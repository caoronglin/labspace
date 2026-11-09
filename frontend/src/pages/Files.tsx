import { useEffect, useMemo, useState, type DragEvent, type Key, type ReactNode } from 'react';
import {
  Alert,
  App,
  Badge,
  Breadcrumb,
  Button,
  Card,
  Checkbox,
  Dropdown,
  Empty,
  Flex,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import {
  AppstoreOutlined,
  ArrowLeftOutlined,
  BookOutlined,
  ClearOutlined,
  ClockCircleOutlined,
  CloudUploadOutlined,
  CodeOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EllipsisOutlined,
  ExperimentOutlined,
  EyeOutlined,
  FileExcelOutlined,
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FilePptOutlined,
  FileTextOutlined,
  FileWordOutlined,
  FileZipOutlined,
  FolderAddOutlined,
  GlobalOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  PlayCircleOutlined,
  ProfileOutlined,
  ReloadOutlined,
  RestOutlined,
  ShareAltOutlined,
  SoundOutlined,
  StopOutlined,
  TeamOutlined,
  UndoOutlined,
  UnorderedListOutlined,
  UploadOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  api,
  type FileAccessEvent,
  type FileEntry,
  type FilePreview,
  type FileSortKey,
  type FileSource,
  type FileTrashItem,
  type PersonalShare,
} from '../services/api';
import { useAuth } from '../app/AuthContext';
import OpenFilePreview from '../components/OpenFilePreview';
import PageShell from '../components/PageShell';
import OfficeWorkspace from '../components/office/OfficeWorkspace';
import { hasPresentation, isOfficeEditable } from '../components/office/registry';

const GENOME_EXTS = new Set(['fa', 'fna', 'fasta', 'fas', 'ffn', 'frn', 'faa', 'gff', 'gff3', 'gtf', 'bed', 'vcf']);

function isGenomeFile(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return GENOME_EXTS.has(ext);
}

type FileVisual = { icon: ReactNode; color: string };

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic']);
const ARCHIVE_EXTS = new Set(['zip', 'gz', 'bz2', 'xz', 'tar', 'tgz', '7z', 'rar']);
const SHEET_EXTS = new Set(['xls', 'xlsx', 'csv', 'tsv']);
const DOC_EXTS = new Set(['doc', 'docx', 'rtf', 'odt']);
const PPT_EXTS = new Set(['ppt', 'pptx', 'odp']);
const TEXT_EXTS = new Set(['md', 'txt', 'rst', 'log', 'tex']);
const CODE_EXTS = new Set(['py', 'js', 'ts', 'tsx', 'jsx', 'go', 'rs', 'sh', 'bash', 'json', 'yaml', 'yml', 'toml', 'c', 'cpp', 'h', 'hpp', 'java', 'r', 'sql', 'html', 'css']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a']);
const BIO_EXTS = new Set([...GENOME_EXTS, 'fastq', 'fq', 'bam', 'sam', 'pdb', 'gb', 'gbk', 'genbank']);

function fileVisual(name: string, dir: boolean): FileVisual {
  if (dir) return { icon: <FolderOpenOutlined />, color: '#D97706' };
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTS.has(ext)) return { icon: <FileImageOutlined />, color: '#7C3AED' };
  if (ext === 'pdf') return { icon: <FilePdfOutlined />, color: '#DC2626' };
  if (SHEET_EXTS.has(ext)) return { icon: <FileExcelOutlined />, color: '#16A34A' };
  if (PPT_EXTS.has(ext)) return { icon: <FilePptOutlined />, color: '#EA580C' };
  if (DOC_EXTS.has(ext)) return { icon: <FileWordOutlined />, color: '#2563EB' };
  if (ARCHIVE_EXTS.has(ext)) return { icon: <FileZipOutlined />, color: '#CA8A04' };
  if (TEXT_EXTS.has(ext)) return { icon: <FileTextOutlined />, color: '#0891B2' };
  if (CODE_EXTS.has(ext)) return { icon: <CodeOutlined />, color: '#4F46E5' };
  if (BIO_EXTS.has(ext)) return { icon: <ExperimentOutlined />, color: '#059669' };
  if (VIDEO_EXTS.has(ext)) return { icon: <VideoCameraOutlined />, color: '#DB2777' };
  if (AUDIO_EXTS.has(ext)) return { icon: <SoundOutlined />, color: '#EA580C' };
  return { icon: <FileOutlined />, color: '#64748B' };
}

function extOf(name: string) {
  const parts = name.split('.');
  return parts.length > 1 ? (parts.pop() ?? '').toLowerCase() : '';
}

function formatSize(n: number) {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTime(v: string) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('zh-CN');
}

function shortDate(v: string) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('zh-CN');
}

/** 回收站条目的剩余保留期：只说"30 天"是不够的，用户关心还剩几天。 */
function trashLeft(expiresAt: string) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return '—';
  const days = Math.ceil(ms / 86_400_000);
  if (days > 1) return `剩 ${days} 天`;
  if (days === 1) return '剩 1 天';
  return '即将自动清除';
}

function ExtTag({ name }: { name: string }) {
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

function PreviewBody({ data }: { data: FilePreview }) {
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

function sourceHint(src: FileSource) {
  if (src.id === 'public') return '全实验室共享的公共资料，登录后可预览与下载。';
  if (src.id === 'plasmids') return '常用克隆、表达与植物双元载体图谱，含 GenBank 注释，可预览与下载。';
  if (src.id === 'genomes') return '实验室公共参考基因组与注释，可在「公共基因组」页直接用 JBrowse2 浏览，也可在此检索与下载。';
  if (src.id === 'users') return '个人文件默认仅本人可见；把文件或文件夹共享给指定同学后，对方在「共享给我」中只读访问。';
  return '实验室内部文件共享空间。';
}

type FileRow = FileEntry & { owner?: string };

const SORT_KEYS: FileSortKey[] = ['name', 'size', 'modified', 'created'];

/** 生信格式交给后端结构化解析：Open File Viewer 只会把 .dna 之类的二进制当文本画出来。 */
const BIO_PREVIEW_EXTS = new Set([
  'dna', 'gb', 'gbk', 'genbank', 'embl',
  'fa', 'fna', 'faa', 'fasta', 'fq', 'fastq', 'sam',
  'vcf', 'gff', 'gff3', 'gtf', 'bed', 'wig', 'bedgraph', 'fai', 'ped', 'map',
  'pdb', 'ent', 'nwk', 'newick', 'tree', 'tre',
  'phy', 'phylip', 'nex', 'nexus', 'sto', 'stockholm', 'aln', 'clustal', 'maf',
]);

function preferNativePreview(name: string | undefined): boolean {
  if (!name) return false;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return BIO_PREVIEW_EXTS.has(ext);
}

/** 把 Go 核心的英文拒绝原因翻译成界面用语，避免只剩一个裸状态码。 */
function fileErrorText(raw: string): string {
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

export default function Files() {
  const { message, modal } = App.useApp();
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [urlParams] = useSearchParams();
  const [source, setSource] = useState(() => urlParams.get('source') || 'public');
  const [dir, setDir] = useState(() => urlParams.get('dir') || '');
  const [q, setQ] = useState(() => urlParams.get('q') || '');
  const [sortKey, setSortKey] = useState<FileSortKey>(() => {
    const raw = urlParams.get('sort') as FileSortKey | null;
    return raw && SORT_KEYS.includes(raw) ? raw : 'name';
  });
  const [order, setOrder] = useState<'asc' | 'desc'>(() =>
    urlParams.get('order') === 'desc' ? 'desc' : 'asc'
  );
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [nativePreview, setNativePreview] = useState(false);
  const [officeTarget, setOfficeTarget] = useState<{ entry: FileEntry; mode: 'edit' | 'present' } | null>(null);
  const [dialog, setDialog] = useState<{ mode: 'mkdir' | 'rename'; entry?: FileEntry } | null>(null);
  const [dialogName, setDialogName] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditAction, setAuditAction] = useState<'all' | 'preview' | 'download'>('all');
  const [personalScope, setPersonalScope] = useState<'mine' | 'shared'>('mine');
  const [shareTarget, setShareTarget] = useState<FileEntry | null>(null);
  const [sharePicks, setSharePicks] = useState<string[]>([]);
  const [shareBusy, setShareBusy] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'grid' | 'details' | 'timeline'>(() => {
    const raw = urlParams.get('view');
    return raw === 'grid' || raw === 'details' || raw === 'timeline' ? raw : 'list';
  });

  // 切换文件源、目录或搜索词后，旧选择不再对应当前列表，必须整体丢弃，
  // 否则批量操作会作用到用户已经看不到的条目上。
  useEffect(() => {
    setSelectedKeys([]);
  }, [source, dir, q, personalScope]);

  useEffect(() => {
    setNativePreview(false);
  }, [previewId]);

  const sources = useQuery({ queryKey: ['file-sources'], queryFn: api.fileSources, staleTime: 60_000 });
  const list = useQuery({
    queryKey: ['files', source, sortKey, order],
    queryFn: () => api.files(source, sortKey, order),
    staleTime: 15_000,
    enabled: Boolean(source) && (sources.data?.sources ?? []).some((s) => s.id === source && s.listable),
  });
  const entries = list.data?.entries ?? [];
  const usage = list.data?.usage;
  // 回收站单独一份数据：列表徽标要常驻，打开面板时也用同一份缓存。
  const trash = useQuery({ queryKey: ['file-trash'], queryFn: api.fileTrash, staleTime: 10_000 });
  const trashItems = trash.data?.items ?? [];
  // 访问记录只对管理员开放，打开面板时才查询，避免普通用户白跑一次 403。
  const audit = useQuery({
    queryKey: ['file-access-log', auditAction],
    queryFn: () =>
      api.fileAccessLog({ action: auditAction === 'all' ? undefined : auditAction, limit: 100 }),
    enabled: isAdmin && auditOpen,
    staleTime: 5_000,
  });
  const retentionDays = trash.data?.retentionDays ?? 30;
  const retentionHint = `删除的内容会进入回收站，保留 ${retentionDays} 天，可原样恢复到删除前的位置。`;
  const previewEntry = entries.find((e) => e.id === previewId);
  const bioDirect = preferNativePreview(previewEntry?.name);
  const preview = useQuery({
    queryKey: ['file-preview', previewId],
    queryFn: () => api.filePreview(previewId!),
    enabled: Boolean(previewId) && (nativePreview || bioDirect),
    retry: false,
  });

  const activeSource = sources.data?.sources.find((s) => s.id === source);
  const sourceWritable = Boolean(activeSource?.writable);
  const writePaths = activeSource?.writePaths ?? [];
  const canWrite = (path: string) =>
    sourceWritable &&
    writePaths.some((p) => p === '' || path === p || path.startsWith(`${p}/`));
  const isPersonal = source === 'users';
  const isSharedView = isPersonal && personalScope === 'shared';

  // 共享名单：候选共享人与「我共享出去」的现状都从服务端取，避免前端猜。
  const shares = useQuery({
    queryKey: ['file-shares'],
    queryFn: api.fileShares,
    enabled: isPersonal,
    staleTime: 15_000,
  });

  // 本人空间根目录由服务端认定（登录名），不能靠"只有一个顶层目录"来猜。
  const homePath = list.data?.home ?? '';
  const sharedWith = list.data?.sharedWith ?? [];
  const personalShares = shares.data?.shares ?? list.data?.shares ?? [];
  const shareRecipients = shares.data?.recipients ?? [];
  const sharedRoots = useMemo(() => sharedWith.map((s) => s.path), [sharedWith]);
  const sharedRootOf = (p: string) =>
    sharedRoots
      .filter((r) => p === r || p.startsWith(`${r}/`))
      .sort((a, b) => b.length - a.length)[0] ?? '';

  const baseDir = isPersonal ? (isSharedView ? dir : dir || homePath) : dir;
  const writable = !isSharedView && canWrite(baseDir);
  const scopeRoot = isPersonal ? (isSharedView ? '' : homePath) : '';

  useEffect(() => {
    if (!isPersonal || isSharedView || dir || !homePath) return;
    setDir(homePath);
  }, [isPersonal, isSharedView, dir, homePath]);

  // 当前视图可见的条目：我的文件只保留本人主目录，共享给我只保留他人共享的子树。
  const viewEntries = useMemo(() => {
    if (!isPersonal) return entries;
    if (isSharedView) {
      return entries.filter((e) =>
        sharedRoots.some((r) => e.path === r || e.path.startsWith(`${r}/`)),
      );
    }
    if (!homePath) return entries;
    const prefix = `${homePath}/`;
    return entries.filter((e) => e.path === homePath || e.path.startsWith(prefix));
  }, [entries, isPersonal, isSharedView, sharedRoots, homePath]);

  const keyword = q.trim().toLowerCase();
  const searching = Boolean(keyword);
  // 排序交给服务端（entries 已按 sortKey/order 返回）；这里只分组：目录恒排在
  // 文件之前，组内保持服务端顺序，避免"只排当前页/只排当前目录"的错觉。
  const children = useMemo(() => {
    const prefix = baseDir ? `${baseDir}/` : '';
    const rows = viewEntries.filter((e) => {
      if (!e.path || e.path === baseDir) return false;
      if (!e.path.startsWith(prefix)) return false;
      const rest = e.path.slice(prefix.length);
      return rest.length > 0 && !rest.includes('/');
    });
    return [...rows.filter((e) => e.dir), ...rows.filter((e) => !e.dir)];
  }, [viewEntries, baseDir]);

  // 「共享给我」根目录是扁平列表（可能分散在多人主目录下），直接展示共享条目本身。
  const sharedRootRows = useMemo(() => {
    if (!isSharedView || baseDir) return [];
    const sign = order === 'asc' ? 1 : -1;
    const sorted = [...sharedWith].sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      let cmp = 0;
      if (sortKey === 'size') cmp = a.size - b.size;
      else if (sortKey === 'modified') cmp = a.modified.localeCompare(b.modified);
      else if (sortKey === 'created') cmp = a.created.localeCompare(b.created);
      else cmp = a.name.localeCompare(b.name, 'zh-CN');
      if (cmp === 0) cmp = a.path.localeCompare(b.path, 'zh-CN');
      return cmp * sign;
    });
    return sorted.map((s) => ({ ...s, source: 'users' }));
  }, [isSharedView, baseDir, sharedWith, sortKey, order]);

  const rows = useMemo(() => {
    if (searching) {
      const found = viewEntries.filter(
        (e) => e.path && (e.name.toLowerCase().includes(keyword) || e.path.toLowerCase().includes(keyword)),
      );
      return found.slice(0, 200);
    }
    return isSharedView && !baseDir ? sharedRootRows : children;
  }, [searching, children, viewEntries, keyword, isSharedView, baseDir, sharedRootRows]);

  // 选择只保留当前列表里仍然存在的条目，避免刷新后对着已消失的 id 操作。
  const selectedEntries = useMemo(
    () => rows.filter((r) => selectedKeys.includes(r.id)),
    [rows, selectedKeys],
  );
  const selectedBytes = selectedEntries.reduce((sum, e) => sum + (e.size || 0), 0);
  const removableSelection = selectedEntries.filter((e) => canWrite(e.path));
  const ingestibleSelection = selectedEntries.filter((e) => !e.dir);

  const toggleSelect = (id: string) =>
    setSelectedKeys((keys) => (keys.includes(id) ? keys.filter((k) => k !== id) : [...keys, id]));

  const timelineGroups = useMemo(() => {
    const groups = new Map<string, FileRow[]>();
    for (const r of rows) {
      const day = (r.modified || '').slice(0, 10) || '未知时间';
      const list = groups.get(day) ?? [];
      list.push(r);
      groups.set(day, list);
    }
    return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [rows]);

  // 用量优先取服务端汇总（usage 覆盖整个源，按目录前缀分桶）；
  // 当前目录的作用域统计在本地按前缀过滤，保证"看到的即所选目录"。
  const stats = useMemo(() => {
    const prefix = baseDir ? `${baseDir}/` : '';
    const filesInView = viewEntries.filter((e) => !e.dir);
    const scoped = filesInView.filter((e) => !prefix || e.path.startsWith(prefix));
    const sumBytes = (list: FileEntry[]) => list.reduce((sum, e) => sum + (e.size || 0), 0);
    return {
      files: scoped.length,
      size: usage?.dirs?.[baseDir] ?? sumBytes(scoped),
      totalFiles: isPersonal ? filesInView.length : (usage?.files ?? filesInView.length),
      totalSize: isPersonal ? sumBytes(filesInView) : (usage?.total ?? sumBytes(filesInView)),
    };
  }, [viewEntries, baseDir, usage, isPersonal]);

  const breadcrumb = useMemo(() => {
    const rootLabel = isPersonal
      ? isSharedView
        ? '共享给我'
        : '个人文件'
      : (activeSource?.label ?? '文件共享');
    const items: { title: ReactNode; onClick?: () => void }[] = [
      {
        title: (
          <Space size={4}>
            {isSharedView ? <TeamOutlined /> : <FolderOpenOutlined />}
            <span>{rootLabel}</span>
          </Space>
        ),
        onClick: () => setDir(scopeRoot),
      },
    ];
    if (isSharedView) {
      const root = sharedRootOf(baseDir);
      if (!root) return items;
      items.push({ title: root.split('/').pop() ?? root, onClick: () => setDir(root) });
      let acc = root;
      for (const part of baseDir.slice(root.length).split('/').filter(Boolean)) {
        acc = `${acc}/${part}`;
        const target = acc;
        items.push({ title: part, onClick: () => setDir(target) });
      }
      return items;
    }
    const rootParts = isPersonal ? homePath.split('/').filter(Boolean) : [];
    const parts = baseDir.split('/').filter(Boolean).slice(rootParts.length);
    let acc = rootParts.join('/');
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      const target = acc;
      items.push({ title: part, onClick: () => setDir(target) });
    }
    return items;
  }, [activeSource?.label, baseDir, homePath, isPersonal, isSharedView, scopeRoot, sharedRoots]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['files', source] });

  const uploadFile = async (file: File) => {
    const target = isPersonal ? baseDir : dir;
    try {
      await api.fileUpload(source, target, file);
    } catch (e) {
      if (!(e as Error).message.includes('already exists')) throw e;
      const ok = await new Promise<boolean>((resolve) => {
        modal.confirm({
          title: '同名文件已存在',
          content: `${file.name} 已存在于当前目录，是否覆盖？`,
          okText: '覆盖',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!ok) return;
      await api.fileUpload(source, target, file, true);
    }
    message.success(`已上传 ${file.name}`);
    await refresh();
  };

  const uploadFiles = async (files: File[]) => {
    for (const file of files) {
      try {
        await uploadFile(file);
      } catch (e) {
        message.error(`上传 ${file.name} 失败：${fileErrorText((e as Error).message)}`);
      }
    }
  };

  const submitDialog = async () => {
    const name = dialogName.trim();
    if (!dialog || !name) return;
    setBusy(true);
    try {
      const target = isPersonal ? baseDir : dir;
      if (dialog.mode === 'mkdir') {
        await api.fileMkdir(source, target ? `${target}/${name}` : name);
        message.success('文件夹已创建');
      } else if (dialog.entry) {
        await api.fileRename(dialog.entry.id, name);
        message.success('已重命名');
      }
      setDialog(null);
      setDialogName('');
      await refresh();
    } catch (e) {
      message.error(fileErrorText((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const refreshAll = async () => {
    await Promise.all([refresh(), trash.refetch()]);
  };

  const relPath = (p: string) =>
    homePath && p.startsWith(`${homePath}/`) ? p.slice(homePath.length + 1) : p;
  const shareOf = (p: string) => personalShares.find((s) => s.path === relPath(p));

  const openShare = (entry: FileEntry) => {
    const existing = shareOf(entry.path);
    setSharePicks(existing?.recipients ?? []);
    setShareTarget(entry);
  };

  const saveShare = async () => {
    if (!shareTarget) return;
    setShareBusy(true);
    try {
      await api.fileShare(relPath(shareTarget.path), sharePicks);
      message.success(sharePicks.length ? `已共享给 ${sharePicks.length} 人` : '已收回该路径的共享');
      setShareTarget(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['file-shares'] }),
        qc.invalidateQueries({ queryKey: ['files', 'users'] }),
      ]);
    } catch (e) {
      message.error(fileErrorText((e as Error).message));
    } finally {
      setShareBusy(false);
    }
  };

  const editShare = (share: PersonalShare) => {
    setManageOpen(false);
    const entry = viewEntries.find((e) => relPath(e.path) === share.path);
    const full = homePath ? `${homePath}/${share.path}` : share.path;
    setSharePicks(share.recipients);
    setShareTarget(
      entry ?? {
        id: '',
        source: 'users',
        path: full,
        name: share.path.split('/').pop() ?? share.path,
        dir: false,
        size: 0,
        modified: '',
        created: '',
      },
    );
  };

  const revokeShare = (share: PersonalShare) => {
    modal.confirm({
      title: `收回「${share.path}」的共享？`,
      content: `${share.recipients.join('、')} 将不能再查看该路径；已下载的副本无法收回。`,
      okText: '收回',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.fileShare(share.path, []);
          message.success('已收回共享');
          await Promise.all([
            qc.invalidateQueries({ queryKey: ['file-shares'] }),
            qc.invalidateQueries({ queryKey: ['files', 'users'] }),
          ]);
        } catch (e) {
          message.error(fileErrorText((e as Error).message));
        }
      },
    });
  };

  const removeEntry = async (entry: FileEntry) => {
    try {
      const res = await api.fileDelete(entry.id);
      const until = shortDate(res?.trash?.expiresAt ?? '');
      message.success(until ? `已移入回收站，${until} 前可恢复` : '已移入回收站');
      if (previewId === entry.id) setPreviewId(null);
      await refreshAll();
    } catch (e) {
      message.error(fileErrorText((e as Error).message));
    }
  };

  const restoreItem = async (item: FileTrashItem) => {
    try {
      await api.fileRestore(item.id);
      message.success(`已恢复到 ${item.sourceLabel || item.source}/${item.path}`);
      await refreshAll();
    } catch (e) {
      message.error(fileErrorText((e as Error).message));
    }
  };

  const purgeItem = (item: FileTrashItem) => {
    modal.confirm({
      title: `彻底删除 ${item.name}？`,
      content: `${item.dir ? `${item.paths} 项 · ` : ''}${formatSize(item.size)} 将从回收站永久清除，之后无法恢复。`,
      okText: '彻底删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await api.filePurge(item.id);
          message.success(`已彻底删除，释放 ${formatSize(res.summary?.bytes ?? 0)}`);
          await trash.refetch();
        } catch (e) {
          message.error(fileErrorText((e as Error).message));
        }
      },
    });
  };

  const emptyTrash = () => {
    modal.confirm({
      title: '清空回收站？',
      content: `你可见的 ${trashItems.length} 条记录会被永久删除。其他人删除的记录属于他们的权限范围，会保留。`,
      okText: '清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const res = await api.fileEmptyTrash();
          const { removed = 0, skipped = 0, bytes = 0 } = res.summary ?? {};
          message.success(
            `已清空 ${removed} 项，释放 ${formatSize(bytes)}${skipped ? `；${skipped} 项属于他人权限，已保留` : ''}`,
          );
          await trash.refetch();
        } catch (e) {
          message.error(fileErrorText((e as Error).message));
        }
      },
    });
  };

  const confirmRemove = (entry: FileEntry) => {
    // 目录删除是递归的（后端 os.RemoveAll），确认框必须给出真实的影响范围，
    // 而不是笼统的"内容都会删除"。
    const prefix = `${entry.path}/`;
    const inside = entry.dir ? entries.filter((e) => e.path.startsWith(prefix)) : [];
    const innerFiles = inside.filter((e) => !e.dir);
    const innerBytes = innerFiles.reduce((sum, e) => sum + (e.size || 0), 0);
    modal.confirm({
      title: `删除 ${entry.name}？`,
      content: entry.dir ? (
        <Flex vertical gap={6}>
          <Typography.Text>
            文件夹会被整体移入回收站，共 {innerFiles.length} 个文件、{formatSize(innerBytes)}
            （含 {inside.length - innerFiles.length} 个子目录）。
          </Typography.Text>
          <Typography.Text type="secondary">{retentionHint}</Typography.Text>
        </Flex>
      ) : (
        <Flex vertical gap={6}>
          <Typography.Text>
            {formatSize(entry.size || 0)} · {entry.path}
          </Typography.Text>
          <Typography.Text type="secondary">{retentionHint}</Typography.Text>
        </Flex>
      ),
      okText: '移入回收站',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => removeEntry(entry),
    });
  };

  const openEntry = (entry: FileEntry) => {
    if (entry.dir) {
      setDir(entry.path);
      if (searching) setQ('');
      return;
    }
    setPreviewId(entry.id);
  };

  /** 一次最多入库 50 个，和后端 MAX_BATCH 对齐，超出的部分明确告知而不是静默丢弃。 */
  const MAX_INGEST = 50;

  const ingestPicks = async (picks: FileEntry[], hidden = 0) => {
    const hide = message.loading(`正在抽取 ${picks.length} 个文件…`, 0);
    try {
      const res = await api.knowledgeFromFiles({
        items: picks.map((e) => ({ id: e.id, source: e.source, path: e.path })),
      });
      const s = res.summary;
      const tail = hidden > 0 ? `，另有 ${hidden} 个超出单次上限未处理` : '';
      if (s.created + s.updated === 0) {
        message.warning(`没有文件入库：${res.results[0]?.reason ?? '未抽取到文本'}${tail}`);
      } else {
        message.success(`已入库：新增 ${s.created}、覆盖 ${s.updated}、跳过 ${s.skipped}${tail}，索引稍后自动更新`);
      }
      await qc.invalidateQueries({ queryKey: ['knowledge'] });
    } catch (e) {
      message.error((e as Error).message || '入库失败');
    } finally {
      hide();
    }
  };

  const ingestToKnowledge = async (entry: FileEntry) => {
    const inside = entry.dir
      ? viewEntries.filter((e) => !e.dir && e.path.startsWith(`${entry.path}/`))
      : [entry];
    const picks = inside.slice(0, MAX_INGEST);
    if (!picks.length) {
      message.warning('这个文件夹里没有可入库的文件');
      return;
    }
    await ingestPicks(picks, inside.length - picks.length);
  };

  const ingestSelection = async () => {
    if (!ingestibleSelection.length) {
      message.warning('所选条目中没有可入库的文件');
      return;
    }
    const picks = ingestibleSelection.slice(0, MAX_INGEST);
    await ingestPicks(picks, ingestibleSelection.length - picks.length);
  };

  const batchDownload = () => {
    if (!selectedEntries.length) return;
    const ids = selectedEntries.map((e) => e.id).join(',');
    const link = document.createElement('a');
    link.href = `/api/files/archive?ids=${encodeURIComponent(ids)}`;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const batchRemove = () => {
    if (!removableSelection.length) {
      message.warning('所选条目都不在当前可写范围内');
      return;
    }
    // 同时选中文件夹及其子项时只删最外层：后端删除文件夹是递归的，
    // 子项再删一次只会得到"文件已不存在"。
    const topLevel = removableSelection.filter(
      (e) => !removableSelection.some((p) => p.dir && p.id !== e.id && e.path.startsWith(`${p.path}/`)),
    );
    const dirs = topLevel.filter((e) => e.dir).length;
    const files = topLevel.length - dirs;
    modal.confirm({
      title: `删除选中的 ${topLevel.length} 项？`,
      content: (
        <Flex vertical gap={6}>
          <Typography.Text>
            其中 {dirs} 个文件夹、{files} 个文件，会整体移入回收站。
          </Typography.Text>
          {topLevel.length < selectedEntries.length ? (
            <Typography.Text type="warning">
              另有 {selectedEntries.length - topLevel.length} 项未单独删除（无权限或已包含在所选文件夹内）。
            </Typography.Text>
          ) : null}
          <Typography.Text type="secondary">{retentionHint}</Typography.Text>
        </Flex>
      ),
      okText: '移入回收站',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setBatchBusy(true);
        const results = await Promise.allSettled(topLevel.map((e) => api.fileDelete(e.id)));
        setBatchBusy(false);
        setSelectedKeys([]);
        const failed = results.filter((r) => r.status === 'rejected');
        if (failed.length) {
          const reason = (failed[0] as PromiseRejectedResult).reason as Error;
          message.warning(
            `已删除 ${topLevel.length - failed.length} 项，${failed.length} 项失败：${fileErrorText(reason?.message ?? '')}`,
          );
        } else {
          message.success(`已将 ${topLevel.length} 项移入回收站`);
        }
        await refreshAll();
      },
    });
  };

  const rowMenu = (entry: FileEntry): MenuProps['items'] => {
    const items: NonNullable<MenuProps['items']> = [];
    if (isPersonal && !isSharedView && entry.path && entry.path !== homePath) {
      const existing = shareOf(entry.path);
      items.push({
        key: 'share',
        icon: <TeamOutlined />,
        label: existing?.recipients.length ? `共享中 · ${existing.recipients.length} 人` : '共享给…',
        onClick: () => openShare(entry),
      });
      if (existing) {
        items.push({
          key: 'unshare',
          icon: <StopOutlined />,
          label: '收回共享',
          onClick: () => revokeShare(existing),
        });
      }
      items.push({ type: 'divider' });
    }
    items.push({
      key: 'knowledge',
      icon: <BookOutlined />,
      label: entry.dir ? '入库该目录的文档' : '入库知识库',
      onClick: () => ingestToKnowledge(entry),
    });
    if (!entry.dir && isOfficeEditable(entry.name)) {
      items.push({ type: 'divider' });
      if (canWrite(entry.path)) {
        items.push({
          key: 'office-edit',
          icon: <EditOutlined />,
          label: '网页编辑',
          onClick: () => openOffice(entry, 'edit'),
        });
      }
      if (hasPresentation(entry.name)) {
        items.push({
          key: 'office-present',
          icon: <PlayCircleOutlined />,
          label: '放映幻灯片',
          onClick: () => openOffice(entry, 'present'),
        });
      }
    }
    if (!entry.dir && isGenomeFile(entry.name)) {
      const toGenomes = (action: 'jbrowse' | 'analyze') =>
        navigate(
          `/genomes?genome=${encodeURIComponent(entry.name)}&gid=${encodeURIComponent(entry.id)}&action=${action}`,
        );
      items.push({ type: 'divider' });
      items.push({
        key: 'jbrowse',
        icon: <GlobalOutlined />,
        label: '在 JBrowse 中浏览',
        onClick: () => toGenomes('jbrowse'),
      });
      items.push({
        key: 'analyze',
        icon: <ExperimentOutlined />,
        label: 'rust-bio 序列分析',
        onClick: () => toGenomes('analyze'),
      });
    }
    if (canWrite(entry.path)) {
      items.push({ type: 'divider' });
      items.push({
        key: 'rename',
        icon: <EditOutlined />,
        label: '重命名',
        onClick: () => {
          setDialog({ mode: 'rename', entry });
          setDialogName(entry.name);
        },
      });
      items.push({ type: 'divider' });
      items.push({
        key: 'delete',
        danger: true,
        icon: <DeleteOutlined />,
        label: '删除',
        onClick: () => confirmRemove(entry),
      });
    }
    return items;
  };

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (!writable) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) await uploadFiles(files);
  };

  const parentDir = (() => {
    const parent = baseDir.split('/').slice(0, -1).join('/');
    if (!isSharedView) return parent;
    // 共享视图里上级若不在任何被共享的子树内，直接回到「共享给我」根。
    return sharedRootOf(parent) ? parent : '';
  })();
  const canGoUp = Boolean(baseDir) && baseDir !== scopeRoot;
  const openPreview = (id: string) => {
    setNativePreview(false);
    setPreviewId(id);
  };
  const openOffice = (entry: FileEntry, mode: 'edit' | 'present') => {
    setPreviewId(null);
    setOfficeTarget({ entry, mode });
  };
  const emptyDescription = searching
    ? `没有匹配「${q.trim()}」的文件`
    : isSharedView
      ? baseDir
        ? '这个共享目录为空'
        : '还没有人共享文件给你；同学在「个人文件」里选择共享人后会出现在这里'
      : baseDir
        ? writable
          ? '当前目录为空，可拖拽文件到此处上传'
          : '当前目录为空'
        : '这个共享空间还没有可访问的文件';
  const emptyView = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyDescription} />;

  const rowActions = (r: FileRow) => (
    <Space size={0}>
      {isPersonal && !isSharedView && r.path !== homePath ? (
        <Button size="small" type="link" icon={<TeamOutlined />} onClick={() => openShare(r)}>
          {shareOf(r.path) ? '共享中' : '共享'}
        </Button>
      ) : null}
      {r.dir ? (
        <Button size="small" type="link" onClick={() => openEntry(r)}>
          打开
        </Button>
      ) : (
        <>
          <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => openPreview(r.id)}>
            预览
          </Button>
          {hasPresentation(r.name) ? (
            <Button
              size="small"
              type="link"
              icon={<PlayCircleOutlined />}
              onClick={() => openOffice(r, 'present')}
            >
              放映
            </Button>
          ) : null}
          <Button
            size="small"
            type="link"
            icon={<DownloadOutlined />}
            href={`/api/files/${encodeURIComponent(r.id)}/download`}
          >
            下载
          </Button>
        </>
      )}
      <Dropdown trigger={['click']} menu={{ items: rowMenu(r) }}>
        <Button size="small" type="link" icon={<EllipsisOutlined />} aria-label="更多操作" />
      </Dropdown>
    </Space>
  );

  const openRow = (r: FileRow) => (r.dir ? openEntry(r) : openPreview(r.id));

  return (
    <PageShell
      title="文件共享"
      description="公共资料、质粒与基因组按用户组授权共享；个人文件默认私密，可单独指定共享人。"
      extra={
        <Space wrap>
          {writable ? (
            <>
              <Button
                icon={<FolderAddOutlined />}
                onClick={() => {
                  setDialog({ mode: 'mkdir' });
                  setDialogName('');
                }}
              >
                新建文件夹
              </Button>
              <Upload
                multiple
                showUploadList={false}
                customRequest={async ({ file, onSuccess, onError }) => {
                  try {
                    await uploadFile(file as File);
                    onSuccess?.({});
                  } catch (e) {
                    message.error(`上传失败：${fileErrorText((e as Error).message)}`);
                    onError?.(e as Error);
                  }
                }}
              >
                <Button type="primary" icon={<UploadOutlined />}>
                  上传文件
                </Button>
              </Upload>
            </>
          ) : null}
          {isPersonal && !isSharedView && personalShares.length ? (
            <Badge count={personalShares.length} size="small" offset={[-2, 2]}>
              <Button icon={<TeamOutlined />} onClick={() => setManageOpen(true)}>
                共享管理
              </Button>
            </Badge>
          ) : null}
          {isAdmin ? (
            <Button icon={<HistoryOutlined />} onClick={() => setAuditOpen(true)}>
              访问记录
            </Button>
          ) : null}
          <Badge count={trashItems.length} size="small" offset={[-2, 2]}>
            <Button icon={<RestOutlined />} onClick={() => setTrashOpen(true)}>
              回收站
            </Button>
          </Badge>
          <Button icon={<ReloadOutlined />} onClick={() => list.refetch()} loading={list.isFetching}>
            刷新
          </Button>
        </Space>
      }
    >
      <Card size="small">
        <Flex vertical gap={12}>
          <Flex justify="space-between" align="center" wrap gap={12}>
            <Space size={8} wrap>
              <Segmented
                value={source}
                onChange={(v) => {
                  setSource(String(v));
                  setDir('');
                  setQ('');
                  setPersonalScope('mine');
                }}
                options={(sources.data?.sources ?? []).map((s) => ({
                  value: s.id,
                  label: s.label,
                  disabled: !s.listable,
                }))}
              />
              {isPersonal ? (
                <Segmented
                  size="small"
                  value={personalScope}
                  onChange={(v) => {
                    const next = v as 'mine' | 'shared';
                    setPersonalScope(next);
                    setQ('');
                    setDir(next === 'mine' ? homePath : '');
                  }}
                  options={[
                    { value: 'mine', label: '我的文件' },
                    { value: 'shared', label: `共享给我${sharedWith.length ? ` (${sharedWith.length})` : ''}` },
                  ]}
                />
              ) : null}
            </Space>
            <Space size={8} wrap>
              <Tooltip title="当前目录内直接包含的文件数与占用；整源用量见下一项">
                <Tag icon={<ShareAltOutlined />} color="default">
                  当前目录 {stats.files} 个文件 · {formatSize(stats.size)}
                </Tag>
              </Tooltip>
              <Tooltip
                title={
                  isPersonal
                    ? isSharedView
                      ? '他人共享给我的文件数与占用'
                      : '我的个人空间文件数与占用'
                    : `整个「${activeSource?.label ?? source}」可见范围内的文件数与占用`
                }
              >
                <Tag icon={<DatabaseOutlined />} color="default">
                  共 {stats.totalFiles} 个文件 · {formatSize(stats.totalSize)}
                </Tag>
              </Tooltip>
              {activeSource?.shared ? <Tag color="green">共享空间</Tag> : <Tag>私人空间</Tag>}
              {isSharedView ? <Tag color="blue">他人共享 · 只读</Tag> : null}
              {!isSharedView && activeSource && activeSource.listable && !writable ? (
                <Tag color="default">{sourceWritable ? '当前目录只读' : '只读'}</Tag>
              ) : null}
            </Space>
          </Flex>
          <Flex justify="space-between" align="center" wrap gap={12}>
            <Space size={8} wrap>
              {canGoUp ? (
                <Button
                  size="small"
                  icon={<ArrowLeftOutlined />}
                  onClick={() => setDir(parentDir)}
                >
                  上级
                </Button>
              ) : null}
              <Breadcrumb items={breadcrumb} />
            </Space>
            <Space size={8} wrap>
              <Segmented
                size="small"
                value={viewMode}
                onChange={(v) => setViewMode(v as typeof viewMode)}
                options={[
                  { value: 'list', icon: <UnorderedListOutlined />, title: '列表视图' },
                  { value: 'grid', icon: <AppstoreOutlined />, title: '网格视图' },
                  { value: 'details', icon: <ProfileOutlined />, title: '详情视图' },
                  { value: 'timeline', icon: <ClockCircleOutlined />, title: '时间线视图' },
                ]}
              />
              <Input.Search
                allowClear
                placeholder="在文件源中搜索名称或路径"
                style={{ width: 280 }}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </Space>
          </Flex>
          {activeSource ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {sourceHint(activeSource)}
            </Typography.Text>
          ) : null}
        </Flex>
      </Card>

      <Card
        size="small"
        onDragOver={(e) => {
          if (!writable) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{
          borderColor: dragging ? 'var(--ant-color-primary)' : undefined,
          boxShadow: dragging ? '0 0 0 2px var(--ant-color-primary-border)' : undefined,
        }}
      >
        {dragging ? (
          <Flex align="center" justify="center" gap={8} style={{ padding: 16, color: 'var(--ant-color-primary)' }}>
            <CloudUploadOutlined />
            <span>松开即可上传到当前目录</span>
          </Flex>
        ) : null}
        {list.isLoading ? (
          <Flex justify="center" style={{ padding: 48 }}>
            <Spin />
          </Flex>
        ) : activeSource && !activeSource.listable ? (
          <Alert
            type="warning"
            showIcon
            title="当前账号没有该文件源的访问权限"
            description="如需访问，请联系管理员调整文件共享权限。"
          />
        ) : (
          <>
            {selectedEntries.length ? (
              <Flex
                justify="space-between"
                align="center"
                wrap
                gap={12}
                style={{
                  padding: '8px 12px',
                  marginBottom: 12,
                  background: 'var(--ant-color-fill-secondary)',
                  borderRadius: 8,
                }}
              >
                <Space size={8} wrap>
                  <Typography.Text strong>已选 {selectedEntries.length} 项</Typography.Text>
                  <Typography.Text type="secondary">
                    {ingestibleSelection.length} 个文件 · {formatSize(selectedBytes)}
                  </Typography.Text>
                </Space>
                <Space size={8} wrap>
                  <Button icon={<DownloadOutlined />} onClick={batchDownload}>
                    批量下载
                  </Button>
                  <Button
                    icon={<BookOutlined />}
                    onClick={ingestSelection}
                    disabled={!ingestibleSelection.length}
                  >
                    入库知识库
                  </Button>
                  {writable ? (
                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      loading={batchBusy}
                      disabled={!removableSelection.length}
                      onClick={batchRemove}
                    >
                      批量删除
                    </Button>
                  ) : null}
                  <Button type="text" onClick={() => setSelectedKeys([])}>
                    取消选择
                  </Button>
                </Space>
              </Flex>
            ) : null}
            {viewMode === 'list' ? (
            <Table<FileRow>
              size="small"
              rowKey="id"
              dataSource={rows}
              rowSelection={{
                selectedRowKeys: selectedKeys,
                onChange: (keys) => setSelectedKeys(keys),
                columnWidth: 40,
              }}
              scroll={{ x: 640 }}
            onChange={(_pagination, _filters, sorter) => {
              const active = Array.isArray(sorter) ? sorter[0] : sorter;
              const field = active?.field as FileSortKey | undefined;
              if (!active?.order || !field || !SORT_KEYS.includes(field)) {
                setSortKey('name');
                setOrder('asc');
                return;
              }
              setSortKey(field);
              setOrder(active.order === 'descend' ? 'desc' : 'asc');
            }}
            pagination={{ pageSize: 50, hideOnSinglePage: true, showSizeChanger: false }}
            locale={{
              emptyText: emptyView,
            }}
            columns={[
              {
                title: '名称',
                dataIndex: 'name',
                sorter: true,
                sortOrder: sortKey === 'name' ? (order === 'asc' ? 'ascend' : 'descend') : null,
                render: (name: string, r) => {
                  const v = fileVisual(name, r.dir);
                  return (
                  <Flex vertical gap={0} style={{ minWidth: 0 }}>
                    <Space size={8}>
                      <span style={{ color: v.color, fontSize: 15, lineHeight: 1, display: 'inline-flex' }}>
                        {v.icon}
                      </span>
                      {r.dir ? (
                        <Typography.Link onClick={() => openEntry(r)}>{name}</Typography.Link>
                      ) : (
                        <Typography.Link onClick={() => openPreview(r.id)}>{name}</Typography.Link>
                      )}
                      {!r.dir ? <ExtTag name={name} /> : null}
                    </Space>
                    {/* 列表已取消「位置」列；跨目录搜索结果仍需区分同名文件 */}
                    {searching ? (
                      <Typography.Text
                        type="secondary"
                        ellipsis
                        style={{ fontSize: 12, paddingLeft: 24 }}
                      >
                        {r.path.split('/').slice(0, -1).join('/') || '根目录'}
                      </Typography.Text>
                    ) : isSharedView ? (
                      <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, paddingLeft: 24 }}>
                        <TeamOutlined /> {r.owner ?? r.path.split('/')[0]} 共享
                      </Typography.Text>
                    ) : isPersonal && shareOf(r.path) ? (
                      <Space size={4} style={{ paddingLeft: 24 }} wrap>
                        <TeamOutlined style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)' }} />
                        {shareOf(r.path)!.recipients.map((n) => (
                          <Tag key={n} variant="filled" style={{ fontSize: 11, marginInlineEnd: 0 }}>
                            {n}
                          </Tag>
                        ))}
                      </Space>
                    ) : null}
                  </Flex>
                  );
                },
              },
              {
                title: '大小',
                dataIndex: 'size',
                width: 110,
                align: 'right',
                sorter: true,
                sortOrder: sortKey === 'size' ? (order === 'asc' ? 'ascend' : 'descend') : null,
                // 目录自身字节数为 0，展示"—"，真实占用见用量标签
                render: (n: number, r) => (r.dir ? '—' : formatSize(n)),
              },
              {
                title: '修改时间',
                dataIndex: 'modified',
                width: 180,
                responsive: ['lg'],
                sorter: true,
                sortOrder: sortKey === 'modified' ? (order === 'asc' ? 'ascend' : 'descend') : null,
                render: formatTime,
              },
              {
                title: '创建时间',
                dataIndex: 'created',
                width: 180,
                responsive: ['xl'],
                sorter: true,
                sortOrder: sortKey === 'created' ? (order === 'asc' ? 'ascend' : 'descend') : null,
                render: formatTime,
              },
              {
                title: '操作',
                width: isPersonal && !isSharedView ? 260 : sourceWritable ? 190 : 140,
                align: 'right',
                render: (_: unknown, r) => (
                  <Space size={0}>
                    {isPersonal && !isSharedView && r.path !== homePath ? (
                      <Button
                        size="small"
                        type="link"
                        icon={<TeamOutlined />}
                        onClick={() => openShare(r)}
                      >
                        {shareOf(r.path) ? '共享中' : '共享'}
                      </Button>
                    ) : null}
                    {r.dir ? (
                      <Button size="small" type="link" onClick={() => openEntry(r)}>
                        打开
                      </Button>
                    ) : (
                      <>
                        <Button size="small" type="link" icon={<EyeOutlined />} onClick={() => openPreview(r.id)}>
                          预览
                        </Button>
                        {hasPresentation(r.name) ? (
                          <Tooltip title="放映幻灯片">
                            <Button
                              size="small"
                              type="link"
                              icon={<PlayCircleOutlined />}
                              onClick={() => openOffice(r, 'present')}
                            />
                          </Tooltip>
                        ) : null}
                        <Button
                          size="small"
                          type="link"
                          icon={<DownloadOutlined />}
                          href={`/api/files/${encodeURIComponent(r.id)}/download`}
                        >
                          下载
                        </Button>
                      </>
                    )}
                    <Dropdown trigger={['click']} menu={{ items: rowMenu(r) }}>
                      <Button size="small" type="link" icon={<EllipsisOutlined />} aria-label="更多操作" />
                    </Dropdown>
                  </Space>
                ),
              },
            ]}
            />
            ) : viewMode === 'grid' ? (
              rows.length ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
                    gap: 12,
                  }}
                >
                  {rows.map((r) => {
                    const v = fileVisual(r.name, r.dir);
                    const selected = selectedKeys.includes(r.id);
                    const shared = isPersonal && !isSharedView && shareOf(r.path);
                    return (
                      <Card
                        key={r.id}
                        size="small"
                        hoverable
                        onClick={() => openRow(r)}
                        style={{
                          borderColor: selected ? 'var(--ant-color-primary)' : undefined,
                          boxShadow: selected ? '0 0 0 2px var(--ant-color-primary-border)' : undefined,
                        }}
                        styles={{ body: { padding: 14, display: 'flex', flexDirection: 'column', gap: 8 } }}
                      >
                        <Flex justify="space-between" align="flex-start">
                          <span style={{ fontSize: 28, lineHeight: 1, color: v.color }}>{v.icon}</span>
                          <Checkbox
                            checked={selected}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleSelect(r.id)}
                            aria-label={`选择 ${r.name}`}
                          />
                        </Flex>
                        <Tooltip title={r.name}>
                          <Typography.Text strong ellipsis>
                            {r.name}
                          </Typography.Text>
                        </Tooltip>
                        <Space size={4} wrap>
                          {r.dir ? (
                            <Tag variant="filled">文件夹</Tag>
                          ) : (
                            <Tag variant="filled">
                              {extOf(r.name).toUpperCase() || '文件'} · {formatSize(r.size)}
                            </Tag>
                          )}
                          {shared ? (
                            <Tag color="blue" variant="filled">
                              共享中
                            </Tag>
                          ) : null}
                        </Space>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                          {formatTime(r.modified)}
                        </Typography.Text>
                        <Flex
                          justify="space-between"
                          align="center"
                          onClick={(e) => e.stopPropagation()}
                          style={{ marginTop: 'auto' }}
                        >
                          <Space size={0}>
                            {r.dir ? (
                              <Button size="small" type="link" onClick={() => openEntry(r)}>
                                打开
                              </Button>
                            ) : (
                              <>
                                <Button
                                  size="small"
                                  type="link"
                                  icon={<EyeOutlined />}
                                  onClick={() => openPreview(r.id)}
                                />
                                {hasPresentation(r.name) ? (
                                  <Tooltip title="放映幻灯片">
                                    <Button
                                      size="small"
                                      type="link"
                                      icon={<PlayCircleOutlined />}
                                      onClick={() => openOffice(r, 'present')}
                                    />
                                  </Tooltip>
                                ) : null}
                                <Button
                                  size="small"
                                  type="link"
                                  icon={<DownloadOutlined />}
                                  href={`/api/files/${encodeURIComponent(r.id)}/download`}
                                />
                              </>
                            )}
                          </Space>
                          <Dropdown trigger={['click']} menu={{ items: rowMenu(r) }}>
                            <Button size="small" type="text" icon={<EllipsisOutlined />} aria-label="更多操作" />
                          </Dropdown>
                        </Flex>
                      </Card>
                    );
                  })}
                </div>
              ) : (
                emptyView
              )
            ) : viewMode === 'details' ? (
              rows.length ? (
                <Flex vertical gap={8}>
                  {rows.map((r) => {
                    const v = fileVisual(r.name, r.dir);
                    return (
                      <Card key={r.id} size="small" styles={{ body: { padding: '10px 14px' } }}>
                        <Flex align="center" gap={12} wrap>
                          <Checkbox
                            checked={selectedKeys.includes(r.id)}
                            onChange={() => toggleSelect(r.id)}
                            aria-label={`选择 ${r.name}`}
                          />
                          <span style={{ fontSize: 22, lineHeight: 1, color: v.color }}>{v.icon}</span>
                          <div style={{ flex: 1, minWidth: 180 }}>
                            <Tooltip title={r.name}>
                              <Typography.Link strong ellipsis onClick={() => openRow(r)}>
                                {r.name}
                              </Typography.Link>
                            </Tooltip>
                            <div>
                              <Typography.Text
                                type="secondary"
                                ellipsis
                                style={{ fontSize: 12, fontFamily: 'monospace' }}
                              >
                                {r.path}
                              </Typography.Text>
                            </div>
                          </div>
                          <Space size={22} wrap>
                            <div>
                              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                                大小
                              </Typography.Text>
                              <div>{r.dir ? '—' : formatSize(r.size)}</div>
                            </div>
                            <div>
                              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                                修改时间
                              </Typography.Text>
                              <div style={{ fontSize: 12 }}>{formatTime(r.modified)}</div>
                            </div>
                            <div>
                              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                                创建时间
                              </Typography.Text>
                              <div style={{ fontSize: 12 }}>{formatTime(r.created)}</div>
                            </div>
                            {isSharedView ? (
                              <Tag variant="filled" color="blue">
                                {(r as FileRow).owner ?? r.path.split('/')[0]} 共享
                              </Tag>
                            ) : null}
                          </Space>
                          {rowActions(r)}
                        </Flex>
                      </Card>
                    );
                  })}
                </Flex>
              ) : (
                emptyView
              )
            ) : rows.length ? (
              <Flex vertical gap={16}>
                {timelineGroups.map(([day, dayRows]) => (
                  <Flex vertical gap={8} key={day}>
                    <Flex align="center" gap={8}>
                      <Tag color="blue" variant="filled">
                        {day}
                      </Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {dayRows.length} 项
                      </Typography.Text>
                    </Flex>
                    <div
                      style={{
                        marginLeft: 6,
                        paddingLeft: 16,
                        borderLeft: '2px solid var(--ant-color-border-secondary)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      {dayRows.map((r) => {
                        const v = fileVisual(r.name, r.dir);
                        return (
                          <Card
                            key={r.id}
                            size="small"
                            hoverable
                            onClick={() => openRow(r)}
                            styles={{ body: { padding: '8px 12px' } }}
                          >
                            <Flex align="center" gap={10} wrap>
                              <span style={{ color: v.color, fontSize: 16, lineHeight: 1 }}>{v.icon}</span>
                              <Tooltip title={r.name}>
                                <Typography.Link ellipsis style={{ flex: 1, minWidth: 140 }}>
                                  {r.name}
                                </Typography.Link>
                              </Tooltip>
                              <Tag variant="filled">
                                {r.dir ? '文件夹' : formatSize(r.size)}
                              </Tag>
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                {formatTime(r.modified)}
                              </Typography.Text>
                              <span onClick={(e) => e.stopPropagation()}>
                                <Dropdown trigger={['click']} menu={{ items: rowMenu(r) }}>
                                  <Button size="small" type="text" icon={<EllipsisOutlined />} aria-label="更多操作" />
                                </Dropdown>
                              </span>
                            </Flex>
                          </Card>
                        );
                      })}
                    </div>
                  </Flex>
                ))}
              </Flex>
            ) : (
              emptyView
            )}
          </>
        )}
        {list.isError ? (
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            showIcon
            title="文件列表加载失败"
            description={(list.error as Error)?.message}
          />
        ) : null}
      </Card>

      <Modal
        open={Boolean(previewId)}
        title={previewEntry?.name ?? '文件预览'}
        width={960}
        onCancel={() => setPreviewId(null)}
        destroyOnHidden
        footer={
          previewEntry ? (
            <Space wrap>
              <Button onClick={() => setPreviewId(null)}>关闭</Button>
              {isOfficeEditable(previewEntry.name) && canWrite(previewEntry.path) ? (
                <Button icon={<EditOutlined />} onClick={() => openOffice(previewEntry, 'edit')}>
                  网页编辑
                </Button>
              ) : null}
              {hasPresentation(previewEntry.name) ? (
                <Button icon={<PlayCircleOutlined />} onClick={() => openOffice(previewEntry, 'present')}>
                  放映
                </Button>
              ) : null}
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                href={`/api/files/${encodeURIComponent(previewEntry.id)}/download`}
              >
                下载原文件
              </Button>
            </Space>
          ) : null
        }
      >
        {!nativePreview && !bioDirect ? (
          <OpenFilePreview
            key={previewId}
            id={previewId!}
            name={previewEntry?.name ?? ''}
            onUnsupported={() => setNativePreview(true)}
          />
        ) : preview.isLoading ? (
          <Flex justify="center" style={{ padding: 40 }}>
            <Spin />
          </Flex>
        ) : preview.isError ? (
          <Alert type="error" showIcon title="无法预览该文件" description={(preview.error as Error)?.message} />
        ) : preview.data ? (
          <Flex vertical gap={12}>
            <PreviewBody data={preview.data} />
            {preview.data.truncated ? (
              <Typography.Text type="secondary">内容较大，仅展示前一部分。</Typography.Text>
            ) : null}
          </Flex>
        ) : null}
      </Modal>

      <OfficeWorkspace
        entry={officeTarget?.entry ?? null}
        mode={officeTarget?.mode ?? 'edit'}
        open={Boolean(officeTarget)}
        onClose={() => setOfficeTarget(null)}
        onSaved={() => {
          message.success('已保存回文件服务器');
          void refreshAll();
        }}
      />

      <Modal
        open={Boolean(dialog)}
        title={dialog?.mode === 'mkdir' ? '新建文件夹' : '重命名'}
        okText={dialog?.mode === 'mkdir' ? '创建' : '保存'}
        cancelText="取消"
        confirmLoading={busy}
        onOk={submitDialog}
        onCancel={() => setDialog(null)}
        destroyOnHidden
      >
        <Input
          autoFocus
          value={dialogName}
          maxLength={120}
          placeholder={dialog?.mode === 'mkdir' ? '文件夹名称' : '新名称'}
          onChange={(e) => setDialogName(e.target.value)}
          onPressEnter={submitDialog}
        />
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
          {dialog?.mode === 'mkdir'
            ? `创建位置：${baseDir || '当前目录'}`
            : `当前名称：${dialog?.entry?.name ?? ''}`}
        </Typography.Text>
      </Modal>

      <Modal
        open={Boolean(shareTarget)}
        title={`共享「${shareTarget?.name ?? ''}」`}
        okText="保存共享"
        cancelText="取消"
        confirmLoading={shareBusy}
        onOk={saveShare}
        onCancel={() => setShareTarget(null)}
        destroyOnHidden
      >
        <Flex vertical gap={10}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            被选择的同学会在「文件管理 → 个人文件 → 共享给我」中看到该路径，只读预览与下载；名单留空保存即收回共享。
          </Typography.Text>
          <Select
            mode="multiple"
            allowClear
            value={sharePicks}
            onChange={setSharePicks}
            placeholder={shareRecipients.length ? '选择共享人' : '暂无可共享的其他账号'}
            showSearch={{ optionFilterProp: 'label' }}
            options={shareRecipients.map((name) => ({ value: name, label: name }))}
            style={{ width: '100%' }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            路径：{shareTarget ? relPath(shareTarget.path) : ''} · 可共享对象：{shareRecipients.length} 人
          </Typography.Text>
        </Flex>
      </Modal>

      <Modal
        open={manageOpen}
        title="共享管理"
        width={720}
        onCancel={() => setManageOpen(false)}
        footer={
          <Button type="primary" onClick={() => setManageOpen(false)}>
            关闭
          </Button>
        }
      >
        <Flex vertical gap={12}>
          <Alert
            type="info"
            showIcon
            title="个人文件默认仅本人可见；共享为只读，名单变更立即生效。"
            description="收回共享后，对方将无法继续预览或下载该路径，但已下载的副本无法追回。"
          />
          <Table<PersonalShare>
            size="small"
            rowKey="path"
            dataSource={personalShares}
            pagination={false}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有共享任何文件" /> }}
            columns={[
              {
                title: '路径',
                dataIndex: 'path',
                render: (p: string) => <Typography.Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{p}</Typography.Text>,
              },
              {
                title: '共享给',
                dataIndex: 'recipients',
                render: (names: string[]) => (
                  <Space size={4} wrap>
                    {names.map((n) => (
                      <Tag key={n} variant="filled">
                        {n}
                      </Tag>
                    ))}
                  </Space>
                ),
              },
              {
                title: '操作',
                width: 130,
                align: 'right',
                render: (_: unknown, r) => (
                  <Space size={0}>
                    <Button size="small" type="link" onClick={() => editShare(r)}>
                      编辑
                    </Button>
                    <Button size="small" type="link" danger onClick={() => revokeShare(r)}>
                      收回
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        </Flex>
      </Modal>

      <Modal
        open={trashOpen}
        title="回收站"
        width={920}
        onCancel={() => setTrashOpen(false)}
        footer={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => trash.refetch()} loading={trash.isFetching}>
              刷新
            </Button>
            <Button danger icon={<ClearOutlined />} disabled={!trashItems.length} onClick={emptyTrash}>
              清空回收站
            </Button>
            <Button type="primary" onClick={() => setTrashOpen(false)}>
              关闭
            </Button>
          </Space>
        }
      >
        <Flex vertical gap={12}>
          <Alert
            type="info"
            showIcon
            title={retentionHint}
            description={
              trashItems.length
                ? `当前 ${trashItems.length} 项、${formatSize(trash.data?.totalBytes ?? 0)}，到期后自动清除；彻底删除可立即释放磁盘。`
                : '这里只列出你有权处置的记录，他人删除的内容不会出现在你的回收站里。'
            }
          />
          <Table<FileTrashItem>
            size="small"
            rowKey="id"
            loading={trash.isLoading || trash.isFetching}
            dataSource={trashItems}
            scroll={{ x: 720 }}
            pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="回收站是空的" /> }}
            columns={[
              {
                title: '名称',
                dataIndex: 'name',
                render: (name: string, r) => (
                  <Space size={8}>
                    {r.dir ? (
                      <FolderOpenOutlined style={{ color: '#D97706' }} />
                    ) : (
                      <FileOutlined style={{ color: 'var(--ant-color-text-tertiary)' }} />
                    )}
                    <Typography.Text ellipsis>{name}</Typography.Text>
                    {!r.dir ? <ExtTag name={name} /> : null}
                  </Space>
                ),
              },
              {
                title: '原位置',
                dataIndex: 'path',
                render: (_: string, r) => (
                  <Flex vertical gap={0}>
                    <Typography.Text style={{ fontSize: 12 }}>{r.sourceLabel || r.source}</Typography.Text>
                    <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
                      {r.path}
                    </Typography.Text>
                  </Flex>
                ),
              },
              {
                title: '大小',
                dataIndex: 'size',
                width: 130,
                align: 'right',
                render: (n: number, r) => (r.dir ? `${formatSize(n)} · ${r.paths} 项` : formatSize(n)),
              },
              {
                title: '删除',
                dataIndex: 'deletedAt',
                width: 170,
                responsive: ['lg'],
                render: (v: string, r) => (
                  <Flex vertical gap={0}>
                    <Typography.Text style={{ fontSize: 12 }}>{formatTime(v)}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {r.deletedBy} 删除
                    </Typography.Text>
                  </Flex>
                ),
              },
              {
                title: '剩余保留期',
                dataIndex: 'expiresAt',
                width: 120,
                render: (v: string) => {
                  const days = Math.ceil((new Date(v).getTime() - Date.now()) / 86_400_000);
                  return <Tag color={days <= 3 ? 'red' : 'default'}>{trashLeft(v)}</Tag>;
                },
              },
              {
                title: '操作',
                width: 170,
                align: 'right',
                render: (_: unknown, r) => (
                  <Space size={0}>
                    <Tooltip
                      title={r.restorable ? undefined : '当前账号在原来的位置没有写入权限，无法恢复'}
                    >
                      <Button
                        size="small"
                        type="link"
                        icon={<UndoOutlined />}
                        disabled={!r.restorable}
                        onClick={() => restoreItem(r)}
                      >
                        恢复
                      </Button>
                    </Tooltip>
                    <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={() => purgeItem(r)}>
                      彻底删除
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        </Flex>
      </Modal>

      <Modal
        open={auditOpen}
        title="文件访问记录"
        width={980}
        onCancel={() => setAuditOpen(false)}
        footer={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => audit.refetch()} loading={audit.isFetching}>
              刷新
            </Button>
            <Button type="primary" onClick={() => setAuditOpen(false)}>
              关闭
            </Button>
          </Space>
        }
      >
        <Flex vertical gap={12}>
          <Alert
            type="info"
            showIcon
            title={`记录全站文件的预览与下载行为，保留 ${audit.data?.retentionDays ?? 90} 天，仅管理员可见。`}
            description="事件由服务端在预览/下载成功时写入；服务令牌的内部读取不计入个人记录。"
          />
          <Segmented
            value={auditAction}
            onChange={(v) => setAuditAction(v as 'all' | 'preview' | 'download')}
            options={[
              { label: '全部', value: 'all' },
              { label: '预览', value: 'preview' },
              { label: '下载', value: 'download' },
            ]}
          />
          <Table<FileAccessEvent>
            size="small"
            rowKey="id"
            loading={audit.isLoading || audit.isFetching}
            dataSource={audit.data?.events ?? []}
            scroll={{ x: 820 }}
            pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无访问记录" /> }}
            columns={[
              {
                title: '时间',
                dataIndex: 'at',
                width: 175,
                render: (v: string) => <Typography.Text style={{ fontSize: 12 }}>{formatTime(v)}</Typography.Text>,
              },
              {
                title: '用户',
                dataIndex: 'userId',
                width: 170,
                render: (v: string) => <Typography.Text ellipsis>{v}</Typography.Text>,
              },
              {
                title: '动作',
                dataIndex: 'action',
                width: 80,
                render: (v: string) => (
                  <Tag color={v === 'download' ? 'blue' : v === 'preview' ? 'green' : 'default'}>
                    {v === 'download' ? '下载' : v === 'preview' ? '预览' : v}
                  </Tag>
                ),
              },
              {
                title: '文件',
                dataIndex: 'name',
                render: (name: string, r) => (
                  <Flex vertical gap={0}>
                    <Typography.Text ellipsis>{name}</Typography.Text>
                    <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
                      {sources.data?.sources.find((s) => s.id === r.source)?.label ?? r.source} · {r.path}
                    </Typography.Text>
                  </Flex>
                ),
              },
              {
                title: '大小',
                dataIndex: 'bytes',
                width: 100,
                align: 'right',
                render: (n: number) => formatSize(n),
              },
            ]}
          />
        </Flex>
      </Modal>
    </PageShell>
  );
}
