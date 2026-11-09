import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AutoComplete, Card, Empty, Flex, Input, Segmented, Skeleton, Space, Tag, Typography } from 'antd';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { SearchOutlined } from '@ant-design/icons';
import { api } from '../services/api';
import SearchResults from '../components/SearchResults';

const SCOPES = [
  { value: 'all', label: '全部' },
  { value: 'web', label: '网页' },
  { value: 'local', label: '本地资源' },
];

const CATEGORY_OPTIONS = [
  { label: '网页', value: 'general' },
  { label: '学术', value: 'science' },
  { label: '论文', value: 'scientific publications' },
  { label: '视频', value: 'videos' },
  { label: '图片', value: 'images' },
  { label: 'IT', value: 'it' },
  { label: '新闻', value: 'news' },
  { label: '图书', value: 'books' },
];

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const keyword = params.get('q') ?? '';
  const category = params.get('categories') || 'general';
  const scope = (params.get('scope') as 'all' | 'web' | 'local') || 'all';
  const page = Math.max(1, Number(params.get('page') || 1) || 1);
  const pageSize = Math.max(1, Number(params.get('pageSize') || 30) || 30);
  const [input, setInput] = useState(keyword);

  useEffect(() => {
    setInput(keyword);
  }, [keyword]);

  const { data: catData } = useQuery({
    queryKey: ['search-categories'],
    queryFn: () => api.searchCategories(),
    staleTime: 600_000,
    retry: false,
  });

  const categoryOptions = useMemo(() => {
    const remote = catData?.categories ?? [];
    if (!remote.length) return CATEGORY_OPTIONS;
    return remote.map((c) => ({ label: c.label, value: c.value }));
  }, [catData]);

  const { data: suggestData } = useQuery({
    queryKey: ['suggest', keyword],
    queryFn: () => api.suggest(keyword, 12),
    staleTime: 60_000,
    retry: false,
  });

  const { data, isFetching, error } = useQuery({
    queryKey: ['search', keyword, category, scope, page, pageSize],
    queryFn: () => api.search(keyword, category, scope, page, pageSize),
    enabled: keyword.trim().length > 0,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const options = useMemo(() => {
    const list = suggestData?.suggestions ?? [];
    const hot = suggestData?.hot ?? [];
    return list.length ? list.map((s) => ({ value: s })) : hot.map((s) => ({ value: s }));
  }, [suggestData]);

  const update = (next: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === '') search.delete(k);
      else search.set(k, String(v));
    }
    setParams(search, { replace: true });
  };

  const submit = (v: string) => {
    const q = v.trim();
    setInput(q);
    update({ q, categories: category, scope, page: 1 });
  };

  const results = data?.results ?? [];

  return (
    <Flex vertical gap={16} className="d509-enter">
      <Card size="small" styles={{ body: { padding: 16 } }}>
        <Flex gap={10} wrap align="center">
          <AutoComplete
            options={options}
            value={input}
            onChange={setInput}
            onSelect={(v) => submit(v)}
            style={{ flex: 1, minWidth: 260 }}
            popupMatchSelectWidth={520}
          >
            <Input.Search
              size="large"
              allowClear
              enterButton={
                <span>
                  <SearchOutlined /> 搜索
                </span>
              }
              placeholder="搜索网页、论文、视频，或本地的服务 / 文件 / 命令 / 植物库"
              onSearch={submit}
            />
          </AutoComplete>
        </Flex>

        <Flex gap={12} wrap style={{ marginTop: 14 }} align="center">
          <Segmented
            value={scope}
            onChange={(v) => update({ scope: String(v), page: 1 })}
            options={SCOPES}
          />
          {scope !== 'local' && (
            <div className="d509-filter-scroll">
              <Segmented
                value={category}
                onChange={(v) => update({ categories: String(v), page: 1 })}
                options={categoryOptions}
                size="small"
              />
            </div>
          )}
        </Flex>

        {(suggestData?.hot?.length ?? 0) > 0 && !keyword && (
          <Flex gap={6} wrap style={{ marginTop: 12 }} align="center">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              热门：
            </Typography.Text>
            {suggestData!.hot.slice(0, 10).map((h) => (
              <Tag
                key={h}
                variant="filled"
                style={{ cursor: 'pointer', padding: '2px 9px', borderRadius: 7, fontSize: 12 }}
                onClick={() => submit(h)}
              >
                {h}
              </Tag>
            ))}
          </Flex>
        )}
      </Card>

      {!keyword && (
        <Card size="small">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="输入关键词，统一检索本地资源与联网结果" />
        </Card>
      )}

      {isFetching && results.length === 0 && (
        <Card size="small">
          <Skeleton active title={{ width: '40%' }} paragraph={{ rows: 6 }} />
        </Card>
      )}

      {error && !isFetching && results.length === 0 && (
        <Card size="small">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="检索服务暂时不可用，请检查 SearXNG 容器状态后重试。"
          />
        </Card>
      )}

      {!isFetching && keyword && results.length === 0 && !error && (
        <Card size="small">
          <Empty description={`没有找到与「${keyword}」相关的结果`} />
        </Card>
      )}

      {results.length > 0 && (
        <Space size={6} wrap>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            「{keyword}」的搜索结果
          </Typography.Text>
          {data?.error ? <Tag color="orange">联网检索：{String(data.error)}</Tag> : null}
        </Space>
      )}

      {results.length > 0 && (
        <SearchResults
          data={data}
          keyword={keyword}
          page={page}
          pageSize={pageSize}
          onPageChange={(p, ps) => {
            update({ page: p, pageSize: ps });
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      )}
    </Flex>
  );
}
