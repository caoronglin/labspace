/**
 * 课题资料（/research）。
 *
 * 目录命名规则：`{进组时间YYYY-MM-DD}-{姓名}`，一个学生一个目录。
 * - **学生**只能看到自己的目录（`GET /api/research/mine`）；
 * - **老师 / 管理员**能看到全部学生的目录，并可开通 / 收回访问授权
 *   （收回只删授权，**不删数据**，界面必须把这句话讲清楚）。
 *
 * 页面风格：antd 6 原生组件 + 无任何第三方 UI 依赖；窄屏自动上下排列。
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
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  FolderOpenOutlined,
  LinkOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import PageShell from '../components/PageShell';
import { useAuth } from '../app/AuthContext';
import { api, type PeopleEntry } from '../services/api';
import { researchApi, type ResearchFolder } from '../services/labspaces';
import { errText } from '../utils/err';

import { formatSize } from '../utils/format';
import { palette } from '../theme/palette';
const { Paragraph, Text } = Typography;

// 大小格式化统一走 utils/format（见该文件顶部说明）
const formatBytes = formatSize;

export default function ResearchFolders() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { isTeacher, isAdmin, loading: authLoading } = useAuth();
  const canManage = isTeacher || isAdmin;

  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<{ account: string }>();

  // 老师视角看全部；学生视角看自己的。
  const folders = useQuery({
    queryKey: ['research', 'folders'],
    queryFn: researchApi.folders,
    enabled: canManage,
    retry: false,
  });
  const mine = useQuery({
    queryKey: ['research', 'mine'],
    queryFn: researchApi.mine,
    enabled: !authLoading && !canManage,
    retry: false,
  });

  const people = useQuery({
    queryKey: ['people'],
    queryFn: api.people,
    enabled: createOpen,
    retry: false,
    staleTime: 300_000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['research'] });
  };

  const createMutation = useMutation({
    mutationFn: (account: string) => researchApi.createFolder(account),
    onSuccess: () => {
      message.success('已开通课题资料目录');
      setCreateOpen(false);
      form.resetFields();
      invalidate();
    },
    onError: (e) => message.error(`开通失败：${errText(e)}`),
  });

  const revokeMutation = useMutation({
    mutationFn: (account: string) => researchApi.revokeFolder(account),
    onSuccess: (r) => {
      message.success(
        r.removed > 0 ? '已收回访问权（数据保留在服务器）' : '该学生本来就没有课题资料授权',
      );
      invalidate();
    },
    onError: (e) => message.error(`收回失败：${errText(e)}`),
  });

  const peopleOptions = useMemo(() => {
    const list: PeopleEntry[] = people.data?.people ?? [];
    return list.map((p) => ({
      value: p.name,
      label: p.displayName || p.name,
    }));
  }, [people.data]);

  const stats = useMemo(() => {
    const list = folders.data?.folders ?? [];
    return {
      total: list.length,
      granted: list.filter((f) => f.granted).length,
      used: list.reduce((sum, f) => sum + (f.usedBytes || 0), 0),
    };
  }, [folders.data]);

  const columns: ColumnsType<ResearchFolder> = [
    {
      title: '学生',
      dataIndex: 'displayName',
      key: 'displayName',
      render: (v: string, row) => (
        <Space orientation="vertical" size={0}>
          <Text strong>{v || '（未知）'}</Text>
          {row.owned ? null : <Tag color="warning">历史目录</Tag>}
        </Space>
      ),
    },
    {
      title: '进组时间',
      dataIndex: 'joinedAt',
      key: 'joinedAt',
      width: 130,
      render: (v: string) =>
        v ? (
          <Text code style={{ whiteSpace: 'nowrap' }}>
            {v}
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '目录名',
      dataIndex: 'name',
      key: 'name',
      render: (v: string) => (
        <Tooltip title="进组时间-姓名">
          <Text code copyable={{ text: v }}>
            {v}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: '占用',
      dataIndex: 'usedBytes',
      key: 'usedBytes',
      width: 110,
      align: 'right',
      render: (v: number) => formatBytes(v || 0),
    },
    {
      title: '访问授权',
      dataIndex: 'granted',
      key: 'granted',
      width: 110,
      render: (v: boolean) =>
        v ? (
          <Tag color="success" icon={<SafetyCertificateOutlined />}>
            已开通
          </Tag>
        ) : (
          <Tag color="default">未开通</Tag>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 190,
      render: (_, row) => (
        <Space size={4} wrap>
          <Button
            size="small"
            icon={<FolderOpenOutlined />}
            onClick={() => navigate(`/files?source=research&dir=${encodeURIComponent(row.path)}`)}
          >
            打开
          </Button>
          {row.granted ? (
            <Popconfirm
              title="收回该学生的访问权？"
              description="只收回访问授权，目录里的数据仍保留在服务器上。"
              okText="收回访问权"
              cancelText="取消"
              onConfirm={() => revokeMutation.mutate(row.account)}
            >
              <Button size="small" danger loading={revokeMutation.isPending}>
                收回授权
              </Button>
            </Popconfirm>
          ) : (
            <Button
              size="small"
              type="primary"
              ghost
              loading={createMutation.isPending}
              onClick={() => createMutation.mutate(row.account)}
            >
              开通授权
            </Button>
          )}
        </Space>
      ),
    },
  ];

  // ------------------------------------------------------------- 学生视角
  if (!authLoading && !canManage) {
    const folder = mine.data?.folder ?? null;
    const msg = mine.data?.message ?? '';
    return (
      <PageShell
        title="课题资料"
        description="按「进组时间-姓名」建立的个人资料目录，只有你能看到自己的目录。"
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void mine.refetch()}>
            刷新
          </Button>
        }
      >
        {mine.isError ? (
          <Alert
            type="error"
            showIcon
            message="读取课题资料失败"
            description={errText(mine.error)}
            action={
              <Button size="small" onClick={() => void mine.refetch()}>
                重试
              </Button>
            }
          />
        ) : null}
        {!mine.isError && !folder ? (
          <Card>
            <Empty description={msg || '还没有开通课题资料目录，请联系导师'} />
          </Card>
        ) : null}
        {folder ? (
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12} lg={8}>
              <Card
                title="我的课题资料目录"
                extra={
                  <Tag color={folder.granted ? 'success' : 'warning'}>
                    {folder.granted ? '已开通' : '未开通'}
                  </Tag>
                }
              >
                <Flex vertical gap={12}>
                  <Statistic title="目录名" value={folder.name} valueStyle={{ fontSize: 16 }} />
                  <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    目录按「进组时间-姓名」命名，导师与管理员也能看到这个目录；
                    进入后即可上传实验数据、原始测序结果与分析脚本。
                  </Paragraph>
                  <Space wrap>
                    <Button
                      type="primary"
                      icon={<FolderOpenOutlined />}
                      onClick={() =>
                        navigate(`/files?source=research&dir=${encodeURIComponent(folder.path)}`)
                      }
                    >
                      进入文件存储
                    </Button>
                    <Button icon={<ReloadOutlined />} onClick={() => void mine.refetch()}>
                      刷新
                    </Button>
                  </Space>
                </Flex>
              </Card>
            </Col>
          </Row>
        ) : null}
      </PageShell>
    );
  }

  // ------------------------------------------------------------- 老师视角
  return (
    <PageShell
      title="课题资料"
      description="每个学生一个目录（进组时间-姓名），学生只能看到自己的目录，老师与管理员可见全部。"
      extra={
        <Space wrap>
          <Button
            icon={<ReloadOutlined />}
            loading={folders.isFetching}
            onClick={() => void folders.refetch()}
          >
            刷新
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateOpen(true)}
          >
            开通课题资料
          </Button>
        </Space>
      }
    >
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={8} lg={6}>
          <Card>
            <Statistic title="目录总数" value={stats.total} suffix="个" />
          </Card>
        </Col>
        <Col xs={24} sm={8} lg={6}>
          <Card>
            <Statistic
              title="已开通授权"
              value={stats.granted}
              suffix="个"
              valueStyle={{ color: palette.brand.olive700 }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8} lg={6}>
          <Card>
            <Statistic title="合计占用" value={formatBytes(stats.used)} />
          </Card>
        </Col>
      </Row>

      <Card>
        {folders.isError ? (
          <Alert
            type="error"
            showIcon
            message="读取目录失败"
            description={errText(folders.error)}
            action={
              <Button size="small" onClick={() => void folders.refetch()}>
                重试
              </Button>
            }
          />
        ) : (
          <Table<ResearchFolder>
            rowKey="name"
            columns={columns}
            dataSource={folders.data?.folders ?? []}
            loading={folders.isLoading}
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            scroll={{ x: 860 }}
            locale={{
              emptyText: (
                <Empty description="还没有课题资料目录，点右上角「开通课题资料」为学生创建" />
              ),
            }}
          />
        )}
      </Card>

      <Modal
        title="开通课题资料目录"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        okText="开通"
        cancelText="取消"
        confirmLoading={createMutation.isPending}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Paragraph type="secondary">
          目录名自动按「进组时间-姓名」生成，无需手工输入。
        </Paragraph>
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => createMutation.mutate(v.account)}
          initialValues={{ account: '' }}
        >
          <Form.Item
            name="account"
            label="学生"
            rules={[{ required: true, message: '请选择学生' }]}
            extra={people.isError ? '人员目录读取失败，可稍后重试' : undefined}
          >
            <Input
              list="research-people"
              placeholder="输入姓名搜索"
              prefix={<TeamOutlined />}
              suffix={
                <Tooltip title="输入的是账号名；下拉里显示的是姓名">
                  <LinkOutlined />
                </Tooltip>
              }
            />
          </Form.Item>
          <datalist id="research-people">
            {peopleOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </datalist>
        </Form>
      </Modal>
    </PageShell>
  );
}
