/**
 * 防抖值
 *
 * 用于「输入即查询」的场景：搜索框每敲一下就改 URL 并发请求，
 * 既刷屏后端也让结果列表抖动。这里只延迟「值」，输入本身保持即时。
 */
import { useEffect, useState } from 'react';

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export default useDebounced;
