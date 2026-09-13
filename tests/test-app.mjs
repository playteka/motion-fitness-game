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
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); }
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
const ctxCounts = { stroke: 0, fill: 0, arc: 0, moveTo: 0, lineTo: 0, fillText: 0 };
const ctxStub = {
  clearRect() {}, beginPath() {}, closePath() {}, save() {}, restore() {}, setLineDash() {},
  arcTo() {},
  moveTo() { ctxCounts.moveTo += 1; },
  lineTo() { ctxCounts.lineTo += 1; },
  stroke() { ctxCounts.stroke += 1; },
  fill() { ctxCounts.fill += 1; },
  arc() { ctxCounts.arc += 1; },
  fillText() { ctxCounts.fillText += 1; },
  measureText: () => ({ width: 40 }),
};
const resetCtxCounts = () => { for (const k of Object.keys(ctxCounts)) ctxCounts[k] = 0; };
elements.get('overlay').getContext = () => ctxStub;

const created = [];
const documentStub = {
  documentElement: new El('html'),
  body: new El('body'),
  hidden: false,
  fullscreenElement: null,
  getElementById: (id) => {
    if (!elements.has(id)) elements.set(id, new El('div', id));
    return elements.get(id);
  },
  createElement: (tag) => { const el = new El(tag); created.push(el); return el; },
  querySelectorAll: (sel) => {
    const cls = sel.replace(/^\./, '');
    return created.filter((el) => (el.className || '').split(/\s+/).includes(cls));
  },
  querySelector: () => null,
  addEventListener() {},
};

const rafQueue = [];
const store = new Map();
const navigatorStub = {
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
  ok('深蹲：要领清单独立', squatSteps.includes('髋部向后向下坐'));
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

  // 未点“开始训练”时也要实时给反馈（这是用户明确要求的）
  const before = det.score;
  api.state.session = 'idle';
  const det2 = (() => { api.selectExercise('squat'); return api.state.detector; })();
  let t2 = t;
  for (let i = 0; i < 45; i++) {
    const lm = standingPose({ knee: 178, lean: 6, armDown: 0, ankleX: 1.0 });
    const sm = smoother.apply(lm.map((q) => ({ ...q, v: q.visibility })), t2 / 1000);
    const f = computeFrame(toMetric(sm, ASPECT), null, t2, false, null);
    api.handleEvents(api.feedDetector(f, t2));
    api.updateHud();
    t2 += 33.4;
  }
  ok('未点开始训练也能实时得分（站姿要领立刻给分）', det2.score > 0, `得分 ${det2.score}`);
  ok('未开始时要领清单同样会打勾', elements.get('stepList').innerHTML.includes('step-item done'));
  ok('要领清单下方给出“下一步该做什么”', elements.get('stepHint').textContent.includes('下一步'));
  ok('继续站着不会重复加分', (() => {
    const s = det2.score;
    for (let i = 0; i < 60; i++) {
      const lm = standingPose({ knee: 178, lean: 6, armDown: 0, ankleX: 1.0 });
      const sm = smoother.apply(lm.map((q) => ({ ...q, v: q.visibility })), t2 / 1000);
      const f = computeFrame(toMetric(sm, ASPECT), null, t2, false, null);
      api.feedDetector(f, t2);
      t2 += 33.4;
    }
    return det2.score === s;
  })());
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
}

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
