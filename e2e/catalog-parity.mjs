// 服务目录一致性校验：Go 核心（LabGo）与 Python 兼容实现必须给出同样的结果
//
// - Go 侧：浏览器经 nginx → /api/services（已切到 Go）与 /api/next/v1/services
// - Python 侧：直连后端容器端口 127.0.0.1:8088/api/services（读 Go 导出文件 + 角色过滤）
//
// 用法：LAB_PASS=<student01 口令> LAB_ADMIN_PASS=<labadmin 口令> node e2e/catalog-parity.mjs
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const BACKEND = process.env.LAB_BACKEND || 'http://127.0.0.1:8088';

const KEY_ORDER = [
  'id', 'name', 'description', 'category', 'url', 'icon', 'openMode', 'embed',
  'embedUrl', 'ssoUrl', 'langNote', 'tags', 'roles', 'notes', 'guide', 'external',
];

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

const fetchJson = (page, path) => page.evaluate(async (p) => {
  const r = await fetch(p, { credentials: 'include' });
  return { status: r.status, body: await r.json() };
}, path);

// 直连 Python 后端（绕过 nginx，确保比对的是 Python 侧实现）
async function fetchBackend(ctx, path) {
  const cookies = await ctx.cookies(BASE);
  const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const host = BASE.replace(/^https?:\/\//, '');
  const resp = await fetch(`${BACKEND}${path}`, {
    headers: { cookie: header, host, 'x-forwarded-host': host },
  });
  return { status: resp.status, body: await resp.json() };
}

let diffs = 0;
const note = (msg) => { console.log(msg); diffs++; };

for (const who of [
  { key: 'student', user: process.env.LAB_USER || 'student01', pass: process.env.LAB_PASS || '' },
  { key: 'admin', user: process.env.LAB_ADMIN_USER || 'labadmin', pass: process.env.LAB_ADMIN_PASS || '' },
]) {
  const s = await login(who.user, who.pass);
  const goRes = await fetchJson(s.page, '/api/services');
  const pyRes = await fetchBackend(s.ctx, '/api/services');
  await s.browser.close();

  const go = goRes.body.services || [];
  const py = pyRes.body.services || [];
  console.log(`\n[${who.key}] Go ${go.length} 项 / Python ${py.length} 项`);

  const goMap = new Map(go.map((x) => [x.id, x]));
  const pyMap = new Map(py.map((x) => [x.id, x]));
  for (const id of new Set([...goMap.keys(), ...pyMap.keys()])) {
    if (!goMap.has(id)) { note(`  ✗ 仅 Python 有: ${id}`); continue; }
    if (!pyMap.has(id)) { note(`  ✗ 仅 Go 有: ${id}`); continue; }
    for (const k of KEY_ORDER) {
      const a = JSON.stringify(goMap.get(id)[k] ?? null);
      const b = JSON.stringify(pyMap.get(id)[k] ?? null);
      if (a !== b) note(`  ✗ ${id}.${k}: Go=${a} Python=${b}`);
    }
  }
}

console.log(diffs === 0 ? '\n结论：Go 与 Python 服务目录字段完全一致' : `\n结论：存在 ${diffs} 处差异`);
process.exit(diffs === 0 ? 0 : 1);
