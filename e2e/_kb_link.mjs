// 知识库分类 / 批量入库 / 个人空间联动的端到端验证。
// 覆盖：分类与标签面额、目录批量上传、从文件管理入库与重复覆盖、可见范围、
// RAG 索引真实产出、检索 ACL 与回链字段。脚本不打印任何凭据。
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const CSRF = 'e2e-csrf-token-value';
const A = 'e2ekb1';
const B = 'e2ekb2';

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

const listFiles = async (token, source) => {
  const r = await call('GET', `/api/files?source=${source}&sort=name&order=asc`, token);
  return (r.json?.entries ?? []).filter((e) => e.path);
};
const findFile = async (token, source, path) => (await listFiles(token, source)).find((e) => e.path === path);
const listDocs = async (token, query = '') => {
  const r = await call('GET', `/api/knowledge?limit=200${query}`, token);
  return r.json?.items ?? [];
};

console.log('# 准备两个一次性账号');
const adminToken = mint('labadmin');
for (const name of [A, B]) {
  const gone = await call('DELETE', `/api/admin/accounts/${name}`, adminToken, { confirm: name });
  ok(`预清理 ${name}`, gone.status === 200 || gone.status === 404, `${gone.status} ${gone.text.slice(0, 120)}`);
  const created = await call('POST', '/api/admin/accounts', adminToken, {
    name,
    displayName: `知识库联动账号 ${name.slice(-1)}`,
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
for (const [label, token] of [['A', ta], ['B', tb]]) {
  const left = await listDocs(token);
  ok(`${label} 账号知识库起点为空`, left.length === 0, `${left.length} 条：${left.map((i) => i.title).join(',')}`);
}

console.log('# 个人空间里放三类文件：Markdown、纯文本、不可抽取的二进制');
const mkNotes = await call('POST', '/api/files/mkdir', ta, { source: 'users', path: `${A}/notes` });
ok('创建 notes 子目录', mkNotes.status === 200, `${mkNotes.status} ${mkNotes.text.slice(0, 160)}`);
const mdBody = '# fastp 使用笔记\n\nfastp 是质控工具，使用 fastp -i read1.fq.gz -I read2.fq.gz -o out1.fq.gz -O out2.fq.gz -h report.html。\n';
const txtBody = '玉米基因组比对流程：hisat2 建索引，hisat2 -x maize -1 r1.fq -2 r2.fq | samtools sort。\n';
const binBody = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe, 0x00, 0x01]);
for (const [name, body] of [
  ['fastp-note.md', mdBody],
  ['align-flow.txt', txtBody],
  ['raw.bin', binBody],
]) {
  const form = new FormData();
  form.append('file', new Blob([body], { type: 'application/octet-stream' }), name);
  const up = await call('POST', `/api/files/upload?source=users&dir=${A}/notes&overwrite=1`, ta, form);
  ok(`上传 notes/${name}`, up.status === 200, `${up.status} ${up.text.slice(0, 160)}`);
}
const mdEntry = await findFile(ta, 'users', `${A}/notes/fastp-note.md`);
const txtEntry = await findFile(ta, 'users', `${A}/notes/align-flow.txt`);
const binEntry = await findFile(ta, 'users', `${A}/notes/raw.bin`);
ok('三个文件都已索引', Boolean(mdEntry?.id && txtEntry?.id && binEntry?.id));

console.log('# 手写条目 + 分类');
const manual = await call('POST', '/api/knowledge', ta, {
  title: '实验室安全守则',
  body: '进入细胞房必须换鞋并登记，废弃枪头投入含消毒液的废液缸。',
  tags: ['安全', '制度'],
  category: '实验室制度',
  visibility: 'private',
});
ok(
  '创建带分类的手写条目',
  manual.status === 200 && manual.json?.item?.category === '实验室制度',
  `${manual.status} ${manual.text.slice(0, 200)}`,
);
const noCategory = await call('POST', '/api/knowledge', ta, {
  title: '临时草稿',
  body: '尚未归档的会议记录草稿。',
  visibility: 'private',
});
ok('不填分类即为未分类', noCategory.status === 200 && noCategory.json?.item?.category === '', `${noCategory.status} ${noCategory.text.slice(0, 160)}`);

const facet0 = await call('GET', '/api/knowledge/categories', ta);
const cats0 = facet0.json?.categories ?? [];
ok(
  '分类面额统计到自建分类与未分类',
  facet0.status === 200
    && cats0.some((c) => c.name === '实验室制度' && c.docs === 1)
    && cats0.some((c) => c.name === '' && c.label === '未分类' && c.docs === 1),
  JSON.stringify(cats0),
);
ok('标签面额可用', (facet0.json?.tags ?? []).some((t) => t.name === '安全' && t.docs === 1), JSON.stringify(facet0.json?.tags));

console.log('# 从文件管理入库');
const fromFiles = await call('POST', '/api/knowledge/from-files', ta, {
  items: [
    { id: mdEntry.id, source: 'users', path: mdEntry.path },
    { id: txtEntry.id, source: 'users', path: txtEntry.path },
    { id: binEntry.id, source: 'users', path: binEntry.path },
  ],
  category: '生信流程',
  tags: ['质控'],
  visibility: 'private',
});
const ff = fromFiles.json ?? {};
const ffResults = ff.results ?? [];
ok('批量入库返回 200', fromFiles.status === 200, `${fromFiles.status} ${fromFiles.text.slice(0, 200)}`);
ok('两个文本文件入库', ff.summary?.created === 2, JSON.stringify(ff.summary));
ok(
  '二进制被跳过并给出原因',
  ff.summary?.skipped === 1 && (ffResults.find((r) => !r.ok)?.reason ?? '').length > 0,
  JSON.stringify(ffResults.find((r) => !r.ok)),
);
const linked = ffResults.find((r) => (r.filePath ?? '').endsWith('fastp-note.md'));
ok('入库结果带回源与路径', linked?.fileSource === 'users' && (linked?.path ?? '').startsWith(`${A}/notes/`), JSON.stringify(linked));
ok('入库条目记录抽取器与字数', Boolean(linked?.extractor) && linked.chars > 20, `${linked?.extractor} / ${linked?.chars}`);

const docsByCategory = await listDocs(ta, '&category=' + encodeURIComponent('生信流程'));
ok('按分类筛选命中两条', docsByCategory.length === 2, docsByCategory.map((d) => d.title).join(','));
ok(
  '条目带文件回链字段',
  docsByCategory.every((d) => d.fileSource === 'users' && (d.filePath ?? '').includes('/notes/')),
  JSON.stringify(docsByCategory.map((d) => d.filePath)),
);
const fastpDoc = docsByCategory.find((d) => (d.filePath ?? '').endsWith('fastp-note.md'));
const full = await call('GET', `/api/knowledge/${fastpDoc.id}`, ta);
ok('详情正文完整', full.status === 200 && (full.json?.item?.body ?? '').includes('fastp'), `${full.status} ${(full.json?.item?.body ?? '').slice(0, 60)}`);
const byTag = await listDocs(ta, '&tag=' + encodeURIComponent('质控'));
ok('按标签筛选命中两条', byTag.length === 2, byTag.map((d) => d.title).join(','));

console.log('# 重复入库覆盖而不是堆条目');
const again = await call('POST', '/api/knowledge/from-files', ta, {
  items: [{ id: mdEntry.id, source: 'users', path: mdEntry.path }],
  category: '工具手册',
  tags: [],
  visibility: 'private',
});
ok('重复入库标记为更新', again.json?.summary?.updated === 1 && again.json?.summary?.created === 0, JSON.stringify(again.json?.summary));
const docsNow = await listDocs(ta);
ok('条目总数没有增加', docsNow.length === 4, `${docsNow.length}：${docsNow.map((d) => d.title).join(',')}`);
const mdDocId = again.json?.results?.[0]?.docId;
const cleared = (await call('GET', `/api/knowledge/${mdDocId}`, ta)).json?.item ?? {};
ok('显式提交空标签即清空、分类改为新值', (cleared.tags ?? []).length === 0 && cleared.category === '工具手册', JSON.stringify({ tags: cleared.tags, category: cleared.category }));
// 文件管理里的"一键重新入库"只更新正文：不带元数据字段时，原有分类和标签必须留着
const keepMe = await call('POST', '/api/knowledge/from-files', ta, {
  items: [{ id: mdEntry.id, source: 'users', path: mdEntry.path }],
});
const kept = (await call('GET', `/api/knowledge/${keepMe.json?.results?.[0]?.docId}`, ta)).json?.item ?? {};
ok('省略元数据时保留分类', kept.category === '工具手册', JSON.stringify({ category: kept.category, status: keepMe.json?.summary }));
const reTag = await call('POST', '/api/knowledge/from-files', ta, {
  items: [{ id: mdEntry.id, source: 'users', path: mdEntry.path }],
  tags: ['质控'],
  category: '生信流程',
});
const reTagged = (await call('GET', `/api/knowledge/${reTag.json?.results?.[0]?.docId}`, ta)).json?.item ?? {};
ok('重新打标并归回原分类', (reTagged.tags ?? []).includes('质控') && reTagged.category === '生信流程', JSON.stringify({ tags: reTagged.tags, category: reTagged.category }));

console.log('# 越权入库必须被文件权限拦住');
const foreign = await call('POST', '/api/knowledge/from-files', tb, {
  items: [{ id: mdEntry.id, source: 'users', path: mdEntry.path }],
  category: '偷来的',
});
ok('他人文件入库被拒', foreign.status === 200 && foreign.json?.summary?.created === 0 && foreign.json?.summary?.skipped === 1, JSON.stringify(foreign.json?.summary));
ok('拒绝理由来自文件核心', /不存在|无权|权限/.test(foreign.json?.results?.[0]?.reason ?? ''), JSON.stringify(foreign.json?.results));
const bDocs = await listDocs(tb);
ok('B 账号没有因此多出条目', bDocs.length === 0, bDocs.map((d) => d.title).join(','));
const csrfMissing = await fetch(`${BASE}/api/knowledge/from-files`, {
  method: 'POST',
  headers: { cookie: `labspace_session=${ta}; labspace_csrf=${CSRF}`, origin: BASE, 'content-type': 'application/json' },
  body: JSON.stringify({ items: [{ id: txtEntry.id, source: 'users', path: txtEntry.path }] }),
});
ok('入库同样要 CSRF', csrfMissing.status === 403, `${csrfMissing.status}`);

console.log('# 目录批量上传');
const uploadBatch = new FormData();
const relPaths = [
  ['protocols/fastp.md', '# fastp 参数说明\n\n--qualified_quality_phred 设定质量阈值，--unpaired1 处理单端数据。\n'],
  ['protocols/hisat2.md', '# hisat2 比对\n\nhisat2-build 构建索引，hisat2 -p 8 多线程比对到参考基因组。\n'],
  ['protocols/star.md', '# STAR 比对\n\nSTAR --runThreadN 16 --genomeDir index --readFilesIn r1.fq r2.fq 输出比对结果。\n'],
];
for (const [path, body] of relPaths) {
  uploadBatch.append('files', new Blob([body], { type: 'text/markdown' }), path.split('/').pop());
}
uploadBatch.append('paths', JSON.stringify(relPaths.map((p) => p[0])));
uploadBatch.append('category', '工具手册');
uploadBatch.append('tags', JSON.stringify(['上传']));
uploadBatch.append('visibility', 'private');
const ingested = await call('POST', '/api/knowledge/ingest', ta, uploadBatch);
const ing = ingested.json ?? {};
ok('一次请求入库多个文件', ingested.status === 200 && ing.summary?.created === 3, `${ingested.status} ${JSON.stringify(ing.summary ?? ingested.text?.slice(0, 200))}`);
ok('上传结果保留目录相对路径', (ing.results ?? []).some((r) => r.name === 'protocols/fastp.md'), JSON.stringify((ing.results ?? []).map((r) => r.name)));
const byCategory = await listDocs(ta, '&category=' + encodeURIComponent('工具手册'));
ok('上传条目落在同一分类下', byCategory.length === 3, byCategory.map((d) => d.title).join(','));

console.log('# 可见范围');
const sharedDoc = fastpDoc;
const madePublic = await call('PATCH', `/api/knowledge/${sharedDoc.id}`, ta, { visibility: 'public', category: '生信流程' });
ok('改为公共可见', madePublic.status === 200 && madePublic.json?.item?.visibility === 'public', `${madePublic.status} ${madePublic.text.slice(0, 160)}`);
const bSees = await listDocs(tb);
ok('他人只看到公共条目', bSees.length === 1 && bSees[0].id === sharedDoc.id, bSees.map((d) => d.title).join(','));
ok('公共条目对他人也带分类', bSees[0]?.category === '生信流程', bSees[0]?.category);
const aAll = await listDocs(ta);
ok('本人仍看到全部条目', aAll.length === 7, `${aAll.length}：${aAll.map((d) => d.title).join(',')}`);
const uncategorized = await listDocs(ta, '&category=' + encodeURIComponent('未分类'));
ok('未分类可单独筛', uncategorized.length === 1 && uncategorized[0].title === '临时草稿', uncategorized.map((d) => d.title).join(','));

console.log('# RAG 索引真实产出');
let rag = {};
for (let i = 0; i < 40; i += 1) {
  const st = await call('GET', '/api/knowledge/rag/status', ta);
  rag = st.json ?? {};
  if ((rag.documents ?? 0) >= 7) break;
  await new Promise((r) => setTimeout(r, 3000));
}
ok('索引文档数与库内条目一致', (rag.documents ?? 0) >= 7, JSON.stringify(rag));
ok('索引产生了片段', (rag.chunks ?? 0) > 0, `chunks=${rag.chunks}`);
ok('分类进入索引', (rag.categories ?? 0) >= 3, `categories=${rag.categories}`);

const askHit = await call('POST', '/api/knowledge/ask', ta, { query: 'fastp 怎么做质控', topK: 5 });
const hits = askHit.json?.citations ?? [];
ok('问答检索命中片段', askHit.status === 200 && hits.length > 0, `${askHit.status} mode=${askHit.json?.mode} ${hits.length}`);
ok('命中片段来自知识库', hits.every((h) => h.docId > 0), JSON.stringify(hits.slice(0, 2).map((h) => ({ t: h.title, c: h.category }))));
const fileHit = hits.find((h) => (h.filePath ?? '').includes('fastp-note'));
ok('引用可回链到原始文件', Boolean(fileHit) && fileHit.fileSource === 'users', JSON.stringify(fileHit ?? hits[0]));

const askScoped = await call('POST', '/api/knowledge/ask', ta, { query: 'hisat2 多线程比对', topK: 5, category: '工具手册' });
const scopedHits = askScoped.json?.citations ?? [];
ok('限定分类后只返回该分类', scopedHits.length > 0 && scopedHits.every((h) => h.category === '工具手册'), JSON.stringify(scopedHits.map((h) => h.category)));
const askOther = await call('POST', '/api/knowledge/ask', ta, { query: 'hisat2 多线程比对', topK: 5, category: '实验室制度' });
ok('换分类后不串档', !(askOther.json?.citations ?? []).some((h) => h.category === '工具手册'), JSON.stringify((askOther.json?.citations ?? []).map((h) => h.category)));

const secretDocId = Number(manual.json?.item?.id ?? -1);
const askPrivate = await call('POST', '/api/knowledge/ask', tb, { query: '细胞房 换鞋 登记 废液缸', topK: 6 });
const bHits = askPrivate.json?.citations ?? [];
ok('他人检索不到我的私有条目', !bHits.some((h) => Number(h.docId) === secretDocId), JSON.stringify(bHits.map((h) => h.docId)));
const askPublic = await call('POST', '/api/knowledge/ask', tb, { query: 'fastp 质控 report.html', topK: 6 });
ok('他人能检索到公共条目', (askPublic.json?.citations ?? []).some((h) => Number(h.docId) === Number(sharedDoc.id)), JSON.stringify((askPublic.json?.citations ?? []).map((h) => h.docId)));

console.log('# 统一搜索联动（按调用者 ACL 合并知识命中）');
const search = async (token, q, scope) => {
  const r = await call('GET', `/api/search?q=${encodeURIComponent(q)}&scope=${scope}`, token);
  return { status: r.status, j: r.json ?? {}, hits: (r.json?.results ?? []).filter((x) => x.category === 'knowledge') };
};
const own = await search(ta, 'fastp', 'local');
ok('本人搜索命中自己的知识条目', own.status === 200 && own.hits.length > 0, `${own.status} ${JSON.stringify(own.hits.slice(0, 2))}`);
const ownHit = own.hits.find((h) => h.url === `/knowledge?doc=${sharedDoc.id}`);
ok('知识命中深链到条目详情', Boolean(ownHit), JSON.stringify(own.hits.map((h) => h.url)));
ok('知识命中带引擎与摘要', ownHit?.engine === '知识库' && (ownHit?.content ?? '').length > 10, JSON.stringify(ownHit));
ok('知识命中带分类与更新时间', ownHit?.docCategory === '生信流程' && Boolean(ownHit?.updatedAt), JSON.stringify(ownHit));
ok('知识命中计入本地总数', (own.j?.localTotal ?? 0) >= own.hits.length, `localTotal=${own.j?.localTotal} knowledge=${own.hits.length}`);
const crossUser = await search(tb, 'fastp', 'local');
ok('他人搜索只命中公共条目', crossUser.hits.length > 0 && crossUser.hits.every((h) => h.url === `/knowledge?doc=${sharedDoc.id}`), JSON.stringify(crossUser.hits.map((h) => h.url)));
const priv = await search(tb, '细胞房 废液缸', 'local');
ok('私有条目不会泄漏给他人', priv.hits.length === 0, JSON.stringify(priv.hits.map((h) => h.url)));
const webOnly = await search(ta, 'fastp', 'web');
ok('网页检索不混入知识命中', webOnly.hits.length === 0, JSON.stringify(webOnly.hits.map((h) => h.url)));
const allScope = await search(ta, 'fastp', 'all');
ok('全部范围同时保留联网与知识结果', allScope.hits.length > 0 && (allScope.j?.results ?? []).some((h) => h.kind === 'web'), `knowledge=${allScope.hits.length} total=${(allScope.j?.results ?? []).length}`);

console.log('# 收尾');
const delDoc = await call('DELETE', `/api/knowledge/${noCategory.json.item.id}`, ta);
ok('删除条目成功', delDoc.status === 200, `${delDoc.status} ${delDoc.text.slice(0, 120)}`);
const afterDelete = await listDocs(ta);
ok('删除后条目减少', afterDelete.length === 6, `${afterDelete.length}`);
for (const name of [A, B]) {
  const removed = await call('DELETE', `/api/admin/accounts/${name}`, adminToken, { confirm: name });
  ok(`硬删除 ${name}`, removed.status === 200, `${removed.status} ${removed.text.slice(0, 140)}`);
}
const leftDocs = await listDocs(adminToken);
ok('账号删除后知识条目一并清空', leftDocs.length === 0, leftDocs.map((d) => d.title).join(','));
const facetEnd = await call('GET', '/api/knowledge/categories', adminToken);
ok('管理员侧也不再统计这两个账号的条目', (facetEnd.json?.total ?? 0) === 0, JSON.stringify(facetEnd.json));

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项${fails.length ? '：' + fails.join('；') : ''}`);
if (fails.length) process.exitCode = 1;
