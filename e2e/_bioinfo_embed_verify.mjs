// /bioinfo 内嵌：正常加载不应出现误报；端口不可达时要给出明确提示
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://198.51.100.71';
const line = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('labadmin@local '));
if (!line) throw new Error('测试账号未找到');
const [user, pass] = line.trim().split(/\s+/);

const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function login(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 30000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(2500);
  for (const label of ['开始使用', '知道了']) {
    const btn = page.getByRole('button', { name: label });
    if (await btn.count()) { await btn.first().click(); await page.waitForTimeout(400); break; }
  }
  return page;
}

// A) 正常访问
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const pageA = await login(ctxA);
await pageA.goto(`${BASE}/bioinfo`, { waitUntil: 'domcontentloaded' });
await pageA.waitForTimeout(13000);
const textA = await pageA.evaluate(() => document.body.innerText);
console.log('A 正常加载：误报提示 =', textA.includes('内嵌窗口未能加载'));
const frameA = pageA.frames().find((f) => f.url().includes(':8102'));
console.log('A iframe 地址：', frameA ? frameA.url() : '(未内嵌)');
await pageA.screenshot({ path: 'shots/_bioinfo_after.png' });
await ctxA.close();

// B) 模拟 8102 不可达
const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const pageB = await login(ctxB);
await pageB.route('**://*:8102/**', (r) => r.abort('connectionrefused'));
await pageB.goto(`${BASE}/bioinfo`, { waitUntil: 'domcontentloaded' });
await pageB.waitForTimeout(13000);
const textB = await pageB.evaluate(() => document.body.innerText);
console.log('B 端口不可达：出现提示 =', textB.includes('内嵌窗口未能加载'));
await pageB.screenshot({ path: 'shots/_bioinfo_blocked.png' });
await ctxB.close();

await browser.close();