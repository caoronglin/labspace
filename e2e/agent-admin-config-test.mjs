// /admin/agent 的 SKILLS / MCP / 模型端点配置端到端校验
// 用法:
//   LAB_ADMIN_PASS=... node agent-admin-config-test.mjs           完整测试（结束后清理）
//   LAB_ADMIN_PASS=... KEEP=1 node agent-admin-config-test.mjs    保留 probe 配置供宿主机检查
//   LAB_ADMIN_PASS=... CLEANUP=1 node agent-admin-config-test.mjs 仅清理 e2e- 前缀的探针配置
import { launch, BASE } from './_auth.mjs';

const USER = process.env.LAB_ADMIN_USER || 'labadmin';
const PASS = process.env.LAB_ADMIN_PASS;
if (!PASS) throw new Error('缺少 LAB_ADMIN_PASS');

const browser = await launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 30000 });
await page.locator('input[type="text"], input:not([type])').first().fill(USER);
await page.locator('input[type="password"]').first().fill(PASS);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(4000);

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const api = (path, init = {}) =>
  page.evaluate(
    async ([p, i]) => {
      if (i.method && i.method !== 'GET') {
        const csrf = (document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
        i = { ...i, headers: { ...(i.headers || {}), 'X-CSRF-Token': decodeURIComponent(csrf) } };
      }
      const r = await fetch(p, { credentials: 'include', ...i });
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 非 JSON */
      }
      return { status: r.status, json, text };
    },
    [path, init],
  );

const getCfg = () => api('/api/agent/admin/config');
let cfgResp = await getCfg();
if (cfgResp.status !== 200) {
  console.error('管理员配置读取失败', cfgResp.status, cfgResp.text.slice(0, 200));
  process.exit(2);
}

if (process.env.CLEANUP === '1') {
  const cfg = cfgResp.json;
  const body = {
    models: cfg.models,
    default_model: cfg.default_model,
    quotas: cfg.quotas,
    plugins: cfg.plugins,
    system_prompt: cfg.system_prompt,
    skills: (cfg.skills || []).filter((s) => !String(s.name || '').startsWith('e2e-')),
    mcp_servers: (cfg.mcp_servers || []).filter((s) => !String(s.name || '').startsWith('e2e-')),
    model_endpoints: (cfg.model_endpoints || []).filter((e) => !String(e.provider || '').startsWith('e2e-')),
  };
  const put = await api('/api/agent/admin/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log('cleanup:', put.status, JSON.stringify(put.json?.model_endpoints?.map((e) => e.provider) || []));
  await browser.close();
  process.exit(put.status === 200 ? 0 : 1);
}

// 等待 runtime 首次同步（管理员读取配置会触发）
for (let i = 0; i < 4; i++) {
  if (cfgResp.json?.runtime_applied) break;
  await page.waitForTimeout(1200);
  cfgResp = await getCfg();
}
const cfg0 = cfgResp.json;
record('配置读取成功', cfgResp.status === 200);
record('运行时同步已生效', cfg0?.runtime_applied === true, `runtime_error=${cfg0?.runtime_error || '无'}`);
const skillPaths = (cfg0?.skills || []).map((s) => s.path);
record(
  '默认 SKILLS 已注入（植物数据库检索 / 文献检索）',
  skillPaths.includes('/opt/labspace/agent/skills/plant-database-search') &&
    skillPaths.includes('/opt/labspace/agent/skills/literature-search'),
  skillPaths.join(', '),
);
record('MCP 初始为空', Array.isArray(cfg0?.mcp_servers) && cfg0.mcp_servers.length === 0);
record('模型端点初始为空', Array.isArray(cfg0?.model_endpoints) && cfg0.model_endpoints.length === 0);
record('密钥字段未回显', !JSON.stringify(cfg0).includes('api_key"') || cfg0.model_endpoints.length === 0);

// 技能扫描接口
const skillsScan = await api('/api/agent/admin/skills');
const discovered = skillsScan.json?.skills || [];
record('技能扫描可用', skillsScan.status === 200 && discovered.length >= 2, `发现 ${discovered.length} 个技能`);
record(
  '扫描包含内置技能目录',
  discovered.some((s) => s.path === '/opt/labspace/agent/skills/plant-database-search'),
);

const secret = `sk-e2e-${Date.now().toString(36)}`;
const probeBody = {
  models: cfg0.models,
  default_model: cfg0.default_model,
  quotas: cfg0.quotas,
  plugins: cfg0.plugins,
  system_prompt: cfg0.system_prompt,
  skills: cfg0.skills,
  mcp_servers: [
    {
      name: 'e2e-echo',
      transport: 'stdio',
      command: 'node',
      args: ['/tmp/lab-mcp-echo.mjs'],
      env: {},
      cwd: '',
      description: 'E2E 探针 MCP',
      enabled: true,
    },
  ],
  model_endpoints: [
    {
      provider: 'e2e-endpoint',
      name: 'E2E 探针端点',
      base_url: 'http://127.0.0.1:9999/v1',
      api: 'openai-completions',
      api_key: secret,
      models: [{ id: 'e2e-chat', name: 'E2E Chat', context: 32000, max_tokens: 4096, reasoning: false, image: false }],
      enabled: true,
    },
  ],
};
const put1 = await api('/api/agent/admin/config', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(probeBody),
});
record('保存 MCP + 端点返回 200', put1.status === 200, `status=${put1.status}`);
record('保存后运行时立即生效', put1.json?.runtime_applied === true, put1.json?.runtime_error || '');
record('响应不含明文密钥', !put1.text.includes(secret));
const ep = (put1.json?.model_endpoints || [])[0] || {};
record('端点已记录且标记密钥已设置', ep.provider === 'e2e-endpoint' && ep.api_key_set === true && ep.api_key === undefined);
record('MCP 已保存', (put1.json?.mcp_servers || [])[0]?.name === 'e2e-echo');

// 重新读取，确认持久化与不回显
await page.waitForTimeout(800);
const cfg1 = await getCfg();
record('重新读取不含明文密钥', !cfg1.text.includes(secret));
const ep1 = (cfg1.json?.model_endpoints || [])[0] || {};
record('重新读取密钥状态保留', ep1.api_key_set === true && ep1.api_key === undefined);

// 模型清单应带出自定义端点模型（默认未启用，需管理员勾选）
let modelList = null;
for (let i = 0; i < 10; i++) {
  const r = await api('/api/agent/models');
  const list = r.json?.models || [];
  if (list.some((m) => m.id === 'e2e-chat')) {
    modelList = list.find((m) => m.id === 'e2e-chat');
    break;
  }
  await page.waitForTimeout(1500);
}
record('自定义端点模型出现在模型清单', !!modelList, modelList ? `enabled=${modelList.enabled}` : '未出现');
record('新端点模型默认未启用', modelList?.enabled === false);

// 参数校验
const badProvider = await api('/api/agent/admin/config', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...probeBody, model_endpoints: [{ ...probeBody.model_endpoints[0], provider: 'Bad Provider' }] }),
});
record('非法端点标识被拒绝', badProvider.status === 400, badProvider.json?.detail || '');
const dupMcp = await api('/api/agent/admin/config', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    ...probeBody,
    mcp_servers: [probeBody.mcp_servers[0], { ...probeBody.mcp_servers[0] }],
  }),
});
record('重复 MCP 名称被拒绝', dupMcp.status === 400, dupMcp.json?.detail || '');

if (process.env.KEEP === '1') {
  console.log('KEEP=1：保留探针配置（e2e-echo / e2e-endpoint），请进行宿主机文件检查后执行 CLEANUP=1。');
} else {
  const restore = {
    models: cfg0.models,
    default_model: cfg0.default_model,
    quotas: cfg0.quotas,
    plugins: cfg0.plugins,
    system_prompt: cfg0.system_prompt,
    skills: cfg0.skills,
    mcp_servers: [],
    model_endpoints: [],
  };
  const put2 = await api('/api/agent/admin/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(restore),
  });
  record('恢复配置成功', put2.status === 200 && put2.json?.runtime_applied === true);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n结果：${results.length - failed}/${results.length} 通过`);
await browser.close();
process.exit(failed ? 1 : 0);
