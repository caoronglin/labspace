# =====================================================================
#  LabSpace 门户后端镜像
#
#  基础镜像：官方 python:3.15-slim
#  历史原因：早期为避开 Docker Hub 拉取速度问题，复用了 open-webui 的 slim 镜像
#  作为 Python 基础镜像 —— 该镜像内含 179 个包（langsmith / httpx2 / openai /
#  boto3 / azure-* / black / alembic / grpcio …），其中绝大多数与门户无关，
#  徒增 CVE 攻击面（实测 starlette 被钉在 1.8.0、pydantic 2.13.4，落后宿主）。
#  现改为官方 slim 镜像 + 全量锁定依赖（29 个包），镜像体积与依赖面同时收敛。
#
#  依赖真源：backend/pyproject.toml（直接依赖，宿主机由 pnpm 管理）
#  传递依赖锁：backend/requirements-lock.txt（由 python:3.15-slim 一次性容器
#              `pip install -r requirements-runtime.txt && pip freeze` 生成；
#              3.15 上 scikit-bio/h5py 无 manylinux 轮子，构建阶段带 gcc+HDF5 编译）
# =====================================================================
# ---------------------------------------------------------------------------
# 阶段 1：把锁文件里的依赖做成 wheel
#
# 为什���要单独一阶段：scikit-bio / biom-format / h5py 在 Python 3.15 上还没有
# 现成的 manylinux 轮子（3.15 太新），只能从源码编译，而编译需要 gcc 与
# HDF5 头文件。把这些工具留在 runtime 镜像里会白占几百 MB 并扩大攻击面，
# 所以放在构建阶段，最终镜像只拿 wheel。
# ---------------------------------------------------------------------------
FROM python:3.15-slim AS wheels

ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential libhdf5-dev pkg-config cmake ninja-build \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-lock.txt /tmp/requirements-lock.txt
RUN pip wheel --wheel-dir /wheels -r /tmp/requirements-lock.txt \
    && rm -f /tmp/requirements-lock.txt

# ---------------------------------------------------------------------------
# 阶段 2：运行时镜像
# ---------------------------------------------------------------------------
FROM python:3.15-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv/app

# 依赖全部来自构建阶段产出的 wheel（含传递依赖），构建结果可复现、且不需要网络
COPY --from=wheels /wheels /wheels
COPY requirements-lock.txt /tmp/requirements-lock.txt
RUN pip install --no-index --find-links=/wheels -r /tmp/requirements-lock.txt \
    && rm -rf /wheels /tmp/requirements-lock.txt

# h5py 是动态链接系统 HDF5 的（源码编译，不像 manylinux 轮子自带静态库），运行时必须装。
# **两个包都要**：`libhdf5-hl-310` 是高阶库，h5py 的 h5.hl 需要它；
# 只装 `libhdf5-310` 时 `import h5py` 会在 dlopen 阶段报
# "libhdf5_serial_hl.so.310: cannot open shared object file"，
# 而这条依赖只有真正调用 skbio.stats（PCoA 等）时才会被踩到。
RUN apt-get update && apt-get install -y --no-install-recommends \
      libhdf5-310 libhdf5-hl-310 \
    && rm -rf /var/lib/apt/lists/*

# Office 放映/旧格式转换依赖：LibreOffice 无头模式 + 中文字体，
# 避免 PPTX 转 PDF 时中文变成方框（字体缺失会静默回退）。
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      fonts-noto-cjk fonts-liberation \
      texlive-xetex texlive-latex-recommended texlive-lang-chinese texlive-fonts-recommended \
      tesseract-ocr tesseract-ocr-chi-sim \
    && rm -rf /var/lib/apt/lists/*

# 种子标签 OCR 用 Tesseract 而不是 RapidOCR / PaddleOCR：
#   本机 Python 是 3.15，onnxruntime 与 paddlepaddle 都还没有 cp315 轮子，
#   RapidOCR 系列装不上。Tesseract 是系统二进制，不绑定 Python ABI，
#   chi_sim 语言包对印刷体标签够用。识别结果只用于**预填表单**，
#   一律由人确认后才入库，不自动提交。

# 冒烟检查：三个生信库的 import 依赖系统库（h5py → HDF5），装错包时只有真正
# 调用某个端点才会炸；这里在构建阶段就 import 一次，失败立刻停构建。
RUN python -c "import Bio, skbio, dna_features_viewer, skbio.stats.ordination, skbio.tree; print('bio deps ok')"

COPY app /srv/app/app

# compose 里实际以 1000:1000 运行（与 Quantum 同一服务账号，复用既有 ACL）；
# 这里保留一个独立账号，供单独 docker run 使用
RUN useradd -u 10002 -m -s /usr/sbin/nologin labspace
USER 10002

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/api/health',timeout=4)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
