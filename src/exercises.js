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
import { t, tList } from './i18n.js';

/* ------------------------------------------------------------------ *
 * 动作元数据（只保留结构与 i18n 键，文案全在 src/locales/*.js）
 * ------------------------------------------------------------------ */

export const EXERCISES = [
  { id: 'squat', icon: '🏋️', kind: 'rep', unitKey: 'ui.repsUnit', defaultTarget: 15 },
  { id: 'lunge', icon: '🦵', kind: 'rep', unitKey: 'ui.repsUnit', defaultTarget: 16 },
  { id: 'pushup', icon: '💪', kind: 'rep', unitKey: 'ui.repsUnit', defaultTarget: 12 },
  { id: 'bridge', icon: '🌉', kind: 'rep', unitKey: 'ui.repsUnit', defaultTarget: 15 },
  { id: 'plank', icon: '🧘', kind: 'hold', unitKey: 'ui.secondsUnit', defaultTarget: 45 },
  { id: 'bridgehold', icon: '⏱️', kind: 'hold', unitKey: 'ui.secondsUnit', defaultTarget: 30 },
];

export const EXERCISE_MAP = Object.fromEntries(EXERCISES.map((e) => [e.id, e]));

/** 动作单位（次 / 秒），随语言变化 */
export function exerciseUnit(id) {
  const ex = EXERCISE_MAP[id];
  return ex ? t(ex.unitKey) : '';
}

/** 取某个动作在当前语言下的全部文案（名称、机位提示、要领、注意事项） */
export function localizedExercise(id) {
  const meta = EXERCISE_MAP[id];
  if (!meta) return null;
  return {
    ...meta,
    name: t(`ex.${id}.name`),
    cameraHint: t(`ex.${id}.cameraHint`),
    goal: t(`ex.${id}.goal`),
    unit: exerciseUnit(id),
    howto: tList(`ex.${id}.howto`),
    tips: tList(`ex.${id}.tips`),
  };
}

/** 当前语言下的全部动作文案 */
export function localizedExercises() {
  return EXERCISES.map((e) => localizedExercise(e.id));
}

/* ------------------------------------------------------------------ *
 * 基类
 * ------------------------------------------------------------------ */

class DetectorBase {
  constructor(meta, opts = {}) {
    this.meta = meta;
    // 默认「宽松」：跟界面默认一致——大体做到了就计次数，动作不标准只用语音纠正。
    // 想严格（必须沉到位才算一次）时由 App 传 { strict: true }。
    this.strict = opts.strict === true;
    this.plan = getStepPlan(meta.id);
    this.reps = 0;
    this.validReps = 0;
    this.partialReps = 0;
    this.holdMs = 0;
    this.score = 0;
    this.scoreAccum = 0;
    this.cycle = 0;
    this.stepDone = new Map();
    this.lastStep = null;
    this.cycleHadValidRep = false;
    this.phase = 'idle';
    this.active = false;
    this.standby = '';
    this.depthPct = 0;
    this.feedback = null;
    this.events = [];
    this._cueAt = new Map();
    this._lostSince = null;
    this._lastFrame = null;
    this.onReset();
  }

  /** 子类重置内部状态 */
  onReset() {}
  onLost() {}

  /** 暂停后恢复时清掉计时基准，避免把暂停时长算进计时 */
  resetClock() { this._lastT = 0; }

  /** 每进入一次新的动作循环时调用（子类可覆盖以清理本轮标记） */
  onNewCycle() {}

  reset() {
    this.reps = 0;
    this.validReps = 0;
    this.partialReps = 0;
    this.holdMs = 0;
    this.score = 0;
    this.scoreAccum = 0;
    this.cycle = 0;
    this.stepDone = new Map();
    this.lastStep = null;
    this.cycleHadValidRep = false;
    this.phase = 'idle';
    this.active = false;
    this.depthPct = 0;
    this.feedback = null;
    this.events = [];
    this._cueAt.clear();
    this._lostSince = null;
    this.onReset();
  }

  /* ---------------- 要领计分 ---------------- */

  /** 步骤在本轮的唯一键：计时类的里程碑整组只算一次 */
  stepKey(def) {
    const perCycle = def.perCycle === undefined ? this.plan.perCycle !== false : def.perCycle;
    return perCycle ? `${def.id}@${this.cycle}` : def.id;
  }

  /** 逐一检查要领步骤，达标就立刻加分并抛出 step 事件（供音效 / 界面使用） */
  evaluateSteps(f, now) {
    const steps = this.plan.steps || [];
    let awarded = 0;
    for (let i = 0; i < steps.length; i++) {
      if (awarded >= 2) break; // 一帧最多奖励两步，避免音效糊在一起
      const def = steps[i];
      const key = this.stepKey(def);
      if (this.stepDone.has(key)) continue;
      let ok = false;
      try { ok = !!def.check(f, this); } catch { ok = false; }
      if (!ok) continue;
      this.stepDone.set(key, now);
      this.score += def.points;
      awarded += 1;
      this.lastStep = {
        id: def.id, labelKey: def.labelKey, points: def.points, score: this.score, index: i, at: now,
      };
      this.emit({
        type: 'step', id: def.id, labelKey: def.labelKey, points: def.points,
        score: this.score, index: i, total: steps.length, at: now,
      });
    }
    return awarded;
  }

  allCycleStepsDone() {
    const steps = this.plan.steps || [];
    return steps.every((def) => this.stepDone.has(this.stepKey(def)));
  }

  /** 进入下一个动作循环：先结算“整轮满分奖励”，再重置步骤清单 */
  nextCycle(now) {
    if (this.cycleHadValidRep && this.plan.repBonus > 0 && this.allCycleStepsDone()) {
      this.score += this.plan.repBonus;
      this.emit({ type: 'bonus', points: this.plan.repBonus, score: this.score, at: now });
    }
    this.cycle += 1;
    this.cycleHadValidRep = false;
    this.onNewCycle();
  }

  /** 供界面渲染要领清单 */
  stepStatus() {
    const steps = this.plan.steps || [];
    return steps.map((def, i) => ({
      id: def.id,
      labelKey: def.labelKey,
      points: def.points,
      done: this.stepDone.has(this.stepKey(def)),
      index: i,
    }));
  }

  /**
   * 下一个待完成要领的“为什么还没拿到分”说明。
   * 界面拿它来告诉用户到底卡在哪一步，避免“站在那一动不动也没反应”。
   */
  pendingHint() {
    const steps = this.plan.steps || [];
    for (const def of steps) {
      if (this.stepDone.has(this.stepKey(def))) continue;
      let hint = null;
      if (typeof def.hint === 'function' && this._lastFrame?.ok) {
        try { hint = def.hint(this._lastFrame, this) || null; } catch { hint = null; }
      }
      return { id: def.id, labelKey: def.labelKey, hint };
    }
    return null;
  }

  emit(ev) { this.events.push(ev); }

  /**
   * 带节流的姿势纠正提示。
   * 只传 code（+ params），文案在渲染时从 locales 里按 `cues.<动作>.<code>` 取，
   * 这样同一套识别逻辑可以直接输出四种语言。
   */
  cue(code, params = null, level = 'warn', now = performance.now(), throttleMs = 4500) {
    const last = this._cueAt.get(code) || -Infinity;
    if (now - last < throttleMs) return;
    this._cueAt.set(code, now);
    const key = `cues.${this.meta.id}.${code}`;
    this.feedback = { code, key, params, level, at: now };
    this.emit({ type: 'cue', code, key, params, level });
  }

  /** 每帧调用。返回本帧事件数组 */
  update(f, now) {
    this.events = [];
    if (!f || !f.ok) {
      if (this._lostSince === null) this._lostSince = now;
      this._lastFrame = null;
      if (now - this._lostSince > 400) {
        if (this.phase !== 'idle') { this.phase = 'idle'; this.onLost(); }
        this.active = false;
        this.standby = 'status.lostTracking';
      }
      return this.events;
    }
    this._lostSince = null;
    this._lastFrame = f;
    // 先结算要领分，再跑计数状态机：这样“完成后半段要领”能赶在同一帧拿到满分奖励
    this.evaluateSteps(f, now);
    this.step(f, now);
    this.tickHoldScore(now);
    return this.events;
  }

  /** 计时类动作的“每秒得分”，默认无 */
  tickHoldScore() {}

  snapshot() {
    return {
      id: this.meta.id,
      kind: this.meta.kind,
      reps: this.validReps,
      validReps: this.validReps,
      partialReps: this.partialReps,
      holdMs: this.holdMs,
      score: this.score,
      cycle: this.cycle,
      steps: this.stepStatus(),
      phase: this.phase,
      active: this.active,
      standby: this.active ? '' : this.standby,
      depthPct: this.depthPct,
      feedback: this.feedback,
    };
  }

  step() {}
}

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

const PUSHUP = {
  activeTorso: 32,
  activeShoulderClear: 0.12,
  activeHandOnFloor: 0.62,
  elbowUp: 152,
  elbowDown: 118,     // 下放到这里就算「下去了」（原来 104）
  elbowFull: 106,     // 满分要求也放宽（原来 92，要压到胸口贴地）
  looseElbow: 124,    // 宽松模式：肘弯到 124° 以内就算一次（原来必须 120 且身体够直）
  minRepMs: 340,      // 原来 420
  bodyStraightMin: 138, // 身体不够直只提示，不再吃次数（原来 146，直接判半程）
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
    if (elbow <= 140) this.cycleLowered = true;

    if (f.hipLineDev > 0.13) this.cue('sag', null, 'warn', now);
    else if (f.hipLineDev < -0.13) this.cue('pike', null, 'warn', now);

    switch (this.stage) {
      case 'up':
        if (elbow <= PUSHUP.elbowUp - 12) {
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
    if (aborted && this.minElbow > 150) return; // 还没开始下放就走了，不算一次尝试
    const full = this.minElbow <= PUSHUP.elbowFull;
    const bodyOk = this.minBody >= PUSHUP.bodyStraightMin;
    const okDepth = full || (!this.strict && this.minElbow <= PUSHUP.looseElbow);

    // 计数放宽：身体不够直也照样算一次，只是要出声纠正、分数打折（严格模式才拦）
    if (this.strict && !bodyOk) {
      this.partialReps += 1;
      this.cue('body', null, 'warn', now, 3000);
      this.emit({ type: 'rep', valid: false, reason: 'body' });
      this.nextCycle(now);
      return;
    }
    if (!okDepth) {
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
    this.validReps += 1;
    this.reps = this.validReps;
    this.cycleHadValidRep = true;
    const quality = clamp(Math.round(60 + (full ? 30 : 15) + (this.minBody > 165 ? 10 : bodyOk ? 5 : 0)), 0, 100);
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
 * 计时类基类
 * ------------------------------------------------------------------ */

class HoldDetector extends DetectorBase {
  constructor(meta, opts) {
    super(meta, opts);
    this.graceMs = 1200;
    this.holdMs = 0;
    this._lastT = 0;
    this.okMs = 0;
    this.badMs = 0;
    this.holding = false;
  }
  onReset() {
    this._lastT = 0;
    this.okMs = 0;
    this.badMs = 0;
    this.holding = false;
    this._primed = false;
  }
  onLost() { this.holding = false; this.badMs = 0; this.okMs = 0; this._primed = false; this._lastT = 0; }

  /** 子类实现：返回 {valid, reason:[code,text]} */
  checkHold() { return { valid: false, reason: 'idle' }; }

  /** 保持期间的“每秒得分”：撑住不动也在涨分，让计时类动作有持续反馈 */
  addHoldScore(dt, now) {
    const pps = this.plan.pointsPerSecond || 0;
    if (pps <= 0) return;
    this.scoreAccum += (dt / 1000) * pps;
    while (this.scoreAccum >= 1) {
      this.scoreAccum -= 1;
      this.score += 1;
      this.emit({ type: 'points', points: 1, score: this.score, at: now, tick: true });
    }
  }

  step(f, now) {
    const dt = this._lastT ? clamp(now - this._lastT, 0, 200) : 0;
    this._lastT = now;
    const r = this.checkHold(f, now);
    this.active = r.valid;

    if (r.valid) {
      this.okMs += dt;
      this.badMs = 0;
      // 稳定 250ms 后才开始计时，避免瞬间误判；跨过阈值时把这 250ms 补回来
      if (this.okMs > 250) {
        if (!this.holding && !this._primed) {
          this.holdMs += this.okMs;
          this._primed = true;
        } else {
          this.holdMs += dt;
        }
        if (!this.holding) {
          this.holding = true;
          this.emit({ type: 'hold', action: 'start' });
        }
        this.addHoldScore(dt, now);
      }
      this.phase = 'holding';
      this.standby = '';
    } else {
      this.okMs = 0;
      this.badMs += dt;
      if (this.holding && this.badMs <= this.graceMs) {
        // 宽限期：暂停累加但保持本组进行中，容忍识别抖动
        this.phase = 'holding';
      } else if (this.badMs > this.graceMs) {
        if (this.holding) {
          this.holding = false;
          this.emit({ type: 'hold', action: 'pause', reason: r.reason });
        }
        this.phase = this.holdMs > 0 ? 'paused' : 'idle';
        this.standby = r.reason ? `cues.${this.meta.id}.${r.reason}` : 'status.holdPaused';
        if (r.reason) this.cue(r.reason, null, 'warn', now, 5000);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 计时类：平板支撑
 * ------------------------------------------------------------------ */

const PLANK = {
  torsoIncl: 42,
  bodyStraight: 142,   // 身体成线（原来 158/146，稍微塌一点就不算）
  shoulderClearMin: 0.14,
  handOnFloorMax: 0.45,
  kneeClearMin: 0.03,
  elbowBentMax: 122,
  elbowStraightMin: 148,
};

class PlankDetector extends HoldDetector {
  checkHold(f) {
    if (f.shoulderClear < PLANK.shoulderClearMin) {
      return { valid: false, reason: 'lift' };
    }
    if (f.torsoIncl < PLANK.torsoIncl) {
      return { valid: false, reason: 'pose' };
    }
    if (f.hipLineDev > 0.14) {
      return { valid: false, reason: 'sag' };
    }
    if (f.hipLineDev < -0.14) {
      return { valid: false, reason: 'pike' };
    }
    if (f.bodyStraight < PLANK.bodyStraight) {
      return { valid: false, reason: 'straight' };
    }
    if (f.wristClear > PLANK.handOnFloorMax) {
      return { valid: false, reason: 'hands' };
    }
    if (f.kneeClear < PLANK.kneeClearMin) {
      return { valid: false, reason: 'knees' };
    }
    const bent = f.elbowAngle < PLANK.elbowBentMax;
    const straight = f.elbowAngle > PLANK.elbowStraightMin;
    if (!bent && !straight) {
      return { valid: false, reason: 'elbow' };
    }
    this.depthPct = 100;
    return { valid: true };
  }
}

/* ------------------------------------------------------------------ *
 * 计时类：静态臀桥
 * ------------------------------------------------------------------ */

const BRIDGE_HOLD = {
  supineTorso: 36,
  kneeMin: 30,
  kneeMax: 148,
  shoulderClearMax: 0.46,
  kneeClearMin: 0.20,
  holdRise: 0.20,   // 原来 0.32
};

class BridgeHoldDetector extends HoldDetector {
  checkHold(f) {
    const supine = f.torsoIncl > BRIDGE_HOLD.supineTorso
      && f.kneeAngle > BRIDGE_HOLD.kneeMin && f.kneeAngle < BRIDGE_HOLD.kneeMax
      && f.kneeClear > BRIDGE_HOLD.kneeClearMin;
    if (!supine) {
      return { valid: false, reason: 'pose' };
    }
    if (f.hipRise < BRIDGE_HOLD.holdRise) {
      this.depthPct = clamp((f.hipRise / 0.6) * 100, 0, 100);
      return { valid: false, reason: 'rise' };
    }
    this.depthPct = 100;
    return { valid: true };
  }
}

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */

export function createDetector(id, opts = {}) {
  const meta = EXERCISE_MAP[id];
  if (!meta) throw new Error('Unknown exercise: ' + id);
  switch (id) {
    case 'squat': return new SquatDetector(meta, opts);
    case 'lunge': return new LungeDetector(meta, opts);
    case 'pushup': return new PushupDetector(meta, opts);
    case 'bridge': return new GluteBridgeDetector(meta, opts);
    case 'plank': return new PlankDetector(meta, opts);
    case 'bridgehold': return new BridgeHoldDetector(meta, opts);
    default: throw new Error('Exercise not implemented: ' + id);
  }
}

export { DetectorBase, HoldDetector };
