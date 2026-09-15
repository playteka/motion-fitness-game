/**
 * 应用主逻辑：摄像头 → 姿态识别 → 指标 → 动作判定 → 界面/语音反馈。
 * 界面文案全部走 i18n（src/locales/*.js），支持中文 / 英文 / 西班牙文 / 法文。
 */

import {
  EXERCISES, createDetector, localizedExercise, localizedExercises, exerciseUnit,
} from './exercises.js';
import { LandmarkSmoother, toMetric, clamp } from './geometry.js';
import { computeFrame } from './metrics.js';
import { PoseEngine, Camera } from './pose-engine.js';
import { PoseRenderer } from './render.js';
import { AudioKit } from './audio.js';
import { Calibrator, requiredView } from './calibration.js';
import {
  t, setLang, getLang, getMeta, applyI18n, detectLang, LOCALES, LANG_ORDER,
} from './i18n.js';

const $ = (id) => document.getElementById(id);

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
  strict: true,
  showAngles: true,
  showSkeleton: true,
  debug: false,
  exerciseId: 'squat',
  targets: {},
  camDeviceId: null,
};

const REP_TARGETS = [8, 12, 15, 20, 30];
const HOLD_TARGETS = [20, 30, 45, 60, 90];

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
  session: 'calibrating',   // calibrating | ready | countdown | running | paused
  detector: null,
  calibrator: null,
  calib: null,
  elapsedMs: 0,
  lastTick: 0,
  countdownTimer: null,
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
  consoleErrors: [],
  saidSteps: new Set(),
  stepSig: '',
  calibSig: '',
  lastScoreMilestone: 0,
};

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

function buildExerciseGrid() {
  const grid = $('exerciseGrid');
  grid.innerHTML = '';
  localizedExercises().forEach((ex, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'exercise-btn';
    btn.dataset.id = ex.id;
    const kind = t(ex.kind === 'rep' ? 'ui.kindRep' : 'ui.kindHold');
    btn.innerHTML = `<span class="ex-icon">${ex.icon}</span><span>${ex.name}</span>`
      + `<span class="ex-kind">${kind} · ${i + 1}</span>`;
    btn.addEventListener('click', () => selectExercise(ex.id));
    grid.appendChild(btn);
  });
}

function selectExercise(id) {
  if (!EXERCISES.some((e) => e.id === id)) return;
  if (state.session === 'running' || state.session === 'paused' || state.session === 'countdown') {
    stopSession('switch');
  }
  state.exerciseId = id;
  state.settings.exerciseId = id;
  const ex = localizedExercise(id);
  state.target = state.settings.targets[id] || ex.defaultTarget;
  state.detector = createDetector(id, { strict: state.settings.strict });
  state.calibrator = state.calibrator || new Calibrator(id, { mirror: state.settings.mirror });
  state.calibrator.setExercise(id);
  state.calibrator.setMirror(state.settings.mirror);
  saveSettings();

  document.querySelectorAll('.exercise-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.id === id);
  });

  $('hudIcon').textContent = ex.icon;
  $('hudName').textContent = ex.name;
  $('hudUnit').textContent = ex.unit;
  $('targetUnit').textContent = ex.unit;
  $('statTimerLabel').textContent = ex.kind === 'hold' ? t('ui.holdTime') : t('ui.setTime');
  $('cameraHint').textContent = `📹 ${ex.cameraHint}`;
  $('howtoTitle').textContent = `${ex.icon} ${ex.name} · ${t('ui.actionGuide')}`;
  $('howtoList').innerHTML = ex.howto.map((x) => `<li>${x}</li>`).join('');
  $('tipList').innerHTML = ex.tips.map((x) => `<li>${x}</li>`).join('');
  $('targetInput').value = String(state.target);
  buildTargetChips();
  $('summaryCard').hidden = true;
  state.stepSig = '';
  state.saidSteps = new Set();
  state.lastScoreMilestone = 0;
  toCalibration({ silent: true });
  updateHud();
  renderRecords();
}

/** 进入「运动前校准」阶段：显示虚线人体轮廓，不计数 */
function toCalibration({ silent = false } = {}) {
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  $('countdown').hidden = true;
  $('celebrate').hidden = true;
  releaseWakeLock();
  state.session = 'calibrating';
  state.calibrator?.reset();
  state.calib = null;
  state.elapsedMs = 0;
  state.goalHit = false;
  state.stepSig = '';
  state.lastTick = performance.now();
  if (!silent) {
    setCueLine(t('calib.lead'));
    setHint(t('calib.lead'), 'warn', 2000);
  }
  updateButtons();
}

function buildTargetChips() {
  const ex = localizedExercise(state.exerciseId);
  const presets = ex.kind === 'hold' ? HOLD_TARGETS : REP_TARGETS;
  const chips = $('targetChips');
  chips.innerHTML = '';
  for (const v of presets) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${v} ${ex.unit}`;
    b.addEventListener('click', () => setTarget(v));
    chips.appendChild(b);
  }
}

function setTarget(v) {
  const ex = localizedExercise(state.exerciseId);
  const n = clamp(Math.round(Number(v) || ex.defaultTarget), 1, 999);
  state.target = n;
  state.settings.targets[state.exerciseId] = n;
  $('targetInput').value = String(n);
  saveSettings();
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

  const valid = det ? det.validReps : 0;
  const partial = det ? det.partialReps : 0;
  const holdMs = det ? det.holdMs : 0;
  const score = det ? det.score : 0;

  if (isHold) {
    $('hudValue').textContent = String(Math.floor(holdMs / 1000));
    $('hudSub').textContent = `${t('ui.targetPrefix')} ${state.target} ${ex.unit}`;
  } else {
    $('hudValue').textContent = String(valid);
    $('hudSub').textContent = `${t('ui.targetPrefix')} ${state.target} ${ex.unit}`;
  }
  $('hudScore').textContent = scoreText(score);

  const progress = isHold
    ? clamp(holdMs / (state.target * 1000), 0, 1)
    : clamp(valid / state.target, 0, 1);
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

/** 实时指标面板：把识别器“看到的”数字直接摆出来，方便自己判断机位问题 */
function renderDebug(f) {
  const el = $('debugLine');
  if (!state.settings.debug) { if (!el.hidden) el.hidden = true; return; }
  el.hidden = false;
  if (!f || !f.ok) {
    el.textContent = t('debug.noPerson');
    return;
  }
  const n = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const mark = (v) => (v ? t('debug.yes') : t('debug.no'));
  // 机位是否“正确”取决于当前动作：深蹲要正面，其余要侧面
  const wantView = requiredView(state.exerciseId);
  const viewName = f.view === 'front' ? t('debug.viewFront') : t('debug.viewSide');
  el.textContent = [
    `${t('debug.view')} ${viewName}${mark(f.view === wantView)}(${n(f.viewRatio, 2)})`,
    `${t('debug.bodyVisible')} ${mark(f.bodyVisible)}`,
    `${t('debug.legsVisible')} ${mark(f.legsVisible)}`,
    `${t('debug.trunkLean')} ${n(f.trunkLean)}°`,
    `${t('debug.knee')} ${n(f.kneeAngle)}°`,
    `${t('debug.elbow')} ${n(f.elbowAngle)}°`,
    `${t('debug.hip')} ${n(f.hipAngle)}°`,
    `${t('debug.bodyStraight')} ${n(f.bodyStraight)}°`,
    `${t('debug.hipRise')} ${n(f.hipRise, 2)}`,
    `${t('debug.thighFromHoriz')} ${n(f.thighFromHoriz)}°`,
    `${t('debug.visibility')} ${n(f.coreVis, 2)}`,
    `${t('debug.state')} ${state.session}`,
  ].join(' · ');
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

function pulseValue() {
  const el = $('hudValue');
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
  setTimeout(() => el.classList.remove('pop'), 160);
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
    state.detector = createDetector(state.exerciseId, { strict: state.settings.strict });
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

  audio.unlock();
  const det = ensureDetector();
  // 注意：不重置计数与得分。识别从选好动作那一刻就开始反馈，
  // 点“开始训练”只是开始计时/记一组，方便用户先站好姿势拿到要领分。
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
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
      $('countdown').hidden = true;
      state.session = 'running';
      state.lastTick = performance.now();
      det.resetClock?.();
      audio.go();
      audio.sayStart();
      setCueLine(t('status.countdownGo'), 'good');
      updateButtons();
    }
  }, 850);
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
  if (!wasActive) { updateButtons(); return; }

  const det = state.detector;
  const ex = localizedExercise(state.exerciseId);
  if (!det) { updateButtons(); return; }

  const isHold = ex.kind === 'hold';
  const value = isHold ? Math.round(det.holdMs / 1000) : det.validReps;
  const score = det.score;
  const steps = det.stepStatus();
  const doneCount = steps.filter((s) => s.done).length;
  const hasWork = value > 0 || det.partialReps > 0 || score > 0;
  if (hasWork) saveSession({ ex, value, partial: det.partialReps, reason, score });

  const items = [
    [t('ui.colAction'), `${ex.icon} ${ex.name}`],
    [t('ui.colScore'), scoreText(score)],
    [isHold ? t('ui.colHold') : t('ui.colValidReps'), `${value} ${ex.unit}`],
    [t('ui.colCompletion'), `${Math.round(clamp(isHold ? det.holdMs / (state.target * 1000) : value / state.target, 0, 1.5) * 100)}%`],
    [t('ui.colSteps'), t('ui.stepsDoneRatio', { done: doneCount, total: steps.length })],
    [t('ui.colElapsed'), fmtClock(state.elapsedMs)],
  ];
  $('summaryGrid').innerHTML = items
    .map(([k, v]) => `<div class="summary-item"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');
  const missed = steps.filter((s) => !s.done).map((s) => t(s.labelKey));
  $('summaryNote').textContent = reason === 'goal'
    ? t('summary.goalReached', { score })
    : (hasWork
      ? (missed.length
        ? t('summary.savedWithMiss', { score, list: missed.join('、') })
        : t('summary.savedAll', { score }))
      : t('summary.noData'));

  audio.finish();
  det.reset();
  state.elapsedMs = 0;
  setCueLine(t('status.setDone'));
  updateHud();
  renderHistory();
  renderRecords();
  setHint('', 'warn', 0);
  // 一组结束后回到校准阶段：下一组开始前重新确认站位与机位
  toCalibration({ silent: false });
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
    const li = document.createElement('li');
    li.innerHTML = `<span class="r-name">${ex.icon} ${ex.name}</span>`
      + `<span class="r-val">${r.value} ${ex.unit}</span>`
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
      + `<span class="h-val">${h.value} ${ex ? ex.unit : ''}</span>`
      + `<span class="h-score">${scoreText(h.score || 0)}</span>`;
    if (h.partial > 0) li.querySelector('.h-what').title = `${t('ui.partial')} ${h.partial}`;
    ul.appendChild(li);
  }
}

/** 校准面板：逐项打勾 + 进度 + 当前该做的一件事 */
function renderCalibration(calib) {
  const card = $('calibCard');
  if (!card) return;
  if (!calib) {
    if (!card.hidden) card.hidden = true;
    return;
  }
  card.hidden = false;
  const sig = `${getLang()}|${calib.checks.map((c) => (c.ok ? 1 : 0)).join('')}`;
  if (sig !== state.calibSig) {
    state.calibSig = sig;
    $('calibList').innerHTML = calib.checks.map((c) => {
      const mark = c.ok ? '✓' : '○';
      return `<li class="calib-item${c.ok ? ' done' : ''}">`
        + `<span class="calib-check">${mark}</span>`
        + `<span>${t(`calib.check.${c.id}`)}</span></li>`;
    }).join('');
  }
  const okCount = calib.checks.filter((c) => c.ok).length;
  $('calibBadge').textContent = `${okCount}/${calib.checks.length}`;
  $('calibFill').style.width = `${Math.round(calib.progress * 100)}%`;
  const hintEl = $('calibHint');
  hintEl.textContent = t(calib.hintKey, calib.hintParams);
  hintEl.className = `calib-hint ${calib.ready ? 'good' : 'warn'}`;
}

/**
 * 校准阶段的一帧处理：跑就位判定、必要时切到「可以开始」、刷新面板与提示。
 * 返回这一帧要画的虚线轮廓参数。
 */
function calibrationStep(frame, now) {
  const calib = state.calibrator.update(frame, now);
  state.calib = calib;
  if (calib.done && state.session === 'calibrating') {
    state.session = 'ready';
    state.lastTick = now;
    audio.milestone();
    audio.say(t('calib.doneVoice'), { rate: 1.15, force: true });
    setCueLine(t('calib.startNow'), 'good');
    updateButtons();
  }
  renderCalibration(calib);
  if (now > state.hintUntil) {
    const level = calib.ready ? 'good' : (frame.ok ? 'warn' : 'bad');
    setHint(t(calib.hintKey, calib.hintParams), level, 700);
  }
  return {
    view: state.calibrator.view,
    status: !frame.ok ? 'search' : (calib.ready ? 'ready' : 'adjust'),
  };
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
  return det.update(f, now);
}

function handleEvents(events) {
  const det = state.detector;
  if (!det) return;
  const running = state.session === 'running';

  for (const ev of events) {
    if (ev.type === 'step') {
      // 每一步要领达标：立刻响铃 + 加分飘字，第一次完成时还用语音念出要领
      audio.step(ev.index, ev.total);
      showScorePop(`+${ev.points}`);
      if (!state.saidSteps.has(ev.id)) {
        state.saidSteps.add(ev.id);
        audio.sayStep(t(ev.labelKey));
      }
      checkScoreMilestone(ev.score);
    } else if (ev.type === 'bonus') {
      audio.bonus();
      showScorePop(`${t('ui.stepsAllDone')} +${ev.points}`, 'bonus');
    } else if (ev.type === 'points') {
      audio.scoreTick();
      checkScoreMilestone(ev.score);
    } else if (ev.type === 'rep') {
      if (ev.valid) {
        pulseValue();
        audio.rep(det.validReps);
        audio.sayRep(det.validReps);
        const half = Math.ceil(state.target / 2);
        if (det.validReps === half && half > 0) {
          audio.milestone();
          setHint(t('status.half'), 'good', 2200);
          audio.sayCue(t('status.halfVoice'));
        }
        if (running && det.validReps >= state.target && !state.goalHit) {
          state.goalHit = true;
          onGoalReached();
        }
      } else {
        audio.partial();
      }
    } else if (ev.type === 'cue') {
      state.lastCueAt = performance.now();
      state.lastCueLevel = ev.level === 'info' ? 'warn' : ev.level;
      audio.sayCue(t(ev.key, ev.params));
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

/** 每跨过 50 分的整数倍就报一次分数 */
function checkScoreMilestone(score) {
  const m = Math.floor(score / 50) * 50;
  if (m > 0 && m > state.lastScoreMilestone) {
    state.lastScoreMilestone = m;
    audio.milestone();
    audio.sayScore(m);
    setHint(t('status.milestone', { score: m }), 'good', 2000);
  }
}

function onGoalReached() {
  const ex = localizedExercise(state.exerciseId);
  const isHold = ex.kind === 'hold';
  const value = isHold
    ? t('summary.celebrateHold', { n: state.target })
    : t('summary.celebrateReps', { n: state.target });
  $('celebrateText').textContent = t('summary.celebrate', { value });
  $('celebrate').hidden = false;
  state.celebrateUntil = performance.now() + 2600;
  audio.finish();
  audio.say(t('status.goalVoice'), { rate: 1.15, force: true });
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
    frame = computeFrame(toMetric(smoothed, aspect), null, now, false, res.worldLandmarks);
  } else {
    if (!state.lostSince) state.lostSince = now;
    if (now - state.lostSince > 800) smoother.reset();
  }

  // 尺寸对齐
  renderer.resize(video.videoWidth || 1280, video.videoHeight || 720);

  const calibrating = state.session === 'calibrating' || state.session === 'ready';
  const counting = state.session === 'running';
  let outline = null;

  if (calibrating) {
    // ---- 运动前校准：只做就位判定与引导，不计数、不计分 ----
    outline = calibrationStep(frame, now);
  } else {
    // ---- 训练中：正常识别与计数 ----
    if (counting) {
      const events = feedDetector(frame, now);
      handleEvents(events);
    }
    renderCalibration(null);

    // 提示条：任何时刻都要有反馈，明确告诉用户“现在是什么状态、卡在哪”
    if (now > state.hintUntil) {
      const det0 = state.detector;
      if (!frame.ok) {
        setHint(t('status.noPerson'), 'bad', 700);
      } else {
        const pending = det0 ? det0.pendingHint() : null;
        const recentCue = det0 && det0.feedback && now - det0.feedback.at < 3200 ? det0.feedback : null;
        if (pending && pending.hint) {
          setHint(t('ui.nextStepWithHint', {
            label: t(pending.labelKey),
            hint: t(pending.hint.key, pending.hint.params),
          }), 'warn', 700);
        } else if (recentCue) {
          setHint(t(recentCue.key, recentCue.params), recentCue.level, 700);
        } else if (det0 && !det0.active && det0.standby) {
          setHint(t(det0.standby), 'warn', 700);
        } else {
          setHint(t('status.ready'), 'good', 700);
        }
      }
    }
  }

  // 计时
  if (counting) {
    const dt = clamp(now - state.lastTick, 0, 250);
    state.elapsedMs += dt;
  }
  state.lastTick = now;

  // 目标达成（计时类）
  const det = state.detector;
  const ex = localizedExercise(state.exerciseId);
  if (counting && det && ex.kind === 'hold' && det.holdMs >= state.target * 1000 && !state.goalHit) {
    state.goalHit = true;
    onGoalReached();
  }

  // 实时指标（调试用）
  renderDebug(frame);

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
  buildExerciseGrid();
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

function bindUI() {
  $('btnStartCam').addEventListener('click', () => startCamera());
  $('btnStart').addEventListener('click', () => startSession());
  $('btnPause').addEventListener('click', () => (state.session === 'paused' ? resumeSession() : pauseSession()));
  $('btnStop').addEventListener('click', () => stopSession('user'));
  $('btnResetReps').addEventListener('click', () => {
    state.detector?.reset();
    state.elapsedMs = 0;
    state.goalHit = false;
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

  // [按钮 id, 设置键, 应用函数, 点击后要不要提示一句话]
  const toggles = [
    ['btnMirror', 'mirror', (v) => {
      $('stage').classList.toggle('mirror', v);
      state.calibrator?.setMirror(v); // 左右方向提示要跟着镜像走
    }, null],
    ['btnVoice', 'voice', (v) => { audio.voiceOn = v; if (!v) audio.stopSpeech(); }, null],
    ['btnSfx', 'sfx', (v) => { audio.sfxOn = v; }, null],
    ['btnStrict', 'strict', (v) => {
      if (state.detector) state.detector.strict = v;
    }, (v) => setCueLine(t(v ? 'status.strictOn' : 'status.strictOff'))],
    ['btnAngles', 'showAngles', (v) => { renderer.showAngles = v; }, null],
    ['btnSkeleton', 'showSkeleton', (v) => {
      renderer.showSkeleton = v;
      // 关掉后立刻清一次画布，避免残影留到下一帧
      if (!v) renderer.clear();
    }, (v) => setCueLine(t(v ? 'status.skeletonOn' : 'status.skeletonOff'))],
    ['btnDebug', 'debug', (v) => { if (!v) $('debugLine').hidden = true; }, null],
  ];
  for (const [id, key, apply, announce] of toggles) {
    const btn = $(id);
    btn.setAttribute('aria-pressed', String(!!state.settings[key]));
    apply(state.settings[key]);
    btn.addEventListener('click', () => {
      const v = !(btn.getAttribute('aria-pressed') === 'true');
      btn.setAttribute('aria-pressed', String(v));
      state.settings[key] = v;
      saveSettings();
      apply(v);
      if (announce) announce(v);
    });
  }
  audio.voiceOn = state.settings.voice;
  audio.sfxOn = state.settings.sfx;

  $('btnFullscreen').addEventListener('click', () => {
    const el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.().catch(() => {});
  });

  $('camSel').addEventListener('change', async (e) => {
    state.settings.camDeviceId = e.target.value;
    saveSettings();
    await startCamera(e.target.value);
  });

  $('tMinus').addEventListener('click', () => {
    const step = localizedExercise(state.exerciseId).kind === 'hold' ? 5 : 1;
    setTarget(state.target - step);
  });
  $('tPlus').addEventListener('click', () => {
    const step = localizedExercise(state.exerciseId).kind === 'hold' ? 5 : 1;
    setTarget(state.target + step);
  });
  $('targetInput').addEventListener('change', (e) => setTarget(e.target.value));

  $('btnClearHistory').addEventListener('click', () => {
    if (!confirm(t('ui.clearConfirm'))) return;
    saveList(STORE.history, []);
    saveList(STORE.records, {});
    renderHistory();
    renderRecords();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); startSession(); return; }
    if (e.key === 'r' || e.key === 'R') { $('btnResetReps').click(); return; }
    if (e.key === 'Escape') { stopSession('user'); return; }
    if (e.key === 'm' || e.key === 'M') { $('btnMirror').click(); return; }
    if (e.key === 's' || e.key === 'S') { $('btnSkeleton').click(); return; }
    if (e.key === 'f' || e.key === 'F') { $('btnFullscreen').click(); return; }
    const n = Number(e.key);
    if (n >= 1 && n <= EXERCISES.length) selectExercise(EXERCISES[n - 1].id);
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
      exerciseButtons: document.querySelectorAll('.exercise-btn').length,
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
  buildExerciseGrid();
  bindUI();
  selectExercise(params.get('exercise') || state.settings.exerciseId || 'squat');
  renderHistory();
  renderRecords();
  updateButtons();
  updateHud();
  updatePipelineStatus();
  requestAnimationFrame(loop);
  if (state.settings.mirror) $('stage').classList.add('mirror');

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
  state, engine, camera, audio, renderer,
  selectExercise, startSession, pauseSession, resumeSession, stopSession, toCalibration,
  feedDetector, handleEvents, updateHud, renderSteps, renderDebug, updatePipelineStatus,
  calibrationStep, renderCalibration,
  setTarget, buildExerciseGrid, changeLang, refreshForLang,
};
