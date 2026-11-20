import { useMemo, useState } from 'react';
import {
  App,
  Button,
  DatePicker,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, type LabopsEntry, type LabopsTemplate } from '../../services/api';

const STATUS_LABEL: Record<string, string> = { draft: '草稿', done: '已完成', archived: '已归档' };
const STATUS_COLOR: Record<string, string> = { draft: 'default', done: 'green', archived: 'blue' };

export default function ElnPanel() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [templateFilter, setTemplateFilter] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<LabopsEntry | null>(null);
  const [form] = Form.useForm();

  const templates = useQuery({ queryKey: ['labops', 'templates'], queryFn: api.labopsTemplates });
  const entries = useQuery({
    queryKey: ['labops', 'entries', keyword, templateFilter],
    queryFn: () => api.labopsEntries(keyword, templateFilter),
  });

  const tplMap = useMemo(() => {
    const map = new Map<string, LabopsTemplate>();
    (templates.data?.items ?? []).forEach((t) => map.set(t.id, t));
    return map;
  }, [templates.data]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['labops', 'entries'] });
  };

  const save = useMutation({
    mutationFn: async (values: any) => {
      const body: Partial<LabopsEntry> = {
        title: values.title,
        template_id: values.template_id || null,
        status: values.status,
        tags: values.tags ?? [],
        entry_date: values.entry_date ? dayjs(values.entry_date).format('YYYY-MM-DD') : undefined,
        content: values.content ?? {},
      };
      if (editing) return api.labopsUpdateEntry(editing.id, body);
      return api.labopsCreateEntry(body);
    },
    onSuccess: () => {
      message.success(editing ? '已保存' : '已创建实验记录');
      setOpen(false);
      setEditing(null);
      form.resetFields();
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const remove = useMutation({
    mutationFn: api.labopsDeleteEntry,
    onSuccess: () => {
      message.success('已删除');
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const toTask = useMutation({
    mutationFn: api.labopsEntryToTask,
    onSuccess: () => message.success('已加入个人工作台任务'),
    onError: (e: Error) => message.error(e.message),
  });

  const toKnowledge = useMutation({
    mutationFn: api.labopsEntryToKnowledge,
    onSuccess: (r) => message.success(`已存入知识库（#${r.docId}）`),
    onError: (e: Error) => message.error(e.message),
  });

  const openEditor = (entry?: LabopsEntry) => {
    setEditing(entry ?? null);
    const initialTemplate = entry?.template_id ?? templates.data?.items?.[0]?.id ?? '';
    form.setFieldsValue({
      title: entry?.title ?? '',
      template_id: initialTemplate,
      status: entry?.status ?? 'draft',
      tags: entry?.tags ?? [],
      entry_date: entry?.entry_date ? dayjs(entry.entry_date) : dayjs(),
      content: entry?.content ?? {},
    });
    setOpen(true);
  };

  const currentTemplate = Form.useWatch('template_id', form);
  const fields = tplMap.get(currentTemplate || '')?.fields ?? [];

  const columns = [
    {
      title: '记录',
      dataIndex: 'title',
      key: 'title',
      render: (title: string, row: LabopsEntry) => (
        <Flex vertical gap={2}>
          <Typography.Text strong>{title}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {tplMap.get(row.template_id || '')?.name ?? '通用'} · {row.entry_date}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (v: string) => <Tag color={STATUS_COLOR[v] ?? 'default'}>{STATUS_LABEL[v] ?? v}</Tag>,
    },
    {
      title: '标签',
      dataIndex: 'tags',
      key: 'tags',
      width: 220,
      render: (tags: string[]) => (
        <Space size={4} wrap>
          {(tags ?? []).slice(0, 4).map((t) => (
            <Tag key={t} variant="filled">
              {t}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: 160,
      render: (v: string) => dayjs(v).format('MM-DD HH:mm'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 300,
      render: (_: unknown, row: LabopsEntry) => (
        <Space size={4} wrap>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEditor(row)}>
            编辑
          </Button>
          <Button size="small" onClick={() => toTask.mutate(row.id)}>
            转任务
          </Button>
          <Button size="small" onClick={() => toKnowledge.mutate(row.id)}>
            存知识库
          </Button>
          <Popconfirm title="删除该实验记录？" okButtonProps={{ danger: true }} onConfirm={() => remove.mutate(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Flex vertical gap={12}>
      <Flex justify="space-between" align="center" wrap gap={10}>
        <Space wrap size={8}>
          <Input.Search
            allowClear
            placeholder="搜索标题 / 内容 / 标签"
            style={{ width: 300 }}
            onSearch={setKeyword}
          />
          <Select
            allowClear
            placeholder="全部模板"
            style={{ width: 200 }}
            value={templateFilter || undefined}
            onChange={(v) => setTemplateFilter(v ?? '')}
            options={(templates.data?.items ?? []).map((t) => ({ value: t.id, label: t.name }))}
          />
        </Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>
          新建记录
        </Button>
      </Flex>
      <Table
        rowKey="id"
        size="middle"
        loading={entries.isLoading}
        dataSource={entries.data?.items ?? []}
        columns={columns as any}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        locale={{ emptyText: <Empty description="还没有实验记录，点击右上角新建" /> }}
      />

      <Drawer
        title={editing ? '编辑实验记录' : '新建实验记录'}
        size={720}
        open={open}
        onClose={() => {
          setOpen(false);
          setEditing(null);
        }}
        extra={
          <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>
            保存
          </Button>
        }
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Flex gap={12} wrap>
            <Form.Item name="title" label="标题" rules={[{ required: true, message: '请填写标题' }]} style={{ flex: 2, minWidth: 240 }}>
              <Input placeholder="例如：玉米 B73 叶片 RNA 提取与质检" />
            </Form.Item>
            <Form.Item name="entry_date" label="日期" style={{ width: 160 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="status" label="状态" style={{ width: 140 }}>
              <Select
                options={[
                  { value: 'draft', label: '草稿' },
                  { value: 'done', label: '已完成' },
                  { value: 'archived', label: '已归档' },
                ]}
              />
            </Form.Item>
          </Flex>
          <Flex gap={12} wrap>
            <Form.Item name="template_id" label="模板" style={{ flex: 1, minWidth: 200 }}>
              <Select
                options={(templates.data?.items ?? []).map((t) => ({ value: t.id, label: t.name }))}
                onChange={() => form.setFieldValue('content', {})}
              />
            </Form.Item>
            <Form.Item name="tags" label="标签" style={{ flex: 2, minWidth: 240 }}>
              <Select mode="tags" placeholder="输入后回车添加" />
            </Form.Item>
          </Flex>
          {fields.map((f) => (
            <Form.Item key={f.key} name={['content', f.key]} label={f.label}>
              {f.type === 'textarea' ? <Input.TextArea rows={4} /> : <Input />}
            </Form.Item>
          ))}
          {fields.length === 0 && (
            <Typography.Text type="secondary">该模板没有预置字段，保存后仍可在记录中补充内容。</Typography.Text>
          )}
        </Form>
      </Drawer>
    </Flex>
  );
}