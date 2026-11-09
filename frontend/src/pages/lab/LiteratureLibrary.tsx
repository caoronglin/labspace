import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Drawer,
  Dropdown,
  Empty,
  Flex,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  BookOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  LinkOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, type LabopsLiterature } from '../../services/api';

const STATUS: Record<string, { color: string; label: string }> = {
  unread: { color: 'default', label: '未读' },
  reading: { color: 'processing', label: '在读' },
  read: { color: 'green', label: '已读' },
};

export default function LiteratureLibrary() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [semanticQ, setSemanticQ] = useState('');
  const [status, setStatus] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [editItem, setEditItem] = useState<LabopsLiterature | null>(null);
  const [citeItem, setCiteItem] = useState<LabopsLiterature | null>(null);
  const [citeText, setCiteText] = useState('');
  const [importForm] = Form.useForm();
  const [editForm] = Form.useForm();

  const list = useQuery({
    queryKey: ['labops', 'literature', keyword, status],
    queryFn: () => api.labopsLiterature(keyword, status),
  });
  const semantic = useQuery({
    queryKey: ['labops', 'literature-search', semanticQ],
    queryFn: () => api.labopsLiteratureSearch(semanticQ),
    enabled: semanticQ.trim().length > 0,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['labops', 'literature'] });

  const importDoi = useMutation({
    mutationFn: (values: { doi?: string; title?: string; tags?: string[] }) => api.labopsImportLiterature(values),
    onSuccess: (r) => {
      message.success(r.duplicate ? '该 DOI 已在库中' : '已导入文献');
      setImportOpen(false);
      importForm.resetFields();
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const update = useMutation({
    mutationFn: (values: Partial<LabopsLiterature>) => api.labopsUpdateLiterature(editItem!.id, values),
    onSuccess: () => {
      message.success('已保存');
      setEditItem(null);
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const remove = useMutation({
    mutationFn: api.labopsDeleteLiterature,
    onSuccess: () => {
      message.success('已删除');
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const showCite = async (item: LabopsLiterature, style: string) => {
    try {
      const text = await api.labopsCitation(item.id, style);
      setCiteItem(item);
      setCiteText(text);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const items = semanticQ ? semantic.data?.items ?? [] : list.data?.items ?? [];

  return (
    <Flex vertical gap={16}>
      <Card
        title={
          <Space>
            <BookOutlined />
            我的文献库
          </Space>
        }
        extra={
          <Dropdown
            menu={{
              items: [
                { key: 'bibtex', label: '导出 BibTeX' },
                { key: 'ris', label: '导出 RIS' },
                { key: 'gbt7714', label: '导出 GB/T 7714' },
                { key: 'apa', label: '导出 APA' },
              ],
              onClick: ({ key }) => window.open(api.labopsLiteratureExportUrl([], key), '_blank'),
            }}
          >
            <Button icon={<DownloadOutlined />}>导出引用</Button>
          </Dropdown>
        }
      >
        <Flex gap={12} wrap style={{ marginBottom: 12 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setImportOpen(true)}>
            DOI 导入
          </Button>
          <Input.Search
            allowClear
            prefix={<SearchOutlined />}
            placeholder="标题 / 作者 / 摘要 / DOI"
            style={{ width: 300 }}
            onSearch={setKeyword}
          />
          <Input.Search
            allowClear
            placeholder="语义检索（AI 向量）"
            style={{ width: 300 }}
            enterButton="语义检索"
            onSearch={setSemanticQ}
          />
          <Select
            allowClear
            placeholder="阅读状态"
            style={{ width: 130 }}
            value={status || undefined}
            onChange={(v) => setStatus(v ?? '')}
            options={Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }))}
          />
        </Flex>
        {semanticQ && (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            语义检索：{semantic.data?.mode === 'hybrid' ? '关键词 + 向量混合排序' : '向量模型未就绪，已降级为关键词匹配'}
          </Typography.Paragraph>
        )}
        <List
          loading={semanticQ ? semantic.isFetching : list.isLoading}
          dataSource={items}
          locale={{ emptyText: <Empty description={semanticQ ? '没有匹配文献' : '文献库为空，先导入一个 DOI'} /> }}
          renderItem={(item: LabopsLiterature) => (
            <List.Item
              actions={[
                <Button
                  key="open"
                  size="small"
                  icon={<LinkOutlined />}
                  disabled={!item.url && !item.doi}
                  onClick={() => window.open(item.url || `https://doi.org/${item.doi}`, '_blank')}
                >
                  原文
                </Button>,
                <Button
                  key="edit"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setEditItem(item);
                    editForm.setFieldsValue({
                      status: item.status,
                      tags: item.tags ?? [],
                      notes: item.notes ?? '',
                    });
                  }}
                >
                  笔记
                </Button>,
                <Dropdown
                  key="cite"
                  menu={{
                    items: [
                      { key: 'gbt7714', label: 'GB/T 7714' },
                      { key: 'bibtex', label: 'BibTeX' },
                      { key: 'ris', label: 'RIS' },
                      { key: 'apa', label: 'APA' },
                    ],
                    onClick: ({ key }) => showCite(item, key),
                  }}
                >
                  <Button size="small" icon={<CopyOutlined />}>
                    引用
                  </Button>
                </Dropdown>,
                <Popconfirm key="del" title="删除该文献？" okButtonProps={{ danger: true }} onConfirm={() => remove.mutate(item.id)}>
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space wrap size={6}>
                    <Typography.Text strong>{item.title || '未命名文献'}</Typography.Text>
                    <Tag color={STATUS[item.status]?.color}>{STATUS[item.status]?.label ?? item.status}</Tag>
                    {typeof item.score === 'number' && item.score > 0 && (
                      <Tag variant="filled">相关度 {item.score.toFixed(2)}</Tag>
                    )}
                  </Space>
                }
                description={
                  <Flex vertical gap={4}>
                    <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                      {[item.authors, item.journal, item.pub_year, item.doi].filter(Boolean).join(' · ')}
                    </Typography.Text>
                    {item.notes && (
                      <Typography.Paragraph style={{ margin: 0, fontSize: 13 }} ellipsis={{ rows: 2 }}>
                        笔记：{item.notes}
                      </Typography.Paragraph>
                    )}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      更新于 {dayjs(item.updated_at).format('YYYY-MM-DD HH:mm')}
                    </Typography.Text>
                  </Flex>
                }
              />
            </List.Item>
          )}
        />
      </Card>

      <Modal
        title="DOI 导入"
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={() => importForm.submit()}
        confirmLoading={importDoi.isPending}
        destroyOnHidden
      >
        <Form form={importForm} layout="vertical" onFinish={(v) => importDoi.mutate(v)}>
          <Form.Item name="doi" label="DOI" extra="例如 10.1038/s41586-023-00000-0，条目信息将自动从 Crossref 拉取">
            <Input placeholder="10.xxxx/xxxxx" />
          </Form.Item>
          <Form.Item name="title" label="或手动填写标题">
            <Input placeholder="不填 DOI 时必填" />
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" placeholder="输入后回车" />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title="阅读笔记"
        open={Boolean(editItem)}
        onClose={() => setEditItem(null)}
        width={560}
        extra={
          <Button type="primary" loading={update.isPending} onClick={() => editForm.submit()}>
            保存
          </Button>
        }
        destroyOnHidden
      >
        {editItem && (
          <Flex vertical gap={12}>
            <Typography.Text strong>{editItem.title}</Typography.Text>
            <Form form={editForm} layout="vertical" onFinish={(v) => update.mutate(v)}>
              <Form.Item name="status" label="阅读状态">
                <Select options={Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }))} />
              </Form.Item>
              <Form.Item name="tags" label="标签">
                <Select mode="tags" />
              </Form.Item>
              <Form.Item name="notes" label="笔记">
                <Input.TextArea rows={12} placeholder="记录方法、结论、可复用点…" />
              </Form.Item>
            </Form>
          </Flex>
        )}
      </Drawer>

      <Modal
        title={citeItem ? `引用 · ${citeItem.title}` : ''}
        open={Boolean(citeItem)}
        onCancel={() => setCiteItem(null)}
        footer={[
          <Button key="close" onClick={() => setCiteItem(null)}>
            关闭
          </Button>,
          <Button
            key="copy"
            type="primary"
            icon={<CopyOutlined />}
            onClick={async () => {
              await navigator.clipboard.writeText(citeText);
              message.success('已复制');
            }}
          >
            复制
          </Button>,
        ]}
        width={640}
      >
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7, margin: 0 }}>{citeText}</pre>
      </Modal>
    </Flex>
  );
}