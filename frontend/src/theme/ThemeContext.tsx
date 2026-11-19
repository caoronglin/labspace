import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { darkTheme, lightTheme, tokens } from './tokens';

export type ThemeMode = 'light' | 'dark' | 'auto';

interface ThemeCtx {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (m: ThemeMode) => void;
  /** 品牌主色（Ant Design ColorPicker 可调） */
  primary: string;
  setPrimary: (color: string) => void;
  resetPrimary: () => void;
}

const Ctx = createContext<ThemeCtx>({
  mode: 'auto',
  resolved: 'light',
  setMode: () => {},
  primary: tokens.colorPrimary,
  setPrimary: () => {},
  resetPrimary: () => {},
});

const STORAGE_KEY = 'labspace.theme';
const PRIMARY_KEY = 'labspace.primary';

/** 与 styles.css 的 --d509-font-sans 保持同一字体栈，供 AntD 组件继承 */
export const FONT_FAMILY =
  "'HONOR Sans', 'HONOR Sans CN', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif";

/** ColorPicker 的预设色板：常用品牌色 + 科研图表色 */
export const PRIMARY_PRESETS: { label: string; colors: string[] }[] = [
  {
    label: '推荐',
    colors: [
      '#2B5CE6',
      '#1677FF',
      '#12A594',
      '#13C2C2',
      '#52C41A',
      '#FA8C16',
      '#FAAD14',
      '#EB2F96',
      '#722ED1',
      '#D4380D',
      '#1F2937',
    ],
  },
];

function readPrimary(): string {
  const saved = localStorage.getItem(PRIMARY_KEY);
  return saved && /^#[0-9a-f]{6}$/i.test(saved) ? saved : tokens.colorPrimary;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(
    () => (localStorage.getItem(STORAGE_KEY) as ThemeMode) || 'auto',
  );
  const [primary, setPrimaryState] = useState(readPrimary);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const resolved: 'light' | 'dark' = mode === 'auto' ? (systemDark ? 'dark' : 'light') : mode;

  // 站点自定义 CSS 变量依赖 html[data-theme]；不同步会导致 AntD 深色而页面底色/滚动条仍是浅色。
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.style.colorScheme = resolved;
  }, [resolved]);

  // 供非 antd 样式引用（--d509-brand 以此为基准）；默认色时不写入，
// 让深色主题的明亮蓝 fallback 生效。
  useEffect(() => {
    const root = document.documentElement;
    if (primary === tokens.colorPrimary) root.style.removeProperty('--d509-primary');
    else root.style.setProperty('--d509-primary', primary);
  }, [primary]);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    localStorage.setItem(STORAGE_KEY, m);
  }, []);

  const setPrimary = useCallback((color: string) => {
    setPrimaryState(color);
    localStorage.setItem(PRIMARY_KEY, color);
  }, []);

  const resetPrimary = useCallback(() => {
    setPrimaryState(tokens.colorPrimary);
    localStorage.removeItem(PRIMARY_KEY);
  }, []);

  const themeConfig = useMemo(() => {
    const base = resolved === 'dark' ? darkTheme : lightTheme;
    return {
      ...base,
      token: {
        ...base.token,
        fontFamily: FONT_FAMILY,
        colorPrimary: primary,
        colorInfo: primary,
        colorLink: primary,
      },
      components: {
        ...base.components,
        Progress: { ...(base.components?.Progress ?? {}), defaultColor: primary },
      },
    };
  }, [resolved, primary]);

  const value = useMemo(
    () => ({ mode, resolved, setMode, primary, setPrimary, resetPrimary }),
    [mode, resolved, setMode, primary, setPrimary, resetPrimary],
  );

  return (
    <Ctx.Provider value={value}>
      <ConfigProvider
        locale={zhCN}
        theme={themeConfig}
        componentSize="middle"
        wave={{ disabled: false }}
        // 所有对话框默认垂直居中：此前 stick 在 top:100px，高分屏上显得贴顶，
        // 长表单配合 70vh 最大高度时下半屏空白过多。单个 Modal 可用 centered={false} 覆盖。
        modal={{ centered: true }}
      >
        {children}
      </ConfigProvider>
    </Ctx.Provider>
  );
}

export const useThemeMode = () => useContext(Ctx);