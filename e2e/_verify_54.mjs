// #54 ACL：翻译作业 IDOR / SnapOtter 作业归属 / 知识库角色清洗 / 服务角色校验
// 临时账号由管理员创建，验证完成后硬删除；密码只在内存中使用。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const lines = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n');
const adminLine = lines.find((l) => l.trim().startsWith('labadmin@local '));
const [ADMIN_USER, ADMIN_PASS] = adminLine.trim().split(/[: ]+/).filter(Boolean);

const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };
const csrfOf = async (ctx) =>
  ((await ctx.cookies()).find((c) => c.name === 'labspace_csrf') || {}).value || '';

async function apiLogin(browser, user, pass) {
  // 复用浏览器登录以拿到门户 Cookie，再用独立 API 请求上下文复用 Cookie
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(6000);
  const body = await page.evaluate(() => document.body.innerText);
  if (!/工作台|全部服务|我的收藏/.test(body)) {
    await ctx.close();
    throw new Error(`login failed for ${user}`);
  }
  await page.close();
  return ctx;
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const suffix = Date.now().toString(36).slice(-6);
const U1 = `acla${suffix}`;
const U2 = `aclb${suffix}`;
const P1 = `T-${crypto.randomBytes(9).toString('base64url')}`;
const P2 = `T-${crypto.randomBytes(9).toString('base64url')}`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
let admin = null;
let ctx1 = null;
let ctx2 = null;

try {
  admin = await apiLogin(browser, ADMIN_USER, ADMIN_PASS);
  const adminCsrf = await csrfOf(admin);

  for (const [name, pwd] of [[U1, P1], [U2, P2]]) {
    const r = await admin.request.post(`${BASE}/api/admin/accounts`, {
      headers: { 'X-CSRF-Token': adminCsrf },
      data: { name, displayName: name, email: '', groups: [], password: pwd },
    });
    ok(r.status() === 200, `create account ${name} HTTP ${r.status()}: ${(await r.text()).slice(0, 120)}`);
  }

  ctx1 = await apiLogin(browser, U1, P1);
  ctx2 = await apiLogin(browser, U2, P2);
  const csrf1 = await csrfOf(ctx1);

  // 1) 翻译作业归属
  const up = await ctx1.request.post(`${BASE}/api/pdf-translate/jobs`, {
    headers: { 'X-CSRF-Token': csrf1 },
    multipart: { file: { name: 'acl.pdf', mimeType: 'application/pdf', buffer: PDF } },
  });
  ok(up.status() === 200, `translate upload HTTP ${up.status()}`);
  const job = (await up.json().catch(() => ({}))).job_id;
  ok(!!job, 'translate upload returned no job_id');

  if (job) {
    const own = await ctx1.request.get(`${BASE}/api/pdf-translate/jobs/${job}`);
    ok(own.status() === 200, `owner status HTTP ${own.status()} (expected 200)`);

    const other = await ctx2.request.get(`${BASE}/api/pdf-translate/jobs/${job}`);
    ok(other.status() === 404, `other-user status HTTP ${other.status()} (expected 404)`);

    const otherResult = await ctx2.request.get(`${BASE}/api/pdf-translate/jobs/${job}/result`);
    ok(otherResult.status() === 404, `other-user result HTTP ${otherResult.status()} (expected 404)`);

    const adminView = await admin.request.get(`${BASE}/api/pdf-translate/jobs/${job}`);
    ok(adminView.status() === 200, `admin status HTTP ${adminView.status()} (expected 200)`);
  }

  // 2) SnapOtter 未知作业：普通用户直接 404，管理员可透传
  const fake = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const s1 = await ctx1.request.get(`${BASE}/api/snapotter/jobs/${fake}`);
  ok(s1.status() === 404, `snapotter unknown job HTTP ${s1.status()} (expected 404)`);
  const sa = await admin.request.get(`${BASE}/api/snapotter/jobs/${fake}`);
  ok(sa.status() !== 404, `admin snapotter passthrough got HTTP ${sa.status()}`);

  // 3) 知识库角色清洗
  const created = await ctx1.request.post(`${BASE}/api/knowledge/`, {
    headers: { 'X-CSRF-Token': csrf1 },
    data: {
      title: `ACL verify ${Date.now()}`,
      body: 'role sanitize check',
      visibility: 'roles',
      roles: ['lab-teacher', 'bad role!<x>', 'lab-teacher', 'a'.repeat(80)],
      tags: ['acl'],
    },
  });
  ok(created.status() === 200, `knowledge create HTTP ${created.status()}`);
  const doc = (await created.json().catch(() => ({}))).item || {};
  ok(Array.isArray(doc.roles), 'knowledge roles missing');
  ok(
    JSON.stringify(doc.roles) === JSON.stringify(['lab-teacher']),
    `knowledge roles not sanitized: ${JSON.stringify(doc.roles)}`,
  );
  if (doc.id) {
    const del = await ctx1.request.delete(`${BASE}/api/knowledge/${doc.id}`, {
      headers: { 'X-CSRF-Token': csrf1 },
    });
    ok(del.status() === 200, `knowledge cleanup HTTP ${del.status()}`);
  }

  // 4) 服务角色校验：不存在的服务 404；可见服务 SSO 正常
  const nope = await ctx1.request.get(`${BASE}/api/services/__nope__/sso`);
  ok(nope.status() === 404, `unknown service sso HTTP ${nope.status()} (expected 404)`);
  const list = await ctx1.request.get(`${BASE}/api/services`);
  const services = (await list.json().catch(() => ({}))).items || [];
  const svc = services.find((s) => s.id);
  if (svc) {
    const sso = await ctx1.request.get(`${BASE}/api/services/${encodeURIComponent(svc.id)}/sso`);
    ok(sso.status() === 200, `visible service sso HTTP ${sso.status()} for ${svc.id}`);
  }
} finally {
  try {
    if (admin) {
      const adminCsrf = await csrfOf(admin);
      for (const name of [U1, U2]) {
        await admin.request
          .delete(`${BASE}/api/admin/accounts/${name}`, {
            headers: { 'X-CSRF-Token': adminCsrf },
            data: { confirm: name },
          })
          .catch(() => {});
      }
    }
  } finally {
    await ctx1?.close().catch(() => {});
    await ctx2?.close().catch(() => {});
    await browser.close();
  }
}

if (failures.length) {
  console.error('FAIL 54:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log('PASS 54: translate job ownership, snapotter guard, knowledge role sanitize, service ACL');