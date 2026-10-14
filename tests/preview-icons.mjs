// 临时脚本：把整套图标导成独立 SVG + 一张预览图（HTML），供肉眼验收（用完删掉）
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { exercisePoseSVG, categoryMarkSVG, navPoseSVG, libIconSVG, APP_ICON_BOX } from '../src/icons.js';
import { EXERCISES, CATEGORIES } from '../src/catalog.js';
import { localizedExercise } from '../src/exercises.js';

const require = createRequire(import.meta.url);
const out = path.resolve('.icon-preview');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const groups = [
  [`动作姿势图（${EXERCISES.length}，手绘）`, EXERCISES.map((ex) => [ex.id, localizedExercise(ex.id).name, exercisePoseSVG(ex.id)])],
  ['分类（5，Lucide / Tabler 现成图标）', CATEGORIES.map((c) => [c.id, localizedExercise('') && c.id, categoryMarkSVG(c.id)])],
  ['导航（3，Lucide 现成图标）', [['back', '返回', navPoseSVG('back')], ['prev', '上一页', navPoseSVG('prev')], ['next', '下一页', navPoseSVG('next')]]],
  ['界面按钮（10，Lucide 现成图标）', ['ui:brand', '品牌', 'ui:home', '回主页', 'ui:trophy', '最佳成绩', 'ui:history', '运动记录', 'ui:search', '搜索', 'ui:hand', '手势开始', 'ui:camera', '摄像头', 'ui:settings', '设定', 'ui:maximize', '全屏', 'ui:close', '关闭']
    .reduce((acc, v, i, arr) => (i % 2 === 0 ? [...acc, [v, arr[i + 1], libIconSVG(v, 'ui-icon')]] : acc), [])],
];

/**
 * 把 class 换成显式属性。
 *
 * 导出的独立 SVG 没有 CSS，必须自己带上描边；而且**两层要分开处理**：
 * 界面图标 = 细线（stroke 2、圆不填），运动象形图 = 实心（stroke 3、头填实）。
 */
function tint(svg, color) {
  const solid = /ex-pose--solid/.test(svg);
  const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '');
  const shaped = body.replace(/<(line|path|circle|polyline|polygon|rect)\b([^>]*?)\/?>/g, (m, tag, attrs) => {
    const clean = attrs.replace(/\sclass="[^"]*"/g, '').trim();
    const pad = clean ? ` ${clean}` : '';
    if (solid && tag === 'circle') return `<circle${pad} fill="${color}" stroke="none"/>`;
    return `<${tag}${pad} fill="none" stroke="${color}" stroke-width="${solid ? 3 : 2}"`
      + ' stroke-linecap="round" stroke-linejoin="round"/>';
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${APP_ICON_BOX} ${APP_ICON_BOX}"`
    + ` width="${APP_ICON_BOX}" height="${APP_ICON_BOX}">${shaped}</svg>`;
}

let files = 0;
for (const [, items] of groups) {
  for (const [id, , svg] of items) {
    // 独立 SVG 自带描边属性（脱离页面 CSS 也能正确显示）
    fs.writeFileSync(path.join(out, `${id.replace(':', '-')}.svg`), tint(svg, '#e8eefc'));
    files += 1;
  }
}

const cell = (id, label, svg, dark) => `<figure class="${dark ? 'dark' : 'light'}">
  <div class="ico">${svg}</div>
  <figcaption>${label}<span>${id}</span></figcaption>
</figure>`;

const section = ([title, items], i) => `<section>
  <h2>${title}</h2>
  <div class="grid">${items.map(([id, label, svg]) => cell(id, label, svg, i === 0)).join('')}</div>
</section>`;

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>图标集预览 · motion-fitness-game</title>
<style>
  :root { --ink:#e8eefc; }
  body { margin:0; padding:28px 32px 60px; background:#0b1017; color:var(--ink);
         font:14px/1.5 "Segoe UI",system-ui,sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; }
  .spec { color:#8fa3c4; margin:0 0 22px; }
  .spec code { color:#cfe0ff; }
  h2 { font-size:15px; font-weight:600; margin:26px 0 10px; color:#b9cdf0; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(112px,1fr)); gap:12px; }
  figure { margin:0; border:1px solid #1d2a3d; border-radius:12px; padding:12px 8px 8px;
           display:flex; flex-direction:column; align-items:center; gap:8px; background:#0f1622; }
  figure.dark { background:#101c2e; }
  .ico { width:64px; height:64px; display:grid; place-items:center; }
  .ico svg { width:64px; height:64px; color:var(--ink); }
  figure.light .ico svg { color:#0b1017; }
  /* 和 style.css 同一套参数：细线图标 + 实心运动象形图 */
  .ex-pose, .ui-icon { fill:none; stroke:currentColor; stroke-width:2;
                       stroke-linecap:round; stroke-linejoin:round; }
  .ex-pose--solid { stroke-width:3; }
  .ex-pose--solid circle { fill:currentColor; }
  figcaption { font-size:12px; text-align:center; color:#c8d8f5; }
  figcaption span { display:block; color:#6f86a8; font-size:11px; }
  .row { display:flex; gap:24px; flex-wrap:wrap; align-items:flex-end; margin-top:10px; }
  .sizes { display:flex; gap:8px; align-items:flex-end; }
  .sizes svg { color:var(--ink); }
</style></head><body>
<h1>图标集预览（ui-icon-design skill 交付）</h1>
<p class="spec">风格原型 <code>rounded</code> · <code>viewBox 0 0 ${APP_ICON_BOX} ${APP_ICON_BOX}</code> ·
 活动区 20×20 居中 · 界面图标 <code>stroke-width 2</code> / 运动象形图 <code>stroke-width 3 + 头填实</code> ·
 <code>stroke-linecap/linejoin round</code> · 颜色 <code>currentColor</code> · 坐标落在整数 / .5 上 ·
 无 emoji、无位图、无硬编码颜色。现成图标来自 Lucide 1.55（ISC）与 Tabler Icons 3.49 outline（MIT）。</p>
${groups.map(section).join('')}
<section><h2>多尺寸检查（16 / 24 / 48 / 64px，选几个代表）</h2>
<div class="row">${['squat', 'plank', 'jumpingJack', 'back', 'cat:core', 'ui:settings']
    .map((id) => {
      const svg = id.startsWith('cat:') ? categoryMarkSVG(id.slice(4))
        : (id === 'back' ? navPoseSVG('back') : (id.startsWith('ui:') ? libIconSVG(id, 'ui-icon') : exercisePoseSVG(id)));
      return `<div class="sizes">${[16, 24, 48, 64].map((s) => `<div style="text-align:center">
        <div style="width:${s}px;height:${s}px">${svg.replace(/<svg /, `<svg style="width:${s}px;height:${s}px" `)}</div>
        <div style="font-size:10px;color:#6f86a8">${s}</div></div>`).join('')}</div>`;
    }).join('')}</div></section>
</body></html>`;
fs.writeFileSync(path.join(out, 'preview.html'), html);
fs.writeFileSync(path.join(out, 'README.txt'),
  `风格：rounded（stroke 2 / round / round），24×24 网格，20×20 活动区，currentColor。\n`
  + `来源：Lucide 1.55（ISC）、Tabler Icons 3.49 outline（MIT）；动作姿势图为本站手绘（库中无对应动作）。\n`);
console.log(`[preview] ${files} 个 SVG + preview.html -> ${out}`);

// 有 sharp 就顺手出一张 PNG（没有就只留 HTML，和 skill 的脚本一样明确告警而不是静默跳过）
const sharpPaths = ['sharp', path.join(process.env.DSH_HOME || '', 'profiles', 'node_modules', 'sharp')];
const sharp = sharpPaths.reduce((acc, p) => acc || (() => { try { return require(p); } catch { return null; } })(), null);
if (!sharp) {
  console.log('[warn] 没找到 sharp —— 只出了 HTML 预览（PNG 跳过），HTML 里用浏览器看效果一样');
} else {
  const cols = 8;
  const all = groups.flatMap(([, items]) => items);
  const size = 72;
  const rows = Math.ceil(all.length / cols);
  const parts = all.map(([id, , svg], i) => {
    const x = (i % cols) * size;
    const y = Math.floor(i / cols) * size;
    const shape = tint(svg, '#e8eefc').replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    return `<g transform="translate(${x + 12},${y + 12}) scale(2)">${shape}</g>`;
  });
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * size}" height="${rows * size}">`
    + `<rect width="100%" height="100%" fill="#0b1017"/>${parts.join('')}</svg>`;
  await sharp(Buffer.from(sheet), { density: 384 }).png().toFile(path.join(out, '_preview.png'));
  console.log('[preview] 还出了一张 _preview.png（默认深色底）');
}
