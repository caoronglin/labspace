// 管理员界面「删除账号」的真实浏览器验证：确认词门禁、危险按钮、删除后列表与磁盘状态。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const NAME = 'e2eui1';
const CSRF = 'e2e-csrf-token-value';

let pass = 0;
const fails = [];
const ok = (name, cond, info = '') => {
  if (cond) { pass += 1; console.log(`PASS  ${name}${info ? ' :: ' + info : ''}`); }
  else { fails.push(name); console.log(`FAIL  ${name}${info ? ' :: ' + info : ''}`); }
};

const adminToken = execFileSync('docker', ['exec', '-i', 'lab-labspace-backend', 'python', '-c', `
from app import accounts
from app.security import issue_session
import json
row = accounts._query('SELECT id, name, display_name, email, groups FROM public."user" WHERE owner=%s AND name=%s', ('built-in', 'labadmin'))[0]
print(issue_session({"id": row["id"], "email": row["email"], "name": row["display_name"], "roles": json.loads(row["groups"] or "[]")}))
`], { encoding: 'utf8' }).trim();

const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { cookie: `labspace_session=${adminToken}; labspace_csrf=${CSRF}`, origin: BASE, 'x-csrf-token': CSRF, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
};

await api('DELETE', `/api/admin/accounts/${NAME}`, { confirm: NAME }); // 清残留
const created = await api('POST', '/api/admin/accounts', {
  name: NAME, displayName: '界面删除测试账号', email: `${NAME}@local`, groups: ['lab-student'],
  password: `E2e${Math.random().toString(36).slice(2, 10)}aA1`,
});
ok('准备测试账号', created.status === 200, `${created.status} ${created.text.slice(0, 160)}`);

const creds = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const password = creds.trim().split(/\s+/)[1];

const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } });
const page = await ctx.newPage();
const badStatus = [];
page.on('response', (r) => {
  if (r.status() >= 400 && /\/api\//.test(r.url()) && !r.url().includes('/api/admin/accounts')) badStatus.push(`${r.status()} ${r.url().replace(BASE, '')}`);
});

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill('labadmin');
await page.locator('input[type="password"]').first().fill(password);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(4000);
await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
await page.locator('.ant-tabs-tab', { hasText: '用户和权限' }).first().click();
await page.waitForTimeout(1500);

await page.locator('input[placeholder="搜索用户名 / 姓名 / 邮箱"]').fill(NAME);
await page.locator('input[placeholder="搜索用户名 / 姓名 / 邮箱"]').press('Enter');
await page.waitForTimeout(1800);
const row = page.locator('.ant-table-row', { hasText: NAME }).first();
ok('列表里能看到测试账号', await row.isVisible());
await page.screenshot({ path: 'shots/admin-delete-row.png', fullPage: false });

await row.getByRole('button', { name: /删\s*除/ }).click();
const modal = page.locator('.ant-modal', { hasText: '删除账号：' }).first();
await modal.waitFor({ state: 'visible', timeout: 8000 });
ok('打开删除确认框', await modal.isVisible());
ok('确认框列出了将被清除的数据', (await modal.innerText()).includes('个人文件空间') && (await modal.innerText()).includes('不可恢复'));

const confirmBtn = modal.getByRole('button', { name: /确认硬删除/ });
ok('未输入时确认按钮禁用', await confirmBtn.isDisabled());
await modal.locator('input').fill('wrong-name');
ok('确认词错误时仍然禁用', await confirmBtn.isDisabled());
await modal.locator('input').fill(NAME);
await page.waitForTimeout(300);
ok('确认词正确时按钮可用', await confirmBtn.isEnabled());
await page.screenshot({ path: 'shots/admin-delete-modal.png' });

await confirmBtn.click();
let toast = '';
for (let i = 0; i < 12 && !/已删除|失败/.test(toast); i += 1) {
  await page.waitForTimeout(400);
  toast = (await page.locator('.ant-message').allInnerTexts().catch(() => [])).join(' ').replace(/\s+/g, ' ');
}
ok('提示删除成功并带清理计数', /已删除/.test(toast), toast.slice(0, 200));
await page.waitForTimeout(1500);
const stillThere = await page.locator('.ant-table-row', { hasText: NAME }).count();
ok('列表里已无该账号', stillThere === 0, `残留行 ${stillThere}`);
ok('个人目录已从磁盘消失', !existsSync(`/srv/lab/users/${NAME}`));
await page.screenshot({ path: 'shots/admin-delete-after.png' });

// 界面刷新后仍然不能再登录：账号行已被物理删除，列表接口也查不到
const listed = await api('GET', `/api/admin/accounts?q=${NAME}`);
let names = [];
try { names = (JSON.parse(listed.text).accounts ?? []).map((a) => a.name); } catch { /* keep empty */ }
ok('账号列表里已查不到该账号', listed.status === 200 && !names.includes(NAME), `${listed.status} ${names.join(',')}`);
ok('除账号接口外没有新的 4xx/5xx', badStatus.length === 0, badStatus.join(' | '));

await browser.close();
console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项${fails.length ? '：' + fails.join('；') : ''}`);
if (fails.length) process.exitCode = 1;
