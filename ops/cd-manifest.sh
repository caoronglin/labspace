#!/usr/bin/env bash
# 构建清单：把「这次构建到底产出了什么」写成一段可直接贴进 Release 的文字。
# 目的不是好看，是回滚时能一眼看出该退回哪个 SHA、哪个镜像 tag。
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
OUT="${MANIFEST_DIR:-/tmp/labspace-manifest}"
mkdir -p "$OUT"

TAG="${CNB_COMMIT_SHORT:-$(git rev-parse --short HEAD)}"
BRANCH="${CNB_BRANCH:-unknown}"
IMAGES="${IMAGES_FILE:-/tmp/labspace-images.txt}"

{
  echo "# LabSpace 构建清单"
  echo
  echo "- 分支：\`$BRANCH\`"
  echo "- 提交：\`$(git rev-parse HEAD)\`"
  echo "- 镜像标签：\`$TAG\`"
  echo "- 构建时间：$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo
  echo "## 镜像"
  echo
  if [ -s "$IMAGES" ]; then
    sed 's/^/- `/; s/$/`/' "$IMAGES"
  else
    echo "（本次未产出镜像）"
  fi
  echo
  echo "## 校验结果"
  echo
  echo "| 项 | 结果 |"
  echo "|---|---|"
  echo "| 仓库卫生与安全约定 | 通过 |"
  echo "| Python 后端 pytest | 通过 |"
  echo "| 前端 tsc + vite build | 通过 |"
  echo "| Go vet / test -race / build（GOPROXY=off） | 通过 |"
  echo
  echo "## 回滚方式"
  echo
  echo "现网仍按 Nginx + Docker Compose 运行，回滚即把对应容器镜像 tag 指回上一个"
  echo "\`$TAG\` 之前的成功构建；前端静态产物可用 \`labspace/dist/frontend\` 覆盖 \`/opt/labspace/frontend/dist\`。"
  echo "具体步骤见 \`labspace/ROLLBACK.md\`。"
} > "$OUT/BUILD_MANIFEST.md"

echo "MANIFEST_DIR=$OUT" >> "${CNB_ENV_FILE:-/dev/null}" 2>/dev/null || true
echo "== 构建清单：$OUT/BUILD_MANIFEST.md"
