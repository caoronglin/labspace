#!/usr/bin/env bash
# Tailscale 入口端口自检（在**客户端**上运行，不是服务器上）
#
# 用法：
#   bash tailscale-port-check.sh              # 默认目标 198.51.100.71
#   bash tailscale-port-check.sh 198.51.100.71
#
# 判读：
#   OK        端口通
#   refused   端口没监听（服务端没开这个端口）
#   timeout   丢包（Tailscale 没连上 / tailnet ACL 拦截 / 对端防火墙）
set -u
HOST="${1:-198.51.100.71}"

PORTS=(
  "80:门户 D509 工作台"
  "8090:统一认证 Casdoor"
  "3000:Open WebUI"
  "8080:Quantum 文件"
  "8082:draw.io"
  "8084:IT-Tools"
  "8086:Linux 命令速查"
  "8091:JBrowse 2"
  "8092:SnapOtter"
  "8102:生信实训平台"
  "445:SMB 文件共享"
)

echo "=== Tailscale 客户端自检 ==="
echo "目标：$HOST"
echo

echo "[1] Tailscale 自身"
if command -v tailscale >/dev/null 2>&1; then
  tailscale status --self 2>/dev/null | head -2 || true
  echo "--- 能否看到 $HOST ---"
  tailscale ping -c 2 --timeout 5s "$HOST" 2>&1 | tail -3
else
  echo "  未安装 tailscale 命令（手机上用 App 即可）"
fi
echo

echo "[2] 端口连通性"
fail=0
for item in "${PORTS[@]}"; do
  port="${item%%:*}"
  name="${item#*:}"
  if command -v nc >/dev/null 2>&1; then
    if nc -z -w 5 "$HOST" "$port" >/dev/null 2>&1; then
      printf '  [ OK   ] %-5s %s\n' "$port" "$name"
    else
      printf '  [ FAIL ] %-5s %s\n' "$port" "$name"
      fail=$((fail + 1))
    fi
  else
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://$HOST:$port/" 2>/dev/null)
    if [[ "$code" != "000" ]]; then
      printf '  [ OK   ] %-5s %s (HTTP %s)\n' "$port" "$name" "$code"
    else
      printf '  [ FAIL ] %-5s %s\n' "$port" "$name"
      fail=$((fail + 1))
    fi
  fi
done
echo

echo "[3] HTTP 抽样"
for url in "http://$HOST/" "http://$HOST:8090/" "http://$HOST:3000/" "http://$HOST/cropgenome/"; do
  code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$url" 2>/dev/null)
  printf '  %-42s %s\n' "$url" "${code:-无响应}"
done

echo
if [[ $fail -eq 0 ]]; then
  echo "结论：所有端口都通，Tailscale 入口正常。"
else
  echo "结论：$fail 个端口不通。"
  echo "  · 全部不通 → Tailscale 没连上这个 tailnet，或 tailnet ACL 没放行（见管理员控制台 Access Controls）。"
  echo "  · 只有个别不通 → 服务端该端口没监听（本机 ss -ltn 可核对）。"
fi
