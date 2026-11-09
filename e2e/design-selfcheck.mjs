// 门户前端「动效与设计系统」自检脚本
// 依据 /opt/labspace/docs/DESIGN_SELF_CHECK.md 的自检表逐项断言：
//   - 控制台无错误
//   - 390 / 768 / 1440 三档无横向溢出
//   - 主标题存在
//   - :focus-visible 焦点态可见（描边或光晕）
//   - .d509-enter 元素最终 opacity = 1 且 transform = none
//   - prefers-reduced-motion: reduce 下动画被禁用
// 用法：LAB_PASS=<密码> node design-selfcheck.mjs
import { mkdirSync } from 'node:fs';
import { launch, loginContext, BASE } from './_auth.mjs';

const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const PAGES = [
  { path: '/', key: 'home', title: '首页' },
  { path: '/services', key: 'services', title: '全部服务' },
  { path: '/databases', key: 'databases', title: '数据库' },
  { path: '/workbench', key: 'workbench', title: '个人工作台' },
  { path: '/agent', key: 'agent', title: 'Agent' },
  { path: '/search', key: 'search', title: '统一搜索' },
  { path: '/devtools', key: 'devtools', title: '开发工具箱' },
];

const VIEWPORTS = [
  { key: 'mobile', width: 390, height: 844 },
  { key: 'tablet', width: 768, height: 1024 },
  { key: 'desktop', width: 1440, height: 900 },
];

const failures = [];
const notes = [];
let checks = 0;

function fail(where, msg) {
  failures.push(`${where} :: ${msg}`);
  console.log(`  ✗ ${where} :: ${msg}`);
}
function pass(where, msg) {
  checks += 1;
  console.log(`  ✓ ${where} :: ${msg}`);
}
function note(where, msg) {
  notes.push(`${where} :: ${msg}`);
  console.log(`  · ${where} :: ${msg}`);
}

const IDENTITY = /^(none|matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\))$/;

async function collectConsole(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

// 标题候选：语义标题 + 组件标题 + 面包屑末项 + 页面标题区
const TITLE_QUERY = [
  'h1', 'h2', 'h3',
  '[role="heading"]',
  '.ant-card-head-title',
  '.ant-breadcrumb li:last-child',
  '.d509-page-header',
  '.d509-page-title',
  '.ant-segmented-item-selected',
].join(',');

async function readTitles(page) {
  return page.evaluate((sel) => {
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) out.push(text);
    }
    return { titles: out, docTitle: document.title };
  }, TITLE_QUERY);
}

async function checkOverflow(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const overflow = de.scrollWidth - de.clientWidth;
    const offenders = [];
    if (overflow > 2) {
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > de.clientWidth + 2 || r.left < -2) {
          const cs = getComputedStyle(el);
          if (cs.position === 'fixed' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
          offenders.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} right=${Math.round(r.right)}`);
          if (offenders.length >= 5) break;
        }
      }
    }
    return { overflow, offenders };
  });
}

async function checkEnterState(page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('.d509-enter'));
    return nodes.slice(0, 8).map((el) => {
      const cs = getComputedStyle(el);
      return {
        opacity: cs.opacity,
        transform: cs.transform,
        animationName: cs.animationName,
        animationPlayState: cs.animationPlayState,
        rect: el.getBoundingClientRect().height,
      };
    });
  });
}

async function checkFocusVisible(page) {
  // 通过键盘 Tab 聚焦，检查是否命中 :focus-visible 且有可见焦点样式
  for (let i = 0; i < 18; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      let visible = false;
      try {
        visible = el.matches(':focus-visible');
      } catch {
        visible = false;
      }
      const cs = getComputedStyle(el);
      const outlineWidth = parseFloat(cs.outlineWidth) || 0;
      const outlineVisible = cs.outlineStyle !== 'none' && outlineWidth > 0;
      const shadow = cs.boxShadow;
      const shadowVisible = shadow && shadow !== 'none' && /rgb/.test(shadow);
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 60),
        focusVisible: visible,
        outlineVisible,
        shadowVisible,
        onScreen: rect.width > 0 && rect.height > 0,
      };
    });
    if (info && info.focusVisible && info.onScreen) {
      if (info.outlineVisible || info.shadowVisible) {
        return { ok: true, ...info };
      }
      return { ok: false, reason: 'focus-visible 生效但无 outline/box-shadow', ...info };
    }
  }
  return { ok: false, reason: 'Tab 序列中未找到可见的 :focus-visible 元素' };
}

async function checkReducedMotion(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.d509-enter');
    if (!el) return { found: false };
    const cs = getComputedStyle(el);
    const animDisabled = cs.animationName === 'none';
    const transDisabled = cs.transitionDuration.split(',').every((d) => parseFloat(d) === 0);
    return {
      found: true,
      animationName: cs.animationName,
      animationDuration: cs.animationDuration,
      transitionDuration: cs.transitionDuration,
      transform: cs.transform,
      animDisabled,
      transDisabled,
    };
  });
}

const browser = await launch();
const ctx = await loginContext(browser, BASE);

try {
  // ---------- 每页 × 每视口 ----------
  for (const vp of VIEWPORTS) {
    console.log(`\n== 视口 ${vp.key} (${vp.width}x${vp.height}) ==`);
    const page = await ctx.newPage();
    const errors = await collectConsole(page);

    for (const target of PAGES) {
      const where = `${target.key}@${vp.key}`;
      const url = `${BASE}${target.path}`;
      errors.length = 0;
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1800);

      // 构建期间 chunk 哈希可能变更导致一次性加载失败，重试一次
      if (errors.some((t) => /Failed to fetch dynamically imported module/i.test(t))) {
        errors.length = 0;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1800);
      }

      // 1) 控制台错误
      const realErrors = errors.filter((t) => !/favicon|Failed to load resource/i.test(t));
      if (realErrors.length === 0) pass(`${where} console`, '无控制台错误');
      else fail(`${where} console`, `出现 ${realErrors.length} 条控制台错误：${realErrors[0].slice(0, 160)}`);

      // 2) 横向溢出
      const ov = await checkOverflow(page);
      if (ov.overflow <= 2) pass(`${where} overflow`, `scrollWidth-clientWidth=${ov.overflow}`);
      else fail(`${where} overflow`, `横向溢出 ${ov.overflow}px：${ov.offenders.join(' | ') || '未定位到元素'}`);

      // 3) 主标题
      const { titles, docTitle } = await readTitles(page);
      if (titles.length === 0) {
        fail(`${where} title`, '页面未找到任何可见标题元素');
      } else {
        const hit = titles.find((t) => t.includes(target.title));
        if (hit) pass(`${where} title`, `主标题命中「${hit.slice(0, 30)}」`);
        else note(`${where} title`, `标题候选：${titles.slice(0, 3).join(' / ').slice(0, 80)}（文档标题：${docTitle}）`);
      }

      // 4) 焦点态可见
      const focus = await checkFocusVisible(page);
      if (focus.ok) pass(`${where} focus`, `focus-visible 生效于 <${focus.tag}> 且有 ${focus.outlineVisible ? 'outline' : 'box-shadow'}`);
      else fail(`${where} focus`, focus.reason);

      // 5) 入场动画终态
      const enters = await checkEnterState(page);
      if (enters.length === 0) {
        note(`${where} enter`, '本页未使用 .d509-enter（无入场动画）');
      } else {
        const bad = enters.filter((e) => Number(e.opacity) !== 1 || !IDENTITY.test(e.transform));
        if (bad.length === 0) pass(`${where} enter`, `${enters.length} 个 .d509-enter 终态 opacity=1 且 transform=none`);
        else fail(`${where} enter`, `动画终态异常：${JSON.stringify(bad[0])}`);
      }

      await page.screenshot({ path: `${SHOTS}design-${target.key}-${vp.key}.png`, fullPage: vp.key === 'desktop' });
    }

    await page.close();
  }

  // ---------- 降低动效偏好 ----------
  console.log('\n== prefers-reduced-motion: reduce ==');
  const rmPage = await ctx.newPage();
  await rmPage.emulateMedia({ reducedMotion: 'reduce' });
  await rmPage.setViewportSize({ width: 1440, height: 900 });
  await rmPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await rmPage.waitForTimeout(1200);
  const rm = await checkReducedMotion(rmPage);
  if (!rm.found) {
    fail('reduced-motion', '首页未找到 .d509-enter 元素，无法验证降级');
  } else if (rm.animDisabled || rm.transDisabled) {
    pass('reduced-motion', `动画已禁用（animation-name=${rm.animationName}，transition-duration=${rm.transitionDuration}，transform=${rm.transform}）`);
  } else {
    fail('reduced-motion', `动画未禁用：animation-name=${rm.animationName}，transition-duration=${rm.transitionDuration}`);
  }
  await rmPage.screenshot({ path: `${SHOTS}design-home-reduced.png`, fullPage: false });
  await rmPage.close();
} finally {
  await ctx.close();
  await browser.close();
}

console.log(`\n==== 自检结果：通过 ${checks} 项，失败 ${failures.length} 项，提醒 ${notes.length} 项 ====`);
if (notes.length) {
  console.log('提醒：');
  for (const n of notes) console.log(`  · ${n}`);
}
if (failures.length) {
  console.log('失败：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✅');
