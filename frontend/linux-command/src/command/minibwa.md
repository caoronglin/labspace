minibwa
===

轻量级 BWA-MEM 风格短读/长读比对工具

## 补充说明

**minibwa** 是 lh3 维护的 BWA-MEM 精简实现，用更小的代码量复现 BWA-MEM 的种子—延伸比对思路，适合在内存与部署成本受限的环境里替代传统 BWA。它读取 FASTA 参考基因组与 FASTQ 测序数据，输出标准 SAM，可继续接 `samtools` 排序、去重与变异检测流程。与 BWA 家族一样，它面向 DNA 比对；RNA-seq 剪接比对应改用 STAR/HISAT2。

## 语法

```shell
minibwa [options] <ref.fa> <reads.fq> [reads2.fq] > out.sam
```

首次使用建议先为参考基因组建立索引（不同版本子命令名可能略有差异，`minibwa` 无参数时会打印帮助）：

```shell
minibwa index ref.fa
```

## 常用选项

* **-t INT** 比对线程数
* **-x STR** 预设参数（如长读/短读模式，按版本帮助选择）
* **-R STR** 在 SAM 头中写入 read group，例如 `@RG\tID:s1\tSM:sample1`
* **-o FILE** 直接输出到文件
* **-h INT** 输出包含所有比对记录的 SAM（默认只给最佳比对）
* **-K INT** 每个批次处理的 reads 数量，影响流式内存占用
* **-Y** 使用软剪切（soft clipping）表示无法比对的末端
* **-M** 将较短的补充比对标记为 secondary

## 示例

单端短读比对并压缩为 BAM：

```shell
minibwa -t 16 ref.fa reads.fq.gz 2> align.log | samtools view -b -o sample.bam -
```

双端比对并带上样本信息：

```shell
minibwa -t 16 -R '@RG\tID:lib1\tSM:sample1\tPL:ILLUMINA' \
        ref.fa R1.fq.gz R2.fq.gz > sample.sam
samtools sort -@ 8 -o sample.sorted.bam sample.sam
samtools index sample.sorted.bam
```

统计比对率：

```shell
samtools flagstat sample.sorted.bam
```

## 注意事项

1. 参考基因组必须与测序物种、版本一致；换参考后要重建索引。
2. 输出是 SAM 流，务必用 `samtools` 排序并建立 `.bai`，否则下游变异检测会报错。
3. 长读数据（ONT/PacBio）通常用 minimap2 更合适；minibwa 定位更接近短读场景。
4. 关注日志中的 mapping rate 与 properly paired 比例，异常低时优先检查接头与参考版本。