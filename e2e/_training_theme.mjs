// 验证实训平台内嵌时是否承袭门户主题（明/暗 + 品牌主色）
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const usersFile = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8');
const line = usersFile.split('\n').find((l) => l.startsWith('labadmin@local '));
if (!line) throw new Error('测试账号未找到');
const [user, pass] = line.trim().split(/\s+/);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3000);

async function inspect(mode, primary, shot) {
  await page.evaluate(([m, p]) => {
    localStorage.setItem('labspace.theme', m);
    localStorage.setItem('labspace.primary', p);
  }, [mode, primary]);
  await page.goto(`${BASE}/bioinfo`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const frame = page.frames().find((f) => f.url().includes(':8102'));
  const info = frame
    ? await frame.evaluate(() => {
        const de = document.documentElement;
        const header = document.querySelector('.ant-layout-header');
        const sider = document.querySelector('.ant-layout-sider');
        const brand = document.querySelector('.ant-layout-sider .ant-typography');
        return {
          url: location.href,
          theme: de.getAttribute('data-theme'),
          bg: getComputedStyle(document.body).backgroundColor,
          headerBg: header ? getComputedStyle(header).backgroundColor : null,
          siderBg: sider ? getComputedStyle(sider).backgroundColor : null,
          brandText: brand?.textContent?.trim() ?? null,
          primaryVar: getComputedStyle(document.querySelector('.ant-btn-primary') || de).backgroundColor,
        };
      })
    : { error: 'iframe not found', frames: page.frames().map((f) => f.url()) };
  await page.screenshot({ path: `/opt/labspace/e2e/shots/${shot}`, fullPage: false });
  console.log(mode, JSON.stringify(info));
}

await inspect('dark', '#D4380D', 'training_dark.png');
await inspect('light', '#2B5CE6', 'training_light.png');
await browser.close();