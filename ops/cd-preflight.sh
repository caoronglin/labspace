#!/usr/bin/env bash
# 发布前置校验：现网是不是真的能接这次发布。
# 不通过就退出，让审批人在点「同意」之前看到拦在哪。
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
fail=0
note() { echo "  $*"; }

echo "== 1. 目标环境参数"
: "${DEPLOY_ENV:?缺少 DEPLOY_ENV（由 .cnb/tag_deploy.yml 注入）}"
note "环境：$DEPLOY_ENV"

echo "== 2. 发布物与代码同源"
HEAD_SHA="$(git rev-parse HEAD)"
note "HEAD：$HEAD_SHA"
if ! git diff --quiet HEAD; then
  echo "  工作区有未提交改动，发布物无法对应到提交"
  fail=1
fi

echo "== 3. 回滚文档与部署文档必须存在"
for f in labspace/ROLLBACK.md labspace/DEPLOY.md labspace/SECURITY.md; do
  if [ -f "$f" ]; then note "$f 存在"; else echo "  缺少 $f"; fail=1; fi
done

echo "== 4. 安全约定：发布配置里不得出现真实凭据"
# 既有的 casdoor-local-dev-pw 是已知项（见 Issue #1 后单独立项），这里只挡新增的
if grep -rniE '(password|secret|api[_-]?key)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_./+@-]{10,}' \
     labspace/deploy --include='*.yaml' --include='*.yml' 2>/dev/null \
   | grep -vE '\.example|casdoor-local-dev-pw' | grep -q .; then
  grep -rniE '(password|secret|api[_-]?key)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_./+@-]{10,}' \
       labspace/deploy --include='*.yaml' --include='*.yml' 2>/dev/null \
    | grep -vE '\.example|casdoor-local-dev-pw' | sed 's/^/    /' | head -5
  echo "  以上为新增的明文凭据，应改为 deploy/.env 注入"
  fail=1
else
  note "ok（仅 casdoor-local-dev-pw 一项已知例外）"
fi

echo "== 5. 现网健康探针（配置了才检）"
if [ -n "${DEPLOY_HEALTH_URL:-}" ]; then
  if curl -fsS --max-time 8 "$DEPLOY_HEALTH_URL" >/dev/null; then
    note "$DEPLOY_HEALTH_URL 可达"
  else
    echo "  $DEPLOY_HEALTH_URL 不可达——发布后无法验证，先确认网络/服务"
    fail=1
  fi
else
  note "未配置 DEPLOY_HEALTH_URL，跳过（发布后需人工确认 /api/health）"
fi

[ "$fail" -eq 0 ] && echo "== 前置校验通过" || { echo "== 前置校验未通过"; exit 1; }
