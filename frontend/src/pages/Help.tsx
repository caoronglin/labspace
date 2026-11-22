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
  GlobalOutlined,
  QuestionCircleOutlined,
  RocketOutlined,
  SearchOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import { useAuth } from '../app/AuthContext';
import { NAV_GROUPS, visibleNavItems } from '../app/navigation';
import { RELEASES } from '../content/releases';
import { QUICK_START, ROLE_STARTS, FAQ } from '../content/helpContent';
import NetworkDiagnostics from '../components/NetworkDiagnostics';
import { requestTour } from '../components/onboardingState';
import { tokens } from '../theme/tokens';

const { Text, Link } = Typography;

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
        description="按下面的四步走一遍，就能把账号、文件与常用工具串起来。遇到权限问题，先看「常见问题 → 文件或服务看不到」。"
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
            {ROLE_STARTS.map((grp) => (
              <Card
                key={grp.role}
                size="small"
                title={
                  <Flex align="center" gap={8}>
                    <span style={{ color: tokens.colorPrimary }}>{grp.icon}</span>
                    <Text strong style={{ fontSize: 13 }}>
                      {grp.role}
                    </Text>
                  </Flex>
                }
                styles={{ body: { padding: 8 } }}
              >
                {grp.items.map((it) => (
                  <Flex
                    key={it.path}
                    align="center"
                    gap={10}
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(it.path)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        navigate(it.path);
                      }
                    }}
                    style={{ padding: '6px 4px', borderRadius: 6, cursor: 'pointer' }}
                  >
                    <Flex vertical style={{ minWidth: 0 }}>
                      <Text strong style={{ fontSize: 12.5 }}>
                        {it.label}
                      </Text>
                      <Text type="secondary" style={{ fontSize: 11.5 }}>
                        {it.hint}
                      </Text>
                    </Flex>
                  </Flex>
                ))}
              </Card>
            ))}
          </div>
        </Flex>
      </Card>

      <Card
        id="quick-start"
        size="small"
        title={<span><RocketOutlined /> 快速上手</span>}
        extra={
          // 与新手引导联动：下面的文字步骤看个大概；
          // 想让人指着界面走一遍，点这个按钮（OnboardingTour 会逐步高亮真实控件）。
          <Button size="small" type="primary" icon={<CompassOutlined />} onClick={() => requestTour()}>
            互动引导
          </Button>
        }
      >
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
                          <span style={{ color: tokens.colorPrimary }}>{it.icon}</span>
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