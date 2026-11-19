import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Flex,
  Form,
  Input,
  InputNumber,
  Row,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudServerOutlined,
  DesktopOutlined,
  ExportOutlined,
  InfoCircleOutlined,
  LaptopOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';

import PageShell from '../components/PageShell';
import { hostUrl } from '../utils/host';

/**
 * 内网主机台（WebSSH 的门户入口）—— **antd 原生自绘**。
 *
 * 这一页解决的是「选哪台机器」和「怎么连」，不是终端本身：
 *   - 终端字节流要复刻 WebSSH 的 socket.io 私有协议（事件名与数据通道
 *     见 docs/WEBSSH-FRONTEND.md），协议未确证前不自绘，避免做出来跑不通。
 *   - 因此这里用 antd 把「主机清单 / 连接参数 / 配额与限制」讲清楚，
 *     终端由 WebSSH 自己的界面渲染，从这里一键直达（带预设参数）。
 *
 * 为什么主机清单写死在门户里，而不是从 WebSSH 拉：
 *   WebSSH 的 SSH 目标有白名单（SSH_ALLOWED_TARGETS），门户再列一遍
 *   同一份清单，用户在两处看到的机器一致；而且清单走门户的会话鉴权，
 *   不依赖 WebSSH 那边是否已经登录过。
 */

/** 实验室可连的内网机器。与 deploy/compose.yaml 的 SSH_ALLOWED_TARGETS 一致。 */
interface LabHost {
  key: string;
  name: string;
  address: string;
  kind: 'hpc' | 'desktop' | 'workstation';
  os: string;
  purpose: string;
  account?: string;
}

/**
 * 主机清单。
 *
 * 与 `deploy/compose.yaml` 的 `SSH_ALLOWED_TARGETS` 一一对应：
 * 白名单之外的机器 WebSSH 会直接拒（防止拿它当跳板扫内网），
 * 所以这里也只列白名单里的，不多不少。
 */
const HOSTS: LabHost[] = [
  {
    key: 'hpc20d509',
    name: 'HPC 计算节点',
    address: '100.77.182.76',
    kind: 'hpc',
    os: 'Linux',
    purpose: '批量计算、组学流水线',
    account: 'labuser',
  },
  {
    key: 'rlcao-ubuntu',
    name: 'Linux 桌面',
    address: '100.75.160.113',
    kind: 'desktop',
    os: 'Linux',
    purpose: '日常开发、图形工具',
  },
  {
    key: 'win-99hgg0bbe3f',
    name: 'Windows 工作站',
    address: '100.81.178.13',
    kind: 'desktop',
    os: 'Windows',
    purpose: 'Office 文档、仪器软件',
  },
  {
    key: 'wsd509',
    name: 'Windows 工作站（实验组）',
    address: '100.100.161.104',
    kind: 'workstation',
    os: 'Windows',
    purpose: '共享盘与测序工作站',
  },
];

const KIND_META: Record<LabHost['kind'], { label: string; icon: React.ReactNode; color: string }> = {
  hpc: { label: 'HPC', icon: <CloudServerOutlined />, color: 'geekblue' },
  desktop: { label: '桌面', icon: <DesktopOutlined />, color: 'green' },
  workstation: { label: '工作站', icon: <LaptopOutlined />, color: 'purple' },
};

/** 与 deploy/compose.yaml 里的配额一致；用户被拒时才知道原因。 */
const LIMITS = {
  sessions: '全局 6 个 / 单人 2 个',
  connectRate: '6 次 / 分钟',
  transfer: '单人 1 个并发传输',
  targetScope: '仅限上表机器（白名单）',
};

export default function WebSshConsole() {
  const [form] = Form.useForm();
  const [selected, setSelected] = useState<LabHost | null>(null);

  // 服务可达性：探 WebSSH 的 ready（不鉴权，只看端口通不通）
  const health = useQuery({
    queryKey: ['webssh', 'ready'],
    queryFn: async () => {
      // 同源探针（门户 nginx 转发到 WebSSH 的 /ready）：
      // 直接打 :8105 是跨域请求，会被 CORS 拦掉 → 页面误报「服务不可达」。
      const res = await fetch('/webssh-ready/', { credentials: 'include' });
      return res.ok;
    },
    retry: false,
    staleTime: 30_000,
  });

  const columns = useMemo<ColumnsType<LabHost>>(
    () => [
      {
        title: '机器',
        dataIndex: 'name',
        key: 'name',
        render: (_, h) => {
          const meta = KIND_META[h.kind];
          return (
            <Flex gap={8} align="center">
              <Tag color={meta.color} icon={meta.icon} style={{ marginInlineEnd: 0 }}>
                {meta.label}
              </Tag>
              <Typography.Text strong style={{ fontSize: 13 }}>
                {h.name}
              </Typography.Text>
            </Flex>
          );
        },
      },
      {
        title: '地址',
        dataIndex: 'address',
        key: 'address',
        width: 150,
        render: (v: string) => (
          <Typography.Text code style={{ fontSize: 12 }}>
            {v}
          </Typography.Text>
        ),
      },
      { title: '系统', dataIndex: 'os', key: 'os', width: 90 },
      { title: '用途', dataIndex: 'purpose', key: 'purpose', ellipsis: true },
      {
        title: '',
        key: 'action',
        width: 150,
        align: 'right',
        render: (_, h) => (
          <Button
            size="small"
            type="primary"
            ghost
            onClick={() => {
              setSelected(h);
              form.setFieldsValue({
                host: h.address,
                port: 22,
                username: h.account ?? '',
              });
            }}
          >
            连接
          </Button>
        ),
      },
    ],
    [form],
  );

  /**
   * 终端页地址。
   *
   * 目标只允许是**当前门户主机**上的 WebSSH 端口：
   * 主机清单是本文件里的常量（不是用户输入），但仍然显式校验一次，
   * 免得以后清单改成从接口取时，这里悄悄变成一个开放重定向。
   */
  const terminalUrl = useMemo(() => {
    if (!selected) return null;
    const q = new URLSearchParams({ host: selected.address, port: '22' });
    const url = hostUrl(`/?${q.toString()}`, 8105);
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== `${window.location.protocol}//${window.location.hostname}`) return null;
    return parsed.toString();
  }, [selected]);

  return (
    <PageShell
      title="内网主机台"
      description="浏览器里连内网的 HPC 与桌面：不用装 SSH 客户端，手机上也能操作。流量走 Tailscale（WireGuard）加密。"
    >
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card
            title="可连的机器"
            size="small"
            extra={
              health.data === false ? (
                <Tag color="red">服务不可达</Tag>
              ) : health.isLoading ? (
                <Tag>检查中…</Tag>
              ) : (
                <Tag color="green">服务正常</Tag>
              )
            }
          >
            <Table<LabHost>
              size="small"
              rowKey="key"
              columns={columns}
              dataSource={HOSTS}
              pagination={false}
              onRow={(h) => ({
                onClick: () => setSelected(h),
                style: { cursor: 'pointer' },
              })}
              rowClassName={(h) => (selected?.key === h.key ? 'ant-table-row-selected' : '')}
            />
          </Card>
        </Col>

        <Col xs={24} xl={8}>
          <Card
            title="连接"
            size="small"
            extra={
              <Tooltip title="WebSSH 有自己的账号体系，首次使用需要在终端页注册一次">
                <InfoCircleOutlined style={{ color: 'var(--ant-color-text-tertiary)' }} />
              </Tooltip>
            }
          >
            {selected ? (
              <Form
                form={form}
                layout="vertical"
                initialValues={{ host: selected.address, port: 22, username: selected.account ?? '' }}
              >
                <Form.Item label="机器" name="host">
                  <Input readOnly />
                </Form.Item>
                <Form.Item label="端口" name="port">
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请填写登录用户名' }]}>
                  <Input placeholder="远端机器上的账号" />
                </Form.Item>
                <Space>
                  {terminalUrl ? (
                    <Button
                      type="primary"
                      icon={<ExportOutlined />}
                      href={terminalUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      打开终端
                    </Button>
                  ) : (
                    <Button type="primary" icon={<ExportOutlined />} disabled>
                      打开终端
                    </Button>
                  )}
                  <Button onClick={() => setSelected(null)}>取消</Button>
                </Space>
              </Form>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                先在左边选一台机器，或直接点「连接」。
              </Typography.Text>
            )}
          </Card>

          <Card title="限制与配额" size="small" style={{ marginTop: 16 }}>
            <Descriptions
              size="small"
              column={1}
              items={[
                { key: 's', label: '会话数', children: LIMITS.sessions },
                { key: 'r', label: '连接频率', children: LIMITS.connectRate },
                { key: 't', label: '传输', children: LIMITS.transfer },
                { key: 'w', label: '可连范围', children: LIMITS.targetScope },
              ]}
            />
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 10 }}
              title="连接被拒时先看这几项"
              description="目标不在白名单、会话数超限、或一分钟内连接太频繁，都会被服务端直接拒绝。"
            />
          </Card>
        </Col>
      </Row>
    </PageShell>
  );
}
