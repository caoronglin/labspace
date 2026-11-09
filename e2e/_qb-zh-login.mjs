import { chromium } from 'playwright';
const BASE='http://192.0.2.10';
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
// 1. 先在 Casdoor 完成登录（同一浏览器上下文，Quantum OIDC 会复用会话）
await page.goto(`${BASE}:8090/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
const inputs = page.locator('input');
await inputs.nth(0).fill('student01');
await inputs.nth(1).fill(process.env.LAB_PASS);
await page.getByRole('button', { name: /登录/ }).first().click();
await page.waitForTimeout(3000);
// 2. 进入 Quantum 并走 OIDC
await page.goto(`${BASE}:8080/files/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.getByText(/OpenID Connect/i).first().click().catch(e => console.log('click err', e.message));
await page.waitForTimeout(8000);
const url = page.url();
const txt = (await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0, 500);
const cjk = (txt.match(/[\u4e00-\u9fa5]/g)||[]).length;
const latin = (txt.match(/[A-Za-z]{2,}/g)||[]).length;
console.log('落地 URL:', url);
console.log('文本:', txt);
console.log(`中文字符=${cjk} 英文词=${latin}`);
await page.screenshot({ path: './shots/quantum-zh.png' });
await browser.close();
