import { useMemo, type ReactNode } from 'react';
import { Alert, Card, Col, Row, Skeleton, Statistic, Tabs, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { asList } from '../../../services/agentscope';
import type {
  AsChannel,
  AsKnowledgeBaseList,
  AsScheduleList,
  AsSopList,
} from '../../../services/agentscope';
import PageShell from '../../../components/PageShell';
import { useAuth } from '../../../app/AuthContext';
import ChannelsTab from './ChannelsTab';
import ScheduleTab from './ScheduleTab';
import SopTab from './SopTab';
import WorkspaceTab from './WorkspaceTab';
import HubTab from './HubTab';
import { asErrorText } from './common';

/**
 * 单个统计卡：各自独立加载，互不阻塞。
 *
 * 某个能力组挂了只影响自己这张卡（显示「不可用 + 原因」），其余三张照常出数。
 */
function StatCard({
  title,
  value,
  loading,
  error,
  onRetry,
}: {
  title: string;
  value: number | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <Card size="small">
        <Skeleton active title={false} paragraph={{ rows: 1 }} />
      </Card>
    );
  }
  return (
    <Card size="small">
      <Statistic title={title} value={error ? '—' : (value ?? 0)} />
      {error ? (
        <Typography.Text
          type="secondary"
          style={{ fontSize: 12 }}
          title={asErrorText(error)}
          // 原因可能很长，超过两行就截断，完整内容在 title 里
          ellipsis={{ tooltip: asErrorText(error) }}
        >
          该能力暂不可用：{asErrorText(error)}
        </Typography.Text>
      ) : null}
      {error ? (
        <Typography.Link onClick={onRetry} style={{ fontSize: 12 }}>
          重试
        </Typography.Link>
      ) : null}
    </Card>
  );
}

/** 能力中心：把 AgentScope 的能力按门户鉴权暴露出来。 */
export default function AgentHub({ embedded = false, extra }: { embedded?: boolean; extra?: ReactNode }) {
  const channels = useQuery({
    queryKey: ['as', 'channels'],
    queryFn: () => asList<AsChannel[]>('channels'),
    staleTime: 30_000,
  });
  const schedules = useQuery({
    queryKey: ['as', 'schedule'],
    queryFn: () => asList<AsScheduleList>('schedule'),
    staleTime: 30_000,
  });
  const bases = useQuery({
    queryKey: ['as', 'knowledge_bases'],
    queryFn: () => asList<AsKnowledgeBaseList>('knowledge_bases'),
    staleTime: 30_000,
  });
  const sops = useQuery({
    queryKey: ['as', 'sop'],
    queryFn: () => asList<AsSopList>('sop'),
    staleTime: 30_000,
  });

  /**
   * 能力中心页签按身份分档。
   *
   * IM 渠道 / 定时任务 / SOP / 工作区都是**管理员配置面**：
   * 普通成员打开只会看到一堆自己不负责的开关，既看不懂也不知道该该动。
   * 知识库问答与长期记忆已合并到 Agent 的「知识与记忆」入口，
   * 能力中心只保留技能 / MCP 与管理员能力，避免同一功能两处维护。
   */
  const { isAdmin, isSuperAdmin } = useAuth();
  const canAdmin = isAdmin || isSuperAdmin;
  const tabs = useMemo(() => {
    const all = [
      { key: 'channels', label: 'IM 渠道', children: <ChannelsTab />, adminOnly: true },
      { key: 'schedule', label: '定时任务', children: <ScheduleTab />, adminOnly: true },
      { key: 'sop', label: 'SOP 工作流', children: <SopTab />, adminOnly: true },
      { key: 'workspace', label: '工作区', children: <WorkspaceTab />, adminOnly: true },
      {
        key: 'hub',
        label: '技能 / MCP',
        children: <HubTab />,
        adminOnly: false,
      },
    ];
    return all
      .filter((t) => canAdmin || !t.adminOnly)
      .map(({ adminOnly: _adminOnly, ...rest }) => rest);
  }, [canAdmin]);

  return (
    <PageShell
      embedded={embedded}
      title="能力中心"
      description="AgentScope 的原生能力在这里按门户会话鉴权后展示：渠道、定时任务、SOP、工作区与技能 / MCP。"
      extra={extra}
    >
      <Alert
        type="info"
        showIcon
        title="这些能力由 AgentScope 2.0.12 原生提供，门户只做鉴权与展示。"
        description="所有请求都经门户后端 /api/agent/as 受控代理转发，能力组在白名单内、身份固定为当前登录用户；上游不可用时这里会显示原因，不会用占位数据填充。"
      />

      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}>
          <StatCard
            title="渠道数"
            value={channels.data?.length}
            loading={channels.isLoading}
            error={channels.error}
            onRetry={() => void channels.refetch()}
          />
        </Col>
        <Col xs={12} md={6}>
          <StatCard
            title="定时任务数"
            value={schedules.data?.total}
            loading={schedules.isLoading}
            error={schedules.error}
            onRetry={() => void schedules.refetch()}
          />
        </Col>
        <Col xs={12} md={6}>
          <StatCard
            title="知识库数"
            value={bases.data?.total}
            loading={bases.isLoading}
            error={bases.error}
            onRetry={() => void bases.refetch()}
          />
        </Col>
        <Col xs={12} md={6}>
          <StatCard
            title="SOP 数"
            value={sops.data?.total}
            loading={sops.isLoading}
            error={sops.error}
            onRetry={() => void sops.refetch()}
          />
        </Col>
      </Row>

      <Tabs defaultActiveKey={canAdmin ? 'channels' : 'hub'} items={tabs} />
    </PageShell>
  );
}
