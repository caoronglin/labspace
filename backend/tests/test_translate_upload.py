"""PDF 翻译上传回归：request.form() 返回 Starlette UploadFile。"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import docs


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(docs, "TRANSLATE_DIR", str(tmp_path))
    monkeypatch.setattr(docs, "TRANSLATE_META_DIR", str(tmp_path / "meta"))
    app = FastAPI()
    app.include_router(docs.router)
    app.dependency_overrides[docs.require_user] = lambda: {"sub": "student01", "name": "E2E"}
    app.dependency_overrides[docs.require_csrf] = lambda: None
    return TestClient(app)


def test_multipart_pdf_is_accepted(client: TestClient, tmp_path: Path) -> None:
    response = client.post(
        "/api/pdf-translate/jobs",
        files={"file": ("test.pdf", b"%PDF-1.4\n%%EOF\n", "application/pdf")},
    )
    assert response.status_code == 200, response.text
    job_id = response.json()["job_id"]
    assert (tmp_path / "pending" / f"{job_id}.pdf").read_bytes().startswith(b"%PDF")
    assert (tmp_path / "meta" / f"{job_id}.json").is_file()


def test_missing_file_is_rejected(client: TestClient) -> None:
    response = client.post("/api/pdf-translate/jobs")
    assert response.status_code == 400
    assert response.json()["detail"] == "缺少文件"


def test_non_pdf_is_rejected(client: TestClient) -> None:
    response = client.post(
        "/api/pdf-translate/jobs",
        files={"file": ("test.txt", b"not pdf", "text/plain")},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "仅支持 PDF 文件"
