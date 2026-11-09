// 帮助中心 + 首次激活/版本更新弹窗验收
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const usersFile = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8');
const line = usersFile.split('\n').find((l) => l.startsWith((process.env.LAB_USER || 'labadmin@local') + ' '));
if (!line) throw new Error('测试账号未找到');
const [user, pass] = line.trim().split(/\s+/);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 960 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

const text = async () => (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(5000);
  console.log('LOGIN_URL', page.url());

  // 首次登录弹窗（新 context 的 localStorage 是空的）
  await page.waitForTimeout(1800);
  let body = await text();
  const onboard = body.includes('欢迎使用 D509 工作台') && body.includes('开始使用');
  console.log('ONBOARD_MODAL', onboard);
  if (onboard) {
    await page.screenshot({ path: '/opt/labspace/e2e/shots/help-onboard-modal.png' });
    await page.getByRole('button', { name: '开始使用' }).click();
  }
  await page.waitForTimeout(600);

  await page.goto(`${BASE}/help`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  body = await text();
  const checks = {
    title: body.includes('帮助中心'),
    quick: body.includes('快速上手'),
    map: body.includes('服务地图'),
    faq: body.includes('常见问题'),
    releases: body.includes('更新日志'),
    version: body.includes('2026.11.07'),
    modalGone: !body.includes('欢迎使用 D509 工作台'),
  };
  console.log('HELP_SECTIONS', JSON.stringify(checks));

  // FAQ 展开
  await page.getByText('为什么有些文件或服务看不到？', { exact: false }).first().click();
  await page.waitForTimeout(400);
  console.log('FAQ_EXPANDED', (await text()).includes('按用户组'));

  await page.screenshot({ path: '/opt/labspace/e2e/shots/help-page.png', fullPage: true });

  // 模拟版本更新：把已读版本改旧
  await page.evaluate(() => localStorage.setItem('d509:help:release-seen', '2026.01.01'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  body = await text();
  const updateModal = body.includes('功能更新 · 公共基因组与帮助中心') && body.includes('知道了');
  console.log('UPDATE_MODAL', updateModal);
  if (updateModal) {
    await page.screenshot({ path: '/opt/labspace/e2e/shots/help-update-modal.png' });
    await page.getByRole('button', { name: '知道了' }).click();
  }
  await page.waitForTimeout(400);
  console.log('UPDATE_MODAL_CLOSED', !(await text()).includes('功能更新 ·'));

  // 再次刷新不应重复弹
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  console.log('NO_REPEAT_MODAL', !(await text()).includes('功能更新 ·'));

  // 顶栏帮助入口
  const helpBtn = await page.locator('button:has(.anticon-question-circle)').count();
  console.log('HEADER_HELP_BUTTON', helpBtn);
  await page.screenshot({ path: '/opt/labspace/e2e/shots/help-after.png', fullPage: false });
  console.log('CONSOLE_ERRORS', errors.length ? errors.slice(0, 5).join(' | ') : 'none');
} finally {
  await ctx.close();
  await browser.close();
}