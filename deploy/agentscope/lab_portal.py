"""门户内部接口客户端（MCP server 侧）。

调用约定
--------
* **公共只读接口**（服务目录 / 数据库目录 / 数据库查询 / 统一搜索）：带内部
  服务令牌 ``X-Lab-Service-Token``。门户把这类调用认成 ``service`` 身份，
  只开放公共只读数据（见 ``docs/CONTRACT_WORKBENCH_AGENT.md`` §3）。
* **用户级接口**（工作台条目 / 绘图任务）：带该用户的短期会话 JWT
  （``Authorization: Bearer``），门户按 ``sub`` 过滤，越权取不到别人的数据。

失败一律转成 ``{"error": ..., "retryable": bool}``，**不抛异常** —— 一次工具
失败不该打断 Agent 的整个循环。
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx

from lab_identity import mint_session_jwt


def _clamp(value: Any, default: int, hi: int) -> int:
    """把外部传入的条数夹到 [1, hi]；脏值（None/文本）退回默认值。"""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(1, min(parsed, hi))


log = logging.getLogger("agentscope.lab.portal")

#: 门户后端（compose 服务名，容器内网直连）。
BACKEND_BASE = os.getenv("LAB_PORTAL_BASE_URL", "http://backend:8080").rstrip("/")
#: AgentScope 自己（MCP server 与 app 同容器），用于 RAG 检索这类内部端点。
AGENTSCOPE_BASE = os.getenv("LAB_AGENTSCOPE_SELF", "http://127.0.0.1:8100").rstrip("/")
#: Go 核心（LabGo）：绘图任务与平台清单的权威实现。
LABGO_BASE = os.getenv("LABGO_BASE_URL", "http://172.28.0.1:8122").rstrip("/")
#: 内部服务令牌（只读公共数据）。
SERVICE_TOKEN = (os.getenv("LABSPACE_SERVICE_TOKEN") or "").strip()
#: 门户会话密钥：用来给已核验的用户签一份短期会话 JWT。
SESSION_SECRET = (os.getenv("LABSPACE_SESSION_SECRET") or "").strip()
#: 门户对外主机名：服务目录里的地址要按用户实际访问入口给，不能给容器地址。
PUBLIC_HOST = (
    os.getenv("LAB_PORTAL_PUBLIC_HOST")
    or os.getenv("LABSPACE_PUBLIC_URL", "http://192.0.2.10").split("//")[-1].split("/")[0]
)

#: 工具级超时（秒）。任务要求每个工具 ≤30s。
TIMEOUT_SERVICES = 15.0
TIMEOUT_DATABASES = 15.0
TIMEOUT_QUERY = 25.0
TIMEOUT_SEARCH = 28.0
TIMEOUT_WORKBENCH = 15.0
TIMEOUT_PLOT = 28.0

#: 数据库查询的条数上限（门户侧也会再夹一次）。
MAX_QUERY_LIMIT = 20
DEFAULT_QUERY_LIMIT = 5
MAX_WORKBENCH_LIMIT = 200
DEFAULT_WORKBENCH_LIMIT = 50


def error(message: str, *, retryable: bool = False) -> dict[str, Any]:
    """统一的失败形状。"""
    return {"error": message, "retryable": retryable}


@dataclass
class PortalClient:
    """门户内部接口客户端。

    每次调用都带超时；网络异常、超时、非 2xx 响应都转成结构化错误。
    """

    backend_base: str = BACKEND_BASE
    labgo_base: str = LABGO_BASE
    service_token: str = SERVICE_TOKEN
    session_secret: str = SESSION_SECRET
    public_host: str = PUBLIC_HOST

    def _headers(self, user_id: str | None) -> dict[str, str]:
        """身份头。

        用户级接口靠 ``Authorization: Bearer``（门户据此认成该用户本人，
        并豁免双提交 CSRF —— 内部服务调用同理）；公共只读接口靠服务令牌。
        """
        headers = {
            "Accept": "application/json",
            "X-Forwarded-Host": self.public_host,
        }
        if self.service_token:
            headers["X-Lab-Service-Token"] = self.service_token
        if user_id and self.session_secret:
            headers["Authorization"] = (
                f"Bearer {mint_session_jwt(user_id, self.session_secret)}"
            )
        return headers

    async def _request(
        self,
        method: str,
        url: str,
        *,
        user_id: str | None = None,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
        timeout: float = 20.0,
    ) -> dict[str, Any]:
        """发一次请求并归一化结果。

        Returns:
            成功时是门户返回的 JSON；失败时是 ``{"error", "retryable"}``。
        """
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.request(
                    method,
                    url,
                    params=params,
                    json=json_body,
                    headers=self._headers(user_id),
                )
        except httpx.TimeoutException:
            return error(f"门户接口超时（{timeout:.0f}s 内没回），可以稍后再试", retryable=True)
        except httpx.HTTPError as exc:
            return error(f"门户接口不可达（{type(exc).__name__}）", retryable=True)

        if resp.status_code >= 400:
            detail = ""
            try:
                payload = resp.json()
                if isinstance(payload, dict):
                    detail = str(payload.get("detail") or payload.get("error") or "")
            except ValueError:
                detail = resp.text[:200]
            retryable = resp.status_code >= 500 or resp.status_code == 429
            return error(
                f"门户返回 HTTP {resp.status_code}" + (f"：{detail}" if detail else ""),
                retryable=retryable,
            )
        try:
            payload = resp.json()
        except ValueError:
            return error("门户返回的不是合法 JSON", retryable=True)
        if not isinstance(payload, dict):
            return {"ok": True, "data": payload}
        return {"ok": True, "data": payload}

    # ------------------------------------------------------------ 服务目录

    async def services(self, user_id: str | None = None) -> dict[str, Any]:
        """服务目录（名称 / 地址 / 说明）。"""
        return await self._request(
            "GET",
            f"{self.backend_base}/api/services",
            user_id=user_id,
            timeout=TIMEOUT_SERVICES,
        )

    # ------------------------------------------------------------ 科研数据库

    async def databases(self, user_id: str | None = None) -> dict[str, Any]:
        """数据库目录（用于把模型给的库名解析成库 id）。"""
        return await self._request(
            "GET",
            f"{self.backend_base}/api/databases",
            user_id=user_id,
            params={"q": "", "category": ""},
            timeout=TIMEOUT_DATABASES,
        )

    async def database_query(
        self,
        db_id: str,
        query: str,
        limit: int = DEFAULT_QUERY_LIMIT,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """对指定数据库执行一次只读查询（门户服务端代理上游 API）。"""
        return await self._request(
            "POST",
            f"{self.backend_base}/api/databases/{db_id}/query",
            user_id=user_id,
            json_body={
                "query": query,
                "limit": max(1, min(int(limit or DEFAULT_QUERY_LIMIT), MAX_QUERY_LIMIT)),
                "params": {},
            },
            timeout=TIMEOUT_QUERY,
        )

    # ------------------------------------------------------------ 统一搜索

    async def search(
        self,
        query: str,
        scope: str = "web",
        categories: str = "general",
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """统一搜索（web=联网，local=本地语料，all=合并）。"""
        return await self._request(
            "GET",
            f"{self.backend_base}/api/search",
            user_id=user_id,
            params={"q": query, "scope": scope, "categories": categories},
            timeout=TIMEOUT_SEARCH,
        )

    # ------------------------------------------------------------ 工作台

    async def workbench_capture(self, text: str, user_id: str) -> dict[str, Any]:
        """把一句话按本地规则记入工作台。"""
        return await self._request(
            "POST",
            f"{self.backend_base}/api/workbench/capture",
            user_id=user_id,
            json_body={"text": text},
            timeout=TIMEOUT_WORKBENCH,
        )

    async def workbench_items(
        self,
        kind: str = "",
        query: str = "",
        limit: int = DEFAULT_WORKBENCH_LIMIT,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """列出当前用户的条目。"""
        params: dict[str, Any] = {
            "limit": max(1, min(int(limit or DEFAULT_WORKBENCH_LIMIT), MAX_WORKBENCH_LIMIT)),
        }
        if kind:
            params["kind"] = kind
        if query:
            params["q"] = query
        return await self._request(
            "GET",
            f"{self.backend_base}/api/workbench/items",
            user_id=user_id,
            params=params,
            timeout=TIMEOUT_WORKBENCH,
        )

    # ------------------------------------------------------------ 绘图

    async def plot_submit(
        self,
        body: dict[str, Any],
        user_id: str,
    ) -> dict[str, Any]:
        """提交绘图任务（Go 队列 + Python 渲染，按用户隔离）。"""
        return await self._request(
            "POST",
            f"{self.labgo_base}/v1/plot/jobs",
            user_id=user_id,
            json_body=body,
            timeout=TIMEOUT_PLOT,
        )

    async def plot_jobs(self, limit: int = 10, user_id: str | None = None) -> dict[str, Any]:
        """最近的绘图任务。"""
        return await self._request(
            "GET",
            f"{self.labgo_base}/v1/plot/jobs",
            user_id=user_id,
            params={"limit": max(1, min(int(limit or 10), 50))},
            timeout=TIMEOUT_PLOT,
        )



    # ---------------------------------------------------------------- 门户业务域
    # 以下四个是"把门户能力真正交给助手"的落点：文献、种子台账、组会材料、
    # 课题资料。全部只读，且一律带 user_id —— 助手能看到的东西与用户在门户里
    # 看到的完全一致，不会因为"是 AI"就多拿权限。

    async def literature_search(
        self, query: str, limit: int = 10, user_id: str | None = None
    ) -> dict[str, Any]:
        """检索文献库（调用者自己的条目）。"""
        return await self._request(
            "GET",
            f"{BACKEND_BASE}/api/labops/literature",
            user_id=user_id,
            params={"q": query, "limit": _clamp(limit, 10, 50)},
        )

    async def seeds_low_stock(
        self, limit: int = 20, user_id: str | None = None
    ) -> dict[str, Any]:
        """种子台账（按数量升序，便于发现快用完的批次）。"""
        return await self._request(
            "GET",
            f"{BACKEND_BASE}/api/labops/inventory/low-count",
            user_id=user_id,
            params={"limit": _clamp(limit, 20, 100)},
        )

    async def meeting_weeks(
        self, week: str = "", user_id: str | None = None
    ) -> dict[str, Any]:
        """组会周目录；指定 week 时返回该周的文件列表。"""
        if week:
            return await self._request(
                "GET",
                f"{BACKEND_BASE}/api/meetings/weeks/{week}/files",
                user_id=user_id,
            )
        return await self._request(
            "GET", f"{BACKEND_BASE}/api/meetings/weeks", user_id=user_id
        )

    async def research_folders(self, user_id: str | None = None) -> dict[str, Any]:
        """课题资料：调用者可见的目录（学生只有自己那棵）。"""
        return await self._request(
            "GET", f"{BACKEND_BASE}/api/research/mine", user_id=user_id
        )

    async def knowledge_search(
        self, knowledge_base_id: str, query: str, top_k: int = 5, user_id: str | None = None
    ) -> dict[str, Any]:
        """在某个知识库里做语义检索（走 AgentScope 自己的 RAG 检索端点）。"""
        return await self._request(
            "POST",
            f"{AGENTSCOPE_BASE}/knowledge_bases/{knowledge_base_id}/search",
            user_id=user_id,
            json_body={"query": query, "top_k": _clamp(top_k, 5, 20)},
        )


def match_database(items: list[dict[str, Any]], wanted: str) -> dict[str, Any] | None:
    """按名称 / 中文名 / id 模糊匹配一个数据库条目。

    模型常写「NCBI GenBank」「KEGG 数据库」这类多词名字，所以除了整串匹配，
    还按词元逐个命中 id / 名称 / 中文名。

    Args:
        items: ``/api/databases`` 的 items。
        wanted: 模型给的库名。

    Returns:
        命中的条目；没有命中返回 ``None``。
    """
    needle = str(wanted or "").strip().lower()
    if not needle:
        return None

    scored: list[tuple[int, dict[str, Any]]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        db_id = str(item.get("id") or "").lower()
        name = str(item.get("name") or "").lower()
        cn = str(item.get("cn") or "").lower()
        desc = str(item.get("desc") or item.get("description") or "").lower()
        category = str(item.get("category") or "").lower()

        if db_id == needle:
            score = 100
        elif name == needle or cn == needle:
            score = 95
        elif name.startswith(needle) or cn.startswith(needle):
            score = 80
        elif needle in name or needle in cn or needle in db_id:
            score = 70
        elif needle in desc or needle in category:
            score = 40
        else:
            score = 0

        if score < 70:
            tokens = [
                token
                for token in str(wanted or "")
                .replace(",", " ")
                .replace("，", " ")
                .replace("、", " ")
                .replace("/", " ")
                .replace("（", " ")
                .replace("）", " ")
                .replace("(", " ")
                .replace(")", " ")
                .split()
                if len(token) >= 2 and token not in ("数据库", "数据库目录")
            ]
            for token in tokens:
                token = token.lower()
                if db_id == token or token in db_id:
                    score = max(score, 90)
                    break
                if token in name or token in cn:
                    score = max(score, 85)
                    break
                if token in desc or token in category:
                    score = max(score, 45)

        if score > 0:
            scored.append((score, item))

    if not scored:
        return None
    scored.sort(key=lambda pair: (-pair[0], str(pair[1].get("name") or "")))
    return scored[0][1]
