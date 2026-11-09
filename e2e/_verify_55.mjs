// #55 实训平台：课程草稿/发布隔离 + 自动批改（txt/sam/bam）
// 管理员与学生凭据只在内存中使用，不打印。测试数据在 finally 中清理。
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { chromium } from '/opt/labspace/e2e/node_modules/playwright/index.mjs';

const BASE = process.env.BIO_BASE || 'http://192.0.2.10:8102';
const PORTAL = 'http://192.0.2.10';
const OIDC = /192\.168\.5\.12:8090/;

const lines = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n');
const cred = (name) => {
  const line = lines.find((l) => l.trim().startsWith(name + ' '));
  if (!line) throw new Error(`credential not found: ${name}`);
  const [user, pass] = line.trim().split(/[: ]+/).filter(Boolean);
  return { user, pass };
};
const ADMIN = cred('labadmin@local');

const fails = [];
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '[ OK ]' : '[FAIL]'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) fails.push(label);
};

const suffix = Date.now().toString(36).slice(-6);
const COURSE_CODE = `E2E-${suffix}`;
const TEMP_NAME = `e55${suffix}`;
const TEMP_PASS = `T-${crypto.randomBytes(9).toString('base64url')}`;
const STUDENT = { user: TEMP_NAME, pass: TEMP_PASS };

async function login(browser, who) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/api/v1/auth/login?redirect=/`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(OIDC, { timeout: 20000 });
  await page.fill('#username', who.user);
  await page.fill('#password', who.pass);
  await Promise.all([
    page.waitForURL((u) => u.port === '8102', { timeout: 30000 }),
    page.getByRole('button', { name: /登录|Log in|Login/i }).first().click(),
  ]);
  await page.waitForLoadState('networkidle').catch(() => {});
  const csrf = await page.evaluate(async () => {
    const r = await fetch('/api/v1/auth/csrf', { credentials: 'include' });
    const j = await r.json();
    return j.csrfToken || j.token || '';
  });
  return { ctx, page, csrf };
}

async function portalLogin() {
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(`${PORTAL}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(ADMIN.user);
  await page.locator('input[type="password"]').first().fill(ADMIN.pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(6000);
  const csrf = ((await ctx.cookies()).find((c) => c.name === 'labspace_csrf') || {}).value || '';
  return { ctx, page, csrf };
}

async function api(s, method, path, { json, files } = {}) {
  return s.page.evaluate(async ({ method, path, csrf, json, files }) => {
    const headers = { 'X-CSRF-Token': csrf };
    let body;
    if (files) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(files.fields || {})) fd.append(k, v);
      for (const f of files.list || []) {
        const bin = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
        fd.append('files', new Blob([bin]), f.name);
      }
      body = fd;
    } else if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const r = await fetch(path, { method, headers, body, credentials: 'include' });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text.slice(0, 300); }
    return { status: r.status, data };
  }, { method, path, csrf: s.csrf, json, files });
}

// BGZF：gzip 头 + BC 扩展字段 + raw deflate，足以被字节级校验识别为 BAM
function bgzf(payload) {
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x04, 0, 0, 0, 0, 0, 0xff]);
  const deflated = zlib.deflateRawSync(payload);
  const extra = Buffer.alloc(8);
  extra.writeUInt16LE(6, 0); // XLEN
  extra.write('BC', 2, 'latin1');
  extra.writeUInt16LE(2, 4); // SLEN
  const total = 10 + 2 + 6 + deflated.length + 8;
  extra.writeUInt16LE((total - 1) & 0xffff, 6); // BSIZE
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(zlib.crc32(payload) >>> 0, 0);
  tail.writeUInt32LE(payload.length >>> 0, 4);
  return Buffer.concat([header, extra, deflated, tail]);
}

const REPORT = 'gene\tcount\nTP53\t12\nBRCA1\t7\n';
const SAM_BAD = 'r001\t0\tchr1\t100\t60\t50M\t*\t0\t0\tACGT\tIIII\n'; // 缺 @ 头且不足 11 列
const BAM = bgzf(Buffer.concat([Buffer.from('BAM\x01'), Buffer.alloc(40)]));
const b64 = (buf) => Buffer.from(buf).toString('base64');

const browser = await chromium.launch({ args: ['--no-sandbox'] });
let admin = null;
let student = null;
let portal = null;
let courseId = null;
let assignmentId = null;
let submissionId = null;

try {
  portal = await portalLogin();
  const mk = await portal.page.request.post(`${PORTAL}/api/admin/accounts`, {
    headers: { 'X-CSRF-Token': portal.csrf },
    data: { name: TEMP_NAME, displayName: `E2E 学生 ${suffix}`, email: '', groups: [], password: TEMP_PASS },
  });
  ok(mk.status() === 200, '创建临时学生账号', `status=${mk.status()}`);

  admin = await login(browser, ADMIN);
  ok(admin.csrf.length > 0, '管理员登录并获取 CSRF');

  // 1. 新建草稿课程
  const created = await api(admin, 'POST', '/api/v1/courses', {
    json: { code: COURSE_CODE, title: `E2E 草稿 ${suffix}`, category: 'linux', isPublic: true, status: 'draft' },
  });
  courseId = created.data?.id;
  ok(created.status === 200 && courseId, '创建草稿课程', `status=${created.status}`);
  ok(created.data?.status === 'draft', '创建后状态为 draft', String(created.data?.status));

  // 2. 教学端页面能看到草稿与操作按钮
  await admin.page.goto(`${BASE}/teaching/courses`, { waitUntil: 'domcontentloaded' });
  await admin.page.waitForSelector('.ant-table-row', { timeout: 20000 }).catch(() => {});
  const row = admin.page.locator('.ant-table-row', { hasText: COURSE_CODE }).first();
  if (!(await row.count())) {
    console.log('  debug teaching body:', (await admin.page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 300));
  }
  ok(await row.count() > 0, '教学端课程表出现草稿课程');
  if (await row.count()) {
    ok(await row.getByRole('button', { name: '发布' }).count() > 0, '草稿行提供“发布”按钮');
    ok(await row.getByRole('button', { name: '编辑' }).count() > 0, '草稿行提供“编辑”按钮');
    ok(await row.getByRole('button', { name: '删除' }).count() > 0, '草稿行提供“删除”按钮');
  }

  // 3. 学生看不到草稿
  student = await login(browser, STUDENT);
  const sList = await api(student, 'GET', '/api/v1/courses');
  ok(sList.status === 200, '学生课程列表 200');
  ok(!(sList.data?.items || []).some((c) => c.id === courseId), '学生列表不含草稿课程');
  const sDetail = await api(student, 'GET', `/api/v1/courses/${courseId}`);
  if (sDetail.status !== 404) console.log('  debug detail:', JSON.stringify(sDetail.data).slice(0, 300));
  ok(sDetail.status === 404, '学生直访草稿详情 404', `status=${sDetail.status}`);
  const sEnroll = await api(student, 'POST', `/api/v1/courses/${courseId}/enroll`);
  ok(sEnroll.status === 404, '学生选课草稿被拒', `status=${sEnroll.status}`);

  // 4. 编辑 + 发布
  const patched = await api(admin, 'PATCH', `/api/v1/courses/${courseId}`, {
    json: { title: `E2E 已发布 ${suffix}`, estimatedHours: 3 },
  });
  ok(patched.status === 200 && patched.data?.title === `E2E 已发布 ${suffix}`, 'PATCH 课程标题', `status=${patched.status}`);
  const published = await api(admin, 'POST', `/api/v1/courses/${courseId}/publish`);
  ok(published.status === 200 && published.data?.status === 'published', '发布课程', `status=${published.status}`);

  const sList2 = await api(student, 'GET', '/api/v1/courses');
  ok((sList2.data?.items || []).some((c) => c.id === courseId), '发布后学生列表可见');
  const sDetail2 = await api(student, 'GET', `/api/v1/courses/${courseId}`);
  ok(sDetail2.status === 200 && sDetail2.data?.status === 'published', '发布后学生可读详情', `status=${sDetail2.status}`);

  // 5. 建作业（txt/sam/bam）
  const a = await api(admin, 'POST', '/api/v1/assignments', {
    json: {
      title: `E2E 自动批改 ${suffix}`,
      courseId,
      requiredFiles: ['report.txt', 'align.sam', 'result.bam'],
      maxScore: 100,
    },
  });
  assignmentId = a.data?.id;
  ok(a.status === 200 && assignmentId, '创建作业', `status=${a.status}`);

  // 6. 学生提交（txt/bam 合法，sam 格式错误）
  const sub = await api(student, 'POST', '/api/v1/submissions', {
    files: {
      fields: { assignment_id: assignmentId, notes: 'E2E 自动批改验证' },
      list: [
        { name: 'report.txt', b64: b64(REPORT) },
        { name: 'align.sam', b64: b64(SAM_BAD) },
        { name: 'result.bam', b64: b64(BAM) },
      ],
    },
  });
  submissionId = sub.data?.id;
  if (!submissionId) console.log('  debug submission:', JSON.stringify(sub.data).slice(0, 300));
  ok(sub.status === 200 && submissionId, '学生提交作业', `status=${sub.status}`);
  ok(sub.data?.status === 'submitted', '提交后仍在待批阅队列', String(sub.data?.status));
  const auto = (sub.data?.reviews || []).find((r) => r.source === 'auto');
  ok(!!auto, '提交响应包含自动批改建议');
  ok(auto?.reviewerId === null, '自动批改 review 无 reviewerId');
  ok(auto && auto.score > 0 && auto.score < 100, '格式错误扣分（0<分数<100）', `score=${auto?.score}`);
  ok(/自动校验/.test(auto?.feedback || ''), '自动批改反馈可读');

  // 7. 教师重跑自动批改
  const regrade = await api(admin, 'POST', `/api/v1/submissions/${submissionId}/auto-grade`);
  ok(regrade.status === 200, '教师重跑自动批改', `status=${regrade.status}`);
  ok(regrade.data?.grading?.score === auto?.score, '重跑分数与提交时一致', `score=${regrade.data?.grading?.score}`);
  ok((regrade.data?.grading?.checks || []).some((c) => c.passed === false), '批改明细含未通过项');

  // 8. 引用保护 + 删除
  const blocked = await api(admin, 'DELETE', `/api/v1/courses/${courseId}`);
  ok(blocked.status === 409, '有关联作业时删除课程被拒 409', `status=${blocked.status}`);

  // 清理作业及其提交（现有 API 无删除端点，直接用应用会话清理）
  const { execFileSync } = await import('node:child_process');
  execFileSync('bash', ['-lc', `set -a; source /etc/bioinfo-training/platform.env; cd /opt/bioinfo-training/backend; .venv/bin/python - "${assignmentId}" <<'PY'
import shutil, sys
from app.db import SessionLocal
from app.config import get_settings
from app.models import Assignment, Submission
db = SessionLocal()
aid = sys.argv[1]
subs = db.query(Submission).filter(Submission.assignment_id == aid).all()
root = get_settings().submissions_root
for s in subs:
    if s.storage_path:
        shutil.rmtree(s.storage_path, ignore_errors=True)
    else:
        shutil.rmtree(root / ('student_' + s.user_id.hex[:8]) / str(s.id), ignore_errors=True)
a = db.get(Assignment, aid)
if a:
    db.delete(a)
db.commit()
print('cleaned', len(subs))
PY`], { stdio: 'pipe' });
  assignmentId = null;

  const deleted = await api(admin, 'DELETE', `/api/v1/courses/${courseId}`);
  ok(deleted.status === 200 && deleted.data?.ok === true, '解除关联后删除课程成功', `status=${deleted.status}`);
  courseId = null;
} catch (err) {
  ok(false, '脚本异常', err?.message || String(err));
} finally {
  if (assignmentId && /^[0-9a-f-]{36}$/i.test(assignmentId)) {
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('bash', ['-lc', `set -a; source /etc/bioinfo-training/platform.env; cd /opt/bioinfo-training/backend; .venv/bin/python - "${assignmentId}" <<'PY'
import shutil, sys
from app.db import SessionLocal
from app.config import get_settings
from app.models import Assignment, Submission
db = SessionLocal()
aid = sys.argv[1]
subs = db.query(Submission).filter(Submission.assignment_id == aid).all()
for s in subs:
    shutil.rmtree(s.storage_path or '', ignore_errors=True)
a = db.get(Assignment, aid)
if a:
    db.delete(a)
db.commit()
PY`], { stdio: 'pipe' });
    } catch { /* ignore */ }
  }
  if (courseId && admin) await api(admin, 'DELETE', `/api/v1/courses/${courseId}`).catch(() => {});
  if (portal) {
    await portal.page.request
      .delete(`${PORTAL}/api/admin/accounts/${TEMP_NAME}`, {
        headers: { 'X-CSRF-Token': portal.csrf },
        data: { confirm: TEMP_NAME },
      })
      .catch(() => {});
  }
  await admin?.ctx.close().catch(() => {});
  await student?.ctx.close().catch(() => {});
  await portal?.ctx.close().catch(() => {});
  await browser.close();
}

console.log(`\n#55 验证: ${fails.length ? '存在失败' : '全部通过'}（失败 ${fails.length}）`);
if (fails.length) console.log('失败项:\n- ' + fails.join('\n- '));
process.exit(fails.length ? 1 : 0);