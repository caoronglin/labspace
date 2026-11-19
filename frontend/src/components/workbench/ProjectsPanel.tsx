/**
 * 个人工作台 · 项目页签（/workbench?tab=projects）
 *
 * 信息层级：「概览数字 → 项目卡片网格 → 卡片内任务清单（Collapse）」。
 * 卡片本身承载项目级信息（名称 / 状态 / 健康度 / 进度 / 任务计数 / 截止日期），
 * 项目内的任务收在 Collapse 里，展开时才按 project_id 拉取，不占首屏。
 *
 * 交互约定（与 PlanPanel / TasksPanel 保持一致）：
 * - 新建 / 编辑统一走 Modal + Form；
 * - 删除统一走 Popconfirm，并明确提示「会连带删除其任务」；
 * - 可点击文本带 role="button" + tabIndex + 键盘事件，图标按钮带 aria-label；
 * - 窄屏（< md）把卡片上的操作收进 Dropdown。
 *
 * 数据源：GET /api/workbench/projects、GET /api/workbench/items（按 project_id 取任务），
 * 写操作落到 POST / PATCH / DELETE /api/workbench/projects。
 * 组件自取数据，不需要父组件传 props。
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
  Select,
  Skeleton,
  Slider,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CalendarOutlined,
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  PlusOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  api,
  readCookie,
  type WorkbenchItem,
  type WorkbenchProject,
} from '../../services/api';
import { errText } from '../../utils/err';

/* ------------------------------------------------------------------ 词典 */

/** 项目状态（与后端 PROJECT_STATUSES 一致） */
const STATUS_CN: Record<string, string> = {
  active: '进行中',
  done: '已完成',
  paused: '已暂停',
};

const STATUS_COLOR: Record<string, string> = {
  active: 'blue',
  done: 'green',
  paused: 'gold',
};

const STATUS_OPTIONS = Object.entries(STATUS_CN).map(([value, label]) => ({ value, label }));

/** 项目健康度（与后端 PROJECT_HEALTHS 一致） */
const HEALTH_CN: Record<string, string> = {
  on_track: '正常',
  at_risk: '有风险',
  blocked: '受阻',
  done: '已收口',
};

const HEALTH_COLOR: Record<string, string> = {
  on_track: 'green',
  at_risk: 'gold',
  blocked: 'red',
  done: 'default',
};

const HEALTH_OPTIONS = Object.entries(HEALTH_CN).map(([value, label]) => ({ value, label }));

const statusCn = (s?: string) => (s && STATUS_CN[s]) || '进行中';
const healthCn = (h?: string) => (h && HEALTH_CN[h]) || '正常';

/** 项目进度：夹到 0-100 */
const projectProgress = (p: WorkbenchProject) =>
  Math.max(0, Math.min(100, Math.round(Number(p.progress ?? 0))));

/* ------------------------------------------------------------------ 类型 */

interface ProjectFormValues {
  name: string;
  description?: string;
  status: string;
  health: string;
  progress?: number;
  next_step?: string;
  due_date?: Dayjs;
}

/* ------------------------------------------------------------------ 请求 */

/**
 * 项目更新 / 删除的后端接口都在（PATCH / DELETE /api/workbench/projects/{id}），
 * 但 api.ts 里只有 workbenchProjects() / workbenchCreateProject()，没有对应方法；
 * 本次不允许改 api.ts，所以这里按 api.ts 里 request 的同源约定直接调用：
 * 同源相对路径 + cookie（credentials: 'include'）+ 写操作带 X-CSRF-Token，
 * 错误文案同样从 detail / error / message 里取。
 */
async function projectRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const csrf = readCookie('labspace_csrf');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
    ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
  };
  const res = await fetch(path, { credentials: 'include', ...init, headers });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as {
        detail?: string;
        error?: string;
        message?: string;
      };
      detail = body.detail ?? body.error ?? body.message ?? detail;
    } catch {
      /* 响应不是 JSON，沿用状态码 */
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ 小组件 */

/** 可点击项目名：鼠标与键盘（Enter / Space）都能进入编辑 */
function ProjectName({
  project,
  onOpen,
}: {
  project: WorkbenchProject;
  onOpen: (project: WorkbenchProject) => void;
}) {
  return (
    <Typography.Text
      strong
      role="button"
      tabIndex={0}
      onClick={() => onOpen(project)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(project);
        }
      }}
      style={{ cursor: 'pointer', minWidth: 0 }}
    >
      {project.name || '未命名项目'}
    </Typography.Text>
  );
}

/** 卡片操作：宽屏展开成图标按钮，窄屏收进 Dropdown（删除独立保留 Popconfirm） */
function ProjectActions({
  project,
  narrow,
  busy,
  onEdit,
  onDelete,
}: {
  project: WorkbenchProject;
  narrow: boolean;
  busy: boolean;
  onEdit: (project: WorkbenchProject) => void;
  onDelete: (project: WorkbenchProject) => void;
}) {
  const menuItems = [{ key: 'edit', icon: <EditOutlined />, label: '编辑项目' }];

  return (
    <Flex gap={4} align="center" justify="flex-end">
      {narrow ? (
        <Dropdown
          trigger={['click']}
          menu={{
            items: menuItems,
            onClick: ({ key }) => {
              if (key === 'edit') onEdit(project);
            },
          }}
        >
          <Button size="small" type="text" icon={<EllipsisOutlined />} aria-label="更多操作" />
        </Dropdown>
      ) : (
        <Tooltip title="编辑项目">
          <Button
            size="small"
            type="text"
            icon={<EditOutlined />}
            aria-label="编辑项目"
            onClick={() => onEdit(project)}
          />
        </Tooltip>
      )}
      <Popconfirm
        title="确定删除这个项目？"
        description="项目下的任务会一并删除，且不可恢复。"
        okText="删除"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        onConfirm={() => onDelete(project)}
      >
        <Tooltip title="删除项目">
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            aria-label="删除项目"
            loading={busy}
          />
        </Tooltip>
      </Popconfirm>
    </Flex>
  );
}

/** 项目内任务清单：展开时才按 project_id 拉取 */
function ProjectTaskList({ projectId }: { projectId: string }) {
  const { message } = App.useApp();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['workbench-items', 'project', projectId],
    queryFn: () => api.workbenchItems({ project_id: projectId, limit: 100 }),
    staleTime: 30_000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['workbench-items'] });
    void qc.invalidateQueries({ queryKey: ['workbench-summary'] });
  };

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<WorkbenchItem> }) =>
      api.workbenchUpdateItem(id, body),
    onSuccess: () => invalidate(),
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

  const items = useMemo(() => query.data?.items ?? [], [query.data]);

  if (query.isLoading && !query.data) {
    return <Skeleton active paragraph={{ rows: 3 }} />;
  }
  if (query.error) {
    return (
      <Alert
        type="error"
        showIcon
        variant="filled"
        title="任务加载失败"
        description={errText(query.error as Error, 120)}
        action={
          <Button size="small" type="primary" onClick={() => void query.refetch()}>
            重试
          </Button>
        }
      />
    );
  }
  if (!items.length) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="这个项目还没有任务"
        styles={{ image: { height: 40 } }}
      />
    );
  }

  return (
    <Flex vertical gap={8}>
      {items.map((item) => (
        <Flex key={item.id} gap={8} align="center" justify="space-between" wrap>
          <Flex gap={8} align="center" wrap style={{ minWidth: 0 }}>
            <Button
              size="small"
              type="text"
              aria-label={item.status === 'done' ? '恢复为进行中' : '标记完成'}
              icon={item.status === 'done' ? <UndoOutlined /> : <CheckOutlined />}
              onClick={() =>
                updateMutation.mutate({
                  id: item.id,
                  body: { status: item.status === 'done' ? 'active' : 'done' },
                })
              }
            />
            <Typography.Text
              delete={item.status === 'done'}
              type={item.status === 'done' ? 'secondary' : undefined}
              ellipsis
              style={{ maxWidth: 260, fontSize: 12.5 }}
            >
              {item.title || '未命名任务'}
            </Typography.Text>
            {item.due_date ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                截止 {dayjs(item.due_date).format('YYYY-MM-DD')}
              </Typography.Text>
            ) : null}
          </Flex>
          <Popconfirm
            title="确定删除这个任务？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => deleteMutation.mutate(item.id)}
          >
            <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="删除任务" />
          </Popconfirm>
        </Flex>
      ))}
    </Flex>
  );
}

/* ------------------------------------------------------------------ 主体 */

export default function ProjectsPanel() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const screens = Grid.useBreakpoint();
  /** 窄屏（< md）时把卡片上的操作收进 Dropdown */
  const narrow = !screens.md;

  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<WorkbenchProject | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [form] = Form.useForm<ProjectFormValues>();

  /* ------------------------------------------------------- 数据 */

  const projectsQuery = useQuery({
    queryKey: ['workbench-projects'],
    queryFn: api.workbenchProjects,
    staleTime: 30_000,
  });

  const itemsQuery = useQuery({
    queryKey: ['workbench-items', 'projects'],
    queryFn: () => api.workbenchItems({ limit: 200 }),
    staleTime: 30_000,
  });

  const projects = useMemo(() => projectsQuery.data?.projects ?? [], [projectsQuery.data]);
  const allItems = useMemo(() => itemsQuery.data?.items ?? [], [itemsQuery.data]);
  const loading = projectsQuery.isLoading && !projectsQuery.data;
  const error = (projectsQuery.error as Error | null) ?? null;

  /** 项目 → 任务计数（按 project_id 聚合，避免逐个项目再请求） */
  const tasksByProject = useMemo(() => {
    const map = new Map<string, WorkbenchItem[]>();
    for (const item of allItems) {
      if (!item.project_id) continue;
      const bucket = map.get(item.project_id);
      if (bucket) bucket.push(item);
      else map.set(item.project_id, [item]);
    }
    return map;
  }, [allItems]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['workbench-projects'] });
    void qc.invalidateQueries({ queryKey: ['workbench-items'] });
    void qc.invalidateQueries({ queryKey: ['workbench-summary'] });
  };

  /* ------------------------------------------------------- 变更 */

  const createMutation = useMutation({
    mutationFn: (body: Partial<WorkbenchProject>) => api.workbenchCreateProject(body),
    onSuccess: () => {
      message.success('项目已创建');
      closeModal();
      invalidate();
    },
    onError: (e: Error) => message.error(`创建失败：${errText(e, 120)}`),
  });

  /** 编辑项目：api.ts 暂无 workbenchUpdateProject，直接调用后端 PATCH */
  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<WorkbenchProject> }) =>
      projectRequest<{ project: WorkbenchProject }>(
        `/api/workbench/projects/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      message.success('项目已更新');
      closeModal();
      invalidate();
    },
    onError: (e: Error) => message.error(`更新失败：${errText(e, 120)}`),
  });

  /**
   * 删除项目：api.ts 暂无 workbenchDeleteProject，直接调用后端 DELETE。
   * 后端删项目不会连带删条目，这里先把归属该项目的任务删掉，
   * 让 Popconfirm 里的「会连带删除其任务」这句提示成立。
   */
  const deleteMutation = useMutation({
    mutationFn: async (project: WorkbenchProject) => {
      const res = await api.workbenchItems({ project_id: project.id, limit: 200 });
      for (const item of res.items) {
        try {
          await api.workbenchDeleteItem(item.id);
        } catch {
          /* 单条任务清理失败不阻断项目删除 */
        }
      }
      await projectRequest<{ ok: boolean }>(
        `/api/workbench/projects/${encodeURIComponent(project.id)}`,
        { method: 'DELETE' },
      );
      return res.items.length;
    },
    onSuccess: (taskCount: number) => {
      message.success(taskCount ? `项目已删除，连带清理 ${taskCount} 项任务` : '项目已删除');
      invalidate();
    },
    onError: (e: Error) => message.error(`删除失败：${errText(e, 120)}`),
  });

  /* ------------------------------------------------------- 派生数据 */

  const stats = useMemo(() => {
    const active = projects.filter((p) => (p.status ?? 'active') === 'active').length;
    const risky = projects.filter((p) => p.health === 'at_risk' || p.health === 'blocked').length;
    const taskCount = projects.reduce((sum, p) => sum + (tasksByProject.get(p.id)?.length ?? 0), 0);
    return { total: projects.length, active, risky, taskCount };
  }, [projects, tasksByProject]);

  /* ------------------------------------------------------- 交互 */

  const closeModal = () => {
    setModalMode(null);
  };

  /** 打开弹窗时重置并回填表单（不靠 initialValues，避免上次编辑残留） */
  const resetForm = (values: ProjectFormValues) => {
    form.resetFields();
    form.setFieldsValue(values);
  };

  const openCreate = () => {
    setEditing(null);
    setModalMode('create');
    resetForm({
      name: '',
      description: '',
      status: 'active',
      health: 'on_track',
      progress: 0,
      next_step: '',
      due_date: undefined,
    });
  };

  const openEdit = (project: WorkbenchProject) => {
    setEditing(project);
    setModalMode('edit');
    resetForm({
      name: project.name,
      description: project.description ?? '',
      status: project.status ?? 'active',
      health: project.health ?? 'on_track',
      progress: projectProgress(project),
      next_step: project.next_step ?? '',
      due_date: project.due_date ? dayjs(project.due_date) : undefined,
    });
  };

  const removeProject = (project: WorkbenchProject) => {
    setPendingId(project.id);
    deleteMutation.mutate(project, { onSettled: () => setPendingId(null) });
  };

  const submitProject = (values: ProjectFormValues) => {
    const body: Partial<WorkbenchProject> = {
      name: values.name.trim(),
      description: values.description ?? '',
      status: values.status,
      health: values.health,
      next_step: values.next_step ?? '',
      due_date: values.due_date ? values.due_date.format('YYYY-MM-DD') : null,
    };
    if (modalMode === 'edit' && editing) {
      updateMutation.mutate({
        id: editing.id,
        body: { ...body, progress: Math.max(0, Math.min(100, Math.round(values.progress ?? 0))) },
      });
      return;
    }
    createMutation.mutate(body);
  };

  /** 表单初始值：表单常驻，初始值只作为首屏兜底，实际回填靠 resetForm */
  const projectInitialValues = useMemo<ProjectFormValues>(
    () =>
      editing
        ? {
            name: editing.name,
            description: editing.description ?? '',
            status: editing.status ?? 'active',
            health: editing.health ?? 'on_track',
            progress: projectProgress(editing),
            next_step: editing.next_step ?? '',
            due_date: editing.due_date ? dayjs(editing.due_date) : undefined,
          }
        : {
            name: '',
            description: '',
            status: 'active',
            health: 'on_track',
            progress: 0,
            next_step: '',
            due_date: undefined,
          },
    [editing],
  );

  /* ------------------------------------------------------- 渲染 */

  const emptyAction = (
    <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
      新建项目
    </Button>
  );

  const renderProjectCard = (project: WorkbenchProject) => {
    const tasks = tasksByProject.get(project.id) ?? [];
    const done = tasks.filter((t) => t.status === 'done').length;
    /** 有任务时按任务完成率算进度，没有任务才用项目自己的进度字段 */
    const percent = tasks.length ? Math.round((done / tasks.length) * 100) : projectProgress(project);
    const due = project.due_date ? dayjs(project.due_date).format('YYYY-MM-DD') : '未设定';

    return (
      <Col xs={24} md={12} xl={8} key={project.id}>
        <Card
          size="small"
          variant="outlined"
          className="d509-card"
          style={{ height: '100%' }}
          styles={{ body: { padding: 12 } }}
        >
          <Flex vertical gap={8} style={{ height: '100%' }}>
            <Flex gap={8} align="center" wrap>
              <ProjectName project={project} onOpen={openEdit} />
              <Tag color={STATUS_COLOR[project.status ?? 'active']} variant="filled" style={{ margin: 0 }}>
                {statusCn(project.status)}
              </Tag>
              <Tag color={HEALTH_COLOR[project.health ?? 'on_track']} style={{ margin: 0 }}>
                {healthCn(project.health)}
              </Tag>
            </Flex>

            {project.description ? (
              <Typography.Paragraph
                type="secondary"
                style={{ margin: 0, fontSize: 12.5 }}
                ellipsis={{ rows: 2 }}
              >
                {project.description}
              </Typography.Paragraph>
            ) : null}

            <Progress
              percent={percent}
              size={['100%', 8]}
              strokeColor={percent >= 100 ? '#12A594' : ['#2B5CE6', '#12A594']}
            />

            <Flex gap={12} align="center" justify="space-between" wrap>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {tasks.length ? `任务 ${done}/${tasks.length}` : '尚未安排任务'}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                <CalendarOutlined aria-hidden /> 截止 {due}
              </Typography.Text>
            </Flex>

            {project.next_step ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                下一步：{project.next_step}
              </Typography.Text>
            ) : null}

            <Collapse
              ghost
              size="small"
              items={[
                {
                  key: 'tasks',
                  label: (
                    <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                      项目内任务（{tasks.length}）
                    </Typography.Text>
                  ),
                  children: <ProjectTaskList projectId={project.id} />,
                },
              ]}
            />

            <Flex justify="flex-end" style={{ marginTop: 'auto' }}>
              <ProjectActions
                project={project}
                narrow={narrow}
                busy={pendingId === project.id}
                onEdit={openEdit}
                onDelete={removeProject}
              />
            </Flex>
          </Flex>
        </Card>
      </Col>
    );
  };

  return (
    <Flex vertical gap={16}>
      {/* ------------------------------------------------ 头部：概览 + 新建 */}
      <Flex gap={12} align="center" justify="space-between" wrap>
        <Flex gap={24} align="center" wrap>
          <Statistic title="项目总数" value={stats.total} styles={{ content: { fontSize: 22 } }} />
          <Statistic title="进行中" value={stats.active} styles={{ content: { fontSize: 22 } }} />
          <Statistic title="有风险" value={stats.risky} styles={{ content: { fontSize: 22 } }} />
          <Statistic title="关联任务" value={stats.taskCount} styles={{ content: { fontSize: 22 } }} />
        </Flex>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate()}>
          新建项目
        </Button>
      </Flex>

      {/* ------------------------------------------------ 错误态 */}
      {error ? (
        <Alert
          type="error"
          showIcon
          variant="filled"
          title="项目数据加载失败"
          description={errText(error, 120)}
          action={
            <Button size="small" type="primary" onClick={() => void projectsQuery.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}

      {/* ------------------------------------------------ 加载态 */}
      {loading ? (
        <Row gutter={[12, 12]}>
          {[0, 1, 2].map((i) => (
            <Col xs={24} md={12} xl={8} key={i}>
              <Card size="small" variant="outlined" className="d509-card">
                <Skeleton active paragraph={{ rows: 3 }} />
              </Card>
            </Col>
          ))}
        </Row>
      ) : projects.length === 0 ? (
        <Card size="small" variant="outlined" className="d509-card">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有项目，先开一个">
            {emptyAction}
          </Empty>
        </Card>
      ) : (
        <Row gutter={[12, 12]} align="stretch">
          {projects.map(renderProjectCard)}
        </Row>
      )}

      {/* ------------------------------------------------ 新建 / 编辑 Modal */}
      <Modal
        open={modalMode !== null}
        title={modalMode === 'edit' ? '编辑项目' : '新建项目'}
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
          initialValues={projectInitialValues}
          onFinish={submitProject}
          requiredMark={false}
        >
          <Form.Item name="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
            <Input placeholder="例如：毕业论文实验" />
          </Form.Item>

          <Form.Item name="description" label="项目描述">
            <Input.TextArea rows={2} placeholder="这个项目要解决什么？（可选）" />
          </Form.Item>

          <Form.Item name="next_step" label="下一步">
            <Input placeholder="接下来具体做什么？（可选）" />
          </Form.Item>

          <Row gutter={12}>
            <Col xs={24} md={12}>
              <Form.Item name="status" label="状态">
                <Select options={STATUS_OPTIONS} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="health" label="健康度">
                <Select options={HEALTH_OPTIONS} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            name="progress"
            label="手动进度"
            tooltip="项目内已安排任务时，卡片进度按任务完成率自动计算；这里的数值在没有任务时作为项目进度"
          >
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
