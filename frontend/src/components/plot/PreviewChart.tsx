import { Button, Empty, Space, Typography } from 'antd';
import { BarChartOutlined } from '@ant-design/icons';
import { Box, Column, Heatmap, Line, Scatter } from '@ant-design/plots';
import { toNumber, type ParsedTable } from './plotTable';

/**
 * 浏览器内 AntV 实时预览。
 *
 * 只负责「按模板把表格画出来」：模板不支持或数据不足时给一句说明并引导到服务端成品，
 * 不在这里做提交、不碰参数表单。
 */
export default function PreviewChart({
  chartId,
  table,
  values,
}: {
  chartId: string;
  table: ParsedTable;
  values: Record<string, unknown>;
}) {
  if (!table.rows.length) {
    return <Empty description="粘贴或上传数据后显示实时预览" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  const { headers, rows } = table;
  const pick = (key: string, fallback?: string) => {
    const v = values[key];
    return typeof v === 'string' && v ? v : fallback;
  };
  const x = pick('x', headers[0]);
  const y = pick('y', headers[1]);
  const group = pick('group');

  if (chartId === 'tree') {
    return <Empty description="树图需服务端渲染，点击「渲染并保存」" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  if (chartId === 'bar' && x && y) {
    const grouped = new Map<string, { x: string; y: number; group?: string; sum: number; n: number }>();
    rows.forEach((r) => {
      const key = `${r[x]}|${group ? r[group] : ''}`;
      const item = grouped.get(key) ?? { x: r[x], y: 0, group: group ? r[group] : undefined, sum: 0, n: 0 };
      item.sum += toNumber(r[y]);
      item.n += 1;
      grouped.set(key, item);
    });
    const data = [...grouped.values()].map((i) => ({ ...i, y: i.sum / i.n }));
    return (
      <Column
        data={data}
        xField="x"
        yField="y"
        colorField={group ? 'group' : undefined}
        group={Boolean(group)}
        height={420}
        axis={{ y: { title: y } }}
      />
    );
  }
  if (chartId === 'line' && x && y) {
    return (
      <Line
        data={rows.map((r) => ({ x: r[x], y: toNumber(r[y]), group: group ? r[group] : '' }))}
        xField="x"
        yField="y"
        colorField={group ? 'group' : undefined}
        height={420}
      />
    );
  }
  if (chartId === 'scatter' && x && y) {
    return (
      <Scatter
        data={rows.map((r) => ({ x: toNumber(r[x]), y: toNumber(r[y]), group: group ? r[group] : '' }))}
        xField="x"
        yField="y"
        colorField={group ? 'group' : undefined}
        height={420}
      />
    );
  }
  if ((chartId === 'box' || chartId === 'violin') && x && y) {
    return (
      <Box
        data={rows.map((r) => ({ x: r[x], y: toNumber(r[y]), group: group ? r[group] : '' }))}
        xField="x"
        yField="y"
        colorField={group ? 'group' : undefined}
        height={420}
      />
    );
  }
  if (chartId === 'heatmap') {
    const lx = pick('x');
    const ly = pick('y');
    const lv = pick('value');
    let data: { x: string; y: string; value: number }[] = [];
    if (lx && ly && lv) {
      data = rows.map((r) => ({ x: r[lx], y: r[ly], value: toNumber(r[lv]) }));
    } else {
      const cols = headers.slice(1);
      data = rows.flatMap((r) => cols.map((c) => ({ x: c, y: r[headers[0]], value: toNumber(r[c]) })));
    }
    return (
      <Heatmap
        data={data}
        xField="x"
        yField="y"
        colorField="value"
        height={420}
        style={{ stroke: '#fff', lineWidth: 1 }}
      />
    );
  }
  if (chartId === 'volcano' && rows.length) {
    const gx = pick('x', 'log2fc');
    const gy = pick('y', 'padj');
    if (gx && gy) {
      return (
        <Scatter
          data={rows.map((r) => ({ x: toNumber(r[gx]), y: -Math.log10(Math.max(toNumber(r[gy]), 1e-300)) }))}
          xField="x"
          yField="y"
          height={420}
          axis={{ x: { title: 'log2FC' }, y: { title: '-log10(p)' } }}
        />
      );
    }
  }
  if (chartId === 'pca') {
    const numeric = headers.filter((h) => rows.every((r) => r[h] !== '' && Number.isFinite(Number(r[h]))));
    if (numeric.length >= 2) {
      return (
        <Scatter
          data={rows.map((r) => ({
            x: toNumber(r[numeric[0]]),
            y: toNumber(r[numeric[1]]),
            group: values.group ? r[String(values.group)] : '',
          }))}
          xField="x"
          yField="y"
          colorField="group"
          height={420}
          axis={{ x: { title: numeric[0] }, y: { title: numeric[1] } }}
        />
      );
    }
  }
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={(
        <Space orientation="vertical" size={2}>
          <span>{chartId} 模板暂不支持浏览器内预览</span>
          <Typography.Text type="secondary">提交后可在「服务端成品」查看出版级图像</Typography.Text>
        </Space>
      )}
    >
      <Button type="primary" icon={<BarChartOutlined />} onClick={() => window.scrollTo({ top: 0 })}>
        查看服务端结果
      </Button>
    </Empty>
  );
}
