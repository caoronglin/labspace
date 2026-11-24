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

  await page.goto(`${BASE}/agent?mode=lab`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(u => u.pathname === '/workbench' && u.searchParams.get('tab') === 'records', { timeout: 20000 });
  record('旧 Agent 实验记录深链重定向到个人工作台', new URL(page.url()).pathname === '/workbench');
} finally {
  await browser.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
