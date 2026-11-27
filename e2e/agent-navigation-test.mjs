// Agent 入口收敛回归：对话 / 知识与记忆 / 能力中心，旧实验记录深链回工作台。
import { launch, loginContext, BASE } from './_auth.mjs';

let pass = 0, fail = 0;
const record = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ` - ${detail}` : ''}`);
};

const browser = await launch();
try {
  const ctx = await loginContext(browser);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/agent`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ant-segmented-item', { timeout: 20000 });

  const labels = await page.locator('.ant-segmented-item').allTextContents();
  record('Agent 一级入口收敛为三项', labels.join('|') === 'Agent 对话|知识与记忆|能力中心', labels.join('|'));
  record('Agent 不再保留实验记录重复模式', !labels.includes('实验记录'));

  // 全站上下文交接：当前页 → Agent 输入框，读后即焚。
  await page.goto(`${BASE}/workbench`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '让 Agent 分析当前页' }).click();
  await page.waitForURL((u) => u.pathname === '/agent');
  await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('textarea')?.value.includes('/workbench'), null, { timeout: 10000 });
  const handoffText = await page.locator('textarea').first().inputValue();
  record('全站 Agent 入口预填当前页上下文', handoffText.includes('/workbench') && handoffText.includes('页面上下文'), handoffText.slice(0, 80));
  record('Agent 交接只注入一次', (await page.evaluate(() => sessionStorage.getItem('labspace.agent.handoff'))) === null);

  await page.locator('.ant-segmented-item').filter({ hasText: '知识与记忆' }).click();
  await page.waitForURL(u => u.searchParams.get('mode') === 'kb');
  const tabLabels = await page.locator('.ant-tabs-tab').allTextContents();
  record('知识与记忆合并问答和长期记忆', tabLabels.some(t => t.includes('知识库问答')) && tabLabels.some(t => t.includes('长期记忆')), tabLabels.join('|'));

  await page.locator('.ant-tabs-tab').filter({ hasText: '长期记忆' }).click();
  await page.waitForURL(u => u.searchParams.get('view') === 'memory');
  record('长期记忆支持可分享深链', new URL(page.url()).searchParams.get('view') === 'memory');

  await page.locator('.ant-segmented-item').filter({ hasText: 'Agent 对话' }).click();
  await page.waitForURL(u => !u.searchParams.get('mode'));
  const memoryButton = page.locator('button').filter({ hasText: /^记忆/ }).first();
  await memoryButton.waitFor({ state: 'visible', timeout: 10000 });
  await memoryButton.click();
  await page.waitForURL(u => u.searchParams.get('mode') === 'kb' && u.searchParams.get('view') === 'memory');
  record('对话工具栏记忆按钮统一进入知识与记忆', true);

  await page.locator('.ant-segmented-item').filter({ hasText: '能力中心' }).click();
  await page.waitForURL(u => u.searchParams.get('mode') === 'hub');
  const hubTabs = await page.locator('.ant-tabs-tab').allTextContents();
  record('能力中心保留技能/MCP', hubTabs.some(t => t.includes('技能 / MCP')), hubTabs.join('|'));
  record('能力中心移除重复知识库页签', !hubTabs.some(t => t === '知识库'));

  // 移动端会话抽屉：折叠布局下仍可切换历史会话。
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/agent`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ant-segmented-item', { timeout: 20000 });
  const mobileSessionButton = page.locator('button').filter({ hasText: /^会话$/ }).first();
  await mobileSessionButton.waitFor({ state: 'visible', timeout: 20000 });
  await mobileSessionButton.click();
  const sessionDrawer = page.locator('.ant-drawer-content-wrapper');
  await sessionDrawer.waitFor({ state: 'visible', timeout: 10000 });
  record('移动端 Agent 会话抽屉可打开', await sessionDrawer.getByPlaceholder('搜索会话').count() === 1);
  await sessionDrawer.locator('.ant-drawer-close').click();
  await sessionDrawer.waitFor({ state: 'hidden', timeout: 10000 });
  record('移动端 Agent 会话抽屉可关闭', true);

  await page.goto(`${BASE}/agent?mode=lab`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(u => u.pathname === '/workbench' && u.searchParams.get('tab') === 'records', { timeout: 20000 });
  record('旧 Agent 实验记录深链重定向到个人工作台', new URL(page.url()).pathname === '/workbench');
} finally {
  await browser.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
