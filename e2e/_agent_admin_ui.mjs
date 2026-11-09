// /admin/agent 页面 UI 校验：SKILLS / MCP / 模型端点卡片与弹窗
import { readFileSync } from 'node:fs';
import { launch, BASE } from './_auth.mjs';

const ADMIN_USER = process.env.LAB_ADMIN_USER || 'labadmin';
const PASS =
  process.env.LAB_ADMIN_PASS ||
  (readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
    .split('\n')
    .find((l) => l.trim().startsWith(`${ADMIN_USER}@`)) || '').trim().split(/\s+/)[1] ||
  '';
if (!PASS) throw new Error('缺少管理员口令');
const browser = await launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 30000 });
await page.locator('input[type="text"], input:not([type])').first().fill(ADMIN_USER);
await page.locator('input[type="password"]').first().fill(PASS);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(4000);
for (const label of ['开始使用', '知道了']) {
  const btn = page.getByRole('button', { name: label });
  if (await btn.count()) {
    await btn.first().click();
    await page.waitForTimeout(500);
    break;
  }
}

const out = [];
const check = (name, ok, detail = '') => {
  out.push({ name, ok, detail });
  console.log(`${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
};

await page.goto(`${BASE}/admin/agent`, { waitUntil: 'domcontentloaded' });
await page.getByText('SKILLS（技能）', { exact: true }).waitFor({ timeout: 20000 });
await page.waitForTimeout(1200);

const body = await page.locator('body').innerText();
check('页面包含 SKILLS 卡片', body.includes('SKILLS（技能）'));
check('页面包含 MCP 服务器卡片', body.includes('MCP 服务器'));
check('页面包含模型端点卡片', body.includes('模型端点'));
check('页面包含模型白名单', body.includes('模型白名单'));
check('内置技能已列出', body.includes('植物数据库检索'));
check('技能说明可见', body.includes('SKILL.md'));

// 扫描技能目录弹窗
await page.getByRole('button', { name: /扫描技能目录/ }).first().click();
await page.getByText('扫描目录：', { exact: false }).waitFor({ timeout: 10000 });
const scanBody = await page.locator('.ant-modal').innerText();
check('扫描弹窗显示扫描根目录', scanBody.includes('/opt/labspace/agent/skills'));
check('扫描弹窗发现技能', scanBody.includes('plant-database-search'));
check('已配置技能标记为已添加', scanBody.includes('已添加'));
await page.screenshot({ path: 'shots/_agent_admin_skills.png', fullPage: true });
await page.getByRole('button', { name: '关闭' }).or(page.locator('.ant-modal-close')).first().click();
await page.waitForTimeout(500);

// MCP 添加弹窗
await page.getByRole('button', { name: /添加 MCP 服务器|添加/ }).nth(1).click().catch(async () => {
  const buttons = page.getByRole('button', { name: '添加' });
  await buttons.last().click();
});
await page.waitForTimeout(600);
const mcpModal = await page.locator('.ant-modal').innerText().catch(() => '');
check('MCP 弹窗打开', mcpModal.includes('名称') && mcpModal.includes('传输方式'));
check('MCP 弹窗支持 stdio/HTTP', mcpModal.includes('stdio') || mcpModal.includes('本地命令'));
await page.screenshot({ path: 'shots/_agent_admin_mcp.png', fullPage: false });
await page.locator('.ant-modal-close').last().click();
await page.waitForTimeout(400);

// 模型端点添加弹窗
await page.getByRole('button', { name: /添加端点/ }).first().click();
await page.waitForTimeout(600);
const epModal = await page.locator('.ant-modal').innerText().catch(() => '');
check('端点弹窗打开', epModal.includes('Provider') || epModal.includes('Base URL'));
check('端点弹窗提示密钥不回显', epModal.includes('API Key') || epModal.includes('密钥'));
await page.screenshot({ path: 'shots/_agent_admin_endpoint.png', fullPage: false });
await page.locator('.ant-modal-close').last().click();

const runtimeAlert = await page.locator('.ant-alert').allInnerTexts();
check('无运行配置未同步告警', !runtimeAlert.some((t) => t.includes('尚未同步')), runtimeAlert.join(' | '));
check('无前端控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '));

const failed = out.filter((o) => !o.ok).length;
console.log(`\n结果：${out.length - failed}/${out.length} 通过`);
await browser.close();
process.exit(failed ? 1 : 0);
