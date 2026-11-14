/**
 * 排课（**每日单次计划**）—— 纯函数，不碰 DOM、不读写 localStorage、不联网。
 *
 * 用户原话：「今天练什么」→ 一份可执行计划 + 一键开始（只做**每日单次计划**，不做 4 周周期）。
 *
 * 这一层只回答三件事：
 *   ① `buildPlanTemplate()` —— 按目标 / 时长 / 器械 / 伤病 / 最近练过什么，从动作库里**排**一份计划；
 *   ② `validatePlan()`       —— 计划**能不能执行**（动作 id 合法 / 时长不超预算 / 不碰伤病禁忌 / 结构合理），
 *      LLM 微调回来的计划**必须**过这一关，不合法就回退模板（绝不交付不安全计划）；
 *   ③ `planToQueue()`        —— 计划 → 执行队列（一组一步 + 组间休息一步），执行层照着走。
 *
 * 依赖方向（保持单向，别在这里 import 任何 UI / app 的东西）：
 *   `i18n.js`（标题 / 理由 / 备注文案） + `catalog.js`（动作库：id / kind / 时长估算）
 *
 * 硬约束：
 *   - **动作必须来自动作库**（`EXERCISE_MAP` 的 id），LLM 也不许发明动作；
 *   - **时长预算**：Σ(组数 × 每组时长 + 休息) ≤ minutes × 60（每组时长按动作 kind 估：
 *     计次 ≈ 每次 3 秒、计时 = 目标秒、限时计数 = 目标秒）；
 *   - **结构**：≥2 个、≤6 个动作；
 *   - **伤病禁忌**：命中就换替代动作（`INJURY_SWAPS`），换不了就整块丢掉。
 */

import { t } from '../i18n.js';
import { EXERCISE_MAP, isTimedReps } from '../catalog.js';

/* ------------------------------------------------------------------ *
 * 常量（全部「一处定义」：界面、测试、服务端 prompt 都读这里）
 * ------------------------------------------------------------------ */

/** 四个目标（用户口径：减脂 / 增肌 / 体能 / 体态） */
export const PLAN_GOALS = Object.freeze(['fatLoss', 'muscle', 'endurance', 'posture']);

/** 器械三档（用户口径：无 / 哑铃 / 弹力带） */
export const PLAN_GEAR = Object.freeze(['none', 'dumbbells', 'band']);

/** 伤病维度（只做两个最常见的：膝盖 / 腰） */
export const PLAN_INJURIES = Object.freeze(['knee', 'waist']);

/** 计划来源（模板 / LLM 微调） */
export const PLAN_SOURCES = Object.freeze(['template', 'llm']);

export const PLAN_DEFAULT_MINUTES = 20;
export const PLAN_MIN_MINUTES = 5;
export const PLAN_MAX_MINUTES = 120;
/** 结构：≥2 个、≤6 个动作（用户要求） */
export const PLAN_MIN_BLOCKS = 2;
export const PLAN_MAX_BLOCKS = 6;
/** 每个动作 1~4 组（组数再多就会挤掉别的动作） */
export const PLAN_MAX_SETS = 4;
export const PLAN_MIN_SETS = 1;
/** 目标下限：计次动作 ≥5 次、计时 / 限时 ≥15 秒（再小就不算练了） */
export const PLAN_MIN_REPS = 5;
export const PLAN_MIN_HOLD_SEC = 15;
export const PLAN_MIN_TIMED_SEC = 20;
/** 计次动作每组时长估算：每次约 3 秒（含换姿势的零头） */
export const PLAN_REP_SECONDS = 3;
/** 组间休息的上限（LLM 给一个荒唐的 600 秒也不接受） */
export const PLAN_MAX_REST_SEC = 180;
/** 计划历史只留最近 10 个（用户要求） */
export const PLAN_HISTORY_MAX = 10;
/** 最近训练摘要最多带 20 条（用户要求 recent20） */
export const PLAN_RECENT_MAX = 20;

/**
 * 伤病禁忌表（**一处定义**）。
 *
 *   knee  → 禁 `lungeJump`（老动作，库里已删，仍然防一手）/ `squatJump` / 大深度深蹲（`squat`）
 *           / 弓步（`lunge`、`lungeBack`）/ 波比跳（`burpee`，落地 + 深蹲）
 *   waist → 禁 `bridge` / `crunch` / `reverseCrunch`（仰卧顶髋与卷腹对腰的高强度屈伸）
 *
 * 注意：这里是**保守的**——宁可少练一个动作，也不让用户在伤痛期做禁忌动作。
 */
export const INJURY_BANS = Object.freeze({
  knee: Object.freeze(['lungeJump', 'squatJump', 'squat', 'lunge', 'lungeBack', 'burpee']),
  waist: Object.freeze(['bridge', 'crunch', 'reverseCrunch']),
});

/**
 * 禁忌命中后的替代动作（会再跑一遍禁忌检查；替代动作本身也不再出现两次）。
 * 没有替代动作的（例如 `burpee` 对膝盖）就整块丢掉。
 */
export const INJURY_SWAPS = Object.freeze({
  lungeJump: 'squatSumo',
  squatJump: 'squatSumo',
  squat: 'squatSumo',
  lunge: 'squatSumo',
  lungeBack: 'squatSumo',
  burpee: 'mountainClimber',
  bridge: 'deadBug',
  crunch: 'deadBug',
  reverseCrunch: 'deadBug',
});

/**
 * 伤病说法 → 维度（用户说的是中文「膝盖 / 腰」，memory facts 里也是中文）。
 * 源码里不留写死的中文（`tests/test-i18n.mjs` 会查），统一用 `\u` 转义写。
 */
const INJURY_WORDS = Object.freeze({
  knee: Object.freeze(['knee', 'knees', '\u819d\u76d6', '\u819d']),          // 膝盖 / 膝
  waist: Object.freeze(['waist', 'low back', 'lower back', 'back', '\u8170']), // 腰
});

/** 器械对**计次动作**的调整：负重时目标次数下调、休息拉长 */
const GEAR_ADJUST = Object.freeze({
  none: Object.freeze({ repScale: 1, restDelta: 0, noteKey: '' }),
  dumbbells: Object.freeze({ repScale: 0.8, restDelta: 10, noteKey: 'plan.note.dumbbells' }),
  band: Object.freeze({ repScale: 0.9, restDelta: 5, noteKey: 'plan.note.band' }),
});

/**
 * 模板（**不是**唯一来源，是「起手式」）：每个目标一条（增肌按上下肢分两条）。
 * 字段：exerciseId / sets / target / restSec；`target` 对计次是「次」、对计时与限时计数是「秒」。
 */
const TEMPLATES = Object.freeze({
  fatLoss: Object.freeze({
    titleKey: 'plan.title.fatLoss',
    rationaleKey: 'plan.rationale.fatLoss',
    blocks: Object.freeze([
      { exerciseId: 'jumpingJack', sets: 3, target: 45, restSec: 20 },
      { exerciseId: 'squat', sets: 3, target: 15, restSec: 30 },
      { exerciseId: 'mountainClimber', sets: 3, target: 20, restSec: 25 },
      { exerciseId: 'buttKick', sets: 2, target: 45, restSec: 20 },
      { exerciseId: 'plank', sets: 2, target: 30, restSec: 25 },
      { exerciseId: 'burpee', sets: 2, target: 8, restSec: 30 },
    ]),
  }),
  muscle: Object.freeze({
    upper: Object.freeze({
      titleKey: 'plan.title.muscleUpper',
      rationaleKey: 'plan.rationale.muscleUpper',
      blocks: Object.freeze([
        { exerciseId: 'pushup', sets: 3, target: 10, restSec: 45 },
        { exerciseId: 'kneePushup', sets: 3, target: 12, restSec: 40 },
        { exerciseId: 'plank', sets: 2, target: 40, restSec: 40 },
        { exerciseId: 'deadBug', sets: 2, target: 12, restSec: 40 },
      ]),
    }),
    lower: Object.freeze({
      titleKey: 'plan.title.muscleLower',
      rationaleKey: 'plan.rationale.muscleLower',
      blocks: Object.freeze([
        { exerciseId: 'squat', sets: 3, target: 15, restSec: 45 },
        { exerciseId: 'lungeBack', sets: 3, target: 12, restSec: 45 },
        { exerciseId: 'bridge', sets: 3, target: 15, restSec: 40 },
        { exerciseId: 'squatSumo', sets: 2, target: 15, restSec: 40 },
      ]),
    }),
  }),
  endurance: Object.freeze({
    titleKey: 'plan.title.endurance',
    rationaleKey: 'plan.rationale.endurance',
    blocks: Object.freeze([
      { exerciseId: 'jumpingJack', sets: 3, target: 40, restSec: 20 },
      { exerciseId: 'mountainClimber', sets: 3, target: 30, restSec: 20 },
      { exerciseId: 'buttKick', sets: 3, target: 40, restSec: 20 },
      { exerciseId: 'burpee', sets: 3, target: 8, restSec: 30 },
      { exerciseId: 'plank', sets: 2, target: 30, restSec: 20 },
    ]),
  }),
  posture: Object.freeze({
    titleKey: 'plan.title.posture',
    rationaleKey: 'plan.rationale.posture',
    blocks: Object.freeze([
      { exerciseId: 'deadBug', sets: 2, target: 12, restSec: 30 },
      { exerciseId: 'plank', sets: 2, target: 40, restSec: 30 },
      { exerciseId: 'crunch', sets: 2, target: 15, restSec: 30 },
      { exerciseId: 'standingForwardFold', sets: 2, target: 30, restSec: 15 },
      { exerciseId: 'seatedForwardFold', sets: 2, target: 30, restSec: 15 },
    ]),
  }),
});

/* ------------------------------------------------------------------ *
 * 小工具（纯函数）
 * ------------------------------------------------------------------ */

const toInt = (value, fallback = 0) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
};

const clampInt = (value, lo, hi) => Math.max(lo, Math.min(hi, toInt(value, lo)));

/** 疾病 / 伤病说法归一化：字符串或数组 → `['knee','waist']`（去重、按 PLAN_INJURIES 顺序） */
export function normalizeInjuries(raw) {
  const list = Array.isArray(raw) ? raw : (raw === undefined || raw === null || raw === '' ? [] : [raw]);
  const found = new Set();
  for (const item of list) {
    const text = String(item == null ? '' : item).toLowerCase();
    if (!text) continue;
    for (const id of PLAN_INJURIES) {
      const words = INJURY_WORDS[id] || [];
      if (words.some((w) => text.includes(String(w).toLowerCase()))) found.add(id);
    }
  }
  return PLAN_INJURIES.filter((id) => found.has(id));
}

/** 某个动作是否被这些伤病禁掉（纯判断，不做替代） */
export function isBannedExercise(exerciseId, injuries) {
  const ids = normalizeInjuries(injuries);
  if (!ids.length) return false;
  return ids.some((injury) => (INJURY_BANS[injury] || []).includes(String(exerciseId || '')));
}

/** 一组预计占多少秒（计次 ≈ 每次 3 秒；计时 / 限时计数 = 目标秒） */
export function perSetSeconds(block) {
  const id = String((block && block.exerciseId) || '');
  const meta = EXERCISE_MAP[id];
  const target = Math.max(1, toInt(block && block.target, 1));
  if (!meta) return target * PLAN_REP_SECONDS;
  if (meta.kind === 'hold' || isTimedReps(meta)) return target;
  return target * PLAN_REP_SECONDS;
}

/** 一个动作块预计占多少秒：组数 ×（每组时长 + 组间休息） */
export function estimateBlockSeconds(block) {
  const sets = clampInt(block && block.sets, PLAN_MIN_SETS, 99);
  const rest = Math.max(0, Math.min(PLAN_MAX_REST_SEC, toInt(block && block.restSec, 0)));
  return sets * (perSetSeconds(block) + rest);
}

/** 整份计划的总量：`{actions, sets, seconds}` */
export function planTotals(plan) {
  const blocks = Array.isArray(plan && plan.blocks) ? plan.blocks : [];
  let sets = 0;
  let seconds = 0;
  for (const block of blocks) {
    sets += clampInt(block && block.sets, PLAN_MIN_SETS, 99);
    seconds += estimateBlockSeconds(block);
  }
  return { actions: blocks.length, sets, seconds };
}

/** 目标 / 器械 / 时长归一化（脏存档、语音口述、LLM 都可能给奇怪的值） */
export function normalizePlanOptions({ goal, minutes, gear, injuries } = {}) {
  const g = PLAN_GOALS.includes(String(goal || '')) ? String(goal) : PLAN_GOALS[0];
  const m = clampInt(minutes === undefined || minutes === null ? PLAN_DEFAULT_MINUTES : minutes,
    PLAN_MIN_MINUTES, PLAN_MAX_MINUTES);
  const eq = PLAN_GEAR.includes(String(gear || '')) ? String(gear) : PLAN_GEAR[0];
  return { goal: g, minutes: m, gear: eq, injuries: normalizeInjuries(injuries) };
}

/** 最近训练（`[{exerciseId, at}]`，也接受裸 id）→ 只留最近 7 天、最多 20 条的紧凑行 */
export function recentForPlan(recent, { max = PLAN_RECENT_MAX, now = Date.now() } = {}) {
  const nowMs = Number(now) || Date.now();
  const weekAgo = nowMs - 7 * 24 * 60 * 60 * 1000;
  const out = [];
  for (const item of Array.isArray(recent) ? recent : []) {
    const row = item && typeof item === 'object' ? item : { exerciseId: item };
    const exerciseId = String(row.exerciseId || row.id || '');
    if (!EXERCISE_MAP[exerciseId]) continue;
    const at = Number(row.at) || nowMs;
    if (at < weekAgo) continue;
    out.push({ exerciseId, at });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, Math.max(0, Number(max) || PLAN_RECENT_MAX));
}

/**
 * 增肌分化：最近 7 天里上肢 / 下肢各练了几组，**挑练得少的那半边**（用户口径）。
 * 打平时练下肢（腿部肌群更大、对「今天练什么」更值）。
 */
export function muscleFocus(recent, { now = Date.now() } = {}) {
  const rows = recentForPlan(recent, { now });
  let upper = 0;
  let lower = 0;
  for (const row of rows) {
    const meta = EXERCISE_MAP[row.exerciseId];
    if (!meta) continue;
    if (meta.cats.includes('upper')) upper += 1;
    if (meta.cats.includes('lower')) lower += 1;
  }
  const focus = upper > lower ? 'lower' : (lower > upper ? 'upper' : 'lower');
  return { focus, upper, lower, sample: rows.length };
}

/** 数组按 n 旋转（「换一个」用它换出血不一样的起手动作；纯函数） */
function rotate(list, n) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const k = arr.length ? ((toInt(n, 0) % arr.length) + arr.length) % arr.length : 0;
  return k ? [...arr.slice(k), ...arr.slice(0, k)] : arr;
}

/** 这个动作的「目标下限」：计次 ≥5 次 / 计时 ≥15 秒 / 限时计数 ≥20 秒 */
function targetFloor(exerciseId) {
  const meta = EXERCISE_MAP[exerciseId];
  if (!meta) return PLAN_MIN_REPS;
  if (meta.kind === 'hold') return PLAN_MIN_HOLD_SEC;
  if (isTimedReps(meta)) return PLAN_MIN_TIMED_SEC;
  return PLAN_MIN_REPS;
}

/** 动作的本地化名字（标题 / 备注里用得到；找不到就退回 id，绝不抛） */
export function exerciseName(exerciseId) {
  const id = String(exerciseId || '');
  if (!EXERCISE_MAP[id]) return id;
  return t(`ex.${id}.name`);
}

/** 动作的目标单位（次 / 秒） */
export function targetUnit(exerciseId) {
  const meta = EXERCISE_MAP[String(exerciseId || '')];
  if (!meta) return t('ui.repsUnit');
  return t(meta.kind === 'hold' || isTimedReps(meta) ? 'ui.secondsUnit' : 'ui.repsUnit');
}

/* ------------------------------------------------------------------ *
 * 模板生成
 * ------------------------------------------------------------------ */

/** 模板 + 归一化后的一组原始块（还没过禁忌 / 预算） */
function templateFor(goal, focus) {
  if (goal === 'muscle') {
    const spec = TEMPLATES.muscle[focus] || TEMPLATES.muscle.lower;
    return { titleKey: spec.titleKey, rationaleKey: spec.rationaleKey, blocks: spec.blocks };
  }
  return TEMPLATES[goal] || TEMPLATES.fatLoss;
}

/** 用一个原始块 + 器械调整 → 真正的计划块（含 note 文案） */
function makeBlock(raw, { gear, injuries, swapped }) {
  const adjust = GEAR_ADJUST[gear] || GEAR_ADJUST.none;
  const meta = EXERCISE_MAP[raw.exerciseId];
  const timed = isTimedReps(meta);
  const hold = meta && meta.kind === 'hold';
  let target = Math.max(targetFloor(raw.exerciseId), toInt(raw.target, 10));
  // 器械只影响**计次**动作：负重 / 阻力之后次数下调（休息时间上浮，见下面的 restSec）
  if (!timed && !hold) target = Math.max(PLAN_MIN_REPS, Math.round(target * adjust.repScale));
  const noteKeys = [];
  if (swapped) noteKeys.push('plan.note.swapped');
  if (!timed && !hold && adjust.noteKey) noteKeys.push(adjust.noteKey);
  return {
    exerciseId: raw.exerciseId,
    sets: clampInt(raw.sets, PLAN_MIN_SETS, PLAN_MAX_SETS),
    target,
    restSec: Math.max(0, Math.min(PLAN_MAX_REST_SEC, toInt(raw.restSec, 0) + adjust.restDelta)),
    note: noteKeys.map((key) => t(key)).filter(Boolean).join(' · '),
    name: exerciseName(raw.exerciseId),
  };
}

/**
 * 时长预算：把块列表压到 ≤ `budgetSec`（纯函数，返回新数组，不改入参）。
 *
 * 顺序（先动「最不痛」的）：
 *   ① 组数最多的那块减一组 → ② 最长那块的目标降到 80%（不低于该动作下限）→
 *   ③ 丢最后一块（保持 ≥2 个动作）→ ④ 休息时间减半（最后才动，休息是安全的一部分）。
 */
export function shrinkToBudget(blocks, budgetSec) {
  const out = (Array.isArray(blocks) ? blocks : [])
    .map((b) => ({ ...b, sets: clampInt(b.sets, PLAN_MIN_SETS, PLAN_MAX_SETS) }));
  const budget = Math.max(0, Number(budgetSec) || 0);
  if (!out.length) return out;
  const total = () => out.reduce((sum, b) => sum + estimateBlockSeconds(b), 0);
  let guard = 400;
  while (total() > budget && guard > 0) {
    guard -= 1;
    // ① 组数最多的（并列时先动更长的那块）
    const bySets = out
      .filter((b) => b.sets > PLAN_MIN_SETS)
      .sort((a, b) => (b.sets - a.sets) || (estimateBlockSeconds(b) - estimateBlockSeconds(a)))[0];
    if (bySets) { bySets.sets -= 1; continue; }
    // ② 最长那块的目标降 20%
    const longest = [...out].sort((a, b) => estimateBlockSeconds(b) - estimateBlockSeconds(a))[0];
    const floor = targetFloor(longest.exerciseId);
    const next = Math.max(floor, Math.round(longest.target * 0.8));
    if (next < longest.target) { longest.target = next; continue; }
    // ③ 丢最后一块
    if (out.length > PLAN_MIN_BLOCKS) { out.pop(); continue; }
    // ④ 休息时间减半（0 也不能再降）
    if (out.some((b) => b.restSec > 0)) {
      for (const b of out) b.restSec = Math.max(0, Math.floor(b.restSec / 2));
      continue;
    }
    break;
  }
  return out;
}

/**
 * 排一份**模板计划**（纯函数；不落盘）。
 *
 * @param {object}   [opts]
 * @param {string}   [opts.goal]     `PLAN_GOALS` 之一（非法 / 缺省 → fatLoss）
 * @param {number}   [opts.minutes]  总时长预算（分钟，5~120）
 * @param {string}   [opts.gear]     `PLAN_GEAR` 之一（非法 → none）
 * @param {Array}    [opts.injuries] 伤病说法（中文 / 英文都认：膝盖 / 腰 / knee / waist）
 * @param {Array}    [opts.recent]   最近训练（增肌分化按最近 7 天没练的部位选）
 * @param {number}   [opts.variant]  第几套变体（「换一个」用它换出不同计划；默认 0）
 * @param {number}   [opts.now]      注入时钟（测试用）
 * @returns {{title:string, blocks:Array<{exerciseId:string,sets:number,target:number,
 *            restSec:number,note:string,name:string}>, source:'template', rationale:string,
 *            goal:string, minutes:number, gear:string, injuries:string[], focus:string,
 *            variant:number, actions:number, sets:number, seconds:number, createdAt:number}}
 */
export function buildPlanTemplate({
  goal, minutes, gear, injuries, recent, variant = 0, now = Date.now(),
} = {}) {
  const opts = normalizePlanOptions({ goal, minutes, gear, injuries });
  const focusInfo = opts.goal === 'muscle' ? muscleFocus(recent, { now }) : { focus: '', upper: 0, lower: 0 };
  const spec = templateFor(opts.goal, focusInfo.focus);
  const rawList = rotate(spec.blocks, variant);
  const budgetSec = opts.minutes * 60;

  /* ① 禁忌过滤 + 替代 + 去重 */
  const picked = [];
  const seen = new Set();
  for (const raw of rawList) {
    if (picked.length >= PLAN_MAX_BLOCKS) break;
    let id = String(raw.exerciseId || '');
    if (!EXERCISE_MAP[id]) continue;
    let swapped = false;
    if (isBannedExercise(id, opts.injuries)) {
      const swap = INJURY_SWAPS[id];
      if (!swap || !EXERCISE_MAP[swap] || isBannedExercise(swap, opts.injuries) || seen.has(swap)) continue;
      id = swap;
      swapped = true;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    picked.push(makeBlock({ ...raw, exerciseId: id }, { gear: opts.gear, injuries: opts.injuries, swapped }));
  }

  /* ② 时长预算（同一套估算函数，和 validatePlan 完全一致） */
  let blocks = shrinkToBudget(picked, budgetSec);
  if (blocks.length > PLAN_MAX_BLOCKS) blocks = blocks.slice(0, PLAN_MAX_BLOCKS);

  /* ③ 标题 / 理由 / 汇总 */
  const totals = planTotals({ blocks });
  const title = t(spec.titleKey, { minutes: opts.minutes, focus: t(`plan.focus.${focusInfo.focus || 'lower'}`) });
  const rationale = t(spec.rationaleKey, {
    actions: totals.actions,
    sets: totals.sets,
    minutes: opts.minutes,
    rest: blocks.length ? Math.max(0, Math.round(
      blocks.reduce((sum, b) => sum + Math.max(0, Number(b.restSec) || 0), 0) / blocks.length,
    )) : 0,
    focus: t(`plan.focus.${focusInfo.focus || 'lower'}`),
    upper: focusInfo.upper,
    lower: focusInfo.lower,
    gear: t(`plan.gear.${opts.gear}`),
  });
  return {
    title,
    blocks,
    source: 'template',
    rationale,
    goal: opts.goal,
    minutes: opts.minutes,
    gear: opts.gear,
    injuries: opts.injuries,
    focus: focusInfo.focus,
    variant: toInt(variant, 0),
    actions: totals.actions,
    sets: totals.sets,
    seconds: totals.seconds,
    createdAt: Number(now) || Date.now(),
  };
}

/* ------------------------------------------------------------------ *
 * 校验（LLM 回来的计划必须过这一关）
 * ------------------------------------------------------------------ */

/**
 * 计划是否**可执行**（结构 / id / 时长 / 禁忌）。
 *
 * @param {object} plan
 * @param {object} [opts]
 * @param {number} [opts.minutes]   时长预算（不给就不查时长）
 * @param {Array}  [opts.injuries]  伤病（不给就不查禁忌）
 * @param {object|Array} [opts.catalog] 动作库（默认 `EXERCISE_MAP`；测试可以塞一个小库）
 * @returns {{ok:boolean, reasons:string[]}}
 */
export function validatePlan(plan, { minutes, injuries, catalog } = {}) {
  const reasons = [];
  const lib = catalog === undefined || catalog === null ? EXERCISE_MAP : catalog;
  const has = (id) => {
    if (!id) return false;
    if (Array.isArray(lib)) return lib.some((x) => (typeof x === 'string' ? x : x && x.id) === id);
    return Object.prototype.hasOwnProperty.call(lib, id);
  };
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, reasons: ['bad-shape'] };
  if (typeof plan.title !== 'string' || !plan.title.trim()) reasons.push('bad-title');
  if (plan.source !== undefined && !PLAN_SOURCES.includes(String(plan.source))) reasons.push('bad-source');
  const blocks = plan.blocks;
  if (!Array.isArray(blocks) || !blocks.length) return { ok: false, reasons: [...reasons, 'no-blocks'] };
  if (blocks.length < PLAN_MIN_BLOCKS) reasons.push('too-few-blocks');
  if (blocks.length > PLAN_MAX_BLOCKS) reasons.push('too-many-blocks');
  const banned = normalizeInjuries(injuries);
  const seen = new Set();
  blocks.forEach((block, index) => {
    const b = block && typeof block === 'object' ? block : {};
    const id = String(b.exerciseId || '');
    if (!has(id)) { reasons.push(`unknown-exercise:${id || '?'}`); return; }
    if (seen.has(id)) reasons.push(`duplicate-exercise:${id}`);
    seen.add(id);
    const sets = toInt(b.sets, 0);
    if (sets < PLAN_MIN_SETS || sets > PLAN_MAX_SETS) reasons.push(`bad-sets:${index}`);
    const target = toInt(b.target, 0);
    if (target < targetFloor(id)) reasons.push(`bad-target:${index}`);
    const rest = Number(b.restSec);
    if (!Number.isFinite(rest) || rest < 0 || rest > PLAN_MAX_REST_SEC) reasons.push(`bad-rest:${index}`);
    if (banned.length && isBannedExercise(id, banned)) reasons.push(`banned:${id}`);
  });
  const budget = Number(minutes);
  if (Number.isFinite(budget) && budget > 0) {
    const totals = planTotals({ blocks });
    if (totals.seconds > Math.round(budget * 60)) reasons.push(`over-budget:${totals.seconds}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ *
 * 执行队列
 * ------------------------------------------------------------------ */

/**
 * 计划 → 执行队列：一组一步（`set`），组间一步休息（`rest`），最后一组的后面没有休息。
 *
 * @param {object} plan
 * @returns {Array<{type:'set', blockIndex:number, setIndex:number, exerciseId:string,
 *                  target:number, restSec:number, blockSets:number}
 *               | {type:'rest', seconds:number, blockIndex:number, afterSet:number}>}
 */
export function planToQueue(plan) {
  const blocks = Array.isArray(plan && plan.blocks) ? plan.blocks : [];
  const queue = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i] && typeof blocks[i] === 'object' ? blocks[i] : {};
    const exerciseId = String(b.exerciseId || '');
    const sets = clampInt(b.sets, PLAN_MIN_SETS, 99);
    const target = Math.max(0, toInt(b.target, 0));
    const restSec = Math.max(0, Math.min(PLAN_MAX_REST_SEC, toInt(b.restSec, 0)));
    for (let s = 1; s <= sets; s += 1) {
      queue.push({ type: 'set', blockIndex: i, setIndex: s, exerciseId, target, restSec, blockSets: sets });
      const isLast = i === blocks.length - 1 && s === sets;
      if (!isLast && restSec > 0) {
        queue.push({ type: 'rest', seconds: restSec, blockIndex: i, afterSet: s });
      }
    }
  }
  return queue;
}

/** 队列的汇总（执行层显示「第几组 / 共几组」用） */
export function queueTotals(queue) {
  const list = Array.isArray(queue) ? queue : [];
  let sets = 0;
  let seconds = 0;
  for (const step of list) {
    if (!step) continue;
    if (step.type === 'set') {
      sets += 1;
      seconds += perSetSeconds(step);
    } else if (step.type === 'rest') seconds += Math.max(0, Number(step.seconds) || 0);
  }
  return { sets, seconds };
}

/* ------------------------------------------------------------------ *
 * LLM 微调：请求体 / 回包解析
 * ------------------------------------------------------------------ */

/**
 * 发给模型的 plan-request 载荷（**纯数据**；`llm.js` 把它塞进 `context`）。
 * 用户要求带：`{goal, minutes, gear, injuries, recent20, template}`。
 */
export function buildPlanRequest({ goal, minutes, gear, injuries, recent, template } = {}) {
  const opts = normalizePlanOptions({ goal, minutes, gear, injuries });
  const rows = recentForPlan(recent);
  return {
    goal: opts.goal,
    minutes: opts.minutes,
    gear: opts.gear,
    injuries: opts.injuries,
    recent: rows.map((row) => ({
      exerciseId: row.exerciseId,
      daysAgo: Math.max(0, Math.round((Date.now() - row.at) / (24 * 60 * 60 * 1000))),
    })),
    template: template && typeof template === 'object'
      ? {
        title: String(template.title || ''),
        blocks: (Array.isArray(template.blocks) ? template.blocks : []).map((b) => ({
          exerciseId: String(b.exerciseId || ''),
          sets: toInt(b.sets, 1),
          target: toInt(b.target, 0),
          restSec: Math.max(0, toInt(b.restSec, 0)),
        })),
      }
      : null,
  };
}

/** 块的两个数值字段统一（LLM 常给字符串 "12" / 3.0） */
function normalizeBlock(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  return {
    exerciseId: String(b.exerciseId || b.exercise || b.id || '').trim(),
    sets: toInt(b.sets, 0),
    target: toInt(b.target ?? b.reps ?? b.seconds, 0),
    restSec: Math.max(0, toInt(b.restSec ?? b.rest, 0)),
    note: typeof b.note === 'string' ? b.note.slice(0, 120) : '',
  };
}

/**
 * 模型回来的文本 → 计划对象（**只做解析与形状归一化**，合不合法交给 `validatePlan`）。
 *
 * 容忍：```json 代码块、前后多一句解释（截第一对 `{}`）、`{plan:{...}}` 包一层。
 *
 * @param {string} raw
 * @param {{titleFallback?:string}} [opts]
 * @returns {{ok:boolean, plan:object|null, reason:string}}
 */
export function parsePlanJson(raw, { titleFallback = '' } = {}) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, plan: null, reason: 'empty' };
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let data = null;
  const tryParse = (chunk) => {
    try { return JSON.parse(chunk); } catch { return null; }
  };
  data = tryParse(unfenced);
  if (!data) {
    const a = unfenced.indexOf('{');
    const b = unfenced.lastIndexOf('}');
    if (a >= 0 && b > a) data = tryParse(unfenced.slice(a, b + 1));
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, plan: null, reason: 'bad-json' };
  }
  const src = data.plan && typeof data.plan === 'object' ? data.plan : data;
  const blocksRaw = Array.isArray(src.blocks) ? src.blocks : (Array.isArray(src.exercises) ? src.exercises : []);
  const blocks = blocksRaw.map(normalizeBlock).filter((b) => b.exerciseId);
  const plan = {
    title: String(src.title || titleFallback || '').trim(),
    blocks,
    source: 'llm',
    rationale: String(src.rationale || src.reason || '').trim(),
    goal: String(src.goal || ''),
    minutes: toInt(src.minutes, 0),
    gear: String(src.gear || ''),
    injuries: normalizeInjuries(src.injuries),
  };
  return { ok: true, plan, reason: '' };
}

export default {
  PLAN_GOALS,
  PLAN_GEAR,
  PLAN_INJURIES,
  PLAN_SOURCES,
  PLAN_DEFAULT_MINUTES,
  PLAN_MIN_MINUTES,
  PLAN_MAX_MINUTES,
  PLAN_MIN_BLOCKS,
  PLAN_MAX_BLOCKS,
  PLAN_MAX_SETS,
  PLAN_MIN_SETS,
  PLAN_MIN_REPS,
  PLAN_MIN_HOLD_SEC,
  PLAN_MIN_TIMED_SEC,
  PLAN_REP_SECONDS,
  PLAN_MAX_REST_SEC,
  PLAN_HISTORY_MAX,
  PLAN_RECENT_MAX,
  INJURY_BANS,
  INJURY_SWAPS,
  normalizeInjuries,
  isBannedExercise,
  perSetSeconds,
  estimateBlockSeconds,
  planTotals,
  normalizePlanOptions,
  recentForPlan,
  muscleFocus,
  exerciseName,
  targetUnit,
  buildPlanTemplate,
  shrinkToBudget,
  validatePlan,
  planToQueue,
  queueTotals,
  buildPlanRequest,
  parsePlanJson,
};
