"""LaTeX 上下审稿与模板库：接口契约、状态流转与 owner 隔离。

不连 PostgreSQL（测试环境不碰真库）：用内存假库顶替 ``db.query`` /
``db.execute``，按 SQL 里稳定出现的关键字分派，并把 ``doc_id`` / ``owner``
谓词真的落到数据上 —— 跨用户 404 只有谓词生效才算数。
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient

from app import db, main
from app.config import settings

CSRF = "csrf-token-for-test"


class FakeDb:
    """只实现 LaTeX 审稿 / 版本用到的那些语句的内存库。"""

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

    def __init__(self) -> None:
        self.documents: dict[str, dict[str, Any]] = {}
        self.reviews: dict[str, dict[str, Any]] = {}
        self.replies: dict[str, dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = []
        self.versions: dict[int, dict[str, Any]] = {}  # event_id -> 源码快照
        self._seq = 0
        self._clock = datetime(2024, 1, 1)

    # ------------------------------------------------------------ 工具
    def _stamp(self) -> datetime:
        self._seq += 1
        self._clock = self._clock + timedelta(seconds=1)
        return self._clock

    def _review_row(self, row: dict[str, Any]) -> dict[str, Any]:
        out = dict(row)
        out["reply_count"] = sum(1 for r in self.replies.values() if r["review_id"] == row["id"])
        return out

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
        if "FROM labspace.latex_reviews r" in s:
            # 先判 reviews：它的子查询里也出现了 replies 表名
            if "r.id = %s" in s:
                review_id, doc_id, owner = params[0], params[1], params[2]
                row = self.reviews.get(review_id)
                if not row or row["doc_id"] != doc_id or row["owner"] != owner:
                    return []
                return [self._review_row(row)]
            doc_id, owner, limit = params[0], params[1], params[2]
            rows = [r for r in self.reviews.values() if r["doc_id"] == doc_id and r["owner"] == owner]
            rows.sort(key=lambda r: (r["created_at"], r["id"]), reverse=True)
            return [self._review_row(r) for r in rows[:limit]]
        if "FROM labspace.latex_review_replies" in s:
            if "ORDER BY created_at ASC" in s:
                review_id, limit = params[0], params[1]
                rows = [r for r in self.replies.values() if r["review_id"] == review_id]
                rows.sort(key=lambda r: (r["created_at"], r["id"]))
                return [dict(r) for r in rows[:limit]]
            reply_id = params[0]
            row = self.replies.get(reply_id)
            return [dict(row)] if row else []
        if "FROM labspace.latex_events e" in s:
            return self._version_rows(s, params)
        return []

    def _version_rows(self, s: str, params: tuple) -> list[dict[str, Any]]:
        if "e.id = %s" in s:
            version_id, doc_id, owner = params[0], params[1], params[2]
            rows = [
                e
                for e in self.events
                if e["id"] == version_id and e["doc_id"] == doc_id and e["owner"] == owner and e["id"] in self.versions
            ]
            return [{**e, "content": self.versions[e["id"]]["content"]} for e in rows]
        doc_id, owner, limit = params[0], params[1], params[2]
        rows = [
            e
            for e in self.events
            if e["doc_id"] == doc_id and e["owner"] == owner and e["kind"] in ("created", "save", "compile")
        ]
        rows.sort(key=lambda e: (e["created_at"], e["id"]), reverse=True)
        return [{**e, "has_content": e["id"] in self.versions} for e in rows[:limit]]

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
            flags = list(params[0::2])[: len(self.DOC_COLUMNS)]
            values = list(params[1::2])[: len(self.DOC_COLUMNS)]
            for col, flag, value in zip(self.DOC_COLUMNS, flags, values, strict=False):
                if flag:
                    doc[col] = value
            doc["updated_at"] = self._stamp()
            return
        if "INSERT INTO labspace.latex_reviews" in s:
            review_id, doc_id, owner, author, line_from, line_to, quote, comment = params
            self.reviews[review_id] = {
                "id": review_id,
                "doc_id": doc_id,
                "owner": owner,
                "author": author,
                "line_from": line_from,
                "line_to": line_to,
                "quote": quote,
                "comment": comment,
                "status": "open",
                "created_at": self._stamp(),
                "updated_at": self._clock,
            }
            return
        if "UPDATE labspace.latex_reviews SET status" in s:
            status, review_id, doc_id, owner = params
            row = self.reviews.get(review_id)
            if row and row["doc_id"] == doc_id and row["owner"] == owner:
                row["status"] = status
                row["updated_at"] = self._stamp()
            return
        if "DELETE FROM labspace.latex_review_replies" in s:
            review_id = params[0]
            for rid in [r for r, v in self.replies.items() if v["review_id"] == review_id]:
                self.replies.pop(rid, None)
            return
        if "DELETE FROM labspace.latex_reviews" in s:
            review_id, doc_id, owner = params
            row = self.reviews.get(review_id)
            if row and row["doc_id"] == doc_id and row["owner"] == owner:
                self.reviews.pop(review_id, None)
            return
        if "INSERT INTO labspace.latex_review_replies" in s:
            reply_id, review_id, owner, author, content = params
            self.replies[reply_id] = {
                "id": reply_id,
                "review_id": review_id,
                "owner": owner,
                "author": author,
                "content": content,
                "created_at": self._stamp(),
            }
            return
        if "INSERT INTO labspace.latex_versions" in s:
            event_id, doc_id, owner, content = params
            self.versions[event_id] = {
                "event_id": event_id,
                "doc_id": doc_id,
                "owner": owner,
                "content": content,
                "created_at": self._stamp(),
            }
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
        json={"title": "审稿测试稿", "template": "article-cn"},
        cookies=cookies(sub),
        headers=write(),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["document"]["id"]


# ---------------------------------------------------------------- 模板库


def test_templates_list_is_public_library_without_content(client: TestClient) -> None:
    resp = client.get("/api/latex/templates", cookies=cookies())
    assert resp.status_code == 200
    templates = resp.json()["templates"]
    ids = {t["id"] for t in templates}
    # 公共模板库至少覆盖这几种文稿
    # 学位论文模板的 id 从 nwafuthesis 改为 thesis：它现在用 ctexbook 自包含排版，
    # 不再依赖仓库里没有的学校类文件（能直接编译）。
    assert {"article-cn", "article-en", "article-two-column", "thesis", "letter", "beamer"} <= ids
    for tpl in templates:
        assert "content" not in tpl, "模板列表不带源码，源码走单模板接口"
        assert tpl["name"] and tpl["description"]
        assert isinstance(tpl["tags"], list) and tpl["tags"]


def test_single_template_returns_source(client: TestClient) -> None:
    resp = client.get("/api/latex/templates/article-en", cookies=cookies())
    assert resp.status_code == 200
    tpl = resp.json()["template"]
    assert tpl["id"] == "article-en"
    assert "\\documentclass" in tpl["content"]


def test_unknown_template_is_404(client: TestClient) -> None:
    resp = client.get("/api/latex/templates/not-a-template", cookies=cookies())
    assert resp.status_code == 404


def test_thesis_template_compiles_without_extra_class_file() -> None:
    """学位论文模板必须**开箱可编译**，并说明怎么换成学校官方类文件。

    以前这条断言要求模板里写 `\\documentclass{nwafuthesis}` 且"必须先上传类文件"，
    而仓库里根本没有那个类文件 —— 用户一点编译就停在
    "File `nwafuthesis.cls' not found"。现在默认用 ctexbook，官方类文件作为
    可选路径写在注释里（素材上传后换一行即可）。
    """
    from app.latex import TEMPLATES

    tpl = next(t for t in TEMPLATES if t["id"] == "thesis")
    assert "\\documentclass[UTF8,zihao=-4,openany]{ctexbook}" in tpl["content"]
    # 不依赖任何外部类文件
    assert "\\documentclass{nwafuthesis}" not in tpl["content"]
    # 但要把"怎么换成官方模板"讲清楚
    assert "nwafuthesis" in tpl["content"]
    assert "素材" in tpl["content"]


# ---------------------------------------------------------------- 批注 CRUD


def test_review_create_list_and_delete(client: TestClient, fake: FakeDb) -> None:
    doc_id = make_doc(client)
    resp = client.post(
        f"/api/latex/documents/{doc_id}/reviews",
        json={"lineFrom": 12, "lineTo": 14, "quote": "\\section{引言}", "comment": "这里要补引用"},
        cookies=cookies(),
        headers=write(),
    )
    assert resp.status_code == 200, resp.text
    review = resp.json()["review"]
    assert review["lineFrom"] == 12 and review["lineTo"] == 14
    assert review["status"] == "open"
    assert review["comment"] == "这里要补引用"

    listing = client.get(f"/api/latex/documents/{doc_id}/reviews", cookies=cookies())
    assert listing.status_code == 200
    reviews = listing.json()["reviews"]
    assert len(reviews) == 1
    assert reviews[0]["id"] == review["id"]

    deleted = client.delete(
        f"/api/latex/documents/{doc_id}/reviews/{review['id']}",
        cookies=cookies(),
        headers=write(),
    )
    assert deleted.status_code == 200
    after = client.get(f"/api/latex/documents/{doc_id}/reviews", cookies=cookies())
    assert after.json()["reviews"] == []


def test_review_status_flow(client: TestClient, fake: FakeDb) -> None:
    doc_id = make_doc(client)
    review_id = client.post(
        f"/api/latex/documents/{doc_id}/reviews",
        json={"lineFrom": 3, "lineTo": 3, "quote": "x", "comment": "改这里"},
        cookies=cookies(),
        headers=write(),
    ).json()["review"]["id"]

    accepted = client.patch(
        f"/api/latex/documents/{doc_id}/reviews/{review_id}",
        json={"status": "accepted"},
        cookies=cookies(),
        headers=write(),
    )
    assert accepted.status_code == 200
    assert accepted.json()["review"]["status"] == "accepted"

    rejected = client.patch(
        f"/api/latex/documents/{doc_id}/reviews/{review_id}",
        json={"status": "rejected"},
        cookies=cookies(),
        headers=write(),
    )
    assert rejected.json()["review"]["status"] == "rejected"

    reopened = client.patch(
        f"/api/latex/documents/{doc_id}/reviews/{review_id}",
        json={"status": "open"},
        cookies=cookies(),
        headers=write(),
    )
    assert reopened.json()["review"]["status"] == "open"

    bad = client.patch(
        f"/api/latex/documents/{doc_id}/reviews/{review_id}",
        json={"status": "nonsense"},
        cookies=cookies(),
        headers=write(),
    )
    assert bad.status_code == 400


def test_reply_append_updates_reply_count(client: TestClient, fake: FakeDb) -> None:
    doc_id = make_doc(client)
    review_id = client.post(
        f"/api/latex/documents/{doc_id}/reviews",
        json={"lineFrom": 5, "lineTo": 5, "quote": "q", "comment": "第一条意见"},
        cookies=cookies(),
        headers=write(),
    ).json()["review"]["id"]

    first = client.post(
        f"/api/latex/documents/{doc_id}/reviews/{review_id}/replies",
        json={"content": "已改"},
        cookies=cookies(),
        headers=write(),
    )
    assert first.status_code == 200
    assert first.json()["reply"]["content"] == "已改"

    client.post(
        f"/api/latex/documents/{doc_id}/reviews/{review_id}/replies",
        json={"content": "再看看"},
        cookies=cookies(),
        headers=write(),
    )

    replies = client.get(f"/api/latex/documents/{doc_id}/reviews/{review_id}/replies", cookies=cookies())
    assert replies.status_code == 200
    assert [r["content"] for r in replies.json()["replies"]] == ["已改", "再看看"]

    listing = client.get(f"/api/latex/documents/{doc_id}/reviews", cookies=cookies())
    assert listing.json()["reviews"][0]["replyCount"] == 2


def test_other_user_cannot_touch_reviews(client: TestClient, fake: FakeDb) -> None:
    doc_id = make_doc(client, sub="u1")
    review_id = client.post(
        f"/api/latex/documents/{doc_id}/reviews",
        json={"lineFrom": 1, "lineTo": 1, "quote": "q", "comment": "只给 u1 看"},
        cookies=cookies("u1"),
        headers=write(),
    ).json()["review"]["id"]

    other = cookies("u2")
    assert client.get(f"/api/latex/documents/{doc_id}/reviews", cookies=other).status_code == 404
    assert client.get(f"/api/latex/documents/{doc_id}/reviews/{review_id}/replies", cookies=other).status_code == 404
    assert (
        client.post(
            f"/api/latex/documents/{doc_id}/reviews",
            json={"lineFrom": 1, "lineTo": 1, "quote": "q", "comment": "插队"},
            cookies=other,
            headers=write(),
        ).status_code
        == 404
    )
    assert (
        client.patch(
            f"/api/latex/documents/{doc_id}/reviews/{review_id}",
            json={"status": "accepted"},
            cookies=other,
            headers=write(),
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/latex/documents/{doc_id}/reviews/{review_id}/replies",
            json={"content": "插队回复"},
            cookies=other,
            headers=write(),
        ).status_code
        == 404
    )
    assert (
        client.delete(
            f"/api/latex/documents/{doc_id}/reviews/{review_id}",
            cookies=other,
            headers=write(),
        ).status_code
        == 404
    )
    # u1 的批注还在
    assert len(client.get(f"/api/latex/documents/{doc_id}/reviews", cookies=cookies("u1")).json()["reviews"]) == 1


def test_review_writes_require_csrf(client: TestClient, fake: FakeDb) -> None:
    doc_id = make_doc(client)
    resp = client.post(
        f"/api/latex/documents/{doc_id}/reviews",
        json={"lineFrom": 1, "lineTo": 1, "quote": "q", "comment": "没有 CSRF 头"},
        cookies=cookies(),
    )
    assert resp.status_code == 403


def test_review_on_unknown_document_is_404(client: TestClient, fake: FakeDb) -> None:
    resp = client.get("/api/latex/documents/does-not-exist/reviews", cookies=cookies())
    assert resp.status_code == 404


# ---------------------------------------------------------------- 版本


def test_versions_track_creation_and_save(client: TestClient, fake: FakeDb) -> None:
    doc_id = make_doc(client)
    listing = client.get(f"/api/latex/documents/{doc_id}/versions", cookies=cookies())
    assert listing.status_code == 200
    versions = listing.json()["versions"]
    assert len(versions) == 1
    assert versions[0]["kind"] == "created"
    assert versions[0]["hasContent"] is True

    client.patch(
        f"/api/latex/documents/{doc_id}",
        json={"content": "\\documentclass{article}\\begin{document}new\\end{document}"},
        cookies=cookies(),
        headers=write(),
    )

    versions = client.get(f"/api/latex/documents/{doc_id}/versions", cookies=cookies()).json()["versions"]
    assert [v["kind"] for v in versions] == ["save", "created"]

    detail = client.get(f"/api/latex/documents/{doc_id}/versions/{versions[0]['id']}", cookies=cookies())
    assert detail.status_code == 200
    assert "new" in detail.json()["version"]["content"]


def test_versions_are_owner_scoped(client: TestClient, fake: FakeDb) -> None:
    doc_id = make_doc(client, sub="u1")
    assert client.get(f"/api/latex/documents/{doc_id}/versions", cookies=cookies("u2")).status_code == 404
