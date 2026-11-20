import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Empty, Flex, Input, Listy, Select, Spin, Tabs, Tag, Typography } from 'antd';
import { BookOutlined, RobotOutlined, SearchOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import SaveKnowledgeModal from '../components/SaveKnowledgeModal';
import { handoffToAgent } from '../utils/agentHandoff';
import LiteratureLibrary from './lab/LiteratureLibrary';
import DailyPapers from './DailyPapers';

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
  const navigate = useNavigate();
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
                    <Button
                      size="small"
                      icon={<RobotOutlined />}
                      onClick={() => navigate(handoffToAgent(agentPromptFor(it, labelOf(source))))}
                    >
                      AI 解读
                    </Button>
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
/** 把一条检索结果拼成"交给 Agent 精读/解读"的提示。 */
function agentPromptFor(it: any, sourceLabel: string): string {
  const lines = [
    `请解读下面这条来自 ${sourceLabel} 的检索结果，中文作答；重点说明它解决什么问题、关键结论是什么、与我可能的育种/组学课题有什么关系。不要编造未给出的结果。`,
    '',
    `标题：${itemTitle(it)}`,
  ];
  const authors = Array.isArray(it.authors) ? it.authors.join(', ') : it.authorString;
  if (authors) lines.push(`作者：${authors}`);
  if (it.journal || it.journalTitle || it.container) {
    lines.push(`期刊/来源：${it.journal || it.journalTitle || it.container}`);
  }
  if (it.pubdate || it.pubYear || it.year) lines.push(`日期：${it.pubdate || it.pubYear || it.year}`);
  if (it.doi) lines.push(`DOI：${it.doi}`);
  if (it.pmid) lines.push(`PMID：${it.pmid}`);
  if (it.url) lines.push(`原文：${it.url}`);
  if (it.abstract) lines.push('', `摘要：${it.abstract}`);
  else if (it.description) lines.push('', `描述：${it.description}`);
  lines.push('', '如果知识库里有相关材料，请检索并标出来源；资料不足时明确说明缺什么。');
  return lines.join('\n');
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
        {
          // 「每日论文」并入文献页：它本质就是文献抓取的一种，不再单开侧栏入口
          key: 'daily',
          label: (
            <span>
              <ThunderboltOutlined /> 每日论文
            </span>
          ),
          children: <DailyPapers embedded />,
        },
      ]}
    />
  );
}
