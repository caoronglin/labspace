import { useEffect, useMemo, useState, type Key, type ReactNode } from 'react';
import { App, Empty, Space } from 'antd';
import { FolderOpenOutlined, TeamOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { usePeopleMap } from '../../utils/displayName';
import { api, type FileEntry, type FileSortKey } from '../../services/api';
import { useAuth } from '../../app/AuthContext';
import { useFileUpload } from '../../hooks/useFileUpload';
import { fileErrorText, preferNativePreview, recommendedView, SORT_KEYS, type FileRow } from './presenters';

/**
 * Files 页的状态与派生值（从 pages/Files.tsx 原样搬出，行为不变）。
 * 全部 hooks 收敛在这个自定义 hook 里，页面组件只负责组合渲染；
 * 操作闭包（共享/删除/入库/移动）在 ./actions 中从本 hook 的返回值取状态。
 */
export function useFilesState() {
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
   * 只展示**真正能打开**的分类。
   *
   * 后端会把六个来源全报回来（哪怕调用者一条权限也没有），之前的做法是
   * 把没权限的置灰 —— 界面上就成了一排点不动的页签（学生看到「课题资料」
   * 「组会汇报」却永远打不开）。权限口径是「老师看到全部，其他人只看到
   * 自己那份」，所以无权的分类直接不渲染，而不是画一个死按钮。
   */
  const listableSources = useMemo(
    () => (sources.data?.sources ?? []).filter((s) => s.listable),
    [sources.data],
  );
  // 当前来源被收回权限（或从旧链接进来）时，回退到第一个可打开的分类，
  // 否则页面会停在空列表上，用户以为“文件没了”。
  useEffect(() => {
    if (!sources.data) return;
    if (listableSources.some((s) => s.id === source)) return;
    const fallback = listableSources[0];
    if (!fallback) return;
    setSource(fallback.id);
    setDir('');
  }, [sources.data, listableSources, source]);
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
  // 写权限统一看服务端返回的 writePaths（源级清单）：自己的家目录、导师给的
  // 「只能上传」的组员目录、老师对整棵共享树的写权，都在这份清单里，
  // 前端不再按「是不是共享视图」分两套判断 —— 那样学生一进「共享给我」
  // 上传按钮就消失了（服务端其实允许上传）。
  const writable = canWrite(baseDir);
  const writableHere = writable;
  // 建目录与传文件分开：共享树里的学生只能上传，不能改结构。
  const mkdirHere = canMkdir(baseDir);

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

  const openEntry = (entry: FileEntry) => {
    if (entry.dir) {
      setDir(entry.path);
      if (searching) setQ('');
      return;
    }
    setPreviewId(entry.id);
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

  const openRow = (r: FileRow) => (r.dir ? openEntry(r) : openPreview(r.id));

  return {
    message, modal, qc, navigate, isAdmin,
    source, setSource, dir, setDir, q, setQ, personalScope, setPersonalScope,
    sortKey, setSortKey, order, setOrder,
    viewMode, setViewMode, setViewPinned,
    sources, listableSources, list, entries, viewEntries,
    trash, trashItems, audit, retentionHint,
    previewEntry, bioDirect, preview, previewId, setPreviewId, nativePreview, setNativePreview,
    activeSource, sourceWritable, peopleMap,
    isPersonal, isSharedView,
    homePath, sharedWith, personalShares, shareRecipients, sharedRoots, sharedWritableOf,
    canWrite, canMoveEntry,
    baseDir, writable, writableHere, mkdirHere,
    uploading, uploadErrors, setUploadErrors, uploadOne, uploadTree, handleDrop,
    searching,
    rows, selectedEntries, selectedBytes, removableSelection, ingestibleSelection, toggleSelect,
    stats, breadcrumb,
    refresh, submitNewFile, submitDialog, refreshAll,
    moveTargets, moveIds, setMoveIds, clipboard, setClipboard, moveTo, setMoveTo,
    parentDir, canGoUp, openEntry, openPreview, openOffice, emptyDescription, emptyView, openRow,
    officeTarget, setOfficeTarget, textEditTarget, setTextEditTarget,
    dialog, setDialog, dialogName, setDialogName, busy,
    newFileOpen, setNewFileOpen, newFileName, setNewFileName, newFileBody, setNewFileBody,
    newFileBusy, setNewFileBusy,
    dragging, setDragging,
    trashOpen, setTrashOpen, auditOpen, setAuditOpen, auditAction, setAuditAction,
    shareTarget, setShareTarget, sharePicks, setSharePicks,
    shareWritable, setShareWritable, shareBusy, setShareBusy,
    manageOpen, setManageOpen,
    selectedKeys, setSelectedKeys, batchBusy, setBatchBusy,
  };
}
export type FilesState = ReturnType<typeof useFilesState>;

