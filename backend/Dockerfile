# =====================================================================
#  LabSpace 镜像（一个 Dockerfile，四个 target）
#
#  为什么拆：科学计算栈（Biopython / scikit-bio / dna-features-viewer 带进
#  numpy / scipy / pandas / matplotlib / h5py）在 Python 3.15 上没有 manylinux
#  轮子，必须源码编译；把它放进门户后端镜像会让镜像从 2.2 GB 长到 3.2 GB，
#  而门户后端根本不需要它。LaTeX 编译 sidecar 更不需要 LibreOffice。
#
#    wheels       基础依赖的 wheel（无科学计算）
#    python-deps  运行时基础层：只装 wheel（无 LibreOffice/TeX/科学计算）
#    backend      门户后端：+ LibreOffice + tesseract + 应用代码
#    latex        LaTeX 编译 sidecar：+ TeX Live，只跑 app.latex_worker
#    biotools     生信工具服务：+ 科学计算 wheel + HDF5 运行时库，只跑
#                 app.biotools_service（门户后端用 /api/biotools 反向代理它）
#
#  依赖真源：backend/pyproject.toml；锁文件：
#    backend/requirements-lock.txt            基础依赖（含传递依赖）
#    backend/requirements-biotools-lock.txt   生信依赖（含传递依赖）
# =====================================================================

# ---------------------------------------------------------------------------
# 阶段 1：基础依赖的 wheel
# ---------------------------------------------------------------------------
FROM python:3.15-slim AS wheels

ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

COPY requirements-lock.txt /tmp/requirements-lock.txt
RUN pip wheel --wheel-dir /wheels -r /tmp/requirements-lock.txt \
    && rm -f /tmp/requirements-lock.txt

# ---------------------------------------------------------------------------
# 阶段 2：运行时基础层（只有 python 依赖）
# ---------------------------------------------------------------------------
FROM python:3.15-slim AS python-deps

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

# ---------------------------------------------------------------------------
# 阶段 3a：门户后端（Office 转换 + 种子 OCR）
# ---------------------------------------------------------------------------
FROM python-deps AS backend

# Office 放映/旧格式转换依赖：LibreOffice 无头模式 + 中文字体，
# 避免 PPTX 转 PDF 时中文变成方框（字体缺失会静默回退）。
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      fonts-noto-cjk fonts-liberation \
      tesseract-ocr tesseract-ocr-chi-sim \
    && rm -rf /var/lib/apt/lists/*

# 种子标签 OCR 用 Tesseract 而不是 RapidOCR / PaddleOCR：
#   本机 Python 是 3.15，onnxruntime 与 paddlepaddle 都还没有 cp315 轮子，
#   RapidOCR 系列装不上。Tesseract 是系统二进制，不绑定 Python ABI，
#   chi_sim 语言包对印刷体标签够用。识别结果只用于**预填表单**，
#   一律由人确认后才入库，不自动提交。

COPY app /srv/app/app

# compose 里实际以 1000:1000 运行（与服务账号一致，复用既有 ACL）；
# 这里保留一个独立账号，供单独 docker run 使用
RUN useradd -u 10002 -m -s /usr/sbin/nologin labspace
USER 10002

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/api/health',timeout=4)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]

# ---------------------------------------------------------------------------
# 阶段 3b：LaTeX 编译 sidecar（只跑 app.latex_worker）
#
# 这个容器只需要 TeX Live 与基础 python 依赖：**不带** LibreOffice，
# 也不带科学计算栈（旧方案直接复用了 backend 镜像，白背 1 GB 以上）。
# ---------------------------------------------------------------------------
FROM python-deps AS latex

RUN apt-get update && apt-get install -y --no-install-recommends \
      texlive-xetex texlive-latex-recommended texlive-lang-chinese texlive-fonts-recommended \
      fonts-noto-cjk fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY app /srv/app/app

RUN useradd -u 10002 -m -s /usr/sbin/nologin labspace
USER 10002

EXPOSE 8131

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8131/health',timeout=4)"

CMD ["python", "-m", "app.latex_worker"]

# ---------------------------------------------------------------------------
# 阶段 3c：生信工具服务（Biopython + scikit-bio + dna-features-viewer）
#
# Python 3.15 上 scikit-bio / biom-format / h5py 没有 manylinux 轮子，只能源码编译：
# 编译需要 gcc + HDF5 头文件，这里单独一阶段出 wheel，运行层只装 wheel 与
# HDF5 运行时库（**两个都要**：`libhdf5-hl-310` 是高阶库，h5py 的 h5.hl 需要它，
# 只装 libhdf5-310 时 `import h5py` 会在 dlopen 阶段报
# "libhdf5_serial_hl.so.310: cannot open shared object file"）。
# ---------------------------------------------------------------------------
FROM python:3.15-slim AS bio-wheels

ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential libhdf5-dev pkg-config cmake ninja-build \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-biotools-lock.txt /tmp/requirements-biotools-lock.txt
RUN pip wheel --wheel-dir /wheels -r /tmp/requirements-biotools-lock.txt \
    && rm -f /tmp/requirements-biotools-lock.txt

FROM python-deps AS biotools

RUN apt-get update && apt-get install -y --no-install-recommends \
      libhdf5-310 libhdf5-hl-310 \
      libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# libgomp1 是 OpenMP 运行时：numpy/scipy 从源码编译后依赖它，
# 缺了会在 `import skbio` 时报 "libgomp.so.1: cannot open shared object file"。
# 这条正是构建期冒烟抓出来的（旧的一体化镜像里它是被 LibreOffice 顺带装上的，
# 拆分后必须自己声明）。

COPY --from=bio-wheels /wheels /wheels
COPY requirements-biotools-lock.txt /tmp/requirements-biotools-lock.txt
RUN pip install --no-index --find-links=/wheels -r /tmp/requirements-biotools-lock.txt \
    && rm -rf /wheels /tmp/requirements-biotools-lock.txt

COPY app /srv/app/app

# 构建期冒烟：装错/装漏时立刻失败，而不是等到用户点开某个按钮才 500
# （PCoA 需要的 skbio.stats → h5py → HDF5 高阶库就是踩过这个坑）。
RUN python -c "import Bio, skbio, dna_features_viewer, skbio.stats.ordination, skbio.tree; print('bio deps ok')"

RUN useradd -u 10002 -m -s /usr/sbin/nologin labspace
USER 10002

EXPOSE 8133

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8133/health',timeout=4)"

CMD ["uvicorn", "app.biotools_service:app", "--host", "0.0.0.0", "--port", "8133", "--proxy-headers", "--forwarded-allow-ips", "*"]
