/**
 * 带持久化的 useState
 *
 * 侧栏折叠、主题之类的偏好散落在各个组件里各自 try/catch 读写 localStorage，
 * 值不可解析时会静默失败并把界面重置。这里统一成一份实现：
 * - 初值反序列化失败直接退回 defaultValue；
 * - 写入失败（隐私模式 / 配额满）不抛错，界面照常；
 * - 多标签页同步通过 storage 事件回灌。
 */
import { useCallback, useEffect, useState } from 'react';

export function useLocalStorage<T>(key: string, defaultValue: T) {
  const read = useCallback((): T => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return defaultValue;
      return JSON.parse(raw) as T;
    } catch {
      return defaultValue;
    }
  }, [key, defaultValue]);

  const [value, setValue] = useState<T>(read);

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 隐私模式 / 配额满：只影响持久化，不影响当前会话 */
    }
  }, [key, value]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      setValue(e.newValue === null ? defaultValue : (JSON.parse(e.newValue) as T));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key, defaultValue]);

  return [value, setValue] as const;
}

export default useLocalStorage;
