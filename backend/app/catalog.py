"""服务目录（读取 Go 核心导出的唯一权威源）。

Go 核心（LabGo，`internal/catalog`）持有服务注册表，并以固定周期把目录导出为
``/srv/labdata/labgo/catalog.json``（宿主机路径），该文件以**只读**方式挂载进后端
容器（容器内路径 ``/srv/labgo/catalog.json``）。

本模块因此不再持有服务清单，只负责：

* 读取导出文件并转成 :class:`ServiceDef`（供语料检索、收藏校验等使用）；
* 把目录中的默认主机改写成用户实际访问的主机（IP 自适应）。

健康检查（``internal/health``）与内嵌探测（``internal/embed``）也已由 Go 核心接管，
对应的 Python 实现已删除。
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("labspace.catalog")


DEFAULT_HOST = "192.0.2.10"
"""服务目录中写死的默认主机（内网 LAN IP）。

仅作为“占位主机”使用：当用户从 Tailscale IP（或其他主机名）访问时，
返回给前端的地址会被替换成用户实际访问的主机，
避免外网客户端被引导到不可达的 LAN 地址。
"""

#: Go 核心导出的服务目录（容器内路径，只读挂载）
EXPORT_PATH = os.environ.get("LABSPACE_CATALOG_EXPORT", "/srv/labgo/catalog.json")

#: 导出文件重新读取的最小间隔（秒）
_REFRESH_INTERVAL = 15.0


def adapt_host(value: Any, host: str = "") -> Any:
    """把结构中字符串里的默认主机替换为当前访问入口的主机。

    - host 为空或就是默认主机时原样返回；
    - 递归处理 dict / list；
    - 仅替换 ``http://192.0.2.10`` 前缀，不动外部站点地址。
    """
    if not host:
        return value
    hostname = host.split(":")[0].strip()
    if not hostname or hostname == DEFAULT_HOST:
        return value
    if isinstance(value, str):
        return value.replace(f"http://{DEFAULT_HOST}", f"http://{hostname}")
    if isinstance(value, list):
        return [adapt_host(v, host) for v in value]
    if isinstance(value, dict):
        return {k: adapt_host(v, host) for k, v in value.items()}
    return value


@dataclass(frozen=True)
class ServiceDef:
    id: str
    name: str
    description: str
    category: str          # ai | files | research | learn | draw | dev
    url: str               # 入口（相对门户主机名的绝对 URL）
    icon: str              # Ant Design 图标名
    open_mode: str = "link"   # link | embed
    embed: bool = False       # 是否提供「平台内嵌」入口（iframe）
    embed_url: str = ""       # 内嵌地址（可与 url 不同，如带配置参数）
    sso_url: str = ""         # 一键登录入口（服务自身的 OIDC 启动端点）
    lang_note: str = ""       # 语言说明（上游无中文包时，向用户解释界面语言）
    health_url: str = ""      # 回环可访问的健康地址
    external: bool = False    # 是否为外部内网服务（非本机部署，故障不归本机运维）
    health_kind: str = "http" # http | tcp | host | file
    health_host: str = ""   # kind=host 时的 Host 头
    roles: list[str] = field(default_factory=list)  # 允许访问的角色；空=所有已登录用户
    tags: list[str] = field(default_factory=list)
    enabled: bool = True
    notes: str = ""
    guide: list[str] = field(default_factory=list)


_cache: tuple[float, list[ServiceDef]] | None = None


def _parse_export(payload: dict[str, Any]) -> list[ServiceDef]:
    services: list[ServiceDef] = []
    for item in payload.get("services") or []:
        try:
            services.append(
                ServiceDef(
                    id=str(item.get("id", "")),
                    name=str(item.get("name", "")),
                    description=str(item.get("description", "")),
                    category=str(item.get("category", "")),
                    url=str(item.get("url", "")),
                    icon=str(item.get("icon", "")),
                    open_mode=str(item.get("open_mode", "link")),
                    embed=bool(item.get("embed")),
                    embed_url=str(item.get("embed_url", "")),
                    sso_url=str(item.get("sso_url", "")),
                    lang_note=str(item.get("lang_note", "")),
                    health_url=str(item.get("health_url", "")),
                    external=bool(item.get("external")),
                    health_kind=str(item.get("health_kind", "http")),
                    health_host=str(item.get("health_host", "")),
                    roles=list(item.get("roles") or []),
                    tags=list(item.get("tags") or []),
                    enabled=bool(item.get("enabled", True)),
                    notes=str(item.get("notes", "")),
                    guide=list(item.get("guide") or []),
                )
            )
        except (TypeError, ValueError) as exc:  # noqa: BLE001
            logger.warning("服务目录条目解析失败：%s", exc)
    return services


def load_catalog(path: str = EXPORT_PATH, force: bool = False) -> list[ServiceDef]:
    """读取 Go 核心导出的服务目录。

    - 文件缺失或内容损坏时保留上一次成功的结果（不抛错），避免导出写盘瞬间
      的半截 JSON 让门户服务目录整体不可用；
    - 读取结果带 15 秒缓存，避免每个请求都读盘。
    """
    global _cache
    now = time.monotonic()
    if not force and _cache is not None and now - _cache[0] < _REFRESH_INTERVAL:
        return _cache[1]

    try:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except FileNotFoundError:
        logger.warning("未找到 Go 核心导出的服务目录：%s", path)
        if _cache is not None:
            return _cache[1]
        return []
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("服务目录读取失败（保留上次结果）：%s", exc)
        if _cache is not None:
            return _cache[1]
        return []

    services = _parse_export(payload)
    _cache = (now, services)
    return services


def visible_services(user: dict[str, Any] | None, host: str = "") -> list[dict[str, Any]]:
    """按角色过滤服务目录。

    host：用户当前实际访问的主机名（LAN IP 或 Tailscale IP）。
    传入后，所有服务地址里的默认主机会被替换成该主机，
    实现「从哪个 IP 进来，其他服务就用同一个 IP」。
    """
    from .security import has_role

    out = []
    for svc in load_catalog():
        if not svc.enabled:
            continue
        if svc.roles and not has_role(user, svc.roles):
            continue
        out.append(
            {
                "id": svc.id,
                "name": svc.name,
                "description": svc.description,
                "category": svc.category,
                "url": svc.url,
                "icon": svc.icon,
                "openMode": svc.open_mode,
                "embed": svc.embed,
                "embedUrl": svc.embed_url or svc.url,
                "ssoUrl": svc.sso_url,
                "langNote": svc.lang_note,
                "tags": svc.tags,
                "roles": svc.roles,
                "notes": svc.notes,
                "guide": svc.guide,
                "external": svc.external,
            }
        )
    return adapt_host(out, host)
