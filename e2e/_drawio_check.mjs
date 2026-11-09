import { chromium } from 'playwright';
import fs from 'node:fs';
const token = fs.readFileSync('/tmp/lab_admin_token.txt', 'utf8').trim();
const csrf = 'drawiocheck123';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
await ctx.addCookies([
  { name: 'labspace_session', value: token, domain: '192.0.2.10', path: '/' },
  { name: 'labspace_csrf', value: csrf, domain: '192.0.2.10', path: '/' },
]);
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://192.0.2.10/drawio', { waitUntil: 'networkidle' });
const start = page.getByRole('button', { name: '开始使用' });
if (await start.isVisible().catch(() => false)) await start.click();
await page.waitForTimeout(800);
console.log('title', await page.locator('.d509-page-header h1, .d509-page-header h2, .d509-page-shell h1').first().textContent().catch(() => 'none'));
console.log('desc', (await page.locator('.d509-page-shell').first().innerText()).replace(/\s+/g,' ').slice(0, 180));
console.log('templates', await page.getByRole('button', { name: /RNA-seq Pipeline/ }).count());
console.log('errors', errors);
await page.screenshot({ path: '_drawio_check.png', fullPage: false });
await browser.close();
