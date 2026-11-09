bismark
===

亚硫酸氢盐测序（WGBS/RRBS）比对与甲基化位点提取

## 补充说明

**Bismark** 是 Babraham Institute 开发的 BS-seq 专用比对与甲基化检出工具。亚硫酸氢盐测序会把未甲基化的胞嘧啶转化为尿嘧啶（测序后表现为 T），因此不能用普通比对器；Bismark 通过三字母（C→T、G→A）转换基因组后比对，再依据比对结果判定每个胞嘧啶的甲基化状态。它依赖 Bowtie2（或 HISAT2）作为底层比对引擎，流程分为 基因组准备、比对、去重、甲基化提取 四步。

## 语法

```shell
# 建立基因组索引
bismark_genome_preparation --bowtie2 /path/to/genome_dir

# 比对
bismark [options] --genome /path/to/genome_dir -1 R1.fq.gz -2 R2.fq.gz

# 去重
deduplicate_bismark [options] -p aligned_pe.bam

# 提取甲基化
bismark_methylation_extractor [options] aligned.deduplicated.bam
```

## 常用选项

### bismark_genome_preparation
* **--bowtie2** 生成 Bowtie2 索引（当前版本默认）
* **--hisat2** 生成 HISAT2 索引
* **--parallel INT** 并行转换的线程数
* **--verbose** 输出详细信息

### bismark
* **--genome DIR** 基因组索引目录（必填）
* **-1 / -2 FILE** 双端 reads；单端使用未命名参数 `reads.fq.gz`
* **--non_directional** 非定向文库（PBAT/emSEQ 等）
* **--pbat** PBAT 文库
* **--score_min STR** 最小比对分数，例如 `L,0,-0.2`
* **-p INT / --parallel INT** 并行比对线程数
* **--multicore INT** 并行处理的基因组区域数（每区域再分多个子进程）
* **-o DIR** 输出目录
* **--unmapped** 同时输出未比对 reads
* **--ambiguous** 输出多重比对 reads
* **--cytosine_report** 直接生成全基因组胞嘧啶报告（需配合提取步骤）

### deduplicate_bismark
* **-p / --paired** 双端模式
* **--barcode** 按 barcode 分组去重
* **-o DIR** 输出目录

### bismark_methylation_extractor
* **-p / --paired-end** 双端输入
* **--comprehensive** 输出 CHG/CHH 上下文
* **--merge_non_CpG** 合并 CHG/CHH 到同一文件
* **--bedGraph** 生成 bedGraph
* **--cytosine_report** 生成全基因组胞嘧啶报告（需基因组 FASTA）
* **--genome_folder DIR** 配合 `--cytosine_report` 使用
* **--gzip** 压缩输出
* **--multicore INT** 并行提取
* **--buffer_size STR** 缓冲大小，如 `10%`

## 示例

双端 RRBS 全流程：

```shell
bismark_genome_preparation --bowtie2 --parallel 8 genome/

bismark --genome genome/ --parallel 4 \
        -1 sample_R1_val_1.fq.gz -2 sample_R2_val_2.fq.gz

deduplicate_bismark -p --output_dir dedup/ \
        sample_R1_val_1_bismark_bt2_pe.bam

bismark_methylation_extractor -p --comprehensive --bedGraph --gzip \
        --multicore 4 --genome_folder genome/ \
        dedup/sample_R1_val_1_bismark_bt2_pe.deduplicated.bam
```

生成甲基化报告：

```shell
bismark2report
bismark2summary
```

## 注意事项

1. 比对前请用 Trim Galore 等工具去除接头与低质量碱基，并保留双端配对关系。
2. 定向文库与 PBAT 的转换链不同，模式选错会导致甲基化率整体偏低。
3. 去重必须使用 `deduplicate_bismark`，普通 `samtools markdup` 不适用于 BS-seq。
4. 甲基化提取需要与建索引时完全相同的基因组目录，否则坐标会错位。