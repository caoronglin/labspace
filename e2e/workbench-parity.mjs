// 对照：Python 工作台 API（/api/workbench/*）与 Go 核心（/api/next/v1/workbench/*）
// 同一用户、同一数据库，检查条数与字段形状是否一致。
import { loginContext, launch } from './_auth.mjs';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const browser = await launch();
const ctx = await loginContext(browser, BASE);
const page = await ctx.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

async function get(path) {
  const res = await page.evaluate(async (p) => {
    const r = await fetch(new URL(p, location.origin).toString(), { credentials: 'include' });
    return { status: r.status, body: await r.text() };
  }, path);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* 文本 */ }
  return { status: res.status, json, raw: res.body };
}

console.log('== 工作台：Python 与 Go 对照 ==');
const pyItems = await get('/api/workbench/items');
const goItems = await get('/api/next/v1/workbench/items');
ok('Python /api/workbench/items 200', pyItems.status === 200, `status=${pyItems.status}`);
ok('Go /api/next/v1/workbench/items 200', goItems.status === 200, `status=${goItems.status} raw=${goItems.raw.slice(0, 160)}`);

const pyList = Array.isArray(pyItems.json?.items) ? pyItems.json.items
  : Array.isArray(pyItems.json) ? pyItems.json : [];
const goList = Array.isArray(goItems.json?.items) ? goItems.json.items
  : Array.isArray(goItems.json) ? goItems.json : [];
console.log(`  python 条数=${pyList.length}，go 条数=${goList.length}`);
ok('两侧条数一致', pyList.length === goList.length, `python=${pyList.length} go=${goList.length}`);

if (pyList.length && goList.length) {
  const pyKeys = Object.keys(pyList[0]).sort();
  const goKeys = Object.keys(goList[0]).sort();
  ok('条目字段集合一致', JSON.stringify(pyKeys) === JSON.stringify(goKeys),
    `py=${pyKeys.join(',')} | go=${goKeys.join(',')}`);
  const pyId = pyList[0].id, goId = goList[0].id;
  ok('首条 id 一致', String(pyId) === String(goId), `py=${pyId} go=${goId}`);
}

// 写入一条（Python 侧创建），再从两侧读取，确认 Go 读到同一批数据
const csrf = await page.evaluate(() => document.cookie.split('; ').find(c => c.startsWith('labspace_csrf='))?.split('=')[1] || '');
const created = await page.evaluate(async ({ csrf }) => {
  const r = await fetch(new URL('/api/workbench/items', location.origin).toString(), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ kind: 'note', title: 'parity-probe-007', content: 'go-python parity', status: 'active' }),
  });
  return { status: r.status, body: await r.text() };
}, { csrf });
console.log(`  创建条目 status=${created.status} ${created.body.slice(0, 160)}`);
let createdId = null;
try { const j = JSON.parse(created.body); createdId = j?.item?.id ?? j?.id ?? null; } catch { /* 忽略 */ }

if (createdId) {
  const pyAfter = await get('/api/workbench/items');
  const goAfter = await get('/api/next/v1/workbench/items');
  const pyHas = JSON.stringify(pyAfter.json).includes('parity-probe-007');
  const goHas = JSON.stringify(goAfter.json).includes('parity-probe-007');
  ok('Python 列表包含新建条目', pyHas);
  ok('Go 列表包含同一条目（同一批数据）', goHas);
  const pyItem = (pyAfter.json.items || pyAfter.json).find?.(i => i.id === createdId) || null;
  const goItem = (goAfter.json.items || goAfter.json).find?.(i => i.id === createdId) || null;
  if (pyItem && goItem) {
    const pyKeys = Object.keys(pyItem).sort();
    const goKeys = Object.keys(goItem).sort();
    ok('条目字段集合一致', JSON.stringify(pyKeys) === JSON.stringify(goKeys),
      `py=${pyKeys.length}个 go=${goKeys.length}个 差异=${pyKeys.filter(k => !goKeys.includes(k)).join(',')||'无'}`);
    ok('时间戳格式一致（ISO-8601）', pyItem.created_at === goItem.created_at,
      `py=${pyItem.created_at} go=${goItem.created_at}`);
    ok('可空字段一致', JSON.stringify(pyItem.project_id) === JSON.stringify(goItem.project_id)
      && JSON.stringify(pyItem.due_date) === JSON.stringify(goItem.due_date),
      `py.project_id=${JSON.stringify(pyItem.project_id)} go.project_id=${JSON.stringify(goItem.project_id)}`);
  } else {
    ok('取到两侧同一条目用于形状比对', false, '未取到');
  }
}

// 清理：删除刚建的条目
if (createdId) {
  const del = await page.evaluate(async ({ csrf, id }) => {
    const r = await fetch(new URL(`/api/workbench/items/${id}`, location.origin).toString(), {
      method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': csrf },
    });
    return { status: r.status, body: (await r.text()).slice(0, 120) };
  }, { csrf, id: createdId });
  ok('清理测试条目', del.status === 200 || del.status === 204, `status=${del.status} ${del.body}`);
}

// 只读端点对照
for (const [p, g] of [['/api/workbench/summary', '/api/next/v1/workbench/summary'],
                      ['/api/workbench/projects', '/api/next/v1/workbench/projects'],
                      ['/api/workbench/plans', '/api/next/v1/workbench/plans']]) {
  const a = await get(p); const b = await get(g);
  ok(`只读端点 ${p} → ${g}`, a.status === 200 && b.status === 200, `py=${a.status} go=${b.status}`);
}

// 服务令牌必须被拒（工作台是按用户隔离的状态）
const svc = await page.evaluate(async () => {
  const r = await fetch('/api/next/v1/workbench/items', {
    credentials: 'include',
    headers: { 'X-Lab-Service-Token': 'not-a-real-token' },
  });
  return { status: r.status, body: (await r.text()).slice(0, 120) };
});
ok('伪造服务令牌被拒', svc.status === 401 || svc.status === 403, `status=${svc.status} ${svc.body}`);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
await browser.close();
process.exit(fail ? 1 : 0);
