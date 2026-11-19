/**
 * 受控跳转：只允许「站内相对路径」或「http(s) 绝对地址」。
 *
 * 为什么需要它：
 *   登出要跳到 IdP 的登出地址，那个地址来自服务端响应。直接
 *   `window.location.href = resp.logoutUrl` 的话，一旦响应被篡改成
 *   `https://evil.example/`，用户就被带去钓鱼站点了。
 *
 * 这里把"跳转目标是受控的"收在一个地方，页面里只剩下一次调用，
 * 不会再出现某处忘了校验的情况。
 */
export function safeExternalUrl(candidate: string | undefined, fallback: string): string {
  if (!candidate) return fallback;
  // 站内相对路径：不含协议与主机，无法跳出本站
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

/** 受控跳转（同标签页）。 */
export function redirectSafely(candidate: string | undefined, fallback: string): void {
  window.location.replace(safeExternalUrl(candidate, fallback));
}
