#!/usr/bin/env bash
# 用 Apptainer 运行一个 SIF，作为常驻服务（systemd 拉起）。
#
# 与 Docker 的差异（决定了这个脚本的参数）：
#   * Apptainer 没有守护进程，容器就是普通进程 → 用 systemd 管生命周期；
#   * 没有 bridge 网络与 DNS 别名 → 服务统一用 `--network=host`，
#     只监听 127.0.0.1（对外一律经 nginx），防火墙规则与原先一致；
#   * 没有 named volume → 数据目录直接 bind 到宿主机路径（更好备份、更好审计）；
#   * 默认会挂载宿主机 $HOME 等目录 → 用 `--containall` 关掉，
#     只显式绑定需要的路径，避免容器看到不该看的东西；
#   * 镜像自带 USER 在 `--containall` 下仍会生效；需要写数据目录时
#     由宿主机预先 chown 好（不靠容器内 chmod）。
#
# 用法：ops/apptainer-run.sh <name>
#   <name> 对应 deploy/apptainer/services.conf 里的一节，读取：
#     <name>.sif / <name>.args / <name>.env / <name>.binds
set -euo pipefail

SIF_DIR=${SIF_DIR:-/srv/labdata/apptainer}
CONF_DIR=${CONF_DIR:-/opt/labspace/deploy/apptainer}
NAME=${1:-}
[ -n "$NAME" ] || { echo "用法: $0 <name>" >&2; exit 2; }

SIF="$SIF_DIR/$NAME.sif"
[ -r "$SIF" ] || { echo "SIF 不存在: $SIF（先跑 ops/apptainer-build.sh $NAME）" >&2; exit 1; }

# ---- 组装参数 ---------------------------------------------------------------
# 注意：Apptainer **默认就与宿主机共享网络命名空间**（不像 Docker 有 bridge）。
# 加 `--network` 反而会去用 CNI 桥接、要求 net.d 配置，这里必须不加。
# 服务因此直接监听宿主机回环端口，与原先 `127.0.0.1:PORT` 的暴露面一致。
ARGS=(exec --containall --no-home --pwd /)

# 数据目录绑定：每行 `宿主路径:容器路径[:ro]`
BINDS_FILE="$CONF_DIR/$NAME.binds"
if [ -r "$BINDS_FILE" ]; then
  while read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    ARGS+=(--bind "$line")
  done < "$BINDS_FILE"
fi

# 环境变量：每行 KEY=VALUE（# 注释）
ENV_FILE="$CONF_DIR/$NAME.env"
if [ -r "$ENV_FILE" ]; then
  while read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    ARGS+=(--env "$line")
  done < "$ENV_FILE"
fi

# ---- 启动 -------------------------------------------------------------------
# .args 里是容器内的命令；没有就用镜像的默认 entrypoint。
ARGS_FILE="$CONF_DIR/$NAME.args"
if [ -r "$ARGS_FILE" ]; then
  # shellcheck disable=SC2207
  CMD=($(grep -vE '^\s*(#|$)' "$ARGS_FILE" | tr '\n' ' '))
  exec apptainer "${ARGS[@]}" "$SIF" "${CMD[@]}"
fi
exec apptainer "${ARGS[@]}" "$SIF"
