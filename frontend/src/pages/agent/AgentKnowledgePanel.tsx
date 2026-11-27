import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Flex,
  Input,
  Select,
  Skeleton,
  Space,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { BookOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../../services/api.ts';
import { errText } from '../../utils/err.ts';
import { tokens } from '../../theme/tokens.ts';
import KnowledgeAsk from '../../components/KnowledgeAsk.tsx';

interface Props {
  view: 'ask' | 'memory';
  onChange: (view: 'ask' | 'memory') => void;
  memoryCount?: number;
  narrow: boolean;
}

export default function AgentKnowledgePanel({ view, onChange, memoryCount, narrow }: Props) {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [memoryQ, setMemoryQ] = useState('');
  const [memoryKind, setMemoryKind] = useState('');

  const memoriesQuery = useQuery({
    queryKey: ['agent-memories', memoryQ, memoryKind],
    queryFn: () => api.agentMemories(memoryQ, memoryKind, 100),
    staleTime: 15_000,
  });

  const deleteMemoryMut = useMutation({
    mutationFn: (id: string) => api.agentMemoryDelete(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent-memories'] });
      void qc.invalidateQueries({ queryKey: ['agent-status'] });
      message.success('已删除记忆');
    },
    onError: (error: unknown) => message.error(`删除记忆失败：${errText(error)}`),
  });

  const renderMemoryPanel = () => {
    if (memoriesQuery.isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;
    if (memoriesQuery.isError) {
      return <Alert type="error" showIcon title="记忆加载失败" description={errText(memoriesQuery.error)} />;
    }
    const memories = memoriesQuery.data?.memories ?? [];
    if (memories.length === 0) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={memoryQ || memoryKind ? '没有匹配的记忆' : '还没有记忆，对话时可点“记住”或由助手自动写入'}
        />
      );
    }
    return (
      <Flex vertical gap={10}>
        {memories.map((memory) => (
          <Card
            key={memory.id}
            size="small"
            styles={{ body: { padding: 12 } }}
            title={
              <Flex align="center" gap={6} wrap>
                <Tag variant="filled" color="blue">{memory.kind}</Tag>
                <Typography.Text strong ellipsis style={{ maxWidth: 280 }}>
                  {memory.title || '未命名记忆'}
                </Typography.Text>
              </Flex>
            }
            extra={
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label="删除记忆"
                loading={deleteMemoryMut.isPending}
                onClick={() => {
                  modal.confirm({
                    title: '删除这条记忆？',
                    content: memory.title || memory.content.slice(0, 40),
                    okText: '删除',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: () => deleteMemoryMut.mutateAsync(memory.id),
                  });
                }}
              />
            }
          >
            <Typography.Paragraph
              style={{ marginBottom: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
              ellipsis={{ rows: 4, expandable: true, symbol: '展开' }}
            >
              {memory.content}
            </Typography.Paragraph>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {memory.updatedAt ? dayjs(memory.updatedAt).fromNow() : ''}
              {memory.sourceSession ? ' · 来自会话' : ''}
            </Typography.Text>
          </Card>
        ))}
      </Flex>
    );
  };

  return (
    <Card
      size="small"
      styles={{ body: { padding: 16 } }}
      title={
        <Space size={8}>
          <BookOutlined style={{ color: tokens.colorPrimary }} />
          <Typography.Text strong>知识与记忆</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            知识库问答、私有文档与跨会话长期记忆统一管理
          </Typography.Text>
        </Space>
      }
      extra={
        <Button size="small" onClick={() => navigate('/knowledge')}>
          管理知识库
        </Button>
      }
    >
      <Tabs
        activeKey={view}
        onChange={(key) => onChange(key as 'ask' | 'memory')}
        items={[
          {
            key: 'ask',
            label: '知识库问答',
            children: <KnowledgeAsk bare height={narrow ? '48vh' : 'calc(100vh - 360px)'} />,
          },
          {
            key: 'memory',
            label: `长期记忆${memoryCount ? ` (${memoryCount})` : ''}`,
            children: (
              <Flex vertical gap={12}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  记忆会在每次对话开始时自动注入，助手可自行检索、写入或遗忘。共 {memoriesQuery.data?.total ?? 0} 条。
                </Typography.Text>
                <Flex gap={8} wrap>
                  <Input.Search
                    allowClear
                    placeholder="搜索记忆内容"
                    style={{ flex: 1, minWidth: 180 }}
                    onSearch={(value) => setMemoryQ(value.trim())}
                  />
                  <Select
                    style={{ width: 120 }}
                    value={memoryKind}
                    onChange={setMemoryKind}
                    options={[
                      { value: '', label: '全部类型' },
                      { value: 'fact', label: '事实' },
                      { value: 'preference', label: '偏好' },
                      { value: 'lesson', label: '经验' },
                      { value: 'project', label: '项目' },
                      { value: 'note', label: '摘录' },
                    ]}
                  />
                  <Tooltip title="刷新记忆">
                    <Button
                      icon={<ReloadOutlined />}
                      loading={memoriesQuery.isFetching}
                      onClick={() => void memoriesQuery.refetch()}
                    />
                  </Tooltip>
                </Flex>
                {renderMemoryPanel()}
              </Flex>
            ),
          },
        ]}
      />
    </Card>
  );
}
