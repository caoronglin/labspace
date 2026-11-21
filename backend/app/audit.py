"""统一审计埋点。

为什么不在每个路由里手写 INSERT：写接口分散在四个模块（种子台账、组会授权、
个人空间跨目录共享、任务产物归档），各写各的必然长歪 —— 字段不一致、IP 漏记、
有的记 before 有的记 after。这里收敛成一个入口：

* actor  —— 操作人账号名（与会话里的 email 本地部分一致）
* action —— 动词，如 ``seed.update`` / ``meeting.grant`` / ``share.grant``
* target —— 被改动的资源标识（行 id、周、路径）
* detail —— 变更摘要（before/after），写进 jsonb
* ip     —— 由中间件塞进 contextvar，业务代码不用管

审计写失败不抛给用户：审计是旁路，不能因为它挂了就让业务操作失败；但会打 error
日志，让运维能在日志里看到「有操作没记下来」。
"""
from __future__ import annotations

import contextvars
import json
import logging
from typing import Any

from . import db

log = logging.getLogger("labspace.audit")

#: 当前请求的客户端 IP；由 main.py 的中间件写入，业务函数直接读。
_current_ip: contextvars.ContextVar[str] = contextvars.ContextVar("labspace_audit_ip", default="")


def set_request_ip(ip: str) -> None:
    _current_ip.set(ip or "")


def current_ip() -> str:
    return _current_ip.get()


def record(
    actor: str,
    action: str,
    target: str,
    detail: dict[str, Any] | None = None,
    ip: str | None = None,
) -> None:
    """写一条审计记录。失败只记日志，不影响调用方的业务返回。"""
    try:
        db.execute(
            """
            INSERT INTO labspace.account_audit (actor, action, target, detail, ip)
            VALUES (%s, %s, %s, %s::jsonb, %s)
            """,
            (
                (actor or "").strip().lower(),
                action,
                target,
                json.dumps(detail or {}, ensure_ascii=False),
                current_ip() if ip is None else ip,
            ),
        )
    except Exception as exc:  # noqa: BLE001 - 审计失败不能打断业务
        log.error("审计写入失败（%s %s %s）：%s", actor, action, target, exc)
