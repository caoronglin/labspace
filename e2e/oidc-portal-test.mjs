// 门户自建 OIDC Provider 端到端：证明已替代 Casdoor 成为内网服务的身份源。
//
// 覆盖：直连口令登录 → authorize（门户会话识别用户）→ code → token（RS256）
// → userinfo → 生信平台凭门户会话完成 SSO 落到 /apps/bioinfo/dashboard。
import { launch, loginContext, BASE } from './_auth.mjs';
import crypto from 'node:crypto';

let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
};

const b = await launch();
try {
  // 1) discovery + JWKS 可取
  const disc = await fetch(`${BASE}/oidc/.well-known/openid-configuration`).then(r => r.json()).catch(() => ({}));
  record('discovery 指向门户 issuer', disc.issuer === `${BASE}/oidc`, `issuer=${disc.issuer}`);
  const jwks = await fetch(`${BASE}/oidc/.well-known/jwks.json`).then(r => r.json()).catch(() => ({}));
  record('JWKS 含 RS256 公钥', jwks.keys?.[0]?.alg === 'RS256' && !!jwks.keys?.[0]?.n);

  // 2) 直连口令登录（自建统一认证，不再经 Casdoor）
  const ctx = await loginContext(b);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const login = await p.evaluate(async ([u, pw]) => {
    const res = await fetch('/api/auth/login-direct', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: pw }),
    });
    return { status: res.status, body: await res.text() };
  }, [process.env.LAB_USER, process.env.LAB_PASS]);
  record('直连口令登录', login.status === 200, `status=${login.status}`);
  const cookie = (await ctx.cookies(BASE)).map(c => `${c.name}=${c.value}`).join('; ');

  // 3) 授权码 + PKCE
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = `${BASE}/apps/bioinfo/api/v1/auth/callback`;
  const q = new URLSearchParams({
    client_id: 'bioinfo-training', redirect_uri: redirectUri, response_type: 'code',
    scope: 'openid profile email groups', state: 'st-e2e',
    code_challenge: challenge, code_challenge_method: 'S256', nonce: 'n-e2e',
  });
  const authRes = await fetch(`${BASE}/oidc/authorize?${q}`, { headers: { cookie }, redirect: 'manual' });
  const loc = authRes.headers.get('location') || '';
  const code = new URL(loc, BASE).searchParams.get('code');
  record('authorize 签发授权码', authRes.status === 302 && !!code, `status=${authRes.status}`);

  // 4) token 交换 + 验签
  const tokRes = await fetch(`${BASE}/oidc/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: code || '', redirect_uri: redirectUri,
      client_id: 'bioinfo-training', client_secret: 'labspace-oidc-2026', code_verifier: verifier,
    }).toString(),
  });
  const tok = await tokRes.json().catch(() => ({}));
  record('token 端点签发 RS256 id_token', tokRes.status === 200 && (tok.id_token || '').split('.').length === 3);
  if (tok.id_token) {
    const payload = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString());
    const header = JSON.parse(Buffer.from(tok.id_token.split('.')[0], 'base64url').toString());
    record('id_token claims 正确', header.alg === 'RS256' && payload.iss === `${BASE}/oidc` && payload.aud === 'bioinfo-training' && payload.nonce === 'n-e2e');
    const uiRes = await fetch(`${BASE}/oidc/userinfo`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    const ui = await uiRes.json().catch(() => ({}));
    record('userinfo 返回身份', uiRes.status === 200 && ui.email === 'student01@lab.local', `email=${ui.email}`);
  }

  // 5) 生信平台凭门户会话 SSO 落到自己的工作台
  const sso = await ctx.newPage();
  await sso.goto(`${BASE}/apps/bioinfo/api/v1/auth/login?back=${encodeURIComponent('/apps/bioinfo/')}`, { waitUntil: 'domcontentloaded' });
  await sso.waitForTimeout(4000);
  record('生信平台 SSO 落到工作台', sso.url().includes('/apps/bioinfo/dashboard'), sso.url().slice(0, 90));
} finally {
  await b.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
