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
  ProfileOutlined,
  QuestionCircleOutlined,
  ReadOutlined,
  RobotOutlined,
  ScheduleOutlined,
  ShareAltOutlined,
  TableOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  TranslationOutlined,
  CloudServerOutlined,
} from '@ant-design/icons';

export type NavGroupKey = 'work' | 'research' | 'learn' | 'tools' | 'admin';

/** 二级入口：折叠态下侧栏只显示这些图标，点击展开子菜单。 */
export interface NavSub {
  key: string;
  label: string;
  icon: ReactNode;
}

export interface NavItem {
  /** 路由路径，同时作为唯一标识 */
  path: string;
  label: string;
  /** 侧栏与命令面板共用的图标 */
  icon: ReactNode;
  group: NavGroupKey;
  /** 二级入口：同一 group 内 sub 相同的条目归到一个子菜单 */
  sub?: string;
  /** 命令面板里的补充说明 */
  hint?: string;
  /** 检索用的额外关键词（中文 + 英文，覆盖用户会打的各种叫法） */
  keywords?: string[];
  /** 仅管理员可见 */
  adminOnly?: boolean;
  /** 仅教师/管理员可见（学生看不到；直接访问路径仍会被后端 ACL 拒绝） */
  teacherOnly?: boolean;
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
  { key: 'work', label: '工作' },
  { key: 'research', label: '科研' },
  { key: 'admin', label: '系统', adminOnly: true },
];

/**
 * 二级入口注册表。
 *
 * 为什么要二级：种子台账、课题资料、组会汇报、多维表格…… 科研类页面有十几个，
 * 平铺在折叠态侧栏里就是 20+ 个没字的小图标，越用越找不到东西。
 * 现在折叠态只留「工作台 / 助手 / 文件 / 文献」这几个高频入口，
 * 其余按用途收进子菜单（悬浮即展开），入口一眼能数完。
 */
export const NAV_SUBS: Record<string, NavSub> = {
  data: { key: 'data', label: '文件与数据', icon: <DatabaseOutlined /> },
  writing: { key: 'writing', label: '分析与写作', icon: <FileTextOutlined /> },
  // 学习资源 + 小工具合并：两者都是"偶尔用一次"的辅助入口，
  // 拆成两个子菜单只会让侧栏更长得滚。
  more: { key: 'more', label: '学习与小工具', icon: <ToolOutlined /> },
  admin: { key: 'admin', label: '后台管理', icon: <CloudServerOutlined /> },
};

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
    group: 'research',
    sub: 'writing',
    hint: '选刊 · 撰写 · 编译 · 投稿',
    keywords: ['latex', 'tex', 'xelatex', 'paper', '论文', '写作', '投稿', '期刊', 'manuscript'],
  },
  {
    path: '/agent',
    label: 'Agent 个人助手',
    icon: <RobotOutlined />,
    group: 'work',
    hint: '对话 · 知识库 · 能力中心',
    keywords: ['agent', 'ai', 'chat', '助手', '对话', '知识库', 'kb', 'rag',
      'agentscope', '能力中心', 'IM', '渠道', '定时', 'SOP', '工作区', 'MCP', '技能'],
  },
  {
    path: '/knowledge',
    label: '知识库',
    icon: <BookOutlined />,
    group: 'work',
    keywords: ['knowledge', 'kb', 'rag', '知识库'],
    hidden: true,
  },

  // ---------------------------------------------------------------- 科研工作
  {
    path: '/files',
    label: '文件存储',
    icon: <FolderOpenOutlined />,
    group: 'research',
    hint: '个人/公共文件 · 在线预览',
    keywords: ['files', 'file', '文件', '网盘', '共享', '质粒', 'genome', '基因组'],
  },
  {
    path: '/seeds',
    label: '种子管理',
    icon: <ExperimentOutlined />,
    group: 'research',
    sub: 'data',
    hint: '种子入库 · 出库 · 存放 · 备份台账',
    keywords: ['seed', 'seeds', '种子', '种质', '入库', '出库', '库存', '台账', 'seed store'],
  },
  {
    path: '/shared',
    label: '组员共享',
    icon: <ShareAltOutlined />,
    group: 'research',
    hidden: true,
    hint: '已并入账号管理',
    keywords: ['shared', '组员', '共享文件', '共享', '组员共享', '学号', '目录'],
  },
  {
    path: '/research',
    label: '课题资料',
    icon: <ProfileOutlined />,
    group: 'research',
    teacherOnly: true,
    sub: 'data',
    hint: '个人资料目录 · 进组时间-姓名',
    keywords: ['research', '课题', '资料', '档案', '目录', '文件夹'],
  },
  {
    path: '/meetings',
    label: '组会汇报',
    icon: <ScheduleOutlined />,
    group: 'research',
    teacherOnly: true,
    sub: 'data',
    hint: '按周归档 · 逐周授权',
    keywords: ['meeting', 'meetings', '组会', '汇报', '周报', '周目录', 'presentation'],
  },
  {
    path: '/lab',
    label: '多维表格空间',
    icon: <TableOutlined />,
    group: 'research',
    sub: 'data',
    hint: '多维表格 · 数据收集 · 库存台账',
    keywords: ['lab', 'table', 'sheet', '多维表格', '表格', '数据', '库存', 'inventory', 'baserow'],
  },
  {
    path: '/databases',
    label: '数据库速查',
    icon: <DatabaseOutlined />,
    group: 'research',
    sub: 'data',
    hint: '生物数据库目录',
    keywords: ['databases', 'plant', '数据库', '植物库'],
  },
  {
    path: '/tools',
    label: '科研工具',
    icon: <ToolOutlined />,
    group: 'research',
    sub: 'writing',
    hint: '流程图 · 绘图 · 基因组',
    keywords: ['tools', 'drawio', 'diagram', 'plot', 'genomes', '流程图', '绘图', '基因组', '科研工具'],
  },
  {
    path: '/drawio',
    label: '流程图设计',
    icon: <PartitionOutlined />,
    group: 'research',
    keywords: ['drawio', 'diagram', '流程图', '绘图', 'drawings', '图形', '草稿'],
    hidden: true,
  },
  {
    path: '/drawings',
    label: '我的图形',
    icon: <FileTextOutlined />,
    group: 'research',
    sub: 'writing',
    hint: '流程图草稿与历史',
    keywords: ['drawings', '图形', '草稿'],
  },
  {
    path: '/plot',
    label: '绘图工作台',
    icon: <BarChartOutlined />,
    group: 'research',
    keywords: ['plot', 'chart', '绘图', '画图', 'seaborn', 'antv', 'gsea', 'venn', 'circos', '火山图', '热图'],
    hidden: true,
  },
  {
    path: '/colors',
    label: '配色搭配',
    icon: <BgColorsOutlined />,
    group: 'research',
    hint: '科研配色 / 取色匹配',
    hidden: true,
    keywords: ['colors', 'palette', '配色', '色板', '调色', 'ggsci', 'nature', 'science'],
  },
  {
    path: '/docparse',
    label: '文档解析',
    icon: <FileSearchOutlined />,
    group: 'research',
    sub: 'writing',
    hint: 'PDF → Markdown',
    keywords: ['docling', 'docparse', 'pdf', '解析'],
  },
  {
    path: '/translate',
    label: '翻译中心',
    icon: <FilePdfOutlined />,
    group: 'research',
    sub: 'writing',
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
    hint: '统一检索 · 每日论文 · 引用',
    keywords: ['literature', 'pubmed', '文献', '检索', 'openalex', 'arxiv', 'crossref'],
  },
  {
    path: '/ssh',
    label: '内网主机台',
    icon: <CloudServerOutlined />,
    group: 'research',
    hint: '浏览器连 HPC 与桌面',
    keywords: ['ssh', '终端', 'HPC', '主机', '远程', 'webssh'],
  },
  {
    path: '/pdf',
    label: 'PDF 工具箱',
    icon: <FilePdfOutlined />,
    group: 'research',
    hint: '合并 · 拆分 · 压缩 · 旋转 · 删页',
    keywords: ['pdf', '合并', '拆分', '压缩', '水印', 'stirling', '论文'],
  },
  {
    path: '/papers',
    label: '每日论文',
    icon: <ReadOutlined />,
    group: 'research',
    hint: '按天抓取 OpenAlex / arXiv 文献',
    hidden: true,
    keywords: ['daily', '论文', 'arxiv', 'openalex'],
  },
  {
    path: '/genomes',
    label: '公共基因组',
    icon: <ExperimentOutlined />,
    group: 'research',
    keywords: ['genomes', 'genome', 'jbrowse', 'fasta', '基因组', '序列', 'orf', 'gc', 'rust-bio'],
    hidden: true,
  },

  // ---------------------------------------------------------------- 学习资源
  {
    path: '/commands',
    label: 'Linux 命令速查',
    icon: <ConsoleSqlOutlined />,
    group: 'research',
    sub: 'more',
    keywords: ['command', 'linux', 'shell', '命令'],
  },
  {
    path: '/bioinfo',
    label: '生信实验实训',
    icon: <CodeOutlined />,
    group: 'research',
    sub: 'more',
    hint: '课程与终端工作区',
    keywords: ['bioinfo', '生信', '实训', '课程', '终端', 'terminal'],
  },
  {
    path: '/weather',
    label: '天气',
    icon: <CloudOutlined />,
    group: 'learn',
    hidden: true,
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
    group: 'research',
    sub: 'more',
    hint: '上手 / FAQ / 诊断',
    keywords: ['help', 'faq', '帮助', '文档', '更新日志', 'release'],
  },

  // ---------------------------------------------------------------- 实用工具
  {
    path: '/snapotter',
    label: '文件工坊',
    icon: <ThunderboltOutlined />,
    group: 'research',
    sub: 'more',
    hint: '文件与媒体处理',
    keywords: ['snapotter', 'media', '转换', '文件'],
  },
  {
    path: '/search',
    label: '统一搜索',
    icon: <GlobalOutlined />,
    group: 'research',
    sub: 'more',
    keywords: ['search', '搜索'],
  },
  {
    path: '/start',
    label: '起始页',
    icon: <FolderOpenOutlined />,
    group: 'tools',
    hint: '浏览器主页',
    hidden: true,
    keywords: ['start', 'home', '起始页'],
    noCommand: true,
  },

  // ---------------------------------------------------------------- 系统管理
  {
    path: '/admin/status',
    label: '服务状态',
    icon: <CloudServerOutlined />,
    group: 'admin',
    sub: 'admin',
    adminOnly: true,
    keywords: ['admin', 'status', 'health', '状态'],
  },
  {
    path: '/admin/users',
    label: '用户和权限',
    icon: <RobotOutlined />,
    group: 'admin',
    sub: 'admin',
    adminOnly: true,
    keywords: ['admin', 'users', '用户', '权限'],
  },
  {
    path: '/admin/settings',
    label: '配置与日志',
    icon: <ToolOutlined />,
    group: 'admin',
    sub: 'admin',
    adminOnly: true,
    keywords: ['admin', 'settings', 'logs', '配置', '日志'],
  },
  {
    path: '/admin/backups',
    label: '备份与恢复',
    icon: <DatabaseOutlined />,
    group: 'admin',
    sub: 'admin',
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

/**
 * 侧栏/命令面板可见的条目。
 *
 * `teacherOnly` 的页面（课题资料、组会汇报）是**教师视角的管理页**：
 * 学生看到的是自己那棵目录（在「组员共享」与个人空间里），
 * 不需要也不该看到这两个"管理全部学生"的入口。
 */
export function visibleNavItems(isAdmin: boolean, isTeacher = false): NavItem[] {
  return NAV_ITEMS.filter((it) => {
    if (it.hidden) return false;
    if (it.adminOnly && !isAdmin) return false;
    // teacherOnly 只认教师用户组：管理员也不显示。
    // 理由：「课题资料」是教师视角的学生目录管理，管理员职责是平台运维，
    // 两者权限不应互相穿透；管理员若确实需要，由管理员另加 lab-teacher 组。
    if (it.teacherOnly && !isTeacher) return false;
    return true;
  });
}

/**
 * 侧栏结构：一级组 → （平铺页面 | 二级子菜单）。
 *
 * 折叠状态下 antd 只画一级项，所以**高频页面平铺、低频页面进子菜单**，
 * 一眼能数完入口；子菜单在折叠态悬浮展开，展开态则是正常的嵌套列表。
 */
export interface SidebarLeaf {
  /** 一级项 key（子菜单用 `sub:<subkey>`） */
  key: string;
  label: ReactNode;
  icon?: ReactNode;
}

export interface SidebarBranch extends SidebarLeaf {
  /** 有 children 就是子菜单，没有就是平铺页面 */
  children?: SidebarLeaf[];
}

export interface SidebarGroup extends SidebarLeaf {
  children: SidebarBranch[];
}

export function sidebarSections(isAdmin: boolean, isTeacher = false): SidebarGroup[] {
  const entries = visibleNavItems(isAdmin, isTeacher);
  const out: SidebarGroup[] = [];
  for (const group of NAV_GROUPS) {
    if (group.adminOnly && !isAdmin) continue;
    const inGroup = entries.filter((it) => it.group === group.key);
    if (!inGroup.length) continue;
    // 子菜单按 NAV_SUBS 的声明顺序排（不按页面出现顺序），平铺项在前。
    const subKeys = [...new Set(inGroup.map((it) => it.sub).filter((s): s is string => Boolean(s)))]
      .sort((a, b) => {
        const order = Object.keys(NAV_SUBS);
        return order.indexOf(a) - order.indexOf(b);
      });
    const flat = inGroup.filter((it) => !it.sub);
    const groupChildren: SidebarBranch[] = [
      ...flat.map((it) => ({ key: it.path, label: it.label, icon: it.icon })),
      ...subKeys.map((sk) => {
        const meta = NAV_SUBS[sk];
        const children = inGroup
          .filter((it) => it.sub === sk)
          .map((it) => ({ key: it.path, label: it.label, icon: it.icon }));
        return {
          key: `sub:${sk}`,
          label: meta?.label ?? sk,
          icon: meta?.icon,
          children,
        };
      }),
    ];
    out.push({
      key: group.key,
      label: group.label,
      children: groupChildren,
    });
  }
  return out;
}

/** 侧栏子菜单 key → 其下的页面路径，用于「选中项自动展开所属子菜单」。 */
export function subKeyOfPath(pathname: string): string | undefined {
  const path = resolveNavPath(pathname);
  const item = NAV_BY_PATH.get(path);
  return item?.sub ? `sub:${item.sub}` : undefined;
}

/** 命令面板用的子集：管理员页面与过场路由都不进面板 */
export function commandableNavItems(isAdmin: boolean, isTeacher = false): NavItem[] {
  return visibleNavItems(isAdmin, isTeacher).filter((it) => !it.noCommand);
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
