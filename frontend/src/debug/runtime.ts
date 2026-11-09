/**
 * Global runtime probe: capture errors, failed requests and redacted app
 * state into a bounded in-memory ring buffer. Installed once at app startup.
 *
 * Redaction rules: never keep a URL's query string (it can carry tokens),
 * never keep headers/bodies/cookies, never keep a full stack trace from a
 * third-party script. Everything stays in this tab's memory.
 */
export interface DebugEvent {
  id: number;
  at: number;
  level: 'error' | 'warn' | 'info';
  source: 'window' | 'unhandledrejection' | 'fetch' | 'console' | 'panel';
  message: string;
  detail?: string;
}

const MAX_EVENTS = 200;
const events: DebugEvent[] = [];
let seq = 0;
let installed = false;

const redactUrl = (raw: string): string => {
  try {
    const u = new URL(raw, location.href);
    if (u.origin !== location.origin) return `${u.origin}/<cross-origin>`;
    return u.pathname;
  } catch {
    return '<unparseable-url>';
  }
};

const clean = (v: unknown, limit = 500): string => {
  let s: string;
  if (v instanceof Error) s = `${v.name}: ${v.message}`;
  else if (typeof v === 'string') s = v;
  else {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  }
  // Query strings and bearer-ish fragments are the two common leak channels.
  return s.replace(/([?&](?:token|key|secret|code|access_token|signature)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer <redacted>')
    .slice(0, limit);
};

export function record(level: DebugEvent['level'], source: DebugEvent['source'], message: unknown, detail?: unknown): void {
  events.push({
    id: ++seq,
    at: Date.now(),
    level, source,
    message: clean(message),
    ...(detail === undefined ? {} : { detail: clean(detail, 1000) }),
  });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function getEvents(): DebugEvent[] {
  return events.slice();
}

export function clearEvents(): void {
  events.length = 0;
}

export interface ClientSnapshot {
  at: number;
  url: string;
  userAgent: string;
  language: string;
  themeMode: string | null;
  resolvedTheme: 'dark' | 'light';
  viewport: { width: number; height: number; dpr: number };
  online: boolean;
  connection: { type?: string; downlink?: number; rtt?: number } | null;
  secureContext: boolean;
  perf: { navigationMs: number | null; domContentLoadedMs: number | null; resources: number } | null;
  memory: { usedMB: number | null; limitMB: number | null } | null;
  storage: {
    localKeys: string[];
    sessionKeys: string[];
    localBytesEstimate: number;
    reactQueryCacheKeys: string[];
  };
  featureFlags: Record<string, boolean>;
}

const has = (k: string) => typeof globalThis[k as keyof typeof globalThis] !== 'undefined';

/** Privacy mode / sandboxed iframes can throw on mere property access. */
function safeStorage(get: () => Storage | null): Storage | null {
  try { return get(); } catch { return null; }
}

function listStorage(store: Storage | null): { keys: string[]; bytes: number } {
  let keys: string[] = [];
  let bytes = 0;
  if (!store) return { keys, bytes };
  try {
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      if (k === null) continue;
      keys.push(k);
      bytes += k.length + (store.getItem(k)?.length ?? 0);
    }
  } catch { /* storage blocked (privacy mode) */ }
  return { keys: keys.slice(0, 50), bytes };
}

function perfSnapshot(): ClientSnapshot['perf'] {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType('resource').length;
    return {
      navigationMs: nav ? Math.round(nav.duration) : null,
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      resources,
    };
  } catch { return null; }
}

export function snapshot(): ClientSnapshot {
  const localStore = safeStorage(() => localStorage);
  const sessionStore = safeStorage(() => sessionStorage);
  const local = listStorage(localStore);
  const session = listStorage(sessionStore);
  const conn = (navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number; rtt?: number } }).connection;
  const perfMem = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  let reactQueryCacheKeys: string[] = [];
  try {
    const raw = localStore?.getItem('REACT_QUERY_OFFLINE_CACHE');
    if (raw) reactQueryCacheKeys = Object.keys(JSON.parse(raw)).slice(0, 20);
  } catch { /* not present / not JSON */ }
  return {
    at: Date.now(),
    url: redactUrl(location.href),
    userAgent: navigator.userAgent.slice(0, 200),
    language: navigator.language,
    themeMode: (() => { try { return localStore?.getItem('labspace.theme') ?? null; } catch { return null; } })(),
    resolvedTheme: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    online: navigator.onLine,
    connection: conn ? { type: conn.effectiveType, downlink: conn.downlink, rtt: conn.rtt } : null,
    secureContext: isSecureContext,
    perf: perfSnapshot(),
    memory: perfMem
      ? { usedMB: Math.round(perfMem.usedJSHeapSize / 1048576), limitMB: Math.round(perfMem.jsHeapSizeLimit / 1048576) }
      : null,
    storage: {
      localKeys: local.keys,
      sessionKeys: session.keys,
      localBytesEstimate: local.bytes,
      reactQueryCacheKeys,
    },
    featureFlags: {
      serviceWorker: 'serviceWorker' in navigator,
      webWorker: has('Worker'),
      streams: has('ReadableStream'),
      decompression: has('DecompressionStream'),
      clipboard: 'clipboard' in navigator,
      webCrypto: has('crypto') && 'subtle' in crypto,
      intersectionObserver: has('IntersectionObserver'),
      localStorage: localStore !== null,
      indexedDB: 'indexedDB' in globalThis,
    },
  };
}

/** Patch fetch once to record failed requests without keeping bodies/headers. */
export function install(): () => void {
  if (installed) return () => {};
  installed = true;

  const onError = (e: ErrorEvent) => {
    record('error', 'window', e.message || 'Script error', e.filename ? `${redactUrl(e.filename)}:${e.lineno}` : undefined);
  };
  const onReject = (e: PromiseRejectionEvent) => {
    record('error', 'unhandledrejection', e.reason, '未处理的 Promise 拒绝');
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onReject);

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    try {
      const res = await originalFetch(input, init);
      if (!res.ok) record('warn', 'fetch', `${method} ${redactUrl(url)} → ${res.status}`, res.statusText);
      return res;
    } catch (err) {
      record('error', 'fetch', `${method} ${redactUrl(url)} 失败`, err);
      throw err;
    }
  };

  record('info', 'panel', '全局 Debug 探针已装载');
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onReject);
    window.fetch = originalFetch;
    installed = false;
  };
}

export const counts = () => ({
  total: events.length,
  errors: events.filter((e) => e.level === 'error').length,
  warns: events.filter((e) => e.level === 'warn').length,
});
