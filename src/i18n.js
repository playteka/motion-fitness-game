/**
 * 轻量国际化内核（零依赖）。
 *
 * 用法：
 *   t('ui.start')                         → 当前语言下 ui.start 的文案
 *   t('summary.missed', { list: '…' })    → 带占位符替换
 *   setLang('en')                         → 切换语言（会写 localStorage 并通知界面刷新）
 *   applyI18n(document)                   → 按 data-i18n / data-i18n-html / data-i18n-title 刷新静态 DOM
 *
 * 语言优先级：用户手动选择 > 浏览器语言 > 英文兜底。
 * 任何键缺失都会回退到英文，再回退到键名本身，不会出现空白界面。
 */

import zh from './locales/zh.js';
import en from './locales/en.js';
import es from './locales/es.js';
import fr from './locales/fr.js';

export const LOCALES = { zh, en, es, fr };
export const LANG_ORDER = ['zh', 'en', 'es', 'fr'];

const STORE_KEY = 'mfg.lang.v1';
let current = 'zh';
const listeners = new Set();

/** 根据浏览器语言挑选默认语言 */
export function detectLang() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved && LOCALES[saved]) return saved;
  } catch { /* ignore */ }
  const nav = (typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage) || 'en').toLowerCase();
  if (nav.startsWith('zh')) return 'zh';
  if (nav.startsWith('es')) return 'es';
  if (nav.startsWith('fr')) return 'fr';
  if (nav.startsWith('en')) return 'en';
  return 'en';
}

export function getLang() { return current; }
export function getMeta(lang = current) { return (LOCALES[lang] || LOCALES.en).meta; }

export function setLang(code, { persist = true } = {}) {
  if (!LOCALES[code] || code === current) {
    if (!LOCALES[code]) return current;
  }
  current = code;
  if (persist) {
    try { localStorage.setItem(STORE_KEY, code); } catch { /* ignore */ }
  }
  const meta = getMeta();
  if (typeof document !== 'undefined') {
    document.documentElement.lang = meta.htmlLang || code;
    if (meta.title) document.title = meta.title;
  }
  for (const fn of listeners) {
    try { fn(code); } catch (err) { console.warn('[i18n] listener failed', err); }
  }
  return current;
}

export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 按点分路径取词条 */
function lookup(dict, key) {
  if (!dict || !key) return undefined;
  const parts = String(key).split('.');
  let node = dict;
  for (const p of parts) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[p];
  }
  return typeof node === 'string' || Array.isArray(node) ? node : undefined;
}

/** 替换 {name} 形式的占位符 */
export function interpolate(template, params) {
  if (typeof template !== 'string' || !params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined || params[k] === null ? m : String(params[k])));
}

/**
 * 取文案。缺失时回退：当前语言 → 英文 → 键名。
 * @param {string} key 点分键，如 'ui.start'
 * @param {object} [params] 占位符
 */
export function t(key, params) {
  let val = lookup(LOCALES[current], key);
  if (val === undefined) val = lookup(LOCALES.en, key);
  if (val === undefined) return key;
  if (Array.isArray(val)) return val;
  return interpolate(val, params);
}

/** 取数组型词条（动作要领、提示列表等） */
export function tList(key) {
  const val = t(key);
  return Array.isArray(val) ? val : [String(val)];
}

/**
 * 某个键在当前语言（或英文兜底）下是否存在。
 * 60+ 动作不可能每个都写全专属提示，识别器靠它决定「用专属文案还是通用文案」。
 */
export function hasKey(key) {
  if (!key) return false;
  const path = String(key).split('.');
  const walk = (dict) => {
    let node = dict;
    for (const p of path) {
      if (node == null || typeof node !== 'object') return false;
      node = node[p];
    }
    return node !== undefined;
  };
  return walk(LOCALES[current]) || walk(LOCALES.en);
}

/**
 * 刷新静态 DOM。
 * 支持属性：
 *   data-i18n            → textContent
 *   data-i18n-html       → innerHTML
 *   data-i18n-title      → title
 *   data-i18n-aria       → aria-label
 *   data-i18n-placeholder→ placeholder
 */
export function applyI18n(root) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const meta = getMeta();
  if (doc.documentElement) doc.documentElement.lang = meta.htmlLang || current;
  if (meta.title && doc === document) document.title = meta.title;

  const each = (sel, attr, apply) => {
    for (const el of doc.querySelectorAll(`[${attr}]`)) {
      const key = el.getAttribute(attr);
      const val = t(key);
      if (typeof val === 'string') apply(el, val);
    }
  };
  each(null, 'data-i18n', (el, v) => { el.textContent = v; });
  each(null, 'data-i18n-html', (el, v) => { el.innerHTML = v; });
  each(null, 'data-i18n-title', (el, v) => { el.title = v; });
  each(null, 'data-i18n-aria', (el, v) => { el.setAttribute('aria-label', v); });
  each(null, 'data-i18n-placeholder', (el, v) => { el.placeholder = v; });
}

/** 供测试使用：把词条对象拍平成 "a.b.c" → 值 */
export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

export function localeKeys(lang) { return Object.keys(flatten(LOCALES[lang])); }

export default { t, tList, setLang, getLang, getMeta, onLangChange, applyI18n, detectLang, LOCALES, LANG_ORDER };
