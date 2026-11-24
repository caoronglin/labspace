import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BellOutlined,
  BookOutlined,
  CloudServerOutlined,
  CompassOutlined,
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
import { navBreadcrumb, resolveNavPath, sidebarSections, subKeyOfPath } from './navigation';
import CommandPalette from '../components/CommandPalette';
import AnnouncementsPanel from '../components/AnnouncementsPanel';
import HelpOnboarding from '../components/HelpOnboarding';
import OnboardingTour from '../components/OnboardingTour';
import { requestTour } from '../components/onboardingState';
import ForcePasswordChange from '../components/ForcePasswordChange';


const { Header, Sider, Content } = Layout;
const { Text } = Typography;


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
  const { me, isAdmin, isTeacher, loading, mustChangePassword, refetch: refetchMe } = useAuth();
  const { resolved, setMode, primary, setPrimary, resetPrimary } = useThemeMode();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.lg;
  /** 实际呈现形态：桌面折叠且未悬浮时收起；移动端 Drawer 始终按展开菜单处理。 */
  const siderCollapsed = !isMobile && collapsed && !siderHover;

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

  // 移动端子菜单跳转后统一关闭抽屉；不能只依赖 Menu.onClick，
  // 链接点击在部分 AntD 嵌套场景下不会冒泡到 Menu。
  useEffect(() => {
    if (isMobile) setMobileOpen(false);
  }, [isMobile, location.pathname]);

  const menuItems = useMemo(() => {
    // 侧栏直接由 navigation.tsx 注册表生成，避免菜单、面包屑、命令面板各写一份。
    // 高频页面平铺，低频页面进子菜单：折叠态只留十几个入口，一眼能数完。
    return sidebarSections(isAdmin, isTeacher).map((group) => ({
      key: group.key,
      type: 'group' as const,
      label: group.label,
      children: (group.children ?? []).map((entry) =>
        entry.children
          ? {
              key: entry.key,
              icon: entry.icon,
              label: entry.label,
              children: entry.children.map((child) => ({
                key: child.key,
                icon: child.icon,
                label: (
                  <Link to={child.key} onClick={() => isMobile && setMobileOpen(false)}>
                    {child.label}
                  </Link>
                ),
              })),
            }
          : {
              key: entry.key,
              icon: entry.icon,
              label: (
                <Link to={entry.key} onClick={() => isMobile && setMobileOpen(false)}>
                  {entry.label}
                </Link>
              ),
            },
      ),
    }));
  }, [isAdmin, isTeacher, isMobile]);

  const goSearch = useCallback(
    (q: string) => navigate(`/search?q=${encodeURIComponent(q)}`),
    [navigate],
  );

  // 高亮项由导航注册表派生：手工映射一份会与注册表漂移（曾经把
  // /docparse 指向 /agent、/drawings 指向 /tools，结果进页面高亮的是别的菜单项）。
  const selectedKey = useMemo(() => resolveNavPath(location.pathname), [location.pathname]);

  // 子菜单默认收起；当前页在某个子菜单里时自动展开它，
  // 否则「课题资料」这种藏得深的页面在侧栏里看不到自己被选中了。
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  useEffect(() => {
    const sub = subKeyOfPath(location.pathname);
    if (!sub) return;
    setOpenKeys((prev) => (prev.includes(sub) ? prev : [...prev, sub]));
  }, [location.pathname]);

  // 面包屑同样取自注册表；多级路径（/admin/users）拼出可读层级。
  const breadcrumbItems = useMemo(
    () => [
      { title: <Link to="/">D509 工作台</Link> },
      ...navBreadcrumb(location.pathname).map((c) =>
        c.path === location.pathname ? { title: c.label } : { title: <Link to={c.path}>{c.label}</Link> },
      ),
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
      { key: 'kb', icon: <BookOutlined />, label: <Link to="/agent?mode=kb">知识与记忆</Link> },
      { key: 'workbench', icon: <DashboardOutlined />, label: <Link to="/workbench">个人工作台</Link> },
      { key: 'help', icon: <QuestionCircleOutlined />, label: <Link to="/help">帮助中心</Link> },
      // 引导的「重看」入口：移动端顶栏按钮被隐藏，头像菜单是唯一稳定入口
      { key: 'tour', icon: <CompassOutlined />, label: '新手引导' },
      ...(isAdmin
        ? [{ key: 'settings', icon: <SettingOutlined />, label: <Link to="/admin/settings">系统设置</Link> }]
        : []),
      { type: 'divider' as const },
      { key: 'logout', icon: <LogoutOutlined />, label: '退出登录' },
    ],
    onClick: async ({ key }: { key: string }) => {
      if (key === 'profile') setProfileOpen(true);
      if (key === 'tour') requestTour();
      if (key === 'cmdk') setCmdkOpen(true);
      if (key === 'start') navigate('/start');
      if (key === 'help') navigate('/help');
      if (key === 'theme') setMode(resolved === 'dark' ? 'light' : 'dark');
      if (key === 'logout') {
        // Casdoor 已下线：登出只清理门户会话，不再信任服务端返回的外部 URL。
        // POST 成功回本地登录页；若 CSRF/网络异常，走兼容 GET 清 Cookie 后回登录页。
        let target = '/login';
        try {
          await api.logout();
        } catch {
          target = '/api/auth/logout-redirect';
        }
        window.location.replace(target);
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
        // 必须始终「受控」：之前传 siderCollapsed ? undefined : openKeys，
        // 折叠↔悬浮展开之间在「非受控/受控」来回切换，AntD 会在切到
        // undefined 时丢掉内部展开状态——用户展开子菜单、鼠标离开再回来，
        // 子菜单就莫名其妙全收起了。传空数组而非 undefined 即可始终受控，
        // 折叠态没有可见子菜单（inlineCollapsed 自动转成悬浮弹层），
        // openKeys 的值不会造成视觉异常，回来时状态还在。
        openKeys={openKeys}
        // 桌面折叠态的子菜单弹层挂到侧栏外壳内：鼠标从图标移到弹层时
        // 不会触发外壳 mouseleave 并把 Sider 重新折叠，子弹菜单才点得进去。
        getPopupContainer={(node) =>
          (node.closest('.d509-sider-shell') as HTMLElement | null) ?? document.body
        }
        onOpenChange={(keys) => {
          // 折叠态（鼠标必在侧栏外，用户不可能在点子菜单）期间，AntD 在
          // inline ↔ vertical 模式切换时会回灌空数组甚至部分 key 的快照——
          // 都不是用户意图。一律忽略，openKeys 只信展开态下的真实操作。
          if (siderCollapsed) return;
          setOpenKeys(keys as string[]);
        }}
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
      data-tour="sider"
      style={{ width: collapsed ? 68 : 232, flex: `0 0 ${collapsed ? 68 : 232}px` }}
      onMouseEnter={() => setSiderHover(true)}
      onMouseLeave={() => setSiderHover(false)}
    >
      <Sider
        theme={resolved === 'dark' ? 'dark' : 'light'}
        width={232}
        collapsedWidth={68}
        collapsed={siderCollapsed}
        trigger={null}
        style={{
          borderRight: '1px solid var(--ant-color-border-secondary, #eef0f4)',
          position: 'absolute',
          insetInlineStart: 0,
          top: 0,
          height: '100%',
          overflow: 'auto',
          // 低于 header(20)：悬浮展开时阴影不再染脏 header 底带；
          // 高于内容区（无定位/低 z-index），浮层仍能盖住页面内容。
          zIndex: 15,
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
          <Button
            type="text"
            icon={<MenuUnfoldOutlined />}
            aria-label="打开导航菜单"
            onClick={() => setMobileOpen(true)}
          />
        ) : (
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
            onClick={() => setCollapsed(!collapsed)}
          />
        )}

        {/* 页头只保留品牌图形：文字块（工作台名 + 副标题）在宽屏占用三段高度，
            使左侧导航与搜索框基线上下错位；页面标题已由 Breadcrumb 承担。 */}
        <Link to="/" className="d509-brand" aria-label="D509 工作台首页">
          <img className="d509-logo d509-logo-img" src="/logo.svg" alt="" width={32} height={32} decoding="async" />
        </Link>

        {!isMobile && (
          <Breadcrumb items={breadcrumbItems} style={{ marginInlineStart: 8, minWidth: 180 }} />
        )}

        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          {!isMobile && (
            <Flex gap={8} align="center" style={{ width: '100%', maxWidth: 460 }}>
              <div style={{ flex: 1 }} data-tour="search">
                <HeaderSearch onSearch={goSearch} />
              </div>
              <Tooltip title="命令面板（⌘K）">
                <Button icon={<ThunderboltOutlined />} data-tour="cmdk" onClick={() => setCmdkOpen(true)} />
              </Tooltip>
            </Flex>
          )}
        </div>

        <Space size={4}>
          {!isMobile && (
            <>
              <Tooltip title="命令面板">
                <Button type="text" icon={<ThunderboltOutlined />} data-tour="cmdk" onClick={() => setCmdkOpen(true)} />
              </Tooltip>
              <Tooltip title="浏览器主页">
                <Button type="text" icon={<HomeOutlined />} onClick={() => navigate('/start')} />
              </Tooltip>
              <Tooltip title="帮助中心">
                <Button
                  type="text"
                  icon={<QuestionCircleOutlined />}
                  data-tour="help"
                  onClick={() => navigate('/help')}
                />
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
            <div
              onClickCapture={(event) => {
                if ((event.target as HTMLElement).closest('a')) setMobileOpen(false);
              }}
            >
              {mobileSider}
            </div>
          </Drawer>
        ) : (
          desktopSider
        )}

        <Content id="d509-main" style={{ padding: isMobile ? 16 : 24, overflow: 'auto' }}>
          <Outlet />
        </Content>
      </Layout>

      {/* 初始口令未改：全站不可关闭的改密框（服务端同时用 428 挡住其它接口） */}
      <ForcePasswordChange mustChange={mustChangePassword} onChanged={refetchMe} />

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
      {/* 强制改密期间不再弹新手引导：两个弹窗叠在一起只会挡住改密框 */}
      {mustChangePassword ? null : <HelpOnboarding />}
      {mustChangePassword ? null : <OnboardingTour />}
    </Layout>
  );
}
