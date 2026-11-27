import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import type { Citation, ToolCall } from './types.ts';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function pickText(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

export function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 从任意结构的 SSE data 中提取增量文本。 */
export function extractDelta(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  const record = asRecord(payload);
  if (!record) return '';
  const direct = pickText(record, ['text', 'delta', 'content', 'chunk', 'token']);
  if (direct) return direct;
  for (const key of ['data', 'message', 'payload']) {
    const nested = record[key];
    if (nested !== undefined && nested !== null) {
      const got = extractDelta(nested);
      if (got) return got;
    }
  }
  return '';
}

/** 从任意结构中提取错误文案。 */
export function extractError(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  const record = asRecord(payload);
  if (!record) return '';
  const direct = pickText(record, ['message', 'error', 'detail', 'reason', 'description']);
  if (direct) return direct;
  for (const key of ['error', 'data', 'message']) {
    const got = extractDelta(record[key]);
    if (got) return got;
  }
  return '';
}

/** 从 meta 中解析工具调用列表，字段缺失时不崩溃。 */
export function parseToolCalls(meta?: Record<string, unknown>): ToolCall[] {
  const out: ToolCall[] = [];
  const push = (raw: unknown, idx: number) => {
    const record = asRecord(raw);
    if (!record) return;
    const name =
      pickText(record, ['toolName', 'tool_name', 'name', 'tool', 'function', 'title']) ||
      '工具调用';
    const args = stringify(
      record.arguments ?? record.input ?? record.args ?? record.parameters ?? record.params,
    );
    const result = stringify(
      record.result ?? record.output ?? record.response ?? record.content ?? record.data,
    );
    const status = pickText(record, ['status', 'state', 'phase']);
    out.push({ key: `${name}-${idx}-${out.length}`, name, args, result, status });
  };

  if (!meta) return out;
  const events = meta.events ?? meta.tools ?? meta.tool_calls;
  if (Array.isArray(events)) {
    events.forEach((event, index) => push(event, index));
  } else if (events !== undefined && events !== null) {
    push(events, 0);
  }

  const hasTopLevel =
    pickText(meta, ['toolName', 'tool_name']) !== '' ||
    meta.tool !== undefined ||
    meta.function !== undefined;
  if (hasTopLevel) push(meta, out.length);
  return out;
}

/** 引用来源以工具检索结果为准，不依赖模型复述文件名。 */
export function parseCitations(tools: ToolCall[]): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!/knowledge_search|knowledge_bases/.test(tool.name) || !tool.result) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(tool.result);
    } catch {
      continue;
    }
    const root = asRecord(parsed);
    if (!root) continue;
    const inner = asRecord(root.data) ?? root;
    const rows = inner.results;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const record = asRecord(row);
      if (!record) continue;
      const source = pickText(record, ['source']) || '未知文件';
      const chunk = typeof record.chunk_index === 'number' ? record.chunk_index : null;
      const key = `${source}#${chunk ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const score = typeof record.score === 'number' ? record.score : null;
      out.push({
        key,
        source,
        chunk,
        score,
        text: pickText(record, ['text', 'excerpt', 'content']),
      });
    }
  }
  return out;
}

export function relTime(value?: string | null): string {
  if (!value) return '';
  const date = dayjs(value);
  return date.isValid() ? date.fromNow() : '';
}

/** 内网 HTTP 场景没有 Clipboard API 时退回 execCommand。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续尝试 execCommand
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
