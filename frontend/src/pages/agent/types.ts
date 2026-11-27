import type { AgentMessage } from '../../services/api';

/** 流式消息只在本地保存，服务端落库后由 query cache 接管。 */
export type LocalMessage = Omit<AgentMessage, 'streaming'> & {
  streaming?: boolean;
};

export type Citation = {
  key: string;
  source: string;
  chunk: number | null;
  score: number | null;
  text: string;
};

/** HITL：等待人工确认或 AskUser 回答的工具调用。 */
export type HitlToolCall = {
  id?: string;
  name?: string;
  input?: string;
  suggested_rules?: unknown[];
};

export type PendingHitl = {
  kind: 'confirm' | 'ask';
  replyId: string;
  toolCalls: HitlToolCall[];
};

export type ToolCall = {
  key: string;
  name: string;
  args: string;
  result: string;
  status: string;
};

export type AgentMode = 'chat' | 'kb' | 'hub';

export type AskQuestion = {
  question: string;
  header?: string;
  context?: string;
  options: { label: string; description?: string; preview?: string }[];
  multi_select?: boolean;
};

export type HitlAnswer = {
  question: string;
  selected: string[];
  other: string | null;
};
