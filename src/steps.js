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
 * 所以同一套判定逻辑可以直接输出中文 / 英文。
 *
 * perCycle: true   → 每完成一次动作，步骤清单重置（可以反复得分）
 * perCycle: false  → 整组只算一次（主要用于计时类动作的里程碑）
 */

import { LM } from './geometry.js';
import { EXERCISE_MAP as CATALOG_MAP } from './catalog.js';

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

/**
 * 深蹲（正面模式）共用的判定阈值 —— 识别状态机与计分步骤必须用同一套数字。
 * 单位是「髋比膝高多少 / 小腿长」：站直 ≈ 1.0，蹲到大腿水平 ≈ 0，蹲过水平 < 0。
 *
 * 换算：hipAboveKnee ≈ sin(大腿与地面的夹角) × (大腿长 / 小腿长)，
 * 腿长比例接近 1 时可以近似当成 sin：
 *   站直 90° → 1.0 ｜ 大腿 60° → 0.87 ｜ 45° → 0.71 ｜ 30° → 0.50 ｜ 15° → 0.26 ｜ 水平 0° → 0
 */
export const SQUAT_FRONT = {
  standRatio: 0.86,      // ≥ 此值算站直（大腿离水平 59° 以上）
  enterRatio: 0.78,      // ≤ 此值算开始下蹲（原来 0.72，早点认出来）
  bottomRatio: 0.40,     // ≤ 此值算蹲到（原来 0.25，要求大腿接近水平太严；0.40 ≈ 大腿离水平 24°）
  looseRatio: 0.62,      // 计次门槛（唯一的宽松档，没有严格模式；原来 0.45，半蹲也算一次）
  partialRatioMax: 0.74, // 低于此高度才算“一次尝试”，否则算抖动（原来 0.62）
  minRepMs: 480,         // 一次有效深蹲的最短用时（原来 620）
};

/** 下蹲进度：0% = 站直，100% = 蹲到大腿水平 */
export function squatDepthPct(hipAboveKnee) {
  const r = Number.isFinite(hipAboveKnee) ? hipAboveKnee : SQUAT_FRONT.standRatio;
  return Math.max(0, Math.min(100, Math.round(((SQUAT_FRONT.standRatio - r) / SQUAT_FRONT.standRatio) * 100)));
}

/**
 * 站姿类要领没达成时，逐条说明卡在哪一项。
 * wantView：该动作要求的机位（深蹲要正面，其余要侧面）
 */
function stanceWhy(f, exId, wantView) {
  if (f.view !== wantView) return H(`steps.${exId}.stance.view`);
  if (!f.bodyVisible) return H(`steps.${exId}.stance.body`);
  if (f.trunkLean >= (wantView === 'front' ? 20 : 32)) return H(`steps.${exId}.stance.lean`);
  if (wantView === 'front') {
    if (f.hipAboveKnee <= SQUAT_FRONT.standRatio) return H(`steps.${exId}.stance.knee`);
  } else if (f.kneeExtended <= 150) {    return H(`steps.${exId}.stance.knee`);
  }
  return H(`steps.${exId}.stance.tune`);
}

/* ---------------- 各动作的计分步骤 ---------------- */

export const STEP_PLANS = {
  /* ---------------- 深蹲（正面模式） ---------------- */
  squat: {
    perCycle: true,
    repBonus: 6,
    steps: [
      {
        id: 'stance',
        labelKey: 'steps.squat.stance.label',
        points: 4,
        // 深蹲要求正对镜头：正面才能看清蹲的深度与膝盖内扣
        check: (f) => f.view === 'front' && f.bodyVisible && f.trunkLean < 20
          && f.hipAboveKnee > SQUAT_FRONT.standRatio,
        hint: (f) => stanceWhy(f, 'squat', 'front'),
      },
      {
        id: 'hinge',
        labelKey: 'steps.squat.hinge.label',
        points: 6,
        check: (f) => f.hipAboveKnee <= SQUAT_FRONT.enterRatio,
        hint: (f) => (f.hipAboveKnee > SQUAT_FRONT.enterRatio ? H('steps.squat.hinge.hint') : null),
      },
      {
        id: 'descend',
        labelKey: 'steps.squat.descend.label',
        points: 7,
        check: (f) => f.hipAboveKnee <= 0.50,
        hint: (f) => (f.hipAboveKnee > 0.50 ? H('steps.squat.descend.hint') : null),
      },
      {
        id: 'parallel',
        labelKey: 'steps.squat.parallel.label',
        points: 14,
        check: (f) => f.hipAboveKnee <= SQUAT_FRONT.bottomRatio,
        hint: (f) => H('steps.squat.parallel.hint', { pct: squatDepthPct(f.hipAboveKnee) }),
      },
      {
        id: 'stand',
        labelKey: 'steps.squat.stand.label',
        points: 8,
        // 比状态机的“回到站姿”（standRatio）略松，保证这一步能在本次循环结算前拿到分
        check: (f, d) => d.cycleDescended && f.hipAboveKnee >= 0.80,
        hint: (f) => (f.hipAboveKnee < 0.80 ? H('steps.squat.stand.hint') : null),
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
        hint: (f) => stanceWhy(f, 'lunge', 'side'),
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
        // 与识别器同一套放宽口径：撑住了、大致成一条线就给分
        check: (f) => prone(f) && straight(f, 150) && aligned(f, 0.18),
        hint: (f) => {
          if (f.torsoIncl <= 32) return H('steps.pushup.setup.pose');
          if (f.wristClear >= 0.62) return H('steps.pushup.setup.hands');
          if (!straight(f, 150)) return H('steps.pushup.setup.straight');
          return H('steps.pushup.setup.tune');
        },
      },
      {
        id: 'lower',
        labelKey: 'steps.pushup.lower.label',
        points: 7,
        check: (f) => f.elbowAngle <= 138 && straight(f, 138),
        hint: (f) => (f.elbowAngle > 138 ? H('steps.pushup.lower.hint') : null),
      },
      {
        id: 'depth',
        labelKey: 'steps.pushup.depth.label',
        points: 14,
        // 放宽到 118°（原来 105°）：用户反馈「俯卧撑最后一个关键帧太难、做不到位」；
        // 识别器的满分深度线也一起放宽到了 128°
        check: (f) => f.elbowAngle <= 118 && straight(f, 138),
        hint: (f) => (f.elbowAngle > 118 ? H('steps.pushup.depth.hint', { deg: Math.round(f.elbowAngle) }) : null),
      },
      {
        id: 'press',
        labelKey: 'steps.pushup.press.label',
        points: 8,
        // 「推起还原」这一步在**识别器判定这一轮完成的那一刻**就该给分，
        // 所以直接调识别器自己的 `armsBack()`（它已经跟着用户自己的幅度自适应了）。
        // ⚠️ 必须和识别器**同一个条件**：以前这里写的是 `肘角 ≥ backLine − 2`，
        // 而识别器还能靠「肩膀抬回顶位」那一路提前退出，于是这些轮的这一步与整轮满分
        // 都拿不到（实测 8 次只有 1 次拿到满轮奖励）。
        check: (f, d) => d.cycleLowered
          && (typeof d.armsBack === 'function' ? d.armsBack(f)
            : f.elbowAngle >= (Number.isFinite(d.backLine) ? d.backLine - 2 : 142)),
        hint: (f) => (f.elbowAngle < 138 ? H('steps.pushup.press.hint') : null),
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
        // 高度法 或 **角度法**（肩-髋-膝 ≥150°）：用户实测「髋到 170° 就是顶点」，
        // 只用高度会让「肩也跟着抬」的人永远拿不到这一步的分
        check: (f) => f.hipRise > 0.15 || f.hipAngle >= 150,
        hint: (f) => ((f.hipRise <= 0.15 && !(f.hipAngle >= 150)) ? H('steps.bridge.lift.hint') : null),
      },
      {
        id: 'top',
        labelKey: 'steps.bridge.top.label',
        points: 14,
        check: (f) => f.hipRise > 0.35 || f.hipAngle >= 165,
        hint: (f) => ((f.hipRise <= 0.35 && !(f.hipAngle >= 165)) ? H('steps.bridge.top.hint') : null),
      },
      {
        id: 'lower',
        labelKey: 'steps.bridge.lower.label',
        points: 8,
        // 用识别器自己的「落回地面」判定（跟着用户自己的最低点走），而不是写死 0.15 ——
        // 否则最低点偏高的人「第三个关键帧」永远拿不到分。
        // 这里直接看**当前这一帧**的高度：它和识别器计次用的是同一个条件，
        // 所以「落回」这一步能和计次、和整轮满分奖励落在同一帧（否则奖励会晚一帧、拿不到）
        check: (f, d) => d.wasAtTop === true && f.hipRise <= (d.bottomLine ?? 0.15),
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
        // 与识别器同一套「放宽」口径：撑起来了就给分 —— **角度优先**（肩关节角，不看地面线），
        // 老的地面线判据（肩离地 + 手离地）保留成替代路径。用户反馈「手离地 ≤0.55 太严、
        // 结果一秒都不计时」之后，这条判据跟识别器一起改了。
        check: (f) => {
          const byAngle = Number.isFinite(f.shoulderAngle)
            && f.shoulderAngle >= 45 && f.shoulderAngle <= 135;
          const byGround = f.shoulderClear > 0.16 && f.wristClear < 0.42;
          return (byAngle || byGround) && (f.elbowAngle < 132 || f.elbowAngle > 140);
        },
        hint: (f) => {
          if (f.torsoIncl <= 38) return H('steps.plank.setup.pose');
          if (Number.isFinite(f.shoulderAngle) && f.shoulderAngle < 45) return H('steps.plank.setup.lift');
          if (f.shoulderClear <= 0.16) return H('steps.plank.setup.lift');
          if (f.wristClear >= 0.42) return H('steps.plank.setup.hands');
          return H('steps.plank.setup.elbow');
        },
      },
      {
        id: 'align',
        labelKey: 'steps.plank.align.label',
        points: 12,
        check: (f) => straight(f, 148) && aligned(f, 0.18),
        hint: (f) => {
          if (f.hipLineDev > 0.18) return H('steps.plank.align.sag');
          if (f.hipLineDev < -0.18) return H('steps.plank.align.pike');
          return H('steps.plank.align.tune');
        },
      },
      { id: 'hold3', labelKey: 'steps.plank.hold3.label', points: 10, check: (f, d) => d.holdMs >= 3000 },
      { id: 'hold10', labelKey: 'steps.plank.hold10.label', points: 15, check: (f, d) => d.holdMs >= 10000 },
      { id: 'hold30', labelKey: 'steps.plank.hold30.label', points: 25, check: (f, d) => d.holdMs >= 30000 },
    ],
  },

  /* ---------------- 静态臀桥（计时） ---------------- */
  /* ================================================================== *
   * 通用「族」方案：60+ 动作库用（动作多到不可能每个都手写一套步骤）
   *
   * 判定只依赖通用引擎暴露的字段：
   *   d.gateOk    姿势门控是否满足（人处在应有的姿势里）
   *   d.progress  当前进度 0=起始 1=到位
   *   d.peak      本轮达到过的最大进度
   *   d.validReps / d.holdMs / d.idx / d.flightSeen
   * ================================================================== */

  /* 站姿屈伸（深蹲/提踵/硬拉/箭步蹲的各种变体） */
  repStand: {
    perCycle: true,
    repBonus: 6,
    steps: [
      {
        id: 'stance',
        labelKey: 'steps.repStand.stance.label',
        points: 4,
        check: (f, d) => d.gateOk && f.kneeExtended > 135,
        hint: () => H('steps.repStand.stance.hint'),
      },
      {
        id: 'lower',
        labelKey: 'steps.repStand.lower.label',
        points: 7,
        check: (f, d) => d.progress >= 0.35,
        hint: () => H('steps.repStand.lower.hint'),
      },
      {
        id: 'bottom',
        labelKey: 'steps.repStand.bottom.label',
        points: 14,
        check: (f, d) => d.progress >= 0.80,
        hint: () => H('steps.repStand.bottom.hint'),
      },
      {
        id: 'up',
        labelKey: 'steps.repStand.up.label',
        points: 8,
        check: (f, d) => d.peak >= 0.5 && d.progress <= 0.30,
        hint: () => H('steps.repStand.up.hint'),
      },
    ],
  },

  /* 开合跳：双脚打开 / 并拢算一轮（正对镜头，用双膝横向距离量开合） */
  jumpingJack: {
    perCycle: true,
    repBonus: 6,
    steps: [
      {
        id: 'stance',
        labelKey: 'steps.jumpingJack.stance.label',
        points: 4,
        // 「并拢站好」用引擎自己的进度判断：progress ≈ 0 就是站在自己最窄的站距上
        check: (f, d) => d.gateOk && d.progress <= 0.25,
        hint: () => H('steps.jumpingJack.stance.hint'),
      },
      {
        id: 'open',
        labelKey: 'steps.jumpingJack.open.label',
        points: 7,
        check: (f, d) => d.progress >= 0.35,
        hint: () => H('steps.jumpingJack.open.hint'),
      },
      {
        id: 'wide',
        labelKey: 'steps.jumpingJack.wide.label',
        points: 14,
        check: (f, d) => d.progress >= 0.80,
        hint: () => H('steps.jumpingJack.wide.hint'),
      },
      {
        id: 'close',
        labelKey: 'steps.jumpingJack.close.label',
        points: 8,
        // 收回这一格要**在「这一轮结束」之前**就判到：识别器收轮的回位线是 0.25，
        // 而要领判定用的是上一帧的进度，所以门槛要留出余量（0.45），否则永远差一点点、拿不到整轮满分
        check: (f, d) => d.peak >= 0.5 && d.progress <= 0.45,
        hint: () => H('steps.jumpingJack.close.hint'),
      },
    ],
  },

  /* 仰卧抬起（卷腹/抬腿/臀桥/龙旗） */
  repSupine: {
    perCycle: true,
    repBonus: 6,
    steps: [
      {
        id: 'setup',
        labelKey: 'steps.repSupine.setup.label',
        points: 4,
        check: (f, d) => d.gateOk,
        hint: () => H('steps.repSupine.setup.hint'),
      },
      {
        id: 'engage',
        labelKey: 'steps.repSupine.engage.label',
        points: 7,
        check: (f, d) => d.progress >= 0.35,
        hint: () => H('steps.repSupine.engage.hint'),
      },
      {
        id: 'top',
        labelKey: 'steps.repSupine.top.label',
        points: 14,
        check: (f, d) => d.progress >= 0.80,
        hint: () => H('steps.repSupine.top.hint'),
      },
      {
        id: 'lower',
        labelKey: 'steps.repSupine.lower.label',
        points: 8,
        check: (f, d) => d.peak >= 0.5 && d.progress <= 0.30,
        hint: () => H('steps.repSupine.lower.hint'),
      },
    ],
  },

  /* 左右交替（登山者/自行车卷腹/死虫式/鸟狗式） */
  repAlt: {
    perCycle: true,
    repBonus: 6,
    steps: [
      {
        id: 'setup',
        labelKey: 'steps.repAlt.setup.label',
        points: 5,
        check: (f, d) => d.gateOk,
        hint: () => H('steps.repAlt.setup.hint'),
      },
      {
        id: 'first',
        labelKey: 'steps.repAlt.first.label',
        points: 10,
        check: (f, d) => d.validReps >= 1,
        hint: () => H('steps.repAlt.first.hint'),
      },
      {
        id: 'switch',
        labelKey: 'steps.repAlt.switch.label',
        points: 10,
        check: (f, d) => d.validReps >= 2 && d.lastSide !== null,
        hint: () => H('steps.repAlt.switch.hint'),
      },
      {
        id: 'rhythm',
        labelKey: 'steps.repAlt.rhythm.label',
        points: 12,
        check: (f, d) => d.validReps >= 4,
        hint: () => H('steps.repAlt.rhythm.hint'),
      },
    ],
  },

  /* 站立左右交替（勾腿跳这类「站着原地交替」的动作）—— 判据同样是左右交替，
     但口令、要领、提示都要说「站着」的事，不能复用躺/趴那一套文案 */
  standAlt: {
    perCycle: true,
    repBonus: 6,
    steps: [
      {
        id: 'setup',
        labelKey: 'steps.standAlt.setup.label',
        points: 5,
        check: (f, d) => d.gateOk,
        hint: () => H('steps.standAlt.setup.hint'),
      },
      {
        id: 'first',
        labelKey: 'steps.standAlt.first.label',
        points: 10,
        check: (f, d) => d.validReps >= 1,
        hint: () => H('steps.standAlt.first.hint'),
      },
      {
        id: 'switch',
        labelKey: 'steps.standAlt.switch.label',
        points: 10,
        check: (f, d) => d.validReps >= 2 && d.lastSide !== null,
        hint: () => H('steps.standAlt.switch.hint'),
      },
      {
        id: 'rhythm',
        labelKey: 'steps.standAlt.rhythm.label',
        points: 12,
        check: (f, d) => d.validReps >= 4,
        hint: () => H('steps.standAlt.rhythm.hint'),
      },
    ],
  },

  /* 左右转体（俄罗斯转体） */

  /* 多段动作（波比跳这类一整套） */
  sequence: {
    perCycle: true,
    repBonus: 8,
    steps: [
      {
        id: 'setup',
        labelKey: 'steps.sequence.setup.label',
        points: 5,
        check: (f, d) => d.gateOk,
        hint: () => H('steps.sequence.setup.hint'),
      },
      {
        id: 'down',
        labelKey: 'steps.sequence.down.label',
        points: 8,
        check: (f, d) => d.idx >= 2,
        hint: () => H('steps.sequence.down.hint'),
      },
      {
        id: 'middle',
        labelKey: 'steps.sequence.middle.label',
        points: 10,
        check: (f, d) => d.idx >= 3,
        hint: () => H('steps.sequence.middle.hint'),
      },
      {
        id: 'finish',
        labelKey: 'steps.sequence.finish.label',
        points: 12,
        check: (f, d) => d.validReps >= 1,
        hint: () => H('steps.sequence.finish.hint'),
      },
    ],
  },

  /* 跳跃类（深蹲跳/弓步跳/跳箱/击掌俯卧撑） */
  jump: {
    perCycle: true,
    repBonus: 8,
    steps: [
      {
        id: 'stance',
        labelKey: 'steps.jump.stance.label',
        points: 4,
        check: (f, d) => d.gateOk && f.kneeExtended > 135,
        hint: () => H('steps.jump.stance.hint'),
      },
      {
        id: 'crouch',
        labelKey: 'steps.jump.crouch.label',
        points: 7,
        check: (f, d) => d.progress >= 0.35,
        hint: () => H('steps.jump.crouch.hint'),
      },
      {
        id: 'flight',
        labelKey: 'steps.jump.flight.label',
        points: 14,
        check: (f, d) => !!d.flightSeen,
        hint: () => H('steps.jump.flight.hint'),
      },
      {
        id: 'land',
        labelKey: 'steps.jump.land.label',
        points: 8,
        check: (f, d) => d.peak >= 0.5 && d.progress <= 0.30,
        hint: () => H('steps.jump.land.hint'),
      },
    ],
  },

  /* 跳箱：三格关键帧（站好 → 屈膝蓄力 → **跳过箱顶**），所以单独写一套方案 ——
     族方案 jump 的四步里「落地站稳」没有对应的关键帧（计次发生在越过箱顶那一刻，见 BOXJUMP）。
     `planKeyOf` 优先取同名方案，所以这个键用动作 id。 */
  boxJump: {
    perCycle: true,
    repBonus: 8,
    steps: [
      {
        id: 'setup',
        labelKey: 'steps.boxJump.setup.label',
        points: 5,
        check: (f, d) => d.gateOk && f.kneeExtended > 135,
        hint: () => H('steps.boxJump.setup.hint'),
      },
      {
        id: 'load',
        labelKey: 'steps.boxJump.load.label',
        points: 8,
        check: (f, d) => d.crouchPct >= 0.45,
        hint: () => H('steps.boxJump.load.hint'),
      },
      {
        id: 'clear',
        labelKey: 'steps.boxJump.clear.label',
        points: 14,
        check: (f, d) => !!d.boxCleared,
        hint: () => H('steps.boxJump.clear.hint'),
      },
      {
        id: 'land',
        labelKey: 'steps.boxJump.land.label',
        points: 6,
        /**
         * 跳过箱顶之后**屈膝缓冲落地**。
         *
         * 判定看识别器自己的「落地了没有」标记（`landed`：越过箱顶之后又回到地面）加上落地那一刻的膝角 ——
         * 膝盖绷直砸下来（> 165°）拿不到这一分。这是**要领分**，不拦计次（计次只看「跳过箱顶」）。
         */
        check: (f, d) => !!d.landed && Number.isFinite(f.kneeAngle) && f.kneeAngle <= 165,
        hint: () => H('steps.boxJump.land.hint'),
      },
    ],
  },

  /* 计时：姿势类（平板/空心/超人/熊爬/螃蟹走） */
  holdPose: {
    perCycle: false,
    repBonus: 0,
    pointsPerSecond: 1,
    steps: [
      {
        id: 'pose',
        labelKey: 'steps.holdPose.pose.label',
        points: 8,
        check: (f, d) => !!d.gateOk,
        hint: () => H('steps.holdPose.pose.hint'),
      },
      {
        id: 'align',
        labelKey: 'steps.holdPose.align.label',
        points: 12,
        check: (f, d) => !!d.gateOk && (f.bodyStraight >= 140 || f.horizontal),
        hint: () => H('steps.holdPose.align.hint'),
      },
      { id: 'hold3', labelKey: 'steps.holdPose.hold3.label', points: 10, check: (f, d) => d.holdMs >= 3000 },
      { id: 'hold10', labelKey: 'steps.holdPose.hold10.label', points: 15, check: (f, d) => d.holdMs >= 10000 },
      { id: 'hold30', labelKey: 'steps.holdPose.hold30.label', points: 20, check: (f, d) => d.holdMs >= 30000 },
    ],
  },

  /* 计时：拉伸类（进入拉伸姿势后保持） */
  stretchHold: {
    perCycle: false,
    repBonus: 0,
    pointsPerSecond: 1,
    steps: [
      {
        id: 'pose',
        labelKey: 'steps.stretchHold.pose.label',
        points: 8,
        check: (f, d) => !!d.gateOk,
        hint: () => H('steps.stretchHold.pose.hint'),
      },
      {
        id: 'settle',
        labelKey: 'steps.stretchHold.settle.label',
        points: 10,
        check: (f, d) => d.holdMs >= 1500,
        hint: () => H('steps.stretchHold.settle.hint'),
      },
      { id: 'hold10', labelKey: 'steps.stretchHold.hold10.label', points: 14, check: (f, d) => d.holdMs >= 10000 },
      { id: 'hold20', labelKey: 'steps.stretchHold.hold20.label', points: 18, check: (f, d) => d.holdMs >= 20000 },
    ],
  },
};

/**
 * 取某个动作的计分方案。
 * 动作自带 `plan` 时用族方案（60+ 动作库都是这样），
 * 最初那 6 个动作有专门写的方案，优先用它们。
 * 没传 meta 时自己从动作库里查（调用方常常只拿得到 id）。
 */
export function getStepPlan(exerciseId, meta) {
  const key = planKeyOf(exerciseId, meta);
  return key ? STEP_PLANS[key] : { steps: [], repBonus: 0, perCycle: true, pointsPerSecond: 0 };
}

/**
 * 这个动作**实际用的**计分方案键（族名，或动作自己的 id）。
 * 进度条要把每个得分项分配到关键帧上，靠的就是这个键去查映射表。
 */
export function planKeyOf(exerciseId, meta) {
  if (STEP_PLANS[exerciseId]) return exerciseId;
  const planId = (meta && meta.plan) || CATALOG_MAP[exerciseId]?.plan;
  return planId && STEP_PLANS[planId] ? planId : null;
}
