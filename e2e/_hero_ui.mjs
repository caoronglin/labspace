// Hero 磨砂背景 UI 验证：Bing 每日图、自动取色变量、移动端布局。脚本不打印任何凭据。
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
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill('labadmin');
await page.locator('input[type="password"]').first().fill(password);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(2500);

const bgResp = page.waitForResponse((r) => r.url().includes('/api/background/daily'), { timeout: 30000 }).catch(() => null);
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
const resp = await bgResp;
ok('背景图接口返回 200 且为图片', Boolean(resp && resp.status() === 200 && /image\//.test(resp.headers()['content-type'] || '')), resp ? `${resp.status()} ${resp.headers()['content-type']}` : 'no response');

const hero = page.locator('.d509-hero').first();
await hero.waitFor({ timeout: 15000 });
await page.waitForFunction(() => {
  const el = document.querySelector('.d509-hero');
  return el && (el.getAttribute('style') || '').includes('--hero-accent');
}, { timeout: 15000 }).catch(() => null);

const info = await hero.evaluate((el) => {
  const bg = el.querySelector('.d509-hero-bg');
  const side = el.querySelector('.d509-hero-side');
  const cs = getComputedStyle(el);
  const sideCs = side ? getComputedStyle(side) : null;
  return {
    bgImage: bg ? getComputedStyle(bg).backgroundImage : '',
    accent: el.style.getPropertyValue('--hero-accent') || cs.getPropertyValue('--hero-accent'),
    scrim: el.style.getPropertyValue('--hero-scrim') || cs.getPropertyValue('--hero-scrim'),
    sideBlur: sideCs ? sideCs.backdropFilter || sideCs.webkitBackdropFilter : '',
    sideBg: sideCs ? sideCs.backgroundColor : '',
  };
});
ok('背景图层挂上每日图', info.bgImage.includes('/api/background/daily'), info.bgImage);
ok('自动取色写入强调色', Boolean(info.accent && info.accent.trim()), info.accent);
ok('自适应压暗层参数已生成', Number(info.scrim) > 0.2 && Number(info.scrim) < 0.9, info.scrim);
ok('右侧面板为磨砂玻璃', /blur/.test(info.sideBlur) && /rgba/.test(info.sideBg), `${info.sideBlur} ${info.sideBg}`);

// 左上公告：位于 D509 标签上方，且与标题、搜索框、右侧面板对齐
const align = await page.evaluate(() => {
  const rect = (el) => (el ? el.getBoundingClientRect() : null);
  const hero = document.querySelector('.d509-hero');
  const ann = document.querySelector('.d509-hero-ann');
  const tag = hero?.querySelector('.ant-tag');
  const title = document.querySelector('.d509-title');
  const search = hero?.querySelector('.ant-input-search');
  const side = document.querySelector('.d509-hero-side');
  return {
    ann: rect(ann),
    tag: rect(tag),
    title: rect(title),
    search: rect(search),
    side: rect(side),
  };
});
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
ok('公告位于 D509 标签上方', align.ann && align.tag && align.ann.bottom <= align.tag.top + 1,
  align.ann && align.tag ? `ann.bottom=${align.ann.bottom.toFixed(1)} tag.top=${align.tag.top.toFixed(1)}` : 'missing');
ok(
  '公告与标签/标题/搜索框左边对齐',
  align.ann && align.tag && align.title && align.search &&
    near(align.ann.left, align.tag.left) &&
    near(align.ann.left, align.title.left) &&
    near(align.ann.left, align.search.left),
  align.ann ? `ann=${align.ann.left.toFixed(1)} tag=${align.tag?.left.toFixed(1)} title=${align.title?.left.toFixed(1)} search=${align.search?.left.toFixed(1)}` : 'missing',
);
ok('公告与搜索框等宽', align.ann && align.search && near(align.ann.width, align.search.width, 2),
  align.ann && align.search ? `${align.ann.width.toFixed(1)} vs ${align.search.width.toFixed(1)}` : 'missing');
ok('左栏内容与右侧面板顶部对齐', align.ann && align.side && near(align.ann.top, align.side.top, 2),
  align.ann && align.side ? `ann.top=${align.ann.top.toFixed(1)} side.top=${align.side.top.toFixed(1)}` : 'missing');

await page.screenshot({ path: 'shots/hero-frosted-desktop.png', fullPage: false });

// 移动端：Hero 上下堆叠、侧栏不溢出（复用同一登录态）
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
const m = await page.evaluate(() => {
  const hero = document.querySelector('.d509-hero');
  const side = document.querySelector('.d509-hero-side');
  const cols = hero ? Array.from(hero.querySelectorAll('.ant-row > .ant-col')) : [];
  return {
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    heroW: hero ? hero.getBoundingClientRect().width : 0,
    sideW: side ? side.getBoundingClientRect().width : 0,
    stacked: cols.length >= 2 ? cols[1].getBoundingClientRect().top >= cols[0].getBoundingClientRect().bottom - 8 : false,
  };
});
ok('移动端无横向溢出', m.scrollW <= m.innerW + 1, `scroll=${m.scrollW} viewport=${m.innerW}`);
ok('移动端 Hero 两列上下堆叠', m.heroW > 300 && m.sideW > 300 && m.stacked, JSON.stringify(m));
await page.screenshot({ path: 'shots/hero-frosted-mobile.png', fullPage: false });

await browser.close();
console.log(`\n通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) console.log('失败项：' + fails.join('、'));
process.exit(fails.length ? 1 : 0);
