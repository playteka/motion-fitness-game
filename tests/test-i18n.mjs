/**
 * 多语言自检。
 *
 *   1) 四种语言的键结构必须完全一致（缺键 / 多键都会失败）
 *   2) 除中文外的语言不允许残留中日韩字符（说明漏翻，直接抄了中文）
 *   3) 除中文外的语言不允许与中文原文完全相同的长文案（说明没翻）
 *   4) 占位符 {xxx} 必须一一对应（翻译时漏掉占位符会让界面显示成 {deg}）
 *   5) 数组型词条长度必须一致（动作要领 4 条、注意事项 3 条）
 *   6) src/ 与 index.html 里不允许残留写死的中文（必须先经过 t()）
 *
 * 用法：node tests/test-i18n.mjs        # 全量检查
 *      node tests/test-i18n.mjs en     # 只检查英文
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import zh from '../src/locales/zh.js';
import en from '../src/locales/en.js';
import es from '../src/locales/es.js';
import fr from '../src/locales/fr.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = { zh, en, es, fr };
const only = process.argv[2];
const langs = only ? [only] : ['zh', 'en', 'es', 'fr'];

let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const flatten = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
};

const keyed = {};
for (const [lang, dict] of Object.entries(LOCALES)) keyed[lang] = flatten(dict);

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const placeholders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',');

/* ---------- 1. 键结构一致 ---------- */
console.log('\n[1] 键结构一致');
{
  const base = Object.keys(keyed.zh);
  ok(`中文词条共 ${base.length} 条`, base.length > 150, `实际 ${base.length}`);
  for (const lang of langs) {
    if (lang === 'zh') continue;
    const keys = Object.keys(keyed[lang]);
    const missing = base.filter((k) => !(k in keyed[lang]));
    const extra = keys.filter((k) => !(k in keyed.zh));
    ok(`${lang}.js 没有缺键`, missing.length === 0, missing.slice(0, 12).join(', ') + (missing.length > 12 ? ` …共 ${missing.length} 条` : ''));
    ok(`${lang}.js 没有多余键`, extra.length === 0, extra.slice(0, 8).join(', '));
  }
}

/* ---------- 2. 不允许残留中文 ---------- */
console.log('\n[2] 非中文语言不允许残留中文');
for (const lang of langs) {
  if (lang === 'zh') continue;
  const bad = Object.entries(keyed[lang]).filter(([, v]) => typeof v === 'string' && CJK.test(v));
  ok(`${lang}.js 没有中日韩字符残留`, bad.length === 0,
    bad.slice(0, 6).map(([k, v]) => `${k}="${String(v).slice(0, 24)}"`).join(' | ') + (bad.length > 6 ? ` …共 ${bad.length} 条` : ''));
}

/* ---------- 3. 不允许整句照抄中文 ---------- */
console.log('\n[3] 非中文语言不允许整句照抄中文');
for (const lang of langs) {
  if (lang === 'zh') continue;
  const same = Object.entries(keyed[lang]).filter(([k, v]) => typeof v === 'string'
    && typeof keyed.zh[k] === 'string'
    && v === keyed.zh[k]
    && v.replace(/[\s\p{Emoji}\p{Sc}\d{}%°×/·.,:;!?()「」（）]/gu, '').length >= 4);
  ok(`${lang}.js 没有未翻译的整句`, same.length === 0,
    same.slice(0, 6).map(([k]) => k).join(', ') + (same.length > 6 ? ` …共 ${same.length} 条` : ''));
}

/* ---------- 4. 占位符一致 ---------- */
console.log('\n[4] 占位符一致');
for (const lang of langs) {
  if (lang === 'zh') continue;
  const bad = [];
  for (const [k, v] of Object.entries(keyed[lang])) {
    const z = keyed.zh[k];
    if (typeof v !== 'string' || typeof z !== 'string') continue;
    if (placeholders(v) !== placeholders(z)) bad.push(`${k}: {${placeholders(z)}} → {${placeholders(v)}}`);
  }
  ok(`${lang}.js 占位符与中文一致`, bad.length === 0, bad.slice(0, 6).join(' | '));
}

/* ---------- 5. 数组长度一致 ---------- */
console.log('\n[5] 数组型词条长度一致');
for (const lang of langs) {
  if (lang === 'zh') continue;
  const bad = [];
  for (const [k, v] of Object.entries(keyed[lang])) {
    const z = keyed.zh[k];
    if (Array.isArray(z) && (!Array.isArray(v) || v.length !== z.length)) bad.push(`${k}: ${z.length} → ${Array.isArray(v) ? v.length : 'not-array'}`);
  }
  ok(`${lang}.js 数组长度一致（动作要领 / 注意事项）`, bad.length === 0, bad.join(', '));
}

/* ---------- 6. 源码里不允许残留写死的中文 ---------- */
if (!only) {
console.log('\n[6] 源码里不允许残留写死的中文');
{
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));

  const offenders = [];
  for (const file of files) {
    if (file.includes(`${path.sep}locales${path.sep}`)) continue; // 词条文件本身就是文案
    let code = fs.readFileSync(file, 'utf8');
    // 去掉注释后再找中文字符串
    code = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const hits = [...code.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\\n]*)`/g)]
      .map((m) => m[1] ?? m[2] ?? m[3] ?? '')
      .filter((s) => CJK.test(s));
    if (hits.length) offenders.push(`${path.relative(ROOT, file)}: ${hits.slice(0, 4).map((h) => `"${h.slice(0, 20)}"`).join(', ')}${hits.length > 4 ? ` …共 ${hits.length}` : ''}`);
  }
  ok('src/ 下的 JS 里没有写死的中文（必须走 t()）', offenders.length === 0, offenders.join('\n     '));

  // HTML 文本节点
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const htmlHits = [...html.matchAll(/>([^<>]*[\u4e00-\u9fff][^<>]*)</g)].map((m) => m[1].trim()).filter(Boolean);
  ok('index.html 里没有写死的中文（用 data-i18n）', htmlHits.length === 0,
    htmlHits.slice(0, 6).map((h) => `"${h.slice(0, 24)}"`).join(', ') + (htmlHits.length > 6 ? ` …共 ${htmlHits.length}` : ''));
}
}

/* ---------- 7. 四份 README 结构一致 ---------- */
if (!only) {
console.log('\n[7] 四份 README 结构一致');
{
  const files = { zh: 'README.md', en: 'README.en.md', es: 'README.es.md', fr: 'README.fr.md' };
  const stats = {};
  let missing = false;
  for (const [lang, name] of Object.entries(files)) {
    const full = path.join(ROOT, name);
    if (!fs.existsSync(full)) {
      ok(`${name} 存在`, false, '文件缺失');
      missing = true;
      continue;
    }
    // 去掉「必须保留中文」的三类内容后，再统计残留汉字：
    //   1) 顶部的语言切换链接 [中文](README.md)
    //   2) 语言自称「中文」（语言列表、词条表里必须原样保留）
    //   3) 服务器启动输出行 —— preview-server.js 真的会打印这一行中文，
    //      四份文档都如实引用，属于「引用真实输出」而不是漏翻
    const txt = fs.readFileSync(full, 'utf8')
      .replace(/\[中文\]\(README\.md\)/g, '[ZH](README.md)')
      .replace(/体感健身游戏预览地址：[^\n]*/g, '[SERVER_OUTPUT]')
      .replace(/中文/g, 'ZH');
    stats[lang] = {
      name,
      headings: (txt.match(/^#{1,4} /gm) || []).length,
      fences: (txt.match(/^```/gm) || []).length,
      tableRows: (txt.match(/^\|/gm) || []).length,
      toc: (txt.match(/^- \[/gm) || []).length,
      links: (txt.match(/\[[^\]]+\]\(README(\.[a-z]+)?\.md\)/g) || []).length,
      cjk: (txt.match(/[\u4e00-\u9fff]/g) || []).length,
      bytes: Buffer.byteLength(txt, 'utf8'),
    };
  }
  if (!missing) {
    const base = stats.zh;
    ok('四份 README 标题数量一致', ['en', 'es', 'fr'].every((l) => stats[l].headings === base.headings),
      ['zh', 'en', 'es', 'fr'].map((l) => `${l}:${stats[l].headings}`).join(' '));
    ok('四份 README 代码块数量一致（安装命令没被弄丢）',
      ['en', 'es', 'fr'].every((l) => stats[l].fences === base.fences),
      ['zh', 'en', 'es', 'fr'].map((l) => `${l}:${stats[l].fences}`).join(' '));
    ok('四份 README 表格行数一致（计分表没被删行）',
      ['en', 'es', 'fr'].every((l) => stats[l].tableRows === base.tableRows),
      ['zh', 'en', 'es', 'fr'].map((l) => `${l}:${stats[l].tableRows}`).join(' '));
    ok('四份 README 目录条目数一致', ['en', 'es', 'fr'].every((l) => stats[l].toc === base.toc),
      ['zh', 'en', 'es', 'fr'].map((l) => `${l}:${stats[l].toc}`).join(' '));
    ok('四份 README 都有四个语言互链', Object.values(stats).every((s) => s.links === 4),
      Object.values(stats).map((s) => `${s.name}:${s.links}`).join(' '));

    // 目录锚点必须能在本文件里找到对应标题。
    // GitHub 的 slug 规则：转小写 → 去掉标点（空格保留，所以连续空格会变成连续连字符）
    // → 空格换成连字符。注意不能把连续空格合并成一个，否则「a / b」这类标题会误判。
    const slug = (h) => h.toLowerCase()
      .replace(/[^\p{L}\p{N} -]/gu, '')
      .replace(/ /g, '-');
    for (const [lang, name] of Object.entries(files)) {
      const txt = fs.readFileSync(path.join(ROOT, name), 'utf8');
      const headings = new Set([...txt.matchAll(/^#{1,4} (.+)$/gm)].map((m) => slug(m[1])));
      const links = [...txt.matchAll(/^[-\s]*\[[^\]]+\]\(#([^)]+)\)/gm)].map((m) => m[1]);
      const bad = links.filter((a) => !headings.has(a));
      ok(`${name} 的 ${links.length} 个目录锚点都指向真实标题`, bad.length === 0, bad.join(', '));
    }
    ok('三份译本没有残留中文',
      ['en', 'es', 'fr'].every((l) => stats[l].cjk === 0),
      ['en', 'es', 'fr'].filter((l) => stats[l].cjk).map((l) => `${stats[l].name}:${stats[l].cjk} 处`).join(' '));
    ok('三份译本篇幅接近原文（没有大段漏译）',
      ['en', 'es', 'fr'].every((l) => stats[l].bytes > base.bytes * 0.6),
      ['zh', 'en', 'es', 'fr'].map((l) => `${l}:${Math.round(stats[l].bytes / 1024)}KB`).join(' '));
  }
}
}

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
