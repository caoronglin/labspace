#!/usr/bin/env bash
# 从 Casdoor 真实账号重建账号台账（/etc/labspace/casdoor-users.txt）。
#
# 为什么要有这个脚本：
#   旧台账是 lab-sync-passwords 写出来的"明文口令清单"，但它只包含
#   Quantum 时代的 5 个账号（admin / adminlegacy / labadmin / student01 / student02），
#   与现有账号完全对不上，还留着已删除的 labadmin。
#   出问题时去查台账会得到**错误答案**，比没有台账更糟。
#
# 这里的做法：
#   * 只从 Casdoor 的 public."user" 表读事实（账号/姓名/邮箱/用户组/建号时间）；
#   * **不写任何口令**——Casdoor 只存 bcrypt 哈希，口令本身不可反查；
#     需要重置走管理端接口，不要在文件里留明文。
#
# 用法：ops/rebuild-account-ledger.sh [输出路径]
set -euo pipefail

OUT=${1:-/etc/labspace/casdoor-users.txt}
PG=${LAB_PG_CONTAINER:-lab-postgres}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

docker inspect "$PG" >/dev/null 2>&1 || die "找不到 Postgres 容器 $PG"

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

docker exec "$PG" psql -U casdoor -d casdoor -t -A -F'|' -c \
  "select name, display_name, email, groups, created_time
     from public.\"user\"
    where is_deleted = false
    order by created_time" >"$tmp" || die "读取 Casdoor 账号失败"

ACCOUNTS="$tmp" OUT="$OUT" python3 - <<'PY'
import datetime
import os
import pathlib

rows = [line.split("|") for line in pathlib.Path(os.environ["ACCOUNTS"]).read_text().splitlines() if line.strip()]
out = [
    "# LabSpace 统一认证账号台账（自动生成，请勿手工编辑）",
    "#",
    "# 生成方式：从 Casdoor 的 public.\"user\" 表读取真实账号，",
    "# 由 ops/rebuild-account-ledger.sh 重建。",
    "#",
    "# 重要：Casdoor 只存 bcrypt 哈希，**口令本身不可反查**。",
    "#   * 新建账号使用服务端随机生成的一次性口令（首次登录强制改密）；",
    "#   * 用户改过口令后，原始口令任何人都无法得知；",
    "#   * 需要重置时走管理端「用户和权限 → 重置口令」，不要在这里写明文。",
    "#",
    "# 字段：账号 | 姓名 | 邮箱 | 用户组 | 建号时间",
    "",
]
count = 0
for row in rows:
    if len(row) < 5:
        continue
    name, disp, email, groups, created = (x for x in row[:5])
    # Casdoor 的 created_time 有两种历史写法：Unix 秒 与 RFC3339
    ts = created
    if created.isdigit():
        ts = datetime.datetime.fromtimestamp(int(created)).astimezone().strftime("%Y-%m-%d %H:%M")
    out.append(f"{name} | {disp} | {email} | {groups} | {ts}")
    count += 1
pathlib.Path(os.environ["OUT"]).write_text("\n".join(out) + "\n")
print(f"台账已重建：{count} 个真实账号 → {os.environ['OUT']}")
PY

chmod 600 "$OUT"
