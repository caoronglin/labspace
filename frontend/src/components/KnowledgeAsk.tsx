import { useMemo, useState } from 'react';
import { Avatar, Card, Empty, Flex, Modal, Select, Spin, Tag, Typography, theme } from 'antd';
import { Bubble, Prompts, Sender, Welcome } from '@ant-design/x';
import { LinkOutlined, RobotOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type KnowledgeDoc, type RagCitation } from '../services/api';
import { resolveDisplayName, usePeopleMap, type PeopleMap } from '../utils/displayName';

const PROMPTS = [
  { key: 'qc', label: 'RNA-seq 质控的标准流程是什么？', description: '检索实验流程与工具说明' },
  { key: 'deg', label: '差异表达分析常用哪些工具？', description: '检索分析文档' },
  { key: 'server', label: '如何访问实验室服务器和实训平台？', description: '检索平台使用说明' },
  { key: 'plants', label: '知识库中有哪些植物学数据库资料？', description: '检索数据库条目' },
];

interface ChatMsg {
  key: string;
  role: 'user' | 'ai';
  content: string;
  pending?: boolean;
  warning?: string;
  mode?: 'generated' | 'retrieval' | 'empty';
  citations?: RagCitation[];
}

function formatTime(v?: string) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('zh-CN');
}

function parentOf(path: string) {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

interface Props {
  /** 放在 Agent 页时由外层控制高度，避免再套一层卡片。 */
  bare?: boolean;
  height?: number | string;
}

export default function KnowledgeAsk({ bare = false, height = '58vh' }: Props) {
  const { token } = theme.useToken();
  // 人员目录：文档作者显示姓名而不是账号名
  const peopleMap = usePeopleMap();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const [askSpace, setAskSpace] = useState(0);
  const [askCategory, setAskCategory] = useState('');
  const [viewDocId, setViewDocId] = useState<number | null>(null);

  const spaces = useQuery({
    queryKey: ['knowledge-spaces'],
    queryFn: api.knowledgeSpaces,
    staleTime: 30_000,
  });
  const facets = useQuery({
    queryKey: ['knowledge-facets', askSpace],
    queryFn: () => api.knowledgeCategories(askSpace || undefined),
    staleTime: 30_000,
  });
  const viewDoc = useQuery({
    queryKey: ['knowledge-doc', viewDocId],
    queryFn: () => api.knowledgeGet(viewDocId as number),
    enabled: viewDocId != null,
  });

  const categories = facets.data?.categories ?? [];
  const spaceOptions = useMemo(
    () => [
      { value: 0, label: '全部知识库' },
      ...(spaces.data?.items ?? []).map((s) => ({ value: s.id, label: `${s.name}（${s.docs}）` })),
    ],
    [spaces.data],
  );

  const ask = async (override?: string) => {
    const question = (override ?? draft).trim();
    if (!question || asking) return;
    const uid = `${Date.now()}`;
    const answerKey = `${uid}-a`;
    setMessages((prev) => [
      ...prev,
      { key: uid, role: 'user', content: question },
      { key: answerKey, role: 'ai', content: '', pending: true },
    ]);
    setDraft('');
    setAsking(true);
    try {
      const res = await api.knowledgeAsk(question, 6, askCategory, askSpace);
      const fallback =
        res.mode === 'retrieval'
          ? '已检索到与问题相关的原文片段。生成模型尚未接入，请查看下方引用。'
          : '知识库中暂未找到相关资料。';
      setMessages((prev) =>
        prev.map((m) =>
          m.key === answerKey
            ? {
                ...m,
                pending: false,
                content: res.answer || fallback,
                warning: res.warning,
                mode: res.mode,
                citations: res.citations,
              }
            : m,
        ),
      );
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) =>
          m.key === answerKey
            ? { ...m, pending: false, content: `问答失败：${(e as Error).message || '请稍后重试'}` }
            : m,
        ),
      );
    } finally {
      setAsking(false);
    }
  };

  const bubbleRoles = {
    user: { placement: 'end' as const, variant: 'filled' as const, shape: 'round' as const },
    ai: {
      placement: 'start' as const,
      variant: 'outlined' as const,
      avatar: (
        <Avatar
          size={30}
          icon={<RobotOutlined />}
          style={{ background: token.colorPrimaryBg, color: token.colorPrimary }}
        />
      ),
    },
  };

  const bubbleItems = messages.map((m) => ({
    key: m.key,
    role: m.role,
    content: m.content,
    loading: m.pending,
    footer:
      m.role === 'ai' && m.citations?.length ? (
        <Flex vertical gap={8} style={{ marginTop: 4 }}>
          {m.warning ? (
            <Typography.Text type="warning" style={{ fontSize: 12.5 }}>
              {m.warning}
            </Typography.Text>
          ) : null}
          <Flex vertical gap={6}>
            {m.citations.map((c) => (
              <div
                key={c.chunkId}
                role="button"
                tabIndex={0}
                onClick={() => setViewDocId(c.docId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setViewDocId(c.docId);
                }}
                style={{
                  cursor: 'pointer',
                  padding: '8px 10px',
                  borderRadius: token.borderRadius,
                  background: token.colorFillQuaternary,
                  border: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <Flex gap={8} align="center">
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                    [{c.n}]
                  </Tag>
                  <Typography.Text strong ellipsis style={{ flex: 1, fontSize: 13 }}>
                    {c.title}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    相关度 {c.score.toFixed(2)}
                  </Typography.Text>
                </Flex>
                <Typography.Paragraph
                  type="secondary"
                  ellipsis={{ rows: 2 }}
                  style={{ margin: '4px 0 0', fontSize: 12.5 }}
                >
                  {c.excerpt.replace(/\n+/g, ' ')}
                </Typography.Paragraph>
                <Flex gap={6} wrap align="center" style={{ marginTop: 4 }}>
                  <Tag variant="filled" color={c.category ? 'purple' : 'default'}>
                    {c.category || '未分类'}
                  </Tag>
                  {c.filePath ? (
                    <Typography.Link
                      style={{ fontSize: 12 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(
                          `/files?source=${encodeURIComponent(c.fileSource || 'users')}&dir=${encodeURIComponent(
                            parentOf(c.filePath ?? ''),
                          )}`,
                        );
                      }}
                    >
                      <LinkOutlined /> {c.filePath}
                    </Typography.Link>
                  ) : null}
                </Flex>
              </div>
            ))}
          </Flex>
        </Flex>
      ) : null,
  }));

  const body = (
    <>
      <div
        style={{
          minHeight: 320,
          maxHeight: height,
          overflowY: 'auto',
          paddingInline: 4,
          marginBottom: 12,
        }}
      >
        {messages.length ? (
          <Bubble.List items={bubbleItems} role={bubbleRoles} autoScroll />
        ) : (
          <Flex vertical align="center" gap={28} style={{ padding: '36px 8px' }}>
            <Welcome
              icon={
                <Avatar
                  size={48}
                  icon={<RobotOutlined />}
                  style={{ background: token.colorPrimaryBg, color: token.colorPrimary }}
                />
              }
              title="实验室知识库问答"
              description="先从文档库入库资料，再用自然语言提问；答案会标注引用来源，并遵循文档可见范围。"
            />
            <Prompts title="可以这样问" items={PROMPTS} wrap onItemClick={({ data }) => ask(String(data.label))} />
          </Flex>
        )}
      </div>
      <Flex gap={8} align="center" wrap style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
          检索范围
        </Typography.Text>
        <Select
          size="small"
          style={{ minWidth: 160 }}
          value={askSpace}
          onChange={(v) => {
            setAskSpace(v);
            setAskCategory('');
          }}
          options={spaceOptions}
        />
        <Select
          size="small"
          variant="borderless"
          style={{ minWidth: 150 }}
          value={askCategory}
          onChange={setAskCategory}
          options={[
            { value: '', label: '全部分类' },
            ...categories
              .filter((c) => c.docs > 0)
              .map((c) => ({ value: c.name, label: `${c.label}（${c.docs}）` })),
          ]}
        />
        {askCategory ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            只在「{askCategory}」里检索
          </Typography.Text>
        ) : null}
      </Flex>
      <Sender
        value={draft}
        onChange={setDraft}
        onSubmit={() => ask()}
        loading={asking}
        placeholder="向知识库提问，回车发送"
        autoSize={{ minRows: 1, maxRows: 4 }}
      />
      <Modal
        open={viewDocId != null}
        title={viewDoc.data?.item.title ?? '引用原文'}
        width={760}
        footer={null}
        onCancel={() => setViewDocId(null)}
        destroyOnHidden
      >
        {viewDoc.isLoading ? (
          <Flex justify="center" style={{ padding: 32 }}>
            <Spin />
          </Flex>
        ) : viewDoc.data?.item ? (
          <CitationDoc doc={viewDoc.data.item} peopleMap={peopleMap} />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="引用文档不存在或无权访问" />
        )}
      </Modal>
    </>
  );

  if (bare) return body;

  return (
    <Card
      styles={{ body: { padding: 16 } }}
      title={
        <Flex gap={8} align="center" wrap>
          <ThunderboltOutlined style={{ color: token.colorPrimary }} />
          <Typography.Text strong>知识问答</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            FlashRAG 检索 · 按知识库与分类过滤 · 回答带原文引用
          </Typography.Text>
        </Flex>
      }
    >
      {body}
    </Card>
  );
}

function CitationDoc({ doc, peopleMap }: { doc: KnowledgeDoc; peopleMap: PeopleMap }) {
  return (
    <Flex vertical gap={10}>
      <Flex gap={8} wrap align="center">
        <Tag color="purple" variant="filled">
          {doc.spaceName || '未归档'}
        </Tag>
        <Tag variant="filled" color={doc.category ? 'purple' : 'default'}>
          {doc.category || '未分类'}
        </Tag>
        <Typography.Text type="secondary">
          {resolveDisplayName(doc.owner, peopleMap, doc.ownerName)} · 更新 {formatTime(doc.updatedAt)}
        </Typography.Text>
      </Flex>
      <Typography.Paragraph
        style={{
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: 1.75,
          maxHeight: '60vh',
          overflowY: 'auto',
        }}
      >
        {doc.body || doc.excerpt}
      </Typography.Paragraph>
    </Flex>
  );
}