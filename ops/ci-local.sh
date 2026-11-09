#!/usr/bin/env bash
# 本地跑 CI 的全部检查，与 .cnb.yml 里的 stage 一一对应。
# 用法：bash labspace/ops/ci-local.sh [hygiene|python|frontend|go|cropgenome]...
#     不带参数 = 全跑
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/../.."

ALL=(hygiene python frontend go cropgenome rust)
TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=("${ALL[@]}")

failed=()
for t in "${TARGETS[@]}"; do
  echo "════════ $t ════════"
  if bash "$HERE/ci-$t.sh"; then
    echo "──────── $t 通过"
  else
    echo "──────── $t 失败"
    failed+=("$t")
  fi
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "失败项：${failed[*]}"
  exit 1
fi
echo "全部通过"
