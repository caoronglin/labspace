import { Button, Dropdown, Flex, Space, Typography } from 'antd';
import type { MenuProps } from 'antd';
import {
  BookOutlined,
  CheckSquareOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  ExperimentOutlined,
  EyeOutlined,
  DownloadOutlined,
  GlobalOutlined,
  PlayCircleOutlined,
  StopOutlined,
  SwapOutlined,
  TeamOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { resolveDisplayName } from '../../utils/displayName';
import { api, type FileEntry, type FileTrashItem, type PersonalShare } from '../../services/api';
import { formatSize, isGenomeFile, isTextEditable } from '../../components/files/fileMeta';
import { hasPresentation, isOfficeEditable } from '../../components/office/registry';
import { fileErrorText, shortDate, type FileRow } from './presenters';
import type { FilesState } from './useFilesState';

/**
 * Files 页的操作闭包（从 pages/Files.tsx 原样搬出，函数体逐字未改）。
 * 原本是组件内 const 闭包，现在改为工厂函数：组件把 useFilesState() 的返回值
 * 整个传入，这里解构后原样执行，运行时行为与内联闭包完全一致。
 */
export function shareActions(state: FilesState) {
  const {
    homePath, personalShares, viewEntries, setSharePicks, setShareWritable,
    setShareTarget, shareTarget, sharePicks, shareWritable, setShareBusy,
    setManageOpen, message, modal, qc, peopleMap,
  } = state;

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

  return { relPath, shareOf, openShare, saveShare, editShare, revokeShare };
}

export function deleteActions(state: FilesState) {
  const {
    message, modal, previewId, setPreviewId, refreshAll,
    trash, trashItems, entries, isSharedView, retentionHint,
  } = state;

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

  return { removeEntry, destroyEntry, confirmDestroy, confirmRemove, restoreItem, purgeItem, emptyTrash };
}

export function selectionActions(state: FilesState) {
  const {
    message, qc, viewEntries, ingestibleSelection, selectedEntries, removableSelection,
    modal, retentionHint, setBatchBusy, setSelectedKeys, refreshAll, list, baseDir,
    canMoveEntry, isSharedView, moveTargets, homePath,
    moveIds, setMoveIds, setMoveTo, clipboard, setClipboard, moveTo, source,
  } = state;

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

  /**
   * 从文件/目录建一条工作台待办。
   *
   * link_source + link_path 存的是**路径**而不是文件 id：id 会随重新扫描
   * 变化，路径稳定。待办里就多一个「打开」入口，直接跳回这个位置。
   */
  const createTodoFromEntry = async (entry: FileEntry) => {
    try {
      await api.workbenchCreateItem({
        kind: 'task',
        title: entry.dir ? `处理目录「${entry.name}」` : `处理文件「${entry.name}」`,
        link_source: source,
        link_path: entry.path,
      });
      message.success('已加入工作台待办');
    } catch (e) {
      message.error(`加入待办失败：${fileErrorText((e as Error).message)}`);
    }
  };

  return {
    ingestToKnowledge, ingestSelection, batchDownload,
    openMove, copyToClipboard, pasteHere, doMove, batchRemove, createTodoFromEntry,
  };
}

export function rowMenus(deps: FilesState & ShareFns & DeleteFns & SelectionFns) {
  const {
    isPersonal, isSharedView, homePath, shareOf, openShare, revokeShare,
    ingestToKnowledge, createTodoFromEntry, source, navigate,
    canWrite, canMoveEntry, openMove, copyToClipboard,
    openOffice, openPreview, setTextEditTarget,
    setDialog, setDialogName, confirmRemove, confirmDestroy, openEntry,
  } = deps;

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
    // 工作台联动：把这份文件/目录挂成一条待办。
    // 这是"看文件时想起要做的事"的典型场景 —— 以前只能切到工作台
    // 手打一遍路径，或者干脆忘了。
    items.push({
      key: 'workbench-todo',
      icon: <CheckSquareOutlined />,
      label: entry.dir ? '把该目录加入待办' : '把该文件加入待办',
      onClick: () => createTodoFromEntry(entry),
    });
    // PDF 联动：直接把这份 PDF 带进门户自绘的 PDF 工具箱
    // （合并/拆分/压缩/加水印…），不用先下载到本地再传回去。
    if (!entry.dir && entry.name.toLowerCase().endsWith('.pdf')) {
      items.push({
        key: 'pdf-tools',
        icon: <ToolOutlined />,
        label: '用 PDF 工具箱处理',
        onClick: () => {
          const q = new URLSearchParams({
            source,
            id: entry.id,
            name: entry.name,
          });
          navigate(`/pdf?${q.toString()}`);
        },
      });
    }
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

  return { rowMenu, rowActions };
}

export type ShareFns = ReturnType<typeof shareActions>;
export type DeleteFns = ReturnType<typeof deleteActions>;
export type SelectionFns = ReturnType<typeof selectionActions>;
export type RowFns = ReturnType<typeof rowMenus>;
/** 渲染辅助函数（toolbar/views/modals）的统一依赖：状态 + 全部操作闭包。 */
export type FilesDeps = FilesState & ShareFns & DeleteFns & SelectionFns & RowFns;

