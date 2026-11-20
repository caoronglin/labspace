import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Badge, Button, Descriptions, Drawer, Empty, Flex, Image, Input,
  Modal, Segmented, Select, Space, Spin, Table, Tag, Typography, Upload, message,
} from 'antd';
import {
  CopyOutlined, DeleteOutlined, DownloadOutlined,
  FileTextOutlined, FolderOpenOutlined, PlayCircleOutlined, ReloadOutlined, StopOutlined,
  CodeOutlined, BgColorsOutlined, DatabaseOutlined,
} from '@ant-design/icons';
import PageShell from '../components/PageShell';
import ParamPanel from '../components/plot/ParamPanel';
import PreviewChart from '../components/plot/PreviewChart';
import { parseTable } from '../components/plot/plotTable';
import { defaultParams, payloadParams } from '../components/plot/plotParams';
import {
  plotApi, type PlotChart, type PlotJob, type PlotSample,
} from '../services/api';

const STATUS_META: Record<PlotJob['status'], { color: string; text: string }> = {
  queued: { color: 'default', text: '排队中' },
  running: { color: 'processing', text: '渲染中' },
  succeeded: { color: 'success', text: '已完成' },
  failed: { color: 'error', text: '失败' },
  cancelled: { color: 'warning', text: '已取消' },
};

function formatTime(value: number): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 一键预设：把「常用组合」做成按钮。
 *
 * 用户的原话是「太麻烦」：以前要选模板 → 想清楚 x/y/group 填哪些列 → 提交。
 * 这几个组合覆盖了实验室八成需求，点一下就把示例数据 + 参数一次填好并进实时预览。
 */
const PRESETS: { key: string; label: string; chart: string; sample: string }[] = [
  { key: 'bar-group', label: '柱状 · 分组', chart: 'bar', sample: 'bar-growth' },
  { key: 'line-trend', label: '折线 · 趋势', chart: 'line', sample: 'line-dose' },
  { key: 'scatter-reg', label: '散点 · 回归', chart: 'scatter', sample: 'scatter-cor' },
  { key: 'volcano', label: '火山图', chart: 'volcano', sample: 'volcano-deg' },
  { key: 'heatmap', label: '热图', chart: 'heatmap', sample: 'heatmap-matrix' },
];

export default function PlotStudio() {
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
  // 当前生效的预设：用户一旦改了数据或参数就不再算「预设结果」，按钮不再高亮
  const [activePreset, setActivePreset] = useState<string>();

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

  function pickChart(id: string) {
    setChartId(id);
    const next = charts.find((c) => c.id === id);
    setValues(defaultParams(next, dataText));
    setSampleId(undefined);
    setActivePreset(undefined);
  }

  /**
   * 应用预设：数据、模板、参数、标题一次填好，并直接切到实时预览。
   * 预设指向后端的示例数据（samples），不在此处再写一份 CSV：
   * 否则两份数据会漂移，渲染出来的图与「示例数据」下的同一模板不一样。
   */
  function applyPreset(preset: (typeof PRESETS)[number]) {
    const sample = samples.find((s) => s.id === preset.sample);
    if (!sample) {
      message.info('示例数据还没加载完成，已先切到对应模板');
      pickChart(preset.chart);
      return;
    }
    loadSample(sample);
    setActivePreset(preset.key);
  }

  function loadSample(sample: PlotSample) {
    setSampleId(sample.id);
    setChartId(sample.chart);
    setTitle(sample.name);
    setDataText(sample.data ?? '');
    const next = charts.find((c) => c.id === sample.chart);
    setValues({ ...defaultParams(next), ...(sample.params ?? {}) });
    setTab('preview');
  }

  function setValue(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setActivePreset(undefined);
  }

  function payloadParamsOf() {
    return payloadParams(values, { palette, width, height, customColors });
  }

  const createM = useMutation({
    mutationFn: () =>
      plotApi.create({
        title: title.trim() || '未命名图',
        chart: chartId,
        data: dataText,
        sample: sampleId,
        params: payloadParamsOf(),
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
      title="绘图工作台"
      description="模板化科研绘图：点预设一键出图，浏览器内用 AntV 预览，Go 核心调度 Python 渲染出版级 PNG / SVG / PDF。"
      extra={(
        <Space wrap>
          <Button size="small" icon={<BgColorsOutlined />} onClick={() => navigate('/colors')}>配色搭配</Button>
          <Button size="small" icon={<DatabaseOutlined />} onClick={() => navigate('/genomes')}>公共基因组</Button>
          <Button size="small" icon={<FolderOpenOutlined />} onClick={() => navigate('/files')}>文件空间</Button>
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
        {/* 预设放在最上面：新用户不用先想清楚 x/y 该填哪列，
            点一下就得到一份能看、能改的图。 */}
        <Flex gap={6} wrap align="center">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>一键出图</Typography.Text>
          {PRESETS.map((p) => (
            <Button
              key={p.key}
              size="small"
              type={activePreset === p.key ? 'primary' : 'default'}
              onClick={() => applyPreset(p)}
            >
              {p.label}
            </Button>
          ))}
        </Flex>
        {/* 工具栏吸顶：预览区很长时，「渲染并保存」不应被滚出视野 */}
        <div
          style={{
            position: 'sticky',
            top: 8,
            zIndex: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
        <Flex
          gap={8}
          wrap
          align="center"
          style={{
            padding: '8px 10px',
            border: '1px solid var(--d509-border-soft)',
            borderRadius: 12,
            background: 'var(--ant-color-bg-container, #fff)',
            boxShadow: 'var(--d509-shadow-sm, 0 1px 2px rgba(16, 24, 40, 0.06))',
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
          {/* 模板说明常驻在工具栏下方：此前只在「参数与样式」抽屉里能看到，
              选完模板后基本靠猜数据列与适用场景 */}
          {chart ? (
            <Flex gap={8} wrap align="center" style={{ paddingInline: 4 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {chart.description}
              </Typography.Text>
              <Tag variant="filled" style={{ marginInlineEnd: 0 }}>
                数据列 {chart.columns}
              </Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                · {chart.library}
              </Typography.Text>
            </Flex>
          ) : null}
        </div>

        <ParamPanel
          chart={chart}
          chartId={chartId}
          table={table}
          values={values}
          onValueChange={setValue}
          palette={palette}
          palettes={metaQ.data?.palettes ?? ['npg']}
          onPaletteChange={(next) => { setPalette(next); setActivePreset(undefined); }}
          size={{ width, height }}
          onSizeChange={(next) => { setWidth(next.width); setHeight(next.height); }}
          customColors={customColors}
          onClearCustomColors={() => setCustomColors([])}
        />

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
                <PreviewChart chartId={chartId} table={table} values={values} />
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
                        <Spin description="Python 正在渲染…">
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
                      <Space orientation="vertical" size={0}>
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
        size={460}
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
        title="运行日志"
        size={640}
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
