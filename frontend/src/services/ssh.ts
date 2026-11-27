import { readCookie } from './api-http';
import type { SshAuditEntry, SshConnection, SshConnectionInput, SshFileEntry, SshSession } from './ssh-types';

export class SshApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly payload: Record<string, unknown>;

  constructor(status: number, payload: Record<string, unknown>) {
    const detail = payload.detail;
    const detailRecord = typeof detail === 'object' && detail !== null
      ? detail as Record<string, unknown>
      : undefined;
    super(String(detailRecord?.message ?? detail ?? payload.message ?? `SSH 网关错误 ${status}`));
    this.name = 'SshApiError';
    this.status = status;
    const payloadCode = typeof payload.code === 'string' ? payload.code : undefined;
    const detailCode = typeof detailRecord?.code === 'string' ? detailRecord.code : undefined;
    this.code = payloadCode ?? detailCode;
    this.payload = payload;
  }
}

async function sshRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const csrf = readCookie('labspace_csrf');
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
  const headers = {
    ...(init.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers as Record<string, string> | undefined),
    ...(csrf && init.method && init.method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
  };
  const response = await fetch(path, { credentials: 'include', ...init, headers });
  if (!response.ok) {
    let payload: Record<string, unknown> = {};
    try { payload = await response.json() as Record<string, unknown>; } catch { /* ignore */ }
    if (response.status === 401 && !window.location.pathname.startsWith('/login')) {
      window.location.assign(`/login?back=${encodeURIComponent(window.location.pathname)}`);
    }
    throw new SshApiError(response.status, payload);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

async function sshBlob(path: string): Promise<Blob> {
  const response = await fetch(path, { credentials: 'include' });
  if (!response.ok) throw new SshApiError(response.status, { detail: `下载失败 ${response.status}` });
  return response.blob();
}

export const sshApi = {
  connections: () => sshRequest<{ connections: SshConnection[] }>('/ssh-api/api/connections'),
  saveConnection: (body: SshConnectionInput) => sshRequest<{ connection: SshConnection }>('/ssh-api/api/connections', { method: 'POST', body: JSON.stringify(body) }),
  deleteConnection: (id: string) => sshRequest<{ ok: boolean }>(`/ssh-api/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  sessions: () => sshRequest<{ sessions: SshSession[]; limits: { perUser: number; global: number } }>('/ssh-api/api/sessions'),
  createSession: (connectionId: string, cols = 120, rows = 30) => sshRequest<{ session: SshSession }>('/ssh-api/api/sessions', { method: 'POST', body: JSON.stringify({ connection_id: connectionId, cols, rows }) }),
  stopSession: (id: string) => sshRequest<{ ok: boolean }>(`/ssh-api/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  confirmHostKey: (host: string, port: number, keyType: string, fingerprint: string) => sshRequest<{ ok: boolean }>('/ssh-api/api/host-keys/confirm', { method: 'POST', body: JSON.stringify({ host, port, key_type: keyType, fingerprint }) }),
  listFiles: (sessionId: string, path: string) => sshRequest<{ path: string; entries: SshFileEntry[] }>(`/ssh-api/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`),
  previewFile: (sessionId: string, path: string) => sshRequest<{ path: string; text: string; truncated: boolean }>(`/ssh-api/api/sessions/${encodeURIComponent(sessionId)}/files/content?path=${encodeURIComponent(path)}`),
  downloadFile: (sessionId: string, path: string) => sshBlob(`/ssh-api/api/sessions/${encodeURIComponent(sessionId)}/files/download?path=${encodeURIComponent(path)}`),
  uploadFile: (sessionId: string, path: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return sshRequest<{ ok: boolean; path: string; size: number }>(`/ssh-api/api/sessions/${encodeURIComponent(sessionId)}/files/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: form });
  },
  mkdir: (sessionId: string, path: string) => sshRequest<{ ok: boolean }>(`/ssh-api/api/sessions/${encodeURIComponent(sessionId)}/files/mkdir`, { method: 'POST', body: JSON.stringify({ path }) }),
  rename: (sessionId: string, path: string, newPath: string) => sshRequest<{ ok: boolean }>(`/ssh-api/api/sessions/${encodeURIComponent(sessionId)}/files/rename`, { method: 'POST', body: JSON.stringify({ path, new_path: newPath }) }),
  deleteFile: (sessionId: string, path: string) => sshRequest<{ ok: boolean }>(`/ssh-api/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  audit: () => sshRequest<{ entries: SshAuditEntry[] }>('/ssh-api/api/audit'),
};
