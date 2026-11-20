"""统一生信工具后端（/api/biotools）的契约测试。

覆盖三类东西：
* 正常路径的**数值**正确性（GC、酶切位点、ORF 坐标、C1V1=C2V2、Mott 裁剪）；
* 错误路径的中文报错（非法字符、空输入、未知格式、未知酶、过大上传）；
* 外网端点（Entrez / BLAST）在无外网时的快速失败（503 + 固定提示）。
"""
from __future__ import annotations

import struct
import time

import jwt
import pytest
from fastapi.testclient import TestClient

from app import biotools as biotools_mod
from app import biotools_service
from app.config import settings

# 39 bp，含一个完整的 CDS（ATG…TAA）与一个 EcoRI 位点
PLASMID = "ATGGCCATTGTAATGGGCCGCTGAAAGGGTGCCCGATAGTAA" + "GAATTC" + "GATCGATCGATCGACTAGCTAG"


def _genbank(sequence: str, *, name: str = "pTEST", topology: str = "linear", features: str = "") -> str:
    """拼一条最小可用的 GenBank 文本（长度按实际序列算，避免解析器长度告警）。"""
    origin = "\n".join(
        f"{start + 1:>9} {sequence[start : start + 60].lower()}" for start in range(0, len(sequence), 60)
    )
    # LOCUS 行的列位是固定的（长度右对齐到第 29 列、分子类型右对齐到第 41 列），
    # 排不齐时 Biopython 会给出 malformed locus 告警，测试里应当保持干净。
    locus = (
        f"LOCUS       {name}"
        f"{len(sequence):>{29 - 12 - len(name)}}"
        " bp "
        f"{'DNA':>6}    "
        f"{topology:<10}"
        "SYN 01-JAN-2025"
    )
    return (
        f"{locus}\n"
        f"DEFINITION  {name} test record.\n"
        "FEATURES             Location/Qualifiers\n"
        f"{features}"
        f"ORIGIN\n{origin}\n//\n"
    )


def _synth_ab1(sequence: str, qualities: list[int]) -> bytes:
    """合成一个最小 ABIF 文件：只有 PBAS2（碱基）与 PCON2（质量）两个 tag。"""
    entries = [("PBAS", 2, 2, sequence.encode()), ("PCON", 2, 2, bytes(qualities))]
    directory_size = 28 * len(entries)
    header_size = 4 + struct.calcsize(">H4sI2H3I")
    payload = b""
    directory = b""
    for tag_name, tag_number, element_type, data in entries:
        offset = header_size + directory_size + len(payload)
        payload += data
        directory += struct.pack(
            ">4sI2H4I", tag_name.encode(), tag_number, element_type, 1, len(data), len(data), offset, 0
        )
    header = struct.pack(
        ">H4sI2H3I", 101, b"tdir", 1023, 1023, 28, len(entries), directory_size, header_size
    )
    return b"ABIF" + header + directory + payload


@pytest.fixture()
def client() -> TestClient:
    # 端点现在跑在独立的 biotools 服务里（biotools_service），不是门户后端的 router：
    # 门户侧只剩一个代理，代理层的鉴权与转发在 tests/test_biotools_proxy.py 里测。
    return TestClient(biotools_service.app)


@pytest.fixture()
def auth() -> dict[str, str]:
    """Bearer 方式带会话：与内部服务同款，CSRF 双提交对 Bearer 豁免。"""
    token = jwt.encode(
        {
            "sub": "u1",
            "email": "a@b.c",
            "name": "木林森",
            "roles": ["lab-admin"],
            "exp": int(time.time()) + 3600,
        },
        settings.session_secret,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def _post(client: TestClient, auth: dict[str, str], path: str, payload: dict) -> dict:
    response = client.post(f"/api/biotools{path}", headers=auth, json=payload)
    assert response.status_code == 200, response.text
    return response.json()


# ---------------------------------------------------------------- 能力清单 / 鉴权


def test_meta_lists_capabilities(client: TestClient, auth: dict[str, str]) -> None:
    response = client.get("/api/biotools/meta", headers=auth)
    assert response.status_code == 200, response.text
    body = response.json()
    ids = {item["id"] for item in body["items"]}
    assert {"sequence_analyze", "restriction", "abi_parse", "blast"} <= ids
    # 每项都要有中文名、分组与输入类型，前端据此渲染卡片
    for item in body["items"]:
        assert item["name"] and item["group"] and item["inputs"]
    assert "EcoRI" in body["enzymes"]
    assert body["external"]["ncbi"] is False


def test_service_is_internal_only(client: TestClient) -> None:
    """本服务不自己做鉴权（它只在内网，由门户代理校验会话）。

    鉴权/CSRF 的断言在 `tests/test_biotools_proxy.py`：那里才是浏览器能到达的一层。
    这里只确认「服务本身不挡内部调用」——否则代理转发过去会被上游回 401，
    真实故障就是「未登录或会话已过期」。
    """
    assert client.get("/health").status_code == 200
    assert client.get("/api/biotools/meta").status_code == 200


# ---------------------------------------------------------------- 序列分析


def test_sequence_analyze_dna(client: TestClient, auth: dict[str, str]) -> None:
    sequence = "ATGGCCATTGTAATGGGCCGCTGAAAGGGTGCCCGATAG"
    body = _post(client, auth, "/sequence/analyze", {"sequence": sequence, "molecule": "dna"})
    assert body["length"] == len(sequence)
    assert body["gc"] == 56.41
    assert body["reverse_complement"] == "CTATCGGGCACCCTTTCAGCGGCCCATTACAATGGCCAT"
    assert body["transcribe"].startswith("AUGGCCAUU")
    # 三框翻译必须都返回，键名固定为 +1/+2/+3
    assert set(body["translate"]) == {"+1", "+2", "+3"}
    assert body["translate"]["+1"].startswith("MAIVMGR")
    # 该读框里有内部终止符，不是完整蛋白，因此理化参数留空而不是硬算
    assert body["molecular_weight"] is None


def test_sequence_analyze_protein(client: TestClient, auth: dict[str, str]) -> None:
    body = _post(client, auth, "/sequence/analyze", {"sequence": "MKVLWAALLL", "molecule": "protein"})
    assert body["length"] == 10
    assert body["gc"] is None
    assert body["translate"] is None
    assert body["molecular_weight"] == pytest.approx(1157.51, abs=0.01)
    assert body["gravy"] == pytest.approx(2.01, abs=0.01)


def test_sequence_analyze_rejects_invalid_letters(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/api/biotools/sequence/analyze", headers=auth, json={"sequence": "ACGTZ", "molecule": "dna"}
    )
    assert response.status_code == 400, response.text
    assert "Z" in response.json()["detail"]


def test_sequence_analyze_rejects_empty_sequence(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post("/api/biotools/sequence/analyze", headers=auth, json={"sequence": ""})
    assert response.status_code == 400, response.text
    assert "不能为空" in response.json()["detail"]


# ---------------------------------------------------------------- CDS 提取


def test_cds_extract_from_genbank_features(client: TestClient, auth: dict[str, str]) -> None:
    features = (
        "     CDS             1..39\n"
        '                     /label="geneA"\n'
        '                     /gene="geneA"\n'
    )
    body = _post(client, auth, "/cds/extract", {"record": _genbank(PLASMID, features=features)})
    assert body["count"] == 1
    item = body["items"][0]
    assert item["id"] == "geneA"
    assert item["location"] == "[0:39](+)"
    assert item["sequence"] == PLASMID[:39]
    # 终止密码子不进蛋白序列
    assert item["protein"] == "MAIVMGR*KGAR"  # 内部有终止符时 Biopython 照样给出


def test_cds_extract_filters_by_id(client: TestClient, auth: dict[str, str]) -> None:
    features = (
        "     CDS             1..9\n"
        '                     /locus_tag="tagA"\n'
        "     CDS             10..18\n"
        '                     /locus_tag="tagB"\n'
    )
    body = _post(
        client, auth, "/cds/extract", {"record": _genbank(PLASMID, features=features), "ids": ["tagB"]}
    )
    assert body["count"] == 1
    assert body["items"][0]["id"] == "tagB"
    assert body["items"][0]["sequence"] == PLASMID[9:18]


def test_cds_extract_from_coordinates_on_minus_strand(client: TestClient, auth: dict[str, str]) -> None:
    body = _post(
        client,
        auth,
        "/cds/extract",
        {"sequence": PLASMID, "start": 1, "end": 9, "strand": "-", "frame": 1},
    )
    item = body["items"][0]
    # 反义链取出的是原序列前 9 个碱基的反向互补
    assert item["sequence"] == "AATGGCCAT"
    assert item["protein"] == "NGH"
    assert item["strand"] == -1


def test_cds_extract_requires_record_or_sequence(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post("/api/biotools/cds/extract", headers=auth, json={})
    assert response.status_code == 400, response.text
    assert "record" in response.json()["detail"]


# ---------------------------------------------------------------- 格式转换


def test_format_convert_genbank_to_fasta(client: TestClient, auth: dict[str, str]) -> None:
    body = _post(
        client, auth, "/format/convert", {"text": _genbank(PLASMID), "from": "genbank", "to": "fasta"}
    )
    assert body["count"] == 1
    assert body["text"].startswith(">pTEST")
    assert PLASMID.upper() in body["text"].replace("\n", "")


def test_format_convert_fasta_to_genbank(client: TestClient, auth: dict[str, str]) -> None:
    body = _post(
        client,
        auth,
        "/format/convert",
        {"text": ">seq1 test\nATGCATGCATGC\n", "from": "fasta", "to": "genbank"},
    )
    assert body["count"] == 1
    assert body["text"].startswith("LOCUS")
    assert body["text"].rstrip().endswith("//")


def test_format_convert_reports_broken_record(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/api/biotools/format/convert",
        headers=auth,
        json={"text": "LOCUS 坏记录\n\nnot genbank at all\n", "from": "genbank", "to": "fasta"},
    )
    assert response.status_code == 400, response.text
    # 报错必须指出是第几条记录出的问题
    assert "第 1 条记录" in response.json()["detail"]


def test_format_convert_rejects_unknown_format(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/api/biotools/format/convert", headers=auth, json={"text": "ACGT", "from": "xyz", "to": "fasta"}
    )
    assert response.status_code == 400, response.text
    assert "from" in response.json()["detail"]


# ---------------------------------------------------------------- 酶切 / ORF


def test_restriction_reports_sites_and_unique_cutters(client: TestClient, auth: dict[str, str]) -> None:
    body = _post(client, auth, "/restriction", {"sequence": PLASMID})
    hits = {item["enzyme"]: item["sites"] for item in body["hits"]}
    # GAATTC 的 0 基下标 +2 = 切点右侧第一个碱基的 1 基位置
    assert hits["EcoRI"] == [PLASMID.index("GAATTC") + 2]
    assert "EcoRI" in body["unique_cutters"]
    # 只给 32 个常用酶做检查，没切点的要出现在 non_cutters 里
    assert body["enzymes_checked"] == 32
    assert "NotI" in body["non_cutters"]
    assert set(hits) | set(body["non_cutters"]) == set(biotools_mod.COMMON_ENZYMES)


def test_restriction_rejects_unknown_enzyme(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/api/biotools/restriction",
        headers=auth,
        json={"sequence": PLASMID, "enzymes": ["NotAnEnzyme"]},
    )
    assert response.status_code == 400, response.text
    assert "NotAnEnzyme" in response.json()["detail"]


def test_orf_finds_start_to_stop(client: TestClient, auth: dict[str, str]) -> None:
    body = _post(client, auth, "/orf", {"sequence": PLASMID, "min_aa": 3})
    assert body["count"] >= 1
    orf = body["orfs"][0]
    assert orf["frame"] == "+1"
    # 第一个 ORF：第 1 位的 ATG 到第 22~24 位的 TAA
    assert (orf["start"], orf["end"]) == (1, 24)
    assert orf["protein"] == "MAIVMGR"
    assert orf["length_aa"] == len(orf["protein"])


def test_orf_rejects_unknown_genetic_code(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/api/biotools/orf", headers=auth, json={"sequence": PLASMID, "min_aa": 3, "genetic_code": 999}
    )
    assert response.status_code == 400, response.text


# ---------------------------------------------------------------- 蛋白 / 引物


def test_protein_params_reports_protparam_fields(client: TestClient, auth: dict[str, str]) -> None:
    body = _post(client, auth, "/protein/params", {"sequence": "MKVLWAALLL"})
    assert body["length"] == 10
    assert body["molecular_weight"] == pytest.approx(1157.51, abs=0.01)
    assert body["instability_index"] > 0
    assert set(body["extinction_coefficient"]) == {"reduced", "cystine"}


def test_protein_params_rejects_non_standard_letters(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post("/api/biotools/protein/params", headers=auth, json={"sequence": "MKVX"})
    assert response.status_code == 400, response.text
    assert "X" in response.json()["detail"]


def test_primer_tm_three_methods(client: TestClient, auth: dict[str, str]) -> None:
    primer = "ATGCGTACGTAGCTAGCTAG"
    nn = _post(client, auth, "/primer/tm", {"sequence": primer, "method": "nn"})
    gc = _post(client, auth, "/primer/tm", {"sequence": primer, "method": "gc"})
    wallace = _post(client, auth, "/primer/tm", {"sequence": "ATGCGTACGTA", "method": "wallace"})
    assert 45 < nn["tm"] < 80
    assert 45 < gc["tm"] < 80
    # Wallace 规则：2*(A+T)+4*(G+C)
    assert wallace["tm"] == 32.0
    assert "短引物" in wallace["note"]


def test_primer_tm_rejects_unknown_method(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/api/biotools/primer/tm", headers=auth, json={"sequence": "ATGCGTACGTA", "method": "bogus"}
    )
    assert response.status_code == 400, response.text


def test_primer_dilution_uses_c1v1_eq_c2v2(client: TestClient, auth: dict[str, str]) -> None:
    body = _post(
        client, auth, "/primer/dilution", {"stock_um": 100, "working_um": 10, "volume_ul": 200}
    )
    assert body["take_ul"] == 20.0
    assert body["diluent_ul"] == 180.0
    assert "C1V1=C2V2" in body["note"]


def test_primer_dilution_rejects_working_above_stock(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/api/biotools/primer/dilution",
        headers=auth,
        json={"stock_um": 10, "working_um": 100, "volume_ul": 100},
    )
    assert response.status_code == 400, response.text


# ---------------------------------------------------------------- 比对 / 建树


def test_align_pairwise_global_identity(client: TestClient, auth: dict[str, str]) -> None:
    body = _post(
        client,
        auth,
        "/align/pairwise",
        {"query": "ACGTACGT", "reference": "ACGTTCGT", "mode": "global"},
    )
    assert body["score"] == 13.0
    assert body["identity"] == pytest.approx(0.875)
    assert body["match_line"] == "||||.|||"
    # 返回的比对串必须三行且等长
    lines = body["alignment"].split("\n")
    assert len(lines) == 3
    assert len(lines[0]) == len(lines[1]) == len(lines[2])


def test_align_multiple_produces_equal_length_rows(client: TestClient, auth: dict[str, str]) -> None:
    body = _post(client, auth, "/align/multiple", {"sequences": ["ACGTACGT", "ACGTTACGT", "ACGACGT"]})
    rows = body["aligned"]
    assert len(rows) == 3
    assert len({len(row) for row in rows}) == 1
    assert len(body["consensus"]) == len(rows[0])
    assert body["method"] == "progressive-star"
    assert body["identity_matrix"][0][0] == 1.0


def test_align_multiple_needs_two_sequences(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post("/api/biotools/align/multiple", headers=auth, json={"sequences": ["ACGT"]})
    assert response.status_code == 400, response.text


def test_phylo_nj_from_sequences(client: TestClient, auth: dict[str, str]) -> None:
    body = _post(
        client,
        auth,
        "/phylo/nj",
        {"sequences": ["ACGTACGTAA", "ACGTACGTAT", "TTGTACGTAA", "ACGTTCGTAA"]},
    )
    assert body["newick"].endswith(";")
    assert body["ids"] == ["seq1", "seq2", "seq3", "seq4"]
    assert len(body["matrix"]) == 4


def test_phylo_nj_rejects_asymmetric_matrix(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/api/biotools/phylo/nj", headers=auth, json={"matrix": [[0, 1, 2], [2, 0, 3], [2, 3, 0]]}
    )
    assert response.status_code == 400, response.text
    assert "对称" in response.json()["detail"]


def test_phylo_convert_ascii_and_nested_json(client: TestClient, auth: dict[str, str]) -> None:
    body = _post(client, auth, "/phylo/convert", {"newick": "((a:1,b:2):1,c:3);"})
    assert "a" in body["ascii"] and "b" in body["ascii"]
    root = body["json"]
    assert root["children"][0]["children"][0]["name"] == "a"
    assert root["children"][0]["length"] == 1.0


def test_phylo_convert_rejects_invalid_newick(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post("/api/biotools/phylo/convert", headers=auth, json={"newick": "((a:1,b"})
    assert response.status_code == 400, response.text
    assert "Newick" in response.json()["detail"]


def test_diversity_pcoa_reports_coordinates(client: TestClient, auth: dict[str, str]) -> None:
    body = _post(
        client,
        auth,
        "/diversity/pcoa",
        {"ids": ["s1", "s2", "s3"], "matrix": [[0, 0.1, 0.5], [0.1, 0, 0.6], [0.5, 0.6, 0]]},
    )
    assert body["ids"] == ["s1", "s2", "s3"]
    assert len(body["coordinates"]) == 3
    assert len(body["coordinates"][0]) == 3
    assert body["proportion_explained"][0] == pytest.approx(1.0)


# ---------------------------------------------------------------- GC 曲线 / 三字母


def test_gc_window_points_and_kmer_frequencies(client: TestClient, auth: dict[str, str]) -> None:
    sequence = "ATGCATGC" * 6
    body = _post(client, auth, "/gc/window", {"sequence": sequence, "window": 8, "step": 8})
    assert body["gc_points"][0] == [1, 50.0]
    assert all(point[1] == 50.0 for point in body["gc_points"])
    assert body["kmer_k"] == 4
    assert body["kmer_frequencies"]["ATGC"] == 12


def test_gc_window_rejects_window_longer_than_sequence(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/api/biotools/gc/window", headers=auth, json={"sequence": "ATGC", "window": 50, "step": 10}
    )
    assert response.status_code == 400, response.text


def test_seq3_convert_patent_layout_round_trip(client: TestClient, auth: dict[str, str]) -> None:
    protein = "MEVK" * 20
    body = _post(
        client,
        auth,
        "/seq3/convert",
        {"sequence": protein, "direction": "1to3", "group_per_line": True, "patent_offset": 1},
    )
    assert body["codes"][:4] == ["Met", "Glu", "Val", "Lys"]
    lines = body["text"].split("\n")
    assert all(len(line) <= 60 for line in lines)
    assert lines[0].split()[0] == "1"

    back = _post(client, auth, "/seq3/convert", {"sequence": body["text"], "direction": "3to1"})
    assert back["text"] == protein


def test_seq3_convert_rejects_unknown_code(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/api/biotools/seq3/convert", headers=auth, json={"sequence": "Foo Bar", "direction": "3to1"}
    )
    assert response.status_code == 400, response.text
    assert "Foo" in response.json()["detail"]


# ---------------------------------------------------------------- 载体裁剪


def test_vector_trim_strips_leading_vector(client: TestClient, auth: dict[str, str]) -> None:
    vector = "AAGCTTGCTTACGCGTGCTAGC"
    insert = "ATGGCCATTGTAATGGGCCG"
    body = _post(client, auth, "/vector/trim", {"read": vector + insert, "vector": vector, "min_score": 5})
    assert body["trimmed_sequence"] == insert
    assert body["trimmed"] == {"start": 0, "end": len(vector)}
    assert body["identity"] == pytest.approx(1.0)


def test_vector_trim_leaves_internal_match_alone(client: TestClient, auth: dict[str, str]) -> None:
    vector = "AAGCTTGCTTACGCGTGCTAGC"
    read = "TTTTTT" + vector + "GGGGGG"
    body = _post(client, auth, "/vector/trim", {"read": read, "vector": vector, "min_score": 5})
    # 内嵌的载体同源片段不裁，原样返回
    assert body["trimmed_sequence"] == read
    assert body["trimmed"] == {"start": 0, "end": 0}


# ---------------------------------------------------------------- 上传类端点


def test_abi_parse_reports_quality_and_trim(client: TestClient, auth: dict[str, str]) -> None:
    qualities = [3] * 8 + [38] * 14 + [2] * 8
    raw = _synth_ab1("ACGTACGTAC" * 3, qualities)
    response = client.post(
        "/api/biotools/abi/parse",
        headers=auth,
        files={"file": ("read.ab1", raw, "application/octet-stream")},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["length"] == 30
    assert body["sequence"] == "ACGTACGTAC" * 3
    assert body["mean_quality"] == pytest.approx(sum(qualities) / 30, abs=0.01)
    # 两端的低质量碱基被 Mott 算法裁掉
    assert body["trimmed"]["start"] == 8
    assert body["trimmed"]["end"] < 30
    assert 0 < body["trimmed"]["length"] < 30
    assert len(body["quality"]) == 30


def test_abi_parse_rejects_non_abi_upload(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/api/biotools/abi/parse",
        headers=auth,
        files={"file": ("read.txt", b"definitely not a chromatogram", "text/plain")},
    )
    assert response.status_code == 400, response.text
    assert "ABIF" in response.json()["detail"]


def test_abi_parse_rejects_oversize_upload(client: TestClient, auth: dict[str, str]) -> None:
    payload = b"ABIF" + b"0" * biotools_mod.ABI_MAX_BYTES
    response = client.post(
        "/api/biotools/abi/parse",
        headers=auth,
        files={"file": ("big.ab1", payload, "application/octet-stream")},
    )
    assert response.status_code == 413, response.text
    assert "1 MB" in response.json()["detail"]


def test_seqio_filter_keeps_by_length(client: TestClient, auth: dict[str, str]) -> None:
    fasta = ">chr1 first\nATGCATGCATGC\n>chr2 second\nGCGCGCGCGCGCGCGC\n>small\nATATAT\n"
    response = client.post(
        "/api/biotools/seqio/filter",
        headers=auth,
        params={"min_len": 8},
        files={"file": ("records.fasta", fasta.encode(), "text/plain")},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["format"] == "fasta"
    assert body["total"] == 3
    assert body["kept"] == 2
    assert body["dropped"] == 1
    assert body["ids"] == ["chr1", "chr2"]
    assert body["dropped_ids"] == ["small"]


def test_seqio_filter_rejects_unknown_format(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/api/biotools/seqio/filter",
        headers=auth,
        files={"file": ("records.bin", b"\x00\x01\x02binary", "application/octet-stream")},
    )
    assert response.status_code == 400, response.text
    assert "未知格式" in response.json()["detail"]


def test_seqio_filter_rejects_oversize_upload(client: TestClient, auth: dict[str, str]) -> None:
    payload = b">big\n" + b"A" * biotools_mod.SEQIO_MAX_BYTES
    response = client.post(
        "/api/biotools/seqio/filter",
        headers=auth,
        files={"file": ("big.fasta", payload, "text/plain")},
    )
    assert response.status_code == 413, response.text
    assert "20 MB" in response.json()["detail"]


# ---------------------------------------------------------------- 质粒图谱


def test_plasmid_map_returns_png(client: TestClient, auth: dict[str, str]) -> None:
    features = (
        "     CDS             1..39\n"
        "                     /label=\"geneA\"\n"
        "     rep_origin      complement(46..57)\n"
        "                     /label=\"ori\"\n"
    )
    response = client.post(
        "/api/biotools/plasmid/map",
        headers=auth,
        json={"record": _genbank(PLASMID, topology="circular", features=features), "topology": "circular"},
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/png"
    assert response.content.startswith(b"\x89PNG")


def test_plasmid_map_returns_svg_on_request(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/api/biotools/plasmid/map",
        headers=auth,
        params={"format": "svg"},
        json={"record": _genbank(PLASMID), "topology": "linear"},
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("image/svg+xml")
    assert b"<svg" in response.content[:200]


def test_plasmid_map_rejects_unsupported_format(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/api/biotools/plasmid/map",
        headers=auth,
        params={"format": "pdf"},
        json={"record": _genbank(PLASMID)},
    )
    assert response.status_code == 400, response.text


# ---------------------------------------------------------------- NCBI（外网）


@pytest.fixture()
def offline(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """把探活换成立即失败：这台机器（和容器）没有外网，端点必须秒回 503。"""
    calls: list[str] = []

    def fake_probe() -> None:
        calls.append("probe")
        raise biotools_mod.HTTPException(status_code=503, detail=biotools_mod._NCBI_UNAVAILABLE)

    monkeypatch.setattr(biotools_mod, "_probe_ncbi", fake_probe)
    return calls


def test_entrez_search_fails_fast_without_internet(
    client: TestClient, auth: dict[str, str], offline: list[str]
) -> None:
    response = client.get(
        "/api/biotools/entrez/search", headers=auth, params={"db": "nuccore", "term": "brca1"}
    )
    assert response.status_code == 503, response.text
    assert response.json()["detail"] == "需要外网访问 NCBI，当前环境不可用"
    # 确实走了"先探活、再调用"的分支，没有真的发出请求
    assert offline == ["probe"]


def test_entrez_fetch_fails_fast_without_internet(
    client: TestClient, auth: dict[str, str], offline: list[str]
) -> None:
    response = client.post(
        "/api/biotools/entrez/fetch", headers=auth, json={"db": "nuccore", "ids": ["NM_001"]}
    )
    assert response.status_code == 503, response.text
    assert "NCBI" in response.json()["detail"]


def test_blast_fails_fast_without_internet(
    client: TestClient, auth: dict[str, str], offline: list[str]
) -> None:
    response = client.post(
        "/api/biotools/blast",
        headers=auth,
        json={"sequence": "ATGCGTACGTAGCTAGCTAG", "program": "blastn"},
    )
    assert response.status_code == 503, response.text
    assert "NCBI" in response.json()["detail"]


def test_blast_rejects_unknown_program(client: TestClient, auth: dict[str, str]) -> None:
    response = client.post(
        "/api/biotools/blast",
        headers=auth,
        json={"sequence": "ATGCGTACGTAGCTAGCTAG", "program": "blastq"},
    )
    assert response.status_code == 400, response.text
