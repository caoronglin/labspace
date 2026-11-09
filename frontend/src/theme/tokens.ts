import { theme as antdTheme, type ThemeConfig } from 'antd';

/**
 * D509 工作台 · 设计令牌
 *
 * 设计原则「简约不简单」：
 * 1. 一个主色（蓝）承担全部强调语义，青色仅用于科研/数据类点缀；
 * 2. 用发丝级边框 + 极浅填充替代厚重阴影，层次靠留白与字重建立；
 * 3. 8px 间距栅格，所有内边距/外边距取 8 的倍数；
 * 4. 动效短促（120–340ms），并尊重 prefers-reduced-motion。
 */
export const tokens = {
  colorPrimary: '#2B5CE6',
  colorAccent: '#12A594',
  colorBgLayout: '#F6F7F9',
  colorBgContainer: '#FFFFFF',
  colorText: '#141A22',
  colorTextSecondary: '#5B6675',
  colorTextTertiary: '#636D7B',
  colorBorder: '#E6E9EF',
  colorSuccess: '#16A34A',
  colorWarning: '#D97706',
  colorError: '#DC2626',
  borderRadius: 10,
  borderRadiusLG: 14,
  borderRadiusSM: 8,
  fontSize: 14,
  controlHeight: 34,
  headerHeight: 60,
  siderWidth: 232,
  siderCollapsedWidth: 68,
  contentPadding: 24,
  motionDuration: 0.2,
  motionDurationSlow: 0.34,
  /** 8px 栅格 */
  space: 8,
} as const;

/**
 * 8px 间距栅格（4 为半格，仅用于图标与文字的微调）
 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/** 圆角体系：与 tokens.borderRadius(SM/LG) 保持一致 */
export const radii = {
  sm: 8,
  md: 10,
  lg: 14,
  pill: 999,
} as const;

/** 阴影三档：全局只允许使用这三档，禁止再写 boxShadow 字面量 */
export const shadows = {
  sm: '0 1px 2px rgba(16, 24, 40, 0.06)',
  md: '0 4px 14px rgba(16, 24, 40, 0.08)',
  lg: '0 12px 32px rgba(16, 24, 40, 0.12)',
} as const;

/** 焦点可见性：2px 实线描边 + 3px 品牌色光晕（键盘可达性） */
export const focusRing = {
  outline: '2px solid #2B5CE6',
  halo: '0 0 0 3px rgba(43, 92, 230, 0.18)',
} as const;

/**
 * 动效令牌：节奏参考 Ant Design Motion
 * - 时长 120 / 200 / 340 / 520ms
 * - 位移统一 8~12px，缩放 0.98→1，无 3D 翻转、无夸张弹跳
 */
export const motion = {
  durationFast: 0.12,
  durationBase: 0.2,
  durationSlow: 0.34,
  durationSlower: 0.52,
  easeStandard: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
  easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
  easeIn: 'cubic-bezier(0.7, 0, 0.84, 0)',
  easeSpring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  /** 错峰间隔与上限 */
  staggerStep: 0.04,
  staggerMax: 8,
  /** 入场位移与缩放 */
  enterOffset: 10,
  enterScale: 0.98,
} as const;

/** 中文排版层级 */
export const typography = {
  fontSize: 14,
  lineHeight: 1.6,
  h1: 21,
  h2: 16.5,
  h3: 15,
  body: 14,
  aux: 12.5,
} as const;

/** 全站唯一一处品牌渐变：仅用于 Hero 与主按钮 */
export const brandGradient = 'linear-gradient(135deg, #2B5CE6 0%, #12A594 100%)';

const baseToken = {
  colorPrimary: tokens.colorPrimary,
  colorInfo: tokens.colorPrimary,
  colorSuccess: tokens.colorSuccess,
  colorWarning: tokens.colorWarning,
  colorError: tokens.colorError,
  colorLink: tokens.colorPrimary,
  borderRadius: tokens.borderRadius,
  borderRadiusLG: tokens.borderRadiusLG,
  borderRadiusSM: Math.round(tokens.borderRadius * 0.75),
  fontSize: tokens.fontSize,
  controlHeight: tokens.controlHeight,
  motionDurationFast: `${motion.durationFast}s`,
  motionDurationMid: `${motion.durationBase}s`,
  motionDurationSlow: `${motion.durationSlow}s`,
  motionEaseInOut: motion.easeStandard,
  motionEaseOut: motion.easeOut,
  motionEaseIn: motion.easeIn,
  wireframe: false,
};

const componentToken = {
  Layout: {
    headerHeight: tokens.headerHeight,
    headerPadding: '0 20px',
    bodyBg: tokens.colorBgLayout,
    siderBg: tokens.colorBgContainer,
  },
  Menu: {
    itemHeight: 38,
    itemBorderRadius: 8,
    collapsedWidth: tokens.siderCollapsedWidth,
    groupTitleFontSize: 12,
    itemMarginInline: 6,
  },
  Card: {
    borderRadiusLG: tokens.borderRadiusLG,
    paddingLG: 20,
    headerHeight: 48,
  },
  Button: { controlHeight: tokens.controlHeight, fontWeight: 500 },
  Input: { controlHeight: tokens.controlHeight, activeShadow: focusRing.halo },
  Select: { controlHeight: tokens.controlHeight },
  Segmented: { itemSelectedBg: tokens.colorBgContainer, trackBg: 'rgba(0,0,0,0.04)' },
  Table: { headerBg: '#FAFBFC', headerSplitColor: 'transparent', cellPaddingBlock: 12 },
  Tag: { defaultBg: 'rgba(0,0,0,0.045)', borderRadiusSM: 6 },
  Statistic: { contentFontSize: 26 },
  Tooltip: { borderRadius: 8 },
  Modal: { borderRadiusLG: tokens.borderRadiusLG },
  Drawer: { borderRadiusLG: 0 },
  Descriptions: { titleMarginBottom: 12 },
  Progress: { defaultColor: tokens.colorPrimary },
  Empty: { colorTextDescription: tokens.colorTextSecondary },
  Skeleton: { gradientFromColor: 'rgba(0,0,0,0.04)', gradientToColor: 'rgba(0,0,0,0.08)' },
};

export const lightTheme: ThemeConfig = {
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    ...baseToken,
    colorBgLayout: tokens.colorBgLayout,
    colorBgContainer: tokens.colorBgContainer,
    colorBgElevated: '#FFFFFF',
    colorText: tokens.colorText,
    colorTextSecondary: tokens.colorTextSecondary,
    colorBorder: tokens.colorBorder,
    colorBorderSecondary: '#EEF0F4',
    colorFillQuaternary: 'rgba(20, 26, 34, 0.04)',
    colorFillTertiary: 'rgba(20, 26, 34, 0.06)',
    colorTextTertiary: tokens.colorTextTertiary,
    boxShadow: shadows.sm,
    boxShadowSecondary: shadows.md,
  },
  components: componentToken,
};

export const darkTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    ...baseToken,
    colorBgLayout: '#0D1219',
    colorBgContainer: '#151B24',
    colorBgElevated: '#1A212C',
    colorText: '#E8ECF2',
    colorTextSecondary: '#97A3B4',
    colorBorder: '#242C38',
    colorBorderSecondary: '#1E2530',
    colorFillQuaternary: 'rgba(255,255,255,0.04)',
    colorFillTertiary: 'rgba(255,255,255,0.07)',
    colorTextTertiary: '#8E99AA',
    boxShadow: '0 1px 2px rgba(0,0,0,0.4)',
    boxShadowSecondary: '0 10px 30px rgba(0,0,0,0.5)',
  },
  components: {
    ...componentToken,
    Layout: { ...componentToken.Layout, bodyBg: '#0D1219', siderBg: '#151B24' },
    Menu: {
      ...componentToken.Menu,
      darkItemBg: 'transparent',
      darkSubMenuItemBg: 'transparent',
      darkItemColor: '#97A3B4',
      darkItemSelectedBg: 'rgba(91,139,255,0.18)',
      darkItemSelectedColor: '#E8ECF2',
      darkItemHoverBg: 'rgba(255,255,255,0.06)',
    },
    Segmented: {
      ...componentToken.Segmented,
      itemSelectedBg: 'rgba(91,139,255,0.24)',
      trackBg: 'rgba(255,255,255,0.06)',
    },
    Table: { ...componentToken.Table, headerBg: '#1A212C' },
    Tag: { ...componentToken.Tag, defaultBg: 'rgba(255,255,255,0.07)' },
    Skeleton: {
      ...componentToken.Skeleton,
      gradientFromColor: 'rgba(255,255,255,0.05)',
      gradientToColor: 'rgba(255,255,255,0.1)',
    },
    Empty: { ...componentToken.Empty, colorTextDescription: '#97A3B4' },
  },
};
