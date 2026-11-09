---
name: plant-database-search
description: 植物学与生物信息学数据库检索指南。当用户查询基因、蛋白、通路、种质、变异或比较基因组信息，需要选择数据库并调用 lab_database_query 时使用。
---

# 植物数据库检索

## 工作顺序

1. 先判断对象类型：核酸/基因组、蛋白、通路、种质表型、变异、比较基因组或文献。
2. 选择 1 个最对口的数据库先查，不要同时试探多个库。
3. 使用 `lab_database_query`，`database` 填数据库英文名或 id，`query` 填基因 ID、物种拉丁名或关键词，`limit` 不超过 10。
4. 结果必须逐条转述标题、链接与来源字段；不得补写数据库没有返回的内容。
5. 无结果或接口失败时，换同类数据库重试一次，仍失败则如实说明失败原因。

## 常用数据库对应关系

- 核酸、蛋白、文献综合检索：`NCBI`、`EBI`
- 蛋白序列与功能注释：`UniProtKB`、`InterPro`、`Pfam`、`PANTHER`、`PDB`（结构）
- 模式植物拟南芥：`TAIR`
- 水稻：`MSU Rice Genome Annotation`、`Gramene`
- 比较基因组：`Phytozome`、`Ensembl Plants`、`PLAZA`、`PlantGDB`
- 代谢通路：`KEGG`、`PlantCyc`
- 种质与表型：`GRIN`、`PhytoPath`、`PRGdb`
- 作物专库：`SoyBase`（大豆）、`CottonGen`（棉花）、`GDR`（蔷薇科）、`SolGenomics`（茄科）
- 转录因子：`PlantTFDB`、`iTAK`
- 非编码 RNA：`RNAcentral`、`PNRD`、`plant small RNA DB`
- 基因组大小：`C-values`

## 查询技巧

- 基因 ID 查询时保留物种前缀（如 `AT1G01010`、`LOC_Os01g01010`），不要自行改写大小写。
- 物种检索使用拉丁名，首次出现时附中文名。
- 通路检索优先用 KEGG 通路编号或酶 EC 号。
- 结果中的坐标、版本号、登录号原样保留。
