/**
 * 识别器基类。
 *
 * 单独放在这里（而不是 exercises.js 里）是为了让「通用引擎」（engines.js）
 * 也能继承它，同时避免 exercises.js ↔ engines.js 的循环依赖。
 *
 * 基类负责与"动作"无关的公共部分：
 *   - 要领计分（steps.js 的步骤清单）
 *   - 提示音/语音提示的生成与节流
 *   - 丢帧处理、快照输出
 */

import { clamp } from './geometry.js';
import { getStepPlan } from './steps.js';

export class DetectorBase {
  constructor(meta, opts = {}) {
    this.meta = meta;
    // 默认「宽松」：跟界面默认一致——大体做到了就计次数，动作不标准只用语音纠正。
    // 想严格（必须沉到位才算一次）时由 App 传 { strict: true }。
    this.strict = opts.strict === true;
    this.plan = getStepPlan(meta.id, meta);
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
    this.lastReject = null;   // 最近一次「没计上」的原因（诊断面板显示）
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
   * 动作没有专门写这条文案时退回通用的 `cue.<code>`（60+ 动作不可能每个都写全）。
   */
  cue(code, params = null, level = 'warn', now = performance.now(), throttleMs = 4500) {
    const last = this._cueAt.get(code) || -Infinity;
    if (now - last < throttleMs) return;
    this._cueAt.set(code, now);
    const key = resolveCueKey(this.meta.id, code);
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

  /**
   * 一行「计数诊断」文本：给 🐞 识别指标面板用。
   *
   * 为什么要有它：用户反馈「做了好几个只记几次」时，光看关节角度是查不出来的 ——
   * 必须能看到识别器的**内部判定状态**（现在处在哪一阶段、这一轮的最小值、
   * 「回到起始位」的判定线在哪、上一次为什么没计上）。各识别器覆盖这个方法来补自己的字段。
   */
  /**
   * 记一笔「这次没计上，因为…」。只给诊断面板用，不影响计数。
   * 存的是**提示码 + 数值**（不存文案），界面再按语言渲染
   * —— src/ 里不写死任何语言的文字。
   */
  reject(code, value = null) {
    this.lastReject = { code, value };
  }

  /**
   * 计数诊断（结构化）：给 🐞 识别指标面板用。
   * 返回 [{ key: i18n 键, value }] 或 [{ key, reject: {code, value} }]，
   * 各识别器覆盖它来补自己的内部状态（阶段、判定线、本轮最小值…）。
   */
  diag() {
    const steps = this.plan && this.plan.steps ? this.stepStatus() : [];
    const out = [
      { key: 'debug.diag.stage', value: this.stage || 'idle' },
    ];
    if (steps.length) out.push({ key: 'debug.diag.steps', value: `${steps.filter((s) => s.done).length}/${steps.length}` });
    out.push({ key: 'debug.diag.counts', value: `${this.validReps}/${this.partialReps}` });
    if (this.lastReject) out.push({ key: 'debug.diag.reject', reject: this.lastReject });
    return out;
  }

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

/**
 * 提示文案的键：优先用动作专属文案（cues.<动作>.<code>），
 * 没有的话退回通用文案（cue.<code>）。用延迟 import 避免与 i18n 形成初始化顺序问题。
 */
let hasKeyFn = null;
export function setCueKeyResolver(fn) { hasKeyFn = fn; }

function resolveCueKey(exerciseId, code) {
  const specific = `cues.${exerciseId}.${code}`;
  if (!hasKeyFn) return specific;
  try {
    if (hasKeyFn(specific)) return specific;
    if (hasKeyFn(`cue.${code}`)) return `cue.${code}`;
  } catch { /* ignore */ }
  return specific;
}

/* ------------------------------------------------------------------ *
 * 计时类基类
 * ------------------------------------------------------------------ */

export class HoldDetector extends DetectorBase {
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
        this.standby = r.reason ? resolveCueKey(this.meta.id, r.reason) : 'status.holdPaused';
        if (r.reason) this.cue(r.reason, null, 'warn', now, 5000);
      }
    }
  }
}
