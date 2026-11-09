"""植物 / 生物医学数据库真实 API 适配器。

每个适配器对应一个可公开访问的 HTTP 接口（端点与返回结构均已实测）。
后端统一做代理与归一化：前端只拿 `{"title","subtitle","url","source","fields"}` 结构。
没有公开 API 的库在 NO_API_NOTES 中写明具体原因，不编造数据。
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx

from .databases import PLANT_DATABASES
from .http import async_client as http_client
from .http import strip_residual_gzip

UA = "D509LabSpace/1.0 (+internal research portal)"


@dataclass(frozen=True)
class ApiSpec:
    key: str
    name: str
    kind: str  # search | lookup | submit | list
    homepage: str
    summary: str
    query_hint: str
    endpoint: str = ""
    method: str = "GET"
    results_path: str = ""
    fields: tuple[tuple[str, str], ...] = ()
    note: str = ""
    timeout: float = 12.0
    transform: str = ""

    def as_dict(self, available: bool | None = None) -> dict[str, Any]:
        return {
            "key": self.key,
            "name": self.name,
            "kind": self.kind,
            "homepage": self.homepage,
            "summary": self.summary,
            "queryHint": self.query_hint,
            "note": self.note,
            "available": available,
        }


# --------------------------------------------------------------------------
# 适配器表（端点均经 curl 实测返回 200）
# --------------------------------------------------------------------------
ADAPTERS: dict[str, ApiSpec] = {}


def _add(spec: ApiSpec) -> None:
    ADAPTERS[spec.key] = spec


_add(ApiSpec(
    key="ncbi", name="NCBI E-utilities", kind="search",
    homepage="https://www.ncbi.nlm.nih.gov/",
    summary="Entrez 基因库检索（esearch + esummary），返回 Gene ID、名称与描述。",
    query_hint="基因名、功能或物种，例如 AP1、flowering、Arabidopsis",
    endpoint="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=gene&retmode=json&retmax={limit}&term={q}",
    transform="ncbi_gene",
))
_add(ApiSpec(
    key="ncbi-sra", name="NCBI SRA (E-utilities)", kind="search",
    homepage="https://www.ncbi.nlm.nih.gov/sra",
    summary="Sequence Read Archive 测序运行检索，返回 Run accession 与实验信息。",
    query_hint="测序关键词，例如 maize RNA-seq",
    endpoint="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=sra&retmode=json&retmax={limit}&term={q}",
    transform="ncbi_sra",
))
_add(ApiSpec(
    key="ncbi-blast", name="NCBI BLAST URL API", kind="submit",
    homepage="https://blast.ncbi.nlm.nih.gov/",
    summary="提交 BLAST 比对任务，返回 RID 与结果页地址（远程排队，不等待结果）。",
    query_hint="核酸或蛋白序列，例如 AT1G01010 或一段 FASTA 序列",
    endpoint="https://blast.ncbi.nlm.nih.gov/Blast.cgi?CMD=Put&PROGRAM={program}&DATABASE={database}&QUERY={q}&FORMAT_TYPE=Text",
    transform="blast_submit",
))
_add(ApiSpec(
    key="ebi", name="EBI Search REST", kind="search",
    homepage="https://www.ebi.ac.uk/ebisearch/",
    summary="EBI 统一检索（uniprot 域），返回 UniProt 条目摘要。",
    query_hint="蛋白名称或基因，例如 kinase、AP1",
    endpoint="https://www.ebi.ac.uk/ebisearch/ws/rest/uniprot?query={q}&format=json&size={limit}",
    results_path="entries",
    fields=(("name", "条目"), ("description", "描述"), ("organism", "物种")),
))
_add(ApiSpec(
    key="ena", name="ENA Portal API", kind="search",
    homepage="https://www.ebi.ac.uk/ena/browser/home",
    summary="欧洲核苷酸档案库检索，返回 Run/Study accession 与物种。",
    query_hint="测序研究关键词，例如 maize、Arabidopsis RNA-seq",
    endpoint="https://www.ebi.ac.uk/ena/portal/api/search?result=read_run&fields=run_accession,study_accession,scientific_name,instrument_platform&format=json&limit={limit}&query={q}",
    transform="ena",
))
_add(ApiSpec(
    key="uniprotkb", name="UniProtKB REST", kind="search",
    homepage="https://www.uniprot.org/",
    summary="UniProt 蛋白质数据库全文检索，返回 accession、蛋白名与物种。",
    query_hint="蛋白名或基因名，例如 kinase、FRUITFULL",
    endpoint="https://rest.uniprot.org/uniprotkb/search?format=json&size={limit}&query={q}",
    results_path="results",
    transform="uniprot",
))
_add(ApiSpec(
    key="interpro", name="InterPro API", kind="search",
    homepage="https://www.ebi.ac.uk/interpro/",
    summary="InterPro 蛋白结构域家族检索，返回结构域名称与 InterPro 编号。",
    query_hint="结构域名称或编号，例如 kinase、Pfam",
    endpoint="https://www.ebi.ac.uk/interpro/api/entry/interpro/?page_size={limit}&search={q}",
    results_path="results",
    transform="interpro",
))
_add(ApiSpec(
    key="pfam", name="Pfam (InterPro API)", kind="search",
    homepage="https://www.ebi.ac.uk/interpro/entry/pfam/",
    summary="Pfam 蛋白家族检索，返回家族编号与描述。",
    query_hint="家族名称，例如 kinase、WRKY",
    endpoint="https://www.ebi.ac.uk/interpro/api/entry/pfam/?page_size={limit}&search={q}",
    results_path="results",
    transform="interpro",
))
_add(ApiSpec(
    key="alphafold", name="AlphaFold DB API", kind="lookup",
    homepage="https://alphafold.ebi.ac.uk/",
    summary="按 UniProt accession 查询 AlphaFold 结构预测条目。",
    query_hint="UniProt accession，例如 P00533",
    endpoint="https://alphafold.ebi.ac.uk/api/prediction/{q}",
    transform="alphafold",
))
_add(ApiSpec(
    key="kegg", name="KEGG REST", kind="search",
    homepage="https://www.genome.jp/kegg/",
    summary="KEGG 基因/通路检索，返回 KEGG 编号与描述。",
    query_hint="基因、通路或化合物，例如 ko:K01062、glycolysis",
    endpoint="https://rest.kegg.jp/find/{space}/{q}",
    transform="kegg",
))
_add(ApiSpec(
    key="expression-atlas", name="Expression Atlas (EBI)", kind="search",
    homepage="https://www.ebi.ac.uk/gxa/home",
    summary="EBI Expression Atlas 基因表达检索，返回表达实验与基因信息。",
    query_hint="基因名，例如 AT1G01010、GAPDH",
    endpoint="https://www.ebi.ac.uk/ebisearch/ws/rest/atlas-genes?query={q}&format=json&size={limit}",
    transform="atlas",
))
_add(ApiSpec(
    key="pdb", name="RCSB PDB Search API", kind="search",
    homepage="https://www.rcsb.org/",
    summary="RCSB 结构数据库全文检索，返回 PDB 条目编号。",
    query_hint="结构关键词，例如 phytochrome、photosystem",
    endpoint="https://search.rcsb.org/rcsbsearch/v2/query",
    transform="rcsb",
))
_add(ApiSpec(
    key="panther", name="PANTHER DB API", kind="lookup",
    homepage="http://www.pantherdb.org/",
    summary="PANTHER 家族分类检索，返回家族 ID 与分类名称。",
    query_hint="基因 symbol，例如 AP1",
    endpoint="https://pantherdb.org/services/oai/pantherdb/geneinfo?geneInputList={q}&organism={organism}",
    transform="panther",
))
_add(ApiSpec(
    key="plant-ontology", name="Plant Ontology (OLS4)", kind="search",
    homepage="https://plantontology.org/",
    summary="植物性状本体检索，返回 PO 术语与定义。",
    query_hint="性状术语，例如 leaf、flower、seed",
    endpoint="https://www.ebi.ac.uk/ols4/api/search?ontology=po&rows={limit}&q={q}",
    transform="ols",
))
_add(ApiSpec(
    key="rnacentral", name="RNAcentral (EBI Search)", kind="search",
    homepage="https://rnacentral.org/",
    summary="RNAcentral 核酸序列检索，返回 RNA 编号与描述。",
    query_hint="miRNA / lncRNA 名称，例如 MIR166、tRNA",
    endpoint="https://www.ebi.ac.uk/ebisearch/ws/rest/rnacentral?query={q}&format=json&size={limit}",
    results_path="entries",
    fields=(("name", "条目"), ("description", "描述"), ("rna_type", "类型")),
))

# --------------------------------------------------------------------------
# 生物医学 / 药物研发 / 组学方向的新增适配器（端点均经 curl / httpx 实测 200）
# --------------------------------------------------------------------------
_add(ApiSpec(
    key="chembl", name="ChEMBL API", kind="search",
    homepage="https://www.ebi.ac.uk/chembl/",
    summary="ChEMBL 生物活性分子检索，返回 ChEMBL ID、分子式、分子量与 ATC 分类。",
    query_hint="药物名或分子名，例如 aspirin、imatinib",
    endpoint="https://www.ebi.ac.uk/chembl/api/data/molecule/search.json?q={q}&limit={limit}",
    transform="chembl",
))
_add(ApiSpec(
    key="pubchem", name="PubChem PUG REST", kind="lookup",
    homepage="https://pubchem.ncbi.nlm.nih.gov/",
    summary="PubChem 小分子检索，返回 CID、分子式、分子量与 IUPAC 名称。",
    query_hint="化合物名称，例如 aspirin、glucose",
    endpoint="https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/{q}/property/MolecularFormula,MolecularWeight,IUPACName/JSON",
    transform="pubchem",
))
_add(ApiSpec(
    key="clinvar", name="ClinVar (E-utilities)", kind="search",
    homepage="https://www.ncbi.nlm.nih.gov/clinvar/",
    summary="ClinVar 临床变异检索，返回 VCV 编号、变异类型、致病分级与等位基因频率。",
    query_hint="基因名或疾病名，例如 BRCA1、cystic fibrosis",
    endpoint="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=clinvar&retmode=json&retmax={limit}&term={q}",
    transform="clinvar",
))
_add(ApiSpec(
    key="opentargets", name="Open Targets GraphQL", kind="search",
    homepage="https://platform.opentargets.org/",
    summary="Open Targets 统一搜索，返回药物 / 疾病 / 靶点实体及其描述。",
    query_hint="药物、疾病或靶点名称，例如 aspirin、HER2、breast cancer",
    endpoint="https://api.platform.opentargets.org/api/v4/graphql",
    method="POST",
    transform="opentargets",
))
_add(ApiSpec(
    key="string-db", name="STRING API", kind="search",
    homepage="https://string-db.org/",
    summary="STRING 蛋白质相互作用网络检索，返回成对蛋白与综合关联分数。",
    query_hint="蛋白名或基因名，例如 TP53、MDM2",
    endpoint="https://string-db.org/api/json/network?identifiers={q}&species=9606&limit={limit}&caller_identity=d509_labspace",
    transform="string",
))
_add(ApiSpec(
    key="hpa", name="Human Protein Atlas API", kind="search",
    homepage="https://www.proteinatlas.org/",
    summary="人类蛋白质图谱检索，返回基因符号、别名与 Ensembl 编号。",
    query_hint="基因符号或蛋白名，例如 TP53、EGFR",
    endpoint="https://www.proteinatlas.org/api/search_download.php?search={q}&format=json&columns=g,gs,eg",
    transform="hpa",
))
_add(ApiSpec(
    key="cellosaurus", name="Cellosaurus API", kind="search",
    homepage="https://www.cellosaurus.org/",
    summary="Cellosaurus 细胞系检索，返回 CVCL 编号、细胞系名称、类别与物种。",
    query_hint="细胞系名称，例如 A549、HeLa、MCF-7",
    endpoint="https://api.cellosaurus.org/search/cell-line?q={q}&format=json&rows={limit}",
    transform="cellosaurus",
))
_add(ApiSpec(
    key="encode", name="ENCODE Portal", kind="search",
    homepage="https://www.encodeproject.org/",
    summary="ENCODE 功能基因组学实验检索，返回实验编号、实验类型、靶点与生物样本。",
    query_hint="靶点或实验关键词，例如 CTCF、H3K27ac",
    endpoint="https://www.encodeproject.org/search/?type=Experiment&searchTerm={q}&format=json&limit={limit}",
    transform="encode",
))
_add(ApiSpec(
    key="cbioportal", name="cBioPortal API", kind="search",
    homepage="https://www.cbioportal.org/",
    summary="cBioPortal 癌症研究检索，返回研究编号、名称、癌症类型与样本数。",
    query_hint="癌症类型或研究关键词，例如 breast、lung",
    endpoint="https://www.cbioportal.org/api/studies?keyword={q}&pageSize={limit}&projection=SUMMARY",
    transform="cbioportal",
))
_add(ApiSpec(
    key="openfda", name="openFDA API", kind="search",
    homepage="https://open.fda.gov/",
    summary="openFDA 药品标签检索，返回通用名、品牌名、给药途径与适应症。",
    query_hint="药品通用名或成分，例如 aspirin、ibuprofen",
    endpoint="https://api.fda.gov/drug/label.json?search=openfda.generic_name:%22{q}%22&limit={limit}",
    transform="openfda",
))
_add(ApiSpec(
    key="europepmc", name="Europe PMC REST", kind="search",
    homepage="https://europepmc.org/",
    summary="Europe PMC 文献检索，返回标题、作者、期刊、年份与 PMID。",
    query_hint="主题词或基因名，例如 CRISPR、aspirin、BRCA1",
    endpoint="https://www.ebi.ac.uk/europepmc/webservices/rest/search?query={q}&format=json&pageSize={limit}&resultType=core",
    transform="europepmc",
))
_add(ApiSpec(
    key="chebi", name="ChEBI (OLS4)", kind="search",
    homepage="https://www.ebi.ac.uk/chebi/",
    summary="ChEBI 化学实体检索，返回术语名称、本体编号与定义。",
    query_hint="化学物名称，例如 glucose、ATP",
    endpoint="https://www.ebi.ac.uk/ols4/api/search?ontology=chebi&rows={limit}&q={q}",
    transform="ols_chebi",
))
_add(ApiSpec(
    key="taxonomy", name="NCBI Taxonomy (E-utilities)", kind="search",
    homepage="https://www.ncbi.nlm.nih.gov/taxonomy",
    summary="NCBI 分类学检索，返回学名、俗名、分类等级与 TaxID。",
    query_hint="物种名，例如 Homo sapiens、Arabidopsis thaliana",
    endpoint="https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=taxonomy&retmode=json&retmax={limit}&term={q}",
    transform="taxonomy",
))
_add(ApiSpec(
    key="hgnc", name="HGNC REST", kind="lookup",
    homepage="https://www.genenames.org/",
    summary="HGNC 基因符号检索，返回标准名称、别名、染色体位置与 Entrez ID。",
    query_hint="基因符号，例如 BRCA1、TP53",
    endpoint="https://rest.genenames.org/fetch/symbol/{q}",
    transform="hgnc",
))
_add(ApiSpec(
    key="pride", name="PRIDE Archive API", kind="search",
    homepage="https://www.ebi.ac.uk/pride/",
    summary="PRIDE 蛋白质组数据集检索，返回项目编号、标题与提交日期。",
    query_hint="数据集关键词，例如 proteome、serum",
    endpoint="https://www.ebi.ac.uk/pride/ws/archive/v2/search/projects?keyword={q}&pageSize={limit}",
    transform="pride",
))
_add(ApiSpec(
    key="enrichr", name="Enrichr 基因集库", kind="list",
    homepage="https://maayanlab.cloud/Enrichr/",
    summary="Enrichr 基因集库列表，返回库名、术语数、每术语基因数与基因覆盖率。",
    query_hint="基因集库关键词，例如 GO、KEGG、Transcription",
    endpoint="https://maayanlab.cloud/Enrichr/datasetStatistics?mode=text&json=true",
    transform="enrichr",
))
_add(ApiSpec(
    key="brain-atlas", name="Allen Brain Atlas API", kind="search",
    homepage="https://brain-map.org/",
    summary="Allen Brain Atlas 图谱检索，返回图谱名称、描述与图像类型。",
    query_hint="脑区或图谱关键词，例如 cortical、mouse",
    endpoint="https://api.brain-map.org/api/v2/data/query.json?criteria=model::Atlas",
    transform="brain_atlas",
))

# 没有公开 API 的库：写明具体原因（不编造）
NO_API_NOTES: dict[str, str] = {
    "tair": "TAIR 未开放公开 REST API，仅提供网页检索与订阅式下载（TAIR10/Subscription）。",
    "gramene": "Gramene 站点当前对本机网络不可达，且未提供稳定的公开查询 API。",
    "plantreactome": "Reactome ContentService 仅支持标识符/物种级查询，站内全文检索接口返回 404，未找到可用公开搜索 API。",
    "metacyc": "MetaCyc 的 BioCyc 网页服务需注册并申请 API key（web services 订阅制）。",
    "brenda": "BRENDA 未提供匿名公开 REST API，数据需注册后下载或使用 SOAP 接口（需凭据）。",
    "tropicos": "Tropicos 官方 API 需申请 apikey，且 services.tropicos.org 对本机网络不可达。",
    "planttfdb": "PlantTFDB 未提供公开 REST API，查询依赖站内表单提交。",
    "phytopath": "PhytoPath/其它专题库未开放公开 API。",
    "itak": "iTAK 仅提供网页 CGI 接口，无稳定 JSON API。",
    "grin": "GRIN 站点检索为表单式，无公开 API。",
    "plantcyc": "Plant Metabolic Network/PlantCyc 属订阅制访问，无公开 API。",
    "phytozome": "Phytozome 数据需注册下载，无公开查询 API。",
    "plaza": "PLAZA 站点检索为网页表单，未提供公开 API。",
    "prgdb": "PRGdb 仅提供网页检索与批量下载。",
    "prgdb4": "PRGdb 4.0 仅提供网页检索与批量下载。",
    "plantsrnas": "PlantSRNs 检索依赖网页表单，未提供公开 API。",
    "plant-imputedb": "PlantImputeDB 仅提供网页检索与文件下载。",
    "cvalues": "CValues 数据以网页表格与下载文件形式提供。",
    "plantgdb": "PlantGDB 检索依赖网页表单，未提供公开 API。",
    "plant-rna-seq": "该资源为专题数据集集合，无统一公开 API。",
    "treegenes": "TreeGenes 提供网页检索与命令行工具，无公开 API。",
    "chromstates": "ChromStates 提供网页浏览与下载，未开放查询 API。",
    "plantgsea": "PlantGSEA 需登录后使用分析模块，接口未公开。",
    "pnrd": "PNRD 仅提供网页浏览与下载。",
    "plantexp": "PlantExpression Atlas 提供网页检索，未开放 API。",
    "gdr": "GDR 需注册后检索，接口未公开。",
    "cottongen": "CottonGen 提供网页检索与下载工具，无公开 API。",
    "plant-mlst": "Plant-MLST 提供网页与本地工具链，无公开 API。",
    "soysnp": "SoySNP 数据以文件下载为主，未开放查询 API。",
    "plantcircbase": "PlantCircBase 提供网页检索与下载。",
    "urgi": "URGI 浏览器为网页式，未提供公开 API。",
    "oryzasnp": "OryzaSNP 数据以下载为主，无公开查询 API。",
    "chromloops": "ChromLoops 提供网页浏览与下载。",
    "plant-metabolic-network": "PMN 数据以下载与网页浏览提供。",
    "plantdeepsea": "PlantDeepSEA 提供网页检索，无公开 API。",
    "pmiren": "PmiREN 提供网页检索与下载。",
    "pscth": "PScTH 提供网页检索与下载。",
    "pcmdb": "PCMDB 提供网页浏览与下载。",
    "cellblast": "Cell BLAST 提供网页与命令行工具，无公开 API。",
    "signalp": "SignalP 需本地运行或 DeepSubmit 提交，无公开检索 API。",
    "eggnog": "eggNOG-mapper 为本地命令行工具，无公开 API。",
    "kaas": "KAAS 为本地命令行工具（服务器版），无公开 API。",
    "pasa": "PASA 为本地比对流程工具，无公开 API。",
    "mirbase": "miRBase 检索依赖网页表单与批量下载。",
    "pmrd": "PMRD 数据以网页与下载方式提供。",
    "genesys": "Genesys 检索依赖网页表单，检索 API 未公开。",
    "coge": "CoGe 提供网页浏览与批量下载，无公开检索 API。",
    "plant-cell-atlas": "Plant Cell Atlas 数据以下载形式发布。",
    "busco": "BUSCO 为本地命令行工具，无公开 API。",
    "genemania": "GeneMANIA 提供网页检索与 API 封装，但官方 API 需申请 key；此处不调用未授权接口。",
    "plantregmap": "PlantRegMap 提供网页检索与下载。",
    "msu-rice": "MSU Rice DB 提供网页检索与下载。",
    "solgenomics": "SGN 提供网页检索与下载。",
    "soybase": "SoyBase 提供网页检索与下载。",
    "tomato-gp": "番茄基因组资源以网页与下载方式提供。",
    "gene": "基因数据库条目以网页浏览与下载为主。",
    "ensemblplants": "Ensembl Plants 依赖 rest.ensembl.org，本机实测间歇超时，未纳入在线查询。",
    "seqin": "序列检索依赖网页表单。",
    # ---- 生物医学 / 药物研发 / 组学方向（2026-11 扩充）----
    "gnomad": "gnomAD 提供 GraphQL API，但本机实测返回 HTTP 429（请求被限流），暂以网页链接方式访问。",
    "gtex": "GTEx 官方 REST API 存在，但本机实测 TLS 握手超时（网络不可达），暂以网页链接方式访问。",
    "depmap": "DepMap 门户 API 对本机返回 Cloudflare 人机验证页面（HTTP 200 非 JSON），数据需在网页端申请下载。",
    "malacards": "MalaCards 对本机网络返回 HTTP 403（Cloudflare 拦截），仅支持浏览器访问。",
    "omim": "OMIM 下载与 API 均需订阅账号，本机网络返回 HTTP 403。",
    "orphanet": "Orphanet 开放下载需提交用途说明申请，站内未提供匿名检索 API。",
    "disgenet": "DisGeNET API 需注册获取访问密钥，当前未持有凭据。",
    "genecards": "GeneCards 对本机网络返回 HTTP 403（需登录或订阅），无匿名查询 API。",
    "drugbank": "DrugBank API 与下载均需订阅账号，本机网络返回 HTTP 403。",
    "proteomedb": "ProteomeDB 站点当前网络不可达（连接超时），未找到可用的公开查询接口。",
    "card": "CARD 检索为网页表单提交，官方 API 需申请许可，未提供匿名接口。",
    "vfdb": "VFDB 数据以网页检索与批量下载方式提供，无公开 JSON API。",
    "microbedb": "MicrobeDB 站点当前网络不可达（连接超时），未找到稳定公开查询 API。",
    "virome": "Virome 站点当前网络不可达（连接超时），仅提供网页检索。",
    "ivisp": "IVISP 站点当前网络不可达（连接超时），仅提供网页序列检索。",
    "roadmap": "Roadmap Epigenomics 以数据文件发布为主（egg2 下载区），未提供条目级检索 API。",
    "gwas": "GWAS Catalog 旧版 REST 接口已下线（返回 404），现以网页检索与文件下载方式提供。",
    "galaxy": "Galaxy 实例提供网页工作流环境与工具 API，但无跨实例统一的公开内容检索 API。",
}


# --------------------------------------------------------------------------
# 出站目标白名单
# --------------------------------------------------------------------------
# 适配器只能访问下列主机上的 https 地址。上游返回的跳转链、以及请求体里
# 透传的参数都不再能改变最终访问目标（防 SSRF 与 open-redirect 式外联）。

# 精确主机白名单（适配器 endpoint 与条目页域名）
ALLOWED_HOSTS: frozenset[str] = frozenset(
    {
        "eutils.ncbi.nlm.nih.gov",
        "blast.ncbi.nlm.nih.gov",
        "www.ncbi.nlm.nih.gov",
        "www.ebi.ac.uk",
        "rest.uniprot.org",
        "www.uniprot.org",
        "alphafold.ebi.ac.uk",
        "rest.kegg.jp",
        "www.genome.jp",
        "search.rcsb.org",
        "www.rcsb.org",
        "pantherdb.org",
        "www.genenames.org",
        "rest.genenames.org",
        "pubchem.ncbi.nlm.nih.gov",
        "maayanlab.cloud",
        "api.brain-map.org",
        "api.cellosaurus.org",
        "api.fda.gov",
        "api.platform.opentargets.org",
        "platform.opentargets.org",
        "string-db.org",
        "rnacentral.org",
        "plantontology.org",
        "europepmc.org",
        "www.cbioportal.org",
    }
)

# 适配器还会访问的家族域（条目页/子域较多，按后缀放行）
_ALLOWED_HOST_SUFFIXES: tuple[str, ...] = (
    ".ncbi.nlm.nih.gov",
    ".ebi.ac.uk",
    ".uniprot.org",
    ".rcsb.org",
    ".proteinatlas.org",
    ".encodeproject.org",
    ".genenames.org",
    ".cellosaurus.org",
    ".brain-map.org",
)


# BLAST 的 program / database 由请求体透传，必须收敛成固定集合，
# 否则用户可以把它拼进上游 query string。
BLAST_PROGRAMS: frozenset[str] = frozenset({"blastn", "blastp", "blastx", "tblastn", "tblastx"})
BLAST_DATABASES: frozenset[str] = frozenset(
    {"refseq_plant", "nr", "nt", "refseq_rna", "refseq_protein", "swissprot", "pdb", "est", "gss"}
)


def _host_allowed(host: str) -> bool:
    h = (host or "").lower().strip(".")
    if not h:
        return False
    if h in ALLOWED_HOSTS:
        return True
    return any(h.endswith(sfx) for sfx in _ALLOWED_HOST_SUFFIXES)


def _assert_allowed_url(url: str) -> None:
    """校验出站 URL：必须 https + 主机命中白名单。"""
    from urllib.parse import urlsplit

    parts = urlsplit(url)
    if parts.scheme != "https":
        raise RuntimeError("上游地址必须使用 https")
    if not _host_allowed(parts.hostname or ""):
        raise RuntimeError(f"上游主机不在白名单内：{parts.hostname}")


# --------------------------------------------------------------------------
# 工具函数
# --------------------------------------------------------------------------
def _dig(payload: Any, path: str) -> Any:
    """按 "a.b.0.c" 逐层取值。"""
    cur = payload
    if not path:
        return cur
    for part in path.split("."):
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        elif isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
    return cur


def _as_list(value: Any) -> list:
    """把 dict / None 统一成列表，避免上游单条结构与列表结构混用。"""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def _flatten_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return "；".join(_flatten_text(v) for v in value[:4] if v)
    if isinstance(value, dict):
        for key in ("value", "name", "title", "description"):
            if key in value:
                return _flatten_text(value[key])
    return ""


def _row(title: str, subtitle: str, url: str, source: str, fields: list[tuple[str, str]]) -> dict[str, Any]:
    return {
        "title": title or "（无标题）",
        "subtitle": subtitle or "",
        "url": url or "",
        "source": source,
        "fields": [{"label": k, "value": v} for k, v in fields if v not in (None, "")],
    }


# 部分上游站点（尤其 EBI 系）在本机房链路偏慢，响应时间波动大：
# 统一放宽超时并允许重试一次，避免偶发超时被当成「接口不可用」。
_SLOW_HOSTS = ("ebi.ac.uk", "ncbi.nlm.nih.gov", "ebi.ac.uk", "rest.uniprot.org", "pantherdb.org")


def _timeout_for(url: str, base: float = 20.0) -> float:
    return 35.0 if any(h in url for h in _SLOW_HOSTS) else base


async def _get_json(url: str, timeout: float = 12.0, retries: int = 0) -> Any:
    """GET 并解析 JSON；上游返回 HTML 错误页时给出可读的中文原因，而不是 JSONDecodeError。"""
    resp = await _get(url, timeout=timeout, retries=retries)
    if resp.status_code >= 400:
        raise RuntimeError(f"上游返回 HTTP {resp.status_code}")
    ctype = (resp.headers.get("content-type") or "").lower()
    body = resp.text or ""
    if "json" not in ctype and not body.lstrip()[:1] in ("{", "["):
        raise RuntimeError(
            "上游返回了非 JSON 内容（常见于服务维护、限流或被网关拦截），"
            f"HTTP {resp.status_code}，响应前 80 字符：{body.strip()[:80]}"
        )
    try:
        return resp.json()
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"解析上游 JSON 失败：{type(exc).__name__}") from exc


#: 共享出站客户端。原先每次请求都新建 AsyncClient（新建连接池 + 重新 TLS 握手），
#: 一次 /api/databases/apis 会并发探活 30+ 个上游，等于凭空多出 30 个连接池。
#: 这里复用一个长生命周期客户端，连接与 TLS 会话可复用，DNS 结果也能命中缓存。
_client: httpx.AsyncClient | None = None
_client_lock = asyncio.Lock()

_DEFAULT_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    # 由 httpx 负责解压；不再依赖上游是否强制 gzip
    "Accept-Encoding": "gzip, deflate",
}


async def shared_client() -> httpx.AsyncClient:
    """返回进程级共享的 IPv4 出站客户端（线程/协程安全）。"""
    global _client
    if _client is None or _client.is_closed:
        async with _client_lock:
            if _client is None or _client.is_closed:
                _client = http_client(
                    timeout=httpx.Timeout(35.0, connect=10.0),
                    follow_redirects=True,
                    limits=httpx.Limits(max_connections=40, max_keepalive_connections=20, keepalive_expiry=30.0),
                    headers=_DEFAULT_HEADERS,
                )
    return _client


async def close_client() -> None:
    """应用关闭时释放连接池。"""
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


async def _request(method: str, url: str, timeout: float, retries: int, payload: dict | None = None) -> httpx.Response:
    _assert_allowed_url(url)
    client = await shared_client()
    last_exc: Exception | None = None
    for attempt in range(retries + 1):
        try:
            resp = await client.request(method, url, timeout=timeout, json=payload)
            return strip_residual_gzip(resp)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            last_exc = exc
            if attempt >= retries:
                raise
            await asyncio.sleep(1.5)
    raise RuntimeError(f"{method} 请求失败：{url}") from last_exc


async def _get(url: str, timeout: float = 12.0, retries: int = 0) -> httpx.Response:
    """GET 请求；retries>0 时对超时/网络抖动做有限重试（部分站点响应极慢）。"""
    return await _request("GET", url, timeout, retries)


async def _post(url: str, payload: dict | None = None, timeout: float = 12.0) -> httpx.Response:
    return await _request("POST", url, timeout, 0, payload)


# --------------------------------------------------------------------------
# 具体转换器
# --------------------------------------------------------------------------
async def _t_ncbi_gene(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    ids = _dig((await _get(spec.endpoint.format(q=_quote(query), limit=limit))).json(), "esearchresult.idlist") or []
    if not ids:
        return []
    summary = (await _get(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=gene&retmode=json&id="
        + ",".join(ids[:limit])
    )).json()
    result = _dig(summary, "result") or {}
    rows = []
    for gid in ids[:limit]:
        item = result.get(gid) or {}
        name = item.get("name") or gid
        desc = _flatten_text(item.get("description"))
        rows.append(_row(
            f"{name}（{gid}）", desc,
            f"https://www.ncbi.nlm.nih.gov/gene/{gid}",
            "NCBI Gene",
            [("物种", _flatten_text((item.get("organism") or {}).get("scientificname"))),
             ("定位", item.get("maplocation") or ""),
             ("基因类型", item.get("genetype") or "")],
        ))
    return rows


async def _t_ncbi_sra(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    data = (await _get(spec.endpoint.format(q=_quote(query), limit=limit))).json()
    ids = _dig(data, "esearchresult.idlist") or []
    if not ids:
        return []
    summary = (await _get(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=sra&retmode=json&id=" + ",".join(ids[:limit])
    )).json()
    result = _dig(summary, "result") or {}
    rows = []
    for rid in ids[:limit]:
        item = result.get(rid) or {}
        acc = item.get("accession") or rid
        rows.append(_row(
            acc, _flatten_text(item.get("title")),
            f"https://www.ncbi.nlm.nih.gov/sra/{acc}",
            "NCBI SRA",
            [("物种", item.get("taxon") or ""), ("平台", item.get("platform") or "")],
        ))
    return rows


async def _t_blast_submit(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    program = str(params.get("program") or "blastn").lower()
    if program not in BLAST_PROGRAMS:
        program = "blastn"
    database = str(params.get("database") or "refseq_plant").lower()
    if database not in BLAST_DATABASES:
        database = "refseq_plant"
    url = spec.endpoint.format(q=_quote(query), program=program, database=database)
    text = (await _get(url, timeout=20.0)).text
    m = re.search(r"RID\s*=\s*\"?([A-Za-z0-9_]+)", text)
    if not m:
        return [_row("任务已提交", "BLAST 返回内容未包含 RID，请稍后重试", "https://blast.ncbi.nlm.nih.gov/", "NCBI BLAST", [])]
    rid = m.group(1)
    return [_row(
        f"BLAST 任务 RID {rid}",
        f"程序 {program}，数据库 {database}；远程排队约需数十秒",
        f"https://blast.ncbi.nlm.nih.gov/Blast.cgi?CMD=Get&RID={rid}&FORMAT_TYPE=Text",
        "NCBI BLAST",
        [("RID", rid), ("程序", program), ("数据库", database)],
    )]


async def _t_ena(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    # ENA portal API 需要字段语法：纯关键词自动转成 study_title="*关键词*"
    qexpr = query if "=" in query else f'study_title="*{query}*"'
    data = (await _get(spec.endpoint.format(q=_quote(qexpr), limit=limit))).json()
    rows = []
    for item in (data if isinstance(data, list) else []):
        rows.append(_row(
            item.get("run_accession") or item.get("study_accession") or "—",
            item.get("study_title") or item.get("scientific_name") or "",
            f"https://www.ebi.ac.uk/ena/browser/view/{item.get('run_accession', '')}",
            "ENA",
            [("研究编号", item.get("study_accession") or ""),
             ("物种", item.get("scientific_name") or ""),
             ("平台", item.get("instrument_platform") or "")],
        ))
    return rows


async def _t_uniprot(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    data = (await _get(spec.endpoint.format(q=_quote(query), limit=limit))).json()
    rows = []
    for item in _dig(data, "results") or []:
        acc = item.get("primaryAccession") or ""
        genes = item.get("genes") or []
        gene = genes[0].get("geneName", {}).get("value", "") if genes else ""
        rows.append(_row(
            f"{gene or acc}（{acc}）",
            _flatten_text((item.get("proteinDescription") or {}).get("recommendedName")),
            f"https://www.uniprot.org/uniprotkb/{acc}/entry",
            "UniProtKB",
            [("物种", (item.get("organism") or {}).get("scientificName", "")),
             ("长度", item.get("sequence", {}).get("length", "")),
             ("基因", gene)],
        ))
    return rows


async def _t_interpro(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    data = (await _get(spec.endpoint.format(q=_quote(query), limit=limit))).json()
    rows = []
    for item in _dig(data, "results") or []:
        meta = item.get("metadata") or {}
        acc = meta.get("accession") or ""
        rows.append(_row(
            f"{meta.get('name') or acc}（{acc}）",
            _flatten_text(meta.get("description")),
            f"https://www.ebi.ac.uk/interpro/entry/{acc}/",
            "InterPro",
            [("类型", meta.get("type") or ""), ("成员库", ", ".join((meta.get("member_databases") or {}).keys()))],
        ))
    return rows


async def _t_alphafold(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    data = (await _get(spec.endpoint.format(q=_quote(query.strip().upper())))).json()
    items = data if isinstance(data, list) else [data]
    rows = []
    for item in items[:limit]:
        acc = item.get("uniprotAccession") or ""
        rows.append(_row(
            f"{item.get('modelEntityId') or acc}",
            _flatten_text(item.get("cifUrl") or item.get("paeDocUrl")),
            f"https://alphafold.ebi.ac.uk/entry/{acc}",
            "AlphaFold DB",
            [("UniProt", acc),
             ("版本", item.get("modelCreatedDate") or ""),
             ("工具", item.get("toolUsed") or "")],
        ))
    return rows


# KEGG REST 的可用检索空间是固定集合；用户传入的 space 必须落在白名单内，
# 否则会被拼进 URL 模板造成路径/查询串注入。
KEGG_SPACES = {
    "genes", "organism", "pathway", "brite", "module", "class", "ec", "ko",
    "genome", "dgnum", "ncbi-organism", "uniprot", "kegg", "rclass", "rname",
    "pname", "pid", "role", "kegg-brite",
}


async def _t_kegg(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    space = str(params.get("space") or "genes").strip().lower()
    if space not in KEGG_SPACES:
        space = "genes"
    text = (await _get(spec.endpoint.format(space=space, q=_quote(query)))).text
    rows = []
    for line in text.splitlines()[:limit]:
        if not line.strip():
            continue
        parts = line.split("\t")
        ident = parts[0]
        desc = parts[1] if len(parts) > 1 else ""
        url = f"https://www.genome.jp/entry/{ident}" if ident.startswith(("ko", "k", "ec", "map", "rn")) else "https://www.genome.jp/kegg/"
        rows.append(_row(ident, desc, url, "KEGG", [("编号", ident)]))
    return rows


async def _t_atlas(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    data = (await _get(spec.endpoint.format(q=_quote(query), limit=limit))).json()
    entries = _dig(data, "entries") or []
    rows = []
    for item in entries:
        fields = item.get("fields") or {}
        gene = ""
        for f in fields.values():
            if isinstance(f, dict) and f.get("name") == "Gene" and f.get("value"):
                gene = f["value"]
                break
        rows.append(_row(
            gene or item.get("id") or "—",
            _flatten_text(fields.get("Description")),
            f"https://www.ebi.ac.uk/gxa/genes/{gene}" if gene else "https://www.ebi.ac.uk/gxa/home",
            "Expression Atlas",
            [("物种", _flatten_text(fields.get("Species"))), ("实验", item.get("id") or "")],
        ))
    return rows


async def _t_rcsb(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    payload = {
        "query": {"type": "terminal", "service": "full_text", "parameters": {"value": query}},
        "return_type": "entry",
        "request_options": {"paginate": {"start": 0, "rows": limit}},
    }
    import json as _json
    url = "https://search.rcsb.org/rcsbsearch/v2/query?json=" + _quote(_json.dumps(payload, separators=(",", ":")))
    data = (await _get(url, timeout=15.0)).json()
    rows = []
    for item in (data.get("result_set") or [])[:limit]:
        acc = item.get("identifier") or ""
        rows.append(_row(acc, "RCSB 结构数据库条目", f"https://www.rcsb.org/structure/{acc}", "RCSB PDB", [("编号", acc)]))
    return rows


async def _t_panther(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    organism = str(params.get("organism") or "3702")
    if not organism.isdigit():
        organism = "3702"
    data = (await _get(spec.endpoint.format(q=_quote(query), organism=organism), timeout=20.0)).json()
    genes = _dig(data, "search.mapped_genes.gene") or []
    if isinstance(genes, dict):
        if "gene_list" in genes:
            genes = genes["gene_list"]
        elif "family_id" in genes:
            genes = [genes]
        else:
            genes = list(genes.values())
    rows = []
    for gene in genes[:limit]:
        family = gene.get("family_id") or ""
        subfamily = gene.get("sf_id") or ""
        names: list[str] = []
        for entry in _as_list(_dig(gene, "annotation_type_list.annotation_data_type")):
            if not isinstance(entry, dict):
                continue
            for anno in _as_list(_dig(entry, "annotation_list.annotation")):
                if isinstance(anno, dict) and anno.get("name"):
                    names.append(anno["name"])
        rows.append(_row(
            subfamily or family or "—",
            "；".join(names[:3]),
            f"http://www.pantherdb.org/panther/family.do?clsAccession={family}",
            "PANTHER",
            [("家族", family), ("亚家族", subfamily), ("物种编号", organism)],
        ))
    return rows


async def _t_ols(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    data = (await _get(spec.endpoint.format(q=_quote(query), limit=limit))).json()
    rows = []
    for doc in _dig(data, "response.docs") or []:
        label = doc.get("label") or doc.get("short_form") or ""
        rows.append(_row(
            f"{label}（{doc.get('short_form', '')}）",
            _flatten_text(doc.get("description")),
            doc.get("iri") or "https://plantontology.org/",
            "Plant Ontology",
            [("本体", doc.get("ontology_name") or "")],
        ))
    return rows


async def _t_chembl(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    # ChEMBL 的 EBI 接口在本机房实测需 25~30 秒，默认 12 秒超时必然失败
    try:
        data = await _get_json(spec.endpoint.format(q=_quote(query), limit=limit), timeout=70.0, retries=1)
    except (RuntimeError, httpx.HTTPError) as exc:
        # ChEMBL 官方 API 偶发整体维护（返回 HTML 500 页）→ 退到 EBI 检索的 chembl 域
        return await _t_chembl_via_ebisearch(query, limit, str(exc))
    rows = []
    for item in _dig(data, "molecules") or []:
        chembl_id = item.get("molecule_chembl_id") or ""
        props = item.get("molecule_properties") or {}
        atc = item.get("atc_classifications") or []
        atc_text = "、".join(a if isinstance(a, str) else str(a.get("code", "")) for a in atc[:3])
        rows.append(_row(
            item.get("pref_name") or chembl_id,
            f"ChEMBL {chembl_id}",
            f"https://www.ebi.ac.uk/chembl/explore/compound/{chembl_id}",
            "ChEMBL",
            [("化学式", props.get("full_molformula") or ""),
             ("分子量", props.get("full_mwt") or ""),
             ("分子类型", item.get("molecule_type") or ""),
             ("ATC 分类", atc_text),
             ("最高临床阶段", item.get("max_phase") or ""),
             ("首次批准", item.get("first_approval") or "")],
        ))
    return rows


async def _t_chembl_via_ebisearch(query: str, limit: int, reason: str) -> list[dict]:
    """ChEMBL 主接口不可用时的回退：EBI Search 的 chembl 域。"""
    url = (
        "https://www.ebi.ac.uk/ebisearch/ws/rest/chembl"
        f"?query={_quote(query)}&format=json&size={max(1, min(limit, 10))}&fields=description,id"
    )
    data = await _get_json(url, timeout=20.0, retries=1)
    rows = []
    for item in (data.get("entries") or [])[:limit]:
        cid = item.get("id") or ""
        descs = (item.get("fields") or {}).get("description") or []
        desc = descs[0] if descs and isinstance(descs[0], str) else ""
        rows.append(_row(
            f"ChEMBL {cid}" if cid else (desc[:60] or "ChEMBL 化合物"),
            cid,
            f"https://www.ebi.ac.uk/chembl/explore/compound/{cid}",
            "ChEMBL（经 EBI 检索回退）",
            [("化合物编号", cid), ("说明", desc[:160]), ("回退原因", reason[:80])],
        ))
    return rows


async def _t_pubchem(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    resp = await _get(spec.endpoint.format(q=_quote(query)))
    if resp.status_code >= 400:
        raise RuntimeError(f"PubChem 未找到该化合物（HTTP {resp.status_code}）")
    data = resp.json()
    props = _dig(data, "PropertyTable.Properties") or []
    rows = []
    for item in props[:limit]:
        cid = item.get("CID") or ""
        rows.append(_row(
            f"CID {cid}",
            item.get("IUPACName") or "",
            f"https://pubchem.ncbi.nlm.nih.gov/compound/{cid}",
            "PubChem",
            [("化学式", item.get("MolecularFormula") or ""),
             ("分子量", item.get("MolecularWeight") or ""),
             ("IUPAC 名称", item.get("IUPACName") or "")],
        ))
    return rows


async def _t_clinvar(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    ids = _dig((await _get(spec.endpoint.format(q=_quote(query), limit=limit))).json(), "esearchresult.idlist") or []
    if not ids:
        return []
    summary = (await _get(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=clinvar&retmode=json&id="
        + ",".join(ids[:limit])
    )).json()
    result = _dig(summary, "result") or {}
    rows = []
    for vid in ids[:limit]:
        item = result.get(vid) or {}
        acc = item.get("accession") or ""
        vsets = item.get("variation_set") or []
        vname = "；".join(v.get("variation_name", "") for v in vsets[:2] if v.get("variation_name"))
        germline = _dig(item, "germline_classification.description") or ""
        freq = ""
        for aset in item.get("allele_freq_set") or []:
            if aset.get("value"):
                freq = str(aset["value"])
                break
        sub = item.get("supporting_submissions") or {}
        scv = sub.get("scv") if isinstance(sub, dict) else None
        rows.append(_row(
            acc or str(vid),
            item.get("title") or "",
            f"https://www.ncbi.nlm.nih.gov/clinvar/variation/{acc}/" if acc else "https://www.ncbi.nlm.nih.gov/clinvar/",
            "ClinVar",
            [("变异类型", item.get("obj_type") or ""),
             ("变异名称", vname),
             ("遗传病分类", germline),
             ("等位基因频率", freq),
             ("提交编号", "、".join(scv[:3]) if isinstance(scv, list) else "")],
        ))
    return rows


async def _t_opentargets(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    body = {
        "query": (
            "query Search($q: String!, $size: Int!) {"
            " search(queryString: $q, page: {index: 0, size: $size}) {"
            "  hits { id name entity description } } }"
        ),
        "variables": {"q": query, "size": limit},
    }
    data = (await _post(spec.endpoint, body, timeout=20.0)).json()
    rows = []
    for hit in _dig(data, "data.search.hits") or []:
        entity = hit.get("entity") or ""
        rows.append(_row(
            hit.get("name") or hit.get("id") or "",
            hit.get("description") or "",
            f"https://platform.opentargets.org/{entity}/{hit.get('id', '')}",
            "Open Targets",
            [("实体类型", entity), ("实体 ID", hit.get("id") or "")],
        ))
    return rows


async def _t_string(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    species = str(params.get("species") or "9606")
    if not species.isdigit():
        species = "9606"
    url = spec.endpoint.format(q=_quote(query), limit=limit).replace("species=9606", f"species={species}")
    data = (await _get(url, timeout=20.0)).json()
    rows = []
    for item in (data if isinstance(data, list) else [])[:limit]:
        a = item.get("preferredName_A") or ""
        b = item.get("preferredName_B") or ""
        rows.append(_row(
            f"{a} — {b}",
            f"综合关联分数 {item.get('score', '')}",
            f"https://string-db.org/cgi/network?identifiers={a}%0d{b}",
            "STRING",
            [("蛋白 A", a), ("蛋白 B", b),
             ("STRING ID", item.get("stringId_A") or ""),
             ("物种编号", item.get("ncbiTaxonId") or "")],
        ))
    return rows


async def _t_hpa(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    resp = await _get(spec.endpoint.format(q=_quote(query)), timeout=20.0)
    try:
        # 共享客户端声明了 Accept-Encoding，httpx 负责解压；这里只做兜底解码
        data = resp.json()
    except (ValueError, UnicodeDecodeError) as exc:
        raise RuntimeError(f"Human Protein Atlas 返回内容无法解析：{exc}") from exc
    items = data if isinstance(data, list) else [data]
    rows = []
    for item in items[:limit]:
        gene = item.get("Gene") or ""
        syn = item.get("Gene synonym") or []
        if isinstance(syn, str):
            syn = [syn]
        ens = item.get("Ensembl") or ""
        rows.append(_row(
            gene or "—",
            "、".join(syn[:3]),
            f"https://www.proteinatlas.org/{ens}" if ens else "https://www.proteinatlas.org/",
            "Human Protein Atlas",
            [("基因", gene), ("别名", "、".join(syn[:5])), ("Ensembl", ens)],
        ))
    return rows


async def _t_cellosaurus(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    data = (await _get(spec.endpoint.format(q=_quote(query), limit=limit), timeout=20.0)).json()
    items = _dig(data, "Cellosaurus.cell-line-list") or []
    rows = []
    for item in items[:limit]:
        accs = [a.get("value") for a in item.get("accession-list") or [] if a.get("value")]
        acc = accs[0] if accs else ""
        names = [n.get("value") for n in item.get("name-list") or [] if n.get("value")]
        species = [s.get("value") for s in item.get("species-list") or [] if s.get("value")]
        rows.append(_row(
            names[0] if names else (acc or "—"),
            f"Cellosaurus {acc}",
            f"https://www.cellosaurus.org/{acc}" if acc else "https://www.cellosaurus.org/",
            "Cellosaurus",
            [("细胞系编号", acc), ("细胞系类别", item.get("category") or ""),
             ("物种", species[0] if species else ""),
             ("别称", "、".join(names[1:4]))],
        ))
    return rows


async def _t_encode(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    # ENCODE 门户从本机房访问极不稳定（www.encodeproject.org 连接超时），这里缩短超时并只做一次重试
    try:
        data = (await _get(spec.endpoint.format(q=_quote(query), limit=limit), timeout=15.0, retries=1)).json()
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        raise RuntimeError(f"ENCODE 门户当前不可达（{type(exc).__name__}），请稍后重试或改用网页访问") from exc
    rows = []
    for item in _dig(data, "@graph") or []:
        acc = item.get("accession") or ""
        target = _dig(item, "target.label") or ""
        rows.append(_row(
            item.get("assay_title") or acc,
            acc,
            f"https://www.encodeproject.org/experiments/{acc}/" if acc else "https://www.encodeproject.org/",
            "ENCODE",
            [("实验编号", acc),
             ("实验类型", item.get("assay_term_name") or ""),
             ("靶点", target),
             ("生物样本", _dig(item, "biosample_ontology.term_name") or ""),
             ("状态", item.get("status") or "")],
        ))
    return rows


async def _t_cbioportal(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    data = (await _get(spec.endpoint.format(q=_quote(query), limit=limit), timeout=20.0)).json()
    items = data if isinstance(data, list) else []
    rows = []
    for item in items[:limit]:
        sid = item.get("studyId") or ""
        rows.append(_row(
            item.get("name") or sid,
            sid,
            f"https://www.cbioportal.org/study/summary?id={sid}",
            "cBioPortal",
            [("研究编号", sid),
             ("癌症类型", item.get("cancerTypeId") or ""),
             ("样本数", item.get("allSampleCount") or ""),
             ("参考基因组", item.get("referenceGenome") or ""),
             ("PMID", item.get("pmid") or ""),
             ("研究状态", item.get("status") or "")],
        ))
    return rows


async def _t_openfda(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    data = (await _get(spec.endpoint.format(q=_quote(query), limit=limit), timeout=20.0)).json()
    rows = []
    for item in _dig(data, "results") or []:
        of = item.get("openfda") or {}
        generic = of.get("generic_name") or []
        brand = of.get("brand_name") or []
        route = of.get("route") or []
        rows.append(_row(
            (generic[0] if generic else "—"),
            "、".join(brand[:3]),
            "https://open.fda.gov/apis/drug/label/",
            "openFDA",
            [("通用名", "、".join(generic[:4])),
             ("品牌名", "、".join(brand[:4])),
             ("给药途径", "、".join(route[:3])),
             ("适应症", (item.get("indications_and_usage") or [""])[0][:160])],
        ))
    return rows


async def _t_europepmc(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    data = (await _get(spec.endpoint.format(q=_quote(query), limit=limit), timeout=20.0)).json()
    rows = []
    for item in _dig(data, "resultList.result") or []:
        pmid = item.get("pmid") or ""
        rows.append(_row(
            (item.get("title") or "—")[:180],
            item.get("authorString") or "",
            f"https://europepmc.org/article/MED/{pmid}" if pmid else "https://europepmc.org/",
            "Europe PMC",
            [("期刊", item.get("journalTitle") or ""),
             ("年份", item.get("pubYear") or ""),
             ("PMID", pmid),
             ("DOI", item.get("doi") or ""),
             ("来源", item.get("source") or "")],
        ))
    return rows


async def _t_ols_chebi(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    data = (await _get(spec.endpoint.format(q=_quote(query), limit=limit))).json()
    rows = []
    for doc in _dig(data, "response.docs") or []:
        label = doc.get("label") or doc.get("short_form") or ""
        obo = doc.get("obo_id") or ""
        rows.append(_row(
            f"{label}（{obo}）" if obo else label,
            _flatten_text(doc.get("description")),
            doc.get("iri") or "https://www.ebi.ac.uk/chebi/",
            "ChEBI",
            [("本体编号", obo), ("本体", doc.get("ontology_name") or "")],
        ))
    return rows


async def _t_taxonomy(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    ids = _dig((await _get(spec.endpoint.format(q=_quote(query), limit=limit))).json(), "esearchresult.idlist") or []
    if not ids:
        return []
    summary = (await _get(
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=taxonomy&retmode=json&id="
        + ",".join(ids[:limit])
    )).json()
    result = _dig(summary, "result") or {}
    rows = []
    for tid in ids[:limit]:
        item = result.get(tid) or {}
        taxid = item.get("taxid") or tid
        rows.append(_row(
            item.get("scientificname") or str(taxid),
            item.get("commonname") or "",
            f"https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi?id={taxid}",
            "NCBI Taxonomy",
            [("学名", item.get("scientificname") or ""),
             ("俗名", item.get("commonname") or ""),
             ("分类等级", item.get("rank") or ""),
             ("类群", item.get("division") or ""),
             ("TaxID", taxid)],
        ))
    return rows


async def _t_hgnc(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    resp = await _get(spec.endpoint.format(q=_quote(query)), timeout=20.0)
    if resp.status_code >= 400:
        raise RuntimeError(f"HGNC 未找到该基因符号（HTTP {resp.status_code}）")
    data = resp.json()
    docs = _dig(data, "response.docs") or []
    rows = []
    for item in docs[:limit]:
        alias = item.get("alias_name") or []
        if isinstance(alias, str):
            alias = [alias]
        rows.append(_row(
            item.get("symbol") or "",
            item.get("name") or "",
            f"https://www.genenames.org/data/gene-symbol-report/#!/hgnc_id/{item.get('hgnc_id', '')}",
            "HGNC",
            [("标准名称", item.get("name") or ""),
             ("别名", "、".join(alias[:4])),
             ("染色体位置", item.get("location") or ""),
             ("Entrez ID", item.get("entrez_id") or ""),
             ("HGNC ID", item.get("hgnc_id") or "")],
        ))
    return rows


async def _t_pride(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    data = (await _get(spec.endpoint.format(q=_quote(query), limit=limit), timeout=20.0)).json()
    items = data if isinstance(data, list) else []
    rows = []
    for item in items[:limit]:
        acc = item.get("accession") or ""
        rows.append(_row(
            item.get("title") or acc,
            acc,
            f"https://www.ebi.ac.uk/pride/archive/projects/{acc}" if acc else "https://www.ebi.ac.uk/pride/",
            "PRIDE",
            [("项目编号", acc),
             ("提交日期", item.get("submissionDate") or ""),
             ("发表日期", item.get("publicationDate") or ""),
             ("数据类别", "、".join(item.get("submissionType") or []) if isinstance(item.get("submissionType"), list) else (item.get("submissionType") or ""))],
        ))
    return rows


async def _t_enrichr(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    data = (await _get(spec.endpoint, timeout=20.0)).json()
    stats = _dig(data, "statistics") or []
    q = (query or "").strip().lower()
    matched = [s for s in stats if q in (s.get("libraryName") or "").lower()]
    picked = matched or stats[:limit]
    note = "基因集库" if matched else "基因集库目录（无匹配关键词，展示前若干个）"
    rows = []
    for item in picked[:limit]:
        rows.append(_row(
            item.get("libraryName") or "",
            note,
            item.get("link") or "https://maayanlab.cloud/Enrichr/",
            "Enrichr",
            [("术语数", item.get("numTerms") or ""),
             ("每术语基因数", item.get("genesPerTerm") or ""),
             ("基因覆盖率", item.get("geneCoverage") or "")],
        ))
    return rows


async def _t_brain_atlas(spec: ApiSpec, query: str, limit: int, params: dict) -> list[dict]:
    data = (await _get(spec.endpoint, timeout=20.0)).json()
    items = _dig(data, "msg") or []
    q = (query or "").strip().lower()
    picked = [i for i in items if q in (i.get("name") or "").lower() or q in (i.get("description") or "").lower()]
    if not picked:
        picked = items[:limit]
    rows = []
    for item in picked[:limit]:
        rows.append(_row(
            item.get("name") or "—",
            (item.get("description") or "")[:160],
            f"https://brain-map.org/atlas#{item.get('id', '')}",
            "Allen Brain Atlas",
            [("图谱 ID", item.get("id") or ""),
             ("图像类型", item.get("image_type") or ""),
             ("样本类型", item.get("specimen_type") or "")],
        ))
    return rows


TRANSFORMS: dict[str, Callable[..., Any]] = {
    "ncbi_gene": _t_ncbi_gene,
    "ncbi_sra": _t_ncbi_sra,
    "blast_submit": _t_blast_submit,
    "ena": _t_ena,
    "uniprot": _t_uniprot,
    "interpro": _t_interpro,
    "alphafold": _t_alphafold,
    "kegg": _t_kegg,
    "atlas": _t_atlas,
    "rcsb": _t_rcsb,
    "panther": _t_panther,
    "ols": _t_ols,
    "chembl": _t_chembl,
    "pubchem": _t_pubchem,
    "clinvar": _t_clinvar,
    "opentargets": _t_opentargets,
    "string": _t_string,
    "hpa": _t_hpa,
    "cellosaurus": _t_cellosaurus,
    "encode": _t_encode,
    "cbioportal": _t_cbioportal,
    "openfda": _t_openfda,
    "europepmc": _t_europepmc,
    "ols_chebi": _t_ols_chebi,
    "taxonomy": _t_taxonomy,
    "hgnc": _t_hgnc,
    "pride": _t_pride,
    "enrichr": _t_enrichr,
    "brain_atlas": _t_brain_atlas,
}


def _quote(value: str) -> str:
    from urllib.parse import quote

    return quote(value or "", safe="")


# --------------------------------------------------------------------------
# 公开 API
# --------------------------------------------------------------------------
_probe_cache: dict[str, tuple[float, bool, str]] = {}
_probe_lock = asyncio.Lock()
_probe_inflight: dict[str, asyncio.Task[tuple[bool, str]]] = {}
PROBE_TTL = 300.0


async def probe(key: str) -> tuple[bool, str]:
    """探测适配器可用性（结果缓存 5 分钟）。"""
    spec = ADAPTERS.get(key)
    if not spec:
        return False, "无公开 API"
    now = time.time()
    cached = _probe_cache.get(key)
    if cached and now - cached[0] < PROBE_TTL:
        return cached[1], cached[2]
    # 同一个适配器被并发探活时只发一次请求（/api/databases/apis 每次都会全量齐射）
    pending = _probe_inflight.get(key)
    if pending is not None and not pending.done():
        return await asyncio.shield(pending)
    task = asyncio.create_task(_probe_uncached(spec, key, now))
    _probe_inflight[key] = task
    try:
        return await task
    finally:
        _probe_inflight.pop(key, None)


async def _probe_uncached(spec: ApiSpec, key: str, now: float) -> tuple[bool, str]:
    try:
        if spec.transform == "blast_submit":
            resp = await _get(f"https://blast.ncbi.nlm.nih.gov/Blast.cgi?CMD=Info", timeout=10.0)
        elif spec.transform == "kegg":
            resp = await _get("https://rest.kegg.jp/info/kegg", timeout=10.0)
        elif spec.transform == "rcsb":
            resp = await _post(
                "https://search.rcsb.org/rcsbsearch/v2/query",
                {"query": {"type": "terminal", "service": "full_text", "parameters": {"value": "plant"}},
                 "return_type": "entry", "request_options": {"paginate": {"start": 0, "rows": 1}}},
                10.0,
            )
        elif spec.transform == "ols":
            resp = await _get("https://www.ebi.ac.uk/ols4/api/ontologies", timeout=10.0)
        elif spec.transform == "pubchem":
            resp = await _get(
                "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/aspirin/property/MolecularFormula/JSON",
                timeout=10.0,
            )
        elif spec.transform == "hgnc":
            resp = await _get("https://rest.genenames.org/fetch/symbol/BRCA1", timeout=10.0)
        elif spec.transform == "openfda":
            resp = await _get(
                "https://api.fda.gov/drug/label.json?search=openfda.generic_name:aspirin&limit=1", timeout=10.0
            )
        elif spec.transform == "opentargets":
            resp = await _post(
                "https://api.platform.opentargets.org/api/v4/graphql",
                {"query": "query { search(queryString: \"aspirin\", page: {index: 0, size: 1}) { hits { id name } } }"},
                10.0,
            )
        elif spec.transform == "panther":
            resp = await _get(spec.endpoint.format(q=_quote("AP1"), organism="3702"), timeout=10.0)
        else:
            url = spec.endpoint.format(q=_quote("test"), limit=1)
            resp = await _get(url, timeout=_timeout_for(url, base=15.0), retries=1)
        ok = resp.status_code < 400
        detail = f"HTTP {resp.status_code}"
    except Exception as exc:  # noqa: BLE001 - 探活不抛错
        ok, detail = False, f"{type(exc).__name__}"
    async with _probe_lock:
        _probe_cache[key] = (now, ok, detail)
    return ok, detail


#: 并发上限：30+ 个适配器一次性齐射会把本机房出口打满，
#: 也会让上游把整批请求判成扫描/滥用。串行批次 + 连接复用足够快。
PROBE_CONCURRENCY = 8


async def probe_all() -> dict[str, tuple[bool, str]]:
    keys = list(ADAPTERS.keys())
    sem = asyncio.Semaphore(PROBE_CONCURRENCY)

    async def _one(k: str) -> tuple[bool, str]:
        async with sem:
            return await probe(k)

    results = await asyncio.gather(*(_one(k) for k in keys))
    return dict(zip(keys, results))


async def run_query(key: str, query: str, limit: int = 5, params: dict | None = None) -> dict[str, Any]:
    """执行一次数据库查询，返回归一化结果。"""
    spec = ADAPTERS.get(key)
    if not spec:
        return {"ok": False, "error": "该数据库没有可用的公开 API", "items": [], "api": None}
    q = (query or "").strip()
    if not q:
        return {"ok": False, "error": "请输入检索关键词", "items": [], "api": spec.as_dict()}
    limit = max(1, min(int(limit or 5), 20))
    started = time.time()
    try:
        if spec.transform:
            fn = TRANSFORMS.get(spec.transform)
            if fn is None:
                raise RuntimeError(f"未知转换器 {spec.transform}")
            items = await fn(spec, q, limit, params or {})
        else:
            url = spec.endpoint.format(q=_quote(q), limit=limit)
            payload = await _get_json(url, timeout=_timeout_for(url), retries=1)
            raw = _dig(payload, spec.results_path) or []
            items = [
                _row(
                    _flatten_text(item.get(key)) or key,
                    "",
                    item.get("url") or spec.homepage,
                    spec.name,
                    [(label, _flatten_text(item.get(key))) for key, label in spec.fields],
                )
                for item in raw[:limit]
                if isinstance(item, dict)
            ]
    except Exception as exc:  # noqa: BLE001 - 统一转成结构化错误
        if isinstance(exc, json.JSONDecodeError):
            reason = "上游返回了非 JSON 内容（服务维护、限流或网关拦截），请稍后重试或改用网页访问"
        elif isinstance(exc, httpx.TimeoutException):
            reason = "上游响应超时（本机房到该站点的链路较慢），请稍后重试"
        elif isinstance(exc, httpx.TransportError):
            reason = f"无法连接上游服务（{type(exc).__name__}），请稍后重试或改用网页访问"
        else:
            reason = f"{type(exc).__name__} {str(exc)[:160]}"
        return {
            "ok": False,
            "error": f"查询失败：{reason}",
            "items": [],
            "api": spec.as_dict(),
            "elapsedMs": int((time.time() - started) * 1000),
        }
    return {
        "ok": True,
        "items": items,
        "api": spec.as_dict(),
        "total": len(items),
        "elapsedMs": int((time.time() - started) * 1000),
    }


def api_index() -> list[dict[str, Any]]:
    """全部数据库的 API 情况（可用适配器 + 无 API 原因）。"""
    out: list[dict[str, Any]] = []
    for db in PLANT_DATABASES:
        key = db["id"]
        spec = ADAPTERS.get(key)
        if spec:
            out.append({
                "id": key,
                "name": db["name"],
                "cn": db.get("cn", ""),
                "category": db.get("category", ""),
                "url": db.get("url", ""),
                "hasApi": True,
                "api": spec.as_dict(),
                "note": spec.note,
            })
        else:
            out.append({
                "id": key,
                "name": db["name"],
                "cn": db.get("cn", ""),
                "category": db.get("category", ""),
                "url": db.get("url", ""),
                "hasApi": False,
                "api": None,
                "note": NO_API_NOTES.get(key, "该资源未提供可匿名调用的公开检索 API，暂以网页链接方式访问。"),
            })
    return out


def api_summary() -> dict[str, Any]:
    """概览：可 API 化的库数量与清单。"""
    with_api = [k for k in ADAPTERS]
    return {
        "total": len(PLANT_DATABASES),
        "withApi": len(with_api),
        "withoutApi": len(PLANT_DATABASES) - len(with_api),
        "keys": with_api,
    }
