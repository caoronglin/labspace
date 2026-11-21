import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  App,
  Button,
  Drawer,
  Empty,
  Flex,
  Image,
  Input,
  Listy,
  Modal,
  Popconfirm,
  Select,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  ExportOutlined,
  FileAddOutlined,
  FolderOpenOutlined,
  FullscreenOutlined,
  PictureOutlined,
  SaveOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { hostUrl } from '../utils/host';
import { useThemeMode } from '../theme/ThemeContext';
import { api } from '../services/api';
import { errText } from '../utils/err';
import { formatDateTime, formatSize } from '../utils/format';
import PageShell from '../components/PageShell';
import { palette } from '../theme/palette';

const EMPTY_TEMPLATE = (name: string) =>
  `<mxfile host="labspace"><diagram name="${name}"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>`;

const TEMPLATES = [
  { key: 'rnaseq', label: 'RNA-seq Pipeline', steps: ['原始测序数据', 'FastQC 质控', 'HISAT2 比对', 'featureCounts 定量', 'DESeq2 差异分析'] },
  { key: 'bsaseq', label: 'BSA-seq Pipeline', steps: ['亲本重测序', '混池构建', '参考基因组比对', 'SNP / InDel 检测', '关联区间定位'] },
  { key: 'wgs', label: 'WGS Pipeline', steps: ['样本采集', '文库构建', '高通量测序', 'BWA 比对', '变异检测', 'VEP 注释'] },
  { key: 'qc', label: '数据质控流程', steps: ['原始数据', '去接头', '质量过滤', '污染检测', '合格数据'] },
  { key: 'design', label: '实验设计流程', steps: ['实验设计', '样本分组', '表型采集', '测序 / 表型', '统计分析'] },
];

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch] as string));
}

function templateXml(name: string, steps: string[]): string {
  const cells = steps.map((label, i) => {
    const first = i === 0;
    const last = i === steps.length - 1;
    const fill = first ? palette.tint.green50 : last ? palette.tint.orange100 : palette.tint.blue50;
    const stroke = first ? palette.brand.green700 : last ? palette.brand.orange800 : palette.brand.blue500;
    return `<mxCell id="n${i + 1}" value="${escapeXml(label)}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};fontSize=13;" vertex="1" parent="1"><mxGeometry x="${40 + i * 210}" y="90" width="160" height="64" as="geometry"/></mxCell>`;
  }).join('');
  const edges = steps.slice(1).map((_, i) =>
    `<mxCell id="e${i + 1}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;strokeColor=${palette.neutral.n450};" edge="1" parent="1" source="n${i + 1}" target="n${i + 2}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
  ).join('');
  return `<mxfile host="labspace"><diagram name="${escapeXml(name)}"><mxGraphModel dx="1200" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1400" pageHeight="300" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}${edges}</root></mxGraphModel></diagram></mxfile>`;
}

interface ExportReply {
  format?: string;
  data?: string;
  xml?: string;
}

function decodeXml(reply: ExportReply): string {
  if (typeof reply.xml === 'string' && reply.xml.includes('<')) return reply.xml;
  const data = reply.data ?? '';
  const marker = data.indexOf(',');
  if (data.startsWith('data:') && marker > 0) {
    const meta = data.slice(0, marker);
    const body = data.slice(marker + 1);
    try {
      return meta.includes('base64') ? atob(body) : decodeURIComponent(body);
    } catch {
      return '';
    }
  }
  return '';
}

/** 嵌入式 draw.io 画布：保存、预览与导出都走浏览器内的 embed 协议，不依赖公网服务。 */
export default function Drawio() {
  const { message } = App.useApp();
  const { resolved } = useThemeMode();
  const qc = useQueryClient();
  const [name, setName] = useState('未命名流程图');
  const [drawingId, setDrawingId] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [ready, setReady] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [searchParams] = useSearchParams();
  const initialDrawing = useRef(searchParams.get('drawing'));
  // 旧「我的图形」页已并入本页：/drawings 重定向到 ?panel=drawings，旧收藏直接开面板
  const [listOpen, setListOpen] = useState(searchParams.get('panel') === 'drawings');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const frameRef = useRef<HTMLIFrameElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const xmlRef = useRef(EMPTY_TEMPLATE('未命名流程图'));
  const nameRef = useRef(name);
  const pendingXml = useRef<string | null>(null);
  const exportWaiter = useRef<((reply: ExportReply) => void) | null>(null);

  nameRef.current = name;

  const src = useMemo(
    () =>
      hostUrl(
        `/?embed=1&proto=json&spin=1&lang=zh&ui=min&noSaveBtn=1&modified=unsavedChanges${resolved === 'dark' ? '&dark=1' : ''}`,
        8082,
      ),
    [resolved],
  );
  const frameOrigin = useMemo(() => {
    try {
      return new URL(src).origin;
    } catch {
      return '';
    }
  }, [src]);

  const { data: drawings, isFetching } = useQuery({ queryKey: ['drawings'], queryFn: api.drawings });
  const drawingList = drawings?.drawings ?? [];

  const post = useCallback((payload: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(JSON.stringify(payload), frameOrigin || '*');
  }, [frameOrigin]);

  const loadXml = useCallback((xml: string, title: string) => {
    xmlRef.current = xml;
    setDirty(false);
    if (ready) post({ action: 'load', xml, title, autosave: 1 });
    else pendingXml.current = xml;
  }, [post, ready]);

  const requestExport = useCallback(
    async (format: 'xml' | 'png' | 'svg'): Promise<ExportReply> => {
      if (!ready) throw new Error('画布尚未就绪');
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          exportWaiter.current = null;
          reject(new Error('画布响应超时'));
        }, 12000);
        exportWaiter.current = (reply) => {
          window.clearTimeout(timer);
          resolve(reply);
        };
        post({ action: 'export', format, spinKey: 'portal-export' });
      });
    },
    [post, ready],
  );

  const save = useMutation({
    mutationFn: async (xml: string) => {
      if (drawingId) {
        await api.updateDrawing(drawingId, name, xml);
        return { id: drawingId };
      }
      const res = await api.saveDrawing(name, xml);
      setDrawingId(res.id);
      return res;
    },
    onSuccess: () => {
      setDirty(false);
      message.success('已保存到我的图形');
      void qc.invalidateQueries({ queryKey: ['drawings'] });
    },
    onError: (e: Error) => message.error(`保存失败：${errText(e)}`),
  });

  const ensureXml = useCallback(async () => {
    if (xmlRef.current && !dirty) return xmlRef.current;
    const reply = await requestExport('xml');
    const xml = decodeXml(reply) || xmlRef.current;
    if (!xml) throw new Error('无法读取画布内容');
    xmlRef.current = xml;
    return xml;
  }, [dirty, requestExport]);

  const handleSave = async () => {
    try {
      const xml = await ensureXml();
      save.mutate(xml);
    } catch (e) {
      message.error(`保存失败：${errText(e)}`);
    }
  };

  const exportToFiles = useMutation({
    mutationFn: async () => {
      const xml = await ensureXml();
      let id = drawingId;
      if (!id) {
        const res = await api.saveDrawing(name, xml);
        id = res.id;
        setDrawingId(res.id);
        void qc.invalidateQueries({ queryKey: ['drawings'] });
      }
      await api.exportDrawing(id, xml, name);
      return name;
    },
    onSuccess: (n) => message.success(`已导出到个人目录/drawio/${n}.drawio`),
    onError: (e: Error) => message.error(`导出失败：${errText(e)}`),
  });

  const showPreview = async () => {
    setPreviewLoading(true);
    try {
      const reply = await requestExport('svg');
      if (!reply.data) throw new Error('未返回图片');
      setPreview(reply.data);
    } catch (e) {
      message.error(`预览失败：${errText(e)}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  const openDrawing = async (id?: string) => {
    setListOpen(false);
    if (!id) {
      setDrawingId(undefined);
      setName('未命名流程图');
      loadXml(EMPTY_TEMPLATE('未命名流程图'), '未命名流程图');
      return;
    }
    try {
      const row = await api.drawing(id);
      setDrawingId(row.id);
      setName(row.name.replace(/\.drawio$/i, ''));
      loadXml(row.content, row.name);
    } catch (e) {
      message.error(`打开失败：${errText(e)}`);
    }
  };

  const renameM = useMutation({
    mutationFn: ({ id, next }: { id: string; next: string }) => api.renameDrawing(id, next),
    onSuccess: (_, { id, next }) => {
      message.success('已重命名');
      setRenaming(null);
      // 重命名的是当前打开的那张：标题框也要跟着改，
      // 否则下一次「保存」会把旧名字又 PUT 回服务端，等于把重命名撤销了。
      if (id === drawingId) setName(next.replace(/\.drawio$/i, ''));
      void qc.invalidateQueries({ queryKey: ['drawings'] });
    },
    onError: (e: Error) => message.error(`重命名失败：${errText(e)}`),
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => api.deleteDrawing(id),
    onSuccess: (_, id) => {
      message.success('已删除');
      // 删的就是当前正在编辑的那张：清掉 drawingId 让「保存」转成新建，
      // 否则下一次保存会去 PUT 一个已不存在的 id。
      if (id === drawingId) setDrawingId(undefined);
      void qc.invalidateQueries({ queryKey: ['drawings'] });
    },
    onError: (e: Error) => message.error(`删除失败：${errText(e)}`),
  });

  /** 列表里的「导出到个人目录」：内容得从服务端取，画布上只有当前打开的那个。 */
  const exportSaved = useMutation({
    mutationFn: async (row: { id: string; name: string }) => {
      const detail = await api.drawing(row.id);
      await api.exportDrawing(row.id, detail.content, detail.name);
      return detail.name.replace(/\.drawio$/i, '');
    },
    onSuccess: (n) => message.success(`已导出到个人目录/drawio/${n}.drawio`),
    onError: (e: Error) => message.error(`导出失败：${errText(e)}`),
  });

  const importFile = (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      message.error('文件过大（≤2MB）');
      return false;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      if (!text.includes('<mxfile') && !text.includes('<mxGraphModel')) {
        message.error('不是有效的 draw.io 文件');
        return;
      }
      const nextName = file.name.replace(/\.(drawio|xml)$/i, '');
      setName(nextName);
      setDrawingId(undefined);
      loadXml(text, nextName);
      message.success('已载入图形');
    };
    reader.readAsText(file);
    return false;
  };

  useEffect(() => {
    const id = initialDrawing.current;
    if (!id) return;
    initialDrawing.current = null;
    void openDrawing(id);
    // 只在挂载时打开 URL 指定的图形
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (frameOrigin && ev.origin !== frameOrigin) return;
      let msg: Record<string, unknown>;
      try {
        msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.event === 'init') {
        setReady(true);
        const xml = pendingXml.current ?? xmlRef.current;
        pendingXml.current = null;
        post({ action: 'load', xml, title: nameRef.current, autosave: 1 });
      } else if (msg.event === 'autosave' && typeof msg.xml === 'string') {
        xmlRef.current = msg.xml;
        setDirty(true);
      } else if (msg.event === 'save' && typeof msg.xml === 'string') {
        xmlRef.current = msg.xml;
        save.mutate(msg.xml);
      } else if (msg.event === 'export') {
        const waiter = exportWaiter.current;
        exportWaiter.current = null;
        waiter?.(msg as ExportReply);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameOrigin, post, save]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = async () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await wrap.requestFullscreen();
  };

  const toolbar = (
    <Flex gap={8} wrap align="center">
      <Input
        style={{ width: 200 }}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setDirty(true);
        }}
        placeholder="图形名称"
        maxLength={64}
      />
      <Select
        style={{ width: 168 }}
        value={drawingId}
        placeholder="打开我的图形"
        allowClear
        loading={isFetching}
        onChange={(v) => void openDrawing(v)}
        options={(drawings?.drawings ?? []).map((d) => ({ value: d.id, label: d.name }))}
      />
      <Button icon={<FolderOpenOutlined />} onClick={() => setListOpen(true)}>
        我的图形{drawingList.length ? ` · ${drawingList.length}` : ''}
      </Button>
      <Button icon={<FileAddOutlined />} onClick={() => void openDrawing()}>新建</Button>
      <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={handleSave}>
        保存
      </Button>
      <Tooltip title={dirty ? '有未保存的修改' : '已同步'}>
        <Tag color={dirty ? 'orange' : 'green'} style={{ marginInlineEnd: 0 }}>
          {dirty ? '未保存' : ready ? '已就绪' : '加载中'}
        </Tag>
      </Tooltip>
      <Button icon={<PictureOutlined />} loading={previewLoading} onClick={showPreview}>预览图片</Button>
      <Button icon={<DownloadOutlined />} loading={exportToFiles.isPending} onClick={() => exportToFiles.mutate()}>
        导出到个人目录
      </Button>
      <Upload accept=".drawio,.xml,text/xml,application/xml" showUploadList={false} beforeUpload={importFile}>
        <Button icon={<SyncOutlined />}>导入</Button>
      </Upload>
      <Tooltip title={fullscreen ? '退出全屏' : '全屏'}>
        <Button icon={<FullscreenOutlined />} onClick={toggleFullscreen} />
      </Tooltip>
      <Tooltip title="新窗口打开">
        <Button
          icon={<ExportOutlined />}
          href={hostUrl('/?lang=zh', 8082)}
          target="_blank"
          rel="noreferrer"
        />
      </Tooltip>
    </Flex>
  );

  const canvas = (
    <div
      ref={wrapRef}
      style={{
        position: 'relative',
        height: fullscreen ? '100dvh' : 'calc(100dvh - 210px)',
        minHeight: 520,
        border: '1px solid var(--d509-border-soft)',
        borderRadius: fullscreen ? 0 : 12,
        overflow: 'hidden',
        background: 'var(--ant-color-bg-container, #fff)',
      }}
    >
      {!ready && (
        <Flex align="center" justify="center" style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
          <Typography.Text type="secondary">正在加载 draw.io 画布…</Typography.Text>
        </Flex>
      )}
      <iframe
        key={src}
        ref={frameRef}
        src={src}
        title="draw.io 流程图编辑器"
        style={{ display: 'block', width: '100%', height: '100%', border: 0 }}
        allow="clipboard-read; clipboard-write; fullscreen"
        allowFullScreen
      />
    </div>
  );

  const templates = (
    <Flex gap={6} wrap>
      {TEMPLATES.map((t) => (
        <Button
          key={t.key}
          size="small"
          type="text"
          onClick={() => {
            setName(`${t.label} · 流程`);
            setDrawingId(undefined);
            loadXml(templateXml(t.label, t.steps), t.label);
          }}
        >
          {t.label}
        </Button>
      ))}
    </Flex>
  );

  const drawingListPanel = (
    <Drawer
      title="我的图形"
      size={520}
      open={listOpen}
      onClose={() => setListOpen(false)}
      extra={<Button type="primary" onClick={() => void openDrawing()}>新建图形</Button>}
    >
      {isFetching && !drawingList.length ? (
        <Empty description="加载中…" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : drawingList.length === 0 ? (
        <Empty description="还没有保存的图形：画完点「保存」，就会出现在这里" />
      ) : (
        <Listy
          items={drawingList}
          rowKey="id"
          height={Math.min(drawingList.length * 84, 560)}
          itemRender={(d: { id: string; name: string; size: number; updated_at: string }) => (
            <Flex gap={12} align="center" justify="space-between" style={{ padding: '8px 4px' }}>
              <div style={{ minWidth: 0 }}>
                <Typography.Text strong ellipsis style={{ display: 'block' }}>
                  {d.name}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {formatDateTime(d.updated_at)} · {formatSize(d.size)}
                </Typography.Text>
              </div>
              <Flex gap={4} align="center">
                <Button size="small" onClick={() => void openDrawing(d.id)}>继续编辑</Button>
                <Tooltip title="重命名">
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => setRenaming({ id: d.id, name: d.name })}
                  />
                </Tooltip>
                <Tooltip title="导出到个人目录">
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    loading={exportSaved.isPending && exportSaved.variables?.id === d.id}
                    onClick={() => exportSaved.mutate(d)}
                  />
                </Tooltip>
                <Tooltip title="下载 .drawio">
                  <Button size="small" icon={<ExportOutlined />} href={`/api/drawings/${d.id}/download`} />
                </Tooltip>
                <Popconfirm title="删除该图形？" onConfirm={() => deleteM.mutate(d.id)}>
                  <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                </Popconfirm>
              </Flex>
            </Flex>
          )}
        />
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 12 }}>
        「导出到个人目录」会把 .drawio 写入个人目录的 drawio/ 下，可在文件空间里继续管理；
        「下载」直接取服务端保存的那一份。
      </Typography.Text>
    </Drawer>
  );

  return (
    <>
      <PageShell
        title="流程图设计"
        description="内嵌 draw.io 画布：绘图、保存、预览与导出都在门户内完成。"
        extra={toolbar}
      >
        <Flex vertical gap={10}>
          {templates}
          {canvas}
        </Flex>
      </PageShell>
      {drawingListPanel}
      <Modal
        open={!!renaming}
        title="重命名图形"
        okText="保存"
        cancelText="取消"
        confirmLoading={renameM.isPending}
        onOk={() => renaming && renameM.mutate({ id: renaming.id, next: renaming.name })}
        onCancel={() => setRenaming(null)}
      >
        <Input
          value={renaming?.name ?? ''}
          onChange={(e) => setRenaming((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
          maxLength={64}
        />
      </Modal>
      <Modal
        open={!!preview}
        title={name}
        footer={null}
        width={900}
        onCancel={() => setPreview(undefined)}
        styles={{ body: { padding: 12, textAlign: 'center' } }}
      >
        {preview ? <Image src={preview} alt={name} style={{ maxHeight: '72vh' }} /> : null}
      </Modal>
    </>
  );
}