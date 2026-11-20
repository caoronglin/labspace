import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Form,
  Image,
  Menu,
  Row,
  Segmented,
  Spin,
  Table,
  Tag,
  Typography,
  Upload,
  message,
  type MenuProps,
} from 'antd';
import {
  CloudUploadOutlined,
  ExperimentOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import PageShell from '../components/PageShell';
import ToolFieldInput, { type ToolField } from '../components/bio/ToolFieldInput';

/**
 * 生信工具：一个入口装下序列、克隆、引物、比对建树、测序批处理。
 *
 * 为什么是「一个页面 + 一张配置表」而不是二十个页面：这些操作都是
 * 「粘一段序列 → 出一份结果 → 后面几步接着用」的短流程，拆成二十个路由
 * 会让侧栏爆炸、也让「做完 A 想接着做 B」变成反复跳转。
 * 工具定义集中在 `TOOLS` 里，加一个能力只需要加一条配置。
 */

type Tool = {
  id: string;
  name: string;
  group: string;
  /** 一句话说明**这个工具解决什么问题**，不是复述名字 */
  summary: string;
  method: 'POST' | 'GET';
  path: string;
  fields: ToolField[];
  /** 结果怎么渲染 */
  render?: 'json' | 'alignment' | 'plasmid' | 'tree';
  /** 需要上传文件（multipart）的工具：用 Upload 而不是文本域 */
  upload?: { field: string; accept: string; hint: string };
  /** 教材式的用法提示 */
  tip?: string;
};

const MOLECULE_OPTIONS = [
  { label: 'DNA', value: 'dna' },
  { label: 'RNA', value: 'rna' },
  { label: '蛋白', value: 'protein' },
];

const TOOLS: Tool[] = [
  {
    id: 'sequence_analyze',
    name: '序列分析',
    group: '序列',
    summary: '一次给出长度 / GC / 反向互补 / 转录 / 三框翻译 / 分子量与等电点',
    method: 'POST',
    path: '/api/biotools/sequence/analyze',
    fields: [
      { name: 'sequence', label: '序列', kind: 'textarea', placeholder: 'ATGGCT...（可带 FASTA 头，自动去掉）' },
      { name: 'molecule', label: '分子类型', kind: 'select', value: 'dna', options: MOLECULE_OPTIONS },
      { name: 'frame', label: '算理化参数用哪个读框', kind: 'number', value: 1, min: 1, max: 3, hint: '三个读框的翻译都会返回' },
    ],
    tip: '粘进引物/基因序列就能看到三框翻译，先判断读框再往下做克隆。',
  },
  {
    id: 'orf',
    name: 'ORF 预测',
    group: '序列',
    summary: '六个读框里找开放阅读框，按最短氨基酸数过滤',
    method: 'POST',
    path: '/api/biotools/orf',
    fields: [
      { name: 'sequence', label: '序列', kind: 'textarea', placeholder: 'ATGGCT...' },
      { name: 'min_aa', label: '最短长度（aa）', kind: 'number', value: 50, min: 1 },
      { name: 'genetic_code', label: '遗传密码表', kind: 'select', value: 1, options: [{ label: '标准（1）', value: 1 }, { label: '线粒体（2）', value: 2 }] },
    ],
  },
  {
    id: 'gc_window',
    name: 'GC / 滑窗 / k-mer',
    group: '序列',
    summary: '滑动窗口 GC 曲线与 k-mer 频次，用来看序列组成是否异常',
    method: 'POST',
    path: '/api/biotools/gc/window',
    fields: [
      { name: 'sequence', label: '序列', kind: 'textarea' },
      { name: 'window', label: '窗口（bp）', kind: 'number', value: 100, min: 1 },
      { name: 'step', label: '步长（bp）', kind: 'number', value: 20, min: 1 },
      { name: 'k', label: 'k-mer 长度', kind: 'number', value: 4, min: 1, max: 8 },
    ],
  },
  {
    id: 'seq3_convert',
    name: '单/三字母 + 专利格式',
    group: '序列',
    summary: '氨基酸单字母↔三字母互转，并按专利要求分组排版',
    method: 'POST',
    path: '/api/biotools/seq3/convert',
    fields: [
      { name: 'sequence', label: '序列', kind: 'textarea', placeholder: 'MKVLAAG... 或 Met Lys Val' },
      { name: 'direction', label: '方向', kind: 'select', value: '1to3', options: [{ label: '单字母 → 三字母', value: '1to3' }, { label: '三字母 → 单字母', value: '3to1' }] },
      { name: 'patent_offset', label: '专利起始位移', kind: 'select', value: 0, options: [{ label: '0', value: 0 }, { label: '1', value: 1 }, { label: '2', value: 2 }] },
      { name: 'group_per_line', label: '每行分组排列', kind: 'switch', value: true },
    ],
  },
  {
    id: 'format_convert',
    name: '格式互转',
    group: '序列',
    summary: 'GenBank / FASTA / EMBL 互转（保留注释与序列）',
    method: 'POST',
    path: '/api/biotools/format/convert',
    fields: [
      { name: 'text', label: '序列文本', kind: 'textarea', placeholder: '把一个或多个记录的全文粘进来' },
      { name: 'from', label: '源格式', kind: 'select', value: 'genbank', options: [{ label: 'GenBank', value: 'genbank' }, { label: 'FASTA', value: 'fasta' }, { label: 'EMBL', value: 'embl' }] },
      { name: 'to', label: '目标格式', kind: 'select', value: 'fasta', options: [{ label: 'FASTA', value: 'fasta' }, { label: 'GenBank', value: 'genbank' }, { label: 'EMBL', value: 'embl' }] },
    ],
  },
  {
    id: 'cds_extract',
    name: 'CDS 提取',
    group: '克隆',
    summary: '从 GenBank 注释或按坐标区间提取编码序列并翻译',
    method: 'POST',
    path: '/api/biotools/cds/extract',
    fields: [
      { name: 'record', label: 'GenBank/EMBL 记录', kind: 'textarea', placeholder: '带 CDS 注释的 plasmid 记录' },
      { name: 'feature_type', label: '注释类型', kind: 'text', value: 'CDS' },
      { name: 'ids', label: '只要这些基因（留空=全部）', kind: 'list', hint: '逗号或换行分隔' },
    ],
  },
  {
    id: 'restriction',
    name: '限制性内切酶',
    group: '克隆',
    summary: '常用酶切位点、单切酶、不切酶——设计克隆方案前先看这张表',
    method: 'POST',
    path: '/api/biotools/restriction',
    fields: [
      { name: 'sequence', label: '序列', kind: 'textarea' },
      { name: 'enzymes', label: '限定酶（留空=内置 30 种）', kind: 'list', placeholder: 'EcoRI, BamHI' },
      { name: 'circular', label: '环状质粒', kind: 'switch', value: false },
    ],
    tip: '单切酶才适合单酶切线性化；双切酶要注意位点间距是否够跑胶。',
  },
  {
    id: 'vector_trim',
    name: '去载体序列',
    group: '克隆',
    summary: '把测序读段里的载体/接头片段比对出来并去掉',
    method: 'POST',
    path: '/api/biotools/vector/trim',
    fields: [
      { name: 'read', label: '测序读段', kind: 'textarea' },
      { name: 'vector', label: '载体序列', kind: 'textarea', placeholder: '载体或接头的参考序列' },
      { name: 'min_score', label: '最低匹配分', kind: 'number', value: 40, min: 1 },
    ],
  },
  {
    id: 'plasmid_map',
    name: '质粒图谱',
    group: '克隆',
    summary: '按 GenBank 注释直接画出环状/线状质粒图谱',
    method: 'POST',
    path: '/api/biotools/plasmid/map',
    render: 'plasmid',
    fields: [
      { name: 'record', label: 'GenBank 记录', kind: 'textarea', placeholder: 'LOCUS ... 带 feature 注释' },
      { name: 'topology', label: '拓扑', kind: 'select', value: 'circular', options: [{ label: '环状', value: 'circular' }, { label: '线状', value: 'linear' }] },
      { name: 'title', label: '标题（可空）', kind: 'text' },
    ],
  },
  {
    id: 'protein_params',
    name: '蛋白理化参数',
    group: '蛋白与引物',
    summary: '分子量 / 等电点 / GRAVY / 芳香性 / 不稳定指数 / 消光系数',
    method: 'POST',
    path: '/api/biotools/protein/params',
    fields: [{ name: 'sequence', label: '氨基酸序列', kind: 'textarea', placeholder: 'MKVLAAGIVGL...' }],
  },
  {
    id: 'primer_tm',
    name: '引物 Tm',
    group: '蛋白与引物',
    summary: 'Wallace / GC / 最近邻三种算法算解链温度',
    method: 'POST',
    path: '/api/biotools/primer/tm',
    fields: [
      { name: 'sequence', label: '引物序列', kind: 'textarea' },
      { name: 'method', label: '算法', kind: 'select', value: 'nn', options: [{ label: '最近邻 (NN)', value: 'nn' }, { label: 'GC 公式', value: 'gc' }, { label: 'Wallace', value: 'wallace' }] },
      { name: 'na_mM', label: 'Na⁺ (mM)', kind: 'number', value: 50, min: 0 },
      { name: 'primer_mM', label: '引物 (mM)', kind: 'number', value: 0.25, min: 0 },
    ],
    tip: '设计 qPCR 引物时用 NN 算法，与实际退火温度更接近。',
  },
  {
    id: 'primer_dilution',
    name: '引物稀释换算',
    group: '蛋白与引物',
    summary: '母液→工作液的取液量，给了 OD/质量时连母液浓度一起算',
    method: 'POST',
    path: '/api/biotools/primer/dilution',
    fields: [
      { name: 'stock_um', label: '母液浓度 (µM)', kind: 'number', value: 100, min: 0 },
      { name: 'working_um', label: '工作液浓度 (µM)', kind: 'number', value: 10, min: 0 },
      { name: 'volume_ul', label: '要配的体积 (µL)', kind: 'number', value: 1000, min: 1 },
      { name: 'mass_od', label: 'OD/质量（可空）', kind: 'number', min: 0, hint: '合成单上的 OD260 或 nmol 数' },
    ],
  },
  {
    id: 'align_pairwise',
    name: '双序列比对',
    group: '比对与进化',
    summary: '全局 / 局部 / 半全局比对，给比对串、一致度与空位数',
    method: 'POST',
    path: '/api/biotools/align/pairwise',
    render: 'alignment',
    fields: [
      { name: 'query', label: 'Query', kind: 'textarea' },
      { name: 'reference', label: 'Reference', kind: 'textarea' },
      { name: 'mode', label: '模式', kind: 'select', value: 'global', options: [{ label: '全局 (global)', value: 'global' }, { label: '局部 (local)', value: 'local' }, { label: '半全局 (semiglobal)', value: 'semiglobal' }] },
      { name: 'match', label: '匹配得分', kind: 'number', value: 2 },
      { name: 'mismatch', label: '错配罚分', kind: 'number', value: -1 },
      { name: 'gap_open', label: '开罚分', kind: 'number', value: -2 },
      { name: 'gap_extend', label: '延伸罚分', kind: 'number', value: -0.5 },
    ],
  },
  {
    id: 'align_multiple',
    name: '多序列比对',
    group: '比对与进化',
    summary: '星型渐进比对：以最长为参考合并成等长矩阵，给一致序列',
    method: 'POST',
    path: '/api/biotools/align/multiple',
    render: 'alignment',
    fields: [{ name: 'sequences', label: '序列（每行一条，或以 > 开头的 FASTA）', kind: 'textarea', placeholder: '>a\nATGC...\n>bb\nATGC...' }],
    tip: '这是渐进星型比对，不是 MSA 最优解；序列多且差异大时建议外部工具复核。',
  },
  {
    id: 'phylo_nj',
    name: 'NJ 进化树',
    group: '比对与进化',
    summary: '按一致度距离建邻接树，直接给 Newick',
    method: 'POST',
    path: '/api/biotools/phylo/nj',
    render: 'tree',
    fields: [{ name: 'sequences', label: '序列（每行一条，或以 > 开头的 FASTA）', kind: 'textarea' }],
  },
  {
    id: 'phylo_convert',
    name: '树格式转换',
    group: '比对与进化',
    summary: 'Newick → 文本树图 / 嵌套 JSON，方便嵌到自己脚本里',
    method: 'POST',
    path: '/api/biotools/phylo/convert',
    fields: [{ name: 'newick', label: 'Newick', kind: 'textarea', placeholder: '((a:0.1,b:0.2):0.3,c:0.4);' }],
  },
  {
    id: 'diversity_pcoa',
    name: 'PCoA 排序图',
    group: '比对与进化',
    summary: '距离矩阵做主坐标分析：坐标 + 各轴解释度',
    method: 'POST',
    path: '/api/biotools/diversity/pcoa',
    fields: [
      { name: 'ids', label: '样本名', kind: 'list', placeholder: 'S1, S2, S3' },
      { name: 'matrix', label: '距离矩阵（行用分号，列用逗号）', kind: 'textarea', placeholder: '0,1,2;1,0,3;2,3,0' },
    ],
  },
  {
    id: 'abi_parse',
    name: '.ab1 峰图解析',
    group: '测序与批处理',
    summary: '读 Sanger 峰图：碱基、平均质量、Mott 裁剪区间',
    method: 'POST',
    path: '/api/biotools/abi/parse',
    upload: { field: 'file', accept: '.ab1', hint: '.ab1 文件（≤1 MB）' },
    fields: [],
  },
  {
    id: 'seqio_filter',
    name: '序列批量筛选',
    group: '测序与批处理',
    summary: '按长度 / GC / 名称正则筛 FASTA 或 GenBank 里的记录',
    method: 'POST',
    path: '/api/biotools/seqio/filter',
    upload: { field: 'file', accept: '.fa,.fasta,.fna,.gb,.gbk,.embl', hint: 'FASTA / GenBank / EMBL（≤20 MB）' },
    fields: [
      { name: 'min_len', label: '最短长度', kind: 'number', min: 1 },
      { name: 'max_len', label: '最长长度', kind: 'number', min: 1 },
      { name: 'min_gc', label: 'GC 下限 (%)', kind: 'number', min: 0, max: 100 },
      { name: 'max_gc', label: 'GC 上限 (%)', kind: 'number', min: 0, max: 100 },
      { name: 'id_pattern', label: '名称正则', kind: 'text', placeholder: '^Chr' },
    ],
  },
  {
    id: 'entrez_search',
    name: 'NCBI 检索',
    group: '外部数据库',
    summary: '按关键词在 NCBI 库里检索，拿登录号（再配合「NCBI 取序列」）',
    method: 'GET',
    path: '/api/biotools/entrez/search',
    fields: [
      { name: 'db', label: '库', kind: 'select', value: 'nuccore', options: [{ label: '核酸 nuccore', value: 'nuccore' }, { label: '蛋白 protein', value: 'protein' }, { label: 'PubMed', value: 'pubmed' }] },
      { name: 'term', label: '检索式', kind: 'text', placeholder: '例如 BRD4 AND Arabidopsis' },
      { name: 'retmax', label: '最多返回条数', kind: 'number', value: 20, min: 1, max: 200 },
    ],
    tip: 'NCBI 需要外网；连不上时会在 3 秒内直接报错，不会让请求一直挂着。',
  },
  {
    id: 'entrez_fetch',
    name: 'NCBI 取序列',
    group: '外部数据库',
    summary: '按登录号取 GenBank/FASTA（内网无外网时会明确报错）',
    method: 'POST',
    path: '/api/biotools/entrez/fetch',
    fields: [
      { name: 'db', label: '库', kind: 'select', value: 'nuccore', options: [{ label: '核酸 nuccore', value: 'nuccore' }, { label: '蛋白 protein', value: 'protein' }] },
      { name: 'ids', label: '登录号', kind: 'list', placeholder: 'NC_000001.11' },
    ],
  },
  {
    id: 'blast',
    name: 'BLAST 比对',
    group: '外部数据库',
    summary: '把序列提到 NCBI 做 BLAST（内网无外网时会明确报错）',
    method: 'POST',
    path: '/api/biotools/blast',
    fields: [
      { name: 'sequence', label: '序列', kind: 'textarea' },
      { name: 'program', label: '程序', kind: 'select', value: 'blastn', options: [{ label: 'blastn', value: 'blastn' }, { label: 'blastp', value: 'blastp' }] },
      { name: 'database', label: '库', kind: 'text', value: 'nt' },
    ],
  },
];

const GROUP_ORDER = ['序列', '克隆', '蛋白与引物', '比对与进化', '测序与批处理', '外部数据库'];

/**
 * 请求端点白名单。
 *
 * 所有请求的 URL 只能来自 `TOOLS` 里声明过的那几条路径：不接受任何运行时
 * 拼出来的地址（哪怕它是从配置表里取的）。这样一个「加工具」的改动必须
 * 同时出现在清单里，也杜绝了把用户输入当 URL 用的写法。
 */
const ENDPOINTS: ReadonlySet<string> = new Set(TOOLS.map((t) => t.path));

function endpointOf(path: string): string {
  if (!ENDPOINTS.has(path)) {
    throw new Error(`未知的工具端点：${path}`);
  }
  return path;
}


function defaultsOf(tool: Tool): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of tool.fields) {
    out[f.name] = f.value ?? (f.kind === 'switch' ? false : f.kind === 'number' ? undefined : '');
  }
  return out;
}

/** 把表单值整成后端要的 JSON：空串不传、列表字段拆成数组。 */
function toPayload(tool: Tool, values: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  let scoring: Record<string, number> = {};
  for (const f of tool.fields) {
    if (f.showWhen && !f.showWhen(values)) continue;
    const raw = values[f.name];
    if (f.name === 'match' || f.name === 'mismatch' || f.name === 'gap_open' || f.name === 'gap_extend') {
      if (raw !== undefined && raw !== '') scoring[f.name] = Number(raw);
      continue;
    }
    if (f.kind === 'list') {
      const items = String(raw ?? '')
        .split(/[,\n]/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (items.length) body[f.name] = items;
      continue;
    }
    if (raw === '' || raw === undefined || raw === null) continue;
    body[f.name] = raw;
  }
  if (Object.keys(scoring).length) body.scoring = scoring;
  return body;
}

function ResultTable({ rows, columns }: { rows: Record<string, unknown>[]; columns: string[] }) {
  return (
    <Table
      size="small"
      pagination={{ pageSize: 20, hideOnSinglePage: true }}
      scroll={{ x: true }}
      rowKey={(_, index) => String(index)}
      dataSource={rows}
      columns={columns.map((c) => ({
        title: c,
        dataIndex: c,
        ellipsis: true,
        render: (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '')),
      }))}
    />
  );
}

/** 结果展示：优先把"数组对象"自动变成表格，剩下的原文放到折叠区。 */
function ResultView({ data, tool }: { data: unknown; tool: Tool }) {
  const pretty = useMemo(() => JSON.stringify(data, null, 2), [data]);
  const table = useMemo(() => {
    if (!data || typeof data !== 'object') return null;
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (Array.isArray(value) && value.length && typeof value[0] === 'object' && value[0] !== null) {
        const columns = Array.from(
          new Set(value.flatMap((row) => Object.keys(row as Record<string, unknown>))),
        ).slice(0, 12);
        return { key, rows: value as Record<string, unknown>[], columns };
      }
    }
    return null;
  }, [data]);

  const alignment = tool.render === 'alignment' ? (data as { aligned?: string[] }).aligned : undefined;

  return (
    <Flex vertical gap={12}>
      {alignment && alignment.length ? (
        <Card size="small" title="比对结果" styles={{ body: { padding: 12 } }}>
          <pre style={{ margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12, overflow: 'auto' }}>
            {alignment.join('\n')}
          </pre>
        </Card>
      ) : null}
      {table ? (
        <Card size="small" title={`结果表（${table.key}）`} styles={{ body: { padding: 8 } }}>
          <ResultTable rows={table.rows} columns={table.columns} />
        </Card>
      ) : null}
      <Card size="small" title="完整返回（JSON）" styles={{ body: { padding: 12 } }}>
        <pre style={{ margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12, maxHeight: 320, overflow: 'auto' }}>
          {pretty}
        </pre>
      </Card>
    </Flex>
  );
}

export default function BioTools() {
  const [toolId, setToolId] = useState(TOOLS[0].id);
  const [group, setGroup] = useState(GROUP_ORDER[0]);
  const [values, setValues] = useState<Record<string, unknown>>(() => defaultsOf(TOOLS[0]));
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const tool = useMemo(() => TOOLS.find((t) => t.id === toolId) ?? TOOLS[0], [toolId]);

  const pickTool = (next: Tool) => {
    setToolId(next.id);
    setValues(defaultsOf(next));
    setFile(null);
    setResult(null);
    setImageUrl('');
    setError('');
  };

  const groupItems: MenuProps['items'] = GROUP_ORDER.filter((g) => TOOLS.some((t) => t.group === g)).map(
    (g) => ({
      key: g,
      label: g,
      children: TOOLS.filter((t) => t.group === g).map((t) => ({ key: t.id, label: t.name })),
    }),
  );

  const submit = async () => {
    setBusy(true);
    setError('');
    setResult(null);
    setImageUrl('');
    try {
      const body = toPayload(tool, values);
      if (tool.upload) {
        // 上传类工具：文件走 multipart，其余条件放 query，和后端签名一致
        if (!file) throw new Error('请先选择文件');
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) qs.set(k, String(v));
        const target = endpointOf(tool.path);
        const res = await fetch(qs.toString() ? `${target}?${qs}` : target, {
          method: 'POST',
          credentials: 'include',
          headers: { 'X-CSRF-Token': readCsrf() },
          body: (() => {
            const form = new FormData();
            form.append(tool.upload.field, file);
            return form;
          })(),
        });
        const payload = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        if (!res.ok) throw new Error(payload?.detail || `请求失败（${res.status}）`);
        setResult(payload);
        return;
      }
      if (tool.render === 'plasmid') {
        const target = endpointOf(tool.path);
        const res = await fetch(`${target}?format=png`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
          throw new Error(payload?.detail || `请求失败（${res.status}）`);
        }
        const blob = await res.blob();
        setImageUrl(URL.createObjectURL(blob));
        return;
      }
      const target = endpointOf(tool.path);
      // GET 类工具（NCBI 检索）参数走 query string —— 后端签名就是 Query 参数
      const query = tool.method === 'GET' ? new URLSearchParams(
        Object.entries(body).map(([k, v]) => [k, String(v)]),
      ).toString() : '';
      const res = await fetch(query ? `${target}?${query}` : target, {
        method: tool.method,
        credentials: 'include',
        headers: tool.method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: tool.method === 'POST' ? JSON.stringify(body) : undefined,
      });
      const payload = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(payload?.detail || `请求失败（${res.status}）`);
      setResult(payload);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  };

  const setField = (name: string, value: unknown) => setValues((prev) => ({ ...prev, [name]: value }));

  return (
    <PageShell
      title="生信工具"
      description="序列·克隆·引物·比对建树·测序批处理，一个入口做完；结果能直接接下一步，不用下载再上传。"
      extra={
        <Flex gap={8}>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              setValues(defaultsOf(tool));
              setFile(null);
              setResult(null);
              setImageUrl('');
              setError('');
            }}
          >
            重置
          </Button>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={busy}
            onClick={() => void submit()}
            disabled={tool.upload ? !file : false}
          >
            运行
          </Button>
        </Flex>
      }
    >
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={6}>
          <Card size="small" styles={{ body: { padding: 8 } }}>
            <Segmented
              size="small"
              block
              value={group}
              onChange={(v) => {
                const next = String(v);
                setGroup(next);
                const first = TOOLS.find((t) => t.group === next);
                if (first) pickTool(first);
              }}
              options={GROUP_ORDER.filter((g) => TOOLS.some((t) => t.group === g))}
            />
            <Menu
              mode="inline"
              selectedKeys={[toolId]}
              defaultOpenKeys={[group]}
              style={{ borderInlineEnd: 'none', marginTop: 8 }}
              items={groupItems}
              onClick={({ key }) => {
                const next = TOOLS.find((t) => t.id === key);
                if (next) pickTool(next);
              }}
            />
          </Card>
        </Col>
        <Col xs={24} lg={18}>
          <Flex vertical gap={12}>
            <Card
              size="small"
              title={
                <Flex gap={8} align="center" wrap>
                  <ExperimentOutlined />
                  <span>{tool.name}</span>
                  <Tag variant="filled">{tool.group}</Tag>
                </Flex>
              }
              extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{tool.method} {tool.path}</Typography.Text>}
            >
              <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                {tool.summary}
              </Typography.Paragraph>
              {tool.tip ? (
                <Alert type="info" showIcon title={tool.tip} style={{ marginBottom: 12 }} />
              ) : null}
              {tool.upload ? (
                <Flex vertical gap={8} style={{ marginBottom: 12 }}>
                  <Upload
                    accept={tool.upload.accept}
                    maxCount={1}
                    beforeUpload={(f) => {
                      setFile(f);
                      return false;
                    }}
                    onRemove={() => setFile(null)}
                    fileList={file ? [{ uid: '1', name: file.name, size: file.size }] : []}
                  >
                    <Button icon={<CloudUploadOutlined />}>{tool.upload.hint}</Button>
                  </Upload>
                </Flex>
              ) : null}
              <Form layout="vertical" size="small">
                {tool.fields
                  .filter((f) => !f.showWhen || f.showWhen(values))
                  .map((f) => (
                    <Form.Item key={f.name} label={f.label} extra={f.hint} style={{ marginBottom: 12 }}>
                      <ToolFieldInput
                        field={f}
                        value={values[f.name]}
                        onChange={(v) => setField(f.name, v)}
                      />
                    </Form.Item>
                  ))}
              </Form>
            </Card>

            {error ? <Alert type="error" showIcon title="运行失败" description={error} /> : null}
            {busy ? (
              <Flex justify="center" style={{ padding: 24 }}>
                <Spin description="正在计算…">
                  <div style={{ width: 160, height: 40 }} />
                </Spin>
              </Flex>
            ) : null}
            {imageUrl ? (
              <Card size="small" title="质粒图谱" styles={{ body: { textAlign: 'center', padding: 12 } }}>
                <Image src={imageUrl} alt="质粒图谱" style={{ maxHeight: 520 }} />
              </Card>
            ) : null}
            {result ? <ResultView data={result} tool={tool} /> : null}
            {!result && !imageUrl && !busy && !error ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="填好参数后点「运行」，结果会显示在这里" />
            ) : null}
          </Flex>
        </Col>
      </Row>
    </PageShell>
  );
}

/** 读门户的 CSRF cookie：上传类请求要双提交。 */
function readCsrf(): string {
  const hit = document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='));
  return hit ? decodeURIComponent(hit.split('=')[1] ?? '') : '';
}

void message;
