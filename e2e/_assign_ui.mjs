// 导师指派验收：创建临时成员 → 派发任务(富文本+附件) → 成员开始/提交(附件) → 导师批阅
// 凭据只在内存中使用，不打印；测试结束后硬删除临时账号与指派。
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const usersFile = readFileSync('/etc/labspace/casdoor-users.txt', 'utf8');
const adminLine = usersFile.split('\n').find((l) => l.startsWith('labadmin@local '));
if (!adminLine) throw new Error('管理员测试账号未找到');
const [adminUser, adminPass] = adminLine.trim().split(/\s+/);

const TEMP = 'e2eassign01';
const TEMP_EMAIL = `${TEMP}@local`;
const tempPass = randomBytes(12).toString('base64url');
const DELIVERY = '/tmp/e2e-assign-delivery.txt';
const BRIEF = '/tmp/e2e-assign-brief.md';
writeFileSync(DELIVERY, '交付文件内容：GWAS 初筛结果表（示意）\n');
writeFileSync(BRIEF, '# 说明\n\n- 使用 **PLINK 2.0** 完成质控\n- 输出 `results.tsv`\n');

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];

async function newPage() {
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 960 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  return { ctx, page };
}

async function login(page, user, pass) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(4500);
  // 首次登录引导
  const onboard = page.getByRole('button', { name: '开始使用' });
  if (await onboard.count()) {
    await onboard.first().click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function api(page, path, { method = 'GET', body, file } = {}) {
  return page.evaluate(
    async ({ path, method, body, file }) => {
      const m = document.cookie.match(/(?:^|; )labspace_csrf=([^;]*)/);
      const csrf = m ? decodeURIComponent(m[1]) : '';
      const headers = {};
      if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
      let payload;
      if (file) {
        const fd = new FormData();
        fd.append('file', new File([file.content], file.name, { type: file.type }));
        payload = fd;
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(path, { method, credentials: 'include', headers, body: payload });
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = text.slice(0, 300);
      }
      return { status: res.status, data };
    },
    { path, method, body, file },
  );
}

let adminCtx;
let studentCtx;
let assignmentId = null;
let deliveryUrl = null;

try {
  // ---------------------------------------------------------------- 管理员
  const admin = await newPage();
  adminCtx = admin.ctx;
  const ap = admin.page;
  await login(ap, adminUser, adminPass);
  console.log('ADMIN_LOGIN', !ap.url().includes('/login'));

  // 清理可能残留的临时账号
  const list = await api(ap, '/api/admin/accounts');
  const existed = (list.data?.accounts || list.data || []).find?.((a) => a.name === TEMP);
  if (existed) {
    const del = await api(ap, `/api/admin/accounts/${TEMP}`, { method: 'DELETE', body: { confirm: TEMP } });
    console.log('PRE_CLEAN', del.status);
  }
  // 清理上次中断残留的指派
  const prev = await api(ap, '/api/workbench/assignments');
  for (const a of prev.data?.outgoing || []) {
    if (a.title === '完成拟南芥开花时间 GWAS 初筛') {
      await api(ap, `/api/workbench/assignments/${a.id}`, { method: 'DELETE' });
    }
  }

  const created = await api(ap, '/api/admin/accounts', {
    method: 'POST',
    body: { name: TEMP, displayName: '指派验收临时成员', email: TEMP_EMAIL, groups: ['lab-student'], password: tempPass },
  });
  console.log('ACCOUNT_CREATE', created.status);

  const people = await api(ap, '/api/workbench/assignment-people');
  const person = (people.data?.people || []).find((p) => p.email === TEMP_EMAIL);
  console.log('PEOPLE_OK', Boolean(person), 'TEMP_ID_LEN', person?.id?.length || 0);
  if (!person) throw new Error('临时成员未出现在指派目录');

  const made = await api(ap, '/api/workbench/assignments', {
    method: 'POST',
    body: {
      assignee_id: person.id,
      kind: 'task',
      title: '完成拟南芥开花时间 GWAS 初筛',
      content: '## 目标\n\n对 120 份自然群体材料完成 **开花时间** 关联初筛。\n\n- 使用 PLINK 2.0 完成质控\n- 输出 `results.tsv` 与曼哈顿图\n\n> 截止前提交结果与简要说明。',
      priority: 'high',
      due_date: '2026-12-31',
    },
  });
  console.log('ASSIGN_CREATE', made.status);
  assignmentId = made.data?.assignment?.id || null;
  if (!assignmentId) throw new Error('指派创建失败');

  const briefUp = await api(ap, `/api/workbench/assignments/${assignmentId}/files?purpose=brief`, {
    method: 'POST',
    file: { name: '任务说明.md', content: readFileSync(BRIEF, 'utf8'), type: 'text/markdown' },
  });
  console.log('BRIEF_UPLOAD', briefUp.status);

  await ap.goto(`${BASE}/workbench`, { waitUntil: 'domcontentloaded' });
  await ap.waitForTimeout(1500);
  await ap.getByRole('tab', { name: /指派/ }).click();
  await ap.waitForTimeout(600);
  await ap.getByText('我发出的', { exact: false }).first().click();
  await ap.waitForTimeout(800);
  const outgoingSeen = (await ap.evaluate(() => document.body.innerText)).includes('完成拟南芥开花时间 GWAS 初筛');
  console.log('OUTGOING_BOARD', outgoingSeen);
  await ap.screenshot({ path: '/opt/labspace/e2e/shots/assign-outgoing.png' });

  // ---------------------------------------------------------------- 成员
  const student = await newPage();
  studentCtx = student.ctx;
  const sp = student.page;
  await login(sp, TEMP_EMAIL, tempPass);
  console.log('STUDENT_LOGIN', !sp.url().includes('/login'));

  await sp.goto(`${BASE}/workbench`, { waitUntil: 'domcontentloaded' });
  await sp.waitForTimeout(1600);
  await sp.getByRole('tab', { name: /指派/ }).click();
  await sp.waitForTimeout(800);
  const incomingSeen = (await sp.evaluate(() => document.body.innerText)).includes('完成拟南芥开花时间 GWAS 初筛');
  console.log('INCOMING_BOARD', incomingSeen);
  await sp.screenshot({ path: '/opt/labspace/e2e/shots/assign-incoming.png' });

  await sp.getByText('完成拟南芥开花时间 GWAS 初筛').first().click();
  await sp.waitForTimeout(600);
  const detailText = await sp.evaluate(() => document.body.innerText);
  console.log('DETAIL_MD', detailText.includes('对 120 份自然群体材料完成'), 'BRIEF_FILE', detailText.includes('任务说明.md'));

  // 标记开始
  await sp.getByRole('button', { name: '标记开始' }).click();
  await sp.waitForTimeout(900);
  console.log('STATUS_IN_PROGRESS', (await sp.evaluate(() => document.body.innerText)).includes('进行中'));

  // 提交交付
  await sp.getByRole('button', { name: '提交交付' }).click();
  await sp.waitForTimeout(500);
  const submitModal = sp.locator('.ant-modal:visible').last();
  await submitModal.locator('textarea').last().fill('已完成质控与关联分析，结果见附件。\n\n- 质控后保留 118 份材料\n- 显著位点 7 个');
  await submitModal.locator('input[type="file"]').last().setInputFiles(DELIVERY);
  await sp.waitForTimeout(500);
  await submitModal.getByRole('button', { name: /^提\s*交$/ }).click();
  await sp.waitForTimeout(2000);
  const submittedText = await sp.evaluate(() => document.body.innerText);
  console.log('SUBMITTED', submittedText.includes('待批阅'), 'SUBMISSION_MD', submittedText.includes('质控后保留 118 份材料'), 'DELIVERY_FILE', submittedText.includes('e2e-assign-delivery.txt'));
  await sp.screenshot({ path: '/opt/labspace/e2e/shots/assign-submitted.png' });

  const sub = (await api(sp, '/api/workbench/assignments')).data?.incoming?.find((a) => a.id === assignmentId);
  deliveryUrl = sub?.submissions?.[0]?.files?.[0]?.url || null;
  const dl = await api(sp, deliveryUrl || '');
  console.log('DELIVERY_DOWNLOAD_AS_ASSIGNEE', dl.status, String(dl.data).includes('GWAS'));
  const briefDl = await api(sp, sub?.brief_files?.[0]?.url || '');
  console.log('BRIEF_DOWNLOAD_AS_ASSIGNEE', briefDl.status, String(briefDl.data).includes('PLINK'));
  console.log('FILE_URLS', Boolean(sub?.brief_files?.[0]?.url), Boolean(sub?.submissions?.[0]?.files?.[0]?.url), sub?.brief_files?.[0]?.size > 0);

  // ---------------------------------------------------------------- 导师批阅
  await ap.reload({ waitUntil: 'domcontentloaded' });
  await ap.waitForTimeout(1800);
  await ap.getByRole('tab', { name: /指派/ }).click();
  await ap.waitForTimeout(700);
  await ap.getByText('我发出的', { exact: false }).first().click();
  await ap.waitForTimeout(800);
  await ap.getByText('完成拟南芥开花时间 GWAS 初筛').first().click();
  await ap.waitForTimeout(700);
  const reviewText = await ap.evaluate(() => document.body.innerText);
  console.log('REVIEW_SEES_SUBMISSION', reviewText.includes('质控后保留 118 份材料'));

  const dl2 = await api(ap, deliveryUrl || '');
  console.log('DELIVERY_DOWNLOAD_AS_CREATOR', dl2.status);

  await ap.locator('.ant-modal:visible').last().locator('button').filter({ hasText: '通过' }).click();
  await ap.waitForTimeout(500);
  const reviewModal = ap.locator('.ant-modal:visible').last();
  await reviewModal.locator('textarea').last().fill('结果符合预期，辛苦了。\n\n请把曼哈顿图整理进周报。');
  await reviewModal.locator('button').filter({ hasText: '确认通过' }).click();
  await ap.waitForTimeout(2000);
  const acceptedText = await ap.evaluate(() => document.body.innerText);
  console.log('ACCEPTED', acceptedText.includes('已通过'), 'FEEDBACK', acceptedText.includes('结果符合预期'));
  await ap.screenshot({ path: '/opt/labspace/e2e/shots/assign-accepted.png' });

  // ---------------------------------------------------------------- 清理
  if (assignmentId) {
    const delA = await api(ap, `/api/workbench/assignments/${assignmentId}`, { method: 'DELETE' });
    console.log('CLEAN_ASSIGNMENT', delA.status);
  }
  const delAcc = await api(ap, `/api/admin/accounts/${TEMP}`, { method: 'DELETE', body: { confirm: TEMP } });
  console.log('CLEAN_ACCOUNT', delAcc.status);

  console.log('CONSOLE_ERRORS', errors.length ? errors.slice(0, 4).join(' | ') : 'none');
} finally {
  await studentCtx?.close().catch(() => {});
  await adminCtx?.close().catch(() => {});
  await browser.close();
  rmSync(DELIVERY, { force: true });
  rmSync(BRIEF, { force: true });
}