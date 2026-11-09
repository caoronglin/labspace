// 账号改名 UI 验证：管理员在编辑弹窗修改登录名，列表即时刷新。
// 脚本不打印任何凭据。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const OLD = 'zzuiren1';
const NEW = 'zzuiren2';
const EMAIL = `${OLD}@local`;

let pass = 0;
const fails = [];
const ok = (name, cond, info = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}${info ? ' :: ' + info : ''}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${info ? ' :: ' + info.slice(0, 220) : ''}`);
  }
};

const mint = (py) =>
  execFileSync('docker', ['exec', '-i', '-w', '/srv/app', 'lab-labspace-backend', 'python', '-c', py], {
    encoding: 'utf8',
  }).trim();

const token = mint(`
from app import accounts
from app.security import issue_session
import json
row = accounts._query('SELECT id, email, display_name, groups FROM public."user" WHERE owner=%s AND name=%s', ('built-in', 'labadmin'))[0]
print(issue_session({"id": row["id"], "email": row["email"], "name": row["display_name"], "roles": json.loads(row["groups"] or "[]")}))
`);

const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text };
};

// 预置一个临时账号（口令随机且不打印）；先清掉上次中断的残留
for (const leftover of [OLD, NEW]) {
  await api('DELETE', `/api/admin/accounts/${leftover}`, { confirm: leftover }).catch(() => {});
}
const password = execFileSync('python3', ['-c', 'import secrets;print(secrets.token_urlsafe(12))'], {
  encoding: 'utf8',
}).trim();
const created = await api('POST', '/api/admin/accounts', {
  name: OLD,
  displayName: '改名 UI 测试',
  email: EMAIL,
  groups: ['lab-student'],
  password,
});
ok('预置临时账号', created.status === 200, `${created.status} ${created.text.slice(0, 160)}`);

const creds = fs
  .readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('labadmin@local'));
const loginPassword = creds.trim().split(/\s+/)[1];

const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill('labadmin');
await page.locator('input[type="password"]').first().fill(loginPassword);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3000);

await page.goto(`${BASE}/admin/users`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.ant-table-row', { timeout: 20000 });
await page.locator('input[placeholder*="搜索用户名"]').fill(OLD);
await page.waitForTimeout(1500);
const row = page.locator('.ant-table-row', { hasText: OLD }).first();
ok('搜索到临时账号', (await row.count()) > 0, page.url());
await row.getByRole('button', { name: '编辑' }).first().click();

const modal = page.locator('.ant-modal').filter({ hasText: `编辑账号：${OLD}` }).first();
await modal.waitFor({ state: 'visible', timeout: 10000 });
const nameField = modal.locator('.ant-form-item', { hasText: '账号标识（登录名）' }).locator('input').first();
ok('编辑弹窗提供登录名字段', (await nameField.count()) > 0, '');
ok('登录名字段回填当前账号', (await nameField.inputValue()) === OLD, await nameField.inputValue().catch(() => ''));
await page.screenshot({ path: 'shots/account-rename-modal.png' });

await nameField.fill(NEW);
await modal.getByRole('button', { name: /保\s*存/ }).click();
const renamed = await page
  .getByText(`账号已改名为 ${NEW}`)
  .first()
  .waitFor({ state: 'visible', timeout: 15000 })
  .then(() => true)
  .catch(() => false);
ok('保存后提示改名成功', renamed, '');

await page.waitForTimeout(1500);
const newRow = page.locator('.ant-table-row', { hasText: NEW }).first();
ok('列表刷新为新登录名', (await newRow.count()) > 0, '');
const oldNameCell = page.getByText(OLD, { exact: true });
ok('旧登录名不再出现', (await oldNameCell.count()) === 0, `matches=${await oldNameCell.count()}`);
await page.screenshot({ path: 'shots/account-rename-done.png' });

await browser.close();

// 收尾：清除临时账号
const removed = await api('DELETE', `/api/admin/accounts/${NEW}`, { confirm: NEW });
ok('清理临时账号', removed.status === 200, `${removed.status}`);

console.log(`\n通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) console.log('失败项：' + fails.join('、'));
process.exit(fails.length ? 1 : 0);
