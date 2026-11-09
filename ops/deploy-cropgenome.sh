#!/usr/bin/env bash
# CropGenome Toolkit 部署：Rust-Bio worker + 前端静态产物 + Go 核心路由。
#
# 三件事，任何一件单独做完都不算上线：
#   1. seq-worker 编译并放到受控绝对路径，CROP_RUST_WORKER 指过去
#      （后端只接受绝对路径；worker 没部署时 4 个分析端点返回 503，
#        不允许"假装没有结果"）。
#   2. 前端按 /cropgenome/ 子路径构建：base=/cropgenome/，
#      VITE_API_BASE=/cropgenome/api/v1 —— 资源与 API 都挂在子路径下，
#      和门户同源，会话 Cookie 与 CSRF 双提交才能自然生效。
#   3. nginx 拆成两段：/cropgenome/api/ 走 Go 核心（→ cropgenome Go → worker），
#      其余是 SPA 静态文件 + history fallback。
#
# 幂等：重复跑只会重建产物并重启服务。
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo /opt/g2/repo)"
CRATE="$ROOT/cropgenome-toolkit/rust-core"
FE="$ROOT/cropgenome-toolkit/frontend"
WEB_ROOT="${CROP_WEB_ROOT:-/srv/labdata/cropgenome/web}"
WORKER_PATH="${CROP_WORKER_PATH:-/opt/cropgenome/bin/seq-worker}"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/crop-rust-target}"

echo "== 1/4 Rust-Bio worker"
if ! command -v cargo >/dev/null 2>&1; then
  echo "缺 cargo：先装 Rust $(grep -m1 'rust-version' "$CRATE/Cargo.toml" | cut -d'"' -f2)" >&2
  exit 1
fi
cd "$CRATE"
# index.crates.io 在部分内网不可达；能直连就用默认源，否则换 rsproxy 稀疏索引。
if ! timeout 10 curl -fsS -o /dev/null https://index.crates.io/config.json 2>/dev/null; then
  mkdir -p "${CARGO_HOME:-$HOME/.cargo}"
  cat > "${CARGO_HOME:-$HOME/.cargo}/config.toml" <<'EOF'
[source.crates-io]
replace-with = "rsproxy-sparse"

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[net]
retry = 5
EOF
  echo "   index.crates.io 不可达，已切换 rsproxy 稀疏索引"
fi
cargo build --release --locked
install -d -m 0755 "$(dirname "$WORKER_PATH")"
install -m 0755 "$CARGO_TARGET_DIR/release/seq-worker" "$WORKER_PATH"
echo "   worker: $WORKER_PATH"

echo "== 2/4 前端构建"
cd "$FE"
# 这份 pnpm-workspace.yaml 只有 allowBuilds、没有 packages 字段，
# pnpm 9+ 会直接报 `packages field missing or empty` —— 必须 --ignore-workspace。
pnpm install --ignore-workspace --ignore-scripts --no-frozen-lockfile
VITE_BASE=/cropgenome/ VITE_API_BASE=/cropgenome/api/v1 pnpm --ignore-workspace run build

echo "== 3/4 发布静态产物"
install -d -m 0755 "$WEB_ROOT"
rsync -a --delete "$FE/dist/" "$WEB_ROOT/"
chown -R www-data:www-data "$WEB_ROOT"

echo "== 4/4 重启服务"
if grep -q '^CROP_RUST_WORKER=' /etc/cropgenome/api.env 2>/dev/null; then
  sed -i "s|^CROP_RUST_WORKER=.*|CROP_RUST_WORKER=$WORKER_PATH|" /etc/cropgenome/api.env
else
  printf 'CROP_RUST_WORKER=%s\n' "$WORKER_PATH" >> /etc/cropgenome/api.env
fi
systemctl restart cropgenome-api
/usr/sbin/nginx -t
systemctl reload nginx
echo "完成：worker=$WORKER_PATH web=$WEB_ROOT"
