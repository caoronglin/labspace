// FlashRAG 知识库：入库 / 索引 / 问答 / ACL 实测
import { chromium } from 'playwright';

const BASE = 'http://192.0.2.10';
let failed = 0;
function must(cond, label, extra = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
}

async function session(user, pass) {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#password', { timeout: 40000 });
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(pass);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(3500);
  const call = (path, init = {}) =>
    page.evaluate(
      async ([p, i]) => {
        const csrf = (document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
        const headers = { ...(i.headers || {}) };
        if (i.method && i.method !== 'GET') headers['X-CSRF-Token'] = decodeURIComponent(csrf);
        const r = await fetch(p, { credentials: 'include', ...i, headers });
        const text = await r.text();
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        return { status: r.status, body };
      },
      [path, init],
    );
  return { b, page, call };
}

const marker = Date.now();
const publicTitle = `RAG 公共测试 ${marker}`;
const privateTitle = `RAG 私有测试 ${marker}`;
const publicBody =
  `RNA-seq 质控流程测试文档 ${marker}。使用 FastQC 检查原始测序质量，` +
  '再用 Trimmomatic 去除接头与低质量碱基，随后用 MultiQC 汇总报告。';
const privateBody =
  `student01 私有实验参数 ${marker}。本项目使用独特的私有标记 ` +
  'PI-ONLY-SECRET-PARAM，仅本人可见，用于验证知识库 ACL。';

const s1 = await session('student01', process.env.LAB_S1_PASS);
const s2 = await session('student02', process.env.LAB_S2_PASS);

const st0 = await s1.call('/api/knowledge/rag/status');
must(st0.status === 200 && st0.body.available === true, 'RAG 状态接口可用', JSON.stringify(st0.body).slice(0, 120));

const pub = await s1.call('/api/knowledge', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: publicTitle, body: publicBody, tags: ['rag-test'], visibility: 'public', roles: [] }),
});
must(pub.status === 200 && pub.body.item?.id, 'student01 创建公共文档');

const priv = await s1.call('/api/knowledge', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: privateTitle, body: privateBody, tags: ['rag-test'], visibility: 'private', roles: [] }),
});
must(priv.status === 200 && priv.body.item?.id, 'student01 创建私有文档');

const ingestText = `生信实训平台指南 ${marker}。Galaxy 平台用于可视化流程编排，Jupyter 用于交互式分析。`;
const ingest = await s1.page.evaluate(async ([name, text]) => {
  const csrf = (document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
  const fd = new FormData();
  fd.append('file', new File([text], name, { type: 'text/markdown' }));
  fd.append('title', `实训平台上传 ${name}`);
  fd.append('visibility', 'public');
  fd.append('roles', '[]');
  const r = await fetch('/api/knowledge/ingest', {
    method: 'POST',
    body: fd,
    credentials: 'include',
    headers: { 'X-CSRF-Token': decodeURIComponent(csrf) },
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}, [`rag-upload-${marker}.md`, ingestText]);
must(ingest.status === 200 && ingest.body.extractedChars > 0, 'Markdown 文档上传入库', JSON.stringify(ingest.body).slice(0, 120));

let status = null;
for (let i = 0; i < 30; i++) {
  await s1.page.waitForTimeout(1000);
  const r = await s1.call('/api/knowledge/rag/status');
  status = r.body;
  if (status?.indexReady && (status.chunks ?? 0) >= 3 && (status.documents ?? 0) >= 3) break;
}
must(status?.indexReady === true, 'FlashRAG 索引就绪', JSON.stringify(status).slice(0, 160));
must((status?.chunks ?? 0) >= 3, '索引包含切分片段', `chunks=${status?.chunks}`);

const askPublic1 = await s1.call('/api/knowledge/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'FastQC 和 Trimmomatic 在 RNA-seq 质控中怎么用？', topK: 4 }),
});
must(askPublic1.status === 200, 'student01 公共问题问答成功', askPublic1.body?.mode);
const cites1 = askPublic1.body?.citations ?? [];
must(cites1.some((c) => c.title === publicTitle), '公共问题引用命中公共文档', cites1.map((c) => c.title).join(' | '));
must(!cites1.some((c) => c.title === privateTitle), '公共问题未泄漏私有文档');

const askUpload = await s1.call('/api/knowledge/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'Galaxy 和 Jupyter 分别用来做什么？', topK: 4 }),
});
must(
  (askUpload.body?.citations ?? []).some((c) => c.title.includes(`rag-upload-${marker}.md`)),
  '上传文档可被检索命中',
);

const askPrivate1 = await s1.call('/api/knowledge/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'PI-ONLY-SECRET-PARAM 是什么？', topK: 4 }),
});
must(
  (askPrivate1.body?.citations ?? []).some((c) => c.title === privateTitle),
  '本人可检索私有文档',
);

const askPrivate2 = await s2.call('/api/knowledge/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'PI-ONLY-SECRET-PARAM 是什么？', topK: 4 }),
});
must(
  !(askPrivate2.body?.citations ?? []).some((c) => c.title === privateTitle),
  'student02 无法检索他人私有文档',
);
must(
  !JSON.stringify(askPrivate2.body ?? {}).includes('PI-ONLY-SECRET-PARAM'),
  '私有正文未泄漏给 student02',
);

const askPublic2 = await s2.call('/api/knowledge/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'RNA-seq 质控 FastQC', topK: 4 }),
});
must(
  (askPublic2.body?.citations ?? []).some((c) => c.title === publicTitle),
  'student02 可检索公共文档',
);

for (const id of [pub.body.item.id, priv.body.item.id, ingest.body.item.id]) {
  await s1.call(`/api/knowledge/${id}`, { method: 'DELETE' });
}
for (let i = 0; i < 20; i++) {
  await s1.page.waitForTimeout(800);
  const r = await s1.call('/api/knowledge/rag/status');
  if ((r.body?.documents ?? 0) === 0) break;
}
const stEnd = await s1.call('/api/knowledge/rag/status');
must((stEnd.body?.documents ?? -1) === 0, '测试文档已删除并重建索引', JSON.stringify(stEnd.body).slice(0, 120));

await s1.b.close();
await s2.b.close();
console.log(failed ? `\n${failed} 项失败` : '\nALL PASS');
process.exit(failed ? 1 : 0);
