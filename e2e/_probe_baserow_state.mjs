import { chromium } from 'playwright';
import fs from 'node:fs';
const CRED = {};
for (const line of fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const [email, pass] = t.split(/\s+/); if (email && pass) CRED[email.split('@')[0]] = pass;
}
const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
await page.goto('http://192.0.2.10/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill('labadmin');
await page.locator('#password').fill(CRED.labadmin);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3500);
const startBtn = page.getByRole('button', { name: '开始使用' });
if (await startBtn.count()) { await startBtn.first().click().catch(() => {}); await page.waitForTimeout(800); }
await page.goto('http://192.0.2.10/baserow', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
const selects = page.locator('.ant-select-selection-item');
console.log('select values:', await selects.allInnerTexts());
for (const n of ['从工作台导入', '分析数据', '导入表格']) {
  const btn = page.getByRole('button', { name: n });
  console.log(n, 'count=', await btn.count(), 'disabled=', await btn.count() ? await btn.first().isDisabled() : 'n/a');
}
await b.close();
