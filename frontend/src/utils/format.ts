/**
 * 统一的格式化函数（大小 / 时间 / 保留期）。
 *
 * 为什么要有这一份
 * ----------------
 * 改之前这些实现散落在 9 个文件里，规则各不相同：
 *   - 有的 0 值显示 `0 B`，有的显示 `—`，有的显示空串
 *   - 有的带 TB，有的不带
 *   - 精度有 1 位有 2 位
 *   - 有几处根本不进位，3MB 显示成 `3072.0 KB`
 * 同一个文件在不同页面显示成两个数，用户会怀疑数据不一致 —— 这是**一致性**
 * 维度上最典型的破窗。
 *
 * 规则（全局唯一）
 * ----------------
 * - 大小：1024 进制，最多 1 位小数；0 显示 `0 B`；未知（null/undefined/负数）显示 `—`
 * - 时间：`zh-CN` 本地化
 * - 保留期：天数 → 「保留最近 N 天」
 */

/** 把字节数格式化成人类可读的大小。 */
export function formatSize(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n) || n < 0) return '—';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / 1024 ** i;
  // 字节不显示小数（"12 B" 而不是 "12.0 B"），其余保留 1 位
  return `${i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** 格式化成 `zh-CN` 本地化时间；空值显示 `—`。 */
export function formatDateTime(v: string | number | Date | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('zh-CN');
}

/** 只到日期（不带时分秒）。 */
export function formatDate(v: string | number | Date | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('zh-CN');
}

/**
 * 保留期天数 → 人话。
 * 之前有的地方写死「7 天内可恢复」，有的地方用后端返回的 retentionDays，
 * 两边不一致时用户会据此安排「过期就找导师」然后踩空。
 * 统一走这里，数字由调用方从**后端配置**取。
 */
export function formatRetention(days: number | null | undefined): string {
  if (days === null || days === undefined || Number.isNaN(days)) return '保留期未配置';
  if (days <= 0) return '不保留';
  return `保留最近 ${days} 天`;
}

/** 时长（秒）→ 「1 小时 5 分」。 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分${s % 60 ? ` ${s % 60} 秒` : ''}`;
  const h = Math.floor(m / 60);
  return `${h} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
}
