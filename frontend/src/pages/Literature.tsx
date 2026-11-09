import { useState } from 'react';
import { Button, Card, Empty, Flex, Input, Listy, Select, Spin, Tabs, Tag, Typography } from 'antd';
import { BookOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import SaveKnowledgeModal from '../components/SaveKnowledgeModal';
import LiteratureLibrary from './lab/LiteratureLibrary';

const SOURCES = [
  { value: 'pubmed', label: 'PubMed' },
  { value: 'europepmc', label: 'Europe PMC' },
  { value: 'crossref', label: 'Crossref' },
  { value: 'uniprot', label: 'UniProt' },
  { value: 'gene', label: 'NCBI Gene' },
];

const labelOf = (value: string) => SOURCES.find((s) => s.value === value)?.label ?? value;

const itemTitle = (it: any): string =>
  String(it.title || it['Protein names'] || it.symbol || it.accession || it.gene_id || it.id || '文献条目');

/** 把不同检索源的异构字段整理成一份可检索的 Markdown 正文。 */
function itemBody(it: any, sourceLabel: string): string {
  const authors = Array.isArray(it.authors) ? it.authors.join(', ') : it.authorString;
  const rows: [string, unknown][] = [
    ['来源', sourceLabel],
    ['作者', authors],
    ['期刊', it.journal || it.journalTitle || it.container],
    ['日期', it.pubdate || it.pubYear || it.year],
    ['PMID', it.pmid],
    ['DOI', it.doi],
    ['登录号', it.accession || it.Entry],
    ['基因', it.symbol || it['Gene Names']],
    ['物种', it.organism],
    ['描述', it.description || it['Protein names']],
    ['链接', it.url],
  ];
  const meta = rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `- ${k}：${v}`)
    .join('\n');
  const abstract = typeof it.abstract === 'string' && it.abstract.trim() ? `\n\n## 摘要\n\n${it.abstract.trim()}` : '';
  return `# ${itemTitle(it)}\n\n${meta}${abstract}\n`;
}

function LiteratureSearch() {
  const [keyword, setKeyword] = useState('');
  const [source, setSource] = useState('pubmed');
  const [q, setQ] = useState('');
  const [saveItem, setSaveItem] = useState<any | null>(null);

  const { data, isFetching, error } = useQuery({
    queryKey: ['literature', q, source],
    queryFn: () => api.literature(q, source),
    enabled: q.trim().length > 0,
  });

  const items: any[] = (data?.items as any[]) ?? [];

  return (
    <Flex vertical gap={16}>
      <Card>
        <Flex gap={12} wrap>
          <Select value={source} onChange={setSource} options={SOURCES} style={{ width: 160 }} />
          <Input.Search
            size="large"
            allowClear
            placeholder="关键词，例如：fastp RNA-seq quality control"
            style={{ flex: 1, minWidth: 260 }}
            onSearch={setQ}
            onChange={(e) => setKeyword(e.target.value)}
            value={keyword}
          />
        </Flex>
      </Card>

      {isFetching && (
        <Flex justify="center" style={{ padding: 40 }}>
          <Spin />
        </Flex>
      )}

      {error && <Typography.Text type="danger">文献服务暂时不可用。</Typography.Text>}

      {q && !isFetching && items.length === 0 && !error && (
        <Card>
          <Empty description="没有找到记录" />
        </Card>
      )}

      {items.length > 0 && (
        <Card title={`${labelOf(source)} 结果（${items.length}）`}>
          <Listy
            items={items}
            rowKey={(it) => String(it.id ?? it.pmid ?? it.doi ?? it.accession ?? it.gene_id ?? Math.random())}
            height={520}
            itemRender={(it) => (
              <div style={{ padding: '10px 4px' }}>
                <Flex justify="space-between" align="flex-start" gap={12}>
                  <div style={{ minWidth: 0 }}>
                    {it.url ? (
                      <a href={it.url} target="_blank" rel="noreferrer noopener" style={{ fontWeight: 500 }}>
                        {it.title || it.id || it.accession || it.gene_id}
                      </a>
                    ) : (
                      <Typography.Text strong>{it.title || it.id || it.accession || it.gene_id}</Typography.Text>
                    )}
                    <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 13 }}>
                      {[it.journal, it.container, it.pubdate, it.year, it.organism, it.description]
                        .filter(Boolean)
                        .join(' · ')}
                    </Typography.Paragraph>
                  </div>
                  <Flex gap={6} wrap style={{ flexShrink: 0 }} align="center">
                    {it.pmid && <Tag variant="filled">PMID {it.pmid}</Tag>}
                    {it.doi && <Tag variant="filled">DOI {it.doi}</Tag>}
                    {it.accession && <Tag variant="filled">{it.accession}</Tag>}
                    {it.gene_id && <Tag variant="filled">Gene {it.gene_id}</Tag>}
                    <Button size="small" icon={<BookOutlined />} onClick={() => setSaveItem(it)}>
                      存入知识库
                    </Button>
                  </Flex>
                </Flex>
              </div>
            )}
          />
        </Card>
      )}

      <SaveKnowledgeModal
        open={Boolean(saveItem)}
        title={saveItem ? itemTitle(saveItem) : ''}
        body={saveItem ? itemBody(saveItem, labelOf(source)) : ''}
        category="文献资料"
        tags={['文献检索', labelOf(source)]}
        onClose={() => setSaveItem(null)}
      />
    </Flex>
  );
}
export default function Literature() {
  return (
    <Tabs
      defaultActiveKey="search"
      items={[
        {
          key: 'search',
          label: (
            <span>
              <SearchOutlined /> 在线检索
            </span>
          ),
          children: <LiteratureSearch />,
        },
        {
          key: 'library',
          label: (
            <span>
              <BookOutlined /> 我的文献库
            </span>
          ),
          children: <LiteratureLibrary />,
        },
      ]}
    />
  );
}
