// 真实 OIDC 浏览器流程验证：门户 → Casdoor(IP:8090) → 登录 → 回调 → 已登录
import { chromium } from 'playwright';

const BASE = 'http://192.0.2.10';
const user = process.env.LAB_USER || 'student01';
const pass = process.env.LAB_PASS;

const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ locale: 'zh-CN' });
const p = await ctx.newPage();
const seen = [];
p.on('request', (r) => {
  const u = r.url();
  if (u.includes('/login/oauth/authorize') || u.includes('/api/auth/callback') || u.includes('oauth/oidc/callback')) {
    seen.push(u.split('?')[0]);
  }
});

await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);
console.log('  跳转后的地址:', p.url().split('?')[0]);
console.log('  是否含域名 auth.lab.internal:', p.url().includes('auth.lab.internal'));
console.log('  是否为 IP 授权端点:', p.url().includes('192.0.2.10:8090/login/oauth/authorize'));

// 在 Casdoor 登录页完成登录
await p.waitForSelector('input[type="password"]', { timeout: 20000 });
await p.locator('input[type="text"], input:not([type])').first().fill(user);
await p.locator('input[type="password"]').first().fill(pass);
await p.getByRole('button', { name: /登录|Login/ }).first().click();

// 授权同意页（如出现）
await p.waitForTimeout(3000);
const consent = p.getByRole('button', { name: /授权|允许|同意|Authorize|Allow|Accept/ }).first();
if (await consent.count()) {
  await consent.click().catch(() => {});
}
await p.waitForTimeout(6000);

const finalUrl = p.url();
const body = (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
const loggedIn = /工作台|全部服务|我的收藏/.test(body);
console.log('  最终地址:', finalUrl.split('?')[0]);
console.log('  是否登录成功（页面含工作台/全部服务）:', loggedIn);
console.log('  经过的关键端点:', [...new Set(seen)].join(' -> '));
await p.screenshot({ path: '/opt/labspace/e2e/shots/oidc-ip-flow.png' });

// 会话可用性检查
const me = await p.evaluate(async () => {
  const r = await fetch('/api/auth/me', { credentials: 'include' });
  return { status: r.status, body: (await r.text()).slice(0, 120) };
});
console.log('  /api/auth/me:', me.status, me.body);

await b.close();
console.log(loggedIn && !seen.join(' ').includes('auth.lab.internal') ? '结果: OIDC 全程 IP 化 ✓' : '结果: 失败 ✗');
