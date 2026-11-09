import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Drawer,
  Flex,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { InboxOutlined, QrcodeOutlined, SwapOutlined } from '@ant-design/icons';
import { QRCodeSVG } from 'qrcode.react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, type LabopsInventoryItem } from '../../services/api';

const KINDS = [
  { value: '', label: '全部' },
  { value: 'sample', label: '样品' },
  { value: 'plasmid', label: '质粒' },
  { value: 'strain', label: '菌株' },
  { value: 'consumable', label: '耗材' },
];
const KIND_LABEL: Record<string, string> = Object.fromEntries(
  KINDS.filter((k) => k.value).map((k) => [k.value, k.label]),
);

export default function InventoryPanel() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [kind, setKind] = useState('');
  const [keyword, setKeyword] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [txItem, setTxItem] = useState<LabopsInventoryItem | null>(null);
  const [labelItem, setLabelItem] = useState<LabopsInventoryItem | null>(null);
  const [historyItem, setHistoryItem] = useState<LabopsInventoryItem | null>(null);
  const [createForm] = Form.useForm();
  const [txForm] = Form.useForm();

  const items = useQuery({
    queryKey: ['labops', 'inventory', kind, keyword, lowOnly],
    queryFn: () => api.labopsInventory({ kind, q: keyword, low: lowOnly }),
  });
  const low = useQuery({ queryKey: ['labops', 'inventory-low'], queryFn: api.labopsLowStock });
  const txs = useQuery({
    queryKey: ['labops', 'inventory-tx', historyItem?.id],
    queryFn: () => api.labopsInventoryTxs(historyItem!.id),
    enabled: Boolean(historyItem),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['labops', 'inventory'] });
    qc.invalidateQueries({ queryKey: ['labops', 'inventory-low'] });
  };

  const create = useMutation({
    mutationFn: (values: any) => api.labopsCreateInventory(values),
    onSuccess: () => {
      message.success('已入库');
      setCreateOpen(false);
      createForm.resetFields();
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const tx = useMutation({
    mutationFn: (values: any) => api.labopsInventoryTx(txItem!.id, values),
    onSuccess: () => {
      message.success('流水已记录');
      setTxItem(null);
      txForm.resetFields();
      refresh();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const columns = [
    {
      title: '条目',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, row: LabopsInventoryItem) => (
        <Flex vertical gap={2}>
          <Typography.Text strong>{name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontFamily: 'var(--d509-mono, monospace)' }}>
            {row.code}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: '类型',
      dataIndex: 'kind',
      key: 'kind',
      width: 90,
      render: (v: string) => <Tag variant="filled">{KIND_LABEL[v] ?? v}</Tag>,
    },
    { title: '位置', dataIndex: 'location', key: 'location', width: 140, render: (v: string) => v || '—' },
    {
      title: '库存',
      key: 'quantity',
      width: 140,
      render: (_: unknown, row: LabopsInventoryItem) => {
        const isLow = Number(row.quantity) <= Number(row.low_threshold);
        return (
          <Space size={6}>
            <Typography.Text strong type={isLow ? 'danger' : undefined}>
              {row.quantity}
            </Typography.Text>
            <Typography.Text type="secondary">{row.unit}</Typography.Text>
            {isLow && <Tag color="red">低</Tag>}
          </Space>
        );
      },
    },
    { title: '警戒线', dataIndex: 'low_threshold', key: 'low_threshold', width: 90 },
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: 150,
      render: (v: string) => dayjs(v).format('MM-DD HH:mm'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 260,
      render: (_: unknown, row: LabopsInventoryItem) => (
        <Space size={4} wrap>
          <Button size="small" icon={<SwapOutlined />} onClick={() => setTxItem(row)}>
            出入库
          </Button>
          <Button size="small" icon={<QrcodeOutlined />} onClick={() => setLabelItem(row)}>
            标签
          </Button>
          <Button size="small" onClick={() => setHistoryItem(row)}>
            流水
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Flex vertical gap={16}>
      {Number(low.data?.count ?? 0) > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`${low.data!.count} 个条目低于警戒线`}
          description={low.data!.items.map((i) => `${i.name}（${i.quantity}${i.unit}）`).join('、')}
        />
      )}
      <Card
        title={
          <Space>
            <InboxOutlined />
            样品 / 质粒 / 菌株 / 耗材台账
          </Space>
        }
        extra={
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            新增条目
          </Button>
        }
      >
        <Flex gap={12} wrap style={{ marginBottom: 12 }} align="center">
          <Segmented value={kind} onChange={(v) => setKind(String(v))} options={KINDS} />
          <Input.Search allowClear placeholder="名称 / 编号 / 位置" style={{ width: 280 }} onSearch={setKeyword} />
          <Button type={lowOnly ? 'primary' : 'default'} onClick={() => setLowOnly((v) => !v)}>
            只看低库存
          </Button>
        </Flex>
        <Table
          rowKey="id"
          size="middle"
          loading={items.isLoading}
          dataSource={items.data?.items ?? []}
          columns={columns as any}
          pagination={{ pageSize: 12, hideOnSinglePage: true }}
        />
      </Card>

      <Modal
        title="新增库存条目"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={create.isPending}
        destroyOnHidden
      >
        <Form
          form={createForm}
          layout="vertical"
          initialValues={{ kind: 'sample', quantity: 1, low_threshold: 0, unit: '份' }}
          onFinish={(v) => create.mutate(v)}
        >
          <Flex gap={12}>
            <Form.Item name="kind" label="类型" style={{ width: 140 }}>
              <Select options={KINDS.filter((k) => k.value)} />
            </Form.Item>
            <Form.Item name="name" label="名称" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input placeholder="例如：B73 叶片 RNA" />
            </Form.Item>
          </Flex>
          <Flex gap={12}>
            <Form.Item name="code" label="编号（留空自动生成）" style={{ flex: 1 }}>
              <Input placeholder="S-260101-ABC123" />
            </Form.Item>
            <Form.Item name="location" label="存放位置" style={{ flex: 1 }}>
              <Input placeholder="-80℃ 冰箱 A2" />
            </Form.Item>
          </Flex>
          <Flex gap={12}>
            <Form.Item name="quantity" label="数量" style={{ width: 140 }}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="unit" label="单位" style={{ width: 120 }}>
              <Input />
            </Form.Item>
            <Form.Item name="low_threshold" label="低库存阈值" style={{ flex: 1 }}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
          </Flex>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={txItem ? `出入库 · ${txItem.name}` : ''}
        open={Boolean(txItem)}
        onCancel={() => setTxItem(null)}
        onOk={() => txForm.submit()}
        confirmLoading={tx.isPending}
        destroyOnHidden
      >
        <Form form={txForm} layout="vertical" initialValues={{ kind: 'out', delta: 1 }} onFinish={(v) => tx.mutate(v)}>
          <Flex gap={12}>
            <Form.Item name="kind" label="类型" style={{ width: 160 }}>
              <Select
                options={[
                  { value: 'in', label: '入库' },
                  { value: 'out', label: '领用出库' },
                  { value: 'loss', label: '损耗' },
                ]}
              />
            </Form.Item>
            <Form.Item name="delta" label="数量" rules={[{ required: true }]} style={{ width: 160 }}>
              <InputNumber min={0.01} step={1} style={{ width: '100%' }} />
            </Form.Item>
          </Flex>
          <Form.Item name="reason" label="原因 / 去向">
            <Input placeholder="例如：RNA-seq 建库使用" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={labelItem ? `二维码标签 · ${labelItem.code}` : ''}
        open={Boolean(labelItem)}
        onCancel={() => setLabelItem(null)}
        footer={null}
        width={360}
        destroyOnHidden
      >
        {labelItem && (
          <Flex vertical align="center" gap={12} style={{ padding: 12 }}>
            <QRCodeSVG value={`LABSPACE:INV:${labelItem.code}`} size={200} level="M" />
            <Typography.Text strong>{labelItem.name}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontFamily: 'var(--d509-mono, monospace)' }}>
              {labelItem.code}
            </Typography.Text>
          </Flex>
        )}
      </Modal>

      <Drawer
        title={historyItem ? `出入库流水 · ${historyItem.name}` : ''}
        open={Boolean(historyItem)}
        onClose={() => setHistoryItem(null)}
        width={520}
      >
        <List
          loading={txs.isLoading}
          dataSource={txs.data?.items ?? []}
          locale={{ emptyText: '暂无流水' }}
          renderItem={(t) => (
            <List.Item>
              <Flex vertical gap={4} style={{ width: '100%' }}>
                <Flex justify="space-between">
                  <Typography.Text type={t.delta >= 0 ? 'success' : 'danger'} strong>
                    {t.delta >= 0 ? `+${t.delta}` : t.delta}
                  </Typography.Text>
                  <Typography.Text type="secondary">{dayjs(t.created_at).format('YYYY-MM-DD HH:mm')}</Typography.Text>
                </Flex>
                <Descriptions size="small" column={1} items={[
                  { key: 'kind', label: '类型', children: t.kind },
                  { key: 'reason', label: '原因', children: t.reason || '—' },
                  { key: 'operator', label: '操作人', children: t.operator },
                ]} />
              </Flex>
            </List.Item>
          )}
        />
      </Drawer>
    </Flex>
  );
}