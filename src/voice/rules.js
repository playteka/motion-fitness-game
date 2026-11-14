/**
 * 规则快车道（R1「动态快车道」的引擎，**纯函数 / 不碰 DOM**）。
 *
 * 用户原话：「除了命令快车道，还应该有**动态快车道**：用户要求每 5 秒读秒，系统就订阅读秒事件，
 * 到点直接 TTS，**不请求 LLM**。」
 *
 * 这一层 = 事件总线（`events.js`）+ 规则表：每条规则是
 *   `{ id, scope, trigger:{event, filter, resetOn}, action:{template, args}, cooldownMs,
 *      priority, budget:{perSet, perMinute}, bypassGap, volumes, enabled }`
 * 命中就返回一句要念的话，**一个网络请求都不发**（也就一分钱不花）。
 *
 * 本模块只做判断，不念话：真正开口的是 app.js 里现有的 `voice.onCoachText()`（弹幕 + TTS）。
 *
 * 护栏（缺一条都会变成「教练很吵」）：
 *   - 同一条规则 `cooldownMs` 内不再开口；
 *   - **全局最小开口间隔 `MIN_GAP_MS = 6000`**（读秒类规则带 `bypassGap:true`，单独放行）；
 *   - 每条规则自己的 `budget.perSet` / `budget.perMinute`；
 *   - 同一个 tick（同一毫秒 / 同一帧）**只让最高优先级的那一条说话**；
 *   - 教练正在说话（`state.speaking`）→ 除 `bypassGap` 的读秒外**一律丢弃**（不排队、不叠音）；
 *   - 静音 / 教练关 → **全部丢弃**；
 *   - `scope` 到期自动清：`set-complete` 清 `set` 规则、`session-end` 清 `session` 规则。
 */

import { t as defaultTranslate, hasKey } from '../i18n.js';
import { GATE_HINT } from '../engines.js';
import { EVENT_TYPES } from './events.js';

/** 全局最小开口间隔（毫秒）：两条规则话之间至少隔这么久，读秒类除外 */
export const MIN_GAP_MS = 6000;

/** 优先级（数字大的先说话；用户拍板的档位：破纪录 > 纠正 > 读秒 > 鼓励） */
export const RULE_PRIORITIES = Object.freeze({
  /** 破纪录（R3 的 `add_rule` 之后会用到；先占住最高档，别让纠正抢在报喜前面） */
  record: 100,
  /** 纠正（门控连错 / 姿势没到位） */
  correct: 60,
  /** 读秒（最后 5 秒 / 最后 3 个） */
  countdown: 40,
  /** 鼓励（每 5 个 / 过半） */
  encourage: 30,
  /** 催促（8 秒没动） */
  idle: 20,
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
  // 「还剩多少」：计次类给 remaining / 由 n、target 推；读秒类（hold-tick）给的是 remainingSec
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
    raw: d,
  };
}

/**
 * filter 是否命中（纯函数）。
 *
 * 支持：`everyN`（每 N 次）· `remainingLte`（还剩 ≤N）· `pctGte`（进度 ≥N%）·
 *       `consecutive`（连续 N 次）· `secLte` / `secGte`（秒数）。
 * 不给 filter（或空对象）= 只要事件类型对上就命中（冷却 / 预算 / 间隔仍生效）。
 */
export function matchesFilter(filter, ctx, { ignoreConsecutive = false } = {}) {
  const f = filter && typeof filter === 'object' ? filter : null;
  if (!f) return true;
  const everyN = num(f.everyN);
  if (everyN !== null) {
    if (!(ctx.n > 0) || ctx.n % everyN !== 0) return false;
  }
  const remainingLte = num(f.remainingLte);
  if (remainingLte !== null) {
    if (ctx.remaining === null || ctx.remaining > remainingLte) return false;
  }
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
  return {
    id,
    scope: RULE_SCOPES.includes(r.scope) ? r.scope : 'session',
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
    bypassGap: r.bypassGap === true,
    volumes: ruleVolumes(r),
    enabled: r.enabled !== false,
  };
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

  function runtimeOf(id) {
    if (!runtime.has(id)) {
      runtime.set(id, { lastAt: -Infinity, setCount: 0, spokenAt: [], streak: 0 });
    }
    return runtime.get(id);
  }

  /** 加一条规则（同 id 覆盖） */
  function add(rule) {
    const r = normalizeRule(rule);
    if (!r) return null;
    rules.set(r.id, r);
    runtime.set(r.id, { lastAt: -Infinity, setCount: 0, spokenAt: [], streak: 0 });
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
    for (const rt of runtime.values()) {
      rt.lastAt = -Infinity;
      rt.setCount = 0;
      rt.spokenAt = [];
      rt.streak = 0;
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

  /** 把 action 渲染成一句话（模板走 i18n；args 可以是函数，按事件现算） */
  function renderAction(action, ctx, event) {
    const act = action || {};
    const key = String(act.template || '');
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
    }

    /* ② 连续次数：先按「这一次事件」更新每条规则的 streak（含 resetOn） */
    for (const rule of rules.values()) {
      const rt = runtimeOf(rule.id);
      if (rule.trigger.resetOn.includes(type)) {
        rt.streak = 0;
        continue;
      }
      if (rule.trigger.event !== type) continue;
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
      if (st.speaking && !rule.bypassGap) {
        note('rule:skip', { reason: 'speaking', ruleId: rule.id, event: type });
        continue;
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
 * 内置六条规则（R1）。
 *
 * | 规则 | 触发 | 说法 | 优先级 |
 * |---|---|---|---|
 * | 每 5 个报数 | rep + everyN:5 | 「{n} 个，稳」 | 30（话量=多） |
 * | 最后 3 个 | rep + remainingLte:3 | 「还剩 {n} 个」 | 40 |
 * | 过半 | progress + pctGte:50（每组一次） | 「一半了，节奏别乱」 | 30（话量=多） |
 * | 读秒（最后 5 秒） | hold-tick + remainingLte:5 | 「{n}」 | 40（bypassGap） |
 * | 门控连错 2 次 | gate-fail + consecutive:2 | 按 gate 名的具体口令 | 60 |
 * | 8 秒没动 | idle + secGte:8 | 「继续啊，我等你」 | 20 |
 *
 * 话量三档（设置里的「少 / 中 / 多」）：
 *   少 = 纠正 + 最后 3 个；
 *   中 = 再加读秒 + 催促（默认）；
 *   多 = 再加过半 + 每 5 个。
 */
export function builtinRules({ t = defaultTranslate } = {}) {
  const translate = typeof t === 'function' ? t : defaultTranslate;
  return [
    {
      id: 'rep-every-5',
      scope: 'set',
      trigger: { event: 'rep', filter: { everyN: 5 }, resetOn: ['set-start', 'session-start'] },
      action: { template: 'rule.repEvery5', args: (ev) => ({ n: eventContext(ev).n }) },
      cooldownMs: 3000,
      priority: RULE_PRIORITIES.encourage,
      budget: { perSet: 0, perMinute: 4 },
      volumes: ['high'],
    },
    {
      id: 'last-three',
      scope: 'set',
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
      trigger: { event: 'hold-tick', filter: { remainingLte: 5 } },
      action: { template: 'rule.countdown', args: (ev) => ({ n: eventContext(ev).sec }) },
      cooldownMs: 0,
      // 读秒必须比「鼓励」晚一格但允许打断 —— 用户要的是「到点就报」
      priority: RULE_PRIORITIES.countdown,
      budget: { perSet: 0, perMinute: 0 },
      bypassGap: true,
      volumes: ['mid', 'high'],
    },
    {
      id: 'gate-fail-2',
      scope: 'set',
      trigger: {
        event: 'gate-fail',
        filter: { consecutive: 2 },
        resetOn: ['gate-ok', 'set-start', 'session-start'],
      },
      action: {
        template: 'rule.gateFail2',
        args: (ev) => ({ cue: translate(gateCueKey(eventContext(ev).gate), {}) }),
      },
      cooldownMs: 8000,
      priority: RULE_PRIORITIES.correct,
      budget: { perSet: 0, perMinute: 3 },
      volumes: ['low', 'mid', 'high'],
    },
    {
      id: 'idle-8',
      scope: 'set',
      trigger: { event: 'idle', filter: { secGte: 8 }, resetOn: ['set-start', 'session-start'] },
      action: { template: 'rule.idle8', args: () => ({}) },
      cooldownMs: 15000,
      priority: RULE_PRIORITIES.idle,
      budget: { perSet: 0, perMinute: 2 },
      volumes: ['mid', 'high'],
    },
  ];
}

/** 内置规则的 id（测试 / 文档一处定义） */
export const BUILTIN_RULE_IDS = Object.freeze([
  'rep-every-5', 'last-three', 'halfway', 'countdown-5', 'gate-fail-2', 'idle-8',
]);

export default {
  createRuleEngine, builtinRules, normalizeRule, matchesFilter, eventContext,
  normalizeCoachVolume, gateCueKey, MIN_GAP_MS, RULE_PRIORITIES, COACH_VOLUMES,
  DEFAULT_COACH_VOLUME, RULE_SCOPES,
};
