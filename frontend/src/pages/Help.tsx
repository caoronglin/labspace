import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Divider,
  Empty,
  Flex,
  Input,
  Space,
  Steps,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import {
  ApiOutlined,
  BookOutlined,
  CloudServerOutlined,
  CodeOutlined,
  CompassOutlined,
  ExperimentOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  QuestionCircleOutlined,
  RobotOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import { useAuth } from '../app/AuthContext';
import { NAV_GROUPS, visibleNavItems } from '../app/navigation';
import { RELEASES } from '../content/releases';
import NetworkDiagnostics from '../components/NetworkDiagnostics';
import { requestTour } from '../components/onboardingState';

const { Text, Paragraph, Link } = Typography;

const QUICK_START = [
  {
    title: '统一身份登录',
    description: '一次 SSO，自动进入工作台，无需在各服务重复注册。',
    icon: <SafetyCertificateOutlined />,
  },
  {
    title: '从工作台出发',
    description: '左侧导航或用 ⌘K 命令面板，直达任意服务与页面。',
    icon: <CompassOutlined />,
  },
  {
    title: '文件与数据',
    description: '公共文件、公共质粒、公共基因组与个人文件按 ACL 隔离。',
    icon: <FolderOpenOutlined />,
  },
  {
    title: '跨服务联动',
    description: '例如在公共基因组中打开 FASTA，再交给 rust-bio 做序列分析、成对比对或 BLAST。',
    icon: <ExperimentOutlined />,
  },
];

const QUICK_LINKS = [
  { label: 'Agent 科研助手', hint: '对话、记忆与代码沙箱', icon: <RobotOutlined />, path: '/agent' },
  { label: '科研工具', hint: '绘图 · 流程图 · 基因组', icon: <ToolOutlined />, path: '/tools' },
  { label: '文件存储', hint: '个人与公共文件', icon: <FolderOpenOutlined />, path: '/files' },
  { label: '知识库', hint: '检索与沉淀结论', icon: <BookOutlined />, path: '/knowledge' },
];

const FAQ = [
  {
    key: 'account',
    keywords: '账号 密码 登录 开通 casdoor 首次',
    label: '账号与密码由谁管理？',
    children: (
      <Paragraph type="secondary" style={{ margin: 0 }}>
        账号、密码与用户组统一由 Casdoor 管理，门户不单独保存密码。新成员请联系管理员开通；
        首次登录会自动弹出本帮助，之后可在右上角「帮助中心」随时打开。
      </Paragraph>
    ),
  },
  {
    key: 'acl',
    keywords: '权限 用户组 只读 看不到 ACL 授权',
    label: '为什么有些文件或服务看不到？',
    children: (
      <Paragraph type="secondary" style={{ margin: 0 }}>
        文件与服务均按用户组（老师 / 博士 / 研究生 / 本科生 / 实习生）与个人权限过滤。
        没有读权限的目录不会出现在列表中；只读权限只能预览与下载，不能修改或删除。
        具体授权可在「用户和权限」中查看，或联系管理员调整。
      </Paragraph>
    ),
  },
  {
    key: 'share',
    keywords: '共享 文件夹 同事 读写 分享',
    label: '如何把个人文件共享给同事？',
    children: (
      <Paragraph type="secondary" style={{ margin: 0 }}>
        打开「文件共享 → 个人文件」，在文件或文件夹的「共享」中选择共享人；
        对方会在「共享给我」中看到内容，并继承你授予的读写范围。
      </Paragraph>
    ),
  },
  {
    key: 'genome',
    keywords: '基因组 fasta 比对 blast 注释 序列',
    label: '公共基因组支持哪些文件？',
    children: (
      <Paragraph type="secondary" style={{ margin: 0 }}>
        序列分析支持 FASTA 系格式（.fa / .fna / .fasta / .fas / .ffn / .frn / .faa）。
        为避免浏览器卡顿，GC / ORF 分析会截取序列前 20 kb；「比对与注释工具」还提供成对比对、
        基序检索、区域重叠、序列提取、基因检索、ID 解析与 BLAST，其中注释相关功能需先导入并发布参考物种。
        所有计算由 CropGenome Toolkit（rust-bio）完成，经门户按你的身份代理，不会暴露服务令牌。
      </Paragraph>
    ),
  },
  {
    key: 'network',
    keywords: 'tailscale 192.168 双入口 证书 地址',
    label: '192.0.2.10 与 Tailscale 双入口怎么用？',
    children: (
      <Paragraph type="secondary" style={{ margin: 0 }}>
        门户会按你实际访问的主机名生成服务地址：从哪个入口进来，就继续用哪个入口访问。
        如果出现证书或别名异常，就近查看本页底部的「访问与诊断」自检结果。
      </Paragraph>
    ),
  },
  {
    key: 'recycle',
    keywords: '删除 回收站 恢复 误删',
    label: '文件误删了还能找回吗？',
    children: (
      <Paragraph type="secondary" style={{ margin: 0 }}>
        删除的文件会进入回收站，管理员可在回收站中恢复；彻底删除后不可恢复。
        账号删除为硬删除（连同个人目录与关联数据一并清除），请务必谨慎操作。
      </Paragraph>
    ),
  },
];

export default function Help() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAdmin } = useAuth();
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();

  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const filteredFaq = useMemo(
    () =>
      needle
        ? FAQ.filter((f) => `${f.label} ${f.keywords}`.toLowerCase().includes(needle))
        : FAQ,
    [needle],
  );

  const groups = useMemo(() => {
    const items = visibleNavItems(isAdmin).filter(
      (it) =>
        !needle ||
        `${it.label} ${it.hint ?? ''} ${(it.keywords ?? []).join(' ')}`
          .toLowerCase()
          .includes(needle),
    );
    return NAV_GROUPS.filter((g) => items.some((it) => it.group === g.key)).map((g) => ({
      ...g,
      items: items.filter((it) => it.group === g.key),
    }));
  }, [isAdmin, needle]);

  useEffect(() => {
    if (location.hash === '#releases') {
      const el = document.getElementById('releases');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [location.hash]);

  return (
    <Flex vertical gap={16} className="d509-enter">
      <PageHeader
        title="帮助中心"
        description="快速上手、服务地图、常见问题与更新日志"
        extra={
          <>
            <Button icon={<CompassOutlined />} onClick={() => requestTour()}>
              重新查看引导
            </Button>
            <Button icon={<CloudServerOutlined />} onClick={() => navigate('/admin/status')}>
              服务状态
            </Button>
            <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => window.dispatchEvent(new Event('d509:cmdk'))}>
              打开命令面板
            </Button>
          </>
        }
      />

      <Alert
        type="info"
        showIcon
        icon={<QuestionCircleOutlined />}
        title="第一次使用？"
        description="按下面的四步走一遍，就能把账号、文件与科研工具串起来。遇到权限问题，先看「常见问题 → 文件或服务看不到」。"
      />

      <Card size="small">
        <Flex vertical gap={12}>
          <Input
            size="large"
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索功能、问题或关键词，例如：共享、BLAST、权限、Tailscale"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="搜索帮助内容"
          />
          <Flex gap={8} wrap>
            {[
              { id: 'quick-start', label: '快速上手' },
              { id: 'service-map', label: '服务地图' },
              { id: 'faq', label: '常见问题' },
              { id: 'diagnostics', label: '访问与诊断' },
              { id: 'releases', label: '更新日志' },
            ].map((s) => (
              <Button key={s.id} size="small" type="text" onClick={() => jump(s.id)}>
                {s.label}
              </Button>
            ))}
            {needle && <Tag color="blue">筛选：{q.trim()} · {filteredFaq.length + groups.reduce((n, g) => n + g.items.length, 0)} 条</Tag>}
          </Flex>
          <div className="d509-grid d509-grid-sm">
            {QUICK_LINKS.map((it) => (
              <Card
                key={it.path}
                size="small"
                hoverable
                styles={{ body: { padding: 12 } }}
                onClick={() => navigate(it.path)}
              >
                <Flex align="center" gap={10}>
                  <span style={{ fontSize: 18, color: '#2B5CE6' }}>{it.icon}</span>
                  <Flex vertical>
                    <Text strong style={{ fontSize: 13 }}>{it.label}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{it.hint}</Text>
                  </Flex>
                </Flex>
              </Card>
            ))}
          </div>
        </Flex>
      </Card>

      <Card id="quick-start" size="small" title={<span><RocketOutlined /> 快速上手</span>}>
        <Steps
          size="small"
          items={QUICK_START.map((s) => ({
            title: s.title,
            description: s.description,
            icon: s.icon,
          }))}
        />
      </Card>

      <Card
        id="service-map"
        size="small"
        title={<span><ApiOutlined /> 服务地图</span>}
        extra={<Text type="secondary" style={{ fontSize: 12 }}>按用户组与个人权限显示</Text>}
      >
        {groups.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的服务" />
        ) : (
          <Flex vertical gap={16}>
            {groups.map((g) => (
              <div key={g.key}>
                <Text strong style={{ fontSize: 13 }}>{g.label}</Text>
                <div className="d509-grid d509-grid-sm" style={{ marginTop: 8 }}>
                  {g.items.map((it) => (
                    <Card
                      key={it.path}
                      size="small"
                      hoverable
                      styles={{ body: { padding: 12 } }}
                      onClick={() => navigate(it.path)}
                      role="link"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          navigate(it.path);
                        }
                      }}
                    >
                      <Flex vertical gap={4}>
                        <Flex align="center" gap={8} style={{ fontSize: 14 }}>
                          <span style={{ color: '#2B5CE6' }}>{it.icon}</span>
                          <Text strong style={{ fontSize: 13 }}>{it.label}</Text>
                        </Flex>
                        <Text type="secondary" style={{ fontSize: 12, minHeight: 32 }}>
                          {it.hint ?? it.keywords?.slice(0, 2).join(' · ') ?? ' '}
                        </Text>
                      </Flex>
                    </Card>
                  ))}
                </div>
              </div>
            ))}
          </Flex>
        )}
      </Card>

      <Card id="faq" size="small" title={<span><BookOutlined /> 常见问题</span>}>
        {filteredFaq.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的问题，试试其他关键词" />
        ) : (
          <Collapse
            ghost
            items={filteredFaq}
            defaultActiveKey={needle ? filteredFaq.map((f) => f.key) : undefined}
          />
        )}
        <Divider style={{ margin: '8px 0 12px' }} />
        <Flex wrap gap={12} align="center">
          <Text type="secondary" style={{ fontSize: 12.5 }}>
            <CodeOutlined /> 快捷键：⌘K / Ctrl+K 唤起命令面板；顶栏搜索支持服务、命令、植物库与资料。
          </Text>
          <Button size="small" onClick={() => navigate('/admin/users')} icon={<TeamOutlined />} disabled={!isAdmin}>
            用户和权限
          </Button>
        </Flex>
      </Card>

      <Card id="diagnostics" size="small" title={<span><GlobalOutlined /> 访问与诊断</span>}
        extra={<Text type="secondary" style={{ fontSize: 12 }}>入口自适应 · 连通性自检</Text>}>
        <NetworkDiagnostics />
      </Card>

      <Card
        id="releases"
        size="small"
        title={<span><ThunderboltOutlined /> 更新日志</span>}
        extra={<Tag color="blue">当前版本 {RELEASES[0].version}</Tag>}
      >
        <Timeline
          items={RELEASES.map((r, i) => ({
            color: i === 0 ? 'blue' : 'gray',
            children: (
              <Flex vertical gap={4}>
                <Flex align="center" gap={8} wrap>
                  <Text strong>{r.title}</Text>
                  <Tag color={i === 0 ? 'blue' : undefined}>v{r.version}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>{r.date}</Text>
                </Flex>
                <Text type="secondary" style={{ fontSize: 12.5 }}>{r.summary}</Text>
                <ul style={{ margin: '2px 0 0', paddingInlineStart: 20 }}>
                  {r.highlights.map((h) => (
                    <li key={h} style={{ fontSize: 12.5, color: 'var(--ant-color-text-secondary)' }}>
                      {h}
                    </li>
                  ))}
                </ul>
              </Flex>
            ),
          }))}
        />
      </Card>

      <Divider style={{ margin: '4px 0' }} />
      <Flex justify="space-between" wrap gap={12} align="center">
        <Text type="secondary" style={{ fontSize: 12.5 }}>
          账号开通、权限调整、数据恢复请联系实验室管理员；服务异常先看「访问与诊断」。
        </Text>
        <Space size={8}>
          <Button size="small" icon={<CloudServerOutlined />} onClick={() => navigate('/admin/status')}>
            服务状态
          </Button>
          <Link
            onClick={() => {
              window.scrollTo({ top: 0, behavior: 'smooth' });
              document.getElementById('d509-main')?.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            回到顶部
          </Link>
        </Space>
      </Flex>
      <Text type="secondary" style={{ fontSize: 12, textAlign: 'center' }}>
        D509 实验室工作台 · 遇到文档没有覆盖的问题，欢迎反馈给管理员
      </Text>
      <Text type="secondary" style={{ fontSize: 12, textAlign: 'center' }}>
        界面字体使用 <Text strong style={{ fontSize: 12 }}>HONOR Sans</Text>（Copyright 2022 Honor
        Device Co., Ltd.），依据 HONOR Sans Copyright License Agreement 嵌入使用。
        <a href="/fonts/honor-sans/LICENSE.txt" target="_blank" rel="noreferrer">
          查看许可协议
        </a>
      </Text>
    </Flex>
  );
}