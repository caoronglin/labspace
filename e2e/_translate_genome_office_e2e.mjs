// 翻译可用性/卡片等高 + 基因组深链动态装配 + Office 编辑/放映回归
import { readFileSync } from 'node:fs';
import { launch, LAB_USER, LAB_PASS } from './_auth.mjs';

const BASE = process.env.LAB_BASE || 'http://198.51.100.71';
const GENOME_GID = process.env.GENOME_GID || 'f_5825778096d28df2b1ff6dfe';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${detail}`);
}

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url)).toString('base64');
}

async function api(page, path, init = {}) {
  return page.evaluate(
    async ({ path, init }) => {
      const csrf = document.cookie
        .split('; ')
        .find((c) => c.startsWith('labspace_csrf='))
        ?.split('=')
        .slice(1)
        .join('=');
      const headers = { ...(init.headers || {}) };
      if (csrf && init.method && init.method !== 'GET') headers['X-CSRF-Token'] = decodeURIComponent(csrf);
      const res = await fetch(path, { credentials: 'include', ...init, headers });
      let body = null;
      const type = res.headers.get('content-type') || '';
      if (type.includes('json')) body = await res.json().catch(() => null);
      else body = await res.text().catch(() => '');
      return { status: res.status, body };
    },
    { path, init },
  );
}

async function uploadInPage(page, dir, name, mime, b64) {
  return page.evaluate(
    async ({ dir, name, mime, b64 }) => {
      const csrf = decodeURIComponent(
        document.cookie
          .split('; ')
          .find((c) => c.startsWith('labspace_csrf='))
          ?.split('=')
          .slice(1)
          .join('=') || '',
      );
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const fd = new FormData();
      fd.append('file', new File([buf], name, { type: mime }));
      const res = await fetch(`/api/files/upload?source=users&dir=${encodeURIComponent(dir)}&overwrite=0`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': csrf },
        body: fd,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { dir, name, mime, b64 },
  );
}

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
};

const browser = await launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.locator('input[type="text"], input:not([type])').first().fill(LAB_USER);
  await page.locator('input[type="password"]').first().fill(LAB_PASS);
  await page.getByRole('button', { name: /登录|Login/ }).first().click();
  await page.waitForTimeout(4500);
  check('Tailscale 入口登录', /工作台|全部服务|我的收藏/.test(await page.evaluate(() => document.body.innerText)), page.url());
  const intro = page.getByRole('button', { name: '开始使用' });
  if ((await intro.count()) && (await intro.first().isVisible().catch(() => false))) {
    await intro.first().click();
    await page.waitForTimeout(800);
  }

  // ---------------- 翻译 ----------------
  const st = await api(page, '/api/mt/status');
  const status = st.body || {};
  check(
    'MT 状态接口可用',
    st.status === 200 && (status.available || status.fallback?.available),
    `${st.status} local=${status.available} fallback=${status.fallback?.available} reason=${String(status.reason || '').slice(0, 80)}`,
  );

  await page.goto(`${BASE}/translate?mode=text`, { waitUntil: 'domcontentloaded' });
  const source = page.getByPlaceholder('粘贴需要翻译的中文或英文内容');
  await source.waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const pageText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  check('翻译页不再误报不可用', !pageText.includes('翻译服务当前不可用'), pageText.slice(0, 100));
  check('翻译页展示引擎标签', pageText.includes('hy-mt2') || pageText.includes('pi-gateway'), pageText.match(/hy-mt2[^ ]*|pi-gateway/g)?.join(',') || '');

  const cardHeights = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.ant-card'));
    const find = (title) =>
      cards.find((c) => (c.querySelector('.ant-card-head')?.textContent || '').includes(title)) || null;
    const a = find('原文');
    const b = find('译文');
    return a && b
      ? { src: Math.round(a.getBoundingClientRect().height), dst: Math.round(b.getBoundingClientRect().height) }
      : null;
  });
  check(
    '原文/译文卡片等高',
    Boolean(cardHeights) && Math.abs(cardHeights.src - cardHeights.dst) <= 2,
    JSON.stringify(cardHeights),
  );

  await source.fill('The CRISPR-Cas9 system enables targeted genome editing in plants.');
  await page.getByRole('button', { name: /^翻\s*译$/ }).click();
  await page.waitForFunction(
    () => {
      const text = document.body.innerText;
      return text.includes('耗时') || text.includes('翻译失败');
    },
    undefined,
    { timeout: 150000 },
  );
  const afterText = await page.evaluate(() => document.body.innerText);
  check('文本翻译返回结果', afterText.includes('耗时') && !afterText.includes('翻译失败'), afterText.replace(/\s+/g, ' ').slice(0, 160));

  // ---------------- 基因组深链 ----------------
  const genomeUrl = `${BASE}/genomes?genome=01.fa&gid=${encodeURIComponent(GENOME_GID)}&action=jbrowse`;
  await page.goto(genomeUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('iframe[title="JBrowse 2 基因组浏览器"]', { timeout: 25000 });
  await page.waitForTimeout(1200);
  const iframeSrc = await page.locator('iframe[title="JBrowse 2 基因组浏览器"]').getAttribute('src');
  check(
    '深链生成动态装配 iframe',
    Boolean(iframeSrc?.includes('/jbrowse/index.html?config=') && iframeSrc.includes('genome-api')),
    String(iframeSrc),
  );
  const configPath = iframeSrc?.includes('config=') ? decodeURIComponent(iframeSrc.split('config=')[1]) : '';
  const cfg = configPath ? await api(page, configPath) : { status: 0, body: null };
  const assembly = cfg.body?.assemblies?.[0];
  const adapter = assembly?.sequence?.adapter;
  const sessionView = cfg.body?.defaultSession?.views?.[0];
  check(
    'JBrowse 动态配置可读取',
    cfg.status === 200 && adapter?.type === 'IndexedFastaAdapter',
    `${cfg.status} name=${assembly?.displayName} adapter=${adapter?.type}`,
  );
  check(
    'JBrowse 会话包含初始缩放 bpPerPx',
    typeof sessionView?.bpPerPx === 'number' && sessionView.bpPerPx > 0,
    `bpPerPx=${sessionView?.bpPerPx} region=${JSON.stringify(sessionView?.displayedRegions?.[0])}`,
  );

  if (adapter) {
    const fai = await api(page, adapter.faiLocation.uri);
    const faiLine = typeof fai.body === 'string' ? fai.body.trim().split('\n')[0] : '';
    check('生成的 .fai 索引有效', fai.status === 200 && faiLine.split('\t').length === 5, `${fai.status} ${faiLine}`);
    const range = await page.evaluate(async (uri) => {
      const res = await fetch(uri, { credentials: 'include', headers: { Range: 'bytes=0-127' } });
      const buf = await res.arrayBuffer();
      return { status: res.status, bytes: buf.byteLength, head: new TextDecoder().decode(buf.slice(0, 24)) };
    }, adapter.fastaLocation.uri);
    check('FASTA Range 读取成功', [200, 206].includes(range.status) && range.bytes > 0, `${range.status} ${range.bytes}B ${range.head}`);
    const frame = page.frames().find((f) => f.url().includes('/jbrowse/index.html'));
    check('JBrowse 页面已加载', Boolean(frame), frame?.url().slice(0, 110) || 'no frame');
    let seqOk = false;
    let seqText = '';
    try {
      const seqTrack = page.frameLocator('iframe[title="JBrowse 2 基因组浏览器"]').locator('svg[data-testid="sequence_track"]').first();
      await seqTrack.waitFor({ timeout: 45000 });
      seqText = (await seqTrack.evaluate((el) => el.textContent || '')).replace(/\s+/g, ' ').trim();
      seqOk = /[ACGTN]{8,}/i.test(seqText);
    } catch {
      seqOk = false;
    }
    check('JBrowse 渲染出序列视图', seqOk, seqText.slice(0, 80));
    await page.screenshot({ path: 'shots/_genomes_deeplink.png', fullPage: false });
  }

  // ---------------- Office 编辑 / 放映 ----------------
  const stamp = Date.now().toString(36).slice(-6);
  const dir = process.env.LAB_DIR || LAB_USER;
  const names = {
    docx: `_office_${stamp}.docx`,
    xlsx: `_office_${stamp}.xlsx`,
    pptx: `_office_${stamp}.pptx`,
    ppt: `_office_${stamp}.ppt`,
  };
  const ids = {};
  for (const kind of Object.keys(names)) {
    const up = await uploadInPage(page, dir, names[kind], MIME[kind], fixture(`e2e-office.${kind}`));
    ids[kind] = up.body?.entry?.id;
    check(`上传 ${kind} 测试文件`, up.status === 200 && Boolean(ids[kind]), `${up.status} ${up.body?.entry?.path || ''}`);
  }

  const content = {};
  for (const kind of Object.keys(names)) {
    if (!ids[kind]) continue;
    const res = await api(page, `/api/office/files/${encodeURIComponent(ids[kind])}/content`);
    content[kind] = res.body;
    const expectKind = kind === 'ppt' ? 'pptx' : kind;
    check(`${kind} 结构化读取`, res.status === 200 && res.body?.kind === expectKind, `${res.status} kind=${res.body?.kind} normalized=${res.body?.normalized}`);
  }

  if (content.docx?.blocks) {
    const blocks = content.docx.blocks.map((b) =>
      b.type === 'paragraph' && b.text.includes('第一段') ? { ...b, text: '第一段（网页编辑已验证）' } : b,
    );
    const saved = await api(page, `/api/office/files/${encodeURIComponent(ids.docx)}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'docx', blocks }),
    });
    const reread = await api(page, `/api/office/files/${encodeURIComponent(ids.docx)}/content`);
    check(
      'DOCX 保存并回读',
      saved.status === 200 && JSON.stringify(reread.body?.blocks || []).includes('网页编辑已验证'),
      `${saved.status} size=${saved.body?.size || 0}`,
    );
  }

  if (content.xlsx?.sheets) {
    const sheets = JSON.parse(JSON.stringify(content.xlsx.sheets));
    if (sheets[0]?.rows?.[1]?.[1] != null) sheets[0].rows[1][1] = '99';
    const saved = await api(page, `/api/office/files/${encodeURIComponent(ids.xlsx)}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'xlsx', sheets }),
    });
    const reread = await api(page, `/api/office/files/${encodeURIComponent(ids.xlsx)}/content`);
    const out = reread.body?.sheets || [];
    check(
      'XLSX 保存并保留其它工作表',
      saved.status === 200 && out[0]?.rows?.[1]?.[1] === '99' && (out[1]?.name === '说明'),
      `${saved.status} cell=${out[0]?.rows?.[1]?.[1]} sheets=${out.map((s) => s.name).join(',')}`,
    );
  }

  if (content.pptx?.slides) {
    const slides = JSON.parse(JSON.stringify(content.pptx.slides));
    const target = slides[1]?.shapes?.find((s) => s.title);
    if (target) target.text = '实验流程（已编辑）';
    const saved = await api(page, `/api/office/files/${encodeURIComponent(ids.pptx)}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'pptx', slides }),
    });
    const reread = await api(page, `/api/office/files/${encodeURIComponent(ids.pptx)}/content`);
    check(
      'PPTX 保存并回读',
      saved.status === 200 && JSON.stringify(reread.body?.slides || []).includes('实验流程（已编辑）'),
      `${saved.status} size=${saved.body?.size || 0}`,
    );
    const pdf = await page.evaluate(async (id) => {
      const res = await fetch(`/api/office/files/${encodeURIComponent(id)}/pdf`, { credentials: 'include' });
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, bytes: buf.length, magic: String.fromCharCode(...buf.slice(0, 5)) };
    }, ids.pptx);
    check('PPTX 转 PDF 放映稿', pdf.status === 200 && pdf.magic === '%PDF-', `${pdf.status} ${pdf.bytes}B ${pdf.magic}`);
  }

  if (content.ppt?.slides) {
    const slides = JSON.parse(JSON.stringify(content.ppt.slides));
    if (slides[0]) slides[0].notes = '旧版 PPT 备注已更新';
    const saved = await api(page, `/api/office/files/${encodeURIComponent(ids.ppt)}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'pptx', slides }),
    });
    const reread = await api(page, `/api/office/files/${encodeURIComponent(ids.ppt)}/content`);
    const ole = await page.evaluate(async (id) => {
      const res = await fetch(`/api/files/${encodeURIComponent(id)}/download`, { credentials: 'include' });
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, bytes: buf.length, hex: Array.from(buf.slice(0, 4)).map((x) => x.toString(16)).join('') };
    }, ids.ppt);
    check(
      '旧版 PPT 编辑后转回原格式',
      saved.status === 200 && JSON.stringify(reread.body?.slides || []).includes('旧版 PPT 备注已更新') && ole.hex.startsWith('d0cf11e0'),
      `${saved.status} download=${ole.status} ${ole.bytes}B ${ole.hex}`,
    );
  }

  // UI：文件管理行菜单 → 网页编辑 / 放映
  await page.goto(`${BASE}/files?source=users&dir=${encodeURIComponent(dir)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ant-table, .ant-empty', { timeout: 25000 });
  await page.waitForTimeout(1500);
  const docRow = page.locator('tr', { hasText: names.docx }).first();
  if (await docRow.count()) {
    await docRow.locator('button[aria-label="更多操作"]').click();
    await page.getByRole('menuitem', { name: '网页编辑' }).click();
    await page.getByText('DOCX 编辑', { exact: true }).waitFor({ timeout: 20000 });
    check('文件管理打开 DOCX 编辑器', true);
    await page.locator('.ant-modal-close').last().click();
    await page.waitForTimeout(600);
  } else {
    check('文件管理打开 DOCX 编辑器', false, 'row not found');
  }

  const pptRow = page.locator('tr', { hasText: names.pptx }).first();
  if (await pptRow.count()) {
    await pptRow.locator('button[aria-label="更多操作"]').click();
    await page.getByRole('menuitem', { name: '放映幻灯片' }).click();
    await page.getByText('放映', { exact: true }).first().waitFor({ timeout: 15000 });
    let canvasShown = false;
    try {
      await page.locator('div[role="dialog"] canvas').first().waitFor({ timeout: 90000 });
      canvasShown = true;
    } catch {
      canvasShown = false;
    }
    check('放映模式渲染幻灯片', canvasShown);
    await page.screenshot({ path: 'shots/_pptx_present.png', fullPage: false });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    check('Esc 退出放映', (await page.locator('div[role="dialog"] canvas').count()) === 0);
  } else {
    check('放映模式渲染幻灯片', false, 'row not found');
  }

  // 清理
  for (const id of Object.values(ids)) {
    if (id) await api(page, `/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  console.log('\nRESULTS', JSON.stringify(results));
  const failed = results.filter((r) => !r.ok);
  console.log(`SUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await ctx.close();
  await browser.close();
}
