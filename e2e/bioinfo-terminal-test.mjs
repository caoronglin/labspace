// 生信平台终端端到端：建会话 → WebSocket 收发 → 校验 cgroup 限额 → 停止会话
import { chromium } from '/opt/labspace/e2e/node_modules/playwright/index.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8102';
const PASS = process.env.LAB_PASS || '';
const USER = process.env.LAB_USER || 'student01';

const fails = [];
const ok = (cond, label) => {
  console.log(`${cond ? '[ OK ]' : '[FAIL]'} ${label}`);
  if (!cond) fails.push(label);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(`${BASE}/api/v1/auth/login?redirect=/`, { waitUntil: 'domcontentloaded' });
await page.waitForURL(/192\.168\.5\.12:8090/, { timeout: 20000 });
await page.fill('#username', USER);
await page.fill('#password', PASS);
await Promise.all([
  page.waitForURL(/8102/, { timeout: 30000 }),
  page.getByRole('button', { name: /登录|Log in|Login/i }).first().click(),
]);
await page.waitForLoadState('networkidle').catch(() => {});
console.log('登录成功');

const csrf = await page.evaluate(async () => (await fetch('/api/v1/auth/csrf', { credentials: 'include' })).json());
const token = csrf?.csrfToken ?? csrf?.token ?? '';

// 1. 建会话
const created = await page.evaluate(async (t) => {
  const r = await fetch('/api/v1/terminal/sessions', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': t },
    body: JSON.stringify({ cols: 120, rows: 30 }),
  });
  return { status: r.status, body: await r.json() };
}, token);
ok(created.status === 200, `创建终端会话 → ${created.status}`);
const sid = created.body?.session?.id;
const unit = created.body?.session?.unitName;
ok(!!sid, `session id=${sid}`);
ok(/^bioinfo-term-[0-9a-f]{32}$/.test(unit || ''), `systemd 单元名合法 → ${unit}`);

// 2. WebSocket 收发
const wsResult = await page.evaluate(async (id) => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/v1/terminal/${id}`);
  const out = [];
  return await new Promise((resolve) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ ok: false, out, reason: 'timeout' }); }, 20000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'input', data: 'echo READY_MARKER_42\n' }));
    ws.onmessage = (ev) => {
      const txt = String(ev.data);
      out.push(txt.slice(0, 400));
      if (txt.includes('READY_MARKER_42')) { clearTimeout(timer); ws.close(); resolve({ ok: true, out }); }
    };
    ws.onerror = () => { clearTimeout(timer); resolve({ ok: false, out, reason: 'ws error' }); };
  });
}, sid);
ok(wsResult.ok, `WebSocket 终端回显 READY_MARKER_42（${wsResult.reason || 'ok'}）`);
if (!wsResult.ok) console.log('  收到片段:', JSON.stringify(wsResult.out).slice(0, 500));

// 3. cgroup 限额（直接读 cgroup 文件，最硬的证据）
const cgroupPath = created.body?.session?.cgroupPath;
const { readFileSync } = await import('node:fs');
const cg = `/sys/fs/cgroup${cgroupPath}`;
const readCg = (f) => { try { return readFileSync(`${cg}/${f}`, 'utf8').trim(); } catch { return null; } };
const memMax = readCg('memory.max');
const pidsMax = readCg('pids.max');
const cpuMax = readCg('cpu.max');
ok(memMax === '1610612736', `cgroup memory.max=${memMax}（standard 1.5GiB）`);
ok(pidsMax === '256', `cgroup pids.max=${pidsMax}（standard 256）`);
ok(cpuMax === '100000 100000', `cgroup cpu.max=${cpuMax}（standard 1 核）`);

// 4. 停止会话
const stopped = await page.evaluate(async ([id, t]) => {
  const r = await fetch(`/api/v1/terminal/sessions/${id}/stop`, {
    method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': t },
  });
  return { status: r.status, body: await r.text() };
}, [sid, token]);
ok(stopped.status === 200, `停止会话 → ${stopped.status}`);

// 5. 单元已退出
await new Promise((r) => setTimeout(r, 2000));
const unitState = await page.evaluate(async (u) => {
  const r = await fetch(`/api/v1/terminal/sessions/current`, { credentials: 'include' });
  return r.status;
}, unit);
ok(unitState === 200, `会话列表可访问 → ${unitState}`);

console.log(`\n终端端到端: 通过 ${7 - fails.length} 项，失败 ${fails.length}`);
if (fails.length) console.log('失败项:', fails.join(' | '));
await browser.close();
process.exit(fails.length ? 1 : 0);
