/**
 * 应用主逻辑：摄像头 → 姿态识别 → 指标 → 动作判定 → 界面/语音反馈。
 * 界面文案全部走 i18n（src/locales/*.js），支持中文 / 英文。
 */

import {
  EXERCISES, EXERCISE_MAP, createDetector, localizedExercise, exerciseUnit,
  localizedCategories, localizedByCategory,
} from './exercises.js';
import { LandmarkSmoother, toMetric, clamp, LM } from './geometry.js';
import { computeFrame } from './metrics.js';
import { PoseEngine, Camera } from './pose-engine.js';
import { PoseRenderer } from './render.js';
import { AudioKit, TRACKS, getTrack, DEFAULT_TRACK } from './audio.js';
import { Calibrator, requiredView } from './calibration.js';
import {
  exerciseSpecs, specCondition, specStages, stageHolds, stageText, stagePoints, stageIndexForStep, SPEC_METRICS,
} from './specs.js';
import { getStepPlan } from './steps.js';
import { iconSVG, uniqueStages } from './icons.js';
import {
  t, setLang, getLang, getMeta, applyI18n, detectLang, LOCALES, LANG_ORDER,
} from './i18n.js';

const $ = (id) => document.getElementById(id);

/** 拼 HTML 时的最小转义（文案来自词条，数值来自代码常量，仍然兜一层底） */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STORE = {
  settings: 'mfg.settings.v1',
  history: 'mfg.history.v1',
  records: 'mfg.records.v1',
};

const DEFAULT_SETTINGS = {
  modelKey: 'lite',
  mirror: true,
  voice: true,
  sfx: true,
  music: true,
  musicTrack: DEFAULT_TRACK,   // 背景音乐选哪首（见 audio.js 的 TRACKS）
  // 判据只有宽松档（用户明确要求取消严格模式），所以设置里没有 strict 这个开关
  showAngles: true,
  showSkeleton: true,
  debug: false,
  exerciseId: 'squat',
  targets: {},
  // 限时计数（开合跳）的时长单独存：这个动作以前的目标是「次数」，
  // 同一个字段改成秒以后老值（50 次）会变成「50 秒」这种莫名其妙的时长，
  // 所以时长另开一份 settings.seconds，老字段原样留着不读。
  seconds: {},
  camDeviceId: null,
};

const REP_TARGETS = [8, 12, 15, 20, 30];
const HOLD_TARGETS = [20, 30, 45, 60, 90];
// 限时计数（开合跳）的时长预设：单位是秒，不是次数
const TIME_TARGETS = [30, 45, 60, 90, 120];

/** 这个动作的目标预设：计时类与限时计数类都是秒，其余是次数 */
function targetPresetsFor(ex) {
  if (ex.kind === 'hold' || ex.timed) return [...(ex.timed ? TIME_TARGETS : HOLD_TARGETS)];
  return [...REP_TARGETS];
}

/** 目标加减按钮的步长（限时/计时类是 15 秒、5 秒，次数类是 1 次） */
function targetStepFor(ex) {
  if (ex.timed) return 15;
  return ex.kind === 'hold' ? 5 : 1;
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

const audio = new AudioKit();
const engine = new PoseEngine();
const camera = new Camera($('video'));
const renderer = new PoseRenderer($('overlay'));
const smoother = new LandmarkSmoother();

const state = {
  settings: loadSettings(),
  exerciseId: 'squat',
  target: 15,
  session: 'calibrating',   // calibrating | ready | countdown | running | paused | idle
  homeMode: false,          // 停在动作主页：不校准、不计数（避免浏览动作时偷偷开始一组）
  autoStart: false,         // 校准识别完成后是否自动进入运动状态（选好动作后为 true）
  afterSet: false,          // 刚结束一组：先让用户休息，不自动开始；离开轮廓后自动恢复
  detector: null,
  calibrator: null,
  calib: null,
  elapsedMs: 0,
  lastTick: 0,
  countdownTimer: null,
  countdownStartedAt: 0,    // 倒计时的起点，用于「定时器被节流」时的时间兜底
  lastCueAt: 0,
  lastCueLevel: 'warn',
  hintUntil: 0,
  lastVideoTime: -1,
  lostSince: 0,
  celebrateUntil: 0,
  goalHit: false,
  wakeLock: null,
  engineReady: false,
  loopCount: 0,
  detectCount: 0,
  poseHits: 0,
  camError: null,
  /** 最近一帧「手/脚」离左下角圆环多远（🐞 面板用：排查到底有没有识别到手/脚） */
  touchInfo: null,
  consoleErrors: [],
  saidSteps: new Set(),
  stepSig: '',
  calibSig: '',
  lastScoreMilestone: 0,
  // ---- 限时计数（开合跳）----
  timeUp: false,            // 时间到：这一组停止计次，等庆祝动画走完再结算
  timeCallsSaid: null,      // 已经报过哪几档剩余时间（45/30/15/5 秒各报一次）
  repsSinceEncourage: 0,      // 距离上一句激励过了几次（每 3 次给一句）
  lastEncourageHint: '',      // 屏幕上刚显示过的激励语（不重复）
  coachAt: -Infinity, // 语音教练上一次说话的时间（全局节流；-Infinity = 还没说过）
  coachSig: '',     // 上一次念的那句话（同一句短时间内不重复）
  // ---- 判定进度条（画面上那条一格一格点亮的判据链）----
  criteriaStages: [],   // 当前动作的阶段（见 specs.js 的 specStages）
  criteriaIdx: -1,      // 已经识别到的最后一格；-1 = 还没开始
  criteriaJust: -1,     // 刚刚点亮的那一格（用于播放「跳一下」动画）
  criteriaJustPts: -1,  // 刚刚拿到分的那一格（同上）
  criteriaPts: [],      // 每一格上**已经拿到**的分（真的有得分项达标才写）
  criteriaMax: [],      // 每一格**能拿多少分**（得分项按关键帧分配，见 specs.js 的 stagePoints）
  criteriaStepStage: {}, // 得分项 id → 第几格（把得分记到对应格子上）
  criteriaClearUntil: 0, // 刚清零后的展示期结束时间（这段时间进度条保持空的）
  criteriaLive: false,   // 这一帧识别到人体了没（决定进度条是灰色还是彩色）
  criteriaLostSince: 0,  // 从什么时候开始没识别到人（丢帧宽限用）
  criteriaIcons: [],     // 每一格的线条图标（SVG 字符串，重建时生成一次）
  criteriaEls: [],       // 每一格的真实元素（{root, icon, pts}）—— 增量更新用，不在计分时重建
  criteriaContext: null, // 生成图标用的上下文（动作姿势/计划/门控）
  // ---- 计时类读秒（每 5 秒播报一次）----
  holdCountNext: 5,      // 下一个要读的秒数（5 / 10 / 15 …）
  holdCountAt: 0,        // 上一次读秒的时刻（用来让要领语音避让）
};

/** 一次动作完成后，进度条保持「空的」多久（让清零看得见） */
const CRITERIA_CLEAR_MS = 650;

/** 丢掉识别多久才把进度条变灰并清零（识别本身会抖，短暂丢帧不算） */
const CRITERIA_LIVE_GRACE_MS = 700;

/** 收集控制台错误，供 ?probe=1 自检输出 */
function captureConsole() {
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      if (level === 'error') state.consoleErrors.push(args.map(String).join(' ').slice(0, 300));
      orig(...args);
    };
  }
}

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE.settings) || '{}');
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try { localStorage.setItem(STORE.settings, JSON.stringify(state.settings)); } catch { /* ignore */ }
}
function loadList(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* ignore */ }
}

/** 分数 + 单位（分 / points / puntos / points） */
const scoreText = (n) => `${n} ${t('speech.scoreSuffix')}`.trim();

/* ------------------------------------------------------------------ *
 * 界面构建
 * ------------------------------------------------------------------ */

function buildLanguageSelect() {
  const sel = $('langSel');
  if (!sel) return;
  sel.innerHTML = '';
  for (const code of LANG_ORDER) {
    const meta = LOCALES[code]?.meta;
    if (!meta) continue;
    const o = document.createElement('option');
    o.value = code;
    o.textContent = `${meta.flag || ''} ${meta.label || code}`.trim();
    sel.appendChild(o);
  }
  sel.value = getLang();
}

/* ------------------------------------------------------------------ *
 * 主页：五个分类 × 动作图标网格
 * ------------------------------------------------------------------ */

/** 当前搜索词（主页搜索框） */
let homeQuery = '';

function buildHome() {
  const box = $('homeCats');
  if (!box) return;
  const q = homeQuery.trim().toLowerCase();
  box.innerHTML = '';
  let shown = 0;
  for (const cat of localizedCategories()) {
    const list = localizedByCategory(cat.id)
      .filter((ex) => !q
        || ex.name.toLowerCase().includes(q)
        || ex.id.toLowerCase().includes(q)
        || (ex.goal || '').toLowerCase().includes(q)
        || (ex.cameraHint || '').toLowerCase().includes(q));
    const block = document.createElement('section');
    block.className = 'cat-block';
    block.dataset.cat = cat.id;
    const count = t('home.count', { n: list.length });
    block.innerHTML = `<h3 class="cat-head"><span class="cat-icon">${cat.icon}</span>`
      + `<span>${cat.name}</span><span class="cat-count">${count}</span></h3>`;
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = t('home.noResult');
      block.appendChild(p);
    } else {
      const grid = document.createElement('div');
      grid.className = 'ex-grid';
      for (const ex of list) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ex-card';
        btn.dataset.id = ex.id;
        if (ex.id === state.exerciseId) btn.classList.add('active');
        const kind = t(ex.kind === 'rep' ? (ex.timed ? 'ui.kindTimed' : 'ui.kindRep') : 'ui.kindHold');
        const target = `${ex.target} ${ex.targetUnit}`;
        btn.innerHTML = `<span class="ex-icon">${ex.icon}</span>`
          + `<span class="ex-name">${ex.name}</span>`
          + `<span class="ex-meta">${kind} · ${target} · ${ex.judgeText}</span>`
          + (ex.rough ? `<span class="ex-badge">${t('home.rough')}</span>` : '');
        btn.addEventListener('click', () => openExercise(ex.id));
        grid.appendChild(btn);
      }
      block.appendChild(grid);
    }
    if (list.length || !q) box.appendChild(block);
    shown += list.length;
  }
  if (q && !shown) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = t('home.noResult');
    box.appendChild(p);
  }
}

/* ------------------------------------------------------------------ *
 * 两个视图：主页（只负责挑动作）与动作页（体感训练）
 *
 * 用地址栏 hash 当路由，这样「进动作页」是真的换页面：
 *   #/            主页
 *   #/ex/<id>     某个动作的训练页
 * 好处是浏览器后退能回主页、刷新能停在同一个动作、链接可以直接分享。
 * ------------------------------------------------------------------ */

const ROUTE_EX = '#/ex/';

/** 从地址栏读当前动作用户想练哪个动作（不在动作页时返回 null） */
function routeExercise() {
  try {
    const h = String(location.hash || '');
    if (!h.startsWith(ROUTE_EX)) return null;
    const id = h.slice(ROUTE_EX.length);
    return EXERCISE_MAP[id] ? id : null;
  } catch { return null; }
}

/** 同步地址栏（不写历史，避免每帧都塞一条记录） */
function setRoute(hash) {
  try {
    if (location.hash === hash) return;
    if (typeof history !== 'undefined' && history.replaceState) history.replaceState(null, '', hash);
    else location.hash = hash;
  } catch { /* 某些环境（自动化桩）没有 history，忽略即可 */ }
}

/** 曲子列表（设置弹窗里选背景音乐） */
function buildMusicTracks() {
  const box = $('musicTracks');
  if (!box) return;
  box.innerHTML = '';
  for (const track of TRACKS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'track-btn';
    btn.dataset.track = track.id;
    const on = track.id === state.settings.musicTrack;
    btn.setAttribute('aria-pressed', String(on));
    if (on) btn.classList.add('active');
    btn.innerHTML = `<span class="track-name">${t(track.nameKey)}</span>`
      + `<span class="track-meta">${track.bpm} BPM</span>`;
    btn.addEventListener('click', () => selectMusicTrack(track.id));
    box.appendChild(btn);
  }
}

/** 选一首曲子：立刻生效（顺便把背景音乐打开，否则选了也听不到） */
function selectMusicTrack(id) {
  const next = audio.setTrack(id);
  state.settings.musicTrack = next;
  if (!state.settings.music) {
    state.settings.music = true;
    $('btnMusic').setAttribute('aria-pressed', 'true');
    applyMusic();
  }
  saveSettings();
  buildMusicTracks();
  setCueLine(t('status.musicTrack', { name: t(getTrack(next).nameKey) }));
}

/**
 * 背景音乐只在**动作页**播放：主页只是挑动作，不放音乐（用户明确要求）。
 * 用户的选择（state.settings.music）保留着，回到动作页时自动接着放。
 */
/**
 * 摄像头只在**动作页**开着：回到主页就关掉（用户明确要求）。
 * 关闭时把遮罩恢复到「开启摄像头」，下次进动作页会自动重新打开（那一下点击本身就是用户手势，
 * 浏览器允许 getUserMedia），所以用户感觉不到多一步操作。
 */
function stopCameraForHome() {
  if (!camera.active && !camera.stream) return;
  try { camera.stop(); } catch { /* ignore */ }
  state.camStoppedForHome = true;
  state.poseHits = 0;
  $('hud').hidden = true;
  renderer.clear();
  const mask = $('stageMask');
  if (mask) mask.classList.remove('hidden');
  $('maskIcon').textContent = '📷';
  $('maskTitle').textContent = t('ui.maskTitle');
  $('maskText').textContent = t('ui.maskText');
  $('btnStartCam').textContent = t('ui.startCam');
  $('camDot').className = 'dot';
  $('camStatus').textContent = t('status.camOff');
  updatePipelineStatus();
}

/** 从主页回到动作页时把摄像头接回来（只在确实是被主页关掉时需要） */
function resumeCameraFromHome() {
  if (!state.camStoppedForHome || !Camera.supported()) return;
  state.camStoppedForHome = false;
  startCamera(state.settings.camDeviceId || null);
}

function applyMusic() {
  const want = !!state.settings.music && !state.homeMode;
  audio.setMusic(want);
}

/**
 * 退出全屏（如果正在全屏）。
 *
 * 用户要求：「做完一个运动退出的时候不仅要退回到主页，也要退出全屏模式」。
 * 否则从「视频框全屏」里点退出/🏠，主页会顶着全屏显示 —— 整页排版被放大、还会留着
 * 那条全屏状态，用户得再按一次 Esc 才回到正常页面。
 *
 * 幂等：本来不在全屏就什么都不做；浏览器不支持 / 拒绝时静默忽略（退出全屏失败绝不能
 * 影响「回主页」这件正事）。桩环境与老浏览器可能不派发 `fullscreenchange`，
 * 所以这里顺手把按钮状态和舞台尺寸自己同步一次。
 */
function exitFullscreen() {
  try {
    const el = document.fullscreenElement;
    if (!el) return false;
    const p = document.exitFullscreen?.();
    if (p && typeof p.catch === 'function') p.catch(() => { /* 退出全屏被拒：忽略 */ });
    $('btnFullscreen')?.setAttribute('aria-pressed', 'false');
    onStageResize();
    return true;
  } catch {
    return false;   // 老浏览器抛异常也不能拦住回主页
  }
}

function showHome({ syncRoute = true } = {}) {
  if (state.session === 'running' || state.session === 'paused' || state.session === 'countdown') {
    stopSession('switch');
  }
  // 注意顺序：stopSession 会摆出手势圆环，所以收起来这一步必须在它之后
  hideGestureRings();
  hideCornerExit();
  // 回主页就一定离开「视频框全屏」：主页上全屏只会把整页放大，没有意义
  exitFullscreen();
  // 主页上不校准也不计数：摄像头可以留着预热，但不能在浏览动作时偷偷开始一组
  state.homeMode = true;
  state.session = 'idle';
  applyMusic();          // 主页不放背景音乐
  stopCameraForHome();   // 主页也不需要摄像头，直接关掉（省电、也让摄像头灯灭掉）
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  $('countdown').hidden = true;
  state.calib = null;
  renderCalibration(null);
  $('homeView').hidden = false;
  $('workoutView').hidden = true;
  $('btnHome').hidden = true;
  $('btnExercise').hidden = true;   // 运动设定只在动作页出现
  closeSettings();
  closeExerciseSettings();
  closeRecordsModal();
  buildHome();
  updateButtons();
  if (syncRoute) setRoute('#/');
}

/** 切到动作页 */
function showWorkout() {
  state.homeMode = false;
  applyMusic();          // 回到动作页再把背景音乐接上（用户选择保留着）
  resumeCameraFromHome(); // 摄像头之前被主页关掉了就自动重开
  $('homeView').hidden = true;
  $('workoutView').hidden = false;
  $('btnHome').hidden = false;
  $('btnExercise').hidden = false;   // 动作页才有「运动设定」
  renderExerciseSettings();
  // 左下角的「退出」圆环不在这里摆：它**只在摄像头开着的时候**显示（用户要求），
  // 由主循环里的 syncCornerExit() 每帧对齐（摄像头一开一关它自己出现/消失）。
  syncCornerExit();
}

/** 从主页点进某个动作（进入训练页） */
function openExercise(id, { fromRoute = false } = {}) {
  if (!EXERCISE_MAP[id]) return;
  showWorkout();
  selectExercise(id);
  if (!fromRoute) setRoute(ROUTE_EX + id);
  // 有些环境（老浏览器 / 自动化桩）没有 scrollTo，别让它把流程打断
  try { window.scrollTo?.({ top: 0, behavior: 'smooth' }); } catch { /* ignore */ }
}

/** 浏览器前进/后退 → 在两个视图之间切换 */
function handleRouteChange() {
  const id = routeExercise();
  if (id) {
    if (state.homeMode || state.exerciseId !== id) openExercise(id, { fromRoute: true });
  } else {
    showHome({ syncRoute: false });
  }
}

/* ------------------------------------------------------------------ *
 * 设置弹窗（语言 / 模型 / 音效 / 背景音乐 / 画面与识别）
 * ------------------------------------------------------------------ */

function settingsOpen() { return !$('settingsModal').hidden; }

function openSettings() {
  const modal = $('settingsModal');
  if (!modal) return;
  modal.hidden = false;
  // 让读屏软件念出弹窗标题（标题文案走 i18n，这里只做无障碍关联）
  const title = $('settingsTitle');
  if (title) title.textContent = t('settings.title');
  const first = modal.querySelector('select, button');
  if (first) first.focus({ preventScroll: true });
}

function closeSettings() {
  const modal = $('settingsModal');
  if (modal) modal.hidden = true;
}

/* ------------------------------------------------------------------ *
 * 最佳成绩 / 运动记录弹窗
 *
 * 用户要求：这两块内容**不要再放在动作页里**，改成顶栏两个图标（🏆 / 📜）+ 弹窗显示。
 * 列表本身还是用同一套渲染（renderRecords / renderHistory），只是被搬进了弹窗的容器里。
 * ------------------------------------------------------------------ */

function recordsModalOpen() {
  return !$('bestModal').hidden || !$('historyModal').hidden;
}

/** 打开某个「记录类」弹窗：先把列表刷成最新的，再显示（顺序保证不会闪旧数据） */
function openRecordsModal(which) {
  const modal = $(which === 'best' ? 'bestModal' : 'historyModal');
  if (!modal) return;
  if (which === 'best') renderRecords(); else renderHistory();
  modal.hidden = false;
  const title = $(which === 'best' ? 'bestTitle' : 'historyTitle');
  if (title) title.textContent = t(which === 'best' ? 'ui.best' : 'ui.history');
  const first = modal.querySelector('button');
  if (first) first.focus({ preventScroll: true });
}

function closeRecordsModal() {
  const best = $('bestModal');
  const hist = $('historyModal');
  if (best) best.hidden = true;
  if (hist) hist.hidden = true;
}

/* ------------------------------------------------------------------ *
 * 运动设定弹窗（只出现在动作页：目标 / 判定方式 / 机位提示）
 * ------------------------------------------------------------------ */

function exerciseSettingsOpen() { return !$('exerciseModal').hidden; }

/**
 * 这个动作的判定进度条模型：显示用的格子、图标、每格能拿多少分。
 * **进度条和运动设定弹窗共用这一份**（弹窗里列的关键帧必须与画面上的一模一样）。
 */
function criteriaModel(id) {
  const ex = localizedExercise(id);
  const ctx = {
    id,
    posture: ex.posture,
    kind: ex.kind,
    plan: ex.plan,
    gate: EXERCISE_MAP[id]?.params?.gate,
    // 引擎量的是哪个指标：图标要用它决定「画成哪一类姿势」（例如开合跳要画正面开合的姿势）
    metric: EXERCISE_MAP[id]?.params?.metric,
    stages: specStages(id),
  };
  // 画出来一模一样的格子留一格就够（计时类动作里两条姿势要求常常画的是同一个姿势）
  const stages = uniqueStages(ctx.stages, ctx);
  const icons = stages.map((s) => iconSVG(s, ctx));
  // **得分分配到关键帧**：每个关键帧能拿多少分（整轮满分奖励记在最后一格，计时类的每秒分也是）
  const scored = stagePoints(id);
  const max = stages.map((s) => {
    const idx = ctx.stages.indexOf(s);
    const row = idx >= 0 ? scored[idx] : null;
    return {
      points: row ? row.points : 0,
      bonus: row ? row.bonus : 0,
      perSecond: row ? row.perSecond : 0,
    };
  });
  // 步骤 id → 第几格：界面按这个把「这一步加到的分」记到对应格子上
  const stepStage = {};
  for (const def of (getStepPlan(id)?.steps || [])) {
    const fullIdx = stageIndexForStep(id, def.id);
    stepStage[def.id] = fullIdx >= 0 ? stages.indexOf(ctx.stages[fullIdx]) : -1;
  }
  return { ctx, stages, icons, max, stepStage };
}

const ROUND_NUM = ['①', '②', '③', '④', '⑤', '⑥', '⑦'];

/**
 * 运动设定弹窗最上面那组：**这个动作的关键帧 + 每格判据 + 每格分数**。
 *
 * 用户要求「把对应动作的关键帧判别标准以及对应的判分标准列出来」，并且
 * **判据完全由关键帧承担** —— 所以这里逐格列出：图标、序号+短标签、判定标准
 * （就是画面上进度条的判据；有替代判据的写成「A 或 B」）、这一格能拿多少分，
 * 以及这一格相关的补充判据（第一格把其余姿势要求、计次格把深度线、最后一格把时间线列出来）。
 * 原来的「计次判据 / 姿势要求」两组已经去掉，判据一律挂在关键帧上。
 */
function keyframeRowsHtml(id) {
  const { stages, icons, max } = criteriaModel(id);
  const isHold = localizedExercise(id).kind === 'hold';
  const { groups } = exerciseSpecs(id);
  const itemsOf = (key) => groups.find((g) => g.titleKey === key)?.items || [];
  const countItems = itemsOf('spec.group.count');
  const postureItems = itemsOf('spec.group.posture');
  const pick = (label) => countItems.find((it) => it.labelKey === label);
  const parts = [];
  let total = 0;
  stages.forEach((stage, i) => {
    const { short, cond } = stageText(stage);
    const row = max[i] || { points: 0, bonus: 0, perSecond: 0 };
    total += row.points + row.bonus;
    const isMoment = i === stages.length - 1;
    const pts = [
      row.points > 0 ? `+${row.points}` : '',
      row.bonus > 0 ? `+${row.bonus} ${t('spec.roundBonus')}` : '',
      row.perSecond > 0 ? `+${row.perSecond}${t('spec.perSecondSuffix')}` : '',
    ].filter(Boolean).join(' ');

    // 这一格的判据：主判据（+ 有替代判据时写成「A 或 B」+ 有附加条件时补「且 C」）+ 该判据原本的说明
    const altText = stage.alt ? ` ${t('spec.orAlt')} ${specCondition(stage.alt.item || stage.alt)}` : '';
    const alsoText = stage.also ? ` ${t('spec.andAlso')} ${specCondition(stage.also.item || stage.also)}` : '';
    const condText = `${cond}${altText}${alsoText}`;
    const lines = [];
    if (stage.item?.noteKey) lines.push(t(stage.item.noteKey, stage.item.noteParams || null));
    // 这一格下面挂「和它同一组（同一个 labelKey）的其余姿势要求」：
    //   ① 第一格还额外带上纯文字类的要求（例如「请正对摄像头」）；
    //   ② 已经被别的格子当判据用掉的条目不再重复（否则第二个关键帧的判据会跑到第一格下面）。
    // 原先只在第一格挂、且不分组，遇到「一个动作有两组姿势要求」（坐姿体前屈：坐好 + 前折到位）就会串位。
    const usedByStages = new Set(stages.map((s) => s.item).filter(Boolean));
    const mine = stage.item ? specCondition(stage.item) : '';
    const sameGroup = (it) => it.labelKey === stage.item?.labelKey;
    const extra = postureItems.filter((it) => it !== stage.item && !usedByStages.has(it)
      && specCondition(it) !== mine
      && (sameGroup(it) || (i === 0 && !!it.textKey)));
    if (extra.length) lines.push(`${t('spec.poseExtra')}${extra.map((it) => specCondition(it)).join('、')}`);
    // 「计次」那一格：把深度线 / 更浅只算晃了一下的线也挂在它下面
    if (stage.item?.labelKey === 'spec.countLine') {
      const bottom = pick('spec.bottomLine');
      if (bottom) lines.push(`${t('spec.depthLine')}${specCondition(bottom)}`);
      const wobble = pick('spec.wobble');
      if (wobble) lines.push(`${t('spec.wobbleLine')}${specCondition(wobble)}`);
    }
    // 最后一格 = 计次那一刻（计时类是开始计时）：把时间类判据挂在这里
    if (isMoment) {
      const minRep = pick('spec.minRep');
      if (minRep) lines.push(`${t('spec.tempoLine')}${specCondition(minRep)}`);
      const prime = pick('spec.holdPrime');
      if (prime) lines.push(`${t('spec.holdPrimeLine')}${specCondition(prime)}`);
      const grace = pick('spec.holdGrace');
      if (grace) lines.push(`${t('spec.holdGraceLine')}${specCondition(grace)}`);
      const giveUp = pick('spec.giveUp');
      if (giveUp) lines.push(t(giveUp.noteKey, giveUp.noteParams || null));
    }

    parts.push(
      '<div class="spec-row spec-kf">'
      + `<span class="spec-kf-icon">${icons[i] || ''}</span>`
      + `<span class="spec-name">${esc(`${ROUND_NUM[i] || `(${i + 1})`} ${short}`)}`
      + (isMoment ? `<span class="spec-badge">${esc(t(isHold ? 'spec.holdMoment' : 'spec.countMoment'))}</span>` : '')
      + '</span>'
      + `<span class="spec-cond">${esc(condText)}</span>`
      + (pts ? `<span class="spec-pts">${esc(pts)}</span>` : '')
      + (lines.filter(Boolean).length
        ? `<span class="spec-note">${esc(lines.filter(Boolean).join(' · '))}</span>` : '')
      + '</div>',
    );
  });
  parts.push(`<div class="spec-note-full">${esc(t('spec.keyframesNote', {
    n: stages.length,
    total,
    every: t('spec.everyFrameNeeded'),
  }))}</div>`);
  return '<div class="spec-group spec-keyframes">'
    + `<div class="spec-group-title">${esc(t('spec.group.keyframes'))}</div>`
    + parts.join('')
    + '</div>';
}

/**
 * 把当前动作的判据渲染进运动设定弹窗。
 *
 * **判据完全挂在关键帧上**（用户要求）：所以只渲染
 *   ① 关键帧与判分（含每格的判据、分数、以及深度/时间等补充线）
 *   ② 姿态提醒（只出声纠正、不吃次数的那几条）
 * 原来的「计次判据（做到什么程度算一次）」「姿势要求」两组已经取消。
 */
function renderExerciseSpecs() {
  const box = $('exerciseSpecs');
  if (!box) return;
  const { groups } = exerciseSpecs(state.exerciseId);
  const parts = [keyframeRowsHtml(state.exerciseId)];
  const advice = groups.find((g) => g.titleKey === 'spec.group.advice');
  if (advice && advice.items.length) {
    parts.push('<div class="spec-group">');
    parts.push(`<div class="spec-group-title">${esc(t(advice.titleKey))}</div>`);
    for (const it of advice.items) {
      const note = it.noteKey ? t(it.noteKey, it.noteParams || null) : '';
      parts.push(
        '<div class="spec-row">'
        + `<span class="spec-name">${esc(t(it.labelKey))}</span>`
        + `<span class="spec-cond">${esc(specCondition(it))}</span>`
        + (note ? `<span class="spec-note">${esc(note)}</span>` : '')
        + '</div>',
      );
    }
    parts.push('</div>');
  }
  box.innerHTML = parts.join('');
}

/** 把当前动作的资料刷进弹窗与侧栏摘要（目标、判定依据、机位、技术指标） */
function renderExerciseSettings() {
  const ex = localizedExercise(state.exerciseId);
  const unit = ex.targetUnit || '';
  $('exerciseName').textContent = `${ex.icon} ${ex.name}`;
  $('exerciseJudge').textContent = `🎯 ${t('exercise.judgeBy', { what: ex.judgeText })}`
    + (ex.rough ? ` · ${t('exercise.rough')}` : '');
  $('exerciseCamera').textContent = `📹 ${ex.cameraHint}`;
  $('targetUnit').textContent = unit;
  $('targetReadout').textContent = `${t('exercise.target')}: ${state.target} ${unit}`;
  // 限时计数（开合跳）：把「这一组跑多久、成绩是什么」写在目标下面，避免以为要跳到某个次数
  const timedEl = $('exerciseTime');
  if (timedEl) {
    timedEl.textContent = ex.timed ? t('exercise.timedLead', { sec: ex.target }) : '';
    timedEl.hidden = !ex.timed;
  }
  renderExerciseSpecs();
}

function openExerciseSettings() {
  const modal = $('exerciseModal');
  if (!modal) return;
  renderExerciseSettings();
  modal.hidden = false;
  // 让读屏软件念出弹窗标题（文案走 i18n，这里只做无障碍关联）
  const title = $('exerciseTitle');
  if (title) title.textContent = t('exercise.title');
  const first = modal.querySelector('button');
  if (first) first.focus({ preventScroll: true });
}

function closeExerciseSettings() {
  const modal = $('exerciseModal');
  if (modal) modal.hidden = true;
}

/* ------------------------------------------------------------------ *
 * 手势圆环：一组做完之后，把手掌放到圆环中央保持 3 秒就触发
 *
 * 为什么要有它：一组做完后人还站在镜头前，手上都是汗/离键盘很远，
 * 「退出」和「再做一次」这两个最常用的选择不该逼用户去点屏幕。
 * 所以一组结束后直接在画面上摆两个大圆环（左：退出，右：再做一次），
 * 手掌（左右手都行）停在圆环中央 → 圆环**顺时针**走满一圈并转成绿色 → 触发。
 * 3 秒是刻意选的：抬手、经过、犹豫都不会误触，鼠标点一下同样有效。
 * ------------------------------------------------------------------ */

/** 两个圆环的位置（舞台内的比例）—— 与 index.html 里的按钮元素一一对应
 *  y = 0.52 是量过的：圆环下沿留在判定进度条（画在画面底部）上方，手机上也不会压住它 */
const GESTURE_RINGS = {
  exit: { x: 0.32, y: 0.52, labelKey: 'ui.gestureExit', timerId: 'ringExitTimer' },
  retry: { x: 0.68, y: 0.52, labelKey: 'ui.gestureRetry', timerId: 'ringRetryTimer' },
};
/** 圆环直径 = 舞台宽度的这个比例（CSS 里 width: 20% 必须与它一致） */
const RING_SIZE = 0.20;
/** 手掌要落在圆心这个半径内才算「在圆环中央」（约环半径的 60%，边缘擦过不算） */
const RING_HIT = 0.06;
/** 手掌要保持多久 */
const GESTURE_HOLD_MS = 3000;
/** 识别会抖：短暂离开这么久以内不清零（但也不再累积） */
const GESTURE_GRACE_MS = 300;

/**
 * **左下角常驻的「退出」圆环**（用户要求）。
 *
 * 「在画面左下角划一个『退出』圆环，手或者脚进入之后保持 3 秒则退出运动以及全屏状态。
 *   圆环的动画效果和运动结束后的退出圆环保持一样。」
 * 后续又要求：「左下角，和右上角的圆环成对角的状态，直径还可以再大一点，
 *   右上角的圆环直径可以小一点，**各个圆环大小一样，保持对称**；而且只在打开摄像头的时候显示。」
 *
 * 所以它和「一组结束后」的那两个圆环**共用同一套东西**：同样的 `.ring-*` 样式与 SVG、
 * 同样的顺时针走满一圈动画、同样的 `paintRing` / `updateGesture` 逻辑、同样的 3 秒
 * （`GESTURE_HOLD_MS`）与同样宽容度（`GESTURE_GRACE_MS`）；尺寸与右上角的 HUD 进度环
 * **共用 CSS 变量 `--ring-px`**（所以「各个圆环大小一样」是一条样式约束，不会各写各的），
 * 位置摆在**左下角**、与右上角那个**严格成对角**（左边距 = 右边距、下边距 = 上边距）。区别只有：
 *   - 手**或脚**都算（手掌中心，或整只脚的中心）；
 *   - 触发后退出这一组**并退出全屏**（`showHome()` 里本来就会退出全屏）；
 *   - **只在摄像头开着的时候显示**（`camera.active`）。
 *
 * 用户后来把两件事一起定下来：「让退出圆环可以放在画面的左下角，和右上角的进度圆环对称。
 *   退出圆环放大一点，大小和右上角的进度圆环保持一样大小。」—— 所以它现在真的贴在左下角，
 *   而**进度条自己把两侧空间让出来**（CSS 变量 `--bar-side-space` = 左边距 + 圆环直径 + 间隙），
 *   两者各占各的地方，不用再靠「把圆环抬高」来避让（原来是 `CORNER_RING_BOTTOM_PX = 122`）。
 */
/** 圆环外沿离画面左边这么远（与右上角 HUD 圆环的 18px 右边距左右对称） */
const CORNER_RING_INSET_PX = 18;
/**
 * 圆环下沿离画面底部这么高：**与右上角 HUD 圆环的上内边距（`.hud` 的 `padding: 16px 18px`）一致**，
 * 这样左下角 / 右上角两个圆环是严格的中心对称关系。
 *
 * 原来这里是 122px（把圆环抬到判定进度条上方）；现在进度条**变短了**（最多 880px，并且两侧
 * 用 `--bar-side-space` 给圆环留了位置），所以圆环可以贴回左下角，不会再压住最左边那一格。
 */
const CORNER_RING_BOTTOM_PX = 16;
/**
 * 读不到元素真实尺寸时的兜底直径（与 style.css 里 `--ring-px` 的 clamp 参数保持一致）。
 * 用户要求「退出圆环放大一点」：96/132 → 104/140（右上角那个共用同一个变量，一起变大、仍然等大）。
 */
const RING_PX_FALLBACK = { min: 104, vw: 0.105, max: 140 };
/**
 * 手 / 脚要「进到圆环里」的判定半径（占**直径**）。
 *
 * 用户最新口径：「**手掌或者脚的一部分进入**就要开始沙漏计时，保持 3 秒后退出，**一部分进入即可触发**。」
 * 所以判定**逐点**做（见 touchSamples）：只要手/脚上的任意一个点（指尖 / 脚跟 / 脚趾尖 / 脚踝 / 手腕）
 * 落进圆环里就算进去了 —— 半径就取**圆环画出来的那个半径**（0.5 × 直径），也就是「点在圆圈里面」。
 *
 * 历史（都保留在注释里，免得以后又走回头路）：
 *   - 最初 0.30（= 环半径的 60%）：必须把「手掌中心 / 整只脚的中心」对准圆心才算，
 *     屏幕上半径 70px 的圆环只有中间 42px 有效 —— 用户反馈「十分不灵敏」；
 *   - 中间改成 0.45（= 环半径的 90%）：好一些，但仍然要求**中心**进环，
 *     用手指尖 / 脚趾尖去够的时候中心还在环外，计时就是不开始 —— 用户再次反馈。
 */
const RING_HIT_RATIO = 0.5;
/**
 * 手势落点的最低可见度：低于这个值的点整帧不参与（被身体挡住的看不见的手/脚不会误触）。
 * 原来写死 0.4 —— 但手/脚伸到**画面边角**（左下角圆环正好在角上）时，MediaPipe 给的可见度
 * 本来就偏低，0.4 会把「明明看得见的手」整个丢掉，这也是「不灵敏」的原因之一，现在放宽到 0.3。
 */
const TOUCH_VIS_MIN = 0.3;
/**
 * **脚**（脚跟 / 脚尖）的最低可见度：比手更宽松（0.15）。
 *
 * 为什么单独给脚一档（用户反馈「**只要脚尖进入圆环就要开始沙漏计时，现在感觉要脚踝进入才开始计时**」）：
 * 圆环贴在画面**左下角**，而脚要够到那儿通常是抬起来斜着伸过去 —— 此时 MediaPipe 对
 * 脚跟 / 脚尖这两个点的可见度经常只有 0.2 上下（脚在画面边缘、鞋尖被裁掉、脚背朝镜头都会被压低），
 * 用 0.3 的门槛**整只脚的脚尖点全被丢掉**，只剩一个脚踝点可用 —— 于是「必须把脚踝塞进圆环」
 * 才开始计时，正是用户感觉到的那个现象。手指尖没有这个问题（手举到角上仍然清晰）。
 *
 * 放宽的代价：偶尔会把「其实看不清的脚」也算进来。所以三条保险都在：判定点必须落在**圆环里面**
 * （半径 0.5×直径，比画出来的圆圈还大 15%）、要**连续停满 3 秒**、而且离开后进度是**慢慢退**的
 * （GESTURE_DRAIN_MS，手抖出去一下不会清零）。
 */
const FOOT_VIS_MIN = 0.15;
/**
 * 脚尖点**量不到时自己估一个**（用户要求「脚尖进入就开始计时」）。
 *
 * 两个方向都估一遍，谁落在圆环里算谁的（这些点只用于圆环判定：画面上不画、也不参与动作识别，
 * 有真实脚尖点时永远不会用到它们）：
 *   ① **顺着小腿**：脚尖 ≈ 脚踝 + (脚踝 − 膝) × `FOOT_TIP_FROM_SHIN`
 *      —— 正面看（人朝镜头）时脚是朝下 / 朝镜头的，脚尖就落在脚踝下面；
 *   ② **朝脚跟的反方向**：脚尖 ≈ 脚踝 + (脚踝 − 脚跟) × `FOOT_TIP_FROM_HEEL`
 *      —— 侧面看时脚跟在后、脚尖在前，两者在脚踝的两侧。
 *
 * ⚠️ 不能写成「脚跟 + (脚跟 − 脚踝)」：那是**继续往脚跟后面伸**，方向正好反了 ——
 * 脚尖和脚跟是在脚踝的**两侧**，不是同侧（这个坑写在注释里，免得以后又写成那样）。
 */
const FOOT_TIP_FROM_SHIN = 0.55;
const FOOT_TIP_FROM_HEEL = 1.6;
/**
 * 估算的脚尖**最多能离脚踝多远**（按小腿长的倍数）：正常人脚尖离脚踝约 0.6 倍小腿长，
 * 这里放宽到 0.8 倍。为什么要这一条：万一 MediaPipe 把脚跟误检到很远的地方，
 * 上面第 ② 条延长线就会「凭空」穿过整个画面落进圆环里 —— 误触 = 直接把这一组退掉，代价很大。
 * 小腿量不到时（膝也丢了）不做这个限制 —— 那种情况本来就该退回真实点。
 */
const FOOT_TIP_MAX_SHIN = 0.8;
/**
 * 手/脚离开圆环之后进度退回去的速度：满圈约 1.5 秒退完。
 *
 * 以前是「离开超过 0.3 秒直接把 `since` 清零」→ 辛辛苦苦停了两秒多，手抖出去 0.4 秒就全没了。
 * 现在改成**按时间慢慢退**：短暂滑出去只损失一点点，真的把手拿开才会眼看着退完。
 */
const GESTURE_DRAIN_MS = 1500;
/**
 * 「手/脚已经靠近圆环」的提示倍数：落在判定半径的这个倍数以内就把圆环点亮一下 ——
 * 用户能立刻看出「摄像头看得见我的手，再往环里挪一点就对了」，不用猜是不是没识别到。
 */
const RING_NEAR_FACTOR = 2.2;

/** 手势圆环的运行时状态（进度 0~1、进入时刻、最后在里面的一刻） */
const gestureState = {
  visible: false,
  exit: { p: 0, since: 0, lastInside: 0, done: false },
  retry: { p: 0, since: 0, lastInside: 0, done: false },
  // 左下角常驻的「退出」圆环：独立显示/隐藏（不跟「一组结束」那两个一起）
  corner: { p: 0, since: 0, lastInside: 0, done: false },
  cornerVisible: false,
};

/**
 * 圆环的直径（像素）。
 *
 * 优先读元素真实尺寸（CSS 里的 `--ring-px`）；读不到（元素还藏着 / 测试桩）就按**同一组 clamp 参数**
 * 算 —— 这样判定半径和屏幕上看到的圆环永远对得上。
 *
 * ⚠️ 兜底公式用的是**视口宽度（vw）**，不是舞台宽度：CSS 里 `--ring-px: clamp(104px, 10.5vw, 140px)`
 * 里的 vw 就是视口宽度，右上角那个 HUD 圆环完全由 CSS 决定（= 11vw）。以前这里用舞台宽度算，
 * 比 vw 小一圈，于是**在元素还没显示出来的时候量到的直径会被写死在行内样式上** ——
 * 结果就是「左下角的退出圆环看起来比右上角的进度圆环小」（用户反馈）。现在两边口径一致。
 */
function ringPx(key) {
  const el = ringEl(key);
  const w = el?.clientWidth || 0;
  if (w > 0) return w;
  const vw = (typeof window !== 'undefined' && window.innerWidth) || stageSize().w;
  return Math.round(clamp(vw * RING_PX_FALLBACK.vw, RING_PX_FALLBACK.min, RING_PX_FALLBACK.max));
}

/** 圆环的圆心（**像素**）：中间两个按比例摆，左下角那个固定贴在左下角 */
function ringCenter(key, stageW, stageH) {
  if (key === 'corner') {
    const px = ringPx('corner');
    return {
      x: CORNER_RING_INSET_PX + px / 2,
      y: stageH - CORNER_RING_BOTTOM_PX - px / 2,
    };
  }
  const r = GESTURE_RINGS[key];
  return { x: r.x * stageW, y: r.y * stageH };
}

/** 圆环的判定半径（像素）：中间两个沿用原来的比例口径，左下角那个按自己的直径算 */
function ringHitRadius(key, size) {
  if (key === 'corner') return ringPx('corner') * RING_HIT_RATIO;
  return RING_HIT * size.w;
}

/**
 * 画面里的「手 / 脚」落点（舞台像素坐标，已经考虑镜像）——**每个关键点各算一个采样点**。
 *
 * 手 = 手腕 + 食指 + 小指 + 拇指（每只手 4 个点）；脚 = 踝 + 脚跟 + 脚趾尖（每只脚 3 个点）。
 *
 * 用户口径：「**手掌或脚的一部分进入**我认为就要开始沙漏计时，保持 3 秒后退出。
 *   **一部分进入即可触发**。」 —— 所以左下角那个退出圆环**逐点**判定：
 * 只要手/脚上的**任意一个点**落进圆环里就开始计时（指尖、脚跟、脚趾尖、脚踝都算）。
 *
 * 用户后来又补了一条：「**只要脚尖进入圆环就要开始沙漏计时**，现在感觉要脚踝进入才开始计时」——
 * 这就是上面两处修改的来源：
 *   1. **脚的两个点单独用更宽松的可见度门槛**（`FOOT_VIS_MIN` = 0.15，手仍然是 0.3）：
 *      脚伸到画面左下角时，脚跟 / 脚尖的可见度经常只有 0.2 上下，旧门槛会把它们整个丢掉；
 *   2. **脚尖点量不到时自己估一个**（`ghost: true`，见 FOOT_TIP_FROM_HEEL / FOOT_TIP_FROM_SHIN）：
 *      脚尖是用户指过去的那个部位，不能因为 MediaPipe 没给点就当作不存在。
 * 加上 `anyTouchInRing` 里的**线段判定**（整只脚连成一片），「脚尖/脚掌进环」就真的能触发计时了。
 */
function touchSamples(landmarks, stageW, stageH, mirror) {
  if (!landmarks || !landmarks.length) return [];
  const out = [];
  const toStage = (p) => ({ x: (mirror ? 1 - p.x : p.x) * stageW, y: p.y * stageH });
  const add = (p, kind, side, part, visMin = TOUCH_VIS_MIN) => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    const vis = p.visibility === undefined ? 1 : p.visibility;
    if (vis < visMin) return null;
    const q = { ...toStage(p), kind, side, part, vis };
    out.push(q);
    return q;
  };
  for (const side of ['L', 'R']) {
    const isL = side === 'L';
    add(landmarks[isL ? LM.L_WRIST : LM.R_WRIST], 'hand', side, 'wrist');
    add(landmarks[isL ? LM.L_INDEX : LM.R_INDEX], 'hand', side, 'index');
    add(landmarks[isL ? LM.L_PINKY : LM.R_PINKY], 'hand', side, 'pinky');
    add(landmarks[isL ? LM.L_THUMB : LM.R_THUMB], 'hand', side, 'thumb');
    const ankle = add(landmarks[isL ? LM.L_ANKLE : LM.R_ANKLE], 'foot', side, 'ankle');
    const heel = add(landmarks[isL ? LM.L_HEEL : LM.R_HEEL], 'foot', side, 'heel', FOOT_VIS_MIN);
    const toe = add(landmarks[isL ? LM.L_FOOT : LM.R_FOOT], 'foot', side, 'toe', FOOT_VIS_MIN);
    // 真实的脚尖点量不到 → 估一个（只在量不到时用，见 FOOT_TIP_FROM_SHIN / FOOT_TIP_FROM_HEEL）
    if (!toe && ankle) {
      const kneeP = landmarks[isL ? LM.L_KNEE : LM.R_KNEE];
      const kp = kneeP && Number.isFinite(kneeP.x) && Number.isFinite(kneeP.y) ? toStage(kneeP) : null;
      // 小腿长（脚踝→膝）：只用来卡「估算点别伸太远」（见 FOOT_TIP_MAX_SHIN）
      const shin = kp ? Math.hypot(ankle.x - kp.x, ankle.y - kp.y) : 0;
      const cands = [];
      if (kp) {
        cands.push({
          dir: { x: ankle.x - kp.x, y: ankle.y - kp.y }, k: FOOT_TIP_FROM_SHIN, vis: ankle.vis,
        });
      }
      if (heel) {
        cands.push({
          dir: { x: ankle.x - heel.x, y: ankle.y - heel.y },
          k: FOOT_TIP_FROM_HEEL,
          vis: Math.min(ankle.vis, heel.vis),
        });
      }
      for (const cand of cands) {
        const len = Math.hypot(cand.dir.x, cand.dir.y);
        if (!(len > 1)) continue;
        const tip = { x: ankle.x + cand.dir.x * cand.k, y: ankle.y + cand.dir.y * cand.k };
        // 估算点离脚踝太远（比如脚跟被误检到画面外）→ 宁可不估，避免凭空落进圆环
        const reach = shin > 1 ? Math.hypot(tip.x - ankle.x, tip.y - ankle.y) / shin : 0;
        if (reach <= FOOT_TIP_MAX_SHIN) {
          out.push({
            x: tip.x, y: tip.y, kind: 'foot', side, part: 'toe', vis: cand.vis, ghost: true,
          });
        }
      }
    }
  }
  return out;
}

/** 点 (px,py) 到线段 ab 的最短距离（用来判断「整只脚」有没有一部分进圆环） */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 有几个采样点落在圆环里（🐞 面板显示用：「环内点 2」说明结论更稳） */
function pointsInRing(samples, key, size) {
  const c = ringCenter(key, size.w, size.h);
  const hit = ringHitRadius(key, size);
  return samples.filter((p) => Math.hypot(p.x - c.x, p.y - c.y) <= hit).length;
}

/**
 * 手 / 脚有**任意一个采样点**落进圆环里就算「进去了」（用户要求「一部分进入即可触发」）。
 *
 * 另外还判**线段**：同一条手/脚上的采样点两两连成线段，圆环只要和其中任意一条相交也算进去了。
 * 为什么必须有这一条（用户反馈「感觉要脚踝进入才开始计时」）：
 * 脚伸过来的时候，**脚尖在环里、脚踝和脚跟都在环外**是完全可能的 —— 逐点判定这时一个点都不在环内，
 * 于是「脚尖明明已经进去了」却不计时，人只好继续往里塞，直到脚踝也进环。线段判定把整只脚看成一整片，
 * 「脚尖/脚掌搭在圆环上」立刻就算进去了。
 *
 * 返回 `{ inside, pointIn, spanIn, best, bestSeg, minDist, hit }`：
 * `best` 是离圆心最近的采样点、`bestSeg` 是最近的那条线段（🐞 面板要显示它们）。
 */
function anyTouchInRing(samples, key, size) {
  const c = ringCenter(key, size.w, size.h);
  const hit = ringHitRadius(key, size);
  if (!samples || !samples.length) {
    return { inside: false, pointIn: false, spanIn: false, best: null, bestSeg: null, minDist: Infinity, hit };
  }
  let best = null;
  for (const p of samples) {
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (!best || d < best.d) best = { d, p };
  }
  // 整只脚 / 整只手连成的线段（同一条肢体内部的点两两相连）
  const groups = new Map();
  for (const p of samples) {
    const g = `${p.kind}:${p.side}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  let bestSeg = null;
  for (const pts of groups.values()) {
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const d = distToSegment(c.x, c.y, pts[i].x, pts[i].y, pts[j].x, pts[j].y);
        if (!bestSeg || d < bestSeg.d) bestSeg = { d, a: pts[i], b: pts[j] };
      }
    }
  }
  const pointIn = !!best && best.d <= hit;
  const spanIn = !!bestSeg && bestSeg.d <= hit;
  const minDist = Math.min(best ? best.d : Infinity, bestSeg ? bestSeg.d : Infinity);
  return { inside: pointIn || spanIn, pointIn, spanIn, best, bestSeg, minDist, hit };
}

/**
 * 手 / 脚各自的**中心**（手掌中心 / 整只脚的中心）—— 只用于「一组结束」那两个圆环
 * （它们的设计是「把手掌放进圆环中央」）和 🐞 面板的读数；左下角退出圆环改用 touchSamples 逐点判。
 */
function touchPoints(landmarks, stageW, stageH, mirror) {
  const samples = touchSamples(landmarks, stageW, stageH, mirror);
  const centreOf = (kind, side) => {
    const pts = samples.filter((p) => p.kind === kind && p.side === side);
    if (!pts.length) return null;
    return {
      x: pts.reduce((n, p) => n + p.x, 0) / pts.length,
      y: pts.reduce((n, p) => n + p.y, 0) / pts.length,
      kind,
      side,
    };
  };
  return [
    centreOf('hand', 'L'), centreOf('hand', 'R'),
    centreOf('foot', 'L'), centreOf('foot', 'R'),
  ].filter(Boolean);
}

/** 只有手掌（「一组结束」那两个圆环用；左下角的退出圆环改用 touchSamples 逐点判，手或脚都算） */
function palmPoints(landmarks, stageW, stageH, mirror) {
  return touchPoints(landmarks, stageW, stageH, mirror).slice(0, 2);
}

/** 舞台的像素尺寸（没有布局信息时按 16:9 的默认值兜底，测试桩里也能跑） */
function stageSize() {
  const stage = $('stage');
  const w = stage?.clientWidth || 0;
  const h = stage?.clientHeight || 0;
  if (w > 0 && h > 0) return { w, h };
  return { w: 1280, h: 720 };
}

/** 摆好两个圆环的位置（一处定义：位置和大小都来自 GESTURE_RINGS / RING_SIZE） */
function layoutGestureRings() {
  for (const key of Object.keys(GESTURE_RINGS)) {
    const el = ringEl(key);
    if (!el) continue;
    el.style.left = `${GESTURE_RINGS[key].x * 100}%`;
    el.style.top = `${GESTURE_RINGS[key].y * 100}%`;
    el.style.width = `${RING_SIZE * 100}%`;
  }
  layoutCornerRing();
}

/** 左下角退出圆环的位置（左下角、与右上角 HUD 圆环成对角；全屏/横竖屏切换后要重摆） */
function layoutCornerRing() {
  const el = ringEl('corner');
  if (!el) return;
  const size = stageSize();
  // ⚠️ 先清掉行内尺寸再量：行内 px 会盖住 CSS 的 `--ring-px`，如果不清，
  // 上一次量到的旧尺寸会被一直沿用 —— 窗口一改大小（或跨过小屏断点）圆环就不跟着变了，
  // 于是又和右上角那个 HUD 圆环不一样大（这正是用户反馈的那个「看起来小一圈」）。
  el.style.width = '';
  el.style.height = '';
  const px = ringPx('corner');
  const c = ringCenter('corner', size.w, size.h);
  el.style.left = `${c.x}px`;
  el.style.top = `${c.y}px`;
  el.style.width = `${px}px`;
  el.style.height = `${px}px`;
}

function ringEl(key) {
  if (key === 'corner') return $('ringQuickExit');
  return $(key === 'exit' ? 'ringExit' : 'ringRetry');
}

/** 左下角退出圆环上那个「退出」文案 / 计时器的元素 */
function cornerLabelEl() { return $('ringQuickExitLabel'); }

/** 一组做完 → 亮出两个圆环，并提示怎么用（语音 + 屏幕上方的提示条） */
function showGestureRings({ speak = true } = {}) {
  const box = $('gestureRings');
  if (!box) return;
  layoutGestureRings();
  const labels = ['exit', 'retry'];
  for (const key of labels) {
    const el = ringEl(key);
    const st = gestureState[key];
    st.p = 0; st.since = 0; st.lastInside = 0; st.done = false;
    el?.classList.remove('dwelling', 'done');
    const label = $(key === 'exit' ? 'ringExitLabel' : 'ringRetryLabel');
    if (label) label.textContent = t(GESTURE_RINGS[key].labelKey);
    const timer = $(GESTURE_RINGS[key].timerId);
    if (timer) timer.textContent = '';
    paintRing(key, 0);
  }
  box.hidden = false;
  // 「一组结束」的两个圆环已经给了退出/再做一次 → 左下角那个常驻圆环先收起来，别重复
  hideCornerExit();
  const hint = $('gestureHint');
  if (hint) {
    hint.textContent = t('ui.gestureHint');
    hint.hidden = false;
  }
  gestureState.visible = true;
  // 语音提示晚一点念：紧接着上一句「本组成绩」说会被听成一句，等它念完再说怎么用手势
  if (speak) {
    setTimeout(() => {
      if (gestureState.visible) audio.say(t('ui.gestureVoice'), { rate: 1.05 });
    }, 2600);
  }
}

function hideGestureRings() {
  const box = $('gestureRings');
  if (box) box.hidden = true;
  const hint = $('gestureHint');
  if (hint) hint.hidden = true;
  gestureState.visible = false;
  for (const key of ['exit', 'retry']) {
    const st = gestureState[key];
    st.p = 0; st.since = 0; st.lastInside = 0; st.done = false;
    ringEl(key)?.classList.remove('dwelling', 'done');
  }
  // 左下角那个常驻圆环的显示/隐藏由「摄像头开着没有」决定（每帧同步，见 syncCornerExit）
  syncCornerExit();
}

/** 圆环的进度：顺时针走满一圈（dashoffset 从满到 0） */
function paintRing(key, p) {
  const el = ringEl(key);
  if (!el) return;
  const circle = el.querySelector?.('.ring-fill');
  const clamped = clamp(p, 0, 1);
  if (circle) circle.style.strokeDashoffset = String(326.7 * (1 - clamped));
  const st = gestureState[key];
  el.classList.toggle('dwelling', clamped > 0.001 && !st.done);
  if (st.done) el.classList.add('done');
}

/** 手/脚在不在这个圆环的中央（判定半径由 ringHitRadius 决定，每个环自己的口径） */
function handInRing(points, key, size) {
  const c = ringCenter(key, size.w, size.h);
  const hit = ringHitRadius(key, size);
  return points.some((p) => Math.hypot(p.x - c.x, p.y - c.y) <= hit);
}

/**
 * 每帧更新两个圆环的进度。返回这一帧是否触发了某个动作（触发时圆环已经收起来）。
 * 只要有一只手停在圆环中央满 GESTURE_HOLD_MS 就触发；两只手各停一个环也行。
 */
function updateGesture(landmarks, now) {
  if (!gestureState.visible) return null;
  const size = stageSize();
  const palms = palmPoints(landmarks, size.w, size.h, state.settings.mirror);
  let fired = null;
  for (const key of ['exit', 'retry']) {
    const st = gestureState[key];
    if (st.done) continue;
    const inside = handInRing(palms, key, size);
    if (inside) {
      st.lastInside = now;
      if (!st.since) st.since = now;
      st.p = clamp((now - st.since) / GESTURE_HOLD_MS, 0, 1);
    } else if (now - st.lastInside > GESTURE_GRACE_MS) {
      st.since = 0;
      st.p = Math.max(0, st.p - 0.06);   // 轻轻退回去，看得出「手离开了」
    }
    paintRing(key, st.p);
    const timer = $(GESTURE_RINGS[key].timerId);
    if (timer) {
      const left = Math.max(0, GESTURE_HOLD_MS - (now - st.since)) / 1000;
      timer.textContent = st.p > 0.02 && st.p < 1 ? `${left.toFixed(1)}s` : '';
    }
    if (st.p >= 1) {
      st.done = true;
      paintRing(key, 1);
      fired = key;
    }
  }
  if (fired) triggerGesture(fired);
  return fired;
}

/**
 * 左下角的常驻「退出」圆环：显示 / 隐藏。
 *
 * 显示时机（用户要求）：**只在摄像头开着的时候**（`camera.active`）摆出来 —— 摄像头没开、
 * 或者出错了，圆环就没意义（手/脚也识别不到）。摄像头开着时在校准 / 倒计时 / 计数中 / 暂停
 * 都一直摆着，手或脚伸进去停 3 秒就能退出，不用去够按钮。
 * 「一组结束」的两个大圆环出来时收起来（那儿已经有「退出」了）。
 * 这一同步在每一帧做（`syncCornerExit`），所以摄像头一开一关它自己跟着出现/消失。
 */
function showCornerExit() {
  const box = $('cornerExit');
  if (!box || gestureState.cornerVisible) return;
  const st = gestureState.corner;
  st.p = 0; st.since = 0; st.at = 0; st.lastInside = 0; st.done = false;
  ringEl('corner')?.classList.remove('dwelling', 'done', 'near');
  const label = cornerLabelEl();
  if (label) label.textContent = t('ui.gestureExit');
  const timer = $('ringQuickExitTimer');
  if (timer) timer.textContent = '';
  paintRing('corner', 0);
  // ⚠️ 顺序很重要：**先显示再量尺寸**。元素还在 `display: none` 时 `clientWidth` 是 0，
  // 量到的是兜底值，那个值会被写进行内 width/height —— 于是圆环会一直比右上角的 HUD 圆环小一圈
  // （用户反馈「退出圆环放大一点，大小和右上角的进度圆环保持一样大小」就是这个原因）。
  box.hidden = false;
  gestureState.cornerVisible = true;
  layoutCornerRing();
}

function hideCornerExit() {
  const box = $('cornerExit');
  if (box) box.hidden = true;
  gestureState.cornerVisible = false;
  const st = gestureState.corner;
  st.p = 0; st.since = 0; st.at = 0; st.lastInside = 0; st.done = false;
  ringEl('corner')?.classList.remove('dwelling', 'done', 'near');
  state.touchInfo = null;
}

/**
 * 把左下角退出圆环的显示状态与「摄像头开着没有」对齐（每帧调用，很便宜）。
 * 条件：摄像头开着 + 不在主页 + 「一组结束」的两个大圆环没摆着。
 */
function syncCornerExit() {
  const want = !!camera.active && !state.homeMode && !gestureState.visible;
  if (want === gestureState.cornerVisible) return;
  if (want) showCornerExit(); else hideCornerExit();
}

/**
 * 每帧更新左下角退出圆环：**手或脚的任意一部分**进到圆环里、保持满 GESTURE_HOLD_MS 就退出。
 * 进度与动画完全复用中间那两个圆环的那一套（paintRing / 同一组常量）。
 *
 * 判定口径（用户要求）：「手掌或脚的一部分进入就要开始沙漏计时，保持 3 秒后退出，
 * **一部分进入即可触发**」，后来又补了「**只要脚尖进入圆环就要开始沙漏计时**，现在感觉要脚踝进入才开始计时」。
 * 所以现在是三层一起判（见 touchSamples / anyTouchInRing）：
 *   1. 逐点 —— 指尖 / 脚跟 / 脚趾尖 / 脚踝 / 手腕，任意一个点落在圆环里；
 *   2. 逐段 —— 同一条手/脚上的点连成线段，圆环和线段相交也算（**脚尖在环里、脚踝在环外**就是这样被抓住的）；
 *   3. 脚尖点量不到时用**估算的脚尖**（`ghost`），脚伸到画面左下角时这一步很关键。
 *
 * 之前几次放宽的历史见 RING_HIT_RATIO / TOUCH_VIS_MIN / FOOT_VIS_MIN / GESTURE_DRAIN_MS 的注释。
 * 「手/脚现在在哪、离圆心多远、是哪个部位进的环」记进 `state.touchInfo`，🐞 面板会显示。
 */
function updateCornerExit(landmarks, now) {
  const size = stageSize();
  const samples = touchSamples(landmarks, size.w, size.h, state.settings.mirror);
  if (!gestureState.cornerVisible) { state.touchInfo = null; return false; }
  const st = gestureState.corner;
  if (st.done) { state.touchInfo = null; return false; }
  // 逐点 + 逐段判定：任意一个采样点、或者整只脚/手连成的线段碰到圆环，就算「手/脚进去了」
  const res = anyTouchInRing(samples, 'corner', size);
  const { inside, best, bestSeg, minDist, pointIn, spanIn } = res;
  const hit = res.hit;
  const near = Number.isFinite(minDist) && minDist <= hit * RING_NEAR_FACTOR;
  const inCount = pointsInRing(samples, 'corner', size);
  state.touchInfo = best
    ? {
      has: true,
      kind: best.p.kind,
      part: best.p.part,
      side: best.p.side,
      ghost: !!best.p.ghost,         // 这个点是**估算**的脚尖（真实的没量到）
      x: best.p.x / size.w,
      y: best.p.y / size.h,
      rel: minDist / (hit || 1),     // 离圆心几个「判定半径」（<1 = 在环里）
      inCount,                       // 有几个采样点进环了（>1 = 结论更稳）
      inside,
      near,
      via: pointIn ? 'point' : (spanIn ? 'span' : 'none'),   // 靠点还是靠「整只脚那一段」进的环
      span: spanIn && bestSeg ? { d: bestSeg.d, from: bestSeg.a.part, to: bestSeg.b.part } : null,
    }
    : { has: false, inside: false, near: false, via: 'none' };

  const dt = clamp(now - (st.at || now), 0, 250);
  st.at = now;
  if (inside) {
    st.lastInside = now;
    st.p = clamp(st.p + dt / GESTURE_HOLD_MS, 0, 1);
  } else if (now - st.lastInside > GESTURE_GRACE_MS) {
    // 离开超过宽限期：**慢慢退回去**（1.5 秒退完一圈），不再一秒清零
    st.p = Math.max(0, st.p - dt / GESTURE_DRAIN_MS);
  }
  const el = ringEl('corner');
  if (el) el.classList.toggle('near', near && !inside);
  paintRing('corner', st.p);
  const timer = $('ringQuickExitTimer');
  if (timer) {
    const left = Math.max(0, GESTURE_HOLD_MS * (1 - st.p)) / 1000;
    timer.textContent = st.p > 0.02 && st.p < 1 ? `${left.toFixed(1)}s` : '';
  }
  if (st.p >= 1) {
    st.done = true;
    paintRing('corner', 1);
    return true;
  }
  return false;
}

/** 左下角圆环触发：退出这一组**并且退出全屏**（和「一组结束后」的退出圆环同一个动作） */
function triggerCornerExit() {
  if (gestureState.corner.done && !gestureState.cornerVisible) return;
  gestureState.corner.done = true;
  paintRing('corner', 1);
  audio.milestone();
  audio.say(t('ui.gestureExit'), { rate: 1.1, force: true });
  hideCornerExit();
  showHome();          // showHome 里会 stopSession + 退出全屏
}

/** 一组做完后的两个选择里那个「退出」圆环（手势停满 3 秒，或者用户直接点它） */
function triggerGesture(key) {
  audio.milestone();
  hideGestureRings();
  if (key === 'exit') {
    audio.say(t('ui.gestureExit'), { rate: 1.1, force: true });
    showHome();
  } else {
    audio.say(t('ui.gestureRetry'), { rate: 1.1, force: true });
    retrySet();
  }
}

/** 「再做一次」：把这一组的计数全部清零，然后马上重新开始这一组 */
function retrySet() {
  hideGestureRings();
  const det = ensureDetector();
  det?.reset();                 // 次数 / 分数 / 要领清单 / 每轮进度全部清零
  state.afterSet = false;       // 又来一组了：不再是「刚做完一组在休息」的状态
  state.elapsedMs = 0;
  state.goalHit = false;
  state.timeUp = false;         // 限时计数：又来一组 → 时间重新开始
  state.timeCallsSaid = new Set();
  state.saidSteps = new Set();
  state.lastScoreMilestone = 0;
  state.stepSig = '';
  state.celebrateUntil = 0;
  $('celebrate').hidden = true;
  $('scorePop').className = 'score-pop';
  resetCriteriaProgress();
  updateHud();
  renderCriteriaBar();
  beginCountdown();
}

/** 舞台尺寸变化（横竖屏切换、全屏）时把圆环重新摆一次 */
function onStageResize() {
  if (gestureState.visible) layoutGestureRings();
  if (gestureState.cornerVisible) layoutCornerRing();
}

/* ------------------------------------------------------------------ *
 * 判定进度条：把判据摊成几步，每识别到一个姿态就点亮一格
 *
 * 每一格都是识别器真正用的阈值（见 specs.js 的 specStages），顺序就是判定顺序：
 *   站姿/俯撑到位 → 开始这一轮 → 计入一次 → 双腿/离地等附加条件 → 深度到位
 * 一格点亮时：轻响一声 + 该格闪一下；如果这一步同时加了分，格子上显示 +N。
 * 每完成一次动作（rep 事件）就把进度条收回起点，下一轮重新一格一格走过去。
 * ------------------------------------------------------------------ */

/** 按当前动作重建进度条（换动作 / 重新校准时调用） */
function buildCriteriaBar() {
  // 与运动设定弹窗共用同一份模型：弹窗里列的关键帧 = 画面上显示的格子（不会各说一套）
  const { ctx, stages, icons, max, stepStage } = criteriaModel(state.exerciseId);
  state.criteriaStages = stages;
  state.criteriaIcons = icons;
  state.criteriaContext = ctx;
  state.criteriaMax = max;
  state.criteriaStepStage = stepStage;
  state.criteriaPts = new Array(stages.length).fill(0);
  // **只在换动作时建一次 DOM**：之后每一帧只改 class 和数字。
  // 为什么：以前每次「点亮一格 / 加分」都重建整条 innerHTML —— 元素被换掉，
  // 过渡和弹出动画（呼吸、对勾、分数弹出）就从头再放一遍，看起来就是「进度条一直在抖」。
  buildCriteriaSegments();
  resetCriteriaProgress();
  renderCriteriaBar();
}

/** 把这条判据链的格子建出来（图标、判据提示都写一次；状态由 renderCriteriaBar 增量更新） */
function buildCriteriaSegments() {
  const track = $('criteriaTrack');
  state.criteriaEls = [];
  if (!track) return;
  track.innerHTML = '';
  state.criteriaStages.forEach((s, i) => {
    const seg = document.createElement('div');
    seg.className = 'criteria-seg';
    seg.dataset.i = String(i);
    seg.dataset.done = '0';
    seg.dataset.pts = '0';
    // 悬停提示里给完整判据 + 这一格的分数（画面上不写文字，鼠标移上去/触摸才知道这一步要什么）
    const tip = [stageText(s).short, stageText(s).cond, criteriaPointsText(i)].filter(Boolean).join(' · ');
    seg.setAttribute('data-tip', tip);
    seg.innerHTML = state.criteriaIcons[i] || '';   // 线条图标（只在这里写一次）

    const pts = document.createElement('span');
    pts.className = 'criteria-seg-pts';
    seg.appendChild(pts);

    track.appendChild(seg);
    state.criteriaEls.push({ root: seg, pts });
  });
}

/**
 * 把进度收回起点。
 *
 * 一次动作做完时会调用它：**进度条清零、下一轮从头开始**。
 * 注意留了一小段「清零展示时间」（CRITERIA_CLEAR_MS）—— 因为动作是在回到起始姿势的那一刻
 * 才算完成的，如果立刻重新判定，「站姿」那一格会在同一帧又亮起来，用户看起来就像没清零。
 * 这段时间里进度条保持空的，之后再从站姿重新一格一格走。
 */
function resetCriteriaProgress({ holdMs = 0, now = performance.now() } = {}) {
  state.criteriaIdx = -1;
  state.criteriaJust = -1;
  state.criteriaJustPts = -1;
  state.criteriaClearUntil = holdMs > 0 ? now + holdMs : 0;
  for (let i = 0; i < state.criteriaPts.length; i++) state.criteriaPts[i] = 0;
}

/** 进度条是不是正处在「刚清零」的展示期 */
function criteriaCleared(now = performance.now()) {
  return now < state.criteriaClearUntil;
}

/** 某一格能拿多少分的文字（悬停提示用；没有分数的格子返回 ''） */
function criteriaPointsText(index) {
  const row = state.criteriaMax?.[index];
  if (!row) return '';
  const earned = state.criteriaPts?.[index] || 0;
  const parts = [];
  if (earned > 0) parts.push(t('ui.criteriaPtsGot', { n: earned }));
  const max = (row.points || 0) + (row.bonus || 0);
  if (max > 0) parts.push(t('ui.criteriaPtsMax', { n: max }));
  if (row.perSecond > 0) parts.push(t('ui.criteriaPtsPerSec', { n: row.perSecond }));
  return parts.join(' · ');
}

/** 悬停某一格：在进度条上方显示这一格的判定标准 */
function showCriteriaTip(index) {
  const tip = $('criteriaTip');
  const stage = state.criteriaStages?.[index];
  if (!tip || !stage) return;
  const { short, cond } = stageText(stage);
  const pts = criteriaPointsText(index);
  tip.innerHTML = `<span class="criteria-tip-name">${esc(short)}</span>${esc(cond)}`
    + (pts ? `<span class="criteria-tip-pts">${esc(pts)}</span>` : '');
  tip.hidden = false;
}

function hideCriteriaTip() {
  const tip = $('criteriaTip');
  if (tip) tip.hidden = true;
}

/** 某一格现在满足了没 */
function criteriaHolds(stage, frame) {
  return stageHolds(stage, frame, state.detector);
}

/**
 * 每帧推进：只看「下一格」，所以必须按顺序一格一格走，不会跳格。
 * events 是这一帧识别器抛出的事件，用来把刚加到的分标在对应格子上。
 */
function updateCriteria(frame, events, now) {
  const stages = state.criteriaStages;
  if (!stages.length) return;

  // 展示期结束 → 进度条收回起点（下一轮从头走）
  if (state.criteriaClearUntil && now >= state.criteriaClearUntil) {
    state.criteriaClearUntil = 0;
    resetCriteriaProgress();
  }

  // 「识别到人了吗」：没识别到 → 进度条整条变灰（表示还没开始工作）。
  // 识别会抖动，所以给一点宽限：短暂丢帧不立刻变灰、也不清进度，丢久了才清零。
  const seen = !!(frame && frame.ok && frame.bodyVisible !== false);
  if (seen) state.criteriaLostSince = 0;
  else if (!state.criteriaLostSince) state.criteriaLostSince = now;
  const lostMs = seen ? 0 : now - state.criteriaLostSince;
  const live = seen || lostMs < CRITERIA_LIVE_GRACE_MS;
  if (live !== state.criteriaLive) {
    state.criteriaLive = live;
    if (!live) resetCriteriaProgress();
  }

  // 这一帧加到的分（要领得分 / 满分奖励）先处理：清零展示期里也不能丢掉分数反馈。
  // 得分按**得分项 → 关键帧**的映射记到对应的格子上（见 specs.js 的 stageIndexForStep），
  // 所以「得分显示在关键帧里」和「哪个要领给的分」永远对得上，不会飘到别的格子上。
  let earned = 0;
  for (const ev of (events || [])) {
    if (!Number.isFinite(ev.points) || ev.points <= 0) continue;
    earned += ev.points;
    const mapped = ev.type === 'step' ? state.criteriaStepStage?.[ev.id] : undefined;
    let idx = Number.isFinite(mapped) ? mapped : -1;
    if (idx < 0 && ev.type !== 'step') idx = stages.length - 1;   // 整轮奖励 / 每秒分 → 最后一格
    if (idx < 0) idx = Math.max(0, Math.min(stages.length - 1, state.criteriaIdx));
    state.criteriaPts[idx] = (state.criteriaPts[idx] || 0) + ev.points;
    state.criteriaJustPts = idx;
  }
  if (earned > 0) {
    const el = $('criteriaEarned');
    if (el) {
      el.textContent = `+${earned}`;
      el.classList.remove('show');
      // 重新触发一次动画（读一次 offsetWidth）
      void el.offsetWidth;
      el.classList.add('show');
    }
  }

  // 刚清零的那一小段时间里不再判定，让「清零」这件事看得见；
  // 也只有真正在计数（running）时才往前推进 —— 校准阶段只显示「识别到人了」的颜色
  if (!live || state.session !== 'running' || criteriaCleared(now)) {
    renderCriteriaBar(now);
    return;
  }

  let advanced = -1;
  for (let i = state.criteriaIdx + 1; i < stages.length; i++) {
    if (!criteriaHolds(stages[i], frame)) break;
    state.criteriaIdx = i;
    advanced = i;
  }
  if (advanced >= 0) {
    state.criteriaJust = advanced;
    audio.criteria(advanced, stages.length);
  }
  renderCriteriaBar(now);
}

/**
 * 画进度条：**增量更新**，一格一格地只改该改的东西。
 *
 * 用户反馈「计分的时候进度条抖得厉害」——根因就是这里以前每次状态变化都重建整条 innerHTML：
 * 元素被换掉，过渡（背景/边框 0.18s）、呼吸动画、对勾、以及分数数字的弹出动画都会**从头再放一遍**，
 * 一秒一次（计时类每秒加分）就成了肉眼可见的抖动。
 * 现在：
 *   - 格子元素只在换动作时建一次（见 buildCriteriaSegments）；
 *   - class 与数字**只有真的变了才写**，动画因此只在自己该播的时候播一次；
 *   - 上面那条「本帧 +N」的牌子也只在分数变化时更新。
 */
function renderCriteriaBar(now = performance.now()) {
  const bar = $('criteriaBar');
  const track = $('criteriaTrack');
  if (!bar || !track) return;
  const stages = state.criteriaStages;
  // 整条进度条**一直显示**在动作页上：没识别到人 / 没开始计数时是灰的（尚未开始），
  // 识别到人而且正在计数时才有颜色（已经开始工作）。
  const visible = stages.length > 0 && !state.homeMode;
  const live = !!state.criteriaLive;
  const active = state.session === 'running' && live;
  $('stage').classList.toggle('has-criteria', visible);
  if (bar.hidden === visible) bar.hidden = !visible;   // 没变就别写属性（每帧都跑）
  if (!visible) return;
  if (bar.classList.contains('idle') === active) bar.classList.toggle('idle', !active);
  if (bar.classList.contains('active') !== active) bar.classList.toggle('active', active);

  const cleared = criteriaCleared(now);
  const wantReset = cleared && active;
  if (bar.classList.contains('reset') !== wantReset) bar.classList.toggle('reset', wantReset);

  const els = state.criteriaEls || [];
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (!el) continue;
    const done = i <= state.criteriaIdx;
    const earned = state.criteriaPts[i] || 0;
    const row = state.criteriaMax?.[i] || { points: 0, bonus: 0, perSecond: 0 };
    const max = (row.points || 0) + (row.bonus || 0);
    // 用 classList.toggle(name, force)：状态没变时浏览器不会改写 class 属性，
    // 于是过渡与动画不会重放（直接赋值 className 每次都算一次改动）
    el.root.classList.toggle('done', done);
    el.root.classList.toggle('current', !!active && i === state.criteriaIdx + 1);
    el.root.classList.toggle('just', i === state.criteriaJust || i === state.criteriaJustPts);
    const doneStr = done ? '1' : '0';
    if (el.root.dataset.done !== doneStr) el.root.dataset.done = doneStr;
    const ptsStr = String(earned);
    if (el.root.dataset.pts !== ptsStr) el.root.dataset.pts = ptsStr;
    // 格子上显示这一格的分：**真的拿到**了就是大号亮色数字，还没拿到的用灰色小字标出「可得」
    const got = earned > 0;
    const ptsText = got ? `+${earned}` : (max > 0 ? `+${max}` : '');
    if (el.pts.textContent !== ptsText) el.pts.textContent = ptsText;
    el.pts.classList.toggle('earned', got);
    el.pts.classList.toggle('max', !got);
  }
}

function selectExercise(id) {
  if (!EXERCISES.some((e) => e.id === id)) return;
  if (state.session === 'running' || state.session === 'paused' || state.session === 'countdown') {
    stopSession('switch');
  }
  hideGestureRings();   // 换动作：上一组的手势圆环不该留着（必须在 stopSession 之后收）
  state.exerciseId = id;
  state.settings.exerciseId = id;
  const ex = localizedExercise(id);
  // 目标：限时计数类是**时长（秒）**，从 settings.seconds 取（默认就是动作自己的秒数）
  state.target = ex.timed
    ? (state.settings.seconds?.[id] || ex.seconds || ex.defaultTarget)
    : (state.settings.targets[id] || ex.defaultTarget);
  state.detector = createDetector(id);
  state.calibrator = state.calibrator || new Calibrator(id, { mirror: state.settings.mirror });
  state.calibrator.setExercise(id);
  state.calibrator.setMirror(state.settings.mirror);
  saveSettings();

  document.querySelectorAll('.exercise-btn, .ex-card').forEach((b) => {
    b.classList.toggle('active', b.dataset.id === id);
  });

  $('hudIcon').textContent = ex.icon;
  $('hudName').textContent = ex.name;
  $('hudUnit').textContent = ex.unit;
  $('targetUnit').textContent = ex.unit;
  $('statTimerLabel').textContent = ex.kind === 'hold' ? t('ui.holdTime') : t('ui.setTime');
  $('cameraHint').textContent = `📹 ${ex.cameraHint}`;
  if ($('judgeLine')) {
    $('judgeLine').textContent = `🎯 ${t('home.judgeBy', { what: ex.judgeText })}`
      + (ex.rough ? ` · ${t('home.rough')}` : '');
  }
  $('howtoTitle').textContent = `${ex.icon} ${ex.name} · ${t('ui.actionGuide')}`;
  $('howtoList').innerHTML = ex.howto.map((x) => `<li>${x}</li>`).join('');
  $('tipList').innerHTML = ex.tips.map((x) => `<li>${x}</li>`).join('');
  $('targetInput').value = String(state.target);
  buildTargetChips();
  renderExerciseSettings();
  buildCriteriaBar();          // 判定进度条：换成这个动作的判据链
  $('summaryCard').hidden = true;
  state.stepSig = '';
  state.saidSteps = new Set();
  state.lastScoreMilestone = 0;
  // 选好动作 → 校准一完成就自动开始（这是用户明确选的动作，不用再点一次）
  toCalibration({ silent: true });
  updateHud();
  renderRecords();
}

/**
 * 进入「运动前校准」阶段：显示虚线人体轮廓，不计数。
 *
 * 默认（afterSet=false）：全身识别一完成，虚线框消失并自动进入运动状态（3-2-1 倒计时）。
 * afterSet=true：一组结束后回到校准，先让用户休息 —— 停在原地不会自动开始（画面上的提示条
 *   会写明「点开始训练」）；一旦离开轮廓（站起来、走开），自动开始立刻恢复，再站好就又会自动开始。
 */
function toCalibration({ silent = false, afterSet = false } = {}) {
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  state.countdownStartedAt = 0;
  $('countdown').hidden = true;
  $('celebrate').hidden = true;
  releaseWakeLock();
  state.session = 'calibrating';
  state.autoStart = true;
  state.afterSet = afterSet;
  resetCriteriaProgress();   // 回到校准：进度条从起点等着
  // 新阶段开始：让语音教练可以立刻开口（不受上一阶段的节流限制）
  state.coachAt = -Infinity;
  state.coachSig = '';
  state.calibrator?.reset();
  state.calib = null;
  state.elapsedMs = 0;
  state.goalHit = false;
  // 回到校准：限时计数的「时间到」也一起清掉，下一组重新计时
  state.timeUp = false;
  state.timeCallsSaid = null;
  state.stepSig = '';
  state.lastTick = performance.now();
  if (!silent) {
    setCueLine(t('calib.lead'));
    // 底部状态条在校准阶段不参与（画面上方有专门的提示条），避免同一句话出现两次
    setHint(null);
    audio.say(t('calib.promptIn'), { rate: 1.05, force: true });
  }
  updateButtons();
}

function buildTargetChips() {
  const ex = localizedExercise(state.exerciseId);
  const presets = targetPresetsFor(ex);
  const chips = $('targetChips');
  chips.innerHTML = '';
  for (const v of presets) {
    const b = document.createElement('button');
    b.type = 'button';
    // 限时计数的预设是**时长**（秒），不是次数 —— 用 targetUnit 才不会写错单位
    b.textContent = `${v} ${ex.targetUnit}`;
    b.addEventListener('click', () => setTarget(v));
    chips.appendChild(b);
  }
}

function setTarget(v) {
  const ex = localizedExercise(state.exerciseId);
  const n = clamp(Math.round(Number(v) || ex.defaultTarget), 1, 999);
  state.target = n;
  // 限时计数存到 seconds（时长），其他动作存到 targets（次数）
  if (ex.timed) {
    state.settings.seconds = state.settings.seconds || {};
    state.settings.seconds[state.exerciseId] = n;
  } else {
    state.settings.targets[state.exerciseId] = n;
  }
  $('targetInput').value = String(n);
  saveSettings();
  renderExerciseSettings();
  updateHud();
}

/* ------------------------------------------------------------------ *
 * HUD / 面板刷新
 * ------------------------------------------------------------------ */

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function updateHud() {
  const ex = localizedExercise(state.exerciseId);
  const det = state.detector;
  const isHold = ex.kind === 'hold';
  const timed = !!ex.timed;

  const valid = det ? det.validReps : 0;
  const partial = det ? det.partialReps : 0;
  const holdMs = det ? det.holdMs : 0;
  const score = det ? det.score : 0;
  // 限时计数：剩几秒（时间到后固定显示 0，不会出现负数）
  const totalMs = state.target * 1000;
  const leftSec = timed ? Math.max(0, Math.ceil((totalMs - state.elapsedMs) / 1000)) : 0;

  if (isHold) {
    $('hudValue').textContent = String(Math.floor(holdMs / 1000));
    $('hudSub').textContent = `${t('ui.targetPrefix')} ${state.target} ${ex.unit}`;
  } else {
    // 限时计数：大数字仍然是**次数**（这一组跳了多少下），时长在下面那行
    $('hudValue').textContent = String(valid);
    $('hudSub').textContent = timed
      ? `⏱ ${t('ui.timeLeft', { left: leftSec, total: state.target })}`
      : `${t('ui.targetPrefix')} ${state.target} ${ex.targetUnit}`;
  }
  $('hudScore').textContent = scoreText(score);

  // 进度环：计时类与限时计数类走**时间**进度（还剩多少时间一眼看得出），其余走次数进度
  const progress = isHold
    ? clamp(holdMs / totalMs, 0, 1)
    : (timed ? clamp(state.elapsedMs / totalMs, 0, 1) : clamp(valid / state.target, 0, 1));
  const C = 2 * Math.PI * 52;
  $('ringFg').style.strokeDashoffset = String(C * (1 - progress));
  $('ringFg').style.stroke = progress >= 1 ? 'var(--good)' : 'var(--accent)';
  $('ringText').textContent = `${Math.round(progress * 100)}%`;

  $('hudExtra').textContent = partial > 0
    ? `${t('ui.partial')} ${partial}`
    : (det && det.phase && det.phase !== 'idle' ? t(`phase.${det.phase}`) : '');

  $('statValid').textContent = isHold ? `${(holdMs / 1000).toFixed(1)} ${ex.unit}` : String(valid);
  $('statPartial').textContent = isHold ? '—' : String(partial);
  $('statScore').textContent = scoreText(score);
  $('statTimer').textContent = fmtClock(state.elapsedMs);
  const depth = det ? Math.round(det.depthPct || 0) : 0;
  $('statDepth').textContent = `${depth}%`;
  $('depthFill').style.width = `${depth}%`;

  renderSteps();
}

/**
 * 计数诊断文本（给 🐞 面板用）。
 * 识别器只给「i18n 键 + 数值」，文案在这里按当前语言拼 —— 这样出问题时
 * 用户能直接把这一行念给我：卡在哪个阶段、判定线在哪、上一轮为什么没计上。
 */
function diagText() {
  const det = state.detector;
  if (!det || typeof det.diag !== 'function') return '—';
  let items = [];
  try { items = det.diag() || []; } catch { items = []; }
  return items.map((d) => {
    const label = t(d.key);
    if (d.reject) {
      const why = t(`cue.${d.reject.code}`);
      return `${label} ${why}${d.reject.value ? ` ${d.reject.value}` : ''}`;
    }
    if (d.key === 'debug.diag.pose') return `${label} ${d.value === 'ok' ? t('debug.yes') : t('debug.no')}`;
    return `${label} ${d.value}`;
  }).join(' · ');
}

/** 左下角「退出」圆环那一行：手/脚现在在哪、离圆心几个判定半径（排查「到底有没有识别到手/脚」） */
function touchDiagLine(n) {
  const info = state.touchInfo;
  if (!info || !info.has) return `${t('debug.touch')} ${t('debug.noTouch')}`;
  const kind = info.kind === 'foot' ? t('debug.foot') : t('debug.hand');
  // 进环的是哪个部位（指尖 / 脚跟 / 脚趾尖 …）—— 「一部分进入即可触发」，看一眼就知道是哪个点进去了
  const partKey = `debug.part.${info.part}`;
  const part = info.part ? t(partKey) : '';
  // 估算出来的脚尖单独标出来（真实的脚尖点没量到，用的是「脚跟 + 一个脚掌」那条延长线上的点）
  const est = info.ghost ? t('debug.estTip') : '';
  const where = part && part !== partKey ? `${kind}·${part}${est}` : kind;
  return `${t('debug.touch')} ${where}(${n(info.x, 2)},${n(info.y, 2)})`
    + ` ${t('debug.ringDist')} ${n(info.rel, 2)}`
    + ` ${info.inside ? t('debug.inRing') : (info.near ? t('debug.nearRing') : t('debug.outRing'))}`
    // 靠「整只脚那一段」碰到圆环进的环（脚尖在环里、脚踝还在环外）—— 这一行说明白它是怎么触发的
    + (info.via === 'span' ? ` ${t('debug.byFoot')}` : '')
    + (info.inCount > 0 ? ` ${t('debug.inPoints')} ${info.inCount}` : '');
}

/** 实时指标面板：把识别器“看到的”数字直接摆出来，方便自己判断机位问题 */
function renderDebug(f, outline = null) {
  const el = $('debugLine');
  if (!state.settings.debug) { if (!el.hidden) el.hidden = true; return; }
  el.hidden = false;
  // 虚线轮廓这一帧画了没：排查「识别成功了轮廓还挂在画面上」时看这一行
  const outlineTxt = `${t('debug.outline')} ${outline ? t('debug.yes') : t('debug.no')}`;
  if (!f || !f.ok) {
    el.textContent = `${t('debug.count')} ${diagText()} · ${outlineTxt} · ${t('debug.noPerson')}`;
    return;
  }
  const n = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const mark = (v) => (v ? t('debug.yes') : t('debug.no'));  const snd = audio.state();
  // 机位是否“正确”取决于当前动作：深蹲要正面，其余要侧面
  const wantView = requiredView(state.exerciseId);
  const viewName = f.view === 'front' ? t('debug.viewFront') : t('debug.viewSide');
  // 计数诊断：识别器的内部判定状态（为什么这一下没计上）
  const diag = diagText();
  // 这个动作**真正在判的那个指标**的实时读数 + 进度：
  // 开合跳这类「判据不是关节角」的动作以前面板里看不到被判的量，调不动也没法自查 —— 现在都摆出来。
  const judged = judgedMetricLine(f, n);
  el.textContent = [
    `${t('debug.count')} ${diag || '—'}`,
    judged,
    `${t('debug.view')} ${viewName}${mark(f.view === wantView)}(${n(f.viewRatio, 2)})`,
    `${t('debug.bodyVisible')} ${mark(f.bodyVisible)}`,
    `${t('debug.legsVisible')} ${mark(f.legsVisible)}`,
    `${t('debug.trunkLean')} ${n(f.trunkLean)}°`,
    `${t('debug.knee')} ${n(f.kneeAngle)}°`,
    `${t('debug.elbow')} ${n(f.elbowAngle)}°`,
    `${t('debug.hip')} ${n(f.hipAngle)}°`,
    `${t('debug.bodyStraight')} ${n(f.bodyStraight)}°`,
    `${t('debug.hipRise')} ${n(f.hipRise, 2)}`,
    // 站立门控（勾腿跳用的 standUpright）判的是**正数版**「肩高于髋」：
    // 站着 ≈ +1.0，躺下 ≈ 0。两行互为相反数，排查「说我没站好」看这一行。
    `${t('debug.shoulderAboveHip')} ${n(f.shoulderAboveHip, 2)}`,
    `${t('debug.kneeClear')} ${n(f.kneeClear, 2)}`,
    `${t('debug.hipClear')} ${n(f.hipClear, 2)}`,
    `${t('debug.thighFromHoriz')} ${n(f.thighFromHoriz)}°`,
    `${t('debug.visibility')} ${n(f.coreVis, 2)}`,
    touchDiagLine(n),
    `🔊 ${t('debug.sound')} ${snd.ctx}/${snd.voices}`,
    outlineTxt,
    `${t('debug.state')} ${state.session}`,
  ].filter(Boolean).join(' · ');
}

/**
 * 「本动作判的是哪个量」那一行：`🎯 双腿开合距离 0.83（进度 52%）`。
 *
 * 指标名走 specs.js 的同一份映射（`metric.<名字>`，和 🎯 运动设定弹窗里显示的名字完全一致），
 * 数值走 `SPEC_METRICS`（识别器真正在判的那个量）。判据不是本表里的量（手写识别器）时不显示这一行。
 */
function judgedMetricLine(f, n) {
  const meta = EXERCISE_MAP[state.exerciseId];
  const name = meta?.params?.metric;
  const read = name && SPEC_METRICS[name];
  if (!read) return '';
  const value = read(f, state.detector);
  if (!Number.isFinite(value)) return '';
  const pct = Number.isFinite(state.detector?.progress)
    ? `（${t('debug.progress')} ${Math.round(Math.max(0, Math.min(1, state.detector.progress)) * 100)}%）`
    : '';
  return `🎯 ${t(`metric.${name}`)} ${n(value, 2)}${pct}`;
}

/** 要领清单：已完成的打勾，当前该做哪一步高亮 */
function renderSteps() {
  const det = state.detector;
  const ul = $('stepList');
  if (!det) { ul.innerHTML = ''; return; }
  const steps = det.stepStatus();
  const sig = `${getLang()}|${det.cycle}|${det.score}|${steps.map((s) => (s.done ? 1 : 0)).join('')}`;
  if (sig === state.stepSig) return;
  state.stepSig = sig;

  const firstPending = steps.findIndex((s) => !s.done);
  ul.innerHTML = steps.map((s, i) => {
    const cls = s.done ? 'done' : (i === firstPending ? 'current' : '');
    const mark = s.done ? '✓' : (i === firstPending ? '▸' : '○');
    return `<li class="step-item ${cls}">`
      + `<span class="step-check">${mark}</span>`
      + `<span class="step-label">${t(s.labelKey)}</span>`
      + `<span class="step-pts">+${s.points}</span></li>`;
  }).join('');
  $('scoreBadge').textContent = scoreText(det.score);

  // 下一步的“卡点说明”单独放在列表下方，逐帧刷新也不会打断打勾动画
  const pending = det.pendingHint();
  const hintEl = $('stepHint');
  if (pending) {
    const label = t(pending.labelKey);
    hintEl.textContent = pending.hint
      ? t('ui.nextStepWithHint', { label, hint: t(pending.hint.key, pending.hint.params) })
      : t('ui.nextStepNoHint', { label });
    hintEl.className = 'step-hint warn';
  } else {
    hintEl.textContent = t('ui.stepsAllDone');
    hintEl.className = 'step-hint good';
  }
}

function showScorePop(text, kind = 'step') {
  const el = $('scorePop');
  el.textContent = text;
  el.className = `score-pop ${kind}`;
  void el.offsetWidth;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 900);
}

function setHint(text, level, ms = 2600) {
  const el = $('poseHint');
  if (!text) {
    el.hidden = true;
    state.hintUntil = 0;
    return;
  }
  el.textContent = text;
  el.className = 'pose-hint ' + level;
  el.hidden = false;
  // ms >= 1000 视为“重要提示”：在它过期前不覆盖（逐帧状态提示用 700ms，不会抢占）
  if (ms >= 1000) state.hintUntil = performance.now() + ms;
}

function setCueLine(text, level = '') {
  const el = $('cueLine');
  el.textContent = text;
  el.className = 'cue-line' + (level ? ' ' + level : '');
}

/** 数值跳一下：次数和分数共用一套（用户要求分数紧贴次数显示，两个数一起跳才像一组） */
function pulseEl(el) {
  if (!el) return;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
  setTimeout(() => el.classList.remove('pop'), 160);
}

function pulseValue() {
  pulseEl($('hudValue'));
}

/** 分数变化时（要领加分 / 每秒加分 / 计上一次）也跳一下 */
function pulseScore() {
  pulseEl($('hudScore'));
}

/* ------------------------------------------------------------------ *
 * 计时类动作读秒：每 5 秒播报一次秒数
 *
 * 用户要求：平板支撑要读秒，每 5 秒读一次，语音播报「5 秒」「10 秒」…
 * 计时类动作（平板支撑 / 两种体前屈）都走这一段：
 *   - 用识别器自己的 holdMs 算秒数（不是自己数帧），所以暂停/恢复后接着数，不会重头念；
 *   - 计时归零（新一组 / 换动作 / 重置计数）→ 自动从 5 秒重新开始读；
 *   - 和「要领达标」的语音撞在同一帧时让读秒先说，免得两句叠在一起听不清。
 * ------------------------------------------------------------------ */

/** 每隔几秒读一次 */
const HOLD_COUNT_EVERY = 5;

/** 语音 + 屏幕上同时跳一下秒数；返回这一帧要不要读 */
function announceHoldCount(det, ex, now) {
  if (!det || !ex || ex.kind !== 'hold') return false;
  const sec = Math.floor((det.holdMs || 0) / 1000);
  // 计时归零：重新装填，下一组从头从 5 秒开始读
  if (sec <= 0) {
    state.holdCountNext = HOLD_COUNT_EVERY;
    return false;
  }
  if (sec < (state.holdCountNext || HOLD_COUNT_EVERY)) return false;
  // 一次只读一个整数（暂停很久再恢复、秒数跳过了也只读当前这一档，不会连珠炮）
  const n = sec - (sec % HOLD_COUNT_EVERY);
  state.holdCountNext = n + HOLD_COUNT_EVERY;
  state.holdCountAt = now;
  audio.sayTime(n * 1000);   // 「5 秒」/「10 秒」…（语音开关关掉时自然不出声）
  pulseValue();              // 屏幕上的秒数同时跳一下，听不见也看得见
  pulseScore();              // 计时类每秒 +1 分，分数跟着一起跳
  return true;
}

/**
 * 限时计数（开合跳）的剩余时间播报。
 *
 * 用户要求「固定 60 秒，看能跳多少次」——那么「还剩多少时间」必须听得见，
 * 否则跳到一半完全没概念。规则很简单：剩余 **45 / 30 / 15 秒** 各报一次，
 * 最后 **5 秒**再单独喊一句冲刺（每一档只报一次，重复报会很吵）。
 * 时间与次数的语音分工：次数照旧每 5 次报一次（speakEvery），这里只管时间。
 */
const TIME_CALL_AT = [45, 30, 15, 5];

function announceTimeLeft(ex, now) {
  if (!ex || !ex.timed || state.timeUp) return false;
  const left = Math.ceil((state.target * 1000 - state.elapsedMs) / 1000);
  if (!state.timeCallsSaid) state.timeCallsSaid = new Set();
  // 从大到小找出「已经到点、但还没报过」的那一档（一帧只报一档，不会连珠炮）
  const hit = TIME_CALL_AT
    .filter((t) => t < state.target && left <= t && !state.timeCallsSaid.has(t))
    .sort((a, b) => b - a)[0];
  if (hit === undefined) return false;
  for (const t of TIME_CALL_AT) if (t >= hit) state.timeCallsSaid.add(t);   // 中间跳过的档也一起标掉
  audio.say(hit === 5 ? t('speech.timeLast5') : t('speech.timeLeft', { n: hit }), { rate: 1.15 });
  pulseValue();
  return true;
}

function updatePipelineStatus() {
  const parts = [];
  if (camera.active) {
    parts.push(t('status.cameraReady', { w: camera.video.videoWidth, h: camera.video.videoHeight }));
    $('camDot').classList.add('on');
  } else {
    parts.push(t('status.cameraOff'));
    $('camDot').classList.remove('on');
  }
  if (state.engineReady) {
    const model = t(state.settings.modelKey === 'full' ? 'ui.modelFull' : 'ui.modelLite');
    parts.push(t('status.modelReadyShort', { model, delegate: engine.delegate || 'CPU' }));
    parts.push(state.poseHits > 0 ? t('status.personFound') : t('status.searching'));
  } else if (camera.active) {
    parts.push(t('status.modelLoading'));
  }
  $('camStatus').textContent = parts.join(' · ');
}

/* ------------------------------------------------------------------ *
 * 训练流程
 * ------------------------------------------------------------------ */

function ensureDetector() {
  if (!state.detector || state.detector.meta.id !== state.exerciseId) {
    state.detector = createDetector(state.exerciseId);
  }
  return state.detector;
}

function startSession() {
  if (!camera.active) {
    setHint(t('status.needCamera'), 'warn', 2600);
    return;
  }
  if (state.session === 'calibrating') {
    setHint(t('calib.needCalib'), 'warn', 2600);
    return;
  }
  if (state.session === 'running') return;
  if (state.session === 'paused') { resumeSession(); return; }
  if (state.session === 'countdown') return;

  beginCountdown();
}

/**
 * 真正开始一组：3-2-1 倒计时 → 计数。
 * 两条路径都会走到这里：校准识别完成后自动开始，以及用户手动点「开始训练」/按空格。
 */
function beginCountdown() {
  try { audio.unlock(); } catch { /* 音频初始化失败不影响开始训练 */ }
  hideGestureRings();   // 要开始新的一组了，圆环先收起来
  const det = ensureDetector();
  // 注意：不重置计数与得分。识别从选好动作那一刻就开始反馈，
  // 开始一组只是开始计时/记一组，方便用户先摆好姿势拿到要领分。
  state.elapsedMs = 0;
  state.goalHit = false;
  state.saidSteps = new Set();
  state.lastScoreMilestone = 0;
  state.stepSig = '';
  state.lastTick = performance.now();
  $('summaryCard').hidden = true;
  $('celebrate').hidden = true;
  setCueLine(`📹 ${localizedExercise(state.exerciseId).cameraHint}`);
  requestWakeLock();

  state.session = 'countdown';
  state.countdownStartedAt = performance.now();
  // 限时计数：倒计时结束才开始计时，所以这里先把「时间到」清掉
  state.timeUp = false;
  state.timeCallsSaid = new Set();
  // 一组开始：教练可以立刻念第一条指令
  state.coachAt = -Infinity;
  state.coachSig = '';
  let n = 3;
  $('countdownNum').textContent = String(n);
  $('countdown').hidden = false;
  audio.tick();
  audio.sayCountdown(n);

  clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(() => {
    n -= 1;
    if (n > 0) {
      $('countdownNum').textContent = String(n);
      $('countdownNum').style.animation = 'none';
      void $('countdownNum').offsetWidth;
      $('countdownNum').style.animation = '';
      audio.tick();
      audio.sayCountdown(n);
    } else {
      finishCountdown(det);
    }
  }, 850);
  updateButtons();
}

/**
 * 倒计时结束，正式开始计数。
 * 定时器与「渲染循环里的时间兜底」都会调用它，所以做成幂等的：
 * 浏览器把定时器节流/暂停时（例如切到别的标签页再回来），靠这里兜底推进，
 * 不会一直停在「3」上。
 */
function finishCountdown(det = state.detector) {
  if (state.session !== 'countdown') return;
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  state.countdownStartedAt = 0;
  $('countdown').hidden = true;
  state.session = 'running';
  state.lastTick = performance.now();
  det?.resetClock?.();
  audio.go();
  audio.sayStart();
  // 限时计数（开合跳）：一开始就把规则说清楚 —— 固定多少秒、成绩是这段时间里的次数
  const startEx = localizedExercise(state.exerciseId);
  setCueLine(startEx.timed
    ? t('status.timedGo', { sec: state.target })
    : t('status.countdownGo'), 'good');
  updateButtons();
}

function pauseSession() {
  if (state.session !== 'running') return;
  state.session = 'paused';
  audio.pause();
  setCueLine(t('status.paused'));
  setHint(t('status.paused'), 'warn', 2000);
  updateButtons();
}

function resumeSession() {
  if (state.session !== 'paused') return;
  state.session = 'running';
  state.lastTick = performance.now();
  state.detector?.resetClock?.();
  setCueLine(t('status.resume'));
  updateButtons();
}

function stopSession(reason = 'user') {
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  $('countdown').hidden = true;
  const wasActive = state.session === 'running' || state.session === 'paused' || state.session === 'countdown';
  state.session = 'calibrating';
  releaseWakeLock();
  if (!wasActive) { updateButtons(); offerSetChoices(); return; }

  const det = state.detector;
  const ex = localizedExercise(state.exerciseId);
  if (!det) { updateButtons(); offerSetChoices(); return; }

  const isHold = ex.kind === 'hold';
  const timed = !!ex.timed;
  const value = isHold ? Math.round(det.holdMs / 1000) : det.validReps;
  const score = det.score;
  const steps = det.stepStatus();
  const doneCount = steps.filter((s) => s.done).length;
  const hasWork = value > 0 || det.partialReps > 0 || score > 0;
  if (hasWork) saveSession({ ex, value, partial: det.partialReps, reason, score });
  // 本组结果也念出来（以语音为主：用户不必转头看小结卡）。
  // **只念次数 / 时长 + 一句夸奖，不念分数**（用户要求：语音一律不报分数）——
  // 分数照旧显示在结算面板与记录里。
  if (hasWork) {
    state.setPraiseSeed = (state.setPraiseSeed || 0) + 1;
    const praise = poolLine('speech.praiseSet', state.setPraiseSeed);
    // 限时计数报「60 秒完成 N 次」：这才是这个动作的成绩（次数 + 时长一起说清楚）
    audio.say(timed
      ? t('speech.timedSummary', { value, sec: state.target, praise })
      : t('speech.setSummary', { value, unit: ex.unit, praise }), { rate: 1.15, force: true });
  }

  const items = [
    [t('ui.colAction'), `${ex.icon} ${ex.name}`],
    [t('ui.colScore'), scoreText(score)],
    [isHold ? t('ui.colHold') : t('ui.colValidReps'), `${value} ${ex.unit}`],
    // 完成度：计时类与限时计数类按**时间**算（时间到 = 100%），其余按次数算
    [t('ui.colCompletion'), `${Math.round(clamp(
      isHold ? det.holdMs / (state.target * 1000)
        : (timed ? state.elapsedMs / (state.target * 1000) : value / state.target),
      0, 1.5,
    ) * 100)}%`],
    [t('ui.colSteps'), t('ui.stepsDoneRatio', { done: doneCount, total: steps.length })],
    [t('ui.colElapsed'), fmtClock(state.elapsedMs)],
  ];
  $('summaryGrid').innerHTML = items
    .map(([k, v]) => `<div class="summary-item"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');
  const missed = steps.filter((s) => !s.done).map((s) => t(s.labelKey));
  $('summaryNote').textContent = reason === 'goal'
    ? (timed
      ? t('summary.timedDone', { sec: state.target, n: value, score })
      : t('summary.goalReached', { score }))
    : (hasWork
      ? (missed.length
        ? t('summary.savedWithMiss', { score, list: missed.join('、') })
        : t('summary.savedAll', { score }))
      : t('summary.noData'));

  audio.finish();
  det.reset();
  state.elapsedMs = 0;
  state.timeUp = false;
  state.timeCallsSaid = null;
  setCueLine(t('status.setDone'));
  updateHud();
  renderHistory();
  renderRecords();
  setHint('', 'warn', 0);
  // 一组结束后回到校准阶段：下一组开始前重新确认站位与机位，
  // 但这一轮不再自动开始（autoStart: false），给用户留出休息和小结的时间。
  toCalibration({ silent: false, afterSet: true });
  // 手上都是汗、离键盘远：一组做完直接把「退出 / 再做一次」摆成两个手势圆环
  offerSetChoices();
}

/**
 * 一组结束后提供的两个选择（退出 / 再做一次）。
 *
 * **所有动作都是这条路**：计数的、计时的（平板支撑 / 体前屈）都一样 ——
 * 只要是在动作页上结束了一组，就把两个圆环摆出来，用户可以把手掌停在圆环里选，
 * 也可以直接点。只在主页上不摆（那儿根本没有「这一组」）。
 */
function offerSetChoices() {
  if (state.homeMode || !state.detector) return;
  showGestureRings();
}

function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  navigator.wakeLock.request('screen').then((l) => { state.wakeLock = l; }).catch(() => {});
}
function releaseWakeLock() {
  try { state.wakeLock?.release(); } catch { /* ignore */ }
  state.wakeLock = null;
}

function updateButtons() {
  const running = state.session === 'running';
  const paused = state.session === 'paused';
  const calibrating = state.session === 'calibrating';
  const busy = running || paused || state.session === 'countdown';
  const label = calibrating ? t('calib.waiting') : (running ? t('ui.training') : (paused ? t('ui.resume') : t('ui.start')));
  $('btnStart').textContent = label;
  $('btnStart').disabled = running || calibrating || state.session === 'countdown';
  $('btnPause').textContent = paused ? t('ui.resume') : t('ui.pause');
  $('btnPause').disabled = !(running || paused);
  $('btnStop').disabled = !busy;
  $('btnResetReps').disabled = !state.detector;
  const rc = $('btnRecalibrate');
  if (rc) rc.disabled = calibrating;
  const card = $('calibCard');
  if (card) card.hidden = !calibrating;
  renderCriteriaBar();   // 判定进度条只在「训练中」出现，跟着会话状态显示/隐藏
}

/* ------------------------------------------------------------------ *
 * 记录
 * ------------------------------------------------------------------ */

function saveSession({ ex, value, partial, reason, score = 0 }) {
  const history = loadList(STORE.history);
  history.unshift({
    at: Date.now(),
    exerciseId: ex.id,
    kind: ex.kind,
    unitKey: ex.unitKey,
    value,
    score,
    partial,
    target: state.target,
    // 限时计数：把时长一起记下来，记录里才能写成「52 次 / 60 秒」
    seconds: ex.timed ? state.target : 0,
    durationMs: Math.round(state.elapsedMs),
    reached: reason === 'goal',
  });
  saveList(STORE.history, history.slice(0, 40));

  const records = loadRecords();
  const cur = records[ex.id];
  const betterScore = !cur || score > (cur.score || 0);
  const betterValue = !cur || value > (cur.value || 0);
  if (value > 0 || score > 0) {
    records[ex.id] = {
      value: betterValue ? value : cur.value,
      score: betterScore ? score : (cur.score || 0),
      // 最好成绩那一次是什么时长（限时计数类）
      seconds: ex.timed ? (betterScore || betterValue ? state.target : (cur.seconds || state.target)) : 0,
      at: Date.now(),
    };
    saveList(STORE.records, records);
  }
}

function loadRecords() {
  try { return JSON.parse(localStorage.getItem(STORE.records) || '{}') || {}; } catch { return {}; }
}

function renderRecords() {
  const records = loadRecords();
  const ul = $('recordList');
  ul.innerHTML = '';
  let any = false;
  for (const meta of EXERCISES) {
    const r = records[meta.id];
    if (!r) continue;
    any = true;
    const ex = localizedExercise(meta.id);
    // 限时计数（开合跳）：成绩要带上时长，「52 次 / 60 秒」这样才说得清
    const sec = ex.timed ? (r.seconds || ex.seconds || 0) : 0;
    const li = document.createElement('li');
    li.innerHTML = `<span class="r-name">${ex.icon} ${ex.name}</span>`
      + `<span class="r-val">${r.value} ${ex.unit}${sec ? ` / ${sec} ${ex.targetUnit}` : ''}</span>`
      + `<span class="r-score">${scoreText(r.score || 0)}</span>`;
    ul.appendChild(li);
  }
  if (!any) ul.innerHTML = `<li class="empty">${t('ui.noRecords')}</li>`;
}

function renderHistory() {
  const history = loadList(STORE.history);
  const ul = $('historyList');
  ul.innerHTML = '';
  if (!history.length) {
    ul.innerHTML = `<li class="empty">${t('ui.noHistory')}</li>`;
    return;
  }
  const localeTag = getMeta().htmlLang || getLang();
  for (const h of history.slice(0, 12)) {
    const d = new Date(h.at);
    const when = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
      + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const ex = localizedExercise(h.exerciseId);
    const li = document.createElement('li');
    li.dataset.locale = localeTag;
    li.innerHTML = `<span class="h-when">${when}</span>`
      + `<span class="h-what">${ex ? `${ex.icon} ${ex.name}` : h.exerciseId}${h.reached ? ' 🎉' : ''}</span>`
      + `<span class="h-val">${h.value} ${ex ? ex.unit : ''}${ex && h.seconds ? ` / ${h.seconds} ${ex.targetUnit}` : ''}</span>`
      + `<span class="h-score">${scoreText(h.score || 0)}</span>`;
    if (h.partial > 0) li.querySelector('.h-what').title = `${t('ui.partial')} ${h.partial}`;
    ul.appendChild(li);
  }
}

/** 校准面板：逐项打勾 + 进度 + 当前该做的一件事 */
function renderCalibration(calib) {
  const card = $('calibCard');
  if (!card) return;
  renderCalibPrompt(calib);
  if (!calib) {
    if (!card.hidden) card.hidden = true;
    return;
  }
  card.hidden = false;
  const sig = `${getLang()}|${calib.checks.map((c) => (c.ok ? 1 : (c.blocking ? 0 : 2))).join('')}`;
  if (sig !== state.calibSig) {
    state.calibSig = sig;
    $('calibList').innerHTML = calib.checks.map((c) => {
      // ✓ 达标；○ 必须项没达标（会拦着开始）；· 建议项没达标（不拦人，只是建议站得更准）
      const mark = c.ok ? '✓' : (c.blocking ? '○' : '·');
      const cls = c.ok ? ' done' : (c.blocking ? '' : ' soft');
      return `<li class="calib-item${cls}">`
        + `<span class="calib-check">${mark}</span>`
        + `<span>${t(`calib.check.${c.id}`)}</span></li>`;
    }).join('');
  }
  const okCount = calib.checks.filter((c) => c.ok).length;
  $('calibBadge').textContent = `${okCount}/${calib.checks.length}`;
  $('calibFill').style.width = `${Math.round(calib.progress * 100)}%`;
  const hintEl = $('calibHint');
  hintEl.textContent = t(calib.hintKey, calib.hintParams);
  // 必须项都过了、只是建议项没达标时用柔和配色，别让人以为「还没法开始」
  hintEl.className = `calib-hint ${calib.ready ? (calib.advisory ? 'soft' : 'good') : 'warn'}`;
}

/**
 * 压在人像上方的文字引导。
 * 用户看的始终是画面，所以「站进虚线轮廓内」这句话必须出现在画面上，
 * 而不是只在右侧面板里；第二行再补上「这一帧还差什么」。
 */
function renderCalibPrompt(calib) {
  const box = $('calibPrompt');
  if (!box) return;
  if (!calib) {
    if (!box.hidden) box.hidden = true;
    return;
  }
  const noBody = calib.hintKey === 'calib.visible';
  const confirmed = state.session === 'ready';
  let mainKey = 'calib.promptIn';
  let level = 'warn';
  if (confirmed) {
    mainKey = 'calib.startNow';
    level = 'ready';
  } else if (calib.ready) {
    mainKey = 'calib.promptReady';
    level = 'ready';
  } else if (noBody) {
    mainKey = 'calib.promptSearch';
    level = 'search';
  }
  // 具体差在哪：只在「人已识别但还没就位」时补充，避免与主提示重复
  const sub = (!confirmed && !calib.ready && !noBody) ? t(calib.hintKey, calib.hintParams) : '';
  const mainEl = $('calibPromptMain');
  const subEl = $('calibPromptSub');
  const mainText = t(mainKey);
  if (mainEl.textContent !== mainText) mainEl.textContent = mainText;
  if (subEl.textContent !== sub) subEl.textContent = sub;
  const cls = `calib-prompt ${level}`;
  if (box.className !== cls) box.className = cls;
  // 一组做完、两个手势圆环摆出来的时候，画面上方只留一条提示（手势怎么用）——
  // 这时候这条提示不显示（会和圆环抢注意力，也占同一块位置）。
  // 但**文字照样更新**：圆环收起来之后它必须立刻是对的，否则会留着上一帧的旧话
  //（例如识别已经成功、却还写着「保持不动…」，用户会以为白站了）。
  box.hidden = !!gestureState.visible;
}

/**
 * 校准阶段的一帧处理：跑就位判定，识别完成后按设置自动进入运动状态。
 * 返回这一帧要画的虚线轮廓参数（**识别成功后一律返回 null** → 虚线轮廓立刻消失）。
 *
 * 虚线轮廓的职责只有一条：**在你还没就位时告诉你要站到哪儿**。
 * 所以它的显示规则是「没就位才画，一就位就消失」，对所有动作、所有阶段都一样：
 *   - 没找到人 / 没站好      → 画（亮蓝 / 亮琥珀，画面上的提示条同时告诉你怎么调整）；
 *   - 就位判定通过并保持住   → 立刻隐藏（第一次自动开始、一组做完的休息态都是这样）。
 * 为什么以前「休息态」会一直留一条绿色轮廓：那一轮故意不自动开始，轮廓被当成
 * 「你已经站好了，可以点开始」的指示灯留着；用户反馈「进了运动状态还有虚线轮廓」，
 * 于是改成统一规则 —— 轮廓只做引导，不做指示灯（就位后由提示条与「开始训练」按钮负责）。
 */
function calibrationStep(frame, now) {
  const calib = state.calibrator.update(frame, now);
  state.calib = calib;
  const outlineOf = (status) => ({
    kind: state.calibrator.kind,
    status,
    // 侧拍时人可能朝左：轮廓跟着翻，头脚方向才不会反
    flip: state.calibrator.facing < 0,
  });

  // 一组结束后先休息：停在原地不自动开始（提示条会写明要自己点「开始训练」）；
  // 一旦从画面里消失（站起来走开、喝水），自动开始立刻重新装填，再站好就又会自动开始。
  // 注意：这里**不再顺手收起手势圆环** —— 卧姿类动作（臀桥 / 卷腹 / 平板 / 坐姿体前屈）做完时
  // 人本来就不在「站立轮廓」里，如果按「离开轮廓」就收圆环，这些动作做完根本选不了。
  // 圆环只在「真的要开始下一组」或用户选择/换动作/回主页时才收。
  const lost = !calib.checks.length || (calib.checks[0].id === 'visible' && !calib.checks[0].ok);
  if (state.afterSet && lost) state.afterSet = false;

  // 全身识别完成（七项全部达标并保持住）
  if (calib.done && state.session === 'calibrating') {
    state.session = 'ready';
    state.lastTick = now;
    audio.milestone();
    setCueLine(t('calib.startNow'), 'good');
    updateButtons();
    // 校准阶段的引导统一走画面上方的提示条：底部状态条收起来，避免同一句话出现两次
    setHint(null);
    if (state.autoStart && !state.afterSet) {
      // 识别完成 → 虚线框消失，直接进入运动状态（3-2-1 倒计时后开始计数）。
      // 这里不再单独念「校准完成」：紧接着的倒计时语音会把它打断。
      renderCalibration(null);
      try {
        beginCountdown();
        return null;
      } catch (err) {
        // 自动开始万一失败（浏览器差异导致初始化异常等），绝不能把用户卡在绿色轮廓上：
        // 退回「手动点开始训练」这条老路，并把错误抛到控制台（页面底部会显示红色错误条）
        state.autoStart = false;   // 自动开始失败：退回手动，避免把用户卡在绿色轮廓上
        console.error('auto start failed:', err);
        renderCalibration(calib);
        return null;               // 识别已经成功：轮廓照样收起来，别再挂在画面上
      }
    }
    // 一组结束后的再次校准：这一轮不自动开始，等用户自己点「开始训练」。
    // 轮廓同样立刻收起 —— 就位了就不再需要引导（提示条会写「点开始训练」）。
    audio.say(t('calib.doneVoice'), { rate: 1.15, force: true });
    renderCalibration(calib);
    return null;
  }

  renderCalibration(calib);
  setHint(null);
  // 校准阶段的每一条提示也念出来：站位、机位、有没有进画面，都不要用户去看屏幕
  coachSay(t(calib.hintKey, calib.hintParams), {
    gapMs: 2600, dedupeMs: 12000, key: `calib:${calib.hintKey}`,
  });
  // 已经就位（这一轮校准早就完成、session 已是 ready）后又回到就位状态：轮廓依旧不画。
  // 只有真的离开就位状态（人出画、站偏）时轮廓才重新出现，用来把人领回轮廓里。
  if (calib.done) return null;
  return outlineOf(!frame.ok ? 'search' : (calib.ready ? 'ready' : 'adjust'));
}

/* ------------------------------------------------------------------ *
 * 事件处理
 * ------------------------------------------------------------------ */

function feedDetector(f, now) {
  const det = state.detector;
  if (!det) return [];
  // 只有真正开始训练后才计数：校准阶段、倒计时、暂停阶段都不累计。
  // 这道门控放在这里而不是调用处，避免以后新增调用点忘了加判断。
  if (state.session !== 'running') return [];
  // 限时计数（开合跳）：时间已经到了 → 这一组立刻停止计次。
  // 「时间到」到真正结算之间还有 2.6 秒庆祝动画，那几秒里多跳的几下不该算进 60 秒的成绩。
  if (state.timeUp) return [];
  return det.update(f, now);
}

/**
 * 画面下方的状态条：任何时刻都要说清「现在是什么状态、卡在哪一步」。
 * 单独抽出来是为了两条纪律：
 *   1) 有待完成的要领时绝不回落成「已识别到你 ✓」这种空话（那会让人以为一切正常、
 *      却在等一个永远不会来的反馈）；
 *   2) 识别器缺失这类异常必须显式写出来，而不是安静地什么都不显示。
 */
function updateStatusHint(frame, now) {
  if (now <= state.hintUntil) return;
  const det = state.detector;
  if (!frame || !frame.ok) {
    setHint(t('status.noPerson'), 'bad', 700);
    // 找不到人也要主动说话：这是最容易「不知道发生了什么」的时刻
    coachSay(t('speech.noPerson'), { gapMs: 4000, dedupeMs: 15000, key: 'noPerson' });
    return;
  }
  if (!det) { setHint(t('status.noDetector'), 'bad', 700); return; }
  const pending = det.pendingHint();
  const recentCue = det.feedback && now - det.feedback.at < 3200 ? det.feedback : null;
  if (pending) {
    setHint(pending.hint
      ? t('ui.nextStepWithHint', { label: t(pending.labelKey), hint: t(pending.hint.key, pending.hint.params) })
      : t('ui.nextStepNoHint', { label: t(pending.labelKey) }), 'warn', 700);
    // 「下一步做什么」也要念出来（带具体差多少的提示，念出来才是真的在教）
    const label = t(pending.labelKey);
    // 用户反馈「指导太多、缺少鼓励」：指导放慢一倍多，把话语权留给报数与激励
    coachSay(pending.hint
      ? t('speech.nextStep', { label, hint: t(pending.hint.key, pending.hint.params) })
      : t('speech.nextStepNoHint', { label }),
    { gapMs: 9000, dedupeMs: 35000, key: `step:${pending.id}` });
    return;
  }
  if (recentCue) {
    setHint(t(recentCue.key, recentCue.params), recentCue.level, 700);
    return;
  }
  if (!det.active && det.standby) {
    setHint(t(det.standby), 'warn', 700);
    coachSay(t(det.standby), { gapMs: 3000, dedupeMs: 15000, key: det.standby });
    return;
  }
  setHint(t('status.ready'), 'good', 700);
}

/**
 * 语音教练：把画面上的提示同步念出来 —— 这个应用是**以语音提示为主**的，
 * 用户不该盯着屏幕才知道下一步做什么、哪里不对、有没有被看到。
 *
 * 三条纪律（避免变成唠叨）：
 *   1) 全局最小间隔（gapMs）：一句话说完之后短时间内不再插话；
 *   2) 同一句话短时间内不重复（dedupeMs）：比如「请站到画面中间」不必每帧都念；
 *   3) 用 force 打断上一句：**最新的指示比正在念的旧话更重要**。
 */
function coachSay(text, { gapMs = 2500, dedupeMs = 12000, key = '' } = {}) {
  if (!text || !state.settings.voice) return;
  const now = performance.now();
  const sig = key || text;
  if (sig === state.coachSig && now - state.coachAt < dedupeMs) return;
  if (now - state.coachAt < gapMs) return;
  state.coachSig = sig;
  state.coachAt = now;
  audio.say(text, { force: true, rate: 1.12 });
}

/**
 * 语音策略（用户反馈：指导太多、缺少鼓励）：
 *   - **每做一个动作都要报数**（sayRep 用 force，不会被别的提示吞掉）；
 *     节奏特别快的动作例外：`catalog.js` 里写 `speakEvery: 10` 的动作（开合跳）**每 10 次才报一次**
 *     —— 用户反馈「动作太快，每次都报数根本听不清」，而且报数本身也会拖慢节奏；
 *   - 每 ENCOURAGE_EVERY 次给一句**激励**（加油 / 太棒了 / 继续坚持 …），轮换不重复；
 *     快节奏动作同样按 `speakEvery` 降频（10 次说一句），不然一组 50 次要念十几句；
 *   - 纠正提示保留但**适度**：同一句话长去重、组内做过 3 次之后进一步降频。
 */
const ENCOURAGE_EVERY = 3;

/** 这个动作每做几次报一次数 / 说一句激励（catalog 里的 speakEvery，默认 1 = 每次都报） */
function speakEveryOf() {
  return Math.max(1, EXERCISE_MAP[state.exerciseId]?.speakEvery || 1);
}

/** 屏幕上的激励语：跟语音同一个池子，轮着显示，不重复上一句 */
function pickEncourageHint(seed) {
  const pool = t('speech.encourage');
  const list = Array.isArray(pool) ? pool : [String(pool)];
  if (!list.length) return '';
  const line = list[Math.abs(Math.round(seed)) % list.length];
  return line === state.lastEncourageHint ? list[(Math.abs(Math.round(seed)) + 1) % list.length] : line;
}

function handleEvents(events, now = performance.now()) {
  const det = state.detector;
  if (!det) return;
  const running = state.session === 'running';

  for (const ev of events) {
    if (ev.type === 'step') {
      // 每一步要领达标：立刻响铃 + 加分飘字，第一次完成时还用语音念出要领
      audio.step(ev.index, ev.total);
      showScorePop(`+${ev.points}`);
      pulseScore();
      if (!state.saidSteps.has(ev.id)) {
        state.saidSteps.add(ev.id);
        // 和「5 秒 / 10 秒」读秒撞在同一帧时，让读秒先说：两句叠在一起谁都听不清
        if (now - (state.holdCountAt || -1e9) > 400) audio.sayStep(t(ev.labelKey));
      }
      checkScoreMilestone(ev.score);
    } else if (ev.type === 'bonus') {
      audio.bonus();
      showScorePop(`${t('ui.stepsAllDone')} +${ev.points}`, 'bonus');
      pulseScore();
      // 整轮关键帧全做到：夸一句（用户要求「多给点情绪价值」）。
      // 稍微延后一点：满分奖励和「计上一次」的报数常常在同一帧，晚 0.9 秒念才不会把报数顶掉。
      state.roundPraiseSeed = (state.roundPraiseSeed || 0) + 1;
      const praise = poolLine('speech.praiseRound', state.roundPraiseSeed);
      if (praise) setTimeout(() => audio.say(praise, { rate: 1.18, force: true, pitch: 1.14 }), 900);
    } else if (ev.type === 'points') {
      audio.scoreTick();
      pulseScore();
      checkScoreMilestone(ev.score);
    } else if (ev.type === 'rep') {
      // 一次动作结束（有效或半程）→ 进度条**点亮最后一格**并保持 0.65 秒（让用户看到「这一轮走完了」），
      // 之后自动收回起点，下一轮重新一格一格走。
      // 注意：识别器真正计上的那一次，这里会把整条链补满 —— 保证「做完了就一定显示做完」。
      const last = state.criteriaStages.length - 1;
      if (last >= 0) {
        state.criteriaIdx = last;
        state.criteriaJust = last;
        state.criteriaClearUntil = now + CRITERIA_CLEAR_MS;
      }
      renderCriteriaBar(now);
      if (ev.valid) {
        pulseValue();
        pulseScore();
        audio.rep(det.validReps);
        // 报数节奏：默认**每做一个都报数**（用户明确要求，用 force 打断上一句，不会被吞掉）；
        // 快节奏动作（开合跳 speakEvery: 10）只在 10 的整数倍报一次 —— 每次时间太短，念了也听不清。
        const speakEvery = speakEveryOf();
        if (det.validReps % speakEvery === 0) audio.sayRep(det.validReps);
        state.repsSinceEncourage = (state.repsSinceEncourage || 0) + 1;
        state.maxRepsSinceEncourage = Math.max(state.maxRepsSinceEncourage || 0, state.repsSinceEncourage);
        // 限时计数（开合跳）：目标是**秒**，不是次数 —— 所以「做满目标次数就达成」和
        // 「做一半提醒」这两件事都不适用（60 次 ≠ 60 秒），达标只由时间决定。
        const timedSet = !!localizedExercise(state.exerciseId).timed;
        const half = timedSet ? 0 : Math.ceil(state.target / 2);
        if (!timedSet && det.validReps === half && half > 0) {
          audio.milestone();
          setHint(t('status.half'), 'good', 2200);
          audio.sayCue(t('status.halfVoice'));
        } else if (!timedSet && running && det.validReps >= state.target && !state.goalHit) {
          state.goalHit = true;
          onGoalReached();
        } else if (state.repsSinceEncourage >= Math.max(ENCOURAGE_EVERY, speakEvery)
          && !(speakEvery > 1 && det.validReps % speakEvery === 0)) {
          // 隔几次给一句激励 —— 语音以「鼓励」为主，而不是只挑毛病（快节奏动作同样降频）。
          // 报数那一帧（speakEvery 的整数倍）让给报数：两句挤在同一帧，后一句会把报数顶掉。
          state.repsSinceEncourage = 0;
          audio.sayEncourage(det.validReps / ENCOURAGE_EVERY + det.cycle);
          setHint(pickEncourageHint(det.validReps), 'good', 1500);
        }
      } else {
        audio.partial();
      }
    } else if (ev.type === 'cue') {
      state.lastCueAt = performance.now();
      state.lastCueLevel = ev.level === 'info' ? 'warn' : ev.level;
      // 姿势纠正：**适度即可**。统一走教练的大间隔 + 同一句话长去重，
      // 而且动作已经做起来之后（组内有效次数 ≥ 3）进一步降低纠正频率，
      // 把话语权留给报数与激励。
      const warmed = (det.validReps || 0) >= 3;
      coachSay(t(ev.key, ev.params), {
        gapMs: warmed ? 9000 : 3000,
        dedupeMs: warmed ? 30000 : 15000,
        key: ev.key,
      });
    } else if (ev.type === 'hold') {
      if (ev.action === 'start') {
        audio.go();
        if (det.holdMs < 500) audio.sayStart();
      } else {
        audio.pause();
      }
    }
  }
}

/**
 * 跨过 50 分的整数倍：**不再报分数**（用户要求语音一律不报分数，只报次数和读秒），
 * 改成念一句**激励语** —— 分数跳档的那一刻正是最该夸的时候，屏幕上的提示牌仍然写着分数。
 */
function checkScoreMilestone(score) {
  const m = Math.floor(score / 50) * 50;
  if (m > 0 && m > state.lastScoreMilestone) {
    state.lastScoreMilestone = m;
    audio.milestone();
    audio.sayEncourage(m / 50 + (state.detector?.cycle || 0));
    setHint(t('status.milestone', { score: m }), 'good', 2000);
  }
}

/** 从词条池里按序号取一句（池子按顺序轮，天然不会连着重复） */
function poolLine(key, index) {
  const pool = t(key);
  const list = Array.isArray(pool) ? pool : [String(pool)];
  if (!list.length) return '';
  return list[Math.abs(Math.round(index)) % list.length];
}

function onGoalReached() {
  const ex = localizedExercise(state.exerciseId);
  const isHold = ex.kind === 'hold';
  const value = isHold
    ? t('summary.celebrateHold', { n: state.target })
    : (ex.timed
      // 限时计数：时间到就是「达成」，庆祝语直接喊时间到（次数在结算面板里）
      ? t('summary.celebrateTimed', { n: state.target })
      : t('summary.celebrateReps', { n: state.target }));
  $('celebrateText').textContent = t('summary.celebrate', { value });
  $('celebrate').hidden = false;
  state.celebrateUntil = performance.now() + 2600;
  audio.finish();
  // 达标了要夸：先念达成，再补一句激励（用户要求语音以激励为主）
  audio.say(t(ex.timed ? 'status.timeUpVoice' : 'status.goalVoice'), { rate: 1.15, force: true });
  setTimeout(() => audio.sayEncourage((state.detector?.validReps || 0) + 1), 1500);
}

/* ------------------------------------------------------------------ *
 * 主循环
 * ------------------------------------------------------------------ */

function loop() {
  requestAnimationFrame(loop);
  state.loopCount += 1;
  const video = camera.video;
  if (!state.engineReady || !camera.active) {
    renderer.clear();
    return;
  }
  if (video.currentTime === state.lastVideoTime) return;
  state.lastVideoTime = video.currentTime;

  const now = performance.now();
  // 倒计时兜底：定时器被浏览器节流/打断时（切标签页、后台标签等），
  // 靠时间判断继续推进，避免永远停在「3」上，之后既不计数也不报语音。
  if (state.session === 'countdown' && state.countdownStartedAt
    && now - state.countdownStartedAt > 3600) {
    finishCountdown();
  }
  const res = engine.detect(video, now);
  state.detectCount += 1;

  const aspect = camera.aspect;
  let frame = { ok: false, t: now };
  let landmarks = null;

  if (res) {
    landmarks = res.landmarks;
    state.poseHits += 1;
    if (state.lostSince) { smoother.reset(); state.lostSince = 0; }
    const smoothed = smoother.apply(landmarks, now / 1000);
    // 把校准阶段观测到的地面线传进去：所有「离地高度」都以它为基准。
    // 否则仰卧抬腿 / 跳跃这类动作里，脚踝会跟着身体一起动，地面基准就飘了。
    frame = computeFrame(toMetric(smoothed, aspect),
      { groundY: state.calibrator?.groundRef ?? null }, now, false, res.worldLandmarks);
  } else {
    if (!state.lostSince) state.lostSince = now;
    if (now - state.lostSince > 800) smoother.reset();
  }

  // 尺寸对齐
  renderer.resize(video.videoWidth || 1280, video.videoHeight || 720);

  const calibrating = !state.homeMode && (state.session === 'calibrating' || state.session === 'ready');
  const counting = !state.homeMode && state.session === 'running';
  let outline = null;

  if (state.homeMode) {
    // ---- 在动作主页上：不校准、不计数、不提示（摄像头可以继续开着预热） ----
    renderCalibration(null);
    state.session = state.session === 'running' ? state.session : 'idle';
  } else if (calibrating) {
    // ---- 运动前校准：只做就位判定与引导，不计数、不计分 ----
    outline = calibrationStep(frame, now);
  } else {
    // ---- 训练中：正常识别与计数 ----
    if (counting) {
      const events = feedDetector(frame, now);
      // 计时类先读秒：这样同一帧里「保持 10 秒」的要领语音会让位给「10 秒」，不会两句叠在一起
      announceHoldCount(state.detector, localizedExercise(state.exerciseId), now);
      // 限时计数：每隔一段报一次「还剩 N 秒」，最后 5 秒单独喊一句
      announceTimeLeft(localizedExercise(state.exerciseId), now);
      handleEvents(events, now);
      updateCriteria(frame, events, now);
    } else {
      // 没在计数时也要跑一次：进度条要一直显示，并且按「有没有识别到人」切换灰/彩色
      updateCriteria(frame, [], now);
    }
    renderCalibration(null);
    updateStatusHint(frame, now);
  }

  // 硬性不变量：**倒计时 / 训练中 / 暂停 这三态一律不画虚线轮廓**。
  // 上面的分支已经保证了这一点，这里再兜一道 —— 以后新增状态分支时，不会因为
  // 漏写 outline = null 就把校准用的虚线轮廓带进训练画面（用户反馈过这个现象：
  // 「进了运动状态还在，进度条都在走了轮廓还留着」）。
  if (state.session === 'countdown' || state.session === 'running' || state.session === 'paused') {
    outline = null;
  }

  // 目标达成：计时类是「保持够久」，限时计数类是「时间到」
  const det = state.detector;
  const ex = localizedExercise(state.exerciseId);

  // 计时（限时计数到点后就停在目标时长上，结算里「本组用时」才是干净的 60 秒）
  if (counting && !state.timeUp) {
    const dt = clamp(now - state.lastTick, 0, 250);
    state.elapsedMs += dt;
    if (ex.timed) state.elapsedMs = Math.min(state.elapsedMs, state.target * 1000);
  }
  state.lastTick = now;

  const timeIsUp = counting && ex.timed && state.elapsedMs >= state.target * 1000;
  if (counting && det && !state.goalHit
    && ((ex.kind === 'hold' && det.holdMs >= state.target * 1000) || timeIsUp)) {
    state.goalHit = true;
    // 时间到就立刻停止计次：庆祝动画那 2.6 秒里多跳的几下不该算进「60 秒」的成绩里
    if (ex.timed) state.timeUp = true;
    onGoalReached();
  }

  // 手势圆环（一组做完后的「退出 / 再做一次」）：识别到的手掌停在圆环中央满 3 秒就触发
  if (gestureState.visible) {
    updateGesture(res ? res.landmarks : null, now);
  }
  // 左下角常驻的「退出」圆环：手或脚进去停满 3 秒 → 退出这一组 + 退出全屏
  // （显示与否由摄像头开着没有决定，见 syncCornerExit）
  syncCornerExit();
  if (gestureState.cornerVisible && updateCornerExit(res ? res.landmarks : null, now)) {
    triggerCornerExit();
  }

  // 实时指标（调试用）
  renderDebug(frame, outline);

  // 绘制
  const status = !frame.ok ? 'idle'
    : (!det || det.active ? (now - state.lastCueAt < 2000 ? 'warn' : 'ok') : 'warn');
  renderer.draw({
    landmarks, frame, exerciseId: state.exerciseId, status, outline,
  });

  updateHud();

  // 管线状态（摄像头 / 模型 / 是否找到人）
  if (state.loopCount % 15 === 0) updatePipelineStatus();

  if (state.celebrateUntil && now > state.celebrateUntil) {
    state.celebrateUntil = 0;
    $('celebrate').hidden = true;
    if (state.session === 'running') {
      stopSession('goal');
    }
  }
}

/* ------------------------------------------------------------------ *
 * 摄像头 / 模型
 * ------------------------------------------------------------------ */

/** 给可能卡住的异步操作加超时，避免界面永远停在“正在打开摄像头…” */
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

async function startCamera(deviceId = null) {
  const mask = $('stageMask');
  $('maskIcon').textContent = '⏳';
  $('maskTitle').textContent = t('ui.maskOpening');
  $('maskText').textContent = t('ui.maskOpeningText');
  try {
    await withTimeout(camera.start(deviceId), 25000, t('ui.maskCamFailTitle'));
  } catch (err) {
    state.camError = `${err?.name || 'Error'}: ${err?.message || err}`;
    console.error('[camera]', state.camError);
    $('maskIcon').textContent = '⚠️';
    $('maskTitle').textContent = t('ui.maskCamFailTitle');
    $('maskText').textContent = `${err?.message || t('ui.unknownError')}${t('ui.maskCamFailSuffix')}`;
    $('btnStartCam').textContent = t('ui.retry');
    updatePipelineStatus();
    return;
  }

  audio.unlock();
  $('stage').style.aspectRatio = `${camera.video.videoWidth} / ${camera.video.videoHeight}`;
  $('hud').hidden = false;
  mask.classList.add('hidden');
  $('btnStart').disabled = false;
  state.poseHits = 0;
  updatePipelineStatus();

  await refreshCameraList();

  if (!state.engineReady) {
    $('maskTitle').textContent = t('ui.maskModelLoading');
    mask.classList.remove('hidden');
    $('maskText').textContent = t('ui.maskModelText');
    try {
      await withTimeout(engine.init({ modelKey: state.settings.modelKey }), 45000, t('ui.maskModelFail'));
      state.engineReady = true;
      mask.classList.add('hidden');
      updatePipelineStatus();
      setCueLine(t('status.modelReady'), 'good');
    } catch (err) {
      $('maskIcon').textContent = '⚠️';
      $('maskTitle').textContent = t('ui.maskModelFail');
      $('maskText').textContent = err?.message || t('ui.unknownError');
      return;
    }
  }
  updateButtons();
}

async function refreshCameraList() {
  try {
    const list = await Camera.list();
    const sel = $('camSel');
    sel.innerHTML = '';
    list.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `${t('ui.camera')} ${i + 1}`;
      sel.appendChild(o);
    });
    if (camera.deviceId) sel.value = camera.deviceId;
    sel.disabled = list.length < 2;
  } catch { /* ignore */ }
}

async function reloadModel() {
  state.engineReady = false;
  try {
    await engine.init({ modelKey: state.settings.modelKey });
    state.engineReady = true;
    const model = t(state.settings.modelKey === 'full' ? 'ui.modelFull' : 'ui.modelLite');
    setCueLine(t('status.modelSwitched', { model }), 'good');
  } catch (err) {
    setCueLine(t('status.modelSwitchFail', { msg: err?.message || err }), 'warn');
  }
}

/* ------------------------------------------------------------------ *
 * 语言切换
 * ------------------------------------------------------------------ */

/** 切换语言后，把静态 DOM 与所有动态文案整体刷新一遍 */
function refreshForLang() {
  applyI18n(document);
  buildLanguageSelect();
  buildHome();
  const prevId = state.exerciseId;
  // 重新渲染当前动作的文案；切换语言不该丢掉已经拿到的分和要领进度
  const det = state.detector;
  const keep = det ? {
    reps: det.validReps,
    partial: det.partialReps,
    hold: det.holdMs,
    score: det.score,
    cycle: det.cycle,
    stepDone: new Map(det.stepDone),
    cycleHadValidRep: det.cycleHadValidRep,
    answered: state.saidSteps,
  } : null;
  selectExercise(prevId);
  if (keep) {
    // 注意：selectExercise 会新建识别器，所以必须恢复到“当前”这个实例上
    const d = state.detector;
    d.validReps = keep.reps; d.reps = keep.reps;
    d.partialReps = keep.partial; d.holdMs = keep.hold; d.score = keep.score;
    d.cycle = keep.cycle; d.stepDone = keep.stepDone;
    d.cycleHadValidRep = keep.cycleHadValidRep;
    state.saidSteps = keep.answered;
  }
  state.stepSig = '';
  audio.pickVoice();
  updateHud();
  updatePipelineStatus();
  renderRecords();
  renderHistory();
  updateButtons();
  if (state.calib) renderCalibration(state.calib);
  buildHome();        // 主页分类/动作名也要跟着换语言
  buildMusicTracks(); // 曲子名也要跟着换语言
  if (gestureState.visible) showGestureRings({ speak: false });   // 圆环上的字也要跟着换
  setCueLine('');
}

function changeLang(code) {
  if (!LOCALES[code]) return;
  setLang(code);
  refreshForLang();
}

/* ------------------------------------------------------------------ *
 * 绑定
 * ------------------------------------------------------------------ */

/**
 * 环境不支持元素全屏时（例如 iPhone 的 Safari），把右下角的全屏按钮藏起来，
 * 免得用户点了没反应。
 */
function syncFullscreenSupport() {
  const btn = $('btnFullscreen');
  if (!btn) return;
  btn.hidden = typeof $('stage').requestFullscreen !== 'function';
}

function bindUI() {
  $('btnStartCam').addEventListener('click', () => {
    try { audio.unlock(); } catch { /* ignore */ }   // 最早的合法用户手势，先把声音解锁
    startCamera();
  });
  $('btnStart').addEventListener('click', () => startSession());
  // 一组做完的两个手势圆环：用手掌停 3 秒是主路径，鼠标/触屏点一下同样有效
  $('ringExit')?.addEventListener('click', () => triggerGesture('exit'));
  $('ringRetry')?.addEventListener('click', () => triggerGesture('retry'));
  // 左下角常驻的「退出」圆环：手或脚停 3 秒是主路径，点一下同样有效
  $('ringQuickExit')?.addEventListener('click', () => triggerCornerExit());
  window.addEventListener('resize', onStageResize);
  document.addEventListener('fullscreenchange', onStageResize);
  $('btnPause').addEventListener('click', () => (state.session === 'paused' ? resumeSession() : pauseSession()));
  $('btnStop').addEventListener('click', () => stopSession('user'));
  $('btnResetReps').addEventListener('click', () => {
    state.detector?.reset();
    state.elapsedMs = 0;
    state.goalHit = false;
    // 限时计数：重置计数也把「时间到」与已报过的剩余时间档清掉，可以接着把这一组跳完
    state.timeUp = false;
    state.timeCallsSaid = null;
    state.saidSteps = new Set();
    state.lastScoreMilestone = 0;
    state.stepSig = '';
    setCueLine(t('status.reset'));
    updateHud();
  });

  $('btnRecalibrate')?.addEventListener('click', () => toCalibration());

  $('langSel').addEventListener('change', (e) => changeLang(e.target.value));

  $('modelSel').value = state.settings.modelKey;
  $('modelSel').addEventListener('change', async (e) => {
    state.settings.modelKey = e.target.value;
    saveSettings();
    if (camera.active) await reloadModel();
  });

  // [按钮 id（同一个开关可能有多个按钮，数组里列出来即可）, 设置键, 应用函数, 点击后要不要提示一句话]
  const toggles = [
    ['btnMirror', 'mirror', (v) => {
      $('stage').classList.toggle('mirror', v);
      state.calibrator?.setMirror(v); // 左右方向提示要跟着镜像走
      renderer.mirror = v;            // 画布上的角度文字要反向抵消，否则是镜像字
    }, null],
    ['btnVoice', 'voice', (v) => {
      audio.voiceOn = v;
      if (!v) { audio.stopSpeech(); return; }
      // 打开语音时立刻试播一句：用户马上就能确认到底有没有声音，
      // 而不是等到训练时才发现整场是静音的（顺便也是一次解锁音频的用户手势）
      audio.unlock();
      audio.say(t('speech.voiceTest'), { force: true });
      const st = audio.state();
      // 只开着门没出声的情况也要说清楚：上下文没跑起来（被浏览器挡住）或系统里没有语音包
      if (st.ctx !== 'running' || st.voices === 0) setCueLine(t('status.noSound'), 'warn');
    }, null],
    ['btnSfx', 'sfx', (v) => {
      audio.sfxOn = v;
      if (v) { audio.unlock(); audio.milestone(); }   // 打开音效也立刻响一声
    }, null],
    ['btnMusic', 'music', (v) => {
      applyMusic();          // 主页上不放背景音乐，回到动作页才播
      if (v) audio.unlock();
    }, (v) => setCueLine(t(v ? 'status.musicOn' : 'status.musicOff'))],
    // 「严格模式」已按用户要求彻底取消：判据只有关键帧这一套，界面与识别器里都没有开关了
    ['btnAngles', 'showAngles', (v) => { renderer.showAngles = v; }, null],
    ['btnSkeleton', 'showSkeleton', (v) => {
      renderer.showSkeleton = v;
      // 关掉后立刻清一次画布，避免残影留到下一帧
      if (!v) renderer.clear();
    }, (v) => setCueLine(t(v ? 'status.skeletonOn' : 'status.skeletonOff'))],
    ['btnDebug', 'debug', (v) => { if (!v) $('debugLine').hidden = true; }, null],
  ];
  for (const [ids, key, apply, announce] of toggles) {
    const btns = (Array.isArray(ids) ? ids : [ids]).map((id) => $(id)).filter(Boolean);
    const press = (v) => { for (const b of btns) b.setAttribute('aria-pressed', String(!!v)); };
    press(!!state.settings[key]);
    apply(state.settings[key]);
    for (const btn of btns) {
      btn.addEventListener('click', () => {
        const v = !(btn.getAttribute('aria-pressed') === 'true');
        press(v);              // 同一个开关的其它按钮一起更新
        state.settings[key] = v;
        saveSettings();
        apply(v);
        if (announce) announce(v);
      });
    }
  }
  audio.voiceOn = state.settings.voice;
  audio.sfxOn = state.settings.sfx;
  // 用上次选的曲子（selectExercise 之前也来得及，因为音乐是这里才启动的）
  audio.setTrack(state.settings.musicTrack || DEFAULT_TRACK);

  // ---- 主页 / 设置弹窗 ----
  $('btnHome').addEventListener('click', () => showHome());
  $('btnSettings').addEventListener('click', () => openSettings());
  $('btnCloseSettings').addEventListener('click', () => closeSettings());
  $('settingsBackdrop').addEventListener('click', () => closeSettings());
  // 运动设定：顶栏图标 + 侧栏「设定目标」卡片里的按钮，两处都打开同一个弹窗
  $('btnExercise').addEventListener('click', () => openExerciseSettings());
  $('btnExerciseInline').addEventListener('click', () => openExerciseSettings());
  $('btnCloseExercise').addEventListener('click', () => closeExerciseSettings());
  $('exerciseBackdrop').addEventListener('click', () => closeExerciseSettings());

  // 鼠标移到某一格关键帧上 → 在进度条上方显示这一格的判定标准
  {
    const track = $('criteriaTrack');
    const segOf = (e) => (e.target && typeof e.target.closest === 'function' ? e.target.closest('.criteria-seg') : null);
    track.addEventListener('mouseover', (e) => {
      const seg = segOf(e);
      if (seg && seg.dataset) showCriteriaTip(Number(seg.dataset.i));
    });
    track.addEventListener('mouseout', (e) => {
      if (!segOf(e)) hideCriteriaTip();
    });
    track.addEventListener('mouseleave', () => hideCriteriaTip());
  }
  $('exSearch').addEventListener('input', (e) => {
    homeQuery = e.target.value || '';
    buildHome();
  });
  // 浏览器前进/后退在两个视图之间切换（自动化桩可能没有 hashchange，忽略即可）
  try { window.addEventListener('hashchange', handleRouteChange); } catch { /* ignore */ }

  // 浏览器要求「页面先有过一次用户交互」才允许出声（WebAudio 的 AudioContext 会一直 suspended，
  // Chrome 也会拦住没有交互就发起的语音）。所以在第一次点击/按键/触摸时就把音频解锁，
  // 免得后面由「自动识别完成」触发的倒计时、要领语音因为没赶上手势而整场静音。
  const unlockOnFirstGesture = () => {
    try { audio.unlock(); } catch { /* ignore */ }
    // 背景音乐要等这次用户手势之后才能出声（浏览器 autoplay 策略）
    try { applyMusic(); } catch { /* ignore */ }   // 首次手势解锁后，只在动作页放音乐
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      document.removeEventListener(ev, unlockOnFirstGesture);
    }
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    document.addEventListener(ev, unlockOnFirstGesture, { passive: true });
  }

  // 全屏只放大「视频框」(#stage)，不是整个 HTML 页面：
  // 整页全屏会把侧栏、要领清单、成绩卡一起放大，反而看不清动作。
  $('btnFullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else $('stage').requestFullscreen?.().catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => {
    $('btnFullscreen').setAttribute('aria-pressed', String(!!document.fullscreenElement));
  });
  syncFullscreenSupport();

  $('camSel').addEventListener('change', async (e) => {
    state.settings.camDeviceId = e.target.value;
    saveSettings();
    await startCamera(e.target.value);
  });

  $('tMinus').addEventListener('click', () => {
    setTarget(state.target - targetStepFor(localizedExercise(state.exerciseId)));
  });
  $('tPlus').addEventListener('click', () => {
    setTarget(state.target + targetStepFor(localizedExercise(state.exerciseId)));
  });
  $('targetInput').addEventListener('change', (e) => setTarget(e.target.value));

  $('btnBest').addEventListener('click', () => openRecordsModal('best'));
  $('btnHistory').addEventListener('click', () => openRecordsModal('history'));
  $('btnCloseBest').addEventListener('click', () => closeRecordsModal());
  $('btnCloseHistory').addEventListener('click', () => closeRecordsModal());
  $('bestBackdrop').addEventListener('click', () => closeRecordsModal());
  $('historyBackdrop').addEventListener('click', () => closeRecordsModal());

  $('btnClearHistory').addEventListener('click', () => {
    if (!confirm(t('ui.clearConfirm'))) return;
    saveList(STORE.history, []);
    saveList(STORE.records, {});
    renderHistory();
    renderRecords();
    setCueLine(t('records.cleared'));
  });

  document.addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) {
      // 搜索框里按 Esc 先退出搜索，而不是结束整组
      if (e.key === 'Escape' && e.target.id === 'exSearch') {
        e.target.value = '';
        homeQuery = '';
        buildHome();
        e.target.blur();
      }
      return;
    }
    if (e.key === 'Escape') {
      // 弹窗优先关闭；其次是结束本组
      if (recordsModalOpen()) { closeRecordsModal(); return; }
      if (exerciseSettingsOpen()) { closeExerciseSettings(); return; }
      if (settingsOpen()) { closeSettings(); return; }
      stopSession('user');
      return;
    }
    if (e.key === 'h' || e.key === 'H') { showHome(); return; }
    if (e.key === 'g' || e.key === 'G' || e.key === '?') {
      if (settingsOpen()) closeSettings(); else openSettings();
      return;
    }
    if (e.code === 'Space') { e.preventDefault(); startSession(); return; }
    if (e.key === 'r' || e.key === 'R') { $('btnResetReps').click(); return; }
    if (e.key === 'm' || e.key === 'M') { $('btnMirror').click(); return; }
    if (e.key === 's' || e.key === 'S') { $('btnSkeleton').click(); return; }
    if (e.key === 'f' || e.key === 'F') { $('btnFullscreen').click(); return; }
    // 数字键 1~9：快速切到动作库里前 9 个动作（动作变多了，全部映射已经没有意义）
    const n = Number(e.key);
    if (n >= 1 && n <= Math.min(9, EXERCISES.length)) openExercise(EXERCISES[n - 1].id);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.session === 'running') pauseSession();
  });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

/** 把运行时错误直接显示在页面上，方便排查（也方便自动化检查） */
function installErrorBanner() {
  let el = null;
  const show = (msg) => {
    if (!el) {
      el = document.createElement('div');
      el.id = 'errBanner';
      el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99;'
        + 'background:rgba(120,20,20,0.94);color:#ffe3e3;border:1px solid #f87171;border-radius:12px;'
        + 'padding:10px 14px;font:13px/1.5 system-ui,sans-serif;white-space:pre-wrap;max-height:30vh;overflow:auto';
      document.body.appendChild(el);
    }
    el.textContent = 'Runtime error: ' + msg;
    document.documentElement.dataset.error = msg;
  };
  window.addEventListener('error', (e) => show(e.message || String(e.error || e)));
  window.addEventListener('unhandledrejection', (e) => show(String(e.reason?.message || e.reason)));
}

function installProbe() {
  setTimeout(() => {
    const res = performance.getEntriesByType('resource')
      .filter((r) => /\.wasm|\.task|vision_bundle/.test(r.name))
      .map((r) => ({ file: r.name.split('/').pop(), status: r.responseStatus || 0, kb: Math.round((r.transferSize || r.decodedBodySize || 0) / 1024) }));
    const info = {
      error: document.documentElement.dataset.error || null,
      lang: getLang(),
      engineReady: state.engineReady,
      delegate: engine.delegate,
      modelKey: engine.modelKey,
      cameraActive: camera.active,
      video: `${camera.video.videoWidth}x${camera.video.videoHeight}`,
      aspect: Number(camera.aspect.toFixed(3)),
      loopCount: state.loopCount,
      detectCount: state.detectCount,
      poseHits: state.poseHits,
      overlay: `${renderer.canvas.width}x${renderer.canvas.height}`,
      exercise: state.exerciseId,
      target: state.target,
      session: state.session,
      calibHint: $('calibHint').textContent,
      calibBadge: $('calibBadge').textContent,
      calibVisible: $('calibCard').hidden === false,
      startDisabled: $('btnStart').disabled,
      hudValue: $('hudValue').textContent,
      hudName: $('hudName').textContent,
      camStatus: $('camStatus').textContent,
      camError: state.camError,
      maskTitle: $('maskTitle').textContent,
      maskText: $('maskText').textContent,
      cueLine: $('cueLine').textContent,
      stepHint: $('stepHint').textContent,
      maskVisible: !$('stageMask').classList.contains('hidden'),
      exerciseButtons: document.querySelectorAll('.ex-card, .exercise-btn').length,
      homeCards: document.querySelectorAll('.ex-card').length,
      homeView: !$('homeView').hidden,
      settingsOpen: !$('settingsModal').hidden,
      resources: res,
      consoleErrors: state.consoleErrors,
    };
    const pre = document.createElement('pre');
    pre.id = 'probe';
    pre.textContent = 'PROBE_JSON:' + JSON.stringify(info);
    document.body.appendChild(pre);
    document.title = 'PROBE_READY';
    try {
      fetch('/__probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(info) });
    } catch { /* ignore */ }
  }, 15000);
}

function boot() {
  installErrorBanner();
  captureConsole();
  const params = new URLSearchParams(location.search);
  if (!Camera.supported()) {
    $('maskIcon').textContent = '🚫';
    $('maskTitle').textContent = t('ui.maskUnsupportedTitle');
    $('maskText').textContent = t('ui.maskUnsupportedText');
    $('btnStartCam').disabled = true;
  }
  setLang(detectLang(), { persist: false });
  applyI18n(document);
  buildLanguageSelect();
  buildMusicTracks();
  bindUI();
  // 先按地址栏路由定位：带 ?exercise= / ?autostart / ?probe 时直接进动作页（自动化与书签要用），
  // 地址栏是 #/ex/<id> 时进那个动作，否则停在主页让用户挑分类与动作。
  const wantId = params.get('exercise') || routeExercise();
  const direct = !!wantId || params.has('autostart') || params.has('probe');
  selectExercise(wantId || state.settings.exerciseId || 'squat');
  if (direct) {
    showWorkout();
    setRoute(ROUTE_EX + state.exerciseId);
  } else {
    showHome();
  }
  renderHistory();
  renderRecords();
  updateButtons();
  updateHud();
  updatePipelineStatus();
  requestAnimationFrame(loop);
  if (state.settings.mirror) {
    $('stage').classList.add('mirror');
    renderer.mirror = true;   // 角度标签跟着反向，避免出现镜像文字
  }

  if (location.protocol === 'file:') {
    setCueLine(t('status.fileProtocol'), 'warn');
  }

  if (params.has('autostart') && Camera.supported()) {
    setTimeout(() => startCamera(), 60);
  }
  if (params.has('probe')) installProbe();
}

boot();

// 调试/自动化测试用的内部句柄（页面本身不依赖它）
window.__mfg = {
  state, engine, camera, audio, renderer, loop,
  selectExercise, startSession, pauseSession, resumeSession, stopSession, toCalibration, beginCountdown,
  feedDetector, handleEvents, updateHud, renderSteps, renderDebug, updatePipelineStatus,
  calibrationStep, renderCalibration, syncFullscreenSupport, finishCountdown, updateStatusHint,
  setTarget, changeLang, refreshForLang,
  buildHome, showHome, showWorkout, openExercise, openSettings, closeSettings,
  openExerciseSettings, closeExerciseSettings, renderExerciseSettings,
  openRecordsModal, closeRecordsModal, recordsModalOpen, renderRecords, renderHistory,
  buildCriteriaBar, updateCriteria, resetCriteriaProgress, renderCriteriaBar,
  showCriteriaTip, hideCriteriaTip,
  showGestureRings, hideGestureRings, updateGesture, triggerGesture, retrySet,
  gestureState, GESTURE_RINGS, GESTURE_HOLD_MS, RING_HIT,
  // 左下角常驻的「退出」圆环（手或脚进去停 3 秒 → 退出这一组 + 退出全屏）
  showCornerExit, hideCornerExit, updateCornerExit, triggerCornerExit, syncCornerExit,
  layoutCornerRing, ringCenter, ringPx, ringHitRadius, touchPoints, touchSamples, anyTouchInRing, stageSize,
  CORNER_RING_INSET_PX, CORNER_RING_BOTTOM_PX, RING_PX_FALLBACK, RING_HIT_RATIO,
  TOUCH_VIS_MIN, FOOT_VIS_MIN, FOOT_TIP_FROM_HEEL, FOOT_TIP_FROM_SHIN, distToSegment, pointsInRing,
  GESTURE_DRAIN_MS, RING_NEAR_FACTOR, touchDiagLine,
  announceHoldCount, HOLD_COUNT_EVERY,
  announceTimeLeft, TIME_CALL_AT, targetPresetsFor, targetStepFor,
  buildMusicTracks, selectMusicTrack,
};
