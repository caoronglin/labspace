import { chromium } from 'playwright';
import fs from 'node:fs';

const CRED = {};
for (const line of fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const [email, pass] = t.split(/\s+/);
  if (email && pass) CRED[email.split('@')[0]] = pass;
}

let failed = 0;
const must = (c, l, e = '') => {
  console.log(`${c ? 'ok  ' : 'FAIL'} ${l}${e ? ' — ' + e : ''}`);
  if (!c) failed++;
};

const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://192.0.2.10/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill('labadmin');
await page.locator('#password').fill(CRED.labadmin);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
try {
  await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
} catch {}
await page.waitForTimeout(1500);

const cookies = await ctx.cookies();
const csrf = cookies.find((c) => c.name === 'labspace_csrf')?.value || '';
const headers = { 'x-csrf-token': csrf };
const base = 'http://192.0.2.10';

const r1 = await page.request.get(`${base}/api/workbench/mentor-bindings`);
must(r1.ok(), '导师绑定接口可用', String(r1.status()));
const data = await r1.json();
must(data.canBind === true, '管理员可管理绑定');
must(Array.isArray(data.interns) && data.interns.length > 0, '存在可绑定成员', `count=${data.interns?.length}`);
must(Array.isArray(data.mentors) && data.mentors.length > 0, '存在可选导师', `count=${data.mentors?.length}`);

const intern = (data.interns || [])[0];
const mentor = intern ? (data.mentors || []).find((m) => m.rank > intern.rank) : undefined;
must(Boolean(intern && mentor), '可选出低年级成员与更高组导师');

if (intern && mentor) {
  const put = await page.request.put(`${base}/api/workbench/mentor-bindings/${encodeURIComponent(intern.id)}`, {
    headers,
    data: { mentor_id: mentor.id },
  });
  must(put.ok(), '绑定成功', String(put.status()));
  const r2 = await page.request.get(`${base}/api/workbench/mentor-bindings`);
  const data2 = await r2.json();
  const hit = (data2.bindings || []).find((x) => x.userId === intern.id && x.mentorId === mentor.id);
  must(Boolean(hit), '绑定结果已持久化');

  const dup = await page.request.put(`${base}/api/workbench/mentor-bindings/${encodeURIComponent(mentor.id)}`, {
    headers,
    data: { mentor_id: intern.id },
  });
  must(dup.status() === 400, '拒绝反向绑定（导师组别必须更高）', String(dup.status()));

  const del = await page.request.delete(`${base}/api/workbench/mentor-bindings/${encodeURIComponent(intern.id)}`, { headers });
  must(del.ok(), '解绑成功', String(del.status()));
  const r3 = await page.request.get(`${base}/api/workbench/mentor-bindings`);
  const data3 = await r3.json();
  must(!(data3.bindings || []).some((x) => x.userId === intern.id), '解绑结果已持久化');
}

await page.goto(`${base}/workbench?tab=assignments`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const start = page.getByRole('button', { name: '开始使用' });
if (await start.count()) {
  await start.first().click();
  await page.waitForTimeout(600);
}
const tab = page.locator('.ant-tabs-tab', { hasText: '指派' }).first();
if (await tab.count()) {
  await tab.click({ force: true });
  await page.waitForTimeout(1800);
}
const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
must(body.includes('实习生绑定'), '工作台显示「实习生绑定」卡片');
must(body.includes('选择成员（实习生）') || body.includes('选择导师'), '绑定选择器渲染');

must(errors.length === 0, '无前端脚本错误', errors.slice(0, 2).join(' | '));
await page.screenshot({ path: '/opt/labspace/e2e/shots/_mentor_binding.png', fullPage: true });
await b.close();
console.log(failed ? `\n${failed} FAIL` : '\nALL PASS');
process.exit(failed ? 1 : 0);