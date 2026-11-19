"""课题资料目录 / 组会周目录 / 种子表模板的接口契约。

三层都不连真实依赖：
* Casdoor 用内存账号表打桩（``admin_research._casdoor_*``）；
* 文件核心用内存 ACL 与条目列表打桩（``admin_research._acl_state`` 等）；
* 门户库与 Baserow 同样用内存替身。

断言的是**真实的路由与权限判定**，不是"给什么返回什么"的空壳。
"""
from __future__ import annotations

import json
import time
from datetime import date
from types import SimpleNamespace
from typing import Any

import httpx
import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import admin_research, baserow, db, main, meetings, seed_tables
from app.config import settings

CSRF = "csrf-token-for-test"

# ------------------------------------------------------------------ 测试数据

CASDOOR_USERS: list[dict[str, Any]] = [
    {
        "id": "u-adminlegacy",
        "name": "adminlegacy",
        "display_name": "陈同学",
        "email": "adminlegacy@lab.example",
        "groups": ["lab-student"],
        "created_time": "2024-09-01T10:00:00+08:00",
    },
    {
        "id": "u-lisi",
        "name": "lisi",
        "display_name": "",
        "email": "lisi@lab.example",
        "groups": ["lab-master"],
        "created_time": "2025-03-15T09:00:00+08:00",
    },
    {
        "id": "u-teacher",
        "name": "teacher1",
        "display_name": "王老师",
        "email": "teacher1@lab.example",
        "groups": ["lab-teacher"],
        "created_time": "2023-01-01T00:00:00+08:00",
    },
]

#: 文件核心里的授权状态（键是文件身份键：邮箱前缀）。
ACL_STATE: dict[str, Any] = {
    "scopes": {
        "adminlegacy": [
            {"source": "research", "path": "2024-09-01-陈同学", "access": "write"},
            {"source": "public", "path": "", "access": "read"},
        ],
        "lisi": [],
    },
    "directories": {"research": ["", "2024-09-01-陈同学"], "meeting": ["", "2026-W48"]},
    "groups": [],
}

#: 文件核心里的实际条目（目录 + 文件）。
ENTRIES: list[dict[str, Any]] = [
    {"source": "research", "path": "2024-09-01-陈同学", "name": "2024-09-01-陈同学", "dir": True, "size": 0},
    {"source": "research", "path": "2024-09-01-陈同学/data.xlsx", "name": "data.xlsx", "dir": False, "size": 120},
    {"source": "meeting", "path": "2026-W48", "name": "2026-W48", "dir": True, "size": 0},
    {"source": "meeting", "path": "2026-W48/周报.pdf", "name": "周报.pdf", "dir": False, "size": 2048},
]


def _session(sub: str, roles: list[str], name: str = "测试") -> str:
    return jwt.encode(
        {
            "sub": sub,
            "email": f"{sub}@lab.example",
            "name": name,
            "roles": roles,
            "exp": int(time.time()) + 3600,
        },
        settings.session_secret,
        algorithm="HS256",
    )


class FakeMeetingStore:
    """门户库里的组会授权名单与压缩状态（内存版）。"""

    def __init__(self) -> None:
        self.grants: dict[tuple[str, str], dict[str, Any]] = {}
        self.state: dict[str, dict[str, Any]] = {}

    def _db_grants(self, year_week: str) -> list[dict[str, Any]]:
        return [
            dict(row)
            for (week, _uid), row in sorted(self.grants.items())
            if week == year_week
        ]

    def _db_all_weeks(self) -> list[str]:
        return sorted({week for (week, _uid) in self.grants})

    def _db_granted_weeks(self, user_id: str) -> set[str]:
        return {week for (week, uid) in self.grants if uid == user_id}

    def _db_add_grant(self, year_week: str, user_id: str, granted_by: str) -> None:
        self.grants[(year_week, user_id)] = {
            "year_week": year_week,
            "user_id": user_id,
            "granted_by": granted_by,
            "created_at": "2026-11-25 10:00:00",
        }

    def _db_remove_grant(self, year_week: str, user_id: str) -> None:
        self.grants.pop((year_week, user_id), None)

    def _db_week_state(self, year_week: str) -> dict[str, Any]:
        return self.state.get(year_week, {"compressed": False, "compressed_at": None})

    def _db_mark_compressed(self, year_weeks: list[str]) -> None:
        for week in year_weeks:
            self.state[week] = {"compressed": True, "compressed_at": "2026-11-25 10:00:00"}


@pytest.fixture()
def world(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """把 Casdoor、文件核心与门户库都换成内存替身。"""
    store = FakeMeetingStore()
    written: dict[str, list[dict[str, Any]]] = {}
    state: dict[str, Any] = json.loads(json.dumps(ACL_STATE))

    def by_name(name: str) -> dict[str, Any] | None:
        for row in CASDOOR_USERS:
            if row["name"] == str(name or "").strip().lower():
                return dict(row)
        return None

    def by_id(uid: str) -> dict[str, Any] | None:
        for row in CASDOOR_USERS:
            if row["id"] == str(uid or "").strip():
                return dict(row)
        return None

    async def acl_state() -> dict[str, Any] | None:
        return json.loads(json.dumps(state))

    async def source_entries(request: Any, source: str) -> list[dict[str, Any]] | None:
        return [e for e in ENTRIES if e["source"] == source]

    async def ensure_source_dir(request: Any, source: str, path: str) -> tuple[bool, str]:
        return True, ""

    async def write_identity_grants(key: str, grants: list[dict[str, Any]]) -> tuple[bool, str]:
        written[key] = grants
        state.setdefault("scopes", {})[key] = grants
        return True, ""

    monkeypatch.setattr(admin_research, "_casdoor_users", lambda: [dict(r) for r in CASDOOR_USERS])
    monkeypatch.setattr(admin_research, "_casdoor_user_by_name", by_name)
    monkeypatch.setattr(admin_research, "_casdoor_user_by_id", by_id)
    monkeypatch.setattr(admin_research, "_acl_state", acl_state)
    monkeypatch.setattr(admin_research, "source_entries", source_entries)
    monkeypatch.setattr(admin_research, "ensure_source_dir", ensure_source_dir)
    monkeypatch.setattr(admin_research, "write_identity_grants", write_identity_grants)
    monkeypatch.setattr(meetings, "write_identity_grants", write_identity_grants)
    monkeypatch.setattr(meetings, "source_entries", source_entries)

    async def fake_user_request(
        method: str,
        path: str,
        request: Any,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any = None,
        files: Any = None,
    ) -> tuple[int, Any]:
        """文件核心的公开接口替身。

        写目录级授权前必须先把目录建出来（文件核心写 ACL 时要求目标目录存在），
        所以这里要应答 ensure-meeting-folder。
        """
        if path.endswith("/ensure-meeting-folder"):
            week = str((json_body or {}).get("yearWeek") or "")
            return 200, {"path": week}
        return 200, {"entry": {"path": "2026-W48/x.pdf", "name": "x.pdf", "size": 9}}

    monkeypatch.setattr(meetings, "labgo_user_request", fake_user_request)

    for name in (
        "_db_grants",
        "_db_all_weeks",
        "_db_granted_weeks",
        "_db_add_grant",
        "_db_remove_grant",
        "_db_week_state",
        "_db_mark_compressed",
    ):
        monkeypatch.setattr(meetings, name, getattr(store, name))

    monkeypatch.setattr(db, "revoked_before", lambda subject: None)
    return SimpleNamespace(store=store, written=written)


def _client() -> TestClient:
    return TestClient(main.app)


def _cookies(sub: str, roles: list[str], name: str = "测试") -> dict[str, str]:
    return {
        "labspace_session": _session(sub, roles, name),
        settings.csrf_cookie: CSRF,
    }


def _write_headers() -> dict[str, str]:
    return {"X-CSRF-Token": CSRF, "Origin": settings.allowed_origins[0]}


# ------------------------------------------------------------------ 命名规则

def test_research_folder_name_uses_join_date_and_display_name() -> None:
    """目录名 = {进组时间}-{姓名}；姓名取 display_name，为空退回登录名。"""
    assert (
        admin_research.research_folder_name("2024-09-01T10:00:00+08:00", "陈同学", "adminlegacy")
        == "2024-09-01-陈同学"
    )
    # display_name 为空时退回登录名
    assert (
        admin_research.research_folder_name("2025-03-15T09:00:00+08:00", "", "lisi")
        == "2025-03-15-lisi"
    )
    # 缺进组时间不给目录名（宁可报错也不要写错的名字）
    with pytest.raises(ValueError):
        admin_research.research_folder_name("", "陈同学", "adminlegacy")


def test_iso_week_label_uses_iso_calendar() -> None:
    """周目录名按 ISO 周：2026-W48。"""
    assert meetings.iso_week_label(date(2026, 11, 25)) == "2026-W48"
    assert meetings.iso_week_label(date(2026, 11, 23)) == "2026-W48"
    # 跨年周仍属于上一个 ISO 年
    assert meetings.iso_week_label(date(2027, 1, 3)) == "2026-W53"
    assert meetings.parse_year_week("2026-w48") == "2026-W48"
    assert meetings.parse_year_week(" 2026-W48 ") == "2026-W48"
    with pytest.raises(HTTPException) as excinfo:
        meetings.parse_year_week("2026-48")
    assert excinfo.value.status_code == 400
    with pytest.raises(HTTPException):
        meetings.parse_year_week("2026-W99")


# ------------------------------------------------------------------ 课题资料

def test_student_only_gets_own_research_folder(world: SimpleNamespace) -> None:
    """学生侧只返回自己的目录，拿不到别人的。"""
    client = _client()
    resp = client.get("/api/research/mine", cookies=_cookies("u-adminlegacy", ["lab-student"]))
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["folder"]["name"] == "2024-09-01-陈同学"
    assert payload["folder"]["path"] == "2024-09-01-陈同学"
    assert payload["folder"]["source"] == "research"

    other = client.get("/api/research/mine", cookies=_cookies("u-lisi", ["lab-master"]))
    assert other.status_code == 200, other.text
    assert other.json()["folder"]["name"] == "2025-03-15-lisi"
    # 另一个学生的目录名不出现在响应里
    assert "2024-09-01-陈同学" not in other.text


def test_admin_folder_list_merges_accounts_and_storage(world: SimpleNamespace) -> None:
    """目录清单按姓名排序，并带上进组时间与已用空间。"""
    client = _client()
    resp = client.get(
        "/api/admin/research/folders", cookies=_cookies("u-teacher", ["lab-teacher"])
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    folders = payload["folders"]
    assert [f["name"] for f in folders] == ["2024-09-01-陈同学"]
    assert folders[0]["displayName"] == "陈同学"
    assert folders[0]["joinedAt"] == "2024-09-01"
    assert folders[0]["usedBytes"] == 120
    assert folders[0]["granted"] is True


def test_admin_cannot_manage_research_folders(world: SimpleNamespace) -> None:
    """没有课题资料权限的账号不能开目录。"""
    client = _client()
    resp = client.post(
        "/api/admin/research/folders",
        json={"name": "lisi"},
        cookies=_cookies("u-lisi", ["lab-master"]),
        headers=_write_headers(),
    )
    assert resp.status_code == 403


def test_create_and_revoke_research_folder(world: SimpleNamespace) -> None:
    """开目录写一条学生授权；收回授权时数据保留。"""
    client = _client()
    resp = client.post(
        "/api/admin/research/folders",
        json={"name": "lisi"},
        cookies=_cookies("u-teacher", ["lab-teacher"]),
        headers=_write_headers(),
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["folder"]["name"] == "2025-03-15-lisi"

    grants = world.written["lisi"]
    research = [g for g in grants if g["source"] == "research"]
    assert research == [
        {
            "source": "research",
            "path": "2025-03-15-lisi",
            "view": True,
            "download": True,
            "create": True,
            "modify": True,
        }
    ]

    revoke = client.delete(
        "/api/admin/research/folders/lisi",
        cookies=_cookies("u-teacher", ["lab-teacher"]),
        headers=_write_headers(),
    )
    assert revoke.status_code == 200, revoke.text
    assert revoke.json()["dataKept"] is True
    # 收回后不再有 research 授权，其它源的授权保留
    assert [g for g in world.written["lisi"] if g["source"] == "research"] == []


# ------------------------------------------------------------------ 组会汇报

def test_meeting_grant_add_and_remove(world: SimpleNamespace) -> None:
    """周目录授权增删：门户名单与文件核心 ACL 同时变。"""
    client = _client()
    resp = client.post(
        "/api/meetings/weeks/2026-W48/grant",
        json={"userId": "u-lisi"},
        cookies=_cookies("u-teacher", ["lab-teacher"]),
        headers=_write_headers(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["yearWeek"] == "2026-W48"
    assert ("2026-W48", "u-lisi") in world.store.grants

    grants = world.written["lisi"]
    assert {
        "source": "meeting",
        "path": "2026-W48",
        "view": True,
        "download": True,
        "create": True,
        "modify": True,
    } in grants

    revoke = client.delete(
        "/api/meetings/weeks/2026-W48/grant/u-lisi",
        cookies=_cookies("u-teacher", ["lab-teacher"]),
        headers=_write_headers(),
    )
    assert revoke.status_code == 200, revoke.text
    assert ("2026-W48", "u-lisi") not in world.store.grants
    assert [g for g in world.written["lisi"] if g["source"] == "meeting"] == []


def test_unauthorized_user_cannot_read_week_files(world: SimpleNamespace) -> None:
    """未授权的人访问某一周目录返回 403。"""
    client = _client()
    resp = client.get(
        "/api/meetings/weeks/2026-W48/files", cookies=_cookies("u-adminlegacy", ["lab-student"])
    )
    assert resp.status_code == 403
    assert "周目录" in resp.json()["detail"]

    # 授权之后就能看
    client.post(
        "/api/meetings/weeks/2026-W48/grant",
        json={"userId": "u-adminlegacy"},
        cookies=_cookies("u-teacher", ["lab-teacher"]),
        headers=_write_headers(),
    )
    allowed = client.get(
        "/api/meetings/weeks/2026-W48/files", cookies=_cookies("u-adminlegacy", ["lab-student"])
    )
    assert allowed.status_code == 200, allowed.text
    assert [f["name"] for f in allowed.json()["files"]] == ["周报.pdf"]


def test_meeting_upload_requires_authorization(world: SimpleNamespace) -> None:
    """未授权的人不能往某周目录上传。"""
    client = _client()
    resp = client.post(
        "/api/meetings/upload",
        files={"file": ("周报.pdf", b"pdf-bytes", "application/pdf")},
        data={"yearWeek": "2026-W48"},
        cookies=_cookies("u-adminlegacy", ["lab-student"]),
        headers=_write_headers(),
    )
    assert resp.status_code == 403


def test_meeting_upload_archives_by_uploader_and_week(
    world: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    """上传落到 meeting/<年-周>/，文件名带上传人姓名与时间戳。"""
    calls: list[dict[str, Any]] = []

    async def fake_user_request(
        method: str,
        path: str,
        request: Any,
        *,
        params: Any = None,
        json_body: Any = None,
        files: Any = None,
    ) -> tuple[int, Any]:
        calls.append({"method": method, "path": path, "params": params, "files": files})
        if path.endswith("/ensure-meeting-folder"):
            return 200, {"path": "2026-W48"}
        return 200, {"entry": {"path": "2026-W48/x.pdf", "name": "x.pdf", "size": 9}}

    monkeypatch.setattr(meetings, "labgo_user_request", fake_user_request)
    client = _client()
    client.post(
        "/api/meetings/weeks/2026-W48/grant",
        json={"userId": "u-adminlegacy"},
        cookies=_cookies("u-teacher", ["lab-teacher"]),
        headers=_write_headers(),
    )
    resp = client.post(
        "/api/meetings/upload",
        files={"file": ("周报.pdf", b"pdf-bytes", "application/pdf")},
        data={"yearWeek": "2026-W48"},
        cookies=_cookies("u-adminlegacy", ["lab-student"]),
        headers=_write_headers(),
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["yearWeek"] == "2026-W48"
    assert payload["uploadedBy"] == "陈同学"

    upload = [c for c in calls if c["path"].endswith("/upload")]
    assert len(upload) == 1
    assert upload[0]["params"] == {"source": "meeting", "dir": "2026-W48"}
    # 归档文件名：上传人姓名 + 时间戳
    sent_name = upload[0]["files"]["file"][0]
    assert sent_name.startswith("陈同学_")
    assert sent_name.endswith(".pdf")


def test_week_list_only_shows_authorized_weeks(world: SimpleNamespace) -> None:
    """学生只看得到自己被授权的周目录；老师看得到全部。"""
    client = _client()
    client.post(
        "/api/meetings/weeks/2026-W48/grant",
        json={"userId": "u-lisi"},
        cookies=_cookies("u-teacher", ["lab-teacher"]),
        headers=_write_headers(),
    )
    student = client.get("/api/meetings/weeks", cookies=_cookies("u-adminlegacy", ["lab-student"]))
    assert student.status_code == 200, student.text
    assert student.json()["weeks"] == []

    granted = client.get("/api/meetings/weeks", cookies=_cookies("u-lisi", ["lab-master"]))
    assert [w["yearWeek"] for w in granted.json()["weeks"]] == ["2026-W48"]
    assert granted.json()["weeks"][0]["fileCount"] == 1
    assert granted.json()["weeks"][0]["sizeBytes"] == 2048

    teacher = client.get("/api/meetings/weeks", cookies=_cookies("u-teacher", ["lab-teacher"]))
    assert [w["yearWeek"] for w in teacher.json()["weeks"]] == ["2026-W48"]


def test_compress_reports_go_core_not_ready(world: SimpleNamespace, monkeypatch: pytest.MonkeyPatch) -> None:
    """Go 侧压缩能力未就绪时明确报错，不静默成功。"""

    async def no_admin(method: str, path: str, payload: Any = None) -> tuple[bool, Any]:
        return False, "文件核心尚未提供组会压缩能力（待 Go 侧就绪）"

    async def no_user(
        method: str,
        path: str,
        request: Any,
        *,
        params: Any = None,
        json_body: Any = None,
        files: Any = None,
    ) -> tuple[int, Any]:
        return 404, {"error": "route not found"}

    monkeypatch.setattr(meetings, "labgo_admin", no_admin)
    monkeypatch.setattr(meetings, "labgo_user_request", no_user)
    client = _client()
    resp = client.post(
        "/api/meetings/compress",
        json={"keepWeeks": 8},
        cookies=_cookies("u-teacher", ["lab-teacher"]),
        headers=_write_headers(),
    )
    assert resp.status_code == 502
    assert "待 Go 侧就绪" in resp.json()["detail"]


# ------------------------------------------------------------------ 种子表模板

class FakeBaserow:
    """内存版 Baserow：只实现种子表模板用到的接口。"""

    def __init__(self) -> None:
        self.workspaces: list[dict[str, Any]] = []
        self.applications: dict[int, list[dict[str, Any]]] = {}
        self.tables: dict[int, list[dict[str, Any]]] = {}
        self.fields: dict[int, list[dict[str, Any]]] = {}
        self.rows: dict[int, list[dict[str, Any]]] = {}
        self.calls: list[tuple[str, str]] = []
        self._seq = 100

    def _id(self) -> int:
        self._seq += 1
        return self._seq

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, path))
        payload = body if isinstance(body, dict) else {}
        parts = [p for p in path.split("/") if p]

        if path.rstrip("/") == "/api/workspaces":
            if request.method == "GET":
                return httpx.Response(200, json=self.workspaces)
            wid = self._id()
            self.workspaces.append({"id": wid, "name": payload.get("name")})
            return httpx.Response(200, json={"id": wid, "name": payload.get("name")})

        if len(parts) == 4 and parts[:2] == ["api", "applications"] and parts[2] == "workspace":
            wid = int(parts[3])
            if request.method == "GET":
                return httpx.Response(200, json=self.applications.get(wid, []))
            did = self._id()
            self.applications.setdefault(wid, []).append(
                {"id": did, "name": payload.get("name"), "type": payload.get("type")}
            )
            return httpx.Response(
                200, json={"id": did, "name": payload.get("name"), "type": payload.get("type")}
            )

        if len(parts) == 5 and parts[:3] == ["api", "database", "tables"] and parts[3] == "database":
            did = int(parts[4])
            if request.method == "GET":
                return httpx.Response(200, json=self.tables.get(did, []))
            tid = self._id()
            self.tables.setdefault(did, []).append({"id": tid, "name": payload.get("name")})
            # Baserow 建表模板：主字段 Name + Notes/Active 两列 + 两行空行
            self.fields[tid] = [
                {"id": self._id(), "name": "Name", "type": "text", "primary": True},
                {"id": self._id(), "name": "Notes", "type": "long_text", "primary": False},
                {"id": self._id(), "name": "Active", "type": "boolean", "primary": False},
            ]
            self.rows[tid] = [{"id": self._id(), "Name": ""}, {"id": self._id(), "Name": ""}]
            return httpx.Response(200, json={"id": tid, "name": payload.get("name")})

        if len(parts) == 5 and parts[:3] == ["api", "database", "fields"] and parts[3] == "table":
            tid = int(parts[4])
            if request.method == "GET":
                return httpx.Response(200, json=self.fields.get(tid, []))
            fid = self._id()
            field = {
                "id": fid,
                "name": payload.get("name"),
                "type": payload.get("type"),
                "primary": False,
                "select_options": payload.get("select_options") or [],
            }
            if payload.get("type") == "number":
                field["number_decimal_places"] = payload.get("number_decimal_places", 0)
                field["number_negative"] = payload.get("number_negative", False)
            self.fields.setdefault(tid, []).append(field)
            return httpx.Response(200, json=field)

        if len(parts) == 4 and parts[:3] == ["api", "database", "fields"]:
            fid = int(parts[3])
            for fields in self.fields.values():
                for field in fields:
                    if field["id"] != fid:
                        continue
                    if request.method == "DELETE":
                        fields.remove(field)
                        return httpx.Response(204)
                    for key in ("name", "number_decimal_places", "number_negative", "select_options"):
                        if key in payload:
                            field[key] = payload[key]
                    return httpx.Response(200, json=field)
            return httpx.Response(404, json={"error": "field not found"})

        if len(parts) >= 5 and parts[:3] == ["api", "database", "rows"] and parts[3] == "table":
            tid = int(parts[4])
            if request.method == "GET":
                return httpx.Response(
                    200, json={"count": len(self.rows.get(tid, [])), "results": self.rows.get(tid, []), "next": None}
                )
            if request.method == "DELETE":
                row_id = int(parts[5])
                self.rows[tid] = [r for r in self.rows.get(tid, []) if r.get("id") != row_id]
                return httpx.Response(204)
            return httpx.Response(200, json={})

        return httpx.Response(404, json={"error": f"unhandled path {path}"})


@pytest.fixture()
def fake_baserow(monkeypatch: pytest.MonkeyPatch) -> FakeBaserow:
    fake = FakeBaserow()
    real_client = httpx.AsyncClient

    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs.pop("transport", None)
        return real_client(*args, transport=httpx.MockTransport(fake.handler), **kwargs)

    monkeypatch.setattr(baserow, "_client", lambda: factory())

    async def fake_admin_token(force: bool = False) -> str:
        return "admin-token"

    monkeypatch.setattr(baserow, "_admin_token", fake_admin_token)
    # 没有配置默认工作区时按名字回落
    monkeypatch.setattr(seed_tables, "_configured_workspace_id", lambda: 0)
    monkeypatch.setattr(db, "revoked_before", lambda subject: None)
    return fake


def test_seed_template_is_idempotent(fake_baserow: FakeBaserow) -> None:
    """第二次调用不重复建工作区 / 库 / 表，只复用。"""
    client = _client()
    admin = _cookies("u-teacher", ["lab-admin"], name="管理员")
    first = client.post("/api/baserow/templates/seed", cookies=admin, headers=_write_headers())
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload["workspaceName"] == "实验室数据"
    assert payload["databaseName"] == "种子"
    assert payload["tableName"] == "种子管理"

    second = client.post("/api/baserow/templates/seed", cookies=admin, headers=_write_headers())
    assert second.status_code == 200, second.text
    again = second.json()
    assert again["tableId"] == payload["tableId"]
    assert again["workspaceId"] == payload["workspaceId"]
    assert again["databaseId"] == payload["databaseId"]

    # 只建过一次工作区 / 数据库 / 表
    assert [p for m, p in fake_baserow.calls if m == "POST" and p == "/api/workspaces/"] == [
        "/api/workspaces/"
    ]
    table_creates = [
        p for m, p in fake_baserow.calls if m == "POST" and p.startswith("/api/database/tables/database/")
    ]
    assert len(table_creates) == 1


def test_seed_template_fields_match_spec(fake_baserow: FakeBaserow) -> None:
    """字段清单与类型按约定下发，主字段是「名称」。"""
    client = _client()
    admin = _cookies("u-teacher", ["lab-admin"], name="管理员")
    resp = client.post("/api/baserow/templates/seed", cookies=admin, headers=_write_headers())
    assert resp.status_code == 200, resp.text
    fields = {f["name"]: f for f in resp.json()["fields"]}
    assert fields["名称"]["primary"] is True
    assert fields["编号"]["type"] == "text"
    assert fields["物种"]["type"] == "text"
    assert fields["来源"]["type"] == "text"
    assert fields["入库日期"]["type"] == "date"
    assert fields["数量"]["type"] == "number"
    assert fields["单位"]["type"] == "text"
    assert fields["存放位置"]["type"] == "text"
    assert fields["存放柜"]["type"] == "text"
    assert fields["发芽率"]["type"] == "number"
    assert fields["活力等级"]["type"] == "single_select"
    assert {o["value"] for o in fields["活力等级"]["select_options"]} == {"高", "中", "低"}
    assert fields["处理方式"]["type"] == "long_text"
    assert fields["备份位置"]["type"] == "text"
    assert fields["是否已备份"]["type"] == "boolean"
    assert fields["备份日期"]["type"] == "date"
    assert fields["负责人"]["type"] == "text"
    assert fields["备注"]["type"] == "long_text"
    assert fields["附件"]["type"] == "file"
    # 建表模板自带的 Notes / Active 不残留
    assert "Notes" not in fields and "Active" not in fields


def test_seed_template_get_returns_ids_and_fields(fake_baserow: FakeBaserow) -> None:
    """GET 返回 workspace / database / table id 与字段清单。"""
    client = _client()
    admin = _cookies("u-teacher", ["lab-admin"], name="管理员")
    created = client.post("/api/baserow/templates/seed", cookies=admin, headers=_write_headers())
    assert created.status_code == 200, created.text

    got = client.get("/api/baserow/templates/seed", cookies=admin)
    assert got.status_code == 200, got.text
    payload = got.json()
    assert payload["tableId"] == created.json()["tableId"]
    assert payload["databaseId"] == created.json()["databaseId"]
    assert payload["workspaceId"] == created.json()["workspaceId"]
    assert len(payload["fields"]) == len(seed_tables.SEED_FIELDS)


def test_seed_template_requires_admin(fake_baserow: FakeBaserow) -> None:
    """普通账号不能建表。"""
    client = _client()
    resp = client.post(
        "/api/baserow/templates/seed",
        cookies=_cookies("u-lisi", ["lab-student"]),
        headers=_write_headers(),
    )
    assert resp.status_code == 403
