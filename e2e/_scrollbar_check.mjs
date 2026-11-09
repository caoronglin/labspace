// 临时探针：滚动条细样式与明暗主题变量
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(process.env.U);
await page.locator('input[type="password"]').first().fill(process.env.P);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(4000);
await page.goto(`${BASE}/knowledge`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

const read = () => page.evaluate(() => {
  const html = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const thumb = html.getPropertyValue('--d509-scroll-thumb').trim();
  const scrollables = [...document.querySelectorAll('*')].filter((el) => el.scrollHeight > el.clientHeight + 4).length;
  const el = [...document.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 4);
  const sides = [...document.querySelectorAll('.ant-layout-sider')].map((el) => {
    const r = el.getBoundingClientRect();
    return { cls: String(el.className).slice(0, 70), bg: getComputedStyle(el).backgroundColor, x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const sider = document.querySelector('.ant-layout-sider');
  const menu = document.querySelector('.ant-menu');
  const header = document.querySelector('.ant-layout-header');
  return {
    scrollbarWidth: html.scrollbarWidth || body.scrollbarWidth,
    thumb,
    scrollables,
    sample: el ? `${el.tagName}.${String(el.className).slice(0, 60)}` : '',
    sampleWidth: el ? getComputedStyle(el).scrollbarWidth : '',
    sides,
    menuClass: menu?.className?.slice(0, 80),
    menuBg: menu ? getComputedStyle(menu).backgroundColor : '',
    headerBg: header ? getComputedStyle(header).backgroundColor : '',
    at20: (() => { const e=document.elementFromPoint(20,300); return e?`${e.tagName}.${String(e.className).slice(0,50)} bg=${getComputedStyle(e).backgroundColor}`:'none'; })(),
    at40: (() => { const e=document.elementFromPoint(40,300); return e?`${e.tagName}.${String(e.className).slice(0,50)} bg=${getComputedStyle(e).backgroundColor}`:'none'; })(),
    seg: (() => { const e=document.querySelector('.ant-segmented-item-selected'); return e?`bg=${getComputedStyle(e).backgroundColor} color=${getComputedStyle(e).color}`:'none'; })(),
  };
});

const light = await read();
await page.evaluate(() => localStorage.setItem('labspace.theme', 'dark'));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
const dark = await read();
await page.screenshot({ path: new URL('./shots/_theme_dark2.png', import.meta.url).pathname });
await page.evaluate(() => localStorage.setItem('labspace.theme', 'light'));
console.log('light:', JSON.stringify(light));
console.log('dark:', JSON.stringify(dark));
console.log('errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
