import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Flex, Space, Table, Tag, Typography } from 'antd';
import { extOf, fileVisual, isCodeFile, isImageFile } from '../../components/files/fileMeta';
import type { FileEntry, FilePreview, FileSortKey, FileSource } from '../../services/api';

/**
 * Files 页的展示级小组件与纯函数（从 pages/Files.tsx 原样搬出，行为不变）。
 * 依赖组件状态的逻辑不在这里，见 ./actions 与 ./views。
 */
/** 缩略图：只有图片走 <img>，其余保持图标。
 *  preview 接口本身已按会话鉴权，且带 maxPreviewBytes 限制，不会把大图拖进列表。 */
export function FileThumb({ id, name, size = 26 }: { id: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const visual = fileVisual(name, false);
  if (!isImageFile(name) || failed) {
    return (
      <span style={{ color: visual.color, fontSize: size * 0.62, lineHeight: 1, display: 'inline-flex' }}>
        {visual.icon}
      </span>
    );
  }
  return (
    <img
      src={`/api/files/${encodeURIComponent(id)}/preview`}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      style={{
        width: size,
        height: size,
        objectFit: 'cover',
        borderRadius: 6,
        border: '1px solid var(--ant-color-border-secondary)',
        background: 'var(--ant-color-fill-quaternary, rgba(0,0,0,0.03))',
        flex: '0 0 auto',
      }}
    />
  );
}

export function shortDate(v: string) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('zh-CN');
}

/** 回收站条目的剩余保留期：只说"7 天"是不够的，用户关心还剩几天。 */
export function trashLeft(expiresAt: string) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return '—';
  const days = Math.ceil(ms / 86_400_000);
  if (days > 1) return `剩 ${days} 天`;
  if (days === 1) return '剩 1 天';
  return '即将自动清除';
}

export function ExtTag({ name }: { name: string }) {
  const ext = extOf(name);
  const color = ['pdf'].includes(ext)
    ? 'red'
    : ['doc', 'docx'].includes(ext)
      ? 'blue'
      : ['xls', 'xlsx', 'csv', 'tsv'].includes(ext)
        ? 'green'
        : ['ppt', 'pptx'].includes(ext)
          ? 'orange'
          : ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)
            ? 'purple'
            : ['zip', 'gz', 'bz2', 'xz', 'tar'].includes(ext)
              ? 'gold'
              : 'default';
  return (
    <Tag color={color} variant="filled" style={{ marginInlineEnd: 0, fontFamily: 'monospace' }}>
      {(ext || 'FILE').slice(0, 5).toUpperCase()}
    </Tag>
  );
}

/** 源码预览：等宽 + 行号 + 换行开关 + 一键复制。
 *
 * 不引高亮库：代码预览的价值在「看得清、能复制」，语法着色交给编辑器；
 * 引一个 highlighter（几百 KB）只为了预览里的颜色，不划算。
 */
function CodePreview({
  text,
  language,
  truncated,
}: {
  text: string;
  language?: string;
  truncated?: boolean;
}) {
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = useMemo(() => text.split('\n'), [text]);
  // 服务端最多返回 60k 字符，极端情况可能有 6 万行；一次渲染全部行会
  // 产生数万个 DOM 节点。按 1000 行分段显示，复制仍包含完整预览文本。
  const [visibleLines, setVisibleLines] = useState(1000);
  useEffect(() => setVisibleLines(1000), [text]);
  const rendered = lines.slice(0, visibleLines);
  return (
    <Flex vertical gap={8}>
      <Flex justify="space-between" align="center" gap={8}>
        <Typography.Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace' }}>
          {(language || 'code').toUpperCase()} · {lines.length} 行{truncated ? '（已截断）' : ''}
        </Typography.Text>
        <Space size={4}>
          <Button size="small" onClick={() => setWrap((v) => !v)}>
            {wrap ? '不换行' : '自动换行'}
          </Button>
          <Button
            size="small"
            onClick={async () => {
              try {
                await navigator.clipboard?.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                /* 非安全上下文或用户拒绝剪贴板权限时静默忽略 */
              }
            }}
          >
            {copied ? '已复制' : '复制'}
          </Button>
        </Space>
      </Flex>
      <pre
        style={{
          margin: 0,
          maxHeight: 520,
          overflow: 'auto',
          padding: 12,
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.6,
          background: 'var(--d509-fill, rgba(0,0,0,0.03))',
          border: '1px solid var(--d509-border)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        {rendered.map((line, i) => (
          <div key={i} style={{ display: 'flex', gap: 12 }}>
            <span
              style={{
                color: 'var(--d509-text-tertiary, rgba(0,0,0,0.45))',
                userSelect: 'none',
                minWidth: 34,
                textAlign: 'right',
              }}
            >
              {i + 1}
            </span>
            <span style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }}>{line || ' '}</span>
          </div>
        ))}
      </pre>
      {visibleLines < lines.length ? (
        <Button
          block
          onClick={() => setVisibleLines((n) => Math.min(n + 1000, lines.length))}
        >
          显示后续 {Math.min(1000, lines.length - visibleLines)} 行（剩余 {lines.length - visibleLines} 行）
        </Button>
      ) : null}
    </Flex>
  );
}

export function PreviewBody({ data }: { data: FilePreview }) {
  if (data.kind === 'image' && data.dataUrl) {
    return (
      <Flex vertical gap={8} align="center">
        <img
          src={data.dataUrl}
          alt="文件预览"
          style={{ maxWidth: '100%', maxHeight: 520, borderRadius: 8, border: '1px solid var(--d509-border)' }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {data.notice || '内联缩略图'}
        </Typography.Text>
      </Flex>
    );
  }
  if (data.kind === 'code' && typeof data.text === 'string') {
    return <CodePreview text={data.text} language={data.language} truncated={data.truncated} />;
  }
  if (data.kind === 'table' && data.rows?.length) {
    const [head, ...body] = data.rows;
    return (
      <Table
        size="small"
        bordered
        pagination={false}
        scroll={{ x: 'max-content', y: 420 }}
        rowKey={(_, i) => String(i)}
        dataSource={body.map((r) => ({ r }))}
        columns={head.map((h, i) => ({
          title: h || `列 ${i + 1}`,
          render: (_: unknown, row: { r: string[] }) => row.r[i] ?? '',
        }))}
      />
    );
  }
  if (data.kind === 'bioinfo' && (data.records?.length || data.meta)) {
    const meta = data.meta ?? {};
    const chips = [
      data.format ? data.format.toUpperCase() : null,
      typeof meta.topology === 'string' ? meta.topology : null,
      typeof meta.length === 'number' ? `${meta.length.toLocaleString()} bp` : null,
      typeof meta.gc_percent === 'number' ? `GC ${meta.gc_percent}%` : null,
      typeof meta.taxa === 'number' ? `${meta.taxa} 条序列` : null,
      typeof meta.sites === 'number' ? `${meta.sites} 个位点` : null,
      typeof meta.tips === 'number' ? `${meta.tips} 个叶节点` : null,
      typeof meta.depth === 'number' ? `深度 ${meta.depth}` : null,
      typeof meta.atoms === 'number' ? `${meta.atoms.toLocaleString()} 个原子` : null,
      Array.isArray(meta.chains) && meta.chains.length ? `链 ${meta.chains.join(' ')}` : null,
      typeof meta.resolution_angstrom === 'string' ? `${meta.resolution_angstrom} Å` : null,
    ].filter(Boolean) as string[];
    const first = data.records?.[0] ?? {};
    const keys = Object.keys(first);
    const mono = new Set(['header', 'snippet', 'sequence', 'sequence_snippet', 'location']);
    const titles: Record<string, string> = {
      header: '序列',
      length: '长度',
      snippet: '片段',
      sequence_snippet: '序列片段',
      feature: '特征',
      location: '位置',
      atom: '原子',
      residue: '残基',
      chain: '链',
      resseq: '编号',
      name: '名称',
    };
    return (
      <Flex vertical gap={10}>
        {chips.length ? (
          <Space size={6} wrap>
            {chips.map((c) => (
              <Tag key={c} variant="filled" style={{ fontSize: 11.5 }}>
                {c}
              </Tag>
            ))}
          </Space>
        ) : null}
        {data.records?.length ? (
          <Table
            size="small"
            bordered
            pagination={{ pageSize: 20, showSizeChanger: false }}
            scroll={{ x: 'max-content' }}
            rowKey={(_, i) => String(i)}
            dataSource={data.records}
            columns={keys.map((k) => ({
              title: titles[k] ?? k,
              dataIndex: k,
              render: (v: unknown) => (
                <span
                  title={String(v ?? '')}
                  style={{
                    display: 'inline-block',
                    maxWidth: mono.has(k) ? 560 : 240,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    verticalAlign: 'bottom',
                    fontFamily: mono.has(k) ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
                    fontSize: mono.has(k) ? 12 : undefined,
                  }}
                >
                  {String(v ?? '')}
                </span>
              ),
            }))}
          />
        ) : null}
        {data.text ? (
          <pre
            style={{
              margin: 0,
              maxHeight: 320,
              overflow: 'auto',
              padding: 12,
              borderRadius: 8,
              background: 'var(--ant-color-fill-quaternary)',
              fontSize: 12.5,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {data.text}
          </pre>
        ) : null}
        {data.notice ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{data.notice}</Typography.Text> : null}
      </Flex>
    );
  }
  if (data.text) {
    return (
      <pre
        style={{
          margin: 0,
          maxHeight: 460,
          overflow: 'auto',
          padding: 12,
          borderRadius: 8,
          background: 'var(--ant-color-fill-quaternary)',
          fontSize: 12.5,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {data.text}
      </pre>
    );
  }
  return (
    <Flex vertical gap={8}>
      <Alert type="info" showIcon title={data.notice || '该格式暂无可视化预览，可下载后使用本地工具查看。'} />
      {data.meta ? <pre style={{ margin: 0, fontSize: 12 }}>{JSON.stringify(data.meta, null, 2)}</pre> : null}
    </Flex>
  );
}

export function sourceHint(src: FileSource) {
  if (src.id === 'public') return '全实验室共享的公共资料，登录后可预览与下载。';
  if (src.id === 'plasmids') return '常用克隆、表达与植物双元载体图谱，含 GenBank 注释，可预览与下载。';
  if (src.id === 'genomes') return '实验室公共参考基因组与注释，可在「公共基因组」页直接用 JBrowse2 浏览，也可在此检索与下载。';
  if (src.id === 'users') return '个人文件默认仅本人可见；把文件或文件夹共享给指定同学后，对方在「共享给我」中只读访问。';
  return '实验室内部文件共享空间。';
}

export type FileRow = FileEntry & { owner?: string };

export const SORT_KEYS: FileSortKey[] = ['name', 'size', 'modified', 'created'];

/**
 * 按存储用途推荐默认视图。
 *
 * - 普通个人文件（users）：条目多、命名杂，列表视图按名字/大小扫一眼最快，默认列表。
 * - 公共基因组 / 公共资料（genomes、public）：内容是持续堆积的“资料堆”，
 *   更关心“什么时候进来的”，默认时间线（按创建时间分组）。
 */
export const TIMELINE_FIRST_SOURCES = new Set(['genomes', 'public']);

export function recommendedView(source: string): 'list' | 'timeline' {
  return TIMELINE_FIRST_SOURCES.has(source) ? 'timeline' : 'list';
}


/** 生信格式交给后端结构化解析：Open File Viewer 只会把 .dna 之类的二进制当文本画出来。 */
const BIO_PREVIEW_EXTS = new Set([
  'dna', 'gb', 'gbk', 'genbank', 'embl',
  'fa', 'fna', 'faa', 'fasta', 'fq', 'fastq', 'sam',
  'vcf', 'gff', 'gff3', 'gtf', 'bed', 'wig', 'bedgraph', 'fai', 'ped', 'map',
  'pdb', 'ent', 'nwk', 'newick', 'tree', 'tre',
  'phy', 'phylip', 'nex', 'nexus', 'sto', 'stockholm', 'aln', 'clustal', 'maf',
]);

export function preferNativePreview(name: string | undefined): boolean {
  if (!name) return false;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  // 源码走门户原生 CodePreview（行号 / 换行 / 复制 / 分段渲染），
  // 不再先交给第三方 OFV；生信格式仍走后端结构化解析。
  return BIO_PREVIEW_EXTS.has(ext) || isCodeFile(name);
}

/** 把 Go 核心的英文拒绝原因翻译成界面用语，避免只剩一个裸状态码。 */
export function fileErrorText(raw: string): string {
  const table: [RegExp, string][] = [
    [/permission denied/i, '当前账号没有该目录的写入权限'],
    [/storage rejected the write/i, '存储层拒绝了写入（目录权限或只读挂载），请联系管理员处理'],
    [/file writes require a user identity/i, '需要以个人账号登录后才能管理文件'],
    [/resource already exists/i, '同名文件已存在'],
    [/resource not found/i, '文件已被移动或删除，请刷新列表'],
    [/invalid path or name/i, '名称或路径不合法'],
    [/exceeds the size limit/i, '文件超过大小上限'],
    [/cannot preview a directory/i, '文件夹不能预览'],
    [/cannot download a directory/i, '文件夹不能直接下载'],
    [/trash manifest/i, '回收站清单读写异常，请联系管理员处理'],
    [/data moved to/i, '文件已移入回收站但清单未记账成功，请联系管理员核对回收目录'],
  ];
  for (const [re, zh] of table) if (re.test(raw)) return `${zh}（${raw}）`;
  return raw;
}
