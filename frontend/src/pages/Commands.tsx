import { useEffect, useMemo, useState } from 'react';
import { Card, Col, Empty, Flex, Input, Row, Space, Spin, Tabs, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { CodeOutlined, ExperimentOutlined, SearchOutlined } from '@ant-design/icons';
import MarkdownView from '../components/MarkdownView';


interface ToolDoc {
  name: string;
  category: string;
  url: string;
  summary: string;
}

/**
 * 生信常用工具的**官方**文档入口。
 *
 * 只收官方站点（GitHub README / 项目文档 / NCBI 手册），不收教程博客：
 * 教程会过时，官方文档不会跑。summary 只写一句"治什么病"，具体用法点进去看。
 */
const TOOL_DOCS: ToolDoc[] = [
  { name: 'BLAST+', category: '序列比对', url: 'https://blast.ncbi.nlm.nih.gov/doc/blast-help/', summary: 'NCBI 官方手册：blastn/blastp/tblastn 参数与结果解读' },
  { name: 'BWA', category: '序列比对', url: 'https://bio-bwa.sourceforge.net/bwa.shtml', summary: '短读长比对到参考基因组，产出 SAM；mem 是最常用子命令' },
  { name: 'Bowtie2', category: '序列比对', url: 'https://bowtie-bio.sourceforge.net/bowtie2/manual.shtml', summary: '另一套短读长比对器，对长读长与局部比对更宽容' },
  { name: 'HISAT2', category: '序列比对', url: 'https://daehwankimlab.github.io/hisat2/manual/', summary: 'RNA-seq 剪接感知比对，需要先建 index' },
  { name: 'STAR', category: '序列比对', url: 'https://github.com/alexdobin/STAR/blob/master/doc/STARmanual.pdf', summary: 'RNA-seq 主力比对器，速度快但内存占用高' },
  { name: 'minimap2', category: '序列比对', url: 'https://lh3.github.io/minimap2/minimap2.html', summary: '长读长（ONT/PacBio）与组装比对的首选' },
  { name: 'samtools', category: 'BAM 处理', url: 'http://www.htslib.org/doc/samtools.html', summary: 'SAM/BAM 排序、索引、子集、统计的瑞士军刀' },
  { name: 'BCFtools', category: '变异检测', url: 'https://samtools.github.io/bcftools/bcftools.html', summary: 'VCF/BCF 的 call、filter、merge、注释' },
  { name: 'GATK', category: '变异检测', url: 'https://gatk.broadinstitute.org/hc/en-us/sections/360007226651-Best-Practices-Workflows', summary: '胚系/体细胞变异检测最佳实践流程（含 HaplotypeCaller）' },
  { name: 'freebayes', category: '变异检测', url: 'https://github.com/freebayes/freebayes', summary: '贝叶斯式变异检测，小规模数据上手快' },
  { name: 'FastQC', category: '质控', url: 'https://www.bioinformatics.babraham.ac.uk/projects/fastqc/', summary: '测序原始数据质量报告（碱基质量、接头、GC 偏移）' },
  { name: 'MultiQC', category: '质控', url: 'https://docs.seqera.io/multiqc/', summary: '把一堆 QC/比对/定量结果汇总成一份 HTML' },
  { name: 'Trimmomatic', category: '质控', url: 'http://www.usadellab.org/cms/?page=trimmomatic', summary: '去接头与低质量碱基，RNA/DNA 通用' },
  { name: 'fastp', category: '质控', url: 'https://github.com/OpenGene/fastp', summary: '一体化质控 + 过滤，自动出报告，速度快' },
  { name: 'featureCounts', category: '定量', url: 'https://subread.sourceforge.net/featureCounts.html', summary: '按 GTF 把 reads 数到基因/外显子上，产出 count 矩阵' },
  { name: 'Salmon', category: '定量', url: 'https://salmon.readthedocs.io/en/latest/', summary: '转录本水平定量（不依赖比对），速度快' },
  { name: 'kallisto', category: '定量', url: 'https://pachterlab.github.io/kallisto/manual', summary: '伪比对定量，资源占用低' },
  { name: 'DESeq2', category: '差异分析', url: 'https://bioconductor.org/packages/release/bioc/vignettes/DESeq2/inst/doc/DESeq2.html', summary: 'RNA-seq 差异表达的标准方法（负二项模型）' },
  { name: 'edgeR', category: '差异分析', url: 'https://bioconductor.org/packages/release/bioc/vignettes/edgeR/inst/doc/edgeRUsersGuide.pdf', summary: '另一套差异表达框架，适合小样本与多组比较' },
  { name: 'Seurat', category: '单细胞', url: 'https://satijalab.org/seurat/articles/get_started', summary: '单细胞 RNA-seq 分析主流程（QC/聚类/注释）' },
  { name: 'Scanpy', category: '单细胞', url: 'https://scanpy.readthedocs.io/en/stable/', summary: 'Python 单细胞分析，等价于 Seurat 的生态位' },
  { name: 'Cellranger', category: '单细胞', url: 'https://www.10xgenomics.com/support/software/cell-ranger/latest', summary: '10x 官方流程：从 fastq 到表达矩阵' },
  { name: 'JBrowse 2', category: '基因组浏览', url: 'https://jbrowse.org/jb2/docs/', summary: '可嵌入的基因组浏览器（本站 /genomes 已集成）' },
  { name: 'Primer3', category: '引物设计', url: 'https://primer3.org/manual.html', summary: '引物设计参数与热力学模型说明' },
  { name: 'IGV', category: '可视化', url: 'https://igv.org/doc/desktop/', summary: '桌面端基因组浏览与 BAM/VCF 查看' },
  { name: 'MultiQC 插件', category: '可视化', url: 'https://docs.seqera.io/multiqc/development/plugins', summary: '自定义 MultiQC 报告模块的写法' },
];

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
    <Tabs
      defaultActiveKey="commands"
      items={[
        {
          key: 'commands',
          label: (
            <span>
              <CodeOutlined /> Linux 命令
            </span>
          ),
          children: (
            <Flex vertical gap={16}>
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
                    styles={{ body: { maxHeight: 'calc(100vh - 300px)', minHeight: 420, overflow: 'auto' } }}
                  >
                    {isLoading ? (
                      <Flex justify="center" style={{ padding: 30 }}>
                        <Spin />
                      </Flex>
                    ) : items.length === 0 ? (
                      <Empty description="没有匹配的命令" />
                    ) : (
                      // 之前每个首字母分组各自套一个 Listy（height 上限 240），
                      // 分组一多就变成十几个小滚动区，命令被截断且要滚很多次。
                      // 改为整列一个滚动容器，字母标题吸顶。
                      <Flex vertical gap={2}>
                        {grouped.map(([ch, list]) => (
                          <div key={ch}>
                            <div
                              style={{
                                position: 'sticky',
                                top: 0,
                                zIndex: 1,
                                padding: '6px 8px',
                                fontSize: 12,
                                color: 'var(--ant-color-text-tertiary)',
                                background: 'var(--ant-color-bg-container, #fff)',
                                borderBottom: '1px solid var(--ant-color-border-secondary, #eef0f4)',
                              }}
                            >
                              {ch} · {list.length}
                            </div>
                            {list.map((it) => {
                              const active = selected === it.name;
                              return (
                                <div
                                  key={it.name}
                                  role="button"
                                  tabIndex={0}
                                  aria-pressed={active}
                                  onClick={() => setSelected(it.name)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      setSelected(it.name);
                                    }
                                  }}
                                  style={{
                                    cursor: 'pointer',
                                    padding: '7px 8px',
                                    borderRadius: 8,
                                    background: active
                                      ? 'var(--ant-color-primary-bg, rgba(37,99,235,0.08))'
                                      : undefined,
                                    borderInlineStart: active
                                      ? '3px solid var(--ant-color-primary, #2B5CE6)'
                                      : '3px solid transparent',
                                    outline: 'none',
                                  }}
                                >
                                  <Typography.Text strong={active} style={{ fontSize: 13 }}>
                                    {it.name}
                                  </Typography.Text>
                                  <Typography.Paragraph
                                    type="secondary"
                                    style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}
                                    ellipsis={{ rows: 2 }}
                                  >
                                    {it.desc}
                                  </Typography.Paragraph>
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </Flex>
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
          ),
        },

              {
                key: 'tools',
                label: (
                  <span>
                    <ExperimentOutlined /> 生信工具文档
                  </span>
                ),
                children: (
                  <Flex vertical gap={12}>
                    <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                      只收官方文档入口（NCBI 手册 / 项目 GitHub / 官方 docs）。教程会过时，官方文档不会跑。
                    </Typography.Text>
                    {Object.entries(
                      TOOL_DOCS.reduce<Record<string, ToolDoc[]>>((acc, tool) => {
                        (acc[tool.category] ??= []).push(tool);
                        return acc;
                      }, {}),
                    ).map(([category, tools]) => (
                      <Card key={category} size="small" title={category} style={{ borderRadius: 10 }}>
                        <Row gutter={[12, 12]}>
                          {tools.map((tool) => (
                            <Col xs={24} md={12} xl={8} key={tool.url}>
                              <a
                                href={tool.url}
                                target="_blank"
                                rel="noreferrer"
                                style={{ display: 'block', padding: '6px 8px', borderRadius: 8 }}
                              >
                                <Typography.Text strong style={{ fontSize: 13 }}>
                                  {tool.name}
                                </Typography.Text>
                                <Typography.Paragraph
                                  type="secondary"
                                  style={{ fontSize: 12, margin: '2px 0 0', lineHeight: 1.55 }}
                                >
                                  {tool.summary}
                                </Typography.Paragraph>
                              </a>
                            </Col>
                          ))}
                        </Row>
                      </Card>
                    ))}
                  </Flex>
                ),
              },
      ]}
    />
  );
}
