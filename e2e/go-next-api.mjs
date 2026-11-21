// =====================================================================
//  Go 核心（LabGo）端到端体检：/api/next/* 由 Go 服务直接鉴权与提供
//  用法: LAB_PASS=<学生口令> LAB_ADMIN_PASS=<管理员口令> node go-next-api.mjs
// =====================================================================
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://127.0.0.1';
const USER = process.env.LAB_USER || 'student01';
const PASS = process.env.LAB_PASS || '';
const ADMIN_USER = process.env.LAB_ADMIN_USER || 'labadmin';
const ADMIN_PASS = process.env.LAB_ADMIN_PASS || '';

let pass = 0;
let fail = 0;

function record(name, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function login(user, password) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(5000);
  const body = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  if (!/工作台|全部服务|我的收藏/.test(body)) {
    await browser.close();
    throw new Error(`登录失败: ${user}`);
  }
  return { browser, ctx, page };
}

async function api(page, path, init = {}) {
  return page.evaluate(
    async ([p, i]) => {
      if (i.method && i.method !== 'GET' && !i.skipCsrf) {
        const csrf = (document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
        i = { ...i, headers: { ...(i.headers || {}), 'X-CSRF-Token': decodeURIComponent(csrf) } };
      }
      const { skipCsrf, ...rest } = i;
      const r = await fetch(p, { credentials: 'include', ...rest });
      const t = await r.text();
      try {
        return { status: r.status, body: JSON.parse(t) };
      } catch {
        return { status: r.status, body: t.slice(0, 400) };
      }
    },
    [path, init],
  );
}

const student = await login(USER, PASS);
const page = student.page;

// ---------- 1. 服务目录与平台清单 ----------
{
  const sources = await api(page, '/api/next/v1/files/sources');
  const ids = (sources.body?.sources || []).map((s) => s.id).sort();
  record('GET /api/next/v1/files/sources 返回四个数据源', sources.status === 200 && ids.join(',') === 'course-materials,projects,public,users', ids.join(','));

  const catalog = await api(page, '/api/next/v1/catalog');
  record('GET /api/next/v1/catalog 服务目录可用', catalog.status === 200 && Array.isArray(catalog.body?.items) && catalog.body.items.length > 0, `${catalog.body?.items?.length} 项`);

  const manifest = await api(page, '/api/next/v1/platform/manifest');
  record('GET /api/next/v1/platform/manifest 平台清单可用', manifest.status === 200 && Array.isArray(manifest.body?.modules), `${manifest.body?.modules?.length} 模块`);

  const routes = await api(page, '/api/next/v1/platform/routes');
  record('GET /api/next/v1/platform/routes 学生被拒（管理员接口）', routes.status === 403, `status=${routes.status}`);
}

// ---------- 2. 文件访问与权限隔离 ----------
let courseFileId = null;
let ownFileId = null;
{
  const course = await api(page, '/api/next/v1/files?source=course-materials');
  const courseEntries = course.body?.entries || [];
  record('GET /api/next/v1/files?source=course-materials 课程资料可见', course.status === 200 && courseEntries.length > 0, `${courseEntries.length} 项`);
  const file = courseEntries.find((e) => !e.dir);
  if (file) courseFileId = file.id;

  const users = await api(page, '/api/next/v1/files?source=users');
  const userEntries = users.body?.entries || [];
  const names = userEntries.map((e) => e.name);
  // 套件原本写死 student02，换一套实验室数据就不存在了；改为「自己不出现别人的目录」，
  // 用 /api/people 里第一个非当前账号来判定，数据无关。
  const peopleRes = await api(page, '/api/people');
  const others = (peopleRes.body?.people || []).map((x) => x.name).filter((n) => n && n !== USER);
  const leaked = names.filter((n) => others.includes(n));
  record('个人文件只返回自己的目录', users.status === 200 && leaked.length === 0,
    `自己=${names.includes(USER)} 别人的=${leaked.length}`);
  const own = userEntries.find((e) => !e.dir);
  if (own) ownFileId = own.id;

  const projects = await api(page, '/api/next/v1/files?source=projects');
  const projectPaths = (projects.body?.entries || []).map((e) => e.path);
  record('项目文件按课题组授权（可见 grp-rnaseq）', projects.status === 200 && projectPaths.some((p) => p.startsWith('grp-rnaseq')), projectPaths.join(','));

  const unknown = await api(page, '/api/next/v1/files?source=secret');
  record('未知数据源被拒绝', unknown.status === 400, `status=${unknown.status}`);
}

// ---------- 3. 预览与下载 ----------
{
  if (courseFileId) {
    const preview = await api(page, `/api/next/v1/files/${courseFileId}/preview`);
    record('GET 预览返回结构化结果', preview.status === 200 && typeof preview.body?.kind === 'string', `kind=${preview.body?.kind} format=${preview.body?.format}`);

    const download = await api(page, `/api/next/v1/files/${courseFileId}/download`);
    record('GET 下载返回文件内容', download.status === 200, `status=${download.status}`);
  } else {
    console.log('  [SKIP] 课程资料存在可预览文件 — 该共享源当前没有可预览文件');
  }
}

// ---------- 4. CSRF 与未登录访问 ----------
{
  const noCsrf = await api(page, '/api/next/v1/files', { method: 'POST', body: JSON.stringify({}), skipCsrf: true });
  record('写操作缺少 CSRF 头被拒绝', noCsrf.status === 403, `status=${noCsrf.status}`);

  const anon = await student.browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const anonRes = await anonPage.evaluate(async (base) => {
    const r = await fetch(`${base}/api/next/v1/files?source=public`, { credentials: 'omit' });
    return r.status;
  }, BASE);
  record('未登录访问被拒绝', anonRes === 401, `status=${anonRes}`);
  await anon.close();
}

// ---------- 5. 跨用户访问必须被隐藏（用管理员取 id，再用学生请求） ----------
if (ADMIN_PASS) {
  const admin = await login(ADMIN_USER, ADMIN_PASS);
  try {
    const adminUsers = await api(admin.page, '/api/next/v1/files?source=users');
    const adminEntries = adminUsers.body?.entries || [];
    const foreignName = adminEntries.map((e) => e.name).find((n) => n && n !== USER);
    const foreign = adminEntries.find((e) => e.name === foreignName);
    if (foreign) {
      const leak = await api(page, `/api/next/v1/files/${foreign.id}/download`);
      record('学生请求他人文件被隐藏（404）', leak.status === 404, `status=${leak.status}`);
    } else {
      record('管理员可见他人目录', false, '管理员视图里没有任何其它账号');
    }
    const adminRoutes = await api(admin.page, '/api/next/v1/platform/routes');
    record('管理员可访问路由表', adminRoutes.status === 200, `status=${adminRoutes.status}`);
  } finally {
    await admin.browser.close();
  }
} else {
  console.log('  [SKIP] 未提供 LAB_ADMIN_PASS，跳过跨用户隔离检查');
}

await student.browser.close();

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
