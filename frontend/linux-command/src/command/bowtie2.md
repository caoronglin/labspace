bowtie2
===

短读序列比对（Bowtie 2）

## 补充说明

**Bowtie2** 是高效的短读比对工具，支持双端/单端 reads，能处理较长读段（最长可达数千 bp）与局部比对（半全局/局部模式），广泛用于 ChIP-seq、RNA-seq（配合 tophat/StringTie）、BS-seq（Bismark 底层）等流程。它需要一个已建立的索引（`.bt2` 文件），输出 SAM 格式。

## 语法

```shell
bowtie2-build [options] ref.fa index_base

bowtie2 [options] -x index_base -1 R1.fq.gz -2 R2.fq.gz -S out.sam
```

## 常用选项

### bowtie2-build
* **--threads INT / -p INT** 建索引线程数
* **--large-index** 超过 4G 的参考基因组使用大索引
* **--seed INT** 随机种子

### bowtie2
* **-x STR** 索引前缀（必填）
* **-1 / -2 FILE** 双端 reads；单端用 `-U`
* **-S FILE** 输出 SAM（默认 stdout）
* **-p / --threads INT** 线程数
* **--very-fast / --fast / --sensitive / --very-sensitive** 敏感度预设
* **--end-to-end / --local** 比对模式（默认 end-to-end）
* **-k INT** 最多报告 k 条比对
* **-a / --all** 报告所有有效比对
* **--no-unal** 不输出未比对 reads
* **--un-conc FILE** 输出未配对的双端 reads
* **-q** 输入为 FASTQ（默认）
* **--phred33 / --phred64** 质量值编码
* **--rg-id / --rg** 写入 read group 信息
* **-t / --time** 打印耗时

## 示例

建立索引并双端比对：

```shell
bowtie2-build --threads 8 genome.fa genome_index

bowtie2 -p 16 --very-sensitive -x genome_index \
        -1 sample_R1.fq.gz -2 sample_R2.fq.gz \
        --no-unal 2> align.log | samtools view -b -o sample.bam -
```

单端：

```shell
bowtie2 -p 16 -x genome_index -U reads.fq.gz 2> align.log | samtools sort -o sample.sorted.bam -
```

查看比对率（日志里）：

```
95.00% overall alignment rate
```

## 注意事项

1. 索引前缀是 `-x` 后的路径，不需要带 `.bt2` 后缀。
2. 比对模式影响结果：end-to-end 适合短读，local 适合含接头或长读。
3. 输出未排序 SAM，下游需 `samtools sort` 并 `samtools index`。
4. 双端 reads 顺序必须一一对应，否则会大量报“paired reads not found”。