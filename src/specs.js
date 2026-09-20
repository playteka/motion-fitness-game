/**
 * 每个动作的「计次技术指标」。
 *
 * 🎯「运动设定」弹窗把这些指标直接列给用户看，用来理解判据、调整姿势。
 *
 * 关键约定（很重要）：
 *   这里的**每一个数字都直接取自识别器真正使用的常量**，不是另写一份文案：
 *     - 手写识别器：exercises.js 的 SQUAT / LUNGE / PUSHUP / BRIDGE / PLANK
 *     - 通用引擎：catalog.js 里该动作的 params（up/down 与 enter/bottom/loose/ignore 进度）
 *     - 姿势门控：engines.js 的 GATE_LIMITS / SEQ_STAGE_LIMITS（同一张表也用于 GATES 判定）
 *     - 实时提醒：engines.js 的 ADVISORY（同一份数值）
 *     - 计时类：detector-base.js 的 HOLD_PRIME_MS / HOLD_GRACE_MS
 *   改了判定阈值，这里显示的数值会自动跟着变，不会出现「界面说的和实际判的不一样」。
 *
 * 一条指标（item）的结构：
 *   { labelKey, metricKey, op, value, value2, unit, noteKey, noteParams }
 *     labelKey   这一行是什么（i18n，如「计入一次（宽松模式）」）
 *     metricKey  看的指标（i18n，如「前膝屈角」）；只有数值没有指标时省略
 *     op         'lte' | 'gte' | 'lt' | 'gt' | 'range'
 *     value      数值（来自代码常量）；range 时配合 value2
 *     unit       'deg' | 'torso' | 'lift' | 's' | 'count'
 *     noteKey/noteParams  可选的补充说明（i18n，可带占位符）
 *   { labelKey, textKey, noteParams }：没有可计算数值的条目（比如「回到最弯处回升 60%」）
 */

import { EXERCISE_MAP } from './catalog.js';
import { GATE_LIMITS, SEQ_STAGE_LIMITS, ADVISORY_LIMITS, SIDE_METRICS } from './engines.js';
import { HORIZONTAL_TILT } from './metrics.js';
import { HOLD_PRIME_MS, HOLD_GRACE_MS } from './detector-base.js';
import { t } from './i18n.js';
import {
  SQUAT, LUNGE, PUSHUP, BRIDGE, PLANK,
} from './exercises.js';

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const DEG = 'deg';
const TORSO = 'torso';
const SHIN = 'shin';
const LIFT = 'lift';
const S = 's';
const COUNT = 'count';

/** 不同单位的显示精度：角度取整，比例两位小数，秒两位小数 */
const PRECISION = { deg: 0, torso: 2, shin: 2, lift: 3, s: 2, count: 0 };

/** 按单位取整（界面显示用；判定本身用的仍是原始常量） */
export function roundFor(v, unit) {
  const d = PRECISION[unit] ?? 2;
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

/** 指标单位：角度用度，各种「离地高度 / 比例」用倍躯干长（后膝用小腿长） */
export const METRIC_UNITS = {
  knee: DEG, kneeBent: DEG, kneeExtended: DEG, elbow: DEG, elbowBent: DEG, elbowExtended: DEG,
  hip: DEG, ankle: DEG, body: DEG, trunk: DEG, torsoIncl: DEG,
  shoulderClear: TORSO, kneeClear: TORSO, hipClear: TORSO, wristClear: TORSO, wristClearMin: TORSO,
  hipRise: TORSO, armRaised: TORSO, kneeSpread: TORSO,
  hipLineDevAbs: TORSO, valgus: TORSO, shoulderDrop: TORSO, wristTwist: TORSO,
  backKneeDrop: SHIN, hipAboveKnee: SHIN,
};

/** 进度 → 指标值：progress = (up - v) / (up - down)，反解 v */
const valueAt = (up, down, p) => up - p * (up - down);

/** 数值越小越「到位」时用 lte，反之 gte */
const deepOp = (up, down) => (up >= down ? 'lte' : 'gte');

/** 门控标签：告诉用户「这个动作要保持在什么姿势」 */
const poseKey = (gateName) => `spec.pose.${gateName}`;

const item = (o) => o;

/* ------------------------------------------------------------------ *
 * 姿势门控 → 指标行（数值来自 GATE_LIMITS，与判定同一张表）
 * ------------------------------------------------------------------ */

function rangeItem(labelKey, metricKey, range, unit) {
  const [min, max] = range;
  const r = (v) => roundFor(v, unit);
  if (min !== null && max !== null) {
    return item({ labelKey, metricKey, op: 'range', value: r(min), value2: r(max), unit });
  }
  if (max !== null) return item({ labelKey, metricKey, op: 'lte', value: r(max), unit });
  return item({ labelKey, metricKey, op: 'gte', value: r(min), unit });
}

/** 某个门控的全部指标行 */
function gateItems(gateName) {
  const limits = GATE_LIMITS[gateName];
  if (!limits) return [];
  const out = [];
  for (const [metric, range] of Object.entries(limits)) {
    const unit = METRIC_UNITS[metric] || TORSO;
    out.push(rangeItem(poseKey(gateName), `metric.${metric}`, range, unit));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 通用「屈伸一次」类：数值全部由 catalog 的 up/down 与进度阈值算出
 * ------------------------------------------------------------------ */

function bendSpecs(meta) {
  const p = meta.params || {};
  const up = Number.isFinite(p.up) ? p.up : 170;
  const down = Number.isFinite(p.down) ? p.down : 100;
  const enterP = p.enterP ?? 0.32;
  const bottomP = p.bottomP ?? 0.85;
  const backP = p.backP ?? 0.16;
  const looseP = p.looseP ?? 0.55;
  const ignoreP = p.ignoreP ?? 0.45;
  const minRepMs = p.minRepMs ?? 380;
  const metric = p.metric || 'knee';
  const unit = METRIC_UNITS[metric] || TORSO;
  const metricKey = `metric.${metric}`;
  const op = deepOp(up, down);
  const back = op === 'lte' ? 'gte' : 'lte';
  const at = (pr) => roundFor(valueAt(up, down, pr), unit);

  const count = [
    item({ labelKey: 'spec.enterLine', metricKey, op, value: at(enterP), unit, noteKey: 'spec.note.enterLine' }),
    item({ labelKey: 'spec.countLine', metricKey, op, value: at(looseP), unit, noteKey: 'spec.note.looseMode' }),
    item({ labelKey: 'spec.bottomLine', metricKey, op, value: at(bottomP), unit, noteKey: 'spec.note.bottomLine' }),
    item({ labelKey: 'spec.backLine', metricKey, op: back, value: at(backP), unit, noteKey: 'spec.note.adaptive' }),
    item({ labelKey: 'spec.wobble', metricKey, op: op === 'lte' ? 'gt' : 'lt', value: at(ignoreP), unit, noteKey: 'spec.note.wobble' }),
    item({ labelKey: 'spec.minRep', op: 'gte', value: roundFor(minRepMs / 1000, S), unit: S }),
  ];
  if (p.flight) {
    count.push(item({
      labelKey: 'spec.flight',
      metricKey: 'metric.lift',
      op: 'gte',
      value: roundFor(Number.isFinite(p.flightMin) ? p.flightMin : 0.035, LIFT),
      unit: LIFT,
      noteKey: 'spec.note.flight',
    }));
  }
  const gate = p.gate || 'stand';
  return { count, posture: gateItems(gate), advice: advisoryItems(gate) };
}

/** 左右交替类：一侧「进入动作」、另一侧「回到休息位」，交替才算一次 */
function altSpecs(meta) {
  const p = meta.params || {};
  const cmpLt = (p.cmp || 'lt') === 'lt';
  const onValue = Number.isFinite(p.onValue) ? p.onValue : (p.active ?? 110);
  const offValue = Number.isFinite(p.offValue) ? p.offValue : (p.inactive ?? 140);
  const minRepMs = p.minRepMs ?? 200;
  const holdMs = p.holdMs ?? 60;
  const metric = p.metric || 'knee';
  const unit = METRIC_UNITS[metric] || DEG;
  const gate = p.gate || 'prone';
  return {
    count: [
      item({
        labelKey: 'spec.altOn',
        metricKey: 'metric.oneSide',
        op: cmpLt ? 'lte' : 'gte',
        value: roundFor(onValue, unit),
        unit,
        noteKey: 'spec.note.altOn',
      }),
      item({
        labelKey: 'spec.altOff',
        metricKey: 'metric.otherSide',
        op: cmpLt ? 'gte' : 'lte',
        value: roundFor(offValue, unit),
        unit,
        noteKey: 'spec.note.altOff',
      }),
      item({ labelKey: 'spec.altHold', op: 'gte', value: roundFor(holdMs / 1000, S), unit: S, noteKey: 'spec.note.altHold' }),
      item({ labelKey: 'spec.altGap', op: 'gte', value: roundFor(minRepMs / 1000, S), unit: S, noteKey: 'spec.note.altGap' }),
    ],
    posture: gateItems(gate),
    advice: advisoryItems(gate),
  };
}

/** 左右转体类（坐着左右扭） */
function twistSpecs(meta) {
  const p = meta.params || {};
  const amount = p.amount ?? 0.16;
  const minRepMs = p.minRepMs ?? 220;
  const gate = p.gate || 'seatedLow';
  return {
    count: [
      item({
        labelKey: 'spec.twistAmount',
        metricKey: 'metric.wristTwist',
        op: 'range',
        value: -roundFor(amount, TORSO),
        value2: roundFor(amount, TORSO),
        unit: TORSO,
        noteKey: 'spec.note.twistAmount',
      }),
      item({ labelKey: 'spec.altGap', op: 'gte', value: roundFor(minRepMs / 1000, S), unit: S, noteKey: 'spec.note.altGap' }),
    ],
    posture: gateItems(gate),
    advice: [],
  };
}

/** 多段序列（波比跳）：每一段都要按顺序做到 */
function sequenceSpecs(meta) {
  const p = meta.params || {};
  const names = p.stages || ['stand', 'crouch', 'plank', 'jump'];
  const total = names.length;
  const count = names.map((name, i) => {
    const limits = SEQ_STAGE_LIMITS[name] || {};
    const quant = Object.entries(limits).find(([k]) => k !== 'gate');
    const n = i + 1;
    if (quant) {
      const [metric, range] = quant;
      const unit = metric === 'lift' ? LIFT : (METRIC_UNITS[metric] || TORSO);
      return {
        ...rangeItem(`spec.seq${n}`, `metric.${metric}`, range, unit),
        noteKey: 'spec.note.sequence',
        noteParams: { n, total },
      };
    }
    return item({
      labelKey: `spec.seq${n}`,
      textKey: limits.gate ? poseKey(limits.gate) : 'spec.text.outOfPose',
      noteKey: 'spec.note.sequence',
      noteParams: { n, total },
    });
  });
  count.push(item({
    labelKey: 'spec.seqWindow',
    op: 'lte',
    value: roundFor((p.windowMs ?? 9000) / 1000, S),
    unit: S,
    noteKey: 'spec.note.seqWindow',
  }));
  count.push(item({ labelKey: 'spec.minRep', op: 'gte', value: roundFor((p.minRepMs ?? 900) / 1000, S), unit: S }));
  return { count, posture: gateItems('stand'), advice: advisoryItems('stand') };
}

/** 计时类（姿势到位就计时） */
function holdSpecs(meta) {
  const p = meta.params || {};
  const count = [
    item({ labelKey: 'spec.holdPrime', op: 'gte', value: roundFor(HOLD_PRIME_MS / 1000, S), unit: S, noteKey: 'spec.note.holdPrime' }),
    item({ labelKey: 'spec.holdGrace', op: 'lte', value: roundFor(HOLD_GRACE_MS / 1000, S), unit: S, noteKey: 'spec.note.holdGrace' }),
  ];
  if (Number.isFinite(p.straight)) {
    count.push(item({
      labelKey: 'spec.holdStraight',
      metricKey: 'metric.body',
      op: 'gte',
      value: roundFor(p.straight, DEG),
      unit: DEG,
    }));
  }
  const gate = p.gate || 'stand';
  return { count, posture: gateItems(gate), advice: [] };
}

/* ------------------------------------------------------------------ *
 * 五个手写识别器（阈值最精确，直接读它们的常量表）
 * ------------------------------------------------------------------ */

function squatSpecs() {
  const s = SQUAT;
  return {
    count: [
      item({ labelKey: 'spec.squatEnter', metricKey: 'metric.hipAboveKnee', op: 'lte', value: s.enterRatio, unit: SHIN }),
      item({ labelKey: 'spec.countLine', metricKey: 'metric.hipAboveKnee', op: 'lte', value: s.looseRatio, unit: SHIN, noteKey: 'spec.note.looseMode' }),
      item({ labelKey: 'spec.bottomLine', metricKey: 'metric.hipAboveKnee', op: 'lte', value: s.bottomRatio, unit: SHIN, noteKey: 'spec.note.squatBottom' }),
      item({ labelKey: 'spec.backLine', metricKey: 'metric.hipAboveKnee', op: 'gte', value: s.standRatio, unit: SHIN, noteKey: 'spec.note.adaptive' }),
      item({ labelKey: 'spec.wobble', metricKey: 'metric.hipAboveKnee', op: 'gt', value: s.partialRatioMax, unit: SHIN, noteKey: 'spec.note.wobble' }),
      item({ labelKey: 'spec.minRep', op: 'gte', value: roundFor(s.minRepMs / 1000, S), unit: S }),
    ],
    posture: [
      item({ labelKey: 'spec.viewFront', textKey: 'spec.text.viewFront' }),
      item({ labelKey: 'spec.startStance', metricKey: 'metric.hipAboveKnee', op: 'gte', value: s.standRatio, unit: SHIN, noteKey: 'spec.note.startStand' }),
      // 正面机位下上身不能前倾（steps.js 里深蹲站姿要领用的就是 20°）
      item({ labelKey: 'spec.leanMax', metricKey: 'metric.trunk', op: 'lte', value: 20, unit: DEG, noteKey: 'spec.note.squatLean' }),
    ],
    advice: advisoryItems('stand'),
  };
}

function lungeSpecs() {
  const L = LUNGE;
  return {
    count: [
      item({ labelKey: 'spec.lungeEnter', metricKey: 'metric.frontKnee', op: 'lte', value: roundFor(L.enterKnee, DEG), unit: DEG, noteKey: 'spec.note.lungeEnter' }),
      item({ labelKey: 'spec.countLine', metricKey: 'metric.frontKnee', op: 'lte', value: roundFor(L.looseKnee, DEG), unit: DEG, noteKey: 'spec.note.lungeCount' }),
      // 两条腿都要弯：较直的那条腿（后腿）也得弯到这个角度以内
      item({
        labelKey: 'spec.bothKnees',
        metricKey: 'metric.straighterKnee',
        op: 'lte',
        value: roundFor(L.bothBentNeeded, DEG),
        unit: DEG,
        noteKey: 'spec.note.bothKnees',
        noteParams: { v: L.bothDrop },
      }),
      item({ labelKey: 'spec.bottomLine', metricKey: 'metric.frontKnee', op: 'lte', value: roundFor(L.downKnee, DEG), unit: DEG, noteKey: 'spec.note.bottomLine' }),
      // 回程判定是「按本轮自己的幅度」算的，没有固定角度，用文字条说明
      item({ labelKey: 'spec.backLine', textKey: 'spec.text.lungeBack', noteParams: { pct: Math.round(L.recovery * 100), deg: L.minBend } }),
      item({ labelKey: 'spec.wobble', textKey: 'spec.text.lungeWobble', noteParams: { deg: L.minBend } }),
      item({ labelKey: 'spec.minRep', op: 'gte', value: roundFor(L.minRepMs / 1000, S), unit: S }),
    ],
    posture: [
      item({ labelKey: 'spec.viewSide', textKey: 'spec.text.viewSide' }),
      item({ labelKey: 'spec.startStance', metricKey: 'metric.kneeExtended', op: 'gte', value: 145, unit: DEG, noteKey: 'spec.note.startStand' }),
      item({ labelKey: 'spec.leanMax', metricKey: 'metric.trunk', op: 'lte', value: 32, unit: DEG, noteKey: 'spec.note.lean' }),
    ],
    advice: [
      item({ labelKey: 'spec.adviceBackKnee', metricKey: 'metric.backKneeDrop', op: 'lte', value: roundFor(L.backKneeDrop, SHIN), unit: SHIN, noteKey: 'spec.note.adviceOnly' }),
      item({ labelKey: 'spec.adviceValgus', metricKey: 'metric.valgus', op: 'lte', value: ADVISORY_LIMITS.stand.valgus, unit: TORSO, noteKey: 'spec.note.adviceOnly' }),
    ],
  };
}

function pushupSpecs() {
  const P = PUSHUP;
  return {
    count: [
      item({ labelKey: 'spec.pushupEnter', metricKey: 'metric.elbow', op: 'lte', value: roundFor(P.elbowEnter, DEG), unit: DEG, noteKey: 'spec.note.pushupEnter', noteParams: { v: P.enterDrop } }),
      item({ labelKey: 'spec.countLine', metricKey: 'metric.elbow', op: 'lte', value: roundFor(P.looseElbow, DEG), unit: DEG, noteKey: 'spec.note.looseMode' }),
      item({ labelKey: 'spec.bottomLine', metricKey: 'metric.elbow', op: 'lte', value: roundFor(P.elbowFull, DEG), unit: DEG, noteKey: 'spec.note.bottomLine' }),
      item({
        labelKey: 'spec.shoulderDrop',
        metricKey: 'metric.shoulderDrop',
        op: 'gte',
        value: roundFor(P.dropMin, TORSO),
        unit: TORSO,
        noteKey: 'spec.note.shoulderDrop',
        noteParams: { full: P.dropFull.toFixed(2), start: P.dropStart.toFixed(2) },
      }),
      item({ labelKey: 'spec.backLine', metricKey: 'metric.elbow', op: 'gte', value: roundFor(P.elbowUp - P.returnTol, DEG), unit: DEG, noteKey: 'spec.note.adaptive' }),
      item({ labelKey: 'spec.wobble', textKey: 'spec.text.pushupWobble', noteParams: { deg: P.minBend } }),
      item({ labelKey: 'spec.minRep', op: 'gte', value: roundFor(P.minRepMs / 1000, S), unit: S }),
      item({ labelKey: 'spec.giveUp', op: 'lte', value: roundFor(P.maxRepMs / 1000, S), unit: S, noteKey: 'spec.note.giveUp' }),
    ],
    posture: [
      // 俯卧撑用的是识别器自己的俯撑判据（isProne），数值取自 PUSHUP 常量，不是通用 prone 门控
      item({ labelKey: 'spec.pushupPose', metricKey: 'metric.torsoIncl', op: 'gte', value: roundFor(P.activeTorso, DEG), unit: DEG, noteKey: 'spec.note.pushupPose' }),
      item({ labelKey: 'spec.pushupPose', metricKey: 'metric.shoulderClear', op: 'gte', value: roundFor(P.activeShoulderClear, TORSO), unit: TORSO }),
      item({ labelKey: 'spec.pushupPose', metricKey: 'metric.wristClear', op: 'lte', value: roundFor(P.activeHandOnFloor, TORSO), unit: TORSO, noteKey: 'spec.note.handOnFloor' }),
      item({ labelKey: 'spec.postureKeep', metricKey: 'metric.body', op: 'gte', value: roundFor(P.bodyStraightMin, DEG), unit: DEG, noteKey: 'spec.note.bodyStraight' }),
      item({ labelKey: 'spec.viewSide', textKey: 'spec.text.viewSide' }),
    ],
    advice: advisoryItems('prone'),
  };
}

function bridgeSpecs() {
  const B = BRIDGE;
  return {
    count: [
      item({ labelKey: 'spec.bridgeDown', metricKey: 'metric.hipRise', op: 'lte', value: roundFor(B.downRise, TORSO), unit: TORSO, noteKey: 'spec.note.bridgeDown' }),
      item({ labelKey: 'spec.countLine', metricKey: 'metric.hipRise', op: 'gte', value: roundFor(B.upRise, TORSO), unit: TORSO, noteKey: 'spec.note.bridgeCount' }),
      item({ labelKey: 'spec.minRep', op: 'gte', value: roundFor(B.minRepMs / 1000, S), unit: S, noteKey: 'spec.note.bridgeTempo' }),
    ],
    posture: [
      item({ labelKey: 'spec.bridgeSupine', metricKey: 'metric.trunk', op: 'gte', value: roundFor(B.supineTorso, DEG), unit: DEG }),
      item({ labelKey: 'spec.bridgeSupine', metricKey: 'metric.knee', op: 'range', value: roundFor(B.kneeMin, DEG), value2: roundFor(B.kneeMax, DEG), unit: DEG, noteKey: 'spec.note.bridgeKnee' }),
      item({ labelKey: 'spec.bridgeSupine', metricKey: 'metric.shoulderClear', op: 'lte', value: roundFor(B.shoulderClearMax, TORSO), unit: TORSO, noteKey: 'spec.note.shoulderOnFloor' }),
      item({ labelKey: 'spec.bridgeSupine', metricKey: 'metric.kneeClear', op: 'gte', value: roundFor(B.kneeClearMin, TORSO), unit: TORSO }),
      item({ labelKey: 'spec.viewSide', textKey: 'spec.text.viewSide' }),
    ],
    advice: [],
  };
}

function plankSpecs() {
  const K = PLANK;
  return {
    count: [
      item({ labelKey: 'spec.holdPrime', op: 'gte', value: roundFor(HOLD_PRIME_MS / 1000, S), unit: S, noteKey: 'spec.note.holdPrime' }),
      item({ labelKey: 'spec.holdGrace', op: 'lte', value: roundFor(HOLD_GRACE_MS / 1000, S), unit: S, noteKey: 'spec.note.holdGrace' }),
    ],
    posture: [
      item({ labelKey: 'spec.plankHard', metricKey: 'metric.trunk', op: 'gte', value: roundFor(K.torsoIncl, DEG), unit: DEG, noteKey: 'spec.note.plankHard' }),
      item({ labelKey: 'spec.plankHard', metricKey: 'metric.shoulderClear', op: 'gte', value: roundFor(K.shoulderClearMin, TORSO), unit: TORSO }),
      item({ labelKey: 'spec.plankHard', metricKey: 'metric.wristClear', op: 'lte', value: roundFor(K.handOnFloorMax, TORSO), unit: TORSO, noteKey: 'spec.note.handOnFloor' }),
      item({ labelKey: 'spec.viewSide', textKey: 'spec.text.viewSide' }),
    ],
    advice: [
      item({ labelKey: 'spec.plankSoft', metricKey: 'metric.body', op: 'gte', value: roundFor(K.bodyStraight, DEG), unit: DEG, noteKey: 'spec.note.plankSoft' }),
      item({ labelKey: 'spec.adviceHip', metricKey: 'metric.hipLineDevAbs', op: 'lte', value: roundFor(K.hipDevMax, TORSO), unit: TORSO, noteKey: 'spec.note.adviceOnly' }),
      item({ labelKey: 'spec.plankKnee', metricKey: 'metric.kneeClear', op: 'gte', value: roundFor(K.kneeClearMin, TORSO), unit: TORSO, noteKey: 'spec.note.adviceOnly' }),
    ],
  };
}

/* ------------------------------------------------------------------ *
 * 姿态提醒（只出声纠正，不拦计数）
 * ------------------------------------------------------------------ */

function advisoryItems(gateName) {
  const a = ADVISORY_LIMITS[gateName];
  if (!a) return [];
  const out = [];
  if (Number.isFinite(a.bodyStraight)) {
    out.push(item({ labelKey: 'spec.adviceStraight', metricKey: 'metric.body', op: 'gte', value: roundFor(a.bodyStraight, DEG), unit: DEG, noteKey: 'spec.note.adviceOnly' }));
  }
  if (Number.isFinite(a.hipLineDev)) {
    out.push(item({ labelKey: 'spec.adviceHip', metricKey: 'metric.hipLineDevAbs', op: 'lte', value: roundFor(a.hipLineDev, TORSO), unit: TORSO, noteKey: 'spec.note.adviceOnly' }));
  }
  if (Number.isFinite(a.valgus)) {
    out.push(item({ labelKey: 'spec.adviceValgus', metricKey: 'metric.valgus', op: 'lte', value: roundFor(a.valgus, TORSO), unit: TORSO, noteKey: 'spec.note.adviceOnly' }));
  }
  if (Number.isFinite(a.trunkLean)) {
    out.push(item({ labelKey: 'spec.adviceLean', metricKey: 'metric.trunk', op: 'lte', value: roundFor(a.trunkLean, DEG), unit: DEG, noteKey: 'spec.note.adviceOnly' }));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

const BUILDERS = {
  squat: squatSpecs,
  lunge: lungeSpecs,
  pushup: pushupSpecs,
  bridge: bridgeSpecs,
  plank: plankSpecs,
};

/**
 * 某个动作的计次技术指标。
 *
 * 返回 { id, engine, groups: [{ titleKey, items: [...] }] }：
 *   spec.group.count   计次判据（做到什么程度算一次）
 *   spec.group.posture 姿势要求（不满足就不进入判定）
 *   spec.group.advice  姿态提醒（只出声纠正，不拦计数）
 */
export function exerciseSpecs(id) {
  const meta = EXERCISE_MAP[id];
  if (!meta) return { id, engine: null, groups: [] };
  let parts;
  if (BUILDERS[id]) parts = BUILDERS[id]();
  else if (meta.engine === 'alt') parts = altSpecs(meta);
  else if (meta.engine === 'twist') parts = twistSpecs(meta);
  else if (meta.engine === 'sequence') parts = sequenceSpecs(meta);
  else if (meta.engine === 'hold') parts = holdSpecs(meta);
  else parts = bendSpecs(meta);
  const groups = [
    { titleKey: 'spec.group.count', items: parts.count || [] },
    { titleKey: 'spec.group.posture', items: parts.posture || [] },
    { titleKey: 'spec.group.advice', items: parts.advice || [] },
  ].filter((g) => g.items.length > 0);
  return { id, engine: meta.engine, groups };
}

/** 面板里出现过的全部 i18n 键（测试用：每种语言都必须有） */
export function specKeys(id) {
  const out = new Set();
  for (const g of exerciseSpecs(id).groups) {
    out.add(g.titleKey);
    for (const it of g.items) {
      for (const k of ['labelKey', 'metricKey', 'noteKey', 'textKey']) {
        if (it[k]) out.add(it[k]);
      }
    }
  }
  return [...out];
}

/* ------------------------------------------------------------------ *
 * 判定进度条：把判据按「识别顺序」摊成几步，画面上一格一格点亮
 * ------------------------------------------------------------------ */

/**
 * 判据里的 metricKey → 当前帧（必要时结合识别器内部状态）里的数值。
 *
 * 进度条靠它逐帧判断「这一步过了没有」。同一个表也用于测试，
 * 保证画面上点亮的那一格和识别器真正判定的是同一个量。
 */
export const SPEC_METRICS = {
  knee: (f) => f.kneeAngle,
  kneeBent: (f) => f.kneeBent,
  kneeExtended: (f) => f.kneeExtended,
  elbow: (f) => f.elbowAngle,
  hip: (f) => f.hipAngle,
  ankle: (f) => f.ankleAngle,
  body: (f) => f.bodyStraight,
  trunk: (f) => f.torsoIncl,
  torsoIncl: (f) => f.torsoIncl,
  shoulderClear: (f) => f.shoulderClear,
  kneeClear: (f) => f.kneeClear,
  hipClear: (f) => f.hipClear,
  wristClear: (f) => f.wristClearMin,
  wristClearMin: (f) => f.wristClearMin,
  hipRise: (f) => f.hipRise,
  hipAboveKnee: (f) => f.hipAboveKnee,
  armRaised: (f) => f.armRaised,
  kneeSpread: (f) => f.kneeSpread,
  ankleSpread: (f) => f.ankleSpread,
  hipLineDevAbs: (f) => Math.abs(f.hipLineDev),
  valgus: (f) => f.valgus,
  // 识别器内部状态（不是当帧指标）：跳跃离地高度、俯卧撑的肩膀下沉量
  lift: (f, det) => det?.lift,
  shoulderDrop: (f, det) => det?.drop,
  // 左右两条腿各自的膝角（箭步蹲用）
  frontKnee: (f) => Math.min(...sideValues(f, 'knee')),
  straighterKnee: (f) => Math.max(...sideValues(f, 'knee')),
  // 左右交替类：正在做的那一侧 / 另一侧
  oneSide: (f, det) => (det?.cmp === 'gt' ? Math.max(...sideValues(f, det?.metricName)) : Math.min(...sideValues(f, det?.metricName))),
  otherSide: (f, det) => (det?.cmp === 'gt' ? Math.min(...sideValues(f, det?.metricName)) : Math.max(...sideValues(f, det?.metricName))),
};

function sideValues(f, metric) {
  const read = SIDE_METRICS[metric] || SIDE_METRICS.knee;
  return ['L', 'R'].map((s) => read(f, s)).filter(Number.isFinite);
}

/** 判据行能不能实时判断（时间类、纯文字类不算） */
const isLiveItem = (it) => !!it && !!it.metricKey && !!SPEC_METRICS[it.metricKey.replace('metric.', '')]
  && Number.isFinite(it.value) && it.op !== undefined;

/**
 * 不进进度条的条目：
 *   - 收尾条件（回到起始位）——那是「这一轮结束」，进度条在结算时就归零了，放进去只会闪一下；
 *   - 「只是晃了一下」是**否定**条件，方向正好相反；
 *   - 时间类（最短用时 / 最长时限 / 计时宽容）在画面上没法「看着一格一格走」。
 */
const NOT_A_STAGE = new Set([
  'spec.backLine', 'spec.wobble', 'spec.minRep', 'spec.giveUp',
  'spec.holdPrime', 'spec.holdGrace', 'spec.seqWindow', 'spec.altHold', 'spec.altGap',
]);

const isStageItem = (it) => isLiveItem(it) && !NOT_A_STAGE.has(it.labelKey);

/** 判据文字用的比较：op 是「值要满足的方向」 */
export function stageHolds(stage, frame, det) {
  const read = SPEC_METRICS[stage.metric];
  if (!read || !frame || !frame.ok) return false;
  const v = read(frame, det);
  if (!Number.isFinite(v)) return false;
  const k = stage.k / 100;   // 一点的宽容：识别抖动时不至于卡在临界线上来回跳
  switch (stage.op) {
    case 'lte': return v <= stage.value + k;
    case 'gte': return v >= stage.value - k;
    case 'lt': return v < stage.value + k;
    case 'gt': return v > stage.value - k;
    case 'range': return v >= stage.value - k && v <= stage.value2 + k;
    default: return false;
  }
}

/** 进度条上一格的短标签（先按「标签 + 指标」精确匹配，再退回只按标签） */
const SHORT_LABEL = {
  // 计时类：同一个标签下有好几条姿势要求，按指标区分，进度条上才不会三格都写「俯撑」
  'spec.plankHard|trunk': 'spec.short.holdPlank',
  'spec.plankHard|shoulderClear': 'spec.short.lift',
  'spec.plankHard|wristClear': 'spec.short.hands',
  'spec.pose.sideLying|torsoIncl': 'spec.short.side',
  'spec.pose.sideLying|shoulderClear': 'spec.short.lift',
  'spec.pose.sideLying|hipClear': 'spec.short.hip',
  'spec.pose.sideLying|wristClearMin': 'spec.short.hands',
  'spec.pose.standFold|torsoIncl': 'spec.short.fold',
  'spec.pose.standFold|hipClear': 'spec.short.hip',
  'spec.pose.seatedFold|hipClear': 'spec.short.seat',
  'spec.pose.seatedFold|torsoIncl': 'spec.short.fold',
  'spec.enterLine': 'spec.short.start',
  'spec.lungeEnter': 'spec.short.start',
  'spec.pushupEnter': 'spec.short.start',
  'spec.squatEnter': 'spec.short.start',
  'spec.countLine': 'spec.short.count',
  'spec.bottomLine': 'spec.short.full',
  'spec.bothKnees': 'spec.short.both',
  'spec.flight': 'spec.short.jump',
  'spec.bridgeDown': 'spec.short.down',
  'spec.shoulderDrop': 'spec.short.drop',
  'spec.seq1': 'spec.short.stand',
  'spec.seq2': 'spec.short.crouch',
  'spec.seq3': 'spec.short.holdPlank',
  'spec.seq4': 'spec.short.jump',
  'spec.altOn': 'spec.short.work',
  'spec.altOff': 'spec.short.rest',
  'spec.plankHard': 'spec.short.holdPlank',
  'spec.plankSoft': 'spec.short.line',
  'spec.plankKnee': 'spec.short.knee',
  'spec.holdPrime': 'spec.short.holdTime',
  'spec.startStance': 'spec.short.stance',
  'spec.viewFront': 'spec.short.stance',
  'spec.viewSide': 'spec.short.stance',
  'spec.pose.stand': 'spec.short.stand',
  'spec.pose.standWide': 'spec.short.stand',
  'spec.pose.prone': 'spec.short.prone',
  'spec.pose.supine': 'spec.short.supine',
  'spec.pose.supineLow': 'spec.short.supine',
  'spec.pose.sideLying': 'spec.short.side',
  'spec.pose.standFold': 'spec.short.fold',
  'spec.pose.seatedFold': 'spec.short.fold',
  'spec.bridgeSupine': 'spec.short.supine',
  'spec.postureKeep': 'spec.short.pose',
  'spec.pushupPose': 'spec.short.prone',
};

const STAGE_TOLERANCE = { deg: 2, torso: 0.03, shin: 0.05, lift: 0.01, s: 0.05, count: 0.5 };

function toStage(it, extra = {}) {
  const metric = it.metricKey.replace('metric.', '');
  return {
    shortKey: SHORT_LABEL[`${it.labelKey}|${metric}`] || SHORT_LABEL[it.labelKey] || 'spec.short.step',
    metric,
    op: it.op,
    value: it.value,
    value2: it.value2,
    unit: it.unit,
    k: STAGE_TOLERANCE[it.unit] ?? 0.02,
    item: it,
    ...extra,
  };
}

/**
 * 某个动作的判定进度条阶段。
 *
 * 顺序 = 识别器真正的判定顺序：先「站/趴到位」（姿势门控），
 * 再依次是 开始这一轮 → 计入一次 → 双腿/离地等附加条件 → 深度到位。
 * 每一格都带**真实阈值**，用户在外面就能看到「差在哪一格」。
 */
export function specStages(id) {
  const meta = EXERCISE_MAP[id];
  const { groups } = exerciseSpecs(id);
  const count = groups.find((g) => g.titleKey === 'spec.group.count');
  const posture = groups.find((g) => g.titleKey === 'spec.group.posture');
  const stages = [];

  // ① 姿势要求：计人类的动作只要第一条（站直 / 俯撑 / 仰卧…）；
  //    计时类动作没有「往复」过程，姿势的每一条就是一个台阶（撑起来 → 身体水平 → 手贴地），都收进来。
  const poseItems = (posture?.items || []).filter(isLiveItem);
  const isHold = meta?.kind === 'hold';
  const poseTake = isHold ? poseItems.slice(0, 4) : poseItems.slice(0, 1);
  for (const it of poseTake) stages.push(toStage(it, { pose: true }));

  // ② 计次判据里能实时判断的条目，按识别器检查顺序
  for (const it of count?.items || []) {
    if (!isStageItem(it)) continue;
    stages.push(toStage(it));
  }

  // 去重（同一格指标 + 同一阈值只留一条），并限制长度，画面上别太挤
  const seen = new Set();
  const out = [];
  for (const s of stages) {
    const sig = `${s.metric}|${s.op}|${s.value}|${s.value2 ?? ''}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(s);
  }
  return out.slice(0, 6);
}

/** 进度条每一格的显示文字（短标签 + 判据），调试与测试都用它 */
export function stageText(stage) {
  return {
    short: t(stage.shortKey),
    cond: specCondition(stage.item),
  };
}

/* ------------------------------------------------------------------ *
 * 渲染文案（app.js 用它拼界面，测试也用它核对最终显示的文字）
 * ------------------------------------------------------------------ */

/** 比较符（数学符号，各语言通用） */
export const SPEC_OP = {
  lte: '≤', gte: '≥', lt: '<', gt: '>',
};

/** 指标值 + 单位后缀（后缀走词条；角度和倍数直接贴在一起，时间类加一个空格） */
export function specValueText(v, unit) {
  const key = `spec.unit.${unit}`;
  const suffix = t(key);
  const known = suffix !== key;
  const body = unit === 'deg' || unit === 'count' ? String(Math.round(v)) : String(v);
  const glue = known && unit === 's' ? ' ' : '';
  return `${body}${glue}${known ? suffix : ''}`;
}

/** 一行指标的「判据」文本，例如「前膝屈角 ≤ 152°」 */
export function specCondition(it) {
  if (it.textKey) return t(it.textKey, it.noteParams || null);
  if (!it.op) return '';
  const metric = it.metricKey ? `${t(it.metricKey)} ` : '';
  if (it.op === 'range') {
    // 区间只写一次单位：「30°–148°」
    const key = `spec.unit.${it.unit}`;
    const suffix = t(key);
    const unit = suffix === key ? '' : suffix;
    return `${metric}${Math.round(it.value)}${unit}–${Math.round(it.value2)}${unit}`;
  }
  return `${metric}${SPEC_OP[it.op] || ''} ${specValueText(it.value, it.unit)}`;
}

/** 某个动作的全部指标行（渲染好的文字，调试与测试都好用） */
export function specTextRows(id) {
  const rows = [];
  for (const g of exerciseSpecs(id).groups) {
    for (const it of g.items) {
      rows.push({
        group: t(g.titleKey),
        name: t(it.labelKey),
        cond: specCondition(it),
        note: it.noteKey ? t(it.noteKey, it.noteParams || null) : '',
      });
    }
  }
  return rows;
}

export { HORIZONTAL_TILT };
