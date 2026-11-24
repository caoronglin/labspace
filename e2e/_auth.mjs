// 登录门户（自有账号口令认证），返回已认证的 BrowserContext
import { chromium } from 'playwright';

export const LAB_USER = process.env.LAB_USER || 'student01';
export const LAB_PASS = process.env.LAB_PASS;
export const BASE = process.env.LAB_BASE || 'http://127.0.0.1';

export async function loginContext(browser, base = BASE) {
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('#username').fill(LAB_USER);
  await page.locator('input[type="password"]').first().fill(LAB_PASS);
  await page.locator('button.ant-btn-primary').first().click();
  await page.waitForTimeout(5000);
  const body = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  if (!/工作台|全部服务|我的收藏/.test(body)) {
    await ctx.close();
    throw new Error(`门户登录失败，停留在 ${page.url()}`);
  }
  return ctx;
}

export async function launch() {
  return chromium.launch({ args: ['--no-sandbox'] });
}
