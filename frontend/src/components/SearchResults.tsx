import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Card, Flex, Pagination, Space, Tag, Typography } from 'antd';
import {
  AppstoreOutlined,
  BookOutlined,
  ConsoleSqlOutlined,
  DatabaseOutlined,
  FileOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  GlobalOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { DatabaseHit, SearchHit, SearchResponse } from '../services/api';

const WEB_GROUPS: Record<string, { label: string; color: string; icon: ReactNode }> = {
  general: { label: '网页', color: '#2563EB', icon: <GlobalOutlined /> },
  science: { label: '学术', color: '#0F766E', icon: <BookOutlined /> },
  videos: { label: '视频', color: '#D97706', icon: <PlayCircleOutlined /> },
  images: { label: '图片', color: '#7C3AED', icon: <PictureOutlined /> },
  news: { label: '新闻', color: '#DC2626', icon: <FileTextOutlined /> },
  books: { label: '图书', color: '#0891B2', icon: <BookOutlined /> },
  it: { label: '技术', color: '#475569', icon: <ConsoleSqlOutlined /> },
  other: { label: '其他', color: '#64748B', icon: <GlobalOutlined /> },
};

const WEB_ORDER = ['general', 'science', 'videos', 'images', 'news', 'books', 'it', 'other'];

const LOCAL_META: Record<string, { label: string; color: string; icon: ReactNode }> = {
  page: { label: '页面', color: '#64748B', icon: <GlobalOutlined /> },
  service: { label: '服务', color: '#2B5CE6', icon: <AppstoreOutlined /> },
  database: { label: '植物库', color: '#12A594', icon: <DatabaseOutlined /> },
  command: { label: '命令', color: '#7C3AED', icon: <ConsoleSqlOutlined /> },
  tool: { label: '工具', color: '#D97706', icon: <FileSearchOutlined /> },
  snapotter: { label: '文件工坊', color: '#0891B2', icon: <ThunderboltOutlined /> },
  file: { label: '文件', color: '#0F766E', icon: <FileOutlined /> },
  knowledge: { label: '知识库', color: '#2563EB', icon: <BookOutlined /> },
};

function webGroup(category = '') {
  const c = category.toLowerCase();
  if (c.includes('scientific') || c === 'science') return 'science';
  if (c === 'general') return 'general';
  if (c === 'videos' || c === 'video') return 'videos';
  if (c === 'images' || c === 'image') return 'images';
  if (c === 'news') return 'news';
  if (c === 'books' || c === 'book') return 'books';
  if (c === 'it') return 'it';
  return 'other';
}

export function highlight(text: string, kw: string) {
  if (!kw.trim()) return text;
  const parts = kw.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return text;
  const re = new RegExp(`(${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).map((seg, i) => (i % 2 === 1 ? <mark key={i}>{seg}</mark> : <span key={i}>{seg}</span>));
}

const PAPER_SOURCES: Record<string, string> = {
  openalex: 'OpenAlex',
  semanticscholar: 'Semantic Scholar',
  crossref: 'Crossref',
  arxiv: 'arXiv',
};

function HitLine({ hit, keyword }: { hit: SearchHit; keyword: string }) {
  const meta = hit.kind === 'local' ? LOCAL_META[hit.category ?? ''] : WEB_GROUPS[webGroup(hit.category)];
  const target = hit.url || hit.path || '';
  const internal = target.startsWith('/');
  const title = highlight(hit.title ?? '', keyword);
  return (
    <div style={{ padding: '10px 4px', borderBottom: '1px solid var(--ant-color-border-secondary, #eef0f4)' }}>
      <Flex gap={8} align="baseline" wrap>
        <Tag
          variant="filled"
          icon={meta?.icon}
          style={{ fontSize: 11, color: meta?.color ?? '#64748B', borderRadius: 6, marginInlineEnd: 0 }}
        >
          {meta?.label ?? '结果'}
        </Tag>
        {hit.engine && hit.engine !== 'd509' && hit.engine !== meta?.label && (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {hit.engine}
          </Typography.Text>
        )}
      </Flex>
      <div style={{ marginTop: 4, fontSize: 14.5, fontWeight: 550, lineHeight: 1.4 }}>
        {target ? (
          internal ? (
            <Link to={target} style={{ color: 'inherit' }}>
              {title}
            </Link>
          ) : (
            <a href={target} target="_blank" rel="noreferrer noopener" style={{ color: 'inherit' }}>
              {title}
            </a>
          )
        ) : (
          title
        )}
      </div>
      {(hit.kind === 'paper' || hit.hitSource) && (
        <Space size={6} style={{ marginTop: 4 }} wrap>
          {/* 文献必须标明数据实际来自哪个源：OpenAlex 挂掉时命中会降级到 Crossref，
              用户有权知道这条是谁给的。 */}
          <Tag variant="filled" color="purple" style={{ fontSize: 11, marginInlineEnd: 0 }}>
            {PAPER_SOURCES[hit.hitSource ?? ''] ?? hit.hitSource ?? '文献'}
          </Tag>
          {hit.year ? (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {hit.year}
            </Typography.Text>
          ) : null}
          {hit.venue ? (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {hit.venue}
            </Typography.Text>
          ) : null}
          {hit.authors?.length ? (
            <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis>
              {hit.authors.slice(0, 3).join('、')}
              {hit.authors.length > 3 ? ' 等' : ''}
            </Typography.Text>
          ) : null}
          {hit.doi ? (
            <Typography.Text code style={{ fontSize: 11 }}>
              {hit.doi}
            </Typography.Text>
          ) : null}
        </Space>
      )}
      {hit.category === 'knowledge' && (hit.docCategory || hit.updatedAt) && (
        <Space size={6} style={{ marginTop: 4 }}>
          <Tag variant="filled" style={{ fontSize: 11, marginInlineEnd: 0 }}>
            {hit.docCategory || '未分类'}
          </Tag>
          {hit.updatedAt ? (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              更新于 {new Date(hit.updatedAt).toLocaleString('zh-CN')}
            </Typography.Text>
          ) : null}
        </Space>
      )}
      {hit.content && (
        <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12.5 }}>
          {highlight(hit.content, keyword)}
        </Typography.Paragraph>
      )}
    </div>
  );
}

function DatabaseLines({ hits, keyword }: { hits: DatabaseHit[]; keyword: string }) {
  return (
    <>
      {hits.map((r) => (
        <div key={r.id} style={{ padding: '10px 4px', borderBottom: '1px solid var(--ant-color-border-secondary, #eef0f4)' }}>
          <Space size={6} wrap>
            <Tag color="cyan" variant="filled" style={{ fontSize: 11 }}>
              {r.source}
            </Tag>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {({ protein: '蛋白', species: '物种', gene: '基因', paper: '文献' } as Record<string, string>)[r.type] ?? r.type}
            </Typography.Text>
          </Space>
          <div style={{ marginTop: 4, fontSize: 14.5, fontWeight: 550, lineHeight: 1.4 }}>
            <a href={r.url} target="_blank" rel="noreferrer noopener" style={{ color: 'inherit' }}>
              {highlight(r.title, keyword)}
            </a>
          </div>
          {r.snippet ? (
            <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12.5 }}>
              {highlight(r.snippet, keyword)}
            </Typography.Paragraph>
          ) : null}
        </div>
      ))}
    </>
  );
}

export interface SearchResultsProps {
  data?: SearchResponse;
  keyword: string;
  page: number;
  pageSize: number;
  onPageChange: (page: number, pageSize: number) => void;
}

export default function SearchResults({ data, keyword, page, pageSize, onPageChange }: SearchResultsProps) {
  const results = data?.results ?? [];
  const local = results.filter((r) => r.kind === 'local' || r.engine === 'd509');
  const web = results.filter((r) => !(r.kind === 'local' || r.engine === 'd509'));
  const databases = data?.databases ?? [];

  const grouped = new Map<string, SearchHit[]>();
  for (const hit of web) {
    const key = webGroup(hit.category);
    grouped.set(key, [...(grouped.get(key) ?? []), hit]);
  }

  const total = Math.max((page - 1) * pageSize + web.length + (data?.hasMore ? pageSize : 0), web.length);

  return (
    <Flex vertical gap={16} style={{ width: '100%', textAlign: 'left' }}>
      {local.length > 0 && (
        <Card
          size="small"
          title={
            <Space>
              <AppstoreOutlined />
              <span>本地资源</span>
              <Tag variant="filled" style={{ fontSize: 11 }}>
                {data?.localTotal ?? local.length}
              </Tag>
            </Space>
          }
          extra={
            <Typography.Text className="d509-search-extra" type="secondary" style={{ fontSize: 12 }}>
              知识库 / 服务 / 文件 / 植物库 / 命令 / 工具
            </Typography.Text>
          }
        >
          {local.map((r, i) => (
            <HitLine key={`${r.url}-${i}`} hit={r} keyword={keyword} />
          ))}
        </Card>
      )}

      {databases.length > 0 && (
        <Card
          size="small"
          title={
            <Space>
              <DatabaseOutlined style={{ color: '#12A594' }} />
              <span>植物学数据库实时结果</span>
              <Tag variant="filled" style={{ fontSize: 11 }}>
                {databases.length}
              </Tag>
            </Space>
          }
          extra={
            <Typography.Text className="d509-search-extra" type="secondary" style={{ fontSize: 12 }}>
              UniProt / GBIF / Europe PMC / NCBI Gene
            </Typography.Text>
          }
        >
          <DatabaseLines hits={databases} keyword={keyword} />
          {(data?.databaseWarnings?.length ?? 0) > 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {data!.databaseWarnings!.join('；')}
            </Typography.Text>
          ) : null}
        </Card>
      )}

      {WEB_ORDER.map((key) => {
        const hits = grouped.get(key) ?? [];
        if (!hits.length) return null;
        const meta = WEB_GROUPS[key];
        return (
          <Card
            key={key}
            size="small"
            title={
              <Space>
                <span style={{ color: meta.color }}>{meta.icon}</span>
                <span>联网 · {meta.label}</span>
                <Tag variant="filled" style={{ fontSize: 11 }}>
                  {hits.length}
                </Tag>
              </Space>
            }
            extra={
              <Typography.Text className="d509-search-extra" type="secondary" style={{ fontSize: 12 }}>
                {(data?.engines ?? []).slice(0, 4).join('、') || 'SearXNG 聚合'}
              </Typography.Text>
            }
          >
            {hits.map((r, i) => (
              <HitLine key={`${r.url}-${i}`} hit={r} keyword={keyword} />
            ))}
          </Card>
        );
      })}

      {(web.length > 0 || data?.hasMore) && (
        <Flex justify="space-between" align="center" wrap gap={12} style={{ paddingBottom: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            第 {page} 页 · 本页 {web.length} 条
            {data?.webTotal ? ` · 已缓存 ${data.webTotal} 条` : ''}
          </Typography.Text>
          <Pagination
            size="small"
            current={page}
            pageSize={pageSize}
            total={total}
            showSizeChanger
            pageSizeOptions={[20, 30, 50, 100]}
            showLessItems
            onChange={(p, ps) => onPageChange(ps !== pageSize ? 1 : p, ps)}
          />
        </Flex>
      )}
    </Flex>
  );
}
