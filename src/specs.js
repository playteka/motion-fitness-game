/**
 * 每个动作的「关键帧判据与判分」。
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
import { GATE_LIMITS, SEQ_STAGE_LIMITS, ADVISORY_LIMITS, SIDE_METRICS, LEG_STRAIGHT_MIN } from './engines.js';
import { HORIZONTAL_TILT } from './metrics.js';
import { HOLD_PRIME_MS, HOLD_GRACE_MS } from './detector-base.js';
import { getStepPlan, planKeyOf } from './steps.js';
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
  const advice = advisoryItems(gate);
  // 仰卧抬腿：判据是腰腿夹角，膝盖弯着也能凑到 90° —— 所以「腿绷直」是一条**建议项**
  // （只语音提醒，不扣次数）。宽容线就是识别器真正用的那条常量，界面与判定不会各说一套。
  if (metric === 'hip' && gate === 'supineLow') {
    advice.push(item({
      labelKey: 'spec.adviceLegStraight',
      metricKey: 'metric.knee',
      op: 'gte',
      value: LEG_STRAIGHT_MIN,
      unit: DEG,
      noteKey: 'spec.note.adviceOnly',
    }));
  }
  return { count, posture: gateItems(gate), advice };
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
 * 某个动作的关键帧判据与判分。
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
  // 通用引擎的「本轮进度」（0 = 起始位，1 = 到位）：最后的「回到起始位」那一格直接问它
  progress: (f, det) => det?.progress,
};

function sideValues(f, metric) {
  const read = SIDE_METRICS[metric] || SIDE_METRICS.knee;
  return ['L', 'R'].map((s) => read(f, s)).filter(Number.isFinite);
}

/**
 * 判据行能不能实时判断（时间类、纯文字类不算）。
 * 注意：进度条的「计数链」不再用黑名单过滤条目（见 specStages），
 * 而是自己挑**计次必需**的条件，保证「链上最后一格点亮 = 这一次已经计上」。
 */
const isLiveItem = (it) => !!it && !!it.metricKey && !!SPEC_METRICS[it.metricKey.replace('metric.', '')]
  && Number.isFinite(it.value) && it.op !== undefined;

const isStageItem = (it) => isLiveItem(it);

/**
 * 判据文字用的比较：op 是「值要满足的方向」。
 *
 * 一格的判定线可以来自三处（优先级从上到下）：
 *   1. `detFlag`：识别器自己的布尔状态（例如「现在是不是已经回到起始位」）；
 *   2. `valueFrom`：识别器自己的**动态判定线**（例如深蹲的 standLine、俯卧撑的 backLine，
 *      它们会跟着用户自己的幅度走）—— 这样进度条和识别器用的是同一条线，不会「界面到了、判定没到」；
 *   3. 判据里的静态数值。
 */
export function stageHolds(stage, frame, det) {
  if (!frame || !frame.ok) return false;
  if (stage.detFlag) {
    const flag = det?.[stage.detFlag];
    if (typeof flag === 'boolean') return flag;
  }
  // `also`：必须同时成立的附加条件（AND）
  if (stage.also && !holdsOne(stage.also, frame, det)) return false;
  if (holdsOne(stage, frame, det)) return true;
  // 有替代判据的格子（例如俯卧撑「肘角到位 或 肩膀已经沉到接近地面」）：任意一条成立就算过
  return !!stage.alt && holdsOne(stage.alt, frame, det);
}

function holdsOne(stage, frame, det) {
  const read = SPEC_METRICS[stage.metric];
  if (!read) return false;
  const v = read(frame, det);
  if (!Number.isFinite(v)) return false;
  // 动态判定线：优先用识别器现在的判定线（跟着用户自己幅度走）
  const dynamic = stage.valueFrom ? det?.[stage.valueFrom] : null;
  const limit = Number.isFinite(dynamic) ? dynamic : stage.value;
  const limit2 = Number.isFinite(dynamic) ? dynamic : stage.value2;
  if (!Number.isFinite(limit)) return false;
  const k = stage.k || 0;   // 宽容量（单位与指标一致：角度就是度）：识别抖动时不至于卡在临界线上来回跳
  switch (stage.op) {
    case 'lte': return v <= limit + k;
    case 'gte': return v >= limit - k;
    case 'lt': return v < limit + k;
    case 'gt': return v > limit - k;
    case 'range': return v >= limit - k && v <= limit2 + k;
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
  'spec.backLine': 'spec.short.back',
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
/**
 * 某个动作的判定进度条阶段（**计数链**）。
 *
 * 核心约定（用户明确要求：**所有关键帧都做完了就必须计次**）：
 *   这条链上的每一格都是「计一次数必须满足的条件」，顺序与识别器判定顺序一致，
 *   **最后一格就是计次发生的那一刻**：
 *     - 在「回到起始位才算一轮」的动作里（深蹲/箭步蹲/俯卧撑/通用屈伸类），最后一个格是「回到起始位」；
 *     - 臀桥是在顶点计数，所以最后一格就是「顶起」；
 *     - 左右交替类最后一格是「另一侧还原」，多段动作（波比跳）最后一格是最后一段（起跳）。
 *   因此「最后一格点亮 ⇒ 这一次已经计上了」。深度 / 满分那类**不影响计次**的判据
 *   （bottomLine 等）不进链（作为 📐 关键帧判据与判分弹窗里那一格的补充判据列出），免得它们卡住后面的格子。
 *
 * 没识别到人 / 没进入动作姿势时，第一格（门控格）不亮，整条进度条也保持灰色。
 */
export function specStages(id) {
  const meta = EXERCISE_MAP[id];
  if (!meta) return [];
  const { groups } = exerciseSpecs(id);
  const count = groups.find((g) => g.titleKey === 'spec.group.count')?.items || [];
  const posture = groups.find((g) => g.titleKey === 'spec.group.posture')?.items || [];
  const pick = (label) => count.find((it) => it.labelKey === label);
  const isHold = meta.kind === 'hold';
  const stages = [];

  // ① 门控格：进入这个动作的姿势。
  //    有真实门控的识别器直接用它的判定结果（俯卧撑 isProne → active、臀桥 isSupine → active、
  //    通用引擎 / 计时类 → gateOk）；深蹲 / 箭步蹲没有门控，退回数值判据
  //    （深蹲「髋比膝高 ≥ 0.86」、箭步蹲「双腿伸直角 ≥ 145°」）。
  const GATED_BUILTINS = new Set(['pushup', 'bridge']);
  const gateItem = posture.find(isLiveItem);
  if (gateItem) {
    const flag = isHold ? 'gateOk' : (GATED_BUILTINS.has(id) ? 'active' : (BUILDERS[id] ? null : 'gateOk'));
    stages.push(toStage(gateItem, { kind: 'gate', detFlag: flag, pose: true }));
  }

  if (isHold) {
    // 计时类没有「往复」，姿势的每一条就是一个台阶（撑起来 → 离地 → 手贴地）；
    // 最后一格 = 姿势到位、计时开始（计时类没有「计次」，所以不参与「最后一格=计次」的约定）
    for (const it of posture.filter(isLiveItem).slice(0, 4)) {
      if (it === gateItem) continue;
      stages.push(toStage(it, { kind: 'gate' }));
    }
    const list = dedupeStages(stages);
    if (list.length) list[list.length - 1].kind = 'hold';
    return list;
  }

  const pushItem = (it, extra) => { if (it && isStageItem(it)) stages.push(toStage(it, extra)); };

  if (id === 'bridge') {
    // 臀桥（用户指定的三个关键帧）：**屈腿仰卧 → 曲腿腰臀顶起 → 恢复屈腿仰卧**
    //   「顶起」用识别器自己的动态顶点线（topLine，会跟着用户自己的最低点走），
    //   「落回」用识别器自己的 atBottom —— 所以最后一格点亮的那一刻就是计次那一刻。
    pushItem(pick('spec.countLine'), { kind: 'count', valueFrom: 'topLine' });
    pushItem(pick('spec.bridgeDown'), { kind: 'finish', detFlag: 'atBottom' });
  } else if (id === 'pushup') {
    // 俯卧撑：开始 → 计次（肘角到位**或**肩膀已经沉到接近地面）→ 回到顶位（计次那一刻）
    pushItem(pick('spec.pushupEnter'), { kind: 'enter' });
    const countItem = pick('spec.countLine');
    const dropItem = pick('spec.shoulderDrop');
    if (countItem && dropItem) {
      const stage = toStage(countItem, { kind: 'count' });
      stage.alt = toStage(dropItem);
      stages.push(stage);
    } else pushItem(countItem, { kind: 'count' });
    // 「回到顶位」用识别器自己的动态线（跟着用户自己举到的最高点走），
    // 而且必须**同时**肩膀也抬回来了（识别器收尾要求的就是这两条，缺一条就会
    // 在下沉刚起步那一帧误判成「已经回到顶位」）
    pushItem(pick('spec.backLine'), {
      kind: 'finish',
      valueFrom: 'backLine',
      also: {
        metric: 'shoulderDrop',
        op: 'lte',
        value: roundFor(PUSHUP.dropStart, TORSO),
        unit: TORSO,
        k: STAGE_TOLERANCE.torso,
      },
    });
  } else if (meta.engine === 'alt') {
    // 左右交替：一侧发力 → 另一侧还原（交替成立那一刻计次）
    pushItem(pick('spec.altOn'), { kind: 'count' });
    pushItem(pick('spec.altOff'), { kind: 'finish' });
  } else if (meta.engine === 'sequence') {
    // 多段动作：按顺序每一段都要做到，最后一段完成即计次
    const seq = count.filter((it) => /^spec\.seq\d+$/.test(it.labelKey));
    seq.forEach((it, i) => pushItem(it, { kind: i === seq.length - 1 ? 'finish' : 'count' }));
  } else if (meta.engine === 'twist') {
    pushItem(pick('spec.twistAmount'), { kind: 'finish' });
  } else if (id === 'squat' || id === 'lunge') {
    // 深蹲 / 箭步蹲：站姿（门控）→ 开始 → 计次 →[双腿都要弯]→ 回到起始位（计次那一刻）
    pushItem(pick('spec.squatEnter') || pick('spec.lungeEnter'), { kind: 'enter' });
    pushItem(pick('spec.countLine'), { kind: 'count' });
    pushItem(pick('spec.bothKnees'), { kind: 'count' });
    if (id === 'squat') {
      pushItem(pick('spec.backLine'), { kind: 'finish', valueFrom: 'standLine' });
    } else {
      // 箭步蹲的「回到站姿」是动态线（按本轮幅度算），同样用识别器自己的 exitLine
      stages.push({
        shortKey: 'spec.short.back',
        metric: 'frontKnee',
        op: 'gte',
        value: 145,
        valueFrom: 'exitLine',
        unit: DEG,
        k: STAGE_TOLERANCE.deg,
        kind: 'finish',
        item: {
          labelKey: 'spec.backLine',
          metricKey: 'metric.frontKnee',
          op: 'gte',
          value: 145,
          unit: DEG,
          textKey: 'spec.text.lungeBack',
          noteParams: { pct: Math.round(LUNGE.recovery * 100), deg: LUNGE.minBend },
        },
      });
    }
  } else {
    // 通用屈伸类：姿势（门控）→ 开始 → 计次 →[要跳起来]→ 回到起始位（计次那一刻）
    pushItem(pick('spec.enterLine'), { kind: 'enter' });
    pushItem(pick('spec.countLine'), { kind: 'count' });
    pushItem(pick('spec.flight'), { kind: 'count' });
    const backP = Number.isFinite(meta.params?.backP) ? meta.params.backP : 0.16;
    // 「回到起始位」这一格用的就是**引擎自己的比例线**（`DetectorBase` 里 `progress <= backP`
    // 就是它计次的那一刻），所以：
    //   - 判定值必须是原始比例（0~1），而且**不加宽容量**（k = 0）——
    //     之前这里写成 roundFor(0.16, 'count') = 0 且 k = 6，等于「永远成立」，
    //     结果链条在「计次」那一格就整条点亮了，用户会看到「进度条满了但没计次」；
    //   - 悬停文字用弹窗里那条真实判据（同一个动作的角度/幅度，例如「膝屈角 ≥ 162°」），
    //     不再显示「幅度 ≤ 0 次」这种没意义的数字。
    const backItem = pick('spec.backLine');
    stages.push({
      shortKey: 'spec.short.back',
      metric: 'progress',
      op: 'lte',
      value: backP,
      unit: COUNT,
      k: 0,
      kind: 'finish',
      item: backItem || {
        labelKey: 'spec.backLine',
        metricKey: 'metric.progress',
        op: 'lte',
        value: roundFor(backP * 100, COUNT),
        unit: COUNT,
        noteKey: 'spec.note.adaptive',
      },
    });
  }

  // 兜底：链上必须有「计次那一刻」这一格
  if (stages.length && !stages.some((s) => s.kind === 'finish')) {
    stages[stages.length - 1].kind = 'finish';
  }
  return dedupeStages(stages);
}

/** 去重（同一格指标 + 同一阈值只留一条），并限制长度，画面上别太挤 */
/**
 * 计划步骤 → 进度条关键帧（用户要求：**把每个动作的得分分配到不同的关键帧里面**）。
 *
 * 值是这一格的短标签键（`spec.short.*` 的后半段），特殊值：
 *   `*first` / `*gate` = 第一格（姿势门控），`*last` = 最后一格（计次那一刻）。
 * 用短标签键而不是下标定位，是因为进度条会把「画得一模一样」的格子合并掉，
 * 下标会跟着变，短标签不会。
 *
 * 一族方案（repStand / repSupine / jump …）里的步骤 id 是共用的，所以一族只写一条。
 */
const STEP_STAGE = {
  squat: { stance: 'stance', hinge: 'start', descend: 'count', parallel: 'count', stand: 'back' },
  lunge: {
    stance: 'stance', split: 'start', stride: 'start', sink: 'count', backknee: 'both', return: 'back',
  },
  pushup: { setup: 'prone', lower: 'start', depth: 'count', press: 'back' },
  bridge: { setup: 'supine', lift: 'count', top: 'count', lower: 'down' },
  repStand: { stance: 'stand', lower: 'start', bottom: 'count', up: 'back' },
  jumpingJack: { stance: 'stand', open: 'start', wide: 'count', close: 'back' },
  repProne: { setup: 'prone', lower: 'start', bottom: 'count', press: 'back' },
  repSupine: { setup: 'supine', engage: 'start', top: 'count', lower: 'back' },
  repAlt: { setup: '*gate', first: 'work', switch: 'rest', rhythm: 'rest' },
  sequence: { setup: 'stand', down: 'crouch', middle: 'holdPlank', finish: 'jump' },
  jump: { stance: 'stand', crouch: 'count', flight: 'jump', land: 'back' },
  plank: { setup: 'lift', align: 'holdPlank', hold3: '*last', hold10: '*last', hold30: '*last' },
  holdPose: { pose: 'side', align: 'lift', hold3: '*last', hold10: '*last', hold30: '*last' },
  stretchHold: { pose: '*first', settle: '*last', hold10: '*last', hold20: '*last' },
};

/** 短标签键 → 第几格（找不到就退回 -1） */
function stageIndexOfToken(stages, token) {
  if (!token) return -1;
  if (token === '*last') return stages.length - 1;
  if (token === '*first') return 0;
  if (token === '*gate') {
    const i = stages.findIndex((s) => s.kind === 'gate');
    return i >= 0 ? i : 0;
  }
  const want = `spec.short.${token}`;
  const i = stages.findIndex((s) => s.shortKey === want);
  return i;
}

/**
 * 每个关键帧能拿多少分（与 `specStages(id)` 同顺序、同长度）。
 *
 * 「整轮要领全过」的奖励记在**最后一格**（计次那一刻给的），计时类的「每秒 1 分」
 * 也记在最后一格（那格的分会一直往上加）。
 */
export function stagePoints(id) {
  const stages = specStages(id);
  const plan = getStepPlan(id);
  const map = STEP_STAGE[planKeyOf(id)] || {};
  const out = stages.map(() => ({ points: 0, steps: [], bonus: 0, perSecond: 0 }));
  if (!out.length) return out;
  for (const def of plan.steps || []) {
    const idx = stageIndexOfToken(stages, map[def.id]);
    if (idx < 0) continue;
    out[idx].points += def.points;
    out[idx].steps.push(def.id);
  }
  if (plan.repBonus > 0) out[out.length - 1].bonus = plan.repBonus;
  if (plan.pointsPerSecond > 0) out[out.length - 1].perSecond = plan.pointsPerSecond;
  return out;
}

/** 步骤 id → 第几格（界面把「这一步加到的分」记到对应格子上时用） */
export function stageIndexForStep(id, stepId) {
  const stages = specStages(id);
  const map = STEP_STAGE[planKeyOf(id)] || {};
  return stageIndexOfToken(stages, map[stepId]);
}

function dedupeStages(stages) {
  const seen = new Set();
  const out = [];
  for (const s of stages) {
    const sig = `${s.metric}|${s.op}|${s.value}|${s.value2 ?? ''}|${s.kind}`;
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
