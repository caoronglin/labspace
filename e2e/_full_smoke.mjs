// 整机冒烟：双入口（192.0.2.10 / Tailscale）公开页面、服务端口、API 与管理员页面
// 凭据只从本地台账读取，不打印。
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const HOSTS = ['192.0.2.10', '198.51.100.71'];
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
  return { status: r.status, headers: r.headers, text: await r.text().catch(() => '') };
}

const PUBLIC_ROUTES = ['/', '/login', '/agent', '/files', '/baserow', '/genomes', '/workbench', '/help', '/nav', '/bioinfo', '/cropgenome/'];
const API_PUBLIC = ['/api/health', '/api/services', '/api/next/v1/services'];
const API_GUARDED = ['/api/files?source=public', '/api/admin/accounts', '/api/knowledge?page=1&pageSize=5', '/api/baserow/overview', '/api/corpus', '/api/search/categories'];
const PAGES_ADMIN = ['/', '/workbench', '/agent', '/files', '/baserow', '/genomes', '/admin/users', '/admin/agent', '/bioinfo', '/cropgenome'];

async function login(browser, base) {
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill('labadmin');
  await page.locator('input[type="password"]').first().fill(adminPass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(5000);
  const onLogin = /\/login/.test(new URL(page.url()).pathname);
  return { ctx, page, ok: !onLogin };
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const host of HOSTS) {
    const base = `http://${host}`;
    for (const route of PUBLIC_ROUTES) {
      try {
        const r = await get(base + route);
        check(`[${host}] 页面 ${route}`, r.status === 200 && /<html/i.test(r.text), `${r.status}`);
      } catch (e) {
        check(`[${host}] 页面 ${route}`, false, String(e).slice(0, 80));
      }
    }
    for (const route of API_PUBLIC) {
      try {
        const r = await get(base + route);
        check(`[${host}] 接口 ${route}`, r.status === 200, `${r.status}`);
      } catch (e) {
        check(`[${host}] 接口 ${route}`, false, String(e).slice(0, 80));
      }
    }
    for (const route of API_GUARDED) {
      try {
        const r = await get(base + route);
        check(`[${host}] 未登录拦截 ${route}`, r.status === 401 || r.status === 403, `${r.status}`);
      } catch (e) {
        check(`[${host}] 未登录拦截 ${route}`, false, String(e).slice(0, 80));
      }
    }
    try {
      const r = await get(base + '/');
      const h = r.headers;
      // 站点用 CSP frame-ancestors 取代 X-Frame-Options（后者无法按端口放行，
      // 会让 8086/8091 等独立端口内嵌空白）；两者有其一即可。
      const framed = (h.get('x-frame-options') || '').toUpperCase() === 'SAMEORIGIN'
        || /frame-ancestors/.test(h.get('content-security-policy') || '');
      check(`[${host}] 安全响应头`, h.get('x-content-type-options') === 'nosniff'
        && framed
        && !!h.get('referrer-policy'),
      `nosniff=${h.get('x-content-type-options')} csp=${(h.get('content-security-policy') || '').slice(0, 40)}`);
    } catch (e) {
      check(`[${host}] 安全响应头`, false, String(e).slice(0, 80));
    }
    for (const [port, label] of [[8090, 'Casdoor'], [8086, '命令手册'], [8091, 'JBrowse'], [8094, 'Baserow'], [8093, '图纸平台']]) {
      try {
        const r = await get(`http://${host}:${port}/`);
        check(`[${host}:${port}] ${label}`, r.status < 500, `${r.status}`);
      } catch (e) {
        check(`[${host}:${port}] ${label}`, false, String(e).slice(0, 80));
      }
    }

    let session;
    try {
      session = await login(browser, base);
      check(`[${host}] 管理员登录`, session.ok);
      if (!session.ok) continue;
      const { page } = session;
      for (const route of PAGES_ADMIN) {
        await page.goto(base + route, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1800);
        const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
        const crashed = /出错了|页面出现异常|Something went wrong/.test(body);
        check(`[${host}] 管理员访问 ${route}`, !crashed && body.length > 150, crashed ? '页面异常' : `len=${body.length}`);
      }
      const api = await page.evaluate(async () => {
        const urls = ['/api/knowledge?page=1&pageSize=5', '/api/agent/sessions', '/api/files?source=public', '/api/baserow/overview', '/api/corpus', '/api/search/categories'];
        const out = {};
        for (const u of urls) {
          try {
            const r = await fetch(u, { credentials: 'include' });
            out[u] = r.status;
          } catch (e) {
            out[u] = String(e);
          }
        }
        return out;
      });
      for (const [u, status] of Object.entries(api)) {
        check(`[${host}] 登录后接口 ${u}`, status === 200, String(status));
      }
    } finally {
      await session?.ctx.close();
    }
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `FAILED ${failed.length}/${results.length}` : `ALL PASS (${results.length})`}`);
process.exit(failed.length ? 1 : 0);