import { chromium } from 'playwright';

const BASE = 'http://192.0.2.10';
const stamp = Date.now().toString().slice(-6);
const docs = {};

function must(cond, label, extra = '') {
  if (!cond) throw new Error(`FAIL ${label} ${extra}`);
  console.log(`ok   ${label}`);
}

async function session(user, pass) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(user);
  await page.locator('input[type="password"]').first().fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(4500);
  const call = (path, init = {}) =>
    page.evaluate(
      async ({ path, init }) => {
        const csrf = document.cookie.match(/(?:^|;\s*)labspace_csrf=([^;]+)/)?.[1];
        const res = await fetch(path, {
          credentials: 'include',
          ...init,
          headers: {
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...(csrf && init.method && init.method !== 'GET' ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}),
            ...(init.headers || {}),
          },
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      { path, init },
    );
  return { browser, ctx, page, call };
}

const create = (call, doc) =>
  call('/api/knowledge', { method: 'POST', body: JSON.stringify(doc) });

const s1 = await session(
  process.env.LAB_S1_USER || 'student01',
  process.env.LAB_S1_PASS || process.env.LAB_PASS,
);
const me1 = await s1.call('/api/me');
must(me1.status === 200 && me1.body.authenticated, 'student01 已登录', JSON.stringify(me1.body));
const tags = ['e2e', `t${stamp}`];

for (const [key, doc] of Object.entries({
  private: { title: `S1 私有笔记 ${stamp}`, body: '只有我可见的内容', tags, visibility: 'private', roles: [] },
  roles: { title: `S1 组内笔记 ${stamp}`, body: 'lab-student 可见', tags, visibility: 'roles', roles: ['lab-student'] },
  public: { title: `S1 公开笔记 ${stamp}`, body: '全实验室可见', tags, visibility: 'public', roles: [] },
})) {
  const res = await create(s1.call, doc);
  must(res.status === 200 && res.body?.item?.id, `创建 ${key} 条目`, JSON.stringify(res.body));
  docs[key] = res.body.item.id;
}

const list1 = await s1.call('/api/knowledge?q=' + encodeURIComponent(`t${stamp}`));
must(list1.body.items.length === 3, 'student01 看到自己 3 条', JSON.stringify(list1.body.total));

const detail1 = await s1.call(`/api/knowledge/${docs.private}`);
must(detail1.body?.item?.body === '只有我可见的内容', '详情包含完整正文');

const patch = await s1.call(`/api/knowledge/${docs.private}`, {
  method: 'PATCH',
  body: JSON.stringify({ body: '只有我可见的内容（已更新）' }),
});
must(patch.status === 200 && patch.body.item.body.endsWith('（已更新）'), '更新私有条目');

// ---- student02 ----
const s2 = await session(
  process.env.LAB_S2_USER || 'student02',
  process.env.LAB_S2_PASS || process.env.LAB_PASS,
);
const me2 = await s2.call('/api/me');
must(me2.status === 200 && me2.body.authenticated, 'student02 已登录');
const list2 = await s2.call('/api/knowledge?q=' + encodeURIComponent(`t${stamp}`));
const ids2 = new Set((list2.body.items || []).map((d) => d.id));
must(!ids2.has(docs.private), 'student02 看不到私有条目');
must(ids2.has(docs.public), 'student02 看到公开条目');
if ((me2.body.roles || []).includes('lab-student')) {
  must(ids2.has(docs.roles), 'student02 看到 lab-student 角色条目');
} else {
  console.log('skip student02 不在 lab-student，跳过角色可见性断言');
}
const hidden = await s2.call(`/api/knowledge/${docs.private}`);
must(hidden.status === 404, 'student02 直接取私有条目返回 404', String(hidden.status));
const forbid = await s2.call(`/api/knowledge/${docs.private}`, {
  method: 'PATCH',
  body: JSON.stringify({ title: '篡改' }),
});
must(forbid.status === 404 || forbid.status === 403, 'student02 无法修改私有条目', String(forbid.status));
const publicRead = await s2.call(`/api/knowledge/${docs.public}`);
must(publicRead.status === 200, 'student02 可读取公开条目');

// ---- admin ----
const admin = await session(
  process.env.LAB_ADMIN_USER || 'labadmin',
  process.env.LAB_ADMIN_PASS || process.env.LAB_PASS,
);
const mea = await admin.call('/api/me');
must(mea.body.isAdmin, 'labadmin 是管理员');
const lista = await admin.call('/api/knowledge?q=' + encodeURIComponent(`t${stamp}`));
must(lista.body.items.length === 3, '管理员看到全部 3 条', String(lista.body.total));
const adminRead = await admin.call(`/api/knowledge/${docs.private}`);
must(adminRead.status === 200, '管理员可读私有条目');

// ---- UI ----
await s1.page.goto(`${BASE}/knowledge`, { waitUntil: 'domcontentloaded' });
await s1.page.waitForTimeout(3500);
const txt = (await s1.page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
must(/实验室知识库/.test(txt), '知识库页面渲染', txt.slice(0, 160));
must(txt.includes(`S1 私有笔记 ${stamp}`), '页面列出私有条目');
await s1.page.getByText(`S1 组内笔记 ${stamp}`).first().click();
await s1.page.waitForTimeout(800);
const detailTxt = (await s1.page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
must(detailTxt.includes('lab-student 可见'), '点击后展示对应正文');
await s1.page.screenshot({ path: '/opt/labspace/e2e/_knowledge_page.png', fullPage: true });

// 打开新建弹窗并检查表单
await s1.page.getByRole('button', { name: /新建条目/ }).first().click();
await s1.page.waitForTimeout(600);
const modalTxt = (await s1.page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
must(/新建条目/.test(modalTxt) && /可见范围/.test(modalTxt), '新建弹窗包含表单');
await s1.page.getByRole('button', { name: /取 ?消/ }).last().click();
await s1.page.waitForTimeout(300);

// ---- cleanup ----
for (const id of Object.values(docs)) {
  const del = await admin.call(`/api/knowledge/${id}`, { method: 'DELETE' });
  must(del.status === 200, `清理条目 ${id}`);
}
const after = await admin.call('/api/knowledge?q=' + encodeURIComponent(`t${stamp}`));
must(after.body.items.length === 0, '测试条目已清理');

await admin.browser.close();
await s2.browser.close();
await s1.browser.close();
console.log('ALL PASS');
