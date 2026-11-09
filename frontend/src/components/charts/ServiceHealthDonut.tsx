/**
 * 服务健康分布（环形图）
 *
 * 数据源：
 * - source='public' → GET /api/services/health （门户公开接口）
 * - source='admin'  → GET /api/admin/health （管理员接口）
 *
 * 字段映射：services[].health.status ∈ up / down / external-down / unknown
 *          → 正常 / 异常 / 外部依赖不可用 / 未知
 */
import { memo, useMemo } from 'react';
import { Pie } from '@ant-design/plots';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import ChartCard from './ChartCard';
import { useChartPalette, useChartTheme } from './chartTheme';

export type HealthSource = 'public' | 'admin';

interface StatusSlice {
  name: string;
  value: number;
  color: string;
}

const STATUS_META: Record<string, { label: string; colorKey: 'success' | 'error' | 'warning' | 'muted' }> = {
  up: { label: '正常', colorKey: 'success' },
  down: { label: '异常', colorKey: 'error' },
  'external-down': { label: '外部依赖不可用', colorKey: 'warning' },
  unknown: { label: '未知', colorKey: 'muted' },
};

/** 状态展示顺序：正常 → 异常 → 外部依赖不可用 → 未知 */
const STATUS_ORDER = ['up', 'down', 'external-down', 'unknown'];

export interface ServiceHealthDonutProps {
  /** 数据来源 */
  source?: HealthSource;
  title?: string;
  description?: string;
  height?: number;
}

function ServiceHealthDonut({
  source = 'public',
  title = '服务健康分布',
  description = '按健康探测结果统计各状态的服务数量',
  height = 260,
}: ServiceHealthDonutProps) {
  const palette = useChartPalette();
  const chartTheme = useChartTheme();

  const query = useQuery({
    queryKey: ['service-health-chart', source],
    queryFn: source === 'admin' ? api.adminHealth : api.servicesHealth,
    refetchInterval: 60_000,
  });

  const slices = useMemo<StatusSlice[]>(() => {
    const services = query.data?.services ?? [];
    const counts = new Map<string, number>();
    for (const svc of services) {
      const raw = (svc.health?.status ?? 'unknown').toLowerCase();
      const key = STATUS_META[raw] ? raw : 'unknown';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return STATUS_ORDER.filter((k) => (counts.get(k) ?? 0) > 0).map((k) => {
      const meta = STATUS_META[k];
      const color =
        meta.colorKey === 'muted' ? palette.textSecondary : palette[meta.colorKey];
      return { name: meta.label, value: counts.get(k) ?? 0, color };
    });
  }, [query.data, palette]);

  const total = slices.reduce((acc, s) => acc + s.value, 0);

  const options = useMemo(
    () => ({
      data: slices.map((s) => ({ name: s.name, value: s.value })),
      angleField: 'value',
      colorField: 'name',
      innerRadius: 0.6,
      theme: chartTheme,
      height,
      scale: {
        color: {
          domain: slices.map((s) => s.name),
          range: slices.map((s) => s.color),
        },
      },
      legend: {
        color: {
          position: 'right' as const,
          title: false,
          itemLabelFontSize: 12,
        },
      },
      axis: false,
      label: {
        text: 'value',
        position: 'inside',
        style: { fill: '#FFFFFF', fontSize: 12, fontWeight: 500 },
      },
      tooltip: {
        title: 'name',
        items: [
          {
            channel: 'y',
            name: '服务数',
            valueFormatter: (v: number) => `${v} 个`,
          },
        ],
      },
    }),
    [slices, chartTheme, height],
  );

  const table = useMemo(
    () => ({
      columns: [
        { title: '状态', dataIndex: 'name', key: 'name' },
        { title: '服务数（个）', dataIndex: 'value', key: 'value' },
        {
          title: '占比（%）',
          dataIndex: 'percent',
          key: 'percent',
          render: (v: number) => v.toFixed(1),
        },
      ],
      rows: slices.map((s) => ({
        name: s.name,
        value: s.value,
        percent: total ? (s.value / total) * 100 : 0,
      })),
    }),
    [slices, total],
  );

  return (
    <ChartCard
      title={title}
      description={`${description}，共 ${total} 个服务`}
      loading={query.isPending}
      error={query.isError ? query.error : undefined}
      onRetry={() => void query.refetch()}
      empty={!query.isPending && !query.isError && slices.length === 0}
      table={table}
    >
      <Pie {...options} />
    </ChartCard>
  );
}

// 图表内部持有 G2 实例，父级 re-render 不应重建
export default memo(ServiceHealthDonut);
