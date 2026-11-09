import { chromium } from 'playwright';
const BASE='http://192.0.2.10';
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN' });
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
const out = await page.evaluate(async () => {
  const res = [];
  for (const m of ['PUT','PATCH','POST']) {
    try {
      const r = await fetch('/files/api/settings', { method: m, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locale: 'zh-cn' }) });
      res.push(`${m} → ${r.status} ${(await r.text()).slice(0,120)}`);
    } catch (e) { res.push(`${m} → err ${e.message}`); }
  }
  for (const p of ['/files/api/users/self','/files/api/users/me','/files/api/users?username=self']) {
    try {
      const r = await fetch(p, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locale: 'zh-cn' }) });
      res.push(`PUT ${p} → ${r.status} ${(await r.text()).slice(0,120)}`);
    } catch (e) { res.push(`PUT ${p} → err ${e.message}`); }
  }
  return res;
});
console.log(out.join('\n'));
await browser.close();
