import { useCallback, useEffect, useMemo, useState } from 'react';
import { Tour } from 'antd';
import type { TourProps } from 'antd';
import { useLocation } from 'react-router-dom';

import { useAuth } from '../app/AuthContext';
import { markTourSeen, tourSeen, TOUR_EVENT } from './onboardingState';

/**
 * 互动式新手引导：用 antd 6 自带的 `Tour` 逐步高亮**真实控件**。
 *
 * 为什么从原来的「静态四宫格 Modal」换成 Tour
 * --------------------------------------------
 * 旧引导（HelpOnboarding 的 onboard 分支）是一张静态卡片，讲的是
 * 「这个平台有身份/文件/工具/帮助四块」。看完用户仍然不知道
 * 「左侧那个菜单是什么」「⌘K 能干什么」「快捷入口在哪」。
 * Tour 直接把真实控件圈出来，答案就在他要去点的地方。
 *
 * antd 6.7.0 自带 Tour（底层 @rc-component/tour 已在依赖树里），**零新依赖**。
 *
 * 触发与「重看」
 * --------------
 * - 首次进入工作台：延迟 1.5s 自动弹一次，按账号记在 localStorage。
 * - 随时重看：帮助中心按钮 / 头像菜单 / 命令面板都通过
 *   `window.dispatchEvent(new Event('d509:tour'))` 触发；重看是显式动作，
 *   不该被「已看过」标记拦住。
 */

/**
 * 按选择器找元素；找不到就返回 null。
 *
 * rc-tour 的 target 类型是 `HTMLElement | (() => HTMLElement) | null | (() => null)`，
 * 不接受「返回 HTMLElement | null 的函数」。所以这里用**元素本身**而不是函数：
 * 元素不存在时传 null，该步自动降级为居中说明（不报错、不空指针）。
 * steps 依赖 mounted 状态重算，保证子组件（首页快捷入口）挂载后能重新解析。
 */
function findTarget(selector: string): HTMLElement | null {
  try {
    return document.querySelector<HTMLElement>(selector);
  } catch {
    return null;
  }
}

export default function OnboardingTour() {
  const { me } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  // 子页面（首页快捷入口）比 AppLayout 晚挂载，steps 里的 target 要在挂载后重算
  const [mounted, setMounted] = useState(false);
  const account = me?.id || me?.email || '';

  useEffect(() => {
    setMounted(true);
  }, [location.pathname, mounted]);

  // 显式重看：清掉标记并打开。
  const replay = useCallback(() => {
    markTourSeen(account);
    setOpen(true);
  }, [account]);

  useEffect(() => {
    if (!me?.authenticated || !account) return;
    // 端到端测试账号不弹引导：Playwright 每次都是全新上下文，
    // 引导层会把「点得到的东西」全挡住，用例只能超时。
    if (me?.e2e) return;  // 见 api.ts 的 Me.e2e
    // 首次：延迟弹一次。已看过就不再打扰。
    if (tourSeen(account)) return;
    const t = setTimeout(() => {
      if (!tourSeen(account)) setOpen(true);
    }, 1500);
    return () => clearTimeout(t);
  }, [me?.authenticated, account]);

  useEffect(() => {
    const onEvent = () => replay();
    window.addEventListener(TOUR_EVENT, onEvent);
    return () => window.removeEventListener(TOUR_EVENT, onEvent);
  }, [replay]);

  const steps = useMemo<TourProps['steps']>(() => {
    const onHome = location.pathname === '/';
    return [
      {
        title: '欢迎使用 D509 工作台',
        description:
          '这里统一了实验室的文件、课题资料、种子台账、文献、绘图与 AI 助手。' +
          '一分钟看完这几个入口，之后就不用到处找了。',
        // 第 0 步不锚定控件，作为总览居中展示
        target: null,
      },
      {
        title: '左侧是所有功能的入口',
        description:
          '分「工作」「科研」「系统」三组。课题资料与组会汇报按角色/授权显示；' +
          '流程图、绘图工作台、公共基因组在「分析与写作」子菜单里，收起后鼠标移上去也能展开。',
        target: findTarget('[data-tour="sider"]'),
      },
      {
        title: '顶栏搜索直达',
        description:
          '搜服务、命令、植物库、资料，不用在菜单里逐层找。' +
          '按 ⌘K（Windows 是 Ctrl+K）还能打开命令面板，所有页面都是一条命令。',
        target: findTarget('[data-tour="search"]'),
      },
      {
        title: '命令面板：所有页面都是命令',
        description: '不用记住菜单层级，打几个字直接跳过去。',
        target: findTarget('[data-tour="cmdk"]'),
      },
      {
        title: '快捷入口 = 每天真会用的',
        description:
          '首页这一排是助手、文件、文献、PDF 工具箱等高频入口。' +
          '常用服务不再重复出现，低频入口收在左侧子菜单里。',
        // 快捷入口只在首页存在；不在首页时这一步降级为居中说明
        target: onHome ? findTarget('[data-tour="quick"]') : null,
      },
      {
        title: '结果可以接着用，不用下载再上传',
        description:
          '文献结果点「AI 解读」、种子台账点「让 Agent 分析」；' +
          '文件里的 PDF 可一键进 PDF 工具箱；工作台待办能直接跳回文件位置。',
        target: null,
      },
      {
        title: '有任何疑问都在帮助中心',
        description:
          '快速上手、按角色推荐入口、服务地图、常见问题都在这里；' +
          '完整说明见 docs/USER_GUIDE.md。本引导随时可从这里或头像菜单重看。',
        target: findTarget('[data-tour="help"]'),
      },
    ];
  }, [location.pathname, mounted]);

  if (!me?.authenticated || !account) return null;

  return (
    <Tour
      open={open}
      onClose={() => {
        setOpen(false);
        markTourSeen(account);
      }}
      onFinish={() => {
        setOpen(false);
        markTourSeen(account);
      }}
      steps={steps}
      closable
    />
  );
}
