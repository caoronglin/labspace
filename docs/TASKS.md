# 任务清单

> 最后更新：2026-11-09
> 详细变更记录见 [CHANGELOG.md](./CHANGELOG.md)。本文件只保留任务状态快照，避免与变更日志重复。

## 状态总览

| 状态 | 数量 | 说明 |
| --- | --- | --- |
| 进行中 | 0 | — |
| 待外部条件 | 3 | 代码已就绪，缺少密钥/上游服务/测试账号，功能自动降级 |
| 已完成 | 132 | 任务编号 #1–#132，按领域归档如下 |

## 待外部条件

1. **SiliconFlow SystemOne 决策模型**（#57）
   - 接入代码与 `/api/decision/status` 已上线；未配置 `LABSPACE_SILICONFLOW_KEY` 时返回 `enabled:false`，自动回落本地规则，不影响页面。
   - 启用方式：在 `/etc/labspace` 对应环境文件写入密钥并重启门户后端。

2. **知识库问答生成模型**
   - 检索、重排、引用、ACL 过滤均已可用；`/ask` 在 `LABRAG_GEN_BASE_URL / LABRAG_GEN_API_KEY / LABRAG_GEN_MODEL` 未配置时返回 `mode:"retrieval"`，页面展示原文片段并提示「生成模型尚未接入」。
   - 启用方式：在 `/etc/lab-rag/rag.env` 配置上述三项并重启 `lab-rag.service`；建议使用内网模型，避免文档内容外发。

3. **学生测试账号 student01@local**
   - `/etc/labspace/casdoor-users.txt` 仍登记 `student01@local` / `student02@local`，但 Casdoor 库里已无这两个账号
     （现有账号仅 admin、adminlegacy、student03、labadmin、m26student11），`/etc/lab-quantum/users.credentials` 中的 Quantum 侧同名账号还在。
   - 影响：`e2e/_files_write_verify.mjs` 的学生只读源断言无法执行；`/usr/local/bin/lab-sync-passwords` 只能改口令、不能补账号。
   - 补齐方式：用门户「用户和权限」页新建 `student01@local`（用户组 `lab-student`），或直接调 `POST /api/admin/accounts`；
     注意不要跑 `lab-casdoor-init`，它会重写 `/etc/labspace/casdoor-users.txt` 并覆盖 labadmin 口令。

## 已完成（按领域归档）

- **账号、权限与安全**：统一 OIDC、用户组 + 用户单独权限、ACL 细化、硬删除与会话吊销、任务派发层级、管理员组、服务令牌、CSRF、限流与安全头。
- **知识库与 Agent**：FlashRAG + BGE-M3 向量/重排、多知识库与分类、Ant Design X 重写、技能/MCP 全链路、知识库问答与长期记忆合并入口、本地模型接入检索/解析/翻译、深度研究技能。
- **文件管理**：原生网盘与预览、Office 编辑与 PPT 放映、多选批量操作、排序/用量/时间列、回收站、共享与公共质粒/基因组、下载与预览审计、四视图（列表/网格/详情/时间线）。
- **实验与生信**：ELN 模板化记录（已并入个人工作台）、库存台账、流水线运行中心、BLAST 结果查看、公共基因组与 JBrowse 联动、生信实训平台 iframe 嵌入与课程/批改。
- **工作台与任务**：分栏/日历/甘特、导师指派看板、项目任务安排、AI 建任务、实验记录页签与 URL 深链。
- **科研工具**：绘图工作台（Go + Python 胶水 + AntV）、流程图设计、配色搭配、翻译中心、文献检索、数据库速查。
- **平台与运维**：双 IP 适配、备份与恢复演练、性能优化、移动端、页面视觉统一、导航与命令面板、全局回归与安全审计。

## 近期增量（2026-11-07 ~ 11-09）

- [x] 绘图工作台改为上下分栏布局。
- [x] LaTeX 写作页改为与多维表格一致的紧凑工具栏 + 全宽卡片风格。
- [x] 实验记录整合进个人工作台（`/workbench?tab=records`），旧入口自动重定向；Agent 不再保留重复的实验记录模式。
- [x] 文件管理列表视图按文件类型显示对应图标与颜色，与其余三个视图一致。
- [x] 文件管理 E2E 登录等待改为等待门户正文（30s）并自动关闭欢迎弹窗，消除 Casdoor 跳转耗时导致的偶发失败。

## 验证状态

- 前端 `npm run build`：通过（2026-11-09）。
- `e2e/_workbench_eln.mjs`：13/13 PASS。
- `e2e/_latex_ui.mjs`：ALL PASS。
- `e2e/_files_write_verify.mjs`：18 通过 / 1 失败（2026-11-09 重跑）。管理员侧 16 项断言全通过，
  含列表视图按类型渲染图标（`.txt` → `anticon-file-text`、目录 → `anticon-folder-open`），图标改动无回归。
  唯一失败是环境问题：Casdoor 中不存在 `student01@local` 账号，学生只读源 3 项断言未能执行（见「待外部条件」）。

## 维护约定

- 新增/完成任务时同步更新本文件的「状态总览」与对应领域条目，并在 CHANGELOG 记录可验证的变更。
- 「待外部条件」项只有在密钥/上游就绪并完成验证后才能移入已完成。