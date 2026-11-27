"""账号 SQL 边界回归：值必须绑定，表/列名必须经 Identifier 转义。"""
from __future__ import annotations

from types import TracebackType
from typing import Any

import pytest
from psycopg2 import sql

from app import accounts


class _Cursor:
    def __init__(self, conn: _Connection) -> None:
        self.conn = conn
        self.calls: list[dict[str, Any]] = []
        self.rows: list[dict[str, Any]] = []
        self.rowcount = 1
        self.error: Exception | None = None

    def __enter__(self) -> _Cursor:
        return self

    def __exit__(
        self,
        _exc_type: type[BaseException] | None,
        _exc: BaseException | None,
        _tb: TracebackType | None,
    ) -> bool:
        return False

    def execute(self, **kwargs: Any) -> None:
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error

    def fetchall(self) -> list[dict[str, Any]]:
        return self.rows


class _Connection:
    def __init__(self) -> None:
        self.cursor_obj = _Cursor(self)
        self.commits = 0
        self.rollbacks = 0
        self.returned = 0

    def cursor(self, **_kwargs: Any) -> _Cursor:
        return self.cursor_obj

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


class _Pool:
    def __init__(self, conn: _Connection) -> None:
        self.conn = conn

    def getconn(self) -> _Connection:
        return self.conn

    def putconn(self, conn: _Connection) -> None:
        assert conn is self.conn
        self.conn.returned += 1


@pytest.fixture()
def casdoor_db(monkeypatch: pytest.MonkeyPatch) -> _Connection:
    conn = _Connection()
    monkeypatch.setattr(accounts, "_get_pool", lambda: _Pool(conn))
    return conn


def test_query_binds_values_separately(casdoor_db: _Connection) -> None:
    statement = 'SELECT name FROM public."user" WHERE owner = %s AND name = %s'
    params = ("built-in", "alice'; DROP TABLE public.\"user\"; --")
    casdoor_db.cursor_obj.rows = [{"name": "alice"}]

    assert accounts._query(statement, params) == [{"name": "alice"}]
    assert casdoor_db.cursor_obj.calls == [{"query": statement, "vars": params}]
    assert casdoor_db.commits == 1
    assert casdoor_db.returned == 1


def test_execute_binds_values_and_rolls_back(casdoor_db: _Connection) -> None:
    statement = 'UPDATE public."user" SET name = %s WHERE owner = %s AND name = %s'
    params = ("alice", "built-in", "old-name")
    casdoor_db.cursor_obj.rowcount = 1
    assert accounts._execute(statement, params) == 1
    assert casdoor_db.cursor_obj.calls == [{"query": statement, "vars": params}]
    assert casdoor_db.commits == 1

    casdoor_db.cursor_obj.error = RuntimeError("write failed")
    with pytest.raises(RuntimeError, match="write failed"):
        accounts._execute(statement, params)
    assert casdoor_db.rollbacks == 1
    assert casdoor_db.returned == 2


@pytest.mark.asyncio
async def test_delete_account_quotes_identifiers_and_binds_subject(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    subject = "user-id-123"
    current = {
        "id": subject,
        "name": "alice",
        "email": "",
        "groups": [],
        "is_deleted": False,
        "display_name": "Alice",
        "created_time": "",
    }
    labspace_calls: list[tuple[sql.Composed, tuple[Any, ...]]] = []
    casdoor_calls: list[tuple[Any, tuple[Any, ...]]] = []

    monkeypatch.setattr(accounts, "_get_user", lambda _name: current)
    monkeypatch.setattr(accounts.db, "revoke_sessions", lambda *_args: None)
    monkeypatch.setattr(accounts, "_audit", lambda *_args, **_kwargs: None)

    async def deprovision(_key: str) -> tuple[bool, dict[str, Any]]:
        return True, {}

    monkeypatch.setattr(accounts, "deprovision_user", deprovision)

    def labspace_query(*, statement: Any, params: tuple = ()) -> list[dict[str, Any]]:
        assert isinstance(statement, sql.Composed)
        labspace_calls.append((statement, params))
        return []

    def casdoor_execute(statement: Any, params: tuple = ()) -> int:
        casdoor_calls.append((statement, params))
        return 1

    monkeypatch.setattr(accounts.db, "query", labspace_query)
    monkeypatch.setattr(accounts, "_execute", casdoor_execute)

    result = await accounts.delete_account(
        "alice", accounts.AccountDeleteConfirm(confirm="alice"), {"name": "admin"}
    )

    assert result["ok"] is True
    assert len(labspace_calls) == len(accounts._LABSPACE_USER_TABLES)
    for (table, column), (statement, params) in zip(
        accounts._LABSPACE_USER_TABLES, labspace_calls, strict=True
    ):
        parts = list(statement)
        assert isinstance(parts[1], sql.Identifier)
        assert parts[1].strings == (table,)
        assert isinstance(parts[3], sql.Identifier)
        assert parts[3].strings == (column,)
        assert params == (subject,)

    assert len(casdoor_calls) == len(accounts._CASDOOR_USER_TABLES) + 1
    assert all(params == (accounts.OWNER, "alice") for _, params in casdoor_calls)
    for (table, column), (statement, _params) in zip(
        accounts._CASDOOR_USER_TABLES, casdoor_calls[:-1], strict=True
    ):
        parts = list(statement)
        assert isinstance(parts[1], sql.Identifier)
        assert parts[1].strings == (table,)
        assert isinstance(parts[3], sql.Identifier)
        assert parts[3].strings == (column,)
    assert casdoor_calls[-1][0] == 'DELETE FROM public."user" WHERE owner = %s AND name = %s'
