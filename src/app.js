/**
 * 应用主逻辑：摄像头 → 姿态识别 → 指标 → 动作判定 → 界面/语音反馈。
 */

import { EXERCISES, EXERCISE_MAP, createDetector } from './exercises.js';
import { LandmarkSmoother, toMetric, clamp } from './geometry.js';
import { computeFrame } from './metrics.js';
import { PoseEngine, Camera, MODELS } from './pose-engine.js';
import { PoseRenderer } from './render.js';
import { AudioKit } from './audio.js';

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

const PHASE_TEXT = {
  idle: '准备',
  up: '还原',
  down: '下落',
  descending: '向下',
  bottom: '底部',
  holding: '保持中',
  paused: '已暂停',
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
  session: 'idle',     // idle | countdown | running | paused
  detector: null,
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

/* ------------------------------------------------------------------ *
 * 界面构建
 * ------------------------------------------------------------------ */

function buildExerciseGrid() {
  const grid = $('exerciseGrid');
  grid.innerHTML = '';
  EXERCISES.forEach((ex, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'exercise-btn';
    btn.dataset.id = ex.id;
    btn.innerHTML = `<span class="ex-icon">${ex.icon}</span><span>${ex.name}</span>`
      + `<span class="ex-kind">${ex.kind === 'rep' ? '计数' : '计时'} · ${i + 1}</span>`;
    btn.addEventListener('click', () => selectExercise(ex.id));
    grid.appendChild(btn);
  });
}

function selectExercise(id) {
  if (!EXERCISE_MAP[id]) return;
  if (state.session === 'running' || state.session === 'paused' || state.session === 'countdown') {
    stopSession('switch');
  }
  state.exerciseId = id;
  state.settings.exerciseId = id;
  const ex = EXERCISE_MAP[id];
  state.target = state.settings.targets[id] || ex.defaultTarget;
  state.detector = createDetector(id, { strict: state.settings.strict });
  saveSettings();

  document.querySelectorAll('.exercise-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.id === id);
  });

  $('hudIcon').textContent = ex.icon;
  $('hudName').textContent = ex.name;
  $('hudUnit').textContent = ex.unit;
  $('targetUnit').textContent = ex.unit;
  $('statTimerLabel').textContent = ex.kind === 'hold' ? '已计时' : '本组用时';
  $('cameraHint').textContent = '📹 ' + ex.cameraHint;
  $('howtoTitle').textContent = `${ex.icon} ${ex.name} · 动作要领`;
  $('howtoList').innerHTML = ex.howto.map((t) => `<li>${t}</li>`).join('');
  $('tipList').innerHTML = ex.tips.map((t) => `<li>${t}</li>`).join('');
  $('targetInput').value = String(state.target);
  buildTargetChips();
  $('summaryCard').hidden = true;
  state.stepSig = '';
  state.saidSteps = new Set();
  state.lastScoreMilestone = 0;
  updateHud();
  renderRecords();
}

function buildTargetChips() {
  const ex = EXERCISE_MAP[state.exerciseId];
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
  const ex = EXERCISE_MAP[state.exerciseId];
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
  const ex = EXERCISE_MAP[state.exerciseId];
  const det = state.detector;
  const isHold = ex.kind === 'hold';

  const valid = det ? det.validReps : 0;
  const partial = det ? det.partialReps : 0;
  const holdMs = det ? det.holdMs : 0;
  const score = det ? det.score : 0;

  if (isHold) {
    $('hudValue').textContent = String(Math.floor(holdMs / 1000));
    $('hudSub').textContent = `目标 ${state.target} 秒`;
  } else {
    $('hudValue').textContent = String(valid);
    $('hudSub').textContent = `目标 ${state.target} 次`;
  }
  $('hudScore').textContent = `${score} 分`;

  const progress = isHold
    ? clamp(holdMs / (state.target * 1000), 0, 1)
    : clamp(valid / state.target, 0, 1);
  const C = 2 * Math.PI * 52;
  $('ringFg').style.strokeDashoffset = String(C * (1 - progress));
  $('ringFg').style.stroke = progress >= 1 ? 'var(--good)' : 'var(--accent)';
  $('ringText').textContent = `${Math.round(progress * 100)}%`;

  $('hudExtra').textContent = partial > 0
    ? `半程/未计 ${partial}`
    : (det && det.phase && det.phase !== 'idle' ? PHASE_TEXT[det.phase] || '' : '');

  $('statValid').textContent = isHold ? `${(holdMs / 1000).toFixed(1)} 秒` : String(valid);
  $('statPartial').textContent = isHold ? '—' : String(partial);
  $('statScore').textContent = `${score} 分`;
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
    el.textContent = '指标：未检测到人体';
    return;
  }
  const n = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  el.textContent = [
    `视角 ${f.view === 'side' ? '侧面✓' : '正面✗(需侧对)'}(${n(f.viewRatio, 2)})`,
    `全身 ${f.bodyVisible ? '✓' : '✗'}`,
    `双腿可见 ${f.legsVisible ? '✓' : '✗'}`,
    `躯干倾角 ${n(f.trunkLean)}°`,
    `膝 ${n(f.kneeAngle)}°`,
    `肘 ${n(f.elbowAngle)}°`,
    `髋 ${n(f.hipAngle)}°`,
    `身体直线 ${n(f.bodyStraight)}°`,
    `髋抬起 ${n(f.hipRise, 2)}`,
    `大腿离水平 ${n(f.thighFromHoriz)}°`,
    `可见度 ${n(f.coreVis, 2)}`,
    `状态 ${state.session}`,
  ].join(' · ');
}

/** 要领清单：已完成的打勾，当前该做哪一步高亮 */
function renderSteps() {
  const det = state.detector;
  const ul = $('stepList');
  if (!det) { ul.innerHTML = ''; return; }
  const steps = det.stepStatus();
  const sig = `${det.cycle}|${det.score}|${steps.map((s) => (s.done ? 1 : 0)).join('')}`;
  if (sig === state.stepSig) return;
  state.stepSig = sig;

  const firstPending = steps.findIndex((s) => !s.done);
  ul.innerHTML = steps.map((s, i) => {
    const cls = s.done ? 'done' : (i === firstPending ? 'current' : '');
    const mark = s.done ? '✓' : (i === firstPending ? '▸' : '○');
    return `<li class="step-item ${cls}">`
      + `<span class="step-check">${mark}</span>`
      + `<span class="step-label">${s.label}</span>`
      + `<span class="step-pts">+${s.points}</span></li>`;
  }).join('');
  $('scoreBadge').textContent = `${det.score} 分`;

  // 下一步的“卡点说明”单独放在列表下方，逐帧刷新也不会打断打勾动画
  const pending = det.pendingHint();
  const hintEl = $('stepHint');
  if (pending) {
    hintEl.textContent = pending.hint
      ? `下一步「${pending.label}」：${pending.hint}`
      : `下一步「${pending.label}」`;
    hintEl.className = 'step-hint warn';
  } else {
    hintEl.textContent = '本轮要领已全部完成 ✓';
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
    setHint('请先开启摄像头', 'warn', 2600);
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
  setCueLine('准备姿势：' + EXERCISE_MAP[state.exerciseId].cameraHint);
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
      setCueLine('开始！跟着提示做动作，半程动作不会计入次数。', 'good');
      updateButtons();
    }
  }, 850);
  updateButtons();
}

function pauseSession() {
  if (state.session !== 'running') return;
  state.session = 'paused';
  audio.pause();
  setCueLine('已暂停，点“继续”接着练。');
  setHint('已暂停', 'warn', 2000);
  updateButtons();
}

function resumeSession() {
  if (state.session !== 'paused') return;
  state.session = 'running';
  state.lastTick = performance.now();
  state.detector?.resetClock?.();
  setCueLine('继续！');
  updateButtons();
}

function stopSession(reason = 'user') {
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  $('countdown').hidden = true;
  const wasActive = state.session === 'running' || state.session === 'paused' || state.session === 'countdown';
  state.session = 'idle';
  releaseWakeLock();
  if (!wasActive) { updateButtons(); return; }

  const det = state.detector;
  const ex = EXERCISE_MAP[state.exerciseId];
  if (!det) { updateButtons(); return; }

  const isHold = ex.kind === 'hold';
  const value = isHold ? Math.round(det.holdMs / 1000) : det.validReps;
  const score = det.score;
  const steps = det.stepStatus();
  const doneCount = steps.filter((s) => s.done).length;
  const hasWork = value > 0 || det.partialReps > 0 || score > 0;
  if (hasWork) saveSession({ ex, value, partial: det.partialReps, reason, score });

  // 小结
  const items = [
    ['动作', `${ex.icon} ${ex.name}`],
    ['得分', `${score} 分`],
    [isHold ? '有效计时' : '有效次数', isHold ? `${value} 秒` : `${value} 次`],
    ['完成度', `${Math.round(clamp(isHold ? det.holdMs / (state.target * 1000) : value / state.target, 0, 1.5) * 100)}%`],
    ['要领完成', `${doneCount}/${steps.length} 步`],
    ['用时', fmtClock(state.elapsedMs)],
  ];
  $('summaryGrid').innerHTML = items
    .map(([k, v]) => `<div class="summary-item"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');
  const missed = steps.filter((s) => !s.done).map((s) => s.label);
  $('summaryNote').textContent = reason === 'goal'
    ? `🎉 目标达成，记录已保存！本组得分 ${score} 分。`
    : (hasWork
      ? (missed.length ? `本组得分 ${score} 分。下次注意：${missed.join('、')}` : `本组得分 ${score} 分，要领全部完成！`)
      : '这一组没有产生有效数据，再试一次吧。');
  $('summaryCard').hidden = false;

  audio.finish();
  det.reset();
  state.elapsedMs = 0;
  setCueLine('本组结束。休息一下，或者开始新的一组。');
  updateHud();
  updateButtons();
  renderHistory();
  renderRecords();
  setHint('', 'warn', 0);
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
  const busy = running || paused || state.session === 'countdown';
  $('btnStart').textContent = running ? '训练中…' : (paused ? '继续' : '开始训练');
  $('btnStart').disabled = running || state.session === 'countdown';
  $('btnPause').textContent = paused ? '继续' : '暂停';
  $('btnPause').disabled = !(running || paused);
  $('btnStop').disabled = !busy;
  $('btnResetReps').disabled = !state.detector;
}

/* ------------------------------------------------------------------ *
 * 记录
 * ------------------------------------------------------------------ */

function saveSession({ ex, value, partial, reason, score = 0 }) {
  const history = loadList(STORE.history);
  history.unshift({
    at: Date.now(),
    exerciseId: ex.id,
    name: ex.name,
    icon: ex.icon,
    kind: ex.kind,
    unit: ex.unit,
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
  for (const ex of EXERCISES) {
    const r = records[ex.id];
    if (!r) continue;
    any = true;
    const li = document.createElement('li');
    li.innerHTML = `<span class="r-name">${ex.icon} ${ex.name}</span>`
      + `<span class="r-val">${r.value} ${ex.unit}</span>`
      + `<span class="r-score">${r.score || 0} 分</span>`;
    ul.appendChild(li);
  }
  if (!any) ul.innerHTML = '<li class="empty">还没有记录，先练一组吧。</li>';
}

function renderHistory() {
  const history = loadList(STORE.history);
  const ul = $('historyList');
  ul.innerHTML = '';
  if (!history.length) {
    ul.innerHTML = '<li class="empty">暂无训练记录。</li>';
    return;
  }
  for (const h of history.slice(0, 12)) {
    const d = new Date(h.at);
    const when = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
      + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const li = document.createElement('li');
    li.innerHTML = `<span class="h-when">${when}</span>`
      + `<span class="h-what">${h.icon} ${h.name}${h.reached ? ' 🎉' : ''}</span>`
      + `<span class="h-val">${h.value} ${h.unit}</span>`
      + `<span class="h-score">${h.score || 0} 分</span>`;
    if (h.partial > 0) li.querySelector('.h-what').title = `半程/未计 ${h.partial} 次`;
    ul.appendChild(li);
  }
}

function updatePipelineStatus() {
  const parts = [];
  if (camera.active) {
    parts.push(`摄像头 ${camera.video.videoWidth}×${camera.video.videoHeight}`);
  } else {
    parts.push('摄像头未开启');
  }
  if (!camera.active) {
    $('camDot').classList.remove('on');
  } else {
    $('camDot').classList.add('on');
  }
  if (state.engineReady) {
    parts.push(`模型就绪 ${engine.modelKey === 'full' ? '完整' : '轻量'}/${engine.delegate || 'CPU'}`);
    parts.push(state.poseHits > 0 ? '已识别到人体 ✓' : '正在找人…（请站到画面里）');
  } else if (camera.active) {
    parts.push('模型加载中…');
  }
  $('camStatus').textContent = parts.join(' · ');
}

/* ------------------------------------------------------------------ *
 * 事件处理
 * ------------------------------------------------------------------ */

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
        audio.sayStep(ev.label);
      }
      checkScoreMilestone(ev.score);
    } else if (ev.type === 'bonus') {
      audio.bonus();
      showScorePop(`要领全过 +${ev.points}`, 'bonus');
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
          setHint('已经完成一半，继续保持！', 'good', 2200);
          audio.sayCue('完成一半，继续保持');
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
      audio.sayCue(ev.text);
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
    setHint(`已经拿到 ${m} 分！`, 'good', 2000);
  }
}

function onGoalReached() {
  const ex = EXERCISE_MAP[state.exerciseId];
  const isHold = ex.kind === 'hold';
  $('celebrateText').textContent = `🎉 目标达成：${isHold ? state.target + ' 秒' : state.target + ' 次'}`;
  $('celebrate').hidden = false;
  state.celebrateUntil = performance.now() + 2600;
  audio.finish();
  audio.say('目标完成，太棒了', { rate: 1.15, force: true });
}

/* ------------------------------------------------------------------ *
 * 主循环
 * ------------------------------------------------------------------ */

function feedDetector(f, now) {
  const det = state.detector;
  if (!det) return [];
  // 一直实时识别：只要达成要领就立刻加分、打勾、响铃，
  // 不需要先点“开始训练”（否则用户站好了却毫无反馈）。
  return det.update(f, now);
}

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

  const counting = state.session === 'running';
  const events = feedDetector(frame, now);
  handleEvents(events);

  // 计时
  if (counting) {
    const dt = clamp(now - state.lastTick, 0, 250);
    state.elapsedMs += dt;
  }
  state.lastTick = now;

  // 目标达成（计时类）
  const det = state.detector;
  const ex = EXERCISE_MAP[state.exerciseId];
  if (counting && det && ex.kind === 'hold' && det.holdMs >= state.target * 1000 && !state.goalHit) {
    state.goalHit = true;
    onGoalReached();
  }

  // 提示条：任何时刻都要有反馈，明确告诉用户“现在是什么状态、卡在哪”
  if (now > state.hintUntil) {
    if (!frame.ok) {
      setHint('没检测到人体：请站到画面中间，让头顶到脚都在画面里（退后 1~2 步）', 'bad', 700);
    } else {
      const pending = det ? det.pendingHint() : null;
      const recentCue = det && det.feedback && now - det.feedback.at < 3200 ? det.feedback : null;
      if (pending && pending.hint) {
        setHint(`下一步「${pending.label}」：${pending.hint}`, 'warn', 700);
      } else if (recentCue) {
        setHint(recentCue.text, recentCue.level, 700);
      } else if (det && !det.active && det.standby) {
        setHint(det.standby, 'warn', 700);
      } else {
        setHint('已识别到你 ✓ 保持这个位置做动作', 'good', 700);
      }
    }
  }

  // 实时指标（调试用）
  renderDebug(frame);

  // 绘制
  const status = !frame.ok ? 'idle' : (!det || det.active ? (now - state.lastCueAt < 2000 ? 'warn' : 'ok') : 'warn');
  renderer.draw({ landmarks, frame, exerciseId: state.exerciseId, status });

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
  $('maskTitle').textContent = '正在打开摄像头…';
  $('maskText').textContent = '请在浏览器弹窗里选择“允许”。如果一直没反应，点下面按钮重试。';
  try {
    await withTimeout(camera.start(deviceId), 25000, '等待摄像头授权超时（25 秒），请检查浏览器权限弹窗或是否有其它程序占用摄像头');
  } catch (err) {
    state.camError = `${err?.name || 'Error'}: ${err?.message || err}`;
    console.error('[camera]', state.camError);
    $('maskIcon').textContent = '⚠️';
    $('maskTitle').textContent = '摄像头打开失败';
    $('maskText').textContent = (err?.message || '未知错误')
      + '。请检查浏览器权限设置，或确认没有其它程序占用摄像头。';
    $('btnStartCam').textContent = '重试';
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
    $('maskTitle').textContent = '正在加载姿态模型…';
    mask.classList.remove('hidden');
    $('maskText').textContent = '首次加载约需几秒（本地模型文件，不需要联网）。';
    try {
      await withTimeout(engine.init({ modelKey: state.settings.modelKey }), 45000, '姿态模型加载超时');
      state.engineReady = true;
      mask.classList.add('hidden');
      updatePipelineStatus();
      setCueLine('模型就绪。选好动作后直接侧对镜头站好，站姿要领就会自动给分。', 'good');
    } catch (err) {
      $('maskIcon').textContent = '⚠️';
      $('maskTitle').textContent = '姿态模型加载失败';
      $('maskText').textContent = err?.message || '未知错误';
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
      o.textContent = d.label || `摄像头 ${i + 1}`;
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
    setCueLine(`已切换到「${MODELS[state.settings.modelKey].label}」模型。`, 'good');
  } catch (err) {
    setCueLine('模型切换失败：' + (err?.message || err), 'warn');
  }
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
    setCueLine('计数与得分已重置。');
    updateHud();
  });

  $('modelSel').value = state.settings.modelKey;
  $('modelSel').addEventListener('change', async (e) => {
    state.settings.modelKey = e.target.value;
    saveSettings();
    if (camera.active) await reloadModel();
  });

  const toggles = [
    ['btnMirror', 'mirror', (v) => $('stage').classList.toggle('mirror', v)],
    ['btnVoice', 'voice', (v) => { audio.voiceOn = v; if (!v) audio.stopSpeech(); }],
    ['btnSfx', 'sfx', (v) => { audio.sfxOn = v; }],
    ['btnStrict', 'strict', (v) => {
      if (state.detector) state.detector.strict = v;
      setCueLine(v ? '严格模式：半程动作不计入有效次数。' : '宽松模式：半程动作也计入次数。');
    }],
    ['btnAngles', 'showAngles', (v) => { renderer.showAngles = v; }],
    ['btnSkeleton', 'showSkeleton', (v) => {
      renderer.showSkeleton = v;
      // 关掉后立刻清一次画布，避免残影留到下一帧
      if (!v) renderer.clear();
      setCueLine(v ? '已显示火柴人骨架。' : '已隐藏火柴人骨架，只保留摄像头画面。');
    }],
    ['btnDebug', 'debug', (v) => { if (!v) $('debugLine').hidden = true; }],
  ];
  for (const [id, key, apply] of toggles) {
    const btn = $(id);
    btn.setAttribute('aria-pressed', String(!!state.settings[key]));
    apply(state.settings[key]);
    btn.addEventListener('click', () => {
      const v = !(btn.getAttribute('aria-pressed') === 'true');
      btn.setAttribute('aria-pressed', String(v));
      state.settings[key] = v;
      saveSettings();
      apply(v);
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

  $('tMinus').addEventListener('click', () => setTarget(state.target - (EXERCISE_MAP[state.exerciseId].kind === 'hold' ? 5 : 1)));
  $('tPlus').addEventListener('click', () => setTarget(state.target + (EXERCISE_MAP[state.exerciseId].kind === 'hold' ? 5 : 1)));
  $('targetInput').addEventListener('change', (e) => setTarget(e.target.value));

  $('btnClearHistory').addEventListener('click', () => {
    if (!confirm('确定清空所有训练记录与最佳成绩吗？')) return;
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
    el.textContent = '运行出错：' + msg;
    document.documentElement.dataset.error = msg;
  };
  window.addEventListener('error', (e) => show(e.message || String(e.error || e)));
  window.addEventListener('unhandledrejection', (e) => show(String(e.reason?.message || e.reason)));
}

function boot() {
  installErrorBanner();
  captureConsole();
  const params = new URLSearchParams(location.search);
  if (!Camera.supported()) {
    $('maskIcon').textContent = '🚫';
    $('maskTitle').textContent = '当前浏览器不支持摄像头';
    $('maskText').textContent = '请使用最新版 Chrome / Edge / Safari，并通过 http(s) 打开本页面。';
    $('btnStartCam').disabled = true;
  }
  buildExerciseGrid();
  bindUI();
  selectExercise(params.get('exercise') || state.settings.exerciseId || 'squat');
  renderHistory();
  renderRecords();
  updateButtons();
  updateHud();
  requestAnimationFrame(loop);
  if (state.settings.mirror) $('stage').classList.add('mirror');

  if (location.protocol === 'file:') {
    setCueLine('检测到用 file:// 打开：浏览器会拦截模型与摄像头，请用 node preview-server.js 通过 http://127.0.0.1 打开。', 'warn');
  }

  if (params.has('autostart') && Camera.supported()) {
    setTimeout(() => startCamera(), 60);
  }
  if (params.has('probe')) installProbe();
}

/** ?probe=1：把运行时自检信息写进 DOM，便于无头浏览器抓取 */
function installProbe() {
  setTimeout(() => {
    const res = performance.getEntriesByType('resource')
      .filter((r) => /\.wasm|\.task|vision_bundle/.test(r.name))
      .map((r) => ({ file: r.name.split('/').pop(), status: r.responseStatus || 0, kb: Math.round((r.transferSize || r.decodedBodySize || 0) / 1024) }));
    const info = {
      error: document.documentElement.dataset.error || null,
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
      hudValue: $('hudValue').textContent,
      hudName: $('hudName').textContent,
      camStatus: $('camStatus').textContent,
      camError: state.camError,
      maskTitle: $('maskTitle').textContent,
      maskText: $('maskText').textContent,
      cueLine: $('cueLine').textContent,
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
    // 同时回报给本地服务（无头浏览器场景下便于抓取）
    try {
      fetch('/__probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(info) });
    } catch { /* ignore */ }
  }, 15000);
}

boot();

// 调试/自动化测试用的内部句柄（页面本身不依赖它）
window.__mfg = {
  state, engine, camera, audio, renderer,
  selectExercise, startSession, pauseSession, resumeSession, stopSession,
  feedDetector, handleEvents, updateHud, renderSteps, renderDebug, updatePipelineStatus,
  setTarget, buildExerciseGrid,
};
