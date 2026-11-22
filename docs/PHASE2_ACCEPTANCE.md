# Phase 2 验收记录

本文件是 Phase 2「清理、ACL 统一与前端解耦」的最终验收证据。
历史踩坑与中间过程见 [PHASE2_STATUS.md](PHASE2_STATUS.md)，本文件只记最终结果，
两者不冲突：STATUS 记「当时发生了什么」，本文件记「交付时是什么样」。

## 交付时间与环境

- 仓库：`/opt/labspace`，公开源 `caoronglin/labspace`
- 门禁执行环境：本机（Python venv `backend/.venv`、Node 22、Go 1.x `GOPROXY=off`）
- e2e 账号：`/etc/labspace/e2e-accounts.env`（不入库）

## 门禁结果（全部实测）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 后端单测 | `backend/.venv/bin/python -m pytest -q` | **307 passed**, 268 warnings |
| 前端类型 | `cd frontend && npx tsc -b` | **0 error** |
| 前端构建 | `cd frontend && npx vite build` | **✓ built in 5.05s** |
| Go 单测 + race | `cd go-core && GOPROXY=off go test -race ./...` | **全部包 ok** |
| 裸 hex | `grep -rnE "#[0-9a-fA-F]{6}" frontend/src/pages --include='*.tsx'`（排除 `Colors.tsx`） | **0 处** |
| e2e 全量 | `cd e2e && ./run-regression.sh`（39 个正式用例） | **全部通过，0 FAIL**（r18，`/tmp/e2e-run18.log`） |
| 文档链接 | `python3 ops/check-docs-links.py` | **OK：28 份文档**，digest 与 compose 一致 |

## 目标达成对照

| 目标 | 结果 |
| --- | --- |
| 清理仓库垃圾 / 文档漂移 | ✅ `.retired`、`.bak` 清理；根目录只留 README；9 份重复文档删除；e2e 探针 167→2（`_auth.mjs` + `_docparse_gone.mjs`，均被引用） |
| 裸 hex 清零 | ✅ 124 处 → 0；`theme/palette.ts` + `ops/ci-frontend.sh` 静态门禁 |
| ACL 巡检与审计导出 | ✅ Go `AuditACL()` 三类异常 + `POST /v1/admin/acl/audit`；`GET /api/admin/audit` JSON/CSV；写操作全落 `labspace.account_audit` |
| 历史重定向债集中管理 | ✅ `routes/legacyRedirects.tsx` 10 条别名 + `sendBeacon('/api/legacy-hit')`；侧栏五分组 |
| 版本化迁移 | ✅ `backend/migrations/0001_init.sql` + 0002 审计 IP；`migrate.py` 账本单事务、不重放 |
| `api.ts` 2790 → ≤1000 | ✅ **832 行**，拆出 `api-http.ts` / `api-types.ts` / `api-types-agent.ts` / `api-plot.ts` / `api-baserow.ts` |
| `main.py` 2072 → ≤1000 | ✅ **497 行**（用户选 A 放宽到 ≤500）；11 个 `routers/` 模块；Deprecation 头 + `/api/admin/deprecated-hits` 命中计数实测生效 |
| `BaserowPage` 3882 → ≤1000 | ⚠️ **2931 行**：已抽出 `baserow/fieldComponents.tsx`（907 行，含全部辅助函数与字段控件）。剩余主组件的渲染区块引用 55 个闭包变量，强拆风险高；按用户选择 A 延后下一期 |
| `Files` 2715 → ≤1000 | ⚠️ **2789 行**：按用户选择 A 延后下一期（同批已纳入下一期拆分计划） |

**关于两个延后项**：用户明确选择方案 A，将 `BaserowPage` / `Files` 的深度组件化延后到下一期。
本轮已完成 `BaserowPage` 的第一层解耦（字段组件层独立成文件），是净改进且 `tsc` 0 error，
不阻塞任何功能与门禁。剩余两个文件超过 1000 行是**已知的、经用户确认的技术债**，
不是回归或门禁失败。

## e2e 收敛过程（r14 → r18）

全量回归失败脚本数逐轮收敛，全部为「旧断言写死了已下线服务/旧数据形状」，非代码缺陷：

| 轮次 | 失败脚本数 | 主要修复 |
| --- | --- | --- |
| r14 | 17 | 下线服务（Quantum / Open WebUI / CropGenome）改 SKIP；BASE TDZ；外部上游超时 |
| r15 | 9 | bioinfo OIDC 主机自适应；`/services`→`/start` 合并；OIDC 登录竞态 |
| r16 | 2 | biomed 上游瞬断重试；agent 会话竞态 |
| r17 | 1 | design-selfcheck 首页渲染慢 → 等标题元素出现再断言 |
| r18 | **0** | 全绿归档 |

关键修复：
- **新增真 bug 修复**：`Start.tsx` 的 `BorderBeam outset={2}` 导致 mobile/tablet/desktop 三档均横向溢出 2px，去掉 outset
- **Go/Python 契约差异**：workbench `link_source`/`link_path` 两字段 Go 侧缺失（`d3f8dfd`），已在 model/store/http 全链路补齐，`workbench-parity` 13/13 通过
- **下线服务守卫**：`sso-e2e-test` 改为验证 Quantum 路由/端口确实下线，不再等不存在的「一键登录」按钮

## 提交索引（Phase 2 关键提交）

| 提交 | 内容 |
| --- | --- |
| `e0e7053` | 仓库垃圾清理 |
| `f19612b` | 文档收敛 + 链接校验脚本 |
| `5fb9dfb` | 设计令牌裸 hex 清零 |
| `1d46c35` | 版本化迁移 |
| `359cc2f` / `0f69cd7` | ACL 巡检与审计 |
| `0aebdfb` | 旧路由集中 + 侧栏分组 |
| `660bc62` / `eba8e64` / `8820162` | `api.ts` 拆分 |
| `77c32ec` 起 | `main.py` → routers 拆分（AST 工具 `ops/split_main_module.py`） |
| `140e63e` | 代码预览 `kind=code`（30+ 扩展名、行号、复制、无高亮依赖） |
| `55006af` / `4dc3759` 等 | e2e 断言按现状重写 |
| `d3f8dfd` | Go workbench 补齐 link_source/link_path |
| `cfd4a86` | 移除 CropGenome 下线脚本 |
| `2ffbe8b` / `cb66048` | design-selfcheck 去抖 + biomed 重试 |
| `5559bff` | BaserowPage 抽出 fieldComponents（3882→2931） |

## 下一期待办（不在本期范围）

1. `BaserowPage.tsx` 2931 / `Files.tsx` 2789 深度拆分至 ≤1000（建议按 ctx 对象传参的展示组件方式，避免 55 个闭包变量逐个透传）
2. `split-backend` 契约中的 create_app 工厂（用户选 A 未要求）
3. Phase 3：`lab_jobs` 任务中心、ELN 血缘、模型降级配额（规格书明确不在本期）
