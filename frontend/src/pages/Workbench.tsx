import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Descriptions,
  Divider,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Popover,
  Progress,
  Row,
  Segmented,
  Select,
  Skeleton,
  Statistic,
  Tag,
  Tabs,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChartOutlined,
  BookOutlined,
  CalendarOutlined,
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  FlagOutlined,
  InboxOutlined,
  PlusOutlined,
  RocketOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import 'dayjs/locale/zh-cn';
import {
  api,
  type WorkbenchCapture,
  type WorkbenchItem,
  type WorkbenchPlan,
  type WorkbenchProject,
} from '../services/api';
import WorkbenchAssignments from '../components/WorkbenchAssignments';
import WorkbenchDailyReading from '../components/WorkbenchDailyReading';
import LazyMount from '../components/LazyMount';
import ErrorBoundary from '../components/ErrorBoundary';
import { useUrlState } from '../hooks/useTableState';
import { useDebounced } from '../hooks/useDebounced';
import { errText } from '../utils/err';

dayjs.locale('zh-cn');

/* 图表组件懒加载：@ant-design/plots 不进入工作台首屏 chunk */
const TaskStatusDonut = lazy(() => import('../components/charts/TaskStatusDonut'));
/* 实验记录面板按需加载，避免首发 chunk 带上模板表格 */
const ElnPanel = lazy(() => import('./lab/ElnPanel'));

/** 图表懒加载占位 */
function ChartFallback() {
  return (
    <Card size="small">
      <Skeleton active title={{ width: '38%' }} paragraph={{ rows: 3 }} />
    </Card>
  );
}

/** URL 查询参数的默认值（useUrlState 要求默认值引用稳定） */
const FILTER_DEFAULTS = { q: '', kind: 'all', tab: 'tasks' };

/* ------------------------------------------------------------------ 词典 */

const KIND_CN: Record<string, string> = {
  task: '任务',
  project: '项目',
  plan: '计划',
  idea: '想法',
  knowledge: '知识',
  memory: '记忆',
  note: '随手记',
};

const STATUS_CN: Record<string, string> = {
  active: '进行中',
  done: '已完成',
  paused: '已暂停',
  archived: '已归档',
};

const HEALTH_CN: Record<string, string> = {
  on_track: '正常',
  at_risk: '有风险',
  blocked: '受阻',
  done: '已完成',
};

const PRIORITY_CN: Record<string, string> = {
  low: '低',
  normal: '中',
  high: '高',
  urgent: '紧急',
};

const PRIORITY_COLOR: Record<string, string> = {
  low: 'default',
  normal: 'blue',
  high: 'gold',
  urgent: 'red',
};

const HEALTH_COLOR: Record<string, string> = {
  on_track: 'green',
  at_risk: 'gold',
  blocked: 'red',
  done: 'default',
};

const kindCn = (k?: string) => (k && KIND_CN[k]) || '条目';
const statusCn = (s?: string) => (s && STATUS_CN[s]) || '未知';
const healthCn = (h?: string) => (h && HEALTH_CN[h]) || '未知';
const priorityCn = (p?: string) => (p && PRIORITY_CN[p]) || '中';

/* ------------------------------------------------------------------ 样式 */

const GRADIENT = 'linear-gradient(135deg, #2B5CE6, #12A594)';


/** 卡片外壳：左侧 3px 色条 + 圆角 16 + hover 上浮 2px */
function Panel({
  title,
  extra,
  color,
  children,
  bodyStyle,
}: {
  title?: React.ReactNode;
  extra?: React.ReactNode;
  color: string;
  children: React.ReactNode;
  bodyStyle?: React.CSSProperties;
}) {
  return (
    <Card
      className="d509-card"
      variant="outlined"
      title={title}
      extra={extra}
      styles={{ body: { padding: 16, ...bodyStyle } }}
      style={{
        borderRadius: 16,
        borderLeft: `3px solid ${color}`,
        height: '100%',
      }}
    >
      {children}
    </Card>
  );
}

/** 条目行 */
function ItemRow({
  item,
  onDone,
  onDelete,
  onEdit,
  danger,
  busy,
}: {
  item: WorkbenchItem;
  onDone?: (item: WorkbenchItem) => void;
  onDelete?: (item: WorkbenchItem) => void;
  onEdit?: (item: WorkbenchItem) => void;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <Flex
      gap={10}
      align="flex-start"
      justify="space-between"
      style={{
        padding: '10px 12px',
        borderRadius: 12,
        border: '1px solid var(--ant-color-border-secondary, #EEF0F4)',
        background: danger ? 'rgba(220, 38, 38, 0.05)' : 'var(--ant-color-bg-container, #fff)',
      }}
    >
      <Flex vertical gap={4} style={{ minWidth: 0, flex: 1 }}>
        <Flex gap={6} align="center" wrap>
          <Typography.Text strong style={{ fontSize: 13.5 }}>
            {item.title}
          </Typography.Text>
          <Tag color={PRIORITY_COLOR[item.priority || 'normal']} style={{ margin: 0, fontSize: 11 }}>
            优先级{priorityCn(item.priority)}
          </Tag>
          <Tag style={{ margin: 0, fontSize: 11 }}>{kindCn(item.kind)}</Tag>
        </Flex>
        {item.content ? (
          <Typography.Paragraph
            type="secondary"
            style={{ margin: 0, fontSize: 12.5 }}
            ellipsis={{ rows: 2 }}
          >
            {item.content}
          </Typography.Paragraph>
        ) : null}
        <Flex gap={10} align="center" wrap style={{ fontSize: 11.5 }}>
          {item.due_date ? (
            <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
              截止 {dayjs(item.due_date).format('YYYY-MM-DD')}
            </Typography.Text>
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
        </Flex>
      </Flex>
      <Flex gap={6} vertical={false}>
        {onEdit ? (
          <Button
            size="small"
            type="text"
            icon={<EditOutlined />}
            aria-label="编辑"
            onClick={() => onEdit(item)}
          />
        ) : null}
        {onDone ? (
          <Button
            size="small"
            type="text"
            icon={<CheckOutlined />}
            loading={busy}
            onClick={() => onDone(item)}
          >
            标记完成
          </Button>
        ) : null}
        {onDelete ? (
          <Popconfirm
            title="确定删除这条记录？"
            description="删除后不可恢复。"
            okText="删除"
            cancelText="取消"
            onConfirm={() => onDelete(item)}
          >
            <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="删除" />
          </Popconfirm>
        ) : null}
      </Flex>
    </Flex>
  );
}

/* ------------------------------------------------------------------ 页面 */

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const GANTT_DAY_W = 26;
const GANTT_LABEL_W = 200;

/** 日历/甘特共用的强调色：完成→青绿，逾期或紧急→红，高→橙，其余品牌蓝 */
function itemAccent(item: WorkbenchItem): string {
  if (item.status === 'done') return '#12A594';
  if (item.due_date && dayjs(item.due_date).isBefore(dayjs(), 'day')) return '#DC2626';
  if (item.priority === 'urgent') return '#DC2626';
  if (item.priority === 'high') return '#D97706';
  return '#2B5CE6';
}

/** 点击日历块 / 甘特条后的快捷操作 */
function ItemPeek({
  item,
  onDone,
  onDelete,
  onEdit,
}: {
  item: WorkbenchItem;
  onDone: (item: WorkbenchItem) => void;
  onDelete: (item: WorkbenchItem) => void;
  onEdit?: (item: WorkbenchItem) => void;
}) {
  return (
    <Flex vertical gap={8} style={{ maxWidth: 260 }}>
      <Typography.Text strong style={{ fontSize: 13 }}>
        {item.title}
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {statusCn(item.status)} · 截止 {item.due_date ? dayjs(item.due_date).format('YYYY-MM-DD') : '未设置'}
      </Typography.Text>
      <Flex gap={6}>
        {onEdit ? (
          <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(item)}>
            编辑
          </Button>
        ) : null}
        <Button size="small" type="primary" disabled={item.status === 'done'} onClick={() => onDone(item)}>
          标记完成
        </Button>
        <Popconfirm title="确定删除这条记录？" okText="删除" cancelText="取消" onConfirm={() => onDelete(item)}>
          <Button size="small" danger>
            删除
          </Button>
        </Popconfirm>
      </Flex>
    </Flex>
  );
}

/** 月历视图：按截止日期铺排任务，可前后翻月 */
function TaskCalendar({
  items,
  onDone,
  onDelete,
  onEdit,
}: {
  items: WorkbenchItem[];
  onDone: (item: WorkbenchItem) => void;
  onDelete: (item: WorkbenchItem) => void;
  onEdit?: (item: WorkbenchItem) => void;
}) {
  const [month, setMonth] = useState(() => dayjs().startOf('month'));
  const [showDone, setShowDone] = useState(false);

  const visible = useMemo(
    () => (showDone ? items : items.filter((it) => it.status !== 'done')),
    [items, showDone],
  );

  const byDay = useMemo(() => {
    const map = new Map<string, WorkbenchItem[]>();
    for (const it of visible) {
      if (!it.due_date) continue;
      const key = dayjs(it.due_date).format('YYYY-MM-DD');
      const arr = map.get(key);
      if (arr) arr.push(it);
      else map.set(key, [it]);
    }
    return map;
  }, [visible]);

  const gridStart = month.startOf('week');
  const gridEnd = month.endOf('month').endOf('week');
  const days: Dayjs[] = [];
  for (let d = gridStart; d.isBefore(gridEnd) || d.isSame(gridEnd, 'day'); d = d.add(1, 'day')) days.push(d);
  const today = dayjs();
  const todayTasks = byDay.get(today.format('YYYY-MM-DD')) ?? [];

  return (
    <Flex vertical gap={12}>
      <Flex gap={8} align="center" wrap>
        <Button size="small" onClick={() => setMonth((m) => m.subtract(1, 'month'))}>
          上月
        </Button>
        <Typography.Text strong style={{ fontSize: 14, minWidth: 92, textAlign: 'center' }}>
          {month.format('YYYY 年 M 月')}
        </Typography.Text>
        <Button size="small" onClick={() => setMonth((m) => m.add(1, 'month'))}>
          下月
        </Button>
        <Button size="small" type="link" onClick={() => setMonth(dayjs().startOf('month'))}>
          回到本月
        </Button>
        <Checkbox checked={showDone} onChange={(e) => setShowDone(e.target.checked)}>
          <span style={{ fontSize: 12.5 }}>显示已完成</span>
        </Checkbox>
        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>
          按截止日期展示，点击事项可编辑 / 完成 / 删除
        </Typography.Text>
      </Flex>
      <Alert
        type={todayTasks.length ? 'info' : 'success'}
        showIcon
        variant="filled"
        message={
          todayTasks.length
            ? `今天有 ${todayTasks.length} 项任务到期`
            : '今天没有到期任务，保持节奏。'
        }
        description={
          todayTasks.length ? (
            <Flex gap={6} wrap>
              {todayTasks.map((it) => (
                <Tag
                  key={it.id}
                  color={it.status === 'done' ? 'default' : PRIORITY_COLOR[it.priority || 'normal']}
                  style={{ margin: 0, cursor: 'pointer' }}
                  onClick={() => onEdit?.(it)}
                >
                  {it.title}
                </Tag>
              ))}
            </Flex>
          ) : undefined
        }
      />
      <div className="d509-cal">
        <div className="d509-cal-week">
          {WEEK_LABELS.map((w) => (
            <div key={w} className="d509-cal-wd">
              {w}
            </div>
          ))}
        </div>
        <div className="d509-cal-grid">
          {days.map((d) => {
            const list = byDay.get(d.format('YYYY-MM-DD')) ?? [];
            return (
              <div
                key={d.valueOf()}
                className={`d509-cal-cell${d.isSame(month, 'month') ? '' : ' is-out'}${d.isSame(today, 'day') ? ' is-today' : ''}`}
              >
                <div className="d509-cal-num">{d.date()}</div>
                <Flex vertical gap={3} style={{ minWidth: 0 }}>
                  {list.slice(0, 3).map((it) => (
                    <Popover
                      key={it.id}
                      trigger="click"
                      placement="right"
                      content={<ItemPeek item={it} onDone={onDone} onDelete={onDelete} onEdit={onEdit} />}
                    >
                      <button
                        type="button"
                        className={`d509-cal-chip${it.status === 'done' ? ' is-done' : ''}`}
                        style={{ borderLeftColor: itemAccent(it) }}
                        title={it.title}
                      >
                        {it.title}
                      </button>
                    </Popover>
                  ))}
                  {list.length > 3 ? <span className="d509-cal-more">+{list.length - 3} 项</span> : null}
                </Flex>
              </div>
            );
          })}
        </div>
      </div>
    </Flex>
  );
}

/** 甘特视图：以创建日期为起点、截止日期为终点绘制任务条 */
function TaskGantt({
  items,
  onDone,
  onDelete,
  onEdit,
}: {
  items: WorkbenchItem[];
  onDone: (item: WorkbenchItem) => void;
  onDelete: (item: WorkbenchItem) => void;
  onEdit?: (item: WorkbenchItem) => void;
}) {
  const today = dayjs().startOf('day');
  const rows = useMemo(
    () =>
      items
        .filter((i) => i.due_date)
        .map((i) => {
          const end = dayjs(i.due_date).startOf('day');
          const created = i.created_at ? dayjs(i.created_at).startOf('day') : end.subtract(2, 'day');
          return { item: i, start: created.isAfter(end) ? end : created, end };
        })
        .sort((a, b) => a.end.valueOf() - b.end.valueOf()),
    [items],
  );

  if (rows.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有带截止日期的事项，先给任务设置一个截止日期" />;
  }

  let rangeStart = today;
  let rangeEnd = today;
  for (const { start, end } of rows) {
    if (start.isBefore(rangeStart)) rangeStart = start;
    if (end.isAfter(rangeEnd)) rangeEnd = end;
  }
  rangeStart = rangeStart.startOf('week').subtract(7, 'day');
  rangeEnd = rangeEnd.startOf('week').add(8, 'week').endOf('week');

  const days: Dayjs[] = [];
  for (let d = rangeStart; d.isBefore(rangeEnd) || d.isSame(rangeEnd, 'day'); d = d.add(1, 'day')) days.push(d);
  const totalW = days.length * GANTT_DAY_W;
  const nowLeft = (today.diff(rangeStart, 'day') + 0.5) * GANTT_DAY_W;

  const months: { key: string; label: string; days: number }[] = [];
  for (const d of days) {
    const key = d.format('YYYY-MM');
    const last = months[months.length - 1];
    if (last && last.key === key) last.days += 1;
    else months.push({ key, label: d.format('YYYY 年 M 月'), days: 1 });
  }

  return (
    <Flex vertical gap={10}>
      <Flex gap={14} wrap align="center" style={{ fontSize: 11.5, color: 'var(--d509-text-secondary)' }}>
        <span>
          <i className="d509-gantt-dot" style={{ background: '#2B5CE6' }} />
          进行中
        </span>
        <span>
          <i className="d509-gantt-dot" style={{ background: '#D97706' }} />
          高优先级
        </span>
        <span>
          <i className="d509-gantt-dot" style={{ background: '#DC2626' }} />
          逾期 / 紧急
        </span>
        <span>
          <i className="d509-gantt-dot" style={{ background: '#12A594' }} />
          已完成
        </span>
        <span style={{ marginLeft: 'auto' }}>
          共 {rows.length} 项 · 按截止日期排序
        </span>
      </Flex>
      <div className="d509-gantt">
        <div className="d509-gantt-inner" style={{ width: GANTT_LABEL_W + totalW }}>
          <div className="d509-gantt-row is-head">
            <div className="d509-gantt-label">事项</div>
            <div className="d509-gantt-track">
              <div className="d509-gantt-days">
                {months.map((m) => (
                  <div key={m.key} className="d509-gantt-month" style={{ width: m.days * GANTT_DAY_W }}>
                    {m.label}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="d509-gantt-row is-head">
            <div className="d509-gantt-label" style={{ fontSize: 11, color: 'var(--d509-text-secondary)' }}>
              截止日期
            </div>
            <div className="d509-gantt-track">
              <div className="d509-gantt-days">
                {days.map((d) => (
                  <div
                    key={d.valueOf()}
                    className={`d509-gantt-day${d.day() === 0 || d.day() === 6 ? ' is-weekend' : ''}${d.isSame(today, 'day') ? ' is-today' : ''}`}
                  >
                    {d.date()}
                    <span className="d509-gantt-wd">{WEEK_LABELS[(d.day() + 6) % 7]}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          {rows.map(({ item, start, end }) => {
            const left = start.diff(rangeStart, 'day') * GANTT_DAY_W + 2;
            const width = Math.max(1, end.diff(start, 'day') + 1) * GANTT_DAY_W - 4;
            return (
              <div key={item.id} className="d509-gantt-row">
                <div className="d509-gantt-label">
                  <span className="d509-gantt-dot" style={{ background: itemAccent(item) }} />
                  <Typography.Text ellipsis style={{ fontSize: 12, flex: 1 }}>
                    {item.title}
                  </Typography.Text>
                </div>
                <div className="d509-gantt-track">
                  <span className="d509-gantt-now" style={{ left: nowLeft }} />
                  <Popover
                    trigger="click"
                    placement="top"
                    content={<ItemPeek item={item} onDone={onDone} onDelete={onDelete} onEdit={onEdit} />}
                  >
                    <button
                      type="button"
                      className="d509-gantt-bar"
                      style={{ left, width, background: itemAccent(item) }}
                      aria-label={item.title}
                    >
                      {width > 70 ? item.title : ''}
                    </button>
                  </Popover>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Flex>
  );
}

/* ------------------------------------------------------------------ 页面 */

/** 项目下的任务草稿：新建项目时随表单一起提交，也可在已有项目上追加。 */
type TaskDraft = {
  title?: string;
  priority?: string;
  due_date?: Dayjs;
};

/** 任务行编辑（Form.List），标题必填，优先级与截止日期可选。 */
function TaskFields() {
  return (
    <Form.List name="tasks">
      {(fields, { add, remove }) => (
        <Flex vertical gap={8}>
          {fields.map((field) => (
            <Flex key={field.key} gap={6} align="flex-start" wrap>
              <Form.Item
                name={[field.name, 'title']}
                rules={[{ required: true, message: '请输入任务标题' }]}
                style={{ flex: '1 1 200px', marginBottom: 0 }}
              >
                <Input placeholder="任务标题，例如：下载 NR 数据库" />
              </Form.Item>
              <Form.Item name={[field.name, 'priority']} style={{ width: 84, marginBottom: 0 }}>
                <Select
                  options={Object.entries(PRIORITY_CN).map(([value, label]) => ({ value, label }))}
                  aria-label="优先级"
                />
              </Form.Item>
              <Form.Item name={[field.name, 'due_date']} style={{ width: 150, marginBottom: 0 }}>
                <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" placeholder="截止日期" />
              </Form.Item>
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                aria-label="删除任务"
                onClick={() => remove(field.name)}
              />
            </Flex>
          ))}
          <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ priority: 'normal' })}>
            添加任务
          </Button>
        </Flex>
      )}
    </Form.List>
  );
}

export default function Workbench() {
  const { message } = App.useApp();
  const qc = useQueryClient();

  const [captureText, setCaptureText] = useState('');
  const [capture, setCapture] = useState<WorkbenchCapture | null>(null);
  const [editor, setEditor] = useState<{ item?: WorkbenchItem; dueDate?: Dayjs } | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [taskProject, setTaskProject] = useState<WorkbenchProject | null>(null);
  const [view, setView] = useState<'list' | 'calendar' | 'gantt'>('list');
  // 搜索词与类型筛选放在 URL 上：刷新不丢、可分享、面板跳转回来还是同一视图
  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);
  const search = filters.q;
  const kindFilter = filters.kind;
  const tab = filters.tab;
  const setSearch = (v: string) => setFilters({ q: v });
  const setKindFilter = (v: string) => setFilters({ kind: v });
  const searchActive = Boolean(search.trim()) || kindFilter !== 'all';
  const [planForm] = Form.useForm();
  const [projectForm] = Form.useForm();
  const [taskForm] = Form.useForm();
  const [itemForm] = Form.useForm();
  const [captureForm] = Form.useForm();

  const openEditor = (item?: WorkbenchItem, dueDate?: Dayjs) => setEditor({ item, dueDate });

  useEffect(() => {
    if (!capture) return;
    captureForm.setFieldsValue({
      title: capture.item.title,
      kind: capture.item.kind,
      priority: capture.extracted?.priority || capture.item.priority || 'normal',
      due_date: capture.extracted?.due_date ? dayjs(capture.extracted.due_date) : undefined,
      tags: capture.extracted?.tags ?? capture.item.tags ?? [],
    });
  }, [capture, captureForm]);

  useEffect(() => {
    if (!editor) return;
    const item = editor.item;
    itemForm.setFieldsValue({
      title: item?.title ?? '',
      content: item?.content ?? '',
      kind: item?.kind ?? 'task',
      priority: item?.priority ?? 'normal',
      status: item?.status ?? 'active',
      tags: item?.tags ?? [],
      project_id: item?.project_id ?? undefined,
      due_date: item?.due_date ? dayjs(item.due_date) : editor.dueDate,
    });
  }, [editor, itemForm]);

  /* ---------------------------------------------------------- 数据查询 */

  const summaryQuery = useQuery({
    queryKey: ['workbench-summary'],
    queryFn: api.workbenchSummary,
    staleTime: 30_000,
  });

  const itemsQuery = useQuery({
    queryKey: ['workbench-items', 'all'],
    queryFn: () => api.workbenchItems({ limit: 200 }),
    staleTime: 30_000,
  });

  const assignmentsQuery = useQuery({
    queryKey: ['workbench-assignments'],
    queryFn: api.workbenchAssignments,
    staleTime: 15_000,
  });
  const pendingAssignments = (assignmentsQuery.data?.incoming ?? []).filter(
    (a) => a.status !== 'accepted',
  ).length;

  // 输入框每敲一个字就写 URL 并发请求，节流到 300ms 后再打后端
  const debouncedSearch = useDebounced(search, 300);

  const searchQuery = useQuery({
    queryKey: ['workbench-items', 'search', debouncedSearch, kindFilter],
    queryFn: () =>
      api.workbenchItems({
        q: debouncedSearch.trim() || undefined,
        kind: kindFilter === 'all' ? undefined : kindFilter,
        limit: 100,
      }),
    enabled: searchActive,
    staleTime: 30_000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['workbench-summary'] });
    void qc.invalidateQueries({ queryKey: ['workbench-items'] });
  };

  /* ---------------------------------------------------------- 变更操作 */

  const captureMutation = useMutation({
    mutationFn: (text: string) => api.workbenchCapture(text),
    onSuccess: (data) => {
      setCapture(data);
      invalidate();
    },
    onError: (e: Error) => message.error(`捕获失败：${errText(e)}`),
  });

  const confirmCaptureMutation = useMutation({
    mutationFn: async (data: WorkbenchCapture) => {
      const edited = captureForm.getFieldsValue();
      const created = await api.workbenchCreateItem({
        kind: edited.kind || data.item.kind,
        title: (edited.title || data.item.title || '').trim(),
        content: data.item.content,
        priority: edited.priority || data.item.priority,
        tags: edited.tags ?? data.item.tags,
        due_date: edited.due_date ? edited.due_date.format('YYYY-MM-DD') : null,
      });
      // 捕获阶段的临时条目已落库（source='capture'），写入成功后删除，避免重复
      try {
        await api.workbenchDeleteItem(data.item.id);
      } catch {
        /* 临时条目清理失败不阻断主流程 */
      }
      return created;
    },
    onSuccess: () => {
      message.success('已写入工作台');
      setCapture(null);
      setCaptureText('');
      captureForm.resetFields();
      invalidate();
    },
    onError: (e: Error) => message.error(`写入失败：${errText(e)}`),
  });

  const discardCaptureMutation = useMutation({
    mutationFn: (id: string) => api.workbenchDeleteItem(id),
    onSuccess: (_r, id) => {
      // 重新编辑：删除临时条目并把原文回填输入框
      const prev = capture?.item;
      if (prev && prev.id === id) setCaptureText(prev.content || prev.title || '');
      setCapture(null);
      invalidate();
    },
    onError: (e: Error) => message.error(`清理失败：${errText(e)}`),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<WorkbenchItem> }) =>
      api.workbenchUpdateItem(id, body),
    onSuccess: () => {
      message.success('已更新');
      invalidate();
    },
    onError: (e: Error) => message.error(`更新失败：${errText(e)}`),
  });

  const saveItemMutation = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Partial<WorkbenchItem> }) =>
      id ? api.workbenchUpdateItem(id, body) : api.workbenchCreateItem(body),
    onSuccess: (_res, vars) => {
      message.success(vars.id ? '已保存修改' : '任务已创建');
      setEditor(null);
      itemForm.resetFields();
      invalidate();
    },
    onError: (e: Error) => message.error(`保存失败：${errText(e)}`),
  });

  /**
   * 删除后 6 秒内可撤销。
   *
   * 之前只有一句「已删除」的提示，误删即永久丢失；这里把删掉的整条记录
   * 留在闭包里，撤销时按原字段重建（保留标题/内容/标签/优先级/截止日期）。
   */
  const deleteMutation = useMutation({
    mutationFn: (item: WorkbenchItem) => api.workbenchDeleteItem(item.id).then(() => item),
    onSuccess: (item) => {
      invalidate();
      const key = `wb-undo-${item.id}`;
      message.open({
        key,
        type: 'success',
        duration: 6,
        content: (
          <Flex gap={12} align="center">
            <span>已删除「{item.title || '未命名'}」</span>
            <Button
              size="small"
              type="link"
              style={{ padding: 0, height: 'auto' }}
              onClick={() => {
                message.destroy(key);
                undoMutation.mutate(item);
              }}
            >
              撤销
            </Button>
          </Flex>
        ),
      });
    },
    onError: (e: Error) => message.error(`删除失败：${errText(e)}`),
  });

  const undoMutation = useMutation({
    mutationFn: (item: WorkbenchItem) =>
      api.workbenchCreateItem({
        kind: item.kind,
        title: item.title,
        content: item.content,
        tags: item.tags,
        priority: item.priority,
        due_date: item.due_date ?? undefined,
        project_id: item.project_id ?? undefined,
        plan_id: item.plan_id ?? undefined,
        status: item.status,
      }),
    onSuccess: () => {
      message.success('已恢复');
      invalidate();
    },
    onError: (e: Error) => message.error(`恢复失败：${errText(e)}`),
  });

  const createPlanMutation = useMutation({
    mutationFn: (body: Partial<WorkbenchPlan>) => api.workbenchCreatePlan(body),
    onSuccess: () => {
      message.success('计划已创建');
      setPlanOpen(false);
      planForm.resetFields();
      invalidate();
    },
    onError: (e: Error) => message.error(`创建失败：${errText(e)}`),
  });

  /** 按草稿逐条创建任务并挂到项目下；空标题的行直接跳过。 */
  const createProjectTasks = async (projectID: string, tasks?: TaskDraft[]) => {
    let count = 0;
    for (const task of tasks ?? []) {
      const title = (task.title || '').trim();
      if (!title) continue;
      await api.workbenchCreateItem({
        kind: 'task',
        title,
        content: '',
        priority: task.priority || 'normal',
        status: 'active',
        project_id: projectID,
        due_date: task.due_date ? task.due_date.format('YYYY-MM-DD') : undefined,
      });
      count += 1;
    }
    return count;
  };

  const createProjectMutation = useMutation({
    mutationFn: async ({ project, tasks }: { project: Partial<WorkbenchProject>; tasks?: TaskDraft[] }) => {
      const res = await api.workbenchCreateProject(project);
      let count = 0;
      let taskError = '';
      try {
        count = await createProjectTasks(res.project.id, tasks);
      } catch (e) {
        // 项目已经落库，任务失败不能连累项目，提示后由用户在卡片上补加
        taskError = errText(e as Error);
      }
      return { project: res.project, count, taskError };
    },
    onSuccess: (res) => {
      if (res.taskError) message.warning(`项目已创建，但任务安排中断：${res.taskError}`);
      else message.success(res.count ? `项目已创建，已安排 ${res.count} 项任务` : '项目已创建');
      setProjectOpen(false);
      projectForm.resetFields();
      invalidate();
    },
    onError: (e: Error) => message.error(`创建失败：${errText(e)}`),
  });

  const addTasksMutation = useMutation({
    mutationFn: ({ project, tasks }: { project: WorkbenchProject; tasks?: TaskDraft[] }) =>
      createProjectTasks(project.id, tasks),
    onSuccess: (count, { project }) => {
      message.success(`已为「${project.name}」添加 ${count} 项任务`);
      setTaskProject(null);
      taskForm.resetFields();
      invalidate();
    },
    onError: (e: Error) => message.error(`添加失败：${errText(e)}`),
  });

  /* ---------------------------------------------------------- 派生数据 */

  const summary = summaryQuery.data;
  const allItems = itemsQuery.data?.items ?? [];

  const actionItems = useMemo(() => allItems.filter((i) => i.kind === 'task'), [allItems]);
  const growthItems = useMemo(
    () => allItems.filter((i) => i.kind === 'memory' || i.kind === 'knowledge'),
    [allItems],
  );
  const knowledgeItems = useMemo(
    () => allItems.filter((i) => i.kind === 'idea' || i.kind === 'knowledge'),
    [allItems],
  );
  const projects: WorkbenchProject[] = summary?.projects ?? [];

  // 项目卡片直接复用条目列表里的任务，避免再按项目逐个请求。
  const tasksByProject = useMemo(() => {
    const map = new Map<string, WorkbenchItem[]>();
    for (const item of allItems) {
      if (item.kind !== 'task' || !item.project_id) continue;
      const bucket = map.get(item.project_id);
      if (bucket) bucket.push(item);
      else map.set(item.project_id, [item]);
    }
    return map;
  }, [allItems]);

  const directions = summary?.plans?.directions ?? [];
  const stages = summary?.plans?.stages ?? [];

  const today = summary?.today;
  const overdue = today?.overdue ?? [];
  const dueToday = today?.dueToday ?? [];
  const others = today?.others ?? [];
  const stats = summary?.stats;

  const searchItems = searchQuery.data?.items ?? [];
  const searchTotal = searchQuery.data?.total ?? 0;

  const loading = summaryQuery.isLoading && !summary;
  const error = summaryQuery.error as Error | null;

  /* ---------------------------------------------------------- 渲染 */

  const planProgress = (p: WorkbenchPlan) => Math.max(0, Math.min(100, Number(p.progress ?? 0)));

  const submitCapture = () => {
    const text = captureText.trim();
    if (!text) {
      message.warning('请输入内容');
      return;
    }
    captureMutation.mutate(text);
  };

  const submitPlan = (values: {
    title: string;
    outcome?: string;
    horizon?: string;
    metrics?: string;
    next_step?: string;
    due_date?: Dayjs;
    kind?: string;
  }) => {
    createPlanMutation.mutate({
      kind: values.kind === 'stage' ? 'stage' : 'direction',
      title: values.title.trim(),
      outcome: values.outcome ?? '',
      horizon: values.horizon ?? '',
      metrics: values.metrics ?? '',
      next_step: values.next_step ?? '',
      due_date: values.due_date ? values.due_date.format('YYYY-MM-DD') : null,
    });
  };

  const submitProject = (values: {
    name: string;
    description?: string;
    next_step?: string;
    health?: string;
    status?: string;
    due_date?: Dayjs;
    tasks?: TaskDraft[];
  }) => {
    createProjectMutation.mutate({
      project: {
        name: values.name.trim(),
        description: values.description ?? '',
        next_step: values.next_step ?? '',
        health: values.health ?? 'on_track',
        status: values.status ?? 'active',
        due_date: values.due_date ? values.due_date.format('YYYY-MM-DD') : null,
      },
      tasks: values.tasks,
    });
  };

  const submitItem = (values: {
    title: string;
    content?: string;
    kind?: string;
    priority?: string;
    status?: string;
    tags?: string[];
    project_id?: string;
    due_date?: Dayjs;
  }) => {
    saveItemMutation.mutate({
      id: editor?.item?.id,
      body: {
        title: values.title.trim(),
        content: values.content ?? '',
        kind: values.kind ?? 'task',
        priority: values.priority ?? 'normal',
        status: values.status ?? 'active',
        tags: values.tags ?? [],
        project_id: values.project_id ?? null,
        due_date: values.due_date ? values.due_date.format('YYYY-MM-DD') : null,
      },
    });
  };

  return (
    <Flex vertical gap={16} className="d509-enter">
      {/* ------------------------------------------------ 页面标题 */}
      <Flex align="center" justify="space-between" wrap gap={12}>
        <div>
          <Typography.Title level={3} style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
            个人工作台
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            记录、聚焦、推进——所有事项都在这里汇合
          </Typography.Text>
        </div>
        <Flex gap={8} align="center" wrap>
          <Input.Search
            allowClear
            placeholder="搜索标题或内容…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 240 }}
          />
          <Segmented
            value={kindFilter}
            onChange={(v) => setKindFilter(String(v))}
            options={[
              { value: 'all', label: '全部' },
              { value: 'task', label: '任务' },
              { value: 'project', label: '项目' },
              { value: 'idea', label: '想法' },
              { value: 'knowledge', label: '知识' },
              { value: 'memory', label: '记忆' },
              { value: 'note', label: '随手记' },
            ]}
          />
        </Flex>
      </Flex>

      {/* ------------------------------------------------ 错误态 */}
      {error ? (
        <Alert
          type="error"
          showIcon
          variant="filled"
          title="工作台数据加载失败"
          description={error.message}
          action={
            <Button size="small" type="primary" onClick={() => void summaryQuery.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}

      {/* ------------------------------------------------ 顶部：快速记录 + 概览 */}
      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} xl={15}>
          <Panel
            color="#2B5CE6"
            title={
              <Flex gap={8} align="center">
                <ThunderboltOutlined style={{ color: '#2B5CE6' }} />
                AI 指挥中心
              </Flex>
            }
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                回车即可记录
              </Typography.Text>
            }
          >
            <Input.TextArea
              rows={3}
              value={captureText}
              onChange={(e) => setCaptureText(e.target.value)}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  submitCapture();
                }
              }}
              placeholder="例如：明天下午提交论文修改稿 / 想做一个每周复盘模板"
            />
            <Flex gap={8} align="center" justify="flex-end" style={{ marginTop: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 'auto' }}>
                AI 会自动判断类型、截止日期、标签与优先级
              </Typography.Text>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                loading={captureMutation.isPending}
                onClick={submitCapture}
                style={{ background: GRADIENT, border: 'none' }}
              >
                记录
              </Button>
            </Flex>
          </Panel>
        </Col>
        <Col xs={24} xl={9}>
          <Panel
            color="#12A594"
            title={
              <Flex gap={8} align="center">
                <InboxOutlined style={{ color: '#12A594' }} />
                概览
              </Flex>
            }
          >
            {loading ? (
              <Skeleton active paragraph={{ rows: 2 }} />
            ) : (
              <div className="d509-stat-grid">
                <Statistic title="进行中任务" value={stats?.activeTasks ?? 0} />
                <Statistic title="进行中项目" value={stats?.activeProjects ?? 0} />
                <Statistic title="长期计划" value={stats?.activeDirections ?? 0} />
                <Statistic title="收件箱" value={stats?.inbox ?? 0} />
                <Statistic title="本周已完成" value={stats?.completedThisWeek ?? 0} />
              </div>
            )}
          </Panel>
        </Col>
      </Row>

      {/* ------------------------------------------------ 主视图分页 */}
      <Card size="small" className="d509-card" style={{ borderRadius: 16 }}>
        <Tabs
          activeKey={tab}
          onChange={(k) => setFilters({ tab: k })}
          items={[
            {
              key: 'tasks',
              label: (
                <Flex gap={6} align="center">
                  <UnorderedListOutlined /> 任务
                  <Tag style={{ margin: 0 }}>{actionItems.length}</Tag>
                </Flex>
              ),
              children: (
                <>
                  <Flex justify="space-between" align="center" wrap gap={8} style={{ marginBottom: 12 }}>
                    <Flex gap={8}>
                      <Button
                        size="small"
                        type="primary"
                        icon={<PlusOutlined />}
                        onClick={() => openEditor(undefined, dayjs())}
                      >
                        新建任务
                      </Button>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        共 {actionItems.length} 项，逾期 {overdue.length} 项
                      </Typography.Text>
                    </Flex>
                    <Segmented
                      size="small"
                      value={view}
                      onChange={(v) => setView(v as 'list' | 'calendar' | 'gantt')}
                      options={[
                        {
                          value: 'list',
                          label: (
                            <span>
                              <UnorderedListOutlined /> 列表
                            </span>
                          ),
                        },
                        {
                          value: 'calendar',
                          label: (
                            <span>
                              <CalendarOutlined /> 日历
                            </span>
                          ),
                        },
                        {
                          value: 'gantt',
                          label: (
                            <span>
                              <BarChartOutlined /> 甘特
                            </span>
                          ),
                        },
                      ]}
                    />
                  </Flex>
              {view === 'list' ? (
                loading ? (
                  <Skeleton active paragraph={{ rows: 4 }} />
                ) : (
                  <Flex vertical gap={14}>
                    {[
                      { key: 'overdue', title: '逾期事项', color: '#DC2626', data: overdue, danger: true },
                      { key: 'dueToday', title: '今日到期', color: '#D97706', data: dueToday, danger: false },
                      { key: 'others', title: '其他事项', color: '#2B5CE6', data: others, danger: false },
                    ].map((group) => (
                      <div key={group.key}>
                        <Flex gap={8} align="center" justify="space-between">
                          <Flex gap={8} align="center">
                            <span
                              style={{ width: 3, height: 14, borderRadius: 2, background: group.color, display: 'inline-block' }}
                            />
                            <Typography.Text strong style={{ fontSize: 13 }}>
                              {group.title}
                            </Typography.Text>
                          </Flex>
                          <Tag style={{ margin: 0 }}>{group.data.length}</Tag>
                        </Flex>
                        <Flex vertical gap={8} style={{ marginTop: 8 }}>
                          {group.data.length === 0 ? (
                            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                              {group.key === 'overdue'
                                ? '没有逾期事项，保持节奏。'
                                : group.key === 'dueToday'
                                  ? '今天没有到期事项。'
                                  : '暂无其他事项。'}
                            </Typography.Text>
                          ) : (
                            group.data.map((i) => (
                              <ItemRow
                                key={i.id}
                                item={i}
                                danger={group.danger}
                                busy={updateMutation.isPending}
                                onDone={(item) => updateMutation.mutate({ id: item.id, body: { status: 'done' } })}
                                onDelete={(item) => deleteMutation.mutate(item)}
                                onEdit={(item) => openEditor(item)}
                              />
                            ))
                          )}
                        </Flex>
                      </div>
                    ))}
                  </Flex>
                )
              ) : itemsQuery.isLoading && actionItems.length === 0 ? (
                <Skeleton active paragraph={{ rows: 6 }} />
              ) : view === 'calendar' ? (
                <TaskCalendar
                  items={actionItems}
                  onDone={(item) => updateMutation.mutate({ id: item.id, body: { status: 'done' } })}
                  onDelete={(item) => deleteMutation.mutate(item)}
                  onEdit={(item) => openEditor(item)}
                />
              ) : (
                <TaskGantt
                  items={actionItems}
                  onDone={(item) => updateMutation.mutate({ id: item.id, body: { status: 'done' } })}
                  onDelete={(item) => deleteMutation.mutate(item)}
                  onEdit={(item) => openEditor(item)}
                />
              )}
                </>
              ),
            },
            {
              key: 'reading',
              label: (
                <Flex gap={6} align="center">
                  <BookOutlined /> 每日文献
                </Flex>
              ),
              children: <WorkbenchDailyReading />,
            },
            {
              key: 'records',
              label: (
                <Flex gap={6} align="center">
                  <ExperimentOutlined /> 实验记录
                </Flex>
              ),
              children: (
                <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
                  <ElnPanel />
                </Suspense>
              ),
            },
            {
              key: 'plans',
              label: (
                <Flex gap={6} align="center">
                  <FlagOutlined /> 计划与方向
                </Flex>
              ),
              children: (
                <>
                  <Flex justify="flex-end" style={{ marginBottom: 12 }}>
                    <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setPlanOpen(true)}>
                      新建计划
                    </Button>
                  </Flex>
              {loading ? (
                <Skeleton active paragraph={{ rows: 4 }} />
              ) : (
                <Flex vertical gap={16}>
                  <div>
                    <Typography.Text className="d509-section-title">长期方向</Typography.Text>
                    <Flex vertical gap={8} style={{ marginTop: 8 }}>
                      {directions.length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有长期方向" />
                      ) : (
                        directions.map((p) => (
                          <Flex
                            key={p.id}
                            gap={12}
                            align="center"
                            style={{
                              padding: '10px 12px',
                              borderRadius: 12,
                              border: '1px solid var(--ant-color-border-secondary, #EEF0F4)',
                            }}
                          >
                            <Flex vertical gap={4} style={{ flex: 1, minWidth: 0 }}>
                              <Flex gap={8} align="center" wrap>
                                <Typography.Text strong style={{ fontSize: 13.5 }}>
                                  {p.title}
                                </Typography.Text>
                                <Tag color={p.status === 'done' ? 'green' : 'blue'} style={{ margin: 0, fontSize: 11 }}>
                                  {statusCn(p.status)}
                                </Tag>
                                {p.horizon ? (
                                  <Tag style={{ margin: 0, fontSize: 11 }}>周期 {p.horizon}</Tag>
                                ) : null}
                              </Flex>
                              {p.outcome ? (
                                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                                  目标：{p.outcome}
                                </Typography.Text>
                              ) : null}
                              {p.next_step ? (
                                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                                  下一步：{p.next_step}
                                </Typography.Text>
                              ) : null}
                              {p.due_date ? (
                                <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                                  截止 {dayjs(p.due_date).format('YYYY-MM-DD')}
                                </Typography.Text>
                              ) : null}
                            </Flex>
                            <Progress
                              percent={planProgress(p)}
                              size={['30%', 8]}
                              strokeColor={['#2B5CE6', '#12A594']}
                              style={{ minWidth: 120 }}
                            />
                          </Flex>
                        ))
                      )}
                    </Flex>
                  </div>

                  <Divider style={{ margin: 0 }} />

                  <div>
                    <Typography.Text className="d509-section-title">阶段计划</Typography.Text>
                    <Flex vertical gap={8} style={{ marginTop: 8 }}>
                      {stages.length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有阶段计划" />
                      ) : (
                        stages.map((p) => (
                          <Flex
                            key={p.id}
                            gap={12}
                            align="center"
                            style={{
                              padding: '10px 12px',
                              borderRadius: 12,
                              border: '1px solid var(--ant-color-border-secondary, #EEF0F4)',
                            }}
                          >
                            <Flex vertical gap={4} style={{ flex: 1, minWidth: 0 }}>
                              <Flex gap={8} align="center" wrap>
                                <Typography.Text strong style={{ fontSize: 13.5 }}>
                                  {p.title}
                                </Typography.Text>
                                <Tag color={p.status === 'done' ? 'green' : 'cyan'} style={{ margin: 0, fontSize: 11 }}>
                                  {statusCn(p.status)}
                                </Tag>
                              </Flex>
                              {p.outcome ? (
                                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                                  目标：{p.outcome}
                                </Typography.Text>
                              ) : null}
                              {p.metrics ? (
                                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                                  指标：{p.metrics}
                                </Typography.Text>
                              ) : null}
                              {p.next_step ? (
                                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                                  下一步：{p.next_step}
                                </Typography.Text>
                              ) : null}
                            </Flex>
                            <Progress
                              percent={planProgress(p)}
                              size={['30%', 8]}
                              strokeColor="#12A594"
                              style={{ minWidth: 120 }}
                            />
                          </Flex>
                        ))
                      )}
                    </Flex>
                  </div>
                </Flex>
              )}
                </>
              ),
            },
            {
              key: 'projects',
              label: (
                <Flex gap={6} align="center">
                  <RocketOutlined /> 项目
                  <Tag style={{ margin: 0 }}>{projects.length}</Tag>
                </Flex>
              ),
              children: (
                <>
                  <Flex justify="flex-end" style={{ marginBottom: 12 }}>
                    <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setProjectOpen(true)}>
                      新建项目
                    </Button>
                  </Flex>
              {loading ? (
                <Skeleton active paragraph={{ rows: 3 }} />
              ) : projects.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无项目" />
              ) : (
                <Row gutter={[12, 12]}>
                  {projects.slice(0, 8).map((p) => {
                    const tasks = tasksByProject.get(p.id) ?? [];
                    const done = tasks.filter((t) => t.status === 'done').length;
                    const percent = tasks.length
                      ? Math.round((done / tasks.length) * 100)
                      : Math.max(0, Math.min(100, Number(p.progress ?? 0)));
                    return (
                      <Col xs={24} md={12} key={p.id}>
                        <Flex
                          vertical
                          gap={4}
                          style={{
                            padding: '10px 12px',
                            borderRadius: 12,
                            border: '1px solid var(--ant-color-border-secondary, #EEF0F4)',
                            height: '100%',
                          }}
                        >
                          <Flex gap={8} align="center" wrap>
                            <Typography.Text strong style={{ fontSize: 13.5 }}>
                              {p.name}
                            </Typography.Text>
                            <Tag color={HEALTH_COLOR[p.health || 'on_track']} style={{ margin: 0, fontSize: 11 }}>
                              {healthCn(p.health)}
                            </Tag>
                          </Flex>
                          {p.description ? (
                            <Typography.Paragraph
                              type="secondary"
                              style={{ margin: 0, fontSize: 12.5 }}
                              ellipsis={{ rows: 2 }}
                            >
                              {p.description}
                            </Typography.Paragraph>
                          ) : null}
                          {p.next_step ? (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              下一步：{p.next_step}
                            </Typography.Text>
                          ) : null}
                          <Flex justify="space-between" align="center" gap={6}>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {tasks.length ? `任务 ${done}/${tasks.length}` : '尚未安排任务'}
                            </Typography.Text>
                            <Button
                              size="small"
                              type="link"
                              icon={<PlusOutlined />}
                              onClick={() => {
                                setTaskProject(p);
                                taskForm.resetFields();
                              }}
                            >
                              安排任务
                            </Button>
                          </Flex>
                          <Progress
                            percent={percent}
                            size={['100%', 6]}
                            strokeColor={['#12A594', '#2B5CE6']}
                          />
                          {tasks.slice(0, 4).map((t) => (
                            <Flex key={t.id} gap={6} align="center">
                              <Checkbox
                                checked={t.status === 'done'}
                                onChange={(e) =>
                                  updateMutation.mutate({
                                    id: t.id,
                                    body: { status: e.target.checked ? 'done' : 'active' },
                                  })
                                }
                              />
                              <Typography.Text
                                delete={t.status === 'done'}
                                type={t.status === 'done' ? 'secondary' : undefined}
                                ellipsis
                                style={{ fontSize: 12, flex: 1 }}
                              >
                                {t.title}
                              </Typography.Text>
                              {t.due_date ? (
                                <Tag style={{ margin: 0, fontSize: 10 }}>{t.due_date}</Tag>
                              ) : null}
                            </Flex>
                          ))}
                          {tasks.length > 4 ? (
                            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                              还有 {tasks.length - 4} 项…
                            </Typography.Text>
                          ) : null}
                        </Flex>
                      </Col>
                    );
                  })}
                </Row>
              )}
                </>
              ),
            },
            {
              key: 'assignments',
              label: (
                <Flex gap={6} align="center">
                  <TeamOutlined /> 指派
                  {pendingAssignments ? (
                    <Tag color="gold" style={{ margin: 0 }}>
                      {pendingAssignments}
                    </Tag>
                  ) : null}
                </Flex>
              ),
              children: <WorkbenchAssignments />,
            },
            {
              key: 'growth',
              label: (
                <Flex gap={6} align="center">
                  <ExperimentOutlined /> 成长与知识
                  <Tag style={{ margin: 0 }}>{growthItems.length + knowledgeItems.length}</Tag>
                </Flex>
              ),
              children: (
                <>
              {loading ? (
                <Skeleton active paragraph={{ rows: 3 }} />
              ) : (
                <Tabs
                  size="small"
                  items={[
                    {
                      key: 'growth',
                      label: `成长 ${growthItems.length}`,
                      children:
                        growthItems.length === 0 ? (
                          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无成长记录" />
                        ) : (
                          <Flex vertical gap={8}>
                            {growthItems.slice(0, 8).map((i) => (
                              <ItemRow
                                key={i.id}
                                item={i}
                                busy={updateMutation.isPending}
                                onDone={(item) => updateMutation.mutate({ id: item.id, body: { status: 'done' } })}
                                onDelete={(item) => deleteMutation.mutate(item)}
                                onEdit={(item) => openEditor(item)}
                              />
                            ))}
                          </Flex>
                        ),
                    },
                    {
                      key: 'knowledge',
                      label: `知识 ${knowledgeItems.length}`,
                      children:
                        knowledgeItems.length === 0 ? (
                          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无知识沉淀" />
                        ) : (
                          <Flex vertical gap={8}>
                            {knowledgeItems.slice(0, 8).map((i) => (
                              <ItemRow
                                key={i.id}
                                item={i}
                                busy={updateMutation.isPending}
                                onDone={(item) => updateMutation.mutate({ id: item.id, body: { status: 'done' } })}
                                onDelete={(item) => deleteMutation.mutate(item)}
                                onEdit={(item) => openEditor(item)}
                              />
                            ))}
                          </Flex>
                        ),
                    },
                  ]}
                />
              )}
                </>
              ),
            },
            {
              key: 'brief',
              label: (
                <Flex gap={6} align="center">
                  <FileTextOutlined /> 简报与趋势
                </Flex>
              ),
              children: (
                <Row gutter={[16, 16]}>
                  <Col xs={24} lg={14}>
                    <Flex vertical gap={8}>
                      <Flex justify="space-between" align="center">
                        <Typography.Text strong>最近简报</Typography.Text>
                        {summary?.brief?.date ? (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {dayjs(summary.brief.date).format('YYYY-MM-DD')}
                          </Typography.Text>
                        ) : null}
                      </Flex>
                      {loading ? (
                        <Skeleton active paragraph={{ rows: 4 }} />
                      ) : summary?.brief?.content ? (
                        <pre
                          style={{
                            margin: 0,
                            padding: 14,
                            borderRadius: 12,
                            background: 'var(--ant-color-fill-quaternary, rgba(0,0,0,0.03))',
                            border: '1px solid var(--ant-color-border-secondary, #EEF0F4)',
                            fontSize: 12.5,
                            lineHeight: 1.7,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                          }}
                        >
                          {summary.brief.content}
                        </pre>
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="今天还没有简报" />
                      )}
                    </Flex>
                  </Col>
                  <Col xs={24} lg={10}>
                    <ErrorBoundary>
                      <Suspense fallback={<ChartFallback />}>
                        <LazyMount height={240}>
                          <TaskStatusDonut height={210} />
                        </LazyMount>
                      </Suspense>
                    </ErrorBoundary>
                  </Col>
                </Row>
              ),
            },
          ]}
        />
      </Card>

      {/* ------------------------------------------------ 检索结果（全局） */}
            {searchActive ? (
              <Panel
                color="#0EA5E9"
                title={
                  <Flex gap={8} align="center">
                    <ExperimentOutlined style={{ color: '#0EA5E9' }} />
                    检索结果
                  </Flex>
                }
                extra={
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    共 {searchTotal} 条
                  </Typography.Text>
                }
              >
                {searchQuery.isLoading ? (
                  <Skeleton active paragraph={{ rows: 3 }} />
                ) : searchQuery.error ? (
                  <Alert
                    type="error"
                    showIcon
                    variant="filled"
                    title="检索失败"
                    description={(searchQuery.error as Error).message}
                    action={
                      <Button size="small" type="primary" onClick={() => void searchQuery.refetch()}>
                        重试
                      </Button>
                    }
                  />
                ) : searchItems.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的条目" />
                ) : (
                  <Flex vertical gap={8}>
                    {searchItems.map((i) => (
                      <ItemRow
                        key={i.id}
                        item={i}
                        busy={updateMutation.isPending}
                        onDone={(item) => updateMutation.mutate({ id: item.id, body: { status: 'done' } })}
                        onDelete={(item) => deleteMutation.mutate(item)}
                      />
                    ))}
                  </Flex>
                )}
              </Panel>
            ) : null}


      {/* ------------------------------------------------ 新建 / 编辑事项 Modal */}
      <Modal
        open={!!editor}
        title={editor?.item ? '编辑事项' : '新建任务'}
        okText={editor?.item ? '保存' : '创建'}
        cancelText="取消"
        confirmLoading={saveItemMutation.isPending}
        onOk={() => itemForm.submit()}
        onCancel={() => {
          setEditor(null);
          itemForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form form={itemForm} layout="vertical" onFinish={submitItem} requiredMark={false}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="例如：整理本周实验数据" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="kind" label="类型">
                <Select
                  options={Object.entries(KIND_CN).map(([value, label]) => ({ value, label }))}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="priority" label="优先级">
                <Select
                  options={Object.entries(PRIORITY_CN).map(([value, label]) => ({ value, label }))}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="status" label="状态">
                <Select
                  options={[
                    { value: 'active', label: '进行中' },
                    { value: 'done', label: '已完成' },
                    { value: 'paused', label: '已暂停' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="due_date" label="截止日期">
                <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" allowClear />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="project_id" label="所属项目">
                <Select
                  allowClear
                  placeholder="可选"
                  options={projects.map((p) => ({ value: p.id, label: p.name }))}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" placeholder="输入后回车添加" tokenSeparators={[',', ' ']} />
          </Form.Item>
          <Form.Item name="content" label="说明">
            <Input.TextArea rows={3} placeholder="补充背景、验收标准或链接" />
          </Form.Item>
        </Form>
      </Modal>

      {/* ------------------------------------------------ 捕获确认 Modal */}
      <Modal
        open={!!capture}
        title="AI 捕获结果"
        onCancel={() => setCapture(null)}
        footer={null}
        width={560}
        destroyOnHidden
      >
        {capture ? (
          <Flex vertical gap={16}>
            <Form form={captureForm} layout="vertical" requiredMark={false}>
              <Form.Item
                name="title"
                label="标题"
                rules={[{ required: true, message: '请输入标题' }]}
              >
                <Input />
              </Form.Item>
              <Row gutter={12}>
                <Col span={8}>
                  <Form.Item name="kind" label="类型">
                    <Select
                      options={Object.entries(KIND_CN).map(([value, label]) => ({ value, label }))}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="priority" label="优先级">
                    <Select
                      options={Object.entries(PRIORITY_CN).map(([value, label]) => ({ value, label }))}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="due_date" label="截止日期">
                    <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" allowClear />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item name="tags" label="标签">
                <Select mode="tags" placeholder="输入后回车添加" tokenSeparators={[',', ' ']} />
              </Form.Item>
            </Form>
            <Descriptions
              column={1}
              size="small"
              items={[
                {
                  key: 'reason',
                  label: '判断依据',
                  children: (
                    <Typography.Text style={{ fontSize: 13 }}>{capture.ai_reason || '—'}</Typography.Text>
                  ),
                },
                {
                  key: 'confidence',
                  label: '置信度',
                  children: (
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      {Math.round(Number(capture.confidence ?? 0) * 100)}%
                    </Typography.Text>
                  ),
                },
              ]}
            />
            <Flex gap={8} justify="flex-end">
              <Button
                icon={<EditOutlined />}
                loading={discardCaptureMutation.isPending}
                onClick={() => discardCaptureMutation.mutate(capture.item.id)}
              >
                重新编辑
              </Button>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                loading={confirmCaptureMutation.isPending}
                style={{ background: GRADIENT, border: 'none' }}
                onClick={() => {
                  captureForm
                    .validateFields()
                    .then(() => confirmCaptureMutation.mutate(capture))
                    .catch(() => undefined);
                }}
              >
                确认写入
              </Button>
            </Flex>
          </Flex>
        ) : null}
      </Modal>

      {/* ------------------------------------------------ 新建计划 Modal */}
      <Modal
        open={planOpen}
        title="新建计划"
        okText="创建"
        cancelText="取消"
        confirmLoading={createPlanMutation.isPending}
        onOk={() => planForm.submit()}
        onCancel={() => {
          setPlanOpen(false);
          planForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form form={planForm} layout="vertical" onFinish={submitPlan} requiredMark={false}>
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, message: '请输入计划标题' }]}
          >
            <Input placeholder="例如：完成第一篇论文投稿" />
          </Form.Item>
          <Form.Item name="kind" label="类型" initialValue="direction">
            <Select
              options={[
                { value: 'direction', label: '长期方向' },
                { value: 'stage', label: '阶段计划' },
              ]}
            />
          </Form.Item>
          <Form.Item name="outcome" label="目标结果">
            <Input placeholder="达成什么算成功？" />
          </Form.Item>
          <Form.Item name="horizon" label="周期">
            <Input placeholder="例如：本季度 / 三周内" />
          </Form.Item>
          <Form.Item name="metrics" label="衡量指标">
            <Input placeholder="例如：完成 3 次实验" />
          </Form.Item>
          <Form.Item name="next_step" label="下一步">
            <Input placeholder="接下来具体做什么？" />
          </Form.Item>
          <Form.Item name="due_date" label="截止日期">
            <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" allowClear />
          </Form.Item>
        </Form>
      </Modal>

      {/* ------------------------------------------------ 新建项目 Modal */}
      <Modal
        open={projectOpen}
        title="新建项目"
        okText="创建"
        cancelText="取消"
        confirmLoading={createProjectMutation.isPending}
        onOk={() => projectForm.submit()}
        onCancel={() => {
          setProjectOpen(false);
          projectForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form form={projectForm} layout="vertical" onFinish={submitProject} requiredMark={false}>
          <Form.Item
            name="name"
            label="项目名称"
            rules={[{ required: true, message: '请输入项目名称' }]}
          >
            <Input placeholder="例如：玉米 bZIP 基因家族分析" />
          </Form.Item>
          <Form.Item name="health" label="健康度" initialValue="on_track">
            <Select
              options={Object.entries(HEALTH_CN).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
          <Form.Item name="status" label="状态" initialValue="active">
            <Select
              options={[
                { value: 'active', label: '进行中' },
                { value: 'paused', label: '已暂停' },
                { value: 'done', label: '已完成' },
              ]}
            />
          </Form.Item>
          <Form.Item name="next_step" label="下一步">
            <Input placeholder="接下来具体做什么？" />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={2} placeholder="项目背景、范围或数据来源" />
          </Form.Item>
          <Form.Item label="任务安排（可选）" extra="创建后任务会自动挂到该项目下，可在项目卡片里勾选完成。">
            <TaskFields />
          </Form.Item>
          <Form.Item name="due_date" label="截止日期">
            <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" allowClear />
          </Form.Item>
        </Form>
      </Modal>

      {/* ------------------------------------------------ 项目追加任务 Modal */}
      <Modal
        open={Boolean(taskProject)}
        title={`安排任务：${taskProject?.name || ''}`}
        okText="添加"
        cancelText="取消"
        width={640}
        confirmLoading={addTasksMutation.isPending}
        onOk={() => taskForm.submit()}
        onCancel={() => {
          setTaskProject(null);
          taskForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form
          form={taskForm}
          layout="vertical"
          requiredMark={false}
          onFinish={(v: { tasks?: TaskDraft[] }) =>
            taskProject ? addTasksMutation.mutate({ project: taskProject, tasks: v.tasks }) : undefined
          }
        >
          <Form.Item label="任务">
            <TaskFields />
          </Form.Item>
        </Form>
      </Modal>
    </Flex>
  );
}
