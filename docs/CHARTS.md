# 门户数据图表说明（AntV）

本目录文档描述门户中新增的 AntV（`@ant-design/plots` v2 / G2 v5）图表：用途、数据来源、字段映射、空/错态设计与配色规则。

- 组件目录：`frontend/src/components/charts/`
- 图表库：`@ant-design/plots@2.6.8`（`pnpm add @ant-design/plots`，仅 pnpm）
- 全部请求走 `frontend/src/services/api.ts` 的 `request` 封装（cookie + CSRF），组件内不直接 `fetch`
- 全部数据来自真实后端接口，无 mock、无随机数

---

## 1. 统一封装 `ChartCard.tsx`

所有图表的外壳，提供统一的三态与可访问性兜底：

| 状态 | 表现 | 说明 |
| --- | --- | --- |
| 加载中 | AntD `Skeleton` | 图表懒加载 chunk 未就绪或请求进行中 |
| 空数据 | AntD `Empty`（文案「暂无数据」） | 请求成功但没有任何可绘制的数据点 |
| 请求失败 | AntD `Alert`「数据加载失败」+ 「重试」按钮 | 点击后调用 `query.refetch()` |

组件底部固定提供「查看数据表格」折叠区（AntD `Collapse` + `Table`），内容与图表等价，便于读屏用户和复制使用。

Props：`title`、`description`、`extra`（卡片右上角操作区）、`loading`、`error`、`onRetry`、`empty`、`emptyText`、`table: { columns, rows }`、`children`（真正的图表）。

## 2. 配色与主题（`chartTheme.ts`）

- 颜色**只取自** `frontend/src/theme/tokens.ts` 与 antd `theme.useToken()`：
  - 主色 `colorPrimary` #2B5CE6
  - 强调色 `colorAccent` #12A594
  - 成功/警告/错误 `colorSuccess` #16A34A / `colorWarning` #D97706 / `colorError` #DC2626
  - 次要文字 `colorTextSecondary` #5B6675
- 图表主题对象由 `useChartTheme()` 生成：亮色 `type: 'classic'`，暗色 `type: 'classicDark'`，背景透明（由卡片承载），坐标轴/图例文字色随明暗切换。
- **如何改色**：只改 `src/theme/tokens.ts` 里的令牌即可全局生效；若只想改某个图表，调整对应组件里 `useChartPalette()` 返回值的取用（例如把「异常」切片从 `palette.error` 换成 `palette.warning`），不要在组件里硬编码色值。

## 3. 图表清单

### 3.1 `ServiceHealthDonut.tsx` —— 服务健康分布（环形图）

- **用途**：一眼看清平台各服务当前是正常、异常、外部依赖不可用还是未知。
- **数据来源**：
  - `source='public'`：`GET /api/services/health`（首页使用）
  - `source='admin'`：`GET /api/admin/health`（管理端使用，需管理员）
- **字段映射**：`services[].health.status` → `up` 正常（success 色） / `down` 异常（error 色） / `external-down` 外部依赖不可用（warning 色） / `unknown` 未知（次要文字色）；未知取值一律归入「未知」。
- **交互**：图例在右侧，提示框显示「服务数（N 个）」，扇区内标注数量。
- **数据表格**：状态 / 服务数（个） / 占比（%）。
- **空/错态**：服务列表为空 → Empty「暂无数据」；接口失败 → Alert + 重试。

### 3.2 `DatabaseCategoryBar.tsx` —— 数据库分类分布（横向条形图）

- **用途**：展示已收录数据资源在各学科分类下的数量差异。
- **数据来源**：`GET /api/databases` → `{ total, matched, categories, items }`。
- **字段映射**：`items[].category` → 分类名（空值归入「未分类」），按分类聚合计数 → 条形长度（个）；`items.length` 即资源总数（当前 107 条 / 13 个分类）。
- **坐标轴**：X 轴「数据库分类」，Y 轴「资源数量（个）」；条形按数量降序，条内白色数字标注数量。
- **数据表格**：分类 / 资源数量（个） / 占比（%）。
- **空/错态**：无资源 → Empty；接口失败 → Alert + 重试。

### 3.3 `DiskUsagePanel.tsx` —— 磁盘使用率（环形图 + 进度条）

- **用途**：展示服务器数据盘占用情况。
- **数据来源**：`GET /api/admin/info`（管理员）→ `{ disk: { total, used, free } }`。
- **字段映射**：`total / used / free` 为字节 → `bytesToGB()` 换算为 GB（保留 1 位小数）；使用率 = `used / total * 100`。
- **图形**：上方环图展示「已用 / 可用」占比，下方 AntD `Progress` 展示使用率百分比；使用率 > 85% 时进度条切换为错误色。
- **数据表格**：指标 / 数值（总量 GB、已用 GB、可用 GB、使用率 %）。
- **空/错态**：磁盘信息缺失 → Empty；非管理员或接口 403 → Alert + 重试。

### 3.4 `TaskStatusDonut.tsx` —— 任务状态分布（环形图）

- **用途**：展示个人工作台任务的到期与完成情况。
- **数据来源**：`GET /api/workbench/summary`。
- **字段映射**（对 `today.tasks` 做互斥切分，再叠加完成量）：
  - `tasks[].due_date < 今天` → 逾期（error 色）
  - `tasks[].due_date == 今天` → 今日到期（warning 色）
  - `tasks[].due_date` 为空或晚于今天 → 待办中（primary 色）
  - `stats.completedThisWeek` → 本周完成（success 色）
- **数据表格**：状态 / 任务数（条） / 占比（%）。
- **空/错态**：没有任何任务 → Empty「暂无数据」；接口失败 → Alert + 重试。

### 3.5 `ModelUsageBar.tsx` —— Agent 消息用量排行（横向条形图，仅管理员）

- **用途**：查看各账号的 Agent 消息发送量与 Token 消耗。
- **数据来源**：`GET /api/agent/admin/usage`（管理员）→ `{ users: [{ user_id, messages, tokens_in, tokens_out, sessions }], totals }`。
- **字段映射**：`user_id` → 用户；`messages` → 消息数（条）；`tokens_in + tokens_out` → Token 合计（个）；按 `messages` 降序取前 10。
- **说明**：后端当前只按「用户」维度聚合，未提供按模型维度的用量，因此图表以用户为统计单位，标题为「Agent 消息用量排行」。
- **数据表格**：用户 / 消息数（条） / Token 合计（个）。
- **空/错态**：无用量记录 → Empty「暂无数据」；接口失败 → Alert + 重试。

---

## 4. 页面接入与首屏体积

| 页面 | 图表 | 位置 |
| --- | --- | --- |
| `pages/Home.tsx` | 服务健康分布、数据库分类分布 | 现有「工具箱」区块**之后**的「数据概览」区块，位于首屏之下 |
| `pages/Admin.tsx` | 磁盘使用率、服务健康分布（管理员视角） | 「服务状态」Tab 的统计卡片之后、健康检查表格之前 |
| `pages/Workbench.tsx` | 任务状态分布 | 「健康状态条」之后、「计划与方向」之前 |
| `pages/Agent.tsx` | Agent 消息用量排行 | 仅 `useAuth().isAdmin === true` 时渲染，非管理员不渲染 |

加载方式：所有图表都用 `React.lazy` + `Suspense`（fallback 为 `Skeleton` 卡片）动态导入，页面文件里**没有**对 `@ant-design/plots` 的静态 import，因此图表库不会进入首屏 chunk。

实测（`pnpm build` 后统计 `dist/`）：

- 入口 HTML 直接引用的产物合计：raw 933.3KB / **gzip 305.98KB**；与「移除全部图表懒加载」的基线构建相比 **gzip 增量 ≈ 0KB**（远小于 120KB 上限）。
- Home 页面 chunk：`Home-*.js` raw 22.4KB / gzip 7.6KB（基线 7.2KB，+0.4KB，仅为懒加载桩）。
- 图表库 chunk（`chartTheme-*.js`，含 `@ant-design/plots` + G2）：raw 1.42MB / gzip 410.6KB，**仅在滚动到图表区时才按需下载**。
- 各图表组件自身 chunk 均 < 2.3KB raw。

## 5. 验收

- 类型检查：`cd frontend && npx tsc --noEmit -p tsconfig.app.json`（无错误）
- 构建：`cd frontend && pnpm build`（成功）
- 端到端：`cd e2e && LAB_PASS=<密码> node charts-test.mjs` —— 校验首页/工作台/Agent/管理端的图表容器出现、canvas/svg 存在、数据非空、数据表格兜底可用、无控制台错误、无横向溢出，并输出截图到 `e2e/shots/charts-*.png`（管理员段落需要 `LAB_ADMIN_PASS`，缺省时从本机账号文件读取）。
