/**
 * 「交给 Agent」跨页交接。
 *
 * 各服务结果页把当前结果拼成一段问题写入一次性信箱，跳到 /agent 后由 Agent 页
 * 取出并预填输入框（读后即焚，刷新不会重复注入）。用 sessionStorage 是为了
 * 只活在当前标签页，不会把别人的结果带到下一个会话。
 */

const HANDOFF_KEY = 'labspace.agent.handoff';

export function handoffToAgent(prompt: string): string {
  try {
    sessionStorage.setItem(HANDOFF_KEY, prompt);
  } catch {
    /* 隐私模式写不了，跳转仍然有效，只是需要用户自己粘贴 */
  }
  return '/agent';
}

export function takeAgentHandoff(): string {
  try {
    const value = sessionStorage.getItem(HANDOFF_KEY);
    if (value) sessionStorage.removeItem(HANDOFF_KEY);
    return value ?? '';
  } catch {
    return '';
  }
}
