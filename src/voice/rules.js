/**
 * 规则快车道（R1「动态快车道」的引擎 + R2「私人教练式缺省规则」，**纯函数 / 不碰 DOM**）。
 *
 * 用户原话：「除了命令快车道，还应该有**动态快车道**：用户要求每 5 秒读秒，系统就订阅读秒事件，
 * 到点直接 TTS，**不请求 LLM**。」
 * 用户原话（R2）：「缺省情况下要帮客户计次；计时的运动要每 5 秒读秒一次。」
 *
 * 这一层 = 事件总线（`events.js`）+ 规则表：每条规则是
 *   `{ id, scope, channel, label, trigger:{event, filter, resetOn}, action:{template, args},
 *      cooldownMs, priority, budget:{perSet, perMinute}, adaptive, bypassGap, volumes, enabled }`
 * 命中就返回一句要念的话，**一个网络请求都不发**（也就一分钱不花）。
 *
 * 本模块只做判断，不念话：真正开口的是 app.js 里现有的 `voice.onCoachText()`（弹幕 + TTS）。
 *
 * 护栏（缺一条都会变成「教练很吵」）：
 *   - 同一条规则 `cooldownMs` 内不再开口；
 *   - **全局最小开口间隔 `MIN_GAP_MS = 6000`**（计数 / 读秒类规则带 `bypassGap:true`，单独放行）；
 *   - 每条规则自己的 `budget.perSet` / `budget.perMinute`；
 *   - 计数规则还有**自适应降频**：按当前节奏 1/2/3 个报一次 + 两次报数至少隔 1 秒（每秒最多 1 次）；
 *   - 同一个 tick（同一毫秒 / 同一帧）**只让最高优先级的那一条说话**；
 *   - 教练正在说话（`state.speaking`）→ 除 `bypassGap` 的计数 / 读秒外**一律丢弃**（不排队、不叠音）；
 *     计数通道再细一层：剩余台词 >1.5s（`state.speakLeftMs`）就跳过这一下；
 *   - 静音 / 教练关 → **全部丢弃**；
 *   - `scope` 到期自动清：`set-complete` 清 `set` 规则的运行期状态、
 *     `session-end` **删掉** `session` 规则（口述建的规则只活一次训练）。
 */

import { t as defaultTranslate, hasKey, getLang } from '../i18n.js';
import { GATE_HINT } from '../engines.js';
import { EVENT_TYPES } from './events.js';
import { numberWord } from './numerals.js';

/** 全局最小开口间隔（毫秒）：两条规则话之间至少隔这么久，读秒类的 `bypassGap` 规则除外 */
export const MIN_GAP_MS = 6000;

/**
 * 计时类动作（hold / 限时）默认每 5 秒读一次秒（用户原话：「计时的运动要每 5 秒读秒一次」）。
 * 这也是「读秒间隔」规则缺省值：`hold-read-5` 的 `filter.everySec`。
 */
export const DEFAULT_READ_EVERY_SEC = 5;

/**
 * 计次类动作的「自适应降频」参数（R2 用户原话：
 * 「目标每秒最多 1 次播报；节奏快时（<1.5s 一个）改成每 2 个 / 每 3 个，避免 TTS 追不上排队」）。
 *
 *   fastMs          一个动作间隔 ≥1.5s → 每个都报（`stride = 1`）
 *   midMs           1.0~1.5s → 每 2 个报一次
 *   maxStride       更快（<1s 一个）→ 最多降到每 3 个（再稀就听不出在计数了）
 *   minStepMs       两次报数之间至少 1 秒 → **每秒最多 1 次播报**
 *   milestoneEvery  每 5 个那一下是「五个了」的整句鼓励，**允许越过 stride**（但仍在 minStep 之内）
 *   lowVolumeStride 话量=少 → 只报每 5 个
 *   skipWhileSpeakingMs 教练正在说话时，剩余台词 >1.5s 就跳过这一下（不积压）
 */
export const ADAPTIVE_REP = Object.freeze({
  fastMs: 1500,
  midMs: 1000,
  maxStride: 3,
  minStepMs: 1000,
  milestoneEvery: 5,
  lowVolumeStride: 5,
  skipWhileSpeakingMs: 1500,
});

/** 优先级（数字大的先说话；用户拍板的档位：破纪录 > 纠正 > 读秒 > 计数 > 鼓励） */
export const RULE_PRIORITIES = Object.freeze({
  /** 破纪录（R3 的 `add_rule` 之后会用到；先占住最高档，别让纠正抢在报喜前面） */
  record: 100,
  /** 纠正（门控连错 / 姿势没到位） */
  correct: 60,
  /** 读秒（最后 5 秒倒数 / 每 5 秒读一次秒） */
  read: 45,
  /** 读秒（最后 5 秒 / 最后 3 个） */
  countdown: 40,
  /** 计数（每做一个报一个 —— 私人教练的数数声，压过鼓励但让位给读秒 / 纠正） */
  count: 35,
  /** 鼓励（过半） */
  encourage: 30,
  /** 催促（8 秒没动） */
  idle: 20,
});

/**
 * 两条「频道」规则（口述建 / 删规则只在这两个频道里替换，见 `addCoachRule`）：
 *   rep  —— 报数间隔（缺省 `rep-count`：每个都报 + 自适应降频）
 *   read —— 读秒间隔（缺省 `hold-read-5`：计时类每 5 秒报一次已经过了几秒）
 */
export const RULE_CHANNELS = Object.freeze(['rep', 'read']);

/** 每个频道的缺省规则 id（一处定义：内置规则表 / 恢复默认 / 测试都读它） */
export const DEFAULT_RULE_BY_CHANNEL = Object.freeze({
  rep: 'rep-count',
  read: 'hold-read-5',
});

/** 规则作用域：一组 / 一次训练 / 永久（内置规则没有 forever，留给以后的自定义规则） */
export const RULE_SCOPES = Object.freeze(['set', 'session', 'forever']);

/** 教练话量三档（设置里的「少 / 中 / 多」） */
export const COACH_VOLUMES = Object.freeze(['low', 'mid', 'high']);
export const DEFAULT_COACH_VOLUME = 'mid';

/** 话量归一化（脏值一律当中档） */
export function normalizeCoachVolume(value) {
  return COACH_VOLUMES.includes(value) ? value : DEFAULT_COACH_VOLUME;
}

/** 话量三档各留哪些规则（`volumes` 缺省 = 三档都说） */
export function ruleVolumes(rule) {
  const list = rule && Array.isArray(rule.volumes) && rule.volumes.length ? rule.volumes : COACH_VOLUMES;
  return list.filter((v) => COACH_VOLUMES.includes(v));
}

/** 有限数字才算数（`undefined` / `NaN` / 字符串数字都按「没有」处理） */
function num(value) {
  const v = Number(value);
  return Number.isFinite(v) ? v : null;
}

/**
 * 一条事件的「判定上下文」（纯函数）：规则 filter 读的都是这里算好的数。
 *
 * 事件 data 里带什么就用什么；没带的按 `n` / `target` 推出来
 * （`rep` 事件只给次数也能算出「还剩几个」「进度百分比」）。
 */
export function eventContext(event, streak = 0) {
  const d = event && event.data && typeof event.data === 'object' ? event.data : {};
  const n = num(d.n);
  const target = num(d.target);
  // 「还剩多少」：计次类给 remaining / 由 n、target 推；读秒类（hold-tick / tick）给的是 remainingSec
  const remaining = num(d.remaining) ?? num(d.remainingSec)
    ?? (n !== null && target ? target - n : null);
  const pct = num(d.pct) ?? (n !== null && target ? (n / target) * 100 : null);
  const sec = num(d.sec) ?? num(d.elapsedSec) ?? num(d.remainingSec);
  return {
    n: n === null ? 0 : n,
    target: target === null ? 0 : target,
    remaining,
    pct,
    sec,
    streak: Math.max(0, Math.round(Number(streak) || 0)),
    gate: String(d.g ?? d.gate ?? ''),
    id: String(d.id ?? d.k ?? ''),
    /** 时间型动作（保持类 / 限时计数类）发出来的 tick 带 hold:1；限时计数类另带 timed:1 */
    hold: d.hold === true || d.hold === 1,
    timed: d.timed === true || d.timed === 1,
    raw: d,
  };
}

/**
 * filter 是否命中（纯函数）。
 *
 * 支持：`everyN`（每 N 次）· `everySec`（每 N 秒，`n > 0` 才命中 —— 0 秒不报）·
 *       `remainingLte` / `remainingGt`（还剩 ≤N / >N）· `pctGte`（进度 ≥N%）·
 *       `consecutive`（连续 N 次）· `secLte` / `secGte`（秒数）·
 *       `hold` / `timed`（只要计时类 / 限时类的 tick）。
 * 不给 filter（或空对象）= 只要事件类型对上就命中（冷却 / 预算 / 间隔仍生效）。
 */
export function matchesFilter(filter, ctx, { ignoreConsecutive = false } = {}) {
  const f = filter && typeof filter === 'object' ? filter : null;
  if (!f) return true;
  const everyN = num(f.everyN);
  if (everyN !== null) {
    if (!(ctx.n > 0) || ctx.n % everyN !== 0) return false;
  }
  const everySec = num(f.everySec);
  if (everySec !== null) {
    // `sec` 是计时事件（tick / hold-tick）里的秒数；0 秒不报（一开始就喊「0 秒」很吵）
    if (ctx.sec === null || !(ctx.sec > 0) || ctx.sec % everySec !== 0) return false;
  }
  const remainingLte = num(f.remainingLte);
  if (remainingLte !== null) {
    if (ctx.remaining === null || ctx.remaining > remainingLte) return false;
  }
  const remainingGt = num(f.remainingGt);
  if (remainingGt !== null) {
    if (ctx.remaining === null || !(ctx.remaining > remainingGt)) return false;
  }
  if (f.hold === true && ctx.hold !== true) return false;
  if (f.timed === true && ctx.timed !== true) return false;
  const pctGte = num(f.pctGte);
  if (pctGte !== null) {
    if (ctx.pct === null || !(ctx.pct >= pctGte)) return false;
  }
  const secLte = num(f.secLte);
  if (secLte !== null) {
    if (ctx.sec === null || !(ctx.sec <= secLte)) return false;
  }
  const secGte = num(f.secGte);
  if (secGte !== null) {
    if (ctx.sec === null || !(ctx.sec >= secGte)) return false;
  }
  const consecutive = num(f.consecutive);
  if (!ignoreConsecutive && consecutive !== null) {
    if (!(ctx.streak >= consecutive)) return false;
  }
  return true;
}

/** 一条规则归一化（缺省值补齐；`enabled` 默认开） */
export function normalizeRule(rule) {
  const r = rule && typeof rule === 'object' ? rule : {};
  const id = String(r.id || '').trim();
  if (!id) return null;
  const trigger = r.trigger && typeof r.trigger === 'object' ? r.trigger : {};
  const event = String(trigger.event || '');
  if (!EVENT_TYPES.includes(event)) return null;
  const priority = num(r.priority);
  const cooldownMs = num(r.cooldownMs);
  const budget = r.budget && typeof r.budget === 'object' ? r.budget : {};
  const channel = RULE_CHANNELS.includes(r.channel) ? r.channel : '';
  const adaptive = r.adaptive && typeof r.adaptive === 'object' && Object.keys(r.adaptive).length
    ? { ...r.adaptive }
    : null;
  return {
    id,
    scope: RULE_SCOPES.includes(r.scope) ? r.scope : 'session',
    /** 频道：rep（报数间隔）/ read（读秒间隔）/ ''（R1 那几条固定规则） */
    channel,
    /** 规则名（`rule.name.*` 词条键；`listRules` / 设置页用它说人话） */
    label: String(r.label || ''),
    trigger: {
      event,
      filter: trigger.filter && typeof trigger.filter === 'object' ? { ...trigger.filter } : null,
      resetOn: [].concat(trigger.resetOn || []).map(String),
    },
    action: r.action && typeof r.action === 'object' ? r.action : {},
    cooldownMs: cooldownMs === null ? 0 : Math.max(0, cooldownMs),
    priority: priority === null ? RULE_PRIORITIES.encourage : priority,
    budget: {
      perSet: Math.max(0, num(budget.perSet) || 0),
      perMinute: Math.max(0, num(budget.perMinute) || 0),
    },
    /** 自适应降频参数（只有「计数」这一条带；见 ADAPTIVE_REP） */
    adaptive,
    bypassGap: r.bypassGap === true,
    volumes: ruleVolumes(r),
    enabled: r.enabled !== false,
  };
}

/**
 * 「这一次该不该报数」—— 自适应降频的核心（纯函数，测试直接喂数字）。
 *
 * 用户原话：「按当前节奏自动降频 —— 目标每秒最多 1 次播报；节奏快时（<1.5s 一个）
 * 改成每 2 个 / 每 3 个，避免 TTS 追不上排队。」
 *
 * @param {number} paceMs 相邻两次动作的间隔（毫秒；0 / 非数字 = 还没样本 → 每个都报）
 * @param {object} [opts] 覆盖 ADAPTIVE_REP 的任意字段
 * @returns {number} 1 / 2 / 3（话量=少的 5 不在这里，见 `adaptiveAllows`）
 */
export function strideForPace(paceMs, opts = {}) {
  const o = { ...ADAPTIVE_REP, ...(opts && typeof opts === 'object' ? opts : {}) };
  const pace = Number(paceMs);
  if (!Number.isFinite(pace) || pace <= 0) return 1;
  if (pace >= o.fastMs) return 1;
  if (pace >= o.midMs) return 2;
  return Math.max(1, Math.round(Number(o.maxStride) || 1));
}

/**
 * 带 `adaptive` 的规则这一次能不能开口（纯函数）。
 *
 * 依次要求：次数 > 0 → 命中 stride（「每 5 个」那种整句可以越过 stride）→ 距上一次报数
 * 至少 `minStepMs`（**每秒最多 1 次播报**）。话量=少直接把 stride 换成 `lowVolumeStride`。
 *
 * @param {object} rule   归一化后的规则（要有 `adaptive`）
 * @param {object} rt     运行期状态（`lastAt` / `paceMs`）
 * @param {object} ctx    eventContext()
 * @param {string} volume 当前话量档位
 * @param {number} at     事件时刻（毫秒）
 */
export function adaptiveAllows(rule, rt, ctx, volume, at) {
  const a = rule && rule.adaptive ? rule.adaptive : null;
  if (!a) return true;
  const n = Number(ctx && ctx.n);
  if (!Number.isFinite(n) || n <= 0) return false;
  const lowStride = num(a.lowVolumeStride) ?? ADAPTIVE_REP.lowVolumeStride;
  const stride = String(volume) === 'low' ? lowStride : strideForPace(rt && rt.paceMs, a);
  const milestoneEvery = num(a.milestoneEvery) ?? 0;
  const milestone = milestoneEvery > 0 && n % milestoneEvery === 0;
  if (!milestone && n % Math.max(1, stride) !== 0) return false;
  const minStep = num(a.minStepMs) ?? ADAPTIVE_REP.minStepMs;
  const lastAt = rt && Number.isFinite(Number(rt.lastAt)) ? Number(rt.lastAt) : -Infinity;
  if (lastAt > -Infinity && Number(at) - lastAt < minStep) return false;
  return true;
}

/** 一句话大约要念多久（毫秒）：给「教练正在说话时还剩多少」用（偏保守，宁可多算） */
export function estimateSpeechMs(text, { charMs = 200, minMs = 600, maxMs = 12000 } = {}) {
  const chars = [...String(text == null ? '' : text)].length;
  const ms = Math.round(Math.max(0, chars) * Math.max(1, Number(charMs) || 200));
  return Math.max(Number(minMs) || 0, Math.min(Number(maxMs) || 12000, ms));
}


/**
 * 创建规则引擎。
 *
 * @param {object}   [opts]
 * @param {Function} [opts.now]     注入时钟（测试固定时间戳；和事件总线用同一个 now）
 * @param {object}   [opts.diag]    诊断收集器（被护栏挡掉时记 `rule:skip {reason}`）
 * @param {Function} [opts.t]       取词条（默认 i18n 的 t；测试可注入）
 * @param {number}   [opts.minGapMs] 全局最小开口间隔（默认 MIN_GAP_MS；测试可调小）
 */
export function createRuleEngine({
  now = () => Date.now(),
  diag = null,
  t = defaultTranslate,
  minGapMs = MIN_GAP_MS,
} = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const gapMs = Math.max(0, num(minGapMs) ?? MIN_GAP_MS);
  const translate = typeof t === 'function' ? t : defaultTranslate;
  /** id → 归一化后的规则 */
  const rules = new Map();
  /** id → 运行期状态（冷却 / 预算 / 连续次数） */
  const runtime = new Map();
  let lastSpeakAt = -Infinity;
  let lastGapAt = -Infinity;
  let spoken = 0;

  function note(type, data) {
    try { diag?.record?.(type, data); } catch { /* 诊断永远不能拖垮规则 */ }
  }

  /** 一条规则的运行期状态（冷却 / 预算 / 连续次数 / 节奏） */
  function blankRuntime() {
    return {
      lastAt: -Infinity, setCount: 0, spokenAt: [], streak: 0,
      /** 上一次触发这条规则的事件时刻（算「节奏」用） */
      lastTriggerAt: -Infinity,
      /** 平滑后的相邻两次触发间隔（毫秒；0 = 还没有样本） */
      paceMs: 0,
    };
  }

  function runtimeOf(id) {
    if (!runtime.has(id)) runtime.set(id, blankRuntime());
    return runtime.get(id);
  }

  /** 加一条规则（同 id 覆盖） */
  function add(rule) {
    const r = normalizeRule(rule);
    if (!r) return null;
    rules.set(r.id, r);
    runtime.set(r.id, blankRuntime());
    return r;
  }

  function remove(id) {
    const key = String(id || '');
    const had = rules.delete(key);
    runtime.delete(key);
    return had;
  }

  /** 规则表（按优先级从高到低） */
  function list() {
    return [...rules.values()].sort((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id));
  }

  /** 清掉某一作用域的所有规则（`set` / `session` / `forever`） */
  function clearScope(scope) {
    const want = String(scope || '');
    let n = 0;
    for (const [id, rule] of [...rules.entries()]) {
      if (rule.scope !== want) continue;
      rules.delete(id);
      runtime.delete(id);
      n += 1;
    }
    return n;
  }

  /** 作用域到期：只清**运行期状态**（规则本身还在，下一组继续用） */
  function resetScope(scope) {
    for (const [id, rule] of rules.entries()) {
      if (rule.scope !== scope) continue;
      const rt = runtimeOf(id);
      rt.lastAt = -Infinity;
      rt.setCount = 0;
      rt.spokenAt = [];
      rt.streak = 0;
      rt.lastTriggerAt = -Infinity;
      rt.paceMs = 0;
    }
  }

  /** 全部清空（回首页 / 换一组 / 测试用例之间） */
  function clear() {
    rules.clear();
    runtime.clear();
    lastSpeakAt = -Infinity;
    lastGapAt = -Infinity;
    spoken = 0;
  }

  /** 只清运行期状态（规则表保留）：调试 / 测试里「换一组成立」时用 */
  function reset() {
    for (const [id] of runtime.entries()) {
      runtime.set(id, blankRuntime());
    }
    lastSpeakAt = -Infinity;
    lastGapAt = -Infinity;
  }

  /** 一条规则这一分钟里说了几次（预算用） */
  function minuteCount(rt, at) {
    const keep = rt.spokenAt.filter((x) => at - x < 60 * 1000);
    rt.spokenAt = keep;
    return keep.length;
  }

  /** 把 action 渲染成一句话（模板走 i18n；args / template 都可以是函数，按事件现算） */
  function renderAction(action, ctx, event) {
    const act = action || {};
    let key = '';
    try {
      // 计数规则按「第几个」换句子（第 5 个说「五个了」），所以模板允许是函数
      key = typeof act.template === 'function'
        ? String(act.template(ctx, event) || '')
        : String(act.template || '');
    } catch {
      key = '';
    }
    if (!key || !hasKey(key)) return '';
    let args = {};
    try {
      args = typeof act.args === 'function' ? (act.args(event, ctx) || {}) : (act.args || {});
    } catch {
      args = {};
    }
    const params = {
      n: ctx.n,
      remaining: ctx.remaining === null ? ctx.n : ctx.remaining,
      pct: ctx.pct === null ? 0 : Math.round(ctx.pct),
      sec: ctx.sec === null ? 0 : Math.round(ctx.sec),
      ...args,
    };
    const text = translate(key, params);
    return typeof text === 'string' ? text.trim() : '';
  }

  /** action 里带 intent 时一起返回（R3 的 `add_rule` 会用到；R1 内置规则都不带） */
  function actionList(action, ctx, event) {
    const act = action || {};
    if (!act.intent) return [];
    let args = {};
    try {
      args = typeof act.args === 'function' ? (act.args(event, ctx) || {}) : (act.args || {});
    } catch {
      args = {};
    }
    return [{ intent: String(act.intent), args: { ...args } }];
  }

  /**
   * 处理一条事件。
   *
   * @param {{type:string,data?:object,t?:number}} event 事件总线发出来的事件
   * @param {object} [state] `{ speaking, muted, coachOn, volume, tone }`（只读）
   * @returns {{speak:{text:string,ruleId:string,priority:number}, actions?:object[]}|null}
   */
  function handle(event, state = {}) {
    const ev = event && typeof event === 'object' ? event : null;
    if (!ev) return null;
    const type = String(ev.type || '');
    if (!EVENT_TYPES.includes(type)) return null;
    const st = state && typeof state === 'object' ? state : {};
    const at = num(ev.t) ?? (num(clock()) ?? 0);

    /* ① 作用域到期 / 会话开始：先清运行期状态（静音 / 正在说话时也要清） */
    if (type === 'set-start') {
      resetScope('set');
    } else if (type === 'set-complete') {
      resetScope('set');
    }
    if (type === 'session-start') {
      resetScope('set');
      resetScope('session');
      lastSpeakAt = -Infinity;
      lastGapAt = -Infinity;
    } else if (type === 'session-end') {
      resetScope('session');
      resetScope('set');
      // 口述建的规则是 `scope: session` 的 —— 一次训练结束就**真的删掉**（下次训练回到缺省规则，
      // 由 app.js 的 `ensureDefaultRules()` 补回来；用户不需要记住自己上次说过什么）。
      clearScope('session');
    }

    /* ② 连续次数 + 节奏：先按「这一次事件」更新每条规则的 streak / pace（含 resetOn） */
    for (const rule of rules.values()) {
      const rt = runtimeOf(rule.id);
      if (rule.trigger.resetOn.includes(type)) {
        rt.streak = 0;
        rt.lastTriggerAt = -Infinity;
        rt.paceMs = 0;
        continue;
      }
      if (rule.trigger.event !== type) continue;
      // 自适应降频要「当前节奏」：取相邻两次触发的间隔做一次指数平滑（0.5 权重，抗抖动）
      if (rule.adaptive && rt.lastTriggerAt > -Infinity && at > rt.lastTriggerAt) {
        const dt = at - rt.lastTriggerAt;
        rt.paceMs = rt.paceMs > 0 ? Math.round(rt.paceMs * 0.5 + dt * 0.5) : dt;
      }
      rt.lastTriggerAt = at;
      const ctx = eventContext(ev, rt.streak + 1);
      rt.streak = matchesFilter(rule.trigger.filter, ctx, { ignoreConsecutive: true })
        ? rt.streak + 1 : 0;
    }

    /* ③ 静音 / 教练关：全丢（调试「为什么教练不说话」的第一条线索） */
    if (st.coachOn === false) {
      note('rule:skip', { reason: 'coach-off', event: type });
      return null;
    }
    if (st.muted) {
      note('rule:skip', { reason: 'muted', event: type });
      return null;
    }

    /* ④ 候选：事件类型对上 + filter 命中 + 话量档位允许 */
    const volume = normalizeCoachVolume(st.volume);
    const candidates = [];
    for (const rule of rules.values()) {
      if (!rule.enabled) continue;
      if (rule.trigger.event !== type) continue;
      if (!rule.volumes.includes(volume)) {
        note('rule:skip', { reason: 'volume', ruleId: rule.id, event: type });
        continue;
      }
      const rt = runtimeOf(rule.id);
      const ctx = eventContext(ev, rt.streak);
      if (!matchesFilter(rule.trigger.filter, ctx)) continue;
      candidates.push({ rule, rt, ctx });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => (b.rule.priority - a.rule.priority) || a.rule.id.localeCompare(b.rule.id));

    /* ⑤ 护栏：从上往下试，谁先过谁说话（同一个 tick 只出一条） */
    for (const { rule, rt, ctx } of candidates) {
      if (rule.adaptive && !adaptiveAllows(rule, rt, ctx, volume, at)) {
        note('rule:skip', { reason: 'stride', ruleId: rule.id, event: type });
        continue;
      }
      if (st.speaking) {
        /**
         * 教练正在说话时：普通规则**一律丢弃**（不排队、不叠音）；
         * `bypassGap` 的读秒类照样说，但**计数**这条还有个更细的条件（R2 用户原话）：
         * 「教练正在说话时仍然：若剩余台词 >1.5s 就跳过这一下」—— 计时器走完之前那一下
         * 就不要了，绝不把数字排到队尾。
         */
        const left = num(st.speakLeftMs) ?? 0;
        const limit = rule.adaptive
          ? (num(rule.adaptive.skipWhileSpeakingMs) ?? ADAPTIVE_REP.skipWhileSpeakingMs)
          : null;
        if (!rule.bypassGap || (limit !== null && left > limit)) {
          note('rule:skip', {
            reason: limit !== null && left > limit ? 'speaking-long' : 'speaking',
            ruleId: rule.id,
            event: type,
          });
          continue;
        }
      }
      if (at <= lastSpeakAt) {
        note('rule:skip', { reason: 'same-tick', ruleId: rule.id, event: type });
        continue;
      }
      if (rule.cooldownMs > 0 && at - rt.lastAt < rule.cooldownMs) {
        note('rule:skip', { reason: 'cooldown', ruleId: rule.id, event: type });
        continue;
      }
      if (rule.budget.perSet > 0 && rt.setCount >= rule.budget.perSet) {
        note('rule:skip', { reason: 'budget:set', ruleId: rule.id, event: type });
        continue;
      }
      if (rule.budget.perMinute > 0 && minuteCount(rt, at) >= rule.budget.perMinute) {
        note('rule:skip', { reason: 'budget:minute', ruleId: rule.id, event: type });
        continue;
      }
      if (!rule.bypassGap && at - lastGapAt < gapMs) {
        note('rule:skip', { reason: 'gap', ruleId: rule.id, event: type });
        continue;
      }
      const text = renderAction(rule.action, ctx, ev);
      if (!text) {
        note('rule:skip', { reason: 'empty', ruleId: rule.id, event: type });
        continue;
      }
      /* ⑥ 记账：规则冷却 / 预算 / 全局间隔（读秒类不动全局间隔） */
      rt.lastAt = at;
      rt.setCount += 1;
      minuteCount(rt, at);
      rt.spokenAt.push(at);
      lastSpeakAt = at;
      spoken += 1;
      if (!rule.bypassGap) lastGapAt = at;
      const speak = { text, ruleId: rule.id, priority: rule.priority };
      const actions = actionList(rule.action, ctx, ev);
      return actions.length ? { speak, actions } : { speak };
    }
    return null;
  }

  return {
    add,
    remove,
    list,
    clear,
    clearScope,
    reset,
    handle,
    /** 现有规则条数（诊断 / 测试） */
    get size() { return rules.size; },
    /** 一共说过几句（测试用） */
    get spoken() { return spoken; },
    /** 全局间隔（测试断言 MIN_GAP_MS 就是它） */
    get gapMs() { return gapMs; },
  };
}

/**
 * 门控名 → 「该怎么做」的词条键（`status.need.*`，和画面上那句是**同一份**文案，
 * 见 engines.js 的 `GATE_HINT`；绝不在这里另抄一张表）。
 */
export function gateCueKey(gate) {
  const name = String(gate || '');
  const hint = GATE_HINT[name] || 'stand';
  return `status.need.${hint}`;
}

/**
 * 「报数」规则（计次类，缺省规则 `rep-count`）。
 *
 * 用户原话（R2）：「缺省情况下要帮客户计次……要像私人教练一样主动帮用户计数，要有陪伴感」。
 *
 *   - 每做一个就报一个（「一」「二」「三」…）；第 5 / 10 个换成整句鼓励（「五个了」「十个了，稳住」）；
 *   - `adaptive` 让它按节奏自动降频：≥1.5s 一个 → 每个都报；1~1.5s → 每 2 个；更快 → 每 3 个；
 *     **两次报数至少隔 1 秒**（每秒最多 1 次播报）；
 *   - `bypassGap: true` → 计数通道不走「全局 6 秒间隔」（每一下都要报）；
 *     但教练正在说话时，剩余台词 >1.5s 仍然跳过这一下（不积压、不叠音）；
 *   - 话量=少 → 只报每 5 个（`lowVolumeStride`）。
 *
 * @param {object} [opts]
 * @param {number} [opts.every] 固定间隔（口述「每 10 个报一次」时传 10；不传 = 自适应逐次）
 * @param {string} [opts.id]    规则 id（缺省 `rep-count`）
 * @param {string} [opts.scope] 作用域（缺省 `set`；口述规则用 `session`）
 */
export function repRule({ every = 0, id = 'rep-count', scope = 'set' } = {}) {
  const n = Math.round(Number(every) || 0);
  const fixed = Number.isFinite(n) && n > 1;
  const rule = {
    id,
    scope,
    channel: 'rep',
    label: 'rule.name.rep',
    trigger: {
      event: 'rep',
      filter: fixed ? { everyN: n } : null,
      resetOn: ['set-start', 'session-start'],
    },
    action: {
      // 第 5 / 10 个换成整句（「五个了」「十个了，稳住」），其余就是数数声
      template: (ctx) => {
        const at = Number(ctx && ctx.n) || 0;
        if (at > 0 && at % 10 === 0) return 'rule.repTen';
        if (at > 0 && at % 5 === 0) return 'rule.repFive';
        return 'rule.repCount';
      },
      args: (ev) => {
        const count = eventContext(ev).n;
        return { n: count, word: numberWord(count, getLang()) };
      },
    },
    cooldownMs: 0,
    priority: RULE_PRIORITIES.count,
    bypassGap: true,
    volumes: ['low', 'mid', 'high'],
  };
  // 固定间隔的规则不需要降频：它本来就「每 N 个才说一次」（话量=少也照用户的数）
  if (!fixed) rule.adaptive = { ...ADAPTIVE_REP };
  return rule;
}

/**
 * 「读秒」规则（计时类，缺省规则 `hold-read-5`）：每 N 秒报一次已经过了几秒（「5 秒」「10 秒」…）。
 *
 * 用户原话（R2）：「计时的运动要每 5 秒读秒一次」。
 *
 * @param {object} [opts]
 * @param {number} [opts.every] 间隔秒数（缺省 DEFAULT_READ_EVERY_SEC = 5）
 * @param {string} [opts.id]    规则 id（缺省 `hold-read-5`）
 * @param {string} [opts.scope] 作用域（缺省 `set`；口述规则用 `session`）
 * @param {boolean} [opts.holdOnly] 只认**时间型动作**（`tick` 带 hold:1 —— 保持类 + 限时计数类），
 *        缺省规则是 true；口述的「每 30 秒报时」是 false（计数类动作也报时）
 */
export function readRule({
  every = DEFAULT_READ_EVERY_SEC,
  id = 'hold-read-5',
  scope = 'set',
  holdOnly = true,
} = {}) {
  const n = Math.max(1, Math.round(Number(every) || DEFAULT_READ_EVERY_SEC));
  return {
    id,
    scope,
    channel: 'read',
    label: 'rule.name.read',
    trigger: {
      event: 'tick',
      // 缺省那条同时要求 remainingGt:5 —— 最后 5 秒交给逐秒倒数，别两句撞在同一秒
      filter: holdOnly ? { everySec: n, hold: true, remainingGt: 5 } : { everySec: n },
      resetOn: ['set-start', 'session-start'],
    },
    action: {
      template: 'rule.readSeconds',
      args: (ev) => {
        const sec = eventContext(ev).sec;
        return { n: sec, word: numberWord(sec, getLang()) };
      },
    },
    cooldownMs: 0,
    priority: RULE_PRIORITIES.read,
    bypassGap: true,
    volumes: ['low', 'mid', 'high'],
  };
}

/**
 * 内置规则（R1 的三条 + R2 的两条缺省规则 + R1 的催促；门控纠正已交给 R3 裁判）。
 *
 * | 规则 | 触发 | 说法 | 优先级 |
 * |---|---|---|---|
 * | 逐次报数 | rep（自适应每 1/2/3 个；话量=少每 5 个） | 「一」「二」…「五个了」 | 35（计数，bypassGap） |
 * | 每 5 秒读秒 | tick + everySec:5 + hold | 「5 秒」「10 秒」… | 45（读秒，bypassGap） |
 * | 最后 3 个 | rep + remainingLte:3 | 「还剩 {n} 个」 | 40 |
 * | 过半 | progress + pctGte:50（每组一次） | 「一半了，节奏别乱」 | 30（话量=多） |
 * | 读秒（最后 5 秒） | hold-tick + remainingLte:5 | 「5」「4」「3」… | 40（bypassGap） |
 * | 8 秒没动 | idle + secGte:8 | 「继续啊，我等你」 | 20 |
 *
 * ⚠️ **R3 起「门控连错 2 次」不再走规则快车道**（用户拍板：停用 R1 那条模板，防双声 ✗）：
 *    它改成由 LLM 裁判判断（`gate-fail2` 事件）—— 模型失败 / 超时才回退这条口令，
 *    回退文本仍然复用 `rule.gateFail2` + `gateCueKey`（同一份文案，不另写一句）。
 *
 * 话量三档（设置里的「少 / 中 / 多」）：
 *   少 = 只报每 5 个 + 读秒 + 最后 3 个；
 *   中 = 再加每个都报 + 最后 5 秒倒数 + 催促（默认）；
 *   多 = 再加过半。
 */
export function builtinRules({ t = defaultTranslate } = {}) {
  const translate = typeof t === 'function' ? t : defaultTranslate;
  void translate;   // 门控口令现在由 app.js 的裁判兜底渲染（同一份 gateCueKey），这里不再用
  return [
    repRule(),
    readRule(),
    {
      id: 'last-three',
      scope: 'set',
      label: 'rule.name.lastThree',
      trigger: { event: 'rep', filter: { remainingLte: 3 }, resetOn: ['set-start', 'session-start'] },
      action: { template: 'rule.lastThree', args: (ev) => ({ n: eventContext(ev).remaining }) },
      cooldownMs: 0,
      priority: RULE_PRIORITIES.countdown,
      budget: { perSet: 1, perMinute: 0 },
      volumes: ['low', 'mid', 'high'],
    },
    {
      id: 'halfway',
      scope: 'set',
      label: 'rule.name.halfway',
      trigger: { event: 'progress', filter: { pctGte: 50 }, resetOn: ['set-start', 'session-start'] },
      action: { template: 'rule.halfway', args: (ev) => ({}) },
      cooldownMs: 0,
      priority: RULE_PRIORITIES.encourage,
      budget: { perSet: 1, perMinute: 0 },
      volumes: ['high'],
    },
    {
      id: 'countdown-5',
      scope: 'set',
      label: 'rule.name.countdown',
      trigger: { event: 'hold-tick', filter: { remainingLte: 5 } },
      action: { template: 'rule.countdown', args: (ev) => ({ n: eventContext(ev).sec }) },
      cooldownMs: 0,
      // 读秒必须比「鼓励」晚一格但允许打断 —— 用户要的是「到点就报」
      priority: RULE_PRIORITIES.countdown,
      budget: { perSet: 0, perMinute: 0 },
      bypassGap: true,
      volumes: ['mid', 'high'],
    },
    /**
     * 门控连错 2 次那条**已停用**（R3：交给 LLM 裁判的 `gate-fail2` 事件，防双声 ✗）。
     * 口令文案与 `gateCueKey` 仍然保留：裁判失败时 app.js 用它兜底。
     */
    {
      id: 'idle-8',
      scope: 'set',
      label: 'rule.name.idle',
      trigger: { event: 'idle', filter: { secGte: 8 }, resetOn: ['set-start', 'session-start'] },
      action: { template: 'rule.idle8', args: () => ({}) },
      cooldownMs: 15000,
      priority: RULE_PRIORITIES.idle,
      budget: { perSet: 0, perMinute: 2 },
      volumes: ['mid', 'high'],
    },
  ];
}

/** 内置规则的 id（测试 / 文档一处定义；顺序 = builtinRules() 的顺序） */
export const BUILTIN_RULE_IDS = Object.freeze([
  'rep-count', 'hold-read-5', 'last-three', 'halfway', 'countdown-5', 'idle-8',
]);

/** 规则名（`rule.name.*` 词条键；没写 label 的规则说「其他规则」） */
export function ruleNameKey(rule) {
  const key = String(rule && rule.label ? rule.label : '');
  return key || 'rule.name.other';
}

/**
 * 规则的间隔短语（**已本地化**）：每 10 个 / 每 30 秒 / 每个都报（节奏快时自动降频）。
 * @param {object} rule
 * @param {Function} [translate] 取词条（默认 i18n 的 t）
 */
export function ruleEveryText(rule, translate = defaultTranslate) {
  const tr = typeof translate === 'function' ? translate : defaultTranslate;
  const filter = rule && rule.trigger && rule.trigger.filter ? rule.trigger.filter : {};
  if (num(filter.everyN) !== null) return tr('rule.everyReps', { n: Math.round(num(filter.everyN)) });
  if (num(filter.everySec) !== null) return tr('rule.everySeconds', { n: Math.round(num(filter.everySec)) });
  if (rule && rule.adaptive) return tr('rule.everyRep');
  return tr('rule.everyAlways');
}

/**
 * 一条规则的「人话」描述（`listRules` 口述 / 设置页将来用）：`报数间隔：每 10 个`。
 * @param {object} rule
 * @param {Function} [translate]
 */
export function describeRule(rule, translate = defaultTranslate) {
  const tr = typeof translate === 'function' ? translate : defaultTranslate;
  return tr('rule.listItem', { name: tr(ruleNameKey(rule)), every: ruleEveryText(rule, tr) });
}

export default {
  createRuleEngine, builtinRules, normalizeRule, matchesFilter, eventContext,
  normalizeCoachVolume, gateCueKey, MIN_GAP_MS, RULE_PRIORITIES, COACH_VOLUMES,
  DEFAULT_COACH_VOLUME, RULE_SCOPES, RULE_CHANNELS, DEFAULT_RULE_BY_CHANNEL,
  DEFAULT_READ_EVERY_SEC, ADAPTIVE_REP, strideForPace, adaptiveAllows, estimateSpeechMs,
  repRule, readRule, ruleNameKey, ruleEveryText, describeRule,
};
