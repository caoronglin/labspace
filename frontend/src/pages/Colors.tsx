import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  ColorPicker,
  Empty,
  Flex,
  Input,
  Pagination,
  Row,
  Segmented,
  Select,
  Slider,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import {
  BarChartOutlined,
  BgColorsOutlined,
  CopyOutlined,
  ExperimentOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SwapRightOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { api, type ColorPalette } from '../services/api';
import { PRIMARY_PRESETS, useThemeMode } from '../theme/ThemeContext';

/* ------------------------------------------------------------ 颜色工具（与 Go colorlab 保持一致） */

const HEX_RE = /^#[0-9A-Fa-f]{6}([A-Fa-f0-9]{2})?$/;
const MAX_COLORS = 16;

function parseColors(input: string): string[] {
  const hits = input.match(/#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (!HEX_RE.test(h)) continue;
    const u = h.toUpperCase();
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= MAX_COLORS) break;
  }
  return out;
}

function applyOpacity(colors: string[], tpp: number): string[] {
  if (tpp <= 0) return colors.slice();
  const alpha = Math.round(((100 - Math.min(tpp, 100)) * 255) / 100)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
  return colors.map((c) => (c.length === 7 ? `${c}${alpha}` : c));
}

function rgbTriple(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbLabel(hex: string): string {
  const [r, g, b] = rgbTriple(hex);
  return `${r}/${g}/${b}`;
}

/* ------------------------------------------------------------ 小组件 */

function PaletteStrip({
  colors,
  height = 46,
  radius = 0,
}: {
  colors: string[];
  height?: number;
  radius?: number;
}) {
  if (!colors.length) {
    return (
      <div
        style={{
          height,
          borderRadius: radius,
          border: '1px dashed var(--d509-border, #d8dee8)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--d509-text-tertiary, #94a3b8)',
          fontSize: 12,
        }}
      >
        暂无颜色
      </div>
    );
  }
  return (
    <div
      style={{
        display: 'flex',
        height,
        borderRadius: radius,
        overflow: 'hidden',
        border: '1px solid rgba(0, 0, 0, 0.08)',
      }}
    >
      {colors.map((c, i) => (
        <Tooltip key={`${c}-${i}`} title={`${c} · ${rgbLabel(c)}`}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              background: c,
              height: '100%',
            }}
            aria-label={c}
          />
        </Tooltip>
      ))}
    </div>
  );
}

type PreviewType = 'bar' | 'box' | 'point' | 'line' | 'pattern';

const PREVIEW_OPTIONS: { label: string; value: PreviewType }[] = [
  { label: '柱状图', value: 'bar' },
  { label: '箱线图', value: 'box' },
  { label: '散点图', value: 'point' },
  { label: '折线图', value: 'line' },
  { label: '色块', value: 'pattern' },
];

/** 确定性伪随机：同一组颜色每次渲染出的形状稳定，避免预览抖动。 */
function noise(i: number, j: number): number {
  const x = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function PreviewChart({ colors, type }: { colors: string[]; type: PreviewType }) {
  if (!colors.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择色板后显示预览" style={{ padding: '28px 0' }} />;
  }
  const W = 460;
  const H = 220;
  const n = colors.length;

  if (type === 'pattern') {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {colors.map((c, i) => (
          <div
            key={`${c}-${i}`}
            style={{
              background: c,
              height: 54,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'center',
              paddingBottom: 4,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 9.5,
              color: 'rgba(255,255,255,0.9)',
              textShadow: '0 1px 2px rgba(0,0,0,0.45)',
            }}
          >
            {c.slice(1, 7)}
          </div>
        ))}
      </div>
    );
  }

  const body = (() => {
    if (type === 'bar') {
      const pad = 26;
      const bw = (W - pad * 2) / n;
      const base = H - 22;
      return colors.map((c, i) => {
        const h = 42 + noise(i, 1) * 128;
        return (
          <rect
            key={i}
            x={pad + i * bw + Math.max(1, bw * 0.12)}
            y={base - h}
            width={Math.max(2, bw * 0.76)}
            height={h}
            fill={c}
            stroke="rgba(0,0,0,0.35)"
            strokeWidth={1}
          />
        );
      });
    }
    if (type === 'box') {
      const pad = 26;
      const bw = (W - pad * 2) / n;
      return colors.map((c, i) => {
        const cx = pad + i * bw + bw / 2;
        const top = 34 + noise(i, 2) * 66;
        const bottom = 150 + noise(i, 3) * 34;
        const q1 = top + (bottom - top) * 0.3;
        const q3 = top + (bottom - top) * 0.72;
        const mid = top + (bottom - top) * 0.52;
        const half = Math.max(3, bw * 0.28);
        return (
          <g key={i} stroke="rgba(0,0,0,0.45)" strokeWidth={1.2}>
            <line x1={cx} y1={top} x2={cx} y2={q1} />
            <line x1={cx} y1={q3} x2={cx} y2={bottom} />
            <line x1={cx - half} y1={top} x2={cx + half} y2={top} />
            <line x1={cx - half} y1={bottom} x2={cx + half} y2={bottom} />
            <rect x={cx - half} y={q1} width={half * 2} height={q3 - q1} fill={c} />
            <line x1={cx - half} y1={mid} x2={cx + half} y2={mid} strokeWidth={2} />
          </g>
        );
      });
    }
    if (type === 'point') {
      const pad = 26;
      const bw = (W - pad * 2) / n;
      const dots: ReactNode[] = [];
      colors.forEach((c, i) => {
        for (let j = 0; j < 12; j++) {
          const x = pad + i * bw + 4 + noise(i, j) * Math.max(2, bw - 8);
          const y = 24 + noise(j, i) * (H - 48);
          dots.push(<circle key={`${i}-${j}`} cx={x} cy={y} r={4.4} fill={c} />);
        }
      });
      return dots;
    }
    // line
    const cols = 24;
    return colors.map((c, i) => {
      const pts = Array.from({ length: cols }, (_, j) => {
        const x = 18 + (j / (cols - 1)) * (W - 36);
        const y = H / 2 + Math.sin(j / 2.4 + i * 0.9) * (26 + i * 5) + noise(i, j) * 10 - 5;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      return <polyline key={i} points={pts} fill="none" stroke={c} strokeWidth={2} strokeLinejoin="round" />;
    });
  })();

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label="配色预览图"
      style={{ display: 'block', background: 'var(--d509-surface-muted, #f8fafc)', borderRadius: 10 }}
    >
      {body}
    </svg>
  );
}

/* ------------------------------------------------------------ 单栏对比面板 */

type PaneMode = 'dataset' | 'custom';

interface PaneState {
  mode: PaneMode;
  id: number | null;
  source?: string;
  count: 'all' | number;
  custom: string;
  opacity: number;
}

const PANE_DEFAULT: PaneState = {
  mode: 'dataset',
  id: null,
  count: 'all',
  custom: '#4DBBD5, #00A087, #E64B35',
  opacity: 0,
};

function ColorPane({
  tag,
  accent,
  state,
  onChange,
  palettes,
  previewType,
  onCopy,
}: {
  tag: string;
  accent: string;
  state: PaneState;
  onChange: (next: PaneState) => void;
  palettes: ColorPalette[];
  previewType: PreviewType;
  onCopy: (text: string, label: string) => void;
}) {
  const selected = useMemo(
    () => (state.id == null ? undefined : palettes.find((p) => p.id === state.id)),
    [palettes, state.id],
  );
  const navigate = useNavigate();

  const sourceOptions = useMemo(() => {
    const set = new Map<string, number>();
    palettes.forEach((p) => set.set(p.source, (set.get(p.source) ?? 0) + 1));
    return [...set.entries()].map(([value, count]) => ({ value, label: `${value}（${count}）` }));
  }, [palettes]);

  const paletteOptions = useMemo(
    () =>
      palettes
        .filter((p) => !state.source || p.source === state.source)
        .map((p) => ({
          value: p.id,
          label: `#${p.id} ${p.name === 'nameless' ? '未命名方案' : p.name} · ${p.count} 色`,
        })),
    [palettes, state.source],
  );

  const base = state.mode === 'dataset' ? (selected?.colors ?? []) : parseColors(state.custom);
  const limited = state.mode === 'dataset' && state.count !== 'all' ? base.slice(0, state.count) : base;
  const colors = applyOpacity(limited, state.opacity);
  const countOptions = useMemo(() => {
    const max = Math.max(2, Math.min(MAX_COLORS, base.length));
    const opts = [{ value: 'all', label: `全部 ${base.length} 色` }];
    for (let i = 2; i <= max; i++) opts.push({ value: String(i), label: `前 ${i} 色` });
    return opts;
  }, [base.length]);

  const set = (patch: Partial<PaneState>) => onChange({ ...state, ...patch });

  const switchMode = (mode: PaneMode) => {
    if (mode === state.mode) return;
    if (mode === 'custom' && !state.custom) set({ mode, custom: selected?.colors.join(', ') ?? '' });
    else set({ mode });
  };

  return (
    <Card
      className="d509-color-pane"
      styles={{ body: { padding: 16 } }}
      style={{ borderTop: `3px solid ${accent}`, height: '100%' }}
    >
      <Flex justify="space-between" align="center" gap={8} wrap>
        <Flex gap={8} align="center">
          <span className="d509-color-badge" style={{ background: accent }}>
            {tag}
          </span>
          <Typography.Text strong style={{ fontSize: 14 }}>
            {state.mode === 'dataset' ? selected?.name === 'nameless' || !selected ? '数据库方案' : selected.name : '自定义方案'}
          </Typography.Text>
          {state.mode === 'dataset' && selected ? <Tag style={{ marginInlineEnd: 0 }}>{selected.source}</Tag> : null}
        </Flex>
        <Segmented
          size="small"
          value={state.mode}
          onChange={(v) => switchMode(v as PaneMode)}
          options={[
            { label: '数据库', value: 'dataset' },
            { label: '自定义', value: 'custom' },
          ]}
        />
      </Flex>

      {state.mode === 'dataset' ? (
        <Flex gap={8} style={{ marginTop: 12 }} wrap>
          <Select
            size="small"
            allowClear
            placeholder="来源"
            style={{ width: 138 }}
            value={state.source}
            options={sourceOptions}
            onChange={(v) => set({ source: v, id: null })}
          />
          <Select
            size="small"
            showSearch={{ optionFilterProp: 'label' }}
            placeholder="选择配色方案"
            style={{ flex: 1, minWidth: 170 }}
            value={state.id ?? undefined}
            options={paletteOptions}
            onChange={(v) => set({ id: v, count: 'all' })}
          />
          <Select
            size="small"
            style={{ width: 108 }}
            value={state.count === 'all' ? 'all' : String(state.count)}
            options={countOptions}
            onChange={(v) => set({ count: v === 'all' ? 'all' : Number(v) })}
          />
        </Flex>
      ) : (
        <Input.TextArea
          style={{ marginTop: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5 }}
          autoSize={{ minRows: 2, maxRows: 4 }}
          value={state.custom}
          placeholder="#4DBBD5, #00A087, #E64B35（逗号/空格/顿号分隔，最多 16 色）"
          onChange={(e) => set({ custom: e.target.value })}
        />
      )}

      <div style={{ marginTop: 14 }}>
        <PaletteStrip colors={colors} height={52} radius={10} />
      </div>

      <Flex align="center" gap={12} style={{ marginTop: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
          透明度
        </Typography.Text>
        <Slider
          min={0}
          max={100}
          value={state.opacity}
          onChange={(v) => set({ opacity: v })}
          tooltip={{ formatter: (v) => `${v}%` }}
          style={{ flex: 1, margin: 0 }}
        />
        <Typography.Text style={{ fontSize: 12, width: 40, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {state.opacity}%
        </Typography.Text>
      </Flex>

      <div className="d509-color-code">
        <Flex justify="space-between" align="center" gap={8}>
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
            HEX · {colors.length} 色{limited.length >= MAX_COLORS ? '（上限 16）' : ''}
          </Typography.Text>
          <Button
            type="text"
            size="small"
            icon={<CopyOutlined />}
            disabled={!colors.length}
            onClick={() => onCopy(colors.join(', '), 'HEX')}
          />
          <Button
            type="text"
            size="small"
            icon={<BarChartOutlined />}
            disabled={!colors.length}
            onClick={() => navigate(`/plot?colors=${encodeURIComponent(colors.join(','))}`)}
          >
            在绘图中使用
          </Button>
        </Flex>
        <Typography.Paragraph
          copyable={false}
          style={{ margin: 0, fontSize: 11.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' }}
        >
          {colors.join(', ') || '—'}
        </Typography.Paragraph>
        <Flex justify="space-between" align="center" gap={8} style={{ marginTop: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
            RGB
          </Typography.Text>
          <Button
            type="text"
            size="small"
            icon={<CopyOutlined />}
            disabled={!colors.length}
            onClick={() => onCopy(colors.map(rgbLabel).join(', '), 'RGB')}
          />
        </Flex>
        <Typography.Paragraph
          style={{ margin: 0, fontSize: 11.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' }}
        >
          {colors.map(rgbLabel).join(', ') || '—'}
        </Typography.Paragraph>
      </div>

      <div style={{ marginTop: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
          绘图预览
        </Typography.Text>
        <div style={{ marginTop: 6 }}>
          <PreviewChart colors={colors} type={previewType} />
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ 页面 */

export default function Colors() {
  const { message } = App.useApp();
  const { primary, setPrimary, resetPrimary } = useThemeMode();
  const [a, setA] = useState<PaneState>({ ...PANE_DEFAULT });
  const [b, setB] = useState<PaneState>({ ...PANE_DEFAULT });
  const [previewType, setPreviewType] = useState<PreviewType>('bar');

  const [libQuery, setLibQuery] = useState('');
  const [libSource, setLibSource] = useState<string>();
  const [libCount, setLibCount] = useState<string>('all');
  const [libSort, setLibSort] = useState<'id' | 'count'>('count');
  const [libPage, setLibPage] = useState(1);

  const palettesQ = useQuery({
    queryKey: ['color-palettes'],
    queryFn: () => api.colorPalettes({ page_size: 500 }),
    staleTime: 10 * 60_000,
  });
  const metaQ = useQuery({ queryKey: ['color-meta'], queryFn: api.colorMeta, staleTime: 10 * 60_000 });

  const palettes = palettesQ.data?.items ?? [];
  const sources = metaQ.data?.sources ?? [];

  // 默认左右各放一套差异明显的方案，打开页面即可看到对比效果。
  useEffect(() => {
    if (!palettes.length) return;
    setA((prev) => (prev.id == null ? { ...prev, id: palettes[0]?.id ?? null } : prev));
    setB((prev) => {
      if (prev.id != null) return prev;
      const pick = palettes.find((p) => p.source !== palettes[0]?.source && p.count >= 5) ?? palettes[Math.min(6, palettes.length - 1)];
      return { ...prev, id: pick?.id ?? null };
    });
  }, [palettes]);

  const copy = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        message.success(`${label} 已复制`);
      } catch {
        message.error('复制失败，请手动选择文本');
      }
    },
    [message],
  );

  const library = useMemo(() => {
    const q = libQuery.trim().toLowerCase();
    let rows = palettes.filter((p) => {
      if (libSource && p.source !== libSource) return false;
      if (libCount !== 'all' && p.count !== Number(libCount)) return false;
      if (!q) return true;
      return (
        String(p.id).includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.source.toLowerCase().includes(q) ||
        p.colors.some((c) => c.toLowerCase().includes(q))
      );
    });
    if (libSort === 'count') rows = [...rows].sort((x, y) => y.count - x.count || x.id - y.id);
    return rows;
  }, [palettes, libQuery, libSource, libCount, libSort]);

  const safePage = Math.min(libPage, Math.max(1, Math.ceil(library.length / 10)));
  const pageRows = useMemo(() => {
    const start = (safePage - 1) * 10;
    return library.slice(start, start + 10);
  }, [library, safePage]);

  const applyTo = (which: 'a' | 'b', p: ColorPalette) => {
    const next: PaneState = { ...PANE_DEFAULT, mode: 'dataset', id: p.id, opacity: which === 'a' ? a.opacity : b.opacity };
    if (which === 'a') setA(next);
    else setB(next);
    message.success(`已放入 ${which.toUpperCase()} 栏：${p.name === 'nameless' ? `#${p.id}` : p.name}`);
  };

  const randomize = () => {
    if (!palettes.length) return;
    const pick = () => palettes[Math.floor(Math.random() * palettes.length)];
    let pa = pick();
    let pb = pick();
    for (let i = 0; i < 8 && pa.id === pb.id; i++) pb = pick();
    setA((prev) => ({ ...prev, mode: 'dataset', id: pa.id, count: 'all' }));
    setB((prev) => ({ ...prev, mode: 'dataset', id: pb.id, count: 'all' }));
  };

  /* ------------------------------- 以图找色 */
  const [seeds, setSeeds] = useState<string[]>(['#4DBBD5', '#00A087', '#E64B35']);
  const validSeeds = useMemo(() => seeds.map((s) => s.trim()).filter((s) => HEX_RE.test(s)), [seeds]);
  const matchQ = useQuery({
    queryKey: ['color-match', validSeeds.join(',').toUpperCase()],
    queryFn: () => api.colorMatch(validSeeds, 8),
    enabled: validSeeds.length > 0,
    staleTime: 60_000,
  });

  const updateSeed = (i: number, value: string) => setSeeds((prev) => prev.map((s, j) => (j === i ? value : s)));

  /* ------------------------------- 配色库表格 */
  const columns: ColumnsType<ColorPalette> = [
    {
      title: '配色',
      dataIndex: 'colors',
      render: (_, p) => (
        <div style={{ minWidth: 150 }}>
          <PaletteStrip colors={p.colors} height={22} radius={6} />
        </div>
      ),
    },
    { title: 'ID', dataIndex: 'id', width: 64, sorter: false },
    {
      title: '名称',
      dataIndex: 'name',
      width: 130,
      render: (name: string, p) => (
        <Space size={4} orientation="vertical" style={{ lineHeight: 1.3 }}>
          <span style={{ fontSize: 12.5 }}>{name === 'nameless' ? '未命名方案' : name}</span>
          <Tag style={{ marginInlineEnd: 0, fontSize: 10.5 }}>{p.source}</Tag>
        </Space>
      ),
    },
    {
      title: '色数',
      dataIndex: 'count',
      width: 64,
      render: (n: number) => <Tag color={n >= 8 ? 'blue' : 'default'}>{n} 色</Tag>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 168,
      render: (_, p) => (
        <Space size={4}>
          <Tooltip title="放入左侧 A 栏">
            <Button size="small" onClick={() => applyTo('a', p)}>
              A
            </Button>
          </Tooltip>
          <Tooltip title="放入右侧 B 栏">
            <Button size="small" onClick={() => applyTo('b', p)}>
              B
            </Button>
          </Tooltip>
          <Tooltip title="复制 HEX">
            <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => copy(p.colors.join(', '), 'HEX')} />
          </Tooltip>
          <Tooltip title={`设为站点主色（${p.colors[0]}）`}>
            <Button
              size="small"
              type="text"
              icon={<BgColorsOutlined />}
              disabled={!p.colors.length}
              onClick={() => {
                setPrimary(p.colors[0]);
                message.success(`已将 ${p.colors[0]} 设为站点主色`);
              }}
            />
          </Tooltip>
        </Space>
      ),
    },
  ];

  const countOptions = useMemo(() => {
    const counts = new Set(palettes.map((p) => p.count));
    return [
      { value: 'all', label: '全部色数' },
      ...[...counts].sort((x, y) => x - y).map((n) => ({ value: String(n), label: `${n} 色` })),
    ];
  }, [palettes]);

  return (
    <Flex vertical gap={16}>
      <Card className="d509-color-hero" styles={{ body: { padding: '20px 22px' } }}>
        <Flex justify="space-between" align="center" gap={16} wrap>
          <div>
            <Flex gap={8} align="center" wrap>
              <span className="d509-color-hero-icon">
                <BgColorsOutlined />
              </span>
              <Typography.Title level={2} style={{ margin: 0, fontSize: 22 }}>
                配色搭配
              </Typography.Title>
            </Flex>
          </div>
          <Space size={8} wrap>
            <Tag color="cyan">{metaQ.data?.total ?? palettes.length} 套色板</Tag>
            <Tag>{sources.length} 个来源</Tag>
            <Tooltip title="全站主题色，立即生效并保存到本机">
              <span>
                <ColorPicker
                  value={primary}
                  disabledAlpha
                  showText
                  presets={PRIMARY_PRESETS}
                  onChangeComplete={(c) => setPrimary(c.toHexString())}
                />
              </span>
            </Tooltip>
            <Button onClick={resetPrimary}>恢复默认色</Button>
            <Button icon={<ReloadOutlined />} onClick={randomize}>
              随机对比
            </Button>
          </Space>
        </Flex>
      </Card>

      <Flex justify="space-between" align="center" gap={12} wrap>
        <Typography.Text className="d509-section-title">双栏对比</Typography.Text>
        <Segmented
          value={previewType}
          options={PREVIEW_OPTIONS}
          onChange={(v) => setPreviewType(v as PreviewType)}
        />
      </Flex>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <ColorPane tag="A" accent="#2B5CE6" state={a} onChange={setA} palettes={palettes} previewType={previewType} onCopy={copy} />
        </Col>
        <Col xs={24} lg={12}>
          <ColorPane tag="B" accent="#12A594" state={b} onChange={setB} palettes={palettes} previewType={previewType} onCopy={copy} />
        </Col>
      </Row>

      <Card className="d509-card" styles={{ body: { padding: 0 } }}>
        <Tabs
          defaultActiveKey="library"
          style={{ padding: '4px 16px 0' }}
          items={[
            {
              key: 'library',
              label: '配色库',
              children: (
                <Flex vertical gap={12} style={{ paddingBottom: 16 }}>
                  <Flex gap={8} wrap align="center">
                    <Input
                      allowClear
                      prefix={<SearchOutlined />}
                      placeholder="搜索 ID、名称、来源或 HEX"
                      value={libQuery}
                      onChange={(e) => {
                        setLibQuery(e.target.value);
                        setLibPage(1);
                      }}
                      style={{ width: 260 }}
                    />
                    <Select
                      allowClear
                      placeholder="来源"
                      style={{ width: 150 }}
                      value={libSource}
                      options={sources.map((s) => ({ value: s.name, label: `${s.name}（${s.count}）` }))}
                      onChange={(v) => {
                        setLibSource(v);
                        setLibPage(1);
                      }}
                    />
                    <Select
                      style={{ width: 120 }}
                      value={libCount}
                      options={countOptions}
                      onChange={(v) => {
                        setLibCount(v);
                        setLibPage(1);
                      }}
                    />
                    <Segmented
                      value={libSort}
                      options={[
                        { label: '按 ID', value: 'id' },
                        { label: '按色数', value: 'count' },
                      ]}
                      onChange={(v) => setLibSort(v as 'id' | 'count')}
                    />
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      共 {library.length} 套
                    </Typography.Text>
                  </Flex>

                  <Table
                    rowKey="id"
                    size="small"
                    columns={columns}
                    dataSource={pageRows}
                    loading={palettesQ.isLoading}
                    pagination={false}
                    scroll={{ x: 640 }}
                    locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的配色方案" /> }}
                  />
                  <Flex justify="flex-end">
                    <Pagination
                      size="small"
                      current={safePage}
                      pageSize={10}
                      total={library.length}
                      showSizeChanger={false}
                      onChange={setLibPage}
                    />
                  </Flex>
                </Flex>
              ),
            },
            {
              key: 'match',
              label: '以图找色',
              children: (
                <Flex vertical gap={14} style={{ paddingBottom: 16 }}>
                  <Flex gap={10} wrap align="center">
                    {seeds.map((s, i) => {
                      const valid = HEX_RE.test(s.trim());
                      return (
                        <div key={i} className="d509-seed-input">
                          <input
                            type="color"
                            value={valid ? (s.trim().length === 7 ? s.trim() : s.trim().slice(0, 7)) : '#cccccc'}
                            onChange={(e) => updateSeed(i, e.target.value.toUpperCase())}
                            aria-label={`主色 ${i + 1}`}
                          />
                          <Input
                            size="small"
                            value={s}
                            status={valid ? undefined : 'error'}
                            onChange={(e) => updateSeed(i, e.target.value)}
                            style={{ width: 96, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                          />
                          <Button
                            type="text"
                            size="small"
                            danger
                            disabled={seeds.length <= 1}
                            onClick={() => setSeeds((prev) => prev.filter((_, j) => j !== i))}
                          >
                            移除
                          </Button>
                        </div>
                      );
                    })}
                    <Button
                      icon={<PlusOutlined />}
                      disabled={seeds.length >= 8}
                      onClick={() => setSeeds((prev) => [...prev, '#888888'])}
                    >
                      主色
                    </Button>
                    <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => matchQ.refetch()}>
                      寻找相似配色
                    </Button>
                  </Flex>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    按 CIELAB 色差（CIE76）为每个主色在色板中寻找最接近的颜色，距离总和越小越相似。
                  </Typography.Text>

                  {matchQ.isLoading ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="匹配中…" />
                  ) : (matchQ.data?.items.length ?? 0) === 0 ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入至少一个有效 HEX 颜色" />
                  ) : (
                    <div className="d509-color-match-grid">
                      {matchQ.data?.items.map((item) => (
                        <Card key={item.id} size="small" styles={{ body: { padding: 12 } }} className="d509-color-match">
                          <Flex justify="space-between" align="center" gap={8}>
                            <Space size={6}>
                              <Typography.Text strong style={{ fontSize: 13 }}>
                                #{item.id}
                              </Typography.Text>
                              <Tag style={{ marginInlineEnd: 0 }}>{item.source}</Tag>
                            </Space>
                            <Tag color={item.score < 24 ? 'green' : item.score < 60 ? 'gold' : 'default'}>
                              ΔE {item.score}
                            </Tag>
                          </Flex>
                          <div style={{ marginTop: 8 }}>
                            <PaletteStrip colors={item.colors} height={26} radius={6} />
                          </div>
                          <Flex gap={6} wrap style={{ marginTop: 8 }}>
                            {item.nearest.map((n, i) => (
                              <Tooltip key={i} title={`主色 ${n.seed} 最接近 ${n.hex}（ΔE ${n.distance}）`}>
                                <span className="d509-color-near">
                                  <i style={{ background: n.seed }} />
                                  <SwapRightOutlined />
                                  <i style={{ background: n.hex }} />
                                  <em>{n.hex}</em>
                                </span>
                              </Tooltip>
                            ))}
                          </Flex>
                          <Flex justify="flex-end" gap={6} style={{ marginTop: 8 }}>
                            <Button size="small" onClick={() => applyTo('a', item)}>
                              放入 A
                            </Button>
                            <Button size="small" onClick={() => applyTo('b', item)}>
                              放入 B
                            </Button>
                          </Flex>
                        </Card>
                      ))}
                    </div>
                  )}
                </Flex>
              ),
            },
            {
              key: 'about',
              label: '说明',
              children: (
                <Flex vertical gap={12} style={{ paddingBottom: 20, maxWidth: 820 }}>
                  <Typography.Paragraph style={{ margin: 0, fontSize: 13, lineHeight: 1.8 }}>
                    左右两栏可分别选择数据库色板或自定义颜色，对比后可直接复制 HEX / RGB 并带入绘图工作台。
                    将 1–8 个主色填入「以图找色」，会按 CIELAB 色差返回最接近的色板。
                  </Typography.Paragraph>
                  <Space wrap size={6}>
                    {sources.map((s) => (
                      <Tag key={s.name}>
                        {s.name} · {s.count}
                      </Tag>
                    ))}
                    <Tag color="blue">
                      <ExperimentOutlined /> {metaQ.data?.total ?? palettes.length} 套
                    </Tag>
                  </Space>
                </Flex>
              ),
            },
          ]}
        />
      </Card>
    </Flex>
  );
}