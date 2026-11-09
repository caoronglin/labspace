import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n').find((l) => l.startsWith('labadmin@local '));
const [user, pass] = line.trim().split(/\s+/);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3000);
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
for (const label of ['开始使用', '知道了']) {
  const btn = page.getByRole('button', { name: label });
  if (await btn.count()) { await btn.first().click(); await page.waitForTimeout(500); break; }
}
await page.waitForTimeout(1500);

const info = await page.evaluate(() => {
  const hero = document.querySelector('.d509-hero');
  const side = document.querySelector('.d509-hero-side');
  const q = document.querySelector('.d509-hero .d509-title');
  const ann = document.querySelector('.d509-hero-ann');
  const r = (el) => el ? { top: Math.round(el.getBoundingClientRect().top), left: Math.round(el.getBoundingClientRect().left), h: Math.round(el.getBoundingClientRect().height) } : null;
  return {
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
    hero: r(hero), side: r(side), title: r(q), ann: r(ann),
    sideSections: document.querySelectorAll('.d509-hero-side-section').length,
    quickTiles: document.querySelectorAll('.d509-tile').length,
    serviceCards: document.querySelectorAll('.lab-service-card').length,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
});
console.log('light', JSON.stringify(info));
await page.screenshot({ path: '/opt/labspace/e2e/shots/home_audit_light.png', fullPage: false });

await page.evaluate(() => localStorage.setItem('labspace.theme', 'dark'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.screenshot({ path: '/opt/labspace/e2e/shots/home_audit_dark.png', fullPage: false });

await page.evaluate(() => localStorage.setItem('labspace.theme', 'light'));
await page.setViewportSize({ width: 390, height: 844 });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const narrow = await page.evaluate(() => ({
  overflowX: document.documentElement.scrollWidth > window.innerWidth,
  heroAnnWidth: Math.round(document.querySelector('.d509-hero-ann')?.getBoundingClientRect().width ?? 0),
  viewport: window.innerWidth,
}));
console.log('narrow', JSON.stringify(narrow));
await page.screenshot({ path: '/opt/labspace/e2e/shots/home_audit_narrow.png', fullPage: false });
console.log('errors', JSON.stringify(errors.slice(0, 8)));
await browser.close();