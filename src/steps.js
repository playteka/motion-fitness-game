/**
 * 动作要领 → 计分步骤。
 *
 * 设计目标：**照着要领一步一步做，就能一步一步拿分**。
 * 每个步骤是一个「可判定的条件」，满足即立刻加分，并触发音效 / 语音 / 界面打勾。
 *
 * check(frame, det) 返回 true 表示这一步达标。
 *   - frame：本帧动作指标（见 metrics.js）
 *   - det：当前识别器实例，用于读取内部状态（例如“这一轮是否已经下蹲过”）
 *
 * labelKey / hint() 返回的都是 **i18n 键**（在 src/locales/*.js 里按语言给出文案），
 * 所以同一套判定逻辑可以直接输出中文 / 英文 / 西班牙文 / 法文。
 *
 * perCycle: true   → 每完成一次动作，步骤清单重置（可以反复得分）
 * perCycle: false  → 整组只算一次（主要用于计时类动作的里程碑）
 */

import { LM } from './geometry.js';

/* ---------------- 小工具 ---------------- */

const SIDE = {
  L: { knee: LM.L_KNEE, ankle: LM.L_ANKLE, hip: LM.L_HIP },
  R: { knee: LM.R_KNEE, ankle: LM.R_ANKLE, hip: LM.R_HIP },
};

/** 某一侧小腿「离地比例」：1 ≈ 站立，0 ≈ 跪地 */
export function legDrop(f, side) {
  const I = SIDE[side];
  const k = f.points[I.knee];
  const a = f.points[I.ankle];
  const shin = Math.hypot(k.x - a.x, k.y - a.y) || 1e-6;
  return (a.y - k.y) / shin;
}

/** 后腿 = 膝盖更低的那条（箭步蹲用） */
export function backSide(f) {
  return f.points[SIDE.L.knee].y >= f.points[SIDE.R.knee].y ? 'L' : 'R';
}

/** 两脚踝的前后距离（相对躯干长） */
export function ankleSpread(f) {
  const dx = Math.abs(f.points[LM.L_ANKLE].x - f.points[LM.R_ANKLE].x);
  return dx / Math.max(1e-3, f.torsoLen);
}

/** 身体是否成一条直线（平板支撑 / 俯卧撑用） */
const straight = (f, min = 165) => Number.isFinite(f.bodyStraight) && f.bodyStraight >= min;
const aligned = (f, max = 0.13) => Math.abs(f.hipLineDev) <= max;

/** 仰卧屈膝姿势（臀桥类用） */
const supine = (f) => f.torsoIncl > 40
  && f.kneeAngle > 30 && f.kneeAngle < 142
  && f.shoulderClear < 0.40 && f.kneeClear > 0.32;

/** 俯撑姿势（俯卧撑用） */
const prone = (f) => f.torsoIncl > 35 && f.shoulderClear > 0.15 && f.wristClear < 0.55;

/** 提示构造小工具 */
const H = (key, params) => ({ key, params: params || null });

/** 站姿类要领没达成时，逐条说明卡在哪一项 */
function stanceWhy(f, exId) {
  if (f.view !== 'side') return H(`steps.${exId}.stance.side`);
  if (!f.bodyVisible) return H(`steps.${exId}.stance.body`);
  if (f.trunkLean >= 32) return H(`steps.${exId}.stance.lean`);
  if (f.kneeExtended <= 150) return H(`steps.${exId}.stance.knee`);
  return H(`steps.${exId}.stance.tune`);
}

/* ---------------- 各动作的计分步骤 ---------------- */

export const STEP_PLANS = {
  /* ---------------- 深蹲 ---------------- */
  squat: {
    perCycle: true,
    repBonus: 6,
    steps: [
      {
        id: 'stance',
        labelKey: 'steps.squat.stance.label',
        points: 4,
        // 用“更直的那条腿”判断站直，避免远侧腿被遮挡时估歪导致拿不到分
        check: (f) => f.view === 'side' && f.bodyVisible && f.trunkLean < 32 && f.kneeExtended > 150,
        hint: (f) => stanceWhy(f, 'squat'),
      },
      {
        id: 'hinge',
        labelKey: 'steps.squat.hinge.label',
        points: 6,
        check: (f) => f.kneeAngle <= 152 && f.hipAngle < 165,
        hint: (f) => (f.kneeAngle > 152 ? H('steps.squat.hinge.hint') : null),
      },
      {
        id: 'descend',
        labelKey: 'steps.squat.descend.label',
        points: 7,
        check: (f) => f.kneeAngle <= 135,
        hint: (f) => (f.kneeAngle > 135 ? H('steps.squat.descend.hint') : null),
      },
      {
        id: 'parallel',
        labelKey: 'steps.squat.parallel.label',
        points: 14,
        check: (f) => f.thighFromHoriz <= 25 || f.hipBelowKnee,
        hint: (f) => H('steps.squat.parallel.hint', { deg: Math.max(1, Math.round(f.thighFromHoriz - 25)) }),
      },
      {
        id: 'stand',
        labelKey: 'steps.squat.stand.label',
        points: 8,
        // 髋角在“快站直”那一瞬间还在恢复中，所以用较宽的髋角下限，避免漏判这一步
        check: (f, d) => d.cycleDescended && f.kneeAngle >= 150 && f.hipAngle >= 130,
        hint: (f) => (f.kneeAngle < 150 ? H('steps.squat.stand.hint') : null),
      },
    ],
  },

  /* ---------------- 箭步蹲 ---------------- */
  lunge: {
    perCycle: true,
    repBonus: 6,
    steps: [
      {
        id: 'stance',
        labelKey: 'steps.lunge.stance.label',
        points: 4,
        check: (f) => f.view === 'side' && f.bodyVisible && f.trunkLean < 32 && f.kneeExtended > 145,
        hint: (f) => stanceWhy(f, 'lunge'),
      },
      {
        id: 'split',
        labelKey: 'steps.lunge.split.label',
        points: 5,
        check: (f) => f.legsVisible && ankleSpread(f) > 0.45 && ankleSpread(f) <= 0.9,
        hint: (f) => (ankleSpread(f) <= 0.45
          ? H('steps.lunge.split.hint', { pct: Math.round(ankleSpread(f) * 100) })
          : null),
      },
      {
        id: 'stride',
        labelKey: 'steps.lunge.stride.label',
        points: 6,
        check: (f) => f.legsVisible && ankleSpread(f) > 0.9,
        hint: (f) => (ankleSpread(f) <= 0.9 ? H('steps.lunge.stride.hint') : null),
      },
      {
        id: 'sink',
        labelKey: 'steps.lunge.sink.label',
        points: 11,
        check: (f) => f.kneeBent <= 118 && f.kneeFar <= 150,
        hint: (f) => (f.kneeBent > 118 ? H('steps.lunge.sink.hint') : null),
      },
      {
        id: 'backknee',
        labelKey: 'steps.lunge.backknee.label',
        points: 14,
        check: (f) => legDrop(f, backSide(f)) <= 0.35,
        hint: (f) => (legDrop(f, backSide(f)) > 0.35 ? H('steps.lunge.backknee.hint') : null),
      },
      {
        id: 'return',
        labelKey: 'steps.lunge.return.label',
        points: 8,
        check: (f, d) => d.cycleSunk && f.kneeBent >= 145 && f.kneeFar >= 140,
        hint: (f) => (f.kneeBent < 145 ? H('steps.lunge.return.hint') : null),
      },
    ],
  },

  /* ---------------- 俯卧撑 ---------------- */
  pushup: {
    perCycle: true,
    repBonus: 6,
    steps: [
      {
        id: 'setup',
        labelKey: 'steps.pushup.setup.label',
        points: 5,
        check: (f) => prone(f) && straight(f) && aligned(f),
        hint: (f) => {
          if (f.torsoIncl <= 35) return H('steps.pushup.setup.pose');
          if (f.wristClear >= 0.55) return H('steps.pushup.setup.hands');
          if (!straight(f, 165)) return H('steps.pushup.setup.straight');
          return H('steps.pushup.setup.tune');
        },
      },
      {
        id: 'lower',
        labelKey: 'steps.pushup.lower.label',
        points: 7,
        check: (f) => f.elbowAngle <= 140 && straight(f, 146),
        hint: (f) => (f.elbowAngle > 140 ? H('steps.pushup.lower.hint') : null),
      },
      {
        id: 'depth',
        labelKey: 'steps.pushup.depth.label',
        points: 14,
        check: (f) => f.elbowAngle <= 95 && straight(f, 146),
        hint: (f) => (f.elbowAngle > 95 ? H('steps.pushup.depth.hint', { deg: Math.round(f.elbowAngle) }) : null),
      },
      {
        id: 'press',
        labelKey: 'steps.pushup.press.label',
        points: 8,
        check: (f, d) => d.cycleLowered && f.elbowAngle >= 145,
        hint: (f) => (f.elbowAngle < 145 ? H('steps.pushup.press.hint') : null),
      },
    ],
  },

  /* ---------------- 臀桥（计数） ---------------- */
  bridge: {
    perCycle: true,
    repBonus: 6,
    steps: [
      {
        id: 'setup',
        labelKey: 'steps.bridge.setup.label',
        points: 5,
        check: (f) => supine(f) && f.hipRise < 0.2,
        hint: (f) => {
          if (f.torsoIncl <= 40) return H('steps.bridge.setup.pose');
          if (f.kneeAngle >= 142 || f.kneeAngle <= 30) return H('steps.bridge.setup.knee');
          if (f.kneeClear <= 0.32) return H('steps.bridge.setup.lift');
          return H('steps.bridge.setup.tune');
        },
      },
      {
        id: 'lift',
        labelKey: 'steps.bridge.lift.label',
        points: 6,
        check: (f) => f.hipRise > 0.15,
        hint: (f) => (f.hipRise <= 0.15 ? H('steps.bridge.lift.hint') : null),
      },
      {
        id: 'top',
        labelKey: 'steps.bridge.top.label',
        points: 14,
        check: (f) => f.hipRise > 0.35,
        hint: (f) => (f.hipRise <= 0.35 ? H('steps.bridge.top.hint') : null),
      },
      {
        id: 'lower',
        labelKey: 'steps.bridge.lower.label',
        points: 8,
        check: (f, d) => d.wasAtTop && f.hipRise < 0.15,
        hint: () => H('steps.bridge.lower.hint'),
      },
    ],
  },

  /* ---------------- 平板支撑（计时） ---------------- */
  plank: {
    perCycle: false,
    repBonus: 0,
    pointsPerSecond: 1,
    steps: [
      {
        id: 'setup',
        labelKey: 'steps.plank.setup.label',
        points: 8,
        check: (f) => f.shoulderClear > 0.22 && f.wristClear < 0.32
          && (f.elbowAngle < 122 || f.elbowAngle > 148),
        hint: (f) => {
          if (f.torsoIncl <= 45) return H('steps.plank.setup.pose');
          if (f.shoulderClear <= 0.22) return H('steps.plank.setup.lift');
          if (f.wristClear >= 0.32) return H('steps.plank.setup.hands');
          return H('steps.plank.setup.elbow');
        },
      },
      {
        id: 'align',
        labelKey: 'steps.plank.align.label',
        points: 12,
        check: (f) => straight(f, 158) && aligned(f, 0.14),
        hint: (f) => {
          if (f.hipLineDev > 0.14) return H('steps.plank.align.sag');
          if (f.hipLineDev < -0.14) return H('steps.plank.align.pike');
          return H('steps.plank.align.tune');
        },
      },
      { id: 'hold3', labelKey: 'steps.plank.hold3.label', points: 10, check: (f, d) => d.holdMs >= 3000 },
      { id: 'hold10', labelKey: 'steps.plank.hold10.label', points: 15, check: (f, d) => d.holdMs >= 10000 },
      { id: 'hold30', labelKey: 'steps.plank.hold30.label', points: 25, check: (f, d) => d.holdMs >= 30000 },
    ],
  },

  /* ---------------- 静态臀桥（计时） ---------------- */
  bridgehold: {
    perCycle: false,
    repBonus: 0,
    pointsPerSecond: 1,
    steps: [
      {
        id: 'setup',
        labelKey: 'steps.bridgehold.setup.label',
        points: 6,
        check: (f) => supine(f),
        hint: (f) => (f.torsoIncl <= 40 ? H('steps.bridgehold.setup.pose') : H('steps.bridgehold.setup.knee')),
      },
      {
        id: 'lift',
        labelKey: 'steps.bridgehold.lift.label',
        points: 12,
        check: (f) => f.hipRise > 0.32,
        hint: (f) => (f.hipRise <= 0.32 ? H('steps.bridgehold.lift.hint') : null),
      },
      { id: 'hold3', labelKey: 'steps.bridgehold.hold3.label', points: 10, check: (f, d) => d.holdMs >= 3000 },
      { id: 'hold10', labelKey: 'steps.bridgehold.hold10.label', points: 15, check: (f, d) => d.holdMs >= 10000 },
      { id: 'hold20', labelKey: 'steps.bridgehold.hold20.label', points: 20, check: (f, d) => d.holdMs >= 20000 },
    ],
  },
};

export function getStepPlan(exerciseId) {
  const plan = STEP_PLANS[exerciseId];
  if (!plan) return { steps: [], repBonus: 0, perCycle: true, pointsPerSecond: 0 };
  return plan;
}
