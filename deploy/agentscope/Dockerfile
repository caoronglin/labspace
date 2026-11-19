# AgentScope 2.0.11 官方 Agent Service（独立镜像）
#
# 为什么不塞进 backend 镜像：agentscope 的依赖很重且带版本约束
# （mcp>=2.0.0、httpx2>=2.5.0、anthropic、dashscope、opentelemetry*），
# 塞进门户后端会与现有 httpx==0.28.1 / mcp 版本打架，并且把镜像撑大几百 MB。
# 独立服务 + 共享同一个 Postgres，仍然是「共用内核」：同一份 create_app、
# 同一套 Session/KnowledgeBase/SOP 存储，只是进程边界清楚。
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TZ=Asia/Shanghai

WORKDIR /srv/agentscope

COPY requirements.txt /tmp/requirements.txt
RUN pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r /tmp/requirements.txt

# 装配层 + lab MCP server（工具能力）。五个文件缺一不可：
#   app.py            —— create_app 装配层（知识库 / 长期记忆 / 工具 / 中间件）
#   lab_mcp_server.py —— 官方 mcp 包的 MCP server，暴露 7 个 lab_* 工具
#   lab_portal.py     —— 转发门户内部接口的客户端
#   lab_identity.py   —— AgentScope 与 MCP server 之间的身份通道
#   lab_embedding.py  —— 内网向量模型（bge-m3）的凭据与 embedding 实现
#   lab_memory.py     —— 长期记忆中间件的加固版（独立检索模型 / 超时 / 兜底）
COPY app.py lab_mcp_server.py lab_portal.py lab_identity.py lab_embedding.py lab_memory.py /srv/agentscope/

EXPOSE 8100
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8100"]
