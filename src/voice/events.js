/**
 * 事件总线（R1「动态快车道」的地基，纯 JS，**不碰 DOM**）。
 *
 * 为什么要有它：教练原来有两条通道 ——
 *   ① 命令快车道（说「暂停」→ 直接执行，不联网）；
 *   ③ LLM 环路（说别的 → POST /llm）。
 * 中间缺一层**确定性**的：用户要「每 5 秒读一次秒」，系统应该订阅读秒事件、到点直接 TTS，
 * **一个请求都不发**。这一层就是 ② 规则快车道，而它要的是一份「谁在什么时候发生了什么」。
 *
 * 于是把原来散在 `session.js`（自己攒 60 秒环形缓冲）和 `llm.js`（自己再裁一遍）里的
 * 事件口径收敛到这里：**一处定义**，`session.recentEvents()` 与规则引擎读的都是同一条总线。
 *
 * 约定：
 *   - `emit(type, data)` → `{ seq, t, type, data }`（seq 单调递增，t = 毫秒时间戳）；
 *   - 订阅：`on('rep', fn)` 按事件类型、`on('gate:*', fn)` 按前缀、`on('*', fn)` 全订阅；
 *     返回**取消订阅函数**；一个 handler 抛错绝不影响其它订阅（也绝不影响 emit 的调用方）；
 *   - `recent({ sinceMs, limit })` → 最近的紧凑事件（只给 LLM prompt 用：
 *     60 秒窗口、≤60 条、单条 ≤60 字符、data 只留标量，**绝不含原始关键点**）；
 *   - 事件白名单就是 `EVENT_TYPES` 那 14 个，全部来自**现有**识别器 / 计时器，没有新造信号。
 */

/** 环形缓冲容量（60 秒窗口内最多留这么多条；比 60 多一点，留给「同一秒里连着几条」的情况） */
export const EVENT_CAPACITY = 120;
/** `recent()` 默认窗口：最近 60 秒 */
export const EVENT_WINDOW_MS = 60 * 1000;
/** 单条紧凑事件的序列化上限（字符；超了从后往前丢 data 字段） */
export const EVENT_MAX_CHARS = 60;
/** 紧凑事件里 data 最多留几个标量字段 */
export const EVENT_MAX_FIELDS = 4;
/** 紧凑事件里字符串值最多留几个字 */
export const EVENT_MAX_STR = 20;

/**
 * 事件白名单（R1 就用这些，**全部来自现有识别器 / 计时器**）：
 *
 *   计次     rep{n}                    识别器计上/计半程的那一下
 *   一组     set-start / set-complete{reps,score}
 *   门控     gate-fail{gate} / gate-ok
 *   关键帧   keyframe-hit{id} / keyframe-miss{id}
 *   进度     progress{pct}
 *   计时     tick{elapsedSec} / hold-tick{remainingSec}
 *   状态     idle{sec} / tempo{perMin}
 *   会话     session-start / session-end
 */
export const EVENT_TYPES = Object.freeze([
  'rep',
  'set-start',
  'set-complete',
  'gate-fail',
  'gate-ok',
  'keyframe-hit',
  'keyframe-miss',
  'progress',
  'tick',
  'hold-tick',
  'idle',
  'tempo',
  'session-start',
  'session-end',
]);

/**
 * 进 LLM prompt 的那几类（Agent context 的 `recentEvents` 只认这 4 个）。
 * 与 `llm.js` 的 `AGENT_EVENT_KINDS`、`session.js` 的 `EVENT_KINDS` 是**同一份数组**。
 */
export const AGENT_EVENT_TYPES = Object.freeze(['rep', 'gate-fail', 'keyframe-hit', 'keyframe-miss']);

/** 事件类型是否在白名单里（纯函数） */
export function isEventType(type) {
  return EVENT_TYPES.includes(String(type || ''));
}

/**
 * 订阅模式匹配（纯函数）：`*` 全匹配，`prefix:*`（或 `prefix*`）前缀匹配，其余按类型全等。
 * 前缀写法容忍分隔符：`gate:*` / `gate-*` / `gate*` 都匹配 `gate-fail` / `gate-ok`。
 */
export function matchPattern(pattern, type) {
  const p = String(pattern || '');
  const ty = String(type || '');
  if (!p || !ty) return false;
  if (p === '*') return true;
  if (p.endsWith('*')) {
    let prefix = p.slice(0, -1);
    if (prefix.endsWith(':')) prefix = prefix.slice(0, -1);
    return prefix ? ty.startsWith(prefix) : true;
  }
  return p === ty;
}

/**
 * 把任意 data 压成「只有标量」的紧凑形状（纯函数）。
 *
 * 规则：数组 / 对象（关键点就在这里面）一律丢掉；键最多 `EVENT_MAX_FIELDS` 个、
 * 字符串最多 `EVENT_MAX_STR` 字；序列化超 `maxChars` 就从后往前丢字段。
 * 空 data 一定装得下（类型本身不动）。
 *
 * @param {object} data
 * @param {string} [type]
 * @param {{maxChars?:number}} [opts] `maxChars = 0` → 不按字符数丢字段（订阅者拿完整标量）
 */
export function compactEventData(data, type = '', { maxChars = EVENT_MAX_CHARS } = {}) {
  const src = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const out = {};
  let n = 0;
  for (const [key, value] of Object.entries(src)) {
    if (n >= EVENT_MAX_FIELDS) break;
    if (typeof value === 'string') {
      out[key] = value.slice(0, EVENT_MAX_STR);
      n += 1;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
      n += 1;
    } else if (typeof value === 'boolean') {
      out[key] = value;
      n += 1;
    }
  }
  const cap = Number(maxChars) > 0 ? Number(maxChars) : 0;
  while (cap && Object.keys(out).length
    && JSON.stringify({ t: 0, type: String(type || ''), data: out }).length > cap) {
    delete out[Object.keys(out).pop()];
  }
  return out;
}

/**
 * 创建一条事件总线。
 *
 * @param {object}   [opts]
 * @param {Function} [opts.now]      注入时钟（测试固定时间戳；默认 Date.now）
 * @param {number}   [opts.capacity] 环形缓冲容量（默认 EVENT_CAPACITY = 120）
 */
export function createEventBus({ now = () => Date.now(), capacity = EVENT_CAPACITY } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const max = Number.isFinite(Number(capacity)) && Number(capacity) > 0
    ? Math.floor(Number(capacity))
    : EVENT_CAPACITY;
  /** 紧凑环形缓冲（只给 recent / LLM prompt 用） */
  let ring = [];
  const listeners = new Set();
  let seq = 0;

  const at = () => {
    const v = Number(clock());
    return Number.isFinite(v) ? v : 0;
  };

  /** 剪掉窗口外 / 超容量的（读、写都剪：容量 + 时间窗两道限制） */
  function trim(nowMs = at()) {
    const cutoff = nowMs - EVENT_WINDOW_MS;
    let drop = 0;
    while (drop < ring.length && ring[drop].t < cutoff) drop += 1;
    if (drop > 0) ring = ring.slice(drop);
    if (ring.length > max) ring = ring.slice(ring.length - max);
  }

  /**
   * 发一条事件。
   *
   * 订阅者拿到的是**完整**事件（data 里可以有 `target` / `remaining` 这类规则要用的字段，
   * 仍然只留标量 —— 数组 / 对象一律不进总线）；
   * 环形缓冲里存的是**紧凑**副本（`compactEventData`），所以 `recent()` 一定短。
   *
   * @returns {{seq:number,t:number,type:string,data:object}|null} 不在白名单 → null（不发）
   */
  function emit(type, data = {}) {
    const ty = String(type || '');
    if (!EVENT_TYPES.includes(ty)) return null;
    const t = at();
    seq += 1;
    // 订阅者拿完整标量（规则要 target / remaining）；环形缓冲存紧凑副本（LLM prompt 一定短）
    const event = { seq, t, type: ty, data: compactEventData(data, ty, { maxChars: 0 }) };
    ring.push({ seq, t, type: ty, data: compactEventData(data, ty, { maxChars: EVENT_MAX_CHARS }) });
    if (ring.length > max) ring = ring.slice(ring.length - max);
    trim(t);
    // 一个订阅者抛错不该影响其它订阅，也不该影响调用方（教练 / 训练主流程）
    for (const item of [...listeners]) {
      if (!matchPattern(item.pattern, ty)) continue;
      try { item.handler(event); } catch { /* ignore */ }
    }
    return event;
  }

  /**
   * 订阅：`on('rep', fn)` / `on('gate:*', fn)` / `on('*', fn)`。
   * @returns {Function} 取消订阅（可以重复调用）
   */
  function on(pattern, handler) {
    if (typeof handler !== 'function') return () => {};
    const item = { pattern: String(pattern || '*'), handler };
    listeners.add(item);
    return () => listeners.delete(item);
  }

  /**
   * 最近事件（紧凑副本，最新的在后）。
   * @param {object} [opts]
   * @param {number} [opts.sinceMs] 窗口（默认 60 秒）
   * @param {number} [opts.limit]   最多几条（默认容量）
   * @param {string[]} [opts.types] 只要这几类（可选）
   */
  function recent({ sinceMs = EVENT_WINDOW_MS, limit = max, types = null } = {}) {
    const nowMs = at();
    trim(nowMs);
    const win = Number.isFinite(Number(sinceMs)) && Number(sinceMs) > 0
      ? Number(sinceMs) : EVENT_WINDOW_MS;
    const cutoff = nowMs - win;
    const want = Array.isArray(types) && types.length ? types.map(String) : null;
    const out = ring
      .filter((ev) => ev.t >= cutoff && (!want || want.includes(ev.type)))
      .map((ev) => ({ seq: ev.seq, t: ev.t, type: ev.type, data: { ...ev.data } }));
    const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : max;
    return out.slice(Math.max(0, out.length - n));
  }

  return {
    emit,
    on,
    recent,
    /** 清空（换动作 / 回首页 / 测试用例之间） */
    clear() { ring = []; },
    /** 现有事件条数（诊断 / 测试用） */
    get size() { trim(); return ring.length; },
    /** 容量（测试断言用） */
    get capacity() { return max; },
    /** 已经发过多少条（seq 单调递增，clear 不回退） */
    get seq() { return seq; },
    /** 总线的时钟（同一个 now 注入给 session 与规则引擎，别各用各的） */
    now: at,
  };
}

export default { createEventBus, compactEventData, matchPattern, isEventType, EVENT_TYPES, AGENT_EVENT_TYPES };
