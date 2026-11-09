import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('student01@local '));
const [user, pass] = line.trim().split(/\s+/);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ locale: 'zh-CN' })).newPage();
try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#password', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(pass);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForTimeout(9000);
  console.log('URL', page.url());
  const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  console.log('TEXT', text.slice(0, 300));
  await page.screenshot({ path: '/opt/labspace/e2e/shots/_login_after.png', fullPage: true });
} finally {
  await browser.close();
}