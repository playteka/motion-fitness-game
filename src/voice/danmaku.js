/**
 * 对话弹幕（P3.6）：用户说一句 / 教练答一句，各飞出一条弹幕。
 *
 * 用户要求（原话要点）：
 *   1) 「把对话的字幕改为**弹幕**的形式：用户讲一句出一条弹幕；AI 教练讲一句也出一条弹幕，
 *      但用**不同颜色**区别于用户说的话。」
 *   2) 只走**上半屏 4 条轨道**，不压 HUD 圆环 / 判定进度条 / 右下按钮；
 *   3) 同屏最多 8 条、队列上限 12、同一句 1.5 秒内不重复弹；
 *   4) 底部保留一条「最近一句」静态行；`prefers-reduced-motion` → 不飞行，降级成静态两行。
 *
 * 分层（测试需要，所以拆开）：
 *   - **纯逻辑**：`pickLane()` / `layoutBullet()` / `createDanmakuModel()` —— 不碰 DOM、不读时钟，
 *     时钟与轨道占用全部从参数进来，Node 里可以直接断言；
 *   - **DOM 渲染**：`createDanmaku()` —— 把模型吐出的 bullet 变成 `.danmaku` 元素、管定时器、
 *     管「最近一句」那一行，并在 `prefers-reduced-motion` 时切成静态两行。
 *
 * 颜色只在这里定义一次（CSS 用同名令牌 `--danmaku-user` / `--danmaku-coach` 引用）：
 *   用户 = 青 `#38bdf8`（--accent-2），教练 = 薄荷绿 `#34e5c4`（--accent）。
 */

import { t } from '../i18n.js';

/** 轨道条数（只占上半屏） */
export const DANMAKU_LANE_COUNT = 4;
/** 同屏最多几条（超了就把最老的一条挤掉） */
export const DANMAKU_MAX_ON_SCREEN = 8;
/** 排队上限（同屏满了才排；满了再来的直接丢弃，避免无限堆积） */
export const DANMAKU_QUEUE_MAX = 12;
/** 同一句（同 kind + 同 text）在这个窗口内不重复弹 */
export const DANMAKU_DEDUPE_MS = 1500;
/** 一条弹幕从右飞到左的时长（CSS 的 --danmaku-flight 与这里同一个数） */
export const DANMAKU_FLIGHT_MS = 7000;
/** 同一条轨道上两条弹幕的最小间隔（避免首尾相接糊成一片） */
export const DANMAKU_LANE_GAP_MS = 2200;
/** 减少动效时最多留几行（用户口径：静态两行） */
export const DANMAKU_STATIC_MAX = 2;

/** 对话显示的三种模式（设置里的「对话显示」三选一） */
export const DANMAKU_MODES = Object.freeze(['danmaku', 'subtitle', 'off']);
export const DANMAKU_DEFAULT_MODE = 'danmaku';

/** 两种说话人的颜色（与 style.css 的令牌一致） */
export const DANMAKU_COLORS = Object.freeze({
  user: '#38bdf8',
  coach: '#34e5c4',
});

/** kind 只认 'coach' / 其它都当 'user' */
export function normalizeKind(kind) {
  return kind === 'coach' ? 'coach' : 'user';
}

/** mode 只认三种之一，其它回落到默认「弹幕」 */
export function normalizeMode(mode) {
  return DANMAKU_MODES.includes(mode) ? mode : DANMAKU_DEFAULT_MODE;
}

/**
 * 选一条不重叠的轨道（纯函数）。
 *
 * @param {number[]} lanes 每条轨道的「空出时刻」（毫秒时间戳；越早越空）
 * @param {number}   now   当前时刻
 * @returns {number} 轨道下标
 *
 * 规则（用户口径）：
 *   1) 有空轨道（freeAt <= now）→ 取下标最小的那条，保证视觉上从上往下填；
 *   2) 全满 → 取**最早空出**的那条（freeAt 最小），至少不会等最久。
 */
export function pickLane(lanes, now) {
  const list = Array.isArray(lanes) ? lanes : [];
  if (!list.length) return 0;
  const at = Number(now);
  for (let i = 0; i < list.length; i += 1) {
    if (!(Number(list[i]) > at)) return i;
  }
  let best = 0;
  for (let i = 1; i < list.length; i += 1) {
    if (Number(list[i]) < Number(list[best])) best = i;
  }
  return best;
}

/**
 * 一条弹幕的版面（纯函数）：轨道 / 起点 / 终点都算好，DOM 层只管照着摆。
 *
 * @param {object} opts
 * @param {string} opts.text
 * @param {'user'|'coach'} [opts.kind]
 * @param {number} [opts.lane]       轨道下标（越界会被夹到 [0, laneCount-1]）
 * @param {number} [opts.startAt]    起飞时刻（毫秒时间戳）
 * @param {number} [opts.durationMs] 飞行时长
 * @param {number} [opts.laneCount]  轨道总数
 * @returns {{text:string,kind:string,lane:number,startAt:number,endAt:number,durationMs:number}}
 */
export function layoutBullet({
  text = '',
  kind = 'user',
  lane = 0,
  startAt = 0,
  durationMs = DANMAKU_FLIGHT_MS,
  laneCount = DANMAKU_LANE_COUNT,
} = {}) {
  const lanes = Math.max(1, Math.floor(Number(laneCount)) || DANMAKU_LANE_COUNT);
  const safeLane = Math.min(lanes - 1, Math.max(0, Math.floor(Number(lane)) || 0));
  const start = Number(startAt) || 0;
  const dur = Number(durationMs) > 0 ? Number(durationMs) : DANMAKU_FLIGHT_MS;
  return {
    text: String(text == null ? '' : text),
    kind: normalizeKind(kind),
    lane: safeLane,
    startAt: start,
    endAt: start + dur,
    durationMs: dur,
  };
}

/**
 * 纯逻辑模型：轨道占用 / 去重 / 同屏上限 / 排队 / 模式，全在这里。
 * 不碰 DOM、不自己读时钟（`now` 可注入），所以测试能按毫秒精确推进。
 *
 *   push({text, kind}) → { ok, queued?, reason?, bullet? }
 *   expire(now)        → { removed: id[], added: bullet[] }（定时器到点后调用）
 *   tick(now)          → 同上（`expire` 的别名，语义更直白）
 *   setMode(mode)      → 切换模式（离开弹幕模式时清空轨道 / 队列）
 *   clear()            → 清空一切（含去重表）
 *   snapshot()         → { mode, onScreen, queued, lanes, bullets, dropped }
 */
export function createDanmakuModel({
  now = () => Date.now(),
  mode = DANMAKU_DEFAULT_MODE,
  laneCount = DANMAKU_LANE_COUNT,
  maxOnScreen = DANMAKU_MAX_ON_SCREEN,
  queueMax = DANMAKU_QUEUE_MAX,
  dedupeMs = DANMAKU_DEDUPE_MS,
  flightMs = DANMAKU_FLIGHT_MS,
  laneGapMs = DANMAKU_LANE_GAP_MS,
} = {}) {
  const laneTotal = Math.max(1, Math.floor(Number(laneCount)) || DANMAKU_LANE_COUNT);
  const screenMax = Math.max(1, Math.floor(Number(maxOnScreen)) || DANMAKU_MAX_ON_SCREEN);
  const queueLimit = Math.max(0, Math.floor(Number(queueMax)) || 0);
  const dedupeWindow = Math.max(0, Number(dedupeMs) || 0);
  const flight = Math.max(1, Number(flightMs) || DANMAKU_FLIGHT_MS);
  const laneGap = Math.max(0, Number(laneGapMs) || 0);

  let currentMode = normalizeMode(mode);
  let bullets = [];
  let queue = [];
  let laneFreeAt = new Array(laneTotal).fill(0);
  const seenAt = new Map();
  let nextId = 1;
  let dropped = 0;

  function emit(item, at) {
    const lane = pickLane(laneFreeAt, at);
    const bullet = {
      id: nextId,
      ...layoutBullet({
        text: item.text,
        kind: item.kind,
        lane,
        startAt: at,
        durationMs: flight,
        laneCount: laneTotal,
      }),
    };
    nextId += 1;
    bullets.push(bullet);
    laneFreeAt[lane] = at + laneGap;
    return bullet;
  }

  function push({ text = '', kind = 'user' } = {}) {
    if (currentMode !== 'danmaku') return { ok: false, reason: 'mode' };
    const body = String(text == null ? '' : text).trim();
    if (!body) return { ok: false, reason: 'empty' };
    const k = normalizeKind(kind);
    const key = `${k}\u0000${body}`;
    const at = Number(now()) || 0;
    const prev = seenAt.get(key);
    if (prev !== undefined && at - prev < dedupeWindow) return { ok: false, reason: 'duplicate' };
    seenAt.set(key, at);

    const item = { text: body, kind: k };
    // 同屏满了（或已经有人在排队）→ 进队列，保证先来的先出
    if (bullets.length >= screenMax || queue.length > 0) {
      if (queue.length >= queueLimit) {
        dropped += 1;
        return { ok: false, reason: 'queue-full' };
      }
      queue.push(item);
      return { ok: true, queued: true };
    }
    return { ok: true, queued: false, bullet: emit(item, at) };
  }

  function expire(at = Number(now()) || 0) {
    const removed = [];
    bullets = bullets.filter((b) => {
      if (b.endAt <= at) { removed.push(b.id); return false; }
      return true;
    });
    const added = [];
    while (queue.length && bullets.length < screenMax) {
      added.push(emit(queue.shift(), at));
    }
    return { removed, added };
  }

  function setMode(next) {
    const modeNext = normalizeMode(next);
    if (modeNext === currentMode) return currentMode;
    currentMode = modeNext;
    bullets = [];
    queue = [];
    laneFreeAt = new Array(laneTotal).fill(0);
    return currentMode;
  }

  function clear() {
    bullets = [];
    queue = [];
    laneFreeAt = new Array(laneTotal).fill(0);
    seenAt.clear();
    return snapshot();
  }

  function snapshot() {
    return {
      mode: currentMode,
      onScreen: bullets.length,
      queued: queue.length,
      lanes: laneFreeAt.slice(),
      bullets: bullets.map((b) => ({ ...b })),
      dropped,
    };
  }

  return {
    laneCount: laneTotal,
    maxOnScreen: screenMax,
    queueMax: queueLimit,
    push,
    expire,
    tick: expire,
    setMode,
    clear,
    snapshot,
    get mode() { return currentMode; },
    get onScreen() { return bullets.length; },
    get queued() { return queue.length; },
  };
}

/**
 * DOM 渲染层（纯逻辑在模型里，这里只做元素 / 定时器 / 文案）。
 *
 * @param {object} opts
 * @param {HTMLElement|null} opts.layer    `#danmakuLayer`
 * @param {HTMLElement|null} opts.lastEl   `#danmakuLast`（底部「最近一句」）
 * @param {object} [opts.settings]         只读 `settings.dialogue`（'danmaku'|'subtitle'|'off'）
 * @param {Document} [opts.doc]
 * @param {Window} [opts.win]
 * @param {Function} [opts.now]
 * @param {Function} [opts.setTimer]
 * @param {Function} [opts.clearTimer]
 */
export function createDanmaku({
  layer = null,
  lastEl = null,
  settings = null,
  doc = null,
  win = null,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  model = null,
} = {}) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const w = win || (typeof window !== 'undefined' ? window : null) || {};

  const readMode = () => normalizeMode(settings && settings.dialogue !== undefined
    ? settings.dialogue
    : DANMAKU_DEFAULT_MODE);
  const m = model || createDanmakuModel({ now, mode: readMode() });
  const nodes = new Map();       // bullet id → DOM 节点
  const timers = new Map();      // bullet id → setTimeout id
  let lastFinal = { text: '', kind: 'user' };
  let interimText = '';
  let destroyed = false;

  function prefersReducedMotion() {
    try {
      const q = typeof w.matchMedia === 'function' ? w.matchMedia('(prefers-reduced-motion: reduce)') : null;
      return !!(q && q.matches);
    } catch {
      return false;
    }
  }

  function who(kind) {
    return t(kind === 'coach' ? 'voice.coach' : 'voice.you');
  }

  function applyLast() {
    if (!lastEl) return;
    const line = interimText
      ? { text: interimText, kind: 'user', interim: true }
      : { text: lastFinal.text, kind: lastFinal.kind, interim: false };
    const show = m.mode !== 'off' && !!line.text;
    lastEl.hidden = !show;
    if (!show) {
      lastEl.textContent = '';
      return;
    }
    lastEl.textContent = `${who(line.kind)}${line.text}`;
    if (lastEl.dataset) lastEl.dataset.kind = line.kind;
    if (lastEl.classList) {
      lastEl.classList.toggle('danmaku-last--coach', line.kind === 'coach');
      lastEl.classList.toggle('danmaku-last--interim', !!line.interim);
    }
  }

  function syncLayer() {
    if (!layer) return;
    layer.hidden = m.mode !== 'danmaku';
    if (layer.dataset) layer.dataset.mode = m.mode;
    if (layer.classList) layer.classList.toggle('danmaku-layer--static', prefersReducedMotion());
  }

  function removeNode(id) {
    const node = nodes.get(id);
    nodes.delete(id);
    const timer = timers.get(id);
    if (timer !== undefined) {
      try { clearTimer(timer); } catch { /* ignore */ }
      timers.delete(id);
    }
    if (!node || !layer) return;
    try {
      if (typeof layer.removeChild === 'function') layer.removeChild(node);
      else if (typeof node.remove === 'function') node.remove();
    } catch { /* ignore */ }
  }

  /** 减少动效：只留最新两行（用户口径「降级成静态两行」） */
  function pruneStatic() {
    const ids = [...nodes.keys()];
    while (ids.length > DANMAKU_STATIC_MAX) {
      removeNode(ids.shift());
    }
  }

  function renderBullet(bullet) {
    if (!d || !layer || !bullet) return null;
    const node = d.createElement('div');
    node.className = `danmaku danmaku--${bullet.kind} danmaku--lane-${bullet.lane}`;
    if (node.dataset) {
      node.dataset.kind = bullet.kind;
      node.dataset.lane = String(bullet.lane);
    }
    if (node.style && typeof node.style.setProperty === 'function') {
      node.style.setProperty('--lane', String(bullet.lane));
    } else if (node.style) {
      node.style['--lane'] = String(bullet.lane);
    }
    node.textContent = `${who(bullet.kind)}${bullet.text}`;
    const staticMode = prefersReducedMotion();
    if (staticMode && node.classList) node.classList.add('danmaku--static');
    layer.appendChild(node);
    nodes.set(bullet.id, node);
    if (staticMode) {
      pruneStatic();
      return node;
    }
    const wait = Math.max(0, Number(bullet.endAt) - now());
    const timer = setTimer(() => {
      if (destroyed) return;
      // 先让模型结算到点的（可能不止这一条），再把新增的排队项渲染出来
      const { removed, added } = m.expire(now());
      for (const id of removed) removeNode(id);
      removeNode(bullet.id);
      for (const b of added) renderBullet(b);
      syncLayer();
    }, wait);
    timers.set(bullet.id, timer);
    return node;
  }

  function clearNodes() {
    for (const id of [...nodes.keys()]) removeNode(id);
    nodes.clear();
  }

  /** 一条最终字幕：先更新底部「最近一句」，弹幕模式下再飞一条 */
  function push({ text = '', kind = 'user' } = {}) {
    if (destroyed) return { ok: false, reason: 'destroyed' };
    const body = String(text == null ? '' : text).trim();
    if (!body) return { ok: false, reason: 'empty' };
    const k = normalizeKind(kind);
    lastFinal = { text: body, kind: k };
    interimText = '';
    applyLast();
    syncLayer();
    if (m.mode !== 'danmaku') return { ok: true, queued: false, displayed: false };
    const result = m.push({ text: body, kind: k });
    if (result.ok && result.bullet) renderBullet(result.bullet);
    syncLayer();
    return result;
  }

  /** ASR 的中间结果：只更新底部灰色实时行，**不弹弹幕** */
  function setInterim(text = '') {
    if (destroyed) return;
    const body = String(text == null ? '' : text).trim();
    if (body === interimText) return;
    interimText = body;
    applyLast();
  }

  function setMode(next) {
    m.setMode(next);
    clearNodes();
    if (m.mode !== 'danmaku') interimText = '';
    syncLayer();
    applyLast();
    return m.mode;
  }

  function clear() {
    m.clear();
    clearNodes();
    lastFinal = { text: '', kind: 'user' };
    interimText = '';
    applyLast();
    syncLayer();
    return m.snapshot();
  }

  function destroy() {
    destroyed = true;
    clearNodes();
    m.clear();
    lastFinal = { text: '', kind: 'user' };
    interimText = '';
    applyLast();
    return api;
  }

  const api = {
    push,
    setInterim,
    setMode,
    clear,
    destroy,
    snapshot() {
      return { ...m.snapshot(), last: { ...lastFinal }, interim: interimText };
    },
    get mode() { return m.mode; },
    get onScreen() { return m.onScreen; },
    get queued() { return m.queued; },
    get lastText() { return interimText || lastFinal.text; },
    get reducedMotion() { return prefersReducedMotion(); },
    model: m,
    nodes,
    laneCount: m.laneCount,
    maxOnScreen: m.maxOnScreen,
    queueMax: m.queueMax,
  };
  syncLayer();
  applyLast();
  return api;
}

export default {
  DANMAKU_LANE_COUNT,
  DANMAKU_MAX_ON_SCREEN,
  DANMAKU_QUEUE_MAX,
  DANMAKU_DEDUPE_MS,
  DANMAKU_MODES,
  DANMAKU_DEFAULT_MODE,
  DANMAKU_COLORS,
  pickLane,
  layoutBullet,
  createDanmakuModel,
  createDanmaku,
};
