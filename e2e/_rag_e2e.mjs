// 知识库 RAG：Docling 抽取入库 → 后台索引 → 检索问答 → UI 引用展示
import { readFileSync } from 'node:fs';
import { BASE, launch, LAB_USER, LAB_PASS } from './_auth.mjs';

const pdf = readFileSync('/srv/lab/course-materials/testdoc.pdf').toString('base64');
const stamp = Date.now().toString(36).slice(-5);
const title = `_e2e_rag_${stamp}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${detail}`);
};

async function signInAs(page, user, pass) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(4000);
}

async function signIn(page) {
  return signInAs(page, LAB_USER, LAB_PASS);
}

async function api(page, path, init = {}) {
  return page.evaluate(
    async ({ path, init }) => {
      const csrf = decodeURIComponent(
        document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=').slice(1).join('=') || '',
      );
      const res = await fetch(path, {
        credentials: 'include',
        ...init,
        headers: { ...(init.headers || {}), ...(csrf && init.method && init.method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}) },
      });
      let body = null;
      try { body = await res.json(); } catch { /* ignore */ }
      return { status: res.status, body };
    },
    { path, init },
  );
}

const browser = await launch();
try {
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  await page.goto(`${BASE}/knowledge`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const before = await api(page, '/api/knowledge/rag/status');
  check('RAG 服务在线', before.status === 200 && before.body?.available === true, JSON.stringify(before.body?.error || before.body?.ok));

  const ing = await page.evaluate(
    async ({ b64, title }) => {
      const csrf = decodeURIComponent(
        document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=').slice(1).join('=') || '',
      );
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const fd = new FormData();
      fd.append('file', new File([buf], 'rag-e2e.pdf', { type: 'application/pdf' }));
      fd.append('title', title);
      fd.append('visibility', 'private');
      fd.append('roles', '[]');
      const res = await fetch('/api/knowledge/ingest', {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': csrf },
        body: fd,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { b64: pdf, title },
  );
  check('PDF 经结构化解析入库', ing.status === 200 && ing.body?.extractedChars > 20, `${ing.status} extractor=${ing.body?.extractor} chars=${ing.body?.extractedChars}`);
  check('抽取来源为 Docling', ing.body?.extractor === 'Docling', String(ing.body?.extractor));

  const docId = ing.body?.item?.id;
  const detail = await api(page, `/api/knowledge/${docId}`);
  const bodyText = detail.body?.item?.body || '';
  check('入库正文为纯文本且含表格内容', /STAR/.test(bodyText) && !/\|---/.test(bodyText) && !/^#/m.test(bodyText), `${bodyText.length} chars: ${bodyText.slice(0, 50).replace(/\n/g, ' ')}`);

  // 等待后台索引
  let indexed = null;
  for (let i = 0; i < 45; i++) {
    const st = await api(page, '/api/knowledge/rag/status');
    if ((st.body?.documents ?? 0) >= 1) { indexed = st.body; break; }
    await page.waitForTimeout(2000);
  }
  check('后台索引包含新文档', Boolean(indexed), indexed ? `docs=${indexed.documents} chunks=${indexed.chunks}` : 'timeout');

  const ask = await api(page, '/api/knowledge/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'STAR genomeGenerate 参数和 QC 指标', topK: 4 }),
  });
  const cites = ask.body?.citations ?? [];
  const hit = cites.find((c) => c.title === title);
  check('检索命中刚入库的私有文档', ask.status === 200 && Boolean(hit), `${ask.status} mode=${ask.body?.mode} cites=${cites.length}${hit ? ` score=${hit.score}` : ''}`);

  const S2_USER = process.env.LAB_USER2 || 'student02@local';
  const S2_PASS = process.env.LAB_PASS2;
  if (S2_PASS) {
    const s2ctx = await browser.newContext({ locale: 'zh-CN' });
    const s2page = await s2ctx.newPage();
    await signInAs(s2page, S2_USER, S2_PASS);
    await s2page.goto(`${BASE}/knowledge`, { waitUntil: 'domcontentloaded' });
    const s2ask = await api(s2page, '/api/knowledge/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'STAR genomeGenerate 参数和 QC 指标', topK: 4 }),
    });
    const leaked = (s2ask.body?.citations ?? []).find((c) => c.title === title);
    check('私有文档不泄露给其他学生', s2ask.status === 200 && !leaked, `${s2ask.status} cites=${(s2ask.body?.citations ?? []).length}`);
    await s2ctx.close();
  }

  // UI 问答
  const sender = page.locator('textarea, input').filter({ hasText: '' }).last();
  const box = page.getByPlaceholder('向知识库提问，回车发送');
  await box.fill('STAR genomeGenerate 参数和 QC 指标');
  await box.press('Enter');
  await page.waitForTimeout(2500);
  const pageText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  check('UI 展示检索引用', pageText.includes(title), pageText.slice(0, 90));
  await page.screenshot({ path: 'shots/_rag_answer.png' });

  await api(page, `/api/knowledge/${docId}`, { method: 'DELETE' });
  let cleared = false;
  for (let i = 0; i < 30; i++) {
    const st = await api(page, '/api/knowledge/rag/status');
    if ((st.body?.documents ?? 0) === 0) { cleared = true; break; }
    await page.waitForTimeout(2000);
  }
  check('清理测试文档并重建索引', cleared, cleared ? 'documents=0' : 'pending');

  // Office 走 Tika 回退
  const docx = readFileSync('fixtures/e2e-preview.docx').toString('base64');
  const docxTitle = `_e2e_docx_${stamp}`;
  const ingDocx = await page.evaluate(
    async ({ b64, title }) => {
      const csrf = decodeURIComponent(
        document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=').slice(1).join('=') || '',
      );
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const fd = new FormData();
      fd.append('file', new File([buf], 'rag-e2e.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
      fd.append('title', title);
      fd.append('visibility', 'private');
      fd.append('roles', '[]');
      const res = await fetch('/api/knowledge/ingest', {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': csrf },
        body: fd,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { b64: docx, title: docxTitle },
  );
  check('Office 文档经 Tika 回退入库', ingDocx.status === 200 && ingDocx.body?.extractor === 'Tika' && /LabSpace E2E/.test(ingDocx.body?.item?.body || ''), `${ingDocx.status} extractor=${ingDocx.body?.extractor}`);
  await api(page, `/api/knowledge/${ingDocx.body?.item?.id}`, { method: 'DELETE' });
  check('无前端运行时错误', errors.length === 0, errors.join(' | ') || 'none');
  await ctx.close();
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? 'RESULT ALL PASS' : `RESULT ${failed.length} FAILED`} (${results.length} checks)`);
if (failed.length) process.exitCode = 1;
