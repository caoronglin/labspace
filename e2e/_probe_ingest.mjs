// 探针：检查批量入库按钮是否触发请求与消息。
import fs from 'node:fs';
import { chromium } from '/opt/labspace/e2e/node_modules/playwright/index.mjs';

const BASE = 'http://192.0.2.10';
const lines = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n');
const line = lines.find((l) => l.trim().startsWith('labadmin'));
const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
page.on('request', (r) => {
  if (/knowledge/.test(r.url())) console.log('REQ', r.method(), r.url());
});
page.on('response', (r) => {
  if (/knowledge/.test(r.url())) console.log('RES', r.status(), r.url());
});
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE-ERR', m.text());
});

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user.split('@')[0]);
  await page.locator('input[type="password"]').first().fill(pass);
  await Promise.all([
    page.waitForNavigation({ timeout: 30000 }).catch(() => {}),
    page.getByRole('button', { name: /登录|Login/i }).first().click(),
  ]);
  await page.waitForTimeout(2400);
  const help = page.getByRole('button', { name: /开始使用|知道了/ }).first();
  if (await help.count()) await help.click().catch(() => {});
  await page.waitForTimeout(500);

  await page.goto(`${BASE}/files?source=users`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ant-table-tbody tr.ant-table-row', { timeout: 20000 });
  // 选第一行（只选文件也可）
  await page.locator('.ant-table-tbody tr.ant-table-row .ant-checkbox-input').first().click({ force: true });
  await page.waitForTimeout(600);
  console.log('bar:', await page.getByText(/已选 \d+ 项/).first().textContent().catch(() => 'none'));

  const btns = page.getByRole('button', { name: '入库知识库' });
  console.log('button count:', await btns.count());
  if (await btns.count()) {
    console.log('visible:', await btns.first().isVisible(), 'enabled:', await btns.first().isEnabled());
    console.log('html:', (await btns.first().evaluate((el) => el.outerHTML)).slice(0, 300));
  }
  await btns.first().click({ timeout: 10000 }).catch((e) => console.log('CLICK-ERR', e.message.split('\n')[0]));
  await page.waitForTimeout(500);
  console.log('msgs@0.5s:', await page.locator('.ant-message-notice-title').allInnerTexts().catch(() => []));
  console.log('modal@0.5s:', await page.locator('.ant-modal-wrap:visible').count());
  await page.waitForTimeout(4000);
  console.log('msgs@4.5s:', await page.locator('.ant-message-notice-title').allInnerTexts().catch(() => []));
  await page.waitForTimeout(8000);
  console.log('msgs@12.5s:', await page.locator('.ant-message-notice-title').allInnerTexts().catch(() => []));
  await page.screenshot({ path: '/opt/labspace/e2e/shots/_probe_ingest.png' });
} finally {
  await ctx.close();
  await browser.close();
}