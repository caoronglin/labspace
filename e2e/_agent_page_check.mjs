import { chromium } from 'playwright';
import fs from 'node:fs';
const CRED = {};
for (const line of fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const [email, pass] = t.split(/\s+/); if (email && pass) CRED[email.split('@')[0]] = pass;
}
let failed = 0;
const must = (c, l, e = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${l}${e ? ' — ' + e : ''}`); if (!c) failed++; };
const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://192.0.2.10/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill('labadmin');
await page.locator('#password').fill(CRED.labadmin);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
try {
  await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
} catch {}
await page.waitForTimeout(2500);
const start = page.getByRole('button', { name: '开始使用' });
if (await start.count()) await start.first().click().catch(() => {});
await page.goto('http://192.0.2.10/agent', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(body.includes('Agent 助手') || body.includes('Agent 个人助手'), 'Agent 页面正常渲染');
must(!body.includes('消息用量') && !body.includes('用量排行') && !body.includes('排行'), '页面不含消息用量排行');
must(body.includes('新建会话') || body.includes('会话'), '会话列表可用');
const input = page.locator('textarea, input[type="text"]').filter({ hasNot: page.locator('[placeholder*="搜索"]') });
must((await input.count()) > 0, '存在对话输入框');
await page.screenshot({ path: '/opt/labspace/e2e/shots/_agent_no_ranking.png' });
must(errors.length === 0, '无脚本异常', errors.join('; '));
await b.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
