/**
 * 视口内才挂载（IntersectionObserver）
 *
 * 图表库（@ant-design/plots → G2）单块 1.4MB，即使做了路由懒加载，
 * 只要页面上有一个图，打开该页就要下载并解析它。
 * 这里的做法是：卡片先占位出正确高度，等它真的滚进视口再挂子组件。
 * - 首屏之外的图表完全不下载；
 * - 占位高度与真实图表一致，避免滚动位置跳动；
 * - 不支持 IntersectionObserver 的环境直接渲染（降级，不阻塞）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface LazyMountProps {
  children: ReactNode;
  /** 占位高度（px），应与真实内容高度一致以免布局抖动 */
  height?: number;
  /** 提前多少像素开始加载 */
  rootMargin?: string;
  /** 加载后的最小高度（默认与占位一致） */
  minHeight?: number;
}

export default function LazyMount({
  children,
  height = 260,
  rootMargin = '240px',
  minHeight,
}: LazyMountProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [visible, rootMargin]);

  return (
    <div ref={ref} style={{ minHeight: minHeight ?? height, contain: 'layout paint' }}>
      {visible ? children : <div aria-hidden style={{ height }} />}
    </div>
  );
}
