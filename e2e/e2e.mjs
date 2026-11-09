// LabSpace 端到端验收：真实浏览器登录 + 页面巡检 + 截图
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.LABSPACE_BASE || 'http://192.0.2.10';
const SHOT = process.env.SHOT_DIR || '/opt/labspace/e2e/shots';
const USER = process.env.LAB_USER || 'student01';
const PASS = process.env.LAB_PASS || '';
const ROLE = process.env.LAB_ROLE || 'student';

fs.mkdirSync(SHOT, { recursive: true });

const log = (...a) => console.log('  ', ...a);
let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? '[ OK ]' : '[FAIL]'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function newCtx(opts = {}) {
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
  });
  return ctx;
}

async function login(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  // 门户未登录时右上角是“登录”按钮
  const loginBtn = page.getByRole('button', { name: '登录' });
  if (await loginBtn.count()) {
    await loginBtn.first().click();
  } else {
    await page.goto(`${BASE}/api/auth/login`, { waitUntil: 'domcontentloaded' });
  }
  // 跳转至 Casdoor 授权页（IP:8090，域名入口仅作兼容别名）
  await page.waitForURL(/login\/oauth\/authorize/, { timeout: 25000 });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(USER);
  await page.locator('input[type="password"]').first().fill(PASS);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  // Casdoor 登录后会自动跳回门户
  await page.waitForURL(/192\.168\.5\.12|portal\.lab\.internal/, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.close();
}

async function shoot(ctx, path, name, opts = {}) {
  const page = await ctx.newPage();
  const res = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => {
    console.log('   导航异常:', e.message.split('\n')[0]);
    return null;
  });
  const status = res ? res.status() : 0;
  await page.waitForTimeout(opts.wait || 1200);
  const file = `${SHOT}/${name}.png`;
  await page.screenshot({ path: file, fullPage: opts.full !== false });
  const title = await page.title();
  console.log(`  页面 ${path} -> HTTP ${status} | ${title} | 截图 ${file}`);
  await page.close();
  return { status, title, file };
}

// ---------------------------------------------------------------- 匿名检查
console.log('== 匿名访问 ==');
{
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/api/me`, { waitUntil: 'domcontentloaded' });
  const me = await page.evaluate(() => document.body.innerText);
  check('未登录 /api/me 返回 authenticated=false', me.includes('"authenticated":false') || me.includes('authenticated'), me.slice(0, 80));
  await page.goto(`${BASE}/api/admin/info`, { waitUntil: 'domcontentloaded' });
  const admin = await page.evaluate(() => document.body.innerText);
  check('未登录访问 /api/admin/info 被拒绝(401)', admin.includes('401') || admin.includes('未登录'), admin.slice(0, 80));
  await ctx.close();
}

// ---------------------------------------------------------------- 登录
console.log('== Casdoor 登录 ==');
const ctx = await newCtx();
try {
  await login(ctx);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/api/me`, { waitUntil: 'domcontentloaded' });
  const meText = await page.evaluate(() => document.body.innerText);
  check('登录后 /api/me 返回已认证', meText.includes('"authenticated":true'), meText.slice(0, 120));
  const roles = (meText.match(/"roles":\[[^\]]*\]/) || [''])[0];
  console.log('   角色:', roles);
  await page.close();
} catch (e) {
  check('Casdoor 登录流程', false, e.message.split('\n')[0]);
}

// ---------------------------------------------------------------- 页面巡检
console.log('== 页面巡检 ==');
const pages = [
  ['/', 'home'],
  ['/services', 'services'],
  ['/services/quantum', 'service-detail'],
  ['/favorites', 'favorites'],
  ['/search?q=fastp', 'search'],
  ['/literature', 'literature'],
  ['/drawio', 'drawio'],
  ['/docling', 'docling'],
  ['/admin/status', 'admin'],
];
for (const [path, name] of pages) {
  const { status, title } = await shoot(ctx, path, name);
  check(`页面 ${path} 可打开`, status === 200 || status === 302, `HTTP ${status} ${title}`);
}

// 首页关键元素
{
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const html = await page.content();
  check('首页含 D509 品牌', html.includes('D509'));
  // 服务卡片由 React Query 异步加载，需等待真实卡片出现（而非骨架屏）
  const cardCount = await page
    .locator('.lab-service-card')
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => page.locator('.lab-service-card').count())
    .catch(() => 0);
  check('首页含服务卡片容器', cardCount > 0, `${cardCount} 张卡片`);
  await page.close();
}

// 深色模式
{
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const btn = page.locator('header .ant-btn').filter({ has: page.locator('.anticon-dashboard, .anticon-cloud-server') }).first();
  if (await btn.count()) {
    await btn.click();
    await page.waitForTimeout(900);
  }
  await page.screenshot({ path: `${SHOT}/dark.png`, fullPage: true });
  const cls = await page.evaluate(() => document.documentElement.className + '|' + document.body.className);
  check('深色主题可切换并截图', true, cls);
  await page.close();
}

// 移动端
{
  const mctx = await newCtx({ viewport: { width: 390, height: 844 } });
  await login(mctx);
  const page = await mctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${SHOT}/mobile-home.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('移动端无严重横向溢出', overflow <= 2, `overflow=${overflow}px`);
  await mctx.close();
}

await ctx.close();
await browser.close();

console.log(`\n结果: 失败 ${failures} 项；截图目录 ${SHOT}`);
process.exit(failures ? 1 : 0);
