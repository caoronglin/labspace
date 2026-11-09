// 验证 Agent 页「深度研究编排」技能：状态接口可见、建议卡片可点、模板可填入
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('labadmin@local '));
if (!line) throw new Error('测试账号未找到');
const [user, pass] = line.trim().split(/\s+/);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });

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

await page.goto(`${BASE}/agent`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

const status = await page.evaluate(async () => {
  const r = await fetch('/api/agent/status', { credentials: 'include' });
  return { code: r.status, body: await r.json() };
});
const skills = (status.body?.skills || []).map((s) => s.name);
console.log('status skills:', skills.join(' | '));

const newBtn = page.getByRole('button', { name: '新建会话' });
if (await newBtn.count()) {
  await newBtn.first().click();
  await page.waitForTimeout(1800);
}

const chip = page.locator('.ant-prompts-item', { hasText: '深度研究编排' }).first();
console.log('suggestion chip:', (await chip.count()) > 0);
await chip.click();
await page.waitForTimeout(500);

const val = await page.locator('textarea').first().inputValue();
console.log('template prefilled:', ['研究问题：', '验收标准：', '期望输出：'].every((k) => val.includes(k)));

await page.screenshot({ path: 'shots/_agent_deep_research.png', fullPage: false });
console.log('errors:', errors.length ? errors.slice(0, 5).join(' || ') : 'none');
await browser.close();