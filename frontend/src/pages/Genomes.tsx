import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Flex,
  Input,
  Segmented,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CopyOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  ExportOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, type FileEntry, type SequenceAnalysis } from '../services/api';
import GenomeTools from '../components/genome/GenomeTools';
import ResultActions from '../components/genome/ResultActions';
import PageShell from '../components/PageShell';

/**
 * 公共基因组：把三件原本孤立的能力串到一条链路上
 *   1. 文件源 `genomes` —— 由 Go 核心按 ACL 过滤，只看得到有权限的基因组文件
 *   2. JBrowse 2 —— 已部署在 8091，nginx `/jbrowse/` 同源反代，浏览器无需跨域
 *   3. CropGenome Toolkit / rust-bio —— 门户以 OIDC 身份代理 `/cropgenome/api/...`，
 *      浏览器直接访问 8095 会被拒绝，必须走同源代理
 */

import { formatDateTime, formatSize } from '../utils/format';
const FASTA_EXTS = new Set(['fa', 'fna', 'fasta', 'fas', 'ffn', 'frn', 'faa']);

/** 整条染色体不适合在交互式面板里跑 ORF，截取前 20 kb 足够说明问题。 */
const MAX_BP = 20_000;

const SAMPLE = 'ATGGCCTCTAGAAGATTTAAACCGGGTTTACGCATGCATGCGGATCCTAGGCTAATCGATCGTAGCTAGCTAGGCTAACGTACGTAGCTAGCTAAGCTTGCGGCCGCGGATCCTCGAGTCGACGAGCTCGGTACCCGGGGATCCTCTAGAGTCGACCTGCAGGCATGCAAGCTTGGCGTAATCATGGTCATAGCTGTTTCCTGTGTGAAATTGTTATCCGCTCACAATTCCACACAACATACGAGCCGGAAGCATAAAGTGTAAAGCCTGGGGTGCCTAATGAGTGAGCTAACTCACATTAATTGCGTTGCGCTCACTGCCCGCTTTCCAGTCGGGAAACCTGTCGTGCCAGCTGCATTAATGAATCGGCCAACGCGCGGGGAGAGGCGGTTTGCGTATTGGGCGCTCTTCCGCTTCCTCGCTCACTGACTCGCTGCGCTCGGTCGTTCGGCTGCGGCGAGCGGTATCAGCTCACTCAAAGGCGGTAATACGGTTATCCACAGAATCAGGGGATAACGCAGGAAAGAACATGTGAGCAAAAGGCCAGCAAAAGGCCAGGAACCGTAAAAAGGCCGCGTTGCTGGCGTTTTTCCATAGGCTCCGCCCCCCTGACGAGCATCACAAAAATCGACGCTCAAGTCAGAGGTGGCGAAACCCGACAGGACTATAAAGATACCAGGCGTTTCCCCCTGGAAGCTCCCTCGTGCGCTCTCCTGTTCCGACCCTGCCGCTTACCGGATACCTGTCCGCCTTTCTCCCTTCGGGAAGCGTGGCGCTTTCTCATAGCTCACGCTGTAGGTATCTCAGTTCGGTGTAGGTCGTTCGCTCCAAGCTGGGCTGTGTGCACGAACCCCCCGTTCAGCCCGACCGCTGCGCCTTATCCGGTAACTATCGTCTTGAGTCCAACCCGGTAAGACACGACTTATCGCCACTGGCAGCAGCCACTGGTAACAGGATTAGCAGAGCGAGGTATGTAGGCGGTGCTACAGAGTTCTTGAAGTGGTGGCCTAACTACGGCTACACTAGAAGAACAGTATTTGGTATCTGCGCTCTGCTGAAGCCAGTTACCTTCGGAAAAAGAGTTGGTAGCTCTTGATCCGGCAAACAAACCACCGCTGGTAGCGGTGGTTTTTTTGTTTGCAAGCAGCAGATTACGCGCAGAAAAAAAGGATCTCAAGAAGATCCTTTGATCTTTTCTACGGGGTCTGACGCTCAGTGGAACGAAAACTCACGTTAAGGGATTTTGGTCATGAGATTATCAAAAAGGATCTTCACCTAGATCCTTTTAAATTAAAAATGAAGTTTTAAATCAATCTAAAGTATATATGAGTAAACTTGGTCTGACAGTTACCAATGCTTAATCAGTGAGGCACCTATCTCAGCGATCTGTCTATTTCGTTCATCCATAGTTGCCTGACTCCCCGTCGTGTAGATAACTACGATACGGGAGGGCTTACCATCTGGCCCCAGTGCTGCAATGATACCGCGAGACCCACGCTCACCGGCTCCAGATTTATCAGCAATAAACCAGCCAGCCGGAAGGGCCGAGCGCAGAAGTGGTCCTGCAACTTTATCCGCCTCCATCCAGTCTATTAATTGTTGCCGGGAAGCTAGAGTAAGTAGTTCGCCAGTTAATAGTTTGCGCAACGTTGTTGCCATTGCTACAGGCATCGTGGTGTCACGCTCGTCGTTTGGTATGGCTTCATTCAGCTCCGGTTCCCAACGATCAAGGCGAGTTACATGATCCCCCATGTTGTGCAAAAAAGCGGTTAGCTCCTTCGGTCCTCCGATCGTTGTCAGAAGTAAGTTGGCCGCAGTGTTATCACTCATGGTTATGGCAGCACTGCATAATTCTCTTACTGTCATGCCATCCGTAAGATGCTTTTCTGTGACTGGTGAGTACTCAACCAAGTCATTCTGAGAATAGTGTATGCGGCGACCGAGTTGCTCTTGCCCGGCGTCAATACGGGATAATACCGCGCCACATAGCAGAACTTTAAAAGTGCTCATCATTGGAAAACGTTCTTCGGGGCGAAAACTCTCAAGGATCTTACCGCTGTTGAGATCCAGTTCGATGTAACCCACTCGTGCACCCAACTGATCTTCAGCATCTTTTACTTTCACCAGCGTTTCTGGGTGAGCAAAAACAGGAAGGCAAAATGCCGCAAAAAAGGGAATAAGGGCGACACGGAAATGTTGAATACTCATACTCTTCCTTTTTCAATATTATTGAAGCATTTATCAGGGTTATTGTCTCATGAGCGGATACATATTTGAATGTATTTAGAAAAATAAACAAATAGGGGTTCCGCGCACATTTCCCCGAAAAGTGCCACCTGACGTCTAAGAAACCATTATTATCATGACATTAACCTATAAAAATAGGCGTATCACGAGGCCCTTTCGTCTTCAAGAATTCTCATGTTTGACAGCTTATCATCGATAAGCTAGCTTTCCTGTGTGAAATTGTTATCCGCTCACAATTCCACACAACATACGAGCCGGAAGCATAAAGTGTAAAGCCTGGGGTGCCTAATGAGTGAGCTAACTCACATTAATTGCGTTGCGCTCACTGCCCGCTTTCCAGTCGGGAAACCTGTCGTGCCAGCTGCATTAATGAATCGGCCAACGCGCGGGGAGAGGCGGTTTGCGTATTGGGCGCTCTTCCGCTTCCTCGCTCACTGACTCGCTGCGCTCGGTCGTTCGGCTGCGGCGAGCGGTATCAGCTCACTCAAAGGCGGTAATACGGTTATCCACAGAATCAGGGGATAACGCAGGAAAGAACATGTGAGCAAAAGGCCAGCAAAAGGCCAGGAACCGTAAAAAGGCCGCGTTGCTGGCGTTTTTCCATAGGCTCCGCCCCCCTGACGAGCATCACAAAAATCGACGCTCAAGTCAGAGGTGGCGAAACCCGACAGGACTATAAAGATACCAGGCGTTTCCCCCTGGAAGCTCCCTCGTGCGCTCTCCTGTTCCGACCCTGCCGCTTACCGGATACCTGTCCGCCTTTCTCCCTTCGGGAAGCGTGGCGCTTTCTCATAGCTCACGCTGTAGGTATCTCAGTTCGGTGTAGGTCGTTCGCTCCAAGCTGGGCTGTGTGCACGAACCCCCCGTTCAGCCCGACCGCTGCGCCTTATCCGGTAACTATCGTCTTGAGTCCAACCCGGTAAGACACGACTTATCGCCACTGGCAGCAGCCACTGGTAACAGGATTAGCAGAGCGAGGTATGTAGGCGGTGCTACAGAGTTCTTGAAGTGGTGGCCTAACTACGGCTACACTAGAAGAACAGTATTTGGTATCTGCGCTCTGCTGAAGCCAGTTACCTTCGGAAAAAGAGTTGGTAGCTCTTGATCCGGCAAACAAACCACCGCTGGTAGCGGTGGTTTTTTTGTTTGCAAGCAGCAGATTACGCGCAGAAAAAAAGGATCTCAAGAAGATCCTTTGATCTTTTCTACGGGGTCTGACGCTCAGTGGAACGAAAACTCACGTTAAGGGATTTTGGTCATGAGATTATCAAAAAGGATCTTCACCTAGATCCTTTTAAATTAAAAATGAAGTTTTAAATCAATCTAAAGTATATATGAGTAAACTTGGTCTGACAG';

const COLUMNS = [
  { title: '名称', dataIndex: 'name', key: 'name', ellipsis: true },
  { title: '大小', dataIndex: 'size', key: 'size', width: 110 },
  { title: '更新时间', dataIndex: 'modified', key: 'modified', width: 180 },
  { title: '操作', key: 'ops', width: 280 },
];

function isFasta(name: string) {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return FASTA_EXTS.has(ext);
}

/** 取文件里的第一条 FASTA 记录；普通纯文本也当一条序列处理。 */
function firstRecord(text: string) {
  const lines = text.split(/\r?\n/);
  const seq: string[] = [];
  let title = '';
  let sawHeader = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('>')) {
      if (sawHeader) break;
      sawHeader = true;
      title = line.slice(1).trim();
      continue;
    }
    if (sawHeader && line) seq.push(line);
  }
  if (!sawHeader) {
    return { title: '', sequence: text.replace(/[^A-Za-z]/g, '') };
  }
  return { title, sequence: seq.join('') };
}

export default function Genomes({ embedded = false }: { embedded?: boolean } = {}) {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [urlParams] = useSearchParams();
  const [view, setView] = useState<'browse' | 'analyze' | 'tools'>('browse');
  // 从文件存储直跳进来时携带的基因组文件名，用于顶部提示
  const [linkedName, setLinkedName] = useState('');
  const handledLink = useRef('');
  // 工具结果「在 JBrowse 查看」的定位区间：设置后浏览器视图直接跳到该位置
  const [loc, setLoc] = useState('');
  // 文件存储选中的 FASTA：交给 JBrowse 动态装配，而不是硬塞进 hg19 示例
  const [jbrowseFile, setJbrowseFile] = useState<{ id: string; name: string } | null>(null);
  const [sequence, setSequence] = useState(SAMPLE);
  const [seqName, setSeqName] = useState('示例序列');
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [loadingName, setLoadingName] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<SequenceAnalysis | null>(null);

  const jbrowseConfig = jbrowseFile
    ? `/genome-api/jbrowse/config?file_id=${encodeURIComponent(jbrowseFile.id)}`
    : '';
  const jbrowseSrc = jbrowseConfig
    ? `/jbrowse/index.html?config=${encodeURIComponent(jbrowseConfig)}`
    : loc
      ? `/jbrowse/index.html?loc=${encodeURIComponent(loc)}`
      : '/jbrowse/';

  const genomes = useQuery({
    queryKey: ['genomes-files'],
    queryFn: () => api.files('genomes', 'name', 'asc'),
    staleTime: 30_000,
  });
  const entries = useMemo(
    () => (genomes.data?.entries ?? []).filter((e) => !e.dir),
    [genomes.data],
  );
  const fastaEntries = useMemo(() => entries.filter((e) => isFasta(e.name)), [entries]);

  const runAnalysis = async (raw: string, label: string) => {
    const clean = raw.replace(/[^A-Za-z]/g, '').toUpperCase();
    if (!clean) {
      message.warning('请先输入 DNA 序列，或从公共基因组中选择一个 FASTA 文件');
      return;
    }
    setAnalyzing(true);
    try {
      const res = await api.genomeAnalyze(clean);
      setResult(res);
      setSeqName(label || '未命名序列');
      message.success(`${res.library} ${res.library_version} 分析完成`);
    } catch (e) {
      message.error(`分析失败：${(e as Error).message}`);
    } finally {
      setAnalyzing(false);
    }
  };

  const analyzeFile = async (entry: Pick<FileEntry, 'id' | 'name' | 'size'>) => {
    if (entry.size > 8 * 1024 * 1024) {
      message.warning('文件超过 8 MB，交互式分析只处理较小序列，请先截取目标区域');
      return;
    }
    setLoadingId(entry.id);
    setLoadingName(entry.name);
    try {
      const text = await api.fileText(entry.id);
      const { title, sequence: raw } = firstRecord(text);
      let seq = raw.replace(/[^A-Za-z]/g, '');
      if (!seq) {
        message.warning('文件里没有识别到可分析的核苷酸序列');
        return;
      }
      if (seq.length > MAX_BP) {
        message.info(`序列共 ${seq.length.toLocaleString()} bp，已截取前 ${MAX_BP.toLocaleString()} bp 分析`);
        seq = seq.slice(0, MAX_BP);
      }
      const label = `${entry.name}${title ? ` · ${title}` : ''}`;
      setSequence(seq);
      setSeqName(label);
      setView('analyze');
      await runAnalysis(seq, label);
    } catch (e) {
      message.error(`读取失败：${(e as Error).message}`);
    } finally {
      setLoadingId(null);
      setLoadingName('');
    }
  };

  // 文件存储行菜单 → /genomes?genome=<name>&gid=<id>&action=jbrowse|analyze
  useEffect(() => {
    const name = urlParams.get('genome');
    if (!name) return;
    const gid = urlParams.get('gid') || '';
    const action = urlParams.get('action') === 'analyze' ? 'analyze' : 'jbrowse';
    const key = `${gid}|${name}|${action}`;
    if (handledLink.current === key) return;
    if (!gid && !genomes.isFetched) return;
    handledLink.current = key;
    setLinkedName(name);
    const entry = entries.find((e) => (gid ? e.id === gid : e.name === name));
    const run = async () => {
      if (action === 'analyze') {
        if (entry) await analyzeFile(entry);
        else if (gid) await analyzeFile({ id: gid, name, size: 0 });
        else message.warning('未在公共基因组中找到该文件');
        return;
      }
      setView('browse');
      const fileId = entry?.id ?? gid;
      if (!fileId) {
        message.warning('未找到该基因组文件，已打开 JBrowse 默认视图');
        return;
      }
      if (!isFasta(name)) {
        setJbrowseFile(null);
        message.info('JBrowse 动态装配只支持 FASTA 文件，已打开默认 hg19 示例');
        return;
      }
      setJbrowseFile({ id: fileId, name });
      message.success(`已把 ${name} 载入 JBrowse 动态装配`);
    };
    void run();
  }, [entries, genomes.isFetched, urlParams]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制到剪贴板');
    } catch {
      message.error('浏览器拒绝了剪贴板写入');
    }
  };

  const orfColumns = [
    { title: '起点', dataIndex: 'start', key: 'start', width: 90 },
    { title: '终点', dataIndex: 'end', key: 'end', width: 90 },
    { title: '长度', key: 'len', width: 90, render: (_: unknown, r: SequenceAnalysis['orfs'][number]) => r.end - r.start + 1 },
    { title: '阅读框', dataIndex: 'frame', key: 'frame', width: 80 },
    { title: '链', dataIndex: 'strand', key: 'strand', width: 70, render: (v: string) => <Tag variant="filled" color={v === '+' ? 'blue' : 'purple'}>{v}</Tag> },
    { title: 'Offset', dataIndex: 'offset', key: 'offset', width: 80 },
  ];

  // 分析结果的可搬运正文：存知识库 / 交给 Agent 都用这一份
  const analysisDigest = result
    ? [
        `## ${seqName} · rust-bio 序列分析`,
        `- 长度：${result.length} bp`,
        `- GC 含量：${(result.gc_content * 100).toFixed(2)}%`,
        `- GC3 含量：${(result.gc3_content * 100).toFixed(2)}%`,
        `- ORF：${result.orfs.length} 个（最小长度 100 bp）`,
        result.warnings.length ? `- 提示：${result.warnings.join('；')}` : '',
        '',
        '| 起点 | 终点 | 长度 | 阅读框 | 链 |',
        '| --- | --- | --- | --- | --- |',
        ...result.orfs
          .slice(0, 40)
          .map((o) => `| ${o.start} | ${o.end} | ${o.end - o.start + 1} | ${o.frame} | ${o.strand} |`),
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const analysisPanel = (
    <Flex vertical gap={12}>
      <Card
        size="small"
        title={
          <Space size={6}>
            <ThunderboltOutlined style={{ color: '#1677ff' }} />
            rust-bio 序列分析
          </Space>
        }
        extra={
          <Space wrap>
            <Button
              size="small"
              onClick={() => {
                setSequence(SAMPLE);
                setSeqName('示例序列');
              }}
            >
              载入示例
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<ExperimentOutlined />}
              loading={analyzing}
              onClick={() => runAnalysis(sequence, seqName)}
            >
              分析序列
            </Button>
          </Space>
        }
      >
        <Flex vertical gap={8}>
          <Input.TextArea
            value={sequence}
            onChange={(e) => {
              setSequence(e.target.value);
              setSeqName('手工输入');
            }}
            autoSize={{ minRows: 5, maxRows: 10 }}
            placeholder="粘贴 DNA 序列（支持 IUPAC 简并碱基，N 会保留）"
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5 }}
          />
          <Flex align="center" justify="space-between" gap={8} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {seqName} · {sequence.replace(/[^A-Za-z]/g, '').length.toLocaleString()} bp
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
              经门户以你的身份代理调用 CropGenome Toolkit（rust-bio），不会暴露服务令牌。
            </Typography.Text>
          </Flex>
        </Flex>
      </Card>

      {result ? (
        <Card
          size="small"
          title={`分析结果 · ${seqName}`}
          extra={
            <Space size={4} wrap>
              <Tag color="blue" variant="filled">
                {result.library} {result.library_version}
              </Tag>
              <Tag variant="filled">{result.coordinate_system}</Tag>
            </Space>
          }
        >
          <Flex vertical gap={12}>
            <Flex gap={16} wrap>
              <Statistic title="长度" value={result.length} suffix="bp" />
              <Statistic title="GC 含量" value={(result.gc_content * 100).toFixed(2)} suffix="%" />
              <Statistic title="GC3 含量" value={(result.gc3_content * 100).toFixed(2)} suffix="%" />
              <Statistic title="ORF 数量" value={result.orfs.length} />
            </Flex>
            {result.warnings.length ? (
              <Alert
                type="warning"
                showIcon
                title="分析提示"
                description={
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {result.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                }
              />
            ) : null}
            <div>
              <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>
                开放阅读框（ORF）
              </Typography.Text>
              {result.orfs.length ? (
                <Table
                  size="small"
                  bordered
                  rowKey={(r, i) => `${r.start}-${r.end}-${r.strand}-${i}`}
                  dataSource={result.orfs}
                  columns={orfColumns}
                  pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
                  scroll={{ y: 280 }}
                />
              ) : (
                <Typography.Text type="secondary">未检测到满足条件的 ORF（默认最小长度 100 bp）。</Typography.Text>
              )}
            </div>
            <ResultActions
              title={`${seqName} · 序列分析`}
              body={analysisDigest}
              category="基因组"
              tags={['rust-bio', 'ORF', 'GC']}
            />
            <div>
              <Flex align="center" justify="space-between" gap={8} style={{ marginBottom: 6 }}>
                <Typography.Text strong>反向互补序列</Typography.Text>
                <Button size="small" icon={<CopyOutlined />} onClick={() => copy(result.reverse_complement)}>
                  复制
                </Button>
              </Flex>
              <Input.TextArea
                readOnly
                value={result.reverse_complement}
                autoSize={{ minRows: 4, maxRows: 8 }}
                style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
              />
            </div>
          </Flex>
        </Card>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="输入序列或从公共基因组选择一个 FASTA 文件，即可得到 GC / GC3 / ORF / 反向互补"
        />
      )}
    </Flex>
  );

  return (
    <PageShell
      embedded={embedded}
      title="公共基因组"
      description="浏览实验室参考基因组，或把序列交给 rust-bio 做 GC / ORF 分析；文件可见性与下载权限沿用实验室 ACL。"
      extra={
        <Space wrap>
          <Tag color="green" variant="filled">
            JBrowse 2
          </Tag>
          <Tag color="blue" variant="filled">
            rust-bio
          </Tag>
          {linkedName ? (
            <Tag color="purple" variant="filled">
              来自文件存储 · {linkedName}
            </Tag>
          ) : null}
          <Button icon={<FolderOpenOutlined />} onClick={() => navigate('/files?source=genomes')}>
            文件存储
          </Button>
        </Space>
      }
    >

      <Card size="small" styles={{ body: { padding: '10px 14px' } }}>
        <Flex align="center" justify="space-between" gap={12} wrap>
          <Segmented
            value={view}
            onChange={(v) => setView(v as 'browse' | 'analyze' | 'tools')}
            options={[
              { label: '基因组浏览', value: 'browse' },
              { label: '序列分析', value: 'analyze' },
              { label: '比对与注释工具', value: 'tools' },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {view === 'browse'
              ? 'JBrowse 2 同源内嵌，无需跨域登录'
              : view === 'analyze'
                ? 'CropGenome Toolkit · rust-bio 4.2.x，经门户鉴权代理'
                : '成对比对 / 基序 / 区域重叠 / 序列提取 / 基因检索 / ID 解析 / BLAST'}
          </Typography.Text>
        </Flex>
      </Card>

      {view === 'browse' ? (
        <Flex vertical gap={12}>
          <Card
            size="small"
            title="基因组浏览"
            extra={
              <Space size={6}>
                {jbrowseFile ? (
                  <Tag color="purple" variant="filled">
                    装配 {jbrowseFile.name}
                  </Tag>
                ) : loc ? (
                  <Tag color="blue" variant="filled">
                    定位 {loc}
                  </Tag>
                ) : (
                  <Tag variant="filled">hg19 教学示例</Tag>
                )}
                {loc || jbrowseFile ? (
                  <Button
                    size="small"
                    onClick={() => {
                      setLoc('');
                      setJbrowseFile(null);
                    }}
                  >
                    回到默认
                  </Button>
                ) : null}
                <Button
                  size="small"
                  icon={<ExportOutlined />}
                  href={jbrowseSrc}
                  target="_blank"
                  rel="noreferrer"
                >
                  新窗口打开
                </Button>
              </Space>
            }
            styles={{ body: { padding: 0, overflow: 'hidden' } }}
          >
            <iframe
              key={jbrowseSrc}
              src={jbrowseSrc}
              title="JBrowse 2 基因组浏览器"
              style={{ display: 'block', width: '100%', height: 'calc(100vh - 380px)', minHeight: 480, border: 0 }}
              allow="clipboard-read; clipboard-write; fullscreen"
            />
          </Card>

          <Card
            size="small"
            title={
              <Space size={6}>
                <FileSearchOutlined />
                公共基因组文件
                <Tag variant="filled">{entries.length}</Tag>
              </Space>
            }
            extra={
              <Tooltip title="列表由实验室 ACL 过滤">
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={genomes.isFetching}
                  onClick={() => genomes.refetch()}
                >
                  刷新
                </Button>
              </Tooltip>
            }
          >
            {entries.length ? (
              <Table<FileEntry>
                rowKey="id"
                size="small"
                dataSource={entries}
                columns={COLUMNS.map((col) => {
                  if (col.key === 'size') {
                    return { ...col, render: (_: unknown, r: FileEntry) => formatSize(r.size) };
                  }
                  if (col.key === 'modified') {
                    return { ...col, render: (_: unknown, r: FileEntry) => formatDateTime(r.modified) };
                  }
                  if (col.key === 'ops') {
                    return {
                      ...col,
                      render: (_: unknown, r: FileEntry) => (
                        <Space size={4} wrap>
                          {isFasta(r.name) ? (
                            <Button
                              size="small"
                              type="link"
                              icon={<ExperimentOutlined />}
                              loading={loadingId === r.id}
                              onClick={() => analyzeFile(r)}
                            >
                              分析
                            </Button>
                          ) : null}
                          {isFasta(r.name) ? (
                            <Button
                              size="small"
                              type="link"
                              icon={<FileSearchOutlined />}
                              onClick={() => {
                                setLoc('');
                                setJbrowseFile({ id: r.id, name: r.name });
                              }}
                            >
                              浏览
                            </Button>
                          ) : null}
                          <Button
                            size="small"
                            type="link"
                            icon={<DownloadOutlined />}
                            href={`/api/files/${encodeURIComponent(r.id)}/download`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            下载
                          </Button>
                        </Space>
                      ),
                    };
                  }
                  return {
                    ...col,
                    render: (_: unknown, r: FileEntry) => (
                      <Tooltip title={r.path}>
                        <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5 }}>
                          {r.name}
                        </span>
                      </Tooltip>
                    ),
                  };
                })}
                pagination={{ pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }}
              />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Space orientation="vertical" size={4}>
                    <Typography.Text>当前目录还没有你看得到的基因组文件。</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      管理员可在「文件存储 → 公共基因组」上传 FASTA / GTF / BED，上传后此处立即出现。
                    </Typography.Text>
                  </Space>
                }
              >
                <Button type="primary" icon={<FolderOpenOutlined />} onClick={() => navigate('/files?source=genomes')}>
                  前往文件存储
                </Button>
              </Empty>
            )}
            {loadingName ? (
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                正在读取 {loadingName} 并调用 rust-bio 分析…
              </Typography.Text>
            ) : null}
          </Card>

          <Alert
            type="info"
            showIcon
            title="默认示例与自有 FASTA"
            description="未选择文件时展示 hg19 教学示例；从文件存储选中 FASTA 后，JBrowse 会用 IndexedFastaAdapter 动态装配该文件（按你的文件权限读取），无需预先配置参考基因组。"
          />
        </Flex>
      ) : view === 'tools' ? (
        <GenomeTools
          onLocate={(l) => {
            setLoc(l);
            setView('browse');
          }}
        />
      ) : (
        <Flex vertical gap={12}>
          {fastaEntries.length ? (
            <Card size="small" styles={{ body: { padding: '10px 14px' } }}>
              <Flex align="center" gap={10} wrap>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  从公共基因组载入：
                </Typography.Text>
                <Space size={4} wrap>
                  {fastaEntries.slice(0, 8).map((e) => (
                    <Button
                      key={e.id}
                      size="small"
                      loading={loadingId === e.id}
                      onClick={() => analyzeFile(e)}
                    >
                      {e.name}
                    </Button>
                  ))}
                </Space>
                {fastaEntries.length > 8 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    另有 {fastaEntries.length - 8} 个文件，可在「基因组浏览 → 公共基因组文件」中选择
                  </Typography.Text>
                ) : null}
              </Flex>
            </Card>
          ) : null}
          {analysisPanel}
        </Flex>
      )}
    </PageShell>
  );
}