// 双入口真实登录链路验证：门户会话 → 生信实训平台 OIDC → /api/v1/me
import { readFileSync } from 'node:fs';

const credFile = '/etc/labspace/casdoor-users.txt';
const wanted = process.env.LAB_ADMIN_USER || 'labadmin@local';
const line = readFileSync(credFile, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .find((l) => l.split(/\s+/)[0] === wanted);
if (!line) {
  console.error(`凭据台账中没有账号 ${wanted}`);
  process.exit(2);
}
process.env.LAB_USER = wanted.split('@')[0];
process.env.LAB_PASS = line.split(/\s+/)[1];

const { loginContext, launch } = await import('./_auth.mjs');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await launch();

for (const host of ['192.0.2.10', '198.51.100.71']) {
  const base = `http://${host}`;
  const ctx = await loginContext(browser, base);
  const page = await ctx.newPage();
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // 门户会话已建立
  const portal = await page.evaluate(async () => {
    const r = await fetch('/api/me', { credentials: 'include' });
    return r.ok ? r.json() : { __status: r.status };
  });
  check(`${host} 门户会话`, !!portal?.sub || !!portal?.user || !!portal?.email, JSON.stringify(portal).slice(0, 90));

  // 走真实 OIDC：跳到生信平台登录入口，回调后应落回该平台并拿到身份
  await page.goto(`${base}:8102/api/v1/auth/login?back=/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const landedUrl = page.url();
  check(`${host} 生信 OIDC 回调落回本机`, landedUrl.startsWith(`http://${host}:8102`), landedUrl);
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  const oidcFail = /校验失败|state|错误|Error|500|502/.test(text) && !/工作台|实训|课程|实验/.test(text);
  check(`${host} 生信登录无 OIDC 错误`, !oidcFail, text.slice(0, 120));

  const me = await page.evaluate(async () => {
    const r = await fetch('/api/v1/auth/me', { credentials: 'include' });
    return r.ok ? r.json() : { __status: r.status, __text: (await r.text()).slice(0, 120) };
  });
  const who = me?.username || me?.displayName || '';
  check(`${host} 生信身份可用`, !!who, `user=${who || JSON.stringify(me).slice(0, 100)}`);

  // 真实终端链路：创建会话 → WebSocket 连接（同主机），并收发一次数据
  const term = await page.evaluate(async () => {
    const csrf = decodeURIComponent(
      document.cookie.split('; ').find((c) => c.startsWith('bioinfo_csrf='))?.split('=')[1] || ''
    );
    const started = await fetch('/api/v1/terminal/sessions', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ cols: 100, rows: 30 }),
    });
    if (!started.ok) return { step: 'create', status: started.status, text: (await started.text()).slice(0, 150) };
    const sid = (await started.json())?.session?.id;
    if (!sid) return { step: 'create', text: '响应中没有会话 id' };
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/v1/terminal/${sid}`);
    const out = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ opened: false, reason: 'timeout' }), 12000);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'input', data: 'echo dualip-$USER\r' }));
      let buf = '';
      ws.onmessage = (ev) => {
        buf += typeof ev.data === 'string' ? ev.data : '';
        if (buf.includes('dualip-')) {
          clearTimeout(timer);
          resolve({ opened: true, echo: true, sid });
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve({ opened: false, reason: 'ws-error', sid });
      };
      ws.onclose = (ev) => {
        if (!buf.includes('dualip-')) {
          clearTimeout(timer);
          resolve({ opened: false, reason: `closed:${ev.code}`, sid });
        }
      };
    });
    ws.close();
    return { step: 'ws', ...out };
  });
  check(
    `${host} 终端 WebSocket 收发`,
    term?.opened === true && term?.echo === true,
    JSON.stringify(term).slice(0, 160)
  );

  await ctx.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
await browser.close();
process.exit(failed.length ? 1 : 0);
