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

await page.goto('http://192.0.2.10/admin/status', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
let body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(body.includes('系统管理'), '页面标题为系统管理');
must(body.includes('数据盘总量') && body.includes('已使用') && body.includes('可用'), '磁盘指标块存在');
must(body.includes('服务健康检查'), '健康检查卡片存在');
must(body.includes('每分钟自动探测一次'), 'ProTable 描述存在');
for (const label of ['紧凑', '默认', '宽松']) must(body.includes(label), `密度选项 ${label}`);
const healthSearch = page.getByPlaceholder('搜索服务 / 分类 / 详情');
must(await healthSearch.count() === 1, '健康检查搜索框存在');
await healthSearch.first().fill('Linux');
await page.waitForTimeout(800);
body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
const healthRows = await page.locator('.ant-table-tbody tr').count();
must(body.includes('Linux Command') && healthRows === 1, '搜索过滤生效', `rows=${healthRows}`);
await page.getByRole('button', { name: /异常|Abnormal/ }).count().catch(() => 0);

await page.goto('http://192.0.2.10/admin/users', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(body.includes('账号总数') && body.includes('正常使用') && body.includes('已禁用') && body.includes('管理员'), '账号统计指标存在');
must(body.includes('统一账号'), '统一账号卡片存在');
must(body.includes('共 ') && body.includes('个账号'), '分页总数提示存在');
must(body.includes('全部') && body.includes('已禁用'), '账号状态筛选存在');
const boxes = await page.locator('.ant-table-tbody .ant-checkbox-input').count();
must(boxes >= 1, '账号表格含选择列', String(boxes));
await page.screenshot({ path: '/opt/labspace/e2e/shots/_admin_pro.png', fullPage: false });
must(errors.length === 0, '无脚本异常', errors.join('; '));
await b.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
