"""生信工具独立服务。

为什么要单独成服务：`biotools.py` 依赖 Biopython / scikit-bio / dna-features-viewer，
它们会带进 numpy / scipy / pandas / matplotlib / h5py，而 Python 3.15 上这些库
**没有 manylinux 轮子**，必须源码编译（要 gcc + HDF5 头文件）。把这些放进门户后台镜像
只会让镜像从 2.2 GB 长到 3.2 GB，而门户后端本身并不需要它们。

因此：
- 本模块跑在 `lab/labspace-biotools` 镜像里，监听 8133，**只连内网 compose 网络**；
- 它自己**不做鉴权**：门户后端在 `/api/biotools/*` 上已经做了会话校验再转发过来，
  这个进程不暴露宿主端口，外网/浏览器都够不到；
- 门户后端只保留一个薄代理（`biotools_proxy.py`），像别的基础组件一样对待它。
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI

from . import biotools
from .security import require_csrf, require_user

app = FastAPI(
    title="D509 生信工具",
    description="序列 / 克隆 / 引物 / 比对建树 / 测序批处理。仅内网调用。",
    # 内网服务不需要对外文档：关掉能少一堆被扫描的路径
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

# 端点函数上写着 `Depends(require_user)` / `Depends(require_csrf)`：
# 那是"由门户代理时"的写法。本服务在内网、不对外暴露，鉴权与 CSRF 都由门户代理
# （`biotools_proxy.py`）完成，所以在这里把这两个依赖覆写成放行——
# 否则上游会对每一个请求回 401，代理转发过去就是"未登录或会话已过期"。
app.dependency_overrides[require_user] = lambda: {"sub": "internal-biotools"}
app.dependency_overrides[require_csrf] = lambda: None

app.include_router(biotools.router)


@app.get("/health", include_in_schema=False)
async def health() -> dict[str, Any]:
    """探活：nginx / compose healthcheck 用，不触发任何计算。"""
    return {"ok": True, "service": "biotools", "version": "2026.11.24"}
