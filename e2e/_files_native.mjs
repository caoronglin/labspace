// 原生文件网盘：上传 / 新建目录 / 重命名 / 预览 / 下载 / 删除 / ACL 实测
import { chromium } from 'playwright';

const BASE = 'http://192.0.2.10';
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

const marker = `native-file-drive-${Date.now()}`;
const s1 = await session('student01', process.env.LAB_S1_PASS);
const s2 = await session('student02', process.env.LAB_S2_PASS);

const src1 = await s1.call('/api/files/sources');
const users1 = (src1.body?.sources ?? []).find((x) => x.id === 'users');
must(users1?.writable === true, 'student01 个人文件源标记为可写');
const pub1 = (src1.body?.sources ?? []).find((x) => x.id === 'public');
must(pub1?.writable === false, '公共资料对 student01 只读');

const list0 = await s1.call('/api/files?source=users');
const entries0 = list0.body?.entries ?? [];
const ownDir = entries0.find((e) => e.dir && e.path === 'student01') || entries0.find((e) => e.dir);
must(!!ownDir, '定位 student01 个人目录', ownDir?.path || '');
const dir = ownDir?.path || 'student01';

// 上传
const up = await s1.upload('users', dir, '_native_probe.txt', marker);
must(up.status === 200 && up.body?.entry?.name === '_native_probe.txt', '上传文件', `status=${up.status}`);
const fileId = up.body?.entry?.id || '';

// 列表 / 预览 / 下载
const list1 = await s1.call('/api/files?source=users');
const found = (list1.body?.entries ?? []).find((e) => e.id === fileId);
must(!!found, '上传后列表可见');
const prev = await s1.call(`/api/files/${fileId}/preview`);
must(prev.status === 200 && String(prev.body?.text || '').includes(marker), '预览内容一致');
const dl = await s1.page.evaluate(async (id) => {
  const r = await fetch(`/api/files/${id}/download`, { credentials: 'include' });
  return { status: r.status, text: await r.text() };
}, fileId);
must(dl.status === 200 && dl.text.includes(marker), '下载内容一致');

// 新建目录 + 上传到新目录 + 重命名
const mk = await s1.call('/api/files/mkdir', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ source: 'users', path: `${dir}/_native_dir` }),
});
must(mk.status === 200 && mk.body?.entry?.dir === true, '新建文件夹', `status=${mk.status}`);
const up2 = await s1.upload('users', `${dir}/_native_dir`, '_inner.txt', marker + '-inner');
must(up2.status === 200, '上传到新建文件夹', `status=${up2.status}`);
const rename = await s1.call('/api/files/rename', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: up2.body?.entry?.id, name: '_inner_renamed.txt' }),
});
must(rename.status === 200 && rename.body?.entry?.name === '_inner_renamed.txt', '重命名文件', `status=${rename.status}`);

// ACL：student02 不能删除或写入 student01 的空间
const s2list = await s2.call('/api/files?source=users');
must(!(s2list.body?.entries ?? []).some((e) => e.id === fileId), 'student02 列表中看不到 student01 文件');
const s2del = await s2.call(`/api/files/${fileId}`, { method: 'DELETE' });
must(s2del.status === 404, 'student02 删除他人文件被拒绝', String(s2del.status));
const s2up = await s2.upload('users', dir, '_stolen.txt', 'x');
must(s2up.status === 403, 'student02 写入他人目录被拒绝', String(s2up.status));

// 公共目录只读
const pubUp = await s1.upload('public', '', '_should_fail.txt', 'x');
must(pubUp.status === 403, '只读公共目录拒绝上传', String(pubUp.status));

// 清理
const delInner = await s1.call(`/api/files/${rename.body?.entry?.id}`, { method: 'DELETE' });
must(delInner.status === 200, '删除重命名后的文件', String(delInner.status));
const delDir = await s1.call(`/api/files/${mk.body?.entry?.id}`, { method: 'DELETE' });
must(delDir.status === 200, '删除新建文件夹', String(delDir.status));
const delFile = await s1.call(`/api/files/${fileId}`, { method: 'DELETE' });
must(delFile.status === 200, '删除上传文件', String(delFile.status));
const list2 = await s1.call('/api/files?source=users');
must(!(list2.body?.entries ?? []).some((e) => e.id === fileId), '清理后列表不可见');

await s1.b.close();
await s2.b.close();
console.log(failed ? `\nFAILED ${failed}` : '\nALL PASS');
process.exit(failed ? 1 : 0);
