// 验证 Agent 页面：可用技能卡片、Enter 发送、Markdown 回答、复制/重新生成、移动端
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const line = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
  .split('\n').find((l) => l.startsWith('labadmin@local '));
if (!line) throw new Error('测试账号未找到');
const [user, pass] = line.trim().split(/\s+/);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('response', (r) => {
  if (r.status() >= 400 && r.url().includes('/api/')) errors.push(`http ${r.status()} ${r.url()}`);
});

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(user);
await page.locator('input[type="password"]').first().fill(pass);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3000);

const status = await ctx.request.get(`${BASE}/api/agent/status`);
const statusJson = status.ok() ? await status.json() : { error: status.status() };
console.log('status', JSON.stringify({ available: statusJson.available, skills: statusJson.skills, quotas: statusJson.quotas }));

await page.goto(`${BASE}/agent`, { waitUntil: 'domcontentloaded' });
await page.getByText('可用技能', { exact: true }).waitFor({ timeout: 20000 });

// 关闭首次激活引导/更新弹窗（组件延迟 1.2s 弹出）
await page.waitForTimeout(2000);
for (const label of ['开始使用', '知道了']) {
  const btn = page.getByRole('button', { name: label });
  if (await btn.count()) { await btn.first().click(); await page.waitForTimeout(500); break; }
}

const skillCard = page.locator('.ant-card').filter({ hasText: '可用技能' }).first();
console.log('skillsCard', JSON.stringify((await skillCard.locator('.ant-card-body').innerText()).split('\n').filter(Boolean)));
await page.screenshot({ path: '/opt/labspace/e2e/shots/agent_skills_wide.png' });

// 点击技能应回填输入框
const firstSkill = statusJson.skills?.[0]?.name;
if (firstSkill) {
  await skillCard.getByText(firstSkill, { exact: true }).click();
  await page.waitForTimeout(300);
  console.log('fillSkill', JSON.stringify(await page.locator('textarea').first().inputValue()));
}

// 复用最近的会话（配额 max_sessions=3，已有活动会话时不能再新建）
const conv = page.locator('.ant-conversations-item').first();
await conv.click();
await page.waitForFunction(() => {
  const t = document.querySelector('textarea');
  return t && !t.disabled;
}, null, { timeout: 20000 });
const markdownBubbles = page.locator('.ant-bubble-content .d509-prose');
for (let i = 0; i < 30; i++) {
  if (await markdownBubbles.count()) break;
  await page.waitForTimeout(500);
}
const before = await markdownBubbles.count();
console.log('existingAnswers', before);

// Enter 发送
const QUESTION = '请用一句话说明你能帮我做什么';
const sender = page.locator('textarea').first();
await sender.click();
await page.keyboard.type(QUESTION, { delay: 5 });
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
const afterEnter = (await sender.inputValue()).trim();
console.log('enterSubmitted', afterEnter !== QUESTION);
if (afterEnter === QUESTION) {
  await page.locator('.ant-sender-actions-btn').last().click();
}

// 等待新一轮回答完成：Markdown 数 +1 且发送按钮不再 loading
let done = false;
for (let i = 0; i < 150; i++) {
  const loading = await page.locator('.ant-sender-actions-btn .anticon-loading').count();
  if ((await markdownBubbles.count()) > before && loading === 0) { done = true; break; }
  await page.waitForTimeout(1000);
}
const lastAnswer = page.locator('.ant-bubble-content .d509-prose').last();
const lastActions = page.locator('.ant-actions').last();
const actionItem = (label) => lastActions.locator(`.ant-actions-item:has(.anticon-${label})`);
for (let i = 0; i < 30; i++) {
  if ((await lastActions.locator('.ant-actions-item').count()) >= 2) break;
  await page.waitForTimeout(500);
}
console.log('answerDone', done, 'alerts', JSON.stringify(await page.locator('.ant-alert').allInnerTexts()));
console.log('markdown', await markdownBubbles.count(),
  'userBubbles', await page.locator('.ant-bubble').filter({ hasText: QUESTION }).count(),
  'lastActions', await lastActions.locator('.ant-actions-item').count(),
  'answerText', JSON.stringify((await lastAnswer.innerText()).slice(0, 80)));
await page.screenshot({ path: '/opt/labspace/e2e/shots/agent_answer_wide.png' });

// 复制
await actionItem('copy').click();
await page.waitForTimeout(800);
console.log('copyToast', JSON.stringify(await page.locator('.ant-message').allInnerTexts()));

// 重新生成
const shown = await markdownBubbles.count();
const regenResp = page.waitForResponse((r) => r.url().includes('regenerate=true'), { timeout: 30000 }).catch(() => null);
await actionItem('reload').click();
const resp = await regenResp;
console.log('regenApi', resp ? resp.status() : 'no-response');
await page.waitForTimeout(1500);
let regenerated = false;
for (let i = 0; i < 150; i++) {
  const loading = await page.locator('.ant-sender-actions-btn .anticon-loading').count();
  if (loading === 0 && (await lastActions.locator('.ant-actions-item').count()) >= 2) { regenerated = true; break; }
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(1200);
console.log('afterRegenerate', {
  regenerated,
  userBubbles: await page.locator('.ant-bubble').filter({ hasText: QUESTION }).count(),
  markdownBefore: shown,
  markdownAfter: await markdownBubbles.count(),
});
await page.screenshot({ path: '/opt/labspace/e2e/shots/agent_regenerated_wide.png' });

// 移动端
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1200);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log('mobileOverflow', overflow);
await page.screenshot({ path: '/opt/labspace/e2e/shots/agent_skills_narrow.png' });

console.log('errors', JSON.stringify(errors.slice(0, 10)));
await browser.close();