import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api } from '../../services/api.ts';
import type { AgentMessage, AgentModel, AgentSession } from '../../services/api.ts';
import { errText } from '../../utils/err.ts';
import { takeAgentHandoffContext } from '../../utils/agentHandoff.ts';
import { asRecord, copyText, extractDelta, extractError, pickText, stringify } from './parse.ts';
import type { HitlToolCall, LocalMessage, PendingHitl } from './types.ts';

/** Agent 对话状态层：服务端 query + 本地 SSE 流 + HITL 回传。 */
export function useAgentChat() {
  const { message, modal } = App.useApp();
  const qc = useQueryClient();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [streamError, setStreamError] = useState('');
  const [streamNotice, setStreamNotice] = useState('');
  const [pendingHitl, setPendingHitl] = useState<PendingHitl | null>(null);
  const [selectedModel, setSelectedModel] = useState('');

  const [localSessionId, setLocalSessionId] = useState<string | null>(null);
  const [localMessages, setLocalMessages] = useState<LocalMessage[] | null>(null);
  const localRef = useRef<LocalMessage[] | null>(null);
  localRef.current = localMessages;
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => () => esRef.current?.close(), []);

  // 其它服务页「交给 Agent」送来的问题：进入页面即预填，可编辑后发送。
  useEffect(() => {
    const handoff = takeAgentHandoffContext();
    if (!handoff) return;
    const context = handoff.context
      ? `\n\n页面上下文（仅供参考，请先核对）：\n${JSON.stringify(handoff.context, null, 2).slice(0, 4000)}`
      : '';
    setInput(`${handoff.prompt}${context}`);
  }, []);

  const statusQuery = useQuery({ queryKey: ['agent-status'], queryFn: api.agentStatus });
  const modelsQuery = useQuery({ queryKey: ['agent-models'], queryFn: api.agentModels });
  const quotaQuery = useQuery({ queryKey: ['agent-quota'], queryFn: api.agentQuota });
  const sessionsQuery = useQuery({ queryKey: ['agent-sessions'], queryFn: api.agentSessions });
  const sessionQuery = useQuery({
    queryKey: ['agent-session', activeId],
    queryFn: () => api.agentSession(activeId as string),
    enabled: Boolean(activeId),
  });

  const sessions = useMemo(() => {
    const list = sessionsQuery.data?.sessions ?? [];
    return [...list].sort((a, b) => {
      const at = a.updated_at ? dayjs(a.updated_at).valueOf() : 0;
      const bt = b.updated_at ? dayjs(b.updated_at).valueOf() : 0;
      return bt - at;
    });
  }, [sessionsQuery.data]);

  const models: AgentModel[] = useMemo(
    () => modelsQuery.data?.models ?? statusQuery.data?.models ?? [],
    [modelsQuery.data, statusQuery.data],
  );
  const enabledModels = useMemo(() => models.filter((model) => model.enabled !== false), [models]);
  const activeSession: AgentSession | undefined = useMemo(
    () => sessions.find((session) => session.id === activeId),
    [sessions, activeId],
  );

  useEffect(() => {
    if (activeSession?.model) setSelectedModel(activeSession.model);
  }, [activeSession?.model]);

  useEffect(() => {
    if (selectedModel || statusQuery.isLoading) return;
    const preferred = statusQuery.data?.model;
    const next =
      enabledModels.find(
        (model) => model.id === preferred || (model.provider && `${model.provider}/${model.id}` === preferred),
      )?.id ?? enabledModels[0]?.id;
    if (next) setSelectedModel(next);
  }, [enabledModels, selectedModel, statusQuery.data?.model, statusQuery.isLoading]);

  const pendingIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (activeId || !sessionsQuery.data) return;
    const latest = sessions[0];
    if (latest) setActiveId(latest.id);
  }, [activeId, sessions, sessionsQuery.data]);

  useEffect(() => {
    if (!activeId || !sessionsQuery.data) return;
    if (pendingIdsRef.current.has(activeId)) {
      if (sessions.some((session) => session.id === activeId)) pendingIdsRef.current.delete(activeId);
      return;
    }
    if (!sessions.some((session) => session.id === activeId)) {
      setActiveId(null);
      setLocalMessages(null);
      setLocalSessionId(null);
    }
  }, [activeId, sessions, sessionsQuery.data]);

  const createMut = useMutation({
    mutationFn: (model: string) => api.agentCreateSession('', model),
    onError: (error) => message.error(`新建会话失败：${errText(error)}`),
    onSuccess: ({ session }) => {
      void qc.invalidateQueries({ queryKey: ['agent-sessions'] });
      pendingIdsRef.current.add(session.id);
      setActiveId(session.id);
      setLocalMessages(null);
      setLocalSessionId(null);
      setPendingHitl(null);
      setStreamError('');
      setStreamNotice('');
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.agentDeleteSession(id),
    onError: (error) => message.error(`删除会话失败：${errText(error)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent-sessions'] });
      void qc.invalidateQueries({ queryKey: ['agent-session'] });
    },
  });

  const saveMemoryMut = useMutation({
    mutationFn: (content: string) =>
      api.agentMemoryCreate({
        kind: 'note',
        title: `对话摘录 · ${dayjs().format('MM-DD HH:mm')}`,
        content: content.slice(0, 4000),
        sourceSession: activeId ?? '',
      }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ['agent-memories'] });
      void qc.invalidateQueries({ queryKey: ['agent-status'] });
      message.success(result.deduped ? '这条内容已在长期记忆中' : '已写入长期记忆');
    },
    onError: (error) => message.error(`写入记忆失败：${errText(error)}`),
  });

  const saveKnowledgeMut = useMutation({
    mutationFn: (content: string) => {
      const firstLine =
        content
          .split('\n')
          .map((line) => line.replace(/^#+\s*/, '').trim())
          .find(Boolean) ?? '';
      return api.knowledgeCreate({
        title: (firstLine || `Agent 对话 ${dayjs().format('YYYY-MM-DD')}`).slice(0, 60),
        body: content,
        tags: ['Agent 助手'],
        visibility: 'private',
        roles: [],
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['knowledge'] });
      void qc.invalidateQueries({ queryKey: ['knowledge-spaces'] });
      message.success('已存入私有知识库');
    },
    onError: (error) => message.error(`存入知识库失败：${errText(error)}`),
  });

  const serverMessages: AgentMessage[] = sessionQuery.data?.messages ?? [];
  const displayMessages: LocalMessage[] = useMemo(() => {
    if (localMessages && localSessionId === activeId) return localMessages;
    return serverMessages.map((item) => ({
      id: item.id,
      role: item.role,
      content: item.content,
      meta: item.meta,
      created_at: item.created_at,
    }));
  }, [localMessages, localSessionId, activeId, serverMessages]);

  const syncFromServer = useCallback(
    async (sid: string, fallbackContent?: string) => {
      try {
        const { messages } = await api.agentMessages(sid);
        const mapped: LocalMessage[] = messages.map((item) => ({
          id: item.id,
          role: item.role,
          content: item.content,
          meta: item.meta,
          created_at: item.created_at,
        }));
        const lastLocal = localRef.current?.filter((item) => item.role === 'assistant').pop();
        if (lastLocal && fallbackContent && lastLocal.content.length > 0) {
          const lastServer = mapped.filter((item) => item.role === 'assistant').pop();
          if (!lastServer || lastServer.content.length < lastLocal.content.length) {
            if (lastServer) lastServer.content = fallbackContent;
            else {
              mapped.push({
                id: `local-${sid}`,
                role: 'assistant',
                content: fallbackContent,
                created_at: new Date().toISOString(),
              });
            }
          }
        }
        setLocalSessionId(sid);
        setLocalMessages(mapped);
      } catch {
        setLocalMessages((prev) => (prev ? prev.map((item) => ({ ...item, streaming: false })) : prev));
      } finally {
        void qc.invalidateQueries({ queryKey: ['agent-session', sid] });
        void qc.invalidateQueries({ queryKey: ['agent-sessions'] });
      }
    },
    [qc],
  );

  const finishStream = useCallback(
    (sid: string, opts: { error?: string; notice?: string; fallbackContent?: string }) => {
      esRef.current?.close();
      esRef.current = null;
      setGenerating(false);
      if (opts.error) setStreamError(opts.error);
      if (opts.notice) setStreamNotice(opts.notice);
      void syncFromServer(sid, opts.fallbackContent);
    },
    [syncFromServer],
  );

  const openStream = useCallback(
    (sid: string, assistantId: string) => {
      let settled = false;
      let gotDelta = false;
      let lastContent = '';
      const es = new EventSource(api.agentStreamUrl(sid));
      esRef.current = es;

      const appendDelta = (text: string) => {
        if (!text) return;
        gotDelta = true;
        lastContent += text;
        setLocalMessages((prev) =>
          prev ? prev.map((item) => (item.id === assistantId ? { ...item, content: item.content + text } : item)) : prev,
        );
      };

      const appendTool = (payload: unknown) => {
        const record = asRecord(payload);
        const call = record
          ? {
              name: pickText(record, ['toolName', 'tool_name', 'name', 'tool']) || '工具调用',
              args: stringify(record.arguments ?? record.input ?? record.args ?? record.params),
              result: stringify(record.result ?? record.output ?? record.response ?? record.content),
              status: pickText(record, ['status', 'state']),
            }
          : null;
        if (!call) return;
        setLocalMessages((prev) =>
          prev
            ? prev.map((item) => {
                if (item.id !== assistantId) return item;
                const meta = { ...(item.meta ?? {}) };
                const list = Array.isArray(meta.toolCalls) ? [...(meta.toolCalls as unknown[])] : [];
                list.push(call);
                return { ...item, meta: { ...meta, toolCalls: list } };
              })
            : prev,
        );
      };

      const settle = (opts: { error?: string; notice?: string }) => {
        if (settled) return;
        settled = true;
        finishStream(sid, { ...opts, fallbackContent: gotDelta ? lastContent : undefined });
      };

      es.addEventListener('ready', () => {});
      es.addEventListener('delta', (event) => {
        const raw = (event as MessageEvent).data;
        try {
          appendDelta(extractDelta(JSON.parse(String(raw))));
        } catch {
          appendDelta(extractDelta(String(raw)));
        }
      });
      es.addEventListener('tool', (event) => {
        const raw = (event as MessageEvent).data;
        try {
          appendTool(JSON.parse(String(raw)));
        } catch {
          appendTool({ toolName: String(raw) });
        }
      });

      const onHitl = (kind: 'confirm' | 'ask') => (event: Event) => {
        try {
          const payload = JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>;
          const replyId = String(payload.replyId ?? '');
          const calls = Array.isArray(payload.toolCalls) ? (payload.toolCalls as HitlToolCall[]) : [];
          if (replyId && calls.length) setPendingHitl({ kind, replyId, toolCalls: calls });
        } catch {
          // 非法事件不改变确认状态
        }
      };
      es.addEventListener('confirm', onHitl('confirm'));
      es.addEventListener('ask', onHitl('ask'));
      es.addEventListener('done', () => {
        setPendingHitl(null);
        settle({});
      });
      es.addEventListener('error', (event) => {
        const messageEvent = event as MessageEvent;
        if (typeof messageEvent.data === 'string' && messageEvent.data) {
          try {
            settle({ error: extractError(JSON.parse(messageEvent.data)) || '生成出错，请稍后重试' });
          } catch {
            settle({ error: extractError(messageEvent.data) || '生成出错，请稍后重试' });
          }
        }
      });
      es.onerror = () => {
        if (settled) return;
        settled = true;
        es.close();
        if (esRef.current === es) esRef.current = null;
        setGenerating(false);
        void syncFromServer(sid, gotDelta ? lastContent : undefined);
      };
    },
    [finishStream, syncFromServer],
  );

  const send = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim();
      if (!text || generating || !activeId) return;
      setInput('');
      setStreamError('');
      setStreamNotice('');
      setPendingHitl(null);

      const now = new Date().toISOString();
      const assistantId = `local-assistant-${Date.now()}`;
      const next: LocalMessage[] = [
        ...displayMessages,
        { id: `local-user-${Date.now()}`, role: 'user', content: text, created_at: now },
        { id: assistantId, role: 'assistant', content: '', created_at: now, streaming: true },
      ];
      setLocalSessionId(activeId);
      setLocalMessages(next);
      setGenerating(true);
      try {
        await api.agentSend(activeId, text);
      } catch (error) {
        setGenerating(false);
        setStreamError(error instanceof Error ? error.message : '发送失败，请稍后重试');
        void syncFromServer(activeId);
        return;
      }
      openStream(activeId, assistantId);
    },
    [activeId, displayMessages, generating, input, openStream, syncFromServer],
  );

  const stop = useCallback(async () => {
    if (!activeId) return;
    try {
      await api.agentAbort(activeId);
    } catch {
      // 即便远端取消失败也结束本地流
    }
    finishStream(activeId, { notice: '已停止生成' });
  }, [activeId, finishStream]);

  const regenerate = useCallback(async () => {
    if (!activeId || generating) return;
    const lastUser = [...displayMessages].reverse().find((item) => item.role === 'user');
    if (!lastUser) return;
    setStreamError('');
    setStreamNotice('');
    const assistantId = `local-assistant-${Date.now()}`;
    const next: LocalMessage[] = [
      ...displayMessages,
      { id: assistantId, role: 'assistant', content: '', created_at: new Date().toISOString(), streaming: true },
    ];
    setLocalSessionId(activeId);
    setLocalMessages(next);
    setGenerating(true);
    try {
      await api.agentSend(activeId, lastUser.content, true);
    } catch (error) {
      setGenerating(false);
      setStreamError(error instanceof Error ? error.message : '重新生成失败，请稍后重试');
      void syncFromServer(activeId);
      return;
    }
    openStream(activeId, assistantId);
  }, [activeId, displayMessages, generating, openStream, syncFromServer]);

  const handleCopy = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      if (await copyText(text)) message.success('已复制');
      else message.error('复制失败，请手动选择文本');
    },
    [message],
  );

  const selectSession = useCallback(
    (id: string) => {
      if (generating && id !== activeId) {
        message.info('请先停止当前生成，再切换会话');
        return;
      }
      setActiveId(id);
      setStreamError('');
      setStreamNotice('');
    },
    [activeId, generating, message],
  );

  const confirmDeleteSession = useCallback(
    (id: string) => {
      if (generating && id === activeId) {
        message.info('请先停止当前生成，再删除当前会话');
        return;
      }
      modal.confirm({
        title: '删除该会话？',
        content: '删除后不可恢复。',
        okText: '删除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => deleteMut.mutate(id),
      });
    },
    [activeId, deleteMut, generating, message, modal],
  );

  const status = statusQuery.data;
  const skills = useMemo(() => statusQuery.data?.skills ?? [], [statusQuery.data]);
  const fillSkill = useCallback((name: string) => {
    setInput(
      name.includes('深度研究')
        ? `使用「${name}」技能开展系统调研。\n研究问题：\n验收标准：\n范围与已知材料：\n期望输出：`
        : `使用「${name}」技能：`,
    );
    setStreamError('');
    setStreamNotice('');
  }, []);

  const quotaText = useMemo(() => {
    const quotas = quotaQuery.data?.quotas ?? {};
    const used = quotaQuery.data?.used ?? {};
    const perDay = quotas.messages_per_day ?? status?.quotas?.messages_per_day ?? 0;
    return `今日已用 ${used.messagesDay ?? 0}/${perDay} 条 · 累计 token ${used.tokensToday ?? 0}`;
  }, [quotaQuery.data, status]);

  const modelOptions = useMemo(
    () => enabledModels.map((model) => ({ value: model.id, label: model.label || model.id })),
    [enabledModels],
  );

  return {
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
    enabledModels,
    activeSession,
    createMut,
    deleteMut,
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
  };
}

export type AgentChatState = ReturnType<typeof useAgentChat>;
