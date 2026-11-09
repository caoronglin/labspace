/**
 * 图表通用外观工具
 *
 * - 颜色一律取自 src/theme/tokens.ts（配合 antd theme.useToken() 适配暗色）
 * - 不另起独立配色板，避免与门户整体视觉割裂
 */
import { theme } from 'antd';
import { useThemeMode } from '../../theme/ThemeContext';
import { tokens } from '../../theme/tokens';

export interface ChartPalette {
  /** 主色（图表主序列） */
  primary: string;
  /** 强调色（科研/数据类点缀） */
  accent: string;
  success: string;
  warning: string;
  error: string;
  /** 次要文本色，用于坐标轴/图例 */
  text: string;
  textSecondary: string;
  /** 图表底色，容器透明时保持与卡片一致 */
  background: string;
}

/** 从 antd 令牌读取明暗主题下的调色板 */
export function useChartPalette(): ChartPalette {
  const { token } = theme.useToken();
  return {
    primary: token.colorPrimary,
    accent: tokens.colorAccent,
    success: token.colorSuccess,
    warning: token.colorWarning,
    error: token.colorError,
    text: token.colorText,
    textSecondary: token.colorTextSecondary,
    background: token.colorBgContainer,
  };
}

/**
 * G2 v5 主题配置：跟随门户明暗模式，并统一字号与文字色。
 * 背景保持透明，由卡片背景承载。
 */
export function useChartTheme() {
  const { resolved } = useThemeMode();
  const { token } = theme.useToken();
  return {
    type: resolved === 'dark' ? 'classicDark' : 'classic',
    backgroundColor: 'transparent',
    textStyle: {
      fill: token.colorTextSecondary,
      fontSize: 12,
    },
    axis: {
      labelFill: token.colorTextSecondary,
      labelFontSize: 11.5,
      titleFill: token.colorText,
      titleFontSize: 12,
      lineStroke: token.colorBorderSecondary,
      tickStroke: token.colorBorderSecondary,
    },
    legend: {
      labelFill: token.colorText,
      labelFontSize: 12,
      titleFontSize: 12,
    },
    view: {
      viewFill: 'transparent',
    },
  };
}

/** 把字节数换算成 GB（保留一位小数） */
export function bytesToGB(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/** 数字千分位 */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}
