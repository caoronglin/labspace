// 门户前端「组件打磨」自检脚本（components-polish-test.mjs）
//
// 覆盖本轮组件改造的自检点：
//   1. 目标页面有主标题 + 操作按钮
//   2. 空状态含行动按钮（清除筛选 / 查看全部服务）
//   3. 404 页有站内搜索框 + 3 个常用入口 + 返回首页
//   4. 登录页有品牌区 / SSO 主按钮 / 状态说明 / 兜底链接
//   5. 390 / 768 / 1440 三档无横向溢出
//   6. 控制台无 JS 错误（网络请求失败的资源日志单独记录为提示）
//   7. 截图 shots/polish-*.png
//
// 用法：LAB_PASS=<密码> node components-polish-test.mjs
// 环境变量：LAB_USER / LAB_PASS / LAB_BASE
import { mkdirSync } from 'node:fs';
import { launch, loginContext, BASE } from './_auth.mjs';

const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  { key: 'mobile', width: 390, height: 844 },
  { key: 'tablet', width: 768, height: 1024 },
  { key: 'desktop', width: 1440, height: 900 },
];

const PAGES = [
  { path: '/', key: 'home', label: '首页' },
  { path: '/services', key: 'services', label: '全部服务' },
  { path: '/databases', key: 'databases', label: '数据库' },
  { path: '/weather', key: 'weather', label: '天气' },
  { path: '/nonexistent-path', key: 'notfound', label: '404 页' },
];

const failures = [];
const notes = [];
let checks = 0;

function fail(where, msg) {
  failures.push(`${where} :: ${msg}`);
  console.log(`  ✗ ${where} :: ${msg}`);
}
function pass(where, msg) {
  checks += 1;
  console.log(`  ✓ ${where} :: ${msg}`);
}
function note(where, msg) {
  notes.push(`${where} :: ${msg}`);
  console.log(`  · ${where} :: ${msg}`);
}

/** 收集控制台错误：JS 异常算失败；资源加载失败（401/500 等）只记为提示 */
function attachConsole(page, where) {
  const bag = { js: [], net: [] };
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/Failed to load resource|net::ERR|status of \d{3}/i.test(text)) bag.net.push(text);
    else bag.js.push(text);
  });
  page.on('pageerror', (err) => bag.js.push(`pageerror: ${err.message}`));
  bag.where = where;
  return bag;
}

function assertNoJsErrors(bag) {
  if (bag.js.length) fail(bag.where, `控制台出现 JS 错误：${bag.js.slice(0, 3).join(' | ')}`);
  else pass(bag.where, '控制台无 JS 错误');
  if (bag.net.length) note(bag.where, `资源请求失败 ${bag.net.length} 条（网络层，非 JS 异常）`);
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1200);
  // 等骨架屏 / 加载态结束（最多 8s）
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const busy = await page.evaluate(() => document.querySelectorAll('.ant-skeleton-active').length);
    if (!busy) break;
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(400);
}

async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const wide = [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 3)
      .map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`);
    return { scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth, wide };
  });
}

/** 主标题：语义标题 / 卡片标题 / 页面标题区 */
async function readHeading(page) {
  return page.evaluate(() => {
    const sel = 'h1, h2, h3, [role="heading"], .ant-card-head-title, .ant-typography';
    // 优先取内容区（排除顶栏/侧边栏）内的标题
    const scope = document.querySelector('.ant-layout-content') ?? document;
    for (const el of scope.querySelectorAll(sel)) {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && text.length <= 40) return text;
    }
    return '';
  });
}

async function visibleButtons(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('button, .ant-btn')]
      .filter((el) => {
        const st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
      })
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()),
  );
}

const browser = await launch();
const ctx = await loginContext(browser, BASE);

try {
  // ---------- 1. 页面级断言（桌面视口） ----------
  console.log('\n[1] 页面主标题 / 操作按钮 / 控制台');
  for (const p of PAGES) {
    const page = await ctx.newPage();
    const bag = attachConsole(page, `${p.label} ${p.path}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}${p.path}`, { waitUntil: 'domcontentloaded' });
    await settle(page);

    const heading = await readHeading(page);
    if (heading) pass(`${p.label}`, `主标题存在：「${heading}」`);
    else fail(`${p.label}`, '未找到主标题');

    const btns = await visibleButtons(page);
    if (btns.length) pass(`${p.label}`, `操作按钮 ${btns.length} 个：${btns.slice(0, 4).join(' / ')}`);
    else fail(`${p.label}`, '页面没有可见操作按钮');

    assertNoJsErrors(bag);
    await page.close();
  }

  // ---------- 2. 空状态（含行动按钮） ----------
  console.log('\n[2] 空状态行动按钮');
  {
    const page = await ctx.newPage();
    const bag = attachConsole(page, '空状态');
    await page.setViewportSize({ width: 1440, height: 900 });

    // /services 搜索无结果
    await page.goto(`${BASE}/services`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const search = page.locator('.ant-layout-content input[placeholder*="筛选"]').first();
    await search.fill('zzz-not-exist-service');
    await page.waitForTimeout(600);
    const clearBtn = page.getByRole('button', { name: /清除筛选/ }).first();
    if (await clearBtn.count()) pass('空状态', '/services 空状态含「清除筛选」行动按钮');
    else fail('空状态', '/services 空状态缺少行动按钮');
    const allBtn = page.getByRole('button', { name: /查看全部服务/ }).first();
    if (await allBtn.count()) pass('空状态', '/services 空状态含「查看全部服务」');
    else note('空状态', '/services 空状态未渲染「查看全部服务」按钮');
    await page.screenshot({ path: `${SHOTS}polish-services-empty.png`, fullPage: false });

    // /databases 搜索无结果
    await page.goto(`${BASE}/databases`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const dbSearch = page.locator('.ant-layout-content input[placeholder*="检索"]').first();
    await dbSearch.fill('zzz-not-exist-db');
    await page.waitForTimeout(800);
    const dbClear = page.getByRole('button', { name: /清除筛选/ }).first();
    if (await dbClear.count()) pass('空状态', '/databases 空状态含「清除筛选」行动按钮');
    else fail('空状态', '/databases 空状态缺少行动按钮');
    await page.screenshot({ path: `${SHOTS}polish-databases-empty.png`, fullPage: false });

    assertNoJsErrors(bag);
    await page.close();
  }

  // ---------- 3. 404 页 ----------
  console.log('\n[3] 404 页');
  {
    const page = await ctx.newPage();
    const bag = attachConsole(page, '404 页');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/nonexistent-path`, { waitUntil: 'domcontentloaded' });
    await settle(page);

    const searchCount = await page.locator('input[placeholder*="搜索"], .ant-input-search input').count();
    if (searchCount) pass('404 页', '存在站内搜索框');
    else fail('404 页', '缺少站内搜索框');

    for (const entry of ['工作台', '全部服务', '我的收藏']) {
      const c = await page.getByText(entry, { exact: true }).count();
      if (c) pass('404 页', `常用入口「${entry}」存在`);
      else fail('404 页', `缺少常用入口「${entry}」`);
    }
    const home = page.getByRole('button', { name: /返回首页/ }).first();
    if (await home.count()) pass('404 页', '保留「返回首页」按钮');
    else fail('404 页', '缺少「返回首页」按钮');

    // 回车跳 /search?q=
    const input = page.locator('input[placeholder*="搜索"], .ant-input-search input').first();
    await input.fill('CRISPR');
    await input.press('Enter');
    await page.waitForTimeout(900);
    if (page.url().includes('/search?q=')) pass('404 页', '搜索回车跳转 /search?q=');
    else fail('404 页', `搜索回车未跳转，当前 ${page.url()}`);

    await page.goto(`${BASE}/nonexistent-path`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.screenshot({ path: `${SHOTS}polish-notfound.png` });
    assertNoJsErrors(bag);
    await page.close();
  }

  // ---------- 4. 三档视口无横向溢出 ----------
  console.log('\n[4] 横向溢出检查');
  for (const vp of VIEWPORTS) {
    for (const p of PAGES) {
      const page = await ctx.newPage();
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`${BASE}${p.path}`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const o = await overflow(page);
      if (o.scrollWidth <= o.innerWidth + 1) pass(`${vp.key} ${p.label}`, `无横向溢出（${o.scrollWidth} <= ${o.innerWidth}）`);
      else fail(`${vp.key} ${p.label}`, `出现横向溢出 ${o.scrollWidth} > ${o.innerWidth}；超宽元素：${o.wide.join(', ')}`);
      await page.screenshot({ path: `${SHOTS}polish-${p.key}-${vp.key}.png`, fullPage: false });
      await page.close();
    }
  }

  // ---------- 5. 登录页（未登录上下文） ----------
  console.log('\n[5] 登录页');
  {
    const lctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    // 让 /api/me 保持 pending：登录页停留在「跳转中」状态，便于断言品牌区与兜底链接
    await lctx.route('**/api/me', async () => {
      await new Promise(() => {});
    });
    const page = await lctx.newPage();
    const bag = attachConsole(page, '登录页');
    // 阻止 300ms 后的自动跳转（否则立即跳 Casdoor），页面本身渲染逻辑不变
    await page.addInitScript(() => {
      const orig = window.setTimeout;
      window.setTimeout = function (fn, delay, ...args) {
        if (delay === 300) return 0;
        return orig.call(window, fn, delay, ...args);
      };
    });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    const brand = await page.getByText('D509 实验室工作台', { exact: true }).count();
    if (brand) pass('登录页', '品牌区名称存在');
    else fail('登录页', '缺少品牌区名称');

    const sso = await page.getByRole('button', { name: /统一身份认证登录/ }).count();
    if (sso) pass('登录页', 'SSO 主按钮存在');
    else fail('登录页', '缺少 SSO 主按钮');

    const status = await page.getByText(/正在跳转/).count();
    if (status) pass('登录页', '跳转状态说明存在');
    else fail('登录页', '缺少跳转状态说明');

    for (const link of ['回到首页', '服务状态']) {
      const c = await page.getByText(link, { exact: true }).count();
      if (c) pass('登录页', `兜底链接「${link}」存在`);
      else fail('登录页', `缺少兜底链接「${link}」`);
    }

    const o = await overflow(page);
    if (o.scrollWidth <= o.innerWidth + 1) pass('登录页', `无横向溢出（${o.scrollWidth} <= ${o.innerWidth}）`);
    else fail('登录页', `出现横向溢出 ${o.scrollWidth} > ${o.innerWidth}`);

    await page.screenshot({ path: `${SHOTS}polish-login.png` });
    assertNoJsErrors(bag);

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(300);
      const ov = await overflow(page);
      if (ov.scrollWidth <= ov.innerWidth + 1) pass(`登录页 ${vp.key}`, '无横向溢出');
      else fail(`登录页 ${vp.key}`, `出现横向溢出 ${ov.scrollWidth} > ${ov.innerWidth}`);
      await page.screenshot({ path: `${SHOTS}polish-login-${vp.key}.png` });
    }
    await lctx.close();
  }
} finally {
  await ctx.close();
  await browser.close();
}

console.log(`\n断言通过 ${checks} 项，失败 ${failures.length} 项，提示 ${notes.length} 条`);
if (notes.length) {
  console.log('\n提示：');
  notes.forEach((n) => console.log('  - ' + n));
}
if (failures.length) {
  console.log('\n失败：');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('\n全部通过 ✅');
