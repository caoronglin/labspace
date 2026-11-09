// 组授权是否真的决定文件操作：用一次性目录 + 无文件权限的 bioinfo-student 组做闭环验证。
// 结束时无条件撤销组授权并删除目录，不改任何内置模板、不碰其他账号。
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const credsFor = (email) => {
  const line = fs
    .readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
    .split('\n')
    .find((l) => l.trimStart().startsWith(email));
  if (!line) throw new Error(`台账缺少 ${email}`);
  return { user: email.split('@')[0], pass: line.trim().split(/\s+/)[1] };
};

let pass = 0;
let fail = 0;
const check = (name, ok, info = '') => {
  ok ? (pass += 1, console.log(`PASS  ${name}${info ? ' :: ' + info : ''}`)) : (fail += 1, console.log(`FAIL  ${name}${info ? ' :: ' + info : ''}`));
};

async function login(browser, email) {
  const { user, pass: pw } = credsFor(email);
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pw);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(5000);
  const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  if (!/工作台|全部服务|文件共享/.test(text)) throw new Error(`${email} 登录失败，停在 ${page.url()}`);
  return { ctx, page };
}

const call = (page, method, url, body) =>
  page.evaluate(
    async ([m, u, b]) => {
      const csrf = document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] || '';
      const r = await fetch(u, {
        method: m,
        headers: b === undefined ? { 'X-CSRF-Token': csrf } : { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
        body: b === undefined ? undefined : JSON.stringify(b),
        credentials: 'include',
      });
      let j = null;
      try {
        j = await r.json();
      } catch {
        /* 忽略非 JSON */
      }
      return { status: r.status, body: j };
    },
    [method, url, body]
  );

const upload = (page, dir, name) =>
  page.evaluate(
    async ([d, n]) => {
      const csrf = document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] || '';
      const fd = new FormData();
      fd.append('file', new Blob(['group-write-proof\n'], { type: 'text/plain' }), n);
      const r = await fetch(`/api/files/upload?source=public&dir=${encodeURIComponent(d)}`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf },
        body: fd,
        credentials: 'include',
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [dir, name]
  );

const GROUP = 'bioinfo-student';
const DIR = '_e2e_gperm';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const admin = await login(browser, 'labadmin@local');
let student = null;

try {
  const pre = await call(admin.page, 'GET', '/api/admin/accounts/groups');
  const row = (pre.body?.groups ?? []).find((g) => g.name === GROUP);
  check('目标组当前无文件权限（可安全试用）', row?.hasFileGrants === false && (row?.members ?? []).includes('student02'), JSON.stringify({ has: row?.hasFileGrants, members: row?.members }));
  if (row?.hasFileGrants) throw new Error(`${GROUP} 已有文件权限，终止以免覆盖真实配置`);

  // 管理员通过内置组 lab-admin 的写授权建目录
  const mk = await call(admin.page, 'POST', '/api/files/mkdir', { source: 'public', path: DIR });
  check('管理员建目录成功（内置组写权限）', mk.status < 300, JSON.stringify(mk.body)?.slice(0, 90));

  student = await login(browser, 'student02@local');
  const before = await call(student.page, 'POST', '/api/files/mkdir', { source: 'public', path: `${DIR}/inner` });
  check('学生默认只读：写操作被拒', before.status === 403, `${before.status} :: ${JSON.stringify(before.body)?.slice(0, 80)}`);
  const listBefore = await call(student.page, 'GET', '/api/files?source=public&sort=name&order=asc');
  check('学生仍能列出该目录（只读不隐藏）', (listBefore.body?.entries ?? []).some((e) => e.path === DIR), `条目 ${listBefore.body?.entries?.length}`);

  const grant = await call(admin.page, 'PUT', `/api/admin/accounts/groups/${GROUP}`, {
    grants: [{ source: 'public', path: DIR, access: 'write' }],
  });
  check('子目录级组授权写入成功', grant.status === 200 && grant.body?.grants?.some((g) => g.path === DIR && g.access === 'write'), JSON.stringify(grant.body?.grants));

  const pv = await call(admin.page, 'POST', '/api/admin/accounts/student02/access-preview');
  const probe = (pv.body?.probes ?? []).find((p) => p.source === 'public' && p.path === DIR);
  check('预演把写权限归因到该组', probe?.actions?.create === true && probe?.origin?.create === `group:${GROUP}`, JSON.stringify(probe));

  const after = await call(student.page, 'POST', '/api/files/mkdir', { source: 'public', path: `${DIR}/inner` });
  check('组授权立即让成员可写子目录', after.status < 300, `${after.status} :: ${JSON.stringify(after.body)?.slice(0, 80)}`);
  const up = await upload(student.page, `${DIR}/inner`, 'proof.txt');
  check('成员上传文件成功', up.status < 300, `${up.status} :: ${JSON.stringify(up.body)?.slice(0, 80)}`);
  const outside = await call(student.page, 'POST', '/api/files/mkdir', { source: 'public', path: `${DIR}_nope` });
  check('写授权不外溢到父层', outside.status === 403, `${outside.status}`);

  // 撤销：删除该组的文件权限后必须马上失效
  const revoke = await call(admin.page, 'DELETE', `/api/admin/accounts/groups/${GROUP}`);
  check('撤销组授权成功', revoke.status === 200, JSON.stringify(revoke.body));
  const lateWrite = await call(student.page, 'POST', '/api/files/mkdir', { source: 'public', path: `${DIR}/inner2` });
  check('撤销后写权限立即收回', lateWrite.status === 403, `${lateWrite.status} :: ${JSON.stringify(lateWrite.body)?.slice(0, 80)}`);
  const stillRead = await call(student.page, 'GET', '/api/files?source=public&sort=name&order=asc');
  check(
    '撤销组写权限后只读继承仍在（只去写、不牵连读）',
    stillRead.status === 200 && (stillRead.body?.entries ?? []).some((e) => e.path === DIR),
    `status=${stillRead.status}`
  );

  // 管理员清理测试目录
  const listing = await call(admin.page, 'GET', '/api/files?source=public&sort=name&order=asc');
  const target = (listing.body?.entries ?? []).find((e) => e.path === DIR);
  const del = target ? await call(admin.page, 'DELETE', `/api/files/${target.id}`) : { status: 'absent' };
  check('测试目录已清理', del.status === 200 || del.status === 'absent', JSON.stringify(del).slice(0, 90));
  const residue = await call(admin.page, 'GET', '/api/files?source=public&sort=name&order=asc');
  check('磁盘上无残留', !(residue.body?.entries ?? []).some((e) => e.path === DIR || e.path.startsWith(`${DIR}/`)), '');
  const finalGroups = await call(admin.page, 'GET', '/api/admin/accounts/groups');
  const frow = (finalGroups.body?.groups ?? []).find((g) => g.name === GROUP);
  check('目标组回到未配置状态', frow?.hasFileGrants === false, JSON.stringify(frow?.grants));
  const builtinIntact = (finalGroups.body?.groups ?? []).filter((g) => g.builtin).map((g) => `${g.name}:${g.grants.length}`);
  check('三个内置模板未被波及', builtinIntact.join(',') === 'lab-admin:4,lab-student:3,lab-teacher:3', builtinIntact.join(','));
} finally {
  await call(admin.page, 'DELETE', `/api/admin/accounts/groups/${GROUP}`).catch(() => {});
  const listing = await call(admin.page, 'GET', '/api/files?source=public&sort=name&order=asc');
  const target = (listing.body?.entries ?? []).find((e) => e.path === DIR);
  if (target) await call(admin.page, 'DELETE', `/api/files/${target.id}`).catch(() => {});
  const after = await call(admin.page, 'GET', '/api/admin/accounts/groups');
  const row = (after.body?.groups ?? []).find((g) => g.name === GROUP);
  const gone = !(await call(admin.page, 'GET', '/api/files?source=public&sort=name&order=asc')).body?.entries?.some((e) => e.path === DIR);
  console.log(`\n兜底复查：${GROUP} hasFileGrants=${row?.hasFileGrants} 目录残留=${gone ? '无' : '有'}`);
  await student?.ctx.close();
  await admin.ctx.close();
}

await browser.close();
console.log(`\n合计：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
