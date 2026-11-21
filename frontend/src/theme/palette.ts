/**
 * 非语义色板：给「必须是个具体颜色」的地方用。
 *
 * 为什么单独一个文件：业务页面里出现 `#2B5CE6` 这种裸 hex 时，改一次主题要
 * 全仓库搜一遍，而且深浅模式没法跟着变。把值收在这里之后，页面只引用名字：
 *
 *   style={{ color: palette.brand.blue600 }}
 *   className 之外的图表色板也走 palette.brand.* / palette.tint.*
 *
 * 真正的**语义**颜色（主色、边框、正文……）请优先用 `theme.useToken()`
 * 或 `theme/tokens.ts` 里的 tokens；这里只兜底那些「就是某个具体色相」的场景
 * （图表序列、分类徽标、渐变）。
 */
export const palette = {
  /** 中性灰阶：背景、分割线、次级文字 */
  neutral: {
    n50: '#F8FAFC',
    n75: '#F6F8FB',
    n80: '#F5F5F5',
    n100: '#EEF0F4',
    n150: '#E6E9EF',
    n175: '#E2E8F0',
    n200: '#D8DEE8',
    n250: '#C7CDD6',
    n280: '#CCCCCC',
    n300: '#BFBFBF',
    n400: '#94A3B8',
    n450: '#8C8C8C',
    n460: '#888888',
    n500: '#64748B',
    n600: '#5B6675',
    n900: '#0F172A',
    n950: '#111C33',
  },
  /** 色相：品牌蓝、青、紫、粉、绿、橙、琥珀、珊瑚 */
  brand: {
    blue600: '#2563EB',
    blue500: '#4F7CFF',
    blue200: '#9EC1FF',
    antBlue: '#1677FF',
    sky500: '#0EA5E9',
    cyan700: '#0891B2',
    cyan400: '#13C2C2',
    violet600: '#7C3AED',
    violet500: '#8E4EC6',
    purple600: '#722ED1',
    pink600: '#EB2F96',
    green500: '#52C41A',
    green700: '#2F9E63',
    olive700: '#3F8600',
    teal700: '#00A087',
    teal300: '#4DBBD5',
    red600: '#E64B35',
    red500: '#E5484D',
    orange600: '#F76B15',
    orange700: '#EA580C',
    orange400: '#FA8C16',
    orange800: '#D46B08',
    amber500: '#FAAD14',
    amber200: '#FFD08A',
    coral200: '#FFB3A7',
  },
  /** 浅底色：标签底、卡片底、提示条底 */
  tint: {
    blue25: '#EFF6FF',
    blue50: '#EEF4FF',
    blue50b: '#EAF2FF',
    blue100: '#E8F0FE',
    blue100b: '#E6F4FF',
    orange50: '#FFF7ED',
    orange100: '#FFF2E8',
    teal50: '#E6F7F5',
    green50: '#E8F7EE',
    green200: '#8EE7C0',
    darkTeal: '#0B2B2B',
  },
  white: '#FFFFFF',
} as const;

export type Palette = typeof palette;
