/**
 * 品牌标识（全站唯一实现）
 *
 * 之前 login / 头部 / 起始页各自写 `<span className="d509-logo">D5</span>`，
 * 字号、圆角、渐变靠 CSS 类各自兜，改一处忘一处就会不一致。
 * 统一到这里：`D5` + `09` 的双字重排版，右侧可挂副标题。
 */
import type { CSSProperties } from 'react';

export interface BrandMarkProps {
  /** 视觉尺寸：sm 头部 / lg 登录页 */
  size?: 'sm' | 'lg';
  /** 是否显示「D509 工作台 / 实验室一体化服务」文字块 */
  withText?: boolean;
  /** 副标题文案，占位固定的品牌语 */
  subtitle?: string;
  style?: CSSProperties;
}

export default function BrandMark({
  size = 'sm',
  withText = true,
  subtitle = '实验室一体化服务',
  style,
}: BrandMarkProps) {
  return (
    <div className="d509-brand" style={style}>
      <span
        className={size === 'lg' ? 'd509-logo d509-logo-lg' : 'd509-logo'}
        aria-hidden
      >
        D5
      </span>
      {withText && (
        <div style={{ minWidth: 0 }}>
          <div className="d509-brand-name">D509 工作台</div>
          <div className="d509-brand-sub">{subtitle}</div>
        </div>
      )}
    </div>
  );
}
