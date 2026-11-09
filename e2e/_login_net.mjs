import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('student01@local '));
const [user, pass] = line.trim().split(/\s+/);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ locale: 'zh-CN' })).newPage();
const log = [];
page.on('response', (r) => {
  const u = r.url();
  if (/login|token|oauth|session|api\//.test(u) && !/\.(js|css|png|svg|woff)/.test(u)) log.push(`${r.status()} ${r.request().method()} ${u.slice(0, 120)}`);
});
page.on('console', (m) => { if (m.type() === 'error') log.push(`CONSOLE ${m.text().slice(0, 160)}`); });
try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#password', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(pass);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForTimeout(8000);
  console.log('URL', page.url().slice(0, 150));
  console.log('LOG', JSON.stringify(log.slice(-12), null, 1));
} finally {
  await browser.close();
}