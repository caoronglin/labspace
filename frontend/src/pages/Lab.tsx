import { Badge, Tabs } from 'antd';
import { InboxOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useSearchParams } from 'react-router-dom';
import PageShell from '../components/PageShell';
import { api } from '../services/api';
import InventoryPanel from './lab/InventoryPanel';
import PipelinePanel from './lab/PipelinePanel';

export default function Lab() {
  const [params, setParams] = useSearchParams();
  if (params.get('tab') === 'bookings') return <Navigate to="/agent?mode=lab" replace />;
  if (params.get('tab') === 'eln') return <Navigate to="/workbench?tab=records" replace />;
  const tab = params.get('tab') || 'inventory';
  const low = useQuery({ queryKey: ['labops', 'inventory-low'], queryFn: api.labopsLowStock });
  const jobs = useQuery({
    queryKey: ['labops', 'jobs'],
    queryFn: api.labopsJobs,
    refetchInterval: 10000,
  });
  const running = (jobs.data?.items ?? []).filter((j) => ['queued', 'running', 'cancelling'].includes(j.status)).length;
  const lowCount = low.data?.count ?? 0;

  return (
    <PageShell
      title="实验室中心"
      description="样品库存 · 生信流水线（实验记录已并入个人工作台）"
    >
      <Tabs
        activeKey={tab}
        onChange={(key) => setParams(key === 'inventory' ? {} : { tab: key }, { replace: true })}
        destroyOnHidden={false}
        items={[
          {
            key: 'inventory',
            label: (
              <span>
                <InboxOutlined /> 库存台账
                {lowCount > 0 && <Badge count={lowCount} size="small" style={{ marginLeft: 6 }} />}
              </span>
            ),
            children: <InventoryPanel />,
          },
          {
            key: 'pipelines',
            label: (
              <span>
                <PlayCircleOutlined /> 流水线
                {running > 0 && <Badge count={running} size="small" style={{ marginLeft: 6 }} />}
              </span>
            ),
            children: <PipelinePanel />,
          },
        ]}
      />
    </PageShell>
  );
}