import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Input,
  Listy,
  Modal,
  Popconfirm,
  Row,
  Space,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { DeleteOutlined, DownloadOutlined, EditOutlined, ExportOutlined, PartitionOutlined } from '@ant-design/icons';
import { api } from '../services/api';

import { formatDateTime, formatSize } from '../utils/format';
interface Drawing {
  id: string;
  name: string;
  size: number;
  updated_at: string;
}

export default function Drawings() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Drawing | null>(null);
  const [name, setName] = useState('');

  const { data, isLoading } = useQuery({ queryKey: ['drawings'], queryFn: api.drawings, staleTime: 15_000 });

  const rename = useMutation({
    mutationFn: ({ id, n }: { id: string; n: string }) =>
      fetch(`/api/drawings/${id}/rename`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': decodeURIComponent(
            document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] || '',
          ),
        },
        body: JSON.stringify({ name: n }),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || '重命名失败');
        return r.json();
      }),
    onSuccess: () => {
      message.success('已重命名');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['drawings'] });
    },
    onError: (e: Error) => message.error(e.message),
  });

  const del = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/drawings/${id}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          'X-CSRF-Token': decodeURIComponent(
            document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] || '',
          ),
        },
      }),
    onSuccess: () => {
      message.success('已删除');
      void qc.invalidateQueries({ queryKey: ['drawings'] });
    },
  });

  const items: Drawing[] = data?.drawings ?? [];

  return (
    <Flex vertical gap={16}>
      <Card
        size="small"
        title={
          <Space>
            <PartitionOutlined style={{ color: '#2563EB' }} />
            我的科研流程图
          </Space>
        }
        extra={
          <Space>
            <Button size="small" onClick={() => navigate('/tools?tool=drawio')}>
              打开绘图器
            </Button>
            <Button size="small" type="primary" onClick={() => navigate('/tools?tool=drawio')}>
              新建流程图
            </Button>
          </Space>
        }
      >
        {isLoading ? (
          <Empty description="加载中…" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : items.length === 0 ? (
          <Empty description="还没有保存的图形，去「绘图工具」新建一个吧" />
        ) : (
          <Listy
            items={items}
            rowKey="id"
            height={Math.min(items.length * 72, 480)}
            itemRender={(d: Drawing) => (
              <Flex gap={12} align="center" justify="space-between" style={{ padding: '8px 4px' }}>
                <div style={{ minWidth: 0 }}>
                  <Typography.Text strong>{d.name}</Typography.Text>
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {formatDateTime(d.updated_at)} · {formatSize(d.size)}
                    </Typography.Text>
                  </div>
                </div>
                <Space size={4}>
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => {
                      setEditing(d);
                      setName(d.name);
                    }}
                  >
                    重命名
                  </Button>
                  <Button
                    size="small"
                    icon={<ExportOutlined />}
                    onClick={() => navigate(`/tools?tool=drawio&drawing=${encodeURIComponent(d.id)}`)}
                  >
                    继续编辑
                  </Button>
                  <Button size="small" icon={<DownloadOutlined />} href={`/api/drawings/${d.id}/download`}>
                    下载
                  </Button>
                  <Popconfirm title="删除该图形？" onConfirm={() => del.mutate(d.id)}>
                    <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              </Flex>
            )}
          />
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card size="small" title="使用说明">
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              <li>在「绘图工具」里用嵌入式 draw.io 编辑，保存后图形会存入你的账号。</li>
              <li>「导出到个人目录」会把 .drawio 写入你的个人目录，可在文件共享中继续管理。</li>
              <li>图形内容仅保存在服务端数据库，不含任何脚本时才会被导出为可安全打开的文件。</li>
            </ul>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small" title="格式说明">
            <Space size={6} wrap>
              <Tag variant="filled" color="blue">
                .drawio
              </Tag>
              <Tag variant="filled">XML</Tag>
              <Tag variant="filled">SVG / PNG 导出</Tag>
            </Space>
          </Card>
        </Col>
      </Row>

      <Modal
        open={!!editing}
        title="重命名图形"
        okText="保存"
        cancelText="取消"
        confirmLoading={rename.isPending}
        onOk={() => editing && rename.mutate({ id: editing.id, n: name })}
        onCancel={() => setEditing(null)}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
      </Modal>
    </Flex>
  );
}
