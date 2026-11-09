/**
 * 导航注册表 —— 站点导航的单一数据源
 *
 * 之前同一个页面的信息在四个地方各写一份：侧栏菜单、面包屑文案、命令面板分组、
 * 首页快捷入口。加一个页面要改四处，漏一处就出现「菜单里有、面包屑显示 /xxx」。
 *
 * 这里只描述「页面是什么」，至于长什么样交给各个消费方：
 * - 侧栏：AppLayout 按 group 渲染
 * - 面包屑：直接查 path
 * - 命令面板：每个页面都是一条可直接跳转的命令（权重高于语料命中）
 *
 * 新增页面 = 在 NAV_ITEMS 里加一条 + 在 routes/index.tsx 里加一条路由。
 */
import type { ReactNode } from 'react';
import {
  BarChartOutlined,
  BgColorsOutlined,
  BookOutlined,
  CloudOutlined,
  CodeOutlined,
  ConsoleSqlOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FilePdfOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  HomeOutlined,
  PartitionOutlined,
  QuestionCircleOutlined,
  RobotOutlined,
  TableOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  TranslationOutlined,
  CloudServerOutlined,
} from '@ant-design/icons';

export type NavGroupKey = 'work' | 'research' | 'learn' | 'tools' | 'admin';

export interface NavItem {
  /** 路由路径，同时作为唯一标识 */
  path: string;
  label: string;
  /** 侧栏与命令面板共用的图标 */
  icon: ReactNode;
  group: NavGroupKey;
  /** 命令面板里的补充说明 */
  hint?: string;
  /** 检索用的额外关键词（中文 + 英文，覆盖用户会打的各种叫法） */
  keywords?: string[];
  /** 仅管理员可见 */
  adminOnly?: boolean;
  /** 不进命令面板（登录页之类的过场路由） */
  noCommand?: boolean;
  /** 面包屑里隐藏（比如重定向路径） */
  hideInBreadcrumb?: boolean;
  /** 已并入其他入口：保留路径用于面包屑与直达，不再出现在侧栏/命令面板 */
  hidden?: boolean;
}

export interface NavGroup {
  key: NavGroupKey;
  label: string;
  /** 侧栏中展示的位置：管理组排在最后并单独分组 */
  adminOnly?: boolean;
}

export const NAV_GROUPS: NavGroup[] = [
  { key: 'work', label: '工作台' },
  { key: 'research', label: '科研工作' },
  { key: 'learn', label: '学习资源' },
  { key: 'tools', label: '实用工具' },
  { key: 'admin', label: '系统管理', adminOnly: true },
];

export const NAV_ITEMS: NavItem[] = [
  // ---------------------------------------------------------------- 工作台
  { path: '/', label: '首页', icon: <HomeOutlined />, group: 'work', keywords: ['home', 'index', '首页'] },
  {
    path: '/workbench',
    label: '个人工作台',
    icon: <DashboardOutlined />,
    group: 'work',
    hint: '记录、聚焦、推进',
    keywords: ['workbench', 'todo', '待办', '计划', '任务', 'eln', '实验记录', '实验'],
  },
  {
    path: '/latex',
    label: 'LaTeX 写作',
    icon: <FileTextOutlined />,
    group: 'work',
    hint: '选刊 · 撰写 · 编译 · 投稿',
    keywords: ['latex', 'tex', 'xelatex', 'paper', '论文', '写作', '投稿', '期刊', 'manuscript'],
  },
  {
    path: '/agent',
    label: 'Agent 与知识库',
    icon: <RobotOutlined />,
    group: 'work',
    hint: '对话 · 知识库 · 技能',
    keywords: ['agent', 'ai', 'chat', '助手', '对话', '知识库', 'kb', 'rag'],
  },
  {
    path: '/knowledge',
    label: '知识库',
    icon: <BookOutlined />,
    group: 'work',
    hint: '已并入 Agent 与知识库',
    keywords: ['knowledge', 'kb', 'rag', '知识库'],
    hidden: true,
  },

  // ---------------------------------------------------------------- 科研工作
  {
    path: '/files',
    label: '文件共享',
    icon: <FolderOpenOutlined />,
    group: 'research',
    hint: '个人/公共文件 · 在线预览',
    keywords: ['files', 'file', '文件', '网盘', '共享', '质粒', 'genome', '基因组'],
  },
  {
    path: '/tools',
    label: '科研工具',
    icon: <ToolOutlined />,
    group: 'research',
    hint: '流程图 · 绘图 · 基因组',
    keywords: ['tools', 'drawio', 'diagram', 'plot', 'genomes', '流程图', '绘图', '基因组', '科研工具'],
  },
  {
    path: '/drawio',
    label: '流程图设计',
    icon: <PartitionOutlined />,
    group: 'research',
    hint: '已并入科研工具',
    keywords: ['drawio', 'diagram', '流程图', '绘图', 'drawings', '图形', '草稿'],
    hidden: true,
  },
  {
    path: '/drawings',
    label: '我的图形',
    icon: <FileTextOutlined />,
    group: 'research',
    keywords: ['drawings', '图形', '草稿'],
    hidden: true,
  },
  {
    path: '/plot',
    label: '绘图工作台',
    icon: <BarChartOutlined />,
    group: 'research',
    hint: '已并入科研工具',
    keywords: ['plot', 'chart', '绘图', '画图', 'seaborn', 'antv', 'gsea', 'venn', 'circos', '火山图', '热图'],
    hidden: true,
  },
  {
    path: '/colors',
    label: '配色搭配',
    icon: <BgColorsOutlined />,
    group: 'research',
    hint: '科研配色 / 取色匹配',
    keywords: ['colors', 'palette', '配色', '色板', '调色', 'ggsci', 'nature', 'science'],
  },
  {
    path: '/docparse',
    label: '文档解析',
    icon: <FileSearchOutlined />,
    group: 'research',
    hint: 'PDF → Markdown',
    keywords: ['docling', 'docparse', 'pdf', '解析'],
    hidden: true,
  },
  {
    path: '/translate',
    label: '翻译中心',
    icon: <FilePdfOutlined />,
    group: 'research',
    hint: '论文全文 · 段落文本',
    keywords: ['translate', 'pdf', '论文', '翻译', 'pdf2zh', 'text', '段落', '摘要'],
  },
  {
    path: '/translation',
    label: '文本翻译',
    icon: <TranslationOutlined />,
    group: 'research',
    hint: '段落 / 摘要',
    keywords: ['translation', 'text', '翻译', '润色'],
    hidden: true,
  },
  {
    path: '/literature',
    label: '科研文献检索',
    icon: <BookOutlined />,
    group: 'research',
    keywords: ['literature', 'pubmed', '文献', '检索'],
  },
  {
    path: '/lab',
    label: '实验室中心',
    icon: <ExperimentOutlined />,
    group: 'research',
    keywords: ['lab', 'eln', 'inventory', 'pipeline', 'booking', '实验', '库存', '流水线', '预约'],
  },
  {
    path: '/databases',
    label: '数据库速查',
    icon: <DatabaseOutlined />,
    group: 'research',
    hint: '生物数据库目录',
    keywords: ['databases', 'plant', '数据库', '植物库'],
  },
  {
    path: '/genomes',
    label: '公共基因组',
    icon: <ExperimentOutlined />,
    group: 'research',
    hint: '已并入科研工具',
    keywords: ['genomes', 'genome', 'jbrowse', 'fasta', '基因组', '序列', 'orf', 'gc', 'rust-bio'],
    hidden: true,
  },

  // ---------------------------------------------------------------- 学习资源
  {
    path: '/commands',
    label: 'Linux 命令速查',
    icon: <ConsoleSqlOutlined />,
    group: 'learn',
    keywords: ['command', 'linux', 'shell', '命令'],
  },
  {
    path: '/bioinfo',
    label: '生信实验实训',
    icon: <CodeOutlined />,
    group: 'learn',
    hint: '课程与终端工作区',
    keywords: ['bioinfo', '生信', '实训', '课程', '终端', 'terminal'],
  },
  {
    path: '/weather',
    label: '天气',
    icon: <CloudOutlined />,
    group: 'learn',
    keywords: ['weather', '天气'],
  },
  {
    path: '/network',
    label: '访问与诊断',
    icon: <GlobalOutlined />,
    group: 'learn',
    hint: '网络别名与连通性',
    keywords: ['network', 'dns', '网络', '诊断'],
    hidden: true,
  },
  {
    path: '/help',
    label: '帮助中心',
    icon: <QuestionCircleOutlined />,
    group: 'learn',
    hint: '上手 / FAQ / 诊断',
    keywords: ['help', 'faq', '帮助', '文档', '更新日志', 'release'],
  },

  // ---------------------------------------------------------------- 实用工具
  {
    path: '/baserow',
    label: '多维表格',
    icon: <TableOutlined />,
    group: 'tools',
    hint: '在线多维表 / 数据收集',
    keywords: ['baserow', 'table', 'sheet', '多维表格', '表格', '数据', '记录'],
  },
  {
    path: '/snapotter',
    label: '文件工坊',
    icon: <ThunderboltOutlined />,
    group: 'tools',
    hint: '文件与媒体处理',
    keywords: ['snapotter', 'media', '转换', '文件'],
  },
  {
    path: '/search',
    label: '统一搜索',
    icon: <GlobalOutlined />,
    group: 'tools',
    keywords: ['search', '搜索'],
  },
  {
    path: '/start',
    label: '起始页',
    icon: <FolderOpenOutlined />,
    group: 'tools',
    hint: '浏览器主页',
    keywords: ['start', 'home', '起始页'],
    noCommand: true,
  },

  // ---------------------------------------------------------------- 系统管理
  {
    path: '/admin/status',
    label: '服务状态',
    icon: <CloudServerOutlined />,
    group: 'admin',
    adminOnly: true,
    keywords: ['admin', 'status', 'health', '状态'],
  },
  {
    path: '/admin/users',
    label: '用户和权限',
    icon: <RobotOutlined />,
    group: 'admin',
    adminOnly: true,
    keywords: ['admin', 'users', '用户', '权限'],
  },
  {
    path: '/admin/settings',
    label: '配置与日志',
    icon: <ToolOutlined />,
    group: 'admin',
    adminOnly: true,
    keywords: ['admin', 'settings', 'logs', '配置', '日志'],
  },
  {
    path: '/admin/backups',
    label: '备份与恢复',
    icon: <DatabaseOutlined />,
    group: 'admin',
    adminOnly: true,
    keywords: ['admin', 'backup', 'restic', '备份', '恢复'],
  },
];

const NAV_BY_PATH = new Map(NAV_ITEMS.map((it) => [it.path, it]));

/** 子路径 → 归属路径：/admin/users 归自身 */
export function resolveNavPath(pathname: string): string {
  if (pathname === '/' || pathname === '') return '/';
  if (NAV_BY_PATH.has(pathname)) return pathname;
  if (pathname.startsWith('/admin')) {
    // /admin 本身没有页面，落到第一个管理页
    if (pathname === '/admin' || pathname === '/admin/') return '/admin/status';
    return pathname;
  }
  const hit = NAV_ITEMS.find((it) => it.path !== '/' && pathname.startsWith(`${it.path}/`));
  return hit ? hit.path : pathname;
}

export function navLabel(pathname: string): string {
  const path = resolveNavPath(pathname);
  return NAV_BY_PATH.get(path)?.label ?? path.replace(/^\//, '');
}

/** 面包屑：一段路径可能是多级（/admin/users），尽量拼出可读层级 */
export function navBreadcrumb(pathname: string): { label: string; path: string }[] {
  const path = resolveNavPath(pathname);
  const base = NAV_BY_PATH.get(path);
  const crumbs: { label: string; path: string }[] = [];
  if (base && !base.hideInBreadcrumb) crumbs.push({ label: base.label, path: base.path });
  if (path !== pathname && pathname.length > path.length) {
    // 详情页：挂一段「详情」，不猜具体名称，避免显得像 bug
    crumbs.push({ label: '详情', path: pathname });
  }
  return crumbs;
}

export function visibleNavItems(isAdmin: boolean): NavItem[] {
  return NAV_ITEMS.filter((it) => !it.hidden && (!it.adminOnly || isAdmin));
}

/** 命令面板用的子集：管理员页面与过场路由都不进面板 */
export function commandableNavItems(isAdmin: boolean): NavItem[] {
  return visibleNavItems(isAdmin).filter((it) => !it.noCommand);
}

/** 命令面板用的关键词命中打分（0 表示不命中） */
export function matchNav(item: NavItem, q: string): number {
  const needle = q.trim().toLowerCase();
  if (!needle) return 0;
  const label = item.label.toLowerCase();
  if (label === needle) return 100;
  if (label.startsWith(needle)) return 80;
  if (label.includes(needle)) return 60;
  if (item.path.toLowerCase().includes(needle)) return 45;
  if ((item.keywords ?? []).some((k) => k.toLowerCase().includes(needle))) return 35;
  if ((item.hint ?? '').toLowerCase().includes(needle)) return 20;
  return 0;
}
