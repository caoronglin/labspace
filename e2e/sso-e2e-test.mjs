// 一键登录（SSO）下线守卫。
//
// 历史：这个脚本原本验证「门户 → Open WebUI / Quantum 一键登录免密」。
// 两个服务（Open WebUI :3000 / Quantum :8080）都已下线，原断言没有可测对象。
// 现在反向守卫：这些服务的路由/端口必须确实下线，将来若重新接入带 OIDC 的
// 服务，按 sso-flow.mjs 的「在线才判定」模式补回正向断言。
import { chromium } from 'playwright';

const BASE = process.env.LAB_BASE || 'http://127.0.0.1';
let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();

// 1) Quantum 的门户路由已下线：不应再出现「一键登录」入口。
{
  await page.goto(`${BASE}/services/quantum`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const hasSsoButton = await page.locator('button:has-text("一键登录")').count().catch(() => 0);
  record('Quantum 路由已下线（无一键登录入口）', hasSsoButton === 0,
    hasSsoButton === 0 ? body.slice(0, 80) : `仍出现一键登录按钮`);
}

// 2) 直连端口不可达（服务确实没在跑）。
{
  const resp = await page.goto(`${BASE}:8080/files/`, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null);
  record('Quantum 端口 :8080 已关闭', resp === null, resp ? `仍返回 ${resp.status()}` : '连接失败（预期）');
}

await browser.close();
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
