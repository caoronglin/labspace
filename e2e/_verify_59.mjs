// #59 移动端巡检：390x844 下登录并检查横向溢出，输出截图
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const shots = '/opt/labspace/e2e/shots/mobile';
fs.mkdirSync(shots, { recursive: true });
const line = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(5000);
await page.locator('.ant-modal-close').first().click({ timeout: 2000 }).catch(() => {});

const routes = ['/', '/services', '/files', '/knowledge', '/workbench', '/aikit', '/admin/users', '/help'];
const issues = [];
for (const r of routes) {
  await page.goto(`${BASE}${r}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  await page.locator('.ant-modal-close').first().click({ timeout: 800 }).catch(() => {});
  const res = await page.evaluate(() => {
    const vw = window.innerWidth;
    const sw = document.scrollingElement.scrollWidth;
    const bad = [];
    if (sw > vw + 1) {
      for (const el of document.querySelectorAll('body *')) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > vw + 2) {
          const cls = typeof el.className === 'string' ? el.className.split(' ').slice(0, 2).join('.') : '';
          bad.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} right=${Math.round(rect.right)}`);
        }
      }
    }
    return { vw, sw, bad: [...new Set(bad)].slice(0, 5) };
  });
  const name = r === '/' ? 'home' : r.replace(/\//g, '_').replace(/^_/, '');
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
  if (res.sw > res.vw + 1) issues.push(`${r} scrollWidth=${res.sw} > ${res.vw} :: ${res.bad.join(' , ')}`);
  // 顶栏按钮是否被挤出
  const header = await page.evaluate(() => {
    const h = document.querySelector('.ant-layout-header');
    return h ? { sw: h.scrollWidth, cw: h.clientWidth } : null;
  });
  if (header && header.sw > header.cw + 1) issues.push(`${r} header overflow ${header.sw}>${header.cw}`);
}

// 移动端头像菜单收纳了命令面板/起始页/主题切换
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.locator('.ant-layout-header .ant-avatar').first().click();
await page.waitForTimeout(500);
const menuText = await page.evaluate(() => document.body.innerText);
for (const label of ['命令面板', '起始页', '切换深色主题', '帮助中心', '退出登录']) {
  if (!menuText.includes(label)) issues.push(`avatar menu missing: ${label}`);
}
await page.getByText('起始页', { exact: true }).last().click();
await page.waitForTimeout(1200);
if (!page.url().endsWith('/start')) issues.push(`start menu item did not navigate: ${page.url()}`);

await browser.close();
if (issues.length) {
  console.log('ISSUES 59:\n' + issues.join('\n'));
  process.exit(1);
}
console.log('PASS 59: no horizontal overflow on mobile routes');