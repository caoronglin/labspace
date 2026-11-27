// 门户数据库池与生信工具多 worker 并发回归。
import { launch, loginContext, BASE } from './_auth.mjs';

let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' - ' + detail : ''}`);
};

const browser = await launch();
try {
  const ctx = await loginContext(browser);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  const portal = await page.evaluate(async () => {
    const started = performance.now();
    const responses = await Promise.all(Array.from({ length: 24 }, () => fetch('/api/me', { credentials: 'include' })));
    const statuses = responses.map((response) => response.status);
    return { statuses, elapsed: Math.round(performance.now() - started) };
  });
  record('24 个门户会话查询并行成功', portal.statuses.length === 24 && portal.statuses.every((status) => status === 200), `${portal.elapsed}ms`);

  const biotools = await page.evaluate(async () => {
    const csrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '');
    const started = performance.now();
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => fetch('/api/biotools/sequence/analyze', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ molecule: 'dna', sequence: `ATGCGT${['A', 'C', 'G', 'T'][index % 4]}ACGTTGCA` }),
    })));
    const bodies = await Promise.all(responses.map(async (response) => ({ status: response.status, body: await response.json().catch(() => null) })));
    return { bodies, elapsed: Math.round(performance.now() - started) };
  });
  const bioOk = biotools.bodies.length === 8 && biotools.bodies.every((item) => item.status === 200 && item.body?.molecule === 'dna');
  record('8 个生信序列计算并行成功', bioOk, `${biotools.elapsed}ms`);
} finally {
  await browser.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
