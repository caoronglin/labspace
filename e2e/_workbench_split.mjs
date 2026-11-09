// 个人工作台拆分检查：顶部快捷记录 + 概览，主区域五个分页。脚本不打印任何凭据。
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
let pass = 0;
const fails = [];
const ok = (name, cond, info = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}${info ? ' :: ' + info : ''}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${info ? ' :: ' + String(info).slice(0, 220) : ''}`);
  }
};

const creds = fs
  .readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('labadmin@local'));
const password = creds.trim().split(/\s+/)[1];

const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1050 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill('labadmin');
await page.locator('input[type="password"]').first().fill(password);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(2200);

await page.goto(`${BASE}/workbench`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const body = await page.locator('body').innerText();
ok('顶部快捷记录保留', body.includes('AI 指挥中心'));
ok('顶部概览保留', body.includes('进行中任务'));
ok('主区域分页出现', body.includes('任务') && body.includes('计划与方向') && body.includes('项目') && body.includes('成长与知识') && body.includes('简报与趋势'));

const tabLabels = ['任务', '计划与方向', '项目', '成长与知识', '简报与趋势'];
for (const label of tabLabels) {
  const tab = page.getByRole('tab', { name: new RegExp(label) }).first();
  const count = await tab.count();
  ok(`分页「${label}」存在`, count === 1);
  if (count) {
    await tab.click();
    await page.waitForTimeout(700);
    const errs = await page.locator('.ant-alert-error').count();
    ok(`分页「${label}」无错误提示`, errs === 0, `errorAlerts=${errs}`);
  }
}

// 切回任务页，确认列表/日历/甘特切换仍可用
await page.getByRole('tab', { name: /任务/ }).first().click();
await page.waitForTimeout(500);
ok('任务页含视图切换', (await page.getByText('甘特', { exact: true }).count()) > 0);

const box = await page.locator('.d509-card').first().boundingBox().catch(() => null);
ok('顶部卡片正常渲染', Boolean(box));
await page.screenshot({ path: 'shots/workbench-split.png', fullPage: true });

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(700);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok('移动端无横向溢出', overflow <= 1, `overflow=${overflow}`);
await page.screenshot({ path: 'shots/workbench-split-mobile.png', fullPage: true });

console.log(`\n${pass} passed, ${fails.length} failed`);
await browser.close();
process.exit(fails.length ? 1 : 0);