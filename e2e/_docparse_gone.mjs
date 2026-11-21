import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-CN' });
await ctx.addCookies([{ name: 'labspace_session', value: process.env.TOK, domain: process.env.LAB_HOST || '127.0.0.1', path: '/' }]);
const page = await ctx.newPage();
const problems = [];
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('/api/') && r.status() >= 400) problems.push(`${r.status()} ${u.replace(BASE, '')}`);
});
page.on('pageerror', (e) => problems.push(`JS ${e}`));

for (const path of ['/docparse', '/start']) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  for (let i = 0; i < 4; i += 1) {
    const close = page.locator('.ant-tour-close, .ant-modal-close').first();
    if (await close.count()) {
      await close.click({ force: true }).catch(() => {});
      await page.waitForTimeout(250);
    }
  }
  const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  const gone = text.includes('页面不存在');
  const tile = await page.locator('.d509-tile:has-text("文档解析")').count();
  process.stdout.write(`${path} 404=${gone} 文档解析tile=${tile}\n`);
}

process.stdout.write(`problems ${JSON.stringify(problems)}\n`);
await page.screenshot({ path: '/tmp/docparse-gone.png' });
await ctx.close();
await browser.close();
