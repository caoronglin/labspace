import { chromium } from 'playwright';

const BASE = 'http://192.0.2.10:8092';
const user = process.env.SO_USER || 'admin';
const pass = process.env.SO_PASS || '';

const browser = await chromium.launch();
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
console.log('URL:', page.url());
console.log('TITLE:', await page.title());
console.log('BODY:', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600));
await page.screenshot({ path: 'shots/_snapotter_login.png', fullPage: false });

if (pass && (await page.locator('input[type=password]').count())) {
  await page.locator('input[type=text], input[type=email], input[name=username]').first().fill(user);
  await page.locator('input[type=password]').first().fill(pass);
  await page.getByRole('button').first().click().catch(() => {});
  await page.waitForTimeout(2500);
  console.log('AFTER LOGIN URL:', page.url());
  console.log('AFTER LOGIN BODY:', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 800));
  await page.screenshot({ path: 'shots/_snapotter_home.png', fullPage: false });
}

await browser.close();
