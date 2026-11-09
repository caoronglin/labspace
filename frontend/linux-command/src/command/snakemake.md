snakemake
===

基于 Python 的可重复工作流管理系统

## 补充说明

**Snakemake** 用规则（rule）描述每一步分析，自动推导文件依赖，只重跑缺失或过期的步骤。它支持通配符、集群/容器/云执行、断点续跑、并行调度与资源声明，是生信流水线最常用的工作流引擎之一。核心理念：*用文件而不是脚本来描述流程*。

## 语法

```shell
snakemake [options] [targets]
```

## 常用选项

* **-s, --snakefile** 指定 Snakefile 路径，默认当前目录 `Snakefile`
* **-j, --cores** 使用本地核数；`--cores all` 使用全部可用核
* **-n, --dry-run** 只打印将要执行的规则，不真正运行
* **-p, --printshellcmds** 打印实际执行的 shell 命令
* **-r, --reason** 说明每条规则为何需要重新执行
* **-F, --force** 强制重跑目标
* **-R, --forcerun** 强制重跑指定规则
* **--rerun-incomplete** 重跑未完成的任务（中断后恢复常用）
* **--keep-going** 单个任务失败后继续执行其他独立分支
* **-k / --rerun-triggers** 控制判定过期依据（code、input、params、software-env 等）
* **--config key=value** 传入配置参数
* **--configfile** 从 YAML/JSON 读取配置
* **--profile** 加载执行配置（集群、容器、资源默认值）
* **--use-conda / --use-singularity / --use-apptainer** 按规则启用隔离环境
* **--resources** 声明资源上限（如 `mem_mb=64000`），供调度器分配
* **--latency-wait** 等待文件系统同步的秒数（NFS 场景建议提高）
* **--dag / --rulegraph** 输出 DAG/规则图（配合 `dot` 渲染）
* **--report** 生成 HTML 报告

## 示例

`Snakefile` 示例：质控 → 比对 → 排序索引

```python
rule all:
    input:
        "results/sample.sorted.bam",
        "results/sample.sorted.bam.bai"

rule fastp:
    input:
        r1="raw/{sample}_R1.fq.gz",
        r2="raw/{sample}_R2.fq.gz"
    output:
        r1="clean/{sample}_R1.fq.gz",
        r2="clean/{sample}_R2.fq.gz",
        html="qc/{sample}.html"
    threads: 8
    shell:
        "fastp -i {input.r1} -I {input.r2} -o {output.r1} -O {output.r2} "
        "--detect_adapter_for_pe -w {threads} -h {output.html}"

rule align:
    input:
        r1="clean/{sample}_R1.fq.gz",
        r2="clean/{sample}_R2.fq.gz"
    output:
        "results/{sample}.bam"
    threads: 16
    shell:
        "bowtie2 -p {threads} -x index/genome -1 {input.r1} -2 {input.r2} "
        "| samtools sort -@ 4 -o {output}"

rule index:
    input: "results/{sample}.bam"
    output: "results/{sample}.sorted.bam.bai"
    shell: "samtools index {input}"
```

先干跑检查依赖，再正式执行：

```shell
snakemake -n -r -p
snakemake -j 32 --rerun-incomplete --keep-going
```

导出流程图：

```shell
snakemake --dag | dot -Tsvg > dag.svg
```

## 注意事项

1. 输出文件名是规则的“契约”，不要手工改写中间文件，否则触发不必要的重跑。
2. 在 NFS/共享存储上使用 `--latency-wait 30`，避免文件尚未可见导致的误判。
3. 使用 `--profile` 把集群参数与资源声明集中管理，避免命令行越写越长。
4. 中断后优先 `--rerun-incomplete`，而不是删除全部结果重来。