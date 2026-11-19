"""后台任务管理（管理员）：定时器、一次性任务与常驻服务的统一视图。

为什么要做这一页：
    以前"系统里有哪些后台任务、上次跑成功没有、下次什么时候跑"只能 ssh 上去
    `systemctl list-timers`。出问题时（比如某天备份失败）没人知道，
    直到需要恢复才发现备份是断的。

设计要点：
    * **只读为主，写操作收敛**：查看状态走无副作用的 `systemctl show/list-timers`；
      触发（start）与重置失败（reset-failed）单独开接口，且必须管理员 + CSRF。
    * **只允许操作白名单单元**：绝不能接受任意 unit 名（那等于给管理员一个
      "以 root 跑任意 systemd 单元"的入口，一旦接口被绕过就是提权）。
    * **不返回完整日志**：只回最近的摘要行，避免把敏感配置/口令刷进浏览器。
    * 全部命令通过固定参数列表调用，不拼 shell 字符串。
"""
from __future__ import annotations

import asyncio
import logging
import shutil
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException

from .security import require_admin, require_csrf, require_superadmin

log = logging.getLogger("labspace.tasks")

router = APIRouter(prefix="/api/admin/tasks", tags=["admin-tasks"])

#: 允许在此页面查看/触发的单元。硬编码白名单，不接受来自请求的任意 unit 名。
MANAGED_UNITS: dict[str, dict[str, str]] = {
    "lab-daily-maintenance.timer": {"label": "每日维护（更新 / 清理 / 重启）", "kind": "timer"},
    "lab-daily-maintenance.service": {"label": "每日维护（执行体）", "kind": "oneshot"},
    "lab-backup.timer": {"label": "全量备份（每日）", "kind": "timer"},
    "lab-backup.service": {"label": "全量备份（执行体）", "kind": "oneshot"},
    "lab-backup-core.timer": {"label": "核心增量备份（每 4 小时）", "kind": "timer"},
    "lab-backup-core.service": {"label": "核心增量备份（执行体）", "kind": "oneshot"},
    "lab-health.timer": {"label": "平台巡检（每日）", "kind": "timer"},
    "lab-health.service": {"label": "平台巡检（执行体）", "kind": "oneshot"},
    "lab-oidc-sync.service": {"label": "OIDC 自适应切换", "kind": "service"},
    "lab-rag.service": {"label": "知识库 RAG 服务", "kind": "service"},
    "lab-sandbox.service": {"label": "一次性代码沙箱", "kind": "service"},
    "labops-worker.service": {"label": "实验平台作业队列", "kind": "service"},
    "apptainer-primer.service": {"label": "Primer 引物平台（Apptainer）", "kind": "service"},
}

#: 可被"立即执行"的单元（只有 oneshot/timer 有意义；常驻服务不允许一键重启，
#: 避免管理员手滑把线上服务踢掉）。
TRIGGERABLE = {
    "lab-daily-maintenance.service",
    "lab-backup.service",
    "lab-backup-core.service",
    "lab-health.service",
}


async def _ops(method: str, path: str, body: dict[str, Any] | None = None) -> tuple[bool, Any]:
    """调用宿主机运维服务（lab-oidc-sync.service，root 运行、令牌鉴权）。

    **为什么不能在这里直接 systemctl**：门户后端跑在容器里，容器内没有
    宿主机的 systemd（D-Bus / PID 1 都不是它），`systemctl show` 会返回空，
    页面就会把所有任务显示成 unknown。这与备份删除走的是同一条通道。
    """
    from .config import settings

    token = (settings.service_token or "").strip()
    if not token:
        return False, "内部服务令牌未配置"
    base = (settings.oidc_sync_url or "").rstrip("/")
    if not base:
        return False, "宿主机运维服务地址未配置（LABSPACE_OIDC_SYNC_URL）"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request(
                method,
                f"{base}{path}",
                json=body if body is not None else {},
                headers={"X-Ops-Token": token},
            )
    except Exception as exc:  # noqa: BLE001
        return False, f"宿主机运维服务不可达（{exc.__class__.__name__}）"
    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        payload = {}
    if resp.status_code != 200:
        detail = str((payload or {}).get("error") or "")
        return False, detail or f"运维服务返回 {resp.status_code}"
    return True, payload


async def _run(*args: str, timeout: float = 20.0) -> tuple[int, str]:
    """执行一个 systemctl/journalctl 命令，返回 (退出码, 输出)。

    仅在**宿主机进程**里可用（测试/运维直连）；容器内请用 _ops。
    """
    if not shutil.which(args[0]):
        return 127, f"{args[0]} 不可用"
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode or 0, out.decode("utf-8", "replace")
    except TimeoutError:
        return 124, "命令超时"
    except OSError as exc:
        return 1, f"{type(exc).__name__}: {exc}"


def _parse_show(text: str) -> dict[str, str]:
    """解析 `systemctl show` 的 KEY=VALUE 输出。"""
    out: dict[str, str] = {}
    for line in text.splitlines():
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key] = value
    return out


def _parse_timers(text: str) -> dict[str, dict[str, str]]:
    """解析 `systemctl list-timers --all --output=json`（失败时退回纯文本跳过）。"""
    import json

    out: dict[str, dict[str, str]] = {}
    try:
        rows = json.loads(text or "[]")
    except json.JSONDecodeError:
        return out
    for row in rows:
        if not isinstance(row, dict):
            continue
        unit = str(row.get("unit") or "")
        if unit:
            out[unit] = {
                "next": str(row.get("next") or ""),
                "last": str(row.get("last") or ""),
                "activates": str(row.get("activates") or ""),
            }
    return out


@router.get("")
async def list_tasks(user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    """列出所有受管单元的状态、上次/下次运行时间。"""
    ok, payload = await _ops("POST", "/ops/tasks")
    if not ok:
        raise HTTPException(status_code=502, detail=f"读取后台任务失败：{payload}")

    raw_units = (payload or {}).get("units") if isinstance(payload, dict) else None
    out: list[dict[str, Any]] = []
    for item in raw_units or []:
        if not isinstance(item, dict):
            continue
        unit = str(item.get("unit") or "")
        meta = MANAGED_UNITS.get(unit)
        if meta is None:
            # 宿主机多出来的单元（例如临时排障单元）不展示：
            # 这页只呈现"我们知道怎么处理"的任务，避免给出无法解释的条目。
            continue
        out.append(
            {
                "unit": unit,
                "label": meta["label"],
                "kind": item.get("kind") or meta["kind"],
                "active": item.get("active", "unknown"),
                "result": item.get("result", ""),
                "sub": item.get("sub", ""),
                "enabled": item.get("enabled", ""),
                "last": item.get("last", ""),
                "next": item.get("next", ""),
                "activates": item.get("activates", ""),
                "triggerable": unit in TRIGGERABLE,
            }
        )

    # 排序：失败的排最前，其次按「定时器 → 服务」分组
    def rank(item: dict[str, Any]) -> tuple[int, int, str]:
        failed = 0 if (item["active"] == "failed" or item["result"] == "failed") else 1
        kind = 0 if item["kind"] == "timer" else 1 if item["kind"] == "oneshot" else 2
        return (failed, kind, item["unit"])

    out.sort(key=rank)
    return {
        "ok": True,
        "units": out,
        "failed": sum(1 for u in out if u["active"] == "failed" or u["result"] == "failed"),
    }


@router.get("/{unit}/logs")
async def unit_logs(
    unit: str,
    lines: int = 60,
    user: dict[str, Any] = Depends(require_admin),
) -> dict[str, Any]:
    """某个单元最近的日志摘要（默认 60 行）。"""
    if unit not in MANAGED_UNITS:
        raise HTTPException(status_code=404, detail="未知的后台任务")
    # 查询参数可能是脏值（?lines=abc），解析失败就退回默认值，
    # 不让一个手改 URL 把日志页打成 500。
    try:
        requested = int(lines)
    except (TypeError, ValueError):
        requested = 60
    n = max(10, min(requested, 200))
    ok, payload = await _ops("POST", "/ops/tasks/logs", {"unit": unit, "lines": n})
    if not ok:
        raise HTTPException(status_code=502, detail=f"读取日志失败：{payload}")
    log_lines = payload.get("lines") if isinstance(payload, dict) else []
    return {"ok": True, "unit": unit, "lines": log_lines or []}


@router.post("/{unit}/run")
async def run_unit(
    unit: str,
    user: dict[str, Any] = Depends(require_superadmin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """立即执行一个（可触发的）任务。

    注意：这里只 `systemctl start`，**不等待它跑完**——备份要跑几分钟，
    同步等待会把 HTTP 请求拖死。前端通过列表刷新看结果。
    """
    if unit not in MANAGED_UNITS:
        raise HTTPException(status_code=404, detail="未知的后台任务")
    if unit not in TRIGGERABLE:
        raise HTTPException(
            status_code=400,
            detail="该单元不支持手动触发（常驻服务请用 systemctl 维护，避免误踢线上服务）",
        )
    ok, payload = await _ops("POST", "/ops/tasks/run", {"unit": unit})
    if not ok:
        raise HTTPException(status_code=502, detail=f"启动失败：{payload}")
    log.info("管理员 %s 触发后台任务 %s", user.get("sub"), unit)
    return {"ok": True, "unit": unit}


@router.post("/{unit}/reset")
async def reset_unit(
    unit: str,
    user: dict[str, Any] = Depends(require_superadmin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    """清除失败状态（reset-failed），让定时器不再卡在 failed。"""
    if unit not in MANAGED_UNITS:
        raise HTTPException(status_code=404, detail="未知的后台任务")
    ok, payload = await _ops("POST", "/ops/tasks/reset", {"unit": unit})
    if not ok:
        raise HTTPException(status_code=502, detail=f"重置失败：{payload}")
    return {"ok": True, "unit": unit}
