/**
 * 识别逻辑的自动化测试。
 *
 * 做法：用合成骨架“演”出标准动作与各种常见错误动作，跑完整识别管线
 * （LandmarkSmoother → toMetric → computeFrame → Detector），
 * 检查计数、计时、判定与提示是否符合预期。
 *
 * 运行：node tests/test-detectors.mjs [--dump]
 */

import { toMetric, LandmarkSmoother, LM } from '../src/geometry.js';
import { computeFrame } from '../src/metrics.js';
import { createDetector } from '../src/exercises.js';
import { t, setLang } from '../src/i18n.js';
import {
  ASPECT, standingPose, pronePose, supinePose, twoLegPose, lostFrame,
} from './synthetic-pose.mjs';

const DT = 1000 / 30;
const DUMP = process.argv.includes('--dump');
setLang('zh', { persist: false });

let passed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function near(name, actual, expect, tol) {
  ok(name, Math.abs(actual - expect) <= tol, `实际 ${actual.toFixed(2)}，期望 ${expect}±${tol}`);
}
function atLeast(name, actual, min) {
  ok(name, actual >= min, `实际 ${actual}，至少 ${min}`);
}

/** 把帧序列喂给检测器 */
function makeRunner(det, { smooth = true } = {}) {
  const smoother = new LandmarkSmoother();
  let t = 0;
  const cues = [];
  const reps = [];
  const holds = [];
  const steps = [];
  const bonuses = [];
  const points = [];
  let lastFrame = null;

  function step(lm) {
    const raw = lm.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0, visibility: p.visibility ?? 1 }));
    const sm = smooth ? smoother.apply(raw, t / 1000) : raw;
    const metric = toMetric(sm, ASPECT);
    const f = computeFrame(metric, null, t, false, null);
    lastFrame = f;
    const evs = det.update(f, t);
    for (const e of evs) {
      if (e.type === 'cue') cues.push(e);
      if (e.type === 'rep') reps.push(e);
      if (e.type === 'hold') holds.push(e);
      if (e.type === 'step') steps.push(e);
      if (e.type === 'bonus') bonuses.push(e);
      if (e.type === 'points') points.push(e);
    }
  }

  return {
    det,
    cues,
    reps,
    holds,
    steps,
    bonuses,
    points,
    get frame() { return lastFrame; },
    get now() { return t; },
    stepIds() { return steps.map((s) => s.id); },
    /** segments: [{ pose: fn(p)=>landmarks | landmarks, ms, label }] */
    run(segments) {
      for (const seg of segments) {
        const n = Math.max(1, Math.round(seg.ms / DT));
        for (let i = 0; i < n; i++) {
          const p = n === 1 ? 1 : i / (n - 1);
          const lm = typeof seg.pose === 'function' ? seg.pose(p) : seg.pose;
          step(lm);
          t += DT;
        }
      }
      return this;
    },
    /** 只喂同一姿势若干帧（等平滑器收敛），返回最后一帧指标 */
    peek(lm, frames = 45) {
      for (let i = 0; i < frames; i++) { step(lm); t += DT; }
      return lastFrame;
    },
  };
}

function fresh(id, opts) { return createDetector(id, opts); }

/** 把一个“一次循环”的姿势函数展开成 count 次重复的帧序列 */
function repeat(poseFn, cycleMs, count) {
  return Array.from({ length: count }, () => ({ pose: poseFn, ms: cycleMs }));
}

const lerp = (a, b, p) => a + (b - a) * p;

/* ------------------------------------------------------------------ *
 * 动作参数（合成骨架）
 * ------------------------------------------------------------------ */

const squatPose = (kneeMin) => (p) => {
  // p: 0→1 一个完整循环
  const s = Math.sin(Math.PI * p);
  const knee = 178 - (178 - kneeMin) * s;
  return standingPose({
    knee,
    lean: 6 + (178 - knee) * 0.28,
    armDown: (178 - knee) * 0.45,
    ankleX: 1.0,
  });
};

const lungeStanding = {
  hip: { x: 0.85, y: 0.41 },
  front: { thighUp: 180, shinUp: 0 },
  back: { thighUp: 180, shinUp: 0 },
  lean: 8, armDown: 0, elbow: 172,
};
const lungeBottom = {
  hip: { x: 0.85, y: 0.62 },
  front: { thighUp: 95, shinUp: 5 },
  back: { thighUp: 195, shinUp: 100 },
  lean: 8, armDown: 10, elbow: 168,
};
/** depth=1 为完整下沉，depth<1 模拟“只蹲了一半”的箭步蹲 */
function lungeMix(depth = 1) {
  const bottom = {
    hip: { x: lungeBottom.hip.x, y: lerp(lungeStanding.hip.y, lungeBottom.hip.y, depth) },
    front: {
      thighUp: lerp(lungeStanding.front.thighUp, lungeBottom.front.thighUp, depth),
      shinUp: lerp(lungeStanding.front.shinUp, lungeBottom.front.shinUp, depth),
    },
    back: {
      thighUp: lerp(lungeStanding.back.thighUp, lungeBottom.back.thighUp, depth),
      shinUp: lerp(lungeStanding.back.shinUp, lungeBottom.back.shinUp, depth),
    },
  };
  return (p) => {
    const s = Math.sin(Math.PI * p);
    return twoLegPose({
      hip: {
        x: lerp(lungeStanding.hip.x, bottom.hip.x, s),
        y: lerp(lungeStanding.hip.y, bottom.hip.y, s),
      },
      front: {
        thighUp: lerp(lungeStanding.front.thighUp, bottom.front.thighUp, s),
        shinUp: lerp(lungeStanding.front.shinUp, bottom.front.shinUp, s),
      },
      back: {
        thighUp: lerp(lungeStanding.back.thighUp, bottom.back.thighUp, s),
        shinUp: lerp(lungeStanding.back.shinUp, bottom.back.shinUp, s),
      },
      lean: lerp(lungeStanding.lean, lungeBottom.lean, s),
      armDown: lerp(lungeStanding.armDown, lungeBottom.armDown, s),
    });
  };
}

const pushupTop = { hip: { x: 1.0, y: 0.68 }, bodyTilt: 63, elbow: 172, armDown: 0, sag: 0 };
const pushupBottom = { hip: { x: 1.0, y: 0.80 }, bodyTilt: 80, elbow: 85, armDown: -30, sag: 0 };
function pushupMix(sagFn = () => 0) {
  return (p) => {
    const s = Math.sin(Math.PI * p);
    return pronePose({
      hip: { x: lerp(pushupTop.hip.x, pushupBottom.hip.x, s), y: lerp(pushupTop.hip.y, pushupBottom.hip.y, s) },
      bodyTilt: lerp(pushupTop.bodyTilt, pushupBottom.bodyTilt, s),
      elbow: lerp(pushupTop.elbow, pushupBottom.elbow, s),
      armDown: lerp(pushupTop.armDown, pushupBottom.armDown, s),
      sag: sagFn(p),
    });
  };
}

const bridgeFlatPose = (p) => supinePose({
  hip: { x: 0.75, y: 0.89 },
  thighUp: 50, knee: 100, torsoUp: 270, armDown: -90, elbow: 178,
});
const BRIDGE_FLAT = { hipY: 0.89, thighUp: 50, knee: 100, torsoUp: 270 };
const BRIDGE_TOP = { hipY: 0.68, thighUp: 90, knee: 90, torsoUp: 233.5 };
const bridgePose = (p, toTop = true) => {
  const s = toTop ? Math.sin(Math.PI * p) : 1;
  const a = toTop ? BRIDGE_FLAT : BRIDGE_TOP;
  const b = toTop ? BRIDGE_TOP : BRIDGE_FLAT;
  return supinePose({
    hip: { x: lerp(0.75, 0.80, s), y: lerp(a.hipY, b.hipY, s) },
    thighUp: lerp(a.thighUp, b.thighUp, s),
    knee: lerp(a.knee, b.knee, s),
    torsoUp: lerp(a.torsoUp, b.torsoUp, s),
    armDown: -90, elbow: 178,
  });
};

// 小臂平板支撑：身体线 78°、肘 90°、手撑地
const plankPose = (opts = {}) => pronePose({
  hip: opts.hip ?? { x: 0.95, y: 0.75 },
  bodyTilt: opts.bodyTilt ?? 78,
  elbow: 90,
  armDown: 0,
  sag: opts.sag ?? 0,
});

const standingIdle = standingPose({ knee: 178, lean: 6, armDown: 0, ankleX: 1.0 });

/* ------------------------------------------------------------------ *
 * 指标自检（阈值调好后这些值就是回归基线）
 * ------------------------------------------------------------------ */

console.log('\n[0] 指标基线');
{
  const r = makeRunner(fresh('squat'));
  const fStand = r.peek(standingIdle);
  if (DUMP) console.log('   站立:', dump(fStand));
  ok('站立：膝角≈180', Math.abs(fStand.kneeAngle - 180) < 6, `knee=${fStand.kneeAngle?.toFixed(1)}`);
  ok('站立：髋远高于膝', fStand.hipBelowKnee === false);

  const deep = r.peek(standingPose({ knee: 88, lean: 30, armDown: 40, ankleX: 1.0 }));
  if (DUMP) console.log('   深蹲底:', dump(deep));
  ok('深蹲底：大腿接近水平', deep.thighFromHoriz < 25, `thigh=${deep.thighFromHoriz?.toFixed(1)}`);
  ok('深蹲底：膝角≈88', Math.abs(deep.kneeAngle - 88) < 6, `knee=${deep.kneeAngle?.toFixed(1)}`);

  const half = r.peek(standingPose({ knee: 128, lean: 18, armDown: 25, ankleX: 1.0 }));
  ok('半蹲：大腿明显高于水平', half.thighFromHoriz > 32, `thigh=${half.thighFromHoriz?.toFixed(1)}`);

  const fPlank = r.peek(plankPose());
  if (DUMP) console.log('   平板:', dump(fPlank));
  ok('平板：躯干接近水平', fPlank.torsoIncl > 55, `incl=${fPlank.torsoIncl?.toFixed(1)}`);
  ok('平板：身体成一条线', fPlank.bodyStraight > 165, `body=${fPlank.bodyStraight?.toFixed(1)}`);

  const fFlat = r.peek(bridgeFlatPose(1));
  if (DUMP) console.log('   仰卧:', dump(fFlat));
  ok('仰卧：髋未抬起', fFlat.hipRise < 0.15, `rise=${fFlat.hipRise?.toFixed(3)}`);

  const fTop = r.peek(supinePose({
    hip: { x: 0.80, y: BRIDGE_TOP.hipY }, thighUp: BRIDGE_TOP.thighUp,
    knee: BRIDGE_TOP.knee, torsoUp: BRIDGE_TOP.torsoUp, armDown: -90, elbow: 178,
  }));
  if (DUMP) console.log('   臀桥顶:', dump(fTop));
  ok('臀桥顶：髋明显抬起', fTop.hipRise > 0.35, `rise=${fTop.hipRise?.toFixed(3)}`);

  const fProne = r.peek(pronePose({ hip: { x: 1.0, y: 0.68 }, bodyTilt: 63, elbow: 172, armDown: 0 }));
  if (DUMP) console.log('   俯撑:', dump(fProne));
  ok('俯撑：肩离地明显', fProne.shoulderClear > 0.5, `clear=${fProne.shoulderClear?.toFixed(2)}`);
}

function dump(f) {
  if (!f || !f.ok) return '(无效帧)';
  const g = (k, n = 1) => (Number.isFinite(f[k]) ? f[k].toFixed(n) : 'NaN');
  return `knee=${g('kneeAngle')} hipAng=${g('hipAngle')} elbow=${g('elbowAngle')} body=${g('bodyStraight')} `
    + `incl=${g('torsoIncl')} thighH=${g('thighFromHoriz')} rise=${f.hipRise.toFixed(3)} shClear=${f.shoulderClear.toFixed(2)} `
    + `knClear=${f.kneeClear.toFixed(2)} wrClear=${f.wristClear.toFixed(2)} lineDev=${f.hipLineDev.toFixed(3)} view=${f.view}`;
}

/* ------------------------------------------------------------------ *
 * 深蹲
 * ------------------------------------------------------------------ */

console.log('\n[1] 深蹲计数');
{
  const det = fresh('squat');
  const r = makeRunner(det);
  r.run(repeat(squatPose(88), 1600, 10));
  ok('10 次标准深蹲 = 10', det.validReps === 10, `实际 ${det.validReps}`);
  ok('无半程误记', det.partialReps === 0, `实际 ${det.partialReps}`);
}
{
  const det = fresh('squat');
  const r = makeRunner(det);
  r.run(repeat(squatPose(88), 1600, 3));
  const base = det.validReps;
  r.run([{ pose: standingIdle, ms: 800 }]);
  r.run(repeat(squatPose(88), 1600, 3));
  ok('中途站直休息不影响累计', det.validReps === base + 3, `实际 ${det.validReps}，期望 ${base + 3}`);
}
{
  const det = fresh('squat');
  const r = makeRunner(det);
  r.run(repeat(squatPose(130), 1600, 6));
  ok('6 次半蹲不计入有效次数', det.validReps === 0, `实际 ${det.validReps}`);
  atLeast('半蹲被记为半程并提示', det.partialReps, 5);
  ok('提示了“蹲低一点”', r.cues.some((c) => c.code === 'depth' || c.code === 'depthAborted'), r.cues.map((c) => c.code).join(','));
}
{
  const det = fresh('squat');
  const r = makeRunner(det);
  r.run(repeat(squatPose(88), 500, 6));
  ok('过快抖动不计数', det.validReps === 0, `实际 ${det.validReps}`);
  ok('提示了速度太快', r.cues.some((c) => c.code === 'tempo'));
}
{
  const det = fresh('squat');
  const r = makeRunner(det);
  r.run(repeat(squatPose(145), 1200, 4));
  ok('轻微晃动不产生半程记录', det.partialReps === 0 && det.validReps === 0,
    `有效 ${det.validReps} / 半程 ${det.partialReps}`);
}
{
  const det = fresh('squat');
  const r = makeRunner(det);
  r.run([{ pose: standingIdle, ms: 3000 }]);
  ok('静立 3 秒计 0 次', det.validReps === 0 && det.partialReps === 0);
  ok('静立时仍处于可训练状态', det.active === true);
}
{
  // 跟踪丢失后不应串数
  const det = fresh('squat');
  const r = makeRunner(det);
  r.run(repeat(squatPose(88), 1600, 1));
  r.run([{ pose: lostFrame(), ms: 1000 }]);
  r.run(repeat(squatPose(88), 1600, 1));
  ok('丢失跟踪后重连：2 次', det.validReps === 2, `实际 ${det.validReps}`);
}

/* ------------------------------------------------------------------ *
 * 箭步蹲
 * ------------------------------------------------------------------ */

console.log('\n[2] 箭步蹲计数');
{
  const det = fresh('lunge');
  const r = makeRunner(det);
  r.run(repeat(lungeMix(1), 1800, 8));
  ok('8 次标准箭步蹲 = 8', det.validReps === 8, `实际 ${det.validReps}`);
  ok('半程误记应为 0', det.partialReps === 0, `实际 ${det.partialReps}`);
  ok('提示左右交替', r.cues.some((c) => c.code === 'alternate'));
}
{
  const det = fresh('lunge');
  const r = makeRunner(det);
  r.run(repeat(lungeMix(0.55), 1800, 5));
  ok('浅箭步蹲不计有效次数', det.validReps === 0, `实际 ${det.validReps}`);
  atLeast('浅箭步蹲被记为半程', det.partialReps, 4);
  ok('提示下沉不够', r.cues.some((c) => c.code === 'lungeDepth' || c.code === 'backknee'));
}

/* ------------------------------------------------------------------ *
 * 俯卧撑
 * ------------------------------------------------------------------ */

console.log('\n[3] 俯卧撑计数');
{
  const det = fresh('pushup');
  const r = makeRunner(det);
  r.run(repeat(pushupMix(), 1400, 8));
  ok('8 次标准俯卧撑 = 8', det.validReps === 8, `实际 ${det.validReps}`);
  ok('无半程误记', det.partialReps === 0, `实际 ${det.partialReps}`);
}
{
  const det = fresh('pushup');
  const r = makeRunner(det);
  r.run(repeat(pushupMix(() => 0.15), 1400, 4));
  ok('塌腰俯卧撑不计数', det.validReps === 0, `实际 ${det.validReps}`);
  atLeast('塌腰被记为半程', det.partialReps, 3);
  ok('提示塌腰', r.cues.some((c) => c.code === 'sag' || c.code === 'pike'));
}
{
  const det = fresh('pushup');
  const r = makeRunner(det);
  r.run([{ pose: standingIdle, ms: 3000 }]);
  ok('站姿不会被误判为俯卧撑', det.validReps === 0 && det.active === false);
  ok('站姿给出准备姿势提示', typeof det.standby === 'string' && det.standby.length > 0);
}
{
  const det = fresh('pushup');
  const r = makeRunner(det);
  r.run(repeat(pushupMix(), 1400, 3));
  r.run([{ pose: standingIdle, ms: 800 }]);
  ok('俯卧撑后立刻站起不再计数', det.validReps === 3 && det.active === false,
    `有效 ${det.validReps}, active=${det.active}`);
}

/* ------------------------------------------------------------------ *
 * 臀桥（计数）
 * ------------------------------------------------------------------ */

console.log('\n[4] 臀桥计数');
{
  const det = fresh('bridge');
  const r = makeRunner(det);
  r.run(repeat((p) => bridgePose(p), 1800, 10));
  ok('10 次臀桥 = 10', det.validReps === 10, `实际 ${det.validReps}`);
  ok('无半程误记', det.partialReps === 0, `实际 ${det.partialReps}`);
}
{
  const det = fresh('bridge');
  const r = makeRunner(det);
  r.run([{ pose: bridgeFlatPose, ms: 4000 }]);
  ok('仰卧不动计 0 次', det.validReps === 0 && det.partialReps === 0);
  ok('仰卧时处于可训练状态', det.active === true);
}
{
  const det = fresh('bridge');
  const r = makeRunner(det);
  r.run([{ pose: standingIdle, ms: 3000 }]);
  ok('站姿不会被误判为臀桥', det.active === false && det.validReps === 0);
  ok('提示需要躺下', r.cues.some((c) => c.code === 'notSupine'));
}
{
  // 顶到一半就落下：不给有效次数
  const det = fresh('bridge');
  const r = makeRunner(det);
  const half = (p) => {
    const s = Math.sin(Math.PI * p) * 0.5; // 只顶到一半高度
    return supinePose({
      hip: { x: lerp(0.75, 0.80, s), y: lerp(BRIDGE_FLAT.hipY, BRIDGE_TOP.hipY, s) },
      thighUp: lerp(BRIDGE_FLAT.thighUp, BRIDGE_TOP.thighUp, s),
      knee: lerp(BRIDGE_FLAT.knee, BRIDGE_TOP.knee, s),
      torsoUp: lerp(BRIDGE_FLAT.torsoUp, BRIDGE_TOP.torsoUp, s),
      armDown: -90, elbow: 178,
    });
  };
  r.run(repeat(half, 1800, 4));
  ok('半程臀桥不计数', det.validReps === 0, `实际 ${det.validReps}`);
  ok('提示顶高一点', r.cues.some((c) => c.code === 'riseMore'));
}

/* ------------------------------------------------------------------ *
 * 平板支撑（计时）
 * ------------------------------------------------------------------ */

console.log('\n[5] 平板支撑计时');
{
  const det = fresh('plank');
  const r = makeRunner(det);
  r.run([{ pose: plankPose(), ms: 5000 }]);
  near('撑住 5 秒 ≈ 计时 5 秒', det.holdMs / 1000, 5, 0.45);
  ok('记录到开始计时事件', r.holds.some((h) => h.action === 'start'));
}
{
  const det = fresh('plank');
  const r = makeRunner(det);
  r.run([{ pose: plankPose(), ms: 5000 }]);
  r.run([{ pose: plankPose({ sag: 0.16 }), ms: 3000 }]); // 塌腰 3 秒
  ok('塌腰时暂停计时', det.holdMs / 1000 < 5.6, `实际 ${(det.holdMs / 1000).toFixed(2)}`);
  ok('提示塌腰', r.cues.some((c) => c.code === 'sag'));
  r.run([{ pose: plankPose(), ms: 3000 }]);
  near('恢复后继续累计 ≈ 8 秒', det.holdMs / 1000, 8, 0.6);
}
{
  const det = fresh('plank');
  const r = makeRunner(det);
  r.run([{ pose: standingIdle, ms: 4000 }]);
  ok('站姿不产生计时', det.holdMs === 0 && det.active === false);
}
{
  const det = fresh('plank');
  const r = makeRunner(det);
  // 瞬间抖动 200ms 不应中断本组
  r.run([{ pose: plankPose(), ms: 2000 }]);
  r.run([{ pose: plankPose({ sag: 0.16 }), ms: 300 }]);
  r.run([{ pose: plankPose(), ms: 2000 }]);
  near('短暂识别抖动不中断计时', det.holdMs / 1000, 4, 0.5);
}

/* ------------------------------------------------------------------ *
 * 静态臀桥（计时）
 * ------------------------------------------------------------------ */

console.log('\n[6] 静态臀桥计时');
{
  const det = fresh('bridgehold');
  const r = makeRunner(det);
  const holdTop = supinePose({
    hip: { x: 0.80, y: BRIDGE_TOP.hipY }, thighUp: BRIDGE_TOP.thighUp,
    knee: BRIDGE_TOP.knee, torsoUp: BRIDGE_TOP.torsoUp, armDown: -90, elbow: 178,
  });
  r.run([{ pose: holdTop, ms: 6000 }]);
  near('顶住 6 秒 ≈ 计时 6 秒', det.holdMs / 1000, 6, 0.45);
}
{
  const det = fresh('bridgehold');
  const r = makeRunner(det);
  // 躺平不顶起来 → 不计时
  r.run([{ pose: bridgeFlatPose, ms: 3000 }]);
  ok('躺着不顶不计时', det.holdMs === 0, `实际 ${(det.holdMs / 1000).toFixed(2)}`);
  ok('提示顶起来', r.cues.some((c) => c.code === 'rise'));
}
{
  const det = fresh('bridgehold');
  const r = makeRunner(det);
  r.run([{ pose: standingIdle, ms: 3000 }]);
  ok('站姿不计时', det.holdMs === 0 && det.active === false);
}

/* ------------------------------------------------------------------ *
 * 要领计分
 * ------------------------------------------------------------------ */

console.log('\n[7] 按动作要领计分');
{
  // 深蹲：整轮要领全过 = 4+6+7+14+8 = 39，外加满分奖励 6
  const det = fresh('squat');
  const r = makeRunner(det);
  r.run(repeat(squatPose(88), 1600, 10));
  ok('深蹲 10 次满分：要领分累计正确', det.score >= 10 * 45 && det.score <= 10 * 45 + 10,
    `得分 ${det.score}（期望 450~460）`);
  ok('“蹲到大腿接近水平”每轮都拿到分', r.steps.filter((s) => s.id === 'parallel').length === 10,
    `实际 ${r.steps.filter((s) => s.id === 'parallel').length} 次`);
  ok('每轮都触发“要领全过”奖励', r.bonuses.length === 10, `实际 ${r.bonuses.length} 次`);
  const order = r.steps.slice(0, 5).map((s) => s.id);
  ok('要领按顺序依次得分', order.join('>') === 'stance>hinge>descend>parallel>stand', order.join('>'));
  ok('每次得分都带着分数与要领文案键', r.steps.every((s) => s.points > 0 && s.labelKey && s.score > 0),
    r.steps.filter((s) => !s.labelKey).length ? '有事件缺 labelKey' : '');
  ok('要领文案键能在词条里取到真实文案', r.steps.every((s) => t(s.labelKey) !== s.labelKey));
  ok('提示事件带着可翻译的键', r.cues.every((c) => c.key && t(c.key) !== c.key));
}
{
  // 半蹲：站姿、屈髋、下沉、站直都能得分，但“蹲到水平”永远拿不到，也没有满分奖励
  const det = fresh('squat');
  const r = makeRunner(det);
  r.run(repeat(squatPose(130), 1600, 6));
  ok('半蹲：拿不到“大腿接近水平”这一步的分',
    !r.steps.some((s) => s.id === 'parallel'), '不应该出现 parallel');
  ok('半蹲：拿不到整轮满分奖励', r.bonuses.length === 0, `实际 ${r.bonuses.length}`);
  ok('半蹲：仍然有部分要领得分', det.score >= 6 * 20, `得分 ${det.score}`);
  ok('半蹲得分明显低于标准深蹲', det.score < 10 * 45, `得分 ${det.score}`);
}
{
  // 箭步蹲：只要站好 + 迈步，就应该开始得分（用户要求的核心反馈）
  const det = fresh('lunge');
  const r = makeRunner(det);
  r.run([{ pose: lungeMix(1), ms: 900 }]); // 只做半程就够触发前几步
  ok('箭步蹲：站好姿势即得第一步分', r.steps.some((s) => s.id === 'stance'));
  ok('箭步蹲：迈步后继续得分', r.steps.some((s) => s.id === 'split') || r.steps.some((s) => s.id === 'stride'));
  ok('箭步蹲：得分顺序符合要领顺序', (() => {
    // 只看第一轮：后续轮次里“站姿”会重新计分，属于正常现象
    const first = [];
    for (const s of r.steps) {
      if (s.id === 'stance' && first.length) break;
      first.push(s.id);
    }
    const want = ['stance', 'split', 'stride', 'sink', 'backknee', 'return'];
    return first.join('>') === want.join('>');
  })(), r.stepIds().join('>'));

  const det2 = fresh('lunge');
  const r2 = makeRunner(det2);
  r2.run(repeat(lungeMix(1), 1800, 8));
  ok('箭步蹲 8 次：每一步要领都反复得分',
    r2.steps.filter((s) => s.id === 'backknee').length === 8,
    `后膝贴地得分 ${r2.steps.filter((s) => s.id === 'backknee').length} 次`);
  ok('箭步蹲 8 次：满分奖励 8 次', r2.bonuses.length === 8, `实际 ${r2.bonuses.length}`);
}
{
  // 俯卧撑
  const det = fresh('pushup');
  const r = makeRunner(det);
  r.run(repeat(pushupMix(), 1400, 8));
  ok('俯卧撑：撑好姿势得分', r.steps.filter((s) => s.id === 'setup').length >= 8);
  ok('俯卧撑：下放到 90° 得高分', r.steps.filter((s) => s.id === 'depth').length === 8,
    `实际 ${r.steps.filter((s) => s.id === 'depth').length}`);
  ok('俯卧撑：满分奖励 8 次', r.bonuses.length === 8, `实际 ${r.bonuses.length}`);
}
{
  // 塌腰俯卧撑：撑好能得分，但幅度与满分拿不到
  const det = fresh('pushup');
  const r = makeRunner(det);
  r.run(repeat(pushupMix(() => 0.15), 1400, 4));
  ok('塌腰俯卧撑：拿不到整轮满分奖励', r.bonuses.length === 0, `实际 ${r.bonuses.length}`);
}
{
  // 臀桥
  const det = fresh('bridge');
  const r = makeRunner(det);
  r.run(repeat((p) => bridgePose(p), 1800, 10));
  ok('臀桥：顶起与顶到最高点都得分',
    r.steps.filter((s) => s.id === 'top').length === 10 && r.steps.filter((s) => s.id === 'lift').length >= 10);
  ok('臀桥：满分奖励 10 次', r.bonuses.length === 10, `实际 ${r.bonuses.length}`);
}
{
  // 计时类：撑住就在加分，里程碑一次比一次高
  const det = fresh('plank');
  const r = makeRunner(det);
  r.run([{ pose: plankPose(), ms: 5000 }]);
  ok('平板支撑：撑好、成一条线各得一次分',
    r.steps.some((s) => s.id === 'setup') && r.steps.some((s) => s.id === 'align'));
  ok('平板支撑：满 3 秒得里程碑分', r.steps.some((s) => s.id === 'hold3'));
  ok('平板支撑：5 秒还拿不到 10 秒里程碑', !r.steps.some((s) => s.id === 'hold10'));
  ok('平板支撑：保持期间每秒都在加分', r.points.length >= 4, `每秒得分 ${r.points.length} 次`);
  ok('平板支撑：总分含每秒得分', det.score >= 8 + 12 + 10 + 4, `得分 ${det.score}`);
}
{
  const det = fresh('bridgehold');
  const r = makeRunner(det);
  const holdTop = supinePose({
    hip: { x: 0.80, y: BRIDGE_TOP.hipY }, thighUp: BRIDGE_TOP.thighUp,
    knee: BRIDGE_TOP.knee, torsoUp: BRIDGE_TOP.torsoUp, armDown: -90, elbow: 178,
  });
  r.run([{ pose: holdTop, ms: 6000 }]);
  ok('静态臀桥：就位与顶到最高点得分',
    r.steps.some((s) => s.id === 'setup') && r.steps.some((s) => s.id === 'lift'));
  ok('静态臀桥：保持 6 秒 ≈ 6 次每秒得分', r.points.length >= 5 && r.points.length <= 7,
    `实际 ${r.points.length}`);
  ok('静态臀桥：总分 = 要领分 + 每秒分', det.score >= 6 + 12 + 10 + 5, `得分 ${det.score}`);
}
{
  // 站着不动只能拿到“站姿”这一步的分，不能反复刷分
  const det = fresh('squat');
  const r = makeRunner(det);
  r.run([{ pose: standingIdle, ms: 5000 }]);
  const ids = new Set(r.stepIds());
  ok('静立只拿到站姿要领分', ids.size === 1 && ids.has('stance'), [...ids].join(','));
  ok('静立得分 = 站姿分', det.score === 4, `得分 ${det.score}`);
  const before = det.score;
  r.run([{ pose: standingIdle, ms: 8000 }]);
  ok('继续静立不会重复加分（无法刷分）', det.score === before, `${before} → ${det.score}`);
}
{
  // 真机侧拍时远侧腿常被躯干遮挡、关键点估歪：
  // 主判定必须只信“看得最清的那一侧”，不能被拖偏
  const bad = standingIdle.map((p) => ({ ...p }));
  bad[LM.R_KNEE] = { ...bad[LM.R_KNEE], x: bad[LM.R_KNEE].x + 0.05, visibility: 0.25 };
  bad[LM.R_ANKLE] = { ...bad[LM.R_ANKLE], x: bad[LM.R_ANKLE].x - 0.04, visibility: 0.25 };
  const det = fresh('squat');
  const r = makeRunner(det);
  const f = r.peek(bad);
  ok('主判定膝角取看得最清的一侧', Math.abs(f.kneeAngle - f.perSide.L.knee) < 0.01,
    `${f.kneeAngle?.toFixed(1)} vs L=${f.perSide.L.knee?.toFixed(1)}`);
  ok('远侧腿估歪也不影响站姿判定', f.kneeAngle > 150 && f.kneeExtended > 150,
    `knee=${f.kneeAngle?.toFixed(1)}`);
  r.run([{ pose: bad, ms: 1500 }]);
  ok('远侧腿估歪时依然能拿到站姿分', det.stepStatus()[0].done === true, `得分 ${det.score}`);
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
