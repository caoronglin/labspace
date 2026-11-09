import { launch, loginContext, BASE } from './_auth.mjs';

const PAGES = ['/', '/services', '/databases', '/workbench', '/agent', '/search', '/devtools'];
const browser = await launch();
const ctx = await loginContext(browser);

for (const p of PAGES) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errs = [];
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 200)));
  await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 45000 }).catch((e) => errs.push('NAV ' + e.message.slice(0, 100)));
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const de = document.documentElement;
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,[role="heading"],.ant-typography')).filter(vis)
      .map((el) => `${el.tagName}:${(el.textContent || '').trim().slice(0, 18)}`);
    const cardTitles = Array.from(document.querySelectorAll('.ant-card-head-title')).filter(vis)
      .map((el) => (el.textContent || '').trim().slice(0, 18));
    const enter = Array.from(document.querySelectorAll('.d509-enter')).map((el) => {
      const st = getComputedStyle(el);
      return { op: st.opacity, tr: st.transform, an: st.animationName };
    });
    const staggerKids = document.querySelectorAll('.d509-stagger > *').length;
    return {
      overflow: de.scrollWidth - de.clientWidth,
      heads: heads.slice(0, 8),
      cardTitles: cardTitles.slice(0, 5),
      enter: enter.slice(0, 3),
      staggerKids,
      docTitle: document.title,
    };
  });
  console.log('=====', p, JSON.stringify(info, null, 1));
  console.log('  errors:', errs.length, errs.slice(0, 4));
  await page.close();
}
await browser.close();
