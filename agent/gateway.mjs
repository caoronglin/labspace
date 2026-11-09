#!/usr/bin/env node
/**
 * D509 工作台 · Agent 网关
 *
 * 在宿主机上托管 pi 编码代理（RPC 模式），为门户后端提供内网 HTTP/SSE 接口：
 *   - 会话管理（每个会话一个 pi 子进程，按需拉起 / 空闲回收）
 *   - 提示词下发、事件流式回传（SSE）
 *   - 模型清单（来自 pi --list-models）
 *
 * 安全边界：
 *   - 只监听 docker 网络网关地址（默认 172.28.0.1），仅容器网段可达，不暴露到内网 LAN。
 *   - 所有请求必须携带 X-Agent-Token。
 *   - pi 子进程禁用内置工具（read/bash/edit/write），只允许 lab_* 插件工具，杜绝宿主机读写。
 *   - 不加载 MCP、不加载 skills、不加载上下文文件。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CONFIG_PATH = process.env.AGENT_GATEWAY_CONFIG || '/etc/labspace/agent-gateway.json';
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const HOST = config.host || '172.28.0.1';
const PORT = Number(config.port || 8110);
const TOKEN = config.token || '';
const PI_BIN = config.pi_bin || '/root/.pi/agent/bin/pi';
const SESSION_DIR = config.session_dir || '/srv/labdata/labspace/agent/sessions';
const WORK_DIR = config.work_dir || '/srv/labdata/labspace/agent/work';
const IDLE_MS = Number(config.idle_timeout_ms || 15 * 60 * 1000);
const ALLOWED_TOOLS = config.allowed_tools || ['lab_*'];
const EXTENSIONS = (config.extensions || []).filter((p) => {
  if (fs.existsSync(p)) return true;
  console.warn(`[agent-gateway] 跳过不存在的扩展：${p}`);
  return false;
});
const SYSTEM_PROMPT = config.system_prompt || '你是 D509 实验室门户的助手。';
const MODEL_DEFAULT = config.default_model || '';

// 管理员在门户 /admin/agent 保存的技能、MCP 服务器与模型端点由后端推送到这里，
// 网关负责落盘为 pi 可直接读取的配置，并对新会话生效。
const RUNTIME_DIR = config.runtime_dir || '/srv/labdata/labspace/agent/runtime';
const RUNTIME_STATE_PATH = path.join(RUNTIME_DIR, 'runtime.json');
const MCP_CONFIG_PATH = path.join(RUNTIME_DIR, 'mcp.json');
const PI_AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR?.trim() || path.join(process.env.HOME || '/root', '.pi', 'agent');
const PI_MODELS_PATH = path.join(PI_AGENT_DIR, 'models.json');
const SKILL_ROOTS = config.skill_roots || ['/opt/labspace/agent/skills', '/srv/labdata/labspace/agent/skills'];
const MODEL_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
]);
const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * pi 的 --model 需要 provider/id 形式，而前端/后端传回的可能是裸模型名（如 MiniMax-M2.7）。
 * 这里用模型清单把它还原成 provider/id，避免 pi 启动失败。
 */
function resolveModel(model) {
  const name = model || MODEL_DEFAULT;
  if (!name) return '';
  if (name.includes('/')) return name;
  const hit = (modelCache.models || []).find((m) => m.id === name);
  if (hit && hit.provider) return `${hit.provider}/${hit.id}`;
  return name;
}

fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

/* ------------------------------------------------------------------ 模型清单 */

let modelCache = { at: 0, models: [] };

async function listModels() {
  if (Date.now() - modelCache.at < 5 * 60 * 1000 && modelCache.models.length) return modelCache.models;
  // pi --list-models 只列出“凭据已配置”的模型；自管端点的密钥存于运行时配置，
  // 必须按与拉会话相同的方式注入环境变量，否则自定义模型不会出现在清单里。
  const env = { ...process.env };
  for (const provider of runtime.providers) {
    if (provider.apiKey) env[providerEnvName(provider.provider)] = provider.apiKey;
  }
  const out = await new Promise((resolve) => {
    const proc = spawn(PI_BIN, ['--list-models'], { env });
    let buf = '';
    proc.stdout.on('data', (c) => (buf += c.toString('utf8')));
    proc.on('close', () => resolve(buf));
    proc.on('error', () => resolve(''));
  });
  const models = [];
  for (const line of out.split('\n')) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 4) continue;
    if (cells[0] === 'provider' && cells[1] === 'model') continue; // 表头
    const [provider, id, contextRaw, , thinkingRaw, imagesRaw] = cells;
    const context = /K$/i.test(contextRaw)
      ? Math.round(parseFloat(contextRaw) * 1000)
      : /M$/i.test(contextRaw)
        ? Math.round(parseFloat(contextRaw) * 1000000)
        : Number(contextRaw) || null;
    models.push({
      provider,
      id,
      label: id,
      context,
      thinking: thinkingRaw === 'yes',
      images: imagesRaw === 'yes',
    });
  }
  modelCache = { at: Date.now(), models };
  return models;
}

/* ------------------------------------------------------------------ 会话 */

// pi 在 message_end.errorMessage 中保留上游原始错误（常为 "429 {...}"）。
// 提取其中的 message 字段，避免把整段 JSON 直接抛给前端。
function friendlyModelError(raw) {
  const text = String(raw || '').trim();
  if (!text) return '模型服务返回错误，请稍后重试。';
  try {
    const start = text.indexOf('{');
    if (start >= 0) {
      const payload = JSON.parse(text.slice(start));
      const msg = payload?.error?.message || payload?.message;
      if (msg) {
        const detail = String(msg).slice(0, 200);
        if (/[\u4e00-\u9fa5]/.test(detail)) return `模型服务：${detail}`;
        if (/rate.?limit|429|quota|token plan/i.test(detail)) {
          return '模型服务已限流或额度不足，请稍后重试。';
        }
        return `模型服务：${detail}`;
      }
    }
  } catch {
    /* 非 JSON 时走原文截断 */
  }
  if (/429|rate.?limit/i.test(text)) return '模型服务已限流或额度不足，请稍后重试。';
  return `模型服务返回错误：${text.slice(0, 160)}`;
}

class AgentSession {
  constructor(id, userId, model, userToken, systemPrompt, noTools) {
    this.id = id;
    this.userId = userId;
    this.model = model || MODEL_DEFAULT;
    this.userToken = userToken || '';
    this.systemPrompt = systemPrompt || SYSTEM_PROMPT;
    this.noTools = !!noTools;
    this.proc = null;
    this.buffer = '';
    this.listeners = new Set();
    this.streams = new Set();
    this.lastActivity = Date.now();
    this.started = false;
    this.running = false;
    this.runtimeVersion = null;
    this.pending = [];
    this.turnLog = [];
    // 本轮工具调用统计：用于判断模型是否陷入「只调工具、不给结论」的循环
    this.turnToolCalls = 0;
    this.turnHadText = false;
    this.turnErrored = false;
    this.autoFollowed = false;
    this.turnActive = false;
  }

  emit(event) {
    this.lastActivity = Date.now();
    // 记录本轮事件，供后到的订阅者回放（避免“先发消息后开流”丢失增量）
    if (this.turnLog.length > 400) this.turnLog.splice(0, 200);
    this.turnLog.push(event);
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* 忽略订阅者异常 */
      }
    }
  }

  start() {
    if (this.proc) return;
    const snapshot = runtime;
    const args = ['--mode', 'rpc', '--session-dir', SESSION_DIR, '--session-id', this.id];
    if (this.model) args.push('--model', resolveModel(this.model));
    args.push('--no-builtin-tools', '--no-mcp', '--no-skills', '--no-context-files');
    if (this.noTools) {
      args.push('--no-tools');
    } else {
      const toolPatterns = [...ALLOWED_TOOLS];
      // MCP 工具由 pi-mcp-adapter 以单个 mcp 代理工具暴露；
      // 只有管理员配置了服务器时才把它加入白名单。
      if (snapshot.mcpServers.length) toolPatterns.push('mcp');
      if (toolPatterns.length) args.push('--tools', toolPatterns.join(','));
      for (const ext of EXTENSIONS) args.push('--extension', ext);
      for (const skill of snapshot.skills) args.push('--skill', skill.path);
    }
    args.push('--system-prompt', this.systemPrompt);

    const env = {
      ...process.env,
      PI_NO_ANALYTICS: '1',
      // 插件以该令牌代表当前用户调用门户内部接口（Bearer = 用户自己的会话 JWT）
      ...(this.userToken ? { LAB_PORTAL_BEARER: this.userToken } : {}),
    };
    if (snapshot.mcpServers.length) {
      // 独占模式：只读取门户生成的 mcp.json，避免宿主机其它 MCP 配置渗透进会话。
      env.PI_MCP_CONFIG_MODE = 'exclusive';
      args.push('--mcp-config', MCP_CONFIG_PATH);
    }
    for (const provider of snapshot.providers) {
      if (provider.apiKey) env[providerEnvName(provider.provider)] = provider.apiKey;
    }

    const proc = spawn(PI_BIN, args, {
      cwd: WORK_DIR,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.runtimeVersion = snapshot.version;

    proc.stdout.on('data', (chunk) => this.onStdout(chunk));
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.emit({ type: 'log', message: text.slice(0, 500) });
    });
    proc.on('exit', (code, signal) => {
      this.proc = null;
      this.running = false;
      this.emit({ type: 'exit', code, signal });
    });
    proc.on('error', (err) => {
      this.proc = null;
      this.running = false;
      this.emit({ type: 'error', message: `无法启动 pi 进程：${err.message}` });
    });
  }

  onStdout(chunk) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      this.handle(rec);
    }
  }

  handle(rec) {
    const type = rec.type;
    if (type === 'message_update') {
      const ev = rec.assistantMessageEvent || {};
      if (ev.type === 'text_delta') this.emit({ type: 'delta', text: ev.delta || '' });
      else if (ev.type === 'thinking_delta') this.emit({ type: 'thinking', text: ev.delta || '' });
      else if (ev.type === 'toolcall_end') {
        this.emit({ type: 'tool', phase: 'call', name: ev.toolCall?.name || '', args: ev.toolCall?.arguments || {} });
      }
      return;
    }
    if (type === 'tool_execution_start') {
      this.emit({ type: 'tool', phase: 'start', name: rec.toolName || '' });
      return;
    }
    if (type === 'tool_execution_end') {
      this.turnToolCalls += 1;
      this.emit({ type: 'tool', phase: 'end', name: rec.toolName || '', isError: !!rec.isError });
      return;
    }
    if (type === 'message_end') {
      const msg = rec.message || {};
      if (msg.role === 'assistant') {
        if (msg.stopReason === 'error' || msg.errorMessage) {
          if (!this.turnErrored) {
            this.turnErrored = true;
            this.emit({ type: 'error', message: friendlyModelError(msg.errorMessage) });
          }
          return;
        }
        const usage = msg.usage || {};
        const content = Array.isArray(msg.content)
          ? msg.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('')
          : String(msg.content || '');
        if (content.trim()) this.turnHadText = true;
        this.emit({
          type: 'assistant_message',
          content,
          usage: {
            input: usage.input || 0,
            output: usage.output || 0,
            cacheRead: usage.cacheRead || 0,
            cacheWrite: usage.cacheWrite || 0,
          },
        });
      }
      return;
    }
    if (type === 'agent_settled') {
      this.running = false;
      // 模型可能陷入「连续调工具但不给结论」的循环（MiniMax 在工具链场景较常见）：
      // 若本轮有工具调用却没有正文，自动补发一轮「直接给结论」的提示，最多一次。
      if (this.turnToolCalls > 0 && !this.turnHadText && !this.autoFollowed) {
        this.autoFollowed = true;
        this.turnToolCalls = 0;
        this.turnHadText = false;
        this.emit({ type: 'log', message: '模型未给出结论，自动请求一次总结' });
        this.send('请停止继续调用工具，直接基于刚才的检索结果给出最终的中文答复。', { isAuto: true });
        return;
      }
      // 上游额度不足 / 限流时 pi 只回若干空消息便 settled，不会抛 error。
      // 这里补一条明确诊断，避免前端一直停在「正在生成」或收到空回复。
      if (this.turnActive && !this.turnHadText && !this.turnErrored && !rec.aborted) {
        this.emit({
          type: 'error',
          message: '模型未返回内容，可能是额度不足或服务限流，请稍后重试或联系管理员。',
        });
      }
      this.turnActive = false;
      this.emit({ type: 'settled', aborted: !!rec.aborted });
      return;
    }
    if (type === 'error') {
      this.turnErrored = true;
      this.emit({ type: 'error', message: rec.error?.message || rec.reason || '未知错误' });
    }
  }

  send(text, options = {}) {
    // 自动补问不重置 autoFollowed，避免形成无限追问循环
    if (!options.isAuto) this.autoFollowed = false;
    if (this.proc && this.runtimeVersion !== runtime.version) {
      // 管理员更新过运行配置：让下一次发言用新配置重启，pi 会按会话 id 恢复历史。
      this.stopProcess();
    }
    this.start();
    const id = `req-${crypto.randomUUID()}`;
    this.running = true;
    this.turnActive = true;
    this.turnLog = [];
    this.turnToolCalls = 0;
    this.turnHadText = false;
    this.turnErrored = false;
    this.lastActivity = Date.now();
    this.proc.stdin.write(JSON.stringify({ id, type: 'prompt', message: text }) + '\n');
    return id;
  }

  abort() {
    if (!this.proc) return false;
    this.proc.stdin.write(JSON.stringify({ id: `abort-${Date.now()}`, type: 'abort' }) + '\n');
    return true;
  }

  stopProcess() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.running = false;
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, 500);
  }

  closeStreams() {
    for (const res of this.streams) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.streams.clear();
  }

  dispose() {
    this.stopProcess();
    this.closeStreams();
    this.listeners.clear();
  }
}

const sessions = new Map();

function getSession(id, userId, model, create = false, userToken = '', systemPrompt = '', noTools = false) {
  let s = sessions.get(id);
  if (!s) {
    if (!create) return null;
    s = new AgentSession(id, userId, model, userToken, systemPrompt, noTools);
    sessions.set(id, s);
  }
  return s;
}

/* ------------------------------------------------------------------ 管理员运行配置 */

const runtime = {
  version: 'unconfigured',
  skills: [],
  mcpServers: [],
  providers: [],
  managedProviders: [],
};

let runtimeApplyChain = Promise.resolve();

function providerEnvName(provider) {
  return `LAB_PI_KEY_${String(provider).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function atomicWrite(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* ignore */
  }
}

function normalizeSkill(raw) {
  const name = String(raw?.name || '').trim().slice(0, 120);
  const input = String(raw?.path || '').trim();
  if (!path.isAbsolute(input)) throw new Error(`技能路径必须是绝对路径：${input || '(空)'}`);
  const resolved = path.resolve(input);
  let isDir;
  try {
    isDir = fs.statSync(resolved).isDirectory();
  } catch {
    throw new Error(`技能路径不存在：${resolved}`);
  }
  if (isDir && !fs.existsSync(path.join(resolved, 'SKILL.md'))) {
    throw new Error(`技能目录缺少 SKILL.md：${resolved}`);
  }
  if (!isDir && !/\.(md|markdown)$/i.test(resolved)) {
    throw new Error(`技能文件必须是 Markdown：${resolved}`);
  }
  return {
    name: name || path.basename(resolved),
    path: resolved,
    description: String(raw?.description || '').slice(0, 1024),
  };
}

function normalizeMcpServer(raw) {
  const name = String(raw?.name || '').trim();
  if (!MCP_NAME_RE.test(name)) {
    throw new Error(`MCP 服务器名称只能包含字母、数字、下划线和短横线：${name || '(空)'}`);
  }
  const description = String(raw?.description || '').slice(0, 1024);
  if (raw?.transport === 'http') {
    const url = String(raw?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error(`MCP「${name}」需要合法的 http(s) URL`);
    const headers = {};
    for (const [key, value] of Object.entries(raw?.headers || {})) {
      const k = String(key).trim();
      if (k && typeof value === 'string') headers[k] = value;
    }
    return { name, transport: 'http', url, headers, description };
  }
  const command = String(raw?.command || '').trim();
  if (!command) throw new Error(`MCP「${name}」缺少启动命令`);
  const args = Array.isArray(raw?.args) ? raw.args.map((a) => String(a)).filter(Boolean) : [];
  const env = {};
  for (const [key, value] of Object.entries(raw?.env || {})) {
    const k = String(key).trim();
    if (k && typeof value === 'string') env[k] = value;
  }
  const cwd = String(raw?.cwd || '').trim();
  return { name, transport: 'stdio', command, args, env, cwd, description };
}

function normalizeProvider(raw) {
  const provider = String(raw?.provider || '').trim().toLowerCase();
  if (!PROVIDER_RE.test(provider)) {
    throw new Error(`模型端点标识只能使用小写字母、数字、下划线和短横线：${provider || '(空)'}`);
  }
  const baseUrl = String(raw?.baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error(`模型端点「${provider}」需要合法的 http(s) Base URL`);
  const api = MODEL_APIS.has(raw?.api) ? raw.api : 'openai-completions';
  const models = [];
  for (const item of Array.isArray(raw?.models) ? raw.models : []) {
    const id = String(item?.id || '').trim();
    if (!id) continue;
    models.push({
      id,
      name: String(item?.name || id).slice(0, 120),
      reasoning: !!item?.reasoning,
      input: item?.image ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: Math.max(1024, Number(item?.context ?? item?.contextWindow) || 128000),
      maxTokens: Math.max(256, Number(item?.max_tokens ?? item?.maxTokens) || 16384),
    });
  }
  if (!models.length) throw new Error(`模型端点「${provider}」至少需要一个模型`);
  return {
    provider,
    name: String(raw?.name || provider).slice(0, 120),
    baseUrl,
    api,
    apiKey: String(raw?.apiKey || ''),
    models,
  };
}

function normalizeRuntime(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('运行配置格式无效');
  const skills = [];
  const seenSkill = new Set();
  for (const raw of Array.isArray(payload.skills) ? payload.skills : []) {
    const skill = normalizeSkill(raw);
    if (seenSkill.has(skill.path)) continue;
    seenSkill.add(skill.path);
    skills.push(skill);
  }
  const mcpServers = [];
  const seenMcp = new Set();
  for (const raw of Array.isArray(payload.mcpServers) ? payload.mcpServers : []) {
    const server = normalizeMcpServer(raw);
    if (seenMcp.has(server.name)) throw new Error(`MCP 服务器名称重复：${server.name}`);
    seenMcp.add(server.name);
    mcpServers.push(server);
  }
  const providers = [];
  const seenProvider = new Set();
  for (const raw of Array.isArray(payload.providers) ? payload.providers : []) {
    const provider = normalizeProvider(raw);
    if (seenProvider.has(provider.provider)) throw new Error(`模型端点 Provider 重复：${provider.provider}`);
    seenProvider.add(provider.provider);
    providers.push(provider);
  }
  const version = String(
    payload.version ||
      crypto
        .createHash('sha256')
        .update(JSON.stringify({ skills, mcpServers, providers }))
        .digest('hex')
        .slice(0, 16),
  );
  return { version, skills, mcpServers, providers };
}

function mcpEntry(server) {
  if (server.transport === 'http') {
    return {
      type: 'streamable-http',
      url: server.url,
      ...(Object.keys(server.headers).length ? { headers: server.headers } : {}),
      ...(server.description ? { description: server.description } : {}),
    };
  }
  return {
    command: server.command,
    ...(server.args.length ? { args: server.args } : {}),
    ...(Object.keys(server.env).length ? { env: server.env } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
    ...(server.description ? { description: server.description } : {}),
  };
}

function writeModels(next) {
  let doc = {};
  try {
    if (fs.existsSync(PI_MODELS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(PI_MODELS_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed;
    }
  } catch (err) {
    console.warn(`[agent-gateway] 读取 models.json 失败，将重建：${err.message}`);
  }
  const providers =
    doc.providers && typeof doc.providers === 'object' && !Array.isArray(doc.providers) ? doc.providers : {};
  for (const id of runtime.managedProviders || []) delete providers[id];
  for (const p of next.providers) {
    const entry = {
      name: p.name,
      baseUrl: p.baseUrl,
      api: p.api,
      models: p.models,
    };
    // apiKey 只以环境变量引用形式落盘，真实密钥由网关在拉起 pi 时注入。
    if (p.apiKey) entry.apiKey = `$${providerEnvName(p.provider)}`;
    providers[p.provider] = entry;
  }
  if (Object.keys(providers).length) doc.providers = providers;
  else delete doc.providers;
  atomicWrite(PI_MODELS_PATH, JSON.stringify(doc, null, 2));
  next.managedProviders = next.providers.map((p) => p.provider);
}

function applyRuntime(payload) {
  const next = normalizeRuntime(payload);
  const mcpDoc = { mcpServers: {} };
  for (const server of next.mcpServers) {
    mcpDoc.mcpServers[server.name] = { ...mcpEntry(server), enabled: true };
  }
  atomicWrite(MCP_CONFIG_PATH, JSON.stringify(mcpDoc, null, 2));
  writeModels(next);
  atomicWrite(RUNTIME_STATE_PATH, JSON.stringify(next, null, 2));

  runtime.version = next.version;
  runtime.skills = next.skills;
  runtime.mcpServers = next.mcpServers;
  runtime.providers = next.providers;
  runtime.managedProviders = next.managedProviders;

  modelCache = { at: 0, models: [] };
  for (const session of sessions.values()) {
    if (!session.proc && !session.running) continue;
    if (session.running) {
      session.emit({ type: 'error', message: '管理员已更新 Agent 运行配置，本轮回复已中止，请重新发送。' });
    }
    session.stopProcess();
    session.closeStreams();
  }
  listModels()
    .then((models) => console.log(`[agent-gateway] runtime ${runtime.version} applied, models=${models.length}`))
    .catch(() => {});
  return runtimeSummary();
}

function queueRuntimeApply(payload) {
  const run = runtimeApplyChain.then(() => applyRuntime(payload));
  runtimeApplyChain = run.catch(() => {});
  return run;
}

function runtimeSummary() {
  return {
    version: runtime.version,
    skills: runtime.skills.map((s) => ({ name: s.name, path: s.path, description: s.description })),
    mcpServers: runtime.mcpServers.map((s) => ({
      name: s.name,
      transport: s.transport,
      enabled: true,
      description: s.description,
    })),
    providers: runtime.providers.map((p) => ({
      provider: p.provider,
      name: p.name,
      baseUrl: p.baseUrl,
      api: p.api,
      models: p.models.length,
      keySet: !!p.apiKey,
    })),
  };
}

function parseSkillMeta(file) {
  const meta = {};
  try {
    const text = fs.readFileSync(file, 'utf8').slice(0, 8000);
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return meta;
    for (const line of match[1].split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      value = value.replace(/^["']|["']$/g, '');
      if (key && !(key in meta)) meta[key] = value;
    }
  } catch {
    /* ignore */
  }
  return meta;
}

function discoverSkills() {
  const found = new Map();
  for (const root of SKILL_ROOTS) {
    if (!fs.existsSync(root)) continue;
    const walk = (dir, depth) => {
      if (depth > 3) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const skillFile = path.join(full, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            const meta = parseSkillMeta(skillFile);
            found.set(full, {
              name: meta.name || entry.name,
              description: meta.description || '',
              path: full,
              root,
            });
          } else {
            walk(full, depth + 1);
          }
        } else if (entry.isFile() && depth === 0 && /\.md$/i.test(entry.name)) {
          const meta = parseSkillMeta(full);
          found.set(full, {
            name: meta.name || entry.name.replace(/\.md$/i, ''),
            description: meta.description || '',
            path: full,
            root,
          });
        }
      }
    };
    walk(root, 0);
  }
  return {
    roots: SKILL_ROOTS,
    skills: [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
  };
}

// 启动时恢复上一次管理员推送的配置，保证网关重启后新会话仍带上技能 / MCP / 模型端点。
try {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  if (fs.existsSync(RUNTIME_STATE_PATH)) {
    const saved = JSON.parse(fs.readFileSync(RUNTIME_STATE_PATH, 'utf8'));
    applyRuntime(saved);
    console.log(`[agent-gateway] restored runtime ${runtime.version}`);
  }
} catch (err) {
  console.error(`[agent-gateway] 恢复运行配置失败：${err.message}`);
}

// 空闲回收
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.proc && now - s.lastActivity > IDLE_MS) {
      s.dispose();
      sessions.delete(id);
    }
  }
}, 60 * 1000).unref?.();

/* ------------------------------------------------------------------ HTTP */

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c.toString('utf8');
      if (buf.length > 2 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  const token = req.headers['x-agent-token'];
  if (!token || token.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type,x-agent-token' });
    res.end();
    return;
  }

  if (route === '/health') {
    json(res, 200, { ok: true, pi: path.basename(PI_BIN), sessions: sessions.size, time: new Date().toISOString() });
    return;
  }

  if (!authorized(req)) {
    json(res, 401, { ok: false, error: '未授权' });
    return;
  }

  try {
    if (route === '/models' && req.method === 'GET') {
      const models = await listModels();
      json(res, 200, { models });
      return;
    }

    if (route === '/admin/runtime' && req.method === 'GET') {
      json(res, 200, { ok: true, runtime: runtimeSummary() });
      return;
    }

    if (route === '/admin/runtime' && req.method === 'PUT') {
      const body = await readBody(req);
      const summary = await queueRuntimeApply(body);
      json(res, 200, { ok: true, runtime: summary });
      return;
    }

    if (route === '/admin/skills' && req.method === 'GET') {
      json(res, 200, discoverSkills());
      return;
    }

    if (route === '/sessions' && req.method === 'POST') {
      const body = await readBody(req);
      const id = body.sessionId || crypto.randomUUID();
      const session = getSession(
        id,
        body.userId || '',
        body.model || MODEL_DEFAULT,
        true,
        body.userToken || '',
        body.systemPrompt || '',
        !!body.noTools,
      );
      session.userToken = body.userToken || session.userToken || '';
      if (body.systemPrompt) session.systemPrompt = body.systemPrompt;
      if (body.noTools !== undefined) session.noTools = !!body.noTools;
      session.start();
      json(res, 200, { session: { id: session.id, userId: session.userId, model: session.model, started: session.started } });
      return;
    }

    const m = route.match(/^\/sessions\/([^/]+)(\/[a-z]+)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const action = (m[2] || '').replace('/', '');
      const session = getSession(id);

      if (action === 'stream' && req.method === 'GET') {
        if (!session) {
          json(res, 404, { ok: false, error: '会话不存在' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        // 前端收到 ready 后再投递 prompt，避免丢失最早的增量事件
        res.write('event: ready\ndata: {"ok":true,"sessionId":"' + session.id + '"}\n\n');
        const push = (event) => {
          const name = event.type || 'message';
          res.write(`event: ${name}\ndata: ${JSON.stringify(event)}\n\n`);
        };
        session.listeners.add(push);
        session.streams.add(res);
        // 回放本轮已产生的事件（先发消息后开流的场景）
        for (const event of session.turnLog) push(event);
        const keepalive = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => {
          clearInterval(keepalive);
          session.listeners.delete(push);
          session.streams.delete(res);
        });
        return;
      }

      if (!session) {
        json(res, 404, { ok: false, error: '会话不存在' });
        return;
      }

      if (action === 'messages' && req.method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text) {
          json(res, 400, { ok: false, error: '消息内容为空' });
          return;
        }
        session.send(text);
        json(res, 200, { accepted: true });
        return;
      }

      if (action === 'abort' && req.method === 'POST') {
        const aborted = session.abort();
        json(res, 200, { ok: true, aborted });
        return;
      }

      if (!action && req.method === 'GET') {
        json(res, 200, {
          session: {
            id: session.id,
            userId: session.userId,
            model: session.model,
            running: session.running,
            alive: !!session.proc,
            lastActivity: session.lastActivity,
          },
        });
        return;
      }

      if (!action && req.method === 'DELETE') {
        session.dispose();
        sessions.delete(id);
        json(res, 200, { ok: true });
        return;
      }
    }

    json(res, 404, { ok: false, error: '未知接口' });
  } catch (err) {
    json(res, 500, { ok: false, error: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[agent-gateway] listening on http://${HOST}:${PORT} pi=${PI_BIN} sessions=${sessions.size}`);
  // 预热模型清单，供 resolveModel() 把裸模型名还原为 provider/id
  listModels().then((m) => console.log(`[agent-gateway] models loaded: ${m.length}`)).catch(() => {});
});

process.on('SIGTERM', () => {
  for (const s of sessions.values()) s.dispose();
  server.close(() => process.exit(0));
});
