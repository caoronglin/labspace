import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BellOutlined,
  BookOutlined,
  CloudServerOutlined,
  DashboardOutlined,
  FolderOpenOutlined,
  HomeOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  QuestionCircleOutlined,
  SearchOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Breadcrumb, Button, ColorPicker, Descriptions, Drawer, Dropdown, Flex, Grid, Input, Layout, Menu, Modal, Popover, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { api, loginUrl } from '../services/api';
import { useAuth } from './AuthContext';
import { PRIMARY_PRESETS, useThemeMode } from '../theme/ThemeContext';
import { NAV_GROUPS, visibleNavItems } from './navigation';
import CommandPalette from '../components/CommandPalette';
import AnnouncementsPanel from '../components/AnnouncementsPanel';
import HelpOnboarding from '../components/HelpOnboarding';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

/** 面包屑标签：模块级常量，避免每次渲染重建对象。 */
const PAGE_LABELS: Record<string, string> = {
  '/': '首页',
  '/tools': '科研工具',
  '/drawio': '科研工具 · 流程图',
  '/drawings': '我的图形',
  '/colors': '配色搭配',
  '/plot': '科研工具 · 绘图',
  '/literature': '科研文献搜索',
  '/lab': '实验室中心',
  '/search': '统一搜索',
  '/docparse': '文档解析',
  '/translation': '文本翻译',
  '/translate': '翻译中心',
  '/weather': '天气',
  '/workbench': '个人工作台',
  '/agent': 'Agent 与知识库',
  '/databases': '数据库速查',
  '/genomes': '科研工具 · 基因组',
  '/baserow': '多维表格',
  '/files': '文件共享',
  '/knowledge': '知识库',
  '/start': '起始页',
  '/bioinfo': '生信实训',
  '/snapotter': '文件工坊',
  '/network': '访问与诊断',
  '/help': '帮助中心',
  '/admin/status': '服务状态',
  '/admin/users': '用户和权限',
  '/admin/settings': '配置与日志',
  '/admin/backups': '备份与恢复',
};

/**
 * 顶栏搜索：受控输入 + 提交跳转。
 *
 * 旧实现把 Input.Search 直接内联在 render 体内，任何一次 keystroke 触发的
 * 重渲染都会重建整棵 Header 子树；这里独立成组件并做浅比较，输入过程中
 * Header 不再重渲染。
 */
const HeaderSearch = memo(function HeaderSearch({ onSearch }: { onSearch: (q: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <Input.Search
      allowClear
      value={value}
      maxLength={120}
      placeholder="搜索服务、命令、植物库或资料"
      aria-label="全站搜索"
      enterButton={<SearchOutlined />}
      onChange={(e) => setValue(e.target.value)}
      onSearch={(v) => {
        const q = v.trim();
        if (q) onSearch(q);
      }}
    />
  );
});

export default function AppLayout() {
  // 默认折叠，仅保留图标栏；鼠标悬浮时以浮层展开显示文字，不挤压内容
  const [collapsed, setCollapsed] = useState(true);
  const [siderHover, setSiderHover] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { me, isAdmin, loading } = useAuth();
  const { resolved, setMode, primary, setPrimary, resetPrimary } = useThemeMode();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.lg;

  // 全局 ⌘K / Ctrl+K 唤起命令面板；首页按钮通过事件触发
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdkOpen(true);
      }
    };
    const onEvent = () => setCmdkOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('d509:cmdk', onEvent);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('d509:cmdk', onEvent);
    };
  }, []);

  const menuItems = useMemo(() => {
    // 侧栏直接由 navigation.tsx 注册表生成，避免菜单、面包屑、命令面板各写一份。
    const entries = visibleNavItems(isAdmin).filter((it) => !it.noCommand);
    return NAV_GROUPS.filter((g) => !g.adminOnly || isAdmin).map((g) => ({
      key: g.key,
      type: 'group' as const,
      label: g.label,
      children: entries
        .filter((it) => it.group === g.key)
        .map((it) => ({ key: it.path, icon: it.icon, label: <Link to={it.path}>{it.label}</Link> })),
    }));
  }, [isAdmin]);

  const goSearch = useCallback(
    (q: string) => navigate(`/search?q=${encodeURIComponent(q)}`),
    [navigate],
  );

  const selectedKey = useMemo(() => {
    const path = location.pathname;
    if (path === '/') return '/';
    if (path.startsWith('/knowledge')) return '/agent';
    if (path.startsWith('/docparse')) return '/agent';
    if (path === '/tools') return '/tools';
    if (path.startsWith('/drawio') || path.startsWith('/drawings')) return '/tools';
    if (path.startsWith('/translation')) return '/translate';
    if (path === '/network') return '/help';
    if (path === '/plot' || path === '/genomes') return '/tools';
    if (path.startsWith('/admin/users')) return '/admin/users';
    if (path.startsWith('/admin/settings')) return '/admin/settings';
    if (path.startsWith('/admin/backups')) return '/admin/backups';
    if (path.startsWith('/admin')) return '/admin/status';
    return path;
  }, [location.pathname]);

  const breadcrumbItems = useMemo(
    () => [
      { title: <Link to="/">D509 工作台</Link> },
      { title: PAGE_LABELS[location.pathname] ?? location.pathname.replace('/', '') },
    ],
    [location.pathname],
  );

  const userMenu = {
    items: [
      ...(isMobile
        ? [
            { key: 'cmdk', icon: <ThunderboltOutlined />, label: '命令面板' },
            { key: 'start', icon: <HomeOutlined />, label: '起始页' },
            { key: 'theme', icon: <CloudServerOutlined />, label: resolved === 'dark' ? '切换浅色主题' : '切换深色主题' },
            { type: 'divider' as const },
          ]
        : []),
      { key: 'profile', icon: <UserOutlined />, label: '个人资料' },
      { key: 'files', icon: <FolderOpenOutlined />, label: <Link to="/files">我的文件</Link> },
      { key: 'kb', icon: <BookOutlined />, label: <Link to="/agent?mode=kb">知识库问答</Link> },
      { key: 'workbench', icon: <DashboardOutlined />, label: <Link to="/workbench">个人工作台</Link> },
      { key: 'help', icon: <QuestionCircleOutlined />, label: <Link to="/help">帮助中心</Link> },
      ...(isAdmin
        ? [{ key: 'settings', icon: <SettingOutlined />, label: <Link to="/admin/settings">系统设置</Link> }]
        : []),
      { type: 'divider' as const },
      { key: 'logout', icon: <LogoutOutlined />, label: '退出登录' },
    ],
    onClick: async ({ key }: { key: string }) => {
      if (key === 'profile') setProfileOpen(true);
      if (key === 'cmdk') setCmdkOpen(true);
      if (key === 'start') navigate('/start');
      if (key === 'help') navigate('/help');
      if (key === 'theme') setMode(resolved === 'dark' ? 'light' : 'dark');
      if (key === 'logout') {
        try {
          const res = await api.logout();
          window.location.href = res.logoutUrl || '/api/auth/logout-redirect';
        } catch {
          window.location.href = '/api/auth/logout-redirect';
        }
      }
    },
  };



  if (loading) {
    return (
      <Flex align="center" justify="center" style={{ minHeight: '60vh' }}>
        <Spin size="large" />
      </Flex>
    );
  }
  if (!me?.authenticated) {
    return <Navigate to="/login" replace />;
  }

  const menu = (
    <div style={{ padding: '10px 8px 4px' }}>
      <Menu
        mode="inline"
        theme={resolved === 'dark' ? 'dark' : 'light'}
        selectedKeys={[selectedKey]}
        items={menuItems}
        style={{ borderInlineEnd: 'none' }}
        onClick={() => isMobile && setMobileOpen(false)}
      />
    </div>
  );

  const mobileSider = (
    <Sider theme={resolved === 'dark' ? 'dark' : 'light'} width={232} collapsed={false} trigger={null} style={{ height: '100%', overflow: 'auto' }}>
      {menu}
    </Sider>
  );

  // 折叠时侧栏外壳只占 68px；悬浮展开的侧栏绝对定位覆盖在内容上，避免页面跳动
  const desktopSider = (
    <div
      className="d509-sider-shell"
      style={{ width: collapsed ? 68 : 232, flex: `0 0 ${collapsed ? 68 : 232}px` }}
      onMouseEnter={() => setSiderHover(true)}
      onMouseLeave={() => setSiderHover(false)}
    >
      <Sider
        theme={resolved === 'dark' ? 'dark' : 'light'}
        width={232}
        collapsedWidth={68}
        collapsed={collapsed && !siderHover}
        trigger={null}
        style={{
          borderRight: '1px solid var(--ant-color-border-secondary, #eef0f4)',
          position: 'absolute',
          insetInlineStart: 0,
          top: 0,
          height: '100%',
          overflow: 'auto',
          zIndex: 25,
          boxShadow: collapsed && siderHover ? 'var(--d509-shadow-md)' : 'none',
        }}
      >
        {menu}
      </Sider>
    </div>
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {/* 键盘用户可直接跳过 30+ 项导航 */}
      <a className="d509-skip-link" href="#d509-main">
        跳到主要内容
      </a>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: 'var(--ant-color-bg-container, #fff)',
          borderBottom: '1px solid var(--ant-color-border-secondary, #eef0f4)',
          position: 'sticky',
          top: 0,
          zIndex: 20,
          paddingInline: 16,
        }}
      >
        {isMobile ? (
          <Button type="text" icon={<MenuUnfoldOutlined />} onClick={() => setMobileOpen(true)} />
        ) : (
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
          />
        )}

        <Link to="/" className="d509-brand" aria-label="D509 工作台首页">
          <img className="d509-logo d509-logo-img" src="/logo.svg" alt="" width={32} height={32} decoding="async" />
          {!isMobile && (
            <div className="d509-brand-text">
              <div className="d509-brand-name">
                D509 工作台<span className="d509-brand-dot" aria-hidden="true" />
              </div>
              <div className="d509-brand-sub">实验室一体化服务</div>
            </div>
          )}
        </Link>

        {!isMobile && (
          <Breadcrumb items={breadcrumbItems} style={{ marginInlineStart: 8, minWidth: 180 }} />
        )}

        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          {!isMobile && (
            <Flex gap={8} align="center" style={{ width: '100%', maxWidth: 460 }}>
              <div style={{ flex: 1 }}>
                <HeaderSearch onSearch={goSearch} />
              </div>
              <Tooltip title="命令面板（⌘K）">
                <Button icon={<ThunderboltOutlined />} onClick={() => setCmdkOpen(true)} />
              </Tooltip>
            </Flex>
          )}
        </div>

        <Space size={4}>
          {!isMobile && (
            <>
              <Tooltip title="命令面板">
                <Button type="text" icon={<ThunderboltOutlined />} onClick={() => setCmdkOpen(true)} />
              </Tooltip>
              <Tooltip title="浏览器主页">
                <Button type="text" icon={<HomeOutlined />} onClick={() => navigate('/start')} />
              </Tooltip>
              <Tooltip title="帮助中心">
                <Button type="text" icon={<QuestionCircleOutlined />} onClick={() => navigate('/help')} />
              </Tooltip>
            </>
          )}
          <Tooltip title="主题色（调色盘）">
            <span style={{ display: 'inline-flex', alignItems: 'center' }}>
              <ColorPicker
                value={primary}
                size="small"
                disabledAlpha
                showText={false}
                presets={PRIMARY_PRESETS}
                onChangeComplete={(c) => setPrimary(c.toHexString())}
              />
            </span>
          </Tooltip>
          {!isMobile && (
            <Tooltip title="恢复默认主题色">
              <Button type="text" size="small" onClick={resetPrimary} style={{ paddingInline: 4 }}>
                <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 5, background: 'var(--d509-primary, #2B5CE6)' }} />
              </Button>
            </Tooltip>
          )}
          {!isMobile && (
            <Tooltip title={resolved === 'dark' ? '切换浅色主题' : '切换深色主题'}>
              <Button
                type="text"
                icon={resolved === 'dark' ? <DashboardOutlined /> : <CloudServerOutlined />}
                onClick={() => setMode(resolved === 'dark' ? 'light' : 'dark')}
              />
            </Tooltip>
          )}
          <Popover
            content={<AnnouncementsPanel />}
            trigger="click"
            placement="bottomRight"
            arrow={false}
          >
            <Tooltip title="公告">
              <Button type="text" icon={<BellOutlined />} />
            </Tooltip>
          </Popover>
          {me?.authenticated ? (
            <Dropdown menu={userMenu} placement="bottomRight">
              <Space style={{ cursor: 'pointer' }}>
                <Avatar size={30} icon={<UserOutlined />} style={{ background: '#2B5CE6' }} />
                {!isMobile && (
                  <Text strong style={{ fontSize: 13 }}>
                    {me.name || me.email}
                  </Text>
                )}
              </Space>
            </Dropdown>
          ) : (
            <Button type="primary" href={loginUrl}>
              登录
            </Button>
          )}
        </Space>
      </Header>

      <Layout>
        {isMobile ? (
          <Drawer
            open={mobileOpen}
            onClose={() => setMobileOpen(false)}
            placement="left"
            size={240}
            styles={{ body: { padding: 0 } }}
          >
            {mobileSider}
          </Drawer>
        ) : (
          desktopSider
        )}

        <Content id="d509-main" style={{ padding: isMobile ? 16 : 24, overflow: 'auto' }}>
          <Outlet />
        </Content>
      </Layout>

      <Modal
        open={profileOpen}
        onCancel={() => setProfileOpen(false)}
        onOk={() => setProfileOpen(false)}
        okText="关闭"
        cancelButtonProps={{ style: { display: 'none' }} }
        title="个人资料"
      >
        <Descriptions column={1} size="small" style={{ marginTop: 12 }}>
          <Descriptions.Item label="姓名">{me?.name || '—'}</Descriptions.Item>
          <Descriptions.Item label="邮箱">{me?.email || '—'}</Descriptions.Item>
          <Descriptions.Item label="账号标识">{me?.id || '—'}</Descriptions.Item>
          <Descriptions.Item label="身份">
            <Space size={4} wrap>
              {me?.isAdmin ? <Tag color="purple">管理员</Tag> : null}
              {!me?.isAdmin && me?.isTeacher ? <Tag color="blue">教师</Tag> : null}
              {!me?.isAdmin && !me?.isTeacher ? <Tag>学生</Tag> : null}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="角色">
            <Space size={4} wrap>
              {(me?.roles ?? []).length
                ? (me?.roles ?? []).map((r) => <Tag key={r}>{r}</Tag>)
                : '—'}
            </Space>
          </Descriptions.Item>
        </Descriptions>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          账号、密码与用户组归属由统一身份源管理；如需调整请联系管理员。
        </Typography.Text>
      </Modal>

      <CommandPalette open={cmdkOpen} onClose={() => setCmdkOpen(false)} />
      <HelpOnboarding />
    </Layout>
  );
}
