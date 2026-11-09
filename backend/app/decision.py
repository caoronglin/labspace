"""SiliconFlow SystemOne 快速决策模型接入。

本模块只服务端持有密钥；前端不可见。未配置 ``LABSPACE_SILICONFLOW_KEY`` 时
``enabled()`` 返回 False，调用方应回退到本地规则，页面也不会出现错误提示。
"""
from __future__ import annotations

import asyncio
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException

from .config import settings
from .security import require_csrf, require_user

router = APIRouter(prefix="/api/decision", tags=["decision"])

MODELS = ("Kev-4b", "SemIf")
QUESTION_TYPES = ("noul", "choice", "score")
MAX_STATE = 12000
MAX_QUESTIONS = 12


def enabled() -> bool:
    return bool(settings.siliconflow_key and settings.siliconflow_base)


def status() -> dict[str, Any]:
    return {"enabled": enabled(), "model": settings.systemone_model, "models": list(MODELS),
            "provider": "SiliconFlow SystemOne"}


async def decide(state: Any, questions: dict[str, Any], model: str | None = None, timeout: float = 12.0) -> dict[str, Any]:
    """调用 /v1/systemone；questions 结构由调用方给出，返回原始 answers。"""
    if not enabled():
        raise RuntimeError("未配置 SiliconFlow 决策模型")
    chosen = model or settings.systemone_model
    if chosen not in MODELS:
        raise ValueError("不支持的模型")
    payload = {"model": chosen, "state": state, "questions": questions}
    headers = {"Authorization": f"Bearer {settings.siliconflow_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(f"{settings.siliconflow_base}/v1/systemone", json=payload, headers=headers)
    if resp.status_code != 200:
        raise RuntimeError(f"决策模型返回 {resp.status_code}")
    body = resp.json()
    answers = body.get("answers") or {}
    usage = body.get("usage") or {}
    return {"answers": answers, "usage": usage, "model": body.get("model") or chosen}


async def classify_capture(text: str) -> dict[str, Any] | None:
    """一句话捕获的分类：返回 {kind, priority, confidence, reason}，失败返回 None。"""
    if not enabled():
        return None
    questions = {
        "kind": {
            "type": "choice",
            "instructions": "把这条内容归入最合适的工作台类型。",
            "criteria": {
                "task": "需要执行、有明确动作的事项",
                "project": "多步骤、较长周期的项目",
                "idea": "灵感、想法、可探索方向",
                "knowledge": "可沉淀为知识条目的资料",
                "note": "普通记录、备忘",
                "memory": "个人偏好或需要长期记住的信息",
                "plan": "计划、安排、日程框架",
            },
        },
        "priority": {
            "type": "choice",
            "instructions": "判断处理优先级。",
            "criteria": {"urgent": "非常紧急，需立即处理", "high": "重要，优先处理", "normal": "常规", "low": "可以稍后处理"},
        },
        "actionable": {"type": "noul", "instructions": "这条内容是否需要立刻采取行动？"},
    }
    try:
        result = await asyncio.wait_for(decide({"text": text[:MAX_STATE]}, questions), timeout=8.0)
    except Exception:  # noqa: BLE001 - 决策模型不可用时静默回退
        return None
    answers = result.get("answers") or {}
    kind_ans = answers.get("kind") or {}
    prio_ans = answers.get("priority") or {}
    action_ans = answers.get("actionable") or {}
    kind = kind_ans.get("choice") if kind_ans.get("type") == "choice" else None
    priority = prio_ans.get("choice") if prio_ans.get("type") == "choice" else None
    if kind not in ("task", "project", "idea", "knowledge", "note", "memory", "plan"):
        return None
    if priority not in ("urgent", "high", "normal", "low"):
        priority = "normal"
    confidence = action_ans.get("noul") if isinstance(action_ans.get("noul"), (int, float)) else None
    reason = f"SystemOne 判断为 {kind}（{priority}）"
    return {"kind": kind, "priority": priority, "confidence": confidence, "reason": reason, "model": result.get("model")}


@router.get("/status")
async def decision_status(user: dict = Depends(require_user)) -> dict:
    return status()


@router.post("/decide")
async def decision_decide(payload: dict, user: dict = Depends(require_user), _: None = Depends(require_csrf)) -> dict:
    state = payload.get("state")
    questions = payload.get("questions")
    if not isinstance(questions, dict) or not questions or len(questions) > MAX_QUESTIONS:
        raise HTTPException(status_code=422, detail="questions 必须为 1-12 个问题的对象")
    if len(str(state)) > MAX_STATE:
        raise HTTPException(status_code=413, detail="state 过长")
    clean: dict[str, Any] = {}
    for key, q in questions.items():
        if not isinstance(q, dict) or q.get("type") not in QUESTION_TYPES:
            raise HTTPException(status_code=422, detail=f"问题 {key} 类型不合法")
        item: dict[str, Any] = {"type": q["type"], "instructions": str(q.get("instructions") or "")[:2000]}
        if q["type"] == "choice":
            criteria = q.get("criteria")
            if not isinstance(criteria, (dict, list)) or not criteria:
                raise HTTPException(status_code=422, detail=f"问题 {key} 缺少 criteria")
            item["criteria"] = criteria
        elif q["type"] == "score":
            criteria = q.get("criteria")
            if not isinstance(criteria, list) or len(criteria) < 2:
                raise HTTPException(status_code=422, detail=f"问题 {key} 需要分级列表")
            item["criteria"] = [str(c)[:200] for c in criteria[:10]]
        clean[str(key)[:40]] = item
    if not enabled():
        return {"enabled": False, **status()}
    try:
        result = await decide(state, clean, payload.get("model"))
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"enabled": True, **result}