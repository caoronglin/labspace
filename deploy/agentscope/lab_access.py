"""AgentScope 的门户共享策略：教师/管理员可读组内其他人的助手与知识库。

为什么需要
----------
AgentScope 默认是**按用户严格隔离**（``DenyAllResourceAccessPolicy``），
这与实验室里「导师要看学生的课题材料」不一致。门户里老师已有整棵课题资料
的可见权，但 AgentScope 里的助手/知识库仍只属于创建者本人。

策略边界（刻意收得很紧）
------------------------
* **只放行 READ，不放行 EDIT**：共享别人的助手/知识库可以提问，不能改名/删除。
* **凭据（credential）永不共享**：共享一个模型/向量凭据等于把密钥交出去。
* **只有教师与管理员**能跨用户读取：普通学生只能看到自己的资源。
* 通过门户会话身份（``viewer_id`` 是 nginx 校验过的 ``X-User-ID``）实时取角色，
  不信任模型或前端传来的任何角色字段。
* 上游不可用时返回空列表（fail closed）：宁可少显示，不可越权显示。

这个策略用 AgentScope 官方 ``resource_access_policy`` 扩展点接入，
不修改 AgentScope 源码。
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

from agentscope.app.access import (
    ResourceAccessPolicyBase,
    ResourceKind,
    ResourcePermission,
    ResourceRef,
)

from lab_portal import PortalClient

log = logging.getLogger("labspace.access")

# 能跨用户读取的角色。普通成员保持严格隔离。
_SHARED_READER_ROLES = frozenset(
    {"lab-teacher", "lab-admin", "lab-superadmin"}
)

# 角色 / 用户目录的缓存时间（秒）。权限变更最多 60 秒后生效，
# 避免每次 list_accessible 都打两次门户请求拖慢对话。
_CACHE_TTL = float(os.getenv("LAB_ACCESS_CACHE_TTL", "60"))

PORTAL = PortalClient()


class LabResourceAccessPolicy(ResourceAccessPolicyBase):
    """按门户用户组决定跨用户只读共享。"""

    def __init__(self) -> None:
        self._roles: dict[str, tuple[float, frozenset[str]]] = {}
        self._people: tuple[float, tuple[str, ...]] | None = None

    async def _viewer_roles(self, viewer_id: str) -> frozenset[str]:
        """从门户取调用者角色（带 TTL 缓存，失败时按无角色处理）。"""
        user = str(viewer_id or "").strip()
        if not user:
            return frozenset()
        cached = self._roles.get(user)
        now = time.monotonic()
        if cached and now - cached[0] < _CACHE_TTL:
            return cached[1]
        result = await PORTAL._request("GET", f"{PORTAL.backend_base}/api/me", user_id=user)
        roles: set[str] = set()
        if result.get("ok") and isinstance(result.get("data"), dict):
            roles = {str(r).strip().lower() for r in (result["data"].get("roles") or [])}
        else:
            log.warning("读门户角色失败（%s），按无共享角色处理", result.get("error"))
        value = frozenset(roles)
        self._roles[user] = (now, value)
        return value

    async def _all_user_ids(self, viewer_id: str) -> tuple[str, ...]:
        """从门户人员目录取所有用户 id（带 TTL 缓存）。"""
        now = time.monotonic()
        if self._people and now - self._people[0] < _CACHE_TTL:
            return self._people[1]
        result = await PORTAL._request(
            "GET", f"{PORTAL.backend_base}/api/people", user_id=viewer_id
        )
        people: list[str] = []
        if result.get("ok") and isinstance(result.get("data"), dict):
            for item in result["data"].get("people") or []:
                if isinstance(item, dict) and item.get("id"):
                    people.append(str(item["id"]))
        else:
            log.warning("读门户人员目录失败（%s），共享列表为空", result.get("error"))
        value = tuple(dict.fromkeys(people))
        self._people = (now, value)
        return value

    async def list_accessible(
        self,
        viewer_id: str,
        kind: ResourceKind,
        storage: Any,
    ) -> list[ResourceRef]:
        """列出可跨用户只读访问的助手 / 知识库。"""
        # 凭据和未知类型一律不共享。
        if kind not in (ResourceKind.AGENT, ResourceKind.KNOWLEDGE_BASE):
            return []
        roles = await self._viewer_roles(viewer_id)
        if not roles.intersection(_SHARED_READER_ROLES):
            return []

        refs: list[ResourceRef] = []
        for owner in await self._all_user_ids(viewer_id):
            if owner == str(viewer_id):
                continue  # 自己的资源由 AgentScope 原生按 owner 逻辑处理
            try:
                if kind is ResourceKind.AGENT:
                    records = await storage.list_agents(owner)
                else:
                    records = await storage.list_knowledge_bases(owner)
            except Exception as exc:  # noqa: BLE001 - 单个用户失败不影响其他人
                log.debug("列 %s 的共享资源失败：%s", owner, exc)
                continue
            for record in records or []:
                rid = getattr(record, "id", None)
                if not rid:
                    continue
                refs.append(
                    ResourceRef(
                        kind=kind,
                        owner_id=owner,
                        resource_id=str(rid),
                        permission=ResourcePermission.READ,
                    )
                )
        return refs
