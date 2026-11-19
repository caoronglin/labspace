"""内网向量模型（bge-m3）接入 AgentScope 的那一层。

为什么不能直接用 agentscope 自带的 ``OpenAIEmbeddingModel``
----------------------------------------------------------
内网模型服务的 ``/v1/embeddings`` **不是** OpenAI 协议：

* 请求：``{"texts": ["...", ...]}``（OpenAI 协议是 ``{"input": [...]}``）
* 响应：``{"model": ..., "dimension": 1024, "count": n, "dense": [[...], ...]}``
  （OpenAI 协议是 ``{"data": [{"embedding": [...]}, ...]}``）

直接用 ``OpenAIEmbeddingModel`` 会被服务端以 422 拒绝（缺 ``texts``），
所以这里按 **官方扩展点** 写一个最小的 embedding 实现：

* :class:`LabEmbeddingCredential` —— 自定义凭据类型，通过
  ``create_app(extra_credentials=...)`` 注册（这是 2.0.11 里唯一的自定义
  provider 入口，见 ``CredentialFactory.register_credential``）。
* :class:`LabEmbeddingModel` —— 由上面的凭据解析出来的 embedding 模型；
  ``CredentialBase.get_embedding_model_class()`` 是官方的「凭据 → 模型」
  映射点，知识库管理器就是靠它把凭据变成可调用的向量模型。

知识库侧还差一环：2.0.11 的向量模型**不是** ``create_app`` / manager 的
构造参数，而是**每个知识库创建时**从 storage 里的凭据解析出来的（见
``CollectionPerKbManager.get_knowledge``）。这条链路由 app.py 里的
``LabKnowledgeBaseManager`` 补齐。

配置（全部走环境变量）
----------------------
* ``AGENTSCOPE_EMBED_BASE``  —— embeddings 接口完整地址
* ``AGENTSCOPE_EMBED_MODEL`` —— 模型名（默认 ``bge-m3``）
* ``AGENTSCOPE_EMBED_DIM``   —— 向量维度（默认 ``1024``）
"""

from __future__ import annotations

import builtins
import hashlib
import os
import time
from typing import Any, Literal

import httpx
from agentscope.credential import CredentialBase
from agentscope.embedding import (
    EmbeddingModelBase,
    EmbeddingModelCard,
    EmbeddingResponse,
    EmbeddingUsage,
)
from pydantic import Field, SecretStr

#: 内网向量模型的自定义凭据类型（``CredentialFactory`` 的判别式）。
LAB_EMBEDDING_CREDENTIAL_TYPE = "lab_embedding_credential"

#: embeddings 接口完整地址（内网，无需鉴权）。
EMBED_ENDPOINT = os.getenv(
    "AGENTSCOPE_EMBED_BASE",
    "http://192.0.2.17:8000/v1/embeddings",
)
#: 模型名。
EMBED_MODEL = os.getenv("AGENTSCOPE_EMBED_MODEL", "bge-m3")
#: 向量维度：必须与服务端实际输出的一致，否则写入 Qdrant 会被拒。
EMBED_DIM = int(os.getenv("AGENTSCOPE_EMBED_DIM", "1024"))
#: 服务端单条文本的截断长度（token）。
EMBED_MAX_LENGTH = int(os.getenv("AGENTSCOPE_EMBED_MAX_LENGTH", "512"))


def embedding_credential_id(user_id: str) -> str:
    """按用户算出内网向量模型凭据的**确定性** id。

    同一个用户每次装配都得到同一个 id，所以重复创建知识库不会堆出一串
    重复凭据；不同用户的 id 必然不同（凭据表的主键是全局的）。

    Args:
        user_id: 知识库 owner 的用户 id。

    Returns:
        形如 ``lab-embed-<16 位十六进制>`` 的凭据 id。
    """
    digest = hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:16]
    return f"lab-embed-{digest}"


class LabEmbeddingModel(EmbeddingModelBase[str]):
    """内网向量模型（bge-m3）的 embedding 实现。

    协议按内网模型服务的实际形态实现（``texts`` 入参、``dense`` 出参），
    同时兼容 OpenAI 风格的响应体（``data[].embedding``），以便内网服务
    换成标准协议时不必再改这里。
    """

    #: 服务端单请求最多 128 条文本、``batch_size`` 上限 32，这里取小值。
    _BATCH_SIZE = 32

    class Parameters(EmbeddingModelBase.Parameters):
        """内网向量模型没有可调的非维度参数（维度是契约的一部分）。"""

    def __init__(
        self,
        credential: CredentialBase,
        model: str,
        dimensions: int | None,
        parameters: EmbeddingModelBase.Parameters | None = None,
        context_size: int = EMBED_MAX_LENGTH,
        max_retries: int = 3,
        retry_delay: float = 1.0,
        timeout: float = 60.0,
    ) -> None:
        """初始化内网向量模型。

        Args:
            credential: 承载内网地址的 :class:`LabEmbeddingCredential`。
            model: 模型名（``bge-m3``）。
            dimensions: 输出向量维度。
            parameters: 非维度参数（本实现没有）。
            context_size: 单条输入的 token 上限。
            max_retries: 单批次的重试次数。
            retry_delay: 重试间隔（秒）。
            timeout: 单次 HTTP 请求超时（秒）。
        """
        super().__init__(
            credential=credential,
            model=model,
            dimensions=dimensions,
            parameters=parameters,
            context_size=context_size,
            batch_size=self._BATCH_SIZE,
            max_retries=max_retries,
            retry_delay=retry_delay,
        )
        self.endpoint: str = getattr(credential, "base_url", EMBED_ENDPOINT)
        self.timeout = timeout

    @classmethod
    def list_models(
        cls,
        custom_yaml_dir: str | None = None,
    ) -> list[EmbeddingModelCard]:
        """返回内网向量模型的 model card。

        卡片是**按环境变量**生成的：模型名与维度必须与实际服务一致，
        否则前端会按错误的维度建集合。

        Args:
            custom_yaml_dir: 未使用（本实现不读 YAML 卡片）。

        Returns:
            内网向量模型的 model card 列表。
        """
        del custom_yaml_dir
        return [
            EmbeddingModelCard(
                name=EMBED_MODEL,
                label=f"{EMBED_MODEL}（内网向量模型）",
                status="active",
                input_types=["text/plain"],
                output_types=["application/x-embedding"],
                dimensions=EMBED_DIM,
                supported_dimensions=None,
                context_size=EMBED_MAX_LENGTH,
            ),
        ]

    @classmethod
    def _get_retryable_exceptions(cls) -> tuple[type[Exception], ...]:
        """网络层面的瞬时故障值得重试。"""
        return (httpx.TransportError,)

    def _parse_vectors(
        self,
        payload: dict,
        expected: int,
    ) -> list[list[float]]:
        """从响应体里取出向量。

        优先读内网服务的 ``dense``；没有则退回 OpenAI 风格的
        ``data[].embedding``。

        Args:
            payload: 响应 JSON。
            expected: 期望的向量条数。

        Returns:
            与输入一一对应的向量列表。

        Raises:
            ValueError: 条数不符或响应体里没有向量。
        """
        dense = payload.get("dense")
        if isinstance(dense, list) and dense:
            vectors = dense
        else:
            data = payload.get("data")
            if not isinstance(data, list):
                raise ValueError(
                    f"向量服务响应里没有向量字段：{sorted(payload)}",
                )
            vectors = [item.get("embedding") for item in data]
        if len(vectors) != expected:
            raise ValueError(
                f"向量条数不匹配：期望 {expected}，实际 {len(vectors)}",
            )
        for vector in vectors:
            if not isinstance(vector, list) or len(vector) != self.dimensions:
                raise ValueError(
                    f"向量维度不匹配：期望 {self.dimensions}，"
                    f"实际 {len(vector) if isinstance(vector, list) else '非列表'}",
                )
        return vectors

    async def _call_api(
        self,
        inputs: list[str],
        **kwargs: Any,
    ) -> EmbeddingResponse:
        """调用内网向量服务。

        Args:
            inputs: 一批文本（长度不超过 ``batch_size``）。
            **kwargs: 未使用。

        Returns:
            携带向量与耗时的 :class:`EmbeddingResponse`。
        """
        del kwargs
        started = time.monotonic()
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                self.endpoint,
                json={"model": self.model, "texts": list(inputs)},
            )
            response.raise_for_status()
            payload = response.json()
        vectors = self._parse_vectors(payload, len(inputs))
        return EmbeddingResponse(
            embeddings=vectors,
            usage=EmbeddingUsage(
                tokens=None,
                time=time.monotonic() - started,
            ),
        )


class LabEmbeddingCredential(CredentialBase):
    """内网向量模型的凭据（只支持 embedding，不支持对话/语音）。"""

    type: Literal["lab_embedding_credential"] = LAB_EMBEDDING_CREDENTIAL_TYPE
    """凭据类型（``CredentialFactory`` 的判别式）。"""

    base_url: str = Field(
        default=EMBED_ENDPOINT,
        description="内网向量模型的 embeddings 接口完整地址。",
    )
    """内网向量服务地址。"""

    api_key: SecretStr = Field(
        default=SecretStr("labspace-local"),
        description="内网服务无需鉴权，这里只是占位以兼容凭据结构。",
    )
    """占位密钥。"""

    @classmethod
    def get_embedding_model_class(cls) -> builtins.type[EmbeddingModelBase]:
        """返回本凭据对应的 embedding 模型类。"""
        return LabEmbeddingModel

    @classmethod
    def get_chat_model_classes(cls) -> list[builtins.type]:
        """内网向量服务不提供对话模型。"""
        return []
