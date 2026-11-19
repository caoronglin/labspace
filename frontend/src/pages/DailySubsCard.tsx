/**
 * 每日论文的「自主订阅」卡片。
 *
 * 与 Agent 助手的分工：
 *   * 订阅只负责**按时把论文抓进来**（主题 / 每天几篇 / 是否启用）；
 *   * 精读由论文卡片上的「AI 精读」交接给 Agent（复用它的 RAG 与工具），
 *     本组件不调模型，避免出现两份互不相干的"AI 结论"。
 */
import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Empty,
  Flex,
  Input,
  InputNumber,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DailySub } from '../services/api';
import { errText } from '../utils/err';

const { Text } = Typography;

export default function DailySubsCard({ onRan }: { onRan?: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [topic, setTopic] = useState('');
  const [limit, setLimit] = useState(10);

  const subs = useQuery({
    queryKey: ['daily-subs'],
    queryFn: api.dailySubs,
    staleTime: 30_000,
    retry: false,
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['daily-subs'] });

  const upsert = useMutation({
    mutationFn: (body: { topic: string; limit?: number; enabled?: boolean }) =>
      api.dailySubUpsert(body),
    onSuccess: () => {
      message.success('已保存订阅');
      setTopic('');
      invalidate();
    },
    onError: (e) => message.error(`保存失败：${errText(e)}`),
  });

  const remove = useMutation({
    mutationFn: (t: string) => api.dailySubDelete(t),
    onSuccess: () => {
      message.success('已取消订阅');
      invalidate();
    },
    onError: (e) => message.error(`取消失败：${errText(e)}`),
  });

  const run = useMutation({
    mutationFn: () => api.dailySubRun(),
    onSuccess: (r) => {
      if (r.failed) {
        message.warning(`抓取完成：成功 ${r.done} 条，失败 ${r.failed} 条（详见各行提示）`);
      } else {
        message.success(`已按订阅抓取 ${r.done} 个主题`);
      }
      invalidate();
      onRan?.();
    },
    onError: (e) => message.error(`抓取失败：${errText(e)}`),
  });

  const rows = subs.data?.subscriptions ?? [];

  const columns: ColumnsType<DailySub> = [
    {
      title: '主题',
      dataIndex: 'topic',
      key: 'topic',
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: '每天',
      dataIndex: 'limit',
      key: 'limit',
      width: 80,
      align: 'right',
      render: (v: number) => `${v} 篇`,
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 80,
      render: (v: boolean, row) => (
        <Switch
          size="small"
          checked={v}
          loading={upsert.isPending}
          onChange={(checked) =>
            upsert.mutate({ topic: row.topic, limit: row.limit, enabled: checked })
          }
        />
      ),
    },
    {
      title: '上次抓取',
      key: 'last',
      width: 210,
      render: (_v, row) =>
        row.lastError ? (
          <Tooltip title={row.lastError}>
            <Tag color="red">失败</Tag>
          </Tooltip>
        ) : row.lastRun ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {new Date(row.lastRun).toLocaleString('zh-CN')} · {row.lastCount} 篇
          </Text>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            还没跑过
          </Text>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 80,
      render: (_v, row) => (
        <Popconfirm
          title={`取消订阅「${row.topic}」？`}
          description="已抓到的论文不会被删除，只是不再自动抓。"
          okText="取消订阅"
          cancelText="保留"
          okButtonProps={{ danger: true }}
          onConfirm={() => remove.mutate(row.topic)}
        >
          <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`取消 ${row.topic}`} />
        </Popconfirm>
      ),
    },
  ];

  return (
    <Card
      size="small"
      title="自主订阅"
      extra={
        <Space>
          <Tooltip title="按当前订阅立即抓取一次（不用等到明天）">
            <Button
              size="small"
              icon={<PlayCircleOutlined />}
              loading={run.isPending}
              disabled={!rows.length}
              onClick={() => run.mutate()}
            >
              立即抓取
            </Button>
          </Tooltip>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={subs.isFetching}
            onClick={() => void subs.refetch()}
          >
            刷新
          </Button>
        </Space>
      }
    >
      <Flex vertical gap={12}>
        <Flex gap={8} wrap align="flex-end">
          <Flex vertical gap={4} style={{ flex: '1 1 220px', minWidth: 180 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              订阅主题
            </Text>
            <Input
              placeholder="例如：水稻耐旱 / single-cell RNA-seq"
              value={topic}
              maxLength={120}
              onChange={(e) => setTopic(e.target.value)}
              onPressEnter={() => topic.trim() && upsert.mutate({ topic: topic.trim(), limit })}
            />
          </Flex>
          <Flex vertical gap={4} style={{ width: 110 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              每天篇数
            </Text>
            <InputNumber min={1} max={50} value={limit} onChange={(v) => setLimit(Number(v) || 10)} />
          </Flex>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={!topic.trim()}
            loading={upsert.isPending}
            onClick={() => upsert.mutate({ topic: topic.trim(), limit })}
          >
            订阅
          </Button>
        </Flex>

        <Table<DailySub>
          rowKey="topic"
          size="small"
          columns={columns}
          dataSource={rows}
          loading={subs.isLoading}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有订阅；订阅后每天会自动抓取对应主题的论文"
              />
            ),
          }}
        />

        <Text type="secondary" style={{ fontSize: 12 }}>
          订阅只负责按时把论文抓进来；「精读」请用每篇论文上的「AI 精读」按钮，
          它会连同实验室知识库一起交给 Agent 处理。
        </Text>
      </Flex>
    </Card>
  );
}
