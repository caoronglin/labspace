// 生信格式预览的端到端验证：真实 SnapGene .dna、GenBank、PDB、Newick、Phylip，
// 以及浏览器里 .dna 预览的渲染。脚本不打印任何凭据。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://192.0.2.10';
const CSRF = 'e2e-csrf-token-value';
const DIR = 'bio-preview';

let pass = 0;
const fails = [];
const ok = (name, cond, info = '') => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}${info ? ' :: ' + info : ''}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${info ? ' :: ' + info.slice(0, 220) : ''}`);
  }
};

const adminToken = execFileSync('docker', ['exec', '-i', '-w', '/srv/app', 'lab-labspace-backend', 'python', '-c', `
from app import accounts
from app.security import issue_session
import json
row = accounts._query('SELECT id, name, display_name, email, groups FROM public."user" WHERE owner=%s AND name=%s', ('built-in', 'labadmin'))[0]
print(issue_session({"id": row["id"], "email": row["email"], "name": row["display_name"], "roles": json.loads(row["groups"] or "[]")}))
`], { encoding: 'utf8' }).trim();

const headers = { cookie: `labspace_session=${adminToken}; labspace_csrf=${CSRF}`, origin: BASE };
const apiCall = async (method, path, body) => {
  const h = { ...headers };
  let payload;
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    h['x-csrf-token'] = CSRF;
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* raw */
  }
  return { status: res.status, json, text };
};

// ---- API：真实质粒里的 .dna ----
const plasmids = await apiCall('GET', '/api/files?source=plasmids&sort=name&order=asc');
const dnaEntries = (plasmids.json?.entries ?? []).filter((e) => !e.dir && e.name.toLowerCase().endsWith('.dna'));
ok('公共质粒里有 .dna 样本', dnaEntries.length > 0, `${dnaEntries.length}`);
const dnaEntry = dnaEntries.find((e) => /pBI121/i.test(e.name)) ?? dnaEntries[0];
const dnaPreview = await apiCall('GET', `/api/files/${encodeURIComponent(dnaEntry.id)}/preview`);
const dna = dnaPreview.json ?? {};
ok('SnapGene 预览返回结构', dnaPreview.status === 200 && dna.kind === 'bioinfo' && dna.format === 'snapgene', `${dnaPreview.status} ${dnaPreview.text.slice(0, 120)}`);
ok('解析出序列长度与拓扑', typeof dna.meta?.length === 'number' && dna.meta.length > 1000 && /环状|线状/.test(dna.meta?.topology ?? ''), `length=${dna.meta?.length} topology=${dna.meta?.topology}`);
ok('给出 GC 含量', typeof dna.meta?.gc_percent === 'number' && dna.meta.gc_percent > 0 && dna.meta.gc_percent < 100, `gc=${dna.meta?.gc_percent}`);
ok('记录首段序列片段', (dna.records?.[0]?.snippet ?? '').length > 20, String(dna.records?.[0]?.snippet ?? '').slice(0, 60));

// ---- API：上传合成样本，覆盖 GenBank / PDB / Newick / Phylip ----
const home = await apiCall('GET', '/api/files?source=users&sort=name&order=asc');
const root = (home.json?.entries ?? []).find((e) => e.dir && !e.path.includes('/'));
const dirPath = `${root.path}/${DIR}`;
await apiCall('POST', '/api/files/mkdir', { source: 'users', path: dirPath });
const upload = async (name, text) => {
  const fd = new FormData();
  fd.append('file', new Blob([text], { type: 'text/plain' }), name);
  const res = await fetch(`${BASE}/api/files/upload?source=users&dir=${encodeURIComponent(dirPath)}&overwrite=1`, {
    method: 'POST',
    headers: { ...headers, 'x-csrf-token': CSRF },
    body: fd,
  });
  return res.status;
};

const gbText = `LOCUS       pUC19                   2686 bp    DNA     circular SYN 01-JAN-2020
DEFINITION  Cloning vector pUC19, complete sequence.
FEATURES             Location/Qualifiers
     source          1..2686
     CDS             100..500
ORIGIN
        1 gatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatcgatc
       61 gatcgatcgatcgatcgatcgatcgatcg
//
`;
const pdbText = `HEADER    TRANSFERASE                             01-JAN-00   1ABC
TITLE     CRYSTAL STRUCTURE OF TEST PROTEIN
REMARK   2 RESOLUTION.    1.80 ANGSTROMS.
ATOM      1  N   ALA A   1      11.104   6.134  -6.504  1.00  0.00           N
ATOM      2  CA  ALA A   1      11.639   6.071  -5.147  1.00  0.00           C
END
`;
const nwkText = '((A:0.1,B:0.2)90:0.3,(C:0.4,D:0.5):0.6);';
const phyText = ' 3 8\nAlpha    ACGTACGT\nBeta     ACGTACGA\nGamma    ACGTACGG\n';
for (const [name, text] of [
  ['pUC19.gb', gbText],
  ['1abc.pdb', pdbText],
  ['tree.nwk', nwkText],
  ['aln.phy', phyText],
]) {
  const st = await upload(name, text);
  ok(`上传样本 ${name}`, st === 200 || st === 201, `${st}`);
}

const entries = await apiCall('GET', `/api/files?source=users&sort=name&order=asc&dir=${encodeURIComponent(dirPath)}`);
const byName = new Map((entries.json?.entries ?? []).map((e) => [e.name, e]));
const preview = async (name) => apiCall('GET', `/api/files/${encodeURIComponent(byName.get(name)?.id ?? 'missing')}/preview`);

const gb = (await preview('pUC19.gb')).json ?? {};
ok('GenBank 解析出 LOCUS 元数据', gb.format === 'genbank' && gb.meta?.name === 'pUC19' && gb.meta?.topology === '环状', JSON.stringify(gb.meta));
ok('GenBank 列出特征', (gb.records ?? []).some((f) => f.feature === 'CDS'), JSON.stringify((gb.records ?? []).map((f) => f.feature)));
const pdb = (await preview('1abc.pdb')).json ?? {};
ok('PDB 统计原子与分辨率', pdb.format === 'pdb' && pdb.meta?.atoms === 2 && pdb.meta?.resolution_angstrom === '1.80', JSON.stringify(pdb.meta));
const nwk = (await preview('tree.nwk')).json ?? {};
ok('Newick 统计叶节点', nwk.meta?.tips === 4 && nwk.text?.includes('A:0.1'), JSON.stringify(nwk.meta));
const phy = (await preview('aln.phy')).json ?? {};
ok('Phylip 解析序列块', phy.meta?.taxa === 3 && (phy.records ?? []).length === 3, JSON.stringify(phy.meta));

// ---- 浏览器：.dna 预览渲染 ----
const creds = fs.readFileSync('/etc/labspace/casdoor-users.txt', 'utf8').split('\n').find((l) => l.startsWith('labadmin@local'));
const password = creds.trim().split(/\s+/)[1];
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1680, height: 1000 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="password"]', { timeout: 20000 });
await page.locator('input[type="text"], input:not([type])').first().fill('labadmin');
await page.locator('input[type="password"]').first().fill(password);
await page.getByRole('button', { name: /登录|Login/ }).first().click();
await page.waitForTimeout(3500);

await page.goto(`${BASE}/files?source=plasmids&q=pBI121`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const row = page.locator('.ant-table-row', { hasText: 'pBI121' }).first();
ok('质粒列表能搜到 pBI121', (await row.count()) > 0, page.url());
await row.locator('button', { hasText: '预览' }).first().click();
const shown = await page.getByText('SNAPGENE').first().waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
const modalText = await page.locator('.ant-modal').first().innerText().catch(() => '');
ok('预览弹窗渲染生信视图', shown && /bp/.test(modalText) && /GC/.test(modalText), modalText.replace(/\n/g, ' ').slice(0, 240));
ok('预览标注序列片段', /[ACGT]{20,}/i.test(modalText), modalText.replace(/\n/g, ' ').slice(-160));
await page.screenshot({ path: 'shots/bio-preview.png' });
await browser.close();

// ---- 收尾：删掉本轮上传的样本 ----
for (const name of ['pUC19.gb', '1abc.pdb', 'tree.nwk', 'aln.phy']) {
  const id = byName.get(name)?.id;
  if (id) await apiCall('DELETE', `/api/files/${encodeURIComponent(id)}`, { confirm: name });
}

console.log(`\n通过 ${pass} / 失败 ${fails.length}`);
if (fails.length) console.log('失败项：' + fails.join('、'));
process.exit(fails.length ? 1 : 0);
