// 文件共享平台端到端验证：预览（图片/PDF/Office）+ 个人空间 ACL（仅本人可见）
import { readFileSync } from 'node:fs';
import { BASE, launch, LAB_USER, LAB_PASS } from './_auth.mjs';

const ADMIN_USER = process.env.LAB_ADMIN_USER || 'labadmin@local';
const ADMIN_PASS = process.env.LAB_ADMIN_PASS;
if (!ADMIN_PASS) throw new Error('缺少 LAB_ADMIN_PASS');

async function loginAs(browser, user, pass) {
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(5000);
  const body = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  if (!/工作台|全部服务|我的收藏/.test(body)) {
    await ctx.close();
    throw new Error(`${user} 登录失败，停留在 ${page.url()}`);
  }
  return ctx;
}

const png = readFileSync('fixtures/e2e-preview.png').toString('base64');
const docx = readFileSync('fixtures/e2e-preview.docx').toString('base64');
const stamp = Date.now().toString(36).slice(-5);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${detail}`);
}

async function api(page, path, init = {}) {
  return page.evaluate(
    async ({ path, init }) => {
      const csrf = document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=')[1];
      const res = await fetch(path, {
        credentials: 'include',
        ...init,
        headers: { ...(init.headers || {}), ...(csrf && init.method && init.method !== 'GET' ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}) },
      });
      let body = null;
      try { body = await res.json(); } catch { /* ignore */ }
      return { status: res.status, body };
    },
    { path, init },
  );
}

async function uploadInPage(page, dir, name, mime, b64) {
  return page.evaluate(
    async ({ dir, name, mime, b64 }) => {
      const csrf = decodeURIComponent(
        document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf='))?.split('=').slice(1).join('=') || '',
      );
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const fd = new FormData();
      fd.append('file', new File([buf], name, { type: mime }));
      const res = await fetch(`/api/files/upload?source=users&dir=${encodeURIComponent(dir)}&overwrite=0`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': csrf },
        body: fd,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { dir, name, mime, b64 },
  );
}

const browser = await launch();
try {
  // ---------- student01 ----------
  const ctx = await loginAs(browser, LAB_USER, LAB_PASS);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`${BASE}/files`, { waitUntil: 'domcontentloaded' });

  const sources = await api(page, '/api/files/sources');
  const byId = Object.fromEntries((sources.body?.sources ?? []).map((s) => [s.id, s]));
  check('文件源列表可读取', sources.status === 200 && Object.keys(byId).length >= 3, `${sources.status} ${Object.keys(byId).join(',')}`);
  check('个人空间可浏览且可写', Boolean(byId.users?.listable) && Boolean(byId.users?.writable), JSON.stringify(byId.users));

  const personal = await api(page, '/api/files?source=users');
  const paths = (personal.body?.entries ?? []).map((e) => e.path);
  const foreign = paths.filter((p) => p && !p.startsWith('student01'));
  check('个人空间仅包含本人目录', personal.status === 200 && foreign.length === 0 && paths.some((p) => p.startsWith('student01/')), `ent=${paths.length} foreign=${foreign.slice(0, 3).join('|')}`);

  // 上传 PNG + DOCX 到个人目录
  const upPng = await uploadInPage(page, 'student01', `_e2e_${stamp}.png`, 'image/png', png);
  const upDoc = await uploadInPage(page, 'student01', `_e2e_${stamp}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx);
  check('上传 PNG 成功', upPng.status === 200 && upPng.body?.entry?.path === `student01/_e2e_${stamp}.png`, `${upPng.status} ${upPng.body?.entry?.path}`);
  check('上传 DOCX 成功', upDoc.status === 200 && upDoc.body?.entry?.path === `student01/_e2e_${stamp}.docx`, `${upDoc.status} ${upDoc.body?.entry?.path}`);

  const pngId = upPng.body?.entry?.id;
  const docId = upDoc.body?.entry?.id;

  const prevPng = await api(page, `/api/files/${pngId}/preview`);
  const prevDoc = await api(page, `/api/files/${docId}/preview`);
  check('图片预览生成内联缩略图', prevPng.status === 200 && prevPng.body?.kind === 'image' && String(prevPng.body?.dataUrl || '').startsWith('data:image/'), `${prevPng.status} kind=${prevPng.body?.kind} dataUrl=${String(prevPng.body?.dataUrl).slice(0, 22)}…`);
  check('Office 预览抽取文本', prevDoc.status === 200 && prevDoc.body?.kind === 'document' && String(prevDoc.body?.text || '').includes('LabSpace E2E'), `${prevDoc.status} kind=${prevDoc.body?.kind} text=${String(prevDoc.body?.text || '').slice(0, 60)}`);

  // PDF（课程材料，Tika 抽取）
  const course = await api(page, '/api/files?source=course-materials');
  const pdf = (course.body?.entries ?? []).find((e) => e.name.toLowerCase().endsWith('.pdf'));
  let prevPdf = { status: 0, body: {} };
  if (pdf) prevPdf = await api(page, `/api/files/${pdf.id}/preview`);
  check('PDF 预览经 Tika 抽取文本', Boolean(pdf) && prevPdf.status === 200 && String(prevPdf.body?.text || '').length > 0, `${pdf?.path} ${prevPdf.status} kind=${prevPdf.body?.kind} chars=${String(prevPdf.body?.text || '').length}`);

  // 列表页出现本人上传文件
  const personal2 = await api(page, '/api/files?source=users');
  const names = (personal2.body?.entries ?? []).map((e) => e.name);
  check('列表返回本人新上传文件', names.includes(`_e2e_${stamp}.png`) && names.includes(`_e2e_${stamp}.docx`), `${names.length} entries`);

  // 记录学生 test.txt 的 id 供越权测试
  const studentTest = (personal2.body?.entries ?? []).find((e) => e.path === 'student01/test.txt');
  const protectedId = studentTest?.id;

  // UI 截图：个人空间
  await page.goto(`${BASE}/files`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ant-table, .ant-empty', { timeout: 20000 });
  await page.locator('.ant-segmented-item', { hasText: '我的文件' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'shots/_files_personal.png', fullPage: false });
  const uiText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  check('UI 个人空间不出现他人文件名', !uiText.includes('student02'), uiText.slice(0, 80));

  // 清理上传
  await api(page, `/api/files/${pngId}`, { method: 'DELETE' });
  await api(page, `/api/files/${docId}`, { method: 'DELETE' });
  const personal3 = await api(page, '/api/files?source=users');
  const names3 = (personal3.body?.entries ?? []).map((e) => e.name);
  check('测试文件已清理', !names3.includes(`_e2e_${stamp}.png`) && !names3.includes(`_e2e_${stamp}.docx`), `${names3.length} entries`);

  await ctx.close();

  // ---------- admin ----------
  const actx = await loginAs(browser, ADMIN_USER, ADMIN_PASS);
  const apage = await actx.newPage();
  await apage.goto(`${BASE}/files`, { waitUntil: 'domcontentloaded' });
  const adminSources = await api(apage, '/api/files/sources');
  const adminUsers = (adminSources.body?.sources ?? []).find((s) => s.id === 'users');
  check('管理员个人空间可写', Boolean(adminUsers?.writable), JSON.stringify(adminUsers));
  const adminPersonal = await api(apage, '/api/files?source=users');
  const adminPaths = (adminPersonal.body?.entries ?? []).map((e) => e.path);
  const leaked = adminPaths.filter((p) => !p.startsWith('labadmin'));
  check('管理员个人空间不含他人目录', adminPersonal.status === 200 && leaked.length === 0, `ent=${adminPaths.length} leaked=${leaked.slice(0, 3).join('|')}`);
  if (protectedId) {
    const steal = await api(apage, `/api/files/${protectedId}/preview`);
    check('管理员无法预览他人个人文件', steal.status === 404, `${steal.status}`);
    const dl = await api(apage, `/api/files/${protectedId}/download`);
    check('管理员无法下载他人个人文件', dl.status === 404, `${dl.status}`);
  } else {
    check('管理员无法预览他人个人文件', false, 'student01/test.txt 未找到');
  }
  await actx.close();

  // ---------- student02 ----------
  const S2_USER = process.env.LAB_USER2 || 'student02@local';
  const S2_PASS = process.env.LAB_PASS2;
  if (S2_PASS) {
    const s2ctx = await loginAs(browser, S2_USER, S2_PASS);
    const s2page = await s2ctx.newPage();
    await s2page.goto(`${BASE}/files`, { waitUntil: 'domcontentloaded' });
    const s2 = await api(s2page, '/api/files?source=users');
    const s2paths = (s2.body?.entries ?? []).map((e) => e.path);
    const cross = s2paths.filter((p) => p && !p.startsWith('student02'));
    check('学生间个人文件隔离', s2.status === 200 && cross.length === 0, `ent=${s2paths.length} cross=${cross.slice(0, 3).join('|')}`);
    await s2ctx.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? 'RESULT ALL PASS' : `RESULT ${failed.length} FAILED`} (${results.length} checks)`);
if (failed.length) process.exitCode = 1;
