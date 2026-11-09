// 账号硬删除 + 会话吊销 的端到端验证（全部走真实 HTTP，不经浏览器）。
// 会话令牌用后端自身的签发函数现场生成；脚本不打印任何凭据。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const BASE = 'http://192.0.2.10';
const CSRF = 'e2e-csrf-token-value';
const ACL = '/etc/lab-go/acl/labgo-acl.json';
const WAIT = 17_000; // 两侧吊销缓存 TTL 都是 15s，等它过期

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name} ${extra}`); }
};

const py = (code) => execFileSync('docker', ['exec', '-i', 'lab-labspace-backend', 'python', '-c', code], { encoding: 'utf8' }).trim();

// 用后端自己的 issue_session 生成会话（等价于浏览器登录后的 Cookie）。
const mint = (name) => py(`
import json
from app import accounts
from app.security import issue_session
row = accounts._query('SELECT id, name, display_name, email, groups FROM public."user" WHERE owner=%s AND name=%s', ('built-in', ${JSON.stringify(name)}))[0]
groups = json.loads(row["groups"] or "[]")
print(issue_session({"id": row["id"], "email": row["email"], "name": row["display_name"] or row["name"], "roles": [g if isinstance(g, str) else g.get("name", "") for g in groups]}))
`);

const one = (mod, sql) => py(`
import ${mod === 'db' ? 'app.db as m' : 'app.accounts as m'}
rows = m.${mod === 'db' ? 'query' : '_query'}(${sql})
first = rows[0] if rows else None
print('' if first is None else first[list(first.keys())[0]])
`);

const call = async (method, path, token, body) => {
  const headers = { cookie: `labspace_session=${token}; labspace_csrf=${CSRF}`, origin: BASE, 'x-csrf-token': CSRF };
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: res.status, json, text };
};

const NAME = 'acctdel1';
const NAME2 = 'acctdis1';
const adminToken = mint('labadmin');

console.log('# 预清理上一轮残留');
for (const name of [NAME, NAME2]) {
  const r = await call('DELETE', `/api/admin/accounts/${name}`, adminToken, { confirm: name });
  ok(`预清理 ${name}`, r.status === 200 || r.status === 404, `${r.status} ${r.text.slice(0, 160)}`);
}

console.log('# 准备两个一次性账号');
for (const [name, label] of [[NAME, '硬删除'], [NAME2, '禁用']]) {
  const r = await call('POST', '/api/admin/accounts', adminToken, {
    name,
    displayName: `${label}测试账号`,
    email: `${name}@local`,
    groups: ['lab-student'],
    password: `E2e${Math.random().toString(36).slice(2, 10)}aA1`,
  });
  ok(`创建 ${name}`, r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
}
const t1 = mint(NAME);
const t2 = mint(NAME2);
const sub1 = one('casdoor', `'SELECT id FROM public."user" WHERE owner=%s AND name=%s', ('built-in', '${NAME}')`);

console.log('# 制造真实数据');
const form = new FormData();
form.append('file', new Blob(['ATGCACGT\n'], { type: 'text/plain' }), 'e2e-delete-me.txt');
const up = await call('POST', `/api/files/upload?source=users&dir=${NAME}&overwrite=1`, t1, form);
ok('上传个人文件', up.status === 200, `${up.status} ${up.text.slice(0, 200)}`);
const wb = await call('POST', '/api/workbench/items', t1, { kind: 'task', title: '待清理的任务' });
ok('创建工作台条目', wb.status === 200 || wb.status === 201, `${wb.status} ${wb.text.slice(0, 200)}`);
const services = await call('GET', '/api/services', adminToken);
const sid = (services.json?.services ?? services.json ?? []).map?.((s) => s.id).find(Boolean) ?? 'search';
const fav = await call('POST', `/api/favorites/${sid}`, t1);
ok('添加收藏', fav.status === 200, `${fav.status} ${fav.text.slice(0, 200)}`);

const home = `/srv/lab/users/${NAME}`;
ok('个人目录已生成', existsSync(home));
ok('个人文件已落盘', existsSync(`${home}/e2e-delete-me.txt`));
ok('ACL 里有该账号', readFileSync(ACL, 'utf8').includes(NAME));
const cellCount = () => py(`
from app import db
p = ${JSON.stringify(sub1)}
print('wb=%s fav=%s ag=%s' % (
  db.query('SELECT count(*) AS n FROM labspace.workbench_items WHERE user_id=%s', (p,))[0]['n'],
  db.query('SELECT count(*) AS n FROM labspace.favorites WHERE user_id=%s', (p,))[0]['n'],
  db.query('SELECT count(*) AS n FROM labspace.agent_sessions WHERE user_id=%s', (p,))[0]['n'],
))
`);
console.log(`  删除前：${cellCount()}`);

console.log('# 误删护栏');
const wrong = await call('DELETE', `/api/admin/accounts/${NAME}`, adminToken, { confirm: 'not-the-name' });
ok('确认词不匹配被拒（400）', wrong.status === 400, `${wrong.status} ${wrong.text.slice(0, 160)}`);
const self = await call('DELETE', '/api/admin/accounts/labadmin', adminToken, { confirm: 'labadmin' });
ok('不能删除当前登录账号（400）', self.status === 400, `${self.status} ${self.text.slice(0, 160)}`);
const ghost = await call('DELETE', '/api/admin/accounts/e2e-no-such-user', adminToken, { confirm: 'e2e-no-such-user' });
ok('不存在的账号 404', ghost.status === 404, `${ghost.status}`);
const bare = await fetch(`${BASE}/api/admin/accounts/${NAME}`, {
  method: 'DELETE',
  headers: { cookie: `labspace_session=${adminToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ confirm: NAME }),
});
ok('缺少 CSRF 头被拒（403）', bare.status === 403, `${bare.status}`);
ok('护栏没有动数据', existsSync(home));

console.log('# 执行硬删除');
const del = await call('DELETE', `/api/admin/accounts/${NAME}`, adminToken, { confirm: NAME });
ok('删除返回 200', del.status === 200, `${del.status} ${del.text.slice(0, 260)}`);
console.log(`  purged=${JSON.stringify(del.json?.purged)} files=${JSON.stringify(del.json?.files)}`);
ok('文件核心汇报删除了 1 个路径', del.json?.files?.removedPaths === 1, JSON.stringify(del.json?.files));

console.log('# 删除后的真实状态');
ok('个人目录已消失', !existsSync(home));
ok('个人文件已消失', !existsSync(`${home}/e2e-delete-me.txt`));
const aclAfter = readFileSync(ACL, 'utf8');
ok('ACL 已无该账号（名字与邮箱两种键）', !aclAfter.includes(`${NAME}"`) && !aclAfter.includes(`${NAME}@`));
ok('Casdoor 账号行已删除', one('casdoor', `'SELECT name FROM public."user" WHERE owner=%s AND name=%s', ('built-in', '${NAME}')`) === '');
ok('Casdoor 会话行已清理', one('casdoor', `'SELECT name FROM public."session" WHERE owner=%s AND name=%s', ('built-in', '${NAME}')`) === '');
const after = cellCount();
ok('工作台/收藏/Agent 行已清空', after === 'wb=0 fav=0 ag=0', after);
ok('其他账号的 ACL 未被牵连', aclAfter.includes('student01'), 'ACL 里连 student01 都没了');
const audit = one('db', `'SELECT action FROM labspace.account_audit WHERE target=%s ORDER BY id DESC LIMIT 1', ('${NAME}',)`);
ok('删除已写入审计', audit === 'delete', `审计=「${audit}」`);

console.log(`# 等两侧吊销缓存过期（${WAIT / 1000}s）`);
await new Promise((r) => setTimeout(r, WAIT));

// /api/me 用的是可选登录依赖，被吊销的会话会返回 200 + authenticated:false；
// 因此 401 要从必须登录的接口上验，Go 侧单独验文件核心。
const deadSession = async (label, token) => {
  const me = await call('GET', '/api/me', token);
  const fav = await call('GET', '/api/favorites', token);
  const go = await call('GET', '/api/files/sources', token);
  ok(`${label}：门户不再认出该会话`, me.status === 200 && me.json?.authenticated === false, `${me.status} ${me.text.slice(0, 120)}`);
  ok(`${label}：门户需登录接口 401`, fav.status === 401, `${fav.status} ${fav.text.slice(0, 120)}`);
  ok(`${label}：Go 文件核心 401`, go.status === 401, `${go.status} ${go.text.slice(0, 120)}`);
};

await deadSession('被删账号的旧会话', t1);

console.log('# 禁用同样立即吊销会话');
const live = await call('GET', '/api/me', t2);
ok('禁用前会话可用', live.status === 200 && live.json?.authenticated === true, `${live.status}`);
const disable = await call('PATCH', `/api/admin/accounts/${NAME2}`, adminToken, { isForbidden: true });
ok('禁用成功', disable.status === 200, `${disable.status} ${disable.text.slice(0, 160)}`);
await new Promise((r) => setTimeout(r, WAIT));
await deadSession('被禁用账号的旧会话', t2);

const cleanup = await call('DELETE', `/api/admin/accounts/${NAME2}`, adminToken, { confirm: NAME2 });
ok('清理第二个测试账号', cleanup.status === 200, `${cleanup.status} ${cleanup.text.slice(0, 200)}`);
await new Promise((r) => setTimeout(r, WAIT));
await deadSession('被删账号的旧会话（第二轮）', t2);
ok('两个测试账号都没留下目录', !existsSync('/srv/lab/users/acctdel1') && !existsSync('/srv/lab/users/acctdis1'));

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项${fails.length ? '：' + fails.join('；') : ''}`);
if (fails.length) process.exitCode = 1;
