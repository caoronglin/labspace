import { chromium } from 'playwright';
const BASE='http://192.0.2.10';
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport:{width:1440,height:900} });
const page = await ctx.newPage();
await page.goto(`${BASE}:8090/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
const inputs = page.locator('input');
await inputs.nth(0).fill('student01'); await inputs.nth(1).fill(process.env.LAB_PASS);
await page.getByRole('button', { name: /登录/ }).first().click();
await page.waitForTimeout(2500);
await page.goto(`${BASE}:8080/files/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.getByText(/OpenID Connect/i).first().click().catch(()=>{});
await page.waitForTimeout(9000);
await page.locator('.person-button').first().click();
await page.waitForTimeout(1500);
await page.getByText('settings', { exact: false }).first().click().catch(e=>console.log('settings click err', e.message));
await page.waitForTimeout(4000);
console.log('URL:', page.url());
const body = (await page.locator('body').innerText()).replace(/\s+/g,' ');
console.log('设置页文本(全文):', body);
const idx = body.toLowerCase().indexOf('language');
console.log('language 位置:', idx, idx>=0 ? body.slice(Math.max(0,idx-120), idx+220) : '');
// 找语言下拉
const selects = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('select, [role="combobox"], .MuiSelect-root, .v-select').forEach(el => {
    out.push(`${el.tagName} ${el.className?.toString().slice(0,50)} :: ${(el.textContent||'').trim().slice(0,60)}`);
  });
  return out;
});
console.log('下拉:', selects.join(' | '));
await page.screenshot({ path: './shots/quantum-settings.png' });
await browser.close();
