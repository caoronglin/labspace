import { App, Button, Card, Flex, Space, Tag, Typography } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { api } from '../../services/api.ts';
import { errText } from '../../utils/err.ts';
import { palette } from '../../theme/palette.ts';
import HitlAskForm from './HitlAskForm.tsx';
import type { HitlAnswer, PendingHitl } from './types.ts';

interface Props {
  activeId: string;
  pending: PendingHitl;
  onClear: () => void;
}

/** HITL 面板：只展示服务端请求，答案经正式接口回传。 */
export default function HitlPanel({ activeId, pending, onClear }: Props) {
  const { message } = App.useApp();
  const reply = (body: Record<string, unknown>) => {
    void api
      .agentHitl(activeId, body)
      .then(onClear)
      .catch((error: unknown) => message.error(`回传失败：${errText(error)}`));
  };

  return (
    <Card
      size="small"
      style={{ marginBottom: 10, borderColor: palette.brand.amber500 }}
      title={
        <Flex align="center" gap={8}>
          <SafetyCertificateOutlined style={{ color: palette.brand.amber500 }} />
          <Typography.Text strong style={{ fontSize: 13 }}>
            {pending.kind === 'confirm' ? '需要你确认工具调用' : '助手需要你做选择'}
          </Typography.Text>
          <Tag style={{ fontSize: 11 }}>{pending.toolCalls.length} 项</Tag>
        </Flex>
      }
      extra={
        <Button size="small" type="text" onClick={onClear}>
          忽略
        </Button>
      }
    >
      <Flex vertical gap={10}>
        {pending.kind === 'confirm' ? (
          <>
            {pending.toolCalls.map((call, index) => (
              <div
                key={String(call.id ?? index)}
                style={{ padding: '6px 9px', borderRadius: 6, background: 'var(--ant-color-fill-quaternary)' }}
              >
                <Typography.Text strong style={{ fontSize: 12.5 }}>
                  {call.name || '工具调用'}
                </Typography.Text>
                <Typography.Paragraph
                  type="secondary"
                  ellipsis={{ rows: 3 }}
                  style={{ margin: '3px 0 0', fontSize: 12 }}
                >
                  {call.input || '(无参数)'}
                </Typography.Paragraph>
              </div>
            ))}
            <Space>
              <Button
                size="small"
                danger
                onClick={() =>
                  reply({
                    kind: 'confirm',
                    replyId: pending.replyId,
                    toolCalls: pending.toolCalls,
                    approved: false,
                  })
                }
              >
                拒绝
              </Button>
              <Button
                size="small"
                type="primary"
                onClick={() =>
                  reply({
                    kind: 'confirm',
                    replyId: pending.replyId,
                    toolCalls: pending.toolCalls,
                    approved: true,
                  })
                }
              >
                批准
              </Button>
            </Space>
          </>
        ) : (
          <HitlAskForm
            key={pending.replyId}
            calls={pending.toolCalls}
            onSubmit={(answers: HitlAnswer[]) =>
              reply({
                kind: 'ask',
                replyId: pending.replyId,
                toolCalls: pending.toolCalls,
                answers,
              })
            }
          />
        )}
      </Flex>
    </Card>
  );
}
