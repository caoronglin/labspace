import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Skeleton,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BellOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  StopOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type AccountItem, type FileGrant } from '../services/api';
import AccessPreview from '../components/acl/AccessPreview';
import { GrantEditor, GrantList } from '../components/acl/GrantEditor';
import LazyMount from '../components/LazyMount';
import PageShell from '../components/PageShell';
import ProStat from '../components/admin/ProStat';
import ProTableCard from '../components/admin/ProTableCard';
import AgentAdmin from './admin/AgentAdmin';
import GroupPermissions from './admin/GroupPermissions';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';

/* 图表组件懒加载：@ant-design/plots 不进入管理页首屏 chunk */
const DiskUsagePanel = lazy(() => import('../components/charts/DiskUsagePanel'));
const ServiceHealthDonut = lazy(() => import('../components/charts/ServiceHealthDonut'));

/** 图表懒加载占位 */
function ChartFallback() {
  return (
    <Card size="small">
      <Skeleton active title={{ width: '38%' }} paragraph={{ rows: 3 }} />
    </Card>
  );
}

function formatBytes(n: number) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function formatCasdoorTime(v?: string) {
  if (!v) return '-';
  const n = Number(v);
  const d = Number.isFinite(n) && v.length <= 11 ? new Date(n * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('zh-CN');
}

const GROUP_COLOR: Record<string, string> = {
  'lab-admin': 'red',
  'lab-teacher': 'orange',
  'lab-student': 'green',
  'bioinfo-admin': 'magenta',
  'bioinfo-instructor': 'orange',
  'bioinfo-ta': 'gold',
  'bioinfo-student': 'green',
};

const ROLE_PRESETS: { label: string; groups: string[] }[] = [
  { label: '学生', groups: ['lab-student', 'bioinfo-student'] },
  { label: '教师', groups: ['lab-teacher', 'bioinfo-instructor'] },
  { label: '实训助教', groups: ['bioinfo-ta'] },
  { label: '管理员', groups: ['lab-admin', 'bioinfo-admin'] },
];

const PASSWORD_CHARS =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';

/** 内网账号使用 @local 等无点域名，AntD 默认 email 规则会误判。 */
const EMAIL_RULE = {
  validator: (_: unknown, value: string) => {
    if (!value || /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(value)) {
      return Promise.resolve();
    }
    return Promise.reject(new Error('邮箱格式不正确'));
  },
};

/** 生成带大小写、数字与符号的初始口令（避开易混淆字符）。 */
function generatePassword(length = 16): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  const required = ['A', 'a', '2', '!'];
  const chars = Array.from(bytes, (n) => PASSWORD_CHARS[n % PASSWORD_CHARS.length]);
  for (let i = 0; i < required.length; i += 1) chars[i] = required[i];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const swap = bytes[i] % (i + 1);
    [chars[i], chars[swap]] = [chars[swap], chars[i]];
  }
  return chars.join('');
}

/** 统一账号管理：Casdoor 是唯一身份源，本页直接读写并写入审计表。 */
function AccountsAdmin() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<AccountItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [pwTarget, setPwTarget] = useState<AccountItem | null>(null);
  const [deleting, setDeleting] = useState<AccountItem | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [created, setCreated] = useState<{ name: string; password: string; groups: string[] } | null>(null);
  const [pwResult, setPwResult] = useState<{ name: string; password: string } | null>(null);
  const [editGrants, setEditGrants] = useState<FileGrant[]>([]);
  const [previewTarget, setPreviewTarget] = useState<AccountItem | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled' | 'admin'>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [editForm] = Form.useForm();
  const [createForm] = Form.useForm();
  const [pwForm] = Form.useForm();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['admin-accounts', q],
    queryFn: () => api.accounts(q),
    staleTime: 15_000,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin-accounts'] });
    void refetch();
  };

  type AccountPatch = Parameters<typeof api.updateAccount>[1];

  const update = useMutation({
    mutationFn: async ({
      name,
      body,
      grants,
    }: {
      name: string;
      body: AccountPatch;
      grants?: FileGrant[];
    }) => {
      const res = await api.updateAccount(name, body);
      // 改名后后续的文件授权必须挂到新账号上
      if (grants) await api.setAccountFileGrants(res.account.name, grants);
      return res;
    },
    onSuccess: (_, v) => {
      const toggling = 'isForbidden' in v.body && Object.keys(v.body).length === 1;
      const renamed = Boolean(v.body.newName) && v.body.newName !== v.name;
      message.success(
        renamed
          ? `账号已改名为 ${v.body.newName}`
          : toggling
            ? v.body.isForbidden
              ? '账号已禁用'
              : '账号已启用'
            : '账号已更新',
      );
      setEditing(null);
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const create = useMutation({
    mutationFn: (v: { name: string; displayName?: string; email?: string; groups: string[]; password: string }) =>
      api.createAccount(v),
    onSuccess: (res, v) => {
      message.success(`账号 ${res.account.name} 已创建`);
      setCreated({ name: res.account.name, password: v.password, groups: v.groups });
      setCreating(false);
      createForm.resetFields();
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const resetPassword = useMutation({
    mutationFn: ({ name, password }: { name: string; password: string }) =>
      api.resetAccountPassword(name, password),
    onSuccess: (_, v) => {
      message.success('口令已重置');
      setPwResult({ name: v.name, password: v.password });
      setPwTarget(null);
      pwForm.resetFields();
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const provision = useMutation({
    mutationFn: (name: string) => api.provisionAccount(name),
    onSuccess: (_, name) => {
      message.success('个人文件空间已初始化');
      setEditing((prev) => (prev && prev.name === name ? { ...prev, homeReady: true } : prev));
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const remove = useMutation({
    mutationFn: ({ name, confirm }: { name: string; confirm: string }) =>
      api.deleteAccount(name, confirm),
    onSuccess: (res) => {
      const purged = Object.values(res.purged ?? {}).reduce((a, b) => a + (b || 0), 0);
      message.success(`账号 ${res.name} 已删除：个人文件 ${res.files?.removedPaths ?? 0} 项，业务数据 ${purged} 条`);
      setDeleting(null);
      setDeleteConfirm('');
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const groupOptions = (data?.groups ?? []).map((g) => ({
    value: g.name,
    label: g.displayName && g.displayName !== g.name ? `${g.displayName}（${g.name}）` : g.name,
  }));

  /** 该账号通过所属用户组继承到的目录权限（同一目录只保留最强的一档）。 */
  const groupGrantsFor = (groups: string[] = []) => {
    const rank: Record<FileGrant['access'], number> = { deny: 2, write: 1, read: 0 };
    const best = new Map<string, FileGrant>();
    for (const group of groups) {
      const template = (data?.fileGroups ?? []).find((g) => g.name === group);
      for (const grant of template?.grants ?? []) {
        const key = `${grant.source}\u0000${grant.path}`;
        const current = best.get(key);
        if (!current || rank[grant.access] > rank[current.access]) {
          best.set(key, grant);
        }
      }
    }
    return [...best.values()];
  };

  const openEdit = (account: AccountItem) => {
    setEditing(account);
    setEditGrants(account.fileGrants ?? []);
    editForm.setFieldsValue({
      newName: account.name,
      displayName: account.displayName,
      email: account.email,
      groups: account.groups,
      isForbidden: account.isForbidden,
    });
  };

  const accounts = data?.accounts ?? [];
  const filteredAccounts = useMemo(() => {
    if (statusFilter === 'all') return accounts;
    if (statusFilter === 'admin') return accounts.filter((a) => a.isAdmin);
    if (statusFilter === 'disabled') return accounts.filter((a) => a.isForbidden);
    return accounts.filter((a) => !a.isForbidden);
  }, [accounts, statusFilter]);

  const counts = useMemo(
    () => ({
      total: accounts.length,
      active: accounts.filter((a) => !a.isForbidden).length,
      disabled: accounts.filter((a) => a.isForbidden).length,
      admins: accounts.filter((a) => a.isAdmin).length,
    }),
    [accounts],
  );

  const bulkToggle = async (isForbidden: boolean) => {
    const targets = accounts.filter(
      (a) => selected.includes(a.name) && a.isForbidden !== isForbidden && !a.isAdmin,
    );
    if (!targets.length) {
      message.info(isForbidden ? '所选账号都已被禁用' : '所选账号都已启用');
      return;
    }
    setBulkBusy(true);
    const results = await Promise.allSettled(targets.map((a) => api.updateAccount(a.name, { isForbidden })));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const bad = results.length - ok;
    message[bad ? 'warning' : 'success'](
      `${isForbidden ? '禁用' : '启用'} ${ok} 个账号${bad ? `，失败 ${bad} 个` : ''}`,
    );
    setSelected([]);
    setBulkBusy(false);
    refresh();
  };

  return (
    <Flex vertical gap={16}>
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}>
          <ProStat icon={<TeamOutlined />} title="账号总数" value={counts.total} hint="Casdoor 同步" />
        </Col>
        <Col xs={12} md={6}>
          <ProStat
            icon={<CheckCircleOutlined />}
            title="正常使用"
            value={counts.active}
            color="#16A34A"
            hint={`占比 ${counts.total ? Math.round((counts.active / counts.total) * 100) : 0}%`}
          />
        </Col>
        <Col xs={12} md={6}>
          <ProStat
            icon={<StopOutlined />}
            title="已禁用"
            value={counts.disabled}
            color={counts.disabled ? '#DC2626' : '#64748B'}
            hint="可随时恢复"
          />
        </Col>
        <Col xs={12} md={6}>
          <ProStat
            icon={<SafetyCertificateOutlined />}
            title="管理员"
            value={counts.admins}
            color="#7C3AED"
            hint="拥有后台权限"
          />
        </Col>
      </Row>

      <Card
      size="small"
      title={
        <Space size={8}>
          <span>统一账号</span>
          <Tag variant="filled">{data?.total ?? 0}</Tag>
        </Space>
      }
      extra={
        <Space wrap>
          <Segmented
            size="small"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as typeof statusFilter)}
            options={[
              { value: 'all', label: '全部' },
              { value: 'active', label: '正常' },
              { value: 'disabled', label: '已禁用' },
              { value: 'admin', label: '管理员' },
            ]}
          />
          <Input.Search
            allowClear
            placeholder="搜索用户名 / 姓名 / 邮箱"
            style={{ width: 240 }}
            onSearch={(v) => setQ(v.trim())}
            onChange={(e) => {
              if (!e.target.value) setQ('');
            }}
          />
          <Button type="primary" onClick={() => setCreating(true)}>
            新建账号
          </Button>
        </Space>
      }
    >
      {selected.length ? (
        <Flex
          align="center"
          justify="space-between"
          wrap
          gap={8}
          style={{
            marginBottom: 10,
            padding: '8px 12px',
            borderRadius: 8,
            background: 'var(--ant-color-primary-bg)',
          }}
        >
          <Typography.Text>
            已选择 <Typography.Text strong>{selected.length}</Typography.Text> 个账号
          </Typography.Text>
          <Space wrap>
            <Button size="small" loading={bulkBusy} onClick={() => void bulkToggle(false)}>
              批量启用
            </Button>
            <Popconfirm
              title={`禁用所选的 ${selected.length} 个账号？`}
              description="禁用后这些账号将无法登录门户与已接入服务。"
              okText="禁用"
              cancelText="取消"
              onConfirm={() => void bulkToggle(true)}
            >
              <Button size="small" danger loading={bulkBusy}>
                批量禁用
              </Button>
            </Popconfirm>
            <Button size="small" type="text" onClick={() => setSelected([])}>
              取消选择
            </Button>
          </Space>
        </Flex>
      ) : null}
      <Table<AccountItem>
        size="small"
        rowKey="name"
        loading={isLoading}
        scroll={{ x: 1100 }}
        dataSource={filteredAccounts}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys.map(String)),
          getCheckboxProps: (r) => ({ disabled: r.isAdmin }),
        }}
        pagination={{
          pageSize: 20,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 个账号`,
        }}
        locale={{ emptyText: q ? '没有匹配的账号' : '暂无账号' }}
        columns={[
          {
            title: '用户名',
            dataIndex: 'name',
            width: 170,
            render: (v: string, r) => (
              <Space size={6}>
                <Typography.Text strong style={{ fontFamily: 'monospace' }}>
                  {v}
                </Typography.Text>
                {r.isAdmin ? <Tag color="red" variant="filled">管理员</Tag> : null}
              </Space>
            ),
          },
          { title: '姓名', dataIndex: 'displayName', width: 130, render: (v: string) => v || '-' },
          { title: '邮箱', dataIndex: 'email', ellipsis: true },
          {
            title: '角色组',
            dataIndex: 'groups',
            render: (groups: string[]) => (
              <Space size={[4, 4]} wrap>
                {(groups ?? []).map((g) => (
                  <Tag key={g} color={GROUP_COLOR[g] ?? 'blue'} variant="filled">
                    {g}
                  </Tag>
                ))}
                {!groups?.length ? <Typography.Text type="secondary">未分配</Typography.Text> : null}
              </Space>
            ),
          },
          {
            title: '文件权限',
            dataIndex: 'fileGrants',
            width: 280,
            render: (grants: FileGrant[], account) => {
              // 个人权限是真实生效的那一层；组授权单独标注，避免"看起来没配权限"
              // 其实一直靠组在兜底。
              const inherited = groupGrantsFor(account.groups);
              return (
                <Flex vertical gap={4}>
                  <GrantList grants={grants ?? []} empty="无个人授权" />
                  {inherited.length ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      来自用户组：
                    </Typography.Text>
                  ) : null}
                  {inherited.length ? <GrantList grants={inherited} empty="" /> : null}
                </Flex>
              );
            },
          },
          {
            title: '状态',
            dataIndex: 'isForbidden',
            width: 90,
            render: (v: boolean) =>
              v ? <Tag color="error">已禁用</Tag> : <Tag color="success">正常</Tag>,
          },
          {
            title: '最近登录',
            dataIndex: 'lastSigninAt',
            width: 170,
            render: (v: string) => formatCasdoorTime(v),
          },
          {
            title: '操作',
            width: 260,
            render: (_: unknown, r) => (
              <Space size={4} wrap>
                <Button size="small" type="link" onClick={() => openEdit(r)}>
                  编辑
                </Button>
                <Button size="small" type="link" onClick={() => setPreviewTarget(r)}>
                  权限预演
                </Button>
                <Button size="small" type="link" onClick={() => setPwTarget(r)}>
                  重置口令
                </Button>
                {r.isForbidden ? (
                  <Button
                    size="small"
                    type="link"
                    loading={update.isPending}
                    onClick={() => update.mutate({ name: r.name, body: { isForbidden: false } })}
                  >
                    启用
                  </Button>
                ) : (
                  <Popconfirm
                    title="禁用该账号？"
                    description="禁用后无法登录门户与所有已接入服务，已登录的会话立即失效，可随时恢复。"
                    okText="禁用"
                    cancelText="取消"
                    onConfirm={() => update.mutate({ name: r.name, body: { isForbidden: true } })}
                  >
                    <Button size="small" type="link" danger>
                      禁用
                    </Button>
                  </Popconfirm>
                )}
                <Button
                  size="small"
                  type="link"
                  danger
                  onClick={() => {
                    setDeleting(r);
                    setDeleteConfirm('');
                  }}
                >
                  删除
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        open={Boolean(editing)}
        title={`编辑账号：${editing?.name ?? ''}`}
        okText="保存"
        cancelText="取消"
        confirmLoading={update.isPending}
        onCancel={() => setEditing(null)}
        onOk={() =>
          editForm.validateFields().then((v) =>
            update.mutate({
              name: editing?.name ?? '',
              body: {
                newName: v.newName?.trim() || undefined,
                displayName: v.displayName ?? '',
                email: v.email ?? '',
                groups: v.groups ?? [],
                isForbidden: Boolean(v.isForbidden),
              },
              grants: data?.fileAccessAvailable ? editGrants : undefined,
            }),
          )
        }
      >
        <Alert
          type={editing?.homeReady ? 'success' : 'warning'}
          showIcon
          style={{ marginBottom: 16 }}
          title={editing?.homeReady ? '个人文件空间已就绪' : '个人文件空间尚未初始化'}
          description={
            editing?.homeReady
              ? '个人目录仅本人可见，管理员也无法浏览。'
              : '未初始化时该用户无法保存个人文件。'
          }
          action={
            editing && !editing.homeReady ? (
              <Button
                size="small"
                loading={provision.isPending}
                onClick={() => provision.mutate(editing.name)}
              >
                立即初始化
              </Button>
            ) : undefined
          }
        />
        <Form form={editForm} layout="vertical">
          <Form.Item
            name="newName"
            label="账号标识（登录名）"
            rules={[
              { required: true, message: '请输入账号标识' },
              { pattern: /^[a-z][a-z0-9._-]{2,31}$/, message: '字母开头，仅小写字母/数字/._-，3–32 位' },
            ]}
            extra="改名后需用新登录名登录，旧登录名的令牌会失效；邮箱和个人文件保持不变。"
          >
            <Input maxLength={32} placeholder="例如：student03" autoComplete="off" />
          </Form.Item>
          <Form.Item name="displayName" label="姓名">
            <Input maxLength={100} placeholder="例如：学生 1" />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[EMAIL_RULE]}>
            <Input maxLength={100} placeholder="student01@local" />
          </Form.Item>
          <Form.Item
            name="groups"
            label="角色组"
            rules={[{ required: true, message: '请至少选择一个角色组' }]}
            extra="角色组决定门户与各服务中的权限，至少保留一个角色。"
          >
            <Select mode="multiple" options={groupOptions} placeholder="选择角色组" />
          </Form.Item>
          <Form.Item
            label="文件目录权限"
            extra={
              data?.fileAccessAvailable
                ? '这里只是个人权限：留空并不代表没有访问权，用户组仍会授予默认目录；单独收回优先于用户组与管理员身份。个人空间始终仅本人可读写。'
                : '文件核心暂不可用，目录权限暂时无法修改。'
            }
          >
            {editing ? (
              <Flex vertical gap={8} style={{ marginBottom: 12 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  来自用户组（{editing.groups.join('、') || '未分配'}）：
                </Typography.Text>
                <GrantList grants={groupGrantsFor(editing.groups)} empty="该账号所属用户组未配置共享目录" />
              </Flex>
            ) : null}
            <GrantEditor
              grants={editGrants}
              directories={data?.directories ?? {}}
              disabled={!data?.fileAccessAvailable}
              onChange={setEditGrants}
            />
          </Form.Item>
          <Form.Item name="isForbidden" label="禁用账号" valuePropName="checked" extra="禁用后该账号无法登录，已登录的会话立即失效，数据与工作区保留。">
            <Switch checkedChildren="已禁用" unCheckedChildren="正常" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={Boolean(previewTarget)}
        title={`权限预演：${previewTarget?.name ?? ''}`}
        width={760}
        footer={
          <Button onClick={() => setPreviewTarget(null)} type="primary">
            关闭
          </Button>
        }
        onCancel={() => setPreviewTarget(null)}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          下表按真实生效顺序计算：单独收回 &gt; 个人权限 &gt; 用户组 &gt; 管理员身份。
          改完权限后重新打开可立即确认实际效果。
        </Typography.Paragraph>
        {previewTarget ? <AccessPreview name={previewTarget.name} /> : null}
      </Modal>

      <Modal
        open={creating}
        title="新建账号"
        okText="创建"
        cancelText="取消"
        confirmLoading={create.isPending}
        onCancel={() => setCreating(false)}
        onOk={() => createForm.validateFields().then((v) => create.mutate(v))}
      >
        <Form
          form={createForm}
          layout="vertical"
          onValuesChange={(changed) => {
            if ('name' in changed && !createForm.isFieldTouched('email')) {
              const name = String(changed.name ?? '').trim();
              createForm.setFieldValue('email', name ? `${name}@local` : '');
            }
          }}
        >
          <Form.Item
            name="name"
            label="用户名"
            rules={[
              { required: true, message: '请输入用户名' },
              { pattern: /^[a-z][a-z0-9._-]{2,31}$/, message: '字母开头，仅小写字母/数字/._-，3–32 位' },
            ]}
            extra="用户名同时用于 Casdoor 与生信实训平台，创建后可在编辑账号时修改。"
          >
            <Input placeholder="例如：student03" autoComplete="off" />
          </Form.Item>
          <Form.Item name="displayName" label="姓名">
            <Input maxLength={100} placeholder="例如：学生 3" />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[EMAIL_RULE]}>
            <Input maxLength={100} placeholder="student03@local" />
          </Form.Item>
          <Form.Item
            name="groups"
            label="角色组"
            initialValue={['lab-student', 'bioinfo-student']}
            rules={[{ required: true, message: '请至少选择一个角色组' }]}
            extra={
              <Space size={4} wrap style={{ marginTop: 6 }}>
                <Typography.Text type="secondary">快速选择：</Typography.Text>
                {ROLE_PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    size="small"
                    onClick={() => createForm.setFieldValue('groups', preset.groups)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </Space>
            }
          >
            <Select mode="multiple" options={groupOptions} placeholder="选择角色组" />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始口令"
            rules={[
              { required: true, message: '请输入初始口令' },
              { min: 10, message: '至少 10 个字符' },
            ]}
            extra={
              <Space size={8} wrap style={{ marginTop: 6 }}>
                <Typography.Text type="secondary">
                  至少 10 个字符，创建完成后仅显示一次。
                </Typography.Text>
                <Button
                  size="small"
                  onClick={() => createForm.setFieldValue('password', generatePassword())}
                >
                  生成强口令
                </Button>
              </Space>
            }
          >
            <Input.Password placeholder="至少 10 个字符" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={Boolean(deleting)}
        title={`删除账号：${deleting?.name ?? ''}`}
        okText="确认硬删除"
        okButtonProps={{ danger: true, disabled: deleteConfirm !== (deleting?.name ?? '') }}
        cancelText="取消"
        confirmLoading={remove.isPending}
        onCancel={() => {
          setDeleting(null);
          setDeleteConfirm('');
        }}
        onOk={() =>
          deleting ? remove.mutate({ name: deleting.name, confirm: deleteConfirm }) : undefined
        }
      >
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          title="硬删除不可恢复"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>统一身份源账号与全部登录会话（含已登录的浏览器）</li>
              <li>个人文件空间 /srv/lab/users/{deleting?.name ?? ''} 及该账号的文件授权</li>
              <li>个人工作台、Agent 会话与消息、收藏与最近访问、绘图、其上传的知识库文档</li>
              <li>全站公告只隐去作者署名，公告内容保留</li>
              <li>当晚的 /srv/lab 全量备份可能仍含已删文件，但不作为可依赖的回滚</li>
            </ul>
          }
        />
        <Input
          value={deleteConfirm}
          onChange={(e) => setDeleteConfirm(e.target.value)}
          placeholder={`输入账号标识 ${deleting?.name ?? ''} 以确认`}
          maxLength={64}
        />
      </Modal>

      <Modal
        open={Boolean(pwTarget)}
        title={`重置口令：${pwTarget?.name ?? ''}`}
        okText="重置"
        cancelText="取消"
        confirmLoading={resetPassword.isPending}
        onCancel={() => setPwTarget(null)}
        onOk={() =>
          pwForm.validateFields().then((v) =>
            resetPassword.mutate({ name: pwTarget?.name ?? '', password: v.password }),
          )
        }
      >
        <Form form={pwForm} layout="vertical">
          <Form.Item
            name="password"
            label="新口令"
            rules={[
              { required: true, message: '请输入新口令' },
              { min: 10, message: '至少 10 个字符' },
            ]}
            extra={
              <Space size={8} wrap style={{ marginTop: 6 }}>
                <Typography.Text type="secondary">
                  重置后旧口令立即失效；生信实训平台使用同一口令。
                </Typography.Text>
                <Button
                  size="small"
                  onClick={() => pwForm.setFieldValue('password', generatePassword())}
                >
                  生成强口令
                </Button>
              </Space>
            }
          >
            <Input.Password placeholder="至少 10 个字符" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={Boolean(created)}
        title="账号已创建"
        onCancel={() => setCreated(null)}
        footer={
          <Button type="primary" onClick={() => setCreated(null)}>
            完成
          </Button>
        }
      >
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 16 }}
          title={`账号 ${created?.name ?? ''} 已创建，个人文件空间已初始化`}
        />
        <Descriptions
          column={1}
          size="small"
          bordered
          items={[
            {
              key: 'name',
              label: '用户名',
              children: <Typography.Text copyable>{created?.name}</Typography.Text>,
            },
            {
              key: 'password',
              label: '初始口令',
              children: <Typography.Text copyable>{created?.password}</Typography.Text>,
            },
            {
              key: 'groups',
              label: '角色组',
              children: (created?.groups ?? []).join('、'),
            },
          ]}
        />
        <Typography.Paragraph type="secondary" style={{ margin: '12px 0 0' }}>
          初始口令仅显示这一次，请通过安全渠道交付并提醒用户妥善保管。
          <Typography.Text
            copyable={{
              text: `用户名：${created?.name ?? ''}\n初始口令：${created?.password ?? ''}\n角色组：${(created?.groups ?? []).join('、')}`,
            }}
            style={{ marginInlineStart: 8 }}
          >
            复制交付信息
          </Typography.Text>
        </Typography.Paragraph>
      </Modal>

      <Modal
        open={Boolean(pwResult)}
        title="口令已重置"
        onCancel={() => setPwResult(null)}
        footer={
          <Button type="primary" onClick={() => setPwResult(null)}>
            完成
          </Button>
        }
      >
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 16 }}
          title={`账号 ${pwResult?.name ?? ''} 的新口令已生效`}
        />
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          新口令：<Typography.Text copyable>{pwResult?.password}</Typography.Text>
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          请立即通过安全渠道告知用户；旧口令与生信实训平台的登录口令均已失效。
        </Typography.Paragraph>
      </Modal>
    </Card>
    </Flex>
  );
}

function AnnouncementAdmin() {
  const { data, refetch } = useQuery({ queryKey: ['announcements'], queryFn: api.announcements });
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: (v: { title: string; content: string; level: string }) =>
      fetch('/api/announcements', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': decodeURIComponent(
            document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] || '',
          ),
        },
        body: JSON.stringify(v),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || '保存失败');
        return r.json();
      }),
    onSuccess: () => {
      message.success('公告已发布');
      setOpen(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['announcements'] });
      void refetch();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const del = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/announcements/${id}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          'X-CSRF-Token': decodeURIComponent(
            document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] || '',
          ),
        },
      }),
    onSuccess: () => {
      message.success('已删除');
      void qc.invalidateQueries({ queryKey: ['announcements'] });
      void refetch();
    },
  });

  return (
    <Card
      size="small"
      title="公告管理"
      extra={
        <Button type="primary" size="small" onClick={() => setOpen(true)}>
          发布公告
        </Button>
      }
    >
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={data?.announcements ?? []}
        locale={{ emptyText: '暂无公告，点击右上角发布' }}
        columns={[
          { title: '标题', dataIndex: 'title' },
          { title: '内容', dataIndex: 'content', ellipsis: true },
          { title: '级别', dataIndex: 'level', width: 90, render: (v: string) => <Tag variant="filled">{v}</Tag> },
          { title: '发布时间', dataIndex: 'created_at', width: 180, render: (v: string) => (v ? new Date(v).toLocaleString('zh-CN') : '-') },
          {
            title: '操作',
            width: 80,
            render: (_: unknown, r: any) => (
              <Popconfirm title="删除该公告？" onConfirm={() => del.mutate(r.id)}>
                <Button size="small" danger type="text">
                  删除
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />
      <Modal
        open={open}
        title="发布公告"
        okText="发布"
        cancelText="取消"
        confirmLoading={save.isPending}
        onOk={() => form.validateFields().then((v) => save.mutate(v))}
        onCancel={() => setOpen(false)}
      >
        <Form form={form} layout="vertical" initialValues={{ level: 'info' }}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="例如：本周六生信实操安排" maxLength={120} />
          </Form.Item>
          <Form.Item name="level" label="级别">
            <Select options={[{ value: 'info', label: '普通' }, { value: 'warning', label: '提醒' }, { value: 'success', label: '通知' }]} />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true, message: '请输入内容' }]}>
            <Input.TextArea rows={4} maxLength={4000} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

/** 企业微信：群机器人 Webhook 通知（公告同步 + 每日任务摘要）。 */
function WeComAdmin() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const { data } = useQuery({
    queryKey: ['admin-wecom'],
    queryFn: () => api.wecomConfig(),
    staleTime: 30_000,
  });
  const save = useMutation({
    mutationFn: (v: {
      enabled: boolean;
      webhookUrl: string;
      announcements: boolean;
      dailyDigest: boolean;
      digestTime: string;
    }) => api.updateWecom(v),
    onSuccess: (res) => {
      message.success('企业微信配置已保存');
      qc.setQueryData(['admin-wecom'], res);
    },
    onError: (e: Error) => message.error(e.message),
  });
  const test = useMutation({
    mutationFn: () => api.testWecom(),
    onSuccess: (res) => message.success(res.detail || '测试消息已发送'),
    onError: (e: Error) => message.error(e.message),
  });

  useEffect(() => {
    if (data) form.setFieldsValue(data);
  }, [data, form]);

  return (
    <Card
      size="small"
      title={
        <Space size={8}>
          <span>企业微信通知</span>
          <Tag color={data?.enabled ? 'green' : 'default'} variant="filled">
            {data?.enabled ? '已启用' : '未启用'}
          </Tag>
        </Space>
      }
      extra={
        <Button
          onClick={() => test.mutate()}
          loading={test.isPending}
          disabled={!data?.configured}
        >
          发送测试
        </Button>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title="使用企业微信群机器人 Webhook"
        description="只推送公告与每日任务摘要，不读取通讯录、聊天或文件；Webhook 密钥保存后仅脱敏显示。"
      />
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          enabled: false,
          webhookUrl: '',
          announcements: true,
          dailyDigest: false,
          digestTime: '08:30',
        }}
      >
        <Form.Item
          name="webhookUrl"
          label="Webhook 地址"
          extra="在企业微信群 → 添加群机器人 → 复制 Webhook 地址；留空保存可清除。"
        >
          <Input
            maxLength={500}
            placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
            autoComplete="off"
          />
        </Form.Item>
        <Flex gap={24} wrap>
          <Form.Item name="enabled" label="启用通知" valuePropName="checked">
            <Switch checkedChildren="已启用" unCheckedChildren="未启用" />
          </Form.Item>
          <Form.Item name="announcements" label="公告同步" valuePropName="checked">
            <Switch checkedChildren="已开启" unCheckedChildren="已关闭" />
          </Form.Item>
          <Form.Item name="dailyDigest" label="每日任务摘要" valuePropName="checked">
            <Switch checkedChildren="已开启" unCheckedChildren="已关闭" />
          </Form.Item>
          <Form.Item
            name="digestTime"
            label="摘要发送时间"
            rules={[{ pattern: /^([01]\d|2[0-3]):[0-5]\d$/, message: '格式为 HH:MM' }]}
          >
            <Input style={{ width: 120 }} placeholder="08:30" />
          </Form.Item>
        </Flex>
        <Button type="primary" loading={save.isPending} onClick={() => form.validateFields().then((v) => save.mutate(v))}>
          保存配置
        </Button>
      </Form>
    </Card>
  );
}

function BackupAdmin() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['admin-backups'],
    queryFn: api.adminBackups,
    refetchInterval: 60_000,
  });
  const disk = data?.disk;
  const snapshots = data?.snapshots ?? [];
  return (
    <Flex vertical gap={16}>
      <Row gutter={[12, 12]}>
        <Col xs={24} md={8}>
          <ProStat
            icon={<DatabaseOutlined />}
            title="备份盘可用"
            value={disk ? formatBytes(disk.free) : '-'}
            color="#16A34A"
            hint={disk?.mount ?? '/srv/labbackup'}
          />
        </Col>
        <Col xs={24} md={8}>
          <ProStat
            icon={<CloudServerOutlined />}
            title="快照数量"
            value={String(snapshots.length)}
            hint={data?.repo ?? '等待备份记录'}
          />
        </Col>
        <Col xs={24} md={8}>
          <ProStat
            icon={<SafetyCertificateOutlined />}
            title="保留策略"
            value={data?.keep_within ?? '3d'}
            hint={data?.outcome === 'failed' ? '最近一次备份失败' : '后台自动增量备份'}
            color={data?.outcome === 'failed' ? '#DC2626' : '#2563EB'}
          />
        </Col>
      </Row>
      <Card
        size="small"
        title="备份快照"
        extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => void refetch()}>刷新</Button>}
      >
        {data?.available === false ? (
          <Alert type="info" showIcon title={data.detail ?? '尚无备份记录'} />
        ) : (
          <>
            <Descriptions
              size="small"
              column={{ xs: 1, md: 2 }}
              items={[
                { key: 'repo', label: '仓库', children: data?.repo ?? '-' },
                { key: 'generated', label: '状态时间', children: data?.generated_at ? formatCasdoorTime(data.generated_at) : '-' },
                { key: 'scope', label: '最近范围', children: data?.scope ?? '-' },
                { key: 'outcome', label: '结果', children: data?.outcome === 'failed' ? <Tag color="red">失败</Tag> : <Tag color="green">成功</Tag> },
              ]}
            />
            <Table
              style={{ marginTop: 12 }}
              size="small"
              rowKey="id"
              loading={isLoading}
              dataSource={snapshots}
              pagination={{ pageSize: 8, size: 'small' }}
              columns={[
                { title: '快照', dataIndex: 'id', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
                { title: '时间', dataIndex: 'time', render: (v: string) => formatCasdoorTime(v) },
                { title: '主机', dataIndex: 'hostname' },
                { title: '标签', dataIndex: 'tags', render: (v: string[]) => (v?.length ? v.map((t) => <Tag key={t}>{t}</Tag>) : '-') },
              ]}
            />
          </>
        )}
      </Card>
    </Flex>
  );
}

const ADMIN_TABS = ['status', 'users', 'announcements', 'agent', 'backups', 'settings'] as const;

export default function Admin() {
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [healthFilter, setHealthFilter] = useState<'all' | 'up' | 'down'>('all');
  const { data: info, isLoading } = useQuery({ queryKey: ['admin-info'], queryFn: api.adminInfo });
  const { data: health } = useQuery({ queryKey: ['admin-health'], queryFn: api.adminHealth, refetchInterval: 60_000 });

  if (isLoading) {
    return (
      <Flex justify="center" style={{ padding: 60 }}>
        <Spin />
      </Flex>
    );
  }

  const disk = info?.disk ?? { total: 0, used: 0, free: 0 };
  const segment = location.pathname.split('/')[2] ?? 'status';
  const activeKey = (ADMIN_TABS as readonly string[]).includes(segment) ? segment : 'status';
  const services = (health?.services ?? []).filter((s: { health?: { status?: string } }) =>
    healthFilter === 'all' ? true : s.health?.status === healthFilter,
  );

  return (
    <PageShell
      title="系统管理"
      description="服务健康、账号与权限、公告、Agent 配置和运行日志的集中控制台。"
      extra={
        <Button
          icon={<ReloadOutlined />}
          onClick={() => {
            void qc.invalidateQueries({ queryKey: ['admin-info'] });
            void qc.invalidateQueries({ queryKey: ['admin-health'] });
          }}
        >
          刷新
        </Button>
      }
    >
    <Tabs
      activeKey={activeKey}
      onChange={(key) => navigate(`/admin/${key}`)}
      items={[
        {
          key: 'status',
          label: '服务状态',
          icon: <CloudServerOutlined />,
          children: (
            <Flex vertical gap={16}>
              <Row gutter={[12, 12]}>
                <Col xs={24} md={8}>
                  <ProStat
                    icon={<DatabaseOutlined />}
                    title="数据盘总量"
                    value={formatBytes(disk.total)}
                    hint="挂载 /srv/lab"
                  />
                </Col>
                <Col xs={24} md={8}>
                  <ProStat
                    icon={<CloudServerOutlined />}
                    title="已使用"
                    value={formatBytes(disk.used)}
                    color="#2563EB"
                    hint={`占用 ${disk.total ? Math.round((disk.used / disk.total) * 100) : 0}%`}
                  />
                </Col>
                <Col xs={24} md={8}>
                  <ProStat
                    icon={<CheckCircleOutlined />}
                    title="可用"
                    value={formatBytes(disk.free)}
                    color="#16A34A"
                    hint="建议保留 10% 以上余量"
                  />
                </Col>
              </Row>

              <Row gutter={[16, 16]}>
                <Col xs={24} lg={10}>
                  <Suspense fallback={<ChartFallback />}>
                    <LazyMount height={260}>
                      <DiskUsagePanel />
                    </LazyMount>
                  </Suspense>
                </Col>
                <Col xs={24} lg={14}>
                  <LazyMount height={280}>
                    <Suspense fallback={<ChartFallback />}>
                      <ServiceHealthDonut
                        source="admin"
                        description="按健康探测结果统计各状态的服务数量（管理员视角）"
                      />
                    </Suspense>
                  </LazyMount>
                </Col>
              </Row>

              <ProTableCard
                title="服务健康检查"
                description="每分钟自动探测一次，可搜索服务名或按状态筛选。"
                searchable
                searchPlaceholder="搜索服务 / 分类 / 详情"
                searchText={(row: any) =>
                  `${row.name ?? ''} ${row.category ?? ''} ${row.health?.status ?? ''} ${row.health?.detail ?? ''}`
                }
                dataSource={services}
                rowKey="id"
                onRefresh={() => void qc.invalidateQueries({ queryKey: ['admin-health'] })}
                refreshLoading={false}
                toolbar={
                  <Segmented
                    size="small"
                    value={healthFilter}
                    onChange={(v) => setHealthFilter(v as typeof healthFilter)}
                    options={[
                      { value: 'all', label: '全部' },
                      { value: 'up', label: '正常' },
                      { value: 'down', label: '异常' },
                    ]}
                  />
                }
                pagination={false}
                columns={[
                  { title: '服务', dataIndex: 'name' },
                  { title: '分类', dataIndex: 'category' },
                  {
                    title: '状态',
                    dataIndex: 'health',
                    render: (h: any) => (
                      <Tag color={h?.status === 'up' ? 'green' : h?.status === 'down' ? 'red' : 'default'} variant="filled">
                        {h?.status ?? 'unknown'}
                      </Tag>
                    ),
                  },
                  {
                    title: '响应',
                    render: (_: any, r: any) => (r.health?.latency_ms != null ? `${r.health.latency_ms} ms` : '-'),
                  },
                  { title: '详情', dataIndex: ['health', 'detail'] },
                ]}
              />
            </Flex>
          ),
        },
        {
          key: 'users',
          label: '用户和权限',
          icon: <TeamOutlined />,
          children: (
            <Flex vertical gap={16}>
              <GroupPermissions />
              <AccountsAdmin />
              <Card size="small" title="角色映射（Casdoor 同步）">
                <Descriptions
                  column={1}
                  bordered
                  size="small"
                  items={[
                    { key: 'a', label: '管理员', children: (info?.roles?.admin ?? []).join('、') },
                    { key: 't', label: '导师', children: (info?.roles?.teacher ?? []).join('、') },
                    { key: 's', label: '学生', children: 'lab-student' },
                    { key: 'p', label: '项目组', children: 'project-*' },
                    { key: 'b', label: '生信平台', children: 'bioinfo-admin / bioinfo-instructor / bioinfo-ta / bioinfo-student' },
                  ]}
                />
              </Card>
            </Flex>
          ),
        },
        {
          key: 'announcements',
          label: '公告管理',
          icon: <BellOutlined />,
          children: <AnnouncementAdmin />,
        },
        {
          key: 'agent',
          label: 'Agent 模型与配额',
          icon: <RobotOutlined />,
          children: <AgentAdmin />,
        },
        {
          key: 'backups',
          label: '备份与恢复',
          icon: <DatabaseOutlined />,
          children: <BackupAdmin />,
        },
        {
          key: 'settings',
          label: '配置与日志',
          icon: <SettingOutlined />,
          children: (
            <Flex vertical gap={16}>
              <Card size="small" title="部署信息">
                <Descriptions
                  column={1}
                  bordered
                  size="small"
                  items={[
                    { key: 'h', label: '主机', children: info?.host?.hostname },
                    { key: 'p', label: '平台', children: info?.host?.platform },
                    { key: 'c', label: 'Casdoor', children: info?.casdoor?.issuer },
                    { key: 'cid', label: 'OIDC Client ID', children: info?.casdoor?.clientId },
                  ]}
                />
              </Card>
              <WeComAdmin />
              <Card size="small" title="运行容器">
                <div style={{ maxHeight: 280, overflow: 'auto' }}>
                  {(info?.containers ?? []).map((c: string) => (
                    <div key={c} style={{ padding: '5px 4px', fontFamily: 'monospace', fontSize: 12.5 }}>
                      {c}
                    </div>
                  ))}
                </div>
              </Card>
            </Flex>
          ),
        },
      ]}
    />
    </PageShell>
  );
}
