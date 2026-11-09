"""Go 核心（LabGo）调用桥。

Go 核心接管了服务目录、健康检查、内嵌探测与统一语料 / 全局搜索；后端在需要时
通过 Docker 网桥地址（``172.28.0.1:8122``）调用它，避免在 Python 侧再实现一份
同样的逻辑。所有调用都带超时与容错：Go 核心不可达时返回 ``None``，由调用方
回退到 Python 本地实现。
"""
from __future__ import annotations

from typing import Any

import httpx

from .config import settings

_TIMEOUT = 12.0


async def _get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any] | None:
    url = f"{settings.labgo_base}{path}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(url, params=params)
        if resp.status_code != 200:
            return None
        return resp.json()
    except Exception:  # noqa: BLE001
        return None


async def service_health(service_id: str) -> dict[str, Any]:
    """查询单个服务的健康状态（由 Go 核心执行探测与缓存）。"""
    data = await _get(f"/v1/services/{service_id}/health")
    if not data:
        return {"status": "unknown", "latency_ms": None, "detail": "Go 核心不可达"}
    return {
        "status": data.get("status", "unknown"),
        "latency_ms": data.get("latency_ms"),
        "detail": data.get("detail", ""),
    }


async def embed_info(service_id: str) -> dict[str, Any]:
    """查询某个服务是否允许 iframe 内嵌（由 Go 核心探测响应头）。"""
    data = await _get(f"/v1/services/{service_id}/embed")
    if not data:
        return {
            "id": service_id,
            "name": "",
            "url": "",
            "embeddable": False,
            "reason": "Go 核心不可达",
            "evidence": "",
            "checked_at": "",
        }
    return data


async def corpus_query(q: str, limit: int) -> dict[str, Any] | None:
    """统一语料查询（命令面板 / 全局直达），由 Go 核心执行。"""
    params: dict[str, Any] = {"limit": limit}
    if q:
        params["q"] = q
    return await _get("/v1/corpus", params)


async def corpus_suggest(q: str, limit: int) -> dict[str, Any] | None:
    """搜索建议（输入框联想）。"""
    return await _get("/v1/corpus/suggest", {"q": q, "limit": limit})


async def corpus_databases(q: str, category: str, limit: int) -> dict[str, Any] | None:
    """植物 / 生物医学数据库目录检索。"""
    params: dict[str, Any] = {"limit": limit}
    if q:
        params["q"] = q
    if category:
        params["category"] = category
    return await _get("/v1/corpus/databases", params)


async def portal_search(q: str, categories: str, scope: str) -> dict[str, Any] | None:
    """统一搜索（本地语料 + SearXNG 联网结果），由 Go 核心执行。"""
    return await _get("/v1/portal/search", {"q": q, "categories": categories, "scope": scope})


async def search_categories() -> dict[str, Any] | None:
    """检索分类清单。"""
    return await _get("/v1/portal/search/categories")


async def _admin_request(
    method: str, path: str, payload: dict[str, Any] | None = None
) -> tuple[bool, Any]:
    """调用 LabGo 的账号/文件权限管理接口（仅服务令牌可用）。"""
    token = (settings.service_token or "").strip()
    if not token:
        return False, "内部服务令牌未配置"
    headers = {"X-Lab-Service-Token": token}
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.request(
                method, f"{settings.labgo_base}{path}", json=payload, headers=headers
            )
    except Exception as exc:  # noqa: BLE001
        return False, f"文件核心不可达（{exc.__class__.__name__}）"
    if resp.status_code != 200:
        try:
            detail = str(resp.json().get("error") or "")
        except Exception:  # noqa: BLE001
            detail = ""
        return False, detail or f"文件核心返回 {resp.status_code}"
    try:
        return True, resp.json()
    except Exception:  # noqa: BLE001
        return False, "文件核心返回了无法解析的响应"


async def provision_user(name: str) -> tuple[bool, str]:
    """创建/修复个人文件空间与基础 ACL（幂等）。"""
    ok, data = await _admin_request("POST", "/v1/admin/provision", {"name": name})
    if not ok:
        return False, str(data)
    return True, ""


async def deprovision_user(name: str) -> tuple[bool, Any]:
    """切断某账号的文件授权并删除其个人目录（硬删除账号时调用）。

    成功时返回文件核心的清理结果（removedPaths / removedBytes / aclEntries），
    失败时返回可直接展示给管理员的原因。
    """
    ok, data = await _admin_request("POST", "/v1/admin/deprovision", {"name": name})
    if not ok:
        return False, data
    return True, data if isinstance(data, dict) else {}


async def file_access() -> dict[str, Any] | None:
    """项目共享目录清单及各账号的授权情况。"""
    ok, data = await _admin_request("GET", "/v1/admin/file-access")
    return data if ok and isinstance(data, dict) else None


async def set_project_access(name: str, projects: list[str]) -> tuple[bool, str]:
    """替换某账号的项目共享目录授权。"""
    ok, data = await _admin_request(
        "PUT", f"/v1/admin/file-access/{name}", {"projects": projects}
    )
    if not ok:
        return False, str(data)
    return True, ""


async def set_file_grants(name: str, grants: list[dict[str, Any]]) -> tuple[bool, str]:
    """替换某账号在所有共享源上的目录级读写授权。"""
    ok, data = await _admin_request(
        "PUT", f"/v1/admin/file-access/{name}", {"grants": grants}
    )
    if not ok:
        return False, str(data)
    return True, ""


async def file_groups() -> list[dict[str, Any]] | None:
    """预配置用户组的文件权限模板。"""
    ok, data = await _admin_request("GET", "/v1/admin/file-groups")
    if not ok or not isinstance(data, dict):
        return None
    groups = data.get("groups")
    return groups if isinstance(groups, list) else []


async def set_group_grants(
    group: str, grants: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]] | None, str]:
    """替换某个用户组的目录授权，返回文件核心归一化后的授权（组权限是成员的
    默认值，个人权限可覆盖）。"""
    ok, data = await _admin_request(
        "PUT", f"/v1/admin/file-groups/{group}", {"grants": grants}
    )
    if not ok:
        return None, str(data)
    normalized = data.get("grants") if isinstance(data, dict) else None
    return (normalized if isinstance(normalized, list) else []), ""


async def delete_file_group(group: str) -> tuple[bool, str]:
    """删除自定义用户组（内置组由文件核心拒绝删除）。"""
    ok, data = await _admin_request("DELETE", f"/v1/admin/file-groups/{group}")
    if not ok:
        return False, str(data)
    return True, ""


async def access_preview(
    name: str, email: str, roles: list[str], admin: bool
) -> tuple[list[dict[str, Any]] | None, str]:
    """按真实的「组 + 个人权限」判定顺序预演某个账号的文件权限。"""
    ok, data = await _admin_request(
        "POST",
        "/v1/admin/file-access-preview",
        {"name": name, "email": email, "roles": roles, "admin": admin},
    )
    if not ok:
        return None, str(data)
    probes = data.get("probes") if isinstance(data, dict) else None
    return (probes if isinstance(probes, list) else []), ""
