import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Dropdown,
  Drawer,
  Empty,
  Flex,
  Select,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DeleteOutlined as DeleteIcon,
  MenuOutlined,
  PlusOutlined as PlusIcon,
  ReloadOutlined as ReloadIcon,
  RobotOutlined,
  SaveOutlined as SaveIcon,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Prompts, Sender, Welcome } from '@ant-design/x';
import { tokens } from '../../theme/tokens.ts';
import { palette } from '../../theme/palette.ts';
import AgentConversations from './AgentConversations.tsx';
import AgentMessages from './AgentMessages.tsx';
import HitlPanel from './HitlPanel.tsx';
import type { AgentChatState } from './useAgentChat.ts';

interface Props {
  chat: AgentChatState;
  narrow: boolean;
  onOpenMemory: () => void;
}

export default function AgentChatPanel({ chat, narrow, onOpenMemory }: Props) {
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const {
    activeId,
    selectSession,
    input,
    setInput,
    generating,
    streamError,
    setStreamError,
    streamNotice,
    setStreamNotice,
    pendingHitl,
    setPendingHitl,
    selectedModel,
    setSelectedModel,
    statusQuery,
    modelsQuery,
    quotaQuery,
    sessionsQuery,
    sessionQuery,
    sessions,
    activeSession,
    createMut,
    saveMemoryMut,
    saveKnowledgeMut,
    displayMessages,
    send,
    stop,
    regenerate,
    handleCopy,
    status,
    skills,
    fillSkill,
    quotaText,
    modelOptions,
    confirmDeleteSession,
  } = chat;

  const suggestionItems = useMemo(
    () => [
      ...skills.map((skill) => ({
        key: `skill:${skill.name}`,
        icon: <ThunderboltOutlined style={{ color: tokens.colorPrimary }} />,
        label: skill.name,
        description: skill.description,
      })),
      { key: 'db', label: '检索植物数据库', description: '按物种或基因名查询 UniProt / GBIF' },
      { key: 'lit', label: '查阅文献', description: '用 Europe PMC 检索研究进展' },
      { key: 'todo', label: '记录实验待办', description: '把下一步计划写入个人工作台' },
    ],
    [skills],
  );

  const conversations = (
    <AgentConversations
      sessions={sessions}
      activeId={activeId}
      onSelect={(id) => {
        selectSession(id);
        setMobileSessionsOpen(false);
      }}
      onDelete={confirmDeleteSession}
    />
  );

  const toolbar = (
    <Card size="small" styles={{ body: { padding: '10px 14px' } }} data-testid="agent-toolbar">
      <Flex justify="space-between" align="center" wrap gap={10}>
        <Space wrap size={8}>
          {narrow ? (
            <Button icon={<MenuOutlined />} onClick={() => setMobileSessionsOpen(true)}>
              会话
            </Button>
          ) : null}
          <Button
            type="primary"
            icon={<PlusIcon />}
            loading={createMut.isPending}
            disabled={generating}
            onClick={() => createMut.mutate(selectedModel)}
          >
            新建会话
          </Button>
          {activeId ? (
            <Tooltip title="删除当前会话">
              <Button
                danger
                icon={<DeleteIcon />}
                aria-label="删除当前会话"
                disabled={generating}
                onClick={() => confirmDeleteSession(activeId)}
              />
            </Tooltip>
          ) : null}
        </Space>
        <Space wrap size={8}>
          <Dropdown
            trigger={['click']}
            menu={{
              items:
                skills.length === 0
                  ? [{ key: 'none', label: '管理员尚未启用技能', disabled: true }]
                  : skills.map((skill) => ({
                      key: skill.name,
                      label: (
                        <Flex vertical gap={2} style={{ maxWidth: 300 }}>
                          <Typography.Text strong style={{ fontSize: 13 }}>
                            {skill.name}
                          </Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {skill.description}
                          </Typography.Text>
                        </Flex>
                      ),
                    })),
              onClick: ({ key }) => {
                if (key !== 'none') fillSkill(String(key));
              },
            }}
          >
            <Button icon={<ThunderboltOutlined style={{ color: tokens.colorPrimary }} />}>
              可用技能{skills.length ? ` (${skills.length})` : ''}
            </Button>
          </Dropdown>
          <Tooltip title="长期记忆：跨会话保留的结论、偏好与方法">
            <Button icon={<SaveIcon style={{ color: tokens.colorPrimary }} />} onClick={onOpenMemory}>
              记忆{status?.memoryCount ? ` (${status.memoryCount})` : ''}
            </Button>
          </Tooltip>
          <Tooltip title="刷新会话列表">
            <Button
              icon={<ReloadIcon />}
              loading={sessionsQuery.isFetching}
              aria-label="刷新会话列表"
              onClick={() => void sessionsQuery.refetch()}
            />
          </Tooltip>
        </Space>
      </Flex>
    </Card>
  );

  const noSessions = !sessionsQuery.isLoading && sessions.length === 0;

  const renderChatBody = () => {
    if (noSessions) {
      return (
        <Flex vertical align="center" justify="center" style={{ flex: 1, gap: 12 }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有会话" style={{ margin: '32px 0' }} />
          <Typography.Text type="secondary">点击上方「新建会话」开始对话</Typography.Text>
        </Flex>
      );
    }
    if (!activeId) {
      if (sessionsQuery.isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;
      return (
        <Flex vertical align="center" justify="center" style={{ flex: 1 }}>
          <Empty
            image={<RobotOutlined style={{ fontSize: 48, color: palette.neutral.n250 }} />}
            description={narrow ? '点击「会话」选择历史对话' : '从左侧选择一个会话开始对话'}
          />
        </Flex>
      );
    }
    if (sessionQuery.isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;
    if (sessionQuery.isError) {
      return (
        <Alert
          type="error"
          showIcon
          title="会话加载失败"
          description={sessionQuery.error instanceof Error ? sessionQuery.error.message : '请稍后重试'}
          action={
            <Button size="small" onClick={() => void sessionQuery.refetch()}>
              重试
            </Button>
          }
        />
      );
    }
    return (
      <div style={{ flex: 1, minHeight: 240, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
        {displayMessages.length === 0 ? (
          <Flex vertical align="center" justify="center" style={{ flex: 1, gap: 16, padding: '24px 0' }}>
            <Welcome
              variant="borderless"
              icon={<RobotOutlined style={{ fontSize: 40, color: tokens.colorPrimary }} />}
              title="今天想研究什么？"
              description="我可以做多步深度调研、检索植物与生物医学数据库、查阅文献，并把结论沉淀到知识库与 D509 工作台。"
            />
            <Prompts
              title="试试这些"
              wrap
              items={suggestionItems}
              onItemClick={(info) => {
                const key = String(info.data.key ?? '');
                if (key.startsWith('skill:')) fillSkill(key.slice('skill:'.length));
                else setInput(String(info.data.label));
              }}
            />
          </Flex>
        ) : (
          <AgentMessages
            messages={displayMessages}
            onCopy={(text) => void handleCopy(text)}
            onRegenerate={() => void regenerate()}
            onSaveKnowledge={(text) => saveKnowledgeMut.mutate(text)}
            onSaveMemory={(text) => saveMemoryMut.mutate(text)}
          />
        )}
      </div>
    );
  };

  return (
    <Flex vertical gap={12}>
      {toolbar}
      <Flex gap={12} align="stretch" wrap={narrow} style={{ minHeight: narrow ? 480 : 'calc(100vh - 220px)' }}>
        {narrow ? null : (
          <div style={{ width: 268, flex: '0 0 268px', minHeight: 0 }}>{conversations}</div>
        )}
        <Card
          size="small"
          style={{ flex: 1, minWidth: 0 }}
          styles={{ body: { padding: 16, display: 'flex', flexDirection: 'column', minHeight: narrow ? 480 : 'calc(100vh - 220px)' } }}
          title={
            <Space orientation="horizontal" size={8}>
              <RobotOutlined style={{ color: tokens.colorPrimary }} />
              <Typography.Text strong ellipsis style={{ maxWidth: 280 }}>
                {activeSession?.title || 'Agent 对话'}
              </Typography.Text>
            </Space>
          }
          extra={
            <Flex align="center" gap={8} wrap>
              <Select
                size="small"
                style={{ minWidth: 168 }}
                value={selectedModel || undefined}
                options={modelOptions}
                onChange={setSelectedModel}
                placeholder="选择模型"
                popupMatchSelectWidth={220}
                aria-label="选择模型"
              />
              <Tooltip title="助手后端（AgentScope）是否可达">
                <Tag color={status?.available ? 'green' : 'red'} variant="filled">
                  {status?.available ? '助手在线' : '助手不可用'}
                </Tag>
              </Tooltip>
              <Tooltip title="代码沙箱：无网络、限额运行，执行后容器立即销毁">
                <Tag color={status?.sandbox ? 'blue' : 'default'} variant="filled">
                  {status?.sandbox ? '沙箱就绪' : '沙箱离线'}
                </Tag>
              </Tooltip>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {quotaText}
              </Typography.Text>
            </Flex>
          }
        >
          {status?.available === false ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              title="Agent 服务不可用"
              description={
                <Flex vertical gap={8}>
                  <Typography.Text>{status.reason || '当前无法连接到助手服务，请稍后重试。'}</Typography.Text>
                  <Button
                    size="small"
                    onClick={() => {
                      void statusQuery.refetch();
                      void quotaQuery.refetch();
                      void modelsQuery.refetch();
                    }}
                  >
                    检查助手状态
                  </Button>
                </Flex>
              }
            />
          ) : null}

          {streamError ? (
            <Alert
              type="error"
              showIcon
              closable={{ onClose: () => setStreamError('') }}
              style={{ marginBottom: 12 }}
              title="生成出错"
              description={streamError}
            />
          ) : null}
          {streamNotice ? (
            <Alert
              type="info"
              showIcon
              closable={{ onClose: () => setStreamNotice('') }}
              style={{ marginBottom: 12 }}
              title={streamNotice}
            />
          ) : null}
          {sessionsQuery.isError ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              title="会话列表加载失败"
              description={sessionsQuery.error instanceof Error ? sessionsQuery.error.message : '请稍后重试'}
              action={
                <Button size="small" onClick={() => void sessionsQuery.refetch()}>
                  重试
                </Button>
              }
            />
          ) : null}

          {renderChatBody()}

          {pendingHitl && activeId ? (
            <HitlPanel activeId={activeId} pending={pendingHitl} onClear={() => setPendingHitl(null)} />
          ) : null}

          <div style={{ marginTop: 12 }}>
            <Sender
              value={input}
              onChange={setInput}
              onSubmit={(text) => {
                if (text.trim()) void send(text);
              }}
              loading={generating}
              onCancel={() => void stop()}
              disabled={!activeId}
              autoSize={{ minRows: 2, maxRows: 6 }}
              submitType="enter"
              placeholder={activeId ? '输入你的问题，例如：检索与青蒿素相关的生物医学文献' : '请先选择或新建一个会话'}
              footer={
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Enter 发送，Shift + Enter 换行。回答由平台模型生成，仅供科研参考。
                </Typography.Text>
              }
            />
          </div>
        </Card>
      </Flex>

      <Drawer
        title="会话"
        open={narrow && mobileSessionsOpen}
        onClose={() => setMobileSessionsOpen(false)}
        size={320}
        styles={{ body: { height: '100%', display: 'flex', flexDirection: 'column' } }}
      >
        {conversations}
      </Drawer>
    </Flex>
  );
}
