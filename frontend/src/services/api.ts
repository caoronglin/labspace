/** D509 工作台后端 API 客户端（始终同源，走 Nginx 代理）。 */

export interface ServiceItem {
  id: string;
  name: string;
  description: string;
  category: string;
  url: string;
  icon: string;
  openMode: 'link' | 'embed';
  /** 是否提供「平台内嵌」入口 */
  embed?: boolean;
  /** 内嵌地址（可能与 url 不同） */
  embedUrl?: string;
  /** 一键登录入口（服务自身 OIDC 启动端点） */
  ssoUrl?: string;
  /** 语言说明（上游无中文包时的提示） */
  langNote?: string;
  tags: string[];
  roles: string[];
  notes: string;
  guide: string[];
  health?: { status: string; latency_ms?: number | null; detail?: string };
}

export interface SearchHit {
  title: string;
  url: string;
  content: string;
  engine: string;
  category?: string;
  kind?: 'web' | 'local' | 'paper';
  /** 文献类命中的实际数据源（openalex / semanticscholar / crossref / arxiv）。 */
  hitSource?: string;
  doi?: string;
  authors?: string[];
  year?: number | null;
  venue?: string;
  path?: string;
  /** 仅知识库命中：条目自己的分类与更新时间。 */
  docCategory?: string;
  updatedAt?: string;
}

export interface SearchResponse {
  results: SearchHit[];
  engines?: string[];
  error?: string | null;
  scope: string;
  hot?: string[];
  databases?: DatabaseHit[];
  databaseWarnings?: string[];
  page?: number;
  pageSize?: number;
  localTotal?: number;
  webTotal?: number;
  hasMore?: boolean;
  /** 降级的检索类别（例如文献源全挂时的 papers）。 */
  degraded?: string[];
}

export interface KnowledgeDoc {
  id: number;
  title: string;
  excerpt: string;
  body?: string;
  tags: string[];
  /** 空间内的文件夹路径（如 项目/2026）；空串表示"未分类"。 */
  category: string;
  /** 所属知识库；0 表示未归档。 */
  spaceId: number;
  spaceName?: string;
  visibility: 'private' | 'roles' | 'public';
  roles: string[];
  source: string;
  /** 从文件存储入库时记录的原始位置，用于回链。 */
  fileSource: string;
  filePath: string;
  fileBytes: number;
  fileModified?: string | null;
  owner: string;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeCategory {
  name: string;
  label: string;
  docs: number;
  chars: number;
  latest?: string;
}

export interface KnowledgeFacets {
  categories: KnowledgeCategory[];
  tags: { name: string; docs: number }[];
  total: number;
}

export interface KnowledgeSpace {
  id: number;
  name: string;
  description: string;
  visibility: 'private' | 'roles' | 'public';
  roles: string[];
  owner: string;
  ownerName: string;
  docs: number;
  chars: number;
  latest?: string | null;
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSpaces {
  items: KnowledgeSpace[];
  unfiled: { docs: number; chars: number; latest?: string | null };
  total: number;
}

export interface IngestResult {
  name: string;
  ok: boolean;
  status: 'created' | 'updated' | 'skipped';
  reason?: string;
  docId?: number;
  title?: string;
  chars?: number;
  extractor?: string;
  bytes?: number;
  truncated?: boolean;
  fileSource?: string;
  filePath?: string;
  path?: string;
  category?: string;
}

export interface IngestSummary {
  created: number;
  updated: number;
  skipped: number;
  chars: number;
}

export interface RagCitation {
  n: number;
  chunkId: string;
  docId: number;
  title: string;
  score: number;
  excerpt: string;
  category?: string;
  spaceId?: number;
  fileSource?: string;
  filePath?: string;
  updatedAt: string;
}

export interface RagAnswer {
  answer: string;
  mode: 'generated' | 'retrieval' | 'empty';
  warning?: string;
  citations: RagCitation[];
  tookMs: number;
}

export interface RagStatus {
  available: boolean;
  indexReady?: boolean;
  indexError?: string;
  documents?: number;
  chunks?: number;
  error?: string;
  generator?: { configured: boolean; protocol: string; model: string };
}

export interface DatabaseHit {
  id: string;
  title: string;
  url: string;
  snippet: string;
  source: string;
  type: string;
}

/** 每日论文条目（后端 /api/daily-papers 返回）。 */
/** 一条每日论文订阅。 */
export interface DailySub {
  topic: string;
  limit: number;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastRun?: string;
  lastCount?: number;
  lastError?: string;
}

export interface DailyPaper {
  title: string;
  doi: string;
  authors: string[];
  venue: string;
  year?: number | null;
  abstract: string;
  snippet: string;
  url: string;
  pdfUrl: string;
  citations?: number | null;
  /** 文献源标识：openalex / semanticscholar / crossref / arxiv。 */
  source: string;
  score?: number | null;
  /** 后端若附了 AI 摘要则渲染，没有就不渲染整块。 */
  aiSummary?: string;
}

/** 每个文献源的一轮抓取结果（全源失败时用来说明原因）。 */
export interface DailyPaperAttempt {
  source: string;
  status: string;
}

export interface DailyPapersResponse {
  day: string;
  topic: string;
  /** 本批条目的来源标签：单一源给源名，混合给 mixed，全败给 none。 */
  source: string;
  sources?: string[];
  count: number;
  total?: number;
  page?: number;
  pageSize?: number;
  papers: DailyPaper[];
  attempts?: DailyPaperAttempt[];
  cached?: boolean;
}

export interface CorpusItem {
  type: 'service' | 'database' | 'command' | 'tool' | 'page' | 'snapotter';
  id: string;
  title: string;
  subtitle: string;
  description: string;
  url: string;
  path: string;
}

export interface EmbedInfo {
  id: string;
  name: string;
  url: string;
  embeddable: boolean;
  reason: string;
  evidence: string;
  checked_at: string;
  ssoUrl?: string;
}

export interface AccountGroup {
  name: string;
  displayName: string;
  enabled: boolean;
}

export interface AccountItem {
  name: string;
  displayName: string;
  email: string;
  groups: string[];
  isAdmin: boolean;
  isForbidden: boolean;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastSigninAt: string;
  fileGrants: FileGrant[];
  homeReady: boolean;
}

export interface AccountsResponse {
  accounts: AccountItem[];
  total: number;
  groups: AccountGroup[];
  /** 预配置用户组的文件权限模板（来自 LabGo）。 */
  fileGroups: FileGroup[];
  directories: Record<string, string[]>;
  fileAccessAvailable: boolean;
}

export interface WeComConfig {
  enabled: boolean;
  /** 已脱敏的 Webhook 地址（密钥显示为 ****）。 */
  webhookUrl: string;
  announcements: boolean;
  dailyDigest: boolean;
  digestTime: string;
  configured: boolean;
  lastDigestDate: string;
}

/**
 * 管理端概览（/api/admin/info）。
 *
 * 之前这里写的是 ``Record<string, any>``：调用方拿到的每个字段都是 any，
 * 拼错字段名（roles.admin → role.admin）不会有任何提示。这里按后端实际返回
 * 的形状声明，未列出的扩展字段保留在 index signature 里（unknown，用前需收窄）。
 */
export interface AdminInfo {
  host?: { platform?: string; python?: string; hostname?: string };
  disk: { total: number; used: number; free: number; mount?: string };
  containers: string[];
  casdoor: { issuer: string; clientId: string };
  roles: { admin: string[]; teacher: string[] };
  [key: string]: unknown;
}

export interface BackupSnapshot {
  id: string;
  time: string;
  hostname?: string;
  tags: string[];
  paths: string[];
}

/** 人员目录条目：只有 id / 用户名 / 姓名，不含邮箱与用户组。 */
export interface PeopleEntry {
  id: string;
  name: string;
  displayName: string;
}

/** 一个后台任务（systemd 定时器 / 一次性任务 / 常驻服务）。 */
export interface AdminTask {
  unit: string;
  label: string;
  kind: 'timer' | 'oneshot' | 'service';
  /** systemd ActiveState：active / inactive / failed / activating … */
  active: string;
  /** systemd Result（失败时为 failed）。 */
  result: string;
  sub: string;
  enabled: string;
  /** 上次运行时间（ISO，可能为空）。 */
  last: string;
  /** 下次运行时间（仅定时器有）。 */
  next: string;
  activates: string;
  /** 是否允许「立即执行」（常驻服务为 false）。 */
  triggerable: boolean;
}

export interface AdminTaskList {
  ok: boolean;
  units: AdminTask[];
  failed: number;
}

/** 异地归档（Git LFS）状态。后端只读状态文件，不接触口令与 git 凭据。 */
export interface BackupGitStatus {
  available: boolean;
  detail?: string;
  outcome?: string;
  /** 最近一次是否真的推送成功。 */
  pushed?: boolean;
  detailMsg?: string;
  keep?: number;
  branch?: string;
  remote?: string;
  generatedAt?: string;
  totalBytes?: number;
  archives?: { name: string; size: number; time: string }[];
}

export interface BackupStatus {
  available: boolean;
  outcome?: string;
  repo?: string;
  scope?: string;
  keep_within?: string;
  generated_at?: string;
  disk?: { total: number; used: number; free: number; mount: string };
  snapshots: BackupSnapshot[];
  detail?: string;
}

export interface FileSource {
  id: string;
  label: string;
  shared: boolean;
  listable: boolean;
  writable?: boolean;
  /** 可写目录（源内相对路径）；空字符串表示整个源可写。 */
  writePaths?: string[];
  /** 可**新建文件夹**的目录（与 writePaths 分开：学生只准上传、不准改目录结构）。 */
  mkdirPaths?: string[];
}

export interface FileGrant {
  source: string;
  path: string;
  /** deny 是"单独收回"，优先于组授权与管理员身份。 */
  access: 'read' | 'write' | 'deny';
}

export interface FileGroup {
  name: string;
  builtin: boolean;
  grants: FileGrant[];
}

export interface GroupPermissionRow extends FileGroup {
  displayName: string;
  enabled: boolean;
  members: string[];
  hasFileGrants: boolean;
  inIdentitySource: boolean;
}

export interface GroupPermissionsResponse {
  groups: GroupPermissionRow[];
  total: number;
  /** 可授权的共享目录（含各源根目录，空字符串表示源根）。 */
  directories: Record<string, string[]>;
  fileAccessAvailable: boolean;
}

export interface AccessProbe {
  source: string;
  path: string;
  actions: Record<string, boolean>;
  /** 动作 → 授权来源：user / group:<名称> / admin。 */
  origin: Record<string, string>;
}

export interface AccessPreviewResponse {
  name: string;
  roles: string[];
  admin: boolean;
  probes: AccessProbe[];
}

export interface FileEntry {
  id: string;
  source: string;
  path: string;
  name: string;
  dir: boolean;
  size: number;
  /** 目录子树内所有文件的字节数之和；文件条目没有这个字段（用 size）。 */
  dirSize?: number;
  modified: string;
  created: string;
}

/** 文本文件正文（Go 核心 /v1/files/{id}/content，经 nginx 同源转发）。 */
export interface FileContent {
  text: string;
  /** 版本标识：保存时回传，服务端据此判断内容是否已被他人改动。 */
  etag: string;
}

/**
 * 乐观并发冲突（HTTP 409）：文件内容已被他人修改。
 *
 * `etag` 是服务端当前的版本号，带它再存一次即"覆盖保存"。
 */
export class FileContentConflictError extends Error {
  readonly etag?: string;
  constructor(message: string, etag?: string) {
    super(message);
    this.name = 'FileContentConflictError';
    this.etag = etag;
  }
}

/** Office 编辑：DOCX 段落/表格、XLSX 单元格窗口、PPTX 文本框/备注。 */
export type OfficeKind = 'docx' | 'xlsx' | 'pptx';

export interface OfficeTextBlock {
  index: number;
  type: 'paragraph';
  style: string;
  text: string;
}

export interface OfficeTableBlock {
  index: number;
  type: 'table';
  rows: string[][];
}

export type OfficeBlock = OfficeTextBlock | OfficeTableBlock;

export interface OfficeSheet {
  name: string;
  rows: string[][];
  maxRow: number;
  maxCol: number;
  window: { rows: number; cols: number };
}

export interface OfficeShape {
  id: number;
  name: string;
  text: string;
  title: boolean;
}

export interface OfficeSlide {
  index: number;
  shapes: OfficeShape[];
  notes: string;
}

export interface OfficeContent {
  kind: OfficeKind;
  name: string;
  size: number;
  /** 旧版 .doc/.xls/.ppt 已转换为 OOXML 读取，保存时再转回原格式。 */
  normalized: boolean;
  originalExt: string;
  truncated?: boolean;
  blocks?: OfficeBlock[];
  sheets?: OfficeSheet[];
  slides?: OfficeSlide[];
}

export interface OfficeSavePayload {
  kind: OfficeKind;
  blocks?: OfficeBlock[];
  sheets?: OfficeSheet[];
  slides?: OfficeSlide[];
}

/** 目录条目按前缀汇总的字节数；键为源内相对路径，'' 表示源根。 */
export interface FileUsage {
  total: number;
  files: number;
  dirs: Record<string, number>;
}

/** rust-bio ORF 命中；坐标为 1-based 闭区间，负链已镜像回正链。 */
export interface SequenceOrf {
  start: number;
  end: number;
  frame: number;
  offset: number;
  strand: '+' | '-';
}

/** CropGenome Toolkit `/sequence/analyze` 的返回；gc 为 0~1 比例而不是百分数。 */




/** rust-bio pairwise 对齐；端点坐标为 0-based 半开区间。 */


/** 区域重叠查询；对外坐标 1-based 闭区间，内部回显 0-based 半开区间。 */



export interface IdResolveCandidate {
  entity_kind: string;
  stable_id: string;
  namespace: string;
  match_type: string;
  annotation_id: string;
  entity_pk: string | number;
}


export interface IdMapOutput {
  identifier: string;
  namespace: string;
  annotation_id: string;
}

export interface IdMapEdge {
  relationship_type: string;
  evidence_source: string;
  confidence_class: string;
  mapping_release?: string | null;
  evidence_url?: string | null;
}


export type FileSortKey = 'name' | 'size' | 'modified' | 'created' | 'path';

/** 我共享出去的路径及当前共享人；名单为空表示已收回。 */
export interface PersonalShare {
  path: string;
  recipients: string[];
  /** 是否授予写权限（可改名/移动/上传，不含删除）；默认 false。 */
  writable: boolean;
}

/** 别人共享给我的个人文件；writable 为真时才可以编辑/移动。 */
export interface SharedEntry {
  id: string;
  owner: string;
  path: string;
  name: string;
  dir: boolean;
  size: number;
  modified: string;
  created: string;
  /** 对方是否授予了写权限（可改名/移动/上传，不含删除）。 */
  writable: boolean;
}

/** 回收站条目：原路径与删除现场，保留期内可原地恢复。 */
export interface FileTrashItem {
  id: string;
  source: string;
  path: string;
  name: string;
  dir: boolean;
  paths: number;
  size: number;
  modified: string;
  deletedAt: string;
  expiresAt: string;
  deletedBy: string;
  restorable?: boolean;
  sourceLabel?: string;
}

export interface FileTrashSummary {
  removed: number;
  skipped: number;
  bytes: number;
}

/** 管理员可见的文件访问事件：谁在什么时间预览/下载了哪个文件。 */
export interface FileAccessEvent {
  id: number;
  userId: string;
  source: string;
  path: string;
  name: string;
  action: string;
  bytes: number;
  status: number;
  at: string;
}

export interface FilePreview {
  kind: string;
  format: string;
  dataUrl?: string;
  rows?: string[][];
  records?: Record<string, unknown>[];
  text?: string;
  meta?: Record<string, unknown>;
  truncated: boolean;
  notice?: string;
}

export interface DatabaseApi {
  key: string;
  name: string;
  kind: string;
  homepage: string;
  summary: string;
  queryHint: string;
  note: string;
  available?: boolean | null;
  statusDetail?: string;
}

/** 目录条目内的 API 摘要 */
export interface DatabaseApiBrief {
  hasApi: boolean;
  name: string;
  summary: string;
  queryHint: string;
  kind: string;
  note: string;
}

export interface DatabaseApiEntry {
  id: string;
  name: string;
  cn: string;
  category: string;
  url: string;
  hasApi: boolean;
  api: DatabaseApi | null;
  note: string;
}

export interface DatabaseApiIndex {
  total: number;
  withApi: number;
  withoutApi: number;
  keys: string[];
  items: DatabaseApiEntry[];
}

export interface DatabaseItem {
  id: string;
  name: string;
  cn: string;
  desc: string;
  url: string;
  category: string;
  tags: string[];
  featured?: boolean;
  /** 已接入的公开 API 摘要（无 API 时 hasApi=false） */
  api?: DatabaseApiBrief | null;
}

export interface DatabaseQueryItem {
  title: string;
  subtitle: string;
  url: string;
  source: string;
  fields: { label: string; value: string }[];
}

export interface DatabaseQueryResult {
  ok: boolean;
  items: DatabaseQueryItem[];
  api: DatabaseApi | null;
  total?: number;
  elapsedMs?: number;
  error?: string | null;
}

export interface Me {
  authenticated: boolean;
  id?: string;
  email?: string;
  /** 会话里的名字（历史账号可能是账号名）。 */
  name?: string;
  /** 服务端从 Casdoor 解析的**中文姓名**，界面应优先用它。 */
  displayName?: string;
  roles?: string[];
  isAdmin?: boolean;
  isTeacher?: boolean;
  /** 系统管理员（lab-superadmin）：在平台管理员之上，能执行平台级运维操作。 */
  isSuperAdmin?: boolean;
  canDispatch?: boolean;
  /** 初始口令还没改：前端必须弹不可关闭的改密框。 */
  mustChangePassword?: boolean;
}

// ---------------- 个人工作台 ----------------

export interface WorkbenchItem {
  id: string;
  kind: string;
  title: string;
  content?: string;
  status?: string;
  priority?: string;
  tags?: string[];
  project_id?: string | null;
  plan_id?: string | null;
  due_date?: string | null;
  /** 挂到文件存储里的文件/目录：来源（users/public/…）与相对路径。 */
  link_source?: string;
  link_path?: string;
  source?: string;
  ai_class?: string;
  ai_reason?: string;
  confidence?: number;
  created_at?: string;
  updated_at?: string;
}

export interface WorkbenchProject {
  id: string;
  name: string;
  description?: string;
  status?: string;
  health?: string;
  progress?: number;
  next_step?: string;
  due_date?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface WorkbenchPlan {
  id: string;
  kind?: string;
  title: string;
  outcome?: string;
  metrics?: string;
  horizon?: string;
  progress?: number;
  status?: string;
  next_step?: string;
  due_date?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface WorkbenchBrief {
  date?: string | null;
  content?: string;
  payload?: Record<string, unknown>;
}

export interface WorkbenchSummary {
  today: {
    tasks: WorkbenchItem[];
    others: WorkbenchItem[];
    overdue: WorkbenchItem[];
    dueToday: WorkbenchItem[];
    doneToday: WorkbenchItem[];
  };
  projects: WorkbenchProject[];
  plans: { directions: WorkbenchPlan[]; stages: WorkbenchPlan[] };
  brief: WorkbenchBrief | null;
  stats: {
    activeTasks: number;
    activeProjects: number;
    activeDirections: number;
    inbox: number;
    completedThisWeek: number;
  };
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  level?: string;
  author?: string | null;
  created_at?: string;
}

export interface WorkbenchCapture {
  item: WorkbenchItem;
  ai_class: string;
  ai_reason: string;
  confidence: number;
  extracted: { due_date?: string | null; tags: string[]; priority: string };
}

// ---------------- 导师绑定 ----------------
//
// 旧的「指派任务」（AssignmentFile / WorkbenchAssignment / AssignmentPerson 等，
// 对应 /api/workbench/assignments*）当前没有 UI 入口，封装与类型已删除；
// 后端路由仍在，需要恢复功能时按路由重新封装即可。

export interface MentorBindingRow {
  userId: string;
  userName: string;
  mentorId: string;
  mentorName: string;
}

export interface MentorBindings {
  bindings: MentorBindingRow[];
  interns: { id: string; name: string; email: string; rank: number; rankLabel: string }[];
  mentors: { id: string; name: string; email: string; rank: number; rankLabel: string }[];
  myMentor: MentorBindingRow | null;
  canBind: boolean;
  myRank: number | null;
  myRankLabel: string;
}

// ---------------- Agent 助手 ----------------

export interface AgentStatus {
  available: boolean;
  reason?: string;
  gateway?: string;
  model?: string;
  models: AgentModel[];
  skills?: AgentSkill[];
  sandbox?: boolean;
  memoryCount?: number;
  quotas: {
    messages_per_hour: number;
    messages_per_day: number;
    tokens_per_day: number;
    max_sessions: number;
  };
}

export interface AgentSkill {
  name: string;
  description: string;
}

export interface AgentModel {
  id: string;
  label?: string;
  provider?: string;
  context?: number | null;
  enabled?: boolean;
}

export interface AgentSession {
  id: string;
  title: string;
  model: string;
  status: string;
  message_count?: number;
  tokens_in?: number;
  tokens_out?: number;
  created_at?: string;
  updated_at?: string;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  meta?: Record<string, unknown>;
  created_at?: string | null;
}

export interface AgentMemory {
  id: string;
  kind: 'fact' | 'preference' | 'lesson' | 'project' | 'note';
  title: string;
  content: string;
  sourceSession?: string;
  pinned: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentQuota {
  quotas?: Record<string, number>;
  used?: {
    messagesHour?: number;
    messagesDay?: number;
    tokensToday?: number;
    sessionsActive?: number;
  };
  remaining?: Record<string, number>;
}

export interface AgentSkillConfig {
  id: string;
  name: string;
  description?: string;
  path: string;
  enabled: boolean;
}

export interface AgentSkillOption {
  name: string;
  description: string;
  path: string;
  root: string;
}

export interface AgentMcpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  enabled: boolean;
}

export interface AgentEndpointModel {
  id: string;
  name?: string;
  context?: number;
  max_tokens?: number;
  reasoning?: boolean;
  image?: boolean;
}

export interface AgentModelEndpoint {
  provider: string;
  name?: string;
  base_url: string;
  api: string;
  api_key?: string;
  api_key_set?: boolean;
  clear_api_key?: boolean;
  models: AgentEndpointModel[];
  enabled: boolean;
}

export interface AgentAdminConfig {
  models?: AgentModel[];
  default_model?: string;
  quotas?: {
    messages_per_hour?: number;
    messages_per_day?: number;
    tokens_per_day?: number;
    max_sessions?: number;
  };
  plugins?: { id: string; name: string; enabled: boolean }[];
  system_prompt?: string;
  skills?: AgentSkillConfig[];
  mcp_servers?: AgentMcpServerConfig[];
  model_endpoints?: AgentModelEndpoint[];
  runtime_applied?: boolean;
  runtime_error?: string;
}

export interface AgentUsageRow {
  user_id: string;
  messages: number;
  tokens_in: number;
  tokens_out: number;
  sessions?: number;
}

/** GET /api/agent/admin/usage 实际返回结构 */
export interface AgentUsageSummary {
  users: AgentUsageRow[];
  totals: {
    messages: number;
    tokens_in: number;
    tokens_out: number;
    sessions: number;
  };
}

// ---------------- 翻译 / 文档解析 / 天气 ----------------

export interface TranslateStatus {
  provider: string;
  available: boolean;
  reason?: string;
  grace?: boolean;
  base_url?: string;
  model?: string;
  models?: string[];
  languages: { value: string; label: string }[];
  maxChars?: number;
  fallback?: {
    provider: string;
    model: string;
    available: boolean;
    reason?: string;
  };
  effective_available?: boolean;
}

export interface TranslateResult {
  translated: string;
  target_lang: string;
  model: string;
  provider?: string;
  fallback_used?: boolean;
  fallback_reason?: string;
  elapsed_ms: number;
  usage?: { input?: number | null; output?: number | null };
}


export interface WeatherReport {
  city: string;
  admin?: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone: string;
  current: {
    temperature: number | null;
    apparent: number | null;
    humidity: number | null;
    wind: number | null;
    code: number | null;
    description: string;
  };
  daily: {
    date: string;
    code: number | null;
    description: string;
    max: number | null;
    min: number | null;
    precipitation: number | null;
    precipitationProbability: number | null;
  }[];
  updated_at: string;
  source: string;
}

/* ---------------- 配色搭配（Go colorlab） ---------------- */

export interface ColorPalette {
  id: number;
  source: string;
  name: string;
  count: number;
  colors: string[];
}

export interface ColorPaletteList {
  items: ColorPalette[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface ColorMeta {
  total: number;
  sources: { name: string; count: number }[];
  counts: Record<string, number>;
  max_colors: number;
  max_count: number;
}

export interface ColorMatchItem extends ColorPalette {
  score: number;
  average: number;
  nearest: { seed: string; hex: string; distance: number }[];
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function readCookie(name: string): string | undefined {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.split('=').slice(1).join('=')) : undefined;
}

export interface LabopsField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'date' | 'number';
}

export interface LabopsTemplate {
  id: string;
  name: string;
  description: string;
  fields: LabopsField[];
  builtin: boolean;
}

export interface LabopsEntry {
  id: string;
  template_id: string | null;
  title: string;
  content: Record<string, string>;
  tags: string[];
  status: string;
  links: Record<string, string>;
  entry_date: string;
  created_at: string;
  updated_at: string;
}

export interface LabopsPublishResult {
  workspaceId: number;
  workspaceName: string;
  databaseId: number;
  databaseName: string;
  /** tables: [{ id, name, rows, inserted }] */
  tables: { id: number; name: string; rows: number; inserted: number }[];
  /** 本次是否新建了工作区/数据库/表 */
  created: boolean;
}

export interface LabopsLiterature {
  id: string;
  doi: string;
  title: string;
  authors: string;
  journal: string;
  pub_year: string;
  abstract: string;
  url: string;
  tags: string[];
  notes: string;
  status: string;
  library_id?: string;
  folder_id?: string;
  score?: number;
  mode?: string;
  updated_at: string;
}

/** 文献库：一个人可以有多个库，默认库不可删除。 */
export interface LabopsLibrary {
  id: string;
  name: string;
  description: string;
  color: string;
  is_default: boolean;
  item_count: number;
  folder_count: number;
  created_at: string;
  updated_at: string;
}

/** 文献库里的文件夹，parent_id 为空表示库根目录。 */
export interface LabopsLibraryFolder {
  id: string;
  library_id: string;
  parent_id: string;
  name: string;
  item_count: number;
  created_at: string;
  updated_at: string;
}

/** 会话失效时统一抛错，页面据此跳转登录 */
export class SessionExpiredError extends Error {
  constructor() {
    super('会话已过期');
    this.name = 'SessionExpiredError';
  }
}

/**
 * 会话过期时跳登录页。
 *
 * 这里是唯一一处跳转：目标固定为同源 ``/api/auth/login``，回跳参数只接受
 * 站内相对路径（以单个 ``/`` 开头，排除 `//host` 这类协议相对地址）。
 * 用 URL 构造而不是字符串拼接，origin 由浏览器给出，不可能被外部值改写。
 */
export function redirectToLogin(): void {
  const back = `${window.location.pathname}${window.location.search}`;
  const target = new URL('/api/auth/login', window.location.origin);
  if (back.startsWith('/') && !back.startsWith('//')) {
    target.searchParams.set('back', back);
  }
  window.location.assign(target.toString());
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const csrf = readCookie('labspace_csrf');
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
  const headers = {
    ...(init.body && !isForm ? JSON_HEADERS : {}),
    ...(init.headers as Record<string, string> | undefined),
    ...(csrf && init.method && init.method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
  };
  const res = await fetch(path, { credentials: 'include', ...init, headers });
  if (res.status === 401 && !path.startsWith('/api/me')) {
    // 会话过期：回登录页并带上原路径（跳转逻辑集中在 redirectToLogin）
    if (!window.location.pathname.startsWith('/login')) {
      redirectToLogin();
    }
    throw new SessionExpiredError();
  }
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      // Go 核心用 {"error": ...}，FastAPI 用 {"detail": ...}，CropGenome
      // 用 {"code","message"}；只读一种的话拒绝原因会退化成裸状态码。
      detail = body?.detail ?? body?.error ?? body?.message ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function requestBlob(path: string): Promise<Blob> {
  const res = await fetch(path, { credentials: 'include' });
  if (res.status === 401) {
    if (!window.location.pathname.startsWith('/login')) {
      redirectToLogin();
    }
    throw new SessionExpiredError();
  }
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      detail = body?.detail ?? body?.error ?? body?.message ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.blob();
}

/**
 * 保存文本文件正文。
 *
 * 单独写一个请求函数而不是复用 request()：409（内容已被他人修改）需要单独识别，
 * 并把服务端当前的 etag 带回去，前端才能提示用户"重新加载"还是"覆盖保存"。
 */
async function requestFileContentPut(
  path: string,
  body: { text: string; etag: string },
): Promise<void> {
  const csrf = readCookie('labspace_csrf');
  const res = await fetch(path, {
    method: 'PUT',
    credentials: 'include',
    headers: {
      ...JSON_HEADERS,
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    if (!window.location.pathname.startsWith('/login')) {
      redirectToLogin();
    }
    throw new SessionExpiredError();
  }
  if (res.status === 409) {
    let detail = '内容已被他人修改';
    let etag: string | undefined;
    try {
      const payload = await res.json();
      detail = payload?.error ?? payload?.detail ?? detail;
      etag = payload?.etag ? String(payload.etag) : undefined;
    } catch {
      /* ignore */
    }
    throw new FileContentConflictError(detail, etag);
  }
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const payload = await res.json();
      detail = payload?.detail ?? payload?.error ?? payload?.message ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
}

export const api = {
  me: () => request<Me>('/api/me'),
  /** 每日诗词（今日诗词 jinrishici.com）：诗句 + 作者 + 出处，按自然日缓存。 */
  saying: () =>
    request<{ text: string; author?: string; origin?: string; date: string; cached: boolean }>('/api/saying'),
  services: () => request<{ services: ServiceItem[] }>('/api/services'),
  servicesHealth: () => request<{ services: ServiceItem[] }>('/api/services/health'),
  serviceHealth: (id: string) => request<{ status: string; latency_ms?: number; detail?: string }>(`/api/services/${id}/health`),
  serviceEmbed: (id: string) => request<EmbedInfo>(`/api/services/${id}/embed`),
  /* SSO 状态清单（GET /api/sso/status）服务端仍提供，但当前没有 UI 入口，故不在客户端封装。 */
  ssoPrepare: (serviceId: string) =>
    request<{
      ready: boolean;
      service: string;
      host: string;
      changed: boolean;
      issuer?: string;
      redirectUri?: string;
      loginUrl: string;
    }>(`/api/sso/${serviceId}/prepare`),
  databases: (q = '', category = '') =>
    request<{ total: number; matched: number; categories: string[]; items: DatabaseItem[] }>(
      `/api/databases?q=${encodeURIComponent(q)}${category ? `&category=${encodeURIComponent(category)}` : ''}`,
    ),
  databaseApis: () => request<DatabaseApiIndex>('/api/databases/apis'),
  /* 单库探测（GET /api/databases/{id}/probe）没有 UI 入口，服务端接口保留。 */
  databaseQuery: (id: string, query: string, limit = 5, params: Record<string, string> = {}) =>
    request<DatabaseQueryResult>(`/api/databases/${encodeURIComponent(id)}/query`, {
      method: 'POST',
      body: JSON.stringify({ query, limit, params }),
    }),
  favorites: () => request<{ favorites: string[] }>('/api/favorites'),
  addFavorite: (id: string) => request<{ favorites: string[] }>(`/api/favorites/${id}`, { method: 'POST' }),
  removeFavorite: (id: string) => request<{ favorites: string[] }>(`/api/favorites/${id}`, { method: 'DELETE' }),
  recent: () => request<{ recent: string[] }>('/api/recent'),
  fileSources: () => request<{ sources: FileSource[] }>('/api/files/sources'),
  files: (source: string, sort: FileSortKey = 'name', order: 'asc' | 'desc' = 'asc') =>
    request<{
      source: string;
      entries: FileEntry[];
      count: number;
      sort: string;
      order: string;
      usage: FileUsage;
      /** 仅 source=users：服务端认定的本人空间根目录。 */
      home?: string;
      sharedWith?: SharedEntry[];
      shares?: PersonalShare[];
      /** 可读目录（源相对路径，含 "" 源根），供移动目标选择器使用。 */
      dirs?: string[];
    }>(`/api/files?source=${encodeURIComponent(source)}&sort=${sort}&order=${order}`),
  fileShares: () =>
    request<{
      owner: string;
      shares: PersonalShare[];
      sharedWith: SharedEntry[];
      recipients: string[];
    }>('/api/files/shares'),
  fileShare: (path: string, recipients: string[], writable = false) =>
    request<{ ok: boolean; share: PersonalShare }>('/api/files/shares', {
      method: 'POST',
      body: JSON.stringify({ path, recipients, writable }),
    }),
  /* 单文件元信息（GET /api/files/{id}）没有 UI 入口（页面用 files / filePreview），服务端接口保留。 */
  filePreview: (id: string) => request<FilePreview>(`/api/files/${encodeURIComponent(id)}/preview`),
  fileUpload: (source: string, dir: string, file: File, overwrite = false) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ entry: FileEntry }>(
      `/api/files/upload?source=${encodeURIComponent(source)}&dir=${encodeURIComponent(dir)}&overwrite=${overwrite ? '1' : '0'}`,
      { method: 'POST', body: fd },
    );
  },
  fileMkdir: (source: string, path: string) =>
    request<{ entry: FileEntry }>('/api/files/mkdir', {
      method: 'POST',
      body: JSON.stringify({ source, path }),
    }),
  fileRename: (id: string, name: string) =>
    request<{ entry: FileEntry }>('/api/files/rename', {
      method: 'POST',
      body: JSON.stringify({ id, name }),
    }),
  /**
   * 把文件/文件夹移动到同一存储源内的另一个目录。
   * 服务端逐条鉴权：需要源条目的 modify 与目标目录的 create；
   * 返回里成功与失败分开，便于批量移动后逐条提示。
   */
  /** 把文件/目录复制到同一存储源的目标目录（服务端递归复制、不覆盖同名）。 */
  fileCopy: (id: string, target: string, name?: string) =>
    request<{ entry: FileEntry }>('/api/files/copy', {
      method: 'POST',
      body: JSON.stringify({ id, target, name: name ?? '' }),
    }),
  fileMove: (ids: string[], target: string) =>
    request<{ moved: FileEntry[]; failed: { id: string; error: string }[] }>('/api/files/move', {
      method: 'POST',
      body: JSON.stringify({ entries: ids.map((id) => ({ id })), target }),
    }),
  fileDelete: (id: string) =>
    request<{ ok: boolean; trash: FileTrashItem }>(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /**
   * 直接删除（不进回收站，不可恢复）。
   *
   * 与 fileDelete 的区别：普通删除进回收站保留 7 天可恢复；
   * 这里立刻从磁盘抹掉，用于"确定不要了"的场景（误传大文件、涉密材料、批量清理）。
   */
  fileDestroy: (id: string) =>
    request<{ ok: boolean; destroyed: { id: string; path: string; size: number } }>(
      `/api/files/${encodeURIComponent(id)}?permanent=1`,
      { method: 'DELETE' },
    ),
  fileTrash: () =>
    request<{
      items: FileTrashItem[];
      count: number;
      paths: number;
      totalBytes: number;
      retentionDays: number;
    }>('/api/files/trash'),
  fileRestore: (id: string) =>
    request<{ ok: boolean; entry: FileEntry }>('/api/files/trash/restore', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  filePurge: (id: string) =>
    request<{ ok: boolean; summary: FileTrashSummary }>(`/api/files/trash/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  fileEmptyTrash: () =>
    request<{ ok: boolean; summary: FileTrashSummary }>('/api/files/trash', { method: 'DELETE' }),
  fileAccessLog: (params: { action?: string; user?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.action) q.set('action', params.action);
    if (params.user) q.set('user', params.user);
    q.set('limit', String(params.limit ?? 50));
    return request<{ events: FileAccessEvent[]; count: number; retentionDays: number }>(
      `/api/files/access-log?${q.toString()}`,
    );
  },
  /* 原文下载（GET /api/files/{id}/download，二进制流，原先用于 FASTA 等）当前没有调用点，
     封装已删除；服务端接口保留。 */
  /** 读取文本文件正文（带 etag，供在线编辑做乐观并发）。 */
  fileContent: (id: string) =>
    request<FileContent>(`/api/files/${encodeURIComponent(id)}/content`),
  /** 保存文本文件正文；etag 与服务端不一致时抛 FileContentConflictError（409）。 */
  fileSaveContent: (id: string, text: string, etag: string) =>
    requestFileContentPut(`/api/files/${encodeURIComponent(id)}/content`, { text, etag }),

  // ---- 组会汇报（按自然周归集） ----
  //
  // 组会周列表 / 周内文件 / 上传（/api/meetings/weeks、/api/meetings/upload）
  // 当前没有 UI 入口（组会汇报页改用 services/labspaces 的 meetingApi），
  // 服务端接口保留，故此处不封装。

  // ---- 课题资料（个人资料目录） ----
  //
  // 管理员成员文件夹列表（/api/admin/research/folders）与本人目录（/api/research/mine）
  // 当前没有 UI 入口（课题资料页改用 services/labspaces 的 researchApi），
  // 服务端接口保留，故此处不封装。
  officeContent: (id: string) =>
    request<OfficeContent>(`/api/office/files/${encodeURIComponent(id)}/content`),
  officeSave: (id: string, payload: OfficeSavePayload) =>
    request<{ ok: boolean; size: number; entry?: FileEntry }>(
      `/api/office/files/${encodeURIComponent(id)}/content`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),
  officePdf: (id: string) => requestBlob(`/api/office/files/${encodeURIComponent(id)}/pdf`),


  // ---- 知识库 ----
  knowledgeList: (q = '', filter: { category?: string; tag?: string; folder?: string; space?: number } = {}) => {
    const params = new URLSearchParams({ q, category: filter.category ?? '', tag: filter.tag ?? '' });
    if (filter.folder) params.set('folder', filter.folder);
    if (filter.space !== undefined) params.set('space', String(filter.space));
    return request<{ items: KnowledgeDoc[]; total: number }>(`/api/knowledge?${params.toString()}`);
  },
  knowledgeCategories: (space?: number) =>
    request<KnowledgeFacets>(`/api/knowledge/categories${space !== undefined ? `?space=${space}` : ''}`),
  knowledgeSpaces: () => request<KnowledgeSpaces>('/api/knowledge/spaces'),
  knowledgeSpaceCreate: (body: {
    name: string;
    description?: string;
    visibility: string;
    roles: string[];
  }) => request<{ item: KnowledgeSpace }>('/api/knowledge/spaces', { method: 'POST', body: JSON.stringify(body) }),
  knowledgeSpaceUpdate: (
    id: number,
    body: { name?: string; description?: string; visibility?: string; roles?: string[] },
  ) =>
    request<{ item: KnowledgeSpace }>(`/api/knowledge/spaces/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  knowledgeSpaceDelete: (id: number) =>
    request<{ ok: boolean; movedToUnfiled: number }>(`/api/knowledge/spaces/${id}`, { method: 'DELETE' }),
  knowledgeGet: (id: number) => request<{ item: KnowledgeDoc }>(`/api/knowledge/${id}`),
  knowledgeCreate: (body: {
    title: string;
    body: string;
    tags: string[];
    category?: string;
    visibility: string;
    roles: string[];
    spaceId?: number;
  }) => request<{ item: KnowledgeDoc }>('/api/knowledge', { method: 'POST', body: JSON.stringify(body) }),
  knowledgeUpdate: (
    id: number,
    body: {
      title?: string;
      body?: string;
      tags?: string[];
      category?: string;
      visibility?: string;
      roles?: string[];
      spaceId?: number;
    },
  ) => request<{ item: KnowledgeDoc }>(`/api/knowledge/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  knowledgeDelete: (id: number) => request<{ ok: boolean }>(`/api/knowledge/${id}`, { method: 'DELETE' }),
  knowledgeAsk: (query: string, topK = 6, category = '', spaceId = 0) =>
    request<RagAnswer>('/api/knowledge/ask', {
      method: 'POST',
      body: JSON.stringify({ query, topK, category, spaceId }),
    }),
  knowledgeRagStatus: () => request<RagStatus>('/api/knowledge/rag/status'),
  knowledgeReindex: () => request<RagStatus>('/api/knowledge/reindex', { method: 'POST' }),
  knowledgeIngest: (form: FormData) =>
    request<{ results: IngestResult[]; summary: IngestSummary }>('/api/knowledge/ingest', {
      method: 'POST',
      body: form,
    }),
  knowledgeFromFiles: (body: {
    items: { id: string; source: string; path: string }[];
    category?: string;
    tags?: string[];
    visibility?: string;
    roles?: string[];
    spaceId?: number;
  }) =>
    request<{ results: IngestResult[]; summary: IngestSummary }>('/api/knowledge/from-files', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  touchRecent: (id: string) => request<{ ok: boolean }>(`/api/recent/${id}`, { method: 'POST' }),
  search: (q: string, categories = 'general', scope: 'web' | 'local' | 'all' = 'web', page = 1, pageSize = 30) =>
    request<SearchResponse>(
      `/api/search?q=${encodeURIComponent(q)}&categories=${encodeURIComponent(categories)}&scope=${scope}&page=${page}&pageSize=${pageSize}`,
    ),
  suggest: (q: string, limit = 10) =>
    request<{ suggestions: string[]; hot: string[] }>(`/api/search/suggest?q=${encodeURIComponent(q)}&limit=${limit}`),
  searchCategories: () =>
    request<{ categories: { value: string; label: string; hint: string }[]; default: string }>(
      '/api/search/categories',
    ),
  corpus: (q = '', limit = 30) =>
    request<{ query: string; count: number; items: CorpusItem[] }>(
      `/api/corpus?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  /** 每日论文列表：按人按天读取，topic 为空表示当天全部主题。 */
  /** 每日论文订阅：每人每主题一条，开启后由每日维护自动抓取。 */
  dailySubs: () =>
    request<{ subscriptions: DailySub[] }>('/api/daily-papers/subscriptions'),
  dailySubUpsert: (body: { topic: string; limit?: number; enabled?: boolean }) =>
    request<{ ok: boolean; subscription: DailySub }>('/api/daily-papers/subscriptions', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  dailySubDelete: (topic: string) =>
    request<{ ok: boolean; topic: string }>(
      `/api/daily-papers/subscriptions/${encodeURIComponent(topic)}`,
      { method: 'DELETE' },
    ),
  dailySubRun: () =>
    request<{ ok: boolean; total: number; done: number; failed: number }>(
      '/api/daily-papers/subscriptions/run',
      { method: 'POST' },
    ),
  dailyPapers: (day: string, topic = '', page = 1, pageSize = 20) =>
    request<DailyPapersResponse>(
      `/api/daily-papers?day=${encodeURIComponent(day)}&topic=${encodeURIComponent(topic)}` +
        `&page=${page}&page_size=${pageSize}`,
    ),
  /** 每日论文刷新：抓取某天某主题的新文献（topic 必填）。 */
  dailyPapersRefresh: (body: { day?: string; topic: string }) =>
    request<DailyPapersResponse>('/api/daily-papers/refresh', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  literature: (q: string, source = 'pubmed') =>
    request<Record<string, unknown>>(`/api/literature?q=${encodeURIComponent(q)}&source=${source}`),

  // ---- 实验室中心（ELN / 文献 / 库存发布）----
  //
  // 服务端仍保留、但当前没有任何 UI 入口因而未在客户端封装的实验室中心能力：
  //   · ELN 状态（/api/labops/status）、新建 ELN 模板、单条记录详情（/api/labops/eln/entries/{id}）
  //   · 库存台账（/api/labops/inventory/items*、low-count、label、transactions）
  //     —— 库存已并入多维表格，只在 Lab 页留了「发布到多维表格」一条
  //   · 生信流水线（/api/labops/pipelines/*）—— 流水线页已下线
  //   · 资源与预约（/api/labops/resources、/api/labops/bookings*）—— 预约已改走 Agent 模式
  //   · 领用申请（/api/labops/supplies*）
  // 需要恢复功能时按上述路由重新封装，不必去 git 历史里翻。
  labopsTemplates: () => request<{ items: LabopsTemplate[] }>('/api/labops/eln/templates'),
  labopsEntries: (q = '', template = '', limit = 50) =>
    request<{ items: LabopsEntry[] }>(
      `/api/labops/eln/entries?q=${encodeURIComponent(q)}&template=${encodeURIComponent(template)}&limit=${limit}`,
    ),
  labopsCreateEntry: (body: Partial<LabopsEntry>) =>
    request<LabopsEntry>('/api/labops/eln/entries', { method: 'POST', body: JSON.stringify(body) }),
  labopsUpdateEntry: (id: string, body: Partial<LabopsEntry>) =>
    request<LabopsEntry>(`/api/labops/eln/entries/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  labopsDeleteEntry: (id: string) =>
    request<{ ok: boolean }>(`/api/labops/eln/entries/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  labopsEntryToTask: (id: string) =>
    request<{ id: string }>(`/api/labops/eln/entries/${encodeURIComponent(id)}/to-task`, { method: 'POST' }),
  labopsEntryToKnowledge: (id: string) =>
    request<{ docId: number }>(`/api/labops/eln/entries/${encodeURIComponent(id)}/to-knowledge`, { method: 'POST' }),

  /** 把本地库存发布到多维表格工作区（幂等；后端只读本地库存表）。 */
  labopsPublishInventory: () =>
    request<LabopsPublishResult>('/api/labops/inventory/publish', { method: 'POST' }),

  labopsLiterature: (q = '', status = '', libraryId = '', folderId?: string) => {
    const query = new URLSearchParams();
    query.set('q', q);
    query.set('status', status);
    query.set('library_id', libraryId);
    // folderId 传 '' 表示只看未分类；不传表示整个库都看
    if (folderId !== undefined) query.set('folder_id', folderId);
    return request<{ items: LabopsLiterature[] }>(`/api/labops/literature?${query.toString()}`);
  },
  labopsLiteratureSearch: (q: string) =>
    request<{ items: LabopsLiterature[]; semantic: boolean; mode: string }>(
      `/api/labops/literature/search?q=${encodeURIComponent(q)}`,
    ),
  labopsImportLiterature: (body: { doi?: string; title?: string; tags?: string[]; library_id?: string; folder_id?: string }) =>
    request<{ id: string; duplicate: boolean }>('/api/labops/literature/import', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  labopsUpdateLiterature: (id: string, body: Partial<LabopsLiterature>) =>
    request<LabopsLiterature>(`/api/labops/literature/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  labopsDeleteLiterature: (id: string) =>
    request<{ ok: boolean }>(`/api/labops/literature/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  labopsCitation: (id: string, style = 'gbt7714') =>
    fetch(`/api/labops/literature/${encodeURIComponent(id)}/citation?style=${style}`, { credentials: 'include' }).then(
      (r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))),
    ),
  labopsLiteratureExportUrl: (ids: string[] = [], style = 'bibtex') =>
    `/api/labops/literature/export?style=${style}&ids=${encodeURIComponent(ids.join(','))}`,

  labopsLibraries: () => request<{ items: LabopsLibrary[]; defaultId: string }>('/api/labops/libraries'),
  labopsCreateLibrary: (body: { name: string; description?: string; color?: string }) =>
    request<{ id: string }>('/api/labops/libraries', { method: 'POST', body: JSON.stringify(body) }),
  labopsUpdateLibrary: (id: string, body: { name?: string; description?: string; color?: string }) =>
    request<LabopsLibrary>(`/api/labops/libraries/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  labopsDeleteLibrary: (id: string, moveTo?: string) =>
    request<{ ok: boolean; moved: number }>(
      `/api/labops/libraries/${encodeURIComponent(id)}${moveTo ? `?move_to=${encodeURIComponent(moveTo)}` : ''}`,
      { method: 'DELETE' },
    ),
  labopsLibraryFolders: (libraryId: string) =>
    request<{ items: LabopsLibraryFolder[] }>(`/api/labops/libraries/${encodeURIComponent(libraryId)}/folders`),
  labopsCreateLibraryFolder: (libraryId: string, body: { name: string; parent_id?: string }) =>
    request<{ id: string }>(`/api/labops/libraries/${encodeURIComponent(libraryId)}/folders`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  labopsUpdateLibraryFolder: (folderId: string, body: { name?: string; parent_id?: string }) =>
    request<LabopsLibraryFolder>(`/api/labops/folders/${encodeURIComponent(folderId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  labopsDeleteLibraryFolder: (folderId: string, moveTo?: string) =>
    request<{ ok: boolean; moved: number }>(
      `/api/labops/folders/${encodeURIComponent(folderId)}${moveTo ? `?move_to=${encodeURIComponent(moveTo)}` : ''}`,
      { method: 'DELETE' },
    ),
  labopsMoveLiterature: (ids: string[], libraryId: string, folderId: string) =>
    request<{ ok: boolean; moved: number }>('/api/labops/literature/move', {
      method: 'POST',
      body: JSON.stringify({ ids, libraryId, folderId }),
    }),

  /* 资源、预约、领用申请（/api/labops/resources、/bookings、/supplies）目前没有 UI 入口，
     服务端仍保留；见本节开头的清单。 */
  drawings: () => request<{ drawings: { id: string; name: string; size: number; updated_at: string }[] }>('/api/drawings'),
  drawing: (id: string) =>
    request<{ id: string; name: string; content: string; size: number; updated_at: string }>(
      `/api/drawings/${encodeURIComponent(id)}`,
    ),
  saveDrawing: (name: string, content: string) =>
    request<{ id: string; name: string }>('/api/drawings', { method: 'POST', body: JSON.stringify({ name, content }) }),
  updateDrawing: (id: string, name: string, content: string) =>
    request<{ ok: boolean }>(`/api/drawings/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ name, content }),
    }),
  // 重命名与删除以前在「我的图形」页里手写 fetch + 手搞 CSRF，
  // 与 request() 的 401 / 错误文案处理不一致；统一走这里。
  renameDrawing: (id: string, name: string) =>
    request<{ ok: boolean }>(`/api/drawings/${encodeURIComponent(id)}/rename`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  deleteDrawing: (id: string) =>
    request<{ ok: boolean }>(`/api/drawings/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  exportDrawing: (id: string, content: string, name: string) =>
    request<{ path: string }>(`/api/drawings/${id}/export`, { method: 'POST', body: JSON.stringify({ content, name }) }),
  announcements: () => request<{ announcements: Announcement[] }>('/api/announcements'),
  /** 轻量人员目录：把用户名/账号 id 显示成姓名。 */
  people: () => request<{ people: PeopleEntry[] }>('/api/people'),
  /** 自助改密：必须校验旧口令；新口令 ≥10 位且不能与初始口令相同。 */
  changeMyPassword: (oldPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/me/password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword }),
    }),
  adminInfo: () => request<AdminInfo>('/api/admin/info'),
  adminHealth: () => request<{ services: any[] }>('/api/admin/health'),
  adminBackups: () => request<BackupStatus>('/api/admin/backups'),
  /** 异地归档（Git LFS）状态：本地仓库之外的第二条腿。 */
  adminBackupGit: () => request<BackupGitStatus>('/api/admin/backups/git'),
  /** 后台任务列表（定时器 / 一次性任务 / 常驻服务的状态与下次运行时间）。 */
  adminTasks: () => request<AdminTaskList>('/api/admin/tasks'),
  /** 某个后台任务最近的日志行。 */
  adminTaskLogs: (unit: string, lines = 60) =>
    request<{ ok: boolean; unit: string; lines: string[] }>(
      `/api/admin/tasks/${encodeURIComponent(unit)}/logs?lines=${lines}`,
    ),
  /** 立即执行一个（可触发的）后台任务；不等待跑完。 */
  adminTaskRun: (unit: string) =>
    request<{ ok: boolean; unit: string }>(
      `/api/admin/tasks/${encodeURIComponent(unit)}/run`,
      { method: 'POST' },
    ),
  /** 清除失败状态（systemctl reset-failed）。 */
  adminTaskReset: (unit: string) =>
    request<{ ok: boolean; unit: string }>(
      `/api/admin/tasks/${encodeURIComponent(unit)}/reset`,
      { method: 'POST' },
    ),
  /** 删除一个备份快照（不可撤销；服务端只接受 8–64 位十六进制 ID）。 */
  adminBackupDelete: (snapshot: string) =>
    request<{ ok: boolean; snapshot: string }>(
      `/api/admin/backups/${encodeURIComponent(snapshot)}`,
      { method: 'DELETE' },
    ),
  wecomConfig: () => request<WeComConfig>('/api/admin/wecom'),
  updateWecom: (body: {
    enabled: boolean;
    webhookUrl: string;
    announcements: boolean;
    dailyDigest: boolean;
    digestTime: string;
  }) => request<WeComConfig>('/api/admin/wecom', { method: 'PUT', body: JSON.stringify(body) }),
  testWecom: () => request<{ ok: boolean; detail: string }>('/api/admin/wecom/test', { method: 'POST' }),
  accounts: (q = '') =>
    request<AccountsResponse>(`/api/admin/accounts${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  createAccount: (body: {
    name: string;
    displayName?: string;
    email?: string;
    groups: string[];
    password: string;
  }) => request<{ ok: boolean; account: AccountItem; initialPassword?: string }>('/api/admin/accounts', { method: 'POST', body: JSON.stringify(body) }),
  updateAccount: (
    name: string,
    body: { newName?: string; displayName?: string; email?: string; groups?: string[]; isForbidden?: boolean },
  ) =>
    request<{ ok: boolean; account: AccountItem }>(`/api/admin/accounts/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  resetAccountPassword: (name: string, password: string) =>
    request<{ ok: boolean }>(`/api/admin/accounts/${encodeURIComponent(name)}/password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  provisionAccount: (name: string) =>
    request<{ ok: boolean }>(`/api/admin/accounts/${encodeURIComponent(name)}/provision`, {
      method: 'POST',
    }),
  deleteAccount: (name: string, confirm: string) =>
    request<{
      ok: boolean;
      name: string;
      purged: Record<string, number>;
      files: { removedPaths?: number; removedBytes?: number; aclEntries?: string[] };
    }>(`/api/admin/accounts/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm }),
    }),
  setAccountFileGrants: (name: string, grants: FileGrant[]) =>
    request<{ ok: boolean; grants: FileGrant[] }>(
      `/api/admin/accounts/${encodeURIComponent(name)}/file-access`,
      { method: 'PUT', body: JSON.stringify({ grants }) },
    ),
  // ---- 权限管理：用户组（预配置）+ 用户单独权限 ----
  groupPermissions: () => request<GroupPermissionsResponse>('/api/admin/accounts/groups'),
  createGroup: (body: { name: string; displayName?: string; enabled?: boolean; grants?: FileGrant[] }) =>
    request<{ ok: boolean; name: string; displayName: string; enabled: boolean; grants: FileGrant[] }>(
      '/api/admin/accounts/groups',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  updateGroup: (
    group: string,
    body: { newName?: string; displayName?: string; enabled?: boolean },
  ) =>
    request<{ ok: boolean; name: string }>(
      `/api/admin/accounts/groups/${encodeURIComponent(group)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),
  setGroupGrants: (group: string, grants: FileGrant[]) =>
    request<{ ok: boolean; name: string; grants: FileGrant[] }>(
      `/api/admin/accounts/groups/${encodeURIComponent(group)}`,
      { method: 'PUT', body: JSON.stringify({ grants }) },
    ),
  removeFileGroup: (group: string, force = false) =>
    request<{ ok: boolean; name: string; removedMembers?: number }>(
      `/api/admin/accounts/groups/${encodeURIComponent(group)}${force ? '?force=true' : ''}`,
      { method: 'DELETE' },
    ),
  accessPreview: (name: string) =>
    request<AccessPreviewResponse>(
      `/api/admin/accounts/${encodeURIComponent(name)}/access-preview`,
      { method: 'POST' },
    ),
  logout: () => request<{ ok: boolean; logoutUrl: string }>('/api/auth/logout', { method: 'POST' }),

  // ---- 个人工作台 ----
  workbenchSummary: () => request<WorkbenchSummary>('/api/workbench/summary'),
  workbenchItems: (
    params: { kind?: string; status?: string; project_id?: string; q?: string; limit?: number } = {},
  ) =>
    request<{ items: WorkbenchItem[]; total: number }>(
      `/api/workbench/items?${new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]),
      ).toString()}`,
    ),
  workbenchCreateItem: (body: Partial<WorkbenchItem>) =>
    request<{ item: WorkbenchItem }>('/api/workbench/items', { method: 'POST', body: JSON.stringify(body) }),
  workbenchUpdateItem: (id: string, body: Partial<WorkbenchItem>) =>
    request<{ item: WorkbenchItem }>(`/api/workbench/items/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  workbenchDeleteItem: (id: string) =>
    request<{ ok: boolean }>(`/api/workbench/items/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workbenchCapture: (text: string) =>
    request<WorkbenchCapture>('/api/workbench/capture', { method: 'POST', body: JSON.stringify({ text }) }),
  workbenchProjects: () => request<{ projects: WorkbenchProject[] }>('/api/workbench/projects'),
  workbenchCreateProject: (body: Partial<WorkbenchProject>) =>
    request<{ project: WorkbenchProject }>('/api/workbench/projects', { method: 'POST', body: JSON.stringify(body) }),
  workbenchPlans: () => request<{ plans: WorkbenchPlan[] }>('/api/workbench/plans'),
  workbenchCreatePlan: (body: Partial<WorkbenchPlan>) =>
    request<{ plan: WorkbenchPlan }>('/api/workbench/plans', { method: 'POST', body: JSON.stringify(body) }),
  /** 更新计划（PATCH /api/workbench/plans/{id}，后端已实现） */
  workbenchUpdatePlan: (id: string, body: Partial<WorkbenchPlan>) =>
    request<{ plan: WorkbenchPlan }>(`/api/workbench/plans/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  /** 删除计划（DELETE /api/workbench/plans/{id}，后端已实现） */
  workbenchDeletePlan: (id: string) =>
    request<{ ok: boolean }>(`/api/workbench/plans/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workbenchBriefs: () => request<{ briefs: WorkbenchBrief[] }>('/api/workbench/briefs'),

  // ---- 导师绑定 ----
  //
  // 指派人名单（/api/workbench/assignment-people）与指派增删改、提交、审阅、附件
  // （/api/workbench/assignments*）当前没有 UI 入口，服务端路由保留，此处不封装。
  workbenchMentorBindings: () => request<MentorBindings>('/api/workbench/mentor-bindings'),
  workbenchBindMentor: (userId: string, mentorId: string) =>
    request<{ ok: boolean }>(`/api/workbench/mentor-bindings/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      body: JSON.stringify({ mentor_id: mentorId }),
    }),
  workbenchUnbindMentor: (userId: string) =>
    request<{ ok: boolean }>(`/api/workbench/mentor-bindings/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    }),

  // ---- LaTeX 写作与投稿 ----
  latexTemplates: () =>
    request<{ templates: LatexTemplate[]; statuses: { value: LatexStatus; label: string }[] }>(
      '/api/latex/templates',
    ),
  latexDocuments: (q = '', status = '') =>
    request<{ documents: LatexDocument[]; counts: Partial<Record<LatexStatus, number>>; total: number }>(
      `/api/latex/documents?q=${encodeURIComponent(q)}${status ? `&status=${encodeURIComponent(status)}` : ''}`,
    ),
  latexDocument: (id: string) =>
    request<{ document: LatexDocument }>(`/api/latex/documents/${encodeURIComponent(id)}`),
  /** 把 .docx 转成 LaTeX 并建成新文稿；warnings 是转换器的如实提示（图片/公式等）。 */
  latexImportDocx: (file: File, template = 'article') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('template', template);
    return request<{
      document: LatexDocument;
      warnings: string[];
      stats: Record<string, number>;
    }>('/api/latex/import-docx', { method: 'POST', body: fd });
  },
  latexCreate: (body: {
    title: string;
    template: string;
    venue?: string;
    authors?: string;
    project_id?: string | null;
    due_date?: string | null;
  }) =>
    request<{ document: LatexDocument }>('/api/latex/documents', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  latexUpdate: (id: string, body: Partial<{
    title: string;
    venue: string;
    authors: string;
    status: LatexStatus;
    abstract: string;
    keywords: string[];
    content: string;
    project_id: string | null;
    knowledge_doc_id: number | null;
    due_date: string | null;
  }>) =>
    request<{ document: LatexDocument }>(`/api/latex/documents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  latexDelete: (id: string) =>
    request<{ ok: boolean }>(`/api/latex/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  latexCompile: (id: string) =>
    request<{ ok: boolean; log: string; ms: number; pdfBytes?: number }>(
      `/api/latex/documents/${encodeURIComponent(id)}/compile`,
      { method: 'POST' },
    ),
  /* 投稿事件时间线（GET/POST /api/latex/documents/{id}/events）没有 UI 入口，
     服务端仍写入 latex_events 表，只是页面暂不展示。 */
  latexPdfUrl: (id: string, download = false) =>
    `/api/latex/documents/${encodeURIComponent(id)}/pdf${download ? '?download=1' : ''}`,
  /** 单个模板（含源码）：新建文稿时「预览源码」用。 */
  latexTemplate: (id: string) =>
    request<{ template: LatexTemplate & { content: string } }>(
      `/api/latex/templates/${encodeURIComponent(id)}`,
    ),
  latexReviews: (id: string) =>
    request<{ reviews: LatexReview[] }>(`/api/latex/documents/${encodeURIComponent(id)}/reviews`),
  latexCreateReview: (id: string, body: { lineFrom: number; lineTo: number; quote: string; comment: string }) =>
    request<{ review: LatexReview }>(`/api/latex/documents/${encodeURIComponent(id)}/reviews`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  latexUpdateReview: (id: string, reviewId: string, status: LatexReviewStatus) =>
    request<{ review: LatexReview }>(
      `/api/latex/documents/${encodeURIComponent(id)}/reviews/${encodeURIComponent(reviewId)}`,
      { method: 'PATCH', body: JSON.stringify({ status }) },
    ),
  latexDeleteReview: (id: string, reviewId: string) =>
    request<{ ok: boolean }>(
      `/api/latex/documents/${encodeURIComponent(id)}/reviews/${encodeURIComponent(reviewId)}`,
      { method: 'DELETE' },
    ),
  latexReviewReplies: (id: string, reviewId: string) =>
    request<{ replies: LatexReviewReply[] }>(
      `/api/latex/documents/${encodeURIComponent(id)}/reviews/${encodeURIComponent(reviewId)}/replies`,
    ),
  latexAddReviewReply: (id: string, reviewId: string, content: string) =>
    request<{ reply: LatexReviewReply }>(
      `/api/latex/documents/${encodeURIComponent(id)}/reviews/${encodeURIComponent(reviewId)}/replies`,
      { method: 'POST', body: JSON.stringify({ content }) },
    ),
  latexVersions: (id: string) =>
    request<{ versions: LatexVersion[] }>(`/api/latex/documents/${encodeURIComponent(id)}/versions`),
  latexVersion: (id: string, versionId: number) =>
    request<{ version: LatexVersion & { content: string } }>(
      `/api/latex/documents/${encodeURIComponent(id)}/versions/${versionId}`,
    ),
  /** 编译素材列表（不含二进制内容） */
  latexAssets: (id: string) =>
    request<{ assets: LatexAsset[] }>(`/api/latex/documents/${encodeURIComponent(id)}/assets`),
  /** 上传编译素材：.cls / .sty / .bib / .bst / 图片等 */
  latexUploadAsset: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ asset: LatexAsset }>(
      `/api/latex/documents/${encodeURIComponent(id)}/assets`,
      { method: 'POST', body: fd },
    );
  },
  latexDeleteAsset: (id: string, assetId: string) =>
    request<{ ok: boolean }>(
      `/api/latex/documents/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}`,
      { method: 'DELETE' },
    ),

  // ---- Agent 助手 ----
  agentStatus: () => request<AgentStatus>('/api/agent/status'),
  agentModels: () => request<{ models: AgentModel[] }>('/api/agent/models'),
  agentQuota: () => request<AgentQuota>('/api/agent/quota'),
  agentSessions: () => request<{ sessions: AgentSession[] }>('/api/agent/sessions'),
  agentCreateSession: (title = '', model = '') =>
    request<{ session: AgentSession }>(`/api/agent/sessions?title=${encodeURIComponent(title)}${model ? `&model=${encodeURIComponent(model)}` : ''}`, {
      method: 'POST',
    }),
  agentSession: (id: string) => request<{ session: AgentSession; messages: AgentMessage[] }>(`/api/agent/sessions/${encodeURIComponent(id)}`),
  agentDeleteSession: (id: string) => request<{ ok: boolean }>(`/api/agent/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  agentMessages: (id: string) => request<{ messages: AgentMessage[] }>(`/api/agent/sessions/${encodeURIComponent(id)}/messages`),
  agentSend: (id: string, content: string, regenerate = false) =>
    request<{ accepted: boolean; regenerate?: boolean; message: AgentMessage | null }>(
      `/api/agent/sessions/${encodeURIComponent(id)}/messages?content=${encodeURIComponent(content)}${regenerate ? '&regenerate=true' : ''}`,
      { method: 'POST' },
    ),
  agentAbort: (id: string) => request<{ ok: boolean }>(`/api/agent/sessions/${encodeURIComponent(id)}/abort`, { method: 'POST' }),
  /** 回传 HITL 结果（工具确认 / AskUser 答案）。 */
  agentHitl: (id: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/agent/sessions/${encodeURIComponent(id)}/hitl`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  agentStreamUrl: (id: string) => `/api/agent/sessions/${encodeURIComponent(id)}/stream`,
  agentAdminConfig: () => request<AgentAdminConfig>('/api/agent/admin/config'),
  agentUpdateAdminConfig: (body: Partial<AgentAdminConfig>) =>
    request<AgentAdminConfig>('/api/agent/admin/config', { method: 'PUT', body: JSON.stringify(body) }),
  agentAdminUsage: () => request<AgentUsageSummary>('/api/agent/admin/usage'),
  agentAdminSkills: () =>
    request<{ roots: string[]; skills: AgentSkillOption[] }>('/api/agent/admin/skills'),
  agentMemories: (q = '', kind = '', limit = 50) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (q) params.set('q', q);
    if (kind) params.set('kind', kind);
    return request<{ memories: AgentMemory[]; total: number }>(`/api/agent/memories?${params.toString()}`);
  },
  agentMemoryCreate: (body: { kind?: string; title?: string; content: string; sourceSession?: string }) =>
    request<{ memory: AgentMemory; deduped?: boolean }>('/api/agent/memories', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /* 修改记忆（PUT /api/agent/memories/{id}）服务端仍提供，但页面只用到新增/删除，故不封装。 */
  agentMemoryDelete: (id: string) =>
    request<{ ok: boolean }>(`/api/agent/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ---- 机器翻译（Hy-MT2） ----
  translateStatus: async () => {
    const raw = await request<
      Omit<TranslateStatus, 'languages'> & {
        languages: Record<string, string> | { value: string; label: string }[];
      }
    >('/api/mt/status');
    const languages = Array.isArray(raw.languages)
      ? raw.languages
      : Object.entries(raw.languages ?? {}).map(([value, label]) => ({ value, label: String(label) }));
    return { ...raw, languages } as TranslateStatus;
  },
  translateText: async (text: string, targetLang: string, style = '', terminology = '') => {
    const raw = await request<{
      translation: string;
      targetLang: string;
      model: string;
      provider?: string;
      fallback?: boolean;
      elapsed_seconds?: number;
    }>('/api/mt/translate', {
      method: 'POST',
      body: JSON.stringify({ source: text, targetLang, style, terminology }),
    });
    const result: TranslateResult = {
      translated: raw.translation,
      target_lang: raw.targetLang,
      model: raw.model,
      provider: raw.provider,
      fallback_used: raw.fallback,
      elapsed_ms: Math.round((raw.elapsed_seconds ?? 0) * 1000),
    };
    return result;
  },

  // ---- 文档解析（OXR-1.0 / Docling） ----

  // ---- 天气（Open-Meteo） ----
  weather: (city = '', days = 7) =>
    request<WeatherReport>(`/api/weather?city=${encodeURIComponent(city)}&days=${days}`),

  /* 配色搭配：Go 核心 /v1/colors（nginx /api/next/ 前缀剥离） */
  colorMeta: () => request<ColorMeta>('/api/next/v1/colors/meta'),
  colorPalettes: (p: {
    q?: string;
    source?: string;
    count?: string;
    min_count?: number;
    sort?: string;
    page?: number;
    page_size?: number;
  } = {}) => {
    const sp = new URLSearchParams();
    Object.entries(p).forEach(([k, v]) => {
      if (v !== undefined && v !== '' && v !== 0) sp.set(k, String(v));
    });
    return request<ColorPaletteList>(`/api/next/v1/colors/palettes?${sp.toString()}`);
  },
  colorMatch: (colors: string[], limit = 8) =>
    request<{ seeds: string[]; items: ColorMatchItem[] }>(
      `/api/next/v1/colors/match?colors=${encodeURIComponent(colors.join(','))}&limit=${limit}`,
    ),
  /* 配色详情（/colors/palettes/{id}）与颜色解析（POST /colors/parse）没有 UI 入口，
     Go 核心仍提供，故不在客户端封装。 */
};


/* ---------------------------------------------------------------- Baserow 数据表 */

export interface BaserowDatabaseRef {
  id: number;
  name: string;
}
export interface BaserowWorkspace {
  id: number;
  name: string;
  databases: BaserowDatabaseRef[];
}
export interface BaserowTableRef {
  id: number;
  name: string;
}
export interface BaserowSelectOption {
  id: number;
  value: string;
  color: string;
}
export interface BaserowField {
  id: number;
  name: string;
  type: string;
  primary: boolean;
  read_only: boolean;
  description?: string;
  link_row_table_id?: number | null;
  people?: boolean;
  select_options: BaserowSelectOption[];
}
export interface BaserowPerson {
  id: string;
  row_id: number;
  name: string;
  displayName: string;
  email: string;
  groups: string[];
}
export interface BaserowRow {
  id: number;
  [key: string]: unknown;
}
export interface BaserowRows {
  count: number;
  next: string | null;
  previous: string | null;
  results: BaserowRow[];
}
export interface BaserowOverview {
  admin: boolean;
  workspaces: BaserowWorkspace[];
}
export interface BaserowMember {
  id: number;
  user_id: number;
  name: string;
  email: string;
  permissions: string;
}
/**
 * Baserow 用户文件（附件）。
 *
 * `name` 是 user-files 的校验名（哈希串），写回文件字段时必须原样带上；
 * `visible_name` 才是用户可读的原始文件名。
 */
export interface BaserowFile {
  url: string;
  name: string;
  visible_name?: string;
  size?: number;
  mime?: string;
}

/** 视图（Baserow 的 view）：表格/画廊/看板/日历/表单都是视图的一种类型。 */
export interface BaserowViewFilter {
  id: number;
  field: number;
  type: string;
  value: string;
  group: number | null;
}
export interface BaserowViewSort {
  id: number;
  field: number;
  order: 'ASC' | 'DESC';
  type: string;
}
export interface BaserowViewFilterGroup {
  id: number;
  filter_type: 'AND' | 'OR';
  parent_group: number | null;
}
export interface BaserowView {
  id: number;
  name: string;
  type: string;
  order: number;
  filter_type: 'AND' | 'OR';
  filters_disabled: boolean;
  filters: BaserowViewFilter[];
  sortings: BaserowViewSort[];
  filter_groups: BaserowViewFilterGroup[];
}
/** 行评论（Baserow 的 row_comments；未开启该能力的部署会返回 402）。 */
export interface BaserowRowComment {
  id: number;
  message: string;
  first_name: string;
  created_on: string;
  updated_on: string;
  edited: boolean;
}
/** 回收站条目。 */
export interface BaserowTrashItem {
  id: number;
  trash_item_id: number;
  trash_item_type: string;
  parent_trash_item_id: number | null;
  trashed_at: string;
  name: string;
  names: string[];
  parent_name: string;
  user_who_trashed: string;
}
/** 关联行（link_row）候选。 */
export interface BaserowLinkRow {
  id: number;
  label: string;
}
/** 视图的字段选项（Baserow 的 grid/gallery/... view field options）。 */
export interface BaserowViewFieldOption {
  width?: number;
  hidden?: boolean;
  order?: number;
  [key: string]: unknown;
}

/** 种子管理模板的字段描述。 */
export interface BaserowSeedTemplateField {
  id: number;
  name: string;
  type: string;
  /** 后端标注的必填字段；缺失时前端按字段语义推断。 */
  required?: boolean;
  /** 主字段（Baserow 每表必有一个，渲染时置顶）。 */
  primary?: boolean;
  /** 单选/多选的选项；由模板接口一并给出，省掉一次往返。 */
  select_options?: { id?: number; value: string; color?: string }[];
}

/** 种子管理模板：工作区 / 数据库 / 表 + 字段。 */
export interface BaserowSeedTemplate {
  workspaceId: number;
  databaseId: number;
  tableId: number;
  fields: BaserowSeedTemplateField[];
}

function baserowRowQuery(p: {
  page: number;
  size: number;
  search?: string;
  order_by?: string;
  view_id?: number | null;
}): string {
  const sp = new URLSearchParams({ page: String(p.page), size: String(p.size) });
  if (p.search) sp.set('search', p.search);
  if (p.order_by) sp.set('order_by', p.order_by);
  if (p.view_id) sp.set('view_id', String(p.view_id));
  return sp.toString();
}

/** 种子标签 OCR 结果：只用于预填表单，不自动入库。 */
export type SeedOcrResult = {
  ok: boolean;
  reason?: string;
  fields: Record<string, string>;
  lines: string[];
  text?: string;
  matched?: number;
};

export const baserowApi = {
  overview: () => request<BaserowOverview>('/api/baserow/overview'),
  /** 读取种子管理模板（幂等，模板不存在时返回 404）。 */
  seedTemplate: () => request<BaserowSeedTemplate>('/api/baserow/templates/seed'),
  /**
   * 种子台账的行（全实验室共享的只读视图）。
   *
   * 不能直接用 `/tables/{id}/rows`：那条路径以**调用者自己的**数据表令牌
   * 访问，而台账在管理员账号的工作区里，非管理员一律 404。
   */
  /**
   * 新增一条种子记录（登录即可）。
   *
   * 台账只有一份、建在管理员工作区，所以由后端用管理员令牌写；
   * 前端**不传表 id**（服务端自己解析），避免变成"随便写任何表"的入口。
   */
  seedCreateRow: (values: Record<string, unknown>) =>
    request<Record<string, unknown>>('/api/baserow/seed/rows', {
      method: 'POST',
      body: JSON.stringify(values),
    }),
  /** 修改一条种子记录（登录即可；删除与结构变更仍只有管理员）。 */
  seedUpdateRow: (rowId: number, values: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/api/baserow/seed/rows/${rowId}`, {
      method: 'PATCH',
      body: JSON.stringify(values),
    }),
  seedRows: (p: { page?: number; size?: number; search?: string; order_by?: string }) => {
    const sp = new URLSearchParams();
    if (p.page) sp.set('page', String(p.page));
    if (p.size) sp.set('size', String(p.size));
    if (p.search) sp.set('search', p.search);
    if (p.order_by) sp.set('order_by', p.order_by);
    const q = sp.toString();
    return request<{ count: number; next: string | null; previous: string | null; results: BaserowRow[] }>(
      `/api/baserow/seed/rows${q ? `?${q}` : ''}`,
    );
  },
  /** 创建/修复种子管理模板（幂等），返回可用的表与字段。 */
  ensureSeedTemplate: () =>
    request<BaserowSeedTemplate>('/api/baserow/templates/seed', { method: 'POST' }),
  /** 导入 .xlsx 到指定表（服务端用 openpyxl 解析，表头自动匹配已有字段）。 */
  importExcel: async (tableId: number, file: File): Promise<{ created: number; fields_added: string[]; skipped: number }> => {
    const csrf = readCookie('labspace_csrf');
    const form = new FormData();
    form.append('file', file, file.name || 'import.xlsx');
    const res = await fetch(`/api/baserow/tables/${tableId}/import/excel`, {
      method: 'POST',
      credentials: 'include',
      body: form,
      headers: csrf ? { 'X-CSRF-Token': csrf } : {},
    });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const body = await res.json();
        detail = body?.detail ?? body?.error ?? detail;
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }
    return (await res.json()) as { created: number; fields_added: string[]; skipped: number };
  },
  /** 导出整表为 .xlsx（管理员）。 */
  exportExcel: async (tableId: number): Promise<Blob> => {
    const res = await fetch(`/api/baserow/tables/${tableId}/export/excel`, { credentials: 'include' });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const body = await res.json();
        detail = body?.detail ?? body?.error ?? detail;
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }
    return await res.blob();
  },
  /** 识别种子标签照片，返回预填字段（multipart 直传，不走 JSON 代理）。 */
  seedOcr: async (file: File): Promise<SeedOcrResult> => {
    const csrf = readCookie('labspace_csrf');
    const form = new FormData();
    form.append('image', file, file.name || 'label.jpg');
    const res = await fetch('/api/baserow/seed/ocr', {
      method: 'POST',
      credentials: 'include',
      body: form,
      headers: csrf ? { 'X-CSRF-Token': csrf } : {},
    });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const body = await res.json();
        detail = body?.detail ?? body?.error ?? detail;
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }
    return (await res.json()) as SeedOcrResult;
  },
  tables: (databaseId: number) =>
    request<{ tables: BaserowTableRef[] }>(`/api/baserow/databases/${databaseId}/tables`),
  fields: (tableId: number) =>
    request<{ fields: BaserowField[] }>(`/api/baserow/tables/${tableId}/fields`),
  people: (tableId: number) =>
    request<{ table_id: number; people: BaserowPerson[] }>(`/api/baserow/tables/${tableId}/people`),
  rows: (tableId: number, p: { page: number; size: number; search?: string; order_by?: string; view_id?: number | null }) =>
    request<BaserowRows>(`/api/baserow/tables/${tableId}/rows?${baserowRowQuery(p)}`),
  /** 视图列表（含各自的筛选与排序）。 */
  views: (tableId: number) => request<{ views: BaserowView[] }>(`/api/baserow/tables/${tableId}/views`),
  createView: (tableId: number, name: string, type: string) =>
    request<BaserowView>(`/api/baserow/tables/${tableId}/views`, {
      method: 'POST',
      body: JSON.stringify({ name, type }),
    }),
  updateView: (
    tableId: number,
    viewId: number,
    patch: { name?: string; filter_type?: string; filters_disabled?: boolean },
  ) =>
    request<BaserowView>(`/api/baserow/tables/${tableId}/views/${viewId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteView: (tableId: number, viewId: number) =>
    request<{ ok: boolean }>(`/api/baserow/tables/${tableId}/views/${viewId}`, { method: 'DELETE' }),
  createViewFilter: (tableId: number, viewId: number, body: { field: number; type: string; value: string }) =>
    request<unknown>(`/api/baserow/tables/${tableId}/views/${viewId}/filters`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateViewFilter: (tableId: number, viewId: number, filterId: number, body: { value?: string; type?: string }) =>
    request<unknown>(`/api/baserow/tables/${tableId}/views/${viewId}/filters/${filterId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteViewFilter: (tableId: number, viewId: number, filterId: number) =>
    request<{ ok: boolean }>(`/api/baserow/tables/${tableId}/views/${viewId}/filters/${filterId}`, { method: 'DELETE' }),
  createViewSort: (tableId: number, viewId: number, body: { field: number; order: 'ASC' | 'DESC' }) =>
    request<unknown>(`/api/baserow/tables/${tableId}/views/${viewId}/sortings`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateViewSort: (tableId: number, viewId: number, sortId: number, body: { order: 'ASC' | 'DESC' }) =>
    request<unknown>(`/api/baserow/tables/${tableId}/views/${viewId}/sortings/${sortId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteViewSort: (tableId: number, viewId: number, sortId: number) =>
    request<{ ok: boolean }>(`/api/baserow/tables/${tableId}/views/${viewId}/sortings/${sortId}`, { method: 'DELETE' }),
  /* 视图筛选分组的增删（POST/DELETE .../views/{id}/filter-groups）没有 UI 入口，
     服务端仍支持（Baserow 自身能力），前端只读视图详情里的 filter_groups。 */
  /** 批量删除记录。 */
  batchDeleteRows: (tableId: number, ids: number[]) =>
    request<{ deleted: number }>(`/api/baserow/tables/${tableId}/rows/batch-delete`, {
      method: 'POST',
      body: JSON.stringify({ items: ids }),
    }),
  /** 批量更新记录（items 里每项带 id 与要写的字段）。 */
  batchUpdateRows: (tableId: number, items: Record<string, unknown>[]) =>
    request<{ updated: number }>(`/api/baserow/tables/${tableId}/rows/batch`, {
      method: 'PATCH',
      body: JSON.stringify({ items }),
    }),
  /** 行评论时间线。 */
  comments: (tableId: number, rowId: number) =>
    request<{ comments: BaserowRowComment[] }>(`/api/baserow/tables/${tableId}/rows/${rowId}/comments`),
  addComment: (tableId: number, rowId: number, message: string) =>
    request<unknown>(`/api/baserow/tables/${tableId}/rows/${rowId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  /** 关联行候选（link_row 选择器用）。 */
  linkRows: (tableId: number, linkedTableId: number, search = '') =>
    request<{ primary_field: string; rows: BaserowLinkRow[] }>(
      `/api/baserow/tables/${tableId}/link-rows/${linkedTableId}?search=${encodeURIComponent(search)}`,
    ),
  /** 回收站条目。 */
  trash: (workspaceId: number) =>
    request<{ count: number; items: BaserowTrashItem[] }>(`/api/baserow/trash?workspace_id=${workspaceId}`),
  /** 视图的字段选项（列宽 / 隐藏 / 顺序）。 */
  viewFieldOptions: (tableId: number, viewId: number) =>
    request<{ field_options: Record<string, BaserowViewFieldOption> }>(
      `/api/baserow/tables/${tableId}/views/${viewId}/field-options`,
    ),
  /** 更新视图的字段选项。 */
  updateViewFieldOptions: (
    tableId: number,
    viewId: number,
    fieldOptions: Record<string, BaserowViewFieldOption>,
  ) =>
    request<{ field_options: Record<string, BaserowViewFieldOption> }>(
      `/api/baserow/tables/${tableId}/views/${viewId}/field-options`,
      { method: 'PATCH', body: JSON.stringify({ field_options: fieldOptions }) },
    ),
  /** 从回收站恢复。 */
  restoreTrash: (body: { trash_item_id: number; trash_item_type: string; parent_trash_item_id?: number | null }) =>
    request<unknown>('/api/baserow/trash/restore', { method: 'POST', body: JSON.stringify(body) }),
  createWorkspace: (name: string) =>
    request<{ id: number; name: string }>('/api/baserow/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  createDatabase: (workspaceId: number, name: string) =>
    request<{ id: number; name: string }>(`/api/baserow/workspaces/${workspaceId}/databases`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  createTable: (databaseId: number, name: string) =>
    request<{ id: number; name: string }>(`/api/baserow/databases/${databaseId}/tables`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  createField: (tableId: number, name: string, type = 'text') =>
    request<{ id: number; name: string; type: string }>(`/api/baserow/tables/${tableId}/fields`, {
      method: 'POST',
      body: JSON.stringify({ name, type }),
    }),
  createRow: (tableId: number, values: Record<string, unknown>) =>
    request<BaserowRow>(`/api/baserow/tables/${tableId}/rows`, {
      method: 'POST',
      body: JSON.stringify(values),
    }),
  updateRow: (tableId: number, rowId: number, values: Record<string, unknown>) =>
    request<BaserowRow>(`/api/baserow/tables/${tableId}/rows/${rowId}`, {
      method: 'PATCH',
      body: JSON.stringify(values),
    }),
  deleteRow: (tableId: number, rowId: number) =>
    request<{ ok: boolean }>(`/api/baserow/tables/${tableId}/rows/${rowId}`, { method: 'DELETE' }),
  members: (workspaceId: number) =>
    request<{ members: BaserowMember[] }>(`/api/baserow/workspaces/${workspaceId}/members`),
  inviteMember: (workspaceId: number, email: string, permissions: string) =>
    request<{ ok?: boolean }>(`/api/baserow/workspaces/${workspaceId}/invite`, {
      method: 'POST',
      body: JSON.stringify({ email, permissions }),
    }),
  updateMember: (workspaceId: number, memberId: number, permissions: string) =>
    request<{ ok?: boolean }>(`/api/baserow/workspaces/${workspaceId}/members/${memberId}`, {
      method: 'PATCH',
      body: JSON.stringify({ permissions }),
    }),
  removeMember: (workspaceId: number, memberId: number) =>
    request<{ ok: boolean }>(`/api/baserow/workspaces/${workspaceId}/members/${memberId}`, { method: 'DELETE' }),
  renameField: (tableId: number, fieldId: number, name: string) =>
    request<{ ok?: boolean }>(`/api/baserow/tables/${tableId}/fields/${fieldId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deleteField: (tableId: number, fieldId: number) =>
    request<{ ok: boolean }>(`/api/baserow/tables/${tableId}/fields/${fieldId}`, { method: 'DELETE' }),
  deleteTable: (tableId: number) =>
    request<{ ok: boolean }>(`/api/baserow/tables/${tableId}`, { method: 'DELETE' }),
  deleteDatabase: (databaseId: number) =>
    request<{ ok: boolean }>(`/api/baserow/databases/${databaseId}`, { method: 'DELETE' }),
  /** 重命名数据表（Baserow 的 application 名称）。 */
  renameDatabase: (databaseId: number, name: string) =>
    request<{ id: number; name: string }>(`/api/baserow/databases/${databaseId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  /** 重命名工作区。 */
  renameWorkspace: (workspaceId: number, name: string) =>
    request<{ id: number; name: string }>(`/api/baserow/workspaces/${workspaceId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  /** 删除工作区（其中的数据表与记录一并删除）。 */
  deleteWorkspace: (workspaceId: number) =>
    request<{ ok: boolean }>(`/api/baserow/workspaces/${workspaceId}`, { method: 'DELETE' }),
  /** 上传附件到 Baserow 的 user-files，返回可写回文件字段的对象。 */
  uploadFile: async (tableId: number, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<BaserowFile>(`/api/baserow/tables/${tableId}/files`, { method: 'POST', body: fd });
  },
  importTable: async (tableId: number, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ created: number; fields_added: string[]; skipped: number }>(
      `/api/baserow/tables/${tableId}/import`,
      { method: 'POST', body: fd },
    );
  },
};
export const loginUrl = '/api/auth/login';

// ---------------------------------------------------------------- 绘图工作台
export interface PlotOutput {
  path: string;
  size: number;
}

export interface PlotJob {
  id: string;
  title: string;
  chart: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  message: string;
  params: Record<string, unknown>;
  outputs: PlotOutput[];
  created_at: number;
  updated_at: number;
}

export interface PlotParamSpec {
  key: string;
  label: string;
  type: 'text' | 'number' | 'checkbox' | 'select' | 'textarea';
  options?: string[];
  help?: string;
}

export interface PlotChart {
  id: string;
  name: string;
  group: string;
  description: string;
  columns: string;
  library: string;
  params: PlotParamSpec[];
}

export interface PlotSample {
  id: string;
  name: string;
  chart: string;
  description: string;
  data: string;
  newick?: string;
  params?: Record<string, unknown>;
}

export interface PlotMeta {
  charts: PlotChart[];
  samples: PlotSample[];
  libraries: { ok: boolean; python: string; libs: Record<string, boolean>; error?: string };
  palettes: string[];
}

export interface PlotJobInput {
  title: string;
  chart: string;
  data?: string;
  sample?: string;
  params?: Record<string, unknown>;
  wait?: boolean;
}

// ---------------------------------------------------------------- LaTeX 写作

export type LatexStatus =
  | 'draft'
  | 'writing'
  | 'submitted'
  | 'under_review'
  | 'revision'
  | 'accepted'
  | 'rejected';

export interface LatexDocument {
  id: string;
  title: string;
  kind: string;
  venue: string;
  authors: string;
  status: LatexStatus;
  abstract: string;
  keywords: string[];
  content: string;
  projectId?: string | null;
  knowledgeDocId?: number | null;
  dueDate?: string | null;
  compiledAt?: string | null;
  compileOk?: boolean | null;
  compileLog: string;
  pdfBytes: number;
  hasPdf: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface LatexTemplate {
  id: string;
  name: string;
  description: string;
  kind: string;
  tags: string[];
}

/** 批注状态：待处理 / 已接受 / 已拒绝 */
export type LatexReviewStatus = 'open' | 'accepted' | 'rejected';

export interface LatexReview {
  id: string;
  docId: string;
  author: string;
  lineFrom: number;
  lineTo: number;
  quote: string;
  comment: string;
  status: LatexReviewStatus;
  replyCount: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface LatexReviewReply {
  id: string;
  reviewId: string;
  author: string;
  content: string;
  createdAt?: string | null;
}

/** 一次可对比的版本（创建 / 保存 / 编译） */
export interface LatexVersion {
  id: number;
  kind: string;
  note: string;
  createdAt?: string | null;
  hasContent: boolean;
}

/** 编译素材（.cls / .sty / 图片等）：编译时与源码一起进沙箱 */
export interface LatexAsset {
  id: string;
  name: string;
  bytes: number;
  contentType: string;
  createdAt?: string | null;
}

export const plotApi = {
  meta: () => request<PlotMeta>('/api/next/v1/plot/meta'),
  jobs: () => request<{ items: PlotJob[] }>('/api/next/v1/plot/jobs'),
  job: (id: string) => request<PlotJob>(`/api/next/v1/plot/jobs/${encodeURIComponent(id)}`),
  create: (input: PlotJobInput) =>
    request<PlotJob>('/api/next/v1/plot/jobs', { method: 'POST', body: JSON.stringify(input) }),
  cancel: (id: string) =>
    request<PlotJob>(`/api/next/v1/plot/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/api/next/v1/plot/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  fileUrl: (id: string, path: string, download = false) =>
    `/api/next/v1/plot/jobs/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`,
  log: async (id: string) => {
    const res = await fetch(`/api/next/v1/plot/jobs/${encodeURIComponent(id)}/log`, { credentials: 'include' });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.text();
  },
};
