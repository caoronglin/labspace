import { useMemo, useState } from 'react';
import {
  App,
  Button,
  Descriptions,
  Flex,
  Modal,
  Popconfirm,
  Space,
  Steps,
  Table,
  Tabs,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { DeleteOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import { Bubble } from '@ant-design/x';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { asDelete, asGet, asList } from '../../../services/agentscope';
import type { AsSopList, AsSopRecord, AsSopRun, AsSopRunList } from '../../../services/agentscope';
import { AsEmpty, AsErrorAlert, AsLoading, asErrorText, formatTime } from './common';

const SOPS_KEY = ['as', 'sop'] as const;
const RUNS_KEY = ['as', 'sop', 'runs'] as const;

/** 阶段 → 标签配色；上游的 phase 是自由字符串，未知值走默认色。 */
function phaseColor(phase?: string): string {
  switch (phase) {
    case 'success':
    case 'done':
    case 'completed':
      return 'green';
    case 'failed':
    case 'error':
      return 'red';
    case 'running':
    case 'in_progress':
      return 'blue';
    default:
      return 'default';
  }
}

/** SOP 步骤在一次运行里的状态 → antd Steps 的 status。 */
function stepStatus(phase?: string): 'wait' | 'process' | 'finish' | 'error' {
  switch (phase) {
    case 'success':
    case 'done':
    case 'completed':
      return 'finish';
    case 'failed':
    case 'error':
      return 'error';
    case 'running':
    case 'in_progress':
      return 'process';
    default:
      return 'wait';
  }
}

/** 把 SOP 运行里的消息块压成纯文本（上游的 Msg 结构不固定）。 */
function messageText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return String(input ?? '');
  const record = input as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  return JSON.stringify(input);
}

/** 一次 SOP 运行的详情：步骤状态 + 输入消息。 */
function SopRunDetail({ runId }: { runId: string }) {
  const run = useQuery({
    queryKey: ['as', 'sop', 'runs', runId],
    queryFn: () => asGet<AsSopRun>('sop', `runs/${runId}`),
    enabled: runId !== '',
    staleTime: 30_000,
  });

  if (run.isLoading) return <AsLoading rows={3} />;
  if (run.error) return <AsErrorAlert error={run.error} onRetry={() => void run.refetch()} />;
  const record = run.data;
  if (!record) return <AsEmpty description="运行记录不存在" />;

  const steps = record.definition?.steps ?? [];
  const runSteps = record.state?.steps ?? [];

  return (
    <Flex vertical gap={12}>
      <Descriptions
        size="small"
        column={{ xs: 1, sm: 2 }}
        items={[
          { key: 'id', label: '运行 ID', children: record.id },
          { key: 'phase', label: '阶段', children: <Tag color={phaseColor(record.state?.phase)}>{record.state?.phase || '未知'}</Tag> },
          { key: 'created', label: '创建时间', children: formatTime(record.created_at) },
          { key: 'sessions', label: '关联会话', children: Object.keys(record.sessions ?? {}).join('、') || '—' },
        ]}
      />
      <Typography.Text strong>步骤状态</Typography.Text>
      <Steps
        size="small"
        direction="vertical"
        items={steps.map((step, index) => ({
          title: step.subject,
          description: step.description,
          status: stepStatus(runSteps[index]?.phase),
        }))}
      />
      {(record.state?.inputs?.length ?? 0) > 0 ? (
        <>
          <Typography.Text strong>输入</Typography.Text>
          <Bubble.List
            items={(record.state?.inputs ?? []).map((input, index) => ({
              key: `${record.id}-${index}`,
              content: messageText(input),
              role: 'user',
              placement: 'end',
            }))}
          />
        </>
      ) : null}
    </Flex>
  );
}

/** SOP 工作流：列表、步骤定义、运行记录。 */
export default function SopTab() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [detailOf, setDetailOf] = useState<AsSopRecord | null>(null);
  const [runId, setRunId] = useState('');

  const sops = useQuery({
    queryKey: SOPS_KEY,
    queryFn: () => asList<AsSopList>('sop'),
    staleTime: 30_000,
  });

  const runs = useQuery({
    queryKey: RUNS_KEY,
    queryFn: () => asList<AsSopRunList>('sop', 'runs'),
    staleTime: 30_000,
  });

  const remove = useMutation({
    mutationFn: (id: string) => asDelete('sop', id),
    onSuccess: () => {
      message.success('SOP 已删除');
      void qc.invalidateQueries({ queryKey: SOPS_KEY });
    },
    onError: (err) => message.error(asErrorText(err)),
  });

  const runsOfDetail = useMemo(
    () => (runs.data?.runs ?? []).filter((run) => run.sop_id === detailOf?.id),
    [runs.data, detailOf],
  );

  const columns: TableColumnsType<AsSopRecord> = [
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
      title: '描述',
      key: 'description',
      render: (_v, record) => record.data?.description || '—',
    },
    {
      title: '步骤数',
      key: 'steps',
      width: 90,
      render: (_v, record) => record.data?.steps?.length ?? 0,
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
      width: 160,
      render: (_v, record) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<EyeOutlined />}
            aria-label={`查看 SOP ${record.data?.name || record.id} 的详情`}
            onClick={() => {
              setDetailOf(record);
              setRunId('');
            }}
          >
            详情
          </Button>
          <Popconfirm
            title="删除该 SOP？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => remove.mutateAsync(record.id)}
          >
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              aria-label={`删除 SOP ${record.data?.name || record.id}`}
            >
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Flex vertical gap={12}>
      {sops.isLoading ? (
        <AsLoading rows={5} />
      ) : sops.error ? (
        <AsErrorAlert error={sops.error} onRetry={() => void sops.refetch()} />
      ) : (sops.data?.sops.length ?? 0) === 0 ? (
        <AsEmpty
          description="还没有 SOP 工作流"
          action={
            <Button icon={<ReloadOutlined />} onClick={() => void sops.refetch()}>
              刷新列表
            </Button>
          }
        />
      ) : (
        <Table<AsSopRecord>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={sops.data?.sops ?? []}
          pagination={false}
          scroll={{ x: 900 }}
        />
      )}

      <Modal
        title={detailOf ? `SOP · ${detailOf.data?.name || detailOf.id}` : 'SOP 详情'}
        open={detailOf !== null}
        onCancel={() => {
          setDetailOf(null);
          setRunId('');
        }}
        footer={null}
        width={760}
      >
        <Tabs
          items={[
            {
              key: 'steps',
              label: '步骤定义',
              children: (detailOf?.data?.steps?.length ?? 0) === 0 ? (
                <AsEmpty description="该 SOP 没有步骤" />
              ) : (
                <Steps
                  direction="vertical"
                  size="small"
                  items={(detailOf?.data?.steps ?? []).map((step) => ({
                    title: step.subject,
                    description: step.description,
                  }))}
                />
              ),
            },
            {
              key: 'runs',
              label: `运行记录（${runsOfDetail.length}）`,
              children: runs.isLoading ? (
                <AsLoading rows={3} />
              ) : runs.error ? (
                <AsErrorAlert error={runs.error} onRetry={() => void runs.refetch()} />
              ) : runsOfDetail.length === 0 ? (
                <AsEmpty description="该 SOP 还没有运行记录" />
              ) : (
                <Flex vertical gap={12}>
                  <Timeline
                    items={runsOfDetail.map((run) => ({
                      color:
                        run.state?.phase === 'failed' || run.state?.phase === 'error'
                          ? 'red'
                          : 'blue',
                      children: (
                        <Flex vertical gap={4}>
                          <Button
                            type="link"
                            style={{ padding: 0, height: 'auto' }}
                            aria-label={`查看运行记录 ${run.id}`}
                            onClick={() => setRunId(run.id)}
                          >
                            {run.id}
                          </Button>
                          <Space size={4}>
                            <Tag color={phaseColor(run.state?.phase)}>{run.state?.phase || '未知'}</Tag>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {formatTime(run.created_at)}
                            </Typography.Text>
                          </Space>
                        </Flex>
                      ),
                    }))}
                  />
                  {runId ? <SopRunDetail runId={runId} /> : null}
                </Flex>
              ),
            },
          ]}
        />
      </Modal>
    </Flex>
  );
}
