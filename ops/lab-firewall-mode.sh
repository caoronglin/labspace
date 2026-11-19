#!/usr/bin/env bash
# labfilter 模式切换：normal（默认） / strict（全量加密）。
#
# 作用
# ----
# 把「内网可达」收敛成「只有对外入口端口可达」，敏感/内部服务只走
# Tailscale（Tailscale 就是 WireGuard 实现，流量天然加密，不需要 SSL 证书）。
#
#   normal：局域网保留对外入口端口（门户、primer、生信…），
#           内部服务（文件核心 8122 / 后端 8088 / RAG 18010 / Samba 445…）只走 Tailscale
#   strict：连对外入口也必须走 Tailscale —— 全部流量强制加密
#
# 安全：带自动回滚
# --------------------
# 应用规则前先起一个后台定时器：若 90 秒内没有收到"确认"信号，
# 自动把规则回滚。万一新规则把自己挡在外面（SSH 断了、nginx 访问不到），
# 定时器会救场。确认方式：脚本跑完后执行 `ops/lab-firewall-mode.sh confirm`。
#
# 用法
#   ops/lab-firewall-mode.sh normal     # 默认档
#   ops/lab-firewall-mode.sh strict     # 全量加密
#   ops/lab-firewall-mode.sh confirm    # 确认当前规则（取消自动回滚）
#   ops/lab-firewall-mode.sh status     # 看当前档位与规则摘要
#   ops/lab-firewall-mode.sh rollback   # 手动回滚到应用前状态
set -euo pipefail

LAB_ROOT=${LAB_ROOT:-/opt/labspace}
SRC_DIR="$LAB_ROOT/ops/nftables"
DST_DIR=/etc/nftables.d
ACTIVE="$DST_DIR/lab-filter.nft"
STATE_DIR=/run/lab-firewall
PENDING="$STATE_DIR/pending-rollback.sh"
ROLLBACK_SECONDS=${LAB_FIREWALL_ROLLBACK_SECONDS:-90}

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

ensure_state_dir() {
  mkdir -p "$STATE_DIR"
}

# 备份当前生效的规则（供回滚）
backup_current() {
  ensure_state_dir
  nft list ruleset > "$STATE_DIR/ruleset.before.txt" 2>/dev/null || true
  nft list table ip labfilter > "$STATE_DIR/labfilter.before.txt" 2>/dev/null || true
}

# 生成回滚脚本：恢复应用前的 ruleset
make_rollback() {
  ensure_state_dir
  cat > "$PENDING" <<EOF
#!/usr/bin/env bash
# 自动回滚：$LAB_ROOT/ops/lab-firewall-mode.sh apply 时生成。
set -euo pipefail
BACKUP="$STATE_DIR/ruleset.before.txt"
if [ -s "\$BACKUP" ]; then
  # 只回滚我们自己的两张表（不动 Tailscale / Docker 的表）
  nft delete table ip labfilter 2>/dev/null || true
  nft delete table ip6 labfilter 2>/dev/null || true
  if [ -s "$STATE_DIR/labfilter.before.txt" ]; then
    nft -f "$STATE_DIR/labfilter.before.txt" || true
  fi
  echo "[auto-rollback] 已回滚 labfilter 规则" >> /var/log/lab-firewall.log 2>/dev/null || true
fi
rm -f "$PENDING"
EOF
  chmod +x "$PENDING"
}

cancel_rollback() {
  ensure_state_dir
  rm -f "$PENDING"
}

apply_rules() {
  local mode="$1"
  local src="$SRC_DIR/lab-filter-$mode.nft"
  [ -r "$src" ] || { log "找不到规则文件：$src"; exit 1; }

  backup_current
  make_rollback

  # 语法先验（-c = check，只解析不加载）
  if ! nft -c -f "$src" 2>"$STATE_DIR/check.err"; then
    log "规则语法有错，未应用："
    cat "$STATE_DIR/check.err" >&2
    rm -f "$PENDING"
    exit 1
  fi

  # 幂等：先删旧表再加载新表（表不存在时 delete 会报错，所以先声明）
  nft list table ip labfilter >/dev/null 2>&1 && nft delete table ip labfilter || true
  nft list table ip6 labfilter >/dev/null 2>&1 && nft delete table ip6 labfilter || true
  nft -f "$src"

  # 装到系统配置，重启后依然生效
  mkdir -p "$DST_DIR"
  install -m 0644 "$src" "$ACTIVE"
  if ! grep -q 'nftables.d/\*.nft' /etc/nftables.conf 2>/dev/null; then
    # include 要放在文件**末尾**（前面已经删过 table，最后重新加载我们的表）
    printf '\n# labfilter（独立表 + priority -10；见 ops/nftables/）\ninclude "%s/*.nft"\n' "$DST_DIR" >> /etc/nftables.conf
  fi

  # 90 秒内没有 confirm 就自动回滚
  ( sleep "$ROLLBACK_SECONDS"; [ -x "$PENDING" ] && "$PENDING" ) >/dev/null 2>&1 &

  log "已应用 $mode 模式；${ROLLBACK_SECONDS}s 内未确认将自动回滚"
  log "确认无误请执行：$LAB_ROOT/ops/lab-firewall-mode.sh confirm"
}

show_status() {
  local mode="unknown"
  if [ -r "$ACTIVE" ]; then
    if grep -q "strict" "$ACTIVE" 2>/dev/null; then mode="strict"; else mode="normal"; fi
    # 文件名不含 strict 时按内容判断
    if grep -q "只留 DNS" "$ACTIVE" 2>/dev/null; then mode="strict"; fi
  fi
  log "当前模式：$mode"
  log "生效文件：$ACTIVE"
  if [ -x "$PENDING" ]; then
    log "⚠ 有待确认的回滚定时器（${ROLLBACK_SECONDS}s 内未 confirm 会自动回滚）"
  else
    log "无待确认的回滚定时器"
  fi
  nft list table ip labfilter 2>/dev/null | sed 's/^/  /' | head -20
}

case "${1:-status}" in
  normal|strict)
    apply_rules "$1"
    ;;
  confirm)
    cancel_rollback
    log "已确认，保留当前规则（自动回滚已取消）"
    ;;
  rollback)
    if [ -x "$PENDING" ]; then
      "$PENDING"
      log "已手动回滚"
    else
      log "没有待回滚的备份"
    fi
    ;;
  status)
    show_status
    ;;
  *)
    echo "用法：$0 {normal|strict|confirm|rollback|status}" >&2
    exit 2
    ;;
esac
