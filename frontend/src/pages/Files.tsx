import { useEffect, useMemo, useState, type Key, type ReactNode } from 'react';
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
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  Progress,
  Upload,
} from 'antd';
import {
  AppstoreOutlined,
  ArrowLeftOutlined,
  BookOutlined,
  ClearOutlined,
  ClockCircleOutlined,
  CloudUploadOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EllipsisOutlined,
  ExperimentOutlined,
  EyeOutlined,
  FileOutlined,
  FileAddOutlined,
  FolderAddOutlined,
  GlobalOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  PlayCircleOutlined,
  ProfileOutlined,
  ReloadOutlined,
  RestOutlined,
  ShareAltOutlined,
  CopyOutlined,
  SnippetsOutlined,
  StopOutlined,
  SwapOutlined,
  TeamOutlined,
  UndoOutlined,
  UnorderedListOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { resolveDisplayName, usePeopleMap } from '../utils/displayName';
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
import { useFileUpload } from '../hooks/useFileUpload';
import OpenFilePreview from '../components/OpenFilePreview';
import PageShell from '../components/PageShell';
import OfficeWorkspace from '../components/office/OfficeWorkspace';
import { hasPresentation, isOfficeEditable } from '../components/office/registry';
import TimelineView from '../components/files/TimelineView';
import TextEditorModal from '../components/files/TextEditorModal';
import {
  extOf,
  fileVisual,
  formatSize,
  formatTime,
  isGenomeFile,
  isImageFile,
  isTextEditable,
} from '../components/files/fileMeta';

/** 缩略图：只有图片走 <img>，其余保持图标。
 *  preview 接口本身已按会话鉴权，且带 maxPreviewBytes 限制，不会把大图拖进列表。 */
function FileThumb({ id, name, size = 26 }: { id: string; name: string; size?: number }) {
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
        border: '1px solid var(--ant-color-border-secondary, #EEF0F4)',
        background: 'var(--ant-color-fill-quaternary, rgba(0,0,0,0.03))',
        flex: '0 0 auto',
      }}
    />
  );
}

function shortDate(v: string) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('zh-CN');
}

/** 回收站条目的剩余保留期：只说"7 天"是不够的，用户关心还剩几天。 */
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

/**
 * 按存储用途推荐默认视图。
 *
 * - 普通个人文件（users）：条目多、命名杂，列表视图按名字/大小扫一眼最快，默认列表。
 * - 公共基因组 / 公共资料（genomes、public）：内容是持续堆积的“资料堆”，
 *   更关心“什么时候进来的”，默认时间线（按创建时间分组）。
 */
const TIMELINE_FIRST_SOURCES = new Set(['genomes', 'public']);

function recommendedView(source: string): 'list' | 'timeline' {
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
  /**
   * 「新建文件」弹窗。
   *
   * 为什么要有：文件存储以前只能"上传"或"新建文件夹"，想记一段文字、
   * 起草一个脚本都得先在本地建好再传上来 —— 手机上根本做不到。
   * 新建的文件落在当前目录，随后可以直接用在线编辑器打开。
   */
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [newFileBody, setNewFileBody] = useState('');
  const [newFileBusy, setNewFileBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditAction, setAuditAction] = useState<'all' | 'preview' | 'download'>('all');
  const [personalScope, setPersonalScope] = useState<'mine' | 'shared'>('mine');
  const [shareTarget, setShareTarget] = useState<FileEntry | null>(null);
  const [sharePicks, setSharePicks] = useState<string[]>([]);
  // 「允许对方编辑」：共享默认只读，只有 owner 显式勾选才带上写权限。
  const [shareWritable, setShareWritable] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'grid' | 'details' | 'timeline'>(() => {
    const raw = urlParams.get('view');
    if (raw === 'grid' || raw === 'details' || raw === 'timeline') return raw;
    // 没有 URL 指定视图时，按存储用途给默认建议（见 recommendedView）。
    return recommendedView(urlParams.get('source') || 'public');
  });
  // 用户手动切过视图后就不再自动跟随存储用途的推荐（URL 指定视图也算手动）。
  const [viewPinned, setViewPinned] = useState(() => Boolean(urlParams.get('view')));
  // 在线编辑（纯文本）：行菜单点「在线编辑」打开。
  const [textEditTarget, setTextEditTarget] = useState<FileEntry | null>(null);
  /**
   * 上传进度：批量/文件夹上传动辄几百个文件，必须让用户看得见
   * 「传到第几个 / 有没有失败」，否则界面像卡死了。
   */


  // 切换文件源、目录或搜索词后，旧选择不再对应当前列表，必须整体丢弃，
  // 否则批量操作会作用到用户已经看不到的条目上。
  useEffect(() => {
    setSelectedKeys([]);
  }, [source, dir, q, personalScope]);

  useEffect(() => {
    setNativePreview(false);
  }, [previewId]);

  // 切换存储源时自动套用该用途的推荐视图（用户手动选过就不再打扰）。
  useEffect(() => {
    if (viewPinned) return;
    setViewMode(recommendedView(source));
  }, [source, viewPinned]);

  const sources = useQuery({ queryKey: ['file-sources'], queryFn: api.fileSources, staleTime: 60_000 });
  /**
   * 文件列表要**看得见别人的改动**：别人删了共享给我的文件，
   * 我的页面不能还留着那条（点开才发现是 404）。
   * 因此这里开窗口聚焦刷新 + 30 秒轮询（后台标签页会自动暂停），
   * 而不是全局那个「聚焦不刷新」的默认设置。
   */
  const list = useQuery({
    queryKey: ['files', source, sortKey, order],
    queryFn: () => api.files(source, sortKey, order),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
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
  const retentionDays = trash.data?.retentionDays ?? 7;
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
  // 人员目录：把共享者/拥有者显示成姓名而不是用户名
  const peopleMap = usePeopleMap();
  const sourceWritable = Boolean(activeSource?.writable);
  const writePaths = activeSource?.writePaths ?? [];
  const canWrite = (path: string) =>
    sourceWritable &&
    writePaths.some((p) => p === '' || path === p || path.startsWith(`${p}/`));
  // 「能传文件」与「能建目录」是两件事：共享目录里的学生只准上传材料，
  // 目录结构由导师维护，所以新建文件夹按钮要单独判。
  const mkdirPaths = activeSource?.mkdirPaths ?? [];
  const canMkdir = (path: string) =>
    sourceWritable &&
    mkdirPaths.some((p) => p === '' || path === p || path.startsWith(`${p}/`));
  const isPersonal = source === 'users';
  const isSharedView = isPersonal && personalScope === 'shared';

  // 共享名单：候选共享人与「我共享出去」的现状都从服务端取，避免前端猜。
  const shares = useQuery({
    queryKey: ['file-shares'],
    queryFn: api.fileShares,
    enabled: isPersonal,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
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
  // 共享子树里的写权限来自共享 scope，而不是自己的家目录：可写共享的条目
  // （含其子目录）才可以移动/改名/上传。
  const sharedWritableOf = (p: string) => {
    const root = sharedRootOf(p);
    if (!root) return false;
    return sharedWith.some((s) => s.path === root && s.writable);
  };
  // 自己空间里看写路径（服务端返回的 writePaths），共享视图里看可写共享。
  const canMoveEntry = (p: string) => (isSharedView ? sharedWritableOf(p) : canWrite(p));

  const baseDir = isPersonal ? (isSharedView ? dir : dir || homePath) : dir;
  const writable = !isSharedView && canWrite(baseDir);
  // 可写共享的目录同样允许上传/新建：写权限来自共享 scope，而不是自己的家目录。
  const writableHere = writable || (isSharedView && sharedWritableOf(baseDir));
  const mkdirHere = canMkdir(baseDir) || (isSharedView && sharedWritableOf(baseDir));

  /**
   * 上传逻辑（单文件 / 批量 / 文件夹树 / 拖拽目录）整体在 hook 里，
   * 页面只负责显示进度与失败明细。详见 hooks/useFileUpload.ts。
   */
  const {
    uploading,
    uploadErrors,
    setUploadErrors,
    uploadOne,
    uploadTree,
    handleDrop,
  } = useFileUpload({
    target: () => ({ source, dir: isPersonal ? baseDir : dir }),
    onUploaded: () => refresh(),
    confirmOverwrite: (name) =>
      new Promise<boolean>((resolve) => {
        modal.confirm({
          title: '同名文件已存在',
          content: `${name} 已存在于当前目录，是否覆盖？`,
          okText: '覆盖',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      }),
  });
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

  /**
   * 新建文件：把内容当作一个空文件上传到当前目录。
   *
   * 复用上传通道而不是新增后端接口 —— 少一条路径少一份权限逻辑，
   * 而且"新建"和"上传"在文件核心里本来就是同一件事。
   */
  const submitNewFile = async () => {
    const name = newFileName.trim();
    if (!name) return;
    setNewFileBusy(true);
    try {
      const file = new File([newFileBody], name, { type: 'text/plain;charset=utf-8' });
      await uploadOne(file);
      message.success(`已新建「${name}」`);
      setNewFileOpen(false);
      setNewFileName('');
      setNewFileBody('');
      await refresh();
    } catch (e) {
      message.error(fileErrorText((e as Error).message));
    } finally {
      setNewFileBusy(false);
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
    setShareWritable(existing?.writable ?? false);
    setShareTarget(entry);
  };

  const saveShare = async () => {
    if (!shareTarget) return;
    setShareBusy(true);
    try {
      await api.fileShare(relPath(shareTarget.path), sharePicks, shareWritable);
      message.success(
        sharePicks.length
          ? `已共享给 ${sharePicks.map((n) => resolveDisplayName(n, peopleMap, n)).join('、')}（${sharePicks.length} 人）${shareWritable ? '（可编辑）' : ''}`
          : '已收回该路径的共享',
      );
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
    setShareWritable(share.writable);
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
      content: `${share.recipients.map((n) => resolveDisplayName(n, peopleMap, n)).join('、')} 将不能再查看该路径；已下载的副本无法收回。`,
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

  /**
   * 直接删除：不进回收站、不可恢复。
   *
   * 与"移入回收站"的区别要说清楚——回收站保留 7 天可恢复，
   * 这里是从磁盘抹掉，误操作就没了。所以确认框必须写明不可恢复。
   */
  const destroyEntry = async (entry: FileEntry) => {
    try {
      await api.fileDestroy(entry.id);
      message.success(`已永久删除 ${entry.name}`);
      if (previewId === entry.id) setPreviewId(null);
      await refreshAll();
    } catch (e) {
      message.error(fileErrorText((e as Error).message));
    }
  };

  /** 确认"直接删除"：二次确认 + 明确不可恢复。 */
  const confirmDestroy = (entry: FileEntry) => {
    modal.confirm({
      title: `永久删除 ${entry.name}？`,
      content: (
        <Flex vertical gap={6}>
          <Typography.Text type="danger">
            这会**直接从磁盘删除**，不进回收站、无法恢复。
          </Typography.Text>
          <Typography.Text type="secondary">
            {formatSize(entry.size || 0)} · {entry.path}
          </Typography.Text>
        </Flex>
      ),
      okText: '永久删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => destroyEntry(entry),
    });
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
          {isSharedView ? (
            <Typography.Text type="warning">
              这是共享文件：删除后共享人那边的副本会同时消失。
            </Typography.Text>
          ) : null}
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

  // ---------------------------------------------------------------- 移动
  // 目标目录来自服务端返回的可读目录清单（list.data.dirs），不在前端推断权限。
  const moveTargets = useMemo(() => {
    const dirs = list.data?.dirs ?? [''];
    if (!isSharedView) return dirs;
    // 共享视图里只有"可写共享目录"与"自己的家目录"是合法目标：
    // 存储源根目录不属于任何人，放进去必然被拒。
    return dirs.filter((d) => {
      if (!d) return false;
      if (homePath && (d === homePath || d.startsWith(`${homePath}/`))) return true;
      return sharedWritableOf(d);
    });
  }, [list.data?.dirs, isSharedView, homePath, sharedWith]);
  const [moveIds, setMoveIds] = useState<string[]>([]);
  // 复制/粘贴：与「移动」分开，复制不动原件，更符合日常文件操作习惯。
  const [clipboard, setClipboard] = useState<{ ids: string[]; names: string[] } | null>(null);
  const [moveTo, setMoveTo] = useState<string>('');

  const openMove = (entries: FileEntry[]) => {
    // 共享给我的内容默认只读（见 SetPersonalShare）：移动必须对源条目有 modify、
    // 对目标有 create，只读共享必然 403，所以直说并给出"复制"路径。
    // 只有 owner 显式勾选了「允许对方编辑」的共享才可以移动。
    const movable = entries.filter((e) => canMoveEntry(e.path));
    if (!movable.length) {
      if (isSharedView) {
        message.info('共享内容是只读的：请用「复制」，再切到「个人文件」里点「粘贴」，即可得到一份可编辑的副本。');
        return;
      }
      message.warning('所选条目都不在当前可写范围内');
      return;
    }
    if (movable.length < entries.length) {
      message.info(`已跳过 ${entries.length - movable.length} 个无写权限的条目`);
    }
    setMoveIds(movable.map((e) => e.id));
    // 共享视图的默认目标是自己的家目录：存储源根目录不属于任何人，放进去必被拒。
    setMoveTo(isSharedView ? (moveTargets.find((d) => d === homePath) ?? moveTargets[0] ?? '') : '');
  };

  const copyToClipboard = (entries: FileEntry[]) => {
    if (!entries.length) return;
    setClipboard({ ids: entries.map((e) => e.id), names: entries.map((e) => e.name) });
    message.success(`已复制 ${entries.length} 项，切换到目标目录后点「粘贴」`);
  };

  const pasteHere = async () => {
    if (!clipboard?.ids.length) return;
    setBatchBusy(true);
    let ok = 0;
    const failures: string[] = [];
    for (const id of clipboard.ids) {
      try {
        await api.fileCopy(id, baseDir || '');
        ok += 1;
      } catch (err) {
        failures.push((err as Error).message);
      }
    }
    setBatchBusy(false);
    if (ok) message.success(`已粘贴 ${ok} 项到当前目录`);
    if (failures.length) message.warning(`有 ${failures.length} 项未能粘贴：${failures[0]}`);
    await list.refetch();
  };

  const doMove = async () => {
    if (!moveIds.length) return;
    setBatchBusy(true);
    try {
      const res = await api.fileMove(moveIds, moveTo);
      const ok = res.moved.length;
      const bad = res.failed.length;
      if (ok) message.success(`已移动 ${ok} 项`);
      if (bad) {
        const first = res.failed[0];
        message.warning(`${bad} 项未能移动：${first.error}${bad > 1 ? ' 等' : ''}`);
      }
      setMoveIds([]);
      setSelectedKeys([]);
      await list.refetch();
    } catch (err) {
      message.error((err as Error).message || '移动失败');
    } finally {
      setBatchBusy(false);
    }
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
    // 在线编辑：只给纯文本类扩展名（txt/md/csv/json/代码等），二进制文件不出现入口。
    if (!entry.dir && isTextEditable(entry.name)) {
      items.push({
        key: 'text-edit',
        icon: <EditOutlined />,
        label: '在线编辑',
        onClick: () => setTextEditTarget(entry),
      });
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
    if (canMoveEntry(entry.path)) {
      items.push({
        key: 'move',
        icon: <SwapOutlined />,
        label: '移动到…',
        onClick: () => openMove([entry]),
      });
    }
    if (canWrite(entry.path)) {
      items.push({
        key: 'copy',
        icon: <CopyOutlined />,
        label: '复制',
        onClick: () => copyToClipboard([entry]),
      });
    }
    if (canMoveEntry(entry.path)) {
      items.push({
        key: 'rename',
        icon: <EditOutlined />,
        label: '重命名',
        onClick: () => {
          setDialog({ mode: 'rename', entry });
          setDialogName(entry.name);
        },
      });
    }
    // 删除：自己空间按写权限；共享视图里**任何人都能删**（物理只有一份，
    // 删了共享人那边同步消失），所以共享条目也给删除入口并写清后果。
    if (canWrite(entry.path) || isSharedView) {
      items.push({ type: 'divider' });
      items.push({
        key: 'delete',
        danger: true,
        icon: <DeleteOutlined />,
        label: isSharedView ? '删除（共享人同步删除）' : '删除',
        onClick: () => confirmRemove(entry),
      });
      items.push({
        key: 'destroy',
        danger: true,
        icon: <DeleteOutlined />,
        label: '直接删除（不保留）',
        onClick: () => confirmDestroy(entry),
      });
    }
    return items;
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
          {writableHere ? (
            <>
              {mkdirHere ? (
                <Button
                  icon={<FolderAddOutlined />}
                  onClick={() => {
                    setDialog({ mode: 'mkdir' });
                    setDialogName('');
                  }}
                >
                  新建文件夹
                </Button>
              ) : null}
              {/* 新建文件：手机上是刚需（不能先在本地建好再传） */}
              <Button
                icon={<FileAddOutlined />}
                onClick={() => {
                  setNewFileOpen(true);
                  setNewFileName('');
                  setNewFileBody('');
                }}
              >
                新建文件
              </Button>
              <Upload
                multiple
                showUploadList={false}
                customRequest={async ({ file, onSuccess, onError }) => {
                  try {
                    await uploadOne(file as File);
                    onSuccess?.({});
                  } catch (e) {
                    message.error(`上传失败：${fileErrorText((e as Error).message)}`);
                    onError?.(e as Error);
                  }
                }}
              >
                <Button type="primary" icon={<UploadOutlined />} loading={Boolean(uploading)}>
                  上传文件
                </Button>
              </Upload>
              {/* 文件夹上传：按 webkitRelativePath 还原目录结构（见 uploadTree） */}
              <Upload
                multiple
                directory
                showUploadList={false}
                customRequest={async ({ file, onSuccess, onError }) => {
                  // directory 模式下 antd 仍然逐文件回调；这里只做单文件兜底，
                  // 真正的树状上传由下方的 onBatch 统一处理。
                  onSuccess?.({});
                  void file;
                  void onError;
                }}
                beforeUpload={(file, fileList) => {
                  // 只在最后一个文件时触发一次批量处理，避免每文件重复建目录。
                  if (file === fileList[fileList.length - 1]) {
                    void uploadTree(fileList as File[]);
                  }
                  return Upload.LIST_IGNORE;
                }}
              >
                <Button icon={<FolderAddOutlined />} loading={Boolean(uploading)}>
                  上传文件夹
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
              {isSharedView ? (
                <Tag color="blue">
                  他人共享{sharedWith.some((s) => s.writable) ? ' · 部分可编辑' : ' · 只读'}
                </Tag>
              ) : null}
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
              <Tooltip
                title={
                  TIMELINE_FIRST_SOURCES.has(source)
                    ? '公共资料/基因组按“加入时间”浏览更顺手，已默认时间线视图'
                    : '个人文件按名称检索更快，已默认列表视图'
                }
              >
                <Segmented
                  size="small"
                  value={viewMode}
                  onChange={(v) => {
                    setViewMode(v as typeof viewMode);
                    setViewPinned(true);
                  }}
                  options={[
                    { value: 'list', icon: <UnorderedListOutlined />, title: '列表视图' },
                    { value: 'grid', icon: <AppstoreOutlined />, title: '网格视图' },
                    { value: 'details', icon: <ProfileOutlined />, title: '详情视图' },
                    { value: 'timeline', icon: <ClockCircleOutlined />, title: '时间线视图' },
                  ]}
                />
              </Tooltip>
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

      {/* 上传进度：批量/文件夹上传时给实时反馈，避免界面像卡死 */}
      {uploading ? (
        <Alert
          type="info"
          showIcon
          icon={<CloudUploadOutlined />}
          title={`正在上传 ${uploading.done} / ${uploading.total}`}
          description={
            <Flex vertical gap={6}>
              <Progress
                percent={uploading.total ? Math.round((uploading.done / uploading.total) * 100) : 0}
                size="small"
                status="active"
              />
              <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
                {uploading.current}
              </Typography.Text>
            </Flex>
          }
        />
      ) : null}

      {/* 失败明细：把"哪几个失败、为什么"摊开，而不是只弹一条 message */}
      {uploadErrors.length ? (
        <Alert
          type="warning"
          showIcon
          title={`有 ${uploadErrors.length} 个文件没有上传成功`}
          description={
            <Flex vertical gap={2} style={{ maxHeight: 140, overflowY: 'auto' }}>
              {uploadErrors.slice(0, 20).map((e, i) => (
                <Typography.Text key={`${e.name}-${i}`} style={{ fontSize: 12 }}>
                  <Typography.Text strong>{e.name}</Typography.Text>
                  <Typography.Text type="secondary"> — {e.reason}</Typography.Text>
                </Typography.Text>
              ))}
              {uploadErrors.length > 20 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  …另有 {uploadErrors.length - 20} 个
                </Typography.Text>
              ) : null}
            </Flex>
          }
          action={
            <Button size="small" onClick={() => setUploadErrors([])}>
              知道了
            </Button>
          }
        />
      ) : null}

      <Card
        size="small"
        onDragOver={(e) => {
          if (!writable) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          if (!writableHere) return;
          void handleDrop(e);
        }}
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
                  {writable && clipboard ? (
                    <Button type="primary" icon={<SnippetsOutlined />} loading={batchBusy} onClick={() => void pasteHere()}>
                      粘贴 {clipboard.ids.length} 项到此目录
                    </Button>
                  ) : null}
                  <Button icon={<DownloadOutlined />} onClick={batchDownload}>
                    批量下载
                  </Button>
                  {writable ? (
                    <Button icon={<CopyOutlined />} onClick={() => copyToClipboard(selectedEntries)}>
                      复制
                    </Button>
                  ) : null}
                  <Button
                    icon={<BookOutlined />}
                    onClick={ingestSelection}
                    disabled={!ingestibleSelection.length}
                  >
                    入库知识库
                  </Button>
                  {writable ? (
                    <>
                      {!isSharedView ? (
                        <Button
                          icon={<SwapOutlined />}
                          disabled={!removableSelection.length}
                          onClick={() => openMove(selectedEntries)}
                        >
                          移动
                        </Button>
                      ) : null}
                      <Button
                        danger
                        icon={<DeleteOutlined />}
                        loading={batchBusy}
                        disabled={!removableSelection.length}
                        onClick={batchRemove}
                      >
                        批量删除
                      </Button>
                    </>
                  ) : null}
                  <Button type="text" onClick={() => setSelectedKeys([])}>
                    取消选择
                  </Button>
                </Space>
              </Flex>
            ) : null}
            {viewMode === 'list' ? (
            <Table<FileRow>
              className="d509-files-table"
              size="middle"
              rowKey="id"
              dataSource={rows}
              sticky
              rowSelection={{
                selectedRowKeys: selectedKeys,
                onChange: (keys) => setSelectedKeys(keys),
                columnWidth: 44,
              }}
              scroll={{ x: 720 }}
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
                  // 次要信息合并进名称列：窄屏时不再靠横向滚动才能看到大小与时间，
                  // 宽屏仍保留独立列（lg/xl 断点显示）。
                  const meta: ReactNode[] = [];
                  if (!r.dir) meta.push(formatSize(r.size));
                  meta.push(formatTime(r.modified));
                  return (
                    <Flex vertical gap={2} style={{ minWidth: 0 }}>
                      <Space size={8} style={{ minWidth: 0 }}>
                        <FileThumb id={r.id} name={name} size={26} />
                        {r.dir ? (
                          <Typography.Link onClick={() => openEntry(r)} ellipsis style={{ fontWeight: 500 }}>
                            {name}
                          </Typography.Link>
                        ) : (
                          <Typography.Link onClick={() => openPreview(r.id)} ellipsis style={{ fontWeight: 500 }}>
                            {name}
                          </Typography.Link>
                        )}
                        {!r.dir ? <ExtTag name={name} /> : null}
                      </Space>
                      <Typography.Text
                        type="secondary"
                        ellipsis
                        style={{ fontSize: 12, paddingLeft: 24, lineHeight: 1.4 }}
                      >
                        {searching
                          ? `${r.path.split('/').slice(0, -1).join('/') || '根目录'} · ${meta.join(' · ')}`
                          : meta.join(' · ')}
                        {isSharedView ? (
                          <>
                            {' · '}
                            <TeamOutlined /> {resolveDisplayName(r.owner, peopleMap, r.path.split('/')[0])}
                          </>
                        ) : null}
                      </Typography.Text>
                      {isSharedView && sharedWritableOf(r.path) ? (
                        <Space size={4} style={{ paddingLeft: 24 }} wrap>
                          <Tag color="green" variant="filled" style={{ fontSize: 11, marginInlineEnd: 0 }}>
                            可编辑
                          </Tag>
                        </Space>
                      ) : null}
                      {isPersonal && !isSharedView && !searching && shareOf(r.path) ? (
                        <Space size={4} style={{ paddingLeft: 24 }} wrap>
                          <TeamOutlined style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)' }} />
                          {shareOf(r.path)!.recipients.map((n) => (
                            <Tag
                              key={n}
                              variant="filled"
                              title={n}
                              style={{ fontSize: 11, marginInlineEnd: 0 }}
                            >
                              {resolveDisplayName(n, peopleMap, n)}
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
                width: 104,
                align: 'right',
                responsive: ['lg'],
                sorter: true,
                sortOrder: sortKey === 'size' ? (order === 'asc' ? 'ascend' : 'descend') : null,
                // 目录自身字节数为 0，展示"—"，真实占用见用量标签
                render: (n: number, r) => (
                  <Typography.Text
                    type={r.dir && !r.dirSize ? 'secondary' : undefined}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                    title={r.dir ? '目录内所有文件的字节数之和' : undefined}
                  >
                    {r.dir ? (r.dirSize ? formatSize(r.dirSize) : '空') : formatSize(n)}
                  </Typography.Text>
                ),
              },
              {
                title: '修改时间',
                dataIndex: 'modified',
                width: 168,
                responsive: ['xl'],
                sorter: true,
                sortOrder: sortKey === 'modified' ? (order === 'asc' ? 'ascend' : 'descend') : null,
                render: (v: string) => (
                  <Typography.Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {formatTime(v)}
                  </Typography.Text>
                ),
              },
              {
                title: '创建时间',
                dataIndex: 'created',
                width: 168,
                responsive: ['xxl'],
                sorter: true,
                sortOrder: sortKey === 'created' ? (order === 'asc' ? 'ascend' : 'descend') : null,
                render: (v: string) => (
                  <Typography.Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {formatTime(v)}
                  </Typography.Text>
                ),
              },
              {
                title: '',
                key: 'actions',
                width: 148,
                align: 'right',
                render: (_: unknown, r) => (
                  <Space size={2}>
                    {r.dir ? (
                      <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => openEntry(r)}>
                        打开
                      </Button>
                    ) : (
                      <>
                        <Tooltip title="预览">
                          <Button
                            size="small"
                            type="text"
                            icon={<EyeOutlined />}
                            aria-label="预览"
                            onClick={() => openPreview(r.id)}
                          />
                        </Tooltip>
                        <Tooltip title="下载">
                          <Button
                            size="small"
                            type="text"
                            icon={<DownloadOutlined />}
                            aria-label="下载"
                            href={`/api/files/${encodeURIComponent(r.id)}/download`}
                          />
                        </Tooltip>
                        {hasPresentation(r.name) ? (
                          <Tooltip title="放映幻灯片">
                            <Button
                              size="small"
                              type="text"
                              icon={<PlayCircleOutlined />}
                              aria-label="放映幻灯片"
                              onClick={() => openOffice(r, 'present')}
                            />
                          </Tooltip>
                        ) : null}
                      </>
                    )}
                    {isPersonal && !isSharedView && r.path !== homePath ? (
                      <Tooltip title={shareOf(r.path) ? '共享设置' : '共享给…'}>
                        <Button
                          size="small"
                          type="text"
                          icon={<TeamOutlined />}
                          aria-label="共享"
                          onClick={() => openShare(r)}
                        />
                      </Tooltip>
                    ) : null}
                    <Dropdown trigger={['click']} menu={{ items: rowMenu(r) }}>
                      <Button size="small" type="text" icon={<EllipsisOutlined />} aria-label="更多操作" />
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
                            {isSharedView && sharedWritableOf(r.path) ? (
                              <Tag variant="filled" color="green">
                                可编辑
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
            ) : (
              <TimelineView
                entries={rows}
                groupBy={TIMELINE_FIRST_SOURCES.has(source) ? 'created' : 'modified'}
                emptyText={emptyDescription}
                onOpen={(entry) => openRow(entry)}
                renderActions={(entry) => (
                  <Dropdown trigger={['click']} menu={{ items: rowMenu(entry) }}>
                    <Button size="small" type="text" icon={<EllipsisOutlined />} aria-label="更多操作" />
                  </Dropdown>
                )}
              />
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
        open={moveIds.length > 0}
        title={`移动到文件夹（${moveIds.length} 项）`}
        okText="移动"
        cancelText="取消"
        confirmLoading={batchBusy}
        onOk={doMove}
        onCancel={() => setMoveIds([])}
        destroyOnHidden
      >
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">
            {isSharedView
              ? '目标目录仅列出可写共享目录与你的个人目录；目标处同名条目会被拒绝，不会覆盖。'
              : '目标目录仅列出你在当前存储源中有读权限的文件夹；目标处同名条目会被拒绝，不会覆盖。'}
          </Typography.Text>
          <Select
            showSearch
            open
            value={moveTo}
            onChange={(v) => setMoveTo(v)}
            style={{ width: '100%' }}
            placeholder="选择目标文件夹"
            optionFilterProp="label"
            options={moveTargets.map((d) => ({
              value: d,
              label: d ? d.split('/').join(' / ') : '（存储源根目录）',
            }))}
          />
        </Flex>
      </Modal>

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

      <TextEditorModal
        open={Boolean(textEditTarget)}
        entry={textEditTarget}
        onClose={() => setTextEditTarget(null)}
        onSaved={() => {
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

      {/* 新建文件：名字 + 初始内容。留空内容就是空文件，随后可用在线编辑器补。 */}
      <Modal
        open={newFileOpen}
        title="新建文件"
        okText="创建"
        cancelText="取消"
        confirmLoading={newFileBusy}
        onOk={submitNewFile}
        onCancel={() => setNewFileOpen(false)}
        destroyOnHidden
        width={560}
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Input
            autoFocus
            value={newFileName}
            maxLength={120}
            placeholder="文件名，例如 实验记录.md"
            onChange={(e) => setNewFileName(e.target.value)}
            onPressEnter={submitNewFile}
          />
          <Input.TextArea
            value={newFileBody}
            rows={8}
            placeholder="初始内容（可留空，之后用在线编辑器补）"
            onChange={(e) => setNewFileBody(e.target.value)}
            style={{ fontFamily: 'monospace' }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            创建位置：{baseDir || '当前目录'}
          </Typography.Text>
        </Space>
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
            被选择的同学会在「文件存储 → 个人文件 → 共享给我」中看到该路径，默认只读预览与下载；名单留空保存即收回共享。
          </Typography.Text>
          <Select
            mode="multiple"
            allowClear
            value={sharePicks}
            onChange={setSharePicks}
            placeholder={shareRecipients.length ? '选择共享人' : '暂无可共享的其他账号'}
            showSearch={{ optionFilterProp: 'label' }}
            // 共享名单一律显示**姓名**：value 仍是账号名（后端按账号名授权），
            // 但用户看到的必须是「陈同学」而不是「adminlegacy」。
            options={shareRecipients.map((name) => ({
              value: name,
              label: resolveDisplayName(name, peopleMap, name),
            }))}
            style={{ width: '100%' }}
          />
          <Flex align="center" justify="space-between" gap={12} wrap>
            <Typography.Text style={{ fontSize: 13 }}>允许对方编辑（移动/改名/上传，不含删除）</Typography.Text>
            <Switch
              checked={shareWritable}
              onChange={setShareWritable}
              disabled={!sharePicks.length}
              aria-label="允许对方编辑"
            />
          </Flex>
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
            title="个人文件默认仅本人可见；共享默认只读，勾选「允许对方编辑」后对方才能移动/改名/上传（不含删除），名单变更立即生效。"
            description="收回共享后，对方将无法继续预览或下载该路径，但已下载的副本无法追回。删除权始终属于本人。"
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
                      <Tag key={n} variant="filled" title={n}>
                        {resolveDisplayName(n, peopleMap, n)}
                      </Tag>
                    ))}
                  </Space>
                ),
              },
              {
                title: '权限',
                dataIndex: 'writable',
                width: 90,
                render: (writable: boolean) => (
                  <Tag color={writable ? 'green' : 'default'} variant="filled">
                    {writable ? '可编辑' : '只读'}
                  </Tag>
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
            title={`记录全站文件的预览与下载行为，保留 ${audit.data?.retentionDays ?? 7} 天，仅管理员可见。`}
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
