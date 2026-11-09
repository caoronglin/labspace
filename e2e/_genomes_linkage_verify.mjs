// 公共基因组联动 + 侧栏入口回归
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://198.51.100.71';
const line = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('labadmin@local '));
if (!line) throw new Error('测试账号未找到');
const [user, pass] = line.trim().split(/\s+/);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1560, height: 950 }, locale: 'zh-CN' });

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 30000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(2500);
for (const label of ['开始使用', '知道了']) {
  const btn = page.getByRole('button', { name: label });
  if (await btn.count()) { await btn.first().click(); await page.waitForTimeout(400); break; }
}

// 1) 侧栏入口
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const side = await page.locator('.ant-menu').first().innerText();
for (const label of ['多维表格', '本地 AI', '公共基因组', '生信实验实训', '配色搭配']) {
  console.log(`侧栏「${label}」=`, side.includes(label));
}

// 2) 工具结果出口
await page.goto(`${BASE}/genomes`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.getByText('比对与注释工具', { exact: true }).first().click();
await page.waitForTimeout(1200);
await page.getByRole('button', { name: '执行对齐' }).first().click();
await page.waitForTimeout(3500);
const t1 = await page.evaluate(() => document.body.innerText);
console.log('比对结果出现出口 =', t1.includes('存入知识库') && t1.includes('交给 Agent'));

// 3) 交给 Agent
const before = page.url();
await page.getByRole('button', { name: /交给 Agent/ }).first().click();
await page.waitForTimeout(2500);
const inputVal = await page.locator('textarea').first().inputValue().catch(() => '');
console.log('跳转 =', before.replace(BASE, ''), '->', new URL(page.url()).pathname, '| 预填含结果 =', inputVal.includes('成对比对'));

// 4) 区域重叠 → JBrowse 定位
await page.goto(`${BASE}/genomes`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await page.getByText('比对与注释工具', { exact: true }).first().click();
await page.waitForTimeout(1000);
await page.getByText('区间', { exact: true }).first().click();
await page.waitForTimeout(800);
await page.getByRole('button', { name: /查询重叠/ }).first().click();
await page.waitForTimeout(3500);
const t2 = await page.evaluate(() => document.body.innerText);
console.log('区间结果有 JBrowse 出口 =', t2.includes('在 JBrowse 查看'));
if (t2.includes('在 JBrowse 查看')) {
  await page.getByRole('button', { name: /在 JBrowse 查看/ }).first().click();
  await page.waitForTimeout(2500);
  const src = await page.locator('iframe').first().getAttribute('src');
  console.log('浏览器 src =', src);
}

// 5) 基因检索 → 提取序列（工具互投）
await page.getByText('比对与注释工具', { exact: true }).first().click();
await page.waitForTimeout(800);
await page.getByText('基因', { exact: true }).first().click();
await page.waitForTimeout(1500);
const t3 = await page.evaluate(() => document.body.innerText);
console.log('基因页含「提取序列」=', t3.includes('提取序列'), '| 含注释未就绪提示 =', t3.includes('尚未导入参考物种'));

// 6) 序列分析（rust-bio）结果也要能存库 / 交给 Agent
await page.goto(`${BASE}/genomes`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.getByText('序列分析', { exact: true }).first().click();
await page.waitForTimeout(800);
await page.getByRole('button', { name: /分析序列/ }).first().click();
await page.waitForTimeout(4000);
const t4 = await page.evaluate(() => document.body.innerText);
console.log('序列分析结果出口 =', t4.includes('存入知识库') && t4.includes('交给 Agent'));

console.log('页面异常：', errors.length ? errors.slice(0, 3) : '无');
await page.screenshot({ path: 'shots/_genomes_linkage.png', fullPage: false });
await ctx.close();
await browser.close();
