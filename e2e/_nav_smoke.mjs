import { chromium } from 'playwright';
import fs from 'node:fs';
const CRED = {};
for (const line of fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const [email, pass] = t.split(/\s+/); if (email && pass) CRED[email.split('@')[0]] = pass;
}
let failed = 0;
const must = (c, l, e = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${l}${e ? ' — ' + e : ''}`); if (!c) failed++; };
const b = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://192.0.2.10/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill('labadmin');
await page.locator('#password').fill(CRED.labadmin);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3500);

const sider = page.locator('.ant-layout-sider').first();
must((await sider.getByText('文件共享', { exact: true }).count()) === 1, '侧栏含「文件共享」');
must((await sider.getByText('知识库', { exact: true }).count()) === 0, '侧栏不再单列「知识库」');
must((await sider.getByText('Agent 与知识库', { exact: true }).count()) === 1, '侧栏含「Agent 与知识库」');

await page.goto('http://192.0.2.10/admin/users', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const selected = await page.locator('.ant-menu-item-selected').first().innerText().catch(() => '');
must(selected.includes('用户和权限'), '/admin/users 高亮「用户和权限」', selected.trim());

await page.goto('http://192.0.2.10/files', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const selected2 = await page.locator('.ant-menu-item-selected').first().innerText().catch(() => '');
must(selected2.includes('文件共享'), '/files 高亮「文件共享」', selected2.trim());

await page.goto('http://192.0.2.10/knowledge', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const selected3 = await page.locator('.ant-menu-item-selected').first().innerText().catch(() => '');
must(selected3.includes('Agent'), '/knowledge 归并高亮 Agent', selected3.trim());

await b.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);
