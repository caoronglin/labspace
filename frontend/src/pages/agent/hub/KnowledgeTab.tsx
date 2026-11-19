import { useMemo, useState } from 'react';
import {
  App,
  Button,
  Drawer,
  Flex,
  Form,
  Grid,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { DeleteOutlined, FileTextOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { asDelete, asGet, asList, asPost, asUpload } from '../../../services/agentscope';
import type {
  AsKbDocument,
  AsKbDocumentList,
  AsKbEmbeddingProviders,
  AsKnowledgeBase,
  AsKnowledgeBaseList,
} from '../../../services/agentscope';
import { AsEmpty, AsErrorAlert, AsLoading, asErrorText, formatBytes, formatTime } from './common';

const KB_KEY = ['as', 'knowledge_bases'] as const;

interface KnowledgeFormValues {
  name: string;
  description?: string;
}

/** 文档索引状态 → 标签配色。 */
function docStatusColor(status: string): string {
  switch (status) {
    case 'ready':
      return 'green';
    case 'error':
      return 'red';
    case 'pending':
    case 'parsing':
    case 'chunking':
    case 'indexing':
      return 'blue';
    default:
      return 'default';
  }
}

/** 知识库：列表、新建、文档上传与索引状态。 */
export default function KnowledgeTab() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  const narrow = !screens.md;
  const [form] = Form.useForm<KnowledgeFormValues>();
  const [creating, setCreating] = useState(false);
  const [docsOf, setDocsOf] = useState<AsKnowledgeBase | null>(null);

  const bases = useQuery({
    queryKey: KB_KEY,
    queryFn: () => asList<AsKnowledgeBaseList>('knowledge_bases'),
    staleTime: 30_000,
  });

  const embeddingModels = useQuery({
    queryKey: ['as', 'knowledge_bases', 'embedding_models'],
    queryFn: () => asGet<AsKbEmbeddingProviders>('knowledge_bases', 'embedding_models'),
    staleTime: 30_000,
  });

  const firstEmbedding = useMemo(() => {
    const provider = embeddingModels.data?.providers?.[0];
    const card = provider?.models?.[0];
    if (!provider || !card) return null;
    return {
      type: 'embedding_model',
      credential_id: provider.credential?.id ?? '',
      model: card.name,
      dimensions: card.dimensions,
      parameters: {},
    };
  }, [embeddingModels.data]);

  const create = useMutation({
    mutationFn: (values: KnowledgeFormValues) => {
      const body: Record<string, unknown> = {
        name: values.name.trim(),
        description: values.description?.trim() ?? '',
      };
      // AgentScope 的 schema 要求 embedding_model_config 必填，
      // 而本平台的向量模型是**平台固定**的：AgentScope 适配层在
      // create_knowledge_base 里会用平台配置覆盖调用方传入的值
      // （见 deploy/agentscope/app.py 的 _platform_embedding_config）。
      //
      // 所以这里不能"没有可用模型就不传"——那样会被 422 挡在协议层，
      // 用户看到的是"创建失败"，而实际原因只是"还没人手动配过凭据"。
      // 有可用模型就带上真实配置（便于界面回显），没有就带上平台占位配置。
      body.embedding_model_config = firstEmbedding ?? {
        type: 'embedding_model',
        credential_id: '',
        model: 'bge-m3',
        dimensions: 1024,
        parameters: {},
      };
      return asPost('knowledge_bases', '', body);
    },
    onSuccess: () => {
      message.success('知识库已创建');
      setCreating(false);
      form.resetFields();
      void qc.invalidateQueries({ queryKey: KB_KEY });
    },
    onError: (err) => message.error(asErrorText(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => asDelete('knowledge_bases', id),
    onSuccess: () => {
      message.success('知识库已删除');
      void qc.invalidateQueries({ queryKey: KB_KEY });
    },
    onError: (err) => message.error(asErrorText(err)),
  });

  const kbId = docsOf?.id ?? '';
  const docs = useQuery({
    queryKey: ['as', 'knowledge_bases', kbId, 'documents'],
    queryFn: () => asGet<AsKbDocumentList>('knowledge_bases', `${kbId}/documents`),
    enabled: kbId !== '',
    staleTime: 30_000,
  });

  const docColumns: TableColumnsType<AsKbDocument> = [
    {
      title: '文件',
      dataIndex: 'filename',
      key: 'filename',
      render: (value: string, record) => (
        <Flex vertical>
          <Space size={4}>
            <FileTextOutlined />
            <span>{value}</span>
          </Space>
          {record.error ? (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              {record.error}
            </Typography.Text>
          ) : null}
        </Flex>
      ),
    },
    {
      title: '大小',
      key: 'size',
      width: 100,
      render: (_v, record) => formatBytes(record.size),
    },
    {
      title: '索引状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (value: string) => <Tag color={docStatusColor(value)}>{value}</Tag>,
    },
    {
      title: '分块数',
      dataIndex: 'chunk_count',
      key: 'chunk_count',
      width: 90,
      render: (value: number | undefined) => value ?? 0,
    },
    {
      title: '更新时间',
      key: 'updated_at',
      width: 170,
      render: (_v, record) => formatTime(record.updated_at),
    },
  ];

  const columns: TableColumnsType<AsKnowledgeBase> = [
    {
      title: '名称',
      key: 'name',
      render: (_v, record) => (
        <Flex vertical>
          <span>{record.name}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.id}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      render: (value: string | undefined) => value || '—',
    },
    {
      title: '文档数',
      dataIndex: 'document_count',
      key: 'document_count',
      width: 90,
      render: (value: number | undefined) => value ?? 0,
    },
    {
      title: '分块数',
      dataIndex: 'chunk_count',
      key: 'chunk_count',
      width: 90,
      render: (value: number | undefined) => value ?? 0,
    },
    {
      title: '索引状态',
      key: 'status_counts',
      width: 220,
      render: (_v, record) => {
        const counts = record.status_counts ?? {};
        const items = Object.entries(counts).filter(([, count]) => (count ?? 0) > 0);
        if (items.length === 0) return <Tag color="default">无文档</Tag>;
        return (
          <Space size={4} wrap>
            {items.map(([status, count]) => (
              <Tag key={status} color={docStatusColor(status)}>
                {status} {count}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '更新时间',
      key: 'updated_at',
      width: 170,
      render: (_v, record) => formatTime(record.updated_at),
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_v, record) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<FileTextOutlined />}
            aria-label={`查看知识库 ${record.name} 的文档`}
            onClick={() => setDocsOf(record)}
          >
            文档
          </Button>
          <Popconfirm
            title="删除该知识库？"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => remove.mutateAsync(record.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} aria-label={`删除知识库 ${record.name}`}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Flex vertical gap={12}>
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Typography.Text type="secondary">
          共 {bases.data?.total ?? 0} 个知识库；上传文档后由 AgentScope 异步解析与索引。
        </Typography.Text>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setCreating(true)}
          aria-label="新建知识库"
        >
          新建知识库
        </Button>
      </Flex>

      {bases.isLoading ? (
        <AsLoading rows={5} />
      ) : bases.error ? (
        <AsErrorAlert error={bases.error} onRetry={() => void bases.refetch()} />
      ) : (bases.data?.knowledge_bases.length ?? 0) === 0 ? (
        <AsEmpty
          description="还没有知识库"
          action={
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              新建知识库
            </Button>
          }
        />
      ) : (
        <Table<AsKnowledgeBase>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={bases.data?.knowledge_bases ?? []}
          pagination={false}
          scroll={{ x: 1000 }}
        />
      )}

      <Modal
        title="新建知识库"
        open={creating}
        onCancel={() => {
          setCreating(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        okText="创建"
        cancelText="取消"
        confirmLoading={create.isPending}
        destroyOnHidden
        width={narrow ? '100%' : 560}
      >
        {embeddingModels.error ? (
          <AsErrorAlert error={embeddingModels.error} onRetry={() => void embeddingModels.refetch()} />
        ) : firstEmbedding ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            将使用嵌入模型 <code>{firstEmbedding.model}</code>（维度 {firstEmbedding.dimensions}）。
          </Typography.Paragraph>
        ) : (
          <Typography.Paragraph type="warning" style={{ marginBottom: 12 }}>
            没有查到可用的嵌入模型，AgentScope 2.0.11 创建知识库时必须绑定一个嵌入模型。
          </Typography.Paragraph>
        )}
        <Form<KnowledgeFormValues>
          form={form}
          layout="vertical"
          onFinish={(values) => create.mutate(values)}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请填写知识库名称' }]}>
            <Input placeholder="例如：肿瘤文献库" aria-label="知识库名称" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="这个知识库收集什么内容？" aria-label="知识库描述" />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={`文档 · ${docsOf?.name ?? ''}`}
        open={kbId !== ''}
        onClose={() => setDocsOf(null)}
        width={narrow ? '100%' : 720}
      >
        <Flex vertical gap={12}>
          <Upload
            showUploadList={false}
            accept=".pdf,.txt,.md,.markdown,.docx,.csv"
            disabled={kbId === ''}
            customRequest={(options) => {
              const form = new FormData();
              // AgentScope 的上传字段名是 file（见 openapi.json 的 knowledge_bases 段）。
              form.append('file', options.file);
              asUpload('knowledge_bases', `${kbId}/documents`, form)
                .then(() => {
                  message.success('文档已提交，等待索引');
                  options.onSuccess?.(undefined);
                  void qc.invalidateQueries({ queryKey: ['as', 'knowledge_bases', kbId, 'documents'] });
                  void qc.invalidateQueries({ queryKey: KB_KEY });
                })
                .catch((err: unknown) => {
                  message.error(asErrorText(err));
                  options.onError?.(err instanceof Error ? err : new Error(asErrorText(err)));
                });
            }}
          >
            <Button icon={<UploadOutlined />} aria-label="上传文档到知识库">
              上传文档
            </Button>
          </Upload>

          {docs.isLoading ? (
            <AsLoading rows={4} />
          ) : docs.error ? (
            <AsErrorAlert error={docs.error} onRetry={() => void docs.refetch()} />
          ) : (docs.data?.documents.length ?? 0) === 0 ? (
            <AsEmpty description="该知识库还没有文档" />
          ) : (
            <Table<AsKbDocument>
              rowKey="id"
              size="small"
              columns={docColumns}
              dataSource={docs.data?.documents ?? []}
              pagination={false}
              scroll={{ x: 700 }}
            />
          )}
        </Flex>
      </Drawer>
    </Flex>
  );
}
