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
import { EXERCISES, EXERCISE_MAP, CATEGORIES, isTimedReps, targetUnitKey } from './catalog.js';
import { createEngineDetector, bodyLift, GATES, GATE_HINT } from './engines.js';

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
  const timed = isTimedReps(meta);
  return {
    ...meta,
    // 限时计数（固定秒数、时间到就结算）：界面要按这个标记换一套说法
    timed,
    name: t(`ex.${id}.name`),
    cameraHint: t(`ex.${id}.cameraHint`),
    goal: t(`ex.${id}.goal`),
    // unit = **成绩**的单位（次数），targetUnit = **目标**的单位（限时/计时类是秒）
    unit: exerciseUnit(id),
    targetUnit: t(targetUnitKey(meta)),
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
/**
 * 阈值表导出是为了让 🎯「运动设定」弹窗显示**真正参与判定的数值**（见 specs.js）：
 * 界面不另抄一份数字，改了这里，界面上的技术指标跟着变，不会出现「说的和判的不一样」。
 */
export const SQUAT = SQUAT_FRONT;

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
    const deepEnough = this.depthOk || this.minRatio <= SQUAT.looseRatio;
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

export const LUNGE = {
  // 判据：**动作大体做到位就算一次**，不要求前膝弯到 90°；但**后面几格要真的弯下去**。
  // 三档膝角：enter 开始算这一轮 → loose 计数线 → down 拿标准深度分。
  standKnee: 142,     // 「回到站姿」的参考门槛（实际跟着用户自己的站姿走，见 standLine）
  enterKnee: 146,     // 「开始这一轮」的参考门槛（实际还会跟 standLine 一起放宽）
  downKnee: 122,      // 「沉到底」阶段（拿整轮满分奖励的深度）
  // 计数线：前膝弯到 138°（≈ 从站直弯下去 35° 以上）才算一次。
  // 用户先要求「即使膝关节没有 90° 也应该计次」，后来又反馈「太灵敏了，后面几个关键帧
  // 对膝盖弯曲的要求可以更大一些」—— 所以计数线从 152° 收到 138°（仍然不要求 90°，
  // 半程箭步蹲照样算，只是「点一下前腿」不再凑数）。
  looseKnee: 138,
  enterDrop: 20,      // 比「自己站得最直时」弯下去这么多度，才算这一轮开始
  minBend: 8,         // 回到自己站姿 8° 以内算这一轮结束；也是「是否算一次尝试」的相对门槛
  recovery: 0.65,     // 从最弯处回升这么多比例就算「回到站姿」（按本轮自己的幅度算）
  // 抖动宽容：膝角必须在门槛内「持续」住才算真的开始/结束一次，
  // 否则跟踪噪声在门槛附近来回跳会造出一堆假的“半程 + 下沉不够”提醒。
  enterHoldMs: 200,
  exitHoldMs: 100,
  bothBentMax: 150,   // 两条腿都算「弯」的门槛（用户要求后几格更严，从 162 收到 150）
  /**
   * 计数门槛：**两条腿都要有弯曲度**（用户反馈「箭步蹲计次太松了」）。
   * 单看前膝的话，只要前腿点一下就能凑一次；这里额外要求「较直的那条腿」
   * 也弯到 bothBentNeeded 以内，或者比用户自己站直时弯下去 bothDrop 度。
   * 取两者中更严的那个，读数被压缩（站直只有 140°）的人也不会被卡死。
   * 数值同样按用户反馈收紧（158 → 146、12° → 18°）。
   */
  bothBentNeeded: 146,
  bothDrop: 18,
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
    // 上下都要夹住：这一轮还没开始时 minFront 还是初始值 180，算出来会是 188°，
    // 那种情况下「回到站姿」永远不成立（进度条最后一格也就永远点不亮）。
    return clamp(
      Math.max(
        this.minFront + LUNGE.minBend,
        Math.min(recovered, this.topLine - LUNGE.minBend),
      ),
      LUNGE.downKnee + 6,
      176,
    );
  }

  /** 用户自己站得最直时量到的膝角（用最近观测；没观测到时按「直腿」起步） */
  get topLine() {
    if (!this._straight.length) return LUNGE.standKnee + 36;
    return Math.max(...this._straight.map((r) => r.v));
  }

  /**
   * 计一次的膝角线：**不要求前膝 90°**（用户明确要求），但也不能只是「点一下」——
   * 138° ≈ 从站直（170° 上下）弯下去 32° 以上；比这更浅的只提示不计数，
   * 而「读数被压缩的人」（站直只有 140°）由自适应的 enter/exit 线兜住，不会乱计数。
   */
  get countLine() { return LUNGE.looseKnee; }

  /**
   * 「两条腿都弯了」的判定线：**较直的那条腿**（后腿）也得弯到这条线以内。
   * 绝对门槛 146° 与「比自己站直时弯下去 18°」取更严的那个 ——
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

    // 只有一个宽松档（用户要求取消严格模式）：前膝弯进 countLine（默认 138°，比站姿弯 35° 以上）就算一次 ——
    // **不要求前膝 90°**，只要动作大体做到位就计次数。
    // 沉得不够的，只提示“下沉不够 / 后膝再低一点”，不再把次数吃掉；深度分照旧按深度打折。
    const bentEnough = this.topLine - this.minFront;   // 这一轮比自己站直时弯了多少度
    // 两条腿都要弯：只看前膝的话，前腿点一下就凑一次（用户反馈「计次太松」）
    const bothOk = this.minBoth <= this.bothLine;
    const deepEnough = this.minFront <= this.countLine || this.depthOk;
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
 *   上限是 PUSHUP.elbowUp），只要回到自己顶位附近就算这一轮完成。
 * 另外：一轮最多 9 秒，超时也会**强制结算**（够深就计数），绝不把次数悄悄吞掉。
 *
 * 四档肘角的意义（**顺序不能反**：顶位 > 开始线 > 计数线 > 满分深度）：
 *   elbowUp      参考顶位（156°，只在用户能举得更高时才用它）→ 回位线 = topLine − returnTol
 *   elbowEnter   「开始这一轮」的参考角度（150°）
 *   looseElbow   宽松模式的计数线（146°）
 *   elbowFull    拿满分深度的线（128°，只影响分数与语音，不影响计次）
 *
 * 第二轮实测放宽（用户：「肘角 ≤ 138° 或肩膀下沉 0.14 太严了，根本计不上」）：
 *   侧拍 + 平滑会把肘角读数**整体压平**，很多人压到极限也只有 145° 左右，
 *   而身体下沉量又和肘角是同一件事的两个面（肘只弯到 146°，肩膀本来就只能沉一点点）。
 *   于是两边一起放宽：肘角计数线 138 → **146**、肩膀下沉计数线 0.14 → **0.08**（躯干长）、
 *   「开始做」从「比顶位弯 22°」放到 **10°**，晃动过滤 12° → **8°**。
 *   实测（合成骨架 + 真实管线）：肘最低 145°（肩膀沉 0.096）现在每次都计上，放宽前一次都不计；
 *   肘最低 148°（肩膀只沉 0.079）仍然不算 —— 计次线和实测边界正好对得上。
 */
export const PUSHUP = {
  activeTorso: 32,
  activeShoulderClear: 0.12,
  activeHandOnFloor: 0.62,
  elbowUp: 170,       // 「顶位」的上限（真人撑起来通常 165~175°；三条线都跟着自己的顶位走，见 countElbow/enterLine/backLine）
  elbowEnter: 150,    // 「开始下沉」的**参考**角度（实际用「自己的顶位 − enterDrop」，见 enterLine）
  elbowDown: 132,     // 顶位基准的下限（手臂伸不直的人也不会低于这里）
  elbowFull: 128,     // 满分深度（只影响深度分与「再低一点」的提醒）
  /**
   * 计数线（宽松模式）：肘角到这条线**就计次** ——
   * 用户最新要求：「**计次不必是人在最低点了**，但是关键帧要优化一下，感觉检测还是不太灵敏」。
   *
   * 以前是「到最低点」那一刻才计次（要求肘角/肩膀先回升一点、或者在底部停 0.18 秒才认），
   * 于是**动作顺下来做的人**要等自己往回推的时候才听到报数 —— 反馈晚、而且连续做的时候
   * 经常感觉「刚才那次没算上」。现在恢复成「下放到深度线的那一帧就计次」：
   * 反馈立刻给（报数/音效/计数跳动同一刻），「推回顶位」只作为**下一轮的前提**。
   *
   * 这条线同时是**跟着人走**的：`countElbow = min(looseElbow, 自己的顶位 − minBend)` ——
   * 手臂伸不直（顶位只有 150°）的人按 142° 算，不会出现「顶位比计数线还低、永远计不上」。
   */
  looseElbow: 146,
  minBend: 8,         // 一轮至少要比「自己的顶位」弯这么多度才算一次（也是计数线的下限来源）
  enterDrop: 6,       // 相对顶位弯下去这么多就算「开始下沉」（进度条第三格）
  returnTol: 8,       // 回到顶位 8° 以内算「推起来了」
  returnGap: 6,       // 「回到顶位」那条线至少要高出计数线这么多度（否则刚计完就会再计一次）
  /**
   * 抖动过滤（**不是**「一轮最短用时」）。
   *
   * 为什么不能用「从离开顶位到计数线」的时长来滤抖：计数线离顶位本来就只有 6~26°（见 countElbow），
   * 这一段真人只要 30~150ms 就穿过去了 —— 拿它当「用时下限」会把每一次正常俯卧撑都判成「太快了」
   * （实测全部变成半程，正是「不灵敏」的来源之一）。
   *
   * 所以改成两个更贴切的守卫：
   *   - `countDwellMs`：深度线要**连续成立**这么久（约 2 帧）才计次 —— 单帧的读数毛刺不会计上，
   *     真人只要压下去就一定会满足，主观上还是「一到线就报数」；
   *   - `minCycleMs`：两次计次之间至少隔这么久（防御性下限；正常一轮远大于它）。
   */
  countDwellMs: 70,
  minCycleMs: 300,
  maxRepMs: 9000,     // 一轮最长时限：超时强制结算，不吞次数
  bodyStraightMin: 138,
  /**
   * 肩膀下沉量（单位：躯干长，见 metrics.js 的 shoulderClear）。
   *
   * 摄像头摆在桌面上斜着往下拍时，画面里**看不到胸口贴地**，2D 投影还会把肘角
   * 压得比真实更“直”（实测同一次俯卧撑在不同机位下相差 20° 以上），于是肘角判据
   * 经常判不出深度。这里补一路与肘角无关的深度证据：撑起时肩离地约 0.9~1.2 个躯干长，
   * 压到底时只剩 0.3~0.5 —— 只要肩膀整体沉下去这么多，就认为身体确实接近地面了。
   *
   * 四个数的关系（**顺序不能反**）：`dropStart < dropReturn < dropMin < dropFull`。
   * `dropReturn` 是收尾用的「肩膀抬回顶位」的宽容度，必须**小于** `dropMin`：
   * 否则「刚开始下沉、肘还没弯」的那一帧会被同时判成「肩膀抬回来了、深度也够了」，
   * 凭空多记一次。
   */
  dropMin: 0.08,      // 沉这么多 = 算「身体接近地面」，可以计次
  dropFull: 0.26,     // 沉这么多 = 深度给满分
  dropStart: 0.04,    // 沉这么多 = 认为「这一轮开始了」（肘角读数被压平时靠这一路起头）
  dropReturn: 0.05,   // 收尾时肩膀要抬回顶位基准这么近（必须 < dropMin，见上面的说明）
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
    // 计数发生在**下放到计数线的那一帧**，推回顶位是下一轮的前提（见 step 的 'recover' 分支）
    this.pendingCycleEnd = false;
    /** 「这一帧肘角到计数线了」——进度条最后一格用它点亮（= 计次那一刻） */
    this.countNow = false;
    /** 深度线连续成立的起点（抖动过滤，见 countDwellMs）；0 = 这一帧还没到线 */
    this.depthSince = 0;
    /** 上一次计次的时刻（两次之间的下限见 minCycleMs；整轮时长也用它） */
    this.lastCountAt = 0;
    /**
     * 最近一次「人在顶位」的时刻 —— 只在第一次计次之前用来估一轮的时长。
     * 注意不能拿它当抖动过滤的基准（见 countDwellMs 的说明）。
     */
    this.lastTopAt = 0;
  }
  onLost() { this.stage = 'up'; this.repStartAt = 0; }
  onNewCycle() { this.cycleLowered = false; }

  /** 俯撑判据：躯干接近水平 + 肩离地 + 手撑在地面上（站姿时手在腰侧，离地很高） */
  isProne(f) {
    return f.torsoIncl > PUSHUP.activeTorso
      && f.shoulderClear > PUSHUP.activeShoulderClear
      && f.wristClear < PUSHUP.activeHandOnFloor;
  }

  /** 这一轮的「顶位」：用户自己刚才举到的最高角度（不越过参考值 elbowUp） */
  get topLine() {
    if (!this._recent.length) return Math.min(this.topBase, PUSHUP.elbowUp);
    const max = Math.max(...this._recent.map((r) => r.v));
    return Math.min(Math.max(max, PUSHUP.elbowDown), PUSHUP.elbowUp);
  }

  /**
   * **计数线**（肘角）：到这条线就计次。
   *   默认 146°；但手臂伸不直的人（顶位只有 150°）按「自己的顶位 − minBend」算，
   *   否则会出现「计数线比他的顶位还低 → 永远计不上」。
   */
  get countElbow() {
    return clamp(Math.min(PUSHUP.looseElbow, this.topLine - PUSHUP.minBend), PUSHUP.elbowFull - 8, PUSHUP.looseElbow);
  }

  /** 「开始下沉」那条线（进度条第三格）：比自己的顶位弯下去 enterDrop 度 */
  get enterLine() {
    return clamp(this.topLine - PUSHUP.enterDrop, PUSHUP.elbowFull, PUSHUP.elbowUp);
  }

  /**
   * 「推起来了」的判定线：回到自己顶位附近（`topLine − returnTol`），
   * 但**必须高出计数线 returnGap 度** —— 否则刚计完一次、肘角还停在计数线上，
   * 立刻又满足「回到顶位」→ 下一轮马上开始 → 同一口气连计好几次。
   */
  get backLine() {
    return Math.max(this.countElbow + PUSHUP.returnGap, Math.min(this.topLine, PUSHUP.elbowUp) - PUSHUP.returnTol);
  }

  /** 这一轮肩膀总共往下沉了多少（躯干长为单位）；负值当 0 处理 */
  get drop() { return Math.max(0, this.clearBase - this.minClear); }

  /** 肩膀已经明显沉下去了：肘角读数被机位压平时，靠这一路认出「开始做了」 */
  get sankEnough() { return this.drop >= PUSHUP.dropStart; }

  /** 计数诊断（🐞 面板显示）：计数线 / 回到顶位的线 / 本轮最小肘角 / 跟踪到的顶位 / 上次为什么没计上 */
  diag() {
    return [
      { key: 'debug.diag.stage', value: this.stage },
      { key: 'debug.diag.countLine', value: `${Math.round(this.countElbow)}/${Math.round(this.enterLine)}` },
      { key: 'debug.diag.backLine', value: Math.round(this.backLine) },
      { key: 'debug.diag.repMin', value: Math.round(this.minElbow) },
      { key: 'debug.diag.topBase', value: Math.round(this.topLine) },
      { key: 'debug.diag.drop', value: `${this.drop.toFixed(2)}/${PUSHUP.dropMin}` },
      { key: 'debug.diag.counts', value: `${this.validReps}/${this.partialReps}` },
      ...(this.lastReject ? [{ key: 'debug.diag.reject', reject: this.lastReject }] : []),
    ];
  }

  /**
   * 记忆最近 1.5 秒的肘角（估用户自己的顶位，见 topLine 的说明）。
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
      // 撑到一半爬起来了 → 按半程收尾，而不是默默不计（此时深度还没到，不会计次）
      if (this.stage === 'descending' || this.stage === 'bottom') this.finish(f, now);
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
        this.trackTop(f, elbow, now);
        // 记下「最近一次真的在顶位」（肘角推回 backLine 之上）—— 只在第一次计次前用来估一轮时长。
        // 这里**不掺「肩膀抬回来了」那条**：肩膀高度在刚开始下沉时几乎没变，
        // 掺进来会把「正在下沉」的那几帧也算成顶位，时长就变成 0 了（踩过）。
        if (elbow >= this.backLine) this.lastTopAt = now;
        // 起步：相对自己的顶位弯下去 enterDrop 度（这样「手肘伸不直」的人也能被认出来）；
        // 或者**肩膀已经明显沉下去了** —— 摄像头斜着往下拍时肘角读数会被压平，只能靠肩膀的高度起头。
        if (elbow <= this.enterLine || this.sankEnough) {
          this.stage = 'descending';
          this.minElbow = elbow;
          this.minBody = f.bodyStraight;
          this.maxSag = f.hipLineDev;
          this.minSag = f.hipLineDev;
          this.minClear = f.shoulderClear;
          this.countNow = false;
          this.depthSince = 0;
        }
        break;
      case 'descending':
      case 'bottom': {
        this.minElbow = Math.min(this.minElbow, elbow);
        this.minBody = Math.min(this.minBody, f.bodyStraight);
        this.maxSag = Math.max(this.maxSag, f.hipLineDev);
        this.minSag = Math.min(this.minSag, f.hipLineDev);
        // 一路记「肩膀最低沉到哪」，结算时用它当第二路深度证据
        if (Number.isFinite(f.shoulderClear)) this.minClear = Math.min(this.minClear, f.shoulderClear);

        /**
         * **计次就发生在下放到计数线的那一帧**（用户最新要求：「计次不必是人在最低点了」）。
         *
         * 两路证据取「或」，谁先到算谁的：
         *   ① **肘角**到计数线（`countElbow`，默认 146°，跟着你自己的顶位走）；
         *   ② **肩膀**下沉够（`dropMin`）—— 斜机位下肘角读数被压平时靠这一路。
         *
         * 以前这里还要等「到最低点」的证据（肘角/肩膀先回升一点，或者在底部停 0.18 秒），
         * 结果**顺下来做的人**要等自己往回推的时候才听到报数：反馈晚，而且连续做的时候
         * 常觉得「刚才那次没算上」。现在把那一刻还给「动作到了深度」这一帧；
         * 「推回顶位」只作为**下一轮的前提**（见 backLine 与 'recover' 分支），
         * 所以在计数线上停着不动不会连着刷次数。
         *
         * 抖动过滤用**连续成立 countDwellMs**（约 2 帧）而不是「一轮最短用时」，原因见 countDwellMs。
         */
        /**
         * 抖动过滤用的是**当前这一帧**的深度（不是「本轮到过的最深」）：
         * 毛刺是「一帧掉到线下、下一帧就回来」，用「到过的最深」永远成立、等于没过滤
         * （实测：一帧 168°→140°→168° 会白记一次）。所以这里看 `depthNow(f)`。
         */
        const atDepth = this.depthNow(f);
        if (atDepth) {
          if (!this.depthSince) this.depthSince = now;
        } else {
          this.depthSince = 0;
        }
        const dwelled = this.depthSince > 0 && now - this.depthSince >= PUSHUP.countDwellMs;
        this.countNow = atDepth && dwelled;
        if (this.countNow) this.finish(f, now);
        else if (this.repStartAt && now - this.repStartAt > PUSHUP.maxRepMs) {
          // 卡在半路太久（比如停在半程不动）：安静地回到「顶位」状态，不刷半程也不出声
          this.stage = 'up';
          this.repStartAt = 0;
        }
        break;
      }
      case 'recover':
        // 刚计完一次，正在推起来：顶位基准照旧跟着走，但要**回到顶位**才算准备好下一次。
        // 判定用 `armsBack()` —— 和「推起还原」那一步要领**同一个条件**（见 armsBack 的说明）：
        // 两条路取「或」：肘角推回 backLine（正路），或者肩膀抬回顶位附近、同时肘角已经
        // 明显离开计数线（斜机位下肘角读数滞后时靠这一路，免得一直卡在 'recover' 里、
        // 后面每一次都计不上 —— 这是「不灵敏」的另一个来源）。
        this.trackTop(f, elbow, now);
        if (this.armsBack(f)) {
          // 一轮到这里才算走完：整轮满分奖励与下一轮的要领清单在这一刻结算/重置，
          // 所以「推起还原 +8」那一格仍然算本轮，而计次本身早就在计数线上给过了（见 finish）。
          if (this.pendingCycleEnd) {
            this.pendingCycleEnd = false;
            this.nextCycle(now);
          }
          this.stage = 'up';
          this.countNow = false;
        }
        break;
      default:
        break;
    }
  }

  /** 顶位基准的跟踪（肘角顶位 + 肩离地基准）—— 「顶位」和「刚计完在推起来」两个状态都要跑 */
  trackTop(f, elbow, now) {
    this.rememberElbow(elbow, now);
    this.topBase = clamp(Math.max(elbow, this.topBase - 0.2), 90, 179);
    if (Number.isFinite(f.shoulderClear)) {
      this.clearBase = Math.max(f.shoulderClear, this.clearBase - PUSHUP.dropDecay);
      // 顶位上「本轮最低点」就是当前高度：让 drop 表示「相对顶位沉了多少」，
      // 否则上一轮的 minClear 会残留下来，一站回顶位就被当成已经沉下去了。
      this.minClear = f.shoulderClear;
    }
  }

  /** 肩膀是不是已经抬回顶位基准附近（用 dropReturn 的宽容度，比「开始做」的 dropStart 松一点） */
  shouldersBack(f) {
    return !Number.isFinite(f.shoulderClear)
      || (this.clearBase - f.shoulderClear) <= PUSHUP.dropReturn;
  }

  /**
   * 这一帧算不算「推起来了」（回到顶位）—— **计次的下一轮前提**，
   * 同时也是「推起还原」那一步要领的判定条件（`steps.js` 的 pushup.press 直接调这个方法）。
   *
   * 两条路取「或」：
   *   ① 肘角推回 `backLine`（跟着自己的顶位走）；
   *   ② 肩膀抬回顶位附近 **且** 肘角明显离开计数线（≥ 计数线 + returnGap）——
   *      斜机位下肘角读数滞后时靠这一路，不至于永远卡在 'recover' 里、后面每一次都计不上。
   *
   * 两者必须是**同一个条件**：以前要领里写的是 ` elbow >= backLine - 2`，
   * 而识别器还能靠肩膀那一路提前退出 'recover' —— 于是那一轮的「推起还原」分数与
   * 整轮满分奖励都拿不到（实测 8 次只有 1 次拿到满轮奖励）。
   */
  armsBack(f) {
    const elbow = f.elbowAngle;
    if (!Number.isFinite(elbow)) return false;
    if (elbow >= this.backLine) return true;
    return this.shouldersBack(f) && elbow >= this.countElbow + PUSHUP.returnGap;
  }

  /** 深度线到了没有（两路证据取「或」）：肘角压到计数线 或 肩膀沉够 —— 到了就计次 */
  depthReached() {
    return (Number.isFinite(this.minElbow) && this.minElbow <= this.countElbow)
      || this.drop >= PUSHUP.dropMin;
  }

  /**
   * **这一帧**的深度证据（两条取「或」）：肘角当前值到计数线，或肩膀当前下沉量到线。
   *
   * 抖动过滤必须看当前帧而不是「本轮到过的最深」（`depthReached`）：单帧毛刺一旦被记进去就永远成立，
   * 过滤等于没做。
   */
  depthNow(f) {
    const elbow = f.elbowAngle;
    const dropNow = Number.isFinite(f.shoulderClear) ? Math.max(0, this.clearBase - f.shoulderClear) : 0;
    return (Number.isFinite(elbow) && elbow <= this.countElbow) || dropNow >= PUSHUP.dropMin;
  }

  finish(f, now) {
    // 整轮时长 = 上一次计次到现在（第一次还没计过时退回「最近一次在顶位」；都没有就不做下限判断）
    const dur = this.lastCountAt ? now - this.lastCountAt : (this.lastTopAt ? now - this.lastTopAt : 0);
    this.repStartAt = 0;
    this.depthSince = 0;
    // 只是晃了一下：肘角比自己的顶位弯得还不够 minBend°，肩膀也没沉到计数线（dropMin）——
    // 连半程都不记，也不出声。
    // 注意这里比的是 **dropMin**（计次线）而不是 dropStart（起头线）：膝盖/肩膀刚一动就
    // 沉到 0.05、肘却没弯的那一帧不能被当成「深度够」，否则会凭空多记一次。
    if (this.topLine - this.minElbow < PUSHUP.minBend && this.drop < PUSHUP.dropMin) {
      this.reject('moreRange', `${Math.round(this.topLine - this.minElbow)}°/${this.drop.toFixed(2)}`);
      this.stage = 'up';
      return;
    }
    const bodyOk = this.minBody >= PUSHUP.bodyStraightMin;
    // 深度两路证据：肘角压到位，**或者**肩膀确实沉下去接近地面了。
    // 后者专治「摄像头看不到胸口贴地」——斜视角下肘角读数被压直，只看肘角会漏判。
    const elbowLine = this.countElbow;
    const deepEnough = this.minElbow <= PUSHUP.elbowFull || this.drop >= PUSHUP.dropFull;
    // 只有宽松一档（用户要求取消严格模式）：肘角读够 或 肩膀沉到线就算一次
    const looseEnough = this.minElbow <= elbowLine || this.drop >= PUSHUP.dropMin;

    // 计数放宽：身体不够直也照样算一次，只是要出声纠正、分数打折（不再有「不直就不算」的严格档）
    if (!deepEnough && !looseEnough) {
      this.partialReps += 1;
      this.reject('depth', `${Math.round(this.minElbow)}°/${elbowLine}°·${this.drop.toFixed(2)}/${PUSHUP.dropMin}`);
      this.cue('depth', null, 'warn', now, 3000);
      this.emit({ type: 'rep', valid: false, reason: 'depth' });
      this.stage = 'recover';   // 这一轮没算：推起来之后重新来过
      this.nextCycle(now);
      return;
    }
    // 两次计次之间的防御性下限（正常一轮远大于它；见 PUSHUP.minCycleMs）
    if (this.lastCountAt && now - this.lastCountAt < PUSHUP.minCycleMs) {
      this.partialReps += 1;
      this.reject('tempo', `${Math.round(now - this.lastCountAt)}ms`);
      this.cue('tempo', null, 'warn', now, 3000);
      this.emit({ type: 'rep', valid: false, reason: 'tempo' });
      this.stage = 'recover';
      this.nextCycle(now);
      return;
    }
    if (!bodyOk) this.cue('body', null, 'warn', now, 3000);
    // 计数放宽了，但沉得不够还是要出声纠正（分数也已经按深度打了折）
    if (!deepEnough) this.cue('depth', null, 'warn', now, 4000);
    this.validReps += 1;
    this.reps = this.validReps;
    this.cycleHadValidRep = true;
    this.lastCountAt = now;
    // 质量分按「下放深度」给：压到 elbowFull 以内（或肩膀沉到接近地面）满分，
    // 只到宽松线就少一截 —— 摄像头看不到贴地时按肩膀下沉量给同样的分。
    // 注意这是**计次那一刻的快照**（计次发生在计数线上，通常还没到最低点）；
    // 「这一轮到底压得多深」体现在「深度」那一步要领的 14 分上（那一步按帧判定，能看到最深处）。
    const depthGain = this.minElbow <= PUSHUP.elbowFull || this.drop >= PUSHUP.dropFull ? 30
      : this.minElbow <= PUSHUP.elbowFull + 6 ? 24
        : this.minElbow <= PUSHUP.elbowFull + 12 ? 18 : 12;
    const quality = clamp(Math.round(56 + depthGain + (this.minBody > 165 ? 10 : bodyOk ? 5 : 0)), 0, 100);
    this.emit({ type: 'rep', valid: true, index: this.validReps, quality, duration: dur });
    /**
     * 计次发生在**下放到计数线的那一帧**（见 step 的 'descending' 分支），
     * 所以这里进入「推起来」状态：回到顶位之后才允许开始下一次（在计数线上停住不会连着刷次数）。
     * 注意**不在这里 `nextCycle()`**：一轮的收尾（整轮满分奖励、下一轮的要领清单）
     * 放到「推回顶位」那一刻结算（见 step 的 'recover' 分支）—— 否则「推起还原 +8」
     * 这一步会被算进下一轮、永远拿不到分。
     */
    this.stage = 'recover';
    this.pendingCycleEnd = true;
    this.countNow = true;
  }
}

/* ------------------------------------------------------------------ *
 * 计数类：臀桥
 * ------------------------------------------------------------------ */

export const BRIDGE = {
  supineTorso: 36,
  kneeMin: 20,
  kneeMax: 160,
  // 肩贴地 / 膝离地：都放宽了（用户反馈「三个关键帧都做对了却不计次」，
  // 实测常见成因是这个门控判得比进度条更严 —— 人都躺好了却被判成「没躺下」）
  shoulderClearMax: 0.7,
  kneeClearMin: 0.12,
  downRise: 0.12,     // 参考的「落回地面」高度（实际判定跟着用户自己的最低点走，见 bottomLine）
  upRise: 0.22,       // 顶起幅度要求（原来 0.35，要顶很高才算）—— 高度法
  /**
   * **角度法**（用户实测后要求补上的判据）：
   * 「我实测髋部抬高到 170° 左右的时候其实就已经到最高点了，可能用这个作为关键帧更为合适。
   *  目前的标准其实无法计数。」
   *
   * 画面上那个「髋」标的就是这个角（肩-髋-膝）：躺平屈膝时约 135°~145°，
   * 顶到「肩-髋-膝 接近一条直线」时约 170°~180°。
   * 只用高度（hipRise）判有两个坑：肩跟着一起抬、或者躯干长的人，明明顶到位了读数也上不去，
   * 于是**永远过不了顶点线、一次都计不上**。所以现在两条路取「或」：
   * **顶得够高** 或 **身体线够直**，都算顶到位。
   */
  liftAngle: 150,     // 「开始顶起来」这一步（动态进度、第二格）
  topAngle: 165,      // 「顶到肩-髋-膝接近一条直线」= 计次那一步（用户实测顶点 ≈170°）
  // 一整轮的时长下限（离开地面 → 落回地面）：只用来滤掉「快速上下抖」，
  // 比人体能做出的最快一次臀桥还短（1 秒 2 次以上一定是抖）。第一次不参与这个判断。
  minRepMs: 420,
};

/**
 * 臀桥的判定（用户指定的三个关键帧：**屈腿仰卧 → 曲腿腰臀顶起 → 落回屈腿仰卧**）。
 *
 * 计次发生在**从顶点落回地面**那一刻 —— 也就是进度条最后一格「落回屈腿仰卧」点亮的同一刻。
 * 这样「三个关键帧都做完」和「记上一个数」永远是同一件事（用户两次反馈的正是这件事：
 * 之前要么在顶点计次、要么固定要求落到 0.12 以下，结果都出现「关键帧都做对了却不计次」）。
 *
 * 两条判定线都**跟着用户自己的幅度走**：
 *   `bottomLine`（落回地面）= 自己这一组的最低点 + 0.08，`topLine`（顶起来）= 最低点 + 0.16（且不低于 0.22）。
 * 每个人躺平时肩-髋高度差并不正好是 0，写死的 0.12 会让「最低点本来就高」的人永远回不到线下。
 */
class GluteBridgeDetector extends DetectorBase {
  onReset() {
    this.stage = 'down';
    this.maxRise = -9;
    this.wasAtTop = false;
    this.prevAtTop = false;
    this.atTop = false;
    this.atBottom = false;
    this.lastRise = 0;
    this.floorLine = null;                // 「自己这一组的最低点」（见 rememberRise）
    this._recent = [];                    // 最近 2.5 秒「没在顶点上」的抬起高度样本
    this.cycleStartAt = 0;                // 这一轮「离开地面」的时刻（算整轮时长用）
  }

  onLost() {
    this.stage = 'down';
    this.wasAtTop = false;
    this.prevAtTop = false;
    this.cycleStartAt = 0;
  }

  onNewCycle() { this.wasAtTop = false; this.cycleStartAt = 0; }

  /** 计数诊断（🐞 面板）：把「顶起线 / 落回线 / 自己这一组的最低点」都摊出来 */
  diag() {
    return [
      { key: 'debug.diag.stage', value: this.stage },
      { key: 'debug.diag.ridgeRise', value: `${this.lastRise.toFixed(2)}/${this.topLine.toFixed(2)}/${this.bottomLine.toFixed(2)}` },
      // 角度法那条线（用户实测顶点 ≈170°）：画面上标的「髋」就是这个数
      { key: 'debug.diag.bridgeAngle', value: `${Number.isFinite(this.lastAngle) ? Math.round(this.lastAngle) : '—'}/${BRIDGE.topAngle}` },
      { key: 'debug.diag.floorLine', value: this.floorLine === null ? '—' : this.floorLine.toFixed(2) },
      { key: 'debug.diag.counts', value: `${this.validReps}/${this.partialReps}` },
      ...(this.lastReject ? [{ key: 'debug.diag.reject', reject: this.lastReject }] : []),
    ];
  }

  /** 仰卧判据：躯干接近水平 + 屈膝 + 肩贴地 + 膝离地 */
  isSupine(f) {
    return f.torsoIncl > BRIDGE.supineTorso
      && f.kneeAngle > BRIDGE.kneeMin && f.kneeAngle < BRIDGE.kneeMax
      && f.shoulderClear < BRIDGE.shoulderClearMax
      && f.kneeClear > BRIDGE.kneeClearMin;
  }

  /**
   * 「自己这一组的最低点」= 最近 2.5 秒里、**没在顶点上**的那些帧的最低值。
   *
   * 为什么需要：原来用固定的 downRise(0.12) 判断「落回地面」，但每个人躺平时
   * 肩-髋高度差并不正好是 0（体态、机位都会带一点偏移）。最低点偏高的人永远回不到
   * 0.12 以下，于是第一次顶点之后再也不计次 —— 正是用户反馈的
   * 「三个关键帧都做对了却不计次」。
   *
   * 为什么把「顶点上的样本」直接丢掉：一直顶在最上面时，最近样本全是高位，
   * 用它们算最低点会把人**在高处判成「落回地面」**，白送一次；而且人从高处开始
   * （进画面时就已经顶起来了）也不会被当成基准。低位的样本过期了就保留上一次的值。
   */
  rememberRise(v, now) {
    if (!Number.isFinite(v)) return;
    if (v > this.topLine) return;      // 顶点附近不算「地面」，不参与基准
    this._recent.push({ t: now, v });
    while (this._recent.length > 3 && now - this._recent[0].t > 2500) this._recent.shift();
    if (!this._recent.length) return;
    this.floorLine = Math.min(...this._recent.map((r) => r.v));
  }

  /** 自己这一组的最低点（还没测到时用参考值） */
  get floorValue() { return this.floorLine === null ? BRIDGE.downRise : this.floorLine; }

  /** 「落回地面」的判定线：回到自己最低点往上 0.08 以内（识别有平滑延迟，贴合太紧会漏计次） */
  get bottomLine() { return this.floorValue + 0.08; }

  /**
   * 「顶起来」的判定线：至少比自己最低点高 0.16（最低点本来就高的人不能一躺下就算顶起）。
   * 因为 topLine 至少比 bottomLine 高 0.08，「已经落回地面」和「还在顶点」不可能同时成立。
   */
  get topLine() { return Math.max(BRIDGE.upRise, this.floorValue + 0.16); }

  /** 这一帧算不算「回到地面」 */
  atBottomNow(rise) { return rise <= this.bottomLine; }

  /**
   * 这一帧算不算「顶到位」：**高度法**（比自己的最低点高 0.16 以上）**或**
   * **角度法**（肩-髋-膝 ≥ `topAngle`，也就是画面上标的那个「髋」）。
   *
   * 为什么要有角度法：用户实测「髋抬到 170° 就已经是最高点了，用它当关键帧更合适，
   * 目前的标准其实无法计数」—— 高度法对「肩也跟着抬」或躯干较长的人读数偏低，
   * 明明顶到位了也永远过不了线。两条路取「或」，谁先到算谁的（宽松模式）。
   * 角度法额外要求「已经稍微离开地面」，免得平躺（肩-髋-膝本来就接近 180°）被算成顶起。
   */
  atTopNow(rise, f) {
    if (rise > this.topLine) { this.topBy = 'rise'; return true; }
    const ang = f?.hipAngle;
    if (Number.isFinite(ang) && ang >= BRIDGE.topAngle && rise > this.bottomLine + 0.02) {
      this.topBy = 'angle';
      return true;
    }
    return false;
  }

  step(f, now) {
    if (!this.isSupine(f)) {
      this.active = false;
      this.standby = 'status.standbyBridge';
      this.stage = 'down';
      this.depthPct = 0;
      this.atTop = false;
      this.atBottom = false;
      this.cycleStartAt = 0;
      if (f.torsoIncl < 35) this.cue('notSupine', null, 'info', now, 8000);
      return;
    }
    this.active = true;
    this.standby = '';
    const rise = f.hipRise;
    this.lastRise = Number.isFinite(rise) ? rise : 0;
    this.lastAngle = Number.isFinite(f.hipAngle) ? f.hipAngle : NaN;
    // 深度条：高度法与角度法各算一个百分比，取大的（哪条路先到 100% 就显示 100%）
    const risePct = clamp((rise / 0.6) * 100, 0, 100);
    const anglePct = Number.isFinite(f.hipAngle)
      ? clamp(((f.hipAngle - BRIDGE.liftAngle) / (BRIDGE.topAngle - BRIDGE.liftAngle)) * 100, 0, 100)
      : 0;
    this.depthPct = Math.max(risePct, anglePct);
    this.rememberRise(rise, now);

    const atTop = this.atTopNow(rise, f);
    const atBottom = this.atBottomNow(rise);
    this.atTop = atTop;
    this.atBottom = atBottom;
    this.stage = atTop ? 'up' : 'down';

    // 这一轮「离开地面」的时刻：用来算整轮时长（滤掉快速上下抖）
    if (!this.cycleStartAt && !atBottom) this.cycleStartAt = now;

    if (atTop && !this.prevAtTop) {
      this.wasAtTop = true;
      this.maxRise = Math.max(this.maxRise, rise);
    } else if (!atTop && !this.wasAtTop && rise > this.bottomLine + 0.03) {
      // 想顶但没顶起来：提示再高一点
      this.cue('riseMore', null, 'warn', now, 3500);
    }
    this.prevAtTop = atTop;

    // 计次 = **从顶点落回地面**那一刻（进度条最后一格「落回屈腿仰卧」点亮的同一刻）
    if (this.wasAtTop && atBottom) {
      const peak = this.maxRise;
      const dur = this.cycleStartAt ? now - this.cycleStartAt : 0;
      this.wasAtTop = false;
      this.maxRise = -9;
      this.cycleStartAt = 0;
      this.phase = 'down';
      if (dur > 0 && dur < BRIDGE.minRepMs) {
        // 快速上下抖一下：不算次数，但出声提示放慢
        this.partialReps += 1;
        this.cue('tempo', null, 'warn', now, 3000);
        this.emit({ type: 'rep', valid: false, reason: 'tempo' });
      } else {
        this.validReps += 1;
        this.reps = this.validReps;
        this.cycleHadValidRep = true;
        this.phase = 'up';
        const quality = clamp(Math.round(60 + (peak > 0.5 ? 30 : 18) + (f.kneeAngle > 80 && f.kneeAngle < 120 ? 10 : 5)), 0, 100);
        this.emit({ type: 'rep', valid: true, index: this.validReps, quality, duration: dur });
      }
      this.nextCycle(now);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 仰卧卷腹（判据按用户给的模型重做）
 * ------------------------------------------------------------------ */

/**
 * 卷腹的判据（**用户给的模型**）：
 *
 * > 「初始关键帧就是屈膝躺下，那么躯干倾角应该是差不多 90 度，膝关节弯曲，应该也在 90 度或者更小。
 * >  真正计次的关键帧，和初始关键帧的变化，应该是**躯干倾角变小了**，与此同时，
 * >  **肩关节到髋关节的长度**因为卷腹而变小，可能只有初始关键帧长度的 **70% 左右**。
 * >  当然，**头部离地**也是一个关键指标。请根据我的描述优化卷腹这个动作的关键帧，让计数更为流畅。」
 *
 * 所以现在是三个信号（前两个是「与起始关键帧的**变化量**」，全部自校准，不写死绝对值）：
 *
 * | 关键帧 | 判据 | 参考值 |
 * |---|---|---|
 * | ① 屈膝躺下（起始姿势） | 躯干接近水平（倾角 ≥62°）+ 屈膝（膝角 25°~118°） | 躺平 ≈90°、屈膝 ≈90° |
 * | ② 卷起来（躯干倾角变小） | 躯干倾角比**自己躺平的基线**小 ≥13° | 卷到位时 ≈65°~75° |
 * | ③ 计次（肩-髋距缩到 70~80% **或** 头离地） | `torsoShrink ≤ 0.80` **或** `headClear ≥ 0.16×躯干长` | 缩到 ≈0.70×、头离地 ≈0.2~0.4× |
 *
 * 为什么要重做：原来是通用屈伸引擎按 **`shoulderClear`（肩离地高度）** 判的，有两个坑 ——
 *   ① 它**依赖校准地面线**（床上/沙发上做、机位偏一点，地面线就落在身体下面，读数整体虚高）；
 *   ② 它除以 `torsoLen`，而 `torsoLen` 就是「肩-髋距离」**本身**：卷腹时这个距离缩小，
 *      于是分母一起变小、读数被放大 —— 越卷越容易满分，判据反而和动作脱钩。
 * 现在直接判**肩-髋距离相对躺平时的比例**（用户说的「只有初始长度的 70% 左右」），
 * 分母是**躺平时的最长值**（自校准），所以读数与机位、体型、离镜头远近都无关。
 *
 * 「让计数更流畅」的几处设计：
 *   - **在卷到位的最高点立刻计次**（和俯卧撑「在最低点计次」同一个思路），
 *     所以「关键帧做完」和「记上一个数」是同一刻，不用等躺回去才结算；
 *   - 三条线都留了余量（用户观察 ≈70%，计次线取 80%；倾角变化取 13°），
 *     幅度小一点、慢一点都能计上；
 *   - 抖动过滤只滤掉「比人能做到的还快」的上下抖（0.32 秒以内一轮），不因为慢而扣次数。
 */
export const CRUNCH = {
  // ---- ① 起始关键帧：屈膝躺下 ----
  lyingTilt: 62,        // 躯干接近水平（0=直立、90=水平）；躺平 ≈90，这里留足余量
  kneeMin: 25,          // 屈膝的下限（腿完全伸直贴地 = 抬腿动作，不是卷腹）
  kneeMax: 118,         // 屈膝的上限（用户说「90 度或者更小」，放宽到 118°）
  /**
   * 还「在不在这个动作里」的宽松门槛（见 step 里的说明）：
   * 卷起来时躯干倾角会掉到 62° 以下，不能因此把它判成「离开了起始姿势」（那会一轮计两次）。
   * 只有明显坐起来（倾角 <35°）或腿伸直（膝角 >140°）才算离开。
   */
  activeTilt: 35,
  activeKneeMax: 140,
  // ---- 基线（自校准）----
  baseTiltFloor: 68,    // 躺到这么平才更新「躺平基线」
  // ---- ② 卷起来 ----
  tiltDrop: 13,         // 躯干倾角比躺平基线小这么多度才算卷起来
  shrinkStart: 0.90,    // 「开始卷起」那一步（进度条第二格）
  // ---- ③ 计次 ----
  shrinkCount: 0.80,    // 肩-髋距缩到躺平时的 80%（用户观察 ≈70%，留余量）→ 计次
  shrinkFull: 0.72,     // 满分深度（≈用户说的 70%）
  headClearCount: 0.16, // 头离地（× 躯干长）—— 与上面的缩距判据取「或」
  // ---- 躺回起始位（下一轮的前提）----
  backShrink: 0.94,     // 肩-髋距回到 94% 以上（参考值：判定用的是「倾角回位 + 进度掉下来」，见 step）
  backTilt: 7,          // 倾角回到基线 7° 以内
  backProgress: 0.30,   // 或三个信号合起来的进度掉到 0.30 以下（幅度小的人也回得来）
  // ---- 抖动过滤 ----
  minRepMs: 320,        // 一次卷腹最快 0.32 秒（比人快的一定是抖；第一次不判）
};

class CrunchDetector extends DetectorBase {
  onReset() {
    this.stage = 'down';
    this.phase = 'down';
    this.baseTilt = 0;      // 躺平基线（躯干倾角的最大值，缓慢衰减以跟上机位变化）
    this.refTorso = 0;      // 躺平时的肩-髋距离（= 用户说的「初始关键帧长度」）
    this.baseHead = NaN;    // 躺平时的头高（头离地用差值：抬头高度 − 躺平时的头高）
    this.torsoShrink = NaN; // 当前肩-髋距 / 躺平时的长度
    this.headUp = NaN;      // 头离地（× 躯干长）
    this.tiltDropNow = 0;
    this.progress = 0;      // 0~1：离「计次线」还有多远（进度条与要领分都用它）
    this.peak = 0;
    this.cycleStartAt = 0;
    this.by = '';           // 这一次是靠哪个信号计上的（缩距 / 头离地）—— 诊断用
  }

  onLost() { this.stage = 'down'; this.phase = 'down'; this.cycleStartAt = 0; }
  onNewCycle() { this.peak = 0; this._minShrink = NaN; this._maxHead = NaN; }

  /** 这一帧算不算「屈膝躺下」（起始关键帧） */
  isLying(f) {
    return f.torsoIncl >= CRUNCH.lyingTilt
      && f.kneeAngle >= CRUNCH.kneeMin && f.kneeAngle <= CRUNCH.kneeMax;
  }

  /** 计数诊断（🐞 面板）：把三个信号和两条线都摊出来 */
  diag() {
    return [
      { key: 'debug.diag.stage', value: this.stage },
      { key: 'debug.diag.torsoTilt', value: `${Number.isFinite(this._lastTilt) ? Math.round(this._lastTilt) : '—'}/${Math.round(this.baseTilt)}` },
      { key: 'debug.diag.torsoShrink', value: `${Number.isFinite(this.torsoShrink) ? this.torsoShrink.toFixed(2) : '—'}/${CRUNCH.shrinkCount}` },
      { key: 'debug.diag.headClear', value: `${Number.isFinite(this.headUp) ? this.headUp.toFixed(2) : '—'}/${CRUNCH.headClearCount}` },
      { key: 'debug.diag.counts', value: `${this.validReps}/${this.partialReps}` },
      ...(this.lastReject ? [{ key: 'debug.diag.reject', reject: this.lastReject }] : []),
    ];
  }

  step(f, now) {
    this._lastTilt = f.torsoIncl;

    /**
     * ⚠️ 两个「在不在这个动作里」的判定必须分开（探针查出来的真 bug）：
     *
     *   - `lying`（起始姿势）：进门的**严格**条件 —— 躯干接近水平 + 屈膝。进度条第一格、
     *     以及建立基线都用它；
     *   - `inExercise`（还在这套动作里）：**宽松**条件 —— 只要人还躺着/卷着、膝还屈着就算。
     *
     * 曾经只用 `lying` 一条：卷起来之后躯干倾角掉到 62° 以下 → 被当成「不在起始姿势」→
     * `phase` 被重置成 'down' → 手一放下又满足计次线 → **一轮计两次**（探针里 4 轮计了 8 次）。
     * 现在只有真正离开动作（坐起来 / 站起来 / 腿伸直）才重置。
     */
    const inExercise = f.torsoIncl >= CRUNCH.activeTilt
      && f.kneeAngle >= CRUNCH.kneeMin && f.kneeAngle <= CRUNCH.activeKneeMax;
    const lying = this.isLying(f);
    this.lying = lying;
    this.gateOk = lying;

    if (!inExercise) {
      // 真的不在这个动作里了：停判，但**保留基线**（用户中途调整一下不该把校准丢掉）
      this.active = false;
      this.curled = false;
      this.topNow = false;
      this.headUp = NaN;
      this.standby = 'status.need.crunchLying';
      this.stage = 'down';
      this.phase = 'down';
      this.depthPct = 0;
      this.progress = 0;
      this.cycleStartAt = 0;
      if (f.torsoIncl < 35) this.cue('notSupine', null, 'info', now, 8000);
      return;
    }
    this.active = true;
    this.standby = '';

    // ---- 自校准基线：躺平的那几帧才更新 ----
    // 倾角基线 = 「自己躺得最平」的读数（缓慢衰减，跟着机位/体态走）
    if (f.torsoIncl >= CRUNCH.baseTiltFloor) {
      this.baseTilt = Math.max(f.torsoIncl, this.baseTilt - 0.12);
    }
    if (!(this.baseTilt > 0)) this.baseTilt = Math.max(f.torsoIncl, CRUNCH.baseTiltFloor);
    this.tiltDropNow = this.baseTilt - f.torsoIncl;
    const curledHalf = this.tiltDropNow >= CRUNCH.tiltDrop * 0.5;
    if (!curledHalf && Number.isFinite(f.torsoLen)) {
      // 肩-髋距基线 = 「自己躺平时的长度」：只有还没卷起来的那几帧参与，取最大值
      this.refTorso = Math.max(f.torsoLen, this.refTorso * 0.9995);
      // 头离地基线 = 躺平时的头高（**相对量**：抬头高度减去躺平时的头高）。
      // 用差值而不是「离地面线的绝对高度」：地面线是校准来的、机位一变就整体平移，
      // 绝对高度会让「躺着」也读到 0.5，差值把这些系统性偏差全部抵消。
      if (Number.isFinite(f.headClear)) {
        this.baseHead = Math.min(f.headClear, this.baseHead + 0.004);
      }
    }
    if (!(this.refTorso > 0) && Number.isFinite(f.torsoLen)) this.refTorso = f.torsoLen;
    if (!Number.isFinite(this.baseHead) && Number.isFinite(f.headClear)) this.baseHead = f.headClear;
    this.torsoShrink = this.refTorso > 0 ? f.torsoLen / this.refTorso : NaN;
    // 本轮卷得最深时缩到了多少（诊断用：看得出来「离计次线还差多少」）；
    // `_deepestShrink` 跨轮不清零 = 这一组卷到过的最深值，`_minShrink` 每轮重置
    this._minShrink = Math.min(Number.isFinite(this._minShrink) ? this._minShrink : 9, this.torsoShrink);
    this._deepestShrink = Math.min(Number.isFinite(this._deepestShrink) ? this._deepestShrink : 9, this.torsoShrink);
    this._maxHead = Math.max(Number.isFinite(this._maxHead) ? this._maxHead : 0, Number.isFinite(this.headUp) ? this.headUp : 0);
    this.headUp = Number.isFinite(f.headClear) && Number.isFinite(this.baseHead)
      ? Math.max(0, f.headClear - this.baseHead)
      : NaN;
    // 识别器把「相对躺平抬起了多少」写回帧上：画面上的「头 x.xx」标注与进度条都读它
    f.headUp = this.headUp;

    // ---- 三个信号 → 进度（与计次线严格对齐：progress ≥ 1 就是计次那一刻）----
    const byTilt = this.tiltDropNow / CRUNCH.tiltDrop;
    const byShrink = Number.isFinite(this.torsoShrink) ? (1 - this.torsoShrink) / (1 - CRUNCH.shrinkCount) : 0;
    const byHead = Number.isFinite(this.headUp) ? this.headUp / CRUNCH.headClearCount : 0;
    const byDepth = Math.max(byShrink, byHead);
    this.progress = clamp(Math.min(byTilt, byDepth), 0, 1);
    this.peak = Math.max(this.peak, this.progress);
    this.depthPct = Math.round(this.progress * 100);
    this.stage = this.progress >= 1 ? 'top' : (this.progress > 0.15 ? 'rising' : 'down');
    // 进度条那三格用的标记（specs.js 的 specStages 直接用它们）：
    this.curled = this.tiltDropNow >= CRUNCH.tiltDrop;      // 「躯干倾角变小了」
    this.topNow = this.progress >= 1;                        // 「缩到 80% 或 头离地」= 计次那一刻
    this.curlLine = this.baseTilt - CRUNCH.tiltDrop;         // 「卷起来」那条动态线（跟着躺平基线走）
    this.shrinkLine = CRUNCH.shrinkCount;                    // 「缩到多少」那条线

    // 卷得不够高：出声提示再卷一点（只在明显开始卷了、又离计次线还远时提示）
    if (this.phase === 'down' && this.progress > 0.35 && this.progress < 0.85 && byTilt > byDepth) {
      this.cue('curlMore', null, 'warn', now, 3500);
    }

    if (this.phase === 'down') {
      if (!this.cycleStartAt) this.cycleStartAt = now;
      if (this.progress >= 1) {
        // ---- 计次：卷到位的最高点立刻记（用户要求「计数更为流畅」）----
        const dur = now - this.cycleStartAt;
        this.by = byShrink >= byHead ? 'shrink' : 'head';
        const peak = this.peak;
        this.cycleStartAt = 0;
        this.phase = 'up';
        if (dur > 0 && dur < CRUNCH.minRepMs) {
          // 比人能做到的还快：只滤抖，不算次数（但要躺回去才能重来）
          this.partialReps += 1;
          this.lastReject = { code: 'tempo', value: `${Math.round(dur)}ms` };
          this.cue('tempo', null, 'warn', now, 3000);
          this.emit({ type: 'rep', valid: false, reason: 'tempo' });
        } else {
          this.lastReject = null;
          this.validReps += 1;
          this.reps = this.validReps;
          this.cycleHadValidRep = true;
          // 质量分：卷得越深越高，屈膝角度合适再加一点（宽松：不标准也计次，只是分低）
          const depthPts = Number.isFinite(this.torsoShrink)
            ? clamp(Math.round(((CRUNCH.shrinkStart - this.torsoShrink) / (CRUNCH.shrinkStart - CRUNCH.shrinkFull)) * 30), 0, 30)
            : 0;
          const kneeOk = f.kneeAngle >= 60 && f.kneeAngle <= 110 ? 8 : 4;
          this.emit({
            type: 'rep', valid: true, index: this.validReps,
            quality: clamp(58 + depthPts + kneeOk, 0, 100), duration: dur,
            // 计次那一刻的三个读数（诊断 / 测试用：看得出来是靠哪条证据计上的）
            shrink: this.torsoShrink, headUp: this.headUp, tiltDrop: this.tiltDropNow, by: this.by,
          });
        }
      }
    } else if (this.tiltDropNow <= CRUNCH.backTilt && this.progress <= CRUNCH.backProgress) {
      // ---- 躺回起始位：下一轮从这里开始 ----
      // 用「倾角回到基线附近 **且** 三个信号合起来的进度掉回 0.30 以下」来判，
      // 而不是单看「肩-髋距回到 94%」：有的人卷腹幅度小、躺平时肩-髋距也回不满，
      // 只盯那一条会永远停在 'up'、后面几次一次都计不上（「计数不流畅」最常见的成因）。
      this.phase = 'down';
      this.stage = 'down';
      this.cycleStartAt = 0;
      this.nextCycle(now);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 计数类：跳箱（画面里画一个箱子，**跳过它**才算一次）
 * ------------------------------------------------------------------ */

/**
 * 跳箱的判定参数（用户要求：「要在视频画面中画出一个箱子让用户跳跃，当用户跳过这个箱子则计一次」）。
 *
 * 口径：
 *   - 画面里画一个**箱子**，箱顶就是判定线（画面上的箱顶 = 判定用的那条线，一处定义不会漂移）；
 *   - **箱子的高度按用户自己的膝高定**（0.55 × 站立膝高 ≈ 25cm 的箱子）：
 *     机位远近、个子高矮都跟着变，不会出现「离得远就永远跳不过去」；
 *   - **脚的最低点越过箱顶**就是一次（`lift = 地面线 − 身体最低点 ≥ 箱高`）：
 *     这正是用户在画面里看到的「人跳到箱子上面去了」；
 *   - 计次发生在**越过箱顶那一帧**（不是落地后），跳过去立刻报数；
 *   - 越过去之后要先落回地面（离地回落到箱高的 45% 以下）才允许下一次，不会连续刷数。
 */
export const BOXJUMP = {
  /** 箱子高度 = 站立时**膝高**的这个比例（0.55 × 膝高 ≈ 25cm 的箱子，跨得过去又不算白给） */
  boxKneeFrac: 0.55,
  /** 膝高基线是「最大值 + 每帧缓慢衰减」：下蹲不会把它拉低，机位慢慢漂移能跟上 */
  baseDecay: 0.0015,
  /** 站姿基线只在这些条件下更新：躯干基本竖直 + 膝接近伸直（下蹲/前倾的读数不参与） */
  baseTiltMax: 25,
  baseKneeMin: 155,
  /** 还没量到基线时的兜底箱高（画面高为单位），以及箱高的上下限 */
  fallbackBox: 0.11,
  minBox: 0.05,
  maxBox: 0.20,
  /**
   * 起跳：离地超过箱高的这个比例就算「脚离地了」。
   * ⚠️ 必须**大于** `landFrac`（迟滞带的方向不能反）：反过来的话，人下落经过「起跳线」时
   * 会被当成又跳了一次，接着就冒出一句「跳得不够高」（探针里真的复现了）。
   */
  takeoffFrac: 0.25,
  /** 落地：离地回落到箱高的这个比例以下，才允许下一次（迟滞带，必须小于 takeoffFrac） */
  landFrac: 0.15,
  /** 蓄力一直不起跳多久才提醒「要跳起来」（正常蓄力不该被念） */
  crouchHintMs: 900,
  /** 「屈膝蓄力」那一格的膝角线（≤ 这个角度 = 蓄好力了） */
  crouchKnee: 150,
  /** 蓄力进度的比例尺：膝角从 168° 弯到 100° 算满 */
  crouchFrom: 168,
  crouchTo: 100,
  /**
   * 两次计次之间最少间隔（滤掉「一两帧的毛刺」）。
   *
   * ⚠️ 写得很小是**故意的**：真人跳起 25cm 只需要约 0.23 秒（自由落体反过来算 `t=√(2h/g)`），
   * 所以「起跳 → 越过箱顶」这段真实时间只有 100~200ms，门槛一大就会把**真跳**也判成「太快」
   * （真跳被吃掉比放过一次毛刺严重得多）。防误触主要靠另外两条**物理**约束：
   *   ① 起跳必须从「脚还在地面附近」（progress < takeoffFrac）**升上来**；
   *   ② 越过去之后必须先落回地面（progress ≤ landFrac）才允许下一次。
   * 这两条已经排掉了抖动：单帧毛刺连「起跳 → 计次」两帧都走不完。
   */
  minRepMs: 90,
  /** 一轮最多这么久（卡在半空/一直不过顶就作废这一轮） */
  maxRepMs: 4000,
  /** 箱子宽度 = 肩宽的倍数，并按上下限夹住（单位都是画面高） */
  widthK: 1.25,
  minWidth: 0.12,
  maxWidth: 0.34,
  /** 箱子的横向跟随（每帧 EMA）：箱子一直在人的正前方，但不会跟着识别抖动左右跳 */
  cxFollow: 0.08,
  /** 箱子离画面左/右边缘至少留这么多（画面宽比例） */
  cxMargin: 0.02,
};

class BoxJumpDetector extends DetectorBase {
  onReset() {
    this.stage = 'ready';        // ready（站在箱子前）→ air（腾空）→ 计次 → 落回 ready
    this.phase = 'ready';
    this.lift = 0;               // 离地高度（画面高为单位）：脚的最低点离地面线多高
    this.progress = 0;           // 0~1：离箱顶还有多远（1 = 脚越过箱顶 = 计次那一刻）
    this.crouchPct = 0;          // 屈膝蓄力进度（0~1）
    this.baseKnee = NaN;         // 站立膝高基线（自校准箱高用）
    this.boxH = BOXJUMP.fallbackBox;
    this.boxCleared = false;     // 这一轮已经越过箱顶（进度条最后一格用它点亮）
    this.landed = false;         // 越过箱顶之后**又落回地面**了（「屈膝缓冲落地」那一步分用它）
    this.peak = 0;               // 这一轮最高跳到箱高的几倍
    this.peakLift = 0;
    this.peakLoaded = false;
    this.cycleStartAt = 0;
    this.clearedAt = 0;
    this.crouchSince = 0;
    /** 最近一次跳跃的结果（诊断用：`peakLift` 每轮会清零，这一份留着看「上次跳了多高」） */
    this.lastJump = { lift: NaN, boxH: NaN, ok: false };
    this.box = null;             // 箱子几何（画面里画它，见 render.js 的 drawBox）
    this._cx = NaN;              // 箱子的横向位置（平滑后的髋-肩中线）
  }

  onLost() {
    this.stage = 'ready';
    this.phase = 'ready';
    this.lift = 0;
    this.progress = 0;
    this.depthPct = 0;
    this.boxCleared = false;
    this.box = null;
    this.cycleStartAt = 0;
    this.clearedAt = 0;
  }

  onNewCycle() { this.peak = 0; this.peakLift = 0; }

  /** 「越过箱顶」那条判定线：动态的（跟着用户自己的膝高走），弹窗与进度条都读它 */
  get boxLine() { return this.boxH; }

  /**
   * 箱子的几何 + 膝高基线。**每帧都要调**（校准 / 倒计时 / 训练中都要看得见箱子），
   * 所以它不参与计数：计数在 step() 里。
   *
   * 返回 `{ cx, w, h, baseY, lift, cleared }`（`cx` 是画面宽比例，`w/h/baseY/lift` 是画面高为单位）：
   * 画面上的箱顶 `baseY - h` 和判定用的那条线**是同一个数**。
   */
  trackBox(f, now) {
    if (!f || !f.ok) {
      this.box = null;
      this.lift = 0;
      return null;
    }
    const ground = Number.isFinite(f.groundRef) ? f.groundRef : f.groundY;
    // 站立膝高（画面高为单位）= 膝离地高度（躯干长为单位）× 躯干长
    const kneeY = Number.isFinite(f.kneeClear) && Number.isFinite(f.torsoLen)
      ? f.kneeClear * f.torsoLen
      : NaN;
    if (Number.isFinite(kneeY) && f.torsoIncl <= BOXJUMP.baseTiltMax && f.kneeExtended >= BOXJUMP.baseKneeMin) {
      this.baseKnee = Number.isFinite(this.baseKnee)
        ? Math.max(kneeY, this.baseKnee - BOXJUMP.baseDecay)
        : kneeY;
    }
    const base = Number.isFinite(this.baseKnee) ? this.baseKnee : NaN;
    this.boxH = clamp(
      (Number.isFinite(base) ? base : BOXJUMP.fallbackBox / BOXJUMP.boxKneeFrac) * BOXJUMP.boxKneeFrac,
      BOXJUMP.minBox,
      BOXJUMP.maxBox,
    );
    // 箱子摆在人的正前方：横向跟着「肩-髋中线」（平滑），高度贴着地面线。
    // ⚠️ 用 `centerXFrac`（**画面宽度比例**）而不是 `centerX` —— 后者是「按宽高比校正过」的
    // 度量坐标（单位 = 画面高度），直接当宽度比例用会让箱子偏到画面右边（实测偏了 0.39）。
    const cxNow = Number.isFinite(f.centerXFrac) ? f.centerXFrac : f.centerX;
    if (Number.isFinite(cxNow)) {
      this._cx = Number.isFinite(this._cx)
        ? this._cx + (cxNow - this._cx) * BOXJUMP.cxFollow
        : cxNow;
    }
    const w = clamp(
      (Number.isFinite(f.shoulderWidth) ? f.shoulderWidth : 0.2) * BOXJUMP.widthK,
      BOXJUMP.minWidth,
      BOXJUMP.maxWidth,
    );
    const aspect = Number.isFinite(f.aspect) && f.aspect > 0 ? f.aspect : 16 / 9;
    const halfX = w / 2 / aspect;      // 箱宽的一半（画面宽比例）= (画面高为单位的宽度) / 宽高比
    const margin = Math.min(BOXJUMP.cxMargin, halfX);
    const cx = Number.isFinite(this._cx)
      ? clamp(this._cx, halfX + margin, 1 - halfX - margin)
      : NaN;
    this.box = (Number.isFinite(ground) && Number.isFinite(cx))
      ? {
        cx, w, h: this.boxH, baseY: ground, lift: this.lift, cleared: this.boxCleared,
      }
      : null;
    return this.box;
  }

  /** 计数诊断（🐞 面板）：箱高、离地高度、上一次跳了多高 */
  diag() {
    const last = this.lastJump || { lift: NaN, ok: false };
    return [
      { key: 'debug.diag.stage', value: this.stage },
      { key: 'debug.diag.boxLine', value: `${this.boxH.toFixed(2)}` },
      { key: 'debug.diag.liftNow', value: `${this.lift.toFixed(2)}/${this.boxH.toFixed(2)}` },
      {
        key: 'debug.diag.jumpPeak',
        value: Number.isFinite(last.lift) ? `${last.lift.toFixed(2)}${last.ok ? '✓' : ''}` : '—',
      },
      { key: 'debug.diag.counts', value: `${this.validReps}/${this.partialReps}` },
      ...(this.lastReject ? [{ key: 'debug.diag.reject', reject: this.lastReject }] : []),
    ];
  }

  step(f, now) {
    const gate = GATES[this.meta.params?.gate || 'stand'];
    const gated = !!gate(f);
    this.gateOk = gated;
    if (!gated) {
      this.active = false;
      this.standby = `status.need.${GATE_HINT[this.meta.params?.gate || 'stand'] || 'stand'}`;
      this.stage = 'ready';
      this.phase = 'ready';
      this.lift = 0;
      this.progress = 0;
      this.depthPct = 0;
      this.boxCleared = false;
      this.cycleStartAt = 0;
      this.trackBox(f, now);
      this.cue('notReady', null, 'info', now, 9000);
      return;
    }
    this.active = true;
    this.standby = '';
    this.trackBox(f, now);

    /**
     * 离地高度 = 地面线 − **身体最低点**（脚）。
     * 用最低点而不是脚踝：要「整个人真的从箱子上过去」，脚掌/脚尖也得跟着上来
     *（`bodyLift` 就是这么定义的，和深蹲跳/开合跳用的是同一个量）。
     */
    const lift = Math.max(0, bodyLift(this, f, now));
    this.lift = lift;
    this.progress = clamp(lift / this.boxH, 0, 1.4);
    this.depthPct = clamp(Math.round(this.progress * 100), 0, 100);
    this.peak = Math.max(this.peak, this.progress);
    this.peakLift = Math.max(this.peakLift, lift);
    this.crouchPct = clamp((BOXJUMP.crouchFrom - f.kneeAngle) / (BOXJUMP.crouchFrom - BOXJUMP.crouchTo), 0, 1);
    if (this.box) this.box.lift = lift;

    /**
     * 实时纠正：**跳得不够高**。
     *
     * 判据写成「已经过了最高点、开始往下落、还是没到箱顶」——不能在「升到一半」时就喊，
     * 否则每一次成功的跳跃在上升途中都会被念一句「再跳高一点」（实测真的会）。
     */
    if (this.phase === 'air' && this.peak < 1 && this.progress < this.peak - 0.06) {
      this.cue('boxLow', { pct: Math.round(this.peak * 100) }, 'warn', now, 2500);
    }
    if (this.phase === 'ready' && this.crouchPct >= 0.5) {
      // 蓄力一直不起跳才提醒「要跳起来」——正常的「蹲一下再跳」不该被念一句
      if (!this.crouchSince) this.crouchSince = now;
      if (now - this.crouchSince > BOXJUMP.crouchHintMs) this.cue('needJump', null, 'info', now, 6000);
    } else {
      this.crouchSince = 0;
    }

    switch (this.phase) {
      case 'cleared':
        // 越过去了：等落回地面（迟滞），才允许下一轮
        this.stage = 'cleared';
        if (this.progress <= BOXJUMP.landFrac) {
          // 落地了：`landed` 留给要领分（「屈膝缓冲落地」那一步）；跳过箱顶的那一轮才算
          this.landed = !!this.boxCleared;
          this.phase = 'ready';
          this.boxCleared = false;
          this.stage = 'ready';
          this.cycleStartAt = 0;
          this.nextCycle(now);
        } else if (now - this.clearedAt > BOXJUMP.maxRepMs) {
          // 一直挂在上面（挂在单杠上？）：放开状态，别锁死
          this.phase = 'ready';
          this.boxCleared = false;
          this.stage = 'ready';
        }
        break;

      case 'air':
        this.stage = 'air';
        if (this.progress >= 1) {
          // ---- 计次：**脚越过箱顶的那一刻**（用户要求「跳过这个箱子则计一次」）----
          const dur = now - this.cycleStartAt;
          this.clearedAt = now;
          this.boxCleared = true;
          this.phase = 'cleared';
          this.stage = 'cleared';
          if (dur > 0 && dur < BOXJUMP.minRepMs) {
            this.partialReps += 1;
            this.reject('tempo', `${Math.round(dur)}ms`);
            this.emit({ type: 'rep', valid: false, reason: 'tempo' });
          } else {
            this.lastReject = null;
            this.validReps += 1;
            this.reps = this.validReps;
            this.cycleHadValidRep = true;
            this.lastJump = { lift: this.peakLift, boxH: this.boxH, ok: true };
            // 质量分：越过箱顶越高越好，蓄力那一下有屈膝再加一点（宽松：不标准也计次，只是分低）
            const over = clamp((this.peak - 1) / 0.4, 0, 1);
            const loadOk = this.peakLoaded ? 8 : 4;
            this.emit({
              type: 'rep', valid: true, index: this.validReps,
              quality: clamp(Math.round(58 + over * 30 + loadOk), 0, 100), duration: dur,
              lift: this.peakLift, boxH: this.boxH,
            });
          }
        } else if (now - this.cycleStartAt > BOXJUMP.maxRepMs) {
          // 跳了半天没过顶：安静地作废这一轮，不刷次数
          this.reject('boxLow', `${this.peakLift.toFixed(2)}<${this.boxH.toFixed(2)}`);
          this.phase = 'ready';
          this.stage = 'ready';
          this.cycleStartAt = 0;
        } else if (this.progress <= BOXJUMP.landFrac && this.peakLift > 0) {
          // 跳了一下又落地了（没过顶）：记一笔「差多少」但不算一次
          this.phase = 'ready';
          this.stage = 'ready';
          this.lastJump = { lift: this.peakLift, boxH: this.boxH, ok: false };
          this.reject('boxLow', `${this.peakLift.toFixed(2)}<${this.boxH.toFixed(2)}`);
          this.cycleStartAt = 0;
          this.nextCycle(now);
        }
        break;

      default:
        // 站在箱子前：屈膝蓄力（`crouchPct`）→ 脚离地进入腾空
        this.stage = this.crouchPct >= 0.3 ? 'crouch' : 'ready';
        if (this.progress >= BOXJUMP.takeoffFrac) {
          this.phase = 'air';
          this.stage = 'air';
          this.cycleStartAt = now;
          this.peak = this.progress;
          this.peakLift = lift;
          this.peakLoaded = this.crouchPct >= 0.35;
          this.landed = false;      // 又起跳了：上一次的「落地」标记作废
        } else if (this.cycleStartAt && now - this.cycleStartAt > BOXJUMP.maxRepMs) {
          this.cycleStartAt = 0;
        }
        break;
    }
  }
}

/* ------------------------------------------------------------------ *
 * 计时类：平板支撑
 * ------------------------------------------------------------------ */

/**
 * 平板支撑的判定（**整体放宽**：大体撑对了就开始计时）。
 *
 * 用户反馈「平板支撑没有计时，可能是规则『手离地高度 ≤ 0.55×躯干长』太严了」，
 * 并且给出了他心里的判据：「**主要是判断关节角度**：肘 90° 左右、肩 90° 左右、
 * 髋膝都在 180 左右、躯干倾角 80° 左右，手离地高度不要太严」。
 * 复现下来完全对得上：**躺得再标准的平板，只要校准地面线比身体低**（床上/沙发上做、
 * 机位偏一点），`wristClear` 就量成 0.68 > 0.55 → 一直提示「手掌/小臂要贴在地面上」、**一秒都不计时**。
 *
 * 所以「撑住了没有」现在改成**两路证据取「或」**，其中主路是**角度**（不依赖地面线）：
 *   ① `shoulderAngle`（髋-肩-肘）落在 [45°, 135°]：上臂明显朝下撑住 ——
 *      实测小臂平板 ≈90°、直臂平板 ≈90°、趴着休息（手臂贴身）≈10°、站着 ≈25°，
 *      所以这一条既放行真正的平板，又能把「趴在地上休息」挡在外面；
 *   ② 老的地面线判据：肩膀离地 ≥0.10 且手离地 ≤0.55（两条同时成立）—— 保留成替代路径，
 *      原来能过的情形现在照样过。
 *
 * 其余仍然是 SOFT（只语音纠正 + 质量分打折，**不打断计时**）：
 * 身体不够直、塌腰/撅臀、膝盖偏低、肘角读数模糊。
 */
export const PLANK = {
  // ---- HARD：撑起来了才开始计时（都是角度判据，不看地面线）----
  torsoIncl: 38,            // 身体接近水平（原来 42）
  shoulderAngleMin: 45,     // 肩关节角下限：上臂要明显离开身体往下撑
  shoulderAngleMax: 135,    // 上限：超过它就变成「手臂贴在身侧」（趴着休息 ≈10°）
  // ---- HARD 的替代路径（老的地面线判据，两条同时成立也算撑住）----
  shoulderClearMin: 0.10,   // 肩离地（原来 0.14）
  handOnFloorMax: 0.55,     // 手/小臂在地面附近（原来 0.45）—— 用户反馈太严，现在只是替代路径
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
    if (f.torsoIncl < PLANK.torsoIncl) {
      return { valid: false, reason: 'pose' };
    }
    // 「撑住了」两路证据取「或」：角度（主路，见 PLANK 的说明）或 老的地面线判据
    const proppedByAngle = Number.isFinite(f.shoulderAngle)
      && f.shoulderAngle >= PLANK.shoulderAngleMin && f.shoulderAngle <= PLANK.shoulderAngleMax;
    const proppedByGround = f.shoulderClear >= PLANK.shoulderClearMin && f.wristClear <= PLANK.handOnFloorMax;
    if (!proppedByAngle && !proppedByGround) {
      // 提示沿用「撑起来」那一句（两条证据都不成立时，最可能的原因就是人还趴在地上）
      return { valid: false, reason: 'lift' };
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
  crunch: CrunchDetector,
  boxJump: BoxJumpDetector,
};

export function createDetector(id, opts = {}) {
  const meta = EXERCISE_MAP[id];
  if (!meta) throw new Error('Unknown exercise: ' + id);
  const Builtin = BUILTIN[id];
  if (Builtin) return new Builtin(meta, opts);
  return createEngineDetector(meta, opts);
}

export { DetectorBase, HoldDetector, CrunchDetector, BoxJumpDetector };
