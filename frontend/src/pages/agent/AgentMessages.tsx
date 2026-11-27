import { useState } from 'react';
import { Actions, Bubble, ThoughtChain } from '@ant-design/x';
import { Flex, Tag, Typography } from 'antd';
import { BookOutlined, CopyOutlined, ReloadOutlined, RobotOutlined, SaveOutlined } from '@ant-design/icons';
import MarkdownView from '../../components/MarkdownView.tsx';
import { tokens } from '../../theme/tokens.ts';
import { parseCitations, parseToolCalls } from './parse.ts';
import type { Citation, LocalMessage, ToolCall } from './types.ts';

interface Props {
  messages: LocalMessage[];
  onCopy: (text: string) => void;
  onRegenerate: () => void;
  onSaveKnowledge: (text: string) => void;
  onSaveMemory: (text: string) => void;
}

function CitationList({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false);
  if (citations.length === 0) return null;
  const shown = open ? citations : citations.slice(0, 3);
  return (
    <Flex vertical gap={6} style={{ marginBottom: 4, maxWidth: 620 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <BookOutlined /> 引用来源 {citations.length} 处
        {citations.length > 3 ? (
          <Typography.Link style={{ fontSize: 12, marginInlineStart: 8 }} onClick={() => setOpen(!open)}>
            {open ? '收起' : '展开全部'}
          </Typography.Link>
        ) : null}
      </Typography.Text>
      {shown.map((citation, index) => (
        <div
          key={citation.key}
          style={{
            padding: '6px 9px',
            borderRadius: tokens.borderRadiusSM,
            background: 'var(--ant-color-fill-quaternary)',
            border: '1px solid var(--ant-color-border-secondary)',
          }}
        >
          <Flex gap={6} align="center" wrap>
            <Tag color="blue" style={{ marginInlineEnd: 0, fontSize: 11 }}>
              [{index + 1}]
            </Tag>
            <Typography.Text style={{ fontSize: 12.5 }} ellipsis={{ tooltip: citation.source }}>
              {citation.source}
            </Typography.Text>
            {citation.chunk === null ? null : (
              <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                第 {citation.chunk + 1} 段
              </Typography.Text>
            )}
            {citation.score === null ? null : (
              <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                相关度 {citation.score.toFixed(2)}
              </Typography.Text>
            )}
          </Flex>
          {citation.text ? (
            <Typography.Paragraph
              type="secondary"
              ellipsis={{ rows: 2 }}
              style={{ margin: '3px 0 0', fontSize: 12 }}
            >
              {citation.text.replace(/\n+/g, ' ')}
            </Typography.Paragraph>
          ) : null}
        </div>
      ))}
    </Flex>
  );
}

function ToolChain({ tools }: { tools: ToolCall[] }) {
  if (tools.length === 0) return null;
  return (
    <ThoughtChain
      line="dashed"
      items={tools.map((tool) => {
        const failed = /error|fail|失败/i.test(tool.status);
        let toolStatus: 'error' | 'success' | undefined;
        if (failed) toolStatus = 'error';
        else if (tool.status) toolStatus = 'success';
        return {
          key: tool.key,
          title: tool.name,
          description: tool.status || undefined,
          status: toolStatus,
          collapsible: true,
          content: (
            <div style={{ fontSize: 12 }}>
              {tool.args ? (
                <div style={{ marginBottom: 6 }}>
                  <Typography.Text type="secondary">调用参数</Typography.Text>
                  <pre style={codeStyle}>{tool.args}</pre>
                </div>
              ) : null}
              {tool.result ? (
                <div>
                  <Typography.Text type="secondary">执行结果</Typography.Text>
                  <pre style={codeStyle}>{tool.result}</pre>
                </div>
              ) : null}
            </div>
          ),
        };
      })}
    />
  );
}

const codeStyle = {
  margin: '4px 0 0',
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-all' as const,
  background: 'var(--ant-color-fill-quaternary)',
  padding: 8,
  borderRadius: tokens.borderRadiusSM,
};

export default function AgentMessages({ messages, onCopy, onRegenerate, onSaveKnowledge, onSaveMemory }: Props) {
  const items = messages.map((message) => {
    const tools = parseToolCalls(message.meta);
    const isUser = message.role === 'user';
    const isAi = message.role === 'assistant';
    const emptyContent = message.streaming && !message.content ? '' : message.content || '（无内容）';
    const content = isAi ? <MarkdownView source={emptyContent} /> : emptyContent;
    return {
      key: message.id,
      role: message.role,
      content,
      loading: message.streaming && !message.content,
      streaming: message.streaming,
      avatar: isUser ? undefined : <RobotOutlined style={{ color: tokens.colorPrimary }} />,
      footer: isAi ? (
        <Flex vertical gap={6} align="flex-start">
          <CitationList citations={parseCitations(tools)} />
          <ToolChain tools={tools} />
          <Actions
            items={[
              { key: 'copy', icon: <CopyOutlined />, label: '复制' },
              ...(message.streaming
                ? []
                : [
                    { key: 'regenerate', icon: <ReloadOutlined />, label: '重新生成' },
                    { key: 'knowledge', icon: <BookOutlined />, label: '存入知识库' },
                    { key: 'memory', icon: <SaveOutlined />, label: '记住' },
                  ]),
            ]}
            onClick={({ key }) => {
              if (key === 'copy') void onCopy(message.content);
              if (key === 'regenerate') void onRegenerate();
              if (key === 'knowledge' && message.content.trim()) onSaveKnowledge(message.content);
              if (key === 'memory' && message.content.trim()) onSaveMemory(message.content);
            }}
          />
        </Flex>
      ) : undefined,
      footerPlacement: 'outer-start' as const,
    };
  });

  return (
    <Bubble.List
      autoScroll
      items={items}
      role={{
        user: { placement: 'end', variant: 'filled', shape: 'corner' },
        ai: { placement: 'start', variant: 'outlined', shape: 'corner' },
        system: { placement: 'start', variant: 'borderless', shape: 'round' },
      }}
      style={{ flex: 1 }}
    />
  );
}
