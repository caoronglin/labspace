// 权限组（老师/博士/研究生/本科生/实习生）页面检查 + 新建/删除冒烟。脚本不打印任何凭据。
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
let pass = 0;
const fails = [];
const ok = (name, cond, info = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}${info ? ' :: ' + info : ''}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${info ? ' :: ' + String(info).slice(0, 220) : ''}`);
  }
};

const creds = fs
  .readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('labadmin@local'));
const password = creds.trim().split(/\s+/)[1];

const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1050 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill('labadmin');
await page.locator('input[type="password"]').first().fill(password);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(2200);

await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const card = page.locator('.ant-card', { hasText: '权限组（预配置）' }).first();
ok('权限组卡片渲染', (await card.count()) === 1);

const body = await page.locator('body').innerText();
for (const [label, code] of [
  ['老师', 'lab-teacher'],
  ['博士', 'lab-phd'],
  ['研究生', 'lab-master'],
  ['本科生', 'lab-undergrad'],
  ['实习生', 'lab-intern'],
]) {
  const row = page.locator('.ant-table-row', { hasText: code }).first();
  ok(`${label}（${code}）出现在列表中`, (await row.count()) === 1);
  if (await row.count()) {
    const t = await row.innerText();
    ok(`${label} 行显示预设授权`, t.includes('公共') || t.includes('课件') || t.includes('共享') || t.includes('质粒'), t.replace(/\s+/g, ' ').slice(0, 160));
  }
}
ok('不再提示缺少推荐角色组', !body.includes('推荐角色组尚未全部建立'));

// 新建一个临时权限组，确认可创建后再删除。
await card.getByRole('button', { name: /新建权限组/ }).click();
const createModal = page.locator('.ant-modal', { hasText: '新建权限组' }).first();
await createModal.waitFor({ timeout: 8000 });
await createModal.locator('input#name').fill('e2e-temp');
await createModal.locator('input#displayName').fill('冒烟测试组');
await createModal.getByRole('button', { name: /创\s*建/ }).click();
await page.waitForTimeout(1800);
ok('临时权限组创建成功', (await page.locator('.ant-table-row', { hasText: 'e2e-temp' }).count()) === 1);

const tempRow = page.locator('.ant-table-row', { hasText: 'e2e-temp' }).first();
await tempRow.getByRole('button', { name: /删\s*除/ }).click();
const delModal = page.locator('.ant-modal', { hasText: '删除权限组' }).first();
await delModal.waitFor({ timeout: 8000 });
await delModal.getByRole('button', { name: /删\s*除/ }).click();
await page.waitForTimeout(1800);
ok('临时权限组已删除', (await page.locator('.ant-table-row', { hasText: 'e2e-temp' }).count()) === 0);

await page.screenshot({ path: 'shots/perm-groups.png', fullPage: true });

console.log(`\n${pass} passed, ${fails.length} failed`);
await browser.close();
process.exit(fails.length ? 1 : 0);