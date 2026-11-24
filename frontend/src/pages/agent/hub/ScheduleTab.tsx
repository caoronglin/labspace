import { useMemo, useState } from 'react';
import {
  App,
  Button,
  Flex,
  Form,
  Grid,
  Input,
  Modal,
  Popconfirm,
  Select,
  Switch,
  Table,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { asDelete, asGet, asList, asPatch, asPost } from '../../../services/agentscope';
import type {
  AsAgentList,
  AsCredential,
  AsCredentialList,
  AsModelCard,
  AsModelList,
  AsScheduleList,
  AsScheduleRecord,
} from '../../../services/agentscope';
import { AsEmpty, AsErrorAlert, AsLoading, asErrorText, formatTime } from './common';

const SCHEDULES_KEY = ['as', 'schedule'] as const;

/** 定时任务表单：名称 / cron / 助手 / 提示词，另有模型配置与时区。 */
interface ScheduleFormValues {
  name: string;
  cron_expression: string;
  agent_id: string;
  description?: string;
  timezone?: string;
  credential_id?: string;
  model?: string;
}

function credentialLabel(credential: AsCredential): string {
  const data = credential.data ?? {};
  const name = typeof data.name === 'string' ? data.name : '';
  const provider = typeof data.provider === 'string' ? data.provider : '';
  return name || provider || credential.id;
}

function credentialProvider(credential: AsCredential): string {
  // 凭据数据是自由结构，只有它自己声明了 provider 时才知道该问哪些模型。
  const provider = credential.data?.provider;
  return typeof provider === 'string' ? provider : '';
}

/** 定时任务：列表、新建、启停、删除。 */
export default function ScheduleTab() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const narrow = !screens.md;
  const [form] = Form.useForm<ScheduleFormValues>();
  const [creating, setCreating] = useState(false);

  const schedules = useQuery({
    queryKey: SCHEDULES_KEY,
    queryFn: () => asList<AsScheduleList>('schedule'),
    staleTime: 30_000,
  });

  const agents = useQuery({
    queryKey: ['as', 'agent'],
    queryFn: () => asList<AsAgentList>('agent'),
    staleTime: 30_000,
  });

  const credentials = useQuery({
    queryKey: ['as', 'credential'],
    queryFn: () => asList<AsCredentialList>('credential'),
    staleTime: 30_000,
  });

  const provider = useMemo(() => {
    const list = credentials.data?.credentials ?? [];
    return list.length ? credentialProvider(list[0]) : '';
  }, [credentials.data]);

  const models = useQuery({
    queryKey: ['as', 'model', provider],
    queryFn: () => asGet<AsModelList>('model', '', { provider }),
    enabled: provider !== '',
    staleTime: 30_000,
  });

  const modelOptions = useMemo(
    () =>
      (models.data?.models ?? []).map((model: AsModelCard) => ({
        value: model.name,
        label: model.label || model.name,
      })),
    [models.data],
  );

  const create = useMutation({
    mutationFn: (values: ScheduleFormValues) => {
      const body: Record<string, unknown> = {
        name: values.name.trim(),
        description: values.description?.trim() ?? '',
        cron_expression: values.cron_expression.trim(),
        agent_id: values.agent_id,
        timezone: values.timezone?.trim() || 'Asia/Shanghai',
        enabled: true,
      };
      // AgentScope 2.0.11 的创建接口要求 chat_model_config；凭据与模型都选好才带上。
      if (values.credential_id && values.model) {
        const picked = (models.data?.models ?? []).find((m) => m.name === values.model);
        body.chat_model_config = {
          type: picked?.model_class || 'openai_chat',
          credential_id: values.credential_id,
          model: values.model,
          parameters: {},
        };
      }
      return asPost('schedule', '', body);
    },
    onSuccess: () => {
      message.success('定时任务已创建');
      setCreating(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
    },
    onError: (err) => message.error(asErrorText(err)),
  });

  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      asPatch('schedule', v.id, { enabled: v.enabled }),
    onSuccess: (_data, v) => {
      message.success(v.enabled ? '任务已启用' : '任务已停用');
      void qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
    },
    onError: (err) => message.error(asErrorText(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => asDelete('schedule', id),
    onSuccess: () => {
      message.success('定时任务已删除');
      void qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
    },
    onError: (err) => message.error(asErrorText(err)),
  });

  const columns: TableColumnsType<AsScheduleRecord> = [
    {
      title: '名称',
      key: 'name',
      render: (_v, record) => (
        <Flex vertical>
          <span>{record.data?.name || record.id}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.id}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: 'Cron',
      dataIndex: ['data', 'cron_expression'],
      key: 'cron',
      width: 150,
      render: (value: string | undefined) => <code>{value || '—'}</code>,
    },
    {
      title: '助手',
      dataIndex: 'agent_id',
      key: 'agent',
      width: 160,
      render: (value: string) => value || '—',
    },
    {
      title: '时区',
      key: 'timezone',
      width: 130,
      render: (_v, record) => record.data?.timezone || '—',
    },
    {
      title: '状态',
      key: 'enabled',
      width: 110,
      render: (_v, record) => (
        <Switch
          checked={record.data?.enabled !== false}
          aria-label={`切换定时任务 ${record.data?.name || record.id} 的启用状态`}
          loading={toggle.isPending && toggle.variables?.id === record.id}
          onChange={(checked) => toggle.mutate({ id: record.id, enabled: checked })}
        />
      ),
    },
    {
      title: '更新时间',
      key: 'updated_at',
      width: 170,
      render: (_v, record) => formatTime(record.updated_at),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_v, record) => (
        <Popconfirm
          title="删除该定时任务？"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => remove.mutateAsync(record.id)}
        >
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            aria-label={`删除定时任务 ${record.data?.name || record.id}`}
          >
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Flex vertical gap={12}>
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Typography.Text type="secondary">
          共 {schedules.data?.total ?? 0} 个定时任务；启用后按 cron 触发所选助手。
        </Typography.Text>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setCreating(true)}
          aria-label="新建定时任务"
        >
          新建任务
        </Button>
      </Flex>

      {schedules.isLoading ? (
        <AsLoading rows={5} />
      ) : schedules.error ? (
        <AsErrorAlert error={schedules.error} onRetry={() => void schedules.refetch()} />
      ) : (schedules.data?.schedules.length ?? 0) === 0 ? (
        <AsEmpty
          description="还没有定时任务"
          action={
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              新建任务
            </Button>
          }
        />
      ) : (
        <Table<AsScheduleRecord>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={schedules.data?.schedules ?? []}
          pagination={false}
          scroll={{ x: 1000 }}
        />
      )}

      <Modal
        title="新建定时任务"
        open={creating}
        onCancel={() => {
          setCreating(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        okText="创建"
        cancelText="取消"
        confirmLoading={create.isPending}
        destroyOnHidden
        width={narrow ? '100%' : 620}
      >
        <Form<ScheduleFormValues>
          form={form}
          layout="vertical"
          onFinish={(values) => create.mutate(values)}
          initialValues={{ timezone: 'Asia/Shanghai' }}
        >
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请填写任务名称' }]}
          >
            <Input placeholder="例如：每日文献速递" aria-label="任务名称" />
          </Form.Item>
          <Form.Item
            name="cron_expression"
            label="Cron 表达式"
            rules={[{ required: true, message: '请填写 5 段 cron 表达式' }]}
            extra="标准 5 段 cron，例如 0 9 * * 1-5 表示工作日每天 09:00。"
          >
            <Input placeholder="0 9 * * 1-5" aria-label="Cron 表达式" />
          </Form.Item>
          <Form.Item
            name="agent_id"
            label="助手"
            rules={[{ required: true, message: '请选择要执行的助手' }]}
          >
            <Select
              placeholder="选择助手"
              aria-label="执行任务的助手"
              options={(agents.data?.agents ?? []).map((agent) => ({
                value: agent.id,
                label: agent.data?.name || agent.id,
              }))}
              notFoundContent={
                agents.error ? '助手列表不可用' : '当前没有可用的助手，请先在 Agent 个人助手里创建'
              }
            />
          </Form.Item>
          <Form.Item
            name="description"
            label="提示词"
            extra="AgentScope 2.0.11 的定时任务没有独立的提示词字段，这里写入任务描述；助手的系统提示词仍取自所选助手。"
          >
            <Input.TextArea
              rows={3}
              placeholder="例如：抓取昨日新增文献并生成中文摘要"
              aria-label="任务提示词"
            />
          </Form.Item>
          <Form.Item name="timezone" label="时区">
            <Input placeholder="Asia/Shanghai" aria-label="时区" />
          </Form.Item>
          <Form.Item
            name="credential_id"
            label="模型凭据"
            extra="AgentScope 要求新建任务时带上 chat_model_config；凭据与模型都选定后才会提交该配置。"
          >
            <Select
              allowClear
              placeholder="选择凭据"
              aria-label="模型凭据"
              options={(credentials.data?.credentials ?? []).map((credential) => ({
                value: credential.id,
                label: credentialLabel(credential),
              }))}
              notFoundContent={credentials.error ? '凭据列表不可用' : '还没有可用凭据'}
            />
          </Form.Item>
          <Form.Item name="model" label="模型">
            <Select
              allowClear
              placeholder="选择模型"
              aria-label="模型"
              options={modelOptions}
              notFoundContent={models.error ? '模型列表不可用' : '该凭据下没有可用模型'}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Flex>
  );
}
