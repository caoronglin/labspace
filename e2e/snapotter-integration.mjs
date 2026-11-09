// =====================================================================
//  SnapOtter 门户集成体检：原生 REST 代理 + 页面 + 真实工具调用
//  用法: LAB_PASS=<口令> node snapotter-integration.mjs
// =====================================================================
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const USER = process.env.LAB_USER || 'student01';
const PASS = process.env.LAB_PASS || '';

let pass = 0;
let fail = 0;
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 200)));

// ---------- 登录 ----------
await page.goto(`${BASE}/api/auth/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#username', { timeout: 20000 });
await page.locator('#username').fill(USER);
await page.locator('#password').fill(PASS);
await page.getByRole('button', { name: '登录' }).first().click();
await page.waitForTimeout(2500);

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

console.log('\n== 1. 服务状态 ==');
{
  const s = await api('/api/snapotter/status');
  record('GET /api/snapotter/status 200', s.status === 200, `status=${s.status}`);
  record('SnapOtter 服务在线', s.body?.up === true, `detail=${s.body?.detail}`);
  record('工具数量 > 100', Number(s.body?.toolCount) > 100, `toolCount=${s.body?.toolCount}`);
}

console.log('\n== 2. 工具目录 ==');
let tools = [];
{
  const t = await api('/api/snapotter/tools');
  record('GET /api/snapotter/tools 200', t.status === 200, `status=${t.status}`);
  tools = t.body?.tools ?? [];
  record('工具目录非空', tools.length > 100, `count=${tools.length}`);
  const sections = [...new Set(tools.map((x) => x.section))];
  record('覆盖 image/pdf/files 等分区', ['image', 'pdf', 'files'].every((s) => sections.includes(s)), sections.join(','));
  const resize = tools.find((x) => x.section === 'image' && x.id === 'resize');
  record('包含 image/resize 工具', !!resize, resize ? resize.name : '未找到');
}

console.log('\n== 3. 真实工具调用（image/resize） ==');
{
  // 生成一张 8x8 的红色 PNG（浏览器 canvas → blob）
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#2B5CE6';
    ctx.fillRect(0, 0, 64, 64);
    return c.toDataURL('image/png');
  });
  const b64 = dataUrl.split(',')[1];

  const run = await page.evaluate(
    async ([b64]) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const fd = new FormData();
      fd.append('file', new File([arr], 'test.png', { type: 'image/png' }));
      fd.append('settings_json', JSON.stringify({ width: 32, height: 32 }));
      const csrf = (document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
      const r = await fetch('/api/snapotter/run?section=image&tool_id=resize', {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': decodeURIComponent(csrf) },
        body: fd,
      });
      const t = await r.text();
      try {
        return { status: r.status, body: JSON.parse(t) };
      } catch {
        return { status: r.status, body: t.slice(0, 300) };
      }
    },
    [b64],
  );
  record('POST /api/snapotter/run 返回 2xx', run.status >= 200 && run.status < 300, `status=${run.status} ${JSON.stringify(run.body).slice(0, 160)}`);
  const jobId = run.body?.jobId;
  record('返回 jobId', !!jobId, String(jobId));
  const downloadUrl = run.body?.downloadUrl;
  record('返回 downloadUrl', !!downloadUrl, String(downloadUrl));

  if (downloadUrl) {
    const dl = await page.evaluate(
      async (u) => {
        const r = await fetch(`/api/snapotter/download?url=${encodeURIComponent(u)}`, { credentials: 'include' });
        const b = await r.blob();
        return { status: r.status, size: b.size, type: b.type };
      },
      downloadUrl,
    );
    record('GET /api/snapotter/download 可下载', dl.status === 200 && dl.size > 0, `status=${dl.status} size=${dl.size}`);
  }
}

console.log('\n== 4. 门户页面 ==');
{
  await page.goto(`${BASE}/snapotter`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const bodyText = await page.locator('body').innerText();
  record('/snapotter 页面加载', bodyText.includes('SnapOtter'), bodyText.slice(0, 60).replace(/\n/g, ' '));
  record('页面显示在线状态', bodyText.includes('在线'), /在线|离线/.exec(bodyText)?.[0] ?? '未找到');
  record('工具目录已渲染', (await page.locator('text=/Resize Image|resize/i').count()) > 0, `匹配 ${await page.locator('text=/Resize Image|resize/i').count()} 处`);
  record('页面无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  await page.screenshot({ path: 'shots/snapotter.png', fullPage: false });
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
