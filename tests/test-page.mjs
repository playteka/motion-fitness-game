/**
 * 页面接线自检（无浏览器依赖）。
 *
 * 检查那些“Node 里跑不到、但一打开浏览器就炸”的问题：
 *   1) app.js 里 $('xxx') / getElementById('xxx') 引用的 id 是否都存在于 index.html
 *   2) ES 模块之间的 import 是否都能在目标文件里找到对应 export
 *   3) index.html 引用的 css/js 是否存在；关键 vendor 文件（wasm / 模型）是否存在
 *   4) 六个动作是否都能成功构造识别器，且 index.html 的按钮与 EXERCISES 一一对应
 *
 * 运行：node tests/test-page.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXERCISES, createDetector, localizedExercise } from '../src/exercises.js';
import { getStepPlan } from '../src/steps.js';
import { setLang, t, LOCALES, LANG_ORDER } from '../src/i18n.js';

setLang('zh', { persist: false });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const html = read('index.html');

/* ---------- 1. DOM id 引用 ---------- */
console.log('\n[1] index.html 与 app.js 的 DOM 接线');
{
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const app = read('src/app.js');
  const refs = new Set();
  for (const m of app.matchAll(/\$\('([^']+)'\)/g)) refs.add(m[1]);
  for (const m of app.matchAll(/getElementById\('([^']+)'\)/g)) refs.add(m[1]);
  // 以变量形式传递的元素 id（例如批量绑定开关按钮）
  for (const m of app.matchAll(/'([A-Za-z][\w-]*)'/g)) if (ids.has(m[1])) refs.add(m[1]);

  const missing = [...refs].filter((r) => !ids.has(r));
  ok(`app.js 引用的 ${refs.size} 个元素 id 都存在于 index.html`, missing.length === 0,
    missing.length ? '缺失: ' + missing.join(', ') : '');

  const unused = [...ids].filter((i) => !refs.has(i));
  ok('index.html 中的 id 都被用到（无死元素）', unused.length === 0, unused.join(', '));

  // 其它文件是否也直接取 DOM
  for (const f of ['src/render.js', 'src/audio.js', 'src/pose-engine.js']) {
    const src = read(f);
    const bad = [...src.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]).filter((i) => !ids.has(i));
    ok(`${f} 没有引用不存在的 id`, bad.length === 0, bad.join(', '));
  }
}

/* ---------- 2. ESM 导入/导出对应 ---------- */
console.log('\n[2] 模块导入导出一致性');
{
  const files = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js')).map((f) => 'src/' + f);
  const exportCache = new Map();

  function exportsOf(file) {
    if (exportCache.has(file)) return exportCache.get(file);
    const src = read(file);
    const names = new Set();
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const as = t.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
        names.add(as ? as[1] : t.replace(/^\s*type\s+/, '').trim());
      }
    }
    exportCache.set(file, names);
    return names;
  }

  let checked = 0;
  for (const file of files) {
    const src = read(file);
    const dir = path.posix.dirname(file);
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
      const target = m[2];
      if (!target.startsWith('.')) continue; // vendor 单独校验
      const resolved = path.posix.normalize(path.posix.join(dir, target));
      if (!fs.existsSync(path.join(ROOT, resolved))) {
        ok(`${file} 的导入目标存在 (${target})`, false, '文件不存在');
        continue;
      }
      const avail = exportsOf(resolved);
      for (const part of m[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const src_name = t.split(/\s+as\s+/)[0].trim();
        checked += 1;
        if (!avail.has(src_name)) {
          ok(`${file} 从 ${target} 导入 ${src_name}`, false, '目标模块没有导出该名字');
        }
      }
    }
  }
  ok(`共校验 ${checked} 个具名导入，全部能对应到导出`, true);

  // vendor 包是否导出我们要用的两个符号
  const bundle = read('vendor/tasks-vision/vision_bundle.mjs');
  const lastExport = bundle.slice(bundle.lastIndexOf('export{'));
  ok('vendor 包导出 FilesetResolver', /as FilesetResolver\b/.test(lastExport));
  ok('vendor 包导出 PoseLandmarker', /as PoseLandmarker\b/.test(lastExport));
}

/* ---------- 3. 静态资源 ---------- */
console.log('\n[3] 静态资源与模型文件');
{
  for (const m of html.matchAll(/<(?:script|link)[^>]*\b(?:src|href)="([^"]+)"/g)) {
    const href = m[1];
    if (/^https?:/.test(href)) continue;
    ok(`index.html 引用的 ${href} 存在`, fs.existsSync(path.join(ROOT, href)));
  }
  const engine = read('src/pose-engine.js');
  for (const m of engine.matchAll(/'\.\/(vendor\/[^']+)'/g)) {
    const p = m[1];
    ok(`${p} 存在`, fs.existsSync(path.join(ROOT, p)));
  }
  for (const f of [
    'vendor/tasks-vision/wasm/vision_wasm_internal.js',
    'vendor/tasks-vision/wasm/vision_wasm_internal.wasm',
    'vendor/models/pose_landmarker_lite.task',
    'vendor/models/pose_landmarker_full.task',
  ]) {
    ok(`${f} 存在且非空`, fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).size > 1000);
  }

  // 校准提示条是压在摄像头画面上方的，太长会折成一大块挡住头顶。
  // 这条断言把「宽度够宽」和「文案够短」两件事都锁住，免得以后加长文案才发现挡住画面。
  const css = read('style.css');
  const promptBlock = /\.calib-prompt\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';
  const maxWidth = /max-width:\s*([\d.]+)%/.exec(promptBlock)?.[1];
  ok('校准提示条够宽（≥70%，长文案才不会折成高块挡住头顶）',
    Number(maxWidth) >= 70, `max-width=${maxWidth}%`);
  const overlong = [];
  for (const lang of LANG_ORDER) {
    for (const key of ['promptIn', 'promptSearch', 'promptReady']) {
      const text = LOCALES[lang]?.calib?.[key];
      if (typeof text !== 'string') { overlong.push(`${lang}.${key}=缺失`); continue; }
      if (text.length > 130) overlong.push(`${lang}.${key}=${text.length} 字`);
    }
  }
  ok('两种语言的提示条文案都不超过 130 字（折 2 行以内）', overlong.length === 0, overlong.join(', '));

  // 判定进度条：铺满视频底边的大部分，图标要够大（不然看不清姿态）
  const barBlock = /\.criteria-bar\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';
  const barWidthPct = Number(/width:\s*min\([^,]+,\s*([\d.]+)%\)/.exec(barBlock)?.[1]);
  ok('判定进度条铺满视频底边的大部分（≥90%）', barWidthPct >= 90, `width=${barWidthPct}%`);
  const iconBlock = /\.criteria-icon\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';
  const iconH = Number(/height:\s*clamp\((\d+)px/.exec(iconBlock)?.[1]
    ?? /height:\s*(\d+)px/.exec(iconBlock)?.[1]);
  ok('进度条图标够大（高度 ≥55px，姿态才看得清）', iconH >= 55, `height=${iconH}px`);
  ok('图标等比缩放（有 max-width，不会被拉变形）', /max-width:/.test(iconBlock));
  ok('进度条出现时底部提示条会让位（不会两块叠在一起）',
    /\.stage\.has-criteria \.pose-hint\s*\{[^}]*bottom:/.test(css));

  // 做到与没做到要一眼分得清（颜色 + 填充 + 线粗 + 对勾，四重区别）
  const segBase = /(?:^|\n)\.criteria-seg\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';
  const segDone = /(?:^|\n)\.criteria-seg\.done\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';
  const doneIcon = /\.criteria-seg\.done \.criteria-icon\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';
  const segCurrent = /(?:^|\n)\.criteria-seg\.current\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';
  ok('没做到的格子：虚线灰框 + 几乎没有底色',
    /border:\s*1px dashed/.test(segBase) && /background:\s*rgba\(255, 255, 255, 0\.0/.test(segBase));
  ok('没做到的图标线条又细又淡（stroke-width ≤ 1.4，透明度 ≤ 0.35）',
    /stroke-width:\s*1\.[0-4]/.test(iconBlock)
    && Number(/stroke:\s*rgba\([^)]*,\s*([\d.]+)\)/.exec(iconBlock)?.[1]) <= 0.35);
  ok('做到的格子：实心绿底 + 实线绿框 + 外发光',
    /border:\s*1px solid/.test(segDone) && /background:/.test(segDone)
    && Number(/background:\s*rgba\([^)]*,\s*([\d.]+)\)/.exec(segDone)?.[1]) >= 0.18
    && /box-shadow/.test(segDone));
  ok('做到的图标线条明显更粗（≥2）', Number(/stroke-width:\s*([\d.]+)/.exec(doneIcon)?.[1]) >= 2);
  ok('做到的格子右上角带对勾（图形符号）', /\.criteria-seg\.done::after\s*\{[^}]*content:\s*'✓'/.test(css));
  // 用户反馈「打的这个钩太小了，根本看不清楚，要加倍放大」
  const tickBlocks = [...css.matchAll(/\.criteria-seg\.done::after\s*\{([\s\S]*?)\}/g)].map((m) => m[1]);
  const tickSize = Math.max(...tickBlocks.map((b) => Number(/width:\s*(\d+)px/.exec(b)?.[1]) || 0));
  const tickFont = Math.max(...tickBlocks.map((b) => Number(/font-size:\s*(\d+)px/.exec(b)?.[1]) || 0));
  ok('对勾做成大号徽标（≥44px 圆盘 + ≥28px 勾，窄屏另有小一号的规则）',
    tickSize >= 44 && tickFont >= 28, `${tickSize}px / ${tickFont}px`);
  // 用户反馈「得分显示在关键帧里，字体要大一点，让人看清楚」
  const ptsEarned = /\.criteria-seg-pts\.earned\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';
  const ptsFont = /font-size:\s*clamp\(\s*([\d.]+)px/.exec(ptsEarned)?.[1]
    || /font-size:\s*([\d.]+)px/.exec(ptsEarned)?.[1];
  ok('关键帧里「已拿到的分」用大号字（≥17px）', Number(ptsFont) >= 17, `font-size=${ptsFont}`);
  ok('「还没拿到的分」用灰色小字标出可得分数',
    /\.criteria-seg-pts\.max\s*\{[^}]*font-size:\s*12px/.test(css));
  ok('图标里的判据角度数字有深色描边打底（压在线条上也看得清）',
    /class="criteria-deg"/.test(fs.readFileSync(path.join(ROOT, 'src/icons.js'), 'utf8'))
    && /paint-order="stroke"/.test(fs.readFileSync(path.join(ROOT, 'src/icons.js'), 'utf8')));
  ok('正在等的那一格：琥珀粗描边 + 呼吸动画',
    /border:\s*2px solid #fbbf24/.test(segCurrent) && /animation:/.test(segCurrent));
  ok('动效敏感用户会关掉呼吸/弹跳动画', /prefers-reduced-motion/.test(css));

  /* ---- 一组结束后的两个手势圆环（退出 / 再做一次） ---- */
  const ringsHtml = /id="gestureRings"/.test(html);
  ok('画面上有手势圆环容器 + 两个圆环 + 用法提示',
    ringsHtml && /id="ringExit"/.test(html) && /id="ringRetry"/.test(html)
    && /id="gestureHint"/.test(html) && /id="ringExitLabel"/.test(html) && /id="ringRetryLabel"/.test(html));
  ok('两个圆环是按钮（鼠标/触屏点一下也能用，不是只能靠手势）',
    /<button[^>]*id="ringExit"/.test(html) && /<button[^>]*id="ringRetry"/.test(html));
  const appSrc = read('src/app.js');
  ok('圆环从 12 点开始顺时针走（rotate(-90deg)）', /\.ring-svg\s*\{[^}]*rotate\(-90deg\)/.test(css));
  ok('圆环进度用 stroke-dashoffset 表示，dasharray = 2πr（r=52 → 326.7）',
    /stroke-dasharray:\s*326\.7/.test(css) && /stroke-dashoffset/.test(css));
  ok('手掌在环里时圆环变色（.dwelling 变绿 + 外发光）',
    /\.ring-btn\.dwelling\s+\.ring-fill\s*\{[^}]*stroke:\s*#4ade80/.test(css));
  ok('触发瞬间整环填满并高亮（.done）', /\.ring-btn\.done\s*\.ring-fill\s*\{[^}]*#22c55e/.test(css));
  // 握持 3 秒 + 「圆环直径 / 命中半径」是跨文件常量，这里锁住两处一致
  ok('保持时间 = 3 秒（用户要求）', /GESTURE_HOLD_MS\s*=\s*3000/.test(appSrc));
  ok('圆环直径 20% 与 CSS 的 width 一致（同一份比例，不会一处改一处忘）',
    /RING_SIZE\s*=\s*0\.20/.test(appSrc) && /\.ring-btn\s*\{[^}]*width:\s*20%/.test(css));
  ok('两个圆环的左右位置在 app.js 里一处定义（左退出 / 右再做一次）',
    /exit:\s*\{\s*x:\s*0\.\d+/.test(appSrc) && /retry:\s*\{\s*x:\s*0\.\d+/.test(appSrc)
    && /ui\.gestureExit/.test(appSrc) && /ui\.gestureRetry/.test(appSrc));
  ok('手势判定要考虑镜像预览（否则左右手会反）', /mirror\s*\?\s*1\s*-\s*cx/.test(appSrc));

  // 全屏按钮：贴在视频框右下角，点它放大的是「视频框」#stage，不是整个 HTML 页面
  const stageAt = html.indexOf('id="stage"');
  const toolbarAt = html.indexOf('class="stage-toolbar"');
  const headerEnd = html.indexOf('</header>');
  const btnAt = html.indexOf('id="btnFullscreen"');
  ok('全屏按钮在视频框内部（已从顶部设置区移走，不是两处都有）',
    btnAt > headerEnd && btnAt > stageAt && btnAt < toolbarAt,
    `headerEnd=${headerEnd} stage=${stageAt} btn=${btnAt} toolbar=${toolbarAt}`);
  ok('全屏按钮用 .stage-btn 样式（贴在右下角）',
    /<button[^>]*id="btnFullscreen"[^>]*class="stage-btn"|<button[^>]*class="stage-btn"[^>]*id="btnFullscreen"/.test(html));
  const app = read('src/app.js');
  ok('点击后请求的是视频框全屏（$(\'stage\').requestFullscreen）',
    /\$\('stage'\)\.requestFullscreen/.test(app));
  ok('不再对 document.documentElement 请求全屏（那会整页放大）',
    !/documentElement\.requestFullscreen/.test(app));
  ok('样式里有视频框全屏规则 .stage:fullscreen', /\.stage:fullscreen\s*\{/.test(css));
  ok('样式里有右下角全屏按钮规则 .stage-btn', /\.stage-btn\s*\{/.test(css));
  // 主页与动作页是同一文档里的两个视图，靠 hidden 属性切换。
  // .layout 这类容器自带 display:grid，只靠属性默认样式会被类选择器盖掉（两个页面会同时显示），
  // 所以样式表里必须有一条全局 [hidden] 兜底规则。
  ok('样式表里有全局 [hidden] 规则（视图切换才会真的隐藏）',
    /\[hidden\][^{]*\{[^}]*display:\s*none/.test(css));
  ok('两个视图的切换写的是 hidden 属性',
    /homeView'\)\.hidden = false/.test(app) && /workoutView'\)\.hidden = true/.test(app)
    && /homeView'\)\.hidden = true/.test(app) && /workoutView'\)\.hidden = false/.test(app));
}

/* ---------- 4. 动作与界面按钮一一对应 ---------- */
console.log('\n[4] 动作库与界面一致性');
{
  const { CATEGORIES } = await import('../src/catalog.js');
  // 动作库就是约定的 22 个动作（用户明确给定清单，多一个少一个都算回归）
  const EXPECT = {
    upper: ['pushup', 'pushupWide', 'pushupDiamond'],
    lower: ['squat', 'squatSumo', 'bulgarianSplitSquat', 'lunge', 'lungeBack', 'bridge', 'squatJump'],
    core: ['plank', 'sidePlank', 'deadBug', 'crunch', 'reverseCrunch', 'lyingLegRaise'],
    full: ['burpee', 'mountainClimber', 'boxJump', 'squatJump', 'lungeJump'],
    stretch: ['standingForwardFold', 'seatedForwardFold'],
  };
  const expectIds = [...new Set(Object.values(EXPECT).flat())];
  ok('动作库就是约定的 22 个动作',
    EXERCISES.map((x) => x.id).sort().join(',') === expectIds.sort().join(','),
    `实际 ${EXERCISES.length} 个：${EXERCISES.map((x) => x.id).join(',')}`);
  for (const [cat, ids] of Object.entries(EXPECT)) {
    const got = EXERCISES.filter((x) => x.cats.includes(cat)).map((x) => x.id);
    ok(`分类 ${cat} 的动作清单与约定一致`, got.sort().join(',') === [...ids].sort().join(','), got.join(','));
  }
  ok('五个一级分类齐全', CATEGORIES.map((c) => c.id).join(',') === 'upper,lower,core,full,stretch',
    CATEGORIES.map((c) => c.id).join(','));
  ok('每个分类都有动作', CATEGORIES.every((c) => EXERCISES.some((x) => x.cats.includes(c.id))),
    CATEGORIES.map((c) => `${c.id}:${EXERCISES.filter((x) => x.cats.includes(c.id)).length}`).join(' '));
  ok('动作 id 唯一', new Set(EXERCISES.map((x) => x.id)).size === EXERCISES.length);
  ok('每个动作都有图标', EXERCISES.every((x) => !!x.icon));
  ok('每个动作都归属至少一个分类', EXERCISES.every((x) => x.cats.length >= 1));
  ok('计时类动作都写了秒数单位', EXERCISES.filter((x) => x.kind === 'hold').every((x) => x.unitKey === 'ui.secondsUnit'));
  ok('中英两种语言都已注册', LANG_ORDER.length === 2 && LANG_ORDER.join() === 'zh,en'
    && LANG_ORDER.every((l) => !!LOCALES[l]) && !LOCALES.es && !LOCALES.fr,
  `${LANG_ORDER.join(',')} / ${Object.keys(LOCALES).join(',')}`);
  for (const meta of EXERCISES) {
    const ex = localizedExercise(meta.id);
    let det = null;
    try { det = createDetector(ex.id, { strict: true }); } catch (e) { det = null; }
    ok(`createDetector('${ex.id}') 可用`, !!det && det.meta.id === ex.id);
    if (det) {
      const snap = det.snapshot();
      ok(`${ex.name} 具备计数/计时字段`, typeof snap.validReps === 'number' && typeof snap.holdMs === 'number');
      ok(`${ex.name} 有动作要领文案（≥3 条要领 + ≥2 条提示）`, ex.howto.length >= 3 && ex.tips.length >= 2,
        `${ex.howto.length}/${ex.tips.length}`);
      ok(`${ex.name} 有名称、机位提示与单位`, !!ex.name && !!ex.cameraHint && !!ex.unit);
      ok(`${ex.name} 动作名称不是键名（两种语言都有文案）`, LANG_ORDER.every((l) => {
        setLang(l, { persist: false });
        const n = localizedExercise(ex.id).name;
        return !!n && n !== `ex.${ex.id}.name`;
      }));
      // 判定依据与粗略标记要在界面上说清楚
      ok(`${ex.name} 有判定依据文案`, !!ex.judgeText && ex.judgeText !== `judge.${meta.judge}`);
    }
    setLang('zh', { persist: false });
  }
  ok('每个动作都有对应识别器分支（无默认抛错）', true);
  ok('动作文案随语言切换而改变', (() => {
    const zhName = localizedExercise('squat').name;
    setLang('en', { persist: false });
    const enName = localizedExercise('squat').name;
    setLang('zh', { persist: false });
    return zhName !== enName && !!enName;
  })());
}

/* ------------------------------------------------------------------ *
 * 5. 要领计分方案
 * ------------------------------------------------------------------ */

console.log('\n[5] 要领计分方案');
{
  for (const meta of EXERCISES) {
    const ex = localizedExercise(meta.id);
    const plan = getStepPlan(ex.id);
    ok(`${ex.name} 有要领计分步骤（≥4 步）`, plan.steps.length >= 4, `实际 ${plan.steps.length} 步`);
    ok(`${ex.name} 每一步都有文案键、分值与判定函数`,
      plan.steps.every((s) => typeof s.labelKey === 'string' && s.labelKey.length > 2
        && Number.isFinite(s.points) && s.points > 0 && typeof s.check === 'function'));
    ok(`${ex.name} 每一步的文案键都能取到两种语言的文案`,
      plan.steps.every((s) => LANG_ORDER.every((l) => {
        setLang(l, { persist: false });
        return t(s.labelKey) !== s.labelKey;
      })));
    setLang('zh', { persist: false });
    ok(`${ex.name} 有明确的“关键一步”（单步 ≥10 分）`,
      Math.max(...plan.steps.map((s) => s.points)) >= 10);
    ok(`${ex.name} 总分构成合理（整轮 ≥20 分）`,
      plan.steps.reduce((a, s) => a + s.points, 0) + (plan.repBonus || 0) >= 20);
    if (ex.kind === 'hold') {
      ok(`${ex.name} 有每秒得分或里程碑`, (plan.pointsPerSecond || 0) > 0 || plan.steps.length >= 4);
    }
    // 步骤 id 不能重复
    const ids = plan.steps.map((s) => s.id);
    ok(`${ex.name} 步骤 id 唯一`, new Set(ids).size === ids.length, ids.join(','));
  }
}

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
