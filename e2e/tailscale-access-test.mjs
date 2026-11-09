import { chromium } from '/opt/labspace/e2e/node_modules/playwright/index.mjs';
const BASE = 'http://198.51.100.71';
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
  ok('通过 Tailscale IP 登录门户', p.url().includes('198.51.100.71') || p.url().includes('192.0.2.10'), p.url());

  // 1) 服务目录随入口主机自适应
  const svc = await p.evaluate(async () => {
    const r = await fetch('/api/services'); return await r.json();
  });
  const urls = (svc.services||[]).map(s => s.url).join(' ');
  ok('服务目录不含内网 IP（已跟随 Tailscale）', !urls.includes('192.0.2.10'), urls.slice(0,110));

  // 2) CropGenome 前端 + Rust 端点
  const crop = await p.evaluate(async () => {
    const m = document.cookie.match(/labspace_csrf=([^;]*)/);
    const res = await fetch('/cropgenome/api/v1/sequence/analyze', { method:'POST',
      headers:{'Content-Type':'application/json','X-CSRF-Token': m ? m[1] : ''},
      body: JSON.stringify({sequence:'ATGCCCTAA', alphabet:'dna'})});
    return res.status + ' ' + (await res.text()).slice(0,80);
  });
  ok('CropGenome Rust 端点经 Tailscale 可用', crop.startsWith('200'), crop);

  // 3) 生信平台入口经 Tailscale（跨端口，浏览器会拦 CORS，改用 Node 侧直连）
  let bio = 'ERR';
  try { const rr = await fetch('http://198.51.100.71:8102/api/v1/health'); bio = rr.status + ' ' + (await rr.text()).slice(0,60); } catch (e) { bio = 'ERR ' + e.message; }
  ok('生信实训平台 8102 经 Tailscale 可达', bio.startsWith('200'), bio);

  // 4) OIDC 统一认证经 Tailscale
  let auth = 'ERR';
  try { const rr = await fetch('http://198.51.100.71:8090/login/oauth/authorize?client_id=app-labspace&response_type=code&redirect_uri=' + encodeURIComponent(BASE + '/api/auth/callback') + '&state=t&scope=openid+profile+email', { redirect: 'manual' }); auth = 'HTTP ' + rr.status; } catch (e) { auth = 'ERR ' + e.message; }
  ok('Casdoor 统一认证 8090 经 Tailscale 可达', auth.includes('302') || auth.includes('200'), auth);

  await b.close();
  console.log(fails.length ? `\n失败 ${fails.length} 项: ${fails.join('; ')}` : '\n全部通过');
  process.exit(fails.length ? 1 : 0);
})();
