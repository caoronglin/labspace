import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(5000);
ok(/工作台|全部服务/.test(await page.evaluate(() => document.body.innerText)), 'login failed');
await page.locator('.ant-modal-close').first().click({ timeout: 2000 }).catch(() => {});
await page.waitForTimeout(300);

// 清空既有主题色，确保从默认开始
await page.evaluate(() => localStorage.removeItem('labspace.primary'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.locator('.ant-modal-close').first().click({ timeout: 2000 }).catch(() => {});

const trigger = page.locator('.ant-layout-header .ant-color-picker-trigger').first();
ok((await trigger.count()) > 0, 'header has no ColorPicker trigger');
await trigger.click();
await page.waitForTimeout(400);
const swatches = page.locator('.ant-color-picker-presets-color');
const n = await swatches.count();
ok(n >= 10, `preset swatches too few: ${n}`);
const targetHex = (await swatches.nth(2).getAttribute('data-color') || '').toLowerCase();
await swatches.nth(2).click();
await page.waitForTimeout(300);
await page.keyboard.press('Escape').catch(() => {});
await page.mouse.click(10, 400);
await page.waitForTimeout(500);

const saved = await page.evaluate(() => localStorage.getItem('labspace.primary'));
ok(!!saved, `primary not persisted (expected ${targetHex})`);
ok(!targetHex || saved === targetHex, `primary persisted ${saved}, expected ${targetHex}`);
const cssVar = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--d509-brand').trim(),
);
ok(!targetHex || cssVar.toLowerCase() === targetHex, `--d509-brand=${cssVar}, expected ${targetHex}`);

// 刷新后保持
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const afterReload = await page.evaluate(() => localStorage.getItem('labspace.primary'));
ok(afterReload === saved, 'primary lost after reload');
const cssAfterReload = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--d509-brand').trim(),
);
ok(cssAfterReload.toLowerCase() === (saved || '').toLowerCase(), '--d509-brand not restored after reload');

// 配色搭配页：表格内“设为主色”按钮
await page.goto(`${BASE}/colors`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const setPrimaryBtn = page.locator('button:has(.anticon-bg-colors)').first();
ok((await setPrimaryBtn.count()) > 0, '/colors has no 设为主色 action');
if (await setPrimaryBtn.count()) {
  await setPrimaryBtn.click();
  await page.waitForTimeout(500);
  const savedFromPalette = await page.evaluate(() => localStorage.getItem('labspace.primary'));
  ok(/^#[0-9a-f]{6}$/i.test(savedFromPalette || ''), `palette 设为主色 did not persist: ${savedFromPalette}`);
}

// 恢复默认
await page.getByRole('button', { name: '恢复默认色' }).first().click();
await page.waitForTimeout(400);
const cleared = await page.evaluate(() => localStorage.getItem('labspace.primary'));
ok(cleared === null, `恢复默认色 did not clear storage: ${cleared}`);
const defaultVar = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--d509-brand').trim(),
);
ok(defaultVar.toLowerCase() === '#2b5ce6', `default --d509-brand=${defaultVar}`);

await browser.close();
if (failures.length) {
  console.log('FAIL 79:', failures.join(' | '));
  process.exit(1);
}
console.log('PASS 79: ColorPicker theme color persisted, applied, reset');