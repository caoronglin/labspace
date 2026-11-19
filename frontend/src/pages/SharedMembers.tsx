/**
 * 组员共享（/shared）—— 导师-组员共享目录（v26.11）。
 *
 * 目录结构（物理上只有一份，挂在导师家目录下）：
 *     共享文件-组员/{学号}_{姓名}/{01_组会汇报, 02_论文, 03_其他}
 *
 * 权限：
 * - 导师：上传 / 下载 / 编辑 / 删除（整棵树，也能自己加目录）
 * - 学生：只在自己那棵目录里「查看 + 上传」，不能下载、不能改结构，
 *   删除只对 48 小时内上传的材料开放。
 *
 * 导师视角是名册管理（补目录、补授权、加人）；学生视角是自己那棵目录的入口。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudUploadOutlined,
  EditOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  LinkOutlined,
  PlusOutlined,
  ReloadOutlined,
  SyncOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import PageShell from '../components/PageShell';
import { labSharedApi, type SharedMember } from '../services/labShared';
import { errText } from '../utils/err';

const { Paragraph, Text } = Typography;

/** 状态与身份口径必须与后端一致（backend/app/lab_shared.py）。 */
const STATUS_OPTIONS = ['在研', '暂休', '已出组'];
const IDENTITY_OPTIONS = ['博士后', '博士生', '硕士生', '本科生', '实习生', '科研助理'];

/**
 * 组员名册与共享目录。
 *
 * 默认独立成页（/shared，学生从这里进自己的目录）；
 * `embedded` 时嵌进「账号管理」——名册本质是账号的延伸（学号↔账号、
 * 身份、在研/出组），放在账号旁边比单开一页更符合管理逻辑。
 */
export default function SharedMembers({ embedded = false }: { embedded?: boolean } = {}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm<{ code: string; name: string; account: string }>();
  // 编辑：改姓名 / 身份 / 状态（进组、出组、暂休）
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<SharedMember | null>(null);
  const [editForm] = Form.useForm<{
    code: string;
    name: string;
    account: string;
    status: string;
    identity: string;
  }>();

  const openEdit = (member: SharedMember) => {
    setEditing(member);
    editForm.setFieldsValue({
      code: member.code,
      name: member.displayName || member.name,
      account: member.account,
      status: member.status || '在研',
      identity: member.identity || '硕士生',
    });
    setEditOpen(true);
  };

  const members = useQuery({
    queryKey: ['lab-shared', 'members'],
    queryFn: labSharedApi.members,
    retry: false,
    staleTime: 30_000,
  });

  const data = members.data;
  const canManage = Boolean(data?.canManage);

  const syncMutation = useMutation({
    mutationFn: labSharedApi.sync,
    onSuccess: (r) => {
      if (r.problems.length) {
        message.warning(`已同步 ${r.synced}/${r.total}，有 ${r.problems.length} 项待处理：${r.problems[0]}`);
      } else {
        message.success(`目录与授权已按名册同步（${r.synced} 位组员）`);
      }
      void qc.invalidateQueries({ queryKey: ['lab-shared'] });
    },
    onError: (e) => message.error(`同步失败：${errText(e)}`),
  });

  const addMutation = useMutation({
    mutationFn: (v: { code: string; name: string; account: string }) =>
      labSharedApi.addMember({ code: v.code, name: v.name, account: v.account }),
    onSuccess: () => {
      message.success('已新增组员并创建目录');
      setAddOpen(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: ['lab-shared'] });
    },
    onError: (e) => message.error(`新增失败：${errText(e)}`),
  });

  const updateMutation = useMutation({
    mutationFn: (v: {
      id: number;
      code: string;
      name: string;
      account: string;
      status: string;
      identity: string;
    }) => labSharedApi.updateMember(v.id, v),
    onSuccess: (r) => {
      if (r.problems.length) {
        message.warning(`已更新，但有 ${r.problems.length} 项未完成：${r.problems[0]}`);
      } else if (r.renamed) {
        message.success(`已改名，目录同步为 ${r.member.folder}`);
      } else {
        message.success('已更新');
      }
      setEditOpen(false);
      void qc.invalidateQueries({ queryKey: ['lab-shared'] });
    },
    onError: (e) => message.error(`更新失败：${errText(e)}`),
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => labSharedApi.removeMember(id),
    onSuccess: () => {
      message.success('已移出名册（目录与数据保留在服务器上）');
      void qc.invalidateQueries({ queryKey: ['lab-shared'] });
    },
    onError: (e) => message.error(`移除失败：${errText(e)}`),
  });

  const stats = useMemo(() => {
    const list = data?.members ?? [];
    return {
      total: list.length,
      withAccount: list.filter((m) => m.account).length,
      pending: list.filter((m) => !m.account).length,
    };
  }, [data]);

  const columns: ColumnsType<SharedMember> = [
    {
      title: '学号',
      dataIndex: 'code',
      key: 'code',
      width: 90,
      render: (v: string) => <Text code>{v}</Text>,
    },
    {
      title: '姓名',
      dataIndex: 'displayName',
      key: 'displayName',
      width: 120,
      render: (v: string, row) => (
        <Space size={6}>
          <Text strong>{v || row.name}</Text>
          {row.displayName && row.displayName !== row.name ? (
            <Tooltip title={`名册登记名：${row.name}`}>
              <Tag>改名</Tag>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: '目录',
      dataIndex: 'folder',
      key: 'folder',
      render: (v: string) => (
        <Text code copyable={{ text: v }}>
          {v}
        </Text>
      ),
    },
    {
      title: '身份',
      dataIndex: 'identity',
      key: 'identity',
      width: 100,
      render: (v: string) => <Tag color="blue">{v || '硕士生'}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (v: string) =>
        v === '已出组' ? (
          <Tag color="default">已出组</Tag>
        ) : v === '暂休' ? (
          <Tag color="warning">暂休</Tag>
        ) : (
          <Tag color="success">在研</Tag>
        ),
    },
    {
      title: '门户账号',
      dataIndex: 'account',
      key: 'account',
      width: 140,
      render: (v: string) =>
        v ? <Tag color="success">{v}</Tag> : <Tag color="warning">未开通</Tag>,
    },
    {
      title: '权限',
      key: 'perm',
      width: 210,
      render: () => (
        <Space size={4} wrap>
          <Tag color="blue">可查看</Tag>
          <Tag color="blue">可上传</Tag>
          <Tooltip title={`删除仅限 ${data?.deleteWithinHours ?? 48} 小时内上传的材料`}>
            <Tag color="orange">{data?.deleteWithinHours ?? 48}h 内可删</Tag>
          </Tooltip>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 190,
      render: (_: unknown, row) => (
        <Space size={4} wrap>
          <Button
            size="small"
            icon={<FolderOpenOutlined />}
            onClick={() =>
              navigate(`/files?source=users&dir=${encodeURIComponent(`${data?.tree ?? ''}/${row.folder}`)}`)
            }
          >
            打开
          </Button>
          <Tooltip title="编辑姓名 / 身份 / 状态（改名会同步重建目录）">
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEdit(row)}
              aria-label={`编辑 ${row.folder}`}
            >
              编辑
            </Button>
          </Tooltip>
          <Popconfirm
            title="把该组员移出名册？"
            description="只收回访问权，目录与里面的数据仍然保留在服务器上。"
            okText="移出"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => removeMutation.mutate(row.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} aria-label={`移出 ${row.folder}`}>
              移出
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  // ---------------------------------------------------------------- 学生视角
  if (data && !canManage) {
    const mine = data.members[0];
    return (
      <PageShell
        title="组员共享文件"
        description="导师与组员共用的目录：你的材料按学号归位，导师可直接查看与批注。"
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void members.refetch()}>
            刷新
          </Button>
        }
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={14}>
            <Card
              title="我的目录"
              extra={
                <Button
                  type="primary"
                  icon={<CloudUploadOutlined />}
                  disabled={!mine}
                  onClick={() =>
                    navigate(
                      `/files?source=users&dir=${encodeURIComponent(`${data.tree}/${mine?.folder ?? ''}`)}`,
                    )
                  }
                >
                  上传材料
                </Button>
              }
            >
              {mine ? (
                <Flex vertical gap={12}>
                  <Space size={8} wrap>
                    <Text strong>{mine.displayName || mine.name}</Text>
                    <Text type="secondary">{mine.code}</Text>
                    <Tag color="blue">{mine.folder}</Tag>
                  </Space>
                  <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    你在这里可以<strong>查看</strong>和<strong>上传</strong>材料；
                    目录结构由导师维护，不能自己新建子目录或改名；
                    上传后 {data.deleteWithinHours} 小时内可以自己删除，超过就只能请导师处理。
                  </Paragraph>
                  <Space wrap>
                    {(data.defaultFolders ?? []).map((f) => (
                      <Button
                        key={f}
                        size="small"
                        icon={<FolderOpenOutlined />}
                        onClick={() =>
                          navigate(
                            `/files?source=users&dir=${encodeURIComponent(`${data.tree}/${mine.folder}/${f}`)}`,
                          )
                        }
                      >
                        {f}
                      </Button>
                    ))}
                  </Space>
                </Flex>
              ) : (
                <Empty description="导师还没有开通你的共享目录" />
              )}
            </Card>
          </Col>
          <Col xs={24} lg={10}>
            <Card title="说明">
              <Paragraph type="secondary" style={{ marginBottom: 8 }}>
                每位成员固定三个目录：01_组会汇报、02_论文、03_其他。
              </Paragraph>
              <Paragraph type="secondary" style={{ marginBottom: 8 }}>
                导师拥有整棵树的查看、上传、下载、编辑权限，还能按需要自建目录。
              </Paragraph>
              {/* 两处材料区的分工，直接写出来 —— 用户最常问的就是
                  「组会材料到底放哪」，而这两个地方以前互不相干。 */}
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 4 }}
                title="组会材料放哪？"
                description={
                  <span>
                    这里是你自己的材料区（长期保存）。
                    如果材料是<b>按周提交到组会归档</b>，请走
                    <Typography.Link style={{ marginInlineStart: 4 }} onClick={() => navigate('/meetings')}>
                      组会汇报
                    </Typography.Link>
                    —— 那条按 ISO 周归档，导师逐周授权。
                  </span>
                }
              />
            </Card>
          </Col>
        </Row>
      </PageShell>
    );
  }

  // ---------------------------------------------------------------- 导师视角
  const advisorBody = (
    <>
      <Flex justify="flex-end" wrap gap={8}>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void members.refetch()}>
            刷新
          </Button>
          <Button
            icon={<SyncOutlined />}
            loading={syncMutation.isPending}
            onClick={() => syncMutation.mutate()}
          >
            同步目录与授权
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
            新增组员
          </Button>
        </Space>
      </Flex>
      {members.isError ? (
        <Alert
          type="error"
          showIcon
          title="读取名册失败"
          description={errText(members.error)}
          action={
            <Button size="small" onClick={() => void members.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={8} lg={6}>
          <Card>
            <Statistic title="在册组员" value={stats.total} suffix="人" />
          </Card>
        </Col>
        <Col xs={24} sm={8} lg={6}>
          <Card>
            <Statistic title="已开通账号" value={stats.withAccount} suffix="人" valueStyle={{ color: '#16A34A' }} />
          </Card>
        </Col>
        <Col xs={24} sm={8} lg={6}>
          <Card>
            <Statistic title="待开通账号" value={stats.pending} suffix="人" valueStyle={{ color: '#D97706' }} />
          </Card>
        </Col>
        <Col xs={24} lg={6}>
          <Card>
            <Statistic title="共享树" value={data?.treeName ?? '共享文件-组员'} valueStyle={{ fontSize: 16 }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {data?.tree ?? ''}
            </Text>
          </Card>
        </Col>
      </Row>

      <Card
        title={
          <Space>
            <TeamOutlined />
            组员名册
          </Space>
        }
        extra={
          <Text type="secondary" style={{ fontSize: 12 }}>
            学生的权限固定为「可查看 + 可上传 + {data?.deleteWithinHours ?? 48}h 内可删」
          </Text>
        }
      >
        <Table<SharedMember>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={data?.members ?? []}
          loading={members.isLoading}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{
            emptyText: <Empty description="名册还是空的，点右上角「新增组员」开始" />,
          }}
          scroll={{ x: 900 }}
        />
      </Card>

      <Modal
        title={editing ? `编辑 ${editing.folder}` : '编辑组员'}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        okText="保存"
        cancelText="取消"
        confirmLoading={updateMutation.isPending}
        onOk={() => editForm.submit()}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          title="改名会同步重建目录"
          description="目录名是「学号_姓名」，只改数据库会让名册和文件树对不上。改名为「已出组」只收回访问权，目录与文件全部保留。"
          style={{ marginBottom: 12 }}
        />
        <Form
          form={editForm}
          layout="vertical"
          onFinish={(v) =>
            editing && updateMutation.mutate({ id: editing.id, ...v })
          }
        >
          <Form.Item name="code" label="学号" rules={[{ required: true, message: '请填写学号' }]}>
            <Input placeholder="2605" />
          </Form.Item>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请填写姓名' }]}>
            <Input placeholder="钱同学" />
          </Form.Item>
          <Form.Item name="identity" label="身份">
            <Select options={IDENTITY_OPTIONS.map((v) => ({ value: v, label: v }))} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select
              options={STATUS_OPTIONS.map((v) => ({
                value: v,
                label: v === '已出组' ? '已出组（收回访问权，保留数据）' : v,
              }))}
            />
          </Form.Item>
          <Form.Item name="account" label="门户账号" extra="账号建好后填这里；留空表示还没开通">
            <Input placeholder="student02" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="新增组员"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        okText="新增并建目录"
        cancelText="取消"
        confirmLoading={addMutation.isPending}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Paragraph type="secondary">
          目录会自动建成 <Text code>{'{学号}_{姓名}'}</Text>，并带上 01_组会汇报 / 02_论文 / 03_其他。
        </Paragraph>
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => addMutation.mutate(v)}
          initialValues={{ code: '', name: '', account: '' }}
        >
          <Form.Item
            name="code"
            label="学号"
            rules={[{ required: true, message: '请填写学号' }]}
            extra="只用数字，例如 2605"
          >
            <Input placeholder="2605" />
          </Form.Item>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请填写姓名' }]}>
            <Input placeholder="钱同学" />
          </Form.Item>
          <Form.Item
            name="account"
            label="门户账号（可留空）"
            extra="账号开通后填这里（邮箱前缀，如 student02），该生就能看到自己的目录"
          >
            <Input placeholder="student02" prefix={<LinkOutlined />} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );

  if (embedded) return advisorBody;
  return (
    <PageShell
      title="组员共享文件"
      description="每位组员固定 01_组会汇报 / 02_论文 / 03_其他 三个目录；导师可自设更多，学生不可。"
    >
      {advisorBody}
    </PageShell>
  );
}
