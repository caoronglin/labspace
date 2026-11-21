// 重置初始化后验收：门户可用、目录可查、工作台可写、Agent 可建会话
import { chromium } from '/opt/labspace/e2e/node_modules/playwright/index.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1';
const PASS = process.env.LAB_PASS || '';
const USER = process.env.LAB_USER || 'student01';

const fails = [];
const ok = (cond, label) => {
  console.log(`${cond ? '[ OK ]' : '[FAIL]'} ${label}`);
  if (!cond) fails.push(label);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });

// 1. 登录
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForURL(/192\.168\.5\.12:8090/, { timeout: 20000 });
await page.fill('#username', USER);
await page.fill('#password', PASS);
await Promise.all([
  page.waitForURL(/192\.168\.5\.12\/(?!api)/, { timeout: 30000 }),
  page.getByRole('button', { name: /登录|Log in|Login/i }).first().click(),
]);
await page.waitForLoadState('networkidle').catch(() => {});
ok(page.url().startsWith(BASE), `登录后回到门户 → ${page.url()}`);
// 登录前（OIDC 跳转过程中）应用外壳会先发几个未鉴权请求 → 401，属预期行为，这里清空只统计登录后的错误
consoleErrors.length = 0;

// 2. 首页：服务卡片 + 收藏为空（已重置）
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const cards = await page.locator('.lab-service-card').count();
ok(cards >= 10, `首页服务卡片 ${cards} 张`);
const heroText = await page.locator('body').innerText();
ok(/全部服务|常用服务|工作台/.test(heroText), '首页含核心区块');

// 3. 数据库目录仍可用（重置只清业务数据，目录是静态配置）
await page.goto(`${BASE}/databases`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const dbText = await page.locator('body').innerText();
ok(/已接入 API|仅网页访问|数据库/.test(dbText), '数据库目录页正常');

// 4. 工作台可写（capture）；CSRF 令牌来自 Cookie labspace_csrf
const cookies = await ctx.cookies();
const token = cookies.find((c) => c.name === 'labspace_csrf')?.value ?? '';
ok(!!token, `已取得 CSRF Cookie（${token ? token.slice(0, 8) + '…' : '缺失'}）`);
const cap = await page.evaluate(async (t) => {
  const r = await fetch('/api/workbench/capture', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': t },
    body: JSON.stringify({ text: '重置验收：明天下午提交实验报告' }),
  });
  return { status: r.status, body: await r.json() };
}, token);
ok(cap.status === 200 && cap.body?.item?.kind === 'task', `工作台捕获可用 → kind=${cap.body?.item?.kind}`);

// 5. 工作台首页渲染
await page.goto(`${BASE}/workbench`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const wbText = await page.locator('body').innerText();
ok(/AI|工作台|计划/.test(wbText), '个人工作台页渲染');

// 6. Agent 可建会话（模型白名单已回落内置默认）
const sess = await page.evaluate(async (t) => {
  const r = await fetch('/api/agent/sessions?title=%E9%87%8D%E7%BD%AE%E9%AA%8C%E6%94%B6', {
    method: 'POST', credentials: 'include',
    headers: { 'X-CSRF-Token': t },
  });
  return { status: r.status, body: await r.text() };
}, token);
ok(sess.status === 200 && /"id"/.test(sess.body || ''), `Agent 建会话可用 → ${sess.status} ${(sess.body || '').slice(0, 120)}`);
const sessId = (() => { try { return JSON.parse(sess.body).session?.id; } catch { return null; } })();
if (sessId) {
  await page.evaluate(async ([id, t]) => {
    await fetch(`/api/agent/sessions/${id}`, { method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': t } });
  }, [sessId, token]);
}

// 7. 清理本次验收写入的工作台条目，恢复干净状态
const cleaned = await page.evaluate(async (t) => {
  const r = await fetch('/api/workbench/items', { credentials: 'include' });
  const j = await r.json();
  const items = j?.items ?? [];
  let n = 0;
  for (const it of items) {
    const d = await fetch(`/api/workbench/items/${it.id}`, { method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': t } });
    if (d.ok) n += 1;
  }
  return { total: items.length, deleted: n };
}, token);
ok(cleaned.deleted === cleaned.total, `验收数据已清理（${cleaned.deleted}/${cleaned.total}）`);

const realErrors = consoleErrors.filter((e) => !/favicon|\.js\?t=|ERR_/.test(e));
ok(realErrors.length === 0, `控制台无错误${realErrors.length ? ` → ${realErrors.slice(0, 2).join(' | ')}` : ''}`);
console.log(`\n重置后验收：通过 ${8 - fails.length} 项，失败 ${fails.length}`);
if (fails.length) console.log('失败项:', fails.join(' | '));
await browser.close();
process.exit(fails.length ? 1 : 0);
