import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Card, Flex, Skeleton, Typography } from 'antd';
import AppLayout from '../app/AppLayout';
import { useAuth } from '../app/AuthContext';
import ErrorBoundary from '../components/ErrorBoundary';
import { LEGACY_REDIRECTS, LegacyRedirectRoute } from './legacyRedirects';

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
const Drawio = lazy(() => import('../pages/Drawio'));
const PlotStudio = lazy(() => import('../pages/PlotStudio'));
const BioTools = lazy(() => import('../pages/BioTools'));
const Genomes = lazy(() => import('../pages/Genomes'));
const Colors = lazy(() => import('../pages/Colors'));
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
 * `/tools?tool=plot|genomes|drawio` 的兼容跳转。
 *
 * 三个工具拆成独立页面后，旧地址仍会从收藏夹与历史回复里被用户点开：
 * 这里把 `tool` 参数换成路径，其余参数（例如 `drawing=<id>`）原样带过去，
 * 否则「继续编辑某个图形」的旧链接会落在空白画布上。
 */
function ToolsRedirect() {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const tool = query.get('tool');
  const target = tool === 'plot' ? '/plot' : tool === 'genomes' ? '/genomes' : '/drawio';
  query.delete('tool');
  const rest = query.toString();
  return <Navigate to={rest ? `${target}?${rest}` : target} replace />;
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
            {/* 历史重定向债：统一在 routes/legacyRedirects.tsx 登记 + 埋点，
                攒够 30 天零命中就删表里那一行，路由表不用动。 */}
            {LEGACY_REDIRECTS.map((item) => (
              <Route key={item.from} path={item.from} element={<LegacyRedirectRoute item={item} />} />
            ))}
            <Route path="/services/:id" element={<ServiceDetail />} />
            <Route path="/embed/:id" element={<EmbedPage />} />
            <Route path="/sso/:serviceId" element={<SsoLogin />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/literature" element={<Literature />} />
            <Route path="/pdf" element={<PdfTools />} />
            <Route path="/papers" element={<DailyPapers />} />
            <Route path="/lab" element={<Lab />} />
            {/* 科研工具拆成三个独立页面；旧地址 /tools?tool=… 曾出现在收藏、
                Agent 回复和帮助文档里，必须重定向而不是 404。 */}
            <Route path="/tools" element={<ToolsRedirect />} />
            <Route path="/drawio" element={<Drawio />} />
            {/* 我的图形已并入流程图页的右侧面板；旧书签直接打开面板。 */}
            <Route path="/colors" element={<Colors />} />
            <Route path="/plot" element={<PlotStudio />} />
            {/* 多维表格已并入 /lab（多维表格空间） */}
            <Route path="/translate" element={<Translate />} />
            <Route path="/commands" element={<Commands />} />
            <Route path="/bioinfo" element={<Bioinfo />} />
            {/* 文本翻译已并入翻译中心（/translate 内含页签），旧路径重定向避免两个入口 */}
            <Route path="/weather" element={<Weather />} />
            <Route path="/workbench" element={<Workbench />} />
            <Route path="/latex" element={<LatexStudio />} />
            <Route path="/agent" element={<Agent />} />
            {/* 能力中心已并入 /agent：旧深链重定向，避免外部链接失效 */}
            <Route path="/databases" element={<Databases />} />
            <Route path="/genomes" element={<Genomes />} />
            <Route path="/bio-tools" element={<BioTools />} />
            <Route path="/help" element={<Help />} />
            <Route path="/files" element={<Files />} />
            <Route path="/seeds" element={<SeedStore />} />
            <Route path="/shared" element={<SharedMembers />} />
            {/* 课题资料与组会：学生也能进。
                之前用 RequireTeacher 整体拦住，学生连自己被授权的那一页都打不开
                （侧栏又没入口，只能靠导师口头说“去点这个链接”）。
                页面内部按角色分支：教师看管理视图，学生只看已授权目录与自己的周。 */}
            <Route path="/research" element={<ResearchFolders />} />
            <Route path="/meetings" element={<MeetingReports />} />
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
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
