"""AgentScope 2.0.11 官方 Agent Service —— 门户的 Agent 后端（共用内核）。

与门户的关系
------------
* 复用同一套身份：nginx 先向门户后端（/api/auth/check）验证会话，**再由 nginx
  注入 X-User-ID**，因此客户端无法伪造身份。本服务不接受外部直连（只绑回环）。
* 复用同一套数据：Session / Agent / Credential / KnowledgeBase 全部落在
  Postgres（独立库 `agentscope`），业务侧不再自建平行的会话表。
* 这里是 create_app 的**装配层**，不重写 AgentScope 的任何能力；缺什么用官方
  扩展点（extra_agent_tools / extra_agent_middlewares / resource_access_policy）。

工具能力（lab_*）
-----------------
门户的科研工具以 **MCP server** 的形式接进来（`lab_mcp_server.py`，官方 `mcp`
包，Streamable HTTP，只绑容器回环）。本文件只做两件事，都是官方扩展点：

* ``extra_agent_tools``：每轮对话按 **调用者** 组装工具 —— 用
  `MCPClient` 连上本进程里的 MCP server，把 ``X-User-ID`` 签成用户断言
  带过去，MCP server 验签后才认这个身份（模型给不了身份）。
* ``extra_agent_middlewares``：门户助手没有「点确认」的 UI，lab 工具里的写操作
  （工作台捕获 / 绘图提交）默认会停在「等用户确认」；这里只对 lab 工具放行，
  其余工具的权限判定保持 AgentScope 原样。

知识库（RAG）与长期记忆
-----------------------
两件事都是 **AgentScope 原生能力**，这里只做装配：

* **知识库**：``knowledge_base_manager``（官方
  ``CollectionPerKbManager``，一库一集合）+ ``QdrantStore``（向量库）+
  ``LocalBlobStore``（文档原件）+ 自带的 PDF/DOCX/TXT/Markdown 解析器与
  分块器。向量模型走内网 bge-m3（见 `lab_embedding.py`）。
* **长期记忆**：官方 ``AgenticMemoryMiddleware``（文件式记忆，落在会话工作区
  下的 ``Memory/``），通过 ``extra_agent_middlewares`` 工厂每轮挂上；官方实现
  在门户场景下有两个会「流永不结束」的坑，这里用 ``lab_memory.py`` 的加固版
  （独立检索模型 + 超时 + 异常兜底）与 ``LabToolMiddleware`` 的权限策略
  （不提供确认入口的工具一律拒绝，绝不停在「等确认」）兜住。

2.0.11 的几处「签名与直觉不同」的地方，都按源码写（详见代码注释）：
向量模型**不是** manager 的构造参数，而是每个知识库创建时从 storage 里的
凭据解析出来的；长期记忆**没有** app 级开关，只能走中间件工厂。
"""

# pyright: reportMissingImports=false, reportMissingModuleSource=false
# 上面这条只关「模块找不到」这一类诊断：agentscope 装在**本目录自己的镜像**里
# （见 Dockerfile / requirements.txt），不在仓库根环境的 Python 里。文件内部的
# 类型错误仍然照常检查。若在仓库根统一关掉这个规则，会连真正的缺依赖一起藏掉。
from __future__ import annotations

import logging
import os
from collections.abc import Awaitable, Callable

from agentscope.agent import Agent
from agentscope.app import SubAgentTemplate, create_app
from agentscope.app.channel import DingTalkChannel, DiscordChannel, FeishuChannel
from agentscope.app.hub import ClawSkillHub, GitHubMCPHub
from agentscope.app.message_bus import InMemoryMessageBus
from agentscope.app.rag.blob_store import LocalBlobStore
from agentscope.app.rag.knowledge_base_manager import CollectionPerKbManager
from agentscope.app.storage import (
    AsyncSQLAlchemyStorage,
    ChunkerConfig,
    EmbeddingModelConfig,
    KnowledgeBaseRecord,
)
from agentscope.app.workspace_manager import LocalWorkspaceManager
from agentscope.mcp import HttpMCPConfig, MCPClient
from agentscope.middleware import MiddlewareBase
from agentscope.permission import (
    PermissionBehavior,
    PermissionContext,
    PermissionDecision,
    PermissionMode,
)
from agentscope.rag import (
    ApproxTokenChunker,
    ExcelParser,
    PDFParser,
    QdrantStore,
    TextParser,
    WordParser,
)
from agentscope.tool import ToolBase
from agentscope.workspace import WorkspaceBase

import lab_access
import lab_mcp_server
from lab_embedding import (
    EMBED_DIM,
    EMBED_ENDPOINT,
    EMBED_MODEL,
    LAB_EMBEDDING_CREDENTIAL_TYPE,
    LabEmbeddingCredential,
    embedding_credential_id,
)
from lab_identity import CHANNEL_HEADER, CHANNEL_TOKEN, mint_user_assertion
from lab_memory import LabAgenticMemoryMiddleware

log = logging.getLogger("agentscope.service")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

# 数据库：与门户同实例、独立库。用独立库而不是同库不同 schema ——
# AgentScope 自带 alembic，schema 隔离需要给 asyncpg 与 alembic 两侧都加
# search_path，任何一侧漏配都会写到 public，风险高于收益。
DSN = os.getenv(
    "AGENTSCOPE_DB_DSN",
    "postgresql+asyncpg://labspace:labspace-local-dev-pw@lab-postgres:5432/agentscope",
)
WORKSPACE_DIR = os.getenv("AGENTSCOPE_WORKSPACE_DIR", "/srv/agentscope/workspaces")

# 知识库（RAG）装配参数（全部走环境变量）。
#   AGENTSCOPE_QDRANT_URL —— compose 内的 qdrant 服务（不发布宿主机端口）
#   AGENTSCOPE_BLOB_DIR   —— 知识库文档原件的落盘目录（挂载卷）
QDRANT_URL = os.getenv("AGENTSCOPE_QDRANT_URL", "http://qdrant:6333")
BLOB_DIR = os.getenv("AGENTSCOPE_BLOB_DIR", "/srv/agentscope/blobs")

# lab MCP server（与本服务同进程、只绑回环）。
LAB_MCP_URL = os.getenv(
    "LAB_MCP_URL",
    f"http://{lab_mcp_server.MCP_HOST}:{lab_mcp_server.MCP_PORT}{lab_mcp_server.MCP_PATH}",
)
# 单次工具调用的超时（秒）：任务要求 ≤30s。
LAB_TOOL_TIMEOUT = float(os.getenv("LAB_TOOL_TIMEOUT", "30"))

storage = AsyncSQLAlchemyStorage(
    DSN,
    # 单实例部署，启动即建表最省事；多副本时必须改成独立迁移步骤，
    # 否则两个副本会并发跑同一份 DDL。
    create_tables=True,
    auto_migrate=False,
)


def _subagent_templates() -> list[SubAgentTemplate]:
    """为 Agent Team 注册实验室专用的子智能体类型。

    AgentScope 2.0.12 的团队能力默认是内置通用 worker；注册模板后，
    leader 的 ``AgentCreate`` 工具会暴露 ``subagent_type`` 枚举，
    可以按任务选角色，而不是所有 worker 共用一套提示词。

    三个模板各有明确的权限边界：
    - ``explorer`` 只读：检索文献/基因库/台账，不许写；
    - ``analyst`` 可读可算：允许调用 lab 工具并在自己的工作区写分析产物；
    - ``reviewer`` 只读：对已有结论做复核，不许改原始资料。
    """
    base = """你是 {member_name}，由 {leader_name} 领导的团队「{team_name}」中的 {type} 智能体。

团队目标：{team_description}
你的角色：{member_description}

## 工作约定
- 只做本角色职责范围内的事；用 lab_* 工具取**真实数据**，不要凭记忆编造。
- 引用文献必须带来源；涉及种子/课题资料的数字必须来自工具返回。
- 完成后用 TeamSay 向 {leader_name} 汇报：结论、依据、来源、未完成事项。
"""
    return [
        SubAgentTemplate(
            type="explorer",
            description="只读调研员：检索文献、种子台账、组会资料与公共数据库，只汇报事实与来源，不修改任何数据。",
            system_prompt_template=(
                base + "\n## 角色边界\n- 你是**只读**的：不写工作台、不提交绘图、不改文件。\n"
            ),
            permission_context=PermissionContext(mode=PermissionMode.EXPLORE),
            override_leader_mode=True,
        ),
        SubAgentTemplate(
            type="analyst",
            description="分析员：在只读检索的基础上做统计、比较与可视化，允许在**自己工作区**写分析产物。",
            system_prompt_template=base
            + "\n## 角色边界\n- 可以写自己的分析文件；但仍不得改动他人的资料或台账。\n",
            permission_context=PermissionContext(mode=PermissionMode.ACCEPT_EDITS),
        ),
        SubAgentTemplate(
            type="reviewer",
            description="复核员：只读检查结论的证据链、来源与逻辑漏洞，不改原始资料，不给无依据的结论背书。",
            system_prompt_template=base
            + "\n## 角色边界\n- 你是**只读**的：只指出问题与依据，不修改任何内容。\n",
            permission_context=PermissionContext(mode=PermissionMode.EXPLORE),
            override_leader_mode=True,
        ),
    ]


async def lab_tools(
    user_id: str,
    agent_id: str,
    session_id: str,
) -> list[ToolBase]:
    """每轮对话按调用者组装 lab 工具（官方 ``extra_agent_tools`` 扩展点）。

    身份链：nginx 校验会话 → 注入 ``X-User-ID`` → AgentScope 取到 user_id →
    这里用进程内密钥把它签成用户断言，随 MCP 请求头带给 MCP server。MCP server
    验签 + 防重放后才认这个身份，所以「模型想调」不能变成「以别人身份调」。

    Args:
        user_id: 已由门户会话校验过的用户 id。
        agent_id: 本轮对话的助手 id。
        session_id: 本轮对话的会话 id。

    Returns:
        本轮可用的 MCP 工具（``MCPTool``）。MCP server 不可用时返回空列表，
        助手照常工作，只是没有 lab 能力。
    """
    client = MCPClient(
        name="lab",
        is_stateful=False,
        mcp_config=HttpMCPConfig(
            url=LAB_MCP_URL,
            headers={CHANNEL_HEADER: CHANNEL_TOKEN},
            timeout=LAB_TOOL_TIMEOUT,
        ),
        execution_timeout=LAB_TOOL_TIMEOUT,
    )
    try:
        await client.set_runtime_headers(
            {"X-Lab-User-Assertion": mint_user_assertion(user_id)},
        )
        return await client.list_tools()
    except Exception as exc:  # noqa: BLE001 - 工具接不上不该打断助手
        log.warning("lab 工具不可用（%s: %s）", type(exc).__name__, exc)
        return []


class LabKnowledgeBaseManager(CollectionPerKbManager):
    """在原生 manager 之上补齐「内网向量模型」这一段装配。

    2.0.11 原生签名（``inspect.signature``）::

        CollectionPerKbManager(storage, vector_store)

    —— **没有 embedding model 参数**。向量模型是**每个知识库创建时**从
    storage 里的凭据解析出来的（``CollectionPerKbManager.get_knowledge``：
    读 KB 记录上的 ``embedding_model_config`` → 按 ``credential_id`` 取
    凭据 → ``build_embedding_model`` 建模型）。所以要让知识库用上内网
    bge-m3，必须在创建知识库之前：

    1. 给 owner 落一条指向内网向量服务的凭据（id 按用户确定性生成，
       重复建库不会堆重复凭据）；
    2. 把知识库上绑的 embedding 配置换成**平台配置**（模型 / 维度来自环境
       变量）——门户侧目前没有「选向量模型」这一步，平台固定一份最省事，
       换模型就换环境变量 + 重建知识库（集合维度是建库时定的，不能改）。

    其余行为（集合命名、删除联动、越权保护）完全保持原生。
    """

    async def create_knowledge_base(
        self,
        user_id: str,
        name: str,
        description: str,
        embedding_model_config: EmbeddingModelConfig,
        chunker_config: ChunkerConfig | None = None,
    ) -> KnowledgeBaseRecord:
        """创建知识库：先落内网向量凭据，再用平台 embedding 配置建库。

        Args:
            user_id: 知识库 owner 的用户 id。
            name: 展示名。
            description: 描述。
            embedding_model_config: 调用方传入的 embedding 配置（被平台配置
                覆盖，见类文档）。
            chunker_config: 分块器配置（原生行为，不动）。

        Returns:
            新建的知识库记录。
        """
        platform_config = self._platform_embedding_config(user_id)
        await self._ensure_embedding_credential(user_id)
        if embedding_model_config != platform_config:
            log.info(
                "知识库 %r 的 embedding 配置被平台配置覆盖：%s → %s",
                name,
                embedding_model_config,
                platform_config,
            )
        return await super().create_knowledge_base(
            user_id,
            name,
            description,
            platform_config,
            chunker_config,
        )

    @staticmethod
    def _platform_embedding_config(user_id: str) -> EmbeddingModelConfig:
        """按环境变量拼出平台固定的 embedding 配置。

        Args:
            user_id: 知识库 owner 的用户 id（决定用哪条内网向量凭据）。

        Returns:
            指向内网向量模型的 embedding 配置。
        """
        return EmbeddingModelConfig(
            type=LAB_EMBEDDING_CREDENTIAL_TYPE,
            credential_id=embedding_credential_id(user_id),
            model=EMBED_MODEL,
            dimensions=EMBED_DIM,
            parameters={},
        )

    async def _ensure_embedding_credential(self, user_id: str) -> None:
        """保证 owner 名下有一条指向内网向量服务的凭据。

        凭据是「知识库 → 向量模型」这条链的最后一环：原生 manager 取模型
        时按 ``credential_id`` 到 owner 名下查凭据，查不到就直接报错。

        Args:
            user_id: 知识库 owner 的用户 id。
        """
        credential = LabEmbeddingCredential(
            id=embedding_credential_id(user_id),
            name=f"内网向量模型（{EMBED_MODEL}）",
            base_url=EMBED_ENDPOINT,
        )
        await self._storage.upsert_credential(user_id, credential)


class LabToolMiddleware(MiddlewareBase):
    """门户的权限策略：放行该放行的，**绝不停在「等确认」**。

    AgentScope 对「会改东西」的工具默认要用户点确认，而门户助手没有这个 UI：
    不处理的话，工作台捕获 / 绘图提交 / 长期记忆写文件都会一直停在
    「等确认」，助手看起来像坏了（2026-11-10 实测：助手停在等确认时，
    ``REPLY_END`` 永远不发，前端一直转圈；数据库里能看到 tool_call 的
    state 卡在 ``asking``）。

    这里的三条规则：

    1. **lab MCP 工具**放行：它们的写操作只落在调用者自己的数据里，
       门户按 user_id 过滤。
    2. **长期记忆目录内的 Write/Edit** 放行：官方记忆中间件就是让模型
       自己往 ``{workdir}/Memory/`` 写记忆文件，不放行记忆就永远存不下来。
    3. 其余工具仍走 AgentScope 原生判定，但**只读调用照常放行**（原生
       read-only 快路径），凡是会停在「等确认」的（写文件、复合 shell
       命令等）一律改成**拒绝**：模型收到报错后自己换条路走，
       助手不会卡死，用户能拿到完整回复。
    """

    #: 允许写入长期记忆目录的文件工具（官方中间件靠它们落盘记忆）。
    MEMORY_WRITE_TOOLS = frozenset({"Write", "Edit"})

    def __init__(
        self,
        workdir: str | None = None,
        memory_dir: str = "Memory",
    ) -> None:
        """初始化权限中间件。

        Args:
            workdir: 本轮会话的工作区目录（记忆目录是它下面的 ``Memory/``）。
            memory_dir: 记忆目录名（相对 workdir）。
        """
        self._workdir = os.path.abspath(workdir) if workdir else None
        self._memory_dir = (
            os.path.realpath(os.path.join(self._workdir, memory_dir)) if self._workdir else None
        )

    async def on_check_permission(
        self,
        agent: Agent,
        input_kwargs: dict,
        next_handler: Callable[..., Awaitable[PermissionDecision]],
    ) -> PermissionDecision:
        """判定工具调用权限。

        Args:
            agent: 本轮对话的执行体（本中间件不依赖它）。
            input_kwargs: 官方中间件契约的入参（``tool`` / ``tool_input``）。
            next_handler: 原生权限判定。

        Returns:
            权限判定；绝不返回「等确认」。
        """
        tool = input_kwargs.get("tool")
        name = getattr(tool, "name", "") or ""
        if name.startswith("mcp__lab__"):
            return PermissionDecision(
                behavior=PermissionBehavior.ALLOW,
                message="lab 门户工具：只对调用者本人的数据生效。",
            )
        if name in self.MEMORY_WRITE_TOOLS and self._is_memory_path(
            input_kwargs.get("tool_input") or {},
        ):
            return PermissionDecision(
                behavior=PermissionBehavior.ALLOW,
                message="长期记忆文件：允许写入本轮会话的记忆目录。",
            )
        decision = await next_handler(**input_kwargs)
        if decision.behavior in (
            PermissionBehavior.ASK,
            PermissionBehavior.PASSTHROUGH,
        ):
            # 门户没有确认入口：停在「等确认」等于整轮对话卡死。
            # 改成拒绝，模型会拿到报错并自己换条路走。
            return PermissionDecision(
                behavior=PermissionBehavior.DENY,
                message=(
                    f"门户助手不提供「{name}」的人工确认入口"
                    f"（{decision.message}），已拒绝该调用；"
                    f"请改用可用的工具继续。"
                ),
                decision_reason="No confirmation UI in the portal",
            )
        return decision

    def _is_memory_path(self, tool_input: dict) -> bool:
        """判断文件工具的目标路径是否落在长期记忆目录内。

        Args:
            tool_input: 工具入参（Write/Edit 用 ``file_path``）。

        Returns:
            落在记忆目录内时返回 ``True``。
        """
        if not self._memory_dir or not self._workdir:
            return False
        raw = str(tool_input.get("file_path") or "").strip()
        if not raw:
            return False
        path = raw if os.path.isabs(raw) else os.path.join(self._workdir, raw)
        path = os.path.realpath(path)
        return path == self._memory_dir or path.startswith(
            self._memory_dir + os.sep,
        )


def _memory_middleware(workspace: WorkspaceBase | None) -> MiddlewareBase | None:
    """按会话工作区装配长期记忆中间件（官方实现的加固版）。

    2.0.11 **没有** app 级的「长期记忆开关」，官方入口只有中间件：这里走
    ``extra_agent_middlewares`` 工厂。记忆中间件需要一个 workdir（记忆文件
    写在 ``{workdir}/Memory/``，``MEMORY.md`` 是索引），所以用会话工作区的
    workdir —— 工作区按 agent 分目录且落在挂载卷上，记忆因此跨会话、跨重启
    留存；工作区的 backend 也一并沿用，记忆文件与工作区文件走同一套读写。

    默认开启（``AGENTSCOPE_MEMORY=1``）。2026-11-10 实测的根因与兜底：

    * **根因**：官方 ``AgenticMemoryMiddleware`` 的记忆指令会把模型引到
      ``{workdir}/Memory/`` 上动手（``ls`` / ``Write`` / ``Grep``）。门户
      没有「点确认」的 UI，而 AgentScope 对写操作、带重定向的复合 shell
      命令的默认判定是 **ASK** —— 助手就停在「等用户确认」，``REPLY_END``
      永远不发，前端一直转圈（数据库里 tool_call 的 state 卡在 ``asking``）。
      官方实现另有一处隐患：检索任务复用主回复的模型实例，收尾时无界
      ``await`` 它，端点一卡整条流也收不到 ``REPLY_END``。
    * **兜底 1**（``LabToolMiddleware``）：不提供确认入口的工具调用一律
      改成**拒绝**（模型拿到报错继续走），只放行 lab 工具与记忆目录内的
      Write/Edit —— 记忆存得下来，助手不会卡死。
    * **兜底 2**（``lab_memory.LabAgenticMemoryMiddleware``）：检索用
      **独立模型实例**（不重试、≤15s 超时），检索失败/超时只记 warning，
      收尾有界等待，绝不把本轮回复卡住。

    Args:
        workspace: 本轮对话解析出来的工作区。

    Returns:
        长期记忆中间件；没有工作区时返回 ``None``（本轮不挂记忆）。
    """
    if workspace is None or os.getenv("AGENTSCOPE_MEMORY", "1") != "1":
        return None
    try:
        backend = workspace.get_backend()
    except RuntimeError:
        # 工作区还没初始化：退回本地文件系统后端，不因为记忆拖垮对话。
        backend = None
    return LabAgenticMemoryMiddleware(
        workdir=workspace.workdir,
        backend=backend,
    )


async def lab_middlewares(
    user_id: str,
    agent_id: str,
    session_id: str,
    workspace: WorkspaceBase | None = None,
) -> list[MiddlewareBase]:
    """每轮对话挂上中间件（官方 ``extra_agent_middlewares`` 扩展点）。

    四参形式（带 workspace）是 2.0.11 支持的签名：``ChatService`` 会探测
    工厂的 arity，只有接受第四个参数的工厂才会拿到工作区。

    Args:
        user_id: 已由门户会话校验过的用户 id。
        agent_id: 本轮对话的助手 id。
        session_id: 本轮对话的会话 id。
        workspace: 本轮对话的工作区（长期记忆的落盘位置）。

    Returns:
        本轮的中间件列表。
    """
    middlewares: list[MiddlewareBase] = [
        # 权限策略要知道工作区：长期记忆目录（{workdir}/Memory/）里的
        # Write/Edit 需要放行，其余会停在「等确认」的调用一律拒绝。
        LabToolMiddleware(workspace.workdir if workspace else None),
    ]
    memory = _memory_middleware(workspace)
    if memory is not None:
        middlewares.append(memory)
    return middlewares


# lab MCP server 与本服务同进程：只绑回环，通道密钥只在内存里。
lab_mcp_server.serve_in_thread()

# 知识库（RAG）装配：向量库 + 文档原件存储 + 解析器 / 分块器。
#   knowledge_base_manager —— 一库一集合（官方 CollectionPerKbManager）
#   blob_store            —— 上传文档的原件（官方 LocalBlobStore）
#   knowledge_parsers     —— 自带解析器：TXT/Markdown/CSV/JSON、PDF、DOCX
#   knowledge_chunkers    —— 自带分块器：ApproxTokenChunker
knowledge_base_manager = LabKnowledgeBaseManager(
    storage=storage,
    vector_store=QdrantStore(url=QDRANT_URL),
)
blob_store = LocalBlobStore(root_dir=BLOB_DIR)

app = create_app(
    storage=storage,
    message_bus=InMemoryMessageBus(),
    workspace_manager=LocalWorkspaceManager(WORKSPACE_DIR),
    knowledge_base_manager=knowledge_base_manager,
    knowledge_parsers=[TextParser(), PDFParser(), WordParser(), ExcelParser()],
    knowledge_chunkers=[ApproxTokenChunker],
    blob_store=blob_store,
    extra_credentials=[LabEmbeddingCredential],
    extra_agent_tools=lab_tools,
    extra_agent_middlewares=lab_middlewares,
    # —— 2.0.12 官方扩展点 ——
    custom_subagent_templates=_subagent_templates(),
    resource_access_policy=lab_access.LabResourceAccessPolicy(),
    # IM 渠道：注册类型即可，具体机器人凭据由管理员在能力中心添加。
    channels=[FeishuChannel, DingTalkChannel, DiscordChannel],
    # MCP / 技能中心：让用户从市场安装到自己资源池，再装配到工作区。
    mcp_hubs=[GitHubMCPHub()],
    skill_hubs=[ClawSkillHub()],
    title="D509 科研助手（AgentScope）",
)


@app.get("/healthz", include_in_schema=False)
async def healthz() -> dict[str, object]:
    """给 nginx/运维探活用的最小端点，不触发任何模型调用。"""
    return {"ok": True, "service": "agentscope", "version": app.version}
