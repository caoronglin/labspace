import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);
const failures = [];
const ok = (c, m) => { if (!c) failures.push(m); };

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(5000);

const me = await page.request.get(`${BASE}/api/me`);
const meBody = await me.json();
ok(meBody.authenticated === true, 'not authenticated');
ok(meBody.canDispatch === true, `canDispatch missing/false: ${JSON.stringify(meBody)}`);

const peopleRes = await page.request.get(`${BASE}/api/workbench/assignment-people`);
ok(peopleRes.ok(), `assignment-people ${peopleRes.status()}`);
const ppl = await peopleRes.json();
ok(ppl.myRank === 5, `admin rank should be 5, got ${ppl.myRank}`);
const ids = new Set(ppl.people.map((p) => p.id));
ok(!ids.has(meBody.id), 'people list includes self');
ok(ppl.people.length > 0, 'no dispatchable people');
ok(ppl.people.every((p) => typeof p.rank === 'number' && p.rank <= 5), 'member rank missing/out of range');
ok(ppl.people.every((p) => p.rankLabel), 'rankLabel missing');

const csrf = (await ctx.cookies()).find((c) => c.name === 'labspace_csrf')?.value || '';
ok(Boolean(csrf), 'csrf cookie missing');
const target = ppl.people[0];
const create = await page.request.post(`${BASE}/api/workbench/assignments`, {
  headers: { 'X-CSRF-Token': csrf },
  data: { assignee_id: target.id, kind: 'task', title: `权限层级验证-${Date.now()}`, content: '', priority: 'normal' },
});
ok(create.ok(), `create assignment failed ${create.status()} ${await create.text()}`);
if (create.ok()) {
  const body = await create.json();
  const del = await page.request.delete(`${BASE}/api/workbench/assignments/${body.assignment.id}`, {
    headers: { 'X-CSRF-Token': csrf },
  });
  ok(del.ok(), `cleanup delete failed ${del.status()}`);
}

await ctx.close();
await browser.close();
if (failures.length) {
  console.error('FAIL\n' + failures.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}
console.log('PASS #116: rank metadata, self-exclusion, dispatch + cleanup');