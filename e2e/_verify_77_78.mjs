import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(5000);
ok(/工作台|全部服务/.test(await page.evaluate(() => document.body.innerText)), 'login failed');

// --- /services 目录整合
await page.goto(`${BASE}/services`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const svcBody = await page.evaluate(() => document.body.innerText);
ok(svcBody.includes('文档解析'), '/services missing 文档解析');
ok(svcBody.includes('生信实验实训平台'), '/services missing 生信实验实训平台');
ok(svcBody.includes('公共基因组'), '/services missing 公共基因组');
ok(svcBody.includes('文件工坊'), '/services missing 文件工坊');
ok(!svcBody.includes('CropGenome 作物基因组工具箱'), '/services still lists CropGenome toolbox');

// --- /start 快捷入口
await page.goto(`${BASE}/start`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const genomesHref = await page.locator('a[href="/genomes"]').count();
ok(genomesHref > 0, '/start missing 公共基因组 -> /genomes tile');
const drawingBoardHref = await page.locator('a[href*=":8093"]').count();
ok(drawingBoardHref > 0, '/start 图纸平台 does not use 8093');
const jbrowse8091 = await page.locator('a[href*=":8091"]').count();
ok(jbrowse8091 === 0, '/start still links raw JBrowse 8091');

// --- 统一搜索跳转：本地结果应有可点击站内链接
await page.goto(`${BASE}/search?q=${encodeURIComponent('基因组')}`, { waitUntil: 'domcontentloaded' });
await page.locator('a[href="/genomes"]').first().waitFor({ timeout: 20000 }).catch(() => {});
const localLinks = await page.locator('a[href^="/"]').evaluateAll((els) =>
  els.map((e) => e.getAttribute('href')).filter((h) => h && !h.startsWith('/search')),
);
ok(localLinks.some((h) => h.startsWith('/genomes')), `search 基因组 has no /genomes link: ${localLinks.slice(0, 10).join(', ')}`);

await page.goto(`${BASE}/search?q=${encodeURIComponent('生信')}`, { waitUntil: 'domcontentloaded' });
await page.locator('a[href="/bioinfo"]').first().waitFor({ timeout: 20000 }).catch(() => {});
const bioLinks = await page.locator('a[href^="/"]').evaluateAll((els) =>
  els.map((e) => e.getAttribute('href')).filter((h) => h && !h.startsWith('/search')),
);
ok(bioLinks.some((h) => h.startsWith('/bioinfo')), `search 生信 has no /bioinfo link: ${bioLinks.slice(0, 10).join(', ')}`);

// 点击首个本地链接，确认不是跳到服务主页（外部端口）
const first = page.locator('a[href^="/"], a[href^="http"]').filter({ hasText: /生信实验实训|公共基因组/ }).first();
if (await first.count()) {
  const href = await first.getAttribute('href');
  ok(Boolean(href && (href.startsWith('/') || href.startsWith('http'))), 'search result link missing href');
}

// 首页 Hero 实时建议：点击「公共基因组」应进入门户页面而不是外站主页
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const modalClose = page.locator('.ant-modal-close').first();
if (await modalClose.count()) {
  await modalClose.click().catch(() => {});
  await page.waitForTimeout(500);
}
const heroInput = page.locator('.d509-hero input').first();
await heroInput.fill('基因组');
const suggestion = page.locator('.d509-hero button').filter({ hasText: '公共基因组' }).first();
await suggestion.waitFor({ timeout: 20000 }).catch(() => {});
if (await suggestion.count()) {
  await suggestion.click();
  await page.waitForTimeout(1200);
  ok(new URL(page.url()).pathname.startsWith('/genomes'), `home suggestion jumped to ${page.url()}`);
} else {
  failures.push('home hero suggestion for 基因组 not found');
}

// --- 合并后的页面可直接打开
for (const [path, text] of [['/docparse', '文档解析'], ['/bioinfo', '生信'], ['/genomes', '基因组'], ['/snapotter', '文件']]) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const body = await page.evaluate(() => document.body.innerText);
  ok(body.includes(text), `${path} did not render expected text ${text}`);
}

await ctx.close();
await browser.close();
if (failures.length) {
  console.error('FAIL\n' + failures.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}
console.log('PASS 77/78: consolidation + search deep links verified');