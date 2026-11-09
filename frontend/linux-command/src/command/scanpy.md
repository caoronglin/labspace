scanpy
===

单细胞转录组分析（Python 库与可执行入口）

## 补充说明

**Scanpy** 是 Python 生态里最常用的单细胞 RNA-seq 分析框架，覆盖 质控、归一化、高变基因、PCA、邻接图、UMAP/t-SNE、Leiden/Louvain 聚类、差异表达 与 细胞类型注释 全流程。它在命令行提供 `scanpy` 入口（`scanpy` / `python -m scanpy` 查看子命令），但绝大多数分析在 Jupyter/脚本中以 Python API 调用。数据规模大时可配合 `anndata` 的 HDF5 存储与 `scanpy.pp` 的稀疏矩阵实现降低内存占用。

## 语法

```shell
scanpy --help
python -c "import scanpy as sc; print(sc.__version__)"
```

典型脚本结构：

```python
import scanpy as sc
adata = sc.read_10x_mtx("filtered_feature_bc_matrix/")
sc.pp.filter_cells(adata, min_genes=200)
sc.pp.filter_genes(adata, min_cells=3)
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)
sc.pp.highly_variable_genes(adata, n_top_genes=2000)
adata = adata[:, adata.var.highly_variable]
sc.pp.scale(adata, max_value=10)
sc.tl.pca(adata, n_comps=30)
sc.pp.neighbors(adata, n_pcs=30)
sc.tl.umap(adata)
sc.tl.leiden(adata, resolution=0.8)
```

## 常用函数

### 读取与质控
* **sc.read_10x_mtx / read_10x_h5 / read_h5ad** 读取 Cell Ranger 或 anndata 文件
* **sc.pp.filter_cells / filter_genes** 过滤低质量细胞与低表达基因
* **sc.pp.calculate_qc_metrics** 计算线粒体/核糖体比例等指标
* **sc.pp.scrublet** 双细胞检测

### 归一化与降维
* **sc.pp.normalize_total** 按文库大小归一化
* **sc.pp.log1p** log 转换
* **sc.pp.highly_variable_genes** 选取高变基因
* **sc.pp.scale** 标准化
* **sc.tl.pca** 主成分分析
* **sc.pp.neighbors** 构建 kNN 图
* **sc.tl.umap / tsne** 二维嵌入

### 聚类与差异
* **sc.tl.leiden / louvain** 图聚类（`resolution` 控制簇数量）
* **sc.tl.rank_genes_groups** 簇间差异基因
* **sc.tl.score_genes** 基因集打分
* **sc.get.rank_genes_groups_df** 导出差异结果

### 保存与可视化
* **adata.write_h5ad("out.h5ad")** 保存中间结果
* **sc.pl.umap / dotplot / violin / heatmap** 常用出图

## 示例

10x 数据端到端脚本：

```shell
python - <<'PY'
import scanpy as sc
sc.settings.verbosity = 2
sc.settings.figdir = "figures/"
adata = sc.read_10x_h5("raw_feature_bc_matrix.h5")
adata.var_names_make_unique()
sc.pp.filter_cells(adata, min_genes=200)
sc.pp.filter_genes(adata, min_cells=3)
adata.var["mt"] = adata.var_names.str.startswith("MT-")
sc.pp.calculate_qc_metrics(adata, qc_vars=["mt"], inplace=True)
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)
sc.pp.highly_variable_genes(adata, n_top_genes=2000)
sc.pp.scale(adata, max_value=10)
sc.tl.pca(adata, n_comps=30)
sc.pp.neighbors(adata, n_pcs=30)
sc.tl.umap(adata)
sc.tl.leiden(adata, resolution=0.8)
sc.pl.umap(adata, color="leiden", save="_leiden.png")
adata.write_h5ad("processed.h5ad")
PY
```

## 注意事项

1. 过滤阈值按数据质量调整；线粒体比例过高的细胞通常需要剔除。
2. `scale` 之后的矩阵是稠密的，会显著占内存；大样本建议只在 HVG 子集上缩放。
3. 聚类分辨率 `resolution` 越大簇越多，需要结合 marker 基因与生物学背景判断。
4. 保存 h5ad 便于复现；不同 Scanpy 版本的 h5ad 结构可能不兼容，建议锁定版本。