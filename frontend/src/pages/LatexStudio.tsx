import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
  Drawer,
  Empty,
  Flex,
  Input,
  Modal,
  Radio,
  Row,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import {
  CloudDownloadOutlined,
  CommentOutlined,
  DeleteOutlined,
  EyeOutlined,
  FileAddOutlined,
  FileWordOutlined,
  FullscreenOutlined,
  HistoryOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SendOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { formatSize } from '../utils/format';
import PageShell from '../components/PageShell';
import PdfViewer from '../components/PdfViewer';
import {
  api,
  type LatexAsset,
  type LatexDocument,
  type LatexReview,
  type LatexReviewReply,
  type LatexReviewStatus,
  type LatexStatus,
  type LatexVersion,
} from '../services/api';

const { Text } = Typography;


interface Draft {
  title: string;
  venue: string;
  authors: string;
  status: LatexStatus;
  abstract: string;
  keywords: string;
  content: string;
  project_id: string | null;
  due_date: string | null;
}

function toDraft(doc: LatexDocument): Draft {
  return {
    title: doc.title,
    venue: doc.venue,
    authors: doc.authors,
    status: doc.status,
    abstract: doc.abstract,
    keywords: (doc.keywords || []).join('；'),
    content: doc.content,
    project_id: doc.projectId ?? null,
    due_date: doc.dueDate ? doc.dueDate.slice(0, 10) : null,
  };
}

function splitKeywords(raw: string): string[] {
  return raw
    .split(/[；;，,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function fmtTime(value?: string | null): string {
  if (!value) return '—';
  const d = dayjs(value);
  return d.isValid() ? d.format('MM-DD HH:mm') : value;
}

/** 位置 → 行号（1 起）：选中源码后换算成批注要用的行区间。 */
function lineNumberAt(text: string, pos: number): number {
  let line = 1;
  const end = Math.min(pos, text.length);
  for (let i = 0; i < end; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

type DiffRow = { type: 'same' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number };

/** 行级 diff（LCS）：自己实现，不引第三方依赖。 */
function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  // 全文太长时不做 O(n×m) 的 LCS：掐掉公共头尾，中间整段当作改动。
  if (n * m > 2_000_000) {
    let head = 0;
    while (head < n && head < m && a[head] === b[head]) head += 1;
    let tail = 0;
    while (tail < n - head && tail < m - head && a[n - 1 - tail] === b[m - 1 - tail]) tail += 1;
    const rows: DiffRow[] = [];
    for (let i = 0; i < head; i += 1) rows.push({ type: 'same', text: a[i], oldNo: i + 1, newNo: i + 1 });
    for (let i = head; i < n - tail; i += 1) rows.push({ type: 'del', text: a[i], oldNo: i + 1 });
    for (let j = head; j < m - tail; j += 1) rows.push({ type: 'add', text: b[j], newNo: j + 1 });
    for (let k = 0; k < tail; k += 1) {
      rows.push({ type: 'same', text: a[n - tail + k], oldNo: n - tail + k + 1, newNo: m - tail + k + 1 });
    }
    return rows;
  }
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', text: a[i], oldNo: i + 1, newNo: j + 1 });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      rows.push({ type: 'del', text: a[i], oldNo: i + 1 });
      i += 1;
    } else {
      rows.push({ type: 'add', text: b[j], newNo: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ type: 'del', text: a[i], oldNo: i + 1 });
    i += 1;
  }
  while (j < m) {
    rows.push({ type: 'add', text: b[j], newNo: j + 1 });
    j += 1;
  }
  return rows;
}

const REVIEW_STATUS_META: Record<LatexReviewStatus, { label: string; color: string }> = {
  open: { label: '待处理', color: 'blue' },
  accepted: { label: '已接受', color: 'green' },
  rejected: { label: '已拒绝', color: 'red' },
};

export default function LatexStudio() {
  const qc = useQueryClient();
  const { message, modal } = App.useApp();

  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [compileLog, setCompileLog] = useState('');
  // 分栏容器可整屏：审稿/长文写作时把编辑与 PDF 一起拉满
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);
  const [previewKey, setPreviewKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newTemplate, setNewTemplate] = useState('article-cn');
  const [newVenue, setNewVenue] = useState('');
  const [newProject, setNewProject] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['latex-docs', q],
    queryFn: () => api.latexDocuments(q),
    staleTime: 15_000,
  });
  const templatesQuery = useQuery({
    queryKey: ['latex-templates'],
    queryFn: api.latexTemplates,
    staleTime: 10 * 60_000,
  });
  const projectsQuery = useQuery({
    queryKey: ['workbench-projects'],
    queryFn: api.workbenchProjects,
    staleTime: 60_000,
  });
  const docQuery = useQuery({
    queryKey: ['latex-doc', selectedId],
    queryFn: () => api.latexDocument(selectedId as string),
    enabled: Boolean(selectedId),
  });
  const assetsQuery = useQuery({
    queryKey: ['latex-assets', selectedId],
    queryFn: () => api.latexAssets(selectedId as string),
    enabled: Boolean(selectedId),
  });

  const doc = docQuery.data?.document;
  const documents = listQuery.data?.documents ?? [];

  useEffect(() => {
    if (!selectedId && documents.length > 0) {
      setSelectedId(documents[0].id);
    }
  }, [documents, selectedId]);

  useEffect(() => {
    if (doc) {
      setDraft(toDraft(doc));
      setDirty(false);
      setCompileLog(doc.compileLog || '');
    }
  }, [doc?.id, doc?.updatedAt, doc]);


  const buildPayload = (patch: Partial<Draft> = {}) => {
    const d = { ...(draft as Draft), ...patch };
    return {
      title: d.title.trim() || '未命名文稿',
      venue: d.venue,
      authors: d.authors,
      status: d.status,
      abstract: d.abstract,
      keywords: splitKeywords(d.keywords),
      content: d.content,
      project_id: d.project_id || null,
      due_date: d.due_date || null,
    };
  };

  const update = (patch: Partial<Draft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  };

  const persist = async (patch: Partial<Draft> = {}) => {
    if (!selectedId || !draft) return null;
    setSaving(true);
    try {
      const res = await api.latexUpdate(selectedId, buildPayload(patch));
      setDraft(toDraft(res.document));
      setDirty(false);
      qc.setQueryData(['latex-doc', selectedId], { document: res.document });
      void qc.invalidateQueries({ queryKey: ['latex-docs'] });
      return res.document;
    } finally {
      setSaving(false);
    }
  };

  const save = async (silent = false) => {
    const saved = await persist();
    if (saved && !silent) message.success('已保存');
  };


  const compileNow = async () => {
    if (!selectedId || !draft) return;
    setCompiling(true);
    try {
      if (dirty) await persist();
      const res = await api.latexCompile(selectedId);
      setCompileLog(res.log || '');
      if (res.ok) {
        message.success(`编译成功 · ${Math.max(1, Math.round((res.pdfBytes || 0) / 1024))} KB`);
        setPreviewKey((k) => k + 1);
      } else {
        message.error('编译失败，请查看编译日志');
      }
      void qc.invalidateQueries({ queryKey: ['latex-doc', selectedId] });
      void qc.invalidateQueries({ queryKey: ['latex-docs'] });
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setCompiling(false);
    }
  };

  // ---------------------------------------------------------- 编译素材
  // 素材（.cls / .sty / 图片）不参与版本快照，编译时与源码一起进沙箱。
  const assets: LatexAsset[] = assetsQuery.data?.assets ?? [];

  const uploadAsset = async (file: File) => {
    if (!selectedId) return;
    try {
      await api.latexUploadAsset(selectedId, file);
      message.success(`已上传素材 ${file.name}`);
      void qc.invalidateQueries({ queryKey: ['latex-assets', selectedId] });
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const removeAsset = (asset: LatexAsset) => {
    if (!selectedId) return;
    // 素材删除不可恢复（.cls/.sty/图片），误触就是永久丢失。
    // 一定要有二次确认，并在确认文案里说明后果。
    modal.confirm({
      title: `删除素材「${asset.name}」？`,
      content: '删除后不可恢复。如果只是临时不用，建议先改名而不是删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.latexDeleteAsset(selectedId, asset.id);
          message.success(`已删除素材 ${asset.name}`);
          void qc.invalidateQueries({ queryKey: ['latex-assets', selectedId] });
        } catch (err) {
          message.error((err as Error).message);
          // 抛出去让弹窗保持打开：失败时用户要知道"到底删没删掉"，
          // 关掉弹窗就只剩一个转瞬即逝的错误提示。
          throw err;
        }
      },
    });
  };

  const removeDoc = () => {
    if (!selectedId || !doc) return;
    modal.confirm({
      title: '删除这份文稿？',
      content: `「${doc.title}」的源码、PDF 与投稿记录都会一并删除，且不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.latexDelete(selectedId);
          message.success('文稿已删除');
          setSelectedId(null);
          setDraft(null);
          void qc.invalidateQueries({ queryKey: ['latex-docs'] });
        } catch (err) {
          message.error(`删除失败：${(err as Error).message}`);
          // 抛出去让弹窗保持打开：否则用户看到"弹窗关了但没删掉"，
          // 不知道到底删成功没有（可能已删但刷新失败）。
          throw err;
        }
      },
    });
  };

  const createDoc = async () => {
    try {
      const res = await api.latexCreate({
        title: newTitle.trim() || '未命名文稿',
        template: newTemplate,
        venue: newVenue,
        project_id: newProject,
      });
      message.success('已按模板创建文稿');
      setCreateOpen(false);
      setNewTitle('');
      setNewVenue('');
      setNewProject(null);
      setSelectedId(res.document.id);
      void qc.invalidateQueries({ queryKey: ['latex-docs'] });
    } catch (err) {
      message.error((err as Error).message);
    }
  };


  const switchDoc = (id: string) => {
    if (id === selectedId) return;
    if (!dirty) {
      setSelectedId(id);
      return;
    }
    modal.confirm({
      title: '切换文稿？',
      content: '当前文稿有未保存的修改，切换后会丢失。',
      okText: '切换',
      cancelText: '继续编辑',
      onOk: () => setSelectedId(id),
    });
  };

  const pdfUrl = selectedId ? `${api.latexPdfUrl(selectedId)}?v=${previewKey}-${doc?.compiledAt ?? ''}` : '';

  const projectOptions = (projectsQuery.data?.projects ?? []).map((p) => ({
    value: p.id,
    label: p.name,
  }));

  const templates = templatesQuery.data?.templates ?? [];
  const selectedInList = documents.some((d) => d.id === selectedId);

  // ---------------------------------------------------------- 公共模板库
  const [tplTag, setTplTag] = useState('全部');
  const [tplPreview, setTplPreview] = useState<{ name: string; content: string } | null>(null);
  const [tplPreviewLoading, setTplPreviewLoading] = useState(false);

  const tplTags = useMemo(() => {
    const tags = new Set<string>();
    templates.forEach((t) => (t.tags || []).forEach((tag) => tags.add(tag)));
    return ['全部', ...Array.from(tags)];
  }, [templates]);

  const visibleTemplates = useMemo(
    () => (tplTag === '全部' ? templates : templates.filter((t) => (t.tags || []).includes(tplTag))),
    [templates, tplTag],
  );

  const previewTemplate = async (id: string) => {
    setTplPreviewLoading(true);
    try {
      const res = await api.latexTemplate(id);
      setTplPreview({ name: res.template.name, content: res.template.content });
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setTplPreviewLoading(false);
    }
  };

  // ---------------------------------------------------------- 上下审稿
  const [reviewOpen, setReviewOpen] = useState(false);
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);
  const selectionRef = useRef<{ from: number; to: number } | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [commentRange, setCommentRange] = useState({ from: 1, to: 1, quote: '' });
  const [replies, setReplies] = useState<Record<string, LatexReviewReply[]>>({});
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const reviewsQuery = useQuery({
    queryKey: ['latex-reviews', selectedId],
    queryFn: () => api.latexReviews(selectedId as string),
    enabled: Boolean(selectedId) && reviewOpen,
    staleTime: 10_000,
  });
  const reviews = reviewsQuery.data?.reviews ?? [];

  // 源码里选中一段 → 换算成行号，交给批注表单
  const trackSelection = (el: HTMLTextAreaElement) => {
    const from = el.selectionStart ?? 0;
    const to = el.selectionEnd ?? 0;
    if (from === to) {
      selectionRef.current = null;
      setSelection(null);
      return;
    }
    const range = { from, to };
    selectionRef.current = range;
    setSelection(range);
  };

  const openComment = () => {
    const range = selectionRef.current;
    if (!range || !draft) return;
    setCommentRange({
      from: lineNumberAt(draft.content, range.from),
      to: lineNumberAt(draft.content, range.to),
      quote: draft.content.slice(range.from, range.to).slice(0, 2000),
    });
    setCommentText('');
    setCommentOpen(true);
  };

  const submitComment = async () => {
    if (!selectedId) return;
    try {
      await api.latexCreateReview(selectedId, {
        lineFrom: commentRange.from,
        lineTo: commentRange.to,
        quote: commentRange.quote,
        comment: commentText.trim(),
      });
      message.success('批注已添加');
      setCommentOpen(false);
      selectionRef.current = null;
      setSelection(null);
      void qc.invalidateQueries({ queryKey: ['latex-reviews', selectedId] });
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const setReviewStatus = async (review: LatexReview, status: LatexReviewStatus) => {
    if (!selectedId) return;
    try {
      await api.latexUpdateReview(selectedId, review.id, status);
      void qc.invalidateQueries({ queryKey: ['latex-reviews', selectedId] });
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  // 正在删除的批注 id：按钮在请求期间禁用，避免重复点击提交两次删除。
  const [pendingReviewId, setPendingReviewId] = useState<string | null>(null);

  const removeReview = (review: LatexReview) => {
    if (!selectedId) return;
    modal.confirm({
      title: '删除这条批注？',
      content: '批注与它下面的回复都会一并删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setPendingReviewId(review.id);
        try {
          await api.latexDeleteReview(selectedId, review.id);
          message.success('批注已删除');
          void qc.invalidateQueries({ queryKey: ['latex-reviews', selectedId] });
        } catch (err) {
          message.error(`删除失败：${(err as Error).message}`);
          throw err;
        } finally {
          setPendingReviewId(null);
        }
      },
    });
  };

  const toggleReplies = async (review: LatexReview) => {
    if (expanded === review.id) {
      setExpanded(null);
      return;
    }
    setExpanded(review.id);
    if (!selectedId || replies[review.id]) return;
    try {
      const res = await api.latexReviewReplies(selectedId, review.id);
      setReplies((prev) => ({ ...prev, [review.id]: res.replies }));
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const submitReply = async (review: LatexReview) => {
    if (!selectedId) return;
    const content = (replyDraft[review.id] || '').trim();
    if (!content) return;
    try {
      await api.latexAddReviewReply(selectedId, review.id, content);
      setReplyDraft((prev) => ({ ...prev, [review.id]: '' }));
      const res = await api.latexReviewReplies(selectedId, review.id);
      setReplies((prev) => ({ ...prev, [review.id]: res.replies }));
      void qc.invalidateQueries({ queryKey: ['latex-reviews', selectedId] });
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  // ---------------------------------------------------------- 版本对比
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffLeft, setDiffLeft] = useState<number | null>(null);
  const [diffRight, setDiffRight] = useState<number | null>(null);
  const [diffRows, setDiffRows] = useState<DiffRow[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);

  const versionsQuery = useQuery({
    queryKey: ['latex-versions', selectedId],
    queryFn: () => api.latexVersions(selectedId as string),
    enabled: Boolean(selectedId) && diffOpen,
    staleTime: 10_000,
  });
  const versions = versionsQuery.data?.versions ?? [];
  // 没有源码快照的旧事件不能参与对比（取内容会 404）
  const diffableVersions = versions.filter((v) => v.hasContent);

  const versionLabel = (v: LatexVersion) => {
    const kind = v.kind === 'created' ? '创建' : v.kind === 'compile' ? '编译' : '保存';
    return `${kind} · ${fmtTime(v.createdAt)}${v.note ? ` · ${v.note}` : ''}`;
  };

  const runDiff = async (left: number | null, right: number | null) => {
    if (!selectedId || left === null || right === null) {
      setDiffRows([]);
      return;
    }
    setDiffLoading(true);
    try {
      const [older, newer] = await Promise.all([
        api.latexVersion(selectedId, left),
        api.latexVersion(selectedId, right),
      ]);
      setDiffRows(diffLines(older.version.content, newer.version.content));
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setDiffLoading(false);
    }
  };

  useEffect(() => {
    if (!diffOpen || !diffableVersions.length) return;
    if (diffLeft !== null && diffRight !== null) return;
    const older = diffableVersions[diffableVersions.length - 1];
    const newer = diffableVersions[0];
    setDiffLeft(older.id);
    setDiffRight(newer.id);
    void runDiff(older.id, newer.id);
    // runDiff 每次渲染都是新函数，这里只关心「版本列表变了」这一件事
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffOpen, diffableVersions]);

  const toolbar = (
    <Card size="small" styles={{ body: { padding: '10px 14px' } }}>
      <Flex justify="space-between" align="center" wrap gap={10}>
        <Space wrap size={8}>
          <Select
            showSearch
            style={{ minWidth: 280 }}
            value={selectedInList ? (selectedId ?? undefined) : undefined}
            placeholder={documents.length ? '选择文稿' : '还没有文稿'}
            loading={listQuery.isLoading}
            options={documents.map((d) => ({ value: d.id, label: d.title }))}
            onChange={(id) => switchDoc(String(id))}
            filterOption={(input, option) =>
              `${option?.label ?? ''}`.toLowerCase().includes(input.trim().toLowerCase())
            }
            optionRender={(option) => {
              const d = documents.find((x) => x.id === option.value);
              return (
                <Flex vertical gap={0} style={{ padding: '2px 0' }}>
                  <Text ellipsis style={{ fontSize: 13 }}>
                    {option.label}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 11.5 }}>
                    {d?.venue || '未指定期刊/会议'}
                  </Text>
                </Flex>
              );
            }}
          />
        </Space>
        <Space wrap size={8}>
          <Input.Search
            allowClear
            placeholder="搜索标题、期刊或摘要"
            style={{ width: 230 }}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="搜索文稿"
          />
          <Button icon={<SaveOutlined />} loading={saving} disabled={!draft} onClick={() => void save()}>
            保存
          </Button>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={compiling}
            disabled={!selectedId}
            onClick={() => void compileNow()}
          >
            编译 PDF
          </Button>
          <Button icon={<CommentOutlined />} disabled={!selectedId} onClick={() => setReviewOpen(true)}>
            审稿
          </Button>
          <Button icon={<HistoryOutlined />} disabled={!selectedId} onClick={() => setDiffOpen(true)}>
            版本对比
          </Button>
          <Tooltip title="删除文稿">
            <Button danger icon={<DeleteOutlined />} disabled={!doc} onClick={removeDoc} aria-label="删除文稿" />
          </Tooltip>
        </Space>
      </Flex>
    </Card>
  );

  // DOCX → LaTeX：转换器会把无法还原的东西（图片/公式/合并单元格）逐条报回来，
  // 这里如实展示，不假装转换是完美的。
  const importDocx = async (file: File) => {
    setImporting(true);
    try {
      const res = await api.latexImportDocx(file);
      message.success(`已导入「${res.document.title}」`);
      if (res.warnings.length) {
        modal.info({
          title: '导入完成，但有需要手工处理的地方',
          width: 620,
          content: (
            <ul style={{ paddingInlineStart: 18, margin: 0 }}>
              {res.warnings.map((w) => (
                <li key={w} style={{ fontSize: 12.5, lineHeight: 1.8 }}>
                  {w}
                </li>
              ))}
            </ul>
          ),
        });
      }
      await qc.invalidateQueries({ queryKey: ['latex-docs'] });
      setSelectedId(res.document.id);
    } catch (err) {
      message.error((err as Error).message || 'DOCX 导入失败');
    } finally {
      setImporting(false);
    }
  };

  return (
    <PageShell
      title="LaTeX 写作"
      description="在线 LaTeX 写作与编译预览，支持 DOCX 导入与公共模板库"
      extra={
        <Flex gap={8} wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void qc.invalidateQueries({ queryKey: ['latex-docs'] })}>
            刷新
          </Button>
          <Tooltip title={fullscreen ? '退出整屏（Esc）' : '整屏编辑与预览'}>
            <Button
              icon={<FullscreenOutlined />}
              onClick={() => setFullscreen((v) => !v)}
              aria-label={fullscreen ? '退出整屏' : '整屏'}
            />
          </Tooltip>
          <Upload
            accept=".docx"
            showUploadList={false}
            beforeUpload={(f: File) => {
              void importDocx(f);
              return false;
            }}
          >
            <Button icon={<FileWordOutlined />} loading={importing}>
              导入 DOCX
            </Button>
          </Upload>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建文稿
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={12}>
        {toolbar}
        {listQuery.isLoading ? (
          <Card size="small">
            <Skeleton active paragraph={{ rows: 10 }} />
          </Card>
        ) : listQuery.error ? (
          <Card size="small">
            <Alert type="error" showIcon title="文稿列表加载失败" description={(listQuery.error as Error).message} />
          </Card>
        ) : documents.length === 0 ? (
          <Card variant="borderless" style={{ background: 'var(--ant-color-fill-quaternary)' }}>
            <Flex vertical align="center" style={{ padding: '36px 12px' }}>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={q ? '没有匹配的文稿' : '还没有文稿，从模板新建一份'}
              >
                <Button type="primary" icon={<FileAddOutlined />} onClick={() => setCreateOpen(true)}>
                  新建文稿
                </Button>
              </Empty>
            </Flex>
          </Card>
        ) : !selectedId ? (
            <Card size="small" style={{ minHeight: 420 }}>
              <Empty description="选择上方文稿开始撰写，或新建一份">
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                  新建文稿
                </Button>
              </Empty>
            </Card>
          ) : docQuery.isLoading || !draft ? (
            <Card size="small">
              <Skeleton active paragraph={{ rows: 12 }} />
            </Card>
          ) : (
            <Card
              size="small"
              style={
                fullscreen
                  ? {
                      position: 'fixed',
                      inset: 12,
                      zIndex: 1200,
                      margin: 0,
                      display: 'flex',
                      flexDirection: 'column',
                    }
                  : undefined
              }
              styles={
                fullscreen
                  ? { body: { flex: 1, minHeight: 0, overflow: 'auto' } }
                  : undefined
              }
              title={
                <Flex align="center" gap={8} style={{ minWidth: 0 }}>
                  <Input
                    variant="borderless"
                    value={draft.title}
                    onChange={(e) => update({ title: e.target.value })}
                    style={{ fontWeight: 600, fontSize: 15, paddingInline: 0 }}
                    aria-label="文稿标题"
                  />
                  {dirty && <Tag color="orange" style={{ margin: 0 }}>未保存</Tag>}
                </Flex>
              }
            >
              {/* 源码与 PDF 左右分栏：同一容器、可整屏，不再用标签页来回切换 */}
              <Flex gap={12} align="stretch" style={{ minWidth: 0 }}>
                <div style={{ flex: '1 1 54%', minWidth: 0 }}>
                  <Flex vertical gap={10}>
                    <Input.TextArea
                      value={draft.content}
                      onChange={(e) => update({ content: e.target.value })}
                      onSelect={(e) => trackSelection(e.currentTarget)}
                      onClick={(e) => trackSelection(e.currentTarget)}
                      onKeyUp={(e) => trackSelection(e.currentTarget)}
                      autoSize={{ minRows: 24, maxRows: fullscreen ? 60 : 46 }}
                      spellCheck={false}
                      style={{
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                        fontSize: 12.5,
                        lineHeight: 1.65,
                        tabSize: 2,
                      }}
                      aria-label="LaTeX 源码"
                    />
                    <Flex gap={8} align="center" wrap>
                      <Button size="small" icon={<CommentOutlined />} disabled={!selection} onClick={openComment}>
                        给选中处加批注
                      </Button>
                      {selection && (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          已选中第 {lineNumberAt(draft.content, selection.from)}–{lineNumberAt(draft.content, selection.to)} 行
                        </Text>
                      )}
                    </Flex>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      编译在独立沙箱中运行（xelatex · 禁用 shell 转义 · 60s 超时），源码与产物不会离开实验室。
                    </Text>
                    {compileLog && (
                      <Collapse
                        size="small"
                        items={[
                          {
                            key: 'log',
                            label: (
                              <Flex gap={8} align="center">
                                <Text style={{ fontSize: 12.5 }}>编译日志</Text>
                                <Tag color={doc?.compileOk ? 'green' : 'red'} style={{ margin: 0 }}>
                                  {doc?.compileOk ? '成功' : '失败'}
                                </Tag>
                              </Flex>
                            ),
                            children: (
                              <pre
                                style={{
                                  margin: 0,
                                  maxHeight: 260,
                                  overflow: 'auto',
                                  fontSize: 11.5,
                                  lineHeight: 1.55,
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word',
                                }}
                              >
                                {compileLog}
                              </pre>
                            ),
                          },
                        ]}
                      />
                    )}
                    <Collapse
                      size="small"
                      items={[
                        {
                          key: 'meta',
                          label: <Text style={{ fontSize: 12.5 }}>文档信息（期刊 / 作者 / 摘要 / 关键词）</Text>,
                          children: (
                            <>
                            <Row gutter={[12, 12]}>
                              <Col xs={24} md={12}>
                                <Text type="secondary" style={{ fontSize: 12 }}>目标期刊 / 会议</Text>
                                <Input
                                  value={draft.venue}
                                  onChange={(e) => update({ venue: e.target.value })}
                                  placeholder="例如：Plant Cell Reports"
                                />
                              </Col>
                              <Col xs={24} md={12}>
                                <Text type="secondary" style={{ fontSize: 12 }}>作者</Text>
                                <Input
                                  value={draft.authors}
                                  onChange={(e) => update({ authors: e.target.value })}
                                  placeholder="用逗号分隔，通讯作者可加 *"
                                />
                              </Col>
                              <Col span={24}>
                                <Text type="secondary" style={{ fontSize: 12 }}>摘要</Text>
                                <Input.TextArea
                                  value={draft.abstract}
                                  onChange={(e) => update({ abstract: e.target.value })}
                                  autoSize={{ minRows: 3, maxRows: 8 }}
                                  placeholder="研究背景、方法、主要结果与结论"
                                />
                              </Col>
                              <Col span={24}>
                                <Text type="secondary" style={{ fontSize: 12 }}>关键词（分号或逗号分隔）</Text>
                                <Input
                                  value={draft.keywords}
                                  onChange={(e) => update({ keywords: e.target.value })}
                                  placeholder="例如：水稻；抗旱；转录组"
                                />
                              </Col>
                            </Row>
                            <div style={{ marginTop: 14, borderTop: '1px solid var(--ant-color-border-secondary)', paddingTop: 12 }}>
                              <Flex justify="space-between" align="center" wrap gap={8}>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  编译素材：放 .cls/.sty/图片，编译时与源码一起进沙箱
                                </Text>
                                <Upload
                                  accept=".cls,.sty,.bib,.bst,.png,.jpg,.jpeg,.pdf,.eps,.svg"
                                  showUploadList={false}
                                  multiple={false}
                                  beforeUpload={(file) => {
                                    // SAFETY: antd 传的 RcFile 就是 File 的子类
                                    void uploadAsset(file as unknown as File);
                                    return false;
                                  }}
                                >
                                  <Button size="small" icon={<UploadOutlined />}>上传素材</Button>
                                </Upload>
                              </Flex>
                              {assets.length === 0 ? (
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  还没有素材。学位论文模板默认用 ctexbook，可直接编译；
                                  要用学校官方类，把 nwafuthesis.cls（及 .bst）上传到这里。
                                </Text>
                              ) : (
                                <Flex vertical gap={6} style={{ marginTop: 8 }}>
                                  {assets.map((asset) => (
                                    <Flex key={asset.id} justify="space-between" align="center" gap={8}>
                                      <Text style={{ fontSize: 12.5 }}>{asset.name}</Text>
                                      <Flex gap={8} align="center">
                                        <Text type="secondary" style={{ fontSize: 12 }}>
                                          {Math.max(1, Math.round(asset.bytes / 1024))} KB
                                        </Text>
                                        <Button
                                          size="small"
                                          type="text"
                                          danger
                                          icon={<DeleteOutlined />}
                                          onClick={() => removeAsset(asset)}
                                          aria-label={`删除素材 ${asset.name}`}
                                        />
                                      </Flex>
                                    </Flex>
                                  ))}
                                </Flex>
                              )}
                            </div>
                            </>
                          ),
                        },
                      ]}
                    />
                  </Flex>
                </div>
                <div style={{ flex: '1 1 46%', minWidth: 0 }}>
                  {doc?.hasPdf ? (
                    <Flex vertical gap={10}>
                      <Flex justify="space-between" align="center" wrap gap={8}>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          最近编译 {fmtTime(doc.compiledAt)} · {formatSize(doc.pdfBytes)}
                        </Text>
                        <Flex gap={6}>
                          {/* 用 Button 的 href 而不是 window.open(变量)：
                              链接是同源相对路径，但 href 渲染成真正的 <a>，
                              用户能中键/右键在新标签打开，window.open 做不到；
                              顺带也消掉了"把变量直接丢进 window.open"的写法。 */}
                          <Button
                            size="small"
                            icon={<CloudDownloadOutlined />}
                            href={api.latexPdfUrl(selectedId, true)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            下载
                          </Button>
                          <Button
                            size="small"
                            icon={<SendOutlined />}
                            href={pdfUrl || undefined}
                            target="_blank"
                            rel="noreferrer"
                          >
                            新窗口打开
                          </Button>
                        </Flex>
                      </Flex>
                      {/* 用门户原生阅读器（pdf.js 内核），不用 iframe：
                          iframe 在整屏下高度算不准，且不能翻页/缩放/选字。 */}
                      <div
                        style={{
                          border: '1px solid var(--ant-color-border-secondary)',
                          borderRadius: 10,
                          overflow: 'hidden',
                          background: '#fff',
                        }}
                      >
                        <PdfViewer
                          src={pdfUrl}
                          name={`${draft.title || 'document'}.pdf`}
                          height={fullscreen ? 'calc(100vh - 230px)' : 720}
                        />
                      </div>
                    </Flex>
                  ) : (
                    <Flex
                      vertical
                      align="center"
                      justify="center"
                      gap={12}
                      style={{
                        minHeight: fullscreen ? 'calc(100vh - 200px)' : 720,
                        border: '1px dashed var(--ant-color-border-secondary)',
                        borderRadius: 10,
                      }}
                    >
                      <Empty description="还没有 PDF，先编译一次">
                        <Button type="primary" icon={<PlayCircleOutlined />} loading={compiling} onClick={() => void compileNow()}>
                          编译 PDF
                        </Button>
                      </Empty>
                    </Flex>
                  )}
                </div>
              </Flex>
            </Card>
          )}
      </Flex>

      <Modal
        open={createOpen}
        title="新建 LaTeX 文稿"
        okText="创建"
        cancelText="取消"
        onOk={() => void createDoc()}
        onCancel={() => setCreateOpen(false)}
        width={720}
        destroyOnHidden
      >
        <Flex vertical gap={14} style={{ paddingTop: 4 }}>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>标题</Text>
            <Input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="例如：水稻耐旱候选基因的功能验证"
              onPressEnter={() => void createDoc()}
            />
          </div>
          <div>
            <Flex justify="space-between" align="center" wrap gap={8}>
              <Text type="secondary" style={{ fontSize: 12 }}>模板</Text>
              <Segmented size="small" options={tplTags} value={tplTag} onChange={(v) => setTplTag(String(v))} />
            </Flex>
            <Row gutter={[12, 12]} style={{ marginTop: 8 }}>
              {visibleTemplates.map((t) => (
                <Col xs={24} md={12} key={t.id}>
                  <Card
                    size="small"
                    hoverable
                    onClick={() => setNewTemplate(t.id)}
                    style={{
                      borderColor: newTemplate === t.id ? 'var(--ant-color-primary)' : undefined,
                      height: '100%',
                    }}
                  >
                    <Flex vertical gap={6}>
                      <Flex align="center" gap={8}>
                        <Radio checked={newTemplate === t.id} onChange={() => setNewTemplate(t.id)} />
                        <Text strong style={{ fontSize: 13 }}>{t.name}</Text>
                      </Flex>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {t.description}
                      </Text>
                      <Flex gap={6} wrap align="center">
                        {(t.tags || []).map((tag) => (
                          <Tag key={tag} style={{ margin: 0, fontSize: 11 }}>
                            {tag}
                          </Tag>
                        ))}
                        <Button
                          size="small"
                          type="link"
                          icon={<EyeOutlined />}
                          onClick={(e) => {
                            e.stopPropagation();
                            void previewTemplate(t.id);
                          }}
                        >
                          预览源码
                        </Button>
                      </Flex>
                    </Flex>
                  </Card>
                </Col>
              ))}
            </Row>
            {visibleTemplates.length === 0 && <Empty description="这个分类下暂时没有模板" />}
          </div>
          <Row gutter={12}>
            <Col xs={24} md={12}>
              <Text type="secondary" style={{ fontSize: 12 }}>目标期刊 / 会议（可后填）</Text>
              <Input value={newVenue} onChange={(e) => setNewVenue(e.target.value)} placeholder="例如：Nature Plants" />
            </Col>
            <Col xs={24} md={12}>
              <Text type="secondary" style={{ fontSize: 12 }}>关联项目（可选）</Text>
              <Select
                allowClear
                style={{ width: '100%' }}
                placeholder="从个人工作台项目中选择"
                value={newProject ?? undefined}
                onChange={(v) => setNewProject(v ?? null)}
                options={projectOptions}
                loading={projectsQuery.isLoading}
              />
            </Col>
          </Row>
        </Flex>
      </Modal>

      {/* 模板源码预览：模板列表不带源码，预览时单独取 */}
      <Drawer
        open={Boolean(tplPreview)}
        title={tplPreview ? `模板源码 · ${tplPreview.name}` : '模板源码'}
        size={720}
        onClose={() => setTplPreview(null)}
      >
        {tplPreviewLoading ? (
          <Skeleton active paragraph={{ rows: 10 }} />
        ) : (
          <pre
            style={{
              margin: 0,
              fontSize: 12,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {tplPreview?.content ?? ''}
          </pre>
        )}
      </Drawer>

      {/* 批注表单：选中行号 + 原文 + 意见 */}
      <Modal
        open={commentOpen}
        title="添加批注"
        okText="添加"
        cancelText="取消"
        onOk={() => void submitComment()}
        onCancel={() => setCommentOpen(false)}
        destroyOnHidden
      >
        <Flex vertical gap={10} style={{ paddingTop: 4 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            第 {commentRange.from}–{commentRange.to} 行
          </Text>
          {commentRange.quote && (
            <pre
              style={{
                margin: 0,
                maxHeight: 180,
                overflow: 'auto',
                padding: '6px 8px',
                borderRadius: 6,
                background: 'var(--ant-color-fill-quaternary)',
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {commentRange.quote}
            </pre>
          )}
          <Input.TextArea
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder="写清楚要改什么、为什么改"
          />
        </Flex>
      </Modal>

      {/* 审稿抽屉：批注列表 + 接受 / 拒绝 / 回复 / 删除 */}
      <Drawer open={reviewOpen} title="审稿意见" size={520} onClose={() => setReviewOpen(false)}>
        {reviewsQuery.isLoading ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : reviews.length === 0 ? (
          <Empty description="还没有批注：在源码里选中一段，点「给选中处加批注」" />
        ) : (
          <Flex vertical gap={10}>
            {reviews.map((r) => {
              const meta = REVIEW_STATUS_META[r.status] ?? REVIEW_STATUS_META.open;
              return (
                <Card
                  key={r.id}
                  size="small"
                  style={{ borderLeft: `3px solid var(--ant-color-${meta.color})` }}
                >
                  <Flex vertical gap={6}>
                    <Flex gap={8} align="center" wrap>
                      <Tag color={meta.color} style={{ margin: 0 }}>
                        {meta.label}
                      </Tag>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        第 {r.lineFrom}–{r.lineTo} 行 · {r.author || '匿名'} · {fmtTime(r.createdAt)}
                      </Text>
                    </Flex>
                    {r.quote && (
                      <pre
                        style={{
                          margin: 0,
                          maxHeight: 140,
                          overflow: 'auto',
                          padding: '6px 8px',
                          borderRadius: 6,
                          background: 'var(--ant-color-fill-quaternary)',
                          fontSize: 12,
                          lineHeight: 1.6,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {r.quote}
                      </pre>
                    )}
                    <Text style={{ fontSize: 13 }}>{r.comment}</Text>
                    <Flex gap={6} wrap>
                      {r.status !== 'accepted' && (
                        <Button size="small" onClick={() => void setReviewStatus(r, 'accepted')}>
                          接受
                        </Button>
                      )}
                      {r.status !== 'rejected' && (
                        <Button size="small" onClick={() => void setReviewStatus(r, 'rejected')}>
                          拒绝
                        </Button>
                      )}
                      {r.status !== 'open' && (
                        <Button size="small" onClick={() => void setReviewStatus(r, 'open')}>
                          重新打开
                        </Button>
                      )}
                      <Button size="small" onClick={() => void toggleReplies(r)}>
                        回复{r.replyCount ? `（${r.replyCount}）` : ''}
                      </Button>
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        loading={pendingReviewId === r.id}
                        disabled={pendingReviewId !== null && pendingReviewId !== r.id}
                        onClick={() => removeReview(r)}
                      >
                        删除
                      </Button>
                    </Flex>
                    {expanded === r.id && (
                      <Flex
                        vertical
                        gap={8}
                        style={{ borderTop: '1px solid var(--ant-color-border-secondary)', paddingTop: 8 }}
                      >
                        {(replies[r.id] || []).map((rep) => (
                          <Flex key={rep.id} vertical gap={2}>
                            <Text type="secondary" style={{ fontSize: 11.5 }}>
                              {rep.author || '匿名'} · {fmtTime(rep.createdAt)}
                            </Text>
                            <Text style={{ fontSize: 12.5 }}>{rep.content}</Text>
                          </Flex>
                        ))}
                        <Flex gap={6}>
                          <Input
                            size="small"
                            value={replyDraft[r.id] || ''}
                            onChange={(e) => setReplyDraft((prev) => ({ ...prev, [r.id]: e.target.value }))}
                            onPressEnter={() => void submitReply(r)}
                            placeholder="回复这条批注"
                          />
                          <Button size="small" type="primary" onClick={() => void submitReply(r)}>
                            发送
                          </Button>
                        </Flex>
                      </Flex>
                    )}
                  </Flex>
                </Card>
              );
            })}
          </Flex>
        )}
      </Drawer>

      {/* 版本对比：选两个版本 → 行级 diff */}
      <Modal
        open={diffOpen}
        title="版本对比"
        width={900}
        footer={null}
        onCancel={() => setDiffOpen(false)}
      >
        <Flex vertical gap={10} style={{ paddingTop: 4 }}>
          <Flex gap={10} wrap>
            <Select
              style={{ minWidth: 280 }}
              value={diffLeft ?? undefined}
              placeholder="旧版本"
              options={diffableVersions.map((v) => ({ value: v.id, label: versionLabel(v) }))}
              onChange={(v) => {
                setDiffLeft(v);
                void runDiff(v, diffRight);
              }}
            />
            <Select
              style={{ minWidth: 280 }}
              value={diffRight ?? undefined}
              placeholder="新版本"
              options={diffableVersions.map((v) => ({ value: v.id, label: versionLabel(v) }))}
              onChange={(v) => {
                setDiffRight(v);
                void runDiff(diffLeft, v);
              }}
            />
          </Flex>
          {diffLoading ? (
            <Skeleton active paragraph={{ rows: 8 }} />
          ) : diffRows.length === 0 ? (
            <Empty description="选两个版本就能看行级差异（保存 / 编译后才会产生版本）" />
          ) : (
            <div
              style={{
                maxHeight: 460,
                overflow: 'auto',
                border: '1px solid var(--ant-color-border-secondary)',
                borderRadius: 8,
              }}
            >
              {diffRows.map((row, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    gap: 8,
                    padding: '1px 8px',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    fontSize: 12,
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    background:
                      row.type === 'add'
                        ? 'rgba(82,196,26,0.12)'
                        : row.type === 'del'
                          ? 'rgba(255,77,79,0.12)'
                          : undefined,
                  }}
                >
                  <span style={{ width: 44, flex: 'none', textAlign: 'right', color: 'var(--ant-color-text-quaternary, #999)' }}>
                    {row.oldNo ?? ''}
                  </span>
                  <span style={{ width: 44, flex: 'none', textAlign: 'right', color: 'var(--ant-color-text-quaternary, #999)' }}>
                    {row.newNo ?? ''}
                  </span>
                  <span style={{ width: 14, flex: 'none' }}>{row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}</span>
                  <span style={{ flex: 1 }}>{row.text}</span>
                </div>
              ))}
            </div>
          )}
        </Flex>
      </Modal>
    </PageShell>
  );
}