// 生信实训平台后端冒烟：以 student01 登录，验证 /api/v1/courses 与 /api/v1/users/me 不再 500
// 用法: LAB_PASS=<口令> node bioinfo-api-smoke.mjs
import { chromium } from '/opt/labspace/e2e/node_modules/playwright/index.mjs';
const BASE = process.env.BIO_BASE || 'http://127.0.0.1:8102';

const PASS = process.env.LAB_PASS || '';
const USER = process.env.LAB_USER || 'student01';
const OIDC = process.env.OIDC || 'http://127.0.0.1:8090';

const fails = [];
const ok = (cond, label) => {
  console.log(`${cond ? '[ OK ]' : '[FAIL]'} ${label}`);
  if (!cond) fails.push(label);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 200)); });

// 1. 走平台 OIDC 登录入口 → 跳转 Casdoor
await page.goto(`${BASE}/api/v1/auth/login?redirect=/`, { waitUntil: 'domcontentloaded' });
await page.waitForURL(/192\.168\.5\.12:8090/, { timeout: 20000 });
await page.fill('#username', USER);
await page.fill('#password', PASS);
await Promise.all([
  page.waitForURL(/8102/, { timeout: 30000 }),
  page.getByRole('button', { name: /登录|Log in|Login/i }).first().click(),
]);
await page.waitForLoadState('networkidle').catch(() => {});
ok(page.url().includes('8102'), `登录成功 → ${page.url().slice(0, 70)}`);

// 2. 学生视角调接口
const probe = async (path) => {
  const res = await page.evaluate(async (p) => {
    const r = await fetch(p, { credentials: 'include' });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
    return { status: r.status, body };
  }, path);
  return res;
};

const me = await probe('/api/v1/users/me');
ok(me.status === 200, `/api/v1/users/me → ${me.status}`);
ok(me.status !== 200 || me.body?.primaryRole === 'student',
  `primaryRole=${me.status === 200 ? me.body?.primaryRole : me.body}`);

const courses = await probe('/api/v1/courses');
ok(courses.status === 200, `/api/v1/courses → ${courses.status}`);
ok(courses.status !== 200 || Array.isArray(courses.body?.items),
  `courses.items=${courses.status === 200 ? (courses.body?.items?.length ?? 'n/a') : courses.body}`);

const cats = await probe('/api/v1/courses/categories');
ok(cats.status === 200, `/api/v1/courses/categories → ${cats.status}`);

const labs = await probe('/api/v1/labs');
ok(labs.status === 200, `/api/v1/labs → ${labs.status}`);

const dash = await probe('/api/v1/dashboard');
ok(dash.status === 200, `/api/v1/dashboard → ${dash.status}`);

const ws = await probe('/api/v1/workspaces/me');
ok(ws.status === 200, `/api/v1/workspaces/me（自己的工作区）→ ${ws.status}`);
ok(ws.status !== 200 || /^student_\d+$/.test(ws.body?.slug || ''),
  `工作区 slug=${ws.status === 200 ? ws.body?.slug : ws.body}`);

// 全部工作区列表是管理员专属，学生必须被拒绝（越权防护）
const wsAll = await probe('/api/v1/workspaces');
ok(wsAll.status === 403, `学生访问 /api/v1/workspaces → ${wsAll.status}（应为 403）`);

console.log(`\n生信平台后端冒烟: 通过 ${7 - fails.length} 项，失败 ${fails.length}`);
if (fails.length) console.log('失败项:', fails.join(' | '));
await browser.close();
process.exit(fails.length ? 1 : 0);
