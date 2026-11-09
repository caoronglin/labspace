/**
 * 数据库分类分布（横向条形图）
 *
 * 数据源：GET /api/databases → { total, matched, categories, items:[{category,...}] }
 * 字段映射：items[].category → 分类名称；按分类聚合计数 → 条形长度
 */
import { memo, useMemo } from 'react';
import { Bar } from '@ant-design/plots';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import ChartCard from './ChartCard';
import { useChartPalette, useChartTheme } from './chartTheme';

export interface DatabaseCategoryBarProps {
  title?: string;
  description?: string;
  height?: number;
}

function DatabaseCategoryBar({
  title = '数据库分类分布',
  description = '统计各分类下已收录的数据资源数量',
  height = 320,
}: DatabaseCategoryBarProps) {
  const palette = useChartPalette();
  const chartTheme = useChartTheme();

  const query = useQuery({
    queryKey: ['database-category-chart'],
    queryFn: () => api.databases(),
    staleTime: 5 * 60_000,
  });

  const rows = useMemo(() => {
    const items = query.data?.items ?? [];
    const counts = new Map<string, number>();
    for (const item of items) {
      const key = item.category || '未分类';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);
  }, [query.data]);

  const total = rows.reduce((acc, r) => acc + r.count, 0);

  const options = useMemo(
    () => ({
      data: rows,
      xField: 'category',
      yField: 'count',
      transpose: true,
      theme: chartTheme,
      height,
      style: {
        fill: palette.primary,
      },
      axis: {
        x: {
          title: '数据库分类',
          labelAutoHide: false,
          labelAutoRotate: false,
        },
        y: {
          title: '资源数量（个）',
        },
      },
      label: {
        text: 'count',
        position: 'inside',
        offset: 2,
        style: { fill: '#FFFFFF', fontSize: 11, fontWeight: 500 },
      },
      tooltip: {
        title: 'category',
        items: [
          {
            channel: 'y',
            name: '资源数量',
            valueFormatter: (v: number) => `${v} 个`,
          },
        ],
      },
    }),
    [rows, chartTheme, height, palette],
  );

  const table = useMemo(
    () => ({
      columns: [
        { title: '分类', dataIndex: 'category', key: 'category' },
        { title: '资源数量（个）', dataIndex: 'count', key: 'count' },
        {
          title: '占比（%）',
          dataIndex: 'percent',
          key: 'percent',
          render: (v: number) => v.toFixed(1),
        },
      ],
      rows: rows.map((r) => ({
        category: r.category,
        count: r.count,
        percent: total ? (r.count / total) * 100 : 0,
      })),
    }),
    [rows, total],
  );

  return (
    <ChartCard
      title={title}
      description={`${description}，共 ${total} 个资源`}
      loading={query.isPending}
      error={query.isError ? query.error : undefined}
      onRetry={() => void query.refetch()}
      empty={!query.isPending && !query.isError && rows.length === 0}
      table={table}
    >
      <Bar {...options} />
    </ChartCard>
  );
}

// 图表内部持有 G2 实例，父级 re-render 不应重建
export default memo(DatabaseCategoryBar);
