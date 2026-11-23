// 侧栏折叠与子菜单展开回归。
//
// 守住两件事：
// 1. 子菜单 key 按分组唯一——历史上「实用工具」等 sub 标签跨分组共用
//    `sub:${sk}` key，AntD 把它们当同一逻辑子菜单，点开一个、其他分组的
//    同名子菜单跟着全部展开（实测点一个联动开三个）。
// 2. 展开状态跨「折叠 ↔ 悬浮展开」保持——AntD 模式切换时会回灌
//    空数组/部分 key 的快照，折叠态必须一律忽略 onOpenChange。
import { launch, loginContext, BASE } from './_auth.mjs';

let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`);
};

const b = await launch();
try {
  const ctx = await loginContext(b);
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1800);
  const openCount = () => p.locator('.ant-menu-submenu-open').count();

  // 折叠态默认无展开子菜单
  record('折叠态默认无展开子菜单', (await openCount()) === 0);

  // 悬浮展开
  await p.mouse.move(34, 300); await p.waitForTimeout(600);
  const titles = p.locator('.ant-menu-submenu-title');
  const total = await titles.count();
  record('悬浮展开且有子菜单', total >= 2, `子菜单 ${total} 个`);

  // 核心断言：点一个子菜单，只展开它自己（此前同名 key 跨组联动，点一个开三个）
  await titles.first().click(); await p.waitForTimeout(500);
  const afterFirst = await openCount();
  record('点开一个子菜单只展开它自己', afterFirst === 1, `展开数=${afterFirst}（应=1）`);

  // 再点另一个（不同分组），独立展开、互不影响
  await titles.nth(3).click(); await p.waitForTimeout(500);
  const afterSecond = await openCount();
  record('第二个子菜单独立展开', afterSecond === 2, `展开数=${afterSecond}（应=2）`);

  // 折叠（鼠标离开）再悬浮回来：两个都保持
  await p.mouse.move(700, 200); await p.waitForTimeout(600);
  await p.mouse.move(34, 300); await p.waitForTimeout(700);
  const afterReturn = await openCount();
  record('离开再回来展开状态保持', afterReturn === 2, `展开数=${afterReturn}（应=2）`);

  // 进入子菜单内的页面：所属子菜单自动展开（分组唯一 key 与 subKeyOfPath 同构）
  await p.locator('a[href="/pdf"]').first().click().catch(async () => {
    await p.goto(`${BASE}/pdf`, { waitUntil: 'domcontentloaded' });
  });
  await p.waitForTimeout(1200);
  const autoOpen = await openCount();
  record('进入子菜单页面自动展开所属项', autoOpen >= 1, `展开数=${autoOpen}`);

  await p.screenshot({ path: new URL('./shots/', import.meta.url).pathname + 'sider-collapse.png', fullPage: false });
} finally {
  await b.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
