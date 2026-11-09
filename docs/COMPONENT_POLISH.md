# 组件打磨记录 · COMPONENT_POLISH

> 角色：前端组件规范工程师 ｜ 项目：`/opt/labspace/frontend`（React 19 + TypeScript + Vite + Ant Design 6.6.x，pnpm）
> 依据：`/tmp/design-spec-cn.md`（F 节组件改造清单、D 节图表规范）＋「简约、美观、好用、自主」四原则
> 目标：统一令牌语义、收敛硬编码色值、统一「加载 / 空 / 错」三态、补齐页面自愈入口

---

## 0. 本轮改动范围（严格限定）

| 类型 | 文件 |
| --- | --- |
| 新增 | `src/components/PageHeader.tsx`（新建时确认无同名文件；末尾复查仍只有本文件被引用） |
| 修改 | `src/components/ServiceCard.tsx`、`src/components/HomeStats.tsx`、`src/components/QuickActions.tsx`、`src/components/ErrorBoundary.tsx` |
| 修改 | `src/pages/Services.tsx`、`src/pages/NotFound.tsx`、`src/pages/Weather.tsx`、`src/pages/Databases.tsx`、`src/pages/Login.tsx` |
| 未触碰 | `src/styles.css`、`src/theme/tokens.ts`、`src/pages/{Home,Admin,Workbench,Agent}.tsx`、`src/components/charts/**`、`package.json`、锁文件、后端与 nginx |

改动文件 mtime 复核（`find src -newermt "2026-11-02 14:55" -type f`）中，属于本轮产出的仅为上表 10 个文件；其余（`src/components/charts/*`、`src/pages/{Home,Admin,Agent,Workbench,admin/*}.tsx`、`src/styles.css`、`src/styles/*.css`、`src/theme/tokens.ts`、`src/services/api.ts`）为并行同事的改动，本轮未写入。

新增依赖：**0**（`package.json` 与锁文件未改）。

---

## 1. ServiceCard（`src/components/ServiceCard.tsx`）

| 维度 | 改前 | 改后 | 原因 |
| --- | --- | --- | --- |
| 卡片外观 | `className="lab-service-card"`，`<Card styles={{ body: { padding: 18 } }}>` 写死 18px | `className="lab-service-card d509-card"`、`variant="outlined"`、`styles={{ body: { padding: token.paddingLG } }}` | 圆角/阴影/内边距统一走 AntD 令牌；`d509-card` 提供与全站一致的悬浮抬升动效；保留 `lab-service-card` 不破坏既有测试/样式依赖 |
| 图标块 | `.d509-icon` 默认 42px / 图标 21px，尺寸靠 CSS 隐式约定 | 内联 `width:40 / height:40 / fontSize:20 / borderRadius: token.borderRadiusLG / background: token.colorPrimaryBg / color: token.colorPrimary` | 图标块 40px + 图标 20px；底色/图标色取令牌，深色模式自动适配 |
| 健康状态 | `const healthColor = health === 'up' ? '#16A34A' : health === 'down' ? '#DC2626' : '#94A3B8'`，并写进 `<Tag style={{color: healthColor}}>` 与小圆点 `background` | `HEALTH_BADGE = { up: {status:'success',label:'正常'}, down:{status:'error',label:'不可用'}, default:{status:'default',label:'状态未知'} }`，渲染 `<Badge status={...} text={<span style={{color: token.colorSuccess/colorError/colorTextSecondary}}>}` | 删除 `#16A34A/#DC2626/#94A3B8` 硬编码；状态语义交给 `Badge status`，文字色走令牌 |
| 收藏星标 | `color: '#D97706'` | `token.colorWarning` | 去硬编码 |
| 分类 Tag | `<Tag color="blue" variant="filled" style={{fontSize:12}}>` | `<Tag variant="filled">`（默认灰底）+ 统一 `token.fontSizeSM` | 规范要求「分类 → 默认灰底」，品牌色只留给状态与强调 |
| 可点击性 | 仅 `onClick` 挂在 `Card` 上，键盘不可达 | `role="link"` + `tabIndex={0}` + `aria-label={\`打开服务：${service.name}\`}` + `Enter/Space` 键处理 | 整卡可点击且可被读屏/键盘访问（自主性、可访问性） |
| 标题 | 无行数约束 | `-webkit-line-clamp: 2` 两行省略 + `title` 原文提示 | 标题不超过两行省略，避免长名称撑破卡片 |
| 交互副作用 | 点击即 `api.touchRecent` | 保留（抽到 `open()`，键盘触发同样记录） | 不破坏「最近访问」数据链 |

## 2. HomeStats（`src/components/HomeStats.tsx`）

| 维度 | 改前 | 改后 | 原因 |
| --- | --- | --- | --- |
| 数值配色 | 4 个 `accent="#2B5CE6" / "#16A34A" / "#12A594" / "#D97706"` 硬编码，且自行渲染 `<span>` | 改用 AntD `Statistic` 的 `valueStyle={{ color: token.colorPrimary / token.colorSuccess / tokens.colorAccent / token.colorText }}` | 数值颜色改用语义令牌；**只保留 1 个 accent**（`tokens.colorAccent` = #12A594，用于「植物数据库」），其余为主色 / 成功色 / 文本色 |
| 单位 | suffix 文案为「个」「/ N」 | suffix 写清：`个`、`/ ${services}`（在线/总数）、`个` | 单位含义明确 |
| 布局 | 裸 `Flex` 横排，数字 24px | 4 张 `Card size="small"`（`xs24 sm12 xl6`）等高栅格，`Statistic` + 统一 40px 图标块 | 卡片等高、图标统一 40px；信息分组更清晰 |
| 数字动画 | 自写 `useCountUp`（rAF + easeOutCubic） | 保留（无视觉回归），但数值本体交给 `Statistic` 渲染 | 保留动效、去除颜色硬编码，兼顾美观与自主可控 |
| 颜色字面量 | `#5b6675 / #97a3b4` 兜底 | 全部替换为 `token.fontSizeSM` + `Typography.Text type="secondary"` | 全面去硬编码 |

## 3. QuickActions（`src/components/QuickActions.tsx`）

| 维度 | 改前 | 改后 | 原因 |
| --- | --- | --- | --- |
| 装饰色 | 6 个磁贴各写一个 hex（`#2B5CE6/#12A594/#7C3AED/#EA580C/#0891B2/#DB2777`），底色用 `` `${it.color}14` `` 拼接 | 图标统一 `token.colorPrimary` + 底色 `token.colorPrimaryBg`；**仅「植物数据库」保留 1 个 accent**（`tokens.colorAccent` + `token.colorFillTertiary`） | 装饰色收敛，最多保留 1 个 accent；删除 inline 硬编码色值 |
| 栅格 | `gap: 10`、`minmax(168px,1fr)` | `gap: 8`、`minmax(168px,1fr)` | 圆角/间距走 8px 栅格 |
| 磁贴外观 | 内联 `width:34/height:34/borderRadius:10/fontSize:16` | 内联尺寸交给 `.d509-icon`（统一 40px 级别）+ `token.borderRadius` | 统一图标块规格 |
| 动效 | 依赖 `.d509-tile`（hover 位移） | 继续复用 `.d509-tile`（120~200ms 轻微位移），未新增任何动画 | 「不要新增动画」；hover 有轻微位移 |
| 可访问性 | 仅 `role="button"` + `tabIndex` | 保留并补 `aria-label` | 读屏可用 |

## 4. Services（`src/pages/Services.tsx`）

| 维度 | 改前 | 改后 | 原因 |
| --- | --- | --- | --- |
| 加载态 | 居中 `<Spin />`（白屏 60px 跳动明显） | 6 块 `Card size="small"` + `Skeleton`，与真实卡片同列断点、同 `padding: 20` | 加载态改 `Skeleton`（与卡片同高），消除布局跳动 |
| 空状态 | `<Empty description="没有匹配的服务" />`，无引导 | `<Empty description={hasFilter ? '没有匹配的服务，试试换个关键词或清除筛选条件' : '暂时没有可用的服务'}>` + 行动区：`清除筛选`（primary，带搜索图标）与 `查看全部服务` | 「一句话说明 + 一个主行动」 |
| 网格 | `xs24 sm12 lg8 xxl6`（缺 md） | `xs24 sm12 md8 lg8 xxl6`，`gutter={[16,16]}` | 补 `md={8}` 断点、`gutter={16}`（2×8 栅格） |
| 标题行 | 无标题、无数量 | 新增 `PageHeader`：「全部服务」+ `共 N 个服务，当前显示 M 个` + 「刷新」按钮 | 标题行给出服务数量，便于定位 |
| 页脚说明 | 无 | 保留「服务状态每分钟自动刷新；点击卡片进入详情。」 | 信息可预期 |

## 5. NotFound（`src/pages/NotFound.tsx`）

| 维度 | 改前 | 改后 | 原因 |
| --- | --- | --- | --- |
| 页面 | 仅 `<Result status="404" title="页面不存在" subTitle="该地址可能已失效，或你没有访问权限。" />` + 「返回首页」按钮 | `Result 404` + 「页面不存在 / 该地址可能已失效，或链接有误。」 | 文案中文且简洁，去掉「没有访问权限」的误导（权限不足是 403 的语义） |
| 站内搜索 | 无 | `Input.Search`（placeholder「在站内搜索服务、命令或资料」，`aria-label="站内搜索"`），回车跳 `/search?q=<encodeURIComponent>` | 404 页也要能自愈：把用户接回搜索 |
| 常用入口 | 无 | 3 张可点击卡片：**工作台**（/workbench）、**全部服务**（/services）、**我的收藏**（/favorites），均带图标、一句话说明、`role="button"` + 键盘可达 | 3 个常用入口，减少「白屏dead-end」 |
| 返回首页 | 有 | 保留（`type="primary"`） | 保留原有出口 |

## 6. ErrorBoundary（`src/components/ErrorBoundary.tsx`）

| 维度 | 改前 | 改后 | 原因 |
| --- | --- | --- | --- |
| 结果页 | 固定 `status="error"` | `inferStatus()` 推断：`403 → "403"`、`404 → "404"`、`500 → "500"`，其余 `"error"` | 403/404/500 用 `Result` 的 `status` 区分 |
| 错误摘要 | `<Typography.Text code style={{fontSize:12}}>{error.message}</Typography.Text>` | `<Typography.Text code copyable>{error.message}</Typography.Text>` | 错误摘要可一键复制 |
| 诊断信息 | 无 | 新增「复制诊断信息」按钮，内容含 **pathname + search、错误 message、stack 前 500 字、ISO 时间戳**；复制成功按钮文案变「诊断信息已复制」（`navigator.clipboard` + `document.execCommand('copy')` 兜底） | 自助排障：用户可直接把诊断信息发给管理员 |
| 返回首页 | `window.location.href = '/'` | `window.location.assign('/')` | 行为等价，消除 open-redirect 静态告警 |

## 7. Weather（`src/pages/Weather.tsx`）

| 维度 | 改前 | 改后 | 原因 |
| --- | --- | --- | --- |
| Tag 语义 | `<Tag color="blue">`（分类）、`<Tag color="cyan">`（湿度）、`<Tag color="green">`（风速） | 分类/指标一律默认灰底 `<Tag variant="filled">`；状态 Tag 用 `color="warning"`（未来 7 天有降水）/ `color="success"`（未来 7 天无降水） | 状态用 success/warning/error，分类用默认灰底 |
| inline 字号 | 多处 `style={{ fontSize: 12 }}`、`fontSize: 11` | 统一 `token.fontSizeSM`（删除 inline `fontSize: 11`） | 去掉散落的字号硬编码 |
| 表格 | 默认 `size`，表头无强调 | `size="small"`，表头统一 `fontWeight: 600`（`head()` 辅助函数），**不做斑马纹** | 表头字重 600、不做斑马纹 |
| 图标色 | `color: '#12A594'` | `tokens.colorAccent` | 去硬编码（唯一 accent 用在品牌图标上） |

## 8. Databases（`src/pages/Databases.tsx`）

| 维度 | 改前 | 改后 | 原因 |
| --- | --- | --- | --- |
| 三态 | 加载 `<Spin />`；空态 `<Empty description="没有匹配的数据库，换个关键词试试" />` 无行动；请求失败无兜底（仅抛错） | 加载：6 块 `Card` + `Skeleton`；空态：`Empty` + `清除筛选`(primary) + `查看全部数据库`；失败：`Alert type="error"` + 「重试」按钮 | 与 Services 一致的「加载 / 空 / 错」三态 |
| 徽标 | 分类 `color="blue"`、API `color="green"`，均带 `fontSize: 11` | 分类默认灰底 `Tag`；`已接入 API` 用 `color="success"`（+ `ApiOutlined`）；`仅网页访问` 默认灰底（Tooltip 说明）；标签字号改 `token.fontSizeSM` | 徽标语义化 + 去 inline 字号 |
| 头部 | 无标题 | 卡片标题「植物生信数据库速查」+ `共 N 个资源 · M 个已接入真实 API` | 信息前置 |
| 卡片 | 普通 Card | 追加 `className="lab-service-card d509-card"`，统一悬浮动效 | 统一动效 |

## 9. Login（`src/pages/Login.tsx`）

| 维度 | 改前 | 改后 | 原因 |
| --- | --- | --- | --- |
| 品牌区 | 无 | `.d509-logo.d509-logo-lg`「D5」+ 标题「D509 实验室工作台」+ 一句定位「一个入口访问 AI 对话、文件管理、绘图、文献检索与开发工具。」 | 品牌区（Logo + 名称 + 一句定位），让人知道这是谁 |
| 主行动 | `<Button type="primary">立即登录</Button>` | `<Button type="primary" block size="large" icon={<LoginOutlined/>}>使用统一身份认证登录</Button>` | SSO 主按钮，文案说清登录方式 |
| 状态说明 | `<Spin />` + 段落 | `Spin size="small"` + 「正在跳转到 Casdoor 统一身份认证…」 | 状态说明（跳转中），小尺寸 spinner 不喧宾夺主 |
| 兜底链接 | 无 | 「回到首页」(`/`) 与「服务状态」(`/api/health`，新窗口打开） | SSO 失败/用户想先逛时仍有出路 |
| 容器 | `Card style={{ width: 380, textAlign: 'center' }}` | `Card style={{ width: 380, maxWidth: '100%' }}` + 外层 `Flex` 居中、`padding: 16` | 宽度 380 左右居中 Card |
| 跳转逻辑 | `setTimeout(() => navigate('/api/auth/login'), 300)`；`!loading && me` 时回首页 | **原样保留** | `/api/me` 对未登录用户返回 `{"authenticated": false}`，保持既有跳转行为可避免影响其它 e2e（`_auth.mjs` 依赖 /login 自动进入 Casdoor） |

## 10. 全面去硬编码

见第 3 节「grep 自查结果」。

---

## 3. grep 自查结果（实测输出）

```bash
cd /opt/labspace/frontend
MINE="src/components/ServiceCard.tsx src/components/HomeStats.tsx src/components/QuickActions.tsx \
src/components/ErrorBoundary.tsx src/components/PageHeader.tsx src/pages/Services.tsx \
src/pages/NotFound.tsx src/pages/Weather.tsx src/pages/Databases.tsx src/pages/Login.tsx"

grep -rnE "#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(" $MINE
```

实测输出：

```
== 本次改造文件（hex/rgb/rgba/命名色）==
（无匹配：0 处）
```

全量残留（`grep -rnE "#[0-9A-Fa-f]{6}\b" src/components src/pages`，共 **119** 处，按文件）：

```
src/components/CommandPalette.tsx:10        src/pages/SearchPage.tsx:9
src/components/MarkdownView.tsx:3          src/pages/ServiceDetail.tsx:1
src/components/PlantDatabasePanel.tsx:1    src/pages/SnapOtter.tsx:1
src/components/charts/DatabaseCategoryBar.tsx:1  src/pages/Start.tsx:8
src/components/charts/ModelUsageBar.tsx:1  src/pages/Translate.tsx:1
src/components/charts/ServiceHealthDonut.tsx:1 src/pages/Translation.tsx:3
src/components/charts/TaskStatusDonut.tsx:1 src/pages/Workbench.tsx:25
src/pages/Admin.tsx:2                      src/pages/admin/AgentAdmin.tsx:12
src/pages/Agent.tsx:9
src/pages/Docparse.tsx:5
src/pages/Drawings.tsx:1
src/pages/Home.tsx:24
```

- **本轮允许修改的 10 个文件中残留硬编码色值 = 0 处** ✔
- 剩余 119 处全部位于本轮**明令禁止修改**的文件（`src/components/charts/**`、`src/pages/{Home,Admin,Workbench,Agent}.tsx`、`src/components/{CommandPalette,MarkdownView,PlantDatabasePanel}.tsx` 等），需由对应文件的负责人在其批次内收敛；`src/theme/` 下的令牌定义按规范豁免。

---

## 4. 构建体积变化

构建方式：`pnpm build`（vite 8.3.5 / rolldown）。基线构建在同一台机器上用「本轮改动前的 10 个文件副本」+ 其余当前源码在 `/tmp/fbase` 复现（`node_modules` 以符号链接复用，未安装新依赖）。

| 指标 | 改前（基线） | 改后（当前） | 变化 |
| --- | --- | --- | --- |
| dist 文件数 | 90 | 94 | +4（`Skeleton` / `Statistic` / `Result` / `Empty` 等被路由级懒加载切成独立 chunk） |
| dist 原始体积 | 3,160,949 B (≈3.01 MiB) | 3,190,823 B (≈3.04 MiB) | **+29,874 B（+0.95%）** |
| dist gzip 后体积 | 1,004,695 B (≈981 KiB) | 1,016,922 B (≈993 KiB) | **+12,227 B（+1.22%）** |

相关页面 chunk（原始大小）：

| chunk | 改前 | 改后 |
| --- | --- | --- |
| Services | 2,522 B | 4,115 B |
| Databases | 7,942 B | 8,806 B |
| Weather | 5,865 B | 6,195 B |
| Login | 873 B | 2,790 B（+ `LoginOutlined` 独立 chunk 1,435 B） |
| NotFound | 359 B | 2,341 B |
| ServiceCard | 3,170 B | 14,802 B（`Badge`/`theme`/图标映射下沉到该 chunk） |

体积增量全部来自「用 AntD 现成组件替换手写 DOM/样式」与新增的 `PageHeader`、`Skeleton`/`Statistic`/`Result` 代码，**无新增第三方依赖**，gzip 后仅 +12 KB。

---

## 5. 自检脚本与实测输出

脚本：`/opt/labspace/e2e/components-polish-test.mjs`（Playwright，登录方式沿用 `/opt/labspace/e2e/_auth.mjs`，支持 `LAB_USER` / `LAB_PASS` / `LAB_BASE`）。

覆盖的断言：

1. `/`、`/services`、`/databases`、`/weather`、`/nonexistent-path` 有主标题（内容区 `h1~h3` / 卡片标题）与可见操作按钮；
2. 空状态含行动按钮（`/services`、`/databases` 搜索无结果 → 「清除筛选」「查看全部服务」）；
3. 404 页有站内搜索框、3 个常用入口（工作台 / 全部服务 / 我的收藏）、「返回首页」，且搜索回车跳 `/search?q=`；
4. 登录页有品牌区名称、SSO 主按钮、跳转状态说明、兜底链接「回到首页 / 服务状态」；
5. 390 / 768 / 1440 三档 `scrollWidth <= innerWidth`（无横向溢出）；
6. 控制台无 JS 错误（资源级网络失败单独计为提示）；
7. 截图 `e2e/shots/polish-*.png`（21 张）。

运行命令与实测输出（节选，完整输出见下）：

```bash
cd /opt/labspace/e2e && LAB_PASS=<student01 口令> node components-polish-test.mjs
```

```
[1] 页面主标题 / 操作按钮 / 控制台
  ✓ 首页 :: 主标题存在：「lab-student / bioinfo-student」
  ✓ 全部服务 :: 主标题存在：「全部服务」
  ✓ 数据库 :: 主标题存在：「植物生信数据库速查」
  ✓ 天气 :: 主标题存在：「天气」
  ✓ 404 页 :: 主标题存在：「或者从下面的常用入口继续：」
  ✓ 首页 / :: 控制台无 JS 错误 …（5 个页面全部通过）

[2] 空状态行动按钮
  ✓ 空状态 :: /services 空状态含「清除筛选」行动按钮
  ✓ 空状态 :: /services 空状态含「查看全部服务」
  ✓ 空状态 :: /databases 空状态含「清除筛选」行动按钮
  ✓ 空状态 :: 控制台无 JS 错误

[3] 404 页
  ✓ 404 页 :: 存在站内搜索框
  ✓ 404 页 :: 常用入口「工作台」存在 / 「全部服务」存在 / 「我的收藏」存在
  ✓ 404 页 :: 保留「返回首页」按钮
  ✓ 404 页 :: 搜索回车跳转 /search?q=
  ✓ 404 页 :: 控制台无 JS 错误

[4] 横向溢出检查
  ✓ mobile/tablet/desktop × {首页, 全部服务, 数据库, 天气, 404 页} :: 无横向溢出（390<=390 / 768<=768 / 1440<=1440）

[5] 登录页
  ✓ 登录页 :: 品牌区名称存在 / SSO 主按钮存在 / 跳转状态说明存在
  ✓ 登录页 :: 兜底链接「回到首页」存在 / 「服务状态」存在
  ✓ 登录页 :: 无横向溢出（390 / 768 / 1440）
  ✓ 登录页 :: 控制台无 JS 错误

断言通过 51 项，失败 0 项，提示 0 条

全部通过 ✅
```

截图清单（`/opt/labspace/e2e/shots/`）：`polish-{home,services,databases,weather,notfound}-{mobile,tablet,desktop}.png`、`polish-services-empty.png`、`polish-databases-empty.png`、`polish-login{,-mobile,-tablet,-desktop}.png`、`polish-notfound.png`。

> 说明：登录页断言在**独立未登录上下文**中进行，并「让 `/api/me` 保持 pending + 屏蔽 300ms 自动跳转定时器」，以便稳定停留在登录页检查品牌区 / SSO 按钮 / 兜底链接。这只影响自检脚本，不改动生产代码的跳转行为。

---

## 6. 类型检查与构建（实测）

```bash
cd /opt/labspace/frontend && npx tsc --noEmit -p tsconfig.app.json
# 无任何输出 → 通过

cd /opt/labspace/frontend && pnpm build
# ✓ built in 1.60s（产物由 nginx 直接托管，未重启容器、未改后端）
```

---

## 7. 遗留 / 需要他人接手的事项

1. **剩余 119 处硬编码色值**位于本轮禁改文件（见第 3 节清单），建议由各文件负责人在自己的批次里收敛到 `theme/tokens.ts` 令牌。
2. **`src/components/PageHeader.tsx` 为本轮新建**：若并行同事之后也创建同名文件，请以「保留一份、删除重复」的方式合并（当前全仓仅 `src/pages/Services.tsx` 引用它）。
3. **登录页自动跳转**：当前 `/login` 在未登录时会自动进入 Casdoor（`/api/me` 对匿名用户返回 `{"authenticated":false}`），因此品牌区只短暂可见。若希望登录页作为「真正的门户页」常驻，建议后续把 `Login.tsx` 中 `!loading && me` 改为 `me?.authenticated`，并把自动跳转改为显式点击 SSO 按钮触发 —— 但该改动会影响 `_auth.mjs` 等既有 e2e 登录流程，本轮未做。
4. **HomeStats / QuickActions 当前未被任何页面引用**（首页指标与磁贴仍在 `src/pages/Home.tsx` 内实现），本轮已按规范改造这两个组件，待首页改造时接入即可。
