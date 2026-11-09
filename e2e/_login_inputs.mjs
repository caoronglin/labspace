import { chromium } from 'playwright';
const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await browser.newContext({ locale: 'zh-CN' })).newPage();
try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const inputs = await page.$$eval('input', (els) =>
    els.map((e) => ({ type: e.getAttribute('type'), name: e.getAttribute('name'), id: e.id, placeholder: e.getAttribute('placeholder'), visible: !!(e.offsetWidth || e.offsetHeight) })),
  );
  console.log('URL', page.url());
  console.log('INPUTS', JSON.stringify(inputs));
  const buttons = await page.$$eval('button', (els) => els.map((e) => e.innerText.trim()).filter(Boolean));
  console.log('BUTTONS', JSON.stringify(buttons));
  await page.screenshot({ path: '/opt/labspace/e2e/shots/_login_debug.png', fullPage: true });
} finally {
  await browser.close();
}