// 语料直达：命令面板/统一搜索的服务命中应直接进入站内页面，而不是服务详情中转页
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://198.51.100.71';
const line = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('labadmin@local '));
if (!line) throw new Error('测试账号未找到');
const [user, pass] = line.trim().split(/\s+/);

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

// 1) 语料数据：站内服务应给出页面直连路径
const corpus = await page.evaluate(() =>
  fetch('/api/corpus?q=%E5%AE%9E%E8%AE%AD&limit=20').then((r) => r.json()),
);
const items = (corpus.items || corpus.results || []).filter((i) => i.type === 'service');
for (const it of items.slice(0, 5)) console.log('语料：', it.title, '| path =', it.path, '| url =', it.url);

// 2) 命令面板直达
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.keyboard.press('Control+k');
await page.waitForTimeout(500);
await page.locator('.ant-modal input').first().fill('实训');
await page.waitForTimeout(1800);
const hit = page.locator('.ant-modal').getByText('生信实验实训平台').first();
console.log('面板命中：', (await hit.count()) > 0);
if (await hit.count()) {
  await hit.click({ force: true });
  await page.waitForTimeout(2500);
  console.log('面板跳转 →', new URL(page.url()).pathname);
}
await ctx.close();
await browser.close();
