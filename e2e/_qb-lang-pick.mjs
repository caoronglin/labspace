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
await page.waitForTimeout(1200);
await page.getByText('settings', { exact: false }).first().click().catch(()=>{});
await page.waitForTimeout(3000);
await page.getByText('Theme & Language', { exact: false }).first().click().catch(e=>console.log('click err', e.message));
await page.waitForTimeout(2000);
const after = await page.locator('body').innerText();
const i = after.indexOf('Theme & Language');
console.log('展开后片段:', after.slice(i, i + 400));
// 列出可交互元素
const els = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('select, [role="combobox"], [role="listbox"], .MuiInputBase-root, input').forEach(el => {
    out.push(`${el.tagName}.${(el.className||'').toString().slice(0,40)} :: ${(el.textContent||el.value||'').trim().slice(0,50)}`);
  });
  return out;
});
console.log('元素:', els.join(' | '));
await page.screenshot({ path: './shots/quantum-theme-lang.png', fullPage: true });
await browser.close();
