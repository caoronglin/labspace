# D509 工作台 · 界面设计规范（可落地版）

> 适用栈：React 19 + TypeScript + Ant Design 6.6.x（仓库：`/opt/labspace/frontend`，现有 token：`src/theme/tokens.ts`，全局样式：`src/styles.css`）
> 依据来源见文末「来源与抓取状态」。本报告只做研究与写作，未修改任何仓库文件。

## 0. 来源与抓取状态

| # | 参考 | 抓取结果 | 采用的内容 |
| --- | --- | --- | --- |
| 1 | landing.ant.design/index-cn | 成功（SPA 壳 + `index.js` 3.0MB 中文案抽取） | 区块化首页模板结构、文案语气（「产品标语介绍」「涉及数据，请自行替换。」）、区块出场栅格 |
| 2 | motion.ant.design/index-cn | 成功（`index.js` 2.8MB） | 三条动效原则、动效参数页签结构 |
| 3 | github.com/utooland/utoo | 成功，但**与题设不符**：该仓库是「统一前端工具链」（Rust 包管理器 `utoo` + Turbopack 打包器 `@utoo/pack` + WASM 版 `@utoo/web`），**不是组件库**，无组件源码/样式规范 | 仅取其 demo UI 样式取向（`examples/utooweb-demo/src/styles.css`、`demo_raw/src/index.css`：8px 滚动条、200ms 过渡、0.5rem 圆角、CSS 变量化明暗主题）作为「自主可控」的旁证 |
| 4 | antv.antgroup.com | 成功（`/llms.txt` + 各页 `.md` 原文） | 设计价值观（信任感/轻松感/意义感）、6 类色板、图表选型与条数上限、Dashboard 三型、响应式与迷你图 |
| 5 | kitchen.alipay.com | **部分失败**：只拿到 SPA 外壳 + umi 运行时（567KB bundle，无可抽取的中文正文），组件清单为客户端渲染 | 页面骨架模式改由 Ant Design 官方组件文档 + 本仓库现状推导（已在 E 节标注来源） |
| 6 | ant.design/theme-editor-cn | 成功（页面为 SPA；token 字段取自 `antd@6.6.8` 的 `es/theme/interface/{seeds,alias}.d.ts`、`maps/{colors,font,size,style}.d.ts`；语义分组取自 `antd-token-previewer` 的 `TOKEN_SORTS`） | 完整 token 字段、语义分组、v6 新增 seed |

AntD 6 相对 5 的三个新 seed（务必在 B 节采纳）：`motion: boolean`（全局关动画）、`focusOutline: boolean`、`wireframe: boolean`。

---

## A. 设计理念落点（4 条可执行准则）

| 准则 | 做到什么 | 避免什么 | 在代码里怎么体现 |
| --- | --- | --- | --- |
| **简约** Simplify | 一屏一个主任务；同层只保留一个视觉重心；文案用「动词 + 对象」，标题 ≤ 12 字 | 多色主色、装饰性渐变堆叠、同屏 > 1 个 primary 按钮、无信息量的图标 | `tokens.ts` 只保留 1 个 `colorPrimary` + 1 个 accent；`QuickActions` 6 个装饰色收敛为 2；按钮层级见 F-05；文案统一「暂无 X」/「X 加载失败」 |
| **美观** Beautify | 用留白、发丝边框、字重建立层次；节奏对齐 8px 栅格；动效短促 | 厚重阴影、彩虹配色、动画炫技（Ant Motion 三原则：自然规律 / 节省时间 / 有意义） | `boxShadow` 仅两级且极淡；`borderRadius` 8/10/12；`styles.css` 全量用 `--d509-ease`；禁止 > 340ms 动画 |
| **好用** Usable | 状态齐全（空/加载/错误/无权限）；就近操作；键盘可达；信息可下钻 | 假数据填充、静默失败、必须 hover 才发现的入口、点了没反馈 | 每处数据区必须实现三态（Empty/Skeleton/Result）；`message/notification` 反馈写操作结果；`Result` 承担 404/403/500；图标 ≥ 14px 且有 Tooltip |
| **自主** Autonomous | Token 单一来源、组件自封装、主题 light/dark/auto 免二次 CSS | 页面里写死颜色/字号、同一语义多处定义、引入第二套 UI 库 | 业务页面禁止硬编码 hex（`grep -n "#2B5CE6" src/pages` 应为 0）；统一走 `theme.useToken()`；新增可视化用 AntV 而非新图表库 |

---

## B. Token 清单（`theme.useToken()`）

图例：`[默认]` = AntD 6.6.8 默认值；`[现状]` = 本仓库 `src/theme/tokens.ts` 现值；`[建议]` = 本规范建议值（需改 `tokens.ts`）。
派生色值由 `theme.getDesignToken({ token: { colorPrimary: '#2B5CE6' } })` 实测得到（与 AntD 官网主题编辑器同一算法）。

### B1 品牌色（seed 与派生）

| Token | 中文 / English | 建议值 | 来源 |
| --- | --- | --- | --- |
| `colorPrimary` | 品牌主色 Brand Color | `#2B5CE6` | [现状] 保留 |
| `colorPrimaryHover` / `colorPrimaryTextHover` | 主色悬停 / 主色文字悬停 | `#5584F2` | [派生实测] |
| `colorPrimaryActive` / `colorPrimaryTextActive` | 主色按下 | `#1B41BF` | [派生实测] |
| `colorPrimaryBg` / `colorPrimaryBgHover` | 主色浅底 / 浅底悬停 | `#F0F6FF` / `#D4E5FF` | [派生实测] |
| `colorPrimaryBorder` / `colorPrimaryBorderHover` | 主色描边 | `#ABCAFF` | [派生实测] |
| `colorLink` / `colorLinkHover` / `colorLinkActive` | 链接色 | `#2B5CE6` / `#5584F2` / `#1B41BF` | [建议] 显式跟随主色（AntD 默认是 `#1677FF`，不跟 seed 会掉色） |
| `colorInfo` | 信息色 Info Color | `#2B5CE6`（等同主色） | [现状] |
| accent（科研/数据点缀） | 辅助强调色 | `#12A594` | [现状] 仅存为 CSS 变量 `--d509-accent`，**不进语义 token**，避免污染「信息色」语义 |

### B2 中性色 / 容器与背景

| Token | 中文 / English | 建议值 | 来源 |
| --- | --- | --- | --- |
| `colorBgLayout` | 布局背景 Layout Background | `#F6F7F9` | [现状] |
| `colorBgContainer` | 容器背景 Container Background | `#FFFFFF` | [现状] |
| `colorBgElevated` | 浮层背景 Elevated | `#FFFFFF` | [现状] |
| `colorBgTextHover` / `colorBgTextActive` | 文字底悬停/激活 | `rgba(20,26,34,.06)` / `rgba(20,26,34,.15)` | [建议] 显式 |
| `colorFill` / `colorFillSecondary` / `colorFillTertiary` / `colorFillQuaternary` | 填充（强→弱） | `rgba(20,26,34,.15)` / `.06` / `.04` / `.02` | [现状] 强度递增保持 AntD 语义 |
| `colorBgMask` | 遮罩 | `rgba(0,0,0,.45)` | [默认] |

### B3 语义色（成功 / 警告 / 错误 / 信息）

| Token | 中文 | 建议值 | 来源 |
| --- | --- | --- | --- |
| `colorSuccess` / `colorSuccessBg` / `colorSuccessBorder` | 成功 / 成功底 / 成功描边 | `#16A34A` / `#EAF7EE` / `#7BC990` | [现状] 主色；底色建议由实测 `#D3E3D6` 调淡为 `#EAF7EE`（AntD 派生偏灰绿） |
| `colorWarning` / `colorWarningBg` / `colorWarningBorder` | 警告 | `#D97706` / `#FFF7E6` / `#F5C46B` | [现状] + [建议] 描边 |
| `colorError` / `colorErrorBg` / `colorErrorBorder` | 错误 | `#DC2626` / `#FFF2F0` / `#FFAFA6` | [现状] + [派生实测] |
| `colorInfo` / `colorInfoBg` / `colorInfoBorder` | 信息 | `#2B5CE6` / `#F0F6FF` / `#ABCAFF` | 同主色阶 |

### B4 文本层级

| Token | 中文 | 建议值 | 来源 |
| --- | --- | --- | --- |
| `colorText` | 主文本 | `#141A22` | [现状] |
| `colorTextSecondary` | 次级文本 | `#5B6675` | [现状] |
| `colorTextTertiary` | 三级文本 | `#97A3B4` | [建议] 显式（AntD 默认 `rgba(0,0,0,.45)`，暗色下不匹配） |
| `colorTextQuaternary` | 四级文本 | `#B9C2CE` | [建议] |
| `colorTextPlaceholder` / `colorTextDisabled` | 占位 / 禁用 | `#A6B0BD` / `#C3CAD4` | [建议] |
| `colorTextDescription` | 描述文本 | `#5B6675` | [建议]（= secondary） |
| `colorTextHeading` | 标题文本 | `#0B1017` | [建议] |
| `colorTextLabel` | 表单标签 | `#3D4757` | [建议] |
| `colorIcon` / `colorIconHover` | 图标色 | `#7A869A` / `#141A22` | [建议] |

### B5 边框与分割 / 圆角

| Token | 中文 | 建议值 | 来源 |
| --- | --- | --- | --- |
| `colorBorder` | 描边 | `#E6E9EF` | [现状] |
| `colorBorderSecondary` | 次级描边 | `#EEF0F4` | [现状] |
| `colorSplit` | 分割线 | `rgba(20,26,34,.06)` | [建议] 显式 |
| `lineWidth` / `lineWidthBold` | 线宽 / 粗线 | `1` / `2` | [默认] |
| `borderRadius` | 基础圆角 | `8`（现状 10 → 建议收 2px 提密度） | [建议] |
| `borderRadiusSM` / `borderRadiusLG` / `borderRadiusXS` / `borderRadiusOuter` | 小/大/极小/外圆角 | `6` / `12`（现状 14）/ `4` / `4` | [建议] |

### B6 间距 / 字号行高

| Token | 中文 | 建议值 | 来源 |
| --- | --- | --- | --- |
| `padding`/`paddingXS`/`paddingSM`/`paddingMD`/`paddingLG`/`paddingXL` | 间距梯度 | `16 / 8 / 12 / 20 / 24 / 32` | [默认]（门户 8px 栅格兼容） |
| `margin`…`marginXXL` | 外边距梯度 | `16 / 8 / 12 / 20 / 24 / 32 / 48` | [默认] |
| `paddingContentHorizontal` / `paddingContentVertical` | 内容内边距 | `24 / 16` | [建议] |
| `sizeUnit` / `sizeStep` | 尺寸单位 / 步长 | `4 / 4`（紧凑模式用 `theme.compactAlgorithm` → step 2） | [默认] |
| `fontSize` / `fontSizeSM` / `fontSizeLG` / `fontSizeXL` | 字号 | `14 / 12 / 16 / 20` | [现状]/[默认] |
| `fontSizeHeading1…5` | 标题字号 | `38 / 30 / 24 / 20 / 16` | [默认] AntD 6 已是新版标题梯度（v5 为 38/30/24/20/16 同值，但行高更松） |
| `lineHeight` / `lineHeightSM` / `lineHeightLG` | 行高 | `1.5714 / 1.6667 / 1.5` | [默认] |
| `fontWeightStrong` | 强调字重 | `600` | [默认] |
| `fontFamily` | 字体族 | `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', Arial, sans-serif` | [建议] 与 `styles.css` body 对齐（AntD 默认带 Roboto，中文会落到 fallback） |

### B7 阴影 / 动效 / 布局

| Token | 中文 | 建议值 | 来源 |
| --- | --- | --- | --- |
| `boxShadow` | 一级阴影 | `0 1px 2px rgba(16,24,40,.05)` | [现状] |
| `boxShadowSecondary` | 二级阴影 | `0 8px 24px rgba(16,24,40,.10)` | [现状] |
| `boxShadowTertiary` | 三级阴影 | `0 1px 2px rgba(16,24,40,.04)` | [建议] 显式，覆盖 AntD 默认三层叠加 |
| `motionDurationFast/Mid/Slow` | 动效时长 | `0.1s / 0.2s / 0.3s`（现状 Slow `0.34s` → 建议 `0.3s`） | [默认]/[建议] |
| `motionEaseOut` / `motionEaseInOut` / `motionEaseInOutCirc` | 缓动 | `cubic-bezier(0.215,0.61,0.355,1)` / `cubic-bezier(0.645,0.045,0.355,1)` / `cubic-bezier(0.78,0.14,0.15,0.86)` | [默认]；门户 `--d509-ease` 改用 `motionEaseOut` 同值 |
| `motionUnit` / `motionBase` / `motion` | 动效单位 / 基准 / 总开关 | `0.1` / `0` / `true` | [默认] v6 新增 `motion:false` 可一键关 |
| `controlHeight` / `controlHeightSM` / `controlHeightLG` | 控件高 | `34 / 26 / 40` | [现状]/[建议] |
| `Layout.headerHeight` / `Menu.collapsedWidth` / `Layout.bodyPadding` | 头部高 / 收起宽 / 内容内边距 | `60 / 68 / 24`（移动端 16） | [现状] |
| `screenXS…screenXXXL` | 断点 | `480 / 576 / 768 / 992 / 1200 / 1600 / 1920` | [默认] |
| `zIndexBase` / `zIndexPopupBase` | 层级 | `0 / 1000` | [默认] |

**落码示例（`src/theme/tokens.ts` 增量）**

```ts
export const baseToken = {
  ...,
  colorLink: tokens.colorPrimary,
  colorTextTertiary: '#97A3B4',
  colorTextQuaternary: '#B9C2CE',
  colorTextPlaceholder: '#A6B0BD',
  colorTextDisabled: '#C3CAD4',
  colorTextDescription: tokens.colorTextSecondary,
  colorTextHeading: '#0B1017',
  colorTextLabel: '#3D4757',
  colorIcon: '#7A869A', colorIconHover: tokens.colorText,
  colorSplit: 'rgba(20,26,34,0.06)',
  borderRadius: 8, borderRadiusSM: 6, borderRadiusLG: 12, borderRadiusXS: 4,
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', Arial, sans-serif",
  boxShadowTertiary: '0 1px 2px rgba(16,24,40,0.04)',
  motionDurationMid: '0.2s', motionDurationSlow: '0.3s',
  motionEaseOut: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
  motion: true, focusOutline: true,
};
```

---

## C. 动效规范

Ant Motion 三原则（官网「动效原则」）：**自然运动规律，保证视觉连贯** / **尽量节省过渡时间，快速完成过渡** / **做有意义的动效，不做太多修饰而干扰用户**。AntV 补充「区块出场栅格」：同区块元素同进同出，按 45° 斜栅格错峰。

### C1 五类动效参数表

| 类型 | 时长 | 缓动 | 位移 | 透明度 | 适用 |
| --- | --- | --- | --- | --- | --- |
| 进入（页面/卡片） | 240ms（AntD `motionDurationMid` 200ms，卡片入场可用 240） | `cubic-bezier(0.215,0.61,0.355,1)`（motionEaseOut） | `translateY(10px) → 0` | `0 → 1` | 路由切换、区块首屏；同组错峰 40ms/项，最多 8 项 |
| 离开 | 160ms | `cubic-bezier(0.645,0.045,0.355,1)`（motionEaseInOut） | `0 → translateY(-6px)` | `1 → 0` | 抽屉关闭、列表删除、路由离开（慎用，避免闪烁） |
| 悬停 | 120ms（颜色/边框）/ 200ms（位移+阴影） | `ease-out` | `translateY(-2px)`（磁贴）/ `-3px`（卡片） | 不变 | 卡片、磁贴、表格行高亮（行高亮只改底色，不位移） |
| 展开 | 240ms；折叠 200ms | `cubic-bezier(0.78,0.14,0.15,0.86)`（motionEaseInOutCirc） | `height/opacity`（0 → 内容高） | `0 → 1` | Collapse、树节点、详情段 |
| 加载 | 骨架 shimmer 1.4s `linear infinite`；Spin 旋转 0.9s `linear infinite`；数字滚动 600ms easeOutCubic | `linear` / `cubic-bezier(0.215,0.61,0.355,1)` | 背景位移 0→100% | 固定 | 列表骨架、局部加载、指标计数 |

### C2 变量表（可直接贴进 `src/styles.css`）

```css
:root{
  --d509-dur-fast:120ms; --d509-dur-base:200ms; --d509-dur-slow:240ms; --d509-dur-enter:240ms; --d509-dur-leave:160ms;
  --d509-ease-out:cubic-bezier(0.215,0.61,0.355,1);
  --d509-ease-in-out:cubic-bezier(0.645,0.045,0.355,1);
  --d509-ease-circ:cubic-bezier(0.78,0.14,0.15,0.86);
  --d509-ease:cubic-bezier(0.215,0.61,0.355,1);
  --d509-enter-y:10px; --d509-leave-y:-6px; --d509-hover-y:-2px;
}
.d509-enter{animation:d509-rise var(--d509-dur-enter) var(--d509-ease) both}
@keyframes d509-rise{from{opacity:0;transform:translate3d(0,var(--d509-enter-y),0)}to{opacity:1;transform:none}}
.d509-stagger>*{animation:d509-rise var(--d509-dur-enter) var(--d509-ease) both}
.d509-stagger>*:nth-child(n){animation-delay:calc(var(--i,0)*40ms)}
```

### C3 `prefers-reduced-motion` 降级

```css
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}
  .d509-enter,.d509-stagger>*{animation:none !important;opacity:1 !important;transform:none !important}
  .d509-card:hover,.d509-tile:hover{transform:none}
  .d509-pulse,.d509-hero::before,.d509-hero-glow{animation:none !important}
}
```

- 保留「状态变化」类反馈（颜色、边框），去掉「位移/缩放/循环」类装饰（现状 `styles.css` 末尾已有该 media 块，需补 `.d509-enter` 透明度兜底）。
- AntD 侧：v6 seed `motion: false` 可全局关组件动画；门户仅在 `ThemeContext` 里按 `prefers-reduced-motion` 动态切换该 seed 即可，不用维护第二套 CSS。

---

## D. 图表规范（基于 AntV / @ant-design/plots）

来源：AntV《设计价值观》（信任感 / 轻松感 / 意义感）、《统计图表 Chart》、《色板》、《通用 Dashboard》、《响应式》。

### D1 推荐图表类型

| 图表 | 适用场景 | 数据字段 | 门户落点 |
| --- | --- | --- | --- |
| 折线图 Line | 随时间变化的趋势（用量、访问量、任务完成曲线） | x：时间（连续）/ y：数值（连续） | 工作台「近 30 天活跃度」、文档解析量 |
| 柱状图 Column | 分类对比；分类数 ≤ 20，多组 ≤ 10 | x：分类（文本）/ y：数值 | 服务分类分布、各工具使用排行 |
| 条形图 Bar | 名称长、需要横向排布、排名/占比语义 | 同上（横向） | 命令速查 Top N、数据库访问量 Top N |
| 迷你图 Sparkline/MiniBar | 空间有限的卡片内，只表示态势 | 单序列数值 | 服务卡片右上角迷你趋势（替代数字） |
| 进度/仪表 Bullet | 单值 vs 目标（完成率、存储配额） | value + target | 工作台任务完成率、资源配额 |
| 散点图 Scatter | 两个连续量的相关性（实验参数 vs 指标） | x、y 连续 | 分析页（若后续引入实验数据） |
| 环形/饼 Donut | 占比；分类 ≤ 9，超出合并「其它」 | 维度 + 度量 | 资源构成；**慎用**（≤ 4 类优先用条形图） |

### D2 配色（与 seed 色板一致）

- 分类色板原则（AntV）：色相分布均衡、相邻色明暗有差异；人眼可辨色数控制在 5–7。
- 门户分类色（首色 = seed 主色）：`#2B5CE6` `#12A594` `#D97706` `#7C3AED` `#0891B2` `#DB2777`；超过 6 类合并「其它」用中性灰 `#97A3B4`。
- 顺序色板（同一色相明度渐变）：`#EAF0FF → #2B5CE6` 区间取 5 级，用于热力/密度。
- 强调色板：重点项用高饱和主色 `#2B5CE6`，其余降饱和到 `#9BB0D9`/`#B8C4D8`，用于「自家 vs 其余」对比。
- 语义色板：成功 `#16A34A`、警告 `#D97706`、错误 `#DC2626`，只表达状态，不当分类色。
- 实现：`src/theme/chart.ts` 导出 `chartPalette`（含 `categorical/sequential/emphasis/semantic`），图表统一 `scale.color.range` 引用，不在页面里写 hex。

### D3 三态处理

| 态 | 图表区 | 表格区 |
| --- | --- | --- |
| 空 | `Empty` 图形 + 「暂无 X 数据」+ 一个主行动（如「去配置数据源」） | `Empty` + 「清除筛选」 |
| 加载 | 固定高度容器 + 骨架（`Skeleton`/`Spin` 置于容器中央，保留坐标轴占位） | `Skeleton` 保持列高，避免跳动 |
| 异常 | `Alert type="error"` + 「重试」按钮，图表区降级为静态文字摘要 | `Result status="error"` 或行内错误提示 |

### D4 取舍原则（不要用图表装饰无意义数据）

1. 一图一问：写不出「这张图回答什么」，就不画。
2. 分类不超过阈值（饼 ≤ 9、柱 ≤ 20），超出合并「其它」。
3. 不做 3D、双 Y 轴、渐变填充背景、雷达图装饰；面积渐变仅用于强调趋势。
4. 先对比再单值：任何单值指标尽量配基线（上周/目标/均值）。
5. 数据不全不做趋势（缺测点用断线而非插值平滑）。
6. 响应式：< 992px 图表降级为 Mini（省轴、省图例），交互细节放进 Tooltip。

---

## E. 页面骨架（5+1 种可复用模式）

> 骨架来源：Ant Design 组件文档 + AntV Dashboard 三型（指标大盘 / 多维分析 / 数据明细）+ 本仓库现状（`pages/`）推导；kitchen.alipay.com 正文未抓到，未引用其私有组件清单。

| 模式 | 区块顺序 | 组件清单 |
| --- | --- | --- |
| **① 仪表盘**（首页 / 工作台） | Hero 概览 → 关键指标条 → 快捷入口 → 图表区（2×2）→ 明细表 → 最近访问 | `Layout` + `Card`(borderless) + `Statistic`/`Flex` 指标 + `Tag` 状态 + `Segmented` 时间范围 + `@ant-design/plots` + `Table` + `List` |
| **② 列表页 + 详情**（全部服务 / 统一搜索） | 标题行（含计数）→ 搜索 + 筛选 → 视图切换 → 结果网格/表格 → 分页 → 详情（抽屉或独立页） | `Input.Search` + `Tabs`/`Segmented` + `Select` + `Row/Col` + `Card`/`Table` + `Pagination` + `Drawer`/`Descriptions` + `Empty`/`Skeleton` |
| **③ 文件浏览器**（文件工坊 / 我的图形） | 工具栏（新建/上传/搜索）→ 面包屑路径 → 视图切换（网格/列表）+ 排序 → 文件卡片/行 → 批量操作条 → 转换/编辑对话框 | `Breadcrumb` + `Segmented` + `Upload` + `Card`/`List` + `Checkbox` + `Dropdown` + `Modal` + `Progress` |
| **④ 对话框工作流**（命令面板 / 绘图 / 翻译） | 触发入口 → 标题+说明 → 主输入区 → 参数区（可折叠）→ 执行/取消 → 结果区 + 导出 | `Modal`/`Drawer` + `Input.TextArea` + `Form` + `Collapse` + `Steps` + `Spin` + `Result` + `Typography`（`copy` 按钮） |
| **⑤ 空状态 / 错误页** | 图形（404/403/500/无数据）→ 原因说明（一句话）→ 主行动 → 次行动 → 反馈入口 | `Result` + `Button` + `Alert`(错误摘要) + `Empty` + `Input.Search` + `Typography.Text copyable` |
| **⑥ 登录页** | 品牌区（Logo + 名称 + 一句定位）→ SSO 主按钮 → 状态说明（跳转中）→ 兜底链接 | `Flex` 居中 + `Card`(宽 380) + `Spin` + `Button type="primary"` + `Typography` |

---

## F. 组件改造清单（16 条，含现状与改法）

| # | 组件 | 现状问题（基于现有代码） | 改法 |
| --- | --- | --- | --- |
| 1 | Card | `ServiceCard` 用 `className="lab-service-card"`，但 `styles.css` 里只有 `.d509-card`（`styles.css:249`），首页/数据库卡片**没有悬停动效**；`styles={{ body: { padding: 18 } }}` 硬编码 | 统一改用 `.d509-card`；padding 走 `Card` token（`paddingLG:20`）；首页/数据库/详情三处同一写法 |
| 2 | Card 阴影 | 门户阴影极淡（`0 1px 2px`），但浮层/Modal 仍用 AntD 默认三层阴影 | `tokens.ts` 显式给 `boxShadow/boxShadowSecondary/boxShadowTertiary`（见 B7），组件级一律 `variant="borderless"` + 描边 |
| 3 | Table | 仅 `Weather/Admin/AgentAdmin` 三处用 Table，未定规范；`tokens.ts` 已设 `cellPaddingBlock:12`、表头 `#FAFBFC` | 定标准：`size="small"`（行高 40）、表头背景去掉改用字重 600 + 底分割线、**不做斑马纹**（靠留白）、超过 8 列时横向滚动 + 首列固定、每列 `ellipsis` |
| 4 | Tag | 全站混用 `color="blue/cyan/green/gold"`（`Weather.tsx:125-130`、`Agent.tsx:727`），与品牌色不一致；多处 `style={{fontSize:11}}` 覆盖 | 语义化：分类 → 默认灰底；状态 → `success/warning/error`；品牌强调 → 主色浅底；删掉所有 inline `fontSize`（统一 `fontSizeSM`） |
| 5 | 按钮层级 | `type="primary"` 出现在卡片、操作条、对话框多处 | 规则：一屏/一区块最多 1 个 primary；工具栏用 `text`/`icon`；危险操作用 `danger` + `Popconfirm`；次要动作用 `default` |
| 6 | Segmented | `tokens.ts` 已配 `Segmented` token，但代码里未用于任何视图切换 | 用于「网格/列表」「今日/本周/本月」「卡片/表格」等互斥视图，替代部分 `Tabs`（分类多时仍用 `Tabs`） |
| 7 | 空状态文案 | `Services.tsx` 空态只有「没有匹配的服务」，无引导 | 规范：「一句话说明 + 一个主行动」。例：暂无数据 / 「清除筛选」；首次使用 / 「添加第一个服务」 |
| 8 | 加载态 | `Services.tsx` 用居中 `Spin` 撑 60px 白屏，跳动明显 | 改 `Skeleton`（与卡片同尺寸），首屏用 Skeleton、局部刷新用 `Spin` 遮罩 |
| 9 | 图标尺寸 | `ServiceCard` 图标块 42px/字号 21，`QuickActions` 34px/16，行内图标 14 混用 | 规范：卡片图标块 40/图标 20；磁贴 32/16；行内 14；全部用 `@ant-design/icons`，不放彩色底 |
| 10 | 状态/健康态 | `ServiceCard.tsx` 硬编码 `#16A34A/#DC2626/#94A3B8` + inline 小圆点 | 改 `Badge status="success|error|default"` + token 色；`styles.css` 的 `.d509-dot-*` 与 Tag 语义统一 |
| 11 | 颜色收敛 | `HomeStats` 4 个硬编码 accent（`#2B5CE6/#16A34A/#12A594/#D97706`）、`QuickActions` 6 个装饰色（`#7C3AED/#EA580C/#0891B2/#DB2777`） | 指标数字用 `colorPrimary`/语义色（成功=绿、强调=accent）；快捷入口统一主色图标 + 淡底，只保留 1 个 accent |
| 12 | 网格与留白 | `Services.tsx` `gutter={[16,16]}`，列断点 `xs24/sm12/lg8/xxl6`（缺 md） | 补 `md={8}`；统一 `gap=16`（2×8 栅格）；卡片高度用 `Flex` 拉伸对齐 |
| 13 | 动效时长 | `styles.css` 卡片 transition `0.22s`、stagger `0.4s` 与 token（0.2/0.24）不一致 | 全部改用 C2 变量（`--d509-dur-*`），单卡悬停 200ms，入场 240ms、错峰 40ms |
| 14 | 错误页 | `ErrorBoundary.tsx` 用 `Result` + `Alert` 展示错误摘要，但无法复制 | `Typography.Text code copyable` + 「报告问题」按钮（预填环境信息）；403 场景独立 `Result status="403"` |
| 15 | 404 页 | `NotFound.tsx` 只有「返回首页」 | 增加 `Input.Search`（站内搜索）+ 常用入口 3 项（工作台/全部服务/我的收藏） |
| 16 | 搜索与高亮 | `Services` 与 `SearchPage` 两套搜索；高亮样式在 `styles.css` 硬编码 `rgba(250,173,20,.28)` | 统一走命令面板（`⌘K`）入口 + 搜索结果页；高亮底色用 token 化 CSS 变量 `--d509-hit-bg`（建议 `#FFF1C2`） |

---

## G. 落地清单（3 天，按收益/成本排序）

| 阶段 | 任务 | 涉及文件 | 验收方式 |
| --- | --- | --- | --- |
| **Day 1（高收益 / 低成本）** | ① token 补全与统一（B 节增量）；② 颜色收敛（去硬编码）；③ 三态统一（Empty/Skeleton/Result）；④ 动效变量化 + reduced-motion 兜底 | `src/theme/tokens.ts`、`src/styles.css`、`src/components/ServiceCard.tsx`、`src/components/HomeStats.tsx`、`src/components/QuickActions.tsx`、`src/pages/Services.tsx`、`src/components/ErrorBoundary.tsx`、`src/pages/NotFound.tsx`、`src/theme/ThemeContext.tsx` | `npm run build` 通过；`grep -rn "#[0-9A-Fa-f]\{6\}" src/pages src/components` 仅剩 token 文件与图表色板；`grep -c "d509-enter" styles.css` 命中 reduced-motion 块；页面目视无布局跳动 |
| **Day 2（中收益 / 中成本）** | ① F 表 1–6、9–12、15 落地（Card/Table/Tag/按钮/Segmented/图标/网格/搜索）；② 页面骨架统一：列表页+详情、文件浏览器、空/错误页、登录页四套骨架抽成模板组件 | `src/components/ServiceCard.tsx`、`src/pages/{Services,Workbench,Weather,Admin,Databases,Drawings,SnapOtter,SearchPage}.tsx`、`src/components/QuickActions.tsx`、`src/app/AppLayout.tsx` | 逐页 checklist：每页有标题/计数/筛选/三态/主次按钮；键盘 Tab 可达主要操作；暗色模式截图与亮色对比无低对比文本 |
| **Day 3（新增能力 / 中成本）** | ① 引入 `@ant-design/plots`，落地 D1 的折线/柱/条/迷你/进度 5 类图 + D2 色板文件 + D3 三态；② 图表页面走「指标大盘」骨架 | 新增 `src/theme/chart.ts`、`src/components/charts/{TrendPanel,CategoryRank,SparklineCell,QuotaBar}.tsx`、改造 `src/pages/Workbench.tsx`、`src/pages/Home.tsx` | 每个图表组件有「空/加载/异常」三个用例截图；分类数 ≤ 9、柱状 ≤ 20 的自动检查（写单测断言）；`prefers-reduced-motion` 下无循环动画（DevTools 验证） |

**风险与回滚**：三阶段均只改 `src/`，不动 `src/services/api.ts` 与后端契约；每阶段独立提交，回滚只需 `git revert`；Day 3 图表库体积较大，可先以 `@ant-design/plots` 的 Tree-shaking 子包（`@ant-design/plots` + `@antv/g2`）引入并观察打包体积，超限则回退到 SVG 手绘迷你图。

---

## 附：关键引用

- AntD 6 token 字段与分组：`antd@6.6.8/es/theme/interface/{seeds,alias}.d.ts`、`maps/{colors,font,size,style}.d.ts`；主题编辑器语义分组 `antd-token-previewer/src/utils/classifyToken.ts`（`TOKEN_SORTS`：seed / colorCommon / colorText / colorBg / colorFill / colorSplit / font / radius / space / screen / line / motion / control / others）。
- AntD 6 新增 seed：`motion`、`focusOutline`、`wireframe`（`seeds.d.ts`）。
- 派生色实测：`theme.getDesignToken({ token: { colorPrimary: '#2B5CE6' } })` → hover `#5584F2`、active `#1B41BF`、bg `#F0F6FF`、bgHover `#D4E5FF`、border `#ABCAFF`。
- 动效三原则（motion.ant.design 首页「动效原则」）与区块出场栅格；AntV 响应式「经典布局 → 拆解构成 → 信息优先级 → 约束 → 策略 → 规则」六步。
- AntV 图表约束：折线「两个连续字段」；柱状「分类 ≤ 20、组 ≤ 10」；饼图「区块 ≤ 9，超出合并其它」；Dashboard 三型与「Overview First, Zoom and Filter, Then Details-on-Demand」。
- utoo 仓库定位：`crates/pm`（包管理器）+ `packages/pack`（Turbopack 打包器）+ `packages/utoo-web`（WASM 版），**非组件库**；其 demo 的 CSS 变量化明暗主题与 8px 滚动条可作旁证。
