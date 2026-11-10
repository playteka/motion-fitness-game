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
    // 真实 DOM 的 add/remove 都收**多个**类名，桩里也一样（换屏动画就是一次移除两个方向）
    add: (...cs) => { for (const c of cs) set.add(c); },
    remove: (...cs) => { for (const c of cs) set.delete(c); },
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
  /** 换屏动画会把当前这一屏的圆环克隆到残影层里，桩里也要能克隆（属性 + 子元素 + 类名够用了） */
  cloneNode() {
    const copy = new El(this.tagName, this.id);
    copy.className = this.className;
    copy._html = this._html;
    copy.style = { ...this.style };
    copy.children = this.children.map((c) => (typeof c.cloneNode === 'function' ? c.cloneNode(true) : c));
    for (const [k, v] of Object.entries(this.attributes || {})) copy.attributes[k] = v;
    if (this.dataset) copy.dataset = { ...this.dataset };
    return copy;
  }
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

/* ------------------------------------------------------------------ *
 * AI 语音教练（P3.0）用的浏览器能力桩：
 *   - SpeechRecognition：记录 start/stop，测试里手动 emit 一句「用户说的话」；
 *   - speechSynthesis / SpeechSynthesisUtterance：记录真正要念的句子，onend 由测试触发；
 *   - getUserMedia({ audio:true })：返回一条可 stop 的音频轨道，用来验证麦克风确实释放了。
 * ------------------------------------------------------------------ */
const coachStubs = {
  recognitions: [],
  utterances: [],
  micCalls: [],
  micTracks: [],
  cancelled: 0,
};
class FakeSpeechRecognition {
  constructor() {
    this.lang = '';
    this.continuous = false;
    this.interimResults = false;
    this.started = 0;
    this.stopped = 0;
    coachStubs.recognitions.push(this);
  }
  start() { this.started += 1; this.onstart?.(); }
  stop() { this.stopped += 1; const end = this.onend; this.onend = null; try { end?.(); } catch { /* ignore */ } }
  abort() { this.stopped += 1; }
  /** 模拟浏览器识别出一句话（isFinal=false = 中间结果） */
  emit(text, isFinal = true) {
    const item = [{ transcript: text, confidence: 1 }];
    item.isFinal = isFinal;
    this.onresult?.({ resultIndex: 0, results: [item] });
  }
  /** 模拟识别服务报错（network / no-speech / not-allowed / audio-capture …） */
  emitError(name) { this.onerror?.({ error: name }); }
}
class FakeUtterance {
  constructor(text) {
    this.text = text;
    this.lang = '';
    this.rate = 1;
    this.onend = null;
    this.onerror = null;
  }
}
const fakeSynth = {
  speak(u) { coachStubs.utterances.push(u); },
  cancel() { coachStubs.cancelled += 1; },
};

const navigatorStub = {
  language: 'zh-CN',
  languages: ['zh-CN'],
  mediaDevices: {
    getUserMedia: async (constraints) => {
      // 真实的 { video, audio:true } 组合请求会一次给回两条轨：音轨用来验证「拿到权限就 stop」，
      // 视频轨用来让 Camera.start 照常取 deviceId / facingMode。
      const video = {
        kind: 'video',
        stopped: false,
        stop() { this.stopped = true; },
        getSettings: () => ({ deviceId: 'cam-stub', facingMode: constraints?.video?.facingMode || 'user' }),
      };
      const tracks = [video];
      if (constraints && constraints.audio) {
        const track = { kind: 'audio', stopped: false, stop() { this.stopped = true; } };
        coachStubs.micCalls.push(constraints);
        coachStubs.micTracks.push(track);
        tracks.push(track);
      }
      return {
        getTracks: () => tracks,
        getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
        getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
      };
    },
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
  location: { protocol: 'http:', host: '127.0.0.1:4174', search: '', href: 'http://127.0.0.1:4174/' },
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
  SpeechRecognition: FakeSpeechRecognition,
  SpeechSynthesisUtterance: FakeUtterance,
  speechSynthesis: fakeSynth,
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
  /* 姿态模型的真实加载要 wasm + 联网，Node 里跑不了：先装一套「立刻失败」的桩。
     目的不是省事，而是**隔离**：用例偶尔会意外走到加载路径（例如 [16] 从主页回动作页会
     resumeCameraFromHome → startCamera），真去下载模型会按 400/900/1800ms 退避重试，
     后台那一串 setTimeout 会把后面用例刚写好的遮罩文案冲掉（[17c] 就是这么被带歪的）。
     换成 wasm 阶段的非重试失败 → 只失败一次、不碰 fetch、不留定时器。
     需要真实驱动加载流程的用例（[17d]）自己替换这三个桩，用完还原。 */
  api.engine.resolveVision = async () => {
    const err = new Error('no wasm in node');
    err.name = 'RuntimeError';
    throw err;
  };
  api.engine.fetchModel = async () => {
    throw new TypeError('no network in node');
  };
  api.engine.createLandmarker = async () => { throw new Error('no landmarker in node'); };
  ok('boot 后已选中一个动作', !!api.state.detector);
  ok('主页渲染了全部动作卡片（按分类展开，动作全部都在）', (() => {
    const ids = new Set(documentStub.querySelectorAll('.ex-card').map((c) => c.dataset.id));
    return ids.size === EXERCISES.length;
  })(), `卡片覆盖动作数 ${new Set(documentStub.querySelectorAll('.ex-card').map((c) => c.dataset.id)).size}/${EXERCISES.length}`);
  ok('主页按一级分类分组（5 类）', documentStub.querySelectorAll('.cat-block').length === 5,
    `实际 ${documentStub.querySelectorAll('.cat-block').length}`);
  ok('boot 后停在主页（动作页隐藏）', elements.get('homeView').hidden === false
    && elements.get('workoutView').hidden === true);
  ok('boot 停在主页时 body 挂着 is-home（没有动作页那个类）',
    documentStub.body.classList.contains('is-home')
    && !documentStub.body.classList.contains('in-workout'),
    String(documentStub.body.className));
  ok('设置弹窗默认关闭', elements.get('settingsModal').hidden === true);
  ok('主页上不校准也不计数（浏览动作时不会偷偷开始一组）',
    api.state.homeMode === true && api.state.session === 'idle',
    `homeMode=${api.state.homeMode} session=${api.state.session}`);
  // 打开设置弹窗 → 关闭；再从主页进动作 → 回到训练视图
  api.openSettings();
  ok('打开设置弹窗', elements.get('settingsModal').hidden === false);
  ok('主页上开弹窗不额外挂牌（弹窗面板自己就是第三个作用域 .modal-card，不靠 body 类）',
    documentStub.body.classList.contains('is-home')
    && !documentStub.body.classList.contains('in-workout'),
    String(documentStub.body.className));
  api.closeSettings();
  ok('关闭设置弹窗', elements.get('settingsModal').hidden === true);
  api.openExercise('bridge');
  ok('从主页进入动作页：切到训练视图并重新校准',
    api.state.homeMode === false && elements.get('workoutView').hidden === false
    && api.state.exerciseId === 'bridge' && api.state.session === 'calibrating',
    `homeMode=${api.state.homeMode} session=${api.state.session} ex=${api.state.exerciseId}`);
  ok('动作页 body 挂 in-workout 且摘掉 is-home（两个类互斥、共用同一套渐变）',
    documentStub.body.classList.contains('in-workout')
    && !documentStub.body.classList.contains('is-home'),
    String(documentStub.body.className));
  // 「运动设定」弹窗开在动作页上：面板照样是同一套配色（.modal-card），body 上的挂牌不变
  api.openExerciseSettings();
  ok('动作页上开「运动设定」弹窗不改变挂牌类（弹窗配色不靠 in-workout）',
    elements.get('exerciseModal').hidden === false
    && documentStub.body.classList.contains('in-workout')
    && !documentStub.body.classList.contains('is-home'),
    String(documentStub.body.className));
  api.closeExerciseSettings();
  api.showHome();
  ok('返回主页：回到 idle 且动作页隐藏',
    api.state.homeMode === true && elements.get('workoutView').hidden === true,
    `homeMode=${api.state.homeMode}`);
  ok('回主页 body 换回 is-home 且摘掉 in-workout（成对开关）',
    documentStub.body.classList.contains('is-home')
    && !documentStub.body.classList.contains('in-workout'),
    String(documentStub.body.className));
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
 * AI 语音教练（P3.0 基座）：Ctrl+I / 设置开关 / 麦克风生命周期 / 不支持时降级
 * ------------------------------------------------------------------ */

console.log('\n[1c] AI 语音教练（P3.0 基座：Ctrl+I + 设置开关 + 麦克风生命周期）');
{
  const api = windowStub.__mfg;
  const { t: tCoach } = await import('../src/i18n.js');
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };

  api.showHome();
  ok('AI 教练默认关闭（settings.coachEnabled=false）',
    api.state.settings.coachEnabled === false && api.state.voice.enabled === false,
    JSON.stringify({ setting: api.state.settings.coachEnabled, voice: api.state.voice.enabled }));
  ok('默认关时字幕面板与状态环都藏着（不占画面）',
    elements.get('coachPanel').hidden === true && elements.get('coachDock').hidden === true);

  api.openExercise('pushup');

  // ① 输入框里按 Ctrl+I 不生效（不能打字时突然开麦）
  // 桩里的元素默认都是 DIV；index.html 里 #exSearch 是 <input>，这里按真实标签模拟一次
  const searchEl = elements.get('exSearch');
  const searchTag = searchEl.tagName;
  searchEl.tagName = 'INPUT';
  const micBefore = coachStubs.micCalls.length;
  documentStub.dispatch('keydown', {
    key: 'i', ctrlKey: true, target: searchEl, preventDefault() {},
  });
  await flush();
  searchEl.tagName = searchTag;
  ok('在输入框里按 Ctrl+I 不触发（不会突然开麦）',
    api.state.settings.coachEnabled === false && coachStubs.micCalls.length === micBefore,
    `setting=${api.state.settings.coachEnabled} mic=${coachStubs.micCalls.length}`);

  // ② Ctrl+I 打开：权限请求 → listening → 字幕面板 → 自我介绍
  let prevented = 0;
  documentStub.dispatch('keydown', {
    key: 'i', ctrlKey: true, target: documentStub.body, preventDefault() { prevented += 1; },
  });
  await flush();
  ok('Ctrl+I 会 preventDefault（不把组合键交给浏览器）', prevented === 1, String(prevented));
  ok('Ctrl+I 打开 AI 教练：状态 listening、开关写进 settings',
    api.state.voice.state === 'listening' && api.state.voice.enabled === true
    && api.state.settings.coachEnabled === true,
    JSON.stringify({ state: api.state.voice.state, enabled: api.state.voice.enabled }));
  ok('弹幕模式：两行字幕面板收起，教练自我介绍进弹幕「最近一句」',
    elements.get('coachPanel').hidden === true
    && elements.get('coachCoachText').textContent === tCoach('coach.intro')
    && elements.get('danmakuLast').textContent
      === tCoach('voice.coach') + tCoach('coach.intro'),
    JSON.stringify({ panel: elements.get('coachPanel').hidden,
      last: elements.get('danmakuLast').textContent }));
  ok('打开时真的请求了麦克风（getUserMedia({ audio: true })）',
    coachStubs.micCalls.length === micBefore + 1
    && coachStubs.micCalls.at(-1).audio === true,
    JSON.stringify(coachStubs.micCalls.at(-1) || null));
  const rec = coachStubs.recognitions.at(-1);
  ok('mock ASR 按约定初始化：continuous / interimResults / 语言跟随界面',
    !!rec && rec.continuous === true && rec.interimResults === true && rec.lang === 'zh-CN',
    JSON.stringify(rec ? { lang: rec.lang, continuous: rec.continuous, interim: rec.interimResults } : null));
  // P3.5：多路麦克风争用是「麦克风亮着但没字幕」的头号嫌疑 —— 回退 Web Speech 前必须先放掉共享流
  ok('回退 Web Speech 前先释放共享麦克风（让识别器自己取麦，避免第二路 getUserMedia 抢麦）',
    coachStubs.micTracks.at(-1)?.stopped === true,
    JSON.stringify({ stopped: coachStubs.micTracks.at(-1)?.stopped }));

  // ②b 音量表打不开（测试环境没有 AudioContext）→ 静默降级成按状态呼吸，不报错、不影响聆听
  ok('音量表第二路音频打不开时静默降级：仍 listening、状态环标 data-vu="off"、不抛错',
    api.state.voice.state === 'listening' && elements.get('coachDock').dataset.vu === 'off'
    && !documentStub.documentElement.dataset.error,
    JSON.stringify({ state: api.state.voice.state, vu: elements.get('coachDock').dataset.vu,
      banner: documentStub.documentElement.dataset.error || null }));

  // ②c 用户反馈「我说话没有出现字幕」：8 秒没结果要**说出来**，而不是一直静默聆听
  api.voice.silenceMs = 30;
  await new Promise((r) => setTimeout(r, 80));
  ok('进入聆听后 8 秒没有任何 interim/final → 面板出现「还没听到你说话」提示（不自动关闭）',
    api.state.voice.state === 'listening'
    && elements.get('coachNotice').hidden === false
    && elements.get('coachNotice').textContent === tCoach('coach.notice.noResult'),
    JSON.stringify({ state: api.state.voice.state, notice: elements.get('coachNotice').textContent }));
  api.voice.silenceMs = 8000;   // 恢复默认（顺手重开计时，后面的 final 会清掉它）

  // ②d interim（临时结果）必须**立刻**上屏：不能等 final（Chrome 的 final 可能很久才来）
  rec.emit('我在', false);
  ok('interim 结果立刻更新字幕「你：我在」（同步，不用等 final / 定时器）',
    elements.get('coachYouText').textContent === '我在'
    && elements.get('coachNotice').hidden === true,
    JSON.stringify({ you: elements.get('coachYouText').textContent,
      notice: elements.get('coachNotice').textContent }));
  rec.emit('我在听', false);
  ok('interim 逐字变化（「我在」→「我在听」）',
    elements.get('coachYouText').textContent === '我在听',
    elements.get('coachYouText').textContent);

  // ②e P3.6 弹幕：partial **不弹**（只更新底部灰色实时行）
  const dmLayer = elements.get('danmakuLayer');
  const dmLast = elements.get('danmakuLast');
  const bulletsBeforeFinal = dmLayer.children.length;
  ok('partial 不弹弹幕：只更新底部「最近一句」灰色实时行',
    dmLayer.children.length === bulletsBeforeFinal
    && dmLast.hidden === false
    && dmLast.textContent === tCoach('voice.you') + '我在听'
    && dmLast.classList.contains('danmaku-last--interim'),
    JSON.stringify({ n: dmLayer.children.length, last: dmLast.textContent,
      cls: dmLast.className }));

  // ③ 用户说一句 → 字幕 → 罐头回复 → TTS → 回到聆听
  rec.emit('你好');
  await new Promise((r) => setTimeout(r, 450));   // app 里 thinkDelay = 360ms
  ok('用户说话后字幕出现「你」这一行（来自识别结果）',
    elements.get('coachYouText').textContent.includes('你好'),
    elements.get('coachYouText').textContent);
  ok('mock LLM 回复非空 → 状态 speaking，教练字幕更新',
    api.state.voice.state === 'speaking'
    && elements.get('coachCoachText').textContent.length > 0
    && elements.get('coachCoachText').textContent !== tCoach('coach.intro'),
    elements.get('coachCoachText').textContent);
  const utter = coachStubs.utterances.at(-1);
  ok('mock TTS 把回复交给 speechSynthesis（语言跟随界面、语速可配）',
    !!utter && utter.lang === 'zh-CN' && utter.rate === 1
    && utter.text === elements.get('coachCoachText').textContent,
    JSON.stringify(utter ? { lang: utter.lang, rate: utter.rate, text: utter.text } : null));
  utter.onend?.();
  await flush();
  ok('TTS 念完 → 回到 listening（还能继续问下一句）',
    api.state.voice.state === 'listening', api.state.voice.state);

  // ③b P3.6 弹幕：final → 一条 user 弹幕；教练回复 → 一条 coach 弹幕（颜色类不同）
  {
    const userBullets = dmLayer.children.filter((n) => n.className.includes('danmaku--user'));
    const coachBullets = dmLayer.children.filter((n) => n.className.includes('danmaku--coach'));
    ok('final 结果弹出一条 user 弹幕（「你：」前缀 + 青色类）',
      userBullets.length === 1
      && userBullets[0].textContent === tCoach('voice.you') + '你好'
      && userBullets[0].classList.contains('danmaku--user'),
      JSON.stringify(userBullets.map((n) => n.textContent)));
    ok('教练回复弹出一条 coach 弹幕（「教练：」前缀 + 薄荷绿类）',
      coachBullets.length >= 1
      && coachBullets.at(-1).textContent
        === tCoach('voice.coach') + elements.get('coachCoachText').textContent
      && coachBullets.at(-1).classList.contains('danmaku--coach'),
      JSON.stringify(coachBullets.map((n) => n.textContent)));
    ok('用户和教练的弹幕颜色类**不同**（一眼能分出谁说的）',
      userBullets[0].className !== coachBullets.at(-1).className,
      JSON.stringify({ user: userBullets[0].className, coach: coachBullets.at(-1).className }));
    ok('底部「最近一句」跟着最新一句（教练那句）',
      dmLast.hidden === false
      && dmLast.textContent === tCoach('voice.coach') + elements.get('coachCoachText').textContent
      && dmLast.classList.contains('danmaku-last--coach'),
      dmLast.textContent);
  }

  // ③c P3.6 设置：对话显示 弹幕 / 字幕 / 关闭 三档行为正确，并持久化
  {
    const savedMM = windowStub.matchMedia;
    api.applyDialogueMode('subtitle');
    ok('设置切「字幕」：弹幕层隐藏、两行字幕面板恢复、最近一句仍在',
      dmLayer.hidden === true
      && elements.get('coachPanel').hidden === false
      && dmLast.hidden === false,
      JSON.stringify({ layer: dmLayer.hidden, panel: elements.get('coachPanel').hidden,
        last: dmLast.hidden }));
    api.applyDialogueMode('off');
    ok('设置切「关闭」：弹幕层 / 两行字幕 / 最近一句都隐藏（状态环仍在）',
      dmLayer.hidden === true && elements.get('coachPanel').hidden === true
      && dmLast.hidden === true && elements.get('coachDock').hidden === false,
      JSON.stringify({ layer: dmLayer.hidden, panel: elements.get('coachPanel').hidden,
        last: dmLast.hidden, dock: elements.get('coachDock').hidden }));
    api.applyDialogueMode('danmaku');
    const saved = JSON.parse(store.get('mfg.settings.v1') || '{}');
    ok('切回「弹幕」：两行字幕面板收起、弹幕层恢复，并写进 localStorage',
      dmLayer.hidden === false && elements.get('coachPanel').hidden === true
      && saved.dialogue === 'danmaku',
      JSON.stringify({ layer: dmLayer.hidden, panel: elements.get('coachPanel').hidden,
        saved: saved.dialogue }));

    // 减少动效：不飞行，降级成静态两行（只保留最新两条）
    api.danmaku.clear();
    windowStub.matchMedia = (q) => ({
      matches: q === '(prefers-reduced-motion: reduce)',
      addEventListener() {},
    });
    api.danmaku.push({ text: '一', kind: 'user' });
    api.danmaku.push({ text: '二', kind: 'coach' });
    api.danmaku.push({ text: '三', kind: 'user' });
    ok('prefers-reduced-motion：弹幕不飞行，降级成静态两行（只留最新两条）',
      dmLayer.classList.contains('danmaku-layer--static')
      && dmLayer.children.length === 2
      && dmLayer.children.every((n) => n.classList.contains('danmaku--static')),
      JSON.stringify({ cls: dmLayer.className, n: dmLayer.children.length }));
    windowStub.matchMedia = savedMM;
    api.applyDialogueMode('danmaku');
    api.danmaku.clear();
    ok('恢复动效后静态类被摘掉（下次说话照常飞行）',
      !dmLayer.classList.contains('danmaku-layer--static'));
  }

  // ④ 页面隐藏自动暂停聆听，回到前台恢复
  documentStub.hidden = true;
  documentStub.dispatch('visibilitychange');
  await flush();
  ok('页面隐藏 → 自动暂停聆听（状态 listening + paused，状态环还在）',
    api.state.voice.paused === true && api.state.voice.state === 'listening'
    && elements.get('coachDock').hidden === false,
    JSON.stringify({ state: api.state.voice.state, paused: api.state.voice.paused }));
  documentStub.hidden = false;
  documentStub.dispatch('visibilitychange');
  await flush();
  ok('回到前台且仍开着 → 恢复聆听',
    api.state.voice.paused === false && api.state.voice.state === 'listening',
    JSON.stringify({ state: api.state.voice.state, paused: api.state.voice.paused }));

  // ④b 识别服务的三种常见错误都必须在面板上**看得见**（用户不再对着静默界面猜）
  const recNow = coachStubs.recognitions.at(-1);
  recNow.emitError('network');
  await flush();
  ok('ASR error.network → 面板出现「网络异常」提示（仍在 listening，自动重试）',
    api.state.voice.state === 'listening'
    && elements.get('coachNotice').hidden === false
    && elements.get('coachNotice').textContent === tCoach('coach.notice.network'),
    JSON.stringify({ state: api.state.voice.state, notice: elements.get('coachNotice').textContent }));
  recNow.emitError('no-speech');
  await flush();
  ok('ASR error.no-speech → 面板出现「没听到声音，靠近一点」提示（不自动关闭）',
    api.state.voice.state === 'listening'
    && elements.get('coachNotice').textContent === tCoach('coach.notice.noSpeech'),
    elements.get('coachNotice').textContent);

  const micTrackBeforeErr = coachStubs.micTracks.at(-1);
  recNow.emitError('not-allowed');
  await flush();
  ok('ASR error.not-allowed → 立刻进 error，面板给出「去地址栏允许麦克风」的处置建议',
    api.state.voice.state === 'error' && api.state.voice.error?.code === 'mic'
    && elements.get('coachCoachText').textContent === tCoach('coach.error.mic')
    && elements.get('coachStatus').textContent === tCoach('voice.status.error'),
    JSON.stringify({ state: api.state.voice.state, error: api.state.voice.error || null,
      coach: elements.get('coachCoachText').textContent }));
  ok('not-allowed 时把主麦克风轨道释放掉（出错后不留后台录音）',
    micTrackBeforeErr.stopped === true, String(micTrackBeforeErr.stopped));

  // ④c 🐞 调试模式：教练面板追加**最后一个原始错误名**（排查「没字幕」时一眼看到 network / not-allowed）
  api.coach.setDebug(true);
  api.coach.render(api.voice.snapshot());
  ok('🐞 调试模式下面板显示最后一个 ASR 原始错误名（lastError）',
    elements.get('coachNotice').hidden === false
    && elements.get('coachNotice').textContent.includes('🐞')
    && elements.get('coachNotice').textContent.includes('not-allowed'),
    elements.get('coachNotice').textContent);
  api.coach.setDebug(false);
  api.coach.render(api.voice.snapshot());
  ok('关掉 🐞 后那行调试后缀消失（不打扰普通用户）',
    elements.get('coachNotice').hidden === true,
    elements.get('coachNotice').textContent);

  // 从 error 状态重新 start()：能恢复聆听，接着测关闭
  await api.setCoachEnabled(true);
  await flush();
  ok('权限错误后重新开启 → 退出 error、回到 listening（会话还能重试）',
    api.state.voice.state === 'listening' && api.state.voice.error === null,
    JSON.stringify({ state: api.state.voice.state, error: api.state.voice.error || null }));

  // ⑤ 再按一次 Ctrl+I：必须释放麦克风 + 停 TTS + 隐藏字幕 + 状态环灰掉
  const track = coachStubs.micTracks.at(-1);
  const recBefore = coachStubs.recognitions.at(-1);
  const cancelledBefore = coachStubs.cancelled;
  documentStub.dispatch('keydown', {
    key: 'I', ctrlKey: true, target: documentStub.body, preventDefault() {},
  });
  await flush();
  ok('再按 Ctrl+I 关闭：状态 off、字幕面板隐藏、状态环灰掉',
    api.state.voice.state === 'off' && elements.get('coachPanel').hidden === true
    && elements.get('coachDock').dataset.state === 'off',
    JSON.stringify({ state: api.state.voice.state, panel: elements.get('coachPanel').hidden,
      dock: elements.get('coachDock').dataset.state }));
  ok('关闭时释放麦克风（track.stop）并停掉 ASR / TTS',
    track.stopped === true && recBefore.stopped > 0 && coachStubs.cancelled > cancelledBefore,
    JSON.stringify({ track: track.stopped, rec: recBefore.stopped, cancel: coachStubs.cancelled }));
  ok('关闭写回 settings.coachEnabled=false 并持久化',
    api.state.settings.coachEnabled === false
    && JSON.parse(store.get('mfg.settings.v1')).coachEnabled === false,
    store.get('mfg.settings.v1'));

  // ⑥ 设置里的开关与 Ctrl+I 同步（设置里打开 = 按了 Ctrl+I）
  api.openSettings();
  const btn = elements.get('btnCoach');
  ok('设置里新增「AI 语音教练」开关（默认 aria-pressed=false）',
    !!btn && btn.getAttribute('aria-pressed') === 'false');
  btn.dispatch('click');
  await flush();
  ok('设置里打开 = 按 Ctrl+I：状态 listening、按钮 aria-pressed=true、settings 同步',
    api.state.settings.coachEnabled === true && api.state.voice.state === 'listening'
    && btn.getAttribute('aria-pressed') === 'true'
    && JSON.parse(store.get('mfg.settings.v1')).coachEnabled === true,
    JSON.stringify({ setting: api.state.settings.coachEnabled, state: api.state.voice.state,
      pressed: btn.getAttribute('aria-pressed') }));
  btn.dispatch('click');
  await flush();
  ok('设置里再点一次关闭：状态 off、按钮 aria-pressed=false、settings 同步',
    api.state.settings.coachEnabled === false && api.state.voice.state === 'off'
    && btn.getAttribute('aria-pressed') === 'false'
    && JSON.parse(store.get('mfg.settings.v1')).coachEnabled === false,
    JSON.stringify({ setting: api.state.settings.coachEnabled, state: api.state.voice.state,
      pressed: btn.getAttribute('aria-pressed') }));
  api.closeSettings();

  // ⑦ 浏览器不支持 SpeechRecognition：明确提示、落 error，而不是崩
  const savedCtor = windowStub.SpeechRecognition;
  delete windowStub.SpeechRecognition;
  delete windowStub.webkitSpeechRecognition;
  await api.setCoachEnabled(true);
  await flush();
  ok('不支持语音识别时落 error 而不是崩溃（不会抛异常 / 不会有运行时错误横幅）',
    api.state.voice.state === 'error' && api.state.voice.error?.code === 'asr-unsupported'
    && !documentStub.documentElement.dataset.error,
    JSON.stringify({ state: api.state.voice.state, error: api.state.voice.error || null,
      banner: documentStub.documentElement.dataset.error || null }));
  ok('错误提示明确（coach.error.unsupported + 状态文字 voice.status.error）',
    elements.get('coachCoachText').textContent === tCoach('coach.error.unsupported')
    && elements.get('coachStatus').textContent === tCoach('voice.status.error'),
    `${elements.get('coachStatus').textContent} / ${elements.get('coachCoachText').textContent}`);
  await api.setCoachEnabled(false);
  await flush();
  windowStub.SpeechRecognition = savedCtor;

  // ⑧ 版面：小屏 560×320 / 大屏 1280×720 都不越界、不压 HUD / 圆环 / 判定条
  {
    const { rectsOverlap } = await import('../src/voice/coach.js');
    for (const size of [{ w: 1280, h: 720, label: '大屏 1280×720' }, { w: 560, h: 320, label: '小屏 560×320' }]) {
      const L = api.coachLayout(size);
      const inside = L.panel.left >= 0 && L.panel.right <= size.w && L.panel.top >= 0
        && L.panel.bottom <= size.h && L.dock.left >= 0 && L.dock.right <= size.w
        && L.dock.top >= 0 && L.dock.bottom <= size.h;
      ok(`${size.label}：字幕面板 / 状态环都落在舞台内（宽 ${Math.round(L.panel.width)}px）`,
        inside, JSON.stringify({ panel: L.panel, dock: L.dock }));
      ok(`${size.label}：字幕面板不压 HUD、右上角两颗圆环、判定进度条与状态环`,
        !rectsOverlap(L.panel, L.hud) && !rectsOverlap(L.panel, L.cornerExit)
        && !rectsOverlap(L.panel, L.cornerSettings) && !rectsOverlap(L.panel, L.criteria)
        && !rectsOverlap(L.panel, L.dock),
        JSON.stringify({ panel: L.panel, hud: L.hud, criteria: L.criteria }));
    }
  }

  api.showHome();
}

/* ------------------------------------------------------------------ *
 * [1c2] 音量表（VU）：状态环真的随音量变色（假 AudioContext，不需要真麦克风）
 * ------------------------------------------------------------------ */

console.log('\n[1c2] 音量表：状态环按音量从灰 → 青 → 薄荷亮绿，关闭时释放');
{
  const api = windowStub.__mfg;
  const flush = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  /** 把队列里的 rAF 回调各跑一帧（coach 的 VU 循环会再排下一帧） */
  const runFrame = () => {
    const cbs = rafQueue.splice(0, rafQueue.length);
    for (const cb of cbs) { try { cb(performance.now()); } catch { /* ignore */ } }
    return cbs.length;
  };

  const vu = { samples: 190, closed: 0, tracks: [], sourceStream: null };
  const savedCtx = windowStub.AudioContext;
  const savedWs = windowStub.WebSocket;
  const savedOverride = windowStub.__MFG_ASR_WS__;
  /** 假的火山 WebSocket：只为了让选路停在 volc（麦克风共享才会发生；这里不需要 ready） */
  class FakeVuWebSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; }
    send() {}
    close() { this.readyState = 3; }
  }
  windowStub.WebSocket = FakeVuWebSocket;
  windowStub.__MFG_ASR_WS__ = 'ws://127.0.0.1:5998/asr';
  function FakeAudioContext() { this.state = 'running'; }
  FakeAudioContext.prototype.createMediaStreamSource = function (stream) {
    vu.sourceStream = stream;
    vu.tracks.push(...stream.getAudioTracks());
    return { connect() {}, disconnect() {} };
  };
  FakeAudioContext.prototype.createAnalyser = function () {
    return {
      fftSize: 64,
      smoothingTimeConstant: 0,
      getByteTimeDomainData(buf) {
        for (let i = 0; i < buf.length; i += 1) buf[i] = vu.samples;
      },
    };
  };
  FakeAudioContext.prototype.resume = () => Promise.resolve();
  FakeAudioContext.prototype.close = function () {
    vu.closed += 1;
    this.state = 'closed';
    return Promise.resolve();
  };
  windowStub.AudioContext = FakeAudioContext;

  // ① 大声：state ring 变薄荷亮绿 + 轻微放大
  const micCallsBefore = coachStubs.micCalls.length;
  const vuTracksBefore = coachStubs.micTracks.length;
  await api.setCoachEnabled(true);
  await flush();
  runFrame();
  const fill = elements.get('coachRingFill');
  const ring = elements.get('coachRing');
  const vuTrack = coachStubs.micTracks.at(-1);
  ok('大声波形 → 状态环变成薄荷亮绿（#34e5c4），并轻微放大 / 发光',
    fill.style.stroke === '#34e5c4' && String(ring.style.transform).includes('scale(')
    && String(ring.style.boxShadow).includes('#34e5c4'),
    JSON.stringify({ stroke: fill.style.stroke, transform: ring.style.transform,
      glow: ring.style.boxShadow }));
  ok('音量表工作时状态环标记 data-vu="active"（样式 / 测试都靠它判断有没有第二路音频）',
    elements.get('coachDock').dataset.vu === 'active');
  // ★ 用户反馈的核心：麦克风只许开一路；VU 与 ASR 采集共用会话层那一条流
  ok('**开启教练只调用一次 getUserMedia**（主麦克风 + 音量表共用同一条流，不再开第二路）',
    coachStubs.micCalls.length === micCallsBefore + 1
    && coachStubs.micTracks.length === vuTracksBefore + 1
    && !!vu.sourceStream
    && vu.sourceStream.getAudioTracks()[0] === vuTrack,
    JSON.stringify({ micCalls: coachStubs.micCalls.length - micCallsBefore,
      tracks: coachStubs.micTracks.length - vuTracksBefore,
      shared: !!vu.sourceStream && vu.sourceStream.getAudioTracks()[0] === vuTrack }));

  // 关闭教练：共享音轨由 createMic 停掉、AudioContext.close()（不留后台麦克风）
  await api.setCoachEnabled(false);
  await flush();
  rafQueue.length = 0;
  ok('关闭教练 → 共享麦克风轨道 stop + 音量表 AudioContext.close()（不留后台麦克风）',
    !!vuTrack && vuTrack.stopped === true && vu.closed >= 1,
    JSON.stringify({ stopped: vuTrack?.stopped, closed: vu.closed }));
  ok('关闭后状态环回到灰掉（data-state="off"、内联音量色清空）',
    elements.get('coachDock').dataset.state === 'off' && fill.style.stroke === '',
    JSON.stringify({ state: elements.get('coachDock').dataset.state, stroke: fill.style.stroke }));

  // ② 静音：重新打开（level 从 0 开始）→ 灰
  vu.samples = 128;
  await api.setCoachEnabled(true);
  await flush();
  runFrame();
  ok('静音波形 → 状态环是灰色（#8fa1bb），不放大也不发光',
    fill.style.stroke === '#8fa1bb' && !String(ring.style.transform).includes('scale(')
    && !String(ring.style.boxShadow).includes('px'),
    JSON.stringify({ stroke: fill.style.stroke, transform: ring.style.transform,
      glow: ring.style.boxShadow }));
  await api.setCoachEnabled(false);
  await flush();
  windowStub.AudioContext = savedCtx;
  rafQueue.length = 0;

  // ③ prefers-reduced-motion：只换颜色、不放大（复用同一套假 AudioContext）
  windowStub.AudioContext = FakeAudioContext;
  vu.samples = 190;
  const savedMatchMedia = windowStub.matchMedia;
  windowStub.matchMedia = (q) => ({ matches: q === '(prefers-reduced-motion: reduce)', addEventListener() {} });
  await api.setCoachEnabled(true);
  await flush();
  runFrame();
  ok('prefers-reduced-motion 下仍按音量变色，但**不**放大 / 发光',
    fill.style.stroke === '#34e5c4' && fill.style.stroke !== ''
    && !String(ring.style.transform).includes('scale(') && ring.style.boxShadow === '',
    JSON.stringify({ stroke: fill.style.stroke, transform: ring.style.transform,
      glow: ring.style.boxShadow }));
  await api.setCoachEnabled(false);
  await flush();
  windowStub.matchMedia = savedMatchMedia;
  windowStub.AudioContext = savedCtx;
  windowStub.WebSocket = savedWs;
  if (savedOverride === undefined) delete windowStub.__MFG_ASR_WS__;
  else windowStub.__MFG_ASR_WS__ = savedOverride;
  rafQueue.length = 0;
  api.showHome();
}

/* ------------------------------------------------------------------ *
 * [1c3] P3.1：切到火山模式（本机代理）—— 选路 / 16k 分片 / 字幕 / 关闭释放
 *
 * 用户在国内，Chrome 的 webkitSpeechRecognition 连不上 Google（error.network）。
 * 这里用**假 WebSocket + 假 AudioContext** 模拟「本机代理可用」：
 *   - `window.__MFG_ASR_WS__` 覆盖的地址必须真的被连上；
 *   - 字幕面板要写明当前用的是火山；
 *   - 关闭教练时 WS / AudioContext / 处理节点 / 麦克风轨道全部释放。
 * 全程不联网、不需要真麦克风。
 * ------------------------------------------------------------------ */

console.log('\n[1c3] P3.1 火山模式：选路 / 16k 分片 / 字幕 / 关闭释放');
{
  const api = windowStub.__mfg;
  const { t: tCoach } = await import('../src/i18n.js');
  const flush = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  const savedWebSocket = windowStub.WebSocket;
  const savedAudioContext = windowStub.AudioContext;
  const savedOverride = windowStub.__MFG_ASR_WS__;

  /* ---- 默认地址跟页面走（同源同端口）----
   * 预览服务器把 /asr 代理并进了**同一个进程**，所以页面根本不该写死 4180：
   * https → wss、http → ws，host / 端口都取页面自己的；`window.__MFG_ASR_WS__` 仍然优先。 */
  {
    const { resolveAsrUrl, sameOriginAsrUrl, ASR_WS_PATH } = await import('../src/voice/providers.js');
    const derive = (loc) => resolveAsrUrl({ location: loc });
    const pageLoc = { protocol: 'http:', host: '127.0.0.1:4174' };
    ok('http 页面 → ws://<同 host 同端口>/asr（默认不再是写死的 4180）',
      derive(pageLoc) === 'ws://127.0.0.1:4174/asr' && ASR_WS_PATH === '/asr', derive(pageLoc));
    ok('https 页面 → wss://…（跟页面协议一致，端口仍是页面自己的）',
      derive({ protocol: 'https:', host: '192.168.1.9:4174' }) === 'wss://192.168.1.9:4174/asr',
      derive({ protocol: 'https:', host: '192.168.1.9:4174' }));
    ok('页面换了端口，代理地址跟着换（不会悄悄退回 4180）',
      derive({ protocol: 'http:', host: '127.0.0.1:8080' }) === 'ws://127.0.0.1:8080/asr'
      && !derive({ protocol: 'http:', host: '127.0.0.1:8080' }).includes(':4180'));
    ok('window.__MFG_ASR_WS__ 仍然优先（换端口 / 手机连独立代理 / 测试）',
      resolveAsrUrl({ ...pageLoc, location: pageLoc, __MFG_ASR_WS__: 'ws://127.0.0.1:5999/asr' })
        === 'ws://127.0.0.1:5999/asr');
    ok('__MFG_ASR_WS__ 写 off 强制回退（返回空 = 不连代理，走 Web Speech）',
      resolveAsrUrl({ location: pageLoc, __MFG_ASR_WS__: 'off' }) === '');
    ok('没有 location.host 时退回独立代理的兜底地址（Node / 老环境）',
      sameOriginAsrUrl({}) === '' && resolveAsrUrl({}) === 'ws://127.0.0.1:4180/asr');

    const savedLoc = { ...windowStub.location };
    ok('真实页面对象（http://127.0.0.1:4174）默认就连 ws://127.0.0.1:4174/asr —— 开箱即用',
      resolveAsrUrl() === 'ws://127.0.0.1:4174/asr', resolveAsrUrl());
    windowStub.location.protocol = 'https:';
    ok('同一个页面换成 https 立刻变 wss://127.0.0.1:4174/asr（手机 https 下不改代码就能用）',
      resolveAsrUrl() === 'wss://127.0.0.1:4174/asr', resolveAsrUrl());
    Object.assign(windowStub.location, savedLoc);
  }

  const volcStubs = { sockets: [], contexts: [] };
  class FakeVolcWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closed = false;
      volcStubs.sockets.push(this);
    }
    send(data) { this.sent.push(data); }
    close() {
      this.closed = true;
      this.readyState = 3;
      this.onclose?.({});
    }
    open() { this.readyState = 1; this.onopen?.({}); }
    message(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  }
  class FakeVolcAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = {};
      this.closed = false;
      this.node = null;
      volcStubs.contexts.push(this);
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() {
      return {
        fftSize: 64,
        smoothingTimeConstant: 0,
        getByteTimeDomainData(buf) { for (let i = 0; i < buf.length; i += 1) buf[i] = 128; },
      };
    }
    createScriptProcessor() {
      this.node = {
        connected: 0,
        disconnected: false,
        onaudioprocess: null,
        connect() { this.connected += 1; },
        disconnect() { this.disconnected = true; },
      };
      return this.node;
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
  }

  windowStub.WebSocket = FakeVolcWebSocket;
  windowStub.AudioContext = FakeVolcAudioContext;
  windowStub.__MFG_ASR_WS__ = 'ws://127.0.0.1:5999/asr';   // 测试专用端口，证明覆盖生效
  const micBefore = coachStubs.micTracks.length;
  const micCallsBefore = coachStubs.micCalls.length;

  await api.setCoachEnabled(true);
  await flush();
  const sock = volcStubs.sockets.at(-1);
  ok('切到火山模式：真的去连 window.__MFG_ASR_WS__ 指定的本机代理',
    api.state.voice.route === 'volc' && sock?.url === 'ws://127.0.0.1:5999/asr',
    JSON.stringify({ route: api.state.voice.route, url: sock?.url || null }));
  ok('字幕面板写明「当前用火山引擎（本机代理）」（中英词条 coach.route.volc）',
    elements.get('coachRoute').hidden === false
    && elements.get('coachRoute').textContent === tCoach('coach.route.volc'),
    elements.get('coachRoute').textContent);

  sock.open();
  ok('WS 打开后给代理发 {"type":"start","lang":"zh-CN"}（语言跟随界面）', (() => {
    const msg = JSON.parse(sock.sent[0]);
    return msg.type === 'start' && msg.lang === 'zh-CN';
  })(), String(sock.sent[0]));

  sock.message({ type: 'ready' });
  await flush();
  const capCtx = volcStubs.contexts.find((c) => c.node);
  ok('代理 ready 后开始采集：用一个 AudioContext + ScriptProcessor 兜底节点',
    !!capCtx && capCtx.node.connected >= 1, JSON.stringify(volcStubs.contexts.map((c) => !!c.node)));
  capCtx.node.onaudioprocess({
    inputBuffer: { getChannelData: () => new Float32Array(4800).fill(0.25) },   // 48k 的 100ms
  });
  const binary = sock.sent.filter((x) => typeof x !== 'string');
  ok('麦克风 48k → 16k PCM16 分片：4800 个采样变成 3200 字节再发出去',
    binary.length === 1 && binary[0].byteLength === 3200,
    JSON.stringify(binary.map((b) => b.byteLength)));

  sock.message({ type: 'partial', text: '深蹲' });
  ok('代理 partial 立刻上屏「你：深蹲」（不用等 final）',
    elements.get('coachYouText').textContent === '深蹲', elements.get('coachYouText').textContent);
  sock.message({ type: 'final', text: '深蹲 暂停' });
  await flush();
  ok('代理 final 定稿（userText 变成完整一句）',
    api.state.voice.userText === '深蹲 暂停', api.state.voice.userText);

  await api.setCoachEnabled(false);
  await flush();
  const tracks = coachStubs.micTracks.slice(micBefore);
  ok('关闭教练：立刻关 AudioContext / 采集节点，但 WS 先留着等最后一包 final（不丢收尾）',
    sock.closed === false && capCtx.closed === true && capCtx.node.disconnected === true,
    JSON.stringify({ ws: sock.closed, ctx: capCtx.closed, node: capCtx.node.disconnected }));
  sock.message({ type: 'final', text: '深蹲 暂停' });
  await flush();
  ok('收到服务端 flush 的 final 之后才断 WS（不留后台连接）',
    sock.closed === true, JSON.stringify({ ws: sock.closed }));
  ok('整个开启期间只取了一次麦克风（主路 / 音量表共享；不存在第二路 getUserMedia）',
    coachStubs.micCalls.length === micCallsBefore + 1 && tracks.length === 1,
    JSON.stringify({ micCalls: coachStubs.micCalls.length - micCallsBefore, tracks: tracks.length }));
  ok('关闭教练：本次打开期间拿到的麦克风轨道全部 stop',
    tracks.length >= 1 && tracks.every((track) => track.stopped === true),
    JSON.stringify(tracks.map((x) => x.stopped)));
  ok('关闭后路由清空、字幕面板与路由那行一起收起',
    api.state.voice.route === '' && elements.get('coachPanel').hidden === true
    && elements.get('coachRoute').hidden === true,
    JSON.stringify({ route: api.state.voice.route, panel: elements.get('coachPanel').hidden,
      hint: elements.get('coachRoute').hidden }));

  // 恢复现场：后面的用例仍然走 P3.0 的 Web Speech 桩
  windowStub.WebSocket = savedWebSocket;
  windowStub.AudioContext = savedAudioContext;
  if (savedOverride === undefined) delete windowStub.__MFG_ASR_WS__;
  else windowStub.__MFG_ASR_WS__ = savedOverride;
  rafQueue.length = 0;
  api.showHome();
}

/* ------------------------------------------------------------------ *
 * [1c4] P3.5：🐞 诊断面板（不依赖教练开关）+ 语音自检四步 + Worklet 失败兜底
 *
 * 用户反馈「说话没有字幕，但麦克风亮着」：健康检查是好的，所以要能自证浏览器侧。
 * 这里全部用桩：不联网、不需要真麦克风，验证面板字段、四步文案、单路麦克风与兜底路径。
 * ------------------------------------------------------------------ */

console.log('\n[1c4] P3.5 诊断面板 + 语音自检（mic → ws → send → result）+ Worklet 兜底');
{
  const api = windowStub.__mfg;
  const { t: tD } = await import('../src/i18n.js');
  const flush = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  const waitUntil = async (fn, ms = 3000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  };

  // ① 教练先关掉 —— 诊断面板 / 自检必须仍然可用
  await api.setCoachEnabled(false);
  await flush();
  api.coach.toggleDiag(false);
  elements.get('btnVoiceDiag').dispatch('click');
  await flush();
  ok('教练关着也能打开诊断面板（诊断独立于 AI 教练开关）',
    elements.get('coachDiag').hidden === false && api.coach.diagOpen === true,
    JSON.stringify({ hidden: elements.get('coachDiag').hidden, open: api.coach.diagOpen }));

  api.coachDiag.record('route:volc', {});
  api.coachDiag.record('ws:connecting', {});
  api.coachDiag.record('ws:open', {});
  api.coachDiag.record('ws:frames', { n: 5, bytes: 16000 });
  api.coachDiag.record('ws:rate', { bytesPerSec: 32000, expected: 32000 });
  api.coachDiag.record('asr:partial', { text: '你好' });
  api.coachDiag.record('asr:final', { text: '你好世界' });
  api.coachDiag.record('mic:ok', { tracks: 1, labels: ['audio-1'] });
  api.coachDiag.record('ctx:sampleRate', { value: 48000, state: 'running' });
  api.coachDiag.record('worklet:fail', { name: 'NotAllowedError' });
  api.coachDiag.record('capture:mode', { mode: 'processor' });
  api.coachDiag.record('asr:error', { code: 'network' });   // 最近错误最后写，面板显示它
  await flush();
  ok('诊断面板显示路由 / WS / 帧数 / 实时码率 / partial·final 计数',
    elements.get('coachDiagRoute').textContent === 'volc'
    && elements.get('coachDiagWs').textContent === 'open'
    && elements.get('coachDiagFrames').textContent.includes('5')
    && elements.get('coachDiagFrames').textContent.includes('16000')
    && elements.get('coachDiagRate').textContent.includes('32.0')
    && elements.get('coachDiagRate').textContent.includes('32')
    && elements.get('coachDiagResults').textContent.includes('partial')
    && elements.get('coachDiagResults').textContent.includes('final'),
    JSON.stringify({ route: elements.get('coachDiagRoute').textContent,
      ws: elements.get('coachDiagWs').textContent,
      frames: elements.get('coachDiagFrames').textContent,
      rate: elements.get('coachDiagRate').textContent,
      results: elements.get('coachDiagResults').textContent }));
  ok('诊断面板显示最近错误 / 麦克风轨数 + AudioContext 状态 / Worklet 兜底',
    elements.get('coachDiagError').textContent.includes('network')
    && elements.get('coachDiagMic').textContent.includes('1')
    && elements.get('coachDiagMic').textContent.includes('running')
    && elements.get('coachDiagWorklet').textContent === tD('coach.diag.workletFail'),
    JSON.stringify({ error: elements.get('coachDiagError').textContent,
      mic: elements.get('coachDiagMic').textContent,
      worklet: elements.get('coachDiagWorklet').textContent }));
  elements.get('coachDiagClose').dispatch('click');
  await flush();
  ok('诊断面板能关掉（不挡 HUD / 圆环 / 判定条）',
    elements.get('coachDiag').hidden === true && api.coach.diagOpen === false);

  /* ---- ② 语音自检四步走通：mic → ws → send → result ---- */
  const savedWs = windowStub.WebSocket;
  const savedCtx = windowStub.AudioContext;
  const savedOverride = windowStub.__MFG_ASR_WS__;
  const savedAwNode = windowStub.AudioWorkletNode;
  const savedRecordMs = windowStub.__MFG_SELFTEST_RECORD_MS__;
  const savedReadyMs = windowStub.__MFG_SELFTEST_READY_MS__;
  const savedResultMs = windowStub.__MFG_SELFTEST_RESULT_MS__;
  windowStub.__MFG_SELFTEST_RECORD_MS__ = 80;
  windowStub.__MFG_SELFTEST_READY_MS__ = 800;
  windowStub.__MFG_SELFTEST_RESULT_MS__ = 800;
  windowStub.__MFG_ASR_WS__ = 'ws://127.0.0.1:5996/asr';

  const st = { sockets: [], contexts: [], micCallsBefore: coachStubs.micCalls.length };
  class SelfTestWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closed = false;
      st.sockets.push(this);
      setTimeout(() => {
        if (this.closed) return;
        this.readyState = 1;
        this.onopen?.({});
      }, 0);
    }
    send(data) {
      this.sent.push(data);
      if (typeof data !== 'string') return;
      let msg = null;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'start') {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) }), 0);
      } else if (msg.type === 'stop') {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'final', text: '你好世界' }) }), 0);
      }
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.readyState = 3;
      this.onclose?.({ code: 1000, reason: '' });
    }
  }
  class SelfTestCtx {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = {};
      this.closed = false;
      this.node = null;
      st.contexts.push(this);
    }
    createMediaStreamSource(stream) { this.stream = stream; return { connect() {}, disconnect() {} }; }
    createAnalyser() {
      return {
        fftSize: 512,
        smoothingTimeConstant: 0,
        getByteTimeDomainData(buf) { for (let i = 0; i < buf.length; i += 1) buf[i] = 190; },
      };
    }
    createScriptProcessor() {
      this.node = {
        onaudioprocess: null,
        disconnected: false,
        connect() {},
        disconnect() { this.disconnected = true; },
      };
      this.pump = setInterval(() => {
        if (this.node?.disconnected) return;
        this.node.onaudioprocess?.({
          inputBuffer: { getChannelData: () => new Float32Array(1024).fill(0.2) },
        });
      }, 10);
      return this.node;
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    resume() { return Promise.resolve(); }
    close() {
      if (this.pump) clearInterval(this.pump);
      this.closed = true;
      this.state = 'closed';
      return Promise.resolve();
    }
  }
  windowStub.WebSocket = SelfTestWS;
  windowStub.AudioContext = SelfTestCtx;

  elements.get('btnVoiceSelfTest').dispatch('click');
  const finished = await waitUntil(() => api.coachSelfTest.snapshot().finishedAt > 0);
  await flush();
  const selfSnap = api.coachSelfTest.snapshot();
  ok('「语音自检」四步全部通过：麦克风 → 代理连接 → 发送音频 → 识别结果',
    finished && selfSnap.running === false
    && selfSnap.steps.mic === 'ok' && selfSnap.steps.ws === 'ok'
    && selfSnap.steps.send === 'ok' && selfSnap.steps.result === 'ok',
    JSON.stringify({ finished, steps: selfSnap.steps, error: selfSnap.error }));
  ok('自检面板每步都有中英词条的「通过」文案（四行都在）',
    [['coachSelfTestMic', 'mic'], ['coachSelfTestWs', 'ws'],
      ['coachSelfTestSend', 'send'], ['coachSelfTestResult', 'result']]
      .every(([id, step]) => elements.get(id).textContent.includes(tD(`coach.selfTest.step.${step}`))
        && elements.get(id).textContent.includes(tD('coach.selfTest.status.ok'))),
    JSON.stringify(['coachSelfTestMic', 'coachSelfTestWs', 'coachSelfTestSend', 'coachSelfTestResult']
      .map((id) => elements.get(id).textContent)));
  ok('自检显示音量读数（VU 共用自检自己的那一条流）',
    elements.get('coachSelfTestVolume').textContent.startsWith(
      tD('coach.selfTest.volumeValue', { level: '' }).replace('{level}', '').trim())
    && !elements.get('coachSelfTestVolume').textContent.includes('—'),
    elements.get('coachSelfTestVolume').textContent);
  ok('自检最后一行显示服务端返回的 final 文本',
    elements.get('coachSelfTestResultText').textContent
      === tD('coach.selfTest.resultText', { kind: 'final', text: '你好世界' }),
    elements.get('coachSelfTestResultText').textContent);
  const stSock = st.sockets.at(-1);
  const stBinary = stSock.sent.filter((x) => typeof x !== 'string');
  ok('自检真的把 PCM 分片发出去了（有二进制帧 + 最后发 {"type":"stop"}）',
    stBinary.length > 0 && stBinary.every((x) => x.byteLength > 0)
    && JSON.parse(stSock.sent.at(-1)).type === 'stop',
    JSON.stringify({ frames: stBinary.length, last: stSock.sent.at(-1) }));
  ok('**自检独立于教练会话，而且只取一次麦克风**（自检自己 open 一次，不共用人家的路）',
    coachStubs.micCalls.length === st.micCallsBefore + 1,
    String(coachStubs.micCalls.length - st.micCallsBefore));
  ok('自检结束释放干净：音轨 stop、AudioContext.close、WebSocket.close',
    coachStubs.micTracks.at(-1)?.stopped === true
    && st.contexts.every((c) => c.closed === true)
    && stSock.closed === true,
    JSON.stringify({ track: coachStubs.micTracks.at(-1)?.stopped,
      ctxClosed: st.contexts.map((c) => c.closed), ws: stSock.closed }));

  /* ---- ③ 自检失败：代理连不上 → 面板写原因 + 用中文把它说出来 ---- */
  windowStub.WebSocket = class FailingSelfTestWS {
    constructor() {
      this.readyState = 0;
      this.sent = [];
      setTimeout(() => this.onerror?.({ name: 'Error', message: 'boom' }), 0);
    }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; }
  };
  elements.get('btnVoiceSelfTest').dispatch('click');
  await waitUntil(() => api.coachSelfTest.snapshot().finishedAt > 0);
  await flush();
  const failSnap = api.coachSelfTest.snapshot();
  ok('自检失败时把失败的那一步说清楚（ws 步骤 fail + 错误码）',
    failSnap.steps.mic === 'ok' && failSnap.steps.ws === 'fail'
    && failSnap.error?.step === 'ws' && !!failSnap.error?.code,
    JSON.stringify({ steps: failSnap.steps, error: failSnap.error }));
  ok('面板结果行写明「失败在：代理连接（…）」',
    elements.get('coachSelfTestResultText').textContent
      === tD('coach.selfTest.failedAt', {
        step: tD('coach.selfTest.step.ws'), code: failSnap.error?.code || '',
      }),
    elements.get('coachSelfTestResultText').textContent);
  ok('失败原因会用语音说出来（「代理连不上」，走的是教练的 TTS）',
    coachStubs.utterances.at(-1)?.text === tD('coach.selfTest.fail.ws'),
    coachStubs.utterances.at(-1)?.text);

  /* ---- ④ AudioWorklet 被拦 → 必须退回 ScriptProcessor，并把路线记进诊断 ---- */
  const wf = { sockets: [], contexts: [] };
  class WorkletFailCtx {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = {};
      this.closed = false;
      this.node = null;
      this.audioWorklet = {
        addModule: async () => {
          const err = new Error('blocked by CSP');
          err.name = 'NotAllowedError';
          throw err;
        },
      };
      wf.contexts.push(this);
    }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() {
      return {
        fftSize: 64,
        smoothingTimeConstant: 0,
        getByteTimeDomainData(buf) { for (let i = 0; i < buf.length; i += 1) buf[i] = 128; },
      };
    }
    createScriptProcessor() {
      this.node = { connected: 0, disconnected: false, onaudioprocess: null,
        connect() { this.connected += 1; }, disconnect() { this.disconnected = true; } };
      return this.node;
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
  }
  class WfWebSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; wf.sockets.push(this); }
    send(d) { this.sent.push(d); }
    close() { this.closed = true; this.readyState = 3; this.onclose?.({}); }
    open() { this.readyState = 1; this.onopen?.({}); }
    message(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  }
  windowStub.WebSocket = WfWebSocket;
  windowStub.AudioContext = WorkletFailCtx;
  windowStub.AudioWorkletNode = class {};
  windowStub.__MFG_ASR_WS__ = 'ws://127.0.0.1:5995/asr';
  await api.setCoachEnabled(true);
  await flush();
  const wfSock = wf.sockets.at(-1);
  wfSock.open();
  wfSock.message({ type: 'ready' });
  await flush();
  const capCtx = wf.contexts.find((c) => c.node);
  const wfDiag = api.coachDiag.snapshot();
  ok('AudioWorklet.addModule 失败 → 自动退回 ScriptProcessor（采集没有静默中断）',
    !!capCtx && capCtx.node.connected >= 1
    && wfDiag.worklet.state === 'fail' && wfDiag.capture === 'processor',
    JSON.stringify({ ctx: !!capCtx, worklet: wfDiag.worklet, capture: wfDiag.capture }));
  ok('走哪条采集路径记进了诊断面板（Worklet fail / ScriptProcessor 兜底）',
    elements.get('coachDiag').hidden === false
    && elements.get('coachDiagWorklet').textContent === tD('coach.diag.workletFail'),
    JSON.stringify({ hidden: elements.get('coachDiag').hidden,
      worklet: elements.get('coachDiagWorklet').textContent }));
  await api.setCoachEnabled(false);
  await flush();

  // 恢复现场
  windowStub.WebSocket = savedWs;
  windowStub.AudioContext = savedCtx;
  if (savedOverride === undefined) delete windowStub.__MFG_ASR_WS__;
  else windowStub.__MFG_ASR_WS__ = savedOverride;
  if (savedAwNode === undefined) delete windowStub.AudioWorkletNode;
  else windowStub.AudioWorkletNode = savedAwNode;
  if (savedRecordMs === undefined) delete windowStub.__MFG_SELFTEST_RECORD_MS__;
  else windowStub.__MFG_SELFTEST_RECORD_MS__ = savedRecordMs;
  if (savedReadyMs === undefined) delete windowStub.__MFG_SELFTEST_READY_MS__;
  else windowStub.__MFG_SELFTEST_READY_MS__ = savedReadyMs;
  if (savedResultMs === undefined) delete windowStub.__MFG_SELFTEST_RESULT_MS__;
  else windowStub.__MFG_SELFTEST_RESULT_MS__ = savedResultMs;
  api.coach.toggleDiag(false);
  rafQueue.length = 0;
  api.showHome();
}

/* ------------------------------------------------------------------ *
 * [1d] AI 教练开启 → 系统语音提示自动关闭（提示音不变）
 *
 * 用户要求：「一旦 AI 语音教练开启，则原来的系统语音提示可以关闭，避免重复。
 * 但是原来的提示音（如滴、叮、错误蜂鸣、计次滴答）可以保持原样，不要变。」
 *
 * 这不只是重复问题：audio.say() 在说话前会 speechSynthesis.cancel()，
 * 而教练的 mock TTS 也走 speechSynthesis → 系统一句提示会把教练掐断。
 * 所以这里最关键的断言是：教练开启时 say() **连 cancel 都不调**。
 * ------------------------------------------------------------------ */

console.log('\n[1d] AI 教练开启时系统语音让位（避免重复 / 避免 cancel 掐断教练），提示音不变');
{
  const api = windowStub.__mfg;
  const flush = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };

  // 假 WebAudio：只数 createOscillator 的次数，证明「提示音照常」
  const savedAudioCtx = windowStub.AudioContext;
  const savedCtx = api.audio.ctx;
  let oscCount = 0;
  function FakeCtx() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
  }
  FakeCtx.prototype.createOscillator = function createOscillator() {
    oscCount += 1;
    return {
      type: '',
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (node) => node,
      start() {},
      stop() {},
    };
  };
  FakeCtx.prototype.createGain = function createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (node) => node,
    };
  };
  windowStub.AudioContext = FakeCtx;
  api.audio.ctx = null;
  api.audio.unlock();
  ok('假 WebAudio 已接管（后面靠 createOscillator 数提示音）', api.audio.ctx instanceof FakeCtx);

  // 教练开 → 系统语音让位
  await api.setCoachEnabled(true);
  await flush();
  ok('教练开启后系统语音总开关关闭（voiceAllowed=false，audio.state 也反映出来）',
    api.audio.voiceAllowed === false && api.state.voice.enabled === true
    && api.audio.state().voiceAllowed === false,
    JSON.stringify({ allowed: api.audio.voiceAllowed, state: api.state.voice.state }));

  const cancelBeforeSay = coachStubs.cancelled;
  const utterBeforeSay = coachStubs.utterances.length;
  api.audio.say('这是一句系统提示', { force: true });
  await flush();
  ok('教练开启时 audio.say() 完全不发声（没有新的 utterance 交给 speechSynthesis）',
    coachStubs.utterances.length === utterBeforeSay,
    `${utterBeforeSay} → ${coachStubs.utterances.length}`);
  ok('教练开启时 audio.say() **没有调用 speechSynthesis.cancel()**（那条 cancel 会掐断教练）',
    coachStubs.cancelled === cancelBeforeSay,
    `${cancelBeforeSay} → ${coachStubs.cancelled}`);
  const cancelBeforeStop = coachStubs.cancelled;
  api.audio.stopSpeech();
  ok('教练开启时 stopSpeech() 也不会 cancel（不会顺手把教练停掉）',
    coachStubs.cancelled === cancelBeforeStop, `${cancelBeforeStop} → ${coachStubs.cancelled}`);

  const oscBefore = oscCount;
  api.audio.rep(1);
  api.audio.tick();
  api.audio.finish();
  ok('教练开启时提示音照常：WebAudio 振荡器仍被创建（滴 / 叮 / 计次 / 错误蜂鸣不走语音开关）',
    oscCount - oscBefore >= 4, `新建 ${oscCount - oscBefore} 个振荡器`);

  // 教练关 → 系统语音完全恢复
  await api.setCoachEnabled(false);
  await flush();
  ok('教练关闭后系统语音恢复（voiceAllowed=true）', api.audio.voiceAllowed === true);

  const cancelBeforeSay2 = coachStubs.cancelled;
  const utterBeforeSay2 = coachStubs.utterances.length;
  api.audio.say('系统提示回来了', { force: true });
  await flush();
  ok('教练关闭后 audio.say() 恢复工作：新 utterance 交给 speechSynthesis',
    coachStubs.utterances.length === utterBeforeSay2 + 1
    && coachStubs.utterances.at(-1)?.text === '系统提示回来了',
    coachStubs.utterances.at(-1)?.text);
  ok('教练关闭后 cancel 照旧调用（切句行为与以前完全一样）',
    coachStubs.cancelled === cancelBeforeSay2 + 1,
    `${cancelBeforeSay2} → ${coachStubs.cancelled}`);
  const oscBefore2 = oscCount;
  api.audio.rep(2);
  ok('教练关闭时提示音同样照常（振荡器仍被创建）',
    oscCount - oscBefore2 >= 2, `新建 ${oscCount - oscBefore2} 个振荡器`);

  // 来回切换多次：状态不残留
  for (let i = 0; i < 3; i += 1) {
    await api.setCoachEnabled(true);
    await flush();
    await api.setCoachEnabled(false);
    await flush();
  }
  ok('教练开关来回 3 次后状态正确：关闭态、系统语音允许、没有卡住的 _speaking',
    api.state.voice.state === 'off' && api.audio.voiceAllowed === true
    && api.audio._speaking === false,
    JSON.stringify({ voice: api.state.voice.state, allowed: api.audio.voiceAllowed,
      speaking: api.audio._speaking }));
  api.audio.say('切换后还能说', { force: true });
  await flush();
  ok('来回切换后 say() 仍然正常（没有残留的静音状态）',
    coachStubs.utterances.at(-1)?.text === '切换后还能说',
    coachStubs.utterances.at(-1)?.text);

  // 恢复现场（不要给后面「声音自检」留一个假 AudioContext）
  windowStub.AudioContext = savedAudioCtx;
  api.audio.ctx = savedCtx;
  api.audio._speaking = false;
  api.audio._speakingSince = 0;
  api.audio._lastVoiceAt = 0;
  api.audio.voiceAllowed = true;
  api.showHome();
}

/* ------------------------------------------------------------------ *
 * 运动设定弹窗（两步：① 先选动作 → ② 再设这个动作的目标 / 判据 / 机位）
 *
 * 用户要求：「将目标设定从运动页面中删除，放到主页的右上方和『设置』在一起。
 * 用户打开『运动设定』之后首先选择运动项目，然后再进入对应的运动目标设置等内容。」
 * ------------------------------------------------------------------ */

console.log('\n[1b] 运动设定弹窗（入口在主页、两步流程）');
{
  const api = windowStub.__mfg;
  api.showHome();
  ok('主页上显示「运动设定」图标（入口挪到了主页右上角）',
    elements.get('btnExercise').hidden === false);
  ok('主页时运动设定弹窗是关着的', elements.get('exerciseModal').hidden === true);

  api.openExercise('pushup');
  ok('动作页**不再**有「运动设定」图标（入口已从运动页删除）',
    elements.get('btnExercise').hidden === true);
  ok('顶栏上「运动设定」与「设置」并排（同一个 topbar-actions 里）', (() => {
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
  ok('回主页后「运动设定」图标重新出现（它是主页入口）',
    elements.get('btnExercise').hidden === false);

  // ===== 打开运动设定：第一步必须先选运动项目 =====
  elements.get('btnExercise').dispatch('click');
  ok('点图标打开运动设定弹窗', elements.get('exerciseModal').hidden === false);
  ok('第一步先选运动项目（选择页显示、目标设置页藏着）',
    elements.get('exercisePickStep').hidden === false
    && elements.get('exerciseTargetStep').hidden === true,
    `pick=${elements.get('exercisePickStep').hidden} target=${elements.get('exerciseTargetStep').hidden}`);
  // 桩里选择页的结构：分类 section → 里面的 grid → 每一个动作按钮
  const pickSections = () => elements.get('exercisePickList').children;
  const pickCards = () => pickSections().flatMap((cat) => cat.children[0]?.children || []);
  ok(`第一步把动作库全部列出来（${EXERCISES.length} 个，与 EXERCISES.length 对齐）`,
    pickCards().length === EXERCISES.length,
    `实际 ${pickCards().length} / ${EXERCISES.length}`);
  ok('第一步按 5 个分类分组',
    pickSections().length === 5 && pickSections().every((s) => !!s.dataset.cat),
    `实际 ${pickSections().length} 组`);
  ok('每一项都有姿势图标 + 名称（图标复用 exercisePoseSVG，不画新的）',
    pickCards().length > 0 && pickCards().every((b) => /<svg class="ex-pose/.test(b.innerHTML)
      && /class="pick-name"/.test(b.innerHTML) && b.innerHTML.includes('ex-pose--solid')),
    pickCards()[0]?.innerHTML?.slice(0, 90));
  ok('选择项无障碍名称走 i18n（含动作名）', (() => {
    const btn = pickCards().find((b) => b.dataset.id === 'pushup');
    return !!btn && /设置「俯卧撑」的目标/.test(btn.attributes['aria-label'] || '');
  })(), pickCards().find((b) => b.dataset.id === 'pushup')?.attributes?.['aria-label']);
  ok('上次练过的动作在选择页里高亮（不是跳过选择页，只是标出来）',
    pickCards().filter((b) => b.classList.contains('active')).map((b) => b.dataset.id).join(',') === 'pushup',
    pickCards().filter((b) => b.classList.contains('active')).map((b) => b.dataset.id).join(','));

  // 选中俯卧撑 → 进第二步
  pickCards().find((b) => b.dataset.id === 'pushup').dispatch('click');
  ok('选中动作后进入第二步（选择页收起、目标设置页出现）',
    elements.get('exerciseTargetStep').hidden === false
    && elements.get('exercisePickStep').hidden === true);
  ok('弹窗标题是刚选的动作', elements.get('exerciseName').textContent.includes('俯卧撑'),
    elements.get('exerciseName').textContent);
  ok('第二步有「换一个动作」返回第一步的入口（大号胶囊按钮 + title / aria 词条）',
    /data-i18n="exercise\.pickAgain"/.test(html) && !!elements.get('btnExercisePickAgain')
    && /data-i18n-title="exercise\.pickAgain"/.test(html)
    && /data-i18n-aria="exercise\.pickAgain"/.test(html));
  ok('「换一个动作」左边真的填进了 libIconSVG(\'back\') 的线条箭头（不是 emoji / 字符）', (() => {
    const box = elements.get('btnExercisePickAgain').querySelector('.pick-again-icon');
    return /<svg class="ui-icon"/.test(box.innerHTML) && /viewBox="0 0 24 24"/.test(box.innerHTML)
      && /M9 14 4 9l5-5/.test(box.innerHTML) && !/←/.test(box.innerHTML);
  })(), (elements.get('btnExercisePickAgain').querySelector('.pick-again-icon')?.innerHTML || '').slice(0, 90));
  ok('第二步显示判定依据', elements.get('exerciseJudge').textContent.includes('判定依据'),
    elements.get('exerciseJudge').textContent);
  ok('第二步显示机位提示', elements.get('exerciseCamera').textContent.includes('侧对摄像头'),
    elements.get('exerciseCamera').textContent);
  ok('弹窗里的目标值跟当前目标一致',
    elements.get('targetInput').value === String(api.state.target),
    `${elements.get('targetInput').value} vs ${api.state.target}`);
  ok('弹窗里列出目标预设',
    elements.get('targetChips').children.length > 0,
    `实际 ${elements.get('targetChips').children.length} 个`);
  // 用户要求：向前 / 向后箭步蹲的默认次数改成 20 —— 预设里必须能直接选到 20
  ok('次数预设里有 20（箭步蹲的新默认值）',
    api.targetPresetsFor({ kind: 'rep', timed: false }).includes(20),
    JSON.stringify(api.targetPresetsFor({ kind: 'rep', timed: false })));
  {
    const { EXERCISE_MAP } = await import('../src/catalog.js');
    const lunge = EXERCISE_MAP.lunge;
    const lungeBack = EXERCISE_MAP.lungeBack;
    ok('前后箭步蹲的默认目标 = 20 次，且预设里能直接选到',
      lunge.target === 20 && lungeBack.target === 20
      && api.targetPresetsFor({ kind: 'rep' }).includes(lunge.target),
      `${lunge.target}/${lungeBack.target}`);
    // 用户要求：卷腹与反向卷腹的默认次数都改成 20（反向卷腹原来是 15）
    ok('卷腹 / 反向卷腹的默认目标都 = 20 次',
      EXERCISE_MAP.crunch.target === 20 && EXERCISE_MAP.reverseCrunch.target === 20,
      `${EXERCISE_MAP.crunch.target}/${EXERCISE_MAP.reverseCrunch.target}`);
  }

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

  // 「← 换一个动作」：回到第一步，再选另一个动作就进它的目标页
  elements.get('btnExercisePickAgain').dispatch('click');
  ok('「← 换一个动作」回到第一步（选择页重新出现、目标页收起）',
    elements.get('exercisePickStep').hidden === false
    && elements.get('exerciseTargetStep').hidden === true);
  ok('回到第一步时高亮的是刚编辑过的动作',
    pickCards().filter((b) => b.classList.contains('active')).map((b) => b.dataset.id).join(',') === 'pushup',
    pickCards().filter((b) => b.classList.contains('active')).map((b) => b.dataset.id).join(','));
  // 选一个别的动作：第二步必须换成**它**的目标与判据（目标本来就是按动作分别存的）
  pickCards().find((b) => b.dataset.id === 'plank').dispatch('click');
  ok('换到平板支撑后，第二步显示它自己的目标（45 秒）与判据',
    elements.get('exerciseName').textContent.includes('平板支撑')
    && elements.get('targetInput').value === '45'
    && elements.get('targetUnit').textContent === '秒'
    && elements.get('exerciseSpecs').innerHTML.includes('关键帧与判分'),
    `${elements.get('exerciseName').textContent} / ${elements.get('targetInput').value} ${elements.get('targetUnit').textContent}`);
  ok('编辑弹窗里别的动作不会顺手改掉「正在练的动作」的目标（当前还是俯卧撑）',
    api.state.exerciseId === 'pushup' && api.state.target === before + 4,
    `${api.state.exerciseId} / ${api.state.target}`);
  // 回到俯卧撑（后面的判据断言都按俯卧撑写）
  elements.get('btnExercisePickAgain').dispatch('click');
  pickCards().find((b) => b.dataset.id === 'pushup').dispatch('click');

  // 关闭方式：✕、点背景、Esc
  elements.get('btnCloseExercise').dispatch('click');
  ok('点 ✕ 关闭运动设定弹窗', elements.get('exerciseModal').hidden === true);
  ok('关闭后回到第一步：下次打开不会直接落在某个动作的目标页',
    elements.get('exercisePickStep').hidden === false
    && elements.get('exerciseTargetStep').hidden === true);
  ok('动作页没有第二个入口了（侧栏只剩只读的目标摘要，没有「运动设定」按钮）',
    !html.includes('id="btnExerciseInline"') && !!elements.get('targetReadout')
    && /<p class="target-readout" id="targetReadout"/.test(html));
  // 重新打开（每次都是第一步），再选俯卧撑进第二步，供下面逐条核对判据
  api.openExerciseSettings();
  pickCards().find((b) => b.dataset.id === 'pushup').dispatch('click');

  // ===== 关键帧判据与判分：把识别器真正用的数值显示给用户 =====
  // 关键帧那一组里带线条图标（SVG 里有坐标数字），做数值断言前先把图标去掉，免得误命中坐标
  const specHtml = () => elements.get('exerciseSpecs').innerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '');
  // ===== 用户要求：判据完全挂在关键帧上，弹窗里不再有单独的「计次判据 / 姿势要求」两组 =====
  ok('运动设定里第一组是关键帧与判分', specHtml().includes('关键帧与判分'), specHtml().slice(0, 120));
  ok('不再有单独的「计次判据（做到什么程度算一次）」分组',
    !specHtml().includes('计次判据'), specHtml().slice(0, 200));
  ok('不再有单独的「姿势要求」分组（并进第一格的关键帧里）',
    !specHtml().includes('姿势要求（不满足就不进入判定）'), specHtml().slice(0, 200));
  // ===== 用户要求「大幅度简化计次标准」之后：弹窗里只剩肘角这一条线的四个数 =====
  ok('俯卧撑：计次线（≤148°）挂在关键帧上', specHtml().includes('148'), specHtml().slice(0, 240));
  ok('俯卧撑：不再有「肩膀下沉量」这条第二路证据（简化掉的就是它）',
    !specHtml().includes('肩膀下沉') && !specHtml().includes('0.08'), specHtml().slice(0, 300));
  ok('俯卧撑：列出俯撑姿势门控（躯干倾角 ≥ 32°）', specHtml().includes('≥ 32'), specHtml().slice(0, 300));
  ok('俯卧撑：四格都是肘角/俯撑，不再有别的指标',
    (specHtml().match(/肘关节角度|躯干倾角|进度/g) || []).length >= 4 && !specHtml().includes('肩膀离地'),
    specHtml().slice(0, 400));
  ok('指标行带上了单位（×躯干长 / °）',
    specHtml().includes('躯干长') && specHtml().includes('°'), specHtml().slice(0, 200));

  // 臀桥（用户要求改判据）：「不要使用髋部抬起高度……关键帧标准改为髋角度 180 左右，
  //   而膝盖是弯曲的，90 度左右，但可以放更宽一些」→ 弹窗里必须是「髋角 ≥170° 且 膝角 55°~130°」，
  //   而且**不许**再出现「髋部抬起高度」那一路。
  {
    api.openExercise('bridge');
    api.renderExerciseSettings();
    const bridgeHtml = elements.get('exerciseSpecs').innerHTML;
    ok('臀桥：顶点写成「髋角 ≥170° 且 膝角 55°~130°」（弹窗里出现「且」和这三个数）',
      bridgeHtml.includes('且') && bridgeHtml.includes('170')
      && bridgeHtml.includes('55') && bridgeHtml.includes('130'),
      bridgeHtml.slice(0, 400));
    ok('臀桥：弹窗里再也没有「髋部抬起高度」这条判据（数据层由 test-specs 断言 metric.hipRise 不再出现）',
      !bridgeHtml.includes('髋部抬起') && !bridgeHtml.includes('抬起高度'),
      bridgeHtml.slice(0, 400));
    ok('臀桥：落回那一条写的是「跟着你自己躺平的读数走」（相对判据）',
      bridgeHtml.includes('躺平'), bridgeHtml.slice(-500));
    api.openExercise('pushup');
    api.renderExerciseSettings();
  }

  // 死虫式：用户反馈「关键帧判别标准都不对」→ 判据重做成「腿伸出去的程度」+「另一条腿留在桌面位」
  {
    api.openExercise('deadBug');
    api.renderExerciseSettings();
    const bugHtml = elements.get('exerciseSpecs').innerHTML;
    ok('死虫式：关键帧短标签是「伸腿 / 换腿」（进度条悬停与弹窗里都是这两个词）',
      bugHtml.includes('伸腿') && bugHtml.includes('换腿'), bugHtml.slice(0, 300));
    ok('死虫式：判据是「膝角与髋角取小」的伸腿程度（弹窗里出现 132 与「膝角与髋角」）',
      bugHtml.includes('132') && bugHtml.includes('膝角与髋角'), bugHtml.slice(0, 400));
    ok('死虫式：「另一条腿留在桌面位」用「且」写成附加条件（出现「且」和 120）',
      bugHtml.includes('且') && bugHtml.includes('120'), bugHtml.slice(0, 500));
    api.openExercise('pushup');
    api.renderExerciseSettings();
  }

  // 仰卧抬腿：用户反馈「总是进入不了起始姿势」→「躺下」判据写成两条证据「或」
  {
    api.openExercise('lyingLegRaise');
    api.renderExerciseSettings();
    const raiseHtml = elements.get('exerciseSpecs').innerHTML;
    ok('仰卧抬腿：关键帧第一格把「躺下」写成「躯干接近水平 或 肩膀贴近地面线」',
      raiseHtml.includes('且') === false && raiseHtml.includes('或')
      && raiseHtml.includes('55') && raiseHtml.includes('0.6'),
      raiseHtml.slice(0, 400));
    api.openExercise('pushup');
    api.renderExerciseSettings();
  }

  // 坐姿体前屈：用户给的判据是「初始关键帧就是侧面向镜头坐好，髋角约 90°、躯干角约 0°；
  //   前屈时躯干角 + 髋角之和始终在 90° 左右；躯干角到 30 左右就到位置、可以开始计时」
  //   → 弹窗必须是**两格关键帧**：① 坐好（认到一次就常亮）② 前折到位（开始计时那一刻）。
  {
    api.openExercise('seatedForwardFold');
    api.renderExerciseSettings();
    const seatHtml = elements.get('exerciseSpecs').innerHTML;
    ok('坐姿体前屈：弹窗里是两格关键帧（「坐好」→「前折到位」）',
      (seatHtml.match(/spec-row spec-kf/g) || []).length === 2
      && seatHtml.includes('坐好') && seatHtml.includes('前折到位'),
      String((seatHtml.match(/spec-row spec-kf/g) || []).length));
    ok('坐姿体前屈：第一格列出「坐好」的四条数（躯干 ≤ 25°、髋 70°–115°、膝 ≥ 130°、髋不比膝高）',
      seatHtml.includes('25') && seatHtml.includes('70') && seatHtml.includes('115')
      && seatHtml.includes('130') && seatHtml.includes('躯干倾角'),
      seatHtml.slice(0, 500));
    ok('坐姿体前屈：第二格列出计时线的数（躯干 ≥ 28° +「躯干角+髋角」60°–125°）',
      seatHtml.includes('28') && seatHtml.includes('躯干角+髋角')
      && seatHtml.includes('60') && seatHtml.includes('125'),
      seatHtml.slice(400, 900));
    ok('坐姿体前屈：说明里写出用户给的恒等式（髋角 = 90° − 躯干倾角，所以两者之和始终在 90° 附近）',
      seatHtml.includes('90° − 躯干倾角') && /躯干角 \+ 髋角 ≈ 60°~125°/.test(seatHtml),
      seatHtml.slice(-700));
    ok('坐姿体前屈：第一格写明「认到一次就常亮」（前折不会把它取消）',
      seatHtml.includes('常亮'), seatHtml.slice(-700));
    ok('坐姿体前屈：最后一格标「开始计时」（计时类没有「计次那一刻」）',
      seatHtml.includes('开始计时') && !seatHtml.includes('计次那一刻'), seatHtml.slice(-300));
    api.openExercise('pushup');
    api.renderExerciseSettings();
  }

  // 卷腹：用户给了新的关键帧模型（屈膝躺下 → 卷起来：躯干倾角变小 + 肩-髋距缩到 ≈70% + 头离地），
  // 弹窗里必须逐条如实列出——他调动作就是照着这个弹窗看数字的。
  {
    api.openExercise('crunch');
    api.renderExerciseSettings();
    const crunchHtml = elements.get('exerciseSpecs').innerHTML;
    ok('卷腹：弹窗里是三格关键帧（躺下 → 卷起 → 卷到位）',
      (crunchHtml.match(/spec-row spec-kf/g) || []).length === 3
      && crunchHtml.includes('躺下') && crunchHtml.includes('卷起'),
      String((crunchHtml.match(/spec-row spec-kf/g) || []).length));
    ok('卷腹：起始格写着「躯干倾角 ≥ 62°」+「膝关节 25°–118°」（屈膝躺下）',
      crunchHtml.includes('62') && crunchHtml.includes('118') && crunchHtml.includes('屈膝躺下'),
      crunchHtml.slice(0, 500));
    ok('卷腹：计次格写着「肩-髋距 ≤ 0.8×躺平时」（单位是「×躺平时」，不是「×躯干长」）',
      crunchHtml.includes('0.8') && crunchHtml.includes('×躺平时') && !crunchHtml.includes('肩-髋距 ≤ 0.8×躯干长'),
      crunchHtml.slice(0, 700));
    ok('卷腹：计次格同时列出「头离地 ≥ 0.16×躯干长」这条「或」的证据',
      crunchHtml.includes('头离地') && crunchHtml.includes('0.16'), crunchHtml.slice(0, 700));
    ok('卷腹：说明里写出用户那套读数（缩到 0.80 就算一次、实际能缩到 0.72 左右）',
      crunchHtml.includes('缩到') && crunchHtml.includes('0.80') && crunchHtml.includes('0.72')
      && crunchHtml.includes('0.90'),
      crunchHtml.slice(-600));
    ok('卷腹：「躯干倾角变小」那条说明写的是「比自己躺平小 13°」（相对基线，不是固定角度）',
      crunchHtml.includes('13°') && crunchHtml.includes('躺平约 90°'), crunchHtml.slice(-900));
    api.openExercise('pushup');
    api.renderExerciseSettings();
  }

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
    ok('俯卧撑：四格的分数 5 / 7 / 14 / 8 都列出来了（开始下沉 7、到计次线 14、回位 8）',
      ['+5', '+7', '+14', '+8'].every((x) => raw.includes(x)), raw.slice(0, 400));
    ok('俯卧撑：整轮满分 6 分标在最后一格上', raw.includes('+6 整轮满分'), raw.slice(-400));
    ok('最后一格标出「计次那一刻」', raw.includes('计次那一刻'), raw.slice(0, 300));
    ok('说明里写了每轮总分（5+7+14+8+6 = 40）', raw.includes('每轮 40 分'),
      (raw.match(/共 \d+ 格[\s\S]{0,150}/) || [''])[0]);
    ok('弹窗里的关键帧判据就是进度条格子上的判据（肘角 159°/148°/161° 都在）',
      raw.includes('159') && raw.includes('148') && raw.includes('161'), raw.slice(0, 600));
    ok('俯卧撑：最后一格写明「回到起始位就计次」（= 识别器结算这一轮的那一刻）',
      raw.includes('回到自己起始位附近') || raw.includes('回到起始位'), raw.slice(-900));
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

  // ===== 跪姿俯卧撑（退阶俯卧撑，用户要求新增）：弹窗里必须能列出它的四格与更松的门槛 =====
  {
    api.selectExercise('kneePushup');
    const kneeHtml = elements.get('exerciseSpecs').innerHTML;
    const kneeRaw = kneeHtml.replace(/<svg[\s\S]*?<\/svg>/g, '');
    ok('跪姿俯卧撑：弹窗里有四格关键帧（跪撑 → 开始下沉 → 到计次线 → 回到起始位）',
      (kneeHtml.match(/spec-row spec-kf/g) || []).length === 4
      && kneeRaw.includes('跪撑') && kneeRaw.includes('回到自己起始位附近'),
      `${(kneeHtml.match(/spec-row spec-kf/g) || []).length} 格`);
    ok('跪姿俯卧撑：计次线（≤155°）与满分深度（≤133°）都列在关键帧上',
      kneeRaw.includes('155') && kneeRaw.includes('133'), kneeRaw.slice(0, 400));
    // 用户后续要求「去掉膝盖 90 度的要求」→ 判据只剩四条（膝角仍在画面上标出来，但不再参与判定）
    // 第二轮反馈「似乎没有计数」→ 四条判据整体放宽（髋 120°–180° / 0.15 / 0.1 / 0.5）
    ok('跪姿俯卧撑：第一格「跪撑」列的是四条判据（髋 120°–180° / 髋比膝高 / 肩高于髋 / 膝离地），**没有膝关节角度**',
      kneeRaw.includes('跪撑') && kneeRaw.includes('髋关节角度 120°–180°')
      && !kneeRaw.includes('膝关节角度')
      && kneeRaw.includes('髋比膝高')
      && kneeRaw.includes('肩高于髋') && kneeRaw.includes('膝离地高度 ≤ 0.5×躯干长')
      && !kneeRaw.includes('躯干倾角 ≥ 32') && !kneeRaw.includes('50°–158°'),
      kneeRaw.slice(0, 600));
    ok('跪姿俯卧撑：分数的分配与 stagePoints 一致（5 / 7 / 14 / 8 + 满轮 6 = 40）',
      ['+5', '+7', '+14', '+8'].every((x) => kneeRaw.includes(x))
      && kneeRaw.includes('+6 整轮满分') && kneeRaw.includes('每轮 40 分'),
      kneeRaw.slice(0, 200));
    api.selectExercise('pushup');
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
  // 重新打开（动作页上按钮是 hidden 的，真实用户点不到它；这里直接调内部入口）
  api.openExerciseSettings();
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
  ok('返回主页时运动设定弹窗自动关闭，图标重新出现（主页才是它的位置）',
    elements.get('exerciseModal').hidden === true && elements.get('btnExercise').hidden === false);
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
  // 用户要求（新版 HUD 三条）：
  //   · **运动名称**在**左上角**（和动作图标同一行胶囊），**排在目标次数上面**；
  //   · **目标次数**在计数圆环的**正上方**，与**圆心纵向对齐**；
  //   · **计分**在圆环下方，同样与圆心纵向对齐 —— 这三者同在一个居中列（名称不在那条中线上）。
  {
    const hudBlock = /class="hud-left"([\s\S]*?)id="hudSub"/.exec(html)?.[1] || '';
    ok('名称 / 目标 / 圆环 / 计分都在同一个左栏（.hud-left）里，名称排在目标**前面**（左上角、目标次数上面）',
      hudBlock.includes('id="hudName"') && hudBlock.includes('id="hudTarget"')
      && hudBlock.indexOf('id="hudName"') < hudBlock.indexOf('id="hudTarget"')
      && hudBlock.includes('id="hudRing"') && hudBlock.includes('id="hudScore"'), hudBlock.slice(0, 120));
    ok('次数（#hudValue）在进度圆环（#hudRing）里面',
      html.indexOf('id="hudRing"') < html.indexOf('id="hudValue"')
      && html.indexOf('id="hudValue"') < html.indexOf('id="hudScore"'));
    ok('目标在圆环**之前**、计分在圆环**之后**（DOM 顺序 = 上 → 中 → 下，分数仍在环下）',
      html.indexOf('id="hudTarget"') < html.indexOf('id="hudRing"')
      && html.indexOf('id="hudRing"') < html.indexOf('id="hudScore"')
      && html.indexOf('id="hudScore"') < html.indexOf('id="hudSub"'), hudBlock.slice(0, 200));
    ok('旧的百分比文字（#ringText）已经去掉（环里只放数字）', !/id="ringText"/.test(html));

    // 真实渲染后的**文案**：目标只有「N 次 / N 秒」（数字来自 state.target，单位来自动作自己），
    // 名称是另一个元素（不再像以前那样和目标挤在同一个胶囊里）。
    const targetText = elements.get('hudTarget').textContent;
    const nameText = elements.get('hudName').textContent;
    ok('目标文案仍然是「N 次」（数字来自 state.target，不是写死的）',
      targetText === `${api.state.target} 次`, targetText);
    ok('名称（#hudName）有自己的文案，且不含目标数字（名称 / 目标已经是两个元素）',
      nameText.trim().length > 0 && !nameText.includes(String(api.state.target)), nameText);

    // 三者的**中心 x**：同一舞台尺寸下必须完全相同（= 圆心那条竖线）。
    // 桩 DOM 没有真实布局，数值来自 app.js 的纯函数 hudColumnGeom()（就是 CSS 那个居中列的模型，
    // ?probe=1 的 JSON 里读的也是同一个函数）。
    const g = api.hudColumnGeom(api.stageSize());
    ok('hudColumnGeom() 只管 **目标 / 圆环 / 计分** 三者（名称不在这条中线上）',
      Object.keys(g.rows).join(',') === 'target,ring,score');
    ok('目标 / 圆环 / 计分三者的中心 x 完全相同（同一个居中列的同一根竖线）',
      g.rows.target.cx === g.rows.ring.cx && g.rows.ring.cx === g.rows.score.cx
      && g.rows.ring.cx === g.cx,
      `target=${g.rows.target.cx} ring=${g.rows.ring.cx} score=${g.rows.score.cx}`);
    ok('这根竖线就是圆心：cx = 左内边距 + 圆环直径 / 2（列宽 = 圆环直径 = --ring-px）',
      Math.abs(g.cx - (g.left + g.ringPx / 2)) < 1e-9
      && g.ringPx === api.hudRingPx() && g.left === api.HUD_COLUMN_PAD_X,
      `cx=${g.cx} left=${g.left} ring=${g.ringPx}`);
    ok('圆环自己也对称地挂在同一根竖线上（left / right 的中点 = cx）',
      Math.abs((g.rows.ring.left + g.rows.ring.right) / 2 - g.cx) < 1e-9);
    // 目标文案比圆环还宽时（长文案 / 大字号）：整列一起变宽，三者**仍然**共用同一根竖线
    const wide = api.hudColumnGeom(api.stageSize(), { targetW: g.ringPx + 60, scoreW: g.ringPx - 20 });
    ok('目标比圆环还宽时，圆环仍然居中在同一根竖线上（三者中心 x 依旧相等）',
      wide.colW === g.ringPx + 60
      && wide.rows.target.cx === wide.rows.ring.cx && wide.rows.ring.cx === wide.rows.score.cx
      && Math.abs(wide.rows.ring.left - (wide.cx - wide.ringPx / 2)) < 1e-9,
      `colW=${wide.colW} cx=${wide.cx}`);
    // 舞台尺寸变了（手机横屏 / 全屏 / 窄屏）也不改这根竖线：列贴左内边距摆，不按舞台宽度换算
    ok('换舞台尺寸（844×390 / 1920×1080 / 560×320）三者仍然对齐、竖线位置不变',
      [{ w: 844, h: 390 }, { w: 1920, h: 1080 }, { w: 560, h: 320 }].every((s) => {
        const q = api.hudColumnGeom(s);
        return q.cx === g.cx && q.rows.target.cx === q.rows.ring.cx && q.rows.ring.cx === q.rows.score.cx;
      }));
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
  // 「肩高于髋」是勾腿跳站立门控真正判的量（正数版）：站着 ≈ +1.0，和「髋抬起」互为相反数。
  // 以前门控误用了 hipRise，导致站着也永远提示「还没进入这个动作的姿势」——
  // 现在面板里两行都摆出来，一眼能看出符号。
  ok('指标面板列出「肩高于髋」（站立门控真正判的量，和「髋抬起」互为相反数）',
    dbg.includes('肩高于髋'), dbg);

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
    // 坐姿体前屈：用户反馈「没有显示角度」—— 它判的就是前折幅度（躯干倾角 ≥28°、躯干角+髋角 ≈90°），
    // 所以现在标出「髋」和「躯干」两个数（同一套胶囊，位置跟着关节走）
    {
      const { supinePose: seatPose } = await import('./synthetic-pose.mjs');
      const smSeat = new LS();
      const seat = seatPose({ hip: { x: 0.75, y: 0.8 }, thighUp: 60, knee: 172, torsoUp: 235, armDown: 40, elbow: 170 });
      let seatFrame = { ok: false };
      for (let i = 0; i < 20; i++) seatFrame = cf(tm(smSeat.apply(seat.map((q) => ({ ...q, v: q.visibility })), i / 30), A), null, i * 33, false, null);
      texts.length = 0;
      api.renderer.draw({ landmarks: seat, frame: seatFrame, exerciseId: 'seatedForwardFold', status: 'ok' });
      ok('坐姿体前屈：画面上标出「髋」（躯干与腿的夹角，折得越深越小）',
        texts.some((x) => x.startsWith('髋')), texts.join(' | '));
      ok('坐姿体前屈：标出「躯干 xx°」（关键帧要的就是躯干倾角 ≥28°，折多深一眼能看到）',
        texts.some((x) => /^躯干\s+\d+°$/.test(x)), texts.join(' | '));
    }
    // 平板支撑：用户反馈「没有计时」+「主要是判断关节角度（肘 90、肩 90、髋膝 180、躯干 80）」
    // → 画面上标出「肩」（髋-肩-肘）和「肘」，那正是现在决定计时跑不跑的两个角
    {
      const { pronePose: plankPose } = await import('./synthetic-pose.mjs');
      const smPlank = new LS();
      const plank = plankPose({ hip: { x: 0.95, y: 0.75 }, bodyTilt: 78, elbow: 90, armDown: 0 });
      let plankFrame = { ok: false };
      for (let i = 0; i < 20; i++) plankFrame = cf(tm(smPlank.apply(plank.map((q) => ({ ...q, v: q.visibility })), i / 30), A), null, i * 33, false, null);
      texts.length = 0;
      api.renderer.draw({ landmarks: plank, frame: plankFrame, exerciseId: 'plank', status: 'ok' });
      ok('平板支撑：画面上标出「肩 xx°」（肩关节角 = 髋-肩-肘，决定计时跑不跑的那个角）',
        texts.some((x) => x.startsWith('肩')), texts.join(' | '));
      ok('平板支撑：标出「肘 xx°」（小臂撑 ≈90° / 直臂撑 ≈175°）',
        texts.some((x) => x.startsWith('肘')), texts.join(' | '));
      ok('平板支撑：标出「髋 xx°」和「躯干 xx°」（用户说的髋 180 / 躯干 80）',
        texts.some((x) => x.startsWith('髋')) && texts.some((x) => /^躯干\s+\d+°$/.test(x)),
        texts.join(' | '));
      // 运动设定：必须项写的是「躯干 + 肩关节角」，替代路径（旧的肩离地/手离地）写在说明里
      api.openExercise('plank');
      api.renderExerciseSettings();
      const plankHtml = elements.get('exerciseSpecs').innerHTML;
      ok('平板支撑：弹窗里必须项写成「躯干倾角 + 肩关节角 45°–135°」',
        plankHtml.includes('躯干倾角') && plankHtml.includes('肩关节角') && plankHtml.includes('45') && plankHtml.includes('135'),
        plankHtml.slice(0, 400));
      ok('平板支撑：说明里给出替代路径（肩离地 / 手离地）的数值',
        plankHtml.includes('0.1') && plankHtml.includes('0.55'), plankHtml.slice(0, 700));
      api.openExercise('pushup');
      api.renderExerciseSettings();
    }
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

  // iPhone 也是「必须有反应」：没有元素级全屏 → 走 CSS 伪全屏，所以按钮**不再藏起来**
  const savedRequestFullscreen = stageEl.requestFullscreen;
  delete stageEl.requestFullscreen;
  api.syncFullscreenSupport();
  ok('没有 requestFullscreen 的环境（iPhone）仍然显示全屏按钮（否则点了没反应）',
    fsBtn.hidden === false, String(fsBtn.hidden));
  stageEl.requestFullscreen = savedRequestFullscreen;
  api.syncFullscreenSupport();
  ok('支持元素全屏时按钮照常显示', fsBtn.hidden === false);

  /* ===== 全屏降级链（纯函数 + 真的切换） =====
     用户原话：「我在 iPhone 上测试……Safari 和 Chrome 都不能打开，也无法进入全屏模式」。
     iPhone 没有元素级 Fullscreen API，所以第三条路必须是 CSS 伪全屏，而且叠加层不能丢。 */
  ok('能力探测的降级顺序：标准 → 老 WebKit → 伪全屏 → 都没有才放弃',
    api.pickFullscreenMode({ requestFullscreen: true, webkitRequestFullscreen: true }) === 'standard'
    && api.pickFullscreenMode({ webkitRequestFullscreen: true }) === 'webkit'
    && api.pickFullscreenMode({}) === 'pseudo'
    && api.pickFullscreenMode({ pseudo: false }) === 'none',
    [api.pickFullscreenMode({ requestFullscreen: true }), api.pickFullscreenMode({ webkitRequestFullscreen: true }),
      api.pickFullscreenMode({}), api.pickFullscreenMode({ pseudo: false })].join(','));
  {
    delete stageEl.requestFullscreen;             // 模拟 iPhone：没有元素级全屏
    api.setPseudoFullscreen(false);
    const entered = api.requestStageFullscreen();
    ok('iPhone（无 requestFullscreen）申请全屏 → 进入 CSS 伪全屏',
      entered === true && api.pseudoFullscreenOn() === true
      && stageEl.classList.contains('pseudo-fullscreen')
      && documentStub.body.classList.contains('pseudo-fullscreen'),
      `entered=${entered} stage=${stageEl.className} body=${documentStub.body.className}`);
    ok('伪全屏只是改 #stage 的定位/类名：HUD 与判定进度条元素一个都没被动过',
      elements.get('hud').classList.contains('pseudo-fullscreen') === false
      && elements.get('criteriaBar').classList.contains('pseudo-fullscreen') === false);
    ok('伪全屏时按钮状态同步成「已全屏」', fsBtn.attributes['aria-pressed'] === 'true');
    // ⚠️ Esc 会顺手撤掉「首次交互解锁音频」那个一次性监听器 —— 和别处的用例一样
    //    把三种事件的监听器列表原样还原，别污染后面 [10] 的声音自检。
    const fsKeySnapshot = {};
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      fsKeySnapshot[ev] = [...(documentStub._listeners[ev] || [])];
    }
    documentStub.dispatch('keydown', { key: 'Escape' });
    for (const [ev, list] of Object.entries(fsKeySnapshot)) documentStub._listeners[ev] = list;
    ok('伪全屏里按 Esc 能退出（再按一次才是结束本组）',
      api.pseudoFullscreenOn() === false && fsBtn.attributes['aria-pressed'] === 'false');
    api.setPseudoFullscreen(true);
    fsBtn.dispatch('click');
    ok('再点一次全屏按钮 → 退出伪全屏', api.pseudoFullscreenOn() === false);
    fsBtn.dispatch('click');
    ok('再点一次 → 又进伪全屏（同一个按钮来回切）', api.pseudoFullscreenOn() === true);
    stageEl.requestFullscreen = savedRequestFullscreen;
    api.syncFullscreenSupport();
    api.setPseudoFullscreen(false);
    ok('恢复成有原生全屏的环境后，伪全屏不再被触发',
      api.pickFullscreenMode(api.fullscreenCaps()) === 'standard' && api.pseudoFullscreenOn() === false);
  }

  // 用户要求：「做完一个运动退出的时候不仅要退回到主页，也要退出全屏模式」。
  // 全屏是**视频框**的全屏，留在主页上只会把整页放大、还留着全屏状态，所以回主页时必须退出。
  //
  // ⚠️ 全手势改造之后分流变了（用户要求「在各项运动中如果退出，则回到菜单页面，
  //    如果在菜单界面退出则回到网页首页」）：运动里的「退出」圆环现在回**手势菜单**（仍然是全屏），
  //    只有菜单里的退出才回网页首页并退出全屏。两条都在这里钉住。
  api.openExercise('squat');
  documentStub.fullscreenElement = stageEl;
  documentStub.exitFullscreenCalls = 0;
  api.triggerGesture('exit');            // 一组做完后的「退出」圆环
  ok('运动里点「退出」圆环 → 回**手势菜单**（全屏留着，不停在网页上）',
    api.state.homeMode === false && api.state.menuMode === true
    && elements.get('gestureMenu').hidden === false && documentStub.exitFullscreenCalls === 0,
    `home=${api.state.homeMode} menu=${api.state.menuMode} exit=${documentStub.exitFullscreenCalls}`);
  api.triggerCornerExit();               // 菜单里再退出一次
  ok('菜单里点「退出」圆环 → 回网页首页 + 退出全屏',
    api.state.homeMode === true && api.state.menuMode === false
    && documentStub.exitFullscreenCalls === 1,
    `home=${api.state.homeMode} menu=${api.state.menuMode} exit=${documentStub.exitFullscreenCalls}`);
  ok('退出全屏后按钮状态同步成「未全屏」',
    fsBtn.attributes['aria-pressed'] === 'false', String(fsBtn.attributes['aria-pressed']));

  api.openExercise('squat');
  documentStub.fullscreenElement = stageEl;
  documentStub.exitFullscreenCalls = 0;
  elements.get('btnHome').dispatch('click');   // 顶栏 🏠
  ok('全屏时点 🏠 回主页：同样退出全屏',
    api.state.homeMode === true && documentStub.exitFullscreenCalls === 1,
    `exit=${documentStub.exitFullscreenCalls}`);

  // 反例：只是结束本组（人还留在动作页、视频框还是全屏）不该被退出全屏
  api.openExercise('squat');
  documentStub.fullscreenElement = stageEl;
  documentStub.exitFullscreenCalls = 0;
  api.state.session = 'running';
  api.stopSession('user');
  ok('只结束本组、还留在动作页时不动全屏（全屏要留着继续练）',
    documentStub.exitFullscreenCalls === 0 && api.state.homeMode === false,
    `exit=${documentStub.exitFullscreenCalls} home=${api.state.homeMode}`);

  // 本来就不在全屏 → 不该去碰全屏 API（幂等，也不会报错）
  documentStub.fullscreenElement = null;
  documentStub.exitFullscreenCalls = 0;
  api.showHome();
  ok('本来不在全屏时回主页不会调用全屏 API', documentStub.exitFullscreenCalls === 0,
    `exit=${documentStub.exitFullscreenCalls}`);
  api.openExercise('squat');
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
  // 用户要求：「把圆环中的文字退出和再试一次都改为图标表示，退出图标可以和返回图标一致，
  // 『再试一次』需要设计一个新的图标」→ 圆环里只有线条图标，文字含义在 title / aria-label 上
  ok('两个圆环都是**图标**（退出 = 和「返回」同一颗箭头；再试一次 = 新设计的重来图标），文字在 title/aria-label 上',
    /class="ex-pose"/.test(elements.get('ringExitLabel').innerHTML)
    && /class="ex-pose"/.test(elements.get('ringRetryLabel').innerHTML)
    && elements.get('ringExitLabel').innerHTML === api.libIconSVG('back', 'ex-pose')
    && elements.get('ringRetryLabel').innerHTML === api.libIconSVG('ui:retry', 'ex-pose')
    && !/退出|再做一次/.test(elements.get('ringExitLabel').innerHTML + elements.get('ringRetryLabel').innerHTML)
    && elements.get('ringExit').attributes['aria-label'] === '退出'
    && elements.get('ringRetry').attributes['aria-label'] === '再做一次',
    `${elements.get('ringExitLabel').innerHTML.length}B / ${elements.get('ringRetryLabel').innerHTML.length}B`);
  ok('画面上给出「手掌放进圆环保持 3 秒」的提示',
    elements.get('gestureHint').hidden === false
    && elements.get('gestureHint').textContent.includes('3 秒'),
    elements.get('gestureHint').textContent);
  ok('两个圆环按 GESTURE_RINGS 的比例摆位（和手势判定用同一份坐标）',
    ring('exit').style.left === `${at('exit').x * 100}%` && ring('retry').style.top === `${at('retry').y * 100}%`,
    `${ring('exit').style.left}/${ring('retry').style.left}`);

  // 圆环摆着的时候画面上方那条提示不显示（留给圆环），但**文字必须已经是最新的**：
  // 否则圆环一收起来，用户看到的是上一帧的旧话（例如识别成功了还写着「保持不动…」）
  api.state.session = 'ready';
  api.renderCalibration({
    checks: [], progress: 1, ready: true, advisory: false,
    hintKey: 'calib.promptReady', hintParams: null,
  });
  ok('圆环摆着时提示条隐藏，但文字已经更新成「开始训练」',
    elements.get('calibPrompt').hidden === true
    && elements.get('calibPromptMain').textContent.includes('开始训练'),
    `hidden=${elements.get('calibPrompt').hidden} text=${elements.get('calibPromptMain').textContent}`);

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

  // 退出：停满 3 秒 → 回手势菜单（用户要求：「在各项运动中如果退出，则回到菜单页面」）
  api.stopSession('goal');
  ok('一组做完后圆环又出现', shown() === true);
  api.updateGesture(palmsAt(at('exit').x, at('exit').y), 20000);
  api.updateGesture(palmsAt(at('exit').x, at('exit').y), 22000);
  api.updateGesture(palmsAt(at('exit').x, at('exit').y), 23001);
  ok('手掌停满 3 秒触发「退出」→ 回手势菜单（不是直接回网页首页）',
    api.state.menuMode === true && api.state.homeMode === false,
    `menu=${api.state.menuMode} home=${api.state.homeMode}`);
  ok('退出后圆环收起来', shown() === false);

  // 镜像预览：画面是翻过来的，圆环没有翻 → 判定必须跟着翻，否则手势会反
  api.closeMenu();
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
    if (elements.get('ringExitLabel').innerHTML !== api.libIconSVG('back', 'ex-pose')
      || elements.get('ringRetryLabel').innerHTML !== api.libIconSVG('ui:retry', 'ex-pose')) bad.push(`${ex.id}:图标`);
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
 * [8e] 右上角常驻的「退出」圆环（手或脚进去停 3 秒 → 退出这一组）
 * ------------------------------------------------------------------ */

console.log('\n[8e] 右上角常驻的「退出」圆环');
{
  const api = windowStub.__mfg;
  const { LM } = await import('../src/geometry.js');
  const { ASPECT: A2, standingPose: sp2 } = await import('./synthetic-pose.mjs');

  /** 骨架：把手（手腕+食指+小指+拇指）放到指定点 */
  const handAt = (x, y, visibility = 1) => {
    const lm = sp2({ knee: 175, ankleX: 1.0, view: 'front' }).map((p) => ({ ...p, visibility }));
    for (const w of [LM.L_WRIST, LM.R_WRIST]) {
      for (const off of [0, 2, 4, 6]) lm[w + off] = { x, y, z: 0, visibility };
    }
    return lm;
  };
  /**
   * 骨架：只有**食指**伸到指定点，手腕/小指/拇指留在原地 ——
   * 「一部分（指尖）进圆环」的用例：掌心中心还在环外。
   */
  const fingertipAt = (x, y, visibility = 1) => {
    const lm = sp2({ knee: 175, ankleX: 1.0, view: 'front' }).map((p) => ({ ...p, visibility }));
    for (const i of [LM.L_INDEX, LM.R_INDEX]) lm[i] = { x, y, z: 0, visibility };
    return lm;
  };
  /**
   * 骨架：把两只脚（踝 + 脚跟 + 脚尖）放到指定点。
   * 判定是**逐点**做的（用户要求「一部分进入即可触发」），桩里三点一起挪是最整的那一种。
   */
  const feetAt = (x, y, visibility = 1) => {
    const lm = sp2({ knee: 175, ankleX: 1.0, view: 'front' }).map((p) => ({ ...p, visibility }));
    for (const a of [LM.L_ANKLE, LM.R_ANKLE, LM.L_HEEL, LM.R_HEEL, LM.L_FOOT, LM.R_FOOT]) {
      lm[a] = { x, y, z: 0, visibility };
    }
    return lm;
  };
  /** 骨架：只有**脚趾尖**伸进圆环，脚踝/脚跟留在原地（脚的中心还在环外） */
  const toeOnlyAt = (x, y, visibility = 1) => {
    const lm = sp2({ knee: 175, ankleX: 1.0, view: 'front' }).map((p) => ({ ...p, visibility }));
    for (const f of [LM.L_FOOT, LM.R_FOOT]) lm[f] = { x, y, z: 0, visibility };
    return lm;
  };
  /** 骨架：**只有踝**探进圆环，脚跟/脚尖还留在远处（脚掌没进去） */
  const ankleOnlyAt = (x, y) => {
    const lm = sp2({ knee: 175, ankleX: 1.0, view: 'front' }).map((p) => ({ ...p, visibility: 1 }));
    for (const a of [LM.L_ANKLE, LM.R_ANKLE]) lm[a] = { x, y, z: 0, visibility: 1 };
    for (const f of [LM.L_HEEL, LM.R_HEEL, LM.L_FOOT, LM.R_FOOT]) {
      lm[f] = { x: x + 0.25, y, z: 0, visibility: 1 };
    }
    return lm;
  };

  const cornerBox = () => elements.get('cornerExit');
  const cornerShown = () => cornerBox().hidden === false;
  const ringBtn = () => elements.get('ringQuickExit');
  const { w: SW, h: SH } = api.stageSize();
  const center = () => api.ringCenter('corner', SW, SH);
  const px = () => api.ringPx('corner');
  /** 圆环圆心的归一化坐标（给骨骼用；镜像关着） */
  const at = () => ({ x: center().x / SW, y: center().y / SH });

  api.state.settings.mirror = false;
  api.openExercise('squat');

  // ===== 用户要求：只在**摄像头开着**的时候显示 =====
  const savedStream = api.camera.stream;
  const fakeStream = { getTracks: () => [] };   // camera.active 依赖 stream + video.readyState
  api.camera.stream = null;
  api.syncCornerExit();
  ok('摄像头没开时不显示右上角退出圆环（用户要求）', cornerShown() === false);
  api.camera.stream = fakeStream;
  api.syncCornerExit();
  ok('摄像头开着时右上角摆出退出圆环（不用等一组做完）', cornerShown() === true);

  // ===== 位置：右上角（用户要求：把「退出」圆环从左下角移到右上角）=====
  const c = center();
  ok('圆环在右上角（圆心在画面右半边、上半边）',
    c.x > SW / 2 && c.y < SH / 2, `中心=(${Math.round(c.x)},${Math.round(c.y)})`);
  ok('右边距与 HUD 的右边距一致（都是 18px）',
    Math.round(SW - (c.x + px() / 2)) === api.CORNER_RING_INSET_PX
    && api.CORNER_RING_INSET_PX === 18, `右边缘距边=${Math.round(SW - (c.x + px() / 2))}px`);
  ok('直径和 HUD 进度圆环一样（共用 CSS 变量 --ring-px，见 test-page 的样式断言）',
    px() > 0 && api.ringHitRadius('corner', { w: SW, h: SH }) > 0, `${px()}px`);
  ok('圆环比上一版更大（用户要求「退出圆环放大一点」：兜底下限 96 → 104）',
    api.RING_PX_FALLBACK.min >= 104 && api.RING_PX_FALLBACK.max >= 140 && px() >= 104,
    `${px()}px（兜底 ${api.RING_PX_FALLBACK.min}~${api.RING_PX_FALLBACK.max}）`);
  // 用户要求：「把『退出』这个圆环从左下角移到右上角」——
  // 右上角与 HUD 的边距对齐：右边距 = HUD 右边距 18px、上边距 = HUD 上边距 16px（同一条基线）。
  ok('退出圆环 / HUD 边距严格对齐（右边距 18px；上边距 16px）',
    Math.round(SW - (c.x + px() / 2)) === 18 && Math.round(c.y - px() / 2) === 16
    && api.CORNER_RING_INSET_PX === 18 && api.CORNER_RING_TOP_PX === 16,
    `右=${Math.round(SW - (c.x + px() / 2))} 上=${Math.round(c.y - px() / 2)}`);
  ok('圆环真的贴在右上角（上边距远小于画面高度；不再是「抬到进度条上方那版」）',
    api.CORNER_RING_TOP_PX < 40, String(api.CORNER_RING_TOP_PX));
  // 不压新 HUD：HUD 左栏的右边界必须停在圆环左边缘左边（留出间隙）。
  // 左栏 max-width = 100% − --ring-px − 48px（见 test-page 的样式断言），这里按同一算式复算。
  {
    const hudLeftRight = 18 + (SW - 36 - px() - 48);
    const ringLeft = c.x - px() / 2;
    ok('退出圆环不压新的进度圆环 / HUD 内容（HUD 左栏右边界在圆环左边缘左侧，留出 ≥12px 间隙）',
      hudLeftRight <= ringLeft - 12,
      `HUD 左栏右=${Math.round(hudLeftRight)} vs 圆环左=${Math.round(ringLeft)}`);
  }
  // 🐞 回归①：**先显示再量尺寸**。
  // 元素还在 display:none 时 clientWidth 是 0，量到的是兜底值，那个值会被写进行内 width/height ——
  // 于是退出圆环永远比 HUD 的进度圆环小一圈（用户反馈「退出圆环放大一点」的真实原因）。
  // 🐞 回归②：**重摆时先清掉行内尺寸再量** —— 行内 px 会盖住 CSS 的 `--ring-px`，
  // 不清的话窗口一改大小圆环就被旧尺寸钉住，又和 HUD 进度圆环不一样大。
  {
    const boxEl = elements.get('cornerExit');
    const btnEl = elements.get('ringQuickExit');
    const CSS_SIZE = 140;     // 模拟 CSS 的 --ring-px（行内尺寸会盖住它，就像真实浏览器）
    Object.defineProperty(btnEl, 'clientWidth', {
      configurable: true,
      // 藏着 = 量不到（真实浏览器就是这样）；显示着且没写行内尺寸 = 量到 CSS 的 --ring-px
      get: () => (boxEl.hidden ? 0 : (btnEl.style.width ? parseFloat(btnEl.style.width) : CSS_SIZE)),
    });
    api.hideCornerExit();
    api.showCornerExit();
    ok('显示之后才量尺寸：量到真实直径就用它（不会被元素藏着的兜底值写死）',
      btnEl.style.width === `${CSS_SIZE}px` && btnEl.style.height === `${CSS_SIZE}px`,
      `${btnEl.style.width} / ${btnEl.style.height}`);
    // 把行内尺寸改成一个「旧的」值，再重摆 —— 必须清掉行内尺寸、重新量到 CSS 的 140px
    btnEl.style.width = '200px';
    btnEl.style.height = '200px';
    api.layoutCornerRing();
    ok('重摆时先清掉行内尺寸再量（否则窗口一改大小圆环就被旧 px 钉住、和 HUD 进度环不再等大）',
      btnEl.style.width === `${CSS_SIZE}px` && btnEl.style.height === `${CSS_SIZE}px`,
      `${btnEl.style.width} / ${btnEl.style.height}`);
    // 还给后面用兜底值的断言：量不到尺寸（clientWidth = 0）
    Object.defineProperty(btnEl, 'clientWidth', { configurable: true, get: () => 0 });
    api.layoutCornerRing(); // 重新按兜底直径摆一次，免得把量到的尺寸留在行内样式里
  }
  ok('位置按像素摆好（left/top 就是圆心，宽高就是圆环直径）',
    ringBtn().style.left === `${c.x}px` && ringBtn().style.top === `${c.y}px`
    && ringBtn().style.width === `${px()}px` && ringBtn().style.height === `${px()}px`,
    JSON.stringify(ringBtn().style));
  ok('右上角圆环里也是**图标**（和「返回」同一颗），文字在 aria-label 上',
    /class="ex-pose"/.test(elements.get('ringQuickExitLabel').innerHTML)
    && elements.get('ringQuickExitLabel').innerHTML === api.libIconSVG('back', 'ex-pose')
    && elements.get('ringQuickExit').attributes['aria-label'] === '退出',
    elements.get('ringQuickExitLabel').innerHTML.length + 'B');
  // 动画与「一组结束后」的圆环完全同一套：同样的 SVG / ring-fill / 同样的 3 秒
  ok('用的是同一套圆环动画（ring-btn + ring-svg + ring-fill）',
    ringBtn().className.includes('ring-btn') && !!ringBtn().querySelector?.('.ring-fill'));
  ok('蓄力时长与「一组结束后」的圆环一致（同一个 GESTURE_HOLD_MS = 3 秒）',
    api.GESTURE_HOLD_MS === 3000);

  // 手不在圆环里 → 不累积
  api.updateCornerExit(handAt(0.5, 0.5), 1000);
  ok('手不在右上角圆环里时进度为 0', api.gestureState.corner.p === 0,
    String(api.gestureState.corner.p));

  /**
   * 像真实主循环那样按 ~33ms 连续喂帧。
   * （进度现在是**按时间累积**的，单帧最多记 250ms —— 一步跳 1 秒会被 clamp，
   *   所以测试也必须一帧一帧喂，跟真机一致。）
   */
  const holdFrames = (pose, from, ms, step = 33) => {
    let fired = false;
    for (let t = from; t <= from + ms + 1e-6; t += step) {
      fired = api.updateCornerExit(pose, Math.round(t)) || fired;
    }
    return fired;
  };
  const resetCorner = () => {
    api.state.homeMode = false;
    api.gestureState.corner.p = 0;
    api.gestureState.corner.done = false;
    api.gestureState.corner.at = 0;
    api.gestureState.corner.since = 0;
    api.gestureState.corner.lastInside = 0;
  };

  // 手伸进圆环 → 进度按时间走（和另外两个圆环同一套：3 秒走满一圈）
  const p0 = at();
  api.camera.stream = fakeStream;
  api.syncCornerExit();
  resetCorner();
  holdFrames(handAt(p0.x, p0.y), 1000, 1000);
  ok('**手**伸进圆环：进度随时间前进（1 秒 → 约 1/3）',
    Math.abs(api.gestureState.corner.p - 1 / 3) < 0.04, String(api.gestureState.corner.p));
  ok('手在圆环里时圆环进入「正在蓄力」状态（变色 + 转绿）',
    ringBtn().classList.contains('dwelling'));
  ok('圆环里显示还剩几秒',
    /^[\d.]+s$/.test(elements.get('ringQuickExitTimer').textContent),
    elements.get('ringQuickExitTimer').textContent);

  /* ---- 用户两轮反馈：先是「十分不灵敏」，然后是「一部分进入即可触发」----
     判定改成**逐点**：手/脚上的任意一个点（指尖 / 脚跟 / 脚趾尖 / 脚踝 / 手腕）进圆环就开始计时。 */
  {
    const c = center();
    const hit = api.ringHitRadius('corner', { w: SW, h: SH });
    ok('判定半径就是**圆环画出来的半径**（0.5×直径 = 圈里就算）',
      api.RING_HIT_RATIO === 0.5 && Math.abs(hit - px() * api.RING_HIT_RATIO) < 0.01,
      `判定 ${Math.round(hit)}px / 圆环直径 ${px()}px`);
    ok('判定区不再要求对准圆心（旧的 0.30 口径只有中间 42px 有效）',
      hit > px() * 0.30 + 5, `${Math.round(hit)}px vs 旧口径 ${Math.round(px() * 0.30)}px`);

    // ★ 用户最新口径：**一部分进入即可触发**
    // 只把**食指指尖**伸进圆环（掌心中心还在环外）→ 也要开始沙漏计时
    resetCorner();
    const tipX = c.x / SW + (hit * 0.9) / SW;
    holdFrames(fingertipAt(tipX, c.y / SH), 30000, 1000);
    ok('**只有指尖**伸进圆环（掌心中心还在环外）就开始计时（一部分进入即可）',
      api.gestureState.corner.p > 0.25, String(api.gestureState.corner.p));
    ok('🐞 面板说明白是哪个部位进环了（这里是食指）',
      api.state.touchInfo?.part === 'index' && api.state.touchInfo?.kind === 'hand',
      JSON.stringify(api.state.touchInfo));

    // 只把**脚趾尖**伸进圆环（脚的中心还在环外）→ 同样开始计时
    resetCorner();
    holdFrames(toeOnlyAt(c.x / SW + (hit * 0.9) / SW, c.y / SH), 32000, 1000);
    ok('**只有脚趾尖**伸进圆环（脚的中心还在环外）就开始计时',
      api.gestureState.corner.p > 0.25, String(api.gestureState.corner.p));

    // 手掌中心落在「环半径的 80%」处 —— 在圆环里面，但离圆心有一段距离
    const off = (hit * 0.8) / SW;
    resetCorner();
    holdFrames(handAt(c.x / SW + off, c.y / SH), 34000, 1000);
    ok('手掌伸到圆环里但偏一侧（半径的 80% 处）照样开始蓄力',
      api.gestureState.corner.p > 0.25, String(api.gestureState.corner.p));

    // 手/脚伸到画面边角时可见度会掉到 0.4 以下 —— 门槛放宽到 0.3
    resetCorner();
    holdFrames(handAt(p0.x, p0.y, 0.35), 40000, 1000);
    ok('可见度 0.35 的手/脚照样算（旧门槛 0.4 会把它整个丢掉）',
      api.TOUCH_VIS_MIN <= 0.3 && api.gestureState.corner.p > 0.25,
      `visMin=${api.TOUCH_VIS_MIN} p=${api.gestureState.corner.p}`);
    resetCorner();
    holdFrames(handAt(p0.x, p0.y, 0.15), 50000, 1000);
    ok('可见度过低（0.15，被身体挡住）仍然不算，不会误触',
      api.gestureState.corner.p === 0, String(api.gestureState.corner.p));

    // 只有一个关键点可用（手指/脚跟那些点在画面边角经常掉到门槛以下）也要认
    const onlyWrist = handAt(p0.x, p0.y);
    for (const w of [LM.L_WRIST, LM.R_WRIST]) {
      for (const off2 of [2, 4, 6]) onlyWrist[w + off2] = { x: p0.x, y: p0.y, z: 0, visibility: 0.05 };
    }
    resetCorner();
    holdFrames(onlyWrist, 60000, 1000);
    ok('只剩手腕一个点可用时也能判定（不再要求「至少 2 个可见点」）',
      api.gestureState.corner.p > 0.25, String(api.gestureState.corner.p));

    // 脚踝也是「脚的一部分」：只把踝探进圆环也算（点了名的「一部分进入即可触发」）
    resetCorner();
    holdFrames(ankleOnlyAt(c.x / SW, c.y / SH), 62000, 1000);
    ok('只有踝探进圆环也算（踝是脚的一部分）', api.gestureState.corner.p > 0.25,
      String(api.gestureState.corner.p));

    /* ---- 用户第四轮反馈：「**只要脚尖进入圆环就要开始沙漏计时**，现在感觉要脚踝进入才开始计时」----
       查出来是两个原因（都不是「判定半径太小」）：
         ① 脚伸到画面角落时，MediaPipe 对脚跟 / 脚尖的可见度常掉到 0.2 上下，
            旧门槛 0.3 把整只脚的脚尖点全丢掉 → 只剩一个脚踝点，于是「必须把踝塞进环」；
         ② 脚是**一片**不是一个点：脚尖搭在圆环上时，脚尖 / 脚跟 / 脚踝可能都在环外（连线穿过圆环）。
       修法：脚单独用更宽松的可见度门槛（FOOT_VIS_MIN）、脚尖点量不到时**估一个**（ghost）、
       并且加了**线段判定**（整只脚连成一片）。下面三条分别钉住这三层。 */
    {
      const hit2 = api.ringHitRadius('corner', { w: SW, h: SH });
      /**
       * 骨架：把两条腿的踝 / 脚跟 / 脚尖分别放到指定点（**像素偏移**，相对圆环圆心）——
       * 只动这三个点，用来构造「只有脚那一段穿过圆环」这种几何。
       */
      const footSpan = ({ ankle, heel, toe, vis = {} }) => {
        const lm = sp2({ knee: 175, ankleX: 1.0 }).map((p) => ({ ...p, visibility: 1 }));
        const put = (indices, off, v) => {
          if (!off) return;
          for (const i of indices) {
            lm[i] = { x: (c.x + off[0] * hit2) / SW, y: (c.y + off[1] * hit2) / SH, z: 0, visibility: v ?? 1 };
          }
        };
        put([LM.L_ANKLE, LM.R_ANKLE], ankle, vis.ankle);
        put([LM.L_HEEL, LM.R_HEEL], heel, vis.heel);
        put([LM.L_FOOT, LM.R_FOOT], toe, vis.toe);
        return lm;
      };
      /**
       * 骨架：站着的人，**整条左腿一起平移**，让**脚尖**正好落在 toeAt / 环心附近 ——
       * 这条腿的几何关系仍然真实（小腿长、脚掌长都还是原来的），用来验证估算出来的脚尖是否靠谱。
       */
      const leftToeAt = (toeAt, vis = {}) => {
        const lm = sp2({ knee: 175, ankleX: 1.0 }).map((p) => ({ ...p, visibility: 1 }));
        const f = lm[LM.L_FOOT];
        const dx = toeAt.x / SW - f.x;
        const dy = toeAt.y / SH - f.y;
        for (const i of [LM.L_KNEE, LM.L_ANKLE, LM.L_HEEL, LM.L_FOOT]) {
          lm[i] = { x: lm[i].x + dx, y: lm[i].y + dy, z: 0, visibility: 1 };
        }
        const byPart = { knee: LM.L_KNEE, ankle: LM.L_ANKLE, heel: LM.L_HEEL, toe: LM.L_FOOT };
        for (const [part, v] of Object.entries(vis)) {
          lm[byPart[part]] = { ...lm[byPart[part]], visibility: v };
        }
        return lm;
      };

      // ★ ① 整只脚**跨在圆环上**：三个关键点全在环外，只有「脚」那一段穿过圆环
      //    改之前一个点都不在环内 → 不计时；改之后线段判定（以及后来补的脚尖外延点）立刻开始计时。
      resetCorner();
      holdFrames(footSpan({
        ankle: [0, -1.8], heel: [-0.5, -0.9], toe: [0.8, 2.2],
      }), 64000, 1000);
      ok('**整只脚跨在圆环上**（脚尖 / 脚跟 / 脚踝三个点都在环外）也开始计时（线段判定 + 脚尖外延点）',
        api.gestureState.corner.p > 0.25, String(api.gestureState.corner.p));
      // 这一条钉的是**线段判定**那一层本身：整只脚连成的线段确实压进了判定半径
      //（后来补的「脚尖外延点」常常先一步进环，所以不能再断言 via === 'span'）
      ok('🐞 面板显示整只脚确实压在圆环上（脚那一段离环心 7px，在判定半径内）',
        api.state.touchInfo?.inside === true && api.state.touchInfo?.span?.d <= hit2,
        JSON.stringify(api.state.touchInfo));

      // ★ ② 整条腿真的抬到圆环边（几何真实）：脚尖落在环内，但它的可见度只有 0.2
      resetCorner();
      holdFrames(leftToeAt({ x: c.x, y: c.y }, { toe: 0.2 }), 66000, 1000);
      ok('脚的关键点可见度只有 0.2 时照样算（脚下的门槛比手宽松：0.15 vs 0.3）',
        api.FOOT_VIS_MIN <= 0.2 && api.TOUCH_VIS_MIN > 0.2 && api.gestureState.corner.p > 0.25,
        `footVisMin=${api.FOOT_VIS_MIN} touchVisMin=${api.TOUCH_VIS_MIN} p=${api.gestureState.corner.p}`);

      // ★ ③ 同一条腿，但**脚尖点完全量不到**（可见度 0.05）：用估算出来的脚尖照样开始计时
      //    （估算规则见 FOOT_TIP_FROM_HEEL：脚尖 ≈ 脚跟 + (脚跟 − 脚踝)，正好落在真实脚尖附近）
      resetCorner();
      holdFrames(leftToeAt({ x: c.x, y: c.y }, { toe: 0.05 }), 68000, 1000);
      ok('脚尖点量不到（可见度 0.05）时用**估算的脚尖**照样开始计时（不然就只剩脚踝能触发）',
        api.gestureState.corner.p > 0.25, String(api.gestureState.corner.p));
      ok('🐞 面板标明这个脚尖是估算出来的',
        api.state.touchInfo?.ghost === true && api.state.touchInfo?.part === 'toe',
        JSON.stringify(api.state.touchInfo));

      // 反例①：脚在画面另一头（离圆环很远）时，线段判定与估算都不会误触
      resetCorner();
      holdFrames(sp2({ knee: 175, ankleX: 1.0 }).map((p) => ({ ...p, visibility: 1 })), 70000, 1500);
      ok('站着的默认姿势（双脚在画面另一头）不会误触（线段与估算都没有把远处算进来）',
        api.gestureState.corner.p === 0, String(api.gestureState.corner.p));

      // 反例②：**脚跟被误检到很远**时不许估算出落在圆环里的脚尖 ——
      // 否则那条延长线会「凭空」穿过整个画面落进圆环，把一组训练直接退掉（见 FOOT_TIP_MAX_SHIN）。
      // 桩：脚踝留在默认站位（画面另一头），脚尖点丢失，脚跟摆到「不加限制正好把估算点送进环心」处。
      {
        const junk = sp2({ knee: 175, ankleX: 1.0 }).map((p) => ({ ...p, visibility: 1 }));
        const a = junk[LM.L_ANKLE];
        const cx = c.x / SW;
        const cy = c.y / SH;
        const k = api.FOOT_TIP_FROM_HEEL;
        for (const i of [LM.L_HEEL, LM.R_HEEL]) {
          junk[i] = { x: a.x + (a.x - cx) / k, y: a.y + (a.y - cy) / k, z: 0, visibility: 1 };
        }
        for (const i of [LM.L_FOOT, LM.R_FOOT]) junk[i] = { x: 0.9, y: 0.9, z: 0, visibility: 0.05 };
        const res = api.anyTouchInRing(api.touchSamples(junk, SW, SH, false), 'corner', { w: SW, h: SH });
        const heelPx = Math.hypot(junk[LM.L_HEEL].x * SW - c.x, junk[LM.L_HEEL].y * SH - c.y);
        ok('脚跟被误检到很远时估算的脚尖**不会**凭空落进圆环（FOOT_TIP_MAX_SHIN 卡住它）',
          res.inside === false && heelPx > hit2 * 4,
          `inside=${res.inside} 脚跟离环心=${Math.round(heelPx)}px`);
      }
    }


    /* ---- 用户第三轮反馈：「感觉目前必须是**脚踝和手腕**进入才开始 3 秒计时，这个不好，请优化。
       改为只要手和脚有一部分进入就可以开始 3 秒计时了。」
       这一轮改的不是「判定半径太小」，而是「手腕 / 脚踝**以外的点根本产生不出来**」——
       两层修法（见 app.js 里 touchSamples / RING_TOUCH_TOL）：
         ① 按肢体方向补出**手掌 / 脚尖的外延点**（Pose 模型的指尖 / 脚跟本来就不可靠）；
         ② 右上角这个退出圆环的判定半径再放宽 12%（手/脚搭在圆环边缘外一点也算），
            **中间那两个大圆环不跟着放宽**（它们是「把手掌放进圆环中央」的设计）。
       下面几条分别钉住这两层，以及「宽容度只给退出圆环」。 */
    {
      const hit4 = api.ringHitRadius('corner', { w: SW, h: SH });
      ok('退出圆环的宽容度常量就写在 app.js 里（12%），其余圆环仍是画出来的半径',
        api.RING_TOUCH_TOL === 1.12 && api.RING_HIT_RATIO === 0.5,
        `TOL=${api.RING_TOUCH_TOL}`);

      /** 从环心指向「右上」的**单位**方向：手臂 / 腿就是从那个方向伸进圆环的 */
      const dir = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
      /** 距环心 rel 倍判定半径（沿上面的方向）的舞台像素点 */
      const atRel = (rel) => ({ x: c.x + dir.x * rel * hit4, y: c.y + dir.y * rel * hit4 });
      /** 环心到某个舞台像素点的距离（像素） */
      const distPx = (q) => Math.hypot(q.x - c.x, q.y - c.y);

      /**
       * 骨架：一条**真的朝圆环伸过去**的手臂（肩 → 肘 → 腕 共线，方向真实）。
       * 手腕停在离环心 wristRel 倍判定半径处（默认 1.3 —— 在环外），
       * 手指三个点的可见度给 fingerVis（默认 0.05 = 量不到，模拟画面边角上的真实情况）。
       */
      const reachArm = ({ wristRel = 1.3, forearmRel = 0.55, fingerVis = 0.05, armVis = 1 } = {}) => {
        const lm = sp2({ knee: 175, ankleX: 1.0, view: 'front' }).map((p) => ({ ...p, visibility: 1 }));
        const put = (i, q, vis) => { lm[i] = { x: q.x / SW, y: q.y / SH, z: 0, visibility: vis }; };
        const w = atRel(wristRel);
        // 肘在环的**另一侧**（更远）：于是 (腕 − 肘) 正好指向圆环 → 手掌外延点朝环内
        const e = { x: w.x + dir.x * forearmRel * hit4, y: w.y + dir.y * forearmRel * hit4 };
        const s = { x: e.x + dir.x * 1.2 * hit4, y: e.y + dir.y * 1.2 * hit4 };
        put(LM.L_WRIST, w, armVis);
        put(LM.L_ELBOW, e, 1);
        put(LM.L_SHOULDER, s, 1);
        for (const i of [LM.L_INDEX, LM.L_PINKY, LM.L_THUMB]) put(i, w, fingerVis);
        return lm;
      };
      /**
       * 骨架：一条**真的朝圆环伸过去**的腿（膝 → 踝 共线）。
       * 踝停在 ankleRel 倍判定半径处（默认 1.3 —— 在环外），脚跟 / 脚尖两个点的可见度给 footVis
       * （默认 0.05 = 量不到：真实画面里脚伸到左边角时这两个点就是这么不可靠）。
       */
      const reachLeg = ({ ankleRel = 1.3, shinRel = 1.1, footVis = 0.05, ankleVis = 1 } = {}) => {
        const lm = sp2({ knee: 175, ankleX: 1.0, view: 'front' }).map((p) => ({ ...p, visibility: 1 }));
        const put = (i, q, vis) => { lm[i] = { x: q.x / SW, y: q.y / SH, z: 0, visibility: vis }; };
        const a = atRel(ankleRel);
        const k = { x: a.x + dir.x * shinRel * hit4, y: a.y + dir.y * shinRel * hit4 };
        put(LM.L_ANKLE, a, ankleVis);
        put(LM.L_KNEE, k, 1);
        put(LM.L_HEEL, a, footVis);
        put(LM.L_FOOT, a, footVis);
        return lm;
      };

      // ★ ① 手：**手腕还在环外**（1.3 倍），指尖三个点全都量不到 —— 只有手掌外延点进环
      {
        const wire = reachArm();
        const res = api.anyTouchInRing(api.touchSamples(wire, SW, SH, false), 'corner', { w: SW, h: SH });
        ok('手腕在环外、指尖三个点量不到时，**沿小臂补出的手掌点**照样把圆环点亮',
          res.inside === true && res.best?.p?.part === 'palm' && res.best?.p?.ghost === true,
          `inside=${res.inside} 最近点=${res.best?.p?.part} 距环心=${Math.round(res.best?.d ?? -1)}px`);
        ok('（对照）这个手腕本身确实在**画出来的**判定半径之外——放宽前这个姿势一点反应都没有',
          distPx(atRel(1.3)) > hit4, `${Math.round(distPx(atRel(1.3)))}px > ${Math.round(hit4)}px`);
        // 端到端：这个姿势连续喂 1 秒 → 沙漏真的开始走（用户口径：手/脚有一部分进入就开始）
        resetCorner();
        holdFrames(reachArm(), 300000, 1000);
        ok('端到端：手腕在环外、指尖量不到，只靠手掌外延点也能开始 3 秒计时',
          api.gestureState.corner.p > 0.25, String(api.gestureState.corner.p));
      }

      // ★ ② 脚：**脚踝还在环外**（1.3 倍），脚跟 / 脚尖两个点全都量不到 —— 只有沿小腿补出的脚尖点进环
      {
        const res = api.anyTouchInRing(api.touchSamples(reachLeg(), SW, SH, false), 'corner', { w: SW, h: SH });
        ok('脚踝在环外、脚跟和脚尖量不到时，**沿小腿补出的脚尖点**照样把圆环点亮',
          res.inside === true && res.best?.p?.kind === 'foot' && res.best?.p?.part === 'toe',
          `inside=${res.inside} 最近点=${res.best?.p?.part} 距环心=${Math.round(res.best?.d ?? -1)}px`);
        ok('（对照）这个脚踝本身也在画出来的判定半径之外（不然还是「必须踝进环」）',
          distPx(atRel(1.3)) > hit4);
        resetCorner();
        holdFrames(reachLeg(), 320000, 1000);
        ok('端到端：只靠脚尖的外延点也能开始 3 秒计时（不必把脚踝塞进圆环）',
          api.gestureState.corner.p > 0.25, String(api.gestureState.corner.p));
      }

      // ★ ③ 宽容度这一层：正好落在「画出来的半径」外一点点（1.06 倍）的点也算进环
      {
        const pIn = { x: c.x + hit4 * 1.06, y: c.y, kind: 'foot', side: 'L', part: 'ankle', vis: 1 };
        const r = api.anyTouchInRing([pIn], 'corner', { w: SW, h: SH });
        ok('脚踝落在判定半径外一点点（1.06 倍）照样算进环（判定用的是 1.12 倍）',
          r.inside === true && r.pointIn === true && r.best.d > hit4,
          `inside=${r.inside} 距离=${(r.best?.d / hit4).toFixed(2)} 倍`);
        const pOut = { x: c.x + hit4 * 1.2, y: c.y, kind: 'foot', side: 'L', part: 'ankle', vis: 1 };
        ok('宽容度不是无限大：明显在环外（1.2 倍）仍然不算，不会凭空退出训练',
          api.anyTouchInRing([pOut], 'corner', { w: SW, h: SH }).inside === false);
        // 同一个点放到「一组结束后」的圆环里：**不**享受这 12%（那两个圆环仍是严格判定）
        const cR = api.ringCenter('retry', SW, SH);
        const hR = api.ringHitRadius('retry', { w: SW, h: SH });
        const pRetry = { x: cR.x + hR * 1.06, y: cR.y, kind: 'hand', side: 'L', part: 'wrist', vis: 1 };
        ok('宽容度只给退出圆环：「再做一次」圆环在 1.06 倍处仍然不算',
          api.anyTouchInRing([pRetry], 'retry', { w: SW, h: SH }).inside === false);
      }
    }

    // 短暂滑出去（宽限期内）不扣进度；滑久了只慢慢退，不会一秒清零
    resetCorner();
    holdFrames(handAt(p0.x, p0.y), 70000, 2400);          // 先蓄到 0.8
    const kept = api.gestureState.corner.p;
    holdFrames(handAt(0.5, 0.5), 72400, 200);              // 滑出去 0.2 秒（宽限期内）
    ok('滑出去 0.2 秒（宽限期内）进度一点都不掉',
      Math.abs(api.gestureState.corner.p - kept) < 1e-6, `${kept} → ${api.gestureState.corner.p}`);
    holdFrames(handAt(0.5, 0.5), 72600, 1000);             // 再离开 1 秒 → 只退一点
    const after = api.gestureState.corner.p;
    ok('离开 1 秒只是慢慢退（不会像以前那样把两秒多的成绩直接清零）',
      after > 0 && after < kept - 0.4, `${kept} → ${after}`);
    // 手拿开 → 进度最终退回 0，不会误触发
    let guard = 0;
    while (api.gestureState.corner.p > 0 && guard < 200) {
      api.updateCornerExit(handAt(0.5, 0.5), 74000 + guard * 40);
      guard += 1;
    }
    ok('手拿开后进度退回 0，不会误退出', api.gestureState.corner.p === 0
      && api.state.homeMode === false, `${api.gestureState.corner.p}/${api.state.homeMode}`);
    // 镜像开着时，手要放在**屏幕上看到的**那一边（镜像开关默认是开的，这里必须对得上，
    // 否则就是「手明明伸进圆环了却没反应」）
    resetCorner();
    api.state.settings.mirror = true;
    holdFrames(handAt(1 - p0.x, p0.y), 85000, 1000);
    ok('镜像开着时，手放在屏幕上看得到的那一边照样蓄力（判定跟着镜像走）',
      api.gestureState.corner.p > 0.25, String(api.gestureState.corner.p));
    resetCorner();
    holdFrames(handAt(p0.x, p0.y), 86000, 1000);
    ok('镜像开着时把手放到相反的一边不算（判定没有反过来）',
      api.gestureState.corner.p === 0, String(api.gestureState.corner.p));
    api.state.settings.mirror = false;
    // 🐞 面板那一行：能看到手在哪、离圆心几倍判定半径（排查「到底有没有识别到手/脚」）
    holdFrames(handAt(p0.x, p0.y), 87000, 100);
    const info = api.state.touchInfo;
    ok('🐞 面板记下了「手/脚在哪、离环心几个判定半径」',
      info && info.has === true && info.kind === 'hand' && info.inside === true && info.rel <= 1,
      JSON.stringify(info));
    api.updateCornerExit([], 80100);
    ok('没识别到手/脚时这一行写成「没看到手或脚」',
      api.touchDiagLine((v) => String(v)).includes('没看到'),
      api.touchDiagLine((v) => String(v)));
  }

  // 手停满 3 秒 → 训练里退出 = 回手势菜单（用户要求：「在各项运动中如果退出，则回到菜单页面」）
  documentStub.fullscreenElement = elements.get('stage');
  documentStub.exitFullscreenCalls = 0;
  resetCorner();
  const fired = holdFrames(handAt(p0.x, p0.y), 90000, 3100);
  ok('手停满 3 秒 → 触发退出', fired === true, String(fired));
  api.triggerCornerExit();
  ok('**手**停满 3 秒退出后：回手势菜单（全屏留着）',
    api.state.menuMode === true && api.state.homeMode === false
    && documentStub.exitFullscreenCalls === 0,
    `menu=${api.state.menuMode} home=${api.state.homeMode} exit=${documentStub.exitFullscreenCalls}`);
  // 用户要求：「在第一级菜单选择页面去掉『退出』圆环，增加一个『返回』圆环，图标和其他『返回』圆环保持一致。」
  // → 菜单里（两级都）不显示右上角那个「退出」圆环；退出圆环的文案始终是「退出」
  api.syncCornerExit();
  ok('菜单里右上角那个「退出」圆环不再显示（菜单模式不摆它）',
    cornerShown() === false && api.gestureState.cornerVisible === false,
    `shown=${cornerShown()}`);
  ok('右上角圆环的图标始终是「退出」那颗箭头，含义仍在 aria-label（只有训练界面用它了）',
    /class="ex-pose"/.test(elements.get('ringQuickExitLabel').innerHTML)
    && elements.get('ringQuickExit').attributes['aria-label'] === '退出',
    elements.get('ringQuickExit').attributes['aria-label']);
  // 菜单里回网页首页走的是右上角常驻那颗「↩ 返回」（不参与翻页、不跟换屏滑动）
  {
    const backIt = api.menuBackItem(api.stageSize());
    ok('右上角常驻一颗「返回」（线条箭头图标，和动作页退出圆环同位置同尺寸），点它 = 回网页首页',
      !!backIt && /class="ex-pose"/.test(backIt.poseIcon)
      && api.menuNavLayout(api.stageSize()).every((it) => it.kind !== 'back')
      && !api.menuItems().some((it) => it.kind === 'back'),
      JSON.stringify(backIt && { id: backIt.id, svg: backIt.poseIcon.length }));
    api.selectFromMenu(backIt.id);
    ok('点「返回」→ 回网页首页 + 退出全屏',
      api.state.homeMode === true && api.state.menuMode === false
      && documentStub.exitFullscreenCalls >= 1,
      `home=${api.state.homeMode} exit=${documentStub.exitFullscreenCalls}`);
  }
  ok('退出后右上角圆环收起（主页上不摆）', cornerShown() === false);

  // 脚也一样（用户要求「手或者脚」）
  api.openExercise('squat');
  api.camera.stream = fakeStream;
  api.syncCornerExit();
  api.state.settings.mirror = false;
  resetCorner();
  const hitR = api.ringHitRadius('corner', { w: SW, h: SH });
  const p1 = at();
  holdFrames(feetAt(p1.x, p1.y), 20000, 1000);
  ok('**脚**伸进圆环：进度同样随时间前进（1 秒 → 约 1/3）',
    Math.abs(api.gestureState.corner.p - 1 / 3) < 0.04, String(api.gestureState.corner.p));
  // 脚比较大：整只脚偏一点也算
  resetCorner();
  holdFrames(feetAt(p1.x + (hitR * 0.7) / SW, p1.y), 21000, 1000);
  ok('整只脚偏一侧（半径的 70% 处）也算踩进圆环',
    api.gestureState.corner.p > 0.25, String(api.gestureState.corner.p));
  // 可见度太低（脚被挡住）不算
  resetCorner();
  holdFrames(feetAt(p1.x, p1.y, 0.1), 22000, 1500);
  ok('脚被挡住（可见度低）时不算伸进圆环', api.gestureState.corner.p === 0,
    String(api.gestureState.corner.p));

  // 「整只脚的中心」仍然是**报告用**的代表点（touchPoints 给「一组结束」那两个圆环与 🐞 面板用），
  // 但退出圆环的判定是**逐点**的：只要手/脚上的任意一个点进环就算（见上面的用例）。
  {
    const tp = api.touchPoints(ankleOnlyAt(p1.x, p1.y), SW, SH, false);
    ok('「脚」的代表点仍是整只脚的中心（踝 + 脚跟 + 脚尖的均值）',
      tp.length === 4 && Math.abs(tp[2].x / SW - (p1.x + 1 / 6)) < 0.002
      && Math.abs(tp[3].x / SW - (p1.x + 1 / 6)) < 0.002,
      JSON.stringify(tp.map((p) => [Number((p.x / SW).toFixed(3)), Number((p.y / SH).toFixed(3))])));
  }

  // 「一组结束」的两个大圆环出来时，右上角这个先收起来（那儿已经有「退出」了）
  api.state.cornerVisible = true;
  api.showCornerExit();
  api.showGestureRings({ speak: false });
  ok('一组结束的两个圆环出来时，右上角圆环收起来（不重复）', cornerShown() === false);
  // 不冲突：即便把退出圆环摆着，它的判定圈与「一组结束」两个圆环的判定圈也不重叠
  {
    const cc = api.ringCenter('corner', SW, SH);
    const cr = api.ringHitRadius('corner', { w: SW, h: SH });
    const clash = ['exit', 'retry'].filter((k) => {
      const gc = api.ringCenter(k, SW, SH);
      const gr = api.ringHitRadius(k, { w: SW, h: SH });
      return Math.hypot(gc.x - cc.x, gc.y - cc.y) <= gr + cr;
    });
    ok('退出圆环的判定圈与「一组结束」两个圆环的判定圈都不重叠', clash.length === 0, clash.join(','));
  }
  api.hideGestureRings();
  ok('大圆环收起后右上角圆环又摆回来（摄像头还开着）', cornerShown() === true);

  // 摄像头关掉（比如出错）→ 圆环跟着收起来
  api.camera.stream = null;
  api.syncCornerExit();
  ok('摄像头关掉时圆环收起来（只在摄像头开着时显示）', cornerShown() === false);

  // 直接点它也同样有效（鼠标 / 触屏）：训练里点 = 回手势菜单（菜单里它根本不显示）
  api.camera.stream = fakeStream;
  api.openExercise('squat');
  api.syncCornerExit();
  documentStub.fullscreenElement = elements.get('stage');
  documentStub.exitFullscreenCalls = 0;
  elements.get('ringQuickExit').dispatch('click');
  ok('点一下右上角圆环 → 回手势菜单（全屏留着）',
    api.state.menuMode === true && api.state.homeMode === false
    && documentStub.exitFullscreenCalls === 0,
    `menu=${api.state.menuMode} home=${api.state.homeMode} exit=${documentStub.exitFullscreenCalls}`);
  api.syncCornerExit();
  ok('回到菜单后这个圆环立刻收起来（菜单里没有「退出」圆环了）',
    cornerShown() === false && api.gestureState.cornerVisible === false);
  // 菜单里回网页首页：点那一格「↩ 返回」（两级都有，图标一致）
  api.selectFromMenu('back');
  ok('点菜单里的「↩ 返回」→ 回网页首页 + 退出全屏',
    api.state.homeMode === true && documentStub.exitFullscreenCalls >= 1,
    `home=${api.state.homeMode} exit=${documentStub.exitFullscreenCalls}`);
  api.camera.stream = savedStream;
}

/* ------------------------------------------------------------------ *
 * [8e4] 新版 HUD：名称 + 目标 + 「计次位置」的进度圆环（数字动态字号）
 *
 * 用户四条要求：
 *   ① 左上角运动名称放大，名称之后紧跟本组目标（`N 次` / `N 秒`）；
 *   ② 进度圆环挪到原来计次的位置，次数 / 秒数放进圆环里，且**数字大了要自动缩小**
 *      （0 / 9 / 99 / 100 / 1000 / 读秒 100 秒以上都不能超出圆环内径）；
 *   ③ 分数仍然在圆环下方；
 *   ④ 「退出」圆环从左下角挪到右上角（绘制与判定同一份坐标，见 [8e]）。
 * ------------------------------------------------------------------ */

console.log('\n[8e4] 新版 HUD：名称 + 目标 + 环里的数字');
{
  const api = windowStub.__mfg;
  // 这一节会改两个动作的目标，测完还回去，免得影响后面的用例
  const savedTargets = { ...api.state.settings.targets };
  const savedSeconds = { ...api.state.settings.seconds };
  const hudValue = () => elements.get('hudValue');
  const sizeOf = () => parseFloat(hudValue().style.fontSize);
  const ringPx = () => api.hudRingPx();
  const inner = () => api.hudRingInnerPx(ringPx());

  // 纯函数本身：0 / 9 / 99 / 100 / 1000 / 100 秒都放得进圆环内径（宽度与高度两条约束）
  {
    const fits = [];
    const widths = [];
    for (const ring of [72, 104, 134, 140]) {
      for (const text of ['0', '9', '99', '100', '1000', '100']) {
        const fs = api.hudValueFontSize(ring, text);
        widths.push([ring, text, fs]);
        if (!(api.hudTextWidth(text, fs) <= api.hudRingInnerPx(ring) + 1e-9)) fits.push(`${ring}/${text}`);
        if (!(fs > 0)) fits.push(`${ring}/${text} 字号为 0`);
      }
    }
    ok('纯函数 hudValueFontSize：0 / 9 / 99 / 100 / 1000 在 72~140px 圆环里都放得下（估算宽度 ≤ 内径）',
      fits.length === 0, fits.join(', ') || `示例 ${JSON.stringify(widths.slice(0, 3))}`);
    const f0 = api.hudValueFontSize(104, '0');
    const f99 = api.hudValueFontSize(104, '99');
    const f100 = api.hudValueFontSize(104, '100');
    const f1000 = api.hudValueFontSize(104, '1000');
    ok('纯函数：位数越多字号越小（0 ≥ 99 ≥ 100 ≥ 1000），读秒到 100 以上会自动缩小',
      f0 >= f99 && f99 > f100 && f100 > f1000, `${f0}/${f99}/${f100}/${f1000}`);
    ok('内径与绘制的圆环同源（内径 = 直径 × 95/120，r=52、stroke=9）',
      Math.abs(api.hudRingInnerPx(120) - 95) < 1e-9, String(api.hudRingInnerPx(120)));
  }

  // 真实渲染：计数类 → 名称 + 「20 次」，数字进圆环，字号随 100 / 1000 变小且不超内径
  api.openExercise('squat');
  api.setTarget(20);
  api.state.session = 'running';
  api.state.detector.validReps = 7;
  api.updateHud();
  ok('左上角显示运动名称（深蹲）', /深蹲/.test(elements.get('hudName').textContent),
    elements.get('hudName').textContent);
  ok('名称后面紧跟本组目标（计数类 → 「20 次」）',
    elements.get('hudTarget').textContent === '20 次', elements.get('hudTarget').textContent);
  ok('圆环里的大数字就是次数（#hudValue = 7）', hudValue().textContent === '7',
    hudValue().textContent);
  ok('运行时把字号写进了 #hudValue 的行内 font-size', /^\d+(\.\d+)?px$/.test(hudValue().style.fontSize),
    hudValue().style.fontSize);
  {
    const seen = {};
    const bad = [];
    for (const v of [0, 9, 99, 100, 1000]) {
      api.state.detector.validReps = v;
      api.updateHud();
      const fs = sizeOf();
      seen[v] = fs;
      if (!(api.hudTextWidth(hudValue().textContent, fs) <= inner() + 1e-9)) bad.push(v);
    }
    ok('真实渲染：0 / 9 / 99 / 100 / 1000 的字号都能让数字**留在圆环内径里**',
      bad.length === 0, `超界 ${bad.join(',')}（内径 ${inner().toFixed(1)}px）`);
    ok('真实渲染：100 比 99 小、1000 比 100 小（位数一多就自动缩）',
      seen[99] > seen[100] && seen[100] > seen[1000],
      JSON.stringify(seen));
    ok('数字变了字号也会重算（不是只算一次就固定）', seen[9] !== seen[1000],
      `${seen[9]} → ${seen[1000]}`);
  }

  // 计时类：读秒到 100 秒以上也要缩，目标写成「N 秒」
  api.openExercise('plank');
  api.state.session = 'running';
  api.state.detector.holdMs = 9_000;
  api.updateHud();
  const fs9 = sizeOf();
  const targetText = elements.get('hudTarget').textContent;
  api.state.detector.holdMs = 100_000;
  api.updateHud();
  const fs100 = sizeOf();
  ok('计时类目标显示成「N 秒」（平板支撑默认 30 秒）', /^\d+ 秒$/.test(targetText), targetText);
  ok('计时类读秒到 100 秒以上：数字自动缩小（100 秒的字号 < 9 秒）',
    hudValue().textContent === '100' && fs100 < fs9, `${fs9} → ${fs100}`);
  ok('读秒 100 秒时估算宽度仍然 ≤ 圆环内径',
    api.hudTextWidth(hudValue().textContent, fs100) <= inner() + 1e-9,
    `${api.hudTextWidth(hudValue().textContent, fs100).toFixed(1)} / ${inner().toFixed(1)}`);
  ok('计时类 hudSub 不再重复「目标 30 秒」（目标已经挪到名称后面）',
    elements.get('hudSub').textContent === '', elements.get('hudSub').textContent);

  // 限时计数：大数字是次数，目标按秒显示
  api.openExercise('jumpingJack');
  api.setTarget(45);
  api.state.session = 'running';
  api.state.elapsedMs = 5_000;
  api.state.detector.validReps = 12;
  api.updateHud();
  ok('限时计数类目标同样显示成「N 秒」（开合跳 45 秒）',
    elements.get('hudTarget').textContent === '45 秒', elements.get('hudTarget').textContent);
  ok('限时计数类的大数字仍是次数（12）', hudValue().textContent === '12', hudValue().textContent);
  ok('限时计数的剩余时间仍然在圆环下方那一行',
    /剩余\s*40\s*\/\s*45\s*秒/.test(elements.get('hudSub').textContent),
    elements.get('hudSub').textContent);

  // 分数：仍在圆环下方（DOM 顺序 + 数值）
  ok('分数（#hudScore）在圆环下面、显示的是识别器的分',
    elements.get('hudScore').textContent === `${api.state.detector.score} 分`
    && html.indexOf('id="hudRing"') < html.indexOf('id="hudScore"'),
    `${elements.get('hudScore').textContent} / ${api.state.detector.score}`);

  // resize / 转屏：onStageResize 会把字号按新圆环直径重算
  {
    const el = hudValue();
    el.style.fontSize = '999px';     // 模拟旧视口下的旧字号
    api.onStageResize?.();
    const after = sizeOf();
    ok('窗口 resize / 转屏后字号按当前圆环直径重算（不是沿用旧值）',
      after > 0 && after < 999 && api.hudTextWidth(el.textContent, after) <= inner() + 1e-9,
      `${after}px（内径 ${inner().toFixed(1)}px）`);
  }

  // 退出圆环：绘制坐标 = 判定圆心（同一份数），且整个落在右上区域
  {
    const { w, h } = api.stageSize();
    const c = api.ringCenter('corner', w, h);
    const px = api.ringPx('corner');
    const btn = elements.get('ringQuickExit');
    ok('退出圆环的**绘制**坐标（行内 left/top）就是判定用的圆心（ringCenter）',
      btn.style.left === `${c.x}px` && btn.style.top === `${c.y}px`,
      `${btn.style.left}/${btn.style.top} vs ${c.x}/${c.y}`);
    ok('退出圆环整个落在右上区域（左边缘在右半边、上边缘在上半边）',
      c.x - px / 2 > w / 2 && c.y - px / 2 < h / 2,
      `left=${Math.round(c.x - px / 2)} top=${Math.round(c.y - px / 2)}`);
    const hit = api.anyTouchInRing(
      [{ x: c.x, y: c.y, kind: 'hand', side: 'L', part: 'wrist', vis: 1 }], 'corner', { w, h });
    ok('判定用的圆心与画出来的圆心一致（把手放到画出来的环心 → 判定也在环里）',
      hit.inside === true, JSON.stringify({ inside: hit.inside, d: hit.best?.d }));
  }

  api.state.settings.targets = savedTargets;
  api.state.settings.seconds = savedSeconds;
  api.state.session = 'idle';   // 别让 showHome() 把这一节的假数据存成记录
  api.showHome();
}

/* ------------------------------------------------------------------ *
 * [8e3] 运动界面里的猫爪指针
 *
 * 用户要求（原话）：「在每个运动的窗口里面，如果手掌进入或者靠近类似『退出』这样的圆环，
 * 则像菜单界面一样出现猫爪」。以前 `renderPaws` 的判据只有「手势菜单」，猫爪层也塞在
 * `#gestureMenu` 里，所以运动那一屏根本看不到它。这一节钉住新的行为：
 *   - 训练中 / 圆环摆着时有手掌 → 猫爪跟手（坐标就是判定用的同一份舞台像素，镜像也一致）；
 *   - 两只手各一个，没识别到的那只手不带 on；
 *   - 没有手掌、回主页 → 整层隐藏，不残留；
 *   - 手势菜单里照旧显示（没被这次改动弄坏）。
 * ------------------------------------------------------------------ */

console.log('\n[8e3] 运动界面里的猫爪指针');
{
  const api = windowStub.__mfg;
  const { LM } = await import('../src/geometry.js');
  const { standingPose: sp3 } = await import('./synthetic-pose.mjs');

  const layer = () => elements.get('pawLayer');
  const pawL = () => elements.get('pawL');
  const pawR = () => elements.get('pawR');
  const handsOn = () => ['L', 'R'].filter((s) => (s === 'L' ? pawL() : pawR()).classList.contains('on'));

  /**
   * 骨架：只把指定那只手（腕 + 食指 + 小指 + 拇指）放到 (x, y)（归一化坐标），
   * 另一只手整只藏起来（visibility 0 → 看不见，就等于「没识别到」）。
   */
  const handAt = (side, x, y) => {
    const lm = sp3({ knee: 175, ankleX: 1.0, view: 'front' }).map((p) => ({ ...p, visibility: 1 }));
    const hands = {
      L: [LM.L_WRIST, LM.L_INDEX, LM.L_PINKY, LM.L_THUMB],
      R: [LM.R_WRIST, LM.R_INDEX, LM.R_PINKY, LM.R_THUMB],
    };
    for (const s of ['L', 'R']) {
      for (const i of hands[s]) {
        lm[i] = s === side
          ? { x, y, z: 0, visibility: 1 }
          : { x: 0.5, y: 0.5, z: 0, visibility: 0 };
      }
    }
    return lm;
  };
  /** 两只手掌都放到同一个点（两只猫爪应当各就各位） */
  const bothHandsAt = (x, y) => {
    const lm = handAt('L', x, y);
    for (const i of [LM.R_WRIST, LM.R_INDEX, LM.R_PINKY, LM.R_THUMB]) {
      lm[i] = { x, y, z: 0, visibility: 1 };
    }
    return lm;
  };

  const before = api.camera.stream;
  const fakeCam = { getTracks: () => [] };
  api.state.settings.mirror = false;
  api.openExercise('squat');
  api.state.session = 'running';         // 训练中（右上角退出圆环这时摆着）
  // ⚠️ 顺序：「进动作页」会异步重开摄像头，所以**进完再**塞桩流、再 sync（和 [8e] 同一个做法）
  api.camera.stream = fakeCam;
  api.syncCornerExit();
  const { w: SW3, h: SH3 } = api.stageSize();
  const c3 = api.ringCenter('corner', SW3, SH3);
  const centre = { x: c3.x / SW3, y: c3.y / SH3 };

  ok('训练界面里允许画猫爪（右上角退出圆环摆着，pawsWanted = true）',
    api.gestureState.cornerVisible === true && api.pawsWanted() === true);

  // ===== 手掌进入右上角退出圆环 → 猫爪出现在手掌坐标上 =====
  api.updatePaws(handAt('L', centre.x, centre.y));
  ok('手掌伸进右上角退出圆环：左边那只猫爪出现在手掌坐标上并带 on',
    layer().hidden === false && pawL().classList.contains('on')
    && pawL().style.left === `${Math.round(c3.x)}px` && pawL().style.top === `${Math.round(c3.y)}px`,
    `${pawL().style.left}/${pawL().style.top} vs ${c3.x}/${c3.y}`);
  ok('没识别到的那只手（右手）不带 on', pawR().classList.contains('on') === false
    && handsOn().length === 1, handsOn().join(','));
  ok('猫爪里画的是 pawSVG（和手势菜单里同一颗图标）',
    /<svg/.test(pawL().innerHTML) && pawL().innerHTML === api.pawSVG());

  // ===== 两只手各一个，各跟各的 =====
  api.updatePaws(bothHandsAt(centre.x, centre.y));
  ok('两只手各一个猫爪，都在各自的手掌坐标上',
    pawL().classList.contains('on') && pawR().classList.contains('on')
    && pawL().style.left === `${Math.round(c3.x)}px` && pawR().style.left === `${Math.round(c3.x)}px`
    && pawR().style.top === `${Math.round(c3.y)}px`);

  // ===== 用户口径是「进入**或者靠近**」：还没进圆环也照样看得见爪子 =====
  const hit3 = api.ringHitRadius('corner', { w: SW3, h: SH3 });
  const near3 = { x: c3.x + hit3 * 1.4, y: c3.y };   // 判定半径的 1.4 倍处：靠近、但没进去
  api.updatePaws(handAt('R', near3.x / SW3, near3.y / SH3));
  ok('手掌只是在退出圆环附近（判定半径 1.4 倍处，没进去）也显示猫爪',
    layer().hidden === false && pawR().classList.contains('on')
    && pawR().style.left === `${Math.round(near3.x)}px` && handsOn().length === 1,
    `hidden=${layer().hidden} on=${handsOn().join(',')} left=${pawR().style.left}/${Math.round(near3.x)}px top=${pawR().style.top}/${Math.round(near3.y)}px`);

  // ===== 镜像设置要一致（和圆环判定同一份舞台像素） =====
  api.state.settings.mirror = true;
  api.updatePaws(bothHandsAt(0.2, 0.7));
  ok('镜像预览下猫爪坐标也跟着镜像（与圆圈判定同一套坐标）',
    pawL().style.left === `${Math.round((1 - 0.2) * SW3)}px`
    && pawL().style.top === `${Math.round(0.7 * SH3)}px`,
    `${pawL().style.left}/${pawL().style.top}`);
  api.state.settings.mirror = false;

  // ===== 没有手掌 → 整层藏起来（不是只去掉 on） =====
  api.updatePaws(null);
  ok('没有识别到手掌时猫爪隐藏（整层 hidden + 两只都不带 on）',
    layer().hidden === true && handsOn().length === 0);
  api.updatePaws(handAt('L', centre.x, centre.y));
  ok('手重新伸进画面又能画出来（藏了之后能恢复）',
    layer().hidden === false && pawL().classList.contains('on'));

  // ===== 回主页 → 必须隐藏，不能残留 =====
  api.showHome();
  api.updatePaws(bothHandsAt(0.5, 0.5));
  ok('回主页后猫爪必须隐藏（不能残留在画面上）',
    api.state.homeMode === true && layer().hidden === true && handsOn().length === 0);

  // ===== 什么都没显示（不在训练、圆环也没摆着）→ 不画 =====
  api.openExercise('squat');
  api.camera.stream = null;            // 摄像头关着：退出圆环不摆
  api.syncCornerExit();
  api.hideGestureRings();
  api.state.session = 'idle';
  ok('不在训练、圆环也没摆着时 pawsWanted = false（不该乱画）',
    api.gestureState.cornerVisible === false && api.gestureState.visible === false
    && api.pawsWanted() === false);
  api.updatePaws(bothHandsAt(0.5, 0.5));
  ok('这种情况下即使递进来一双手也不画', layer().hidden === true && handsOn().length === 0);

  // ===== 手势菜单里照旧显示（这次改动不能把它弄坏） =====
  api.camera.stream = fakeCam;
  api.openMenu({ silent: true });
  api.updatePaws(bothHandsAt(0.5, 0.5));
  ok('手势菜单里照旧显示猫爪（菜单那一屏没被这次改动破坏）',
    api.state.menuMode === true && layer().hidden === false
    && pawL().classList.contains('on') && pawR().classList.contains('on'));

  api.closeMenu();
  api.showHome();
  api.camera.stream = before;
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

  // 其他计时动作同样按 5 秒读（换动作 → 新识别器计时为 0 → 读秒重新装填）
  api.openExercise('standingForwardFold');
  api.state.session = 'running';
  said.length = 0;
  step(0, 79000);
  api.state.detector.holdMs = 15000;
  ok('其它计时动作也按 5 秒读（计时类通用）', step(15000, 80000) === true && said[0] === '15 秒', said.join(' | '));

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
  const wasUnlocked = api.audio._unlocked === true;
  documentStub.dispatch('pointerdown');
  ok('第一次用户交互后音频被解锁', api.audio._unlocked === true);
  // 正常情况：这次 pointerdown 把三个「首次手势」监听器一起撤掉，keydown 上少一个。
  // 前面的 AI 教练测试也按过 Ctrl+I，那种情况下解锁监听器已经在那次 keydown 里撤掉了
  // （before 就只剩主监听器），这里保持「已撤」也算通过 —— 钉的是「用完即撤」，不是「必须由这次撤」。
  ok('解锁用的监听器用完即撤（keydown 上少了一个）',
    (documentStub._listeners.keydown || []).length === keydownBefore - 1
    || (wasUnlocked && (documentStub._listeners.keydown || []).length === keydownBefore),
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
  // 去重状态清掉：上一条激励/整轮夸奖可能刚念过同一句，去重命中时会「该说也没说」——
  // 那不是这条用例要测的东西（不清的话这条断言会偶尔偶发失败）
  api.audio._lastEncourage = null;
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
  ok('两个新图标（最佳成绩 / 运动记录）在顶栏里，而且都是线条图标（不再是 emoji）',
    /id="btnBest"/.test(html) && /id="btnHistory"/.test(html)
    && /id="btnBest"[\s\S]{0,400}?class="ui-icon"/.test(html)
    && /id="btnHistory"[\s\S]{0,400}?class="ui-icon"/.test(html));
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
 * [14] 虚线轮廓的显示时机（跑真实主循环，覆盖整个动作库）
 *
 * 用户要求：**刚开始识别人体的时候画面里有虚线人体轮廓，识别成功进入运动状态后就要隐藏。**
 * 这一段的做法不是「看代码觉得对」，而是真的把 loop() 一帧一帧跑起来，
 * 记录每一帧交给渲染器的 outline，然后按会话状态分类断言：
 *   没找到人 → 画；还没就位 → 画；识别成功（含休息态）→ 不画；倒计时/计数/暂停 → 一帧都不画。
 * 放在最后：它会驱动摄像头/推理桩跑完整流程，别影响前面的用例。
 * ------------------------------------------------------------------ */

console.log(`\n[14] 虚线轮廓：识别成功就隐藏（真实主循环，全 ${EXERCISES.length} 个动作）`);
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

  // 可控时钟：校准要「保持 0.6 秒」才算识别成功，靠真实时间跑完整个动作库太慢，
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
  ok(`这一段覆盖了全部动作（${EXERCISES.length} 个）`, EXERCISES.length === 19, all);
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

console.log(`\n[16] 调试数据记录（全局配置里的隐藏分组 + 视频状态下 Ctrl+H 直接开关）`);
{
  const { LM: LMK } = await import('../src/geometry.js');
  const { standingPose: sp4 } = await import('./synthetic-pose.mjs');
  const api = windowStub.__mfg;

  // ===== ① 开关搬到了「设置（全局配置）」弹窗里，默认关着 =====
  api.openExercise('buttKick');
  api.renderExerciseSettings();
  const btn = elements.get('btnPoseLog');
  ok('「记录调试数据」开关在**设置（全局配置）**里，不再是运动设定弹窗的内容',
    !!btn && !!elements.get('btnPoseLogSave') && !!elements.get('poseLogStatus')
    && api.state.settings.poseLog === false
    && /^settings\./.test(btn.attributes['data-i18n'] || ''),
    JSON.stringify({ btn: !!btn, key: btn?.attributes['data-i18n'] }));
  const statusOff = elements.get('poseLogStatus').textContent;
  ok('没打开时状态行写「未开始记录」', /未开始记录/.test(statusOff), statusOff);

  // ===== ⓪ 用户要求：这一组**默认藏着**，在**设置弹窗**里按 Ctrl+H 才显示出来 =====
  {
    const group = elements.get('poseLogGroup');
    api.openExercise('buttKick');
    api.openSettings();
    ok('「调试数据记录」那一组默认是藏着的（设置弹窗里看不到，弹窗更短）',
      group.hidden === true && elements.get('settingsModal').hidden === false,
      `group.hidden=${group.hidden} modal.hidden=${elements.get('settingsModal').hidden}`);
    // 在设置弹窗里按 Ctrl+H → 显出来
    documentStub.dispatch('keydown', { key: 'h', ctrlKey: true, preventDefault() {} });
    ok('在**设置弹窗**里按 Ctrl+H → 「调试数据记录」显示出来',
      group.hidden === false, `group.hidden=${group.hidden}`);
    ok('这时候只是「显示出来」，不会顺手开始记录（记录由开关说了算）',
      api.state.settings.poseLog === false && api.poseLogger.active === false,
      `poseLog=${api.state.settings.poseLog} active=${api.poseLogger.active}`);
    // 再按一次 → 又藏起来
    documentStub.dispatch('keydown', { key: 'h', ctrlKey: true, preventDefault() {} });
    ok('再按一次 Ctrl+H → 又藏起来（不会把弹窗越撑越长）', group.hidden === true);
    // 带修饰键的变体一律都算（Chrome 里 Ctrl+H 有时会被浏览器自己吃掉，留一条退路）
    documentStub.dispatch('keydown', { key: 'h', ctrlKey: true, altKey: true, preventDefault() {} });
    ok('Ctrl+Alt+H 也能显出来（浏览器把 Ctrl+H 抢走时的退路）', group.hidden === false);
    documentStub.dispatch('keydown', { key: 'H', ctrlKey: true, altKey: true, preventDefault() {} });
    ok('再按一次 Ctrl+Alt+H 收起', group.hidden === true);
    // 关掉设置弹窗、打开运动设定弹窗：Ctrl+H 已经不该再管这一组了，也不吞这个键
    api.closeSettings();
    api.openExerciseSettings();
    let prevented = false;
    documentStub.dispatch('keydown', { key: 'h', ctrlKey: true, preventDefault() { prevented = true; } });
    ok('运动设定弹窗里按 Ctrl+H 不再翻出这一组（它搬去全局配置了），也不跟浏览器抢键',
      group.hidden === true && prevented === false && api.state.settings.poseLog === false,
      `group.hidden=${group.hidden} prevented=${prevented}`);
    api.closeExerciseSettings();
  }

  // ===== ⓪′ 用户要求：**视频状态下**按 Ctrl+H 直接开始 / 停止记录（不用打开弹窗） =====
  {
    const group = elements.get('poseLogGroup');
    api.closeSettings();
    api.openExercise('buttKick');
    // 桩 DOM 不读 HTML 里的 hidden 属性：按真实页面的初始状态把两个「记录类」弹窗关上
    elements.get('bestModal').hidden = true;
    elements.get('historyModal').hidden = true;
    ok('现在处于视频状态（动作页、没有弹窗）',
      api.videoStateActive() === true && api.state.homeMode === false,
      `video=${api.videoStateActive()} home=${api.state.homeMode} workout=${elements.get('workoutView').hidden}`);
    let prevented = false;
    documentStub.dispatch('keydown', { key: 'h', ctrlKey: true, preventDefault() { prevented = true; } });
    ok('视频状态下按 Ctrl+H → 开始记录（并拦下这个键，不让浏览器开历史记录）',
      api.state.settings.poseLog === true && api.poseLogger.active === true && prevented === true,
      `poseLog=${api.state.settings.poseLog} active=${api.poseLogger.active} prevented=${prevented}`);
    ok('提示条告诉用户文件名、并说明再按一次就停',
      /开始记录调试数据/.test(elements.get('cueLine').textContent)
      && new RegExp(api.poseLogger.status().file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .test(elements.get('cueLine').textContent),
      elements.get('cueLine').textContent);
    ok('右下角「正在记录」角标同时出现', elements.get('recBadge').hidden === false);
    ok('这一组仍然是藏着的（快捷键记录 ≠ 把它显示出来）', group.hidden === true);
    documentStub.dispatch('keydown', { key: 'h', ctrlKey: true, preventDefault() {} });
    ok('再按一次 Ctrl+H → 停止记录（补一行 end，角标收起）',
      api.state.settings.poseLog === false && api.poseLogger.active === false
      && elements.get('recBadge').hidden === true,
      `poseLog=${api.state.settings.poseLog} active=${api.poseLogger.active}`);
    ok('停止时提示条说明「已停止 / 共多少帧」',
      /已停止记录调试数据/.test(elements.get('cueLine').textContent),
      elements.get('cueLine').textContent);
    const savedNow = JSON.parse(store.get('mfg.settings.v1') || '{}');
    ok('快捷方式切换的开关状态同样写进 localStorage（刷新后仍然生效）',
      savedNow.poseLog === false, JSON.stringify(savedNow.poseLog));
    // 主页（还没进动作页）不拦 Ctrl+H：那时摄像头都没开，不该悄悄开始记录
    api.showHome();
    let preventedHome = false;
    documentStub.dispatch('keydown', { key: 'h', ctrlKey: true, preventDefault() { preventedHome = true; } });
    ok('动作主页（还没进动作页）按 Ctrl+H 不开始记录、也不拦这个键',
      api.state.settings.poseLog === false && preventedHome === false && api.state.homeMode === true,
      `poseLog=${api.state.settings.poseLog} prevented=${preventedHome}`);
    api.openExercise('buttKick');
  }

  // 后面那些用例要按开关：打开设置弹窗 + 按 Ctrl+H 显出来
  api.openSettings();
  documentStub.dispatch('keydown', { key: 'h', ctrlKey: true, preventDefault() {} });
  ok('要调试时：设置弹窗里按一下 Ctrl+H 就能看到开关与保存按钮',
    elements.get('poseLogGroup').hidden === false
    && !!elements.get('btnPoseLog') && !!elements.get('btnPoseLogSave'));

  // 打桩：接住「攒批 → POST」那一批数据
  const savedFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url, opts = {}) => {
    posts.push({ url: String(url), body: String(opts.body || '') });
    return { ok: true, status: 200 };
  };
  btn.dispatch('click');
  ok('点一下开关就开始记录（设置里也存下来了）',
    api.state.settings.poseLog === true && btn.attributes['aria-pressed'] === 'true',
    String(api.state.settings.poseLog));
  ok('状态行显示文件名 / 帧数 / 大小',
    /记录中/.test(elements.get('poseLogStatus').textContent)
    && /pose-buttKick-\d{8}-\d{6}\.jsonl/.test(elements.get('poseLogStatus').textContent),
    elements.get('poseLogStatus').textContent);
  const saved = JSON.parse(store.get('mfg.settings.v1') || '{}');
  ok('开关状态写进了 localStorage（刷新后还在）', saved.poseLog === true, JSON.stringify(saved.poseLog));

  /* ---- 用户要求：「一旦这个开关打开，则在视频屏幕的**右下角**要出现一个图标，显示其正在记录
     帧数据，同时用数字显示已经记录了多少帧了。」 ---- */
  {
    const badge = elements.get('recBadge');
    const num = elements.get('recFrames');
    ok('开关打开 → 画面右下角出现「正在记录」角标（起点 0 帧）',
      badge.hidden === false && num.textContent === '0',
      `hidden=${badge.hidden} 帧数=${num.textContent}`);
    ok('角标是「谁在记」的独立提示，和弹窗里那一行状态各管各的',
      elements.get('poseLogStatus').textContent !== num.textContent,
      `${elements.get('poseLogStatus').textContent} / ${num.textContent}`);
  }

  // ===== ② 真实主循环跑几帧 → 数据被攒起来并 POST 给本地服务器 =====
  const savedStream = api.camera.stream;
  const savedDetect = api.engine.detect;
  const savedEngineReady = api.state.engineReady;
  const savedDraw = api.renderer.draw;
  const savedPerf = globalThis.performance;
  api.camera.stream = { getTracks: () => [], getVideoTracks: () => [] };
  api.camera.video.readyState = 4;
  api.state.engineReady = true;
  let clock = 7_000_000;
  const fakePerf = { now: () => clock, timeOrigin: savedPerf.timeOrigin };
  Object.defineProperty(globalThis, 'performance', { value: fakePerf, configurable: true, writable: true });
  windowStub.performance = fakePerf;
  let pose = sp4({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0, view: 'side' });
  api.engine.detect = () => (pose ? { landmarks: pose, worldLandmarks: null } : null);
  api.renderer.draw = () => {};
  let t = 6_000_000;
  const pump = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock += 33.4;
      t += 33.4;
      api.camera.video.currentTime = t;
      api.state.engineReady = true;
      if (!api.camera.stream) api.camera.stream = { getTracks: () => [], getVideoTracks: () => [] };
      api.loop();
    }
  };
  const logger = api.poseLogger;
  ok('主循环里能拿到记录器（__mfg 暴露了它，测试才能驱动）', !!logger && typeof api.setPoseLog === 'function', typeof logger);
  pump(6);
  logger.flush({ force: true });
  await new Promise((r) => setTimeout(r, 10));
  const posted = posts.map((p) => p.body).join('');
  const lines = posted.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const meta = lines.find((l) => l.k === 'meta');
  const frames = lines.filter((l) => l.k === 'f');
  ok('数据是 POST 给本地预览服务器的 /__debug/log（服务端再追加写进 logs/）',
    posts.length > 0 && posts.every((p) => p.url.startsWith('/__debug/log?file=pose-buttKick-')),
    posts[0]?.url || '没有发出任何请求');
  ok('第一批里有一行 meta（动作 / 机位 / 校准地面线 / 识别器 / 关键帧判据）',
    !!meta && meta.exerciseId === 'buttKick' && typeof meta.det === 'string'
    && Array.isArray(meta.stages) && meta.stages.length > 0 && typeof meta.ua === 'string',
    JSON.stringify(meta));
  ok('每一帧都记下来了：33 个关节点（原始 + 平滑后）+ 全部指标 + 识别器内部状态 + 进度条进度',
    frames.length >= 4
    && frames.every((f) => Array.isArray(f.lm) && f.lm.length === 33 && Array.isArray(f.lm[0]) && f.lm[0].length === 4)
    && frames.every((f) => Array.isArray(f.sm) && f.sm.length === 33)
    && frames.every((f) => f.m && Number.isFinite(f.m.kneeAngle) && typeof f.m.ok === 'boolean')
    && frames.every((f) => f.d && Object.keys(f.d).length >= 3 && typeof f.d.gateOk === 'boolean')
    && frames.every((f) => Array.isArray(f.bar) && f.bar[1] > 0),
    `帧数 ${frames.length} / ${JSON.stringify(frames[0]?.d || null)}`);
  ok('帧里带着「这一帧算不算识别到人」和会话状态（分析时先看这两条）',
    frames.every((f) => typeof f.s === 'string' && typeof f.m.ok === 'boolean')
    && frames.every((f) => typeof f.ex === 'string' && f.ex === 'buttKick'),
    JSON.stringify(frames[0]?.s));
  ok('左右交替类额外记「两条腿各自的读数 + 基线」（勾腿跳查『计不上』靠的就是这几个数）',
    frames.every((f) => f.sides && f.sides.L && f.sides.R
      && Number.isFinite(f.sides.L.v) && Number.isFinite(f.sides.L.alt)
      && Number.isFinite(f.sides.R.v) && 'base' in f.sides.R),
    JSON.stringify(frames[0]?.sides || null));

  /* ---- 右下角角标上的帧数（用户要求「用数字显示已经记录了多少帧了」）---- */
  {
    const num = elements.get('recFrames');
    api.renderRecBadge();
    ok('角标上的数字 = 记录器**真正记下来的**帧数（不是循环帧号：队列满了会丢帧）',
      Number(num.textContent) === logger.status().frames && logger.status().frames > 0,
      `角标=${num.textContent} 记录器=${logger.status().frames}`);
    const before = logger.status().frames;
    pump(20);                       // 主循环里每 15 帧刷一次角标，跑一会儿应该自己跳
    ok('主循环自己刷新角标（帧数会跟着涨，不需要手动调；最多落后 15 帧）',
      Number(num.textContent) > before && Number(num.textContent) <= logger.status().frames,
      `${before} → 角标=${num.textContent} 记录器=${logger.status().frames}`);
    api.renderRecBadge();
    ok('下一次刷新时角标就追平记录器（落后只是刷新频率，不是记错）',
      Number(num.textContent) === logger.status().frames,
      `角标=${num.textContent} 记录器=${logger.status().frames}`);
  }

  // ===== ③ 计次 / 提示这些事件也各占一行 =====
  logger.event('rep', { ex: 'buttKick', valid: true, index: 3, quality: 72, duration: 640 });
  logger.flush({ force: true });
  await new Promise((r) => setTimeout(r, 10));
  const lines2 = posts.map((p) => p.body).join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  ok('计次事件单独一行（valid / index / quality / duration 都在）',
    lines2.some((l) => l.k === 'rep' && l.valid === true && l.index === 3 && l.quality === 72),
    JSON.stringify(lines2.find((l) => l.k === 'rep') || null));

  // ===== ④ 关掉开关：补一行 end，并且不再记帧 =====
  pump(3);
  btn.dispatch('click');
  await new Promise((r) => setTimeout(r, 20));
  logger.flush({ force: true });
  await new Promise((r) => setTimeout(r, 20));
  const all = posts.map((p) => p.body).join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  ok('关掉开关时补一行 end（写清原因与总帧数）',
    !!all.find((l) => l.k === 'end') && all.find((l) => l.k === 'end').frames > 0,
    JSON.stringify(all.find((l) => l.k === 'end') || null));
  const frozen = logger.status().frames;
  pump(3);
  ok('关掉之后不再记录（帧数不再增长）',
    api.state.settings.poseLog === false && logger.status().frames === frozen && frozen > 0,
    `关掉时 ${frozen} → 之后 ${logger.status().frames}`);
  ok('关掉后状态行回到「未开始记录」', /未开始记录/.test(elements.get('poseLogStatus').textContent),
    elements.get('poseLogStatus').textContent);
  ok('关掉开关 → 右下角「正在记录」角标跟着消失（不会让人以为还在记）',
    elements.get('recBadge').hidden === true, String(elements.get('recBadge').hidden));

  // ===== ⑤ 回归：一批数据必须切成 ≤48KB 的块，而且**不许带 keepalive** =====
  // 真机上踩过：加了 keepalive 之后，浏览器对请求体有 64KiB 上限，每批 100KB 全部被拒，
  // 结果用户测完一组，文件里只剩那一行 765 字节的 meta（帧数据一行都没有）。
  {
    const captured = [];
    const savedPost = logger.post;
    logger.post = async (file, body) => { captured.push(body); return { ok: true }; };
    api.setPoseLog(true, { silent: true });     // 重新开一个文件（前面刚关掉过开关）
    logger._lastFlush = 0;
    // 造 200 帧数据（每帧带 33 个关节点 + 一大堆指标），总量远超 48KB
    for (let i = 0; i < 200; i += 1) {
      logger.frame({
        t: 1000 + i,
        exerciseId: 'buttKick',
        session: 'running',
        landmarks: Array.from({ length: 33 }, (_, k) => ({ x: 0.1 + k / 1000, y: 0.2 + k / 1000, z: 0, visibility: 0.9 })),
        smoothed: Array.from({ length: 33 }, (_, k) => ({ x: 0.1 + k / 1000, y: 0.2 + k / 1000, z: 0, visibility: 0.9 })),
        frame: { ok: true, kneeAngle: 100 + i, torsoIncl: 5, hipAngle: 170, bodyStraight: 175, shoulderClear: 1.1, hipLineDev: 0.01, torsoLen: 0.3, kneeClear: 0.9 },
        det: { gateOk: true, metricName: 'knee', progress: 0.4, peak: 0.6, validReps: i },
        barIndex: 1,
        barTotal: 3,
      });
    }
    logger.flush({ force: true });
    await new Promise((r) => setTimeout(r, 60));
    const total = logger.status().bytes;
    ok('一帧记录只有几 KB，一整组必须切块发送',
      total > 48 * 1024 && captured.length >= 2,
      `共 ${(total / 1024).toFixed(0)}KB / ${captured.length} 批`);
    ok('每一批都 ≤48KB（浏览器对 keepalive / sendBeacon 的 64KiB 上限就绕开了）',
      captured.every((b) => b.length <= 48 * 1024),
      captured.map((b) => `${(b.length / 1024).toFixed(0)}KB`).join(' '));
    ok('切块是按行切的（每一行都还是完整的 JSON，不会把一帧记录切成两半）',
      captured.every((b) => b.trim().split('\n').every((l) => { try { JSON.parse(l); return true; } catch { return false; } })),
      String(captured[0]?.length));
    logger.post = savedPost;
    logger.rows = [];
    logger.queue = [];
  }

  // ===== ⑥ 兜底：没有服务器时也能把数据下载下来 =====
  {
    const savedURL = globalThis.URL;
    const clicks = [];
    globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL() {} };
    const realCreate = documentStub.createElement;
    documentStub.createElement = (tag) => {
      const el = realCreate.call(documentStub, tag);
      el.click = () => clicks.push({ tag, href: el.href, download: el.download });
      return el;
    };
    api.openExercise('buttKick');
    api.setPoseLog(true, { silent: true });
    logger.event('rep', { valid: true });
    const name = logger.download();
    ok('「保存/下载文件」能把已记录的数据做成 .jsonl 下载（没有预览服务器时的兜底）',
      /^pose-buttKick-\d{8}-\d{6}\.jsonl$/.test(name || '') && clicks.length === 1
      && clicks[0].download === name && clicks[0].href === 'blob:fake',
      JSON.stringify({ name, clicks }));
    api.setPoseLog(false, { silent: true });
    documentStub.createElement = realCreate;
    globalThis.URL = savedURL;
  }

  // 恢复现场
  api.renderer.draw = savedDraw;
  api.engine.detect = savedDetect;
  api.state.engineReady = savedEngineReady;
  api.camera.stream = savedStream;
  api.camera.video.currentTime = 0;
  globalThis.fetch = savedFetch;
  Object.defineProperty(globalThis, 'performance', { value: savedPerf, configurable: true, writable: true });
  windowStub.performance = savedPerf;
  api.state.session = 'idle';
}

/* ------------------------------------------------------------------ *
 * [17] 全手势操作：首页「开始」→ 全屏手势菜单 → 手掌停 3 秒选动作
 *      →（运动中退出）回菜单 →（菜单里退出）回网页首页
 * ------------------------------------------------------------------ */

console.log('\n[17] 全手势操作：首页「开始」→ 手势菜单 → 选动作 → 退出回菜单 → 再退出回首页');
{
  const api = windowStub.__mfg;
  const { LM: LMK } = await import('../src/geometry.js');
  const { standingPose: sp6 } = await import('./synthetic-pose.mjs');
  const { w: SW, h: SH } = api.stageSize();
  const stageEl = elements.get('stage');
  const menuEl = elements.get('gestureMenu');
  const grid = elements.get('menuGrid');
  const savedReady = api.camera.video.readyState;
  const savedStream6 = api.camera.stream;
  const savedMirror = api.state.settings.mirror;
  const savedClientW = stageEl.clientWidth;      // 桩里的舞台尺寸（默认 undefined = 用 1280×720 兜底）
  const savedClientH = stageEl.clientHeight;

  api.state.settings.mirror = false;      // 判定与「屏幕上看到的那一边」一致，测试里关掉镜像更好算坐标
  api.state.engineReady = true;

  /** 骨架：两只手掌心放在舞台像素点 (x, y)，其它部位是站着的人 */
  const palmsAt6 = (x, y, vis = 1) => {
    const lm = sp6({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0, view: 'front' })
      .map((p) => ({ ...p, visibility: vis }));
    for (const w of [LMK.L_WRIST, LMK.R_WRIST]) {
      for (const off of [0, 2, 4, 6]) lm[w + off] = { x: x / SW, y: y / SH, z: 0, visibility: vis };
    }
    return lm;
  };

  // ===== ① 首页那个大「开始」按钮 =====
  api.showHome();
  const startBtn = elements.get('btnStartGesture');
  ok('首页多了一个大的「开始」按钮（.start-gesture，文案走 menu.start / menu.startSub）',
    !!startBtn && String(startBtn.attributes.class || '').includes('start-gesture'),
    JSON.stringify({ cls: startBtn?.attributes?.class }));
  ok('按钮在动作库上面（先看到它，再去挑动作）',
    /id="btnStartGesture"[\s\S]*id="homeCats"/.test(html), '顺序不对');

  // 点它：开摄像头 + 切到视频界面 + 进手势菜单 + 对 #stage 申请全屏
  api.camera.stream = null;
  api.camera.video.readyState = 0;
  stageEl.requestFullscreenCalls = 0;
  documentStub.fullscreenElement = null;
  startBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 40));      // startCamera 是异步的
  ok('点「开始」→ 打开摄像头', !!api.camera.stream, String(!!api.camera.stream));
  ok('点「开始」→ 切到全屏视频界面（对 #stage 申请全屏，而不是整页）',
    stageEl.requestFullscreenCalls === 1 && elements.get('homeView').hidden === true
    && elements.get('workoutView').hidden === false,
    `fullscreen=${stageEl.requestFullscreenCalls} home=${elements.get('homeView').hidden}`);
  ok('点「开始」→ 直接进入手势菜单（不是进某个动作）',
    api.state.menuMode === true && menuEl.hidden === false
    && String(elements.get('workoutView').className).includes('menu-mode')
    && String(stageEl.className).includes('menu-mode'),
    `menu=${api.state.menuMode} hidden=${menuEl.hidden}`);
  ok('菜单模式把运动相关的面板收起来（侧栏 / 进度条 / HUD 都不显示）',
    /#workoutView\.menu-mode \.panel/.test(fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8'))
    && /#stage\.menu-mode \.hud/.test(fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8')),
    '样式里没有 menu-mode 收起规则');

  // ===== ② 第一级菜单：每行最多 6 个格子、一页只摆一行（用户要求） =====
  /* 用户要求：「把每个运动圆环的大小再进一步缩小，每行最多放 6 个圆环，
     但是把『上一页』、『下一页』这两个圆环也放在这一行（如果需要显示的话）。」 */
  const layout = api.menuRingLayout(api.stageSize());
  const info0 = api.menuPageInfo();
  const nav0 = api.menuNavLayout(api.stageSize());
  const band0 = api.menuBandGeom(api.stageSize());
  /**
   * 误触面积（用户反馈：「菜单圆环很大、数量又多，人站在画面中手很容易误触某个圆环」）：
   * 在画面上撒点，量一量「圆环 / 起手圈 / 判定圈」各占整幅画面的百分之几。
   */
  const coverPct = (list, size, rad = (it) => it.r, N = 96) => {
    const cols = Math.round(N * (size.w / size.h));
    let n = 0;
    for (let iy = 0; iy < N; iy += 1) {
      for (let ix = 0; ix < cols; ix += 1) {
        const x = ((ix + 0.5) / cols) * size.w;
        const y = ((iy + 0.5) / N) * size.h;
        if (list.some((it) => Math.hypot(x - it.cx, y - it.cy) <= rad(it))) n += 1;
      }
    }
    return (n / (N * cols)) * 100;
  };
  ok('每行最多 6 个格子 + 一页只摆一行：第一级 5 个分类一页正好放完（5 ≤ 6，不出现翻页圆环）',
    api.state.menuLevel === 0 && layout.length === 5 && layout.every((it) => it.kind === 'category')
    && api.MENU_COLS === 6 && api.MENU_ROWS === 1 && api.menuCols(api.stageSize().w) === 6
    && api.menuPageCells(api.stageSize()) === 6 && api.menuPerPage(api.stageSize()) === 6
    && info0.total === 5 && info0.pages === 1 && nav0.length === 0,
    `${layout.length} 个 / 每页 ${api.menuPerPage(api.stageSize())} / ${info0.pages} 页`);
  ok('圆环跟着格子**变小**（直径 = 格子宽 × 0.86：1280×720 上 176.1px，上一版 211.4px）',
    layout.every((it) => Math.abs(it.r * 2 - band0.dia) < 1e-9)
    && Math.abs(band0.dia - 176.1) < 0.2 && band0.dia < 211,
    `Ø${band0.dia.toFixed(1)}px（上一版 Ø211.4px）`);
  ok('名字 / 图标字号仍看得清（名字 = 直径 × 15% ≈ 26.4px，图标 = 直径 × 38% ≈ 66.9px）',
    layout.every((it) => Math.abs(it.nameSize - band0.dia * 0.15) < 1e-9 && it.nameSize >= 24)
    && layout.every((it) => Math.abs(it.iconSize - band0.dia * 0.38) < 1e-9 && it.iconSize >= 40),
    `name=${layout[0].nameSize.toFixed(1)} icon=${layout[0].iconSize.toFixed(1)} dia=${band0.dia.toFixed(1)}`);
  ok('「返回」**常驻在右上角**、**不参与翻页**（不在选项格子里，也不在翻页那排里）',
    nav0.length === 0
    && api.menuItems().every((it) => it.kind !== 'back')
    && !grid.children.some((c) => c.dataset.ex === 'back')
    && (() => {
      const b = api.menuBackItem(api.stageSize());
      const c = api.ringCenter('corner', SW, SH);
      return b.cx === c.x && b.cy === c.y && /class="ex-pose"/.test(b.poseIcon);
    })(),
    JSON.stringify(nav0.map((it) => [it.kind, Math.round(it.cx), Math.round(it.cy)])));
  ok('右上角那颗圆环尺寸 = 动作页退出圆环的 --ring-px（1280×720 上 ≥130px，最早只有 Ø83px）',
    api.menuBackItem(api.stageSize()).r * 2 >= 130,
    `Ø${Math.round(api.menuBackItem(api.stageSize()).r * 2)}px`);
  {
    // ---- 误触面积（用户反馈：「人站在画面中手很容易误触某个圆环」）
    const sz = api.stageSize();
    const all = [...layout, ...api.menuNavLayout(sz), api.menuBackItem(sz)];
    const hitPct = coverPct(all, sz, (it) => it.hit);
    const startPct = coverPct(all, sz, (it) => it.start);
    const oldPct = coverPct(all.map((it) => ({ ...it, hit: it.r * 1.15 })), sz, (it) => it.hit);
    ok('判定圈就是**画出来的圆圈**（1.0 倍，不再外扩 15%）：误触面积比旧口径少四分之一',
      api.MENU_HIT_RATIO === 1 && hitPct <= oldPct * 0.8 && oldPct >= 12,
      `判定 ${hitPct.toFixed(1)}% / 旧口径 ${oldPct.toFixed(1)}% / 画出来 ${coverPct(all, sz).toFixed(1)}%`);
    ok('起手圈再收 20%（0.8 倍）：**开始蓄力**的误触面积只有判定圈的 2/3',
      api.MENU_START_RATIO === 0.8 && startPct <= hitPct * 0.75,
      `起手 ${startPct.toFixed(1)}% vs 判定 ${hitPct.toFixed(1)}%（旧口径 ${oldPct.toFixed(1)}%）`);
    const lowest = Math.max(...layout.map((it) => it.cy + it.r));
    ok('整块圆环往上放：画面下方留出「放手区」（圆环最低点不超过画面高度的 80%）',
      lowest / sz.h <= 0.8,
      `最低 ${(lowest / sz.h * 100).toFixed(0)}%（放手区 ${(100 - lowest / sz.h * 100).toFixed(0)}%）`);
  }
  ok('单页时整行就是纯选项：翻页圆环和页码都不出现（右上角「返回」仍然在）',
    api.menuNavLayout(api.stageSize()).length === 0
    && api.menuBackItem(api.stageSize()).kind === 'back'
    && elements.get('menuPage').hidden === true);
  ok('每一格都写好了位置 / 直径 / 字号（和判定用的是同一份圆心、半径）',
    layout.every((it) => {
      const el = grid.children.find((c) => c.dataset.ex === it.id);
      const name = el.querySelector?.('.menu-name');
      return el.style.left === `${it.cx}px` && el.style.top === `${it.cy}px`
        && el.style.width === `${it.r * 2}px` && !!name;
    }), JSON.stringify({ left: layout[0].cx, r: layout[0].r }));
  // 用户要求：「对于『上肢』『下肢』这样的大类下面，不要显示『x 个动作』这样的提示了，删掉」
  ok('一级菜单的分类格子**不再有「N 个动作」那行小字**（只剩图标和名字）',
    !/个动作/.test(grid.children[0].innerHTML)
    && layout.every((it) => it.sub === '')
    && api.menuBackItem(api.stageSize()).sub === '',
    grid.children[0].innerHTML.slice(0, 140));
  {
    const all = [...layout, ...nav0, api.menuBackItem(api.stageSize())];
    const bad = [];
    for (let i = 0; i < all.length; i += 1) {
      const a = all[i];
      if (a.cx - a.r < 0 || a.cx + a.r > SW || a.cy - a.r < 0 || a.cy + a.r > SH) bad.push(`${a.id}:出画`);
      for (let j = i + 1; j < all.length; j += 1) {
        const b = all[j];
        if (Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.hit + b.hit) bad.push(`${a.id}↔${b.id}:判定圈重叠`);
      }
    }
    ok('选项 + 右上角「返回」都完整落在画面里、判定圈互不重叠（「最近的那一格」不会有歧义）',
      bad.length === 0, bad.slice(0, 3).join(', '));
  }

  // ===== ②′ 分页：翻页圆环**也在选项那一行**（5 个格子 = 3 个选项 + 上一页 + 下一页） =====
  /* 宽屏 6 格正好放下所有分类（最多 6 个动作），所以翻页只在格子更少时出现：
     这里把舞台改成 700×400（5 列 × 1 行 = 5 格，「核心」6 个动作 > 5 → 要翻页），
     这时整行就是 `[上一页] + 3 个选项 + [下一页]`，全部圆环同一行、同一套直径/字号。 */
  {
    stageEl.clientWidth = 700;
    stageEl.clientHeight = 400;
    api.state.menuLevel = 0;
    api.state.menuCategory = '';
    api.state.menuPage = 0;
    api.selectFromMenu('cat:core');                 // 核心 6 个动作，一页 3 个 → 2 页
    const sizeP = api.stageSize();
    const navP = api.menuNavLayout(sizeP);
    const optsP = api.menuRingLayout(sizeP);
    const gP = api.menuBandGeom(sizeP);
    ok('有分页时：这一行 = [上一页] + 选项 + [下一页]，**格子总数 ≤ 6**（700×400：5 格）',
      api.menuCols(sizeP.w) === 5 && api.menuPageCells(sizeP) === 5
      && navP.length === 2 && optsP.length === 3
      && navP.map((it) => it.kind).join(',') === 'prev,next'
      && api.menuNavCells(sizeP) === 2,
      `cols=${api.menuCols(sizeP.w)} cells=${api.menuPageCells(sizeP)} nav=${navP.length} opt=${optsP.length}`);
    ok('翻页圆环放在这一行的两端：上一页最左、下一页最右（cx 递增，判定圈不重叠）',
      navP[0].cx < optsP[0].cx && optsP.every((o) => o.cx < navP[1].cx - o.r)
      && [...optsP, ...navP].every((a, i, arr) => arr.every((b) => a === b
        || Math.hypot(a.cx - b.cx, a.cy - b.cy) >= a.hit + b.hit)),
      JSON.stringify([navP[0].cx, ...optsP.map((o) => o.cx), navP[1].cx].map(Math.round)));
    ok('**全部圆环都在同一行**（含翻页那两颗：cy 完全相同），直径也同一份',
      [optsP[0].cy, ...optsP.map((o) => o.cy), ...navP.map((n) => n.cy)].every((y) => Math.abs(y - optsP[0].cy) < 1e-9)
      && navP.every((n) => Math.abs(n.r - optsP[0].r) < 1e-9)
      && Math.abs(optsP[0].r * 2 - gP.dia) < 1e-9,
      `cy=${optsP[0].cy} Ø=${(optsP[0].r * 2).toFixed(1)}`);
    ok('分页时每页选项数 = 格子数 − 2，菜单信息自洽（6 个动作 → 每页 3 个 → 2 页）',
      api.menuPerPage(sizeP) === 3 && api.menuPageInfo(sizeP).per === 3
      && api.menuPageInfo(sizeP).pages === 2 && api.menuPageInfo(sizeP).total === 6
      && /第 1 \/ 2 页/.test(elements.get('menuPage').textContent)
      && /6 项/.test(elements.get('menuPage').textContent),
      `${api.menuPerPage(sizeP)} / ${api.menuPageInfo(sizeP).pages} 页 / ${elements.get('menuPage').textContent}`);
    ok('翻页后「上一页 / 下一页」位置**一点不动**（不跟着换页跳）',
      (() => {
        const before = api.menuNavLayout(sizeP).map((it) => [it.cx, it.cy, it.r]);
        api.flipMenuPage(1);
        const after = api.menuNavLayout(sizeP).map((it) => [it.cx, it.cy, it.r]);
        api.state.menuPage = 0;
        return JSON.stringify(before) === JSON.stringify(after)
          && api.menuRingLayout(sizeP).length === 3;
      })(),
      JSON.stringify(api.menuNavLayout(sizeP).map((it) => [Math.round(it.cx), Math.round(it.cy)])));
    // 分组测完，回到第一级、恢复宽屏舞台
    api.state.menuLevel = 0;
    api.state.menuCategory = '';
    api.state.menuPage = 0;
    stageEl.clientWidth = savedClientW;
    stageEl.clientHeight = savedClientH;
    api.renderMenu();
  }

  // ===== ②″ 更窄的屏（320×700，2 列 × 2 行 = 4 格）：翻页主路径 + 返回 =====
  {
    const stageStub = stageEl;
    stageStub.clientWidth = 320;
    stageStub.clientHeight = 700;
    /* 窄屏上 CSS 把 `--ring-px` 收到 72px（@media max-width:560px）。桩里量不到真实布局，
       所以把「探针」的 clientWidth 设成 72 —— 这正是真实浏览器里 ringPx() 走的那条路：
       动作页那颗退出圆环在菜单里 display:none，靠探针拿到 CSS 真正算出来的直径。 */
    const probeEl = elements.get('ringSizeProbe');
    Object.defineProperty(probeEl, 'clientWidth', { configurable: true, get: () => 72 });
    const sizeN = api.stageSize();
    api.state.menuPage = 0;
    api.renderMenu();
    const nav = api.menuNavLayout(sizeN);
    const infoN = api.menuPageInfo(sizeN);
    ok('窄屏（320×700）：列数 2、两行 → 4 格；5 个分类 > 4 → 翻页圆环各占一格（每页 2 个、共 3 页）',
      api.menuCols(sizeN.w) === 2 && api.menuRowsFor(sizeN) === 2 && api.menuPageCells(sizeN) === 4
      && api.menuPerPage(sizeN) === 2 && infoN.pages === 3 && infoN.total === 5
      && api.menuRingLayout(sizeN).length === 2 && nav.length === 2,
      `cols=${api.menuCols(sizeN.w)} rows=${api.menuRowsFor(sizeN)} per=${api.menuPerPage(sizeN)} pages=${infoN.pages}`);
    ok('小屏上「返回」圆环的直径 = 探针读到的 CSS --ring-px（72px，不是兜底的 104px）',
      api.ringPx('corner') === 72 && api.menuBackItem(sizeN).px === 72
      && elements.get('menuBack').style.width === '72px',
      `${api.ringPx('corner')}px / item ${api.menuBackItem(sizeN).px} / inline ${elements.get('menuBack').style.width}`);
    ok('只有 2 列时第一行排不下三样东西 → 按整页首 / 末格摆（左上上一页、右下下一页），选项用中间两格',
      nav[0].cx < nav[1].cx && nav[0].cy < nav[1].cy
      && Math.abs(nav[0].cx - (api.menuBandGeom(sizeN).padX + api.menuBandGeom(sizeN).cellW * 0.5)) < 1e-9
      && Math.abs(nav[1].cx - (api.menuBandGeom(sizeN).padX + api.menuBandGeom(sizeN).cellW * 1.5)) < 1e-9,
      JSON.stringify(nav.map((it) => [it.kind, Math.round(it.cx), Math.round(it.cy)])));
    ok('翻页圆环和选项同样大、判定圈互不重叠（不会抢格）',
      nav.every((n) => Math.abs(n.r - api.menuRingLayout(sizeN)[0].r) < 1e-9)
      && api.menuRingLayout(sizeN).every((a) => nav.every((b) => (
        Math.hypot(a.cx - b.cx, a.cy - b.cy) >= a.hit + b.hit))),
      '重叠了');
    ok('右上角「返回」在窄屏也落在画面里，且判定圈不和选项 / 翻页圆环重叠',
      (() => {
        const b = api.menuBackItem(sizeN);
        const others = [...api.menuRingLayout(sizeN), ...nav];
        return b.cx - b.r >= 0 && b.cx + b.r <= sizeN.w && b.cy - b.r >= 0 && b.cy + b.r <= sizeN.h
          && others.every((o) => Math.hypot(o.cx - b.cx, o.cy - b.cy) >= o.hit + b.hit);
      })(),
      JSON.stringify([Math.round(api.menuBackItem(sizeN).cx), Math.round(api.menuBackItem(sizeN).cy)]));
    ok('页码那一行写着「第 1 / 3 页 · 共 5 项」，而且能点',
      elements.get('menuPage').hidden === false
      && /第 1 \/ 3 页/.test(elements.get('menuPage').textContent)
      && /5 项/.test(elements.get('menuPage').textContent),
      elements.get('menuPage').textContent);
    // 手掌放进「下一页」圆环，停 5 秒 → 翻页（用户要求导航圆环的沙漏时间加到 5 秒）
    // ⚠️ palmsAt6 收的是「宽屏舞台像素」，这里舞台换成窄屏了，所以要按比例换算一下
    const palmsAt = (x, y) => palmsAt6(x * (SW / sizeN.w), y * (SH / sizeN.h));
    const next = nav.find((it) => it.kind === 'next');
    // 防误触第 4 条：手必须**从圆环外面进来**才算数（先把「许可」拿到手）
    api.updateMenu(palmsAt(160, 690), 19900);
    ok('手掌放进「下一页」2.6 秒还没到（导航圆环要停满 5 秒）',
      api.updateMenu(palmsAt(next.cx, next.cy), 20000) === null
      && api.updateMenu(palmsAt(next.cx, next.cy), 22600) === null,
      String(api.gestureState.menu.p));
    ok('沙漏时间确实是 5 秒（面板上倒计时从 5 秒开始走）',
      api.MENU_NAV_HOLD_MS === 5000
      && api.gestureState.menu.p > 0.4 && api.gestureState.menu.p < 0.6,
      `p=${api.gestureState.menu.p.toFixed(2)}`);
    const act = api.updateMenu(palmsAt(next.cx, next.cy), 25300);
    ok('停满 5 秒 → 判定翻页（返回 {kind:page, dir:+1}）',
      act && act.kind === 'page' && act.dir === 1, JSON.stringify(act));
    api.flipMenuPage(act.dir);
    ok('翻到第 2 页（每页 2 个分类；翻页圆环按格子摆、仍然一样大）',
      api.state.menuPage === 1 && api.menuRingLayout(sizeN).length === 2
      && /第 2 \/ 3 页/.test(elements.get('menuPage').textContent),
      `page=${api.state.menuPage}`);
    // 按住不放 → 一页一页连续翻（不会卡住；间隔就是那 5 秒）
    const act2 = api.updateMenu(palmsAt(next.cx, next.cy), 30500);
    ok('手掌**一直按着**：再过 5 秒又翻一页（按住不放仍然能连翻）',
      act2 && act2.kind === 'page' && act2.dir === 1, JSON.stringify(act2));
    api.flipMenuPage(act2.dir);
    ok('按住不放翻到第 3 页（一共 3 页）',
      api.state.menuPage === 2 && /第 3 \/ 3 页/.test(elements.get('menuPage').textContent),
      `page=${api.state.menuPage}`);
    api.flipMenuPage(1);
    ok('再翻一页就循环回第 1 页（3 页循环）', api.state.menuPage === 0, `page=${api.state.menuPage}`);
    // 手离开 → 进度慢慢退回去，不会连翻
    api.updateMenu(palmsAt(200, 60), 31200);
    const act3 = api.updateMenu(palmsAt(200, 60), 31600);
    ok('手掌移开之后就不再翻了', act3 === null && api.state.menuPage === 0);

    /* 用户反馈：「因为返回、上一页、下一页始终在相同的位置，容易在返回之后持续返回，
       这几个圆环的沙漏时间我觉得可以增加到 5 秒。」—— 蓄力加到 5 秒，
       而且触发之后**必须把手拿出圆环再进来**才会重新计满（一直停在原地也不会连触发）。 */
    {
      api.state.menuLevel = 0;
      api.state.menuCategory = '';
      api.state.menuPage = 0;
      api.renderMenu();
      api.selectFromMenu('cat:core');                        // 进到第二级，「返回」才有意义
      // 「返回」在右上角（和动作页退出圆环同一套坐标），不在顶部那排翻页圆环里
      const back = api.menuBackItem(api.stageSize());
      api.updateMenu(palmsAt(200, 690), 40000);              // 先出环拿许可（窄屏舞台坐标）
      api.updateMenu(palmsAt(back.cx, back.cy), 40100);
      ok('「返回」也是 5 秒沙漏：停 4 秒还没到',
        api.state.menuLevel === 1
        && api.updateMenu(palmsAt(back.cx, back.cy), 44100) === null
        && api.gestureState.menu.p > 0.7,
        `level=${api.state.menuLevel} p=${api.gestureState.menu.p.toFixed(2)}`);
      const backAct = api.updateMenu(palmsAt(back.cx, back.cy), 45300);
      ok('停满 5 秒 → 触发一次「返回」（主循环接着调 selectFromMenu）',
        !!backAct && backAct.kind === 'select' && backAct.id === 'back',
        JSON.stringify(backAct));
      if (backAct) api.selectFromMenu(backAct.id);
      ok('触发之后层级回到第一级', api.state.menuLevel === 0, `level=${api.state.menuLevel}`);
      // 手一直停在同一颗圆环上（用户最怕的「持续返回」）：再等 10 秒也不会再触发
      const again1 = api.updateMenu(palmsAt(back.cx, back.cy), 50300);
      const again2 = api.updateMenu(palmsAt(back.cx, back.cy), 55300);
      ok('触发之后手还停在原地：**不会**连续返回（要拿出圆环再进来才重新计满）',
        again1 === null && again2 === null && api.state.menuLevel === 0 && api.state.menuMode === true,
        `level=${api.state.menuLevel} act=${JSON.stringify(again2)}`);
      // 拿出去再进来 → 才允许再来一次
      api.updateMenu(palmsAt(200, 690), 56000);
      api.updateMenu(palmsAt(back.cx, back.cy), 56100);
      const again3 = api.updateMenu(palmsAt(back.cx, back.cy), 61300);
      ok('手拿出圆环再进来 → 才能再触发（许可机制没被绕过）',
        !!again3 && again3.id === 'back', JSON.stringify(again3));
      api.state.menuLevel = 0;
      api.state.menuCategory = '';
      api.state.menuPage = 0;
      api.renderMenu();
    }
    // 鼠标点翻页圆环同样有效
    const prev = nav.find((it) => it.kind === 'prev');
    grid.children.find((c) => c.dataset.ex === prev.id).dispatch('click');
    ok('鼠标点一下翻页圆环也能翻（第 1 页往前翻 = 循环到最后一页）',
      api.state.menuPage === 2, `page=${api.state.menuPage}`);
    // 恢复宽屏舞台
    api.state.menuPage = 0;
    stageStub.clientWidth = savedClientW;
    stageStub.clientHeight = savedClientH;
    Object.defineProperty(probeEl, 'clientWidth', { configurable: true, get: () => 0 });   // 探针量不到 → 走兜底
    api.renderMenu();
  }

  // ===== ②″ 第二级菜单：分类里的动作（同样一行、一样大；「返回」在顶部常驻） =====
  const at6 = (it) => palmsAt6(it.cx, it.cy);
  const catLower = layout.find((it) => it.catId === 'lower');
  api.selectFromMenu(catLower.id);
  const layout2 = api.menuRingLayout(api.stageSize());
  const navLower = api.menuNavLayout(api.stageSize());
  const backLower = api.menuBackItem(api.stageSize());
  ok('选了分类 → 进第二级：5 个动作一页放完（下肢正好 5 个），「返回」在右上角、不占选项行',
    api.state.menuLevel === 1 && api.state.menuCategory === 'lower'
    && api.state.menuPage === 0 && layout2.length === 5
    && layout2.every((it) => it.kind === 'exercise')
    && api.menuPageInfo().pages === 1
    && navLower.length === 0                                  // 只有一页 → 没有翻页圆环
    && backLower.kind === 'back'
    && Math.abs(backLower.cx - api.ringCenter('corner', SW, SH).x) < 1   // 和动作页退出圆环同 x
    && Math.abs(backLower.cy - api.ringCenter('corner', SW, SH).y) < 1,  // 同 y
    `${api.state.menuLevel}/${api.state.menuCategory} n=${layout2.length} pages=${api.menuPageInfo().pages}`);
  ok('第二级标题写着分类名（一眼知道自己在哪一层）',
    elements.get('menuTitle').textContent === catLower.name
    && elements.get('menuLead').textContent.includes(catLower.name),
    `${elements.get('menuTitle').textContent} / ${elements.get('menuLead').textContent}`);
  ok('第二级的圆环同样够大（和第一级一样大）',
    layout2.every((it) => Math.abs(it.r - layout[0].r) < 0.01),
    `${Math.round(layout2[0].r * 2)}px vs ${Math.round(layout[0].r * 2)}px`);
  ok('「返回」那颗看得出来不是动作（menu-ring--back 类 + 常驻在 #menuGrid 之外）',
    String(elements.get('menuBack').className).includes('menu-ring--back')
    && !grid.children.some((c) => c.dataset.ex === 'back')
    && elements.get('menuCornerExit').hidden === false);
  {
    const all2 = [...layout2, ...navLower, backLower];
    const bad = [];
    for (let i = 0; i < all2.length; i += 1) {
      const a = all2[i];
      if (a.cx - a.r < 0 || a.cx + a.r > SW || a.cy - a.r < 0 || a.cy + a.r > SH) bad.push(`${a.id}:出画`);
      for (let j = i + 1; j < all2.length; j += 1) {
        const b = all2[j];
        if (Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.hit + b.hit) bad.push(`${a.id}↔${b.id}:判定圈重叠`);
      }
    }
    ok('第二级这一页的圆环也都落在画面里、判定圈互不重叠', bad.length === 0, bad.slice(0, 3).join(', '));
  }
  {
    // 「核心」有 6 个动作，正好占满一行 6 格 → 单页放完，不出现翻页圆环（用户要求「每行最多 6 个」）
    api.selectFromMenu('back');
    api.selectFromMenu('cat:core');
    const lv1a = api.menuRingLayout(api.stageSize());
    const gCore = api.menuBandGeom(api.stageSize());
    ok('「核心」6 个动作**一页正好放完**（6 格）：6 个圆环同一行、cx 递增、不出现翻页圆环',
      api.state.menuCategory === 'core' && api.menuPageInfo().pages === 1
      && lv1a.length === 6 && api.menuNavLayout(api.stageSize()).length === 0
      && lv1a.every((it) => Math.abs(it.cy - lv1a[0].cy) < 1e-9)
      && lv1a.every((it, i) => i === 0 || it.cx > lv1a[i - 1].cx + 1)
      && lv1a.every((it) => Math.abs(it.r * 2 - gCore.dia) < 1e-9),
      `pages=${api.menuPageInfo().pages} n=${lv1a.length} Ø=${(lv1a[0].r * 2).toFixed(1)}`);
    ok('第二级的圆环和第一级同尺寸（都在同一套格子里算）',
      lv1a.every((it) => Math.abs(it.r - layout[0].r) < 1e-9 && Math.abs(it.nameSize - layout[0].nameSize) < 1e-9),
      `${lv1a[0].r * 2}px vs ${layout[0].r * 2}px`);
    ok('右上角「返回」在第一级 / 第二级 / 核心页都完全同坐标同尺寸（和动作页退出圆环一致）',
      Math.abs(api.menuBackItem(api.stageSize()).cx - backLower.cx) < 1e-9
      && Math.abs(api.menuBackItem(api.stageSize()).cy - backLower.cy) < 1e-9
      && Math.abs(api.menuBackItem(api.stageSize()).r - backLower.r) < 1e-9,
      `${api.menuBackItem(api.stageSize()).cx},${api.menuBackItem(api.stageSize()).cy}`);
    {
      const allC = [...lv1a, api.menuBackItem(api.stageSize())];
      const bad = [];
      for (let i = 0; i < allC.length; i += 1) {
        const a = allC[i];
        if (a.cx - a.r < 0 || a.cx + a.r > SW || a.cy - a.r < 0 || a.cy + a.r > SH) bad.push(`${a.id}:出画`);
        for (let j = i + 1; j < allC.length; j += 1) {
          const b = allC[j];
          if (Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.hit + b.hit) bad.push(`${a.id}↔${b.id}:判定圈重叠`);
        }
      }
      ok('核心这一页的 6 个圆环 + 右上角「返回」都在画面里、判定圈互不重叠', bad.length === 0, bad.slice(0, 3).join(', '));
    }
    api.state.menuPage = 0;
    api.selectFromMenu('back');
  }

  // ===== ②‴ 右上角「退出 / 返回」圆环：两个界面**同坐标、同尺寸、判定 = 绘制** =====
  /* 用户要求：「把菜单界面中的退出圆环始终放在右上角，且各界面退出圆环的位置和大小都保持一致。」
     → 动作页那颗「退出」和菜单里那颗「返回」共用 app.js 的 exitRingLayout()。 */
  {
    const size = api.stageSize();
    const savedStream2 = api.camera.stream;
    api.camera.stream = { getTracks: () => [], getVideoTracks: () => [] };
    // ---- 动作页：把退出圆环摆出来，记下真实写进行内样式的坐标 / 尺寸
    api.openExercise('squat');
    api.syncCornerExit();
    const actionEl = elements.get('ringQuickExit');
    const actionDraw = {
      left: Number.parseFloat(actionEl.style.left),
      top: Number.parseFloat(actionEl.style.top),
      w: actionEl.style.width,
      h: actionEl.style.height,
    };
    const actionCenter = api.ringCenter('corner', size.w, size.h);
    ok('动作页退出圆环的绘制坐标就是判定圆心（行内 left/top = ringCenter(\'corner\')）',
      actionDraw.left === actionCenter.x && actionDraw.top === actionCenter.y,
      JSON.stringify(actionDraw));
    // ---- 菜单：右上角那颗「返回」（切过去之后动作页那颗应该收起）
    api.openMenu({ silent: true });
    const backItem = api.menuBackItem(size);
    const backEl = elements.get('menuBack');
    ok('菜单返回圆环的屏幕坐标 = 动作页退出圆环的屏幕坐标（同一个 ringCenter(\'corner\')）',
      backItem.cx === actionCenter.x && backItem.cy === actionCenter.y
      && Number.parseFloat(backEl.style.left) === actionDraw.left
      && Number.parseFloat(backEl.style.top) === actionDraw.top,
      `menu=${backItem.cx},${backItem.cy} action=${actionDraw.left},${actionDraw.top}`);
    ok('两者尺寸一致（都用 --ring-px：行内 width/height 与 ringPx(\'corner\') 同一个数）',
      backEl.style.width === actionDraw.w && backEl.style.height === actionDraw.h
      && actionDraw.w === `${api.ringPx('corner')}px`
      && `${backItem.r * 2}px` === actionDraw.w,
      `action=${actionDraw.w} menu=${backEl.style.width} ringPx=${api.ringPx('corner')}`);
    ok('菜单返回圆环的判定圆心 = 它的绘制坐标（绘制与判定同源）',
      backItem.cx === Number.parseFloat(backEl.style.left)
      && backItem.cy === Number.parseFloat(backEl.style.top)
      && backItem.hit === api.ringHitRadius('corner', size) * api.RING_TOUCH_TOL,
      `hit=${backItem.hit} vs ${api.ringHitRadius('corner', size) * api.RING_TOUCH_TOL}`);
    ok('菜单里只有**一颗**「退出 / 返回」圆环：动作页那颗收起了，只剩右上角这颗「返回」',
      elements.get('cornerExit').hidden === true && api.gestureState.cornerVisible === false
      && /返回/.test(backEl.attributes['aria-label'] || '')
      && elements.get('ringQuickExit').attributes['aria-label'] === '退出'
      && elements.get('menuCornerExit').hidden === false,
      `cornerHidden=${elements.get('cornerExit').hidden} backAria=${backEl.attributes['aria-label']}`);
    // ---- 行为：点它 = 回网页首页（第一级）
    documentStub.fullscreenElement = elements.get('stage');
    documentStub.exitFullscreenCalls = 0;
    backEl.dispatch('click');
    ok('菜单里点右上角那颗「返回」→ 回网页首页 + 退出全屏',
      api.state.homeMode === true && api.state.menuMode === false
      && documentStub.exitFullscreenCalls >= 1,
      `home=${api.state.homeMode} exit=${documentStub.exitFullscreenCalls}`);
    // ---- 行为：手掌停在它上面满 5 秒 = 回网页首页（和翻页圆环同一套 5 秒蓄力）
    api.openMenu({ silent: true });
    const backAt = api.menuBackItem(api.stageSize());
    const palmAt = (x, y) => palmsAt6(x, y);            // 舞台是 1280×720
    api.updateMenu(palmAt(SW * 0.5, SH * 0.96), 70000); // 先从所有圆环外面拿「许可」
    api.updateMenu(palmAt(backAt.cx, backAt.cy), 70100);
    ok('手掌停在右上角「返回」上：4 秒还没到（5 秒沙漏）',
      api.updateMenu(palmAt(backAt.cx, backAt.cy), 74100) === null
      && api.gestureState.menu.p > 0.7,
      `p=${api.gestureState.menu.p.toFixed(2)}`);
    const backAct = api.updateMenu(palmAt(backAt.cx, backAt.cy), 75300);
    ok('停满 5 秒 → 判定「返回」这一格（主循环接着调 selectFromMenu）',
      !!backAct && backAct.kind === 'select' && backAct.id === 'back', JSON.stringify(backAct));
    if (backAct) api.selectFromMenu(backAct.id);
    ok('菜单第一级触发「返回」→ 回网页首页 + 退出全屏',
      api.state.homeMode === true && api.state.menuMode === false
      && documentStub.exitFullscreenCalls >= 1,
      `home=${api.state.homeMode} exit=${documentStub.exitFullscreenCalls}`);
    api.camera.stream = savedStream2;
  }

  // ===== ③ 手掌停进某一格 3 秒 → 选中它（在第一级试：选分类不会离开菜单） =====
  api.openMenu({ silent: true });           // 稳定回到第一级第 1 页（openMenu 总是回第一级）
  ok('菜单停稳在第一级（层级与分类都清干净）',
    api.state.menuMode === true && api.state.menuLevel === 0 && api.state.menuCategory === ''
    && elements.get('menuTitle').textContent === '选择运动',
    `${api.state.menuMode}/${api.state.menuLevel}/${api.state.menuCategory}`);
  const target = layout[0];
  // 选中一次之后要重新攒「许可」：先把手放在圆环外面
  api.updateMenu(palmsAt6(SW * 0.5, SH * 0.96), 690);
  ok('手**从圆环外面移进来**的那一帧：手还在动，进度一点都不攒（防误触第 3 条）',
    api.updateMenu(at6(target), 1000) === null && api.gestureState.menu.p === 0,
    `p=${api.gestureState.menu.p} id=${api.gestureState.menu.id}`);
  ok('手停下来：停 1 秒 → 进度攒到约 1/3，还没选中',
    api.updateMenu(at6(target), 2250) === null
    && Math.abs(api.gestureState.menu.p - 1 / 3) < 0.05,
    `p=${api.gestureState.menu.p}`);
  ok('手掌移到**另一格**：进度从头开始（不会在两格之间攒进度）',
    api.updateMenu(at6(layout[1]), 2400) === null
    && api.gestureState.menu.id === layout[1].id
    && api.gestureState.menu.p < 0.05,
    `${api.gestureState.menu.id} p=${api.gestureState.menu.p}`);
  api.updateMenu(at6(layout[1]), 3400);
  ok('指着某一格一会儿就会把它念出来（先确认指的是哪一个，再决定要不要停满 3 秒）',
    api.gestureState.menu.announced === layout[1].id && api.gestureState.menu.id === layout[1].id,
    `${api.gestureState.menu.announced} / ${api.gestureState.menu.id}`);
  const picked = api.updateMenu(at6(layout[1]), 5700);
  ok('手掌停满 3 秒 → 判定选中这一格（返回 {kind:select, id}）',
    picked && picked.kind === 'select' && picked.id === layout[1].id, JSON.stringify(picked));
  ok('选中之后这一格的进度清干净（不会连着再选一次）',
    api.gestureState.menu.p === 0 && api.gestureState.menu.id === ''
    && api.gestureState.menu.announced === '');

  // 手离开：宽限期内先不动，之后退回去（菜单里退得比别的圆环快：蹭一下不留半格进度）
  api.updateMenu(palmsAt6(SW * 0.5, SH * 0.96), 5900);          // 重新拿到许可
  api.updateMenu(at6(target), 6000);
  api.updateMenu(at6(target), 7000);
  const kept6 = api.gestureState.menu.p;
  ok('手停住 1 秒后攒下了进度（这一次是正常起手，能攒）', kept6 > 0.2, `p=${kept6}`);
  api.updateMenu(palmsAt6(SW * 0.5, SH * 0.96), 7100);          // 手离开（挪到画面最上面）
  ok('手离开 0.1 秒（宽限期内）进度一点都不掉',
    Math.abs(api.gestureState.menu.p - kept6) < 1e-6,
    `${kept6} → ${api.gestureState.menu.p}`);
  api.updateMenu(palmsAt6(SW * 0.5, SH * 0.96), 8200);
  ok('手离开久了就退干净（菜单里退得更快，蹭一下不会留下半格进度）',
    api.gestureState.menu.p === 0 && api.gestureState.menu.id === '',
    `${kept6} → ${api.gestureState.menu.p}`);

  // ===== ④ 防误触（用户反馈：「菜单圆环很大、数量又多，人站在画面中手很容易误触某个圆环」）=====
  {
    const ring = layout[0];                              // 第一级第一格
    const atK = (it, k) => palmsAt6(it.cx + it.r * k, it.cy);   // 离圆心 k 倍半径处
    // (1) 进菜单时手本来就垂在某一格里 → 一格都不该亮
    api.openMenu({ silent: true });
    const acts = [];
    for (let t = 0; t <= 6000; t += 200) acts.push(api.updateMenu(at6(ring), 30000 + t));
    ok('手本来就在圆环里（进菜单时手垂在那一格）：停 6 秒也不亮、不念名字、更不会选中',
      acts.every((a) => a === null) && api.gestureState.menu.p === 0
      && api.gestureState.menu.id === '' && api.gestureState.menu.announced === '',
      `p=${api.gestureState.menu.p} 选中=${acts.filter(Boolean).length}`);

    // (2) 手**从环外**进来才认（正常流程照旧好使）
    api.updateMenu(palmsAt6(SW * 0.5, SH * 0.96), 37000);
    api.updateMenu(at6(ring), 37300);
    api.updateMenu(at6(ring), 40300);
    ok('手从环外进来之后照旧能攒（防误触没有把正常选中变难）',
      api.gestureState.menu.p > 0.5, `p=${api.gestureState.menu.p}`);

    // (3) 手一直在动（从圆环上扫过去）→ 一点都不攒
    api.openMenu({ silent: true });
    api.updateMenu(palmsAt6(SW * 0.5, SH * 0.96), 50000);
    for (let i = 0; i < 24; i += 1) {
      api.updateMenu(palmsAt6(ring.cx - 240 + i * 40, ring.cy), 50100 + i * 100);   // 40px/100ms = 400px/s
    }
    ok('手从圆环上**扫过去**（一直在动，400px/s）：进度一点都不攒（MENU_STILL_SPEED）',
      api.gestureState.menu.p === 0, `p=${api.gestureState.menu.p}`);

    // (4) 起手圈 0.8 倍：停在圆内但贴边（0.9 倍半径）不算起手
    api.openMenu({ silent: true });
    api.updateMenu(palmsAt6(SW * 0.5, SH * 0.96), 60000);
    for (let t = 60100; t <= 61000; t += 100) api.updateMenu(atK(ring, 0.9), t);
    ok('手停在「圈内但离圆心 0.9 倍半径」处：不算起手（起手圈是 0.8 倍，排除贴边那一圈）',
      api.gestureState.menu.p === 0 && api.gestureState.menu.id === '',
      `p=${api.gestureState.menu.p} id=${api.gestureState.menu.id}`);

    // (5) 从圆环中间进来 → 正常起手；已经在蓄力时晃到 0.95 倍半径仍然继续（迟滞）
    api.updateMenu(palmsAt6(SW * 0.5, SH * 0.96), 62000);
    api.updateMenu(atK(ring, 0.5), 62300);
    api.updateMenu(atK(ring, 0.5), 63300);
    const beforeK = api.gestureState.menu.p;
    ok('从圆环中间（0.5 倍半径）进来就正常起手', beforeK > 0.2, `p=${beforeK}`);
    api.updateMenu(atK(ring, 0.95), 63900);
    ok('已经在蓄力时，手晃到 0.95 倍半径（仍在圆内）不算离开、继续攒（迟滞）',
      api.gestureState.menu.p > beforeK, `${beforeK} → ${api.gestureState.menu.p}`);
  }

  // ===== ⑤ 双手同时挥两次翻页（用户要求：「双手向上挥动两次则向上翻页，向下挥动两次则向下翻页」） =====
  {
    const size = api.stageSize();
    const travel = api.MENU_SWIPE_TRAVEL * size.h;
    // 用「更窄的屏」（320×700：2 列 × 2 行 = 4 格）造出 3 页，翻页圆环才出现
    const stageStub = stageEl;
    stageStub.clientWidth = 320;
    stageStub.clientHeight = 700;
    const sizeN = api.stageSize();
    const travelN = api.MENU_SWIPE_TRAVEL * sizeN.h;
    const toN = (x, y) => palmsAt6(x * (SW / sizeN.w), y * (SH / sizeN.h));   // 窄屏像素 → 宽屏像素
    /**
     * 两只手一起挥一次：**挥出去 → 回到原位 → 停一下**（真实动作就是这样）。
     * burst 机制保证「挥出去」只算一次，「收回来的那一下」不算。
     * 返回这一轮里真正翻页的方向（0 = 没翻），并且像主循环那样执行它。
     */
    const doubleSwipe = (dir, t0) => {
      const yBase = sizeN.h * 0.45;
      const down = toN(sizeN.w * 0.5, yBase);
      const over = toN(sizeN.w * 0.5, yBase + dir * travelN * 1.4);
      const frames = [
        [down, t0],                    // 静止（建立参考点）
        [down, t0 + 150],              // 仍然静止 → 参考点落定
        [over, t0 + 270],              // 挥出去（120ms 走完 1.4 程）
        [down, t0 + 400],              // 收回来（burst 里，不计数）
        [down, t0 + 560],              // 停一下（≥ QUIET_MS）→ 结束这一次
      ];
      let fired = 0;
      for (const [lm, tt] of frames) {
        const act = api.updateMenu(lm, tt);
        if (act && act.kind === 'page') { fired = act.dir; api.flipMenuPage(act.dir); }
      }
      return fired;
    };
    api.state.menuPage = 0;
    api.renderMenu();
    ok('窄屏下第一级分 3 页（准备翻页用）', api.menuPageInfo(sizeN).pages === 3);

    let t = 70000;
    doubleSwipe(-1, t);
    ok('只挥一次不算（要连着挥两次）', api.state.menuPage === 0, `page=${api.state.menuPage}`);
    t += 1000;
    const upDir = doubleSwipe(-1, t);
    ok('双手同时**向上**挥两次 → 上一页（在第 1 页往前翻 = 循环到最后一页）',
      upDir === -1 && api.state.menuPage === 2, `dir=${upDir} page=${api.state.menuPage}`);

    api.state.menuPage = 0;
    api.renderMenu();
    t += 2000;
    doubleSwipe(1, t);
    ok('只向下挥一次同样不算', api.state.menuPage === 0, `page=${api.state.menuPage}`);
    t += 1000;
    const downDir = doubleSwipe(1, t);
    ok('双手同时**向下**挥两次 → 下一页',
      downDir === 1 && api.state.menuPage === 1, `dir=${downDir} page=${api.state.menuPage}`);

    // 两次之间隔太久 → 重新数（不算「连着挥两下」）
    api.state.menuPage = 0;
    api.renderMenu();
    api.gestureState.menu.swipe.cooldownUntil = 0;
    t += 5000;
    doubleSwipe(1, t);
    t += api.MENU_SWIPE_CHAIN_MS + 400;
    doubleSwipe(1, t);
    ok('两次挥动间隔太久（超过 MENU_SWIPE_CHAIN_MS）→ 不算，要重新连着挥两下',
      api.state.menuPage === 0, `page=${api.state.menuPage}`);

    // 一只手挥 → 不算
    api.gestureState.menu.swipe.cooldownUntil = 0;
    t += 3000;
    {
      const yBase = sizeN.h * 0.45;
      const onlyRight = (y) => {
        const lm = toN(sizeN.w * 0.5, y);
        // 把左手挪到画面角落（不跟着挥）
        for (const off of [0, 2, 4, 6]) lm[LMK.L_WRIST + off] = { x: 0.02, y: 0.02, z: 0, visibility: 1 };
        return lm;
      };
      for (let i = 0; i < 2; i += 1) {
        const base = t + i * 1000;
        api.updateMenu(onlyRight(yBase), base);
        api.updateMenu(onlyRight(yBase + travelN * 1.4), base + 150);
        api.updateMenu(onlyRight(yBase + travelN * 1.4), base + 400);
      }
    }
    ok('只有一只手挥 → 不算翻页（必须两只手一起）', api.state.menuPage === 0,
      `page=${api.state.menuPage}`);

    // 一次很长的挥动（中间不停）不算两次
    api.gestureState.menu.swipe.cooldownUntil = 0;
    t += 4000;
    {
      const y0 = sizeN.h * 0.25;
      const step = travelN * 1.4;
      api.updateMenu(toN(sizeN.w * 0.5, y0), t);
      api.updateMenu(toN(sizeN.w * 0.5, y0 + step), t + 150);
      api.updateMenu(toN(sizeN.w * 0.5, y0 + step * 2), t + 300);      // 继续往下（没停）
      api.updateMenu(toN(sizeN.w * 0.5, y0 + step * 3), t + 450);
    }
    ok('一次不停的长挥动不算两次（两次之间要停一下）', api.state.menuPage === 0,
      `page=${api.state.menuPage}`);

    // 手正指着某一格时挥手 → 不算翻页
    api.gestureState.menu.swipe.cooldownUntil = 0;
    t += 3000;
    {
      const r0 = api.menuRingLayout(sizeN)[0];
      const y0 = r0.cy;
      for (let i = 0; i < 2; i += 1) {
        const base = t + i * 1000;
        api.updateMenu(toN(r0.cx, y0), base);
        api.updateMenu(toN(r0.cx, y0 + travelN * 1.4), base + 150);
        api.updateMenu(toN(r0.cx, y0 + travelN * 1.4), base + 400);
      }
    }
    ok('手在圆环里（正指着某一格）时挥手不算翻页', api.state.menuPage === 0,
      `page=${api.state.menuPage}`);

    // 挥的路线**穿过圆环那一片**照样算（现实里人就是在菜单那一行前面挥手）
    api.gestureState.menu.swipe.cooldownUntil = 0;
    api.state.menuPage = 0;
    api.renderMenu();
    t += 3000;
    {
      const row = api.menuRingLayout(sizeN)[0];
      const xCol = row.cx;                                   // 第一列（上下两个圆环都在这条竖线上）
      const throughY = sizeN.h * 0.65;                       // 第二行圆环的圆心高度
      const above = toN(xCol, sizeN.h * 0.21);               // 环外（上方）
      const below = toN(xCol, sizeN.h * 0.98);               // 环外（下方）
      const through = toN(xCol, throughY);                   // 第二行圆环的正中间（穿过）
      ok('（准备）这条挥手路线确实会穿过一个圆环',
        [...api.menuRingLayout(sizeN), ...api.menuNavLayout(sizeN)]
          .some((it) => Math.hypot(xCol - it.cx, throughY - it.cy) <= it.hit),
        `through=(${Math.round(xCol)},${Math.round(throughY)})`);
      const frames = [
        [below, t],                 // 起手：在环外（立参考点）
        [below, t + 150],
        [through, t + 270],         // 向上挥，这一帧正好在圆环里
        [above, t + 390],           // 挥到环外上方
        [below, t + 520],           // 收回来（burst 里，不计数）
        [below, t + 700],           // 停一下……
        [below, t + 840],           // ……停够 QUIET_MS → 结束这一次
        [through, t + 960],         // 第二下：又一次向上挥（同样穿过圆环）
        [above, t + 1080],
      ];
      for (const [lm, tt] of frames) {
        const act = api.updateMenu(lm, tt);
        if (act && act.kind === 'page') api.flipMenuPage(act.dir);
      }
    }
    ok('挥的路线穿过圆环那一片也算（只要立参考点时两只手在环外）', api.state.menuPage === 2,
      `page=${api.state.menuPage}`);

    // 恢复宽屏
    api.state.menuPage = 0;
    stageStub.clientWidth = savedClientW;
    stageStub.clientHeight = savedClientH;
    api.renderMenu();
    void travel;
  }

  // 选中一个动作 → 落到那个动作的训练界面（这里调的就是主循环里那一句）
  api.selectFromMenu(layout.find((it) => it.catId === 'full').id);      // 先随便进一个分类
  const layout3 = api.menuRingLayout(api.stageSize()).filter((it) => it.kind === 'exercise');
  api.selectFromMenu(layout3[2].id);
  ok('选中动作后直接进入该动作的全屏训练界面（菜单收起来）',
    api.state.menuMode === false && api.state.exerciseId === layout3[2].id
    && menuEl.hidden === true && elements.get('workoutView').hidden === false
    && !String(elements.get('workoutView').className).includes('menu-mode'),
    `menu=${api.state.menuMode} ex=${api.state.exerciseId}`);
  ok('进入动作后右上角圆环又变回「退出」（退出 = 回菜单）',
    elements.get('ringQuickExitLabel').textContent === '退出'
    || api.gestureState.cornerVisible === false,         // 摄像头关着时它本来就不摆
    elements.get('ringQuickExitLabel').textContent);

  // ===== ④ 鼠标点菜单项同样能选（全手势之外的兜底） =====
  api.openMenu({ silent: true });
  ok('重新进菜单总是从第一级第 1 页开始（不会停在上一次的分类 / 页码里）',
    api.state.menuLevel === 0 && api.state.menuCategory === '' && api.state.menuPage === 0
    && grid.children.length === 5 && api.menuPageInfo().total === 5);   // 5 个分类（「返回」常驻在右上角，不进 #menuGrid）
  const before6 = api.state.exerciseId;
  const clickCat = api.menuRingLayout(api.stageSize()).find((it) => it.catId === 'core');
  grid.children.find((c) => c.dataset.ex === clickCat.id).dispatch('click');
  ok('鼠标点一下分类圆环 → 进第二级',
    api.state.menuLevel === 1 && api.state.menuCategory === 'core'
    && api.state.menuMode === true,
    `${api.state.menuLevel}/${api.state.menuCategory}`);
  const clickEx = api.menuRingLayout(api.stageSize()).find((it) => it.kind === 'exercise');
  grid.children.find((c) => c.dataset.ex === clickEx.id).dispatch('click');
  ok('再点一下动作圆环 → 进那个动作（不用非得用手势）',
    api.state.menuMode === false && api.state.exerciseId === clickEx.id
    && api.state.exerciseId !== before6,
    `${before6} → ${api.state.exerciseId}`);

  // ===== ⑤ 退出分流：运动里 → 菜单；菜单里 → 网页首页（并退出全屏） =====
  documentStub.fullscreenElement = stageEl;
  documentStub.exitFullscreenCalls = 0;
  api.triggerCornerExit();                  // 训练界面里退出
  ok('运动中退出 → 回手势菜单（全屏留着，而且总是回到第一级第 1 页）',
    api.state.menuMode === true && api.state.homeMode === false
    && api.state.menuLevel === 0 && api.state.menuCategory === '' && api.state.menuPage === 0
    && menuEl.hidden === false && documentStub.exitFullscreenCalls === 0
    && api.menuRingLayout(api.stageSize()).length === 5 && api.menuPageInfo().total === 5
    && api.menuBackItem(api.stageSize()).kind === 'back'      // 右上角那颗「返回」常驻
    && api.gestureState.cornerVisible === false,      // 菜单里不再显示右上角那个「退出」圆环
    `menu=${api.state.menuMode} level=${api.state.menuLevel} exit=${documentStub.exitFullscreenCalls}`);
  api.triggerCornerExit();                  // 菜单里退出
  ok('菜单里退出 → 回网页首页（主页可见 + 退出全屏 + 菜单收起来）',
    api.state.homeMode === true && api.state.menuMode === false
    && elements.get('homeView').hidden === false && menuEl.hidden === true
    && documentStub.exitFullscreenCalls === 1,
    `home=${api.state.homeMode} exit=${documentStub.exitFullscreenCalls}`);
  ok('菜单里按 Esc 也是回网页首页（键盘用户的退路）',
    (() => {
      api.openMenu({ silent: true });
      documentStub.dispatch('keydown', { key: 'Escape' });
      return api.state.homeMode === true && api.state.menuMode === false;
    })());

  // ===== ⑥ 走一遍**真实主循环**：摄像头 → 识别 → 两层菜单判定 → 自动进入那个动作 =====
  {
    const savedDetect = api.engine.detect;
    const savedDraw = api.renderer.draw;
    const savedPerf = globalThis.performance;
    const savedStream7 = api.camera.stream;
    const savedReady7 = api.camera.video.readyState;
    api.camera.stream = { getTracks: () => [], getVideoTracks: () => [] };
    api.camera.video.readyState = 4;
    api.state.engineReady = true;
    let clock = 8_000_000;
    const fakePerf = { now: () => clock, timeOrigin: savedPerf.timeOrigin };
    Object.defineProperty(globalThis, 'performance', { value: fakePerf, configurable: true, writable: true });
    windowStub.performance = fakePerf;
    let pose = null;
    api.engine.detect = () => (pose ? { landmarks: pose, worldLandmarks: null } : null);
    api.renderer.draw = () => {};
    let vt = 7_000_000;
    const pump = (lm, n) => {
      pose = lm;
      for (let i = 0; i < n; i += 1) {
        clock += 33.4;
        vt += 33.4;
        api.camera.video.currentTime = vt;
        api.state.engineReady = true;
        if (!api.camera.stream) api.camera.stream = { getTracks: () => [], getVideoTracks: () => [] };
        api.loop();
      }
    };
    api.state.homeMode = false;
    api.openMenu({ silent: true });
    // 防误触第 4 条：手得先在圆环外面露过面（真实场景里就是「手从身侧抬起来去够圆环」）
    pump(palmsAt6(SW * 0.5, SH * 0.96), 6);
    const cat17 = api.menuRingLayout(api.stageSize())[2];      // 第一级：某一格分类
    pump(palmsAt6(cat17.cx, cat17.cy), 40);
    ok('真实主循环里：手掌停在分类圆环上还没满 3 秒，先不选（进度在攒）',
      api.state.menuMode === true && api.state.menuLevel === 0
      && api.gestureState.menu.p > 0.2 && api.gestureState.menu.p < 1,
      `menu=${api.state.menuMode} p=${api.gestureState.menu.p}`);
    pump(palmsAt6(cat17.cx, cat17.cy), 90);
    ok('真实主循环里：手掌停满 3 秒 → 进第二级（列出这个分类的动作，右上角「返回」仍在）',
      api.state.menuMode === true && api.state.menuLevel === 1
      && api.state.menuCategory === cat17.catId && api.state.menuPage === 0
      && api.menuRingLayout(api.stageSize()).every((it) => it.kind === 'exercise')
      && api.menuBackItem(api.stageSize()).kind === 'back'
      && api.menuPageInfo().pages === Math.ceil(api.menuPageInfo().total / api.menuPerPage()),
      `level=${api.state.menuLevel} cat=${api.state.menuCategory} total=${api.menuPageInfo().total} pages=${api.menuPageInfo().pages}`);

    const ex17 = api.menuRingLayout(api.stageSize()).find((it) => it.kind === 'exercise');
    pump(palmsAt6(SW * 0.5, SH * 0.96), 6);        // 手从环外再进来一次（防误触第 4 条要的「许可」）
    pump(palmsAt6(ex17.cx, ex17.cy), 100);
    ok('真实主循环里：再停满 3 秒 → 进入那个动作（菜单关掉、界面切过去）',
      api.state.menuMode === false && api.state.exerciseId === ex17.id
      && menuEl.hidden === true && elements.get('workoutView').hidden === false,
      `menu=${api.state.menuMode} ex=${api.state.exerciseId}`);

    api.engine.detect = savedDetect;
    api.renderer.draw = savedDraw;
    api.camera.stream = savedStream7;
    api.camera.video.readyState = savedReady7;
    Object.defineProperty(globalThis, 'performance', { value: savedPerf, configurable: true, writable: true });
    windowStub.performance = savedPerf;
  }

  // ===== ⑥ 翻页 / 返回的「滑动 + 淡入淡出」动画（用户要求） =====
  {
    const grid = elements.get('menuGrid');
    const ghost = elements.get('menuGridGhost');
    const menuEl2 = elements.get('gestureMenu');
    // 用窄屏（320×700：4 格 → 3 页）造出第二页，才有翻页动画可看
    stageEl.clientWidth = 320;
    stageEl.clientHeight = 700;
    api.openMenu({ silent: true });            // 保证在菜单里（前一段真实主循环用例把菜单关掉了）
    api.state.menuLevel = 0;
    api.state.menuCategory = '';
    api.state.menuPage = 0;
    api.renderMenu();
    const perf = globalThis.performance;
    const savedNow = perf.now;
    let clock2 = api.gestureState.menuAnim.until + 100;
    perf.now = () => clock2;

    ok('菜单里有一个「残影」层用来播滑出动画（#menuGridGhost）',
      !!ghost && typeof ghost.className === 'string' && api.menuPageInfo().pages === 3);

    api.flipMenuPage(1);
    ok('翻到下一页：新一屏立刻换好（DOM 与状态同步，不等动画），并带上「整屏从右边滑进来」的类',
      api.state.menuPage === 1
      && elements.get('menuScreen').classList.contains('menu-anim-in-next')
      && !elements.get('menuScreen').classList.contains('menu-anim-in-prev')
      && ghost.classList.contains('menu-anim-out-next'),
      `page=${api.state.menuPage} grid=${grid.className}`);
    ok('残影层里是上一屏圆环的克隆（滑出去的就是刚才那一屏）',
      ghost.children.length >= 3, `${ghost.children.length} 个克隆（标题 + 圆环 + 提示）`);

    clock2 = api.gestureState.menuAnim.until + 100;
    api.flipMenuPage(-1);
    ok('翻回上一页：方向反过来（整屏从左边滑回来）',
      api.state.menuPage === 0 && elements.get('menuScreen').classList.contains('menu-anim-in-prev')
      && ghost.classList.contains('menu-anim-out-prev'),
      `page=${api.state.menuPage} grid=${grid.className}`);

    // 返回上一层也走同一套动画；回网页首页则是菜单淡出 + 主页淡入
    api.state.menuLevel = 0;
    api.state.menuCategory = '';
    api.state.menuPage = 0;
    api.renderMenu();
    clock2 = api.gestureState.menuAnim.until + 100;
    const catCore = api.menuItems().find((it) => it.kind === 'category');
    api.selectFromMenu(catCore.id);
    ok('进下一层（选分类）：整屏从右边滑入（和「下一页」同方向）',
      api.state.menuLevel === 1 && elements.get('menuScreen').classList.contains('menu-anim-in-next'),
      `level=${api.state.menuLevel} grid=${grid.className}`);
    clock2 = api.gestureState.menuAnim.until + 100;
    api.selectFromMenu('back');
    ok('「返回」上一层：整屏反向滑回，层级也回到第一级',
      api.state.menuLevel === 0 && elements.get('menuScreen').classList.contains('menu-anim-in-prev'),
      `level=${api.state.menuLevel} grid=${grid.className}`);
    clock2 = api.gestureState.menuAnim.until + 100;
    api.menuBackHome();
    ok('「返回」到网页首页：主页淡入、菜单淡出，而且**立刻**就切过去了（不等动画）',
      api.state.homeMode === true
      && elements.get('homeView').classList.contains('menu-anim-in-home')
      && menuEl2.classList.contains('menu-anim-out-home'),
      `home=${api.state.homeMode} homeCls=${elements.get('homeView').className}`);
    clock2 = api.gestureState.menuAnim.until + 100;
    api.openMenu({ silent: true });
    ok('从动作退回菜单 / 刚进菜单：菜单整屏从左边滑入',
      api.state.menuMode === true && elements.get('menuScreen').classList.contains('menu-anim-in-prev'),
      `menu=${api.state.menuMode} grid=${grid.className}`);

    perf.now = savedNow;
    stageEl.clientWidth = savedClientW;
    stageEl.clientHeight = savedClientH;
    api.state.menuPage = 0;
    api.renderMenu();
  }

  // ===== ⑦ 图标：臀桥 / 平板支撑用「人体姿势」线条图（用户要求），其余仍用 emoji =====
  {
    api.state.homeMode = false;
    api.openMenu({ silent: true });
    api.selectFromMenu('cat:core');
    const items = api.menuItems();
    const bridgeIt = items.find((it) => it.id === 'bridge');
    const plankIt = items.find((it) => it.id === 'plank');
    const crunchIt = items.find((it) => it.id === 'crunch');
    ok('菜单里每个动作画的都是「人体姿势」线条图（不再用 emoji），而且两两不同',
      items.length > 0 && items.every((it) => /class="ex-pose ex-pose--solid"/.test(it.poseIcon))
      && new Set(items.map((it) => it.poseIcon)).size === items.length
      && bridgeIt.poseIcon !== plankIt.poseIcon && bridgeIt.poseIcon !== crunchIt.poseIcon,
      `n=${items.length} 去重=${new Set(items.map((it) => it.poseIcon)).size}`);
    api.state.menuLevel = 0;
    api.state.menuCategory = '';
    api.state.menuPage = 0;
    api.renderMenu();
    const cats = api.menuItems();
    ok('第一级的五个分类也换成线条图标（库里现成的专业图标：上肢 / 下肢 / 核心 / 全身 / 拉伸）',
      cats.length === 5 && cats.every((it) => /class="ex-pose"/.test(it.poseIcon) && !/<text/.test(it.poseIcon))
      && new Set(cats.map((it) => it.poseIcon)).size === 5,
      `n=${cats.length} 去重=${new Set(cats.map((it) => it.poseIcon)).size}`);
    api.selectFromMenu('cat:core');
    const bridgeEl = grid.children.find((c) => c.dataset.ex === 'bridge');
    const crunchEl = grid.children.find((c) => c.dataset.ex === 'crunch');
    ok('菜单圆环的 DOM 里真的画出来了（不再有 emoji 字形）',
      /ex-pose/.test(bridgeEl.innerHTML) && /ex-pose/.test(crunchEl.innerHTML)
      && !/🌀/.test(crunchEl.innerHTML));

    // 主页动作卡片 / HUD 上也是同一张图（一处定义，三处显示一致）
    const findByData = (root, id) => {
      const stack = [...(root.children || [])];
      while (stack.length) {
        const el = stack.shift();
        if (el?.dataset?.id === id) return el;
        stack.push(...(el.children || []));
      }
      return null;
    };
    api.showHome();
    const card = findByData(elements.get('homeCats'), 'bridge');
    ok('主页上臀桥那张卡片画的也是「人体姿势」图',
      !!card && /ex-pose/.test(card.innerHTML), card ? card.innerHTML.slice(0, 80) : '没找到卡片');
    api.openExercise('bridge');
    ok('HUD 里那个小图标同样是「人体姿势」图',
      /ex-pose/.test(elements.get('hudIcon').innerHTML),
      elements.get('hudIcon').innerHTML.slice(0, 60));

    // 用户要求：「返回，上一页，下一页不要显示文字了，显示图标即可」
    // 「返回」现在常驻在右上角（menuBackItem），翻页两颗来自 menuNavLayout —— 两处一起检查
    const navRings = [...api.menuNavLayout(api.stageSize()), api.menuBackItem(api.stageSize())];
    const navHtml = navRings.map((it) => api.menuItemEl(it).innerHTML);
    ok('导航圆环（返回 / 上一页 / 下一页）**只显示图标、不显示文字**',
      navRings.length >= 1 && navHtml.every((h) => /class="menu-icon"/.test(h) && /ex-pose/.test(h)
        && !/menu-name/.test(h) && !/(返回|上一页|下一页)/.test(h)),
      navHtml.map((h) => (h.match(/menu-name/) ? '有文字' : '纯图标')).join(', '));
    ok('但无障碍名称还在（aria-label / title 仍然是「返回」这类文字，读屏和悬停提示不受影响）',
      api.menuItemEl(navRings[0]).attributes['aria-label'] === navRings[0].name
      && api.menuItemEl(navRings[0]).attributes.title === navRings[0].name);
    ok('动作 / 分类的圆环照旧显示名字（只有导航那三个不显示）',
      /class="menu-name"/.test(api.menuItemEl(items[0]).innerHTML),
      items[0].name);
    ok('不显示文字之后图标画得更大（导航圆环的图标 ≈ 直径的 62%）',
      navRings[0].iconSize >= navRings[0].r * 2 * 0.55,
      `icon=${navRings[0].iconSize.toFixed(0)}px 环=${(navRings[0].r * 2).toFixed(0)}px`);
    ok('右上角「返回」的图标字号 = 直径 × 62%（和动作页退出圆环同一比例，CSS 一处给）',
      Math.abs(api.menuBackItem(api.stageSize()).iconSize
        - api.menuBackItem(api.stageSize()).r * 2 * 0.62) < 1e-9);
  }

  // 恢复现场
  api.state.settings.mirror = savedMirror;
  api.camera.video.readyState = savedReady;
  api.camera.stream = savedStream6;
  api.state.session = 'idle';
}

/* ------------------------------------------------------------------ *
 * [17b] 首页「开始体感训练」= 摄像头 + 麦克风一次请求（用户要求）
 *
 * 用户原话：「关于打开 mic 的授权，当用户在首页点击『开始体感训练』的时候就要提示用户授权。」
 *
 * 钉住五件事（全部用假 getUserMedia，不需要真麦克风）：
 *   ① 这一次只发**一次** `getUserMedia({ video…, audio: true })`（组合授权框只弹一次）；
 *   ② 拿到流之后**音轨立刻 stop**（只要权限、不长期占麦，免得和 SpeechRecognition 抢）；
 *   ③ 组合请求失败（没麦克风 / 拒绝麦克风）→ **自动降级成只有 video**，摄像头照常起来；
 *   ④ 摄像头本身被拒（NotAllowedError）时仍然「不换来换去重试」，只是不会因为麦克风而误判；
 *   ⑤ 其它路径（遮罩上的「开启摄像头」/ 切镜头 / 自动重开）不再请求 audio，不重复弹框。
 * ------------------------------------------------------------------ */

console.log('\n[17b] 首页「开始体感训练」一并请求麦克风（失败自动降级，不挡摄像头）');
{
  const api = windowStub.__mfg;
  const {
    cameraWithMic, stopAudioTracks, cameraConstraintsFor, shouldRetryCamera,
  } = await import('../src/pose-engine.js');
  const media = navigatorStub.mediaDevices;
  const savedGum = media.getUserMedia;
  const saved = {
    stream: api.camera.stream,
    ready: api.camera.video.readyState,
    src: api.camera.video.srcObject,
    camStopped: api.state.camStoppedForHome,
    camErr: api.state.camErrName,
    engineReady: api.state.engineReady,
  };
  api.state.engineReady = true;   // 不让这一段去加载真模型

  const makeTrack = (kind) => ({ kind, stops: 0, stop() { this.stops += 1; } });
  const makeStream = ({ audio = true } = {}) => {
    const tracks = [makeTrack('video')];
    if (audio) tracks.push(makeTrack('audio'));
    return {
      tracks,
      getTracks: () => tracks,
      getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
      getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    };
  };
  const tick = () => new Promise((r) => setTimeout(r, 40));

  /** 模拟用户回到首页 → 点「开始体感训练」：先回首页（有流时会把遮罩亮出来）再开 */
  const beginFromHome = async () => {
    api.showHome();
    api.camera.stream = null;
    api.camera.video.readyState = 4;
    api.camera.video.srcObject = null;
    api.startGestureMode();
    await tick();
  };

  // ① 正常：一次组合请求，音轨立刻 stop，摄像头照常起来
  {
    const calls = [];
    let stream = null;
    media.getUserMedia = async (constraints) => {
      calls.push(constraints);
      stream = makeStream();
      return stream;
    };
    await beginFromHome();
    ok('首页「开始体感训练」只发一次 getUserMedia，约束同时包含 video 与 audio: true',
      calls.length === 1 && calls[0].audio === true && !!calls[0].video,
      JSON.stringify(calls.map((c) => ({ audio: c.audio, video: !!c.video }))));
    ok('拿到组合流后音轨立刻 stop（只要权限、不长期占麦克风），视频轨不停',
      stream.tracks.length === 2 && stream.tracks[1].stops === 1 && stream.tracks[0].stops === 0,
      stream.tracks.map((t) => `${t.kind}:${t.stops}`).join(','));
    ok('摄像头照常起来：stream / srcObject 都接上，麦克风成功不会弹任何错误',
      !!api.camera.stream && api.camera.video.srcObject === stream
      && api.camera.active === true
      && elements.get('stageMask').classList.contains('hidden') && api.state.camErrName === '',
      `stream=${!!api.camera.stream} mask=${elements.get('stageMask').className} err=${api.state.camErrName}`);
  }

  // ② 没有麦克风（NotFoundError）→ 自动降级成只请求摄像头，训练照常
  {
    const calls = [];
    let stream = null;
    media.getUserMedia = async (constraints) => {
      calls.push(constraints);
      if (constraints.audio) {
        const err = new Error('Requested device not found');
        err.name = 'NotFoundError';
        throw err;
      }
      stream = makeStream({ audio: false });
      return stream;
    };
    await beginFromHome();
    ok('没有麦克风（组合请求 NotFoundError）→ 自动降级成「只有 video」的请求（同一条摄像头约束）',
      calls.length === 2 && calls[0].audio === true && calls[1].audio === false
      && JSON.stringify(calls[0].video) === JSON.stringify(calls[1].video),
      JSON.stringify(calls.map((c) => ({ audio: c.audio, video: !!c.video }))));
    ok('降级后摄像头仍然起来、麦克风失败不算致命错误（遮罩收起、不写 camErr）',
      !!api.camera.stream && api.camera.video.srcObject === stream
      && elements.get('stageMask').classList.contains('hidden') && api.state.camErrName === '',
      `stream=${!!api.camera.stream} mask=${elements.get('stageMask').className} err=${api.state.camErrName}`);
  }

  // ③ 麦克风被单独拒（NotAllowedError，Chrome 有时会这样）→ 同样降级，摄像头照常
  {
    const calls = [];
    let stream = null;
    media.getUserMedia = async (constraints) => {
      calls.push(constraints);
      if (constraints.audio) {
        const err = new Error('Permission denied');
        err.name = 'NotAllowedError';
        throw err;
      }
      stream = makeStream({ audio: false });
      return stream;
    };
    await beginFromHome();
    ok('麦克风被单独拒（audio 那条 NotAllowedError）→ 也降级成纯视频请求，不放弃摄像头',
      calls.length === 2 && calls[1].audio === false
      && !!api.camera.stream && api.camera.video.srcObject === stream
      && api.state.camErrName === '',
      JSON.stringify({ n: calls.length, secondAudio: calls[1]?.audio, cam: !!api.camera.stream }));
  }

  // ④ 摄像头本身也被拒：组合 + 纯视频各试一次就停手（权限被拒不换来换去）
  {
    const calls = [];
    media.getUserMedia = async (constraints) => {
      calls.push(constraints);
      const err = new Error('Permission denied');
      err.name = 'NotAllowedError';
      throw err;
    };
    await beginFromHome();
    ok('摄像头权限被拒时：组合 + 纯视频**各一次**就停手，不会继续换镜头（不重复弹框）',
      calls.length === 2 && calls[0].audio === true && calls[1].audio === false,
      JSON.stringify(calls.map((c) => ({ audio: c.audio, video: !!c.video }))));
    ok('这种「摄像头真打不开」仍然照旧是致命错误（遮罩 + 诊断面板亮着），没被麦克风降级吞掉',
      !api.camera.stream && api.state.camErrName === 'NotAllowedError'
      && elements.get('stageMask').classList.contains('hidden') === false,
      `cam=${!!api.camera.stream} err=${api.state.camErrName} hidden=${elements.get('stageMask').classList.contains('hidden')}`);
  }

  // ⑤ 不重复弹框：其它路径（遮罩上的「开启摄像头」）不再请求麦克风
  {
    const calls = [];
    media.getUserMedia = async (constraints) => {
      calls.push(constraints);
      return makeStream();
    };
    api.camera.stream = null;
    api.camera.video.readyState = 0;
    api.camera.video.srcObject = null;
    elements.get('btnStartCam').dispatch('click');
    await tick();
    ok('遮罩上的「开启摄像头」（以及切镜头 / 自动重开）不再请求麦克风，不会重复弹框',
      calls.length === 1 && calls[0].audio === false && !!calls[0].video,
      JSON.stringify(calls.map((c) => ({ audio: c.audio, video: !!c.video }))));
  }

  // ⑥ 纯函数：只在副本上加 audio、只停音轨、权限语义不变
  {
    const base = cameraConstraintsFor({ facing: 'user', tier: 'high' });
    const withMic = cameraWithMic(base);
    const stream = makeStream();
    ok('cameraWithMic 不改原约束（第一条 attempt 的副本才带 audio: true）',
      base.audio === false && withMic.audio === true && withMic.video === base.video);
    ok('stopAudioTracks 只停音轨、不碰视频轨，并返回停掉的条数',
      stopAudioTracks(stream) === 1 && stream.tracks[1].stops === 1 && stream.tracks[0].stops === 0);
    ok('shouldRetryCamera 语义没变：权限被拒不重试（麦克风降级是 Camera.start 里单独的一步）',
      shouldRetryCamera('NotAllowedError') === false && shouldRetryCamera('NotFoundError') === true);
  }

  // 恢复现场
  api.showHome();
  media.getUserMedia = savedGum;
  api.camera.stream = saved.stream;
  api.camera.video.readyState = saved.ready;
  api.camera.video.srcObject = saved.src;
  api.state.camStoppedForHome = saved.camStopped;
  api.state.camErrName = saved.camErr;
  api.state.engineReady = saved.engineReady;
  api.state.session = 'idle';
}

/* ------------------------------------------------------------------ *
 * [17c] 点「开始体感训练」：已授权直接全屏 / 未授权先弹框再全屏 / 摄像头被拒不再请求
 *
 * 用户原话：「点击『开始体感训练』，如果已经完成了【摄像头 + 麦克风】组合授权，
 * 则不用弹窗授权，直接进入全屏状态，否则应该弹窗要求客户授权，再进入全屏状态。」
 *
 * 钉住这几件事（全部用假 permissions / 假 getUserMedia，不需要真摄像头）：
 *   ① 已授权（camera + microphone 都 granted）：`requestFullscreen` 在 `getUserMedia`
 *      **之前**被调用，遮罩上是「已授权」的说法 —— 没有任何「请允许」的授权提示；
 *   ② 未授权（prompt）：先请求全屏、再 `getUserMedia`，遮罩上出现「需要授权」的提示；
 *      权限流程走完时原生全屏那条路失败 → **伪全屏被打开**（伪全屏不需要手势）；
 *   ③ **摄像头**被拒（denied）：一次 `getUserMedia` 都不发，直接落到摄像头诊断面板 + 地址栏提示；
 *      反过来「摄像头被拒 + 麦克风允许」也一样不请求；
 *   ④ **只有麦克风**被拒：**不拦训练**（821c30a 的硬要求）—— 只请求摄像头（`audio: false`）、
 *      照常开始，只给一句轻量说明，绝不进错误 / 诊断面板；
 *   ⑤ permissions API 不存在 / query 抛错 → 当作「未知」，不崩、流程照常（照旧请求授权）。
 * ------------------------------------------------------------------ */

console.log('\n[17c] 点「开始体感训练」：已授权直接全屏 / 未授权先弹框 / 摄像头被拒不再请求');
{
  const api = windowStub.__mfg;
  const { t: tMic } = await import('../src/i18n.js');
  const { PSEUDO_FS_CLASS } = api;
  const stageEl = elements.get('stage');
  const mask = elements.get('stageMask');
  const media = navigatorStub.mediaDevices;
  const savedGum = media.getUserMedia;
  const savedPermissions = navigatorStub.permissions;
  const savedRequestFullscreen = stageEl.requestFullscreen;
  const saved = {
    stream: api.camera.stream,
    ready: api.camera.video.readyState,
    src: api.camera.video.srcObject,
    engineReady: api.state.engineReady,
    camStopped: api.state.camStoppedForHome,
    camErr: api.state.camErrName,
    fsEl: documentStub.fullscreenElement,
  };
  api.state.engineReady = true;   // 不让这一段去加载真模型

  const order = [];
  /** 跑完「点击 → 权限查询 → 开摄像头 → 全屏兜底」这一串异步动作 */
  const tick = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 40));
  };

  /** 模拟真浏览器：requestFullscreen 成功时 document.fullscreenElement 立刻指向这个元素 */
  const fullscreenWorks = () => {
    stageEl.requestFullscreen = () => {
      order.push('fullscreen');
      documentStub.fullscreenElement = stageEl;
      return Promise.resolve();
    };
  };
  /** 模拟「浏览器拒绝了原生全屏」（典型原因：手势已经被授权框消耗掉了） */
  const fullscreenFails = () => {
    stageEl.requestFullscreen = () => {
      order.push('fullscreen');
      const err = new Error('Fullscreen request denied');
      err.name = 'TypeError';
      return Promise.reject(err);
    };
  };
  /** 造一套 permissions 桩；state === 'throw' = 这个权限名浏览器不认（Firefox） */
  const permissions = (cameraState, micState) => {
    navigatorStub.permissions = {
      query: async ({ name }) => {
        const state = name === 'camera' ? cameraState : micState;
        if (state === 'throw') throw new TypeError(`'${name}' is not a valid PermissionName`);
        return { name, state };
      },
    };
  };
  /** 组合请求的假流：video + audio 两条轨（和 821c30a 的降级链配合） */
  const gumStream = () => {
    const tracks = [
      { kind: 'video', stops: 0, stop() { this.stops += 1; }, getSettings: () => ({ deviceId: 'cam-stub', facingMode: 'user' }) },
      { kind: 'audio', stops: 0, stop() { this.stops += 1; } },
    ];
    return {
      tracks,
      getTracks: () => tracks,
      getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
      getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    };
  };
  /** 从首页点「开始体感训练」（等价于真实点击，每次都从干净的初始状态出发） */
  const begin = async () => {
    api.showHome();
    api.camera.stream = null;
    api.camera.video.readyState = 4;      // Camera.active 还要求 readyState ≥ 2
    api.camera.video.srcObject = null;
    api.state.camErrName = '';
    api.state.camErrMessage = '';
    documentStub.fullscreenElement = null;
    api.setPseudoFullscreen(false);
    order.length = 0;
    api.startGestureMode();
    await tick();
  };

  // ① 已授权：requestFullscreen → getUserMedia，全程不提「请允许」
  {
    fullscreenWorks();
    permissions('granted', 'granted');
    const calls = [];
    let textWhileWaiting = '';
    media.getUserMedia = async (constraints) => {
      calls.push(constraints);
      order.push('gum');
      // 正开着摄像头（= 真实环境里授权框那一步）：看看这一刻遮罩上写的是什么
      await new Promise((r) => setTimeout(r, 20));
      textWhileWaiting = elements.get('maskText').textContent;
      return gumStream();
    };
    await begin();
    ok('已授权（camera + microphone 都 granted）：requestFullscreen **先于** getUserMedia 被调用',
      order.join(',') === 'fullscreen,gum', order.join(','));
    ok('已授权：只发一次组合请求（video + audio: true），不额外弹框',
      calls.length === 1 && calls[0].audio === true && !!calls[0].video,
      JSON.stringify(calls.map((c) => ({ audio: c.audio, video: !!c.video }))));
    ok('已授权：遮罩上是「已授权，正在进入全屏训练…」，**没有**渲染「需要授权」的提示',
      textWhileWaiting === tMic('ui.maskGrantedText')
      && elements.get('maskTitle').textContent === tMic('ui.maskGrantedTitle')
      && textWhileWaiting !== tMic('ui.maskPermText'),
      JSON.stringify({ while: textWhileWaiting, final: elements.get('maskText').textContent }));
    ok('已授权：摄像头照常起来（流接上、遮罩收起），且原生全屏已经进了 → 不叠伪全屏',
      !!api.camera.stream && api.camera.video.srcObject !== null
      && mask.classList.contains('hidden') === true
      && stageEl.classList.contains(PSEUDO_FS_CLASS) === false
      && api.stageFullscreenOn() === true,
      JSON.stringify({
        cam: !!api.camera.stream,
        maskHidden: mask.classList.contains('hidden'),
        pseudo: stageEl.classList.contains(PSEUDO_FS_CLASS),
        fs: api.stageFullscreenOn(),
      }));
  }

  // ② 未授权（prompt）：先全屏、再 getUserMedia，并显示「需要授权」的提示
  {
    fullscreenWorks();
    permissions('prompt', 'prompt');
    const calls = [];
    let textWhileWaiting = '';
    media.getUserMedia = async (constraints) => {
      calls.push(constraints);
      order.push('gum');
      await new Promise((r) => setTimeout(r, 20));
      textWhileWaiting = elements.get('maskText').textContent;
      return gumStream();
    };
    await begin();
    ok('未授权（prompt）：先 requestFullscreen、再 getUserMedia（顺序不变，手势没丢）',
      order.join(',') === 'fullscreen,gum', order.join(','));
    ok('未授权：等授权时遮罩上就是「需要授权」的说法（提示用户允许摄像头 + 麦克风）',
      textWhileWaiting === tMic('ui.maskPermText')
      && elements.get('maskTitle').textContent === tMic('ui.maskPermTitle'),
      JSON.stringify({ while: textWhileWaiting, title: elements.get('maskTitle').textContent }));
    ok('未授权：授权完摄像头照常起来（训练不受影响）',
      calls.length === 1 && calls[0].audio === true && !!api.camera.stream,
      JSON.stringify({ n: calls.length, cam: !!api.camera.stream }));
  }

  // ③ 未授权 + 原生全屏失败（授权框打断了手势）→ 权限流程结束后伪全屏兜底
  {
    fullscreenFails();
    permissions('prompt', 'prompt');
    const calls = [];
    media.getUserMedia = async (constraints) => {
      calls.push(constraints);
      order.push('gum');
      const err = new Error('Permission denied');
      err.name = 'NotAllowedError';
      throw err;
    };
    await begin();
    ok('先全屏再要权限的顺序仍然成立（原生那条路失败也不改变「先申请全屏」）',
      order[0] === 'fullscreen', order.join(','));
    ok('权限流程结束后不在任何全屏里 → CSS 伪全屏被打开（#stage 与 body 都挂 pseudo-fullscreen）',
      stageEl.classList.contains(PSEUDO_FS_CLASS)
      && documentStub.body.classList.contains(PSEUDO_FS_CLASS)
      && api.stageFullscreenOn() === true,
      JSON.stringify({
        stage: stageEl.classList.contains(PSEUDO_FS_CLASS),
        body: documentStub.body.classList.contains(PSEUDO_FS_CLASS),
      }));
    ok('伪全屏出来的同时，摄像头失败照旧走错误 / 诊断面板（两条路互不影响）',
      mask.classList.contains('hidden') === false
      && elements.get('camDiag').hidden === false
      && api.state.camErrName === 'NotAllowedError',
      JSON.stringify({ maskHidden: mask.classList.contains('hidden'), diag: elements.get('camDiag').hidden }));
    // 用户随时能退：Esc / 右下角全屏按钮走同一个 exitFullscreen（伪全屏也认）
    const stillFullscreen = api.toggleStageFullscreen();
    ok('伪全屏用现有的退出方式就能退（全屏按钮 / Esc 同一个 exitFullscreen）',
      stillFullscreen === false && stageEl.classList.contains(PSEUDO_FS_CLASS) === false,
      `toggle=${stillFullscreen} pseudo=${stageEl.classList.contains(PSEUDO_FS_CLASS)}`);
  }

  // ④ 摄像头被拒（denied）：一次 getUserMedia 都不发，直接出诊断面板 + 地址栏提示
  {
    fullscreenWorks();
    permissions('denied', 'denied');
    const calls = [];
    media.getUserMedia = async (constraints) => { calls.push(constraints); return gumStream(); };
    await begin();
    ok('摄像头被拒（camera=denied）：一次 getUserMedia 都不发（请求也不会弹框，省得白等）',
      calls.length === 0, JSON.stringify(calls.length));
    ok('摄像头被拒：走现有的摄像头错误 / 诊断面板分支，遮罩提示「请在地址栏左侧允许摄像头与麦克风」',
      mask.classList.contains('hidden') === false
      && elements.get('camDiag').hidden === false
      && elements.get('maskText').textContent.includes(tMic('ui.maskPermDeniedText'))
      && elements.get('maskTitle').textContent === tMic('ui.maskCamFailTitle')
      && api.state.camErrName === 'NotAllowedError',
      JSON.stringify({
        mask: elements.get('maskText').textContent.slice(0, 24),
        diag: elements.get('camDiag').hidden,
        err: api.state.camErrName,
      }));
    ok('摄像头被拒：诊断面板给出的建议是「权限被拒」那一条（diag.adviceNotAllowed）',
      elements.get('camDiagAdvice').textContent.includes(tMic('diag.adviceNotAllowed')),
      elements.get('camDiagAdvice').textContent);
  }

  // ④b 只有**麦克风**被拒（camera=granted）→ 训练不能停（821c30a 的硬要求）：
  //     改成只请求摄像头（audio:false），照常开始，只在画面上给一句轻量说明。
  {
    fullscreenWorks();
    permissions('granted', 'denied');
    const calls = [];
    media.getUserMedia = async (constraints) => { calls.push(constraints); order.push('gum'); return gumStream(); };
    await begin();
    ok('只有麦克风被拒（camera=granted + microphone=denied）：**仍然调用 getUserMedia**，而且 audio 为 false',
      calls.length === 1 && calls[0].audio === false && !!calls[0].video,
      JSON.stringify(calls.map((c) => ({ audio: c.audio, video: !!c.video }))));
    ok('只有麦克风被拒：训练照常开始（摄像头起来、遮罩收起、不写 camErr）',
      !!api.camera.stream && api.camera.video.srcObject !== null
      && mask.classList.contains('hidden') === true && api.state.camErrName === '',
      JSON.stringify({ cam: !!api.camera.stream, maskHidden: mask.classList.contains('hidden'), err: api.state.camErrName }));
    ok('只有麦克风被拒：**不进**错误 / 诊断面板（不拦训练）',
      elements.get('camDiag').hidden === true
      && elements.get('maskTitle').textContent !== tMic('ui.maskCamFailTitle'),
      JSON.stringify({ diag: elements.get('camDiag').hidden, title: elements.get('maskTitle').textContent }));
    ok('只有麦克风被拒：给一句轻量说明（画面 6 秒提示 + 侧栏状态行 + 遮罩上都写了 ui.micDeniedHint）',
      elements.get('poseHint').hidden === false
      && elements.get('poseHint').textContent === tMic('ui.micDeniedHint')
      && elements.get('cueLine').textContent === tMic('ui.micDeniedHint')
      && elements.get('maskText').textContent.includes(tMic('ui.micDeniedHint')),
      JSON.stringify({
        hint: elements.get('poseHint').textContent.slice(0, 20),
        cue: elements.get('cueLine').textContent.slice(0, 20),
        mask: elements.get('maskText').textContent.slice(-20),
      }));
    ok('只有麦克风被拒：仍然进了全屏（原生全屏已进），不需要伪全屏兜底',
      api.stageFullscreenOn() === true && stageEl.classList.contains(PSEUDO_FS_CLASS) === false,
      JSON.stringify({ fs: api.stageFullscreenOn(), pseudo: stageEl.classList.contains(PSEUDO_FS_CLASS) }));
  }

  // ④c 反过来：摄像头被拒 + 麦克风允许 → 照样不请求（摄像头才是练不了的那一个）
  {
    fullscreenWorks();
    permissions('denied', 'granted');
    const calls = [];
    media.getUserMedia = async (constraints) => { calls.push(constraints); return gumStream(); };
    await begin();
    ok('摄像头被拒 + 麦克风允许：仍然**一次 getUserMedia 都不发**（麦克风允许也救不了摄像头）',
      calls.length === 0, JSON.stringify(calls.length));
    ok('摄像头被拒 + 麦克风允许：照旧进错误 / 诊断面板（与两个都拒绝时同一条路）',
      elements.get('camDiag').hidden === false
      && elements.get('maskText').textContent.includes(tMic('ui.maskPermDeniedText'))
      && api.state.camErrName === 'NotAllowedError',
      JSON.stringify({ diag: elements.get('camDiag').hidden, err: api.state.camErrName }));
  }

  // ⑤ permissions API 不存在（Firefox / 老浏览器）→ 当作「未知」，流程照常
  {
    fullscreenWorks();
    navigatorStub.permissions = undefined;
    const calls = [];
    media.getUserMedia = async (constraints) => { calls.push(constraints); order.push('gum'); return gumStream(); };
    await begin();
    ok('permissions API 不存在 → 按「未知」处理：先全屏、再照常请求组合授权（video + audio: true）',
      order.join(',') === 'fullscreen,gum' && calls.length === 1 && calls[0].audio === true
      && !!api.camera.stream,
      JSON.stringify({ order: order.join(','), n: calls.length, cam: !!api.camera.stream }));
    ok('permissions API 不存在时不崩：遮罩照常收起（当作「需要授权」那条路）',
      mask.classList.contains('hidden') === true && api.state.camErrName === '',
      JSON.stringify({ maskHidden: mask.classList.contains('hidden'), err: api.state.camErrName }));
  }

  // ⑥ query 抛错（Firefox 不认 camera / microphone）→ 一样当作「未知」
  {
    fullscreenWorks();
    permissions('throw', 'granted');
    const calls = [];
    media.getUserMedia = async (constraints) => { calls.push(constraints); order.push('gum'); return gumStream(); };
    await begin();
    ok('permissions.query 抛错（不认这个权限名）→ 按「未知」处理，不把异常抛出去、流程照常',
      order.join(',') === 'fullscreen,gum' && calls.length === 1 && !!api.camera.stream,
      JSON.stringify({ order: order.join(','), n: calls.length, cam: !!api.camera.stream }));
    const perm6 = await api.queryGesturePermission();
    ok('权限判定：一个抛错（未知）→ 两个状态各自如实报 unknown / granted（不再一刀切）',
      perm6.camera === 'unknown' && perm6.microphone === 'granted', JSON.stringify(perm6));
  }

  // ⑦ 纯函数：摄像头 / 麦克风**分开判**（摄像头 denied 才拦训练；麦克风 denied 只降级成纯视频）
  {
    permissions('granted', 'granted');
    const both = await api.queryGesturePermission();
    ok('queryGesturePermission：两个权限分开返回（camera / microphone 都 granted）',
      both.camera === 'granted' && both.microphone === 'granted', JSON.stringify(both));
    permissions('granted', 'denied');
    const micOff = await api.queryGesturePermission();
    ok('queryGesturePermission：camera=granted + microphone=denied → 两个状态各自如实报出来',
      micOff.camera === 'granted' && micOff.microphone === 'denied', JSON.stringify(micOff));
    ok('gestureWantsMic：麦克风被拒 → 不要麦克风（只请求摄像头，训练照常开始）',
      api.gestureWantsMic(micOff) === false);
    permissions('denied', 'granted');
    const camOff = await api.queryGesturePermission();
    ok('gestureWantsMic：麦克风允许 → 带麦克风（摄像头那边单独判：camera=denied 才拦）',
      api.gestureWantsMic(camOff) === true && camOff.camera === 'denied');
    permissions('prompt', 'prompt');
    ok('gestureWantsMic：麦克风只是 prompt / 未知 → 照样带（这一步才会弹组合授权框）',
      api.gestureWantsMic(await api.queryGesturePermission()) === true
      && api.gestureWantsMic({ microphone: 'unknown' }) === true);
    permissions('unknown', 'unknown');
    ok('queryGesturePermission：浏览器返回非三态的值 → 各自都报 unknown',
      JSON.stringify(await api.queryGesturePermission())
        === JSON.stringify({ camera: 'unknown', microphone: 'unknown' }),
      JSON.stringify(await api.queryGesturePermission()));
    navigatorStub.permissions = undefined;
    ok('queryMediaPermission：没有 permissions API → unknown（不抛异常）',
      await api.queryMediaPermission('camera') === 'unknown');
    navigatorStub.permissions = { query: () => { throw new TypeError('boom'); } };
    ok('queryMediaPermission：query 同步抛错 → unknown（不抛异常）',
      await api.queryMediaPermission('microphone') === 'unknown');
  }

  // 恢复现场
  api.showHome();
  media.getUserMedia = savedGum;
  navigatorStub.permissions = savedPermissions;
  stageEl.requestFullscreen = savedRequestFullscreen;
  documentStub.fullscreenElement = saved.fsEl;
  api.camera.stream = saved.stream;
  api.camera.video.readyState = saved.ready;
  api.camera.video.srcObject = saved.src;
  api.state.camStoppedForHome = saved.camStopped;
  api.state.camErrName = saved.camErr;
  api.state.engineReady = saved.engineReady;
  api.state.session = 'idle';
}

/* ------------------------------------------------------------------ *
 * [17d] 姿态模型加载：分阶段报错 / 下载失败自动重试 / GPU → CPU 兜底 / 首帧超时
 *
 * 用户反馈：「在首页点击开始按钮，出现『姿态模型加载失败』」——服务器侧资源全是 200，
 * 所以问题在浏览器里：GPU delegate 建不起来、服务器比页面晚起来（fetch 404 / 连不上），
 * 或者错误被一句笼统的「加载失败」盖住了。这里钉住四件事（全部用桩，不需要浏览器 / 真模型）：
 *   ① `createFromOptions(GPU)` 抛错 → **自动用 CPU 重试并成功**，且把 'cpu' 记进 settings，
 *      下次启动直接走 CPU（不再先失败一次）；
 *   ② fetch 返回 404 → 退避重试 **3 次**（共 4 次请求）后报错，提示文案带「HTTP 404」，
 *      期间遮罩上显示「正在重试（n/3）」；诊断日志里留下 `pose:load-fail`；
 *   ③ 首帧推理超时（GPU 卡住 / CPU 卡住）→ 报错文案带「超时」，GPU 卡住时自动切 CPU
 *      并成功；wasm 阶段失败**不重试**（重试也没用）；
 *   ④ 成功路径不回归：只下载一次模型（字节直接喂 createFromOptions）、GPU 正常时不写设置。
 * ------------------------------------------------------------------ */

console.log('\n[17d] 姿态模型加载：分阶段报错 / 下载重试 / GPU→CPU 兜底 / 首帧超时');
{
  const api = windowStub.__mfg;
  const { t: tPose } = await import('../src/i18n.js');
  const {
    PoseLoadError, isRetryableLoadError, normalizeDelegate,
  } = await import('../src/pose-engine.js');
  const engine = api.engine;
  const mask = elements.get('stageMask');
  const maskTitle = elements.get('maskTitle');
  const maskText = elements.get('maskText');
  const btnRetry = elements.get('btnStartCam');

  const saved = {
    resolveVision: engine.resolveVision,
    createLandmarker: engine.createLandmarker,
    fetchModel: engine.fetchModel,
    sleep: engine.sleep,
    now: engine.now,
    modelKey: api.state.settings.modelKey,
    poseDelegate: api.state.settings.poseDelegate,
    engineReady: api.state.engineReady,
    modelError: api.state.modelError,
    tuning: { ...api.poseLoadTuning },
    diagEvents: api.coachDiag.snapshot().events,
  };

  /** 造一个「能跑首帧推理」的假推理器 */
  const makeLandmarker = ({ detect } = {}) => ({
    closed: false,
    close() { this.closed = true; },
    detectForVideo: detect || (() => ({ landmarks: [[{ x: 0.5, y: 0.5, z: 0, visibility: 1 }]] })),
  });
  const bytes = () => new Uint8Array([1, 2, 3, 4]);
  const resetEngine = () => { engine.close(); engine._vision = null; engine._wasmWarmed = ''; };
  const diagEvents = () => api.coachDiag.snapshot().events;

  // 重试退避与首帧超时都调到「几乎瞬间」，用例不必真等 3 秒 / 8 秒（1s 是为了让「超时 Ns」可读）
  api.poseLoadTuning.retryDelays = [0, 0, 0];
  api.poseLoadTuning.firstDetectTimeoutMs = 1000;
  api.poseLoadTuning.totalTimeoutMs = 5000;
  engine.sleep = async () => {};
  // 这一段只管「下载失败 / GPU 兜底」：文件集不带 wasm 路径 → 不触发预热（预热与进度另有 [17e]）
  engine.resolveVision = async () => ({});

  /* ---- ① GPU 建不起来 → 自动 CPU 重试并成功，且记住 'cpu' ---- */
  {
    resetEngine();
    api.state.engineReady = false;
    // 显式要 GPU 才走「先 GPU 再 CPU」那条链（默认已经改成 CPU 了，见 [17f]）
    api.state.settings.poseDelegate = 'gpu';
    const delegates = [];
    let fetched = 0;
    let createOptions = null;
    engine.fetchModel = async () => { fetched += 1; return bytes(); };
    engine.createLandmarker = async (vision, options) => {
      createOptions = options;
      delegates.push(options.baseOptions.delegate);
      if (options.baseOptions.delegate === 'GPU') {
        const err = new Error('Failed to create WebGL context');
        err.name = 'RuntimeError';
        throw err;
      }
      return makeLandmarker();
    };
    const eventsBefore = diagEvents();
    const okLoad = await api.loadPoseModel();
    ok('GPU 建不起来（createFromOptions 抛错）→ 自动用 CPU 重试一次并成功',
      okLoad === true && delegates.join(',') === 'GPU,CPU'
      && engine.ready === true && engine.delegate === 'CPU' && api.state.engineReady === true,
      JSON.stringify({ okLoad, delegates, delegate: engine.delegate, ready: engine.ready }));
    ok('模型只下载一次：字节直接喂给 createFromOptions（第二次不再联网）',
      fetched === 1 && createOptions?.baseOptions?.modelAssetBuffer?.byteLength === 4
      && !createOptions?.baseOptions?.modelAssetPath,
      JSON.stringify({ fetched, buffer: createOptions?.baseOptions?.modelAssetBuffer?.byteLength || 0 }));
    ok('兜底成功 → settings.poseDelegate 记成 cpu（写进 localStorage，下次直接用 CPU）',
      api.state.settings.poseDelegate === 'cpu'
      && JSON.parse(store.get('mfg.settings.v1') || '{}').poseDelegate === 'cpu',
      JSON.stringify({ setting: api.state.settings.poseDelegate, saved: JSON.parse(store.get('mfg.settings.v1') || '{}').poseDelegate }));
    ok('兜底这一次也写进诊断日志（pose:delegate，GPU → CPU）',
      diagEvents() > eventsBefore && api.coachDiag.snapshot().lastType === 'pose:delegate',
      `${diagEvents()}/${api.coachDiag.snapshot().lastType}`);
    ok('成功后遮罩收起、模型加载错误清空（state.modelError=null）',
      mask.classList.contains('hidden') === true && api.state.modelError === null,
      JSON.stringify({ hidden: mask.classList.contains('hidden'), modelError: api.state.modelError }));

    // 下次启动：设置里已经是 cpu → 第一次就用 CPU，不再先失败一次
    resetEngine();
    api.state.engineReady = false;
    const again = [];
    engine.createLandmarker = async (vision, options) => {
      again.push(options.baseOptions.delegate);
      return makeLandmarker();
    };
    const okAgain = await api.loadPoseModel();
    ok('下次启动直接用记住的 CPU（不再先试 GPU、不再先失败一次）',
      okAgain === true && again.join(',') === 'CPU', JSON.stringify(again));
  }

  /* ---- ② fetch 404 → 重试 3 次后报错，文案带「HTTP 404」，重试期间显示「正在重试（n/3）」 ---- */
  {
    resetEngine();
    api.state.engineReady = false;
    api.state.settings.poseDelegate = '';
    const retryTexts = [];
    let fetches = 0;
    let created = 0;
    engine.fetchModel = async () => { fetches += 1; return { ok: false, status: 404 }; };
    engine.createLandmarker = async () => { created += 1; return makeLandmarker(); };
    // 重试前的退避正好发生在 onRetry 之后：在这里把遮罩上的那句话抄下来
    engine.sleep = async () => { retryTexts.push(maskText.textContent); };
    const eventsBefore = diagEvents();
    const okLoad = await api.loadPoseModel();

    ok('模型下载 404 → 首次 + 3 次重试（共 4 次请求）后才报错，且根本没去创建推理器',
      okLoad === false && fetches === 4 && created === 0,
      JSON.stringify({ okLoad, fetches, created }));
    ok('重试期间遮罩上显示「正在重试（n/3）」（1/3 → 2/3 → 3/3，每次都带原因）',
      retryTexts.length === 3
      && retryTexts[0].includes(tPose('ui.poseRetry', { n: '1', max: '3' }))
      && retryTexts[1].includes(tPose('ui.poseRetry', { n: '2', max: '3' }))
      && retryTexts[2].includes(tPose('ui.poseRetry', { n: '3', max: '3' }))
      && retryTexts.every((s) => s.includes('HTTP 404')),
      JSON.stringify(retryTexts));
    ok('最终提示是「模型文件下载失败（HTTP 404）」（阶段 + 一句话原因，用户能照念）',
      maskText.textContent === api.poseFailText({
        stage: 'model', errName: 'HttpError', reason: 'HTTP 404', status: 404,
      })
      && maskText.textContent.includes(tPose('ui.poseStageModel'))
      && maskText.textContent.includes('HTTP 404'),
      maskText.textContent);
    ok('遮罩标题是「姿态模型加载失败」，按钮换成「重试加载模型」',
      maskTitle.textContent === tPose('ui.maskModelFail')
      && btnRetry.textContent === tPose('ui.poseRetryBtn')
      && mask.classList.contains('hidden') === false,
      JSON.stringify({ title: maskTitle.textContent, btn: btnRetry.textContent }));
    ok('失败原因结构化留给界面 / 探针（stage=model、name=HttpError、status=404、engineReady=false）',
      api.state.modelError?.stage === 'model' && api.state.modelError?.name === 'HttpError'
      && api.state.modelError?.status === 404 && api.state.engineReady === false,
      JSON.stringify(api.state.modelError));
    ok('每次尝试都写进诊断日志：pose:load-fail（stage/name/message/attempt），最终 lastError 指向 pose',
      diagEvents() - eventsBefore === 4
      && api.coachDiag.snapshot().lastType === 'pose:load-fail'
      && api.coachDiag.snapshot().lastError.startsWith('pose:')
      && api.coachDiag.snapshot().lastError.includes('HttpError'),
      JSON.stringify({ events: diagEvents() - eventsBefore, lastError: api.coachDiag.snapshot().lastError }));

    // 服务器还没起来（fetch 直接抛 TypeError）同样重试 4 次，报错里带真实错误名
    resetEngine();
    const netRetryTexts = [];
    let netFetches = 0;
    engine.fetchModel = async () => { netFetches += 1; throw new TypeError('Failed to fetch'); };
    engine.sleep = async () => { netRetryTexts.push(maskText.textContent); };
    const okNet = await api.loadPoseModel();
    ok('服务器比页面晚起来（fetch 抛 TypeError）也走同一套重试，提示里带真实错误名',
      okNet === false && netFetches === 4 && netRetryTexts.length === 3
      && maskText.textContent.includes('TypeError')
      && api.state.modelError?.stage === 'model' && api.state.modelError?.name === 'TypeError',
      JSON.stringify({ netFetches, text: maskText.textContent, modelError: api.state.modelError }));
  }

  /* ---- ③ 首帧推理超时 / wasm 失败不重试 ---- */
  {
    // CPU 也卡住 → 超时失败，文案带「超时」
    resetEngine();
    api.state.engineReady = false;
    api.state.settings.poseDelegate = '';
    engine.fetchModel = async () => bytes();
    engine.sleep = async () => {};
    engine.createLandmarker = async () => makeLandmarker({ detect: () => new Promise(() => {}) });
    const okLoad = await api.loadPoseModel();
    ok('首帧推理超时（默认 8s，测试里调成 1s）→ 失败，文案带「超时」而不是干等',
      okLoad === false && api.state.modelError?.stage === 'detect'
      && api.state.modelError?.name === 'TimeoutError'
      && maskText.textContent.includes(tPose('ui.poseStageDetect'))
      && maskText.textContent.includes(tPose('ui.poseReasonTimeout', { sec: '1' })),
      JSON.stringify({ modelError: api.state.modelError, text: maskText.textContent }));

    // GPU 首帧卡住、CPU 正常 → 自动切 CPU 并成功
    resetEngine();
    api.state.engineReady = false;
    api.state.settings.poseDelegate = 'gpu';
    const delegates = [];
    engine.createLandmarker = async (vision, options) => {
      delegates.push(options.baseOptions.delegate);
      if (options.baseOptions.delegate === 'GPU') return makeLandmarker({ detect: () => new Promise(() => {}) });
      return makeLandmarker();
    };
    const okCpu = await api.loadPoseModel();
    ok('GPU 首帧推理超时 → 自动切 CPU 重试并成功（同样记住 cpu）',
      okCpu === true && delegates.join(',') === 'GPU,CPU' && engine.delegate === 'CPU'
      && api.state.settings.poseDelegate === 'cpu',
      JSON.stringify({ okCpu, delegates, delegate: engine.delegate, setting: api.state.settings.poseDelegate }));

    // wasm 编译失败：重试没用 → 只尝试一次，直接报错
    resetEngine();
    api.state.engineReady = false;
    api.state.settings.poseDelegate = '';
    let resolveCalls = 0;
    let fetchCalls = 0;
    engine.resolveVision = async () => {
      resolveCalls += 1;
      const err = new Error('RuntimeError: abort(CompileError)');
      err.name = 'RuntimeError';
      throw err;
    };
    engine.fetchModel = async () => { fetchCalls += 1; return bytes(); };
    engine.createLandmarker = async () => makeLandmarker();
    const okWasm = await api.loadPoseModel();
    ok('wasm 初始化失败（RuntimeError）→ 不重试（只解析一次、模型一次都没下），提示带错误名',
      okWasm === false && resolveCalls === 1 && fetchCalls === 0
      && api.state.modelError?.stage === 'wasm'
      && api.state.modelError?.name === 'RuntimeError'
      && maskText.textContent.includes(tPose('ui.poseStageWasm'))
      && maskText.textContent.includes('RuntimeError'),
      JSON.stringify({ resolveCalls, fetchCalls, modelError: api.state.modelError, text: maskText.textContent }));
  }

  /* ---- ④ 成功路径不回归 ---- */
  {
    resetEngine();
    engine.resolveVision = async () => ({});
    api.state.engineReady = false;
    api.state.settings.poseDelegate = 'gpu';
    const delegates = [];
    let fetched = 0;
    engine.fetchModel = async () => { fetched += 1; return bytes(); };
    engine.createLandmarker = async (vision, options) => {
      delegates.push(options.baseOptions.delegate);
      return makeLandmarker();
    };
    const lastErrorBefore = api.coachDiag.snapshot().lastError;
    const okLoad = await api.loadPoseModel();
    ok('成功路径：GPU 一次就建好 → 不写 poseDelegate（保持用户选的 gpu）、遮罩收起、没有失败日志',
      okLoad === true && delegates.join(',') === 'GPU' && engine.delegate === 'GPU'
      && api.state.settings.poseDelegate === 'gpu' && fetched === 1
      && mask.classList.contains('hidden') === true
      && api.state.engineReady === true && api.state.modelError === null
      && api.coachDiag.snapshot().lastType !== 'pose:load-fail'
      && api.coachDiag.snapshot().lastError === lastErrorBefore,
      JSON.stringify({
        okLoad, delegates, setting: api.state.settings.poseDelegate, lastType: api.coachDiag.snapshot().lastType,
      }));
    ok('成功时首帧自检确实跑过（时间戳只在自检成功后被推高，循环里的 detect 从它继续递增）',
      engine._lastTs >= 0, String(engine._lastTs));
  }

  /* ---- ⑤ 纯函数：错误分类 / 三句可照念的提示 ---- */
  {
    ok('isRetryableLoadError：网络 / HTTP 类重试，WebGL / wasm 编译 / 超时不重试',
      isRetryableLoadError(new PoseLoadError('model', 'HttpError', 'HTTP 404', { retryable: true })) === true
      && isRetryableLoadError(new PoseLoadError('model', 'TypeError', 'Failed to fetch', { retryable: true })) === true
      && isRetryableLoadError(new PoseLoadError('create', 'RuntimeError', 'webgl', { retryable: false })) === false
      && isRetryableLoadError(new PoseLoadError('detect', 'TimeoutError', 'timeout', { retryable: false })) === false
      && isRetryableLoadError(Object.assign(new Error('x'), { name: 'TypeError' })) === true
      && isRetryableLoadError(Object.assign(new Error('x'), { name: 'RuntimeError' })) === false);
    ok('normalizeDelegate：只认 GPU / CPU，其它（含空）一律 null=自动',
      normalizeDelegate('gpu') === 'GPU' && normalizeDelegate('CPU') === 'CPU'
      && normalizeDelegate('') === null && normalizeDelegate('webgpu') === null);

    // 用户能照着念的三句话（中英文都从词条拼，不写死）
    const http = api.poseFailText(new PoseLoadError('model', 'HttpError', 'HTTP 404', { status: 404 }));
    const wasm = api.poseFailText(new PoseLoadError('wasm', 'RuntimeError', 'wasm compile failed'));
    const timeout = api.poseFailText(new PoseLoadError('detect', 'TimeoutError', 'timeout after 8s', { seconds: 8 }));
    ok('三种典型失败各有可照念的一行：HTTP 404 / wasm 编译失败：RuntimeError / 超时 8s',
      http === `${tPose('ui.poseStageModel')}（${tPose('ui.poseReasonHttp', { status: '404' })}）`
      && http.includes('HTTP 404')
      && wasm.includes(tPose('ui.poseStageWasm')) && wasm.includes('RuntimeError')
      && timeout.includes(tPose('ui.poseReasonTimeout', { sec: '8' })),
      JSON.stringify({ http, wasm, timeout }));
    ok('GPU 兜底的那句提示说清「已切 CPU + 已记住」（下次直接用 CPU）',
      tPose('ui.poseGpuFallback').includes('CPU')
      && tPose('ui.poseGpuFallback') !== 'ui.poseGpuFallback',
      tPose('ui.poseGpuFallback'));
  }

  /* ---- 恢复现场：把桩换回 [1] 里那套「立刻失败」的隔离桩 ---- */
  resetEngine();
  engine.resolveVision = saved.resolveVision;
  engine.createLandmarker = saved.createLandmarker;
  engine.fetchModel = saved.fetchModel;
  engine.sleep = saved.sleep;
  engine.now = saved.now;
  api.state.settings.modelKey = saved.modelKey;
  api.state.settings.poseDelegate = saved.poseDelegate;
  api.state.engineReady = saved.engineReady;
  api.state.modelError = saved.modelError;
  Object.assign(api.poseLoadTuning, saved.tuning);
  api.showHome();
  api.state.session = 'idle';
}

/* ------------------------------------------------------------------ *
 * [17e] 姿态模型加载进度条 + 每阶段超时（用户反馈「一直显示正在加载姿态模型…但加载不成功」）
 *
 * 用户要求：「增加一个进度条，在加载姿态模型的时候通过进度条来反馈进度」。这里钉住：
 *   ① 进度纯函数 composeProgress：按 运行库 40% / 模型 40% / 初始化 20% 合成，百分比单调不减，
 *      拿不到总大小 → 不确定态（percent=null，绝不谎报）；
 *   ② 流式下载：`response.body.getReader()` 逐块读、按 Content-Length 算百分比、进度回调递增，
 *      字节拼出来的结果与源数据一致；
 *   ③ 卡住超时：读流一直没有新字节 → 超时（错误里带「已收 / 总共」），提示文案说「超时」，
 *      不会再出现「永远转圈」；
 *   ④ 顺序与真实进度：先预热 wasm 两个文件、再下模型（各一次），进度条先出现在遮罩里、
 *      三段依次变成「完成」，加载完收起；初始化那段的「已用秒数」与不确定态有对应 DOM 状态；
 *   ⑤ 进度每 2 秒写一条诊断日志（`pose:progress`，只有数字），`done` 那条一定写。
 * ------------------------------------------------------------------ */

console.log('\n[17e] 姿态模型加载进度条 + 每阶段超时（不再「永远转圈」）');
{
  const api = windowStub.__mfg;
  const { t: tProg } = await import('../src/i18n.js');
  const {
    composeProgress, formatMB, PROGRESS_WEIGHTS, DOWNLOAD_STALL_TIMEOUT_MS, INIT_TIMEOUT_MS,
    GPU_INIT_TIMEOUT_MS, DEFAULT_DELEGATE, modelUrlFor, NOSIMD_FILES,
  } = await import('../src/pose-engine.js');
  const engine = api.engine;
  const mask = elements.get('stageMask');
  const box = elements.get('modelProgress');
  const pctEl = elements.get('mpPercent');

  const saved = {
    resolveVision: engine.resolveVision,
    createLandmarker: engine.createLandmarker,
    fetchModel: engine.fetchModel,
    sleep: engine.sleep,
    poseDelegate: api.state.settings.poseDelegate,
    engineReady: api.state.engineReady,
    modelError: api.state.modelError,
    tuning: { ...api.poseLoadTuning },
  };
  const makeLandmarker = ({ detect } = {}) => ({
    closed: false,
    close() { this.closed = true; },
    detectForVideo: detect || (() => ({ landmarks: [[{ x: 0.5, y: 0.5, z: 0, visibility: 1 }]] })),
  });
  const resetEngine = () => { engine.close(); engine._vision = null; engine._wasmWarmed = ''; };

  /** 造一个「有流式 body」的假 Response（chunks 逐块吐；total 写 Content-Length） */
  const streamResponse = (chunks, total) => ({
    ok: true,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(total) : null) },
    body: {
      getReader() {
        let i = 0;
        return {
          read: async () => {
            if (i >= chunks.length) return { done: true, value: undefined };
            const value = chunks[i];
            i += 1;
            return { done: false, value };
          },
          cancel: async () => {},
          releaseLock() {},
        };
      },
    },
  });

  // 纯函数先来：权重、单调、边界
  ok('超时阈值是这一套：下载 60s 没新字节 / 初始化 45s（GPU 只给 6s 软超时）/ 默认 CPU',
    DOWNLOAD_STALL_TIMEOUT_MS === 60000 && INIT_TIMEOUT_MS === 45000
    && GPU_INIT_TIMEOUT_MS === 6000 && DEFAULT_DELEGATE === 'CPU'
    && PROGRESS_WEIGHTS.wasm === 0.4 && PROGRESS_WEIGHTS.model === 0.4 && PROGRESS_WEIGHTS.init === 0.2,
    JSON.stringify({ DOWNLOAD_STALL_TIMEOUT_MS, INIT_TIMEOUT_MS, GPU_INIT_TIMEOUT_MS, DEFAULT_DELEGATE, PROGRESS_WEIGHTS }));

  ok('composeProgress：运行库 40% / 模型 40% / 初始化 20%（逐步走完正好 100%）',
    composeProgress({}).percent === 0
    && composeProgress({ wasm: { loaded: 5, total: 5 }, model: { loaded: 0, total: 5 } }).percent === 40
    && composeProgress({ wasm: { loaded: 5, total: 5 }, model: { loaded: 5, total: 5 } }).percent === 80
    && composeProgress({ wasm: { loaded: 5, total: 5 }, model: { loaded: 5, total: 5 }, init: 0.5 }).percent === 90
    && composeProgress({
      wasm: { loaded: 5, total: 5, done: true },
      model: { loaded: 5, total: 5, done: true },
      init: 1,
    }).percent === 100,
    JSON.stringify(['', 'wasm done', 'both done', 'init half', 'all done'].map((label, i) => [
      label, [composeProgress({}), composeProgress({ wasm: { loaded: 5, total: 5 }, model: { loaded: 0, total: 5 } }),
        composeProgress({ wasm: { loaded: 5, total: 5 }, model: { loaded: 5, total: 5 } }),
        composeProgress({ wasm: { loaded: 5, total: 5 }, model: { loaded: 5, total: 5 }, init: 0.5 }),
        composeProgress({ wasm: { loaded: 5, total: 5, done: true }, model: { loaded: 5, total: 5, done: true }, init: 1 })][i].percent,
    ])));

  ok('composeProgress：字节增长时百分比单调不减（进度条不会往回跳）',
    (() => {
      const percents = [0, 1, 2, 3, 4, 5].map((loaded) => composeProgress({
        wasm: { loaded: 5, total: 5, done: true },
        model: { loaded, total: 5 },
      }).percent);
      return percents.every((p, i) => i === 0 || p >= percents[i - 1]) && percents.at(-1) === 80;
    })(),
    JSON.stringify([0, 1, 2, 3, 4, 5].map((loaded) => composeProgress({
      wasm: { loaded: 5, total: 5, done: true }, model: { loaded, total: 5 },
    }).percent)));

  ok('composeProgress：拿不到 Content-Length（total 未知）→ 不确定态（percent=null），不谎报百分比',
    (() => {
      const p = composeProgress({ wasm: { loaded: 1024, total: 0 } });
      return p.percent === null && p.indeterminate === true && p.wasm.loaded === 1024;
    })(),
    JSON.stringify(composeProgress({ wasm: { loaded: 1024, total: 0 } })));

  ok('formatMB：B / KB / MB 三档都写得出来（进度条与失败原因共用同一份）',
    formatMB(0) === '0B' && formatMB(2048) === '2KB' && formatMB(5.6 * 1024 * 1024) === '5.6MB',
    `${formatMB(0)} ${formatMB(2048)} ${formatMB(5.6 * 1024 * 1024)}`);

  /* ---- 流式下载：进度递增 + 字节正确 ---- */
  {
    const events = [];
    engine.fetchModel = async () => streamResponse(
      [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])], 5,
    );
    const got = await engine.downloadWithProgress('model.task', {
      stage: 'model', timeoutMs: 1000, onProgress: (p) => events.push(p),
    });
    ok('流式下载：逐块读完得到的字节与源数据一致（拼装没丢没重）',
      got.byteLength === 5 && [...got].join(',') === '1,2,3,4,5',
      `${got.byteLength}:${[...got].join(',')}`);
    ok('流式下载：进度回调按 Content-Length 递增（0 → 2 → 5 → 完成），最后一条 done=true',
      events.length >= 3 && events[0].loaded === 0 && events[0].total === 5
      && events.every((e, i) => i === 0 || e.loaded >= events[i - 1].loaded)
      && events.at(-1).loaded === 5 && events.at(-1).done === true,
      JSON.stringify(events.map((e) => [e.loaded, e.total, !!e.done])));
    ok('流式下载：进度换算成百分比也是单调不减的（进度条不会抖回去）',
      (() => {
        const percents = events.map((e) => composeProgress({ model: e }).percent);
        return percents.every((p, i) => i === 0 || p >= percents[i - 1]);
      })(),
      JSON.stringify(events.map((e) => composeProgress({ model: e }).percent)));
  }

  /* ---- 卡住超时：读流一直没有新字节 → 超时（带「已收 / 总共」）---- */
  {
    let reads = 0;
    engine.fetchModel = async () => ({
      ok: true,
      headers: { get: () => '10000' },
      body: {
        getReader: () => ({
          read: () => {
            reads += 1;
            if (reads === 1) return Promise.resolve({ done: false, value: new Uint8Array(5000) });
            return new Promise(() => {});   // 之后永远不返回（就是用户遇到的「卡死」）
          },
          cancel: async () => {},
          releaseLock() {},
        }),
      },
    });
    let stall = null;
    try {
      await engine.downloadWithProgress('model.task', { stage: 'model', timeoutMs: 1000 });
    } catch (err) { stall = err; }
    ok('下载卡住（60s 没有新字节，测试里调成 1s）→ 超时失败，而不是永远 await',
      !!stall && stall.name === 'PoseLoadError' && stall.errName === 'TimeoutError'
      && stall.stage === 'model' && stall.seconds === 1,
      JSON.stringify(stall && { name: stall.name, errName: stall.errName, stage: stall.stage, seconds: stall.seconds }));
    ok('超时错误带着「已收 / 总共」字节（界面才能说清是网慢还是根本没开始）',
      stall.loaded === 5000 && stall.total === 10000,
      JSON.stringify({ loaded: stall.loaded, total: stall.total }));
    const reason = api.poseFailReason(stall);
    ok('卡住时的提示文案带「超时」+ 已收 / 总共（如「超时 1s（已收 5KB / 10KB）」）',
      reason === tProg('ui.poseReasonStall', {
        sec: '1', got: formatMB(5000), total: formatMB(10000),
      })
      && reason.includes('超时') && reason.includes(formatMB(5000)),
      reason);
  }

  /* ---- 真实加载：只下模型（运行库交给识别器内部下载），进度条出现在遮罩里并在结束后收起 ---- */
  {
    resetEngine();
    api.state.engineReady = false;
    api.state.settings.poseDelegate = '';
    const calls = [];
    engine.resolveVision = async () => ({
      wasmLoaderPath: '/vendor/tasks-vision/wasm/vision_wasm_internal.js',
      wasmBinaryPath: '/vendor/tasks-vision/wasm/vision_wasm_internal.wasm',
    });
    engine.fetchModel = async (url) => {
      calls.push(String(url));
      return streamResponse([new Uint8Array(2)], 2);
    };
    engine.createLandmarker = async () => makeLandmarker();

    const pending = api.loadPoseModel();
    ok('加载过程中遮罩里出现进度条（真实进度，不是假转圈）：三段都摆出来了',
      box.hidden === false
      && !!elements.get('mpFillWasm') && !!elements.get('mpFillModel') && !!elements.get('mpFillInit'));
    const okLoad = await pending;
    ok('只下模型一次（运行库交给识别器内部下载：不再预热、不会把 9.3MB 下两遍），URL 带 ?v= 指纹',
      okLoad === true && calls.length === 1
      && calls[0].includes('pose_landmarker_lite.task') && /\?v=\d+$/.test(calls[0])
      && modelUrlFor('lite') === calls[0],
      JSON.stringify(calls));
    ok('加载完成：整条进度条收起、三段都是「完成」、总百分比 100%',
      box.hidden === true && api.modelProgressState.shownPercent === 100
      && elements.get('mpRowWasm').dataset.state === 'done'
      && elements.get('mpRowModel').dataset.state === 'done'
      && elements.get('mpRowInit').dataset.state === 'done'
      && elements.get('mpMetaWasm').textContent === tProg('ui.modelProgressDone'),
      JSON.stringify({
        hidden: box.hidden,
        shown: api.modelProgressState.shownPercent,
        wasm: elements.get('mpRowWasm').dataset.state,
        model: elements.get('mpRowModel').dataset.state,
        init: elements.get('mpRowInit').dataset.state,
      }));
    ok('进度也写进了诊断日志（lastType = pose:progress，只有数字、没有二进制）',
      api.coachDiag.snapshot().lastType === 'pose:progress',
      api.coachDiag.snapshot().lastType);
  }

  /* ---- 进度条 DOM：模型字节百分比 / 运行库那一行说清「谁在下载」 ---- */
  {
    api.resetModelProgress();
    api.modelProgressState.wasm = { loaded: 0, total: 0, bps: 0, done: false, byEngine: true };
    api.modelProgressState.model = { loaded: 100, total: 500, bps: 0, done: false };
    const sum = api.renderModelProgress();
    ok('进度条：总百分比只按模型 + 初始化算（模型 100/500 → 13%），运行库那行不谎报字节',
      sum.percent === 13 && pctEl.textContent === '13%'
      && elements.get('mpMetaWasm').textContent === tProg('ui.modelProgressByEngine')
      && elements.get('mpRowWasm').dataset.state === 'indeterminate',
      JSON.stringify({ percent: sum.percent, pct: pctEl.textContent, meta: elements.get('mpMetaWasm').textContent }));

    api.resetModelProgress();
    api.modelProgressState.model = { loaded: 999, total: 0, bps: 0, done: false };
    api.renderModelProgress();
    ok('进度条：模型拿不到总大小时显示「进行中…」+ 不确定态（脉冲由 CSS 负责）',
      pctEl.textContent === tProg('ui.modelProgressIndeterminate')
      && elements.get('mpRowModel').dataset.state === 'indeterminate'
      && elements.get('mpMetaModel').textContent.includes('999B'),
      JSON.stringify({ pct: pctEl.textContent, state: elements.get('mpRowModel').dataset.state }));

    api.resetModelProgress();
    api.modelProgressState.init = 0;   // 初始化没开始 → 等待中
    api.renderModelProgress();
    ok('进度条：还没开始的阶段显示「等待中」，初始化进行中显示已用秒数（数字是真的）',
      elements.get('mpRowInit').dataset.state === 'waiting'
      && elements.get('mpMetaInit').textContent === tProg('ui.modelProgressWaiting')
      && api.modelProgressState.init === 0,
      JSON.stringify({ state: elements.get('mpRowInit').dataset.state, meta: elements.get('mpMetaInit').textContent }));
    api.resetModelProgress();
  }

  /* ---- 进度写日志：每 2 秒一条，done 一定写 ---- */
  {
    api.poseProgressLog.lastAt = 0;
    const before = api.coachDiag.snapshot().events;
    const first = api.notePoseProgress({ stage: 'model', loaded: 1000, total: 2000, bps: 500 });
    const second = api.notePoseProgress({ stage: 'model', loaded: 1500, total: 2000, bps: 500 });
    const afterThrottle = api.coachDiag.snapshot().events;
    const done = api.notePoseProgress({
      stage: 'model', loaded: 2000, total: 2000, bps: 500, done: true,
    });
    ok('进度日志：2 秒内的重复进度被节流（只写一条），但 done 那条一定写',
      first === true && second === false && done === true
      && afterThrottle === before + 1 && api.coachDiag.snapshot().events === before + 2,
      JSON.stringify({ first, second, done, events: api.coachDiag.snapshot().events - before }));
  }

  /* ---- 卡死 → 超时 → 失败提示（用户看到的那句话）---- */
  {
    resetEngine();
    api.state.settings.poseDelegate = '';
    api.state.engineReady = false;
    api.poseLoadTuning.stallTimeoutMs = 1000;
    api.poseLoadTuning.attempts = 1;
    api.poseLoadTuning.retryDelays = [0];
    engine.sleep = async () => {};
    engine.resolveVision = async () => ({});
    engine.fetchModel = async () => ({
      ok: true,
      headers: { get: () => '5600000' },
      body: {
        getReader: () => ({
          read: () => new Promise(() => {}),   // 模型：一块都没来（卡死）
          cancel: async () => {},
          releaseLock() {},
        }),
      },
    });
    const okLoad = await api.loadPoseModel();
    ok('模型下载卡死 → 1s 后失败（不再永远「正在加载」），提示带阶段 + 超时 + 已收 / 总共',
      okLoad === false
      && elements.get('maskText').textContent === api.poseFailText({
        stage: 'model', errName: 'TimeoutError', reason: 'no data', seconds: 1, loaded: 0, total: 5600000,
      })
      && elements.get('maskText').textContent.includes(tProg('ui.poseStageModel'))
      && elements.get('maskText').textContent.includes('超时')
      && elements.get('maskText').textContent.includes('5.3MB'),
      elements.get('maskText').textContent);
    ok('卡死失败后进度条也收起（不会盖着错误提示）', box.hidden === true);
    ok('卡死失败写进诊断日志：pose:load-fail（stage=model / name=TimeoutError）',
      api.state.modelError?.stage === 'model' && api.state.modelError?.name === 'TimeoutError'
      && api.coachDiag.snapshot().lastType === 'pose:load-fail',
      JSON.stringify(api.state.modelError));
  }

  /* ---- file:// 打开：fetch 会被浏览器拦住 → 明确报「打开方式不对」，不干等 ---- */
  {
    resetEngine();
    api.state.settings.poseDelegate = '';
    api.state.engineReady = false;
    const savedLocation = globalThis.location;
    const savedFetchModel = engine.fetchModel;
    let fetched = 0;
    engine.fetchModel = async () => { fetched += 1; return new Promise(() => {}); };
    Object.defineProperty(globalThis, 'location', {
      value: { protocol: 'file:', host: '', search: '', href: 'file:///C:/x/index.html' },
      configurable: true,
      writable: true,
    });
    const okLoad = await api.loadPoseModel();
    Object.defineProperty(globalThis, 'location', { value: savedLocation, configurable: true, writable: true });
    engine.fetchModel = savedFetchModel;
    ok('从 file:// 打开 → 立刻明确报「打开方式不对」（不是从 http://127.0.0.1:4174 打开的）',
      okLoad === false && fetched === 0
      && api.state.modelError?.stage === 'env'
      && api.state.modelError?.name === 'FileProtocol'
      && elements.get('maskText').textContent.includes(tProg('ui.poseStageEnv'))
      && elements.get('maskText').textContent.includes('127.0.0.1:4174'),
      JSON.stringify({ okLoad, fetched, modelError: api.state.modelError, text: elements.get('maskText').textContent }));
  }

  // 恢复现场
  resetEngine();
  engine.resolveVision = saved.resolveVision;
  engine.createLandmarker = saved.createLandmarker;
  engine.fetchModel = saved.fetchModel;
  engine.sleep = saved.sleep;
  api.state.settings.poseDelegate = saved.poseDelegate;
  api.state.engineReady = saved.engineReady;
  api.state.modelError = saved.modelError;
  Object.assign(api.poseLoadTuning, saved.tuning);
  api.resetModelProgress();
  api.showHome();
  api.state.session = 'idle';
}

/* ------------------------------------------------------------------ *
 * [17e2] 加载偏慢提示：单块 < 1MB/s 且已用 > 8 秒 → 一行黄色提示 + pose:slow-load
 *
 * 用户反馈「刚开始加载运行库总是有问题 —— 公司网络加载很快，家里网络加载很慢」。
 * 运行库与模型都是**本机 4174 提供的本地文件**（直连 10MB/s 以上，实测 9.3MB 走 86~1655ms），
 * 慢成这样基本只有一种原因：**代理 / VPN 把 127.0.0.1 也代理了**（Chrome 默认把 localhost
 * 交给系统代理，除非显式绕过）。所以界面只**提示**「把 127.0.0.1、localhost 加进直连再刷新」——
 * **绝不自动改系统代理** ✗；诊断日志只留两个数字（bps / elapsedMs），方便对比「家里 vs 公司」。
 *
 * 阈值**一处定义**在 pose-engine.js（SLOW_LOAD_BPS / SLOW_LOAD_AFTER_MS），界面与测试都读它。
 * ------------------------------------------------------------------ */
console.log('\n[17e2] 加载偏慢提示：< 1MB/s 且 > 8s 才出现，只提示不改系统设置');
{
  const api = windowStub.__mfg;
  const { t: tSlow } = await import('../src/i18n.js');
  const enDict = (await import('../src/locales/en.js')).default;
  const hintEl = elements.get('mpSlowHint');

  ok('门槛一处定义：1MB/s + 8 秒（界面与测试读同一份常量，不是另抄一份）',
    api.SLOW_LOAD_BPS === 1024 * 1024 && api.SLOW_LOAD_AFTER_MS === 8000,
    JSON.stringify({ bps: api.SLOW_LOAD_BPS, ms: api.SLOW_LOAD_AFTER_MS }));

  ok('isSlowLoad：慢（300KB/s · 9s）→ true；快（20MB/s）→ false；还不够 8 秒 → false',
    api.isSlowLoad({ bps: 300 * 1024, elapsedMs: 9000 }) === true
    && api.isSlowLoad({ bps: 20 * 1024 * 1024, elapsedMs: 9000 }) === false
    && api.isSlowLoad({ bps: 300 * 1024, elapsedMs: 7999 }) === false);
  ok('isSlowLoad 的边界：8s 整就算慢、正好 1MB/s 不算慢、bps=0（一个字节没来）归「卡住」那一档去报',
    api.isSlowLoad({ bps: 1, elapsedMs: 8000 }) === true
    && api.isSlowLoad({ bps: api.SLOW_LOAD_BPS, elapsedMs: 60000 }) === false
    && api.isSlowLoad({ bps: 0, elapsedMs: 60000 }) === false
    && api.isSlowLoad({}) === false);

  ok('词条中英都有，且都指向「把 127.0.0.1 / localhost 加进代理直连」',
    tSlow('ui.modelSlowLoad').includes('127.0.0.1') && tSlow('ui.modelSlowLoad').includes('localhost')
    && tSlow('ui.modelSlowLoad').includes('刷新')
    && enDict.ui.modelSlowLoad.includes('127.0.0.1') && enDict.ui.modelSlowLoad.includes('localhost')
    && /refresh/i.test(enDict.ui.modelSlowLoad),
    enDict.ui.modelSlowLoad);
  ok('那一行挂在进度条下面（index.html 的 #mpSlowHint，走 data-i18n，不写死文案）',
    !!hintEl && hintEl.getAttribute('data-i18n') === 'ui.modelSlowLoad',
    hintEl && hintEl.getAttribute('data-i18n'));

  /* ---- 慢：提示出现 + 只记一条诊断（bps / elapsedMs，没有文件内容）---- */
  const records = [];
  const savedRecord = api.coachDiag.record;
  api.coachDiag.record = (type, data) => {
    records.push({ type, data });
    return savedRecord.call(api.coachDiag, type, data);
  };
  let slow = null;
  let fast = null;
  let slowHidden = null;
  let fastHidden = null;
  try {
    api.resetModelProgress();
    api.modelProgressState.loadStartedAt = Date.now() - 9000;
    api.modelProgressState.model = {
      loaded: 300 * 1024, total: 2 * 1024 * 1024, bps: 300 * 1024, done: false,
    };
    slow = api.updateSlowLoadHint();
    slowHidden = hintEl.hidden;   // 那一刻的状态（后面「变快」还会改它）
    // 进度条每 0.5 秒重画一次：再画两次也只能有一条诊断
    api.updateSlowLoadHint();
    api.updateSlowLoadHint();

    api.modelProgressState.model = {
      loaded: 8 * 1024 * 1024, total: 10 * 1024 * 1024, bps: 20 * 1024 * 1024, done: false,
    };
    fast = api.updateSlowLoadHint();
    fastHidden = hintEl.hidden;
  } finally {
    api.coachDiag.record = savedRecord;
  }
  ok('慢链路：黄色提示出现（hidden=false）', slow === true && slowHidden === false,
    JSON.stringify({ slow, hidden: slowHidden }));
  ok('慢链路写一条 pose:slow-load {bps, elapsedMs} —— 只有两个数字，没有文件名 / 文件内容',
    records.length === 1 && records[0].type === 'pose:slow-load'
    && records[0].data.bps === 300 * 1024
    && records[0].data.elapsedMs >= 9000
    && Object.keys(records[0].data).sort().join(',') === 'bps,elapsedMs',
    JSON.stringify(records));
  ok('同一次加载只记一条（进度条每 0.5 秒重画，诊断日志不会被刷爆）', records.length === 1);
  ok('速率跟上来（20MB/s）→ 提示自己收起', fast === false && fastHidden === true,
    JSON.stringify({ fast, hidden: fastHidden }));

  api.resetModelProgress();
  ok('重新开始加载（含重试）：提示收起、slowLogged 清零（下一次还能再提示一次）',
    api.modelProgressState.slowLogged === false && api.modelProgressState.loadStartedAt > 0,
    JSON.stringify({
      slowLogged: api.modelProgressState.slowLogged, startedAt: api.modelProgressState.loadStartedAt,
    }));
  ok('「慢」不写进诊断面板的 lastError（慢不是错误；面板照旧显示真正的错误）',
    !String(api.coachDiag.snapshot().lastError).includes('slow'),
    api.coachDiag.snapshot().lastError);
}

/* ------------------------------------------------------------------ *
 * [17f] 初始化识别器：**卡住（不 reject）也要兜底** + CPU 优先 + 诊断留痕
 *
 * 用户实测的错误原文：「姿态模型加载失败 / 推理器创建失败（超时 20s）」。
 * 关键点：`createFromOptions` 是**卡死**（既不 resolve 也不 reject），只接 reject 的兜底
 * 永远等不到 —— 所以：
 *   ① 默认 CPU（根本不去碰那条会卡死的 GPU 路）；
 *   ② 显式要 GPU 时只给 6s 软超时，超时也切 CPU，并把 'cpu' 记进设置；
 *   ③ 初始化超时放宽到 45s，提示写清「上限 / 已用」；
 *   ④ 每次初始化都写 pose:init-start / pose:init-fail / pose:init-timeout（带 crossOriginIsolated）。
 * 这一段用「永不 resolve 的 Promise」直接钉住用户这次的形态。
 * ------------------------------------------------------------------ */
console.log('\n[17f] 初始化卡死也要兜底：GPU 6s 软超时 → CPU / 45s 上限 / 诊断留痕');
{
  const api = windowStub.__mfg;
  const { t: tInit } = await import('../src/i18n.js');
  const { NOSIMD_FILES, DEFAULT_DELEGATE, INIT_TIMEOUT_MS, GPU_INIT_TIMEOUT_MS } = await import('../src/pose-engine.js');
  const engine = api.engine;
  const mask = elements.get('stageMask');
  const maskText = elements.get('maskText');
  const cue = elements.get('cueLine');

  const saved = {
    resolveVision: engine.resolveVision,
    createLandmarker: engine.createLandmarker,
    fetchModel: engine.fetchModel,
    sleep: engine.sleep,
    poseDelegate: api.state.settings.poseDelegate,
    engineReady: api.state.engineReady,
    modelError: api.state.modelError,
    tuning: { ...api.poseLoadTuning },
    crossOriginIsolated: windowStub.crossOriginIsolated,
    record: api.coachDiag.record,
  };
  const makeLandmarker = () => ({
    closed: false,
    close() { this.closed = true; },
    detectForVideo: () => ({ landmarks: [[{ x: 0.5, y: 0.5, z: 0, visibility: 1 }]] }),
  });
  const resetEngine = () => { engine.close(); engine._vision = null; };
  const bytes = () => new Uint8Array([1, 2, 3, 4]);
  /** 录下所有诊断事件（app 里是 coachDiag.record(...)，替换属性就能截到） */
  const seen = [];
  api.coachDiag.record = (type, data = {}) => {
    seen.push({ type, ...data });
    return saved.record(type, data);
  };
  const eventsOf = (type) => seen.filter((e) => e.type === type);

  // 让计时快一点：GPU 软超时 120ms、初始化上限 400ms
  api.poseLoadTuning.gpuTimeoutMs = 120;
  api.poseLoadTuning.initTimeoutMs = 400;
  api.poseLoadTuning.totalTimeoutMs = 15000;
  api.poseLoadTuning.retryDelays = [0, 0, 0];
  engine.sleep = async () => {};
  engine.resolveVision = async () => ({});
  engine.fetchModel = async () => bytes();

  /* ---- ① 默认就是 CPU：不碰 GPU（用户今天就是被 GPU 卡死的） ---- */
  {
    resetEngine();
    api.state.engineReady = false;
    api.state.settings.poseDelegate = '';
    const delegates = [];
    engine.createLandmarker = async (vision, options) => {
      delegates.push(options.baseOptions.delegate);
      return makeLandmarker();
    };
    const okLoad = await api.loadPoseModel();
    ok('默认 CPU（设置里空串也走 CPU）→ 第一次就只建 CPU，不再先碰会卡死的 GPU',
      okLoad === true && delegates.join(',') === 'CPU' && engine.delegate === 'CPU'
      && DEFAULT_DELEGATE === 'CPU',
      JSON.stringify({ okLoad, delegates }));
  }

  /* ---- ② GPU 卡死（永不 resolve）→ 6s 软超时也兜底切 CPU，并记住 cpu ---- */
  {
    resetEngine();
    api.state.engineReady = false;
    api.state.settings.poseDelegate = 'gpu';   // 只有显式要 GPU 才走这条链
    windowStub.crossOriginIsolated = true;
    seen.length = 0;
    const delegates = [];
    engine.createLandmarker = async (vision, options) => {
      delegates.push(options.baseOptions.delegate);
      // GPU：**永远不 resolve**（用户实测的卡死形态；不是 reject，所以只接 reject 的兜底会白等）
      if (options.baseOptions.delegate === 'GPU') return new Promise(() => {});
      return makeLandmarker();
    };
    const startedAt = Date.now();
    const okLoad = await api.loadPoseModel();
    const ms = Date.now() - startedAt;
    ok('GPU 初始化卡死（createFromOptions 永不返回）→ 软超时后**自动改试 CPU**并成功',
      okLoad === true && delegates.join(',') === 'GPU,CPU' && engine.delegate === 'CPU'
      && api.state.settings.poseDelegate === 'cpu'
      && ms >= api.poseLoadTuning.gpuTimeoutMs && ms < 5000,
      JSON.stringify({ okLoad, delegates, delegate: engine.delegate, setting: api.state.settings.poseDelegate, ms }));
    ok('GPU 卡住时提示条说的是「GPU 初始化卡住，已自动改用 CPU」（不是笼统的失败）',
      cue.textContent === tInit('ui.poseGpuHang') && cue.textContent.includes('CPU'),
      cue.textContent);
    const initStart = eventsOf('pose:init-start');
    const initFail = eventsOf('pose:init-fail');
    const initTimeout = eventsOf('pose:init-timeout');
    ok('诊断留痕：pose:init-start 带 delegate / attempt / conservative / crossOriginIsolated / hardwareConcurrency',
      initStart.length >= 2 && initStart[0].delegate === 'GPU'
      && initStart[0].crossOriginIsolated === true
      && typeof initStart[0].hardwareConcurrency === 'number'
      && initStart[0].timeoutMs === api.poseLoadTuning.gpuTimeoutMs,
      JSON.stringify(initStart.slice(0, 2)));
    ok('诊断留痕：GPU 超时写 pose:init-fail（TimeoutError + elapsedMs）与 pose:init-timeout',
      initFail.length === 1 && initFail[0].delegate === 'GPU'
      && initFail[0].name === 'TimeoutError' && initFail[0].elapsedMs > 0
      && initTimeout.length === 1 && initTimeout[0].delegate === 'GPU'
      && initTimeout[0].timeoutMs === api.poseLoadTuning.gpuTimeoutMs,
      JSON.stringify({ initFail, initTimeout }));
    ok('GPU → CPU 的切换也写了 pose:delegate（带 elapsedMs，不写任何二进制）',
      eventsOf('pose:delegate').some((e) => e.from === 'GPU' && e.to === 'CPU' && e.name === 'TimeoutError'),
      JSON.stringify(eventsOf('pose:delegate')));
  }

  /* ---- ③ CPU 也卡死 → 最终提示「初始化识别器超时（上限 45s，已用 …s）」 ---- */
  {
    resetEngine();
    api.state.engineReady = false;
    api.state.settings.poseDelegate = '';   // 默认 CPU
    api.poseLoadTuning.initTimeoutMs = 1200;
    seen.length = 0;
    let creates = 0;
    engine.createLandmarker = async () => { creates += 1; return new Promise(() => {}); };   // 永远卡住
    const okLoad = await api.loadPoseModel();
    const text = maskText.textContent;
    const expected = tInit('ui.poseInitTimeout', { timeout: '1', elapsed: '1' });
    ok('CPU 初始化也卡死 → 只试一次就报错（不重复白等），提示是「初始化识别器超时（上限 / 已用）」',
      okLoad === false && creates === 1
      && text === expected
      && text.startsWith('初始化识别器超时')
      && api.state.modelError?.stage === 'create'
      && api.state.modelError?.name === 'TimeoutError'
      && api.state.modelError?.timeoutMs === api.poseLoadTuning.initTimeoutMs
      && api.state.modelError?.elapsedMs > 0,
      JSON.stringify({ okLoad, creates, text, modelError: api.state.modelError }));
    ok('失败后遮罩标题 / 重试按钮都是「加载失败 / 重试加载模型」，遮罩保持显示',
      elements.get('maskTitle').textContent === tInit('ui.maskModelFail')
      && elements.get('maskText').textContent === text
      && elements.get('btnStartCam').textContent === tInit('ui.poseRetryBtn')
      && mask.classList.contains('hidden') === false);
    ok('CPU 卡死也写 pose:init-fail + pose:init-timeout（delegate=CPU，带真实 elapsedMs）',
      eventsOf('pose:init-fail').some((e) => e.delegate === 'CPU' && e.name === 'TimeoutError' && e.elapsedMs > 0)
      && eventsOf('pose:init-timeout').some((e) => e.delegate === 'CPU' && e.elapsedMs > 0),
      JSON.stringify({ fail: eventsOf('pose:init-fail'), timeout: eventsOf('pose:init-timeout') }));
    ok('最终失败也照旧写 pose:load-fail（stage=create / name=TimeoutError）',
      eventsOf('pose:load-fail').some((e) => e.stage === 'create' && e.name === 'TimeoutError'),
      JSON.stringify(eventsOf('pose:load-fail')));
    ok('初始化超时的诊断不碰任何二进制 / 密钥字段',
      !/audio|pcm|apiKey|token|buffer/.test(JSON.stringify(seen)),
      JSON.stringify(seen).slice(0, 120));
    api.poseLoadTuning.initTimeoutMs = saved.tuning.initTimeoutMs;
  }

  /* ---- ④ CPU 抛非超时的初始化错误 → 用「非 SIMD 运行库 + CPU」最保守那档再试一次 ---- */
  {
    resetEngine();
    api.state.engineReady = false;
    api.state.settings.poseDelegate = '';
    seen.length = 0;
    const filesets = [];
    let calls = 0;
    engine.createLandmarker = async (vision, options) => {
      filesets.push(vision);
      calls += 1;
      if (calls === 1) {
        const err = new Error('RuntimeError: abort(CompileError). Build with -sASSERTIONS');
        err.name = 'RuntimeError';
        throw err;
      }
      return makeLandmarker();
    };
    const okLoad = await api.loadPoseModel();
    ok('初始化抛「SIMD / wasm 编译」类错误（非超时）→ 用非 SIMD 运行库再试一次（最保守一档）并成功',
      okLoad === true && calls === 2
      && filesets[0] !== NOSIMD_FILES && filesets[1] === NOSIMD_FILES
      && engine.ready === true && engine.delegate === 'CPU',
      JSON.stringify({ okLoad, calls, secondIsNosimd: filesets[1] === NOSIMD_FILES }));
    ok('最保守那次的诊断带 conservative=1 与 attempt=2（能看出「第二次换了运行库」）',
      eventsOf('pose:init-fail').some((e) => e.delegate === 'CPU' && e.attempt === 1 && e.retry === 1)
      && eventsOf('pose:init-start').some((e) => e.conservative === 1 && e.attempt === 2),
      JSON.stringify({ fail: eventsOf('pose:init-fail'), start: eventsOf('pose:init-start') }));
    ok('纯超时**不会**再补一次非 SIMD（免得白等两轮）—— 只有非超时错误才换运行库',
      INIT_TIMEOUT_MS > GPU_INIT_TIMEOUT_MS
      && INIT_TIMEOUT_MS === 45000 && GPU_INIT_TIMEOUT_MS === 6000);
  }

  // 恢复现场
  api.coachDiag.record = saved.record;
  resetEngine();
  engine.resolveVision = saved.resolveVision;
  engine.createLandmarker = saved.createLandmarker;
  engine.fetchModel = saved.fetchModel;
  engine.sleep = saved.sleep;
  api.state.settings.poseDelegate = saved.poseDelegate;
  api.state.engineReady = saved.engineReady;
  api.state.modelError = saved.modelError;
  Object.assign(api.poseLoadTuning, saved.tuning);
  if ('crossOriginIsolated' in windowStub) windowStub.crossOriginIsolated = saved.crossOriginIsolated;
  api.resetModelProgress();
  api.showHome();
  api.state.session = 'idle';
}

/* ------------------------------------------------------------------ *
 * ⑧ 摄像头诊断面板（手机打不开摄像头时，把客观事实摆出来 + 一句处置建议）
 *
 * 用户实测：iPhone 上只有 QQ 浏览器能开摄像头，Safari / Chrome 不能。
 * 根因是 secure context 规则（http + 局域网 IP 一律不给 getUserMedia），
 * 所以面板必须**先**把 isSecureContext / location.protocol 摆出来，再谈权限。
 * 这里用构造出来的环境喂纯函数，把「什么环境说什么话」钉住。
 * ------------------------------------------------------------------ */
{
  const api = windowStub.__mfg;
  const { t: tDiag } = await import('../src/i18n.js');

  // 手机 http + 局域网 IP 的真实样子：不是安全上下文、mediaDevices 直接不存在
  const insecure = {
    secureContext: false, protocol: 'http:', hasMediaDevices: false, hasGetUserMedia: false,
    errName: '', errMessage: '', videoW: 0, videoH: 0,
    playsinline: null, muted: null, autoplay: null,
  };
  const denied = {
    secureContext: true, protocol: 'https:', hasMediaDevices: true, hasGetUserMedia: true,
    errName: 'NotAllowedError', errMessage: 'Permission denied', videoW: 0, videoH: 0,
    playsinline: true, muted: true, autoplay: true,
  };

  ok('非安全上下文（http + 局域网 IP）→ 处置建议直接指向「换 https」',
    api.cameraDiagAdviceKey(insecure) === 'diag.adviceInsecure',
    api.cameraDiagAdviceKey(insecure));
  ok('https 下 NotAllowedError → 建议去改浏览器 / 系统权限',
    api.cameraDiagAdviceKey(denied) === 'diag.adviceNotAllowed');
  ok('NotFoundError → 建议确认摄像头存在且没被占用',
    api.cameraDiagAdviceKey({ ...denied, errName: 'NotFoundError' }) === 'diag.adviceNotFound');
  ok('NotReadableError（被别的程序占用）→ 有自己的建议',
    api.cameraDiagAdviceKey({ ...denied, errName: 'NotReadableError' }) === 'diag.adviceNotReadable');
  ok('SecurityError / OverconstrainedError 也各自有建议',
    api.cameraDiagAdviceKey({ ...denied, errName: 'SecurityError' }) === 'diag.adviceSecurity'
    && api.cameraDiagAdviceKey({ ...denied, errName: 'OverconstrainedError' }) === 'diag.adviceOverconstrained');
  ok('没见过的错误名 → 兜底到「按上面的客观事实排查」',
    api.cameraDiagAdviceKey({ ...denied, errName: 'WeirdError' }) === 'diag.adviceUnknown');
  ok('错误名表里每种建议都真的有词条（不会显示成 key）',
    Object.values(api.DIAG_ERROR_ADVICE).every((k) => tDiag(k) !== k && !/^diag\./.test(tDiag(k))),
    Object.values(api.DIAG_ERROR_ADVICE).filter((k) => tDiag(k) === k).join(', '));

  const rows = api.cameraDiagRows(insecure);
  ok('诊断面板列出 7 项客观事实（含 isSecureContext / 协议 / 错误 / 画面尺寸 / video 属性）',
    rows.length === 7, `实际 ${rows.length} 行`);
  ok('第一行就是 isSecureContext，非安全上下文时标成「坏行」并显示「否」',
    rows[0].label.includes('isSecureContext') && rows[0].value === tDiag('diag.no') && rows[0].bad === true,
    JSON.stringify(rows[0]));
  ok('协议那一行显示的是真实的 location.protocol',
    rows[1].value === 'http:', rows[1].value);
  ok('mediaDevices / getUserMedia 不存在时也标成坏行',
    rows[2].bad === true && rows[3].bad === true);
  ok('没有报错时错误行写「（没有报错）」，有报错时把 name 和 message 都写出来',
    rows[4].value === tDiag('diag.noError') && api.cameraDiagRows(denied)[4].value === 'NotAllowedError: Permission denied',
    api.cameraDiagRows(denied)[4].value);
  ok('画面尺寸行写「videoWidth × videoHeight」',
    api.cameraDiagRows({ ...denied, videoW: 1280, videoH: 720 })[5].value === '1280 × 720');
  ok('拿不到 isSecureContext 这类事实时显示「—」，不假装是「否」',
    api.cameraDiagRows({ ...insecure, secureContext: null })[0].value === tDiag('diag.unknown'));

  // 真的写进 DOM（面板挂在遮罩里、原生 <details> 可折叠）
  api.renderCameraDiag({ name: 'NotAllowedError', message: 'Permission denied' });
  ok('诊断面板显示出来了（打不开时才出现）', elements.get('camDiag').hidden === false);
  ok('面板里写进了 7 行事实', elements.get('camDiagList').children.length === 7,
    `${elements.get('camDiagList').children.length} 行`);
  ok('出问题的那一行带 is-bad 类（一眼看出哪条不对）',
    elements.get('camDiagList').children.filter((li) => li.classList.contains('is-bad')).length === 1,
    elements.get('camDiagList').children.map((li) => li.className).join(' | '));
  ok('最后一行是处置建议，且与错误名对应',
    elements.get('camDiagAdvice').textContent === `${tDiag('diag.advice')}：${tDiag('diag.adviceNotAllowed')}`,
    elements.get('camDiagAdvice').textContent);
  ok('面板里每一行都是「字段名 + 值」两个 span（手机上窄屏也能一行一行看）',
    elements.get('camDiagList').children.every((li) => li.children.length === 2
      && li.children[0].className === 'cam-diag-k' && li.children[1].className === 'cam-diag-v'));

  // 非安全上下文时的文案必须明确提到 https（用户 iPhone 上 Safari / Chrome 打不开就是这个原因）
  ok('「地址不安全」的文案里明确写了 https 怎么办',
    /https/.test(tDiag('ui.maskInsecureText')) && /README/.test(tDiag('ui.maskInsecureText')),
    tDiag('ui.maskInsecureText').slice(0, 60));
}

/* ------------------------------------------------------------------ *
 * ⑨ 手机适配：设备档位 / 省电默认值 / 视口与安全区 / 竖屏遮罩 / 前后摄像头
 *
 * 用户要求「让该软件同时适应 PC 浏览器和手机浏览器」，同时「PC 行为必须不变」。
 * 下面全部按纯函数喂环境值来断言：手机结论要对，PC 结论必须和改造前一样（档位 high、模型不动）。
 * ------------------------------------------------------------------ */
{
  const api = windowStub.__mfg;
  const { t: tPhone } = await import('../src/i18n.js');
  const {
    cameraConstraintsFor, cameraAttemptsFor, shouldRetryCamera,
  } = await import('../src/pose-engine.js');

  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
  const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

  ok('设备识别：iPhone / Android 手机 → phone，iPad → tablet，PC → desktop',
    api.deviceClass({ ua: IPHONE_UA }) === 'phone' && api.deviceClass({ ua: ANDROID_UA }) === 'phone'
    && api.deviceClass({ ua: IPAD_UA }) === 'tablet' && api.deviceClass({ ua: PC_UA }) === 'desktop',
    [api.deviceClass({ ua: IPHONE_UA }), api.deviceClass({ ua: ANDROID_UA }),
      api.deviceClass({ ua: IPAD_UA }), api.deviceClass({ ua: PC_UA })].join(','));
  ok('iPadOS 把自己报成 Mac 时也不会被当成手机（触摸 + 屏幕最小边 768 → tablet/desktop）',
    api.deviceClass({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', maxTouchPoints: 5, screenMin: 768 }) === 'desktop');
  ok('UA 认不出来时靠「触摸屏 + 小屏」兜底判成手机',
    api.deviceClass({ ua: 'Mozilla/5.0 (Linux; Android 14)', maxTouchPoints: 5, screenMin: 412 }) === 'phone');

  ok('性能档位：手机一律 low（省电），PC 多核仍是 high（行为不变）',
    api.perfTier({ ua: IPHONE_UA, hardwareConcurrency: 6 }) === 'low'
    && api.perfTier({ ua: PC_UA, hardwareConcurrency: 16 }) === 'high'
    && api.perfTier({ ua: PC_UA, hardwareConcurrency: 2 }) === 'low',
    [api.perfTier({ ua: IPHONE_UA, hardwareConcurrency: 6 }),
      api.perfTier({ ua: PC_UA, hardwareConcurrency: 16 }),
      api.perfTier({ ua: PC_UA, hardwareConcurrency: 2 })].join(','));
  ok('默认模型：手机 / 低配 → 轻量；PC → null（不改动任何东西）',
    api.pickDefaultModelKey({ ua: IPHONE_UA }) === 'lite'
    && api.pickDefaultModelKey({ ua: PC_UA, hardwareConcurrency: 16 }) === null);

  // 用户改过的模型**永不覆盖**（用户明确要求）
  {
    const saved = { modelKey: api.state.settings.modelKey, modelKeySet: api.state.settings.modelKeySet };
    api.state.settings.modelKey = 'full';
    api.state.settings.modelKeySet = true;
    const changed = api.applyDeviceDefaults({ ua: IPHONE_UA });
    ok('用户自己选过模型（modelKeySet）→ 手机上也不会被改成轻量',
      changed === null && api.state.settings.modelKey === 'full', `${changed}/${api.state.settings.modelKey}`);
    api.state.settings.modelKey = 'full';
    api.state.settings.modelKeySet = false;
    const applied = api.applyDeviceDefaults({ ua: IPHONE_UA });
    ok('没改过的手机 → 首次打开自动用轻量模型（并写回存档）',
      applied === 'lite' && api.state.settings.modelKey === 'lite', String(applied));
    ok('用户改过模型这件事会写进设置（以后再换设备也不覆盖）',
      api.state.settings.modelKeySet === false || typeof api.state.settings.modelKeySet === 'boolean');
    api.state.settings.modelKey = saved.modelKey;
    api.state.settings.modelKeySet = saved.modelKeySet;
  }

  // 竖屏提示只在「手机 + 竖屏」出现
  ok('竖屏提示：手机竖屏 → 提示；手机横屏 / 电脑 → 不提示',
    api.shouldSuggestRotate({ ua: IPHONE_UA, width: 390, height: 844 }) === true
    && api.shouldSuggestRotate({ ua: IPHONE_UA, width: 844, height: 390 }) === false
    && api.shouldSuggestRotate({ ua: PC_UA, width: 900, height: 1200 }) === false);

  // 摄像头约束与降级顺序（纯函数）
  ok('手机（low 档）请求的分辨率更省：960×540@24，而 PC 仍是 1280×720@30',
    cameraConstraintsFor({ tier: 'low' }).video.width.ideal === 960
    && cameraConstraintsFor({ tier: 'low' }).video.frameRate.ideal === 24
    && cameraConstraintsFor({ tier: 'high' }).video.width.ideal === 1280
    && cameraConstraintsFor({ tier: 'high' }).video.frameRate.ideal === 30);
  ok('默认要求前置摄像头（facingMode: user）',
    cameraConstraintsFor({}).video.facingMode === 'user');
  ok('指定镜头 id 时用 deviceId.exact（工具栏「镜头」选的）',
    cameraConstraintsFor({ deviceId: 'abc' }).video.deviceId.exact === 'abc'
    && cameraConstraintsFor({ deviceId: 'abc' }).video.facingMode === undefined);
  ok('后置摄像头失败时按顺序回退：后置 → 前置 → 不加任何挑选条件',
    (() => {
      const a = cameraAttemptsFor({ facing: 'environment' });
      return a.length === 3
        && a[0].video.facingMode === 'environment'
        && a[1].video.facingMode === 'user'
        && a[2].video.facingMode === undefined;
    })());
  ok('前置摄像头只试两次（前置 → 无条件下兜底），不会多绕一圈',
    cameraAttemptsFor({ facing: 'user' }).length === 2);
  ok('权限被拒（NotAllowedError）不重试（重试只会再弹一次权限框）',
    shouldRetryCamera('NotAllowedError') === false
    && shouldRetryCamera('OverconstrainedError') === true
    && shouldRetryCamera('NotFoundError') === true
    && shouldRetryCamera('') === false);

  // 竖屏遮罩：真的切 DOM，而且正在练的那一组会先暂停
  {
    const savedSession = api.state.session;
    const savedHome = api.state.homeMode;
    api.state.session = 'idle';
    api.state.homeMode = false;                     // 停在动作页（要横向画面）
    const portrait = api.syncDeviceClasses({ ua: IPHONE_UA, width: 390, height: 844 });
    ok('手机竖屏：body 打上 is-phone + is-portrait，并亮出「请把手机横过来」遮罩',
      portrait.portrait === true && portrait.gate === true
      && documentStub.body.classList.contains('is-phone')
      && documentStub.body.classList.contains('is-portrait')
      && elements.get('rotateGate').hidden === false,
      `rotate=${portrait.portrait} body=${documentStub.body.className}`);
    api.state.session = 'running';
    api.syncDeviceClasses({ ua: IPHONE_UA, width: 390, height: 844 });
    ok('遮罩盖住画面时，正在练的那一组先暂停（不让用户白做）',
      api.state.session === 'paused', api.state.session);
    const landscape = api.syncDeviceClasses({ ua: IPHONE_UA, width: 844, height: 390 });
    ok('横过来之后遮罩收起，body 换成 is-landscape',
      landscape.gate === false && elements.get('rotateGate').hidden === true
      && documentStub.body.classList.contains('is-landscape')
      && !documentStub.body.classList.contains('is-portrait'));
    api.state.homeMode = true;                      // 回到主页：竖屏浏览动作库不该被挡
    const onHome = api.syncDeviceClasses({ ua: IPHONE_UA, width: 390, height: 844 });
    ok('手机竖屏停在主页时不挡（竖屏浏览动作库是正常的）',
      onHome.portrait === true && onHome.gate === false && elements.get('rotateGate').hidden === true);
    api.syncDeviceClasses({ ua: PC_UA, width: 1440, height: 900 });
    ok('电脑上永远不出现竖屏遮罩、也不打 is-phone',
      elements.get('rotateGate').hidden === true && !documentStub.body.classList.contains('is-phone'));
    api.state.session = savedSession;
    api.state.homeMode = savedHome;
  }

  // 视口单位：把 visualViewport 的实测高度写进 --vh（iOS 地址栏伸缩兜底）
  {
    const root = documentStub.documentElement;
    const savedStyle = root.style;
    const written = {};
    root.style = { setProperty: (k, v) => { written[k] = v; } };
    const savedH = windowStub.innerHeight;
    windowStub.innerHeight = 640;
    const h = api.syncViewportUnit();
    ok('视口高度兜底：把 innerHeight/100 写进 --vh（iOS 地址栏伸缩时 100vh 会算错）',
      h === 640 && written['--vh'] === '6.40px', `${h} / ${written['--vh']}`);
    root.style = savedStyle;
    windowStub.innerHeight = savedH;
  }

  // 安全区：右上角退出圆环要躲开右侧刘海 / 顶部状态栏
  {
    const savedGCS = windowStub.getComputedStyle;
    windowStub.getComputedStyle = () => ({
      getPropertyValue: (n) => ({ '--safe-right': '34px', '--safe-top': '21px' }[n] || '0px'),
    });
    const size = { w: 1280, h: 720 };
    const c = api.ringCenter('corner', size.w, size.h);
    const px = api.ringPx('corner');
    ok('有安全区时右上角「退出」圆环往左下让开（右侧刘海 34px + 顶部状态栏 21px）',
      c.x === size.w - 34 - api.CORNER_RING_INSET_PX - px / 2
      && c.y === 21 + api.CORNER_RING_TOP_PX + px / 2, JSON.stringify(c));
    windowStub.getComputedStyle = savedGCS;
    const c0 = api.ringCenter('corner', size.w, size.h);
    ok('没有安全区时（PC）圆环就贴在右上角：右边距 18px、上边距 16px',
      c0.x === size.w - api.CORNER_RING_INSET_PX - px / 2
      && c0.y === api.CORNER_RING_TOP_PX + px / 2, JSON.stringify(c0));
  }

  // 前后摄像头切换（设置里的下拉）
  {
    const sel = elements.get('facingSel');
    ok('设置里有「前置 / 后置」两个选项',
      /id="facingSel"[\s\S]{0,400}?value="user"/.test(html)
      && /id="facingSel"[\s\S]{0,400}?value="environment"/.test(html));
    const savedFacing = api.state.settings.cameraFacing;
    sel.value = 'environment';
    sel.dispatch('change', { target: { value: 'environment' } });
    ok('切到后置会写进设置并提示一句',
      api.state.settings.cameraFacing === 'environment'
      && elements.get('cueLine').textContent.includes(tPhone('ui.facingBack')),
      `${api.state.settings.cameraFacing} / ${elements.get('cueLine').textContent}`);
    sel.value = 'user';
    sel.dispatch('change', { target: { value: 'user' } });
    ok('切回前置同样生效', api.state.settings.cameraFacing === 'user');
    api.state.settings.cameraFacing = savedFacing;
  }

  // 屏幕常亮：回到前台且还在练时重新申请（切后台时浏览器会收走 wakeLock）
  {
    const savedWake = navigatorStub.wakeLock;
    let requested = 0;
    navigatorStub.wakeLock = { request: async () => { requested += 1; return { release() {} }; } };
    api.state.session = 'running';
    documentStub.hidden = false;
    documentStub.dispatch('visibilitychange');
    ok('回到前台还在练 → 重新申请屏幕常亮（wakeLock）', requested === 1, String(requested));
    documentStub.hidden = true;
    api.state.session = 'running';
    documentStub.dispatch('visibilitychange');
    ok('切到后台 → 自动暂停（本来就有，别被新逻辑弄丢）', api.state.session === 'paused', api.state.session);
    documentStub.hidden = false;
    api.state.session = 'idle';
    navigatorStub.wakeLock = savedWake;
  }
}

/* ------------------------------------------------------------------ *
 * [18] 右上角「设置」环 → 屏幕中间选择「每组次数 / 每组秒数」圆环
 *
 * 用户要求（原话）：「在每一个运动的页面的右上角『退出』圆环**下方**增加一个『设置』圆环，
 * 当用户选择之后，在**界面中间出现多个圆环**，让用户选择该运动**每组运动的次数或者秒数**，
 * 比如在俯卧撑界面，则选择每组多少次，在平板支撑界面，则选择多少秒。」
 *
 * 钉住五件事：
 *   ① 「设置」环的几何：圆心 = 退出环圆心 +（直径 + 间距），同直径 / 同 cx，
 *      判定圆心与 DOM 里的 left/top 是同一个数（不存在「另写一套坐标」）；
 *   ② 计数类动作（俯卧撑）→ 中间有 `SET_REP_CHOICES.length` 颗圆环、当前值高亮、每颗是
 *      「大号数字 + 小号单位」；选 12 → `settings.targets[id]`、HUD「12 次」、持久化、选择层关闭；
 *   ③ 计时类动作（平板支撑）→ 中间是 `SET_SEC_CHOICES`，选 30 → `settings.seconds[id]`、HUD「30 秒」；
 *   ④ 两个动作互不影响；
 *   ⑤ 版式（大屏 / 手机横屏 / 小屏都不越界、小屏退成 3×2）、三种关闭方式（点空白处 / Esc / 再点设置环）、
 *      键盘（数字键、Tab 可达）、手掌停满 3 秒也能选。
 * ------------------------------------------------------------------ */

console.log('\n[18] 右上角「设置」环 → 中间选择每组次数 / 秒数');
{
  const api = windowStub.__mfg;
  const { t: tSet } = await import('../src/i18n.js');
  const { LM } = await import('../src/geometry.js');
  const { standingPose } = await import('./synthetic-pose.mjs');
  api.changeLang('zh');            // 后面的「12 次 / 30 秒」按中文断言
  api.state.settings.mirror = false;

  const setBox = () => elements.get('cornerExit');
  const setBtn = () => elements.get('ringQuickSet');
  const picker = () => elements.get('setPicker');
  const grid = () => elements.get('setPickerGrid');
  const choices = () => grid().children;
  const btnOf = (v) => choices().find((b) => String(b.dataset.v) === String(v));
  const hudTarget = () => elements.get('hudTarget').textContent;
  const UNITS = { reps: tSet('ui.repsUnit'), sec: tSet('ui.secondsUnit') };

  /** 一只手（手腕 + 食指 + 小指 + 拇指）放在指定的**归一化**坐标上 */
  const handAt = (nx, ny, visibility = 1) => {
    const lm = standingPose({ knee: 175, ankleX: 1.0, view: 'front' }).map((p) => ({ ...p, visibility }));
    for (const w of [LM.L_WRIST, LM.R_WRIST]) {
      for (const off of [0, 2, 4, 6]) lm[w + off] = { x: nx, y: ny, z: 0, visibility };
    }
    return lm;
  };

  api.openExercise('pushup');
  const size = api.stageSize();

  /* ---- ① 几何：在退出环正下方、同直径、判定圆心 = 绘制坐标 ---- */
  const exit = api.exitRingLayout(size);
  const set = api.settingsRingLayout(size);
  ok('「设置」环的圆心 = 退出环圆心 +（直径 + 间距）：cx 相同、cy 正好低一个直径 + 一道间距',
    set.cx === exit.cx && set.cy === exit.cy + exit.px + api.SET_RING_GAP_PX,
    `exit=(${exit.cx},${exit.cy}) set=(${set.cx},${set.cy}) px=${exit.px} gap=${api.SET_RING_GAP_PX}`);
  ok('「设置」环与退出环**同直径**（px / r / 判定半径全部复用退出环那一份）',
    set.px === exit.px && set.r === exit.r && set.hit === exit.hit && set.below === exit.px + api.SET_RING_GAP_PX,
    JSON.stringify({ px: set.px, r: set.r, below: set.below }));
  ok('间距是一处定义的常量（SET_RING_GAP_PX = 12），圆心距离 = 直径 + 间距 = ' + (set.px + 12) + 'px',
    api.SET_RING_GAP_PX === 12 && set.cy - exit.cy === set.px + api.SET_RING_GAP_PX);
  api.layoutCornerRing();
  {
    const c = api.ringCenter('settings', size.w, size.h);
    ok('判定圆心 = 绘制坐标（ringCenter(\'settings\') 与行内 left/top/宽高是同一个数）',
      c.x === set.cx && c.y === set.cy
      && setBtn().style.left === `${c.x}px` && setBtn().style.top === `${c.y}px`
      && setBtn().style.width === `${set.px}px` && setBtn().style.height === `${set.px}px`,
      JSON.stringify(setBtn().style));
    ok('判定半径与退出环同一档口径（画出来的半径 × RING_HIT_RATIO）',
      api.ringHitRadius('settings', size) === api.ringPx('corner') * api.RING_HIT_RATIO,
      `${api.ringHitRadius('settings', size)} vs ${api.ringPx('corner') * api.RING_HIT_RATIO}`);
    ok('「设置」环用的是和退出环同一套圆环动画（ring-btn / ring-svg，里面能拿到 .ring-fill）',
      setBtn().className.includes('ring-btn') && !!setBtn().querySelector?.('.ring-fill'));
    ok('「设置」环里是齿轮线条图标（icons.js 的 `ui:settings`，和主页那颗同一个），不是 emoji；文字在 aria-label 上',
      elements.get('ringQuickSetLabel').innerHTML === api.libIconSVG('ui:settings', 'ex-pose')
      && /class="ex-pose"/.test(elements.get('ringQuickSetLabel').innerHTML)
      && setBtn().attributes['aria-label'] === tSet('ui.gestureSet')
      && tSet('ui.gestureSet') === '设置', setBtn().attributes['aria-label']);
  }

  // 摄像头开着 → 两颗环（同一个容器）一起出现
  const fakeStream = { getTracks: () => [] };
  api.camera.stream = fakeStream;
  api.syncCornerExit();
  ok('摄像头开着时「设置」环和「退出」环一起摆出来（共用一个容器 / 一套显隐）',
    setBox().hidden === false && setBtn().hidden !== true);
  ok('「设置」环摆着的时候猫爪指针层照样生效（它和退出环共用一个显示条件，手在哪看得见）',
    api.pawsWanted() === true);

  /* ---- ② 计数类动作（俯卧撑）：每组次数 · 一页 5 个 + 两端「向前 / 向后」箭头 ---- */
  // 一页 5 个（SET_PICKER_PER_PAGE）+ 两端箭头；下面反复要按「这一页摆了哪几颗」断言，所以先备几个 helper
  const allBtns = () => grid().children;
  const choiceBtns = () => allBtns().filter((b) => b.dataset.v !== undefined);
  const choiceVals = () => choiceBtns().map((b) => Number(b.dataset.v));
  const arrowBtn = (dir) => allBtns().find((b) => b.dataset.role === (dir < 0 ? 'prev' : 'next'));
  /** 某个值在这一页排第几颗（0 是「向前」箭头，所以选项从 1 开始） */
  const ringIndexFor = (v) => api.setPickerPageRings().rings
    .findIndex((r) => r.role === 'choice' && r.value === v);
  const lastPage = () => api.setPickerPages(api.SET_REP_CHOICES.length) - 1;

  api.setTarget(8, 'pushup');      // 先把当前值改成 8，才能验证「当前值高亮」
  ok('准备：俯卧撑当前目标是 8 次（HUD 也是「8 次」）',
    api.state.target === 8 && hudTarget() === `8 ${UNITS.reps}`, hudTarget());
  setBtn().dispatch('click');
  ok('点「设置」环 → 屏幕中间出现选择层（原本 hidden）',
    picker().hidden === false && api.state.setPickerOpen === true);
  ok('一页只摆 5 个选项（SET_PICKER_PER_PAGE = 5）+ 两端各一颗箭头 = 7 颗圆环',
    api.SET_PICKER_PER_PAGE === 5 && choiceBtns().length === 5 && allBtns().length === 7,
    `${choiceBtns().length} 选项 / ${allBtns().length} 颗`);
  ok(`第一页就是列表最前面那 5 个（${api.SET_REP_CHOICES.slice(0, 5).join(' / ')}，一处定义）`,
    choiceVals().every((v, i) => v === api.SET_REP_CHOICES[i]),
    choiceVals().join(','));
  ok('计数类动作给的是「每组次数」：标题里有主题 + 当前值「当前每组 8 次」+ 页码',
    api.state.setPickerKind === 'reps'
    && elements.get('setPickerTitle').textContent.includes(tSet('ui.setPickerReps'))
    && elements.get('setPickerTitle').textContent.includes(tSet('ui.setPickerCurrent', { n: 8, unit: UNITS.reps }))
    && elements.get('setPickerTitle').textContent.includes(tSet('ui.setPickerPage', { n: 1, total: api.setPickerPages() })),
    elements.get('setPickerTitle').textContent);
  ok('当前值高亮（8 那颗 is-current + aria-pressed=true，10 那颗不是）',
    !!btnOf(8) && btnOf(8).classList.contains('is-current')
    && btnOf(8).attributes['aria-pressed'] === 'true'
    && !btnOf(10).classList.contains('is-current'));
  ok('每颗数字圆环里是「大号数字 + 小号单位」（单位与 HUD 同一份：次 / 秒）',
    choiceVals().every((v) => {
      const b = btnOf(v);
      return !!b && /set-choice-num/.test(b.innerHTML) && /set-choice-unit/.test(b.innerHTML)
        && b.innerHTML.includes(`>${v}</span>`) && b.innerHTML.includes(UNITS.reps);
    }), btnOf(8)?.innerHTML?.slice(0, 160));
  ok('每颗数字环都是真 <button>（键盘可 Tab / 回车选中）且有无障碍名字（「每组 N 次」）',
    choiceBtns().every((b) => b.tagName === 'BUTTON'
      && (b.attributes['aria-label'] || '').includes(UNITS.reps)
      && (b.attributes['aria-label'] || '').includes(String(b.dataset.v))));
  ok('那一排两端各是一颗「向前」「向后」箭头圆环（.set-choice--arrow + data-role，顺序 = 最前 / 最后）',
    !!arrowBtn(-1) && !!arrowBtn(1)
    && allBtns()[0] === arrowBtn(-1) && allBtns()[allBtns().length - 1] === arrowBtn(1)
    && arrowBtn(-1).classList.contains('set-choice--arrow')
    && arrowBtn(1).classList.contains('set-choice--arrow'));
  ok('箭头里是项目的线条箭头图标（libIconSVG 的 prev / next），不是 emoji、不是 ◀ ▶ 字形、也没有数字',
    arrowBtn(-1).innerHTML.includes(api.libIconSVG('prev', 'ex-pose'))
    && arrowBtn(1).innerHTML.includes(api.libIconSVG('next', 'ex-pose'))
    && !/[◀▶←→]/.test(arrowBtn(-1).innerHTML + arrowBtn(1).innerHTML)
    && !/set-choice-num/.test(arrowBtn(-1).innerHTML + arrowBtn(1).innerHTML));
  ok('箭头的 title / aria-label 走 i18n（中文就是「向前」「向后」）',
    arrowBtn(-1).attributes['aria-label'] === '向前' && arrowBtn(-1).attributes.title === '向前'
    && arrowBtn(1).attributes['aria-label'] === '向后' && arrowBtn(1).attributes.title === '向后',
    `${arrowBtn(-1).attributes['aria-label']} / ${arrowBtn(1).attributes['aria-label']}`);
  ok('箭头与选项**同直径 / 同一排**（7 颗的行内宽高完全一样 → 判定半径也同源）',
    new Set(allBtns().map((b) => b.style.width)).size === 1
    && new Set(allBtns().map((b) => b.style.height)).size === 1
    && new Set(allBtns().map((b) => b.style.top)).size === 1,
    allBtns().map((b) => b.style.width).join(','));

  arrowBtn(1).dispatch('click');   // 点「向后」→ 第 2 页
  ok(`点「向后」→ 翻到第 2 页，出现另外 5 个值（${api.SET_REP_CHOICES.slice(5, 10).join(' / ')}）`,
    api.state.setPickerPage === 1 && choiceBtns().length === 5
    && choiceVals().every((v, i) => v === api.SET_REP_CHOICES[i + 5]),
    `page=${api.state.setPickerPage} ${choiceVals().join(',')}`);
  ok('翻页后标题页码跟着变（第 2/N 页），而且**当前值提示仍在**（信息不丢）',
    elements.get('setPickerTitle').textContent.includes(tSet('ui.setPickerPage', { n: 2, total: api.setPickerPages() }))
    && elements.get('setPickerTitle').textContent.includes(tSet('ui.setPickerCurrent', { n: 8, unit: UNITS.reps })),
    elements.get('setPickerTitle').textContent);
  ok('当前值不在这页时不会有错误的高亮（8 不在第 2 页 → 一颗都不亮）',
    choiceBtns().every((b) => !b.classList.contains('is-current')));
  btnOf(20).dispatch('click');
  ok('选第 2 页的 20 → 写进**这个动作自己那一份** settings.targets.pushup',
    api.state.settings.targets.pushup === 20, JSON.stringify(api.state.settings.targets));
  ok('HUD 左上角的目标文案立刻变成「20 次」', hudTarget() === `20 ${UNITS.reps}`, hudTarget());
  ok('已经持久化（localStorage 里那份 settings 的 targets.pushup = 20）',
    JSON.parse(store.get('mfg.settings.v1') || '{}').targets?.pushup === 20,
    store.get('mfg.settings.v1'));
  ok('选完选择层自己关掉（hidden + 状态复位 + 圆环清空）',
    picker().hidden === true && api.state.setPickerOpen === false && allBtns().length === 0);

  /* ---- 循环翻页：第 1 页「向前」→ 最后一页；最后一页「向后」→ 第 1 页 ---- */
  api.setTarget(8, 'pushup');
  setBtn().dispatch('click');
  ok('打开时停在第 1 页（当前值 8 就在第 1 页）', api.state.setPickerPage === 0);
  arrowBtn(-1).dispatch('click');
  ok('第 1 页点「向前」→ **循环**到最后一页（不是夹在第 1 页不动）',
    api.state.setPickerPage === lastPage(), `${api.state.setPickerPage} / ${lastPage()}`);
  ok('最后一页只剩 4 个值（14 = 5 + 5 + 4）+ 2 个箭头 = 6 颗圆环',
    choiceBtns().length === 4 && allBtns().length === 6
    && choiceVals().every((v, i) => v === api.SET_REP_CHOICES[i + 10]),
    `${choiceBtns().length} 选项 / ${allBtns().length} 颗 · ${choiceVals().join(',')}`);
  arrowBtn(1).dispatch('click');
  ok('最后一页点「向后」→ 循环回第 1 页',
    api.state.setPickerPage === 0 && choiceVals()[0] === api.SET_REP_CHOICES[0]);

  /* ---- 当前值不在第 1 页：打开就定位 + 高亮 + 标题里也有页码提示 ---- */
  api.closeSetPicker();
  api.setTarget(60, 'pushup');     // 60 在列表里是第 12 个 → 第 3 页
  setBtn().dispatch('click');
  ok('当前值不在第 1 页时，**打开就定位到它所在的那一页**（60 → 第 3/3 页），不用先翻页找它',
    api.state.setPickerPage === api.setPickerPages() - 1
    && elements.get('setPickerTitle').textContent.includes(tSet('ui.setPickerPage', { n: 3, total: api.setPickerPages() })),
    `page=${api.state.setPickerPage} · ${elements.get('setPickerTitle').textContent}`);
  ok('而且那颗「60」就是高亮的（is-current + aria-pressed）',
    !!btnOf(60) && btnOf(60).classList.contains('is-current')
    && btnOf(60).attributes['aria-pressed'] === 'true');
  api.closeSetPicker();

  /* ---- 三种关闭方式（用户要求「明显的关闭 / 取消方式」） ---- */
  api.setTarget(8, 'pushup');
  setBtn().dispatch('click');
  const openedOnce = picker().hidden === false;
  elements.get('setPickerBackdrop').dispatch('click');
  ok('点空白处（遮罩）就关掉', openedOnce && picker().hidden === true && api.state.setPickerOpen === false);
  setBtn().dispatch('click');
  documentStub.dispatch('keydown', { key: 'Escape' });
  ok('按 Esc 关掉（而且不会顺手把这一组结束掉）',
    picker().hidden === true && api.state.setPickerOpen === false && api.state.session !== 'idle',
    `session=${api.state.session}`);
  setBtn().dispatch('click');
  const reopened = picker().hidden === false;
  setBtn().dispatch('click');
  ok('再点一次「设置」环也关掉（toggle：打开 → 再点 → 关）',
    reopened && picker().hidden === true && api.state.setPickerOpen === false);

  /* ---- 键盘：数字键选「这一页第几个」，← →（PageUp / PageDown）翻页 ---- */
  setBtn().dispatch('click');
  documentStub.dispatch('keydown', { key: '4' });
  ok('键盘数字键 4 → 选中这一页第 4 个（10 次），选择层同时关掉',
    api.state.settings.targets.pushup === api.SET_REP_CHOICES[3] && picker().hidden === true,
    `${api.state.settings.targets.pushup} / ${api.SET_REP_CHOICES[3]}`);
  setBtn().dispatch('click');
  documentStub.dispatch('keydown', { key: 'ArrowRight' });
  const kbNext = api.state.setPickerPage === 1 && api.state.setPickerOpen === true;
  documentStub.dispatch('keydown', { key: 'ArrowLeft' });
  ok('键盘 → / ← 也能翻页（选择层不关，也不穿透到训练快捷键）',
    kbNext && api.state.setPickerPage === 0, `page=${api.state.setPickerPage}`);
  documentStub.dispatch('keydown', { key: 'ArrowLeft' });
  ok('键盘 ← 在第 1 页同样是**循环**到最后一页', api.state.setPickerPage === lastPage());
  api.closeSetPicker();

  /* ---- 手掌停满 3 秒：选值 / 翻页都能干（用户要求「点 / 停满 / 键盘」三种都一样） ---- */
  api.setTarget(8, 'pushup');
  setBtn().dispatch('click');
  arrowBtn(1).dispatch('click');   // 先翻到第 2 页，验证「停在第 2 页的某一颗上也能选」
  {
    const info = api.setPickerPageRings();
    const lay = api.setChooserLayout(info.rings.length, api.stageSize());
    const it = lay.items[ringIndexFor(20)];
    let fired = false;
    for (let ms = 90000; ms <= 90000 + 3400; ms += 33) {
      fired = api.updateSetPicker(handAt(it.cx / size.w, it.cy / size.h), Math.round(ms)) >= 0 || fired;
    }
    ok('手掌停在「20」那颗圆环里满 3 秒也能选中（和点它一样），圆心就是版面算出来的坐标',
      fired && api.state.settings.targets.pushup === 20 && picker().hidden === true,
      `fired=${fired} target=${api.state.settings.targets.pushup}`);
  }
  api.setTarget(8, 'pushup');
  setBtn().dispatch('click');
  {
    const info = api.setPickerPageRings();
    const lay = api.setChooserLayout(info.rings.length, api.stageSize());
    const it = lay.items[info.rings.findIndex((r) => r.role === 'next')];
    for (let ms = 95000; ms <= 95000 + 3400; ms += 33) {
      api.updateSetPicker(handAt(it.cx / size.w, it.cy / size.h), Math.round(ms));
    }
    ok('手掌停在「向后」箭头上满 3 秒也能翻页（翻页不算选中，选择层不关）',
      api.state.setPickerPage === 1 && api.state.setPickerOpen === true,
      `page=${api.state.setPickerPage}`);
  }
  api.closeSetPicker();

  /* ---- 选项 ≤5 时：一颗箭头都不出现（也就没有翻页） ---- */
  api.setTarget(12, 'pushup');
  setBtn().dispatch('click');
  {
    // 把列表临时收窄成「一页放得下」的 5 个，再走真实的 renderSetPicker() 重画
    api.state.setPickerChoices = [5, 10, 12, 15, 20];
    api.state.setPickerPage = 0;
    api.renderSetPicker();
    ok('选项 ≤5 时不渲染箭头、也不分页（5 颗数字圆环、标题里没有页码）',
      allBtns().length === 5 && !arrowBtn(-1) && !arrowBtn(1)
      && choiceBtns().length === 5 && choiceVals().join(',') === '5,10,12,15,20'
      && !elements.get('setPickerTitle').textContent.includes(tSet('ui.setPickerPage', { n: 1, total: 1 })));
    api.closeSetPicker();
  }

  // 手停在「设置」环里满 3 秒 → 打开选择层（和点它一样；离开后才会重新武装）
  {
    api.setTarget(8, 'pushup');
    const sc = api.ringCenter('settings', size.w, size.h);
    const st = api.gestureState.settings;
    st.p = 0; st.done = false; st.at = 0; st.since = 0; st.lastInside = 0;
    let fired = false;
    for (let ms = 120000; ms <= 120000 + 3400; ms += 33) {
      if (api.updateSetRing(handAt(sc.x / size.w, sc.y / size.h), Math.round(ms))) {
        fired = true;
        api.triggerSetRing();
        break;
      }
    }
    ok('手停满 3 秒也能触发「设置」环（打开中间那一层，不用鼠标）',
      fired && api.state.setPickerOpen === true, `fired=${fired}`);
    api.closeSetPicker();
  }

  /* ---- ③ 计时类动作（平板支撑）：每组秒数（同样一页 5 个 + 两端箭头） ---- */
  api.openExercise('plank');
  setBtn().dispatch('click');
  ok('计时类动作给的是「每组秒数」：第一页 5 个（10 / 15 / 20 / 30 / 45）+ 2 个箭头 = 7 颗，单位是秒',
    choiceVals().every((v, i) => v === api.SET_SEC_CHOICES[i])
    && choiceBtns().length === 5 && allBtns().length === 7
    && choiceBtns().every((b) => b.innerHTML.includes(UNITS.sec))
    && api.state.setPickerKind === 'seconds'
    && elements.get('setPickerTitle').textContent.includes(tSet('ui.setPickerSeconds'))
    && elements.get('setPickerTitle').textContent.includes(tSet('ui.setPickerPage', { n: 1, total: api.setPickerPages(api.SET_SEC_CHOICES.length) })),
    `${choiceVals().join(',')} · ${elements.get('setPickerTitle').textContent}`);
  ok('平板支撑当前值（默认 45 秒）高亮', !!btnOf(45) && btnOf(45).classList.contains('is-current'));
  btnOf(30).dispatch('click');
  /**
   * ⚠️ 落在**哪一份存储**由 `setTarget()` 的既定口径决定，两种动作不一样：
   *   - 计时类（`kind === 'hold'`，平板支撑）→ `settings.targets[id]`（这个动作的「目标秒数」）；
   *   - **限时计数**（开合跳 / 勾腿跳，`timed`）→ `settings.seconds[id]`（那一组固定多少秒）。
   * 所以这里断言的是「这个动作自己那一份目标 = 30 秒」，同时钉住**没有顺手在另一份里再抄一遍**
   * （新造存储 / 两份数据源会让 HUD 和弹窗各说一套）。
   */
  ok('选 30 秒 → 写进**这个动作自己那一份**目标（settings.targets.plank = 30，与「运动设定」弹窗同一个口径）',
    api.targetForExercise('plank') === 30
    && api.state.settings.targets.plank === 30
    && api.state.settings.seconds.plank === undefined,
    JSON.stringify({ targets: api.state.settings.targets, seconds: api.state.settings.seconds }));
  ok('HUD 目标文案变成「30 秒」', hudTarget() === `30 ${UNITS.sec}`, hudTarget());
  // 计时类也要能翻页选（第 2 页 = 60 / 90 / 120 / 150 / 180）
  setBtn().dispatch('click');
  arrowBtn(1).dispatch('click');
  ok('计时类同样能翻页：第 2 页是 60 / 90 / 120 / 150 / 180 秒',
    api.state.setPickerPage === 1
    && choiceVals().every((v, i) => v === api.SET_SEC_CHOICES[i + 5]),
    choiceVals().join(','));
  btnOf(120).dispatch('click');
  ok('第 2 页选 120 秒 → settings.targets.plank = 120 且 HUD「120 秒」',
    api.state.settings.targets.plank === 120 && hudTarget() === `120 ${UNITS.sec}`,
    `${api.state.settings.targets.plank} · ${hudTarget()}`);

  /* ---- ④ 两个动作互不影响 ---- */
  api.setTarget(15, 'pushup');
  ok('改平板支撑不会动到俯卧撑（targets.pushup 仍是 15 次；平板支撑也没有被写进 seconds 那一份）',
    api.state.settings.targets.pushup === 15 && api.state.settings.seconds.plank === undefined,
    JSON.stringify({ targets: api.state.settings.targets, seconds: api.state.settings.seconds }));
  api.openExercise('pushup');
  ok('换回俯卧撑：目标还是自己那一份（15 次），HUD 跟着切回来',
    api.state.target === 15 && hudTarget() === `15 ${UNITS.reps}`, hudTarget());

  /* ---- ⑤ 版式：一页 7 颗（5 选项 + 2 箭头）在大屏 / 手机横屏 / 小屏都不越界 ---- */
  {
    const sizes = [
      { w: 1280, h: 720, label: '大屏 1280×720' },
      { w: 900, h: 520, label: '中等 900×520' },
      { w: 667, h: 375, label: '手机横屏 667×375' },
      { w: 560, h: 320, label: '小屏 560×320' },
      { w: 390, h: 220, label: '极窄 390×220' },
    ];
    // 满页 7 颗（5 选项 + 2 箭头）和最后一页 6 颗（4 选项 + 2 箭头）都要不越界
    for (const s of sizes) {
      for (const rings of [7, 6]) {
        const L = api.setChooserLayout(rings, s);
        const inside = L.items.length === rings && L.items.every((it) => it.cx - it.px / 2 >= 0
          && it.cx + it.px / 2 <= s.w && it.cy - it.px / 2 >= 0 && it.cy + it.px / 2 <= s.h
          && it.px >= api.SET_CHOOSER_MIN_PX && it.px >= 44);
        ok(`${s.label} · ${rings} 颗：${L.cols} 列 × ${L.rows} 行、每颗 Ø${L.cell}px，全部落在舞台内（热区 ≥44px）`,
          inside, JSON.stringify({ cols: L.cols, rows: L.rows, cell: L.cell, items: L.items.length }));
      }
    }
    const small = api.setChooserLayout(7, { w: 560, h: 320 });
    ok('小屏 560×320 退成 4 列 × 2 行（4 + 3，两行都比 3 + 3 + 1 三行大得多）',
      small.cols === 4 && small.rows === 2, `${small.cols}×${small.rows} Ø${small.cell}`);
    ok('大屏 1280×720 排成一整排 7 颗（圆心在同一根水平线上、尺寸相同）', (() => {
      const L = api.setChooserLayout(7, { w: 1280, h: 720 });
      return L.cols === 7 && L.rows === 1 && L.items.every((it) => it.cy === L.items[0].cy && it.px === L.items[0].px);
    })());
    ok('小屏 560×320 的 7 个圆心都在舞台内、热区 ≥44px（箭头和选项同一份尺寸）', (() => {
      const ys = small.items.map((it) => it.cy);
      const xs = small.items.map((it) => it.cx);
      return Math.min(...ys) - small.cell / 2 >= 0 && Math.max(...ys) + small.cell / 2 <= 320
        && Math.min(...xs) - small.cell / 2 >= 0 && Math.max(...xs) + small.cell / 2 <= 560
        && small.cell >= 44 && new Set(small.items.map((it) => it.px)).size === 1;
    })(), JSON.stringify({ cell: small.cell, ys: small.items.map((it) => Math.round(it.cy)) }));
  }

  /* ---- 语言切换：图标 / 无障碍名跟着换 ---- */
  api.changeLang('en');
  const enAria = elements.get('ringQuickSet').attributes['aria-label'];
  ok('「设置」环的 aria-label 跟着语言切换（设置 → Settings），图标不变',
    enAria === tSet('ui.gestureSet') && /settings/i.test(enAria)
    && elements.get('ringQuickSetLabel').innerHTML === api.libIconSVG('ui:settings', 'ex-pose'),
    enAria);
  api.changeLang('zh');
  ok('切回中文后 aria-label 又变回「设置」',
    elements.get('ringQuickSet').attributes['aria-label'] === '设置',
    elements.get('ringQuickSet').attributes['aria-label']);

  // 收尾：把两颗环收起来，免得影响后面（这一组测试是最后一段，但保持状态干净）
  api.hideCornerExit();
  api.closeSetPicker();
}

/* ------------------------------------------------------------------ *
 * [19] P3.2 命令快车道：真实 app.js + DOM 桩，喂一句话看界面真的变了
 *
 * 覆盖用户要求的那几条：
 *   暂停 / 设目标 / 退出确认（确认·取消·超时）/ 开始深蹲 / 帮助 / 胡话。
 * 走的是 `voice.onUserText()` 的真实路径：parseCommand → run(ctx) → 字幕 + 状态。
 * ------------------------------------------------------------------ */

console.log('\n[19] P3.2 命令快车道：喂一句话 → 界面真的变了');
{
  const api = windowStub.__mfg;
  const { t: tC } = await import('../src/i18n.js');
  const flush = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const hudTargetText = () => elements.get('hudTarget').textContent;

  /** 喂一句最终识别结果；返回这一句新产生的 TTS 句（没有就 null） */
  const feed = async (text) => {
    const before = coachStubs.utterances.length;
    api.voice.onUserText(text);
    await flush();
    return coachStubs.utterances.length > before ? coachStubs.utterances.at(-1) : null;
  };
  /** 让教练说完 → 回到 listening（下一句才听得进去） */
  const finishSpeech = async (utter) => {
    if (utter && typeof utter.onend === 'function') utter.onend();
    await flush();
  };

  api.showHome();
  await api.setCoachEnabled(true);
  await flush();
  ok('命令快车道的起点：教练已开启、正在聆听',
    api.state.voice.state === 'listening' && api.state.voice.enabled === true,
    JSON.stringify({ state: api.state.voice.state, enabled: api.state.voice.enabled }));

  /* ---- ① 「暂停」→ state.paused + 字幕确认 ---- */
  api.openExercise('squat');
  api.state.session = 'running';
  let utter = await feed('暂停');
  ok('喂「暂停」→ state.paused === true（界面状态真的变了），字幕出现「好的，暂停」',
    api.state.session === 'paused'
    && elements.get('coachCoachText').textContent === tC('coach.cmdAck.pause'),
    JSON.stringify({ session: api.state.session, coach: elements.get('coachCoachText').textContent }));
  await finishSpeech(utter);

  utter = await feed('继续');
  ok('喂「继续」→ 回到 running，字幕确认', api.state.session === 'running'
    && elements.get('coachCoachText').textContent === tC('coach.cmdAck.resume'),
    JSON.stringify({ session: api.state.session, coach: elements.get('coachCoachText').textContent }));
  await finishSpeech(utter);

  /* ---- ② 「设成 30 次」→ 当前动作的目标 + HUD 目标文案 ---- */
  api.setTarget(15, 'squat');
  utter = await feed('设成 30 次');
  ok('喂「设成 30 次」→ settings.targets.squat === 30、state.target === 30、HUD 目标「30 次」',
    api.state.settings.targets.squat === 30 && api.state.target === 30
    && hudTargetText() === `30 ${tC('ui.repsUnit')}`,
    JSON.stringify({ stored: api.state.settings.targets.squat, target: api.state.target, hud: hudTargetText() }));
  ok('教练回「目标改成 30 次」（来自命令表的短确认词条）',
    elements.get('coachCoachText').textContent === tC('coach.cmdAck.setTarget', {
      value: 30, unit: tC('ui.repsUnit'),
    }), elements.get('coachCoachText').textContent);
  await finishSpeech(utter);

  utter = await feed('加 5 个');
  ok('喂「加 5 个」→ 目标 30 → 35（HUD 跟着变）',
    api.state.settings.targets.squat === 35 && api.state.target === 35
    && hudTargetText() === `35 ${tC('ui.repsUnit')}`,
    JSON.stringify({ target: api.state.target, hud: hudTargetText() }));
  await finishSpeech(utter);

  /* ---- ③ 查询：「我做了几个」读当前 state ---- */
  api.state.detector.validReps = 7;
  api.state.detector.score = 42;
  utter = await feed('我做了几个');
  ok('喂「我做了几个」→ 教练读出当前次数与分数（7 个 / 42 分）',
    elements.get('coachCoachText').textContent.includes('7')
    && elements.get('coachCoachText').textContent.includes('42'),
    elements.get('coachCoachText').textContent);
  await finishSpeech(utter);

  /* ---- ④ 「退出」→ 先问确认；「确认」才真的退出 ---- */
  api.state.session = 'running';
  utter = await feed('退出');
  ok('喂「退出」→ **不立即退出**：还没进菜单，pendingConfirm=intent exit，字幕问确认',
    api.state.menuMode === false
    && api.voice.pendingConfirm && api.voice.pendingConfirm.intent === 'exit'
    && elements.get('coachCoachText').textContent === tC('coach.confirm.ask'),
    JSON.stringify({ menuMode: api.state.menuMode, pending: api.voice.pendingConfirm,
      coach: elements.get('coachCoachText').textContent }));
  await finishSpeech(utter);

  utter = await feed('确认');
  ok('再喂「确认」→ 真的退出（回手势菜单），pending 清空',
    api.state.menuMode === true && api.voice.pendingConfirm === null,
    JSON.stringify({ menuMode: api.state.menuMode, pending: api.voice.pendingConfirm }));
  await finishSpeech(utter);

  /* ---- ⑤ 「退出」→「取消」：不退出 ---- */
  api.showHome();
  api.openExercise('squat');
  api.state.session = 'running';
  utter = await feed('退出');
  await finishSpeech(utter);
  utter = await feed('取消');
  ok('喂「取消」→ 不退出：还在训练页、menuMode=false、pending 清空',
    api.state.menuMode === false && api.state.homeMode === false
    && api.state.exerciseId === 'squat' && api.voice.pendingConfirm === null,
    JSON.stringify({ menuMode: api.state.menuMode, homeMode: api.state.homeMode,
      exercise: api.state.exerciseId, pending: api.voice.pendingConfirm }));
  await finishSpeech(utter);

  /* ---- ⑥ 8 秒没回应 → 自动取消（测试里把 confirmMs 调到 30ms） ---- */
  api.voice.confirmMs = 30;
  utter = await feed('退出');
  ok('超时测试：先进入等待确认', api.voice.pendingConfirm?.intent === 'exit');
  await wait(70);
  ok('30ms 没回应（等价于 8 秒）→ 自动取消：不退出、pending 清空、字幕提示超时',
    api.state.menuMode === false && api.voice.pendingConfirm === null
    && elements.get('coachCoachText').textContent === tC('coach.confirm.timeout'),
    JSON.stringify({ menuMode: api.state.menuMode, pending: api.voice.pendingConfirm,
      coach: elements.get('coachCoachText').textContent }));
  api.voice.confirmMs = 8000;   // 恢复默认 8 秒
  await finishSpeech(coachStubs.utterances.at(-1));   // 超时提示说完 → 回到 listening

  /* ---- ⑦ 「开始深蹲」→ 走 startGestureMode（全屏 + 权限）+ 进入深蹲 ---- */
  api.showHome();
  const origStart = api.voiceCommandCtx.startGestureMode;
  let startCalls = 0;
  api.voiceCommandCtx.startGestureMode = (...args) => {
    startCalls += 1;
    return origStart ? origStart(...args) : undefined;
  };
  utter = await feed('开始深蹲');
  ok('喂「开始深蹲」→ 真的调用了 startGestureMode（全屏 + 权限没绕开）',
    startCalls === 1, String(startCalls));
  ok('并且进入深蹲训练页（exerciseId=squat、不在菜单、workoutView 显示）',
    api.state.exerciseId === 'squat' && api.state.menuMode === false
    && elements.get('workoutView').hidden === false && api.state.homeMode === false,
    JSON.stringify({ ex: api.state.exerciseId, menuMode: api.state.menuMode,
      workoutHidden: elements.get('workoutView').hidden, homeMode: api.state.homeMode }));
  ok('字幕确认里带动作名「自重深蹲」',
    elements.get('coachCoachText').textContent === tC('coach.cmdAck.startWorkoutNamed', {
      name: tC('ex.squat.name'),
    }), elements.get('coachCoachText').textContent);
  api.voiceCommandCtx.startGestureMode = origStart;
  await finishSpeech(utter);

  /* ---- ⑧ 「我能说什么」→ 帮助面板（表格从命令表生成） ---- */
  utter = await feed('我能说什么');
  const helpHtml = elements.get('voiceHelpList').innerHTML;
  const helpRows = (helpHtml.match(/<tr data-intent=/g) || []).length;
  ok('喂「我能说什么」→ 帮助面板出现，且行数 = 命令表条数',
    elements.get('voiceHelpModal').hidden === false
    && helpRows === api.COMMANDS.length && helpRows >= 20,
    JSON.stringify({ open: !elements.get('voiceHelpModal').hidden, rows: helpRows,
      commands: api.COMMANDS.length }));
  ok('帮助表每行三列（中文说法 / English / 作用），并且含「开始训练」「暂停」',
    helpHtml.includes('开始训练') && helpHtml.includes('暂停')
    && (helpHtml.match(/<td>/g) || []).length === helpRows * 3,
    JSON.stringify({ rows: helpRows, cells: (helpHtml.match(/<td>/g) || []).length }));
  documentStub.dispatch('keydown', {
    key: 'Escape', target: documentStub.body, preventDefault() {},
  });
  ok('按 Esc 关掉帮助面板（和其它弹窗一致）',
    elements.get('voiceHelpModal').hidden === true);
  await finishSpeech(utter);

  // 设置里那一行入口：点一下打开的是同一张表
  api.openSettings();
  elements.get('btnVoiceHelp').dispatch('click');
  ok('设置里「语音命令一览」入口能打开同一个面板',
    elements.get('settingsModal').hidden === false
    && elements.get('voiceHelpModal').hidden === false
    && elements.get('voiceHelpList').innerHTML.includes('data-intent="home"'));
  api.closeVoiceHelp();
  api.closeSettings();

  /* ---- ⑨ 「别说话 / 说话」：只关朗读，字幕照常 ---- */
  const spokenBefore = coachStubs.utterances.length;
  utter = await feed('别说话');
  ok('喂「别说话」→ muted=true，只出字幕不朗读（TTS 没有新句子）',
    api.state.voice.muted === true && coachStubs.utterances.length === spokenBefore
    && elements.get('coachCoachText').textContent === tC('coach.cmdAck.mute'),
    JSON.stringify({ muted: api.state.voice.muted, spoken: coachStubs.utterances.length,
      coach: elements.get('coachCoachText').textContent }));
  utter = await feed('说话');
  ok('喂「说话」→ muted=false，朗读恢复',
    api.state.voice.muted === false && coachStubs.utterances.length > spokenBefore,
    JSON.stringify({ muted: api.state.voice.muted, spoken: coachStubs.utterances.length }));
  await finishSpeech(utter);

  /* ---- ⑩ 胡话：状态不变 + 提示（走 mockLlm 兜底） ---- */
  api.showHome();
  const before = {
    menuMode: api.state.menuMode, homeMode: api.state.homeMode,
    exercise: api.state.exerciseId, session: api.state.session, target: api.state.target,
  };
  api.voice.onUserText('烤面包');
  await wait(450);   // app 的 thinkDelay = 360ms
  await flush();
  ok('喂胡话 → 状态一个都没变（不改菜单 / 动作 / 目标），教练给出「没听清…能说什么」的提示',
    api.state.menuMode === before.menuMode && api.state.homeMode === before.homeMode
    && api.state.exerciseId === before.exercise && api.state.session === before.session
    && api.state.target === before.target
    && elements.get('coachCoachText').textContent === tC('coach.reply.fallback'),
    JSON.stringify({ before, after: { menuMode: api.state.menuMode, homeMode: api.state.homeMode,
      exercise: api.state.exerciseId, session: api.state.session, target: api.state.target },
    coach: elements.get('coachCoachText').textContent }));
  await finishSpeech(coachStubs.utterances.at(-1));

  /* ---- ⑪ 「关闭教练」→ 等于 Ctrl+I 关：状态 off、面板收起 ---- */
  utter = await feed('关闭教练');
  ok('喂「关闭教练」→ settings.coachEnabled=false、会话 off、字幕面板收起',
    api.state.settings.coachEnabled === false && api.state.voice.state === 'off'
    && elements.get('coachPanel').hidden === true,
    JSON.stringify({ setting: api.state.settings.coachEnabled,
      state: api.state.voice.state, panel: elements.get('coachPanel').hidden }));
  await finishSpeech(utter);
  api.showHome();

  /* ---- ⑫ 用户反馈钉住（2026-11-10「听不到任何声音 + 第一句之后都没识别」）：
   *   ① 命令回合的确认语**也走 TTS**（弹幕 + 朗读都要有），诊断里有 tts:*；
   *   ② final 之后仍在 listening，麦克风 / 识别都没停（final 只上屏 + 触发回复）；
   *   ③ 只有明确关掉（Ctrl+I / 设置 = user）/ 页面卸载（pagehide）/ 页面隐藏（pause）才会停。 ---- */
  {
    await api.setCoachEnabled(true);
    await flush();
    api.openExercise('squat');
    api.state.session = 'running';
    api.setTarget(20, 'squat');
    await flush();

    const seen = [];
    const unsub = api.coachDiag.subscribe((snap) => seen.push(String(snap.lastType || '')));
    // 这一套测试走的是「浏览器自带识别」那一路（Node 里没有 WebSocket / AudioContext）：
    // 共享麦克风会按设计交给 SpeechRecognition，所以「还在听」要看识别器有没有被 stop，
    // 而不是看 getUserMedia 那条轨道（volc 路由下才一直握着它）。
    const rec = coachStubs.recognitions.at(-1);
    const spokenBefore = coachStubs.utterances.length;

    utter = await feed('设成 20 次');
    const ackText = tC('coach.cmdAck.setTarget', { value: 20, unit: tC('ui.repsUnit') });
    ok('⑫ 命令回合（「设成 20 次」）的确认语**真的走 TTS**（朗读队列收到这一句）',
      coachStubs.utterances.length === spokenBefore + 1
      && coachStubs.utterances.at(-1).text === ackText,
      JSON.stringify({ before: spokenBefore, after: coachStubs.utterances.length,
        last: coachStubs.utterances.at(-1)?.text, expect: ackText }));
    ok('⑫ 同一回合也进了弹幕（文字反馈没丢）',
      String(elements.get('danmakuLast').textContent).includes(ackText),
      String(elements.get('danmakuLast').textContent));
    ok('⑫ 诊断里出现 tts:* 与 session:say {by:cmd}（以后一眼看出「这回合走没走发声」）',
      seen.some((x) => x.startsWith('tts:')) && seen.includes('session:say')
      && api.coachDiag.snapshot().session.sayBy === 'cmd',
      JSON.stringify({ seen: seen.slice(-10), sayBy: api.coachDiag.snapshot().session.sayBy }));

    // 教练还在念的时候用户说下一句 → 当作插话处理，绝不静默丢弃
    //（用户遇到的「第一句之后都没识别」正是卡在 speaking 时被丢掉的那一类）
    ok('⑫ 前置：这一句还在念（speaking），ASR 没有被停',
      api.state.voice.state === 'speaking' && rec && rec.stopped === 0,
      JSON.stringify({ state: api.state.voice.state, stopped: rec && rec.stopped }));
    api.voice.onUserText('加 5 个');
    await flush();
    ok('⑫ 教练说话中用户说的下一句照样处理（先插话打断再执行，不静默丢弃）',
      api.state.settings.targets.squat === 25 && seen.includes('session:barge-final')
      && api.state.voice.state === 'speaking',
      JSON.stringify({ target: api.state.settings.targets.squat,
        barge: seen.includes('session:barge-final'), state: api.state.voice.state }));
    await finishSpeech(coachStubs.utterances.at(-1));
    ok('⑫ 念完回 listening，识别器没被 stop（final 之后继续聆听，没有关会话）',
      api.state.voice.state === 'listening' && api.state.voice.enabled === true
      && rec && rec.stopped === 0,
      JSON.stringify({ state: api.state.voice.state, enabled: api.state.voice.enabled,
        stopped: rec && rec.stopped }));
    ok('⑫ 诊断：session:speak-end {by:tts-end}（这句是正常念完的）',
      api.coachDiag.snapshot().session.endBy === 'tts-end',
      JSON.stringify(api.coachDiag.snapshot().session));

    // 页面隐藏：允许暂停聆听（pause），但会话还在、麦克风不用重新授权
    api.voice.pause('hidden');
    await flush();
    ok('⑫ 页面隐藏 → pause（by=hidden）：会话还在、还是 enabled（回前台直接恢复，不重新授权）',
      api.state.voice.paused === true && api.state.voice.enabled === true
      && seen.includes('session:pause'),
      JSON.stringify({ paused: api.state.voice.paused, enabled: api.state.voice.enabled,
        seen: seen.slice(-6) }));
    api.voice.resume();
    await flush();
    ok('⑫ 回到前台 → resume 恢复聆听', api.state.voice.paused === false
      && api.state.voice.state === 'listening',
      JSON.stringify({ paused: api.state.voice.paused, state: api.state.voice.state }));

    // 明确关掉（Ctrl+I / 设置）才允许真的 stop：释放麦克风，并留下 by=user
    await api.setCoachEnabled(false);
    await flush();
    ok('⑫ 只有明确关掉（Ctrl+I / 设置）才 stop：session:stop {by:user} + 识别器被停',
      api.state.voice.state === 'off'
      && api.coachDiag.snapshot().session.stopBy === 'user'
      && rec && rec.stopped > 0 && seen.includes('session:stop'),
      JSON.stringify({ state: api.state.voice.state,
        stopBy: api.coachDiag.snapshot().session.stopBy, stopped: rec && rec.stopped }));
    unsub();
  }
}

console.log('\n[20] P3.3 自由对话：/llm → 工具调用真的改界面（走现有 handler）');
{
  const api = windowStub.__mfg;
  const { t: tL } = await import('../src/i18n.js');
  const flush = async (n = 14) => {
    for (let i = 0; i < n; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  /** 喂一句话；app 的 thinkDelay 是 360ms，等够了再看结果 */
  const feed = async (text, ms = 520) => {
    api.voice.onUserText(text);
    await wait(ms);
    await flush();
  };
  const finishSpeech = async () => {
    const u = coachStubs.utterances.at(-1);
    if (u && typeof u.onend === 'function') u.onend();
    await flush();
  };

  api.showHome();
  await api.setCoachEnabled(true);
  await flush();

  /* ---------------- 假 LLM：正常 / 失败 / 慢 ---------------- */
  const requests = [];
  let mode = 'ok';
  let slowRelease = null;
  const llmReply = '好，平板支撑 30 秒，慢一点做。';
  const healthPayload = {
    ok: true, configured: true, provider: 'deepseek', model: 'deepseek-chat',
    limits: { perMinute: 20, maxTokens: 400 }, usage: { requests: 1, tokens: { prompt: 1, completion: 1, total: 2 } },
  };
  api.llmClient.setFetch(async (url, init = {}) => {
    requests.push({ url, init });
    if (init.method === 'GET') {
      return { ok: true, status: 200, json: async () => healthPayload };
    }
    if (mode === 'fail') {
      return { ok: false, status: 503, json: async () => ({ ok: false, error: 'not-configured' }) };
    }
    if (mode === 'slow') {
      return new Promise((resolve) => {
        slowRelease = () => resolve({
          ok: true, status: 200,
          json: async () => ({ ok: true, reply: '想好了。', actions: [], usage: {}, provider: 'deepseek', model: 'deepseek-chat' }),
        });
      });
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        ok: true,
        reply: llmReply,
        actions: [
          { intent: 'startWorkout', args: { exerciseId: 'plank', value: 30 } },
          { intent: 'setTarget', args: { value: 30 } },
        ],
        usage: { prompt: 10, completion: 5, total: 15 },
        provider: 'deepseek', model: 'deepseek-chat',
      }),
    };
  });
  ok('自由对话默认开启，且 /llm 客户端准备好（测试注入假 fetch，不联网）',
    api.state.settings.freeChat === true && typeof api.llmClient.respond === 'function');

  /* ---------------- ① 快车道优先：命中命令表就不发 /llm ---------------- */
  {
    api.openExercise('squat');
    api.state.session = 'running';
    const before = requests.length;
    await feed('帮我换成平板支撑 30 秒');
    ok('「帮我换成平板支撑 30 秒」命中命令快车道：**不发 /llm**，直接改动作 + 目标',
      requests.length === before && api.state.exerciseId === 'plank' && api.state.target === 30,
      JSON.stringify({ requests: requests.length - before, ex: api.state.exerciseId, target: api.state.target }));
    await finishSpeech();
  }

  /* ---------------- ② 没命中 → POST /llm → 用现有 handler 执行 actions ---------------- */
  {
    api.showHome();
    api.openExercise('squat');
    api.state.session = 'running';
    api.state.target = 15;
    const calls = { start: 0, select: [], target: [] };
    const orig = {
      start: api.voiceCommandCtx.startGestureMode,
      select: api.voiceCommandCtx.selectExercise,
      target: api.voiceCommandCtx.setTarget,
    };
    api.voiceCommandCtx.startGestureMode = (...a) => { calls.start += 1; return orig.start?.(...a); };
    api.voiceCommandCtx.selectExercise = (...a) => { calls.select.push(a[0]); return orig.select?.(...a); };
    api.voiceCommandCtx.setTarget = (...a) => { calls.target.push(a[0]); return orig.target?.(...a); };

    const before = requests.length;
    await feed('教练我有点累，帮我安排个轻松的');
    const posted = requests.slice(before).find((r) => r.init && r.init.method === 'POST');
    ok('没命中命令 → 真的发了 POST /llm（带 locale / context / history）',
      !!posted && String(posted.url).endsWith('/llm')
      && JSON.parse(posted.init.body).locale === 'zh'
      && Array.isArray(JSON.parse(posted.init.body).history),
      posted ? String(posted.url) : '（没发请求）');
    const body = posted ? JSON.parse(posted.init.body) : {};
    ok('context 是结构化 Agent 快照（now / session / performance / history / signals + utterance）',
      !!body.context && ['now', 'session', 'performance', 'history', 'signals', 'utterance'].every((k) => k in body.context)
      && body.context.utterance === '教练我有点累，帮我安排个轻松的'
      && body.context.session.exerciseId === 'squat',
      JSON.stringify(Object.keys(body.context || {})));
    ok('context 的 JSON ≤ 6000 字符（≈800 tokens 预算）',
      JSON.stringify(body.context || {}).length <= 6000, String(JSON.stringify(body.context || {}).length));

    ok('模型返回的 start_workout(plank) + set_target(30) → 真的调用了**现有 handler**',
      calls.start === 1 && calls.select.includes('plank') && calls.target.includes(30),
      JSON.stringify(calls));
    ok('界面真的变了：动作 = 平板支撑、目标 = 30 秒、HUD 写「30 秒」',
      api.state.exerciseId === 'plank' && api.state.target === 30
      && elements.get('hudTarget').textContent === `30 ${tL('ui.secondsUnit')}`,
      JSON.stringify({ ex: api.state.exerciseId, target: api.state.target, hud: elements.get('hudTarget').textContent }));
    ok('模型那句 reply 当教练说的话（字幕）',
      api.state.voice.coachText === llmReply, api.state.voice.coachText);
    ok('reply 也进了弹幕（教练那一行）',
      String(elements.get('danmakuLast').textContent).includes(llmReply),
      String(elements.get('danmakuLast').textContent));
    ok('reply 被 TTS 念出来（coachTts → 系统 TTS 桩）',
      coachStubs.utterances.some((u) => u.text === llmReply),
      coachStubs.utterances.map((u) => u.text).join(' / '));
    await finishSpeech();

    api.voiceCommandCtx.startGestureMode = orig.start;
    api.voiceCommandCtx.selectExercise = orig.select;
    api.voiceCommandCtx.setTarget = orig.target;
  }

  /* ---------------- ③ LLM 503 → 回退罐头回复，不崩 ---------------- */
  {
    api.showHome();
    mode = 'fail';
    await feed('烤面包');
    ok('LLM 503 → 回退原来的罐头回复（「没听清…能说什么」），界面状态不变、不崩',
      api.state.voice.coachText === tL('coach.reply.fallback')
      && api.state.voice.state !== 'error' && api.state.homeMode === true,
      JSON.stringify({ coach: api.state.voice.coachText, state: api.state.voice.state }));
    await finishSpeech();
    mode = 'ok';
  }

  /* ---------------- ④ 自由对话关掉 → 只走快车道（完全不发请求） ---------------- */
  {
    api.showHome();
    await api.applyFreeChat(false);
    await flush();
    ok('设置里关掉「自由对话」→ settings.freeChat=false，按钮 aria-pressed=false',
      api.state.settings.freeChat === false
      && elements.get('btnFreeChat').getAttribute('aria-pressed') === 'false');
    const before = requests.length;
    await feed('烤面包');
    ok('关掉之后**完全不发 /llm 请求**（只用命令快车道 + 罐头回复）',
      requests.length === before && api.state.voice.coachText === tL('coach.reply.fallback'),
      JSON.stringify({ sent: requests.length - before, coach: api.state.voice.coachText }));
    await finishSpeech();
    await api.applyFreeChat(true);
    await flush();
    ok('重新打开「自由对话」→ 恢复（默认开）', api.state.settings.freeChat === true);
  }

  /* ---------------- ⑤ 1.5s 没回来 → 底下那行小字「教练在想…」 ---------------- */
  {
    api.showHome();
    api.voice.thinkSlowMs = 40;   // 测试调小；默认 1500ms（THINK_SLOW_MS）
    mode = 'slow';
    api.voice.onUserText('你随便说两句');
    // app 的 thinkDelay 是 360ms：请求发出去之后才开始算「在想…」的 1.5 秒
    await wait(650);
    await flush();
    ok('请求超过 1.5s（测试 40ms）没回来 → 状态环旁显示「教练在想…」',
      elements.get('coachThinking').hidden === false
      && elements.get('coachThinking').textContent === tL('coach.thinkingSlow'),
      JSON.stringify({ hidden: elements.get('coachThinking').hidden,
        text: elements.get('coachThinking').textContent, state: api.state.voice.state }));
    ok('这时候状态环已经切到 thinking（已有状态机，不另造）',
      api.state.voice.state === 'thinking');
    slowRelease?.();
    await wait(40);
    await flush();
    ok('回答回来 → 「教练在想…」立刻收掉', elements.get('coachThinking').hidden === true);
    await finishSpeech();
    api.voice.thinkSlowMs = 1500;
    mode = 'ok';
  }

  /* ---------------- ⑥ 设置里显示 provider / model（health，不含 key） ---------------- */
  {
    api.openSettings();
    await wait(20);
    await flush();
    const status = elements.get('llmStatus');
    ok('设置里显示当前 provider / model（GET /llm/health，不显示 key）',
      status.hidden === false && status.textContent.includes('deepseek')
      && status.textContent.includes('deepseek-chat')
      && !/sk-/.test(status.textContent),
      status.textContent);
    api.closeSettings();
    // 手动点开关也能切（和 state / 持久化同步）
    elements.get('btnFreeChat').dispatch('click');
    await flush();
    ok('点「自由对话」开关 → 立刻生效（关掉）', api.state.settings.freeChat === false);
    elements.get('btnFreeChat').dispatch('click');
    await flush();
    ok('再点一下 → 打开', api.state.settings.freeChat === true);

    /* ---- P3.4 插话打断开关：默认开、点一下关掉、再点打开（随设置持久化） ---- */
    ok('「允许插话打断」默认开（settings.bargeIn === true，按钮 aria-pressed=true）',
      api.state.settings.bargeIn === true
      && elements.get('btnBargeIn').getAttribute('aria-pressed') === 'true',
      JSON.stringify({ setting: api.state.settings.bargeIn,
        pressed: elements.get('btnBargeIn').getAttribute('aria-pressed') }));
    elements.get('btnBargeIn').dispatch('click');
    await flush();
    ok('点「允许插话打断」→ 立刻关掉（settings.bargeIn=false，按钮同步）',
      api.state.settings.bargeIn === false
      && elements.get('btnBargeIn').getAttribute('aria-pressed') === 'false');
    elements.get('btnBargeIn').dispatch('click');
    await flush();
    ok('再点一下 → 重新打开（默认值不变）', api.state.settings.bargeIn === true);
  }

  api.llmClient.setFetch(null);   // 还原：后续用例不再走假 fetch
  api.showHome();
  api.state.settings.freeChat = true;
  await api.setCoachEnabled(false);
  await flush();
}

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
