import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = 'http://192.0.2.10';
const line = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const pw = line.trim().split(/\s+/)[1];
let fails = 0;
const ok = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!c) fails++; };
const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 } });
const p = await ctx.newPage();
const errs = [];
const fontStatus = {};
p.on('pageerror', (e) => errs.push(String(e)));
p.on('response', (r) => {
  if (r.url().includes('/fonts/honor-sans/')) fontStatus[r.url().split('/').pop()] = r.status();
});
await p.goto(`${BASE}/login`); await p.waitForSelector('input[type="password"]');
await p.locator('input[type="text"], input:not([type])').first().fill('labadmin');
await p.locator('input[type="password"]').first().fill(pw);
await p.getByRole('button', { name: /登录|Login/ }).first().click(); await p.waitForTimeout(4000);
const wm = p.locator('.ant-modal').filter({ hasText: '欢迎使用 D509 工作台' }).first();
if (await wm.isVisible().catch(() => false)) { await wm.getByRole('button', { name: /开始使用/ }).click(); await p.waitForTimeout(600); }
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.evaluate(() => document.fonts.ready);
const info = await p.evaluate(() => ({
  bodyFont: getComputedStyle(document.body).fontFamily,
  latin: document.fonts.check('16px "HONOR Sans"', 'Laboratory'),
  cn: document.fonts.check('16px "HONOR Sans CN"', '科研工作台'),
  faces: [...document.fonts].filter((f) => f.family.includes('HONOR')).map((f) => `${f.family}/${f.weight}/${f.status}`),
}));
ok('body 字体栈包含 HONOR Sans', /HONOR Sans/.test(info.bodyFont), info.bodyFont.slice(0, 80));
ok('西文字体可用', info.latin, info.faces.filter((f) => !f.includes('CN')).join(','));
ok('中文字体可用', info.cn, info.faces.filter((f) => f.includes('CN')).join(','));
ok('字体文件可访问', Object.keys(fontStatus).length > 0 && Object.values(fontStatus).every((s) => s === 200 || s === 304), JSON.stringify(fontStatus));
await p.screenshot({ path: 'shots/final-font-home.png', fullPage: false });
await p.goto(`${BASE}/help`, { waitUntil: 'networkidle' });
const notice = p.getByText(/界面字体使用/).first();
await notice.scrollIntoViewIfNeeded();
ok('帮助页含字体署名', await notice.isVisible().catch(() => false));
const lic = p.getByRole('link', { name: '查看许可协议' }).first();
ok('许可协议链接可达', (await lic.getAttribute('href')) === '/fonts/honor-sans/LICENSE.txt');
await p.screenshot({ path: 'shots/final-font-help.png', fullPage: false });
ok('无前端异常', errs.length === 0, errs.slice(0, 2).join(' '));
await b.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);