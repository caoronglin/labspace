#!/usr/bin/env bash
# 流水线工具链：装 Go、对齐 pnpm 版本。
# Debian 仓库里的 Go 只有 1.19，go.mod 要 1.23，所以直接取官方 tarball。
set -euo pipefail
GO_VERSION="${GO_VERSION:-1.23.11}"

. /etc/os-release 2>/dev/null || true
ARCH="$(dpkg --print-architecture 2>/dev/null || echo amd64)"

need_pkgs=()
command -v curl    >/dev/null || need_pkgs+=(curl ca-certificates)
command -v python3 >/dev/null || need_pkgs+=(python3)
command -v tar     >/dev/null || need_pkgs+=(tar)
# -race 与 CGO_ENABLED=1 需要 C 工具链；镜像里通常不带
command -v gcc     >/dev/null || need_pkgs+=(gcc libc6-dev)
if [ ${#need_pkgs[@]} -gt 0 ]; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${need_pkgs[@]}"
fi

if ! command -v go >/dev/null || ! go version | grep -q "go${GO_VERSION%%.[0-9]*}\."; then
  echo "== 安装 Go ${GO_VERSION}"
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tgz
  rm -rf /usr/local/go
  tar -C /usr/local -xzf /tmp/go.tgz
  ln -sf /usr/local/go/bin/go  /usr/local/bin/go
  ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
fi
go version

# pnpm：镜像通常自带 corepack，版本按 env.PNPM_VERSION 固定
if ! command -v pnpm >/dev/null; then
  npm i -g "pnpm@${PNPM_VERSION:-12.16.1}" >/dev/null 2>&1 || corepack enable
fi
pnpm --version
python3 --version
node --version
