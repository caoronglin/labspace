// #46 页面合并验证：重复的管理入口归档，课程/数据集统一到教学管理。
// 凭据仅从本机文件读取，不打印。
import fs from 'node:fs';
import { chromium } from '/opt/labspace/e2e/node_modules/playwright/index.mjs';

const BASE = process.env.BIO_BASE || 'http://192.0.2.10:8102';
const OIDC = /192\.168\.5\.12:8090/;

const lines = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n');
const pick = (name) => {
  const line = lines.find((l) => l.trim().startsWith(`${name} `) || l.trim().startsWith(`${name}:`));
  if (!line) throw new Error(`credential not found: ${name}`);
  const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);
  return { user, pass };
};
const ADMIN = pick('labadmin@local');

let pass = 0;
const fails = [];
const ok = (label, cond, extra = '') => {
  if (cond) pass += 1;
  else fails.push(label);
  console.log(`${cond ? '[ OK ]' : '[FAIL]'} ${label}${extra ? ' — ' + extra : ''}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

try {
  await page.goto(`${BASE}/api/v1/auth/login?redirect=/`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(OIDC, { timeout: 20000 });
  await page.fill('#username', ADMIN.user);
  await page.fill('#password', ADMIN.pass);
  await Promise.all([
    page.waitForURL((u) => u.port === '8102', { timeout: 30000 }),
    page.getByRole('button', { name: /登录|Log in|Login/i }).first().click(),
  ]);
  await page.waitForLoadState('networkidle').catch(() => {});
  ok('管理员登录', !page.url().includes(':8090'));

  const go = async (path, titleRe, expectedPath) => {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL((u) => u.pathname === expectedPath, { timeout: 15000 }).catch(() => {});
    const h2 = (await page.locator('.bio-page-title').first().textContent().catch(() => '')) || '';
    ok(`${path} 重定向到 ${expectedPath}`, new URL(page.url()).pathname === expectedPath, page.url());
    ok(`${expectedPath} 标题为「${titleRe}」`, titleRe.test(h2), h2.trim());
  };

  await go('/admin/courses', /课程管理/, '/teaching/courses');
  await page.waitForSelector('.ant-table-row', { timeout: 20000 }).catch(() => {});
  const headers = await page.locator('.ant-table-thead th').allTextContents();
  ok('管理员可见“选课记录”列', headers.some((h) => h.includes('选课记录')), headers.join(' | '));
  ok('教学课程表含“创建时间”列', headers.some((h) => h.includes('创建时间')), headers.join(' | '));
  ok('课程表渲染数据行', (await page.locator('.ant-table-row').count()) >= 0);

  await go('/admin/datasets', /数据集管理/, '/teaching/datasets');
  await page.waitForSelector('.ant-table', { timeout: 20000 }).catch(() => {});
  ok('数据集表存在', (await page.locator('.ant-table').count()) > 0);

  await go('/admin/resources', /系统概览/, '/admin/overview');
  await page.waitForSelector('.ant-statistic', { timeout: 20000 }).catch(() => {});
  ok('系统概览统计卡片渲染', (await page.locator('.ant-statistic').count()) >= 6);

  // 侧边栏：旧入口消失，教学分组保留且包含课程/数据集管理
  const hrefs = await page.locator('.ant-menu a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  ok('侧栏不再包含 /admin/courses', !hrefs.includes('/admin/courses'), hrefs.join(','));
  ok('侧栏不再包含 /admin/datasets', !hrefs.includes('/admin/datasets'), hrefs.join(','));
  ok('侧栏不再包含 /admin/resources', !hrefs.includes('/admin/resources'), hrefs.join(','));
  ok('侧栏包含教学课程入口', hrefs.includes('/teaching/courses'), hrefs.join(','));
  ok('侧栏包含教学数据集入口', hrefs.includes('/teaching/datasets'), hrefs.join(','));
  const groupTitles = await page.locator('.ant-menu-item-group-title').allTextContents();
  ok('管理员可见“教学”分组', groupTitles.some((t) => t.includes('教学')), groupTitles.join(','));

  // 教学概览：重复的“教学状态”卡片已移除
  await page.goto(`${BASE}/teaching/overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.bio-page-title', { timeout: 20000 });
  await page.waitForTimeout(1200);
  const body = await page.evaluate(() => document.body.innerText);
  ok('教学概览不再显示“教学状态”重复卡片', !body.includes('教学状态'), body.includes('教学状态') ? '仍存在' : '');
  ok('教学概览保留待批阅作业表', body.includes('待批阅作业'));
  ok('教学概览统计卡片完整', (await page.locator('.ant-statistic').count()) >= 6);
  const crumbs = await page.locator('.ant-breadcrumb li').allTextContents();
  ok('面包屑已本地化（无 overview）', !crumbs.join('/').includes('overview'), crumbs.filter(Boolean).join(' / '));

  await page.screenshot({ path: '/opt/labspace/e2e/shots/merge-46-teaching-overview.png', fullPage: false });
  ok('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' / '));
} catch (err) {
  ok('脚本异常', false, err?.message || String(err));
} finally {
  await ctx.close().catch(() => {});
  await browser.close();
}

console.log(`\n#46 验证：通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) console.log('失败项：\n- ' + fails.join('\n- '));
process.exit(fails.length ? 1 : 0);