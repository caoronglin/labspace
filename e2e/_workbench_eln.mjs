import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
let failures = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures += 1;
}

const line = fs
  .readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('labadmin@local'));
const password = line.trim().split(/\s+/)[1];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => {
  if (r.url().includes('/api/labops') && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
});

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill('labadmin');
await page.locator('input[type="password"]').first().fill(password);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(4000);

async function dismissWelcome() {
  const welcome = page.locator('.ant-modal').filter({ hasText: '欢迎使用 D509 工作台' }).first();
  if (await welcome.isVisible().catch(() => false)) {
    await welcome.getByRole('button', { name: /开始使用/ }).click();
    await page.waitForTimeout(600);
  }
}
await dismissWelcome();

// 旧链接 /lab?tab=eln 应跳转到个人工作台的实验记录页签
await page.goto(`${BASE}/lab?tab=eln`, { waitUntil: 'domcontentloaded' });
await dismissWelcome();
await page.waitForTimeout(1500);
ok('旧入口重定向', /\/workbench\?tab=records/.test(page.url()), page.url());

const recordsTab = page.getByRole('tab', { name: /实验记录/ });
ok('实验记录页签存在', (await recordsTab.count()) === 1);
ok('页签已选中', (await recordsTab.getAttribute('aria-selected')) === 'true');
await page.getByRole('button', { name: '新建记录' }).first().waitFor({ timeout: 20000 });
ok('新建记录按钮', true);
await page.screenshot({ path: 'shots/workbench-eln.png', fullPage: true });

// 新建一条实验记录
const title = `E2E 实验记录 ${Date.now().toString().slice(-6)}`;
await page.getByRole('button', { name: '新建记录' }).first().click();
const drawer = page.locator('.ant-drawer').filter({ hasText: /实验记录/ }).first();
await drawer.waitFor({ state: 'visible', timeout: 10000 });
await drawer.locator('input[placeholder*="RNA"]').fill(title);
await drawer.getByRole('button', { name: /保\s*存/ }).click();
const created = await page
  .waitForSelector('.ant-message-success:has-text("已创建实验记录")', { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
ok('创建实验记录', created);
await page.waitForTimeout(1200);
const row = page.locator('.ant-table-row').filter({ hasText: title }).first();
ok('列表出现新记录', (await row.count()) === 1);

// 转任务
if (await row.count()) {
  await row.getByRole('button', { name: '转任务' }).click();
  const toTask = await page
    .waitForSelector('.ant-message-success:has-text("已加入个人工作台任务")', { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  ok('转任务', toTask);
}

// 清理：删除测试记录
if (await row.count()) {
  await row.locator('button.ant-btn-dangerous').click();
  const pop = page.locator('.ant-popconfirm').filter({ visible: true }).first();
  await pop.waitFor({ state: 'visible', timeout: 8000 });
  await pop.locator('.ant-btn-primary').click();
  const removed = await page
    .waitForSelector('.ant-message-success:has-text("已删除")', { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  ok('删除实验记录', removed);
}

// 实验室中心默认落在库存台账
await page.goto(`${BASE}/lab`, { waitUntil: 'domcontentloaded' });
await dismissWelcome();
await page.waitForTimeout(1200);
ok('实验室中心默认标签', (await page.getByRole('tab', { name: /库存台账/ }).getAttribute('aria-selected')) === 'true');

// 工作台默认仍在任务页签，切换页签写回 URL
await page.goto(`${BASE}/workbench`, { waitUntil: 'domcontentloaded' });
await dismissWelcome();
await page.waitForTimeout(1200);
ok('工作台默认任务页签', (await page.getByRole('tab', { name: /任务/ }).first().getAttribute('aria-selected')) === 'true');
await page.getByRole('tab', { name: /每日文献/ }).click();
await page.waitForTimeout(600);
ok('页签切换写回 URL', /tab=reading/.test(page.url()), page.url());

// Agent 个人助手的实验记录模式复用同一面板
await page.goto(`${BASE}/agent?mode=lab`, { waitUntil: 'domcontentloaded' });
await dismissWelcome();
await page.waitForTimeout(1500);
ok('Agent 实验记录模式', (await page.getByRole('button', { name: '新建记录' }).count()) >= 1);

ok('无前端异常', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);