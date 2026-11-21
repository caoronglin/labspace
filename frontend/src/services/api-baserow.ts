/** 多维表格（Baserow）的类型与客户端。
 *
 * 从 api.ts 整块拆出：它是唯一一大块「自成体系」的领域（类型 + 一个子客户端），
 * 只依赖 request，搬走后 api.ts 只留核心接口与传输层。
 */
import { readCookie, request } from './api';

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
