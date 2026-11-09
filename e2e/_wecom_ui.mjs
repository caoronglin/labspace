// 企业微信通知配置卡片的 UI 验证。脚本不打印任何凭据。
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
    console.log(`FAIL  ${name}${info ? ' :: ' + info.slice(0, 220) : ''}`);
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
await page.waitForTimeout(3000);

await page.goto(`${BASE}/admin/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const card = page.locator('.ant-card', { hasText: '企业微信通知' }).first();
ok('设置页出现企业微信卡片', (await card.count()) > 0, page.url());
const text = (await card.innerText().catch(() => '')).replace(/\n/g, ' ');
ok('展示 Webhook 与公告说明', /Webhook/.test(text) && /公告/.test(text), text.slice(0, 140));
ok('提供启用与摘要开关', /启用通知/.test(text) && /每日任务摘要/.test(text), '');
ok('提供发送测试按钮', /发送测试/.test(text) && /保存配置/.test(text), '');
await card.scrollIntoViewIfNeeded();
await page.screenshot({ path: 'shots/wecom-settings.png' });

await browser.close();
console.log(`\n通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) console.log('失败项：' + fails.join('、'));
process.exit(fails.length ? 1 : 0);
