import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Card, Flex, Skeleton, Typography } from 'antd';
import AppLayout from '../app/AppLayout';
import { useAuth } from '../app/AuthContext';
import ErrorBoundary from '../components/ErrorBoundary';

// 路由级懒加载：首屏只加载需要的代码块
const Home = lazy(() => import('../pages/Home'));
const ServiceDetail = lazy(() => import('../pages/ServiceDetail'));
const EmbedPage = lazy(() => import('../pages/EmbedPage'));
const SsoLogin = lazy(() => import('../pages/SsoLogin'));
const SearchPage = lazy(() => import('../pages/SearchPage'));
const Literature = lazy(() => import('../pages/Literature'));
const PdfTools = lazy(() => import('../pages/PdfTools'));
const DailyPapers = lazy(() => import('../pages/DailyPapers'));
const Lab = lazy(() => import('../pages/Lab'));
const Toolbox = lazy(() => import('../pages/Toolbox'));
const Drawings = lazy(() => import('../pages/Drawings'));
const Colors = lazy(() => import('../pages/Colors'));
const Docparse = lazy(() => import('../pages/Docparse'));
const Translate = lazy(() => import('../pages/Translate'));
const Commands = lazy(() => import('../pages/Commands'));
const Bioinfo = lazy(() => import('../pages/Bioinfo'));
const Weather = lazy(() => import('../pages/Weather'));
const Workbench = lazy(() => import('../pages/Workbench'));
const LatexStudio = lazy(() => import('../pages/LatexStudio'));
const Agent = lazy(() => import('../pages/Agent'));

const Databases = lazy(() => import('../pages/Databases'));
const Help = lazy(() => import('../pages/Help'));
const Files = lazy(() => import('../pages/Files'));
const SeedStore = lazy(() => import('../pages/SeedStore'));
const SharedMembers = lazy(() => import('../pages/SharedMembers'));
const ResearchFolders = lazy(() => import('../pages/ResearchFolders'));
const MeetingReports = lazy(() => import('../pages/MeetingReports'));
const Knowledge = lazy(() => import('../pages/Knowledge'));
const Network = lazy(() => import('../pages/Network'));
const Start = lazy(() => import('../pages/Start'));
const SnapOtter = lazy(() => import('../pages/SnapOtter'));
const Login = lazy(() => import('../pages/Login'));
const Admin = lazy(() => import('../pages/Admin'));
const NotFound = lazy(() => import('../pages/NotFound'));

function Loading() {
  return (
    <Flex vertical gap={16}>
      <Card size="small" styles={{ body: { padding: 20 } }}>
        <Skeleton active title={{ width: '32%' }} paragraph={{ rows: 1, width: ['70%', '45%'] }} />
      </Card>
      <div className="d509-stagger d509-grid d509-grid-lg">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} size="small" styles={{ body: { padding: 18 } }}>
            <Skeleton.Avatar active shape="square" size={42} />
          </Card>
        ))}
      </div>
    </Flex>
  );
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { isAdmin, loading } = useAuth();
  if (loading) return <Loading />;
  if (!isAdmin) {
    return (
      <Result403 />
    );
  }
  return <>{children}</>;
}

/**
 * 教师视角页面（课题资料、组会汇报）的路由守卫。
 *
 * 侧栏已经按 `teacherOnly` 隐藏了入口，但**直接粘链接**（收藏、分享、命令面板
 * 之外的旧地址）仍会进来：页面先渲出来，接口再 403，控制台一片红。
 * 这里提前拦住，给一个明确的"无访问权限"。
 */
function RequireTeacher({ children }: { children: React.ReactNode }) {
  const { isTeacher, loading } = useAuth();
  if (loading) return <Loading />;
  if (!isTeacher) {
    return <Result403 what="lab-teacher 教师" />;
  }
  return <>{children}</>;
}

function ToolRedirect({ tool }: { tool: string }) {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  query.set('tool', tool);
  return <Navigate to={`/tools?${query.toString()}`} replace />;
}

function Result403({ what = 'lab-admin 管理员' }: { what?: string }) {
  return (
    <div style={{ padding: 24 }}>
      <Typography.Title level={3} style={{ fontSize: 20 }}>
        无访问权限
      </Typography.Title>
      <Typography.Text type="secondary">
        该页面仅限 {what} 访问；需要的话请管理员给你加上对应用户组。
      </Typography.Text>
    </div>
  );
}

export function AppRoutes() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/start" element={<Start />} />
          <Route element={<AppLayout />}>
            <Route index element={<Home />} />
            <Route path="/services" element={<Navigate to="/start" replace />} />
            <Route path="/nav" element={<Navigate to="/start" replace />} />
            <Route path="/services/:id" element={<ServiceDetail />} />
            <Route path="/embed/:id" element={<EmbedPage />} />
            <Route path="/sso/:serviceId" element={<SsoLogin />} />
            <Route path="/favorites" element={<Navigate to="/start" replace />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/literature" element={<Literature />} />
            <Route path="/pdf" element={<PdfTools />} />
            <Route path="/papers" element={<DailyPapers />} />
            <Route path="/lab" element={<Lab />} />
            <Route path="/tools" element={<Toolbox />} />
            <Route path="/drawio" element={<ToolRedirect tool="drawio" />} />
            <Route path="/drawings" element={<Drawings />} />
            <Route path="/colors" element={<Colors />} />
            <Route path="/plot" element={<ToolRedirect tool="plot" />} />
            {/* 多维表格已并入 /lab（多维表格空间） */}
            <Route path="/baserow" element={<Navigate to="/lab?tab=tables" replace />} />
            <Route path="/docparse" element={<Docparse />} />
            <Route path="/translate" element={<Translate />} />
            <Route path="/commands" element={<Commands />} />
            <Route path="/bioinfo" element={<Bioinfo />} />
            {/* 文本翻译已并入翻译中心（/translate 内含页签），旧路径重定向避免两个入口 */}
            <Route path="/translation" element={<Navigate to="/translate" replace />} />
            <Route path="/weather" element={<Weather />} />
            <Route path="/workbench" element={<Workbench />} />
            <Route path="/latex" element={<LatexStudio />} />
            <Route path="/agent" element={<Agent />} />
            {/* 能力中心已并入 /agent：旧深链重定向，避免外部链接失效 */}
            <Route path="/agent/hub" element={<Navigate to="/agent?mode=hub" replace />} />
            <Route path="/databases" element={<Databases />} />
            <Route path="/genomes" element={<ToolRedirect tool="genomes" />} />
            <Route path="/help" element={<Help />} />
            <Route path="/files" element={<Files />} />
            <Route path="/seeds" element={<SeedStore />} />
            <Route path="/shared" element={<SharedMembers />} />
            <Route
              path="/research"
              element={
                <RequireTeacher>
                  <ResearchFolders />
                </RequireTeacher>
              }
            />
            <Route
              path="/meetings"
              element={
                <RequireTeacher>
                  <MeetingReports />
                </RequireTeacher>
              }
            />
            <Route path="/knowledge" element={<Knowledge />} />
            <Route path="/network" element={<Network />} />
            <Route path="/snapotter" element={<SnapOtter />} />
            <Route
              path="/admin/*"
              element={
                <RequireAdmin>
                  <Admin />
                </RequireAdmin>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Route>
          <Route path="/index.html" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
