import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Empty, Flex, Progress, Result, Row, Segmented, Space, Spin, Tag, Typography, Upload } from 'antd';
import { InboxOutlined, TranslationOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import PageShell from '../components/PageShell';
import Translation from './Translation';
import { palette } from '../theme/palette';

interface JobStatus {
  status: 'queued' | 'processing' | 'done' | 'failed';
  id?: string;
  result?: string;
  error?: string;
}

export default function Translate() {
  const [params, setParams] = useSearchParams();
  const tab: 'pdf' | 'text' = params.get('mode') === 'text' ? 'text' : 'pdf';
  const [jobId, setJobId] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [uploading, setUploading] = useState(false);

  const { data: svc } = useQuery({
    queryKey: ['pdf-translate-status'],
    queryFn: async () => (await fetch('/api/pdf-translate/status', { credentials: 'include' })).json(),
    refetchInterval: 30_000,
  });

  const { data: job, isFetching } = useQuery({
    queryKey: ['translate-job', jobId],
    queryFn: async (): Promise<JobStatus> => {
      const r = await fetch(`/api/pdf-translate/jobs/${jobId}`, { credentials: 'include' });
      if (!r.ok) throw new Error('作业不存在');
      return r.json();
    },
    enabled: !!jobId,
    refetchInterval: (q) => {
      const st = q.state.data?.status;
      return st === 'done' || st === 'failed' ? false : 3000;
    },
  });

  const submit = async (file: File) => {
    setError('');
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const csrf = document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1];
      const r = await fetch('/api/pdf-translate/jobs', {
        method: 'POST',
        credentials: 'include',
        headers: csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : undefined,
        body: fd,
      });
      if (!r.ok) {
        const t = await r.json().catch(() => ({}));
        throw new Error(t.detail || `提交失败(${r.status})`);
      }
      setJobId((await r.json()).job_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
    return false;
  };

  const stage = job?.status === 'queued' ? 10 : job?.status === 'processing' ? 60 : job?.status === 'done' ? 100 : job?.status === 'failed' ? 100 : 5;

  return (
    <PageShell
      title="翻译中心"
      description="论文 PDF 全文翻译与段落文本翻译共用本地 Hy-MT2 模型，内容不出内网。"
      extra={
        <Segmented
          value={tab}
          onChange={(v) =>
            setParams(v === 'text' ? { mode: 'text' } : {}, { replace: true })
          }
          options={[
            { label: '论文 PDF', value: 'pdf' },
            { label: '文本段落', value: 'text' },
          ]}
        />
      }
    >
      {tab === 'text' ? (
        <Translation />
      ) : (
    <Flex vertical gap={16}>
      <Card
        title={
          <Space>
            <TranslationOutlined style={{ color: palette.brand.blue600 }} />
            PDF 论文翻译
          </Space>
        }
        extra={
          svc ? (
            <Tag color={svc.pending > 0 ? 'gold' : 'green'} variant="filled">
              队列 {svc.pending} · 上限 {Math.round(svc.max_bytes / 1024 / 1024)}MB
            </Tag>
          ) : null
        }
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Upload.Dragger
              accept="application/pdf,.pdf"
              beforeUpload={submit}
              showUploadList={false}
              disabled={uploading}
              multiple={false}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽 PDF 到此处</p>
              <p className="ant-upload-hint">
                英文论文 PDF → 中文译文（保留公式与排版），队列串行处理
              </p>
            </Upload.Dragger>
            {uploading && (
              <Flex justify="center" style={{ marginTop: 12 }}>
                <Spin description="上传中…" />
              </Flex>
            )}
            {error && (
              <Alert style={{ marginTop: 12 }} type="error" showIcon title="提交失败" description={error} />
            )}
          </Col>

          <Col xs={24} lg={12}>
            {!jobId ? (
              <Empty description="提交后在此查看翻译进度" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : job?.status === 'done' ? (
              <Result
                status="success"
                title="翻译完成"
                subTitle="译文已生成，可下载压缩包"
                extra={
                  <Button
                    type="primary"
                    onClick={() => window.open(`/api/pdf-translate/jobs/${jobId}/result`, '_blank')}
                  >
                    下载译文
                  </Button>
                }
              />
            ) : job?.status === 'failed' ? (
              <Result status="error" title="翻译失败" subTitle={job.error || '请查看服务日志'} />
            ) : (
              <Card size="small" title="处理进度">
                <Progress percent={stage} status="active" />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {job?.status === 'queued' ? '排队中…' : '正在解析并翻译（大文件可能需要数分钟）'}
                </Typography.Text>
                {isFetching && (
                  <Flex justify="center" style={{ marginTop: 10 }}>
                    <Spin size="small" />
                  </Flex>
                )}
              </Card>
            )}
          </Col>
        </Row>
      </Card>

      <Alert
        type="info"
        showIcon
        title="使用说明"
        description="PDF 解析与翻译全部在本地完成，不经过公网；完成后下载双语对照压缩包，任务记录保留 7 天。"
      />
    </Flex>
      )}
    </PageShell>
  );
}
