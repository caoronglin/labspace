/**
 * 任务状态分布（环形图）
 *
 * 数据源：GET /api/workbench/summary → today: { tasks, overdue, dueToday, doneToday }
 * 字段映射（基于 today.tasks 的活跃任务做互斥切分 + 本周完成量）：
 *   - 逾期    : 活跃任务中 due_date 早于今天
 *   - 今日到期 : 活跃任务中 due_date 等于今天
 *   - 待办中  : 活跃任务中无截止日期或截止日期晚于今天
 *   - 本周完成 : stats.completedThisWeek
 */
import { memo, useMemo } from 'react';
import { Pie } from '@ant-design/plots';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import ChartCard from './ChartCard';
import { useChartPalette, useChartTheme } from './chartTheme';

export interface TaskStatusDonutProps {
  title?: string;
  description?: string;
  height?: number;
}

function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function TaskStatusDonut({
  title = '任务状态分布',
  description = '按截止日期与完成情况统计我的任务',
  height = 260,
}: TaskStatusDonutProps) {
  const palette = useChartPalette();
  const chartTheme = useChartTheme();

  const query = useQuery({
    queryKey: ['workbench-summary-chart'],
    queryFn: api.workbenchSummary,
    staleTime: 60_000,
  });

  const slices = useMemo(() => {
    const today = todayISO();
    const tasks = query.data?.today?.tasks ?? [];
    let overdue = 0;
    let dueToday = 0;
    let pending = 0;
    for (const task of tasks) {
      const due = task.due_date ? task.due_date.slice(0, 10) : '';
      if (!due) {
        pending += 1;
      } else if (due < today) {
        overdue += 1;
      } else if (due === today) {
        dueToday += 1;
      } else {
        pending += 1;
      }
    }
    const done = query.data?.stats?.completedThisWeek ?? 0;
    const raw = [
      { name: '待办中', value: pending, color: palette.primary },
      { name: '今日到期', value: dueToday, color: palette.warning },
      { name: '逾期', value: overdue, color: palette.error },
      { name: '本周完成', value: done, color: palette.success },
    ];
    return raw.filter((s) => s.value > 0);
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
            name: '任务数',
            valueFormatter: (v: number) => `${v} 条`,
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
        { title: '任务数（条）', dataIndex: 'value', key: 'value' },
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
      description={`${description}，共 ${total} 条`}
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

// 图表内部会 new G2 Chart 实例，父级任何 re-render 都不该重建它
export default memo(TaskStatusDonut);
