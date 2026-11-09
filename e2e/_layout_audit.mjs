import { chromium } from 'playwright';
const BASE = 'http://192.0.2.10';
const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 200)));
await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(process.env.LAB_USER || 'labadmin');
await page.locator('input[type="password"]').first().fill(process.env.LAB_PASS);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(4000);

for (const p of ['/', '/start', '/services', '/databases', '/workbench', '/knowledge']) {
  await page.goto(BASE + p, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.ant-card')].filter((el) => el.offsetParent !== null);
    const rects = cards.slice(0, 40).map((el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
    });
    // 同一行（y 相同 ±2）卡片高度差
    const rows = new Map();
    for (const r of rects) {
      const key = Math.round(r.y / 10) * 10;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(r.h);
    }
    const uneven = [...rows.entries()]
      .map(([y, hs]) => ({ y, hs }))
      .filter((r) => r.hs.length > 1 && Math.max(...r.hs) - Math.min(...r.hs) > 4);
    return {
      cards: cards.length,
      bodyW: document.body.scrollWidth,
      viewW: window.innerWidth,
      uneven: uneven.slice(0, 5),
      scrollH: document.documentElement.scrollHeight,
    };
  });
  console.log(p, JSON.stringify(info));
  await page.screenshot({ path: `/opt/labspace/e2e/_layout_${p.replace(/\W/g, '_') || 'home'}.png`, fullPage: true });
}
console.log('console errors:', errors.slice(0, 8));
await b.close();
