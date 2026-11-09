// 原生文件预览：图片内联缩略图 + PDF 文本提取（内网 Tika）
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = 'http://192.0.2.10';
let failed = 0;
function must(cond, label, extra = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#password', { timeout: 40000 });
await page.locator('#username').fill('student01');
await page.locator('#password').fill(process.env.LAB_S1_PASS);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3500);

const call = (path, init = {}) =>
  page.evaluate(
    async ([p, i]) => {
      const csrf = (document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
      const headers = { ...(i.headers || {}) };
      if (i.method && i.method !== 'GET') headers['X-CSRF-Token'] = decodeURIComponent(csrf);
      const r = await fetch(p, { credentials: 'include', ...i, headers });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, init],
  );

const upload = (name, b64, type) =>
  page.evaluate(
    async ([n, data, t]) => {
      const csrf = (document.cookie.split('; ').find((x) => x.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
      const bin = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const fd = new FormData();
      fd.append('file', new File([bin], n, { type: t }));
      const r = await fetch('/api/files/upload?source=users&dir=student01', {
        method: 'POST',
        body: fd,
        credentials: 'include',
        headers: { 'X-CSRF-Token': decodeURIComponent(csrf) },
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [name, b64, type],
  );

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const pdf = readFileSync(new URL('./fixtures/probe.pdf', import.meta.url)).toString('base64');

const upImg = await upload('_preview_probe.png', png, 'image/png');
must(upImg.status === 200, '上传测试图片', `status=${upImg.status}`);
const imgPrev = await call(`/api/files/${upImg.body?.entry?.id}/preview`);
must(imgPrev.status === 200 && imgPrev.body?.kind === 'image', '图片预览返回 image', `kind=${imgPrev.body?.kind}`);
must(String(imgPrev.body?.dataUrl || '').startsWith('data:image/'), '图片返回内联缩略图 dataUrl', String(imgPrev.body?.dataUrl || '').slice(0, 30));
must(!imgPrev.body?.text, '图片预览不回传源字节');

const upPdf = await upload('_preview_probe.pdf', pdf, 'application/pdf');
must(upPdf.status === 200, '上传测试 PDF', `status=${upPdf.status}`);
const pdfPrev = await call(`/api/files/${upPdf.body?.entry?.id}/preview`);
must(pdfPrev.status === 200 && pdfPrev.body?.kind === 'text', 'PDF 预览返回 text', `kind=${pdfPrev.body?.kind}`);
must(String(pdfPrev.body?.text || '').includes('Hello D509 OXR'), 'PDF 文本提取正确', String(pdfPrev.body?.text || '').slice(0, 60));

const del1 = await call(`/api/files/${upImg.body?.entry?.id}`, { method: 'DELETE' });
const del2 = await call(`/api/files/${upPdf.body?.entry?.id}`, { method: 'DELETE' });
must(del1.status === 200 && del2.status === 200, '清理预览测试文件');

await browser.close();
console.log(failed ? `\nFAILED ${failed}` : '\nALL PASS');
process.exit(failed ? 1 : 0);
