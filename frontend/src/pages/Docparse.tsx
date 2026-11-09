import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Flex,
  Row,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import {
  BookOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  DownloadOutlined,
  FileTextOutlined,
  InboxOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { errText } from '../utils/err';
import SaveKnowledgeModal from '../components/SaveKnowledgeModal';

const ACCEPT = '.pdf,.docx,.txt,.md,.csv,.xlsx,.pptx';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function Docparse() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const [file, setFile] = useState<File | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  const statusQuery = useQuery({
    queryKey: ['docparse-status'],
    queryFn: () => api.docparseStatus(),
    staleTime: 30_000,
    retry: false,
  });

  const status = statusQuery.data;
  const maxBytes = status?.maxBytes ?? 0;
  const oversized = !!file && maxBytes > 0 && file.size > maxBytes;

  const parseMutation = useMutation({
    mutationFn: async (target: File) => api.docparseParse(target, true),
    onError: (e: Error) => message.error(`解析失败：${errText(e)}`),
  });

  const result = parseMutation.data;

  const copyMarkdown = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.markdown);
      message.success('Markdown 已复制到剪贴板');
    } catch {
      message.error('复制失败，请手动选择文本复制');
    }
  };

  const downloadMarkdown = () => {
    if (!result) return;
    const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const base = file?.name.replace(/\.[^.]+$/, '') || 'document';
    a.download = `${base}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const metaItems = result
    ? [
        { key: 'provider', label: '解析引擎', children: result.provider },
        { key: 'pages', label: '页数', children: result.pages != null ? result.pages : '-' },
        { key: 'fileType', label: '文件类型', children: result.fileType || '-' },
        { key: 'taskId', label: '任务号', children: result.taskId || '-' },
        { key: 'elapsed', label: '耗时', children: `${result.elapsed_ms} ms` },
        {
          key: 'fallback',
          label: '是否回退',
          children: result.fallbackUsed ? '已回退到 Docling' : '否',
        },
        {
          key: 'warnings',
          label: '警告',
          children:
            result.warnings && result.warnings.length > 0 ? (
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : (
              '无'
            ),
        },
      ]
    : [];

  const tabItems = [
    {
      key: 'markdown',
      label: 'Markdown',
      children: result?.markdown ? (
        <pre
          style={{
            background: '#FFFFFF',
            border: '1px solid #E6E9EF',
            borderRadius: 10,
            padding: 16,
            margin: 0,
            maxHeight: 520,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 13,
            lineHeight: 1.7,
          }}
        >
          {result.markdown}
        </pre>
      ) : (
        <Empty description="暂无 Markdown 内容" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ),
    },
    {
      key: 'text',
      label: '纯文本',
      children: result?.text ? (
        <pre
          style={{
            background: '#FFFFFF',
            border: '1px solid #E6E9EF',
            borderRadius: 10,
            padding: 16,
            margin: 0,
            maxHeight: 520,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 13,
            lineHeight: 1.7,
          }}
        >
          {result.text}
        </pre>
      ) : (
        <Empty description="暂无纯文本内容" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ),
    },
    {
      key: 'meta',
      label: '元信息',
      children: result ? (
        <Descriptions bordered size="small" column={1} items={metaItems} />
      ) : (
        <Empty description="暂无解析元信息" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Flex align="center" justify="space-between" wrap gap={8}>
        <Typography.Title level={3} style={{ margin: 0, fontSize: 22 }}>
          <Space>
            <FileTextOutlined style={{ color: '#2B5CE6' }} />
            文档解析
          </Space>
        </Typography.Title>
        <Space>
          {status && (
            <Tag color={status.available ? 'green' : 'orange'} variant="filled">
              {status.provider}
            </Tag>
          )}
          {status?.fallback && (
            <Tag color={status.fallback.available ? 'blue' : 'default'}>
              回退：{status.fallback.name}
            </Tag>
          )}
          <Button
            icon={<ReloadOutlined />}
            loading={statusQuery.isFetching}
            onClick={() => queryClient.invalidateQueries({ queryKey: ['docparse-status'] })}
          >
            检查服务状态
          </Button>
        </Space>
      </Flex>

      {statusQuery.isLoading && (
        <Card size="small">
          <Flex justify="center">
            <Spin description="正在获取解析服务状态…" />
          </Flex>
        </Card>
      )}

      {statusQuery.isError && (
        <Alert
          type="error"
          showIcon
          title="获取服务状态失败"
          description={(statusQuery.error as Error)?.message || '无法连接后端服务'}
          action={
            <Button size="small" onClick={() => queryClient.invalidateQueries({ queryKey: ['docparse-status'] })}>
              重试
            </Button>
          }
        />
      )}

      {status && !status.available && (
        <Alert
          type="warning"
          showIcon
          title="文档解析服务当前不可用"
          description={status.reason || 'OXR-1.0 解析服务未启动：请确认解析服务已部署并可访问'}
          action={
            <Button size="small" onClick={() => queryClient.invalidateQueries({ queryKey: ['docparse-status'] })}>
              检查服务状态
            </Button>
          }
        />
      )}

      {status && !status.available && status.fallback?.available && (
        <Alert
          type="info"
          showIcon
          title="已启用 Docling 回退"
          description={`${status.fallback.name}：${status.fallback.detail}${status.fallback.url ? `（${status.fallback.url}）` : ''}`}
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <Card title="上传文档" size="small">
            <Upload.Dragger
              accept={ACCEPT}
              multiple={false}
              beforeUpload={(f) => {
                setFile(f);
                parseMutation.reset();
                return false;
              }}
              fileList={[]}
              onChange={() => undefined}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽文件到此处上传，支持 PDF / Word / Markdown / 文本 / 表格</p>
              <p className="ant-upload-hint">
                支持 PDF、Word（.docx）、Markdown、纯文本、CSV / Excel、PowerPoint 单文件解析
                {maxBytes > 0 ? `，单个文件不超过 ${formatBytes(maxBytes)}` : ''}
              </p>
            </Upload.Dragger>

            {file && (
              <Flex vertical gap={8} style={{ marginTop: 12 }}>
                <Space wrap>
                  <Tag color="blue" variant="filled">
                    {file.name}
                  </Tag>
                  <Tag>{formatBytes(file.size)}</Tag>
                </Space>
                {oversized && (
                  <Alert
                    type="error"
                    showIcon
                    title={`文件超过解析上限（${formatBytes(maxBytes)}）`}
                    description={`当前文件 ${formatBytes(file.size)}，请压缩或拆分后再试。`}
                  />
                )}
                <Flex gap={8}>
                  <Button
                    type="primary"
                    loading={parseMutation.isPending}
                    disabled={oversized || parseMutation.isPending}
                    onClick={() => file && parseMutation.mutate(file)}
                  >
                    开始解析
                  </Button>
                  <Button onClick={() => setFile(null)} disabled={parseMutation.isPending}>
                    清除
                  </Button>
                </Flex>
              </Flex>
            )}

            {parseMutation.isPending && (
              <Flex justify="center" style={{ marginTop: 16 }}>
                <Spin description="正在解析文档…" />
              </Flex>
            )}

            {parseMutation.isError && (
              <Alert
                style={{ marginTop: 12 }}
                type="error"
                showIcon
                title="解析失败"
                description={(parseMutation.error as Error)?.message || '未知错误'}
                action={
                  <Button size="small" onClick={() => file && parseMutation.mutate(file)}>
                    重试
                  </Button>
                }
              />
            )}
          </Card>
        </Col>

        <Col xs={24} lg={14}>
          <Card
            title="解析结果"
            size="small"
            extra={
              result && (
                <Space>
                  {result.fallbackUsed && (
                    <Tag color="warning" icon={<CheckCircleOutlined />}>
                      已回退到 Docling
                    </Tag>
                  )}
                  <Button size="small" icon={<CopyOutlined />} onClick={copyMarkdown}>
                    复制 Markdown
                  </Button>
                  <Button size="small" icon={<DownloadOutlined />} onClick={downloadMarkdown}>
                    下载 .md
                  </Button>
                  <Button
                    size="small"
                    type="primary"
                    icon={<BookOutlined />}
                    disabled={!result.markdown && !result.text}
                    onClick={() => setSaveOpen(true)}
                  >
                    保存到知识库
                  </Button>
                </Space>
              )
            }
          >
            {result?.fallbackUsed && (
              <Alert
                style={{ marginBottom: 12 }}
                type="warning"
                showIcon
                title="已回退到 Docling 解析"
                description="OXR-1.0 解析未成功，已自动使用 Docling 完成解析，输出结构可能略有差异。"
              />
            )}

            {result ? (
              <Tabs items={tabItems} />
            ) : parseMutation.isPending ? (
              <Empty description="正在解析文档…" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Empty description="上传文件并点击「开始解析」后在此查看结果" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>
        </Col>
      </Row>

      <SaveKnowledgeModal
        open={saveOpen}
        title={file?.name.replace(/\.[^.]+$/, '') || '文档解析结果'}
        body={result?.markdown || result?.text || ''}
        category="文档解析"
        tags={['文档解析']}
        onClose={() => setSaveOpen(false)}
      />
    </Flex>
  );
}
