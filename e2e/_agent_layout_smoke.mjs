import { chromium } from 'playwright';
import fs from 'node:fs';

const CRED = {};
for (const line of fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const [email, pass] = t.split(/\s+/);
  if (email && pass) CRED[email.split('@')[0]] = pass;
}

let failed = 0;
const must = (c, l, e = '') => {
  console.log(`${c ? 'ok  ' : 'FAIL'} ${l}${e ? ' — ' + e : ''}`);
  if (!c) failed++;
};

const b = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await b.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('http://192.0.2.10/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill('labadmin');
await page.locator('#password').fill(CRED.labadmin);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3500);
await page.goto('http://192.0.2.10/agent', { waitUntil: 'domcontentloaded' });

const dismissOverlays = async () => {
  for (let i = 0; i < 3; i++) {
    const modal = page.locator('.ant-modal-wrap:visible').first();
    if (!(await modal.count())) return;
    const btn = modal.getByRole('button', { name: /知道了|开始使用|我知道了|关闭|稍后|确定/ }).last();
    if (await btn.count()) await btn.click().catch(() => {});
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
};
await page.waitForTimeout(4000);
await dismissOverlays();
await page.evaluate(() => {
  localStorage.setItem('d509:help:release-seen', 'v2026.11.07.1');
});

const toolbar = page.getByTestId('agent-toolbar');
await toolbar.waitFor({ timeout: 30000 });
await page.waitForTimeout(1200);

const box = await toolbar.boundingBox();
must(!!box && box.width > 900, '工具条通栏（原左栏已上移）', `width=${box?.width ?? 0}`);
must(await toolbar.locator('.ant-select').count() >= 1, '工具条含会话选择器');
must((await toolbar.getByRole('button', { name: /新建会话/ }).count()) === 1, '工具条含新建会话');
must((await toolbar.getByRole('button', { name: /可用技能/ }).count()) === 1, '工具条含可用技能');
must((await page.getByText('从左侧选择').count()) === 0, '不再提示“从左侧选择”');

// 首张卡片应为工具条：直接位于 PageShell 内容顶部
const firstCardIsToolbar = await page.evaluate(() => {
  const card = document.querySelector('.ant-card');
  return card?.getAttribute('data-testid') === 'agent-toolbar';
});
must(firstCardIsToolbar, '页面首个卡片即顶部工具条');

// 技能下拉可展开
await toolbar.getByRole('button', { name: /可用技能/ }).click();
await page.waitForTimeout(600);
const menu = page.locator('.ant-dropdown').first();
must(await menu.isVisible(), '技能下拉可展开');
const skillItems = await menu.locator('.ant-dropdown-menu-item').count();
must(skillItems >= 1, '技能下拉有内容', String(skillItems));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// 新建会话 → 输入框可用 → 删除该会话
await toolbar.getByRole('button', { name: /新建会话/ }).click();
await page.waitForTimeout(2000);
const input = page.getByPlaceholder(/输入你的问题/);
must(await input.isVisible(), '新建会话后输入框可用');
must((await toolbar.getByLabel('删除当前会话').count()) === 1, '选中会话后出现删除按钮');

await toolbar.getByLabel('删除当前会话').click();
await page.getByRole('button', { name: /^删\s*除$/ }).last().click();
await page.waitForTimeout(1500);

await page.screenshot({ path: '/opt/labspace/e2e/_agent_toolbar.png', fullPage: false });
await b.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASS');
process.exit(failed ? 1 : 0);