import { chromium } from 'playwright';
const BASE = 'http://198.51.100.71';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
for (const [name, tok] of [['student', process.env.STUDENT_TOK], ['teacher', process.env.TEACHER_TOK]]) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'zh-CN' });
  await ctx.addCookies([{ name: 'labspace_session', value: tok, domain: '198.51.100.71', path: '/' }]);
  const page = await ctx.newPage();
  const bad = [];
  page.on('response', (r) => {
    const u = r.url();
    if (!u.includes('/api/')) return;
    if (r.status() >= 400) bad.push(`${r.status()} ${u.replace(BASE, '')}`);
  });
  page.on('pageerror', (e) => bad.push(`JS ${e}`));
  for (const path of ['/seeds', '/lab']) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    for (let i = 0; i < 4; i += 1) {
      const close = page.locator('.ant-tour-close, .ant-modal-close').first();
      if (await close.count()) { await close.click({ force: true }).catch(() => {}); await page.waitForTimeout(250); }
    }
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const hasTable = (await page.locator('tbody tr').count()) > 1;
    await page.screenshot({ path: `/tmp/${name}${path.replace('/', '-')}.png` });
    console.log(name, path, JSON.stringify({ hasTable, snippet: text.slice(0, 150) }));
  }
  console.log(name, 'problems', JSON.stringify(bad));
  await ctx.close();
}
await browser.close();
