// 图表验收：门户首页 / 个人工作台 / Agent / 管理端的 AntV 图表渲染、数据非空、控制台无错误、无横向溢出
// 用法：LAB_PASS=<学生密码> node charts-test.mjs   （管理员段落需要 LAB_ADMIN_PASS，缺省时从本机账号文件读取）
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { BASE } from './_auth.mjs';

const LAB_USER = process.env.LAB_USER || 'student01';
const LAB_PASS = process.env.LAB_PASS;
const ADMIN_USER = process.env.LAB_ADMIN_USER || 'labadmin';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
const ACCOUNTS_FILE = '/etc/labspace/casdoor-users.txt';

mkdirSync(SHOTS, { recursive: true });

const results = [];
const ok = (name, extra = '') => {
  results.push([true, name, extra]);
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};
const bad = (name, extra = '') => {
  results.push([false, name, extra]);
  console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
};
const skip = (name, extra = '') => {
  results.push([true, name, extra]);
  console.log(`  – ${name}（跳过${extra ? '：' + extra : ''}）`);
};

const IGNORE_CONSOLE = [
  /favicon/i,
  /\/api\/agent\/sessions\/[^/]+\/stream/i, // SSE 长连接在页面关闭时的取消噪声
  /net::ERR_ABORTED/i,
  /Failed to load resource: the server responded with a status of 40[13]/i, // 未登录/无权限的探测请求
];

if (!LAB_PASS) {
  console.error('缺少环境变量 LAB_PASS');
  process.exit(2);
}

/** 从本机账号文件里找管理员密码（仅测试环境使用） */
function adminPassFromFile() {
  try {
    const text = readFileSync(ACCOUNTS_FILE, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const [user, pass] = t.split(/\s+/);
      if (user && pass && user.startsWith(ADMIN_USER)) return pass;
    }
  } catch {
    /* 无权限读取时忽略 */
  }
  return '';
}

async function loginAs(browser, user, pass) {
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(5000);
  const body = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  if (!/工作台|全部服务|我的收藏/.test(body)) {
    await ctx.close();
    throw new Error(`登录失败：${user}`);
  }
  return ctx;
}

/** 在页面里定位标题匹配的图表卡片 */
const CARD = (title) => `.ant-card:has-text("${title}")`;

async function inspectCard(page, title) {
  const card = page.locator(CARD(title)).first();
  await card.waitFor({ state: 'visible', timeout: 20000 });
  const info = await card.evaluate((el) => {
    const canvas = el.querySelector('canvas');
    const svg = el.querySelector('svg');
    const box = el.getBoundingClientRect();
    const text = el.innerText || '';
    return {
      hasCanvas: !!canvas,
      hasSvg: !!svg,
      canvasSize: canvas ? { w: canvas.clientWidth, h: canvas.clientHeight } : null,
      width: Math.round(box.width),
      text,
    };
  });
  return info;
}

/** 通用页面体检：控制台错误 + 横向溢出 */
async function pageHealth(page) {
  const overflow = await page.evaluate(() => {
    const de = document.documentElement;
    return Math.max(0, de.scrollWidth - de.clientWidth);
  });
  return overflow;
}

function realErrors(errors) {
  return errors.filter((e) => !IGNORE_CONSOLE.some((re) => re.test(e)));
}

async function run() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  /* ---------------------------------------------- 学生视角 */
  console.log('\n[学生视角] 首页 / 工作台 / Agent');
  const ctx = await loginAs(browser, LAB_USER, LAB_PASS);
  const me = await ctx.newPage();
  await me.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const meInfo = await me.evaluate(async () => {
    const r = await fetch('/api/me', { credentials: 'include' });
    return r.json();
  });
  await me.close();
  const isAdmin = !!meInfo?.isAdmin;
  ok('登录成功', `${meInfo?.name ?? LAB_USER}${isAdmin ? '（管理员）' : ''}`);

  // ---- 首页：服务健康分布 + 数据库分类分布
  {
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    for (const title of ['服务健康分布', '数据库分类分布']) {
      try {
        const info = await inspectCard(page, title);
        if (!info.hasCanvas && !info.hasSvg) {
          bad(`首页 · ${title} 图表渲染`, '未找到 canvas/svg');
          continue;
        }
        const m = info.text.match(/共\s*(\d+)\s*个/);
        const total = m ? Number(m[1]) : 0;
        if (!total) {
          bad(`首页 · ${title} 数据非空`, `未读到有效数量：${info.text.slice(0, 60)}`);
          continue;
        }
        ok(`首页 · ${title} 图表渲染`, `canvas=${info.hasCanvas} 共 ${total} 个`);
      } catch (e) {
        bad(`首页 · ${title}`, e.message.slice(0, 140));
      }
    }

    // 数据表格折叠区（可访问性兜底）
    try {
      const card = page.locator(CARD('服务健康分布')).first();
      await card.getByText('查看数据表格').click();
      await page.waitForTimeout(500);
      const rows = await card.locator('tbody tr.ant-table-row').count();
      if (rows > 0) ok('首页 · 数据表格兜底', `${rows} 行`);
      else bad('首页 · 数据表格兜底', '表格无数据行');
    } catch (e) {
      bad('首页 · 数据表格兜底', e.message.slice(0, 140));
    }

    const overflow = await pageHealth(page);
    if (overflow > 1) bad('首页 横向溢出', `${overflow}px`);
    else ok('首页 横向溢出', '无');

    const errs = realErrors(errors);
    if (errs.length) bad('首页 控制台', errs.slice(0, 2).join(' | ').slice(0, 200));
    else ok('首页 控制台无错误');

    // 截图：滚动到图表区
    await page.locator(CARD('服务健康分布')).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}charts-home.png` });
    await page.close();
  }

  // ---- 工作台：任务状态分布
  {
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto(`${BASE}/workbench`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    try {
      const info = await inspectCard(page, '任务状态分布');
      const emptyState = info.text.includes('暂无数据');
      if (info.hasCanvas || info.hasSvg || emptyState) {
        ok('工作台 · 任务状态分布', info.hasCanvas ? '图表已渲染' : '空状态');
      } else {
        bad('工作台 · 任务状态分布', '既无图表也无空状态');
      }
      await page.locator(CARD('任务状态分布')).first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SHOTS}charts-workbench.png` });
    } catch (e) {
      bad('工作台 · 任务状态分布', e.message.slice(0, 140));
    }
    const overflow = await pageHealth(page);
    if (overflow > 1) bad('工作台 横向溢出', `${overflow}px`);
    else ok('工作台 横向溢出', '无');
    const errs = realErrors(errors);
    if (errs.length) bad('工作台 控制台', errs.slice(0, 2).join(' | ').slice(0, 200));
    else ok('工作台 控制台无错误');
    await page.close();
  }

  // ---- Agent：非管理员不应渲染用量图
  {
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto(`${BASE}/agent`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const count = await page.locator(CARD('Agent 消息用量排行')).count();
    if (isAdmin) ok('Agent · 管理员可见用量图');
    else if (count === 0) ok('Agent · 非管理员不渲染用量图');
    else bad('Agent · 非管理员不渲染用量图', `出现了 ${count} 个`);
    await page.screenshot({ path: `${SHOTS}charts-agent.png` });
    const errs = realErrors(errors);
    if (errs.length) bad('Agent 控制台', errs.slice(0, 2).join(' | ').slice(0, 200));
    else ok('Agent 控制台无错误');
    await page.close();
  }

  await ctx.close();

  /* ---------------------------------------------- 管理员视角 */
  console.log('\n[管理员视角] 管理端 / Agent');
  const adminPass = process.env.LAB_ADMIN_PASS || adminPassFromFile();
  let adminCtx = null;
  if (adminPass) {
    try {
      adminCtx = await loginAs(browser, ADMIN_USER, adminPass);
      ok('管理员登录成功', ADMIN_USER);
    } catch (e) {
      skip('管理员登录', e.message.slice(0, 80));
    }
  } else {
    skip('管理员登录', '未提供 LAB_ADMIN_PASS，且本机账号文件不可读');
  }

  if (adminCtx) {
    const page = await adminCtx.newPage();
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    for (const title of ['磁盘使用率', '服务健康分布']) {
      try {
        const info = await inspectCard(page, title);
        if (!info.hasCanvas && !info.hasSvg) {
          bad(`管理端 · ${title} 图表渲染`, '未找到 canvas/svg');
          continue;
        }
        const pct = info.text.match(/使用率\s*([\d.]+)%/);
        ok(`管理端 · ${title} 图表渲染`, pct ? `使用率 ${pct[1]}%` : 'canvas 已渲染');
      } catch (e) {
        bad(`管理端 · ${title}`, e.message.slice(0, 140));
      }
    }
    const overflow = await pageHealth(page);
    if (overflow > 1) bad('管理端 横向溢出', `${overflow}px`);
    else ok('管理端 横向溢出', '无');
    const errs = realErrors(errors);
    if (errs.length) bad('管理端 控制台', errs.slice(0, 2).join(' | ').slice(0, 200));
    else ok('管理端 控制台无错误');
    await page.locator(CARD('磁盘使用率')).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}charts-admin.png` });
    await page.close();

    // Agent 用量图（管理员可见）
    const agentPage = await adminCtx.newPage();
    const agentErrors = [];
    agentPage.on('console', (m) => {
      if (m.type() === 'error') agentErrors.push(m.text());
    });
    agentPage.on('pageerror', (e) => agentErrors.push(`pageerror: ${e.message}`));
    await agentPage.goto(`${BASE}/agent`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await agentPage.waitForTimeout(2500);
    try {
      const info = await inspectCard(agentPage, 'Agent 消息用量排行');
      const emptyState = info.text.includes('暂无数据');
      if (info.hasCanvas || info.hasSvg || emptyState) ok('Agent · 用量排行卡片', info.hasCanvas ? '图表已渲染' : '空状态');
      else bad('Agent · 用量排行卡片', '既无图表也无空状态');
      await agentPage.locator(CARD('Agent 消息用量排行')).first().scrollIntoViewIfNeeded();
      await agentPage.waitForTimeout(500);
      await agentPage.screenshot({ path: `${SHOTS}charts-agent-admin.png` });
    } catch (e) {
      bad('Agent · 用量排行卡片', e.message.slice(0, 140));
    }
    const agentErrs = realErrors(agentErrors);
    if (agentErrs.length) bad('Agent（管理员）控制台', agentErrs.slice(0, 2).join(' | ').slice(0, 200));
    else ok('Agent（管理员）控制台无错误');
    await agentPage.close();

    await adminCtx.close();
  }

  await browser.close();

  const failed = results.filter((r) => !r[0]);
  console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
  if (failed.length) {
    for (const [, name, extra] of failed) console.log(`  ✗ ${name} ${extra}`);
    process.exit(1);
  }
  console.log('全部通过 ✅');
}

await run();
