/**
 * 导师-组员共享目录（v26.11）的前端 API 客户端。
 *
 * 后端契约（backend/app/lab_shared.py）：
 * - `GET    /api/lab/shared/members`          → 名册 + 目录状态
 * - `POST   /api/lab/shared/members`          → 新增组员（并建目录、下发授权）
 * - `DELETE /api/lab/shared/members/{id}`     → 移出名册（目录与数据保留）
 * - `POST   /api/lab/shared/members/{id}/link`→ 关联门户账号
 * - `POST   /api/lab/shared/sync`             → 按名册补齐目录并重新下发授权
 * - `GET    /api/lab/shared/mine`             → 我在共享树里的那棵目录
 */
import { readCookie, redirectToLogin, SessionExpiredError } from './api';

export interface SharedMember {
  id: number;
  /** 学号。 */
  code: string;
  /** 名册里的姓名。 */
  name: string;
  /** 账号当前的显示名（目录名用这个）。 */
  displayName: string;
  status: string;
  /** 身份：博士后 / 博士生 / 硕士生 / 本科生 / 实习生 / 科研助理。 */
  identity: string;
  /** 门户账号键（还没建账号时为空）。 */
  account: string;
  /** 组员文件夹名：{学号}_{当前姓名}。 */
  folder: string;
}

export interface SharedMembersResult {
  ok: boolean;
  advisor: string;
  /** 共享树在文件核心里的路径：{导师账号}/共享文件-组员。 */
  tree: string;
  treeName: string;
  defaultFolders: string[];
  deleteWithinHours: number;
  canManage: boolean;
  members: SharedMember[];
}

export interface SharedMine {
  ok: boolean;
  granted: boolean;
  folder?: string;
  path?: string;
  tree: string;
  folders?: string[];
  deleteWithinHours?: number;
  message?: string;
}

export interface SharedSyncResult {
  ok: boolean;
  synced: number;
  total: number;
  problems: string[];
}

async function sharedFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const csrf = readCookie('labspace_csrf');
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'include',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (e) {
    // 网络层错误统一成可读文案：调用方只需要处理一种异常。
    throw new Error(`网络请求失败（${e instanceof Error ? e.message : String(e)}）`);
  }
  if (res.status === 401) {
    if (!window.location.pathname.startsWith('/login')) redirectToLogin();
    throw new SessionExpiredError();
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { detail?: unknown };
      if (typeof data.detail === 'string') detail = data.detail;
    } catch {
      /* 非 JSON 错误体：保留状态码文案 */
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const labSharedApi = {
  members: () => sharedFetch<SharedMembersResult>('/api/lab/shared/members'),
  mine: () => sharedFetch<SharedMine>('/api/lab/shared/mine'),
  /** 修改组员资料（姓名/身份/状态/账号）。改名会连带重建目录。 */
  updateMember: (
    id: number,
    body: { code: string; name: string; account?: string; status?: string; identity?: string },
  ) =>
    sharedFetch<{
      ok: boolean;
      member: SharedMember;
      renamed: boolean;
      oldFolder: string;
      problems: string[];
    }>(`/api/lab/shared/members/${encodeURIComponent(String(id))}`, {
      method: 'PATCH',
      body,
    }),
  addMember: (body: { code: string; name: string; account?: string; status?: string; identity?: string }) =>
    sharedFetch<{ ok: boolean; member: SharedMember }>('/api/lab/shared/members', {
      method: 'POST',
      body,
    }),
  removeMember: (id: number) =>
    sharedFetch<{ ok: boolean; removed: string; dataKept: boolean }>(
      `/api/lab/shared/members/${encodeURIComponent(String(id))}`,
      { method: 'DELETE' },
    ),
  linkMember: (id: number, body: { code: string; name: string; account: string }) =>
    sharedFetch<{ ok: boolean; member: SharedMember }>(
      `/api/lab/shared/members/${encodeURIComponent(String(id))}/link`,
      { method: 'POST', body },
    ),
  sync: () => sharedFetch<SharedSyncResult>('/api/lab/shared/sync', { method: 'POST' }),
};
