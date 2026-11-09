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

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(5000);

await page.goto(`${BASE}/files?source=genomes`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const startBtn = page.getByRole('button', { name: '开始使用' });
if (await startBtn.count()) await startBtn.click().catch(() => {});
const close = page.locator('.ant-modal-close').first();
if (await close.count()) if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
await page.waitForSelector('.ant-modal-wrap', { state: 'hidden', timeout: 5000 }).catch(() => {});
await page.locator('.ant-table-row').first().waitFor({ timeout: 15000 });

const seg = page.locator('.ant-segmented').filter({ has: page.locator('[title="网格视图"]') }).first();
ok(await seg.count() > 0, 'view switcher missing');
for (const t of ['列表视图', '网格视图', '详情视图', '时间线视图']) {
  ok(await page.locator(`[title="${t}"]`).count() > 0, `view option missing: ${t}`);
}

// grid
await page.locator('[title="网格视图"]').click();
await page.waitForTimeout(800);
const gridCards = await page.locator('.ant-card-hoverable').count();
ok(gridCards > 0, 'grid view has no cards');
ok(await page.locator('.ant-table').count() === 0, 'table still visible in grid view');

// select a card checkbox
const cb = page.locator('.ant-card-hoverable input[type="checkbox"]').first();
ok(await cb.count() > 0, 'grid cards missing selection checkbox');
await cb.check();
await page.waitForTimeout(500);
ok(await page.getByText(/已选 1 项/).count() > 0, 'grid selection bar not shown');
await page.getByText('取消选择', { exact: true }).click();

// details
await page.locator('[title="详情视图"]').click();
await page.waitForTimeout(800);
ok(await page.getByText('修改时间', { exact: true }).count() > 0, 'details view missing modified column');
ok(await page.getByText('创建时间', { exact: true }).count() > 0, 'details view missing created column');
ok(await page.locator('.ant-table').count() === 0, 'table still visible in details view');

// timeline
await page.locator('[title="时间线视图"]').click();
await page.waitForTimeout(800);
const dayTags = await page.locator('.ant-tag', { hasText: /^\d{4}-\d{2}-\d{2}$/ }).count();
ok(dayTags > 0, 'timeline has no date groups');

// back to list
await page.locator('[title="列表视图"]').click();
await page.waitForTimeout(800);
ok(await page.locator('.ant-table').count() > 0, 'list view table missing');

await browser.close();
if (failures.length) {
  console.error('FAIL:\n - ' + failures.join('\n - '));
  process.exit(1);
}
console.log('PASS #117 multi-view file manager');