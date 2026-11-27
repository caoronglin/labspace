import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Form,
  Grid,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  theme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, LinkOutlined, PlusOutlined, StopOutlined } from '@ant-design/icons';
import PageShell from '../components/PageShell';
import { formatDateTime } from '../utils/format';
import { SshApiError, sshApi } from '../services/ssh';
import type { SshAuditEntry, SshConnection, SshConnectionInput, SshSession } from '../services/ssh-types';
import SshFiles from './ssh/SshFiles';
import SshTerminal from './ssh/SshTerminal';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface HostKeyPrompt {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
}

export default function Ssh() {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.lg;
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [sessions, setSessions] = useState<SshSession[]>([]);
  const [audit, setAudit] = useState<SshAuditEntry[]>([]);
  const [activeId, setActiveId] = useState('');
  const [tab, setTab] = useState('terminal');
  const [loading, setLoading] = useState(true);
  const [connectingId, setConnectingId] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hostKey, setHostKey] = useState<HostKeyPrompt | null>(null);
  const [pendingConnection, setPendingConnection] = useState<SshConnection | null>(null);
  const [form] = Form.useForm();
  const authType = Form.useWatch('authType', form) || 'password';

  const activeSession = useMemo(() => sessions.find((item) => item.id === activeId) ?? sessions[0], [activeId, sessions]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [connectionData, sessionData, auditData] = await Promise.all([
        sshApi.connections(),
        sshApi.sessions(),
        sshApi.audit(),
      ]);
      setConnections(connectionData.connections);
      setSessions(sessionData.sessions);
      setAudit(auditData.entries);
      setActiveId((prev) => sessionData.sessions.some((item) => item.id === prev) ? prev : sessionData.sessions[0]?.id ?? '');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'SSH 网关加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const connect = useCallback(async (connection: SshConnection) => {
    setConnectingId(connection.id);
    try {
      const data = await sshApi.createSession(connection.id);
      setActiveId(data.session.id);
      setTab('terminal');
      message.success(`已连接 ${connection.username}@${connection.host}`);
      await loadAll();
    } catch (error) {
      if (error instanceof SshApiError && error.status === 409 && isRecord(error.payload.detail)) {
        const detail = error.payload.detail;
        if (detail.code === 'host_key_required') {
          setPendingConnection(connection);
          setHostKey({
            host: String(detail.host || connection.host),
            port: Number(detail.port || connection.port),
            keyType: String(detail.keyType || ''),
            fingerprint: String(detail.fingerprint || ''),
          });
          return;
        }
      }
      message.error(error instanceof Error ? error.message : 'SSH 连接失败');
    } finally {
      setConnectingId('');
    }
  }, [loadAll, message]);

  const confirmHostKey = async () => {
    if (!hostKey || !pendingConnection) return;
    try {
      await sshApi.confirmHostKey(hostKey.host, hostKey.port, hostKey.keyType, hostKey.fingerprint);
      message.success('主机指纹已确认');
      setHostKey(null);
      const connection = pendingConnection;
      setPendingConnection(null);
      await connect(connection);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '主机指纹确认失败');
    }
  };

  const saveConnection = async () => {
    const values = await form.validateFields();
    const body: SshConnectionInput = {
      name: String(values.name || '').trim(),
      host: String(values.host || '').trim(),
      port: Number(values.port || 22),
      username: String(values.username || '').trim(),
      authType: values.authType,
      password: values.authType === 'password' ? values.password : undefined,
      privateKey: values.authType === 'private_key' ? values.privateKey : undefined,
      passphrase: values.authType === 'private_key' ? values.passphrase : undefined,
    };
    setSaving(true);
    try {
      await sshApi.saveConnection(body);
      message.success('SSH 连接已加密保存');
      form.resetFields();
      setFormOpen(false);
      await loadAll();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const stopSession = async (session: SshSession) => {
    try {
      await sshApi.stopSession(session.id);
      message.success('SSH 会话已断开');
      if (activeId === session.id) setActiveId('');
      await loadAll();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '断开失败');
    }
  };

  const auditColumns: ColumnsType<SshAuditEntry> = [
    { title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 180, render: (value: string) => formatDateTime(value) },
    { title: '动作', dataIndex: 'action', key: 'action', width: 170 },
    { title: '目标', dataIndex: 'target', key: 'target', ellipsis: true },
  ];

  return (
    <PageShell
      title="SSH 工作台"
      description="连接内网 SSH 服务器，使用真实终端与 SFTP 文件目录；连接、主机密钥和操作记录按你的门户账号隔离。"
      extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setFormOpen(true); }}>新建连接</Button>}
    >
      <Flex vertical={isMobile} gap={16} align="stretch">
        <Card
          size="small"
          title="我的 SSH 连接"
          loading={loading}
          style={{ width: isMobile ? '100%' : 310, flex: isMobile ? 'none' : '0 0 310px' }}
          styles={{ body: { maxHeight: isMobile ? 320 : 660, overflow: 'auto' } }}
        >
          <Flex vertical gap={8}>
            {connections.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有保存的 SSH 连接" /> : connections.map((connection) => (
              <Card key={connection.id} size="small" style={{ borderColor: token.colorBorderSecondary }}>
                <Flex vertical gap={8}>
                  <Flex justify="space-between" align="center" gap={8}>
                    <Typography.Text strong ellipsis style={{ maxWidth: 180 }}>{connection.name}</Typography.Text>
                    <Tag>{connection.authType === 'password' ? '口令' : '私钥'}</Tag>
                  </Flex>
                  <Typography.Text code style={{ fontSize: 12 }}>{connection.username}@{connection.host}:{connection.port}</Typography.Text>
                  <Flex gap={8}>
                    <Button type="primary" size="small" icon={<LinkOutlined />} loading={connectingId === connection.id} onClick={() => void connect(connection)}>连接</Button>
                    <Popconfirm title="删除已保存的连接？" description="只会删除门户中的加密凭据，不影响远端服务器账号。" okText="删除" cancelText="取消" onConfirm={async () => {
                      try {
                        await sshApi.deleteConnection(connection.id);
                        message.success('连接已删除');
                        await loadAll();
                      } catch (error) {
                        message.error(error instanceof Error ? error.message : '删除失败');
                      }
                    }}>
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Flex>
                </Flex>
              </Card>
            ))}
          </Flex>
        </Card>

        <Card
          size="small"
          title={activeSession ? `${activeSession.name} · ${activeSession.username}@${activeSession.host}` : 'SSH 会话'}
          extra={activeSession ? (
            <Space wrap>
              <Select
                aria-label="切换 SSH 会话"
                value={activeSession.id}
                onChange={setActiveId}
                options={sessions.map((session) => ({ value: session.id, label: `${session.name} · ${session.host}` }))}
                style={{ minWidth: 190 }}
                size="small"
              />
              <Button size="small" danger icon={<StopOutlined />} onClick={() => void stopSession(activeSession)}>断开</Button>
            </Space>
          ) : null}
          style={{ flex: 1, minWidth: 0 }}
        >
          {activeSession ? (
            <Tabs
              activeKey={tab}
              onChange={setTab}
              items={[
                { key: 'terminal', label: '终端', children: <SshTerminal key={activeSession.id} sessionId={activeSession.id} /> },
                { key: 'files', label: '文件目录', children: <SshFiles key={activeSession.id} sessionId={activeSession.id} /> },
                {
                  key: 'audit',
                  label: '操作审计',
                  children: <Table<SshAuditEntry> rowKey="id" columns={auditColumns} dataSource={audit} size="small" pagination={{ pageSize: 12 }} />,
                },
              ]}
            />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="从左侧选择连接并点击“连接”，首次连接会要求确认服务器指纹" />
          )}
        </Card>
      </Flex>

      <Modal title="新建 SSH 连接" open={formOpen} onCancel={() => setFormOpen(false)} onOk={() => void saveConnection()} confirmLoading={saving} okText="加密保存" cancelText="取消" width={620}>
        <Alert type="info" showIcon title="凭据保护" description="口令或私钥加密后保存在门户数据库，仅你的账号可读取；目标必须位于运维配置的内网白名单。" style={{ marginBottom: 16 }} />
        <Form form={form} layout="vertical" initialValues={{ port: 22, authType: 'password' }}>
          <Form.Item name="name" label="连接名称" rules={[{ required: true, message: '请输入连接名称' }]}>
            <Input placeholder="例如：HPC 计算节点" maxLength={80} />
          </Form.Item>
          <Flex gap={12}>
            <Form.Item name="host" label="主机地址" rules={[{ required: true, message: '请输入内网 IP 或主机名' }]} style={{ flex: 1 }}>
              <Input placeholder="内网 IP 或已配置的主机名" maxLength={253} />
            </Form.Item>
            <Form.Item name="port" label="端口" rules={[{ required: true, message: '请输入端口' }]}>
              <Input type="number" min={1} max={65535} style={{ width: 110 }} />
            </Form.Item>
          </Flex>
          <Form.Item name="username" label="远端用户名" rules={[{ required: true, message: '请输入远端用户名' }]}>
            <Input placeholder="SSH 服务器上的账号" maxLength={128} />
          </Form.Item>
          <Form.Item name="authType" label="认证方式">
            <Select options={[{ value: 'password', label: '口令' }, { value: 'private_key', label: '私钥' }]} />
          </Form.Item>
          {authType === 'password' ? (
            <Form.Item name="password" label="SSH 口令" rules={[{ required: true, message: '请输入 SSH 口令' }]}>
              <Input.Password autoComplete="new-password" maxLength={1024} />
            </Form.Item>
          ) : (
            <>
              <Form.Item name="privateKey" label="私钥内容" rules={[{ required: true, message: '请输入私钥' }]}>
                <Input.TextArea rows={6} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" maxLength={65536} />
              </Form.Item>
              <Form.Item name="passphrase" label="私钥口令（可选）">
                <Input.Password autoComplete="new-password" maxLength={1024} />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>

      <Modal
        title="确认 SSH 主机指纹"
        open={hostKey !== null}
        onCancel={() => { setHostKey(null); setPendingConnection(null); }}
        onOk={() => void confirmHostKey()}
        okText="我已核对，确认信任"
        cancelText="取消"
      >
        <Alert type="warning" showIcon title="首次连接必须人工确认" description="请通过可信渠道核对指纹；自动接受主机密钥会关闭中间人攻击防护。" style={{ marginBottom: 16 }} />
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="服务器">{hostKey ? `${hostKey.host}:${hostKey.port}` : '—'}</Descriptions.Item>
          <Descriptions.Item label="密钥类型">{hostKey?.keyType || '—'}</Descriptions.Item>
          <Descriptions.Item label="SHA256 指纹"><Typography.Text code>{hostKey?.fingerprint || '—'}</Typography.Text></Descriptions.Item>
        </Descriptions>
      </Modal>
    </PageShell>
  );
}
