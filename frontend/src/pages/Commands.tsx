import { useEffect, useMemo, useState } from 'react';
import { hostUrl } from '../utils/host';
import { Alert, Card, Col, Empty, Flex, Input, Listy, Row, Space, Spin, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { SearchOutlined } from '@ant-design/icons';
import MarkdownView from '../components/MarkdownView';

interface CmdItem {
  name: string;
  desc: string;
  path: string;
}

export default function Commands() {
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<string>('');

  const { data, isLoading } = useQuery({
    queryKey: ['commands', keyword],
    queryFn: async () => {
      const r = await fetch(`/api/commands?q=${encodeURIComponent(keyword)}&limit=200`, { credentials: 'include' });
      if (!r.ok) throw new Error('命令库加载失败');
      return (await r.json()) as { total: number; matched: number; items: CmdItem[] };
    },
    staleTime: 5 * 60_000,
  });

  const { data: detail, isFetching: loadingDetail } = useQuery({
    queryKey: ['command', selected],
    queryFn: async () => {
      const r = await fetch(`/api/commands/${encodeURIComponent(selected)}`, { credentials: 'include' });
      if (!r.ok) throw new Error('未找到该命令的说明');
      return (await r.json()) as { name: string; desc: string; markdown: string };
    },
    enabled: !!selected,
    staleTime: 10 * 60_000,
  });

  const items = data?.items ?? [];

  useEffect(() => {
    if (!selected && items.length) setSelected(items[0].name);
  }, [items, selected]);

  const grouped = useMemo(() => {
    const map = new Map<string, CmdItem[]>();
    for (const it of items) {
      const ch = it.name[0]?.toUpperCase() ?? '#';
      if (!map.has(ch)) map.set(ch, []);
      map.get(ch)!.push(it);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <Flex vertical gap={16}>
      <Alert
        type="info"
        showIcon
        title="Linux 命令速查（只读参考）"
        description={
          <>
            内置 linux-command 官方命令库共 {data?.total ?? 621} 条完整说明（含语法、选项与示例），仅供查阅，
            <b>不会执行任何命令</b>。需要交互式浏览请打开独立站点
            <a href={hostUrl('/commands/')} target="_blank" rel="noreferrer">
              {hostUrl('/commands/')}
            </a>
            。
          </>
        }
      />

      <Input
        size="large"
        allowClear
        prefix={<SearchOutlined />}
        placeholder="输入命令名或用途，例如 grep / awk / 压缩 / 磁盘"
        value={keyword}
        onChange={(e) => {
          setKeyword(e.target.value);
          setSelected('');
        }}
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8} xl={7}>
          <Card
            size="small"
            title={`命令列表（${data?.matched ?? 0}）`}
            styles={{ body: { maxHeight: '68vh', overflow: 'auto' } }}
          >
            {isLoading ? (
              <Flex justify="center" style={{ padding: 30 }}>
                <Spin />
              </Flex>
            ) : items.length === 0 ? (
              <Empty description="没有匹配的命令" />
            ) : (
              grouped.map(([ch, list]) => (
                <div key={ch}>
                  <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', margin: '8px 0 4px' }}>
                    {ch}
                  </Typography.Text>
                  <Listy
                    items={list}
                    rowKey={(it: CmdItem) => it.name}
                    height={Math.min(list.length * 46, 240)}
                    itemRender={(it: CmdItem) => (
                      <div
                        onClick={() => setSelected(it.name)}
                        style={{
                          cursor: 'pointer',
                          padding: '6px 8px',
                          borderRadius: 6,
                          background: selected === it.name ? 'rgba(37,99,235,0.08)' : undefined,
                        }}
                      >
                        <Typography.Text strong style={{ fontSize: 13 }}>
                          {it.name}
                        </Typography.Text>
                        <Typography.Paragraph
                          type="secondary"
                          style={{ fontSize: 12, margin: 0 }}
                          ellipsis={{ rows: 1 }}
                        >
                          {it.desc}
                        </Typography.Paragraph>
                      </div>
                    )}
                  />
                </div>
              ))
            )}
          </Card>
        </Col>

        <Col xs={24} lg={16} xl={17}>
          <Card
            size="small"
            title={detail ? (
              <Space>
                <Typography.Text strong>{detail.name}</Typography.Text>
                {detail.desc && <Tag variant="filled">{detail.desc}</Tag>}
              </Space>
            ) : '命令说明'}
            styles={{ body: { maxHeight: '68vh', overflow: 'auto' } }}
          >
            {!selected ? (
              <Empty description="从左侧选择一个命令" />
            ) : loadingDetail ? (
              <Flex justify="center" style={{ padding: 40 }}>
                <Spin />
              </Flex>
            ) : detail ? (
              <MarkdownView source={detail.markdown} />
            ) : (
              <Empty description="未找到说明" />
            )}
          </Card>
        </Col>
      </Row>
    </Flex>
  );
}
