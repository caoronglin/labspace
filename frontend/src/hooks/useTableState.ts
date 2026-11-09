/**
 * 表格 / 列表的查询状态收敛到 URL
 *
 * 之前工作台的「搜索词 + 类型筛选」是组件内部 state：刷新丢失、无法分享、
 * 从命令面板跳回来也只能落在默认视图。放在 URL 上代价很小，收益是这三件事同时成立。
 *
 * - 只写非默认值，默认视图的地址保持干净；
 * - 用 replace 覆盖历史，避免每敲一个字就多一条浏览器后退记录。
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export type ParamMap = Record<string, string>;

export function useUrlState<T extends ParamMap>(defaults: T) {
  const [params, setParams] = useSearchParams();

  const value = useMemo(() => {
    const next: ParamMap = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const raw = params.get(key);
      if (raw !== null) next[key] = raw;
    }
    return next as T;
  }, [params, defaults]);

  const setValue = useCallback(
    (patch: Partial<T>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            const fallback = defaults[k as keyof T];
            if (v === undefined || v === null || v === '' || v === fallback) next.delete(k);
            else next.set(k, String(v));
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams, defaults],
  );

  const reset = useCallback(() => setParams(new URLSearchParams(), { replace: true }), [setParams]);

  return [value, setValue, reset] as const;
}
