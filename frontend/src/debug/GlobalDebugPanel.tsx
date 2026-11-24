/**
 * Global Debug & Preview panel — available on every page, including /login and
 * /start, because it is mounted outside AppLayout (see main.tsx).
 *
 * Four tabs:
 *   概览       backend/go-core/session snapshot + capability flags
 *   服务健康   aggregated from the existing /api/services/health
 *   运行时     client snapshot, error ring buffer, storage/query cache
 *   Preview    bounded derived-only preview of a locally selected file
 *
 * Design rule: diagnostics must never make an outage worse. No polling, no
 * full-catalog fan-out; one bounded snapshot per explicit refresh.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Badge,
  Button,
  Drawer,
  Empty,
  Flex,
  Segmented,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import {
  BugOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  CopyOutlined,
  DeleteOutlined,
  EyeOutlined,
  InboxOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { renderPreview, MAX_INPUT, PreviewError, type PreviewResult } from './previewEngine';
import { clearEvents, counts, getEvents, record, snapshot, type ClientSnapshot, type DebugEvent } from './runtime';

const { Text, Paragraph } = Typography;

interface BackendStatus {
  backend: {
    service: string; version: string; python: string; platform: string;
    uptime_seconds: number; pid: number;
  };
  session: { authenticated: boolean; roles: string[]; is_admin: boolean };
  go_core: { reachable: boolean; latency_ms: number; status: string };
  capabilities: Record<string, boolean>;
  limits: { max_inline_preview_bytes: number };
  server_time: string;
}

interface ServiceHealth {
  id: string; name: string; category: string;
  health?: { status: string; latency_ms?: number | null; detail?: string };
}

const STATUS_META: Record<string, { color: string; label: string }> = {
  up: { color: 'green', label: '正常' },
  down: { color: 'red', label: '不可用' },
  'external-down': { color: 'orange', label: '外部服务不可用' },
  unknown: { color: 'default', label: '未知' },
};

const CAP_LABELS: Record<string, string> = {
  session_secret: '会话密钥',
  database_dsn: '数据库连接',
  health_probes: '健康探测',
  service_token: '内部服务令牌',
  portal_oidc: '门户 OIDC',
  agent_gateway: 'Agent 网关',
  labgo_core: 'Go 核心',
};

const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);

const timeStr = (ts: number) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { credentials: 'include', signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export default function GlobalDebugPanel() {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('overview');
  const [loading, setLoading] = useState(false);
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceHealth[]>([]);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [client, setClient] = useState<ClientSnapshot | null>(null);
  const [eventList, setEventList] = useState<DebugEvent[]>([]);
  const [refreshAt, setRefreshAt] = useState(0);
  const [previewFile, setPreviewFile] = useState<{ name: string; size: number } | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [channel, setChannel] = useState<'local' | 'server'>('local');
  const abortRef = useRef<AbortController | null>(null);

  // 全局入口：快捷键 + 自定义事件（命令面板 / 页面按钮都发这个事件）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    const onPreview = () => { setOpen(true); setTab('preview'); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('d509:debug', onOpen);
    window.addEventListener('d509:preview', onPreview);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('d509:debug', onOpen);
      window.removeEventListener('d509:preview', onPreview);
    };
  }, []);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setBackendError(null);
    setServicesError(null);
    const [b, s] = await Promise.allSettled([
      getJson<BackendStatus>('/api/debug/status', ctrl.signal),
      getJson<{ services: ServiceHealth[] }>('/api/services/health', ctrl.signal),
    ]);
    if (ctrl.signal.aborted) return;
    if (b.status === 'fulfilled') setBackend(b.value);
    else setBackendError(b.reason instanceof Error ? b.reason.message : String(b.reason));
    if (s.status === 'fulfilled') setServices(s.value.services ?? []);
    else setServicesError(s.reason instanceof Error ? s.reason.message : String(s.reason));
    setClient(snapshot());
    setEventList(getEvents());
    setRefreshAt(Date.now());
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open && !client) void refresh();
  }, [open, client, refresh]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const doPreview = useCallback(async (file: File) => {
    setPreviewFile({ name: file.name, size: file.size });
    setPreview(null);
    setPreviewError(null);
    if (file.size > MAX_INPUT) {
      setPreviewError(`文件 ${bytes(file.size)} 超过 8MiB 内联预览上限`);
      return;
    }
    setPreviewBusy(true);
    try {
      if (channel === 'local') {
        const buf = await file.arrayBuffer();
        const result = await renderPreview(file.name, buf);
        setPreview(result);
        record('info', 'panel', `本地预览 ${file.name}`, `${result.kind}/${result.format}`);
      } else {
        // 与 Go core internal/preview 契约对证；文件只在此请求内存在。
        const fd = new FormData();
        fd.append('file', file);
        const csrf = document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=').slice(1).join('=');
        const res = await fetch('/api/debug/preview', {
          method: 'POST', credentials: 'include', body: fd,
          headers: csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {},
        });
        if (!res.ok) throw new Error(`${res.status} ${(await res.json().catch(() => ({})))?.detail ?? ''}`);
        const data = (await res.json()) as { result: Record<string, unknown> };
        setPreview(data.result as unknown as PreviewResult);
        record('info', 'panel', `服务端预览 ${file.name}`, 'derived-only');
      }
    } catch (err) {
      const msg = err instanceof PreviewError ? err.message : err instanceof Error ? err.message : String(err);
      setPreviewError(msg);
      record('error', 'panel', '预览失败', msg);
    } finally {
      setPreviewBusy(false);
    }
  }, [channel]);

  const copyReport = useCallback(async () => {
    const report = {
      collected_at: new Date().toISOString(),
      backend: backend ?? backendError,
      services: services.map((s) => ({ id: s.id, status: s.health?.status, latency_ms: s.health?.latency_ms })),
      client,
      events: eventList.slice(-30),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      void message.success('诊断摘要已复制');
    } catch {
      void message.error('复制失败');
    }
  }, [backend, backendError, services, client, eventList]);

  const c = useMemo(() => counts(), [eventList]);
  const downCount = services.filter((s) => s.health?.status === 'down' || s.health?.status === 'external-down').length;

  const overview = (
    <Flex vertical gap={12}>
      {backendError && <Alert type="warning" title="后端诊断接口不可用" description={backendError} showIcon />}
      {loading && !backend && <Spin description="采集中…" />}
      {backend && (
        <>
          <Flex gap={8} wrap>
            <Tag color={backend.go_core.reachable ? 'green' : 'red'}>
              Go 核心 {backend.go_core.reachable ? `可达 · ${backend.go_core.latency_ms}ms` : '不可达'}
            </Tag>
            <Tag color="blue">{backend.backend.service} v{backend.backend.version}</Tag>
            <Tag>Python {backend.backend.python}</Tag>
            <Tag>运行 {Math.floor(backend.backend.uptime_seconds / 60)} 分钟</Tag>
            <Tag color={backend.session.is_admin ? 'gold' : 'default'}>
              {backend.session.is_admin ? '管理员' : backend.session.roles.join(', ') || '普通用户'}
            </Tag>
          </Flex>
          <div className="d509-debug-grid">
            <div className="d509-debug-kv"><Text type="secondary">服务端时间</Text><Text>{backend.server_time}</Text></div>
            <div className="d509-debug-kv"><Text type="secondary">平台</Text><Text ellipsis>{backend.backend.platform}</Text></div>
            <div className="d509-debug-kv"><Text type="secondary">进程 PID</Text><Text>{backend.backend.pid}</Text></div>
            <div className="d509-debug-kv"><Text type="secondary">预览上限</Text><Text>{bytes(backend.limits.max_inline_preview_bytes)}</Text></div>
          </div>
          <div>
            <Text strong>能力开关</Text>
            <Flex gap={6} wrap style={{ marginTop: 8 }}>
              {Object.entries(backend.capabilities).map(([k, v]) => (
                <Tag key={k} color={v ? 'green' : 'default'} icon={v ? <CheckCircleOutlined /> : undefined}>
                  {CAP_LABELS[k] ?? k}
                </Tag>
              ))}
            </Flex>
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              只显示是否配置，不显示任何配置值、密钥或连接串。
            </Paragraph>
          </div>
        </>
      )}
    </Flex>
  );

  const healthTab = (
    <Flex vertical gap={10}>
      {servicesError && <Alert type="warning" title="服务健康接口不可用" description={servicesError} showIcon />}
      <Space>
        <Tag color="green">正常 {services.filter((s) => s.health?.status === 'up').length}</Tag>
        <Tag color="red">异常 {downCount}</Tag>
        <Tag>总计 {services.length}</Tag>
      </Space>
      <Table<ServiceHealth>
        size="small"
        rowKey="id"
        dataSource={services}
        pagination={false}
        scroll={{ y: 340 }}
        locale={{ emptyText: <Empty description="暂无服务数据" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        columns={[
          { title: '服务', dataIndex: 'name', ellipsis: true },
          { title: '分类', dataIndex: 'category', width: 110, ellipsis: true },
          {
            title: '状态', dataIndex: ['health', 'status'], width: 130,
            render: (v: string) => {
              const m = STATUS_META[v] ?? STATUS_META.unknown;
              return <Tag color={m.color}>{m.label}</Tag>;
            },
          },
          {
            title: '延迟', dataIndex: ['health', 'latency_ms'], width: 90,
            render: (v: number | null) => (v == null ? '-' : `${v} ms`),
          },
          { title: '详情', dataIndex: ['health', 'detail'], ellipsis: true },
        ]}
      />
    </Flex>
  );

  const runtimeTab = (
    <Flex vertical gap={12}>
      {client && (
        <>
          <div className="d509-debug-grid">
            <div className="d509-debug-kv"><Text type="secondary">页面</Text><Text ellipsis>{client.url}</Text></div>
            <div className="d509-debug-kv"><Text type="secondary">视口</Text><Text>{client.viewport.width}×{client.viewport.height} @ {client.viewport.dpr}x</Text></div>
            <div className="d509-debug-kv"><Text type="secondary">主题</Text><Text>{client.themeMode ?? 'auto'} / 系统 {client.resolvedTheme}</Text></div>
            <div className="d509-debug-kv"><Text type="secondary">网络</Text><Text>{client.online ? '在线' : '离线'}{client.connection?.type ? ` · ${client.connection.type}` : ''}</Text></div>
            <div className="d509-debug-kv"><Text type="secondary">安全上下文</Text><Text>{client.secureContext ? '是' : '否'}</Text></div>
            <div className="d509-debug-kv"><Text type="secondary">导航耗时</Text><Text>{client.perf?.navigationMs ?? '-'} ms</Text></div>
            <div className="d509-debug-kv"><Text type="secondary">JS 堆</Text><Text>{client.memory ? `${client.memory.usedMB} / ${client.memory.limitMB} MB` : '不可用'}</Text></div>
            <div className="d509-debug-kv"><Text type="secondary">本地存储</Text><Text>{bytes(client.storage.localBytesEstimate)} · {client.storage.localKeys.length} 键</Text></div>
          </div>
          <div>
            <Text strong>浏览器能力</Text>
            <Flex gap={6} wrap style={{ marginTop: 8 }}>
              {Object.entries(client.featureFlags).map(([k, v]) => (
                <Tag key={k} color={v ? 'green' : 'default'}>{k}</Tag>
              ))}
            </Flex>
          </div>
          <div>
            <Text strong>本地存储键</Text>
            <Flex gap={6} wrap style={{ marginTop: 8 }}>
              {client.storage.localKeys.length ? client.storage.localKeys.map((k) => <Tag key={k}>{k}</Tag>) : <Text type="secondary">无</Text>}
            </Flex>
          </div>
        </>
      )}
      <div>
        <Flex justify="space-between" align="center">
          <Text strong>运行时事件 <Text type="secondary">（错误 {c.errors} / 警告 {c.warns} / 共 {c.total}）</Text></Text>
          <Button
            size="small" icon={<DeleteOutlined />}
            onClick={() => { clearEvents(); setEventList(getEvents()); }}
          >清空</Button>
        </Flex>
        <Table<DebugEvent>
          size="small"
          rowKey="id"
          dataSource={[...eventList].reverse()}
          pagination={{ pageSize: 8, size: 'small' }}
          style={{ marginTop: 8 }}
          locale={{ emptyText: <Empty description="暂无错误或警告" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          columns={[
            { title: '时间', dataIndex: 'at', width: 90, render: (v: number) => <Text style={{ fontSize: 11 }}>{timeStr(v)}</Text> },
            {
              title: '级别', dataIndex: 'level', width: 78,
              render: (v: string) => <Tag color={v === 'error' ? 'red' : v === 'warn' ? 'orange' : 'blue'}>{v}</Tag>,
            },
            { title: '来源', dataIndex: 'source', width: 110 },
            { title: '消息', dataIndex: 'message', ellipsis: true, render: (v: string, r) => (
              <Tooltip title={r.detail}><span>{v}</span></Tooltip>
            ) },
          ]}
        />
        <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
          仅保留最近 200 条；URL 查询串、请求头、Cookie、响应体均不记录。
        </Paragraph>
      </div>
    </Flex>
  );

  const previewTab = (
    <Flex vertical gap={12}>
      <Alert
        type="info" showIcon
        title="文件只在浏览器内存里解析，不上传、不回显原始字节"
        description="仅返回有界派生结果（最多 20 行 / 2048 字符）。Office 只抽取文本，图片只读尺寸；PDF/BAM 需隔离 Worker，不在此透传。"
      />
      <Flex gap={8} align="center" wrap>
        <Text type="secondary">渲染通道</Text>
        <Segmented
          size="small"
          value={channel}
          onChange={(v) => setChannel(v as 'local' | 'server')}
          options={[
            { label: '本地（默认）', value: 'local' },
            { label: '服务端对证', value: 'server' },
          ]}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {channel === 'local' ? '零网络请求，无需登录' : 'POST /api/debug/preview（需登录 + CSRF），与服务端契约对证'}
        </Text>
      </Flex>
      <Upload.Dragger
        accept=".fa,.fna,.faa,.fasta,.fq,.fastq,.sam,.gff,.gff3,.gtf,.vcf,.bed,.csv,.tsv,.txt,.md,.log,.json,.yaml,.yml,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.gif,.webp,.bmp,.gz,.pdf,.bam,.bw,.bigwig"
        maxCount={1}
        beforeUpload={(file) => { void doPreview(file as File); return false; }}
        showUploadList={false}
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">点击或拖入文件预览</p>
        <p className="ant-upload-hint">支持 FASTA/FASTQ/SAM、VCF/GFF/CSV、文本、Office、图片元数据（含 .gz）</p>
      </Upload.Dragger>

      {previewBusy && <Spin description="解析中…" />}
      {previewError && <Alert type="error" showIcon title="预览失败" description={previewError} />}
      {preview && previewFile && (
        <Flex vertical gap={10}>
          <Flex gap={8} wrap align="center">
            <Tag color="blue">{preview.kind}</Tag>
            <Tag>{preview.format || '未知格式'}</Tag>
            <Tag>{previewFile.name}</Tag>
            <Tag>{bytes(previewFile.size)}</Tag>
            {preview.truncated && <Tag color="orange" icon={<WarningOutlined />}>已截断</Tag>}
          </Flex>
          {preview.notice && <Alert type="warning" showIcon title={preview.notice} />}
          {preview.text !== undefined && (
            <pre className="d509-debug-pre">{preview.text || '（无可见文本）'}</pre>
          )}
          {preview.rows && preview.rows.length > 0 && (
            <Table
              size="small" rowKey={(_, i) => String(i)} dataSource={preview.rows}
              pagination={false} scroll={{ x: true, y: 260 }}
              columns={preview.rows[0].map((_, i) => ({
                title: `列 ${i + 1}`, dataIndex: i, ellipsis: true,
                render: (v: string) => v,
              }))}
            />
          )}
          {preview.records && preview.records.length > 0 && (
            <Table
              size="small" rowKey={(_, i) => String(i)} dataSource={preview.records}
              pagination={false} scroll={{ x: true, y: 260 }}
              columns={Object.keys(preview.records[0]).map((k) => ({ title: k, dataIndex: k, ellipsis: true }))}
            />
          )}
          {preview.kind === 'unsupported' && <Empty description="该格式未纳入允许的预览器" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          <Text type="secondary" style={{ fontSize: 12 }}>
            已检视 {bytes(preview.bytesExamined ?? 0)}
            {preview.recordsSeen !== undefined ? ` · 共 ${preview.recordsSeen} 条记录` : ''}
          </Text>
        </Flex>
      )}
    </Flex>
  );

  return (
    <>
      <button
        type="button"
        className="d509-debug-fab"
        aria-label="打开全局 Debug 与 Preview 面板"
        title="全局 Debug / Preview（⌘⇧D）"
        onClick={() => setOpen(true)}
      >
        <BugOutlined />
        {c.errors > 0 && <span className="d509-debug-fab-dot" title={`${c.errors} 条运行时错误`} />}
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        size={Math.min(840, window.innerWidth - 24)}
        title={
          <Flex gap={10} align="center">
            <BugOutlined />
            <span>全局 Debug & Preview</span>
            <Tag color={downCount ? 'red' : 'green'}>{downCount ? `${downCount} 项服务异常` : '服务正常'}</Tag>
          </Flex>
        }
        extra={
          <Space>
            <Tooltip title="复制脱敏诊断摘要">
              <Button size="small" icon={<CopyOutlined />} onClick={() => void copyReport()} />
            </Tooltip>
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()}>刷新</Button>
          </Space>
        }
        styles={{ body: { paddingTop: 8 } }}
      >
        <Flex vertical gap={6} style={{ marginBottom: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            上次采集 {refreshAt ? timeStr(refreshAt) : '—'} · ⌘⇧D / Ctrl⇧D 开关 · 命令面板可直达
          </Text>
        </Flex>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            { key: 'overview', label: <Space size={6}><CloudServerOutlined />概览</Space>, children: overview },
            { key: 'health', label: <Space size={6}><CheckCircleOutlined />服务健康</Space>, children: healthTab },
            { key: 'runtime', label: <Space size={6}><WarningOutlined />运行时{c.errors ? <Badge count={c.errors} size="small" /> : null}</Space>, children: runtimeTab },
            { key: 'preview', label: <Space size={6}><EyeOutlined />Preview</Space>, children: previewTab },
          ]}
        />
      </Drawer>
    </>
  );
}
