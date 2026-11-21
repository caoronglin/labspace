import { useEffect, useMemo, useState } from 'react';
import { hostUrl } from '../utils/host';
import { Link } from 'react-router-dom';
import {
  Avatar,
  Button,
  BorderBeam,
  Card,
  Dropdown,
  Empty,
  Flex,
  Input,
  Segmented,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import AccessGuide from '../components/AccessGuide';
import SearchResults from '../components/SearchResults';
import {
  ApartmentOutlined,
  AppstoreOutlined,
  BarChartOutlined,
  BgColorsOutlined,
  CodeOutlined,
  DatabaseOutlined,
  ConsoleSqlOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  LogoutOutlined,
  PartitionOutlined,
  SearchOutlined,
  TableOutlined,
  ThunderboltOutlined,
  TranslationOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { redirectSafely } from '../utils/safeNavigate';
import { api } from '../services/api';
import { useAuth } from '../app/AuthContext';
import { useThemeMode } from '../theme/ThemeContext';
import { tokens } from '../theme/tokens';
import { palette } from '../theme/palette';

/** 背景方案：全部为本地 CSS 渐变/纹理，离线可用，不拉外链图片 */
const BACKGROUNDS = [
  { key: 'lab', name: '实验蓝', css: `linear-gradient(135deg,${palette.tint.blue100} 0%,${palette.neutral.n75} 45%,${palette.tint.teal50} 100%)` },
  { key: 'teal', name: '松石绿', css: `linear-gradient(135deg,${palette.tint.teal50} 0%,${palette.neutral.n75} 50%,${palette.tint.blue50b} 100%)` },
  { key: 'dawn', name: '晨曦', css: `linear-gradient(135deg,${palette.tint.orange50} 0%,${palette.neutral.n75} 55%,${palette.tint.blue25} 100%)` },
  { key: 'graph', name: '网格', css: `linear-gradient(135deg,${palette.neutral.n75} 0%,${palette.neutral.n75} 100%)` },
  { key: 'dark', name: '深空', css: `linear-gradient(135deg,${palette.neutral.n900} 0%,${palette.neutral.n950} 55%,${palette.tint.darkTeal} 100%)` },
];

const SOURCES = [
  { key: 'all', label: '全部', categories: 'general,science,videos,news,books,it' },
  { key: 'web', label: '网页', categories: 'general' },
  { key: 'paper', label: '学术', categories: 'science,scientific publications' },
  // 「论文」只走文献源（OpenAlex → Semantic Scholar → Crossref → arXiv）；
  // 分类值与后端 searchconfig.py 的 SEARCH_CATEGORIES 一致。
  { key: 'papers', label: '论文', categories: 'scientific publications' },
  { key: 'video', label: '视频', categories: 'videos' },
  { key: 'image', label: '图片', categories: 'images' },
];

const QUICK = [
  { key: 'bioinfo', name: '生信实训', url: '/bioinfo', icon: <ExperimentOutlined /> },
  { key: 'genomes', name: '公共基因组', url: '/genomes', icon: <ExperimentOutlined /> },
  { key: 'files', name: '文件共享', url: '/files', icon: <FolderOpenOutlined /> },
  { key: 'knowledge', name: '知识库问答', url: '/agent?mode=kb', icon: <FileTextOutlined /> },
  { key: 'snapotter', name: '文件工坊', url: '/snapotter', icon: <ThunderboltOutlined /> },
  { key: 'plot', name: '绘图工作台', url: '/plot', icon: <BarChartOutlined /> },
  { key: 'drawio', name: '流程图设计', url: '/drawio', icon: <PartitionOutlined /> },
  { key: 'commands', name: 'Linux 命令', url: '/commands', icon: <ConsoleSqlOutlined /> },
  { key: 'literature', name: '文献检索', url: '/literature', icon: <GlobalOutlined /> },
  { key: 'databases', name: '植物数据库', url: '/databases', icon: <DatabaseOutlined /> },
  { key: 'translate', name: '翻译中心', url: '/translate', icon: <TranslationOutlined /> },
  { key: 'baserow', name: '数据表格', url: '/baserow', icon: <TableOutlined /> },
  { key: 'drawing', name: '图纸平台', url: hostUrl('/', 8093), icon: <ApartmentOutlined /> },
];

export default function Start() {
  const { me, loading } = useAuth();
  const { resolved, setMode } = useThemeMode();
  const { token } = theme.useToken();
  const [bg, setBg] = useState<string>(() => localStorage.getItem('labspace.bg') || 'lab');
  const [source, setSource] = useState('all');
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);

  useEffect(() => {
    localStorage.setItem('labspace.bg', bg);
  }, [bg]);

  const current = useMemo(() => BACKGROUNDS.find((b) => b.key === bg) ?? BACKGROUNDS[0], [bg]);
  const isDarkBg = current.key === 'dark';
  const fg = isDarkBg ? palette.neutral.n175 : token.colorText;
  const sub = isDarkBg ? 'rgba(226,232,240,0.72)' : token.colorTextSecondary;
  const categories = SOURCES.find((s) => s.key === source)?.categories ?? 'general';
  const searching = submitted.trim().length > 0;

  const search = useQuery({
    queryKey: ['start-search', submitted, categories, page, pageSize],
    queryFn: () => api.search(submitted, categories, 'all', page, pageSize),
    enabled: searching,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const results = search.data?.results ?? [];

  const onSearch = (value: string) => {
    const query = (value ?? q).trim();
    setQ(query);
    setSubmitted(query);
    setPage(1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const changeSource = (value: string) => {
    setSource(value);
    setPage(1);
  };

  const resetSearch = () => {
    setSubmitted('');
    setQ('');
    setPage(1);
  };

  const bgMenu = {
    items: BACKGROUNDS.map((b) => ({
      key: b.key,
      label: (
        <Space>
          <span
            style={{
              display: 'inline-block',
              width: 16,
              height: 16,
              borderRadius: 4,
              background: b.css,
              border: '1px solid rgba(0,0,0,0.12)',
            }}
          />
          {b.name}
          {b.key === bg && <Tag color="blue" variant="filled">当前</Tag>}
        </Space>
      ),
    })),
    onClick: ({ key }: { key: string }) => {
      setBg(key);
      if (key === 'dark') setMode('dark');
      else if (resolved === 'dark') setMode('light');
    },
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: current.css,
        color: fg,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Flex justify="space-between" align="center" style={{ padding: '16px 24px' }}>
        <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="lab-logo">D5</span>
          <Typography.Text strong style={{ color: fg, fontSize: 16 }}>
            D509 工作台
          </Typography.Text>
          <Tag variant="filled" style={{ background: isDarkBg ? 'rgba(255,255,255,0.08)' : 'rgba(37,99,235,0.08)' }}>
            实验室门户
          </Tag>
        </Link>

        <Space size={8}>
          <Tooltip title="切换背景">
            <Dropdown menu={bgMenu} placement="bottomRight">
              <Button
                type="text"
                icon={<BgColorsOutlined />}
                style={{ color: fg }}
              />
            </Dropdown>
          </Tooltip>
          <Tooltip title={resolved === 'dark' ? '切换浅色主题' : '切换深色主题'}>
            <Button
              type="text"
              icon={<CodeOutlined rotate={resolved === 'dark' ? 180 : 0} />}
              style={{ color: fg }}
              onClick={() => setMode(resolved === 'dark' ? 'light' : 'dark')}
            />
          </Tooltip>
          {loading ? null : me?.authenticated ? (
            <Dropdown
              placement="bottomRight"
              menu={{
                items: [
                  { key: 'profile', icon: <UserOutlined />, label: me.displayName || me.name || me.email },
                  { key: 'logout', icon: <LogoutOutlined />, label: '退出登录' },
                ],
                onClick: async ({ key }: { key: string }) => {
                  if (key === 'logout') {
                    const fallback = '/api/auth/logout-redirect';
                    try {
                      const r = await api.logout();
                      redirectSafely(r.logoutUrl, fallback);
                    } catch {
                      redirectSafely(undefined, fallback);
                    }
                  }
                },
              }}
            >
              <Space style={{ cursor: 'pointer' }}>
                <Avatar size={28} icon={<UserOutlined />} style={{ background: palette.brand.blue600 }} />
                <Typography.Text style={{ color: fg }}>{me.displayName || me.name || me.email}</Typography.Text>
              </Space>
            </Dropdown>
          ) : (
            <Button type="primary" onClick={() => redirectSafely('/api/auth/login', '/')}>
              登录
            </Button>
          )}
        </Space>
      </Flex>

      <Flex
        vertical
        align="center"
        justify={searching ? 'flex-start' : 'center'}
        style={{
          flex: 1,
          padding: searching ? '20px 24px 48px' : '0 24px 8vh',
          textAlign: 'center',
        }}
      >
        <Typography.Title
          level={searching ? 3 : 1}
          style={{
            color: fg,
            fontSize: searching ? 24 : 34,
            marginBottom: searching ? 14 : 4,
            fontWeight: 600,
          }}
        >
          {searching ? '统一搜索' : '实验数据、文献与工具，一步可达'}
        </Typography.Title>
        {!searching && (
          <Typography.Paragraph style={{ color: sub, marginBottom: 28, fontSize: 15 }}>
            统一检索网页、学术文献与教学视频，或直接进入常用工具
          </Typography.Paragraph>
        )}

        <div style={{ width: '100%', maxWidth: searching ? 1080 : 680 }}>
          <Flex justify="space-between" align="center" wrap gap={8} style={{ marginBottom: 12 }}>
            <Segmented
              value={source}
              onChange={(v) => changeSource(v as string)}
              options={SOURCES.map((s) => ({ label: s.label, value: s.key }))}
              style={{ background: isDarkBg ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.72)' }}
            />
            {searching ? (
              <Button type="text" onClick={resetSearch} style={{ color: sub }}>
                返回起始页
              </Button>
            ) : null}
          </Flex>
          {/* Ant Design 6 原生 BorderBeam：整页只在这里用一次，
              作为唯一动效焦点；周边仍是静态磨砂玻璃，避免"到处在动"。 */}
          <BorderBeam
            color={[
              { color: tokens.colorPrimary, percent: 0 },
              { color: tokens.colorAccent, percent: 50 },
              { color: palette.brand.violet600, percent: 100 },
            ]}
            count={2}
            duration={9}
            lineWidth={2}
            outset={2}
            style={{ borderRadius: 14 }}
          >
            <div className="d509-glass" style={{ borderRadius: 14, padding: 6 }}>
              <Input.Search
                size="large"
                allowClear
                enterButton={<SearchOutlined />}
                placeholder="搜索网页 / 学术文献 / 教学视频，或本地的服务、文件、命令与植物库"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onSearch={onSearch}
                variant="borderless"
              />
            </div>
          </BorderBeam>
          {!searching && (
            <Typography.Text style={{ color: sub, fontSize: 12, display: 'block', marginTop: 10 }}>
              回车搜索 · 来源：{SOURCES.find((s) => s.key === source)?.label}
            </Typography.Text>
          )}
        </div>

        {!searching && (
          <>
            <Flex gap={10} wrap justify="center" style={{ marginTop: 40, maxWidth: 860 }}>
              {QUICK.map((item) => {
                const tile = (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '10px 14px',
                      borderRadius: 10,
                      border: `1px solid ${isDarkBg ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.08)'}`,
                      background: isDarkBg ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.78)',
                      color: fg,
                      minWidth: 140,
                    }}
                  >
                    <span style={{ fontSize: 16, color: palette.brand.blue600 }}>{item.icon}</span>
                    <Typography.Text style={{ color: fg, fontSize: 13 }}>{item.name}</Typography.Text>
                  </div>
                );
                return item.url.startsWith('http') ? (
                  <a key={item.key} href={item.url} target="_blank" rel="noreferrer noopener">
                    {tile}
                  </a>
                ) : (
                  <Link key={item.key} to={item.url}>
                    {tile}
                  </Link>
                );
              })}
            </Flex>

            <Typography.Text style={{ color: sub, fontSize: 12, marginTop: 36 }}>
              <AppstoreOutlined /> 浏览器主页：/start
            </Typography.Text>
          </>
        )}

        {searching && (
          <div style={{ width: '100%', maxWidth: 1080, marginTop: 20 }}>
            {search.isFetching && !search.data ? (
              <Card size="small">
                <Skeleton active title={{ width: '35%' }} paragraph={{ rows: 6 }} />
              </Card>
            ) : null}
            {!search.isFetching && search.error ? (
              <Card size="small">
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="检索服务暂时不可用，请稍后重试。"
                />
              </Card>
            ) : null}
            {!search.isFetching && !search.error && results.length === 0 ? (
              <Card size="small">
                <Empty description={`没有找到与「${submitted}」相关的结果`} />
              </Card>
            ) : null}
            {results.length > 0 ? (
              <SearchResults
                data={search.data}
                keyword={submitted}
                page={page}
                pageSize={pageSize}
                onPageChange={(p, ps) => {
                  setPage(ps !== pageSize ? 1 : p);
                  setPageSize(ps);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              />
            ) : null}
          </div>
        )}
      </Flex>

      <AccessGuide />
    </div>
  );
}
