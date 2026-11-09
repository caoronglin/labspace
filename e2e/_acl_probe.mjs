// 非管理员 ACL 探针：临时账号 → 校验管理面拦截 → 硬删除
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const BASE='http://192.0.2.10';
const line = readFileSync('/etc/labspace/casdoor-users.txt','utf8').split('\n').find(l=>l.trim().startsWith('labadmin@local '));
const [adminUser, adminPass] = line.trim().split(/\s+/);
const name = `aclprobe${Date.now().toString(36)}`;
const pwd = randomBytes(16).toString('base64url');
const browser = await chromium.launch({args:['--no-sandbox']});
const out = {name, created:false, deleted:false, api:[], pages:{}};
const adminCtx = await browser.newContext();
const admin = await adminCtx.newPage();
async function login(page, u, p) {
  await page.goto(`${BASE}/login`, {waitUntil:'domcontentloaded'});
  await page.waitForSelector('input[type="password"]', {timeout:30000});
  await page.locator('input[type="text"], input:not([type])').first().fill(u);
  await page.locator('input[type="password"]').first().fill(p);
  await page.getByRole('button', {name:/登录|Login/}).first().click();
  await page.waitForURL(u2=>u2.hostname==='192.0.2.10' && u2.port==='' && !/\/login/.test(u2.pathname), {timeout:45000});
  await page.waitForTimeout(2500);
}
try {
  await login(admin, adminUser, adminPass);
  out.created = await admin.evaluate(async ({name,pwd}) => {
    const csrf = document.cookie.split('; ').find(c=>c.startsWith('labspace_csrf='))?.split('=')[1] || '';
    const r = await fetch('/api/admin/accounts', {method:'POST', credentials:'include', headers:{'Content-Type':'application/json','X-CSRF-Token':decodeURIComponent(csrf)}, body: JSON.stringify({name, displayName:'ACL 探针', groups:['lab-student'], password:pwd})});
    return r.ok;
  }, {name, pwd});
  if (!out.created) throw new Error('临时账号创建失败');

  const userCtx = await browser.newContext();
  const page = await userCtx.newPage();
  await login(page, name, pwd);
  out.api = await page.evaluate(async (nm) => {
    window.__aclnm = nm;
    const get = async (u, o={}) => { try { const r = await fetch(u, {credentials:'include', ...o}); return {u, status:r.status}; } catch(e) { return {u, err:String(e)}; } };
    const list = [['/api/admin/accounts'],['/api/admin/health'],['/api/agent/admin/config'],['/api/admin/accounts/groups'],['/api/knowledge/spaces'],['/api/knowledge?page=1&pageSize=5'],['/api/files/sources']];
    const base = await Promise.all(list.map(([u])=>get(u)));
    const srcRes = await fetch('/api/files/sources', {credentials:'include'});
    const srcJson = await srcRes.json().catch(()=>({}));
    const srcs = (srcJson.sources||[]).filter(s=>s.listable).map(s=>s.id);
    const per = await Promise.all(srcs.map(id=>get('/api/files?source='+encodeURIComponent(id)+'&sort=name&order=asc')));
    const usersRes = await fetch('/api/files?source=users&sort=name&order=asc', {credentials:'include'});
    const usersJson = await usersRes.json().catch(()=>({}));
    const owners = [...new Set((usersJson.entries||[]).map(e=>e.owner).filter(Boolean))];
    const selfPaths = (usersJson.entries||[]).map(e=>e.path).slice(0,5);
    const csrf = document.cookie.split('; ').find(c=>c.startsWith('labspace_csrf='))?.split('=')[1] || '';
    const hdr = {'Content-Type':'application/json','X-CSRF-Token':decodeURIComponent(csrf)};
    const mk = async (source, p) => { const r = await fetch('/api/files/mkdir', {method:'POST', credentials:'include', headers:hdr, body: JSON.stringify({source, path:p})}); const j = await r.json().catch(()=>({})); return {source, status:r.status, id:j?.entry?.id}; };
    const pub = await mk('public','aclprobe-tmp');
    const mine = await mk('users', window.__aclnm + '/aclprobe-tmp');
    let cleanup = null;
    if (mine.id) { const r = await fetch('/api/files/'+encodeURIComponent(mine.id), {method:'DELETE', credentials:'include', headers:hdr}); cleanup = r.status; }
    return {base, sources: srcs, per, owners, selfPaths, homePath: window.__aclnm, write: {public: pub.status, users: mine.status, cleanup}};
  }, name);
  for (const route of ['/admin/users','/admin/announcements','/files','/knowledge']) {
    await page.goto(BASE+route, {waitUntil:'domcontentloaded'});
    await page.waitForTimeout(1600);
    const t = (await page.locator('body').innerText()).slice(0,220);
    out.pages[route] = {forbidden:/无访问权限|仅限 lab-admin/.test(t), crash:/出错了|页面出现异常/.test(t), snippet: t.replace(/\s+/g,' ').slice(0,90)};
  }
  await userCtx.close();
} finally {
  try {
    out.deleted = await admin.evaluate(async ({name}) => {
      const csrf = document.cookie.split('; ').find(c=>c.startsWith('labspace_csrf='))?.split('=')[1] || '';
      const r = await fetch(`/api/admin/accounts/${encodeURIComponent(name)}`, {method:'DELETE', credentials:'include', headers:{'Content-Type':'application/json','X-CSRF-Token':decodeURIComponent(csrf)}, body: JSON.stringify({confirm:name})});
      return r.ok;
    }, {name});
  } catch {}
  await browser.close();
}
console.log(JSON.stringify(out, null, 1));
