import { chromium } from 'playwright';
const BASE='http://192.0.2.10';
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
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
for (const val of ['zhCN', 'zh-cn', 'zh-CN']) {
  const r = await page.evaluate(async (v) => {
    const res = await fetch('/files/api/settings', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locale: v }) });
    let b = ''; try { b = (await res.text()).slice(0, 200); } catch {}
    return { status: res.status, body: b };
  }, val);
  console.log('PUT locale=' + val, '→', r.status, r.body);
  await page.waitForTimeout(1200);
  const got = await page.evaluate(async () => {
    const res = await fetch('/files/api/users?username=self', { credentials: 'same-origin' });
    const j = await res.json();
    return j.locale;
  });
  console.log('   回读 locale =', got);
  if (got && got !== 'en') break;
}
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const txt = (await page.locator('body').innerText()).replace(/\s+/g,' ');
console.log('页面文本:', txt.slice(0, 260));
console.log('中文字符=', (txt.match(/[\u4e00-\u9fa5]/g)||[]).length, '英文词=', (txt.match(/[A-Za-z]{2,}/g)||[]).length);
await page.screenshot({ path: './shots/quantum-zh.png' });
await browser.close();
