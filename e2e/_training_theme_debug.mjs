import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = 'http://192.0.2.10';
const line = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local '));
const [user, pass] = line.trim().split(/\s+/);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
page.on('console', (m) => console.log('CONSOLE', m.type(), m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3000);

await page.evaluate(() => {
  localStorage.setItem('labspace.theme', 'dark');
  localStorage.setItem('labspace.primary', '#D4380D');
});
await page.goto(`${BASE}/bioinfo`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

console.log('PARENT_THEME', await page.evaluate(() => document.documentElement.getAttribute('data-theme')));
const frame = page.frames().find((f) => f.url().includes(':8102'));
console.log('FRAME', frame?.url());

// 手动观察消息是否能到达平台窗口
await frame.evaluate(() => {
  window.__msgs = [];
  window.addEventListener('message', (e) => window.__msgs.push(e.data));
});
await page.evaluate(() => {
  const iframe = document.querySelector('iframe[src*="8102"]');
  iframe?.contentWindow?.postMessage({ type: 'labspace:theme', mode: 'dark', primary: '#D4380D' }, 'http://192.0.2.10:8102');
});
await page.waitForTimeout(1500);
console.log('MSG_LOG', JSON.stringify(await frame.evaluate(() => window.__msgs)));
console.log('FRAME_THEME', await frame.evaluate(() => ({
  theme: document.documentElement.getAttribute('data-theme'),
  bg: getComputedStyle(document.body).backgroundColor,
  vars: getComputedStyle(document.documentElement).getPropertyValue('--bio-bg'),
})));

await page.screenshot({ path: '/opt/labspace/e2e/shots/training_debug.png' });
await browser.close();