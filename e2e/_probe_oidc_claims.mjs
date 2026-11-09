import { chromium } from 'playwright';

const BASE = 'http://192.0.2.10:8102';
const [username, password] = process.argv.slice(2);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();

await page.goto(`${BASE}/api/v1/auth/login`, { waitUntil: 'domcontentloaded' });
await page.waitForURL(u => u.href.includes('/login'), { timeout: 15000 });
await page.fill('#username', username);
await page.fill('#password', password);
await page.click('button:has-text("登录")');
await page.waitForURL(u => !u.href.includes('/login'), { timeout: 30000 });

const ui = await page.evaluate(async () => {
  const r = await fetch('/api/v1/auth/me', { credentials: 'include' });
  return { status: r.status, body: await r.text() };
});
console.log(`${username} ->`, ui.status, ui.body.slice(0, 400));
await browser.close();
