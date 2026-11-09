import { useState, type ReactNode } from 'react';
import { App, Button, Card, Col, Empty, Flex, Input, List, Row, Skeleton, Tag, Typography } from 'antd';
import { BookOutlined, CloudDownloadOutlined, ExportOutlined, ReadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type LabopsLiterature } from '../services/api';
import { errText } from '../utils/err';

const { Text, Paragraph } = Typography;

/** 每日文献：固定主题轮换 + 收藏库最近条目，避免每天从空白搜索框开始 */
const TOPICS: Array<{ key: string; label: string; query: string; hint: string }> = [
  { key: 'crispr', label: '基因编辑', query: 'CRISPR plant genome editing 2025', hint: '编辑效率与递送' },
  { key: 'drought', label: '抗逆', query: 'crop drought stress transcriptome', hint: '抗旱机制与组学' },
  { key: 'single-cell', label: '单细胞', query: 'plant single-cell RNA sequencing', hint: '细胞图谱' },
  { key: 'multiomics', label: '多组学', query: 'multi-omics integration crop improvement', hint: '关联分析' },
  { key: 'ai-bio', label: 'AI 生物', query: 'deep learning protein structure plant', hint: '模型与工具' },
  { key: 'microbiome', label: '微生物组', query: 'root microbiome plant health', hint: '根际互作' },
];

function LiteratureItem({
  item,
  action,
}: {
  item: LabopsLiterature;
  action?: ReactNode;
}) {
  return (
    <Flex vertical gap={4} style={{ width: '100%' }}>
      <Flex justify="space-between" gap={8} align="flex-start">
        <Text strong style={{ fontSize: 13, lineHeight: 1.45 }}>
          {item.title || '未命名文献'}
        </Text>
        {action}
      </Flex>
      <Text type="secondary" ellipsis style={{ fontSize: 11.5 }}>
        {[item.authors, item.journal, item.pub_year].filter(Boolean).join(' · ') || '暂无出处信息'}
      </Text>
      {item.abstract && (
        <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ margin: 0, fontSize: 12 }}>
          {item.abstract}
        </Paragraph>
      )}
      <Flex gap={8} align="center" wrap>
        {item.doi && <Text type="secondary" style={{ fontSize: 11 }}>DOI {item.doi}</Text>}
        {(item.tags || []).slice(0, 3).map((t) => (
          <Tag key={t} style={{ margin: 0 }}>{t}</Tag>
        ))}
        {item.url && (
          <Button
            type="link"
            size="small"
            icon={<ExportOutlined />}
            style={{ paddingInline: 0, height: 20, fontSize: 12 }}
            onClick={() => window.open(item.url, '_blank', 'noopener')}
          >
            打开原文
          </Button>
        )}
      </Flex>
    </Flex>
  );
}

export default function WorkbenchDailyReading() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [topic, setTopic] = useState(TOPICS[0]);
  const [custom, setCustom] = useState('');
  const [activeQuery, setActiveQuery] = useState(TOPICS[0].query);
  const [importing, setImporting] = useState<string | null>(null);

  const libraryQ = useQuery({
    queryKey: ['wb-daily-literature'],
    queryFn: () => api.labopsLiterature('', ''),
    staleTime: 60_000,
  });
  const searchQ = useQuery({
    queryKey: ['wb-daily-literature-search', activeQuery],
    queryFn: () => api.labopsLiteratureSearch(activeQuery),
    enabled: Boolean(activeQuery),
    staleTime: 10 * 60_000,
  });

  const library = libraryQ.data?.items ?? [];
  const results = searchQ.data?.items ?? [];
  const savedKeys = new Set(library.flatMap((i) => [i.doi && `doi:${i.doi.toLowerCase()}`, `title:${i.title.toLowerCase()}`]));

  const runSearch = (next: typeof TOPICS[number]) => {
    setTopic(next);
    setActiveQuery(next.query);
  };

  const runCustom = () => {
    const q = custom.trim();
    if (!q) return;
    setTopic({ ...TOPICS[0], key: 'custom', label: '自定义', hint: '自定义检索' });
    setActiveQuery(q);
  };

  const save = async (item: LabopsLiterature) => {
    setImporting(item.title);
    try {
      const res = await api.labopsImportLiterature({
        doi: item.doi || undefined,
        title: item.title,
        tags: [topic.label],
      });
      message.success(res.duplicate ? '文献已在库中' : '已加入文献库');
      void qc.invalidateQueries({ queryKey: ['wb-daily-literature'] });
    } catch (err) {
      message.error(errText(err));
    } finally {
      setImporting(null);
    }
  };

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={13}>
        <Flex vertical gap={12}>
          <Flex gap={8} align="center" wrap>
            <BookOutlined style={{ color: '#2B5CE6' }} />
            <Text strong>今日文献</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              每次换一个主题，读完顺手入库
            </Text>
          </Flex>
          <Flex gap={8} wrap>
            {TOPICS.map((t) => (
              <Button
                key={t.key}
                size="small"
                type={topic.key === t.key ? 'primary' : 'default'}
                onClick={() => runSearch(t)}
              >
                {t.label}
              </Button>
            ))}
            <Input
              size="small"
              allowClear
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onPressEnter={runCustom}
              placeholder="自定义关键词"
              prefix={<SearchOutlined />}
              style={{ width: 180 }}
              aria-label="自定义文献检索"
            />
            <Button size="small" onClick={runCustom} disabled={!custom.trim()}>
              检索
            </Button>
          </Flex>
          <Card size="small" style={{ background: 'var(--ant-color-fill-quaternary, rgba(0,0,0,0.02))' }}>
            <Flex justify="space-between" align="center" wrap gap={6}>
              <Flex vertical gap={2}>
                <Text strong style={{ fontSize: 13 }}>{topic.label}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{topic.hint} · {activeQuery}</Text>
              </Flex>
              {searchQ.data?.semantic && <Tag color="processing" style={{ margin: 0 }}>语义检索</Tag>}
            </Flex>
          </Card>
          {searchQ.isLoading ? (
            <Skeleton active paragraph={{ rows: 5 }} />
          ) : searchQ.error ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={errText(searchQ.error)} />
          ) : results.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有检索到结果，换个关键词试试" />
          ) : (
            <List
              size="small"
              dataSource={results}
              renderItem={(item) => {
                const saved =
                  savedKeys.has(`title:${item.title.toLowerCase()}`) ||
                  (item.doi ? savedKeys.has(`doi:${item.doi.toLowerCase()}`) : false);
                return (
                  <List.Item>
                    <LiteratureItem
                      item={item}
                      action={
                        <Button
                          size="small"
                          type={saved ? 'default' : 'primary'}
                          ghost={!saved}
                          disabled={saved}
                          loading={importing === item.title}
                          icon={<CloudDownloadOutlined />}
                          onClick={() => void save(item)}
                        >
                          {saved ? '已入库' : '入库'}
                        </Button>
                      }
                    />
                  </List.Item>
                );
              }}
            />
          )}
        </Flex>
      </Col>
      <Col xs={24} xl={11}>
        <Flex vertical gap={12}>
          <Flex justify="space-between" align="center">
            <Flex gap={8} align="center">
              <ReadOutlined style={{ color: '#12A594' }} />
              <Text strong>我的文献库</Text>
              <Tag style={{ margin: 0 }}>{library.length}</Tag>
            </Flex>
            <Button size="small" type="link" onClick={() => window.open('/literature', '_self')}>
              去文献中心
            </Button>
          </Flex>
          {libraryQ.isLoading ? (
            <Skeleton active paragraph={{ rows: 5 }} />
          ) : library.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有收藏文献，从左侧检索并入库" />
          ) : (
            <List
              size="small"
              dataSource={library.slice(0, 8)}
              renderItem={(item) => (
                <List.Item>
                  <LiteratureItem item={item} />
                </List.Item>
              )}
            />
          )}
        </Flex>
      </Col>
    </Row>
  );
}