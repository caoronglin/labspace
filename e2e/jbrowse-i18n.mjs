/**
 * JBrowse 4 中文界面回归
 * 1. 顶栏菜单为中文
 * 2. 展开各菜单后，菜单项不含成片英文
 * 3. 无控制台错误、页面关键内容渲染正常
 */
import { chromium } from 'playwright';

const BASE = process.env.JB_BASE || 'http://192.0.2.10:8091';
const JB_URL = `${BASE}/index.html?config=data/demo/config.zh.json`;
const SHOT = new URL('./shots/jbrowse-i18n.png', import.meta.url).pathname;

const EN_WORDS = /\b(Add|Remove|File|Tools|Help|Share|Close|Cancel|Delete|Export|Import|Open|Save|Settings|Search|Track|View|Session|Assembly|Reference|Annotation|Export|Save as|Track Store|Bookmark|Highlight|Copy|Paste|Undo|Redo|Reset|Apply|Loading|Error|None|Yes|No)\b/;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(JB_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

// 1. 顶栏菜单
const bar = await page.evaluate(() => {
  const hdr = document.querySelector('header');
  if (!hdr) return [];
  return Array.from(hdr.querySelectorAll('button'))
    .map((b) => (b.innerText || '').trim())
    .filter(Boolean);
});
console.log('顶栏按钮:', JSON.stringify(bar));
check('顶栏为中文', bar.length > 0 && bar.every((t) => /[一-龥]/.test(t)), bar.join(' / '));
check('顶栏无残留英文菜单', !bar.some((t) => /^(ADD|TOOLS|HELP|SHARE|FILE)$/i.test(t)), bar.join(' / '));

// 2. 展开每个菜单检查菜单项
const menuLabels = [];
for (const label of bar) {
  const btn = page.locator('header button', { hasText: label }).first();
  if (!(await btn.count())) continue;
  await btn.click();
  await page.waitForTimeout(1200);
  const items = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[role="menu"], .MuiPaper-root ul li, .MuiListItem-root').forEach((el) => {
      const t = (el.innerText || '').trim();
      if (t && t.length < 60) out.push(t);
    });
    return Array.from(new Set(out));
  });
  menuLabels.push({ label, items });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}
console.log('菜单展开采样:', JSON.stringify(menuLabels.slice(0, 4), null, 1).slice(0, 1200));

const enItems = [];
for (const m of menuLabels) {
  for (const it of m.items) {
    if (EN_WORDS.test(it)) enItems.push(`${m.label}: ${it}`);
  }
}
check('展开菜单无英文条目', enItems.length === 0, enItems.slice(0, 8).join(' ; '));

// 3. 关键内容
const text = await page.evaluate(() => document.body.innerText);
check('页面正常渲染', /chr3/.test(text) && text.length > 200, `文本长度 ${text.length}`);
check('控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' ; '));

await page.screenshot({ path: SHOT, fullPage: false });
console.log('截图:', SHOT);

const failed = results.filter((r) => !r.ok).length;
console.log(`\nJBrowse 中文化: ${results.length - failed}/${results.length} 通过`);
await browser.close();
process.exit(failed ? 1 : 0);
