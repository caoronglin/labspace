import { useMemo, useState } from 'react';
import {
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Grid,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { EyeOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { asGet, asList } from '../../../services/agentscope';
import type {
  AsAgentList,
  AsDirectoryEntry,
  AsDirectoryListing,
  AsSessionList,
  AsWorkspaceStatus,
} from '../../../services/agentscope';
import { AsEmpty, AsErrorAlert, AsLoading, formatBytes } from './common';

/** 工作区文件预览：上游返回的可能是纯文本，也可能是结构化内容。 */
function previewText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload === undefined || payload === null) return '';
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

/** 工作区：状态详情（Descriptions）+ 文件列表（可预览）。 */
export default function WorkspaceTab() {
  const screens = Grid.useBreakpoint();
  const narrow = !screens.md;
  const [agentId, setAgentId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<{ name: string; path: string } | null>(null);

  const agents = useQuery({
    queryKey: ['as', 'agent'],
    queryFn: () => asList<AsAgentList>('agent'),
    staleTime: 30_000,
  });

  const effectiveAgent = agentId || agents.data?.agents?.[0]?.id || '';

  // AgentScope 的会话按助手过滤（GET /sessions/ 需要 agent_id）。
  const sessions = useQuery({
    queryKey: ['as', 'sessions', effectiveAgent],
    queryFn: () => asGet<AsSessionList>('sessions', '', { agent_id: effectiveAgent }),
    enabled: effectiveAgent !== '',
    staleTime: 30_000,
  });

  const effectiveSession = sessionId || sessions.data?.sessions?.[0]?.id || '';

  // 工作区状态与文件列表都按（助手, 会话）定位。
  const status = useQuery({
    queryKey: ['as', 'workspace', 'status', effectiveAgent, effectiveSession],
    queryFn: () =>
      asGet<AsWorkspaceStatus>('workspace', 'status', {
        agent_id: effectiveAgent,
        session_id: effectiveSession,
      }),
    enabled: effectiveAgent !== '' && effectiveSession !== '',
    staleTime: 30_000,
  });

  const directories = useQuery({
    queryKey: ['as', 'workspace', 'directories', path, effectiveAgent, effectiveSession],
    queryFn: () =>
      asGet<AsDirectoryListing>('workspace', 'directories', {
        path,
        agent_id: effectiveAgent,
        session_id: effectiveSession,
      }),
    enabled: effectiveAgent !== '' && effectiveSession !== '',
    staleTime: 30_000,
  });

  const file = useQuery({
    queryKey: ['as', 'workspace', 'files', preview?.path ?? '', effectiveAgent, effectiveSession],
    queryFn: () =>
      asGet<unknown>('workspace', 'files', {
        path: preview?.path ?? '',
        agent_id: effectiveAgent,
        session_id: effectiveSession,
      }),
    enabled: preview !== null,
    staleTime: 0,
  });

  const columns: TableColumnsType<AsDirectoryEntry> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (value: string, record) => (
        <Space size={4}>
          {record.is_dir ? <FolderOpenOutlined /> : null}
          {record.is_dir ? (
            <Button
              type="link"
              style={{ padding: 0, height: 'auto' }}
              aria-label={`进入目录 ${value}`}
              onClick={() => setPath((prev) => (prev ? `${prev.replace(/\/$/, '')}/${value}` : value))}
            >
              {value}
            </Button>
          ) : (
            <span>{value}</span>
          )}
        </Space>
      ),
    },
    {
      title: '类型',
      key: 'is_dir',
      width: 90,
      render: (_v, record) => <Tag>{record.is_dir ? '目录' : '文件'}</Tag>,
    },
    {
      title: '大小',
      key: 'size',
      width: 110,
      render: (_v, record) => (record.is_dir ? '—' : formatBytes(record.size_bytes)),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_v, record) =>
        record.is_dir ? null : (
          <Button
            size="small"
            icon={<EyeOutlined />}
            aria-label={`预览文件 ${record.name}`}
            onClick={() =>
              setPreview({
                name: record.name,
                path: path ? `${path.replace(/\/$/, '')}/${record.name}` : record.name,
              })
            }
          >
            预览
          </Button>
        ),
    },
  ];

  const git = status.data?.git;
  const noScope = effectiveAgent === '' || effectiveSession === '';

  const statusItems = useMemo(
    () => [
      { key: 'workdir', label: '工作目录', children: status.data?.workdir || '—' },
      { key: 'cwd', label: '当前目录', children: status.data?.cwd || '—' },
      {
        key: 'branch',
        label: 'Git 分支',
        children: git?.branch ? <Tag color="blue">{git.branch}</Tag> : '—',
      },
      {
        key: 'head',
        label: 'Git HEAD',
        children: git?.head ? <code>{git.head.slice(0, 12)}</code> : '—',
      },
      {
        key: 'ahead',
        label: '领先 / 落后',
        children: git ? `${git.ahead ?? 0} / ${git.behind ?? 0}` : '—',
      },
      {
        key: 'changes',
        label: '改动统计',
        children: git
          ? `+${git.insertions ?? 0} / -${git.deletions ?? 0}（未暂存 ${git.unstaged ?? 0}，未跟踪 ${git.untracked ?? 0}）`
          : '—',
      },
    ],
    [status.data, git],
  );

  return (
    <Flex vertical gap={16}>
      <Card size="small" title="工作区状态">
        {status.isLoading ? (
          <AsLoading rows={3} />
        ) : status.error ? (
          <AsErrorAlert error={status.error} onRetry={() => void status.refetch()} />
        ) : (
          <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} items={statusItems} />
        )}
      </Card>

      <Card size="small" title="文件">
        <Flex vertical gap={12}>
          <Flex gap={8} wrap align="center">
            <Select
              showSearch
              style={{ minWidth: 220 }}
              placeholder="选择助手"
              aria-label="工作区所属助手"
              value={effectiveAgent || undefined}
              onChange={(value) => {
                setAgentId(value);
                // 换助手后旧会话不再适用，回到自动选择。
                setSessionId('');
              }}
              options={(agents.data?.agents ?? []).map((agent) => ({
                value: agent.id,
                label: agent.data?.name || agent.id,
              }))}
              notFoundContent={agents.error ? '助手列表不可用' : '没有可用助手'}
            />
            <Select
              showSearch
              style={{ minWidth: 220 }}
              placeholder="选择会话"
              aria-label="工作区所属会话"
              value={effectiveSession || undefined}
              onChange={setSessionId}
              options={(sessions.data?.sessions ?? []).map((session) => ({
                value: session.id,
                label: session.id,
              }))}
              notFoundContent={sessions.error ? '会话列表不可用' : '没有可用会话'}
            />
            <Input
              style={{ minWidth: 200 }}
              value={path}
              placeholder="相对工作区根目录的路径"
              aria-label="工作区路径"
              onChange={(e) => setPath(e.target.value)}
            />
            <Button
              icon={<ReloadOutlined />}
              aria-label="刷新文件列表"
              onClick={() => void directories.refetch()}
            >
              刷新
            </Button>
          </Flex>

          {noScope ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="AgentScope 的工作区按助手 + 会话定位，先选一个助手与会话。"
            />
          ) : directories.isLoading ? (
            <AsLoading rows={4} />
          ) : directories.error ? (
            <AsErrorAlert error={directories.error} onRetry={() => void directories.refetch()} />
          ) : (directories.data?.entries.length ?? 0) === 0 ? (
            <AsEmpty description="该目录下没有文件" />
          ) : (
            <Table<AsDirectoryEntry>
              rowKey="name"
              size="small"
              columns={columns}
              dataSource={directories.data?.entries ?? []}
              pagination={false}
              scroll={{ x: 700 }}
            />
          )}

          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            当前路径：{directories.data?.path || path || '（工作区根目录）'}
          </Typography.Text>
        </Flex>
      </Card>

      <Modal
        title={`预览 · ${preview?.name ?? ''}`}
        open={preview !== null}
        onCancel={() => setPreview(null)}
        footer={null}
        width={narrow ? '100%' : 800}
      >
        {file.isLoading ? (
          <AsLoading rows={4} />
        ) : file.error ? (
          <AsErrorAlert error={file.error} onRetry={() => void file.refetch()} />
        ) : (
          <pre
            style={{
              maxHeight: 460,
              overflow: 'auto',
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {previewText(file.data)}
          </pre>
        )}
      </Modal>
    </Flex>
  );
}
