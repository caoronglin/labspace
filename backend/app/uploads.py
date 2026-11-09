"""上传文件的分块读取与大小限制。

所有接收上传的接口都应使用这里的读取函数：
分块读取并在超过上限时立即中断（而不是先整包读进内存再判断大小），
避免大文件把容器内存打满。
"""
from __future__ import annotations

from fastapi import HTTPException, UploadFile

CHUNK_SIZE = 1024 * 1024
"""每次读取的块大小（1 MiB）。"""


async def read_upload_capped(file: UploadFile, limit: int, *, message: str = "") -> bytes:
    """读取上传内容，总大小超过 limit 时抛 413。

    Args:
        file: FastAPI 的 UploadFile。
        limit: 允许的最大字节数。
        message: 自定义错误提示（为空时自动生成）。
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise HTTPException(
                status_code=413,
                detail=message or f"文件超过 {limit // (1024 * 1024)} MB 上限",
            )
        chunks.append(chunk)
    return b"".join(chunks)
