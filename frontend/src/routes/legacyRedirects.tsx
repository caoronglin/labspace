import { Navigate } from 'react-router-dom';

/**
 * 历史重定向债的**唯一登记处**。
 *
 * 这些旧路径曾经是真实入口（收藏夹、Agent 回复、文档、别人的书签里都还在），
 * 删掉就会 404，用户只会说「门户坏了」。但把它们散落在 `routes/index.tsx` 里
 * 又有两个问题：
 *
 *   1. 没人清得掉 —— 不知道哪条还在被访问，也就没人敢删；
 *   2. 路由表越读越长，真正的页面关系被淹没在转发里。
 *
 * 所以集中登记 + 埋点：每条命中都打一次 `/api/legacy-hit`，攒够 30 天零命中
 * 就可以从这张表里删掉。**删的时候只删这张表的一行**，路由表不动。
 */
export interface LegacyRedirect {
  /** 旧路径 */
  from: string;
  /** 新路径（可带 query） */
  to: string;
  /** 为什么还留着 —— 写清楚来源，将来才敢删 */
  note: string;
}

export const LEGACY_REDIRECTS: LegacyRedirect[] = [
  { from: '/services', to: '/start', note: '服务目录与「全部服务」合并为 /start' },
  { from: '/nav', to: '/start', note: '老的导航页并进 /start' },
  { from: '/favorites', to: '/start', note: '收藏与最近访问并入 /start 首屏' },
  { from: '/drawings', to: '/drawio?panel=drawings', note: '我的图形并入 /drawio 右侧面板' },
  { from: '/baserow', to: '/lab?tab=tables', note: '多维表格并入 /lab' },
  { from: '/translation', to: '/translate', note: '文本翻译并入翻译中心页签' },
  { from: '/agent/hub', to: '/agent?mode=hub', note: '能力中心并入 /agent' },
  { from: '/network', to: '/start', note: '网络自检并入 /start 的服务状态区' },
  { from: '/index.html', to: '/', note: '静态站点时代的首屏地址' },
];

/** 记一次命中：失败就算了，埋点不能影响跳转。 */
function recordHit(from: string) {
  try {
    const body = JSON.stringify({ path: from });
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon('/api/legacy-hit', new Blob([body], { type: 'application/json' }));
      return;
    }
    void fetch('/api/legacy-hit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    });
  } catch {
    /* 埋点是旁路 */
  }
}

/** 旧路径 → 新路径，命中即上报。 */
export function LegacyRedirectRoute({ item }: { item: LegacyRedirect }) {
  recordHit(item.from);
  return <Navigate to={item.to} replace />;
}
