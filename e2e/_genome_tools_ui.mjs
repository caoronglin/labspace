// 公共基因组「比对与注释工具」验收：入口、各工具切换、ID 解析/跨注释映射、布局溢出
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const usersFile = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8');
const line = usersFile.split('\n').find((l) => l.startsWith((process.env.LAB_USER || 'labadmin@local') + ' '));
if (!line) throw new Error('测试账号未在 casdoor-users.txt 中找到');
const [user, pass] = line.trim().split(/\s+/);
mkdirSync('/opt/labspace/e2e/shots', { recursive: true });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 960 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

async function overflow() {
  return page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
}

async function closeModals() {
  for (let i = 0; i < 3; i += 1) {
    if (!(await page.locator('.ant-modal-wrap').count())) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const close = page.locator('.ant-modal-close').first();
    if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(4000);

  await page.goto(`${BASE}/genomes`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await closeModals();
  await page.getByText('比对与注释工具', { exact: true }).first().click();
  await page.waitForTimeout(1200);
  console.log('TOOLS_OVERFLOW_1440', JSON.stringify(await overflow()));
  await page.screenshot({ path: '/opt/labspace/e2e/shots/genome-tools-align.png', fullPage: false });

  const toolSeg = page.locator('.ant-segmented').nth(1);
  const tools = ['基序', '区间', '提取', '基因', 'ID 解析', 'BLAST'];
  for (const t of tools) {
    await toolSeg.locator('.ant-segmented-item-label', { hasText: new RegExp(`^${t}$`) }).first().click();
    await page.waitForTimeout(700);
    const ok = await toolSeg.locator('.ant-segmented-item-selected').innerText();
    console.log('TAB', t, '->', ok.replace(/\s+/g, ' '));
  }
  await page.screenshot({ path: '/opt/labspace/e2e/shots/genome-tools-blast.png', fullPage: false });

  await toolSeg.locator('.ant-segmented-item-label', { hasText: /^ID 解析$/ }).first().click();
  await page.waitForTimeout(600);
  const mapTab = page.getByText('跨注释映射', { exact: true }).first();
  console.log('MAP_TAB_VISIBLE', await mapTab.count());
  await mapTab.click();
  await page.waitForTimeout(500);
  const mapHint = await page.getByText(/至少需要两个已发布注释版本|目标注释/).count();
  console.log('MAP_HINT', mapHint);
  await page.screenshot({ path: '/opt/labspace/e2e/shots/genome-tools-idmap.png', fullPage: false });

  // 窄屏检查：工具选择器应降级为 Select，标签不再截断
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  const mobileTool = await page.locator('.ant-select-selection-item').first().innerText().catch(() => '');
  console.log('MOBILE_TOOL_SELECT', mobileTool.replace(/\s+/g, ' '));
  console.log('TOOLS_OVERFLOW_390', JSON.stringify(await overflow()));
  await page.screenshot({ path: '/opt/labspace/e2e/shots/genome-tools-mobile.png', fullPage: false });

  console.log('CONSOLE_ERRORS', errors.length ? errors.slice(0, 5).join(' | ') : 'none');
} finally {
  await ctx.close();
  await browser.close();
}