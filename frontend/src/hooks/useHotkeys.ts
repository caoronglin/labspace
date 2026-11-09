/**
 * 全局快捷键注册
 *
 * 之前 ⌘K 是直接在 AppLayout 里手写 keydown；再多一个快捷键就得复制一遍。
 * 这里把「解析按键 + 忽略输入框内触发 + 卸载移除」收敛掉。
 */
import { useEffect, useRef } from 'react';

export interface Hotkey {
  /** 形如 'mod+k'、'shift+/'、'escape'；mod = macOS 的 ⌘ / 其他平台 Ctrl */
  combo: string;
  handler: () => void;
  /** 输入框聚焦时是否仍触发（默认 false） */
  whenTyping?: boolean;
}

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return EDITABLE.has(el.tagName) || el.isContentEditable === true;
}

function matches(e: KeyboardEvent, combo: string) {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  const mod = parts.includes('mod');
  const shift = parts.includes('shift');
  const alt = parts.includes('alt');
  const expectsMod = mod ? e.metaKey || e.ctrlKey : !e.metaKey && !e.ctrlKey;
  if (!expectsMod) return false;
  if (shift !== e.shiftKey) return false;
  if (alt !== e.altKey) return false;
  return e.key.toLowerCase() === key;
}

export function useHotkeys(hotkeys: Hotkey[]) {
  const latest = useRef(hotkeys);
  latest.current = hotkeys;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const hk of latest.current) {
        if (!hk.whenTyping && isTyping(e.target)) continue;
        if (matches(e, hk.combo)) {
          e.preventDefault();
          hk.handler();
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export default useHotkeys;
