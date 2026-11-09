import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Divider,
  Drawer,
  Empty,
  Flex,
  Grid,
  Input,
  InputNumber,
  Radio,
  Segmented,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { CopyOutlined, DownloadOutlined, PlayCircleOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  type BlastDatabase,
  type BlastHit,
  type BlastHsp,
  type BlastJob,
  type BlastQuery,
  type ExtractedSequence,
  type GenomeAnnotation,
  type GenomeGene,
  type IdMapItem,
  type IdResolveItem,
  type MotifSearchResult,
  type PairwiseAlignment,
  type RegionOverlapResult,
} from '../../services/api';
import ResultActions from './ResultActions';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** 工具互投：上游结果作为种子交给下游面板预填 */
interface SeedSeq {
  value: string;
  from: string;
  target: string;
}
interface SeedRegion {
  seqid: string;
  start: number;
  end: number;
  from: string;
}

const cleanDna = (s: string) => s.replace(/[^A-Za-z]/g, '').toUpperCase();

const STATUS_LABEL: Record<string, string> = {
  not_provisioned: '未部署',
  staging: '导入中',
  validated: '已校验待发布',
  failed: '失败',
  blocked_data_not_provided: '缺数据',
  published: '已发布',
};

const RESOLVE_STATUS: Record<string, { color: string; text: string }> = {
  exact: { color: 'green', text: '精确' },
  alias: { color: 'blue', text: '别名' },
  ambiguous: { color: 'gold', text: '歧义' },
  not_found: { color: 'default', text: '未找到' },
  mapped: { color: 'green', text: '已映射' },
  unmapped: { color: 'default', text: '未映射' },
  '1:n': { color: 'gold', text: '一对多' },
  UNSUPPORTED_MAPPING_EVIDENCE: { color: 'red', text: '缺映射证据' },
};

const TOOL_OPTIONS = [
  { label: '比对', value: 'align' },
  { label: '基序', value: 'motif' },
  { label: '区间', value: 'region' },
  { label: '提取', value: 'extract' },
  { label: '基因', value: 'genes' },
  { label: 'ID 解析', value: 'resolve' },
  { label: 'BLAST', value: 'blast' },
] as const;

const BLAST_STATUS: Record<string, { color: string; text: string }> = {
  queued: { color: 'default', text: '排队中' },
  claimed: { color: 'processing', text: '已领取' },
  running: { color: 'processing', text: '运行中' },
  succeeded: { color: 'green', text: '已完成' },
  finished: { color: 'green', text: '已完成' },
  failed: { color: 'red', text: '失败' },
  cancelled: { color: 'default', text: '已取消' },
  canceled: { color: 'default', text: '已取消' },
  expired: { color: 'default', text: '已过期' },
};

const TERMINAL_JOB = ['succeeded', 'finished', 'failed', 'cancelled', 'canceled', 'expired'];
const READY_JOB = ['succeeded', 'finished'];

const fmtBitscore = (v?: number | null) => (v === undefined || v === null ? '—' : v.toFixed(1));

const fmtEvalue = (v?: number | null) => {
  if (v === undefined || v === null) return '—';
  if (v === 0) return '0';
  return v < 1e-3 ? v.toExponential(1) : Number(v.toPrecision(3)).toString();
};

const fmtCoverage = (v?: number | null) => (v === undefined || v === null ? '—' : `${v.toFixed(1)}%`);

function midline(query: string, subject: string) {
  let out = '';
  const n = Math.min(query.length, subject.length);
  for (let i = 0; i < n; i += 1) {
    const a = query[i];
    const b = subject[i];
    out += a === '-' || b === '-' ? ' ' : a === b ? '|' : '.';
  }
  return out;
}

const BLAST_MODES = [
  { value: 'blastp', label: 'blastp', hint: '蛋白 → 蛋白库' },
  { value: 'blastx', label: 'blastx', hint: '核酸翻译 → 蛋白库' },
  { value: 'blastn', label: 'blastn', hint: '核酸 → 核酸库（预留）' },
];

const SEQUENCE_TYPES = [
  { value: 'TRANSCRIPT_CDS', label: 'CDS', hint: '编码区' },
  { value: 'TRANSCRIPT_CDNA', label: 'cDNA', hint: '剪接后含 UTR' },
  { value: 'TRANSCRIPT_PROTEIN', label: 'Protein', hint: '注释蛋白' },
  { value: 'GENE_GENOMIC', label: 'Gene 基因组段', hint: '含内含子' },
  { value: 'UPSTREAM', label: '上游', hint: '5′ flank' },
  { value: 'DOWNSTREAM', label: '下游', hint: '3′ flank' },
  { value: 'GENOMIC_INTERVAL', label: '染色体区间', hint: 'seqid:start-end，1-based 闭区间' },
];

function CopyButton({ text }: { text: string }) {
  const { message } = App.useApp();
  return (
    <Button
      size="small"
      icon={<CopyOutlined />}
      disabled={!text}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          message.success('已复制');
        } catch {
          message.error('浏览器拒绝了剪贴板写入');
        }
      }}
    >
      复制
    </Button>
  );
}

function AlignPanel({ seed }: { seed?: SeedSeq | null }) {
  const { message } = App.useApp();
  const [query, setQuery] = useState('ACCGTGGAT');
  const [reference, setReference] = useState('AAAAACCGTTGAT');
  const [mode, setMode] = useState<'global' | 'semiglobal' | 'local'>('semiglobal');
  const [scoring, setScoring] = useState({ match: 1, mismatch: -1, gap_open: -5, gap_extend: -1 });
  const [result, setResult] = useState<PairwiseAlignment | null>(null);
  const [running, setRunning] = useState(false);

  // 上游工具（序列提取 / 基因检索）送来的序列填到 query
  useEffect(() => {
    if (seed?.value) setQuery(seed.value);
  }, [seed]);

  const run = async () => {
    const q = cleanDna(query);
    const r = cleanDna(reference);
    if (!q || !r) {
      message.warning('query 与 reference 都不能为空');
      return;
    }
    setRunning(true);
    try {
      setResult(await api.genomeAlignPairwise({ query: q, reference: r, molecule: 'dna', mode, scoring }));
    } catch (e) {
      message.error(`对齐失败：${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Flex vertical gap={12}>
      <Alert
        type="info"
        showIcon
        title="rust-bio pairwise 对齐"
        description="支持 global / semiglobal / local 三种模式；区间为 0-based 半开区间，CIGAR 与 pretty 由后端直接生成。"
      />
      <Flex gap={12} wrap align="stretch">
        <Input.TextArea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoSize={{ minRows: 4, maxRows: 8 }}
          placeholder="query 序列"
          style={{ fontFamily: MONO, flex: '1 1 320px' }}
        />
        <Input.TextArea
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          autoSize={{ minRows: 4, maxRows: 8 }}
          placeholder="reference 序列"
          style={{ fontFamily: MONO, flex: '1 1 320px' }}
        />
      </Flex>
      <Flex gap={12} wrap align="center">
        <Segmented
          value={mode}
          onChange={(v) => setMode(v as typeof mode)}
          options={[
            { label: 'global', value: 'global' },
            { label: 'semiglobal', value: 'semiglobal' },
            { label: 'local', value: 'local' },
          ]}
        />
        <Space size={6} wrap>
          {(
            [
              ['match', '匹配'],
              ['mismatch', '错配'],
              ['gap_open', '开缺'], 
              ['gap_extend', '延缺'],
            ] as const
          ).map(([key, label]) => (
            <InputNumber
              key={key}
              size="small"
              prefix={<span style={{ color: 'rgba(0,0,0,0.45)' }}>{label}</span>}
              value={scoring[key]}
              onChange={(v) => setScoring((s) => ({ ...s, [key]: Number(v ?? 0) }))}
              style={{ width: 130 }}
            />
          ))}
        </Space>
        <Button type="primary" icon={<PlayCircleOutlined />} loading={running} onClick={run}>
          执行对齐
        </Button>
      </Flex>
      {result ? (
        <Card
          size="small"
          title="对齐结果"
          extra={
            <Space size={4} wrap>
              <Tag color="blue" variant="filled">{result.algorithm}</Tag>
              <Tag variant="filled">rust-bio {result.library_version}</Tag>
            </Space>
          }
        >
          <Flex vertical gap={12}>
            <Flex gap={20} wrap>
              <Statistic title="得分" value={result.score} />
              <Statistic
                title="query 区间"
                value={`[${result.query_interval.start}, ${result.query_interval.end})`}
              />
              <Statistic
                title="reference 区间"
                value={`[${result.reference_interval.start}, ${result.reference_interval.end})`}
              />
            </Flex>
            <div>
              <Flex align="center" justify="space-between" style={{ marginBottom: 6 }}>
                <Typography.Text strong>CIGAR</Typography.Text>
                <CopyButton text={result.cigar} />
              </Flex>
              <Typography.Text code style={{ fontFamily: MONO }}>{result.cigar}</Typography.Text>
            </div>
            <div>
              <Flex align="center" justify="space-between" style={{ marginBottom: 6 }}>
                <Typography.Text strong>对齐（pretty）</Typography.Text>
                <CopyButton text={result.pretty} />
              </Flex>
              <pre style={{ margin: 0, padding: 10, background: 'rgba(0,0,0,0.03)', borderRadius: 6, fontFamily: MONO, fontSize: 12, overflowX: 'auto' }}>
                {result.pretty}
              </pre>
            </div>
            <ResultActions
              title={`成对比对 · ${result.algorithm}（${mode}）`}
              body={[
                `## 成对比对（${result.algorithm} · ${mode}）`,
                `- 得分：${result.score}`,
                `- query 区间：[${result.query_interval.start}, ${result.query_interval.end})`,
                `- reference 区间：[${result.reference_interval.start}, ${result.reference_interval.end})`,
                '',
                `CIGAR：${result.cigar}`,
                '',
                '```',
                result.pretty,
                '```',
              ].join('\n')}
              category="生信"
              tags={['比对', 'rust-bio']}
            />
          </Flex>
        </Card>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="填写两条序列后执行对齐" />
      )}
    </Flex>
  );
}

function MotifPanel() {
  const { message } = App.useApp();
  const [text, setText] = useState('CGGTCCTGAGGGATTAGCAC');
  const [pattern, setPattern] = useState('CCTG');
  const [mode, setMode] = useState<'exact' | 'approximate'>('exact');
  const [distance, setDistance] = useState(2);
  const [result, setResult] = useState<MotifSearchResult | null>(null);
  const [running, setRunning] = useState(false);
  const clean = useMemo(() => cleanDna(text), [text]);

  const run = async () => {
    const p = cleanDna(pattern);
    if (!clean || !p) {
      message.warning('text 与 pattern 都不能为空');
      return;
    }
    setRunning(true);
    try {
      setResult(
        await api.genomeSearchMotifs({
          text: clean,
          pattern: p,
          mode,
          max_distance: mode === 'approximate' ? distance : 0,
        }),
      );
    } catch (e) {
      message.error(`检索失败：${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Flex vertical gap={12}>
      <Alert
        type="info"
        showIcon
        title="rust-bio 基序检索"
        description="exact 使用 KMP 精确匹配；approximate 使用 Myers 允许最多 max_distance 个编辑。坐标为 0-based 半开区间。"
      />
      <Flex gap={12} wrap>
        <Input.TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoSize={{ minRows: 4, maxRows: 8 }}
          placeholder="待检索序列"
          style={{ fontFamily: MONO, flex: '1 1 380px' }}
        />
        <Flex vertical gap={8} style={{ flex: '0 1 260px' }}>
          <Input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="pattern，例如 CCTG"
            style={{ fontFamily: MONO }}
          />
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as typeof mode)}
            options={[
              { label: 'exact（KMP）', value: 'exact' },
              { label: 'approximate（Myers）', value: 'approximate' },
            ]}
          />
          <InputNumber
            size="small"
            prefix={<span style={{ color: 'rgba(0,0,0,0.45)' }}>max_distance</span>}
            min={0}
            max={32}
            value={distance}
            disabled={mode === 'exact'}
            onChange={(v) => setDistance(Number(v ?? 0))}
            style={{ width: '100%' }}
          />
          <Button type="primary" icon={<SearchOutlined />} loading={running} onClick={run}>
            检索
          </Button>
        </Flex>
      </Flex>
      {result ? (
        <Card
          size="small"
          title={`命中 ${result.matches.length} 处`}
          extra={
            <Space size={4} wrap>
              <Tag color="blue" variant="filled">{result.algorithm}</Tag>
              <Tag variant="filled">mode {result.mode}</Tag>
              <Tag variant="filled">pattern {result.pattern_length} bp</Tag>
            </Space>
          }
        >
          <Table
            size="small"
            rowKey={(r) => `${r.start}-${r.end}-${r.distance}`}
            dataSource={result.matches}
            pagination={result.matches.length > 10 ? { pageSize: 10 } : false}
            locale={{ emptyText: '没有命中' }}
            columns={[
              { title: 'start', dataIndex: 'start', width: 110, render: (v) => <span style={{ fontFamily: MONO }}>{v}</span> },
              { title: 'end', dataIndex: 'end', width: 110, render: (v) => <span style={{ fontFamily: MONO }}>{v}</span> },
              {
                title: 'distance',
                dataIndex: 'distance',
                width: 110,
                render: (v: number) => <Tag color={v === 0 ? 'green' : 'gold'}>{v}</Tag>,
              },
              {
                title: '命中片段',
                key: 'frag',
                render: (_: unknown, r) => (
                  <span style={{ fontFamily: MONO }}>{clean.slice(r.start, r.end)}</span>
                ),
              },
            ]}
          />
          <ResultActions
            title={`基序检索 · ${result.algorithm}`}
            body={[
              `## 基序检索（${result.algorithm} · mode ${result.mode}）`,
              `- pattern 长度：${result.pattern_length} bp`,
              `- 命中：${result.matches.length} 处`,
              '',
              '| start | end | distance | 命中片段 |',
              '| --- | --- | --- | --- |',
              ...result.matches
                .slice(0, 60)
                .map((m) => `| ${m.start} | ${m.end} | ${m.distance} | ${clean.slice(m.start, m.end)} |`),
            ].join('\n')}
            category="生信"
            tags={['基序', 'rust-bio']}
          />
        </Card>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="填写 text 与 pattern 后点「检索」" />
      )}
    </Flex>
  );
}

function parseFeatures(text: string) {
  const rows: Array<{ contig: string; start: number; end: number; id: string }> = [];
  const errors: string[] = [];
  text
    .split(/\r?\n/)
    .forEach((line, i) => {
      const cells = line.trim().split(/[\s,;\t]+/).filter(Boolean);
      if (!cells.length) return;
      if (cells.length < 4) {
        errors.push(`第 ${i + 1} 行字段不足 4 列`);
        return;
      }
      const start = Number(cells[1]);
      const end = Number(cells[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
        errors.push(`第 ${i + 1} 行区间无效`);
        return;
      }
      rows.push({ contig: cells[0], start, end, id: cells[3] });
    });
  return { rows, errors };
}

function RegionPanel({ assemblyId, onLocate }: { assemblyId?: string; onLocate?: (loc: string) => void }) {
  const { message } = App.useApp();
  const [text, setText] = useState('chr1\t100\t200\tgeneA\nchr1\t180\t260\tgeneB\nchr1\t400\t500\tgeneC');
  const [contig, setContig] = useState('chr1');
  const [start, setStart] = useState(190);
  const [end, setEnd] = useState(220);
  const [result, setResult] = useState<RegionOverlapResult | null>(null);
  const [running, setRunning] = useState(false);
  const parsed = useMemo(() => parseFeatures(text), [text]);

  const run = async () => {
    if (!parsed.rows.length || !contig.trim() || end < start) {
      message.warning('请填写有效的特征区间与查询区间');
      return;
    }
    setRunning(true);
    try {
      setResult(
        await api.genomeRegionFeatures({
          features: parsed.rows,
          query: { contig: contig.trim(), start, end, ...(assemblyId ? { assembly_id: assemblyId } : {}) },
          ...(assemblyId ? { assembly_id: assemblyId } : {}),
        }),
      );
    } catch (e) {
      message.error(`查询失败：${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Flex vertical gap={12}>
      <Alert
        type="info"
        showIcon
        title="rust-bio IntervalTree 区域重叠"
        description="特征区间与查询区间都按 1-based 闭区间填写；后端会换算成 0-based 半开区间并在内部区间中回显。"
      />
      <Flex gap={12} wrap>
        <Flex vertical gap={8} style={{ flex: '1 1 380px' }}>
          <Input.TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoSize={{ minRows: 6, maxRows: 12 }}
            placeholder={'每行：contig 起始 结束 id\nchr1\t100\t200\tgeneA'}
            style={{ fontFamily: MONO }}
          />
          {parsed.errors.length ? (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              跳过 {parsed.errors.length} 行无法解析的内容：{parsed.errors.slice(0, 3).join('；')}
            </Typography.Text>
          ) : null}
        </Flex>
        <Flex vertical gap={8} style={{ flex: '0 1 300px' }}>
          <Input prefix="contig" value={contig} onChange={(e) => setContig(e.target.value)} />
          <Space size={6} wrap>
            <InputNumber prefix="start" min={1} value={start} onChange={(v) => setStart(Number(v ?? 1))} />
            <InputNumber prefix="end" min={1} value={end} onChange={(v) => setEnd(Number(v ?? 1))} />
          </Space>
          <Button
            type="primary"
            icon={<SearchOutlined />}
            loading={running}
            disabled={!parsed.rows.length}
            onClick={run}
          >
            查询重叠（{parsed.rows.length} 个特征）
          </Button>
        </Flex>
      </Flex>
      {result ? (
        <Card
          size="small"
          title="重叠结果"
          extra={
            <Space size={4} wrap>
              <Tag color="blue" variant="filled">{result.algorithm}</Tag>
              <Tag variant="filled">内部区间 [{result.internal_interval.start}, {result.internal_interval.end})</Tag>
            </Space>
          }
        >
          {result.hits.length ? (
            <Flex gap={6} wrap>
              {result.hits.map((hit) => (
                <Tag key={hit} color="blue" variant="filled" style={{ fontFamily: MONO }}>
                  {hit}
                </Tag>
              ))}
            </Flex>
          ) : (
            <Typography.Text type="secondary">该区间与任何特征都不重叠</Typography.Text>
          )}
          <ResultActions
            title={`区域重叠 · ${contig}:${start}-${end}`}
            body={[
              `## 区域重叠（${result.algorithm}）`,
              `- 查询区间：${contig}:${start}-${end}（1-based 闭区间）`,
              `- 内部区间：[${result.internal_interval.start}, ${result.internal_interval.end})`,
              `- 特征数：${parsed.rows.length}`,
              `- 重叠命中：${result.hits.length} 个`,
              '',
              result.hits.length ? result.hits.join('\n') : '（无重叠）',
            ].join('\n')}
            loc={`${contig}:${start}-${end}`}
            onLocate={onLocate}
            category="生信"
            tags={['区间', 'rust-bio']}
          />
        </Card>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="填写特征区间后点「查询重叠」" />
      )}
    </Flex>
  );
}

function ExtractPanel({
  annotationId,
  seed,
  seedRegion,
  onUseSequence,
}: {
  annotationId?: string;
  seed?: SeedSeq | null;
  seedRegion?: SeedRegion | null;
  onUseSequence?: (seq: string, target: 'align' | 'blast', from: string) => void;
}) {
  const { message } = App.useApp();
  const [seqType, setSeqType] = useState('TRANSCRIPT_CDS');
  const [identifiers, setIdentifiers] = useState('');
  const [intervalSeqid, setIntervalSeqid] = useState('');
  const [intervalStart, setIntervalStart] = useState(1);
  const [intervalEnd, setIntervalEnd] = useState(1000);
  const [flank, setFlank] = useState(1000);
  const [policy, setPolicy] = useState<'all' | 'canonical' | 'longest'>('all');
  const [items, setItems] = useState<ExtractedSequence[] | null>(null);
  const [running, setRunning] = useState(false);

  const isInterval = seqType === 'GENOMIC_INTERVAL';
  // 上游工具（区域重叠 / 基因检索）送来的 ID 或区间直接预填
  useEffect(() => {
    if (seedRegion) {
      setSeqType('GENOMIC_INTERVAL');
      setIntervalSeqid(seedRegion.seqid);
      setIntervalStart(seedRegion.start);
      setIntervalEnd(seedRegion.end);
    }
  }, [seedRegion]);
  useEffect(() => {
    if (seed?.value) setIdentifiers(seed.value);
  }, [seed]);
  const isFlank = seqType === 'UPSTREAM' || seqType === 'DOWNSTREAM';
  const ids = useMemo(
    () => identifiers.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 200),
    [identifiers],
  );

  const run = async () => {
    if (!annotationId) {
      message.warning('请先选择注释版本');
      return;
    }
    const body = {
      annotation_id: annotationId,
      sequence_type: seqType,
      multi_transcript_policy: policy,
      format: 'json' as const,
      ...(isInterval
        ? { interval_seqid: intervalSeqid.trim(), interval_start_1: intervalStart, interval_end_1: intervalEnd }
        : { identifiers: ids }),
      ...(isFlank ? (seqType === 'UPSTREAM' ? { upstream_bp: flank } : { downstream_bp: flank }) : {}),
    };
    setRunning(true);
    try {
      const res = await api.genomeExtract(body);
      setItems(res.items ?? []);
      message.success(`提取完成，共 ${res.items?.length ?? 0} 条`);
    } catch (e) {
      message.error(`提取失败：${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Flex vertical gap={12}>
      <Alert
        type="info"
        showIcon
        title="按注释提取序列"
        description="CDS / cDNA / 蛋白 / 基因基因组段 / 上下游 flank / 染色体区间都由 CropGenome 按所选注释版本生成。"
      />
      <Flex gap={12} wrap align="flex-start">
        <Flex vertical gap={8} style={{ flex: '1 1 340px' }}>
          <Select
            value={seqType}
            onChange={setSeqType}
            options={SEQUENCE_TYPES.map((t) => ({ value: t.value, label: `${t.label} — ${t.hint}` }))}
          />
          <Select
            value={policy}
            onChange={setPolicy}
            disabled={isInterval}
            options={[
              { value: 'all', label: '多转录本：全部返回' },
              { value: 'canonical', label: '多转录本：仅 canonical' },
              { value: 'longest', label: '多转录本：最长转录本' },
            ]}
          />
          {isInterval ? (
            <Space size={6} wrap>
              <Input
                prefix="seqid"
                value={intervalSeqid}
                onChange={(e) => setIntervalSeqid(e.target.value)}
                placeholder="chr1"
                style={{ width: 190 }}
              />
              <InputNumber prefix="start" min={1} value={intervalStart} onChange={(v) => setIntervalStart(Number(v ?? 1))} />
              <InputNumber prefix="end" min={1} value={intervalEnd} onChange={(v) => setIntervalEnd(Number(v ?? 1))} />
            </Space>
          ) : (
            <Input.TextArea
              value={identifiers}
              onChange={(e) => setIdentifiers(e.target.value)}
              autoSize={{ minRows: 4, maxRows: 8 }}
              placeholder="每行一个 ID，也支持空格 / 逗号 / 分号分隔，单次最多 200 个"
              style={{ fontFamily: MONO }}
            />
          )}
          {isFlank ? (
            <InputNumber
              prefix={`${seqType === 'UPSTREAM' ? 'upstream' : 'downstream'}_bp`}
              min={1}
              max={100000}
              value={flank}
              onChange={(v) => setFlank(Number(v ?? 1000))}
              style={{ width: 220 }}
            />
          ) : null}
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={running}
            disabled={!annotationId || (!isInterval && ids.length === 0)}
            onClick={run}
          >
            提取序列
          </Button>
        </Flex>
        <div style={{ flex: '2 1 460px', minWidth: 280 }}>
          {items === null ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择类型并填写标识后提取" />
          ) : items.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有提取到序列" />
          ) : (
            <Flex vertical gap={8}>
              <Flex align="center" justify="space-between">
                <Typography.Text strong>共 {items.length} 条</Typography.Text>
                <CopyButton
                  text={items.map((it) => `>${it.fasta_id}\n${it.sequence}`).join('\n')}
                />
              </Flex>
              {items.slice(0, 40).map((it) => (
                <div key={it.fasta_id}>
                  <Typography.Text code style={{ fontFamily: MONO }}>{`>${it.fasta_id}`}</Typography.Text>
                  <Input.TextArea
                    readOnly
                    value={it.sequence}
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    style={{ fontFamily: MONO, fontSize: 12, marginTop: 4 }}
                  />
                </div>
              ))}
              {items.length > 40 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  仅展示前 40 条，完整结果请使用「复制」导出 FASTA。
                </Typography.Text>
              ) : null}
              <ResultActions
                title={`序列提取 · ${SEQUENCE_TYPES.find((t) => t.value === seqType)?.label ?? seqType}`}
                body={items.map((it) => `>${it.fasta_id}\n${it.sequence}`).join('\n')}
                category="生信"
                tags={['FASTA', '序列提取']}
              />
              {onUseSequence && items.length ? (
                <Space size={6} wrap>
                  <Button size="small" onClick={() => onUseSequence(items[0].sequence, 'align', `提取 ${items[0].fasta_id}`)}>
                    把首条送去比对
                  </Button>
                  <Button size="small" onClick={() => onUseSequence(items[0].sequence, 'blast', `提取 ${items[0].fasta_id}`)}>
                    把首条送去 BLAST
                  </Button>
                </Space>
              ) : null}
            </Flex>
          )}
        </div>
      </Flex>
    </Flex>
  );
}

function GenesPanel({
  annotationId,
  onUseRegion,
  onLocate,
}: {
  annotationId?: string;
  onUseRegion?: (region: SeedRegion) => void;
  onLocate?: (loc: string) => void;
}) {
  const { message } = App.useApp();
  const [keyword, setKeyword] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<string[]>([]);
  const genes = useQuery({
    queryKey: ['cg-genes', annotationId, submitted, cursor],
    queryFn: () => api.genomeGenes({ annotationId: annotationId!, q: submitted || undefined, cursor, limit: 20 }),
    enabled: !!annotationId,
    placeholderData: (prev) => prev,
  });

  if (!annotationId) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先在上方选择物种 → assembly → 注释版本" />;
  }

  const rows = genes.data?.items ?? [];
  const next = genes.data?.next_cursor ?? undefined;

  return (
    <Flex vertical gap={12}>
      <Alert
        type="info"
        showIcon
        title="基因检索"
        description="按当前注释版本检索 Gene ID / 别名 / 描述关键词；不会跨注释版本混查。"
      />
      <Flex gap={8} wrap>
        <Input.Search
          allowClear
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onSearch={(v) => {
            setSubmitted(v.trim());
            setCursor(undefined);
            setHistory([]);
          }}
          placeholder="Gene ID / 别名 / 描述关键词"
          style={{ width: 420 }}
        />
        <Button icon={<ReloadOutlined />} loading={genes.isFetching} onClick={() => genes.refetch()}>
          刷新
        </Button>
      </Flex>
      <Table<GenomeGene>
        size="small"
        rowKey="id"
        loading={genes.isFetching}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: submitted ? '没有匹配的基因' : '输入关键词开始检索' }}
        columns={[
          { title: 'Gene ID', dataIndex: 'stable_id', width: 200, render: (v) => <span style={{ fontFamily: MONO }}>{v}</span> },
          {
            title: '位置',
            key: 'loc',
            render: (_: unknown, r) => `${r.seqid}:${r.start_1.toLocaleString()}–${r.end_1.toLocaleString()}`,
          },
          {
            title: '链',
            dataIndex: 'strand',
            width: 80,
            render: (v: string) => (
              <Tag color={v === '-' ? 'volcano' : v === '+' ? 'blue' : 'default'} variant="filled">
                {v || '—'}
              </Tag>
            ),
          },
          {
            title: '长度',
            key: 'len',
            width: 110,
            render: (_: unknown, r) => `${(r.end_1 - r.start_1 + 1).toLocaleString()} bp`,
          },
          { title: '类型', dataIndex: 'biotype', width: 120, render: (v) => v || '—' },
          { title: '描述', dataIndex: 'description', ellipsis: true, render: (v) => v || '—' },
          {
            title: '操作',
            key: 'ops',
            width: 190,
            render: (_: unknown, r) => (
              <Space size={0}>
                <Button
                  size="small"
                  type="link"
                  icon={<CopyOutlined />}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(r.stable_id);
                      message.success('已复制 Gene ID');
                    } catch {
                      message.error('浏览器拒绝了剪贴板写入');
                    }
                  }}
                />
                <Button
                  size="small"
                  type="link"
                  onClick={() =>
                    onUseRegion?.({ seqid: r.seqid, start: r.start_1, end: r.end_1, from: r.stable_id })
                  }
                >
                  提取序列
                </Button>
                {onLocate ? (
                  <Button
                    size="small"
                    type="link"
                    onClick={() => onLocate(`${r.seqid}:${r.start_1}-${r.end_1}`)}
                  >
                    定位
                  </Button>
                ) : null}
              </Space>
            ),
          },
        ]}
      />
      <Flex gap={8} align="center">
        <Button
          size="small"
          disabled={!history.length}
          onClick={() => {
            const prev = [...history];
            const last = prev.pop();
            setHistory(prev);
            setCursor(last);
          }}
        >
          上一页
        </Button>
        <Button
          size="small"
          disabled={!next}
          onClick={() => {
            if (cursor) setHistory((h) => [...h, cursor]);
            else setHistory((h) => [...h, '']);
            setCursor(next);
          }}
        >
          下一页
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          当前每页 20 条
        </Typography.Text>
      </Flex>
      {rows.length ? (
        <ResultActions
          title={`基因检索 · ${submitted || '当前注释全部基因'}`}
          body={[
            `## 基因检索（注释 ${annotationId}）`,
            `- 关键词：${submitted || '（空，返回当前页）'}`,
            `- 本页：${rows.length} 条`,
            '',
            '| Gene ID | 位置 | 链 | 长度 | 类型 | 描述 |',
            '| --- | --- | --- | --- | --- | --- |',
            ...rows.map(
              (g) =>
                `| ${g.stable_id} | ${g.seqid}:${g.start_1}-${g.end_1} | ${g.strand || '—'} | ${
                  g.end_1 - g.start_1 + 1
                } bp | ${g.biotype || '—'} | ${(g.description || '—').replace(/\|/g, '/')} |`,
            ),
          ].join('\n')}
          category="生信"
          tags={['基因', '注释']}
        />
      ) : null}
    </Flex>
  );
}

function ResolvePanel({
  annotationId,
  annotations,
}: {
  annotationId?: string;
  annotations: GenomeAnnotation[];
}) {
  const { message } = App.useApp();
  const [kind, setKind] = useState<'resolve' | 'map'>('resolve');
  const [text, setText] = useState('');
  const [matchType, setMatchType] = useState<'exact' | 'alias'>('exact');
  const [sourceNs, setSourceNs] = useState('');
  const [targetNs, setTargetNs] = useState('');
  const [targetAnnotation, setTargetAnnotation] = useState<string>();
  const [items, setItems] = useState<IdResolveItem[] | null>(null);
  const [mapped, setMapped] = useState<IdMapItem[] | null>(null);
  const [running, setRunning] = useState(false);

  const ids = useMemo(
    () => text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 500),
    [text],
  );
  const annotationNames = useMemo(
    () => new Map(annotations.map((a) => [a.id, a.annotation_name])),
    [annotations],
  );
  const mapReady =
    !!annotationId &&
    !!targetAnnotation &&
    !!sourceNs.trim() &&
    !!targetNs.trim() &&
    ids.length > 0;

  const run = async () => {
    if (!ids.length) {
      message.warning('请先粘贴 ID');
      return;
    }
    setRunning(true);
    try {
      if (kind === 'resolve') {
        const res = await api.genomeResolveIds({ ids, annotation_id: annotationId, match_type: matchType });
        setItems(res.items ?? []);
      } else {
        const res = await api.genomeMapIds({
          inputs: ids,
          source_namespace: sourceNs.trim(),
          target_namespace: targetNs.trim(),
          source_annotation_id: annotationId!,
          target_annotation_id: targetAnnotation!,
        });
        setMapped(res.items ?? []);
      }
    } catch (e) {
      message.error(`${kind === 'resolve' ? '解析' : '映射'}失败：${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Flex vertical gap={12}>
      <Alert
        type="info"
        showIcon
        title={kind === 'resolve' ? '批量 ID 解析' : '跨注释 ID 映射'}
        description={
          kind === 'resolve'
            ? '在本服务内解析 Gene / Transcript ID 与别名，不会把输入写入日志正文。'
            : '只走已导入的 identifier_edges；缺乏可信证据时返回 UNSUPPORTED_MAPPING_EVIDENCE，不会用序列相似度冒充同源关系。'
        }
      />
      <Radio.Group
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        optionType="button"
        options={[
          { value: 'resolve', label: '解析 / 转 ID' },
          { value: 'map', label: '跨注释映射' },
        ]}
      />
      <Flex gap={12} wrap align="flex-start">
        <Flex vertical gap={8} style={{ flex: '1 1 360px' }}>
          <Input.TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoSize={{ minRows: 6, maxRows: 12 }}
            placeholder={'每行一个 ID，例如\nAT1G01010\nAT1G01020.1'}
            style={{ fontFamily: MONO }}
          />
          {kind === 'resolve' ? (
            <Flex gap={8} wrap align="center">
              <Select
                size="small"
                value={matchType}
                onChange={setMatchType}
                options={[
                  { value: 'exact', label: 'exact' },
                  { value: 'alias', label: 'alias' },
                ]}
                style={{ width: 120 }}
              />
              <Button type="primary" loading={running} disabled={!annotationId || !ids.length} onClick={run}>
                {ids.length ? `解析 ${ids.length} 个 ID` : '解析'}
              </Button>
              {!annotationId ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  需要先选择注释版本
                </Typography.Text>
              ) : null}
            </Flex>
          ) : (
            <Flex gap={8} wrap align="center">
              <Select
                size="small"
                style={{ width: 230 }}
                placeholder="目标注释"
                value={targetAnnotation}
                onChange={setTargetAnnotation}
                options={annotations
                  .filter((a) => a.id !== annotationId)
                  .map((a) => ({ value: a.id, label: a.annotation_name }))}
              />
              <Input
                size="small"
                prefix="源"
                value={sourceNs}
                onChange={(e) => setSourceNs(e.target.value)}
                placeholder="如 Zm00001eb.1"
                style={{ width: 170 }}
              />
              <Input
                size="small"
                prefix="目标"
                value={targetNs}
                onChange={(e) => setTargetNs(e.target.value)}
                placeholder="如 Zm00001eb.2"
                style={{ width: 170 }}
              />
              <Button type="primary" loading={running} disabled={!mapReady} onClick={run}>
                映射 {ids.length ? `${ids.length} 个 ID` : 'ID'}
              </Button>
            </Flex>
          )}
          {kind === 'map' && !annotations.some((a) => a.id !== annotationId) ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              跨注释映射至少需要两个已发布注释版本。
            </Typography.Text>
          ) : null}
        </Flex>
        <div style={{ flex: '2 1 460px', minWidth: 280 }}>
          {kind === 'map' ? (
            mapped === null ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="粘贴 ID，选择源/目标注释与 namespace 后映射" />
            ) : (
              <Table<IdMapItem>
                size="small"
                rowKey={(r, i) => `${r.input}-${i}`}
                dataSource={mapped}
                pagination={{ pageSize: 20, showSizeChanger: false }}
                locale={{ emptyText: '没有映射结果' }}
                columns={[
                  { title: '输入', dataIndex: 'input', width: 180, render: (v) => <span style={{ fontFamily: MONO }}>{v}</span> },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    width: 150,
                    render: (v: string) => {
                      const meta = RESOLVE_STATUS[v] ?? { color: 'default', text: v };
                      return <Tag color={meta.color} variant="filled">{meta.text}</Tag>;
                    },
                  },
                  {
                    title: '目标（namespace · annotation）',
                    key: 'outputs',
                    render: (_: unknown, r) => {
                      const outputs = r.outputs ?? [];
                      if (!outputs.length) return <Typography.Text type="secondary">—</Typography.Text>;
                      return (
                        <Flex gap={4} wrap>
                          {outputs.map((o) => (
                            <Tag key={`${o.annotation_id}-${o.identifier}`} color="purple" variant="filled">
                              {o.identifier}
                              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                                {' '}· {o.namespace}
                                {annotationNames.has(o.annotation_id) ? ` · ${annotationNames.get(o.annotation_id)}` : ''}
                              </Typography.Text>
                            </Tag>
                          ))}
                        </Flex>
                      );
                    },
                  },
                  {
                    title: '证据',
                    key: 'edges',
                    render: (_: unknown, r) => {
                      const edges = r.edges ?? [];
                      if (!edges.length) return <Typography.Text type="secondary">无</Typography.Text>;
                      return (
                        <Flex vertical gap={0}>
                          {edges.map((edge, i) => (
                            <Typography.Text key={i} style={{ fontSize: 12 }}>
                              {edge.relationship_type} · {edge.evidence_source}（{edge.confidence_class}）
                              {edge.mapping_release ? ` · ${edge.mapping_release}` : ''}
                            </Typography.Text>
                          ))}
                        </Flex>
                      );
                    },
                  },
                ]}
              />
            )
          ) : items === null ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="粘贴 ID 后解析" />
          ) : (
            <Table<IdResolveItem>
              size="small"
              rowKey={(r, i) => `${r.input}-${i}`}
              dataSource={items}
              pagination={{ pageSize: 20, showSizeChanger: false }}
              expandable={{
                rowExpandable: (r) => (r.candidates?.length ?? 0) > 1,
                expandedRowRender: (r) => (
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {(r.candidates ?? []).map((c) => (
                      <li key={`${c.annotation_id}-${c.entity_kind}-${c.entity_pk}`}>
                        <Tag variant="filled">{c.entity_kind}</Tag>
                        <span style={{ fontFamily: MONO }}>{c.stable_id}</span> · {c.namespace} · {c.match_type}
                      </li>
                    ))}
                  </ul>
                ),
              }}
              columns={[
                { title: '输入', dataIndex: 'input', width: 200, render: (v) => <span style={{ fontFamily: MONO }}>{v}</span> },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 130,
                  render: (v: string) => {
                    const meta = RESOLVE_STATUS[v] ?? { color: 'default', text: v };
                    return <Tag color={meta.color} variant="filled">{meta.text}</Tag>;
                  },
                },
                {
                  title: '命中实体',
                  key: 'hit',
                  render: (_: unknown, r) => {
                    const hits = r.candidates ?? [];
                    if (!hits.length) return <Typography.Text type="secondary">无命中</Typography.Text>;
                    return (
                      <Flex gap={4} wrap>
                        {hits.map((c) => (
                          <Tag
                            key={`${c.annotation_id}-${c.entity_kind}-${c.entity_pk}`}
                            color={c.entity_kind === 'gene' ? 'blue' : 'purple'}
                            variant="filled"
                          >
                            {c.stable_id}
                          </Tag>
                        ))}
                      </Flex>
                    );
                  },
                },
              ]}
            />
          )}
          {items?.length ? (
            <ResultActions
              title="ID 解析结果"
              body={[
                '## ID 解析',
                '',
                '| 输入 | 状态 | 命中实体 |',
                '| --- | --- | --- |',
                ...items.map(
                  (r) =>
                    `| ${r.input} | ${r.status} | ${(r.candidates ?? [])
                      .map((c) => `${c.stable_id}(${c.entity_kind})`)
                      .join('、') || '—'} |`,
                ),
              ].join('\n')}
              category="生信"
              tags={['ID 解析', '注释']}
            />
          ) : null}
        </div>
      </Flex>
    </Flex>
  );
}

function HspTable({ jobId, hitId }: { jobId: string; hitId: string }) {
  const hsps = useQuery({
    queryKey: ['cg-blast-hsps', jobId, hitId],
    queryFn: () => api.genomeBlastJobHsps(jobId, hitId),
  });
  const items = hsps.data?.items ?? [];
  return (
    <Table<BlastHsp>
      size="small"
      rowKey="hsp_rank"
      loading={hsps.isLoading}
      dataSource={items}
      pagination={false}
      locale={{ emptyText: '该 hit 没有 HSP 记录' }}
      scroll={{ x: 640 }}
      expandable={{
        rowExpandable: (h) => !!(h.query_aligned && h.subject_aligned),
        expandedRowRender: (h) => {
          const q = h.query_aligned ?? '';
          const s = h.subject_aligned ?? '';
          return (
            <pre style={{ margin: 0, fontFamily: MONO, fontSize: 12, lineHeight: 1.5, overflowX: 'auto' }}>
              {q}
              {'\n'}
              {midline(q, s)}
              {'\n'}
              {s}
            </pre>
          );
        },
      }}
      columns={[
        { title: 'HSP', dataIndex: 'hsp_rank', width: 60 },
        {
          title: 'Query 区间',
          key: 'q',
          render: (_: unknown, h) => `${h.query_start_1}–${h.query_end_1} ${h.query_strand ?? ''}`.trim(),
        },
        {
          title: 'Subject 区间',
          key: 's',
          render: (_: unknown, h) => `${h.subject_start_1}–${h.subject_end_1} ${h.subject_strand ?? ''}`.trim(),
        },
        { title: 'pident', dataIndex: 'pident', width: 80, render: (v) => fmtCoverage(v) },
        { title: 'len', dataIndex: 'align_length', width: 70, render: (v) => v ?? '—' },
        { title: 'E-value', dataIndex: 'evalue', width: 100, render: (v) => fmtEvalue(v) },
        { title: 'bitscore', dataIndex: 'bitscore', width: 90, render: (v) => fmtBitscore(v) },
        { title: 'frame', dataIndex: 'frame', width: 70, render: (v) => v || '—' },
      ]}
    />
  );
}

function BlastResults({ jobId, open, onClose }: { jobId?: string; open: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const [queryId, setQueryId] = useState<string>();
  const [sort, setSort] = useState<'bitscore' | 'evalue' | 'identity'>('bitscore');
  const [downloading, setDownloading] = useState<string>();

  const queries = useQuery({
    queryKey: ['cg-blast-queries', jobId],
    queryFn: () => api.genomeBlastJobQueries(jobId!),
    enabled: open && !!jobId,
  });
  const queryItems = queries.data?.items ?? [];

  useEffect(() => {
    if (!queryItems.length) return;
    if (!queryId || !queryItems.some((q) => q.internal_id === queryId)) {
      setQueryId(queryItems[0].internal_id);
    }
  }, [queryItems, queryId]);

  const hits = useQuery({
    queryKey: ['cg-blast-hits', jobId, queryId, sort],
    queryFn: () => api.genomeBlastJobHits(jobId!, { queryId, limit: 200, sort }),
    enabled: open && !!jobId && !!queryId,
    placeholderData: (prev) => prev,
  });
  const hitItems: BlastHit[] = hits.data?.items ?? [];

  const download = async (kind: 'tsv' | 'json' | 'fasta') => {
    if (!jobId) return;
    setDownloading(kind);
    try {
      const blob = await api.genomeBlastDownload(jobId, kind);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${jobId.slice(0, 12)}.${kind}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      message.error(`下载失败：${(e as Error).message}`);
    } finally {
      setDownloading(undefined);
    }
  };

  return (
    <Drawer
      title={<span style={{ fontFamily: MONO, fontSize: 14 }}>BLAST 结果 · {(jobId ?? '').slice(0, 12)}</span>}
      size="min(1080px, 96vw)"
      open={open}
      onClose={onClose}
      destroyOnHidden
    >
      <Flex vertical gap={12}>
        <Flex gap={8} wrap align="center">
          <Select
            style={{ width: 360, maxWidth: '100%' }}
            placeholder="选择 query"
            loading={queries.isLoading}
            value={queryId}
            onChange={setQueryId}
            options={queryItems.map((q: BlastQuery) => ({
              value: q.internal_id,
              label: `${(q.original_header ?? q.internal_id).slice(0, 48)}（${q.length}${q.zero_hits ? ' · 无命中' : ''}）`,
            }))}
            notFoundContent={queries.isLoading ? '加载中…' : '没有 query 记录'}
          />
          <Select
            size="middle"
            style={{ width: 150 }}
            value={sort}
            onChange={setSort}
            options={[
              { value: 'bitscore', label: 'bitscore ↓' },
              { value: 'evalue', label: 'E-value ↑' },
              { value: 'identity', label: 'identity ↓' },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {hitItems.length} 个 hit
          </Typography.Text>
          <div style={{ flex: 1 }} />
          <Button size="small" icon={<DownloadOutlined />} loading={downloading === 'tsv'} onClick={() => download('tsv')}>
            规范化 TSV
          </Button>
          <Button size="small" icon={<DownloadOutlined />} loading={downloading === 'json'} onClick={() => download('json')}>
            完整 JSON
          </Button>
          <Button size="small" icon={<DownloadOutlined />} loading={downloading === 'fasta'} onClick={() => download('fasta')}>
            Subject FASTA
          </Button>
        </Flex>
        {hitItems.length ? (
          <ResultActions
            title={`BLAST 结果 · ${(queryItems.find((q) => q.internal_id === queryId)?.original_header ?? queryId ?? '').slice(0, 40)}`}
            body={[
              `## BLAST 结果（任务 ${(jobId ?? '').slice(0, 12)}）`,
              `- 排序：${sort}`,
              `- 命中：${hitItems.length} 个`,
              '',
              '| # | Subject | bitscore | E-value | query cov | subject cov | HSP |',
              '| --- | --- | --- | --- | --- | --- | --- |',
              ...hitItems
                .slice(0, 50)
                .map(
                  (h) =>
                    `| ${h.hit_rank} | ${h.subject_id} | ${h.best_bitscore ?? '—'} | ${h.best_evalue ?? '—'} | ${
                      h.query_coverage ?? '—'
                    } | ${h.subject_coverage ?? '—'} | ${h.hsp_count ?? '—'} |`,
                ),
            ].join('\n')}
            category="生信"
            tags={['BLAST']}
          />
        ) : null}
        {queries.isError ? (
          <Alert type="error" showIcon title="Query 列表加载失败" description={(queries.error as Error).message} />
        ) : null}
        {hits.isError ? (
          <Alert type="error" showIcon title="命中列表加载失败" description={(hits.error as Error).message} />
        ) : null}
        <Table<BlastHit>
          size="small"
          rowKey="id"
          loading={hits.isLoading || hits.isFetching}
          dataSource={hitItems}
          pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (n) => `共 ${n} 条` }}
          scroll={{ x: 760 }}
          locale={{ emptyText: queryId ? '该 query 没有命中' : '选择 query 后查看命中' }}
          expandable={{
            expandedRowRender: (h) => (jobId ? <HspTable jobId={jobId} hitId={h.id} /> : null),
          }}
          columns={[
            { title: '#', dataIndex: 'hit_rank', width: 55 },
            {
              title: 'Subject',
              dataIndex: 'subject_id',
              ellipsis: true,
              render: (v) => <span style={{ fontFamily: MONO, fontSize: 12 }}>{v}</span>,
            },
            { title: 'bitscore', dataIndex: 'best_bitscore', width: 95, render: (v) => fmtBitscore(v) },
            { title: 'E-value', dataIndex: 'best_evalue', width: 105, render: (v) => fmtEvalue(v) },
            { title: 'query cov', dataIndex: 'query_coverage', width: 105, render: (v) => fmtCoverage(v) },
            { title: 'subject cov', dataIndex: 'subject_coverage', width: 110, render: (v) => fmtCoverage(v) },
            { title: 'HSP', dataIndex: 'hsp_count', width: 70 },
          ]}
        />
      </Flex>
    </Drawer>
  );
}

function BlastPanel({ annotationId, seed }: { annotationId?: string; seed?: SeedSeq | null }) {
  const { message } = App.useApp();
  const [mode, setMode] = useState('blastp');
  const [databaseId, setDatabaseId] = useState<string>();
  const [queryFasta, setQueryFasta] = useState('');
  const [evalue, setEvalue] = useState(1e-5);
  const [maxTargets, setMaxTargets] = useState(50);
  const [sensitivity, setSensitivity] = useState('sensitive');
  const [running, setRunning] = useState(false);
  const [resultJobId, setResultJobId] = useState<string>();

  const databases = useQuery({
    queryKey: ['cg-blast-dbs', annotationId, mode],
    queryFn: () => api.genomeBlastDatabases(annotationId!, mode),
    enabled: !!annotationId,
  });
  const jobs = useQuery({
    queryKey: ['cg-blast-jobs'],
    queryFn: api.genomeBlastJobs,
    refetchInterval: 5000,
  });

  const usable = (databases.data?.items ?? []).filter((d: BlastDatabase) => d.usable);

  useEffect(() => {
    setDatabaseId(undefined);
  }, [mode, annotationId]);

  // 上游工具送来的序列：BLAST 只收 FASTA，裸序列补一个 header
  useEffect(() => {
    if (!seed?.value) return;
    setQueryFasta(seed.value.startsWith('>') ? seed.value : `>${seed.from || 'query'}\n${seed.value}`);
  }, [seed]);

  const run = async () => {
    if (!databaseId) {
      message.warning('请选择一个已就绪的数据库');
      return;
    }
    if (!queryFasta.trim()) {
      message.warning('请填写 query FASTA');
      return;
    }
    setRunning(true);
    try {
      const res = await api.genomeCreateBlastJob({
        mode,
        database_id: databaseId,
        query_fasta: queryFasta,
        evalue,
        max_target_seqs: maxTargets,
        sensitivity,
      });
      message.success(`任务已提交：${res.job_id}`);
      await jobs.refetch();
    } catch (e) {
      message.error(`提交失败：${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  const cancel = async (jobId: string) => {
    try {
      await api.genomeCancelBlastJob(jobId);
      message.success('已取消');
      await jobs.refetch();
    } catch (e) {
      message.error(`取消失败：${(e as Error).message}`);
    }
  };

  return (
    <Flex vertical gap={12}>
      <Alert
        type="info"
        showIcon
        title="BLAST / DIAMOND 任务"
        description="query 必须是 FASTA；任务异步执行，可在下方列表查看状态并取消未完成任务。"
      />
      <Flex gap={12} wrap align="flex-start">
        <Flex vertical gap={8} style={{ flex: '1 1 340px' }}>
          <Radio.Group
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            optionType="button"
            buttonStyle="solid"
            options={BLAST_MODES.map((m) => ({ value: m.value, label: `${m.label} · ${m.hint}` }))}
          />
          <Select
            value={databaseId}
            onChange={setDatabaseId}
            placeholder={annotationId ? '选择比对数据库' : '需要先选择注释版本'}
            disabled={!annotationId}
            loading={databases.isFetching}
            options={usable.map((d) => ({
              value: d.id,
              label: `${String(d.name ?? d.id)} · ${(d.supported_modes ?? []).join('/') || '—'}`,
            }))}
            notFoundContent={databases.isFetching ? '加载中…' : '没有已就绪的数据库'}
          />
          <Input.TextArea
            value={queryFasta}
            onChange={(e) => setQueryFasta(e.target.value)}
            autoSize={{ minRows: 6, maxRows: 12 }}
            placeholder={'>query_1\nMKTAYIAKQRQISFVKSHFSRQ...'}
            style={{ fontFamily: MONO }}
          />
          <Flex gap={8} wrap align="center">
            <InputNumber
              size="small"
              prefix="evalue"
              min={0}
              value={evalue}
              onChange={(v) => setEvalue(Number(v ?? 1e-5))}
              style={{ width: 160 }}
            />
            <InputNumber
              size="small"
              prefix="max_target_seqs"
              min={1}
              max={500}
              value={maxTargets}
              onChange={(v) => setMaxTargets(Number(v ?? 50))}
              style={{ width: 200 }}
            />
            <Select
              size="small"
              value={sensitivity}
              onChange={setSensitivity}
              options={[
                { value: 'fast', label: 'fast' },
                { value: 'sensitive', label: 'sensitive' },
                { value: 'more-sensitive', label: 'more-sensitive' },
              ]}
              style={{ width: 160 }}
            />
          </Flex>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={running}
            onClick={run}
            disabled={!annotationId}
          >
            提交任务
          </Button>
        </Flex>
        <div style={{ flex: '2 1 440px', minWidth: 280 }}>
          <Card
            size="small"
            title={
              <Flex align="center" gap={8}>
                <span>任务记录</span>
                <Tag variant="filled">{jobs.data?.items?.length ?? 0}</Tag>
              </Flex>
            }
            extra={
              <Button size="small" icon={<ReloadOutlined />} loading={jobs.isFetching} onClick={() => jobs.refetch()}>
                刷新
              </Button>
            }
          >
            <Table<BlastJob>
              size="small"
              rowKey="job_id"
              loading={jobs.isLoading}
              dataSource={jobs.data?.items ?? []}
              pagination={{ pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }}
              locale={{ emptyText: '还没有 BLAST 任务' }}
              scroll={{ x: 700 }}
              columns={[
                {
                  title: '任务',
                  dataIndex: 'job_id',
                  width: 150,
                  ellipsis: true,
                  render: (v) => <span style={{ fontFamily: MONO }}>{String(v).slice(0, 12)}…</span>,
                },
                { title: '模式', dataIndex: 'mode', width: 100, render: (v) => v || '—' },
                {
                  title: '状态',
                  dataIndex: 'status',
                  width: 110,
                  render: (v: string) => {
                    const meta = BLAST_STATUS[v] ?? { color: 'default', text: v || '—' };
                    return (
                      <Tag color={meta.color} variant="filled">
                        {meta.text}
                      </Tag>
                    );
                  },
                },
                {
                  title: '创建时间',
                  dataIndex: 'created_at',
                  width: 180,
                  render: (v) => (v ? new Date(v).toLocaleString('zh-CN') : '—'),
                },
                {
                  title: '操作',
                  key: 'ops',
                  width: 150,
                  render: (_: unknown, r) => (
                    <Flex gap={4} align="center">
                      <Button
                        size="small"
                        type="link"
                        disabled={!READY_JOB.includes(r.status)}
                        onClick={() => setResultJobId(r.job_id)}
                      >
                        查看结果
                      </Button>
                      {TERMINAL_JOB.includes(r.status) ? null : (
                        <Button size="small" danger type="link" onClick={() => cancel(r.job_id)}>
                          取消
                        </Button>
                      )}
                    </Flex>
                  ),
                },
              ]}
            />
          </Card>
        </div>
      </Flex>
      {resultJobId ? (
        <BlastResults jobId={resultJobId} open onClose={() => setResultJobId(undefined)} />
      ) : null}
    </Flex>
  );
}

export default function GenomeTools({ onLocate }: { onLocate?: (loc: string) => void }) {
  const screens = Grid.useBreakpoint();
  const [tool, setTool] = useState<'align' | 'motif' | 'region' | 'extract' | 'genes' | 'resolve' | 'blast'>('align');
  const [speciesId, setSpeciesId] = useState<string>();
  const [assemblyId, setAssemblyId] = useState<string>();
  const [annotationId, setAnnotationId] = useState<string>();
  const [seedSeq, setSeedSeq] = useState<SeedSeq | null>(null);
  const [seedRegion, setSeedRegion] = useState<SeedRegion | null>(null);

  // 工具之间互投：结果不必复制粘贴，直接落到下一个工具的输入框
  const useSequence = (seq: string, target: 'align' | 'blast', from: string) => {
    setSeedSeq({ value: seq, from, target });
    setTool(target);
  };
  const useRegion = (region: SeedRegion) => {
    setSeedRegion(region);
    setTool('extract');
  };

  const species = useQuery({ queryKey: ['cg-species'], queryFn: api.genomeSpecies, staleTime: 300_000 });
  const assemblies = useQuery({
    queryKey: ['cg-assemblies', speciesId],
    queryFn: () => api.genomeAssemblies(speciesId!),
    enabled: !!speciesId,
    staleTime: 300_000,
  });
  const annotations = useQuery({
    queryKey: ['cg-annotations', assemblyId],
    queryFn: () => api.genomeAnnotations(assemblyId!),
    enabled: !!assemblyId,
    staleTime: 60_000,
  });

  const speciesItems = species.data?.items ?? [];
  const assemblyItems = assemblies.data?.items ?? [];
  const annotationItems = annotations.data?.items ?? [];
  const published = annotationItems.filter((a: GenomeAnnotation) => a.status === 'published');

  useEffect(() => {
    if (!speciesId && speciesItems.length) setSpeciesId(speciesItems[0].id);
  }, [speciesId, speciesItems]);

  useEffect(() => {
    if (!assemblyId && assemblyItems.length) setAssemblyId(assemblyItems[0].id);
  }, [assemblyId, assemblyItems]);

  useEffect(() => {
    if (annotationId && !published.some((a) => a.id === annotationId)) setAnnotationId(undefined);
    if (!annotationId && published.length) setAnnotationId(published[0].id);
  }, [annotationId, published]);

  const needsAnnotation = tool === 'extract' || tool === 'genes' || tool === 'resolve' || tool === 'blast';

  const seedNote =
    tool === 'extract' && seedRegion && !seedSeq
      ? `已接收「区域重叠 / 基因检索」送来的区间：${seedRegion.seqid}:${seedRegion.start}-${seedRegion.end}（${seedRegion.from}）`
      : seedSeq && seedSeq.target === tool
        ? `已接收 ${seedSeq.from} 送来的序列，可直接执行本工具`
        : '';

  return (
    <Flex vertical gap={12}>
      <Card size="small" styles={{ body: { padding: '10px 14px' } }}>
        <Flex vertical gap={10}>
          <Flex gap={10} wrap align="center">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>参考数据</Typography.Text>
            <Select
              size="small"
              style={{ width: 210 }}
              placeholder="选择物种"
              loading={species.isLoading}
              value={speciesId}
              onChange={(v) => {
                setSpeciesId(v);
                setAssemblyId(undefined);
                setAnnotationId(undefined);
              }}
              showSearch={{ optionFilterProp: 'label' }}
              options={speciesItems.map((s) => ({
                value: s.id,
                label: `${s.common_name} ${s.scientific_name}`,
              }))}
              notFoundContent={species.isLoading ? '加载中…' : '尚未导入物种'}
            />
            <Select
              size="small"
              style={{ width: 250 }}
              placeholder={speciesId ? '选择 assembly' : '先选物种'}
              loading={assemblies.isFetching}
              disabled={!speciesId}
              value={assemblyId}
              onChange={(v) => {
                setAssemblyId(v);
                setAnnotationId(undefined);
              }}
              showSearch={{ optionFilterProp: 'label' }}
              options={assemblyItems.map((a) => ({
                value: a.id,
                label: `${a.cultivar} · ${a.assembly_name}`,
              }))}
              notFoundContent={assemblies.isFetching ? '加载中…' : '该物种没有 assembly'}
            />
            <Select
              size="small"
              style={{ width: 260 }}
              placeholder={assemblyId ? '选择注释版本' : '先选 assembly'}
              loading={annotations.isFetching}
              disabled={!assemblyId}
              value={annotationId}
              onChange={setAnnotationId}
              showSearch={{ optionFilterProp: 'label' }}
              options={annotationItems.map((a) => ({
                value: a.id,
                label: `${a.annotation_name}（${STATUS_LABEL[a.status] ?? a.status}）`,
                disabled: a.status !== 'published',
              }))}
              notFoundContent={annotations.isFetching ? '加载中…' : '该 assembly 没有注释'}
            />
            {annotationId ? (
              <Tag color="blue" variant="filled">含注释的操作已启用</Tag>
            ) : (
              <Tag variant="filled">未选注释</Tag>
            )}
          </Flex>
          {!speciesItems.length && !species.isLoading ? (
            <Alert
              type="warning"
              showIcon
              title="尚未导入参考物种"
              description="基因检索、ID 解析、序列提取与 BLAST 依赖已发布的注释数据；对齐 / 基序 / 区域重叠不依赖参考数据，可直接使用。"
            />
          ) : null}
        </Flex>
      </Card>

      <Card size="small" styles={{ body: { paddingTop: 8 } }}>
        {screens.md ? (
          <Segmented
            value={tool}
            onChange={(v) => setTool(v as typeof tool)}
            options={[...TOOL_OPTIONS]}
            block
          />
        ) : (
          <Select
            size="middle"
            style={{ width: '100%' }}
            value={tool}
            onChange={(v) => setTool(v as typeof tool)}
            options={[...TOOL_OPTIONS]}
          />
        )}
        <Divider style={{ margin: '12px 0' }} />
        {seedNote ? (
          <Alert type="info" showIcon style={{ marginBottom: 12 }} title={seedNote} />
        ) : null}
        {tool === 'align' ? <AlignPanel seed={seedSeq?.target === 'align' ? seedSeq : null} /> : null}
        {tool === 'motif' ? <MotifPanel /> : null}
        {tool === 'region' ? <RegionPanel assemblyId={assemblyId} onLocate={onLocate} /> : null}
        {tool === 'extract' ? (
          <ExtractPanel
            annotationId={annotationId}
            seed={seedSeq?.target === 'extract' ? seedSeq : null}
            seedRegion={seedRegion}
            onUseSequence={useSequence}
          />
        ) : null}
        {tool === 'genes' ? (
          <GenesPanel annotationId={annotationId} onUseRegion={useRegion} onLocate={onLocate} />
        ) : null}
        {tool === 'resolve' ? <ResolvePanel annotationId={annotationId} annotations={published} /> : null}
        {tool === 'blast' ? <BlastPanel annotationId={annotationId} seed={seedSeq?.target === 'blast' ? seedSeq : null} /> : null}
        {needsAnnotation && !annotationId ? (
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
            该工具需要注释版本；若上方为空，说明 CropGenome 还没有发布参考数据。
          </Typography.Text>
        ) : null}
      </Card>
    </Flex>
  );
}