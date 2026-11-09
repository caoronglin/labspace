"""企业微信集成：群机器人通知 + 每日任务摘要。

只做“选择性通知”：公告发布同步、每日任务摘要、管理员手动测试。
不拉取通讯录、不同步聊天与文件，也不做企业微信登录——身份仍以 Casdoor 为准。
Webhook 地址含密钥，读取接口始终脱敏，日志里也不出现原文。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from . import db
from .config import settings
from .security import require_admin, require_csrf

log = logging.getLogger("labspace.wecom")
router = APIRouter(prefix="/api/admin/wecom", tags=["wecom"])

_SETTING_KEY = "wecom"
_TZ = ZoneInfo("Asia/Shanghai")
# 企业微信群机器人内容上限 4096 字节；留出余量按字符截断即可（中文 3 字节）。
_MAX_CONTENT = 1800

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": False,
    "webhookUrl": "",
    "announcements": True,
    "dailyDigest": False,
    "digestTime": "08:30",
    "lastDigestDate": "",
}

# 常见错误码给中文解释；未知错误码只回显 errcode 与截断后的 errmsg。
_ERRCODES = {
    93000: "Webhook 地址无效或机器人已被移除，请在企业微信群中重新获取",
    45009: "企业微信接口调用超过频率限制（20 条/分钟），请稍后再试",
    40058: "企业微信消息内容超出长度限制",
    40008: "企业微信消息格式不正确",
    45033: "企业微信接口并发超过限制，请稍后重试",
}

_SECRET_QUERY_RE = re.compile(r"([?&](?:key|token|secret|password)=)[^&#]+", re.IGNORECASE)


def mask_webhook(url: str) -> str:
    return _SECRET_QUERY_RE.sub(r"\1****", url or "")


def _load() -> dict[str, Any]:
    cfg = dict(DEFAULT_CONFIG)
    rows = db.query("SELECT value FROM labspace.integration_settings WHERE key = %s", (_SETTING_KEY,))
    if rows and isinstance(rows[0].get("value"), dict):
        cfg.update(rows[0]["value"])
    return cfg


def _save(cfg: dict[str, Any]) -> None:
    db.execute(
        """
        INSERT INTO labspace.integration_settings (key, value, updated_at)
        VALUES (%s, %s::jsonb, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        """,
        (_SETTING_KEY, json.dumps(cfg, ensure_ascii=False)),
    )


def _public(cfg: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in cfg.items() if k != "lastDigestDate"}
    out["webhookUrl"] = mask_webhook(str(cfg.get("webhookUrl") or ""))
    out["configured"] = bool(cfg.get("webhookUrl"))
    out["lastDigestDate"] = str(cfg.get("lastDigestDate") or "")
    return out


async def _post_markdown(url: str, content: str) -> tuple[bool, str]:
    payload = {"msgtype": "markdown", "markdown": {"content": content[:_MAX_CONTENT]}}
    try:
        async with httpx.AsyncClient(timeout=6, follow_redirects=False) as client:
            resp = await client.post(url, json=payload)
            data = resp.json()
    except httpx.HTTPError:
        return False, "无法连接企业微信服务器，请检查 Webhook 地址与网络"
    except ValueError:
        return False, "企业微信返回了无法解析的响应"
    errcode = int(data.get("errcode") or 0)
    if resp.status_code != 200 or errcode != 0:
        hint = _ERRCODES.get(errcode)
        if hint:
            return False, hint
        msg = str(data.get("errmsg") or "")[:120]
        return False, f"企业微信返回错误（errcode={errcode}）{('：' + msg) if msg else ''}"
    return True, ""


async def notify_announcement(title: str, content: str, level: str) -> None:
    """公告发布后的尽力推送；失败只记日志，绝不影响公告本身。"""
    cfg = _load()
    url = str(cfg.get("webhookUrl") or "")
    if not (cfg.get("enabled") and cfg.get("announcements") and url):
        return
    level_text = {"info": "通知", "warning": "提醒", "error": "重要"}.get(level, "通知")
    text = f"## LabSpace 公告 · {level_text}\n> **{title}**\n\n{content}"
    ok, detail = await _post_markdown(url, text)
    if not ok:
        log.warning("wecom announcement push failed: %s", detail)


def _digest_stats() -> dict[str, int]:
    row = db.query(
        """
        SELECT
          count(*) FILTER (WHERE status = 'active' AND due_date < CURRENT_DATE)::int AS overdue,
          count(*) FILTER (WHERE status = 'active' AND due_date = CURRENT_DATE)::int AS due_today,
          count(*) FILTER (WHERE status = 'active')::int AS active,
          count(*) FILTER (WHERE status = 'done' AND due_date = CURRENT_DATE)::int AS done_today
        FROM labspace.workbench_items
        """
    )[0]
    announcements = db.query(
        "SELECT count(*)::int AS n FROM labspace.announcements WHERE created_at >= CURRENT_DATE"
    )[0]
    return {
        "overdue": int(row.get("overdue") or 0),
        "dueToday": int(row.get("due_today") or 0),
        "active": int(row.get("active") or 0),
        "doneToday": int(row.get("done_today") or 0),
        "announcements": int(announcements.get("n") or 0),
    }


async def _maybe_send_digest() -> None:
    cfg = _load()
    url = str(cfg.get("webhookUrl") or "")
    if not (cfg.get("enabled") and cfg.get("dailyDigest") and url):
        return
    now = datetime.now(_TZ)
    today = now.date().isoformat()
    if now.strftime("%H:%M") < str(cfg.get("digestTime") or "08:30"):
        return
    if str(cfg.get("lastDigestDate") or "") == today:
        return
    stats = _digest_stats()
    text = (
        f"## LabSpace 每日任务摘要\n> {now.strftime('%Y-%m-%d')}\n\n"
        f"- 今日到期：**{stats['dueToday']}** 项\n"
        f"- 已逾期：**{stats['overdue']}** 项\n"
        f"- 进行中：**{stats['active']}** 项\n"
        f"- 今日完成：**{stats['doneToday']}** 项\n"
        f"- 今日公告：**{stats['announcements']}** 条\n\n"
        f"[打开工作台]({settings.public_url}/workbench)"
    )
    ok, detail = await _post_markdown(url, text)
    if not ok:
        log.warning("wecom digest push failed: %s", detail)
    # 无论成功与否都按日去重，避免企业微信故障时每分钟重试刷日志。
    cfg["lastDigestDate"] = today
    _save(cfg)


async def digest_loop() -> None:
    while True:
        await asyncio.sleep(60)
        try:
            await _maybe_send_digest()
        except Exception as exc:  # noqa: BLE001 - 后台摘要失败不影响门户
            log.warning("wecom digest loop: %s", exc)


class WeComConfig(BaseModel):
    enabled: bool = False
    webhookUrl: str = Field(default="", max_length=500)
    announcements: bool = True
    dailyDigest: bool = False
    digestTime: str = Field(default="08:30", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")


@router.get("")
async def get_wecom_config(_admin: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    return _public(_load())


@router.put("")
async def update_wecom_config(
    body: WeComConfig,
    admin: dict[str, Any] = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    cfg = _load()
    url = body.webhookUrl.strip()
    if "****" in url:
        # 界面拿到的是脱敏地址：原样保存时必须保留真实密钥，而不是写入星号。
        url = str(cfg.get("webhookUrl") or "")
    if url and not re.match(r"^https?://", url, re.IGNORECASE):
        raise HTTPException(status_code=400, detail="Webhook 地址必须以 http:// 或 https:// 开头")
    if (body.enabled or body.dailyDigest) and not url:
        raise HTTPException(status_code=400, detail="启用通知前请先填写企业微信群机器人 Webhook 地址")
    new_cfg = {
        "enabled": bool(body.enabled),
        "webhookUrl": url,
        "announcements": bool(body.announcements),
        "dailyDigest": bool(body.dailyDigest),
        "digestTime": body.digestTime,
        "lastDigestDate": str(cfg.get("lastDigestDate") or ""),
    }
    _save(new_cfg)
    log.info(
        "wecom config saved by %s (enabled=%s digest=%s)",
        admin.get("name") or admin.get("email"),
        new_cfg["enabled"],
        new_cfg["dailyDigest"],
    )
    return _public(new_cfg)


@router.post("/test")
async def test_wecom_webhook(
    _admin: dict[str, Any] = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> dict[str, Any]:
    cfg = _load()
    url = str(cfg.get("webhookUrl") or "")
    if not url:
        raise HTTPException(status_code=400, detail="请先保存 Webhook 地址")
    now = datetime.now(_TZ).strftime("%Y-%m-%d %H:%M")
    text = (
        "## LabSpace 连接测试\n"
        f"> {now}\n\n"
        "如果你看到这条消息，说明企业微信群机器人已经和 LabSpace 打通。"
    )
    ok, detail = await _post_markdown(url, text)
    if not ok:
        raise HTTPException(status_code=502, detail=detail)
    return {"ok": True, "detail": "测试消息已发送到企业微信群"}
