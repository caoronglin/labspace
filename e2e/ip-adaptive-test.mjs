//  IP 自适应回归：访问哪个入口，服务地址就用同一个 IP
//  用法: LAB_PASS=<口令> node ip-adaptive-test.mjs
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://127.0.0.1';
const TS_HOST = process.env.LAB_TS_HOST || '198.51.100.71';
const USER = process.env.LAB_USER || 'student01';
const PASS = process.env.LAB_PASS || '';
let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('    [console.error]', m.text().slice(0, 140)); });

// ---------- 登录 ----------
await page.goto(`${BASE}/api/auth/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#username', { timeout: 20000 });
await page.locator('#username').fill(USER);
await page.locator('#password').fill(PASS);
await page.getByRole('button', { name: '登录' }).first().click();
await page.waitForURL(`${BASE}/**`, { timeout: 25000 }).catch(() => {});
await page.waitForTimeout(1200);

const apiAs = async (host, path, timeout = 30000) => {
  const res = await ctx.request.get(`${BASE}${path}`, { headers: { Host: host }, timeout });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status(), body };
};

console.log('\n== 1. 服务目录按入口主机适配 ==');
for (const host of ['192.0.2.10', TS_HOST]) {
  const { status, body } = await apiAs(host, '/api/services');
  const items = body?.items || body?.services || [];
  const urls = items.map((i) => i.url || '').filter((u) => /^https?:\/\//.test(u));
  const bad = urls.filter((u) => !u.startsWith(`http://${host}`) && !u.includes('192.0.2.29'));
  record(`${host} 入口的服务地址全部跟随该主机`, status === 200 && urls.length > 0 && bad.length === 0,
    `${urls.length} 个服务，异常 ${bad.length}${bad.length ? '：' + bad.slice(0, 3).join(' , ') : ''}`);
}

console.log('\n== 2. 网络入口清单 / 搜索 / SSO 状态 ==');
{
  const r = await apiAs(TS_HOST, '/api/network/entries');
  const host = r.body?.host || '';
  const urls = (r.body?.items || []).map((i) => i.url || '');
  const bad = urls.filter((u) => !u.startsWith(`http://${TS_HOST}`));
  record('GET /api/network/entries 按主机适配', r.status === 200 && host === TS_HOST && bad.length === 0,
    `host=${host} 异常 ${bad.length}`);
}
{
  const r = await apiAs(TS_HOST, '/api/search?q=fastp');
  const local = r.body?.local || [];
  const bad = local.filter((i) => i.url && !i.url.startsWith(`http://${TS_HOST}`));
  record('GET /api/search 本地命中链接适配', r.status === 200 && bad.length === 0, `命中 ${local.length} 条`);
}
{
  const r = await apiAs(TS_HOST, '/api/sso/status');
  const items = r.body?.items || [];
  const bad = items.filter((i) => !String(i.loginUrl || '').startsWith(`http://${TS_HOST}`));
  // Quantum 下线后没有配置 SSO 的第三方服务；服务数为 0 时这是环境状态，不是缺陷。
  if (!items.length) { console.log('  [SKIP] GET /api/sso/status — 当前没有配置 SSO 的服务'); }
  else
  record('GET /api/sso/status 一键登录地址适配', r.status === 200 && items.length > 0 && bad.length === 0,
    `host=${r.body?.host} 服务 ${items.length}`);
}

console.log('\n== 3. 一键登录准备（切换第三方服务 OIDC 到当前主机） ==');
// Quantum 已下线（:8080 容器与网络均已清理），SSO prepare/issuer 切换这一段
// 没有可测对象，随服务一起删掉；将来新增带 OIDC 的第三方服务时再补回。

console.log('\n== 4. 浏览器实测：两个入口页面上的 IP 外链 ==');
for (const entry of [`${BASE}`, `http://${TS_HOST}`]) {
  const host = new URL(entry).hostname;
  const other = host === '192.0.2.10' ? TS_HOST : '192.0.2.10';
  await page.goto(`${entry}/start`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a[href^="http"]', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const info = await page.evaluate(() => {
    const hrefs = [...document.querySelectorAll('a[href]')].map((e) => e.getAttribute('href') || '');
    const ipLinks = hrefs.filter((h) => /https?:\/\/\d+\.\d+\.\d+\.\d+/.test(h));
    const text = document.body.innerText || '';
    return { ipLinks, text };
  });
  const bad = info.ipLinks.filter((h) => !h.includes(host) && !h.includes('192.0.2.29'));
  record(`${entry} /start 的 IP 外链跟随该主机`, info.ipLinks.length > 0 && bad.length === 0,
    `IP 外链 ${info.ipLinks.length} 个，异常 ${bad.length}${bad.length ? '：' + bad.slice(0, 3).join(' , ') : ''}`);
  // 只校验「链接」不指向另一入口；页面正文会刻意列出两个入口地址供用户参考
  const badLink = info.ipLinks.filter((h) => h.includes(other));
  record(`${entry} /start 无指向另一入口的链接`, badLink.length === 0,
    badLink.length ? badLink.slice(0, 3).join(' , ') : `另一入口 ${other}`);
}

await browser.close();
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
