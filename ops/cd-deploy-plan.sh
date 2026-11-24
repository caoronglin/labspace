#!/usr/bin/env bash
# 发布清单：把「这次发布要动什么、怎么验、怎么退」写成文字附到 Release。
#
# 为什么流水线不直接改现网：现网是宿主机 Nginx + Docker Compose + systemd，
# 从构建容器里远程改它需要把宿主机凭据放进 CI 变量，代价远大于收益；
# 而部署本身是几条可复制的命令。所以这里产出的是「照做即可」的清单，
# 由有权限的人执行，步骤留在 Release 里可追溯。
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
OUT="${PLAN_DIR:-/tmp/labspace-deploy-plan}"
mkdir -p "$OUT"

BRANCH="${CNB_BRANCH:-unknown}"        # tag_deploy 事件里是 Tag 名
SHA="$(git rev-parse --short HEAD)"
REGISTRY="${CNB_DOCKER_REGISTRY:-docker.cnb.cool}"
SLUG="${CNB_REPO_SLUG_LOWERCASE:-math-nwafu/labspace}"
ENV_NAME="${DEPLOY_ENV:-production}"

{
  echo "# 发布清单 · $ENV_NAME"
  echo
  echo "- 版本：\`$BRANCH\`"
  echo "- 提交：\`$SHA\`"
  echo "- 生成时间：$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo
  echo "## 1. 镜像"
  echo
  echo '```'
  echo "$REGISTRY/$SLUG/frontend:$SHA"
  echo "$REGISTRY/$SLUG/backend:$SHA"
  echo "$REGISTRY/$SLUG/go-core:$SHA"
  echo '```'
  echo
  echo "## 2. 执行顺序"
  echo
  cat <<'STEPS'
1. 备份当前前端产物：`cp -a /opt/labspace/frontend/dist /opt/labspace/frontend/dist.bak-$(date +%Y%m%d%H%M)`
2. 拉取并切换后端镜像（compose 里改 tag 后 `docker compose up -d backend`）
3. 跑一次 Go 核心影子对账（见 `labspace/docs/GO_CORE_REPLACEMENT.md`），对不上就停在这里
4. 覆盖前端产物：`rsync -a --delete dist/frontend/ /opt/labspace/frontend/dist/`
5. `nginx -t && nginx -s reload`
STEPS
  echo
  echo "## 3. 验收"
  echo
  cat <<'STEPS'
- `curl -fsS http://127.0.0.1/api/health`
- 页面能用门户本地账号登录（浏览器不下发服务令牌）
- 工作台打开、条目增删改查各一次
- SnapOtter 上传一个小文件并下载结果
- 科研 API 目录 `/api/databases` 返回 32 项的探活状态
STEPS
  echo
  echo "## 4. 回滚"
  echo
  cat <<STEPS
前端：\`rsync -a --delete /opt/labspace/frontend/dist.bak-<时间戳>/ /opt/labspace/frontend/dist/\` 后 reload nginx
后端：compose 里 tag 改回上一个成功构建的 SHA 再 \`up -d\`
完整步骤见 \`labspace/ROLLBACK.md\`。
STEPS
  echo
  echo "> 本清单由 \`labspace/ops/cd-deploy-plan.sh\` 生成，未对现网做任何写入。"
} > "$OUT/DEPLOY_PLAN.md"

echo "PLAN_DIR=$OUT" >> "${CNB_ENV_FILE:-/dev/null}" 2>/dev/null || true
echo "== 发布清单：$OUT/DEPLOY_PLAN.md"
