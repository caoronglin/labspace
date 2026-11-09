// 复现「本地 Hy-MT2 服务未就绪」：登录后直接读取 /api/mt/status 与页面表现
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('labadmin@local '));
if (!line) throw new Error('测试账号未找到');
const [user, pass] = line.trim().split(/\s+/);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const net = [];
page.on('response', (r) => {
  if (r.url().includes('/api/mt') || r.url().includes('/api/translate')) {
    net.push(`${r.status()} ${r.url()}`);
  }
});

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

const status = await page.evaluate(async () => {
  const r = await fetch('/api/mt/status', { credentials: 'include' });
  return { code: r.status, body: await r.json().catch(() => null) };
});
console.log('BASE =', BASE);
console.log('status http:', status.code);
console.log(JSON.stringify(status.body, null, 1).slice(0, 1200));

await page.goto(`${BASE}/translation`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const text = await page.evaluate(() => (document.body.innerText || '').slice(0, 600));
console.log('--- page text ---');
console.log(text.replace(/\n{2,}/g, '\n'));
console.log('--- mt requests ---');
console.log(net.join('\n') || 'none');

// 实际提交一次翻译，验证是否真的不可用
const result = await page.evaluate(async () => {
  const csrf = document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] || '';
  const r = await fetch('/api/mt/translate', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ source: '质体基因组比较分析', targetLang: '英语' }),
  });
  return { code: r.status, body: (await r.text()).slice(0, 300) };
});
console.log('translate probe:', result.code, result.body);
await browser.close();