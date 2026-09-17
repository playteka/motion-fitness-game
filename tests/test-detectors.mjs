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
import {
  Calibrator, OUTLINE, LYING, outlinePath, outlineBounds, outlineKind,
} from '../src/calibration.js';
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

/**
 * 深蹲姿势生成器。
 * 深蹲现在是**正面模式**（判据是「髋比膝高多少 / 小腿长」，不是膝角），
 * 所以这里给 view:'front'。膝角与 hipAboveKnee 的对应关系（实测）：
 *   178° → 1.00 ｜ 145° → 0.90 ｜ 130° → 0.79 ｜ 110° → 0.61 ｜ 88° → 0.35 ｜ 75° → 0.18 ｜ 62° → -0.04
 */
const squatPose = (kneeMin) => (p) => {
  // p: 0→1 一个完整循环
  const s = Math.sin(Math.PI * p);
  const knee = 178 - (178 - kneeMin) * s;
  return standingPose({
    knee,
    lean: 6 + (178 - knee) * 0.28,
    armDown: (178 - knee) * 0.45,
    ankleX: 1.0,
    view: 'front',
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
function pushupMix(sagFn = () => 0, opts = {}) {
  const botElbow = opts.botElbow ?? pushupBottom.elbow;   // 抬高点 = 只放一半
  return (p) => {
    const s = Math.sin(Math.PI * p);
    return pronePose({
      hip: { x: lerp(pushupTop.hip.x, pushupBottom.hip.x, s), y: lerp(pushupTop.hip.y, pushupBottom.hip.y, s) },
      bodyTilt: lerp(pushupTop.bodyTilt, pushupBottom.bodyTilt, s),
      elbow: lerp(pushupTop.elbow, botElbow, s),
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

const standingIdle = standingPose({ knee: 178, lean: 6, armDown: 0, ankleX: 1.0, view: 'front' });

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

  const deep = r.peek(standingPose({ knee: 75, lean: 30, armDown: 40, ankleX: 1.0, view: 'front' }));
  if (DUMP) console.log('   深蹲底:', dump(deep));
  ok('深蹲底：判为正面视角', deep.view === 'front', deep.view);
  ok('深蹲底：髋到膝的高度差已进入“接近水平”区间', deep.hipAboveKnee <= 0.25, `hipAboveKnee=${deep.hipAboveKnee?.toFixed(3)}`);
  ok('深蹲底：大腿确实接近水平', deep.thighFromHoriz < 12, `thigh=${deep.thighFromHoriz?.toFixed(1)}`);

  const half = r.peek(standingPose({ knee: 120, lean: 18, armDown: 25, ankleX: 1.0, view: 'front' }));
  ok('半蹲：髋仍明显高于膝（够不到“接近水平”）', half.hipAboveKnee > 0.25, `hipAboveKnee=${half.hipAboveKnee?.toFixed(3)}`);
  ok('半蹲：不会算成蹲到水平', half.thighFromHoriz > 20, `thigh=${half.thighFromHoriz?.toFixed(1)}`);

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
  r.run(repeat(squatPose(75), 1600, 10));
  ok('10 次标准深蹲 = 10', det.validReps === 10, `实际 ${det.validReps}`);
  ok('无半程误记', det.partialReps === 0, `实际 ${det.partialReps}`);
}
{
  const det = fresh('squat');
  const r = makeRunner(det);
  r.run(repeat(squatPose(75), 1600, 3));
  const base = det.validReps;
  r.run([{ pose: standingIdle, ms: 800 }]);
  r.run(repeat(squatPose(75), 1600, 3));
  ok('中途站直休息不影响累计', det.validReps === base + 3, `实际 ${det.validReps}，期望 ${base + 3}`);
}
{
  const det = fresh('squat');
  const r = makeRunner(det);
  r.run(repeat(squatPose(110), 1600, 6));
  ok('6 次半蹲不计入有效次数', det.validReps === 0, `实际 ${det.validReps}`);
  atLeast('半蹲被记为半程并提示', det.partialReps, 5);
  ok('提示了“蹲低一点”', r.cues.some((c) => c.code === 'depth' || c.code === 'depthAborted'), r.cues.map((c) => c.code).join(','));
}
{
  const det = fresh('squat');
  const r = makeRunner(det);
  r.run(repeat(squatPose(75), 500, 6));
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
  r.run(repeat(squatPose(75), 1600, 1));
  r.run([{ pose: lostFrame(), ms: 1000 }]);
  r.run(repeat(squatPose(75), 1600, 1));
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
  // 默认宽松（跟界面默认一致）：浅一点的箭步蹲也算一次——大体做到了就计次数
  const det = fresh('lunge');
  const r = makeRunner(det);
  r.run(repeat(lungeMix(0.55), 1800, 5));
  atLeast('浅一点的箭步蹲也计数（默认宽松）', det.validReps, 4);
  ok('仍然提示后膝/下沉', r.cues.some((c) => c.code === 'lungeDepth' || c.code === 'backknee'));
}
{
  // 严格模式（界面上的“严格”开关）：必须沉到位才算有效次数
  const det = fresh('lunge', { strict: true });
  const r = makeRunner(det);
  r.run(repeat(lungeMix(0.55), 1800, 5));
  ok('严格模式：浅箭步蹲不计有效次数', det.validReps === 0, `实际 ${det.validReps}`);
  atLeast('严格模式：浅箭步蹲被记为半程', det.partialReps, 4);
  ok('严格模式：提示下沉不够', r.cues.some((c) => c.code === 'lungeDepth'));
}
{
  // 抖动宽容：站姿/踏步时的轻微晃动不能变成“半程 + 下沉不够”的碎碎念
  const det = fresh('lunge');
  const r = makeRunner(det);
  r.run(repeat(lungeMix(0.35), 1800, 4));
  ok('轻微晃动不计数、也不记半程', det.validReps === 0 && det.partialReps === 0,
    `有效 ${det.validReps} / 半程 ${det.partialReps}`);
  ok('轻微晃动不反复提示', r.cues.filter((c) => c.code === 'lungeDepth').length === 0);
}
{
  // 下沉深度扫描：只要真的蹲下去了（> 站姿晃动），要么计进次数，要么给出纠正提示——不留“无声空档”
  const rows = [0.4, 0.45, 0.5, 0.55, 0.6].map((d) => {
    const det = fresh('lunge');
    const r = makeRunner(det);
    r.run(repeat(lungeMix(d), 1800, 2));
    return {
      d,
      valid: det.validReps,
      partial: det.partialReps,
      hint: r.cues.some((c) => c.code === 'lungeDepth' || c.code === 'backknee' || c.code === 'alternate'),
    };
  });
  ok('下沉扫描：没有“既不计次数也不提示”的空档', rows.every((row) => row.valid > 0 || row.hint),
    rows.map((row) => `${row.d}:${row.valid}/${row.partial}${row.hint ? '' : '✗无提示'}`).join(' '));
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
  // 政策：识别与计数都放宽——塌腰也照样算一次（大体做到了就计次数），
  // 但必须用语音/文字把“塌腰”纠正出来，而且拿不到整轮满分奖励（分数仍然体现质量）。
  const det = fresh('pushup');
  const r = makeRunner(det);
  r.run(repeat(pushupMix(() => 0.15), 1400, 4));
  atLeast('塌腰俯卧撑也计数（放宽后）', det.validReps, 3);
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
{
  // 只放到一半（肘 130° 左右）：宽松线（124°）之外，仍然记为半程并提示，但不吃成有效次数
  const det = fresh('pushup');
  const r = makeRunner(det);
  r.run(repeat(pushupMix(() => 0, { botElbow: 130 }), 1400, 4));
  ok('半程俯卧撑不计有效次数', det.validReps === 0, `实际 ${det.validReps}`);
  atLeast('半程俯卧撑记为半程', det.partialReps, 3);
  ok('半程俯卧撑提示再低一点', r.cues.some((c) => c.code === 'depth' || c.code === 'body'));
}
{
  // 默认宽松 / 可选严格：面板上的“严格”开关必须真的改变判据
  ok('默认宽松（跟界面默认一致）', fresh('squat').strict === false && fresh('lunge').strict === false);
  ok('传 strict: true 才严格', fresh('squat', { strict: true }).strict === true);
  const loose = fresh('pushup');
  const strict = fresh('pushup', { strict: true });
  const shallow = repeat(pushupMix(() => 0, { botElbow: 116 }), 1400, 3);
  makeRunner(loose).run(shallow);
  makeRunner(strict).run(shallow);
  ok('放一半多：宽松计次、严格不计次', loose.validReps === 3 && strict.validReps === 0,
    `宽松 ${loose.validReps} / 严格 ${strict.validReps}`);
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
  // 顶到一半就落下：放宽后照样计次（大体做了就算），但仍然要提示“顶高一点”
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
  atLeast('半程臀桥也计数（放宽后）', det.validReps, 3);
  ok('提示顶高一点', r.cues.some((c) => c.code === 'riseMore'));
}
{
  // 第一次顶起没有“上一次顶点”可比较，不能因为缺计时数据就吃掉用户的第一下
  const det = fresh('bridge');
  const r = makeRunner(det);
  r.run(repeat((p) => bridgePose(p), 1800, 1));
  ok('第一次顶起就算一次', det.validReps === 1, `实际 ${det.validReps}`);
  ok('第一次顶起不记为半程“太快”', det.partialReps === 0, `实际 ${det.partialReps}`);
}
{
  // 上下快速抖动（整轮 0.3 秒，远快于人类）：只提示太快，不刷次数
  const det = fresh('bridge');
  const r = makeRunner(det);
  r.run(repeat((p) => bridgePose(p), 300, 8));
  ok('臀桥快速抖动不刷次数', det.validReps <= 1, `实际 ${det.validReps}`);
  ok('臀桥快速抖动提示太快', r.cues.some((c) => c.code === 'tempo'));
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
  r.run(repeat(squatPose(75), 1600, 10));
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
  r.run(repeat(squatPose(110), 1600, 6));
  ok('半蹲：拿不到“大腿接近水平”这一步的分',
    !r.steps.some((s) => s.id === 'parallel'), '不应该出现 parallel');
  ok('半蹲：拿不到整轮满分奖励', r.bonuses.length === 0, `实际 ${r.bonuses.length}`);
  ok('半蹲：仍然有部分要领得分', det.score >= 6 * 18, `得分 ${det.score}`);
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
 * 运动前校准
 * ------------------------------------------------------------------ */

console.log('\n[8] 运动前校准');

/** 把姿势缩放到校准目标大小并摆到画面中间（踝部对齐地面线、身体居中） */
const fitToOutline = (lm, { k = 0.78, centerX = 0.5, groundY = 0.92, dx = 0 } = {}) => {
  const ankleY = Math.max(lm[LM.L_ANKLE].y, lm[LM.R_ANKLE].y);
  const cx = (lm[LM.L_HIP].x + lm[LM.R_HIP].x + lm[LM.L_SHOULDER].x + lm[LM.R_SHOULDER].x) / 4;
  return lm.map((p) => ({
    ...p,
    x: centerX + dx + (p.x - cx) * k,
    y: groundY + (p.y - ankleY) * k,
  }));
};

/** 把一帧关键点跑成校准结果 */
function calibOnce(cal, lm, now) {
  const metric = toMetric(lm.map((p) => ({ ...p, v: p.visibility ?? 1 })), ASPECT);
  const f = computeFrame(metric, null, now, false, null);
  return { f, res: cal.update(f, now) };
}

{
  const standing = (view) => standingPose({ knee: 176, lean: 5, armDown: 0, ankleX: 1.0, view });
  const idleFront = fitToOutline(standing('front'));
  const idleSide = fitToOutline(standing('side'));

  // 1) 站进轮廓里：应该逐项通过并最终判定完成
  const cal = new Calibrator('squat');
  let res = null;
  let t = 0;
  for (let i = 0; i < 60; i++) {
    ({ res } = calibOnce(cal, idleFront, t));
    t += 33.4;
  }
  ok('站进轮廓里：全部检查通过', res.checks.every((c) => c.ok),
    res.checks.filter((c) => !c.ok).map((c) => c.id).join(','));
  ok('站进轮廓里：保持一小会儿后判定校准完成', res.done === true, `progress=${res.progress.toFixed(2)}`);
  ok('校准完成时给出“可以开始”的提示', res.hintKey === 'calib.ready', res.hintKey);
  ok('深蹲要求的机位是正面', cal.view === 'front', cal.view);

  // 1.5) 只有「识别到人体 + 全身在画面里」是必须项，其余都是建议项
  {
    const cal3 = new Calibrator('squat');
    const tiny = calibOnce(new Calibrator('squat'), fitToOutline(standing('front'), { k: 0.2 }), 0).res;
    let r = null;
    let t = 0;
    for (let i = 0; i < 40; i++) { ({ res: r } = calibOnce(cal3, fitToOutline(standing('front'), { k: 0.2 }), t)); t += 33.4; }
    ok('人小一点（离得远）也能开始：距离只是建议项',
      r.ready === true && r.done === true
      && r.checks.find((c) => c.id === 'distance').ok === false,
      `ready=${r.ready} done=${r.done} distance=${r.checks.find((c) => c.id === 'distance').ok}`);
    ok('必须项只有「识别到人体」「全身入镜」两项',
      tiny.checks.filter((c) => c.blocking).every((c) => c.id === 'visible' || c.id === 'framing')
      && tiny.checks.filter((c) => !c.blocking).length === 5,
      tiny.checks.map((c) => `${c.id}:${c.blocking ? '必须' : '建议'}`).join(' '));
    // 站偏、高度不对同样不拦人
    const offC = new Calibrator('squat');
    let roff = null; let t2 = 0;
    for (let i = 0; i < 40; i++) { ({ res: roff } = calibOnce(offC, fitToOutline(standing('front'), { dx: 0.36 }), t2)); t2 += 33.4; }
    ok('站偏一点也能开始：左右只是建议项', roff.ready === true && roff.done === true, String(roff.done));
    // 但被画面切掉（头顶出画）必须拦住
    const cutC = new Calibrator('squat');
    let rcut = null; let t3c = 0;
    for (let i = 0; i < 40; i++) { ({ res: rcut } = calibOnce(cutC, fitToOutline(standing('front'), { k: 1.25 }), t3c)); t3c += 33.4; }
    ok('被画面切掉（头顶出画）必须拦住', rcut.ready === false && rcut.done === false,
      `ready=${rcut.ready} done=${rcut.done} hint=${rcut.hintKey}`);
  }

  // 2) 离得太远（放宽后：身体至少要占画面高度 42%）
  const far = new Calibrator('squat');
  const r2 = calibOnce(far, fitToOutline(standing('front'), { k: 0.25 }), 0).res;
  ok('离太远：距离检查不通过', r2.checks.find((c) => c.id === 'distance').ok === false);
  ok('离太远：提示“往前走一点”', r2.hintKey === 'calib.tooFar', r2.hintKey);

  // 3) 离得太近：放宽后只有在顶到画面边缘时才算不合格（framing 会先报「头顶出画」，
  //    两条提示方向一致，都是让用户往后退）
  const near = new Calibrator('squat');
  const r3 = calibOnce(near, fitToOutline(standing('front'), { k: 1.15 }), 0).res;
  ok('贴到画面边缘：不再是全绿', r3.checks.every((c) => c.ok) === false,
    r3.checks.map((c) => `${c.id}:${c.ok ? '✓' : '✗'}`).join(' '));
  ok('贴到画面边缘：提示往后退', ['calib.headCut', 'calib.tooClose'].includes(r3.hintKey), r3.hintKey);

  // 再近到头顶出画：提示换成“头顶出画了”，方向同样是后退
  const tooNear = new Calibrator('squat');
  const r3b = calibOnce(tooNear, fitToOutline(standing('front'), { k: 1.05 }), 0).res;
  ok('近到头顶出画：给出后退方向的提示', ['calib.headCut', 'calib.tooClose'].includes(r3b.hintKey), r3b.hintKey);

  // 3.5) 大小合适但整体偏得很高：位置检查不通过（放宽后仍要挡住「人在画面上半截」这种离谱情况）
  const high = new Calibrator('squat');
  const r3c = calibOnce(high, fitToOutline(standing('front'), { k: 0.5, groundY: 0.60 }), 0).res;
  ok('身体明显偏高：大小检查通过但位置检查不通过',
    r3c.checks.find((c) => c.id === 'distance').ok === true
    && r3c.checks.find((c) => c.id === 'vertical').ok === false,
    r3c.checks.map((c) => `${c.id}:${c.ok ? '✓' : '✗'}`).join(' '));
  ok('身体明显偏高：提示往下站', r3c.hintKey === 'calib.moveDown', r3c.hintKey);
  ok('身体明显偏高：不会判定校准完成', r3c.done === false);

  // 4) 站偏了（放宽后左右可偏 30%，再偏就该提示了）
  const off = new Calibrator('squat');
  const r4 = calibOnce(off, fitToOutline(standing('front'), { dx: 0.36 }), 0).res;
  ok('站偏了：左右位置检查不通过', r4.checks.find((c) => c.id === 'center').ok === false);
  // 预览默认镜像：原始画面偏右 = 用户看到自己偏左 → 应该提示「往右站」
  ok('站偏了：提示往右站（镜像预览下）', r4.hintKey === 'calib.centerRight', r4.hintKey);

  // 关掉镜像后，方向提示必须反过来
  const offNoMirror = new Calibrator('squat', { mirror: false });
  const r4b = calibOnce(offNoMirror, fitToOutline(standing('front'), { dx: 0.36 }), 0).res;
  ok('关掉镜像后方向提示相反', r4b.hintKey === 'calib.centerLeft', r4b.hintKey);

  // 5) 机位不对：深蹲却侧对镜头
  const wrongView = new Calibrator('squat');
  const r5 = calibOnce(wrongView, idleSide, 0).res;
  ok('深蹲侧对镜头：机位检查不通过', r5.checks.find((c) => c.id === 'view').ok === false);
  ok('深蹲侧对镜头：提示“请正对摄像头”', r5.hintKey === 'calib.viewFront', r5.hintKey);
  ok('机位不对时不判定完成', r5.done === false);

  // 6) 侧拍动作换成正面，也应提示换机位
  const lunge = new Calibrator('lunge');
  ok('箭步蹲要求的机位是侧面', lunge.view === 'side', lunge.view);
  const r6 = calibOnce(lunge, idleFront, 0).res;
  ok('箭步蹲正对镜头：提示“请侧对摄像头”', r6.hintKey === 'calib.viewSide', r6.hintKey);

  // 7) 没识别到人
  const nobody = new Calibrator('squat');
  const r7 = calibOnce(nobody, lostFrame(), 0).res;
  ok('没识别到人：只报“人体识别”这一项不通过', r7.checks.length === 1 && r7.checks[0].ok === false);
  ok('没识别到人：提示看清全身', r7.hintKey === 'calib.visible', r7.hintKey);

  // 8) 一直动来动去
  // 「站定不动」现在只是建议项：晃来晃去照样能开始（用户要求「人在画面里就开始」），
  // 但面板里仍然会把这一项标成没达标，提醒用户站定更稳。
  const moving = new Calibrator('squat');
  let r8 = null;
  for (let i = 0; i < 40; i++) {
    ({ res: r8 } = calibOnce(moving, fitToOutline(standing('front'), { dx: i % 2 ? 0.05 : -0.05 }), i * 33.4));
  }
  ok('来回晃动：站定检查标为不合格（只是建议）', r8.checks.find((c) => c.id === 'steady').ok === false);
  ok('来回晃动：不再拦着开始（必须项仍满足）', r8.ready === true && r8.done === true,
    `ready=${r8.ready} done=${r8.done}`);

  // 9) 校准完成后再动：只要人还在画面里就仍算就位；走出画面才会掉出「已就位」
  const cal2 = new Calibrator('squat');
  let r9 = null;
  for (let i = 0; i < 60; i++) ({ res: r9 } = calibOnce(cal2, idleFront, i * 33.4));
  ok('先完成校准', r9.done === true);
  const r10 = calibOnce(cal2, fitToOutline(standing('front'), { dx: 0.36 }), 60 * 33.4).res;
  ok('偏了一点仍在画面里：依旧算就位（只提示左右建议）', r10.ready === true, String(r10.ready));
  const r10b = calibOnce(cal2, fitToOutline(standing('front'), { dx: 0.9 }), 61 * 33.4).res;
  ok('走出画面后不再处于已就位状态', r10b.ready === false, String(r10b.ready));
  ok('走出画面时提示的是必须项（全身入镜）',
    ['calib.headCut', 'calib.feetCut', 'calib.cutOff'].includes(r10b.hintKey), r10b.hintKey);

  // 9.5) 躺姿动作（俯卧撑 / 平板支撑 / 臀桥 / 静态臀桥）
  // 躺下以后身体是横着的：竖直跨度只剩身体厚度，所以距离要量水平长度、高度要看上下范围，
  // 否则臀桥这类动作永远过不了校准（旧版本就是卡在这里）。
  const lyingFit = (lm, { target = 0.72, groundY = 0.9, dx = 0 } = {}) => {
    const core = [
      LM.NOSE, LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP,
      LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE, LM.L_FOOT, LM.R_FOOT,
    ];
    const xs = core.map((i) => lm[i].x * ASPECT);
    const ys = core.map((i) => lm[i].y);
    const k = target / (Math.max(...xs) - Math.min(...xs));
    const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
    const baseY = Math.max(...ys);
    return lm.map((p) => ({
      ...p,
      x: dx + (0.5 * ASPECT + (p.x * ASPECT - midX) * k) / ASPECT,
      y: groundY - (baseY - p.y) * k,
    }));
  };
  const proneArm = pronePose({ hip: { x: 0.9, y: 0.7 }, bodyTilt: 66, elbow: 172, armDown: 6 });
  const proneForearm = pronePose({ hip: { x: 0.9, y: 0.7 }, bodyTilt: 66, elbow: 92, armDown: 4 });
  const supineLegs = supinePose({ hip: { x: 0.75, y: 0.9 }, armDown: 90 });

  for (const [id, pose, label, highY] of [
    ['pushup', proneArm, '俯卧撑', 0.45],
    ['plank', proneForearm, '平板支撑', 0.45],
    ['bridge', supineLegs, '臀桥', 0.35],
    ['bridgehold', supineLegs, '静态臀桥', 0.35],
  ]) {
    const cal = new Calibrator(id);
    let out = null;
    let tt = 0;
    for (let i = 0; i < 60; i++) {
      ({ res: out } = calibOnce(cal, lyingFit(pose), tt));
      tt += 33.4;
    }
    ok(`${label}：躺姿摆好后能通过校准（修好前这里永远过不了）`, out.done === true,
      out.checks.filter((c) => !c.ok).map((c) => c.id).join(','));
    ok(`${label}：机位要求是侧面`, cal.view === 'side' && cal.lying === true, `${cal.view}/${cal.posture}`);

    const far = calibOnce(new Calibrator(id), lyingFit(pose, { target: 0.33 }), 0).res;
    ok(`${label}：身体太短 → 提示靠近镜头`, far.hintKey === 'calib.tooFar', far.hintKey);
    const near = calibOnce(new Calibrator(id), lyingFit(pose, { target: 1.0 }), 0).res;
    ok(`${label}：身体太长 → 提示离镜头远一点`, near.hintKey === 'calib.tooClose', near.hintKey);
    const off = calibOnce(new Calibrator(id), lyingFit(pose, { target: 0.6, dx: 0.3 }), 0).res;
    ok(`${label}：横着偏了 → 给出左右方向提示`,
      ['calib.centerLeft', 'calib.centerRight'].includes(off.hintKey), off.hintKey);
    const up = calibOnce(new Calibrator(id), lyingFit(pose, { groundY: highY }), 0).res;
    ok(`${label}：整体跑到画面上半部分 → 提示往下挪`, up.hintKey === 'calib.moveDown', up.hintKey);
    const cut = calibOnce(new Calibrator(id), lyingFit(pose, { dx: 0.8 }), 0).res;
    ok(`${label}：身体出画 → 提示回到画面里`, cut.hintKey === 'calib.cutOff', cut.hintKey);
    ok(`${label}：没就位时不会判定完成`, far.done === false && cut.done === false);
  }

  // 9.6) 侧拍时人朝左：轮廓要跟着翻，否则头脚方向是反的
  {
    const ahead = outlinePath('pushup');
    const behind = outlinePath('pushup', { flip: true });
    ok('轮廓支持左右翻转，且是严格镜像',
      ahead.length === behind.length
      && ahead.every((p, i) => Math.abs(p[0] + behind[i][0] - 2 * OUTLINE.centerX) < 1e-9
        && Math.abs(p[1] - behind[i][1]) < 1e-9));
    const mirroredPose = (lm) => lm.map((p) => ({ ...p, x: 1 - p.x }));
    const straight = new Calibrator('pushup');
    const mirrored = new Calibrator('pushup');
    let rs = null; let rm = null;
    let tt = 0;
    for (let i = 0; i < 60; i++) {
      ({ res: rs } = calibOnce(straight, lyingFit(proneArm), tt));
      ({ res: rm } = calibOnce(mirrored, mirroredPose(lyingFit(proneArm)), tt));
      tt += 33.4;
    }
    ok('人朝右时轮廓不翻转', straight.facing === 1, String(straight.facing));
    ok('人朝左时轮廓自动翻转（判定与朝向无关）',
      mirrored.facing === -1 && rm.done === true, `${mirrored.facing}/${rm.done}`);
  }

  // 10) 剪影几何本身：一条简单闭合的外部轮廓
  for (const view of ['front', 'side']) {
    const pts = outlinePath(view);
    const b = outlineBounds(view);
    ok(`${view} 剪影是一条闭合轮廓（点数够密、也不过密）`,
      pts.length >= 24 && pts.length <= 90, `pts=${pts.length}`);
    ok(`${view} 剪影全部落在画面内`,
      pts.every(([x, y]) => x > 0 && x < 1 && y > 0 && y < 1));
    ok(`${view} 剪影脚底固定在 0.938 线上、放大后头顶仍留在画面内`,
      Math.abs(b.bottom - 0.938) < 1e-9 && b.top > 0.02
      && Math.abs(b.height - 0.783 * (OUTLINE.scale || 1)) < 1e-6,
      `top=${b.top.toFixed(3)} bottom=${b.bottom} 高=${b.height.toFixed(3)}`);
    ok(`${view} 剪影高度落在「距离合适」区间内（站进去就能过距离判定）`,
      b.height >= OUTLINE.spanMin && b.height <= OUTLINE.spanMax, `height=${b.height}`);
    // 真人身材是「瘦长」的：肩宽/身高 ≈ 0.24。老版本那种又宽又矮的雪人身材会在这里挂掉。
    ok(`${view} 剪影身材接近真人（不要又宽又矮）`,
      b.width / b.height > 0.10 && b.width / b.height < 0.30,
      `宽高比=${(b.width / b.height).toFixed(3)}`);
  }

  // 10.5) 躺姿剪影：横着放、宽而扁，水平长度要落在「距离合适」的区间里
  for (const kind of ['pushup', 'plank', 'bridge']) {
    const pts = outlinePath(kind);
    const b = outlineBounds(kind);
    const metricWidth = b.width * (16 / 9);
    ok(`${kind} 剪影是一条闭合轮廓`, pts.length >= 24 && pts.length <= 90, `pts=${pts.length}`);
    ok(`${kind} 剪影全部落在画面内`,
      pts.every(([x, y]) => x > 0 && x < 1 && y > 0 && y < 1));
    ok(`${kind} 剪影是「横着躺」的（宽大于高）`, b.width > b.height * 1.2,
      `宽=${b.width.toFixed(3)} 高=${b.height.toFixed(3)}`);
    ok(`${kind} 剪影的身体长度落在躺姿距离区间内（躺进去就能过距离判定）`,
      metricWidth >= LYING.spanMin && metricWidth <= LYING.spanMax,
      `长度=${metricWidth.toFixed(3)} ∈ [${LYING.spanMin}, ${LYING.spanMax}]`);
  }
  {
    // 俯卧撑 vs 平板支撑：手臂形状必须不同（一个是直臂撑起，一个是小臂贴地横放）
    const flatRuns = (kind) => outlinePath(kind).filter((p, i, arr) => {
      const q = arr[(i + 1) % arr.length];
      const s = OUTLINE.scale || 1;
      return Math.abs(p[1] - q[1]) < 0.015 * s && Math.abs(p[0] - q[0]) > 0.03 * s;
    }).length;
    ok('平板支撑的剪影里小臂贴地横放（至少 3 段水平线）', flatRuns('plank') >= 3, `水平段=${flatRuns('plank')}`);
    ok('俯卧撑的剪影没有横放的小臂（只有躯干那一小段，是直臂撑起）',
      flatRuns('pushup') <= 1, `水平段=${flatRuns('pushup')}`);
    // 臀桥：最高点在身体中段（抬起的膝盖），而不是头那一端
    const bPts = outlinePath('bridge');
    const topPt = bPts.reduce((a, p) => (p[1] < a[1] ? p : a), bPts[0]);
    ok('臀桥剪影的最高点是抬起的膝盖（在身体中段）',
      Math.abs(topPt[0] - OUTLINE.centerX) < 0.15, `最高点 x=${topPt[0].toFixed(3)}`);
    const headEndYs = bPts.filter(([x]) => x > OUTLINE.centerX + 0.15).map(([, y]) => y);
    ok('臀桥的头部贴近地面（不是抬着头的姿势）',
      headEndYs.every((y) => y > 0.72) && headEndYs.length > 0,
      `头端 y=${headEndYs.map((y) => y.toFixed(2)).join(',')}`);
    // 静态臀桥与臀桥共用同一个剪影
    ok('静态臀桥与臀桥共用同一剪影',
      outlineKind('bridgehold') === outlineKind('bridge')
      && JSON.stringify(outlinePath(outlineKind('bridgehold')))
        === JSON.stringify(outlinePath(outlineKind('bridge'))));
  }
  {
    // 俯卧撑与平板支撑是两种不同形状，用户一眼能分辨
    ok('俯卧撑与平板支撑的剪影不是同一条曲线',
      JSON.stringify(outlinePath('pushup')) !== JSON.stringify(outlinePath('plank')));
    // 每个动作都能查到自己的剪影种类
    const expected = {
      squat: 'front', lunge: 'side', pushup: 'pushup', plank: 'plank', bridge: 'bridge', bridgehold: 'bridge',
    };
    ok('六个动作都能查到对应的剪影种类',
      Object.entries(expected).every(([id, kind]) => outlineKind(id) === kind),
      Object.entries(expected).map(([id, kind]) => `${id}:${outlineKind(id)}≠${kind}`).join(' '));
    // 手写点列最容易出的错是「点序写乱」：相邻两点之间跨越大半张画面，画出来会有一条怪线
    const jumps = {};
    for (const kind of ['front', 'side', 'pushup', 'plank', 'bridge']) {
      const pts = outlinePath(kind);
      let max = 0;
      pts.forEach((p, i) => {
        const q = pts[(i + 1) % pts.length];
        max = Math.max(max, Math.hypot(p[0] - q[0], p[1] - q[1]));
      });
      jumps[kind] = max;
    }
    ok('五种剪影的相邻两点都没有「跨越大半张画面」的怪线段（点序没写乱）',
      Object.values(jumps).every((d) => d < 0.2),
      Object.entries(jumps).map(([k, d]) => `${k}:${d.toFixed(3)}`).join(' '));
  }
  {
    // 正面剪影由「半侧 + 镜像」生成：左右必须严格对称，中线外不能有多出来的点
    const pts = outlinePath('front');
    const b = outlineBounds('front');
    const onAxis = pts.filter(([x]) => Math.abs(x - OUTLINE.centerX) < 1e-9).length;
    const right = pts.filter(([x]) => x > OUTLINE.centerX).length;
    const left = pts.filter(([x]) => x < OUTLINE.centerX).length;
    ok('正面剪影左右对称', Math.abs((b.left + b.right) / 2 - OUTLINE.centerX) < 1e-9,
      `left=${b.left} right=${b.right}`);
    ok('正面剪影左右点数一致、只有头顶与裆部落在中线上',
      left === right && left > 10 && onAxis === 2, `left=${left} right=${right} onAxis=${onAxis}`);

    // 身材比例必须像真人：横向尺寸换算成「占身高比例」要乘宽高比
    const ASPECT_RATIO = 16 / 9;
    const toHeight = (dx) => (dx * ASPECT_RATIO) / b.height;
    const spansAt = (poly, y) => {
      const xs = [];
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
      }
      xs.sort((m, n) => m - n);
      const out = [];
      for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
      return out;
    };

    // 剪影整体放大过，取样高度要按同一基准（最下沿 0.938）换算回放大前的位置
    const scaleY = (y) => 0.938 - (0.938 - y) * (OUTLINE.scale || 1);
    const headSpans = spansAt(pts, scaleY(0.190));
    const shoulderSpans = spansAt(pts, scaleY(0.300));
    const chestSpans = spansAt(pts, scaleY(0.375));
    const waistSpans = spansAt(pts, scaleY(0.452));
    const hipSpans = spansAt(pts, scaleY(0.530));
    const kneeSpans = spansAt(pts, scaleY(0.715));

    ok('剪影头宽占身高 9%~13%（真人约 1/9）',
      headSpans.length === 1 && toHeight(headSpans[0][1] - headSpans[0][0]) > 0.09
      && toHeight(headSpans[0][1] - headSpans[0][0]) < 0.13,
      `头宽=${toHeight(headSpans[0][1] - headSpans[0][0]).toFixed(3)}`);
    ok('剪影肩宽占身高 21%~29%（真人约 1/4）',
      shoulderSpans.length === 1 && toHeight(shoulderSpans[0][1] - shoulderSpans[0][0]) > 0.21
      && toHeight(shoulderSpans[0][1] - shoulderSpans[0][0]) < 0.29,
      `肩宽=${toHeight(shoulderSpans[0][1] - shoulderSpans[0][0]).toFixed(3)}`);
    // 有腰身：腰比胸和髋都细，否则剪影就是个水桶
    const torsoWidth = (spans) => {
      const mid = spans.length === 1 ? spans[0] : spans[Math.floor(spans.length / 2)];
      return mid[1] - mid[0];
    };
    ok('剪影有腰身（腰比胸、比髋都细）',
      torsoWidth(waistSpans) < torsoWidth(chestSpans) && torsoWidth(waistSpans) < torsoWidth(hipSpans),
      `胸=${torsoWidth(chestSpans).toFixed(3)} 腰=${torsoWidth(waistSpans).toFixed(3)} 髋=${torsoWidth(hipSpans).toFixed(3)}`);
    // 手臂与躯干之间要留出缝隙：既是「双臂微张」的站姿要求，也避免手臂挡住躯干影响识别
    ok('剪影的手臂与躯干分开（留出缝隙）',
      chestSpans.length === 3
      && (chestSpans[1][0] - chestSpans[0][1]) > 0.008
      && (chestSpans[2][0] - chestSpans[1][1]) > 0.008,
      `缝宽=${(chestSpans[1][0] - chestSpans[0][1]).toFixed(4)}`);
    // 双腿：膝高处必须是两条独立的腿，中间有可见缝隙
    ok('剪影的双腿分开（膝高处两条腿、中间有缝）',
      kneeSpans.length === 2 && (kneeSpans[1][0] - kneeSpans[0][1]) > 0.01,
      `缝宽=${kneeSpans.length === 2 ? (kneeSpans[1][0] - kneeSpans[0][1]).toFixed(4) : 'n/a'}`);
    // 手臂自然下垂：手的轮廓要低到髋部以下，否则剪影看起来像「举手投降」
    const handPts = pts.filter(([x, y]) => y > 0.50 && y < 0.62 && Math.abs(x - OUTLINE.centerX) > 0.04);
    ok('正面剪影的手臂垂到髋部以下、双脚完整（不是半身像）',
      handPts.length >= 2 && b.bottom > 0.9, `hand=${handPts.length} bottom=${b.bottom}`);
  }
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
