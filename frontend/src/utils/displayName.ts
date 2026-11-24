/**
 * 显示名解析：把账号 id / 用户名显示成**姓名**。
 *
 * 为什么需要它
 * ------------
 * 门户里很多地方存的是账号 id（OIDC sub）或账号库的用户名，但界面上要给
 * 人看姓名（"陈同学" 而不是 "adminlegacy"）。这些字段分散在文件共享、知识库、
 * 工作台指派三处，如果各自写一套回退逻辑，很快就会漂移成"有的地方显示姓名、
 * 有的地方显示邮箱"。
 *
 * 规则（全局统一）
 * ----------------
 *   1. 有姓名 → 显示姓名；
 *   2. 没有姓名但有用户名 → 显示 "姓名未设置（username）"；
 *   3. 什么都没有 → 显示 "未知成员"。
 * 任何情况下都不直接显示邮箱全串 —— 邮箱不是给人名用的。
 */
import { useQuery } from '@tanstack/react-query';

import { api, type PeopleEntry } from '../services/api';

export type PeopleMap = Map<string, PeopleEntry>;

const EMPTY: PeopleMap = new Map();

/** 拉取人员目录并建索引（按 id 与用户名各建一条）。 */
export function usePeopleMap() {
  const { data } = useQuery({
    queryKey: ['people'],
    queryFn: api.people,
    staleTime: 5 * 60_000,
  });
  const people = data?.people ?? [];
  if (!people.length) return EMPTY;
  const map: PeopleMap = new Map();
  for (const p of people) {
    if (p.id) map.set(p.id, p);
    if (p.name) map.set(p.name, p);
  }
  return map;
}

/**
 * 把一个身份标识解析成显示名。
 *
 * @param identity 账号 id 或用户名（可能为空）
 * @param map       usePeopleMap() 的结果
 * @param fallback  目录里查不到时的兜底文本（例如已知的 displayName 字段）
 */
export function resolveDisplayName(
  identity: string | undefined | null,
  map: PeopleMap,
  fallback?: string | null,
): string {
  const key = (identity ?? '').trim();
  const hit = key ? map.get(key) : undefined;
  if (hit?.displayName) return hit.displayName;
  // 目录里有这个人但没设姓名：显示用户名并说明没设姓名，别让人以为是系统故障。
  if (hit?.name) return `姓名未设置（${hit.name}）`;
  const fb = (fallback ?? '').trim();
  if (fb) {
    // fallback 多半是 ownerName / creator_name，本身已经是姓名。
    return fb.includes('@') ? fb.split('@')[0] : fb;
  }
  if (key) return key.includes('@') ? key.split('@')[0] : key;
  return '未知成员';
}
