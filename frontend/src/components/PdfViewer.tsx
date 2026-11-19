/**
 * 门户原生的 PDF 阅读器（与「文件存储」里的预览同一套内核）。
 *
 * 为什么不用 <iframe src="...pdf">：iframe 依赖浏览器内置阅读器，
 * 翻页/缩放/文字层都不可控，且在外面套「整屏」时高度计算会互相打架。
 * 这里用 @open-file-viewer 的 pdf 插件，工具栏与缩放由组件自己管。
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { Alert, Flex, Spin, Typography } from 'antd';

import { loadViewerCore } from './preview/viewerCore';

const FileViewer = lazy(() =>
  import('@open-file-viewer/react').then((m) => ({ default: m.FileViewer })),
);

interface Props {
  /** PDF 地址（同源，带 cookie）。 */
  src: string;
  /** 展示用文件名，影响下载标题。 */
  name: string;
  /** 容器高度；传 '100%' 时由父容器决定。 */
  height?: number | string;
}

export default function PdfViewer({ src, name, height = 720 }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [plugins, setPlugins] = useState<Awaited<ReturnType<typeof loadViewerCore>>['plugins']>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError('');
    (async () => {
      const [{ core, plugins: loaded }, res] = await Promise.all([
        loadViewerCore(),
        fetch(src, { credentials: 'same-origin' }),
      ]);
      if (!res.ok) throw new Error(`PDF 加载失败（HTTP ${res.status}）`);
      const blob = await res.blob();
      if (cancelled) return;
      const fileObj = new File([blob], name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`, {
        type: 'application/pdf',
      });
      const supported = await core.isPreviewSupported(fileObj, loaded, {
        fileName: fileObj.name,
        mimeType: 'application/pdf',
      });
      if (cancelled) return;
      if (!supported) {
        // 走到这里说明 pdf 插件没被加载成功，宁可明说也不静默降级成 iframe
        throw new Error('PDF 渲染内核未就绪');
      }
      setPlugins(loaded);
      setFile(fileObj);
    })().catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [src, name]);

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        title="PDF 预览失败"
        description={`${error}。可点「下载」用本地阅读器打开。`}
      />
    );
  }

  if (!file) {
    return (
      <Flex align="center" justify="center" vertical gap={10} style={{ height, minHeight: 320 }}>
        <Spin />
        <Typography.Text type="secondary">正在加载 PDF…</Typography.Text>
      </Flex>
    );
  }

  return (
    <div style={{ height, minHeight: 320 }}>
      <Suspense
        fallback={
          <Flex align="center" justify="center" style={{ height: '100%' }}>
            <Spin />
          </Flex>
        }
      >
        <FileViewer
          file={file}
          fileName={name}
          height="100%"
          width="100%"
          theme="light"
          locale="zh-CN"
          toolbar
          plugins={plugins}
        />
      </Suspense>
    </div>
  );
}
