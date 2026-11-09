import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Checkbox,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { CloudUploadOutlined, PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, type LabopsJob } from '../../services/api';

const STATUS: Record<string, { color: string; label: string }> = {
  queued: { color: 'default', label: '排队中' },
  running: { color: 'processing', label: '运行中' },
  succeeded: { color: 'green', label: '已完成' },
  failed: { color: 'red', label: '失败' },
  cancelled: { color: 'default', label: '已取消' },
  cancelling: { color: 'orange', label: '取消中' },
};
const ACTIVE = new Set(['queued', 'running', 'cancelling']);

export default function PipelinePanel() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const [pipeline, setPipeline] = useState('');
  const [demo, setDemo] = useState('');
  const [demoFiles, setDemoFiles] = useState<string[]>([]);
  const [uploads, setUploads] = useState<any[]>([]);
  const [logJob, setLogJob] = useState<LabopsJob | null>(null);

  const meta = useQuery({ queryKey: ['labops', 'pipeline-meta'], queryFn: api.labopsPipelineMeta });
  const jobs = useQuery({
    queryKey: ['labops', 'jobs'],
    queryFn: api.labopsJobs,
    refetchInterval: (query) => {
      const rows = query.state.data?.items ?? [];
      return rows.some((j) => ACTIVE.has(j.status)) ? 4000 : false;
    },
  });
  const log = useQuery({
    queryKey: ['labops', 'job-log', logJob?.id],
    queryFn: () => api.labopsJobLog(logJob!.id),
    enabled: Boolean(logJob),
    refetchInterval: logJob && ACTIVE.has(logJob.status) ? 3000 : false,
  });

  const catalog = meta.data?.catalog ?? [];
  const current = useMemo(() => catalog.find((p) => p.id === pipeline), [catalog, pipeline]);
  const demoEntry = useMemo(() => meta.data?.demos.find((d) => d.name === demo), [meta.data, demo]);

  useEffect(() => {
    if (!current) return;
    form.setFieldsValue({ params: current.params });
  }, [current, form]);

  useEffect(() => {
    setDemoFiles(demoEntry ? demoEntry.files.map((f) => f.path) : []);
  }, [demoEntry]);

  const create = useMutation({
    mutationFn: async (values: any) => {
      if (!pipeline) throw new Error('请选择流程');
      const fd = new FormData();
      fd.append('pipeline', pipeline);
      fd.append('name', values.name || '');
      fd.append('reference', values.reference || '');
      fd.append('demo', demo);
      fd.append('inputs', JSON.stringify(demoFiles));
      fd.append('params', JSON.stringify(values.params ?? {}));
      uploads.forEach((u) => {
        if (u.originFileObj) fd.append('files', u.originFileObj);
        else if (u instanceof File) fd.append('files', u);
      });
      return api.labopsCreateJob(fd);
    },
    onSuccess: () => {
      message.success('任务已提交，等待宿主机 worker 执行');
      setUploads([]);
      form.resetFields(['name']);
      qc.invalidateQueries({ queryKey: ['labops', 'jobs'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const cancel = useMutation({
    mutationFn: api.labopsCancelJob,
    onSuccess: () => {
      message.success('已请求取消');
      qc.invalidateQueries({ queryKey: ['labops', 'jobs'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const columns = [
    {
      title: '任务',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, row: LabopsJob) => (
        <Flex vertical gap={2}>
          <Typography.Text strong>{name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {catalog.find((p) => p.id === row.pipeline)?.name ?? row.pipeline} · {dayjs(row.created_at).format('MM-DD HH:mm')}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 150,
      render: (status: string, row: LabopsJob) => (
        <Flex vertical gap={4}>
          <Tag color={STATUS[status]?.color ?? 'default'}>{STATUS[status]?.label ?? status}</Tag>
          {(status === 'running' || status === 'queued') && <Progress percent={row.progress ?? 0} size="small" />}
        </Flex>
      ),
    },
    {
      title: '说明',
      dataIndex: 'message',
      key: 'message',
      ellipsis: true,
      render: (v: string) => v || '—',
    },
    {
      title: '输出',
      dataIndex: 'outputs',
      key: 'outputs',
      width: 240,
      render: (outputs: LabopsJob['outputs'], row: LabopsJob) => (
        <Space size={4} wrap>
          {(outputs ?? []).map((out, idx) => (
            <Button
              key={out.path}
              size="small"
              type="link"
              style={{ padding: 0 }}
              href={api.labopsJobFileUrl(row.id, out.path)}
              target="_blank"
            >
              {out.path.split('/').pop() ?? `输出 ${idx + 1}`}
            </Button>
          ))}
          {(outputs ?? []).length === 0 && '—'}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_: unknown, row: LabopsJob) => (
        <Space size={4}>
          <Button size="small" onClick={() => setLogJob(row)}>
            日志
          </Button>
          {ACTIVE.has(row.status) && (
            <Popconfirm title="取消该任务？" onConfirm={() => cancel.mutate(row.id)}>
              <Button size="small" danger>
                取消
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Card
        title={
          <Space>
            <PlayCircleOutlined />
            生信流水线运行中心
          </Space>
        }
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => meta.refetch()}>
            刷新工具状态
          </Button>
        }
      >
        <Flex gap={8} wrap style={{ marginBottom: 12 }}>
          {Object.entries(meta.data?.tools ?? {}).map(([tool, path]) => (
            <Tag key={tool} color={path ? 'green' : 'red'}>
              {tool}: {path ? '已就绪' : '缺失'}
            </Tag>
          ))}
          {meta.data?.worker?.last_seen && (
            <Tag color="blue">worker 心跳 {dayjs(meta.data.worker.last_seen).format('HH:mm:ss')}</Tag>
          )}
        </Flex>
        <Form form={form} layout="vertical" onFinish={(v) => create.mutate(v)}>
          <Flex gap={12} wrap>
            <Form.Item label="流程" required style={{ flex: 1, minWidth: 220 }}>
              <Select
                placeholder="选择分析流程"
                value={pipeline || undefined}
                onChange={setPipeline}
                options={catalog.map((p) => ({ value: p.id, label: p.name }))}
              />
            </Form.Item>
            <Form.Item name="name" label="任务名称" style={{ flex: 1, minWidth: 220 }}>
              <Input placeholder="留空使用流程名" />
            </Form.Item>
          </Flex>
          {current && <Typography.Paragraph type="secondary">{current.description}</Typography.Paragraph>}

          <Flex gap={12} wrap>
            <Form.Item label="演示数据" style={{ flex: 1, minWidth: 220 }}>
              <Select
                allowClear
                placeholder="使用内置演示数据"
                value={demo || undefined}
                onChange={(v) => setDemo(v ?? '')}
                options={(meta.data?.demos ?? []).map((d) => ({ value: d.name, label: d.name }))}
              />
            </Form.Item>
            {current?.needs_reference && (
              <Form.Item name="reference" label="参考基因组" rules={[{ required: true, message: '请选择参考基因组' }]} style={{ flex: 2, minWidth: 280 }}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="共享参考基因组"
                  options={(meta.data?.references ?? []).map((r) => ({ value: r.path, label: r.name }))}
                />
              </Form.Item>
            )}
          </Flex>

          {demoEntry && (
            <Form.Item label={`演示文件（${demoEntry.name}）`}>
              <Checkbox.Group value={demoFiles} onChange={(v) => setDemoFiles(v as string[])}>
                <Flex vertical gap={4}>
                  {demoEntry.files.map((f) => (
                    <Checkbox key={f.path} value={f.path}>
                      {f.name} · {(f.size / 1024 / 1024).toFixed(1)} MB
                    </Checkbox>
                  ))}
                </Flex>
              </Checkbox.Group>
            </Form.Item>
          )}

          <Form.Item label="上传输入数据">
            <Upload.Dragger
              multiple
              fileList={uploads as any}
              beforeUpload={() => false}
              onChange={({ fileList }) => setUploads(fileList as any)}
            >
              <Flex vertical align="center" gap={4} style={{ padding: 12 }}>
                <CloudUploadOutlined style={{ fontSize: 28 }} />
                <Typography.Text>拖拽 FASTQ / 矩阵文件到这里，或点击选择</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  单文件上限 2 GiB
                </Typography.Text>
              </Flex>
            </Upload.Dragger>
          </Form.Item>

          {current && Object.keys(current.params).length > 0 && (
            <Card size="small" title="参数" style={{ marginBottom: 16 }}>
              <Flex gap={12} wrap>
                {Object.entries(current.params).map(([key, value]) => (
                  <Form.Item key={key} name={['params', key]} label={key} style={{ minWidth: 160, marginBottom: 8 }}>
                    {typeof value === 'number' ? <InputNumber style={{ width: '100%' }} /> : <Input />}
                  </Form.Item>
                ))}
              </Flex>
            </Card>
          )}

          <Button type="primary" htmlType="submit" loading={create.isPending} icon={<PlayCircleOutlined />}>
            提交任务
          </Button>
        </Form>
      </Card>

      <Card title="运行记录" extra={<Button icon={<ReloadOutlined />} onClick={() => jobs.refetch()}>刷新</Button>}>
        <Table
          rowKey="id"
          size="middle"
          loading={jobs.isLoading}
          dataSource={jobs.data?.items ?? []}
          columns={columns as any}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          locale={{ emptyText: <Empty description="还没有运行记录" /> }}
        />
      </Card>

      <Drawer
        title={logJob ? `运行日志 · ${logJob.name}` : ''}
        open={Boolean(logJob)}
        onClose={() => setLogJob(null)}
        width={760}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => log.refetch()}>
            刷新
          </Button>
        }
      >
        {logJob && (
          <Flex vertical gap={12}>
            <Flex gap={12} wrap>
              <Tag color={STATUS[logJob.status]?.color}>{STATUS[logJob.status]?.label ?? logJob.status}</Tag>
              <Typography.Text type="secondary">{logJob.message}</Typography.Text>
            </Flex>
            <pre
              style={{
                margin: 0,
                padding: 12,
                background: 'rgba(0,0,0,0.45)',
                color: '#d7e0ea',
                borderRadius: 8,
                fontSize: 12,
                lineHeight: 1.6,
                maxHeight: '72vh',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
              }}
            >
              {log.isLoading ? '加载日志…' : log.data || '暂无日志'}
            </pre>
          </Flex>
        )}
      </Drawer>
    </Flex>
  );
}