// PubScholar 接入验证：数据库目录条目 + 文献检索页深度链接。
// 采用合规的「外部深度链接」方式：?query=<词> 预填 PubScholar 搜索框（已实测），
// 不爬取、不逆向其私有 API。
import { launch, loginContext, BASE } from './_auth.mjs';

let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
};

const b = await launch();
try {
  const ctx = await loginContext(b);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

  // 1) 数据库目录 API：GET（纯读接口，不需要 CSRF）
  const db = await p.evaluate(async () => {
    const res = await fetch('/api/databases?q=pubscholar', { credentials: 'include' });
    return { status: res.status, body: await res.text() };
  });
  const items = JSON.parse(db.body).items ?? [];
  const ps = items.find((d) => d.id === 'pubscholar');
  record('数据库目录含 pubscholar', db.status === 200 && Boolean(ps), `status=${db.status}`);
  record('条目标注为网页访问', ps && ps.api?.hasApi === false, ps ? `hasApi=${ps.api?.hasApi}` : '无条目');
  record('条目 URL 指向 PubScholar', ps?.url?.startsWith('https://pubscholar.cn/'), ps?.url);

  // 2) 文献检索页：外链按钮带当前关键词
  await p.goto(`${BASE}/literature`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  const input = p.getByPlaceholder(/关键词/).first();
  await input.fill('Arabidopsis 基因组');
  await p.waitForTimeout(400);
  const link = p.locator('a[href*="pubscholar.cn"]').first();
  const href = await link.getAttribute('href').catch(() => null);
  record('文献页有 PubScholar 外链', Boolean(href), href ?? '未找到');
  record('外链携带关键词', href?.includes('query=Arabidopsis') ?? false);
  record('外链安全属性', await link.getAttribute('rel') === 'noreferrer noopener' && await link.getAttribute('target') === '_blank');
  await p.screenshot({ path: new URL('./shots/', import.meta.url).pathname + 'pubscholar.png', fullPage: false });
} finally {
  await b.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
