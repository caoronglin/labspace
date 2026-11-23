/**
 * 帮助中心内容 —— 与页面渲染分离，便于独立维护与搜索。
 *
 * 这里只放「内容」：快速上手、按角色入口、常见问题。
 * 页面骨架与交互在 pages/Help.tsx；版本日志在 content/releases.ts（更新弹窗共用）。
 *
 * 维护约定：
 * - 服务下线时，必须同步删除对应 FAQ（曾残留 CropGenome 条目误导用户）；
 * - 新增功能后，在本文件补一条 FAQ 或在 releases.ts 补版本说明；
 * - keywords 参与顶栏搜索过滤，别只写标题词。
 */

import {
  CloudServerOutlined,
  CompassOutlined,
  ExperimentOutlined,
  FolderOpenOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import React from 'react';

export interface QuickStartItem {
  title: string;
  description: string;
  icon: React.ReactNode;
}

export interface RoleStartGroup {
  role: string;
  icon: React.ReactNode;
  items: { label: string; hint: string; path: string }[];
}

export interface FaqItem {
  key: string;
  keywords: string;
  label: string;
  children: React.ReactNode;
}

export const QUICK_START: QuickStartItem[] = [
  {
    title: '一次登录，全站可用',
    description: 'Casdoor 是唯一身份源；首次登录按提示改完初始口令即可使用所有已授权服务。',
    icon: <SafetyCertificateOutlined />,
  },
  {
    title: '三种方式找到入口',
    description: '首页快捷入口、左侧分组导航、⌘K 命令面板。记不住菜单也没关系，搜页面名就行。',
    icon: <CompassOutlined />,
  },
  {
    title: '文件按权限隔离',
    description: '个人文件、课题资料、组会周目录、组员共享树各有 ACL；老师看全部、学生只看自己。',
    icon: <FolderOpenOutlined />,
  },
  {
    title: '结果可以接着用',
    description:
      '文献可「AI 解读」、种子可「让 Agent 分析」、PDF 文件可一键进 PDF 工具箱、待办可跳回文件位置 —— 不用下载再上传。',
    icon: <ExperimentOutlined />,
  },
];

/**
 * 按角色的推荐入口。
 * 快速上手 = 通用四步（怎么用这个平台）；这里 = 按你的角色，第一步该点哪。
 */
export const ROLE_STARTS: RoleStartGroup[] = [
  {
    role: '学生',
    icon: <FolderOpenOutlined />,
    items: [
      { label: '文件空间', hint: '个人目录与共享文件', path: '/files' },
      { label: '组会汇报', hint: '按周提交材料', path: '/meetings' },
      { label: 'Agent 助手', hint: '检索、写作与代码', path: '/agent' },
      { label: '统一搜索', hint: '网页 / 学术 / 站内聚合检索', path: '/search' },
      { label: 'PDF 工具箱', hint: '本机合并 · 拆分 · 压缩', path: '/pdf' },
    ],
  },
  {
    role: '导师',
    icon: <TeamOutlined />,
    items: [
      { label: '组员名册', hint: '账号、目录与授权', path: '/admin/users' },
      { label: '课题资料', hint: '逐生的资料目录', path: '/research' },
      { label: '种子管理', hint: '突变台账 · Excel · AI 分析', path: '/seeds' },
      { label: '组会汇报', hint: '按周授权 · 沿用上周', path: '/meetings' },
      { label: 'PDF 工具箱', hint: '本机合并 · 拆分 · 压缩', path: '/pdf' },
    ],
  },
  {
    role: '管理员',
    icon: <CloudServerOutlined />,
    items: [
      { label: '账号与权限', hint: '用户组与文件授权', path: '/admin/users' },
      { label: 'ACL 巡检', hint: '孤儿权限 · 悬空授权 · 越权组', path: '/admin/status' },
      { label: '后台任务', hint: '定时任务与日志', path: '/admin/tasks' },
      { label: '备份归档', hint: '本地与异地副本', path: '/admin/backups' },
    ],
  },
];

export const FAQ: FaqItem[] = [
  {
    key: 'account',
    keywords: '账号 密码 登录 开通 casdoor 首次',
    label: '账号与密码由谁管理？',
    children: (
      <ParagraphText>
        账号、密码与用户组统一由 Casdoor 管理，门户不单独保存密码。新成员请联系管理员开通；
        首次登录会自动弹出本帮助，之后可在右上角「帮助中心」随时打开。
      </ParagraphText>
    ),
  },
  {
    key: 'acl',
    keywords: '权限 用户组 只读 看不到 ACL 授权',
    label: '为什么有些文件或服务看不到？',
    children: (
      <ParagraphText>
        文件与服务均按用户组（老师 / 博士 / 研究生 / 本科生 / 实习生）与个人权限过滤。
        没有读权限的目录不会出现在列表中；只读权限只能预览与下载，不能修改或删除。
        具体授权可在「用户和权限」中查看，或联系管理员调整。
      </ParagraphText>
    ),
  },
  {
    key: 'share',
    keywords: '共享 文件夹 同事 读写 分享',
    label: '如何把个人文件共享给同事？',
    children: (
      <ParagraphText>
        打开「文件共享 → 个人文件」，在文件或文件夹的「共享」中选择共享人；
        对方会在「共享给我」中看到内容，并继承你授予的读写范围。
      </ParagraphText>
    ),
  },
  {
    key: 'code-preview',
    keywords: '代码预览 源码 py ts go 行号 复制 截断',
    label: '怎么预览源代码文件？',
    children: (
      <ParagraphText>
        在文件空间单击 .py / .ts / .go / .rs 等源码文件或 Dockerfile、Makefile，
        即可在弹窗中查看带行号的代码，支持换行切换与一键复制。超过 6 万字符的文件只展示前一部分并提示截断。
      </ParagraphText>
    ),
  },
  {
    key: 'table',
    keywords: '数据表格 baserow 工作区 字段 记录 视图 筛选',
    label: '多维表格能做什么？',
    children: (
      <ParagraphText>
        「数据表格」支持工作区 / 数据表 / 字段 / 记录一站管理，提供表格、画廊、看板、日历、表单五种视图，
        每种视图可单独设置筛选与排序；字段支持附件、关联行、人员指派等类型，还可导入 CSV、批量修改与邀请成员共享。
      </ParagraphText>
    ),
  },
  {
    key: 'genome',
    keywords: '基因组 fasta 比对 blast 注释 序列',
    label: '公共基因组与序列分析支持哪些功能？',
    children: (
      <ParagraphText>
        「公共基因组」内嵌 JBrowse 2 按 ACL 浏览参考基因组；序列分析支持 FASTA 系格式（.fa / .fna / .fasta / .fas / .ffn / .frn / .faa），
        可做 GC / GC3 含量、ORF 预测与反向互补。为避免浏览器卡顿，分析会截取序列前 20 kb。
        「比对与注释工具」另提供成对比对、基序检索、区域重叠、序列提取、基因检索与 BLAST，注释相关功能需先导入并发布参考物种。
      </ParagraphText>
    ),
  },
  {
    key: 'terminal',
    keywords: '终端 ssh pty 登录 命令行 实验室终端 cgroup 限额',
    label: '怎么使用实验室终端？',
    children: (
      <ParagraphText>
        从「生信实训 → 实验室终端」进入，门户登录后自动免密进入终端工作区。
        终端运行在资源限额容器内（CPU / 内存 / 进程数），断开重连不会丢失工作区文件；
        请勿在共享目录写入他人数据，命令记录仅用于审计，不对外展示。
      </ParagraphText>
    ),
  },
  {
    key: 'network',
    keywords: 'tailscale 双入口 证书 地址 自适应',
    label: '内网与 Tailscale 双入口怎么用？',
    children: (
      <ParagraphText>
        门户会按你实际访问的主机名生成服务地址：从哪个入口进来，就继续用哪个入口访问，无需手动切换。
        如果出现证书或别名异常，就近查看本页底部的「访问与诊断」自检结果。
      </ParagraphText>
    ),
  },
  {
    key: 'recycle',
    keywords: '删除 回收站 恢复 误删',
    label: '文件误删了还能找回吗？',
    children: (
      <ParagraphText>
        删除的文件会进入回收站，管理员可在回收站中恢复；彻底删除后不可恢复。
        账号删除为硬删除（连同个人目录与关联数据一并清除），请务必谨慎操作。
      </ParagraphText>
    ),
  },
];

/** FAQ 正文统一用 Typography.Paragraph，避免每个条目重复写 type/margin。 */
function ParagraphText({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--ant-color-text-secondary)' }}>{children}</span>;
}
