import { chromium } from 'playwright';
import fs from 'node:fs';
const CRED = {};
for (const line of fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const [email, pass] = t.split(/\s+/); if (email && pass) CRED[email.split('@')[0]] = pass;
}
const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();
await page.goto('http://192.0.2.10/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill('labadmin');
await page.locator('#password').fill(CRED.labadmin);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3000);
const out = await page.evaluate(async () => {
  const csrf = document.cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('labspace_csrf='))?.split('=')[1] || '';
  const r = await fetch('/api/workbench/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf) },
    body: JSON.stringify({ kind: 'task', title: 'probe', priority: 'normal', status: 'todo' }),
  });
  return { status: r.status, body: await r.text(), csrfLen: csrf.length };
});
console.log(out);
await b.close();
