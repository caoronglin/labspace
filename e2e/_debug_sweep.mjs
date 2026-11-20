import { chromium } from 'playwright';

/**
 * 全局 Debug 巡检：逐条路由加载，记录 4xx/5xx、JS 异常、console error、超时。
 *
 * 用法：
 *   TOK=<session> CSRF=<csrf> node _debug_sweep.mjs            # 管理员会话
 *   TOK=... CSRF=... ROLE=student node _debug_sweep.mjs
 */
const BASE = process.env.BASE || 'http://198.51.100.71';
const TOK = process.env.TOK;
const CSRF = process.env.CSRF;
const ROLE = process.env.ROLE || 'admin';

const ROUTES = [
  '/', '/start', '/workbench', '/latex', '/agent', '/knowledge',
  '/files', '/seeds', '/shared', '/research', '/meetings',
  '/lab', '/databases', '/tools', '/drawings', '/colors',
  '/translate', '/literature', '/papers',
  '/commands', '/bioinfo', '/weather', '/network', '/help',
  '/snapotter', '/search', '/services/primer', '/embed/primer',
  '/admin/status', '/admin/users', '/admin/settings', '/admin/backups',
  '/admin/tasks', '/admin/shared',
];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'zh-CN' });
await ctx.addCookies([
  { name: 'labspace_session', value: TOK, domain: '198.51.100.71', path: '/' },
  { name: 'labspace_csrf', value: CSRF, domain: '198.51.100.71', path: '/' },
]);
const page = await ctx.newPage();

const problems = [];
const expected = [];
let current = '';

page.on('response', (r) => {
  const u = r.url();
  // 只关心**门户自己**的后端。
  // :8102 是生信实训平台的独立应用（跨域 iframe），它自己的 /api/v1/auth/me
  // 在未登录时返回 401 属正常（那个应用自己判断登录态），不该算门户的问题。
  // 门户真正的 API 在 BASE 上（无端口）或 8090。
  if (!u.startsWith(BASE)) return;
  const origin = new URL(u).origin;
  if (origin !== BASE) return;
  if (r.status() >= 400) {
    problems.push({ route: current, kind: `HTTP ${r.status()}`, url: u.replace(BASE, '').slice(0, 90) });
  }
});
page.on('pageerror', (e) => {
  problems.push({ route: current, kind: 'JS异常', url: String(e).split('\n')[0].slice(0, 140) });
});
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  // favicon 之类不算问题
  if (/favicon|ResizeObserver loop/i.test(t)) return;
  // 生信实训平台是**独立应用**（跨域 iframe），它自己的前端会调
  // :8102/api/v1/auth/me 判断登录态，未登录返回 401 属设计如此。
  // 浏览器仍会记成 console error —— 这不是门户的问题，单独归类。
  // Chrome 的 console 文本里**不含 URL**，要看 location 才知道是哪个请求
  const loc = m.location()?.url || '';
  if (/8102\/api\/v1\/auth\/me/.test(loc)) {
    expected.push({ route: current, url: `${loc} → ${t.slice(0, 60)}` });
    return;
  }
  problems.push({ route: current, kind: 'console.error', url: t.slice(0, 140) });
});
page.on('requestfailed', (r) => {
  const f = r.failure()?.errorText || '';
  if (/ERR_ABORTED/.test(f)) return;
  problems.push({ route: current, kind: '请求失败', url: `${r.url().replace(BASE, '').slice(0, 70)} ${f}` });
});

for (const r of ROUTES) {
  current = r;
  try {
    await page.goto(BASE + r, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2600);
    // 弹窗类遮罩会挡住内容，统一点掉
    await page
      .locator('.ant-modal button:has-text("开始使用"), .ant-modal button:has-text("知道了"), .ant-drawer button[aria-label="Close"]')
      .first()
      .click({ timeout: 1500 })
      .catch(() => {});
    await page.waitForTimeout(400);
    // 自检：确认真的渲染了内容，而不是被重定向到登录页 / 白屏
    const st = await page.evaluate(() => ({
      text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().length,
      url: location.pathname,
    }));
    if (st.url === '/login') {
      problems.push({ route: current, kind: '被重定向到登录页', url: '会话失效或路由守卫误拦' });
    } else if (st.text < 40) {
      problems.push({ route: current, kind: '页面近乎空白', url: `正文仅 ${st.text} 字符` });
    }
  } catch (e) {
    problems.push({ route: r, kind: '加载失败', url: String(e).split('\n')[0].slice(0, 120) });
  }
}

// 汇总
const byRoute = {};
for (const p of problems) {
  byRoute[p.route] = byRoute[p.route] || [];
  byRoute[p.route].push(p);
}
console.log(`\n===== 全局巡检（${ROLE}）=====`);
console.log(`路由 ${ROUTES.length} 条，问题 ${problems.length} 条`);
for (const [route, list] of Object.entries(byRoute)) {
  console.log(`\n▸ ${route}`);
  for (const p of list.slice(0, 6)) console.log(`   [${p.kind}] ${p.url}`);
}
if (!problems.length) console.log('✅ 零 4xx、零 JS 异常、零 console.error');
if (expected.length) {
  console.log(`\n（另有 ${expected.length} 条**已知预期**告警，未计入问题数）`);
  for (const e of expected.slice(0, 3)) console.log(`   · ${e.route}: ${e.url}`);
}
await browser.close();
