#!/usr/bin/env bash
# 全局 Debug / Preview 一键自检：类型、构建、引擎契约、后端路由与脱敏。
# 不连数据库、不连内网、不依赖 Go 工具链。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# 用本 workspace 的二进制，不走 npx：npx 会去 registry 找同名包，
# 第一次跑可能撞上不相干的 tsc@2.0.3，等于自检时偷偷联网装包。
FRONTEND_BIN="$ROOT/labspace/frontend/node_modules/.bin"
for bin in tsc vite; do
  [ -x "$FRONTEND_BIN/$bin" ] || { echo "缺 $FRONTEND_BIN/$bin：先跑 ci-frontend.sh 装依赖" >&2; exit 1; }
done

echo "==> [1/4] 前端类型检查"
(cd labspace/frontend && "$FRONTEND_BIN/tsc" -b)

echo "==> [2/4] 前端构建"
(cd labspace/frontend && "$FRONTEND_BIN/vite" build > /dev/null)

echo "==> [3/4] Preview 引擎契约（node --test）"
(cd labspace/frontend && node --test src/debug/__tests__/previewEngine.test.mjs)

echo "==> [4/4] 后端单测（含 debug 路由与脱敏）"
(cd labspace/backend && python3 -m pytest tests -q)

echo "✓ 全局 Debug / Preview 自检通过"
