/**
 * 课题资料（research 源）与组会汇报（meeting 源）的前端 API 客户端。
 *
 * 后端契约
 * --------
 * 课题资料（老师/管理员）：
 * - `GET    /api/admin/research/folders`      → { folders, total, storageAvailable }
 * - `POST   /api/admin/research/folders`      body { name }（学生账号名）
 * - `DELETE /api/admin/research/folders/{name}`（只收回访问权，**不删数据**）
 *
 * 课题资料（学生）：
 * - `GET    /api/research/mine`               → { ok, folder | null, message }
 *
 * 组会汇报：
 * - `GET    /api/meetings/weeks`                    → { weeks, total, currentWeek, storageAvailable }
 * - `POST   /api/meetings/weeks/{week}/grant`       body { userId }
 * - `DELETE /api/meetings/weeks/{week}/grant/{uid}`
 * - `GET    /api/meetings/weeks/{week}/files`       → { yearWeek, files, total, sizeBytes }
 * - `POST   /api/meetings/upload`                   multipart(file, yearWeek)
 * - `POST   /api/meetings/compress`                 body { keepWeeks }
 *
 * 为什么自己实现 fetch 而不复用 `services/api.ts` 的 `request()`
 * -----------------------------------------------------
 * `request()` 在 api.ts 里没有导出（只导出 `readCookie` / `redirectToLogin`），
 * 而 api.ts 已被多处引用、改动风险高。这里复用同样的 CSRF 双提交头与
 * 「401 跳登录」语义，另起一份实现，避免互相影响。
 */
import { readCookie, redirectToLogin, SessionExpiredError } from './api';

/** 后端 4xx/5xx 时抛出的错误，保留状态码以便界面区分「无权限」与「服务异常」。 */
export class LabspaceApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'LabspaceApiError';
    this.status = status;
  }

  /** 是否是「没有权限」类错误（界面要显示成提示而不是红色报错）。 */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `HTTP ${res.status}`;
    try {
      const data = JSON.parse(text) as unknown;
      if (data && typeof data === 'object' && 'detail' in data) {
        const detail = (data as { detail: unknown }).detail;
        if (typeof detail === 'string') return detail;
      }
      return text.slice(0, 200);
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function labFetch<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const csrf = readCookie('labspace_csrf');
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
  const headers: Record<string, string> = {};
  if (init.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;

  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers,
    body:
      init.body === undefined
        ? undefined
        : isForm
          ? (init.body as FormData)
          : JSON.stringify(init.body),
  });

  if (res.status === 401) {
    if (!window.location.pathname.startsWith('/login')) redirectToLogin();
    throw new SessionExpiredError();
  }
  if (!res.ok) throw new LabspaceApiError(res.status, await errorDetail(res));
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    // SAFETY: 本模块的接口全部返回 JSON；非 JSON 响应只可能是网关的纯文本错误页，
    // 调用方按字符串处理（这里用 unknown 断言保持泛型签名不变），不会静默丢内容。
    return (await res.text()) as unknown as T;
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------- 类型

/** 一个课题资料目录（`{进组时间}-{姓名}`）。 */
export interface ResearchFolder {
  name: string;
  source: string;
  path: string;
  /** 目录主人姓名（不是账号名）。 */
  displayName: string;
  /** 账号名（登录名），用于收回授权时定位。 */
  account: string;
  userId: string;
  /** 进组日期（YYYY-MM-DD）。 */
  joinedAt: string;
  usedBytes: number;
  /** 是否已开通访问授权。 */
  granted: boolean;
  /** 存储里是否存在对应账号（false = 历史遗留目录）。 */
  owned: boolean;
}

export interface ResearchFolderList {
  folders: ResearchFolder[];
  total: number;
  storageAvailable: boolean;
}

export interface ResearchMine {
  ok: boolean;
  folder: {
    name: string;
    path: string;
    source: string;
    exists: boolean;
    granted: boolean;
  } | null;
  message: string;
}

/** 某个周目录的一条授权名单。 */
export interface MeetingGrant {
  userId: string;
  name: string;
  account: string;
  grantedBy: string;
  createdAt: string;
}

/** 一个周目录（如 2026-W48）。 */
export interface MeetingWeek {
  yearWeek: string;
  grants: MeetingGrant[];
  fileCount: number;
  sizeBytes: number;
  compressed: boolean;
  compressedAt: string;
}

export interface MeetingWeekList {
  weeks: MeetingWeek[];
  total: number;
  /** 当前 ISO 周（如 2026-W48）。 */
  currentWeek: string;
  storageAvailable: boolean;
}

export interface MeetingFile {
  name: string;
  path: string;
  size: number;
  modified: string;
}

export interface MeetingFileList {
  yearWeek: string;
  files: MeetingFile[];
  total: number;
  sizeBytes: number;
  storageAvailable: boolean;
}

// ---------------------------------------------------------------- API

export const researchApi = {
  /** 老师/管理员：所有学生的课题资料目录。 */
  folders: () => labFetch<ResearchFolderList>('/api/admin/research/folders'),
  /** 老师/管理员：给某个学生开通课题资料目录。 */
  createFolder: (name: string) =>
    labFetch<{ ok: boolean; folder: ResearchFolder }>('/api/admin/research/folders', {
      method: 'POST',
      body: { name },
    }),
  /** 老师/管理员：收回目录访问权（数据保留）。 */
  revokeFolder: (name: string) =>
    labFetch<{ ok: boolean; removed: number; folders: string[]; dataKept: boolean }>(
      `/api/admin/research/folders/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),
  /** 学生：我的课题资料目录。 */
  mine: () => labFetch<ResearchMine>('/api/research/mine'),
};

export const meetingApi = {
  /** 周目录列表（只返回调用者可见的周）。 */
  weeks: () => labFetch<MeetingWeekList>('/api/meetings/weeks'),
  /** 给某人开通某周的访问权。 */
  grant: (yearWeek: string, userId: string) =>
    labFetch<{ ok: boolean; yearWeek: string; userId: string }>(
      `/api/meetings/weeks/${encodeURIComponent(yearWeek)}/grant`,
      { method: 'POST', body: { userId } },
    ),
  /**
   * 沿用上一周的授权名单。
   *
   * 只做加法：本周已有的保持不动，不会因为上周没有某人就撤权
   * （撤权是破坏性操作，必须由人显式决定）。
   */
  copyPreviousGrants: (yearWeek: string) =>
    labFetch<{
      ok: boolean;
      from: string;
      yearWeek: string;
      added: string[];
      skipped: number;
      failed: string[];
    }>(`/api/meetings/weeks/${encodeURIComponent(yearWeek)}/grant/copy-previous`, {
      method: 'POST',
    }),
  /** 收回某人的某周访问权。 */
  revoke: (yearWeek: string, userId: string) =>
    labFetch<{ ok: boolean }>(
      `/api/meetings/weeks/${encodeURIComponent(yearWeek)}/grant/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    ),
  /** 某周目录下的文件列表（未授权 403）。 */
  /** 删除周目录里的一个文件（进回收站，7 天内可恢复）。 */
  deleteFile: (yearWeek: string, path: string) =>
    labFetch<{ ok: boolean; yearWeek: string; path: string; name: string }>(
      `/api/meetings/weeks/${encodeURIComponent(yearWeek)}/delete`,
      { method: 'POST', body: { path } },
    ),
  files: (yearWeek: string) =>
    labFetch<MeetingFileList>(`/api/meetings/weeks/${encodeURIComponent(yearWeek)}/files`),
  /** 上传组会材料（归档文件名带上传人姓名与时间戳）。 */
  upload: (file: File, yearWeek?: string) => {
    const form = new FormData();
    form.append('file', file);
    if (yearWeek) form.append('yearWeek', yearWeek);
    return labFetch<{ ok: boolean; yearWeek: string; uploadedBy: string }>('/api/meetings/upload', {
      method: 'POST',
      body: form,
    });
  },
  /** 压缩旧周目录（保留最近 keepWeeks 周）。 */
  compress: (keepWeeks: number) =>
    labFetch<{ ok: boolean; compressed: number }>('/api/meetings/compress', {
      method: 'POST',
      body: { keepWeeks },
    }),
};
