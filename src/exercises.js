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
    this._straight = [];   // 「自己站得最直」的最近观测（见 standLine）
  }
  onLost() { this.stage = 'up'; this.repStartAt = 0; }
  onNewCycle() { this.cycleDescended = false; }

  /**
   * 「回到站姿」的判定线：默认 0.86，但跟着**用户自己的站姿**走
   * （他站直时读数只有 0.80 就按 0.80 算）。
   * 绝对阈值一旦高于他实际能到的值，这一轮就永远不结算，后面几次会并进同一轮
   * —— 这正是「做了好几个只记一次」的成因（俯卧撑上是同一个 bug）。
   */
  get standLine() {
    if (!this._straight.length) return SQUAT.standRatio;
    const best = Math.max(...this._straight.map((x) => x.v));
    return Math.min(SQUAT.standRatio, Math.max(best, SQUAT.looseRatio));
  }

  rememberStraight(v, now) {
    if (!Number.isFinite(v)) return;
    this._straight.push({ t: now, v });
    while (this._straight.length > 2 && now - this._straight[0].t > 2000) this._straight.shift();
  }

  /** 计数诊断（🐞 面板显示） */
  diag() {
    return [
      { key: 'debug.diag.stage', value: this.stage },
      { key: 'debug.diag.standLine', value: this.standLine.toFixed(2) },
      { key: 'debug.diag.repMin', value: Number.isFinite(this.minRatio) ? this.minRatio.toFixed(2) : '—' },
      { key: 'debug.diag.counts', value: `${this.validReps}/${this.partialReps}` },
      ...(this.lastReject ? [{ key: 'debug.diag.reject', reject: this.lastReject }] : []),
    ];
  }

  step(f, now) {
    this.active = true;
    this.standby = '';
    const r = f.hipAboveKnee;   // 髋比膝高多少（除以小腿长）
    const standLine = this.standLine;

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
        this.rememberStraight(r, now);
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
        } else if (r >= standLine) {
          this.finish(f, now, true);
        } else if (now - this.repStartAt > 2500) {
          this.cue('halfway', null, 'warn', now, 4000);
          this.repStartAt = now;
        }
        break;

      case 'bottom':
        this.minRatio = Math.min(this.minRatio, r);
        if (r >= standLine) this.finish(f, now, false);
        else if (now - this.repStartAt > 12000) this.finish(f, now, false);   // 超时强制结算，不吞次数
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
  // 判据整体放宽：**动作大体做到位就算一次**，不要求前膝弯到 90°。
  // 三档膝角：enter 开始算这一轮 → loose 宽松计数线 → down 拿标准深度分。
  standKnee: 142,     // 「回到站姿」的参考门槛（实际跟着用户自己的站姿走，见 standLine）
  enterKnee: 146,     // 「开始这一轮」的参考门槛（实际还会跟 standLine 一起放宽）
  downKnee: 128,      // 「沉到底」阶段（拿整轮满分奖励 / 严格模式的深度）
  // 宽松计数线：前膝弯到 152°（≈ 从站直弯下去 25° 以上）就算一次 ——
  // 用户反馈「即使膝关节没有 90° 也应该计次，大体做到位就行」。
  looseKnee: 152,
  enterDrop: 20,      // 比「自己站得最直时」弯下去这么多度，才算这一轮开始
  minBend: 8,         // 回到自己站姿 8° 以内算这一轮结束；也是「是否算一次尝试」的相对门槛
  recovery: 0.60,     // 从最弯处回升这么多比例就算「回到站姿」（按本轮自己的幅度算）
  // 抖动宽容：膝角必须在门槛内「持续」住才算真的开始/结束一次，
  // 否则跟踪噪声在门槛附近来回跳会造出一堆假的“半程 + 下沉不够”提醒。
  enterHoldMs: 200,
  exitHoldMs: 100,
  bothBentMax: 162,   // 两条腿都算「弯」的门槛放宽（原来 150）
  /**
   * 计次门槛：**两条腿都要有弯曲度**（用户反馈「箭步蹲计次太松了」）。
   * 单看前膝的话，只要前腿点一下就能凑一次；这里额外要求「较直的那条腿」
   * 也弯到 bothBentNeeded 以内，或者比用户自己站直时弯下去 bothDrop 度。
   * 取两者中更严的那个，读数被压缩（站直只有 140°）的人也不会被卡死。
   */
  bothBentNeeded: 158,
  bothDrop: 12,
  backKneeCue: 0.66,  // 后膝太高 → 提示（后膝离地高度 / 小腿长）
  backKneeDrop: 0.66, // 深度达标要求（原来 0.58，要求后膝几乎贴地太严）
  minRepMs: 450,      // 一次有效箭步蹲的最短用时（原来 750/520）
  // 「太快」只对**真的沉下去过**的那些轮次做检查：浅的一次本来就做得快，
  // 拿速度去卡它只会把「大体做到」的动作判成半程（用户反馈）。
  tempoDepth: 138,
};

class LungeDetector extends DetectorBase {
  onReset() {
    this.stage = 'up';
    this.repStartAt = 0;
    this.bendSince = 0;
    this.upSince = 0;
    this.minFront = 180;
    this.minBoth = 180;
    this.minBackDrop = 9;
    this.depthOk = false;
    this.lastFrontSide = null;
    this.sameSideStreak = 0;
    this.cycleSunk = false;
    this._straight = [];   // 「自己站得最直」的最近观测（见 standLine）
  }
  onLost() {
    this.stage = 'up';
    this.repStartAt = 0;
    this.bendSince = 0;
    this.upSince = 0;
  }
  onNewCycle() { this.cycleSunk = false; }

  /**
   * 「回到站姿」的判定线：默认 142°，但跟着**用户自己的站姿**走
   * （如果他的膝盖伸直时读数只有 138°，就按 138 算）。
   * 不这么做的话，绝对阈值一旦高于他实际能到的角度，这一轮永远不结算，
   * 后面几次都会并进同一轮 —— 正是「做了好几个只记一次」的成因。
   */
  get standLine() {
    if (!this._straight.length) return LUNGE.standKnee;
    const best = Math.max(...this._straight.map((r) => r.v));
    return Math.min(LUNGE.standKnee, Math.max(best, LUNGE.downKnee + 6));
  }

  /** 「开始这一轮」的判定线：比**自己站得最直时**弯下去 enterDrop 度（自适应，不看绝对角度） */
  get enterLine() { return this.topLine - LUNGE.enterDrop; }

  /**
   * 「回到站姿」的判定线：按这一轮**自己的幅度**算，三条一起看，取最容易达成的那条：
   *   ① 从最弯处回升 recovery（60%）—— 蹲得深的人回程长，这条先到；
   *   ② 回到站姿 minBend（8°）以内 —— 浅的那次靠这条收尾；
   *   ③ 无论如何至少比最弯处高出 minBend —— 保证是「掉头回升」，而不是还在往下走。
   * 只用一个固定角度不行：固定线在浅蹲时一进一出就被数成两次（实测 0.4 幅度被数成 8 次），
   * 在深蹲时又一直等不到，把后面几次并进同一轮。
   */
  get exitLine() {
    const recovered = this.minFront + LUNGE.recovery * (this.topLine - this.minFront);
    return Math.max(
      this.minFront + LUNGE.minBend,
      Math.min(recovered, this.topLine - LUNGE.minBend),
    );
  }

  /** 用户自己站得最直时量到的膝角（用最近观测；没观测到时按「直腿」起步） */
  get topLine() {
    if (!this._straight.length) return LUNGE.standKnee + 36;
    return Math.max(...this._straight.map((r) => r.v));
  }

  /**
   * 计一次的膝角线：**不要求前膝 90°**（用户明确要求）。
   * 152° ≈ 从站直（170° 上下）弯下去 18° 以上；比这更浅的只提示不计数，
   * 而「读数被压缩的人」（站直只有 140°）由自适应的 enter/exit 线兜住，不会乱计数。
   */
  get countLine() { return LUNGE.looseKnee; }

  /**
   * 「两条腿都弯了」的判定线：**较直的那条腿**（后腿）也得弯到这条线以内。
   * 绝对门槛 158° 与「比自己站直时弯下去 12°」取更严的那个 ——
   * 后者让读数被压缩的人同样能计次，前者防止站得很直的人靠一点点抖动凑数。
   */
  get bothLine() {
    return Math.min(LUNGE.bothBentNeeded, this.topLine - LUNGE.bothDrop);
  }

  rememberStraight(v, now) {
    if (!Number.isFinite(v)) return;
    this._straight.push({ t: now, v });
    while (this._straight.length > 2 && now - this._straight[0].t > 2000) this._straight.shift();
  }

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
      this.cue('backknee', null, 'warn', now, 10000);
    }
    if (f.trunkLean > 38 && bent < 146) {
      this.cue('lean', null, 'warn', now, 10000);
    }

    const standing = bent >= this.exitLine && bothBent >= this.exitLine - 8;

    switch (this.stage) {
      case 'up':
        // 站着的时候记下「自己最直能到多少度」：回到站姿的判定线跟着自己的幅度走
        this.rememberStraight(bent, now);
        // 下蹲要“持续”住才算这一轮开始（滤掉单帧抖动）
        if (bent <= this.enterLine) {
          if (!this.bendSince) this.bendSince = now;
          if (now - this.bendSince >= LUNGE.enterHoldMs) {
            this.stage = 'descending';
            this.repStartAt = this.bendSince;
            this.minFront = bent;
            this.minBoth = bothBent;
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
        // 两条腿同时最弯的那一帧：较直的那条腿弯到多少度（计次要看它）
        this.minBoth = Math.min(this.minBoth, bothBent);
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

  /** 计数诊断（🐞 面板显示）：站姿线 / 本轮最弯的前膝 / 上次为什么没计上 */
  diag() {
    return [
      { key: 'debug.diag.stage', value: this.stage },
      { key: 'debug.diag.standLine', value: Math.round(this.standLine) },
      { key: 'debug.diag.repMin', value: Math.round(this.minFront) },
      { key: 'debug.diag.bothMin', value: `${Math.round(this.minBoth)}/${Math.round(this.bothLine)}` },
      { key: 'debug.diag.counts', value: `${this.validReps}/${this.partialReps}` },
      ...(this.lastReject ? [{ key: 'debug.diag.reject', reject: this.lastReject }] : []),
    ];
  }

  finish(f, now) {
    const dur = now - this.repStartAt;
    this.stage = 'up';
    this.phase = 'up';
    this.repStartAt = 0;
    this.bendSince = 0;
    this.upSince = 0;

    // 宽松模式：前膝弯进 countLine（默认 152°，比站姿弯 25° 以上）就算一次 ——
    // **不要求前膝 90°**，只要动作大体做到位就计次数（用户明确要求）。
    // 沉得不够的，只提示“下沉不够 / 后膝再低一点”，不再把次数吃掉。
    // 严格模式：既要深度达标，又要真的沉到 downKnee 以内。
    const bentEnough = this.topLine - this.minFront;   // 这一轮比自己站直时弯了多少度
    // 两条腿都要弯：只看前膝的话，前腿点一下就凑一次（用户反馈「计次太松」）
    const bothOk = this.minBoth <= this.bothLine;
    const deepEnough = (!this.strict && this.minFront <= this.countLine)
      || (this.depthOk && (!this.strict || this.minFront <= LUNGE.downKnee));
    if (bentEnough < LUNGE.minBend) {
      // 只是晃了一下：连半程都不记，也不出声
      this.reject('moreRange', `${Math.round(bentEnough)}°`);
      return;
    }
    if (!bothOk) {
      // 两腿都要沉：只有前腿弯下去不算一次（用户明确要求「两个膝盖都有一定弯曲度」）
      this.partialReps += 1;
      this.reject('bothKnees', `${Math.round(this.minBoth)}°/${Math.round(this.bothLine)}°`);
      this.cue('bothKnees', null, 'warn', now, 8000);
      this.emit({ type: 'rep', valid: false, reason: 'bothKnees' });
      this.nextCycle(now);
      return;
    }
    if (!deepEnough) {
      this.partialReps += 1;
      this.reject('depth', `${Math.round(this.minFront)}°/${Math.round(this.countLine)}°`);
      this.cue('lungeDepth', null, 'warn', now, 8000);
      this.emit({ type: 'rep', valid: false, reason: 'depth' });
      this.nextCycle(now);
      return;
    }
    if (this.minFront <= LUNGE.tempoDepth && dur < LUNGE.minRepMs) {
      this.partialReps += 1;
      this.reject('tempo', `${Math.round(dur)}ms`);
      this.cue('tempo', null, 'warn', now, 3000);
      this.emit({ type: 'rep', valid: false, reason: 'tempo' });
      this.nextCycle(now);
      return;
    }
    // 计数放宽了，但深度不够还是要出声纠正（分数也已经按深度打了折扣）
    if (!this.depthOk) this.cue('lungeDepth', null, 'warn', now, 12000);

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
 * 关键教训（用户实测「做了好几个只记 1 个」的根因）：
 *   原来「回到 145° 才算推起来」是一个**绝对角度**，而侧拍时肘角是二维投影、
 *   又经过平滑，手臂明明伸直了读数也可能只有 140° 左右 —— 于是这一轮**永远不结算**，
 *   后面每一次下放都被并进同一轮里，十次变成一次。
 *   所以现在「顶位」是**跟着用户自己的幅度走**的（topBase 慢慢跟踪他实际能举到的最高角度，
 *   上限仍然是 145°），只要回到自己顶位附近就算这一轮完成。
 * 另外：一轮最多 9 秒，超时也会**强制结算**（够深就计数），绝不把次数悄悄吞掉。
 *
 * 三档肘角的意义：
 *   elbowUp      参考顶位（145°，只在用户能举得更高时才用它）
 *   looseElbow   宽松模式的计数线（135°）
 *   elbowFull    拿满分深度的线（118°）
 */
const PUSHUP = {
  activeTorso: 32,
  activeShoulderClear: 0.12,
  activeHandOnFloor: 0.62,
  elbowUp: 145,       // 参考顶位（原来 152，要求手臂几乎全直）
  elbowEnter: 138,    // 起步角度参考值（实际用「顶位基准 − 22°」判断，见 step）
  elbowDown: 120,     // 下放到这里算「到过底部」
  elbowFull: 118,     // 满分深度
  looseElbow: 135,    // 宽松模式计数线
  ignoreElbow: 146,   // 没弯过这里 = 只是晃了一下（相对判定用，见 minBend）
  minBend: 12,        // 一轮至少要比「自己的顶位」弯这么多度才算一次尝试（滤掉噪声）
  enterDrop: 22,      // 相对顶位弯下去这么多才算「开始做」
  returnTol: 8,       // 回到顶位 8° 以内算「推起来了」
  minRepMs: 260,      // 用时下限（只滤手抖）
  maxRepMs: 9000,     // 一轮最长时限：超时强制结算，不吞次数
  bodyStraightMin: 138,
  /**
   * 肩膀下沉量（单位：躯干长，见 metrics.js 的 shoulderClear）。
   *
   * 摄像头摆在桌面上斜着往下拍时，画面里**看不到胸口贴地**，2D 投影还会把肘角
   * 压得比真实更“直”（实测同一次俯卧撑在不同机位下相差 20° 以上），于是肘角判据
   * 经常判不出深度。这里补一路与肘角无关的深度证据：撑起时肩离地约 0.9~1.2 个躯干长，
   * 压到底时只剩 0.3~0.5 —— 只要肩膀整体沉下去这么多，就认为身体确实接近地面了。
   */
  dropMin: 0.20,      // 沉这么多 = 算「身体接近地面」，宽松模式可以计次
  dropFull: 0.40,     // 沉这么多 = 深度给满分（严格模式下也认这个深度）
  dropStart: 0.10,    // 沉这么多 = 认为「这一轮开始了」（肘角读数被压平时靠这一路起头）
  dropDecay: 0.01,    // 顶位基准的缓慢回落（跟着用户姿势漂移，不会一直卡在最高点）
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
    // 顶位基准 + 最近 1.5 秒的肘角：判断「回到顶位」用（见 topLine / backLine）
    this.topBase = PUSHUP.elbowUp;
    this._recent = [];
    this._recentAt = undefined;
    // 肩膀下沉量（第二路深度证据，见 PUSHUP.dropMin）
    this.clearBase = 0;
    this.minClear = 9;
  }
  onLost() { this.stage = 'up'; this.repStartAt = 0; }
  onNewCycle() { this.cycleLowered = false; }

  /** 俯撑判据：躯干接近水平 + 肩离地 + 手撑在地面上（站姿时手在腰侧，离地很高） */
  isProne(f) {
    return f.torsoIncl > PUSHUP.activeTorso
      && f.shoulderClear > PUSHUP.activeShoulderClear
      && f.wristClear < PUSHUP.activeHandOnFloor;
  }

  /** 这一轮的「顶位」：用户自己刚才举到的最高角度（不越过参考值 145°） */
  get topLine() {
    if (!this._recent.length) return Math.min(this.topBase, PUSHUP.elbowUp);
    const max = Math.max(...this._recent.map((r) => r.v));
    return Math.min(Math.max(max, PUSHUP.elbowDown), PUSHUP.elbowUp);
  }

  /** 「推起来」的判定线：回到自己顶位附近，或者手臂确实伸直了 */
  get backLine() {
    return Math.min(this.topLine - PUSHUP.returnTol, PUSHUP.elbowUp - PUSHUP.returnTol);
  }

  /** 这一轮肩膀总共往下沉了多少（躯干长为单位）；负值当 0 处理 */
  get drop() { return Math.max(0, this.clearBase - this.minClear); }

  /** 肩膀已经明显沉下去了：肘角读数被机位压平时，靠这一路认出「开始做了」 */
  get sankEnough() { return this.drop >= PUSHUP.dropStart; }

  /** 深度够不够（两路证据取其一：肘角压下去了，或者肩膀确实沉到接近地面） */
  get deepByDrop() { return this.drop >= PUSHUP.dropMin; }

  /** 计数诊断（🐞 面板显示）：结算线 / 本轮最小肘角 / 跟踪到的顶位 / 上次为什么没计上 */
  diag() {
    return [
      { key: 'debug.diag.stage', value: this.stage },
      { key: 'debug.diag.backLine', value: Math.round(this.backLine) },
      { key: 'debug.diag.repMin', value: Math.round(this.minElbow) },
      { key: 'debug.diag.topBase', value: Math.round(this.topLine) },
      { key: 'debug.diag.drop', value: `${this.drop.toFixed(2)}/${PUSHUP.dropMin}` },
      { key: 'debug.diag.counts', value: `${this.validReps}/${this.partialReps}` },
      ...(this.lastReject ? [{ key: 'debug.diag.reject', reject: this.lastReject }] : []),
    ];
  }

  /**
   * 记住最近 1.5 秒的肘角（估用户自己的顶位，见 topLine 的说明）。
   * 注意：一轮进行中不能把缓冲清空 —— 否则结算时只剩「参考顶位」，
   * 手臂伸不直的人就永远回不到那条线，次数又会被吞掉；所以至少保留最早的两个值。
   */
  rememberElbow(v, now) {
    if (!Number.isFinite(v)) return;
    this._recent.push({ t: now, v });
    while (this._recent.length > 2 && now - this._recent[0].t > 1500) this._recent.shift();
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

    // 姿势提醒适度即可：同一句至少隔 9 秒（用户反馈「语音提示太多，缺少鼓励」）
    if (f.hipLineDev > 0.13) this.cue('sag', null, 'warn', now, 9000);
    else if (f.hipLineDev < -0.13) this.cue('pike', null, 'warn', now, 9000);

    switch (this.stage) {
      case 'up':
        this.rememberElbow(elbow, now);
        this.topBase = clamp(Math.max(elbow, this.topBase - 0.2), 90, 179);
        // 撑起的顶位：肩离地高度的基准（掉头回升后会跟着漂移，见 dropDecay）
        if (Number.isFinite(f.shoulderClear)) {
          this.clearBase = Math.max(f.shoulderClear, this.clearBase - PUSHUP.dropDecay);
          // 顶位上「本轮最低点」就是当前高度：让 drop 表示「相对顶位沉了多少」，
          // 否则上一轮的 minClear 会残留下来，一站回顶位就被当成已经沉下去了。
          this.minClear = f.shoulderClear;
        }
        // 起步：相对自己的顶位弯下去 enterDrop 度，或者已经到达计数线（135°），
        // 这样「手肘伸不直」的人也能被认出来；再或者**肩膀已经明显沉下去了**
        // —— 摄像头斜着往下拍时肘角读数会被压平，只能靠肩膀的高度起头。
        if (elbow <= Math.max(this.topLine - PUSHUP.enterDrop, PUSHUP.looseElbow) || this.sankEnough) {
          this.stage = 'descending';
          this.repStartAt = now;
          this.minElbow = elbow;
          this.minBody = f.bodyStraight;
          this.maxSag = f.hipLineDev;
          this.minSag = f.hipLineDev;
          this.minClear = f.shoulderClear;
        }
        break;
      case 'descending':
      case 'bottom':
        this.minElbow = Math.min(this.minElbow, elbow);
        this.minBody = Math.min(this.minBody, f.bodyStraight);
        this.maxSag = Math.max(this.maxSag, f.hipLineDev);
        this.minSag = Math.min(this.minSag, f.hipLineDev);
        // 一路记「肩膀最低沉到哪」，结算时用它当第二路深度证据
        if (Number.isFinite(f.shoulderClear)) this.minClear = Math.min(this.minClear, f.shoulderClear);
        if (elbow <= PUSHUP.elbowDown && this.stage === 'descending') this.stage = 'bottom';
        // 回到「自己的顶位」附近、并且肩膀确实抬回起点高度，就算推起来了。
        // 只看肘角不够：肩膀沉了但肘角读数几乎没变时（斜机位），
        // 会在进入的下一帧就被判成「太快」，真正做的一轮反而被吞掉。
        // 注意这里的「抬回起点」看的是**当前**肩高（不是本轮最低点）。
        const backUp = !Number.isFinite(f.shoulderClear)
          || (this.clearBase - f.shoulderClear) <= PUSHUP.dropStart;
        const pushedUp = elbow >= this.backLine && backUp;
        if (pushedUp) this.finish(f, now, false);
        else if (now - this.repStartAt > PUSHUP.maxRepMs) this.finish(f, now, false);
        break;
      default:
        break;
    }
  }

  finish(f, now, aborted = false) {
    const dur = now - this.repStartAt;
    this.stage = 'up';
    this.repStartAt = 0;
    // 只是晃了一下（比自己的顶位弯得还不够 12°，肩膀也没沉下去）：
    // 连半程都不记，也不出声
    if (this.topLine - this.minElbow < PUSHUP.minBend && !this.sankEnough) {
      this.reject('moreRange', `${Math.round(this.topLine - this.minElbow)}°/${this.drop.toFixed(2)}`);
      return;
    }
    const full = this.minElbow <= PUSHUP.elbowFull;
    const bodyOk = this.minBody >= PUSHUP.bodyStraightMin;
    // 深度两路证据：肘角压到位，**或者**肩膀确实沉下去接近地面了。
    // 后者专治「摄像头看不到胸口贴地」——斜视角下肘角读数被压直，只看肘角会漏判。
    const elbowLine = this.strict ? PUSHUP.elbowFull : PUSHUP.looseElbow;
    const deepEnough = this.minElbow <= PUSHUP.elbowFull || this.drop >= PUSHUP.dropFull;
    // 严格模式仍然要求「深度确实到位」，不允许只沉一点的半程蒙混过关
    const looseEnough = !this.strict
      && (this.minElbow <= elbowLine || this.drop >= PUSHUP.dropMin);

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
      this.reject('depth', `${Math.round(this.minElbow)}°/${elbowLine}°·${this.drop.toFixed(2)}/${PUSHUP.dropMin}`);
      this.cue('depth', null, 'warn', now, 3000);
      this.emit({ type: 'rep', valid: false, reason: 'depth' });
      this.nextCycle(now);
      return;
    }
    if (!aborted && dur < PUSHUP.minRepMs) {
      this.partialReps += 1;
      this.reject('tempo', `${Math.round(dur)}ms`);
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
    // 质量分按「下放深度」给：压到 elbowFull 以内（或肩膀沉到接近地面）满分，
    // 只到宽松线就少一截 —— 摄像头看不到贴地时按肩膀下沉量给同样的分。
    const depthGain = this.minElbow <= PUSHUP.elbowFull || this.drop >= PUSHUP.dropFull ? 30
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
      this.cue('sag', null, 'warn', this._lastT || 0, 9000);
    } else if (f.hipLineDev < -PLANK.hipDevMax) {
      this.cue('pike', null, 'warn', this._lastT || 0, 9000);
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
