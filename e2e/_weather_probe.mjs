// 天气页加载诊断：等待真实数据渲染，记录失败请求
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const usersFile = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8');
const line = usersFile.split('\n').find((l) => l.startsWith('labadmin@local '));
if (!line) throw new Error('测试账号未找到');
const [user, pass] = line.trim().split(/\s+/);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3000);

const failed = [];
page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

await page.goto(`${BASE}/weather`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.ant-skeleton', { state: 'detached', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1200);
const state = await page.evaluate(() => ({
  skeleton: document.querySelectorAll('.ant-skeleton').length,
  alert: [...document.querySelectorAll('.ant-alert')].map((e) => e.textContent?.trim().slice(0, 160)),
  temperature: [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && /\d+\s*°/.test(e.textContent || '')).slice(0, 6).map((e) => e.textContent?.trim()),
  city: [...document.querySelectorAll('h1,h2,h3,h4,.ant-typography')].slice(0, 8).map((e) => e.textContent?.trim()).filter(Boolean),
}));
await page.screenshot({ path: '/opt/labspace/e2e/shots/subpages/1440_weather_live.png', fullPage: false });
console.log(JSON.stringify({ state, failed }, null, 1));
await browser.close();