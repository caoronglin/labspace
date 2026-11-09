// 临时探针：全局 Debug 面板仅管理员可见
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const cases = [
  { user: process.env.U_STUDENT, pass: process.env.P_STUDENT, admin: false, label: 'student01' },
  { user: process.env.U_ADMIN, pass: process.env.P_ADMIN, admin: true, label: 'labadmin' },
];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
for (const c of cases) {
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 160)));

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(c.user);
  await page.locator('input[type="password"]').first().fill(c.pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(4000);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const fab = await page.locator('.d509-debug-fab').count();
  let commandHit = false;
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(700);
  const paletteInput = page.locator('.ant-modal input').first();
  if (await paletteInput.count()) {
    await paletteInput.fill('debug');
    await page.waitForTimeout(700);
    commandHit = /打开全局 Debug/.test(await page.locator('.ant-modal').first().innerText().catch(() => ''));
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  let drawerOpened = false;
  if (fab > 0) {
    await page.locator('.d509-debug-fab').click();
    await page.waitForTimeout(900);
    drawerOpened = (await page.locator('.ant-drawer').count()) > 0 &&
      /全局 Debug & Preview/.test(await page.locator('.ant-drawer').first().innerText().catch(() => ''));
    await page.screenshot({ path: new URL(`./shots/_debug_${c.label}.png`, import.meta.url).pathname });
    if (drawerOpened) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  }

  console.log(`[${c.label}] fab=${fab} commandHit=${commandHit} drawerOpened=${drawerOpened} errors=${errors.length ? errors.slice(0, 3).join(' | ') : 'none'}`);
  const ok = c.admin ? fab === 1 && commandHit && drawerOpened : fab === 0 && !commandHit;
  console.log(`[${c.label}] ${ok ? 'PASS' : 'FAIL'}`);
  await ctx.close();
}
await browser.close();
