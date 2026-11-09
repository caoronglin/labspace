import { chromium } from 'playwright';
const BASE = 'http://192.0.2.10';
const user = process.env.LAB_USER;
const pass = process.env.LAB_PASS;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 160)));
await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3500);
const api = await page.evaluate(async () => {
  const r = await fetch('/api/services/cropgenome/embed', { credentials: 'include' });
  return { status: r.status, body: await r.json().catch(() => null) };
});
console.log('EMBED API:', JSON.stringify(api));
await page.goto(BASE + '/services/cropgenome', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
const info = await page.evaluate(() => {
  const iframe = document.querySelector('iframe');
  const alert = document.querySelector('.ant-alert');
  return {
    title: document.title,
    hasIframe: !!iframe,
    iframeSrc: iframe?.getAttribute('src') || '',
    alertText: alert ? alert.textContent.slice(0, 120) : '',
    bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 220),
  };
});
console.log('PAGE:', JSON.stringify(info));
const frame = page.frames().find((f) => f.url().includes('/cropgenome/'));
if (frame) {
  await frame.waitForTimeout(800);
  console.log('FRAME URL:', frame.url());
  console.log('FRAME TEXT:', (await frame.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 260));
}
await page.screenshot({ path: 'shots/_cropgenome_embed.png', fullPage: false });
console.log('CONSOLE ERRORS:', errors.slice(0, 6));
await browser.close();
