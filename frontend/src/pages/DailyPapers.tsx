import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Flex,
  Input,
  Listy,
  Pagination,
  Row,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { FilePdfOutlined, LinkOutlined, ReloadOutlined, RobotOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import PageShell from '../components/PageShell';
import { api, type DailyPaper, type DailyPapersResponse } from '../services/api';
import { handoffToAgent } from '../utils/agentHandoff';
import DailySubsCard from './DailySubsCard';

/** 文献源徽标文案：后端 source 取值就是这几个小写串。 */
const SOURCE_LABELS: Record<string, string> = {
  openalex: 'OpenAlex',
  semanticscholar: 'Semantic Scholar',
  crossref: 'Crossref',
  arxiv: 'arXiv',
};

function sourceLabel(source: string): string {
  const key = (source || '').toLowerCase();
  if (!key || key === 'none') return '文献';
  return SOURCE_LABELS[key] ?? source;
}

/**
 * 把一篇论文拼成「AI 精读」的指令，交给 Agent 助手执行。
 *
 * 为什么把要求写进 prompt 而不是自己调模型：
 *   Agent 侧已经有 RAG（可检索本实验室知识库）、工具（查 DOI/引用）与
 *   长期记忆，精读结果还能顺着会话继续追问。这里另调一次模型的话，
 *   会产出两份互不相干的结论，用户也不知道该信哪个。
 */
function buildDeepReadPrompt(paper: DailyPaper): string {
  const lines = [
    '请精读下面这篇论文，按「研究问题 / 方法 / 关键结果 / 局限 / 与我的课题的关系」五段输出，中文作答，不要编造数据。',
    '',
    `标题：${paper.title || '(无)'}`,
  ];
  if (paper.authors?.length) lines.push(`作者：${paper.authors.join(', ')}`);
  if (paper.venue) lines.push(`期刊/会议：${paper.venue}`);
  if (paper.year) lines.push(`年份：${paper.year}`);
  if (paper.doi) lines.push(`DOI：${paper.doi}`);
  if (paper.url) lines.push(`原文：${paper.url}`);
  if (paper.abstract) lines.push('', `摘要：${paper.abstract}`);
  lines.push('', '如果知识库里有相关材料，请一并引用并标出来源；信息不足时请直接说明缺什么。');
  return lines.join('\n');
}

/** 单条论文：标题、来源徽标、年份、期刊、作者、DOI、摘要与全文链接。 */
function PaperItem({ paper }: { paper: DailyPaper }) {
  const navigate = useNavigate();
  const authors = paper.authors ?? [];
  const authorText = authors.slice(0, 3).join('、') + (authors.length > 3 ? ' 等' : '');
  const title = paper.title || '（无标题）';
  return (
    <div style={{ padding: '14px 4px' }}>
      <Flex vertical gap={6} style={{ width: '100%' }}>
        <Flex gap={8} wrap align="baseline">
          <Tag variant="filled" color="purple" style={{ fontSize: 11, marginInlineEnd: 0 }}>
            {sourceLabel(paper.source)}
          </Tag>
          {paper.year ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {paper.year}
            </Typography.Text>
          ) : null}
          {paper.venue ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: paper.venue }}>
              {paper.venue}
            </Typography.Text>
          ) : null}
          {typeof paper.citations === 'number' ? (
            <Tag variant="filled" style={{ fontSize: 11, marginInlineEnd: 0 }}>
              被引 {paper.citations}
            </Tag>
          ) : null}
        </Flex>

        <div style={{ fontSize: 15, fontWeight: 550, lineHeight: 1.4 }}>
          {paper.url ? (
            <a href={paper.url} target="_blank" rel="noreferrer noopener" style={{ color: 'inherit' }}>
              {title}
            </a>
          ) : (
            <span>{title}</span>
          )}
        </div>

        {authorText ? (
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }} ellipsis={{ tooltip: authors.join('、') }}>
            {authorText}
          </Typography.Text>
        ) : null}

        {paper.doi ? (
          <Typography.Text code style={{ fontSize: 11.5 }}>
            {paper.doi}
          </Typography.Text>
        ) : null}

        {paper.abstract ? (
          <Typography.Paragraph
            type="secondary"
            style={{ margin: 0, fontSize: 13 }}
            ellipsis={{ rows: 2, expandable: true, symbol: '展开摘要' }}
          >
            {paper.abstract}
          </Typography.Paragraph>
        ) : null}

        {/* AI 摘要后端可能没有给：没有就整块不渲染，不留空框。 */}
        {paper.aiSummary ? (
          <div
            className="d509-glass"
            style={{ borderRadius: 10, padding: '10px 12px', background: 'var(--ant-color-fill-secondary)' }}
          >
            <Typography.Text strong style={{ fontSize: 12.5 }}>
              <RobotOutlined /> AI 摘要
            </Typography.Text>
            <Typography.Paragraph style={{ margin: '4px 0 0', fontSize: 13 }}>{paper.aiSummary}</Typography.Paragraph>
          </div>
        ) : null}

        <Space size={12} wrap>
          {paper.pdfUrl ? (
            <a href={paper.pdfUrl} target="_blank" rel="noreferrer noopener" style={{ fontSize: 12.5 }}>
              <FilePdfOutlined /> PDF
            </a>
          ) : null}
          {paper.url ? (
            <a href={paper.url} target="_blank" rel="noreferrer noopener" style={{ fontSize: 12.5 }}>
              <LinkOutlined /> 原文
            </a>
          ) : null}
          {/*
            AI 精读：不在这里另建一套摘要管线，而是把论文信息交接给现有的
            Agent 助手（AgentScope）——它已经有 RAG、工具与长期记忆，
            重复造一套只会出现两份互不相干的"AI 结论"。
          */}
          <Button
            size="small"
            type="link"
            style={{ padding: 0, fontSize: 12.5 }}
            icon={<RobotOutlined />}
            onClick={() => {
              navigate(
                handoffToAgent(buildDeepReadPrompt(paper)),
              );
            }}
          >
            AI 精读
          </Button>
        </Space>
      </Flex>
    </div>
  );
}

export default function DailyPapers({ embedded = false }: { embedded?: boolean } = {}) {
  const [day, setDay] = useState<Dayjs>(dayjs());
  const [topicInput, setTopicInput] = useState('');
  const [topic, setTopic] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  /** 最近一次刷新的结果：全源失败时的失败原因只在这里有。 */
  const [note, setNote] = useState<{ key: string; result: DailyPapersResponse } | null>(null);
  const qc = useQueryClient();

  const dayStr = day.format('YYYY-MM-DD');
  const topicKey = topicInput.trim();
  const noteKey = `${dayStr}|${topicKey}`;

  const { data, isFetching, error } = useQuery({
    queryKey: ['daily-papers', dayStr, topic, page, pageSize],
    queryFn: () => api.dailyPapers(dayStr, topic, page, pageSize),
    staleTime: 60_000,
    retry: false,
  });

  const refresh = useMutation({
    mutationFn: () => api.dailyPapersRefresh({ day: dayStr, topic: topicKey }),
    onSuccess: (result) => {
      setNote({ key: noteKey, result });
      setTopic(topicKey);
      setPage(1);
      void qc.invalidateQueries({ queryKey: ['daily-papers'] });
    },
  });

  const applyTopic = () => {
    setTopic(topicKey);
    setPage(1);
  };

  const papers = data?.papers ?? [];
  const activeNote = note?.key === noteKey ? note.result : null;
  const attempts = activeNote?.attempts ?? data?.attempts ?? [];
  /** source="none" 且拿到了每个源的失败原因：说明这轮文献源全挂了，不是"今天没新论文"。 */
  const allSourcesFailed = (data?.source ?? 'none') === 'none' && attempts.length > 0;
  const total = data?.total ?? data?.count ?? papers.length;

  return (
    <PageShell
      embedded={embedded}
      title="每日论文"
      description="按天抓取 OpenAlex / Semantic Scholar / Crossref / arXiv 的文献，条目按人隔离，只有你能看到自己抓过的主题。"
    >
      {/* 自主订阅：每天自动抓，不用天天手点；精读仍走论文卡片上的「AI 精读」 */}
      <DailySubsCard onRan={() => void qc.invalidateQueries({ queryKey: ['daily-papers'] })} />

      <Card size="small" styles={{ body: { padding: 16 } }}>
        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} md={6}>
            <DatePicker
              value={day}
              onChange={(d) => {
                if (!d) return;
                setDay(d);
                setPage(1);
              }}
              format="YYYY-MM-DD"
              allowClear={false}
              style={{ width: '100%' }}
            />
          </Col>
          <Col xs={24} md={12}>
            <Input
              value={topicInput}
              onChange={(e) => setTopicInput(e.target.value)}
              onPressEnter={applyTopic}
              placeholder="如：植物抗旱"
              allowClear
            />
          </Col>
          <Col xs={24} md={6}>
            <Space wrap>
              <Button onClick={applyTopic}>查询</Button>
              <Tooltip title={topicKey ? `抓取 ${dayStr} 的「${topicKey}」` : '请先填写主题'}>
                <span>
                  <Button
                    type="primary"
                    icon={<ReloadOutlined />}
                    loading={refresh.isPending}
                    disabled={!topicKey}
                    onClick={() => refresh.mutate()}
                  >
                    刷新
                  </Button>
                </span>
              </Tooltip>
            </Space>
          </Col>
        </Row>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          主题留空时查看当天全部主题；刷新会重新抓取并落库，同一 (天, 人, 主题) 不会重复抓取。
        </Typography.Text>
      </Card>

      {refresh.isError ? (
        <Alert
          type="error"
          showIcon
          title="刷新失败"
          description={refresh.error instanceof Error ? refresh.error.message : String(refresh.error)}
        />
      ) : null}

      {activeNote ? (
        <Alert
          type={activeNote.source === 'none' ? 'warning' : 'success'}
          showIcon
          title={
            activeNote.source === 'none'
              ? `${activeNote.day} 刷新未成功：所有文献源都不可用`
              : `${activeNote.day} 刷新完成 · 来源 ${sourceLabel(activeNote.source)} · ${activeNote.count} 条`
          }
          description={activeNote.cached ? '命中本地缓存，本次没有重复抓取文献源。' : '已抓取并落库。'}
        />
      ) : null}

      {error && !isFetching ? (
        <Alert
          type="error"
          showIcon
          title="每日论文服务暂时不可用"
          description={error instanceof Error ? error.message : String(error)}
        />
      ) : null}

      {isFetching && !data ? (
        <Card size="small">
          <Skeleton active title={{ width: '40%' }} paragraph={{ rows: 6 }} />
        </Card>
      ) : null}

      {!isFetching && !error && papers.length === 0 ? (
        <Card size="small">
          {allSourcesFailed ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Flex vertical gap={8} align="center">
                  <Typography.Text>本轮所有文献源都不可用</Typography.Text>
                  <Space size={6} wrap>
                    {attempts.map((a, i) => (
                      <Tag key={`${a.source}-${i}`} color="orange" variant="filled">
                        {sourceLabel(a.source)}：{a.status}
                      </Tag>
                    ))}
                  </Space>
                </Flex>
              }
            />
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Flex vertical gap={4} align="center">
                  <Typography.Text>今天该主题暂无新文献</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {dayStr}
                    {topic ? ` · ${topic}` : ''}
                  </Typography.Text>
                </Flex>
              }
            />
          )}
        </Card>
      ) : null}

      {papers.length > 0 ? (
        <Card
          size="small"
          title={
            <Space>
              <span>每日论文</span>
              <Tag variant="filled" style={{ fontSize: 11 }}>
                {total}
              </Tag>
              <Tag variant="filled" color="purple" style={{ fontSize: 11 }}>
                {sourceLabel(data?.source ?? '')}
              </Tag>
            </Space>
          }
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {dayStr}
              {topic ? ` · ${topic}` : ''}
            </Typography.Text>
          }
        >
          <Listy
            items={papers}
            rowKey={(p) => `${p.doi || p.title}-${p.year ?? ''}-${p.source}`}
            itemRender={(p) => <PaperItem paper={p} />}
          />
          {total > pageSize ? (
            <Flex justify="flex-end" style={{ marginTop: 12 }}>
              <Pagination
                size="small"
                current={page}
                pageSize={pageSize}
                total={total}
                showSizeChanger
                pageSizeOptions={[20, 50, 100]}
                showLessItems
                onChange={(p, ps) => {
                  setPage(ps !== pageSize ? 1 : p);
                  setPageSize(ps);
                }}
              />
            </Flex>
          ) : null}
        </Card>
      ) : null}
    </PageShell>
  );
}
