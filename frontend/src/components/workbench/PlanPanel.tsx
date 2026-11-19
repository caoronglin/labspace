/**
 * 个人工作台 · 计划页签（/workbench?tab=plans）
 *
 * 信息层级按「当前阶段 → 关键里程碑 → 待办清单」三段式组织，
 * 层级全部由 Ant Design 原生组件（Card / Descriptions / Timeline / Steps /
 * Progress / Statistic / Collapse）表达，不堆裸 div。
 *
 * 交互约定：
 * - 新建 / 编辑统一走 Modal + Form，不手写受控 state 拼表单；
 * - 删除统一走 Popconfirm；
 * - 状态切换统一走 Select（列表内）或 Segmented（表单内）；
 * - 行内操作按钮统一「图标 + Tooltip」，危险操作加 danger。
 *
 * 数据源用 GET /api/workbench/plans（比工作台概览更全：包含已归档计划），
 * 写操作落到 POST / PATCH / DELETE /api/workbench/plans。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
  DatePicker,
  Descriptions,
  Dropdown,
  Empty,
  Flex,
  Form,
  Grid,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Segmented,
  Select,
  Skeleton,
  Slider,
  Statistic,
  Steps,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import {
  CalendarOutlined,
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  FlagOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  RocketOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { api, type WorkbenchPlan } from '../../services/api';
import { errText } from '../../utils/err';

/* ------------------------------------------------------------------ 词典 */

/** 计划状态（与后端 PLAN_STATUSES 一致） */
const STATUS_CN: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  done: '已完成',
  archived: '已归档',
};

const STATUS_COLOR: Record<string, string> = {
  active: 'blue',
  paused: 'gold',
  done: 'green',
  archived: 'default',
};

/** 计划类型（与后端 PLAN_KINDS 一致） */
const KIND_CN: Record<string, string> = {
  direction: '长期方向',
  stage: '阶段计划',
};

const STATUS_OPTIONS = Object.entries(STATUS_CN).map(([value, label]) => ({ value, label }));

const KIND_OPTIONS = [
  { value: 'direction', label: '长期方向' },
  { value: 'stage', label: '阶段计划' },
];

const statusCn = (s?: string) => (s && STATUS_CN[s]) || '未知';
const kindCn = (k?: string) => (k && KIND_CN[k]) || '计划';
const planProgress = (p: WorkbenchPlan) => Math.max(0, Math.min(100, Number(p.progress ?? 0)));

/* ------------------------------------------------------------------ 类型 */

export interface PlanFormValues {
  title: string;
  kind: 'direction' | 'stage';
  status: 'active' | 'paused' | 'done' | 'archived';
  outcome?: string;
  metrics?: string;
  horizon?: string;
  next_step?: string;
  progress?: number;
  due_date?: Dayjs;
}

export interface PlanPanelProps {
  /** 负责人显示名（计划按账号归属，即当前登录用户） */
  owner: string;
}

/* ------------------------------------------------------------------ 小组件 */

/** 状态标签：颜色由状态语义决定 */
function StatusTag({ status }: { status?: string }) {
  return (
    <Tag color={STATUS_COLOR[status || 'active']} variant="filled" style={{ margin: 0 }}>
      {statusCn(status)}
    </Tag>
  );
}

/** 时间区间：创建时间 → 截止日期；截止为空时显示「未设定」 */
function TimeRange({ plan }: { plan: WorkbenchPlan }) {
  const created = plan.created_at ? dayjs(plan.created_at).format('YYYY/MM/DD') : '未记录';
  const due = plan.due_date ? dayjs(plan.due_date).format('YYYY/MM/DD') : '未设定';
  return (
    <Tooltip title="创建时间是计划建档时间（不可编辑）；截止日期可在编辑里调整">
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>
        创建于 {created} → 截止 {due}
      </span>
    </Tooltip>
  );
}

/** 可点击标题：鼠标与键盘（Enter / Space）都能进入编辑 */
function PlanTitle({
  plan,
  onOpen,
  strong = true,
}: {
  plan: WorkbenchPlan;
  onOpen: (plan: WorkbenchPlan) => void;
  strong?: boolean;
}) {
  return (
    <Typography.Text
      strong={strong}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(plan)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(plan);
        }
      }}
      style={{ cursor: 'pointer', minWidth: 0 }}
    >
      {plan.title}
    </Typography.Text>
  );
}

/** 行内操作：宽屏展开成图标按钮，窄屏收进 Dropdown */
function PlanActions({
  plan,
  narrow,
  busy,
  onEdit,
  onStatus,
  onDelete,
}: {
  plan: WorkbenchPlan;
  narrow: boolean;
  busy: boolean;
  onEdit: (plan: WorkbenchPlan) => void;
  onStatus: (plan: WorkbenchPlan, status: string) => void;
  onDelete: (plan: WorkbenchPlan) => void;
}) {
  const menuItems = [
    { key: 'edit', icon: <EditOutlined />, label: '编辑计划' },
    {
      key: 'status',
      icon: <FlagOutlined />,
      label: '切换状态',
      children: STATUS_OPTIONS.map((o) => ({ key: `status:${o.value}`, label: o.label })),
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
              if (key === 'edit') onEdit(plan);
              if (key.startsWith('status:')) onStatus(plan, key.slice('status:'.length));
            },
          }}
        >
          <Button size="small" type="text" icon={<EllipsisOutlined />} aria-label="更多操作" />
        </Dropdown>
      ) : (
        <Tooltip title="编辑计划">
          <Button
            size="small"
            type="text"
            icon={<EditOutlined />}
            aria-label="编辑计划"
            onClick={() => onEdit(plan)}
          />
        </Tooltip>
      )}
      <Popconfirm
        title="确定删除这个计划？"
        description="删除后不可恢复，相关进度也会一并消失。"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onConfirm={() => onDelete(plan)}
      >
        <Tooltip title="删除计划">
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            aria-label="删除计划"
            loading={busy}
          />
        </Tooltip>
      </Popconfirm>
    </Flex>
  );
}

/* ------------------------------------------------------------------ 主体 */

export default function PlanPanel({ owner }: PlanPanelProps) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const screens = Grid.useBreakpoint();
  /** 窄屏（< md）时把次要操作收进 Dropdown */
  const narrow = !screens.md;

  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<WorkbenchPlan | null>(null);
  const [createKind, setCreateKind] = useState<'direction' | 'stage'>('direction');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [form] = Form.useForm<PlanFormValues>();

  /* ------------------------------------------------------- 数据 */

  const plansQuery = useQuery({
    queryKey: ['workbench-plans'],
    queryFn: api.workbenchPlans,
    staleTime: 30_000,
  });

  const plans = useMemo(() => plansQuery.data?.plans ?? [], [plansQuery.data]);
  const loading = plansQuery.isLoading && !plansQuery.data;
  const error = plansQuery.error as Error | null;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['workbench-plans'] });
    void qc.invalidateQueries({ queryKey: ['workbench-summary'] });
  };

  /* ------------------------------------------------------- 变更 */

  const createMutation = useMutation({
    mutationFn: (body: Partial<WorkbenchPlan>) => api.workbenchCreatePlan(body),
    onSuccess: () => {
      message.success('计划已创建');
      closeModal();
      invalidate();
    },
    onError: (e: Error) => message.error(`创建失败：${errText(e, 120)}`),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<WorkbenchPlan> }) =>
      api.workbenchUpdatePlan(id, body),
    onSuccess: () => {
      message.success('计划已更新');
      closeModal();
      invalidate();
    },
    onError: (e: Error) => message.error(`更新失败：${errText(e, 120)}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.workbenchDeletePlan(id),
    onSuccess: () => {
      message.success('计划已删除');
      invalidate();
    },
    onError: (e: Error) => message.error(`删除失败：${errText(e, 120)}`),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.workbenchUpdatePlan(id, { status }),
    onSuccess: () => {
      message.success('状态已更新');
      invalidate();
    },
    onError: (e: Error) => message.error(`状态更新失败：${errText(e, 120)}`),
  });

  /* ------------------------------------------------------- 派生数据 */

  const directions = useMemo(() => plans.filter((p) => p.kind !== 'stage'), [plans]);
  const stages = useMemo(() => plans.filter((p) => p.kind === 'stage'), [plans]);

  /** 排序权重：进行中 > 已暂停 > 已完成，同级按截止日期、再按进度 */
  const byUrgency = (a: WorkbenchPlan, b: WorkbenchPlan) => {
    const rank = (p: WorkbenchPlan) =>
      p.status === 'active' ? 0 : p.status === 'paused' ? 1 : p.status === 'done' ? 2 : 3;
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const ad = a.due_date ? dayjs(a.due_date).valueOf() : Number.POSITIVE_INFINITY;
    const bd = b.due_date ? dayjs(b.due_date).valueOf() : Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return planProgress(b) - planProgress(a);
  };

  /** 当前阶段：最需要推进的那一个（默认取阶段计划，退回长期方向） */
  const current = useMemo(() => {
    const pool = [...stages, ...directions].filter((p) => p.status !== 'archived');
    const sorted = [...pool].sort(byUrgency);
    return sorted[0] ?? null;
  }, [stages, directions]);

  /** 关键里程碑：阶段计划按截止日期排成时间线 */
  const milestones = useMemo(
    () =>
      [...stages].sort((a, b) => {
        const ad = a.due_date ? dayjs(a.due_date).valueOf() : Number.POSITIVE_INFINITY;
        const bd = b.due_date ? dayjs(b.due_date).valueOf() : Number.POSITIVE_INFINITY;
        if (ad !== bd) return ad - bd;
        return planProgress(b) - planProgress(a);
      }),
    [stages],
  );

  /** 待办清单：还没收口的计划（进行中 / 已暂停），按截止日期排 */
  const todos = useMemo(
    () => plans.filter((p) => p.status === 'active' || p.status === 'paused').sort(byUrgency),
    [plans],
  );

  const stats = useMemo(() => {
    const active = plans.filter((p) => p.status === 'active').length;
    const done = plans.filter((p) => p.status === 'done').length;
    const avg = plans.length
      ? Math.round(plans.reduce((sum, p) => sum + planProgress(p), 0) / plans.length)
      : 0;
    return { total: plans.length, active, done, milestones: stages.length, avg };
  }, [plans, stages]);

  /* ------------------------------------------------------- 交互 */

  const closeModal = () => {
    setModalMode(null);
  };

  /** 打开弹窗时重置并回填表单（不靠 initialValues，避免上次编辑残留） */
  const resetForm = (values: PlanFormValues) => {
    form.resetFields();
    form.setFieldsValue(values);
  };

  const openCreate = (kind: 'direction' | 'stage' = 'direction') => {
    setCreateKind(kind);
    setEditing(null);
    setModalMode('create');
    resetForm({
      title: '',
      kind,
      status: 'active',
      outcome: '',
      metrics: '',
      horizon: '',
      next_step: '',
      progress: 0,
      due_date: undefined,
    });
  };

  const openEdit = (plan: WorkbenchPlan) => {
    setEditing(plan);
    setModalMode('edit');
    resetForm({
      title: plan.title,
      kind: plan.kind === 'stage' ? 'stage' : 'direction',
      status: (plan.status ?? 'active') as PlanFormValues['status'],
      outcome: plan.outcome ?? '',
      metrics: plan.metrics ?? '',
      horizon: plan.horizon ?? '',
      next_step: plan.next_step ?? '',
      progress: planProgress(plan),
      due_date: plan.due_date ? dayjs(plan.due_date) : undefined,
    });
  };

  /** 表单初始值：表单常驻，初始值只作为首屏兜底，实际回填靠 resetForm */
  const planInitialValues = useMemo<PlanFormValues>(
    () =>
      editing
        ? {
            title: editing.title,
            kind: editing.kind === 'stage' ? 'stage' : 'direction',
            status: (editing.status ?? 'active') as PlanFormValues['status'],
            outcome: editing.outcome ?? '',
            metrics: editing.metrics ?? '',
            horizon: editing.horizon ?? '',
            next_step: editing.next_step ?? '',
            progress: planProgress(editing),
            due_date: editing.due_date ? dayjs(editing.due_date) : undefined,
          }
        : {
            title: '',
            kind: createKind,
            status: 'active',
            outcome: '',
            metrics: '',
            horizon: '',
            next_step: '',
            progress: 0,
            due_date: undefined,
          },
    [editing, createKind],
  );

  const submitPlan = (values: PlanFormValues) => {
    const body: Partial<WorkbenchPlan> = {
      kind: values.kind,
      status: values.status,
      title: values.title.trim(),
      outcome: values.outcome ?? '',
      metrics: values.metrics ?? '',
      horizon: values.horizon ?? '',
      next_step: values.next_step ?? '',
      progress: Math.max(0, Math.min(100, Math.round(values.progress ?? 0))),
      due_date: values.due_date ? values.due_date.format('YYYY-MM-DD') : null,
    };
    if (modalMode === 'edit' && editing) {
      updateMutation.mutate({ id: editing.id, body });
      return;
    }
    createMutation.mutate(body);
  };

  const changeStatus = (plan: WorkbenchPlan, status: string) => {
    if (status === plan.status) return;
    setPendingId(plan.id);
    statusMutation.mutate(
      { id: plan.id, status },
      { onSettled: () => setPendingId(null) },
    );
  };

  const removePlan = (plan: WorkbenchPlan) => {
    setPendingId(plan.id);
    deleteMutation.mutate(plan.id, { onSettled: () => setPendingId(null) });
  };

  /* ------------------------------------------------------- 渲染 */

  const emptyAction = (
    <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
      新建计划
    </Button>
  );

  const renderCurrent = () => {
    if (!current) {
      return (
        <Card size="small" title="当前阶段" variant="outlined" className="d509-card">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有计划，先定一个方向" >
            {emptyAction}
          </Empty>
        </Card>
      );
    }
    return (
      <Card
        size="small"
        title="当前阶段"
        variant="outlined"
        className="d509-card"
        extra={
          <Tag variant="filled" style={{ margin: 0 }}>
            {kindCn(current.kind)}
          </Tag>
        }
      >
        <Flex vertical gap={12}>
          <Flex gap={8} align="center" wrap>
            <PlanTitle plan={current} onOpen={openEdit} />
            <StatusTag status={current.status} />
          </Flex>

          <Progress
            percent={planProgress(current)}
            size={['100%', 10]}
            strokeColor={{ '0%': '#2B5CE6', '100%': '#12A594' }}
          />

          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2, lg: 3 }}
            items={[
              {
                key: 'owner',
                label: (
                  <Tooltip title="计划按账号归属，这里的负责人就是当前登录用户">
                    <span>
                      负责人 <QuestionCircleOutlined style={{ fontSize: 11, opacity: 0.6 }} />
                    </span>
                  </Tooltip>
                ),
                children: owner,
              },
              {
                key: 'created',
                label: (
                  <Tooltip title="创建时间是计划建档时间，不是可编辑的开始日期">
                    <span>
                      创建时间 <QuestionCircleOutlined style={{ fontSize: 11, opacity: 0.6 }} />
                    </span>
                  </Tooltip>
                ),
                children: current.created_at
                  ? dayjs(current.created_at).format('YYYY-MM-DD HH:mm')
                  : '未记录',
              },
              {
                key: 'due',
                label: '截止日期',
                children: current.due_date ? dayjs(current.due_date).format('YYYY-MM-DD') : '未设定',
              },
              {
                key: 'horizon',
                label: '周期',
                children: current.horizon || '未设定',
              },
              {
                key: 'outcome',
                label: '目标结果',
                children: current.outcome ? (
                  <Tooltip title={current.outcome}>
                    <Typography.Text ellipsis style={{ maxWidth: 220 }}>
                      {current.outcome}
                    </Typography.Text>
                  </Tooltip>
                ) : (
                  '未填写'
                ),
              },
              {
                key: 'metrics',
                label: '衡量指标',
                children: current.metrics ? (
                  <Tooltip title={current.metrics}>
                    <Typography.Text ellipsis style={{ maxWidth: 220 }}>
                      {current.metrics}
                    </Typography.Text>
                  </Tooltip>
                ) : (
                  '未填写'
                ),
              },
            ]}
          />

          <Flex
            gap={8}
            align="flex-start"
            style={{
              padding: '10px 12px',
              borderRadius: 12,
              background: 'var(--ant-color-fill-quaternary, rgba(20,26,34,0.04))',
            }}
          >
            <RocketOutlined style={{ color: '#2B5CE6', marginTop: 2 }} />
            <Flex vertical gap={2} style={{ minWidth: 0 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                下一步
              </Typography.Text>
              {current.next_step ? (
                <Tooltip title={current.next_step}>
                  <Typography.Paragraph
                    style={{ margin: 0, fontSize: 13 }}
                    ellipsis={{ rows: 2 }}
                  >
                    {current.next_step}
                  </Typography.Paragraph>
                </Tooltip>
              ) : (
                <Typography.Text style={{ fontSize: 13 }}>未填写下一步</Typography.Text>
              )}
            </Flex>
          </Flex>

          <Flex justify="space-between" align="center" gap={8} wrap>
            {narrow ? null : (
              <Select
                size="small"
                value={current.status ?? 'active'}
                options={STATUS_OPTIONS}
                aria-label="切换当前计划状态"
                style={{ width: 112 }}
                loading={pendingId === current.id}
                onChange={(v) => changeStatus(current, v)}
              />
            )}
            <PlanActions
              plan={current}
              narrow={narrow}
              busy={pendingId === current.id}
              onEdit={openEdit}
              onStatus={changeStatus}
              onDelete={removePlan}
            />
          </Flex>
        </Flex>
      </Card>
    );
  };

  const renderMilestones = () => {
    if (milestones.length === 0) {
      return (
        <Card size="small" title="关键里程碑" variant="outlined" className="d509-card">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有阶段计划"
            styles={{ image: { height: 48 } }}
          >
            <Button icon={<PlusOutlined />} onClick={() => openCreate('stage')}>
              新建阶段计划
            </Button>
          </Empty>
        </Card>
      );
    }
    const currentIndex = milestones.findIndex((p) => p.status !== 'done');
    return (
      <Card
        size="small"
        title="关键里程碑"
        variant="outlined"
        className="d509-card"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {milestones.length} 个
          </Typography.Text>
        }
      >
        <Flex vertical gap={14}>
          {milestones.length > 1 ? (
            <Steps
              size="small"
              current={currentIndex < 0 ? milestones.length - 1 : currentIndex}
              items={milestones.map((p) => ({
                title: p.title,
                description: p.due_date ? dayjs(p.due_date).format('YYYY-MM-DD') : '未设定截止',
                status: p.status === 'done' ? 'finish' : undefined,
              }))}
            />
          ) : null}
          <Timeline
            items={milestones.map((p) => ({
              key: p.id,
              color:
                p.status === 'done'
                  ? '#12A594'
                  : p.status === 'paused'
                    ? '#D97706'
                    : p.status === 'archived'
                      ? 'var(--ant-color-border, #E6E9EF)'
                      : '#2B5CE6',
              children: (
                <Flex vertical gap={4} style={{ minWidth: 0 }}>
                  <Flex gap={8} align="center" wrap>
                    <PlanTitle plan={p} onOpen={openEdit} strong={false} />
                    <StatusTag status={p.status} />
                  </Flex>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    <TimeRange plan={p} /> · 负责人 {owner}
                  </Typography.Text>
                  {p.next_step ? (
                    <Tooltip title={p.next_step}>
                      <Typography.Paragraph
                        type="secondary"
                        style={{ margin: 0, fontSize: 12.5 }}
                        ellipsis={{ rows: 1 }}
                      >
                        下一步：{p.next_step}
                      </Typography.Paragraph>
                    </Tooltip>
                  ) : null}
                  <Progress percent={planProgress(p)} size={['100%', 6]} />
                </Flex>
              ),
            }))}
          />
        </Flex>
      </Card>
    );
  };

  const renderTodos = () => {
    if (todos.length === 0) {
      return (
        <Card
          size="small"
          title="待办清单"
          variant="outlined"
          className="d509-card"
          extra={
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
              新建计划
            </Button>
          }
        >
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待推进的计划">
            {emptyAction}
          </Empty>
        </Card>
      );
    }
    return (
      <Card
        size="small"
        title="待办清单"
        variant="outlined"
        className="d509-card"
        extra={
          <Flex gap={8} align="center">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {todos.length} 项待推进
            </Typography.Text>
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
              新建计划
            </Button>
          </Flex>
        }
      >
        <Row gutter={[12, 12]}>
          {todos.map((p) => (
            <Col xs={24} md={12} xl={8} key={p.id}>
              <Card
                size="small"
                variant="outlined"
                styles={{ body: { padding: 12 } }}
                style={{ height: '100%' }}
              >
                <Flex vertical gap={8} style={{ height: '100%' }}>
                  <Flex gap={8} align="center" wrap>
                    <PlanTitle plan={p} onOpen={openEdit} />
                    <StatusTag status={p.status} />
                    <Tag variant="filled" style={{ margin: 0 }}>
                      {kindCn(p.kind)}
                    </Tag>
                  </Flex>

                  <Flex gap={12} align="center" wrap style={{ fontSize: 12 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      <CalendarOutlined /> <TimeRange plan={p} />
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      <TeamOutlined /> {owner}
                    </Typography.Text>
                  </Flex>

                  <Progress percent={planProgress(p)} size={['100%', 6]} />

                  <Collapse
                    ghost
                    size="small"
                    items={[
                      {
                        key: 'detail',
                        label: (
                          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                            详情与关联
                          </Typography.Text>
                        ),
                        children: (
                          <Descriptions
                            size="small"
                            column={1}
                            items={[
                              {
                                key: 'outcome',
                                label: '目标',
                                children: p.outcome ? (
                                  <Tooltip title={p.outcome}>
                                    <Typography.Text ellipsis style={{ maxWidth: 240 }}>
                                      {p.outcome}
                                    </Typography.Text>
                                  </Tooltip>
                                ) : (
                                  '—'
                                ),
                              },
                              {
                                key: 'metrics',
                                label: '指标',
                                children: p.metrics ? (
                                  <Tooltip title={p.metrics}>
                                    <Typography.Text ellipsis style={{ maxWidth: 240 }}>
                                      {p.metrics}
                                    </Typography.Text>
                                  </Tooltip>
                                ) : (
                                  '—'
                                ),
                              },
                              {
                                key: 'next',
                                label: '下一步',
                                children: p.next_step ? (
                                  <Tooltip title={p.next_step}>
                                    <Typography.Text ellipsis style={{ maxWidth: 240 }}>
                                      {p.next_step}
                                    </Typography.Text>
                                  </Tooltip>
                                ) : (
                                  '—'
                                ),
                              },
                              {
                                key: 'horizon',
                                label: '周期',
                                children: p.horizon || '—',
                              },
                            ]}
                          />
                        ),
                      },
                    ]}
                  />

                  <Flex justify="space-between" align="center" gap={8} style={{ marginTop: 'auto' }}>
                    {narrow ? null : (
                      <Select
                        size="small"
                        value={p.status ?? 'active'}
                        options={STATUS_OPTIONS}
                        aria-label="切换计划状态"
                        style={{ width: 108 }}
                        loading={pendingId === p.id}
                        onChange={(v) => changeStatus(p, v)}
                      />
                    )}
                    <PlanActions
                      plan={p}
                      narrow={narrow}
                      busy={pendingId === p.id}
                      onEdit={openEdit}
                      onStatus={changeStatus}
                      onDelete={removePlan}
                    />
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
      {/* ------------------------------------------------ 头部：概览 + 新建 */}
      <Flex gap={12} align="center" justify="space-between" wrap>
        <Flex gap={24} align="center" wrap>
          <Statistic title="计划总数" value={stats.total} styles={{ content: { fontSize: 22 } }} />
          <Statistic title="进行中" value={stats.active} styles={{ content: { fontSize: 22 } }} />
          <Statistic title="里程碑" value={stats.milestones} styles={{ content: { fontSize: 22 } }} />
          <Statistic
            title="平均进度"
            value={stats.avg}
            suffix="%"
            styles={{ content: { fontSize: 22 } }}
          />
        </Flex>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
          新建计划
        </Button>
      </Flex>

      {/* ------------------------------------------------ 错误态 */}
      {error ? (
        <Alert
          type="error"
          showIcon
          variant="filled"
          title="计划数据加载失败"
          description={errText(error, 120)}
          action={
            <Button size="small" type="primary" onClick={() => void plansQuery.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}

      {/* ------------------------------------------------ 加载态 */}
      {loading ? (
        <Card size="small" variant="outlined" className="d509-card">
          <Skeleton active paragraph={{ rows: 4 }} />
        </Card>
      ) : (
        <>
          {/* -------------------------------------------- 第一段：当前阶段 + 关键里程碑 */}
          <Row gutter={[16, 16]} align="stretch">
            <Col xs={24} xl={14}>
              {renderCurrent()}
            </Col>
            <Col xs={24} xl={10}>
              {renderMilestones()}
            </Col>
          </Row>

          {/* -------------------------------------------- 第二段：待办清单 */}
          {renderTodos()}
        </>
      )}

      {/* ------------------------------------------------ 新建 / 编辑 Modal */}
      <Modal
        open={modalMode !== null}
        title={modalMode === 'edit' ? '编辑计划' : '新建计划'}
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
          initialValues={planInitialValues}
          onFinish={submitPlan}
          requiredMark={false}
        >
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, message: '请输入计划标题' }]}
          >
            <Input placeholder="例如：完成第一篇论文投稿" />
          </Form.Item>

          <Row gutter={12}>
            <Col xs={24} md={12}>
              <Form.Item name="kind" label="类型">
                <Segmented options={KIND_OPTIONS} block />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="status" label="状态">
                <Segmented options={STATUS_OPTIONS} block />
              </Form.Item>
            </Col>
          </Row>

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

          <Form.Item name="progress" label="进度" tooltip="0-100，用于里程碑推进度">
            <Slider min={0} max={100} marks={{ 0: '0', 50: '50', 100: '100' }} />
          </Form.Item>

          <Form.Item name="due_date" label="截止日期">
            <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" allowClear />
          </Form.Item>
        </Form>
      </Modal>
    </Flex>
  );
}
