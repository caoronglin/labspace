import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Input,
  Row,
  Segmented,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiOutlined, ExportOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { api, type DatabaseItem } from '../services/api';

const API_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'api', label: '已接入 API' },
  { value: 'web', label: '仅网页访问' },
];

const SAMPLE: Record<string, string> = {
  ncbi: 'AP1 Arabidopsis',
  'ncbi-sra': 'maize RNA-seq',
  'ncbi-blast': 'AT1G01010',
  ebi: 'kinase',
  ena: 'maize',
  uniprotkb: 'kinase AND organism_id:3702',
  interpro: 'kinase',
  pfam: 'WRKY',
  alphafold: 'P00533',
  kegg: 'kinase',
  'expression-atlas': 'AT1G01010',
  pdb: 'phytochrome',
  panther: 'AP1',
  'plant-ontology': 'leaf',
  rnacentral: 'MIR166',
};

export default function Databases() {
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('全部');
  const [apiFilter, setApiFilter] = useState('all');
  const [active, setActive] = useState<DatabaseItem | null>(null);
  const [query, setQuery] = useState('');
  const { token } = theme.useToken();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['databases', keyword, category],
    queryFn: () => api.databases(keyword, category === '全部' ? '' : category),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const { data: apiIndex } = useQuery({
    queryKey: ['database-apis'],
    queryFn: api.databaseApis,
    staleTime: 10 * 60_000,
    retry: false,
  });

  const categories = useMemo(() => ['全部', ...(data?.categories ?? [])], [data]);
  const items = useMemo(() => {
    const list = data?.items ?? [];
    if (apiFilter === 'api') return list.filter((d) => d.api?.hasApi);
    if (apiFilter === 'web') return list.filter((d) => !d.api?.hasApi);
    return list;
  }, [data, apiFilter]);

  const runQuery = useMutation({
    mutationFn: async () => {
      if (!active) throw new Error('未选择数据库');
      return api.databaseQuery(active.id, query.trim(), 6);
    },
  });

  const openQuery = (item: DatabaseItem) => {
    setActive(item);
    setQuery(SAMPLE[item.id] ?? '');
    runQuery.reset();
  };

  const hasFilter = Boolean(keyword.trim()) || category !== '全部' || apiFilter !== 'all';
  const clearFilters = () => {
    setKeyword('');
    setCategory('全部');
    setApiFilter('all');
  };

  return (
    <Flex vertical gap={16}>
      <Card
        size="small"
        title="植物生信数据库速查"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            共 {data?.total ?? 0} 个资源 · {apiIndex?.withApi ?? 0} 个已接入真实 API
          </Typography.Text>
        }
      >
        <Flex gap={10} wrap align="center" style={{ marginBottom: 12 }}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="按名称、用途或标签检索，例如：单细胞 / miRNA / 拟南芥 / SNP"
            style={{ maxWidth: 420, flex: '1 1 320px' }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label="数据库检索"
          />
          <Flex gap={6} wrap align="center" style={{ flex: '2 1 480px' }}>
            {categories.map((c) => (
              <Tag.CheckableTag
                key={c}
                checked={category === c}
                onChange={() => setCategory(c)}
                style={{ marginInlineEnd: 0 }}
              >
                {c}
              </Tag.CheckableTag>
            ))}
          </Flex>
        </Flex>
        <Flex gap={10} wrap align="center">
          <Segmented value={apiFilter} onChange={(v) => setApiFilter(String(v))} options={API_FILTERS} />
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            命中 {items.length} 条；带 API 标记的数据库可直接在门户内发起真实检索。
          </Typography.Text>
        </Flex>
      </Card>

      {isLoading ? (
        <Row gutter={[16, 16]}>
          {Array.from({ length: 6 }, (_, i) => (
            <Col key={i} xs={24} md={12} xl={8}>
              <Card size="small" styles={{ body: { padding: 20 } }}>
                <Skeleton active title={{ width: '48%' }} paragraph={{ rows: 2, width: ['90%', '60%'] }} />
              </Card>
            </Col>
          ))}
        </Row>
      ) : isError ? (
        <Alert
          type="error"
          showIcon
          title="数据库列表加载失败"
          description={(error as Error)?.message || '请稍后重试'}
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void refetch()}>
              重试
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <Card>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={hasFilter ? '没有匹配的数据库，换个关键词或清除筛选条件' : '暂时没有可用的数据库'}
          >
            <Flex gap={8} justify="center" wrap>
              <Button type="primary" icon={<SearchOutlined />} onClick={clearFilters} disabled={!hasFilter}>
                清除筛选
              </Button>
              <Button onClick={() => setKeyword('')}>查看全部数据库</Button>
            </Flex>
          </Empty>
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          {items.map((d) => (
            <Col key={d.id} xs={24} md={12} xl={8}>
              <Card
                size="small"
                className="lab-service-card d509-card"
                data-db-id={d.id}
                title={
                  <Space size={6}>
                    <Typography.Text strong>{d.name}</Typography.Text>
                    <Tag variant="filled">{d.category}</Tag>
                  </Space>
                }
                extra={
                  <Tooltip title={d.url}>
                    <a href={d.url} target="_blank" rel="noreferrer noopener" aria-label={`在新窗口打开 ${d.name}`}>
                      <ExportOutlined />
                    </a>
                  </Tooltip>
                }
              >
                <Typography.Paragraph
                  type="secondary"
                  style={{ fontSize: token.fontSizeSM, marginBottom: 8, minHeight: 38 }}
                  ellipsis={{ rows: 2 }}
                >
                  {d.cn}：{d.desc}
                </Typography.Paragraph>
                <Flex gap={4} wrap align="center" style={{ marginBottom: 8 }}>
                  {d.api?.hasApi ? (
                    <Tag color="success" variant="filled" icon={<ApiOutlined />}>
                      已接入 API
                    </Tag>
                  ) : (
                    <Tooltip title={d.api?.note}>
                      <Tag variant="filled">仅网页访问</Tag>
                    </Tooltip>
                  )}
                  {d.tags.slice(0, 3).map((t) => (
                    <Tag key={t} variant="filled">
                      {t}
                    </Tag>
                  ))}
                </Flex>
                {d.api?.hasApi ? (
                  <Button size="small" type="primary" ghost icon={<ApiOutlined />} onClick={() => openQuery(d)}>
                    站内查询
                  </Button>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                    {d.api?.note}
                  </Typography.Text>
                )}
              </Card>
            </Col>
          ))}
        </Row>
      )}

      <Drawer
        open={Boolean(active)}
        onClose={() => setActive(null)}
        size={720}
        title={
          active ? (
            <Space size={8}>
              <Typography.Text strong>{active.name}</Typography.Text>
              <Tag color="success" variant="filled" icon={<ApiOutlined />}>
                {active.api?.name}
              </Tag>
            </Space>
          ) : (
            '数据库查询'
          )
        }
        extra={
          <Button
            type="primary"
            loading={runQuery.isPending}
            onClick={() => runQuery.mutate()}
            disabled={!query.trim()}
          >
            查询
          </Button>
        }
      >
        {active && (
          <Flex vertical gap={14}>
            <Descriptions size="small" column={1} bordered items={[
              { key: 'cn', label: '中文名', children: active.cn },
              { key: 'api', label: 'API 端点', children: active.api?.name ?? '—' },
              { key: 'summary', label: '说明', children: active.api?.summary || '—' },
              { key: 'hint', label: '检索提示', children: active.api?.queryHint || '可直接输入关键词' },
            ]} />
            <Input.Search
              allowClear
              enterButton="查询"
              loading={runQuery.isPending}
              placeholder={active.api?.queryHint || '输入关键词，例如 AP1 Arabidopsis'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onSearch={() => runQuery.mutate()}
            />
            {runQuery.isError && (
              <Alert type="error" showIcon title="查询失败" description={(runQuery.error as Error)?.message} />
            )}
            {runQuery.data && !runQuery.data.ok && (
              <Alert type="warning" showIcon title="查询未成功" description={runQuery.data.error ?? '未知错误'} />
            )}
            {runQuery.data?.ok && runQuery.data.items.length === 0 && (
              <Empty description="该数据库没有返回结果，换个关键词再试" />
            )}
            {runQuery.data?.ok && runQuery.data.items.length > 0 && (
              <Flex vertical gap={10}>
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                  返回 {runQuery.data.total ?? runQuery.data.items.length} 条 · 耗时 {runQuery.data.elapsedMs} ms · 数据来自 {runQuery.data.api?.name}
                </Typography.Text>
                {runQuery.data.items.map((item, idx) => (
                  <Card key={`${item.title}-${idx}`} size="small" className="lab-service-card d509-card">
                    <Flex vertical gap={6}>
                      <Typography.Text strong style={{ fontSize: 13.5 }}>
                        {item.title}
                      </Typography.Text>
                      {item.subtitle && (
                        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                          {item.subtitle}
                        </Typography.Text>
                      )}
                      <Flex gap={4} wrap>
                        {item.fields.slice(0, 4).map((f) => (
                          <Tag key={f.label} variant="filled">
                            {f.label}: {f.value}
                          </Tag>
                        ))}
                      </Flex>
                      {item.url && (
                        <a href={item.url} target="_blank" rel="noreferrer noopener" style={{ fontSize: token.fontSizeSM }}>
                          在原站打开 <ExportOutlined />
                        </a>
                      )}
                    </Flex>
                  </Card>
                ))}
              </Flex>
            )}
          </Flex>
        )}
      </Drawer>
    </Flex>
  );
}
