#!/usr/bin/env bash
# 打包前端产物：产出 dist 目录，供镜像构建/发布上传。
# 产物目录固定为 labspace/dist，下游脚本与 .cnb.yml 都按这个路径取。
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT/labspace"

pnpm install --frozen-lockfile --ignore-scripts
cd frontend
# 同上：锁定本地二进制，不让 npx 在发布构建时偷偷联网解析同名包。
for bin in node_modules/.bin/tsc node_modules/.bin/vite; do
  [ -x "$bin" ] || { echo "缺 $bin：pnpm install 没装全" >&2; exit 1; }
done
./node_modules/.bin/tsc -b
./node_modules/.bin/vite build

cd "$ROOT/labspace"
rm -rf dist
mkdir -p dist
cp -a frontend/dist dist/frontend
# 版本号：优先 tag，其次 commit 短 SHA —— 任何构建都能对回一个提交
VERSION="${CNB_BRANCH:-}"
if [ -z "$VERSION" ] || [ "$VERSION" = "main" ]; then
  VERSION="${CNB_COMMIT_SHORT:-$(git rev-parse --short HEAD)}"
fi
echo "$VERSION" > dist/VERSION
echo "RELEASE_VERSION=$VERSION" >> "${CNB_ENV_FILE:-/dev/null}" 2>/dev/null || true
echo "== 前端产物：$(du -sh dist/frontend | cut -f1)，版本 $VERSION"
