import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Flex,
  Grid,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { CloudDownloadOutlined, DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { asDelete, asGet, asList, asPatch, asPost } from '../../../services/agentscope';
import type {
  AsHubInfo,
  AsMcpCard,
  AsMcpHubPage,
  AsMcpView,
  AsSkillCard,
  AsSkillHubPage,
  AsSkillView,
} from '../../../services/agentscope';
import { useAuth } from '../../../app/AuthContext';
import { AsEmpty, AsErrorAlert, AsLoading, asErrorText } from './common';

const MCP_KEY = ['as', 'mcp'] as const;
const SKILL_KEY = ['as', 'skill'] as const;

/** 能力市场卡片（MCP 与技能共用的展示形状）。 */
interface HubCardRow {
  hub_id: string;
  id: string;
  name: string;
  display_name?: string | null;
  description?: string;
  tags?: string[];
}

function toHubCard(card: AsMcpCard | AsSkillCard): HubCardRow {
  return {
    hub_id: card.hub_id,
    id: card.id,
    name: card.name,
    display_name: card.display_name,
    description: card.description,
    tags: card.tags,
  };
}

/** 技能 / MCP：能力市场（hub）+ 已安装 MCP + 已安装技能。 */
export default function HubTab() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { isAdmin } = useAuth();
  const screens = Grid.useBreakpoint();
  const narrow = !screens.md;
  const [kind, setKind] = useState<'mcp' | 'skill'>('mcp');
  const [hubId, setHubId] = useState('');

  const hubs = useQuery({
    queryKey: ['as', 'hub', kind],
    queryFn: () => asList<AsHubInfo[]>('hub', kind),
    staleTime: 30_000,
  });

  const effectiveHub = hubId || hubs.data?.[0]?.hub_id || '';

  const cards = useQuery({
    queryKey: ['as', 'hub', kind, effectiveHub, 'cards'],
    queryFn: async () => {
      if (kind === 'mcp') {
        const page = await asGet<AsMcpHubPage>('hub', `mcp/${effectiveHub}/cards`);
        return page.cards.map(toHubCard);
      }
      const page = await asGet<AsSkillHubPage>('hub', `skill/${effectiveHub}/cards`);
      return page.cards.map(toHubCard);
    },
    enabled: effectiveHub !== '',
    staleTime: 30_000,
  });

  const installedMcp = useQuery({
    queryKey: MCP_KEY,
    queryFn: () => asList<AsMcpView[]>('mcp'),
    staleTime: 30_000,
  });

  const installedSkill = useQuery({
    queryKey: SKILL_KEY,
    queryFn: () => asList<AsSkillView[]>('skill'),
    staleTime: 30_000,
  });

  const install = useMutation({
    mutationFn: (v: { cardId: string }) =>
      kind === 'mcp'
        ? asPost('hub', `mcp/${effectiveHub}/cards/${v.cardId}/install`)
        : asPost('hub', `skill/${effectiveHub}/cards/${v.cardId}/install`),
    onSuccess: () => {
      message.success('已安装到我的能力库');
      void qc.invalidateQueries({ queryKey: MCP_KEY });
      void qc.invalidateQueries({ queryKey: SKILL_KEY });
    },
    onError: (err) => message.error(asErrorText(err)),
  });

  const toggleMcp = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => asPatch('mcp', v.id, { enabled: v.enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: MCP_KEY }),
    onError: (err) => message.error(asErrorText(err)),
  });

  const toggleSkill = useMutation({
    // AgentScope 2.0.11 只提供 GET/DELETE /skill/{id}（上游对 PATCH 返回 405），
    // 这里仍然按统一契约发起 PATCH，失败时把上游原因原样告诉用户。
    mutationFn: (v: { id: string; enabled: boolean }) => asPatch('skill', v.id, { enabled: v.enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: SKILL_KEY }),
    onError: (err) => message.error(asErrorText(err)),
  });

  const removeMcp = useMutation({
    mutationFn: (id: string) => asDelete('mcp', id),
    onSuccess: () => {
      message.success('MCP 已移除');
      void qc.invalidateQueries({ queryKey: MCP_KEY });
    },
    onError: (err) => message.error(asErrorText(err)),
  });

  const removeSkill = useMutation({
    mutationFn: (id: string) => asDelete('skill', id),
    onSuccess: () => {
      message.success('技能已移除');
      void qc.invalidateQueries({ queryKey: SKILL_KEY });
    },
    onError: (err) => message.error(asErrorText(err)),
  });

  const mcpColumns: TableColumnsType<AsMcpView> = [
    {
      title: '名称',
      key: 'name',
      render: (_v, record) => (
        <Flex vertical>
          <span>{record.display_name || record.name}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.name}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      render: (value: string | undefined) => value || '—',
    },
    {
      title: '类型',
      key: 'is_stateful',
      width: 100,
      render: (_v, record) => <Tag>{record.is_stateful ? '有状态' : '无状态'}</Tag>,
    },
    {
      title: '启用',
      key: 'enabled',
      width: 100,
      render: (_v, record) => (
        <Switch
          checked={record.enabled}
          aria-label={`切换 MCP ${record.name} 的启用状态`}
          loading={toggleMcp.isPending && toggleMcp.variables?.id === record.id}
          onChange={(checked) => toggleMcp.mutate({ id: record.id, enabled: checked })}
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_v, record) => (
        <Popconfirm
          title="移除该 MCP？"
          okText="移除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => removeMcp.mutateAsync(record.id)}
        >
          <Button size="small" danger icon={<DeleteOutlined />} aria-label={`移除 MCP ${record.name}`}>
            移除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const skillColumns: TableColumnsType<AsSkillView> = [
    {
      title: '名称',
      key: 'name',
      render: (_v, record) => (
        <Flex vertical>
          <span>{record.display_name || record.name}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.name}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      render: (value: string | undefined) => value || '—',
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
      width: 110,
      render: (value: string | undefined) => value || '—',
    },
    {
      title: '启用',
      key: 'enabled',
      width: 100,
      render: (_v, record) => (
        <Switch
          checked={record.enabled}
          aria-label={`切换技能 ${record.name} 的启用状态`}
          loading={toggleSkill.isPending && toggleSkill.variables?.id === record.id}
          onChange={(checked) => toggleSkill.mutate({ id: record.id, enabled: checked })}
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_v, record) => (
        <Popconfirm
          title="移除该技能？"
          okText="移除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => removeSkill.mutateAsync(record.id)}
        >
          <Button size="small" danger icon={<DeleteOutlined />} aria-label={`移除技能 ${record.name}`}>
            移除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const cardRows = cards.data ?? [];

  return (
    <Flex vertical gap={16}>
      <Card size="small" title="能力市场（Hub）">
        <Flex vertical gap={12}>
          <Flex gap={8} wrap align="center">
            <Segmented
              value={kind}
              onChange={(value) => {
                setKind(value as 'mcp' | 'skill');
                setHubId('');
              }}
              options={[
                { value: 'mcp', label: 'MCP' },
                { value: 'skill', label: '技能' },
              ]}
            />
            <Select
              style={{ minWidth: 240 }}
              placeholder="选择 Hub"
              aria-label="选择能力市场"
              value={effectiveHub || undefined}
              onChange={setHubId}
              options={(hubs.data ?? []).map((hub) => ({
                value: hub.hub_id,
                label: hub.display_name || hub.hub_id,
              }))}
              notFoundContent={hubs.error ? 'Hub 列表不可用' : '没有可用的 Hub'}
            />
          </Flex>

          {hubs.isLoading ? (
            <AsLoading rows={3} />
          ) : hubs.error ? (
            <AsErrorAlert error={hubs.error} onRetry={() => void hubs.refetch()} />
          ) : (hubs.data?.length ?? 0) === 0 ? (
            <AsEmpty description="没有配置任何能力市场" />
          ) : cards.isLoading ? (
            <AsLoading rows={3} />
          ) : cards.error ? (
            <AsErrorAlert error={cards.error} onRetry={() => void cards.refetch()} />
          ) : cardRows.length === 0 ? (
            <AsEmpty description="该市场里还没有卡片" />
          ) : (
            <Table<HubCardRow>
              rowKey={(row) => `${row.hub_id}/${row.id || row.name}`}
              size="small"
              pagination={false}
              scroll={{ x: 700 }}
              dataSource={cardRows}
              columns={[
                {
                  title: '名称',
                  key: 'name',
                  render: (_v, row) => (
                    <Flex vertical>
                      <span>{row.display_name || row.name}</span>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {row.description || row.name}
                      </Typography.Text>
                    </Flex>
                  ),
                },
                {
                  title: '标签',
                  key: 'tags',
                  width: 200,
                  render: (_v, row) => (
                    <Space size={4} wrap>
                      {(row.tags ?? []).length === 0 ? (
                        '—'
                      ) : (
                        (row.tags ?? []).map((tag) => <Tag key={tag}>{tag}</Tag>)
                      )}
                    </Space>
                  ),
                },
                {
                  title: '操作',
                  key: 'actions',
                  width: 110,
                  render: (_v, row) =>
                    isAdmin ? (
                      <Button
                        size="small"
                        icon={<CloudDownloadOutlined />}
                        aria-label={`安装 ${row.display_name || row.name}`}
                        loading={install.isPending && install.variables?.cardId === (row.id || row.name)}
                        onClick={() => install.mutate({ cardId: row.id || row.name })}
                      >
                        安装
                      </Button>
                    ) : (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        仅管理员可安装
                      </Typography.Text>
                    ),
                },
              ]}
            />
          )}
        </Flex>
      </Card>

      <Card size="small" title="已安装 MCP">
        {installedMcp.isLoading ? (
          <AsLoading rows={3} />
        ) : installedMcp.error ? (
          <AsErrorAlert error={installedMcp.error} onRetry={() => void installedMcp.refetch()} />
        ) : (installedMcp.data?.length ?? 0) === 0 ? (
          <AsEmpty description="还没有安装任何 MCP" />
        ) : (
          <Table<AsMcpView>
            rowKey="id"
            size="small"
            columns={mcpColumns}
            dataSource={installedMcp.data ?? []}
            pagination={false}
            scroll={{ x: narrow ? 700 : 900 }}
          />
        )}
      </Card>

      <Card size="small" title="已安装技能">
        {installedSkill.isLoading ? (
          <AsLoading rows={3} />
        ) : installedSkill.error ? (
          <AsErrorAlert error={installedSkill.error} onRetry={() => void installedSkill.refetch()} />
        ) : (installedSkill.data?.length ?? 0) === 0 ? (
          <AsEmpty description="还没有安装任何技能" />
        ) : (
          <Table<AsSkillView>
            rowKey="id"
            size="small"
            columns={skillColumns}
            dataSource={installedSkill.data ?? []}
            pagination={false}
            scroll={{ x: narrow ? 700 : 900 }}
          />
        )}
      </Card>
    </Flex>
  );
}
