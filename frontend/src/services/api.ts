/** D509 工作台后端 API 客户端（始终同源，走 Nginx 代理）。 */
export * from './api-http';
export * from './api-types';
export * from './api-types-agent';
export * from './api-plot';
import { request, requestBlob, requestFileContentPut } from './api-http';
import type { AccessPreviewResponse, AccountItem, AccountsResponse, AdminInfo, AdminTaskList, Announcement, BackupGitStatus, BackupStatus, CorpusItem, DailyPapersResponse, DailySub, DatabaseApiIndex, DatabaseItem, DatabaseQueryResult, EmbedInfo, FileAccessEvent, FileContent, FileEntry, FileGrant, FilePreview, FileSortKey, FileSource, FileTrashItem, FileTrashSummary, FileUsage, GroupPermissionsResponse, IngestResult, IngestSummary, KnowledgeDoc, KnowledgeFacets, KnowledgeSpace, KnowledgeSpaces, Me, MentorBindings, OfficeContent, OfficeSavePayload, PeopleEntry, PersonalShare, RagAnswer, RagStatus, SearchResponse, ServiceItem, SharedEntry, WeComConfig, WorkbenchBrief, WorkbenchCapture, WorkbenchItem, WorkbenchPlan, WorkbenchProject, WorkbenchSummary } from './api-types';
import type { AgentAdminConfig, AgentMemory, AgentMessage, AgentModel, AgentQuota, AgentSession, AgentSkillOption, AgentStatus, AgentUsageSummary, ColorMatchItem, ColorMeta, ColorPaletteList, LabopsEntry, LabopsLibrary, LabopsLibraryFolder, LabopsLiterature, LabopsPublishResult, LabopsTemplate, TranslateResult, TranslateStatus, WeatherReport } from './api-types-agent';
import type { LatexAsset, LatexDocument, LatexReview, LatexReviewReply, LatexReviewStatus, LatexStatus, LatexTemplate, LatexVersion } from './api-plot';



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

export * from './api-baserow';
