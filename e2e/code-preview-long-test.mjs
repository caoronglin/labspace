// 门户长文件代码预览：验证原生 CodePreview 优先、1000 行分段渲染与“显示后续”。
import { launch, loginContext, BASE } from './_auth.mjs';

const FILE_NAME = 'demo_preview_long.py';
const CODE = Array.from({ length: 1005 }, (_, i) => `value_${i + 1} = ${i + 1}`).join('\n');
let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
};

const b = await launch();
let fileId = '';
try {
  const ctx = await loginContext(b);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

  const home = await p.evaluate(async () => {
    const r = await fetch('/api/files?source=users', { credentials: 'include' });
    return (await r.json()).home || '';
  });
  const up = await p.evaluate(async ([dir, code, filename]) => {
    const csrf = decodeURIComponent((document.cookie.split('; ').find(c => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '');
    const form = new FormData();
    form.append('file', new File([code], filename, { type: 'text/x-python' }));
    const res = await fetch(`/api/files/upload?source=users&dir=${encodeURIComponent(dir)}&overwrite=1`, {
      method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf }, body: form,
    });
    return { status: res.status, body: await res.text() };
  }, [home, CODE, FILE_NAME]);
  record('上传 1005 行源码', up.status === 200, `status=${up.status}`);
  if (up.status !== 200) throw new Error(up.body.slice(0, 120));

  const list = await p.evaluate(async (dir) => {
    const r = await fetch(`/api/files?source=users&dir=${encodeURIComponent(dir)}`, { credentials: 'include' });
    return await r.json();
  }, home);
  const f = (list.entries || []).find(e => e.name === FILE_NAME);
  fileId = f?.id || '';
  record('列表返回文件 id', Boolean(fileId));
  if (!fileId) throw new Error('file id missing');

  const pv = await p.evaluate(async (id) => {
    const r = await fetch(`/api/files/${id}/preview`, { credentials: 'include' });
    return { status: r.status, body: await r.json() };
  }, fileId);
  record('API 返回完整 1005 行', pv.status === 200 && pv.body.kind === 'code' && pv.body.lines === 1005,
    `kind=${pv.body.kind} lines=${pv.body.lines}`);

  await p.goto(`${BASE}/files?source=users&dir=${encodeURIComponent(home)}`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.ant-table-row', { timeout: 15000 });
  await p.locator('.ant-table-row a').filter({ hasText: FILE_NAME }).first().click();
  const modal = p.locator('.ant-modal').first();
  await modal.waitFor({ state: 'visible', timeout: 15000 });
  await modal.locator('pre > div').first().waitFor({ state: 'attached', timeout: 15000 });
  record('原生代码预览首次只渲染 1000 行', await modal.locator('pre > div').count() === 1000,
    `rows=${await modal.locator('pre > div').count()}`);
  const more = modal.getByRole('button', { name: /显示后续 5 行/ });
  record('存在“显示后续”按钮', await more.count() === 1);
  await more.click();
  await p.waitForTimeout(300);
  record('点击后渲染全部 1005 行', await modal.locator('pre > div').count() === 1005,
    `rows=${await modal.locator('pre > div').count()}`);
  await modal.getByRole('button', { name: '自动换行' }).click();
  const wrap = await modal.locator('pre > div > span:last-child').first().evaluate(el => getComputedStyle(el).whiteSpace);
  record('换行开关生效', wrap === 'pre-wrap', `white-space=${wrap}`);
  await p.screenshot({ path: new URL('./shots/', import.meta.url).pathname + 'code-preview-long.png', fullPage: false });
} finally {
  if (fileId) {
    try {
      const ctx = await loginContext(b);
      const p = await ctx.newPage();
      await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await p.evaluate(async (id) => {
        const csrf = decodeURIComponent((document.cookie.split('; ').find(c => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '');
        await fetch(`/api/files/${id}`, { method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': csrf } });
      }, fileId);
    } catch { /* 清理失败不掩盖原始断言 */ }
  }
  await b.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
