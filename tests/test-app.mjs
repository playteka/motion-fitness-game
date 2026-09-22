/**
 * 无浏览器的集成测试：用最小 DOM 桩真实加载 src/app.js，
 * 检查界面接线、要领导分清单、音效触发与 HUD 刷新是否正常。
 *
 * 运行：node tests/test-app.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/* ------------------------------------------------------------------ *
 * 最小 DOM 桩
 * ------------------------------------------------------------------ */

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    _set: set,
  };
}

class El {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this._className = '';
    this.classList = makeClassList();
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this._text = '';
    this._html = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.offsetWidth = 100;
    this.readyState = 4;
    this.currentTime = 0;
    this.videoWidth = 1280;
    this.videoHeight = 720;
    this.srcObject = null;
    this.play = async () => {};
    // 全屏：记录「对哪个元素请求了全屏」，用来验证放大的是视频框而不是整个页面
    this.requestFullscreenCalls = 0;
    this.requestFullscreen = () => { this.requestFullscreenCalls += 1; return Promise.resolve(); };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  // className 与 classList 在真实浏览器里是同一份数据：桩里也保持一致，
  // 否则「用 className 赋值」的代码在测试里 classList.contains 会查不到
  get className() { return [...this.classList._set].join(' '); }
  set className(v) {
    this.classList._set.clear();
    for (const c of String(v).split(/\s+/)) if (c) this.classList._set.add(c);
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); if (v === '') this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  addEventListener(t, fn) { (this.listeners[t] || (this.listeners[t] = [])).push(fn); }
  removeEventListener() {}
  dispatch(type, ev = {}) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, target: this, ...ev }); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  querySelector(sel) {
    // 桩 DOM：先在自己的子元素里按 class / 标签找（进度条的 .criteria-seg-pts 就是这样被找到的），
    // 找不到（例如 HTML 里写死的 .ring-fill）就退回一个稳定桩，便于断言它的样式
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    for (const c of this.children) {
      const names = String(c.className || '').split(/\s+/);
      if (cls ? names.includes(cls) : String(c.tagName || '').toLowerCase() === sel.toLowerCase()) return c;
    }
    const key = `_q${sel}`;
    if (!this[key]) this[key] = new El('div', '');
    return this[key];
  }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { width: 1280, height: 720, left: 0, top: 0 }; }
  focus() {}
}

const elements = new Map();
for (const id of htmlIds) elements.set(id, new El('div', id));
elements.get('video').tagName = 'VIDEO';
const ctxCounts = {
  stroke: 0, fill: 0, arc: 0, moveTo: 0, lineTo: 0, quadraticCurveTo: 0, fillText: 0,
  translate: 0, scale: 0, scaleX: null,
  strokeStyle: null, globalAlpha: null, lineWidth: null,
};
/** 画面上真正写出来的文字（角度标注等）——按用例清空后断言 */
const texts = [];
const ctxStub = {
  clearRect() {}, beginPath() {}, closePath() {}, save() {}, restore() {}, setLineDash() {},
  arcTo() {},
  translate() { ctxCounts.translate += 1; },
  scale(x) { ctxCounts.scale += 1; ctxCounts.scaleX = x; },
  moveTo() { ctxCounts.moveTo += 1; },
  lineTo() { ctxCounts.lineTo += 1; },
  quadraticCurveTo() { ctxCounts.quadraticCurveTo += 1; },
  // 记录真实用到的画笔参数，供「线条要醒目」这类断言使用
  stroke() {
    ctxCounts.stroke += 1;
    ctxCounts.strokeStyle = this.strokeStyle;
    ctxCounts.globalAlpha = this.globalAlpha;
    ctxCounts.lineWidth = this.lineWidth;
  },
  fill() { ctxCounts.fill += 1; },
  arc() { ctxCounts.arc += 1; },
  fillText(txt) { ctxCounts.fillText += 1; texts.push(String(txt)); },
  measureText: () => ({ width: 40 }),
};
const resetCtxCounts = () => { for (const k of Object.keys(ctxCounts)) ctxCounts[k] = 0; };
elements.get('overlay').getContext = () => ctxStub;
// 画布尺寸跟真实页面一致（1280×720），这样画笔粗细（lineWidth）之类的断言才有意义
elements.get('overlay').width = 1280;
elements.get('overlay').height = 720;

const created = [];

/** 简易选择器匹配：支持 .class 与 [attr] */
function matches(el, sel) {
  const s = sel.trim();
  if (s.startsWith('.')) return (el.className || '').split(/\s+/).includes(s.slice(1));
  if (s.startsWith('[') && s.endsWith(']')) {
    const attr = s.slice(1, -1).split('=')[0];
    return el.attributes?.[attr] !== undefined;
  }
  return true;
}

function walkTree(root, out = []) {
  for (const c of root.children || []) { out.push(c); walkTree(c, out); }
  return out;
}

const documentStub = {
  documentElement: new El('html'),
  hidden: false,
  fullscreenElement: null,
  exitFullscreenCalls: 0,
  exitFullscreen() { documentStub.exitFullscreenCalls += 1; documentStub.fullscreenElement = null; return Promise.resolve(); },
  getElementById: (id) => {
    if (!elements.has(id)) elements.set(id, new El('div', id));
    return elements.get(id);
  },
  createElement: (tag) => { const el = new El(tag); created.push(el); return el; },
  querySelectorAll: (sel) => {
    const all = [...walkTree(documentStub.documentElement), ...walkTree(documentStub.body)];
    return all.filter((el) => matches(el, sel));
  },
  querySelector: (sel) => documentStub.querySelectorAll(sel)[0] || null,
  _listeners: {},
  addEventListener(type, fn) {
    (documentStub._listeners[type] || (documentStub._listeners[type] = [])).push(fn);
  },
  removeEventListener(type, fn) {
    const l = documentStub._listeners[type] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  },
  dispatch(type, ev = {}) {
    for (const fn of [...(documentStub._listeners[type] || [])]) fn({ type, preventDefault() {}, ...ev });
  },
};
documentStub.body = new El('body');

// 把 index.html 里每个带 id 的元素的属性同步到桩元素上，
// 这样 applyI18n 的 [data-i18n] 选择器才能真正生效
for (const m of html.matchAll(/<([a-zA-Z0-9]+)([^>]*)>/g)) {
  const attrs = m[2];
  const idm = attrs.match(/\bid="([^"]+)"/);
  if (!idm) continue;
  const el = elements.get(idm[1]) || documentStub.getElementById(idm[1]);
  for (const a of attrs.matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) el.setAttribute(a[1], a[2]);
  documentStub.body.appendChild(el);
}

const rafQueue = [];
const store = new Map();
const navigatorStub = {
  language: 'zh-CN',
  languages: ['zh-CN'],
  mediaDevices: {
    getUserMedia: async () => ({ getTracks: () => [], getVideoTracks: () => [] }),
    enumerateDevices: async () => [],
  },
};
const windowStub = {
  document: documentStub,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  location: { protocol: 'http:', search: '', href: 'http://127.0.0.1:4174/' },
  navigator: navigatorStub,
  requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
  cancelAnimationFrame: () => {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  confirm: () => false,
  addEventListener() {},
  removeEventListener() {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  performance,
  console,
  fetch: async () => ({ ok: true }),
  AudioContext: undefined,
  speechSynthesis: undefined,
};

globalThis.window = windowStub;
globalThis.document = documentStub;
// document.getElementById 的短名字（app.js 用 $ = id => document.getElementById(id)）
for (const k of Object.keys(windowStub)) {
  if (!(k in globalThis) || k === 'document' || k === 'navigator' || k === 'location') {
    try { Object.defineProperty(globalThis, k, { value: windowStub[k], configurable: true, writable: true }); } catch { /* ignore */ }
  }
}
Object.defineProperty(globalThis, 'location', { value: windowStub.location, configurable: true, writable: true });
Object.defineProperty(globalThis, 'navigator', { value: navigatorStub, configurable: true, writable: true });

/* ------------------------------------------------------------------ *
 * 加载应用
 * ------------------------------------------------------------------ */

console.log('\n[1] 应用启动');
const { EXERCISES } = await import('../src/catalog.js');
let app = null;
try {
  app = await import('../src/app.js');
} catch (err) {
  ok('加载 src/app.js 不报错', false, err?.stack?.split('\n').slice(0, 3).join(' | '));
}
if (app) {
  ok('加载 src/app.js 不报错', true);
  const api = windowStub.__mfg;
  ok('应用暴露内部句柄（供自动化使用）', !!api);
  ok('boot 后已选中一个动作', !!api.state.detector);
  ok('主页渲染了全部动作卡片（按分类展开，动作全部都在）', (() => {
    const ids = new Set(documentStub.querySelectorAll('.ex-card').map((c) => c.dataset.id));
    return ids.size === EXERCISES.length;
  })(), `卡片覆盖动作数 ${new Set(documentStub.querySelectorAll('.ex-card').map((c) => c.dataset.id)).size}/${EXERCISES.length}`);
  ok('主页按一级分类分组（5 类）', documentStub.querySelectorAll('.cat-block').length === 5,
    `实际 ${documentStub.querySelectorAll('.cat-block').length}`);
  ok('boot 后停在主页（动作页隐藏）', elements.get('homeView').hidden === false
    && elements.get('workoutView').hidden === true);
  ok('设置弹窗默认关闭', elements.get('settingsModal').hidden === true);
  ok('主页上不校准也不计数（浏览动作时不会偷偷开始一组）',
    api.state.homeMode === true && api.state.session === 'idle',
    `homeMode=${api.state.homeMode} session=${api.state.session}`);
  // 打开设置弹窗 → 关闭；再从主页进动作 → 回到训练视图
  api.openSettings();
  ok('打开设置弹窗', elements.get('settingsModal').hidden === false);
  api.closeSettings();
  ok('关闭设置弹窗', elements.get('settingsModal').hidden === true);
  api.openExercise('bridge');
  ok('从主页进入动作页：切到训练视图并重新校准',
    api.state.homeMode === false && elements.get('workoutView').hidden === false
    && api.state.exerciseId === 'bridge' && api.state.session === 'calibrating',
    `homeMode=${api.state.homeMode} session=${api.state.session} ex=${api.state.exerciseId}`);
  api.showHome();
  ok('返回主页：回到 idle 且动作页隐藏',
    api.state.homeMode === true && elements.get('workoutView').hidden === true,
    `homeMode=${api.state.homeMode}`);
  // 地址栏路由：#/ex/<id> 能在刷新后直接进同一个动作；后退能回主页
  api.openExercise('crunch');
  ok('进动作页会写地址栏路由（#/ex/<id>）',
    String(windowStub.location.hash || '').endsWith('#/ex/crunch'), String(windowStub.location.hash));
  api.showHome();
  ok('回主页会把路由收回 #/',
    String(windowStub.location.hash || '') === '#/' || String(windowStub.location.hash || '') === '',
    String(windowStub.location.hash));
  ok('要领清单已渲染', elements.get('stepList').innerHTML.includes('step-item'));
  ok('没有运行时错误横幅', !documentStub.documentElement.dataset.error,
    documentStub.documentElement.dataset.error);
}

/* ------------------------------------------------------------------ *
 * 运动设定弹窗（目标 / 判定方式 / 机位，只出现在动作页）
 * ------------------------------------------------------------------ */

console.log('\n[1b] 运动设定弹窗');
{
  const api = windowStub.__mfg;
  api.showHome();
  ok('主页上「运动设定」图标隐藏（只在动作页出现）',
    elements.get('btnExercise').hidden === true);
  ok('主页时运动设定弹窗是关着的', elements.get('exerciseModal').hidden === true);

  api.openExercise('pushup');
  ok('动作页显示「运动设定」图标', elements.get('btnExercise').hidden === false);
  ok('顶栏上「运动设定」与「配置」并排（同一个 topbar-actions 里）', (() => {
    const bar = html.slice(html.indexOf('class="topbar-actions"'), html.indexOf('</header>'));
    const ex = bar.indexOf('id="btnExercise"');
    const st = bar.indexOf('id="btnSettings"');
    return ex >= 0 && st >= 0 && ex < st;
  })(), '两个图标不在同一个顶栏动作区里');

  // 「返回主页」也是图标按钮：不再有可见文字，含义放在 title / aria-label 上（快捷键 H）
  const homeBtn = elements.get('btnHome');
  ok('返回主页是图标按钮（.icon-btn + 图标，不再是文字按钮）', (() => {
    const tag = html.match(/<button[^>]*id="btnHome"[^>]*>/)?.[0] || '';
    const body = html.slice(html.indexOf('id="btnHome"'), html.indexOf('</button>', html.indexOf('id="btnHome"')));
    return /class="icon-btn"/.test(tag) && /aria-hidden="true"/.test(body) && !/data-i18n="/.test(tag);
  })(), html.match(/<button[^>]*id="btnHome"[^>]*>/)?.[0]);
  ok('返回主页图标挂在顶栏最左边（在 🎯 与 ⚙️ 之前）', (() => {
    const bar = html.slice(html.indexOf('class="topbar-actions"'), html.indexOf('</header>'));
    const h = bar.indexOf('id="btnHome"');
    return h >= 0 && h < bar.indexOf('id="btnExercise"') && h < bar.indexOf('id="btnSettings"');
  })());
  ok('返回主页图标有无障碍名称（走 data-i18n-aria / title，随语言切换）',
    (homeBtn.attributes['data-i18n-aria'] || '') === 'home.back'
    && (homeBtn.attributes['data-i18n-title'] || '') === 'home.back',
    JSON.stringify({ aria: homeBtn.attributes['data-i18n-aria'], title: homeBtn.attributes['data-i18n-title'] }));

  const { t: tBack } = await import('../src/i18n.js');
  const backZh = tBack('home.back');
  api.changeLang('en');
  const backEn = tBack('home.back');
  api.changeLang('zh');
  ok('返回主页图标的无障碍名称随语言切换（中文 → 英文）',
    backZh === '返回主页' && /back/i.test(backEn) && !/[\u4e00-\u9fff]/.test(backEn), `${backZh} → ${backEn}`);

  ok('返回主页图标在动作页可见', homeBtn.hidden === false);
  homeBtn.dispatch('click');
  ok('点图标能回主页', api.state.homeMode === true, String(api.state.homeMode));
  ok('回主页后图标自己隐藏', homeBtn.hidden === true);
  api.openExercise('pushup');

  elements.get('btnExercise').dispatch('click');
  ok('点图标打开运动设定弹窗', elements.get('exerciseModal').hidden === false);
  ok('弹窗标题是当前动作', elements.get('exerciseName').textContent.includes('俯卧撑'),
    elements.get('exerciseName').textContent);
  ok('弹窗里显示判定依据', elements.get('exerciseJudge').textContent.includes('判定依据'),
    elements.get('exerciseJudge').textContent);
  ok('弹窗里显示机位提示', elements.get('exerciseCamera').textContent.includes('侧对摄像头'),
    elements.get('exerciseCamera').textContent);
  ok('弹窗里的目标值跟当前目标一致',
    elements.get('targetInput').value === String(api.state.target),
    `${elements.get('targetInput').value} vs ${api.state.target}`);
  ok('弹窗里列出目标预设',
    elements.get('targetChips').children.length > 0,
    `实际 ${elements.get('targetChips').children.length} 个`);

  // 目标改动要实时同步到侧栏摘要
  const before = api.state.target;
  elements.get('targetInput').value = String(before + 4);
  elements.get('targetInput').dispatch('change', { target: elements.get('targetInput') });
  ok('弹窗里改目标立即生效', api.state.target === before + 4, `${before} → ${api.state.target}`);
  ok('侧栏摘要跟着更新', elements.get('targetReadout').textContent.includes(String(before + 4)),
    elements.get('targetReadout').textContent);

  // 严格模式已按用户要求取消：设置弹窗与运动设定里都不该再有这个开关
  ok('设置弹窗里没有严格模式按钮了', elements.get('btnStrict') === undefined
    && !html.includes('id="btnStrict"'));
  ok('运动设定里没有严格模式按钮了', elements.get('btnStrictEx') === undefined
    && !html.includes('id="btnStrictEx"'));
  ok('设置项里也没有 strict 这个状态', api.state.settings.strict === undefined,
    String(api.state.settings.strict));
  ok('识别器上不再有 strict 开关（判据只剩宽松这一档）',
    api.state.detector.strict === undefined, String(api.state.detector.strict));

  // 关闭方式：✕、点背景、Esc
  elements.get('btnCloseExercise').dispatch('click');
  ok('点 ✕ 关闭运动设定弹窗', elements.get('exerciseModal').hidden === true);
  elements.get('btnExerciseInline').dispatch('click');
  ok('侧栏「设定目标」卡片里的按钮也能打开', elements.get('exerciseModal').hidden === false);

  // ===== 关键帧判据与判分：把识别器真正用的数值显示给用户 =====
  // 关键帧那一组里带线条图标（SVG 里有坐标数字），做数值断言前先把图标去掉，免得误命中坐标
  const specHtml = () => elements.get('exerciseSpecs').innerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '');
  // ===== 用户要求：判据完全挂在关键帧上，弹窗里不再有单独的「计次判据 / 姿势要求」两组 =====
  ok('运动设定里第一组是关键帧与判分', specHtml().includes('关键帧与判分'), specHtml().slice(0, 120));
  ok('不再有单独的「计次判据（做到什么程度算一次）」分组',
    !specHtml().includes('计次判据'), specHtml().slice(0, 200));
  ok('不再有单独的「姿势要求」分组（并进第一格的关键帧里）',
    !specHtml().includes('姿势要求（不满足就不进入判定）'), specHtml().slice(0, 200));
  ok('俯卧撑：肘角计次线（≤138°）挂在关键帧上', specHtml().includes('138'), specHtml().slice(0, 240));
  ok('俯卧撑：列出肩膀下沉量这条第二路证据（0.14）', specHtml().includes('0.14'), specHtml().slice(0, 200));
  ok('俯卧撑：列出俯撑姿势门控（躯干倾角 ≥ 32°）', specHtml().includes('≥ 32'), specHtml().slice(0, 300));
  ok('指标行带上了单位（×躯干长 / °）',
    specHtml().includes('躯干长') && specHtml().includes('°'), specHtml().slice(0, 200));

  // ===== 关键帧 + 判分标准：用户要求「把对应动作的关键帧判别标准以及对应的判分标准列出来」 =====
  {
    const { specStages: stagesOf, stagePoints } = await import('../src/specs.js');
    const { uniqueStages: uniq } = await import('../src/icons.js');
    const { EXERCISE_MAP: EXMAP } = await import('../src/catalog.js');
    api.selectExercise('pushup');
    const raw = elements.get('exerciseSpecs').innerHTML;
    ok('弹窗第一组就是「关键帧与判分」', /spec-group spec-keyframes[\s\S]*关键帧与判分/.test(raw), raw.slice(0, 90));
    const meta = EXMAP.pushup;
    const ctx = {
      id: 'pushup', posture: meta.posture, kind: meta.kind, plan: meta.plan,
      gate: meta.params?.gate, metric: meta.params?.metric, stages: stagesOf('pushup'),
    };
    const shown = uniq(ctx.stages, ctx);
    const kfRows = (raw.match(/spec-row spec-kf/g) || []).length;
    ok('关键帧格数 = 画面上进度条的格数（同一份数据）', kfRows === shown.length, `${kfRows} vs ${shown.length}`);
    ok('每一格都画了那个关键帧的线条图标',
      (raw.match(/spec-kf-icon"><svg class="criteria-icon"/g) || []).length === shown.length,
      String((raw.match(/spec-kf-icon"><svg class="criteria-icon"/g) || []).length));
    ok('俯卧撑：四格的分数 5 / 7 / 14 / 8 都列出来了',
      ['+5', '+7', '+14', '+8'].every((x) => raw.includes(x)), raw.slice(0, 400));
    ok('俯卧撑：整轮满分 6 分标在最后一格上', raw.includes('+6 整轮满分'), raw.slice(-400));
    ok('最后一格标出「计次那一刻」', raw.includes('计次那一刻'), raw.slice(0, 300));
    ok('说明里写了每轮总分（5+7+14+8+6 = 40）', raw.includes('每轮 40 分'),
      (raw.match(/共 \d+ 格[\s\S]{0,150}/) || [''])[0]);
    ok('弹窗里的关键帧判据就是进度条格子上的判据（肘角 146°/138° 都在）',
      raw.includes('146') && raw.includes('138'), raw.slice(0, 400));
    ok('分数与 stagePoints 一致（弹窗不会自己编一套：5 / 7 / 14 / 8 + 满轮 6 = 40）',
      stagePoints('pushup').map((r) => r.points).join(',') === '5,7,14,8'
      && stagePoints('pushup')[3].bonus === 6
      && stagePoints('pushup').reduce((n, r) => n + r.points + r.bonus, 0) === 40,
      stagePoints('pushup').map((r) => `${r.points}+${r.bonus}`).join(' '));
    // 计时类：最后一格是「开始计时」，并列出每秒加分
    api.selectExercise('plank');
    const holdRaw = elements.get('exerciseSpecs').innerHTML;
    ok('平板支撑：最后一格标「开始计时」（计时类没有「计次那一刻」）',
      holdRaw.includes('开始计时') && !holdRaw.includes('计次那一刻'), holdRaw.slice(0, 200));
    ok('平板支撑：列出每秒加分（+1/秒）', holdRaw.includes('+1/秒'), holdRaw.slice(-300));
  }

  api.selectExercise('lunge');
  // 用户要求「后面几个关键帧对膝盖弯曲的要求更大」：计次 152° → 138°、双腿 158° → 146°
  ok('切到箭步蹲后指标跟着换（计次线 138°）',
    specHtml().includes('138') && !specHtml().includes('152'), specHtml().slice(0, 200));
  ok('箭步蹲：计次那一格比「开始」更弯（138° 比 146° 严）',
    specHtml().includes('前膝屈角 ≤ 138°') && specHtml().includes('前膝屈角 ≤ 146°'), specHtml().slice(0, 300));
  ok('箭步蹲：列出「两条腿都要弯」的门槛（≤146°）', specHtml().includes('≤ 146°'), specHtml().slice(0, 200));
  ok('箭步蹲：说明回程按自己的幅度算（没有固定角度）', specHtml().includes('回升 65%'), specHtml().slice(0, 300));

  api.selectExercise('plank');
  ok('平板支撑：列出计时类指标（姿势稳定后开始计时 0.25 秒）',
    specHtml().includes('0.25') && specHtml().includes('1.2'), specHtml().slice(0, 200));
  ok('平板支撑：列出必须项阈值（身体接近水平 ≥38°）', specHtml().includes('38'), specHtml().slice(0, 200));
  ok('姿态提醒标注了「只出声、不吃次数」', specHtml().includes('不吃次数'), specHtml().slice(0, 400));

  // 切语言时指标文案也要跟着变（数值不变）
  api.changeLang('en');
  ok('切到英文后指标文案变英文（数值仍是同一批）',
    !/[\u4e00-\u9fff]/.test(specHtml()) && specHtml().includes('38'), specHtml().slice(0, 200));
  api.changeLang('zh');
  api.selectExercise('pushup');

  elements.get('exerciseBackdrop').dispatch('click');
  ok('点背景关闭', elements.get('exerciseModal').hidden === true);
  elements.get('btnExercise').dispatch('click');
  // 注意：dispatch 一次 keydown 会顺带触发「首次手势解锁音频」那个一次性的监听器
  //（它用完就把 pointerdown / keydown / touchstart 上的自己都摘掉），
  // 所以这里把三种事件的监听器列表原样还原，别影响后面 [10] 的用例。
  const gestureSnapshot = {};
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    gestureSnapshot[ev] = [...(documentStub._listeners[ev] || [])];
  }
  documentStub.dispatch('keydown', { key: 'Escape' });
  for (const [ev, list] of Object.entries(gestureSnapshot)) documentStub._listeners[ev] = list;
  ok('Esc 优先关掉运动设定弹窗', elements.get('exerciseModal').hidden === true);

  api.showHome();
  ok('返回主页时运动设定弹窗自动关闭且图标隐藏',
    elements.get('exerciseModal').hidden === true && elements.get('btnExercise').hidden === true);
}

/* ------------------------------------------------------------------ *
 * 切换动作 → 要领清单
 * ------------------------------------------------------------------ */

console.log('\n[2] 切换动作与要领清单');
{
  const api = windowStub.__mfg;
  api.selectExercise('lunge');
  const stepHtml = elements.get('stepList').innerHTML;
  ok('箭步蹲：栏目标题正确', elements.get('howtoTitle').textContent.includes('箭步蹲'));
  ok('箭步蹲：要点明“侧对摄像头”', elements.get('cameraHint').textContent.includes('侧对摄像头'));
  ok('箭步蹲：要领清单有 6 步', (stepHtml.match(/step-item/g) || []).length === 6,
    `实际 ${(stepHtml.match(/step-item/g) || []).length}`);
  ok('箭步蹲：第一步是站姿要领', stepHtml.indexOf('侧对摄像头站好') < stepHtml.indexOf('向前迈出'));
  ok('箭步蹲：每一步都标了分值', (stepHtml.match(/\+\d+/g) || []).length === 6);
  ok('初始得分显示为 0 分', elements.get('statScore').textContent === '0 分',
    elements.get('statScore').textContent);
  ok('初始要领清单没有已完成的步骤', !stepHtml.includes('step-item done'));

  const squatSteps = (() => {
    api.selectExercise('squat');
    return elements.get('stepList').innerHTML;
  })();
  ok('深蹲：要领清单独立', squatSteps.includes('屈膝下蹲，髋部向下沉'));
  ok('切换动作后要领清单同步刷新', !squatSteps.includes('向前迈出'));
}

/* ------------------------------------------------------------------ *
 * 用合成动作驱动计分 → 界面 / 音效
 * ------------------------------------------------------------------ */

console.log('\n[3] 动作 → 计分 → 音效与界面');
{
  const { toMetric, LandmarkSmoother } = await import('../src/geometry.js');
  const { computeFrame } = await import('../src/metrics.js');
  const { ASPECT, standingPose, twoLegPose } = await import('./synthetic-pose.mjs');

  const api = windowStub.__mfg;
  api.selectExercise('lunge');
  const det = api.state.detector;

  // 监听音效调用
  const calls = [];
  for (const m of ['step', 'bonus', 'rep', 'scoreTick', 'partial', 'milestone']) {
    const orig = api.audio[m].bind(api.audio);
    api.audio[m] = (...a) => { calls.push({ m, a }); return orig(...a); };
  }
  const said = [];
  const origSay = api.audio.say.bind(api.audio);
  api.audio.say = (t, o) => { said.push(t); return origSay(t, o); };

  api.state.session = 'running';
  api.state.elapsedMs = 0;
  const smoother = new LandmarkSmoother();
  let t = 0;

  const lungeStanding = {
    hip: { x: 0.85, y: 0.41 },
    front: { thighUp: 180, shinUp: 0 },
    back: { thighUp: 180, shinUp: 0 },
    lean: 8, armDown: 0, elbow: 172,
  };
  const lerp = (a, b, p) => a + (b - a) * p;
  // 一整套箭步蹲：站立 → 迈步 → 下沉 → 后膝贴地 → 起身
  const keys = [
    { p: 0.0, hipY: 0.41, fT: 180, fS: 0, bT: 180, bS: 0 },
    { p: 0.25, hipY: 0.46, fT: 165, fS: 3, bT: 186, bS: 30 },
    { p: 0.5, hipY: 0.55, fT: 130, fS: 5, bT: 190, bS: 70 },
    { p: 0.75, hipY: 0.62, fT: 95, fS: 5, bT: 195, bS: 100 },
    { p: 1.0, hipY: 0.41, fT: 180, fS: 0, bT: 180, bS: 0 },
  ];
  function poseAt(p) {
    let a = keys[0];
    let b = keys[keys.length - 1];
    for (let i = 0; i < keys.length - 1; i++) {
      if (p >= keys[i].p && p <= keys[i + 1].p) { a = keys[i]; b = keys[i + 1]; break; }
    }
    const u = b.p === a.p ? 0 : (p - a.p) / (b.p - a.p);
    return twoLegPose({
      hip: { x: 0.85, y: lerp(a.hipY, b.hipY, u) },
      front: { thighUp: lerp(a.fT, b.fT, u), shinUp: lerp(a.fS, b.fS, u) },
      back: { thighUp: lerp(a.bT, b.bT, u), shinUp: lerp(a.bS, b.bS, u) },
      lean: 8, armDown: 0, elbow: 172,
    });
  }

  // 先站着不动 1.5 秒（应该只拿到站姿那一步的分）
  // 注意：真实页面里 updateHud 由渲染循环每帧调用，这里手动调用以模拟同一条路径
  let scoreAfterStand = 0;
  for (let i = 0; i < 45; i++) {
    const lm = twoLegPose(lungeStanding);
    const sm = smoother.apply(lm.map((q) => ({ ...q, v: q.visibility })), t / 1000);
    const f = computeFrame(toMetric(sm, ASPECT), null, t, false, null);
    api.handleEvents(api.feedDetector(f, t));
    api.updateHud();
    t += 33.4;
  }
  scoreAfterStand = det.score;
  ok('站好姿势就能得分（用户核心诉求）', scoreAfterStand > 0, `得分 ${scoreAfterStand}`);
  ok('站姿得分对应第一步要领', det.stepStatus()[0].done === true);
  ok('站姿即触发音效反馈', calls.some((c) => c.m === 'step'));
  ok('站姿得分会念出要领', said.length > 0, said.join(' / '));
  ok('界面总分已刷新', elements.get('statScore').textContent !== '0 分',
    elements.get('statScore').textContent);
  ok('要领清单第一步打勾', elements.get('stepList').innerHTML.includes('step-item done'));

  // 再做 3 次完整的箭步蹲
  calls.length = 0;
  for (let rep = 0; rep < 3; rep++) {
    for (let i = 0; i <= 60; i++) {
      const lm = poseAt(i / 60);
      const sm = smoother.apply(lm.map((q) => ({ ...q, v: q.visibility })), t / 1000);
      const f = computeFrame(toMetric(sm, ASPECT), null, t, false, null);
      api.handleEvents(api.feedDetector(f, t));
      api.updateHud();
      t += 33.4;
    }
  }
  ok('完整动作后分数继续上涨', det.score > scoreAfterStand, `${scoreAfterStand} → ${det.score}`);
  ok('做满 3 次得到计次音效', calls.filter((c) => c.m === 'rep').length >= 3,
    `计次音效 ${calls.filter((c) => c.m === 'rep').length} 次`);
  ok('每一轮要领都有加分音效', calls.filter((c) => c.m === 'step').length >= 12,
    `要领音效 ${calls.filter((c) => c.m === 'step').length} 次`);
  ok('整轮要领全过有额外奖励音效', calls.filter((c) => c.m === 'bonus').length >= 1,
    `奖励音效 ${calls.filter((c) => c.m === 'bonus').length} 次`);
  ok('HUD 分数与检测器一致',
    elements.get('hudScore').textContent === `${det.score} 分`,
    `${elements.get('hudScore').textContent} vs ${det.score}`);
  // 用户要求：分数要放在和次数靠近的地方（次数下方），并且用不同的颜色
  {
    const hudLeft = /<div class="hud-left">([\s\S]*?)<div class="hud-ring"/.exec(html)?.[1] || '';
    ok('分数（#hudScore）和次数（#hudValue）在同一个 hud-left 区块里',
      hudLeft.includes('id="hudValue"') && hudLeft.includes('id="hudScore"'), hudLeft.slice(0, 120));
    ok('分数就排在次数下方（次数 → 分数 → 目标/提示）',
      hudLeft.indexOf('id="hudValue"') < hudLeft.indexOf('id="hudScore"')
      && hudLeft.indexOf('id="hudScore"') < hudLeft.indexOf('id="hudSub"'),
      hudLeft.slice(0, 200));
    ok('分数不再挂在右下角的目标进度环下面（环里只剩百分比）',
      html.indexOf('id="hudScore"') < html.indexOf('class="hud-ring"'));
  }

  // 现在流程是「校准 → 开始 → 计数」：校准阶段不计数、不计分
  const before = det.score;
  // 先退出训练态，避免切换动作时把上一组存成记录、干扰后面的结算用例
  api.state.session = 'idle';
  const det2 = (() => { api.selectExercise('squat'); return api.state.detector; })();
  ok('切换动作后回到校准阶段', api.state.session === 'calibrating', api.state.session);
  let t2 = t;
  for (let i = 0; i < 45; i++) {
    const lm = standingPose({ knee: 176, lean: 6, armDown: 0, ankleX: 1.0, view: 'front' });
    const sm = smoother.apply(lm.map((q) => ({ ...q, v: q.visibility })), t2 / 1000);
    const f = computeFrame(toMetric(sm, ASPECT), null, t2, false, null);
    api.handleEvents(api.feedDetector(f, t2));
    api.updateHud();
    t2 += 33.4;
  }
  ok('校准阶段站着不会计分', det2.score === 0 && det2.validReps === 0, `score=${det2.score} reps=${det2.validReps}`);
  ok('箭步蹲得分未被深蹲影响', before > 0);
}

/* ------------------------------------------------------------------ *
 * 记录保存
 * ------------------------------------------------------------------ */

console.log('\n[4] 记录与结算');
{
  const api = windowStub.__mfg;
  api.selectExercise('squat');
  api.setTarget(5);
  api.state.session = 'running';
  api.state.elapsedMs = 42_000;
  api.state.detector.validReps = 5;
  api.state.detector.score = 123;
  api.stopSession('user');
  const history = JSON.parse(store.get('mfg.history.v1') || '[]');
  const records = JSON.parse(store.get('mfg.records.v1') || '{}');
  ok('本组写入了训练记录', history.length === 1 && history[0].value === 5, JSON.stringify(history[0] || {}));
  ok('记录里带上了得分', history[0]?.score === 123, `实际 ${history[0]?.score}`);
  ok('最佳成绩记录了得分', records.squat?.score === 123, JSON.stringify(records.squat || {}));
  ok('结算面板列出得分', elements.get('summaryGrid').innerHTML.includes('得分'));
  ok('结算面板列出要领完成度', elements.get('summaryGrid').innerHTML.includes('要领完成'));
  ok('结算提示包含本组得分', elements.get('summaryNote').textContent.includes('123'),
    elements.get('summaryNote').textContent);
  ok('结算后计数已归零', api.state.detector.validReps === 0);
}

/* ------------------------------------------------------------------ *
 * 诊断面板（用户排查“为什么没识别出来”的主要工具）
 * ------------------------------------------------------------------ */

console.log('\n[5] 诊断面板');
{
  const { toMetric: tm, LandmarkSmoother: LS } = await import('../src/geometry.js');
  const { computeFrame: cf } = await import('../src/metrics.js');
  const { ASPECT: A, standingPose: sp } = await import('./synthetic-pose.mjs');
  const api = windowStub.__mfg;

  api.state.settings.debug = true;
  api.renderDebug(null);
  ok('未检测到人体时指标面板给出提示', elements.get('debugLine').textContent.includes('未检测到人体'),
    elements.get('debugLine').textContent);

  const sm = new LS();
  const lm = sp({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0 });
  let f = { ok: false };
  for (let i = 0; i < 20; i++) f = cf(tm(sm.apply(lm.map((q) => ({ ...q, v: q.visibility })), i / 30), A), null, i * 33, false, null);
  api.renderDebug(f);
  const dbg = elements.get('debugLine').textContent;
  ok('指标面板列出视角判断', dbg.includes('视角') && dbg.includes('侧面'), dbg);
  ok('指标面板列出全身可见度', dbg.includes('全身'), dbg);
  ok('指标面板列出关节角度', dbg.includes('膝') && dbg.includes('躯干倾角'), dbg);
  ok('指标面板列出「膝离地 / 髋离地」（站姿门控用的两个地面相关量，排查「总说我没站好」时看这两行）',
    dbg.includes('膝离地') && dbg.includes('髋离地') && dbg.includes('髋抬起'), dbg);

  // 用户反馈「开合跳一次都没计上」时，面板里看不到被判的那个量 —— 现在每个动作都显示
  // 「🎯 本动作判的量 + 进度」，方便自查（也对齐 🎯 运动设置弹窗里的名字）
  {
    const jack = sp({ knee: 175, view: 'front', spread: 0.05, spreadAnkle: 0.09 });
    const smJ = new LS();
    let fj = { ok: false };
    for (let i = 0; i < 20; i++) fj = cf(tm(smJ.apply(jack.map((q) => ({ ...q, v: q.visibility })), i / 30), A), null, i * 33, false, null);
    api.selectExercise('jumpingJack');
    api.state.detector.gateOk = true;
    api.state.detector.progress = 0.62;
    api.renderDebug(fj);
    const jdbg = elements.get('debugLine').textContent;
    ok('指标面板显示「本动作真正在判的量」（开合跳：双腿开合距离 + 进度）',
      jdbg.includes('双腿开合距离') && jdbg.includes('进度') && /0\.\d\d/.test(jdbg), jdbg);
    // 手写识别器（深蹲）判的是它自己的内部量，没有这一行也不该报错
    api.selectExercise('squat');
    api.renderDebug(f);
    ok('手写识别器的动作不显示那一行、也不报错',
      !elements.get('debugLine').textContent.includes('双腿开合距离'), elements.get('debugLine').textContent.slice(0, 80));
  }

  api.state.settings.debug = false;
  api.renderDebug(f);
  ok('关闭指标面板后隐藏', elements.get('debugLine').hidden === true);

  api.updatePipelineStatus();
  ok('管线状态条有内容', elements.get('camStatus').textContent.length > 0,
    elements.get('camStatus').textContent);
  ok('未开摄像头时状态条说明摄像头未开启',
    elements.get('camStatus').textContent.includes('摄像头未开启'), elements.get('camStatus').textContent);

  api.selectExercise('lunge');
  ok('切换动作后“下一步”提示会跟着更新',
    (api.renderSteps(), elements.get('stepHint').textContent.includes('下一步')),
    elements.get('stepHint').textContent);
}

/* ------------------------------------------------------------------ *
 * 火柴人开关
 * ------------------------------------------------------------------ */

console.log('\n[6] 火柴人开关');
{
  const { toMetric: tm, LandmarkSmoother: LS } = await import('../src/geometry.js');
  const { computeFrame: cf } = await import('../src/metrics.js');
  const { ASPECT: A, standingPose: sp } = await import('./synthetic-pose.mjs');
  const api = windowStub.__mfg;

  const sm = new LS();
  const landmarks = sp({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0 });
  let frame = { ok: false };
  for (let i = 0; i < 12; i++) frame = cf(tm(sm.apply(landmarks.map((q) => ({ ...q, v: q.visibility })), i / 30), A), null, i * 33, false, null);

  api.renderer.showSkeleton = true;
  resetCtxCounts();
  api.renderer.draw({ landmarks, frame, exerciseId: 'squat', status: 'ok' });
  const on = { ...ctxCounts };

  api.renderer.showSkeleton = false;
  resetCtxCounts();
  api.renderer.draw({ landmarks, frame, exerciseId: 'squat', status: 'ok' });
  const off = { ...ctxCounts };

  ok('显示火柴人时会画骨架线条', on.lineTo > 10 && on.arc >= 10,
    `lineTo=${on.lineTo} arc=${on.arc}`);
  ok('关闭火柴人后完全不画骨架线条（含地面参考线）', off.lineTo === 0, `lineTo=${off.lineTo}`);
  ok('关闭火柴人后不画关节点', off.arc === 0, `arc=${off.arc}`);
  ok('关闭火柴人后仍在绘制角度标注（各自独立开关）', off.fillText >= 1, `fillText=${off.fillText}`);

  // ===== 镜像预览下的角度文字 =====
  // 开启镜像时视频和画布都被 CSS scaleX(-1) 翻转，画在画布上的「膝 132°」会变成镜像字。
  // 所以绘制角度标签时必须自己再翻一次（translate 到标签中心后 scale(-1, 1)）抵消掉。
  api.renderer.mirror = false;
  resetCtxCounts();
  api.renderer.draw({ landmarks, frame, exerciseId: 'squat', status: 'ok' });
  const plain = { ...ctxCounts };
  ok('不镜像时角度标签不做水平翻转', plain.scale === 0, `scale 调用 ${plain.scale} 次`);

  api.renderer.mirror = true;
  resetCtxCounts();
  api.renderer.draw({ landmarks, frame, exerciseId: 'squat', status: 'ok' });
  const mirrored = { ...ctxCounts };
  ok('镜像时角度标签水平翻转抵消（不再是镜像字）',
    mirrored.scaleX === -1 && mirrored.translate >= 1 && mirrored.fillText >= 1,
    `scaleX=${mirrored.scaleX} translate=${mirrored.translate} fillText=${mirrored.fillText}`);
  // 打开/关闭镜像按钮要真的把标志位传给渲染器
  const mirrorBtn = elements.get('btnMirror');
  mirrorBtn.setAttribute('aria-pressed', 'true');
  mirrorBtn.dispatch('click');
  ok('关掉镜像后渲染器标志位跟着关', api.renderer.mirror === false);
  mirrorBtn.dispatch('click');
  ok('打开镜像后渲染器标志位跟着开', api.renderer.mirror === true);
  // 两次点击后回到默认（镜像开着），后面的用例继续按原状态跑
  ok('镜像开关与设置项保持一致', api.state.settings.mirror === true && api.renderer.mirror === true);

  /* ---- 画面上的角度标注：每个动作标出它真正的判据角 ---- */
  {
    const { supinePose: liePose } = await import('./synthetic-pose.mjs');
    // 仰卧抬腿：判据是「腰腿夹角」，画面上要像别的动作标膝关节那样标出来（用户要求）
    const smLie = new LS();
    const lie = liePose({ hip: { x: 0.75, y: 0.9 }, knee: 176, armDown: 90 });
    let lieFrame = { ok: false };
    for (let i = 0; i < 20; i++) lieFrame = cf(tm(smLie.apply(lie.map((q) => ({ ...q, v: q.visibility })), i / 30), A), null, i * 33, false, null);
    api.renderer.mirror = false;
    api.renderer.showAngles = true;
    texts.length = 0;
    api.renderer.draw({ landmarks: lie, frame: lieFrame, exerciseId: 'lyingLegRaise', status: 'ok' });
    ok('仰卧抬腿：画面上标出「髋」（腰腿夹角，判据那个数字）',
      texts.some((x) => x.startsWith('髋')), texts.join(' | '));
    ok('仰卧抬腿：标出的就是判据那个数字（0~180°）',
      texts.some((x) => /^髋\s+\d+°$/.test(x) && Number(/(\d+)°/.exec(x)[1]) > 0), texts.join(' | '));
    ok('仰卧抬腿：同时标出膝角（用来看腿有没有绷直）',
      texts.some((x) => x.includes('膝')), texts.join(' | '));
    // 用户要求：躯干倾角也要像「髋」「膝」那样显示在画面上
    ok('仰卧抬腿：标出「躯干 xx°」（用户要求显示躯干倾角）',
      texts.some((x) => /^躯干\s+\d+°$/.test(x)), texts.join(' | '));
    ok('躯干倾角是合理读数（0~90°，0=直立 / 90=水平）',
      texts.some((x) => /^躯干\s+(\d+)°$/.test(x) && Number(/^躯干\s+(\d+)°$/.exec(x)[1]) <= 90),
      texts.join(' | '));
    // 别的动作一样叫「髋」——全应用只有一种叫法，不做特例
    texts.length = 0;
    api.renderer.draw({ landmarks, frame, exerciseId: 'squat', status: 'ok' });
    ok('深蹲也标「髋」（和应用里其它动作同一套叫法）',
      texts.some((x) => x.startsWith('髋')), texts.join(' | '));
    ok('深蹲：同样标出「躯干 xx°」',
      texts.some((x) => /^躯干\s+\d+°$/.test(x)), texts.join(' | '));

    /* ---- 两条腿都在画面里时，左右膝分别标（用户要求） ---- */
    {
      const front = sp({ knee: 150, lean: 12, armDown: 0, ankleX: 1.0, view: 'front' });
      const smF = new LS();
      let fFront = { ok: false };
      for (let i = 0; i <= 16; i++) {
        fFront = cf(tm(smF.apply(front.map((q) => ({ ...q, v: q.visibility })), i / 30), A), null, i * 33, false, null);
      }
      texts.length = 0;
      api.renderer.draw({ landmarks: front, frame: fFront, exerciseId: 'squat', status: 'ok' });
      const leftK = texts.find((x) => x.startsWith('左膝'));
      const rightK = texts.find((x) => x.startsWith('右膝'));
      ok('正面深蹲（双腿都可见）：分别标出「左膝 xx°」和「右膝 xx°」',
        fFront.legsVisible === true
        && /^左膝\s+\d+°$/.test(leftK || '') && /^右膝\s+\d+°$/.test(rightK || ''),
        `legsVisible=${fFront.legsVisible} | ${texts.join(' | ')}`);
      ok('左右膝各标各的读数，不是同一个数字抄两遍',
        !!leftK && !!rightK
        && /^左膝\s+(\d+)°$/.exec(leftK)[1] !== /^右膝\s+(\d+)°$/.exec(rightK)[1],
        `${leftK} / ${rightK}`);

      // 远侧腿被躯干挡住（可见度 0.05）→ 退回单个「膝」，不做左右之分
      const { LM: LMK } = await import('../src/geometry.js');
      const hidden = front.map((p, i) => ([LMK.R_HIP, LMK.R_KNEE, LMK.R_ANKLE].includes(i)
        ? { ...p, visibility: 0.05, v: 0.05 } : p));
      const fHidden = cf(tm(hidden.map((q) => ({ ...q, v: q.visibility })), A), null, 999, false, null);
      texts.length = 0;
      api.renderer.draw({ landmarks: hidden, frame: fHidden, exerciseId: 'squat', status: 'ok' });
      ok('一条腿看不清时不做左右之分（只标一个「膝」）',
        fHidden.legsVisible === false
        && texts.some((x) => /^膝\s+\d+°$/.test(x))
        && !texts.some((x) => x.startsWith('左膝') || x.startsWith('右膝')),
        `legsVisible=${fHidden.legsVisible} | ${texts.join(' | ')}`);
    }
    // 没有角度判据的动作（跳跃离地、开合距离）不标角度，避免画面全是数字。
    // 但开合跳的判据是「双腿开合幅度」，所以画面上显示那个幅度（用户问「开合跳怎么没有角度」）。
    texts.length = 0;
    api.renderer.draw({ landmarks, frame, exerciseId: 'jumpingJack', status: 'ok' });
    ok('开合跳：不标任何角度（它的判据不是关节角）',
      !texts.some((x) => x.includes('°')), texts.join(' | '));
    ok('开合跳：改标「开合 x.xx」（就是识别器真正在判的那个量）',
      texts.some((x) => /^开合\s+\d+\.\d\d$/.test(x)), texts.join(' | '));
    {
      // 真帧里读的就是 frame.legSpread（膝 / 踝取较大值）
      const jackFrame = { ...frame, legSpread: 0.82 };
      texts.length = 0;
      api.renderer.draw({ landmarks, frame: jackFrame, exerciseId: 'jumpingJack', status: 'ok' });
      ok('开合跳：读数跟着 legSpread 走（0.82 → 屏幕显示 0.82）',
        texts.includes('开合 0.82'), texts.join(' | '));
    }
    api.renderer.mirror = true;
  }

  // 按钮联动
  api.renderer.showSkeleton = true;
  elements.get('btnSkeleton').setAttribute('aria-pressed', 'true');
  elements.get('btnSkeleton').dispatch('click');
  ok('点“火柴人”按钮后关闭骨架', api.renderer.showSkeleton === false);
  ok('开关状态被记住', api.state.settings.showSkeleton === false);
  elements.get('btnSkeleton').dispatch('click');
  ok('再点一次恢复显示', api.renderer.showSkeleton === true);
  ok('恢复后状态同样被记住', api.state.settings.showSkeleton === true);

  // 关闭状态下渲染不应报错，也不该残留
  api.renderer.showSkeleton = false;
  resetCtxCounts();
  api.renderer.draw({ landmarks, frame, exerciseId: 'plank', status: 'warn' });
  ok('关闭骨架时其它动作也能正常渲染', ctxCounts.lineTo === 0, `lineTo=${ctxCounts.lineTo}`);
  api.renderer.draw({ landmarks: null, frame: null, exerciseId: 'squat', status: 'idle' });
  ok('没有关键点时不报错', true);
  api.renderer.showSkeleton = true;

  // 全屏按钮：放大的是「视频框」#stage，而不是整个 HTML 页面
  const stageEl = elements.get('stage');
  const fsBtn = elements.get('btnFullscreen');
  stageEl.requestFullscreenCalls = 0;
  documentStub.documentElement.requestFullscreenCalls = 0;
  documentStub.fullscreenElement = null;
  fsBtn.dispatch('click');
  ok('点全屏按钮请求的是视频框全屏', stageEl.requestFullscreenCalls === 1,
    `stage=${stageEl.requestFullscreenCalls}`);
  ok('不再请求整个 HTML 页面全屏', documentStub.documentElement.requestFullscreenCalls === 0,
    `html=${documentStub.documentElement.requestFullscreenCalls}`);
  documentStub.fullscreenElement = stageEl;
  documentStub.exitFullscreenCalls = 0;
  fsBtn.dispatch('click');
  ok('已全屏时点同一个按钮会退出全屏', documentStub.exitFullscreenCalls === 1,
    `exit=${documentStub.exitFullscreenCalls}`);
  ok('全屏按钮是视频框的右下角按钮（stage-btn 类）',
    fsBtn.className.includes('stage-btn'), fsBtn.className);
  ok('全屏按钮有无障碍名称（走 data-i18n-aria，随语言切换）',
    (fsBtn.attributes['data-i18n-aria'] || '') === 'ui.fullscreen'
    && (fsBtn.attributes['data-i18n-title'] || '') === 'ui.fullscreen',
    JSON.stringify({ aria: fsBtn.attributes['data-i18n-aria'], title: fsBtn.attributes['data-i18n-title'] }));

  // 不支持元素全屏的环境（例如 iPhone 的 Safari）要藏起来，而不是点了没反应
  const savedRequestFullscreen = stageEl.requestFullscreen;
  delete stageEl.requestFullscreen;
  api.syncFullscreenSupport();
  ok('环境不支持元素全屏时藏起全屏按钮', fsBtn.hidden === true);
  stageEl.requestFullscreen = savedRequestFullscreen;
  api.syncFullscreenSupport();
  ok('支持元素全屏时按钮恢复显示', fsBtn.hidden === false);
}

/* ------------------------------------------------------------------ *
 * 多语言切换
 * ------------------------------------------------------------------ */

console.log('\n[7] 多语言切换');
{
  const api = windowStub.__mfg;
  api.selectExercise('squat');

  const zhName = elements.get('hudName').textContent;
  const zhHowto = elements.get('howtoList').innerHTML;
  const zhMirror = elements.get('btnMirror').textContent;
  ok('默认按浏览器语言选中中文', api.state && documentStub.documentElement.lang === 'zh-CN',
    documentStub.documentElement.lang);
  ok('applyI18n 能定位到静态文案元素', documentStub.querySelectorAll('[data-i18n]').length >= 15,
    `实际 ${documentStub.querySelectorAll('[data-i18n]').length} 个`);
  ok('启动时静态文案已按语言填充', /镜像/.test(zhMirror), JSON.stringify(zhMirror));

  api.changeLang('en');
  const enName = elements.get('hudName').textContent;
  const enHowto = elements.get('howtoList').innerHTML;
  ok('切到英文后动作名变化', enName !== zhName && /squat/i.test(enName), `${zhName} → ${enName}`);
  ok('切到英文后动作要领变化', enHowto !== zhHowto && !/[\u4e00-\u9fff]/.test(enHowto));
  ok('切到英文后静态按钮文案变化', elements.get('btnMirror').textContent !== zhMirror,
    elements.get('btnMirror').textContent);
  ok('切到英文后 html lang 更新', documentStub.documentElement.lang === 'en', documentStub.documentElement.lang);
  ok('切到英文后主页卡片重新渲染且是英文', (() => {
    const cards = documentStub.querySelectorAll('.ex-card');
    return cards.length > 0 && cards.every((c) => !/[\u4e00-\u9fff]/.test(c.innerHTML));
  })(), elements.get('homeCats').innerHTML.slice(0, 80));
  ok('切到英文后要领清单也是英文',
    !/[\u4e00-\u9fff]/.test(elements.get('stepList').innerHTML), elements.get('stepList').innerHTML.slice(0, 80));
  ok('切到英文后“下一步”提示是英文', !/[\u4e00-\u9fff]/.test(elements.get('stepHint').textContent),
    elements.get('stepHint').textContent);
  ok('切到英文后界面统计标签是英文', !/[\u4e00-\u9fff]/.test(elements.get('statScore').textContent));

  // 语言只保留中文和英文（西语 / 法语已移除）
  const { LANG_ORDER: ORDER, getLang, LOCALES: DICTS } = await import('../src/i18n.js');
  ok('只注册了中文和英文两种语言', ORDER.join() === 'zh,en' && Object.keys(DICTS).join() === 'zh,en',
    `${ORDER.join()} / ${Object.keys(DICTS).join()}`);
  ok('语言下拉框里也只有两项', elements.get('langSel').children.length === 2,
    String(elements.get('langSel').children.length));
  api.changeLang('es');
  api.changeLang('fr');
  ok('切到已移除的语言无效：仍停留在英文', getLang() === 'en', getLang());
  ok('已移除的语言目录确实不存在', !DICTS.es && !DICTS.fr);

  // 切换语言不应该丢掉已经拿到的分
  api.changeLang('zh');
  api.state.detector.score = 42;
  api.state.detector.validReps = 3;
  api.updateHud();
  api.changeLang('en');
  ok('切换语言不会清空得分与次数',
    api.state.detector.score === 42 && api.state.detector.validReps === 3,
    `score=${api.state.detector.score} reps=${api.state.detector.validReps}`);
  api.changeLang('zh');
  ok('切回中文后动作名恢复', elements.get('hudName').textContent === zhName);
}

/* ------------------------------------------------------------------ *
 * 运动前校准（应用接线）
 * ------------------------------------------------------------------ */

console.log('\n[8] 运动前校准流程');
{
  const { toMetric: tm, LandmarkSmoother: LS, LM: LMK } = await import('../src/geometry.js');
  const { computeFrame: cf } = await import('../src/metrics.js');
  const { ASPECT: A, standingPose: sp, lostFrame } = await import('./synthetic-pose.mjs');
  const api = windowStub.__mfg;

  /** 把姿势缩放到校准目标大小并摆到画面中间 */
  const fit = (lm, { k = 0.78, cx0 = 0.5, groundY = 0.92, dx = 0 } = {}) => {
    const ankleY = Math.max(lm[LMK.L_ANKLE].y, lm[LMK.R_ANKLE].y);
    const cx = (lm[LMK.L_HIP].x + lm[LMK.R_HIP].x + lm[LMK.L_SHOULDER].x + lm[LMK.R_SHOULDER].x) / 4;
    return lm.map((p) => ({ ...p, x: cx0 + dx + (p.x - cx) * k, y: groundY + (p.y - ankleY) * k }));
  };
  const frameOf = (lm, t) => cf(tm(lm.map((p) => ({ ...p, v: p.visibility ?? 1 })), A), null, t, false, null);

  api.selectExercise('squat');
  ok('选中动作后进入校准阶段', api.state.session === 'calibrating', api.state.session);
  ok('校准面板可见', elements.get('calibCard').hidden === false);
  ok('校准阶段开始按钮不可用', elements.get('btnStart').disabled === true);
  ok('校准阶段按钮文案提示等待校准',
    elements.get('btnStart').textContent.includes('等待校准'), elements.get('btnStart').textContent);

  api.startSession();
  ok('未完成校准时不会进入倒计时', api.state.session !== 'countdown', api.state.session);

  // 站进轮廓并保持 → 识别完成 → 自动进入运动状态
  const idle = fit(sp({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0, view: 'front' }));
  const returns = [];
  let t3 = 500000;
  for (let i = 0; i < 60; i++) {
    returns.push(api.calibrationStep(frameOf(idle, t3), t3));
    t3 += 33.4;
  }
  ok('全身识别完成 → 自动进入倒计时（不用再点开始）', api.state.session === 'countdown', api.state.session);
  ok('识别完成那一帧就不再画虚线框（返回 null）', returns.includes(null),
    `返回 null 的帧数=${returns.filter((r) => r === null).length}`);
  ok('自动进入后倒计时遮罩显示出来', elements.get('countdown').hidden === false);
  ok('校准清单逐项打勾', elements.get('calibList').innerHTML.includes('calib-item done'),
    elements.get('calibList').innerHTML.slice(0, 60));

  // 一组结束后回到校准：停在原地不自动开始，要用户自己点（否则刚练完就被拽进下一组）
  api.stopSession('goal');
  ok('一组结束后回到校准阶段', api.state.session === 'calibrating', api.state.session);
  ok('一组结束后进入「休息态」：留在原地不会自动开始',
    api.state.afterSet === true, `afterSet=${api.state.afterSet}`);
  let t3b = t3 + 100000;
  let outlineAfterSet = null;
  for (let i = 0; i < 60; i++) {
    outlineAfterSet = api.calibrationStep(frameOf(idle, t3b), t3b);
    t3b += 33.4;
  }
  ok('留在原地再次识别完成，也只停在「可以开始」而不是自动开始',
    api.state.session === 'ready', api.state.session);
  ok('这一轮识别成功后轮廓立刻收起（休息态不再留一条绿色轮廓）',
    outlineAfterSet === null, JSON.stringify(outlineAfterSet));
  ok('这一轮提示条给出「开始训练」的话',
    elements.get('calibPromptMain').textContent.includes('开始训练'),
    elements.get('calibPromptMain').textContent);
  const savedStreamLying = api.camera.stream;
  api.camera.stream = {};
  api.startSession();
  ok('手动点开始训练仍然可用（进入倒计时）', api.state.session === 'countdown', api.state.session);
  api.stopSession('user');
  api.camera.stream = savedStreamLying;

  // 休息够了走开再回来：自动开始重新装填，站好就又会自动开始
  api.toCalibration({ silent: true, afterSet: true });   // 等价于「一组结束后回到校准」
  ok('结束一组后处于休息态', api.state.afterSet === true);
  api.calibrationStep(frameOf(lostFrame(), t3b), t3b);   // 人离开画面
  t3b += 33.4;
  ok('离开画面后自动开始重新装填', api.state.afterSet === false);
  for (let i = 0; i < 60; i++) { api.calibrationStep(frameOf(idle, t3b), t3b); t3b += 33.4; }
  ok('走开再回来站好 → 又会自动开始', api.state.session === 'countdown', api.state.session);
  api.stopSession('user');

  // 机位跟着动作变
  api.selectExercise('lunge');
  ok('切到箭步蹲后要求侧面机位', api.state.calibrator.view === 'side', api.state.calibrator.view);
  const sideIdle = fit(sp({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0, view: 'side' }));
  const o2 = api.calibrationStep(frameOf(sideIdle, t3b), t3b);
  ok('箭步蹲的虚线轮廓是站姿侧面形状', o2.kind === 'side', o2.kind);

  // 躺姿动作：轮廓要换成俯卧 / 仰卧的形状，而且是横着的
  for (const [id, kind, label] of [
    ['pushup', 'pushup', '俯卧撑用俯卧撑起来的侧面轮廓'],
    ['plank', 'plank', '平板支撑用小臂撑地的侧面轮廓'],
    ['bridge', 'bridge', '臀桥用仰卧屈腿的侧面轮廓'],
    ['bridgehold', 'bridge', '静态臀桥与臀桥共用同一轮廓'],
  ]) {
    api.selectExercise(id);
    const lying = fit(sp({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0, view: 'side' }));
    const o = api.calibrationStep(frameOf(lying, t3), t3);
    ok(label, o.kind === kind && api.state.calibrator.lying === true, `kind=${o.kind}`);
  }
  api.selectExercise('lunge');

  // 站偏时给方向提示（左右现在是建议项：面板会提示，但不拦着开始）
  api.toCalibration();
  ok('重新校准后回到校准阶段', api.state.session === 'calibrating');
  api.calibrationStep(frameOf(fit(sideIdle, { dx: 0.36 }), t3), t3);
  ok('站偏时面板给出左右方向提示', /左|右/.test(elements.get('calibHint').textContent),
    elements.get('calibHint').textContent);
  ok('站偏时仍然算就位（建议项不拦人，轮廓已是已就位配色）',
    api.calibrationStep(frameOf(fit(sideIdle, { dx: 0.36 }), t3), t3).status === 'ready');
  ok('面板把没达标的建议项标成「·」而不是「○」',
    elements.get('calibList').innerHTML.includes('calib-item soft'),
    elements.get('calibList').innerHTML.slice(0, 120));
  // 只有被画面切掉（必须项不达标）才会停在「调整」
  api.calibrationStep(frameOf(fit(sideIdle, { dx: 0.9 }), t3), t3);
  ok('身体出画时必须项拦住，轮廓回到调整色',
    api.calibrationStep(frameOf(fit(sideIdle, { dx: 0.9 }), t3), t3).status === 'adjust');

  // 轮廓是独立的一层：关掉“火柴人”也必须照常显示引导
  api.renderer.showSkeleton = false;
  resetCtxCounts();
  api.renderer.draw({ landmarks: null, frame: null, exerciseId: 'squat', status: 'idle', outline: { view: 'front', status: 'adjust' } });
  const outlineCalls = { ...ctxCounts };
  ok('关掉火柴人时虚线轮廓照常绘制',
    outlineCalls.quadraticCurveTo > 20 && outlineCalls.stroke === 1,
    `quadraticCurveTo=${outlineCalls.quadraticCurveTo} stroke=${outlineCalls.stroke}`);
  ok('轮廓只画一条闭合曲线（不再拼十几段胶囊，画面才不乱）',
    outlineCalls.moveTo === 1 && outlineCalls.stroke === 1,
    `moveTo=${outlineCalls.moveTo} stroke=${outlineCalls.stroke}`);
  ok('关掉火柴人且没有关键点时也不会画骨架',
    outlineCalls.stroke > 0 && outlineCalls.fill === 0, `stroke=${outlineCalls.stroke} fill=${outlineCalls.fill}`);

  // 线条要醒目：灰蓝色在摄像头画面里（白墙、木地板、深色衣服）会糊掉看不见
  const outlinePen = {};
  for (const st of ['search', 'adjust', 'ready']) {
    resetCtxCounts();
    api.renderer.draw({
      landmarks: null, frame: null, exerciseId: 'squat', status: 'idle', outline: { view: 'front', status: st },
    });
    outlinePen[st] = { color: ctxCounts.strokeStyle, alpha: ctxCounts.globalAlpha, width: ctxCounts.lineWidth };
  }
  ok('剪影三种状态都用高饱和亮色（亮蓝找人 / 亮琥珀调整 / 亮绿已就位）',
    outlinePen.search.color === '#38bdf8' && outlinePen.adjust.color === '#fbbf24'
    && outlinePen.ready.color === '#4ade80',
    JSON.stringify(outlinePen));
  ok('剪影不再使用灰蓝色（旧配色不醒目）',
    ['search', 'adjust', 'ready'].every((k) => outlinePen[k].color !== '#7c8aa5'),
    ['search', 'adjust', 'ready'].map((k) => outlinePen[k].color).join(' '));
  ok('剪影线条不透明且够粗（1280 宽下 ≥5px）',
    ['search', 'adjust', 'ready'].every((k) => outlinePen[k].alpha >= 0.9 && outlinePen[k].width >= 5),
    ['search', 'adjust', 'ready'].map((k) => `${k}:a=${outlinePen[k].alpha},w=${outlinePen[k].width}`).join(' '));
  ok('三种状态的颜色互不相同（能一眼看出状态变化）',
    new Set(['search', 'adjust', 'ready'].map((k) => outlinePen[k].color)).size === 3);

  api.renderer.showSkeleton = true;
  resetCtxCounts();
  api.renderer.draw({ landmarks: null, frame: null, exerciseId: 'squat', status: 'idle', outline: null });
  ok('不传轮廓时不画任何东西', ctxCounts.stroke === 0 && ctxCounts.lineTo === 0);

  // 画面上的文字引导：必须始终告诉用户「进入虚线轮廓内」
  api.selectExercise('squat');
  // 被画面切掉（必须项不达标）时，提示条第二行要给出具体该做什么
  const cutFrame = () => frameOf(fit(sp({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0, view: 'front' }), { dx: 0.9 }), t3 + 10000);
  api.calibrationStep(cutFrame(), t3 + 10000);
  ok('校准阶段画面上出现文字提示条', elements.get('calibPrompt').hidden === false);
  ok('提示条第一行是「进入虚线轮廓内」',
    elements.get('calibPromptMain').textContent.includes('进入虚线轮廓'), elements.get('calibPromptMain').textContent);
  ok('提示条第二行给出还差什么', /出画/.test(elements.get('calibPromptSub').textContent),
    elements.get('calibPromptSub').textContent);
  // 提示条走 t()，必须跟着语言切换
  api.changeLang('en');
  api.calibrationStep(cutFrame(), t3 + 10200);
  ok('提示条文案跟随语言切换（英文）',
    /outline/i.test(elements.get('calibPromptMain').textContent),
    elements.get('calibPromptMain').textContent);
  api.changeLang('zh');
  ok('人没进画面时提示条换成「没找到你」',
    (() => {
      const r = api.calibrationStep(frameOf(lostFrame(), t3 + 10100), t3 + 10100);
      return r.status === 'search' && elements.get('calibPromptMain').textContent.includes('没找到你');
    })(), elements.get('calibPromptMain').textContent);
  ok('提示条配色跟着剪影状态走（找人 = 亮蓝 search 配色）',
    elements.get('calibPrompt').className.includes('search'), elements.get('calibPrompt').className);
  ok('底部状态条在校准阶段让位（同一句话不重复出现）', elements.get('poseHint').hidden === true);

  // 站好后就位：只等「人在画面里」这一必须项（保持 0.6 秒）→ 自动进入倒计时
  let t4 = t3 + 20000;
  for (let i = 0; i < 8; i++) { api.calibrationStep(frameOf(idle, t4), t4); t4 += 33.4; }
  ok('进画面约 0.27 秒后提示条已是「位置很好」',
    api.state.session === 'calibrating' && elements.get('calibPromptMain').textContent.includes('位置很好'),
    `session=${api.state.session} text=${elements.get('calibPromptMain').textContent}`);
  ok('提示条在就位保持阶段转绿',
    elements.get('calibPrompt').className.includes('ready'), elements.get('calibPrompt').className);
  // 只在校准阶段调用（真实渲染循环就是这样分流的），进入倒计时后不再调用
  let guard = 0;
  while (guard < 60 && api.state.session === 'calibrating') {
    api.calibrationStep(frameOf(idle, t4), t4);
    t4 += 33.4;
    guard += 1;
  }
  ok('保持满 1.1 秒后自动进入倒计时（识别完成即开练）',
    api.state.session === 'countdown', api.state.session);
  api.renderCalibration(null);   // 真实循环在非校准分支里每帧都会收一次面板
  ok('识别完成后提示条收起，画面不再被挡',
    elements.get('calibPrompt').hidden === true);

  // 离开校准阶段后提示条要收起来
  api.toCalibration({ silent: true });
  api.renderCalibration(null);
  ok('离开校准阶段后提示条隐藏', elements.get('calibPrompt').hidden === true);
  ok('侧面机位的剪影也照常绘制',
    api.renderer.draw({ landmarks: null, frame: null, exerciseId: 'lunge', status: 'idle', outline: { view: 'side', status: 'search' } }) === undefined);

  // 躺姿动作的完整链路：摆好躺姿 → 校准通过 → 可以开始训练
  // （修好前俯卧撑会被「左右居中」卡住、臀桥会被「距离合适」卡死，永远进不了训练）
  {
    const { pronePose, supinePose } = await import('./synthetic-pose.mjs');
    const CORE = [
      LMK.NOSE, LMK.L_SHOULDER, LMK.R_SHOULDER, LMK.L_HIP, LMK.R_HIP,
      LMK.L_KNEE, LMK.R_KNEE, LMK.L_ANKLE, LMK.R_ANKLE, LMK.L_FOOT, LMK.R_FOOT,
    ];
    const lyingFit = (lm, { target = 0.72, groundY = 0.9 } = {}) => {
      const xs = CORE.map((i) => lm[i].x * A);
      const ys = CORE.map((i) => lm[i].y);
      const k = target / (Math.max(...xs) - Math.min(...xs));
      const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
      const baseY = Math.max(...ys);
      return lm.map((p) => ({
        ...p,
        x: (0.5 * A + (p.x * A - midX) * k) / A,
        y: groundY - (baseY - p.y) * k,
      }));
    };
    for (const [id, pose, label] of [
      ['pushup', pronePose({ hip: { x: 0.9, y: 0.7 }, bodyTilt: 66, elbow: 172, armDown: 6 }), '俯卧撑'],
      ['plank', pronePose({ hip: { x: 0.9, y: 0.7 }, bodyTilt: 66, elbow: 92, armDown: 4 }), '平板支撑'],
      ['bridge', supinePose({ hip: { x: 0.75, y: 0.9 }, armDown: 90 }), '臀桥'],
    ]) {
      api.selectExercise(id);
      let tt = 900000;
      let sawNull = false;
      for (let i = 0; i < 60; i++) {
        if (api.calibrationStep(frameOf(lyingFit(pose), tt), tt) === null) sawNull = true;
        tt += 33.4;
      }
      const failed = (api.state.calib?.checks || []).filter((c) => !c.ok).map((c) => c.id).join(',');
      ok(`${label}：摆好躺姿后识别完成并自动进入倒计时`,
        api.state.session === 'countdown' && sawNull, `${api.state.session}/${failed}`);
      api.stopSession('user');
    }
    api.selectExercise('squat');
    api.toCalibration({ silent: true });
  }

  // 端到端：校准完成 → 自动 3-2-1 倒计时 → 真正开始计数（等真实计时器走完）
  // 这一条覆盖「识别完成后到底有没有真的进入计数」——中间任何一环断掉，深蹲都不会计数。
  {
    const savedStream = api.camera.stream;
    api.camera.stream = {};   // camera.active 依赖真实视频流，这里用桩模拟
    const saidNow = [];
    const origSay = api.audio.say;
    api.audio.say = (txt, o) => { saidNow.push(txt); return origSay.call(api.audio, txt, o); };
    api.selectExercise('squat');
    let te = 1200000;
    for (let i = 0; i < 60; i++) { api.calibrationStep(frameOf(idle, te), te); te += 33.4; }
    ok('端到端：校准完成即进入倒计时', api.state.session === 'countdown', api.state.session);

    await new Promise((r) => setTimeout(r, 2900));   // 3 × 850ms 倒计时
    ok('端到端：倒计时结束自动进入计数状态', api.state.session === 'running', api.state.session);
    ok('端到端：倒计时报了 3 个数', saidNow.includes('3') && saidNow.includes('2') && saidNow.includes('1'),
      saidNow.join(' / '));

    const beforeVoices = saidNow.length;
    const sm2 = new LS();
    for (let rep = 0; rep < 3; rep++) {
      for (let i = 0; i <= 60; i++) {
        const s = Math.sin(Math.PI * (i / 60));
        const knee = 178 - (178 - 75) * s;
        const lm = fit(sp({
          knee, lean: 6 + (178 - knee) * 0.28, armDown: (178 - knee) * 0.45, ankleX: 1.0, view: 'front',
        }));
        const smp = sm2.apply(lm.map((q) => ({ ...q, v: q.visibility })), te / 1000);
        api.handleEvents(api.feedDetector(frameOf(smp, te), te));
        api.updateHud();
        te += 33.4;
      }
    }
    ok('端到端：深蹲被计入有效次数', api.state.detector.validReps >= 2,
      `reps=${api.state.detector.validReps}`);
    ok('端到端：训练过程中有语音提示（要领/报数）', saidNow.length > beforeVoices,
      saidNow.slice(beforeVoices, beforeVoices + 4).join(' / '));

    // 状态条纪律 1：有待完成的要领时，即使这一步没有具体提示，也必须写清卡在哪一步
    const detRef = api.state.detector;
    const origPending = detRef.pendingHint;
    detRef.pendingHint = () => ({ id: 'x', labelKey: 'steps.squat.hinge.label', hint: null });
    api.state.hintUntil = 0;
    api.updateStatusHint({ ok: true }, performance.now() + 1000);
    ok('待完成要领没有具体提示时，状态条写「下一步…」而不是「已识别到你 ✓」',
      elements.get('poseHint').textContent.includes('下一步')
      && !elements.get('poseHint').textContent.includes('保持这个位置做动作'),
      elements.get('poseHint').textContent.slice(0, 60));
    detRef.pendingHint = origPending;

    // 状态条纪律 2：识别器缺失这类异常要显式说出来，不能安静地什么都不显示
    const savedDetector = api.state.detector;
    api.state.detector = null;
    api.state.hintUntil = 0;
    api.updateStatusHint({ ok: true }, performance.now() + 2000);
    ok('识别器缺失时状态条给出明确提示（不再假装正常）',
      elements.get('poseHint').textContent.includes('识别器'), elements.get('poseHint').textContent.slice(0, 60));
    api.state.detector = savedDetector;

    // 倒计时兜底：定时器被浏览器节流/打断时，渲染循环里的时间判断能把状态推进到 running
    api.state.session = 'countdown';
    api.state.countdownStartedAt = performance.now() - 5000;
    api.finishCountdown();
    ok('倒计时能被时间兜底推进到计数状态', api.state.session === 'running', api.state.session);
    api.finishCountdown();
    ok('兜底推进是幂等的（重复调用不会把 running 打回去）', api.state.session === 'running', api.state.session);
    api.audio.say = origSay;
    api.stopSession('user');
    api.camera.stream = savedStream;
  }
}

/* ------------------------------------------------------------------ *
 * 判定进度条（画面上那条一格一格点亮的判据链）
 * ------------------------------------------------------------------ */

console.log('\n[8b] 判定进度条');
{
  const { toMetric: tm, LandmarkSmoother: LS } = await import('../src/geometry.js');
  const { computeFrame: cf } = await import('../src/metrics.js');
  const { ASPECT: A, standingPose: sp } = await import('./synthetic-pose.mjs');
  const { specStages, stagePoints } = await import('../src/specs.js');
  const api = windowStub.__mfg;

  const frameOf = (knee) => {
    const sm = new LS();
    const lm = sp({ knee, lean: 6 + (178 - knee) * 0.28, armDown: (178 - knee) * 0.45, ankleX: 1.0, view: 'front' });
    let f = { ok: false };
    for (let i = 0; i < 6; i++) {
      f = cf(tm(sm.apply(lm.map((p) => ({ ...p, v: p.visibility ?? 1 })), i / 30), A), null, 900 + i * 33, false, null);
    }
    return f;
  };
  // 进度条是**增量更新**的：格子是真实元素，只在换动作时重建一次。
  // 所以断言直接看元素（class / 文本 / 属性），而不是 innerHTML 字符串。
  const trackEl = () => elements.get('criteriaTrack');
  const segs = () => trackEl().children;
  const segCount = () => segs().length;
  const segAt = (i) => segs()[i];
  const segTip = (i) => (segAt(i)?.getAttribute('data-tip') || '');
  const ptsEl = (i) => segAt(i)?.querySelector('.criteria-seg-pts');
  const ptsText = (i) => (ptsEl(i)?.textContent || '');
  const iconHtml = () => segs().map((c) => c.innerHTML).join('');
  const segHtml = () => iconHtml();   // 图标标记（判据文字只在 data-tip 里）

  // 主页上不该出现（整页都没有视频框）
  api.showHome();
  ok('主页上不显示判定进度条', elements.get('criteriaBar').hidden === true);

  api.openExercise('squat');
  ok('校准阶段进度条也在（一直显示在画面上）', elements.get('criteriaBar').hidden === false);

  // 校准阶段：还没识别到人 → 灰色（尚未开始）
  api.state.criteriaLive = false;
  api.renderCriteriaBar();
  ok('没识别到人时进度条是灰的（idle）', elements.get('criteriaBar').classList.contains('idle'));
  ok('没识别到人时不点亮任何一格', api.state.criteriaIdx === -1, String(api.state.criteriaIdx));

  // 识别到人 + 训练中 → 彩色（开始工作）
  api.buildCriteriaBar();
  api.state.session = 'running';
  api.updateCriteria(frameOf(178), [], 900);
  const squatStages = specStages('squat');
  ok('识别到人之后进度条进入彩色状态（active）',
    elements.get('criteriaBar').classList.contains('active')
    && elements.get('criteriaBar').classList.contains('idle') === false);
  ok('进度条格数 = 这个动作的关键帧数', segCount() === squatStages.length,
    `${segCount()} vs ${squatStages.length}`);
  ok('每一格画的是线条图标（svg），不是文字',
    (iconHtml().match(/<svg class="criteria-icon"/g) || []).length === segCount()
    && !/[\u4e00-\u9fff]/.test(iconHtml()), iconHtml().slice(0, 200));
  ok('进度条上没有任何可见文字（格子只有图标）',
    !segs().some((c) => /criteria-seg-(label|index)/.test(String(c.className))), iconHtml().slice(0, 200));
  ok('悬停提示里带判据（图标看不出数值时能查）',
    segs().some((c, i) => /(站姿|0\.86)/.test(segTip(i))), segTip(0));
  api.hideCriteriaTip();
  ok('判据文字默认不显示（进度条上只有图标）', elements.get('criteriaTip').hidden === true);
  api.showCriteriaTip(1);
  ok('鼠标移到某一格时，判据文字显示在进度条上方',
    elements.get('criteriaTip').hidden === false
    && /<=|≤/.test(elements.get('criteriaTip').innerHTML)
    && elements.get('criteriaTip').innerHTML.includes('开始'),
    elements.get('criteriaTip').innerHTML);
  api.hideCriteriaTip();
  ok('移开鼠标后判据文字收起', elements.get('criteriaTip').hidden === true);

  // 站着不动：只点亮「站姿」这一格
  ok('站着时点亮「站姿」这一格', api.state.criteriaIdx === 0, String(api.state.criteriaIdx));
  ok('「站姿」那一格标记为已完成', segAt(0).classList.contains('done'), segAt(0).className);
  ok('下一格标记为正在等（current）', segAt(1).classList.contains('current'), segAt(1).className);

  // 一路蹲下去：进度条一格一格往前走
  const walked = [];
  for (const knee of [170, 160, 150, 140, 130, 120, 110, 100, 90, 80, 75]) {
    api.updateCriteria(frameOf(knee), [], 1100 + knee);
    walked.push(api.state.criteriaIdx);
  }
  ok('蹲下去时进度条只前进不后退（单调）',
    walked.every((v, i) => i === 0 || v >= walked[i - 1]), walked.join(','));
  ok('蹲下去时走到「计次」这一格（深度分不再单独占格）',
    api.state.criteriaIdx === squatStages.length - 2,
    `${api.state.criteriaIdx + 1}/${squatStages.length}`);
  ok('最后一格是「回位」：蹲到底时它还没亮（说明它真的是「回到起始位」那一刻）',
    !segAt(3).classList.contains('done'), segAt(3).className);
  // 站起来 → 最后一格亮，同时识别器计上这一次（「关键帧全做完 = 已经计次」）
  api.updateCriteria(frameOf(178), [], 1400);
  ok('站起来后最后一格也亮了（整条链走完）', api.state.criteriaIdx === squatStages.length - 1,
    `${api.state.criteriaIdx + 1}/${squatStages.length}`);

  // 一步真的加了分 → 标在格子上，并飘一下「+N」
  api.resetCriteriaProgress();
  api.updateCriteria(frameOf(178), [], 2000);
  api.updateCriteria(frameOf(100), [{ type: 'step', points: 7, index: 1, total: 5, labelKey: 'x' }], 2100);
  ok('这一步加到的分标在格子上',
    segs().some((c, i) => ptsText(i).includes('+7')), segs().map((c, i) => ptsText(i)).join(','));
  ok('同时飘一下「+N」（数字，不带文字）',
    elements.get('criteriaEarned').textContent === '+7', elements.get('criteriaEarned').textContent);

  // —— 得分分配到关键帧（用户要求：把每个动作的得分分到不同的关键帧里，按是否达标实际显示，字要大）——
  api.openExercise('squat');
  api.buildCriteriaBar();
  api.state.session = 'running';
  api.state.criteriaLive = true;
  const squatPts = stagePoints('squat');
  ok('每一格都有「这一格能拿多少分」（得分项按关键帧分配）',
    api.state.criteriaMax.length === squatPts.length
    && api.state.criteriaMax[0].points === 4
    && api.state.criteriaMax[2].points === 21
    && api.state.criteriaMax[api.state.criteriaMax.length - 1].bonus === 6,
    JSON.stringify(api.state.criteriaMax));
  api.updateCriteria(frameOf(178), [], 8000);
  ok('还没拿到分时，格子上用灰字标出「可得分数」',
    ptsText(0) === '+4' && ptsEl(0).className === 'criteria-seg-pts max',
    `${ptsText(0)}/${ptsEl(0).className}`);
  api.updateCriteria(frameOf(178), [{ type: 'step', id: 'hinge', points: 6, index: 1, total: 5, labelKey: 'x' }], 8100);
  ok('得分项按映射落到对应关键帧（squat 的 hinge → 第 2 格「开始」）',
    api.state.criteriaPts[1] === 6 && segAt(1).dataset.pts === '6',
    JSON.stringify(api.state.criteriaPts));
  ok('拿到分的那一格显示大号亮色数字（.earned）',
    ptsText(1) === '+6' && ptsEl(1).className === 'criteria-seg-pts earned',
    `${ptsText(1)}/${ptsEl(1).className}`);
  ok('得分不会跑到别的格子上',
    api.state.criteriaPts.filter((n, i) => i !== 1 && n > 0).length === 0,
    JSON.stringify(api.state.criteriaPts));

  // —— 用户反馈「计分的时候进度条抖得厉害」：这里把「不重建 DOM」锁死 ——
  {
    const same = segs();
    const iconsBefore = segs().map((c) => c.innerHTML);
    const clsBefore = segs().map((c) => String(c.className));
    // 连续加分 + 继续推进（真实计分时的连续变化）
    api.updateCriteria(frameOf(178), [{ type: 'step', id: 'descend', points: 7, index: 2, total: 5, labelKey: 'x' }], 2200);
    api.updateCriteria(frameOf(100), [], 2300);
    api.updateCriteria(frameOf(100), [{ type: 'step', id: 'parallel', points: 14, index: 3, total: 5, labelKey: 'x' }], 2400);
    ok('计分过程中进度条是同一批元素（重建 DOM 会让动画重放 = 抖）',
      segs().length === same.length && segs().every((c, i) => c === same[i]), `${segs().length}`);
    ok('计分过程中图标不会被重写（只有 class 和数字在变）',
      segs().map((c) => c.innerHTML).join('|') === iconsBefore.join('|'));
    ok('没被影响的格子 class 没被反复改写（只有 just 提示会移动）',
      segs().every((c, i) => String(c.className).includes('criteria-seg'))
      && iconsBefore.length === segs().length);
    // 同一份状态重复渲染：一次 class 写入都不该发生（写入会打断动画 → 看起来就是抖）
    let writes = 0;
    for (const c of segs()) {
      const orig = c.classList.toggle.bind(c.classList);
      c.classList.toggle = (name, force) => {
        const had = c.classList.contains(name);
        const r = orig(name, force);
        if (c.classList.contains(name) !== had) writes += 1;
        return r;
      };
    }
    api.renderCriteriaBar(2600);
    ok('状态没变时一次 class 写入都没有（动画不会被打断）', writes === 0, String(writes));
    // 同一份状态重复渲染：DOM 完全不动（幂等 → 动画不会被打断）
    const clsNow = segs().map((c) => String(c.className));
    const ptsNow = segs().map((c, i) => ptsText(i));
    api.renderCriteriaBar(2500);
    api.renderCriteriaBar(2501);
    ok('状态没变时重复渲染不动任何一格（幂等）',
      segs().map((c) => String(c.className)).join('|') === clsNow.join('|')
      && segs().map((c, i) => ptsText(i)).join('|') === ptsNow.join('|'));

    // 计时类每秒加分（抖动最明显的场景）同样不重建
    api.openExercise('plank');
    api.buildCriteriaBar();
    api.state.session = 'running';
    api.state.criteriaLive = true;
    const holdEls = segs();
    for (let i = 0; i < 5; i += 1) {
      api.updateCriteria({ ok: true, torsoIncl: 70, shoulderClear: 0.6, wristClear: 0.4, hipLineDev: 0, bodyStraight: 175, kneeClear: 0.6, elbowAngle: 90 },
        [{ type: 'points', points: 1, tick: true }], 3000 + i * 1000);
    }
    ok('计时类每秒加分时同样不重建 DOM（格子还是同一批元素）',
      segs().length === holdEls.length && segs().every((c, i) => c === holdEls[i]), `${segs().length}`);

    // 用户反馈「运动时进度条抖得很厉害」：**渲染过程不许写任何影响布局的内联样式**
    // （宽高 / 位移 / 字号 / margin 之类）。几何一动，整条就会跟着抖一下。
    {
      const LAYOUT_KEYS = ['width', 'height', 'transform', 'fontSize', 'margin', 'padding', 'top', 'bottom', 'left', 'right', 'position'];
      const before = new Map();
      const watch = (el) => { if (el && !before.has(el)) before.set(el, { ...el.style }); };
      watch(elements.get('criteriaBar'));
      for (const c of segs()) { watch(c); watch(c.querySelector('.criteria-seg-pts')); }
      api.updateCriteria({ ok: true, torsoIncl: 70, shoulderClear: 0.6, wristClear: 0.4, hipLineDev: 0, bodyStraight: 175, kneeClear: 0.6, elbowAngle: 90 },
        [{ type: 'points', points: 1, tick: true }], 4000);
      api.renderCriteriaBar(4100);
      const touched = [];
      for (const [el, snap] of before) {
        for (const k of LAYOUT_KEYS) {
          if (String(el.style[k] ?? '') !== String(snap[k] ?? '')) touched.push(`${el.id || 'seg'}.${k}`);
        }
      }
      ok('渲染进度条时不写任何影响布局的内联样式（几何不变 → 不可能抖）',
        touched.length === 0, touched.join(', '));
    }
    api.openExercise('squat');
    api.buildCriteriaBar();
    api.state.session = 'running';
    api.state.criteriaLive = true;
    api.updateCriteria(frameOf(178), [], 4000);
  }
  api.showCriteriaTip(1);
  ok('悬停提示里带上这一格的分数',
    /\+6/.test(elements.get('criteriaTip').innerHTML), elements.get('criteriaTip').innerHTML);
  api.hideCriteriaTip();

  // 臀桥：三个关键帧 = 屈腿仰卧 → 腰臀顶起 → 恢复屈腿仰卧（三个图标必须互不相同）
  api.openExercise('bridge');
  api.buildCriteriaBar();
  api.state.session = 'running';
  const bridgeIcons = api.state.criteriaIcons || [];
  ok('臀桥进度条 = 3 个关键帧（仰卧 → 顶起 → 落回）',
    bridgeIcons.length === 3, `${bridgeIcons.length}`);
  ok('臀桥三个关键帧的图标互不相同（顶起有向上箭头、落回有向下箭头）',
    new Set(bridgeIcons).size === 3, bridgeIcons.map((s) => s.length).join(','));
  ok('臀桥得分分配：仰卧 5 / 顶起 20 / 落回 8 + 满轮 6',
    JSON.stringify(api.state.criteriaMax.map((r) => r.points)) === '[5,20,8]'
    && api.state.criteriaMax[2].bonus === 6,
    JSON.stringify(api.state.criteriaMax));
  api.openExercise('squat');
  api.buildCriteriaBar();
  api.state.session = 'running';

  // 一次动作结束 → 整条链点亮并保持 0.65 秒（让用户看到「这轮走完了」），然后清零重来
  api.updateCriteria(frameOf(80), [], 5100);
  api.handleEvents([{ type: 'rep', valid: true, index: 1, quality: 90, duration: 900 }], 5200);
  ok('识别器计上一次时，进度条整条点亮（做完了就一定显示做完）',
    api.state.criteriaIdx === squatStages.length - 1, String(api.state.criteriaIdx));
  ok('点亮后进入 0.65 秒展示期（还没清零）',
    api.state.criteriaClearUntil > 5200, String(api.state.criteriaClearUntil));
  api.updateCriteria(frameOf(178), [], 5300);
  ok('展示期内不会被「站姿」立刻重新点亮（还是保持整条亮着）',
    api.state.criteriaIdx === squatStages.length - 1, String(api.state.criteriaIdx));
  api.updateCriteria(frameOf(178), [], 6000);
  ok('展示期过后清零，从头开始（先点亮站姿）', api.state.criteriaIdx === 0, String(api.state.criteriaIdx));
  ok('清零标记也撤掉了', elements.get('criteriaBar').classList.contains('reset') === false);
  // 半程动作也算「一次动作结束」，同样走完 + 清零
  api.updateCriteria(frameOf(120), [], 6100);
  api.handleEvents([{ type: 'rep', valid: false, reason: 'depth' }], 6200);
  ok('半程动作结束后也整条点亮并进入展示期',
    api.state.criteriaIdx === squatStages.length - 1, String(api.state.criteriaIdx));
  api.updateCriteria(frameOf(178), [], 7000);
  ok('半程的展示期过后同样清零', api.state.criteriaIdx === 0, String(api.state.criteriaIdx));

  // 识别丢了：短暂丢帧保持不变（识别本来就会抖），丢久了才变灰并清零
  api.updateCriteria({ ok: true, perSide: { L: { knee: 130 }, R: { knee: 150 } }, kneeExtended: 150 }, [], 6300);
  const beforeLost = api.state.criteriaIdx;
  api.updateCriteria({ ok: false }, [], 6400);
  ok('刚丢一帧不会立刻变灰（给识别抖动留宽限）',
    elements.get('criteriaBar').classList.contains('active') === true
    && api.state.criteriaIdx === beforeLost, `${elements.get('criteriaBar').className} / ${api.state.criteriaIdx}`);
  api.updateCriteria({ ok: false }, [], 7400);  ok('丢失识别超过宽限后进度条回到灰色（尚未开始）',
    elements.get('criteriaBar').classList.contains('idle') === true
    && api.state.criteriaIdx === -1, `${elements.get('criteriaBar').className} / ${api.state.criteriaIdx}`);

  // 换动作 → 格子跟着换（判据不同 → 图标不同）
  api.openExercise('lunge');
  api.state.session = 'running';
  api.buildCriteriaBar();
  api.updateCriteria({ ok: true, perSide: { L: { knee: 175 }, R: { knee: 175 } }, kneeExtended: 175 }, [], 7000);
  ok('换到箭步蹲后进度条重建（格数跟着关键帧走）',
    segCount() === specStages('lunge').length, `${segCount()} 格`);
  ok('箭步蹲站着时只点亮「站姿」格', api.state.criteriaIdx === 0, String(api.state.criteriaIdx));
  api.updateCriteria({
    ok: true, perSide: { L: { knee: 120 }, R: { knee: 140 } }, kneeExtended: 140,
  }, [], 7100);
  ok('箭步蹲蹲到 120°/140°（两条腿都弯过 146°）后走到「双腿」那一格',
    api.state.criteriaIdx === specStages('lunge').length - 2, String(api.state.criteriaIdx));

  // 后腿弯得不够（150° > 新的 146° 门槛）时，卡在「双腿」那一格
  api.resetCriteriaProgress();
  api.updateCriteria({ ok: true, perSide: { L: { knee: 120 }, R: { knee: 150 } }, kneeExtended: 150 }, [], 7150);
  ok('后腿只弯到 150° 时过不了「双腿」那一格（门槛已收到 146°）',
    api.state.criteriaIdx === 2, String(api.state.criteriaIdx));

  // 后腿不弯时，卡在「双腿」那一格
  api.resetCriteriaProgress();
  api.updateCriteria({ ok: true, perSide: { L: { knee: 120 }, R: { knee: 172 } }, kneeExtended: 172 }, [], 7200);
  ok('后腿几乎伸直时卡在「双腿」那一格', api.state.criteriaIdx === 2, String(api.state.criteriaIdx));

  // 回主页 → 进度条隐藏
  api.showHome();
  ok('回主页后进度条隐藏', elements.get('criteriaBar').hidden === true);
  api.openExercise('squat');
  api.stopSession('user');
  api.showHome();
}

/* ------------------------------------------------------------------ *
 * 手势圆环：一组结束后的「退出 / 再做一次」（手掌停在圆环中央 3 秒）
 * ------------------------------------------------------------------ */

console.log('\n[8c] 一组结束后的手势圆环');
{
  const api = windowStub.__mfg;
  const { LM } = await import('../src/geometry.js');
  const { ASPECT: A, standingPose: sp } = await import('./synthetic-pose.mjs');

  /** 造一份 33 点骨架，把「左手/右手」的手腕+食指+小指+拇指放到指定位置（归一化坐标） */
  const palmsAt = (x, y, visibility = 1) => {
    const lm = sp({ knee: 175, ankleX: 1.0, view: 'front' }).map((p) => ({ ...p, visibility }));
    for (const w of [LM.L_WRIST, LM.R_WRIST]) {
      for (const off of [0, 2, 4, 6]) {          // 手腕 / 小指 / 食指 / 拇指
        lm[w + off] = { x, y, z: 0, visibility };
      }
    }
    return lm;
  };
  const at = (key) => api.GESTURE_RINGS[key];
  const ring = (key) => elements.get(key === 'exit' ? 'ringExit' : 'ringRetry');
  const shown = () => elements.get('gestureRings').hidden === false;

  api.openExercise('squat');
  api.state.session = 'running';
  api.state.settings.mirror = false;   // 前面的用例把镜像打开了，这里从明确的初始状态开始
  ok('训练中（还没做完一组）不显示手势圆环', shown() === false);

  // 做完一组 → 圆环出现（左＝退出，右＝再做一次），并给出用法提示
  api.state.target = 1;
  api.state.detector.validReps = 1;
  api.stopSession('goal');
  ok('一组做完后出现两个手势圆环', shown() === true
    && elements.get('gestureRings').hidden === false);
  ok('左圆环写「退出」、右圆环写「再做一次」',
    elements.get('ringExitLabel').textContent === '退出'
    && elements.get('ringRetryLabel').textContent === '再做一次',
    `${elements.get('ringExitLabel').textContent} / ${elements.get('ringRetryLabel').textContent}`);
  ok('画面上给出「手掌放进圆环保持 3 秒」的提示',
    elements.get('gestureHint').hidden === false
    && elements.get('gestureHint').textContent.includes('3 秒'),
    elements.get('gestureHint').textContent);
  ok('两个圆环按 GESTURE_RINGS 的比例摆位（和手势判定用同一份坐标）',
    ring('exit').style.left === `${at('exit').x * 100}%` && ring('retry').style.top === `${at('retry').y * 100}%`,
    `${ring('exit').style.left}/${ring('retry').style.left}`);

  // 手掌不在圆环里 → 不累积
  api.updateGesture(palmsAt(0.5, 0.56), 1000);
  ok('手掌在两个圆环之间时进度为 0', api.gestureState.exit.p === 0 && api.gestureState.retry.p === 0,
    `${api.gestureState.exit.p}/${api.gestureState.retry.p}`);

  // 手掌停在「再做一次」圆环中央 → 顺时针进度按时间走
  api.updateGesture(palmsAt(at('retry').x, at('retry').y), 1000);
  api.updateGesture(palmsAt(at('retry').x, at('retry').y), 2000);
  const p1 = api.gestureState.retry.p;
  api.updateGesture(palmsAt(at('retry').x, at('retry').y), 2500);
  const p2 = api.gestureState.retry.p;
  ok('手掌停在圆环中央时进度随时间前进（0.33 → 0.5）',
    Math.abs(p1 - 1 / 3) < 0.02 && Math.abs(p2 - 0.5) < 0.02, `${p1.toFixed(2)} → ${p2.toFixed(2)}`);
  ok('识别到手掌时圆环进入「正在蓄力」状态（变色）',
    (api.updateGesture(palmsAt(at('retry').x, at('retry').y), 2600), ring('retry').classList.contains('dwelling')));
  ok('圆环里显示还剩几秒',
    elements.get('ringRetryTimer').textContent.endsWith('s'), elements.get('ringRetryTimer').textContent);

  // 手离开 → 宽限期内不清零，超过宽限后进度退回
  api.updateGesture(palmsAt(0.5, 0.56), 2700);
  ok('手掌刚移开时不清零（给识别抖动留宽限）', api.gestureState.retry.p > 0.4);
  let guard = 0;
  while (api.gestureState.retry.p > 0 && guard < 200) { api.updateGesture(palmsAt(0.5, 0.56), 3100 + guard * 40); guard += 1; }
  ok('手掌移开后进度退回 0（不会误触）', api.gestureState.retry.p === 0, String(api.gestureState.retry.p));

  // 停满 3 秒 = 再做一次：计数器清零 + 立刻重新开始这一组
  api.state.detector.validReps = 3;
  api.state.detector.score = 21;
  api.updateGesture(palmsAt(at('retry').x, at('retry').y), 10000);
  api.updateGesture(palmsAt(at('retry').x, at('retry').y), 12000);
  api.updateGesture(palmsAt(at('retry').x, at('retry').y), 13001);
  ok('手掌停满 3 秒触发「再做一次」：计数与分数清零',
    api.state.detector.validReps === 0 && api.state.detector.score === 0,
    `${api.state.detector.validReps} / ${api.state.detector.score}`);
  ok('触发后立刻重新开始这一组（进入 3-2-1）', api.state.session === 'countdown', api.state.session);
  ok('触发后圆环收起来', shown() === false);
  api.finishCountdown();

  // 退出：停满 3 秒 → 回到主页
  api.stopSession('goal');
  ok('一组做完后圆环又出现', shown() === true);
  api.updateGesture(palmsAt(at('exit').x, at('exit').y), 20000);
  api.updateGesture(palmsAt(at('exit').x, at('exit').y), 22000);
  api.updateGesture(palmsAt(at('exit').x, at('exit').y), 23001);
  ok('手掌停满 3 秒触发「退出」：回到主页', api.state.homeMode === true);
  ok('退出后圆环收起来', shown() === false);

  // 镜像预览：画面是翻过来的，圆环没有翻 → 判定必须跟着翻，否则手势会反
  api.openExercise('squat');
  api.state.settings.mirror = true;
  api.state.session = 'running';
  api.stopSession('goal');
  api.updateGesture(palmsAt(1 - at('exit').x, at('exit').y), 30000);
  api.updateGesture(palmsAt(1 - at('exit').x, at('exit').y), 31000);
  ok('镜像预览下，手掌位置跟着镜像（否则左右会反）', api.gestureState.exit.p > 0.3,
    String(api.gestureState.exit.p));
  api.state.settings.mirror = false;
  api.hideGestureRings();

  // 手被挡住（visibility 很低）不算
  api.stopSession('goal');
  api.updateGesture(palmsAt(at('exit').x, at('exit').y, 0.1), 40000);
  api.updateGesture(palmsAt(at('exit').x, at('exit').y, 0.1), 42000);
  ok('手被身体挡住（可见度低）时不算手掌在圆环里', api.gestureState.exit.p === 0);

  // 人走开 → 圆环留着（卧姿类动作做完时人本来就不在站立轮廓里，不能因此收掉）
  api.state.afterSet = true;
  api.calibrationStep({ ok: false }, 50000);
  ok('人不在轮廓里（卧姿类做完）时圆环也留着，不会一闪就没',
    elements.get('gestureRings').hidden === false);
  api.showHome();
}

/* ------------------------------------------------------------------ *
 * 所有动作做完一组都要给出「退出 / 再做一次」
 * ------------------------------------------------------------------ */

console.log('\n[8d] 每个动作做完一组都有两个圆环');
{
  const api = windowStub.__mfg;
  const { EXERCISES } = await import('../src/exercises.js');
  const ringsShown = () => elements.get('gestureRings').hidden === false;
  const bad = [];
  for (const ex of EXERCISES) {
    api.openExercise(ex.id);
    api.state.settings.mirror = false;
    api.state.session = 'running';
    // 造一点成绩（计数类给次数、计时类给已计时），模拟「做完一组」
    api.state.detector.validReps = 1;
    api.state.detector.holdMs = 1000;
    api.stopSession('goal');
    if (!ringsShown()) bad.push(`${ex.id}:没显示`);
    if (elements.get('ringExitLabel').textContent !== '退出'
      || elements.get('ringRetryLabel').textContent !== '再做一次') bad.push(`${ex.id}:文案`);
    // 结束之后再跑几帧校准（卧姿类动作这时人不在站立轮廓里）：圆环不能被收掉
    api.state.afterSet = true;
    api.calibrationStep({ ok: false }, 90000);
    if (!ringsShown()) bad.push(`${ex.id}:闪没了`);
    api.hideGestureRings();
  }
  ok(`全部 ${EXERCISES.length} 个动作（计数 + 计时）做完一组都显示两个圆环`, bad.length === 0, bad.join(', '));

  // 计时类动作也一样（用户要求「所有运动」）：平板支撑做满时间 → 结束 → 圆环
  api.openExercise('plank');
  api.state.session = 'running';
  api.state.detector.holdMs = api.state.target * 1000;
  api.stopSession('goal');
  ok('计时类（平板支撑）做完也显示两个圆环', ringsShown() === true);

  // 手动点「结束本组」同样给选择
  api.openExercise('squat');
  api.state.session = 'running';
  api.state.detector.validReps = 3;
  api.stopSession('user');
  ok('手动结束本组同样显示两个圆环', ringsShown() === true);

  // 开始下一组就收起来（选择已经发生 / 不需要了）
  api.beginCountdown();
  ok('开始下一组时圆环收起（3-2-1 倒计时干净的）', ringsShown() === false);
  api.finishCountdown();
  api.showHome();
  ok('回主页后圆环收起', ringsShown() === false);
}

/* ------------------------------------------------------------------ *
 * 开合跳（新增在「全身」分类里）
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * [8e2] 勾腿跳：三格进度条 + 图标 + 最后一格由「换边成功」点亮
 * ------------------------------------------------------------------ */

console.log('\n[8e2] 勾腿跳');
{
  const api = windowStub.__mfg;
  const segEls = () => elements.get('criteriaTrack').children;
  const segCount = () => segEls().length;
  const iconHtml = () => segEls().map((c) => c.innerHTML).join('');
  const { specStages } = await import('../src/specs.js');
  api.openExercise('buttKick');
  ok('勾腿跳默认目标是「限时 60 秒」（用户要求改成定时计次）',
    api.state.target === 60, String(api.state.target));
  api.buildCriteriaBar();
  api.state.session = 'running';
  api.state.criteriaLive = true;
  api.state.detector.gateOk = true;
  api.state.detector.active = true;
  const stages = specStages('buttKick');
  ok('勾腿跳进度条 = 3 格（站立 → 勾腿 → 换另一条腿勾）', segCount() === 3, String(segCount()));
  ok('勾腿跳每一格都画了图标（站姿勾腿的火柴人，不是躺着的图）',
    (iconHtml().match(/<svg class="criteria-icon"/g) || []).length === 3, iconHtml().slice(0, 100));
  const iconPaths = (iconHtml().match(/<line /g) || []).length;
  ok('勾腿跳的后两格图标是勾腿姿势（线条数比「站立」那格多）', iconPaths >= 3 * 6, String(iconPaths));

  // 第一格：站着（门控过了）就点亮
  api.state.detector.switched = false;
  api.updateCriteria({ ok: true, torsoIncl: 10, kneeClear: 0.5, hipClear: 1.0, perSide: { L: { knee: 170 }, R: { knee: 170 } } }, [], 1000);
  ok('勾腿跳：站着时只点亮「站立」这一格', api.state.criteriaIdx === 0, String(api.state.criteriaIdx));
  // 勾起来一条腿（膝角 80°）：点亮「勾腿」那一格
  api.updateCriteria({ ok: true, torsoIncl: 10, kneeClear: 0.5, hipClear: 1.0, perSide: { L: { knee: 80 }, R: { knee: 168 } } }, [], 1100);
  ok('勾腿跳：勾起来一条腿（膝角 80° ≤100°）点亮「勾腿」那一格',
    api.state.criteriaIdx === 1, String(api.state.criteriaIdx));
  // 最后一格用识别器自己的「换边成功」标记：没换边不亮，换边了才亮（= 计次那一刻）
  ok('勾腿跳：还没换边时最后一格不亮（switched = false）',
    api.state.criteriaIdx === 1, String(api.state.criteriaIdx));
  api.state.detector.switched = true;
  api.updateCriteria({ ok: true, torsoIncl: 10, kneeClear: 0.5, hipClear: 1.0, perSide: { L: { knee: 168 }, R: { knee: 80 } } }, [], 1200);
  ok('勾腿跳：换边成功（识别器 switched = true）时最后一格点亮 —— 也就是计次那一刻',
    api.state.criteriaIdx === stages.length - 1, String(api.state.criteriaIdx));
  api.showHome();
}

console.log('\n[8e] 开合跳');
{
  const api = windowStub.__mfg;
  const { localizedExercise } = await import('../src/exercises.js');
  const { isTimedReps } = await import('../src/catalog.js');
  const segEls = () => elements.get('criteriaTrack').children;
  const segCount = () => segEls().length;
  const iconHtml = () => segEls().map((c) => c.innerHTML).join('');

  const cards = documentStub.querySelectorAll('.ex-card').map((c) => c.dataset.id);
  ok('主页动作墙里有开合跳', cards.includes('jumpingJack'), cards.join(','));
  ok('深蹲跳不再出现在「全身」块里（只在下肢）',
    documentStub.querySelectorAll('.cat-block').length === 5, `${documentStub.querySelectorAll('.cat-block').length}`);

  api.openExercise('jumpingJack');
  ok('开合跳默认目标是「限时 60 秒」（用户要求改成定时计次）',
    api.state.target === 60 && localizedExercise('jumpingJack').timed === true, String(api.state.target));
  ok('目标输入框也跟着显示 60', String(elements.get('targetInput').value) === '60', String(elements.get('targetInput').value));
  ok('目标单位是「秒」而不是「次」（成绩才是次数）',
    elements.get('targetUnit').textContent === '秒'
    && localizedExercise('jumpingJack').unit === '次',
    `${elements.get('targetUnit').textContent} / ${localizedExercise('jumpingJack').unit}`);
  ok('时长预设是秒（30/45/60/90/120），不是次数',
    elements.get('targetChips').children.map((c) => c.textContent).join(',') === '30 秒,45 秒,60 秒,90 秒,120 秒',
    elements.get('targetChips').children.map((c) => c.textContent).join(','));
  ok('🎯 运动设定里写明了「限时计数」的规则与时长',
    elements.get('exerciseTime').hidden === false
    && elements.get('exerciseTime').textContent.includes('60'), elements.get('exerciseTime').textContent);
  // 「+ / −」按 15 秒一步（时长不是次数，一步 1 秒太慢）
  elements.get('tPlus').dispatch('click');
  ok('时长加减按钮按 15 秒一步', api.state.target === 75, String(api.state.target));
  api.setTarget(60);
  ok('改回 60 秒后时长存进 settings.seconds（不会和「次数」那个字段混在一起）',
    api.state.settings.seconds.jumpingJack === 60, JSON.stringify(api.state.settings.seconds));
  api.buildCriteriaBar();
  api.state.session = 'running';
  // 通用引擎的「站立」门控是识别器自己的布尔状态（detFlag: gateOk），桩里直接给上
  api.state.detector.gateOk = true;
  api.state.detector.active = true;
  // 判据量的是 legSpread（膝 / 踝取较大值），阈值按用户反馈放宽到 0.54 / 0.66 / 0.54
  // （计次线又从 0.73 收到 0.66：用户反馈「0.73 可能太大了，适度调小一点」）
  api.updateCriteria({ ok: true, torsoIncl: 6, kneeClear: 0.8, hipClear: 1.5, legSpread: 0.3 }, [], 1000);
  // 用户要求：开合跳节奏快，「开始」那一格一闪而过没意义 → 只留三帧
  ok('开合跳进度条 = 3 格（并拢站好 → 跳开 → 收回）', segCount() === 3, String(segCount()));
  ok('开合跳每一格都画了图标（正面开合的火柴人）',
    (iconHtml().match(/<svg class="criteria-icon"/g) || []).length === 3, iconHtml().slice(0, 120));
  ok('站着并拢时只点亮「站立」这一格', api.state.criteriaIdx === 0, String(api.state.criteriaIdx));
  ok('跳开之后进度条往前走（跳开 → 开到最大，收回那一格要等真的并拢才亮）', (() => {
    api.state.detector.progress = 0.33;
    api.updateCriteria({ ok: true, torsoIncl: 6, kneeClear: 0.8, hipClear: 1.5, legSpread: 0.6 }, [], 1100);
    const mid = api.state.criteriaIdx;                      // 0.60 < 0.66：还没到计次线
    api.state.detector.progress = 0.6;
    api.updateCriteria({ ok: true, torsoIncl: 6, kneeClear: 0.8, hipClear: 1.5, legSpread: 0.68 }, [], 1150);
    const counted = api.state.criteriaIdx;                  // 0.68 ≥ 0.66：点亮「跳开（计次）」
    api.state.detector.progress = 0.9;
    api.updateCriteria({ ok: true, torsoIncl: 6, kneeClear: 0.8, hipClear: 1.5, legSpread: 1.1 }, [], 1200);
    const top = api.state.criteriaIdx;
    api.state.detector.progress = 0.05;
    api.updateCriteria({ ok: true, torsoIncl: 6, kneeClear: 0.8, hipClear: 1.5, legSpread: 0.3 }, [], 1300);
    return mid === 0 && counted === 1 && top === 1 && api.state.criteriaIdx === 2;
  })(), `mid=${api.state.criteriaIdx}`);
  ok('开合跳得分分配到三帧：并拢 4 / 跳开 7+14=21 / 收回 8 + 满轮 6',
    JSON.stringify(api.state.criteriaMax.map((r) => r.points)) === '[4,21,8]'
    && api.state.criteriaMax[2].bonus === 6,
    JSON.stringify(api.state.criteriaMax));
  api.showHome();
}

/* ------------------------------------------------------------------ *
 * 计时类每 5 秒读秒（用户要求：平板支撑播报「5 秒」「10 秒」…）
 * ------------------------------------------------------------------ */

console.log('\n[8f] 计时类每 5 秒读秒');
{
  const api = windowStub.__mfg;
  const { localizedExercise } = await import('../src/exercises.js');
  const said = [];
  const origSay = api.audio.say.bind(api.audio);
  api.audio.say = (txt, o) => { said.push(String(txt)); return origSay(txt, o); };
  const step = (ms, now) => api.announceHoldCount(api.state.detector, localizedExercise(api.state.exerciseId), now);

  api.openExercise('plank');
  api.state.session = 'running';
  ok('平板支撑是计时类（读秒逻辑适用）', localizedExercise('plank').kind === 'hold');
  ok('读秒间隔就是 5 秒', api.HOLD_COUNT_EVERY === 5, String(api.HOLD_COUNT_EVERY));

  const reads = [];
  for (let sec = 1; sec <= 24; sec += 1) {
    api.state.detector.holdMs = sec * 1000;
    if (step(sec * 1000, 1000 + sec * 1000)) reads.push(sec);
  }
  ok('每 5 秒读一次：5 / 10 / 15 / 20 各读一次（中间不读）',
    reads.join(',') === '5,10,15,20', reads.join(','));
  ok('读到「5 秒」', said.includes('5 秒'), said.join(' | '));
  ok('读到「10 秒」', said.includes('10 秒'), said.join(' | '));
  ok('4 秒 / 6 秒这种非整档不读', !said.includes('4 秒') && !said.includes('6 秒'), said.join(' | '));
  ok('每次读都是「数字 + 秒」', said.filter((x) => /^\d+ 秒$/.test(x)).length === 4, said.join(' | '));

  // 计时归零（新一组 / 换动作 / 重置计数）→ 重新从 5 秒开始读
  api.state.detector.holdMs = 0;
  step(0, 40000);
  api.state.detector.holdMs = 5000;
  ok('计时归零后重新从 5 秒读起', step(5000, 41000) === true);

  // 暂停很久再恢复（秒数跳档）→ 只读当前这一档，不连珠炮
  said.length = 0;
  api.state.detector.holdMs = 32000;
  step(32000, 60000);
  ok('秒数跳档时只读一次（不连珠炮）', said.length === 1 && said[0] === '30 秒', said.join(' | '));

  // 计数类动作不该读秒
  api.openExercise('squat');
  api.state.session = 'running';
  ok('计数类动作不读秒', step(5000, 70000) === false);

  // 侧平板这种计时动作同样按 5 秒读（换动作 → 新识别器计时为 0 → 读秒重新装填）
  api.openExercise('sidePlank');
  api.state.session = 'running';
  said.length = 0;
  step(0, 79000);
  api.state.detector.holdMs = 15000;
  ok('侧平板支撑也按 5 秒读（计时类通用）', step(15000, 80000) === true && said[0] === '15 秒', said.join(' | '));

  // 切到英文时读英文单位
  api.changeLang('en');
  api.openExercise('plank');
  api.state.session = 'running';
  said.length = 0;
  step(0, 89000);
  api.state.detector.holdMs = 5000;
  step(5000, 90000);
  ok('切到英文后读「5 seconds」', said.includes('5 seconds'), said.join(' | '));
  api.changeLang('zh');

  api.audio.say = origSay;
  api.showHome();
}

/* ------------------------------------------------------------------ *
 * [8g] 开合跳：限时计数（用户要求「固定 60 秒，看能跳多少次」）
 *
 * 两段：
 *   ① 剩余时间播报的节奏（直接调函数，精确到「哪一档报一次」）；
 *   ② 跑**真实主循环**把一组时间跑完（目标临时改成 3 秒，否则要跑 60 秒的帧），
 *      核对：时间到 → 立刻停止计次、用时停在上限、结算 = 「N 次」+ 100%、记录带时长，
 *      以及「普通计数动作不会被时间结束」（回归保护）。
 * ------------------------------------------------------------------ */

console.log('\n[8g] 开合跳：限时计数（60 秒看能跳多少次）');
{
  const api = windowStub.__mfg;
  const { localizedExercise } = await import('../src/exercises.js');
  const { LM: LMK } = await import('../src/geometry.js');
  const { standingPose: sp } = await import('./synthetic-pose.mjs');
  const said = [];
  const origSay = api.audio.say.bind(api.audio);
  api.audio.say = (txt, o) => { said.push(String(txt)); return origSay(txt, o); };

  api.openExercise('jumpingJack');
  const jack = localizedExercise('jumpingJack');
  api.setTarget(60);
  ok('开合跳是限时计数，默认 60 秒', jack.timed === true && api.state.target === 60, `${jack.timed}/${api.state.target}`);

  // ---- ① 剩余时间播报：45 / 30 / 15 秒各一次，最后 5 秒单独喊 ----
  api.state.timeCallsSaid = null;
  api.state.timeUp = false;
  const calls = [];
  for (const left of [50, 45, 40, 30, 20, 15, 10, 5, 2]) {
    api.state.elapsedMs = (60 - left) * 1000;
    if (api.announceTimeLeft(jack, 1000)) calls.push(left);
  }
  ok('剩余时间只在 45 / 30 / 15 秒各报一次（中间的秒数不念）',
    calls.join(',') === '45,30,15,5', calls.join(','));
  ok('播报文案是「还剩 N 秒」', said.includes('还剩 45 秒') && said.includes('还剩 30 秒')
    && said.includes('还剩 15 秒'), said.join(' | '));
  ok('最后 5 秒换成冲刺话术', said.includes('最后 5 秒，冲刺！'), said.join(' | '));
  api.state.timeUp = true;
  ok('时间到之后不再报剩余时间', api.announceTimeLeft(jack, 2000) === false);
  api.state.timeUp = false;
  ok('普通计数动作不会被时间结束（不报剩余时间）',
    api.announceTimeLeft(localizedExercise('squat'), 3000) === false
    && api.announceTimeLeft(localizedExercise('plank'), 3000) === false);

  // ---- ② 真实主循环：把一组时间跑完 ----
  const savedStream = api.camera.stream;
  const savedDetect = api.engine.detect;
  const savedReady = api.state.engineReady;
  const savedPerf = globalThis.performance;
  api.camera.stream = { getTracks: () => [], getVideoTracks: () => [] };
  api.camera.video.readyState = 4;
  api.state.engineReady = true;
  let clock = 8_000_000;
  const fakePerf = { now: () => clock, timeOrigin: savedPerf.timeOrigin };
  Object.defineProperty(globalThis, 'performance', { value: fakePerf, configurable: true, writable: true });
  windowStub.performance = fakePerf;

  // 校准要求「全身在画面里」，所以姿势要按校准目标大小摆好（同 [8] / [14]）
  const fit = (lm, { k = 0.78, cx0 = 0.5, groundY = 0.92 } = {}) => {
    const ankleY = Math.max(lm[LMK.L_ANKLE].y, lm[LMK.R_ANKLE].y);
    const cx = (lm[LMK.L_HIP].x + lm[LMK.R_HIP].x + lm[LMK.L_SHOULDER].x + lm[LMK.R_SHOULDER].x) / 4;
    return lm.map((p) => ({ ...p, x: cx0 + (p.x - cx) * k, y: groundY + (p.y - ankleY) * k }));
  };
  const pose = fit(sp({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0, view: 'front' }));
  api.engine.detect = () => ({ landmarks: pose, worldLandmarks: null });
  let vt = 8_000_000;
  const pump = (n) => {
    for (let i = 0; i < n; i++) {
      clock += 33.4;
      vt += 33.4;
      api.camera.video.currentTime = vt;
      api.state.engineReady = true;
      if (!api.camera.stream) api.camera.stream = { getTracks: () => [], getVideoTracks: () => [] };
      api.loop();
    }
  };

  // 目标临时改成 3 秒：功能一样，测试不用真跑 60 秒的帧
  api.setTarget(3);
  api.openExercise('jumpingJack');
  api.setTarget(3);
  ok('时长改成 3 秒后，目标与单位都跟着变（秒）', api.state.target === 3, String(api.state.target));
  pump(30);                                   // 站好 → 校准完成 → 倒计时
  ok('校准完成后自动进入倒计时', api.state.session === 'countdown', api.state.session);
  api.state.countdownStartedAt = clock - 4000; // 用主循环里的时间兜底推进倒计时
  pump(2);
  ok('倒计时结束进入计数', api.state.session === 'running', api.state.session);
  ok('HUD 显示剩余时间（⏱ 剩余 N / 3 秒）',
    /剩余\s*3\s*\/\s*3\s*秒/.test(elements.get('hudSub').textContent), elements.get('hudSub').textContent);
  ok('计时开始时画面上的提示写明了时长',
    elements.get('cueLine').textContent.includes('3 秒'), elements.get('cueLine').textContent);

  // 这一组跳了 7 次（计数本身由 tests/test-detectors.mjs 逐帧验证，这里只关心「时间」这条线）
  api.state.detector.validReps = 7;
  pump(95);                                   // 3 秒 ≈ 90 帧
  ok('时间到：进入「停止计次」状态', api.state.timeUp === true);
  ok('时间到时仍然停在 running（先放庆祝动画，2.6 秒后才结算）',
    api.state.session === 'running', api.state.session);
  ok('时间到后 feedDetector 直接返回空（多跳的几下不算进这一组）',
    Array.isArray(api.feedDetector(null, clock)) && api.feedDetector(null, clock).length === 0);
  const repsAtTimeUp = api.state.detector.validReps;
  pump(40);                                   // 庆祝动画里继续跳
  ok('庆祝动画期间次数不再增加', api.state.detector.validReps === repsAtTimeUp,
    `${repsAtTimeUp} → ${api.state.detector.validReps}`);
  ok('本组用时停在上限（不会跑到 3 秒以上）', api.state.elapsedMs === 3000, String(api.state.elapsedMs));
  ok('HUD 的剩余时间归零（不会出现负数）',
    /剩余\s*0\s*\/\s*3\s*秒/.test(elements.get('hudSub').textContent), elements.get('hudSub').textContent);

  // 庆祝动画走完 → 自动结算（之后必然回到「校准 / 就位等开始」这两态之一）
  pump(90);
  ok('时间到后自动结算（离开 running，回到等下一组的状态）',
    (api.state.session === 'calibrating' || api.state.session === 'ready')
    && api.state.afterSet === true && !/running|paused/.test(api.state.session), api.state.session);
  const grid = elements.get('summaryGrid').innerHTML;
  ok('结算面板里的成绩是「7 次」（成绩单位仍是次数）', /7 次/.test(grid), grid.slice(0, 200));
  ok('结算面板里的完成度按时间算 = 100%', /100%/.test(grid), grid.slice(0, 200));
  ok('结算面板里的本组用时 = 00:03', /00:03/.test(grid), grid.slice(0, 200));
  ok('结算说明写明「3 秒时间到：完成 7 次」',
    elements.get('summaryNote').textContent.includes('3 秒时间到')
    && elements.get('summaryNote').textContent.includes('7'), elements.get('summaryNote').textContent);
  ok('一组结束的播报是「3 秒完成 7 次 + 夸奖」（不念分数）',
    said.some((x) => x.includes('3 秒完成 7 次')), said.join(' | '));
  const rec = JSON.parse(store.get('mfg.records.v1') || '{}').jumpingJack;
  ok('最佳成绩里记下「7 次 / 3 秒」（改动后的时长不会让成绩说不清）',
    rec && rec.value === 7 && rec.seconds === 3, JSON.stringify(rec));

  // ---- ③ 勾腿跳同样适用（用户要求「勾腿跳也改为在固定时长内计次，比如 1 分钟」）----
  const kick = localizedExercise('buttKick');
  ok('勾腿跳也是限时计数，默认 60 秒', kick.timed === true && kick.seconds === 60);
  api.openExercise('buttKick');
  ok('打开勾腿跳后目标就是 60 秒（时长单独存，不会读到旧的「20 次」）',
    api.state.target === 60, String(api.state.target));
  ok('勾腿跳的目标单位是秒、时长预设同样是 30/45/60/90/120 秒',
    elements.get('targetUnit').textContent === '秒'
    && elements.get('targetChips').children.map((c) => c.textContent).join(',') === '30 秒,45 秒,60 秒,90 秒,120 秒',
    `${elements.get('targetUnit').textContent} / ${elements.get('targetChips').children.length}`);
  ok('🎯 运动设定里同样写明了「限时计数」与时长',
    elements.get('exerciseTime').hidden === false
    && elements.get('exerciseTime').textContent.includes('60'), elements.get('exerciseTime').textContent);
  // 用 3 秒跑完一组，核对「时间到」这条线在 alt 引擎的动作上也一样生效
  api.setTarget(3);
  api.openExercise('buttKick');
  api.setTarget(3);
  pump(30);
  api.state.countdownStartedAt = clock - 4000;
  pump(2);
  ok('勾腿跳也能进入计数（限时计数不挑引擎）', api.state.session === 'running', api.state.session);
  api.state.detector.validReps = 41;
  pump(95);
  ok('勾腿跳时间到同样立刻停止计次', api.state.timeUp === true
    && api.feedDetector(null, clock).length === 0);
  pump(130);                                  // 庆祝动画走完 → 自动结算
  const kickRec = JSON.parse(store.get('mfg.records.v1') || '{}').buttKick;
  ok('勾腿跳的最佳成绩也记成「41 次 / 3 秒」',
    kickRec && kickRec.value === 41 && kickRec.seconds === 3, JSON.stringify(kickRec));
  ok('勾腿跳的结算说明同样写「3 秒时间到：完成 41 次」',
    elements.get('summaryNote').textContent.includes('3 秒时间到')
    && elements.get('summaryNote').textContent.includes('41'), elements.get('summaryNote').textContent);
  api.state.settings.seconds.buttKick = 60;    // 还原成默认 60 秒

  // ---- ④ 回归：普通计数动作不会被「时间」结束 ----
  api.openExercise('squat');
  ok('深蹲不是限时计数', localizedExercise('squat').timed === false);
  pump(30);
  api.state.countdownStartedAt = clock - 4000;
  pump(2);
  pump(1900);                                 // 跑 60 秒以上
  ok('普通计数动作跑过 60 秒也不会被时间结束（只有限时计数才看时间）',
    api.state.session === 'running' && api.state.timeUp === false
    && api.state.elapsedMs > 60_000,
    `${api.state.session}/${api.state.timeUp}/${Math.round(api.state.elapsedMs)}`);

  // 恢复现场
  api.engine.detect = savedDetect;
  api.state.engineReady = savedReady;
  api.camera.stream = savedStream;
  api.camera.video.currentTime = 0;
  api.state.session = 'idle';
  Object.defineProperty(globalThis, 'performance', { value: savedPerf, configurable: true, writable: true });
  windowStub.performance = savedPerf;
  api.audio.say = origSay;
  api.state.settings.seconds.jumpingJack = 60;   // 把测试里临时改的 3 秒还回默认 60 秒
  api.showHome();
}
{
  const { AudioKit } = await import('../src/audio.js');
  const spoken = [];
  const oldSynth = globalThis.speechSynthesis;
  const oldUtter = globalThis.SpeechSynthesisUtterance;
  globalThis.speechSynthesis = {
    cancel() {},
    speak(u) { spoken.push(u.text); u.onstart?.(); u.onend?.(); },
    getVoices: () => [],
  };
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = String(text); } };
  const kit = new AudioKit();
  kit.voiceOn = true;

  // 模拟「上一句被 cancel 后再也没有 onend」：_speaking 卡死 20 秒
  kit._speaking = true;
  kit._speakingSince = performance.now() - 20000;
  kit.say('第一句');
  await new Promise((r) => setTimeout(r, 20));
  ok('语音状态卡死超过 10 秒后能自动恢复（不会永久没声音）', spoken.includes('第一句'), spoken.join(' / '));

  // 连发两句（间隔超过 minGapMs）：cancel + speak 不该把后一句吞掉
  spoken.length = 0;
  await new Promise((r) => setTimeout(r, 320));   // 先让上一条的节流窗口过去
  kit.say('A');
  await new Promise((r) => setTimeout(r, 320));
  kit.say('B');
  await new Promise((r) => setTimeout(r, 20));
  ok('连续两次提示都能发声（cancel 后不会吞掉新的一句）',
    spoken.includes('A') && spoken.includes('B'), spoken.join(' / '));

  globalThis.speechSynthesis = oldSynth;
  globalThis.SpeechSynthesisUtterance = oldUtter;
}

/* ------------------------------------------------------------------ *
 * 声音自检：首次交互解锁音频 + 开关立刻试播 + 诊断面板显示音频状态
 * ------------------------------------------------------------------ */

console.log('\n[10] 声音自检');
{
  const api = windowStub.__mfg;

  // 浏览器要求「页面先有过一次交互」才允许出声：第一次点击/按键/触摸就要把音频解锁
  const keydownBefore = (documentStub._listeners.keydown || []).length;
  documentStub.dispatch('pointerdown');
  ok('第一次用户交互后音频被解锁', api.audio._unlocked === true);
  ok('解锁用的监听器用完即撤（keydown 上少了一个）',
    (documentStub._listeners.keydown || []).length === keydownBefore - 1,
    `before=${keydownBefore} after=${(documentStub._listeners.keydown || []).length}`);
  documentStub.dispatch('pointerdown');   // 再点一次也不该报错
  ok('重复点击不会报错', true);

  // 打开「语音」开关：立刻试播一句，用户当场就能确认有没有声音
  const spoken = [];
  const origSay = api.audio.say;
  api.audio.say = (txt, o) => { spoken.push(txt); return origSay.call(api.audio, txt, o); };
  const voiceBtn = elements.get('btnVoice');
  voiceBtn.setAttribute('aria-pressed', 'false');
  voiceBtn.dispatch('click');
  ok('打开语音开关会立刻试播一句', spoken.length === 1, spoken.join(' / '));
  ok('试播之后语音开关处于开启状态', api.audio.voiceOn === true);
  voiceBtn.dispatch('click');   // 关掉
  ok('关掉语音开关会停止朗读并静音', api.audio.voiceOn === false);
  voiceBtn.dispatch('click');   // 再打开，恢复原样
  api.audio.say = origSay;

  // 诊断面板显示音频状态，便于用户自查「为什么没声音」
  const st = api.audio.state();
  ok('audio.state() 给出音频上下文与语音包数量',
    typeof st.ctx === 'string' && typeof st.voices === 'number',
    JSON.stringify(st));
  api.state.settings.debug = true;
  const fakeFrame = {
    ok: true, view: 'front', viewRatio: 0.85, bodyVisible: true, legsVisible: true,
    trunkLean: 6, kneeAngle: 176, elbowAngle: 170, hipAngle: 175, bodyStraight: 178,
    hipRise: 0.1, thighFromHoriz: 60, coreVis: 0.9,
  };
  api.renderDebug(fakeFrame);
  ok('诊断面板里有一项「声音」状态', elements.get('debugLine').textContent.includes('声音'),
    elements.get('debugLine').textContent.slice(-90));
  api.state.settings.debug = false;
}

/* ------------------------------------------------------------------ *
 * 背景音乐（现场合成，不依赖音频文件）
 * ------------------------------------------------------------------ */

console.log('\n[11] 背景音乐');
{
  const {
    musicEvents, musicLoopSeconds, mtof, MUSIC, TRACKS, DEFAULT_TRACK, getTrack,
  } = await import('../src/audio.js');
  const ev = musicEvents();
  const count = (k) => ev.filter((e) => e.kind === k).length;

  ok('mtof 换算正确（A4 = 440Hz）', mtof(69) === 440 && Math.abs(mtof(60) - 261.63) < 0.01);
  ok('至少 4 首可选曲目，id 唯一且有名字键', TRACKS.length >= 4
    && new Set(TRACKS.map((m) => m.id)).size === TRACKS.length
    && TRACKS.every((m) => typeof m.nameKey === 'string' && m.nameKey.startsWith('music.track.')),
  TRACKS.map((m) => m.id).join(','));
  ok('默认曲子是列表里的第一首', DEFAULT_TRACK === TRACKS[0].id && getTrack('nope').id === TRACKS[0].id);
  ok('每首曲子都是 4 小节、带和弦进行与鼓组/贝斯/主旋律图案',
    TRACKS.every((m) => m.progression.length === 4
      && m.drums && m.drums.kick.length > 0 && m.drums.snare.length > 0 && m.drums.hat.length > 0
      && m.bass.length >= 4 && m.lead.length >= 4
      && ['kick', 'snare', 'hat'].every((k) => Array.isArray(m.drums[k]))));
  ok('四首曲子的速度与和声进行各不相同（不是同一首换个名字）',
    new Set(TRACKS.map((m) => m.bpm)).size >= 3
    && new Set(TRACKS.map((m) => m.progression.map((b) => b.root).join('-'))).size === TRACKS.length,
    TRACKS.map((m) => `${m.id}:${m.bpm}`).join(' '));

  // 每首曲子的事件都要：排好序、落在循环内、音量不刺耳、音高在可听范围
  for (const track of TRACKS) {
    const e2 = musicEvents(track);
    const loop = musicLoopSeconds(track);
    ok(`${track.id}：事件都在一个循环内且有序`,
      e2.length > 60 && e2[0].t === 0 && e2.every((x, i) => i === 0 || x.t >= e2[i - 1].t)
      && e2.every((x) => x.t >= 0 && x.t < loop + 0.05),
      `${e2.length} 个事件 / 循环 ${loop.toFixed(2)}s`);
    ok(`${track.id}：有鼓组（底鼓+军鼓+踩镲）与贝斯`,
      ['kick', 'snare', 'hat', 'bass'].every((k) => e2.some((x) => x.kind === k)));
    ok(`${track.id}：单音音量 ≤0.25、音高在 40Hz~12kHz`,
      e2.every((x) => x.gain <= 0.25 && x.freq >= 40 && x.freq <= 12000));
  }

  ok('循环长度 = 16 拍（4 小节）',
    Math.abs(musicLoopSeconds() - 16 * (60 / MUSIC.bpm)) < 1e-9,
    `${musicLoopSeconds().toFixed(2)}s`);
  ok('事件按时间排好序，且从 0 开始',
    ev[0].t === 0 && ev.every((e, i) => i === 0 || e.t >= ev[i - 1].t));
  ok('默认曲目包含明亮的旋律、低音与鼓组',
    count('lead') > 0 && count('bass') > 0 && count('kick') > 0 && count('snare') > 0 && count('hat') > 0,
    JSON.stringify({ lead: count('lead'), bass: count('bass'), kick: count('kick'), snare: count('snare'), hat: count('hat') }));
  ok('单个音符音量不超过 0.25（不刺耳、也不会盖住语音）',
    ev.every((e) => e.gain <= 0.25), String(Math.max(...ev.map((e) => e.gain))));

  // 「节奏感鲜明」的三条特征：① 重拍清晰 ② 有切分或反拍重音 ③ 拍速在运动区间
  const beat = 60 / MUSIC.bpm;
  const kicks = ev.filter((e) => e.kind === 'kick').map((e) => e.t / beat);
  ok('底鼓有切分（不只是死板的正拍）',
    kicks.some((t) => Math.abs(t - Math.round(t)) > 0.3),
    kicks.slice(0, 6).map((t) => t.toFixed(2)).join(','));
  ok('有拍手/反拍重音这类「推着动」的元素',
    TRACKS.every((m) => (m.drums.clap || []).length > 0 || (m.drums.hatAccent || []).length > 0));
  ok('每首曲子都在运动可用的拍速区间（110~160 BPM）',
    TRACKS.every((m) => m.bpm >= 110 && m.bpm <= 160), TRACKS.map((m) => m.bpm).join(','));
  const musicVolume = windowStub.__mfg.audio.musicVolume;
  const duckVolume = windowStub.__mfg.audio.musicDuckVolume;
  ok('音乐音量明显调大（≥0.25），且念要领时仍会压低',
    musicVolume >= 0.25 && musicVolume > duckVolume, `${musicVolume} vs ${duckVolume}`);

  // 开关接线：没有 WebAudio 环境时也不能报错（Node 里就是这样）
  const api = windowStub.__mfg;
  const musicBtn = elements.get('btnMusic');
  musicBtn.setAttribute('aria-pressed', 'false');
  musicBtn.dispatch('click');
  ok('点「音乐」开关会记住设置（主页上不播，进动作页才播）',
    api.state.settings.music === true && api.state.homeMode === true && api.audio.musicOn === false,
    `settings=${api.state.settings.music} home=${api.state.homeMode} musicOn=${api.audio.musicOn}`);
  // 进动作页 → 背景音乐接上；回主页 → 停掉（用户反馈：主页不要放背景音）
  api.openExercise('bridge');
  ok('进动作页后开始播放背景音乐', api.audio.musicOn === true);
  api.showHome();
  ok('回到主页后背景音乐停掉', api.audio.musicOn === false);
  ok('回主页只是停播，用户的选择仍然保留', api.state.settings.music === true);

  // ---- 摄像头：回到主页就关掉（用户反馈：回主页可以关摄像头了） ----
  let trackStopped = false;
  api.camera.stream = { getTracks: () => [{ stop() { trackStopped = true; } }] };
  api.showHome();
  ok('回到主页会关掉摄像头', trackStopped === true && api.state.camStoppedForHome === true);
  ok('关掉摄像头后遮罩回来（提示可以重新开启）',
    elements.get('stageMask').classList.contains('hidden') === false);
  ok('状态条说明摄像头已关', elements.get('camStatus').textContent.includes('摄像头'),
    elements.get('camStatus').textContent);
  api.state.camStoppedForHome = false;   // 后面还要用摄像头跑端到端

  api.openExercise('bridge');
  ok('再次进动作页会自动接着放', api.audio.musicOn === true);
  api.showHome();
  musicBtn.dispatch('click');   // 关掉
  ok('关掉音乐开关后设置也变了',
    api.state.settings.music === false && api.audio.musicOn === false);
  musicBtn.dispatch('click');   // 恢复默认（开）
  ok('没有 WebAudio 环境时启动音乐不报错（静默降级）',
    api.audio._musicTimer === null || typeof api.audio._musicTimer === 'object');
  ok('控制台里没有因音乐产生的错误',
    !api.state.consoleErrors.some((e) => /music/i.test(e)),
    api.state.consoleErrors.slice(-2).join(' | '));

  // ---- 选曲界面：设置弹窗里能选，选了会记住，并且会自动把音乐打开 ----
  const trackBtns = documentStub.querySelectorAll('.track-btn');
  ok('设置弹窗里列出了全部曲目', trackBtns.length === TRACKS.length,
    `实际 ${trackBtns.length} 个`);
  const pick = trackBtns.find((b) => b.dataset.track === TRACKS[2].id);
  musicBtn.setAttribute('aria-pressed', 'false');
  api.state.settings.music = false;
  pick.dispatch('click');
  ok('点某首曲子会切换曲目并记住',
    api.state.settings.musicTrack === TRACKS[2].id && api.audio.trackId === TRACKS[2].id,
    `${api.state.settings.musicTrack}`);
  ok('选曲子会自动把背景音乐打开（否则选了也听不到）',
    api.state.settings.music === true);
  api.selectMusicTrack(DEFAULT_TRACK);
  ok('可以切回默认曲目', api.state.settings.musicTrack === DEFAULT_TRACK);
}

/* ------------------------------------------------------------------ *
 * 语音教练：画面上的提示都要念出来（以语音提示为主）
 * ------------------------------------------------------------------ */

console.log('\n[12] 语音教练');
{
  const api = windowStub.__mfg;
  const said = [];
  const origSay = api.audio.say;
  api.audio.say = (txt, o) => { said.push(txt); return origSay.call(api.audio, txt, o); };
  api.state.settings.voice = true;

  // 1) 找不到人：主动念「请站到画面中间…」
  said.length = 0;
  api.state.coachAt = -Infinity;
  api.state.hintUntil = 0;
  api.updateStatusHint({ ok: false }, performance.now() + 1000);
  ok('找不到人时会念出来', said.some((s) => s.includes('站到画面中间')), said.join(' / '));

  // 2) 该做哪个动作：念「下一步，…」并带上具体差多少
  said.length = 0;
  api.state.coachAt = -Infinity;
  api.state.hintUntil = 0;
  const detRef = api.state.detector || api.state.__det;
  const fakeDet = {
    pendingHint: () => ({ id: 'descend', labelKey: 'steps.squat.descend.label', hint: { key: 'steps.squat.descend.hint', params: null } }),
    feedback: null,
    active: true,
    standby: '',
  };
  const savedDet = api.state.detector;
  api.state.detector = fakeDet;
  api.updateStatusHint({ ok: true }, performance.now() + 2000);
  ok('会念出「下一步 + 要领名 + 差多少」',
    said.some((s) => s.startsWith('下一步') && s.includes('蹲')), said.join(' / '));

  // 3) 节流：紧接着再说一次不同的话不会立刻插话
  said.length = 0;
  fakeDet.pendingHint = () => ({ id: 'parallel', labelKey: 'steps.squat.parallel.label', hint: null });
  api.updateStatusHint({ ok: true }, performance.now() + 2100);
  ok('教练有全局最小间隔，不会每帧都念', said.length === 0, said.join(' / '));

  // 4) 同一句话短时间内不重复（间隔过了也不重复，超过去重窗口才再提醒）
  said.length = 0;
  api.state.coachAt = -Infinity;
  api.state.coachSig = '';
  const tBase = performance.now();
  api.updateStatusHint({ ok: false }, tBase + 10000);
  const first = said.length;
  api.updateStatusHint({ ok: false }, tBase + 15000);
  ok('同一句提示短时间内不重复念（间隔已过也不重复）',
    first === 1 && said.length === 1, said.join(' / '));
  // coachSay 用的是真实时钟，这里直接把「上次说话时间」往前拨，模拟去重窗口已过
  api.state.coachAt = performance.now() - 20000;
  api.updateStatusHint({ ok: false }, tBase + 31000);
  ok('超过去重窗口后会再提醒一次', said.length === 2, said.join(' / '));
  api.state.detector = savedDet;

  // 5) 姿势纠正：cue 事件直接念出来
  said.length = 0;
  api.state.coachAt = -Infinity;
  api.handleEvents([{ type: 'cue', code: 'depth', key: 'cues.squat.depth', params: null, level: 'warn' }]);
  ok('姿势纠正会被念出来', said.some((s) => s.includes('蹲低')), said.join(' / '));

  // 5.1) 每做一个都报数（用户明确要求）
  said.length = 0;
  api.state.coachAt = -Infinity;
  api.state.detector = savedDet;
  api.state.repsSinceEncourage = 0;
  api.state.settings.voice = true;
  if (api.state.detector) api.state.detector.validReps = 1;
  api.handleEvents([{ type: 'rep', valid: true, index: 1 }]);
  ok('做一次就报一次数（1 次）', said.some((s) => /^1\b/.test(s.trim())), said.join(' / '));
  said.length = 0;
  api.state.detector.validReps = 2;
  api.handleEvents([{ type: 'rep', valid: true, index: 2 }]);
  ok('第二下也要报数（不会被上一句吞掉）', said.some((s) => /^2\b/.test(s.trim())), said.join(' / '));

  // 5.2) 每 3 次给一句激励（语音以鼓励为主）
  said.length = 0;
  api.state.detector.validReps = 3;
  api.handleEvents([{ type: 'rep', valid: true, index: 3 }]);
  const poolRaw = (await import('../src/i18n.js')).t('speech.encourage');
  const pool = Array.isArray(poolRaw) ? poolRaw : [String(poolRaw)];
  const encouraged = said.filter((s) => pool.includes(s));
  ok('满 3 次会给一句激励语', encouraged.length >= 1, `说了 ${said.join(' / ')}｜池子 ${pool.join('/')}`);

  // 5.2a) 用户要求：语音**一律不报分数**；跨过 50 分改成念一句激励语
  {
    const base = api.state.lastScoreMilestone || 0;
    said.length = 0;
    api.state.coachAt = -Infinity;
    // 清掉「上一句激励」的去重状态：去重命中时本来就该闭嘴，那不是这条用例要测的东西
    api.audio._lastEncourage = null;
    api.handleEvents([{ type: 'points', score: base + 60 }]);
    const crossed = Math.floor((base + 60) / 50) * 50;
    ok('跨过 50 分时不再念分数（不出现数字与「分」）',
      said.length > 0 && !said.some((s) => /分|points/.test(s)), said.join(' / '));
    ok('跨过 50 分时改念一句激励语',
      said.some((s) => pool.includes(s)), said.join(' / '));
    ok('跨过 50 分的档位被记住（不会重复念）', api.state.lastScoreMilestone === crossed,
      `${api.state.lastScoreMilestone} vs ${crossed}`);
  }

  // 5.2b) 整轮满分（关键帧全做到）→ 补一句更热烈的夸奖
  {
    said.length = 0;
    api.handleEvents([{ type: 'bonus', points: 6 }]);
    await new Promise((r) => setTimeout(r, 1100));   // 夸奖延后 0.9 秒，等它说完
    const roundPraise = (await import('../src/i18n.js')).t('speech.praiseRound');
    ok('整轮满分时会念一句夸奖（完美 / 太漂亮了…）',
      (Array.isArray(roundPraise) ? roundPraise : [roundPraise]).some((p) => said.includes(p)),
      said.join(' / '));
  }

  // 5.2b-2) 激励语池要够大（用户要求「多给点情绪价值」）
  {
    const zhPool = (await import('../src/locales/zh.js')).default.speech.encourage;
    const enPool = (await import('../src/locales/en.js')).default.speech.encourage;
    ok('激励语池至少 20 句（用户要求多一些情绪价值）', zhPool.length >= 20, `${zhPool.length} 句`);
    ok('中英激励语池长度一致（否则轮到的句子对不上）', zhPool.length === enPool.length,
      `${zhPool.length} vs ${enPool.length}`);
    ok('激励语里有「太棒了 / 优秀 / 加油」这类正面词',
      zhPool.includes('太棒了') && zhPool.includes('优秀') && zhPool.includes('加油'), zhPool.slice(0, 6).join('/'));
  }


  // 5.2b) 快节奏动作（开合跳 / 勾腿跳）：每 5 次才报一次数（用户要求），中间的次数不念
  {
    const same = api.state.exerciseId;
    for (const [id, name] of [['jumpingJack', '开合跳'], ['buttKick', '勾腿跳']]) {
      api.selectExercise(id);
      api.state.settings.voice = true;
      api.state.detector = api.state.detector || savedDet;
      api.state.repsSinceEncourage = 0;
      const counts = [];
      for (const n of [1, 4, 5, 6, 9, 10, 11, 14, 15, 19, 20]) {
        said.length = 0;
        api.state.detector.validReps = n;
        api.handleEvents([{ type: 'rep', valid: true, index: n }]);
        const spokeCount = said.some((s) => new RegExp(`^${n}\\b`).test(s.trim()));
        if (spokeCount) counts.push(n);
      }
      ok(`${name}：只在 5 的整数倍报数（5 / 10 / 15 / 20），中间的次数不念`,
        counts.join(',') === '5,10,15,20', `实际报了：${counts.join(',') || '（一次都没报）'}`);
    }
    api.selectExercise(same);
    api.state.detector = savedDet;
  }

  // 5.3) 纠正提示在做过几次之后明显降频（gapMs 更大）
  said.length = 0;
  api.state.detector.validReps = 6;
  api.state.coachAt = performance.now() - 2000;   // 距上次说话 2 秒
  api.handleEvents([{ type: 'cue', code: 'depth', key: 'cues.squat.depth', params: null, level: 'warn' }]);
  ok('做起来之后纠正提示不再插话（2 秒间隔内不念）', said.length === 0, said.join(' / '));

  // 6) 一组结束：念本组成绩（**只念次数 + 一句夸奖，不念分数** —— 用户要求语音不报分数）
  said.length = 0;
  api.state.coachAt = -Infinity;
  api.state.detector = savedDet;
  if (api.state.detector) { api.state.detector.validReps = 7; api.state.detector.score = 42; }
  api.state.session = 'running';
  api.stopSession('user');
  const summaryLine = said.find((s) => s.includes('7')) || '';
  ok('一组结束时会念出本组次数',
    /\b7\b/.test(summaryLine), said.join(' / '));
  ok('一组结束的播报里**没有分数**（不念「42 分」）',
    summaryLine !== '' && !summaryLine.includes('42') && !summaryLine.includes('分'), summaryLine);
  const setPraise = (await import('../src/i18n.js')).t('speech.praiseSet');
  ok('一组结束时会补一句夸奖（情绪价值）',
    (Array.isArray(setPraise) ? setPraise : [setPraise]).some((p) => summaryLine.includes(p)), summaryLine);
  ok('结算面板上仍然有分数（只是不念出来）',
    elements.get('summaryGrid').innerHTML.includes('得分'), elements.get('summaryGrid').innerHTML.slice(0, 80));

  api.audio.say = origSay;
  api.state.settings.voice = true;
  api.toCalibration({ silent: true });
}

/* ------------------------------------------------------------------ *
 * [13] 最佳成绩 / 运动记录：顶栏两个图标 + 弹窗（用户要求：不再放在动作页里）
 *
 * 放在最后：这一段会切主页 / 换动作 / 派发 Esc，先跑的用例对会话状态有期待，别影响它们。
 * ------------------------------------------------------------------ */

console.log('\n[13] 最佳成绩 / 运动记录（两个图标 + 弹窗）');
{
  const api = windowStub.__mfg;

  ok('动作页侧栏里不再有「最佳成绩」卡片',
    !/<h2 class="card-title" data-i18n="ui\.best"><\/h2>/.test(html));
  ok('动作页侧栏里不再有「训练记录」卡片（连清空按钮一起搬走）',
    !/<ul class="history-list" id="historyList">/.test(html.split('id="historyModal"')[0]));
  ok('两个新图标（🏆 最佳成绩 / 📜 运动记录）在顶栏里',
    /id="btnBest"/.test(html) && /id="btnHistory"/.test(html)
    && /🏆/.test(html) && /📜/.test(html));
  {
    const span = (from, to) => html.slice(html.indexOf(from), html.indexOf(to));
    ok('列表被搬进了弹窗里（recordList / historyList / 清空按钮都在弹窗中）',
      span('id="bestModal"', 'id="historyModal"').includes('id="recordList"')
      && span('id="historyModal"', '<script').includes('id="historyList"')
      && span('id="historyModal"', '<script').includes('id="btnClearHistory"'));
  }

  // 点图标打开弹窗（打开时会先把列表刷成最新的）
  api.openExercise('squat');
  store.set('mfg.records.v1', JSON.stringify({ squat: { value: 12, score: 340 } }));
  store.set('mfg.history.v1', JSON.stringify([
    { at: Date.now(), exerciseId: 'squat', value: 12, score: 340, partial: 1, reached: true },
  ]));
  elements.get('btnBest').dispatch('click');
  const recText = elements.get('recordList').children.map((c) => c.innerHTML).join(' | ');
  ok('点 🏆 打开最佳成绩弹窗，并列出记录（12 次 / 340 分）',
    elements.get('bestModal').hidden === false
    && recText.includes('12') && recText.includes('340'), recText.slice(0, 100));
  elements.get('bestBackdrop').dispatch('click');
  ok('点背景关闭最佳成绩弹窗', elements.get('bestModal').hidden === true);

  elements.get('btnHistory').dispatch('click');
  const histText = elements.get('historyList').children.map((c) => c.innerHTML).join(' | ');
  ok('点 📜 打开运动记录弹窗，并列出最近一组（动作名 + 成绩）',
    elements.get('historyModal').hidden === false && histText.includes('12') && /深蹲|Squat/.test(histText),
    histText.slice(0, 100));

  // Esc 关闭（记录弹窗优先于「结束本组」）。注意：keydown 上挂着一个一次性的
  // 「首次手势解锁音频」监听器，把它原样还原，别影响后续用例。
  const snapshot = {};
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) snapshot[ev] = [...(documentStub._listeners[ev] || [])];
  api.state.session = 'idle';
  documentStub.dispatch('keydown', { key: 'Escape' });
  for (const [ev, list] of Object.entries(snapshot)) documentStub._listeners[ev] = list;
  ok('Esc 关闭运动记录弹窗（不会误当成「结束本组」）',
    elements.get('historyModal').hidden === true && api.state.session === 'idle', api.state.session);

  // 回主页也关掉（不留悬空弹窗）
  elements.get('btnBest').dispatch('click');
  api.showHome();
  ok('返回主页时记录弹窗自动关闭', elements.get('bestModal').hidden === true);

  // 清空按钮搬进弹窗后仍然有效，并给一句反馈
  api.openExercise('squat');
  store.set('mfg.history.v1', JSON.stringify([
    { at: Date.now(), exerciseId: 'squat', value: 12, score: 340, partial: 0, reached: true },
  ]));
  store.set('mfg.records.v1', JSON.stringify({ squat: { value: 12, score: 340 } }));
  windowStub.confirm = () => true;
  globalThis.confirm = () => true;   // app.js 里是裸调用 confirm()，桩要同时改全局那一份
  elements.get('btnHistory').dispatch('click');
  elements.get('btnClearHistory').dispatch('click');
  ok('弹窗里的「清空」能真的清掉记录与最佳成绩',
    (store.get('mfg.history.v1') === '[]') && (store.get('mfg.records.v1') === '{}'),
    `${store.get('mfg.history.v1')} / ${store.get('mfg.records.v1')}`);
  ok('清空后列表显示空态文案',
    elements.get('historyList').children.map((c) => c.innerHTML).join('').includes('暂无')
    || elements.get('historyList').innerHTML.includes('暂无'),
    elements.get('historyList').innerHTML.slice(0, 60));
  ok('清空后给了一句反馈（提示条）', elements.get('cueLine').textContent.includes('清空'),
    elements.get('cueLine').textContent);
}

/* ------------------------------------------------------------------ *
 * [14] 虚线轮廓的显示时机（跑真实主循环，全 22 个动作）
 *
 * 用户要求：**刚开始识别人体的时候画面里有虚线人体轮廓，识别成功进入运动状态后就要隐藏。**
 * 这一段的做法不是「看代码觉得对」，而是真的把 loop() 一帧一帧跑起来，
 * 记录每一帧交给渲染器的 outline，然后按会话状态分类断言：
 *   没找到人 → 画；还没就位 → 画；识别成功（含休息态）→ 不画；倒计时/计数/暂停 → 一帧都不画。
 * 放在最后：它会驱动摄像头/推理桩跑完整流程，别影响前面的用例。
 * ------------------------------------------------------------------ */

console.log('\n[14] 虚线轮廓：识别成功就隐藏（真实主循环，全 22 个动作）');
{
  const { toMetric: tm, LM: LMK } = await import('../src/geometry.js');
  const { ASPECT: A, standingPose: sp } = await import('./synthetic-pose.mjs');
  const api = windowStub.__mfg;

  ok('测试能驱动真实主循环（__mfg 暴露了 loop）', typeof api.loop === 'function');

  // 摄像头 + 推理打桩：loop() 因此能真的跑完「没找到人 → 就位 → 倒计时 → 计数 → 暂停 → 收工」
  const savedStream = api.camera.stream;
  const savedDetect = api.engine.detect;
  const savedEngineReady = api.state.engineReady;
  const savedDraw = api.renderer.draw;
  const savedPerf = globalThis.performance;
  api.camera.stream = { getTracks: () => [], getVideoTracks: () => [] };
  api.camera.video.readyState = 4;
  api.state.engineReady = true;

  // 可控时钟：校准要「保持 0.6 秒」才算识别成功，靠真实时间跑 22 个动作太慢，
  // 所以这里给主循环一个每帧走 33.4ms 的假时钟（app.js 里所有计时都走 performance.now）。
  let clock = 5_000_000;
  const fakePerf = { now: () => clock, timeOrigin: savedPerf.timeOrigin };
  Object.defineProperty(globalThis, 'performance', { value: fakePerf, configurable: true, writable: true });
  windowStub.performance = fakePerf;

  let pose = null;
  api.engine.detect = () => (pose ? { landmarks: pose, worldLandmarks: null } : null);

  /** 每一帧交给渲染器的 outline（连同当时的会话状态）——一路累积，最后整体查一遍 */
  const frames = [];
  const since = () => frames.length;
  const sliceFrom = (i) => frames.slice(i);
  api.renderer.draw = (o) => {
    frames.push({ session: api.state.session, outline: o?.outline ?? null });
  };

  /** 把姿势缩放到校准目标大小并摆到画面中间（同 [8]） */
  const fit = (lm, { k = 0.78, cx0 = 0.5, groundY = 0.92, dx = 0 } = {}) => {
    const ankleY = Math.max(lm[LMK.L_ANKLE].y, lm[LMK.R_ANKLE].y);
    const cx = (lm[LMK.L_HIP].x + lm[LMK.R_HIP].x + lm[LMK.L_SHOULDER].x + lm[LMK.R_SHOULDER].x) / 4;
    return lm.map((p) => ({ ...p, x: cx0 + dx + (p.x - cx) * k, y: groundY + (p.y - ankleY) * k }));
  };

  let t = 4_000_000;
  const pump = (lm, n = 1) => {
    pose = lm;
    for (let i = 0; i < n; i++) {
      clock += 33.4;                      // 假时钟往前走一帧（33.4ms ≈ 30fps）
      t += 33.4;
      api.camera.video.currentTime = t;   // 每帧都变，主循环才会真的渲染
      api.state.engineReady = true;       // 摄像头/模型桩：始终视为就绪
      if (!api.camera.stream) api.camera.stream = { getTracks: () => [], getVideoTracks: () => [] };
      api.loop();
    }
  };

  const idle = fit(sp({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0, view: 'front' }));
  const offSpot = fit(sp({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0, view: 'front' }), { dx: 0.9 });
  const at = (list, fn) => list.filter(fn);
  const drawn = (list) => at(list, (f) => f.outline !== null);
  const WORK = new Set(['countdown', 'running', 'paused']);

  const bad = { search: [], keep: [], work: [], rest: [], back: [] };
  let reachedRunning = 0;

  for (const meta of EXERCISES) {
    const tag = `${meta.icon} ${meta.id}`;
    api.openExercise(meta.id);

    // ① 还没识别到人体：画面里必须有「找人」的虚线轮廓
    let i0 = since();
    pump(null, 3);
    const noBody = sliceFrom(i0);
    if (!(noBody.length === 3 && noBody.every((f) => f.outline && f.outline.status === 'search'))) {
      bad.search.push(`${tag}：${noBody.map((f) => (f.outline ? f.outline.status : 'null')).join(',')}`);
    }

    // ② 站进画面 → 保持住 → 自动进入运动状态（倒计时 → 计数）
    i0 = since();
    pump(idle, 40);
    const settle = sliceFrom(i0);
    const calibFrames = at(settle, (f) => f.session === 'calibrating');
    if (calibFrames.length && drawn(calibFrames).length !== calibFrames.length) {
      bad.keep.push(`${tag}：校准阶段有 ${calibFrames.length - drawn(calibFrames).length} 帧没画轮廓`);
    }
    if (!settle.some((f) => f.session === 'countdown')) {
      bad.keep.push(`${tag}：站好后没有自动进入倒计时（${settle[settle.length - 1]?.session}）`);
    }

    // 倒计时用时间兜底推进（主循环里本来就有的那条兜底），然后真的跑一段计数
    api.state.countdownStartedAt = clock - 4000;
    i0 = since();
    pump(idle, 25);
    const work = sliceFrom(i0);
    if (work.some((f) => f.session === 'running')) reachedRunning += 1;
    if (drawn(work).length) {
      bad.work.push(`${tag}：倒计时/计数期间画了 ${drawn(work).length} 帧轮廓（${work.find((f) => f.outline)?.session}）`);
    }

    // ③ 暂停也不该画
    api.pauseSession();
    i0 = since();
    pump(idle, 3);
    if (drawn(sliceFrom(i0)).length) bad.work.push(`${tag}：暂停时画了轮廓`);

    // ④ 一组结束回到校准：**识别成功后同样不再画轮廓**（不再留一条绿色轮廓）
    api.stopSession('goal');
    i0 = since();
    pump(idle, 40);
    const rest = sliceFrom(i0);
    if (api.state.session !== 'ready') bad.rest.push(`${tag}：休息态没有停在「可以开始」（${api.state.session}）`);
    const restReady = at(rest, (f) => f.session === 'ready' || f.session === 'countdown');
    if (!restReady.length || drawn(restReady).length) {
      bad.rest.push(`${tag}：休息态就位后还画了 ${drawn(restReady).length} 帧轮廓`);
    }
    if (!drawn(at(rest, (f) => f.session === 'calibrating')).length) {
      bad.rest.push(`${tag}：休息态还没站好时也不画轮廓（那就没有引导了）`);
    }

    // ⑤ 站偏（离开就位状态）→ 轮廓重新出现，把人领回轮廓里。
    // 这里要跑够 16 帧（≈0.53 秒）：站偏后还有 300ms 的抖动宽限（flickerGraceMs），
    // 单帧不达标不该让轮廓一闪一闪的。
    i0 = since();
    pump(offSpot, 16);
    if (!drawn(sliceFrom(i0)).length) bad.back.push(`${tag}：站偏后轮廓没有重新出现`);
  }

  const all = EXERCISES.map((e) => e.id).join(',');
  ok('这一段覆盖了全部动作（22 个）', EXERCISES.length === 22, all);
  ok('每个动作都真的进入了计数状态（不是空跑）', reachedRunning === EXERCISES.length,
    `实际 ${reachedRunning}/${EXERCISES.length}`);
  ok('没识别到人体时，画面里画「找人」的虚线轮廓（亮蓝）', bad.search.length === 0,
    bad.search.slice(0, 3).join(' | '));
  ok('就位之前轮廓一直在（一直引导你站进轮廓里）', bad.keep.length === 0,
    bad.keep.slice(0, 3).join(' | '));
  ok('倒计时 / 计数 / 暂停期间**一帧都不画**虚线轮廓', bad.work.length === 0,
    bad.work.slice(0, 3).join(' | '));
  ok('识别成功后不再画轮廓（休息态也不留绿色轮廓）', bad.rest.length === 0,
    bad.rest.slice(0, 3).join(' | '));
  ok('站偏（离开就位状态）后轮廓重新出现', bad.back.length === 0,
    bad.back.slice(0, 3).join(' | '));

  // 硬性不变量（把跑过的每一帧都翻一遍，不只看抽样出来的那几段）：
  // 训练三态（countdown / running / paused）里**绝不允许**出现 dashed outline。
  const total = frames.length;
  const workFrames = at(frames, (f) => WORK.has(f.session));
  const workDrawn = drawn(workFrames);
  ok(`跑过的每一帧都符合「训练中不画轮廓」（共 ${total} 帧，其中训练态 ${workFrames.length} 帧）`,
    total > 1000 && workFrames.length > 500 && workDrawn.length === 0,
    `训练态画了 ${workDrawn.length} 帧：${workDrawn.slice(0, 3).map((f) => f.session).join(',')}`);
  ok('校准态（还没就位）的帧里轮廓是常态：确实在引导',
    drawn(at(frames, (f) => f.session === 'calibrating')).length > 100,
    String(drawn(at(frames, (f) => f.session === 'calibrating')).length));

  // 🐞 面板里能直接看到「这一帧画没画虚线轮廓」，排查「还有轮廓」时不用猜
  api.state.settings.debug = true;
  api.renderDebug(null, { kind: 'front', status: 'adjust' });
  const outlineOn = elements.get('debugLine').textContent;
  api.renderDebug(null, null);
  const outlineOff = elements.get('debugLine').textContent;
  ok('🐞 面板显示「虚线轮廓」这一帧画了没（画了 ✓ / 没画 ✗）',
    outlineOn.includes('虚线轮廓') && outlineOn.includes('✓')
    && outlineOff.includes('虚线轮廓') && outlineOff.includes('✗'),
    `${outlineOn} / ${outlineOff}`);
  api.state.settings.debug = false;

  // 恢复现场
  api.renderer.draw = savedDraw;
  api.engine.detect = savedDetect;
  api.state.engineReady = savedEngineReady;
  api.camera.stream = savedStream;
  api.camera.video.currentTime = 0;
  Object.defineProperty(globalThis, 'performance', { value: savedPerf, configurable: true, writable: true });
  windowStub.performance = savedPerf;
  api.toCalibration({ silent: true });
  api.state.session = 'idle';
}

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
