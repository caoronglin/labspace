// 验证 #71 配色搭配页面 与 #72 侧栏分隔线 / Hero 公告与天气图标。
// 脚本不打印任何凭据。
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
    console.log(`FAIL  ${name}${info ? ' :: ' + String(info).slice(0, 240) : ''}`);
  }
};

fs.mkdirSync('shots', { recursive: true });
const creds = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const password = creds.trim().split(/\s+/)[1];
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill('labadmin');
await page.locator('input[type="password"]').first().fill(password);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3500);

// ----------------------------- 配色搭配
await page.goto(`${BASE}/colors`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const colorText = await page.locator('body').innerText();
ok('配色页标题', /配色搭配/.test(colorText), colorText.slice(0, 80).replace(/\n/g, ' '));
ok('双栏对比 A/B', (await page.locator('.d509-color-pane').count()) === 2);
ok('配色库有数据', /pal_(npg|aaas|simpsons)/.test(colorText));
ok('ColorLab 接口返回 229 套', /229|230/.test(await page.locator('.d509-color-hero').innerText()));
const swatchCount = await page.locator('.d509-color-pane').first().locator('div[style*="border-radius"]').count();
ok('色板条渲染', swatchCount > 0, `swatches=${swatchCount}`);
const paneSvg = await page.locator('.d509-color-pane svg').count();
ok('预览图渲染', paneSvg >= 2, `svg=${paneSvg}`);
await page.screenshot({ path: 'shots/colors-page.png', fullPage: true });

// 切换自定义方案并输入 HEX
const pane = page.locator('.d509-color-pane').first();
await pane.getByText('自定义', { exact: true }).click();
await page.waitForTimeout(400);
const seedInput = pane.locator('textarea').first();
await seedInput.fill('#4DBBD5 #00A087 #E64B35');
await page.waitForTimeout(700);
const customText = await pane.innerText();
ok('自定义 HEX 解析', /4DBBD5/i.test(customText) && /E64B35/i.test(customText), customText.slice(0, 120).replace(/\n/g, ' '));

// 以图找色
await page.getByText('以图找色', { exact: true }).click();
await page.waitForTimeout(1500);
const matchText = await page.locator('body').innerText();
ok('种子色匹配结果', /pal_npg|ΔE|匹配/.test(matchText));
ok('匹配网格渲染', (await page.locator('.d509-color-match').count()) > 0);
await page.screenshot({ path: 'shots/colors-match.png', fullPage: true });

// ----------------------------- 首页 Hero
await page.mouse.move(900, 500);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
ok('Hero 公告条存在', (await page.locator('.d509-hero-ann').count()) === 1);
const annText = await page.locator('.d509-hero-ann').first().innerText().catch(() => '');
ok('公告含标题/标签', /公告|提醒/.test(annText) && annText.trim().length > 4, annText.replace(/\n/g, ' '));
const weather = page.locator('.d509-hero-weather');
const hasWeather = (await weather.count()) === 1;
ok('Hero 天气胶囊存在', hasWeather, hasWeather ? await weather.first().innerText() : '');
if (hasWeather) {
  const wt = await weather.first().innerText();
  ok('天气含温度或描述', /°C|晴|云|雨|雪|雾|阴/.test(wt), wt);
}
await page.screenshot({ path: 'shots/home-hero-ann-weather.png', fullPage: false });

// 侧栏折叠态分组分隔线：鼠标移开避免 hover 展开
await page.mouse.move(1000, 700);
await page.waitForTimeout(400);
const sep = await page.evaluate(() => {
  const groups = document.querySelectorAll('.ant-layout-sider-collapsed .ant-menu-item-group');
  if (groups.length < 2) return { groups: groups.length, border: null };
  const g = groups[1];
  const cs = getComputedStyle(g);
  return { groups: groups.length, border: cs.borderTopWidth, style: cs.borderTopStyle, color: cs.borderTopColor };
});
ok('折叠侧栏分组分隔线', sep.groups >= 2 && sep.border !== '0px' && sep.border !== null, JSON.stringify(sep));

// 点击公告弹出详情
await page.locator('.d509-hero-ann').first().click();
await page.waitForTimeout(600);
ok('公告点击弹出详情', (await page.locator('.ant-popover').count()) > 0);

ok('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);