/**
 * 个人工作台 · 每日文献页签（DailyReadingPanel）
 *
 * 交互：
 * - 顶部：日期选择（默认今天）+ 主题/关键词输入 + 「抓取」按钮（Popconfirm 提示会向文献源发请求）；
 * - 列表：文献卡片（标题跳原文、作者、年份、期刊、DOI、摘要可展开）；
 * - 三种状态分开：加载中 Skeleton / 该日无文献 Empty（提示换一个关键词）/ 抓取失败 Alert（带原因）。
 *
 * 用到的接口（沿用 src/services/api.ts 已有方法，本文件不新增接口）：
 * - GET /api/labops/literature/search?q=...  api.labopsLiteratureSearch
 *
 * 说明：后端没有「按日期存文献」的接口，日期只作为本地抓取批次（同一日期的抓取结果会被缓存复用）。
 */
import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Flex,
  Grid,
  Input,
  Popconfirm,
  Row,
  Skeleton,
  Tag,
  Typography,
  type InputRef,
} from 'antd';
import { LinkOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { api, type LabopsLiterature } from '../../services/api';
import { errText } from '../../utils/err';

/* ------------------------------------------------------------------ 小组件 */

/** 文献卡片：标题跳原文，出处信息与摘要 */
function LiteratureCard({ item }: { item: LabopsLiterature }) {
  const meta = [
    item.authors,
    item.pub_year,
    item.journal,
  ].filter((v) => Boolean(v && v.trim()));

  return (
    <Card size="small" variant="outlined" className="d509-card" styles={{ body: { padding: 12 } }}>
      <Flex vertical gap={6}>
        {item.url ? (
          <Typography.Link
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 13.5, fontWeight: 600 }}
          >
            {item.title || '未命名文献'}
          </Typography.Link>
        ) : (
          <Typography.Text strong style={{ fontSize: 13.5 }}>
            {item.title || '未命名文献'}
          </Typography.Text>
        )}

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {meta.length ? meta.join(' · ') : '暂无出处信息'}
        </Typography.Text>

        {item.doi ? (
          <Flex gap={6} align="center" wrap>
            <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
              DOI
            </Typography.Text>
            <Typography.Text code copyable={{ tooltips: '复制 DOI' }} style={{ fontSize: 11.5 }}>
              {item.doi}
            </Typography.Text>
          </Flex>
        ) : null}

        {item.abstract ? (
          <Typography.Paragraph
            type="secondary"
            style={{ margin: 0, fontSize: 12 }}
            ellipsis={{ rows: 2, expandable: true, symbol: '展开摘要' }}
          >
            {item.abstract}
          </Typography.Paragraph>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            暂无摘要
          </Typography.Text>
        )}
      </Flex>
    </Card>
  );
}

/* ------------------------------------------------------------------ 主体 */

export default function DailyReadingPanel() {
  const screens = Grid.useBreakpoint();
  const inputRef = useRef<InputRef>(null);

  const [date, setDate] = useState<Dayjs>(dayjs());
  const [keywordInput, setKeywordInput] = useState('');
  /** 已经发起过的抓取批次：日期 + 关键词 */
  const [requested, setRequested] = useState<{ date: string; keyword: string } | null>(null);

  const activeDate = date.format('YYYY-MM-DD');
  const keyword = keywordInput.trim();
  /** 只有当前日期 + 当前关键词确实抓取过，才展示这一批结果 */
  const active =
    requested && requested.date === activeDate && requested.keyword === keyword ? requested : null;

  const literatureQuery = useQuery({
    queryKey: ['daily-reading', activeDate, keyword],
    queryFn: () => api.labopsLiteratureSearch(keyword),
    enabled: Boolean(active),
    retry: false,
    staleTime: 10 * 60_000,
  });

  const items = useMemo(() => literatureQuery.data?.items ?? [], [literatureQuery.data]);
  const semantic = literatureQuery.data?.semantic ?? false;
  const loading = Boolean(active) && literatureQuery.isLoading;
  const error = active ? (literatureQuery.error as Error | null) : null;

  /** 「抓取」：只记下这次的日期与关键词，真正取数交给上面的 query */
  const runFetch = () => {
    setRequested({ date: activeDate, keyword });
  };

  /** 「换一个关键词」：清空输入并聚焦 */
  const changeKeyword = () => {
    setKeywordInput('');
    inputRef.current?.focus();
  };

  return (
    <Flex vertical gap={16}>
      {/* ------------------------------------------------ 抓取条 */}
      <Card size="small" variant="outlined" className="d509-card" styles={{ body: { padding: 12 } }}>
        <Flex gap={12} align="flex-end" wrap>
          <Flex vertical gap={4} style={{ minWidth: 160 }}>
            <Typography.Text style={{ fontSize: 12 }}>日期</Typography.Text>
            <DatePicker
              value={date}
              onChange={(d) => setDate(d ?? dayjs())}
              format="YYYY-MM-DD"
              allowClear={false}
              style={{ width: '100%' }}
              aria-label="选择抓取日期"
            />
          </Flex>

          <Flex vertical gap={4} style={{ flex: 1, minWidth: 220 }}>
            <Typography.Text style={{ fontSize: 12 }}>主题 / 关键词</Typography.Text>
            <Input
              ref={inputRef}
              value={keywordInput}
              onChange={(e) => setKeywordInput(e.target.value)}
              onPressEnter={runFetch}
              placeholder="例如：CRISPR 抗病 育种"
              prefix={<SearchOutlined />}
              aria-label="文献主题或关键词"
              allowClear
            />
          </Flex>

          <Popconfirm
            title="向文献源发起抓取请求？"
            description="抓取会向外部文献源发送一次检索请求，通常需要几秒钟。"
            okText="抓取"
            cancelText="取消"
            onConfirm={runFetch}
            disabled={!keyword}
          >
            <Button type="primary" icon={<SearchOutlined />} disabled={!keyword}>
              抓取
            </Button>
          </Popconfirm>
        </Flex>
      </Card>

      {/* ------------------------------------------------ 批次信息 */}
      <Flex gap={8} align="center" wrap>
        <Typography.Text strong style={{ fontSize: 13 }}>
          {activeDate} 的文献
        </Typography.Text>
        {active ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            关键词「{active.keyword}」
          </Typography.Text>
        ) : null}
        {semantic ? (
          <Tag color="processing" style={{ margin: 0 }}>
            语义检索
          </Tag>
        ) : null}
        {active && !loading && !error ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {items.length} 条
          </Typography.Text>
        ) : null}
      </Flex>

      {/* ------------------------------------------------ 三种状态 */}
      {loading ? (
        <Card size="small" variant="outlined" className="d509-card">
          <Skeleton active paragraph={{ rows: 6 }} />
        </Card>
      ) : error ? (
        <Alert
          type="error"
          showIcon
          variant="filled"
          title="抓取失败"
          description={`${errText(error, 160)}（关键词「${active?.keyword ?? keyword}」）`}
          action={
            <Button
              size="small"
              type="primary"
              icon={<ReloadOutlined />}
              onClick={() => void literatureQuery.refetch()}
            >
              重试
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <Card size="small" variant="outlined" className="d509-card">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              active
                ? `${activeDate} 没有检索到文献，换一个关键词试试`
                : `${activeDate} 还没有抓取文献，填好关键词后点「抓取」`
            }
          >
            <Flex gap={8} justify="center" wrap>
              <Button type="primary" icon={<SearchOutlined />} onClick={runFetch} disabled={!keyword}>
                抓取
              </Button>
              <Button onClick={changeKeyword}>换一个关键词</Button>
            </Flex>
          </Empty>
        </Card>
      ) : (
        <Row gutter={[12, 12]}>
          {items.map((item, idx) => (
            <Col xs={24} md={screens.xl ? 12 : 24} key={`${item.doi || item.id || item.title}-${idx}`}>
              <LiteratureCard item={item} />
            </Col>
          ))}
        </Row>
      )}

      {!items.length && !loading && !error ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <LinkOutlined /> 文献标题可点击跳转到原文，新标签页打开。
        </Typography.Text>
      ) : null}
    </Flex>
  );
}
