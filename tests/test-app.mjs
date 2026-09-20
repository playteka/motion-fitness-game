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
    this.className = '';
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
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); if (v === '') this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  addEventListener(t, fn) { (this.listeners[t] || (this.listeners[t] = [])).push(fn); }
  removeEventListener() {}
  dispatch(type, ev = {}) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, target: this, ...ev }); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  querySelector() { return null; }
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
  fillText() { ctxCounts.fillText += 1; },
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

  // 严格模式：弹窗与配置弹窗是同一个开关，必须双向同步
  const strictBtn = elements.get('btnStrict');
  const strictEx = elements.get('btnStrictEx');
  strictBtn.setAttribute('aria-pressed', 'false');
  api.state.settings.strict = false;
  strictBtn.dispatch('click');
  ok('在配置弹窗里打开严格模式后，运动设定里也是打开的',
    strictEx.getAttribute('aria-pressed') === 'true', String(strictEx.getAttribute('aria-pressed')));
  strictEx.dispatch('click');
  ok('在运动设定里点严格模式，等同于点配置弹窗里那个开关',
    strictBtn.getAttribute('aria-pressed') === 'false' && api.state.settings.strict === false,
    `strict=${api.state.settings.strict}`);

  // 关闭方式：✕、点背景、Esc
  elements.get('btnCloseExercise').dispatch('click');
  ok('点 ✕ 关闭运动设定弹窗', elements.get('exerciseModal').hidden === true);
  elements.get('btnExerciseInline').dispatch('click');
  ok('侧栏「设定目标」卡片里的按钮也能打开', elements.get('exerciseModal').hidden === false);
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

  for (const lang of ['es', 'fr']) {
    api.changeLang(lang);
    const name = elements.get('hudName').textContent;
    const howto = elements.get('howtoList').innerHTML;
    const cjk = /[\u4e00-\u9fff]/.test(elements.get('stepList').innerHTML + name + elements.get('stepHint').textContent);
    ok(`切到 ${lang} 后界面没有中文残留`, !cjk, `${name} | ${elements.get('stepHint').textContent.slice(0, 60)}`);
    ok(`切到 ${lang} 后动作文案与中文不同`, !!name && name !== zhName && howto !== zhHowto, name);
  }

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
  ok('这一轮保留绿色轮廓，等用户自己点开始',
    outlineAfterSet && outlineAfterSet.status === 'ready', JSON.stringify(outlineAfterSet));
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
 * 语音播报的健壮性（浏览器不给被取消的那句触发 onend 时不能永久哑掉）
 * ------------------------------------------------------------------ */

console.log('\n[9] 语音播报健壮性');
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
  // 5.3) 纠正提示在做过几次之后明显降频（gapMs 更大）
  said.length = 0;
  api.state.detector.validReps = 6;
  api.state.coachAt = performance.now() - 2000;   // 距上次说话 2 秒
  api.handleEvents([{ type: 'cue', code: 'depth', key: 'cues.squat.depth', params: null, level: 'warn' }]);
  ok('做起来之后纠正提示不再插话（2 秒间隔内不念）', said.length === 0, said.join(' / '));

  // 6) 一组结束：念本组成绩
  said.length = 0;
  api.state.coachAt = -Infinity;
  api.state.detector = savedDet;
  if (api.state.detector) { api.state.detector.validReps = 7; api.state.detector.score = 42; }
  api.state.session = 'running';
  api.stopSession('user');
  ok('一组结束时会念出本组成绩',
    said.some((s) => s.includes('7') && s.includes('42')), said.join(' / '));

  api.audio.say = origSay;
  api.state.settings.voice = true;
  api.toCalibration({ silent: true });
}

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
