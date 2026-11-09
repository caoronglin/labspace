// 安全检查：未登录拦截 / CSRF / 越权 / 路径穿越 / 回环端口 / 凭据文件权限 / 前端产物泄露
// 凭据只从本地台账读取，临时账号用完即硬删除，全程不打印口令。
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';

const BASE = 'http://192.0.2.10';
const creds = new Map();
for (const raw of readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const [email, pass] = line.split(/\s+/);
  if (email && pass) creds.set(email.split('@')[0], pass);
}
const adminPass = creds.get('labadmin');
if (!adminPass) {
  console.error('凭据台账中没有 labadmin');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

async function get(url, opts = {}) {
  const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...opts });
  return { status: r.status, text: await r.text().catch(() => '') };
}

function canConnect(host, port, timeout = 2500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// ---- 1. 未登录接口一律拒绝 ----
for (const route of [
  '/api/files?source=public',
  '/api/files?source=users',
  '/api/admin/accounts',
  '/api/admin/health',
  '/api/agent/admin/config',
  '/api/agent/sessions',
  '/api/knowledge?page=1&pageSize=5',
  '/api/baserow/overview',
]) {
  try {
    const r = await get(BASE + route);
    check(`未登录拦截 ${route}`, r.status === 401 || r.status === 403, String(r.status));
  } catch (e) {
    check(`未登录拦截 ${route}`, false, String(e).slice(0, 80));
  }
}

// ---- 2. 回环端口不得对外暴露 ----
for (const [host, port, label, wantOpen] of [
  ['127.0.0.1', 8088, '后端(本机)', true],
  ['192.0.2.10', 8088, '后端(内网直连)', false],
  ['198.51.100.71', 8088, '后端(Tailscale 直连)', false],
  ['127.0.0.1', 8096, 'Baserow(本机)', true],
  ['192.0.2.10', 8096, 'Baserow(内网直连)', false],
  ['192.0.2.10', 8100, '模型服务(内网直连)', false],
  ['198.51.100.71', 8100, '模型服务(Tailscale 直连)', false],
]) {
  const open = await canConnect(host, port);
  check(`端口 ${host}:${port} ${label}`, open === wantOpen, open ? 'open' : 'closed');
}

// ---- 3. 凭据文件权限 ----
for (const [file, label] of [
  ['/etc/labspace/casdoor-users.txt', '账号台账'],
  ['/etc/labspace/baserow-admin.txt', 'Baserow 管理员'],
  ['/etc/lab-rag/rag.env', 'RAG 环境'],
  ['/etc/cropgenome/api.env', 'CropGenome 环境'],
]) {
  try {
    const mode = statSync(file).mode & 0o777;
    const worldReadable = (mode & 0o004) !== 0;
    const groupReadable = (mode & 0o040) !== 0;
    const ok = !worldReadable && (file.endsWith('casdoor-users.txt') ? !groupReadable : true);
    check(`${label} 权限 ${file}`, ok, mode.toString(8).padStart(3, '0'));
  } catch (e) {
    check(`${label} 权限 ${file}`, false, String(e).slice(0, 60));
  }
}

// ---- 4. 前端产物不得含凭据变量名或私钥 ----
{
  const scan = spawnSync('grep', ['-rlE', 'LABRAG_TOKEN|CROP_DSN|POSTGRES_PASSWORD|BEGIN (RSA|OPENSSH) PRIVATE KEY', '/opt/labspace/frontend/dist'], { encoding: 'utf8' });
  const hits = (scan.stdout || '').trim();
  check('前端产物无凭据特征串', scan.status === 1 && !hits, hits ? hits.split('\n').slice(0, 3).join(',') : 'clean');
}

// ---- 5. 登录后：CSRF / 越权 / 路径穿越 ----
const browser = await chromium.launch({ args: ['--no-sandbox'] });
async function login(page, user, pass) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(5000);
  return !/\/login/.test(new URL(page.url()).pathname);
}

const tempName = `secprobe${Date.now().toString(36)}`;
const tempPass = randomBytes(18).toString('base64url');
let adminCtx;
let userCtx;
try {
  adminCtx = await browser.newContext({ locale: 'zh-CN' });
  const admin = await adminCtx.newPage();
  check('管理员登录', await login(admin, 'labadmin', adminPass));

  const csrf = await admin.evaluate(() => document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] || '');
  check('CSRF Cookie 已下发', !!csrf);

  const noToken = await admin.evaluate(async () => {
    const r = await fetch('/api/agent/sessions', { method: 'POST', credentials: 'include' });
    return r.status;
  });
  check('写接口缺少 CSRF → 403', noToken === 403, String(noToken));

  const badToken = await admin.evaluate(async () => {
    const r = await fetch('/api/agent/sessions', { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': 'forged-token' } });
    return r.status;
  });
  check('写接口伪造 CSRF → 403', badToken === 403, String(badToken));

  const mk = await admin.evaluate(async () => {
    const token = document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] || '';
    const hdr = { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(token) };
    const name = `csrf-probe-${Date.now().toString(36)}`;
    const r = await fetch('/api/files/mkdir', { method: 'POST', credentials: 'include', headers: hdr, body: JSON.stringify({ source: 'users', path: `labadmin/${name}` }) });
    const j = await r.json().catch(() => ({}));
    const id = j?.entry?.id;
    let cleanup = null;
    if (id) {
      const d = await fetch('/api/files/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'include', headers: hdr });
      cleanup = d.status;
    }
    return { status: r.status, cleanup };
  });
  check('正确 CSRF 可写入', mk.status === 200, String(mk.status));
  check('写入后清理', mk.cleanup === 200, String(mk.cleanup));

  for (const route of ['/api/files/%2e%2e%2F%2e%2e%2Fetc%2Fpasswd/download', '/api/files/%2e%2e%2F%2e%2e%2Fetc%2Fpasswd/preview']) {
    // nginx 会把含 .. 的 URI 归一化到 SPA 首页；关键是绝不能回吐系统文件内容。
    const r = await admin.evaluate(async (u) => {
      const res = await fetch(u, { credentials: 'include' });
      return { status: res.status, text: (await res.text()).slice(0, 4000) };
    }, route);
    const leaked = /root:x:0:0:|PRIVATE KEY|add_header\s/.test(r.text);
    const rejected = r.status === 400 || r.status === 403 || r.status === 404;
    check(`路径穿越无泄露 ${route}`, !leaked && (rejected || /<!doctype html/i.test(r.text)), `${r.status}${rejected ? ' rejected' : ' spa-shell'}`);
  }

  const created = await admin.evaluate(async ({ name, pwd }) => {
    const token = document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] || '';
    const r = await fetch('/api/admin/accounts', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(token) },
      body: JSON.stringify({ name, displayName: '安全探针', groups: ['lab-student'], password: pwd }),
    });
    return r.ok;
  }, { name: tempName, pwd: tempPass });
  check('创建临时普通账号', created);

  if (created) {
    userCtx = await browser.newContext({ locale: 'zh-CN' });
    const page = await userCtx.newPage();
    check('普通账号登录', await login(page, tempName, tempPass));
    const probe = await page.evaluate(async () => {
      const urls = ['/api/admin/accounts', '/api/admin/health', '/api/agent/admin/config', '/api/admin/accounts/groups'];
      const out = {};
      for (const u of urls) {
        try { out[u] = (await fetch(u, { credentials: 'include' })).status; } catch (e) { out[u] = String(e); }
      }
      const token = document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] || '';
      const hdr = { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(token) };
      const r = await fetch('/api/files/mkdir', { method: 'POST', credentials: 'include', headers: hdr, body: JSON.stringify({ source: 'public', path: 'secprobe-tmp' }) });
      out.publicWrite = r.status;
      return out;
    });
    for (const u of ['/api/admin/accounts', '/api/admin/health', '/api/agent/admin/config', '/api/admin/accounts/groups']) {
      check(`普通账号越权拒绝 ${u}`, probe[u] === 403, String(probe[u]));
    }
    check('普通账号不可写公共目录', probe.publicWrite === 403, String(probe.publicWrite));

    await page.goto(`${BASE}/admin/users`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    check('普通账号访问 /admin/users 被拦截', /无访问权限|仅限|没有权限|Forbidden/.test(body), body.slice(0, 60));
  }
} finally {
  try {
    if (adminCtx) {
      const admin = adminCtx.pages()[0];
      const ok = await admin.evaluate(async ({ name }) => {
        const token = document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] || '';
        const r = await fetch(`/api/admin/accounts/${encodeURIComponent(name)}`, {
          method: 'DELETE', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(token) },
          body: JSON.stringify({ confirm: name }),
        });
        return r.ok;
      }, { name: tempName }).catch(() => false);
      check('临时账号硬删除', ok);
    }
  } finally {
    await userCtx?.close();
    await adminCtx?.close();
    await browser.close();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `FAILED ${failed.length}/${results.length}` : `ALL PASS (${results.length})`}`);
process.exit(failed.length ? 1 : 0);