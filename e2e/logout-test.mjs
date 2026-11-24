// 门户本地登出回归：清会话 Cookie、/api/me 失效、不再请求 Casdoor/8090。
import { launch, loginContext, BASE } from './_auth.mjs';

let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ` - ${detail}` : ''}`);
};

const browser = await launch();
try {
  const ctx = await loginContext(browser);
  const page = ctx.pages()[0];
  const authRequests = [];
  page.on('request', req => {
    if (req.url().includes('/api/auth/logout')) authRequests.push({ url: req.url(), method: req.method() });
  });
  const before = await ctx.cookies();
  record('登录后存在门户会话 Cookie', before.some(c => c.name === 'labspace_session'));
  const meBefore = await page.request.get(`${BASE}/api/me`);
  record('登出前 /api/me 已认证', meBefore.status() === 200 && (await meBefore.json()).authenticated === true);

  await page.locator('.ant-avatar').first().click();
  await page.getByText('退出登录', { exact: true }).click();
  await page.waitForURL(u => u.pathname === '/login', { timeout: 20000 });
  await page.waitForTimeout(500);

  const after = await ctx.cookies();
  record('登出后会话 Cookie 已删除', !after.some(c => c.name === 'labspace_session'));
  record('登出后 CSRF Cookie 已删除', !after.some(c => c.name === 'labspace_csrf'));
  const meAfter = await page.request.get(`${BASE}/api/me`);
  const meBody = await meAfter.json();
  record('登出后 /api/me 未认证', meAfter.status() === 200 && meBody.authenticated === false);
  record('登出链路不访问 Casdoor/8090', authRequests.length > 0 && authRequests.every(r => !r.url.includes(':8090')), JSON.stringify(authRequests));
} finally {
  await browser.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
