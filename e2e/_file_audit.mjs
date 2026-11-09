// 文件访问审计的端到端验证：管理员可查看预览/下载历史，普通用户被拒绝。
// 脚本不打印任何凭据。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const CSRF = 'e2e-audit-csrf-value';

let pass = 0;
const fails = [];
const ok = (name, cond, info = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}${info ? ' :: ' + info : ''}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${info ? ' :: ' + info.slice(0, 220) : ''}`);
  }
};

const mint = (py) =>
  execFileSync('docker', ['exec', '-i', '-w', '/srv/app', 'lab-labspace-backend', 'python', '-c', py], {
    encoding: 'utf8',
  }).trim();

const adminToken = mint(`
from app import accounts
from app.security import issue_session
import json
row = accounts._query('SELECT id, name, display_name, email, groups FROM public."user" WHERE owner=%s AND name=%s', ('built-in', 'labadmin'))[0]
print(issue_session({"id": row["id"], "email": row["email"], "name": row["display_name"], "roles": json.loads(row["groups"] or "[]")}))
`);

const plainToken = mint(`
from app.security import issue_session
print(issue_session({"id": "e2e-audit-nobody", "email": "e2e-audit-nobody@local", "name": "E2E Nobody", "roles": []}))
`);

const adminHeaders = { cookie: `labspace_session=${adminToken}; labspace_csrf=${CSRF}`, origin: BASE };
const plainHeaders = { cookie: `labspace_session=${plainToken}; labspace_csrf=${CSRF}`, origin: BASE };

const call = async (headers, method, path) => {
  const res = await fetch(BASE + path, { method, headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* raw body (download) */
  }
  return { status: res.status, json, text };
};

const waitForEvent = async (action, limit = 20) => {
  for (let i = 0; i < 10; i += 1) {
    const r = await call(adminHeaders, 'GET', `/api/files/access-log?action=${action}&limit=${limit}`);
    if (r.status === 200 && (r.json?.events ?? []).length) return r.json.events;
    await new Promise((res) => setTimeout(res, 300));
  }
  return [];
};

// ---- 选择一个真实质粒文件 ----
const plasmids = await call(adminHeaders, 'GET', '/api/files?source=plasmids&sort=name&order=asc');
const dna = (plasmids.json?.entries ?? []).find((e) => !e.dir && /pBI121/i.test(e.name)) ??
  (plasmids.json?.entries ?? []).find((e) => !e.dir && e.name.toLowerCase().endsWith('.dna'));
ok('找到用于审计的质粒文件', Boolean(dna), dna?.name ?? '');

const preview = await call(adminHeaders, 'GET', `/api/files/${encodeURIComponent(dna.id)}/preview`);
ok('管理员预览文件成功', preview.status === 200, String(preview.status));

const previewEvents = await waitForEvent('preview');
const previewHit = previewEvents.find((e) => e.name === dna.name);
ok('预览历史已入库', Boolean(previewHit), previewHit ? `${previewHit.userId}` : 'none');
ok('预览历史含用户与时间', Boolean(previewHit?.userId) && Boolean(previewHit?.at), previewHit ? `at=${previewHit.at}` : '');
ok('预览历史记录来源与路径', previewHit?.source === 'plasmids' && previewHit?.path === dna.path, `${previewHit?.source} ${previewHit?.path}`);

const download = await call(adminHeaders, 'GET', `/api/files/${encodeURIComponent(dna.id)}/download`);
ok('管理员下载文件成功', download.status === 200 && download.text.length > 0, `${download.status} bytes=${download.text.length}`);

const downloadEvents = await waitForEvent('download');
const downloadHit = downloadEvents.find((e) => e.name === dna.name);
ok('下载历史已入库', Boolean(downloadHit), downloadHit ? `bytes=${downloadHit.bytes}` : 'none');
ok('下载历史字节数与文件一致', Number(downloadHit?.bytes) === dna.size, `event=${downloadHit?.bytes} file=${dna.size}`);

const all = await call(adminHeaders, 'GET', '/api/files/access-log?limit=200');
ok('访问记录返回保留期', all.status === 200 && all.json?.retentionDays === 90, String(all.json?.retentionDays));
ok('访问记录按时间倒序', (() => {
  const rows = all.json?.events ?? [];
  for (let i = 1; i < rows.length; i += 1) {
    if (new Date(rows[i - 1].at) < new Date(rows[i].at)) return false;
  }
  return rows.length > 0;
})());

const empty = await call(adminHeaders, 'GET', '/api/files/access-log?user=no-such-user%40local');
ok('按用户过滤生效', empty.status === 200 && (empty.json?.events ?? []).length === 0);

const limited = await call(adminHeaders, 'GET', '/api/files/access-log?limit=1');
ok('limit 参数生效', limited.status === 200 && (limited.json?.events ?? []).length <= 1);

const denied = await call(plainHeaders, 'GET', '/api/files/access-log');
ok('普通用户被拒绝', denied.status === 403, `${denied.status} ${denied.json?.error ?? ''}`);

const anon = await fetch(BASE + '/api/files/access-log');
ok('未登录被拒绝', anon.status === 401, String(anon.status));

// ---- 浏览器：管理员在文件页打开「访问记录」 ----
const creds = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const password = creds.trim().split(/\s+/)[1];
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill('labadmin');
await page.locator('input[type="password"]').first().fill(password);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3500);

await page.goto(`${BASE}/files?source=plasmids&q=pBI121`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const auditBtn = page.getByRole('button', { name: '访问记录' }).first();
ok('管理员可见「访问记录」入口', (await auditBtn.count()) > 0);
await auditBtn.click();
const modal = page.locator('.ant-modal').first();
await modal.waitFor({ state: 'visible', timeout: 15000 });
const modalText = await modal.innerText().catch(() => '');
ok('访问记录弹窗展示事件', /文件访问记录/.test(modalText) && /pBI121\.dna/.test(modalText), modalText.replace(/\n/g, ' ').slice(0, 200));
ok('记录含用户与动作', /@local/.test(modalText) && /预览/.test(modalText));

await modal.locator('.ant-segmented-item', { hasText: '下载' }).first().click();
const downloadRow = modal.locator('.ant-table-row', { hasText: 'pBI121.dna' }).first();
const downloadShown = await downloadRow.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
ok('下载筛选仍能看到记录', downloadShown);
await page.screenshot({ path: 'shots/file-audit.png' });
await browser.close();

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('FAILED: ' + fails.join(', '));
  process.exit(1);
}
