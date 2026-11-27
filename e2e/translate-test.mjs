// PDF 翻译回归：模型可用时真实上传并等待终态；环境依赖缺失时明确 SKIP。
import fs from 'node:fs';
import { launch, loginContext, BASE } from './_auth.mjs';

let pass = 0, fail = 0, skip = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ` - ${detail}` : ''}`);
};

const MINIMAL_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj\n' +
  '4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 20 100 Td (D509 test) Tj ET\nendstream endobj\n' +
  'trailer<</Root 1 0 R>>\n%%EOF\n',
);

const browser = await launch();
try {
  const ctx = await loginContext(browser);
  const page = ctx.pages()[0];
  await page.setViewportSize({ width: 1400, height: 950 });
  const mt = await page.evaluate(async () => {
    const r = await fetch('/api/mt/status', { credentials: 'include' });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  });
  if (mt.status !== 200 || !mt.body?.effective_available) {
    skip++;
    console.log(`  [SKIP] PDF 翻译模型与备用网关均不可用：${mt.body?.reason || mt.body?.fallback?.reason || `HTTP ${mt.status}`}`);
  } else {
    await page.goto(`${BASE}/translate`, { waitUntil: 'domcontentloaded' });
    const status = await page.evaluate(async () => {
      const response = await fetch('/api/pdf-translate/status', { credentials: 'include' });
      return response.text();
    });
    console.log('  服务状态:', status);
    const input = page.locator('.ant-upload input[type="file"]').first();
    await input.waitFor({ state: 'attached', timeout: 20000 });
    const fixture = '/opt/labspace/e2e/fixtures/probe.pdf';
    const buf = fs.existsSync(fixture) ? fs.readFileSync(fixture) : MINIMAL_PDF;
    await input.setInputFiles({ name: 'testdoc.pdf', mimeType: 'application/pdf', buffer: buf });
    await page.waitForTimeout(2000);
    record('PDF 上传后创建翻译任务', /排队中|正在解析|翻译完成|翻译失败/.test(await page.locator('body').innerText()));

    let finalText = '';
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(5000);
      const bodyText = await page.locator('body').innerText();
      finalText = bodyText.replace(/\s+/g, ' ');
      if (finalText.includes('翻译完成') || finalText.includes('翻译失败')) break;
      if (i % 6 === 0) console.log('  ...', finalText.match(/排队中|正在解析[^，]*/)?.[0] ?? '');
    }
    record('翻译任务成功完成', finalText.includes('翻译完成'), finalText.match(/翻译完成|翻译失败/)?.[0] || '超时');
    await page.screenshot({ path: '/opt/labspace/e2e/shots/translate-result.png' });
  }
} finally {
  await browser.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail} / 跳过 ${skip}`);
process.exit(fail ? 1 : 0);
