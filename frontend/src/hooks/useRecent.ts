/**
 * 访问足迹（本地记一份）
 *
 * 服务访问记录原本只落在后端 /api/recent，导航命令面板要给「最近去过」排序时
 * 又得再排一次；本地这份是给命令面板做排序权重的，纯前端偏好，不同步服务端。
 */
import { useCallback } from 'react';
import { useLocalStorage } from './useLocalStorage';

const KEY = 'd509:recent-paths';
const MAX = 12;

export function useRecentPaths() {
  const [paths, setPaths] = useLocalStorage<string[]>(KEY, []);

  const touch = useCallback(
    (path: string) => {
      if (!path) return;
      setPaths((prev) => [path, ...prev.filter((p) => p !== path)].slice(0, MAX));
    },
    [setPaths],
  );

  const clear = useCallback(() => setPaths([]), [setPaths]);

  return { paths, touch, clear };
}

export default useRecentPaths;
