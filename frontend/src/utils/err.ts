/**
 * 统一的错误文案处理。
 *
 * 后端异常信息有时很长（含 SQL、回溯、URL），直接塞进浮层提示会让界面很吵。
 * 这里统一截断到 60 个字符（按码点切，避免截断 emoji/中文组合）。
 */
export function errText(err: unknown, max = 60): string {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : err ? String(err) : '未知错误';
  const flat = raw.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return `${chars.slice(0, max).join('')}…`;
}
