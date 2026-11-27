"""长期记忆中间件的加固版（AgentScope 2.0.12 官方 ``AgenticMemoryMiddleware``）。

为什么官方中间件在门户里会让「流永不结束」
------------------------------------------
官方实现在 ``on_reply`` 里用 ``asyncio.create_task`` 起一个**检索任务**，
检索用的是 ``agent.model.generate_structured_output(...)`` —— 和主回复
**共用同一个模型实例**，等于在回复过程中对同一个 OpenAI 兼容端点并发发起
第二次调用；``finally`` 里 ``task.cancel()`` 之后紧跟一句
``await self._retrieval_task``，这个 await 一旦卡在端点上，整条回复就再也
收不到 ``REPLY_END``，前端一直转圈。

这个文件做三件事（都在官方中间件之外，不改官方源码）：

1. **检索用独立的模型实例**（方案 A）：同一份凭据、独立的 client，
   ``max_retries=0``、非流式、请求超时 ≤15s，不与主回复抢连接/额度。
   建不出独立实例时**直接关掉异步检索**（等价于方案 B），
   记忆本身仍然可用（``MEMORY.md`` 索引照样进系统提示，模型自己
   Read/Grep 记忆文件）。
2. **检索整体套超时 + try/except**：检索失败或超时只记 warning，
   本轮回复照常进行（只是少注入一段记忆），绝不影响用户看到的内容。
3. **收尾有界**：``finally`` 里取消检索任务后**最多等 1s**，
   端点再不听话也不会把回复卡死。

配套的权限策略在 ``app.py`` 的 ``LabToolMiddleware`` 里：门户没有
「点确认」的 UI，所以任何会停在「等确认」的工具调用都必须改成拒绝。
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import os
from collections.abc import AsyncGenerator, Callable

from agentscope.agent import Agent
from agentscope.message import Msg
from agentscope.middleware import AgenticMemoryMiddleware
from agentscope.model import ChatModelBase

log = logging.getLogger("agentscope.service")

# 检索（挑记忆文件）的整体超时：秒。任务要求 ≤15s。
RETRIEVAL_TIMEOUT = float(
    os.getenv("AGENTSCOPE_MEMORY_RETRIEVAL_TIMEOUT", "15"),
)
# 回复收尾时等待检索任务结束的上限：秒。超过就放弃，绝不把回复卡住。
RETRIEVAL_SHUTDOWN_TIMEOUT = float(
    os.getenv("AGENTSCOPE_MEMORY_SHUTDOWN_TIMEOUT", "1"),
)


def build_retrieval_model(agent_model: ChatModelBase) -> ChatModelBase | None:
    """按主回复的模型**另建一个实例**，专门给记忆检索用。

    为什么必须是独立实例：官方实现默认 ``retrieval_model=None``，
    于是检索直接复用 ``agent.model`` —— 同一个 client、同一份连接池，
    在主回复流式输出的同时再打一次同一个端点，既抢连接又放大失败面。
    独立实例可以用更激进的参数（不重试、短超时、非流式），
    坏了也只影响「这一轮少注入一段记忆」。

    Args:
        agent_model: 本轮回复用的模型实例（拿它的凭据与模型名）。

    Returns:
        新的模型实例；构造不出来时返回 ``None``（调用方据此关闭异步检索）。
    """
    model_cls = type(agent_model)
    common = {
        "credential": agent_model.credential,
        "model": agent_model.model,
        "parameters": agent_model.parameters,
    }
    # 逐级降级：带 client_kwargs 的完整参数 → 只带重试参数 → 最简参数。
    # 不同 provider 的构造签名不一样，所以不能只试一种。
    attempts = (
        {
            **common,
            "stream": False,
            "max_retries": 0,
            "retry_delay": 1.0,
            "client_kwargs": {
                "timeout": RETRIEVAL_TIMEOUT,
                "max_retries": 0,
            },
        },
        {**common, "stream": False, "max_retries": 0, "retry_delay": 1.0},
        {**common},
    )
    for kwargs in attempts:
        try:
            return model_cls(**kwargs)
        except Exception as exc:
            log.debug(
                "记忆检索模型构造失败（%s: %s），尝试下一种参数。",
                type(exc).__name__,
                exc,
            )
    log.warning("无法为记忆检索建立独立模型实例，本轮关闭异步检索。")
    return None


def _swallow_task_result(task: asyncio.Task) -> None:
    """任务结束但没人 await 时，别让 asyncio 刷「异常未取回」的告警。"""
    if not task.cancelled():
        task.exception()


class LabAgenticMemoryMiddleware(AgenticMemoryMiddleware):
    """官方 ``AgenticMemoryMiddleware`` + 三处加固。

    * 检索走**独立模型实例**（见 :func:`build_retrieval_model`）；
    * 检索有**整体超时**与**异常兜底**，失败只记 warning；
    * 收尾**有界等待**，不会把本轮回复卡住。
    """

    def __init__(
        self,
        *,
        workdir: str,
        backend: object | None = None,
        retrieval_timeout: float = RETRIEVAL_TIMEOUT,
        shutdown_timeout: float = RETRIEVAL_SHUTDOWN_TIMEOUT,
    ) -> None:
        """初始化加固版长期记忆中间件。

        Args:
            workdir: 记忆文件所在的工作区目录（``{workdir}/Memory/``）。
            backend: 记忆文件的读写后端；``None`` 用本地文件系统。
            retrieval_timeout: 检索的整体超时（秒）。
            shutdown_timeout: 回复收尾时等待检索任务的上限（秒）。
        """
        super().__init__(
            workdir=workdir,
            backend=backend,
            parameters=AgenticMemoryMiddleware.Parameters(),
        )
        self._retrieval_timeout = retrieval_timeout
        self._shutdown_timeout = shutdown_timeout
        self._retrieval_model: ChatModelBase | None = None

    async def on_reply(
        self,
        agent: Agent,
        input_kwargs: dict,
        next_handler: Callable[..., AsyncGenerator],
    ) -> AsyncGenerator:
        """起检索任务 → 转发本轮回复 → 有界收尾。

        官方实现在这里 ``create_task`` + ``finally`` 里无界 ``await``；
        这里换成：独立模型实例 + 超时 + 有界收尾。

        Args:
            agent: 本轮回复的执行体（提供模型与工作区）。
            input_kwargs: 转发给下游的入参。
            next_handler: 下游中间件或核心回复逻辑。

        Yields:
            下游产出的事件。
        """
        self._retrieval_model = build_retrieval_model(agent.model)
        if self._retrieval_model is not None:
            self._parameters.retrieval_model = self._retrieval_model
        else:
            # 建不出独立实例就不做异步检索（等价于 retrieval_async=False）：
            # 与其复用主回复的模型实例抢同一个端点，不如不检索。
            # 记忆本身不受影响 —— MEMORY.md 索引照样进系统提示。
            self._parameters.retrieval_async = False

        query = self._collect_query(input_kwargs)
        if query and self._parameters.retrieval_async:
            self._retrieval_task = asyncio.create_task(
                self._retrieve_relevant_files(agent, query),
            )

        try:
            async for item in next_handler(**input_kwargs):
                yield item
        except Exception:
            log.warning("长期记忆中间件异常，本轮回复按原样结束。", exc_info=True)
            raise
        finally:
            await self._shutdown_retrieval()

    async def _retrieve_relevant_files(
        self,
        agent: Agent,
        query: str,
    ) -> str | None:
        """检索相关记忆文件，失败/超时都只记 warning。

        Args:
            agent: 本轮回复的执行体。
            query: 本轮用户输入（检索用的查询串）。

        Returns:
            可注入的检索结果；失败或超时时返回 ``None``（本轮不注入记忆）。
        """
        inner = asyncio.ensure_future(
            super()._retrieve_relevant_files(agent, query),
        )
        inner.add_done_callback(_swallow_task_result)
        try:
            # shield + 显式 cancel：超时后**不等**内层任务结束。
            # 端点不响应取消时，也不会把本轮回复拖死。
            return await asyncio.wait_for(
                asyncio.shield(inner),
                timeout=self._retrieval_timeout,
            )
        except TimeoutError:
            inner.cancel()
            log.warning(
                "长期记忆检索超时（%.0fs），本轮不注入记忆。",
                self._retrieval_timeout,
            )
            return None
        except asyncio.CancelledError:
            inner.cancel()
            raise
        except Exception:
            inner.cancel()
            log.warning("长期记忆检索失败，本轮不注入记忆。", exc_info=True)
            return None

    async def _shutdown_retrieval(self) -> None:
        """取消检索任务并**有界**等待，然后关掉独立模型的 client。"""
        task = self._retrieval_task
        self._retrieval_task = None
        if task is not None:
            if not task.done():
                task.cancel()
            try:
                # asyncio.wait 不会把子任务的异常抛出来，超时也只是返回，
                # 因此这里永远不会因为检索任务而卡住收尾。
                await asyncio.wait({task}, timeout=self._shutdown_timeout)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.debug("等待记忆检索任务结束时出错。", exc_info=True)
        await self._close_retrieval_model()

    async def _close_retrieval_model(self) -> None:
        """关掉独立检索模型的 client（否则每轮泄漏一个连接池）。"""
        model = self._retrieval_model
        self._retrieval_model = None
        self._parameters.retrieval_model = None
        if model is None:
            return
        client = getattr(model, "client", None)
        close = getattr(client, "close", None)
        if close is None:
            return
        try:
            result = close()
            if inspect.isawaitable(result):
                await result
        except Exception:
            log.debug("关闭记忆检索模型失败。", exc_info=True)

    @staticmethod
    def _collect_query(input_kwargs: dict) -> str:
        """从回复入参里取出本轮用户输入，作为检索查询串。

        Args:
            input_kwargs: 回复入参（``inputs`` 可能是 Msg 或 Msg 列表）。

        Returns:
            查询串；取不到时返回空串。
        """
        inputs = input_kwargs.get("inputs")
        msgs: list[Msg] | None = None
        if isinstance(inputs, list) and all(isinstance(_, Msg) for _ in inputs):
            msgs = inputs
        elif isinstance(inputs, Msg):
            msgs = [inputs]
        if msgs is None:
            return ""
        return "\n".join(
            f"{_.name}: " + _.get_text_content() for _ in msgs if _.get_text_content() is not None
        )
