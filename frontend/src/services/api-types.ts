/** 后端契约类型（与 FastAPI / LabGo 的响应一一对应）。 */
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
  /** 端到端测试账号：前端据此跳过新手引导 */
  e2e?: boolean;
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


export interface LabopsLibraryFolder {
  id: string;
  library_id: string;
  parent_id: string;
  name: string;
  item_count: number;
  created_at: string;
  updated_at: string;
}
