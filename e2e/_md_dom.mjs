import fs from 'node:fs';
import { chromium } from 'playwright';
const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]');
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(5000);
await page.locator('.ant-modal-close').first().click({ timeout: 2000 }).catch(() => {});
await page.goto(`${BASE}/commands`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.locator('div[style*="cursor: pointer"]').first().click();
await page.waitForSelector('.d509-md');
const info = await page.evaluate(() => {
  const md = document.querySelector('.d509-md');
  const pre = md.querySelector('pre');
  const h1 = md.querySelector('h1');
  const cs = pre ? getComputedStyle(pre) : null;
  return {
    html: md.innerHTML.slice(0, 1600),
    preStyle: cs ? { bg: cs.backgroundColor, padding: cs.padding, fontSize: cs.fontSize } : null,
    h1: h1 ? { text: h1.textContent, size: getComputedStyle(h1).fontSize, margin: getComputedStyle(h1).margin } : null,
    rootClass: md.firstElementChild?.className,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
