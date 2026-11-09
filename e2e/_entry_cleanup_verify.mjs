// 验证「站内原生页服务」不再经过服务详情层
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://198.51.100.71';
const line = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('labadmin@local '));
if (!line) throw new Error('测试账号未找到');
const [user, pass] = line.trim().split(/\s+/);

const CASES = [
  ['bioinfo-training', '/bioinfo'],
  ['jbrowse', '/genomes'],
    ['snapotter', '/snapotter'],
  ['docling', '/docparse'],
  ['literature-search', '/literature'],
  ['pdf-translate', '/translate'],
  ['searxng', '/search'],
  ['drawio', '/drawio'],
];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 30000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(2500);
for (const label of ['开始使用', '知道了']) {
  const btn = page.getByRole('button', { name: label });
  if (await btn.count()) { await btn.first().click(); await page.waitForTimeout(400); break; }
}

// 1) 直接访问旧的服务详情地址
for (const [id, expect] of CASES) {
  await page.goto(`${BASE}/services/${id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const got = new URL(page.url()).pathname;
  console.log(`/services/${id} -> ${got} ${got === expect ? 'OK' : `期望 ${expect}`}`);
}

// 2) 首页服务卡片点击是否直达
await page.goto(`${BASE}/services`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const card = page.locator('.lab-service-card', { hasText: '生信实验实训平台' }).first();
if (await card.count()) {
  await card.click();
  await page.waitForTimeout(1500);
  console.log('服务页点击「生信实验实训平台」->', new URL(page.url()).pathname);
} else {
  console.log('服务页未找到生信卡片');
}

// 3) 外部服务仍保留详情页
await page.goto(`${BASE}/services/drawing-board`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
console.log('/services/drawing-board ->', new URL(page.url()).pathname);

await browser.close();