#!/usr/bin/env bash
# Rust-Bio 4.2.2 worker 门禁 + Go↔Rust 端到端。
#
# 单独一条 stage，不并进 ci-cropgenome.sh：那边是 Go module，这里是独立
# Cargo crate，工具链、依赖来源、测试方式都不同。混在一起会让「Rust 没编译」
# 被 Go 的全绿盖过去——这正是接入新组件时最该防的事。
#
# 关于工具链：node:22-bookworm 基础镜像没有 rustc/cargo。固定 1.87.0
# （rust-bio 4.2.2 的 MSRV），用官方 rustup 装；与 ci-toolchain.sh 装固定
# Go 版本是同一个套路。装不上就明确失败，不静默跳过——新接入的核心没被
# 编译过却显示绿，比红灯危险得多。
#
# Cargo.lock 入库，cargo 用 --locked 保证离线可复现：依赖漂移必须显式改锁文件。
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
CRATE="$ROOT/cropgenome-toolkit/rust-core"
BACKEND="$ROOT/cropgenome-toolkit/backend"
RUST_VERSION="1.87.0"

export CARGO_HOME="${CARGO_HOME:-/root/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-/root/.rustup}"
export PATH="$CARGO_HOME/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/crop-rust-target}"
export GOCACHE="${GOCACHE:-/tmp/gocache}"

echo "== 工具链：rustc/cargo ${RUST_VERSION}（rust-bio 4.2.2 MSRV）"
if ! command -v cargo >/dev/null 2>&1 || ! rustc --version 2>/dev/null | grep -q "${RUST_VERSION}"; then
  command -v curl >/dev/null 2>&1 || {
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends curl ca-certificates gcc libc6-dev
  }
  curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh
  sh /tmp/rustup-init.sh -y --default-toolchain "$RUST_VERSION" --profile minimal \
    --component rustfmt --component clippy
fi
rustc --version
cargo --version

cd "$CRATE"
echo "== 锁文件一致性（--locked；漂移必须显式改 Cargo.lock）"
cargo metadata --locked --format-version 1 >/dev/null

echo "== 格式（cargo fmt --check）"
cargo fmt --check

echo "== 静态检查（clippy -D warnings）"
cargo clippy --all-targets --locked -- -D warnings

echo "== 集成回归（cargo test，12 项）"
cargo test --locked

echo "== release 产物"
cargo build --release --locked
WORKER="$CARGO_TARGET_DIR/release/seq-worker"
[ -x "$WORKER" ] || { echo "seq-worker 没编出来" >&2; exit 1; }
echo "== 产物：$WORKER ($(stat -c%s "$WORKER") 字节)"
"$WORKER" version

echo "== Go↔Rust 端到端（把真二进制指给 internal/rustbio 测试）"
cd "$BACKEND"
export GOPROXY=off GOFLAGS=-mod=vendor GOTOOLCHAIN=local
export CROP_TEST_RUST_WORKER="$WORKER"
go test ./internal/rustbio/ -race -count=1 -v
# skip 不等于通过：设了 CROP_TEST_RUST_WORKER 还出现 SKIP，就是配置错了。
out="$(go test ./internal/rustbio/ -count=1 -v -run 'TestInvoke|TestProbe' 2>&1)"
if printf '%s\n' "$out" | grep -q -- '--- SKIP'; then
  echo "CROP_TEST_RUST_WORKER 已设却仍有 SKIP，端到端没真跑：" >&2
  printf '%s\n' "$out" | grep -- '--- SKIP' >&2
  exit 1
fi

echo "== Rust 门禁通过"
