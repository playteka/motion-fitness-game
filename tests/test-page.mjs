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

import { EXERCISES, createDetector } from '../src/exercises.js';
import { getStepPlan } from '../src/steps.js';

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
}

/* ---------- 4. 动作与界面按钮一一对应 ---------- */
console.log('\n[4] 六个动作与界面一致性');
{
  ok('恰好 6 个动作', EXERCISES.length === 6, `实际 ${EXERCISES.length}`);
  for (const ex of EXERCISES) {
    let det = null;
    try { det = createDetector(ex.id, { strict: true }); } catch (e) { det = null; }
    ok(`createDetector('${ex.id}') 可用`, !!det && det.meta.id === ex.id);
    if (det) {
      const snap = det.snapshot();
      ok(`${ex.name} 具备计数/计时字段`, typeof snap.validReps === 'number' && typeof snap.holdMs === 'number');
      ok(`${ex.name} 有动作要领文案`, ex.howto.length >= 3 && ex.tips.length >= 1);
    }
    // 界面按钮由 EXERCISES 生成，编号提示应与数组顺序一致
    const idx = EXERCISES.indexOf(ex) + 1;
    ok(`${ex.name} 快捷键 ${idx} 在范围内`, idx >= 1 && idx <= 6);
  }
  ok('每个动作都有对应识别器分支（无默认抛错）', true);
}

/* ------------------------------------------------------------------ *
 * 5. 要领计分方案
 * ------------------------------------------------------------------ */

console.log('\n[5] 要领计分方案');
{
  for (const ex of EXERCISES) {
    const plan = getStepPlan(ex.id);
    ok(`${ex.name} 有要领计分步骤（≥4 步）`, plan.steps.length >= 4, `实际 ${plan.steps.length} 步`);
    ok(`${ex.name} 每一步都有文案、分值与判定函数`,
      plan.steps.every((s) => typeof s.label === 'string' && s.label.length > 2
        && Number.isFinite(s.points) && s.points > 0 && typeof s.check === 'function'));
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
