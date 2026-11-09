import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);
const failures = [];
const ok = (c, m) => { if (!c) failures.push(m); };

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();

const closeModal = async () => {
  const btn = page.locator('.ant-modal-close').first();
  if (await btn.count()) if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
  await page.waitForSelector('.ant-modal-wrap', { state: 'hidden', timeout: 3000 }).catch(() => {});
};

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(5000);

const openMenuFor = async (name) => {
  await page.goto(`${BASE}/files?source=genomes`, { waitUntil: 'domcontentloaded' });
  await closeModal();
  const row = page.locator('.ant-table-row', { hasText: name }).first();
  await row.waitFor({ timeout: 15000 });
  await row.locator('button[aria-label="更多操作"]').click();
  await page.waitForSelector('.ant-dropdown-menu', { timeout: 5000 });
  return page.locator('.ant-dropdown-menu');
};

// 1) JBrowse jump
let menu = await openMenuFor('all_sites.fa');
await menu.getByText('在 JBrowse 中浏览', { exact: true }).click();
await page.waitForURL(/\/genomes\?.*action=jbrowse/, { timeout: 10000 });
await page.waitForTimeout(2500);
const banner = await page.locator('.ant-tag', { hasText: '来自文件管理' }).count();
ok(banner > 0, 'missing linked-genome banner');
const locTag = await page.locator('.ant-tag', { hasText: /^定位 / }).count();
ok(locTag > 0, 'JBrowse loc tag not set from FASTA header');
const iframeSrc = await page.locator('iframe').first().getAttribute('src').catch(() => null);
ok(Boolean(iframeSrc && iframeSrc.includes('/jbrowse/index.html?loc=')), `jbrowse iframe not at loc: ${iframeSrc}`);
ok(Boolean(iframeSrc && iframeSrc.includes('Zm00001eb031700')), `jbrowse loc missing record name: ${iframeSrc}`);
console.log('jbrowse src =', iframeSrc);

// 2) Analyze jump
menu = await openMenuFor('all_sites.fa');
await menu.getByText('rust-bio 序列分析', { exact: true }).click();
await page.waitForURL(/\/genomes\?.*action=analyze/, { timeout: 10000 });
await page.waitForTimeout(4000);
const analyzingText = await page.getByText(/all_sites\.fa/).count();
ok(analyzingText > 0, 'analyze view does not reference selected file');
const hasGc = await page.getByText(/GC|ORF/).count();
ok(hasGc > 0, 'analysis result panel not rendered');
const banner2 = await page.locator('.ant-tag', { hasText: '来自文件管理' }).count();
ok(banner2 > 0, 'missing linked banner in analyze view');

await browser.close();
if (failures.length) {
  console.error('FAIL:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('PASS #115 genome link');