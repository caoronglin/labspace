// 绘图工作台 UI 冒烟：注入管理员会话，验证页面渲染、提交任务、配色搭配带色跳转
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const token = fs.readFileSync('/tmp/lab_admin_token.txt', 'utf8').trim();
const csrf = 'plotcheck123';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
const host = new URL(BASE).hostname;
await ctx.addCookies([
  { name: 'labspace_session', value: token, domain: host, path: '/' },
  { name: 'labspace_csrf', value: csrf, domain: host, path: '/' },
]);
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));

await page.goto(`${BASE}/plot`, { waitUntil: 'domcontentloaded' });
await page.getByRole('heading', { name: '绘图工作台' }).first().waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);
const startBtn = page.getByRole('button', { name: '开始使用' });
if (await startBtn.isVisible().catch(() => false)) await startBtn.click();
await page.waitForTimeout(1000);
console.log('title-ok');
await page.screenshot({ path: '/opt/labspace/e2e/_plot_ui_initial.png', fullPage: true });
const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
console.log('body', body.slice(0, 600));
console.log('selects', await page.locator('.ant-select').count(), 'prompts', await page.locator('[class*="prompts"]').count());
console.log('chart-count', await page.locator('.ant-select').first().innerText({ timeout: 3000 }).catch(() => 'n/a'));
console.log('sample-chips', await page.getByText('处理组生长量').count());

await page.getByRole('button', { name: '渲染并保存' }).click();
await page.waitForTimeout(1200);
await page.getByRole('tab', { name: '服务端成品' }).click();
await page.getByText('已完成').first().waitFor({ timeout: 90000 });
const img = page.locator('img[src*="/v1/plot/"]').first();
await img.waitFor({ timeout: 30000 });
const src = await img.getAttribute('src');
const desc = await page.locator('.ant-descriptions').innerText().catch(() => '');
console.log('job-src', src);
console.log('job-desc', desc.replace(/\s+/g, ' ').slice(0, 200));
await page.screenshot({ path: '/opt/labspace/e2e/_plot_ui_output.png', fullPage: true });

// 配色搭配 → 绘图工作台带色跳转
await page.goto(`${BASE}/colors`, { waitUntil: 'domcontentloaded' });
await page.getByRole('heading', { name: /配色/ }).first().waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);
if (await startBtn.isVisible().catch(() => false)) await startBtn.click();
await page.waitForTimeout(1200);
const handoff = page.getByRole('button', { name: '在绘图中使用' }).first();
await handoff.waitFor({ timeout: 15000 });
await handoff.click();
await page.waitForURL(/\/plot\?colors=/, { timeout: 15000 });
await page.waitForTimeout(2000);
const url = page.url();
const tag = await page.getByText('来自配色搭配').first().count();
console.log('handoff-url', decodeURIComponent(url));
console.log('handoff-tag', tag);
console.log('console-errors', JSON.stringify(errors));
await browser.close();