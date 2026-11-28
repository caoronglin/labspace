// Agent HITL 浏览器回归：服务端 SSE 触发工具确认与 AskUser，前端只回传用户选择。
import { launch, loginContext, BASE } from './_auth.mjs';

let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' - ' + detail : ''}`);
};

const browser = await launch();
const contexts = [];
try {
  const ctx = await loginContext(browser);
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setViewportSize({ width: 1440, height: 900 });

  let streamMode = 'confirm';
  const hitlPayloads = [];
  await page.route('**/api/agent/sessions/*/stream*', async (route) => {
    const event = streamMode === 'confirm'
      ? {
          name: 'confirm',
          data: {
            replyId: 'reply-confirm-e2e',
            toolCalls: [{ id: 'call-confirm-e2e', name: 'Write', input: '{\"file_path\":\"example.txt\"}' }],
          },
        }
      : {
          name: 'ask',
          data: {
            replyId: 'reply-ask-e2e',
            toolCalls: [{
              id: 'call-ask-e2e',
              name: 'AskUser',
              input: JSON.stringify({
                questions: [{
                  question: '选择分析类型',
                  options: [{ label: '序列比对' }, { label: '基因组注释' }],
                }],
              }),
            }],
          },
        };
    const body = `event: ready\ndata: {}\n\nevent: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  await page.route('**/api/agent/sessions/*/messages*', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: true, message: null }) });
  });
  await page.route('**/api/agent/sessions/*/hitl', async (route) => {
    hitlPayloads.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto(`${BASE}/agent`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const before = await page.evaluate(async () => {
    const response = await fetch('/api/agent/sessions', { credentials: 'include' });
    return ((await response.json()).sessions || []).map((item) => item.id);
  });
  await page.getByRole('button', { name: /新建会话/ }).first().click();
  await page.waitForTimeout(1200);
  let sessionId = '';
  for (let i = 0; i < 20 && !sessionId; i++) {
    sessionId = await page.evaluate(async (oldIds) => {
      const response = await fetch('/api/agent/sessions', { credentials: 'include' });
      const ids = ((await response.json()).sessions || []).map((item) => item.id);
      return ids.find((id) => !oldIds.includes(id)) || '';
    }, before);
    if (!sessionId) await page.waitForTimeout(500);
  }
  record('HITL 测试会话创建', Boolean(sessionId));

  const box = page.locator('textarea').first();
  await box.fill('触发工具确认');
  await box.press('Enter');
  await page.getByText('需要你确认工具调用', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  record('服务端 confirm 事件显示确认面板', true);
  await page.getByRole('button', { name: /拒\s*绝/ }).click();
  await page.waitForTimeout(500);
  const confirmPayload = hitlPayloads.find((item) => item.kind === 'confirm');
  record('拒绝结果通过正式 HITL 接口回传', confirmPayload?.approved === false && confirmPayload?.replyId === 'reply-confirm-e2e');
  record('确认回传保留服务端工具调用', confirmPayload?.toolCalls?.[0]?.id === 'call-confirm-e2e');

  streamMode = 'ask';
  await box.fill('触发 AskUser');
  await box.press('Enter');
  await page.getByText('助手需要你做选择', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  record('服务端 ask 事件显示 AskUser 表单', true);
  await page.locator('.ant-radio-wrapper').filter({ hasText: '序列比对' }).click();
  await page.getByRole('button', { name: '提交回答' }).click();
  await page.waitForTimeout(500);
  const askPayload = hitlPayloads.find((item) => item.kind === 'ask');
  record('AskUser 答案通过正式 HITL 接口回传', askPayload?.replyId === 'reply-ask-e2e' && askPayload?.answers?.[0]?.selected?.[0] === '序列比对');

  streamMode = 'confirm';
  await box.fill('触发工具批准');
  await box.press('Enter');
  await page.getByText('需要你确认工具调用', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  await page.getByRole('button', { name: /批\s*准/ }).click();
  await page.waitForTimeout(500);
  const approvalPayload = hitlPayloads.find((item) => item.kind === 'confirm' && item.approved === true);
  record('批准结果通过正式 HITL 接口回传', approvalPayload?.replyId === 'reply-confirm-e2e' && approvalPayload?.toolCalls?.[0]?.id === 'call-confirm-e2e');

  if (sessionId) {
    await page.evaluate(async (id) => {
      const csrf = decodeURIComponent((document.cookie.split('; ').find((cookie) => cookie.startsWith('labspace_csrf=')) || '').split('=')[1] || '');
      await fetch(`/api/agent/sessions/${id}`, { method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': csrf } });
    }, sessionId);
  }
  record('HITL 页面无运行时异常', errors.length === 0, errors.join(' | '));
} finally {
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
