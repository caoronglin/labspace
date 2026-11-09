// 复现生信平台终端会话创建 500，并打印响应体
import { chromium } from '/opt/labspace/e2e/node_modules/playwright/index.mjs';

const BASE = 'http://192.0.2.10:8102';
const PASS = process.env.LAB_PASS || '';
const USER = process.env.LAB_USER || 'student01';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(`${BASE}/api/v1/auth/login?redirect=/`, { waitUntil: 'domcontentloaded' });
await page.waitForURL(/192\.168\.5\.12:8090/, { timeout: 20000 });
await page.fill('#username', USER);
await page.fill('#password', PASS);
await Promise.all([
  page.waitForURL(/8102/, { timeout: 30000 }),
  page.getByRole('button', { name: /登录|Log in|Login/i }).first().click(),
]);
await page.waitForLoadState('networkidle').catch(() => {});

const csrf = await page.evaluate(async () => {
  const r = await fetch('/api/v1/auth/csrf', { credentials: 'include' });
  return r.json();
});
console.log('csrf:', JSON.stringify(csrf));

const res = await page.evaluate(async (token) => {
  const r = await fetch('/api/v1/terminal/sessions', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    body: JSON.stringify({}),
  });
  const text = await r.text();
  return { status: r.status, body: text.slice(0, 1500) };
}, csrf?.csrfToken ?? csrf?.token ?? '');
console.log('POST /api/v1/terminal/sessions →', res.status);
console.log(res.body);
await browser.close();
