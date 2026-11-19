/**
 * 统一加载 @open-file-viewer 的 core 与插件集。
 *
 * 抽出来是因为「LaTeX 写作」的 PDF 预览也要用它：不能因为来源是
 * /api/latex/{id}/pdf 而不是 /api/files/{id}/download 就退回去用 <iframe>，
 * 那会丢掉翻页/缩放/文字层，和门户其它预览体验不一致。
 */
import type { PreviewPlugin } from '@open-file-viewer/core';
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';
import legacyWorkerSrc from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import '@open-file-viewer/core/style.css';

export type ViewerCore = typeof import('@open-file-viewer/core');

let viewerCorePromise: Promise<{ core: ViewerCore; plugins: PreviewPlugin[] }> | null = null;

export function loadViewerCore() {
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
    ],
  }));
  return viewerCorePromise;
}
