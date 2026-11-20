import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Flex,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DownloadOutlined,
  ExperimentOutlined,
  ExportOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, type FileEntry } from '../services/api';
import PageShell from '../components/PageShell';
import { formatDateTime, formatSize } from '../utils/format';

/**
 * 公共基因组：只负责「看」。
 *
 * 1. 文件源 `genomes` —— 由 Go 核心按 ACL 过滤，只看得到有权限的文件；
 * 2. JBrowse 2 —— 跑在 8091，nginx `/jbrowse/` 同源反代，浏览器无需跨域；
 *    从文件存储选中的 FASTA 由 `/genome-api` 动态装配（IndexedFastaAdapter）。
 *
 * 序列层面的分析（GC / ORF / 酶切 / 翻译 / 比对…）已经统一到 `/bio-tools`：
 * 原来这里内嵌的 CropGenome（rust-bio）面板已下架，同一个页面里既有「浏览」
 * 又有「分析」会让人分不清该在哪儿做，也会把两套算法口径混在一起。
 */

const FASTA_EXTS = new Set(['fa', 'fna', 'fasta', 'fas', 'ffn', 'frn', 'faa']);

const COLUMNS = [
  { title: '名称', dataIndex: 'name', key: 'name', ellipsis: true },
  { title: '大小', dataIndex: 'size', key: 'size', width: 110 },
  { title: '更新时间', dataIndex: 'modified', key: 'modified', width: 180 },
  { title: '操作', key: 'ops', width: 240 },
];

function isFasta(name: string) {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return FASTA_EXTS.has(ext);
}

export default function Genomes() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [urlParams] = useSearchParams();
  // 从文件存储直跳进来时携带的基因组文件名，用于顶部提示
  const [linkedName, setLinkedName] = useState('');
  const handledLink = useRef('');
  // 文件存储选中的 FASTA：交给 JBrowse 动态装配，而不是硬塞进示例基因组
  const [jbrowseFile, setJbrowseFile] = useState<{ id: string; name: string } | null>(null);

  const jbrowseConfig = jbrowseFile
    ? `/genome-api/jbrowse/config?file_id=${encodeURIComponent(jbrowseFile.id)}`
    : '';
  const jbrowseSrc = jbrowseConfig
    ? `/jbrowse/index.html?config=${encodeURIComponent(jbrowseConfig)}`
    : '/jbrowse/';

  const genomes = useQuery({
    queryKey: ['genomes-files'],
    queryFn: () => api.files('genomes', 'name', 'asc'),
    staleTime: 30_000,
  });
  const entries = useMemo(() => (genomes.data?.entries ?? []).filter((e) => !e.dir), [genomes.data]);

  useEffect(() => {
    const name = urlParams.get('genome');
    if (!name) return;
    const gid = urlParams.get('gid') || '';
    const wantsAnalyze = urlParams.get('action') === 'analyze';
    const key = `${gid}|${name}|${wantsAnalyze ? 'analyze' : 'jbrowse'}`;
    if (handledLink.current === key) return;
    if (!gid && !genomes.isFetched) return;
    handledLink.current = key;
    setLinkedName(name);
    if (wantsAnalyze) {
      // 分析已迁到 /bio-tools：不再在这里内嵌一套算法面板
      message.info('序列分析已移到「生信工具」，请在那里粘贴或载入序列');
      navigate('/bio-tools');
      return;
    }
    const entry = entries.find((e) => (gid ? e.id === gid : e.name === name));
    const fileId = entry?.id ?? gid;
    if (!fileId) {
      message.warning('未找到该基因组文件，已打开 JBrowse 默认视图');
      return;
    }
    if (!isFasta(name)) {
      setJbrowseFile(null);
      message.info('JBrowse 动态装配只支持 FASTA 文件，已打开默认示例');
      return;
    }
    setJbrowseFile({ id: fileId, name });
    message.success(`已把 ${name} 载入 JBrowse 动态装配`);
  }, [entries, genomes.isFetched, urlParams, navigate, message]);

  return (
    <PageShell
      title="公共基因组"
      description="浏览实验室参考基因组（JBrowse 2）；序列分析、酶切、ORF、比对在「生信工具」里做，文件权限沿用实验室 ACL。"
      extra={
        <Space wrap>
          <Tag color="green" variant="filled">
            JBrowse 2
          </Tag>
          {linkedName ? (
            <Tag color="purple" variant="filled">
              来自文件空间 · {linkedName}
            </Tag>
          ) : null}
          <Button icon={<ExperimentOutlined />} type="primary" onClick={() => navigate('/bio-tools')}>
            生信工具
          </Button>
          <Button icon={<FolderOpenOutlined />} onClick={() => navigate('/files?source=genomes')}>
            文件空间
          </Button>
        </Space>
      }
    >
      <Flex vertical gap={12}>
        <Card
          size="small"
          title="基因组浏览"
          extra={
            <Space size={6}>
              {jbrowseFile ? (
                <Tag color="purple" variant="filled">
                  装配 {jbrowseFile.name}
                </Tag>
              ) : (
                <Tag variant="filled">默认示例</Tag>
              )}
              {jbrowseFile ? (
                <Button size="small" onClick={() => setJbrowseFile(null)}>
                  回到默认
                </Button>
              ) : null}
              <Button size="small" icon={<ExportOutlined />} href={jbrowseSrc} target="_blank" rel="noreferrer">
                新窗口打开
              </Button>
            </Space>
          }
          styles={{ body: { padding: 0, overflow: 'hidden' } }}
        >
          <iframe
            key={jbrowseSrc}
            src={jbrowseSrc}
            title="JBrowse 2 基因组浏览器"
            style={{ display: 'block', width: '100%', height: 'calc(100vh - 330px)', minHeight: 520, border: 0 }}
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        </Card>

        <Card
          size="small"
          title={
            <Space size={6}>
              <FileSearchOutlined />
              公共基因组文件
              <Tag variant="filled">{entries.length}</Tag>
            </Space>
          }
          extra={
            <Tooltip title="列表由实验室 ACL 过滤">
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={genomes.isFetching}
                onClick={() => genomes.refetch()}
              >
                刷新
              </Button>
            </Tooltip>
          }
        >
          {entries.length ? (
            <Table<FileEntry>
              rowKey="id"
              size="small"
              dataSource={entries}
              columns={COLUMNS.map((col) => {
                if (col.key === 'size') {
                  return { ...col, render: (_: unknown, r: FileEntry) => formatSize(r.size) };
                }
                if (col.key === 'modified') {
                  return { ...col, render: (_: unknown, r: FileEntry) => formatDateTime(r.modified) };
                }
                if (col.key === 'ops') {
                  return {
                    ...col,
                    render: (_: unknown, r: FileEntry) => (
                      <Space size={4} wrap>
                        {isFasta(r.name) ? (
                          <Button
                            size="small"
                            type="link"
                            icon={<FileSearchOutlined />}
                            onClick={() => setJbrowseFile({ id: r.id, name: r.name })}
                          >
                            浏览
                          </Button>
                        ) : null}
                        <Button
                          size="small"
                          type="link"
                          icon={<DownloadOutlined />}
                          href={`/api/files/${encodeURIComponent(r.id)}/download`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          下载
                        </Button>
                      </Space>
                    ),
                  };
                }
                return {
                  ...col,
                  render: (_: unknown, r: FileEntry) => (
                    <Tooltip title={r.path}>
                      <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5 }}>
                        {r.name}
                      </span>
                    </Tooltip>
                  ),
                };
              })}
              pagination={{ pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }}
            />
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Space orientation="vertical" size={4}>
                  <Typography.Text>当前目录还没有你看得到的基因组文件。</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    管理员可在「文件空间 → 公共基因组」上传 FASTA / GTF / BED，上传后此处立即出现。
                  </Typography.Text>
                </Space>
              }
            >
              <Button type="primary" icon={<FolderOpenOutlined />} onClick={() => navigate('/files?source=genomes')}>
                前往文件空间
              </Button>
            </Empty>
          )}
        </Card>

        <Alert
          type="info"
          showIcon
          title="默认示例与自有 FASTA"
          description="未选择文件时展示教学示例；从文件空间选中 FASTA 后，JBrowse 会用 IndexedFastaAdapter 动态装配该文件（按你的文件权限读取），无需预先配置参考基因组。"
        />
      </Flex>
    </PageShell>
  );
}
