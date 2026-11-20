import { Button, Collapse, Flex, Input, InputNumber, Segmented, Select, Space, Tag, Typography } from 'antd';
import type { PlotChart, PlotParamSpec } from '../../services/api';
import { numericColumnsOf, type ParsedTable } from './plotTable';

/**
 * 模板的「基础参数」：只留出图真正必填的列映射，其余（聚合、阈值、色带、尺寸）进高级区。
 * 没有列映射概念的模板（维恩图、系统发育树）退回「前 3 个非标题参数」，
 * 保证基础区永远不超过 3~4 项。
 */
const BASIC_PARAM_KEYS: Record<string, string[]> = {
  bar: ['x', 'y', 'group'],
  line: ['x', 'y', 'group'],
  scatter: ['x', 'y', 'group'],
  box: ['x', 'y', 'group'],
  violin: ['x', 'y', 'group'],
  heatmap: ['x', 'y', 'value'],
  volcano: ['gene', 'x', 'y'],
};

function basicParamKeys(chart?: PlotChart): string[] {
  if (!chart) return [];
  const preferred = BASIC_PARAM_KEYS[chart.id] ?? ['x', 'y', 'group'];
  const hit = chart.params.filter((p) => preferred.includes(p.key)).map((p) => p.key);
  if (hit.length) return hit;
  return chart.params.filter((p) => p.key !== 'title').slice(0, 3).map((p) => p.key);
}

/**
 * 列名联动：按参数语义收窄候选。
 *
 * 选了分类列之后，Y 列还列出所有文本列的话，用户得自己在 30 个选项里
 * 辨认哪个是数值 —— 直接只给数值列，选错的机会就没了。
 */
function columnCandidates(
  spec: PlotParamSpec,
  chartId: string,
  table: ParsedTable,
  numeric: string[],
): string[] | undefined {
  if (spec.type !== 'text') return undefined;
  const numericKeys = ['y', 'value', 'score', 'pos', 'start', 'end'];
  const categoricalKeys = ['group', 'gene', 'chr'];
  const numericOnly = (chartId === 'line' || chartId === 'scatter' || chartId === 'pca') && spec.key === 'x';
  if (numericKeys.includes(spec.key) || numericOnly) {
    return numeric.length ? numeric : table.headers;
  }
  if (categoricalKeys.includes(spec.key)) {
    const categorical = table.headers.filter((h) => !numeric.includes(h));
    return categorical.length ? categorical : table.headers;
  }
  return table.headers;
}

/**
 * 单个参数控件。
 *
 * `columns` 有值时，文本类参数渲染成「列名下拉」而不是自由输入框：
 * 手打列名很容易拼错一个字符、渲染时才报错，下拉里只列真实存在的列就不会错。
 */
function ParamField({
  spec,
  value,
  columns,
  onChange,
}: {
  spec: PlotParamSpec;
  value: unknown;
  columns?: string[];
  onChange: (v: unknown) => void;
}) {
  const label = (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {spec.label}{spec.help ? `（${spec.help}）` : ''}
    </Typography.Text>
  );
  if (spec.type === 'checkbox') {
    return (
      <Flex justify="space-between" align="center" style={{ paddingTop: 20 }}>
        {label}
        <Segmented
          size="small"
          value={value ? 'on' : 'off'}
          onChange={(v) => onChange(v === 'on')}
          options={[{ label: '关', value: 'off' }, { label: '开', value: 'on' }]}
        />
      </Flex>
    );
  }
  if (spec.type === 'select') {
    return (
      <Flex vertical gap={2}>
        {label}
        <Select
          size="small"
          value={value as string | undefined}
          onChange={onChange}
          allowClear
          style={{ width: '100%' }}
          options={(spec.options ?? []).map((o) => ({ value: o, label: o }))}
        />
      </Flex>
    );
  }
  if (spec.type === 'number') {
    return (
      <Flex vertical gap={2}>
        {label}
        <InputNumber
          size="small"
          value={value as number | undefined}
          onChange={(v) => onChange(v ?? undefined)}
          style={{ width: '100%' }}
        />
      </Flex>
    );
  }
  if (spec.type === 'textarea') {
    return (
      <Flex vertical gap={2}>
        {label}
        <Input.TextArea
          rows={4}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
        />
      </Flex>
    );
  }
  return (
    <Flex vertical gap={2}>
      {label}
      {columns ? (
        <Select
          size="small"
          value={(value as string | undefined) ?? undefined}
          onChange={onChange}
          allowClear
          style={{ width: '100%' }}
          placeholder="选择列"
          options={columns.map((c) => ({ value: c, label: c }))}
        />
      ) : (
        <Input
          size="small"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="列名"
        />
      )}
    </Flex>
  );
}

/**
 * 参数区：基础参数（列映射）+ 高级参数与样式（聚合、色板、尺寸）。
 *
 * 参数按两级收进 Collapse：默认只展开基础区，一次调好就不再动的项折起来——
 * 列表全展开正是用户说的「太麻烦」。状态仍由页面持有，这里只负责渲染与回传改动。
 */
export default function ParamPanel({
  chart,
  chartId,
  table,
  values,
  onValueChange,
  palette,
  palettes,
  onPaletteChange,
  size,
  onSizeChange,
  customColors,
  onClearCustomColors,
}: {
  chart?: PlotChart;
  chartId: string;
  table: ParsedTable;
  values: Record<string, unknown>;
  onValueChange: (key: string, value: unknown) => void;
  palette: string;
  palettes: string[];
  onPaletteChange: (palette: string) => void;
  size: { width: number; height: number };
  onSizeChange: (size: { width: number; height: number }) => void;
  customColors: string[];
  onClearCustomColors: () => void;
}) {
  const numericColumns = numericColumnsOf(table);
  const basicKeys = basicParamKeys(chart);
  const basicSpecs = (chart?.params ?? []).filter((spec) => basicKeys.includes(spec.key));
  const advancedSpecs = (chart?.params ?? []).filter((spec) => !basicKeys.includes(spec.key));

  return (
    <Collapse
      size="small"
      defaultActiveKey={['basic']}
      items={[
        {
          key: 'basic',
          label: '基础参数',
          children: basicSpecs.length ? (
            <Flex gap={12} wrap>
              {basicSpecs.map((spec) => (
                <div key={spec.key} style={{ width: 220 }}>
                  <ParamField
                    spec={spec}
                    value={values[spec.key]}
                    columns={columnCandidates(spec, chartId, table, numericColumns)}
                    onChange={(v) => onValueChange(spec.key, v)}
                  />
                </div>
              ))}
            </Flex>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              这个模板不需要列映射，参数都在「高级参数与样式」里。
            </Typography.Text>
          ),
        },
        {
          key: 'advanced',
          label: '高级参数与样式',
          children: (
            <Flex vertical gap={12}>
              {advancedSpecs.length ? (
                <Flex gap={12} wrap>
                  {advancedSpecs.map((spec) => (
                    <div key={spec.key} style={{ width: spec.type === 'textarea' ? '100%' : 220 }}>
                      <ParamField
                        spec={spec}
                        value={values[spec.key]}
                        columns={spec.type === 'text' ? table.headers : undefined}
                        onChange={(v) => onValueChange(spec.key, v)}
                      />
                    </div>
                  ))}
                </Flex>
              ) : null}
              <Flex gap={8} wrap>
                <div style={{ width: 160 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>色板</Typography.Text>
                  <Select
                    value={palette}
                    onChange={onPaletteChange}
                    style={{ width: '100%' }}
                    options={palettes.map((p) => ({ value: p, label: p.toUpperCase() }))}
                  />
                </div>
                <div style={{ width: 88 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>宽 (in)</Typography.Text>
                  <InputNumber
                    min={2}
                    max={20}
                    step={0.5}
                    value={size.width}
                    onChange={(v) => onSizeChange({ ...size, width: Number(v) || 7.2 })}
                    style={{ width: '100%' }}
                  />
                </div>
                <div style={{ width: 88 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>高 (in)</Typography.Text>
                  <InputNumber
                    min={2}
                    max={20}
                    step={0.5}
                    value={size.height}
                    onChange={(v) => onSizeChange({ ...size, height: Number(v) || 4.8 })}
                    style={{ width: '100%' }}
                  />
                </div>
              </Flex>
              {customColors.length > 0 && (
                <Space wrap size={4}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>配色搭配：</Typography.Text>
                  {customColors.map((c) => (
                    <Tag key={c} color={c} style={{ color: '#fff', border: 'none' }}>{c}</Tag>
                  ))}
                  <Button size="small" type="link" onClick={onClearCustomColors}>清除</Button>
                </Space>
              )}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                输出 300 dpi · PNG / SVG / PDF
              </Typography.Text>
            </Flex>
          ),
        },
      ]}
    />
  );
}
