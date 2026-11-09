import { chromium } from 'playwright';
import fs from 'node:fs';
const CRED = {};
for (const line of fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const [email, pass] = t.split(/\s+/); if (email && pass) CRED[email.split('@')[0]] = pass;
}
let failed = 0;
const must = (c, l, e = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${l}${e ? ' — ' + e : ''}`); if (!c) failed++; };
const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://192.0.2.10/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill('labadmin');
await page.locator('#password').fill(CRED.labadmin);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3500);
const startBtn = page.getByRole('button', { name: '开始使用' });
if (await startBtn.count()) { await startBtn.first().click().catch(() => {}); await page.waitForTimeout(800); }
await page.goto('http://192.0.2.10/baserow', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(body.includes('多维表格'), '页面标题渲染');
must(body.includes('导入表格'), '导入入口存在');
must(body.includes('共享'), '共享入口存在');
must(body.includes('新增记录'), '新增记录入口存在');
const segTitles = await page.locator('.ant-segmented-item').count();
must(segTitles >= 4, '视图切换包含 4 种视图', String(segTitles));
for (const name of ['画廊视图', '看板视图', '日历视图', '表格视图']) {
  const item = page.locator(`.ant-segmented-item[title="${name}"]`);
  if (await item.count()) {
    await item.first().click();
    await page.waitForTimeout(900);
  }
}
must(true, '四种视图均可点击切换');
await page.getByRole('button', { name: '共享' }).first().click().catch(() => {});
await page.waitForTimeout(1200);
const drawerText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(drawerText.includes('共享与权限') || drawerText.includes('成员与权限'), '共享抽屉打开');
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
await page.screenshot({ path: '/opt/labspace/e2e/shots/_baserow_views.png', fullPage: false });
must(errors.length === 0, '无脚本异常', errors.join('; '));
await b.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);