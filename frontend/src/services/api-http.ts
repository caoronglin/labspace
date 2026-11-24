/** 传输层：CSRF、401 跳登录、错误归一化、ETag 冲突。 */
export const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function readCookie(name: string): string | undefined {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.split('=').slice(1).join('=')) : undefined;
}






/** 文献库：一个人可以有多个库，默认库不可删除。 */

/** 文献库里的文件夹，parent_id 为空表示库根目录。 */

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
  const target = new URL('/login', window.location.origin);
  if (back.startsWith('/') && !back.startsWith('//')) {
    target.searchParams.set('back', back);
  }
  window.location.assign(target.toString());
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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

export async function requestBlob(path: string): Promise<Blob> {
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
export async function requestFileContentPut(
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

export class FileContentConflictError extends Error {
  readonly etag?: string;
  constructor(message: string, etag?: string) {
    super(message);
    this.name = 'FileContentConflictError';
    this.etag = etag;
  }
}
