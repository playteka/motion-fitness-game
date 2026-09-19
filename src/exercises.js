/**
 * 六个动作的识别逻辑。
 *
 * 设计要点
 *  1) 每个动作都是一个小型状态机，只在“完整、到位”的动作循环上 +1，
 *     半程动作单独统计并给出纠正提示，避免“抖一抖就算一个”。
 *  2) 全部阈值使用角度与长度比例，与身高、机位距离无关。
 *  3) 计时类动作使用“有效性门控 + 宽限期”，姿势垮掉超过宽限期才暂停计时。
 */

import { LM, dist2, clamp } from './geometry.js';
import { getStepPlan, SQUAT_FRONT } from './steps.js';
import { t, tList, hasKey } from './i18n.js';
import {
  DetectorBase, HoldDetector, setCueKeyResolver,
} from './detector-base.js';
import { EXERCISES, EXERCISE_MAP, CATEGORIES } from './catalog.js';
import { createEngineDetector } from './engines.js';

// 提示文案的兜底：动作没写专属提示时用通用提示（见 detector-base.js）
setCueKeyResolver(hasKey);

/* ------------------------------------------------------------------ *
 * 动作元数据（结构与文案）：目录在 catalog.js（60+ 动作）
 * ------------------------------------------------------------------ */

export { EXERCISES, EXERCISE_MAP };

/** 动作单位（次 / 秒），随语言变化 */
export function exerciseUnit(id) {
  const ex = EXERCISE_MAP[id];
  return ex ? t(ex.unitKey) : '';
}

/**
 * 取某个动作在当前语言下的全部文案（名称、机位提示、要领、注意事项）。
 *
 * 60+ 动作不可能每个都手写一套「要领/注意事项」，所以：
 *   姓名 / 机位 / 目标 → 每个动作都有（差异就在这几句里）
 *   要领 / 注意事项   → 动作没写就用所属「族」的模板（fam.<方案>），保证界面上永远不是空的
 */
export function localizedExercise(id) {
  const meta = EXERCISE_MAP[id];
  if (!meta) return null;
  const famKey = `fam.${meta.plan}`;
  const howtoKey = hasKey(`ex.${id}.howto`) ? `ex.${id}.howto` : `${famKey}.howto`;
  const tipsKey = hasKey(`ex.${id}.tips`) ? `ex.${id}.tips` : `${famKey}.tips`;
  return {
    ...meta,
    name: t(`ex.${id}.name`),
    cameraHint: t(`ex.${id}.cameraHint`),
    goal: t(`ex.${id}.goal`),
    unit: exerciseUnit(id),
    defaultTarget: meta.target,     // 兼容旧字段名
    judgeText: t(`judge.${meta.judge}`),
    howto: tList(howtoKey),
    tips: tList(tipsKey),
  };
}

/** 分类（带文案） */
export function localizedCategories() {
  return CATEGORIES.map((c) => ({ ...c, name: t(c.key) }));
}

/** 某个分类下的动作（带文案） */
export function localizedByCategory(catId) {
  return EXERCISES.filter((x) => x.cats.includes(catId)).map((x) => localizedExercise(x.id));
}

/* 基类（DetectorBase / HoldDetector）见 detector-base.js —— 本文件只保留专门写的动作识别器 */
const P = (f, i) => f.points[i];
const segLen = (f, a, b) => dist2(P(f, a), P(f, b));

/** 角度 → 百分比（越弯越大），用于进度条 */
function bendPct(angle, straight, bent) {
  if (!Number.isFinite(angle)) return 0;
  return clamp(((straight - angle) / (straight - bent)) * 100, 0, 100);
}

/* ------------------------------------------------------------------ *
 * 计数类：深蹲（正面模式）
 * ------------------------------------------------------------------ */

/**
 * 为什么深蹲改成「正对摄像头」：
 *
 * 深蹲的屈膝发生在**前后方向**上，而正对镜头时，这个方向正好被投影压掉。
 * 实测同一组三维姿势（见 commit 说明）：侧拍时膝角随下蹲从 172° 降到 63°，
 * 正拍时只从 178.7° 变到 177.7°，髋-膝-踝在画面里始终接近一条竖线 ——
 * **膝角在正视图里基本失效**，判不出"蹲没蹲到底"，也判不出"有没有在蹲"。
 *
 * 正面改用「髋比膝高多少 / 小腿长」：
 *   站直 ≈ 1.0，蹲到大腿水平 ≈ 0，蹲过水平 < 0
 * 竖直方向的差值在正视图里**不被压缩**，所以这个量测得很准；
 * 而且它本来就是「蹲到大腿水平」的严格定义，比膝角更直接。
 * 小腿在图中的长度在下蹲过程中基本不变，是稳定的比例尺。
 *
 * 附带好处：膝盖内扣只有正面才看得出来，这条纠错现在才真正生效。
 */
const SQUAT = SQUAT_FRONT;

class SquatDetector extends DetectorBase {
  onReset() {
    this.stage = 'up';
    this.repStartAt = 0;
    this.minRatio = 9;
    this.depthOk = false;
    this.cycleDescended = false;
  }
  onLost() { this.stage = 'up'; this.repStartAt = 0; }
  onNewCycle() { this.cycleDescended = false; }

  step(f, now) {
    this.active = true;
    this.standby = '';
    const r = f.hipAboveKnee;   // 髋比膝高多少（除以小腿长）

    // 进度条：0% = 站直，100% = 蹲到大腿水平或更低
    this.depthPct = clamp(((SQUAT.standRatio - r) / SQUAT.standRatio) * 100, 0, 100);
    if (r <= SQUAT.enterRatio) this.cycleDescended = true;

    // 实时姿势提醒（都是正面视角才能看出来的问题）
    if (f.view === 'front' && f.valgus > 0.45 && r < 0.75) {
      this.cue('valgus', null, 'warn', now);
    }
    if (f.trunkLean > 20 && r < 0.75) {
      this.cue('lateral', null, 'warn', now);
    }
    // 纠正提示提前给：要求放宽了，但提醒要更积极（还没到位就先提示怎么蹲）
    if (this.stage !== 'up' && r > 0.48 && r <= SQUAT.enterRatio) {
      this.cue('depth', null, 'warn', now, 3000);
    }

    switch (this.stage) {
      case 'up':
        if (r <= SQUAT.enterRatio) {
          this.stage = 'descending';
          this.repStartAt = now;
          this.minRatio = r;
          this.depthOk = r <= SQUAT.bottomRatio;
        }
        break;

      case 'descending':
        this.minRatio = Math.min(this.minRatio, r);
        if (r <= SQUAT.bottomRatio) {
          this.depthOk = true;
          this.stage = 'bottom';
          this.phase = 'bottom';
          this.emit({ type: 'phase', phase: 'bottom' });
        } else if (r >= SQUAT.standRatio) {
          this.finish(f, now, true);
        } else if (now - this.repStartAt > 2500) {
          this.cue('halfway', null, 'warn', now, 4000);
          this.repStartAt = now;
        }
        break;

      case 'bottom':
        this.minRatio = Math.min(this.minRatio, r);
        if (r >= SQUAT.standRatio) this.finish(f, now, false);
        break;
      default:
        break;
    }
  }

  finish(f, now, aborted) {
    const dur = now - this.repStartAt;
    const deepEnough = this.depthOk || (!this.strict && this.minRatio <= SQUAT.looseRatio);
    this.stage = 'up';
    this.phase = 'up';
    this.repStartAt = 0;

    if (aborted && this.minRatio > SQUAT.partialRatioMax) {
      // 只是晃了一下，不算一次尝试（也不重置要领清单）
      return;
    }
    if (aborted || !deepEnough) {
      this.partialReps += 1;
      this.cue(aborted ? 'depthAborted' : 'depth', null, 'warn', now, 2600);
      this.emit({ type: 'rep', valid: false, reason: 'depth', ratio: this.minRatio });
      this.nextCycle(now);
      return;
    }
    if (dur < SQUAT.minRepMs) {
      this.partialReps += 1;
      this.cue('tempo', null, 'warn', now, 3000);
      this.emit({ type: 'rep', valid: false, reason: 'tempo' });
      this.nextCycle(now);
      return;
    }
    this.validReps += 1;
    this.reps = this.validReps;
    this.cycleHadValidRep = true;
    const quality = clamp(Math.round(
      60 + (this.minRatio <= 0.05 ? 30 : this.minRatio <= 0.18 ? 22 : 12) + (dur > 1200 ? 10 : 5),
    ), 0, 100);
    this.emit({
      type: 'rep', valid: true, index: this.validReps, quality, duration: dur, ratio: this.minRatio,
    });
    this.nextCycle(now);
  }
}

/* ------------------------------------------------------------------ *
 * 计数类：箭步蹲
 * ------------------------------------------------------------------ */

const LUNGE = {
  // 判据整体放宽：看得出是箭步蹲就算一次，动作不标准交给语音提示。
  // 三档膝角：enter 开始算这一轮 → loose 宽松计数线 → down 拿标准深度分。
  standKnee: 142,     // 「回到站姿」的门槛（原来 152：跟踪噪声下很难稳定回到站直，一卡就整轮作废）
  enterKnee: 146,     // 下蹲到 146° 以内才算「开始这一轮」（比站姿晃动深，避免碎碎念）
  downKnee: 128,      // 「沉到底」阶段（拿整轮满分奖励 / 严格模式的深度）
  looseKnee: 142,     // 宽松模式：前膝弯到 142° 以内就算一次（原来靠 140，但被 aborted 拦掉了）
  // 抖动宽容：膝角必须在门槛内「持续」住才算真的开始/结束一次，
  // 否则跟踪噪声在门槛附近来回跳会造出一堆假的“半程 + 下沉不够”提醒。
  enterHoldMs: 200,
  exitHoldMs: 100,
  bothBentMax: 162,   // 两条腿都算「弯」的门槛放宽（原来 150）
  backKneeCue: 0.66,  // 后膝太高 → 提示（后膝离地高度 / 小腿长）
  backKneeDrop: 0.66, // 深度达标要求（原来 0.58，要求后膝几乎贴地太严）
  minRepMs: 450,      // 一次有效箭步蹲的最短用时（原来 750/520）
};

class LungeDetector extends DetectorBase {
  onReset() {
    this.stage = 'up';
    this.repStartAt = 0;
    this.bendSince = 0;
    this.upSince = 0;
    this.minFront = 180;
    this.minBackDrop = 9;
    this.depthOk = false;
    this.lastFrontSide = null;
    this.sameSideStreak = 0;
    this.cycleSunk = false;
  }
  onLost() {
    this.stage = 'up';
    this.repStartAt = 0;
    this.bendSince = 0;
    this.upSince = 0;
  }
  onNewCycle() { this.cycleSunk = false; }

  sideInfo(f, s) {
    const I = { L: { k: LM.L_KNEE, a: LM.L_ANKLE, h: LM.L_HIP }, R: { k: LM.R_KNEE, a: LM.R_ANKLE, h: LM.R_HIP } }[s];
    const kneeY = P(f, I.k).y;
    const ankleY = P(f, I.a).y;
    const shin = Math.max(1e-3, segLen(f, I.k, I.a));
    return {
      s,
      knee: f.perSide[s].knee,
      kneeY,
      ankleY,
      drop: (ankleY - kneeY) / shin, // 1 ≈ 站立, 0 ≈ 跪地
      vis: f.perSide[s].vis,
    };
  }

  step(f, now) {
    const L = this.sideInfo(f, 'L');
    const R = this.sideInfo(f, 'R');
    const bent = Math.min(L.knee, R.knee);
    const bothBent = Math.max(L.knee, R.knee);
    // 前腿 = 膝盖更高的那条（后膝几乎贴地）
    const front = L.kneeY <= R.kneeY ? L : R;
    const back = front === L ? R : L;

    this.depthPct = bendPct(bent, 165, 95);
    this.active = true;
    this.standby = '';
    if (bent <= 130) this.cycleSunk = true;

    if (this.stage !== 'up' && back.drop > LUNGE.backKneeCue && bent < 140) {
      this.cue('backknee', null, 'warn', now);
    }
    if (f.trunkLean > 38 && bent < 146) {
      this.cue('lean', null, 'warn', now);
    }

    const standing = bent >= LUNGE.standKnee && bothBent >= LUNGE.standKnee - 8;

    switch (this.stage) {
      case 'up':
        // 下蹲要“持续”住才算这一轮开始（滤掉单帧抖动）
        if (bent <= LUNGE.enterKnee) {
          if (!this.bendSince) this.bendSince = now;
          if (now - this.bendSince >= LUNGE.enterHoldMs) {
            this.stage = 'descending';
            this.repStartAt = this.bendSince;
            this.minFront = bent;
            this.minBackDrop = back.drop;
            this.depthOk = false;
            this.frontSide = front.s;
            this.upSince = 0;
          }
        } else {
          this.bendSince = 0;
        }
        break;

      case 'descending':
      case 'bottom': {
        this.minFront = Math.min(this.minFront, bent);
        if (front.s === this.frontSide) this.minBackDrop = Math.min(this.minBackDrop, back.drop);
        if (bothBent <= LUNGE.bothBentMax && back.drop <= LUNGE.backKneeDrop) this.depthOk = true;
        if (this.stage === 'descending' && bent <= LUNGE.downKnee && bothBent <= LUNGE.bothBentMax) {
          this.stage = 'bottom';
          this.phase = 'bottom';
          this.emit({ type: 'phase', phase: 'bottom' });
        }
        // 回到站姿也要“持续”住才算这一轮结束
        if (standing) {
          if (!this.upSince) this.upSince = now;
          if (now - this.upSince >= LUNGE.exitHoldMs) this.finish(f, now);
        } else {
          this.upSince = 0;
        }
        break;
      }
      default:
        break;
    }
  }

  finish(f, now) {
    const dur = now - this.repStartAt;
    this.stage = 'up';
    this.phase = 'up';
    this.repStartAt = 0;
    this.bendSince = 0;
    this.upSince = 0;

    // 宽松模式：前膝弯进 looseKnee 就算一次——不再要求“必须沉到底才作数”。
    // 沉得不够的，只提示“下沉不够 / 后膝再低一点”，不再把次数吃掉。
    // 严格模式：既要深度达标，又要真的沉到 downKnee 以内。
    const deepEnough = (!this.strict && this.minFront <= LUNGE.looseKnee)
      || (this.depthOk && (!this.strict || this.minFront <= LUNGE.downKnee));
    if (!deepEnough) {
      this.partialReps += 1;
      this.cue('lungeDepth', null, 'warn', now, 3000);
      this.emit({ type: 'rep', valid: false, reason: 'depth' });
      this.nextCycle(now);
      return;
    }
    if (dur < LUNGE.minRepMs) {
      this.partialReps += 1;
      this.cue('tempo', null, 'warn', now, 3000);
      this.emit({ type: 'rep', valid: false, reason: 'tempo' });
      this.nextCycle(now);
      return;
    }
    // 计数放宽了，但深度不够还是要出声纠正（分数也已经按深度打了折扣）
    if (!this.depthOk) this.cue('lungeDepth', null, 'warn', now, 4000);

    // 左右腿交替检查
    if (this.lastFrontSide && this.lastFrontSide === this.frontSide) {
      this.sameSideStreak += 1;
      if (this.sameSideStreak >= 1) {
        this.cue('alternate', null, 'warn', now, 5000);
      }
    } else {
      this.sameSideStreak = 0;
    }
    this.lastFrontSide = this.frontSide;

    this.validReps += 1;
    this.reps = this.validReps;
    this.cycleHadValidRep = true;
    // 深度分：沉到底 30 分，浅一点递减（次数放宽了，分数仍然区分质量）
    const depthGain = this.minFront <= 100 ? 30
      : this.minFront <= 118 ? 24
        : this.minFront <= 130 ? 18 : 10;
    const quality = clamp(Math.round(60 + depthGain + (this.minBackDrop < 0.35 ? 10 : 5)), 0, 100);
    this.emit({ type: 'rep', valid: true, index: this.validReps, quality, duration: dur, side: this.frontSide });
    this.nextCycle(now);
  }
}

/* ------------------------------------------------------------------ *
 * 计数类：俯卧撑
 * ------------------------------------------------------------------ */

/**
 * 俯卧撑的判定（**整体放宽**：大体上做了一次就计一次）。
 *
 * 三档肘角说清了一件事：
 *   elbowUp      回到这个角度以上 = 一次动作结束（原来 152°，手臂必须几乎全直；现在 145° 就认）
 *   looseElbow   宽松模式的计数线（原来 124°：要下放到「胸口接近地面」才算；现在 135° 就算一次）
 *   elbowFull    拿满分深度的线（原来 106°）
 * 另外：
 *   - 身体不够直不再吃次数，只出声纠正 + 质量分打折；
 *   - 用时下限只用来滤掉「手抖一下」，260ms 比人能做的任何一次俯卧撑都快；
 *   - 只是晃了一下（肘角没弯过 146°）不算一次尝试，也不出声。
 */
const PUSHUP = {
  activeTorso: 32,
  activeShoulderClear: 0.12,
  activeHandOnFloor: 0.62,
  elbowUp: 145,       // 回到这个角度算「推起来了」（原来 152）
  elbowEnter: 138,    // 从这个角度开始算「正在下放」（原来 elbowUp-12 = 140）
  elbowDown: 120,     // 下放到这里算「到过底部」（原来 118）
  elbowFull: 118,     // 满分深度（原来 106，要压到胸口贴地）
  looseElbow: 135,    // 宽松模式计数线（原来 124）
  ignoreElbow: 146,   // 没弯过这里 = 只是晃了一下（不计次也不出声）
  minRepMs: 260,      // 原来 340
  bodyStraightMin: 138, // 身体不够直只提示，不再吃次数
};

class PushupDetector extends DetectorBase {
  onReset() {
    this.stage = 'up';
    this.repStartAt = 0;
    this.minElbow = 180;
    this.minBody = 180;
    this.maxSag = -9;
    this.minSag = 9;
    this.cycleLowered = false;
  }
  onLost() { this.stage = 'up'; this.repStartAt = 0; }
  onNewCycle() { this.cycleLowered = false; }

  /** 俯撑判据：躯干接近水平 + 肩离地 + 手撑在地面上（站姿时手在腰侧，离地很高） */
  isProne(f) {
    return f.torsoIncl > PUSHUP.activeTorso
      && f.shoulderClear > PUSHUP.activeShoulderClear
      && f.wristClear < PUSHUP.activeHandOnFloor;
  }

  step(f, now) {
    if (!this.isProne(f)) {
      // 撑到一半爬起来了 → 按半程收尾，而不是默默不计
      if (this.stage !== 'up') this.finish(f, now, true);
      this.active = false;
      this.standby = 'status.standbyPushup';
      this.stage = 'up';
      this.repStartAt = 0;
      this.depthPct = 0;
      return;
    }
    this.active = true;
    this.standby = '';
    const elbow = f.elbowAngle;
    this.depthPct = bendPct(elbow, 168, 88);
    if (elbow <= PUSHUP.looseElbow) this.cycleLowered = true;

    if (f.hipLineDev > 0.13) this.cue('sag', null, 'warn', now);
    else if (f.hipLineDev < -0.13) this.cue('pike', null, 'warn', now);

    switch (this.stage) {
      case 'up':
        if (elbow <= PUSHUP.elbowEnter) {
          this.stage = 'descending';
          this.repStartAt = now;
          this.minElbow = elbow;
          this.minBody = f.bodyStraight;
          this.maxSag = f.hipLineDev;
          this.minSag = f.hipLineDev;
        }
        break;
      case 'descending':
      case 'bottom':
        this.minElbow = Math.min(this.minElbow, elbow);
        this.minBody = Math.min(this.minBody, f.bodyStraight);
        this.maxSag = Math.max(this.maxSag, f.hipLineDev);
        this.minSag = Math.min(this.minSag, f.hipLineDev);
        if (elbow <= PUSHUP.elbowDown && this.stage === 'descending') this.stage = 'bottom';
        if (elbow >= PUSHUP.elbowUp) this.finish(f, now, false);
        break;
      default:
        break;
    }
  }

  finish(f, now, aborted = false) {
    const dur = now - this.repStartAt;
    this.stage = 'up';
    this.repStartAt = 0;
    // 只是晃了一下（肘角没弯过 146°）：连半程都不记，也不出声
    if (this.minElbow > PUSHUP.ignoreElbow) return;
    const full = this.minElbow <= PUSHUP.elbowFull;
    const bodyOk = this.minBody >= PUSHUP.bodyStraightMin;
    const deepEnough = this.minElbow <= PUSHUP.elbowFull;
    const looseEnough = !this.strict && this.minElbow <= PUSHUP.looseElbow;

    // 计数放宽：身体不够直也照样算一次，只是要出声纠正、分数打折（严格模式才拦）
    if (this.strict && !bodyOk) {
      this.partialReps += 1;
      this.cue('body', null, 'warn', now, 3000);
      this.emit({ type: 'rep', valid: false, reason: 'body' });
      this.nextCycle(now);
      return;
    }
    if (!deepEnough && !looseEnough) {
      this.partialReps += 1;
      this.cue('depth', null, 'warn', now, 3000);
      this.emit({ type: 'rep', valid: false, reason: 'depth' });
      this.nextCycle(now);
      return;
    }
    if (!aborted && dur < PUSHUP.minRepMs) {
      this.partialReps += 1;
      this.cue('tempo', null, 'warn', now, 3000);
      this.emit({ type: 'rep', valid: false, reason: 'tempo' });
      this.nextCycle(now);
      return;
    }
    if (!bodyOk) this.cue('body', null, 'warn', now, 3000);
    // 计数放宽了，但沉得不够还是要出声纠正（分数也已经按深度打了折）
    if (!deepEnough) this.cue('depth', null, 'warn', now, 4000);
    this.validReps += 1;
    this.reps = this.validReps;
    this.cycleHadValidRep = true;
    // 质量分按「下放深度」给：压到 elbowFull 以内满分，只到宽松线就少一截
    const depthGain = this.minElbow <= PUSHUP.elbowFull ? 30
      : this.minElbow <= 124 ? 24
        : this.minElbow <= 130 ? 18 : 12;
    const quality = clamp(Math.round(56 + depthGain + (this.minBody > 165 ? 10 : bodyOk ? 5 : 0)), 0, 100);
    this.emit({ type: 'rep', valid: true, index: this.validReps, quality, duration: dur });
    this.nextCycle(now);
  }
}

/* ------------------------------------------------------------------ *
 * 计数类：臀桥
 * ------------------------------------------------------------------ */

const BRIDGE = {
  supineTorso: 36,
  kneeMin: 30,
  kneeMax: 148,
  shoulderClearMax: 0.46,
  kneeClearMin: 0.20,
  downRise: 0.12,
  upRise: 0.22,   // 顶起幅度要求（原来 0.35，要顶很高才算）
  // 整轮时长下限（上一个顶点 → 这个顶点）：比人体能做出的最快一次臀桥还短，
  // 所以只会滤掉“上下抖一下”，不会吃掉真做的次数。第一次顶起不参与这个判断。
  minRepMs: 700,
};

class GluteBridgeDetector extends DetectorBase {
  onReset() { this.stage = 'down'; this.lastTopAt = 0; this.maxRise = -9; this.wasAtTop = false; }
  onLost() { this.stage = 'down'; this.lastTopAt = 0; }
  onNewCycle() { this.wasAtTop = false; }

  /** 仰卧判据：躯干接近水平 + 屈膝 + 肩贴地 + 膝离地 */
  isSupine(f) {
    return f.torsoIncl > BRIDGE.supineTorso
      && f.kneeAngle > BRIDGE.kneeMin && f.kneeAngle < BRIDGE.kneeMax
      && f.shoulderClear < BRIDGE.shoulderClearMax
      && f.kneeClear > BRIDGE.kneeClearMin;
  }

  step(f, now) {
    if (!this.isSupine(f)) {
      this.active = false;
      this.standby = 'status.standbyBridge';
      this.stage = 'down';
      this.depthPct = 0;
      if (f.torsoIncl < 35) this.cue('notSupine', null, 'info', now, 8000);
      return;
    }
    this.active = true;
    this.standby = '';
    const rise = f.hipRise;
    this.depthPct = clamp((rise / 0.6) * 100, 0, 100);

    const atTop = rise > BRIDGE.upRise;
    const atBottom = rise < BRIDGE.downRise;

    if (this.stage === 'down') {
      if (atTop) {
        // 一次计数的时长 = 上一个顶点 → 这个顶点（整轮时长），只用来滤掉“快速上下抖”。
        // 第一次顶起没有上一个顶点作参照，直接算有效，不要因为“计时数据不足”吃掉用户的第一下。
        const dur = this.lastTopAt ? now - this.lastTopAt : 0;
        this.lastTopAt = now;
        this.stage = 'up';
        this.maxRise = rise;
        this.wasAtTop = true;
        if (dur > 0 && dur < BRIDGE.minRepMs) {
          this.partialReps += 1;
          this.cue('tempo', null, 'warn', now, 3000);
          this.emit({ type: 'rep', valid: false, reason: 'tempo' });
        } else {
          this.validReps += 1;
          this.reps = this.validReps;
          this.cycleHadValidRep = true;
          this.phase = 'up';
          const quality = clamp(Math.round(60 + (rise > 0.5 ? 30 : 18) + (f.kneeAngle > 80 && f.kneeAngle < 120 ? 10 : 5)), 0, 100);
          this.emit({ type: 'rep', valid: true, index: this.validReps, quality, duration: dur });
        }
      } else if (rise > BRIDGE.downRise) {
        this.cue('riseMore', null, 'warn', now, 3500);
      }
    } else {
      this.maxRise = Math.max(this.maxRise, rise);
      if (atBottom) {
        this.stage = 'down';
        this.phase = 'down';
        // 回到起点才算一轮结束：此时结算“整轮要领满分”，并重置要领清单
        this.nextCycle(now);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 计时类：平板支撑
 * ------------------------------------------------------------------ */

/**
 * 平板支撑的判定（**整体放宽**：大体撑对了就开始计时）。
 *
 * 分两档：
 *   HARD（必须满足，否则暂停计时）：身体基本放平、肩离地、手/小臂在地面附近
 *   SOFT（只是语音纠正，不打断计时）：身体不够直、塌腰/撅臀、膝盖偏低、肘角读数模糊
 * 这样「撑得不太标准」也能一直计时（分数照常按性价比打折），
 * 而「根本没撑起来」（站着、趴在地上）才不计时。
 */
const PLANK = {
  // ---- HARD：撑起来了才开始计时 ----
  torsoIncl: 38,          // 身体接近水平（原来 42）
  shoulderClearMin: 0.10, // 肩离地（原来 0.14）
  handOnFloorMax: 0.55,   // 手/小臂在地面附近（原来 0.45）
  // ---- SOFT：只提示不打断 ----
  bodyStraight: 132,      // 身体成线（原来 142）
  hipDevMax: 0.20,        // 塌腰 / 撅臀的容忍度（原来 0.14）
  kneeClearMin: 0.02,     // 膝离地（原来 0.03）
  elbowBentMax: 132,      // 低于此值算「小臂撑」（原来 122）
  elbowStraightMin: 140,  // 高于此值算「直臂撑」（原来 148）
};

class PlankDetector extends HoldDetector {
  checkHold(f) {
    // ---- 必须项：没撑起来就不计时 ----
    if (f.shoulderClear < PLANK.shoulderClearMin) {
      return { valid: false, reason: 'lift' };
    }
    if (f.torsoIncl < PLANK.torsoIncl) {
      return { valid: false, reason: 'pose' };
    }
    if (f.wristClear > PLANK.handOnFloorMax) {
      return { valid: false, reason: 'hands' };
    }
    // ---- 建议项：出声纠正，但计时继续 ----
    if (f.hipLineDev > PLANK.hipDevMax) {
      this.cue('sag', null, 'warn', this._lastT || 0, 6000);
    } else if (f.hipLineDev < -PLANK.hipDevMax) {
      this.cue('pike', null, 'warn', this._lastT || 0, 6000);
    }
    if (f.bodyStraight < PLANK.bodyStraight) {
      this.cue('straight', null, 'warn', this._lastT || 0, 6000);
    }
    if (f.kneeClear < PLANK.kneeClearMin) {
      this.cue('knees', null, 'warn', this._lastT || 0, 6000);
    }
    const bent = f.elbowAngle < PLANK.elbowBentMax;
    const straight = f.elbowAngle > PLANK.elbowStraightMin;
    if (!bent && !straight) {
      this.cue('elbow', null, 'info', this._lastT || 0, 9000);
    }
    // 姿势质量进分数：不太标准也计时，但 depthPct 会低一些（进度条与质量分都看得出来）
    const quality = clamp(
      Math.round(
        100
        - Math.max(0, PLANK.bodyStraight - f.bodyStraight)
        - Math.max(0, Math.abs(f.hipLineDev) - 0.10) * 120,
      ),
      55,
      100,
    );
    this.depthPct = quality;
    return { valid: true };
  }
}

/* ------------------------------------------------------------------ *
 * 工厂
 *
 * 最经典的几个动作保留专门写的识别器（判定最精细），
 * 其余动作走 engines.js 里配置驱动的通用引擎（bend / alt / twist / sequence / hold）。
 * ------------------------------------------------------------------ */

const BUILTIN = {
  squat: SquatDetector,
  lunge: LungeDetector,
  pushup: PushupDetector,
  bridge: GluteBridgeDetector,
  plank: PlankDetector,
};

export function createDetector(id, opts = {}) {
  const meta = EXERCISE_MAP[id];
  if (!meta) throw new Error('Unknown exercise: ' + id);
  const Builtin = BUILTIN[id];
  if (Builtin) return new Builtin(meta, opts);
  return createEngineDetector(meta, opts);
}

export { DetectorBase, HoldDetector };
