"""LabSpace 业务数据（收藏 / 最近访问等）。

使用独立的 labspace 数据库，表名带 labspace 前缀，避免与既有表冲突。
收藏 / 最近访问的浏览器请求现由 Go 核心（internal/portal）处理，
本模块保留同样的实现，作为 Go 不可用时的 /v1/* 兼顶路径。
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any

import psycopg2
import psycopg2.extras
from psycopg2 import pool as pgpool

from .config import settings

log = logging.getLogger("labspace.db")
_pool: pgpool.ThreadedConnectionPool | None = None
_lock = threading.Lock()




def get_pool() -> pgpool.ThreadedConnectionPool:
    global _pool
    if _pool is None:
        with _lock:
            if _pool is None:
                _pool = pgpool.ThreadedConnectionPool(
                    settings.db_pool_min,
                    settings.db_pool_max,
                    dsn=settings.db_dsn,
                )
                conn = _pool.getconn()
                try:
                    # 结构变更走版本化迁移（app/migrations/*.sql），执行过的记在
                    # labspace.schema_migrations：重复启动不会重放，日志里也能看到
                    # 这次到底应用了哪几个文件，而不是一段隐式 DDL。
                    from . import migrate

                    migrate.apply(conn)
                finally:
                    _pool.putconn(conn)
    return _pool


def query(statement: Any, params: tuple = ()) -> list[dict[str, Any]]:
    """执行一条查询。

    ``statement`` 允许传 ``psycopg2.sql.Composed``：表名/列名这类标识符不能
    用占位符传，必须由驱动做转义后拼接。普通 SQL 仍然照常写字符串。
    """
    pool = get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # SAFETY: statement 是字面量或 psycopg2.sql.Composed（编译期常量），
            # 值一律在 params 里由驱动转义；分析器只看到变量就报注入，是误报。
            cur.execute(statement, params)  # noqa: S608, python-sql-injection
            rows = cur.fetchall()
            conn.commit()
            return [dict(r) for r in rows]
    finally:
        pool.putconn(conn)


def query_many(statements: list[tuple[str, tuple]]) -> list[list[dict[str, Any]]]:
    """在**单条连接**上依次执行多条查询，返回与入参同序的结果列表。

    背景：连接池上限可配置（默认 24），如果像工作台首页那样把 12 条查询丢进
    asyncio.gather（每条都经 to_thread 独占一条连接），会直接触发
    psycopg2 的 PoolError: connection pool exhausted。
    批量查询只占一条连接，把 12 次往返压成 1 次线程调度。
    """
    pool = get_pool()
    conn = pool.getconn()
    try:
        out: list[list[dict[str, Any]]] = []
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            for sql, params in statements:
                cur.execute(sql, params)
                out.append([dict(r) for r in cur.fetchall()])
        conn.commit()
        return out
    finally:
        pool.putconn(conn)


def execute(sql: str, params: tuple = ()) -> None:
    pool = get_pool()
    conn = pool.getconn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
        conn.commit()
    finally:
        pool.putconn(conn)


# 会话吊销：门户会话是无状态 HS256 JWT，只校验签名与 exp，因此"禁用/删除账号"
# 本身不会让已经发出的 Cookie 失效。这张表是唯一的失效手段：早于 revoked_at
# 签发的会话一律作废。
_revocation_cache: dict[str, tuple[float, int | None]] = {}
_revocation_lock = threading.Lock()
REVOCATION_TTL = 15.0


def revoke_sessions(subject: str, reason: str = "") -> None:
    execute(
        """
        INSERT INTO labspace.session_revocation (subject, revoked_at, reason)
        VALUES (%s, now(), %s)
        ON CONFLICT (subject) DO UPDATE
          SET revoked_at = greatest(labspace.session_revocation.revoked_at, now()),
              reason = EXCLUDED.reason
        """,
        (subject, reason),
    )
    with _revocation_lock:
        _revocation_cache.pop(subject, None)


def revoked_before(subject: str) -> int | None:
    """返回该主体会话的失效时刻（Unix 秒）；None 表示没有吊销记录。

    查询失败按"未吊销"处理并记日志：数据库抖动不应该把整个实验室踢下线。
    """
    now = time.monotonic()
    with _revocation_lock:
        hit = _revocation_cache.get(subject)
        if hit and now - hit[0] < REVOCATION_TTL:
            return hit[1]
    try:
        rows = query(
            "SELECT extract(epoch FROM revoked_at)::bigint AS at"
            " FROM labspace.session_revocation WHERE subject = %s",
            (subject,),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("session revocation lookup failed for %s: %s (session accepted)", subject, exc)
        return None
    at = int(rows[0]["at"]) if rows else None
    with _revocation_lock:
        _revocation_cache[subject] = (now, at)
    return at


def list_favorites(user_id: str) -> list[str]:
    return [r["service_id"] for r in query("SELECT service_id FROM labspace.favorites WHERE user_id=%s ORDER BY created_at", (user_id,))]


def add_favorite(user_id: str, service_id: str) -> None:
    execute(
        "INSERT INTO labspace.favorites (user_id, service_id) VALUES (%s,%s) ON CONFLICT DO NOTHING",
        (user_id, service_id),
    )


def remove_favorite(user_id: str, service_id: str) -> None:
    execute("DELETE FROM labspace.favorites WHERE user_id=%s AND service_id=%s", (user_id, service_id))


def touch_recent(user_id: str, service_id: str, keep: int = 12) -> None:
    execute(
        """
        INSERT INTO labspace.recent (user_id, service_id, visited_at) VALUES (%s,%s, now())
        ON CONFLICT (user_id, service_id) DO UPDATE SET visited_at = now()
        """,
        (user_id, service_id),
    )
    execute(
        """
        DELETE FROM labspace.recent WHERE user_id=%s AND service_id NOT IN (
            SELECT service_id FROM labspace.recent WHERE user_id=%s ORDER BY visited_at DESC LIMIT %s
        )
        """,
        (user_id, user_id, keep),
    )


def list_recent(user_id: str, limit: int = 12) -> list[str]:
    return [
        r["service_id"]
        for r in query(
            "SELECT service_id FROM labspace.recent WHERE user_id=%s ORDER BY visited_at DESC LIMIT %s",
            (user_id, limit),
        )
    ]


def save_drawing(user_id: str, name: str, content: str) -> dict[str, Any]:
    import uuid

    did = str(uuid.uuid4())
    execute(
        """
        INSERT INTO labspace.drawings (id, user_id, name, content, size)
        VALUES (%s,%s,%s,%s,%s)
        """,
        (did, user_id, name, content, len(content.encode())),
    )
    return {"id": did, "name": name}


def list_drawings(user_id: str) -> list[dict[str, Any]]:
    return query(
        "SELECT id, name, size, updated_at FROM labspace.drawings WHERE user_id=%s ORDER BY updated_at DESC",
        (user_id,),
    )


def get_drawing(user_id: str, drawing_id: str) -> dict[str, Any] | None:
    rows = query(
        "SELECT id, name, content, size, updated_at FROM labspace.drawings WHERE id=%s AND user_id=%s",
        (drawing_id, user_id),
    )
    return rows[0] if rows else None


def delete_drawing(user_id: str, drawing_id: str) -> None:
    execute("DELETE FROM labspace.drawings WHERE id=%s AND user_id=%s", (drawing_id, user_id))


def rename_drawing(user_id: str, drawing_id: str, name: str) -> None:
    execute("UPDATE labspace.drawings SET name=%s, updated_at=now() WHERE id=%s AND user_id=%s", (name, drawing_id, user_id))


def update_drawing(user_id: str, drawing_id: str, name: str, content: str) -> None:
    execute(
        "UPDATE labspace.drawings SET name=%s, content=%s, size=%s, updated_at=now() WHERE id=%s AND user_id=%s",
        (name, content, len(content.encode()), drawing_id, user_id),
    )


# ---------------------------------------------------------------- 公告

def list_announcements() -> list[dict[str, Any]]:
    return query(
        "SELECT id, title, content, level, author, created_at, expires_at FROM labspace.announcements "
        "WHERE (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC LIMIT 20"
    )


def add_announcement(title: str, content: str, level: str, author: str) -> dict[str, Any]:
    import uuid

    aid = str(uuid.uuid4())
    execute(
        "INSERT INTO labspace.announcements (id, title, content, level, author) VALUES (%s,%s,%s,%s,%s)",
        (aid, title, content, level, author),
    )
    rows = query("SELECT id, title, content, level, author, created_at FROM labspace.announcements WHERE id=%s", (aid,))
    return rows[0] if rows else {"id": aid}


def delete_announcement(aid: str) -> None:
    execute("DELETE FROM labspace.announcements WHERE id=%s", (aid,))
