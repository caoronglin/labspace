/**
 * 个人工作台 · 实验记录页签
 *
 * 字段与交互沿用 frontend/src/pages/lab/ElnPanel.tsx 的 ELN 约定：
 * - 模板（labops_eln_templates）+ 条目（labops_eln_entries）；
 * - 条目字段：template_id / title / entry_date / status / tags / content（模板字段键值对）；
 * - 动态表单：选中模板后按模板 fields 渲染输入项；
 * - 删除统一走 Popconfirm，列表用 Table。
 *
 * 数据源：GET /api/labops/eln/templates、GET /api/labops/eln/entries，
 * 写操作落到 POST / PATCH / DELETE /api/labops/eln/entries。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Empty,
  Flex,
  Form,
  Grid,
  Input,
  Modal,
  Popconfirm,
  Select,
  Skeleton,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import type { TableColumnsType } from 'antd';
import { api, type LabopsEntry, type LabopsTemplate } from '../../services/api';
import { errText } from '../../utils/err';

/* ------------------------------------------------------------------ 词典 */

/** 条目状态（与后端 labops ELN 状态一致） */
const STATUS_LABEL: Record<string, string> = { draft: '草稿', done: '已完成', archived: '已归档' };
const STATUS_COLOR: Record<string, string> = { draft: 'default', done: 'green', archived: 'blue' };

/** 状态可选项 */
const STATUS_OPTIONS = [
  { value: 'draft', label: '草稿' },
  { value: 'done', label: '已完成' },
  { value: 'archived', label: '已归档' },
];

/* ------------------------------------------------------------------ 类型 */

/** 实验记录表单 */
interface EntryFormValues {
  title: string;
  template_id?: string;
  entry_date?: Dayjs;
  status?: string;
  tags?: string[];
  content?: Record<string, string>;
}

/* ------------------------------------------------------------------ 主体 */

export default function RecordsPanel() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const screens = Grid.useBreakpoint();
  /** 窄屏（< md）时收起次要列 */
  const narrow = !screens.md;

  const [keyword, setKeyword] = useState('');
  const [templateFilter, setTemplateFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<LabopsEntry | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [form] = Form.useForm<EntryFormValues>();

  /* ------------------------------------------------------- 数据 */

  const templatesQuery = useQuery({
    queryKey: ['labops', 'templates'],
    queryFn: api.labopsTemplates,
    staleTime: 60_000,
  });

  const entriesQuery = useQuery({
    queryKey: ['labops', 'entries', keyword, templateFilter],
    queryFn: () => api.labopsEntries(keyword, templateFilter),
  });

  const templates = templatesQuery.data?.items ?? [];
  const entries = entriesQuery.data?.items ?? [];

  /** 模板 id → 模板，用于列表显示模板名、动态表单渲染字段 */
  const templateMap = useMemo(() => {
    const map = new Map<string, LabopsTemplate>();
    for (const t of templates) map.set(t.id, t);
    return map;
  }, [templates]);

  const templateOptions = useMemo(
    () => templates.map((t) => ({ value: t.id, label: t.name })),
    [templates],
  );

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['labops', 'entries'] });
  };

  /* ------------------------------------------------------- 变更 */

  const saveMutation = useMutation({
    mutationFn: (values: EntryFormValues) => {
      const body: Partial<LabopsEntry> = {
        title: values.title.trim(),
        template_id: values.template_id || null,
        status: values.status ?? 'draft',
        tags: values.tags ?? [],
        entry_date: values.entry_date
          ? dayjs(values.entry_date).format('YYYY-MM-DD')
          : dayjs().format('YYYY-MM-DD'),
        content: values.content ?? {},
      };
      return editing
        ? api.labopsUpdateEntry(editing.id, body)
        : api.labopsCreateEntry(body);
    },
    onSuccess: () => {
      message.success(editing ? '实验记录已保存' : '实验记录已创建');
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      invalidate();
    },
    onError: (e: Error) => message.error(`保存失败：${errText(e)}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.labopsDeleteEntry(id),
    onSuccess: () => {
      message.success('实验记录已删除');
      invalidate();
    },
    onError: (e: Error) => message.error(`删除失败：${errText(e)}`),
  });

  /* ------------------------------------------------------- 交互 */

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      title: '',
      template_id: templates[0]?.id ?? '',
      entry_date: dayjs(),
      status: 'draft',
      tags: [],
      content: {},
    });
    setModalOpen(true);
  };

  const openEdit = (entry: LabopsEntry) => {
    setEditing(entry);
    form.resetFields();
    form.setFieldsValue({
      title: entry.title ?? '',
      template_id: entry.template_id ?? templates[0]?.id ?? '',
      entry_date: entry.entry_date ? dayjs(entry.entry_date) : dayjs(),
      status: entry.status ?? 'draft',
      tags: entry.tags ?? [],
      content: entry.content ?? {},
    });
    setModalOpen(true);
  };

  const removeEntry = (id: string) => {
    setPendingId(id);
    deleteMutation.mutate(id, { onSettled: () => setPendingId(null) });
  };

  /* ------------------------------------------------------- 渲染 */

  /** 摘要：把模板字段值拼成一行文本 */
  const summaryOf = (entry: LabopsEntry) =>
    Object.values(entry.content ?? {})
      .map((v) => (v ?? '').trim())
      .filter(Boolean)
      .join(' · ');

  const columns: TableColumnsType<LabopsEntry> = [
    {
      title: '记录',
      dataIndex: 'title',
      key: 'title',
      render: (title: string, row: LabopsEntry) => (
        <Flex vertical gap={2} style={{ minWidth: 0 }}>
          <Typography.Text strong style={{ fontSize: 13.5 }}>
            {title}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {templateMap.get(row.template_id || '')?.name ?? '通用'} · {row.entry_date}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: '摘要',
      key: 'summary',
      responsive: narrow ? ['xl'] : ['md'],
      render: (_: unknown, row: LabopsEntry) => {
        const text = summaryOf(row);
        if (!text) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <Tooltip title={text}>
            <Typography.Text ellipsis style={{ maxWidth: 320, fontSize: 12.5 }}>
              {text}
            </Typography.Text>
          </Tooltip>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      responsive: narrow ? ['xl'] : ['md'],
      render: (value: string) => (
        <Tag color={STATUS_COLOR[value] ?? 'default'} variant="filled" style={{ margin: 0 }}>
          {STATUS_LABEL[value] ?? value}
        </Tag>
      ),
    },
    {
      title: '标签',
      dataIndex: 'tags',
      key: 'tags',
      width: 200,
      responsive: ['xl'],
      render: (tags: string[]) => (
        <Flex gap={4} wrap>
          {(tags ?? []).slice(0, 4).map((t) => (
            <Tag key={t} variant="filled" style={{ margin: 0 }}>
              {t}
            </Tag>
          ))}
        </Flex>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      align: 'right',
      render: (_: unknown, row: LabopsEntry) => (
        <Flex gap={4} justify="flex-end">
          <Tooltip title="编辑记录">
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              aria-label={`编辑实验记录：${row.title}`}
              onClick={() => openEdit(row)}
            />
          </Tooltip>
          <Popconfirm
            title="确定删除这条实验记录？"
            description="删除后不可恢复。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => removeEntry(row.id)}
          >
            <Tooltip title="删除记录">
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                aria-label={`删除实验记录：${row.title}`}
                loading={pendingId === row.id}
              />
            </Tooltip>
          </Popconfirm>
        </Flex>
      ),
    },
  ];

  const currentTemplateId = Form.useWatch('template_id', form);
  const templateFields = templateMap.get(currentTemplateId || '')?.fields ?? [];

  return (
    <Flex vertical gap={16}>
      {/* ------------------------------------------------ 错误态 */}
      {entriesQuery.error ? (
        <Alert
          type="error"
          showIcon
          variant="filled"
          title="实验记录加载失败"
          description={errText(entriesQuery.error as Error, 120)}
          action={
            <Button size="small" type="primary" onClick={() => void entriesQuery.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}

      {/* ------------------------------------------------ 头部：筛选 + 新建 */}
      <Flex gap={12} align="center" justify="space-between" wrap>
        <Flex gap={8} align="center" wrap>
          <Input.Search
            allowClear
            placeholder="搜索标题 / 内容 / 标签"
            style={{ width: 260 }}
            onSearch={setKeyword}
            aria-label="搜索实验记录"
          />
          <Select
            allowClear
            placeholder="全部模板"
            style={{ width: 200 }}
            value={templateFilter || undefined}
            onChange={(v) => setTemplateFilter(v ?? '')}
            options={templateOptions}
            aria-label="按模板筛选"
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {entries.length} 条
          </Typography.Text>
        </Flex>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建记录
        </Button>
      </Flex>

      {/* ------------------------------------------------ 列表 */}
      <Card size="small" variant="outlined" className="d509-card" styles={{ body: { padding: 0 } }}>
        {entriesQuery.isLoading && entries.length === 0 ? (
          <div style={{ padding: 16 }}>
            <Skeleton active paragraph={{ rows: 5 }} />
          </div>
        ) : (
          <Table
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={entries}
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="还没有实验记录，点击右上角新建"
                />
              ),
            }}
          />
        )}
      </Card>

      {/* ------------------------------------------------ 新建 / 编辑 Modal */}
      <Modal
        open={modalOpen}
        title={editing ? '编辑实验记录' : '新建实验记录'}
        okText={editing ? '保存' : '创建'}
        cancelText="取消"
        width={680}
        confirmLoading={saveMutation.isPending}
        onOk={() => form.submit()}
        onCancel={() => {
          setModalOpen(false);
          setEditing(null);
          form.resetFields();
        }}
        forceRender
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values: EntryFormValues) => saveMutation.mutate(values)}
          requiredMark={false}
        >
          <Flex gap={12} wrap>
            <Form.Item
              name="title"
              label="标题"
              rules={[{ required: true, message: '请填写标题' }]}
              style={{ flex: 2, minWidth: 240 }}
            >
              <Input placeholder="例如：玉米 B73 叶片 RNA 提取与质检" />
            </Form.Item>
            <Form.Item name="entry_date" label="日期" style={{ width: 160 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="status" label="状态" style={{ width: 140 }}>
              <Select options={STATUS_OPTIONS} />
            </Form.Item>
          </Flex>

          <Flex gap={12} wrap>
            <Form.Item name="template_id" label="模板" style={{ flex: 1, minWidth: 200 }}>
              <Select
                options={templateOptions}
                onChange={() => form.setFieldValue('content', {})}
                aria-label="选择记录模板"
              />
            </Form.Item>
            <Form.Item name="tags" label="标签" style={{ flex: 2, minWidth: 240 }}>
              <Select mode="tags" placeholder="输入后回车添加" />
            </Form.Item>
          </Flex>

          {templateFields.map((f) => (
            <Form.Item key={f.key} name={['content', f.key]} label={f.label}>
              {f.type === 'textarea' ? <Input.TextArea rows={4} /> : <Input />}
            </Form.Item>
          ))}
          {templateFields.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              该模板没有预置字段，保存后仍可在记录中补充内容。
            </Typography.Text>
          ) : null}
        </Form>
      </Modal>
    </Flex>
  );
}
