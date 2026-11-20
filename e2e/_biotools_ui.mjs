import { chromium } from 'playwright';

/** 生信工具页 + 导航重构 + CropGenome 下架 的浏览器级验收。 */
const BASE = 'http://198.51.100.71';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: 'zh-CN' });
await ctx.addCookies([{ name: 'labspace_session', value: process.env.TOK, domain: '198.51.100.71', path: '/' }]);
const page = await ctx.newPage();
const problems = [];
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('/api/') && r.status() >= 400) problems.push(`${r.status()} ${u.replace(BASE, '')}`);
});
page.on('pageerror', (e) => problems.push(`JS ${e}`));

const closeTour = async () => {
  for (let i = 0; i < 4; i += 1) {
    const c = page.locator('.ant-tour-close, .ant-modal-close').first();
    if (await c.count()) {
      await c.click({ force: true }).catch(() => {});
      await page.waitForTimeout(250);
    }
  }
};

// 1) /bio-tools 页面 + 跑一个工具
await page.goto(`${BASE}/bio-tools`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await closeTour();
const groups = (await page.locator('.ant-segmented-item-label').allInnerTexts()).filter(Boolean);
await page.locator('textarea').first().fill('ATGGCTAGCTAGCTAGCTAA');
await page.getByRole('button', { name: /运\s*行/ }).click();
await page.waitForTimeout(2500);
const body = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
const sawGc = /gc|GC/.test(body) && /反向互补|reverse/i.test(body);
await page.screenshot({ path: '/tmp/biotools.png' });
console.log('bio-tools groups:', JSON.stringify(groups));
console.log('bio-tools 结果出现:', sawGc);

// 2) 旧入口重定向
for (const [path, expect] of [['/tools', '/drawio'], ['/tools?tool=plot', '/plot'], ['/drawings', '/drawio']]) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const url = new URL(page.url());
  console.log(`${path} -> ${url.pathname}${url.search} (期望 ${expect})`);
}

// 3) /genomes 只剩浏览，且有「生信工具」按钮
await page.goto(`${BASE}/genomes`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const genomesText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
console.log('genomes 有生信工具入口:', /生信工具/.test(genomesText), '| 有 rust-bio 字样:', /rust-bio/i.test(genomesText));
await page.screenshot({ path: '/tmp/genomes.png' });

// 4) CropGenome 已下架：旧 API 落到 SPA（HTML）
const cg = await page.request.get(`${BASE}/cropgenome/api/v1/species`);
console.log('cropgenome api status:', cg.status(), 'content-type:', (cg.headers()['content-type'] || '').slice(0, 24));

// 5) 侧栏含新入口
await page.goto(`${BASE}/start`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await closeTour();
const nav = await page.evaluate(() => document.body.innerText);
console.log('侧栏/页面含「生信工具」:', /生信工具/.test(nav), '| 含「文件空间」:', /文件空间/.test(nav), '| 仍含「文件存储」:', /文件存储/.test(nav));

console.log('problems:', JSON.stringify(problems));
await ctx.close();
await browser.close();
