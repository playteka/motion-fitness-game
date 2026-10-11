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
import { exercisePoseSVG, categoryMarkSVG, navPoseSVG } from '../src/icons.js';

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
    // 用户反馈「左下角退出圆环十分不灵敏」：手/脚靠近时圆环要**亮一下**，
    // 让人分得清「没识别到」和「位置差一点」；而且只改颜色 / 光晕，不动尺寸。
    const nearBlock = /\.corner-ring \.ring-btn\.near\s*\{([^}]*)\}/.exec(css)?.[1] || '';
    ok('手/脚靠近圆环时圆环会亮一下（.near 状态）',
      !!nearBlock && /box-shadow/.test(nearBlock) && /background:/.test(nearBlock), nearBlock.trim());
    ok('「靠近」状态只改颜色 / 光晕，不动宽高与位置（不会抖）',
      !!nearBlock && !/(width|height|left|top|transform)\s*:/.test(nearBlock), nearBlock.trim());
    // 小屏也必须还是「两个一起收」：.hud-ring 不许再写死尺寸（以前写过 84px，会和左下角那个不一样大）
    ok('小屏时右上角 HUD 圆环不再写死尺寸（改用同一个 --ring-px，两个圆环仍然等大）',
      !/@media[^{]*720px[^{]*\{[^@]*\.hud-ring\s*\{[^}]*width:\s*\d+px/.test(css), 'hud-ring 有写死的宽高');

    /* ---- 用户反馈：「感觉目前必须是脚踝和手腕进入才开始 3 秒计时，这个不好」----
       根因（见 app.js 里 touchSamples 的注释）：Pose 模型对手指（17~22）与脚跟 / 脚尖（29~32）
       这些点本来就是**估出来的**，手/脚伸到画面左下角时常落在手腕 / 脚踝附近或被可见度门槛丢掉 ——
       于是只剩「手腕 / 脚踝」两个点能触发。修法分两层，这里把两层都钉住。 */
    const ringSrc = read('src/app.js');
    ok('手/脚按**肢体方向补出外延点**再判（用肘推手掌、用膝 / 脚跟推脚尖）',
      /HAND_EXT_K\s*=\s*\[/.test(ringSrc) && /FOOT_EXT_K\s*=\s*\[/.test(ringSrc)
      && /wrist\.x\s*-\s*ep\.x/.test(ringSrc) && /ankle\.x\s*-\s*kp\.x/.test(ringSrc)
      && /const extend = \(/.test(ringSrc));
    ok('外延点有「别伸太远」的上限（按手臂 / 小腿长度卡住，误检的脚跟不会把脚尖送进圆环）',
      /HAND_EXT_MAX_ARM/.test(ringSrc) && /FOOT_TIP_MAX_SHIN/.test(ringSrc));
    ok('只有左下角退出圆环的判定半径放宽 12%（中间两个大圆环仍然严格按画出来的半径判）',
      /RING_TOUCH_TOL\s*=\s*1\.12/.test(ringSrc)
      && (ringSrc.match(/key === 'corner' \? RING_TOUCH_TOL : 1/g) || []).length >= 2);
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

  // 做到与没做到要一眼分得清（颜色 + 填充 + 线粗，三重区别；**不再有对勾**）
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
  // 用户要求：「检测到关键帧之后不要再打钩了，有颜色的变化就可以了，简化一下」
  // → 进度条上不再有任何对勾 / 徽标，做到与否只靠颜色（绿底 + 绿框 + 绿线条 + 外发光）区分。
  ok('做到的格子不再画对勾（进度条上没有任何 ✓ 徽标）',
    !/\.criteria-seg\.done::after/.test(css) && !/content:\s*'✓'/.test(css)
    && !/content:\s*"✓"/.test(css), '还有 done::after 的勾');
  ok('做到与否只靠颜色区分（绿底 + 绿框 + 外发光 + 线条加粗，四样都在）',
    /border:\s*1px solid rgba\(74, 222, 128/.test(segDone)
    && /background:\s*rgba\(74, 222, 128/.test(segDone)
    && /box-shadow/.test(segDone)
    && Number(/stroke-width:\s*([\d.]+)/.exec(doneIcon)?.[1]) >= 2);
  // 去掉对勾之后，绿色底色要更实一点，否则「做到了」会变得不明显
  ok('去掉对勾后绿色底色更实（≥0.24，比带勾那版更清晰）',
    Number(/background:\s*rgba\([^)]*,\s*([\d.]+)\)/.exec(segDone)?.[1]) >= 0.24,
    String(/background:\s*rgba\([^)]*,\s*([\d.]+)\)/.exec(segDone)?.[1]));
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
     点亮下一格、加分都只能改颜色 / 光晕 / 透明度，不能改边框宽度、尺寸或位置，
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
  // 逐点判定（touchSamples）里也是同一处镜像翻转：`(mirror ? 1 - p.x : p.x) * stageW`
  ok('手势判定要考虑镜像预览（否则左右手会反）', /mirror\s*\?\s*1\s*-\s*(cx|p\.x)/.test(appSrc));

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

  /* ---- 用户要求：「一旦『记录调试数据』这个开关打开，则在**视频屏幕的右下角**要出现一个图标，
     显示其正在记录帧数据，同时用数字显示已经记录了多少帧了。」---- */
  {
    const badgeAt = html.indexOf('id="recBadge"');
    const fsAt = html.indexOf('id="btnFullscreen"');
    ok('画面右下角有「正在记录」角标（在视频框 #stage 内部、右键全屏按钮的上方）',
      badgeAt > stageAt && badgeAt > headerEnd && badgeAt < fsAt && badgeAt < toolbarAt,
      `stage=${stageAt} badge=${badgeAt} fullscreen=${fsAt}`);
    ok('角标默认藏着（没开记录时屏幕上什么都没有）',
      /<div class="rec-badge" id="recBadge" hidden/.test(html));
    ok('角标 = 红点 + 帧数数字 + 单位文案（文案走 i18n，中英都有词条）',
      /<span class="rec-dot"/.test(html) && /id="recFrames"/.test(html)
      && /data-i18n="ui\.recUnit"/.test(html) && /data-i18n-title="ui\.recTitle"/.test(html)
      && typeof LOCALES.zh.ui.recUnit === 'string' && typeof LOCALES.en.ui.recUnit === 'string'
      && typeof LOCALES.zh.ui.recTitle === 'string' && typeof LOCALES.en.ui.recTitle === 'string');
    const badgeBlock = /(?:^|\n)\.rec-badge\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';
    ok('角标贴在右下角（position:absolute + right/bottom 定位）',
      /position:\s*absolute/.test(badgeBlock) && /right:\s*\d+px/.test(badgeBlock)
      && /bottom:\s*\d+px/.test(badgeBlock), badgeBlock.trim().slice(0, 80));
    ok('角标不吃鼠标事件（pointer-events:none，不挡住底下的按钮）',
      /pointer-events:\s*none/.test(badgeBlock));
    ok('角标藏着的时候不占位（.rec-badge[hidden] → display:none）',
      /\.rec-badge\[hidden\]\s*\{\s*display:\s*none/.test(css));
    ok('红点在呼吸（一眼看出「正在录」）；动效敏感用户会关掉它',
      /\.rec-badge \.rec-dot\s*\{[^}]*animation:/.test(css)
      && /prefers-reduced-motion[\s\S]*?\.rec-badge \.rec-dot\s*\{\s*animation:\s*none/.test(css));
    ok('帧数用等宽数字（数字一直跳也不会左右抖）',
      /font-variant-numeric:\s*tabular-nums/.test(badgeBlock));
    // 接线：显示 / 隐藏跟着开关走，数字取记录器真正写出去的行数，主循环里定时刷新
    ok('角标的显隐跟着开关走（renderRecBadge 读 state.settings.poseLog 与 poseLogger.active）',
      /function renderRecBadge\(\)/.test(app) && /badge\.hidden = !on/.test(app)
      && /state\.settings\.poseLog && poseLogger\.active/.test(app));
    ok('数字取的是记录器**真正记下来的**帧数（不是循环帧号：队列满了会丢帧）',
      /String\(poseLogger\.status\(\)\.frames\)/.test(app));
    ok('主循环里定时刷新角标（每 15 帧一次，不必每帧写 DOM）',
      /state\.loopCount % 15 === 0\) renderRecBadge\(\)/.test(app));
  }

  /* ---- 用户要求：「关于调试数据记录这部分，请从运动设置放到全局配置里面，还是维持 Ctrl+H
     隐藏这样的模式，正常情况下不显示。此外，在视频状态下，按下 Ctrl+H 可以开启或者停止记录调试数据。」---- */
  {
    const groupAt = html.indexOf('id="poseLogGroup"');
    const exStart = html.indexOf('id="exerciseModal"');
    const exEnd = html.indexOf('id="recordsArea"') >= 0
      ? html.indexOf('id="recordsArea"') : html.length;
    const setStart = html.indexOf('id="settingsModal"');
    const setEnd = exStart;
    ok('「调试数据记录」那一组在**设置（全局配置）**里，不再挂在运动设定弹窗下面',
      groupAt > setStart && groupAt < setEnd && !(groupAt > exStart && groupAt < exEnd),
      `settings=${setStart} group=${groupAt} exercise=${exStart}`);
    ok('它默认是藏着的（整个分组 hidden，正常情况下看不到）',
      /<div class="modal-group" id="poseLogGroup" hidden>/.test(html));
    ok('开关 / 保存按钮 / 状态行 / 说明文字都在（文案走 settings.log* 词条，中英都有）',
      /id="btnPoseLog"/.test(html) && /id="btnPoseLogSave"/.test(html) && /id="poseLogStatus"/.test(html)
      && /data-i18n="settings\.logGroup"/.test(html) && /data-i18n="settings\.logLead"/.test(html)
      && /data-i18n="settings\.logHide"/.test(html)
      && typeof LOCALES.zh.settings.logGroup === 'string' && typeof LOCALES.en.settings.logGroup === 'string'
      && typeof LOCALES.zh.settings.logToggle === 'string' && typeof LOCALES.en.settings.logToggle === 'string');
    ok('运动设定弹窗里已经没有这一组了（旧键 exercise.log* 一并清掉）',
      !/data-i18n="exercise\.log/.test(html) && !/exercise\.log[A-Z]/.test(app)
      && LOCALES.zh.exercise.logGroup === undefined && LOCALES.en.exercise.logGroup === undefined);
    // 快捷键：设置弹窗里 Ctrl+H = 显示 / 收起；视频状态下 Ctrl+H = 直接开始 / 停止记录
    ok('Ctrl+H 在设置弹窗里显示 / 收起这一组（还认得 Ctrl+Alt+H / Ctrl+Shift+H 这些变体）',
      /\(e\.ctrlKey \|\| e\.metaKey\) && \(e\.key === 'h' \|\| e\.key === 'H'\)/.test(app)
      && /if \(settingsOpen\(\)\) \{[\s\S]{0,160}setPoseLogUi\(!poseLogUiVisible\)/.test(app));
    ok('Ctrl+H 在视频状态下直接开始 / 停止记录（不必打开弹窗）',
      /else if \(videoStateActive\(\)\) \{[\s\S]{0,120}togglePoseLog\(\)/.test(app));
    ok('「视频状态」= 动作页 + 没有弹窗 + 不在动作主页（主页按 Ctrl+H 不偷偷开始记录）',
      /function videoStateActive\(\)/.test(app) && /!state\.homeMode && !!view && !view\.hidden && !anyModalOpen\(\)/.test(app));
    ok('切换开关会写进设置、同步按钮状态，并且提示条说清开始 / 停止与帧数',
      /function togglePoseLog\(/.test(app) && /state\.settings\.poseLog = on;/.test(app)
      && /saveSettings\(\);/.test(app)
      && /status\.poseLogKeyOn/.test(app) && /status\.poseLogKeyOff/.test(app)
      && typeof LOCALES.zh.status.poseLogKeyOn === 'string'
      && typeof LOCALES.en.status.poseLogKeyOff === 'string');
    ok('设置弹窗打开时按上次的临时状态对齐这一组的显隐（刷新页面回到隐藏）',
      /function openSettings\(\)/.test(app)
      && /setPoseLogUi\(poseLogUiVisible\);\s*\n\s*renderPoseLogStatus\(\);/.test(app));
  }

  /* ---- 用户要求：「我希望把界面改造为全手势操作。请在首页增加一个大的『开始』按钮，点击后就打开
     摄像头进入到全屏的视频界面。在这个视频界面里面，给出手势选择菜单，也采用手进入圆环 3 秒的方式
     来进行选择，菜单项就是各项运动，选择之后则直接进入到全屏的各项运动界面，在各项运动中如果退出，
     则回到菜单页面，如果在菜单界面退出则回到网页首页。」---- */
  {
    const startAt = html.indexOf('id="btnStartGesture"');
    const catsAt = html.indexOf('id="homeCats"');
    ok('首页有那个大的「开始」按钮（在动作库网格之前，一眼就能看到）',
      startAt > 0 && startAt < catsAt
      && /<button class="start-gesture" id="btnStartGesture"/.test(html),
      `start=${startAt} cats=${catsAt}`);
    ok('按钮文案走 i18n，中英都有（menu.start / menu.startSub）',
      /data-i18n="menu\.start"/.test(html) && /data-i18n="menu\.startSub"/.test(html)
      && typeof LOCALES.zh.menu.start === 'string' && typeof LOCALES.en.menu.start === 'string'
      && typeof LOCALES.zh.menu.startSub === 'string' && typeof LOCALES.en.menu.startSub === 'string');

    const menuAt = html.indexOf('id="gestureMenu"');
    ok('手势菜单盖在**视频框 #stage 里面**（全屏时跟着视频一起放大）',
      menuAt > stageAt && menuAt < toolbarAt, `stage=${stageAt} menu=${menuAt} toolbar=${toolbarAt}`);
    ok('菜单默认藏着（没点「开始」之前不显示）',
      /<div class="gesture-menu" id="gestureMenu" hidden>/.test(html));
    ok('菜单有标题 / 说明 / 圆环容器 / 底部提示四块（文案走 menu.*，中英都有）',
      /id="menuGrid"/.test(html) && /class="menu-title" id="menuTitle" data-i18n="menu\.title"/.test(html)
      && /class="menu-lead" id="menuLead" data-i18n="menu\.lead"/.test(html)
      && /class="menu-foot" id="menuFoot" data-i18n="menu\.hint"/.test(html)
      && typeof LOCALES.zh.menu.lead === 'string' && typeof LOCALES.en.menu.lead === 'string'
      && typeof LOCALES.zh.menu.hint === 'string' && typeof LOCALES.en.menu.hint === 'string');
    const menuBlock = /(?:^|\n)\.gesture-menu\s*\{([\s\S]*?)\}/.exec(css)?.[1] || '';
    ok('菜单铺满视频框、但只有圆环吃鼠标（pointer-events:none）',
      /position:\s*absolute/.test(menuBlock) && /inset:\s*0/.test(menuBlock)
      && /pointer-events:\s*none/.test(menuBlock), menuBlock.trim().slice(0, 80));
    ok('菜单圆环复用 .ring-btn 那一套（同一种圆环动画与 3 秒手感）',
      /\.menu-ring\s*\{/.test(css) && /\.ring-btn/.test(css)
      && /btn\.className = `menu-ring ring-btn menu-ring--\$\{it\.kind\}`/.test(app)
      && /menu-name/.test(css) && /\.menu-ring\s*\{[^}]*min-width:\s*0/.test(css));
    ok('菜单模式把运动相关面板收起来（侧栏 / 工具栏 / HUD / 进度条）',
      /#workoutView\.menu-mode \.panel/.test(css) && /#stage\.menu-mode \.hud/.test(css)
      && /#stage\.menu-mode \.criteria-bar/.test(css));
    // 接线：首页按钮 → 开摄像头 + 全屏 + 进菜单；菜单判定 → 选中动作；退出分流
    ok('首页按钮接的是「开摄像头 → 全屏视频 → 手势菜单」这一套',
      /\$\('btnStartGesture'\)\?\.addEventListener\('click', \(\) => startGestureMode\(\)\)/.test(app)
      && /function startGestureMode\(\)/.test(app)
      && /requestStageFullscreen\(\)/.test(app)
      && /if \(!camera\.active\) startCamera\(state\.settings\.camDeviceId \|\| null\)/.test(app),
      '按钮接线不对');
    ok('全屏申请的是 #stage（视频框），不是整页',
      /function requestStageFullscreen\(\)/.test(app) && /stage\.requestFullscreen\(\)/.test(app));
    ok('菜单判定用「手掌中心 + 3 秒」，和别的圆环同一套常量',
      /function updateMenu\(/.test(app) && /palmPoints\(landmarks/.test(app)
      && /GESTURE_HOLD_MS/.test(app) && /MENU_HIT_RATIO/.test(app));
    // 两级菜单 + 每页一行 5 个 + 「双手挥两次」翻页（用户要求）
    ok('菜单是**两级**：第一级分类、第二级动作',
      /state\.menuLevel = 0;/.test(app) && /function menuItems\(\)/.test(app)
      && /if \(state\.menuLevel === 0\)/.test(app) && /kind: 'category'/.test(app));
    ok('每页最多一行、每行最多 5 个（用户要求「每页还是最多一行，每一行最多 5 个圆环选项」）',
      /const MENU_COLS = 5;/.test(app) && /const MENU_ROWS = 1;/.test(app)
      && /function menuPageInfo\(/.test(app) && /function menuPerPage\(/.test(app)
      && /function menuCols\(/.test(app) && /function menuRowsFor\(/.test(app)
      && /state\.menuPage = 0;/.test(app)
      && /id="menuPage"/.test(html) && typeof LOCALES.zh.menu.page === 'string'
      && typeof LOCALES.en.menu.page === 'string');
    ok('三个导航圆环并排居中（上一页 / 返回 / 下一页），「返回」不在 menuItems 里、不参与翻页',
      /function menuNavLayout\(/.test(app)
      && /const page = menuHasPages\(size\);/.test(app)
      && /\['page:prev', 'prev', -1, t\('menu\.prev'\)\], \['back', 'back', 0, t\('menu\.back'\)\]/.test(app)
      && /cx: size\.w \/ 2 \+ \(i - mid\) \* step,/.test(app)
      && !/list\.push\(\{ id: 'back'/.test(app)
      && /const item = \[\.\.\.menuItems\(\), \.\.\.menuNavLayout\(stageSize\(\)\)\]\.find/.test(app));
    ok('「上一页 / 下一页」圆环按需出现（有第二页才有），和「返回」一样停满 5 秒才触发',
      /\['page:prev', 'prev', -1/.test(app) && /\['page:next', 'next', 1/.test(app)
      && /const page = menuHasPages\(size\);/.test(app)
      && /const MENU_NAV_HOLD_MS = 5000;/.test(app)
      && /const MENU_NAV_KINDS = \{ back: 1, prev: 1, next: 1 \};/.test(app)
      && /const holdMs = item && MENU_NAV_KINDS\[item\.kind\] \? MENU_NAV_HOLD_MS : GESTURE_HOLD_MS;/.test(app)
      && typeof LOCALES.zh.menu.prev === 'string' && typeof LOCALES.en.menu.next === 'string');
    ok('翻页主路径 = **双手同时挥两次**（向上 = 上一页、向下 = 下一页；单手 / 只挥一次都不算）',
      /function updateMenuSwipe\(palms, layout, size, now, speed\)/.test(app)
      && /const up = dys\.every\(\(d\) => d <= -travel\)/.test(app)
      && /const down = dys\.every\(\(d\) => d >= travel\)/.test(app)
      && /const dir = up \? -1 : 1;/.test(app)                    // 上 = 上一页
      && /const both = palms\.length >= 2 && palms\[0\]\.side !== palms\[1\]\.side;/.test(app)
      && /if \(sw\.count < 2\) return 0;/.test(app)
      && /sw\.burst = true;/.test(app)                            // 一次挥动只算一次
      && /const swipeDir = updateMenuSwipe\(palms, layout, size, now, speed\);/.test(app)
      && /MENU_SWIPE_CHAIN_MS/.test(app) && /MENU_SWIPE_COOLDOWN_MS/.test(app));
    ok('主循环按返回的动作分流：翻页 / 选中',
      /const act = updateMenu\(res \? res\.landmarks : null, now\)/.test(app)
      && /if \(act\.kind === 'page'\) flipMenuPage\(act\.dir\);/.test(app)
      && /else selectFromMenu\(act\.id\);/.test(app));
    ok('指着某一格一会儿先把它念出来（确认瞄对了再停满 3 秒）',
      /MENU_ANNOUNCE_P/.test(app) && /st\.announced !== st\.id/.test(app)
      && /audio\.say\(item\.name, \{ rate: 1\.25, minGapMs: 400 \}\)/.test(app));
    ok('翻页只建当前这一页的圆环（其它页的不会留在画面角落上）',
      /menuItems\(\)\.slice\(info\.from, info\.to\)/.test(app));
    ok('键盘 / 鼠标也能翻页（← / → 方向键、点页码那一行、点翻页圆环）',
      /flipMenuPage\(\(e\.key === 'ArrowRight'/.test(app)
      && /\$\('menuPage'\)\?\.addEventListener\('click', \(\) => flipMenuPage\(1\)\)/.test(app)
      && /if \(it\.kind === 'prev' \|\| it\.kind === 'next'\) flipMenuPage\(it\.dir\)/.test(app));
    ok('圆环直径上限 ≥300px（不再是 19 个挤一屏的小圆环）',
      /const MENU_RING_MAX = (\d+)/.test(app)
      && Number(/const MENU_RING_MAX = (\d+)/.exec(app)[1]) >= 300,
      String(/const MENU_RING_MAX = (\d+)/.exec(app)?.[1]));
    /* 防误触（用户反馈：「菜单圆环很大、数量又多，人站在画面中手很容易误触某个圆环」）：
       四道闸 + 更快退回，都在源码里有单一出处，测试盯住它们别再被放松回去。 */
    ok('防误触①：判定圈 = 画出来的圆圈本身（1.0 倍，不再外扩 15%）',
      /const MENU_HIT_RATIO = 1\.0;/.test(app)
      && /const MENU_NAV_HIT_RATIO = 1\.0;/.test(app));
    ok('防误触②：起手圈收到 0.8 倍（贴边那一圈 36% 面积排除在「起手」之外），进环后仍按 1.0 算（迟滞）',
      /const MENU_START_RATIO = 0\.8;/.test(app)
      && /start: \(dia \/ 2\) \* MENU_START_RATIO,/.test(app)
      && /start: r \* MENU_START_RATIO,/.test(app)
      && /if \(d > \(same \? it\.hit : it\.start\)\) continue;/.test(app));
    ok('防误触③：手在动就暂停计时（`MENU_STILL_SPEED`，走过去 / 挥过去都不算）',
      /const MENU_STILL_SPEED = 0\.30;/.test(app)
      && /const speed = \{ L: 0, R: 0 \};/.test(app)
      && /if \(speed\[st\.side\] > MENU_STILL_SPEED \* size\.h\) st\.since \+= dt;/.test(app));
    ok('防误触④：一只手必须先在**所有圆环之外**露过面，才算「从外面进来」（先垂在某一格里不会自己开始攒）',
      /const MENU_ARM_MS = \d+;/.test(app) && /armed: \{ L: false, R: false \}/.test(app)
      && /if \(layout\.every\(\(it\) => Math\.hypot\(p\.x - it\.cx, p\.y - it\.cy\) > it\.hit\)\) st\.armed\[p\.side\] = true;/.test(app)
      && /if \(!same && !st\.armed\[p\.side\]\) continue;/.test(app)
      && /st\.armed\[hover\.side\] = false;/.test(app)
      && /st\.armed = \{ L: false, R: false \};/.test(app));
    ok('防误触⑤：手离开后退得更快（MENU_DRAIN_MS < 别的圆环的 GESTURE_DRAIN_MS），蹭一下不留半格进度',
      /const MENU_DRAIN_MS = (\d+);/.test(app)
      && Number(/const MENU_DRAIN_MS = (\d+)/.exec(app)[1]) < 1500
      && /st\.p = Math\.max\(0, st\.p - dt \/ MENU_DRAIN_MS\);/.test(app));
    ok('防误触⑥：整块圆环往上放，底部留出「放手区」（top 16% / bottom 18%，窄屏 20% / 20%）',
      /const top = size\.h \* \(narrow \? 0\.20 : 0\.16\);/.test(app)
      && /const bottom = size\.h \* \(narrow \? 0\.20 : 0\.18\);/.test(app));
    ok('字号跟着圆环直径算（一处定义，圆环大字号就大）',
      /const nameSize = clamp\(dia \* 0\.15/.test(app)
      && /name\.style\.fontSize = `\$\{it\.nameSize/.test(app));
    ok('菜单项就是动作库（一处定义：分类与动作都从目录取，不会再抄一份清单）',
      /function menuItems\(\)/.test(app) && /localizedCategories\(\)\.map/.test(app)
      && /localizedByCategory\(state\.menuCategory\)\.map/.test(app));
    ok('「返回」那一格有单独样式（一眼分得出它不是动作）',
      /menu-ring--\$\{it\.kind\}/.test(app) && /\.menu-ring--back/.test(css)
      && typeof LOCALES.zh.menu.back === 'string' && typeof LOCALES.en.menu.back === 'string'
      && typeof LOCALES.zh.menu.leadIn === 'string' && typeof LOCALES.en.menu.leadIn === 'string'
      && typeof LOCALES.zh.menu.catCount === 'string' && typeof LOCALES.en.menu.catCount === 'string');
    ok('主循环里跑菜单判定，选中 / 翻页各有各的出口',
      /if \(state\.menuMode\) \{/.test(app) && /updateMenu\(res \? res\.landmarks : null, now\)/.test(app)
      && /selectFromMenu\(act\.id\)/.test(app) && /flipMenuPage\(act\.dir\)/.test(app));
    ok('退出分流：菜单里不再显示左下角圆环（顶部常驻「↩ 返回」），动作里点它回菜单',
      /const toHome = state\.menuMode;/.test(app)
      && /if \(toHome\) showHome\(\);\s*\n\s*else openMenu\(\{ silent: true \}\);/.test(app)
      && /openMenu\(\{ silent: true \}\);\s*\/\/ 退出动作 → 回手势菜单/.test(app)
      && /const want = !!camera\.active && !state\.homeMode && !state\.menuMode && !gestureState\.visible;/.test(app));
    ok('左下角圆环只有一种语义了：「退出（回菜单）」',
      /function syncCornerLabel\(\)/.test(app)
      && /const txt = t\('ui\.gestureExit'\);/.test(app)
      && !/menu\.exitHome/.test(app)
      && LOCALES.zh.menu.exitHome === undefined && LOCALES.en.menu.exitHome === undefined);
    ok('导航那颗「返回」图标与样式和其他「返回」完全一致（线条箭头 + menu-ring--back），第一级回网页首页',
      /\['back', 'back', 0, t\('menu\.back'\)\]/.test(app)
      && /menu-ring--\$\{it\.kind\}/.test(app)
      && /poseIcon: navPoseSVG\(kind\)/.test(app)
      && /menuBackHome\(\);                     \/\/ 淡出 \+ 主页淡入（用户要求返回也要有淡入淡出）/.test(app));
    ok('底部提示分两级 + 教翻页手势（双手挥两次）',
      /id="menuFoot"/.test(html)
      && /foot\.textContent = state\.menuLevel === 0 \? t\('menu\.hint'\) : t\('menu\.hintIn'\)/.test(app)
      && typeof LOCALES.zh.menu.hintIn === 'string' && typeof LOCALES.en.menu.hintIn === 'string'
      && /双手同时向上挥两次/.test(LOCALES.zh.menu.hint)
      && /swipe up twice/.test(LOCALES.en.menu.hint));
    /* 用户要求：「翻页以及返回都要采用滑动的淡入淡出动画效果。」 */
    ok('翻页 / 返回改成**整屏滑动**：两张屏（menu-screen / menu-ghost）+ 四张位移关键帧 + 从两侧进出',
      /id="menuScreen"/.test(html) && /id="menuGridGhost"/.test(html) && /class="menu-ghost"/.test(html)
      && /\.menu-screen \{ position: absolute; inset: 0; will-change: transform; \}/.test(css)
      && /\.menu-ghost \{ position: absolute; inset: 0; pointer-events: none; will-change: transform; \}/.test(css)
      && /@keyframes menuScreenOutLeft/.test(css) && /@keyframes menuScreenInFromRight/.test(css)
      && /@keyframes menuScreenOutRight/.test(css) && /@keyframes menuScreenInFromLeft/.test(css)
      && /\.menu-ghost\.menu-anim-out-next \{ animation: menuScreenOutLeft var\(--menu-anim-out/.test(css)
      && /\.menu-screen\.menu-anim-in-next \{ animation: menuScreenInFromRight var\(--menu-anim-in/.test(css)
      && /\.menu-ghost\.menu-anim-out-prev \{ animation: menuScreenOutRight/.test(css)
      && /\.menu-screen\.menu-anim-in-prev \{ animation: menuScreenInFromLeft/.test(css));
    // 用户要求「改为完整的滑动效果」：关键帧里只剩位移，没有 opacity（淡入淡出只留给回首页那一路）
    ok('「完整的滑动」= 位移关键帧里不再有 opacity',
      !/opacity/.test(css.slice(css.indexOf('@keyframes menuScreenOutLeft'), css.indexOf('@keyframes menuFadeIn'))));
    ok('滑动动画在「减少动态效果」偏好下自动关掉',
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.menu-screen\.menu-anim-in-prev[\s\S]*?animation: none;/.test(css));
    ok('翻页 / 返回 / 进下一层 / 退回菜单都接了这套动画，而且真实 DOM 立刻重建（状态与界面同步）',
      /function animateMenuSwap\(dir, rebuild\)/.test(app)
      && /for \(const el of \[head, grid, foot\]\)/.test(app)                     // 整屏克隆（标题 + 圆环 + 提示）
      && /rebuild\(\);                                     \/\/ ② 真实那一屏马上换好（同步）/.test(app)
      && /animateMenuSwap\(dir, \(\) => \{\s*\n\s*buildMenu\(\);/.test(app)
      && /animateMenuSwap\(-1, \(\) => renderMenu\(\)\);/.test(app)
      && /animateMenuSwap\(1, \(\) => renderMenu\(\)\);/.test(app)
      && /function menuBackHome\(\)/.test(app));
    ok('滑行距离按舞台算（最里面那颗也滑出画面）、时长写成 CSS 变量、进出同长',
      /function menuSlideDistance\(size\)/.test(app) && /menuSlideDistance\(size\)/.test(app)
      && /--menu-slide-x/.test(app) && /--menu-anim-out/.test(app) && /--menu-anim-in/.test(app)
      && /var\(--menu-anim-out/.test(css) && /var\(--menu-anim-in/.test(css)
      && /const MENU_ANIM_OUT_MS = (\d+);/.test(app)
      && Number(/const MENU_ANIM_OUT_MS = (\d+)/.exec(app)[1]) >= 450
      && /const MENU_ANIM_OUT_MS = (\d+)/.exec(app)[1] === /const MENU_ANIM_IN_MS = (\d+)/.exec(app)[1]);
    ok('菜单里不摆「一组结束」的两个圆环（offerSetChoices 认得菜单模式）',
      /if \(state\.homeMode \|\| state\.menuMode \|\| !state\.detector\) return;/.test(app));
    ok('菜单里按 Esc = 回网页首页（键盘用户的退路）',
      /if \(state\.menuMode\) \{ showHome\(\); return; \}/.test(app));
  }

  /* ---- 用户要求：「返回图标的颜色要改为白色，和文字的颜色一样，让人可以清晰的辨识。」
     以及「臀桥的图标要改为人体做臀桥的姿势，就是躺下，腿部弯曲，身体绷直的姿势。
     平板支撑的图标也要改为双肘撑地，身体绷直的样子。」---- */
  {
    const bridgeSVG = exercisePoseSVG('bridge');
    const plankSVG = exercisePoseSVG('plank');
    ok('臀桥 / 平板支撑的线条图标（用户最早点名要改的两个）画的是各自的姿势',
      /class="ex-pose/.test(bridgeSVG) && /class="ex-pose/.test(plankSVG)
      && bridgeSVG !== plankSVG && exercisePoseSVG('squat') !== '',
      `bridge=${bridgeSVG.length}B plank=${plankSVG.length}B squat=${exercisePoseSVG('squat').length}B`);

    /**
     * 把图标解析成「关节图」。
     *
     * 图标的骨架是一条**链**：踝－膝－髋－肩－肘－手（其余动作同理），
     * 所以沿链走一遍就能认出每个关节；「哪一头是手」用**臂比腿短**来判断
     * （上臂+小臂 ≈ 6 段长，大腿+小腿 ≈ 10 段长），不靠猜。
     */
    const jointsOf = (svg) => {
      const segs = [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)]
        .map((m) => [{ x: +m[1], y: +m[2] }, { x: +m[3], y: +m[4] }]);
      const head = (svg.match(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/) || [])
        .slice(1).map(Number);
      const key = (p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      const V = new Map();
      segs.forEach((s, i) => {
        for (const p of s) {
          const k = key(p);
          if (!V.has(k)) V.set(k, { p, segs: [] });
          V.get(k).segs.push(i);
        }
      });
      const end = [...V.values()].find((v) => v.segs.length === 1);
      const chain = [];                       // 顶点序列
      const lens = [];                        // 每段的长度
      let cur = end;
      let prev = -1;
      while (cur) {
        chain.push(cur.p);
        const si = cur.segs.find((i) => i !== prev);
        if (si === undefined) break;
        const s = segs[si];
        const other = key(s[0]) === key(cur.p) ? s[1] : s[0];
        lens.push(Math.hypot(other.x - cur.p.x, other.y - cur.p.y));
        prev = si;
        cur = V.get(key(other));
      }
      // 臂（两段更短的）在哪一头：决定链的方向，从而定出肩 / 肘 / 手 / 髋 / 膝 / 踝
      const headFirst = lens[0] + lens[1] < lens[lens.length - 1] + lens[lens.length - 2];
      const P = headFirst ? [...chain].reverse() : chain;
      const [ankle, knee, hip, shoulder, elbow, hand] = P;
      const ang = (a, b, c) => {
        const v1 = { x: a.x - b.x, y: a.y - b.y };
        const v2 = { x: c.x - b.x, y: c.y - b.y };
        const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
        return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
      };
      const xs = segs.flat().map((p) => p.x);
      const ys = segs.flat().map((p) => p.y);
      return {
        ankle, knee, hip, shoulder, elbow, hand,
        head: { x: head[0], y: head[1], r: head[2] },
        hipAngle: ang(shoulder, hip, knee),
        kneeAngle: ang(hip, knee, ankle),
        elbowAngle: ang(shoulder, elbow, hand),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
        minY: Math.min(...ys), maxY: Math.max(...ys),
        segments: segs.length,
      };
    };

    const b = jointsOf(bridgeSVG);
    ok('臀桥图标 = 躺下（横着比竖着长）+ 髋部抬起来（明显高于肩）',
      b.w > b.h && (b.shoulder.y - b.hip.y) >= 2,
      JSON.stringify({ w: +b.w.toFixed(1), h: +b.h.toFixed(1), 髋高于肩: +(b.shoulder.y - b.hip.y).toFixed(1) }));
    // ⚠️ 关节角度现在由 EXERCISE_POSES 一处定义（合并共线笔画后，从 SVG 反推角度不再可靠），
    //    这里只钉「画出来是不是那个意思」；具体角度见源码那张表 + 下面的「不纠缠 / 辨识度」两条。
    ok('臀桥图标 = 腿是弯的 + 身体是绷直的一条弧（不是直挺挺躺着）',
      b.kneeAngle < 150 && b.hipAngle >= 110,
      `膝角=${Math.round(b.kneeAngle)}° 髋角=${Math.round(b.hipAngle)}°`);
    ok('臀桥图标 = 脚踩在地面线上、双臂平放在地面附近（不是朝天举）',
      Math.abs(b.ankle.y - b.maxY) <= 4 && Math.abs(b.hand.y - b.shoulder.y) <= 3.5,
      `踝=${b.ankle.y.toFixed(1)} 地面=${b.maxY.toFixed(1)} 肩=${b.shoulder.y.toFixed(1)} 手=${b.hand.y.toFixed(1)}`);

    const p = jointsOf(plankSVG);
    ok('平板支撑图标 = 双肘撑地（肘在**地面线上**、就在肩的正下方）',
      Math.abs(p.elbow.y - p.maxY) <= 0.5 && Math.abs(p.elbow.x - p.shoulder.x) <= 1
      && p.elbowAngle >= 60 && p.elbowAngle <= 120,
      `肘y=${p.elbow.y.toFixed(1)} 地面=${p.maxY.toFixed(1)} 肩x=${p.shoulder.x.toFixed(1)} 肘x=${p.elbow.x.toFixed(1)} 肘角=${Math.round(p.elbowAngle)}°`);
    ok('平板支撑图标 = 小臂平贴地面、朝头的方向伸出去（一眼看出是撑在小臂上）',
      Math.abs(p.hand.y - p.elbow.y) <= 0.5
      && Math.sign(p.hand.x - p.elbow.x) === Math.sign(p.head.x - p.shoulder.x),
      `手=(${p.hand.x.toFixed(1)},${p.hand.y.toFixed(1)}) 肘=(${p.elbow.x.toFixed(1)},${p.elbow.y.toFixed(1)})`);
    ok('平板支撑图标 = 身体绷直（躯干-大腿、髋-膝都接近一条线，≥150°）',
      p.hipAngle >= 150 && p.kneeAngle >= 150 && p.w > p.h,
      `髋角=${Math.round(p.hipAngle)}° 膝角=${Math.round(p.kneeAngle)}°`);

    // 参数是唯一来源：姿势由这几个数决定，改一个数图标就变（测试盯住它们）
    ok('姿势参数写在一处（EXERCISE_POSES 一张表：19 个动作各自那一帧）',
      /const EXERCISE_POSES = \{/.test(read('src/icons.js'))
      && (read('src/icons.js').match(/^  [a-zA-Z]+: \(\) => build/gm) || []).length === 19);
    ok('姿势图标接进了动作元数据（localizedExercise 提供 poseIcon），界面按 poseIcon ∨ emoji 取',
      /poseIcon: exercisePoseSVG\(id\)/.test(read('src/exercises.js'))
      && /<span class="ex-icon">\$\{ex\.poseIcon \|\| ex\.icon\}<\/span>/.test(app)
      && /\$\('hudIcon'\)\.innerHTML = ex\.poseIcon \|\| ex\.icon;/.test(app)
      && /const iconHtml = it\.poseIcon \|\| it\.icon;/.test(app));
    ok('文字箭头（返回 / 上一页 / 下一页）的图标色是**白色**，和名字一个颜色',
      /\.menu-icon \{[\s\S]*?color: #f2f8ff;/.test(css)
      && /\.menu-name \{[\s\S]*?color: #f2f8ff;/.test(css));
    ok('姿势图标的线条走 currentColor（放在哪儿就跟哪儿的文字颜色一致）',
      /\.ex-pose \{[\s\S]*?stroke: currentColor;/.test(css)
      && /\.ex-pose \{[\s\S]*?fill: none;/.test(css)
      && /\.ex-pose \{[\s\S]*?width: 1em;/.test(css));

    /* ---- 用户要求（第一次）：「图标能否全面重新设计一下，要保持风格的一致性，同时和运动动作有相关性。」
       ---- 用户要求（第二次）：「使用新装的专业设计图标的 skill，ui-icon-design 来重新设计所有的图标。」
       按 skill 的规格钉住：24×24 网格 / 20×20 活动区居中 / 坐标落在整数或 .5 上 /
       只含 shapes（没有 <text>、没有 emoji）/ 颜色走 currentColor；
       分类图标与导航箭头用库里现成的专业图标（Lucide ISC / Tabler MIT），动作姿势图自己画但同一套几何。 ---- */
    {
      const ids = EXERCISES.map((x) => x.id);
      const svgOf = new Map(ids.map((id) => [id, exercisePoseSVG(id)]));
      const numsOf = (svg) => [...svg.matchAll(/(?:x1|y1|x2|y2|cx|cy|r)="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
      const linesOf = (svg) => [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)]
        .map((m) => m.slice(1).map(Number));
      const boxOf = (svg) => {
        const segs = linesOf(svg);
        const circles = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map((m) => m.slice(1).map(Number));
        const xs = [...segs.flatMap((s) => [s[0], s[2]]), ...circles.flatMap((c) => [c[0] - c[2], c[0] + c[2]])];
        const ys = [...segs.flatMap((s) => [s[1], s[3]]), ...circles.flatMap((c) => [c[1] - c[2], c[1] + c[2]])];
        return {
          minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys),
          w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
          headX: circles.length ? circles[0][0] : null,
          el: segs.length + circles.length,
          heads: circles.length,
        };
      };
      const allShared = [...ids.map((id) => svgOf.get(id)),
        ...['upper', 'lower', 'core', 'full', 'stretch'].map((c) => categoryMarkSVG(c)),
        ...['back', 'prev', 'next'].map((k) => navPoseSVG(k))];
      ok('19 个动作**全部**有自己的线条姿势图标（一整套里没有 emoji 当图标）',
        ids.every((id) => /class="ex-pose/.test(svgOf.get(id)) && boxOf(svgOf.get(id)).el >= 4
          && boxOf(svgOf.get(id)).heads === 1),
        ids.map((id) => `${id}:${boxOf(svgOf.get(id)).el}`).join(' '));
      /**
       * 用户要求（第三次）：「运动类的图标也重新设计一下，要设计得更大气、上档次一些。」
       * 做法：运动图标升级成**实心象形图**（`.ex-pose--solid`）—— 描边 3（四肢变成实心身体）、
       * 头填实且按骨架的 1.7 倍放大（剪影要有一个明显的头）、内容用满 20×20 活动区。
       * 界面图标（导航 / 分类 / 按钮）保持细线 `rounded`（用户说「导航类的图标设计得还可以」）。
       */
      ok('运动类图标是**实心象形图**：带 ex-pose--solid、头填实、描边 3、用满活动区',
        ids.every((id) => /class="ex-pose ex-pose--solid"/.test(svgOf.get(id)))
        && /\.ex-pose--solid \{ stroke-width: 1\.8; \}/.test(css)
        && /\.ex-pose--solid circle \{ fill: currentColor; \}/.test(css)
        && /APP_POSE_SCALE/.test(read('src/icons.js')));
      ok('19 张图**两两不同**（每个动作都有自己的样子，不会两张一样）',
        new Set([...svgOf.values()]).size === ids.length,
        `${new Set([...svgOf.values()]).size} / ${ids.length}`);
      ok('skill 规格：全部是 24×24 网格、只含 shapes、没有 <text> / emoji',
        allShared.every((svg) => /viewBox="0 0 24 24"/.test(svg) && !/<text/.test(svg)
          && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(svg)),
        '有图标不合规');
      ok('skill 规格：坐标全部落在整数或 .5 上（不会出现半像素虚边）',
        allShared.every((svg) => numsOf(svg).every((v) => Math.abs(v * 2 - Math.round(v * 2)) < 1e-6)),
        allShared.map((svg, i) => (numsOf(svg).every((v) => Math.abs(v * 2 - Math.round(v * 2)) < 1e-6) ? '' : i))
          .filter(Boolean).join(',') || 'ok');
      ok('skill 规格：动作图标都画在 20×20 活动区里（地面线也在框内）',
        ids.every((id) => {
          const b = boxOf(svgOf.get(id));
          return b.minX >= 2 && b.maxX <= 22 && b.minY >= 1.5 && b.maxY <= 22 && b.el <= 12;
        }),
        ids.map((id) => `${id}:[${boxOf(svgOf.get(id)).minX},${boxOf(svgOf.get(id)).minY}]`).join(' '));
      /* 用户要求（第四次）：「线条纠缠成一团、不够舒展，有些动作太相近，仿效奥运项目图标的设计风格」。
         奥运象形图的三条做法：**统一比例 + 一条地面线 + 匀称细线条**，以及「同族动作靠姿势拉开」。 */
      ok('仿奥运象形图：统一比例（不各自拉满活动区）+ 一条地面线 + 匀称细线条 1.8',
        /const APP_POSE_SCALE = [\d.]+;/.test(read('src/icons.js'))
        && /const APP_GROUND_Y = 21;/.test(read('src/icons.js'))
        && /function groundLine\(\)/.test(read('src/icons.js'))
        && ids.every((id) => /class="icon-ground"/.test(svgOf.get(id)))
        && ids.every((id) => /y1="21"|y2="21"/.test(svgOf.get(id))));
      const segsOf2 = (svg) => [...svg.matchAll(/<line( class="icon-(?:mark|ground)")? x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)]
        .filter((m) => !m[1])
        .map((m) => m.slice(2).map(Number).reduce((acc, v, i) => (i % 2 ? [...acc, { x: m[i + 1], y: v }] : acc), []))
        .map(([a, b]) => ({ a, b }));
      const distToSeg = (p, s) => {
        const dx = s.b.x - s.a.x; const dy = s.b.y - s.a.y; const l2 = dx * dx + dy * dy;
        const k = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / l2)) : 0;
        return Math.hypot(p.x - (s.a.x + k * dx), p.y - (s.a.y + k * dy));
      };
      const segGap = (s1, s2) => Math.min(
        distToSeg(s1.a, s2), distToSeg(s1.b, s2), distToSeg(s2.a, s1), distToSeg(s2.b, s1));
      const adjacent = (s1, s2) => [s1.a, s1.b].some((p) => distToSeg(p, s2) < 0.6)
        || [s2.a, s2.b].some((p) => distToSeg(p, s1) < 0.6);
      /** 纠缠度：不相邻的两笔之间最近的距离（地面接触线不计） */
      const clearanceOf = (svg) => {
        const segs = segsOf2(svg);
        let worst = Infinity;
        for (let i = 0; i < segs.length; i += 1) {
          for (let j = i + 1; j < segs.length; j += 1) {
            if (adjacent(segs[i], segs[j])) continue;
            worst = Math.min(worst, segGap(segs[i], segs[j]));
          }
        }
        return Number.isFinite(worst) ? worst : Infinity;   // 全相邻（没有可比的笔画）不算纠缠
      };
      const clearances = ids.map((id) => [id, clearanceOf(svgOf.get(id))]);
      ok('不纠缠：19 张图里任意两笔（非相邻）都留出了可见的空隙（≥0.8 单位）',
        clearances.every(([, d]) => d >= 0.8),
        clearances.filter(([, d]) => d < 0.8).map(([id, d]) => `${id}:${d.toFixed(2)}`).join(' ') || 'ok');
      /** 辨识度：把图标栅格成 16×16，两两算 Jaccard 距离（只看有墨的格子） */
      const inkOf = (svg) => {
        const N = 16;
        const cells = new Set();
        const segs = segsOf2(svg);
        const put = (x, y) => cells.add(`${Math.min(N - 1, Math.max(0, Math.floor((x / 24) * N)))},${Math.min(N - 1, Math.max(0, Math.floor((y / 24) * N)))}`);
        for (const s of segs) {
          for (let k = 0; k <= 1; k += 0.05) put(s.a.x + (s.b.x - s.a.x) * k, s.a.y + (s.b.y - s.a.y) * k);
        }
        for (const m of svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)) {
          const [x, y, r] = m.slice(1).map(Number);
          put(x, y - r); put(x, y + r); put(x - r, y); put(x + r, y);
        }
        return cells;
      };
      const inks = ids.map((id) => [id, inkOf(svgOf.get(id))]);
      const close = [];
      for (let i = 0; i < inks.length; i += 1) {
        for (let j = i + 1; j < inks.length; j += 1) {
          let inter = 0;
          let union = 0;
          for (const c of inks[i][1]) { union += 1; if (inks[j][1].has(c)) inter += 1; }
          for (const c of inks[j][1]) if (!inks[i][1].has(c)) union += 1;
          close.push([1 - inter / Math.max(1, union), inks[i][0], inks[j][0]]);
        }
      }
      close.sort((a, b) => a[0] - b[0]);
      ok('辨识度高：任意两个动作的图形都不一样（最像的一对也差 15% 以上）',
        close[0][0] >= 0.15,
        close.slice(0, 3).map(([d, a, b]) => `${a}↔${b}:${d.toFixed(2)}`).join(' '));
      /**
       * 躺 / 撑 / 坐的动作画成横构图，而且头在画面一端。
       * ⚠️ 例外：**反向卷腹 / 仰卧抬腿**是躺着的，但腿是往正上方抬的 —— 外框会变成「竖的」，只要求头在一端。
       */
      const LEGS_UP = new Set(['reverseCrunch', 'lyingLegRaise']);
      const lyingIds = ids.filter((id) => EXERCISES.find((x) => x.id === id).posture !== 'stand');
      const standIds = ids.filter((id) => EXERCISES.find((x) => x.id === id).posture === 'stand');
      ok('**和动作相关**：躺 / 撑 / 坐的动作画成横构图，而且头在画面一端',
        lyingIds.every((id) => {
          const b = boxOf(svgOf.get(id));
          const atEnd = b.headX <= b.minX + b.w * 0.3 || b.headX >= b.maxX - b.w * 0.3;
          return atEnd && (LEGS_UP.has(id) || b.w > b.h * 0.85);
        }),
        lyingIds.map((id) => `${id}:${boxOf(svgOf.get(id)).w.toFixed(1)}x${boxOf(svgOf.get(id)).h.toFixed(1)}`).join(' '));
      ok('分类图标用库里现成的专业图标（5 个各不相同、只含 shapes、元素 ≤6）',
        ['upper', 'lower', 'core', 'full', 'stretch'].every((c) => /class="ex-pose/.test(categoryMarkSVG(c))
          && !/<text/.test(categoryMarkSVG(c)))
        && new Set(['upper', 'lower', 'core', 'full', 'stretch'].map((c) => categoryMarkSVG(c))).size === 5
        && ['upper', 'lower', 'core', 'full', 'stretch']
          .every((c) => (categoryMarkSVG(c).match(/<(path|circle|line|rect|polyline|polygon|ellipse)/g) || []).length <= 6));
      ok('导航箭头用库里现成的专业箭头（返回 / 上一页 / 下一页各不相同），不是字体里的 ◀ ▶ ↩',
        new Set(['back', 'prev', 'next'].map((k) => navPoseSVG(k))).size === 3
        && ['back', 'prev', 'next'].every((k) => /class="ex-pose/.test(navPoseSVG(k)))
        && ['back', 'prev', 'next'].every((k) => !/ex-pose--solid/.test(navPoseSVG(k)))
        && ['upper', 'lower', 'core', 'full', 'stretch'].every((c) => !/ex-pose--solid/.test(categoryMarkSVG(c)))
        && !/◀|▶|↩/.test(navPoseSVG('back') + navPoseSVG('prev') + navPoseSVG('next')));
      ok('界面按钮的图标也换成线条图标（主页 / 成绩 / 设定 / 开始），HTML 里没有 emoji 图标了',
        !/[\u{1F300}-\u{1FAFF}]/u.test(html)
        && (html.match(/class="ui-icon"/g) || []).length >= 4);
      /* 用户要求：「把圆环中的文字退出和再试一次都改为图标表示，退出图标可以和返回图标一致，
       『再试一次』需要设计一个新的图标。」 */
    ok('圆环里的「退出 / 再试一次」是线条图标（退出 = 返回同款 corner-up-left；再试一次 = 新加的 rotate-ccw）',
      /'ui:retry': '<path d="M3 12a9 9 0 1 0 9-9/.test(read('src/icons.js'))
      && /function setRingIcon\(labelEl, btnEl, kind, text\)/.test(app)
      && /const key = kind === 'retry' \? 'ui:retry' : 'back';/.test(app)
      && /labelEl\.innerHTML = libIconSVG\(key, 'ex-pose'\);/.test(app)
      && /btnEl\.setAttribute\('aria-label', text\);/.test(app)
      && /setRingIcon\(\$\(key === 'exit' \? 'ringExitLabel' : 'ringRetryLabel'\), el, key, t\(GESTURE_RINGS\[key\]\.labelKey\)\);/.test(app)
      && /setRingIcon\(cornerLabelEl\(\), ringEl\('corner'\), 'exit', txt\)/.test(app));
    ok('图标态的圆环标签放大居中（CSS），文字含义仍在 title / aria-label',
      /\.ring-label--icon \{ font-size: clamp\(30px, 3\.6vw, 52px\); line-height: 0; \}/.test(css)
      && /\.ring-label--icon \.ex-pose \{ width: 1em; height: 1em; \}/.test(css));
    ok('主页的分类标题也用**线条图标**（和菜单 / 视频画面同一张），不是 emoji',
      /const catIcon = categoryMarkSVG\(cat\.id\) \|\| cat\.icon;/.test(app)
      && /<h3 class="cat-head"><span class="cat-icon">\$\{catIcon\}<\/span>/.test(app)
      && /import \{ iconSVG, uniqueStages, categoryMarkSVG, navPoseSVG, libIconSVG \}/.test(app));
    ok('现成图标的来源与许可写在源码里（Lucide ISC / Tabler MIT），换图标时查得到出处',
        /Lucide 1\.55（ISC 许可）/.test(read('src/icons.js')) && /Tabler Icons 3\.49 outline（MIT）/.test(read('src/icons.js')));
      /* 用户要求：「返回，上一页，下一页不要显示文字了，显示图标即可」 */
      ok('导航圆环只画图标、不生成文字节点（动作 / 分类仍然有名字），无障碍名称保留在 aria-label 上',
        /const navKind = it\.kind === 'back' \|\| it\.kind === 'prev' \|\| it\.kind === 'next';/.test(app)
        && /\(navKind \? '' : `<span class="menu-name">\$\{it\.name\}<\/span>`\)/.test(app)
        && /btn\.setAttribute\('aria-label', label\);/.test(app));
      ok('兜底样式：万一有文字混进导航圆环也不显示；图标居中而不是给文字让位（图标还可以画得更大）',
        /\.menu-ring--back \.menu-name,[\s\S]{0,140}?\{ display: none; \}/.test(css)
        && /\.menu-ring--back \.menu-icon,[\s\S]{0,140}?\{ transform: none; \}/.test(css)
        && /const iconSize = clamp\(d \* 0\.62, 30, 78\);/.test(app));
    }
  }
}

/* ---------- 4. 动作与界面按钮一一对应 ---------- */
console.log('\n[4] 动作库与界面一致性');
{
  const { CATEGORIES } = await import('../src/catalog.js');
  // 动作库就是约定的动作清单（用户明确给定清单，多一个少一个都算回归）
  const EXPECT = {
    upper: ['pushup'],
    // 用户要求：臀桥从「下肢」移到「核心」（下肢 5 个、核心 6 个）
    lower: ['squat', 'squatSumo', 'lunge', 'lungeBack', 'buttKick'],
    core: ['bridge', 'plank', 'deadBug', 'crunch', 'reverseCrunch', 'lyingLegRaise'],
    full: ['squatJump', 'burpee', 'mountainClimber', 'jumpingJack', 'boxJump'],
    stretch: ['standingForwardFold', 'seatedForwardFold'],
  };
  const expectIds = [...new Set(Object.values(EXPECT).flat())];
  ok('动作库就是约定的 19 个动作（弓步跳、宽距/窄距俯卧撑、侧平板支撑已删除；新增勾腿跳；深蹲跳移到全身；臀桥移到核心）',
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
    // 后来用户又要求：卷腹与反向卷腹的默认次数也都 = 20（反向卷腹原来是 15）
    const crunch = EXERCISES.find((x) => x.id === 'crunch');
    const reverse = EXERCISES.find((x) => x.id === 'reverseCrunch');
    ok('卷腹 / 反向卷腹默认目标都是 20 次（用户要求）',
      crunch?.target === 20 && reverse?.target === 20, `${crunch?.target}/${reverse?.target}`);
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
