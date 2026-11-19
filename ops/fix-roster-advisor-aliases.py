#!/usr/bin/env python3
# pyright: reportMissingImports=false, reportMissingModuleSource=false
# 这个脚本跑在**后端容器里**（app 包只存在于镜像中），仓库根解析不到 app。
# 真正的解析错误会在运行时报出来，不需要类型检查器在这里重复拦一次。
"""名册 advisor 归一：把「改过账号名的导师」的行并到当前账号键下。

问题
----
导师账号改名后（adminlegacy → admin01），名册里的 advisor 列
留下了两套值：

    advisor=adminlegacy    13 行   ← 旧账号名，Casdoor 里已不存在
    advisor=admin01  8 行  ← 当前账号名

后果：
- `list_members(advisor)` 只按当前 advisor 查 → 旧名下的组员**整组消失**
- 同一名（code+name）在两套 advisor 下各有一行 → 目录会建两遍、授权打架
- 导师登录后看到"少了 13 个组员"，而名册里明明还有这些人

做法
----
1. 找出所有**在 Casdoor 里已不存在**的 advisor 值；
2. 同一名（code+name）在有效 advisor 下已有行 → 删掉失效 advisor 下的重复行；
3. 否则把 advisor 改写成有效账号键。

只处理「账号确实不存在」的 advisor；指向另一个**真实存在**的导师
（比如另一个 PI 的账号）一律不动 —— 那是另一位老师的组员，不是脏数据。

用法：
    python3 ops/fix-roster-advisor-aliases.py            # 只报告，不改
    python3 ops/fix-roster-advisor-aliases.py --apply    # 真改
"""


from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, "/srv/app")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))


def _db():
    from app import db  # noqa: PLC0415 - 运行时才 import（脚本可能不在容器里）

    return db


def casdoor_accounts() -> set[str]:
    """Casdoor 里真实存在的账号名集合。"""
    from app.accounts import OWNER, _query  # noqa: PLC0415

    rows = _query(
        'SELECT name FROM public."user" WHERE owner = %s AND is_deleted = false', (OWNER,)
    )
    return {str(r.get("name") or "") for r in rows}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="真正写库（默认只报告）")
    args = parser.parse_args()

    db = _db()
    accounts = casdoor_accounts()

    roster = db.query(
        "SELECT id, advisor, code, name FROM labspace.lab_roster ORDER BY advisor, code, name"
    )
    by_advisor: dict[str, list[dict]] = {}
    for row in roster:
        by_advisor.setdefault(str(row.get("advisor") or ""), []).append(row)

    stale = sorted(a for a in by_advisor if a and a not in accounts)
    changed = 0
    if stale:
        print(f"Casdoor 里已不存在的 advisor：{stale}\n")
    else:
        print("名册里的 advisor 全部指向真实账号。\n")
    for old in stale:
        # 同名在有效 advisor 下已有 → 目标 advisor
        for row in by_advisor[old]:
            code, name = str(row.get("code") or ""), str(row.get("name") or "")
            targets = [
                adv
                for adv, items in by_advisor.items()
                if adv and adv in accounts
                and any(
                    str(i.get("code") or "") == code and str(i.get("name") or "") == name
                    for i in items
                )
            ]
            if targets:
                target = targets[0]
                print(f"  删除重复行  advisor={old:<20} {code} {name}（已存在于 {target}）")
                if args.apply:
                    db.execute(
                        "DELETE FROM labspace.lab_roster WHERE id=%s", (row.get("id"),)
                    )
                    changed += 1
            else:
                # 没有同名可并：找一个"最像"的合法 advisor（同姓/同前缀）来并
                target = _guess_target(old, accounts, by_advisor)
                if not target:
                    print(f"  ⚠ 无法判断 {old} 应并到谁，保留原样：{code} {name}")
                    continue
                print(f"  改写 advisor {old} → {target}  {code} {name}")
                if args.apply:
                    db.execute(
                        "UPDATE labspace.lab_roster SET advisor=%s WHERE id=%s",
                        (target, row.get("id")),
                    )
                    changed += 1

    # ---- 旧名残留行 -------------------------------------------------------
    # 改名（人名改了）后，名册里会留下「同一学号、旧姓名、没绑定账号」的残行。
    # 它会让同一个学号出现两次（陈同学 / 陈同学），目录也会建两棵。
    #
    # 判定规则（保守）：
    #   同一 (advisor, code) 组里，若该 code 下**已绑定账号**的当前显示名集合非空，
    #   而某行的 name 不在这个集合里、且该行没有绑定任何账号
    #   → 这一行是改名前的残留 → 删。
    #   集合为空（该组所有人都没账号）时不动：分不清是旧名还是本来就没人报名。
    stale_rows = _stale_name_rows(db, accounts)
    for row in stale_rows:
        print(
            f"  删除旧名残留  advisor={row['advisor']:<20} "
            f"{row['code']} {row['name']}（当前显示名：{row['known']}）"
        )
        if args.apply:
            db.execute("DELETE FROM labspace.lab_roster WHERE id=%s", (row.get("id"),))
            changed += 1

    print(f"\n{'已应用' if args.apply else '试运行（加 --apply 执行）'}：{changed} 行变更")
    return 0


def _stale_name_rows(db, accounts: set[str]) -> list[dict]:
    """找出「同一学号下、改名前的旧姓名、且没有绑定账号」的残留行。"""
    rows = db.query(
        "SELECT id, advisor, code, name, account FROM labspace.lab_roster ORDER BY advisor, code, name"
    )
    by_group: dict[tuple[str, str], list[dict]] = {}
    for row in rows:
        key = (str(row.get("advisor") or ""), str(row.get("code") or ""))
        by_group.setdefault(key, []).append(row)

    # 已绑定账号的当前显示名
    display: dict[str, str] = {}
    for name in accounts:
        display[name] = _display_name(name)

    # 同一 code 下、**任意 advisor** 的已绑定账号显示名都算数：
    # 陈同学/陈同学 这类旧名行可能挂在另一个导师名下，但同一个学号
    # 在任一导师下都已经有了"新名 + 已绑定账号"的行 → 旧名行就是残留。
    by_code: dict[str, set[str]] = {}
    for (_advisor, code), items in by_group.items():
        for item in items:
            account = str(item.get("account") or "")
            if account and display.get(account):
                by_code.setdefault(code, set()).add(display[account])

    out: list[dict] = []
    for (advisor, code), items in by_group.items():
        known = by_code.get(code) or set()
        if not known:
            continue
        for item in items:
            name = str(item.get("name") or "")
            if not name or name in known:
                continue
            if item.get("account"):
                continue
            out.append(
                {
                    "id": item.get("id"),
                    "advisor": advisor,
                    "code": code,
                    "name": name,
                    "known": "/".join(sorted(known)),
                }
            )
    return out


def _display_name(account: str) -> str:
    """账号在 Casdoor 里的当前显示名（取不到就空）。

    注意：**不能**用门户库查 ``public."user"`` —— 那是 Casdoor 库里的表，
    门户库里没有（查了会抛 UndefinedTable）。要用 accounts 的 Casdoor 查询。
    """
    try:
        from app.accounts import OWNER, _query  # noqa: PLC0415

        rows = _query(
            'SELECT display_name FROM public."user" WHERE owner = %s AND name = %s LIMIT 1',
            (OWNER, account),
        )
    except Exception:  # noqa: BLE001 - 取不到就当没有
        return ""
    return str(rows[0].get("display_name") or "") if rows else ""


def _guess_target(old: str, accounts: set[str], by_advisor: dict[str, list[dict]]) -> str | None:
    """猜旧 advisor 名该并到哪个有效账号。

    规则：有效账号里去掉数字后缀后与旧名相同（adminlegacy ↔ admin01），
    且该账号确实带着名册里的行 → 就是它。
    """
    base = old.rstrip("0123456789")
    candidates = [a for a in accounts if a.rstrip("0123456789") == base and a in by_advisor]
    if len(candidates) == 1:
        return candidates[0]
    # 还有多个候选时，取带行最多的那个
    if candidates:
        return max(candidates, key=lambda a: len(by_advisor[a]))
    return None


if __name__ == "__main__":
    raise SystemExit(main())
