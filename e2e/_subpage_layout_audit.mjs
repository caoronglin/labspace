// 服务子页面布局审计：横向溢出、控制台错误、可见卡片数、超宽元素
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const usersFile = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8');
const line = usersFile.split('\n').find((l) => l.startsWith((process.env.LAB_USER || 'labadmin@local') + ' '));
if (!line) throw new Error('测试账号未在 casdoor-users.txt 中找到');
const [user, pass] = line.trim().split(/\s+/);
mkdirSync('/opt/labspace/e2e/shots/subpages', { recursive: true });

const ROUTES = [
  '/devtools', '/translate', '/bioinfo', '/literature', '/databases',
  '/network', '/colors', '/aikit', '/commands', '/snapotter', '/knowledge', '/files',
  '/genomes', '/agent', '/workbench', '/services', '/weather', '/translation', '/help',
];

const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function login(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(3500);
  await page.close();
  return ctx.storageState();
}

const state = await login(await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' }));

async function scan(width, height, routes, shots) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', storageState: state });
  const page = await ctx.newPage();
  let errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 180)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 180)));
  for (const route of routes) {
    errors = [];
    try {
      await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2200);
      for (let i = 0; i < 2; i += 1) {
        if (!(await page.locator('.ant-modal-wrap').count())) break;
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
        await page.locator('.ant-modal-close').first().click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(250);
      }
      const info = await page.evaluate(() => {
        const de = document.documentElement;
        const vw = de.clientWidth;
        const wide = [...document.querySelectorAll('body *')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > vw + 4 && r.height > 10 && getComputedStyle(el).position !== 'fixed';
          })
          .slice(0, 4)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').filter(Boolean).slice(0, 2).join('.')} w=${Math.round(el.getBoundingClientRect().width)}`);
        return {
          doc: de.scrollWidth - vw,
          body: document.body.scrollWidth - vw,
          cards: [...document.querySelectorAll('.ant-card')].filter((el) => el.offsetParent !== null).length,
          h1: (document.querySelector('h1')?.textContent || '').trim().slice(0, 24),
          wide,
        };
      });
      console.log(`LAYOUT ${width} ${route} ${JSON.stringify({ ...info, errors: errors.slice(0, 2) })}`);
      if (shots) await page.screenshot({ path: `/opt/labspace/e2e/shots/subpages/${width}${route.replace(/\W/g, '_') || '_home'}.png` });
    } catch (e) {
      console.log(`LAYOUT ${width} ${route} FAIL ${String(e).slice(0, 140)}`);
    }
  }
  await ctx.close();
}

await scan(1440, 900, ROUTES, true);
await scan(390, 844, ['/devtools', '/translate', '/bioinfo', '/literature', '/databases', '/knowledge', '/files', '/genomes', '/agent', '/workbench', '/services', '/help'], true);
await browser.close();