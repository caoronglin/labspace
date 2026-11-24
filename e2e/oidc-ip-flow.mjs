// 门户认证入口回归：本地口令登录 + 门户 OIDC discovery/JWKS 可用。
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1';
const user = process.env.LAB_USER || 'student01';
const pass = process.env.LAB_PASS;
const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ locale: 'zh-CN' });
const p = await ctx.newPage();

await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('#username', { timeout: 20000 });
await p.locator('#username').fill(user);
await p.locator('#password').fill(pass);
await p.locator('button.ant-btn-primary').first().click();
await p.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 25000 }).catch(() => {});
await p.waitForTimeout(2500);
const body = (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
const loggedIn = /工作台|全部服务|我的收藏/.test(body);
console.log('  最终地址:', p.url().split('?')[0]);
console.log('  是否登录成功:', loggedIn);

const disc = await p.evaluate(async () => {
  const r = await fetch('/oidc/.well-known/openid-configuration');
  return { status: r.status, body: await r.json() };
});
const jwks = await p.evaluate(async () => {
  const r = await fetch('/oidc/.well-known/jwks.json');
  return { status: r.status, body: await r.json() };
});
console.log('  discovery:', disc.status, disc.body.issuer);
console.log('  JWKS:', jwks.status, jwks.body.keys?.[0]?.alg);
await p.screenshot({ path: '/opt/labspace/e2e/shots/oidc-ip-flow.png' });
await b.close();
const ok = loggedIn && disc.status === 200 && disc.body.issuer === `${BASE}/oidc` && jwks.status === 200 && jwks.body.keys?.[0]?.alg === 'RS256';
console.log(ok ? '结果: 门户本地认证 + OIDC ✓' : '结果: 失败 ✗');
process.exit(ok ? 0 : 1);
