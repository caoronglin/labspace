import { chromium } from 'playwright';
const BASE = 'http://192.0.2.10';
const user = process.env.LAB_USER || 'student01';
const pass = process.env.LAB_PASS;
const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill(user);
await page.locator('#password').fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(1500);
  console.log(i, page.url());
}
const me = await page.evaluate(async () => {
  const r = await fetch('/api/me', { credentials: 'include' });
  return { status: r.status, body: (await r.text()).slice(0, 300) };
});
console.log('me', JSON.stringify(me));
console.log('cookies', (await ctx.cookies()).map((c) => `${c.domain}${c.path} ${c.name}`).join(' | '));
console.log('text', (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 300));
await b.close();
