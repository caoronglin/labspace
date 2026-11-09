import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Badge, Button, Descriptions, Drawer, Empty, Flex, Image, Input, InputNumber,
  Modal, Segmented, Select, Space, Spin, Table, Tag, Typography, Upload, message,
} from 'antd';
import {
  BarChartOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined,
  FileTextOutlined, FolderOpenOutlined, PlayCircleOutlined, ReloadOutlined, StopOutlined,
  CodeOutlined, BgColorsOutlined, DatabaseOutlined,
} from '@ant-design/icons';
import { Box, Column, Heatmap, Line, Scatter } from '@ant-design/plots';
import PageShell from '../components/PageShell';
import {
  plotApi, type PlotChart, type PlotJob, type PlotParamSpec, type PlotSample,
} from '../services/api';

const STATUS_META: Record<PlotJob['status'], { color: string; text: string }> = {
  queued: { color: 'default', text: '排队中' },
  running: { color: 'processing', text: '渲染中' },
  succeeded: { color: 'success', text: '已完成' },
  failed: { color: 'error', text: '失败' },
  cancelled: { color: 'warning', text: '已取消' },
};

function parseTable(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const raw = text.replace(/^\uFEFF/, '');
  if (!raw.trim()) return { headers: [], rows: [] };
  const first = raw.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = first.includes('\t') && !first.includes(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quoted) {
      if (ch === '"' && raw[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  const objects = rows
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, idx) => [h, (r[idx] ?? '').trim()])));
  return { headers, rows: objects };
}

function toNumber(value: unknown): number {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function formatTime(value: number): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export default function PlotStudio({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const [chartId, setChartId] = useState('bar');
  const [title, setTitle] = useState('未命名图');
  const [dataText, setDataText] = useState('');
  const [sampleId, setSampleId] = useState<string>();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [palette, setPalette] = useState('npg');
  const [width, setWidth] = useState(7.2);
  const [height, setHeight] = useState(4.8);
  const [customColors, setCustomColors] = useState<string[]>([]);
  const [jobId, setJobId] = useState<string>();
  const [tab, setTab] = useState('preview');
  const [logOpen, setLogOpen] = useState(false);
  const [logText, setLogText] = useState('');
  const [apiOpen, setApiOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);

  const metaQ = useQuery({ queryKey: ['plot-meta'], queryFn: plotApi.meta, staleTime: 5 * 60_000 });
  const historyQ = useQuery({ queryKey: ['plot-jobs'], queryFn: plotApi.jobs, refetchInterval: 30_000 });
  const jobQ = useQuery({
    queryKey: ['plot-job', jobId],
    queryFn: () => plotApi.job(jobId as string),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' ? 1_500 : false;
    },
  });

  const charts = metaQ.data?.charts ?? [];
  const samples = metaQ.data?.samples ?? [];
  const chart = useMemo(() => charts.find((c) => c.id === chartId), [charts, chartId]);
  const currentJob = jobQ.data;

  // 从「配色搭配」带色板过来：/plot?colors=%23hex,%23hex
  useEffect(() => {
    const raw = params.get('colors');
    if (raw) {
      const list = raw.split(',').map((c) => c.trim()).filter((c) => /^#[0-9a-fA-F]{3,8}$/.test(c));
      if (list.length) {
        setCustomColors(list);
        message.info(`已载入配色搭配中的 ${list.length} 个颜色`);
      }
    }
    const p = params.get('palette');
    if (p) setPalette(p);
  }, [params]);

  useEffect(() => {
    const initial = samples.find((s) => s.chart === 'bar');
    if (initial && !dataText) loadSample(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples.length]);

  function defaultParams(next?: PlotChart) {
    if (!next) return {};
    const table = parseTable(dataText);
    const init: Record<string, unknown> = {};
    next.params.forEach((spec) => {
      if (spec.type === 'checkbox') init[spec.key] = false;
      else if (spec.type === 'number') init[spec.key] = undefined;
      else if (spec.type === 'select') init[spec.key] = spec.options?.[0];
      else init[spec.key] = table.headers.includes(spec.key) ? spec.key : undefined;
    });
    return init;
  }

  function pickChart(id: string) {
    setChartId(id);
    const next = charts.find((c) => c.id === id);
    setValues(defaultParams(next));
    setSampleId(undefined);
  }

  function loadSample(sample: PlotSample) {
    setSampleId(sample.id);
    setChartId(sample.chart);
    setTitle(sample.name);
    setDataText(sample.data ?? '');
    const next = charts.find((c) => c.id === sample.chart);
    const init: Record<string, unknown> = {};
    next?.params.forEach((spec) => {
      if (spec.type === 'checkbox') init[spec.key] = false;
      else if (spec.type === 'number') init[spec.key] = undefined;
      else if (spec.type === 'select') init[spec.key] = spec.options?.[0];
    });
    setValues({ ...init, ...(sample.params ?? {}) });
    setTab('preview');
  }

  function setValue(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function payloadParams() {
    const clean: Record<string, unknown> = {};
    Object.entries(values).forEach(([k, v]) => {
      if (v === undefined || v === '' || v === null) return;
      clean[k] = v;
    });
    clean.palette = palette;
    clean.width = width;
    clean.height = height;
    if (customColors.length) clean.colors = customColors;
    return clean;
  }

  const createM = useMutation({
    mutationFn: () =>
      plotApi.create({
        title: title.trim() || '未命名图',
        chart: chartId,
        data: dataText,
        sample: sampleId,
        params: payloadParams(),
      }),
    onSuccess: (job) => {
      setJobId(job.id);
      setTab('server');
      message.success('任务已提交，正在渲染');
      queryClient.invalidateQueries({ queryKey: ['plot-jobs'] });
    },
    onError: (err: Error) => message.error(`提交失败：${err.message}`),
  });

  const cancelM = useMutation({
    mutationFn: () => plotApi.cancel(jobId as string),
    onSuccess: () => {
      message.info('已取消任务');
      queryClient.invalidateQueries({ queryKey: ['plot-job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['plot-jobs'] });
    },
  });

  const removeM = useMutation({
    mutationFn: (id: string) => plotApi.remove(id),
    onSuccess: (_, id) => {
      if (id === jobId) setJobId(undefined);
      message.success('已删除');
      queryClient.invalidateQueries({ queryKey: ['plot-jobs'] });
    },
    onError: (err: Error) => message.error(`删除失败：${err.message}`),
  });

  const table = useMemo(() => parseTable(dataText), [dataText]);
  const preview = useMemo(() => buildPreview(chartId, table, values), [chartId, table, values]);
  const busy = currentJob?.status === 'queued' || currentJob?.status === 'running';
  const png = currentJob?.outputs.find((o) => o.path.endsWith('.png'));

  async function openLog(id: string) {
    setLogOpen(true);
    setLogText('加载中…');
    try {
      setLogText((await plotApi.log(id)) || '（日志为空）');
    } catch (err) {
      setLogText(`读取日志失败：${(err as Error).message}`);
    }
  }

  function useJob(job: PlotJob) {
    setJobId(job.id);
    setTab('server');
  }

  const chartOptions = useMemo(() => {
    const groups = new Map<string, PlotChart[]>();
    charts.forEach((c) => {
      const list = groups.get(c.group) ?? [];
      list.push(c);
      groups.set(c.group, list);
    });
    return [...groups.entries()].map(([label, list]) => ({
      label,
      options: list.map((c) => ({ value: c.id, label: `${c.name} · ${c.library}` })),
    }));
  }, [charts]);

  return (
    <PageShell
      embedded={embedded}
      title="绘图工作台"
      description="模板化科研绘图：浏览器内用 AntV 预览，Go 核心调度 Python 渲染出版级 PNG / SVG / PDF。"
      extra={(
        <Space wrap>
          <Button size="small" icon={<BgColorsOutlined />} onClick={() => navigate('/colors')}>配色搭配</Button>
          <Button size="small" icon={<DatabaseOutlined />} onClick={() => navigate('/tools?tool=genomes')}>公共基因组</Button>
          <Button size="small" icon={<FolderOpenOutlined />} onClick={() => navigate('/files')}>文件管理</Button>
          <Button size="small" icon={<CodeOutlined />} onClick={() => setApiOpen(true)}>Agent 调用</Button>
        </Space>
      )}
    >
      {metaQ.data && !metaQ.data.libraries.ok && (
        <Alert
          type="warning"
          showIcon
          title="渲染环境不完整"
          description={metaQ.data.libraries.error || 'Python 绘图库缺失，部分图表可能不可用。'}
        />
      )}

      <Flex vertical gap={12}>
        <Flex
          gap={8}
          wrap
          align="center"
          style={{
            padding: '8px 10px',
            border: '1px solid var(--d509-border-soft)',
            borderRadius: 12,
            background: 'var(--ant-color-bg-container, #fff)',
          }}
        >
          <Input
            variant="borderless"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="图表标题"
            maxLength={80}
            style={{ flex: '1 1 180px', minWidth: 160, paddingInline: 6, fontWeight: 600, fontSize: 15 }}
          />
          <Select
            value={chartId}
            onChange={pickChart}
            options={chartOptions}
            style={{ width: 230 }}
            popupMatchSelectWidth={340}
            aria-label="图表模板"
          />
          <Button icon={<DatabaseOutlined />} onClick={() => setDataOpen(true)}>
            数据{table.rows.length ? ` · ${table.rows.length} 行` : ''}
          </Button>
          <Button icon={<BgColorsOutlined />} onClick={() => setStyleOpen(true)}>样式</Button>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={createM.isPending}
            onClick={() => createM.mutate()}
          >
            渲染并保存
          </Button>
          {busy && (
            <Button danger icon={<StopOutlined />} loading={cancelM.isPending} onClick={() => cancelM.mutate()}>
              取消
            </Button>
          )}
        </Flex>

        <Flex
          vertical
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 520,
            border: '1px solid var(--d509-border-soft)',
            borderRadius: 12,
            background: 'var(--ant-color-bg-container, #fff)',
            overflow: 'hidden',
          }}
        >
          <Flex
            gap={8}
            wrap
            align="center"
            justify="space-between"
            style={{ padding: '8px 12px', borderBottom: '1px solid var(--d509-border-soft)' }}
          >
            <Segmented
              size="small"
              value={tab}
              onChange={(v) => setTab(String(v))}
              options={[
                { value: 'preview', label: '实时预览' },
                { value: 'server', label: '成品' },
                { value: 'history', label: `历史${historyQ.data?.items.length ? ` ${historyQ.data.items.length}` : ''}` },
              ]}
            />
            <Space size={6} wrap>
              {currentJob && (
                <Badge status={STATUS_META[currentJob.status].color as never} text={STATUS_META[currentJob.status].text} />
              )}
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => {
                  if (tab === 'history') void historyQ.refetch();
                  else if (jobId) void queryClient.invalidateQueries({ queryKey: ['plot-job', jobId] });
                }}
              >
                刷新
              </Button>
            </Space>
          </Flex>

          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
            {tab === 'preview' && (
              <Flex vertical gap={8} style={{ height: '100%' }}>
                {preview}
                <Typography.Text type="secondary" style={{ fontSize: 12, textAlign: 'center' }}>
                  AntV 实时预览用于快速校对数据结构；出版级细节以「成品」中的服务端渲染为准。
                </Typography.Text>
              </Flex>
            )}
            {tab === 'server' && (
              <Flex vertical gap={12}>
                {!currentJob && (
                  <Empty description="提交任务后，这里会显示出版级渲染结果">
                    <Button type="primary" onClick={() => createM.mutate()} loading={createM.isPending}>立即渲染</Button>
                  </Empty>
                )}
                {currentJob && (
                  <>
                    <Descriptions size="small" column={2} items={[
                      { key: 't', label: '标题', children: currentJob.title },
                      { key: 'c', label: '模板', children: chartName(charts, currentJob.chart) },
                      { key: 's', label: '状态', children: <Tag color={STATUS_META[currentJob.status].color}>{STATUS_META[currentJob.status].text}</Tag> },
                      { key: 'u', label: '更新', children: formatTime(currentJob.updated_at) },
                      { key: 'm', label: '信息', span: 2, children: currentJob.message || '—' },
                    ]} />
                    {busy && (
                      <Flex justify="center" style={{ padding: 24 }}>
                        <Spin tip="Python 正在渲染…">
                          <div style={{ width: 180, height: 60 }} />
                        </Spin>
                      </Flex>
                    )}
                    {png && (
                      <Flex justify="center">
                        <Image
                          src={plotApi.fileUrl(currentJob.id, png.path)}
                          alt={currentJob.title}
                          style={{ width: 'min(100%, 1080px)', borderRadius: 8, background: '#fff' }}
                        />
                      </Flex>
                    )}
                    {currentJob.outputs.length > 0 && (
                      <Space wrap>
                        {currentJob.outputs.map((o) => (
                          <Button
                            key={o.path}
                            size="small"
                            icon={<DownloadOutlined />}
                            href={plotApi.fileUrl(currentJob.id, o.path, true)}
                            target="_blank"
                          >
                            {o.path.split('.').pop()?.toUpperCase()} · {(o.size / 1024).toFixed(0)} KB
                          </Button>
                        ))}
                        <Button size="small" icon={<FileTextOutlined />} onClick={() => openLog(currentJob.id)}>运行日志</Button>
                        <Button size="small" icon={<CopyOutlined />} onClick={() => copyShareLink(currentJob)}>复制图片链接</Button>
                      </Space>
                    )}
                    {currentJob.status === 'failed' && (
                      <Alert type="error" showIcon title="渲染失败" description={currentJob.message} action={
                        <Button size="small" onClick={() => openLog(currentJob.id)}>查看日志</Button>
                      } />
                    )}
                  </>
                )}
              </Flex>
            )}
            {tab === 'history' && (
              <Table<PlotJob>
                size="small"
                rowKey="id"
                dataSource={historyQ.data?.items ?? []}
                loading={historyQ.isLoading}
                pagination={{ pageSize: 8, size: 'small' }}
                columns={[
                  {
                    title: '任务', dataIndex: 'title',
                    render: (text: string, row) => (
                      <Space direction="vertical" size={0}>
                        <Typography.Link onClick={() => useJob(row)}>{text}</Typography.Link>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{chartName(charts, row.chart)} · {formatTime(row.created_at)}</Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: '状态', dataIndex: 'status', width: 96,
                    render: (s: PlotJob['status']) => <Tag color={STATUS_META[s].color}>{STATUS_META[s].text}</Tag>,
                  },
                  {
                    title: '操作', key: 'actions', width: 150,
                    render: (_, row) => (
                      <Space size={2}>
                        <Button size="small" type="text" icon={<PlayCircleOutlined />} onClick={() => useJob(row)} />
                        {row.outputs.some((o) => o.path.endsWith('.png')) && (
                          <Button
                            size="small" type="text" icon={<DownloadOutlined />}
                            href={plotApi.fileUrl(row.id, row.outputs.find((o) => o.path.endsWith('.png'))!.path, true)}
                          />
                        )}
                        <Button size="small" type="text" icon={<FileTextOutlined />} onClick={() => openLog(row.id)} />
                        <Button
                          size="small" type="text" danger icon={<DeleteOutlined />}
                          loading={removeM.isPending && removeM.variables === row.id}
                          onClick={() => removeM.mutate(row.id)}
                        />
                      </Space>
                    ),
                  },
                ]}
              />
            )}
          </div>
        </Flex>
      </Flex>

      <Drawer
        title="数据源"
        width={460}
        open={dataOpen}
        onClose={() => setDataOpen(false)}
        extra={<Button type="primary" onClick={() => setDataOpen(false)}>完成</Button>}
      >
        <Flex vertical gap={12}>
          {samples.length > 0 && (
            <Select
              value={sampleId}
              placeholder="载入示例数据"
              allowClear
              style={{ width: '100%' }}
              onChange={(v) => {
                const item = samples.find((x) => x.id === v);
                if (item) loadSample(item);
                else setSampleId(undefined);
              }}
              options={samples.map((x) => ({ value: x.id, label: `${x.name} · ${chartName(charts, x.chart)}` }))}
            />
          )}
          <Input.TextArea
            value={dataText}
            onChange={(e) => {
              setDataText(e.target.value);
              setSampleId(undefined);
            }}
            autoSize={{ minRows: 14, maxRows: 24 }}
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
            placeholder={chartId === 'tree' ? '树图只需在参数中填写 Newick，可留空。' : 'gene,value,group\nA,1.2,WT\nB,1.8,WT'}
          />
          <Upload.Dragger
            accept=".csv,.tsv,.txt"
            showUploadList={false}
            beforeUpload={(file) => {
              if (file.size > 8 * 1024 * 1024) {
                message.error('文件超过 8 MiB');
                return Upload.LIST_IGNORE;
              }
              file.text().then((text) => {
                setDataText(text);
                setSampleId(undefined);
                message.success(`已载入 ${file.name}`);
              });
              return false;
            }}
            style={{ padding: 4 }}
          >
            <p className="ant-upload-text" style={{ fontSize: 13 }}>上传 CSV / TSV</p>
            <p className="ant-upload-hint" style={{ fontSize: 12 }}>首行为列名，最大 8 MiB</p>
          </Upload.Dragger>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {table.rows.length
              ? `${table.rows.length} 行 × ${table.headers.length} 列 · ${table.headers.join(' / ')}`
              : '粘贴表格或上传文件后，右侧即时预览。'}
          </Typography.Text>
        </Flex>
      </Drawer>

      <Drawer
        title={chart ? `${chart.name} · 参数与样式` : '参数与样式'}
        width={400}
        open={styleOpen}
        onClose={() => setStyleOpen(false)}
        extra={<Button type="primary" onClick={() => setStyleOpen(false)}>完成</Button>}
      >
        <Flex vertical gap={12}>
          {(chart?.params ?? []).map((spec) => (
            <div key={spec.key}>
              <ParamField spec={spec} value={values[spec.key]} onChange={(v) => setValue(spec.key, v)} />
            </div>
          ))}
          <Flex gap={8}>
            <div style={{ flex: 1 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>色板</Typography.Text>
              <Select
                value={palette}
                onChange={setPalette}
                style={{ width: '100%' }}
                options={(metaQ.data?.palettes ?? ['npg']).map((p) => ({ value: p, label: p.toUpperCase() }))}
              />
            </div>
            <div style={{ width: 76 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>宽 (in)</Typography.Text>
              <InputNumber min={2} max={20} step={0.5} value={width} onChange={(v) => setWidth(Number(v) || 7.2)} style={{ width: '100%' }} />
            </div>
            <div style={{ width: 76 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>高 (in)</Typography.Text>
              <InputNumber min={2} max={20} step={0.5} value={height} onChange={(v) => setHeight(Number(v) || 4.8)} style={{ width: '100%' }} />
            </div>
          </Flex>
          {customColors.length > 0 && (
            <Space wrap size={4}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>配色搭配：</Typography.Text>
              {customColors.map((c) => (
                <Tag key={c} color={c} style={{ color: '#fff', border: 'none' }}>{c}</Tag>
              ))}
              <Button size="small" type="link" onClick={() => setCustomColors([])}>清除</Button>
            </Space>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            输出 300 dpi · PNG / SVG / PDF
          </Typography.Text>
          {chart?.description ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {chart.description}
            </Typography.Text>
          ) : null}
        </Flex>
      </Drawer>

      <Drawer
        title="运行日志"
        width={640}
        open={logOpen}
        onClose={() => setLogOpen(false)}
        extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => jobId && openLog(jobId)} disabled={!jobId}>刷新</Button>}
      >
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.6 }}>{logText}</pre>
      </Drawer>

      <Modal
        title="Agent / 脚本调用"
        open={apiOpen}
        onCancel={() => setApiOpen(false)}
        footer={<Button onClick={() => setApiOpen(false)}>关闭</Button>}
        width={720}
      >
        <Typography.Paragraph>
          绘图工作台是纯 JSON API，Agent 可直接调用（需要当前用户的会话 Cookie 与 CSRF）。
          提交后轮询 <Typography.Text code>GET /api/next/v1/plot/jobs/&lt;id&gt;</Typography.Text>，
          成品在 <Typography.Text code>outputs[].path</Typography.Text>，通过
          <Typography.Text code>/file?path=</Typography.Text> 下载。
        </Typography.Paragraph>
        <pre style={{ background: '#f6f8fa', padding: 12, borderRadius: 8, fontSize: 12, overflow: 'auto' }}>{`POST /api/next/v1/plot/jobs
Content-Type: application/json
X-CSRF-Token: <labspace_csrf>

{
  "title": "处理组生长量",
  "chart": "bar",
  "data": "category,value,group\\nControl,12.4,WT\\nLow-N,10.1,WT",
  "params": {"x":"category","y":"value","group":"group","palette":"npg"},
  "wait": true
}`}</pre>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          可选模板：{charts.map((c) => c.id).join('、')}；`wait:true` 最多等待 60 秒，适合 Agent 一次取回结果。
        </Typography.Paragraph>
      </Modal>
    </PageShell>
  );
}
function chartName(charts: PlotChart[], id: string): string {
  return charts.find((c) => c.id === id)?.name ?? id;
}

async function copyShareLink(job: PlotJob) {
  const png = job.outputs.find((o) => o.path.endsWith('.png'));
  if (!png) return;
  const url = `${window.location.origin}${plotApi.fileUrl(job.id, png.path)}`;
  try {
    await navigator.clipboard.writeText(url);
    message.success('图片链接已复制');
  } catch {
    message.error('复制失败');
  }
}

function ParamField({ spec, value, onChange }: { spec: PlotParamSpec; value: unknown; onChange: (v: unknown) => void }) {
  const label = (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {spec.label}{spec.help ? `（${spec.help}）` : ''}
    </Typography.Text>
  );
  if (spec.type === 'checkbox') {
    return (
      <Flex justify="space-between" align="center" style={{ paddingTop: 20 }}>
        {label}
        <Segmented
          size="small"
          value={value ? 'on' : 'off'}
          onChange={(v) => onChange(v === 'on')}
          options={[{ label: '关', value: 'off' }, { label: '开', value: 'on' }]}
        />
      </Flex>
    );
  }
  if (spec.type === 'select') {
    return (
      <Flex vertical gap={2}>
        {label}
        <Select
          size="small"
          value={value as string | undefined}
          onChange={onChange}
          allowClear
          style={{ width: '100%' }}
          options={(spec.options ?? []).map((o) => ({ value: o, label: o }))}
        />
      </Flex>
    );
  }
  if (spec.type === 'number') {
    return (
      <Flex vertical gap={2}>
        {label}
        <InputNumber
          size="small"
          value={value as number | undefined}
          onChange={(v) => onChange(v ?? undefined)}
          style={{ width: '100%' }}
        />
      </Flex>
    );
  }
  if (spec.type === 'textarea') {
    return (
      <Flex vertical gap={2}>
        {label}
        <Input.TextArea
          rows={4}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
        />
      </Flex>
    );
  }
  return (
    <Flex vertical gap={2}>
      {label}
      <Input
        size="small"
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder="列名"
      />
    </Flex>
  );
}

function buildPreview(
  chartId: string,
  table: { headers: string[]; rows: Record<string, string>[] },
  values: Record<string, unknown>,
) {
  if (!table.rows.length) {
    return <Empty description="粘贴或上传数据后显示实时预览" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  const { headers, rows } = table;
  const pick = (key: string, fallback?: string) => {
    const v = values[key];
    return typeof v === 'string' && v ? v : fallback;
  };
  const x = pick('x', headers[0]);
  const y = pick('y', headers[1]);
  const group = pick('group');

  if (chartId === 'tree') {
    return <Empty description="树图需服务端渲染，点击「渲染并保存」" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  if (chartId === 'bar' && x && y) {
    const grouped = new Map<string, { x: string; y: number; group?: string; sum: number; n: number }>();
    rows.forEach((r) => {
      const key = `${r[x]}|${group ? r[group] : ''}`;
      const item = grouped.get(key) ?? { x: r[x], y: 0, group: group ? r[group] : undefined, sum: 0, n: 0 };
      item.sum += toNumber(r[y]);
      item.n += 1;
      grouped.set(key, item);
    });
    const data = [...grouped.values()].map((i) => ({ ...i, y: i.sum / i.n }));
    return (
      <Column
        data={data}
        xField="x"
        yField="y"
        colorField={group ? 'group' : undefined}
        group={Boolean(group)}
        height={420}
        axis={{ y: { title: y } }}
      />
    );
  }
  if (chartId === 'line' && x && y) {
    return (
      <Line
        data={rows.map((r) => ({ x: r[x], y: toNumber(r[y]), group: group ? r[group] : '' }))}
        xField="x"
        yField="y"
        colorField={group ? 'group' : undefined}
        height={420}
      />
    );
  }
  if (chartId === 'scatter' && x && y) {
    return (
      <Scatter
        data={rows.map((r) => ({ x: toNumber(r[x]), y: toNumber(r[y]), group: group ? r[group] : '' }))}
        xField="x"
        yField="y"
        colorField={group ? 'group' : undefined}
        height={420}
      />
    );
  }
  if ((chartId === 'box' || chartId === 'violin') && x && y) {
    return (
      <Box
        data={rows.map((r) => ({ x: r[x], y: toNumber(r[y]), group: group ? r[group] : '' }))}
        xField="x"
        yField="y"
        colorField={group ? 'group' : undefined}
        height={420}
      />
    );
  }
  if (chartId === 'heatmap') {
    const lx = pick('x');
    const ly = pick('y');
    const lv = pick('value');
    let data: { x: string; y: string; value: number }[] = [];
    if (lx && ly && lv) {
      data = rows.map((r) => ({ x: r[lx], y: r[ly], value: toNumber(r[lv]) }));
    } else {
      const cols = headers.slice(1);
      data = rows.flatMap((r) => cols.map((c) => ({ x: c, y: r[headers[0]], value: toNumber(r[c]) })));
    }
    return (
      <Heatmap
        data={data}
        xField="x"
        yField="y"
        colorField="value"
        height={420}
        style={{ stroke: '#fff', lineWidth: 1 }}
      />
    );
  }
  if (chartId === 'volcano' && rows.length) {
    const gx = pick('x', 'log2fc');
    const gy = pick('y', 'padj');
    if (gx && gy) {
      return (
        <Scatter
          data={rows.map((r) => ({ x: toNumber(r[gx]), y: -Math.log10(Math.max(toNumber(r[gy]), 1e-300)) }))}
          xField="x"
          yField="y"
          height={420}
          axis={{ x: { title: 'log2FC' }, y: { title: '-log10(p)' } }}
        />
      );
    }
  }
  if (chartId === 'pca') {
    const numeric = headers.filter((h) => rows.every((r) => r[h] !== '' && Number.isFinite(Number(r[h]))));
    if (numeric.length >= 2) {
      return (
        <Scatter
          data={rows.map((r) => ({
            x: toNumber(r[numeric[0]]),
            y: toNumber(r[numeric[1]]),
            group: values.group ? r[String(values.group)] : '',
          }))}
          xField="x"
          yField="y"
          colorField="group"
          height={420}
          axis={{ x: { title: numeric[0] }, y: { title: numeric[1] } }}
        />
      );
    }
  }
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={(
        <Space direction="vertical" size={2}>
          <span>{chartId} 模板暂不支持浏览器内预览</span>
          <Typography.Text type="secondary">提交后可在「服务端成品」查看出版级图像</Typography.Text>
        </Space>
      )}
    >
      <Button type="primary" icon={<BarChartOutlined />} onClick={() => window.scrollTo({ top: 0 })}>
        查看服务端结果
      </Button>
    </Empty>
  );
}