// 首页 Hero 改造验证：每日一言、今日任务、精简统计，旧地点/角色/副标题已移除。
// 脚本不打印任何凭据。
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
    console.log(`FAIL  ${name}${info ? ' :: ' + info.slice(0, 220) : ''}`);
  }
};

const saying = await (await fetch(`${BASE}/api/saying`)).json();
ok('每日一言接口可用', typeof saying.text === 'string' && saying.text.length > 0, saying.text.slice(0, 30));

const creds = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const password = creds.trim().split(/\s+/)[1];
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill('labadmin');
await page.locator('input[type="password"]').first().fill(password);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3500);

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const heroText = await page.locator('.d509-hero').first().innerText().catch(() => '');
ok('不再显示地点与角色', !/陕西杨陵/.test(heroText) && !/生信管理员/.test(heroText), heroText.replace(/\n/g, ' ').slice(0, 120));
ok('副标题句已删除', !/面向杨陵校区教学与科研/.test(heroText));
ok('展示每日一言', /每日一言/.test(heroText) && heroText.includes(saying.text.slice(0, 8)), saying.text.slice(0, 24));
ok('展示今日任务', /今日任务/.test(heroText) && /今日到期/.test(heroText) && /逾期/.test(heroText) && /进行中/.test(heroText));
ok('精简统计保留服务与在线', /可用服务/.test(heroText) && /当前在线/.test(heroText));
ok('移除数据库与收藏统计', !/我的收藏/.test(heroText) && !/生物数据库/.test(heroText));

const pageText = await page.locator('body').innerText();
ok('底部两张卡片改为任务面板', /我的任务/.test(pageText) && /待办任务/.test(pageText) && /任务概览/.test(pageText));
ok('数据概览图表已移除', !/数据概览/.test(pageText));
ok('任务概览展示本周完成度', /本周完成度/.test(pageText));

await page.screenshot({ path: 'shots/home-hero.png', fullPage: false });
await page.screenshot({ path: 'shots/home-tasks.png', fullPage: true });

// 打开工作台链接可用
const wbLink = page.getByText('打开工作台').first();
ok('今日任务可跳转工作台', (await wbLink.count()) > 0);
await wbLink.click();
await page.waitForTimeout(1200);
ok('跳转到工作台', /\/workbench/.test(page.url()), page.url());

await browser.close();
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
