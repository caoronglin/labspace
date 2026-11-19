/**
 * 个人工作台 · 任务页签（/workbench?tab=tasks）
 *
 * 信息层级按「概览数字 → 三种视图 → 行内操作」组织：
 * 顶部一排 Statistic（进行中 / 今日到期 / 逾期 / 本周完成），
 * 主体用 Segmented 在「列表 / 日历 / 甘特」三种视图间切换。
 *
 * 交互约定（与 PlanPanel 保持一致）：
 * - 新建 / 编辑统一走 Modal + Form，不手写受控 state 拼表单；
 * - 删除统一走 Popconfirm；
 * - 逾期事项置顶并标红（danger 色）；
 * - 图标按钮一律带 aria-label，可点击文本带 role="button" + tabIndex + 键盘事件；
 * - 窄屏（< md）把行内操作收进 Dropdown。
 *
 * 数据源：GET /api/workbench/summary（概览数字）、GET /api/workbench/items（条目）、
 * GET /api/workbench/projects（所属项目下拉），写操作落到 POST / PATCH / DELETE
 * /api/workbench/items。组件自取数据，不需要父组件传 props。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Calendar,
  Card,
  Col,
  DatePicker,
  Dropdown,
  Empty,
  Flex,
  Form,
  Grid,
  Input,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Skeleton,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { TableProps } from 'antd';
import {
  BarChartOutlined,
  CalendarOutlined,
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  PlusOutlined,
  UnorderedListOutlined,
  UserOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { api, type WorkbenchItem } from '../../services/api';
import { errText } from '../../utils/err';

/* ------------------------------------------------------------------ 词典 */

/** 条目类型（与后端 ITEM_KINDS 一致；界面只暴露常用的几种） */
const KIND_CN: Record<string, string> = {
  task: '任务',
  idea: '想法',
  knowledge: '知识',
  note: '笔记',
  memory: '记忆',
  plan: '计划',
  project: '项目',
};

const KIND_OPTIONS = [
  { value: 'task', label: '任务' },
  { value: 'idea', label: '想法' },
  { value: 'knowledge', label: '知识' },
  { value: 'note', label: '笔记' },
  { value: 'memory', label: '记忆' },
];

/** 条目状态（与后端 ITEM_STATUSES 一致） */
const STATUS_CN: Record<string, string> = {
  active: '进行中',
  done: '已完成',
  paused: '已暂停',
  archived: '已归档',
};

const STATUS_COLOR: Record<string, string> = {
  active: 'blue',
  done: 'green',
  paused: 'gold',
  archived: 'default',
};

const STATUS_OPTIONS = Object.entries(STATUS_CN).map(([value, label]) => ({ value, label }));

/** 优先级（与后端 ITEM_PRIORITIES 一致） */
const PRIORITY_CN: Record<string, string> = { low: '低', normal: '普通', high: '高' };

const PRIORITY_COLOR: Record<string, string> = { low: 'default', normal: 'blue', high: 'red' };

const PRIORITY_OPTIONS = Object.entries(PRIORITY_CN).map(([value, label]) => ({ value, label }));

const statusCn = (s?: string) => (s && STATUS_CN[s]) || '未知';
const kindCn = (k?: string) => (k && KIND_CN[k]) || '条目';

/* ------------------------------------------------------------------ 类型 */

interface TaskFormValues {
  title: string;
  content?: string;
  kind: string;
  priority: string;
  status: string;
  due_date?: Dayjs;
  project_id?: string;
}

/* ------------------------------------------------------------------ 判定 */

/** 未完成（已完成 / 已归档不算待办） */
const isOpen = (item: WorkbenchItem) =>
  item.status !== 'done' && item.status !== 'archived';

/** 逾期：截止日期早于今天且还没收口 */
const isOverdue = (item: WorkbenchItem) =>
  isOpen(item) && !!item.due_date && dayjs(item.due_date).isBefore(dayjs(), 'day');

/** 今日到期 */
const isDueToday = (item: WorkbenchItem) =>
  isOpen(item) && !!item.due_date && dayjs(item.due_date).isSame(dayjs(), 'day');

/** 日历圆点颜色：按状态 */
const dotColor = (item: WorkbenchItem) => {
  if (isOverdue(item)) return '#DC2626';
  if (item.status === 'done') return '#12A594';
  if (item.status === 'paused') return '#D97706';
  return '#2B5CE6';
};

/* ------------------------------------------------------------------ 小组件 */

/** 可点击标题：鼠标与键盘（Enter / Space）都能进入编辑 */
function TaskTitle({
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

/** 行内操作：宽屏展开成图标按钮，窄屏收进 Dropdown（删除始终独立，保留 Popconfirm） */
function TaskActions({
  item,
  narrow,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  item: WorkbenchItem;
  narrow: boolean;
  busy: boolean;
  onEdit: (item: WorkbenchItem) => void;
  onToggle: (item: WorkbenchItem) => void;
  onDelete: (item: WorkbenchItem) => void;
}) {
  const menuItems = [
    { key: 'edit', icon: <EditOutlined />, label: '编辑条目' },
    {
      key: 'toggle',
      icon: <CheckOutlined />,
      label: item.status === 'done' ? '恢复为进行中' : '标记完成',
    },
  ];

  return (
    <Flex gap={4} align="center" justify="flex-end">
      {narrow ? (
        <Dropdown
          trigger={['click']}
          menu={{
            items: menuItems,
            onClick: ({ key }) => {
              if (key === 'edit') onEdit(item);
              if (key === 'toggle') onToggle(item);
            },
          }}
        >
          <Button size="small" type="text" icon={<EllipsisOutlined />} aria-label="更多操作" />
        </Dropdown>
      ) : (
        <Tooltip title="编辑条目">
          <Button
            size="small"
            type="text"
            icon={<EditOutlined />}
            aria-label="编辑条目"
            onClick={() => onEdit(item)}
          />
        </Tooltip>
      )}
      <Popconfirm
        title="确定删除这个条目？"
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
            aria-label="删除条目"
            loading={busy}
          />
        </Tooltip>
      </Popconfirm>
    </Flex>
  );
}

/* ------------------------------------------------------------------ 主体 */

export default function TasksPanel() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const screens = Grid.useBreakpoint();
  /** 窄屏（< md）时把次要操作收进 Dropdown */
  const narrow = !screens.md;

  const [view, setView] = useState<'list' | 'calendar' | 'gantt'>('list');
  const [selectedDate, setSelectedDate] = useState<Dayjs>(dayjs());
  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<WorkbenchItem | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [form] = Form.useForm<TaskFormValues>();

  /* ------------------------------------------------------- 数据 */

  const summaryQuery = useQuery({
    queryKey: ['workbench-summary'],
    queryFn: api.workbenchSummary,
    staleTime: 30_000,
  });

  const itemsQuery = useQuery({
    queryKey: ['workbench-items', 'tasks'],
    queryFn: () => api.workbenchItems({ limit: 200 }),
    staleTime: 30_000,
  });

  const projectsQuery = useQuery({
    queryKey: ['workbench-projects'],
    queryFn: api.workbenchProjects,
    staleTime: 30_000,
  });

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    staleTime: 5 * 60_000,
  });

  const items = useMemo(() => itemsQuery.data?.items ?? [], [itemsQuery.data]);
  const projects = useMemo(() => projectsQuery.data?.projects ?? [], [projectsQuery.data]);
  const loading = itemsQuery.isLoading && !itemsQuery.data;
  const error = (itemsQuery.error as Error | null) ?? null;

  /** 负责人：条目按账号归属，就是当前登录用户 */
  const owner = meQuery.data?.name || meQuery.data?.email || '我';

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['workbench-items'] });
    void qc.invalidateQueries({ queryKey: ['workbench-summary'] });
    void qc.invalidateQueries({ queryKey: ['workbench-projects'] });
  };

  /* ------------------------------------------------------- 变更 */

  const createMutation = useMutation({
    mutationFn: (body: Partial<WorkbenchItem>) => api.workbenchCreateItem(body),
    onSuccess: () => {
      message.success('任务已创建');
      closeModal();
      invalidate();
    },
    onError: (e: Error) => message.error(`创建失败：${errText(e, 120)}`),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<WorkbenchItem> }) =>
      api.workbenchUpdateItem(id, body),
    onSuccess: () => {
      message.success('任务已更新');
      closeModal();
      invalidate();
    },
    onError: (e: Error) => message.error(`更新失败：${errText(e, 120)}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.workbenchDeleteItem(id),
    onSuccess: () => {
      message.success('任务已删除');
      invalidate();
    },
    onError: (e: Error) => message.error(`删除失败：${errText(e, 120)}`),
  });

  /* ------------------------------------------------------- 派生数据 */

  /** 概览数字：能取到 summary 就用 summary，其余从条目列表算 */
  const stats = useMemo(() => {
    const active = items.filter((i) => i.status === 'active').length;
    const dueToday = items.filter(isDueToday).length;
    const overdue = items.filter(isOverdue).length;
    const doneThisWeek = items.filter(
      (i) =>
        i.status === 'done' &&
        !!i.updated_at &&
        dayjs(i.updated_at).isAfter(dayjs().startOf('week')),
    ).length;
    return {
      active,
      dueToday: summaryQuery.data?.today.dueToday.length ?? dueToday,
      overdue: summaryQuery.data?.today.overdue.length ?? overdue,
      doneThisWeek: summaryQuery.data?.stats.completedThisWeek ?? doneThisWeek,
    };
  }, [items, summaryQuery.data]);

  /** 排序：逾期置顶，其次按截止日期，最后按最近更新 */
  const sortedItems = useMemo(() => {
    const rank = (item: WorkbenchItem) => {
      if (isOverdue(item)) return 0;
      if (isDueToday(item)) return 1;
      if (item.status === 'active') return 2;
      if (item.status === 'paused') return 3;
      return 4;
    };
    return [...items].sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      const ad = a.due_date ? dayjs(a.due_date).valueOf() : Number.POSITIVE_INFINITY;
      const bd = b.due_date ? dayjs(b.due_date).valueOf() : Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      return dayjs(b.updated_at ?? b.created_at ?? 0).valueOf() - dayjs(a.updated_at ?? a.created_at ?? 0).valueOf();
    });
  }, [items]);

  /** 截止日期 → 当日条目（日历视图用） */
  const itemsByDueDate = useMemo(() => {
    const map = new Map<string, WorkbenchItem[]>();
    for (const item of items) {
      if (!item.due_date) continue;
      const key = dayjs(item.due_date).format('YYYY-MM-DD');
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
    return map;
  }, [items]);

  /** 甘特时间轴：取所有条目的创建 / 截止日期作为横轴范围 */
  const ganttRange = useMemo(() => {
    const stamps: number[] = [];
    for (const item of items) {
      if (item.created_at) stamps.push(dayjs(item.created_at).startOf('day').valueOf());
      if (item.due_date) stamps.push(dayjs(item.due_date).startOf('day').valueOf());
    }
    if (!stamps.length) {
      const today = dayjs().startOf('day');
      return { start: today, end: today.add(7, 'day') };
    }
    const start = dayjs(Math.min(...stamps));
    const end = dayjs(Math.max(...stamps));
    return { start, end: end.isAfter(start) ? end : start.add(1, 'day') };
  }, [items]);

  /* ------------------------------------------------------- 交互 */

  const closeModal = () => {
    setModalMode(null);
  };

  /** 打开弹窗时重置并回填表单（不靠 initialValues，避免上次编辑残留） */
  const resetForm = (values: TaskFormValues) => {
    form.resetFields();
    form.setFieldsValue(values);
  };

  const openCreate = () => {
    setEditing(null);
    setModalMode('create');
    resetForm({
      title: '',
      content: '',
      kind: 'task',
      priority: 'normal',
      status: 'active',
      due_date: undefined,
      project_id: undefined,
    });
  };

  const openEdit = (item: WorkbenchItem) => {
    setEditing(item);
    setModalMode('edit');
    resetForm({
      title: item.title,
      content: item.content ?? '',
      kind: item.kind ?? 'task',
      priority: item.priority ?? 'normal',
      status: item.status ?? 'active',
      due_date: item.due_date ? dayjs(item.due_date) : undefined,
      project_id: item.project_id ?? undefined,
    });
  };

  const removeItem = (item: WorkbenchItem) => {
    setPendingId(item.id);
    deleteMutation.mutate(item.id, { onSettled: () => setPendingId(null) });
  };

  const toggleDone = (item: WorkbenchItem) => {
    const next = item.status === 'done' ? 'active' : 'done';
    setPendingId(item.id);
    updateMutation.mutate(
      { id: item.id, body: { status: next } },
      { onSettled: () => setPendingId(null) },
    );
  };

  const submitTask = (values: TaskFormValues) => {
    const body: Partial<WorkbenchItem> = {
      kind: values.kind,
      title: values.title.trim(),
      content: values.content ?? '',
      status: values.status,
      priority: values.priority,
      due_date: values.due_date ? values.due_date.format('YYYY-MM-DD') : null,
      project_id: values.project_id ? values.project_id : null,
    };
    if (modalMode === 'edit' && editing) {
      updateMutation.mutate({ id: editing.id, body });
      return;
    }
    createMutation.mutate(body);
  };

  /** 表单初始值：表单常驻，初始值只作为首屏兜底，实际回填靠 resetForm */
  const taskInitialValues = useMemo<TaskFormValues>(
    () =>
      editing
        ? {
            title: editing.title,
            content: editing.content ?? '',
            kind: editing.kind ?? 'task',
            priority: editing.priority ?? 'normal',
            status: editing.status ?? 'active',
            due_date: editing.due_date ? dayjs(editing.due_date) : undefined,
            project_id: editing.project_id ?? undefined,
          }
        : {
            title: '',
            content: '',
            kind: 'task',
            priority: 'normal',
            status: 'active',
            due_date: undefined,
            project_id: undefined,
          },
    [editing],
  );

  /* ------------------------------------------------------- 渲染 */

  const emptyAction = (
    <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
      新建任务
    </Button>
  );

  const projectOptions = projects.map((p) => ({ value: p.id, label: p.name }));

  const columns: TableProps<WorkbenchItem>['columns'] = [
    {
      title: '标题',
      dataIndex: 'title',
      key: 'title',
      render: (_: unknown, record: WorkbenchItem) => (
        <Flex gap={8} align="center" wrap>
          <TaskTitle item={record} onOpen={openEdit} />
          <Tag variant="filled" color={record.kind === 'task' ? 'blue' : 'default'} style={{ margin: 0 }}>
            {kindCn(record.kind)}
          </Tag>
          {isOverdue(record) ? (
            <Tag color="danger" variant="filled" style={{ margin: 0 }}>
              逾期
            </Tag>
          ) : null}
        </Flex>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 92,
      render: (value?: string) => (
        <Tag color={STATUS_COLOR[value ?? 'active']} variant="filled" style={{ margin: 0 }}>
          {statusCn(value)}
        </Tag>
      ),
    },
    {
      title: '优先级',
      dataIndex: 'priority',
      key: 'priority',
      width: 84,
      render: (value?: string) => (
        <Tag color={PRIORITY_COLOR[value ?? 'normal']} style={{ margin: 0 }}>
          {PRIORITY_CN[value ?? 'normal'] ?? '普通'}
        </Tag>
      ),
    },
    {
      title: '截止日期',
      dataIndex: 'due_date',
      key: 'due_date',
      width: 132,
      render: (value: string | null | undefined, record: WorkbenchItem) => {
        if (!value) return <Typography.Text type="secondary">未设定</Typography.Text>;
        const overdue = isOverdue(record);
        return (
          <Flex gap={6} align="center">
            <CalendarOutlined aria-hidden />
            <Typography.Text
              style={{ fontVariantNumeric: 'tabular-nums' }}
              type={overdue ? 'danger' : undefined}
              delete={record.status === 'done'}
            >
              {dayjs(value).format('YYYY-MM-DD')}
            </Typography.Text>
          </Flex>
        );
      },
    },
    {
      title: '负责人',
      key: 'owner',
      width: 110,
      render: () => (
        <Tooltip title="工作台条目按账号归属，负责人就是当前登录用户">
          <Flex gap={6} align="center">
            <UserOutlined aria-hidden />
            <Typography.Text ellipsis style={{ maxWidth: 80 }}>
              {owner}
            </Typography.Text>
          </Flex>
        </Tooltip>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 96,
      align: 'right',
      render: (_: unknown, record: WorkbenchItem) => (
        <TaskActions
          item={record}
          narrow={narrow}
          busy={pendingId === record.id}
          onEdit={openEdit}
          onToggle={toggleDone}
          onDelete={removeItem}
        />
      ),
    },
  ];

  /** 日历视图：当日事项列表 */
  const renderDayItems = () => {
    const key = selectedDate.format('YYYY-MM-DD');
    const dayItems = itemsByDueDate.get(key) ?? [];
    return (
      <Card
        size="small"
        title={`当日事项 · ${key}`}
        variant="outlined"
        className="d509-card"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {dayItems.length} 项
          </Typography.Text>
        }
      >
        {dayItems.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这一天没有到期事项" styles={{ image: { height: 48 } }} />
        ) : (
          <Flex vertical gap={8}>
            {dayItems.map((item) => (
              <Flex key={item.id} gap={8} align="center" justify="space-between" wrap>
                <Flex gap={8} align="center" wrap style={{ minWidth: 0 }}>
                  <TaskTitle item={item} onOpen={openEdit} />
                  <Tag
                    color={STATUS_COLOR[item.status ?? 'active']}
                    variant="filled"
                    style={{ margin: 0 }}
                  >
                    {statusCn(item.status)}
                  </Tag>
                  <Tag color={PRIORITY_COLOR[item.priority ?? 'normal']} style={{ margin: 0 }}>
                    {PRIORITY_CN[item.priority ?? 'normal'] ?? '普通'}
                  </Tag>
                </Flex>
                <TaskActions
                  item={item}
                  narrow={narrow}
                  busy={pendingId === item.id}
                  onEdit={openEdit}
                  onToggle={toggleDone}
                  onDelete={removeItem}
                />
              </Flex>
            ))}
          </Flex>
        )}
      </Card>
    );
  };

  /** 甘特视图：横轴是时间，条形是「创建 → 截止」区间，条内填充是推进进度 */
  const renderGantt = () => {
    const spanMs = ganttRange.end.diff(ganttRange.start, 'day') || 1;
    const rows = sortedItems.slice(0, 50);

    /** 单条：起止日期 → 横轴百分比 */
    const position = (item: WorkbenchItem) => {
      let start = ganttRange.start;
      if (item.created_at) {
        start = dayjs(item.created_at).startOf('day');
      } else if (item.due_date) {
        start = dayjs(item.due_date).subtract(3, 'day');
      }
      const end = item.due_date ? dayjs(item.due_date).startOf('day') : start.add(3, 'day');
      const left = Math.max(0, Math.min(100, ((start.valueOf() - ganttRange.start.valueOf()) / (spanMs * 86400000)) * 100));
      const width = Math.max(
        2,
        Math.min(100 - left, ((end.diff(start, 'day') + 1) / spanMs) * 100),
      );
      return { left, width, start, end };
    };

    /** 进度：已完成即 100%，否则按时间流逝比例估算 */
    const progressOf = (item: WorkbenchItem, start: Dayjs, end: Dayjs) => {
      if (item.status === 'done') return 100;
      const total = end.diff(start, 'day') + 1;
      if (total <= 0) return 0;
      const passed = dayjs().diff(start, 'day');
      return Math.max(0, Math.min(99, Math.round((passed / total) * 100)));
    };

    return (
      <Card size="small" title="甘特视图" variant="outlined" className="d509-card">
        <Flex gap={8} align="center" justify="space-between" wrap style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {ganttRange.start.format('YYYY/MM/DD')} → {ganttRange.end.format('YYYY/MM/DD')}
          </Typography.Text>
          <Flex gap={12} wrap>
            {[
              { color: '#DC2626', label: '逾期' },
              { color: '#2B5CE6', label: '进行中' },
              { color: '#D97706', label: '已暂停' },
              { color: '#12A594', label: '已完成' },
            ].map((legend) => (
              <Flex key={legend.label} gap={6} align="center">
                <span
                  aria-hidden
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 3,
                    background: legend.color,
                    display: 'inline-block',
                  }}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {legend.label}
                </Typography.Text>
              </Flex>
            ))}
          </Flex>
        </Flex>

        {rows.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可排期的条目" />
        ) : (
          <Flex vertical gap={8}>
            {rows.map((item) => {
              const { left, width, start, end } = position(item);
              const percent = progressOf(item, start, end);
              return (
                <Flex key={item.id} gap={12} align="center">
                  <Tooltip title={`${start.format('YYYY-MM-DD')} → ${end.format('YYYY-MM-DD')} · 进度 ${percent}%`}>
                    <Typography.Text
                      ellipsis
                      style={{ width: 180, flexShrink: 0, fontSize: 12.5 }}
                    >
                      {item.title || '未命名条目'}
                    </Typography.Text>
                  </Tooltip>
                  <div
                    style={{
                      position: 'relative',
                      flex: 1,
                      minWidth: 120,
                      height: 18,
                      borderRadius: 9,
                      background: 'var(--ant-color-fill-quaternary, rgba(20,26,34,0.06))',
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        left: `${left}%`,
                        width: `${width}%`,
                        top: 0,
                        bottom: 0,
                        borderRadius: 9,
                        background: `${dotColor(item)}33`,
                        border: `1px solid ${dotColor(item)}`,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${percent}%`,
                          height: '100%',
                          background: dotColor(item),
                        }}
                      />
                    </div>
                  </div>
                  <Typography.Text
                    type="secondary"
                    style={{ width: 96, flexShrink: 0, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {start.format('MM/DD')} → {end.format('MM/DD')}
                  </Typography.Text>
                </Flex>
              );
            })}
          </Flex>
        )}
      </Card>
    );
  };

  /** 主区：加载态 / 空态 / 三视图 */
  const main = (() => {
    if (loading) {
      return (
        <Card size="small" variant="outlined" className="d509-card">
          <Skeleton active paragraph={{ rows: 6 }} />
        </Card>
      );
    }
    if (items.length === 0) {
      return (
        <Card size="small" variant="outlined" className="d509-card">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有任务，先建一条">
            {emptyAction}
          </Empty>
        </Card>
      );
    }
    if (view === 'calendar') {
      return (
        <Flex vertical gap={12}>
          <Card size="small" variant="outlined" className="d509-card">
            <Calendar
              value={selectedDate}
              onSelect={(date: Dayjs) => setSelectedDate(date)}
              cellRender={(date: Dayjs, info) => {
                if (info.type !== 'date') return info.originNode;
                const list = itemsByDueDate.get(date.format('YYYY-MM-DD')) ?? [];
                if (!list.length) return info.originNode;
                return (
                  <Flex vertical gap={2} align="center">
                    {info.originNode}
                    <Flex gap={2} wrap justify="center">
                      {list.slice(0, 3).map((item) => (
                        <span
                          key={item.id}
                          aria-hidden
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: dotColor(item),
                            display: 'inline-block',
                          }}
                        />
                      ))}
                    </Flex>
                    {list.length > 3 ? (
                      <Typography.Text type="secondary" style={{ fontSize: 10 }}>
                        +{list.length - 3}
                      </Typography.Text>
                    ) : null}
                  </Flex>
                );
              }}
            />
          </Card>
          {renderDayItems()}
        </Flex>
      );
    }
    if (view === 'gantt') return renderGantt();
    return (
      <Card size="small" variant="outlined" className="d509-card" styles={{ body: { padding: 0 } }}>
        <Table<WorkbenchItem>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={sortedItems}
          pagination={{ pageSize: 10, size: 'small', showSizeChanger: false }}
          scroll={{ x: 720 }}
          onRow={(record: WorkbenchItem) => ({
            style: isOverdue(record)
              ? { background: 'rgba(220, 38, 38, 0.06)' }
              : undefined,
          })}
        />
      </Card>
    );
  })();

  return (
    <Flex vertical gap={16}>
      {/* ------------------------------------------------ 头部：概览 + 视图切换 */}
      <Flex gap={12} align="center" justify="space-between" wrap>
        <Flex gap={24} align="center" wrap>
          <Statistic title="进行中" value={stats.active} styles={{ content: { fontSize: 22 } }} />
          <Statistic title="今日到期" value={stats.dueToday} styles={{ content: { fontSize: 22 } }} />
          <Statistic
            title="逾期"
            value={stats.overdue}
            valueStyle={stats.overdue > 0 ? { color: '#DC2626' } : undefined}
            styles={{ content: { fontSize: 22 } }}
          />
          <Statistic title="本周完成" value={stats.doneThisWeek} styles={{ content: { fontSize: 22 } }} />
        </Flex>
        <Flex gap={8} align="center" wrap>
          <Segmented
            size="small"
            value={view}
            onChange={(v) => setView(v as 'list' | 'calendar' | 'gantt')}
            aria-label="切换视图"
            options={[
              { value: 'list', label: <span><UnorderedListOutlined /> 列表</span> },
              { value: 'calendar', label: <span><CalendarOutlined /> 日历</span> },
              { value: 'gantt', label: <span><BarChartOutlined /> 甘特</span> },
            ]}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
            新建任务
          </Button>
        </Flex>
      </Flex>

      {/* ------------------------------------------------ 错误态 */}
      {error ? (
        <Alert
          type="error"
          showIcon
          variant="filled"
          title="任务数据加载失败"
          description={errText(error, 120)}
          action={
            <Button size="small" type="primary" onClick={() => void itemsQuery.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}

      {/* ------------------------------------------------ 主区 */}
      {main}

      {/* ------------------------------------------------ 新建 / 编辑 Modal */}
      <Modal
        open={modalMode !== null}
        title={modalMode === 'edit' ? '编辑任务' : '新建任务'}
        okText={modalMode === 'edit' ? '保存' : '创建'}
        cancelText="取消"
        width={640}
        confirmLoading={createMutation.isPending || updateMutation.isPending}
        onOk={() => form.submit()}
        onCancel={closeModal}
        /* 表单常驻：打开时回填字段，避免 destroyOnHidden 后残留上一次的值 */
        forceRender
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={taskInitialValues}
          onFinish={submitTask}
          requiredMark={false}
        >
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="例如：整理实验数据并同步给导师" />
          </Form.Item>

          <Form.Item name="content" label="内容">
            <Input.TextArea rows={3} placeholder="补充说明（可选）" />
          </Form.Item>

          <Row gutter={12}>
            <Col xs={24} md={8}>
              <Form.Item name="kind" label="类型">
                <Select options={KIND_OPTIONS} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="priority" label="优先级">
                <Select options={PRIORITY_OPTIONS} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="status" label="状态">
                <Select options={STATUS_OPTIONS} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="due_date" label="截止日期">
            <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" allowClear />
          </Form.Item>

          <Form.Item name="project_id" label="所属项目">
            <Select
              options={projectOptions}
              allowClear
              placeholder="不归属任何项目"
              notFoundContent="还没有项目"
            />
          </Form.Item>

          {editing ? (
            <Alert
              type="info"
              showIcon
              variant="filled"
              title={
                <Flex gap={6} align="center">
                  <WarningOutlined aria-hidden />
                  <span>该条目由 {editing.source === 'capture' ? '智能捕获' : '手动创建'}加入工作台</span>
                </Flex>
              }
            />
          ) : null}
        </Form>
      </Modal>
    </Flex>
  );
}
