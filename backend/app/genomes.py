"""把文件管理里的 FASTA 直接接到 JBrowse 2。

JBrowse 内置示例只认 hg19。用户在文件管理里选中的质粒/片段 FASTA 需要以
动态装配（assembly）的形式打开，这里生成 IndexedFastaAdapter 所需索引，
并把配置/序列通过 8091 的同源代理交给 JBrowse 读取。

鉴权链完全复用调用者自己的门户会话：Go 文件核心按 ACL 判权，本模块只做
格式转换与转发，不额外放行任何文件。
"""
from __future__ import annotations

import asyncio
import hashlib
import time
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from .config import settings
from .http import async_client
from .security import require_user

router = APIRouter(prefix="/api/genomes", tags=["genomes"])

FASTA_EXTS = {"fa", "fna", "fasta", "fas", "ffn", "frn", "faa"}
MAX_INDEX_BYTES = 128 * 1024 * 1024
_INDEX_CACHE: dict[str, dict[str, Any]] = {}
_INDEX_LOCKS: dict[str, asyncio.Lock] = {}
_MAX_CACHE = 16


def _ext(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def _cookie(request: Request) -> str:
    return request.headers.get("cookie", "")


async def _meta(entry_id: str, request: Request) -> dict[str, Any]:
    if not settings.labgo_base:
        raise HTTPException(status_code=503, detail="文件核心尚未配置")
    try:
        async with async_client(timeout=20) as client:
            resp = await client.get(
                f"{settings.labgo_base}/v1/files/{quote(entry_id)}",
                headers={"cookie": _cookie(request)},
            )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="文件核心暂不可用") from exc
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="文件不存在或无权访问")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"文件核心返回 {resp.status_code}")
    data = resp.json() if resp.content else {}
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="文件核心返回了无法解析的响应")
    return data


async def _download(entry_id: str, request: Request) -> bytes:
    try:
        async with async_client(timeout=120) as client:
            resp = await client.get(
                f"{settings.labgo_base}/v1/files/{quote(entry_id)}/download",
                headers={"cookie": _cookie(request)},
            )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="文件核心暂不可用") from exc
    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail="文件不存在或无权访问")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"文件核心返回 {resp.status_code}")
    if len(resp.content) > MAX_INDEX_BYTES:
        raise HTTPException(status_code=413, detail="文件超过 128 MB，动态装配请先切分或使用已注册参考基因组")
    return resp.content


def _build_fai(raw: bytes) -> tuple[list[dict[str, Any]], str]:
    refs: list[dict[str, Any]] = []
    seen: dict[str, int] = {}
    current: dict[str, Any] | None = None
    pos = 0

    def flush() -> None:
        nonlocal current
        if current and current["length"] > 0 and current["linebases"] > 0:
            base = str(current["name"])
            count = seen.get(base, 0) + 1
            seen[base] = count
            if count > 1:
                current["name"] = f"{base}_{count}"
            refs.append(current)
        current = None

    for line in raw.splitlines(keepends=True):
        if line.startswith(b">"):
            flush()
            header = line[1:].strip().split()
            name = header[0].decode("utf-8", "replace") if header else f"seq{len(refs) + 1}"
            current = {"name": name, "length": 0, "offset": 0, "linebases": 0, "linewidth": 0}
        elif current is not None:
            seq = line.rstrip(b"\r\n")
            if seq:
                if current["linebases"] == 0:
                    current["offset"] = pos
                    current["linebases"] = len(seq)
                    current["linewidth"] = len(line)
                current["length"] += len(seq)
        pos += len(line)
    flush()

    if not refs:
        raise HTTPException(status_code=422, detail="文件里没有可识别的 FASTA 序列")
    fai = "".join(
        f"{r['name']}\t{r['length']}\t{r['offset']}\t{r['linebases']}\t{r['linewidth']}\n"
        for r in refs
    )
    return refs, fai


async def _index(entry_id: str, meta: dict[str, Any], request: Request) -> dict[str, Any]:
    key = hashlib.sha256(
        f"{entry_id}:{meta.get('size') or 0}:{meta.get('modified') or ''}".encode()
    ).hexdigest()
    hit = _INDEX_CACHE.get(key)
    if hit:
        return hit
    lock = _INDEX_LOCKS.setdefault(key, asyncio.Lock())
    async with lock:
        hit = _INDEX_CACHE.get(key)
        if hit:
            return hit
        raw = await _download(entry_id, request)
        refs, fai = await asyncio.to_thread(_build_fai, raw)
        entry = {"refs": refs, "fai": fai, "at": time.time()}
        _INDEX_CACHE[key] = entry
        if len(_INDEX_CACHE) > _MAX_CACHE:
            oldest = min(_INDEX_CACHE, key=lambda k: _INDEX_CACHE[k]["at"])
            _INDEX_CACHE.pop(oldest, None)
        return entry


@router.get("/jbrowse/config")
async def jbrowse_config(
    file_id: str,
    request: Request,
    _: dict = Depends(require_user),
) -> JSONResponse:
    meta = await _meta(file_id, request)
    name = str(meta.get("name") or "")
    ext = _ext(name)
    if ext not in FASTA_EXTS:
        raise HTTPException(status_code=415, detail=f"JBrowse 动态装配只支持 FASTA（.{ext or '?'}）")
    index = await _index(file_id, meta, request)
    ref = index["refs"][0]
    ref_len = max(int(ref["length"]), 1)
    # 会话快照必须带 bpPerPx：缺省值 1 会把短序列压进几十像素、参考序列轨道
    # 永远停在 Loading。按约 1000px 视口做初始适配。
    bp_per_px = max(round(ref_len / 1000, 6), 0.000001)
    digest = hashlib.sha256(file_id.encode()).hexdigest()[:12]
    track_id = f"ref_{digest}"
    display_id = f"{track_id}-LinearReferenceSequenceDisplay"
    fasta_uri = f"/genome-api/jbrowse/fasta/{quote(file_id)}"
    fai_uri = f"/genome-api/jbrowse/fai/{quote(file_id)}"
    view_id = f"view_{digest}"
    config = {
        "assemblies": [
            {
                "name": track_id,
                "displayName": f"{name}（来自文件管理）",
                "sequence": {
                    "type": "ReferenceSequenceTrack",
                    "trackId": track_id,
                    "adapter": {
                        "type": "IndexedFastaAdapter",
                        "fastaLocation": {"uri": fasta_uri, "locationType": "UriLocation"},
                        "faiLocation": {"uri": fai_uri, "locationType": "UriLocation"},
                    },
                },
            }
        ],
        "tracks": [],
        "defaultSession": {
            "name": name,
            "views": [
                {
                    "id": view_id,
                    "type": "LinearGenomeView",
                    "bpPerPx": bp_per_px,
                    "offsetPx": 0,
                    "displayedRegions": [
                        {
                            "refName": ref["name"],
                            "start": 0,
                            "end": ref_len,
                            "assemblyName": track_id,
                        }
                    ],
                    "tracks": [
                        {
                            "type": "ReferenceSequenceTrack",
                            "configuration": track_id,
                            "displays": [
                                {
                                    "type": "LinearReferenceSequenceDisplay",
                                    "configuration": display_id,
                                }
                            ],
                        }
                    ],
                    "trackSelectorType": "hierarchical",
                    "hideControls": False,
                }
            ],
        },
    }
    return JSONResponse(config, headers={"Cache-Control": "private, max-age=60"})


@router.get("/jbrowse/fai/{entry_id}")
async def jbrowse_fai(
    entry_id: str,
    request: Request,
    _: dict = Depends(require_user),
) -> Response:
    meta = await _meta(entry_id, request)
    name = str(meta.get("name") or "")
    if _ext(name) not in FASTA_EXTS:
        raise HTTPException(status_code=415, detail="不是 FASTA 文件")
    index = await _index(entry_id, meta, request)
    return Response(index["fai"], media_type="text/plain; charset=utf-8")


@router.get("/jbrowse/fasta/{entry_id}")
async def jbrowse_fasta(entry_id: str, request: Request) -> StreamingResponse:
    """按浏览器原始 Range 头转发，IndexedFastaAdapter 依赖 206 分段读取。"""
    if not settings.labgo_base:
        raise HTTPException(status_code=503, detail="文件核心尚未配置")
    headers = {"cookie": _cookie(request)}
    if request.headers.get("range"):
        headers["range"] = request.headers["range"]
    client = async_client(timeout=300)
    try:
        req = client.build_request(
            "GET",
            f"{settings.labgo_base}/v1/files/{quote(entry_id)}/download",
            headers=headers,
        )
        resp = await client.send(req, stream=True)
    except Exception as exc:  # noqa: BLE001
        await client.aclose()
        raise HTTPException(status_code=503, detail="文件核心暂不可用") from exc
    if resp.status_code not in (200, 206):
        await resp.aclose()
        await client.aclose()
        status = 404 if resp.status_code == 404 else 502
        raise HTTPException(status_code=status, detail="无法读取该 FASTA 文件")

    async def cleanup() -> None:
        await resp.aclose()
        await client.aclose()

    passthrough = {}
    for header in ("content-range", "accept-ranges", "content-length", "last-modified", "etag"):
        value = resp.headers.get(header)
        if value:
            passthrough[header.title()] = value
    return StreamingResponse(
        resp.aiter_raw(),
        status_code=resp.status_code,
        media_type="text/plain; charset=utf-8",
        headers=passthrough,
        background=BackgroundTask(cleanup),
    )
