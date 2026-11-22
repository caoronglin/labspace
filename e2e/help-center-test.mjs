// 帮助中心端到端：验证重构后的内容区块、FAQ 新条目、搜索过滤与版本展示。
//
// 帮助内容已从 Help.tsx 抽到 content/helpContent.tsx（快速上手 / 角色入口 / FAQ），
// 本用例守住「内容没丢、旧服务说明没残留、版本号指向最新、搜索能过滤」四件事。
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
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e).slice(0, 100)));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 100)); });

  await p.goto(`${BASE}/help`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  const body = (await p.locator('body').innerText()).replace(/\s+/g, ' ');

  for (const [name, text] of [
    ['页面标题', '帮助中心'],
    ['快速上手区块', '快速上手'],
    ['服务地图区块', '服务地图'],
    ['常见问题区块', '常见问题'],
    ['访问与诊断区块', '访问与诊断'],
    ['更新日志区块', '更新日志'],
  ]) record(name, body.includes(text));

  // 新增 FAQ 必须在（重构时补的两节）
  record('FAQ：代码预览', body.includes('怎么预览源代码文件'));
  record('FAQ：多维表格', body.includes('多维表格能做什么'));
  // 已下线服务不得残留（历史上 CropGenome 说明一直挂在 FAQ 里误导用户）
  record('无已下线服务残留', !body.includes('CropGenome') && !body.includes('Quantum'));
  // 版本号指向最新条目（更新弹窗与帮助中心共用 RELEASES[0]）
  record('版本号指向最新版本', body.includes('2026.11.22.1'));

  // 搜索过滤：输入关键词后应只剩相关 FAQ
  await p.getByPlaceholder(/搜索功能/).fill('代码预览');
  await p.waitForTimeout(700);
  const after = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
  record('搜索过滤出代码预览 FAQ', after.includes('怎么预览源代码文件'));
  record('搜索过滤掉无关 FAQ', !after.includes('多维表格能做什么'));

  record('无控制台错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  await p.screenshot({ path: new URL('./shots/', import.meta.url).pathname + 'help-center.png', fullPage: false });
} finally {
  await b.close();
}
console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
