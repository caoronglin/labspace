/**
 * 文件上传逻辑（文件 / 批量 / 文件夹树 / 拖拽目录）。
 *
 * 为什么单独抽出来：
 * Files.tsx 里已经混了列表、共享、在线编辑、回收站、批量操作五块逻辑，
 * 再加上传流程就接近 2700 行，改一处得滚半天。上传本身是**自洽的一整套**：
 * 进度、失败清单、同名覆盖、目录树还原，与页面渲染无关，抽成 hook 后
 * 页面只负责显示 `uploading` / `uploadErrors`。
 *
 * 关键行为：
 * - 单文件：失败抛错，由调用方决定提示；
 * - 批量：不中断，收齐失败明细（`uploadErrors`）一次报给用户；
 * - 文件夹：先按 `webkitRelativePath` 逐层 mkdir，再逐文件上传，
 *   服务端得到与本地一致的目录树，而不是几百个平铺文件；
 * - 拖拽：用 `webkitGetAsEntry()` 递归展开目录（`dataTransfer.files`
 *   会把文件夹当成 size=0 的不可读项，静默丢掉）。
 */
import { useCallback, useState, type DragEvent } from 'react';
import { App } from 'antd';
import { api } from '../services/api';
import { fileErrorText } from '../utils/fileError';

export interface UploadTarget {
  source: string;
  /** 目标目录（源内相对路径）。 */
  dir: string;
}

export interface UploadError {
  name: string;
  reason: string;
}

export interface UploadProgress {
  done: number;
  total: number;
  current: string;
}

interface Options {
  /** 取当前上传落点（依赖页面状态，所以用函数而不是值）。 */
  target: () => UploadTarget;
  /** 上传完成后刷新列表。 */
  onUploaded: () => void | Promise<void>;
  /** 同名文件是否覆盖：由页面弹确认框决定。 */
  confirmOverwrite?: (name: string) => Promise<boolean>;
}

export function useFileUpload({ target, onUploaded, confirmOverwrite }: Options) {
  const { message } = App.useApp();
  const [uploading, setUploading] = useState<UploadProgress | null>(null);
  const [uploadErrors, setUploadErrors] = useState<UploadError[]>([]);

  /** 单文件上传（含同名覆盖确认）。失败向上抛，由调用方决定怎么提示。 */
  const uploadOne = useCallback(
    async (file: File, targetDir?: string) => {
      const { source, dir } = target();
      const dest = targetDir ?? dir;
      try {
        await api.fileUpload(source, dest, file);
        return;
      } catch (e) {
        if (!(e as Error).message.includes('already exists')) throw e;
        const ok = confirmOverwrite ? await confirmOverwrite(file.name) : false;
        if (!ok) return;
      }
      await api.fileUpload(source, dest, file, true);
    },
    [target, confirmOverwrite],
  );

  /**
   * 批量上传：不因单个失败中断，最后汇总失败明细。
   * `relativeDirs[i]` 是第 i 个文件的目标子目录（文件夹上传时用）。
   */
  const uploadMany = useCallback(
    async (files: File[], relativeDirs?: string[]) => {
      if (!files.length) return;
      const errors: UploadError[] = [];
      setUploadErrors([]);
      let done = 0;
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const label = relativeDirs?.[i]
          ? `${relativeDirs[i]}/${file.name}`
          : file.name;
        setUploading({ done, total: files.length, current: label });
        try {
          await uploadOne(file, relativeDirs?.[i]);
          done += 1;
        } catch (e) {
          errors.push({ name: label, reason: fileErrorText((e as Error).message) });
        }
        setUploading({ done, total: files.length, current: label });
      }
      setUploading(null);
      if (errors.length) {
        setUploadErrors(errors);
        message.warning(
          `${files.length - errors.length} 个成功，${errors.length} 个失败（见下方明细）`,
        );
      } else if (files.length > 1) {
        message.success(`已上传 ${files.length} 个文件`);
      }
      await onUploaded();
    },
    [uploadOne, message, onUploaded],
  );

  /**
   * 文件夹上传：先逐层建目录，再逐文件上传到对应子目录。
   * 目录创建失败时（除"已存在"）直接中止，避免上传到一半结构不完整。
   */
  const uploadTree = useCallback(
    async (files: File[]) => {
      const { source, dir } = target();
      const dirs = new Set<string>();
      const relDirs: string[] = [];
      for (const f of files) {
        const parts = (f.webkitRelativePath || '').split('/').slice(0, -1);
        let acc = dir;
        for (const part of parts) {
          acc = acc ? `${acc}/${part}` : part;
          dirs.add(acc);
        }
        relDirs.push(acc);
      }
      // 浅层优先：父目录必须先存在，否则子目录 mkdir 会失败。
      const sorted = [...dirs].sort(
        (a, b) => a.split('/').length - b.split('/').length,
      );
      for (const d of sorted) {
        try {
          await api.fileMkdir(source, d);
        } catch (e) {
          if (!/exist/i.test((e as Error).message || '')) {
            message.error(`创建目录 ${d} 失败：${fileErrorText((e as Error).message)}`);
            return;
          }
        }
      }
      await uploadMany(files, relDirs);
    },
    [target, uploadMany, message],
  );

  /**
   * 拖拽处理：支持文件夹。
   *
   * `dataTransfer.files` 对文件夹只会给一个 size=0 的条目，直接当文件传
   * 会得到空文件；必须用 `webkitGetAsEntry()` 递归展开。
   */
  const handleDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const items = Array.from(e.dataTransfer.items ?? []);
      const entries = items
        .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
        .filter((x): x is FileSystemEntry => Boolean(x));

      if (!entries.length) {
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length) await uploadMany(files);
        return;
      }

      const collected: File[] = [];
      const walk = async (entry: FileSystemEntry): Promise<void> => {
        if (entry.isFile) {
          const file = await new Promise<File | null>((resolve) => {
            (entry as FileSystemFileEntry).file(
              (f) => resolve(f),
              () => resolve(null),
            );
          });
          if (!file) return;
          // 保留相对路径，交给 uploadTree 还原目录结构。
          Object.defineProperty(file, 'webkitRelativePath', {
            value: entry.fullPath.replace(/^\//, ''),
            configurable: true,
          });
          collected.push(file);
          return;
        }
        if (!entry.isDirectory) return;
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        // readEntries 一次最多 100 项，必须循环读到空。
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((resolve) => {
            reader.readEntries(
              (list) => resolve(list),
              () => resolve([]),
            );
          });
          if (!batch.length) return;
          for (const child of batch) await walk(child);
        }
      };
      for (const entry of entries) await walk(entry);

      if (!collected.length) {
        message.info('拖入的内容里没有可上传的文件');
        return;
      }
      const hasDirs = collected.some((f) =>
        (f.webkitRelativePath || '').includes('/'),
      );
      await (hasDirs ? uploadTree(collected) : uploadMany(collected));
    },
    [uploadMany, uploadTree, message],
  );

  return {
    uploading,
    uploadErrors,
    setUploadErrors,
    uploadOne,
    uploadMany,
    uploadTree,
    handleDrop,
  };
}
