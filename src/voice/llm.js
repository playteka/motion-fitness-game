/**
 * 前端「自由对话」客户端（P3.3）。
 *
 * 只做一件事：把一句话 + 当前界面状态发给**同源的** `POST /llm`，拿回
 * `{ reply, actions }`。密钥永远在服务端（`coach.env`），这里既没有也不该有。
 *
 * 约定（和 `src/voice/session.js` 的接缝）：
 *   - 命令快车道**先**跑（`parse.js`），没命中才轮到这一层（见 app.js 的 `voiceLlm`）；
 *   - `actions` 的每一项都是命令表里的 `{ intent, args }`，由会话层用**现有 handler** 执行；
 *   - 失败 / 超时 / 503 / 429 一律抛 `{ code }`，由 app.js 回退到原来的罐头回复，
 *     并记一条 `llm:fallback` 诊断 —— **绝不把错误弹到界面上**；
 *   - 对话记忆只存在内存里（最近 10 轮），刷新页面即清，**不落盘**。
 *
 * 纯逻辑 + 注入 fetch，所以 Node 里能直接测（见 tests/test-voice.mjs）。
 */

import { LOCALES } from '../i18n.js';

/** 服务端路由（和 server/llm-provider.mjs 的 LLM_PATH / LLM_HEALTH_PATH 一致） */
export const LLM_PATH = '/llm';
export const LLM_HEALTH_PATH = '/llm/health';

/**
 * 客户端等多久（服务端自己 8s 超时，这里留 1s 余量：
 * 正常一定是服务端先返回 503，客户端这个只是兜底，避免请求永远挂着）。
 */
export const LLM_CLIENT_TIMEOUT_MS = 9000;

/** 只带最近 10 轮（一轮 = 用户一句 + 教练一句）；刷新即清，不落盘（用户拍板：6 → 10） */
export const LLM_HISTORY_TURNS = 10;

/** 单句上限（和服务端 LLM_MAX_TEXT 同值） */
export const LLM_CLIENT_MAX_TEXT = 500;

/* ------------------------------------------------------------------ *
 * Agent context（P3.3 补充要求）
 *
 * 用户原话：「接入 LLM，本质上这个软件就成了一个 Agent。每次提交给 LLM 的应该包括
 * 客户的话语 + 客户当下的运动状态（最近的动作、最近的状态……）。」
 *
 * 所以 context **不是**「动作名 + 剩余次数」两三个字段，而是一份结构化快照：
 *   now / session / performance / history / signals / utterance
 * —— **所有数字都由客户端算好**（分数 / 命中率 / 趋势 / 每帧得分），模型只负责解释与决策。
 * 纯函数（`buildAgentContext(snapshot)`）：Node 里直接测，不碰 DOM，也不读全局。
 * ------------------------------------------------------------------ */

/** 训练摘要最多给几条（用户口径：最近 20 次，最新在前；存在浏览器 localStorage） */
export const AGENT_SUMMARY_MAX = 20;
/** 整份 context 的 JSON 上限（字符数；≈ 800 tokens 的预算，超了就按下面的顺序瘦身） */
export const AGENT_CONTEXT_MAX_CHARS = 6000;
/** `history.lastExercises` 最多给几条（用户要求 5 条） */
export const AGENT_HISTORY_MAX = 5;
/** `performance.keyframes` 最多给几帧（用户要求 3~5 帧） */
export const AGENT_KEYFRAMES_MAX = 5;
/** `signals.lastNudges` / `recentCommands` 最多各留几条 */
export const AGENT_SIGNALS_MAX = 3;

/* ------------------------------------------------------------------ *
 * 三层记忆的「短时 / 中时」参数（用户拍板，改之前先看清楚）
 *
 *   短时（内存，不落盘）：最近 10 轮对话 / 教练最近 5 句（防复读）/ 最近 60 秒事件（≤60 条）
 *   中时（跨会话，客户端算）：最近 20 次训练摘要 / 本周 vs 上周趋势 / 上次练到哪了
 *   长时（服务端 MD）：prefs / facts（见 server/memory-store.mjs）
 * ------------------------------------------------------------------ */

/** 发给模型的「教练最近说过什么」最多几句（防复读；用户要求 5 句） */
export const AGENT_COACH_LINES_MAX = 5;
/** 最近事件最多几条（用户拍板：60 条，环形缓冲） */
export const AGENT_EVENTS_MAX = 60;
/** 最近事件只看多久以内（用户拍板：60 秒） */
export const AGENT_EVENTS_WINDOW_MS = 60 * 1000;
/** 单条事件序列化上限（字符；超过就丢 data 字段，保持短） */
export const AGENT_EVENT_MAX_CHARS = 60;
/** 事件类型白名单（和 src/voice/session.js 的 EVENT_KINDS 同一份口径） */
export const AGENT_EVENT_KINDS = Object.freeze(['rep', 'gate-fail', 'keyframe-hit', 'keyframe-miss']);
/** 周趋势的判定阈值：本周平均分比上周高 / 低这么多才算 improved / declined，否则 flat */
export const TREND_WEEK_SCORE_DELTA = 3;
/**
 * 中时记忆里能进 context 的字段（**和 server/memory-store.mjs 的白名单一一对应**；
 * tests/test-voice.mjs 会直接比对两份数组，漂了就会红）。
 */
export const AGENT_MEMORY_PREF_FIELDS = Object.freeze([
  'tone', 'difficulty', 'sessionMinutes', 'restSec', 'voiceSource', 'voiceGender', 'rate',
]);
export const AGENT_MEMORY_FACT_FIELDS = Object.freeze(['goal', 'injuries', 'weeklyGoal']);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** 本地时间的「现在大概什么时候」（给模型一个自然的时间感；只到小时级，不含日期） */
export function timeOfDayHint(date = new Date(), locale = 'zh') {
  const hour = date.getHours();
  const key = hour < 5 ? 'earlyMorning'
    : (hour < 9 ? 'morning'
      : (hour < 12 ? 'lateMorning'
        : (hour < 14 ? 'noon'
          : (hour < 18 ? 'afternoon'
            : (hour < 23 ? 'evening' : 'lateNight')))));
  const lang = locale === 'en' ? 'en' : 'zh';
  // 文案在 src/locales/*.js 里（一处定义）；缺失就退回键名，绝不在这里写死中文
  return LOCALES[lang]?.coach?.timeOfDay?.[key] || key;
}

/** 本地当天 00:00 的时间戳（「今天练了几组」按本地日算，不按 UTC） */
function startOfLocalDay(ms) {
  const d = new Date(Number(ms) || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地「本周一 00:00」的时间戳（周一为一周起点；用日历加减，跨夏令时也不飘） */
export function startOfLocalWeek(ms) {
  const d = new Date(Number(ms) || Date.now());
  d.setHours(0, 0, 0, 0);
  const offset = (d.getDay() + 6) % 7;   // 周一 = 0 … 周日 = 6
  d.setDate(d.getDate() - offset);
  return d.getTime();
}

/** 一组历史 → {sets,reps,secs,avgScore}（纯函数；趋势和周汇总共用） */
function weekTotals(entries) {
  let sets = 0;
  let reps = 0;
  let secs = 0;
  let score = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue;
    sets += 1;
    if (e.kind === 'hold') secs += Number(e.value) || 0;
    else {
      reps += Number(e.value) || 0;
      secs += Number(e.seconds) || 0;
    }
    score += Number(e.score) || 0;
  }
  return { sets, reps, secs, avgScore: sets ? Math.round(score / sets) : 0 };
}

/**
 * 本周 vs 上周（**客户端算好**，模型只引用）。
 *
 * 判定规则（写死在这里，测试用假日期钉住）：
 *   - 两周都没练 → flat；只有本周练了 → improved；只有上周练了 → declined；
 *   - 都有 → 本周平均分 − 上周平均分 ≥ +3 → improved，≤ −3 → declined，其余 flat。
 *
 * @param {Array<{at:number,value:number,score:number,kind?:string,seconds?:number}>} entries
 * @param {number} [nowMs]
 * @returns {{thisWeek:{sets:number,reps:number,secs:number,avgScore:number},
 *            lastWeek:{sets:number,reps:number,secs:number,avgScore:number},
 *            delta:{sets:number,reps:number,secs:number,avgScore:number},
 *            verdict:'improved'|'declined'|'flat'}}
 */
export function weekTrend(entries, nowMs = Date.now()) {
  const now = Number(nowMs) || Date.now();
  const thisStart = startOfLocalWeek(now);
  const lastStart = startOfLocalWeek(thisStart - 24 * 60 * 60 * 1000);
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === 'object');
  const thisEntries = list.filter((e) => (Number(e.at) || 0) >= thisStart);
  const lastEntries = list.filter((e) => {
    const at = Number(e.at) || 0;
    return at >= lastStart && at < thisStart;
  });
  const thisWeek = weekTotals(thisEntries);
  const lastWeek = weekTotals(lastEntries);
  const delta = {
    sets: thisWeek.sets - lastWeek.sets,
    reps: thisWeek.reps - lastWeek.reps,
    secs: thisWeek.secs - lastWeek.secs,
    avgScore: thisWeek.avgScore - lastWeek.avgScore,
  };
  let verdict = 'flat';
  if (!thisWeek.sets && !lastWeek.sets) verdict = 'flat';
  else if (!thisWeek.sets) verdict = 'declined';
  else if (!lastWeek.sets) verdict = 'improved';
  else if (delta.avgScore >= TREND_WEEK_SCORE_DELTA) verdict = 'improved';
  else if (delta.avgScore <= -TREND_WEEK_SCORE_DELTA) verdict = 'declined';
  return { thisWeek, lastWeek, delta, verdict };
}

/** `MM-DD HH:mm`（local；给模型看的紧凑时间，不塞完整 ISO） */
export function shortStamp(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)) {
    return value.slice(5, 16);
  }
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 长期记忆 → 只留白名单里的 prefs / facts（值也做基础归一化，防止手改的脏值进模型） */
export function memoryForContext(memory) {
  const mem = memory && typeof memory === 'object' ? memory : {};
  const srcPrefs = mem.prefs && typeof mem.prefs === 'object' ? mem.prefs : {};
  const srcFacts = mem.facts && typeof mem.facts === 'object' ? mem.facts : {};
  const prefs = {};
  for (const field of AGENT_MEMORY_PREF_FIELDS) {
    const v = srcPrefs[field];
    if (typeof v === 'string' || typeof v === 'number') prefs[field] = v;
  }
  const facts = {};
  for (const field of AGENT_MEMORY_FACT_FIELDS) {
    const v = srcFacts[field];
    if (Array.isArray(v)) {
      const list = v.filter((x) => typeof x === 'string' && x.trim()).slice(0, 5).map((x) => x.slice(0, 20));
      if (list.length) facts[field] = list;
    } else if (typeof v === 'string' || typeof v === 'number') facts[field] = v;
  }
  return { prefs, facts };
}

/** 最近事件：只留白名单类型 / 60 秒以内 / 最多 60 条；data 只留标量（**绝不含原始关键点**） */
export function normalizeRecentEvents(events, { max = AGENT_EVENTS_MAX, windowMs = AGENT_EVENTS_WINDOW_MS } = {}) {
  const list = Array.isArray(events) ? events : [];
  const out = [];
  for (const ev of list) {
    if (!ev || typeof ev !== 'object') continue;
    const type = String(ev.type || '');
    if (!AGENT_EVENT_KINDS.includes(type)) continue;
    const t = Number(ev.t);
    if (!Number.isFinite(t) || t < 0 || t * 1000 > windowMs) continue;
    const data = {};
    const raw = ev.data && typeof ev.data === 'object' && !Array.isArray(ev.data) ? ev.data : {};
    let n = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (n >= 4) break;
      if (typeof v === 'string') { data[k] = v.slice(0, 20); n += 1; }
      else if (typeof v === 'number' || typeof v === 'boolean') { data[k] = v; n += 1; }
      // 数组 / 对象（关键点就在这里面）一律丢掉
    }
    const item = { t: Math.round(t * 10) / 10, type, data };
    // 单条保持短：超了从后往前丢 data 字段（空 data 一定在 60 字符内）
    while (Object.keys(item.data).length
      && JSON.stringify(item).length > AGENT_EVENT_MAX_CHARS) {
      delete item.data[Object.keys(item.data).pop()];
    }
    out.push(item);
  }
  // **按时间正序**（最旧的在前）：t 是「多少秒前」，所以 t 大的在前
  out.sort((a, b) => b.t - a.t);
  return out.slice(-max);
}

/** 最近 20 次训练摘要（**浏览器 localStorage** 的 mfg.history.v1，最新在前）→ context 用的紧凑行 */
export function trainingSummaryForContext(rows, max = AGENT_SUMMARY_MAX) {
  const list = Array.isArray(rows) ? rows : [];
  return list.slice(0, Math.max(0, Number(max) || AGENT_SUMMARY_MAX)).map((row) => {
    const r = row && typeof row === 'object' ? row : {};
    return {
      date: shortStamp(r.at || r.date || ''),
      name: String(r.name || r.exerciseName || r.exerciseId || '').slice(0, 20),
      target: Math.max(0, Math.round(Number(r.target) || 0)),
      reps: Math.max(0, Math.round(Number(r.reps ?? r.value) || 0)),
      score: Math.max(0, Math.round(Number(r.score) || 0)),
    };
  }).filter((row) => row.name);
}

/** 上次练到哪了 → context 里的紧凑形状；没有就 null */
export function lastSessionForContext(value) {
  const s = value && typeof value === 'object' ? value : null;
  if (!s) return null;
  const exerciseId = String(s.exerciseId || '').trim();
  const name = String(s.name || exerciseId).trim();
  if (!exerciseId && !name) return null;
  return {
    exerciseId: exerciseId.slice(0, 32),
    name: name.slice(0, 30),
    target: Math.max(0, Math.round(Number(s.target) || 0)),
    reps: Math.max(0, Math.round(Number(s.reps ?? s.value) || 0)),
    score: Math.max(0, Math.round(Number(s.score) || 0)),
    set: Math.max(1, Math.round(Number(s.setIndex ?? s.set) || 1)),
    at: shortStamp(s.at || s.stamp || s.date || ''),
    finished: s.finished === true,
  };
}

/**
 * 关键帧挑选：最多 5 帧。
 * 优先「第一个没达标的帧」（那是用户下一步该改的地方），其次有得分的帧，最后按顺序补齐。
 */
function pickKeyframes(criteria, max = AGENT_KEYFRAMES_MAX) {
  const list = Array.isArray(criteria) ? criteria : [];
  if (list.length <= max) return list.map((c) => ({
    name: String((c && c.name) || ''),
    hit: !!(c && c.hit),
    pts: Number((c && c.pts) || 0),
    max: Number((c && c.max) || 0),
  }));
  const picked = new Set();
  const firstMissed = list.findIndex((c) => !(c && c.hit));
  if (firstMissed >= 0) picked.add(firstMissed);
  for (let i = list.length - 1; i >= 0 && picked.size < max; i -= 1) {
    if (!picked.has(i) && Number(list[i] && list[i].pts) > 0) picked.add(i);
  }
  for (let i = 0; i < list.length && picked.size < max; i += 1) picked.add(i);
  return [...picked].sort((a, b) => a - b).map((i) => ({
    name: String((list[i] && list[i].name) || ''),
    hit: !!(list[i] && list[i].hit),
    pts: Number((list[i] && list[i].pts) || 0),
    max: Number((list[i] && list[i].max) || 0),
  }));
}

/**
 * 趋势：和**上一组**比分数。只有 0/1 组 → 'first'。
 * 规则刻意简单（用户要求「简单规则算」）：高于上一组 improved、低于 declined、相同 flat。
 */
export function scoreTrend(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length < 2) return 'first';
  const last = Number(list[0] && list[0].score) || 0;
  const prev = Number(list[1] && list[1].score) || 0;
  if (last > prev) return 'improved';
  if (last < prev) return 'declined';
  return 'flat';
}

/**
 * `getStateSnapshot()` 的扩展快照 → 给 LLM 的结构化 context（纯函数）。
 *
 * 入参字段（都来自 app.js 的 getStateSnapshot + utterance + now）：
 *   utterance / locale / view / fullscreen / coachOn / dialogue / ttsSource
 *   exerciseId / exerciseName / kind / session / target / reps / holdMs / elapsedMs / score
 *   criteria[{name,hit,pts,max}] / gateOk / gateName / tooFastCount
 *   history[{exerciseId,name,kind,at,value,target,score,seconds}] / bestScore
 *   nudges[] / recentCommands[]
 *
 * 出参就是用户给的那份结构（字段名稳定，测试钉住）。
 */
export function buildAgentContext(snapshot = {}) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const locale = s.locale === 'en' ? 'en' : 'zh';
  const nowMs = Number(s.now) || Date.now();
  const kind = s.kind === 'hold' ? 'hold' : 'reps';
  const target = Number(s.target) || 0;
  const reps = Number(s.reps) || 0;
  const score = Number(s.score) || 0;
  const elapsedSec = Math.max(0, Math.round((Number(s.elapsedMs) || 0) / 1000));

  /* ---- keyframes / 命中率 / 质量分（全部这里算好，不让模型算） ---- */
  const keyframes = pickKeyframes(s.criteria);
  const hits = keyframes.filter((k) => k.hit).length;
  const keyframeHitRate = keyframes.length ? round2(hits / keyframes.length) : 0;
  const earnedPts = keyframes.reduce((sum, k) => sum + k.pts, 0);
  const maxPts = keyframes.reduce((sum, k) => sum + k.max, 0);
  const quality = maxPts > 0 ? round2(Math.min(1, earnedPts / maxPts)) : 0;

  /* ---- 节奏 / 剩余时间 ---- */
  const tempoPerMin = elapsedSec >= 5 ? Math.round((reps * 60) / elapsedSec) : 0;
  let remainingSec = null;
  if (kind === 'hold' && target > 0) {
    remainingSec = Math.max(0, target - Math.floor((Number(s.holdMs) || 0) / 1000));
  } else if (s.phase === 'countdown' || s.timed) {
    remainingSec = Math.max(0, target - elapsedSec);
  }

  /* ---- 历史：最近 5 条 + 今日汇总 + 趋势 + 最好成绩 ---- */
  const entries = (Array.isArray(s.history) ? s.history : [])
    .filter((e) => e && typeof e === 'object')
    .slice(0, 30);
  const lastExercises = entries.slice(0, AGENT_HISTORY_MAX).map((e) => ({
    id: String(e.exerciseId || e.id || ''),
    name: String(e.name || e.exerciseId || e.id || ''),
    agoSec: Math.max(0, Math.round((nowMs - (Number(e.at) || nowMs)) / 1000)),
    reps: Number(e.value) || 0,
    target: Number(e.target) || 0,
    score: Number(e.score) || 0,
  }));
  const dayStart = startOfLocalDay(nowMs);
  const todays = entries.filter((e) => (Number(e.at) || 0) >= dayStart);
  let todayReps = 0;
  let todaySecs = 0;
  let todayScore = 0;
  for (const e of todays) {
    const isHold = e.kind === 'hold';
    todayReps += isHold ? 0 : (Number(e.value) || 0);
    todaySecs += isHold ? (Number(e.value) || 0) : (Number(e.seconds) || 0);
    todayScore += Number(e.score) || 0;
  }
  const today = {
    sets: todays.length,
    reps: todayReps,
    secs: todaySecs,
    avgScore: todays.length ? Math.round(todayScore / todays.length) : 0,
  };
  const history = {
    lastExercises,
    today,
    bestScore: Number(s.bestScore) || 0,
    trend: scoreTrend(entries),
  };

  const context = {
    now: {
      tsHint: timeOfDayHint(new Date(nowMs), locale),
      locale,
      view: s.view === 'home' ? 'home' : (s.view === 'menu' ? 'menu' : 'workout'),
      fullscreen: !!s.fullscreen,
      coachOn: !!s.coachOn,
      dialogueMode: s.dialogue !== false,
      tts: s.ttsSource === 'system' ? 'system' : 'volc',
    },
    session: {
      exerciseId: String(s.exerciseId || ''),
      name: String(s.exerciseName || s.exerciseId || ''),
      kind,
      phase: String(s.session || s.phase || 'idle'),
      target,
      reps,
      remainingSec,
      elapsedSec,
    },
    performance: {
      score,
      quality,
      tempoPerMin,
      tooFastCount: Math.max(0, Number(s.tooFastCount) || 0),
      keyframes: keyframes.map((k) => ({ name: k.name, hit: k.hit, pts: k.pts })),
      gateOk: s.gateOk !== false,
      lastGateFail: s.gateOk === false ? String(s.gateName || '') : '',
    },
    history,
    signals: {
      keyframeHitRate,
      lastNudges: (Array.isArray(s.nudges) ? s.nudges : []).filter(Boolean).slice(-AGENT_SIGNALS_MAX).map(String),
      recentCommands: (Array.isArray(s.recentCommands) ? s.recentCommands : []).filter(Boolean)
        .slice(-AGENT_SIGNALS_MAX).map(String),
    },
    /**
     * ---- 三层记忆 ----
     * 短时：recentEvents（最近 60 秒，≤60 条）+ lastCoachLines（最近 5 句，防复读）
     * 中时：trendWeek（本周 vs 上周）+ lastSession（上次练到哪了）
     * 长时：memory（服务端 MD 里的 prefs + facts；facts 是用户主动说的）
     */
    recentEvents: normalizeRecentEvents(s.recentEvents),
    lastCoachLines: (Array.isArray(s.lastCoachLines) ? s.lastCoachLines : [])
      .filter((x) => typeof x === 'string' && x.trim())
      .map((x) => x.trim().slice(0, 80))
      .slice(-AGENT_COACH_LINES_MAX),
    memory: memoryForContext(s.memory),
    trendWeek: weekTrend(entries, nowMs),
    lastSession: lastSessionForContext(s.lastSession),
    /** 中时记忆的「最近 20 次」摘要（来自浏览器 localStorage；最新在前） */
    trainingSummary: trainingSummaryForContext(s.trainingSummary),
    utterance: String(s.utterance || ''),
  };
  return trimAgentContext(context);
}

/**
 * 瘦身：JSON 超过 `AGENT_CONTEXT_MAX_CHARS` 时按「最不重要的先丢」的顺序缩，
 * 保证**任何情况下** `JSON.stringify(context).length <= 上限`（测试钉住）。
 */
export function trimAgentContext(context, { maxChars = AGENT_CONTEXT_MAX_CHARS } = {}) {
  const ctx = context && typeof context === 'object' ? context : {};
  const limit = Math.max(120, Number(maxChars) || AGENT_CONTEXT_MAX_CHARS);
  const size = () => JSON.stringify(ctx).length;
  if (size() <= limit) return ctx;
  const history = ctx.history || null;
  const perf = ctx.performance || null;
  const signals = ctx.signals || null;
  /**
   * 瘦身顺序（从「最不影响回答」到「最后才丢」，用户拍板：**先丢 recentEvents**）：
   *   最近事件 → 教练最近 5 句 → 上次练到哪 → 历史条数 → 关键帧个数 → 提示/命令条数 →
   *   utterance → 整块历史 → 整块 signals → 关键帧清空 → 周趋势 / 记忆 / 事件清空
   * 每一步之后都重新量一次，够小就停 —— 6000 字符的预算下基本第 1~2 步就够了。
   */
  const steps = [
    // 先丢最旧的一半事件（按时间正序，新的在数组末尾 —— 先丢开头）
    () => {
      if (Array.isArray(ctx.recentEvents) && ctx.recentEvents.length > 1) {
        ctx.recentEvents = ctx.recentEvents.slice(Math.ceil(ctx.recentEvents.length / 2));
      }
    },
    () => { ctx.recentEvents = []; },
    () => { if (Array.isArray(ctx.lastCoachLines) && ctx.lastCoachLines.length > 2) ctx.lastCoachLines = ctx.lastCoachLines.slice(-2); },
    () => { ctx.lastSession = null; },
    () => { if (Array.isArray(ctx.trainingSummary) && ctx.trainingSummary.length > 8) ctx.trainingSummary = ctx.trainingSummary.slice(0, 8); },
    () => { if (history && Array.isArray(history.lastExercises) && history.lastExercises.length > 3) history.lastExercises = history.lastExercises.slice(0, 3); },
    () => { if (perf && Array.isArray(perf.keyframes) && perf.keyframes.length > 3) perf.keyframes = perf.keyframes.slice(0, 3); },
    () => { if (signals) { signals.lastNudges = (signals.lastNudges || []).slice(-1); signals.recentCommands = (signals.recentCommands || []).slice(-1); } },
    () => { ctx.utterance = String(ctx.utterance || '').slice(0, 120); },
    () => { if (history) history.lastExercises = []; },
    () => { if (perf && Array.isArray(perf.keyframes) && perf.keyframes.length > 1) perf.keyframes = perf.keyframes.slice(0, 1); },
    () => { if (history) history.today = { sets: 0, reps: 0, secs: 0, avgScore: 0 }; },
    () => { ctx.utterance = ''; },
    () => { ctx.signals = { keyframeHitRate: (signals && signals.keyframeHitRate) || 0 }; },
    () => { if (perf) perf.keyframes = []; },
    () => { if (history) { history.lastExercises = []; history.today = { sets: 0, reps: 0, secs: 0, avgScore: 0 }; } },
    () => { ctx.lastCoachLines = []; },
    () => { ctx.trainingSummary = []; },
    () => { ctx.memory = { prefs: {}, facts: {} }; },
    () => {
      ctx.trendWeek = {
        thisWeek: { sets: 0, reps: 0, secs: 0, avgScore: 0 },
        lastWeek: { sets: 0, reps: 0, secs: 0, avgScore: 0 },
        delta: { sets: 0, reps: 0, secs: 0, avgScore: 0 },
        verdict: 'flat',
      };
    },
    () => { if (history) { history.lastExercises = []; history.today = { sets: 0, reps: 0, secs: 0, avgScore: 0 }; } },
  ];
  for (const step of steps) {
    if (size() <= limit) break;
    try { step(); } catch { /* 某一步失败不该让整份 context 崩 */ }
  }
  return ctx;
}

/** 稳定错误码 → 一句给人看的原因（只用于诊断 / 测试，界面上不显示） */
export const LLM_CLIENT_ERRORS = Object.freeze({
  'llm-timeout': 'timeout',
  'llm-not-configured': 'not-configured',
  'llm-rate-limit': 'rate-limit',
  'llm-network': 'network',
  'llm-bad-json': 'bad-json',
  'llm-empty': 'empty',
});

export function llmClientError(code, detail = '') {
  const err = new Error(detail || code);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

/** 把服务端返回的 actions 归一化（只留命令表里可能有的形状：{intent:string, args:object}） */
export function normalizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  const out = [];
  for (const item of actions) {
    if (!item || typeof item !== 'object') continue;
    const intent = String(item.intent || '');
    if (!intent) continue;
    const args = item.args && typeof item.args === 'object' && !Array.isArray(item.args)
      ? { ...item.args }
      : {};
    out.push({ intent, args });
  }
  return out;
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] 注入的 fetch（默认 globalThis.fetch；测试传假的）
 * @param {object} [opts.diag]        语音诊断收集器（只记计数与错误码，不记文本）
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.historyTurns]
 * @param {string} [opts.endpoint]    默认 '/llm'
 * @param {string} [opts.healthEndpoint]
 * @param {Function} [opts.now]       注入时钟（测试断言耗时用）
 * @param {string|Function} [opts.userId] 长期记忆的 userId（默认 'default'；函数形式可动态取）
 */
export function createLlmClient({
  fetchImpl = null,
  diag = null,
  timeoutMs = LLM_CLIENT_TIMEOUT_MS,
  historyTurns = LLM_HISTORY_TURNS,
  endpoint = LLM_PATH,
  healthEndpoint = LLM_HEALTH_PATH,
  now = () => Date.now(),
  userId = 'default',
} = {}) {
  let call = fetchImpl;
  let pathUrl = endpoint;
  let healthUrl = healthEndpoint;
  const turns = Math.max(0, Math.floor(Number(historyTurns) || 0));
  const waitMs = Math.max(1, Number(timeoutMs) || LLM_CLIENT_TIMEOUT_MS);
  const history = [];
  /** 最近一次成功回复的元信息（测试 / 诊断面板看；不含文本） */
  let last = null;

  const record = (event, fields) => {
    try { diag?.record?.(event, fields); } catch { /* 诊断坏掉不影响对话 */ }
  };

  function resolveFetch() {
    if (typeof call === 'function') return call;
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    return null;
  }

  function remember(user, assistant) {
    const u = String(user == null ? '' : user).trim();
    const a = String(assistant == null ? '' : assistant).trim();
    if (!u || !a) return;
    history.push({ role: 'user', content: u.slice(0, LLM_CLIENT_MAX_TEXT) });
    history.push({ role: 'assistant', content: a.slice(0, LLM_CLIENT_MAX_TEXT) });
    const max = turns * 2;
    while (history.length > max && max > 0) history.shift();
    if (max === 0) history.length = 0;
  }

  /** 发一次对话请求；失败一律抛 { code } */
  async function respond(text, { locale = 'zh', context = null, history: extra = null } = {}) {
    const body = String(text == null ? '' : text).trim();
    if (!body) throw llmClientError('llm-empty');
    const f = resolveFetch();
    if (!f) throw llmClientError('llm-network', 'fetch unavailable');
    const controller = new AbortController();
    let timedOut = false;
    let timer = null;
    // 和 provider 一样双保险：abort + Promise.race（测试 / 某些旧浏览器里 fetch 会忽略 signal）
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        try { controller.abort(); } catch { /* ignore */ }
        reject(llmClientError('llm-timeout', `timeout after ${waitMs}ms`));
      }, waitMs);
    });
    const started = now();
    const payload = {
      text: body.slice(0, LLM_CLIENT_MAX_TEXT),
      locale: locale === 'en' ? 'en' : 'zh',
      context: context && typeof context === 'object' ? context : null,
      // 长期记忆按 userId 分文件（服务端还会再校验一次 `^[a-zA-Z0-9_-]{1,32}$`）
      user: String(typeof userId === 'function' ? userId() : userId || 'default').slice(0, 32) || 'default',
      // 只带最近 10 轮（服务端会再夹一次）；**不落盘**
      history: Array.isArray(extra) ? extra.slice(-(turns * 2)) : history.slice(),
    };
    try {
      const res = await Promise.race([f(pathUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }), timeoutPromise]);
      const status = Number(res && res.status) || 0;
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!res || res.ok === false || status >= 400) {
        const code = (data && data.error)
          || (status === 503 ? 'llm-not-configured' : (status === 429 ? 'llm-rate-limit' : `llm-http-${status || 'error'}`));
        throw llmClientError(code, `status ${status}`);
      }
      if (!data || typeof data !== 'object') throw llmClientError('llm-bad-json');
      const reply = String(data.reply || '').trim();
      const actions = normalizeActions(data.actions);
      if (!reply && !actions.length) throw llmClientError('llm-bad-json', 'empty reply');
      // 只调了工具、没有文字的回合也要记进记忆（否则历史里会出现连续两条 user）：
      // assistant 那一格记成工具名，下一轮模型才知道「上一句我已经执行过什么」
      const memoryReply = reply || (actions.length ? actions.map((a) => a.intent).join(',') : '');
      remember(payload.text, memoryReply);
      const ms = Math.max(0, Number(now()) - Number(started));
      last = { ms, actions: actions.length, provider: data.provider || '', model: data.model || '' };
      record('llm:reply', { ms, actions: actions.length });
      return {
        reply,
        actions,
        // 模型刚写/删了记忆时，服务端会回一份最新快照（前端据此刷新「教练记得什么」）
        memory: data.memory && typeof data.memory === 'object' ? data.memory : null,
        memoryOps: Array.isArray(data.memoryOps) ? data.memoryOps : [],
        usage: data.usage && typeof data.usage === 'object' ? data.usage : { prompt: 0, completion: 0, total: 0 },
        provider: String(data.provider || ''),
        model: String(data.model || ''),
        ms,
      };
    } catch (err) {
      const code = (err && err.code)
        || (timedOut ? 'llm-timeout' : 'llm-network');
      record('llm:fail', { code, ms: Math.max(0, Number(now()) - Number(started)) });
      if (timedOut) throw llmClientError('llm-timeout', `timeout after ${waitMs}ms`);
      if (err && err.code) throw err;
      throw llmClientError(code, String((err && err.message) || err));
    } finally {
      try { clearTimeout(timer); } catch { /* ignore */ }
    }
  }

  /** 问服务端「配没配 / 谁 / 哪个模型」（设置面板显示用）；失败返回 null，不抛 */
  async function health() {
    const f = resolveFetch();
    if (!f) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, Math.min(waitMs, 4000));
    try {
      const res = await f(healthUrl, { method: 'GET', signal: controller.signal });
      if (!res || res.ok === false) return null;
      const data = await res.json();
      if (!data || typeof data !== 'object') return null;
      return {
        configured: !!data.configured,
        provider: String(data.provider || ''),
        model: String(data.model || ''),
        limits: data.limits && typeof data.limits === 'object' ? data.limits : null,
        usage: data.usage && typeof data.usage === 'object' ? data.usage : null,
      };
    } catch {
      return null;
    } finally {
      try { clearTimeout(timer); } catch { /* ignore */ }
    }
  }

  return {
    path: pathUrl,
    healthPath: healthUrl,
    timeoutMs: waitMs,
    historyTurns: turns,
    respond,
    health,
    /** 清空对话记忆（刷新页面也会清；这是给「清空对话」/ 测试用的） */
    reset() {
      history.length = 0;
      last = null;
      return this;
    },
    get history() { return history.map((m) => ({ ...m })); },
    get last() { return last ? { ...last } : null; },
    setFetch(fn) {
      call = typeof fn === 'function' ? fn : null;
      return this;
    },
  };
}

export default {
  LLM_PATH,
  LLM_HEALTH_PATH,
  LLM_CLIENT_TIMEOUT_MS,
  LLM_HISTORY_TURNS,
  LLM_CLIENT_MAX_TEXT,
  LLM_CLIENT_ERRORS,
  AGENT_CONTEXT_MAX_CHARS,
  AGENT_HISTORY_MAX,
  AGENT_KEYFRAMES_MAX,
  AGENT_COACH_LINES_MAX,
  AGENT_EVENTS_MAX,
  AGENT_EVENTS_WINDOW_MS,
  AGENT_EVENT_MAX_CHARS,
  AGENT_EVENT_KINDS,
  AGENT_MEMORY_PREF_FIELDS,
  AGENT_MEMORY_FACT_FIELDS,
  TREND_WEEK_SCORE_DELTA,
  buildAgentContext,
  trimAgentContext,
  scoreTrend,
  weekTrend,
  startOfLocalWeek,
  shortStamp,
  memoryForContext,
  normalizeRecentEvents,
  lastSessionForContext,
  trainingSummaryForContext,
  AGENT_SUMMARY_MAX,
  timeOfDayHint,
  createLlmClient,
  llmClientError,
  normalizeActions,
};
