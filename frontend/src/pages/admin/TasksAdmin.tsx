/**
 * 后台任务管理（管理端 → 后台任务）。
 *
 * 解决的问题：以前"有哪些定时任务、上次跑成功没有、下次什么时候跑"只能 ssh
 * 上去 `systemctl list-timers`，出问题没人知道，直到要恢复时才发现备份是断的。
 *
 * 交互规则（与后端白名单一致）：
 * - 定时器/一次性任务可以「立即执行」，但**常驻服务不提供一键重启**，
 *   避免手滑把线上服务踢掉；
 * - 失败项置顶，并给「重置失败状态」按钮（否则 systemd 会一直挂着 failed）；
 * - 日志按需展开，只拉最近 60 行。
 */
import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Flex,
  Grid,
  Popconfirm,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AdminTask } from '../../services/api';
import { errText } from '../../utils/err';
import { tokens } from '../../theme/tokens';

const { Text } = Typography;

/** systemd 的 ActiveState → 中文与颜色。 */
function stateTag(task: AdminTask) {
  if (task.active === 'failed' || task.result === 'failed') {
    return (
      <Tag color="error" icon={<ExclamationCircleOutlined />}>
        失败
      </Tag>
    );
  }
  switch (task.active) {
    case 'active':
      return task.kind === 'oneshot' ? (
        <Tag color="success" icon={<CheckCircleOutlined />}>
          已就绪
        </Tag>
      ) : (
        <Tag color="success">运行中</Tag>
      );
    case 'activating':
      return <Tag color="processing">启动中</Tag>;
    case 'inactive':
      return <Tag>待触发</Tag>;
    default:
      return <Tag>{task.active}</Tag>;
  }
}

/** ISO 时间 → 本地可读（解析失败就原样显示，不吞掉信息）。 */
function fmt(value: string): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('zh-CN', { hour12: false });
}

export default function TasksAdmin() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const screens = Grid.useBreakpoint();
  const [expanded, setExpanded] = useState<string | null>(null);

  const tasks = useQuery({
    queryKey: ['admin-tasks'],
    queryFn: api.adminTasks,
    retry: false,
    // 任务状态会自己变化（定时器到点就跑），开轮询让页面不用手动刷。
    refetchInterval: 20_000,
  });

  const logs = useQuery({
    queryKey: ['admin-task-logs', expanded],
    queryFn: () => api.adminTaskLogs(expanded as string, 60),
    enabled: Boolean(expanded),
    retry: false,
  });

  const runMutation = useMutation({
    mutationFn: (unit: string) => api.adminTaskRun(unit),
    onSuccess: (_r, unit) => {
      message.success(`已触发 ${unit}（后台执行，稍后自动刷新状态）`);
      void qc.invalidateQueries({ queryKey: ['admin-tasks'] });
    },
    onError: (e) => message.error(`触发失败：${errText(e)}`),
  });

  const resetMutation = useMutation({
    mutationFn: (unit: string) => api.adminTaskReset(unit),
    onSuccess: (_r, unit) => {
      message.success(`已清除 ${unit} 的失败状态`);
      void qc.invalidateQueries({ queryKey: ['admin-tasks'] });
    },
    onError: (e) => message.error(`重置失败：${errText(e)}`),
  });

  const units = tasks.data?.units ?? [];
  const failed = tasks.data?.failed ?? 0;
  const timers = units.filter((u) => u.kind === 'timer').length;
  const services = units.filter((u) => u.kind === 'service').length;

  const columns: ColumnsType<AdminTask> = [
    {
      title: '任务',
      dataIndex: 'label',
      key: 'label',
      width: 260,
      render: (label: string, row) => (
        <Flex vertical gap={2}>
          <Text strong>{label}</Text>
          <Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace' }}>
            {row.unit}
          </Text>
        </Flex>
      ),
    },
    {
      title: '状态',
      key: 'state',
      width: 100,
      render: (_v, row) => stateTag(row),
    },
    {
      title: '上次运行',
      dataIndex: 'last',
      key: 'last',
      width: 170,
      render: (v: string) => <Text type="secondary">{fmt(v)}</Text>,
    },
    {
      title: '下次运行',
      dataIndex: 'next',
      key: 'next',
      width: 170,
      render: (v: string) =>
        v ? (
          <Space size={4}>
            <ClockCircleOutlined style={{ color: tokens.colorPrimary }} />
            <Text>{fmt(v)}</Text>
          </Space>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 240,
      render: (_v, row) => (
        <Space size={4} wrap>
          <Tooltip title="查看最近日志">
            <Button
              size="small"
              icon={<FileTextOutlined />}
              onClick={() => setExpanded(row.unit)}
              aria-label={`查看 ${row.label} 日志`}
            >
              日志
            </Button>
          </Tooltip>
          {row.triggerable ? (
            <Popconfirm
              title={`立即执行「${row.label}」？`}
              description="会在后台开始跑，页面稍后自动刷新状态。"
              okText="执行"
              cancelText="取消"
              onConfirm={() => runMutation.mutate(row.unit)}
            >
              <Button
                size="small"
                type="primary"
                ghost
                icon={<PlayCircleOutlined />}
                loading={runMutation.isPending}
              >
                执行
              </Button>
            </Popconfirm>
          ) : null}
          {row.active === 'failed' || row.result === 'failed' ? (
            <Popconfirm
              title="清除失败状态？"
              description="只是把 systemd 的 failed 标记清掉，不会修复失败原因。"
              okText="清除"
              cancelText="取消"
              onConfirm={() => resetMutation.mutate(row.unit)}
            >
              <Button size="small" icon={<UndoOutlined />}>
                重置
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      {tasks.isError ? (
        <Alert
          type="error"
          showIcon
          title="读取后台任务失败"
          description={errText(tasks.error)}
          action={
            <Button size="small" onClick={() => void tasks.refetch()}>
              重试
            </Button>
          }
        />
      ) : null}

      <Flex gap={12} wrap>
        <Card size="small" style={{ flex: '1 1 150px', minWidth: 140 }}>
          <Statistic title="定时任务" value={timers} suffix="个" />
        </Card>
        <Card size="small" style={{ flex: '1 1 150px', minWidth: 140 }}>
          <Statistic title="常驻服务" value={services} suffix="个" />
        </Card>
        <Card size="small" style={{ flex: '1 1 150px', minWidth: 140 }}>
          <Statistic
            title="失败项"
            value={failed}
            suffix="个"
            styles={{ content: { color: failed ? tokens.colorError : tokens.colorSuccess } }}
          />
        </Card>
      </Flex>

      {failed > 0 ? (
        <Alert
          type="warning"
          showIcon
          title={`有 ${failed} 个后台任务处于失败状态`}
          description="失败的任务不会自动恢复。先看日志定位原因，修好后点「执行」手动跑一次，再点「重置」清掉失败标记。"
        />
      ) : null}

      <Card
        size="small"
        title="后台任务"
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={tasks.isFetching}
            onClick={() => void tasks.refetch()}
          >
            刷新
          </Button>
        }
      >
        {tasks.isLoading ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : (
          <Table<AdminTask>
            rowKey="unit"
            size="small"
            columns={columns}
            dataSource={units}
            pagination={false}
            scroll={{ x: screens.md ? undefined : 820 }}
            expandable={{
              expandedRowKeys: expanded ? [expanded] : [],
              onExpandedRowsChange: (keys) => {
                const next = (keys as string[])[0] ?? null;
                setExpanded(next);
              },
              expandedRowRender: (row) => (
                <Flex vertical gap={8}>
                  {logs.isLoading ? (
                    <Skeleton active paragraph={{ rows: 4 }} />
                  ) : logs.isError ? (
                    <Alert type="error" showIcon title="日志读取失败" description={errText(logs.error)} />
                  ) : (logs.data?.lines ?? []).length === 0 ? (
                    <Empty description="该任务暂无日志" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  ) : (
                    <pre
                      style={{
                        margin: 0,
                        padding: 10,
                        maxHeight: 320,
                        overflow: 'auto',
                        fontSize: 12,
                        lineHeight: 1.5,
                        background: 'rgba(2, 6, 23, 0.04)',
                        borderRadius: 6,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                      }}
                    >
                      {(logs.data?.lines ?? []).join('\n')}
                    </pre>
                  )}
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    只显示最近 60 行；完整日志用 journalctl -u {row.unit}
                  </Text>
                </Flex>
              ),
            }}
            locale={{ emptyText: <Empty description="没有可管理的后台任务" /> }}
          />
        )}
      </Card>

    </Flex>
  );
}
