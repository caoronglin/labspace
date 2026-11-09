import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Skeleton,
  Tag,
  Typography,
  Upload,
} from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  DownloadOutlined,
  PaperClipOutlined,
  PlusOutlined,
  SendOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import {
  api,
  type AssignmentFile,
  type AssignmentPerson,
  type WorkbenchAssignment,
} from '../services/api';
import { useAuth } from '../app/AuthContext';
import MarkdownView from './MarkdownView';
import { errText } from '../utils/err';

dayjs.locale('zh-cn');

/* ------------------------------------------------------------------ 词典 */

const STATUS_META: Record<string, { label: string; color: string; icon: ReactNode }> = {
  assigned: { label: '待开始', color: 'default', icon: <ClockCircleOutlined /> },
  in_progress: { label: '进行中', color: 'processing', icon: <ClockCircleOutlined /> },
  submitted: { label: '待批阅', color: 'gold', icon: <SendOutlined /> },
  accepted: { label: '已通过', color: 'success', icon: <CheckCircleOutlined /> },
  returned: { label: '已退回', color: 'error', icon: <CloseCircleOutlined /> },
};

const PRIORITY_META: Record<string, { label: string; color: string }> = {
  low: { label: '低优先', color: 'default' },
  normal: { label: '普通', color: 'blue' },
  high: { label: '高优先', color: 'red' },
};

const KIND_CN: Record<string, string> = { task: '任务', project: '课题' };

/* --------------------------------------------------------------- Markdown 编辑器 */

function MarkdownEditor({
  value = '',
  onChange,
  rows = 8,
  placeholder,
}: {
  value?: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');

  const wrap = (before: string, after: string, fallback: string) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end) || fallback;
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };

  return (
    <Flex vertical gap={8}>
      <Flex gap={6} align="center" wrap>
        <Segmented
          size="small"
          value={mode}
          onChange={(v) => setMode(v as 'edit' | 'preview')}
          options={[
            { label: '编辑', value: 'edit' },
            { label: '预览', value: 'preview' },
          ]}
        />
        {mode === 'edit' ? (
          <>
            <Button size="small" onClick={() => wrap('## ', '', '小标题')}>
              标题
            </Button>
            <Button size="small" onClick={() => wrap('**', '**', '粗体')}>
              粗体
            </Button>
            <Button size="small" onClick={() => wrap('`', '`', '代码')}>
              代码
            </Button>
            <Button size="small" onClick={() => wrap('- ', '', '列表项')}>
              列表
            </Button>
            <Button size="small" onClick={() => wrap('\n```\n', '\n```\n', '代码块')}>
              代码块
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
              支持 Markdown
            </Typography.Text>
          </>
        ) : null}
      </Flex>
      {mode === 'edit' ? (
        <textarea
          ref={ref}
          value={value}
          rows={rows}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: '100%',
            padding: '10px 12px',
            borderRadius: 10,
            border: '1px solid var(--ant-color-border, #D9D9D9)',
            background: 'var(--ant-color-bg-container, #fff)',
            color: 'inherit',
            fontSize: 13,
            lineHeight: 1.7,
            fontFamily: 'inherit',
            resize: 'vertical',
            outline: 'none',
          }}
        />
      ) : (
        <div
          style={{
            minHeight: rows * 22,
            padding: '10px 12px',
            borderRadius: 10,
            border: '1px dashed var(--ant-color-border-secondary, #EEF0F4)',
            background: 'var(--ant-color-fill-quaternary, rgba(0,0,0,0.02))',
          }}
        >
          {value.trim() ? <MarkdownView source={value} /> : <Typography.Text type="secondary">暂无内容</Typography.Text>}
        </div>
      )}
    </Flex>
  );
}

/* ------------------------------------------------------------------ 附件选择 */

function FileStager({
  files,
  onChange,
  hint,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  hint?: string;
}) {
  const { message } = App.useApp();
  return (
    <Flex vertical gap={8}>
      <Flex gap={8} align="center" wrap>
        <Upload
          multiple
          showUploadList={false}
          beforeUpload={(f) => {
            if (f.size > 20 * 1024 * 1024) {
              message.warning('单个附件不能超过 20 MB');
              return false;
            }
            if (files.length >= 12) {
              message.warning('每位成员最多 12 个附件');
              return false;
            }
            onChange([...files, f]);
            return false;
          }}
        >
          <Button size="small" icon={<PaperClipOutlined />}>
            添加附件
          </Button>
        </Upload>
        <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
          {hint || '单个 ≤ 20 MB，最多 12 个'}
        </Typography.Text>
      </Flex>
      {files.length ? (
        <Flex gap={6} wrap>
          {files.map((f, idx) => (
            <Tag
              key={`${f.name}-${idx}`}
              closable
              onClose={(e) => {
                e.preventDefault();
                onChange(files.filter((_, i) => i !== idx));
              }}
              style={{ margin: 0, maxWidth: '100%' }}
            >
              {f.name}
            </Tag>
          ))}
        </Flex>
      ) : null}
    </Flex>
  );
}

/* ------------------------------------------------------------------ 附件列表 */

function FileList({
  files,
  canDelete,
  onDelete,
}: {
  files: AssignmentFile[];
  canDelete?: (f: AssignmentFile) => boolean;
  onDelete?: (f: AssignmentFile) => void;
}) {
  if (!files.length) return null;
  return (
    <Flex vertical gap={4}>
      {files.map((f) => (
        <Flex key={f.id} gap={6} align="center" wrap>
          <PaperClipOutlined style={{ color: '#64748B' }} />
          <Typography.Link href={f.url} style={{ fontSize: 12.5 }}>
            {f.filename}
          </Typography.Link>
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
            {formatBytes(f.size ?? 0)} · {f.created_at ? dayjs(f.created_at).format('MM-DD HH:mm') : ''}
          </Typography.Text>
          <Button
            size="small"
            type="text"
            icon={<DownloadOutlined />}
            href={f.url}
            style={{ paddingInline: 4 }}
          />
          {canDelete?.(f) ? (
            <Popconfirm title="删除这个附件？" onConfirm={() => onDelete?.(f)}>
              <Button size="small" type="text" danger icon={<DeleteOutlined />} style={{ paddingInline: 4 }} />
            </Popconfirm>
          ) : null}
        </Flex>
      ))}
    </Flex>
  );
}

function formatBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ 卡片 */

function AssignmentCard({
  a,
  mode,
  onOpen,
}: {
  a: WorkbenchAssignment;
  mode: 'incoming' | 'outgoing';
  onOpen: (a: WorkbenchAssignment) => void;
}) {
  const st = STATUS_META[a.status] || STATUS_META.assigned;
  const pr = PRIORITY_META[a.priority] || PRIORITY_META.normal;
  const overdue =
    a.due_date && a.status !== 'accepted' && dayjs(a.due_date).endOf('day').isBefore(dayjs());
  return (
    <Card
      size="small"
      hoverable
      onClick={() => onOpen(a)}
      style={{
        borderRadius: 12,
        borderColor: a.status === 'submitted' ? '#F59E0B' : undefined,
        cursor: 'pointer',
      }}
      styles={{ body: { padding: '10px 12px' } }}
    >
      <Flex vertical gap={6}>
        <Flex gap={6} align="center" wrap>
          <Tag color={a.kind === 'project' ? 'purple' : 'blue'} style={{ margin: 0, fontSize: 11 }}>
            {KIND_CN[a.kind] || a.kind}
          </Tag>
          <Tag color={st.color} icon={st.icon} style={{ margin: 0, fontSize: 11 }}>
            {st.label}
          </Tag>
          {a.priority !== 'normal' ? (
            <Tag color={pr.color} style={{ margin: 0, fontSize: 11 }}>
              {pr.label}
            </Tag>
          ) : null}
        </Flex>
        <Typography.Text strong style={{ fontSize: 13.5 }} ellipsis={{ tooltip: a.title }}>
          {a.title}
        </Typography.Text>
        <Flex gap={8} align="center" wrap>
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
            {mode === 'incoming' ? `来自 ${a.creator_name || '导师'}` : `指派给 ${a.assignee_name || '成员'}`}
          </Typography.Text>
          {a.due_date ? (
            <Typography.Text type={overdue ? 'danger' : 'secondary'} style={{ fontSize: 11.5 }}>
              截止 {dayjs(a.due_date).format('MM-DD')}
              {overdue ? ' · 已逾期' : ''}
            </Typography.Text>
          ) : null}
        </Flex>
        {a.submissions.length ? (
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
            已有 {a.submissions.length} 次提交
          </Typography.Text>
        ) : null}
      </Flex>
    </Card>
  );
}

/* ------------------------------------------------------------------ 看板 */

const BOARD_COLUMNS = ['assigned', 'in_progress', 'submitted', 'accepted', 'returned'];

function AssignmentBoard({
  items,
  mode,
  onOpen,
}: {
  items: WorkbenchAssignment[];
  mode: 'incoming' | 'outgoing';
  onOpen: (a: WorkbenchAssignment) => void;
}) {
  if (!items.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={mode === 'incoming' ? '还没有收到指派' : '还没有发出指派'} />;
  }
  return (
    <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 4 }}>
      {BOARD_COLUMNS.map((status) => {
        const list = items.filter((i) => i.status === status);
        const meta = STATUS_META[status];
        return (
          <div key={status} style={{ minWidth: 236, flex: '1 0 236px' }}>
            <Flex gap={6} align="center" style={{ marginBottom: 8, paddingInline: 2 }}>
              <Tag color={meta.color} icon={meta.icon} style={{ margin: 0 }}>
                {meta.label}
              </Tag>
              <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                {list.length}
              </Typography.Text>
            </Flex>
            <Flex vertical gap={8}>
              {list.map((a) => (
                <AssignmentCard key={a.id} a={a} mode={mode} onOpen={onOpen} />
              ))}
              {!list.length ? (
                <div
                  style={{
                    border: '1px dashed var(--ant-color-border-secondary, #EEF0F4)',
                    borderRadius: 10,
                    padding: '18px 8px',
                    textAlign: 'center',
                  }}
                >
                  <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                    暂无
                  </Typography.Text>
                </div>
              ) : null}
            </Flex>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ 主组件 */

export default function WorkbenchAssignments() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { me } = useAuth();
  const canDispatch = !!me?.canDispatch;
  const uid = me?.id || '';

  const [tab, setTab] = useState<'incoming' | 'outgoing'>('incoming');
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [submitId, setSubmitId] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [reviewDecision, setReviewDecision] = useState<'accept' | 'return'>('accept');
  const [files, setFiles] = useState<File[]>([]);
  const [createForm] = Form.useForm();

  const q = useQuery({
    queryKey: ['workbench-assignments'],
    queryFn: api.workbenchAssignments,
    staleTime: 15_000,
  });

  const peopleQuery = useQuery({
    queryKey: ['workbench-assignment-people'],
    queryFn: api.workbenchAssignmentPeople,
    enabled: createOpen && canDispatch,
    staleTime: 60_000,
  });

  const [bindUser, setBindUser] = useState<string>();
  const [bindMentor, setBindMentor] = useState<string>();
  const bindQ = useQuery({
    queryKey: ['workbench-mentor-bindings'],
    queryFn: api.workbenchMentorBindings,
    staleTime: 30_000,
  });

  const bindMutation = useMutation({
    mutationFn: () => api.workbenchBindMentor(bindUser!, bindMentor!),
    onSuccess: () => {
      message.success('已绑定导师');
      setBindUser(undefined);
      setBindMentor(undefined);
      void qc.invalidateQueries({ queryKey: ['workbench-mentor-bindings'] });
    },
    onError: (e: Error) => message.error(`绑定失败：${errText(e)}`),
  });

  const unbindMutation = useMutation({
    mutationFn: (id: string) => api.workbenchUnbindMentor(id),
    onSuccess: () => {
      message.success('已解除绑定');
      void qc.invalidateQueries({ queryKey: ['workbench-mentor-bindings'] });
    },
    onError: (e: Error) => message.error(`解绑失败：${errText(e)}`),
  });

  const bindData = bindQ.data;
  const internRank = bindData?.interns.find((p) => p.id === bindUser)?.rank ?? -1;
  const mentorOptions = (bindData?.mentors ?? []).filter((p) => p.rank > internRank);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['workbench-assignments'] });
    void qc.invalidateQueries({ queryKey: ['workbench-summary'] });
  };

  const incoming = q.data?.incoming ?? [];
  const outgoing = q.data?.outgoing ?? [];
  const all = useMemo(() => [...incoming, ...outgoing], [incoming, outgoing]);

  const detail = useMemo(() => all.find((a) => a.id === detailId) ?? null, [all, detailId]);
  const submitTarget = useMemo(() => all.find((a) => a.id === submitId) ?? null, [all, submitId]);
  const reviewTarget = useMemo(() => all.find((a) => a.id === reviewId) ?? null, [all, reviewId]);

  const isCreator = detail ? detail.creator_id === uid : false;
  const isAssignee = detail ? detail.assignee_id === uid : false;

  /* ------------------------------------------------------------- mutations */

  const createMutation = useMutation({
    mutationFn: async (body: Parameters<typeof api.workbenchCreateAssignment>[0]) => {
      const created = await api.workbenchCreateAssignment(body);
      for (const f of files) {
        await api.workbenchUploadAssignmentFile(created.assignment.id, f, 'brief');
      }
      return created.assignment;
    },
    onSuccess: () => {
      message.success('指派已发出');
      setCreateOpen(false);
      setFiles([]);
      createForm.resetFields();
      invalidate();
    },
    onError: (e: Error) => message.error(`发出失败：${errText(e)}`),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.workbenchUpdateAssignment(id, { status }),
    onSuccess: () => {
      message.success('状态已更新');
      invalidate();
    },
    onError: (e: Error) => message.error(`更新失败：${errText(e)}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.workbenchDeleteAssignment(id),
    onSuccess: () => {
      message.success('指派已删除');
      setDetailId(null);
      invalidate();
    },
    onError: (e: Error) => message.error(`删除失败：${errText(e)}`),
  });

  const uploadMutation = useMutation({
    mutationFn: ({ id, file, purpose }: { id: string; file: File; purpose: 'brief' | 'delivery' }) =>
      api.workbenchUploadAssignmentFile(id, file, purpose),
    onSuccess: () => {
      message.success('附件已上传');
      invalidate();
    },
    onError: (e: Error) => message.error(`上传失败：${errText(e)}`),
  });

  const deleteFileMutation = useMutation({
    mutationFn: (f: AssignmentFile) => api.workbenchDeleteAssignmentFile(f.id),
    onSuccess: () => {
      message.success('附件已删除');
      invalidate();
    },
    onError: (e: Error) => message.error(`删除失败：${errText(e)}`),
  });

  const submitMutation = useMutation({
    mutationFn: async ({ id, content }: { id: string; content: string }) => {
      for (const f of files) {
        await api.workbenchUploadAssignmentFile(id, f, 'delivery');
      }
      return api.workbenchSubmitAssignment(id, content);
    },
    onSuccess: () => {
      message.success('已提交，等待导师批阅');
      setSubmitId(null);
      setFiles([]);
      invalidate();
    },
    onError: (e: Error) => message.error(`提交失败：${errText(e)}`),
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, decision, feedback }: { id: string; decision: 'accept' | 'return'; feedback: string }) =>
      api.workbenchReviewAssignment(id, decision, feedback),
    onSuccess: (_r, v) => {
      message.success(v.decision === 'accept' ? '已通过' : '已退回，成员可继续修改');
      setReviewId(null);
      invalidate();
    },
    onError: (e: Error) => message.error(`批阅失败：${errText(e)}`),
  });

  /* ------------------------------------------------------------- handlers */

  const submitCreate = async () => {
    const v = await createForm.validateFields();
    createMutation.mutate({
      assignee_id: v.assignee_id,
      kind: v.kind || 'task',
      title: v.title,
      content: v.content || '',
      priority: v.priority || 'normal',
      due_date: v.due_date ? v.due_date.format('YYYY-MM-DD') : null,
    });
  };

  const submitWork = (target: WorkbenchAssignment | null, content: string) => {
    if (!target) return;
    if (!content.trim() && !files.length) {
      message.warning('请填写交付说明或上传交付附件');
      return;
    }
    submitMutation.mutate({ id: target.id, content });
  };

  const submitReview = (feedback: string) => {
    if (!reviewTarget) return;
    reviewMutation.mutate({ id: reviewTarget.id, decision: reviewDecision, feedback });
  };

  const peopleOptions = (people: AssignmentPerson[] | undefined) =>
    (people ?? []).map((p) => ({
      value: p.id,
      label: `${p.displayName || p.name}${p.rankLabel ? ` · ${p.rankLabel}` : ''}${p.email ? ` · ${p.email}` : ''}`,
      groups: p.groups,
      rankLabel: p.rankLabel,
    }));

  const canDeleteFile = (f: AssignmentFile) =>
    Boolean(uid) && (f.uploader_id === uid || (detail?.creator_id === uid));

  const doneCount = incoming.filter((a) => a.status === 'accepted').length;
  const pendingCount = incoming.filter((a) => a.status !== 'accepted').length;

  /* ---------------------------------------------------------------- render */

  return (
    <>
      <Flex justify="space-between" align="center" gap={8} wrap style={{ marginBottom: 14 }}>
        <Flex gap={10} align="center" wrap>
          <Segmented
            value={tab}
            onChange={(v) => setTab(v as 'incoming' | 'outgoing')}
            options={[
              { label: `我收到的 ${incoming.length}`, value: 'incoming' },
              { label: `我发出的 ${outgoing.length}`, value: 'outgoing' },
            ]}
          />
          {tab === 'incoming' && incoming.length ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              待办 {pendingCount} · 已完成 {doneCount}
            </Typography.Text>
          ) : null}
        </Flex>
        {canDispatch ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建指派
          </Button>
        ) : null}
      </Flex>

      {bindData?.canBind ? (
        <Card size="small" style={{ marginBottom: 12 }} styles={{ body: { padding: '10px 12px' } }}>
          <Flex vertical gap={10}>
            <Flex gap={8} align="center" wrap>
              <Typography.Text strong style={{ fontSize: 13 }}>
                <TeamOutlined /> 实习生绑定
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                把实习生等低年级成员挂到高年级导师名下，导师就能直接在任务编排里看到并指派。
              </Typography.Text>
            </Flex>
            <Flex gap={8} wrap align="center">
              <Select
                size="small"
                style={{ minWidth: 180 }}
                placeholder="选择低年级成员"
                value={bindUser}
                onChange={(v) => {
                  setBindUser(v);
                  setBindMentor(undefined);
                }}
                options={(bindData.interns ?? []).map((p) => ({
                  value: p.id,
                  label: `${p.name}${p.rankLabel ? ` · ${p.rankLabel}` : ''}`,
                }))}
                showSearch
                optionFilterProp="label"
                notFoundContent="没有待绑定的实习生"
              />
              <span style={{ color: 'var(--ant-color-text-tertiary)' }}>→</span>
              <Select
                size="small"
                style={{ minWidth: 180 }}
                placeholder="选择导师"
                value={bindMentor}
                onChange={setBindMentor}
                disabled={!bindUser}
                options={mentorOptions.map((p) => ({
                  value: p.id,
                  label: `${p.name} · ${p.rankLabel}`,
                }))}
                showSearch
                optionFilterProp="label"
                notFoundContent="没有更高组别的导师"
              />
              <Button
                size="small"
                type="primary"
                disabled={!bindUser || !bindMentor}
                loading={bindMutation.isPending}
                onClick={() => bindMutation.mutate()}
              >
                绑定
              </Button>
              {bindData.bindings.length ? (
                <Flex gap={6} wrap style={{ marginInlineStart: 8 }}>
                  {bindData.bindings.map((b) => (
                    <Tag
                      key={b.userId}
                      closable
                      onClose={() => unbindMutation.mutate(b.userId)}
                      style={{ margin: 0 }}
                    >
                      {b.userName} → {b.mentorName}
                    </Tag>
                  ))}
                </Flex>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  暂未绑定
                </Typography.Text>
              )}
            </Flex>
          </Flex>
        </Card>
      ) : bindData?.myMentor ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          title={`我的导师：${bindData.myMentor.mentorName}`}
        />
      ) : null}

      {q.isLoading ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : q.error ? (
        <Alert
          type="error"
          showIcon
          title="加载失败"
          description={errText(q.error as Error)}
          action={
            <Button size="small" onClick={() => void q.refetch()}>
              重试
            </Button>
          }
        />
      ) : (
        <AssignmentBoard
          items={tab === 'incoming' ? incoming : outgoing}
          mode={tab}
          onOpen={(a) => setDetailId(a.id)}
        />
      )}

      {/* ------------------------------------------------------ 新建指派 */}
      <Modal
        open={createOpen}
        title={
          <Flex gap={8} align="center">
            <TeamOutlined style={{ color: '#2B5CE6' }} /> 新建指派
          </Flex>
        }
        okText="发出"
        confirmLoading={createMutation.isPending}
        onOk={() => void submitCreate()}
        onCancel={() => {
          setCreateOpen(false);
          setFiles([]);
        }}
        width={640}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical" initialValues={{ kind: 'task', priority: 'normal' }}>
          <Form.Item
            name="assignee_id"
            label="指派给"
            rules={[{ required: true, message: '请选择成员' }]}
          >
            <Select
              loading={peopleQuery.isLoading}
              placeholder="搜索姓名或邮箱"
              showSearch={{ optionFilterProp: 'label' }}
              options={peopleOptions(peopleQuery.data?.people)}
              notFoundContent={peopleQuery.isLoading ? '加载中…' : '没有可指派成员'}
            />
          </Form.Item>
          <Flex gap={12} wrap>
            <Form.Item name="kind" label="类型" style={{ minWidth: 140, flex: 1 }}>
              <Select
                options={[
                  { value: 'task', label: '任务' },
                  { value: 'project', label: '课题' },
                ]}
              />
            </Form.Item>
            <Form.Item name="priority" label="优先级" style={{ minWidth: 140, flex: 1 }}>
              <Select
                options={[
                  { value: 'low', label: '低' },
                  { value: 'normal', label: '普通' },
                  { value: 'high', label: '高' },
                ]}
              />
            </Form.Item>
            <Form.Item name="due_date" label="截止日期" style={{ minWidth: 160, flex: 1 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
          </Flex>
          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, message: '请填写标题' }, { max: 200, message: '最多 200 字' }]}
          >
            <Input placeholder="例如：完成拟南芥开花时间 GWAS 初筛" />
          </Form.Item>
          <Form.Item name="content" label="任务说明">
            <MarkdownEditor
              value={createForm.getFieldValue('content') || ''}
              onChange={(v) => createForm.setFieldValue('content', v)}
              rows={8}
              placeholder="目标、方法、交付要求…支持 Markdown"
            />
          </Form.Item>
          <Form.Item label="说明附件">
            <FileStager files={files} onChange={setFiles} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ------------------------------------------------------ 指派详情 */}
      <Modal
        open={Boolean(detail)}
        title={
          detail ? (
            <Flex gap={8} align="center" wrap>
              <Tag color={detail.kind === 'project' ? 'purple' : 'blue'} style={{ margin: 0 }}>
                {KIND_CN[detail.kind] || detail.kind}
              </Tag>
              <span>{detail.title}</span>
            </Flex>
          ) : '指派详情'
        }
        footer={null}
        width={760}
        onCancel={() => setDetailId(null)}
        destroyOnHidden
      >
        {detail ? (
          <Flex vertical gap={14}>
            <Flex gap={8} align="center" wrap>
              <Tag
                color={STATUS_META[detail.status]?.color}
                icon={STATUS_META[detail.status]?.icon}
                style={{ margin: 0 }}
              >
                {STATUS_META[detail.status]?.label || detail.status}
              </Tag>
              <Tag color={PRIORITY_META[detail.priority]?.color} style={{ margin: 0 }}>
                {PRIORITY_META[detail.priority]?.label || detail.priority}
              </Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {detail.creator_name || '导师'} → {detail.assignee_name || '成员'}
              </Typography.Text>
              {detail.due_date ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  截止 {dayjs(detail.due_date).format('YYYY-MM-DD')}
                </Typography.Text>
              ) : null}
            </Flex>

            <Card size="small" title="任务说明" styles={{ body: { paddingTop: 8 } }}>
              {detail.content?.trim() ? (
                <MarkdownView source={detail.content} />
              ) : (
                <Typography.Text type="secondary">未填写说明</Typography.Text>
              )}
              {detail.brief_files.length ? (
                <div style={{ marginTop: 10 }}>
                  <Typography.Text strong style={{ fontSize: 12.5, display: 'block', marginBottom: 6 }}>
                    说明附件
                  </Typography.Text>
                  <FileList
                    files={detail.brief_files}
                    canDelete={canDeleteFile}
                    onDelete={(f) => deleteFileMutation.mutate(f)}
                  />
                </div>
              ) : null}
              {isCreator ? (
                <div style={{ marginTop: 10 }}>
                  <Upload
                    multiple
                    showUploadList={false}
                    beforeUpload={(f) => {
                      if (f.size > 20 * 1024 * 1024) {
                        message.warning('单个附件不能超过 20 MB');
                        return false;
                      }
                      uploadMutation.mutate({ id: detail.id, file: f, purpose: 'brief' });
                      return false;
                    }}
                  >
                    <Button size="small" icon={<PaperClipOutlined />} loading={uploadMutation.isPending}>
                      追加附件
                    </Button>
                  </Upload>
                </div>
              ) : null}
            </Card>

            <Card size="small" title={`提交记录（${detail.submissions.length}）`} styles={{ body: { paddingTop: 8 } }}>
              {detail.submissions.length === 0 ? (
                <Typography.Text type="secondary">还没有提交</Typography.Text>
              ) : (
                <Flex vertical gap={12}>
                  {detail.submissions.map((s, idx) => (
                    <div
                      key={s.id}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 10,
                        background: 'var(--ant-color-fill-quaternary, rgba(0,0,0,0.02))',
                        border: '1px solid var(--ant-color-border-secondary, #EEF0F4)',
                      }}
                    >
                      <Flex gap={8} align="center" style={{ marginBottom: 6 }} wrap>
                        <Tag color="blue" style={{ margin: 0 }}>
                          第 {detail.submissions.length - idx} 次
                        </Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                          {dayjs(s.created_at).format('MM-DD HH:mm')}
                        </Typography.Text>
                      </Flex>
                      {s.content.trim() ? <MarkdownView source={s.content} /> : null}
                      {s.files.length ? (
                        <div style={{ marginTop: 8 }}>
                          <FileList
                            files={s.files}
                            canDelete={canDeleteFile}
                            onDelete={(f) => deleteFileMutation.mutate(f)}
                          />
                        </div>
                      ) : null}
                    </div>
                  ))}
                </Flex>
              )}
              {detail.feedback ? (
                <Alert
                  style={{ marginTop: 12 }}
                  type={detail.status === 'accepted' ? 'success' : 'warning'}
                  showIcon
                  title="导师反馈"
                  description={<MarkdownView source={detail.feedback} />}
                />
              ) : null}
            </Card>

            <Flex gap={8} justify="flex-end" wrap>
              {isCreator ? (
                <>
                  <Popconfirm title="删除这条指派及其全部提交与附件？" onConfirm={() => deleteMutation.mutate(detail.id)}>
                    <Button danger icon={<DeleteOutlined />} loading={deleteMutation.isPending}>
                      删除
                    </Button>
                  </Popconfirm>
                  {detail.status === 'submitted' ? (
                    <>
                      <Button
                        icon={<CloseCircleOutlined />}
                        onClick={() => {
                          setReviewDecision('return');
                          setReviewId(detail.id);
                        }}
                      >
                        退回修改
                      </Button>
                      <Button
                        type="primary"
                        icon={<CheckCircleOutlined />}
                        onClick={() => {
                          setReviewDecision('accept');
                          setReviewId(detail.id);
                        }}
                      >
                        通过
                      </Button>
                    </>
                  ) : null}
                  {detail.status === 'accepted' || detail.status === 'returned' ? (
                    <Button
                      loading={statusMutation.isPending}
                      onClick={() => statusMutation.mutate({ id: detail.id, status: 'assigned' })}
                    >
                      重新开启
                    </Button>
                  ) : null}
                </>
              ) : null}
              {isAssignee && (detail.status === 'assigned' || detail.status === 'returned') ? (
                <Button
                  loading={statusMutation.isPending}
                  onClick={() => statusMutation.mutate({ id: detail.id, status: 'in_progress' })}
                >
                  标记开始
                </Button>
              ) : null}
              {isAssignee && detail.status !== 'accepted' ? (
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  onClick={() => {
                    setFiles([]);
                    setSubmitId(detail.id);
                  }}
                  disabled={detail.status === 'submitted'}
                >
                  提交交付
                </Button>
              ) : null}
            </Flex>
          </Flex>
        ) : null}
      </Modal>

      {/* ------------------------------------------------------ 提交交付 */}
      <SubmitModal
        key={submitId || 'submit-none'}
        open={Boolean(submitTarget)}
        assignment={submitTarget}
        files={files}
        setFiles={setFiles}
        busy={submitMutation.isPending}
        onCancel={() => {
          setSubmitId(null);
          setFiles([]);
        }}
        onSubmit={submitWork}
      />

      {/* ------------------------------------------------------ 批阅 */}
      <ReviewModal
        key={`${reviewId || 'review-none'}-${reviewDecision}`}
        open={Boolean(reviewTarget)}
        decision={reviewDecision}
        busy={reviewMutation.isPending}
        onCancel={() => setReviewId(null)}
        onSubmit={submitReview}
      />
    </>
  );
}

/* ------------------------------------------------------------------ 提交弹窗 */

function SubmitModal({
  open,
  assignment,
  files,
  setFiles,
  busy,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  assignment: WorkbenchAssignment | null;
  files: File[];
  setFiles: (f: File[]) => void;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (target: WorkbenchAssignment | null, content: string) => void;
}) {
  const [content, setContent] = useState('');
  return (
    <Modal
      open={open}
      title={assignment ? `提交交付 · ${assignment.title}` : '提交交付'}
      okText="提交"
      confirmLoading={busy}
      onOk={() => onSubmit(assignment, content)}
      onCancel={() => {
        setContent('');
        onCancel();
      }}
      width={640}
      destroyOnHidden
    >
      <Flex vertical gap={12}>
        {assignment?.status === 'returned' && assignment.feedback ? (
          <Alert
            type="warning"
            showIcon
            title="导师退回意见"
            description={<MarkdownView source={assignment.feedback} />}
          />
        ) : null}
        <div>
          <Typography.Text strong style={{ fontSize: 12.5, display: 'block', marginBottom: 6 }}>
            交付说明
          </Typography.Text>
          <MarkdownEditor
            value={content}
            onChange={setContent}
            rows={8}
            placeholder="说明完成情况、结果文件与注意事项…支持 Markdown"
          />
        </div>
        <div>
          <Typography.Text strong style={{ fontSize: 12.5, display: 'block', marginBottom: 6 }}>
            交付附件
          </Typography.Text>
          <FileStager files={files} onChange={setFiles} hint="随本次提交一起交付，单个 ≤ 20 MB" />
        </div>
      </Flex>
    </Modal>
  );
}

/* ------------------------------------------------------------------ 批阅弹窗 */

function ReviewModal({
  open,
  decision,
  busy,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  decision: 'accept' | 'return';
  busy: boolean;
  onCancel: () => void;
  onSubmit: (feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState('');
  return (
    <Modal
      open={open}
      title={decision === 'accept' ? '通过指派' : '退回修改'}
      okText={decision === 'accept' ? '确认通过' : '确认退回'}
      confirmLoading={busy}
      onOk={() => {
        onSubmit(feedback);
        setFeedback('');
      }}
      onCancel={() => {
        setFeedback('');
        onCancel();
      }}
      width={560}
      destroyOnHidden
    >
      <Flex vertical gap={10}>
        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
          {decision === 'accept'
            ? '通过后该指派将标记为已完成，成员仍可查看历史。'
            : '退回后成员会看到你的意见，并可继续补充提交。'}
        </Typography.Text>
        <MarkdownEditor
          value={feedback}
          onChange={setFeedback}
          rows={6}
          placeholder="反馈意见（支持 Markdown，可留空）"
        />
      </Flex>
    </Modal>
  );
}