import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { currentHost, hostUrl } from '../utils/host';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
  Empty,
  Flex,
  Input,
  Row,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
  Upload,
  theme,
} from 'antd';
import type { UploadProps } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  CustomerServiceOutlined,
  DownloadOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  LoadingOutlined,
  PictureOutlined,
  ReloadOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import PageShell from '../components/PageShell';
import { readCookie } from '../services/api';
import { SECTION_META, toolMeta } from './snapotterCatalog';

interface SoTool {
  section: string;
  id: string;
  name: string;
  description: string;
  icon?: string;
  accept?: string;
  settingsHint?: string;
}

interface SoStatus {
  configured: boolean;
  up: boolean;
  detail: string;
  toolCount: number;
  baseUrl: string;
}

interface RecentRef {
  section: string;
  id: string;
}

const SECTION_ORDER = ['image', 'pdf', 'files', 'video', 'audio'];
const RECENT_KEY = 'd509.snapotter.recent';

const SECTION_ICON: Record<string, ReactNode> = {
  image: <PictureOutlined />,
  pdf: <FilePdfOutlined />,
  files: <FileTextOutlined />,
  video: <VideoCameraOutlined />,
  audio: <CustomerServiceOutlined />,
};

const QUICK_PICKS = [
  'image/compress',
  'image/remove-background',
  'image/ocr',
  'pdf/merge-pdf',
  'pdf/pdf-to-word',
  'files/word-to-pdf',
  'video/video-to-gif',
  'audio/mp3-to-wav',
];

function sectionMeta(key: string) {
  return SECTION_META[key] ?? { label: key || '通用工具', hint: '', color: '#2B5CE6' };
}

function toolIcon(tool: SoTool) {
  if (tool.id.includes('-to-')) return <SwapOutlined />;
  return SECTION_ICON[tool.section] ?? <ThunderboltOutlined />;
}

function formatBytes(bytes?: number) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function readRecent(): RecentRef[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter((x) => x && typeof x.section === 'string' && typeof x.id === 'string').slice(0, 8);
  } catch {
    return [];
  }
}

/** 门户原生调用 SnapOtter REST API（不使用 iframe） */
export default function SnapOtter() {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const [params, setParams] = useSearchParams();
  const [keyword, setKeyword] = useState('');
  const [section, setSection] = useState<string>('all');
  const [active, setActive] = useState<SoTool | null>(null);
  const [settings, setSettings] = useState('{}');
  const [advOpen, setAdvOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [recent, setRecent] = useState<RecentRef[]>(readRecent);
  const firstSync = useRef(true);

  const { data: status } = useQuery({
    queryKey: ['so-status'],
    queryFn: async () => {
      const r = await fetch('/api/snapotter/status', { credentials: 'include' });
      if (!r.ok) throw new Error('状态不可用');
      return (await r.json()) as SoStatus;
    },
    staleTime: 30_000,
    retry: false,
  });

  const {
    data: toolData,
    isLoading: toolsLoading,
    refetch,
  } = useQuery({
    queryKey: ['so-tools'],
    queryFn: async () => {
      const r = await fetch('/api/snapotter/tools', { credentials: 'include' });
      if (!r.ok) throw new Error('工具目录不可用');
      return (await r.json()) as { tools: SoTool[] };
    },
    staleTime: 300_000,
    retry: false,
  });

  const tools = useMemo(() => toolData?.tools ?? [], [toolData]);
  const toolIndex = useMemo(
    () => new Map(tools.map((t) => [`${t.section}/${t.id}`, t])),
    [tools],
  );
  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    tools.forEach((t) => {
      map[t.section] = (map[t.section] ?? 0) + 1;
    });
    return map;
  }, [tools]);

  // 来自统一语料的深链接：/snapotter?section=image&tool=resize
  useEffect(() => {
    const s = params.get('section');
    const t = params.get('tool');
    if (!t || !tools.length) return;
    const hit = tools.find((x) => x.id === t && (!s || x.section === s));
    if (!hit) return;
    setActive(hit);
    setFile(null);
    setResult(null);
    setAdvOpen(Boolean(hit.settingsHint));
    if (firstSync.current) {
      if (s) setSection(s);
      firstSync.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, tools]);

  const grouped = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const filtered = tools.filter((t) => {
      if (section !== 'all' && t.section !== section) return false;
      if (!kw) return true;
      const meta = toolMeta(t.section, t.id, t.name, t.description);
      return (
        meta.name.toLowerCase().includes(kw) ||
        meta.desc.toLowerCase().includes(kw) ||
        t.name.toLowerCase().includes(kw) ||
        t.description.toLowerCase().includes(kw) ||
        t.id.toLowerCase().includes(kw)
      );
    });
    const map = new Map<string, SoTool[]>();
    filtered.forEach((t) => {
      const list = map.get(t.section) ?? [];
      list.push(t);
      map.set(t.section, list);
    });
    return [...map.entries()].sort((a, b) => {
      const ia = SECTION_ORDER.indexOf(a[0]);
      const ib = SECTION_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [tools, keyword, section]);

  const filteredCount = useMemo(
    () => grouped.reduce((sum, [, list]) => sum + list.length, 0),
    [grouped],
  );

  const selectTool = (tool: SoTool) => {
    setActive(tool);
    setFile(null);
    setResult(null);
    setSettings('{}');
    setAdvOpen(Boolean(tool.settingsHint));
    const next = new URLSearchParams(params);
    next.set('section', tool.section);
    next.set('tool', tool.id);
    setParams(next, { replace: true });
  };

  const setSectionFilter = (value: string) => {
    setSection(value);
    const next = new URLSearchParams(params);
    next.delete('tool');
    if (value === 'all') next.delete('section');
    else next.set('section', value);
    setParams(next, { replace: true });
  };

  const rememberRecent = (tool: SoTool) => {
    const next = [{ section: tool.section, id: tool.id }, ...recent.filter((x) => !(x.section === tool.section && x.id === tool.id))].slice(0, 8);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* 本地存储不可用时忽略 */
    }
  };

  const uploadProps: UploadProps = {
    accept: active?.accept || undefined,
    maxCount: 1,
    beforeUpload: (f) => {
      if (f.size > 200 * 1024 * 1024) {
        message.warning('文件超过 200 MB 上限');
        return Upload.LIST_IGNORE;
      }
      setFile(f as unknown as File);
      setResult(null);
      return false;
    },
    onRemove: () => {
      setFile(null);
      setResult(null);
    },
  };

  const run = async () => {
    if (!active || !file) {
      message.warning('请先选择工具并上传文件');
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('settings_json', settings || '{}');
      const csrf = readCookie('labspace_csrf');
      const r = await fetch(
        `/api/snapotter/run?section=${encodeURIComponent(active.section)}&tool_id=${encodeURIComponent(active.id)}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: csrf ? { 'X-CSRF-Token': csrf } : undefined,
          body: fd,
        },
      );
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.detail || `HTTP ${r.status}`);
      setResult(body);
      rememberRecent(active);
      message.success('处理完成');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '处理失败');
    } finally {
      setRunning(false);
    }
  };

  const activeMeta = active ? toolMeta(active.section, active.id, active.name, active.description) : null;
  const downloadUrl =
    (result?.downloadUrl as string | undefined) ??
    (result?.outputUrl as string | undefined) ??
    (result?.url as string | undefined) ??
    '';
  const jobId = (result?.jobId as string | undefined) ?? (result?.job_id as string | undefined) ?? '';
  const originalSize = result?.originalSize as number | undefined;
  const processedSize = result?.processedSize as number | undefined;

  const extra = (
    <Space size={8} wrap>
      {status ? (
        <Tag
          color={status.up ? 'success' : 'error'}
          icon={status.up ? <CheckCircleOutlined /> : undefined}
        >
          {status.up ? `服务在线 · ${status.toolCount} 个工具` : `服务离线 · ${status.detail}`}
        </Tag>
      ) : (
        <Tag>检测中</Tag>
      )}
      <Button size="small" icon={<ReloadOutlined />} onClick={() => refetch()}>
        刷新目录
      </Button>
      <Button
        size="small"
        icon={<ThunderboltOutlined />}
        href={hostUrl('/', 8092)}
        target="_blank"
        rel="noreferrer"
      >
        官方界面
      </Button>
    </Space>
  );

  return (
    <PageShell
      title="文件工坊"
      description="图片、PDF、文档、音视频的一站式内网处理；上传的文件只在本实验室服务器内流转，处理后可直接下载。"
      extra={extra}
    >
      {status && !status.up && (
        <Alert
          type="warning"
          showIcon
          title="文件处理服务当前不可用"
          description={`门户后端连不上 ${status.baseUrl}（${status.detail}）。请在 ${currentHost()} 上检查 lab-snapotter 容器状态。`}
        />
      )}

      <div className="so-section-grid">
        {SECTION_ORDER.map((key) => {
          const meta = sectionMeta(key);
          const on = section === key;
          return (
            <button
              key={key}
              type="button"
              className={`so-section-card${on ? ' is-active' : ''}`}
              style={{ color: meta.color }}
              onClick={() => setSectionFilter(on ? 'all' : key)}
            >
              <span
                className="so-section-icon"
                style={{ background: `${meta.color}14`, color: meta.color }}
              >
                {SECTION_ICON[key] ?? <ThunderboltOutlined />}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <Flex justify="space-between" align="baseline" gap={6}>
                  <Typography.Text strong style={{ fontSize: 14 }}>
                    {meta.label}
                  </Typography.Text>
                  <Typography.Text style={{ fontSize: 12, color: meta.color, fontVariantNumeric: 'tabular-nums' }}>
                    {counts[key] ?? 0}
                  </Typography.Text>
                </Flex>
                <Typography.Text
                  type="secondary"
                  ellipsis
                  style={{ fontSize: 11.5, display: 'block' }}
                >
                  {meta.hint}
                </Typography.Text>
              </span>
            </button>
          );
        })}
      </div>

      <Card size="small" styles={{ body: { padding: 12 } }}>
        <Flex gap={12} wrap align="center">
          <Input.Search
            allowClear
            placeholder="搜索工具，如 压缩 / 抠图 / 转 PDF / 抽帧 / 降噪"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ maxWidth: 420, flex: '1 1 260px' }}
          />
          <Segmented
            size="small"
            value={section}
            onChange={(v) => setSectionFilter(String(v))}
            options={[
              { value: 'all', label: `全部 ${tools.length}` },
              ...SECTION_ORDER.filter((s) => counts[s]).map((s) => ({
                value: s,
                label: `${sectionMeta(s).label} ${counts[s]}`,
              })),
            ]}
          />
        </Flex>
        {recent.length > 0 && (
          <Flex gap={6} wrap align="center" style={{ marginTop: 10 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              最近使用
            </Typography.Text>
            {recent.map((ref) => {
              const tool = toolIndex.get(`${ref.section}/${ref.id}`);
              if (!tool) return null;
              const meta = toolMeta(tool.section, tool.id, tool.name, tool.description);
              return (
                <Tag
                  key={`${ref.section}/${ref.id}`}
                  style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                  color={active?.section === tool.section && active?.id === tool.id ? 'processing' : undefined}
                  onClick={() => selectTool(tool)}
                >
                  {meta.name}
                </Tag>
              );
            })}
            <Button
              type="link"
              size="small"
              style={{ paddingInline: 4 }}
              onClick={() => {
                setRecent([]);
                try {
                  localStorage.removeItem(RECENT_KEY);
                } catch {
                  /* ignore */
                }
              }}
            >
              清空
            </Button>
          </Flex>
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <Card
            size="small"
            title={
              <Space size={6}>
                <span>工具目录</span>
                <Tag variant="filled" style={{ fontSize: 11 }}>
                  {section === 'all' ? '全部' : sectionMeta(section).label}
                </Tag>
              </Space>
            }
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {filteredCount} 个
              </Typography.Text>
            }
          >
            {toolsLoading ? (
              <Flex justify="center" style={{ padding: 48 }}>
                <Spin />
              </Flex>
            ) : filteredCount === 0 ? (
              <Empty
                description={keyword ? '没有匹配的工具，换个关键词试试' : '暂无可用工具'}
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            ) : (
              <div className="so-catalog-scroll">
                {grouped.map(([sec, list]) => {
                  const meta = sectionMeta(sec);
                  return (
                    <div key={sec} style={{ marginBottom: 10 }}>
                      <div className="so-group-title">
                        <span style={{ color: meta.color, marginRight: 6 }}>●</span>
                        {meta.label} · {list.length}
                      </div>
                      {list.map((t) => {
                        const zh = toolMeta(t.section, t.id, t.name, t.description);
                        const on = active?.section === t.section && active?.id === t.id;
                        return (
                          <button
                            key={`${t.section}/${t.id}`}
                            type="button"
                            className={`so-tool-item${on ? ' is-active' : ''}`}
                            onClick={() => selectTool(t)}
                          >
                            <span
                              style={{
                                color: on ? token.colorPrimary : token.colorTextTertiary,
                                fontSize: 15,
                                marginTop: 1,
                              }}
                            >
                              {toolIcon(t)}
                            </span>
                            <span className="so-tool-item-body">
                              <span className="so-tool-item-name">{zh.name}</span>
                              <span className="so-tool-item-desc">{zh.desc || t.description}</span>
                            </span>
                            {on && <Tag color="processing" style={{ marginInlineEnd: 0, fontSize: 11 }}>已选</Tag>}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={14}>
          <Card
            size="small"
            title={
              active ? (
                <Space size={8} wrap>
                  <span>{activeMeta?.name}</span>
                  <Tag color={sectionMeta(active.section).color} style={{ marginInlineEnd: 0 }}>
                    {sectionMeta(active.section).label}
                  </Tag>
                </Space>
              ) : (
                '选择一个工具'
              )
            }
            extra={
              active && (
                <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                  {active.id}
                </Typography.Text>
              )
            }
          >
            {!active ? (
              <Flex vertical gap={16} style={{ padding: '12px 0 4px' }}>
                <Empty
                  description="从左侧目录选择工具；也可以从下面的常用工具开始"
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                />
                <Flex gap={8} wrap justify="center">
                  {QUICK_PICKS.map((key) => {
                    const tool = toolIndex.get(key);
                    if (!tool) return null;
                    const zh = toolMeta(tool.section, tool.id, tool.name, tool.description);
                    return (
                      <Button key={key} size="small" onClick={() => selectTool(tool)}>
                        {zh.name}
                      </Button>
                    );
                  })}
                </Flex>
              </Flex>
            ) : (
              <Flex vertical gap={14}>
                <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
                  {activeMeta?.desc || active.description || sectionMeta(active.section).hint}
                </Typography.Paragraph>

                <Upload.Dragger {...uploadProps} disabled={running}>
                  <p className="ant-upload-drag-icon">
                    <CloudUploadOutlined />
                  </p>
                  <p className="ant-upload-text">点击或拖拽文件到此处</p>
                  <p className="ant-upload-hint">
                    {file
                      ? `已选择：${file.name}（${formatBytes(file.size)}）`
                      : `单个文件，最大 200 MB${active.accept ? `；支持 ${active.accept}` : ''}`}
                  </p>
                </Upload.Dragger>

                <Collapse
                  ghost
                  size="small"
                  activeKey={advOpen ? ['advanced'] : []}
                  onChange={(keys) => setAdvOpen((Array.isArray(keys) ? keys : [keys]).includes('advanced'))}
                  items={[
                    {
                      key: 'advanced',
                      label: (
                        <Space size={6}>
                          <span>高级设置</span>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {active.settingsHint ? '该工具支持参数，建议按提示填写' : '可选，参数以 JSON 传给工具'}
                          </Typography.Text>
                        </Space>
                      ),
                      children: (
                        <Flex vertical gap={8}>
                          {active.settingsHint && (
                            <Alert
                              type="info"
                              showIcon
                              message="可用参数"
                              description={
                                <div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.7 }}>
                                  {active.settingsHint}
                                </div>
                              }
                            />
                          )}
                          <Input.TextArea
                            rows={4}
                            value={settings}
                            onChange={(e) => setSettings(e.target.value)}
                            placeholder='例如 {"quality": 90}；留空则使用默认参数'
                            style={{
                              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                              fontSize: 12.5,
                            }}
                          />
                        </Flex>
                      ),
                    },
                  ]}
                />

                <Flex gap={10} wrap>
                  <Button
                    type="primary"
                    icon={running ? <LoadingOutlined /> : <ThunderboltOutlined />}
                    onClick={run}
                    loading={running}
                    disabled={!file}
                    style={{ minWidth: 140 }}
                  >
                    {running ? '处理中' : '开始处理'}
                  </Button>
                  {file && (
                    <Button
                      onClick={() => {
                        setFile(null);
                        setResult(null);
                      }}
                      disabled={running}
                    >
                      清空文件
                    </Button>
                  )}
                </Flex>

                {result && (
                  <Card
                    size="small"
                    title={
                      <Space size={6}>
                        <CheckCircleOutlined style={{ color: token.colorSuccess }} />
                        <span>处理完成</span>
                      </Space>
                    }
                    extra={<Tag color="success">可下载</Tag>}
                    style={{ borderColor: `${token.colorSuccess}55`, background: `${token.colorSuccess}08` }}
                  >
                    <div className="so-result-grid">
                      <div className="so-result-stat">
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          原始大小
                        </Typography.Text>
                        <div style={{ fontSize: 16, fontWeight: 600 }}>{formatBytes(originalSize)}</div>
                      </div>
                      <div className="so-result-stat">
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          输出大小
                        </Typography.Text>
                        <div style={{ fontSize: 16, fontWeight: 600 }}>{formatBytes(processedSize)}</div>
                      </div>
                      <div className="so-result-stat">
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          体积变化
                        </Typography.Text>
                        <div style={{ fontSize: 16, fontWeight: 600 }}>
                          {typeof originalSize === 'number' && typeof processedSize === 'number' && originalSize > 0
                            ? `${processedSize >= originalSize ? '+' : ''}${(
                                ((processedSize - originalSize) / originalSize) *
                                100
                              ).toFixed(1)}%`
                            : '-'}
                        </div>
                      </div>
                    </div>
                    {jobId && (
                      <Flex gap={6} align="center" style={{ marginTop: 10 }}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          任务 ID
                        </Typography.Text>
                        <Typography.Text code copyable style={{ fontSize: 12 }}>
                          {jobId}
                        </Typography.Text>
                      </Flex>
                    )}
                    <Flex gap={10} wrap style={{ marginTop: 12 }}>
                      <Button
                        type="primary"
                        icon={<DownloadOutlined />}
                        disabled={!downloadUrl}
                        onClick={() => {
                          window.open(
                            `/api/snapotter/download?url=${encodeURIComponent(downloadUrl)}`,
                            '_blank',
                          );
                        }}
                      >
                        下载结果
                      </Button>
                      <Button
                        onClick={() => {
                          setFile(null);
                          setResult(null);
                        }}
                      >
                        再处理一个
                      </Button>
                    </Flex>
                  </Card>
                )}
              </Flex>
            )}
          </Card>
        </Col>
      </Row>
    </PageShell>
  );
}