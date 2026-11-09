import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
  DatePicker,
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
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import {
  BookOutlined,
  CloudDownloadOutlined,
  CodeOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  FileAddOutlined,
  FilePdfOutlined,
  HistoryOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SendOutlined,
  TranslationOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import PageShell from '../components/PageShell';
import { api, type LatexDocument, type LatexStatus } from '../services/api';

const { Text, Paragraph } = Typography;

const STATUS_META: Record<LatexStatus, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' },
  writing: { label: '撰写中', color: 'processing' },
  submitted: { label: '已投稿', color: 'blue' },
  under_review: { label: '审稿中', color: 'gold' },
  revision: { label: '返修中', color: 'orange' },
  accepted: { label: '已录用', color: 'green' },
  rejected: { label: '未录用', color: 'red' },
};

const STATUS_ORDER: LatexStatus[] = ['draft', 'writing', 'submitted', 'under_review', 'revision', 'accepted'];

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

export default function LatexStudio() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message, modal } = App.useApp();

  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [compileLog, setCompileLog] = useState('');
  const [tab, setTab] = useState('source');
  const [previewKey, setPreviewKey] = useState(0);
  const [eventNote, setEventNote] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newTemplate, setNewTemplate] = useState('article-cn');
  const [newVenue, setNewVenue] = useState('');
  const [newProject, setNewProject] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['latex-docs', q, statusFilter],
    queryFn: () => api.latexDocuments(q, statusFilter),
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
  const eventsQuery = useQuery({
    queryKey: ['latex-events', selectedId],
    queryFn: () => api.latexEvents(selectedId as string),
    enabled: Boolean(selectedId) && tab === 'history',
  });

  const doc = docQuery.data?.document;
  const documents = listQuery.data?.documents ?? [];
  const counts = listQuery.data?.counts ?? {};

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

  const statusOptions = useMemo(
    () =>
      templatesQuery.data?.statuses?.map((s) => ({ value: s.value, label: s.label })) ??
      STATUS_ORDER.map((s) => ({ value: s, label: STATUS_META[s].label })),
    [templatesQuery.data],
  );

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

  const changeStatus = async (next: LatexStatus) => {
    if (!draft) return;
    update({ status: next });
    try {
      await persist({ status: next });
      message.success(`状态已更新为「${STATUS_META[next].label}」`);
      void qc.invalidateQueries({ queryKey: ['latex-events', selectedId] });
    } catch (err) {
      message.error((err as Error).message);
    }
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
        setTab('pdf');
      } else {
        setTab('source');
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

  const removeDoc = () => {
    if (!selectedId || !doc) return;
    modal.confirm({
      title: '删除这份文稿？',
      content: `「${doc.title}」的源码、PDF 与投稿记录都会一并删除，且不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await api.latexDelete(selectedId);
        message.success('文稿已删除');
        setSelectedId(null);
        setDraft(null);
        void qc.invalidateQueries({ queryKey: ['latex-docs'] });
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
      setTab('source');
      void qc.invalidateQueries({ queryKey: ['latex-docs'] });
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const addEvent = async () => {
    if (!selectedId || !eventNote.trim()) return;
    try {
      await api.latexAddEvent(selectedId, eventNote.trim());
      setEventNote('');
      void qc.invalidateQueries({ queryKey: ['latex-events', selectedId] });
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
                    {d ? `${STATUS_META[d.status]?.label ?? d.status} · ${d.venue || '未指定期刊/会议'}` : ''}
                  </Text>
                </Flex>
              );
            }}
          />
          <Segmented
            value={statusFilter || 'all'}
            onChange={(v) => setStatusFilter(v === 'all' ? '' : String(v))}
            options={[
              { value: 'all', label: '全部' },
              ...STATUS_ORDER.slice(0, 5).map((s) => ({
                value: s,
                label: `${STATUS_META[s].label} ${counts[s] ?? 0}`,
              })),
            ]}
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
          <Tooltip title="删除文稿">
            <Button danger icon={<DeleteOutlined />} disabled={!doc} onClick={removeDoc} aria-label="删除文稿" />
          </Tooltip>
        </Space>
      </Flex>
    </Card>
  );

  return (
    <PageShell
      title="LaTeX 写作"
      description="模板起草 · 本地编译 · 投稿时间线，与项目、文献、知识库联动"
      extra={
        <Flex gap={8} wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void qc.invalidateQueries({ queryKey: ['latex-docs'] })}>
            刷新
          </Button>
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
                description={q || statusFilter ? '没有匹配的文稿' : '还没有文稿，从模板新建一份'}
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
              extra={
                <Space wrap size={6}>
                  {draft.due_date ? (
                    <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      截止 {draft.due_date}
                    </Text>
                  ) : null}
                  <Select
                    size="small"
                    value={draft.status}
                    onChange={(v) => void changeStatus(v as LatexStatus)}
                    options={statusOptions}
                    style={{ width: 104 }}
                    aria-label="投稿状态"
                  />
                </Space>
              }
            >
              <Tabs
                activeKey={tab}
                onChange={setTab}
                items={[
                  {
                    key: 'source',
                    label: (
                      <span>
                        <CodeOutlined /> 源码
                      </span>
                    ),
                    children: (
                      <Flex vertical gap={10}>
                        <Input.TextArea
                          value={draft.content}
                          onChange={(e) => update({ content: e.target.value })}
                          autoSize={{ minRows: 24, maxRows: 46 }}
                          spellCheck={false}
                          style={{
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                            fontSize: 12.5,
                            lineHeight: 1.65,
                            tabSize: 2,
                          }}
                          aria-label="LaTeX 源码"
                        />
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
                      </Flex>
                    ),
                  },
                  {
                    key: 'meta',
                    label: (
                      <span>
                        <ExperimentOutlined /> 摘要与关联
                      </span>
                    ),
                    children: (
                      <Flex vertical gap={14}>
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
                          <Col xs={24} md={12}>
                            <Text type="secondary" style={{ fontSize: 12 }}>投稿截止</Text>
                            <DatePicker
                              style={{ width: '100%' }}
                              value={draft.due_date ? dayjs(draft.due_date) : null}
                              onChange={(d) => update({ due_date: d ? d.format('YYYY-MM-DD') : null })}
                              placeholder="选择日期"
                            />
                          </Col>
                          <Col xs={24} md={12}>
                            <Text type="secondary" style={{ fontSize: 12 }}>关联项目</Text>
                            <Select
                              allowClear
                              style={{ width: '100%' }}
                              placeholder="从个人工作台项目中选择"
                              value={draft.project_id ?? undefined}
                              onChange={(v) => update({ project_id: v ?? null })}
                              options={projectOptions}
                              loading={projectsQuery.isLoading}
                            />
                          </Col>
                        </Row>
                        <div>
                          <Text type="secondary" style={{ fontSize: 12 }}>摘要</Text>
                          <Input.TextArea
                            value={draft.abstract}
                            onChange={(e) => update({ abstract: e.target.value })}
                            autoSize={{ minRows: 6, maxRows: 12 }}
                            placeholder="背景、方法、结果与结论"
                          />
                        </div>
                        <div>
                          <Text type="secondary" style={{ fontSize: 12 }}>关键词（分号或逗号分隔）</Text>
                          <Input
                            value={draft.keywords}
                            onChange={(e) => update({ keywords: e.target.value })}
                            placeholder="例如：水稻；抗旱；转录组"
                          />
                        </div>
                        <Card size="small" style={{ background: 'var(--ant-color-fill-quaternary, rgba(0,0,0,0.03))' }}>
                          <Flex gap={8} wrap align="center">
                            <LinkOutlined style={{ color: '#2B5CE6' }} />
                            <Text strong style={{ fontSize: 12.5 }}>与已有功能联动</Text>
                            <Button size="small" icon={<BookOutlined />} onClick={() => navigate('/literature')}>
                              文献与引用
                            </Button>
                            <Button size="small" icon={<FilePdfOutlined />} onClick={() => navigate('/agent?mode=kb')}>
                              知识库
                            </Button>
                            <Button size="small" icon={<TranslationOutlined />} onClick={() => navigate('/translate')}>
                              翻译润色
                            </Button>
                            <Button size="small" icon={<ExperimentOutlined />} onClick={() => navigate('/tools?tool=plot')}>
                              数据绘图
                            </Button>
                          </Flex>
                          <Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
                            在文献中心导出 BibTeX，粘贴到源码的参考文献段落即可引用；图表在科研工具生成后插入
                            <Text code style={{ fontSize: 11.5 }}>\includegraphics</Text>。
                          </Paragraph>
                        </Card>
                      </Flex>
                    ),
                  },
                  {
                    key: 'pdf',
                    label: (
                      <span>
                        <FilePdfOutlined /> PDF 预览
                      </span>
                    ),
                    children: doc?.hasPdf ? (
                      <Flex vertical gap={10}>
                        <Flex justify="space-between" align="center" wrap gap={8}>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            最近编译 {fmtTime(doc.compiledAt)} · {Math.max(1, Math.round(doc.pdfBytes / 1024))} KB
                          </Text>
                          <Flex gap={6}>
                            <Button size="small" icon={<CloudDownloadOutlined />} onClick={() => window.open(api.latexPdfUrl(selectedId, true), '_blank')}>
                              下载
                            </Button>
                            <Button size="small" icon={<SendOutlined />} onClick={() => window.open(pdfUrl, '_blank')}>
                              新窗口打开
                            </Button>
                          </Flex>
                        </Flex>
                        <iframe
                          title="LaTeX PDF 预览"
                          src={pdfUrl}
                          style={{
                            width: '100%',
                            height: 640,
                            border: '1px solid var(--ant-color-border-secondary, #EEF0F4)',
                            borderRadius: 10,
                            background: '#fff',
                          }}
                        />
                      </Flex>
                    ) : (
                      <Empty description="还没有 PDF，先编译一次">
                        <Button type="primary" icon={<PlayCircleOutlined />} loading={compiling} onClick={() => void compileNow()}>
                          编译 PDF
                        </Button>
                      </Empty>
                    ),
                  },
                  {
                    key: 'history',
                    label: (
                      <span>
                        <HistoryOutlined /> 投稿动态
                      </span>
                    ),
                    children: (
                      <Flex vertical gap={12}>
                        <Flex gap={8}>
                          <Input
                            value={eventNote}
                            onChange={(e) => setEventNote(e.target.value)}
                            placeholder="记录一次沟通，例如：编辑部要求补充图 3 的统计检验"
                            onPressEnter={() => void addEvent()}
                          />
                          <Button icon={<PlusOutlined />} onClick={() => void addEvent()} disabled={!eventNote.trim()}>
                            记录
                          </Button>
                        </Flex>
                        {eventsQuery.isLoading ? (
                          <Skeleton active paragraph={{ rows: 4 }} />
                        ) : (eventsQuery.data?.events ?? []).length === 0 ? (
                          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有投稿记录" />
                        ) : (
                          <Timeline
                            items={(eventsQuery.data?.events ?? []).map((e, i) => ({
                              color: e.kind === 'status' ? 'blue' : e.kind === 'compile' ? 'green' : 'gray',
                              children: (
                                <Flex vertical gap={2}>
                                  <Text style={{ fontSize: 12.5 }}>{e.note || e.kind}</Text>
                                  <Text type="secondary" style={{ fontSize: 11.5 }}>
                                    {fmtTime(e.createdAt)} · {i === 0 ? '最近' : ''}
                                  </Text>
                                </Flex>
                              ),
                            }))}
                          />
                        )}
                      </Flex>
                    ),
                  },
                ]}
              />
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
            <Text type="secondary" style={{ fontSize: 12 }}>模板</Text>
            <Radio.Group
              value={newTemplate}
              onChange={(e) => setNewTemplate(e.target.value)}
              style={{ width: '100%' }}
            >
              <Row gutter={[12, 12]} style={{ marginTop: 4 }}>
                {templates.map((t) => (
                  <Col xs={24} md={12} key={t.id}>
                    <Card
                      size="small"
                      hoverable
                      onClick={() => setNewTemplate(t.id)}
                      style={{
                        borderColor: newTemplate === t.id ? 'var(--ant-color-primary, #2B5CE6)' : undefined,
                        height: '100%',
                      }}
                    >
                      <Flex vertical gap={6}>
                        <Flex align="center" gap={8}>
                          <Radio value={t.id} />
                          <Text strong style={{ fontSize: 13 }}>{t.name}</Text>
                        </Flex>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {t.description}
                        </Text>
                      </Flex>
                    </Card>
                  </Col>
                ))}
              </Row>
            </Radio.Group>
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
    </PageShell>
  );
}