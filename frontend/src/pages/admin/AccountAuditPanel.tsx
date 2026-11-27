import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Flex,
  Input,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { DownloadOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { api, type AuditItem } from '../../services/api.ts';

interface Filters {
  actor: string;
  action: string;
  since: string;
  until: string;
}

const EMPTY: Filters = { actor: '', action: '', since: '', until: '' };

export default function AccountAuditPanel() {
  const { message } = App.useApp();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);

  const query = useQuery({
    queryKey: ['admin-audit', filters],
    queryFn: () => api.adminAudit(filters),
    staleTime: 15_000,
  });

  const columns: TableColumnsType<AuditItem> = [
    {
      title: '时间',
      dataIndex: 'created_at',
      width: 180,
      render: (value: string) => new Date(value).toLocaleString('zh-CN'),
    },
    { title: '操作人', dataIndex: 'actor', width: 140, render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
    {
      title: '动作',
      dataIndex: 'action',
      width: 180,
      render: (value: string) => <Tag color={value.includes('failed') || value.includes('blocked') ? 'error' : 'blue'}>{value}</Tag>,
    },
    { title: '目标', dataIndex: 'target', width: 180, ellipsis: true },
    { title: '来源 IP', dataIndex: 'ip', width: 140, render: (value: string) => <Typography.Text code>{value || '-'}</Typography.Text> },
    {
      title: '详情',
      dataIndex: 'detail',
      render: (value: Record<string, unknown>) => (
        <Typography.Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}>
          {JSON.stringify(value, null, 2)}
        </Typography.Paragraph>
      ),
    },
  ];

  const apply = () => {
    const toIso = (value: string) => {
      if (!value) return '';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : date.toISOString();
    };
    const next = {
      actor: draft.actor.trim(),
      action: draft.action.trim(),
      since: toIso(draft.since),
      until: toIso(draft.until),
    };
    setFilters(next);
  };

  const exportCsv = () => {
    const url = api.adminAuditCsvUrl({ ...filters, limit: 5000 });
    const link = document.createElement('a');
    link.href = url;
    link.download = 'labspace-audit.csv';
    link.click();
    message.success('审计导出已开始');
  };

  return (
    <Card
      size="small"
      title="账号与权限审计"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => void query.refetch()}>
            刷新
          </Button>
          <Button icon={<DownloadOutlined />} onClick={exportCsv} disabled={!query.data?.count}>
            导出 CSV
          </Button>
        </Space>
      }
    >
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        记录登录成功/失败/锁定、账号变更、口令重置、组权限与文件授权操作。仅管理员可见。
      </Typography.Text>
      <Flex wrap gap={8} style={{ marginBottom: 12 }}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="操作人"
          value={draft.actor}
          onChange={(event) => setDraft((prev) => ({ ...prev, actor: event.target.value }))}
          onPressEnter={apply}
          style={{ width: 160 }}
        />
        <Input
          allowClear
          placeholder="动作前缀，如 auth.login"
          value={draft.action}
          onChange={(event) => setDraft((prev) => ({ ...prev, action: event.target.value }))}
          onPressEnter={apply}
          style={{ width: 220 }}
        />
        <Input
          type="datetime-local"
          value={draft.since}
          onChange={(event) => setDraft((prev) => ({ ...prev, since: event.target.value }))}
          style={{ width: 210 }}
        />
        <Input
          type="datetime-local"
          value={draft.until}
          onChange={(event) => setDraft((prev) => ({ ...prev, until: event.target.value }))}
          style={{ width: 210 }}
        />
        <Button type="primary" onClick={apply}>查询</Button>
        <Button onClick={() => { setDraft(EMPTY); setFilters(EMPTY); }}>重置</Button>
      </Flex>
      {query.isError ? (
        <Alert type="error" showIcon title="审计加载失败" description={query.error instanceof Error ? query.error.message : '请稍后重试'} />
      ) : (
        <Table<AuditItem>
          rowKey="id"
          size="small"
          loading={query.isLoading}
          columns={columns}
          dataSource={query.data?.items ?? []}
          scroll={{ x: 1000 }}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 条` }}
          locale={{ emptyText: '当前筛选下没有审计记录' }}
        />
      )}
    </Card>
  );
}
