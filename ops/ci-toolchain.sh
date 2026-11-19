#!/usr/bin/env bash
# 流水线工具链：装 Go、对齐 pnpm 版本。
# Debian 仓库里的 Go 只有 1.19，go.mod 要 1.23，所以直接取官方 tarball。
set -euo pipefail
GO_VERSION="${GO_VERSION:-1.23.11}"
# 运行时下限：Node 26.13（原生跑 TypeScript）/ Python 3.15。
# 低于下限时只告警不失败：CI 镜像升级节奏与业务改动解耦，但日志要留痕。
NODE_MIN="${NODE_MIN:-26.13.0}"
PYTHON_MIN="${PYTHON_MIN:-3.15}"

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

# 版本下限检查（只告警，不中断流水线）
node -e '
const [maj,min] = process.versions.node.split(".").map(Number);
const [wmaj,wmin] = process.env.NODE_MIN.split(".").map(Number);
if (maj < wmaj || (maj === wmaj && min < wmin)) {
  console.warn(`WARN: Node ${process.versions.node} 低于约定 ${process.env.NODE_MIN}（原生 TS 支持需要 26+）`);
}
' 2>/dev/null || true
python3 - <<'EOF' 2>/dev/null || true
import os, sys
want = tuple(int(x) for x in os.environ.get("PYTHON_MIN", "3.15").split("."))
if sys.version_info[:2] < want:
    print(f"WARN: Python {sys.version.split()[0]} 低于约定 {os.environ['PYTHON_MIN']}")
EOF
