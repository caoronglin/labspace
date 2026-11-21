// =====================================================================
//  LabSpace API 集成体检：逐个真实调用后端接口，输出 PASS/FAIL
//  用法: LAB_PASS=<口令> node api-integration.mjs
// =====================================================================
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://127.0.0.1';
const USER = process.env.LAB_USER || 'student01';
const PASS = process.env.LAB_PASS || '';

let pass = 0;
let fail = 0;
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'zh-CN' });
const page = await ctx.newPage();

// ---------- 登录 ----------
await page.goto(`${BASE}/api/auth/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#username', { timeout: 20000 });
await page.locator('#username').fill(USER);
await page.locator('#password').fill(PASS);
await page.getByRole('button', { name: '登录' }).first().click();
await page.waitForURL(`${BASE}/**`, { timeout: 25000 }).catch(() => {});
await page.waitForTimeout(1500);

const api = async (path, init = {}) => {
  const res = await page.evaluate(
    async ([p, i]) => {
      // 写操作带上双提交 CSRF 头（与前端一致）
      if (i.method && i.method !== 'GET' && !i.skipCsrf) {
        const csrf = (document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '';
        i = { ...i, headers: { ...(i.headers || {}), 'X-CSRF-Token': decodeURIComponent(csrf) } };
      }
      const { skipCsrf, ...rest } = i;
      const r = await fetch(p, { credentials: 'include', ...rest });
      const t = await r.text();
      try {
        return { status: r.status, body: JSON.parse(t) };
      } catch {
        return { status: r.status, body: t.slice(0, 200) };
      }
    },
    [path, init],
  );
  return res;
};

// ---------- 1. 身份与会话 ----------
{
  const me = await api('/api/me');
  record('GET /api/me 返回已认证', me.status === 200 && me.body?.authenticated === true, `roles=${JSON.stringify(me.body?.roles)}`);
  const cookies = await ctx.cookies();
  const sess = cookies.find((c) => c.name === 'labspace_session');
  const csrf = cookies.find((c) => c.name === 'labspace_csrf');
  record('会话 Cookie 存在且 HttpOnly', !!sess && sess.httpOnly === true, sess ? `path=${sess.path} sameSite=${sess.sameSite}` : '缺失');
  record('CSRF Cookie 非 HttpOnly（供前端读取）', !!csrf && csrf.httpOnly === false);
}

// ---------- 2. 会话恢复（刷新 / 新标签 / 新开页面） ----------
{
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const me = await api('/api/me');
  record('刷新页面后会话仍有效', me.body?.authenticated === true);

  const p2 = await ctx.newPage();
  await p2.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(1500);
  const restored = await p2.evaluate(async () => {
    const r = await fetch('/api/me', { credentials: 'include' });
    const j = await r.json();
    return j.authenticated;
  });
  record('新标签页会话可恢复', restored === true);
  const shown = (await p2.evaluate(() => document.body.innerText)).includes(USER);
  record('新标签页直接显示已登录用户', shown);
  await p2.close();
}

// ---------- 3. 服务目录与健康 ----------
{
  const svc = await api('/api/services');
  record('GET /api/services 返回目录', svc.status === 200 && Array.isArray(svc.body?.services) && svc.body.services.length > 0, `${svc.body?.services?.length} 项`);
  const health = await api('/api/services/health');
  const list = health.body?.services ?? [];
  const up = list.filter((s) => s.health?.status === 'up').length;
  // 外部内网服务（图纸平台等）故障不算本机失败，只作提示
  const extDown = list.filter((s) => s.health?.status === 'external-down');
  const own = list.filter((s) => s.health?.status !== 'external-down');
  const ownUp = own.filter((s) => s.health?.status === 'up').length;
  record(
    'GET /api/services/health 本机服务全部探测',
    health.status === 200 && ownUp === own.length,
    `${ownUp}/${own.length} 本机服务 up` + (extDown.length ? `；外部服务异常 ${extDown.length} 个（${extDown.map((s) => s.name).join(',')}）` : ''),
  );
  const one = await api('/api/services/quantum/health');
  record('GET /api/services/{id}/health', one.status === 200 && one.body?.status === 'up');
}

// ---------- 4. 收藏 / 最近 ----------
{
  const fav0 = await api('/api/favorites');
  record('GET /api/favorites', fav0.status === 200 && Array.isArray(fav0.body?.favorites));
  const add = await api('/api/favorites/quantum', { method: 'POST' });
  record('POST /api/favorites/{id}', add.status === 200 && add.body?.favorites?.includes('quantum'));
  const del = await api('/api/favorites/quantum', { method: 'DELETE' });
  record('DELETE /api/favorites/{id}', del.status === 200 && !del.body?.favorites?.includes('quantum'));
  const rec = await api('/api/recent');
  record('GET /api/recent', rec.status === 200 && Array.isArray(rec.body?.recent));
  const touch = await api('/api/recent/quantum', { method: 'POST' });
  record('POST /api/recent/{id} 记录访问', touch.status === 200);
  const rec2 = await api('/api/recent');
  record('最近访问已写入', rec2.body?.recent?.includes('quantum'));
}

// ---------- 5. 检索 / 文献 ----------
{
  const s = await api('/api/search?q=fastp&categories=science');
  const n = s.body?.results?.length ?? 0;
  record('GET /api/search 学术检索', s.status === 200 && n > 0, `${n} 条`);
  const s2 = await api('/api/search?q=CRISPR&categories=general');
  record('GET /api/search 网页检索', s2.status === 200 && (s2.body?.results?.length ?? 0) > 0);
  const lit = await api('/api/literature?q=fastp+RNA-seq+quality+control&source=pubmed');
  record('GET /api/literature 文献检索', lit.status === 200 && (lit.body?.items?.length ?? 0) > 0, `${lit.body?.items?.length ?? 0} 条`);
  const lit2 = await api('/api/literature?q=P04637&source=uniprot');
  record('GET /api/literature UniProt', lit2.status === 200 && !!(lit2.body?.items?.[0]?.Entry || lit2.body?.accession));
}

// ---------- 6. 命令库 ----------
{
  const list = await api('/api/commands?q=grep');
  record('GET /api/commands 检索', list.status === 200 && list.body?.matched > 0, `命中 ${list.body?.matched}`);
  const one = await api('/api/commands/awk');
  record('GET /api/commands/{name} 全文', one.status === 200 && one.body?.markdown?.length > 500, `${one.body?.markdown?.length ?? 0} 字符`);
}

// ---------- 6.5 植物数据库目录 ----------
{
  const all = await api('/api/databases');
  record('GET /api/databases 全量目录', all.status === 200 && all.body?.total >= 50, `${all.body?.total} 个资源 / ${all.body?.categories?.length} 个分类`);
  const hit = await api('/api/databases?q=' + encodeURIComponent('单细胞'));
  record('GET /api/databases 关键词检索', hit.status === 200 && hit.body?.matched > 0, `命中 ${hit.body?.matched}`);
  const cat = await api('/api/databases?category=' + encodeURIComponent('多组学与单细胞'));
  record('GET /api/databases 分类筛选', cat.status === 200 && cat.body?.matched > 0 && cat.body.items.every((i) => i.category === '多组学与单细胞'));
  const s3 = await api('/api/search?q=' + encodeURIComponent('miRNA') + '&categories=general');
  const local = s3.body?.local ?? [];
  record('全局搜索并入本地植物库', s3.status === 200 && local.length > 0, `本地命中 ${local.length}`);
}

// ---------- 7. 翻译 ----------
{
  const st = await api('/api/pdf-translate/status');
  record('GET /api/translate/status', st.status === 200 && st.body?.service === 'pdf2zh', JSON.stringify(st.body));
}

// ---------- 8. 图形（draw.io 集成） ----------
{
  const list = await api('/api/drawings');
  record('GET /api/drawings', list.status === 200 && Array.isArray(list.body?.drawings));
  const svg = '<mxfile><diagram name="t"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
  const created = await api('/api/drawings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'api-integration-test', content: svg }),
  });
  record('POST /api/drawings 保存图形', created.status === 200 && !!created.body?.id);
  const id = created.body?.id;
  if (id) {
    const renamed = await api(`/api/drawings/${id}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'api-integration-renamed' }),
    });
    record('POST /api/drawings/{id}/rename', renamed.status === 200);
    const dl = await api(`/api/drawings/${id}/download`);
    record('GET /api/drawings/{id}/download', dl.status === 200 && String(dl.body).includes('mxfile'));
    const del = await api(`/api/drawings/${id}`, { method: 'DELETE' });
    record('DELETE /api/drawings/{id}', del.status === 200);
  }
}

// ---------- 9. 公告 ----------
{
  const a = await api('/api/announcements');
  record('GET /api/announcements', a.status === 200 && Array.isArray(a.body?.announcements));
  const forbidden = await api('/api/announcements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x', content: 'y' }),
  });
  record('学生发布公告被拒绝(403)', forbidden.status === 403, `HTTP ${forbidden.status}`);
}

// ---------- 10. 管理端权限 ----------
{
  const info = await api('/api/admin/info');
  record('学生访问 /api/admin/info 被拒绝(403)', info.status === 403, `HTTP ${info.status}`);
  const hs = await api('/api/admin/health');
  record('学生访问 /api/admin/health 被拒绝(403)', hs.status === 403, `HTTP ${hs.status}`);
}

// ---------- 11. CSRF 防护 ----------
{
  const noCsrf = await api('/api/favorites/quantum', { method: 'POST', skipCsrf: true });
  record('缺少 CSRF 头的写操作被拒绝(403)', noCsrf.status === 403, `HTTP ${noCsrf.status}`);
}

// ---------- 9.5 服务入口自检（IP + 端口） ----------
{
  const r = await api('/api/network/entries');
  const items = r.body?.items ?? [];
  record('GET /api/network/entries 入口自检', r.status === 200 && items.length >= 8, `${items.length} 个入口`);
  record(
    '全部入口均可用（主机 + 端口）',
    items.length > 0 && items.every((i) => i.up),
    items.filter((i) => !i.up).map((i) => `${i.name}:${i.detail}`).join(',') || '全部正常',
  );
  // 允许 http://<主机>/ (80) 与 http://<主机>:PORT/ 两种形式，均不得含域名
  const noDomain = items.every((i) => /^http:\/\/192\.168\.5\.12(:\d+)?\//.test(i.url));
  record('入口地址不含任何域名', noDomain);
}

// ---------- 11.5 SnapOtter 文件工坊（原生 REST 代理） ----------
{
  const st = await api('/api/snapotter/status');
  record('GET /api/snapotter/status', st.status === 200 && st.body?.up === true, st.body?.detail || `status=${st.status}`);
  record('SnapOtter 工具目录 > 100 个', Number(st.body?.toolCount) > 100, `toolCount=${st.body?.toolCount}`);

  const tools = await api('/api/snapotter/tools');
  const list = tools.body?.tools ?? [];
  record('GET /api/snapotter/tools', tools.status === 200 && list.length > 100, `${list.length} 个工具`);
  const sections = [...new Set(list.map((t) => t.section))];
  record('工具覆盖 image/pdf/files/video/audio', ['image', 'pdf', 'files', 'video', 'audio'].every((s) => sections.includes(s)), sections.join(','));
}

// ---------- 11.6 统一语料（含 SnapOtter 工具与扩充后的植物库） ----------
{
  const c1 = await api('/api/corpus?limit=10&q=' + encodeURIComponent('PDF 合并'));
  const t1 = c1.body?.items ?? [];
  record('语料命中 SnapOtter 工具（PDF 合并）', t1.some((i) => i.type === 'snapotter' && /Merge/i.test(i.title)), t1.map((i) => i.title).join(' | ').slice(0, 80));
  const c2 = await api('/api/corpus?limit=10&q=' + encodeURIComponent('单细胞'));
  const t2 = c2.body?.items ?? [];
  record('语料命中单细胞植物库 ≥ 5 条', t2.filter((i) => i.type === 'database').length >= 5, `${t2.filter((i) => i.type === 'database').length} 条`);
  const c3 = await api('/api/corpus?limit=6&q=' + encodeURIComponent('AlphaFold'));
  record('语料命中扩充后的植物库（AlphaFold）', (c3.body?.items ?? []).some((i) => i.type === 'database' && /AlphaFold/.test(i.title)));
  const c4 = await api('/api/corpus?limit=40');
  const types = [...new Set((c4.body?.items ?? []).map((i) => i.type))];
  record('语料类型覆盖 service/database/page/tool/snapotter/command', ['service', 'database', 'page', 'tool', 'snapotter', 'command'].every((t) => types.includes(t)), types.join(','));
}

// ---------- 12. 登出 ----------
{
  const out = await api('/api/auth/logout', { method: 'POST' });
  record('POST /api/auth/logout', out.status === 200 && !!out.body?.logoutUrl);
  const me = await api('/api/me');
  record('登出后会话失效', me.body?.authenticated === false);
}

// ---------- 10. OIDC 全流程（真实浏览器，IP 化授权端点）----------
{
  const { chromium } = await import('playwright');
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const pg = await (await b.newContext({ locale: 'zh-CN' })).newPage();
  await pg.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(3500);
  const authUrl = pg.url();
  record(
    'OIDC 授权端点使用 IP（非域名）',
    authUrl.startsWith(`${BASE}:8090/login/oauth/authorize`) && !authUrl.includes('auth.lab.internal'),
    authUrl.split('?')[0],
  );
  try {
    await pg.waitForSelector('input[type="password"]', { timeout: 15000 });
    await pg.locator('input[type="text"], input:not([type])').first().fill(process.env.LAB_USER || 'student01');
    await pg.locator('input[type="password"]').first().fill(process.env.LAB_PASS);
    await pg.getByRole('button', { name: /登录|Login/ }).first().click();
    await pg.waitForTimeout(6000);
    const body = (await pg.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
    record('OIDC 浏览器全流程登录成功', /工作台|全部服务|我的收藏/.test(body), pg.url().split('?')[0]);
  } catch (e) {
    record('OIDC 浏览器全流程登录成功', false, String(e).slice(0, 80));
  }
  await b.close();
}

await browser.close();
console.log(`\nAPI 集成体检: 通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
