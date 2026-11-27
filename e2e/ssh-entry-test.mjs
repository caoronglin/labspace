// 门户 SSH 工作台入口与账号隔离回归。
import { randomBytes } from 'node:crypto';
import { launch, loginContext, BASE } from './_auth.mjs';

let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' - ' + detail : ''}`);
};

const browser = await launch();
const contexts = [];
try {
  const ctx = await loginContext(browser);
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/ssh`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'SSH 工作台' }).waitFor({ state: 'visible', timeout: 20000 });
  record('门户 SSH 路由可访问', true);
  await page.getByRole('button', { name: '新建连接' }).click();
  await page.getByLabel('连接名称').waitFor({ state: 'visible' });
  record('新建连接表单可打开', true);
  await page.locator('.ant-modal-close').click();

  const anonymous = await browser.newContext();
  contexts.push(anonymous);
  const anonymousStatus = await anonymous.request.get(`${BASE}/ssh-api/api/connections`, { maxRedirects: 0 }).then((r) => r.status());
  record('未登录访问 SSH API 被拒绝', anonymousStatus === 401 || anonymousStatus === 302, `status=${anonymousStatus}`);

  const name = `e2e-ssh-${randomBytes(4).toString('hex')}`;
  const password = randomBytes(18).toString('base64url');
  const created = await page.evaluate(async ({ name, password }) => {
    const csrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '');
    const response = await fetch('/ssh-api/api/connections', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ name, host: '127.0.0.1', port: 22, username: 'e2e', auth_type: 'password', password }),
    });
    return { status: response.status, body: await response.json() };
  }, { name, password });
  const connection = created.body?.connection;
  record('SSH 连接可加密保存', created.status === 201 && Boolean(connection?.id), `status=${created.status}`);
  record('API 不返回 SSH 凭据', Boolean(connection) && !('password' in connection) && !('secret_ciphertext' in connection));

  const listed = await page.evaluate(async () => {
    const response = await fetch('/ssh-api/api/connections', { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  });
  record('本人可读取已保存连接', listed.status === 200 && listed.body.connections.some((item) => item.name === name));

  const admin = await browser.newContext({ locale: 'zh-CN' });
  contexts.push(admin);
  const adminPage = await admin.newPage();
  await adminPage.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await adminPage.locator('#username').fill(process.env.LAB_ADMIN_USER || 'labadmin');
  await adminPage.locator('input[type="password"]').first().fill(process.env.LAB_ADMIN_PASS || '');
  await adminPage.locator('button.ant-btn-primary').first().click();
  await adminPage.waitForTimeout(4000);
  const adminList = await adminPage.evaluate(async () => {
    const response = await fetch('/ssh-api/api/connections', { credentials: 'include' });
    return { status: response.status, body: await response.json() };
  });
  record('其他账号看不到我的 SSH 连接', adminList.status === 200 && !adminList.body.connections.some((item) => item.name === name));

  const rejected = await page.evaluate(async () => {
    const csrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '');
    const response = await fetch('/ssh-api/api/connections', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ name: 'e2e-public-target', host: '8.8.8.8', port: 22, username: 'e2e', auth_type: 'password', password: 'not-used' }),
    });
    return { status: response.status, body: await response.json() };
  });
  record('公网 SSH 目标被白名单拒绝', rejected.status === 403, `status=${rejected.status}`);

  if (connection?.id) {
    const deleted = await page.evaluate(async (id) => {
      const csrf = decodeURIComponent((document.cookie.split('; ').find((c) => c.startsWith('labspace_csrf=')) || '').split('=')[1] || '');
      const response = await fetch(`/ssh-api/api/connections/${id}`, { method: 'DELETE', credentials: 'include', headers: { 'X-CSRF-Token': csrf } });
      return response.status;
    }, connection.id);
    record('测试连接已清理', deleted === 200 || deleted === 204, `status=${deleted}`);
  }
  record('SSH 页面无运行时异常', errors.length === 0, errors.join(' | '));
  await page.screenshot({ path: new URL('./shots/', import.meta.url).pathname + 'ssh-workspace.png', fullPage: false });
} finally {
  await Promise.all(contexts.map((ctx) => ctx.close()));
  await browser.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
