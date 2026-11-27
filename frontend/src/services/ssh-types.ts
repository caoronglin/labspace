export interface SshConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'private_key';
  createdAt: string;
  updatedAt: string;
}

export interface SshConnectionInput {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'private_key';
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SshSession {
  id: string;
  connectionId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  createdAt: number;
  lastActiveAt: number;
  websocketAttached: boolean;
}

export interface SshFileEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'link';
  size: number;
  mtime: number;
  mode: number;
}

export interface SshAuditEntry {
  id: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  createdAt: string;
}
