"""LaTeX 版本保留策略与编译素材：上限、隔离与「素材随源码进沙箱」。

不连 PostgreSQL（测试环境不碰真库）：用内存假库顶替 ``db.query`` /
``db.execute``。版本表 / 素材表上的谓词（doc_id、owner）真的落到数据上，
跨用户访问只有谓词生效才算数。
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient

from app import db, main
from app.config import settings

CSRF = "csrf-token-for-test"
DOC_COLUMNS = (
    "title",
    "venue",
    "authors",
    "status",
    "abstract",
    "keywords",
    "content",
    "project_id",
    "knowledge_doc_id",
    "due_date",
)


class FakeDb:
    """只实现 LaTeX 文稿 / 版本 / 素材用到的那些语句的内存库。"""

    def __init__(self) -> None:
        self.documents: dict[str, dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = []
        self.versions: list[dict[str, Any]] = []
        self.assets: list[dict[str, Any]] = []
        self._seq = 0
        self._clock = datetime(2024, 1, 1)

    # ------------------------------------------------------------ 工具
    def _stamp(self) -> datetime:
        self._seq += 1
        self._clock = self._clock + timedelta(seconds=1)
        return self._clock

    def version_rows(self, doc_id: str, owner: str = "u1") -> list[dict[str, Any]]:
        return [v for v in self.versions if v["doc_id"] == doc_id and v["owner"] == owner]

    def asset_rows(self, doc_id: str, owner: str = "u1") -> list[dict[str, Any]]:
        return [a for a in self.assets if a["doc_id"] == doc_id and a["owner"] == owner]

    # ------------------------------------------------------------ 读
    def query(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        s = " ".join(sql.split())
        if "FROM labspace.latex_documents" in s:
            doc_id, owner = params[0], params[1]
            row = self.documents.get(doc_id)
            return [dict(row)] if row and row["owner"] == owner else []
        if "INSERT INTO labspace.latex_events" in s:
            doc_id, owner, kind, note = params
            self._seq += 1
            event_id = self._seq
            self.events.append(
                {"id": event_id, "doc_id": doc_id, "owner": owner, "kind": kind, "note": note, "created_at": self._stamp()}
            )
            return [{"id": event_id}] if "RETURNING id" in s else []
        if "FROM labspace.latex_versions" in s:
            if s.startswith("SELECT content FROM"):
                doc_id, owner = params
                rows = [v for v in self.versions if v["doc_id"] == doc_id and v["owner"] == owner]
                rows.sort(key=lambda v: (v["created_at"], v["id"]), reverse=True)
                return [dict(rows[0])] if rows else []
            if s.startswith("DELETE FROM"):
                doc_id, owner, keep = params
                rows = [v for v in self.versions if v["doc_id"] == doc_id and v["owner"] == owner]
                rows.sort(key=lambda v: (v["created_at"], v["id"]), reverse=True)
                stale = rows[keep:]
                for row in stale:
                    self.versions.remove(row)
                return [{"id": row["id"]} for row in stale]
        if "FROM labspace.latex_assets" in s:
            if "count(*)" in s:
                doc_id, owner = params
                rows = self.asset_rows(doc_id, owner)
                return [{"n": len(rows), "total": sum(r["bytes"] for r in rows)}]
            if "SELECT name, data FROM" in s:
                doc_id, owner = params
                return [dict(r) for r in self.asset_rows(doc_id, owner)]
            if "WHERE id=%s" in s:
                asset_id = params[0]
                row = next((a for a in self.assets if a["id"] == asset_id), None)
                return [dict(row)] if row else []
            if "WHERE id=%s AND doc_id=%s AND owner=%s" in s:
                asset_id, doc_id, owner = params
                row = next(
                    (a for a in self.assets if a["id"] == asset_id and a["doc_id"] == doc_id and a["owner"] == owner),
                    None,
                )
                return [dict(row)] if row else []
            doc_id, owner = params
            return [dict(r) for r in self.asset_rows(doc_id, owner)]
        return []

    # ------------------------------------------------------------ 写
    def execute(self, sql: str, params: tuple = ()) -> None:
        s = " ".join(sql.split())
        if "INSERT INTO labspace.latex_documents" in s:
            (doc_id, owner, title, kind, venue, authors, abstract, keywords, content, project_id, knowledge_doc_id, due_date) = params
            self.documents[doc_id] = {
                "id": doc_id,
                "owner": owner,
                "title": title,
                "kind": kind,
                "venue": venue,
                "authors": authors,
                "status": "draft",
                "abstract": abstract,
                "keywords": keywords,
                "content": content,
                "project_id": project_id,
                "knowledge_doc_id": knowledge_doc_id,
                "due_date": due_date,
                "compiled_at": None,
                "compile_ok": None,
                "compile_log": "",
                "pdf_bytes": 0,
                "created_at": self._stamp(),
                "updated_at": self._clock,
            }
            return
        if "UPDATE labspace.latex_documents SET" in s:
            doc_id, owner = params[-2], params[-1]
            doc = self.documents.get(doc_id)
            if not doc or doc["owner"] != owner:
                return
            if "compiled_at=now()" in s:
                doc["compiled_at"] = self._stamp()
                doc["compile_ok"] = "compile_ok=true" in s
                doc["compile_log"] = params[0]
                if "pdf_bytes=%s" in s:
                    doc["pdf_bytes"] = params[1]
                doc["updated_at"] = self._clock
                return
            flags = list(params[0::2])[: len(DOC_COLUMNS)]
            values = list(params[1::2])[: len(DOC_COLUMNS)]
            for col, flag, value in zip(DOC_COLUMNS, flags, values, strict=False):
                if flag:
                    doc[col] = value
            doc["updated_at"] = self._stamp()
            return
        if "INSERT INTO labspace.latex_versions" in s:
            event_id, doc_id, owner, content = params
            self._seq += 1
            self.versions.append(
                {
                    "id": self._seq,
                    "event_id": event_id,
                    "doc_id": doc_id,
                    "owner": owner,
                    "content": content,
                    "created_at": self._stamp(),
                }
            )
            return
        if "INSERT INTO labspace.latex_assets" in s:
            asset_id, doc_id, owner, name, size, content_type, data = params
            self._seq += 1
            self.assets.append(
                {
                    "id": asset_id,
                    "doc_id": doc_id,
                    "owner": owner,
                    "name": name,
                    "bytes": size,
                    "content_type": content_type,
                    "data": bytes(data),
                    "created_at": self._stamp(),
                }
            )
            return
        if "DELETE FROM labspace.latex_assets" in s:
            asset_id, doc_id, owner = params
            self.assets = [
                a
                for a in self.assets
                if not (a["id"] == asset_id and a["doc_id"] == doc_id and a["owner"] == owner)
            ]
            return


@pytest.fixture()
def fake(monkeypatch: pytest.MonkeyPatch) -> FakeDb:
    store = FakeDb()
    monkeypatch.setattr(db, "query", store.query)
    monkeypatch.setattr(db, "execute", store.execute)
    return store


@pytest.fixture()
def client() -> TestClient:
    return TestClient(main.app)


def cookies(sub: str = "u1") -> dict[str, str]:
    token = jwt.encode(
        {"sub": sub, "email": f"{sub}@example.com", "name": sub.upper(), "roles": [], "exp": int(time.time()) + 3600},
        settings.session_secret,
        algorithm="HS256",
    )
    return {"labspace_session": token, settings.csrf_cookie: CSRF}


def write() -> dict[str, str]:
    return {"X-CSRF-Token": CSRF, "Origin": settings.allowed_origins[0]}


def make_doc(client: TestClient, sub: str = "u1") -> str:
    resp = client.post(
        "/api/latex/documents",
        json={"title": "素材测试稿", "template": "article-cn"},
        cookies=cookies(sub),
        headers=write(),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["document"]["id"]


def upload(client: TestClient, doc_id: str, name: str, blob: bytes, sub: str = "u1"):
    return client.post(
        f"/api/latex/documents/{doc_id}/assets",
        files={"file": (name, blob, "application/octet-stream")},
        cookies=cookies(sub),
        headers=write(),
    )


# ---------------------------------------------------------------- 版本保留策略


def test_versions_are_capped_at_thirty_and_oldest_are_deleted(client: TestClient, fake: FakeDb) -> None:
    """版本快照不能无限增长：超过 30 个就把最旧的删掉。"""
    doc_id = make_doc(client)
    for i in range(35):
        resp = client.patch(
            f"/api/latex/documents/{doc_id}",
            json={"content": f"\\documentclass{{article}}\n% v{i}\n\\begin{{document}}x{i}\\end{{document}}"},
            cookies=cookies(),
            headers=write(),
        )
        assert resp.status_code == 200, resp.text

    rows = fake.version_rows(doc_id)
    assert len(rows) == 30, f"应保留最近 30 个版本，实际 {len(rows)}"
    # 留的是最新的 30 个：最早那几版已经被删掉
    contents = [r["content"] for r in rows]
    assert "% v34" in contents[-1] or any("% v34" in c for c in contents)
    assert not any("% v0\n" in c for c in contents), "最旧的版本应已被删除"


def test_identical_content_is_not_stored_twice(client: TestClient, fake: FakeDb) -> None:
    """同一份源码不重复存：内容没变就别再存第二份快照。"""
    doc_id = make_doc(client)
    content = "\\documentclass{article}\\begin{document}same\\end{document}"
    resp = client.patch(
        f"/api/latex/documents/{doc_id}",
        json={"content": content},
        cookies=cookies(),
        headers=write(),
    )
    assert resp.status_code == 200, resp.text
    after_save = len(fake.version_rows(doc_id))
    assert after_save == 2, "改过的源码应存一份新快照"

    # 再存一次同样的内容：不新增快照
    client.patch(
        f"/api/latex/documents/{doc_id}",
        json={"content": content},
        cookies=cookies(),
        headers=write(),
    )
    assert len(fake.version_rows(doc_id)) == after_save

    # 编译同一份源码：也不该再存一份（编译事件仍留在时间线上）
    calls: list[dict[str, Any]] = []

    class _Resp:
        status_code = 200

        def json(self) -> dict[str, Any]:
            return {"ok": False, "log": "fake compile", "ms": 1, "pdf": ""}

    class _Client:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> _Client:
            return self

        async def __aexit__(self, *exc: Any) -> bool:
            return False

        async def post(self, url: str, json: dict[str, Any] | None = None) -> _Resp:
            calls.append(json or {})
            return _Resp()

    from app import latex as latex_mod

    original = latex_mod.httpx.AsyncClient
    latex_mod.httpx.AsyncClient = _Client  # type: ignore[assignment]
    try:
        compiled = client.post(
            f"/api/latex/documents/{doc_id}/compile",
            cookies=cookies(),
            headers=write(),
        )
    finally:
        latex_mod.httpx.AsyncClient = original  # type: ignore[assignment]

    assert compiled.status_code == 200, compiled.text
    assert calls, "编译请求应真的发出去了"
    assert len(fake.version_rows(doc_id)) == after_save, "内容没变就不该再存版本快照"


def test_prune_versions_returns_deleted_count(client: TestClient, fake: FakeDb) -> None:
    """prune_versions 是可复用函数：返回删掉的条数。"""
    from app.latex import prune_versions

    doc_id = make_doc(client)
    for i in range(5):
        client.patch(
            f"/api/latex/documents/{doc_id}",
            json={"content": f"\\documentclass{{article}}\n% p{i}"},
            cookies=cookies(),
            headers=write(),
        )
    assert len(fake.version_rows(doc_id)) == 6
    deleted = asyncio.run(prune_versions(doc_id, "u1", keep=2))
    assert deleted == 4
    assert len(fake.version_rows(doc_id)) == 2


# ---------------------------------------------------------------- 编译素材


def test_asset_extension_whitelist_is_enforced(client: TestClient, fake: FakeDb) -> None:
    doc_id = make_doc(client)
    for bad in ("payload.exe", "shell.sh", "noext", "archive.zip"):
        resp = upload(client, doc_id, bad, b"data")
        assert resp.status_code == 400, f"{bad} 应被拒绝：{resp.text}"
        assert "扩展名" in resp.json()["detail"]
    # 白名单里的能传
    ok = upload(client, doc_id, "nwafuthesis.cls", b"\\NeedsTeXFormat{LaTeX2e}")
    assert ok.status_code == 200, ok.text
    assert ok.json()["asset"]["name"] == "nwafuthesis.cls"


def test_asset_over_two_megabytes_is_rejected(client: TestClient, fake: FakeDb) -> None:
    doc_id = make_doc(client)
    resp = upload(client, doc_id, "big.sty", b"x" * (2 * 1024 * 1024 + 1))
    assert resp.status_code == 413, resp.text
    assert "2 MB" in resp.json()["detail"]
    assert not fake.asset_rows(doc_id)


def test_at_most_twenty_assets_per_document(client: TestClient, fake: FakeDb) -> None:
    doc_id = make_doc(client)
    for i in range(20):
        resp = upload(client, doc_id, f"fig{i}.png", b"\x89PNG" + bytes([i]))
        assert resp.status_code == 200, resp.text
    listing = client.get(f"/api/latex/documents/{doc_id}/assets", cookies=cookies())
    assert listing.status_code == 200
    assert len(listing.json()["assets"]) == 20

    over = upload(client, doc_id, "fig20.png", b"\x89PNG")
    assert over.status_code == 400, over.text
    assert "20" in over.json()["detail"]
    assert len(fake.asset_rows(doc_id)) == 20


def test_assets_are_owner_scoped(client: TestClient, fake: FakeDb) -> None:
    """别人的文稿与素材一律 404：看不到，也删不掉。"""
    doc_id = make_doc(client, sub="u1")
    asset_id = upload(client, doc_id, "mine.cls", b"cls").json()["asset"]["id"]

    other = cookies("u2")
    assert client.get(f"/api/latex/documents/{doc_id}/assets", cookies=other).status_code == 404
    assert (
        client.delete(
            f"/api/latex/documents/{doc_id}/assets/{asset_id}",
            cookies=other,
            headers=write(),
        ).status_code
        == 404
    )
    assert (
        upload(client, doc_id, "theirs.cls", b"cls", sub="u2").status_code
        == 404
    )
    # u1 的素材还在
    assert len(fake.asset_rows(doc_id, "u1")) == 1


def test_asset_list_and_delete_roundtrip(client: TestClient, fake: FakeDb) -> None:
    doc_id = make_doc(client)
    asset = upload(client, doc_id, "style.sty", b"\\ProvidesPackage{style}").json()["asset"]
    assert asset["bytes"] == len(b"\\ProvidesPackage{style}")
    assert "data" not in asset, "列表不带二进制内容"

    listing = client.get(f"/api/latex/documents/{doc_id}/assets", cookies=cookies())
    assert listing.status_code == 200
    names = [a["name"] for a in listing.json()["assets"]]
    assert names == ["style.sty"]

    deleted = client.delete(
        f"/api/latex/documents/{doc_id}/assets/{asset['id']}",
        cookies=cookies(),
        headers=write(),
    )
    assert deleted.status_code == 200
    assert client.get(f"/api/latex/documents/{doc_id}/assets", cookies=cookies()).json()["assets"] == []


def test_asset_upload_requires_csrf(client: TestClient, fake: FakeDb) -> None:
    doc_id = make_doc(client)
    resp = client.post(
        f"/api/latex/documents/{doc_id}/assets",
        files={"file": ("a.cls", b"x", "application/octet-stream")},
        cookies=cookies(),
    )
    assert resp.status_code == 403


def test_assets_do_not_enter_version_snapshots(client: TestClient, fake: FakeDb) -> None:
    """素材不进版本快照：版本表里只该有源码。"""
    doc_id = make_doc(client)
    before = len(fake.version_rows(doc_id))
    upload(client, doc_id, "nwafuthesis.cls", b"\\NeedsTeXFormat{LaTeX2e}")
    assert len(fake.version_rows(doc_id)) == before
    assert all(b"NeedsTeXFormat" not in v["content"].encode() for v in fake.version_rows(doc_id))


def test_compile_sends_assets_to_the_sandbox(client: TestClient, fake: FakeDb) -> None:
    """编译时素材要跟着源码一起送进沙箱（文件名保持原样）。"""
    import base64

    doc_id = make_doc(client)
    blob = b"\\NeedsTeXFormat{LaTeX2e}\\ProvidesClass{nwafuthesis}"
    upload(client, doc_id, "nwafuthesis.cls", blob)

    calls: list[dict[str, Any]] = []

    class _Resp:
        status_code = 200

        def json(self) -> dict[str, Any]:
            return {"ok": False, "log": "fake compile", "ms": 1, "pdf": ""}

    class _Client:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> _Client:
            return self

        async def __aexit__(self, *exc: Any) -> bool:
            return False

        async def post(self, url: str, json: dict[str, Any] | None = None) -> _Resp:
            calls.append(json or {})
            return _Resp()

    from app import latex as latex_mod

    original = latex_mod.httpx.AsyncClient
    latex_mod.httpx.AsyncClient = _Client  # type: ignore[assignment]
    try:
        resp = client.post(
            f"/api/latex/documents/{doc_id}/compile",
            cookies=cookies(),
            headers=write(),
        )
    finally:
        latex_mod.httpx.AsyncClient = original  # type: ignore[assignment]

    assert resp.status_code == 200, resp.text
    assert calls, "编译请求应真的发出去了"
    payload = calls[0]
    assert "content" in payload
    files = payload.get("files") or {}
    assert "nwafuthesis.cls" in files, f"素材没随源码送出：{payload.keys()}"
    assert base64.b64decode(files["nwafuthesis.cls"]) == blob
