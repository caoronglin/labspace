// 首页排版验收：桌面 / 平板 / 移动三档，检测横向溢出、元素重叠、层级
import { launch, loginContext, BASE } from './_auth.mjs';

const VIEWPORTS = [
  { key: 'desktop', width: 1440, height: 900 },
  { key: 'tablet', width: 1024, height: 768 },
  { key: 'mobile', width: 390, height: 844 },
];

const browser = await launch();
const ctx = await loginContext(browser);
let failed = 0;

for (const vp of VIEWPORTS) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: vp.width, height: vp.height });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 140)));
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForSelector('.lab-service-card', { timeout: 20000 });
  await page.waitForTimeout(2200);

  const metrics = await page.evaluate(() => {
    const de = document.documentElement;
    const overflow = de.scrollWidth - de.clientWidth;
    // 找出越界的元素（忽略被祖先 overflow:hidden 裁切的装饰元素）
    const bad = [];
    const clipped = (el) => {
      let p = el.parentElement;
      while (p && p !== document.body) {
        const ov = getComputedStyle(p).overflow;
        if (ov === 'hidden' || ov === 'clip') return true;
        p = p.parentElement;
      }
      return false;
    };
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > de.clientWidth + 2 || r.left < -2) {
        if (clipped(el)) continue;
        const cls = typeof el.className === 'string' ? el.className.split(' ').slice(0, 2).join('.') : '';
        bad.push(`${el.tagName.toLowerCase()}.${cls} right=${Math.round(r.right)}`);
      }
      if (bad.length > 6) break;
    }
    // 卡片重叠检测（同一容器内的绝对定位元素对）
    const overlaps = [];
    const rects = Array.from(document.querySelectorAll('.ant-card, .lab-service-card, .d509-tile')).map((el) => ({
      el,
      r: el.getBoundingClientRect(),
    }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        // 嵌套卡片（外层面板内嵌子卡片）不算重叠
        if (rects[i].el.contains(rects[j].el) || rects[j].el.contains(rects[i].el)) continue;
        const a = rects[i].r;
        const b = rects[j].r;
        if (a.width === 0 || b.width === 0) continue;
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 8 && oy > 8) {
          overlaps.push(`${rects[i].el.className}|${rects[j].el.className}`);
        }
      }
    }
    return {
      overflow,
      bad: bad.slice(0, 6),
      overlaps: overlaps.slice(0, 5),
      cards: document.querySelectorAll('.lab-service-card').length,
      height: de.scrollHeight,
    };
  });

  const hero = await page.evaluate(() => {
    const h = document.querySelector('.d509-hero');
    const stats = document.querySelector('.d509-hero-stats');
    if (!h || !stats) return { ok: false };
    const hr = h.getBoundingClientRect();
    const sr = stats.getBoundingClientRect();
    return { ok: sr.top >= hr.top - 2 && sr.bottom <= hr.bottom + 2, heroH: Math.round(hr.height) };
  });

  const ok = metrics.overflow <= 2 && metrics.bad.length === 0 && metrics.overlaps.length === 0 && metrics.cards > 0;
  if (!ok) failed++;
  console.log(
    `[${vp.key} ${vp.width}x${vp.height}] ${ok ? 'OK' : 'FAIL'} 溢出=${metrics.overflow}px 卡片=${metrics.cards} 页面高=${metrics.height} Hero高度=${hero.heroH ?? '-'}`,
  );
  if (metrics.bad.length) console.log('   越界元素:', metrics.bad.join(' ; '));
  if (metrics.overlaps.length) console.log('   重叠元素:', metrics.overlaps.join(' ; '));
  if (!hero.ok) console.log('   警告: Hero 指标面板未正确内嵌');
  if (errors.length) console.log(`   控制台错误(${errors.length}):`, errors.slice(0, 2).join(' | '));

  await page.screenshot({ path: `/opt/labspace/e2e/shots/home-${vp.key}.png`, fullPage: vp.key === 'desktop' });
  await page.close();
}

await browser.close();
console.log(failed === 0 ? '首页排版验收: 全部通过' : `首页排版验收: ${failed} 档失败`);
process.exit(failed === 0 ? 0 : 1);
