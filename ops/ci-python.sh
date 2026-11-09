#!/usr/bin/env bash
# Python 后端：装依赖 + 跑 pytest。
# 用系统 python3（容器内为 Debian 自带的 3.11+），不依赖 pnpm 的 python 管理，
# 因为容器里的 pnpm 拉独立解释器要联网。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/labspace/backend"

PY="${PYTHON:-python3}"
VENV="${VENV_DIR:-/tmp/labspace-venv}"

# node:22-bookworm 里既没有 python3-venv 也没有 pip，venv 能建出来但 ensurepip 缺失，
# 退回系统解释器同样没有 pip（实测：No module named pip）。
# 所以这里必须先把 venv+pip 补上，不能指望基础镜像。
if [ ! -f "$VENV/bin/activate" ] || ! "$VENV/bin/python" -m pip --version >/dev/null 2>&1; then
  echo "== 准备 venv 与 pip"
  if ! "$PY" -m venv "$VENV" >/dev/null 2>&1 || ! "$VENV/bin/python" -m pip --version >/dev/null 2>&1; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      python3-venv python3-pip ca-certificates >/dev/null
    rm -rf "$VENV"
    "$PY" -m venv "$VENV"
  fi
fi

# shellcheck disable=SC1091
. "$VENV/bin/activate"

PIP_ARGS=(-q)
[ -n "${PIP_INDEX_URL:-}" ] && PIP_ARGS+=(-i "$PIP_INDEX_URL")
python -m pip install "${PIP_ARGS[@]}" -r requirements.txt

python -m pytest tests -q --strict-markers
