"""文献库（多库 + 文件夹）接口契约。

跟真实 PostgreSQL 对话：建表用生产 DDL（``app.db.SCHEMA``），因此这份测试同时
守住「历史文献无需迁移」和「删除非空库/文件夹必须显式指定去处」这两条底线。

需要一个可写的 PostgreSQL：默认连本机开发库，可用 ``LABSPACE_TEST_DSN`` 覆盖；
连不上就整体跳过，不影响其余测试。
"""
from __future__ import annotations

import os
import time
import uuid
from collections.abc import Iterator
from typing import Any

import jwt
import psycopg2
import pytest
from fastapi.testclient import TestClient

from app import db, main
from app.config import settings

CSRF = "csrf-token-for-test"
DEFAULT_DSN = "postgresql://labtest:labtest@127.0.0.1:5433/labtest"


def _dsn() -> str:
    return os.getenv("LABSPACE_TEST_DSN") or DEFAULT_DSN


@pytest.fixture(scope="module")
def pg() -> Iterator[Any]:
    """一个可写的 PostgreSQL 连接池句柄；连不上就跳过整份测试。"""
    try:
        conn = psycopg2.connect(_dsn())
    except Exception as exc:  # noqa: BLE001 - 环境没装数据库时跳过即可
        pytest.skip(f"需要 PostgreSQL 测试库（LABSPACE_TEST_DSN）：{exc}")
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute("DROP SCHEMA IF EXISTS labspace CASCADE")
        cur.execute("DROP DOMAIN IF EXISTS public.vector")
        # pgvector 不一定装得上，用文本域顶替 embedding 列，保证 DDL 能整体跑通
        cur.execute("CREATE DOMAIN public.vector AS text")
        cur.execute(db.SCHEMA)
    yield conn
    conn.close()


@pytest.fixture
def client(pg: Any, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """把应用真的指到测试库上：跑的是生产 SQL 与生产 DDL，不是假数据。"""
    with pg.cursor() as cur:
        cur.execute("TRUNCATE labspace.literature_library, labspace.literature_folder, labspace.labops_literature")
        cur.execute("DELETE FROM labspace.session_revocation")
    old_pool = db._pool
    old_dsn = db.settings.db_dsn
    monkeypatch.setattr(db, "_pool", None)
    object.__setattr__(db.settings, "db_dsn", _dsn())
    try:
        yield TestClient(main.app)
    finally:
        pool = db._pool
        db._pool = old_pool
        if pool is not None:
            pool.closeall()
        object.__setattr__(db.settings, "db_dsn", old_dsn)


def _session(sub: str) -> dict[str, str]:
    now = int(time.time())
    token = jwt.encode(
        {"sub": sub, "email": f"{sub}@example.org", "name": sub, "roles": [], "iat": now, "exp": now + 3600},
        settings.session_secret,
        algorithm="HS256",
    )
    return {settings.cookie_name: token, settings.csrf_cookie: CSRF}


def _write() -> dict[str, str]:
    return {"X-CSRF-Token": CSRF, "Origin": settings.allowed_origins[0]}


def _insert_literature(pg: Any, owner: str, title: str, library_id: str = "", folder_id: str = "") -> str:
    item_id = "lit-" + uuid.uuid4().hex[:10]
    with pg.cursor() as cur:
        cur.execute(
            "INSERT INTO labspace.labops_literature (id, owner, title, library_id, folder_id) VALUES (%s,%s,%s,%s,%s)",
            (item_id, owner, title, library_id, folder_id),
        )
    return item_id


def _library(client: TestClient, cookies: dict[str, str], name: str = "课题 A") -> dict[str, Any]:
    resp = client.post("/api/labops/libraries", json={"name": name}, cookies=cookies, headers=_write())
    assert resp.status_code == 200, resp.text
    return resp.json()


def _folder(
    client: TestClient, cookies: dict[str, str], library_id: str, name: str = "方法", parent_id: str = ""
) -> str:
    resp = client.post(
        f"/api/labops/libraries/{library_id}/folders",
        json={"name": name, "parent_id": parent_id},
        cookies=cookies,
        headers=_write(),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def test_default_library_is_created_idempotently(client: TestClient) -> None:
    cookies = _session("u-default")
    first = client.get("/api/labops/libraries", cookies=cookies)
    assert first.status_code == 200
    body = first.json()
    defaults = [lib for lib in body["items"] if lib["is_default"]]
    assert len(defaults) == 1
    assert defaults[0]["name"] == "默认文献库"
    assert body["defaultId"] == defaults[0]["id"]

    second = client.get("/api/labops/libraries", cookies=cookies).json()
    assert second["defaultId"] == body["defaultId"]
    assert len(second["items"]) == 1


def test_legacy_literature_shows_up_in_default_library(client: TestClient, pg: Any) -> None:
    cookies = _session("u-legacy")
    _insert_literature(pg, "u-legacy", "旧文献")
    default_id = client.get("/api/labops/libraries", cookies=cookies).json()["defaultId"]
    items = client.get(f"/api/labops/literature?library_id={default_id}", cookies=cookies).json()["items"]
    assert [i["title"] for i in items] == ["旧文献"]


def test_create_and_rename_library(client: TestClient) -> None:
    cookies = _session("u-crud")
    lib = _library(client, cookies, "表型组学")
    listed = client.get("/api/labops/libraries", cookies=cookies).json()["items"]
    target = next(x for x in listed if x["id"] == lib["id"])
    assert target["name"] == "表型组学"
    assert target["is_default"] is False

    resp = client.patch(
        f"/api/labops/libraries/{lib['id']}",
        json={"name": "表型组学 2024", "description": "课题文献", "color": "#52c41a"},
        cookies=cookies,
        headers=_write(),
    )
    assert resp.status_code == 200
    updated = client.get("/api/labops/libraries", cookies=cookies).json()["items"]
    target = next(x for x in updated if x["id"] == lib["id"])
    assert target["name"] == "表型组学 2024"
    assert target["description"] == "课题文献"
    assert target["color"] == "#52c41a"


def test_delete_non_empty_library_requires_move_to(client: TestClient, pg: Any) -> None:
    cookies = _session("u-del-lib")
    keep = _library(client, cookies, "保留库")
    drop = _library(client, cookies, "待删库")
    _insert_literature(pg, "u-del-lib", "要保留的文献", library_id=drop["id"])

    resp = client.delete(f"/api/labops/libraries/{drop['id']}", cookies=cookies, headers=_write())
    assert resp.status_code == 409
    assert "文献库" in resp.json()["detail"]

    resp = client.delete(
        f"/api/labops/libraries/{drop['id']}?move_to={keep['id']}", cookies=cookies, headers=_write()
    )
    assert resp.status_code == 200, resp.text
    moved = client.get(f"/api/labops/literature?library_id={keep['id']}", cookies=cookies).json()["items"]
    assert [i["title"] for i in moved] == ["要保留的文献"]
    assert client.get(f"/api/labops/libraries/{drop['id']}/folders", cookies=cookies).status_code == 404


def test_default_library_cannot_be_deleted(client: TestClient) -> None:
    cookies = _session("u-del-default")
    default_id = client.get("/api/labops/libraries", cookies=cookies).json()["defaultId"]
    resp = client.delete(f"/api/labops/libraries/{default_id}", cookies=cookies, headers=_write())
    assert resp.status_code == 409


def test_delete_non_empty_folder_requires_move_to(client: TestClient, pg: Any) -> None:
    cookies = _session("u-del-folder")
    lib = _library(client, cookies, "带文件夹的库")
    folder = _folder(client, cookies, lib["id"], "实验记录")
    _insert_literature(pg, "u-del-folder", "夹在文件夹里的文献", library_id=lib["id"], folder_id=folder)

    resp = client.delete(f"/api/labops/folders/{folder}", cookies=cookies, headers=_write())
    assert resp.status_code == 409

    resp = client.delete(f"/api/labops/folders/{folder}?move_to=root", cookies=cookies, headers=_write())
    assert resp.status_code == 200, resp.text
    items = client.get(f"/api/labops/literature?library_id={lib['id']}&folder_id=", cookies=cookies).json()["items"]
    assert [i["title"] for i in items] == ["夹在文件夹里的文献"]
    assert items[0]["folder_id"] == ""


def test_delete_folder_can_move_into_sibling(client: TestClient, pg: Any) -> None:
    cookies = _session("u-move-folder")
    lib = _library(client, cookies, "兄弟文件夹")
    keep = _folder(client, cookies, lib["id"], "保留")
    drop = _folder(client, cookies, lib["id"], "搬走")
    item = _insert_literature(pg, "u-move-folder", "待搬文献", library_id=lib["id"], folder_id=drop)

    resp = client.delete(f"/api/labops/folders/{drop}?move_to={keep}", cookies=cookies, headers=_write())
    assert resp.status_code == 200, resp.text
    items = client.get(f"/api/labops/literature?library_id={lib['id']}&folder_id={keep}", cookies=cookies).json()["items"]
    assert [i["id"] for i in items] == [item]
    assert client.get(f"/api/labops/libraries/{lib['id']}/folders", cookies=cookies).json()["items"]


def test_move_literature_between_libraries_and_folders(client: TestClient, pg: Any) -> None:
    cookies = _session("u-move")
    lib_a = _library(client, cookies, "库 A")
    lib_b = _library(client, cookies, "库 B")
    folder = _folder(client, cookies, lib_b["id"], "综述")
    item = _insert_literature(pg, "u-move", "可移动文献")

    resp = client.post(
        "/api/labops/literature/move",
        json={"ids": [item], "libraryId": lib_b["id"], "folderId": folder},
        cookies=cookies,
        headers=_write(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["moved"] == 1

    in_b = client.get(f"/api/labops/literature?library_id={lib_b['id']}&folder_id={folder}", cookies=cookies).json()["items"]
    assert [i["id"] for i in in_b] == [item]
    in_a = client.get(f"/api/labops/literature?library_id={lib_a['id']}", cookies=cookies).json()["items"]
    assert in_a == []


def test_patch_literature_can_change_library(client: TestClient, pg: Any) -> None:
    cookies = _session("u-patch")
    lib = _library(client, cookies, "目标库")
    item = _insert_literature(pg, "u-patch", "改归属的文献")
    resp = client.patch(
        f"/api/labops/literature/{item}", json={"library_id": lib["id"]}, cookies=cookies, headers=_write()
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["library_id"] == lib["id"]
    in_lib = client.get(f"/api/labops/literature?library_id={lib['id']}", cookies=cookies).json()["items"]
    assert [i["id"] for i in in_lib] == [item]


def test_libraries_are_isolated_between_users(client: TestClient, pg: Any) -> None:
    alice = _session("u-alice")
    bob = _session("u-bob")
    lib = _library(client, alice, "Alice 的库")
    item = _insert_literature(pg, "u-alice", "Alice 的文献", library_id=lib["id"])

    bob_libs = client.get("/api/labops/libraries", cookies=bob).json()["items"]
    assert [x["name"] for x in bob_libs] == ["默认文献库"]
    assert client.get(f"/api/labops/literature?library_id={lib['id']}", cookies=bob).json()["items"] == []
    assert client.get(f"/api/labops/libraries/{lib['id']}/folders", cookies=bob).status_code == 404
    assert client.patch(
        f"/api/labops/libraries/{lib['id']}", json={"name": "被抢"}, cookies=bob, headers=_write()
    ).status_code == 404
    assert client.delete(f"/api/labops/libraries/{lib['id']}", cookies=bob, headers=_write()).status_code == 404
    assert client.patch(
        f"/api/labops/literature/{item}", json={"notes": "偷改"}, cookies=bob, headers=_write()
    ).status_code == 404
    assert client.post(
        "/api/labops/literature/move",
        json={"ids": [item], "libraryId": lib["id"], "folderId": ""},
        cookies=bob,
        headers=_write(),
    ).status_code == 404


def test_folder_cannot_be_moved_into_its_own_child(client: TestClient) -> None:
    cookies = _session("u-cycle")
    lib = _library(client, cookies, "循环库")
    parent = _folder(client, cookies, lib["id"], "父")
    child = _folder(client, cookies, lib["id"], "子", parent_id=parent)
    resp = client.patch(
        f"/api/labops/folders/{parent}", json={"parent_id": child}, cookies=cookies, headers=_write()
    )
    assert resp.status_code == 422
