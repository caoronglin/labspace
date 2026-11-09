// #42「未接入功能」补齐的真实浏览器验证：
// 导航死链、个人资料、通知按钮、/docling 遗留路由、工作台新建项目（含 Go 端 snake_case 绑定修复）。
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const credsFor = (email) => {
  const line = fs
    .readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
    .split('\n')
    .find((l) => l.trimStart().startsWith(email));
  if (!line) throw new Error(`台账缺少 ${email}`);
  return { user: email.split('@')[0], pass: line.trim().split(/\s+/)[1] };
};

let pass = 0;
let fail = 0;
const check = (name, ok, info = '') => {
  ok ? ((pass += 1), console.log(`PASS  ${name}${info ? ' :: ' + info : ''}`)) : ((fail += 1), console.log(`FAIL  ${name}${info ? ' :: ' + info : ''}`));
};

const badStatus = [];

async function login(browser, email) {
  const { user, pass: pw } = credsFor(email);
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } });
  const page = await ctx.newPage();
  page.on('response', (r) => {
    const u = r.url();
    if (r.status() >= 400 && /\/api\//.test(u) && !/\/api\/auth\/me/.test(u)) badStatus.push(`${r.status()} ${u.replace(BASE, '')}`);
  });
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pw);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(5000);
  const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  if (!/工作台|全部服务|文件共享/.test(text)) throw new Error(`${email} 登录失败，停在 ${page.url()}`);
  return { ctx, page };
}

const req = (page, method, url, body) =>
  page.evaluate(
    async ([m, u, b]) => {
      const csrf = document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1] || '';
      const r = await fetch(u, {
        method: m,
        headers: b === undefined ? { 'X-CSRF-Token': csrf } : { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
        body: b === undefined ? undefined : JSON.stringify(b),
        credentials: 'include',
      });
      let json = null;
      try {
        json = await r.json();
      } catch {}
      return { status: r.status, json };
    },
    [method, url, body],
  );

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const { ctx, page } = await login(browser, 'labadmin@local');

/* -------------------------------------------------- 1. 侧栏链接指向真实路由 */
await page.goto(`${BASE}/workbench`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

const sideLink = async (label) => {
  // 侧栏默认折叠，悬浮展开后才有文字链接
  await page.locator('.ant-layout-sider').hover();
  await page.waitForTimeout(600);
  const a = page.locator(`.ant-menu a:has-text("${label}")`).first();
  if (!(await a.count())) return null;
  return a.getAttribute('href');
};

const hrefDoc = await sideLink('文档解析');
const hrefPdf = await sideLink('论文翻译');
const hrefTxt = await sideLink('文本翻译');
check('侧栏「文档解析」直达 /docparse', hrefDoc === '/docparse', `href=${hrefDoc}`);
check('侧栏「论文翻译」直达 /translate', hrefPdf === '/translate', `href=${hrefPdf}`);
check('侧栏「文本翻译」直达 /translation', hrefTxt === '/translation', `href=${hrefTxt}`);

/* -------------------------------------------------- 2. 三个路由都能真正渲染 */
const rendered = async (path, marker) => {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const t = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  return { ok: t.includes(marker) && !t.includes('页面不存在'), len: t.length };
};
const rDoc = await rendered('/docparse', '文档');
const rPdf = await rendered('/translate', '翻译');
const rTxt = await rendered('/translation', '翻译');
check('/docparse 正常渲染', rDoc.ok);
check('/translate 正常渲染', rPdf.ok);
check('/translation 正常渲染', rTxt.ok);

const rOld = await rendered('/docling', '文档解析');
check('/docling 遗留路由显示 404 而非空白页', !rOld.ok);
await page.screenshot({ path: '/opt/labspace/e2e/shots/unwired-docling-404.png' });

/* -------------------------------------------------- 3. 首页快捷入口不落到死路由 */
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const docTile = page.locator('.d509-tile:has-text("文档解析")');
check('首页存在「文档解析」快捷入口', (await docTile.count()) > 0);
if (await docTile.count()) {
  await docTile.click();
  await page.waitForTimeout(3000);
  check('快捷入口跳转后 URL 为 /docparse', page.url().endsWith('/docparse'), page.url());
}

/* -------------------------------------------------- 4. 头部死按钮已移除，个人资料可用 */
const bell = page.locator('.ant-layout-header button:has(.anticon-bell)');
check('头部公告铃铛存在', (await bell.count()) > 0);
await bell.first().click();
await page.waitForTimeout(2000);
const pop = page.locator('.ant-popover:visible');
check('铃铛弹出公告面板（接入真实公告数据）', (await pop.count()) > 0);
if (await pop.count()) {
  const popText = (await pop.first().innerText()).replace(/\s+/g, ' ');
  check('公告面板渲染出内容而非空白', popText.length > 4, popText.slice(0, 80));
  await page.screenshot({ path: '/opt/labspace/e2e/shots/unwired-bell.png' });
}
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

await page.locator('.ant-layout-header .ant-avatar').first().click();
await page.waitForTimeout(900);
const menuText = await page.locator('.ant-dropdown-menu').first().innerText();
check('账户菜单含「个人资料」', menuText.includes('个人资料'));
check('账户菜单不再含无效的「账户设置」', !menuText.includes('账户设置'), menuText.replace(/\n/g, ' | '));
check('管理员账户菜单含「系统设置」', menuText.includes('系统设置'));
await page.locator('.ant-dropdown-menu-item:has-text("个人资料")').first().click();
await page.waitForSelector('.ant-modal', { timeout: 10000 }).catch(() => {});
const modal = page.locator('.ant-modal:has-text("个人资料")');
check('个人资料弹窗打开', (await modal.count()) > 0);
const modalText = (await modal.first().innerText()).replace(/\s+/g, ' ');
check('弹窗显示真实邮箱', modalText.includes('labadmin'), modalText.slice(0, 120));
check('弹窗显示角色', /lab-admin/.test(modalText), modalText.slice(0, 160));
await page.screenshot({ path: '/opt/labspace/e2e/shots/unwired-profile.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

/* -------------------------------------------------- 5. 工作台新建项目（真实写入 + 读回） */
const before = await req(page, 'GET', '/api/workbench/summary');
const beforeCount = (before.json?.projects ?? []).length;

await page.goto(`${BASE}/workbench`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const btn = page.locator('button:has-text("新建项目")');
check('项目面板出现「新建项目」入口', (await btn.count()) > 0);
if (await btn.count()) {
  await btn.first().click();
  await page.waitForTimeout(900);
  const m = page.locator('.ant-modal:has-text("新建项目")');
  check('新建项目弹窗打开', (await m.count()) > 0);
  await m.locator('#name').fill('_e2e 未接入验证项目');
  await m.locator('#next_step').fill('检查 snake_case 字段是否入库');
  await m.locator('#due_date').click();
  await page.waitForTimeout(400);
  await page.locator('.ant-picker-dropdown:visible .ant-picker-cell[title="2026-11-28"]').first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/opt/labspace/e2e/shots/unwired-project-modal.png' });
  await m.locator('.ant-modal-footer button:has-text("创 建"), .ant-modal-footer button:has-text("创建")').first().click();
  await page.waitForTimeout(2500);
  const toast = (await page.evaluate(() => document.body.innerText)).includes('项目已创建');
  check('提交后提示「项目已创建」', toast);

  const after = await req(page, 'GET', '/api/workbench/summary');
  const list = after.json?.projects ?? [];
  const mine = list.find((p) => p.name === '_e2e 未接入验证项目');
  check('项目已写入数据库', Boolean(mine), `count ${beforeCount} → ${list.length}`);
  check(
    'Go 端绑定 next_step（曾静默丢弃）',
    mine?.next_step === '检查 snake_case 字段是否入库',
    `next_step=${JSON.stringify(mine?.next_step)}`,
  );
  check('Go 端绑定 due_date（曾静默丢弃）', mine?.due_date === '2026-11-28', `due_date=${JSON.stringify(mine?.due_date)}`);
  check('Go 端绑定 health/status', mine?.health === 'on_track' && mine?.status === 'active', `${mine?.health}/${mine?.status}`);
  if (mine?.id) {
    const del = await req(page, 'DELETE', `/api/workbench/projects/${encodeURIComponent(mine.id)}`);
    const cleanup = await req(page, 'GET', '/api/workbench/summary');
    const left = (cleanup.json?.projects ?? []).filter((p) => p.name === '_e2e 未接入验证项目').length;
    check('删除测试项目且无残留', del.status === 200 && left === 0, `del=${del.status} left=${left}`);
  } else {
    check('删除测试项目且无残留', false, '没有拿到项目 id');
  }
}

/* -------------------------------------------------- 6. 公告接口仍然存在（删除的是假接口） */
const ann = await req(page, 'GET', '/api/announcements');
check('/api/announcements 返回真实数据', ann.status === 200 && Array.isArray(ann.json?.announcements), `status=${ann.status}`);
const fake = await req(page, 'GET', '/api/teacher/announcements');
check('假接口 /api/teacher/announcements 已下线', fake.status === 404, `status=${fake.status}`);

const unexpected = badStatus.filter((s) => !/^404 /.test(s) || !/teacher\/announcements/.test(s));
check('全程无非预期 4xx/5xx', unexpected.length === 0, unexpected.slice(0, 6).join(' , '));

await ctx.close();
await browser.close();
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
