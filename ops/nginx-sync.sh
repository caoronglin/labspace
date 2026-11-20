#!/usr/bin/env bash
# 把仓库里的 nginx 配置同步到系统目录并 reload。
#
# 为什么需要这一步：`/etc/nginx/sites-enabled/labspace.conf` 是**拷贝**而不是
# 指向仓库的符号链接，改了 deploy/nginx/*.conf 不自动生效。踩过一次坑：
# 配置里加了 X-Original-Method / CSRF 透传和 /pdf-api/ 限流，reload 一切正常，
# 但线上跑的还是旧拷贝，验证时看到的行为和代码完全对不上。
#
# 用法：sudo ops/nginx-sync.sh [--check]
#   --check  只对比差异、不写入（用于 CI 或巡检）
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/deploy/nginx"
DST="${LABSPACE_NGINX_DIR:-/etc/nginx/sites-enabled}"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

differ=0
for f in "$SRC"/*.conf; do
  name="$(basename "$f")"
  # 共享片段（include 用）不是站点，放在 sites-enabled 里会被当成 server 块解析
  if [[ "$name" == lab-security-headers.conf ]]; then
    continue
  fi
  if [[ ! -f "$DST/$name" ]]; then
    echo "缺失: $DST/$name"
    differ=1
    continue
  fi
  if ! diff -q "$f" "$DST/$name" >/dev/null; then
    echo "有差异: $name"
    differ=1
    if [[ $CHECK_ONLY -eq 0 ]]; then
      install -m 0664 "$f" "$DST/$name"
    fi
  fi
done

if [[ $CHECK_ONLY -eq 1 ]]; then
  [[ $differ -eq 0 ]] && echo "nginx 配置与仓库一致"
  exit $differ
fi

nginx -t
nginx -s reload
echo "nginx 已同步并重载"
