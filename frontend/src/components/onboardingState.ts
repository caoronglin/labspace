/**
 * 新手引导的「已看过」状态。
 *
 * 单独抽出来是因为有两个组件要读它：
 * - OnboardingTour：写它（看完 / 关闭 / 重看）
 * - HelpOnboarding：读它，用来决定「版本更新弹窗」该不该抢在引导前面出现
 *
 * 放在 localStorage 而不是后端：这是纯客户端偏好，跨设备同步收益低、
 * 成本高（要加用户偏好表 + 迁移）。
 */

export const TOUR_EVENT = 'd509:tour';
export const TOUR_SEEN_PREFIX = 'd509:tour:v1:';

export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式禁用存储时忽略：本次会话内不再弹 */
  }
}

/** 该账号是否已经看过新手引导。 */
export function tourSeen(account: string): boolean {
  if (!account) return false;
  return readLocal(TOUR_SEEN_PREFIX + account) === '1';
}

/** 标记该账号已看过新手引导。 */
export function markTourSeen(account: string) {
  if (account) writeLocal(TOUR_SEEN_PREFIX + account, '1');
}

/** 触发一次「重看引导」。 */
export function requestTour() {
  window.dispatchEvent(new Event(TOUR_EVENT));
}
