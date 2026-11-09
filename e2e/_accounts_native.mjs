// 统一账号管理：创建账号 → 个人文件空间初始化 → 项目目录授权 → 真实登录与 ACL 实测
import { chromium } from 'playwright';

const BASE = 'http://192.0.2.10';
const ADMIN_USER = process.env.LAB_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.LAB_ADMIN_PASS || '';
const stamp = Date.now().toString(36).slice(-6);
const TMP_USER = `qa${stamp}`;
const TMP_PASS_PREFIX = 'Qa-';

let failed = 0;
function must(cond, label, extra = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
}

async function session(user, pass) {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#password', { timeout: 40000 });
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(3500);
  const call = (path, init = {}) =>
    page.evaluate(
      async ([p, i]) => {
        const csrf = (document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
        const headers = { ...(i.headers || {}) };
        if (i.method && i.method !== 'GET') headers['X-CSRF-Token'] = decodeURIComponent(csrf);
        const r = await fetch(p, { credentials: 'include', ...i, headers });
        const text = await r.text();
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        return { status: r.status, body };
      },
      [path, init],
    );
  const upload = (source, dir, name, content) =>
    page.evaluate(
      async ([s, d, n, c]) => {
        const csrf = (document.cookie.split('; ').find((x) => x.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
        const fd = new FormData();
        fd.append('file', new File([c], n, { type: 'text/plain' }));
        const r = await fetch(`/api/files/upload?source=${encodeURIComponent(s)}&dir=${encodeURIComponent(d)}`, {
          method: 'POST',
          body: fd,
          credentials: 'include',
          headers: { 'X-CSRF-Token': decodeURIComponent(csrf) },
        });
        return { status: r.status, body: await r.json().catch(() => null) };
      },
      [source, dir, name, content],
    );
  return { b, page, call, upload };
}

const admin = await session(ADMIN_USER, ADMIN_PASS);
const me = await admin.call('/api/me');
must(me.status === 200 && me.body?.isAdmin === true, '管理员登录', `status=${me.status}`);

await admin.page.goto(`${BASE}/admin/users`, { waitUntil: 'domcontentloaded' });
await admin.page.getByText('统一账号', { exact: false }).first().waitFor({ timeout: 30000 });
must(true, '打开用户和权限页面');

// ---- 新建账号（真实 UI） ----
await admin.page.getByRole('button', { name: /新建账号/ }).click();
const createModal = admin.page.locator('.ant-modal').filter({ hasText: '新建账号' }).last();
await createModal.waitFor({ state: 'visible' });
await createModal.locator('#name').fill(TMP_USER);
must(
  (await createModal.locator('#email').inputValue()) === `${TMP_USER}@local`,
  '用户名自动生成邮箱',
);
await createModal.getByRole('button', { name: /学\s*生/ }).click();
await createModal.getByRole('button', { name: /生成强口令/ }).click();
const tempPass = await createModal.locator('#password').inputValue();
must(
  tempPass.length >= 14 && /[A-Z]/.test(tempPass) && /[a-z]/.test(tempPass) && /[0-9]/.test(tempPass),
  '生成强口令',
  `长度=${tempPass.length}`,
);
await createModal.getByRole('button', { name: /创\s*建/ }).click();
const createdDialog = admin.page.locator('.ant-modal').filter({ hasText: '账号已创建' }).last();
await createdDialog.waitFor({ state: 'visible', timeout: 20000 });
const createdText = await createdDialog.textContent();
must(createdText.includes(TMP_USER), '创建成功弹窗显示用户名');
must(createdText.includes(tempPass), '创建成功弹窗显示初始口令');
await createdDialog.getByRole('button', { name: /完\s*成/ }).click();
await createdDialog.waitFor({ state: 'hidden' }).catch(() => {});

const row = admin.page.locator('tr.ant-table-row').filter({ hasText: TMP_USER }).first();
await row.waitFor({ timeout: 15000 });
must(!(await row.textContent()).includes('未初始化'), '账号行已出现');

const listed = await admin.call(`/api/admin/accounts?q=${encodeURIComponent(TMP_USER)}`);
const created = (listed.body?.accounts ?? []).find((a) => a.name === TMP_USER);
must(listed.status === 200 && !!created, '账号写入 Casdoor');
must(created?.homeReady === true, '个人文件空间已初始化');
must(Array.isArray(created?.projects) && created.projects.length === 0, '默认无项目目录授权');
const accessMeta = listed.body ?? {};
must(accessMeta.fileAccessAvailable === true, '文件权限接口可用');

// ---- 授予项目目录（真实 UI） ----
await row.getByRole('button', { name: /编\s*辑/ }).click();
const editModal = admin.page.locator('.ant-modal').filter({ hasText: `编辑账号：${TMP_USER}` }).last();
await editModal.waitFor({ state: 'visible' });
must(
  (await editModal.textContent()).includes('个人文件空间已就绪'),
  '编辑弹窗显示文件空间状态',
);
await editModal.locator('#projects').click();
await admin.page
  .locator('.ant-select-dropdown:visible .ant-select-item-option')
  .filter({ hasText: 'grp-mcn' })
  .first()
  .click();
await editModal.getByRole('button', { name: /保\s*存/ }).click();
await admin.page.waitForTimeout(1500);

const listed2 = await admin.call(`/api/admin/accounts?q=${encodeURIComponent(TMP_USER)}`);
const updated = (listed2.body?.accounts ?? []).find((a) => a.name === TMP_USER);
must(
  updated?.projects?.includes('grp-mcn') === true,
  '项目目录授权已保存',
  JSON.stringify(updated?.projects ?? []),
);
must(
  (await admin.page.locator('tr.ant-table-row').filter({ hasText: TMP_USER }).first().textContent()).includes('grp-mcn'),
  '账号行显示共享目录',
);

const adminFiles = await admin.call('/api/files?source=users');
const adminSeesTmp = (adminFiles.body?.entries ?? []).some((e) => e.path === TMP_USER);
must(adminFiles.status === 200 && !adminSeesTmp, '管理员看不到他人个人目录');

// ---- 新账号真实登录并验证文件 ACL ----
const user = await session(TMP_USER, tempPass);
const userMe = await user.call('/api/me');
must(userMe.status === 200 && userMe.body?.name === TMP_USER, '新账号可登录门户', `status=${userMe.status}`);

const sources = await user.call('/api/files/sources');
const srcUsers = (sources.body?.sources ?? []).find((s) => s.id === 'users');
const srcProjects = (sources.body?.sources ?? []).find((s) => s.id === 'projects');
const srcPublic = (sources.body?.sources ?? []).find((s) => s.id === 'public');
must(srcUsers?.writable === true, '个人文件空间可写');
must(srcProjects?.writable === true, '项目共享目录可写');
must(srcPublic?.writable === false, '公共资料保持只读');

const ownList = await user.call('/api/files?source=users');
must(
  (ownList.body?.entries ?? []).some((e) => e.dir && e.path === TMP_USER),
  '新账号能看到自己的目录',
);

const projList = await user.call('/api/files?source=projects');
const projPaths = (projList.body?.entries ?? []).map((e) => e.path);
must(projPaths.includes('grp-mcn'), '已授权项目目录可见');
must(!projPaths.some((p) => p.startsWith('grp-rnaseq')), '未授权项目目录不可见');

const marker = `account-provision-${stamp}`;
const up = await user.upload('users', TMP_USER, '_account_probe.txt', marker);
must(up.status === 200, '个人目录上传成功', `status=${up.status}`);
const afterUpload = await user.call('/api/files?source=users');
must(
  (afterUpload.body?.entries ?? []).some((e) => e.path === `${TMP_USER}/_account_probe.txt`),
  '上传后个人目录列表可见',
);
const adminFiles2 = await admin.call('/api/files?source=users');
must(
  !(adminFiles2.body?.entries ?? []).some((e) => e.path.startsWith(`${TMP_USER}/`)),
  '管理员仍看不到新账号文件',
);

console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
console.log(`TMP_USER=${TMP_USER}`);

await user.b.close();
await admin.b.close();
process.exit(failed ? 1 : 0);
