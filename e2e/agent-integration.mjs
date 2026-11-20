// =====================================================================
//  D509 新能力集成体检：个人工作台 / Agent 助手 / 天气 / Hy-MT2 / OXR 文档解析
//  用法: LAB_PASS=<口令> node agent-integration.mjs
// =====================================================================
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const USER = process.env.LAB_USER || 'labadmin';
const PASS =
  process.env.LAB_PASS ||
  (readFileSync('/etc/labspace/casdoor-users.txt', 'utf8')
    .split('\n')
    .find((l) => l.trim().startsWith(`${USER}@`)) || '').trim().split(/\s+/)[1] ||
  '';

let pass = 0;
let fail = 0;
function record(name, ok, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();

await page.goto(`${BASE}/api/auth/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#username', { timeout: 20000 });
await page.locator('#username').fill(USER);
await page.locator('#password').fill(PASS);
await page.getByRole('button', { name: '登录' }).first().click();
await page.waitForURL(`${BASE}/**`, { timeout: 25000 }).catch(() => {});
await page.waitForTimeout(1200);

const api = async (path, init = {}) =>
  page.evaluate(
    async ([p, i]) => {
      if (i.method && i.method !== 'GET') {
        const csrf = (document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
        i = { ...i, headers: { ...(i.headers || {}), 'X-CSRF-Token': decodeURIComponent(csrf) } };
      }
      const r = await fetch(p, { credentials: 'include', ...i });
      const t = await r.text();
      try {
        return { status: r.status, body: JSON.parse(t) };
      } catch {
        return { status: r.status, body: t.slice(0, 300) };
      }
    },
    [path, init],
  );

console.log('\n== 1. 个人工作台 ==');
{
  const s = await api('/api/workbench/summary');
  record('GET /api/workbench/summary', s.status === 200, `status=${s.status}`);

  const c = await api('/api/workbench/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '明天下午提交论文修改稿' }),
  });
  record('POST /api/workbench/capture', c.status === 200 && !!c.body?.item, `kind=${c.body?.ai_class} title=${c.body?.item?.title}`);

  const items = await api('/api/workbench/items');
  record('GET /api/workbench/items', items.status === 200 && Array.isArray(items.body?.items), `count=${items.body?.items?.length}`);

  const projects = await api('/api/workbench/projects');
  record('GET /api/workbench/projects', projects.status === 200 && Array.isArray(projects.body?.projects), `count=${projects.body?.projects?.length}`);

  const plans = await api('/api/workbench/plans');
  record('GET /api/workbench/plans', plans.status === 200 && Array.isArray(plans.body?.plans), `count=${plans.body?.plans?.length}`);
}

console.log('\n== 2. 天气 ==');
{
  const w = await api('/api/weather?city=' + encodeURIComponent('北京') + '&days=5');
  record('GET /api/weather', w.status === 200 && !!w.body?.current, `${w.body?.city} ${w.body?.current?.description} ${w.body?.current?.temperature}℃`);
  record('天气逐日预报', Array.isArray(w.body?.daily) && w.body.daily.length === 5, `days=${w.body?.daily?.length}`);
}

console.log('\n== 3. Hy-MT2 翻译 ==');
{
  const st = await api('/api/mt/status');
  record('GET /api/mt/status', st.status === 200 && /hy-mt2/i.test(String(st.body?.provider || '')), `available=${st.body?.available} reason=${st.body?.reason}`);
  const langCount = st.body?.languages ? Object.keys(st.body.languages).length : 0;
  record('翻译语言列表', langCount >= 5, `count=${langCount}`);
  if (st.body?.effective_available || st.body?.available) {
    const r = await api('/api/mt/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'The quick brown fox jumps over the lazy dog.', targetLang: '中文' }),
    });
    record('POST /api/mt/translate', r.status === 200 && !!r.body?.translation, `-> ${String(r.body?.translation || '').slice(0, 40)}`);
  } else {
    console.log('  [SKIP] Hy-MT2 模型未部署，跳过真实翻译（状态接口已返回明确原因）');
  }
}

console.log('\n== 4. 文档解析页已下架 ==');
{
  const st = await api('/api/docparse/status');
  record('GET /api/docparse/status 已下线', st.status === 404, `${st.status}`);
}

console.log('\n== 5. Agent 助手 ==');
{
  const st = await api('/api/agent/status');
  record('GET /api/agent/status', st.status === 200, `available=${st.body?.available} reason=${st.body?.reason}`);

  const models = await api('/api/agent/models');
  record('GET /api/agent/models', models.status === 200 && Array.isArray(models.body?.models), `count=${models.body?.models?.length}`);

  const quota = await api('/api/agent/quota');
  record('GET /api/agent/quota', quota.status === 200, `used=${quota.body?.used}`);

  const create = await api('/api/agent/sessions?title=' + encodeURIComponent('集成体检会话'), { method: 'POST' });
  record('POST /api/agent/sessions', create.status === 200 && !!create.body?.session?.id, `id=${create.body?.session?.id}`);
  const sid = create.body?.session?.id;

  if (sid) {
    const send = await api(`/api/agent/sessions/${sid}/messages?content=` + encodeURIComponent('用一句话介绍你能做什么'), { method: 'POST' });
    record('POST /api/agent/sessions/{id}/messages', send.status === 200 && send.body?.accepted === true, `status=${send.status} body=${JSON.stringify(send.body).slice(0, 200)}`);

    const streamed = await (async () => {
      const ssePage = await ctx.newPage();
      await ssePage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      try {
        const out = await ssePage.evaluate(
          async ([id, base]) => {
            const res = await fetch(`${base}/api/agent/sessions/${id}/stream`, { credentials: 'include' });
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            let name = '';
            let text = '';
            let done = false;
            let raw = '';
            let status = res.status;
            const deadline = Date.now() + 120000;
            while (Date.now() < deadline && !done) {
              const { value, finished } = await reader.read();
              if (finished) break;
              buf += dec.decode(value, { stream: true });
              raw += buf;
              const lines = buf.split('\n');
              buf = lines.pop() || '';
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('event:')) {
                  name = trimmed.slice(6).trim();
                } else if (trimmed.startsWith('data:')) {
                  let obj = {};
                  try {
                    obj = JSON.parse(trimmed.slice(5).trim());
                  } catch {}
                  if (name === 'delta' && obj.text) text += obj.text;
                  if (name === 'done') done = true;
                }
              }
            }
            return { ok: text.length > 0, text, status, raw: raw.slice(0, 400) };
          },
          [sid, BASE],
        );
        return out;
      } catch (err) {
        return { ok: false, text: '', error: String(err).slice(0, 160) };
      } finally {
        await ssePage.close().catch(() => {});
      }
    })();
    record('Agent SSE 流式回复', streamed.ok && streamed.text.length > 0, `字数=${streamed.text.length} 前40字=${streamed.text.slice(0, 40)}${streamed.error ? ' 错误=' + streamed.error : ''} status=${streamed.status ?? '-'}${streamed.raw ? ' raw=' + streamed.raw.slice(0, 120).replace(/\n/g, ' ') : ''}`);

    const msgs = await api(`/api/agent/sessions/${sid}/messages`);
    const roles = (msgs.body?.messages || []).map((m) => m.role);
    record('GET /api/agent/sessions/{id}/messages', msgs.status === 200 && Array.isArray(msgs.body?.messages), `count=${msgs.body?.messages?.length} roles=${roles.join(',')}`);
    record('助手回复已落库', roles.includes('assistant'), `assistant=${roles.filter((r) => r === 'assistant').length} 条`);

    const del = await api(`/api/agent/sessions/${sid}`, { method: 'DELETE' });
    record('DELETE /api/agent/sessions/{id}', del.status === 200, `status=${del.status}`);
  }
}

console.log(`\n结果: 通过 ${pass} / 失败 ${fail}`);
await browser.close();
process.exit(fail ? 1 : 0);
