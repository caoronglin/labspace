"""账号的「必须修改初始口令」标记。

放在**门户库**而不是 Casdoor 库：这是一张门户自己的业务表，而
``app/accounts.py`` 用的连接池指向 Casdoor 库（那里只放 Casdoor 自己的
``public."user"`` 等表）。两库混用会让查询直接报 "relation does not exist"，
进而把 /api/me 变成 500，整个门户对已登录用户全部失效。

因此：
* 建表语句在 ``app/db.py`` 的 SCHEMA 里（门户库，随门户启动幂等执行）；
* 读写都用 ``app.db`` 的门户连接池；
* 改 Casdoor 口令本身仍走 ``app/accounts.py``（那是 Casdoor 库的事）。
"""

from __future__ import annotations

from . import db


def must_change_password(name: str) -> bool:
    """该账号是否处于「必须修改初始口令」状态。

    查不到记录一律按 False：存量账号没有这行，不能被误判成要改密。
    """
    key = (name or "").strip().lower()
    if not key:
        return False
    rows = db.query(
        "SELECT must_change FROM labspace.account_security WHERE name = %s",
        (key,),
    )
    return bool(rows and rows[0].get("must_change"))


def mark_must_change(name: str) -> None:
    """标记该账号必须改密（新建账号、重置为初始口令时调用）。"""
    key = (name or "").strip().lower()
    if not key:
        return
    db.execute(
        """
        INSERT INTO labspace.account_security (name, must_change, updated_at)
        VALUES (%s, true, now())
        ON CONFLICT (name) DO UPDATE SET must_change = true, updated_at = now()
        """,
        (key,),
    )


def clear_must_change(name: str) -> None:
    """改密成功后清标记。"""
    key = (name or "").strip().lower()
    if not key:
        return
    db.execute(
        "UPDATE labspace.account_security SET must_change = false, updated_at = now() WHERE name = %s",
        (key,),
    )


def ensure_table() -> None:
    """确保表存在（供测试与迁移脚本显式调用）。"""
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS labspace.account_security (
            name        text PRIMARY KEY,
            must_change boolean NOT NULL DEFAULT false,
            updated_at  timestamptz NOT NULL DEFAULT now()
        )
        """
    )


__all__ = [
    "clear_must_change",
    "ensure_table",
    "mark_must_change",
    "must_change_password",
]
