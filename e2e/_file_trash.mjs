// 文件删除进回收站的端到端验证：真实 HTTP + 真实磁盘状态，覆盖删除/恢复/彻底删除/
// 清空/越权/保留期到期/账号硬删除联动。脚本不打印任何凭据。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const CSRF = 'e2e-csrf-token-value';
const LAB = '/srv/lab';
const TRASH = `${LAB}/.trash`;
const MANIFEST = `${TRASH}/trash.json`;
const A = 'e2etrash1';
const B = 'e2etrash2';
const WAIT = 65_000; // 定时扫描周期 60s，等它跑一轮

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${extra ? ' :: ' + extra : ''}`);
  }
};

const py = (code) =>
  execFileSync('docker', ['exec', '-i', 'lab-labspace-backend', 'python', '-c', code], { encoding: 'utf8' }).trim();

const mint = (name) => py(`
import json
from app import accounts
from app.security import issue_session
row = accounts._query('SELECT id, name, display_name, email, groups FROM public."user" WHERE owner=%s AND name=%s', ('built-in', ${JSON.stringify(name)}))[0]
groups = json.loads(row["groups"] or "[]")
print(issue_session({"id": row["id"], "email": row["email"], "name": row["display_name"] or row["name"], "roles": [g if isinstance(g, str) else g.get("name", "") for g in groups]}))
`);

const call = async (method, path, token, body) => {
  const headers = { cookie: `labspace_session=${token}; labspace_csrf=${CSRF}`, origin: BASE };
  if (token) headers['x-csrf-token'] = CSRF;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (process.env.DEBUG_TRASH) console.log('DEBUG →', method, path, JSON.stringify(headers).slice(0, 80), String(payload).slice(0, 120));
  const res = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: res.status, json, text };
};

const listEntries = async (token, source) => {
  const r = await call('GET', `/api/files?source=${source}&sort=name&order=asc`, token);
  return (r.json?.entries ?? []).filter((e) => e.path);
};

const findEntry = async (token, source, path) =>
  (await listEntries(token, source)).find((e) => e.path === path);

const readManifest = () => {
  if (!existsSync(MANIFEST)) return { items: [] };
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
};

const sha = (p) => crypto.createHash('sha256').update(readFileSync(p)).digest('hex');

console.log('# 准备两个一次性账号');
const adminToken = mint('labadmin');
if (process.env.DEBUG_TRASH) {
  const me = await call('GET', '/api/me', adminToken);
  console.log('DEBUG admin /api/me', me.status, me.text.slice(0, 200));
  console.log('DEBUG admin claims', Buffer.from(adminToken.split('.')[1], 'base64').toString('utf8'));
}
for (const name of [A, B]) {
  const gone = await call('DELETE', `/api/admin/accounts/${name}`, adminToken, { confirm: name });
  ok(`预清理 ${name}`, gone.status === 200 || gone.status === 404, `${gone.status} ${gone.text.slice(0, 120)}`);
  const created = await call('POST', '/api/admin/accounts', adminToken, {
    name,
    displayName: `回收站测试账号 ${name.slice(-1)}`,
    email: `${name}@local`,
    groups: ['lab-student'],
    password: `E2e${crypto.randomBytes(6).toString('hex')}aA1`,
  });
  ok(`创建 ${name}`, created.status === 200, `${created.status} ${created.text.slice(0, 160)}`);
  const prov = await call('POST', `/api/admin/accounts/${name}/provision`, adminToken);
  ok(`初始化 ${name} 个人空间`, prov.status === 200, `${prov.status} ${prov.text.slice(0, 160)}`);
}
const ta = mint(A);
const tb = mint(B);

console.log('# 回收站目录位置正确且不进任何文件源');
ok('个人空间目录存在', existsSync(`${LAB}/users/${A}`));
const sourcesSeen = await call('GET', '/api/files/sources', ta);
ok('文件源清单里没有 .trash', !sourcesSeen.text.includes('.trash'), sourcesSeen.text.slice(0, 200));

console.log('# 单个文件：删除 → 回收站 → 恢复');
const form1 = new FormData();
const body1 = `trash-roundtrip-${crypto.randomBytes(4).toString('hex')}\n`;
form1.append('file', new Blob([body1], { type: 'text/plain' }), 'roundtrip.txt');
const up1 = await call('POST', `/api/files/upload?source=users&dir=${A}&overwrite=1`, ta, form1);
ok('上传待删文件', up1.status === 200, `${up1.status} ${up1.text.slice(0, 200)}`);
const diskPath = `${LAB}/users/${A}/roundtrip.txt`;
const hashBefore = sha(diskPath);
const mtimeBefore = Math.floor(statSync(diskPath).mtimeMs / 1000);
const e1 = await findEntry(ta, 'users', `${A}/roundtrip.txt`);
ok('列表里能看到该文件', Boolean(e1?.id));

const del1 = await call('DELETE', `/api/files/${e1.id}`, ta);
ok('删除返回 200', del1.status === 200, `${del1.status} ${del1.text.slice(0, 200)}`);
const trash1 = del1.json?.trash ?? {};
ok('响应带回收站记录（含到期时间）', /^[a-f0-9]{12}$/.test(trash1.id ?? '') && Boolean(trash1.expiresAt), JSON.stringify(trash1));
ok('文件已从个人空间消失', !existsSync(diskPath));
ok('负载落到 .trash 目录', existsSync(`${TRASH}/${trash1.id}`));
const days = Math.round((new Date(trash1.expiresAt).getTime() - Date.now()) / 86_400_000);
ok('保留期 30 天', days >= 29 && days <= 31, String(days));

const page1 = await call('GET', '/api/files/trash', ta);
const items1 = page1.json?.items ?? [];
ok('回收站列出该条', page1.status === 200 && items1.length === 1, `${page1.status} ${page1.text.slice(0, 200)}`);
const row1 = items1[0] ?? {};
ok(
  '记录含原路径/来源/大小/删除人',
  row1.path === `${A}/roundtrip.txt` && row1.sourceLabel === '我的文件' && row1.size === Buffer.byteLength(body1) && row1.deletedBy === A,
  JSON.stringify(row1),
);
ok('记录标记为可恢复', row1.restorable === true);
ok('回收站汇总了占用', page1.json?.totalBytes === Buffer.byteLength(body1) && page1.json?.retentionDays === 30, JSON.stringify({ t: page1.json?.totalBytes, r: page1.json?.retentionDays }));

const pageB = await call('GET', '/api/files/trash', tb);
ok('他人看不到我的回收站', (pageB.json?.items ?? []).length === 0, pageB.text.slice(0, 200));
const cross = await call('POST', '/api/files/trash/restore', tb, { id: trash1.id });
ok('他人无法恢复我的条目（404）', cross.status === 404, `${cross.status} ${cross.text.slice(0, 160)}`);
const crossPurge = await call('DELETE', `/api/files/trash/${trash1.id}`, tb);
ok('他人无法彻底删除我的条目（404）', crossPurge.status === 404, `${crossPurge.status} ${crossPurge.text.slice(0, 160)}`);
ok('越权尝试后负载仍在', existsSync(`${TRASH}/${trash1.id}`));

const noCsrf = await fetch(`${BASE}/api/files/trash/restore`, {
  method: 'POST',
  headers: { cookie: `labspace_session=${ta}`, origin: BASE, 'content-type': 'application/json' },
  body: JSON.stringify({ id: trash1.id }),
});
ok('恢复也要 CSRF（缺头 403）', noCsrf.status === 403, String(noCsrf.status));

const restored = await call('POST', '/api/files/trash/restore', ta, { id: trash1.id });
ok('恢复返回 200', restored.status === 200, `${restored.status} ${restored.text.slice(0, 200)}`);
ok('文件回到原路径', existsSync(diskPath));
ok('内容逐字节一致', sha(diskPath) === hashBefore);
const mtimeAfter = Math.floor(statSync(diskPath).mtimeMs / 1000);
ok('修改时间原样恢复', mtimeAfter === mtimeBefore, `${mtimeBefore} -> ${mtimeAfter}`);
ok('负载已从 .trash 移走', !existsSync(`${TRASH}/${trash1.id}`));
const page2 = await call('GET', '/api/files/trash', ta);
ok('恢复后清单清空', (page2.json?.items ?? []).length === 0, page2.text.slice(0, 200));
ok('恢复后列表可见', Boolean(await findEntry(ta, 'users', `${A}/roundtrip.txt`)));

console.log('# 文件夹：删除 → 恢复；先删子文件再删父目录的合并恢复');
const mkSub = await call('POST', '/api/files/mkdir', ta, { source: 'users', path: `${A}/drop` });
ok('创建子目录', mkSub.status === 200, `${mkSub.status} ${mkSub.text.slice(0, 160)}`);
for (const [name, body] of [['a.txt', 'aaa\n'], ['b.txt', 'bbbbb\n']]) {
  const fd = new FormData();
  fd.append('file', new Blob([body], { type: 'text/plain' }), name);
  const r = await call('POST', `/api/files/upload?source=users&dir=${A}/drop&overwrite=1`, ta, fd);
  ok(`上传 drop/${name}`, r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);
}
const dirEntry = await findEntry(ta, 'users', `${A}/drop`);
const fileA = await findEntry(ta, 'users', `${A}/drop/a.txt`);
ok('目录与子文件都已索引', Boolean(dirEntry?.id && fileA?.id));

const delA = await call('DELETE', `/api/files/${fileA.id}`, ta);
const delD = await call('DELETE', `/api/files/${dirEntry.id}`, ta);
ok('先删子文件再删父目录', delA.status === 200 && delD.status === 200, `${delA.status}/${delD.status}`);
ok('目录整体从磁盘消失', !existsSync(`${LAB}/users/${A}/drop`));
const dirRow = (delD.json?.trash ?? {});
ok('目录记录标注为目录并统计项数', dirRow.dir === true && dirRow.paths >= 2 && dirRow.size === 6, JSON.stringify(dirRow));

const rA = await call('POST', '/api/files/trash/restore', ta, { id: delA.json.trash.id });
ok('父目录已删时仍能恢复子文件', rA.status === 200 && existsSync(`${LAB}/users/${A}/drop/a.txt`), `${rA.status} ${rA.text.slice(0, 160)}`);
const rD = await call('POST', '/api/files/trash/restore', ta, { id: dirRow.id });
ok('再恢复父目录时按内容合并', rD.status === 200 && existsSync(`${LAB}/users/${A}/drop/b.txt`), `${rD.status} ${rD.text.slice(0, 160)}`);
ok('合并后两个文件都在', existsSync(`${LAB}/users/${A}/drop/a.txt`) && existsSync(`${LAB}/users/${A}/drop/b.txt`));
ok('合并后负载清空', !existsSync(`${TRASH}/${dirRow.id}`));
const page3 = await call('GET', '/api/files/trash', ta);
ok('合并后清单清空', (page3.json?.items ?? []).length === 0, page3.text.slice(0, 200));

console.log('# 目标被占用时不覆盖');
const occ = await call('DELETE', `/api/files/${(await findEntry(ta, 'users', `${A}/drop/a.txt`)).id}`, ta);
ok('再次删除 a.txt', occ.status === 200, `${occ.status} ${occ.text.slice(0, 160)}`);
const fd2 = new FormData();
fd2.append('file', new Blob(['replacement\n'], { type: 'text/plain' }), 'a.txt');
await call('POST', `/api/files/upload?source=users&dir=${A}/drop&overwrite=1`, ta, fd2);
const rOcc = await call('POST', '/api/files/trash/restore', ta, { id: occ.json.trash.id });
ok('同名新文件存在时拒绝恢复（409）', rOcc.status === 409, `${rOcc.status} ${rOcc.text.slice(0, 160)}`);
ok('新文件未被旧内容覆盖', readFileSync(`${LAB}/users/${A}/drop/a.txt`, 'utf8') === 'replacement\n');

console.log('# 彻底删除与清空');
const purge = await call('DELETE', `/api/files/trash/${occ.json.trash.id}`, ta);
ok('彻底删除返回 200', purge.status === 200, `${purge.status} ${purge.text.slice(0, 160)}`);
ok('彻底删除释放了字节', (purge.json?.summary?.removed ?? 0) === 1 && purge.json.summary.bytes > 0, JSON.stringify(purge.json?.summary));
ok('负载已不在磁盘', !existsSync(`${TRASH}/${occ.json.trash.id}`));

const fd3 = new FormData();
fd3.append('file', new Blob(['to-empty-1\n'], { type: 'text/plain' }), 'e1.txt');
const up3 = await call('POST', `/api/files/upload?source=users&dir=${A}&overwrite=1`, ta, fd3);
ok('上传待清空文件', up3.status === 200, `${up3.status} ${up3.text.slice(0, 160)}`);
const e3 = await findEntry(ta, 'users', `${A}/e1.txt`);
const del3 = await call('DELETE', `/api/files/${e3.id}`, ta);
ok('移入回收站', del3.status === 200, `${del3.status} ${del3.text.slice(0, 160)}`);
const foreign = del3.json.trash.id;

const formB = new FormData();
formB.append('file', new Blob(['other-account\n'], { type: 'text/plain' }), 'b1.txt');
await call('POST', `/api/files/upload?source=users&dir=${B}&overwrite=1`, tb, formB);
const eB = await findEntry(tb, 'users', `${B}/b1.txt`);
const delB = await call('DELETE', `/api/files/${eB.id}`, tb);
ok('另一账号也有自己的回收站条目', delB.status === 200, `${delB.status} ${delB.text.slice(0, 160)}`);

const emptyByOther = await call('DELETE', '/api/files/trash', tb);
ok(
  '他人清空只动自己的条目',
  emptyByOther.status === 200 &&
    (emptyByOther.json?.summary?.removed ?? -1) === 1 &&
    (emptyByOther.json?.summary?.skipped ?? -1) === 1 &&
    existsSync(`${TRASH}/${foreign}`),
  JSON.stringify(emptyByOther.json),
);
const emptyOwn = await call('DELETE', '/api/files/trash', ta);
ok('自己清空生效', emptyOwn.status === 200 && (emptyOwn.json?.summary?.removed ?? 0) === 1, JSON.stringify(emptyOwn.json));
ok('清空后负载消失', !existsSync(`${TRASH}/${foreign}`));
const noSuch = await call('DELETE', '/api/files/trash/deadbeef000000', ta);
ok('未知回收站 id 返回 404', noSuch.status === 404, `${noSuch.status} ${noSuch.text.slice(0, 120)}`);
const badId = await call('POST', '/api/files/trash/restore', ta, { id: '../../../../etc/passwd' });
ok('伪造 id 不能逃出回收站目录', badId.status === 404 || badId.status === 400, `${badId.status} ${badId.text.slice(0, 120)}`);
ok('/etc/passwd 未被移动', existsSync('/etc/passwd'));

console.log('# 保留期到期后自动清除（等一轮定时扫描）');
const fd4 = new FormData();
fd4.append('file', new Blob(['expire-me-please\n'], { type: 'text/plain' }), 'expiring.txt');
await call('POST', `/api/files/upload?source=users&dir=${A}&overwrite=1`, ta, fd4);
const e4 = await findEntry(ta, 'users', `${A}/expiring.txt`);
const del4 = await call('DELETE', `/api/files/${e4.id}`, ta);
const expiringId = del4.json?.trash?.id ?? '';
ok('制造一条待过期条目', del4.status === 200 && Boolean(expiringId), `${del4.status} ${del4.text.slice(0, 160)}`);
{
  const doc = readManifest();
  let touched = false;
  for (const it of doc.items) {
    if (it.id === expiringId) {
      it.expiresAt = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
      touched = true;
    }
  }
  ok('条目已写入过期时间', touched);
  writeFileSync(MANIFEST, `${JSON.stringify(doc, null, '  ')}\n`, { mode: 0o600 });
}
console.log(`  …等待定时清理（${WAIT / 1000}s）`);
await new Promise((r) => setTimeout(r, WAIT));
const afterSweep = await call('GET', '/api/files/trash', ta);
ok('过期条目自动移出清单', (afterSweep.json?.items ?? []).every((it) => it.id !== expiringId), JSON.stringify(afterSweep.json?.items));
ok('过期负载自动删除', !existsSync(`${TRASH}/${expiringId}`));

console.log('# 账号硬删除会清掉个人回收站');
const fd5 = new FormData();
fd5.append('file', new Blob(['ghost-file-content\n'], { type: 'text/plain' }), 'ghost.txt');
await call('POST', `/api/files/upload?source=users&dir=${A}&overwrite=1`, ta, fd5);
const e5 = await findEntry(ta, 'users', `${A}/ghost.txt`);
const del5 = await call('DELETE', `/api/files/${e5.id}`, ta);
const ghostId = del5.json?.trash?.id ?? '';
ok('删除个人文件制造残留', del5.status === 200 && Boolean(ghostId), `${del5.status} ${del5.text.slice(0, 160)}`);
ok('回收站里确实有负载', existsSync(`${TRASH}/${ghostId}`));
const killA = await call('DELETE', `/api/admin/accounts/${A}`, adminToken, { confirm: A });
ok('硬删除账号成功', killA.status === 200, `${killA.status} ${killA.text.slice(0, 200)}`);
ok('账号回收站负载被清除', !existsSync(`${TRASH}/${ghostId}`));
const docAfter = readManifest();
ok(
  '清单里不再有该账号的记录',
  !JSON.stringify(docAfter).includes(ghostId) && !docAfter.items.some((it) => it.source === 'users' && it.path.split('/')[0] === A),
  JSON.stringify(docAfter.items.map((i) => i.path)),
);

console.log('# 收尾核查');
const killB = await call('DELETE', `/api/admin/accounts/${B}`, adminToken, { confirm: B });
ok('删除第二个测试账号', killB.status === 200, `${killB.status} ${killB.text.slice(0, 160)}`);
const finalDoc = readManifest();
ok('测试账号没有在回收站留下记录', finalDoc.items.every((it) => !it.path.startsWith(`${A}/`) && !it.path.startsWith(`${B}/`)), JSON.stringify(finalDoc.items));
ok('回收站目录对其他账号不可读', (statSync(TRASH).mode & 0o077) === 0, (statSync(TRASH).mode & 0o777).toString(8));
const realUsers = execFileSync('ls', [`${LAB}/users`], { encoding: 'utf8' }).trim().split('\n');
ok('真实账号目录未被波及', realUsers.includes('labadmin') && !realUsers.includes(A) && !realUsers.includes(B), realUsers.join(','));

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log(`失败项：${fails.join(' | ')}`);
  process.exitCode = 1;
}
