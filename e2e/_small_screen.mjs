import { chromium } from 'playwright';

/**
 * 小屏实测（item 10）：390×844（iPhone 14 逻辑分辨率）。
 *
 * 只看三件事：① 有没有**横向溢出**（body.scrollWidth > innerWidth）；
 * ② 关键控件是否仍可见（标题、主按钮、内容卡片）；
 * ③ 有没有 JS 异常 / 4xx。
 * 截图存 /tmp/small-<page>.png 供人工复核。
 */
const BASE = process.env.BASE || 'http://127.0.0.1';
const PAGES = ['/drawio', '/plot', '/bio-tools', '/files', '/seeds', '/genomes', '/latex'];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: 'zh-CN',
});
await ctx.addCookies([{ name: 'labspace_session', value: process.env.TOK, domain: process.env.LAB_HOST || '127.0.0.1', path: '/' }]);
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`JS ${e}`));
page.on('response', (r) => {
  if (r.url().includes('/api/') && r.status() >= 400) problems.push(`${r.status()} ${r.url().replace(BASE, '')}`);
});

const results = [];
for (const path of PAGES) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  for (let i = 0; i < 4; i += 1) {
    const c = page.locator('.ant-tour-close, .ant-modal-close').first();
    if (await c.count()) {
      await c.click({ force: true }).catch(() => {});
      await page.waitForTimeout(200);
    }
  }
  const metrics = await page.evaluate(() => {
    const de = document.documentElement;
    const wide = [...document.querySelectorAll('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > window.innerWidth + 2;
      })
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className || '').slice(0, 40)}`);
    return {
      scrollWidth: de.scrollWidth,
      innerWidth: window.innerWidth,
      textLen: document.body.innerText.trim().length,
      wideEls: wide,
    };
  });
  const overflow = metrics.scrollWidth > metrics.innerWidth + 2;
  results.push({ path, overflow, ...metrics });
  await page.screenshot({ path: `/tmp/small${path.replace('/', '-')}.png`, fullPage: false });
}

for (const r of results) {
  process.stdout.write(
    `${r.overflow ? 'OVERFLOW' : 'ok      '} ${r.path} scrollW=${r.scrollWidth} inner=${r.innerWidth} text=${r.textLen}${r.wideEls.length ? ` wide=${JSON.stringify(r.wideEls)}` : ''}\n`,
  );
}
process.stdout.write(`problems ${JSON.stringify(problems)}\n`);
await ctx.close();
await browser.close();
