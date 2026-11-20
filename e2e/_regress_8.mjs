import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);

const ROUTES = [
  ['/', /你好|今日|服务/],
  ['/services', /全部服务/],
  ['/start', /快捷|起始页|服务/],
  ['/search?q=%E5%9F%BA%E5%9B%A0%E7%BB%84', /本地资源|搜索/],
  ['/files', /文件管理|个人文件/],
  ['/knowledge', /知识库/],
  ['/workbench', /工作台/],
  ['/genomes', /公共基因组|基因组/],
  ['/bioinfo', /生信|实训/],
  [/文档解析/],
  ['/snapotter', /文件工坊|SnapOtter/],
  ['/colors', /配色搭配/],
  ['/help', /帮助/],
  ['/commands', /命令/],
  ['/devtools', /开发工具/],
  ['/literature', /文献/],
  ['/databases', /植物|数据库/],
  ['/weather', /天气/],
  ['/agent', /Agent|助手|对话/],
  ['/favorites', /收藏/],
  ['/network', /网络|IP/],
];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const failures = [];
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(5000);

for (const [route, re] of ROUTES) {
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(route === '/' ? 2500 : 1500);
    const text = await page.evaluate(() => document.body.innerText);
    if (!re.test(text)) failures.push(`${route} missing ${re}`);
    if (/页面不存在|出错了|Something went wrong/.test(text) && !route.includes('search')) {
      failures.push(`${route} shows error state`);
    }
  } catch (e) {
    failures.push(`${route} ${String(e.message || e).slice(0, 120)}`);
  }
}

// 管理员页面
for (const route of ['/admin', '/admin/users', '/admin/agent']) {
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1200);
    const text = await page.evaluate(() => document.body.innerText);
    if (/页面不存在/.test(text)) failures.push(`${route} 404`);
  } catch (e) {
    failures.push(`${route} ${String(e.message || e).slice(0, 120)}`);
  }
}

// API 探针（携带登录态）
const probes = [
  ['/api/services', (j) => Array.isArray(j.services) && j.services.length >= 10],
  ['/api/favorites', (j) => Array.isArray(j.favorites)],
  ['/api/recent', (j) => Array.isArray(j.recent)],
  ['/api/announcements', (j) => Array.isArray(j.announcements)],
  ['/api/workbench/summary', (j) => !!j.stats],
  ['/api/next/v1/colors/meta', (j) => Array.isArray(j.sources)],
];
for (const [p, check] of probes) {
  try {
    const res = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return { code: r.status, body: await r.text() };
    }, p);
    if (res.code !== 200) { failures.push(`${p} HTTP ${res.code}`); continue; }
    if (!check(JSON.parse(res.body))) failures.push(`${p} payload unexpected`);
  } catch (e) {
    failures.push(`${p} ${String(e.message || e).slice(0, 100)}`);
  }
}

await browser.close();
if (consoleErrors.length) console.log('console errors:', consoleErrors.slice(0, 5).join(' || '));
if (failures.length) {
  console.log('FAIL 8:', failures.join(' | '));
  process.exit(1);
}
console.log(`PASS 8: ${ROUTES.length} routes + admin + 6 APIs`);