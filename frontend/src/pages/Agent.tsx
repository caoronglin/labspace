import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Drawer,
  Dropdown,
  Empty,
  Flex,
  Grid,
  Input,
  Radio,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  BookOutlined,
  CopyOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  MessageOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SaveOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Actions, Bubble, Conversations, Prompts, Sender, ThoughtChain, Welcome } from '@ant-design/x';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { api } from '../services/api';
import type { AgentMessage, AgentModel, AgentSession } from '../services/api';
import { errText } from '../utils/err';
import { takeAgentHandoff } from '../utils/agentHandoff';
import KnowledgeAsk from '../components/KnowledgeAsk';
import ElnPanel from './lab/ElnPanel';
import MarkdownView from '../components/MarkdownView';
import PageShell from '../components/PageShell';
import AgentHub from './agent/hub/AgentHub';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

/* ------------------------------------------------------------------ */
/* 本地消息（流式用，不进 query cache）                                  */
/* ------------------------------------------------------------------ */

type LocalMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  meta?: Record<string, unknown>;
  created_at?: string | null;
  streaming?: boolean;
};

type Citation = {
  key: string;
  source: string;
  chunk: number | null;
  score: number | null;
  text: string;
};

/** 2.0.12 HITL：等待人工确认 / AskUser 回答的工具调用。 */
type HitlToolCall = {
  id?: string;
  name?: string;
  input?: string;
  suggested_rules?: unknown[];
};
type PendingHitl = {
  kind: 'confirm' | 'ask';
  replyId: string;
  toolCalls: HitlToolCall[];
};

type ToolCall = {
  key: string;
  name: string;
  args: string;
  result: string;
  status: string;
};

/* ------------------------------------------------------------------ */
/* 防御式解析工具                                                       */
/* ------------------------------------------------------------------ */

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function pickText(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** 从任意结构的 SSE data 中提取增量文本 */
function extractDelta(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  const o = asRecord(payload);
  if (!o) return '';
  const direct = pickText(o, ['text', 'delta', 'content', 'chunk', 'token']);
  if (direct) return direct;
  for (const key of ['data', 'message', 'payload']) {
    const nested = o[key];
    if (nested !== undefined && nested !== null) {
      const got = extractDelta(nested);
      if (got) return got;
    }
  }
  return '';
}

/** 从任意结构中提取错误文案 */
function extractError(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  const o = asRecord(payload);
  if (!o) return '';
  const direct = pickText(o, ['message', 'error', 'detail', 'reason', 'description']);
  if (direct) return direct;
  for (const key of ['error', 'data', 'message']) {
    const nested = o[key];
    const got = extractDelta(nested);
    if (got) return got;
  }
  return '';
}

/** 从 meta 中解析工具调用列表，字段缺失时不崩溃 */

/**
 * 从工具调用结果里抽 RAG 命中，渲染成「引用来源」。
 *
 * 为什么从工具结果抽而不是让模型自己写：
 *   模型复述文件名不可靠（会漏、会简写、会张冠李戴）。检索结果里的
 *   ``source`` / ``chunk_index`` 是后端给的事实，直接展示才是可核对的。
 *   模型正文里仍然可以写「据 xxx.md」，但**引用块**以工具结果为准。
 */
function parseCitations(tools: ToolCall[]): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    if (!/knowledge_search|knowledge_bases/.test(t.name)) continue;
    if (!t.result) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t.result);
    } catch {
      continue;
    }
    const root = asRecord(parsed);
    if (!root) continue;
    // 工具返回可能被包一层 {data: {...}}，也可能直接是 {results: [...]}
    const inner = asRecord(root.data) ?? root;
    const rows = inner.results;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const r = asRecord(row);
      if (!r) continue;
      const source = pickText(r, ['source']) || '未知文件';
      const chunk = typeof r.chunk_index === 'number' ? r.chunk_index : null;
      const key = `${source}#${chunk ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const score = typeof r.score === 'number' ? r.score : null;
      out.push({
        key,
        source,
        chunk,
        score,
        text: pickText(r, ['text', 'excerpt', 'content']),
      });
    }
  }
  return out;
}

function CitationList({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false);
  if (citations.length === 0) return null;
  const shown = open ? citations : citations.slice(0, 3);
  return (
    <Flex vertical gap={6} style={{ marginBottom: 4, maxWidth: 620 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <BookOutlined /> 引用来源 {citations.length} 处
        {citations.length > 3 ? (
          <Typography.Link style={{ fontSize: 12, marginInlineStart: 8 }} onClick={() => setOpen(!open)}>
            {open ? '收起' : '展开全部'}
          </Typography.Link>
        ) : null}
      </Typography.Text>
      {shown.map((c, i) => (
        <div
          key={c.key}
          style={{
            padding: '6px 9px',
            borderRadius: 6,
            background: 'var(--ant-color-fill-quaternary)',
            border: '1px solid var(--ant-color-border-secondary)',
          }}
        >
          <Flex gap={6} align="center" wrap>
            <Tag color="blue" style={{ marginInlineEnd: 0, fontSize: 11 }}>
              [{i + 1}]
            </Tag>
            <Typography.Text style={{ fontSize: 12.5 }} ellipsis={{ tooltip: c.source }}>
              {c.source}
            </Typography.Text>
            {c.chunk !== null ? (
              <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                第 {c.chunk + 1} 段
              </Typography.Text>
            ) : null}
            {c.score !== null ? (
              <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                相关度 {c.score.toFixed(2)}
              </Typography.Text>
            ) : null}
          </Flex>
          {c.text ? (
            <Typography.Paragraph
              type="secondary"
              ellipsis={{ rows: 2 }}
              style={{ margin: '3px 0 0', fontSize: 12 }}
            >
              {c.text.replace(/\n+/g, ' ')}
            </Typography.Paragraph>
          ) : null}
        </div>
      ))}
    </Flex>
  );
}

function parseToolCalls(meta?: Record<string, unknown>): ToolCall[] {
  const out: ToolCall[] = [];
  const push = (raw: unknown, idx: number) => {
    const o = asRecord(raw);
    if (!o) return;
    const name =
      pickText(o, ['toolName', 'tool_name', 'name', 'tool', 'function', 'title']) || '工具调用';
    const args = stringify(o.arguments ?? o.input ?? o.args ?? o.parameters ?? o.params);
    const result = stringify(o.result ?? o.output ?? o.response ?? o.content ?? o.data);
    const status = pickText(o, ['status', 'state', 'phase']);
    out.push({ key: `${name}-${idx}-${out.length}`, name, args, result, status });
  };

  if (!meta) return out;

  const events = meta.events ?? meta.tools ?? meta.tool_calls;
  if (Array.isArray(events)) {
    events.forEach((e, i) => push(e, i));
  } else if (events !== undefined && events !== null) {
    push(events, 0);
  }

  const hasTopLevel =
    pickText(meta, ['toolName', 'tool_name']) !== '' ||
    meta.tool !== undefined ||
    meta.function !== undefined;
  if (hasTopLevel) push(meta, out.length);

  return out;
}

function relTime(value?: string | null): string {
  if (!value) return '';
  const d = dayjs(value);
  if (!d.isValid()) return '';
  return d.fromNow();
}


/** 内网多为 HTTP，非安全上下文没有 navigator.clipboard，退回 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续尝试 execCommand */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */

type AskQuestion = {
  question: string;
  header?: string;
  context?: string;
  options: { label: string; description?: string; preview?: string }[];
  multi_select?: boolean;
};

/** AskUser 表单：从工具 input（JSON 字符串）里解析问题，渲染为原生单选/多选。 */
function HitlAskForm({
  calls,
  onSubmit,
}: {
  calls: HitlToolCall[];
  onSubmit: (answers: { question: string; selected: string[]; other: string | null }[]) => void;
}) {
  const questions = useMemo<AskQuestion[]>(() => {
    for (const call of calls) {
      if (call.name !== 'AskUser' || !call.input) continue;
      try {
        const raw = JSON.parse(call.input) as { questions?: AskQuestion[] };
        if (Array.isArray(raw.questions) && raw.questions.length) return raw.questions;
      } catch {
        /* 格式异常时不猜 */
      }
    }
    return [];
  }, [calls]);

  const [picks, setPicks] = useState<Record<number, string[]>>({});
  const [others, setOthers] = useState<Record<number, string>>({});

  if (!questions.length) {
    return (
      <Alert
        type="info"
        showIcon
        title="助手提出了问题，但当前客户端无法解析选项"
        description="请在命令行或重新提问；不会自动替你回答。"
      />
    );
  }

  const submit = () => {
    const answers = questions.map((q, i) => {
      const selected = picks[i] ?? [];
      const other = others[i]?.trim() || null;
      return { question: q.question, selected, other };
    });
    onSubmit(answers);
  };

  return (
    <Flex vertical gap={12}>
      {questions.map((q, i) => (
        <div key={`${q.question}-${i}`}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            {q.header ? `[${q.header}] ` : ''}
            {q.question}
          </Typography.Text>
          {q.context ? (
            <Typography.Paragraph type="secondary" style={{ margin: '4px 0', fontSize: 12 }}>
              {q.context}
            </Typography.Paragraph>
          ) : null}
          <div style={{ marginTop: 6 }}>
            {q.multi_select ? (
              <Checkbox.Group
                value={picks[i] ?? []}
                onChange={(vals) => setPicks((p) => ({ ...p, [i]: vals.map(String) }))}
                options={[...q.options.map((o) => o.label), '其他']}
              />
            ) : (
              <Radio.Group
                value={(picks[i] ?? [])[0]}
                onChange={(e) => setPicks((p) => ({ ...p, [i]: e.target.value ? [String(e.target.value)] : [] }))}
                options={[...q.options.map((o) => o.label), '其他']}
              />
            )}
          </div>
          {(picks[i] ?? []).includes('其他') ? (
            <Input.TextArea
              size="small"
              rows={2}
              style={{ marginTop: 6 }}
              placeholder="请补充你的回答"
              value={others[i] ?? ''}
              onChange={(e) => setOthers((o) => ({ ...o, [i]: e.target.value }))}
            />
          ) : null}
        </div>
      ))}
      <Button type="primary" size="small" onClick={submit}>
        提交回答
      </Button>
    </Flex>
  );
}

export default function Agent() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const screens = Grid.useBreakpoint();
  const narrow = !screens.lg;

  const [mode, setMode] = useState<'chat' | 'kb' | 'lab' | 'hub'>(() => {
    const wanted = searchParams.get('mode') || searchParams.get('tab');
    return wanted === 'kb' || wanted === 'lab' || wanted === 'hub' ? wanted : 'chat';
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [streamError, setStreamError] = useState('');
  const [streamNotice, setStreamNotice] = useState('');
  const [pendingHitl, setPendingHitl] = useState<PendingHitl | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryQ, setMemoryQ] = useState('');
  const [memoryKind, setMemoryKind] = useState('');

  // 流式消息：局部 state
  const [localSessionId, setLocalSessionId] = useState<string | null>(null);
  const [localMessages, setLocalMessages] = useState<LocalMessage[] | null>(null);
  const localRef = useRef<LocalMessage[] | null>(null);
  localRef.current = localMessages;

  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const raw = searchParams.get('mode');
    // 白名单必须和上面的初始值保持一致 —— 漏掉 'hub' 时，
    // 挂载后这个 effect 会把 /agent?mode=hub 立刻覆盖成 'chat'，
    // 于是「能力中心」深链永远打不开（页面停在对话页）。
    const wanted: 'chat' | 'kb' | 'lab' | 'hub' =
      raw === 'kb' || raw === 'lab' || raw === 'hub' ? raw : 'chat';
    setMode((cur) => (cur === wanted ? cur : wanted));
  }, [searchParams]);

  const switchMode = (next: 'chat' | 'kb' | 'lab' | 'hub') => {
    setMode(next);
    const params = new URLSearchParams(searchParams);
    // 能力中心与对话共用同一个页面：用 mode 参数切换，深链可直接到 hub
    if (next === 'chat') params.delete('mode');
    else params.set('mode', next);
    params.delete('tab');
    setSearchParams(params, { replace: true });
  };

  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  // 其它服务页「交给 Agent」送来的问题：进入页面即预填，可再编辑后发送
  useEffect(() => {
    const prompt = takeAgentHandoff();
    if (prompt) setInput(prompt);
  }, []);

  /* ------------------------- 查询 ------------------------- */

  const statusQuery = useQuery({
    queryKey: ['agent-status'],
    queryFn: api.agentStatus,
  });

  const modelsQuery = useQuery({
    queryKey: ['agent-models'],
    queryFn: api.agentModels,
  });

  const quotaQuery = useQuery({
    queryKey: ['agent-quota'],
    queryFn: api.agentQuota,
  });

  const sessionsQuery = useQuery({
    queryKey: ['agent-sessions'],
    queryFn: api.agentSessions,
  });

  const sessionQuery = useQuery({
    queryKey: ['agent-session', activeId],
    queryFn: () => api.agentSession(activeId as string),
    enabled: !!activeId,
  });

  const memoriesQuery = useQuery({
    queryKey: ['agent-memories', memoryQ, memoryKind],
    queryFn: () => api.agentMemories(memoryQ, memoryKind, 100),
    enabled: memoryOpen,
    staleTime: 15_000,
  });

  const sessions = useMemo(() => {
    const list = sessionsQuery.data?.sessions ?? [];
    return [...list].sort((a, b) => {
      const at = a.updated_at ? dayjs(a.updated_at).valueOf() : 0;
      const bt = b.updated_at ? dayjs(b.updated_at).valueOf() : 0;
      return bt - at;
    });
  }, [sessionsQuery.data]);

  const models: AgentModel[] = useMemo(
    () => modelsQuery.data?.models ?? statusQuery.data?.models ?? [],
    [modelsQuery.data, statusQuery.data],
  );

  const enabledModels = useMemo(
    () => models.filter((m) => m.enabled !== false),
    [models],
  );

  const modelLabel = useCallback(
    (id?: string) => {
      if (!id) return '默认模型';
      const hit = models.find((m) => m.id === id);
      return hit ? hit.label || hit.id : id;
    },
    [models],
  );

  const activeSession: AgentSession | undefined = useMemo(
    () => sessions.find((s) => s.id === activeId),
    [sessions, activeId],
  );

  const [selectedModel, setSelectedModel] = useState<string>('');
  useEffect(() => {
    if (activeSession?.model) setSelectedModel(activeSession.model);
  }, [activeSession?.model]);

  useEffect(() => {
    if (selectedModel || statusQuery.isLoading) return;
    const preferred = statusQuery.data?.model;
    const next =
      enabledModels.find(
        (m) => m.id === preferred || (m.provider && `${m.provider}/${m.id}` === preferred),
      )?.id ?? enabledModels[0]?.id;
    if (next) setSelectedModel(next);
  }, [enabledModels, selectedModel, statusQuery.data?.model, statusQuery.isLoading]);

  // 被删除的会话：从服务端刷新后自动失效
  // 注意：新建会话后 invalidateQueries 触发的列表刷新可能尚未包含新会话，
  // 此时不能把刚选中的会话置空（否则输入框会被禁用）。
  const pendingIdsRef = useRef<Set<string>>(new Set());
  // 首次进入时自动选中最近一次会话：否则输入框一直是禁用状态，
  // 用户看到的是一个"不能输入"的助手页。
  useEffect(() => {
    if (activeId || !sessionsQuery.data) return;
    const latest = sessions[0];
    if (latest) setActiveId(latest.id);
  }, [activeId, sessions, sessionsQuery.data]);

  useEffect(() => {
    if (!activeId || !sessionsQuery.data) return;
    if (pendingIdsRef.current.has(activeId)) {
      // 列表已包含该会话后再解除待定标记
      if (sessions.some((s) => s.id === activeId)) pendingIdsRef.current.delete(activeId);
      return;
    }
    if (!sessions.some((s) => s.id === activeId)) {
      setActiveId(null);
      setLocalMessages(null);
      setLocalSessionId(null);
    }
  }, [activeId, sessions, sessionsQuery.data]);

  /* ------------------------- 变更 ------------------------- */

  const createMut = useMutation({
    mutationFn: (model: string) => api.agentCreateSession('', model),
    onError: (err) => {
      // 新建会话失败（如触发配额 429）必须让用户看见原因，否则按钮点了没反应
      message.error(`新建会话失败：${errText(err)}`);
    },
    onSuccess: ({ session }) => {
      qc.invalidateQueries({ queryKey: ['agent-sessions'] });
      pendingIdsRef.current.add(session.id);
      setActiveId(session.id);
      setLocalMessages(null);
      setLocalSessionId(null);
      setStreamError('');
      setStreamNotice('');
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.agentDeleteSession(id),
    onError: (err) => {
      message.error(`删除会话失败：${errText(err)}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-sessions'] });
      qc.invalidateQueries({ queryKey: ['agent-session'] });
    },
  });

  // 把一段助手回答沉淀为长期记忆 / 私有知识库条目
  const saveMemoryMut = useMutation({
    mutationFn: (content: string) =>
      api.agentMemoryCreate({
        kind: 'note',
        title: `对话摘录 · ${dayjs().format('MM-DD HH:mm')}`,
        content: content.slice(0, 4000),
        sourceSession: activeId ?? '',
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['agent-memories'] });
      qc.invalidateQueries({ queryKey: ['agent-status'] });
      message.success(res.deduped ? '这条内容已在长期记忆中' : '已写入长期记忆');
    },
    onError: (err) => message.error(`写入记忆失败：${errText(err)}`),
  });

  const saveKnowledgeMut = useMutation({
    mutationFn: (content: string) => {
      const firstLine =
        content
          .split('\n')
          .map((line) => line.replace(/^#+\s*/, '').trim())
          .find(Boolean) ?? '';
      return api.knowledgeCreate({
        title: (firstLine || `Agent 对话 ${dayjs().format('YYYY-MM-DD')}`).slice(0, 60),
        body: content,
        tags: ['Agent 助手'],
        visibility: 'private',
        roles: [],
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['knowledge'] });
      qc.invalidateQueries({ queryKey: ['knowledge-spaces'] });
      message.success('已存入私有知识库');
    },
    onError: (err) => message.error(`存入知识库失败：${errText(err)}`),
  });

  const deleteMemoryMut = useMutation({
    mutationFn: (id: string) => api.agentMemoryDelete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-memories'] });
      qc.invalidateQueries({ queryKey: ['agent-status'] });
      message.success('已删除记忆');
    },
    onError: (err) => message.error(`删除记忆失败：${errText(err)}`),
  });

  /* ------------------------- 消息来源 ------------------------- */

  const serverMessages: AgentMessage[] = sessionQuery.data?.messages ?? [];

  const displayMessages: LocalMessage[] = useMemo(() => {
    if (localMessages && localSessionId === activeId) return localMessages;
    return serverMessages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      meta: m.meta,
      created_at: m.created_at,
    }));
  }, [localMessages, localSessionId, activeId, serverMessages]);

  /* ------------------------- 流式 ------------------------- */

  const syncFromServer = useCallback(
    async (sid: string, fallbackContent?: string) => {
      try {
        const { messages } = await api.agentMessages(sid);
        const mapped: LocalMessage[] = messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          meta: m.meta,
          created_at: m.created_at,
        }));
        const lastLocal = localRef.current?.filter((m) => m.role === 'assistant').pop();
        if (lastLocal && fallbackContent && lastLocal.content.length > 0) {
          const lastServer = mapped.filter((m) => m.role === 'assistant').pop();
          if (!lastServer || lastServer.content.length < lastLocal.content.length) {
            if (lastServer) lastServer.content = fallbackContent;
            else {
              mapped.push({
                id: `local-${sid}`,
                role: 'assistant',
                content: fallbackContent,
                created_at: new Date().toISOString(),
              });
            }
          }
        }
        setLocalSessionId(sid);
        setLocalMessages(mapped);
      } catch {
        setLocalMessages((prev) =>
          prev ? prev.map((m) => ({ ...m, streaming: false })) : prev,
        );
      } finally {
        qc.invalidateQueries({ queryKey: ['agent-session', sid] });
        qc.invalidateQueries({ queryKey: ['agent-sessions'] });
      }
    },
    [qc],
  );

  const finishStream = useCallback(
    (sid: string, opts: { error?: string; notice?: string; fallbackContent?: string }) => {
      esRef.current?.close();
      esRef.current = null;
      setGenerating(false);
      if (opts.error) setStreamError(opts.error);
      if (opts.notice) setStreamNotice(opts.notice);
      void syncFromServer(sid, opts.fallbackContent);
    },
    [syncFromServer],
  );

  const openStream = useCallback(
    (sid: string, assistantId: string) => {
      let settled = false;
      let gotDelta = false;
      let lastContent = '';

      const es = new EventSource(api.agentStreamUrl(sid));
      esRef.current = es;

      const appendDelta = (text: string) => {
        if (!text) return;
        gotDelta = true;
        lastContent += text;
        setLocalMessages((prev) =>
          prev
            ? prev.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + text } : m,
              )
            : prev,
        );
      };

      const appendTool = (payload: unknown) => {
        const o = asRecord(payload);
        const call = o
          ? {
              name: pickText(o, ['toolName', 'tool_name', 'name', 'tool']) || '工具调用',
              args: stringify(o.arguments ?? o.input ?? o.args ?? o.params),
              result: stringify(o.result ?? o.output ?? o.response ?? o.content),
              status: pickText(o, ['status', 'state']),
            }
          : null;
        if (!call) return;
        setLocalMessages((prev) =>
          prev
            ? prev.map((m) => {
                if (m.id !== assistantId) return m;
                const meta = { ...(m.meta ?? {}) };
                const list = Array.isArray(meta.toolCalls) ? [...(meta.toolCalls as unknown[])] : [];
                list.push(call);
                return { ...m, meta: { ...meta, toolCalls: list } };
              })
            : prev,
        );
      };

      const settle = (opts: { error?: string; notice?: string }) => {
        if (settled) return;
        settled = true;
        finishStream(sid, { ...opts, fallbackContent: gotDelta ? lastContent : undefined });
      };

      es.addEventListener('ready', () => {
        /* 预热事件，无需处理 */
      });

      es.addEventListener('delta', (ev) => {
        const raw = (ev as MessageEvent).data;
        let text = '';
        try {
          text = extractDelta(JSON.parse(String(raw)));
        } catch {
          text = extractDelta(String(raw));
        }
        appendDelta(text);
      });

      es.addEventListener('tool', (ev) => {
        const raw = (ev as MessageEvent).data;
        let payload: unknown = raw;
        try {
          payload = JSON.parse(String(raw));
        } catch {
          payload = { toolName: String(raw) };
        }
        appendTool(payload);
      });

      // 2.0.12 HITL：确认请求 / AskUser 问题到达后挂起，等用户答复再继续。
      const onHitl = (kind: 'confirm' | 'ask') => (ev: Event) => {
        const raw = (ev as MessageEvent).data;
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        const replyId = String(payload.replyId ?? '');
        const calls = Array.isArray(payload.toolCalls) ? (payload.toolCalls as HitlToolCall[]) : [];
        if (replyId && calls.length) setPendingHitl({ kind, replyId, toolCalls: calls });
      };
      es.addEventListener('confirm', onHitl('confirm'));
      es.addEventListener('ask', onHitl('ask'));

      es.addEventListener('done', () => {
        setPendingHitl(null);
        settle({});
      });

      es.addEventListener('error', (ev) => {
        // 服务端显式 error 事件（有 data）；网络错误没有 data，交给 es.onerror
        const e = ev as MessageEvent;
        if (e && typeof e.data === 'string' && e.data) {
          let msg = '';
          try {
            msg = extractError(JSON.parse(e.data));
          } catch {
            msg = extractError(e.data);
          }
          settle({ error: msg || '生成出错，请稍后重试' });
        }
      });

      es.onerror = () => {
        if (settled) return;
        settled = true;
        es.close();
        if (esRef.current === es) esRef.current = null;
        setGenerating(false);
        // 兜底：回源拉取已落库消息
        void syncFromServer(sid, gotDelta ? lastContent : undefined);
      };
    },
    [finishStream, syncFromServer],
  );

  const send = useCallback(async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || generating || !activeId) return;

    setInput('');
    setStreamError('');
    setStreamNotice('');
    setPendingHitl(null);

    const now = new Date().toISOString();
    const assistantId = `local-assistant-${Date.now()}`;
    const base = displayMessages;
    const next: LocalMessage[] = [
      ...base,
      { id: `local-user-${Date.now()}`, role: 'user', content: text, created_at: now },
      { id: assistantId, role: 'assistant', content: '', created_at: now, streaming: true },
    ];

    setLocalSessionId(activeId);
    setLocalMessages(next);
    setGenerating(true);

    try {
      await api.agentSend(activeId, text);
    } catch (e) {
      setGenerating(false);
      setStreamError(e instanceof Error ? e.message : '发送失败，请稍后重试');
      void syncFromServer(activeId);
      return;
    }
    openStream(activeId, assistantId);
  }, [activeId, displayMessages, generating, input, openStream, syncFromServer]);

  const stop = useCallback(async () => {
    if (!activeId) return;
    try {
      await api.agentAbort(activeId);
    } catch {
      /* 忽略：即便失败也结束本地流 */
    }
    finishStream(activeId, { notice: '已停止生成' });
  }, [activeId, finishStream]);

  const regenerate = useCallback(async () => {
    if (!activeId || generating) return;
    const lastUser = [...displayMessages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;

    setStreamError('');
    setStreamNotice('');
    const assistantId = `local-assistant-${Date.now()}`;
    const next: LocalMessage[] = [
      ...displayMessages,
      {
        id: assistantId,
        role: 'assistant',
        content: '',
        created_at: new Date().toISOString(),
        streaming: true,
      },
    ];
    setLocalSessionId(activeId);
    setLocalMessages(next);
    setGenerating(true);

    try {
      await api.agentSend(activeId, lastUser.content, true);
    } catch (e) {
      setGenerating(false);
      setStreamError(e instanceof Error ? e.message : '重新生成失败，请稍后重试');
      void syncFromServer(activeId);
      return;
    }
    openStream(activeId, assistantId);
  }, [activeId, displayMessages, generating, openStream, syncFromServer]);

  const handleCopy = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      const ok = await copyText(text);
      if (ok) message.success('已复制');
      else message.error('复制失败，请手动选择文本');
    },
    [message],
  );

  /* ------------------------- 派生展示 ------------------------- */

  const status = statusQuery.data;

  const skills = useMemo(() => statusQuery.data?.skills ?? [], [statusQuery.data]);

  const fillSkill = useCallback((name: string) => {
    setInput(
      name.includes('深度研究')
        ? `使用「${name}」技能开展系统调研。\n研究问题：\n验收标准：\n范围与已知材料：\n期望输出：`
        : `使用「${name}」技能：`,
    );
    setStreamError('');
    setStreamNotice('');
  }, []);

  const quotaText = useMemo(() => {
    const quotas = quotaQuery.data?.quotas ?? {};
    const used = quotaQuery.data?.used ?? {};
    const perDay =
      quotas.messages_per_day ?? status?.quotas?.messages_per_day ?? 0;
    const day = used.messagesDay ?? 0;
    const tokens = used.tokensToday ?? 0;
    return `今日已用 ${day}/${perDay} 条 · 累计 token ${tokens}`;
  }, [quotaQuery.data, status]);

  const modelOptions = useMemo(
    () =>
      enabledModels.map((m) => ({
        value: m.id,
        label: m.label || m.id,
      })),
    [enabledModels],
  );

  /* ------------------------- 渲染块 ------------------------- */

  const confirmDeleteSession = (id: string) => {
    modal.confirm({
      title: '删除该会话？',
      content: '删除后不可恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => deleteMut.mutate(id),
    });
  };

  const suggestionItems = [
    ...skills.map((s) => ({
      key: `skill:${s.name}`,
      icon: <ThunderboltOutlined style={{ color: '#2B5CE6' }} />,
      label: s.name,
      description: s.description,
    })),
    { key: 'db', label: '检索植物数据库', description: '按物种或基因名查询 UniProt / GBIF' },
    { key: 'lit', label: '查阅文献', description: '用 Europe PMC 检索研究进展' },
    { key: 'todo', label: '记录实验待办', description: '把下一步计划写入个人工作台' },
  ];

  /** 会话搜索默认折叠：侧栏窄，搜索框常驻会把它挤没。 */
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionKeyword, setSessionKeyword] = useState('');

  /** 会话列表按「今天 / 更早」分组，用 X 的 Conversations 呈现。 */
  const conversationItems = useMemo(() => {
    const today = dayjs().format('YYYY-MM-DD');
    const kw = sessionKeyword.trim().toLowerCase();
    const visible = kw
      ? sessions.filter((s) => `${s.title || ''} ${s.model || ''}`.toLowerCase().includes(kw))
      : sessions;
    return visible.map((s) => ({
      key: s.id,
      label: (
        <Flex vertical gap={0} style={{ minWidth: 0 }}>
          <Typography.Text strong ellipsis style={{ fontSize: 13, maxWidth: 220 }}>
            {s.title || '未命名会话'}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {relTime(s.updated_at) || '刚刚'} · {s.message_count ?? 0} 条
          </Typography.Text>
        </Flex>
      ),
      icon: <MessageOutlined />,
      group: s.updated_at && s.updated_at.startsWith(today) ? '今天' : '更早',
    }));
  }, [sessions, sessionKeyword]);

  const renderToolbar = () => (
    <Card size="small" styles={{ body: { padding: '10px 14px' } }} data-testid="agent-toolbar">
      <Flex justify="space-between" align="center" wrap gap={10}>
        <Space wrap size={8}>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            loading={createMut.isPending}
            onClick={() => createMut.mutate(selectedModel)}
          >
            新建会话
          </Button>
          {activeId ? (
            <Tooltip title="删除当前会话">
              <Button
                danger
                icon={<DeleteOutlined />}
                aria-label="删除当前会话"
                onClick={() => confirmDeleteSession(activeId)}
              />
            </Tooltip>
          ) : null}
        </Space>
        <Space wrap size={8}>
          <Dropdown
            trigger={['click']}
            menu={{
              items:
                skills.length === 0
                  ? [{ key: 'none', label: '管理员尚未启用技能', disabled: true }]
                  : skills.map((skill) => ({
                      key: skill.name,
                      label: (
                        <Flex vertical gap={2} style={{ maxWidth: 300 }}>
                          <Typography.Text strong style={{ fontSize: 13 }}>
                            {skill.name}
                          </Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {skill.description}
                          </Typography.Text>
                        </Flex>
                      ),
                    })),
              onClick: ({ key }) => {
                if (key !== 'none') fillSkill(String(key));
              },
            }}
          >
            <Button icon={<ThunderboltOutlined style={{ color: '#2B5CE6' }} />}>
              可用技能{skills.length ? ` (${skills.length})` : ''}
            </Button>
          </Dropdown>
          <Tooltip title="长期记忆：跨会话保留的结论、偏好与方法">
            <Button
              icon={<SaveOutlined style={{ color: '#2B5CE6' }} />}
              onClick={() => setMemoryOpen(true)}
            >
              记忆{status?.memoryCount ? ` (${status.memoryCount})` : ''}
            </Button>
          </Tooltip>
          <Tooltip title="刷新会话列表">
            <Button
              icon={<ReloadOutlined />}
              loading={sessionsQuery.isFetching}
              aria-label="刷新会话列表"
              onClick={() => void sessionsQuery.refetch()}
            />
          </Tooltip>
        </Space>
      </Flex>
    </Card>
  );

  const toolChain = (tools: ToolCall[]) =>
    tools.length ? (
      <ThoughtChain
        line="dashed"
        items={tools.map((t) => ({
          key: t.key,
          title: t.name,
          description: t.status || undefined,
          status: /error|fail|失败/i.test(t.status) ? 'error' : t.status ? 'success' : undefined,
          collapsible: true,
          content: (
            <div style={{ fontSize: 12 }}>
              {t.args ? (
                <div style={{ marginBottom: 6 }}>
                  <Typography.Text type="secondary">调用参数</Typography.Text>
                  <pre
                    style={{
                      margin: '4px 0 0',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      background: 'rgba(0,0,0,0.04)',
                      padding: 8,
                      borderRadius: 8,
                    }}
                  >
                    {t.args}
                  </pre>
                </div>
              ) : null}
              {t.result ? (
                <div>
                  <Typography.Text type="secondary">执行结果</Typography.Text>
                  <pre
                    style={{
                      margin: '4px 0 0',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      background: 'rgba(0,0,0,0.04)',
                      padding: 8,
                      borderRadius: 8,
                    }}
                  >
                    {t.result}
                  </pre>
                </div>
              ) : null}
            </div>
          ),
        }))}
      />
    ) : undefined;

  /**
   * 2.0.12 HITL：AskUser / 工具确认面板。
   *
   * 只渲染服务端发来的问题与选项；答案由这里构造，
   * 经 /api/agent/sessions/{id}/hitl 回传（事件形状服务端重建，前端不能伪造）。
   */
  const hitlPanel = pendingHitl ? (
    <Card
      size="small"
      style={{ marginBottom: 10, borderColor: '#FAAD14' }}
      title={
        <Flex align="center" gap={8}>
          <SafetyCertificateOutlined style={{ color: '#FAAD14' }} />
          <Typography.Text strong style={{ fontSize: 13 }}>
            {pendingHitl.kind === 'confirm' ? '需要你确认工具调用' : '助手需要你做选择'}
          </Typography.Text>
          <Tag style={{ fontSize: 11 }}>{pendingHitl.toolCalls.length} 项</Tag>
        </Flex>
      }
      extra={
        <Button size="small" type="text" onClick={() => setPendingHitl(null)}>
          忽略
        </Button>
      }
    >
      <Flex vertical gap={10}>
        {pendingHitl.kind === 'confirm' ? (
          <>
            {pendingHitl.toolCalls.map((call, i) => (
              <div
                key={String(call.id ?? i)}
                style={{
                  padding: '6px 9px',
                  borderRadius: 6,
                  background: 'var(--ant-color-fill-quaternary)',
                }}
              >
                <Typography.Text strong style={{ fontSize: 12.5 }}>
                  {call.name || '工具调用'}
                </Typography.Text>
                <Typography.Paragraph
                  type="secondary"
                  ellipsis={{ rows: 3 }}
                  style={{ margin: '3px 0 0', fontSize: 12 }}
                >
                  {call.input || '(无参数)'}
                </Typography.Paragraph>
              </div>
            ))}
            <Space>
              <Button
                size="small"
                danger
                onClick={() => {
                  void api
                    .agentHitl(activeId!, {
                      kind: 'confirm',
                      replyId: pendingHitl.replyId,
                      toolCalls: pendingHitl.toolCalls,
                      approved: false,
                    })
                    .then(() => setPendingHitl(null))
                    .catch((e) => message.error(`回传失败：${errText(e)}`));
                }}
              >
                拒绝
              </Button>
              <Button
                size="small"
                type="primary"
                onClick={() => {
                  void api
                    .agentHitl(activeId!, {
                      kind: 'confirm',
                      replyId: pendingHitl.replyId,
                      toolCalls: pendingHitl.toolCalls,
                      approved: true,
                    })
                    .then(() => setPendingHitl(null))
                    .catch((e) => message.error(`回传失败：${errText(e)}`));
                }}
              >
                批准
              </Button>
            </Space>
          </>
        ) : (
          <HitlAskForm
            key={pendingHitl.replyId}
            calls={pendingHitl.toolCalls}
            onSubmit={(answers) => {
              void api
                .agentHitl(activeId!, {
                  kind: 'ask',
                  replyId: pendingHitl.replyId,
                  toolCalls: pendingHitl.toolCalls,
                  answers,
                })
                .then(() => setPendingHitl(null))
                .catch((e) => message.error(`回传失败：${errText(e)}`));
            }}
          />
        )}
      </Flex>
    </Card>
  ) : null;

  const bubbleItems = displayMessages.map((m) => {
    const tools = parseToolCalls(m.meta);
    const isUser = m.role === 'user';
    const isAi = m.role === 'assistant';
    return {
      key: m.id,
      role: m.role === 'system' ? 'system' : isUser ? 'user' : 'ai',
      content: isAi ? (
        m.streaming && !m.content ? (
          ''
        ) : (
          <MarkdownView source={m.content || '（无内容）'} />
        )
      ) : (
        m.content || (m.streaming ? '' : '（无内容）')
      ),
      loading: m.streaming && !m.content,
      streaming: m.streaming,
      avatar: isUser ? undefined : <RobotOutlined style={{ color: '#2B5CE6' }} />,
      footer: isAi ? (
        <Flex vertical gap={6} align="flex-start">
          <CitationList citations={parseCitations(tools)} />
          {toolChain(tools)}
          <Actions
            items={[
              { key: 'copy', icon: <CopyOutlined />, label: '复制' },
              ...(m.streaming
                ? []
                : [
                    { key: 'regenerate', icon: <ReloadOutlined />, label: '重新生成' },
                    { key: 'knowledge', icon: <BookOutlined />, label: '存入知识库' },
                    { key: 'memory', icon: <SaveOutlined />, label: '记住' },
                  ]),
            ]}
            onClick={({ key }) => {
              if (key === 'copy') void handleCopy(m.content);
              if (key === 'regenerate') void regenerate();
              if (key === 'knowledge') {
                if (!m.content.trim()) return;
                saveKnowledgeMut.mutate(m.content);
              }
              if (key === 'memory') {
                if (!m.content.trim()) return;
                saveMemoryMut.mutate(m.content);
              }
            }}
          />
        </Flex>
      ) : undefined,
      footerPlacement: 'outer-start' as const,
    };
  });

  /** 左侧会话栏：Ant Design X 的 Conversations（唯一框架），搜索默认折叠。 */
  const renderConversations = () => (
    <div
      style={{
        width: narrow ? '100%' : 268,
        flex: narrow ? '0 0 auto' : '0 0 268px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 0,
      }}
    >
      <Flex gap={6} align="center">
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索会话"
          value={sessionKeyword}
          onChange={(e) => setSessionKeyword(e.target.value)}
          style={{ flex: 1 }}
          aria-label="搜索会话"
        />
        <Tooltip title={sessionSearchOpen ? '收起搜索' : '搜索会话'}>
          <Button
            size="small"
            type={sessionSearchOpen ? 'primary' : 'default'}
            icon={<SearchOutlined />}
            aria-label="搜索会话"
            onClick={() => {
              setSessionSearchOpen((v) => !v);
              if (sessionSearchOpen) setSessionKeyword('');
            }}
          />
        </Tooltip>
      </Flex>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid var(--ant-color-border-secondary, #EEF0F4)', borderRadius: 10, padding: 4 }}>
        <Conversations
          items={conversationItems}
          activeKey={activeId ?? undefined}
          groupable={{ collapsible: true }}
          onActiveChange={(key) => {
            setActiveId(String(key));
            setStreamError('');
            setStreamNotice('');
          }}
          creation={{
            icon: <PlusOutlined />,
            label: '新建会话',
            onClick: () => createMut.mutate(selectedModel),
          }}
          menu={(item) => ({
            items: [
              {
                key: 'delete',
                label: '删除会话',
                danger: true,
                onClick: () => confirmDeleteSession(String(item.key)),
              },
            ],
          })}
        />
      </div>
    </div>
  );

  const renderChat = () => {
    const noSessions = !sessionsQuery.isLoading && sessions.length === 0;

    return (
      <Flex gap={12} align="stretch" wrap={narrow} style={{ minHeight: narrow ? 480 : 'calc(100vh - 220px)' }}>
      {narrow ? null : renderConversations()}
      <Card
        size="small"
        style={{ flex: 1, minWidth: 0 }}
        styles={{ body: { padding: 16, display: 'flex', flexDirection: 'column', minHeight: narrow ? 480 : 'calc(100vh - 220px)' } }}
        title={
          <Space orientation="horizontal" size={8}>
            <RobotOutlined style={{ color: '#2B5CE6' }} />
            <Typography.Text strong>Agent 助手</Typography.Text>
          </Space>
        }
        extra={
          <Flex align="center" gap={8} wrap="wrap">
            <Select
              size="small"
              style={{ minWidth: 168 }}
              value={selectedModel || undefined}
              options={modelOptions}
              onChange={setSelectedModel}
              placeholder="选择模型"
              popupMatchSelectWidth={220}
              aria-label="选择模型"
            />
            <Tooltip title="助手后端（AgentScope）是否可达">
              <Tag color={status?.available ? 'green' : 'red'} variant="filled">
                {status?.available ? '助手在线' : '助手不可用'}
              </Tag>
            </Tooltip>
            <Tooltip title="代码沙箱：无网络、限额运行，执行后容器立即销毁">
              <Tag color={status?.sandbox ? 'blue' : 'default'} variant="filled" icon={<SafetyCertificateOutlined />}>
                {status?.sandbox ? '沙箱就绪' : '沙箱离线'}
              </Tag>
            </Tooltip>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {quotaText}
            </Typography.Text>
          </Flex>
        }
      >
        {status?.available === false && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            title="Agent 网关不可用"
            description={
              <Flex vertical gap={8}>
                <Typography.Text>
                  {status.reason || '当前无法连接到助手服务，请稍后重试。'}
                </Typography.Text>
                <Button
                  size="small"
                  onClick={() => {
                    void statusQuery.refetch();
                    void quotaQuery.refetch();
                    void modelsQuery.refetch();
                  }}
                >
                  检查助手状态
                </Button>
              </Flex>
            }
          />
        )}

        {streamError && (
          <Alert
            type="error"
            showIcon
            closable={{ onClose: () => setStreamError('') }}
            style={{ marginBottom: 12 }}
            title="生成出错"
            description={streamError}
          />
        )}
        {streamNotice && (
          <Alert
            type="info"
            showIcon
            closable={{ onClose: () => setStreamNotice('') }}
            style={{ marginBottom: 12 }}
            title={streamNotice}
          />
        )}

        {sessionsQuery.isError && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            title="会话列表加载失败"
            description={
              sessionsQuery.error instanceof Error
                ? sessionsQuery.error.message
                : '请稍后重试'
            }
            action={
              <Button size="small" onClick={() => void sessionsQuery.refetch()}>
                重试
              </Button>
            }
          />
        )}

        {noSessions ? (
          <Flex vertical align="center" justify="center" style={{ flex: 1, gap: 12 }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有会话"
              style={{ margin: '32px 0' }}
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              loading={createMut.isPending}
              onClick={() => createMut.mutate(selectedModel)}
            >
              新建会话
            </Button>
          </Flex>
        ) : !activeId ? (
          sessionsQuery.isLoading ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : (
            <Flex vertical align="center" justify="center" style={{ flex: 1 }}>
              <Empty
                image={<RobotOutlined style={{ fontSize: 48, color: '#C7CDD6' }} />}
                description="从上方选择一个会话开始对话"
              />
            </Flex>
          )
        ) : sessionQuery.isLoading ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : sessionQuery.isError ? (
          <Alert
            type="error"
            showIcon
            title="会话加载失败"
            description={
              sessionQuery.error instanceof Error ? sessionQuery.error.message : '请稍后重试'
            }
            action={
              <Button size="small" onClick={() => void sessionQuery.refetch()}>
                重试
              </Button>
            }
          />
        ) : (
          <div style={{ flex: 1, minHeight: 240, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
            {displayMessages.length === 0 ? (
              <Flex vertical align="center" justify="center" style={{ flex: 1, gap: 16, padding: '24px 0' }}>
                <Welcome
                  variant="borderless"
                  icon={<RobotOutlined style={{ fontSize: 40, color: '#2B5CE6' }} />}
                  title="今天想研究什么？"
                  description="我可以做多步深度调研、检索植物与生物医学数据库、查阅文献，并把结论沉淀到知识库与 D509 工作台。"
                />
                <Prompts
                  title="试试这些"
                  wrap
                  items={suggestionItems}
                  onItemClick={(info) => {
                    const key = String(info.data.key ?? '');
                    if (key.startsWith('skill:')) fillSkill(key.slice('skill:'.length));
                    else setInput(String(info.data.label));
                  }}
                />
              </Flex>
            ) : (
              <Bubble.List
                autoScroll
                items={bubbleItems}
                role={{
                  user: { placement: 'end', variant: 'filled', shape: 'corner' },
                  ai: { placement: 'start', variant: 'outlined', shape: 'corner' },
                  system: { placement: 'start', variant: 'borderless', shape: 'round' },
                }}
                style={{ flex: 1 }}
              />
            )}
          </div>
        )}

        {hitlPanel}

        <div style={{ marginTop: 12 }}>
          <Sender
            value={input}
            onChange={setInput}
            onSubmit={(text) => {
              if (text.trim()) void send(text);
            }}
            loading={generating}
            onCancel={() => void stop()}
            disabled={!activeId}
            autoSize={{ minRows: 2, maxRows: 6 }}
            submitType="enter"
            placeholder={
              activeId ? '输入你的问题，例如：检索与青蒿素相关的生物医学文献' : '请先选择或新建一个会话'
            }
            footer={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Enter 发送，Shift + Enter 换行。回答由平台模型生成，仅供科研参考。
              </Typography.Text>
            }
          />
        </div>
      </Card>
      </Flex>
    );
  };

  const modeSwitcher = (
    <Segmented
      value={mode}
      onChange={(v) => switchMode(v as 'chat' | 'kb' | 'lab' | 'hub')}
      options={[
        { label: 'Agent 对话', value: 'chat' },
        { label: '知识库问答', value: 'kb' },
        { label: '实验记录', value: 'lab' },
        { label: '能力中心', value: 'hub' },
      ]}
    />
  );

  if (mode === 'hub') {
    return <AgentHub embedded extra={modeSwitcher} />;
  }

  return (
    <PageShell
      title="Agent 个人助手"
      description="多步深度调研、数据库检索、文献阅读与工作台协同；回答可沉淀到知识库。"
      extra={
        <Space orientation="horizontal" size={8} wrap>
          <Segmented
            value={mode}
            onChange={(v) => switchMode(v as 'chat' | 'kb' | 'lab' | 'hub')}
            options={[
              { label: 'Agent 对话', value: 'chat' },
              { label: '知识库问答', value: 'kb' },
              { label: '实验记录', value: 'lab' },
              { label: '能力中心', value: 'hub' },
            ]}
          />
          {mode === 'chat' && generating && (
            <Tag color="processing" variant="filled">
              正在生成…
            </Tag>
          )}
          {mode === 'chat' && status?.model && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              当前模型：{modelLabel(status.model)}
            </Typography.Text>
          )}
        </Space>
      }
    >

      {mode === 'lab' ? (
        <Card
          size="small"
          styles={{ body: { padding: 16 } }}
          title={
            <Space size={8}>
              <ExperimentOutlined style={{ color: '#2B5CE6' }} />
              <Typography.Text strong>实验记录</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                电子实验记录已并入个人助手，可直接沉淀为任务或知识库条目
              </Typography.Text>
            </Space>
          }
        >
          <ElnPanel />
        </Card>
      ) : mode === 'kb' ? (
        <Card
          size="small"
          styles={{ body: { padding: 16 } }}
          title={
            <Space size={8}>
              <RobotOutlined style={{ color: '#2B5CE6' }} />
              <Typography.Text strong>知识库问答</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                按知识库与分类检索，回答带原文引用
              </Typography.Text>
            </Space>
          }
          extra={
            <Button size="small" onClick={() => navigate('/knowledge')}>
              管理知识库
            </Button>
          }
        >
          <KnowledgeAsk bare height={narrow ? '48vh' : 'calc(100vh - 360px)'} />
        </Card>
      ) : (
        <Flex vertical gap={16}>
          {renderToolbar()}
          {renderChat()}
        </Flex>
      )}

      <Drawer
        title="长期记忆"
        size={narrow ? '100%' : 420}
        open={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        styles={{ body: { display: 'flex', flexDirection: 'column', gap: 12 } }}
        extra={
          <Tooltip title="刷新">
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={memoriesQuery.isFetching}
              onClick={() => void memoriesQuery.refetch()}
            />
          </Tooltip>
        }
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          记忆会在每次对话开始时自动注入，助手可自行检索、写入或遗忘。共 {memoriesQuery.data?.total ?? 0} 条。
        </Typography.Text>
        <Flex gap={8} wrap>
          <Input.Search
            allowClear
            placeholder="搜索记忆内容"
            style={{ flex: 1, minWidth: 180 }}
            onSearch={(v) => setMemoryQ(v.trim())}
          />
          <Select
            style={{ width: 120 }}
            value={memoryKind}
            onChange={setMemoryKind}
            options={[
              { value: '', label: '全部类型' },
              { value: 'fact', label: '事实' },
              { value: 'preference', label: '偏好' },
              { value: 'lesson', label: '经验' },
              { value: 'project', label: '项目' },
              { value: 'note', label: '摘录' },
            ]}
          />
        </Flex>
        {memoriesQuery.isLoading ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : memoriesQuery.isError ? (
          <Alert
            type="error"
            showIcon
            title="记忆加载失败"
            description={errText(memoriesQuery.error)}
          />
        ) : (memoriesQuery.data?.memories ?? []).length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={memoryQ || memoryKind ? '没有匹配的记忆' : '还没有记忆，对话时可点“记住”或由助手自动写入'}
          />
        ) : (
          <Flex vertical gap={10} style={{ overflowY: 'auto' }}>
            {(memoriesQuery.data?.memories ?? []).map((m) => (
              <Card
                key={m.id}
                size="small"
                styles={{ body: { padding: 12 } }}
                title={
                  <Flex align="center" gap={6} wrap>
                    <Tag variant="filled" color="blue">
                      {m.kind}
                    </Tag>
                    <Typography.Text strong ellipsis style={{ maxWidth: 220 }}>
                      {m.title || '未命名记忆'}
                    </Typography.Text>
                  </Flex>
                }
                extra={
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label="删除记忆"
                    loading={deleteMemoryMut.isPending}
                    onClick={() => {
                      modal.confirm({
                        title: '删除这条记忆？',
                        content: m.title || m.content.slice(0, 40),
                        okText: '删除',
                        okButtonProps: { danger: true },
                        cancelText: '取消',
                        onOk: () => deleteMemoryMut.mutateAsync(m.id),
                      });
                    }}
                  />
                }
              >
                <Typography.Paragraph
                  style={{ marginBottom: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                  ellipsis={{ rows: 4, expandable: true, symbol: '展开' }}
                >
                  {m.content}
                </Typography.Paragraph>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {m.updatedAt ? dayjs(m.updatedAt).fromNow() : ''}
                  {m.sourceSession ? ' · 来自会话' : ''}
                </Typography.Text>
              </Card>
            ))}
          </Flex>
        )}
      </Drawer>
    </PageShell>
  );
}
