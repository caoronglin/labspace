fastp
===

超快速 FASTQ 质控与过滤工具

## 补充说明

**fastp** 是一个用 C++ 编写的 FASTQ 预处理工具，可一次性完成接头去除、质量过滤、滑窗剪切、polyG/polyX 修剪、双端数据校正、UMI 处理与质控报告生成。相比 Trimmomatic 等老工具，fastp 在保持相同过滤效果的前提下速度更快，并且无需额外脚本即可输出 HTML/JSON 质控报告，适合作为 RNA-seq、WGS、ChIP-seq 等流程的第一步。

## 语法

```shell
fastp [options]
```

## 常用选项

* **-i, --in1** 输入文件 1（单端或双端 R1）
* **-I, --in2** 输入文件 2（双端 R2）
* **-o, --out1** 输出文件 1
* **-O, --out2** 输出文件 2
* **--unpaired1 / --unpaired2** 双端中一端被过滤后剩余单端的输出
* **-q, --qualified_quality_phred** 合格碱基质量阈值，默认 15
* **-u, --unqualified_percent_limit** 一条 read 中允许低质量碱基的比例，默认 40
* **-n, --n_base_limit** 允许 N 碱基的数量，默认 5
* **-l, --length_required** 过滤后最短 read 长度，默认 15
* **--cut_front / --cut_tail / --cut_right** 从 5′ / 3′ 端或滑窗剪切
* **--cut_window_size / --cut_mean_quality** 滑窗大小与窗口平均质量阈值
* **-a, --adapter_sequence** 单端接头序列（默认自动识别）
* **--detect_adapter_for_pe** 双端数据自动检测接头
* **-g, --trim_poly_g** 去除 3′ 端 polyG（NextSeq/NovaSeq 推荐开启）
* **-x, --trim_poly_x** 去除 3′ 端 polyX
* **-f, --trim_front1 / -t, --trim_tail1** 从 R1 前端/尾端裁剪固定长度
* **-w, --thread** 线程数，默认 3
* **-j, --json** JSON 报告路径
* **-h, --html** HTML 报告路径
* **--correction** 双端重叠区碱基校正（仅 PE）
* **--dedup** 去除重复 read
* **--overrepresentation_analysis** 过表达序列分析

## 示例

双端数据一键质控，输出干净数据和 HTML 报告：

```shell
fastp -i raw_R1.fq.gz -I raw_R2.fq.gz \
      -o clean_R1.fq.gz -O clean_R2.fq.gz \
      --detect_adapter_for_pe \
      -g -q 20 -u 30 -l 30 \
      -w 8 \
      -h fastp.html -j fastp.json
```

单端数据并保留被过滤掉的 reads：

```shell
fastp -i in.fq.gz -o out.fq.gz --failed_out failed.fq.gz -h report.html
```

## 注意事项

1. 默认会同时写 `fastp.html` 与 `fastp.json`；流水线里建议显式指定路径，便于归档。
2. 双端数据使用 `--detect_adapter_for_pe` 比手动填写接头序列更稳妥。
3. Illumina NextSeq/NovaSeq 数据应开启 `-g`，否则 3′ polyG 会显著影响比对。
4. 过度修剪会降低有效数据量，先看报告中的 `passed_filter_reads` 再决定阈值。