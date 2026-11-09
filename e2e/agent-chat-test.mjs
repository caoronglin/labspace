// 浏览器端到端：Agent 助手真实对话（建会话 → 发消息 → SSE 流式中文回复）
import { launch, BASE } from './_auth.mjs';
import { mkdirSync } from 'node:fs';

const LAB_USER = process.env.LAB_USER || 'student01';
const LAB_PASS = process.env.LAB_PASS;

mkdirSync(new URL('./shots/', import.meta.url).pathname, { recursive: true });

const browser = await launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(LAB_USER);
await page.locator('input[type="password"]').first().fill(LAB_PASS);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(4000);
console.log('✓ 登录成功');

await page.goto(`${BASE}/agent`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// 记录已有会话（用于识别本次新建的那一个）
const before = await page.evaluate(async (base) => {
  const res = await fetch(`${base}/api/agent/sessions`, { credentials: 'include' });
  const data = await res.json();
  return (data.sessions || []).map((s) => s.id);
}, BASE);

// 新建会话
await page.getByRole('button', { name: /新建会话/ }).first().click();
await page.waitForTimeout(2500);
let newSessionId = '';
for (let i = 0; i < 20; i++) {
  newSessionId = await page.evaluate(async (args) => {
    const res = await fetch(`${args.base}/api/agent/sessions`, { credentials: 'include' });
    const data = await res.json();
    const ids = (data.sessions || []).map((s) => s.id);
    return ids.find((id) => !args.before.includes(id)) || '';
  }, { base: BASE, before });
  if (newSessionId) break;
  await page.waitForTimeout(1000);
}
console.log(`✓ 会话创建：${newSessionId ? '新会话 ' + newSessionId : '未取到新会话 id'}`);

// 发送消息
const box = page.locator('textarea').first();
await box.fill('请帮我查一下 NCBI GenBank 里有没有 Arabidopsis thaliana 的基因组记录');
await box.press('Enter');
console.log('✓ 消息已发送，等待流式回复…');

// 等待助手回复（以服务端落库为准，避免被用户自己的文本误判）
let persisted = { ok: false, count: 0, roles: [], assistantLen: [] };
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(1500);
  persisted = await page.evaluate(async (args) => {
    const list = await fetch(`${args.base}/api/agent/sessions`, { credentials: 'include' }).then((r) => r.json());
    const all = list.sessions || [];
    const target = all.find((s) => s.id === args.id) || all[0];
    if (!target) return { ok: false, count: 0, roles: [], assistantLen: [] };
    const md = await fetch(`${args.base}/api/agent/sessions/${target.id}/messages`, { credentials: 'include' }).then((r) => r.json());
    const msgs = md.messages || [];
    const roles = msgs.map((x) => x.role);
    const assistantLen = msgs.filter((x) => x.role === 'assistant').map((x) => (x.content || '').length);
    return { ok: roles.includes('assistant'), count: all.length, roles, assistantLen };
  }, { base: BASE, id: newSessionId });
  if (persisted.ok && (persisted.assistantLen?.[0] || 0) >= 30) break;
}
const reply = await page.evaluate(() => document.body.innerText);
const hasCjk = /[\u4e00-\u9fa5]/.test(reply);
console.log(`✓ 页面文本长度 ${reply.length}，含中文 ${hasCjk}`);
console.log(`✓ 服务端会话 ${persisted.count} 个，消息角色 ${JSON.stringify(persisted.roles)}，助手消息长度 ${JSON.stringify(persisted.assistantLen)}`);

// 清理：删除本次创建的会话，避免占满活动会话配额影响后续运行
if (newSessionId) {
  await page.evaluate(async (args) => {
    await fetch(`${args.base}/api/agent/sessions/${args.id}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'X-CSRF-Token': document.cookie.split('labspace_csrf=')[1]?.split(';')[0] || '' },
    });
  }, { base: BASE, id: newSessionId });
  console.log('✓ 已清理本次会话');
}

await page.screenshot({ path: new URL('./shots/agent-chat.png', import.meta.url).pathname });
console.log(errors.length ? `控制台错误：${errors.slice(0, 3).join(' | ')}` : '✓ 控制台无错误');
await browser.close();

const ok = persisted.ok && persisted.roles.includes('assistant') && (persisted.assistantLen?.[0] || 0) > 0;
console.log(ok ? '\n结果：Agent 对话端到端通过' : '\n结果：Agent 对话端到端失败');
process.exit(ok ? 0 : 1);
