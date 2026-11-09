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
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(`${BASE}/login`); await p.waitForSelector('input[type="password"]');
await p.locator('input[type="text"], input:not([type])').first().fill('labadmin');
await p.locator('input[type="password"]').first().fill(pw);
await p.getByRole('button', { name: /登录|Login/ }).first().click(); await p.waitForTimeout(4000);
const wm = p.locator('.ant-modal').filter({ hasText: '欢迎使用 D509 工作台' }).first();
if (await wm.isVisible().catch(() => false)) { await wm.getByRole('button', { name: /开始使用/ }).click(); await p.waitForTimeout(600); }

const svc = await p.evaluate(async () => (await fetch('/api/services')).json());
ok('服务目录无 it-tools', !svc.services.some((s) => s.id === 'it-tools' || /开发工具箱/.test(s.name)), svc.services.map((s) => s.id).join(','));

await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
const home = await p.locator('body').innerText();
ok('首页无开发工具箱', !home.includes('开发工具箱'));
ok('首页无开发工具标签', !home.includes('开发工具'));
const toolsRes = await p.evaluate(async () => {
  const r = await fetch('/tools/', { redirect: 'follow' });
  return { status: r.status, url: r.url };
});
ok('旧 8084 跳转已移除', toolsRes.status === 200 && !toolsRes.url.includes(':8084'), JSON.stringify(toolsRes));

await p.keyboard.press('Control+K'); await p.waitForTimeout(800);
const cmdk = p.locator('.ant-modal, [role="dialog"]').first();
ok('命令面板可打开', await cmdk.isVisible().catch(() => false));
if (await cmdk.isVisible().catch(() => false)) {
  const input = cmdk.locator('input').first();
  await input.fill('开发工具'); await p.waitForTimeout(1200);
  const txt = await cmdk.innerText();
  ok('命令面板无开发工具箱', !txt.includes('开发工具箱') && !txt.includes('/devtools'), txt.slice(0, 120).replace(/\n/g, ' | '));
  await p.keyboard.press('Escape');
}

await p.goto(`${BASE}/help`, { waitUntil: 'networkidle' });
const help = await p.locator('body').innerText();
ok('帮助服务地图无开发工具箱', !help.includes('开发工具箱') && !help.includes('/devtools'));

await p.goto(`${BASE}/tools/`, { waitUntil: 'networkidle' });
ok('科研工具页正常', (await p.locator('body').innerText()).includes('科研工具'));
await p.screenshot({ path: 'shots/final-tools-page.png' });
await p.goto(`${BASE}/devtools`, { waitUntil: 'networkidle' });
const devText = await p.locator('body').innerText();
ok('/devtools 无工具页面', !devText.includes('开发工具箱'), devText.slice(0, 80).replace(/\n/g, ' | '));
ok('无前端异常', errs.length === 0, errs.slice(0, 2).join(' '));
await b.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);