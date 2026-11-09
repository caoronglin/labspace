import { useMemo, useState } from 'react';
import { Card, Flex, Input, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { DatabaseOutlined, SearchOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

interface DbItem {
  id: string;
  name: string;
  cn: string;
  url: string;
  category: string;
}

/** 首页常驻的植物数据库速查（可搜索，命中直达官方站点） */
export default function PlantDatabasePanel() {
  const navigate = useNavigate();
  const [keyword, setKeyword] = useState('');

  const { data } = useQuery({
    queryKey: ['databases', keyword],
    queryFn: async () => {
      const r = await fetch(`/api/databases?q=${encodeURIComponent(keyword)}&limit=8`, { credentials: 'include' });
      if (!r.ok) throw new Error('目录加载失败');
      return (await r.json()) as { total: number; matched: number; items: DbItem[] };
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  const items = useMemo(() => (data?.items ?? []).slice(0, 8), [data]);

  return (
    <Card
      size="small"
      title={
        <Space>
          <DatabaseOutlined style={{ color: '#0D9488' }} />
          植物数据库速查
        </Space>
      }
      extra={
        <Typography.Link onClick={() => navigate('/databases')}>全部 {data?.total ?? 50} 个 →</Typography.Link>
      }
    >
      <Input
        allowClear
        prefix={<SearchOutlined />}
        placeholder="检索植物数据库：单细胞 / miRNA / 拟南芥 / SNP / 蛋白家族"
        style={{ maxWidth: 460, marginBottom: 12 }}
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        onPressEnter={() => navigate(`/databases?q=${encodeURIComponent(keyword)}`)}
      />
      <Flex gap={6} wrap>
        {items.map((d) => (
          <a key={d.id} href={d.url} target="_blank" rel="noreferrer noopener">
            <Tag variant="filled" color="cyan" style={{ cursor: 'pointer', padding: '3px 10px', fontSize: 12.5 }}>
              {d.name}
              <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 5 }}>
                {d.category}
              </Typography.Text>
            </Tag>
          </a>
        ))}
      </Flex>
    </Card>
  );
}
