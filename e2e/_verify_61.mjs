import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const failures = [];
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(5000);
await page.locator('.ant-modal-close').first().click({ timeout: 2000 }).catch(() => {});

await page.goto(`${BASE}/commands`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
// 选一个命令，加载详情 Markdown
const item = page.locator('div[style*="cursor: pointer"]').first();
ok((await item.count()) > 0, '/commands command list empty');
if (await item.count()) {
  await item.click();
  await page.waitForSelector('.d509-md', { timeout: 15000 }).catch(() => {});
}
const md = page.locator('.d509-md').first();
ok((await md.count()) > 0, '/commands did not render .d509-md');
if (await md.count()) {
  const stats = await md.evaluate((el) => ({
    headings: el.querySelectorAll('h1,h2,h3,h4').length,
    paras: el.querySelectorAll('p').length,
    codes: el.querySelectorAll('pre,code').length,
    text: (el.textContent || '').trim().length,
  }));
  ok(stats.text > 20, `rendered markdown too short: ${JSON.stringify(stats)}`);
  ok(stats.headings + stats.paras > 0, `no block elements: ${JSON.stringify(stats)}`);
  await md.screenshot({ path: '/opt/labspace/e2e/shots/md-commands.png' });
}

// 工作台：页面应正常加载（无渲染错误）
await page.goto(`${BASE}/workbench`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
ok(/工作台|课题|任务/.test(await page.evaluate(() => document.body.innerText)), '/workbench blank');
await page.screenshot({ path: '/opt/labspace/e2e/shots/md-workbench.png' });

await browser.close();
ok(errors.length === 0, `console errors: ${errors.slice(0, 3).join(' | ')}`);
if (failures.length) {
  console.log('FAIL 61:', failures.join(' | '));
  process.exit(1);
}
console.log('PASS 61: XMarkdown renders /commands, workbench loads, no console errors');