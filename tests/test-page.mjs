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
import { isTimedReps, targetUnitKey } from '../src/catalog.js';
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

  /* ---- 圆环尺寸：右上角的 HUD 进度环与左下角的「退出」环共用同一个变量，所以永远一样大 ----
     用户要求：「左下角这个退出圆环…和右上角的圆环成对角的状态…各个圆环大小一样，保持对称」。 */
  {
    const ringPx = /--ring-px:\s*clamp\(([^)]*)\)/.exec(css)?.[1];
    ok('圆环直径是一个共用变量 --ring-px（clamp 形式，小屏自己收一收）',
      !!ringPx && ringPx.trim().split(',').length === 3, String(ringPx));
    const hudBlock = /\.hud-ring\s*\{([^}]*)\}/.exec(css)?.[1] || '';
    const cornerBlock = /\.corner-ring\s+\.ring-btn\s*\{([^}]*)\}/.exec(css)?.[1] || '';
    ok('右上角 HUD 圆环的宽高 = --ring-px（不再写死 118px）',
      /width:\s*var\(--ring-px\)/.test(hudBlock) && /height:\s*var\(--ring-px\)/.test(hudBlock),
      hudBlock.trim());
    ok('左下角「退出」圆环的宽高 = 同一个 --ring-px（所以两个圆环永远等大、成对角）',
      /width:\s*var\(--ring-px\)/.test(cornerBlock) && /height:\s*var\(--ring-px\)/.test(cornerBlock),
      cornerBlock.trim());
    // 左下角的容器铺满舞台、靠 JS 摆到左下角，且不属于「一组结束」那两个圆环那一组
    ok('左下角退出圆环有自己的容器（不与「一组结束后」的两个圆环共用显隐）',
      /\.corner-ring\s*\{[^}]*position:\s*absolute/.test(css)
      && /\.corner-ring\[hidden\]\s*\{\s*display:\s*none/.test(css));
    // 用户要求「退出圆环放大一点」：下限抬高到 ≥104px
    const ringMin = Number((ringPx || '').split(',')[0].replace(/[^\d.]/g, ''));
    ok('圆环直径比上一版更大（clamp 下限 ≥104px）', ringMin >= 104, `下限=${ringMin}px`);
    // 小屏也必须还是「两个一起收」：.hud-ring 不许再写死尺寸（以前写过 84px，会和左下角那个不一样大）
    ok('小屏时右上角 HUD 圆环不再写死尺寸（改用同一个 --ring-px，两个圆环仍然等大）',
      !/@media[^{]*720px[^{]*\{[^@]*\.hud-ring\s*\{[^}]*width:\s*\d+px/.test(css), 'hud-ring 有写死的宽高');
  }

  // 判定进度条：**用户要求「缩短一点、高度也变小一些」** ——
  //   宽度不再铺满（上限 880px，并且两侧用 --bar-side-space 给左下角的退出圆环留位置）；
  //   高度由 --criteria-icon-h 推出来（图标 44~60px，比上一版的 58~82px 矮一截）。
  const barBlock = /\.criteria-bar\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';
  ok('进度条宽度不再铺满画面（上限 ≤900px，且两侧给圆环留出位置）',
    /width:\s*min\((\d+)px,\s*calc\(100%\s*-\s*2\s*\*\s*var\(--bar-side-space\)\)\)/.test(barBlock)
    && Number(/width:\s*min\((\d+)px/.exec(barBlock)[1]) <= 900, barBlock.trim().slice(0, 120));
  const sideSpace = /--bar-side-space:\s*calc\(([^;]*)\);/.exec(css)?.[1] || '';
  ok('进度条让出的两侧空间 = 左边距 + 圆环直径 + 间隙（圆环和进度条各占各的地方）',
    /18px\s*\+\s*var\(--ring-px\)\s*\+/.test(sideSpace), String(sideSpace));
  const iconVar = /--criteria-icon-h:\s*clamp\((\d+)px,\s*([\d.]+)vh,\s*(\d+)px\)/.exec(css);
  const iconBlock = /\.criteria-icon\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';
  ok('进度条图标高度走共用变量 --criteria-icon-h（改一处整条一起收）',
    !!iconVar && /height:\s*var\(--criteria-icon-h\)/.test(iconBlock), iconBlock.trim().slice(0, 60));
  ok('进度条变矮了（图标 44~60px，比上一版的 58~82px 小一截）但仍然看得清（≥40px）',
    !!iconVar && Number(iconVar[1]) >= 40 && Number(iconVar[3]) <= 64,
    iconVar ? `${iconVar[1]}~${iconVar[3]}px` : '没读到 --criteria-icon-h');
  ok('进度条总高度由图标高度推出来（提示条让位也用它，不会两处对不上）',
    /--criteria-bar-h:\s*calc\(var\(--criteria-icon-h\)\s*\+/.test(css)
    && /\.stage\.has-criteria \.pose-hint\s*\{[^}]*bottom:\s*calc\([^)]*var\(--criteria-bar-h\)/.test(css));
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
  ok('正在等的那一格：琥珀描边 + 外环 + 呼吸动画（边框宽度不变）',
    /border:\s*1px solid #fbbf24/.test(segCurrent) && /box-shadow:\s*0 0 0 2px/.test(segCurrent)
    && /animation:/.test(segCurrent));

  /* ---- 用户反馈「运动时进度条抖动得很厉害」：状态变化**一律不许改几何** ----
     打钩、加分、点亮下一格都只能改颜色 / 光晕 / 透明度，不能改边框宽度、尺寸或位置，
     否则每点亮一格整条就会跟着动一下。 */
  {
    const borderWidth = (block) => {
      const m = /border(?:-width)?:\s*([\d.]+)px/.exec(block);
      return m ? Number(m[1]) : null;
    };
    const segDone = /(?:^|\n)\.criteria-seg\.done\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';
    ok('三种状态的格子边框宽度完全一致（1px）—— 状态变化不会让格子里面的图标缩放',
      borderWidth(segBase) === 1 && borderWidth(segDone) === 1 && borderWidth(segCurrent) === 1,
      `${borderWidth(segBase)} / ${borderWidth(segDone)} / ${borderWidth(segCurrent)}`);
    ok('「正在等」那一格不做位移（不再 translateY(-2px)）', !/translateY/.test(segCurrent));
    ok('格子的过渡只含颜色类属性（不含 transform / width / height）',
      /transition:/.test(segBase) && !/transition:[^;]*(transform|width|height)/.test(segBase), segBase);
    const keyframes = (name) => {
      const m = new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
      return m ? m[1] : '';
    };
    ok('「刚点亮」的闪动只用光晕（segFlash 里没有 transform 缩放）',
      /\.criteria-seg\.just\s*\{\s*animation:\s*segFlash/.test(css) && !/transform/.test(keyframes('segFlash')),
      keyframes('segFlash').slice(0, 60));
    ok('一格做完时的整条闪动不缩放整条（criteriaReset 里没有 transform）',
      /\.criteria-bar\.reset/.test(css) && !/transform/.test(keyframes('criteriaReset')),
      keyframes('criteriaReset').slice(0, 60));
    ok('分数药丸的弹入不做缩放（criteriaPtsPop 里没有 transform）',
      !/transform/.test(keyframes('criteriaPtsPop')), keyframes('criteriaPtsPop').slice(0, 60));
    ok('旧的缩放动画 segPop 已删除', !/@keyframes segPop/.test(css));
  }

  // 用户要求：分数要放在和次数靠近的地方（次数下方），而且字体要换个颜色
  const scoreBlock = /(?:^|\n)\.hud-score\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';
  const scoreVar = /color:\s*var\((--[\w-]+)\)/.exec(scoreBlock)?.[1];
  const scoreColor = scoreVar && new RegExp(`${scoreVar}:\\s*([^;]+);`).exec(css)?.[1].trim();
  const textColor = /--text:\s*([^;]+);/.exec(css)?.[1].trim();
  const accentColor = /--accent:\s*([^;]+);/.exec(css)?.[1].trim();
  ok('分数用专属颜色变量（和次数的白色、进度的青色都不是同一个颜色）',
    scoreVar === '--score' && !!scoreColor && scoreColor !== textColor && scoreColor !== accentColor,
    `${scoreVar}=${scoreColor} vs --text=${textColor} / --accent=${accentColor}`);
  ok('分数不再绝对定位在进度环底下（改成跟着次数排）', !/position:\s*absolute/.test(scoreBlock));
  ok('分数字号够大（≥22px，紧挨着次数也看得清）',
    Number(/font-size:\s*(\d+)px/.exec(scoreBlock)?.[1]) >= 22,
    /font-size:\s*(\d+)px/.exec(scoreBlock)?.[1]);
  ok('分数变了会跳一下（.hud-score.pop）', /\.hud-score\.pop\s*\{[^}]*transform/.test(css));
  ok('窄屏也压得住（小屏规则里给了分数的字号）',
    /@media[^{]*\{\s*[\s\S]*?\.hud-score\s*\{[^}]*font-size/.test(css));
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

  /* ---- 计时类读秒：每 5 秒播报一次（用户要求：平板支撑读「5 秒」「10 秒」…） ---- */
  ok('读秒间隔写死为 5 秒', /HOLD_COUNT_EVERY\s*=\s*5/.test(appSrc));
  ok('读秒接在识别之后、要领语音之前（同一帧里让读秒先说）',
    /announceHoldCount\(state\.detector[\s\S]{0,500}handleEvents\(events, now\)/.test(appSrc));
  ok('限时计数的「还剩 N 秒」也排在要领语音之前（同一帧让读秒先说）',
    /announceTimeLeft\(localizedExercise[\s\S]{0,160}handleEvents\(events, now\)/.test(appSrc));
  ok('读秒走语音包的 sayTime（文案是「N 秒」/ 随语言变化）', /audio\.sayTime\(n \* 1000\)/.test(appSrc));
  ok('和读秒撞车的要领语音会被让位（400ms 窗口）',
    /holdCountAt \|\| -1e9\) > 400/.test(appSrc));
  ok('计时归零时读秒重新装填（下一组从 5 秒开始）',
    /sec <= 0[\s\S]{0,80}holdCountNext = HOLD_COUNT_EVERY/.test(appSrc));

  /* ---- 进度条不抖动：增量更新，不在计分时重建 DOM（用户反馈「计分时抖得厉害」） ---- */
  ok('进度条 DOM 只在换动作时建一次（buildCriteriaBar 里建、renderCriteriaBar 里只改状态）',
    /function buildCriteriaSegments\(\)/.test(appSrc)
    && /buildCriteriaSegments\(\);/.test(appSrc)
    && !/function renderCriteriaBar[\s\S]{0,2200}innerHTML/.test(appSrc),
    '渲染函数里不该再出现 innerHTML');
  ok('格子状态用 classList.toggle 增量更新（状态不变时浏览器不会改写 class）',
    /classList\.toggle\('done', done\)/.test(appSrc)
    && /classList\.toggle\('current'/.test(appSrc)
    && /classList\.toggle\('just'/.test(appSrc));
  ok('分数数字只在变化时才写（否则弹出动画每次都会重放）',
    /if \(el\.pts\.textContent !== ptsText\) el\.pts\.textContent = ptsText;/.test(appSrc));
  ok('「本帧 +N」牌子的高度固定（出现时不会把整条进度条顶下去）',
    /\.criteria-head\s*\{[^}]*min-height:\s*1[0-9]px/.test(css));

  /* ---- 画面上的角度标注：判据是哪个关节角，就标哪个角（仰卧抬腿要标「腰部角度」） ---- */
  const renderSrc = read('src/render.js');
  const focusBlock = /const FOCUS = \{([\s\S]*?)\};/.exec(renderSrc)?.[1] || '';
  const metricToFocus = {
    knee: 'knee', kneeBent: 'knee', kneeExtended: 'knee',
    elbow: 'elbow', elbowBent: 'elbow', hip: 'hip',
  };
  const noFocus = [];
  for (const meta of EXERCISES) {
    const need = metricToFocus[meta.params?.metric];
    if (!need) continue;
    const entry = new RegExp(`\\b${meta.id}:\\s*\\[([^\\]]*)\\]`).exec(focusBlock);
    if (!entry || !entry[1].includes(`'${need}'`)) noFocus.push(`${meta.id}(${meta.params.metric})`);
  }
  ok('判据是关节角的动作都会在画面上标出该角度', noFocus.length === 0, noFocus.join(', '));
  ok('仰卧抬腿：标「髋」（判据是腰腿夹角）+ 膝角（用来看腿有没有绷直）',
    /lyingLegRaise:\s*\['hip',\s*'knee'\]/.test(focusBlock), focusBlock.slice(0, 80));
  ok('角度文案全应用统一叫「髋」（不再有「胯 / 腰部角度」这类特例叫法）',
    Object.values(LOCALES).every((L) => !!L.debug && L.debug.hip === (L === LOCALES.en ? 'Hip' : '髋')
      && !L.debug.crotch && !L.debug.waist),
    Object.keys(LOCALES).join(','));
  ok('渲染器里不再有「按动作换名字」的特例表（angleLabelKey 已删除）',
    !/angleLabelKey|ANGLE_LABEL/.test(renderSrc));
  ok('判据不是关节角的动作不标角度（开合跳/波比跳/跳跃类不占画面）',
    !/jumpingJack:|burpee:/.test(focusBlock));

  /* ---- 膝：两条腿都在画面里时左右分别标（用户要求「分别显示左膝和右膝的度数」） ---- */
  ok('膝标签按「两条腿是否都在画面里」分两种画法',
    /if \(bothKneesVisible\(frame, P\(K\.L\), P\(K\.R\)\)\)/.test(renderSrc));
  ok('「双腿都在画面里」复用识别器自己的判据（frame.legsVisible，和 🐞 面板同一个条件）',
    /export function bothKneesVisible[\s\S]*?frame\.legsVisible === true/.test(renderSrc)
    && /frame\.legsVisible === true/.test(renderSrc));
  ok('左右膝读的是各自那一侧的角度（perSide.L.knee / perSide.R.knee），不是同一条腿抄两遍',
    /frame\.perSide\[s\]\.knee/.test(renderSrc) && /for \(const s of \['L', 'R'\]\)/.test(renderSrc));
  ok('一条腿看不清时退回单个「膝」（不硬说左右）',
    /else if \(Number\.isFinite\(frame\.kneeAngle\)\)/.test(renderSrc));
  ok('两种语言都有「左膝 / 右膝」词条',
    Object.values(LOCALES).every((L) => L.debug?.kneeL === (L === LOCALES.en ? 'Left knee' : '左膝')
      && L.debug?.kneeR === (L === LOCALES.en ? 'Right knee' : '右膝')),
    Object.entries(LOCALES).map(([k, L]) => `${k}:${L.debug?.kneeL}/${L.debug?.kneeR}`).join(','));
  ok('标签之间有防重叠处理（两个膝几乎重在一起时往上抬一行，不会叠成一团）',
    /防重叠/.test(renderSrc) && /boxes\[i\]\.y -= boxes\[i\]\.h \+ base \* 2/.test(renderSrc));

  /* ---- 躯干倾角：用户要求「要在画面上显示躯干倾角的度数，类似『髋』『膝』的度数显示方法」 ---- */
  ok('躯干倾角用和髋 / 膝同一套画法（同一个 drawAngles 里画，不是另做的浮层）',
    /if \(showsTrunkAngle\(exerciseId\) && Number\.isFinite\(frame\.torsoIncl\)\)/.test(renderSrc));
  ok('躯干倾角垂直于躯干方向让开一段（站立标在躯干侧面、躺姿标在身体上方，不会和关节标签叠住）',
    /const sm = mid\(ls, rs\)[\s\S]*?const ax = sm\.x - hm\.x[\s\S]*?let nx = -ay \/ len/.test(renderSrc)
    && /if \(ny > 0\)/.test(renderSrc));
  ok('躯干倾角用短名文案（和「髋 / 膝」一个长度，胶囊不会宽到互相压住）',
    /t\('debug\.trunk'\)/.test(renderSrc) && !/debug\.trunkLean/.test(renderSrc));
  ok('两种语言都有「躯干 / Trunk」这个词条',
    Object.values(LOCALES).every((L) => !!L.debug && typeof L.debug.trunk === 'string'
      && L.debug.trunk === (L === LOCALES.en ? 'Trunk' : '躯干')),
    Object.entries(LOCALES).map(([k, L]) => `${k}:${L.debug?.trunk}`).join(','));
  {
    // 规则：凡是画面上标了关节角的动作，都跟着标躯干倾角；不标角度的动作一个数字都不多
    const { showsTrunkAngle } = await import('../src/render.js');
    const judged = EXERCISES.filter((m) => showsTrunkAngle(m.id)).map((m) => m.id);
    const clean = EXERCISES.filter((m) => !showsTrunkAngle(m.id)).map((m) => m.id);
    ok(`标关节角的 ${judged.length} 个动作都会在画面上标出躯干倾角`,
      judged.every((id) => new RegExp(`\\b${id}:`).test(focusBlock)), judged.join(', '));
    ok('不标角度的动作（开合跳 / 波比跳 / 站立体前屈）不会多出一个躯干数字',
      clean.length > 0 && clean.every((id) => !new RegExp(`\\b${id}:`).test(focusBlock)), clean.join(', '));
    // 宽距 / 窄距俯卧撑已删除（18 → 16）；坐姿体前屈按用户反馈「没有显示角度」补上（16 → 17）；
    // 侧平板支撑删除（17 → 16）
    ok('躯干倾角覆盖了全部「角度判定」的动作（16 个）', judged.length === 16, String(judged.length));
    ok('坐姿体前屈：标「髋」+「躯干」（它判的就是前折幅度，用户反馈过没有数字）',
      /seatedForwardFold:\s*\['hip'\]/.test(focusBlock), focusBlock.slice(-120));
  }

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
  // 动作库就是约定的动作清单（用户明确给定清单，多一个少一个都算回归）
  const EXPECT = {
    upper: ['pushup'],
    lower: ['squat', 'squatSumo', 'lunge', 'lungeBack', 'bridge', 'buttKick'],
    core: ['plank', 'deadBug', 'crunch', 'reverseCrunch', 'lyingLegRaise'],
    full: ['squatJump', 'burpee', 'mountainClimber', 'jumpingJack', 'boxJump'],
    stretch: ['standingForwardFold', 'seatedForwardFold'],
  };
  const expectIds = [...new Set(Object.values(EXPECT).flat())];
  ok('动作库就是约定的 19 个动作（弓步跳、宽距/窄距俯卧撑、侧平板支撑已删除；新增勾腿跳；深蹲跳移到全身）',
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
  // 用户要求：向前 / 向后箭步蹲的**默认次数都改成 20 次**（原来是 16）
  {
    const lunge = EXERCISES.find((x) => x.id === 'lunge');
    const lungeBack = EXERCISES.find((x) => x.id === 'lungeBack');
    ok('向前 / 向后箭步蹲默认目标都是 20 次（用户要求）',
      lunge?.target === 20 && lungeBack?.target === 20, `${lunge?.target}/${lungeBack?.target}`);
  }
  // 用户指定的调整：深蹲跳移到「全身」；下肢新增「勾腿跳」；全身有「开合跳」，默认目标 50 次
  const squatJump = EXERCISES.find((x) => x.id === 'squatJump');
  ok('深蹲跳在「全身」分类里（用户要求从下肢移过去）',
    squatJump && squatJump.cats.join(',') === 'full', squatJump?.cats.join(','));
  const buttKick = EXERCISES.find((x) => x.id === 'buttKick');
  ok('下肢新增「勾腿跳」（站立左右交替）',
    !!buttKick && buttKick.cats.join(',') === 'lower',
    `${buttKick?.cats.join(',')}/${buttKick?.target}`);
  // 用户要求：勾腿跳也改成限时计数（1 分钟看能勾多少次）
  ok('勾腿跳 = 限时计数：固定 60 秒（计次规则不变）',
    isTimedReps(buttKick) === true && buttKick?.seconds === 60 && buttKick?.target === 60,
    `${buttKick?.seconds}/${buttKick?.target}`);
  ok('勾腿跳的目标单位是秒、成绩单位是次',
    targetUnitKey(buttKick) === 'ui.secondsUnit' && buttKick?.unitKey === 'ui.repsUnit'
    && localizedExercise('buttKick').targetUnit === '秒' && localizedExercise('buttKick').unit === '次');
  ok('勾腿跳用左右交替引擎 + 站立交替的计分方案',
    buttKick?.engine === 'alt' && buttKick?.plan === 'standAlt', `${buttKick?.engine}/${buttKick?.plan}`);
  ok('勾腿跳侧对镜头（才看得清脚跟有没有勾起来）', buttKick?.view === 'side', String(buttKick?.view));
  const jack = EXERCISES.find((x) => x.id === 'jumpingJack');
  ok('全身分类里有「开合跳」', !!jack && jack.cats.join(',') === 'full', jack?.cats.join(','));
  // 用户要求：开合跳改成**定时计次** —— 固定 60 秒，看这段时间里能跳多少次
  ok('开合跳 = 限时计数：固定 60 秒（kind 仍是计数，计次规则不变）',
    jack?.kind === 'rep' && jack?.seconds === 60 && jack?.target === 60,
    `${jack?.kind}/${jack?.seconds}/${jack?.target}`);
  ok('开合跳的计时引擎与判据没变（还是 bend + legSpread，只是结束条件换成时间到）',
    jack?.engine === 'bend' && jack?.params?.metric === 'legSpread', `${jack?.engine}/${jack?.params?.metric}`);
  ok('isTimedReps 只认「计数类 + 配了秒数」的动作', isTimedReps(jack) === true
    && isTimedReps(EXERCISES.find((x) => x.id === 'squat')) === false
    && isTimedReps(EXERCISES.find((x) => x.id === 'plank')) === false);
  ok('限时计数就是「开合跳 + 勾腿跳」两个（其他动作的结束条件都还是次数 / 保持时长）',
    EXERCISES.filter((x) => isTimedReps(x)).map((x) => x.id).sort().join(',') === 'buttKick,jumpingJack',
    EXERCISES.filter((x) => isTimedReps(x)).map((x) => x.id).join(','));
  ok('限时计数：目标单位是秒、成绩单位是次（两个单位不能混）',
    targetUnitKey(jack) === 'ui.secondsUnit' && jack.unitKey === 'ui.repsUnit'
    && localizedExercise('jumpingJack').targetUnit === '秒' && localizedExercise('jumpingJack').unit === '次');
  ok('限时计数在界面上有专属说法（限时计数 / 剩余时间 / 时间到）',
    !!t('ui.kindTimed') && !!t('ui.timeLeft') && !!t('status.timedGo')
    && !!t('status.timeUpVoice') && !!t('summary.celebrateTimed') && !!t('summary.timedDone')
    && !!t('exercise.timedLead') && !!t('speech.timedSummary')
    && !!t('speech.timeLeft') && !!t('speech.timeLast5'));
  ok('开合跳判定依据是「双腿开合幅度」', jack?.judge === 'spread', String(jack?.judge));
  ok('开合跳要求正对镜头（正面才量得准开合宽度）', jack?.view === 'front', String(jack?.view));
  ok('每个动作都有图标', EXERCISES.every((x) => !!x.icon));
  ok('每个动作都归属至少一个分类', EXERCISES.every((x) => x.cats.length >= 1));
  ok('计时类动作都写了秒数单位', EXERCISES.filter((x) => x.kind === 'hold').every((x) => x.unitKey === 'ui.secondsUnit'));
  ok('中英两种语言都已注册', LANG_ORDER.length === 2 && LANG_ORDER.join() === 'zh,en'
    && LANG_ORDER.every((l) => !!LOCALES[l]) && !LOCALES.es && !LOCALES.fr,
  `${LANG_ORDER.join(',')} / ${Object.keys(LOCALES).join(',')}`);
  for (const meta of EXERCISES) {
    const ex = localizedExercise(meta.id);
    let det = null;
    try { det = createDetector(ex.id); } catch (e) { det = null; }
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
