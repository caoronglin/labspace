"""统一生信工具后端（Biopython + scikit-bio）。

已废弃的 CropGenome（rust-bio 实现的序列工具）被本模块取代：这里把序列分析、
格式转换、酶切、ORF、引物、比对、建树、质粒图谱、测序峰图等能力集中到**一个**
只读、纯计算的路由里，前端按 ``GET /meta`` 返回的能力清单渲染卡片。

设计约束（与门户其它模块一致）：
* 无状态：不落盘、不读写数据库，上传内容只在内存里处理；
* 只读：所有端点都可以重复调用，不改变任何服务端数据；
* 需要登录：``require_user``；只有 multipart 上传端点额外要 CSRF。

外网能力（Entrez / BLAST）在部署环境里不可用，见 ``_ncbi_call``。
"""
from __future__ import annotations

import asyncio
import io
import math
import re
import socket
from typing import Any, cast

from Bio import SeqIO
from Bio.Align import PairwiseAligner
from Bio.Data import CodonTable
from Bio.Data.IUPACData import protein_letters_3to1_extended
from Bio.Restriction import Analysis, RestrictionBatch
from Bio.Seq import Seq
from Bio.SeqUtils import MeltingTemp, gc_fraction, seq1, seq3
from Bio.SeqUtils.ProtParam import ProteinAnalysis
from fastapi import APIRouter, Body, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response

from .security import require_csrf, require_user
from .uploads import read_upload_capped

router = APIRouter(prefix="/api/biotools", tags=["biotools"])

# ---------------------------------------------------------------- 常量与限制

DNA_LETTERS = frozenset("ACGTNRYWSKMBDHV")
"""DNA 允许的 IUPAC 字符（含简并碱基，限制酶与 GC 计算都能处理）。"""

RNA_LETTERS = frozenset("ACGUNRYWSKMBDHV")
"""RNA 允许的字符；U 替 T。"""

PROTEIN_LETTERS = frozenset("ACDEFGHIKLMNPQRSTVWY")
"""ProtParam 只接受 20 种标准氨基酸，因此校验也只用这 20 个。"""

STOP_CODON_MARKS = frozenset("*")
"""三字母码表里代表终止的写法（seq3 输出 ``Ter``）。"""

COMMON_ENZYMES: tuple[str, ...] = (
    "EcoRI", "BamHI", "HindIII", "SmaI", "XbaI", "SalI", "PstI", "KpnI",
    "SacI", "SphI", "NcoI", "NotI", "BglII", "ClaI", "EcoRV", "SpeI",
    "NdeI", "ApaI", "AvrII", "AgeI", "XhoI", "MluI", "NheI", "AatII",
    "HaeIII", "MseI", "NruI", "PacI", "PmeI", "PvuII", "StuI", "ScaI",
)
"""常用限制酶（32 个）。前端不传 enzymes 时按这份清单做全量酶切。"""

MAX_SEQUENCE_LEN = 200_000
MAX_PAIRWISE_LEN = 5_000
MAX_MSA_SEQUENCES = 24
MAX_MSA_LEN = 2_000
MAX_ENZYMES = 60
MAX_TREE_CHARS = 200_000
ABI_MAX_BYTES = 1 * 1024 * 1024
SEQIO_MAX_BYTES = 20 * 1024 * 1024
QUALITY_SAMPLE_POINTS = 100
MAX_KMER_ENTRIES = 512

_NCBI_HOST = "eutils.ncbi.nlm.nih.gov"
_NCBI_CONNECT_TIMEOUT = 3
_NCBI_TOTAL_TIMEOUT = 15
_NCBI_BLAST_TIMEOUT = 120
"""BLAST 是排队式远程计算，正常也要几十秒；探活已经保证"连不上就立刻 503"。"""
_NCBI_UNAVAILABLE = "需要外网访问 NCBI，当前环境不可用"
_NCBI_EMAIL = "labspace@lab.example"
"""NCBI 要求调用方声明联系邮箱，未设置时 Entrez 直接报错。"""

_WHITESPACE_OR_DIGITS = re.compile(r"[\s\d]+")
_ID_SAFE = re.compile(r"[^A-Za-z0-9_.\-]+")

_CAPABILITIES: tuple[dict[str, Any], ...] = (
    {
        "id": "sequence_analyze",
        "name": "序列分析",
        "group": "序列",
        "method": "POST",
        "path": "/api/biotools/sequence/analyze",
        "inputs": ["sequence", "molecule", "frame"],
        "summary": "长度、GC、互补/反向互补、转录、三框翻译与蛋白理化参数",
    },
    {
        "id": "cds_extract",
        "name": "CDS 提取与翻译",
        "group": "序列",
        "method": "POST",
        "path": "/api/biotools/cds/extract",
        "inputs": ["record", "feature_type", "ids", "sequence", "start", "end", "strand", "frame"],
        "summary": "从 GenBank/EMBL 的 CDS 注释或按坐标区间提取编码序列并翻译",
    },
    {
        "id": "format_convert",
        "name": "格式转换",
        "group": "序列",
        "method": "POST",
        "path": "/api/biotools/format/convert",
        "inputs": ["text", "from", "to"],
        "summary": "GenBank / FASTA / EMBL 互转（Bio.SeqIO）",
    },
    {
        "id": "restriction",
        "name": "限制酶切位点",
        "group": "克隆",
        "method": "POST",
        "path": "/api/biotools/restriction",
        "inputs": ["sequence", "enzymes", "circular"],
        "summary": "全部酶切位点、单切酶与不切酶",
    },
    {
        "id": "orf",
        "name": "ORF 预测",
        "group": "序列",
        "method": "POST",
        "path": "/api/biotools/orf",
        "inputs": ["sequence", "min_aa", "genetic_code"],
        "summary": "六框 ORF（起点必须是起始密码子，终点为终止密码子）",
    },
    {
        "id": "protein_params",
        "name": "蛋白参数",
        "group": "蛋白",
        "method": "POST",
        "path": "/api/biotools/protein/params",
        "inputs": ["sequence"],
        "summary": "分子量、等电点、GRAVY、芳香性、不稳定指数与消光系数",
    },
    {
        "id": "primer_tm",
        "name": "引物 Tm",
        "group": "引物",
        "method": "POST",
        "path": "/api/biotools/primer/tm",
        "inputs": ["sequence", "method", "na_mM", "primer_mM"],
        "summary": "Wallace / GC / 最近邻三种解链温度算法",
    },
    {
        "id": "primer_dilution",
        "name": "引物稀释",
        "group": "引物",
        "method": "POST",
        "path": "/api/biotools/primer/dilution",
        "inputs": ["stock_um", "working_um", "volume_ul", "mass_od"],
        "summary": "C1V1=C2V2 配制工作液，可选 OD260 换算提示",
    },
    {
        "id": "align_pairwise",
        "name": "双序列比对",
        "group": "比对",
        "method": "POST",
        "path": "/api/biotools/align/pairwise",
        "inputs": ["query", "reference", "mode", "scoring"],
        "summary": "全局/局部/半全局比对，返回打分、一致度与带匹配行的比对串",
    },
    {
        "id": "align_multiple",
        "name": "多序列比对",
        "group": "比对",
        "method": "POST",
        "path": "/api/biotools/align/multiple",
        "inputs": ["sequences"],
        "summary": "星型渐进比对（非最优 MSA），输出等长矩阵、一致序列与一致度矩阵",
    },
    {
        "id": "phylo_nj",
        "name": "邻接法建树",
        "group": "进化",
        "method": "POST",
        "path": "/api/biotools/phylo/nj",
        "inputs": ["sequences", "matrix", "ids"],
        "summary": "按一致度距离或给定距离矩阵做 NJ 建树，返回 Newick",
    },
    {
        "id": "phylo_convert",
        "name": "树格式互转",
        "group": "进化",
        "method": "POST",
        "path": "/api/biotools/phylo/convert",
        "inputs": ["newick"],
        "summary": "Newick → ASCII 树形图与嵌套 JSON",
    },
    {
        "id": "gc_window",
        "name": "GC 窗口曲线",
        "group": "序列",
        "method": "POST",
        "path": "/api/biotools/gc/window",
        "inputs": ["sequence", "window", "step", "k"],
        "summary": "滑动窗口 GC 曲线点与 k-mer 频次",
    },
    {
        "id": "seq3_convert",
        "name": "三字母转换",
        "group": "蛋白",
        "method": "POST",
        "path": "/api/biotools/seq3/convert",
        "inputs": ["sequence", "direction", "patent_offset", "group_per_line"],
        "summary": "氨基酸单字母↔三字母，支持专利序列表排版",
    },
    {
        "id": "vector_trim",
        "name": "载体序列裁剪",
        "group": "克隆",
        "method": "POST",
        "path": "/api/biotools/vector/trim",
        "inputs": ["read", "vector", "min_score"],
        "summary": "去掉测序读段末端的载体残留，返回裁剪区间与匹配度",
    },
    {
        "id": "abi_parse",
        "name": "测序峰图解析",
        "group": "测序",
        "method": "POST",
        "path": "/api/biotools/abi/parse",
        "inputs": ["file(.ab1)"],
        "summary": "读取 ABI 峰图：碱基、平均质量、裁剪区间与质量抽样点",
        "upload": True,
    },
    {
        "id": "seqio_filter",
        "name": "序列文件筛选",
        "group": "序列",
        "method": "POST",
        "path": "/api/biotools/seqio/filter",
        "inputs": ["file", "min_len", "max_len", "min_gc", "max_gc", "id_pattern"],
        "summary": "按长度/GC/名称正则筛选 FASTA 或 GenBank 记录",
        "upload": True,
    },
    {
        "id": "plasmid_map",
        "name": "质粒图谱",
        "group": "克隆",
        "method": "POST",
        "path": "/api/biotools/plasmid/map",
        "inputs": ["record", "topology", "title"],
        "summary": "按 GenBank 注释绘制环形/线性质粒图谱（PNG 或 SVG）",
    },
    {
        "id": "diversity_pcoa",
        "name": "PCoA 排序",
        "group": "进化",
        "method": "POST",
        "path": "/api/biotools/diversity/pcoa",
        "inputs": ["ids", "matrix"],
        "summary": "对称距离矩阵的主坐标分析，返回坐标与解释度",
    },
    {
        "id": "entrez_search",
        "name": "NCBI 检索",
        "group": "外部",
        "method": "GET",
        "path": "/api/biotools/entrez/search",
        "inputs": ["db", "term", "retmax"],
        "summary": "Entrez esearch（需要外网，当前环境不可用）",
    },
    {
        "id": "entrez_fetch",
        "name": "NCBI 取序列",
        "group": "外部",
        "method": "POST",
        "path": "/api/biotools/entrez/fetch",
        "inputs": ["db", "ids"],
        "summary": "Entrez efetch（需要外网，当前环境不可用）",
    },
    {
        "id": "blast",
        "name": "NCBI BLAST",
        "group": "外部",
        "method": "POST",
        "path": "/api/biotools/blast",
        "inputs": ["sequence", "program", "database"],
        "summary": "远程 BLAST 比对（需要外网，当前环境不可用）",
    },
)


# ---------------------------------------------------------------- 输入校验


def _text_field(payload: dict[str, Any], key: str, *, label: str = "") -> str:
    """取一个必填文本字段（保留大小写与原样换行，供格式转换类端点使用）。"""
    value = payload.get(key)
    text = "" if value is None else str(value)
    if not text.strip():
        raise HTTPException(status_code=400, detail=f"{label or key} 不能为空")
    return text


def _clean_sequence(raw: Any, label: str = "序列") -> str:
    """规整用户粘贴的序列：去掉空白与行号数字，统一大写。

    GenBank/FASTA 复制出来的序列常带空格、换行和 60/10 位行号；
    这些字符对计算没有意义，但会让 Bio.Seq 的校验直接报错。
    """
    text = "" if raw is None else str(raw)
    cleaned = _WHITESPACE_OR_DIGITS.sub("", text).upper()
    if not cleaned:
        raise HTTPException(status_code=400, detail=f"{label}不能为空")
    return cleaned


def _require_nucleic(raw: Any, *, label: str = "序列", allow_rna: bool = False) -> str:
    """校验核酸序列（DNA/RNA），返回大写无空白的序列。

    先做字符白名单再比对长度：提前拦掉蛋白质或乱码输入，
    比让 Bio.Seq/Restriction 抛内部异常更容易定位问题。
    """
    sequence = _clean_sequence(raw, label)
    alphabet = RNA_LETTERS if allow_rna else DNA_LETTERS
    bad = sorted({ch for ch in sequence if ch not in alphabet})
    if bad:
        raise HTTPException(
            status_code=400,
            detail=f"{label}含非法字符：{'、'.join(bad)}（只允许 {'ACGTUN' if allow_rna else 'ACGTN'} 及简并碱基）",
        )
    if len(sequence) > MAX_SEQUENCE_LEN:
        raise HTTPException(status_code=400, detail=f"{label}过长（上限 {MAX_SEQUENCE_LEN} 个碱基）")
    return sequence


def _require_protein(raw: Any, *, label: str = "蛋白序列") -> str:
    """校验蛋白序列：只允许 20 种标准氨基酸（ProtParam 的硬性要求）。"""
    sequence = _clean_sequence(raw, label)
    bad = sorted({ch for ch in sequence if ch not in PROTEIN_LETTERS})
    if bad:
        raise HTTPException(
            status_code=400,
            detail=f"{label}含非法字符：{'、'.join(bad)}（只允许 20 种标准氨基酸单字母码）",
        )
    if len(sequence) > MAX_SEQUENCE_LEN:
        raise HTTPException(status_code=400, detail=f"{label}过长（上限 {MAX_SEQUENCE_LEN} 个残基）")
    return sequence


def _int_field(
    payload: dict[str, Any],
    key: str,
    default: int,
    *,
    lo: int,
    hi: int,
) -> int:
    """取整型字段；缺省用 default，超范围或非整数按 400 处理。"""
    raw = payload.get(key)
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"{key} 必须是整数") from exc
    if value < lo or value > hi:
        raise HTTPException(status_code=400, detail=f"{key} 必须在 {lo}~{hi} 之间")
    return value


def _float_field(
    payload: dict[str, Any],
    key: str,
    default: float,
    *,
    lo: float | None = None,
    hi: float | None = None,
) -> float:
    """取浮点字段；空值用 default，越界按 400 处理。"""
    raw = payload.get(key)
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"{key} 必须是数字") from exc
    if not math.isfinite(value):
        raise HTTPException(status_code=400, detail=f"{key} 必须是有限数字")
    if lo is not None and value < lo:
        raise HTTPException(status_code=400, detail=f"{key} 不能小于 {lo}")
    if hi is not None and value > hi:
        raise HTTPException(status_code=400, detail=f"{key} 不能大于 {hi}")
    return value


def _round(value: float, digits: int = 4) -> float:
    return round(float(value), digits)


# ---------------------------------------------------------------- 通用计算


def _gc_percent(sequence: str) -> float:
    """GC 含量百分比；空序列按 0 处理，避免除零。"""
    if not sequence:
        return 0.0
    return _round(gc_fraction(Seq(sequence)) * 100, 2)


def _protein_params(protein: str) -> dict[str, Any]:
    """ProtParam 的理化参数集合（供 /sequence/analyze 与 /protein/params 复用）。"""
    analysis = ProteinAnalysis(protein)
    reduced, cystine = analysis.molar_extinction_coefficient()
    return {
        "molecular_weight": _round(analysis.molecular_weight(), 2),
        "isoelectric_point": _round(analysis.isoelectric_point(), 3),
        "gravy": _round(analysis.gravy(), 3),
        "aromaticity": _round(analysis.aromaticity(), 3),
        "instability_index": _round(analysis.instability_index(), 2),
        "extinction_coefficient": {"reduced": reduced, "cystine": cystine},
    }


EMPTY_PROTEIN_PARAMS: dict[str, Any] = {
    "molecular_weight": None,
    "isoelectric_point": None,
    "gravy": None,
    "aromaticity": None,
    "instability_index": None,
    "extinction_coefficient": None,
}
"""翻译结果不是一条完整蛋白时的占位参数（保证响应字段恒在）。"""


def _protein_params_or_none(protein: str) -> dict[str, Any] | None:
    """能算就算，不能算就返回 None。

    核酸的三框翻译里常有内部终止符或简并密码子翻译出的 X，
    这样的序列不是一条完整蛋白，ProtParam 会直接抛错，因此不做硬算。
    """
    if not protein or any(letter not in PROTEIN_LETTERS for letter in protein):
        return None
    return _protein_params(protein)


def _three_frame_translations(nucleic: str, table: str = "1") -> dict[str, str]:
    """核酸的三个正向读框翻译；末尾的 ``*`` 保留，便于用户看出终止位置。"""
    seq = Seq(nucleic)
    return {f"+{frame}": str(seq[frame - 1 :].translate(table=table)) for frame in (1, 2, 3)}


def _translate_cds(nucleic: str, *, table: str = "1", frame: int = 1) -> str:
    """翻译编码序列：从 frame（1/2/3）开始，去掉末尾终止符 ``*``。

    CDS 末尾的终止密码子不属于蛋白产物，保留会让下游分子量计算多算一个残基。
    """
    trimmed = nucleic[frame - 1 :]
    return str(Seq(trimmed).translate(table=table)).rstrip("*")


def _codon_table(code_id: int) -> CodonTable.CodonTable:
    try:
        return CodonTable.unambiguous_dna_by_id[code_id]
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=f"不支持的遗传密码表编号：{code_id}") from exc


def _pairwise_aligner(
    *,
    mode: str,
    match: float = 1.0,
    mismatch: float = -1.0,
    gap_open: float = -2.0,
    gap_extend: float = -1.0,
) -> PairwiseAligner:
    """按模式构造 PairwiseAligner。

    ``semiglobal`` 用 ``end_gap_score=0`` 把全局比对两端空位设为免费，
    等价于"半全局/重叠比对"，Biopython 没有单独的 semiglobal 模式。
    """
    aligner = PairwiseAligner()
    aligner.match_score = match
    aligner.mismatch_score = mismatch
    aligner.open_gap_score = gap_open
    aligner.extend_gap_score = gap_extend
    if mode == "local":
        aligner.mode = "local"
    elif mode in {"global", "semiglobal"}:
        aligner.mode = "global"
        if mode == "semiglobal":
            aligner.end_gap_score = 0
    else:
        raise HTTPException(status_code=400, detail="mode 只能是 global / local / semiglobal")
    return aligner


def _alignment_strings(alignment: Any) -> tuple[str, str]:
    """取比对结果的两行比对串（含空位）。"""
    return str(alignment[0]), str(alignment[1])


def _alignment_score(alignment: Any) -> float:
    """比对得分（Biopython 的 Alignment 桩里没有 score，统一从这里读）。"""
    return float(alignment.score)


def _match_line(query_row: str, reference_row: str) -> str:
    """生成三行比对里的匹配行：``|`` 相同、``.`` 错配、空格 空位。"""
    marks = []
    for query_base, reference_base in zip(query_row, reference_row, strict=True):
        if query_base == "-" or reference_base == "-":
            marks.append(" ")
        elif query_base == reference_base:
            marks.append("|")
        else:
            marks.append(".")
    return "".join(marks)


def _alignment_stats(query_row: str, reference_row: str) -> dict[str, Any]:
    """比对串的统计量：匹配数、一致度、空位数。

    一致度 = 相同列 / 比对总列数（空位计为不一致）。
    不用"非空位列"作分母：那样只差插入/缺失的两条序列会被算成 100% 一致，
    建树时距离直接归零，进化关系就被抹平了。
    """
    matches = 0
    gap_columns = 0
    informative = 0
    for query_base, reference_base in zip(query_row, reference_row, strict=True):
        if query_base == "-" or reference_base == "-":
            gap_columns += 1
            if query_base == "-" and reference_base == "-":
                continue
            continue
        informative += 1
        if query_base == reference_base:
            matches += 1
    identity = _round(matches / len(query_row), 4) if query_row else 0.0
    return {
        "matches": matches,
        "informative_columns": informative,
        "gap_columns": gap_columns,
        "identity": identity,
    }


def _identity_between(first: str, second: str) -> float:
    """两条（未比对）序列的一致度，用于建树前构造距离矩阵。"""
    aligner = _pairwise_aligner(mode="global", match=1.0, mismatch=-1.0, gap_open=-2.0, gap_extend=-1.0)
    try:
        alignment = aligner.align(first, second)[0]
    except IndexError:  # 理论上不会发生：空序列已在入口被拦住
        return 0.0
    query_row, reference_row = _alignment_strings(alignment)
    return float(_alignment_stats(query_row, reference_row)["identity"])


# ---------------------------------------------------------------- 格式解析


def _sniff_format(text: str) -> str:
    """按内容猜测序列文件格式（FASTA / GenBank / EMBL）。"""
    head = text.lstrip()
    if head.startswith(">"):
        return "fasta"
    if head.startswith("LOCUS"):
        return "genbank"
    if re.match(r"^ID\s+\S+;", head):
        return "embl"
    raise HTTPException(status_code=400, detail="未知格式：既不是 FASTA，也不是 GenBank/EMBL")


def _parse_records(text: str, file_format: str) -> list[Any]:
    """解析多记录文件，出错时指出是第几条记录。

    SeqIO 的报错原文里带位置信息，但不知道是第几条记录；逐条 next() 才能
    把"第 N 条记录"补上，用户才知道去文件哪一段查。
    """
    iterator = SeqIO.parse(io.StringIO(text), file_format)
    records: list[Any] = []
    while True:
        try:
            record = next(iterator)
        except StopIteration:
            break
        except (ValueError, KeyError) as exc:
            raise HTTPException(
                status_code=400,
                detail=f"第 {len(records) + 1} 条记录解析失败：{exc}",
            ) from exc
        records.append(record)
    if not records:
        # 一条都没解析出来时，问题一定在第 1 条记录：把"第 1 条"和常见原因
        # 一起说出来，用户才知道是缺 LOCUS 行还是缺结尾的 //。
        raise HTTPException(
            status_code=400,
            detail=(
                f"没有解析到任何记录（按 {file_format} 解析）："
                "第 1 条记录就不完整，请检查是否缺少 LOCUS/ID 行或结尾的 //"
            ),
        )
    return records


def _prepare_record(record: Any, file_format: str, warnings: list[str]) -> None:
    """补上 GenBank/EMBL 写出必需的注释，并把非法 ID 换成可写出的形式。

    GenBank 的 LOCUS 名不允许空格与冒号，直接写会抛 ValueError；
    这里改写而不是让整个转换失败，同时把改写记录进 warnings 告知用户。
    """
    if not record.annotations.get("molecule_type"):
        letters = set(str(record.seq).upper())
        record.annotations["molecule_type"] = "DNA" if letters <= (DNA_LETTERS | RNA_LETTERS) else "protein"
    if file_format == "fasta":
        return
    record.id = _ID_SAFE.sub("_", record.id or "")[:40] or "record"
    record.name = _ID_SAFE.sub("_", record.name or "")[:16] or record.id
    if record.name != record.id[:16]:
        warnings.append(f"记录 {record.id} 的名称含 GenBank/EMBL 不允许的字符，已改为 {record.name}")


# ---------------------------------------------------------------- 序列分析


@router.get("/meta")
async def biotools_meta(_: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    """能力清单：前端据此渲染工具卡片、分组与输入提示。"""
    groups: list[str] = []
    for item in _CAPABILITIES:
        if item["group"] not in groups:
            groups.append(item["group"])
    return {
        "items": [dict(item) for item in _CAPABILITIES],
        "groups": groups,
        "enzymes": list(COMMON_ENZYMES),
        "limits": {
            "max_sequence_len": MAX_SEQUENCE_LEN,
            "max_pairwise_len": MAX_PAIRWISE_LEN,
            "max_msa_sequences": MAX_MSA_SEQUENCES,
            "max_msa_len": MAX_MSA_LEN,
            "abi_max_bytes": ABI_MAX_BYTES,
            "seqio_max_bytes": SEQIO_MAX_BYTES,
        },
        "external": {"ncbi": False, "reason": _NCBI_UNAVAILABLE},
    }


@router.post("/sequence/analyze")
async def sequence_analyze(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """核酸/蛋白序列一览：GC、互补链、转录、三框翻译与理化参数。

    ``frame``（1/2/3）用来指定"用哪个读框的翻译结果算蛋白参数"，
    其余读框的翻译照样全部返回，便于前端一次展示三条。
    """
    molecule = str(payload.get("molecule") or "dna").strip().lower()
    if molecule not in {"dna", "rna", "protein"}:
        raise HTTPException(status_code=400, detail="molecule 只能是 dna / rna / protein")
    frame = _int_field(payload, "frame", 1, lo=1, hi=3)

    if molecule == "protein":
        protein = _require_protein(payload.get("sequence"))
        return {
            "molecule": "protein",
            "length": len(protein),
            "gc": None,
            "reverse_complement": None,
            "complement": None,
            "transcribe": None,
            "translate": None,
            "frame": None,
            **_protein_params(protein),
        }

    nucleic = _require_nucleic(payload.get("sequence"), allow_rna=molecule == "rna")
    bios = Seq(nucleic)
    frames = _three_frame_translations(nucleic)
    translation = frames[f"+{frame}"]
    params = _protein_params_or_none(translation.rstrip("*")) or dict(EMPTY_PROTEIN_PARAMS)
    return {
        "molecule": molecule,
        "length": len(nucleic),
        "gc": _gc_percent(nucleic),
        "reverse_complement": str(bios.reverse_complement()),
        "complement": str(bios.complement()),
        # DNA 输入给转录产物（mRNA）；RNA 输入反过来给对应的 DNA 序列
        "transcribe": str(bios.back_transcribe()) if molecule == "rna" else str(bios.transcribe()),
        "translate": frames,
        "frame": frame,
        "protein": translation,
        **params,
    }


@router.post("/cds/extract")
async def cds_extract(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """提取编码序列并翻译。

    两种输入方式：
    * ``{record, feature_type?, ids?}``：从 GenBank/EMBL 的注释里取；
    * ``{sequence, start, end, strand, frame?}``：按坐标区间取（start/end 为 1 基闭区间）。
    命中为空时返回 200 + 空列表：筛选无结果不算错误。
    """
    if payload.get("record") is not None:
        return _extract_from_record(payload)
    if payload.get("sequence") is not None:
        return _extract_from_coordinates(payload)
    raise HTTPException(
        status_code=400,
        detail="需要提供 record（GenBank/EMBL 文本）或 sequence + start/end",
    )


def _feature_keys(record: Any, feature: Any, index: int) -> set[str]:
    """一条特征的可用标识集合（locus_tag / gene / label / product / 内部序号）。"""
    keys = {f"{record.id}:{index}", str(index)}
    for name in ("locus_tag", "gene", "label", "product", "protein_id"):
        for value in feature.qualifiers.get(name, []) or []:
            text = str(value).strip()
            if text:
                keys.add(text)
    return keys


def _extract_from_record(payload: dict[str, Any]) -> dict[str, Any]:
    text = _text_field(payload, "record", label="record")
    file_format = _sniff_format(text)
    if file_format == "fasta":
        raise HTTPException(status_code=400, detail="FASTA 没有特征注释，无法提取 CDS；请提供 GenBank 或 EMBL")
    records = _parse_records(text, file_format)
    feature_type = str(payload.get("feature_type") or "CDS").strip() or "CDS"
    wanted = {str(item).strip() for item in (payload.get("ids") or []) if str(item).strip()}

    items: list[dict[str, Any]] = []
    for record in records:
        for index, feature in enumerate(record.features):
            if feature.type.lower() != feature_type.lower():
                continue
            keys = _feature_keys(record, feature, index)
            if wanted and not (wanted & keys):
                continue
            items.append(_feature_item(record, feature, index))
    return {"feature_type": feature_type, "count": len(items), "items": items}


def _feature_item(record: Any, feature: Any, index: int) -> dict[str, Any]:
    """把一条 CDS 特征转成 {核酸, 蛋白} 结果项。"""
    raw = feature.extract(record.seq)
    table_id = int(str((feature.qualifiers.get("transl_table") or ["1"])[0]))
    frame = int(str((feature.qualifiers.get("codon_start") or ["1"])[0]))
    nucleic = str(raw)
    _codon_table(table_id)  # 编号不受支持时直接 400，不走下面的兜底
    try:
        protein = _translate_cds(nucleic, table=str(table_id), frame=frame)
    except ValueError:  # 含简并碱基或长度不是 3 的倍数：翻译不了，保留核酸即可
        protein = ""
    labels = [str((feature.qualifiers.get(key) or [""])[0]) for key in ("locus_tag", "gene", "label", "product")]
    return {
        "id": next((label for label in labels if label), f"{record.id}:{index}"),
        "record_id": record.id,
        "index": index,
        "feature_type": feature.type,
        "location": str(feature.location),
        "strand": feature.location.strand,
        "codon_start": frame,
        "transl_table": table_id,
        "length": len(nucleic),
        "sequence": nucleic,
        "protein": protein,
    }


def _extract_from_coordinates(payload: dict[str, Any]) -> dict[str, Any]:
    sequence = _require_nucleic(payload.get("sequence"))
    start = _int_field(payload, "start", 1, lo=1, hi=len(sequence))
    end = _int_field(payload, "end", len(sequence), lo=1, hi=len(sequence))
    if end < start:
        raise HTTPException(status_code=400, detail="end 不能小于 start（坐标按 1 基闭区间）")
    strand = str(payload.get("strand") or "+").strip()
    if strand not in {"+", "-", "1", "-1", "plus", "minus"}:
        raise HTTPException(status_code=400, detail="strand 只能是 + 或 -")
    frame = _int_field(payload, "frame", 1, lo=1, hi=3)
    table_id = _int_field(payload, "genetic_code", 1, lo=1, hi=33)

    region = sequence[start - 1 : end]
    if strand in {"-", "-1", "minus"}:
        region = str(Seq(region).reverse_complement())
    _codon_table(table_id)  # 先校验遗传密码表编号是否受支持
    protein = _translate_cds(region, table=str(table_id), frame=frame)
    return {
        "count": 1,
        "items": [
            {
                "id": f"{start}..{end}",
                "record_id": "",
                "index": 0,
                "feature_type": "region",
                "location": f"[{start - 1}:{end}]({'-' if strand.startswith('-') or strand == 'minus' else '+'})",
                "strand": -1 if strand.startswith("-") or strand == "minus" else 1,
                "codon_start": frame,
                "transl_table": table_id,
                "length": len(region),
                "sequence": region,
                "protein": protein,
            }
        ],
    }


@router.post("/format/convert")
async def format_convert(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """序列文件格式互转（GenBank / FASTA / EMBL）。

    逐条写出：某条记录写不出来时，报错会带上记录序号，用户不必逐个试。
    """
    source = str(payload.get("from") or "").strip().lower()
    target = str(payload.get("to") or "").strip().lower()
    supported = {"genbank", "fasta", "embl"}
    if source not in supported:
        raise HTTPException(status_code=400, detail="from 只能是 genbank / fasta / embl")
    if target not in supported:
        raise HTTPException(status_code=400, detail="to 只能是 genbank / fasta / embl")
    if source == target:
        raise HTTPException(status_code=400, detail="源格式与目标格式相同，无需转换")

    text = _text_field(payload, "text", label="text")
    records = _parse_records(text, source)
    warnings: list[str] = []
    buffer = io.StringIO()
    for position, record in enumerate(records, start=1):
        _prepare_record(record, target, warnings)
        try:
            SeqIO.write([record], buffer, target)
        except (ValueError, KeyError) as exc:
            raise HTTPException(
                status_code=400,
                detail=f"第 {position} 条记录（{record.id}）无法写成 {target}：{exc}",
            ) from exc
    return {
        "from": source,
        "to": target,
        "count": len(records),
        "ids": [record.id for record in records],
        "text": buffer.getvalue(),
        "warnings": warnings,
    }


# ---------------------------------------------------------------- 克隆相关


def _validated_enzymes(payload: dict[str, Any]) -> list[str]:
    """校验酶名清单：不传用常用酶；传了就必须每个都真实存在。"""
    raw = payload.get("enzymes")
    if raw is None or (isinstance(raw, list) and not raw):
        return list(COMMON_ENZYMES)
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail="enzymes 必须是酶名数组")
    names = [str(item).strip() for item in raw if str(item).strip()]
    if not names:
        return list(COMMON_ENZYMES)
    if len(names) > MAX_ENZYMES:
        raise HTTPException(status_code=400, detail=f"一次最多查询 {MAX_ENZYMES} 种酶")
    unknown = []
    for name in names:
        try:
            RestrictionBatch([name])
        except ValueError:
            unknown.append(name)
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"未知的限制酶：{'、'.join(unknown)}；可用酶见 GET /api/biotools/meta",
        )
    return names


@router.post("/restriction")
async def restriction_sites(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """限制酶切位点分析：全部位点、单切酶（unique cutter）与不切酶。

    位点按 Biopython Restriction 的约定给出：切点**右侧第一个碱基**的 1 基位置；
    环状质粒由 ``circular=true`` 打开跨零点搜索。
    """
    sequence = _require_nucleic(payload.get("sequence"))
    enzymes = _validated_enzymes(payload)
    circular = bool(payload.get("circular", False))
    batch = RestrictionBatch(enzymes)
    # Analysis.full() 的键是酶类对象而不是酶名，先按 str(enzyme) 建索引再查
    sites = {str(enzyme): positions for enzyme, positions in Analysis(batch, Seq(sequence), linear=not circular).full().items()}

    hits: list[dict[str, Any]] = []
    unique_cutters: list[str] = []
    non_cutters: list[str] = []
    for name in enzymes:
        positions = sorted(sites.get(name, []) or [])
        if not positions:
            non_cutters.append(name)
            continue
        if len(positions) == 1:
            unique_cutters.append(name)
        hits.append({"enzyme": name, "count": len(positions), "sites": positions})
    hits.sort(key=lambda item: (-item["count"], item["enzyme"]))
    return {
        "length": len(sequence),
        "circular": circular,
        "enzymes_checked": len(enzymes),
        "hits": hits,
        "unique_cutters": unique_cutters,
        "non_cutters": non_cutters,
    }


@router.post("/orf")
async def orf_find(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """六框 ORF 预测：以起始密码子开头、终止密码子结尾，长度 ≥ min_aa。

    只接受"有起始密码子"的完整 ORF——开放读框（无终止）在真核基因组里到处都是，
    全列出来对用户没有意义。``min_aa`` 缺省 30。
    """
    sequence = _require_nucleic(payload.get("sequence"))
    min_aa = _int_field(payload, "min_aa", 30, lo=1, hi=MAX_SEQUENCE_LEN)
    table_id = _int_field(payload, "genetic_code", 1, lo=1, hi=33)
    table = _codon_table(table_id)

    hits: list[dict[str, Any]] = []
    for strand, template in (("+", sequence), ("-", str(Seq(sequence).reverse_complement()))):
        for offset in range(3):
            for start_index, end_index in _orf_intervals(template, offset, table):
                codons = (end_index - start_index) // 3
                length_aa = codons - 1  # 末尾终止密码子不算残基
                if length_aa < min_aa:
                    continue
                protein = _translate_cds(template[start_index:end_index], table=str(table_id))
                hits.append(
                    {
                        "frame": f"{strand}{offset + 1}",
                        "strand": strand,
                        "start": _orf_position(strand, start_index, len(sequence), 0),
                        "end": _orf_position(strand, start_index, len(sequence), end_index - 1),
                        "length_aa": length_aa,
                        "length_nt": end_index - start_index,
                        "protein": protein,
                    }
                )
    hits.sort(key=lambda item: (item["start"], item["frame"]))
    return {
        "count": len(hits),
        "min_aa": min_aa,
        "genetic_code": table_id,
        "orfs": hits,
    }


def _orf_intervals(template: str, offset: int, table: CodonTable.CodonTable) -> list[tuple[int, int]]:
    """在单一读框里找 [(起点, 终点)] 区间：起点为起始密码子，终点为终止密码子之后。"""
    intervals: list[tuple[int, int]] = []
    position = offset
    while position + 3 <= len(template):
        if template[position : position + 3] not in table.start_codons:
            position += 3
            continue
        for cursor in range(position + 3, len(template) - 2, 3):
            if template[cursor : cursor + 3] in table.stop_codons:
                intervals.append((position, cursor + 3))
                position = cursor + 3
                break
        else:
            # 这个起点下游没有终止密码子：更靠后的起点同样没有，直接结束本框
            break
    return intervals


def _orf_position(strand: str, start_index: int, total: int, offset: int) -> int:
    """把某一链模板上的 0 基偏移换算回原始序列的 1 基坐标。"""
    if strand == "+":
        return start_index + offset + 1
    return total - (start_index + offset)


@router.post("/protein/params")
async def protein_params(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """蛋白理化参数（ProtParam）：分子量、等电点、GRAVY、芳香性等。"""
    protein = _require_protein(payload.get("sequence"))
    return {"length": len(protein), **_protein_params(protein)}


@router.post("/primer/tm")
async def primer_tm(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """引物解链温度（Tm）：Wallace / GC / 最近邻（SantaLucia 盐校正）。

    ``na_mM`` 是单价阳离子浓度（默认 50 mM）；``primer_mM`` 是引物浓度
    （默认 0.25 µM = 250 nM，按双链等量换算成 MeltingTemp 需要的 nM）。
    """
    primer = _require_nucleic(payload.get("sequence"), label="引物序列")
    method = str(payload.get("method") or "nn").strip().lower()
    if method not in {"wallace", "gc", "nn"}:
        raise HTTPException(status_code=400, detail="method 只能是 wallace / gc / nn")
    na_mm = _float_field(payload, "na_mM", 50.0, lo=1.0, hi=1000.0)
    primer_mm = _float_field(payload, "primer_mM", 0.25, lo=0.0001, hi=100.0)
    if len(primer) > 200:
        raise HTTPException(status_code=400, detail="引物长度超过 200 nt，Tm 计算不再适用")

    try:
        if method == "wallace":
            value = MeltingTemp.Tm_Wallace(primer)
        elif method == "gc":
            value = MeltingTemp.Tm_GC(primer, Na=cast(int, na_mm))
        else:
            value = MeltingTemp.Tm_NN(
                primer,
                dnac1=cast(int, primer_mm * 1e6),
                dnac2=cast(int, primer_mm * 1e6),
                Na=cast(int, na_mm),
                saltcorr=5,
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Tm 计算失败：{exc}") from exc
    return {
        "tm": _round(value, 2),
        "method": method,
        "length": len(primer),
        "gc": _gc_percent(primer),
        "na_mM": na_mm,
        "primer_mM": primer_mm,
        "note": "Wallace 规则只按 A/T 与 G/C 计数，仅适合 14 nt 以内的短引物"
        if method == "wallace"
        else "",
    }


@router.post("/primer/dilution")
async def primer_dilution(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """引物工作液配制：C1V1=C2V2，返回吸取体积与稀释液体积。

    ``mass_od`` 可选，传母液的 OD260 读数时附上质量浓度换算提示
    （ssDNA 约 33 µg/mL 每 1 OD），便于核对母液浓度是否自洽。
    """
    stock = _float_field(payload, "stock_um", 100.0, lo=1e-6, hi=1e7)
    working = _float_field(payload, "working_um", 10.0, lo=1e-6, hi=1e7)
    volume = _float_field(payload, "volume_ul", 100.0, lo=1e-3, hi=1e6)
    if working > stock:
        raise HTTPException(status_code=400, detail="工作液浓度不能高于母液浓度")

    take = round(working * volume / stock, 3)
    diluent = round(volume - take, 3)
    notes = [f"按 C1V1=C2V2：吸取 {take} µL 母液（{stock} µM），加稀释液 {diluent} µL 至 {volume} µL"]

    od = payload.get("mass_od")
    if od is not None and not (isinstance(od, str) and not od.strip()):
        od_value = _float_field(payload, "mass_od", 0.0, lo=0.0, hi=1000.0)
        mass_ug_per_ml = round(od_value * 33.0, 2)
        notes.append(
            f"OD260={od_value} 约合 {mass_ug_per_ml} µg/mL（引物按 ssDNA 33 µg/mL 估算）；"
            f"若母液标称 {stock} µM 与 OD 换算结果不符，请以实测浓度为准"
        )
    return {
        "take_ul": take,
        "diluent_ul": diluent,
        "total_ul": round(volume, 3),
        "stock_um": stock,
        "working_um": working,
        "note": "；".join(notes),
    }


@router.post("/vector/trim")
async def vector_trim(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """去掉测序读段两端的载体残留。

    只在载体片段**贴住读段首/尾**时才裁剪：内嵌的载体同源片段通常是真实插入
    片段的一部分（例如目的基因来自同一载体骨架），剪掉会破坏序列。
    """
    read = _require_nucleic(payload.get("read"), label="测序读段")
    vector = _require_nucleic(payload.get("vector"), label="载体序列")
    min_score = _float_field(payload, "min_score", 20.0, lo=0.0, hi=1e6)
    if len(read) > MAX_SEQUENCE_LEN or len(vector) > MAX_SEQUENCE_LEN:
        raise HTTPException(status_code=400, detail=f"读段与载体长度均需 ≤ {MAX_SEQUENCE_LEN}")

    aligner = _pairwise_aligner(mode="local", match=1.0, mismatch=-1.0, gap_open=-2.0, gap_extend=-1.0)
    try:
        alignment = aligner.align(vector, read)[0]
    except IndexError:
        raise HTTPException(status_code=400, detail="读段与载体没有可用的局部比对") from None
    read_row, vector_row = _alignment_strings(alignment)
    stats = _alignment_stats(read_row, vector_row)
    blocks = alignment.aligned[1]
    start = int(min(block[0] for block in blocks)) if len(blocks) else 0
    end = int(max(block[1] for block in blocks)) if len(blocks) else 0

    trimmed = read
    trimmed_region = {"start": 0, "end": 0}
    if _alignment_score(alignment) >= min_score and end > start:
        if start <= 5:  # 5' 端残留（允许 5 个碱基的比对噪声）
            trimmed = read[end:]
            trimmed_region = {"start": 0, "end": end}
        elif len(read) - end <= 5:  # 3' 端残留
            trimmed = read[:start]
            trimmed_region = {"start": start, "end": len(read)}
    return {
        "trimmed_sequence": trimmed,
        "trimmed": trimmed_region,
        "trimmed_length": trimmed_region["end"] - trimmed_region["start"],
        "remaining_length": len(trimmed),
        "score": _round(_alignment_score(alignment), 2),
        "identity": stats["identity"],
        "min_score": min_score,
        "matched_region": {"start": start, "end": end},
    }


# ---------------------------------------------------------------- 测序峰图


def _mott_trim(qualities: list[int]) -> tuple[int, int]:
    """Richard Mott 修剪算法的自实现版（Biopython 里是私有函数，故重写）。

    分数 = 0.05 − 10^(−Q/10)：低质量碱基为正分，累计分首次转正的碱基是
    左边界，累计分最高处是右边界。输入按 PHRED 质量给出。
    """
    if len(qualities) <= 20:
        return 0, len(qualities)
    scores = [0.05 - 10 ** (quality / -10.0) for quality in qualities]
    cumulative = [0.0]
    start = 0
    started = False
    for index in range(1, len(scores)):
        value = cumulative[-1] + scores[index]
        cumulative.append(0.0 if value < 0 else value)
        if not started and cumulative[-1] > 0:
            start = index
            started = True
    end = cumulative.index(max(cumulative))
    if end <= start:
        return 0, len(qualities)
    return start, end


@router.post("/abi/parse")
async def abi_parse(
    file: UploadFile = File(..., description="ABI 测序峰图（.ab1）"),
    _: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    """解析 ABI 峰图：碱基序列、平均质量、Mott 裁剪区间与质量抽样点。

    上限 1 MB：.ab1 里含四个通道的原始荧光值，正常文件也在几十到几百 KB。
    """
    raw = await read_upload_capped(file, ABI_MAX_BYTES, message="峰图文件超过 1 MB 上限")
    if not raw:
        raise HTTPException(status_code=400, detail="文件内容为空")
    if not raw.startswith(b"ABIF"):
        raise HTTPException(status_code=400, detail="不是 ABI 峰图文件（应以 ABIF 标识开头）")
    try:
        records = list(SeqIO.parse(io.BytesIO(raw), "abi"))
    except (ValueError, KeyError, IndexError) as exc:
        raise HTTPException(status_code=400, detail=f"ABI 文件解析失败：{exc}") from exc
    if not records:
        raise HTTPException(status_code=400, detail="ABI 文件里没有可读的序列记录")

    record = records[0]
    sequence = str(record.seq)
    qualities = [int(value) for value in record.letter_annotations.get("phred_quality", [])]
    start, end = _mott_trim(qualities)
    step = max(1, math.ceil(len(qualities) / QUALITY_SAMPLE_POINTS)) if qualities else 1
    return {
        "length": len(sequence),
        "mean_quality": _round(sum(qualities) / len(qualities), 2) if qualities else None,
        "trimmed": {"start": start, "end": end, "length": max(0, end - start)},
        "quality": [[index + 1, qualities[index]] for index in range(0, len(qualities), step)],
        "sequence": sequence,
    }


# ---------------------------------------------------------------- 序列文件筛选


@router.post("/seqio/filter")
async def seqio_filter(
    file: UploadFile = File(..., description="FASTA 或 GenBank/EMBL 序列文件"),
    min_len: int | None = Query(default=None, ge=1),
    max_len: int | None = Query(default=None, ge=1),
    min_gc: float | None = Query(default=None, ge=0, le=100),
    max_gc: float | None = Query(default=None, ge=0, le=100),
    id_pattern: str = Query(default="", max_length=200),
    _: dict[str, Any] = Depends(require_user),
    __: None = Depends(require_csrf),
) -> dict[str, Any]:
    """按长度 / GC / 名称正则筛选序列记录（上限 20 MB）。

    格式按内容自动识别；条件取交集，全部满足才保留。
    """
    if min_len is not None and max_len is not None and max_len < min_len:
        raise HTTPException(status_code=400, detail="max_len 不能小于 min_len")
    if min_gc is not None and max_gc is not None and max_gc < min_gc:
        raise HTTPException(status_code=400, detail="max_gc 不能小于 min_gc")
    pattern = None
    if id_pattern.strip():
        try:
            pattern = re.compile(id_pattern.strip())
        except re.error as exc:
            raise HTTPException(status_code=400, detail=f"id_pattern 不是合法正则：{exc}") from exc

    raw = await read_upload_capped(file, SEQIO_MAX_BYTES, message="序列文件超过 20 MB 上限")
    if not raw:
        raise HTTPException(status_code=400, detail="文件内容为空")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    file_format = _sniff_format(text)
    records = _parse_records(text, file_format)

    kept: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for record in records:
        sequence = str(record.seq).upper()
        stats = {"id": record.id, "length": len(sequence), "gc": _gc_percent(sequence)}
        if not _keep_record(record, stats, min_len, max_len, min_gc, max_gc, pattern):
            dropped.append(stats)
            continue
        kept.append(stats)
    return {
        "format": file_format,
        "total": len(records),
        "kept": len(kept),
        "dropped": len(dropped),
        "ids": [item["id"] for item in kept],
        "dropped_ids": [item["id"] for item in dropped],
        "records": kept,
    }


def _keep_record(
    record: Any,
    stats: dict[str, Any],
    min_len: int | None,
    max_len: int | None,
    min_gc: float | None,
    max_gc: float | None,
    pattern: re.Pattern[str] | None,
) -> bool:
    """单条记录的筛选判定（长度、GC、名称正则三项取交集）。"""
    if min_len is not None and stats["length"] < min_len:
        return False
    if max_len is not None and stats["length"] > max_len:
        return False
    if min_gc is not None and stats["gc"] < min_gc:
        return False
    if max_gc is not None and stats["gc"] > max_gc:
        return False
    if pattern is not None:
        text = f"{record.id} {record.description}"
        if not pattern.search(text):
            return False
    return True


# ---------------------------------------------------------------- 质粒图谱


@router.post("/plasmid/map")
async def plasmid_map(
    payload: dict[str, Any] = Body(default_factory=dict),
    format: str = Query(default="png", description="png 或 svg"),
    _: dict[str, Any] = Depends(require_user),
) -> Response:
    """按 GenBank 注释画质粒图谱，直接把图片字节流回前端（不落盘）。

    图片在内存里生成：图谱是一次性预览，写到磁盘只会留下没人清理的临时文件。
    """
    render_format = format.strip().lower()
    if render_format not in {"png", "svg"}:
        raise HTTPException(status_code=400, detail="format 只能是 png 或 svg")
    text = _text_field(payload, "record", label="record")
    file_format = _sniff_format(text)
    if file_format == "fasta":
        raise HTTPException(status_code=400, detail="FASTA 没有特征注释，无法画图谱；请提供 GenBank")
    topology = str(payload.get("topology") or "circular").strip().lower()
    if topology not in {"circular", "linear"}:
        raise HTTPException(status_code=400, detail="topology 只能是 circular 或 linear")
    title = str(payload.get("title") or "").strip()[:120]
    records = _parse_records(text, file_format)

    # 绘图依赖（matplotlib / dna_features_viewer）只在画图时才需要，
    # 放函数内导入可以避免每次导入 app.main 都拖上一个绘图栈。
    import matplotlib.pyplot as plt
    from dna_features_viewer import (
        BiopythonTranslator,
        CircularGraphicRecord,
        GraphicRecord,
    )

    record = records[0]
    try:
        translated = BiopythonTranslator().translate_record(record)
        length = len(record.seq)
        graphic = (
            CircularGraphicRecord(sequence_length=length, features=translated.features)
            if topology == "circular"
            else GraphicRecord(sequence_length=length, features=translated.features)
        )
        axes: Any = graphic.plot(figure_width=8)[0]
        if title:
            axes.set_title(title)
        buffer = io.BytesIO()
        axes.figure.savefig(buffer, format=render_format, bbox_inches="tight")
    except (ValueError, KeyError, IndexError) as exc:
        raise HTTPException(status_code=400, detail=f"配置文件无法绘制图谱：{exc}") from exc
    finally:
        plt.close("all")
    media_type = "image/png" if render_format == "png" else "image/svg+xml"
    return Response(
        content=buffer.getvalue(),
        media_type=media_type,
        headers={"Cache-Control": "no-store"},
    )


# ---------------------------------------------------------------- 比对


@router.post("/align/pairwise")
async def align_pairwise(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """双序列比对（全局 / 局部 / 半全局）。

    半全局（semiglobal）用 ``end_gap_score=0`` 实现：一条序列完整、另一条可
    悬在两端之外，适合"引物/片段在参考序列里找位置"。
    """
    query = _clean_sequence(payload.get("query"), "query 序列")
    reference = _clean_sequence(payload.get("reference"), "reference 序列")
    for label, sequence in (("query", query), ("reference", reference)):
        if len(sequence) > MAX_PAIRWISE_LEN:
            raise HTTPException(
                status_code=400,
                detail=f"{label} 序列过长（上限 {MAX_PAIRWISE_LEN} nt），请先裁剪后再比对",
            )
    mode = str(payload.get("mode") or "global").strip().lower()
    raw_scoring = payload.get("scoring")
    scoring: dict[str, Any] = raw_scoring if isinstance(raw_scoring, dict) else {}
    aligner = _pairwise_aligner(
        mode=mode,
        match=_float_field(scoring, "match", 2.0, lo=-100.0, hi=100.0),
        mismatch=_float_field(scoring, "mismatch", -1.0, lo=-100.0, hi=100.0),
        gap_open=_float_field(scoring, "gap_open", -5.0, lo=-100.0, hi=0.0),
        gap_extend=_float_field(scoring, "gap_extend", -2.0, lo=-100.0, hi=0.0),
    )
    try:
        alignment = aligner.align(reference, query)[0]
    except IndexError:
        raise HTTPException(status_code=400, detail="两条序列之间没有可用的比对结果") from None

    reference_row, query_row = _alignment_strings(alignment)
    stats = _alignment_stats(query_row, reference_row)
    match_line = _match_line(query_row, reference_row)
    return {
        "mode": mode,
        "score": _round(_alignment_score(alignment), 2),
        "identity": stats["identity"],
        "matches": stats["matches"],
        "alignment_length": len(reference_row),
        "gap_columns": stats["gap_columns"],
        "query_aligned": query_row,
        "reference_aligned": reference_row,
        "match_line": match_line,
        "alignment": f"query     {query_row}\n          {match_line}\nreference {reference_row}",
    }


@router.post("/align/multiple")
async def align_multiple(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """多序列比对：以最长序列为参考的**渐进星型比对**。

    注意：这是星型渐进比对，不是 MSA 最优解。做法是把每条序列单独与参考序列
    做全局双序列比对，再把各自的空位投影到参考坐标系上合并成等长矩阵。
    优点是 O(N) 次双序列比对、实现简单可解释；代价是序列之间从不当面比对，
    所以当序列两两差异较大（一致度 < 70%）时，结果会明显劣于 Clustal/MAFFT
    一类真正的最优化算法——那种场景请用专门的比对服务。
    """
    raw = payload.get("sequences")
    if not isinstance(raw, list) or not raw:
        raise HTTPException(status_code=400, detail="sequences 必须是非空字符串数组")
    if len(raw) < 2:
        raise HTTPException(status_code=400, detail="至少需要 2 条序列才能比对")
    if len(raw) > MAX_MSA_SEQUENCES:
        raise HTTPException(status_code=400, detail=f"一次最多比对 {MAX_MSA_SEQUENCES} 条序列")
    sequences = [_clean_sequence(item, f"第 {index + 1} 条序列") for index, item in enumerate(raw)]
    for index, sequence in enumerate(sequences, start=1):
        if len(sequence) > MAX_MSA_LEN:
            raise HTTPException(
                status_code=400,
                detail=f"第 {index} 条序列过长（上限 {MAX_MSA_LEN} nt）",
            )

    reference_index, aligned = _star_alignment(sequences)
    columns = list(zip(*aligned, strict=True))
    consensus = "".join(_consensus_column(column) for column in columns)
    return {
        "reference_index": reference_index,
        "aligned": aligned,
        "consensus": consensus,
        "identity_matrix": _identity_matrix(aligned),
        "alignment_length": len(aligned[0]),
        "method": "progressive-star",
    }


def _star_alignment(sequences: list[str]) -> tuple[int, list[str]]:
    """星型渐进比对的主体：参考序列 + 每条序列的空位投影。

    返回 (参考序列下标, 等长比对行)。空位插入点的列宽取"该点最长插入"，
    其余行在左侧补 '-'，保证所有行等长且插入内容不被截断。
    """
    reference_index = max(range(len(sequences)), key=lambda index: len(sequences[index]))
    reference = sequences[reference_index]
    aligner = _pairwise_aligner(mode="global", match=2.0, mismatch=-1.0, gap_open=-5.0, gap_extend=-2.0)

    projected: list[tuple[dict[int, str], dict[int, str]]] = []
    widths: dict[int, int] = {}
    for index, sequence in enumerate(sequences):
        if index == reference_index:
            projected.append((dict(enumerate(reference)), {}))
            continue
        alignment = aligner.align(reference, sequence)[0]
        reference_row, sequence_row = _alignment_strings(alignment)
        aligned_at, inserted = _project_alignment(reference_row, sequence_row)
        projected.append((aligned_at, inserted))
        for position, chunk in inserted.items():
            widths[position] = max(widths.get(position, 0), len(chunk))

    rows = [_render_row(reference, aligned_at, inserted, widths) for aligned_at, inserted in projected]
    return reference_index, rows


def _project_alignment(reference_row: str, sequence_row: str) -> tuple[dict[int, str], dict[int, str]]:
    """把一条比对行投影到参考坐标。

    返回 (参考位置→该行字符, 参考位置→插在该位置之前的残基)。
    参考行里的 '-' 表示该序列在这里有额外残基（插入），需要额外列来承载。
    """
    aligned_at: dict[int, str] = {}
    inserted: dict[int, str] = {}
    position = 0
    for reference_base, sequence_base in zip(reference_row, sequence_row, strict=True):
        if reference_base == "-":
            inserted[position] = inserted.get(position, "") + ("" if sequence_base == "-" else sequence_base)
            continue
        aligned_at[position] = sequence_base
        position += 1
    return aligned_at, inserted


def _render_row(
    reference: str,
    aligned_at: dict[int, str],
    inserted: dict[int, str],
    widths: dict[int, int],
) -> str:
    """按参考坐标系渲染一行，插入列在参考碱基之前输出。"""
    buffer: list[str] = []
    for position in range(len(reference) + 1):
        width = widths.get(position)
        if width:
            chunk = inserted.get(position, "")
            buffer.append("-" * (width - len(chunk)) + chunk)
        if position < len(reference):
            buffer.append(aligned_at.get(position, "-"))
    return "".join(buffer)


def _consensus_column(column: tuple[str, ...]) -> str:
    """单列的一致字符：出现最多的非空位字符；全空位记 '-'。"""
    letters = [base for base in column if base != "-"]
    if not letters:
        return "-"
    return max(set(letters), key=lambda base: (letters.count(base), base))


def _identity_matrix(aligned: list[str]) -> list[list[float]]:
    """比对后各行两两一致度（对称矩阵，对角线 1.0）。"""
    size = len(aligned)
    matrix = [[1.0] * size for _ in range(size)]
    for first in range(size):
        for second in range(first + 1, size):
            value = _alignment_stats(aligned[first], aligned[second])["identity"]
            matrix[first][second] = value
            matrix[second][first] = value
    return matrix


# ---------------------------------------------------------------- 进化


def _distance_matrix_from_sequences(sequences: list[str]) -> tuple[list[str], list[list[float]]]:
    """按"1 − 一致度"构造距离矩阵。"""
    size = len(sequences)
    matrix = [[0.0] * size for _ in range(size)]
    for first in range(size):
        for second in range(first + 1, size):
            distance = 1.0 - _identity_between(sequences[first], sequences[second])
            matrix[first][second] = _round(max(0.0, distance), 4)
            matrix[second][first] = matrix[first][second]
    return [f"seq{index + 1}" for index in range(size)], matrix


def _validated_matrix(payload: dict[str, Any]) -> tuple[list[str], list[list[float]]]:
    """校验用户给的距离矩阵：方阵、对称、非负。"""
    raw = payload.get("matrix")
    if not isinstance(raw, list) or not raw:
        raise HTTPException(status_code=400, detail="matrix 必须是非空的二维数字数组")
    matrix: list[list[float]] = []
    for row_index, row in enumerate(raw, start=1):
        if not isinstance(row, list) or len(row) != len(raw):
            raise HTTPException(status_code=400, detail=f"matrix 第 {row_index} 行长度与行数不一致（必须是方阵）")
        values: list[float] = []
        for value in row:
            try:
                number = float(value)
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=400, detail=f"matrix 第 {row_index} 行含非数字") from exc
            if number < 0:
                raise HTTPException(status_code=400, detail="距离矩阵不能有负数")
            values.append(_round(number, 6))
        matrix.append(values)
    for first in range(len(matrix)):
        for second in range(first + 1, len(matrix)):
            if abs(matrix[first][second] - matrix[second][first]) > 1e-6:
                raise HTTPException(status_code=400, detail="距离矩阵必须对称")
    ids = payload.get("ids")
    if isinstance(ids, list) and ids:
        labels = [str(item) for item in ids]
        if len(labels) != len(matrix):
            raise HTTPException(status_code=400, detail="ids 数量必须与矩阵维度一致")
        return labels, matrix
    return [f"s{index + 1}" for index in range(len(matrix))], matrix


@router.post("/phylo/nj")
async def phylo_nj(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """邻接法（NJ）建树：从序列算一致度距离，或直接用给定距离矩阵。

    scikit-bio 的 ``nj`` 需要 DistanceMatrix（带样本名），因此矩阵与样本名一起返回，
    前端可以直接画热图再和 Newick 对照。
    """
    if payload.get("matrix") is not None:
        ids, matrix = _validated_matrix(payload)
    elif payload.get("sequences") is not None:
        raw = payload.get("sequences")
        if not isinstance(raw, list) or len(raw) < 3:
            raise HTTPException(status_code=400, detail="sequences 至少需要 3 条才能建树")
        if len(raw) > MAX_MSA_SEQUENCES:
            raise HTTPException(status_code=400, detail=f"一次最多 {MAX_MSA_SEQUENCES} 条序列")
        sequences = [_clean_sequence(item, f"第 {index + 1} 条序列") for index, item in enumerate(raw)]
        for index, sequence in enumerate(sequences, start=1):
            if len(sequence) > MAX_PAIRWISE_LEN:
                raise HTTPException(status_code=400, detail=f"第 {index} 条序列过长（上限 {MAX_PAIRWISE_LEN} nt）")
        ids, matrix = _distance_matrix_from_sequences(sequences)
    else:
        raise HTTPException(status_code=400, detail="需要提供 sequences 或 matrix")

    # scikit-bio 只在建树这一处用到，函数内导入避免拖慢门户启动
    from skbio import DistanceMatrix
    from skbio.tree import nj

    try:
        tree: Any = nj(DistanceMatrix(matrix, ids=ids))
    except (ValueError, IndexError) as exc:
        raise HTTPException(status_code=400, detail=f"建树失败：{exc}") from exc
    buffer = io.StringIO()
    tree.write(file=buffer, format="newick")
    return {"ids": ids, "matrix": matrix, "newick": buffer.getvalue().strip()}


@router.post("/phylo/convert")
async def phylo_convert(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """Newick → ASCII 树形图 + 嵌套 JSON（前端可拿去画交互式树）。"""
    newick = _text_field(payload, "newick", label="newick")
    if len(newick) > MAX_TREE_CHARS:
        raise HTTPException(status_code=400, detail=f"Newick 文本过长（上限 {MAX_TREE_CHARS} 字符）")
    from skbio import TreeNode
    from skbio.io import FileFormatError

    try:
        tree: Any = TreeNode.read(
            io.StringIO(newick if newick.rstrip().endswith(";") else f"{newick};")
        )
    except (ValueError, TypeError, FileFormatError) as exc:
        raise HTTPException(status_code=400, detail=f"Newick 解析失败：{exc}") from exc
    return {"ascii": tree.ascii_art(), "json": _node_to_dict(tree)}


def _node_to_dict(node: Any) -> dict[str, Any]:
    """树节点 → {name, length, support, children}，长度统一转成浮点。"""
    length = getattr(node, "length", None)
    support = getattr(node, "support", None)
    return {
        "name": node.name,
        "length": None if length is None else _round(float(length), 6),
        "support": None if support is None else _round(float(support), 6),
        "children": [_node_to_dict(child) for child in node.children],
    }


@router.post("/diversity/pcoa")
async def diversity_pcoa(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """主坐标分析（PCoA）：对称距离矩阵 → 坐标 + 各轴解释度 + 样本名。"""
    ids, matrix = _validated_matrix(payload)
    from skbio import DistanceMatrix
    from skbio.stats.ordination import pcoa

    try:
        result = pcoa(DistanceMatrix(matrix, ids=ids))
    except (ValueError, IndexError) as exc:
        raise HTTPException(status_code=400, detail=f"PCoA 失败：{exc}") from exc
    axes = [str(column) for column in result.samples.columns]
    return {
        "ids": ids,
        "axes": axes,
        "coordinates": [[_round(float(value), 6) for value in row] for row in result.samples.to_numpy()],
        "proportion_explained": [_round(float(value), 6) for value in result.proportion_explained],
    }


# ---------------------------------------------------------------- GC 曲线


@router.post("/gc/window")
async def gc_window(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """滑动窗口 GC 曲线 + k-mer 频次。

    窗口起点是 1 基坐标（与序列查看器一致）；k-mer 频次只返回出现最多的前
    ``MAX_KMER_ENTRIES`` 个，避免 8-mer 这种高维词表把响应撑爆。
    """
    sequence = _require_nucleic(payload.get("sequence"))
    window = _int_field(payload, "window", 50, lo=1, hi=MAX_SEQUENCE_LEN)
    step = _int_field(payload, "step", 10, lo=1, hi=MAX_SEQUENCE_LEN)
    k = _int_field(payload, "k", 4, lo=1, hi=8)
    if window > len(sequence):
        raise HTTPException(status_code=400, detail=f"窗口长度 {window} 大于序列长度 {len(sequence)}")

    points = [
        [start + 1, _gc_percent(sequence[start : start + window])]
        for start in range(0, len(sequence) - window + 1, step)
    ]
    counts: dict[str, int] = {}
    for start in range(len(sequence) - k + 1):
        kmer = sequence[start : start + k]
        counts[kmer] = counts.get(kmer, 0) + 1
    top = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:MAX_KMER_ENTRIES]
    return {
        "length": len(sequence),
        "window": window,
        "step": step,
        "gc_points": points,
        "kmer_k": k,
        "kmer_frequencies": dict(top),
        "kmer_truncated": len(counts) > MAX_KMER_ENTRIES,
    }


# ---------------------------------------------------------------- 三字母码


_CODE3_TO_CODE1: dict[str, str] = {**protein_letters_3to1_extended, "Ter": "*", "Xxx": "X"}
"""三字母码表：IUPAC 扩展表 + 终止符 Ter / 未知残基 Xxx（seq1 认不出这两种）。"""


@router.post("/seq3/convert")
async def seq3_convert(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """氨基酸单字母 ↔ 三字母互转，可选专利序列表排版。

    专利排版（``group_per_line=true``）按残基逐个分组、每行不超过 60 字符并带行首
    编号；``patent_offset`` 让第一个残基的显示编号为 1+offset，用来对齐专利文件
    里"序列从第 0/1/2 位起算"的不同口径。
    """
    direction = str(payload.get("direction") or "1to3").strip().lower()
    if direction not in {"1to3", "3to1"}:
        raise HTTPException(status_code=400, detail="direction 只能是 1to3 或 3to1")
    patent_offset = _int_field(payload, "patent_offset", 0, lo=0, hi=2)
    group_per_line = bool(payload.get("group_per_line", False))

    if direction == "1to3":
        sequence = _clean_sequence(payload.get("sequence"), "氨基酸序列")
        bad = sorted({ch for ch in sequence if ch not in PROTEIN_LETTERS and ch not in STOP_CODON_MARKS})
        if bad:
            raise HTTPException(
                status_code=400,
                detail=f"氨基酸序列含非法字符：{'、'.join(bad)}（只允许 20 种标准氨基酸与 *）",
            )
        codes = [seq3(base) for base in sequence]
        text = _patent_layout(codes, patent_offset) if group_per_line else " ".join(codes)
        return {
            "direction": direction,
            "residues": len(codes),
            "codes": codes,
            "text": text,
            "group_per_line": group_per_line,
            "patent_offset": patent_offset,
        }

    tokens = _three_letter_tokens(payload.get("sequence"))
    unknown = sorted({token for token in tokens if token not in _CODE3_TO_CODE1})
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"无法识别的三字母码：{'、'.join(unknown[:10])}（应形如 Met / Glu / Ter）",
        )
    single = seq1("".join(tokens), custom_map=_CODE3_TO_CODE1)
    return {
        "direction": direction,
        "residues": len(tokens),
        "codes": tokens,
        "text": single,
        "group_per_line": False,
        "patent_offset": patent_offset,
    }


def _three_letter_tokens(raw: Any) -> list[str]:
    """把三字母码输入切成 token，兼容空格分隔与连续写法。"""
    text = "" if raw is None else str(raw)
    # 数字是行号/序号，先去掉；剩下按空白切，没有空白就按 3 字符切
    cleaned = _WHITESPACE_OR_DIGITS.sub(" ", text).strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="三字母码序列不能为空")
    parts = cleaned.split()
    if len(parts) == 1:
        token = parts[0]
        if len(token) % 3 != 0:
            raise HTTPException(status_code=400, detail="连续写法的三字母码长度必须是 3 的倍数")
        parts = [token[index : index + 3] for index in range(0, len(token), 3)]
    return [part[:1].upper() + part[1:].lower() for part in parts]


def _patent_layout(codes: list[str], offset: int) -> str:
    """专利序列表排版：每行不超过 60 字符，行首带 1+offset 起的残基编号。"""
    lines: list[str] = []
    current: list[str] = []
    line_start = 1
    for index, code in enumerate(codes):
        candidate = " ".join([*current, code])
        if len(f"{line_start:>6} {candidate}") > 60 and current:
            lines.append(f"{line_start:>6} {' '.join(current)}")
            current = [code]
            line_start = index + 1 + offset
            continue
        current.append(code)
    if current:
        lines.append(f"{line_start:>6} {' '.join(current)}")
    return "\n".join(lines)


# ---------------------------------------------------------------- NCBI（外网）


def _probe_ncbi() -> None:
    """3 秒探活：连不上 NCBI 立刻失败。

    用 socket 直接探 TCP，而不是依赖 urllib：Bio.Entrez 底层没有超时参数，
    外网被墙时请求会一直挂着，把容器里的事件循环占死。
    """
    try:
        socket.create_connection((_NCBI_HOST, 443), timeout=_NCBI_CONNECT_TIMEOUT).close()
    except OSError as exc:
        raise HTTPException(status_code=503, detail=_NCBI_UNAVAILABLE) from exc


async def _ncbi_call(
    function: Any,
    *args: Any,
    total_timeout: float = _NCBI_TOTAL_TIMEOUT,
    **kwargs: Any,
) -> Any:
    """在线程里执行阻塞的 NCBI 调用，并把一切失败统一成 503 + 中文提示。

    后端进程是单事件循环，NCBI 调用必须丢进线程；即便探活通过，
    线程里的请求仍可能卡住，因此外层再套一个整体超时兜底。
    """

    def run() -> Any:
        _probe_ncbi()
        return function(*args, **kwargs)

    try:
        return await asyncio.wait_for(asyncio.to_thread(run), timeout=total_timeout)
    # 外网不可用的表现五花八门（DNS / 超时 / TLS / HTTP 错误），统一收成 503 + 中文提示
    except Exception as exc:
        raise HTTPException(status_code=503, detail=_NCBI_UNAVAILABLE) from exc


@router.get("/entrez/search")
async def entrez_search(
    db: str = Query(default="nuccore", max_length=40),
    term: str = Query(..., min_length=1, max_length=200),
    retmax: int = Query(default=20, ge=1, le=200),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """NCBI Entrez 检索（需要外网；当前环境返回 503 + 中文提示）。"""
    from Bio import Entrez

    Entrez.email = _NCBI_EMAIL
    with await _ncbi_call(Entrez.esearch, db=db, term=term, retmax=retmax) as handle:
        result: Any = await asyncio.to_thread(Entrez.read, handle)
    return {
        "db": db,
        "term": term,
        "count": int(result.get("Count", 0) or 0),
        "ids": [str(item) for item in result.get("IdList", [])],
    }


@router.post("/entrez/fetch")
async def entrez_fetch(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """按登录号取记录文本（GenBank/FASTA）；需要外网。"""
    from Bio import Entrez

    db = str(payload.get("db") or "nuccore").strip()
    raw_ids = payload.get("ids")
    if not isinstance(raw_ids, list) or not raw_ids:
        raise HTTPException(status_code=400, detail="ids 必须是非空字符串数组")
    ids = [str(item).strip() for item in raw_ids if str(item).strip()]
    if len(ids) > 50:
        raise HTTPException(status_code=400, detail="一次最多取 50 条记录")
    rettype = str(payload.get("rettype") or "gb").strip()[:16]
    Entrez.email = _NCBI_EMAIL
    handle = await _ncbi_call(Entrez.efetch, db=db, id=",".join(ids), rettype=rettype, retmode="text")
    text = await asyncio.to_thread(handle.read)
    return {"db": db, "ids": ids, "rettype": rettype, "text": str(text)[:200_000]}


@router.post("/blast")
async def blast(
    payload: dict[str, Any] = Body(default_factory=dict),
    _: dict[str, Any] = Depends(require_user),
) -> dict[str, Any]:
    """远程 BLAST（需要外网）：返回前 20 条命中及最优 HSP 的统计量。"""
    from Bio.Blast import NCBIWWW, NCBIXML

    program = str(payload.get("program") or "blastn").strip().lower()
    if program not in {"blastn", "blastp", "blastx", "tblastn", "tblastx"}:
        raise HTTPException(status_code=400, detail="program 只能是 blastn/blastp/blastx/tblastn/tblastx")
    if program == "blastp":
        sequence = _require_protein(payload.get("sequence"))
    else:
        sequence = _clean_sequence(payload.get("sequence"))
        bad = sorted({letter for letter in sequence if letter not in (DNA_LETTERS | RNA_LETTERS)})
        if bad:
            raise HTTPException(status_code=400, detail=f"序列含非法字符：{'、'.join(bad)}（只允许 ACGTUN 及简并碱基）")
    if len(sequence) < 10:
        raise HTTPException(status_code=400, detail="BLAST 序列至少 10 nt")
    database = str(payload.get("database") or "nt").strip()[:32]

    handle = await _ncbi_call(
        NCBIWWW.qblast,
        program,
        database,
        sequence,
        total_timeout=_NCBI_BLAST_TIMEOUT,
    )
    xml_text = await asyncio.to_thread(handle.read)
    record = await asyncio.to_thread(NCBIXML.read, io.StringIO(xml_text))
    hits = []
    for alignment in list(getattr(record, "alignments", []))[:20]:
        hsp = alignment.hsps[0] if alignment.hsps else None
        hits.append(
            {
                "id": alignment.hit_id,
                "title": alignment.title[:200],
                "length": alignment.length,
                "evalue": hsp.expect if hsp else None,
                "score": hsp.score if hsp else None,
                "identity": _round(hsp.identities / hsp.align_length, 4) if hsp and hsp.align_length else None,
            }
        )
    return {"program": program, "database": database, "hits": hits, "count": len(hits)}
