#!/usr/bin/env bash
# D509 工作台全量回归：所有浏览器/接口体检脚本依次执行
# 用法: LAB_PASS=<口令> ./run-regression.sh [脚本名...]
set -uo pipefail
cd /opt/labspace/e2e
: "${LAB_PASS:?请先 export LAB_PASS=<student01 口令>（见 /etc/labspace/casdoor-users.txt）}"
export LAB_PASS
: "${LAB_ADMIN_PASS:?请先 export LAB_ADMIN_PASS=<labadmin 口令>（见 /etc/labspace/casdoor-users.txt）}"
export LAB_ADMIN_PASS

ALL=(api-integration.mjs e2e.mjs snapotter-integration.mjs agent-integration.mjs
     agent-chat-test.mjs sso-flow.mjs
     new-features-test.mjs db-api-integration.mjs databases-api-ui.mjs
     biomed-api-test.mjs biomed-search-test.mjs
     i18n-full.mjs embed-test.mjs jbrowse-i18n.mjs home-layout.mjs oidc-multi.mjs
     charts-test.mjs design-selfcheck.mjs components-polish-test.mjs
     ip-adaptive-test.mjs sso-e2e-test.mjs sso-no-thrash-test.mjs
     post-reset-test.mjs bioinfo-api-smoke.mjs bioinfo-terminal-test.mjs
     cropgenome-test.mjs cropgenome-rust-test.mjs
     tailscale-access-test.mjs)
TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=("${ALL[@]}")

FAILED=()
for t in "${TARGETS[@]}"; do
  [ -f "$t" ] || { echo "== 跳过 $t（不存在）"; continue; }
  echo "================ $t ================"
  out=$(timeout 420 node "$t" 2>&1)
  code=$?
  echo "$out" | tail -6
  if [ $code -ne 0 ]; then
    echo "---- 失败输出（$t）----"
    echo "$out" | grep -E "FAIL|失败|Error|error:" | head -12
    FAILED+=("$t")
  fi
  echo
done

echo "================ 汇总 ================"
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "全部通过"
else
  echo "失败脚本: ${FAILED[*]:-无}"
fi
