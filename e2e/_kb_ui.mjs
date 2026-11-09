// 知识库界面联动的真实浏览器验证：分类筛选、从文件管理入库、目录上传表单、回链、文件页反向入库。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const CSRF = 'e2e-csrf-token-value';
const CATEGORY = '界面验证分类';
const DOC_TITLE = '界面验证条目';

let pass = 0;
const fails = [];
const ok = (name, cond, info = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}${info ? ' :: ' + info : ''}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${info ? ' :: ' + info.slice(0, 220) : ''}`);
  }
};

const adminToken = execFileSync('docker', ['exec', '-i', 'lab-labspace-backend', 'python', '-c', `
from app import accounts
from app.security import issue_session
import json
row = accounts._query('SELECT id, name, display_name, email, groups FROM public."user" WHERE owner=%s AND name=%s', ('built-in', 'labadmin'))[0]
print(issue_session({"id": row["id"], "email": row["email"], "name": row["display_name"], "roles": json.loads(row["groups"] or "[]")}))
`], { encoding: 'utf8' }).trim();

const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      cookie: `labspace_session=${adminToken}; labspace_csrf=${CSRF}`,
      origin: BASE,
      'x-csrf-token': CSRF,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: (() => (text.startsWith('{') ? JSON.parse(text) : null))() };
};

// ---- 准备：个人空间里放两个可抽取的文档，清掉上一轮残留条目 ----
for (const term of [DOC_TITLE, 'kb-ui']) {
  const old = await api('GET', '/api/knowledge?q=' + encodeURIComponent(term));
  for (const d of old.json?.items ?? []) await api('DELETE', `/api/knowledge/${d.id}`);
}

const home = (await api('GET', '/api/files?source=users&sort=name&order=asc')).json;
const homeDir = (home?.entries ?? []).find((e) => e.dir && !e.path.includes('/'));
const uiPath = `${homeDir.path}/kb-ui`;
await api('POST', '/api/files/mkdir', { source: 'users', path: uiPath });
const upload = async (name, text) => {
  const fd = new FormData();
  fd.append('file', new Blob([text], { type: 'text/plain' }), name);
  const res = await fetch(
    `${BASE}/api/files/upload?source=users&dir=${encodeURIComponent(uiPath)}&overwrite=1`,
    { method: 'POST', headers: { cookie: `labspace_session=${adminToken}; labspace_csrf=${CSRF}`, origin: BASE, 'x-csrf-token': CSRF }, body: fd },
  );
  return res.status;
};
const up1 = await upload('kb-ui-a.md', '# STAR 比对要点\n\nSTAR --runThreadN 16 --genomeDir index 用于基因组比对。');
const up2 = await upload('kb-ui-b.txt', 'hisat2 建索引使用 hisat2-build，比对使用 hisat2 -x maize -1 r1.fq -2 r2.fq。');
ok('准备个人空间测试文件', up1 === 200 || up1 === 201, `${up1}/${up2}`);

// ---- 浏览器 ----
const creds = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const password = creds.trim().split(/\s+/)[1];

const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } });
const page = await ctx.newPage();
const badApi = [];
const apiLog = [];
page.on('response', (r) => {
  if (/\/api\/knowledge/.test(r.url())) {
    r.text()
      .then((t) => apiLog.push(`${r.status()} ${r.url().replace(BASE, '')} ${t.slice(0, 260)}`))
      .catch(() => {});
  }
});
page.on('console', (m) => {
  if (m.type() === 'error') badApi.push(`console ${m.text().slice(0, 160)}`);
});
page.on('response', (r) => {
  if (r.status() >= 400 && /\/api\//.test(r.url())) badApi.push(`${r.status()} ${r.url().replace(BASE, '')}`);
});

await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill('labadmin');
await page.locator('input[type="password"]').first().fill(password);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3500);

console.log('# 文档库标签页与分类面板');
await page.goto(`${BASE}/knowledge`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.locator('.ant-segmented-item', { hasText: '文档库' }).first().click();
await page.waitForTimeout(1500);
const band = page.locator('.ant-card', { hasText: '分类' }).first();
ok('分类面板存在', await band.isVisible());
ok('面板有「全部」计数', (await band.innerText()).includes('全部（'), (await band.innerText()).slice(0, 120));
const toolbar = page.getByRole('button', { name: /从文件管理入库/ });
ok('工具栏有「从文件管理入库」', (await toolbar.count()) > 0);

console.log('# 从文件管理入库');
await toolbar.first().click();
const picker = page.locator('.ant-modal', { hasText: '从文件管理入库' }).first();
await picker.waitFor({ state: 'visible', timeout: 8000 });
ok('打开入库选择器', await picker.isVisible());
await picker.locator('.ant-table-row').first().waitFor({ state: 'visible', timeout: 15000 });
const pickerText = await picker.innerText();
ok('选择器列出个人空间内容', (await picker.locator('.ant-table-row').count()) > 0, pickerText.slice(0, 200));
// 个人空间根下是账号同名目录，双击逐层进入 kb-ui
const hasKbUi = async () => (await picker.locator('.ant-table-row', { hasText: 'kb-ui' }).count()) > 0;
const enabledBoxes = () => picker.locator('.ant-table-row input[type="checkbox"]:not([disabled])');
for (let i = 0; i < 3; i += 1) {
  if ((await enabledBoxes().count()) > 0) break;
  const hop = (await hasKbUi())
    ? picker.locator('.ant-table-row', { hasText: 'kb-ui' }).first()
    : picker.locator('.ant-table-row', { has: page.locator('.anticon-folder') }).first();
  if (!(await hop.count())) break;
  await hop.dblclick();
  await page.waitForTimeout(1200);
}
ok('进入 kb-ui 目录', (await picker.innerText()).includes('kb-ui-a'), (await picker.innerText()).slice(0, 160));
const boxes = enabledBoxes();
ok('可勾选文件数 >= 2', (await boxes.count()) >= 2, `count=${await boxes.count()}`);
const checks = picker.locator('.ant-table-row .ant-checkbox');
await checks.nth(0).click();
await checks.nth(1).click();
await page.waitForTimeout(400);
ok('按钮显示已选数量', (await picker.getByRole('button', { name: /入库（2）/ }).count()) > 0, await picker.getByRole('button', { name: /入库/ }).innerText());
await picker.locator('.ant-form-item', { hasText: '分类' }).first().locator('input').fill(CATEGORY);
await page.waitForTimeout(300);
await picker.getByRole('button', { name: /入库（2）/ }).click();
await page.locator('.ant-message-notice').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);
const toast = (await page.locator('.ant-message').innerText().catch(() => '')) + ' || ' + apiLog.slice(-2).join(' || ');
ok('入库成功提示', /已入库|新增/.test(toast), toast.slice(0, 220));
await page.waitForTimeout(2500);

console.log('# 分类筛选与回链');
const search = page.locator('input[placeholder="搜索标题、正文或标签"]');
await search.fill('kb-ui');
await search.press('Enter');
await page.waitForTimeout(1800);
const listCard = page.locator('.ant-card', { hasText: '文档（' }).first();
const listText = await listCard.innerText();
ok('入库条目出现在文档列表', listText.includes('kb-ui-a') && listText.includes('kb-ui-b'), listText.slice(0, 220));
ok('搜索结果只有这两个条目', listText.includes('文档（2）'), listText.slice(0, 80));
const docRow = listCard.locator('.ant-list-item', { hasText: 'kb-ui-a' }).first();
await docRow.click();
await page.waitForTimeout(1500);
const detail = page.locator('.ant-card', { hasText: '在文件管理中打开' }).first();
ok('详情给出来源与回链', (await detail.count()) > 0, (await detail.innerText().catch(() => '')).slice(0, 200));
ok('详情标注分类', (await detail.innerText()).includes(CATEGORY), (await detail.innerText()).slice(0, 200));
await page.screenshot({ path: 'shots/kb-ui-detail.png' });
const back = page.getByRole('button', { name: /在文件管理中打开/ });
await back.click();
await page.waitForTimeout(2500);
ok('回链跳到文件管理并定位目录', /\/files\?source=users&dir=/.test(page.url()) && (await page.locator('body').innerText()).includes('kb-ui-a'), page.url());
await page.goto(`${BASE}/knowledge`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.locator('.ant-segmented-item', { hasText: '文档库' }).first().click();
await page.waitForTimeout(1500);
const catChip = page.locator('.ant-tag-checkable', { hasText: CATEGORY }).first();
ok('分类面板出现新分类', (await catChip.count()) > 0, await page.locator('.ant-card', { hasText: '分类' }).first().innerText());
await catChip.click();
await page.waitForTimeout(1800);
ok('按分类筛选命中两个条目', (await listCard.innerText()).includes('文档（2）'), (await listCard.innerText()).slice(0, 120));
await page.locator('.ant-tag-checkable', { hasText: '全部（' }).first().click();
await page.waitForTimeout(1200);

console.log('# 新建文档：分类字段');
await page.getByRole('button', { name: /新\s*建\s*文\s*档/ }).first().click();
const editor = page.locator('.ant-modal', { hasText: '新建文档' }).first();
await editor.waitFor({ state: 'visible', timeout: 8000 });
ok('新建表单含分类', (await editor.innerText()).includes('分类'));
await editor.locator('input[placeholder*="水稻基因组"]').fill(DOC_TITLE + 'B');
await editor.locator('.ant-form-item', { hasText: '分类' }).locator('input').first().fill(CATEGORY);
await editor.locator('.ant-form-item', { hasText: '标签' }).locator('input').first().fill('质控');
await editor.locator('.ant-form-item', { hasText: '标签' }).locator('input').first().press('Enter');
await editor.locator('textarea').fill('fastp 质控：fastp -i r1.fq.gz -I r2.fq.gz -o c1.fq.gz -O c2.fq.gz -h qc.html');
await editor.getByRole('button', { name: /保\s*存/ }).click();
await page.waitForTimeout(3000);
const savedToast = await page.locator('.ant-message').innerText().catch(() => '');
ok('新建带分类的文档成功', /已创建|已更新/.test(savedToast), savedToast.slice(0, 160));
await page.waitForTimeout(2000);
const bandText = await page.locator('.ant-card', { hasText: '分类' }).first().innerText();
ok('分类计数随新条目增加', /界面验证分类 · 3/.test(bandText), bandText.replace(/\n/g, ' ').slice(0, 200));
ok('标签面板出现「质控」', bandText.includes('质控'), bandText.replace(/\n/g, ' ').slice(0, 220));
const tagChip = page.locator('.ant-tag-checkable', { hasText: '质控' }).first();
await tagChip.click();
await page.waitForTimeout(1800);
ok('按标签筛选命中该条目', (await listCard.innerText()).includes(DOC_TITLE + 'B'), (await listCard.innerText()).slice(0, 160));
await tagChip.click();
await page.waitForTimeout(1200);

console.log('# 上传表单：目录开关与分类');
await page.getByRole('button', { name: /上\s*传\s*文\s*档/ }).first().click();
const uploader = page.locator('.ant-modal', { hasText: '上传文档入库' }).first();
await uploader.waitFor({ state: 'visible', timeout: 8000 });
ok('上传表单默认单文件多选', (await uploader.innerText()).includes('单文件：可以一次多选'), (await uploader.innerText()).replace(/\n/g, ' ').slice(0, 160));
await uploader.locator('.ant-form-item', { hasText: '选择方式' }).locator('.ant-switch').click();
await page.waitForTimeout(600);
ok('切换到整目录模式', (await uploader.innerText()).includes('整个目录'), (await uploader.innerText()).replace(/\n/g, ' ').slice(0, 200));
ok('上传表单有分类与标签', (await uploader.innerText()).includes('分类') && (await uploader.innerText()).includes('标签'));
ok('上传表单提示批量上限', (await uploader.innerText()).includes('50'));
await uploader.getByRole('button', { name: /取\s*消/ }).click();
await page.waitForTimeout(1200);

console.log('# 问答：检索范围与引用分类');
await api('POST', '/api/knowledge/reindex');
await page.waitForTimeout(4000);
await page.locator('.ant-segmented-item', { hasText: '知识问答' }).first().click();
const sender = page.locator('textarea[placeholder="向知识库提问，回车发送"], input[placeholder="向知识库提问，回车发送"]');
await sender.first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
ok('切到问答标签页', (await sender.count()) > 0, await page.locator('.ant-segmented-item-selected').innerText().catch(() => ''));
const askCard = page.locator('.ant-card', { hasText: 'FlashRAG 检索' }).first();
ok('问答面板有检索范围', (await askCard.innerText().catch(() => '')).includes('检索范围'), (await askCard.innerText().catch(() => '')).replace(/\n/g, ' ').slice(0, 160));
await sender.first().fill('STAR 基因组比对需要哪些参数');
await page.keyboard.press('Enter');
await page.waitForTimeout(12000);
const chat = await page.locator('.ant-bubble').allInnerTexts();
ok('问答返回引用', chat.some((t) => /\[1\]/.test(t)), chat.join(' | ').slice(0, 200));
ok('引用标出分类', chat.some((t) => t.includes(CATEGORY)), chat.join(' | ').slice(0, 240));
await page.screenshot({ path: 'shots/kb-ui-ask.png' });

console.log('# 文件管理反向入库');
await page.goto(`${BASE}/files?source=users&dir=${encodeURIComponent(uiPath)}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const more = page.locator('button[aria-label="更多操作"]').first();
ok('文件行有「更多操作」', (await more.count()) > 0);
await more.click();
await page.waitForTimeout(600);
const menu = await page.locator('.ant-dropdown-menu').innerText().catch(() => '');
ok('菜单里有知识库入口', /入库知识库/.test(menu), menu.replace(/\n/g, ' ').slice(0, 160));
await page.locator('.ant-dropdown-menu-item', { hasText: '入库知识库' }).first().click();
await page.locator('.ant-message-notice').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1200);
const backToast = await page.locator('.ant-message').innerText().catch(() => '');
ok('从文件页直接入库成功', /已入库|覆盖|更新/.test(backToast), `${backToast.slice(0, 160)} || ${apiLog.slice(-2).join(' || ')}`);

console.log('# 统一搜索 → 知识库深链');
const deepDoc = (await api('GET', '/api/knowledge?q=' + encodeURIComponent('kb-ui'))).json?.items?.[0] ?? null;
ok('有一个可深链的条目', Boolean(deepDoc?.id), JSON.stringify(deepDoc?.title));
await page.goto(`${BASE}/search?q=${encodeURIComponent('kb-ui')}&scope=local`, { waitUntil: 'domcontentloaded' });
const hit = page.locator(`a[href*="doc=${deepDoc?.id}"]`).first();
const landed = await hit.waitFor({ state: 'visible', timeout: 45000 }).then(() => true).catch(() => false);
ok('搜索结果里出现知识库命中', landed, page.url());
const localText = await page.locator('.ant-card').filter({ has: hit }).first().innerText().catch(() => '');
ok('知识命中落在本地资源栏', /本地资源/.test(localText), localText.replace(/\n/g, ' ').slice(0, 200));
ok('知识命中标出来源引擎', /知识库/.test(localText), localText.replace(/\n/g, ' ').slice(0, 160));
await hit.click();
await page.waitForTimeout(3500);
ok('点击后跳到条目深链', new URL(page.url()).pathname === '/knowledge' && page.url().includes(`doc=${deepDoc?.id}`), page.url());
const detailText = await page.locator('.ant-card', { hasText: '作者' }).first().innerText().catch(() => '');
ok('深链直接打开对应条目', detailText.includes(deepDoc?.title ?? '__none__'), detailText.replace(/\n/g, ' ').slice(0, 200));

await browser.close();

// ---- 收尾：删掉本轮创建的条目 ----
const created = await api('GET', '/api/knowledge?q=' + encodeURIComponent('kb-ui'));
for (const d of created.json?.items ?? []) await api('DELETE', `/api/knowledge/${d.id}`);
const createdB = await api('GET', '/api/knowledge?q=' + encodeURIComponent(DOC_TITLE));
for (const d of createdB.json?.items ?? []) await api('DELETE', `/api/knowledge/${d.id}`);

const real = badApi.filter((s) => !/\/api\/(knowledge\/rag\/status|me|notifications|announcements)/.test(s));
console.log(`\n通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) console.log('失败项：' + fails.join('、'));
if (real.length) console.log('接口/控制台报错：\n  ' + [...new Set(real)].slice(0, 12).join('\n  '));
process.exit(fails.length ? 1 : 0);
