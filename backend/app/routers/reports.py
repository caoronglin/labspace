"""reports 路由（由 ops/split_main_module.py 从 main.py 搬出）。"""
from __future__ import annotations

import json
from datetime import date
from typing import Any

from fastapi import (
    APIRouter,
    Body,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
)

from .. import (
    dailypapers as dailypapers_mod,
)
from .. import (
    db,
)
from ..security import (
    require_admin,
    require_csrf,
    require_user,
)

#: 已被 Go 核心接管、Python 侧只作兼容备份的路由前缀（中间件也用它打 Deprecation 头）
_DEPRECATED_PREFIXES = (
    "/api/services",
    "/api/corpus",
    "/api/search",
    "/api/favorites",
    "/api/recent",
)
_DEPRECATED_HITS: dict[str, int] = {}

router = APIRouter()


#: 已被 Go 核心（labgo :8122）接管、Python 侧只作兼容备份的路由前缀。
#: 还在被访问说明有调用方没切过去，所以先计数 + 打 Deprecation 头，
#: 等观测到一整轮发布周期零命中，再从 main.py 里删实现（别凭感觉删）。

@router.get("/api/admin/deprecated-hits")
async def api_deprecated_hits(_admin: dict = Depends(require_admin)) -> dict[str, Any]:
    """管理员看：还有谁在打 Python 侧的兼容路由（决定何时能删实现）。"""
    return {
        "prefixes": list(_DEPRECATED_PREFIXES),
        "items": [{"path": k, "hits": v} for k, v in sorted(_DEPRECATED_HITS.items(), key=lambda kv: -kv[1])],
    }

# ------------------------------------------------------------------ 每日论文

def _parse_day_param(raw: str | None) -> date:
    """解析 day 查询参数（YYYY-MM-DD）；空值取今天，格式错误直接 400。"""
    value = (raw or "").strip()
    if not value:
        return date.today()
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="day 需要 YYYY-MM-DD 格式") from exc

@router.get("/api/daily-papers")
async def api_daily_papers(
    day: str = Query("", max_length=10),
    topic: str = Query("", max_length=200),
    page: int = Query(1, ge=1, le=1000),
    page_size: int = Query(20, ge=1, le=100),
    user: dict = Depends(require_user),
) -> dict[str, Any]:
    """按人读取某天的「每日论文」。跨用户不可见：查询始终带调用者的 sub。"""
    target = _parse_day_param(day)
    return await dailypapers_mod.list_daily(
        user["sub"],
        target,
        topic=topic,
        page=page,
        page_size=page_size,
    )

@router.get("/api/daily-papers/subscriptions")
async def api_daily_subs(user: dict = Depends(require_user)) -> dict[str, Any]:
    """我的每日论文订阅。"""
    return {"subscriptions": await dailypapers_mod.list_subs(user["sub"])}

@router.put("/api/daily-papers/subscriptions")
async def api_daily_sub_upsert(
    payload: dict[str, Any] = Body(default_factory=dict),
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """新增/修改订阅：主题 + 每天抓几篇 + 是否启用。"""
    topic = str(payload.get("topic") or "").strip()
    if not topic:
        raise HTTPException(status_code=400, detail="topic 不能为空")
    if len(topic) > 120:
        raise HTTPException(status_code=400, detail="主题最长 120 字")
    try:
        limit = int(payload.get("limit") or 10)
    except (TypeError, ValueError):
        limit = 10
    limit = max(1, min(limit, 50))
    enabled = bool(payload.get("enabled", True))
    sub = await dailypapers_mod.upsert_sub(user["sub"], topic, limit, enabled)
    return {"ok": True, "subscription": sub}

@router.delete("/api/daily-papers/subscriptions/{topic}")
async def api_daily_sub_delete(
    topic: str,
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """取消订阅。"""
    await dailypapers_mod.delete_sub(user["sub"], topic)
    return {"ok": True, "topic": topic}

@router.post("/api/daily-papers/subscriptions/run")
async def api_daily_sub_run(
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """立即抓取我的全部订阅（不用等到明天）。"""
    return await dailypapers_mod.run_subs(user["sub"])

@router.post("/api/daily-papers/refresh")
async def api_daily_papers_refresh(
    payload: dict[str, Any] = Body(default_factory=dict),
    user: dict = Depends(require_user),
    _: None = Depends(require_csrf),
) -> dict[str, Any]:
    """抓取并落库某天的论文（主题必填）。

    同一 (天, 人, 主题) 已有数据时直接读库返回，不会重复打文献源。
    文献源全败时返回 source="none"、count=0，不会伪造条目。
    """
    topic = str(payload.get("topic") or "").strip()
    if not topic:
        raise HTTPException(status_code=400, detail="topic 不能为空")
    target = _parse_day_param(str(payload.get("day") or ""))
    return await dailypapers_mod.build_daily(user["sub"], topic, target)

#: 历史重定向命中计数（进程内）。目的是「敢不敢删」，不是精确统计 ——
#: 重启归零没关系，运维看的是「一天里还有没有在跳」。
_LEGACY_HITS: dict[str, int] = {}

@router.post("/api/legacy-hit")
async def api_legacy_hit(request: Request) -> Response:
    """记录一次旧路径命中（前端跳转前打点）。

    隐私上只记路径，不记用户、不记来源页：这里要回答的是「这条重定向还有人用吗」。
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - 打点坏数据不该报错
        body = {}
    path = str((body or {}).get("path") or "")[:200]
    if path:
        _LEGACY_HITS[path] = _LEGACY_HITS.get(path, 0) + 1
    return Response(status_code=204)

@router.get("/api/admin/legacy-hits")
async def api_legacy_hits(_admin: dict = Depends(require_admin)) -> dict[str, Any]:
    """给管理员看：哪些旧路径还在被访问（决定什么时候能从重定向表里删）。"""
    return {"items": [{"path": k, "hits": v} for k, v in sorted(_LEGACY_HITS.items(), key=lambda kv: -kv[1])]}

@router.get("/api/admin/audit")
async def api_admin_audit(
    request: Request,
    actor: str = Query(default=""),
    action: str = Query(default=""),
    since: str = Query(default=""),
    until: str = Query(default=""),
    limit: int = Query(default=500, ge=1, le=5000),
    format: str = Query(default="json"),
    _admin: dict[str, Any] = Depends(require_admin),
) -> Any:
    """按时间、操作人、动作导出审计日志（JSON 或 CSV）。

    审计表是全实验室的写操作底账：种子台账改动、组会授权、跨目录共享、账号变更
    都往这里写。导出走服务端过滤而不是把全表丢给前端 —— 表会一直长。
    """
    clauses = ["1=1"]
    params: list[Any] = []
    if actor:
        clauses.append("actor = %s")
        params.append(actor.strip().lower())
    if action:
        clauses.append("action LIKE %s")
        params.append(f"{action.strip()}%")
    if since:
        clauses.append("created_at >= %s")
        params.append(since)
    if until:
        clauses.append("created_at < %s")
        params.append(until)
    where = " AND ".join(clauses)
    rows = db.query(
        f"SELECT id, actor, action, target, detail, ip, created_at "
        f"FROM labspace.account_audit WHERE {where} ORDER BY created_at DESC LIMIT %s",  # noqa: S608
        (*params, limit),
    )
    if format.lower() == "csv":
        import csv
        import io

        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["id", "actor", "action", "target", "detail", "ip", "created_at"])
        for r in rows:
            writer.writerow([
                r["id"], r["actor"], r["action"], r["target"],
                json.dumps(r["detail"], ensure_ascii=False), r["ip"], r["created_at"],
            ])
        from fastapi.responses import PlainTextResponse

        return PlainTextResponse(
            buf.getvalue(),
            media_type="text/csv; charset=utf-8",
            headers={"content-disposition": 'attachment; filename="labspace-audit.csv"'},
        )
    return {"items": rows, "count": len(rows)}
