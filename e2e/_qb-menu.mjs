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
// 列出所有可点击的图标按钮/菜单项
const items = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('button, [role="button"], a, li').forEach((el) => {
    const t = (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40);
    if (t) out.push(`${el.tagName}.${el.className?.toString().slice(0,30)} :: ${t}`);
  });
  return [...new Set(out)].slice(0, 40);
});
console.log(items.join('\n'));
await browser.close();
