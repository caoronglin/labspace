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
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
await page.goto('http://192.0.2.10/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill('labadmin');
await page.locator('#password').fill(CRED.labadmin);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3500);
await page.goto('http://192.0.2.10/baserow', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const setup = await page.evaluate(async () => {
  const csrf = (document.cookie.match(/(?:^|;\s*)labspace_csrf=([^;]+)/) || [])[1] || '';
  const call = async (path, opts = {}) => {
    const res = await fetch(path, {
      credentials: 'include', ...opts,
      headers: { 'x-csrf-token': decodeURIComponent(csrf), ...(opts.headers || {}) },
    });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const overview = await call('/api/baserow/overview');
  const ws = overview.data?.workspaces?.[0];
  if (!ws) return { error: 'no workspace' };
  for (const d of ws.databases || []) {
    if (d.name === 'E2E人员界面库') await call(`/api/baserow/databases/${d.id}`, { method: 'DELETE' });
  }
  const db = await call(`/api/baserow/workspaces/${ws.id}/databases`, json('POST', { name: 'E2E人员界面库' }));
  if (db.status >= 300) return { error: `db ${db.status} ${JSON.stringify(db.data)}` };
  const table = await call(`/api/baserow/databases/${db.data.id}/tables`, json('POST', { name: '人员界面测试' }));
  if (table.status >= 300) return { error: `table ${table.status} ${JSON.stringify(table.data)}` };
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
  await createField({ name: '标题', type: 'text' });
  const pf = await createField({ name: '负责人', type: 'people' });
  const people = await call(`/api/baserow/tables/${tableId}/people`);
  return {
    dbId: db.data.id, tableId, workspaceName: ws.name,
    peopleFieldStatus: pf.status,
    people: (people.data?.people || []).map((p) => ({ row_id: p.row_id, name: p.name, displayName: p.displayName })),
  };
});
if (setup.error) {
  console.log('FAIL setup — ' + setup.error);
  await b.close();
  process.exit(1);
}
must(setup.peopleFieldStatus === 200, 'setup people field', String(setup.peopleFieldStatus));
must(setup.people.length > 0, 'setup people list', `n=${setup.people.length}`);
const target = setup.people.find((p) => p.name === 'labadmin') || setup.people[0];
const targetLabel = target.displayName || target.name;

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

const openWraps = page.locator('.ant-modal-wrap:visible');
if (await openWraps.count()) {
  console.log('open modals at start:', JSON.stringify(await openWraps.allInnerTexts()));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
}

const toolbar = page.locator('.ant-card').filter({ has: page.getByRole('button', { name: '刷新' }) }).first();
const selects = toolbar.locator('.ant-select');
must((await selects.count()) >= 3, 'toolbar selectors', String(await selects.count()));

async function pickSelect(index, optionText) {
  await selects.nth(index).click();
  const opt = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ hasText: optionText }).first();
  await opt.waitFor({ state: 'visible', timeout: 15000 });
  await opt.click();
  await page.waitForTimeout(1500);
}

await pickSelect(0, setup.workspaceName);
await pickSelect(1, 'E2E人员界面库');
await pickSelect(2, '人员界面测试');

console.log('toolbar values:', JSON.stringify(await selects.allInnerTexts()));
await page.screenshot({ path: '/opt/labspace/e2e/shots/_baserow_people_toolbar.png', fullPage: true });
const heading = page.locator('.ant-card-head-title').filter({ hasText: '人员界面测试' }).first();
must(await heading.isVisible().catch(() => false), 'UI table selected');
const headerLoaded = await page.locator('.ant-table-thead').getByText('负责人', { exact: true })
  .waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
must(headerLoaded, 'people field column rendered', (await page.locator('.ant-table-thead').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160));

await page.getByRole('button', { name: '新增记录' }).last().click();
await page.waitForTimeout(800);
console.log('modal titles after click:', JSON.stringify(await page.locator('.ant-modal-title').allInnerTexts()));
console.log('modal content count:', await page.locator('.ant-modal-content').count(), JSON.stringify((await page.locator('.ant-modal-content').allInnerTexts()).map((t) => t.slice(0, 60))));
console.log('modal dom:', await page.evaluate(() => {
  const t = document.querySelector('.ant-modal-title');
  if (!t) return 'no title';
  const chain = [];
  let el = t;
  for (let i = 0; i < 7 && el; i++) { chain.push(`${el.tagName}.${String(el.className).slice(0, 80)}`); el = el.parentElement; }
  return chain.join(' <- ');
}));
const modal = page.locator('.ant-modal-container').filter({ hasText: '新增记录' }).last();
await modal.waitFor({ state: 'visible', timeout: 10000 });
console.log('modal text:', JSON.stringify((await modal.innerText()).replace(/\s+/g, ' ').slice(0, 400)));
console.log('form item count:', await modal.locator('.ant-form-item').count());
console.log('form labels:', JSON.stringify(await modal.locator('.ant-form-item-label').allInnerTexts()));
console.log('select count:', await modal.locator('.ant-select').count(), 'selector count:', await modal.locator('.ant-select-selector').count());

await modal.locator('.ant-form-item').filter({ hasText: '标题' }).locator('input').fill('界面指派测试');
const peopleItem = modal.locator('.ant-form-item').filter({ hasText: '负责人' });
await peopleItem.locator('.ant-select').click();
await page.keyboard.type(target.name);
const opt = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
  .filter({ hasText: targetLabel }).first();
await opt.waitFor({ state: 'visible', timeout: 15000 });
const optionMeta = await opt.innerText();
await opt.click();
await page.waitForTimeout(400);
await page.screenshot({ path: '/opt/labspace/e2e/shots/_baserow_people_modal.png', fullPage: true });
await modal.getByRole('button', { name: /保\s*存/ }).click();
await page.waitForTimeout(2500);

const modalGone = !(await page.locator('.ant-modal-container').filter({ hasText: '新增记录' }).first().isVisible().catch(() => false));
must(modalGone, 'row modal closed');
const rowText = await page.locator('.ant-table-tbody').innerText().catch(() => '');
must(rowText.includes('界面指派测试'), 'row saved in table', rowText.replace(/\s+/g, ' ').slice(0, 160));
must(rowText.includes(targetLabel), 'person tag rendered in table', rowText.replace(/\s+/g, ' ').slice(0, 160));

const savedRow = page.locator('.ant-table-tbody tr').filter({ hasText: '界面指派测试' }).first();
await savedRow.locator('button').nth(1).click();
await page.waitForTimeout(1200);
const editModal = page.locator('.ant-modal-container').filter({ hasText: '编辑记录' }).first();
const editOpen = await editModal.isVisible().catch(() => false);
let editValue = '';
if (editOpen) {
  editValue = await editModal.locator('.ant-form-item').filter({ hasText: '负责人' }).innerText().catch(() => '');
  must(editValue.includes(targetLabel), 'person preselected in edit modal', editValue.replace(/\s+/g, ' ').slice(0, 160));
  await editModal.getByRole('button', { name: /取\s*消/ }).click();
} else {
  must(false, 'edit modal opens on row click');
}

await page.screenshot({ path: '/opt/labspace/e2e/shots/_baserow_people_table.png', fullPage: true });

const cleanup = await page.evaluate(async (dbId) => {
  const csrf = (document.cookie.match(/(?:^|;\s*)labspace_csrf=([^;]+)/) || [])[1] || '';
  const res = await fetch(`/api/baserow/databases/${dbId}`, {
    method: 'DELETE', credentials: 'include',
    headers: { 'x-csrf-token': decodeURIComponent(csrf) },
  });
  return res.status;
}, setup.dbId);
must(cleanup < 300, 'cleanup temp database', String(cleanup));

await b.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);