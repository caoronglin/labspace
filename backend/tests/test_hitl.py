"""HITL 回传：**服务端重建事件形状**，不接受前端伪造。

为什么要单独测：`POST /api/agent/sessions/{id}/hitl` 是唯一"允许工具往下跑"的入口，
如果它信任前端传来的 `tool_call` / 权限规则，就等于把「批准任意工具调用」交给浏览器。
这里断言的是：客户端只能给"选择"，事件由服务端按 `replyId + toolCalls` 重新拼。

不打真实 AgentScope：`submit_event` 用桩捕获事件，只校验形状与拒绝分支。
"""
from __future__ import annotations

import time
from typing import Any

import jwt
import pytest
from fastapi.testclient import TestClient

from app import agent as agent_mod
from app import agentscope_adapter, agentscope_bridge, main
from app.config import settings

REPLY_ID = "reply-123"
SESSION = "sess-hitl"


@pytest.fixture()
def client() -> TestClient:
    return TestClient(main.app)


@pytest.fixture()
def captured(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """把 AgentScope 通道换成桩：只记录 submit_event 收到的事件。"""
    events: list[dict[str, Any]] = []

    monkeypatch.setattr(agent_mod, "_use_agentscope", lambda: True)

    async def fake_resolved_agent(user_id: str, platform: Any) -> tuple[str, str, str]:
        return "agent-1", "model-1", "cred-1"

    async def fake_submit_event(session_id: str, agent_id: str, user_id: str, event: dict[str, Any]) -> None:
        events.append({"session": session_id, "agent": agent_id, "event": event})

    monkeypatch.setattr(agentscope_bridge, "resolved_agent", fake_resolved_agent)
    monkeypatch.setattr(agentscope_adapter, "submit_event", fake_submit_event)
    return events


def _headers() -> dict[str, str]:
    token = jwt.encode(
        {"sub": "u1", "email": "stu01@local", "name": "张三", "roles": ["lab-student"], "exp": int(time.time()) + 3600},
        settings.session_secret,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}", "X-CSRF-Token": "t"}


def test_rejects_payload_without_reply_or_calls(client: TestClient, captured: list[dict[str, Any]]) -> None:
    resp = client.post(
        f"/api/agent/sessions/{SESSION}/hitl",
        headers=_headers(),
        cookies={"labspace_csrf": "t"},
        json={"kind": "confirm", "approved": True},
    )
    assert resp.status_code == 400, resp.text
    assert captured == []


def test_confirm_event_is_rebuilt_server_side(client: TestClient, captured: list[dict[str, Any]]) -> None:
    """前端只能给 approved；规则由服务端从 tool call 里取，前端塞的 rules 不生效。"""
    forged = {"id": "call-1", "name": "Write", "input": {"file_path": "x"}, "rules": [{"allow": "*"}]}
    resp = client.post(
        f"/api/agent/sessions/{SESSION}/hitl",
        headers=_headers(),
        cookies={"labspace_csrf": "t"},
        json={"kind": "confirm", "replyId": REPLY_ID, "approved": False, "toolCalls": [forged]},
    )
    assert resp.status_code == 200, resp.text
    event = captured[0]["event"]
    assert event["type"] == "USER_CONFIRM_RESULT"
    assert event["reply_id"] == REPLY_ID
    assert event["confirm_results"][0]["confirmed"] is False
    # 服务端只回传调用本身与它自己的规则字段，不复用前端给的 rules
    assert event["confirm_results"][0]["tool_call"]["id"] == "call-1"


def test_ask_requires_askuser_call(client: TestClient, captured: list[dict[str, Any]]) -> None:
    resp = client.post(
        f"/api/agent/sessions/{SESSION}/hitl",
        headers=_headers(),
        cookies={"labspace_csrf": "t"},
        json={
            "kind": "ask",
            "replyId": REPLY_ID,
            "toolCalls": [{"id": "c1", "name": "Bash", "input": {}}],
            "answers": [{"question": "选哪个？", "selected": ["A"], "other": None}],
        },
    )
    assert resp.status_code == 400, resp.text
    assert "AskUser" in resp.json()["detail"]
    assert captured == []


def test_ask_event_carries_answers_to_model(client: TestClient, captured: list[dict[str, Any]]) -> None:
    resp = client.post(
        f"/api/agent/sessions/{SESSION}/hitl",
        headers=_headers(),
        cookies={"labspace_csrf": "t"},
        json={
            "kind": "ask",
            "replyId": REPLY_ID,
            "toolCalls": [{"id": "c1", "name": "AskUser", "input": {}}],
            "answers": [{"question": "用哪个物种？", "selected": ["水稻"], "other": "备注"}],
        },
    )
    assert resp.status_code == 200, resp.text
    event = captured[0]["event"]
    assert event["type"] == "EXTERNAL_EXECUTION_RESULT"
    result = event["execution_results"][0]
    assert result["id"] == "c1"
    assert "水稻" in result["output"][0]["text"]
    assert result["metadata"]["answers"][0]["selected"] == ["水稻"]


def test_unknown_kind_rejected(client: TestClient, captured: list[dict[str, Any]]) -> None:
    resp = client.post(
        f"/api/agent/sessions/{SESSION}/hitl",
        headers=_headers(),
        cookies={"labspace_csrf": "t"},
        json={"kind": "sudo", "replyId": REPLY_ID, "toolCalls": [{"id": "c1", "name": "AskUser"}]},
    )
    assert resp.status_code == 400, resp.text
    assert captured == []
