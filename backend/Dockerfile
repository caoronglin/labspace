# =====================================================================
#  LabSpace 门户后端镜像
#
#  基础镜像：官方 python:3.11-slim
#  历史原因：早期为避开 Docker Hub 拉取速度问题，复用了 open-webui 的 slim 镜像
#  作为 Python 基础镜像 —— 该镜像内含 179 个包（langsmith / httpx2 / openai /
#  boto3 / azure-* / black / alembic / grpcio …），其中绝大多数与门户无关，
#  徒增 CVE 攻击面（实测 starlette 被钉在 1.8.0、pydantic 2.13.4，落后宿主）。
#  现改为官方 slim 镜像 + 全量锁定依赖（29 个包），镜像体积与依赖面同时收敛。
#
#  依赖真源：backend/pyproject.toml（直接依赖，宿主机由 pnpm 管理）
#  传递依赖锁：backend/requirements-lock.txt（由 python:3.11-slim 一次性容器
#              `pip install -r requirements-runtime.txt && pip freeze` 生成）
# =====================================================================
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv/app

# 依赖全部来自锁文件（含传递依赖），构建结果可复现
COPY requirements-lock.txt /tmp/requirements-lock.txt
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
      -r /tmp/requirements-lock.txt && rm -f /tmp/requirements-lock.txt

# Office 放映/旧格式转换依赖：LibreOffice 无头模式 + 中文字体，
# 避免 PPTX 转 PDF 时中文变成方框（字体缺失会静默回退）。
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      fonts-noto-cjk fonts-liberation \
      texlive-xetex texlive-latex-recommended texlive-lang-chinese texlive-fonts-recommended \
    && rm -rf /var/lib/apt/lists/*

COPY app /srv/app/app

# compose 里实际以 1000:1000 运行（与 Quantum 同一服务账号，复用既有 ACL）；
# 这里保留一个独立账号，供单独 docker run 使用
RUN useradd -u 10002 -m -s /usr/sbin/nologin labspace
USER 10002

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/api/health',timeout=4)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
