import { chromium } from 'playwright';
import fs from 'node:fs';
const CRED = {};
for (const line of fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const [email, pass] = t.split(/\s+/); if (email && pass) CRED[email.split('@')[0]] = pass;
}
const b = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })).newPage();
await page.goto('http://192.0.2.10/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill('labadmin');
await page.locator('#password').fill(CRED.labadmin);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3000);
await page.goto('http://192.0.2.10/workbench', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
if (await page.getByRole('button', { name: '开始使用' }).count()) { await page.getByRole('button', { name: '开始使用' }).first().click(); await page.waitForTimeout(800); }
await page.getByRole('button', { name: '新建任务' }).first().click();
await page.waitForTimeout(1200);
const html = await page.locator('.ant-modal-wrap').first().innerHTML().catch(e => 'ERR '+e.message);
console.log(html.slice(0, 1200));
console.log('labels all:', JSON.stringify(await page.locator('.ant-modal-wrap label').allInnerTexts()));
await b.close();
