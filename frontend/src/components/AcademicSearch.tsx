import { useState } from 'react';
import { Card, Flex, Input, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';

interface Hit {
  title: string;
  url: string;
  content: string;
  engine: string;
}

const CATS = [
  { key: 'science', label: '学术文献' },
  { key: 'general', label: '网页' },
  { key: 'videos', label: '教学视频' },
];

/** 主页面的多源学术检索（走门户后端 → SearXNG 多引擎聚合） */
export default function AcademicSearch() {
  const [cat, setCat] = useState('science');
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');

  const { data, isFetching } = useQuery({
    queryKey: ['home-search', submitted, cat],
    queryFn: async () => {
      const r = await fetch(
        `/api/search?q=${encodeURIComponent(submitted)}&categories=${encodeURIComponent(cat)}`,
        { credentials: 'include' },
      );
      if (!r.ok) throw new Error('检索服务暂时不可用');
      return (await r.json()) as { results: Hit[]; engines?: string[] };
    },
    enabled: !!submitted,
    staleTime: 60_000,
    retry: false,
  });

  return (
    <Card
      size="small"
      title="学术检索"
      extra={
        <Space size={6}>
          {data?.engines?.slice(0, 4).map((e) => (
            <Tag key={e} variant="filled" style={{ fontSize: 11 }}>
              {e}
            </Tag>
          ))}
        </Space>
      }
    >
      <Flex gap={10} wrap align="center">
        <Segmented
          value={cat}
          onChange={(v) => {
            setCat(String(v));
            if (submitted) setSubmitted(submitted);
          }}
          options={CATS.map((c) => ({ label: c.label, value: c.key }))}
        />
        <Input.Search
          allowClear
          enterButton={<SearchOutlined />}
          placeholder="PubMed / arXiv / Crossref 关键词，如：STAR genomeGenerate"
          style={{ flex: 1, minWidth: 260 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onSearch={(v) => setSubmitted(v.trim())}
        />
        {isFetching && <Spin size="small" />}
      </Flex>

      {submitted && !isFetching && data?.results?.length ? (
        <Flex vertical gap={6} style={{ marginTop: 12 }}>
          {data.results.slice(0, 4).map((r, i) => (
            <Flex key={r.url + i} gap={8} align="baseline">
              <Tag variant="filled" style={{ fontSize: 11, flexShrink: 0 }}>
                {r.engine}
              </Tag>
              <a href={r.url} target="_blank" rel="noreferrer noopener" style={{ fontSize: 13 }}>
                {r.title}
              </a>
              <Typography.Text type="secondary" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.content}
              </Typography.Text>
            </Flex>
          ))}
        </Flex>
      ) : submitted && !isFetching ? (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
          没有结果（可在“网页/学术搜索”页查看完整结果）
        </Typography.Text>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
          直接在首页检索学术文献、网页与教学视频（聚合 SearXNG 多引擎：PubMed / Europe PMC / Crossref / arXiv / Bing / 百度 / 搜狗 / Bilibili）
        </Typography.Text>
      )}
    </Card>
  );
}
