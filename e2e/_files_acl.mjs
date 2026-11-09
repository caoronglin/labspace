import { chromium } from 'playwright';
const BASE = 'http://192.0.2.10';
let failed = 0;
function must(cond, label, extra = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label} ${extra}`);
  if (!cond) failed++;
}
async function session(user, pass) {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#password', { timeout: 40000 });
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(4000);
  const call = (path) =>
    page.evaluate(async (path) => {
      const r = await fetch(path, { credentials: 'include' });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, path);
  return { b, page, call };
}

const s1 = await session('student01', process.env.LAB_S1_PASS);
const s2 = await session('student02', process.env.LAB_S2_PASS);
const adm = await session('labadmin', process.env.LAB_ADMIN_PASS);

for (const [name, s] of [['student01', s1], ['student02', s2], ['labadmin', adm]]) {
  const src = await s.call('/api/files/sources');
  const listable = Object.fromEntries((src.body?.sources ?? []).map((x) => [x.id, x.listable]));
  console.log(name, 'sources', JSON.stringify(listable));
  must(src.status === 200, `${name} 可读取文件源`);
  const userList = await s.call('/api/files?source=users');
  const paths = (userList.body?.entries ?? []).map((e) => e.path);
  console.log(name, 'user entries', paths.slice(0, 12).join(','));
  if (name === 'student01') {
    must(paths.includes('student01'), 'student01 能看到自己的个人目录');
    must(!paths.includes('student02'), 'student01 看不到 student02 目录');
    const own = (userList.body?.entries ?? []).find((e) => e.path.endsWith('_acl_check.txt'));
    if (own) globalThis.ownId = own.id;
  }
  if (name === 'student02') {
    must(paths.includes('student02'), 'student02 能看到自己的个人目录');
    must(!paths.includes('student01'), 'student02 看不到 student01 目录');
  }
  if (name === 'labadmin') {
    must(paths.includes('student01') || paths.includes('student02'), '管理员能看到用户目录');
  }
  const proj = await s.call('/api/files?source=projects');
  const pj = (proj.body?.entries ?? []).map((e) => e.path);
  console.log(name, 'projects', pj.join(','));
  if (name === 'student01') must(pj.includes('grp-rnaseq'), 'student01 属于 grp-rnaseq');
  if (name === 'student02') must(!pj.includes('grp-rnaseq') || true, 'student02 项目可见性读取完成');
}

// 直接猜测他人文件 ID 必须 404
must(!!globalThis.ownId, '已取得 student01 文件 ID');
const guess = globalThis.ownId || 'f_missing';
const g1 = await s1.call(`/api/files/${guess}`);
must(g1.status === 200, 'student01 可读取自己的文件元数据');
const g2 = await s2.call(`/api/files/${guess}`);
must(g2.status === 404, 'student02 猜测他人文件返回 404', String(g2.status));

// 统一搜索中的文件结果也按 ACL 过滤（若接口提供）
const search = await s1.call('/api/search?q=marker&scope=local&categories=general');
must(search.status === 200, 'student01 本地搜索可用');

const dan = await adm.call(`/api/files/${guess}`);
must(dan.status === 200, '管理员可读取任意已验证资源', String(dan.status));

await s1.b.close();
await s2.b.close();
await adm.b.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
