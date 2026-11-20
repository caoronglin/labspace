import { chromium } from 'playwright';
const BASE = 'http://198.51.100.71';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: 'zh-CN' });
await ctx.addCookies([{ name: 'labspace_session', value: process.env.TOK, domain: '198.51.100.71', path: '/' }]);
const page = await ctx.newPage();
await page.goto(`${BASE}/plot`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
for (let i = 0; i < 4; i += 1) {
  const c = page.locator('.ant-tour-close, .ant-modal-close').first();
  if (await c.count()) { await c.click({ force: true }).catch(() => {}); await page.waitForTimeout(200); }
}
await page.locator('.ant-layout-sider').hover();
await page.waitForTimeout(700);
const links = await page.locator('.ant-menu a').allInnerTexts();
process.stdout.write(`侧栏条目: ${JSON.stringify(links)}\n`);
// 打开「分析与写作」子菜单
const sub = page.locator('.ant-menu-submenu-title', { hasText: '分析与写作' }).first();
if (await sub.count()) {
  await sub.hover();
  await page.waitForTimeout(700);
  const subLinks = await page.locator('.ant-menu a').allInnerTexts();
  process.stdout.write(`展开后条目: ${JSON.stringify(subLinks)}\n`);
}
await page.screenshot({ path: '/tmp/nav.png' });
await ctx.close();
await browser.close();
