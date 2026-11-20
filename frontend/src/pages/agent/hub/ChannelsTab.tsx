import { useState } from 'react';
import {
  App,
  Button,
  Drawer,
  Dropdown,
  Flex,
  Grid,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { DeleteOutlined, MessageOutlined, MoreOutlined, ReloadOutlined } from '@ant-design/icons';
import { Conversations } from '@ant-design/x';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { asDelete, asGet, asList, asPost } from '../../../services/agentscope';
import type { AsChannel, AsSessionList } from '../../../services/agentscope';
import { AsEmpty, AsErrorAlert, AsLoading, asErrorText, formatTime } from './common';

const CHANNELS_KEY = ['as', 'channels'] as const;

/** IM 渠道：列表、启停、删除、绑定会话。 */
export default function ChannelsTab() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const narrow = !screens.md;
  const [sessionOf, setSessionOf] = useState<AsChannel | null>(null);

  const channels = useQuery({
    queryKey: CHANNELS_KEY,
    queryFn: () => asList<AsChannel[]>('channels'),
    staleTime: 30_000,
  });

  const toggle = useMutation({
    mutationFn: (v: { id: string; enable: boolean }) =>
      asPost('channels', `${v.id}/${v.enable ? 'enable' : 'disable'}`),
    onSuccess: (_data, v) => {
      message.success(v.enable ? '渠道已启用' : '渠道已停用');
      void qc.invalidateQueries({ queryKey: CHANNELS_KEY });
    },
    onError: (err) => message.error(asErrorText(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => asDelete('channels', id),
    onSuccess: () => {
      message.success('渠道已删除');
      void qc.invalidateQueries({ queryKey: CHANNELS_KEY });
    },
    onError: (err) => message.error(asErrorText(err)),
  });

  const columns: TableColumnsType<AsChannel> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (_v, record) => (
        <Flex vertical>
          <span>{record.name || record.platform_bot_id || record.id}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.id}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: '类型',
      dataIndex: 'channel_type',
      key: 'channel_type',
      width: 120,
      render: (value: string) => <Tag>{value}</Tag>,
    },
    {
      title: '机器人 ID',
      dataIndex: 'platform_bot_id',
      key: 'platform_bot_id',
      width: 160,
      render: (value: string) => value || '—',
    },
    {
      title: '状态',
      key: 'enabled',
      width: 110,
      render: (_v, record) => (
        <Switch
          checked={record.enabled}
          aria-label={`切换渠道 ${record.name || record.id} 的启用状态`}
          loading={toggle.isPending && toggle.variables?.id === record.id}
          onChange={(checked) => toggle.mutate({ id: record.id, enable: checked })}
        />
      ),
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
      render: (_v, record) =>
        narrow ? (
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'sessions', label: '绑定会话', icon: <MessageOutlined /> },
                { type: 'divider' },
                { key: 'delete', label: '删除', icon: <DeleteOutlined />, danger: true },
              ],
              onClick: async ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === 'sessions') {
                  setSessionOf(record);
                  return;
                }
                if (key === 'delete') await remove.mutateAsync(record.id);
              },
            }}
          >
            <Button size="small" icon={<MoreOutlined />} aria-label={`渠道 ${record.name || record.id} 的更多操作`}>
              更多
            </Button>
          </Dropdown>
        ) : (
          <Space size={4}>
            <Button size="small" icon={<MessageOutlined />} onClick={() => setSessionOf(record)}>
              会话
            </Button>
            <Popconfirm
              title="删除该渠道？"
              description="删除后该渠道的路由与凭据引用会一并失效。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => remove.mutateAsync(record.id)}
            >
              <Button size="small" danger icon={<DeleteOutlined />} aria-label={`删除渠道 ${record.name || record.id}`}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ),
    },
  ];

  const sessionChannelId = sessionOf?.id ?? '';

  const sessions = useQuery({
    queryKey: ['as', 'channels', sessionChannelId, 'sessions'],
    queryFn: () => asGet<AsSessionList>('channels', `${sessionChannelId}/sessions`),
    enabled: sessionChannelId !== '',
    staleTime: 30_000,
  });

  return (
    <Flex vertical gap={12}>
      {channels.isLoading ? (
        <AsLoading rows={5} />
      ) : channels.error ? (
        <AsErrorAlert error={channels.error} onRetry={() => void channels.refetch()} />
      ) : (channels.data?.length ?? 0) === 0 ? (
        <AsEmpty
          description="还没有配置任何 IM 渠道"
          action={
            <Button icon={<ReloadOutlined />} onClick={() => void channels.refetch()}>
              刷新渠道列表
            </Button>
          }
        />
      ) : (
        <Table<AsChannel>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={channels.data}
          pagination={false}
          scroll={{ x: 900 }}
        />
      )}

      <Drawer
        title={`绑定会话 · ${sessionOf?.name || sessionOf?.id || ''}`}
        open={sessionChannelId !== ''}
        onClose={() => setSessionOf(null)}
        size={520}
      >
        {sessions.isLoading ? (
          <AsLoading rows={3} />
        ) : sessions.error ? (
          <AsErrorAlert error={sessions.error} onRetry={() => void sessions.refetch()} />
        ) : (sessions.data?.sessions.length ?? 0) === 0 ? (
          <AsEmpty description="该渠道尚未绑定任何会话" />
        ) : (
          <Conversations
            items={(sessions.data?.sessions ?? []).map((session) => ({
              key: session.id,
              label: (
                <Flex vertical>
                  <span>{session.id}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {session.agent_id || '未知助手'} · {formatTime(session.created_at)}
                  </Typography.Text>
                </Flex>
              ),
            }))}
          />
        )}
      </Drawer>
    </Flex>
  );
}
