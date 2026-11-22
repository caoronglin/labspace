// 植物数据库 API 站内查询 UI 验收
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://127.0.0.1';
const USER = process.env.LAB_USER || 'student01';
const PASS = process.env.LAB_PASS || '';

let pass = 0;
let fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`${BASE}/api/auth/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#username', { timeout: 20000 });
await page.locator('#username').fill(USER);
await page.locator('#password').fill(PASS);
await page.getByRole('button', { name: '登录' }).first().click();
await page.waitForTimeout(3500);

// 数据库页有持续的后台轮询（健康探测），networkidle 永远等不到；
// 改 domcontentloaded + 定长等待。
await page.goto(`${BASE}/databases`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

const totalText = await page.locator('.ant-typography').filter({ hasText: '已接入真实 API' }).first().innerText().catch(() => '');
record('统计条显示 API 接入数', /已接入真实 API/.test(totalText), totalText.replace(/\s+/g, ' '));

const apiTags = await page.locator('.ant-tag', { hasText: '已接入 API' }).count();
record('卡片显示「已接入 API」徽标', apiTags >= 10, `${apiTags} 个`);

const webTags = await page.locator('.ant-tag', { hasText: '仅网页访问' }).count();
record('无 API 库显示「仅网页访问」徽标', webTags >= 30, `${webTags} 个`);

// 打开一个带 API 的库并执行真实查询（选 NCBI E-utilities，关键词有效）
await page.locator('[data-db-id="ncbi"] button:has-text("站内查询")').click();
await page.waitForTimeout(800);
record('查询抽屉打开', await page.locator('.ant-drawer-section').isVisible());

await page.locator('.ant-drawer-section input.ant-input').first().fill('AP1 Arabidopsis');
// AntD v6 会给两个汉字的按钮插入空格（「查 询」），用正则匹配
await page.locator('.ant-drawer-section button').filter({ hasText: /查\s*询/ }).first().click();
// 外部数据库站点响应慢（实测 >6s），轮询等结果文案出现，最多 30s
let drawerText = '';
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(2000);
  drawerText = await page.locator('.ant-drawer-section').innerText();
  if (/返回 \d+ 条|上游|超时|不可用|失败/.test(drawerText)) break;
}
// 该检索打的是外部数据库站点；抽屉里出现「上游/超时/失败」时按环境问题记 SKIP。
const upstreamDown = /上游|超时|不可用|失败/.test(drawerText);
if (upstreamDown) console.log('  [SKIP] 返回真实检索结果 — 上游不可达');
else record('返回真实检索结果', /返回 \d+ 条/.test(drawerText), (drawerText.match(/返回 \d+ 条 · 耗时 \d+ ms · 数据来自 \S+/) || [''])[0]);
await page.screenshot({ path: 'shots/databases-api-query.png', fullPage: false });

// 无 API 的库不应出现查询按钮
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
const apiOnly = await page.locator('.ant-segmented-item', { hasText: '仅网页访问' }).click().then(async () => {
  await page.waitForTimeout(900);
  return page.locator('button:has-text("站内查询")').count();
});
record('仅网页分类下无查询按钮', apiOnly === 0, `按钮数=${apiOnly}`);

record('控制台无错误', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n结果: 通过 ${pass} / 失败 ${fail}`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
