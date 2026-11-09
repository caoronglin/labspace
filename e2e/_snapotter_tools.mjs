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
await page.waitForTimeout(2200);
for (const path of ['/image/remove-gif-background', '/pdf/sign-pdf']) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  console.log(path, '=>', page.url());
  console.log(body.slice(0, 260));
  console.log('HAS_EN:', /Remove GIF Background|Sign PDF|AI background removal/.test(body));
}
await page.screenshot({ path: 'shots/_snapotter_sign.png' });
await browser.close();
