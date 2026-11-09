import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Alert, Flex, Spin, Typography } from 'antd';
import type { PreviewPlugin } from '@open-file-viewer/core';
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';
import legacyWorkerSrc from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import '@open-file-viewer/core/style.css';

const FileViewer = lazy(() =>
  import('@open-file-viewer/react').then((m) => ({ default: m.FileViewer })),
);

type ViewerCore = typeof import('@open-file-viewer/core');

let viewerCorePromise: Promise<{ core: ViewerCore; plugins: PreviewPlugin[] }> | null = null;

function loadViewerCore() {
  viewerCorePromise ??= import('@open-file-viewer/core').then((core) => ({
    core,
    plugins: [
      core.imagePlugin(),
      core.pdfPlugin({
        workerSrc,
        legacyWorkerSrc,
        cMapUrl: '/pdfjs/cmaps/',
        standardFontDataUrl: '/pdfjs/standard_fonts/',
        wasmUrl: '/pdfjs/wasm/',
        useFetchData: true,
        webFallbackScripts: 'never',
      }),
      core.officePlugin(),
      core.textPlugin(),
      core.epubPlugin(),
      core.xpsPlugin(),
      core.ofdPlugin(),
      core.archivePlugin(),
      core.emailPlugin(),
      core.drawingPlugin(),
      core.xmindPlugin(),
      core.gisPlugin(),
      core.model3dPlugin(),
      core.videoPlugin(),
      core.audioPlugin(),
      core.assetPlugin(),
      core.cadPlugin({ libreDwg: false }),
    ],
  }));
  return viewerCorePromise;
}

type ViewerState =
  | { phase: 'loading' }
  | { phase: 'ready'; file: File; plugins: PreviewPlugin[] }
  | { phase: 'error'; message: string };

type Props = {
  id: string;
  name: string;
  onUnsupported: () => void;
};

/** 使用 Open File Viewer（React 原生适配）渲染文件；不支持的格式交回原生预览 */
export default function OpenFilePreview({ id, name, onUnsupported }: Props) {
  const [state, setState] = useState<ViewerState>({ phase: 'loading' });
  const [renderError, setRenderError] = useState('');
  const unsupportedRef = useRef(onUnsupported);
  unsupportedRef.current = onUnsupported;

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    setRenderError('');

    (async () => {
      const [{ core, plugins }, res] = await Promise.all([
        loadViewerCore(),
        fetch(`/api/files/${encodeURIComponent(id)}/download`, { credentials: 'same-origin' }),
      ]);
      if (!res.ok) throw new Error(`文件下载失败（HTTP ${res.status}）`);
      const blob = await res.blob();
      if (cancelled) return;
      const type = blob.type && blob.type !== 'application/octet-stream' ? blob.type : '';
      const file = new File([blob], name, { type });
      const supported = await core.isPreviewSupported(file, plugins, {
        fileName: name,
        mimeType: type || undefined,
      });
      if (cancelled) return;
      if (!supported) {
        unsupportedRef.current();
        return;
      }
      setState({ phase: 'ready', file, plugins });
    })().catch((err: unknown) => {
      if (cancelled) return;
      setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    });

    return () => {
      cancelled = true;
    };
  }, [id, name]);

  if (state.phase === 'loading') {
    return (
      <Flex align="center" justify="center" vertical gap={12} style={{ minHeight: 360 }}>
        <Spin size="large" />
        <Typography.Text type="secondary">正在加载文件预览…</Typography.Text>
      </Flex>
    );
  }

  if (state.phase === 'error') {
    return (
      <Alert
        type="error"
        showIcon
        title="文件预览加载失败"
        description={`${state.message}。可以下载原文件后使用本地软件查看。`}
      />
    );
  }

  return (
    <Flex vertical gap={8}>
      <div style={{ height: 'min(66vh, 640px)', minHeight: 380 }}>
        <Suspense
          fallback={
            <Flex align="center" justify="center" style={{ height: '100%' }}>
              <Spin size="large" />
            </Flex>
          }
        >
          <FileViewer
            file={state.file}
            fileName={name}
            height="100%"
            width="100%"
            theme="light"
            locale="zh-CN"
            toolbar
            plugins={state.plugins}
            onError={(err: Error) => setRenderError(err.message)}
          />
        </Suspense>
      </div>
      {renderError && (
        <Alert
          type="warning"
          showIcon
          title="渲染过程中出现问题"
          description={`${renderError}。可以下载原文件后使用本地软件查看。`}
          closable={{ onClose: () => setRenderError('') }}
        />
      )}
    </Flex>
  );
}
