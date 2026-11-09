import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
let failures = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failures += 1;
}

const line = fs
  .readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('labadmin@local'));
const password = line.trim().split(/\s+/)[1];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => {
  if (r.url().includes('/api/latex') && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
});

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill('labadmin');
await page.locator('input[type="password"]').first().fill(password);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(4000);

async function dismissWelcome() {
  const welcome = page.locator('.ant-modal').filter({ hasText: '欢迎使用 D509 工作台' }).first();
  if (await welcome.isVisible().catch(() => false)) {
    await welcome.getByRole('button', { name: /开始使用/ }).click();
    await page.waitForTimeout(600);
  }
}
await dismissWelcome();

await page.goto(`${BASE}/latex`, { waitUntil: 'domcontentloaded' });
await dismissWelcome();
await page.getByRole('button', { name: '新建文稿' }).first().waitFor({ timeout: 20000 });
ok('页面打开', true, page.url());
ok('导航标题', /LaTeX 写作/.test(await page.locator('body').innerText()));
await page.screenshot({ path: 'shots/latex-home.png', fullPage: true });

const title = `E2E 测试文稿 ${Date.now().toString().slice(-6)}`;
await page.getByRole('button', { name: '新建文稿' }).first().click();
const modal = page.locator('.ant-modal').filter({ hasText: '新建 LaTeX 文稿' }).first();
await modal.waitFor({ state: 'visible', timeout: 10000 });
ok('模板列表', (await modal.locator('.ant-card').count()) >= 4);
await modal.locator('input[placeholder*="水稻耐旱"]').fill(title);
await modal.getByRole('button', { name: /创\s*建/ }).click();
await page.waitForTimeout(2500);
ok('创建后进入编辑器', (await page.locator('textarea[aria-label="LaTeX 源码"]').count()) === 1);
ok('标题回显', (await page.locator('input[aria-label="文稿标题"]').inputValue()) === title);

await page.waitForTimeout(2500);
await page.getByRole('button', { name: '编译 PDF' }).first().click();
const compileOk = await page
  .waitForSelector('.ant-message-success:has-text("编译成功")', { timeout: 120000 })
  .then(() => true)
  .catch(() => false);
ok('编译成功提示', compileOk);
const pdfTab = page.getByRole('tab', { name: /PDF 预览/ });
await pdfTab.click();
await page.waitForTimeout(2000);
const iframe = page.locator('iframe[title="LaTeX PDF 预览"]');
ok('PDF 预览 iframe', (await iframe.count()) === 1);
if (await iframe.count()) {
  const src = await iframe.getAttribute('src');
  const resp = await page.request.get(`${BASE}${src}`);
  ok('PDF 接口可下载', resp.ok(), `${resp.status()} ${(await resp.body()).length}B`);
}
await page.screenshot({ path: 'shots/latex-pdf.png', fullPage: true });

ok('无前端异常', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);