// D509 新功能页面验收：个人工作台 / Agent 助手 / 论文翻译 / 天气 / 文档解析 / 管理端 Agent 面板 / 新版首页
import { launch, BASE } from './_auth.mjs';
import { mkdirSync } from 'node:fs';

const LAB_PASS = process.env.LAB_PASS;
const ADMIN_USER = process.env.LAB_ADMIN_USER || 'labadmin';
const ADMIN_PASS = process.env.LAB_ADMIN_PASS || process.env.LAB_PASS;

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

const results = [];
const ok = (name, extra = '') => { results.push([true, name, extra]); console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); };
const bad = (name, extra = '') => { results.push([false, name, extra]); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); };

mkdirSync(new URL('./shots/', import.meta.url).pathname, { recursive: true });

const IGNORE_CONSOLE = [
  /favicon/i,
  /\/api\/agent\/sessions\/[^/]+\/stream/i, // SSE 长连接在页面关闭时的取消噪声
];

async function checkPage(ctx, path, { label, expect: expectFn, viewport } = {}) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORE_CONSOLE.some((re) => re.test(m.text()))) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  if (viewport) await page.setViewportSize(viewport);
  let detail = '';
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);
    const text = await page.evaluate(() => document.body.innerText);
    const verdict = expectFn ? await expectFn(page, text) : { pass: true };
    if (verdict.pass) ok(label, verdict.detail || detail);
    else bad(label, verdict.detail || '断言未满足');
    detail = verdict.detail || '';
    await page.screenshot({ path: new URL(`./shots/new-${label.replace(/[^\w一-龥]/g, '_')}.png`, import.meta.url).pathname, fullPage: false });
  } catch (e) {
    bad(label, e.message.slice(0, 160));
  }
  const real = errors.filter((e) => !/net::ERR_ABORTED|Failed to load resource: the server responded with a status of 401/.test(e));
  if (real.length) bad(`${label} 控制台`, real.slice(0, 2).join(' | ').slice(0, 200));
  else ok(`${label} 控制台无错误`);
  await page.close();
}

const browser = await launch();

// ---------- 学生视角 ----------
const ctx = await loginAs(browser, process.env.LAB_USER || 'student01', LAB_PASS);
console.log('\n[学生视角]');

await checkPage(ctx, '/workbench', {
  label: '个人工作台',
  expect: async (page, text) => {
    const has = /工作台/.test(text);
    const capture = await page.locator('textarea').count();
    return { pass: has && capture > 0, detail: has ? `输入框 ${capture} 个` : '未找到工作台标题' };
  },
});

await checkPage(ctx, '/agent', {
  label: 'Agent 助手',
  expect: async (page, text) => {
    const has = /Agent|助手/.test(text);
    const newBtn = await page.getByRole('button', { name: /新建会话|新会话/ }).count();
    return { pass: has && newBtn > 0, detail: `新建会话按钮 ${newBtn} 个` };
  },
});

await checkPage(ctx, '/translation', {
  label: '论文翻译',
  expect: async (page, text) => {
    const has = /翻译/.test(text);
    const hasAlert = /不可达|未启动|服务不可用|模型服务/.test(text);
    const hasArea = await page.locator('textarea').count();
    return { pass: has && hasArea > 0, detail: `${hasAlert ? '已提示模型未就绪' : '模型就绪'}` };
  },
});

await checkPage(ctx, '/weather', {
  label: '天气',
  expect: async (page, text) => {
    const has = /天气/.test(text);
    const hasData = /℃|预报|查询|温度/.test(text);
    return { pass: has && hasData, detail: hasData ? '有天气内容' : '缺少天气内容' };
  },
});

await checkPage(ctx, '/docparse', {
  label: '文档解析',
  expect: async (page, text) => {
    const has = /文档解析|上传|拖拽/.test(text);
    const hasUpload = await page.locator('.ant-upload-drag').count();
    return { pass: has && hasUpload > 0, detail: `拖拽区 ${hasUpload} 个` };
  },
});

await checkPage(ctx, '/', {
  label: '新版首页',
  viewport: { width: 1440, height: 900 },
  expect: async (page, text) => {
    const cards = await page.locator('.lab-service-card').count();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const hasTools = /工具箱|快捷入口|常用服务/.test(text);
    return { pass: cards > 0 && overflow <= 0 && hasTools, detail: `服务卡 ${cards} 张，横向溢出 ${overflow}px` };
  },
});

await checkPage(ctx, '/', {
  label: '首页移动端',
  viewport: { width: 390, height: 844 },
  expect: async (page) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    return { pass: overflow <= 0, detail: `横向溢出 ${overflow}px` };
  },
});

await ctx.close();

// ---------- 管理员视角 ----------
const adminCtx = await loginAs(browser, ADMIN_USER, ADMIN_PASS);
console.log('\n[管理员视角]');
await checkPage(adminCtx, '/admin', {
  label: '管理端 Agent 面板',
  expect: async (page, text) => {
    const tab = await page.getByRole('tab', { name: /Agent 模型与配额/ }).count();
    if (!tab) return { pass: false, detail: '未找到 Agent 模型与配额 页签' };
    await page.getByRole('tab', { name: /Agent 模型与配额/ }).first().click();
    await page.waitForTimeout(2500);
    const t2 = await page.evaluate(() => document.body.innerText);
    const has = /模型白名单|配额|用量统计/.test(t2);
    return { pass: has, detail: has ? '面板已渲染' : '面板内容缺失' };
  },
});
await adminCtx.close();

await browser.close();

const failed = results.filter((r) => !r[0]);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：');
  failed.forEach(([, n, d]) => console.log(` - ${n}: ${d}`));
  process.exit(1);
}
