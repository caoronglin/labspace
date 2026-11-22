// 侧栏折叠回归：折叠图标栏 ↔ 悬浮展开之间，子菜单展开状态必须保持。
// 曾因 onOpenChange 在折叠态收到 AntD 清空的空数组、覆盖 state，导致
// 用户展开子菜单后鼠标一离开就全收起，回来还得重新点。
import { launch, loginContext, BASE } from './_auth.mjs';
const b = await launch();
const ctx = await loginContext(b);
const p = await ctx.newPage();
await p.setViewportSize({ width: 1440, height: 900 });
await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1800);
const n = () => p.locator('.ant-menu-submenu-open').count();
await p.mouse.move(34, 300); await p.waitForTimeout(500);
const subs = p.locator('.ant-menu-submenu-title');
const cnt = await subs.count();
let pass = 0, fail = 0;
const rec = (name, ok) => { ok ? pass++ : fail++; console.log(`  ${ok?'[ OK ]':'[FAIL]'} ${name}`); };
rec('折叠态默认无展开子菜单', await n() === 0);
rec('存在子菜单项', cnt > 0);
if (cnt) {
  await subs.first().click(); await p.waitForTimeout(400);
  const opened = await n();
  rec('点击后子菜单展开', opened > 0);
  await p.mouse.move(700, 300); await p.waitForTimeout(500);
  rec('鼠标离开后保持展开', await n() === opened);
  await p.mouse.move(34, 300); await p.waitForTimeout(500);
  rec('再次悬浮后仍保持展开', await n() === opened);
  await p.screenshot({ path: new URL('./shots/', import.meta.url).pathname + 'sider-collapse.png' });
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
await b.close();
process.exit(fail ? 1 : 0);
