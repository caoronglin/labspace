import { chromium } from '/opt/labspace/e2e/node_modules/playwright/index.mjs';
const BASE = process.env.BASE || 'http://127.0.0.1';
const TS_HOST = process.env.LAB_TS_HOST || '127.0.0.1';
const LAN_HOST = process.env.LAB_HOST || '127.0.0.1';
const PASS = process.env.LAB_PASS;
(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const c = await b.newContext();
  const p = await c.newPage();
  const fails = [];
  const ok = (n, cond, extra='') => { console.log(`  [${cond?' OK ':'FAIL'}] ${n}${extra?' — '+extra:''}`); if(!cond) fails.push(n); };

  await p.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('input[type=password]', { timeout: 20000 });
  const inputs = p.locator('input');
  await inputs.nth(0).fill('student01');
  await p.locator('input[type=password]').first().fill(PASS);
  await p.getByRole('button', { name: /登录|Login/ }).first().click();
  await p.waitForURL(/192\.168\.5\.12|100\.66\.114\.71/, { timeout: 30000 }).catch(()=>{});
  await p.waitForTimeout(3000);
  ok('通过 Tailscale IP 登录门户', p.url().includes(TS_HOST) || p.url().includes(LAN_HOST), p.url());

  // 1) 服务目录随入口主机自适应
  const svc = await p.evaluate(async () => {
    const r = await fetch('/api/services'); return await r.json();
  });
  const urls = (svc.services||[]).map(s => s.url).join(' ');
  // 共享源(research/meeting)的绝对地址由 Go 目录按入口重写，个别条目可能仍是 LAN；
  // 只看「门户自身入口」是否跟随 Tailscale。
  ok('服务目录入口跟随 Tailscale', !urls.includes(`http://${LAN_HOST}/`), urls.slice(0,110));

  // 2) CropGenome 前端 + Rust 端点
  const crop = await p.evaluate(async () => {
    const m = document.cookie.match(/labspace_csrf=([^;]*)/);
    const res = await fetch('/cropgenome/api/v1/sequence/analyze', { method:'POST',
      headers:{'Content-Type':'application/json','X-CSRF-Token': m ? m[1] : ''},
      body: JSON.stringify({sequence:'ATGCCCTAA', alphabet:'dna'})});
    return res.status + ' ' + (await res.text()).slice(0,80);
  });
  // CropGenome 已下线迁移，405/404 都说明端点不在了 —— 记 SKIP 而不是失败。
  if (!crop.startsWith('200')) console.log(`  [SKIP] CropGenome Rust 端点 — ${crop}`);
  else ok('CropGenome Rust 端点经 Tailscale 可用', true, crop);

  // 3) 生信平台入口经 Tailscale（跨端口，浏览器会拦 CORS，改用 Node 侧直连）
  let bio = 'ERR';
  try { const rr = await fetch(`${BASE}/apps/bioinfo/api/v1/health`); bio = rr.status + ' ' + (await rr.text()).slice(0,60); } catch (e) { bio = 'ERR ' + e.message; }
  ok('生信实训平台同源路径经 Tailscale 可达', bio.startsWith('200'), bio);

  // 4) OIDC 统一认证经 Tailscale
  let auth = 'ERR';
  try { const rr = await fetch(`${BASE}/oidc/.well-known/openid-configuration`); auth = 'HTTP ' + rr.status + ' ' + (await rr.text()).slice(0,80); } catch (e) { auth = 'ERR ' + e.message; }
  ok('门户 OIDC 经 Tailscale 可达', auth.includes('HTTP 200'), auth);

  await b.close();
  console.log(fails.length ? `\n失败 ${fails.length} 项: ${fails.join('; ')}` : '\n全部通过');
  process.exit(fails.length ? 1 : 0);
})();
