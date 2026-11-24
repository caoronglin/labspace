// 代码预览端到端：上传源码 → API kind=code 契约 → UI 弹窗渲染代码。
//
// 源码文件优先走门户原生 CodePreview（行号 / 换行 / 复制 / 分段渲染）；
// Open File Viewer 仅处理图片、Office、PDF 等非源码格式。
// 本用例覆盖：
//   1. API：/api/files/{id}/preview 返回 kind=code + language + lines（labgo）；
//   2. UI ：单击文件名弹窗渲染代码与行号；
//   3. 长文件分段渲染由 code-preview-long-test.mjs 覆盖。
// 测试文件自建自删（overwrite=1 幂等），不依赖共享区已有数据。
import { launch, loginContext, BASE } from './_auth.mjs';

const FILE_NAME = 'demo_preview.py';
const CODE = [
  '#!/usr/bin/env python3',
  '# demo: 用于验证代码预览链路',
  'import os',
  '',
  'def greet(name: str) -> str:',
  '    return f"hello {name}"',
  '',
  'if __name__ == "__main__":',
  '    print(greet(os.environ.get("USER", "world")))',
  '',
].join('\n');

let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
};

const b = await launch();
try {
  const ctx = await loginContext(b);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

  // 1) 上传（FormData 必须在页面上下文构造）
  const up = await p.evaluate(async ([path, code, filename]) => {
    const csrf = (document.cookie.split('; ').find(c => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
    const form = new FormData();
    form.append('file', new File([code], filename, { type: 'text/x-python' }));
    const res = await fetch(path, {
      method: 'POST', credentials: 'include',
      headers: { 'X-CSRF-Token': decodeURIComponent(csrf) }, body: form,
    });
    return { status: res.status, body: await res.text() };
  }, [`/api/files/upload?source=users&dir=student01&overwrite=1`, CODE, FILE_NAME]);
  record('上传源码文件', up.status === 200, `status=${up.status}`);
  if (up.status !== 200) throw new Error(up.body.slice(0, 120));

  // 2) 拿文件 id
  const list = await p.evaluate(async (path) => {
    const res = await fetch(path, { credentials: 'include' });
    return { status: res.status, body: await res.text() };
  }, '/api/files?source=users&dir=student01');
  const f = (JSON.parse(list.body).entries || []).find(e => e.name === FILE_NAME);
  record('列表返回文件条目', Boolean(f), f ? f.id : '未找到');
  if (!f) throw new Error('file entry not found');

  // 3) API 预览契约（Go preview：kind=code）
  const pv = await p.evaluate(async (path) => {
    const res = await fetch(path, { credentials: 'include' });
    return { status: res.status, body: await res.text() };
  }, `/api/files/${f.id}/preview`);
  const d = JSON.parse(pv.body);
  record('API kind=code + language=python', d.kind === 'code' && d.language === 'python',
    `kind=${d.kind} language=${d.language}`);
  record('API 行数与内容', d.lines === 10 && (d.text || '').includes('def greet'),
    `lines=${d.lines} truncated=${d.truncated}`);

  // 4) UI：单击文件名 → 弹窗渲染代码
  await p.goto(`${BASE}/files?source=users&dir=student01`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.ant-table-row', { timeout: 15000 });
  await p.locator('.ant-table-row a').filter({ hasText: FILE_NAME }).first().click();
  await p.waitForTimeout(3500);
  const modal = p.locator('.ant-modal').first();
  const modalText = (await modal.innerText().catch(() => '')).replace(/\s+/g, ' ');
  record('弹窗标题为文件名', await modal.count() > 0 && modalText.includes(FILE_NAME));
  record('弹窗渲染代码内容', modalText.includes('def greet') && modalText.includes('hello {name}'));
  const codeRows = modal.locator('pre > div');
  await codeRows.first().waitFor({ state: 'attached', timeout: 10000 });
  const firstLineNo = await codeRows.first().locator('span').first().textContent().catch(() => '');
  record('弹窗含行号序列', await codeRows.count() === 10 && firstLineNo?.trim() === '1',
    `rows=${await codeRows.count()} first=${firstLineNo}`);
  await p.screenshot({ path: new URL('./shots/', import.meta.url).pathname + 'code-preview.png', fullPage: false });

  // 5) 清理测试文件（DELETE 走 CSRF）
  const del = await p.evaluate(async ([path]) => {
    const csrf = (document.cookie.split('; ').find(c => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
    const res = await fetch(path, {
      method: 'DELETE', credentials: 'include',
      headers: { 'X-CSRF-Token': decodeURIComponent(csrf) },
    });
    return res.status;
  }, [`/api/files/${f.id}`]);
  record('清理测试文件', del === 200 || del === 204, `status=${del}`);
} finally {
  await b.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
