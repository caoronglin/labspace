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
  const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { steps: [] };
  const step = (name, ok, detail = '') => out.steps.push({ name, ok, detail });

  const overview = await call('/api/baserow/overview');
  step('overview', overview.status === 200 && Array.isArray(overview.data?.workspaces), `${overview.status}`);
  const ws = overview.data?.workspaces?.[0];
  if (!ws) return out;

  const db = await call(`/api/baserow/workspaces/${ws.id}/databases`, json('POST', { name: 'E2E人员临时库' }));
  step('createDatabase', db.status < 300 && !!db.data?.id, `${db.status}`);
  if (db.status >= 300) return out;

  const table = await call(`/api/baserow/databases/${db.data.id}/tables`, json('POST', { name: '人员测试' }));
  step('createTable', table.status < 300 && !!table.data?.id, `${table.status}`);
  if (table.status >= 300) return out;
  const tableId = table.data.id;

  const createField = async (body) => {
    let res;
    for (let i = 0; i < 10; i++) {
      res = await call(`/api/baserow/tables/${tableId}/fields`, json('POST', body));
      if (res.status !== 409) break;
      await wait(500);
    }
    return res;
  };

  const titleField = await createField({ name: '标题', type: 'text' });
  step('createTitleField', titleField.status < 300, `${titleField.status}`);

  const started = Date.now();
  const peopleField = await createField({ name: '负责人', type: 'people' });
  const elapsed = Date.now() - started;
  step(
    'createPeopleField',
    peopleField.status < 300 && peopleField.data?.type === 'people' && peopleField.data?.people === true && peopleField.data?.link_row_table_id > 0,
    `${peopleField.status} ${elapsed}ms ${JSON.stringify(peopleField.data).slice(0, 200)}`,
  );
  if (peopleField.status >= 300) return out;
  const mirrorTableId = peopleField.data.link_row_table_id;

  const fields = await call(`/api/baserow/tables/${tableId}/fields`);
  const storedField = (fields.data?.fields || []).find((f) => f.name === '负责人');
  step(
    'fieldExposedAsPeople',
    storedField?.type === 'people' && storedField?.people === true && storedField?.link_row_table_id === mirrorTableId,
    JSON.stringify(storedField || {}).slice(0, 220),
  );

  const tables = await call(`/api/baserow/databases/${db.data.id}/tables`);
  const names = (tables.data?.tables || []).map((t) => t.name);
  step('mirrorTableHidden', !names.includes('系统人员（自动同步）'), names.join(','));
  step('mirrorTableExists', (tables.data?.tables || []).length === 1, `visible=${names.length}`);

  const people = await call(`/api/baserow/tables/${tableId}/people`);
  const list = people.data?.people || [];
  const valid = list.length > 0 && list.every((p) => Number.isFinite(p.row_id) && p.row_id > 0 && !!p.id && !!p.name);
  step('listPeople', people.status === 200 && valid, `${people.status} n=${list.length} sample=${JSON.stringify(list[0] || {}).slice(0, 160)}`);
  const expected = list.length;
  if (!valid) return out;

  const first = list[0];
  const row = await call(`/api/baserow/tables/${tableId}/rows`, json('POST', { 标题: '人员指派测试', 负责人: [first.row_id] }));
  step('createRowWithPerson', row.status < 300 && !!row.data?.id, `${row.status} ${JSON.stringify(row.data).slice(0, 160)}`);
  if (row.status >= 300) return out;

  const rows = await call(`/api/baserow/tables/${tableId}/rows?page=1&size=20`);
  const saved = (rows.data?.results || []).find((r) => r.id === row.data.id);
  const savedIds = (saved?.负责人 || []).map((v) => (v && typeof v === 'object' ? v.id : v));
  step('rowPersonPersisted', savedIds.length === 1 && savedIds[0] === first.row_id, `ids=${JSON.stringify(savedIds)}`);
  step('rowPersonValue', typeof saved?.负责人?.[0] === 'object' && (saved.负责人[0].value === first.displayName || saved.负责人[0].value === first.name), JSON.stringify(saved?.负责人 || []).slice(0, 180));

  if (list.length > 1) {
    const second = list[1];
    const patched = await call(`/api/baserow/tables/${tableId}/rows/${row.data.id}`, json('PATCH', { 负责人: [first.row_id, second.row_id] }));
    step('updateRowPeople', patched.status < 300, `${patched.status}`);
    const rows2 = await call(`/api/baserow/tables/${tableId}/rows?page=1&size=20`);
    const saved2 = (rows2.data?.results || []).find((r) => r.id === row.data.id);
    const ids2 = (saved2?.负责人 || []).map((v) => (v && typeof v === 'object' ? v.id : v));
    step('rowPeopleUpdated', ids2.length === 2 && ids2.includes(first.row_id) && ids2.includes(second.row_id), JSON.stringify(ids2));
  }

  const again = await call(`/api/baserow/tables/${tableId}/people`);
  step('peopleStableAcrossCalls', again.status === 200 && (again.data?.people || []).length >= expected, `n=${(again.data?.people || []).length} expected>=${expected}`);

  const mirrorFields = await call(`/api/baserow/tables/${mirrorTableId}/fields`);
  const mirrorNames = (mirrorFields.data?.fields || []).map((f) => f.name);
  step(
    'mirrorColumns',
    ['姓名', '系统ID', '账号', '邮箱', '分组'].every((n) => mirrorNames.includes(n)),
    mirrorNames.join(','),
  );

  const mirrorField = (mirrorFields.data?.fields || []).find((f) => f.name === '账号');
  if (mirrorField) {
    const blockedRename = await call(`/api/baserow/tables/${mirrorTableId}/fields/${mirrorField.id}`, json('PATCH', { name: '账号2' }));
    step('guardMirrorFieldRename', blockedRename.status === 403 || blockedRename.status === 400, `${blockedRename.status}`);
  }
  const blockedDelete = await call(`/api/baserow/tables/${mirrorTableId}`, { method: 'DELETE' });
  step('guardMirrorTableDelete', blockedDelete.status === 403 || blockedDelete.status === 400, `${blockedDelete.status}`);

  const delTable = await call(`/api/baserow/tables/${tableId}`, { method: 'DELETE' });
  step('deleteTable', delTable.status < 300, `${delTable.status}`);
  const delDb = await call(`/api/baserow/databases/${db.data.id}`, { method: 'DELETE' });
  step('deleteDatabase', delDb.status < 300, `${delDb.status}`);
  return out;
});

for (const s of result.steps) must(s.ok, s.name, s.detail);
must(result.steps.length >= 12, '全部接口步骤执行', String(result.steps.length));
await b.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);