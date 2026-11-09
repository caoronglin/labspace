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
await page.waitForTimeout(3500);
const startBtn = page.getByRole('button', { name: '开始使用' });
if (await startBtn.count()) { await startBtn.first().click().catch(() => {}); await page.waitForTimeout(800); }

const stamp = Date.now();
const created = await page.evaluate(async (title) => {
  const csrf = document.cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('labspace_csrf='))?.split('=')[1] || '';
  const r = await fetch('/api/workbench/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf) },
    body: JSON.stringify({ kind: 'task', title, priority: 'normal', status: 'active' }),
  });
  return { status: r.status, body: await r.text() };
}, `多维表格联动测试 ${stamp}`);
must(created.status === 200 || created.status === 201, '准备一条工作台任务', String(created.status));

await page.goto('http://192.0.2.10/baserow', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);

const importBtn = page.getByRole('button', { name: '从工作台导入' });
must(await importBtn.count() === 1 && !(await importBtn.first().isDisabled()), '从工作台导入按钮可用');
await importBtn.first().click();
await page.waitForTimeout(3500);
const body1 = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(body1.includes('已从工作台导入') || body1.includes('工作台没有进行中的事项'), '导入反馈出现', body1.match(/已从工作台导入[^ ]*|工作台没有进行中的事项/)?.[0] || '');
const searchBox = page.getByPlaceholder('搜索记录');
if (await searchBox.count()) {
  await searchBox.first().fill(`多维表格联动测试 ${stamp}`);
  await searchBox.first().press('Enter');
  await page.waitForTimeout(2500);
}
const body2 = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(body2.includes(`多维表格联动测试 ${stamp}`), '导入的记录出现在表格中');

const analyzeBtn = page.getByRole('button', { name: '分析数据' });
must(await analyzeBtn.count() === 1 && !(await analyzeBtn.first().isDisabled()), '分析数据按钮可用');
await analyzeBtn.first().click();
await page.waitForTimeout(3000);
must(page.url().includes('/agent'), '跳转到 Agent 页面', page.url());
const inputValue = await page.locator('textarea').first().inputValue().catch(() => '');
must(inputValue.includes('请分析多维表格') && inputValue.includes('字段：'), '分析提示词已预填到 Agent 输入框', inputValue.slice(0, 80));

must(errors.length === 0, '无脚本异常', errors.join('; '));
await page.screenshot({ path: '/opt/labspace/e2e/shots/_baserow_bindings.png', fullPage: false });
await b.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);