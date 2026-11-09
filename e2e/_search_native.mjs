// 统一搜索：起始页直达 / 分栏 / 分页 / 本地文件搜索 / 个人文件 ACL
import { chromium } from 'playwright';

const BASE = 'http://192.0.2.10';
let failed = 0;
function must(cond, label, extra = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
}

async function session(user, pass) {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#password', { timeout: 40000 });
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(4500);
  const call = (path) =>
    page.evaluate(async (p) => {
      const r = await fetch(p, { credentials: 'include' });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, path);
  return { b, page, call };
}

const s1 = await session('student01', process.env.LAB_S1_PASS);
const s2 = await session('student02', process.env.LAB_S2_PASS);

await s1.page.goto(`${BASE}/start`, { waitUntil: 'domcontentloaded' });
await s1.page.waitForTimeout(1200);
await s1.page.locator('input[placeholder*="搜索网页"]').fill('fastp');
await s1.page.locator('input[placeholder*="搜索网页"]').press('Enter');
await s1.page.waitForSelector('text=联网 ·', { timeout: 60000 });
await s1.page.waitForTimeout(1000);
must(s1.page.url() === `${BASE}/start`, '起始页搜索不跳转');
const body1 = (await s1.page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
must(body1.includes('本地资源'), '起始页展示本地资源分栏');
must(body1.includes('联网 · 网页') || body1.includes('联网 · 学术'), '起始页展示联网分栏');
const pager = s1.page.locator('.ant-pagination');
must((await pager.count()) > 0, '联网结果出现分页器');
const before = (await s1.page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
await pager.locator('.ant-pagination-next').click();
await s1.page.waitForTimeout(3500);
const after = (await s1.page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
must(s1.page.url() === `${BASE}/start`, '翻页仍在起始页');
must(/第 2 页/.test(after) && after !== before, '翻页加载了新的联网结果');

const api = await s1.call('/api/search?q=RNA&categories=general,science&scope=all&page=1&pageSize=100');
const web = (api.body.results ?? []).filter((r) => r.engine !== 'd509');
must(api.status === 200 && web.length > 30, '联网结果超过锁定 20 条', `web=${web.length}`);

await s1.page.goto(`${BASE}/search?q=test.txt&categories=general&scope=local`, { waitUntil: 'domcontentloaded' });
await s1.page.waitForTimeout(4000);
const fileLink = s1.page.locator('a[href^="/files?"]').first();
must((await fileLink.count()) > 0, '本地搜索返回文件结果');
if (await fileLink.count()) {
  await fileLink.click();
  await s1.page.waitForTimeout(2000);
  must(s1.page.url().includes('/files?source='), '文件结果直达文件共享');
  const filesBody = (await s1.page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  must(filesBody.includes('test.txt'), '文件共享带关键词定位');
}

const s2api = await s2.call('/api/search?q=test.txt&categories=general&scope=local&pageSize=30');
const s2files = (s2api.body.results ?? []).filter((r) => r.category === 'file');
must(!s2files.some((r) => String(r.path).startsWith('student01/')), '搜索不泄露他人个人文件');

await s1.b.close();
await s2.b.close();
console.log(failed ? `\nFAILED ${failed}` : '\nALL PASS');
process.exit(failed ? 1 : 0);
