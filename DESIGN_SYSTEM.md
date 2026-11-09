# DESIGN_SYSTEM.md — LabSpace 设计系统

Ant Design 6 原生组件 + 统一 Token，未引入 Pro / shadcn / MUI / Tailwind。

## 1. 颜色

| 用途 | 值 |
| --- | --- |
| Primary | `#2563EB` |
| Secondary Accent | `#0D9488` |
| 页面背景 | `#F6F8FB` |
| 主容器 | `#FFFFFF` |
| 主文字 | `#1F2937` |
| 次级文字 | `#64748B` |
| 边框 | `#E5EAF1` |
| Success / Warning / Error | `#16A34A` / `#D97706` / `#DC2626` |

服务卡片不使用高饱和底色，仅图标底色 `rgba(37,99,235,.1)` + 主色图标，保持克制。

## 2. Token（`frontend/src/theme/tokens.ts`）

```ts
colorPrimary: '#2563EB'      borderRadius: 8        fontSize: 14
colorBgLayout: '#F6F8FB'     controlHeight: 34      motionDurationMid: '0.18s'
colorBgContainer: '#FFFFFF'  colorText: '#1F2937'
colorTextSecondary: '#64748B' colorBorderSecondary: '#E5EAF1'
```

布局常量：Header 64px、Sider 224px（收起 72px）、内容间距 24px、卡片圆角 12px。

## 3. 主题

`ThemeProvider` 使用 Ant Design 的 `defaultAlgorithm` / `darkAlgorithm`，不维护两套 CSS；
模式 `light | dark | auto`（auto 跟随 `prefers-color-scheme`）持久化在 `localStorage.labspace.theme`。
深色下 Layout 背景 `#0F172A`、容器 `#111C33`、边框 `#1E293B`。

## 4. 组件约定

- 图标统一来自 `@ant-design/icons`（服务卡片用统一图标，不为每个服务做彩色卡片）。
- 服务卡片：图标 + 名称 + 两行简介 + 分类/状态 Tag + 收藏按钮；点击整卡跳转详情。
- 状态只在真实健康检查可用时显示（正常/不可用/未知三态），失败只影响该卡片。
- 空数据用 `Empty`，加载用 `Spin`，不使用假数据填充。
- 动画 150–200ms；`prefers-reduced-motion` 下禁用卡片位移（`styles.css`）。

## 5. 布局

- Header：折叠按钮 · Logo+名称 · 面包屑 · 全局搜索 · 主题切换 · 通知 · 用户菜单（个人资料/我的文件/我的知识库/账户设置/退出）。
- Sider 分组：工作台 / 科研工作 / 学习资源 / 实用工具 / 系统管理（仅管理员可见，前端隐藏 + 后端二次校验）。
- 移动端（<lg）：Sider 改 Drawer，内容区 16px 间距，实测无横向溢出（overflow=0px）。
