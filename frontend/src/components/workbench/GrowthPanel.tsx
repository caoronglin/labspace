/**
 * 个人工作台 · 成长与知识页签
 *
 * 信息层级按「累计概览 → 成长条目流 → 知识卡片网格」三段式组织，
 * 全部由 Ant Design 原生组件（Statistic / Timeline / Card / Modal / Popconfirm）表达。
 *
 * 数据源：GET /api/workbench/items（与工作台首页共用同一缓存键），
 * 写操作落到 POST / PATCH / DELETE /api/workbench/items；
 * 「存入知识库」复用 SaveKnowledgeModal（知识库正文写入独立服务）。
 *
 * 类型划分（不重叠）：
 * - 成长类目：memory（记忆）/ note（随手记）——过程与经验
 * - 知识类目：knowledge（知识）/ idea（想法）——已沉淀的结论
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
  Grid,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Skeleton,
  Statistic,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import {
  BookOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  PlusOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, type WorkbenchItem } from '../../services/api';
import SaveKnowledgeModal from '../SaveKnowledgeModal';
import { errText } from '../../utils/err';

/* ------------------------------------------------------------------ 词典 */

/** 成长类目：过程性记录 */
const GROWTH_KINDS = ['memory', 'note'] as const;

/** 知识类目：结论性沉淀 */
const KNOWLEDGE_KINDS = ['knowledge', 'idea'] as const;

/** 条目类型中文名（与后端 ITEM_KINDS 对齐） */
const KIND_CN: Record<string, string> = {
  memory: '记忆',
  note: '随手记',
  knowledge: '知识',
  idea: '想法',
};

/** 条目类型标签色 */
const KIND_COLOR: Record<string, string> = {
  memory: 'purple',
  note: 'cyan',
  knowledge: 'blue',
  idea: 'gold',
};

const KIND_OPTIONS = [
  ...GROWTH_KINDS,
  ...KNOWLEDGE_KINDS,
].map((value) => ({ value, label: KIND_CN[value] ?? value }));

const isKind = (kinds: readonly string[], kind: string) => kinds.includes(kind);

/* ------------------------------------------------------------------ 类型 */

/** 新建 / 编辑条目表单 */
interface GrowthFormValues {
  kind: string;
  title: string;
  content?: string;
  tags?: string[];
}

/* ------------------------------------------------------------------ 小组件 */

/** 可点击标题：鼠标与键盘（Enter / Space）都能进入编辑 */
function ItemTitle({
  item,
  onOpen,
}: {
  item: WorkbenchItem;
  onOpen: (item: WorkbenchItem) => void;
}) {
  return (
    <Typography.Text
      strong
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(item);
        }
      }}
      style={{ cursor: 'pointer', minWidth: 0 }}
    >
      {item.title || '未命名条目'}
    </Typography.Text>
  );
}

/** 行内操作：编辑 / 删除（删除走 Popconfirm） */
function ItemActions({
  item,
  busy,
  onEdit,
  onDelete,
}: {
  item: WorkbenchItem;
  busy: boolean;
  onEdit: (item: WorkbenchItem) => void;
  onDelete: (item: WorkbenchItem) => void;
}) {
  return (
    <Flex gap={4} align="center">
      <Tooltip title="编辑条目">
        <Button
          size="small"
          type="text"
          icon={<EditOutlined />}
          aria-label={`编辑条目：${item.title || '未命名条目'}`}
          onClick={() => onEdit(item)}
        />
      </Tooltip>
      <Popconfirm
        title="确定删除这条记录？"
        description="删除后不可恢复。"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onConfirm={() => onDelete(item)}
      >
        <Tooltip title="删除条目">
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            aria-label={`删除条目：${item.title || '未命名条目'}`}
            loading={busy}
          />
        </Tooltip>
      </Popconfirm>
    </Flex>
  );
}

/* ------------------------------------------------------------------ 主体 */

export default function GrowthPanel() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const screens = Grid.useBreakpoint();
  /** 窄屏（< md）时卡片改为单列、操作按钮收紧 */
  const narrow = !screens.md;

  const [form] = Form.useForm<GrowthFormValues>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WorkbenchItem | null>(null);
  const [kbTarget, setKbTarget] = useState<WorkbenchItem | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  /* ------------------------------------------------------- 数据 */

  const itemsQuery = useQuery({
    queryKey: ['workbench-items', 'all'],
    queryFn: () => api.workbenchItems({ limit: 200 }),
    staleTime: 30_000,
  });

  const items = useMemo(() => itemsQuery.data?.items ?? [], [itemsQuery.data]);
  const loading = itemsQuery.isLoading && !itemsQuery.data;
  const error = itemsQuery.error as Error | null;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['workbench-items'] });
    void qc.invalidateQueries({ queryKey: ['workbench-summary'] });
  };

  /* ------------------------------------------------------- 派生数据 */

  const growthItems = useMemo(
    () => items.filter((i) => isKind(GROWTH_KINDS, i.kind)),
    [items],
  );
  const knowledgeItems = useMemo(
    () => items.filter((i) => isKind(KNOWLEDGE_KINDS, i.kind)),
    [items],
  );

  /** 成长条目按类型分组，组内按创建时间倒序 */
  const groups = useMemo(() => {
    const map = new Map<string, WorkbenchItem[]>();
    for (const item of growthItems) {
      const bucket = map.get(item.kind);
      if (bucket) bucket.push(item);
      else map.set(item.kind, [item]);
    }
    return [...map.entries()]
      .map(([kind, list]) => ({
        kind,
        list: [...list].sort(
          (a, b) => dayjs(b.created_at ?? 0).valueOf() - dayjs(a.created_at ?? 0).valueOf(),
        ),
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
  }, [growthItems]);

  /** 累计记录 / 本周新增 / 沉淀条目 */
  const stats = useMemo(() => {
    const all = [...growthItems, ...knowledgeItems];
    const weekStart = dayjs().startOf('week');
    const thisWeek = all.filter(
      (i) => Boolean(i.created_at) && dayjs(i.created_at).isAfter(weekStart),
    ).length;
    return {
      total: all.length,
      thisWeek,
      settled: knowledgeItems.length,
    };
  }, [growthItems, knowledgeItems]);

  /* ------------------------------------------------------- 变更 */

  const saveMutation = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Partial<WorkbenchItem> }) =>
      id ? api.workbenchUpdateItem(id, body) : api.workbenchCreateItem(body),
    onSuccess: (_res, vars) => {
      message.success(vars.id ? '条目已更新' : '记录已写入');
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      invalidate();
    },
    onError: (e: Error) => message.error(`保存失败：${errText(e)}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (item: WorkbenchItem) => api.workbenchDeleteItem(item.id).then(() => item),
    onSuccess: (item) => {
      message.success(`已删除「${item.title || '未命名条目'}」`);
      invalidate();
    },
    onError: (e: Error) => message.error(`删除失败：${errText(e)}`),
  });

  /* ------------------------------------------------------- 交互 */

  const openCreate = (kind: string = 'memory') => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ kind, title: '', content: '', tags: [] });
    setModalOpen(true);
  };

  const openEdit = (item: WorkbenchItem) => {
    setEditing(item);
    form.resetFields();
    form.setFieldsValue({
      kind: item.kind,
      title: item.title ?? '',
      content: item.content ?? '',
      tags: item.tags ?? [],
    });
    setModalOpen(true);
  };

  const removeItem = (item: WorkbenchItem) => {
    setPendingId(item.id);
    deleteMutation.mutate(item, { onSettled: () => setPendingId(null) });
  };

  const submit = (values: GrowthFormValues) => {
    const body: Partial<WorkbenchItem> = {
      kind: values.kind,
      title: values.title.trim(),
      content: values.content ?? '',
      tags: values.tags ?? [],
      status: 'active',
    };
    saveMutation.mutate({ id: editing?.id, body });
  };

  /* ------------------------------------------------------- 渲染 */

  const renderGrowthItem = (item: WorkbenchItem) => (
    <Flex vertical gap={4} style={{ minWidth: 0 }}>
      <Flex gap={8} align="center" justify="space-between" wrap>
        <Flex gap={8} align="center" wrap style={{ minWidth: 0 }}>
          <ItemTitle item={item} onOpen={openEdit} />
          <Tag color={KIND_COLOR[item.kind] ?? 'default'} variant="filled" style={{ margin: 0 }}>
            {KIND_CN[item.kind] ?? '条目'}
          </Tag>
        </Flex>
        <ItemActions
          item={item}
          busy={pendingId === item.id}
          onEdit={openEdit}
          onDelete={removeItem}
        />
      </Flex>

      {item.content ? (
        <Tooltip title={item.content}>
          <Typography.Paragraph
            type="secondary"
            style={{ margin: 0, fontSize: 12.5 }}
            ellipsis={{ rows: 2 }}
          >
            {item.content}
          </Typography.Paragraph>
        </Tooltip>
      ) : null}

      <Flex gap={8} align="center" wrap style={{ fontSize: 11.5 }}>
        <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
          {item.created_at ? dayjs(item.created_at).format('YYYY-MM-DD') : '未记录时间'}
        </Typography.Text>
        {(item.tags?.length ?? 0) > 0 ? (
          <Flex gap={4} wrap>
            {item.tags!.map((t) => (
              <Tag key={t} color="cyan" style={{ margin: 0, fontSize: 11 }}>
                #{t}
              </Tag>
            ))}
          </Flex>
        ) : null}
      </Flex>
    </Flex>
  );

  const renderGrowth = () => {
    if (growthItems.length === 0) {
      return (
        <Card size="small" title="成长" variant="outlined" className="d509-card">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有成长记录，先把经验随手记下来"
            styles={{ image: { height: 48 } }}
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('memory')}>
              记一条成长记录
            </Button>
          </Empty>
        </Card>
      );
    }
    return (
      <Card
        size="small"
        title="成长"
        variant="outlined"
        className="d509-card"
        extra={
          <Button size="small" icon={<PlusOutlined />} onClick={() => openCreate('memory')}>
            记一条
          </Button>
        }
      >
        <Flex vertical gap={16}>
          {groups.map((group) => (
            <div key={group.kind}>
              <Flex gap={8} align="center" justify="space-between">
                <Flex gap={8} align="center">
                  <span
                    style={{
                      width: 3,
                      height: 14,
                      borderRadius: 2,
                      display: 'inline-block',
                      background: 'var(--ant-color-primary, #2B5CE6)',
                    }}
                  />
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {KIND_CN[group.kind] ?? group.kind}
                  </Typography.Text>
                </Flex>
                <Tag style={{ margin: 0 }}>{group.list.length}</Tag>
              </Flex>
              <Timeline
                style={{ marginTop: 12 }}
                items={group.list.map((item) => ({
                  key: item.id,
                  color: KIND_COLOR[item.kind] ?? 'blue',
                  children: renderGrowthItem(item),
                }))}
              />
            </div>
          ))}
        </Flex>
      </Card>
    );
  };

  const renderKnowledge = () => {
    if (knowledgeItems.length === 0) {
      return (
        <Card size="small" title="知识" variant="outlined" className="d509-card">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有沉淀的知识，把结论整理成一条"
            styles={{ image: { height: 48 } }}
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('knowledge')}>
              沉淀一条知识
            </Button>
          </Empty>
        </Card>
      );
    }
    return (
      <Card
        size="small"
        title="知识"
        variant="outlined"
        className="d509-card"
        extra={
          <Flex gap={8} align="center">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              共 {knowledgeItems.length} 条
            </Typography.Text>
            <Button size="small" icon={<PlusOutlined />} onClick={() => openCreate('knowledge')}>
              沉淀一条
            </Button>
          </Flex>
        }
      >
        <Row gutter={[12, 12]}>
          {knowledgeItems.map((item) => (
            <Col xs={24} md={12} xl={8} key={item.id}>
              <Card
                size="small"
                variant="outlined"
                styles={{ body: { padding: 12 } }}
                style={{ height: '100%' }}
              >
                <Flex vertical gap={8} style={{ height: '100%' }}>
                  <Flex gap={8} align="center" justify="space-between" wrap>
                    <Flex gap={8} align="center" wrap style={{ minWidth: 0 }}>
                      <ItemTitle item={item} onOpen={openEdit} />
                      <Tag
                        color={KIND_COLOR[item.kind] ?? 'default'}
                        variant="filled"
                        style={{ margin: 0 }}
                      >
                        {KIND_CN[item.kind] ?? '条目'}
                      </Tag>
                    </Flex>
                    <ItemActions
                      item={item}
                      busy={pendingId === item.id}
                      onEdit={openEdit}
                      onDelete={removeItem}
                    />
                  </Flex>

                  {item.content ? (
                    <Tooltip title={item.content}>
                      <Typography.Paragraph
                        type="secondary"
                        style={{ margin: 0, fontSize: 12.5 }}
                        ellipsis={{ rows: narrow ? 2 : 3 }}
                      >
                        {item.content}
                      </Typography.Paragraph>
                    </Tooltip>
                  ) : null}

                  {(item.tags?.length ?? 0) > 0 ? (
                    <Flex gap={4} wrap>
                      {item.tags!.map((t) => (
                        <Tag key={t} color="cyan" style={{ margin: 0, fontSize: 11 }}>
                          #{t}
                        </Tag>
                      ))}
                    </Flex>
                  ) : null}

                  <Flex justify="space-between" align="center" gap={8} style={{ marginTop: 'auto' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                      {item.created_at ? dayjs(item.created_at).format('YYYY-MM-DD') : '未记录时间'}
                    </Typography.Text>
                    <Button
                      size="small"
                      type="link"
                      icon={<SaveOutlined />}
                      onClick={() => setKbTarget(item)}
                    >
                      存入知识库
                    </Button>
                  </Flex>
                </Flex>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>
    );
  };

  return (
    <Flex vertical gap={16}>
      {/* ------------------------------------------------ 头部：累计概览 */}
      <Flex gap={24} align="center" wrap>
        <Statistic title="累计记录" value={stats.total} styles={{ content: { fontSize: 22 } }} />
        <Statistic title="本周新增" value={stats.thisWeek} styles={{ content: { fontSize: 22 } }} />
        <Statistic title="沉淀条目" value={stats.settled} styles={{ content: { fontSize: 22 } }} />
        <Button
          type="primary"
          icon={<PlusOutlined />}
          style={{ marginLeft: 'auto' }}
          onClick={() => openCreate('memory')}
        >
          记一条
        </Button>
      </Flex>

      {/* ------------------------------------------------ 错误态 */}
      {error ? (
        <Alert
          type="error"
          showIcon
          variant="filled"
          title="成长数据加载失败"
          description={errText(error, 120)}
          action={
            <Button size="small" type="primary" onClick={() => void itemsQuery.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}

      {/* ------------------------------------------------ 加载态 */}
      {loading ? (
        <Card size="small" variant="outlined" className="d509-card">
          <Skeleton active paragraph={{ rows: 5 }} />
        </Card>
      ) : (
        <>
          {/* -------------------------------------------- 上半区：成长 */}
          {renderGrowth()}

          {/* -------------------------------------------- 下半区：知识 */}
          {renderKnowledge()}
        </>
      )}

      {/* ------------------------------------------------ 新建 / 编辑 Modal */}
      <Modal
        open={modalOpen}
        title={editing ? '编辑条目' : '记一条'}
        okText={editing ? '保存' : '写入'}
        cancelText="取消"
        width={560}
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
          onFinish={submit}
          requiredMark={false}
          initialValues={{ kind: 'memory', title: '', content: '', tags: [] }}
        >
          <Form.Item name="kind" label="类型">
            <Select options={KIND_OPTIONS} />
          </Form.Item>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="例如：这次实验失败的原因是……" />
          </Form.Item>
          <Form.Item name="content" label="正文">
            <Input.TextArea rows={4} placeholder="记录过程、结论或背景" />
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" placeholder="输入后回车添加" tokenSeparators={[',', '，']} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ------------------------------------------------ 存入知识库 */}
      <SaveKnowledgeModal
        open={Boolean(kbTarget)}
        title={kbTarget?.title ?? ''}
        body={kbTarget?.content ?? ''}
        tags={kbTarget?.tags ?? []}
        onClose={() => setKbTarget(null)}
      />

      {/* ------------------------------------------------ 无障碍锚点说明 */}
      <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
        <ExperimentOutlined /> 标题可点击进入编辑（支持 Tab 聚焦与 Enter / Space 触发）
        <BookOutlined style={{ marginLeft: 8 }} />
        「存入知识库」会把当前条目正文写入实验室知识库
      </Typography.Text>
    </Flex>
  );
}
