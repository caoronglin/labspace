// 公共质粒 + ACL 目录级读写：真实浏览器 + 接口实测
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://192.0.2.10';
let failed = 0;
function must(cond, label, extra = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
}

function ledger() {
  const out = {};
  for (const line of fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [email, pass] = t.split(/\s+/);
    if (!email || !pass) continue;
    out[email.split('@')[0]] = pass;
  }
  return out;
}
const CRED = ledger();

const launch = () => chromium.launch({ args: ['--no-sandbox'] });

async function session(user) {
  const b = await launch();
  const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#password', { timeout: 40000 });
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(CRED[user]);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(4000);
  const call = (path, init = {}) =>
    page.evaluate(
      async ([p, i]) => {
        const csrf = (document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
        const headers = { ...(i.headers || {}) };
        if (i.method && i.method !== 'GET') headers['X-CSRF-Token'] = decodeURIComponent(csrf);
        const r = await fetch(p, { credentials: 'include', ...i, headers });
        const text = await r.text();
        let body = null;
        try { body = JSON.parse(text); } catch { body = text; }
        return { status: r.status, body };
      },
      [path, init],
    );
  const upload = (source, dir, name, content) =>
    page.evaluate(
      async ([s, d, n, c]) => {
        const csrf = (document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
        const fd = new FormData();
        fd.append('file', new File([c], n, { type: 'text/plain' }));
        const r = await fetch(
          `/api/files/upload?source=${encodeURIComponent(s)}&dir=${encodeURIComponent(d)}&overwrite=1`,
          { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': decodeURIComponent(csrf) }, body: fd },
        );
        const text = await r.text();
        let body = null;
        try { body = JSON.parse(text); } catch { body = text; }
        return { status: r.status, body };
      },
      [source, dir, name, content],
    );
  return { b, page, call, upload, errors };
}

const adm = await session('labadmin');
const s1 = await session('student01');

// ---------- 1. 账号接口：目录清单与读写授权 ----------
const acc = await adm.call('/api/admin/accounts');
must(acc.status === 200, '管理员可读取账号列表', String(acc.status));
const accounts = acc.body?.accounts ?? [];
const student = accounts.find((a) => a.name === 'student01');
must(Boolean(student), '账号列表包含 student01');
must(
  (student?.fileGrants ?? []).some((g) => g.source === 'projects' && g.path === 'grp-rnaseq' && g.access === 'write'),
  'student01 初始对 grp-rnaseq 有读写授权',
  JSON.stringify(student?.fileGrants),
);
must((acc.body?.directories?.plasmids ?? []).includes('克隆载体'), '目录清单包含公共质粒/克隆载体');
must((acc.body?.directories?.plasmids ?? []).includes('表达载体'), '目录清单包含公共质粒/表达载体');

// ---------- 2. 管理页：文件权限列与授权编辑器 ----------
await adm.page.goto(`${BASE}/admin/users`, { waitUntil: 'domcontentloaded' });
await adm.page.getByText('统一账号', { exact: false }).first().waitFor({ timeout: 30000 });
await adm.page.waitForTimeout(1200);
must(
  (await adm.page.getByRole('columnheader', { name: '文件权限' }).count()) > 0,
  '账号表存在“文件权限”列',
);
const adminRow = adm.page.locator('tr', { hasText: 'student01' }).first();
const rowText = await adminRow.innerText();
must(rowText.includes('grp-rnaseq') && rowText.includes('读写'), '账号表展示 student01 读写授权', rowText.replace(/\s+/g, ' ').slice(0, 160));

await adminRow.getByRole('button', { name: '编辑' }).click();
const dialog = adm.page.locator('.ant-modal-container');
await dialog.waitFor({ timeout: 15000 });
const dialogText = (await dialog.innerText()).replace(/\s+/g, ' ');
must(dialogText.includes('文件目录权限'), '编辑弹窗包含目录级权限编辑器');
must(dialogText.includes('只读可查看/下载'), '编辑器包含只读/读写说明');
await adm.page.screenshot({ path: '/opt/labspace/e2e/shots/_admin_grants_modal.png', fullPage: false });

// 将 grp-rnaseq 由「读写」改为「只读」
const accessSel = dialog.locator('.ant-select').filter({ hasText: '读写' }).first();
await accessSel.click();
const dropdown = adm.page.locator('.ant-select-dropdown:visible');
await dropdown.getByText('只读', { exact: true }).first().click();
await adm.page.getByRole('button', { name: /保\s*存/ }).last().click();
await adm.page.waitForTimeout(2500);
must(!(await dialog.isVisible().catch(() => false)), '保存后编辑弹窗关闭');

const acc2 = await adm.call('/api/admin/accounts');
const student2 = (acc2.body?.accounts ?? []).find((a) => a.name === 'student01');
const projectGrant = (student2?.fileGrants ?? []).find((g) => g.source === 'projects' && g.path === 'grp-rnaseq');
must(projectGrant?.access === 'read', 'grp-rnaseq 已降级为只读', JSON.stringify(projectGrant));

// ---------- 3. student01：只读目录仅可查看/下载 ----------
const src1 = await s1.call('/api/files/sources');
const projSrc = (src1.body?.sources ?? []).find((s) => s.id === 'projects');
must(projSrc?.writable === false, 'projects 源对 student01 不可写', JSON.stringify(projSrc));
must((projSrc?.writePaths ?? []).length === 0, 'projects 源无可写目录');
const plasmidSrc = (src1.body?.sources ?? []).find((s) => s.id === 'plasmids');
must(plasmidSrc?.listable === true && plasmidSrc?.writable === false, '公共质粒可浏览但只读');

// 管理员放入探针文件
const probeUp = await adm.upload('projects', 'grp-rnaseq', '_acl_probe.txt', 'acl probe');
must(probeUp.status === 200, '管理员可在 grp-rnaseq 上传探针', String(probeUp.status));
const projList = await adm.call('/api/files?source=projects');
const probe = (projList.body?.entries ?? []).find((e) => e.name === '_acl_probe.txt');
must(Boolean(probe), '探针文件已进入项目目录');

const deniedUp = await s1.upload('projects', 'grp-rnaseq', '_acl_denied.txt', 'x');
must(deniedUp.status === 403, '只读用户上传被拒绝', String(deniedUp.status));
const deniedDel = await s1.call(`/api/files/${probe?.id}`, { method: 'DELETE' });
must(deniedDel.status === 403, '只读用户删除被拒绝', String(deniedDel.status));
const deniedRen = await s1.call('/api/files/rename', {
  method: 'POST',
  body: JSON.stringify({ id: probe?.id, name: '_acl_renamed.txt' }),
  headers: { 'Content-Type': 'application/json' },
});
must(deniedRen.status === 403, '只读用户重命名被拒绝', String(deniedRen.status));
const allowedPrev = await s1.call(`/api/files/${probe?.id}/preview`);
must(allowedPrev.status === 200, '只读用户仍可预览', String(allowedPrev.status));
const allowedDl = await s1.page.evaluate(async (id) => {
  const r = await fetch(`/api/files/${id}/download`, { credentials: 'include' });
  return { status: r.status, len: (await r.arrayBuffer()).byteLength };
}, probe?.id);
must(allowedDl.status === 200 && allowedDl.len > 0, '只读用户仍可下载', JSON.stringify(allowedDl));

await s1.page.goto(`${BASE}/files?source=projects`, { waitUntil: 'domcontentloaded' });
await s1.page.waitForTimeout(2000);
const s1body = (await s1.page.locator('body').innerText()).replace(/\s+/g, ' ');
must(!s1body.includes('上传文件') && !s1body.includes('新建文件夹'), '只读目录界面隐藏上传/新建入口');
must(s1body.includes('只读'), '只读目录界面显示“只读”标识');
const moreButtons = await s1.page.getByRole('button', { name: '更多操作' }).count();
must(moreButtons === 0, '只读目录界面隐藏行内更多操作', String(moreButtons));
await s1.page.screenshot({ path: '/opt/labspace/e2e/shots/_files_readonly.png', fullPage: false });

// ---------- 4. 公共质粒：浏览与预览 ----------
await s1.page.goto(`${BASE}/files`, { waitUntil: 'domcontentloaded' });
await s1.page.getByText('公共质粒', { exact: true }).first().waitFor({ timeout: 20000 });
await s1.page.getByText('公共质粒', { exact: true }).first().click();
await s1.page.waitForTimeout(1800);
let plasBody = (await s1.page.locator('body').innerText()).replace(/\s+/g, ' ');
must(plasBody.includes('克隆载体') && plasBody.includes('植物双元载体') && plasBody.includes('表达载体'), '公共质粒展示三个分类目录');
await s1.page.locator('tr', { hasText: '克隆载体' }).first().getByRole('button', { name: '打开' }).click();
await s1.page.waitForTimeout(1500);
plasBody = (await s1.page.locator('body').innerText()).replace(/\s+/g, ' ');
must(plasBody.includes('pUC19_L09137.gb'), '克隆载体目录包含 pUC19 GenBank 文件');
await s1.page.locator('tr', { hasText: 'pUC19_L09137.gb' }).first().getByRole('button', { name: '预览' }).click();
const previewDialog = s1.page.locator('.ant-modal-container');
await previewDialog.waitFor({ timeout: 20000 });
await s1.page.waitForTimeout(1500);
const previewText = await previewDialog.innerText();
must(/LOCUS|pUC19|GenBank/i.test(previewText), 'GenBank 文件可原生预览', previewText.replace(/\s+/g, ' ').slice(0, 120));
must(!previewText.includes('文件格式未纳入允许的预览器'), 'GenBank 预览不再提示格式不支持');
await s1.page.screenshot({ path: '/opt/labspace/e2e/shots/_files_plasmid_preview.png', fullPage: false });
const puc = (await s1.call('/api/files?source=plasmids')).body?.entries?.find((e) => e.name === 'pUC19_L09137.gb');
const pucDl = await s1.page.evaluate(async (id) => {
  const r = await fetch(`/api/files/${id}/download`, { credentials: 'include' });
  return { status: r.status, len: (await r.arrayBuffer()).byteLength };
}, puc?.id);
must(pucDl.status === 200 && pucDl.len > 1000, '质粒文件可下载原文件', JSON.stringify(pucDl));

// ---------- 5. 恢复读写并验证写权限即时生效 ----------
const s1Grants = (student2?.fileGrants ?? []).map((g) =>
  g.source === 'projects' && g.path === 'grp-rnaseq' ? { ...g, access: 'write' } : g,
);
const restore = await adm.call('/api/admin/accounts/student01/file-access', {
  method: 'PUT',
  body: JSON.stringify({ grants: s1Grants }),
  headers: { 'Content-Type': 'application/json' },
});
must(restore.status === 200, '恢复 grp-rnaseq 读写授权', String(restore.status));
const src2 = await s1.call('/api/files/sources');
const projSrc2 = (src2.body?.sources ?? []).find((s) => s.id === 'projects');
must(projSrc2?.writable === true, '恢复后 projects 源可写');
const wrote = await s1.upload('projects', 'grp-rnaseq', '_acl_probe2.txt', 'acl probe 2');
must(wrote.status === 200, '恢复后 student01 可上传', String(wrote.status));
const list2 = await s1.call('/api/files?source=projects');
const probe2 = (list2.body?.entries ?? []).find((e) => e.name === '_acl_probe2.txt');
const del2 = await s1.call(`/api/files/${probe2?.id}`, { method: 'DELETE' });
must(del2.status === 200, '恢复后 student01 可删除', String(del2.status));
await adm.call(`/api/files/${probe?.id}`, { method: 'DELETE' });

must(adm.errors.length === 0, '管理页无脚本异常', adm.errors.join('; '));
must(s1.errors.length === 0, '文件页无脚本异常', s1.errors.join('; '));

await adm.b.close();
await s1.b.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
