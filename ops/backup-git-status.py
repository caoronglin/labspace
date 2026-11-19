#!/usr/bin/env python3
"""把异地归档（Git LFS）的状态写成管理端可读的 JSON。

为什么单独一个脚本：
    归档流程本身是 bash（git/openssl 调用），而拼 JSON 用 Python 更稳。
    把"写状态"独立出来，既避免了在 bash 里嵌 heredoc 的转义地狱，
    也让状态文件的结构只在一个地方定义。

安全：**绝不写入**归档口令（LAB_BACKUP_ARCHIVE_KEY）与任何 git 凭据。
    写进去的只有时间、份数、大小、远端地址与最近一次结果。
"""
from __future__ import annotations

import argparse
import json
import pathlib
from datetime import UTC, datetime


def collect(archive_dir: pathlib.Path) -> list[dict]:
    items: list[dict] = []
    if not archive_dir.is_dir():
        return items
    files = sorted(
        archive_dir.glob("*.tar.gz.enc"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for path in files:
        stat = path.stat()
        items.append(
            {
                "name": path.name,
                "size": stat.st_size,
                "time": datetime.fromtimestamp(stat.st_mtime, tz=UTC)
                .astimezone()
                .isoformat(),
            }
        )
    return items


def main() -> int:
    parser = argparse.ArgumentParser(description="写异地归档状态文件")
    parser.add_argument("--archive-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--outcome", required=True)
    parser.add_argument("--pushed", default="0")
    parser.add_argument("--detail", default="")
    parser.add_argument("--keep", default="3")
    parser.add_argument("--branch", default="")
    parser.add_argument("--remote", default="")
    args = parser.parse_args()

    archives = collect(pathlib.Path(args.archive_dir))
    doc = {
        "outcome": args.outcome,
        "pushed": args.pushed == "1",
        "detail": args.detail,
        "keep": int(args.keep or 3),
        "branch": args.branch,
        "remote": args.remote,
        "generatedAt": datetime.now(tz=UTC).astimezone().isoformat(),
        "totalBytes": sum(a["size"] for a in archives),
        "archives": archives,
    }

    out = pathlib.Path(args.out)
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(out)
    except OSError as exc:
        # 状态写不进去不该让备份失败——归档已经生成，下次会重写。
        print(f"WARN: 状态文件写入失败 {out}: {exc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
