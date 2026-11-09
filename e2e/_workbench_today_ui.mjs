import { chromium } from 'playwright';
import fs from 'node:fs';

const CRED = {};
for (const line of fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const [email, pass] = t.split(/\s+/);
  if (email && pass) CRED[email.split('@')[0]] = pass;
}

let failed = 0;
const must = (c, l, e = '') => {
  console.log(`${c ? 'ok  ' : 'FAIL'} ${l}${e ? ' — ' + e : ''}`);
  if (!c) failed++;
};
const stamp = Date.now().toString().slice(-6);
const title = `E2E 今日任务 ${stamp}`;
const edited = `${title} 已编辑`;

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
if (await startBtn.count()) {
  await startBtn.first().click().catch(() => {});
  await page.waitForTimeout(800);
}

await page.goto('http://192.0.2.10/workbench', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

// 新建一个今天到期的任务
await page.getByRole('button', { name: '新建任务' }).first().click();
await page.waitForTimeout(900);
const modal = page.getByRole('dialog').filter({ hasText: '新建任务' }).last();
must((await modal.count()) > 0, '新建任务弹窗打开');
await modal.getByLabel('标题').fill(title);
await modal.getByRole('button', { name: /创\s*建/ }).click();
await page.waitForTimeout(2000);
let body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(body.includes(title), '任务创建后出现在列表');
must(body.includes('今日到期'), '列表包含今日到期分组');

// 切到日历视图，检查今日提醒
await page.getByText('日历', { exact: true }).first().click();
await page.waitForTimeout(1400);
body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(/今天有 \d+ 项任务到期/.test(body), '日历显示今日到期提醒', body.slice(0, 60));
must(body.includes(title), '日历展示今日任务');
must(body.includes('显示已完成'), '日历提供显示已完成开关');

// 点击今日任务标签进入编辑
await page.getByText(title, { exact: true }).first().click();
await page.waitForTimeout(900);
const editModal = page.getByRole('dialog').filter({ hasText: '编辑事项' }).last();
must((await editModal.count()) > 0, '点击日历任务打开编辑弹窗');
if (await editModal.count()) {
  await editModal.getByLabel('标题').fill(edited);
  await editModal.getByRole('button', { name: /保\s*存/ }).click();
  await page.waitForTimeout(1800);
  body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  must(body.includes(edited), '编辑后标题已更新');
}

// 清理：切回列表，删除测试任务
await page.getByText('列表', { exact: true }).first().click();
await page.waitForTimeout(1200);
const row = page.locator('.ant-card, li, div').filter({ hasText: edited }).last();
const delBtn = page.locator('[aria-label="删除"]').last();
if (await delBtn.count()) {
  await delBtn.click().catch(() => {});
  await page.waitForTimeout(600);
  const confirm = page.locator('.ant-modal-confirm, .ant-popconfirm').last();
  const ok = confirm.getByRole('button', { name: /删\s*除|确\s*定/ }).last();
  if (await ok.count()) await ok.click().catch(() => {});
  await page.waitForTimeout(1200);
}
void row;

await page.screenshot({ path: '/opt/labspace/e2e/shots/_workbench_today.png', fullPage: false });
must(errors.length === 0, '无脚本异常', errors.join('; '));
await b.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);