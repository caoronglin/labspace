/** Agent / 知识库 / 工作台相关的契约类型（api-types 的后半段）。 */
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
