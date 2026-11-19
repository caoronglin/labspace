/**
 * AgentScope 受控代理客户端（门户后端 `/api/agent/as/*`）。
 *
 * 后端契约
 * --------
 * - `GET    /api/agent/as/{group}`                列出能力组
 * - `GET    /api/agent/as/{group}/{path}`         查询
 * - `POST   /api/agent/as/{group}/{path}`         创建 / 动作（需 CSRF）
 * - `PATCH  /api/agent/as/{group}/{path}`
 * - `DELETE /api/agent/as/{group}/{path}`
 *
 * 后端只代理白名单里的能力组，并把出站身份固定为当前门户会话用户；返回体是
 * AgentScope 的**原始 JSON**，状态码原样透传（4xx/5xx 带 JSON `detail`）。
 * 因此这里不做任何二次包装，也不吞错误：调用方拿到的就是上游的真实结果。
 *
 * 为什么没有直接复用 `services/api.ts` 里的 `request()`
 * -----------------------------------------------------
 * `request()` 在 api.ts 里没有导出（只导出了 `readCookie`），而 api.ts 又不允许
 * 改动，所以本文件复用 `readCookie` + 同源 fetch 自己实现一份，并保留同样的
 * 「401 跳登录」行为与 CSRF 双提交头。
 */
import { readCookie, redirectToLogin, SessionExpiredError } from './api';

/** 后端允许代理的能力组（与后端 `ALLOWED_GROUPS` 保持一致）。 */
export const AS_GROUPS = [
  'agent',
  'channels',
  'credential',
  'hub',
  'knowledge_bases',
  'mcp',
  'schedule',
  'sessions',
  'skill',
  'sop',
  'workspace',
  'embedding-model',
  'model',
  'tts-model',
  'realtime',
] as const;

export type AsGroup = (typeof AS_GROUPS)[number];

const AS_BASE = '/api/agent/as';

export type AsQueryValue = string | number | boolean | null | undefined;
export type AsQuery = Record<string, AsQueryValue>;

/** 上游返回 4xx/5xx 时抛出：带状态码，便于页面区分「暂不可用」与「参数非法」。 */
export class AsApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AsApiError';
    this.status = status;
  }
}

function asUrl(group: AsGroup, path: string, query?: AsQuery): string {
  const clean = String(path ?? '')
    .split('?')[0]
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const base = clean ? `${AS_BASE}/${group}/${clean}` : `${AS_BASE}/${group}`;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}

/** 会话过期时回登录页（回跳参数只接受站内相对路径）。 */

/** 把上游的错误体翻译成一句人能读懂的原因。 */
async function errorDetail(res: Response): Promise<string> {
  let detail: unknown;
  try {
    detail = await res.json();
  } catch {
    const text = await res.text().catch(() => '');
    return text.trim() || `HTTP ${res.status}`;
  }
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (detail && typeof detail === 'object') {
    const record = detail as Record<string, unknown>;
    const raw = record.detail ?? record.error ?? record.message;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (Array.isArray(raw)) {
      // FastAPI 的 422：[{ loc, msg, type }]
      const parts = raw
        .map((item) => {
          if (!item || typeof item !== 'object') return String(item);
          const it = item as Record<string, unknown>;
          const loc = Array.isArray(it.loc) ? it.loc.join('.') : '';
          const msg = typeof it.msg === 'string' ? it.msg : '';
          return loc ? `${loc}: ${msg}` : msg;
        })
        .filter(Boolean);
      if (parts.length) return parts.join('；');
    }
  }
  return `HTTP ${res.status}`;
}

async function asFetch<T>(
  group: AsGroup,
  path: string,
  init: { method: string; body?: unknown; query?: AsQuery },
): Promise<T> {
  const url = asUrl(group, path, init.query);
  const csrf = readCookie('labspace_csrf');
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
  const headers: Record<string, string> = {};
  if (init.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (csrf && init.method !== 'GET') headers['X-CSRF-Token'] = csrf;

  const res = await fetch(url, {
    method: init.method,
    credentials: 'include',
    headers,
    body:
      init.body === undefined ? undefined : isForm ? (init.body as FormData) : JSON.stringify(init.body),
  });

  if (res.status === 401) {
    if (!window.location.pathname.startsWith('/login')) redirectToLogin();
    throw new SessionExpiredError();
  }
  if (!res.ok) {
    throw new AsApiError(res.status, await errorDetail(res));
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    const text = await res.text();
    // SAFETY: 非 JSON 成功响应（上游只会返回纯文本）按原样透传，调用方按需收窄；
    // 这里不会静默丢内容，因此断言成泛型 T 与运行时行为一致。
    return text as unknown as T;
  }
  return (await res.json()) as T;
}

/** 列出能力组：`GET /api/agent/as/{group}`。 */
export function asList<T = unknown>(group: AsGroup, path = '', query?: AsQuery): Promise<T> {
  return asFetch<T>(group, path, { method: 'GET', query });
}

/** 查询单个资源：`GET /api/agent/as/{group}/{path}`。 */
export function asGet<T = unknown>(group: AsGroup, path: string, query?: AsQuery): Promise<T> {
  return asFetch<T>(group, path, { method: 'GET', query });
}

/** 创建 / 触发动作：`POST /api/agent/as/{group}/{path}`（CSRF 由 request 头带上）。 */
export function asPost<T = unknown>(
  group: AsGroup,
  path: string,
  body?: unknown,
  query?: AsQuery,
): Promise<T> {
  return asFetch<T>(group, path, { method: 'POST', body, query });
}

/** 更新：`PATCH /api/agent/as/{group}/{path}`。 */
export function asPatch<T = unknown>(
  group: AsGroup,
  path: string,
  body?: unknown,
  query?: AsQuery,
): Promise<T> {
  return asFetch<T>(group, path, { method: 'PATCH', body, query });
}

/** 删除：`DELETE /api/agent/as/{group}/{path}`。 */
export function asDelete<T = unknown>(group: AsGroup, path: string, query?: AsQuery): Promise<T> {
  return asFetch<T>(group, path, { method: 'DELETE', query });
}

/**
 * 上传文件：`POST /api/agent/as/{group}/{path}`，请求体是 `multipart/form-data`。
 *
 * 注意：门户后端当前只按 JSON 解析写操作请求体，multipart 上传是否可用取决于
 * 后端是否放行原始请求体；失败时后端会返回 4xx，页面照常显示原因。
 */
/** 扩展名 → MIME。AgentScope 按 MIME 选解析器，缺失就会被判成
 *  ``application/octet-stream`` 并直接 "No parser registered"（实测）。
 *  浏览器通常会给对，但 .md/.txt 在不同系统上偶发为空，这里兜一层。 */
const UPLOAD_MIME: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** 上传文件，并在 MIME 缺失/为 octet-stream 时按扩展名补一个可用类型。 */
export function asUpload<T = unknown>(
  group: AsGroup,
  path: string,
  form: FormData,
  query?: AsQuery,
): Promise<T> {
  const file = form.get('file');
  if (file instanceof File && (!file.type || file.type === 'application/octet-stream')) {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const mime = UPLOAD_MIME[ext];
    if (mime) {
      // 重建 FormData：File 的 type 是只读的，只能换一个带类型的副本。
      form.delete('file');
      form.append('file', new File([file], file.name, { type: mime }));
    }
  }
  return asFetch<T>(group, path, { method: 'POST', body: form, query });
}

/* ------------------------------------------------------------------ */
/* AgentScope 原始数据结构（按 openapi.json 的 schema 声明）             */
/* ------------------------------------------------------------------ */

/** 渠道（`GET /channels/`）。 */
export interface AsChannel {
  id: string;
  channel_type: string;
  name: string | null;
  user_id: string;
  platform_bot_id: string;
  enabled: boolean;
  platform_config: Record<string, unknown>;
  routing: Record<string, unknown>;
  session: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** 会话（`GET /sessions/`、`GET /channels/{id}/sessions`）。 */
export interface AsSession {
  id: string;
  user_id: string;
  agent_id: string;
  created_at?: string;
  updated_at?: string;
  origin?: Record<string, unknown>;
  config?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

export interface AsSessionList {
  sessions: AsSession[];
  total: number;
}

/** 定时任务（`GET /schedule/`）。 */
export interface AsScheduleData {
  name: string;
  description?: string;
  enabled?: boolean;
  timezone?: string;
  cron_expression: string;
  agent_id?: string;
  started_at?: string;
  ended_at?: string | null;
  stateful?: boolean;
  permission_mode?: string;
}

export interface AsScheduleRecord {
  id: string;
  user_id: string;
  agent_id: string;
  data: AsScheduleData;
  created_at?: string;
  updated_at?: string;
}

export interface AsScheduleList {
  schedules: AsScheduleRecord[];
  total: number;
}

/** 助手（`GET /agent/`）。 */
export interface AsAgentData {
  name: string;
  system_prompt?: string;
  chat_config?: Record<string, unknown>;
}

export interface AsAgent {
  id: string;
  user_id: string;
  data: AsAgentData;
  editable: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface AsAgentList {
  agents: AsAgent[];
  total: number;
}

/** 凭据（`GET /credential/`）。 */
export interface AsCredential {
  id: string;
  user_id: string;
  data: Record<string, unknown>;
  editable?: boolean;
}

export interface AsCredentialList {
  credentials: AsCredential[];
  total: number;
}

/** 对话模型（`GET /model/?provider=...`）。 */
export interface AsModelCard {
  name: string;
  label: string;
  status?: string;
  model_class?: string;
  context_size?: number;
  output_size?: number;
}

export interface AsModelList {
  models: AsModelCard[];
  total: number;
}

/** SOP（`GET /sop/`、`GET /sop/{id}`）。 */
export interface AsSopStep {
  version?: string;
  subject: string;
  description: string;
  executor: Record<string, unknown>;
  verifier?: Record<string, unknown> | null;
  max_attempts?: number;
}

export interface AsSopData {
  name: string;
  description?: string;
  steps: AsSopStep[];
  workspace_grain?: string;
  session_settings?: Record<string, unknown>;
}

export interface AsSopRecord {
  id: string;
  user_id: string;
  data: AsSopData;
  created_at?: string;
  updated_at?: string;
}

export interface AsSopList {
  sops: AsSopRecord[];
  total: number;
}

export interface AsSopStepRunState {
  phase?: string;
  given?: unknown[];
  submission?: unknown[] | null;
  verifications?: unknown[];
}

export interface AsSopRunState {
  id?: string;
  phase: string;
  inputs?: unknown[];
  steps?: AsSopStepRunState[];
  created_at?: string;
}

export interface AsSopRun {
  id: string;
  user_id: string;
  sop_id: string;
  definition: AsSopData;
  sessions?: Record<string, string>;
  state: AsSopRunState;
  created_at?: string;
  updated_at?: string;
}

export interface AsSopRunList {
  runs: AsSopRun[];
  total: number;
}

/** 知识库（`GET /knowledge_bases/`）。 */
export interface AsEmbeddingModelConfig {
  type: string;
  credential_id: string;
  model: string;
  dimensions: number;
  parameters?: Record<string, unknown>;
}

export interface AsKbStatusCounts {
  pending?: number;
  parsing?: number;
  chunking?: number;
  indexing?: number;
  ready?: number;
  error?: number;
}

export interface AsKnowledgeBase {
  id: string;
  name: string;
  description?: string;
  embedding_model_config?: AsEmbeddingModelConfig;
  chunker_config?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  editable: boolean;
  document_count?: number;
  chunk_count?: number;
  credential_name?: string | null;
  status_counts?: AsKbStatusCounts;
}

export interface AsKnowledgeBaseList {
  knowledge_bases: AsKnowledgeBase[];
  total: number;
  page?: number;
  page_size?: number;
}

export interface AsKbDocument {
  id: string;
  filename: string;
  size: number;
  content_type?: string | null;
  status: string;
  error?: string | null;
  chunk_count?: number;
  created_at: string;
  updated_at: string;
}

export interface AsKbDocumentList {
  documents: AsKbDocument[];
  total: number;
  page?: number;
  page_size?: number;
}

export interface AsEmbeddingModelCard {
  type?: string;
  name: string;
  label: string;
  status?: string;
  dimensions: number;
  supported_dimensions?: number[] | null;
}

export interface AsKbEmbeddingProviders {
  providers: { credential: AsCredential; models: AsEmbeddingModelCard[] }[];
  policy?: { kind: string; dimension?: number | null };
}

/** 工作区（`GET /workspace/status`、`GET /workspace/directories`）。 */
export interface AsWorkspaceStatus {
  workdir: string;
  cwd: string;
  git?: {
    branch?: string | null;
    head?: string | null;
    ahead?: number | null;
    behind?: number | null;
    insertions?: number;
    deletions?: number;
    staged?: number;
    unstaged?: number;
    untracked?: number;
    conflicted?: number;
  } | null;
}

export interface AsDirectoryEntry {
  name: string;
  is_dir: boolean;
  size_bytes?: number | null;
  updated_at?: number | null;
}

export interface AsDirectoryListing {
  path: string;
  entries: AsDirectoryEntry[];
}

/** MCP / 技能 / 能力市场。 */
export interface AsMcpView {
  id: string;
  name: string;
  is_stateful: boolean;
  enabled: boolean;
  display_name?: string | null;
  description?: string;
  tags?: string[];
  author?: string | null;
  url?: string | null;
  hub_id?: string | null;
  card_id?: string | null;
  version?: string | null;
}

export interface AsSkillView {
  id: string;
  name: string;
  enabled: boolean;
  display_name?: string | null;
  description?: string;
  tags?: string[];
  author?: string | null;
  url?: string | null;
  hub_id?: string | null;
  card_id?: string | null;
  version?: string | null;
}

export interface AsHubInfo {
  hub_id: string;
  display_name: string;
  description: string;
  icon_url?: string | null;
}

export interface AsMcpCard {
  hub_id: string;
  id: string;
  name: string;
  display_name?: string | null;
  description?: string;
  tags?: string[];
  version?: string | null;
  author?: string | null;
  installs?: number | null;
  downloads?: number | null;
  url?: string | null;
  readme?: string | null;
}

export interface AsSkillCard {
  hub_id: string;
  id: string;
  name: string;
  display_name?: string | null;
  description?: string;
  tags?: string[];
  version?: string | null;
  author?: string | null;
  installs?: number | null;
  downloads?: number | null;
  url?: string | null;
  markdown?: string | null;
}

export interface AsMcpHubPage {
  cards: AsMcpCard[];
  next_cursor?: string | null;
}

export interface AsSkillHubPage {
  cards: AsSkillCard[];
  next_cursor?: string | null;
}
