/**
 * 导航命令：把注册表里的页面变成命令面板可执行的动作
 *
 * 页面文案与跳转行为集中在这里，UI 只负责渲染，
 * 以后要加「按角色过滤 / 最近使用抬升」也只需改这一处。
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRecentPaths } from '../hooks/useRecent';
import { commandableNavItems, matchNav, type NavItem } from './navigation';

export interface NavCommand {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  score: number;
  run: () => void;
}

export function useNavCommands({
  query,
  isAdmin,
  isTeacher = false,
}: {
  query: string;
  isAdmin: boolean;
  isTeacher?: boolean;
}) {
  const navigate = useNavigate();
  const { paths: recentPaths, touch } = useRecentPaths();

  const items = useMemo(() => commandableNavItems(isAdmin, isTeacher), [isAdmin, isTeacher]);

  const commands = useMemo<NavCommand[]>(() => {
    const recentRank = new Map(recentPaths.map((p, i) => [p, recentPaths.length - i]));
    const q = query.trim();
    return items
      .map<NavCommand>((it: NavItem) => {
        // 空输入时不列全部页面，只抬出最近访问的几条，避免面板一打开就是 20 条噪音；
        // 有输入时按命中分数排，页面命中整体高于语料命中。
        const recentBoost = !q && recentRank.has(it.path) ? 50 + recentRank.get(it.path)! * 2 : 0;
        const score = q ? matchNav(it, q) : recentBoost;
        return {
          id: `nav:${it.path}`,
          label: it.label,
          hint: it.hint ?? it.path,
          icon: it.icon,
          score,
          run: () => {
            touch(it.path);
            navigate(it.path);
          },
        };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);
  }, [items, query, recentPaths, navigate, touch]);

  return { commands, touch };
}
