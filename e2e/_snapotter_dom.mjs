import { chromium } from 'playwright';
const BASE = 'http://192.0.2.10:8092';
const pass = process.env.SO_PASS || '';
const browser = await chromium.launch();
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
await page.locator('input[type=text], input[type=email], input[name=username]').first().fill('admin');
await page.locator('input[type=password]').first().fill(pass);
await page.locator('input[type=password]').first().press('Enter');
await page.waitForTimeout(2500);
const navHtml = await page.evaluate(() => {
  const el = [...document.querySelectorAll('nav, aside, [role=navigation]')].map((e) => e.outerHTML).join('\n');
  return el.slice(0, 5000);
});
console.log(navHtml);
const labels = await page.evaluate(() => [...document.querySelectorAll('a,button,li')].map(e => e.innerText && e.innerText.trim()).filter(Boolean).filter(t => /^(Image|Video|Audio|PDF|文件|全部)\s*\d*$/.test(t)));
console.log('LABELS:', JSON.stringify(labels));
await browser.close();
