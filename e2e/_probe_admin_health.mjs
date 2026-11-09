import { chromium } from 'playwright';
import fs from 'node:fs';
const CRED = {};
for (const line of fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const [email, pass] = t.split(/\s+/); if (email && pass) CRED[email.split('@')[0]] = pass;
}
const b = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await b.newContext({ locale: 'zh-CN' })).newPage();
await page.goto('http://192.0.2.10/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill('labadmin');
await page.locator('#password').fill(CRED.labadmin);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3000);
await page.goto('http://192.0.2.10/admin/status', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
const rows = await page.locator('.ant-table-tbody tr').allInnerTexts();
console.log(rows.slice(0, 12).map((r) => r.replace(/\s+/g, ' ').slice(0, 90)));
await b.close();
