/**
 * 访问入口自适应工具。
 *
 * 门户支持两种入口：
 *   - 内网 LAN：      http://192.0.2.10/
 *   - Tailscale：     http://198.51.100.71/
 *
 * 用户从哪个地址进来，服务链接就使用同一个地址，
 * 避免外网客户端被引导到不可达的 LAN IP。
 */

/** 默认（内网）主机名，仅在浏览器环境不可用时兜底。 */
export const DEFAULT_HOST = '192.0.2.10';

/** 当前访问入口的主机名（不含端口）。 */
export function currentHost(): string {
  if (typeof window === 'undefined' || !window.location?.hostname) return DEFAULT_HOST;
  return window.location.hostname || DEFAULT_HOST;
}

/**
 * 拼出「当前主机 + 端口 + 路径」的服务地址。
 *
 * @param path  路径，例如 '/files/'
 * @param port  端口，例如 8082；省略则用当前端口（门户自身 80）
 */
export function hostUrl(path = '/', port?: number | string): string {
  const host = currentHost();
  const suffix = port === undefined || port === '' ? '' : `:${port}`;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `http://${host}${suffix}${p}`;
}

/** 相对路径链接（站内页面，无需主机名）。 */
export function siteUrl(path = '/'): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return p;
}
