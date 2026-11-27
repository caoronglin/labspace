/**
 * 「交给 Agent」跨页交接。
 *
 * 页面把问题、来源与可核对上下文写入当前标签页的一次性信箱；Agent 页取出后
 * 预填输入框，用户可编辑再发送。sessionStorage 保证不跨标签页泄漏，读后即焚。
 */
const HANDOFF_KEY = 'labspace.agent.handoff';

export type AgentHandoff = {
  version: 1;
  source: string;
  title: string;
  prompt: string;
  context?: Record<string, unknown>;
  createdAt: string;
};

export function handoffToAgent(input: string | Omit<AgentHandoff, 'version' | 'createdAt'>): string {
  const handoff: AgentHandoff =
    typeof input === 'string'
      ? {
          version: 1,
          source: '',
          title: '',
          prompt: input,
          createdAt: new Date().toISOString(),
        }
      : {
          ...input,
          version: 1,
          createdAt: new Date().toISOString(),
        };
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
  } catch {
    /* 隐私模式写不了，跳转仍然有效，只是需要用户自己粘贴 */
  }
  return '/agent';
}

/** 兼容旧调用：只取问题文本。 */
export function takeAgentHandoff(): string {
  return takeAgentHandoffContext()?.prompt ?? '';
}

/** 新调用：保留来源与上下文，供 Agent 页生成可编辑的完整提示。 */
export function takeAgentHandoffContext(): AgentHandoff | null {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(HANDOFF_KEY);
    const parsed = JSON.parse(raw) as Partial<AgentHandoff>;
    if (typeof parsed.prompt !== 'string' || !parsed.prompt.trim()) return null;
    return {
      version: 1,
      source: typeof parsed.source === 'string' ? parsed.source : '',
      title: typeof parsed.title === 'string' ? parsed.title : '',
      prompt: parsed.prompt,
      context:
        parsed.context && typeof parsed.context === 'object' && !Array.isArray(parsed.context)
          ? (parsed.context as Record<string, unknown>)
          : undefined,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
