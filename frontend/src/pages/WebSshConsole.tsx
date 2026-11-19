import { useMemo } from 'react';
import { Card, Col, Descriptions, Flex, Row, Table, Tabs, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CloudServerOutlined, DesktopOutlined, LaptopOutlined } from '@ant-design/icons';

import PageShell from '../components/PageShell';
import WebSshTerminal from './WebSshTerminal';

/**
 * 内网主机台 —— 一个入口，两个页签。
 *
 *   「终端」      = 真正可用的 SSH 终端（antd + xterm 自绘，走 WebSSH 的
 *                   socket.io 协议；见 WebSshTerminal.tsx 顶部的协议说明）
 *   「主机与配额」 = 机器清单 + 配额/限制
 *
 * 为什么合成一个入口：以前「内网主机台」只是机器清单，点「打开终端」还要
 * 跳到另一个端口（:8105）的另一个界面 —— 用户被送出门户、还要再登一次。
 * 现在默认就落在终端上，清单作为辅助页签。
 */

/** 实验室可连的内网机器。与 deploy/compose.yaml 的 SSH_ALLOWED_TARGETS 一致。 */
interface LabHost {
  key: string;
  name: string;
  address: string;
  kind: 'hpc' | 'desktop' | 'workstation';
  os: string;
  purpose: string;
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
  targetScope: '仅限下表机器（白名单）',
};

const COLUMNS: ColumnsType<LabHost> = [
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
    width: 155,
    render: (v: string) => (
      <Typography.Text code style={{ fontSize: 12 }}>
        {v}
      </Typography.Text>
    ),
  },
  { title: '系统', dataIndex: 'os', key: 'os', width: 90 },
  { title: '用途', dataIndex: 'purpose', key: 'purpose', ellipsis: true },
];

export default function WebSshConsole() {
  const hostsTab = useMemo(
    () => (
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card title="可连的机器" size="small">
            <Table<LabHost>
              size="small"
              rowKey="key"
              columns={COLUMNS}
              dataSource={HOSTS}
              pagination={false}
            />
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card title="限制与配额" size="small">
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
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
              连接被拒时先看这几项：目标不在白名单、会话数超限、或一分钟内连接太频繁，
              都会被服务端直接拒绝。
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>
    ),
    [],
  );

  return (
    <PageShell
      title="内网主机台"
      description="浏览器里连内网的 HPC 与桌面：不用装 SSH 客户端，手机上也能操作。流量走 Tailscale（WireGuard）加密。"
    >
      <Tabs
        defaultActiveKey="terminal"
        items={[
          // 终端是主用途：点进来是要"连机器"，不是先看清单
          { key: 'terminal', label: '终端', children: <WebSshTerminal /> },
          { key: 'hosts', label: '主机与配额', children: hostsTab },
        ]}
      />
    </PageShell>
  );
}
