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
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
await page.goto('http://192.0.2.10/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill('labadmin');
await page.locator('#password').fill(CRED.labadmin);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3500);
await page.goto('http://192.0.2.10/baserow', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const result = await page.evaluate(async () => {
  const csrf = (document.cookie.match(/(?:^|;\s*)labspace_csrf=([^;]+)/) || [])[1] || '';
  const call = async (path, opts = {}) => {
    const res = await fetch(path, {
      credentials: 'include',
      ...opts,
      headers: { 'x-csrf-token': decodeURIComponent(csrf), ...(opts.headers || {}) },
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  const out = { steps: [] };
  const step = (name, ok, detail = '') => out.steps.push({ name, ok, detail });
  const overview = await call('/api/baserow/overview');
  step('overview', overview.status === 200 && Array.isArray(overview.data?.workspaces), `${overview.status}`);
  const ws = overview.data?.workspaces?.[0];
  if (!ws) return out;
  out.workspaceId = ws.id;
  const members = await call(`/api/baserow/workspaces/${ws.id}/members`);
  step('members', members.status === 200 && Array.isArray(members.data?.members), `${members.status} ${members.data?.members?.length ?? '?'}`);
  const db = await call(`/api/baserow/workspaces/${ws.id}/databases`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'E2E临时表' }),
  });
  step('createDatabase', db.status < 300, `${db.status}`);
  if (db.status >= 300) return out;
  const table = await call(`/api/baserow/databases/${db.data.id}/tables`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '导入测试' }),
  });
  step('createTable', table.status < 300, `${table.status}`);
  if (table.status >= 300) return out;
  // 新建表后 Baserow 会异步写入字段/样例行，此时建字段可能短暂 409，重试
  let field;
  for (let i = 0; i < 8; i++) {
    field = await call(`/api/baserow/tables/${table.data.id}/fields`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '数量', type: 'text' }),
    });
    if (field.status !== 409) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  step('createField', field.status < 300 && !!field.data?.id, `${field.status} ${JSON.stringify(field.data).slice(0, 120)}`);
  const csv = '名称,数量\n样本A,12\n样本B,34\n';
  const fd = new FormData();
  fd.append('file', new File([csv], 'e2e.csv', { type: 'text/csv' }));
  const imp = await call(`/api/baserow/tables/${table.data.id}/import`, { method: 'POST', body: fd });
  step('importCsv', imp.status === 200 && imp.data?.created === 2, `${imp.status} created=${imp.data?.created}`);
  const rows = await call(`/api/baserow/tables/${table.data.id}/rows?page=1&size=20`);
  // 新建表自带两行空白样例行，这里只校验导入的两条数据存在
  step(
    'rows',
    rows.status === 200 &&
      (rows.data?.count ?? 0) >= 2 &&
      rows.data?.results?.some((r) => r['名称'] === '样本A') &&
      rows.data?.results?.some((r) => r['名称'] === '样本B'),
    `count=${rows.data?.count} names=${JSON.stringify((rows.data?.results || []).map((r) => r['名称']))}`,
  );
  const sample = rows.data?.results?.find((r) => r['名称'] === '样本A');
  step('rowValues', sample?.['数量'] === '12', JSON.stringify(sample || {}));
  // 老式 Mac / 部分 Excel 导出的 CR 换行 CSV 必须能解析
  const crCsv = '编号,备注\rA1,第一行\rA2,第二行\r';
  const fdCr = new FormData();
  fdCr.append('file', new File([crCsv], 'cr.csv', { type: 'text/csv' }));
  const impCr = await call(`/api/baserow/tables/${table.data.id}/import`, { method: 'POST', body: fdCr });
  step('importCrCsv', impCr.status === 200 && impCr.data?.created === 2, `${impCr.status} ${JSON.stringify(impCr.data).slice(0, 120)}`);
  // 带引号的多行字段（合法 CSV）
  const multiline = '编号,备注\nB1,"第一行\n第二行"\n';
  const fdMulti = new FormData();
  fdMulti.append('file', new File([multiline], 'multi.csv', { type: 'text/csv' }));
  const impMulti = await call(`/api/baserow/tables/${table.data.id}/import`, { method: 'POST', body: fdMulti });
  step('importQuotedMultiline', impMulti.status === 200 && impMulti.data?.created === 1, `${impMulti.status} ${JSON.stringify(impMulti.data).slice(0, 120)}`);
  // Baserow 在刚导入/建字段后可能短暂锁住字段（ERROR_FAILED_TO_LOCK_FIELD_DUE_TO_CONFLICT），重试即可
  let ren;
  for (let i = 0; i < 8; i++) {
    ren = await call(`/api/baserow/tables/${table.data.id}/fields/${field.data.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '用量' }),
    });
    if (ren.status !== 409) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  step('renameField', ren.status < 300, `${ren.status} ${typeof ren.data === 'string' ? ren.data : JSON.stringify(ren.data ?? {}).slice(0, 200)}`);
  const fields = await call(`/api/baserow/tables/${table.data.id}/fields`);
  step('fieldRenamed', fields.data?.fields?.some((f) => f.name === '用量'), fields.data?.fields?.map((f) => f.name).join(','));
  const delField = await call(`/api/baserow/tables/${table.data.id}/fields/${field.data.id}`, { method: 'DELETE' });
  step('deleteField', delField.status < 300, `${delField.status}`);
  const delTable = await call(`/api/baserow/tables/${table.data.id}`, { method: 'DELETE' });
  step('deleteTable', delTable.status < 300, `${delTable.status}`);
  const delDb = await call(`/api/baserow/databases/${db.data.id}`, { method: 'DELETE' });
  step('deleteDatabase', delDb.status < 300, `${delDb.status}`);
  return out;
});

for (const s of result.steps) must(s.ok, s.name, s.detail);
must(result.steps.length >= 10, '全部接口步骤执行', String(result.steps.length));
await b.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);