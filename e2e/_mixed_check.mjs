// 混合目录权限：项目根目录只读 + grp-rnaseq 读写
import { chromium } from 'playwright';
import fs from 'node:fs';

let failed = 0;
const must = (c, l, e = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${l}${e ? ' — ' + e : ''}`); if (!c) failed++; };
const CRED = {};
for (const line of fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const [email, pass] = t.split(/\s+/); if (email && pass) CRED[email.split('@')[0]] = pass;
}
let TOKEN = '';
TOKEN = fs.readFileSync('/etc/lab-go/labgo.env', 'utf8').split('\n').find((l) => l.startsWith('LABSPACE_SERVICE_TOKEN=')).split('=').slice(1).join('=').trim().replace(/^"|"$/g, '');
async function admin(method, path, body) {
  const r = await fetch('http://172.28.0.1:8122' + path, {
    method, headers: { 'X-Lab-Service-Token': TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const before = await admin('GET', '/v1/admin/file-access');
const original = before.body.scopes.student01;
const mixed = [
  ...original.filter((g) => !(g.source === 'projects' && g.path === '')),
  { source: 'projects', path: '', access: 'read' },
  { source: 'projects', path: 'grp-rnaseq', access: 'write' },
].filter((g, i, arr) => arr.findIndex((x) => x.source === g.source && x.path === g.path) === i);
const put = await admin('PUT', '/v1/admin/file-access/student01', { grants: mixed });
must(put.status === 200, '设置混合授权（根只读 + 子目录读写）', String(put.status));

const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
await page.goto('http://192.0.2.10/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill('student01');
await page.locator('#password').fill(CRED.student01);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(4000);
const call = (path, init = {}) => page.evaluate(async ([p, i]) => {
  const csrf = (document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
  const headers = { ...(i.headers || {}) };
  if (i.method && i.method !== 'GET') headers['X-CSRF-Token'] = decodeURIComponent(csrf);
  const r = await fetch(p, { credentials: 'include', ...i, headers });
  const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}, [path, init]);
const upload = (dir, name) => page.evaluate(async ([d, n]) => {
  const csrf = (document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
  const fd = new FormData(); fd.append('file', new File(['probe'], n, { type: 'text/plain' }));
  const r = await fetch(`/api/files/upload?source=projects&dir=${encodeURIComponent(d)}&overwrite=1`, {
    method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': decodeURIComponent(csrf) }, body: fd,
  });
  return { status: r.status };
}, [dir, name]);

const src = await call('/api/files/sources');
const proj = (src.body?.sources ?? []).find((s) => s.id === 'projects');
must(proj?.writable === true, 'projects 源整体可写（存在子目录写权限）');
must(JSON.stringify(proj?.writePaths) === JSON.stringify(['grp-rnaseq']), 'writePaths 精确到 grp-rnaseq', JSON.stringify(proj?.writePaths));

await page.goto('http://192.0.2.10/files?source=projects', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
let body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(body.includes('当前目录只读'), '项目根目录显示“当前目录只读”');
must(!body.includes('上传文件'), '项目根目录隐藏上传入口');
await page.locator('tr', { hasText: 'grp-rnaseq' }).first().getByRole('button', { name: '打开' }).click();
await page.waitForTimeout(1200);
body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(body.includes('上传文件') && body.includes('新建文件夹'), '授权子目录显示上传/新建入口');
must(!body.includes('当前目录只读'), '授权子目录不显示只读标识');
await page.screenshot({ path: '/opt/labspace/e2e/shots/_files_mixed_acl.png' });

const rootUp = await upload('', '_acl_root_denied.txt');
must(rootUp.status === 403, '根目录上传被拒绝', String(rootUp.status));
const subUp = await upload('grp-rnaseq', '_acl_mixed_probe.txt');
must(subUp.status === 200, '子目录上传成功', String(subUp.status));
const list = await call('/api/files?source=projects');
const probe = (list.body?.entries ?? []).find((e) => e.name === '_acl_mixed_probe.txt');
const del = await call(`/api/files/${probe?.id}`, { method: 'DELETE' });
must(del.status === 200, '子目录删除成功（清理探针）', String(del.status));

// 还原原始授权
const restore = await admin('PUT', '/v1/admin/file-access/student01', { grants: original });
must(restore.status === 200, '还原 student01 原始授权', String(restore.status));
const after = await admin('GET', '/v1/admin/file-access');
const now = (after.body.scopes.student01 ?? []).map((g) => `${g.source}:${g.path}:${g.access}`).sort();
const want = original.map((g) => `${g.source}:${g.path}:${g.access}`).sort();
must(JSON.stringify(now) === JSON.stringify(want), 'ACL 与测试前一致', now.join(','));
await b.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
