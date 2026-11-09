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

const idx = await page.request.get(`${BASE}/api/commands?q=&limit=2000`);
ok(idx.ok(), `/api/commands status ${idx.status()}`);
const body = await idx.json();
ok(body.total === 627, `expected 627 commands, got ${body.total}`);
for (const name of ['fastp', 'snakemake', 'minibwa', 'bismark', 'scanpy', 'bowtie2']) {
  ok(body.items.some((it) => it.name === name), `index missing ${name}`);
  const d = await page.request.get(`${BASE}/api/commands/${name}`);
  ok(d.ok(), `${name} detail status ${d.status()}`);
  if (d.ok()) {
    const det = await d.json();
    ok(det.markdown.includes('语法'), `${name} markdown missing 语法`);
    ok(det.markdown.length > 500, `${name} markdown too short (${det.markdown.length})`);
  }
}

const q = await page.request.get(`${BASE}/api/commands?q=fastp&limit=50`);
const qb = await q.json();
ok(qb.matched >= 1 && qb.items[0].name === 'fastp', `search fastp returned ${JSON.stringify(qb.items.slice(0, 3))}`);

await page.goto(`${BASE}/commands`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const modalClose = page.locator('.ant-modal-close').first();
if (await modalClose.count()) {
  await modalClose.click().catch(() => {});
  await page.waitForTimeout(600);
}
const input = page.locator('input[placeholder*="命令名"]').first();
await input.fill('fastp');
await page.waitForTimeout(1500);
const item = page.getByText('fastp', { exact: true }).first();
await item.waitFor({ timeout: 15000 }).catch(() => {});
ok(await item.count() > 0, 'UI list missing fastp');
await item.click();
await page.waitForTimeout(1500);
const bodyText = await page.evaluate(() => document.body.innerText);
ok(bodyText.includes('FASTQ') && bodyText.includes('语法'), 'UI detail did not render fastp doc');
ok(bodyText.includes('627'), 'UI total not updated to 627');

await ctx.close();
await browser.close();
if (failures.length) {
  console.error('FAIL\n' + failures.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}
console.log('PASS #96: 627 commands, 6 new docs served and rendered');