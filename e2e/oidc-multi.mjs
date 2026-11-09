// 多入口 OIDC 验证：LAN IP / Tailscale IP / 域名别名
import { chromium } from 'playwright';
const user = process.env.LAB_USER || 'student01';
const pass = process.env.LAB_PASS;

async function flow(base, label) {
  const b = await chromium.launch({args:['--no-sandbox']});
  const p = await (await b.newContext({locale:'zh-CN'})).newPage();
  let authUrl = '';
  try {
    await p.goto(`${base}/login`, {waitUntil:'domcontentloaded'});
    await p.waitForTimeout(3500);
    authUrl = p.url();
    await p.waitForSelector('input[type="password"]', {timeout:15000});
    await p.locator('input[type="text"], input:not([type])').first().fill(user);
    await p.locator('input[type="password"]').first().fill(pass);
    await p.getByRole('button', {name:/登录|Login/}).first().click();
    await p.waitForTimeout(6000);
    const body = (await p.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ');
    const ok = /工作台|全部服务|我的收藏/.test(body);
    console.log(`  [${label}] 授权端点: ${authUrl.split('?')[0]}`);
    console.log(`  [${label}] 回调落地: ${p.url().split('?')[0]} | 登录成功: ${ok}`);
    await p.screenshot({path:`/opt/labspace/e2e/shots/oidc-${label}.png`});
    await b.close();
    return {ok, authUrl};
  } catch (e) {
    console.log(`  [${label}] 失败: ${String(e).split('\n')[0]}`);
    console.log(`  [${label}] 停在: ${p.url().split('?')[0]}`);
    await b.close();
    return {ok:false, authUrl};
  }
}

const r1 = await flow('http://192.0.2.10', 'lan');
const r2 = await flow('http://198.51.100.71', 'tailscale');
console.log('汇总: LAN', r1.ok ? 'OK':'FAIL', '| Tailscale', r2.ok ? 'OK':'FAIL');
