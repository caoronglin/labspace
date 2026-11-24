// 生信平台工作区代码预览：上传 1005 行源码 → API 契约 → UI 分段渲染 → 清理。
import { launch, loginContext, BASE } from './_auth.mjs';

const FILE_NAME = `preview_e2e_${Date.now()}.py`;
const CODE = Array.from({ length: 1005 }, (_, i) => `value_${i + 1} = ${i + 1}`).join('\n');
const API = '/apps/bioinfo/api/v1';
let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
};

const b = await launch();
let page;
try {
  const ctx = await loginContext(b);
  page = await ctx.newPage();
  await page.goto(`${BASE}/apps/bioinfo/api/v1/auth/login?redirect=${encodeURIComponent('/apps/bioinfo/workspace')}`, { waitUntil: 'commit' }).catch(() => {});
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    if (page.url().includes('/apps/bioinfo/') && !page.url().includes('/auth/')) break;
  }
  record('门户 SSO 进入生信工作区', page.url().includes('/apps/bioinfo/workspace'), page.url().slice(0, 90));

  const csrf = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/auth/csrf`, { credentials: 'include' });
    return (await r.json()).csrfToken ?? '';
  }, API);
  const uploaded = await page.evaluate(async ([api, csrf, name, code]) => {
    const form = new FormData();
    form.append('path', '');
    form.append('file', new File([code], name, { type: 'text/x-python' }));
    const r = await fetch(`${api}/workspaces/me/upload`, {
      method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf }, body: form,
    });
    return { status: r.status, body: await r.json() };
  }, [API, csrf, FILE_NAME, CODE]);
  record('上传 1005 行源码', uploaded.status === 200, `status=${uploaded.status}`);
  if (uploaded.status !== 200) throw new Error(JSON.stringify(uploaded.body).slice(0, 120));

  const preview = await page.evaluate(async ([api, name]) => {
    const r = await fetch(`${api}/workspaces/me/preview?path=${encodeURIComponent(name)}`, { credentials: 'include' });
    return { status: r.status, body: await r.json() };
  }, [API, FILE_NAME]);
  record('API kind=code + language=python', preview.status === 200 && preview.body.kind === 'code' && preview.body.language === 'python',
    `kind=${preview.body.kind} language=${preview.body.language}`);
  record('API 返回完整 1005 行', (preview.body.text || '').split('\n').length === 1005 && !preview.body.truncated);

  await page.goto(`${BASE}/apps/bioinfo/workspace`, { waitUntil: 'domcontentloaded' });
  const row = page.locator('.ant-list-item').filter({ hasText: FILE_NAME }).first();
  await row.waitFor({ state: 'visible', timeout: 15000 });
  await row.getByRole('button', { name: '预览' }).click();
  const modal = page.locator('.ant-modal').first();
  await modal.locator('pre > div').first().waitFor({ state: 'attached', timeout: 15000 });
  record('UI 首次只渲染 1000 行', await modal.locator('pre > div').count() === 1000,
    `rows=${await modal.locator('pre > div').count()}`);
  const more = modal.getByRole('button', { name: /显示后续 5 行/ });
  record('存在“显示后续”按钮', await more.count() === 1);
  await more.click();
  await page.waitForTimeout(300);
  record('点击后渲染全部 1005 行', await modal.locator('pre > div').count() === 1005,
    `rows=${await modal.locator('pre > div').count()}`);
  await modal.getByRole('button', { name: '自动换行' }).click();
  const wrap = await modal.locator('pre > div > span:last-child').first().evaluate(el => getComputedStyle(el).whiteSpace);
  record('换行开关生效', wrap === 'pre-wrap', `white-space=${wrap}`);
  await page.screenshot({ path: new URL('./shots/', import.meta.url).pathname + 'bioinfo-code-preview.png', fullPage: false });
} finally {
  if (page) {
    try {
      await page.evaluate(async ([api, name]) => {
        const r = await fetch(`${api}/auth/csrf`, { credentials: 'include' });
        const csrf = (await r.json()).csrfToken ?? '';
        await fetch(`${api}/workspaces/me/files?path=${encodeURIComponent(name)}`, {
          method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': csrf },
        });
      }, [API, FILE_NAME]);
    } catch { /* 清理失败不掩盖原始断言 */ }
  }
  await b.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
