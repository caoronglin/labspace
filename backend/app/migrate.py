"""版本化数据库迁移。

为什么不继续在 ``db.py`` 里放一个巨大的 ``SCHEMA`` 常量直接 ``execute``：

* **没有历史**：改了常量，谁也不知道这台机器上究竟跑过哪一版；
* **不能演进**：``CREATE TABLE IF NOT EXISTS`` 不会给已存在的表补列，
  于是补列只能靠一串 ``ALTER ... IF NOT EXISTS`` 混在同一段 SQL 里；
* **启动即隐式建表**：日志里看不出发生了什么，出问题也无从回溯。

现在规则很简单：

1. 结构变更只写 ``backend/migrations/NNNN_描述.sql``，按文件名升序执行；
2. 执行过的记在 ``labspace.schema_migrations``，重复启动不会重放；
3. 一个文件在**一个事务**里跑完：失败就整体回滚，不会留下半截结构；
4. 历史文件不改，只追加 —— 别的机器要能按同样顺序重放出同样的结构。
"""
from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger("labspace.migrate")

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"

#: 记录已执行迁移的小账本。它自己必须先存在，所以用一条独立的、幂等的 DDL。
_LEDGER = """
CREATE SCHEMA IF NOT EXISTS labspace;
CREATE TABLE IF NOT EXISTS labspace.schema_migrations (
    name       text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);
"""


def migration_files() -> list[Path]:
    if not MIGRATIONS_DIR.is_dir():
        return []
    return sorted(MIGRATIONS_DIR.glob("*.sql"))


def migrations_sql() -> str:
    """把全部迁移拼成一段 SQL（测试建库、离线核对用）。"""
    return "\n".join(p.read_text(encoding="utf-8") for p in migration_files())


def apply(conn) -> list[str]:
    """把未执行过的迁移按顺序跑掉，返回本次实际执行的文件名。"""
    applied: list[str] = []
    with conn.cursor() as cur:
        cur.execute(_LEDGER)
        cur.execute("SELECT name FROM labspace.schema_migrations")
        done = {row[0] for row in cur.fetchall()}
    conn.commit()

    for path in migration_files():
        name = path.name
        if name in done:
            continue
        sql = path.read_text(encoding="utf-8")
        with conn.cursor() as cur:
            try:
                # SAFETY: sql 来自仓库内的 migrations/*.sql（编译期常量文件），
                # 不含任何运行期输入，也没有占位符可参数化；执行前不做字符串拼接。
                cur.execute(sql)  # noqa: S608, python-sql-injection
                # SAFETY: 表名与列名是字面量，唯一的值走占位符。
                cur.execute(  # noqa: S608, python-sql-injection
                    "INSERT INTO labspace.schema_migrations (name) VALUES (%s)", (name,)
                )
            except Exception:
                conn.rollback()
                log.error("迁移失败并已回滚：%s", name)
                raise
        conn.commit()
        applied.append(name)
        log.info("已应用数据库迁移：%s", name)

    if applied:
        log.warning("数据库结构已更新（本次应用 %d 个迁移）：%s", len(applied), ", ".join(applied))
    else:
        log.info("数据库结构已是最新（%d 个迁移文件，无待应用）", len(migration_files()))
    return applied
