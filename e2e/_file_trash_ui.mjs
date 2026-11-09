// 回收站面板的真实浏览器验证：删除确认文案、徽标计数、面板列表、恢复与彻底删除。
// 会话用后端签发的 cookie 注入（登录链路已由 _admin_delete_ui.mjs 覆盖）；脚本不打印凭据。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const CSRF = 'e2e-csrf-token-value';
const LAB = '/srv/lab';
const TRASH = `${LAB}/.trash`;
const MANIFEST = `${TRASH}/trash.json`;
const NAME = 'e2etrash3';
const FILE = 'ui-roundtrip.txt';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${extra ? ' :: ' + extra : ''}`);
  }
};

const py = (code) =>
  execFileSync('docker', ['exec', '-i', 'lab-labspace-backend', 'python', '-c', code], { encoding: 'utf8' }).trim();

const mint = (name) => py(`
import json
from app import accounts
from app.security import issue_session
row = accounts._query('SELECT id, name, display_name, email, groups FROM public."user" WHERE owner=%s AND name=%s', ('built-in', ${JSON.stringify(name)}))[0]
groups = json.loads(row["groups"] or "[]")
print(issue_session({"id": row["id"], "email": row["email"], "name": row["display_name"] or row["name"], "roles": [g if isinstance(g, str) else g.get("name", "") for g in groups]}))
`);

const call = async (method, path, token, body) => {
  const headers = { cookie: `labspace_session=${token}; labspace_csrf=${CSRF}`, origin: BASE };
  if (token) headers['x-csrf-token'] = CSRF;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: res.status, json, text };
};

const sha = (p) => crypto.createHash('sha256').update(readFileSync(p)).digest('hex');
const manifest = () => (existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { items: [] });
const myRows = () => manifest().items.filter((i) => String(i.path || '').startsWith(`${NAME}/`));

console.log('# 准备账号与一个待删文件');
const adminToken = mint('labadmin');
const gone = await call('DELETE', `/api/admin/accounts/${NAME}`, adminToken, { confirm: NAME });
ok('预清理账号', gone.status === 200 || gone.status === 404, `${gone.status} ${gone.text.slice(0, 120)}`);
const created = await call('POST', '/api/admin/accounts', adminToken, {
  name: NAME,
  displayName: '回收站界面测试账号',
  email: `${NAME}@local`,
  groups: ['lab-student'],
  password: `E2e${crypto.randomBytes(6).toString('hex')}aA1`,
});
ok('创建账号', created.status === 200, `${created.status} ${created.text.slice(0, 160)}`);
const prov = await call('POST', `/api/admin/accounts/${NAME}/provision`, adminToken);
ok('初始化个人空间', prov.status === 200, `${prov.status} ${prov.text.slice(0, 160)}`);
const studentToken = mint(NAME);

const form = new FormData();
const content = `ui-trash-${crypto.randomBytes(4).toString('hex')}\n`;
form.append('file', new Blob([content], { type: 'text/plain' }), FILE);
const up = await call('POST', `/api/files/upload?source=users&dir=${NAME}&overwrite=1`, studentToken, form);
ok('上传待删文件', up.status === 200, `${up.status} ${up.text.slice(0, 200)}`);
const diskPath = `${LAB}/users/${NAME}/${FILE}`;
const hashBefore = sha(diskPath);

const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } });
await ctx.addCookies([
  { name: 'labspace_session', value: studentToken, url: BASE },
  { name: 'labspace_csrf', value: CSRF, url: BASE },
]);
const page = await ctx.newPage();
const badStatus = [];
page.on('response', (r) => {
  if (r.status() >= 400 && /\/api\//.test(r.url())) badStatus.push(`${r.status()} ${r.url().replace(BASE, '')}`);
});
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(String(e).slice(0, 160)));

const toastText = async (re, rounds = 14) => {
  for (let i = 0; i < rounds; i += 1) {
    await page.waitForTimeout(400);
    const t = (await page.locator('.ant-message').allInnerTexts().catch(() => [])).join(' ').replace(/\s+/g, ' ');
    if (re.test(t)) return t;
  }
  return '';
};

const rowOf = (label) => page.locator('.ant-table-row', { hasText: label }).first();
const badge = () => page.locator('.ant-badge-count').first();

console.log('# 文件管理页（我的文件）');
await page.goto(`${BASE}/files?source=users`, { waitUntil: 'domcontentloaded' });
await rowOf(FILE).waitFor({ state: 'visible', timeout: 25000 });
ok('列表里能看到该文件', await rowOf(FILE).isVisible());
const trashBtn = page.getByRole('button', { name: '回收站' });
ok('回收站入口存在', await trashBtn.isVisible());
ok('没有删除记录时徽标为空', (await badge().count()) === 0 || (await badge().innerText()) === '');

console.log('# 删除：确认框讲清保留期');
await rowOf(FILE).locator('button[aria-label="更多操作"]').click();
await page.locator('.ant-dropdown-menu-item', { hasText: '删除' }).first().click();
const confirm = page.locator('.ant-modal-confirm').first();
await confirm.waitFor({ state: 'visible', timeout: 8000 });
const confirmText = await confirm.innerText();
ok('确认框标题点名文件', confirmText.includes(FILE), confirmText.slice(0, 160));
ok('确认框说明会进回收站并给出保留天数', /回收站/.test(confirmText) && /保留\s*\d+\s*天/.test(confirmText));
ok('确认框不再谎称不可恢复', !/无法恢复/.test(confirmText));
await confirm.getByRole('button', { name: /移入回收站/ }).click();
const delToast = await toastText(/已移入回收站/);
ok('提示已移入回收站并给出可恢复期限', /前可恢复/.test(delToast), delToast.slice(0, 160));
await page.waitForTimeout(1200);
ok('文件从列表消失', (await rowOf(FILE).count()) === 0);
ok('磁盘上原文件已移走', !existsSync(diskPath));
const rows1 = myRows();
ok('回收站里记账了一条', rows1.length === 1 && rows1[0].name === FILE, JSON.stringify(rows1));
ok('负载落到 .trash', existsSync(`${TRASH}/${rows1[0]?.id}`));
await page.waitForTimeout(1200);
ok('徽标显示 1 条待恢复', (await badge().count()) > 0 && (await badge().innerText()) === '1');
await page.screenshot({ path: 'shots/file-trash-badge.png' });

console.log('# 回收站面板');
await trashBtn.click();
const panel = page.locator('.ant-modal', { hasText: '清空回收站' }).first();
await panel.waitFor({ state: 'visible', timeout: 8000 });
await page.waitForTimeout(700); // 弹窗有入场动画，立刻量只会拿到缩放中的框
const box = await panel.boundingBox();
ok('面板真的弹出来了', Boolean(box) && box.width > 800 && box.height > 200, JSON.stringify(box));
await page.screenshot({ path: 'shots/file-trash-panel.png' });
const panelText = await panel.innerText();
ok('面板列出该条', panelText.includes(FILE), panelText.slice(0, 200));
ok('面板交代原位置', panelText.includes('我的文件') && panelText.includes(`${NAME}/${FILE}`));
ok('面板交代删除时间与删除人', panelText.includes(NAME));
ok('面板给出剩余保留期', /剩\s*\d+\s*天|即将自动清除/.test(panelText));
ok('面板说明到期自动清除', /自动清除/.test(panelText));
const trashRow = panel.locator('.ant-table-row', { hasText: FILE }).first();
ok('恢复按钮可用', await trashRow.getByRole('button', { name: /恢\s*复/ }).isEnabled());

console.log('# 恢复');
await trashRow.getByRole('button', { name: /恢\s*复/ }).click();
const backToast = await toastText(/已恢复到/);
ok('提示恢复到源/路径', /我的文件/.test(backToast), backToast.slice(0, 160));
await page.waitForTimeout(1000);
const panelText2 = await panel.innerText().catch(() => '');
ok('恢复后面板里这一条消失', !panelText2.includes(FILE), panelText2.slice(0, 160));
await panel.locator('.ant-modal-footer').getByRole('button', { name: /关\s*闭/ }).click();
await page.waitForTimeout(1200);
ok('文件回到列表', await rowOf(FILE).isVisible());
ok('磁盘内容逐字节一致', existsSync(diskPath) && sha(diskPath) === hashBefore);
ok('负载已从 .trash 移走', !existsSync(`${TRASH}/${rows1[0].id}`));
ok('徽标清零', (await badge().count()) === 0 || (await badge().innerText()) === '');

console.log('# 彻底删除');
await rowOf(FILE).locator('button[aria-label="更多操作"]').click();
await page.locator('.ant-dropdown-menu-item', { hasText: '删除' }).first().click();
await page.locator('.ant-modal-confirm').first().getByRole('button', { name: /移入回收站/ }).click();
await toastText(/已移入回收站/);
await page.waitForTimeout(1200);
const rows2 = myRows();
ok('第二次删除记账', rows2.length === 1);
await trashBtn.click();
const panel2 = page.locator('.ant-modal', { hasText: '清空回收站' }).first();
await panel2.waitFor({ state: 'visible', timeout: 8000 });
await page.waitForTimeout(700);
await panel2.locator('.ant-table-row', { hasText: FILE }).first().getByRole('button', { name: /彻底删除/ }).click();
const purgeConfirm = page.locator('.ant-modal-confirm', { hasText: '永久清除' }).first();
await purgeConfirm.waitFor({ state: 'visible', timeout: 8000 });
ok('彻底删除前再次确认', (await purgeConfirm.innerText()).includes(FILE));
await purgeConfirm.getByRole('button', { name: /彻底删除/ }).click();
const purgeToast = await toastText(/已彻底删除/);
ok('提示释放的字节数', /释放/.test(purgeToast), purgeToast.slice(0, 160));
await page.waitForTimeout(1200);
ok('负载已不在磁盘', !existsSync(`${TRASH}/${rows2[0].id}`));
ok('清单不再记账', myRows().length === 0);
const panel2Text = await panel2.innerText().catch(() => '');
ok('面板回到空状态', /回收站是空的/.test(panel2Text), panel2Text.slice(0, 160));
await page.screenshot({ path: 'shots/file-trash-empty.png' });

ok('界面过程中没有出现 4xx/5xx', badStatus.length === 0, badStatus.join(' | '));
ok('页面没有 JS 报错', jsErrors.length === 0, jsErrors.join(' | '));
await browser.close();

console.log('# 收尾：删除测试账号');
const removed = await call('DELETE', `/api/admin/accounts/${NAME}`, adminToken, { confirm: NAME });
ok('删除测试账号', removed.status === 200, `${removed.status} ${removed.text.slice(0, 160)}`);
ok('账号没有回收站残留', myRows().length === 0);

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项${fails.length ? '：' + fails.join('；') : ''}`);
if (fails.length) process.exitCode = 1;
