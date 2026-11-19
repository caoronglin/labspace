"""实验室门户 MCP server（官方 ``mcp`` 包，Streamable HTTP）。

暴露 7 个工具（名字与 pi 时代的 ``lab_*`` 对齐，语义覆盖门户现有科研能力）：

============================ ==================================================
工具                          转发到
============================ ==================================================
``lab_services``             门户后端 ``/api/services``（服务目录）
``lab_database_query``       门户后端 ``/api/databases`` + ``/api/databases/{id}/query``
``lab_web_search``           门户后端 ``/api/search``（统一搜索）
``lab_knowledge_search``     **占位**：RAG 未接好时明确返回 ``knowledge_unavailable``
``lab_workbench_capture``    门户后端 ``/api/workbench/capture``
``lab_workbench_list``       门户后端 ``/api/workbench/items``
``lab_plot``                 Go 核心 ``/v1/plot/jobs``（绘图任务）
============================ ==================================================

三条硬规矩
----------
1. **身份不来自模型**：每个工具先验通道密钥与用户断言（``lab_identity``），
   user_id 是 nginx 校验会话后注入、AgentScope 签过名的那个，不是模型给的。
2. **只读的工具就是只读**：数据库查询只走门户的只读查询代理；写操作
   （工作台捕获、绘图提交）只落在**调用者自己**的数据里（门户按 ``sub`` 过滤）。
3. **失败不抛异常**：超时、上游报错、参数不对，一律返回
   ``{"error": ..., "retryable": bool}``，不打断 Agent 的循环。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from mcp.server.mcpserver import Context, MCPServer
from mcp.types import ToolAnnotations
from pydantic import Field

from lab_identity import (
    ASSERTION_HEADER,
    CHANNEL_HEADER,
    CHANNEL_TOKEN,
    verify_user_assertion,
)
from lab_portal import (
    PortalClient,
    error,
    match_database,
)

log = logging.getLogger("agentscope.lab.mcp")

#: MCP server 监听地址：**只绑回环**，容器外（nginx、宿主机）都够不着。
MCP_HOST = "127.0.0.1"
MCP_PORT = 8101
MCP_PATH = "/mcp"

#: 数据库目录缓存（秒）：模型常常连着问好几个库，目录不用每次重拉。
DATABASE_CACHE_TTL = 300.0

_database_cache: dict[str, Any] = {"at": 0.0, "items": []}
_database_lock = threading.Lock()

server = MCPServer(
    name="lab-portal",
    instructions=(
        "实验室门户能力：服务目录、科研数据库查询、统一搜索、工作台条目、绘图。"
        "调用者身份由网关校验，工具只对调用者本人的数据生效。"
    ),
)


# ------------------------------------------------------------------ 身份


def _caller(ctx: Context) -> tuple[str, dict[str, Any] | None]:
    """校验调用者，返回 ``(user_id, 错误)``。

    两道校验：
    * 通道密钥 —— 证明请求确实来自 AgentScope 进程（外部够不着这个端口，
      密钥只是兜底）。
    * 用户断言 —— 证明 user_id 是 AgentScope 签过名的那个，而不是模型编的。

    Returns:
        校验通过时 ``(user_id, None)``；否则 ``("", 错误负载)`` —— 失败时
        user_id 为空串，调用方必须先看错误负载。
    """
    headers = {str(k).lower(): str(v) for k, v in (ctx.headers or {}).items()}
    channel = headers.get(CHANNEL_HEADER.lower(), "")
    if not channel or channel != CHANNEL_TOKEN:
        return "", error("unauthorized：调用方不是 AgentScope 服务", retryable=False)
    assertion = headers.get(ASSERTION_HEADER.lower(), "")
    user_id = verify_user_assertion(assertion)
    if not user_id:
        return "", error("unauthorized：缺少可验证的用户身份断言", retryable=False)
    return user_id, None



def _clamp(value: Any, default: int, hi: int) -> int:
    """把外部传入的条数夹到 [1, hi]；脏值（None/文本）退回默认值。

    工具参数来自模型/上游，可能是 ``"ten"`` 这类非数字；裸 ``int()`` 会让
    整个工具调用抛异常，而按约定工具失败应当返回 ``{"error": ...}``。
    """
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(1, min(parsed, hi))


def _ok(data: dict[str, Any]) -> dict[str, Any]:
    """成功形状。"""
    return {"ok": True, "data": data}


def _trim(value: Any, limit: int = 160) -> str:
    """把长文本压成一行摘要。"""
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[:limit] + "…"


# ------------------------------------------------------------------ 工具


@server.tool(
    name="lab_services",
    annotations=ToolAnnotations(title="实验室服务目录", read_only_hint=True),
)
async def lab_services(
    q: str = Field(default="", description="可选。按名称/说明/分类/URL 过滤服务目录。"),
    ctx: Context = None,
) -> dict[str, Any]:
    """查询实验室门户登记的内网服务清单（名称、地址、说明）。

    用于回答「有哪些内网服务」「XX 服务的地址是什么」这类问题。
    """
    user_id, failure = _caller(ctx)
    if failure is not None:
        return failure
    result = await PORTAL.services(user_id)
    if "error" in result:
        return result
    services = result["data"].get("services") or []
    needle = (q or "").strip().lower()
    picked = [
        svc
        for svc in services
        if not needle
        or needle
        in " ".join(
            str(svc.get(key) or "")
            for key in ("name", "description", "category", "url", "id")
        ).lower()
    ]
    return _ok(
        {
            "count": len(picked),
            "total": len(services),
            "services": [
                {
                    "id": svc.get("id"),
                    "name": svc.get("name"),
                    "category": svc.get("category"),
                    "url": svc.get("url"),
                    "description": _trim(svc.get("description")),
                }
                for svc in picked
            ],
        },
    )


@server.tool(
    name="lab_database_query",
    annotations=ToolAnnotations(title="科研数据库查询", read_only_hint=True),
)
async def lab_database_query(
    database: str = Field(description="数据库名称或 id，支持中文名/英文名/id 模糊匹配。"),
    query: str = Field(description="要在该数据库中检索的关键词。"),
    limit: int = Field(default=5, description="返回条数上限，默认 5，最大 20。"),
    ctx: Context = None,
) -> dict[str, Any]:
    """在科研数据库里做一次只读检索（门户服务端代理上游 API）。

    例：database="NCBI GenBank"、query="Arabidopsis thaliana"。
    """
    user_id, failure = _caller(ctx)
    if failure is not None:
        return failure
    catalog = await _database_items(user_id)
    if "error" in catalog:
        return catalog
    items = catalog["items"]
    matched = match_database(items, database)
    if matched is None:
        names = [str(item.get("name") or item.get("id")) for item in items[:20]]
        return error(
            f"没有找到名为「{database}」的数据库。可选库：{'、'.join(names)}",
            retryable=False,
        )
    result = await PORTAL.database_query(
        str(matched.get("id")),
        query,
        limit,
        user_id,
    )
    if "error" in result:
        return result
    payload = result["data"]
    if not payload.get("ok", True):
        return error(
            str(payload.get("error") or "数据库查询失败"),
            retryable=False,
        )
    return _ok(
        {
            "database": {
                "id": matched.get("id"),
                "name": matched.get("name"),
                "cn": matched.get("cn"),
            },
            "query": query,
            "count": len(payload.get("items") or []),
            "items": payload.get("items") or [],
        },
    )


@server.tool(
    name="lab_web_search",
    annotations=ToolAnnotations(title="统一搜索", read_only_hint=True),
)
async def lab_web_search(
    query: str = Field(description="搜索关键词。"),
    scope: str = Field(
        default="web",
        description="web=仅联网结果（默认）；local=仅本地语料（服务/数据库/页面）；all=合并。",
    ),
    ctx: Context = None,
) -> dict[str, Any]:
    """统一搜索：联网（SearXNG 聚合）+ 门户本地语料。"""
    user_id, failure = _caller(ctx)
    if failure is not None:
        return failure
    result = await PORTAL.search(query, scope, user_id=user_id)
    if "error" in result:
        return result
    payload = result["data"]
    hits = payload.get("results") or []
    return _ok(
        {
            "query": query,
            "scope": scope,
            "count": len(hits),
            "results": [
                {
                    "title": _trim(hit.get("title"), 120),
                    "url": hit.get("url"),
                    "engine": hit.get("engine"),
                    "category": hit.get("category"),
                    "content": _trim(hit.get("content"), 240),
                }
                for hit in hits[:10]
            ],
            "degraded": payload.get("degraded") or [],
        },
    )


@server.tool(
    name="lab_knowledge_search",
    annotations=ToolAnnotations(title="知识库检索（未接入）", read_only_hint=True),
)
async def lab_knowledge_search(
    knowledge_base_id: str = Field(
        description="知识库 id。可用 lab_knowledge_bases 工具列出自己可见的知识库。"
    ),
    q: str = Field(description="检索问题（自然语言即可）。"),
    top_k: int = Field(default=5, description="返回条数上限，默认 5，最大 20。"),
    ctx: Context = None,
) -> dict[str, Any]:
    """在指定知识库里做语义检索，返回命中片段与**来源文件**。

    RAG 已就绪（平台固定 bge-m3 / 1024 维）。返回的每条结果都带
    ``source``（文件名）与 ``chunk_index``，回答时应当据此逐条标注来源，
    不要在没有片段支撑时编造结论。
    """
    user_id, failure = _caller(ctx)
    if failure is not None:
        return failure
    if not knowledge_base_id.strip():
        return error("knowledge_base_id 不能为空：先用 lab_knowledge_bases 查自己的知识库。")
    result = await PORTAL.knowledge_search(knowledge_base_id, q, top_k, user_id)
    if "error" in result:
        return result
    payload = result["data"]
    results = payload.get("results") or []
    return _ok(
        {
            "count": len(results),
            "results": [
                {
                    "score": round(float(r.get("score") or 0), 6),
                    "source": (r.get("chunk") or {}).get("source"),
                    "chunk_index": (r.get("chunk") or {}).get("chunk_index"),
                    "text": _trim(((r.get("chunk") or {}).get("content") or {}).get("text"), 800),
                    "document_id": r.get("document_id"),
                }
                for r in results
            ],
        },
    )


@server.tool(
    name="lab_workbench_capture",
    annotations=ToolAnnotations(
        title="记入工作台",
        read_only_hint=False,
        destructive_hint=False,
    ),
)
async def lab_workbench_capture(
    text: str = Field(
        description=(
            "要记入工作台的一句话。可含日期（今天/明天/2026-11-05）、#标签、"
            "优先级词（紧急/不急）。例：「明天下午前完成 #实验 蛋白提取」。"
        ),
    ),
    ctx: Context = None,
) -> dict[str, Any]:
    """把一句话按本地规则记进**调用者自己的**工作台（任务/项目/笔记/计划…）。"""
    user_id, failure = _caller(ctx)
    if failure is not None:
        return failure
    content = (text or "").strip()
    if not content:
        return error("捕获内容不能为空", retryable=False)
    result = await PORTAL.workbench_capture(content, user_id)
    if "error" in result:
        return result
    payload = result["data"]
    item = payload.get("item") or {}
    return _ok(
        {
            "id": item.get("id"),
            "kind": item.get("kind"),
            "title": item.get("title"),
            "priority": item.get("priority"),
            "tags": item.get("tags"),
            "due_date": item.get("due_date"),
            "ai_class": payload.get("ai_class"),
            "ai_reason": payload.get("ai_reason"),
            "confidence": payload.get("confidence"),
        },
    )


@server.tool(
    name="lab_workbench_list",
    annotations=ToolAnnotations(title="工作台条目", read_only_hint=True),
)
async def lab_workbench_list(
    kind: str = Field(
        default="",
        description="可选。按类型过滤：task/project/idea/knowledge/note/memory/plan；留空返回全部。",
    ),
    q: str = Field(default="", description="可选。按标题/正文检索。"),
    limit: int = Field(default=20, description="返回条数上限，默认 20，最大 200。"),
    ctx: Context = None,
) -> dict[str, Any]:
    """列出**调用者自己**的工作台条目（任务/项目/想法/笔记/记忆/计划）。"""
    user_id, failure = _caller(ctx)
    if failure is not None:
        return failure
    result = await PORTAL.workbench_items(kind, q, limit, user_id)
    if "error" in result:
        return result
    payload = result["data"]
    items = payload.get("items") or []
    return _ok(
        {
            "count": len(items),
            "total": payload.get("total"),
            "items": [
                {
                    "id": item.get("id"),
                    "kind": item.get("kind"),
                    "title": item.get("title"),
                    "content": _trim(item.get("content"), 200),
                    "status": item.get("status"),
                    "priority": item.get("priority"),
                    "tags": item.get("tags"),
                    "due_date": item.get("due_date"),
                    "source": item.get("source"),
                }
                for item in items
            ],
        },
    )


@server.tool(
    name="lab_plot",
    annotations=ToolAnnotations(
        title="提交绘图任务",
        read_only_hint=False,
        destructive_hint=False,
    ),
)
async def lab_plot(
    chart: str = Field(
        description=(
            "图表模板 id：bar/line/scatter/box/violin/heatmap/volcano/venn/tree/"
            "circos/manhattan/pca/gsea。"
        ),
    ),
    data: str = Field(default="", description="CSV/TSV 文本（首行为列名）；tree 模板可省略。"),
    title: str = Field(default="", description="图表标题，留空使用模板名。"),
    sample: str = Field(default="", description="可选。使用内置示例数据（sample id）。"),
    params: dict[str, Any] = Field(
        default_factory=dict,
        description='可选。模板参数，如 {"x":"category","y":"value"}。',
    ),
    wait: bool = Field(
        default=False,
        description=(
            "可选。false（默认）=提交后立即返回任务 id；true=等待渲染完成，"
            "但渲染可能超过工具超时（30s），超时后任务仍在后台继续。"
        ),
    ),
    ctx: Context = None,
) -> dict[str, Any]:
    """以**调用者本人**的身份提交一次出版级图表渲染，返回任务 id 与成品链接。"""
    user_id, failure = _caller(ctx)
    if failure is not None:
        return failure
    chart_id = (chart or "").strip()
    if not chart_id:
        return error("参数 chart 不能为空", retryable=False)
    body = {
        "chart": chart_id,
        "title": (title or "").strip(),
        "data": data or "",
        "sample": (sample or "").strip(),
        "params": params or {},
        "wait": bool(wait),
    }
    result = await PORTAL.plot_submit(body, user_id)
    if "error" in result:
        return result
    job = result["data"]
    outputs = job.get("outputs") or []
    base = PORTAL.public_host
    files = [
        {
            "path": out.get("path"),
            "size": out.get("size"),
            "url": (
                f"http://{base}/api/next/v1/plot/jobs/"
                f"{job.get('id')}/file?path={out.get('path')}"
            ),
        }
        for out in outputs
    ]
    return _ok(
        {
            "id": job.get("id"),
            "chart": job.get("chart"),
            "title": job.get("title"),
            "status": job.get("status"),
            "message": job.get("message"),
            "outputs": files,
        },
    )


# ------------------------------------------------------------------ 目录缓存


async def _database_items(user_id: str | None) -> dict[str, Any]:
    """数据库目录（带 5 分钟缓存）。"""
    now = time.time()
    with _database_lock:
        if _database_cache["items"] and now - _database_cache["at"] < DATABASE_CACHE_TTL:
            return {"items": _database_cache["items"]}
    result = await PORTAL.databases(user_id)
    if "error" in result:
        return result
    items = result["data"].get("items") or []
    with _database_lock:
        _database_cache["at"] = time.time()
        _database_cache["items"] = items
    return {"items": items}


#: 门户客户端（一个进程一个实例足够：httpx 客户端按调用新建）。
PORTAL = PortalClient()


# ------------------------------------------------------------------ 启动


def serve_in_thread(host: str = MCP_HOST, port: int = MCP_PORT) -> threading.Thread:
    """在本进程的后台线程里跑 MCP server。

    为什么是线程而不是独立容器：MCP server 与 AgentScope 同进程，通道密钥
    只存在于内存里（不进环境变量、不进文件、不进日志），外部拿不到；而且它
    只绑 127.0.0.1，容器对外只发布 8100，nginx 与宿主机都够不着这个端口。

    Args:
        host: 监听地址（默认只绑回环）。
        port: 监听端口。

    Returns:
        已启动的后台线程。
    """

    def _run() -> None:
        try:
            server.run(
                transport="streamable-http",
                host=host,
                port=port,
                streamable_http_path=MCP_PATH,
                json_response=True,
                stateless_http=True,
            )
        except Exception:
            log.exception("lab MCP server 退出")

    thread = threading.Thread(
        target=_run,
        name="lab-mcp-server",
        daemon=True,
    )
    thread.start()
    log.info("lab MCP server 已启动：http://%s:%s%s", host, port, MCP_PATH)
    return thread


def main() -> None:
    """独立运行 MCP server（调试用：``python lab_mcp_server.py``）。"""
    logging.basicConfig(level="INFO")
    server.run(
        transport="streamable-http",
        host=MCP_HOST,
        port=MCP_PORT,
        streamable_http_path=MCP_PATH,
        json_response=True,
        stateless_http=True,
    )


if __name__ == "__main__":
    main()

@server.tool(
    name="lab_knowledge_bases",
    annotations=ToolAnnotations(title="我的知识库", read_only_hint=True),
)
async def lab_knowledge_bases(
    ctx: Context = None,
) -> dict[str, Any]:
    """列出**调用者自己**的知识库（id / 名称 / 文档数）。

    先用它拿到 ``knowledge_base_id``，再调 lab_knowledge_search 检索。
    """
    user_id, failure = _caller(ctx)
    if failure is not None:
        return failure
    result = await PORTAL._request(
        "GET", f"{PORTAL.backend_base}/api/agent/as/knowledge_bases", user_id=user_id
    )
    if "error" in result:
        return result
    data = result["data"]
    bases = data.get("knowledge_bases") or []
    return _ok(
        {
            "count": len(bases),
            "knowledge_bases": [
                {
                    "id": b.get("knowledge_base_id") or b.get("id"),
                    "name": b.get("name"),
                    "documents": b.get("document_count"),
                }
                for b in bases
            ],
        },
    )


@server.tool(
    name="lab_literature_search",
    annotations=ToolAnnotations(title="文献库检索", read_only_hint=True),
)
async def lab_literature_search(
    q: str = Field(default="", description="可选。标题/作者/摘要关键词。"),
    limit: int = Field(default=10, description="返回条数上限，默认 10。"),
    ctx: Context = None,
) -> dict[str, Any]:
    """检索**调用者自己**收藏的文献（不是联网检索；联网请用 lab_web_search）。"""
    user_id, failure = _caller(ctx)
    if failure is not None:
        return failure
    result = await PORTAL.literature_search(q, limit, user_id)
    if "error" in result:
        return result
    data = result["data"]
    items = data.get("items") or data.get("literature") or []
    return _ok(
        {
            "count": len(items),
            "items": [
                {
                    "title": it.get("title"),
                    "authors": it.get("authors"),
                    "year": it.get("pub_year") or it.get("year"),
                    "venue": it.get("journal") or it.get("venue"),
                    "doi": it.get("doi"),
                    "url": it.get("url"),
                    "abstract": _trim(it.get("abstract"), 400),
                }
                for it in items
            ],
        },
    )


@server.tool(
    name="lab_seeds_low_stock",
    annotations=ToolAnnotations(title="种子台账（低库存）", read_only_hint=True),
)
async def lab_seeds_low_stock(
    limit: int = Field(default=20, description="返回条数上限，默认 20。"),
    ctx: Context = None,
) -> dict[str, Any]:
    """按数量升序列出种子批次，便于发现快用完的种质。"""
    user_id, failure = _caller(ctx)
    if failure is not None:
        return failure
    result = await PORTAL.seeds_low_stock(limit, user_id)
    if "error" in result:
        return result
    data = result["data"]
    items = data.get("items") or []
    return _ok(
        {
            "count": len(items),
            "items": [
                {
                    "name": it.get("name"),
                    "code": it.get("code"),
                    "species": it.get("species"),
                    "quantity": it.get("quantity"),
                    "unit": it.get("unit"),
                    "location": it.get("location"),
                    "owner": it.get("owner_name") or it.get("owner"),
                }
                for it in items
            ],
        },
    )


@server.tool(
    name="lab_meeting_files",
    annotations=ToolAnnotations(title="组会材料", read_only_hint=True),
)
async def lab_meeting_files(
    week: str = Field(default="", description="ISO 周，如 2026-W48；留空则列出所有可见周目录。"),
    ctx: Context = None,
) -> dict[str, Any]:
    """组会周目录与其中的材料。未授权的周目录**不会出现**（后端按 ACL 过滤）。"""
    user_id, failure = _caller(ctx)
    if failure is not None:
        return failure
    result = await PORTAL.meeting_weeks(week, user_id)
    if "error" in result:
        return result
    data = result["data"]
    if week:
        files = data.get("files") or []
        return _ok(
            {
                "week": week,
                "count": len(files),
                "files": [
                    {"name": f.get("name"), "size": f.get("size"), "modified": f.get("modified")}
                    for f in files
                ],
            },
        )
    weeks = data.get("weeks") or []
    return _ok(
        {
            "current_week": data.get("currentWeek"),
            "count": len(weeks),
            "weeks": [
                {
                    "week": w.get("yearWeek"),
                    "files": w.get("fileCount"),
                    "size_bytes": w.get("sizeBytes"),
                }
                for w in weeks
            ],
        },
    )


@server.tool(
    name="lab_research_folder",
    annotations=ToolAnnotations(title="我的课题资料目录", read_only_hint=True),
)
async def lab_research_folder(
    ctx: Context = None,
) -> dict[str, Any]:
    """调用者的课题资料目录（学生只有自己那棵，教师看自己那份）。"""
    user_id, failure = _caller(ctx)
    if failure is not None:
        return failure
    result = await PORTAL.research_folders(user_id)
    if "error" in result:
        return result
    return _ok(result["data"])

