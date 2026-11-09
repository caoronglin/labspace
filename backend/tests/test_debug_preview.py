"""全局 Debug / Preview 通道：有界派生契约与路由鉴权。

不连数据库、不连内网。只验证：超限拒绝、格式分派、绝不回显原始字节、
以及 /api/debug/* 不会在未登录时被访问。
"""
from __future__ import annotations

import gzip
import io
import zipfile

import pytest

from app.preview_inline import MAX_INPUT, MAX_ROWS, PreviewError, render


def test_text_is_capped_and_never_echoes_raw() -> None:
    r = render("note.txt", b"hello" + b"x" * 5000)
    assert r["kind"] == "text"
    assert len(r["text"]) <= 2048
    assert r["truncated"] is True
    assert "raw" not in r and "content" not in r


def test_input_over_8mib_rejected() -> None:
    with pytest.raises(PreviewError):
        render("x.txt", b"a" * (MAX_INPUT + 1))


def test_gz_dispatch_and_expansion_limit() -> None:
    r = render("reads.fasta.gz", gzip.compress(b">a\nACGT\n>b\nTTTT\n"))
    assert r["format"] == "fasta"
    assert len(r["records"]) == 2
    with pytest.raises(PreviewError):
        render("bomb.txt.gz", gzip.compress(b"a" * (24 << 20) + b"x"))


def test_fasta_row_cap_and_count() -> None:
    payload = "".join(f">s{i}\nACGT\n" for i in range(25)).encode()
    r = render("x.fa", payload)
    assert len(r["records"]) == MAX_ROWS
    assert r["records_seen"] == 25
    assert r["truncated"] is True


def test_fastq_rejects_malformed() -> None:
    with pytest.raises(PreviewError):
        render("x.fq", b"@r1\nACGT\n+\nII\n")  # seq/qual 长度不等
    with pytest.raises(PreviewError):
        render("x.fq", b"@r1\nACGT\n+\n")      # 缺一行


def test_csv_quoted_comma_keeps_columns() -> None:
    r = render("x.csv", b'a,b,c\n"x,y",z,w\n')
    assert r["rows"][1][:3] == ["x,y", "z", "w"]


def test_table_row_and_column_cap() -> None:
    row = "\t".join(f"c{i}" for i in range(30))
    r = render("x.tsv", ("\n".join([row] * 30)).encode())
    assert len(r["rows"]) == MAX_ROWS
    assert len(r["rows"][0]) == 16
    assert r["truncated"] is True


def test_docx_text_only_no_macros() -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(
            "word/document.xml",
            '<w:document><w:p><w:t>Hello 实验室</w:t></w:p></w:document>',
        )
        z.writestr("word/vbaProject.bin", b"MZ-MACRO")
    r = render("x.docx", buf.getvalue())
    assert r["kind"] == "document"
    assert "Hello 实验室" in r["text"]
    assert "MZ-MACRO" not in r["text"]


def test_docx_rejects_bad_zip() -> None:
    with pytest.raises(PreviewError):
        render("x.docx", b"not a zip")


def test_pdf_and_bam_are_worker_only() -> None:
    r = render("secret.pdf", b"%PDF-1.7\nTOP-SECRET")
    assert r["kind"] == "requires-worker"
    assert "text" not in r


def test_image_meta_png_header_only() -> None:
    b = bytearray(33)
    b[:8] = b"\x89PNG\r\n\x1a\n"
    b[16:20] = (400).to_bytes(4, "big")
    b[20:24] = (200).to_bytes(4, "big")
    r = render("x.png", bytes(b))
    assert r["kind"] == "image-metadata"
    assert r["meta"]["width"] == 400 and r["meta"]["height"] == 200


def test_unsupported_does_not_guess() -> None:
    r = render("x.bin", b"\x00\x01\x02")
    assert r["kind"] == "unsupported"
    assert "rows" not in r and "text" not in r


# ------------------------------------------------------------------ 路由
def test_debug_routes_require_login() -> None:
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    assert client.get("/api/debug/status").status_code == 401
    assert client.post("/api/debug/preview", files={"file": ("a.txt", b"hi")}).status_code in (401, 403)


@pytest.mark.asyncio
async def test_debug_status_is_redacted(monkeypatch: pytest.MonkeyPatch) -> None:
    from app import debug_api
    from app.config import settings

    async def fake_go(_path: str) -> dict:
        return {"status": "alive"}

    monkeypatch.setattr(debug_api, "go_get", fake_go)
    user = {"id": "u1", "roles": ["lab-admin"]}
    r = await debug_api.debug_status(user)  # type: ignore[arg-type]
    assert "backend" in r and "go_core" in r and "capabilities" in r
    assert r["session"]["is_admin"] is True
    # 能力开关只暴露布尔值，绝不出现配置值/密钥
    assert all(isinstance(v, bool) for v in r["capabilities"].values())
    dumped = str(r)
    assert settings.session_secret not in dumped
    assert settings.db_dsn not in dumped
    assert "cookie" not in dumped.lower()
