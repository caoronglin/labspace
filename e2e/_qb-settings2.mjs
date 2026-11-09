import { chromium } from 'playwright';
const BASE='http://192.0.2.10';
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('response', async (r) => {
  const u = r.url();
  if (/\/api\/(settings|users)/.test(u)) {
    let body = '';
    try { body = (await r.text()).slice(0, 500); } catch {}
    console.log('[resp]', r.status(), u.replace(BASE,''), '=>', body);
  }
});
await page.goto(`${BASE}:8090/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
const inputs = page.locator('input');
await inputs.nth(0).fill('student01');
await inputs.nth(1).fill(process.env.LAB_PASS);
await page.getByRole('button', { name: /登录/ }).first().click();
await page.waitForTimeout(2500);
await page.goto(`${BASE}:8080/files/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.getByText(/OpenID Connect/i).first().click().catch(()=>{});
await page.waitForTimeout(9000);
const menu = await page.locator('body').innerText();
console.log('--- 页面文本 ---');
console.log(menu.replace(/\s+/g,' ').slice(0, 300));
await browser.close();
