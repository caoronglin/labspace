// #48 性能优化回归：懒加载调试面板 + 分包后页面无报错
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(5000);
const body = await page.evaluate(() => document.body.innerText);
if (!/工作台|全部服务|我的收藏/.test(body)) throw new Error('login failed: ' + page.url());
await page.locator('.ant-modal-close').first().click({ timeout: 2000 }).catch(() => {});

const loaded = [];
page.on('request', (r) => { if (/\/assets\/.*\.js$/.test(r.url())) loaded.push(r.url().split('/').pop()); });

for (const path of ['/', '/colors', '/aikit', '/admin']) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const text = await page.evaluate(() => document.body.innerText);
  if (text.trim().length < 20) errors.push(`${path}: blank page`);
}

const debugJs = loaded.filter((f) => f.includes('GlobalDebugPanel'));
if (!debugJs.length) errors.push('debug panel chunk not requested for admin');

const perf = await page.evaluate(() => {
  const rs = performance.getEntriesByType('resource');
  return {
    transfer: Math.round(rs.reduce((a, r) => a + (r.transferSize || 0), 0) / 1024),
    chunks: rs.filter((r) => /\/assets\/.*\.js$/.test(r.name)).length,
  };
});

await browser.close();
if (errors.length) {
  console.log('FAIL 48:', errors.join(' | '));
  process.exit(1);
}
console.log(`PASS 48: lazy debug chunk loaded, 4 pages render, no console errors (last page transfer ${perf.transfer} KB, ${perf.chunks} js)`);