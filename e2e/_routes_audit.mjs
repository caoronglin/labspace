// 全站路由审计：登录后逐个打开页面，记录 404/403/异常/接口失败/横向溢出
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n').find((l) => l.startsWith('labadmin@local '));
if (!line) throw new Error('测试账号未找到');
const [user, pass] = line.trim().split(/\s+/);

const ROUTES = [
  '/', '/start', '/services', '/services/jbrowse', '/favorites', '/search',
  '/literature', '/drawio', '/drawings', '/colors', '/baserow', '/aikit',
  '/docparse', '/translate', '/commands', '/bioinfo', '/translation',
  '/weather', '/workbench', '/agent', '/devtools', '/databases', '/genomes',
  '/help', '/files', '/knowledge', '/network', '/snapotter',
  '/admin/status', '/admin/users', '/admin/announcements', '/admin/agent', '/admin/settings',
];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
page.on('response', (r) => {
  if (r.status() >= 400 && r.url().includes('/api/')) errors.push(`http ${r.status()} ${r.url().replace(BASE, '')}`);
});

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 30000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(2500);

// 关闭首次激活引导（每账号一次）
await page.waitForTimeout(1500);
for (const label of ['开始使用', '知道了']) {
  const btn = page.getByRole('button', { name: label });
  if (await btn.count()) { await btn.first().click(); await page.waitForTimeout(400); break; }
}

const rows = [];
for (const route of ROUTES) {
  errors.length = 0;
  let status = 0;
  try {
    const resp = await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 30000 });
    status = resp?.status() ?? 0;
    await page.waitForTimeout(1400);
  } catch (e) {
    rows.push({ route, status, fault: `goto: ${e.message.split('\n')[0]}` });
    continue;
  }
  const info = await page.evaluate(() => {
    const text = document.body.innerText || '';
    const de = document.documentElement;
    return {
      notFound: text.includes('页面不存在'),
      forbidden: text.includes('无访问权限') || text.includes('仅限 lab-admin'),
      crash: text.includes('页面出现异常') || text.includes('服务出错了'),
      overflowX: de.scrollWidth > de.clientWidth + 1,
      title: (text.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '').slice(0, 40),
    };
  });
  rows.push({ route, status, ...info, errors: [...new Set(errors)].slice(0, 4) });
}
console.log(JSON.stringify(rows, null, 1));

const mobile = ['/files', '/knowledge', '/genomes', '/workbench', '/agent', '/admin/users'];
await page.setViewportSize({ width: 390, height: 844 });
const mob = [];
for (const route of mobile) {
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  mob.push([route, await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)]);
}
console.log('mobileOverflow', JSON.stringify(mob));
await browser.close();