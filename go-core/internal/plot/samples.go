package plot

import (
	"crypto/rand"
	"encoding/hex"
)

func newID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return hex.EncodeToString([]byte{byte(len(b))})
	}
	return hex.EncodeToString(b)
}

var sampleList = []Sample{
	{
		ID:          "bar-growth",
		Name:        "处理组生长量",
		Chart:       "bar",
		Description: "3 个处理 × 2 个基因型的均值比较。",
		Data: `category,value,group
Control,12.4,WT
Low-N,10.1,WT
High-N,15.2,WT
Control,9.8,mut1
Low-N,6.4,mut1
High-N,11.1,mut1
Control,13.7,WT
Low-N,10.9,WT
High-N,16.0,WT
Control,10.2,mut1
Low-N,6.9,mut1
High-N,11.8,mut1
`,
		Params: map[string]any{"x": "category", "y": "value", "group": "group", "agg": "mean"},
	},
	{
		ID:          "line-dose",
		Name:        "剂量响应曲线",
		Chart:       "line",
		Description: "两次重复的 OD600 随处理浓度变化。",
		Data: `dose,od,rep
0,0.12,R1
1,0.21,R1
2,0.38,R1
4,0.71,R1
8,1.02,R1
16,1.18,R1
0,0.11,R2
1,0.23,R2
2,0.36,R2
4,0.68,R2
8,0.97,R2
16,1.15,R2
`,
		Params: map[string]any{"x": "dose", "y": "od", "group": "rep"},
	},
	{
		ID:          "scatter-cor",
		Name:        "表达量相关",
		Chart:       "scatter",
		Description: "qPCR 与 RNA-seq 的 log2 表达值。",
		Data: `qpcr,rnaseq,tissue
2.1,2.4,leaf
3.4,3.1,leaf
4.8,5.0,leaf
5.2,4.7,root
6.1,6.5,root
6.8,6.4,root
1.2,1.5,stem
2.5,2.2,stem
3.9,3.6,stem
5.5,5.9,seed
6.4,6.1,seed
7.1,7.4,seed
`,
		Params: map[string]any{"x": "qpcr", "y": "rnaseq", "group": "tissue", "trendline": true},
	},
	{
		ID:          "box-yield",
		Name:        "田间产量箱线图",
		Chart:       "box",
		Description: "三个品种在两种氮水平下的产量分布。",
		Data: `cultivar,yield,nitrogen
A,420,Low
A,455,Low
A,398,Low
A,470,Low
A,512,High
A,498,High
A,530,High
B,380,Low
B,365,Low
B,402,Low
B,441,Low
B,470,High
B,455,High
B,488,High
C,450,Low
C,478,Low
C,432,Low
C,495,Low
C,540,High
C,525,High
C,558,High
`,
		Params: map[string]any{"x": "cultivar", "y": "yield", "group": "nitrogen", "points": true},
	},
	{
		ID:          "violin-expression",
		Name:        "基因表达小提琴图",
		Chart:       "violin",
		Description: "四个组织中的表达分布。",
		Data: `tissue,expression
leaf,12.4
leaf,11.2
leaf,13.8
leaf,10.9
leaf,14.1
root,7.2
root,6.8
root,8.1
root,7.5
root,8.9
stem,9.4
stem,10.1
stem,8.7
stem,9.9
stem,10.6
seed,15.2
seed,16.8
seed,14.4
seed,17.1
seed,15.9
`,
		Params: map[string]any{"x": "tissue", "y": "expression", "points": true},
	},
	{
		ID:          "heatmap-matrix",
		Name:        "表达矩阵热图",
		Chart:       "heatmap",
		Description: "12 个基因 × 6 个样本的标准化表达。",
		Data: `gene,S1,S2,S3,S4,S5,S6
GENE1,2.4,2.1,1.8,4.6,4.9,4.2
GENE2,1.2,0.9,1.4,3.8,4.1,3.9
GENE3,3.1,2.8,3.4,1.9,1.6,2.2
GENE4,0.8,1.2,1.0,2.9,3.1,2.7
GENE5,4.5,4.8,4.2,2.1,1.8,2.4
GENE6,2.9,3.3,3.0,5.1,5.4,4.8
GENE7,1.6,1.4,1.9,0.9,1.2,1.0
GENE8,5.2,4.9,5.5,3.6,3.2,3.8
GENE9,0.5,0.7,0.6,2.4,2.8,2.1
GENE10,3.8,3.5,4.1,1.7,1.4,1.9
GENE11,2.2,2.6,2.0,4.3,4.6,4.0
GENE12,4.1,3.7,4.4,2.2,2.5,2.0
`,
		Params: map[string]any{"standardize": true, "cmap": "RdBu_r"},
	},
	{
		ID:          "volcano-deg",
		Name:        "差异表达火山图",
		Chart:       "volcano",
		Description: "30 个基因的 log2FC 与调整后 p 值。",
		Data: `gene,log2fc,padj
GENE1,2.8,0.001
GENE2,3.4,0.0004
GENE3,-2.6,0.002
GENE4,1.2,0.08
GENE5,-3.8,0.0002
GENE6,4.1,0.0001
GENE7,-1.1,0.12
GENE8,0.8,0.35
GENE9,2.1,0.03
GENE10,-2.9,0.004
GENE11,3.6,0.0008
GENE12,-0.6,0.52
GENE13,1.7,0.04
GENE14,-4.2,0.0001
GENE15,0.3,0.78
GENE16,2.4,0.008
GENE17,-1.8,0.045
GENE18,1.1,0.22
GENE19,-2.2,0.012
GENE20,3.9,0.0003
GENE21,0.5,0.61
GENE22,-3.1,0.001
GENE23,1.9,0.02
GENE24,-0.9,0.31
GENE25,2.7,0.005
GENE26,-1.4,0.09
GENE27,0.7,0.47
GENE28,4.5,0.0001
GENE29,-2.0,0.018
GENE30,1.5,0.06
`,
		Params: map[string]any{"gene": "gene", "x": "log2fc", "y": "padj", "fc_cut": 1, "p_cut": 0.05, "labels": 8},
	},
	{
		ID:          "venn-overlap",
		Name:        "三组学交集",
		Chart:       "venn",
		Description: "RNA-seq / ChIP-seq / ATAC-seq 基因重叠。",
		Data: `gene,RNAseq,ChIPseq,ATACseq
GENE1,1,1,0
GENE2,1,0,1
GENE3,1,1,1
GENE4,0,1,1
GENE5,1,0,0
GENE6,0,0,1
GENE7,1,1,1
GENE8,0,1,0
GENE9,1,0,1
GENE10,1,1,0
GENE11,0,1,1
GENE12,1,1,1
`,
		Params: map[string]any{"sets": []string{"RNAseq", "ChIPseq", "ATACseq"}},
	},
	{
		ID:          "tree-phylo",
		Name:        "系统发育树",
		Chart:       "tree",
		Description: "6 个物种的 Newick 树。",
		Newick:      "(((Arabidopsis:0.12,Brassica:0.18):0.08,(Solanum:0.22,Capsicum:0.19):0.10):0.15,(Oryza:0.31,Zea:0.27):0.20);",
		Params:      map[string]any{"newick": "(((Arabidopsis:0.12,Brassica:0.18):0.08,(Solanum:0.22,Capsicum:0.19):0.10):0.15,(Oryza:0.31,Zea:0.27):0.20);"},
	},
	{
		ID:          "circos-genome",
		Name:        "染色体圈图",
		Chart:       "circos",
		Description: "5 条染色体的区间信号值。",
		Data: `chr,start,end,value
Chr1,0,5000000,2.1
Chr1,5000000,12000000,4.8
Chr1,12000000,20000000,3.4
Chr2,0,6000000,1.8
Chr2,6000000,14000000,5.2
Chr2,14000000,22000000,2.9
Chr3,0,4000000,3.9
Chr3,4000000,11000000,2.2
Chr3,11000000,19000000,4.1
Chr4,0,3000000,1.2
Chr4,3000000,9000000,3.6
Chr4,9000000,16000000,2.7
Chr5,0,7000000,4.4
Chr5,7000000,15000000,1.9
Chr5,15000000,24000000,3.1
`,
		Params: map[string]any{"chr": "chr", "start": "start", "end": "end", "value": "value", "pycircos": true},
	},
	{
		ID:          "manhattan-gwas",
		Name:        "GWAS 曼哈顿图",
		Chart:       "manhattan",
		Description: "30 个 SNP 按染色体排列。",
		Data: `chr,pos,pvalue
1,1200000,0.002
1,4500000,0.0004
1,9800000,0.08
1,15300000,0.31
2,800000,0.02
2,3400000,0.0001
2,7200000,0.15
2,12000000,0.004
3,2200000,0.6
3,5600000,0.03
3,9900000,0.0002
3,14500000,0.22
4,1500000,0.04
4,4800000,0.0007
4,8600000,0.5
4,13200000,0.009
5,700000,0.11
5,3900000,0.0003
5,8100000,0.27
5,12800000,0.016
6,2100000,0.0025
6,5900000,0.4
6,9600000,0.0006
6,14200000,0.07
7,1100000,0.19
7,4300000,0.03
7,8800000,0.0009
7,13500000,0.52
8,2500000,0.006
8,6100000,0.28
`,
		Params: map[string]any{"chr": "chr", "pos": "pos", "y": "pvalue", "p_cut": 0.001},
	},
	{
		ID:          "pca-samples",
		Name:        "样本 PCA",
		Chart:       "pca",
		Description: "12 个样本 × 6 个表达特征。",
		Data: `sample,group,G1,G2,G3,G4,G5,G6
S1,Control,2.1,1.8,3.4,5.2,2.9,4.1
S2,Control,2.4,2.0,3.1,4.9,3.2,3.8
S3,Control,1.9,2.2,3.6,5.5,2.7,4.3
S4,Control,2.2,1.7,3.3,5.0,3.0,4.0
S5,Treated,6.8,5.9,2.1,1.8,4.4,2.6
S6,Treated,7.1,6.2,1.9,1.6,4.7,2.3
S7,Treated,6.5,5.7,2.3,2.0,4.1,2.9
S8,Treated,7.3,6.0,2.0,1.7,4.5,2.5
S9,Rescue,4.2,4.0,2.8,3.4,3.6,3.3
S10,Rescue,4.5,3.8,3.0,3.1,3.9,3.0
S11,Rescue,4.0,4.3,2.6,3.6,3.4,3.5
S12,Rescue,4.3,4.1,2.9,3.3,3.7,3.2
`,
		Params: map[string]any{"group": "group"},
	},
	{
		ID:          "gsea-prerank",
		Name:        "GSEA 预排序富集",
		Chart:       "gsea",
		Description: "30 个基因的排序值 + 两个小型基因集。",
		Data: `gene,score
GENE1,3.8
GENE2,3.4
GENE3,3.1
GENE4,2.8
GENE5,2.5
GENE6,2.2
GENE7,1.9
GENE8,1.6
GENE9,1.3
GENE10,1.0
GENE11,0.7
GENE12,0.4
GENE13,0.1
GENE14,-0.2
GENE15,-0.5
GENE16,-0.8
GENE17,-1.1
GENE18,-1.4
GENE19,-1.7
GENE20,-2.0
GENE21,-2.3
GENE22,-2.6
GENE23,-2.9
GENE24,-3.2
GENE25,-3.5
GENE26,-3.8
GENE27,-4.1
GENE28,-4.4
GENE29,-4.7
GENE30,-5.0
`,
		Params: map[string]any{
			"gene": "gene", "score": "score", "permutations": 200,
			"gmt": "PHOTOSYNTHESIS\tGENE1\tGENE2\tGENE3\tGENE4\tGENE5\tGENE6\tGENE7\tGENE8\nSTRESS_RESPONSE\tGENE25\tGENE26\tGENE27\tGENE28\tGENE29\tGENE30\tGENE24\tGENE23\n",
		},
	},
}

func samples() []Sample {
	return sampleList
}
