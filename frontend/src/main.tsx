import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, message as antdMessage } from 'antd';
import { ThemeProvider } from './theme/ThemeContext';
import { AuthProvider, useAuth } from './app/AuthContext';
import { AppRoutes } from './routes';
import './styles.css';
import { install as installDebugProbe } from './debug/runtime';

installDebugProbe();

// 调试面板整包较大且仅管理员可见，改成按需加载，不进普通用户首屏。
const GlobalDebugPanel = lazy(() => import('./debug/GlobalDebugPanel'));

function AdminOnlyDebugPanel() {
  const { isAdmin, loading } = useAuth();
  if (loading || !isAdmin) return null;
  return (
    <Suspense fallback={null}>
      <GlobalDebugPanel />
    </Suspense>
  );
}

// 全局消息提醒：顶部靠下（避开页头）、2 秒自动消失、最多同时 3 条。
// antd 6 的 message 实例不带 ConfigProvider 主题上下文，这里只调行为参数；
// 带样式的提示统一走 App.useApp() 的 message。
antdMessage.config({ top: 72, duration: 2, maxCount: 3, pauseOnHover: true });

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <AntApp>
            <BrowserRouter>
              <AppRoutes />
              <AdminOnlyDebugPanel />
            </BrowserRouter>
          </AntApp>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
