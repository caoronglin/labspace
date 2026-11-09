/**
 * 天气趋势图：未来 7 天最高/最低气温折线 + 降水概率柱状图
 *
 * 数据源：GET /api/weather 的 daily[]，无额外请求。
 */
import { memo, useMemo } from 'react';
import { Col, Row } from 'antd';
import { Column, Line } from '@ant-design/plots';
import type { WeatherReport } from '../../services/api';
import ChartCard from './ChartCard';
import { useChartPalette, useChartTheme } from './chartTheme';

const shortDate = (date: string) => date.slice(5);

function WeatherTrendChart({ daily }: { daily: WeatherReport['daily'] }) {
  const palette = useChartPalette();
  const chartTheme = useChartTheme();

  const tempRows = useMemo(
    () =>
      daily.flatMap((d) => {
        const date = shortDate(d.date);
        const rows: { date: string; temp: number; kind: string }[] = [];
        if (d.max != null) rows.push({ date, temp: Math.round(d.max * 10) / 10, kind: '最高气温' });
        if (d.min != null) rows.push({ date, temp: Math.round(d.min * 10) / 10, kind: '最低气温' });
        return rows;
      }),
    [daily],
  );

  const rainRows = useMemo(
    () =>
      daily.map((d) => ({
        date: shortDate(d.date),
        probability: d.precipitationProbability ?? 0,
        precipitation: d.precipitation ?? 0,
      })),
    [daily],
  );

  const tempOptions = useMemo(
    () => ({
      data: tempRows,
      xField: 'date',
      yField: 'temp',
      colorField: 'kind',
      theme: chartTheme,
      height: 240,
      scale: {
        color: {
          domain: ['最高气温', '最低气温'],
          range: [palette.warning, palette.primary],
        },
      },
      axis: {
        x: { title: false, labelAutoRotate: false },
        y: { title: '温度（℃）' },
      },
      style: { lineWidth: 2 },
      point: { shapeField: 'circle', sizeField: 4 },
      legend: { color: { position: 'top' as const, title: false } },
      tooltip: {
        title: 'date',
        items: [
          {
            channel: 'y',
            name: '温度',
            valueFormatter: (v: number) => `${v}℃`,
          },
        ],
      },
    }),
    [tempRows, chartTheme, palette],
  );

  const rainOptions = useMemo(
    () => ({
      data: rainRows,
      xField: 'date',
      yField: 'probability',
      theme: chartTheme,
      height: 240,
      scale: { y: { domain: [0, 100] } },
      style: { fill: palette.accent, radiusTopLeft: 4, radiusTopRight: 4 },
      axis: {
        x: { title: false, labelAutoRotate: false },
        y: { title: '降水概率（%）' },
      },
      label: {
        text: 'probability',
        position: 'top' as const,
        style: { fill: palette.textSecondary, fontSize: 11 },
      },
      tooltip: {
        title: 'date',
        items: [
          {
            field: 'probability',
            name: '降水概率',
            valueFormatter: (v: number) => `${v}%`,
          },
          {
            field: 'precipitation',
            name: '降水量',
            valueFormatter: (v: number) => `${v} mm`,
          },
        ],
      },
    }),
    [rainRows, chartTheme, palette],
  );

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={12}>
        <ChartCard title="气温趋势" description="未来 7 天最高与最低气温变化">
          {tempRows.length > 0 ? <Line {...tempOptions} /> : null}
        </ChartCard>
      </Col>
      <Col xs={24} xl={12}>
        <ChartCard title="降水概率" description="未来 7 天降水概率与预计降水量">
          {rainRows.length > 0 ? <Column {...rainOptions} /> : null}
        </ChartCard>
      </Col>
    </Row>
  );
}

export default memo(WeatherTrendChart);
