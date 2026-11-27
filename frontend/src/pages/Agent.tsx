import { useEffect, useState } from 'react';
import { Grid, Segmented, Space, Tag } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import PageShell from '../components/PageShell.tsx';
import AgentHub from './agent/hub/AgentHub.tsx';
import AgentChatPanel from './agent/AgentChatPanel.tsx';
import AgentKnowledgePanel from './agent/AgentKnowledgePanel.tsx';
import { useAgentChat } from './agent/useAgentChat.ts';
import type { AgentMode } from './agent/types.ts';

/** Agent 个人助手页面：只负责模式与深链，对话状态由 useAgentChat 管理。 */
export default function Agent() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const screens = Grid.useBreakpoint();
  const narrow = !screens.lg;
  const chat = useAgentChat();

  const [mode, setMode] = useState<AgentMode>(() => {
    const wanted = searchParams.get('mode') || searchParams.get('tab');
    return wanted === 'kb' || wanted === 'hub' ? wanted : 'chat';
  });
  const [knowledgeView, setKnowledgeView] = useState<'ask' | 'memory'>(() =>
    searchParams.get('view') === 'memory' ? 'memory' : 'ask',
  );

  useEffect(() => {
    const raw = searchParams.get('mode') || searchParams.get('tab');
    if (raw === 'lab') {
      navigate('/workbench?tab=records', { replace: true });
      return;
    }
    const wanted: AgentMode = raw === 'kb' || raw === 'hub' ? raw : 'chat';
    setMode((current) => (current === wanted ? current : wanted));
    setKnowledgeView(raw === 'kb' && searchParams.get('view') === 'memory' ? 'memory' : 'ask');
  }, [searchParams, navigate]);

  const switchMode = (next: AgentMode) => {
    setMode(next);
    setKnowledgeView('ask');
    const params = new URLSearchParams(searchParams);
    if (next === 'chat') params.delete('mode');
    else params.set('mode', next);
    params.delete('tab');
    params.delete('view');
    setSearchParams(params, { replace: true });
  };

  const openMemory = () => {
    setMode('kb');
    setKnowledgeView('memory');
    const params = new URLSearchParams(searchParams);
    params.set('mode', 'kb');
    params.set('view', 'memory');
    params.delete('tab');
    setSearchParams(params, { replace: true });
  };

  const changeKnowledgeView = (next: 'ask' | 'memory') => {
    setKnowledgeView(next);
    const params = new URLSearchParams(searchParams);
    if (next === 'memory') params.set('view', 'memory');
    else params.delete('view');
    setSearchParams(params, { replace: true });
  };

  const modeSwitcher = (
    <Segmented
      value={mode}
      onChange={(value) => switchMode(value as AgentMode)}
      options={[
        { label: 'Agent 对话', value: 'chat' },
        { label: '知识与记忆', value: 'kb' },
        { label: '能力中心', value: 'hub' },
      ]}
    />
  );

  if (mode === 'hub') return <AgentHub embedded extra={modeSwitcher} />;

  return (
    <PageShell
      title="Agent 个人助手"
      description="多步深度调研、数据库检索、文献阅读与工作台协同；回答可沉淀到知识库。"
      extra={
        <Space orientation="horizontal" size={8} wrap>
          {modeSwitcher}
          {mode === 'chat' && chat.generating ? <Tag color="processing" variant="filled">正在生成…</Tag> : null}
        </Space>
      }
    >
      {mode === 'kb' ? (
        <AgentKnowledgePanel
          view={knowledgeView}
          onChange={changeKnowledgeView}
          memoryCount={chat.status?.memoryCount}
          narrow={narrow}
        />
      ) : (
        <AgentChatPanel chat={chat} narrow={narrow} onOpenMemory={openMemory} />
      )}
    </PageShell>
  );
}
