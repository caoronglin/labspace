import { useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Flex, Input, Radio, Typography } from 'antd';
import type { AskQuestion, HitlAnswer, HitlToolCall } from './types.ts';

interface Props {
  calls: HitlToolCall[];
  onSubmit: (answers: HitlAnswer[]) => void;
}

/** AskUser 表单：只解析服务端给出的问题与选项，不自动替用户回答。 */
export default function HitlAskForm({ calls, onSubmit }: Props) {
  const questions = useMemo<AskQuestion[]>(() => {
    for (const call of calls) {
      if (call.name !== 'AskUser' || !call.input) continue;
      try {
        const raw = JSON.parse(call.input) as { questions?: AskQuestion[] };
        if (Array.isArray(raw.questions) && raw.questions.length) return raw.questions;
      } catch {
        // 格式异常时不猜
      }
    }
    return [];
  }, [calls]);

  const [picks, setPicks] = useState<Record<number, string[]>>({});
  const [others, setOthers] = useState<Record<number, string>>({});

  if (!questions.length) {
    return (
      <Alert
        type="info"
        showIcon
        title="助手提出了问题，但当前客户端无法解析选项"
        description="请在命令行或重新提问；不会自动替你回答。"
      />
    );
  }

  const submit = () => {
    onSubmit(
      questions.map((question, index) => ({
        question: question.question,
        selected: picks[index] ?? [],
        other: others[index]?.trim() || null,
      })),
    );
  };

  return (
    <Flex vertical gap={12}>
      {questions.map((question, index) => (
        <div key={`${question.question}-${index}`}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            {question.header ? `[${question.header}] ` : ''}
            {question.question}
          </Typography.Text>
          {question.context ? (
            <Typography.Paragraph type="secondary" style={{ margin: '4px 0', fontSize: 12 }}>
              {question.context}
            </Typography.Paragraph>
          ) : null}
          <div style={{ marginTop: 6 }}>
            {question.multi_select ? (
              <Checkbox.Group
                value={picks[index] ?? []}
                onChange={(values) =>
                  setPicks((prev) => ({ ...prev, [index]: values.map(String) }))
                }
                options={[...question.options.map((option) => option.label), '其他']}
              />
            ) : (
              <Radio.Group
                value={(picks[index] ?? [])[0]}
                onChange={(event) =>
                  setPicks((prev) => ({
                    ...prev,
                    [index]: event.target.value ? [String(event.target.value)] : [],
                  }))
                }
                options={[...question.options.map((option) => option.label), '其他']}
              />
            )}
          </div>
          {(picks[index] ?? []).includes('其他') ? (
            <Input.TextArea
              size="small"
              rows={2}
              style={{ marginTop: 6 }}
              placeholder="请补充你的回答"
              value={others[index] ?? ''}
              onChange={(event) =>
                setOthers((prev) => ({ ...prev, [index]: event.target.value }))
              }
            />
          ) : null}
        </div>
      ))}
      <Button type="primary" size="small" onClick={submit}>
        提交回答
      </Button>
    </Flex>
  );
}
