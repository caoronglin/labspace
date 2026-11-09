/**
 * 磁盘使用率（环形图 + 进度条）
 *
 * 数据源：GET /api/admin/info（管理员）→ disk: { total, used, free }（字节）
 * 字段映射：total → 磁盘总量(GB)，used → 已用(GB)，free → 可用(GB)，used/total → 使用率(%)
 */
import { memo, useMemo } from 'react';
import { Pie } from '@ant-design/plots';
import { useQuery } from '@tanstack/react-query';
import { Progress, Typography } from 'antd';
import { api } from '../../services/api';
import ChartCard from './ChartCard';
import { bytesToGB, useChartPalette, useChartTheme } from './chartTheme';

interface AdminInfoLike {
  disk?: { total?: number; used?: number; free?: number };
}

export interface DiskUsagePanelProps {
  title?: string;
  description?: string;
  height?: number;
}

function DiskUsagePanel({
  title = '磁盘使用率',
  description = '服务器数据盘容量占用情况',
  height = 200,
}: DiskUsagePanelProps) {
  const palette = useChartPalette();
  const chartTheme = useChartTheme();

  const query = useQuery({
    queryKey: ['admin-info-chart'],
    queryFn: api.adminInfo,
    staleTime: 60_000,
  });

  const disk = (query.data as AdminInfoLike | undefined)?.disk;
  const totalBytes = Number(disk?.total ?? 0);
  const usedBytes = Number(disk?.used ?? 0);
  const freeBytes = Number(disk?.free ?? 0);
  const hasData = totalBytes > 0;

  const percent = hasData ? Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100)) : 0;

  const options = useMemo(
    () => ({
      data: [
        { name: '已用', value: bytesToGB(usedBytes) },
        { name: '可用', value: bytesToGB(freeBytes) },
      ],
      angleField: 'value',
      colorField: 'name',
      innerRadius: 0.65,
      theme: chartTheme,
      height,
      scale: {
        color: {
          domain: ['已用', '可用'],
          range: [percent > 85 ? palette.error : palette.primary, palette.textSecondary],
        },
      },
      legend: {
        color: {
          position: 'bottom' as const,
          title: false,
          itemLabelFontSize: 12,
        },
      },
      axis: false,
      tooltip: {
        title: 'name',
        items: [
          {
            channel: 'y',
            name: '容量',
            valueFormatter: (v: number) => `${v} GB`,
          },
        ],
      },
    }),
    [usedBytes, freeBytes, percent, chartTheme, height, palette],
  );

  const table = useMemo(
    () => ({
      columns: [
        { title: '指标', dataIndex: 'metric', key: 'metric' },
        { title: '数值', dataIndex: 'value', key: 'value' },
      ],
      rows: [
        { metric: '磁盘总量', value: `${bytesToGB(totalBytes)} GB` },
        { metric: '已用', value: `${bytesToGB(usedBytes)} GB` },
        { metric: '可用', value: `${bytesToGB(freeBytes)} GB` },
        { metric: '使用率', value: `${percent.toFixed(1)}%` },
      ],
    }),
    [totalBytes, usedBytes, freeBytes, percent],
  );

  return (
    <ChartCard
      title={title}
      description={description}
      loading={query.isPending}
      error={query.isError ? query.error : undefined}
      onRetry={() => void query.refetch()}
      empty={!query.isPending && !query.isError && !hasData}
      table={table}
    >
      <Pie {...options} />
      <Typography.Paragraph style={{ margin: '4px 0 0' }}>
        <Progress
          percent={Number(percent.toFixed(1))}
          strokeColor={percent > 85 ? palette.error : palette.primary}
          railColor={palette.textSecondary}
          size="small"
          format={(p) => `使用率 ${p}%`}
        />
      </Typography.Paragraph>
    </ChartCard>
  );
}

// 图表内部持有 G2 实例，父级 re-render 不应重建
export default memo(DiskUsagePanel);
