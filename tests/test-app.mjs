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
  strokeStyle: null, globalAlpha: null, lineWidth: null,
};
const ctxStub = {
  clearRect() {}, beginPath() {}, closePath() {}, save() {}, restore() {}, setLineDash() {},
  arcTo() {},
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
  addEventListener() {},
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
  ok('界面生成了 6 个动作按钮', documentStub.querySelectorAll('.exercise-btn').length === 6,
    `实际 ${documentStub.querySelectorAll('.exercise-btn').length}`);
  ok('要领清单已渲染', elements.get('stepList').innerHTML.includes('step-item'));
  ok('没有运行时错误横幅', !documentStub.documentElement.dataset.error,
    documentStub.documentElement.dataset.error);
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
  ok('切到英文后动作按钮重新渲染', documentStub.querySelectorAll('.exercise-btn').length === 6);
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

  // 站进轮廓并保持
  const idle = fit(sp({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0, view: 'front' }));
  let outline = null;
  let t3 = 500000;
  for (let i = 0; i < 60; i++) {
    outline = api.calibrationStep(frameOf(idle, t3), t3);
    t3 += 33.4;
  }
  ok('站进轮廓并保持后判定校准完成', api.state.session === 'ready', api.state.session);
  ok('校准完成时轮廓切到「已就位」配色', outline.status === 'ready', outline.status);
  ok('校准完成后开始按钮可用', elements.get('btnStart').disabled === false);
  ok('校准清单逐项打勾', elements.get('calibList').innerHTML.includes('calib-item done'),
    elements.get('calibList').innerHTML.slice(0, 60));
  ok('校准完成后给出开始提示', elements.get('cueLine').textContent.includes('开始'),
    elements.get('cueLine').textContent);

  // 机位跟着动作变
  api.selectExercise('lunge');
  ok('切到箭步蹲后要求侧面机位', api.state.calibrator.view === 'side', api.state.calibrator.view);
  const sideIdle = fit(sp({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0, view: 'side' }));
  const o2 = api.calibrationStep(frameOf(sideIdle, t3), t3);
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

  // 站偏时给方向提示
  api.toCalibration();
  ok('重新校准后回到校准阶段', api.state.session === 'calibrating');
  api.calibrationStep(frameOf(fit(sideIdle, { dx: 0.3 }), t3), t3);
  ok('站偏时给出左右方向提示', /左|右/.test(elements.get('calibHint').textContent),
    elements.get('calibHint').textContent);
  ok('站偏时有人体但未就位（轮廓为调整色）',
    api.calibrationStep(frameOf(fit(sideIdle, { dx: 0.3 }), t3), t3).status === 'adjust');

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

  // 画面上的文字引导：必须始终告诉用户「站进虚线轮廓内」
  api.selectExercise('squat');
  const early = api.calibrationStep(frameOf(fit(sp({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0, view: 'front' }), { dx: 0.3 }), t3 + 10000), t3 + 10000);
  ok('校准阶段画面上出现文字提示条', elements.get('calibPrompt').hidden === false);
  ok('提示条第一行是「进入虚线轮廓内」',
    elements.get('calibPromptMain').textContent.includes('进入虚线轮廓'), elements.get('calibPromptMain').textContent);
  ok('提示条第二行给出还差什么', /左|右/.test(elements.get('calibPromptSub').textContent),
    elements.get('calibPromptSub').textContent);
  // 提示条走 t()，必须跟着语言切换
  api.changeLang('en');
  api.calibrationStep(frameOf(fit(sp({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0, view: 'front' }), { dx: 0.3 }), t3 + 10200), t3 + 10200);
  ok('提示条文案跟随语言切换（英文）',
    /dashed outline/i.test(elements.get('calibPromptMain').textContent),
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

  // 站好后就位：先进入「保持不动」，保持满 1.1 秒才算确认
  let t4 = t3 + 20000;
  let last = null;
  for (let i = 0; i < 20; i++) { last = api.calibrationStep(frameOf(idle, t4), t4); t4 += 33.4; }
  ok('就位后提示条变成「位置很好」',
    api.state.session === 'calibrating' && elements.get('calibPromptMain').textContent.includes('位置很好'),
    `session=${api.state.session} text=${elements.get('calibPromptMain').textContent}`);
  for (let i = 0; i < 60; i++) { last = api.calibrationStep(frameOf(idle, t4), t4); t4 += 33.4; }
  ok('校准确认后提示条给出开始训练的话',
    api.state.session === 'ready' && elements.get('calibPromptMain').textContent.includes('开始训练'),
    `session=${api.state.session} text=${elements.get('calibPromptMain').textContent}`);
  ok('就位后轮廓切到「已就位」配色', last.status === 'ready', last.status);
  ok('提示条的配色跟着状态切换',
    elements.get('calibPrompt').className.includes('ready'), elements.get('calibPrompt').className);

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
      for (let i = 0; i < 60; i++) { api.calibrationStep(frameOf(lyingFit(pose), tt), tt); tt += 33.4; }
      const failed = (api.state.calib?.checks || []).filter((c) => !c.ok).map((c) => c.id).join(',');
      ok(`${label}：摆好躺姿后能通过校准并进入可开始状态`,
        api.state.session === 'ready', `${api.state.session}/${failed}`);
      // 校准通过后必须能真正开始（camera.active 依赖真实视频流，这里用桩模拟）
      const savedStream = api.camera.stream;
      api.camera.stream = {};
      api.startSession();
      ok(`${label}：校准通过后点「开始训练」能进入倒计时`, api.state.session === 'countdown', api.state.session);
      api.stopSession('user');
      api.camera.stream = savedStream;
    }
    api.selectExercise('squat');
    api.toCalibration({ silent: true });
  }
}

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
