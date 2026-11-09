// 临时探针：打开 /agent，检查 Ant Design X 组件渲染与 SSE 事件
import { launch, BASE } from './_auth.mjs';

const LAB_USER = process.env.LAB_USER || 'student01';
const LAB_PASS = process.env.LAB_PASS;

const browser = await launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e).slice(0, 200)));

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill(LAB_USER);
await page.locator('input[type="password"]').first().fill(LAB_PASS);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(4000);

await page.goto(`${BASE}/agent`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

const dom = await page.evaluate(() => ({
  conversations: document.querySelectorAll('.ant-conversations').length,
  conversationsItems: document.querySelectorAll('.ant-conversations-item').length,
  welcome: document.querySelectorAll('.ant-welcome').length,
  prompts: document.querySelectorAll('.ant-prompts').length,
  bubbles: document.querySelectorAll('.ant-bubble').length,
  sender: document.querySelectorAll('.ant-sender').length,
  textarea: document.querySelectorAll('textarea').length,
  bodyLen: document.body.innerText.length,
}));
console.log('DOM:', JSON.stringify(dom));

// 新建会话
await page.getByRole('button', { name: /新建会话/ }).first().click();
await page.waitForTimeout(2000);
const sid = await page.evaluate(async (base) => {
  const r = await fetch(`${base}/api/agent/sessions`, { credentials: 'include' });
  const d = await r.json();
  return (d.sessions || []).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0]?.id || '';
}, BASE);
console.log('session:', sid);

if (sid) {
  // 打开 SSE 监听再发消息
  const events = [];
  const streamPromise = page.evaluate(async ({ base, id }) => {
    const out = [];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const r = await fetch(`${base}/api/agent/sessions/${id}/stream`, { credentials: 'include', signal: ctrl.signal });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if (!raw) continue;
          const ev = (raw.match(/^event: (.+)$/m) || [])[1] || 'message';
          const data = (raw.match(/^data: (.+)$/m) || [])[1] || '';
          out.push({ ev, data: data.slice(0, 300) });
          if (ev === 'done' || ev === 'error') { ctrl.abort(); return out; }
        }
      }
    } catch (e) {
      out.push({ ev: 'abort', data: String(e).slice(0, 120) });
    } finally {
      clearTimeout(timer);
    }
    return out;
  }, { base: BASE, id: sid }).catch((e) => [{ ev: 'eval-error', data: String(e).slice(0, 200) }]);

  await page.waitForTimeout(800);
  const box = page.locator('textarea').first();
  await box.fill('你好，请用一句话介绍你自己');
  await box.press('Enter');
  const result = await streamPromise;
  console.log('SSE events:', JSON.stringify(result).slice(0, 2500));
  console.log('DOM bubbles after:', await page.evaluate(() => document.querySelectorAll('.ant-bubble').length));
  console.log('text:', (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 600));
  console.log('model select:', await page.locator('.ant-select-selection-item').first().innerText().catch(() => 'n/a'));

  await page.screenshot({ path: new URL('./shots/_agent_probe.png', import.meta.url).pathname });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  await page.evaluate(async ({ base, id }) => {
    await fetch(`${base}/api/agent/sessions/${id}`, {
      method: 'DELETE', credentials: 'include',
      headers: { 'X-CSRF-Token': document.cookie.split('labspace_csrf=')[1]?.split(';')[0] || '' },
    });
  }, { base: BASE, id: sid });
}

console.log('console errors:', errors.slice(0, 5));
await browser.close();
