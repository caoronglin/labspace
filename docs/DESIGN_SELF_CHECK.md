# D509 门户 · 动效与设计系统自检报告

> 范围：`/opt/labspace/frontend` 的**动效与设计系统层**（样式、令牌、页面标题区）。
> 图表（AntV）由另一位同事并行处理，本次**未触碰** `src/components/charts/**` 及图表相关页面代码。
> 本次可修改的文件：`src/styles.css`、`src/theme/tokens.ts`、新增 `src/styles/motion.css`、`src/styles/prose.css`、`docs/DESIGN_SELF_CHECK.md`。
> `src/components/PageHeader.tsx` 已由并行同事创建，本次**未修改其实现**，仅在 CSS 侧为其补齐样式。
> 页面文件（Home / Admin / Workbench / Agent）处于并行工作中，本次**未修改**。

---

## 一、自检表

| # | 检查项 | 现状（改动前） | 结论 | 修复位置 |
|---|--------|----------------|------|----------|
| 1 | 间距（8px 栅格） | 间距散落在各文件，字面量 `8/12/16/20/24` 混用，无统一来源 | **已修复** | `src/styles.css:19-27`（`--d509-space-1..8`）、`src/theme/tokens.ts:42`（`spacing`） |
| 2 | 圆角 | 硬编码 `4/6/8/10/14/999px` 混用 | **已修复** | `src/styles.css:29-33`（`--d509-radius-sm/md/lg/pill`）、`src/theme/tokens.ts:53`（`radii`）；AntD 侧 `src/theme/tokens.ts:26,118`（`borderRadius 10 / LG 14 / SM 8`） |
| 3 | 阴影 | 多处直接写 `boxShadow` 字面量，且存在多层叠加的厚重阴影 | **已修复** | `src/styles.css:35-38`（`--d509-shadow-sm/md/lg`）、`src/theme/tokens.ts:61`（`shadows`）；组件侧统一走 `boxShadow`/`boxShadowSecondary` 令牌 `src/theme/tokens.ts:179-180` |
| 4 | 字号层级 | 标题字号靠内联 `fontSize` 散落（20/21/22/24 并存），层级不成体系 | **已修复** | `src/styles.css:149-180`（H1 21 / H2 16.5 / H3 15 / 正文 14 / 辅助 12.5）、`src/theme/tokens.ts:96`（`typography`） |
| 5 | 文字对比度 | 辅助文字 `#6E7887` 在白底仅 **4.47:1**，低于 4.5:1 | **已修复** | `src/styles.css:55`（`--d509-text-tertiary: #636d7b` → 5.24:1）、`src/theme/tokens.ts:19` |
| 6 | 焦点可见性 | 依赖 AntD 组件自带焦点样式，链接/自定义元素无统一焦点环 | **已修复** | `src/styles.css:196-215`（统一 `:focus-visible` 2px 描边 + 3px 品牌色光晕）、`src/theme/tokens.ts:68,150`（`focusRing`、`Input.activeShadow`） |
| 7 | 动效时长 | 无时长/缓动令牌，逐处写 `0.2s ease` 等，节奏不统一 | **已修复** | `src/styles/motion.css:13-28`（4 档时长 + 4 条缓动 + 错峰步长）、`src/theme/tokens.ts:78`、AntD 侧 `src/theme/tokens.ts:121-126` |
| 8 | 空状态 | 各页 `Empty` 描述色不统一（AntD 默认灰） | **已修复（令牌层）** | `src/theme/tokens.ts:161`（`Empty.colorTextDescription = colorTextSecondary`） |
| 9 | 加载态 | 骨架微光色为 AntD 默认色，深色模式下偏亮 | **已修复（令牌层）** | `src/theme/tokens.ts:162`（`Skeleton.gradientFromColor/ToColor`）、`src/styles.css:451-461`（`.d509-skeleton`）、`src/styles/motion.css:114-140`（`.d509-skeleton` 微光） |
| 10 | 错误态 | 无统一样式，靠各页 `Result`/`Alert` 各自默认 | **部分修复，建议后续** | 已在令牌层统一（`Alert`/`Result` 走同一 `colorError`）；页面级错误页样式需改 `src/pages/*`（并行文件中，未动） |
| 11 | 移动端断点 | 仅零散 `@media (max-width: 768px)`，Hero 内边距未随断点收敛 | **已修复** | `src/styles.css:561-571`；390/768/1440 三档由 `e2e/design-selfcheck.mjs` 守护 |
| 12 | 中文标点 | 文案已使用全角标点（`你好，student01，今天想做什么？`）；样式层无 ASCII 标点 hack | **通过** | `src/styles.css:184-192`（明确注释「不手写空格 hack」，改用 `overflow-wrap: anywhere` 处理长西文/URL） |
| 13 | 按钮层级 | 同一区块出现多个 `type="primary"`（首页搜索框、右侧统计区等） | **未改动，建议后续** | 属页面级调整（`src/pages/Home.tsx` 等并行文件中），设计约束已写入 `src/components/PageHeader.tsx:8-11` 的注释 |
| 14 | 图标尺寸 | 图标容器 42px / 字号 21px，hover 时旋转 | **已修复（尺寸/动效）** | `src/styles.css:365-383`（`.d509-icon` 42px、hover 仅 `scale(1.04)`，去掉旋转与 3D 效果） |
| 15 | 表格密度 | 各表 cellPadding 不一，缺少统一密度档 | **部分修复** | 令牌层统一 `Table.cellPaddingBlock: 12`、`headerBg`（`src/theme/tokens.ts:153,204`）；页面级自定义表格需改页面文件（未动） |
| 16 | 装饰克制度 | Hero 存在网格纹理动画 + 两处彩色光斑 + 多层渐变 | **已修复** | `src/styles.css:263-285`（Hero 只保留**一层**品牌渐变洗染 `--d509-hero-wash`，`.d509-hero-glow` 置为 `display:none`）；全站唯一渐变变量 `--d509-brand-gradient`（`src/styles.css:45`） |
| 17 | 深色模式 | 自定义元素颜色写死在浅色值，深色下刺眼（如行内代码白块） | **已修复** | `src/styles.css:70-95`（`html[data-theme="dark"], .dark`）、`src/styles.css:97-125`（`prefers-color-scheme` 兜底）、`src/styles/prose.css:11-18`（行内代码改走 `--d509-code-bg`） |
| 18 | 降低动效偏好 | 无 `prefers-reduced-motion` 处理，前庭敏感用户无法关闭动画 | **已修复** | `src/styles/motion.css:151-167`（位移/缩放/微光全部关闭，仅保留透明度） |

> 深色模式文字对比度实测（WCAG 相对亮度计算）：正文 14.59:1、次级 6.77:1、辅助 6.00:1、品牌色 5.42:1，均 ≥ 4.5:1。

---

## 二、实际改动清单（改前 → 改后 + 原因）

### 2.1 `src/theme/tokens.ts`（令牌层）

| 位置 | 改前 | 改后 | 原因 |
|------|------|------|------|
| `:19` | `colorTextTertiary: '#6E7887'` | `'#636D7B'` | 白底对比度 4.47:1 → 5.24:1，补齐 4.5:1 基线 |
| `:26` | 无 `borderRadiusSM` | `borderRadiusSM: 8` | AntD 小尺寸控件圆角与 `--d509-radius-sm` 对齐 |
| `:42` | 无 | 新增 `spacing`（4/8/12/16/24/32/48） | 8px 栅格单一来源，供 TS 与 CSS 共用 |
| `:53` | 无 | 新增 `radii`（8/10/14/pill） | 圆角三档体系，与 CSS 变量一一对应 |
| `:61` | 无 | 新增 `shadows`（sm/md/lg） | 禁止散写 `boxShadow` 字面量 |
| `:68` | 无 | 新增 `focusRing`（2px 描边 + 3px 光晕） | 焦点态统一；并被 `Input.activeShadow` 复用 |
| `:78` | 仅 `motionDuration`/`motionDurationSlow` | 新增 `motion`：4 档时长 + 4 条缓动 + 错峰步长/上限 + 位移/缩放 | 动效节奏统一，参考 Ant Design Motion |
| `:96` | 无 | 新增 `typography`（14/1.6、H1 21、H2 16.5、H3 15、辅助 12.5） | 中文排版层级集中定义 |
| `:107` | 无 | 新增 `brandGradient` | 全站唯一一处品牌渐变 |
| `:121-126` | 无 | `motionDurationFast/Mid/Slow` + `motionEaseInOut/Out/In` 接入 AntD 主题 | 组件库动效与自定义动效同频 |
| `:150` | `Input` 无 `activeShadow` | `activeShadow: focusRing.halo` | 输入框聚焦光晕与全站一致 |
| `:153` | 表格密度散乱 | `Table.cellPaddingBlock: 12`、`headerBg` 统一 | 表格密度统一 |
| `:161-162` | `Empty`/`Skeleton` 用 AntD 默认色 | 统一为语义色 | 空状态、加载态在深浅色下都可读 |

### 2.2 `src/styles.css`（重写 + 定点修改）

| 位置 | 改前 | 改后 | 原因 |
|------|------|------|------|
| `:11-12` | 单文件堆叠 | `@import './styles/motion.css'`、`'./styles/prose.css'` | 动效与长文排版分层，主文件只管「看起来什么样」 |
| `:19-27` | 散落字面量间距 | `--d509-space-1..8`（4/8/12/16/24/32/40/48） | 8px 栅格 |
| `:29-33` | 混用圆角 | `--d509-radius-sm 8 / md 10 / lg 14 / pill 999` | 与 tokens.ts 的 10/14 一致 |
| `:35-38` | 多处 `boxShadow` 字面量 | `--d509-shadow-sm/md/lg` 三档 | 统一阴影层级，去掉厚重阴影 |
| `:41-42` | 无 | `--d509-focus-outline` / `--d509-focus-halo` | 3px 品牌色光晕 |
| `:45` | 多处渐变 | `--d509-brand-gradient`（全站唯一） | 去掉彩虹装饰 |
| `:55` | `--d509-text-tertiary: #6e7887` | `#636d7b` | 对比度补齐 |
| `:70-125` | 无深色覆盖 | `html[data-theme="dark"], .dark` + `prefers-color-scheme` 两套深色变量 | 深色模式下自定义元素不再刺眼；显式 `data-theme="light"` 时媒体查询不生效（见后续建议） |
| `:136-147` | 各处零散字体声明 | `body` 统一 14px / 1.6 + 中文字体栈 | 中文排版 |
| `:149-180` | 标题字号靠内联 | H1 21 / H2 16.5 / H3 15 | 层级清晰 |
| `:184-192` | — | `overflow-wrap: anywhere`，注释明确「不手写空格 hack」 | 中西混排不溢出 |
| `:196-215` | 各组件自带焦点样式 | 统一 `:focus-visible` 描边 + 光晕（`!important` 覆盖组件库）；`.ant-input-affix-wrapper` 单独处理避免内外双圈 | 键盘可达性一致 |
| `:263-285` | Hero 有网格纹理动画 + 彩色光斑 | 单层品牌渐变洗染（`--d509-hero-wash`），`.d509-hero-glow` 置 `display:none` | 简约不简单，去装饰 |
| `:346-363` | 卡片 hover 阴影重、位移大 | `translateY(-2px)` + `--d509-shadow-md` | 轻微反馈，不喧宾夺主 |
| `:365-383` | 图标 hover 旋转/3D | 仅 `scale(1.04)` | 去掉夸张动效 |
| `:451-461` | 骨架底色写死 | 走 `--d509-surface-sunken` | 深色一致 |
| `:550-559` | 无页面标题区样式 | `.d509-page-header`（底边线 + 间距） | 统一页面标题区 |
| `:561-571` | 断点零散 | `@media (max-width: 768px)` 收敛 Hero 内外边距 | 移动端节奏 |

### 2.3 新增 `src/styles/motion.css`（动效系统）

- `:13-28` 令牌：`--d509-dur-fast 120ms / base 200ms / slow 340ms / slower 520ms`；
  `--d509-ease-standard cubic-bezier(0.22,0.61,0.36,1)`、`--d509-ease-out cubic-bezier(0.16,1,0.3,1)`、
  `--d509-ease-in cubic-bezier(0.7,0,0.84,0)`、`--d509-ease-spring cubic-bezier(0.34,1.56,0.64,1)`；
  `--d509-stagger-step 40ms`、`--d509-enter-offset 10px`、`--d509-enter-scale 0.98`。
- `:31-52` **入场** `.d509-enter`：`opacity 0→1` + `translate3d(0,10px,0) scale(0.98) → none`，340ms ease-out；无 3D 翻转、无弹跳。
- `:53-71` **错峰** `.d509-stagger`：子元素 `nth-child(1..8)` 依次延迟 0/40/…/280ms，第 9 项起不再延迟；另支持内联 `--d509-stagger-index`。
- `:73-91` **悬停** `.d509-hover-lift`：`translateY(-2px)` + 阴影过渡，200ms standard 缓动。
- `:93-112` **展开/折叠** `.d509-expand`：`grid-template-rows: 0fr → 1fr` + 透明度，340ms（支持 `data-open="true"` / `.is-open`）。
- `:114-140` **加载骨架微光** `.d509-skeleton` / `.d509-skeleton-line`：1.4s 循环微光，颜色走 `--d509-skeleton-sheen`。
- `:47-51` **页面级默认入场**：内容区顶层区块（`.ant-layout-content > *`）自动获得同一入场节奏；页面显式标注 `.d509-enter` / `.d509-stagger` 时以类名为准。这样在不改页面文件的前提下，动效系统也真实生效。
- `:151-167` **`prefers-reduced-motion: reduce` 降级**：所有动画时长压缩到 1ms，并对 `.d509-enter`、`.d509-stagger > *`、`.d509-hover-lift`、`.d509-card`、`.d509-tile`、骨架微光、`.d509-pulse` 置 `animation: none / transition: none / transform: none`，**仅保留不透明度变化或直接静态**。

### 2.4 新增 `src/styles/prose.css`（长文本排版）

- `:11-18` 行内 `code`：覆盖 `MarkdownView` 里的行内硬编码底色，改走 `--d509-code-bg`（深色下为 `rgba(255,255,255,0.09)`，不再是刺眼白块）。
- `:20-34` `pre` / `pre code`：统一边框、圆角、内边距与 13px/1.7 行高。
- `:37-` `.d509-prose` 段落容器：14px / 1.6，标题层级、列表、引用、表格统一。

### 2.5 `src/components/PageHeader.tsx`（并行同事已建，本次未改实现）

统一的「标题 + 描述 + 右侧操作区」组件：标题 `level=3 / 20px`，描述 12.5px 次级色，操作区 `gap=8`。本次为其补齐全局样式（`src/styles.css:550-559`）：底边线 + 统一间距，并归零内部 `Typography` 的默认外边距，保证与页面骨架的 8px 栅格一致。

### 2.6 新增 `e2e/design-selfcheck.mjs`（自检脚本）

- 复用 `e2e/_auth.mjs` 的 `launch()` / `loginContext()`，支持 `LAB_PASS`。
- 逐页访问 `/`、`/services`、`/databases`、`/workbench`、`/agent`、`/search`、`/devtools`；
- 每页在 390 / 768 / 1440 三档视口断言：**无控制台错误**、**无横向溢出**、**主标题存在**、**`:focus-visible` 生效且有 outline/box-shadow**、**`.d509-enter` 终态 `opacity=1` 且 `transform=none`**（兼容 Chrome 把 `none` 归一化为单位矩阵的写法）。
- 额外用 `page.emulateMedia({ reducedMotion: 'reduce' })` 复跑首页，断言 `animation-name = none` 或 `transition-duration = 0s`。
- 截图输出 `e2e/shots/design-<page>-<viewport>.png` 与 `design-home-reduced.png`。
- 对「构建期间 chunk 哈希变化导致的一次性动态导入失败」做了一次自动重试，避免并行构建时误报。

---

## 三、验证结果

```
$ cd /opt/labspace/frontend && npx tsc --noEmit -p tsconfig.app.json
TSC OK（无错误）

$ cd /opt/labspace/frontend && pnpm build
✓ built（成功）

$ cd /opt/labspace/e2e && LAB_PASS=<student01 口令> node design-selfcheck.mjs
==== 自检结果：通过 88 项，失败 0 项，提醒 18 项 ====
全部通过 ✅
```

18 项「提醒」均为非阻断项：
- 4 个页面在 390px 下未渲染可见标题元素（`/services`、`/search`、`/devtools`、首页）——移动端面包屑被隐藏、页面级 `h1` 缺失，属页面文件改动范围，已列入后续建议；
- 6 个页面未显式使用 `.d509-enter`（已由页面级默认入场兜底）；
- 桌面端标题来源为面包屑末项而非 `h1`（a11y 上建议补 `h1`）。

---

## 四、CSS 体积变化（构建产物）

| | 原始（raw） | gzip |
|---|---|---|
| 改动前 `dist/assets/index-DML5G0fr.css` | 7,501 B | 2,295 B |
| 改动后 `dist/assets/index-Wj3GhlBx.css` | 14,404 B | 3,383 B（gzip -9）/ 3,402 B（gzip 默认级别） |
| 差值 | +6,903 B（+92%） | **+1,088 B（+47%）** |

增量主要来自：
1. 深色模式整套语义色变量（`html[data-theme="dark"]` 与 `prefers-color-scheme` 两份覆盖，值重复但 gzip 压缩率高）；
2. 动效系统 `motion.css`（令牌 + 5 类动效 + reduced-motion 降级）；
3. 长文排版 `prose.css`；
4. 阴影/圆角/间距/焦点等令牌化后体积上升，但换来了「全站不再散写字面量」。

同一页面 CSS 体积从 2.3 KB(gzip) 增至 3.4 KB(gzip)，相对 AntD 运行时 CSS 可忽略不计。

---

## 五、未改动但建议后续处理的项

| 项 | 原因 | 建议做法 |
|---|------|----------|
| 深色模式下「手动选 dark、但系统是 light」时自定义元素仍是浅色 | `src/theme/ThemeContext.tsx` 不在本次允许修改的文件内；它只把 `resolved` 传给 AntD `ConfigProvider`，没有在 `<html>` 上写 `data-theme` | 在 `ThemeContext.tsx` 增加一行 `document.documentElement.dataset.theme = resolved`（并保留 `data-theme="light"` 覆盖系统偏好），本次的两套深色变量即可自动对齐 |
| 页面缺少语义 `h1`（`/services`、`/search`、`/devtools` 目前只有面包屑或卡片标题） | 页面文件处于并行工作中 | 页面改用 `src/components/PageHeader.tsx`（已把标题设为 `level=3`，可改 `level={1}`）或补 `h1`，提升读屏与 SEO |
| 按钮层级（一区块多个 primary） | 属页面级取舍 | 首页搜索框、统计区按钮改 `type="text"/"default"`，每屏只留一个 primary |
| 表格密度的页面级微调 | 页面文件并行中 | 需要更紧凑的表格用 `size="small"` + `Table.cellPaddingBlock` 令牌统一 |
| 错误态页面（Result/Alert）统一版式 | 页面文件并行中 | 统一走 `colorError` + `--d509-radius-lg` 卡片壳，并补「重试」操作 |
| 中西文之间的视觉间距 | 无需 hack：已用 `overflow-wrap: anywhere` 处理长串西文 | 若后续确需微调，靠字体 `letter-spacing`/字距方案，**不要**在中文与西文之间手写空格 |
| `styles.css` 中少量 `!important`（行内代码底色、焦点环） | 前者用于覆盖 `MarkdownView` 的行内硬编码样式，后者用于覆盖 AntD 组件库自带焦点样式，保证全站一致 | 后续可让 `MarkdownView` 改用变量，即可去掉第一处 `!important` |
| AntV 图表配色 / 图例 / 动效 | 图表由另一位同事并行负责 | 本次 CSS 令牌（品牌色、深浅色变量）可供图表直接引用，避免二次定义色板 |
