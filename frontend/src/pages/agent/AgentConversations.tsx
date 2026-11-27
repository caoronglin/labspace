import { useMemo, useState } from 'react';
import { Conversations } from '@ant-design/x';
import { Flex, Input, Typography } from 'antd';
import { MessageOutlined, SearchOutlined } from '@ant-design/icons';
import type { AgentSession } from '../../services/api.ts';
import { relTime } from './parse.ts';

interface Props {
  sessions: AgentSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

/** Ant Design X 会话列表：按今天/更早分组，支持搜索与删除菜单。 */
export default function AgentConversations({ sessions, activeId, onSelect, onDelete }: Props) {
  const [keyword, setKeyword] = useState('');
  const items = useMemo(() => {
    const today = new Date().toLocaleDateString('sv-SE');
    const term = keyword.trim().toLowerCase();
    const visible = term
      ? sessions.filter((session) => `${session.title || ''} ${session.model || ''}`.toLowerCase().includes(term))
      : sessions;
    return visible.map((session) => ({
      key: session.id,
      label: (
        <Flex vertical gap={0} style={{ minWidth: 0 }}>
          <Typography.Text strong ellipsis style={{ fontSize: 13, maxWidth: 220 }}>
            {session.title || '未命名会话'}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {relTime(session.updated_at) || '刚刚'} · {session.message_count ?? 0} 条
          </Typography.Text>
        </Flex>
      ),
      icon: <MessageOutlined />,
      group: session.updated_at && session.updated_at.startsWith(today) ? '今天' : '更早',
    }));
  }, [sessions, keyword]);

  return (
    <Flex vertical gap={8} style={{ height: '100%', minHeight: 0 }}>
      <Input
        size="small"
        allowClear
        prefix={<SearchOutlined />}
        placeholder="搜索会话"
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        aria-label="搜索会话"
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid var(--ant-color-border-secondary)', borderRadius: 10, padding: 4 }}>
        <Conversations
          items={items}
          activeKey={activeId ?? undefined}
          groupable={{ collapsible: true }}
          onActiveChange={(key) => onSelect(String(key))}
          menu={(item) => ({
            items: [
              {
                key: 'delete',
                label: '删除会话',
                danger: true,
                onClick: () => onDelete(String(item.key)),
              },
            ],
          })}
        />
      </div>
    </Flex>
  );
}
