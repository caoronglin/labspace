// 复现 /bioinfo 内嵌与 /services/bioinfo-training 旧入口的实际表现
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://198.51.100.71';
const line = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('labadmin@local '));
if (!line) throw new Error('测试账号未找到');
const [user, pass] = line.trim().split(/\s+/);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const bad = [];
page.on('console', (m) => { if (m.type() === 'error') bad.push(`console: ${m.text().slice(0, 180)}`); });
page.on('requestfailed', (r) => bad.push(`reqfail: ${r.url().slice(0, 140)} ${r.failure()?.errorText || ''}`));
page.on('response', (r) => { if (r.status() >= 400) bad.push(`http ${r.status()} ${r.url().slice(0, 140)}`); });

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

console.log('==== /bioinfo ====');
await page.goto(`${BASE}/bioinfo`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
for (const f of page.frames()) {
  const info = await f.evaluate(() => ({
    href: location.href,
    title: document.title,
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 220),
  })).catch((e) => ({ href: f.url(), title: '(不可读)', text: String(e).slice(0, 80) }));
  console.log(`frame: ${info.href}\n  title=${info.title}\n  text=${info.text}`);
}
await page.screenshot({ path: 'shots/_bioinfo_embed.png' });
console.log('issues:', bad.length ? bad.slice(0, 8).join('\n  ') : 'none');

bad.length = 0;
console.log('==== /services/bioinfo-training ====');
await page.goto(`${BASE}/services/bioinfo-training`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
console.log('url now:', page.url());
const t = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 400));
console.log('page text:', t);
await page.screenshot({ path: 'shots/_services_bioinfo_training.png' });
console.log('issues:', bad.length ? bad.slice(0, 6).join('\n  ') : 'none');

await browser.close();