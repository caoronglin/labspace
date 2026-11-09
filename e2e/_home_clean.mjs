// 首页“我的任务”卡片已移除 + 页脚检查。脚本不打印任何凭据。
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

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('.d509-hero', { timeout: 15000 });
await page.waitForTimeout(800);

const text = await page.locator('body').innerText();
ok('首页不再出现“我的任务”', !text.includes('我的任务'));
ok('首页不再出现“任务概览”', !text.includes('任务概览'));
ok('首页不再出现“待办任务”', !text.includes('待办任务'));
const foot = await page.locator('.d509-home-foot').count();
ok('页脚已渲染', foot === 1, `count=${foot}`);

const box = await page.locator('.d509-home-foot').first().boundingBox().catch(() => null);
if (box) {
  await page.screenshot({ path: 'shots/home-clean-desktop.png', fullPage: true });
  ok('页面高度合理（无大段空白）', box.y > 600, `foot.y=${Math.round(box.y)}`);
}

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok('移动端无横向溢出', overflow <= 1, `overflow=${overflow}`);
await page.screenshot({ path: 'shots/home-clean-mobile.png', fullPage: true });

console.log(`\n${pass} passed, ${fails.length} failed`);
await browser.close();
process.exit(fails.length ? 1 : 0);