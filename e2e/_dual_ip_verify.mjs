// 双入口（内网 192.0.2.10 / Tailscale 198.51.100.71）适配验证
// 判定标准：从某个入口进来时，页面上出现的任何服务地址都必须指向同一个入口主机，
// 且内嵌页必须真实渲染 iframe（不出现“不可嵌入”提示）。
import { readFileSync } from 'node:fs';

// 口令从凭据台账读取（0600），不写入命令行，避免在 shell 历史/输出中泄露
const credFile = '/etc/labspace/casdoor-users.txt';
const wanted = process.env.LAB_ADMIN_USER || 'labadmin@local';
const line = readFileSync(credFile, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .find((l) => l.split(/\s+/)[0] === wanted);
if (!line) {
  console.error(`凭据台账中没有账号 ${wanted}`);
  process.exit(2);
}
process.env.LAB_USER = wanted.split('@')[0];
process.env.LAB_PASS = line.split(/\s+/)[1];

// _auth.mjs 在模块加载时读取环境变量，必须等凭据写入后再动态导入
const { loginContext, launch } = await import('./_auth.mjs');

const ENTRY_PAGES = [
  '/services',
  '/commands',
  '/drawio',
  '/embed/drawing-board',
  '/devtools',
  '/bioinfo',
  '/snapotter',
  '/files',
  '/knowledge',
  '/network',
];

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await launch();

for (const host of ['192.0.2.10', '198.51.100.71']) {
  const other = host === '192.0.2.10' ? '198.51.100.71' : '192.0.2.10';
  const base = `http://${host}`;
  let ctx;
  try {
    ctx = await loginContext(browser, base);
  } catch (e) {
    check(`${host} 登录`, false, e.message);
    continue;
  }
  check(`${host} 登录`, true);
  const page = await ctx.newPage();

  for (const path of ENTRY_PAGES) {
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(path.includes('embed') ? 5000 : 3000);
    const info = await page.evaluate(() => {
      const urls = Array.from(
        document.querySelectorAll('a[href], iframe[src], link[href], source[src]')
      )
        .map((el) => el.getAttribute('href') || el.getAttribute('src') || '')
        .filter((u) => u.startsWith('http'));
      return { urls, body: document.body.innerText.replace(/\s+/g, ' ') };
    });

    // 1) 页面不得把用户指向另一个入口主机（127.0.0.1/192.0.2.29 属后端内部地址，忽略）
    const wrong = info.urls.filter((u) => u.includes(`//${other}`));
    check(`${host}${path} 无跨入口地址`, wrong.length === 0, wrong.slice(0, 2).join(', '));

    // 2) 服务地址必须跟随当前入口
    const sameHost = info.urls.filter((u) => u.includes(`//${host}`));
    if (path === '/services' || path === '/network' || path.includes('embed')) {
      check(`${host}${path} 地址指向当前入口`, sameHost.length > 0, `命中 ${sameHost.length} 个`);
    }

    // 3) 内嵌页必须真正渲染出 iframe，且不出现“不可嵌入”提示
    if (path.includes('embed')) {
      const frame = info.urls.find((u) => u.startsWith(`http://${host}`));
      const blocked = /未提供内嵌入口|禁止被嵌入|站点限制了|无法嵌入/.test(info.body);
      check(`${host}${path} iframe 已渲染`, !!frame && !blocked, frame || info.body.slice(0, 100));
    }
  }

  // 4) 功能级验证：核心 API 必须在该入口主机下真实可用
  const sources = await page.evaluate(async () => {
    const r = await fetch('/api/files/sources', { credentials: 'include' });
    const d = await r.json();
    return (d.sources || []).map((s) => s.id || s.key || s.name).filter(Boolean);
  });
  check(`${host} 文件源清单`, sources.length > 0, sources.join(','));
  const fnChecks = [
    { name: '服务目录', url: '/api/services', pick: (d) => (d.services || d.items || []).length },
    {
      name: '统一搜索',
      url: '/api/search?q=%E6%B0%B4%E7%A8%BB&page=1&pageSize=5',
      pick: (d) => (d.results || d.items || d.web || d.categories || []).length,
    },
    {
      name: '文件列表',
      url: `/api/files?source=${encodeURIComponent(sources[0] || '')}`,
      pick: (d) => (d.items || d.files || d.entries || []).length,
    },
    { name: '知识库', url: '/api/knowledge?q=%E6%B0%B4%E7%A8%BB', pick: (d) => (d.items || []).length },
    { name: 'Agent 会话', url: '/api/agent/sessions', pick: (d) => (d.sessions || d.items || []).length },
  ];
  for (const c of fnChecks) {
    const got = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: 'include' });
        const text = await r.text();
        let data = {};
        try {
          data = JSON.parse(text);
        } catch {
          data = { __raw: text.slice(0, 80) };
        }
        return { status: r.status, data };
      } catch (e) {
        return { status: 0, data: { __err: String(e) } };
      }
    }, c.url);
    const count = got.status === 200 ? c.pick(got.data) : -1;
    check(
      `${host} ${c.name} API`,
      got.status === 200 && count >= 0,
      `status=${got.status} 命中=${count}` + (count <= 0 ? ` ${JSON.stringify(got.data).slice(0, 120)}` : '')
    );
  }

  // 4b) CropGenome：Go 核心注入身份后，工具页应真实渲染数据而不是报未认证
  await page.goto(`${base}/cropgenome/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const crop = await page.evaluate(() => ({ text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 500) }));
  const cropBad = /unauthenticated|authentication required|"code":401|无权访问/.test(crop.text);
  check(`${host} CropGenome 页面可用`, !cropBad, crop.text.slice(0, 120));

  // 5) 服务目录里的地址必须跟随入口主机
  const catalogHosts = await page.evaluate(async () => {
    const r = await fetch('/api/services', { credentials: 'include' });
    const d = await r.json();
    const list = d.services || d.items || [];
    return Array.from(
      new Set(
        list
          .flatMap((s) => [s.url || s.URL, s.embed_url || s.embedUrl, s.sso_url || s.ssoUrl])
          .filter((u) => typeof u === 'string' && u.startsWith('http'))
          .map((u) => {
            try {
              return new URL(u).hostname;
            } catch {
              return '';
            }
          })
          .filter(Boolean)
      )
    );
  });
  const badCatalog = catalogHosts.filter((h) => h !== host && !['127.0.0.1'].includes(h));
  check(`${host} 目录地址全部跟随入口`, badCatalog.length === 0, badCatalog.join(', '));

  await ctx.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
await browser.close();
process.exit(failed.length ? 1 : 0);
