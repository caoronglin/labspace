// CropGenome Toolkit 接入验收：
//  1. 匿名访问 /cropgenome/** 必须 401（核心校验会话，工具服务不接触 Cookie）
//  2. 客户端伪造 X-OIDC-* 身份头必须无效（核心只认门户会话）
//  3. 登录后访问工具 API 必须 200，且响应来自真实上游
//  4. 写操作缺 CSRF 必须 403
//
// 实现说明：请求一律走 Playwright 的 APIRequestContext（page.request），
// 不用 page.evaluate(fetch) —— 门户首页对未登录用户会跳转 /login，
// evaluate 里的 fetch 会被导航打断（"Execution context was destroyed"）。
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const USER = process.env.LAB_USER || 'student01';
const PASS = process.env.LAB_PASS;

let pass = 0, fail = 0;
const ok = (name, extra = '') => { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); };
const bad = (name, extra = '') => { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); };

async function login(browser) {
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(USER);
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(5000);
  const body = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  if (!/工作台|全部服务|我的收藏/.test(body)) throw new Error(`登录失败，停留在 ${page.url()}`);
  return { ctx, page };
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });

console.log('=== 1. 匿名与伪造身份 ===');
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const r1 = await page.request.get(`${BASE}/cropgenome/api/v1/species`, {
    headers: { Accept: 'application/json' },
  });
  const t1 = (await r1.text()).slice(0, 120);
  r1.status() === 401 ? ok('匿名访问被拒', `HTTP ${r1.status()}`) : bad('匿名访问被拒', `HTTP ${r1.status()} ${t1}`);

  const r2 = await page.request.get(`${BASE}/cropgenome/api/v1/species`, {
    headers: {
      Accept: 'application/json',
      'X-OIDC-Subject': 'attacker@local',
      'X-OIDC-Issuer': 'http://192.0.2.10:8090',
      'X-OIDC-Audience': 'cropgenome',
    },
  });
  const t2 = (await r2.text()).slice(0, 120);
  r2.status() === 401 ? ok('伪造身份头无效', `HTTP ${r2.status()}`) : bad('伪造身份头无效', `HTTP ${r2.status()} ${t2}`);
  await ctx.close();
}

console.log('=== 2. 登录后访问工具 API ===');
const { ctx, page } = await login(browser);
{
  for (const p of ['/cropgenome/api/v1/species', '/cropgenome/api/v1/blast/databases', '/cropgenome/api/v1/healthz']) {
    const r = await page.request.get(`${BASE}${p}`, { headers: { Accept: 'application/json' } });
    const t = (await r.text()).slice(0, 160);
    r.status() === 200 ? ok(`GET ${p}`, t.replace(/\s+/g, ' ').slice(0, 90)) : bad(`GET ${p}`, `HTTP ${r.status()} ${t}`);
  }

  // 写操作：缺 CSRF 必须 403
  const w = await page.request.post(`${BASE}/cropgenome/api/v1/ids/resolve`, {
    headers: { 'Content-Type': 'application/json' },
    data: { ids: ['AT1G01010'] },
  });
  const wt = (await w.text()).slice(0, 160);
  w.status() === 403 ? ok('写操作缺 CSRF 被拒', `HTTP ${w.status()}`) : bad('写操作缺 CSRF 被拒', `HTTP ${w.status()} ${wt}`);
}

await ctx.close();
await browser.close();
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
