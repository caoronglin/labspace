import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Alert, Button, Flex, Input, Spin, Tag, Tooltip, Typography } from 'antd';
import {
  CloseOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  LeftOutlined,
  RightOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { api, type OfficeSlide } from '../../services/api';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

type Props = {
  entryId: string;
  name: string;
  open: boolean;
  slides?: OfficeSlide[];
  onClose: () => void;
};

/** PPT/PPTX 放映：服务端转 PDF 后由 PDF.js 全屏渲染，尽量还原真实版式。 */
export default function PptPresentation({ entryId, name, open, slides, onClose }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [textSlides, setTextSlides] = useState<OfficeSlide[]>([]);
  const [thumbs, setThumbs] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const slidesRef = useRef(slides);
  slidesRef.current = slides;

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadingTaskRef.current?.destroy().catch(() => undefined);
    loadingTaskRef.current = null;
    setPdf(null);
    setLoading(true);
    setError('');
    setPage(1);
    setNumPages(0);
    let task: PDFDocumentLoadingTask | null = null;
    api
      .officePdf(entryId)
      .then((blob) => blob.arrayBuffer())
      .then((buffer) => {
        if (cancelled) return null;
        task = pdfjs.getDocument({
          data: new Uint8Array(buffer),
          cMapUrl: '/pdfjs/cmaps/',
          standardFontDataUrl: '/pdfjs/standard_fonts/',
          wasmUrl: '/pdfjs/wasm/',
        });
        loadingTaskRef.current = task;
        return task.promise;
      })
      .then((doc) => {
        if (!doc) return;
        if (cancelled) {
          task?.destroy().catch(() => undefined);
          return;
        }
        setPdf(doc);
        setNumPages(doc.numPages);
      })
      .catch(async (err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        const cached = slidesRef.current ?? [];
        setTextSlides(cached);
        if (!cached.length) {
          try {
            const content = await api.officeContent(entryId);
            if (!cancelled) setTextSlides(content.slides ?? []);
          } catch {
            /* 文本回退也失败时只保留错误提示 */
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      loadingTaskRef.current?.destroy().catch(() => undefined);
      loadingTaskRef.current = null;
    };
  }, [open, entryId]);

  useEffect(() => {
    if (open) return;
    loadingTaskRef.current?.destroy().catch(() => undefined);
    loadingTaskRef.current = null;
    setPdf(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, thumbs]);

  useEffect(() => {
    if (!pdf || !stage.w || !stage.h) return;
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    (async () => {
      const p = await pdf.getPage(page);
      if (cancelled || !canvasRef.current) return;
      const base = p.getViewport({ scale: 1 });
      const fit = Math.min((stage.w - 40) / base.width, (stage.h - 28) / base.height);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = p.getViewport({ scale: Math.max(0.1, fit) * dpr });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
      renderTaskRef.current?.cancel();
      const task = p.render({ canvas, viewport });
      renderTaskRef.current = task;
      try {
        await task.promise;
      } catch (err: unknown) {
        if (!cancelled && (err as { name?: string })?.name !== 'RenderingCancelledException') {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [pdf, page, stage]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        setPage((n) => Math.min(numPages || 1, n + 1));
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        setPage((n) => Math.max(1, n - 1));
      } else if (e.key === 'Home') {
        setPage(1);
      } else if (e.key === 'End') {
        setPage(numPages || 1);
      } else if (e.key === 'Escape') {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => undefined);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, numPages, onClose]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  if (!open) return null;

  const total = numPages || textSlides.length || 1;
  const textSlide = textSlides[page - 1];

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (overlayRef.current) {
        await overlayRef.current.requestFullscreen();
      }
    } catch {
      /* 浏览器拒绝全屏时保持页面内全屏 */
    }
  };

  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${name} 放映`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1300,
        background: '#0b0e14',
        color: '#e5e7eb',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Flex
        align="center"
        justify="space-between"
        gap={12}
        style={{ padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}
      >
        <Flex align="center" gap={10} style={{ minWidth: 0 }}>
          <Tag color="blue" variant="filled">
            放映
          </Tag>
          <Typography.Text ellipsis style={{ color: '#e5e7eb', maxWidth: '42vw' }}>
            {name}
          </Typography.Text>
          <Typography.Text style={{ color: '#94a3b8', fontSize: 12 }}>
            {page} / {total}
          </Typography.Text>
        </Flex>
        <Flex align="center" gap={4}>
          <Tooltip title="缩略图">
            <Button
              type="text"
              icon={<UnorderedListOutlined />}
              onClick={() => setThumbs((v) => !v)}
              style={{ color: thumbs ? '#60a5fa' : '#e5e7eb' }}
            />
          </Tooltip>
          <Tooltip title={fullscreen ? '退出全屏' : '全屏'}>
            <Button
              type="text"
              icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              onClick={toggleFullscreen}
              style={{ color: '#e5e7eb' }}
            />
          </Tooltip>
          <Tooltip title="关闭（Esc）">
            <Button type="text" icon={<CloseOutlined />} onClick={onClose} style={{ color: '#e5e7eb' }} />
          </Tooltip>
        </Flex>
      </Flex>

      <Flex style={{ flex: 1, minHeight: 0 }}>
        {thumbs ? (
          <div
            style={{
              width: 210,
              overflowY: 'auto',
              borderRight: '1px solid rgba(255,255,255,0.1)',
              padding: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              flexShrink: 0,
            }}
          >
            {Array.from({ length: total }, (_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPage(i + 1)}
                style={{
                  textAlign: 'left',
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: `1px solid ${page === i + 1 ? '#60a5fa' : 'rgba(255,255,255,0.12)'}`,
                  background: page === i + 1 ? 'rgba(96,165,250,0.16)' : 'rgba(255,255,255,0.03)',
                  color: '#e5e7eb',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                {i + 1}
                {textSlides[i]
                  ? ` · ${(textSlides[i].shapes.find((s) => s.title)?.text || textSlides[i].shapes[0]?.text || '')
                      .replace(/\s+/g, ' ')
                      .slice(0, 12)}`
                  : ''}
              </button>
            ))}
          </div>
        ) : null}

        <div ref={stageRef} style={{ flex: 1, minWidth: 0, display: 'grid', placeItems: 'center', padding: 16 }}>
          {loading ? (
            <Flex vertical align="center" gap={12}>
              <Spin size="large" />
              <Typography.Text style={{ color: '#94a3b8' }}>正在生成放映稿…</Typography.Text>
            </Flex>
          ) : pdf ? (
            <canvas ref={canvasRef} style={{ maxWidth: '100%', maxHeight: '100%', boxShadow: '0 10px 40px rgba(0,0,0,0.5)' }} />
          ) : textSlide ? (
            <div
              style={{
                width: 'min(960px, 92%)',
                aspectRatio: '16 / 9',
                background: '#fff',
                color: '#111827',
                borderRadius: 10,
                padding: '7% 8%',
                overflow: 'auto',
                boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
              }}
            >
              {textSlide.shapes.map((shape) => (
                <div
                  key={shape.id}
                  style={{
                    fontSize: shape.title ? 30 : 18,
                    fontWeight: shape.title ? 700 : 400,
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    marginBottom: 12,
                  }}
                >
                  {shape.text}
                </div>
              ))}
              {textSlide.notes ? (
                <Typography.Paragraph style={{ marginTop: 24, color: '#64748b', fontSize: 13 }}>
                  备注：{textSlide.notes}
                </Typography.Paragraph>
              ) : null}
            </div>
          ) : (
            <Alert
              type="error"
              showIcon
              title="无法生成放映稿"
              description={`${error || '服务端转换失败'}。可以关闭放映后下载原文件，用本地 PowerPoint / WPS 打开。`}
            />
          )}
        </div>
      </Flex>

      <Flex
        align="center"
        justify="center"
        gap={12}
        style={{ padding: '10px 16px', borderTop: '1px solid rgba(255,255,255,0.1)' }}
      >
        <Button
          icon={<LeftOutlined />}
          onClick={() => setPage((n) => Math.max(1, n - 1))}
          disabled={page <= 1}
        >
          上一页
        </Button>
        <Input
          value={page}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/\D/g, ''));
            if (n >= 1 && n <= total) setPage(n);
          }}
          style={{ width: 64, textAlign: 'center' }}
          aria-label="页码"
        />
        <Typography.Text style={{ color: '#94a3b8', fontSize: 12 }}>/ {total}</Typography.Text>
        <Button
          icon={<RightOutlined />}
          iconPlacement="end"
          onClick={() => setPage((n) => Math.min(total, n + 1))}
          disabled={page >= total}
        >
          下一页
        </Button>
      </Flex>
      {error && pdf ? (
        <div style={{ padding: '0 16px 10px' }}>
          <Alert type="warning" showIcon title="放映稿渲染出现提示" description={error} />
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
