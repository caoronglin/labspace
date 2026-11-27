// 侧栏折叠与子菜单交互回归。
//
// 覆盖三种真实形态：
// 1. 折叠态悬浮展开 -> vertical 弹层，hover 打开、鼠标可移入弹层并跳转；
// 2. 固定展开 -> inline 菜单，click 打开、状态保持；
// 3. 移动端 Drawer -> inline 菜单，click 打开、跳转后关闭。
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
  await p.waitForTimeout(1500);
  const openCount = () => p.locator('.ant-menu-submenu-open').count();

  record('折叠态默认无展开子菜单', (await openCount()) === 0);

  // 悬浮展开为 vertical 弹层菜单
  await p.mouse.move(34, 300);
  await p.waitForTimeout(600);
  const titles = p.locator('.ant-menu-submenu-title');
  const total = await titles.count();
  record('悬浮展开且有子菜单', total >= 2, `子菜单 ${total} 个`);
  record('悬浮展开使用 vertical 模式', (await p.locator('.ant-menu-vertical:visible').count()) === 1,
    `可见 vertical 菜单 ${await p.locator('.ant-menu-vertical:visible').count()} 个`);
  const flyoutWidth = await p.locator('.d509-sider-shell .ant-layout-sider').evaluate((el) => el.getBoundingClientRect().width);
  record('悬浮展开实际拓宽侧栏', flyoutWidth >= 200, `宽度 ${Math.round(flyoutWidth)}px`);
  record('顶栏命令面板按钮不重复', (await p.locator('.ant-layout-header button[data-tour="cmdk"]').count()) === 1);
  const submenuLabels = await titles.allTextContents();
  record('侧栏子菜单名称不跨组重复', new Set(submenuLabels).size === submenuLabels.length,
    submenuLabels.join(' / '));

  const firstTitle = titles.first();
  await firstTitle.hover();
  await p.waitForTimeout(500);
  const popup = p.locator('.ant-menu-submenu-popup:visible');
  record('hover 子菜单标题出现弹层', (await popup.count()) === 1, `弹层 ${await popup.count()} 个`);
  record('hover 后 aria-expanded=true', (await firstTitle.getAttribute('aria-expanded')) === 'true');

  // 鼠标从标题移入弹层，弹层不能因侧栏 mouseleave 消失
  const popupLink = popup.locator('a').first();
  const popupHref = await popupLink.getAttribute('href');
  await popupLink.hover();
  await p.waitForTimeout(250);
  record('鼠标可移入子弹菜单', (await popup.count()) === 1);
  if (popupHref) {
    await popupLink.click();
    await p.waitForURL((u) => u.pathname === popupHref, { timeout: 10000 });
  }
  record('子弹菜单项可跳转', Boolean(popupHref) && new URL(p.url()).pathname === popupHref, popupHref || '未找到链接');

  // 固定展开态仍保留 inline click 交互
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await p.mouse.move(800, 200);
  await p.waitForTimeout(400);
  await p.getByRole('button', { name: '展开侧栏' }).click();
  await p.waitForTimeout(400);
  record('固定展开使用 inline 模式', (await p.locator('.ant-menu-inline').count()) === 1);
  const inlineTitles = p.locator('.ant-menu-submenu-title');
  await inlineTitles.first().click();
  await p.waitForTimeout(350);
  record('固定展开点击可打开子菜单', (await openCount()) === 1, `展开数=${await openCount()}`);
  const inlineLink = p.locator('.ant-menu-submenu-open a').first();
  const inlineHref = await inlineLink.getAttribute('href');
  if (inlineHref) {
    await inlineLink.click();
    await p.waitForURL((u) => u.pathname === inlineHref, { timeout: 10000 });
  }
  record('inline 子菜单项可跳转', Boolean(inlineHref) && new URL(p.url()).pathname === inlineHref, inlineHref || '未找到链接');

  // 移动端 Drawer
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(800);
  await p.getByRole('button', { name: '打开导航菜单' }).click();
  await p.locator('.ant-drawer-content-wrapper').waitFor({ state: 'visible' });
  const mobileTitles = p.locator('.ant-drawer-content-wrapper .ant-menu-submenu-title');
  record('移动端抽屉显示子菜单', (await mobileTitles.count()) >= 2, `子菜单 ${await mobileTitles.count()} 个`);
  await mobileTitles.first().click();
  await p.waitForTimeout(300);
  record('移动端子菜单可展开', (await p.locator('.ant-drawer-content-wrapper .ant-menu-submenu-open').count()) >= 1);
  const mobileLink = p.locator('.ant-drawer-content-wrapper .ant-menu-submenu-open a').first();
  const mobileHref = await mobileLink.getAttribute('href');
  if (mobileHref) {
    await mobileLink.click();
    await p.waitForURL((u) => u.pathname === mobileHref, { timeout: 10000 });
    await p.locator('.ant-drawer-content-wrapper').waitFor({ state: 'hidden', timeout: 10000 });
  }
  record('移动端子菜单可跳转并关闭抽屉', Boolean(mobileHref) && new URL(p.url()).pathname === mobileHref, mobileHref || '未找到链接');

  await p.screenshot({ path: new URL('./shots/', import.meta.url).pathname + 'sider-collapse.png', fullPage: false });
} finally {
  await b.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
