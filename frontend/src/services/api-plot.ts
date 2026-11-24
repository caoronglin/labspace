/** 绘图工作台与 LaTeX 写作的类型与客户端（从 api.ts 整块拆出）。 */
import { request } from './api-http';

export const loginUrl = '/login';

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
