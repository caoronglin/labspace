"""出站边界：数据库适配器白名单与 SnapOtter 下载地址规范化。

这两个函数是门户唯一两处「按用户输入拼上游 URL」的地方，
回归一旦破了就是 SSRF。
"""
from __future__ import annotations

import pytest

from app import db_apis, snapotter


@pytest.mark.parametrize(
    "url",
    [
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=gene",
        "https://www.ebi.ac.uk/ebisearch/ws/rest/uniprot",
        "https://rest.uniprot.org/uniprotkb/search",
        "https://alphafold.ebi.ac.uk/api/prediction/P00533",
        "https://www.cbioportal.org/api/studies",
    ],
)
def test_allowed_upstream(url: str) -> None:
    db_apis._assert_allowed_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "http://eutils.ncbi.nlm.nih.gov/x",  # 非 https
        "https://evil.example.com/x",
        "https://127.0.0.1/x",
        "https://169.254.169.254/latest/meta-data/",  # 云元数据
        "https://ncbi.nlm.nih.gov.evil.com/x",  # 后缀欺骗
        "file:///etc/passwd",
    ],
)
def test_rejected_upstream(url: str) -> None:
    with pytest.raises(RuntimeError):
        db_apis._assert_allowed_url(url)


def test_every_adapter_endpoint_is_allowed() -> None:
    """适配器表里的每个 endpoint 都必须落在白名单内，避免新增一条就 SSRF。"""
    for key, spec in db_apis.ADAPTERS.items():
        if not spec.endpoint:
            continue
        url = spec.endpoint.format(
            q="x", limit=1, program="blastn", database="nr", organism="3702", species="9606", space="genes"
        )
        db_apis._assert_allowed_url(url)  # 不抛错即通过


def test_blast_params_are_not_passthrough() -> None:
    """program / database 来自请求体，必须收敛到固定集合。"""
    assert "blastn" in db_apis.BLAST_PROGRAMS
    assert "refseq_plant" in db_apis.BLAST_DATABASES
    assert "x&QUERY=evil" not in db_apis.BLAST_PROGRAMS


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("/api/v1/jobs/1/download", "/api/v1/jobs/1/download"),
        ("/files/a.zip", "/api/v1/files/a.zip"),
        ("http://lab-snapotter:1349/files/a.zip", "/api/v1/files/a.zip"),
        ("http://172.17.0.5:1349/api/v1/x?y=1", "/api/v1/x?y=1"),
        ("http://[::1]:1349/api/v1/x", "/api/v1/x"),
    ],
)
def test_snapotter_download_path(raw: str, expected: str) -> None:
    assert snapotter.resolve_download(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "http://evil.example.com/x",
        "https://raw.githubusercontent.com/a/b",
        "file:///etc/passwd",
        "gopher://127.0.0.1:6379/_INFO",
        "",
    ],
)
def test_snapotter_download_rejects(raw: str) -> None:
    with pytest.raises(ValueError):
        snapotter.resolve_download(raw)


def test_snapotter_keeps_whitelisted_origin() -> None:
    """下载必须落在 SnapOtter 自己的地址上，不能跟随第三方主机。"""
    path = snapotter.resolve_download("http://lab-snapotter:1349/files/a.zip")
    assert path.startswith("/api/v1/")
