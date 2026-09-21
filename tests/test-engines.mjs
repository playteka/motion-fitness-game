/**
 * 通用识别引擎（engines.js）的自动化测试。
 *
 * 6 个经典动作由 exercises.js 里手写的识别器负责（见 test-detectors.mjs），
 * 其余动作全部走 engines.js 里配置驱动的通用引擎：
 *   bend     屈伸一次（膝 / 肘 / 髋 / 踝 / 抬高高度）
 *   alt      左右交替（死虫式 / 登山者）
 *   twist    左右转体（俄罗斯转体 —— 目录里暂时没有动作用它，用手工 meta 直接构造）
 *   sequence 多段动作序列（波比跳：站 → 蹲 → 撑 → 跳）
 *   hold     姿势计时（侧平板 / 站姿体前屈 / 坐姿体前屈）
 * 这里用和 test-detectors.mjs 完全一样的做法：合成骨架「演」出标准动作与各种常见错误动作，
 * 跑完整识别管线（LandmarkSmoother → toMetric → computeFrame → Detector），
 * 检查计数 / 半程 / 提示 / 计时 / 门控是否符合预期；纯阈值与纯门控的用例用手搓帧直接喂。
 *
 * 进度模型（engines.js 顶部）：progress = (up − v) / (up − down)，0 = 起始位置，1 = 到位。
 *   peak ≥ bottomP 到位 ｜ 宽松模式 peak ≥ looseP 即计次 ｜ peak < ignoreP 只当晃了一下（不计也不出声）
 *
 * 运行：node tests/test-engines.mjs
 */

import { toMetric, LandmarkSmoother, LM } from '../src/geometry.js';
import { computeFrame } from '../src/metrics.js';
import { createDetector, EXERCISE_MAP } from '../src/exercises.js';
import { EXERCISES } from '../src/catalog.js';
import { t, setLang } from '../src/i18n.js';
import {
  GATES,
  BendRepDetector, AltRepDetector, TwistRepDetector, SequenceRepDetector, PoseHoldDetector,
} from '../src/engines.js';
import {
  ASPECT, SEG, standingPose, pronePose, supinePose, lostFrame, up, add,
} from './synthetic-pose.mjs';

const DT = 1000 / 30;
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

/* ------------------------------------------------------------------ *
 * 两个驱动器：真实合成骨架 / 手搓帧
 * ------------------------------------------------------------------ */

/** 把帧序列喂给检测器（走和真机一样的管线） */
function makeRunner(det, { smooth = true } = {}) {
  const smoother = new LandmarkSmoother();
  let t = 0;
  const cues = [];
  const reps = [];
  const holds = [];
  let lastFrame = null;

  function step(lm) {
    const raw = lm.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0, visibility: p.visibility ?? 1 }));
    const sm = smooth ? smoother.apply(raw, t / 1000) : raw;
    const f = computeFrame(toMetric(sm, ASPECT), null, t, false, null);
    lastFrame = f;
    for (const e of det.update(f, t)) {
      if (e.type === 'cue') cues.push(e);
      if (e.type === 'rep') reps.push(e);
      if (e.type === 'hold') holds.push(e);
    }
    t += DT;
  }

  return {
    det,
    cues,
    reps,
    holds,
    get frame() { return lastFrame; },
    get now() { return t; },
    /** segments: [{ pose: fn(p)=>landmarks | landmarks, ms }] */
    run(segments) {
      for (const seg of segments) {
        const n = Math.max(1, Math.round(seg.ms / DT));
        for (let i = 0; i < n; i++) {
          const p = n === 1 ? 1 : i / (n - 1);
          step(typeof seg.pose === 'function' ? seg.pose(p) : seg.pose);
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

/**
 * 手搓帧的驱动器：直接构造引擎读到的字段（engines.js 的引擎只读字段，不要求真实关键点）。
 * 用来覆盖纯阈值 / 纯门控的用例（例如目录里已经不存在的转体动作、左右交替的分侧指标）。
 */
function makeFrameRunner(det) {
  let now = 0;
  const cues = [];
  const reps = [];
  const holds = [];

  function feed(obj) {
    const f = { ok: true, t: now, points: [], ...obj };
    f.t = now;
    for (const e of det.update(f, now)) {
      if (e.type === 'cue') cues.push(e);
      if (e.type === 'rep') reps.push(e);
      if (e.type === 'hold') holds.push(e);
    }
    now += DT;
  }

  return {
    det,
    cues,
    reps,
    holds,
    get now() { return now; },
    /** segments: [{ f: fn(p)=>frame | frame, ms }] */
    run(segments) {
      for (const seg of segments) {
        const n = Math.max(1, Math.round(seg.ms / DT));
        for (let i = 0; i < n; i++) {
          const p = n === 1 ? 1 : i / (n - 1);
          feed(typeof seg.f === 'function' ? seg.f(p) : seg.f);
        }
      }
      return this;
    },
  };
}

/** 把一段「一次循环」的手搓帧序列重复 count 次 */
function repeatFrames(segments, count) {
  return Array.from({ length: count }, () => segments).flat();
}

/** 把一个「一次循环」的姿势函数展开成 count 次重复的帧序列（真实骨架） */
function repeat(poseFn, cycleMs, count) {  return Array.from({ length: count }, () => ({ pose: poseFn, ms: cycleMs }));
}

/** 同上，但用于手搓帧的驱动器 */
function repeatF(frameFn, cycleMs, count) {
  return Array.from({ length: count }, () => ({ f: frameFn, ms: cycleMs }));
}

const cuesOf = (r) => r.cues.map((c) => c.code);
const badReasons = (r) => r.reps.filter((x) => x.valid === false).map((x) => x.reason);
const hasCue = (r, code) => r.cues.some((c) => c.code === code);

/* ------------------------------------------------------------------ *
 * 合成姿势夹具
 * ------------------------------------------------------------------ */

/** 站立：手垂在体侧、脚踝踩在同一条地面线上；view 由目录条目决定 */
const standPose = (o = {}) => standingPose({ ankleX: 1.0, ...o });
const IDLE_FRONT = standPose({ knee: 178, lean: 6, armDown: 0, view: 'front' });
const IDLE_SIDE = standPose({ knee: 178, lean: 6, armDown: 0, view: 'side' });

/** 站立类「屈膝一次」循环：p: 0→1 蹲下去再站起来；kneeMin 越小蹲得越深；kneeMax 用来模拟「站不直」 */
function kneeCycle(kneeMin, view = 'front', kneeMax = 178) {
  return (p) => {
    const s = Math.sin(Math.PI * p);
    const knee = kneeMax - (kneeMax - kneeMin) * s;
    return standingPose({
      knee, lean: 6 + (178 - knee) * 0.14, armDown: (178 - knee) * 0.45, ankleX: 1.0, view,
    });
  };
}

/** 把整具骨架在画面里抬起 dy（归一化 y 向上减）：用来模拟「跳起来离地」 */
const liftPose = (lm, dy) => lm.map((p) => ({ ...p, y: p.y - dy }));

/** 蹬伸时抬起的高度：引擎用「最近 3 秒身体最低点」当基准（f.bodyBottomY），抬高 ~0.3 秒就够 */
const AIR_DY = 0.07;

/**
 * 跳跃类（深蹲跳 / 箭步跳 / 跳箱）一次循环：下蹲 → 蹬伸。
 * air = true 时在蹬伸段整具骨架抬离地面，air = false 时脚不离地。
 */
function jumpCycle(air, { view = 'front', kneeMin = 95, dy = AIR_DY } = {}) {
  return (p) => {
    let knee;
    if (p < 0.45) knee = 178 - (178 - kneeMin) * (p / 0.45);            // 下蹲
    else if (p < 0.75) knee = kneeMin + (178 - kneeMin) * ((p - 0.45) / 0.30); // 蹬伸
    else knee = 178;                                                    // 落地站稳
    const lm = standingPose({
      knee, lean: 6 + (178 - knee) * 0.14, armDown: (178 - knee) * 0.45, ankleX: 1.0, view,
    });
    return air && p >= 0.45 && p < 0.80 ? liftPose(lm, dy) : lm;
  };
}

/** 俯卧撑一次循环：肘角 172° → elbowMin（越小越深） */
function pushupCycle(elbowMin) {
  return (p) => {
    const s = Math.sin(Math.PI * p);
    const elbow = 172 - (172 - elbowMin) * s;
    return pronePose({
      hip: { x: 1.0, y: 0.68 + (172 - elbow) * 0.006 },
      bodyTilt: 63 + (172 - elbow) * 0.17,
      elbow,
      armDown: -(172 - elbow) * 0.3,
    });
  };
}

/** 卷腹一次循环：躺平（torsoUp 270）→ 肩抬到 topTorsoUp（数越大抬得越高） */
function crunchCycle(topTorsoUp) {
  return (p) => {
    const s = Math.sin(Math.PI * p);
    return supinePose({
      hip: { x: 0.75, y: 0.89 }, thighUp: 55, knee: 100,
      torsoUp: 270 + (topTorsoUp - 270) * s, armDown: -90, elbow: 178,
    });
  };
}

/**
 * 死虫式：仰卧屈膝（两膝朝天），把 extSide 那条腿伸直推出（膝盖放平 → 膝角 180°）。
 * 交替伸直左右腿就是「一次换边」；extSide = null 时两条腿都屈着（俯卧撑式的过渡姿势）。
 */
function deadBugPose(extSide, o = {}) {
  const hip = o.hip ?? { x: 0.75, y: 0.86 };
  const base = supinePose({
    hip, thighUp: o.thighUp ?? 55, knee: o.knee ?? 100, torsoUp: 270, armDown: -90, elbow: 178,
  });
  const out = base.map((p) => ({ ...p }));
  if (!extSide) return out;
  const dir = o.extUp ?? 90;              // 伸直的腿指向（90 = 水平推出）
  const kneePos = add(hip, up(dir), SEG.thigh);
  const anklePos = add(kneePos, up(dir), SEG.shin);
  const put = (i, q) => { out[i] = { ...out[i], x: q.x / ASPECT, y: q.y }; };
  put(extSide === 'L' ? LM.L_KNEE : LM.R_KNEE, kneePos);
  put(extSide === 'L' ? LM.L_ANKLE : LM.R_ANKLE, anklePos);
  put(extSide === 'L' ? LM.L_HEEL : LM.R_HEEL, add(anklePos, up(dir + 90), 0.07));
  put(extSide === 'L' ? LM.L_FOOT : LM.R_FOOT, add(anklePos, up(dir + 90), -0.13));
  return out;
}

/** 侧平板：身体横着、支撑手撑在地面（肩与髋都离地） */
const sidePlankPose = () => pronePose({
  hip: { x: 0.8, y: 0.75 }, bodyTilt: 78, elbow: 180, armDown: 0,
});
/** 侧平板垮掉：坐起来（躯干不再水平、门控不通过） */
const sidePlankBroken = () => pronePose({
  hip: { x: 0.8, y: 0.75 }, bodyTilt: 30, elbow: 90, armDown: 0,
});

/** 站姿体前屈：站着往前折（躯干 78°） */
const foldPose = () => standPose({ knee: 170, lean: 78, armDown: 20, view: 'side' });

/** 坐姿体前屈：坐在地上往前折 */
const seatedFoldPose = (torsoUp = 245) => supinePose({
  hip: { x: 0.72, y: 0.9 }, thighUp: 100, knee: 170, torsoUp, armDown: -90, elbow: 178,
});

/** 波比跳的三个姿势：站 → 蹲 → 俯撑（脚仍踩在同一条地面线上，否则横躺会被误算成「离地」） */
const BURPEE_STAND = IDLE_FRONT;
const BURPEE_CROUCH = standPose({ knee: 95, lean: 30, armDown: 40, view: 'front' });
const BURPEE_PLANK = pronePose({ hip: { x: 1.0, y: 0.838 }, bodyTilt: 78, elbow: 172, armDown: 0 });
const BURPEE_JUMP = liftPose(standPose({ knee: 178, lean: 4, armDown: -40, view: 'front' }), AIR_DY);
/** 波比跳开始时先喂一小段丢失跟踪的帧，让时钟不从 0 开始（见 [8] 的说明） */
const LOST = lostFrame();

/* ------------------------------------------------------------------ *
 * 手搓帧夹具（只覆盖纯阈值 / 纯门控的用例）
 * ------------------------------------------------------------------ */

/** 俯撑帧：门控 prone（躯干接近水平 + 肩离地 + 手撑地） */
const proneFrame = (over = {}) => ({
  ok: true, torsoIncl: 70, shoulderClear: 0.9, wristClearMin: 0.05,
  bodyStraight: 175, hipLineDev: 0, torsoLen: 0.3, ...over,
});

/** 登山者：一侧膝收起来（膝角小）、另一侧伸直 */
const climberFrame = (tuck) => proneFrame({
  perSide: { L: { knee: tuck === 'L' ? 85 : 178 }, R: { knee: tuck === 'R' ? 85 : 178 } },
});

/** 仰卧帧：门控 supine（躯干接近水平 + 肩贴地 + 膝离地） */
const supineFrame = (over = {}) => ({
  ok: true, torsoIncl: 60, shoulderClear: 0.3, kneeClear: 0.3, kneeAngle: 100,
  hipLineDev: 0, torsoLen: 0.3, ...over,
});

/** 坐着的地面姿势帧：门控 seatedLow / seatedFold */
const seatedFrame = (over = {}) => ({
  ok: true, torsoIncl: 45, hipClear: 0.4, wristTwist: 0, torsoLen: 0.3, ...over,
});

/** 目录里已经没有任何动作使用 twist 引擎，所以直接手工构造一个转体动作的 meta */
const TWIST_META = {
  id: 'russianTwist', plan: 'repAlt', kind: 'rep', engine: 'twist',
  params: { gate: 'seatedLow', amount: 0.16, minRepMs: 260 },
};

/* ------------------------------------------------------------------ *
 * [0] 引擎与目录
 * ------------------------------------------------------------------ */

console.log('\n[0] 引擎与目录');
{
  // createDetector(id) 必须按目录条目的 engine 字段选出对应的通用引擎
  const expected = {
    pushupWide: BendRepDetector, pushupDiamond: BendRepDetector, squatSumo: BendRepDetector,
    lungeBack: BendRepDetector, lungeBack: BendRepDetector, crunch: BendRepDetector,
    reverseCrunch: BendRepDetector, lyingLegRaise: BendRepDetector, squatJump: BendRepDetector,
    lungeJump: BendRepDetector, boxJump: BendRepDetector,
    deadBug: AltRepDetector, mountainClimber: AltRepDetector,
    burpee: SequenceRepDetector,
    sidePlank: PoseHoldDetector, standingForwardFold: PoseHoldDetector, seatedForwardFold: PoseHoldDetector,
  };
  const wrong = Object.entries(expected)
    .filter(([id, Cls]) => !(createDetector(id) instanceof Cls))
    .map(([id, Cls]) => `${id}→${createDetector(id).constructor.name}≠${Cls.name}`);
  ok('通用动作都按 engine 字段选到了对应的引擎', wrong.length === 0, wrong.join(' '));
  ok('五个引擎类都能当识别器用（有 update / snapshot）',
    [BendRepDetector, AltRepDetector, TwistRepDetector, SequenceRepDetector, PoseHoldDetector]
      .every((C) => typeof C.prototype.update === 'function' && typeof C.prototype.snapshot === 'function'));
  ok('六个经典动作仍然是手写识别器（没有被通用引擎顶掉）',
    ['squat', 'lunge', 'pushup', 'bridge', 'plank']
      .every((id) => !(createDetector(id) instanceof BendRepDetector)
        && !(createDetector(id) instanceof AltRepDetector)
        && !(createDetector(id) instanceof PoseHoldDetector)));

  // 直接 new 引擎与工厂给的结果必须一致（同一份配置、同一个状态机）
  const pairs = [
    ['lungeBack', new BendRepDetector(EXERCISE_MAP.lungeBack)],
    ['deadBug', new AltRepDetector(EXERCISE_MAP.deadBug)],
    ['burpee', new SequenceRepDetector(EXERCISE_MAP.burpee)],
    ['sidePlank', new PoseHoldDetector(EXERCISE_MAP.sidePlank)],
  ];
  for (const [id, direct] of pairs) {
    ok(`直接构造 ${direct.constructor.name}（${id}）可用`, typeof direct.snapshot === 'function');
    const viaFactory = createDetector(id);
    for (const r of [makeRunner(direct), makeRunner(viaFactory)]) {
      if (id === 'burpee') {
        r.run([{ pose: LOST, ms: 200 }, { pose: BURPEE_STAND, ms: 700 }, { pose: BURPEE_CROUCH, ms: 500 },
          { pose: BURPEE_PLANK, ms: 700 }, { pose: BURPEE_JUMP, ms: 400 }, { pose: BURPEE_STAND, ms: 400 }]);
      } else if (id === 'sidePlank') r.run([{ pose: sidePlankPose(), ms: 3000 }]);
      else if (id === 'deadBug') r.run([{ pose: deadBugPose('L'), ms: 600 }, { pose: deadBugPose('R'), ms: 600 }]);
      else r.run(repeat(kneeCycle(95), 1800, 2));
    }
    ok(`直接构造与 createDetector（${id}）结果一致`, direct.validReps === viaFactory.validReps,
      `直接 ${direct.validReps} / 工厂 ${viaFactory.validReps}`);
  }

  // 严格模式已按用户要求取消：识别器上不再有这个开关，传了也不会生效
  ok('识别器上没有 strict 开关（严格模式已取消）',
    createDetector('lungeBack').strict === undefined
    && createDetector('lungeBack', { strict: true }).strict === undefined
    && new BendRepDetector(EXERCISE_MAP.lungeBack, { strict: true }).strict === undefined
    && new PoseHoldDetector(EXERCISE_MAP.sidePlank, { strict: true }).strict === undefined);

  // 每个动作都能建出识别器（目录与引擎表不能脱节）
  const broken = [];
  for (const ex of EXERCISES) {
    try {
      const det = createDetector(ex.id);
      if (!det || typeof det.update !== 'function') broken.push(ex.id);
    } catch (e) { broken.push(`${ex.id}:${e.message}`); }
  }
  ok('目录里的每个动作都能建出识别器', broken.length === 0, broken.join(' '));

  // GATES：目录里用到的每个门控都必须有判定函数
  const gated = EXERCISES.filter((ex) => ex.params && ex.params.gate);
  const missing = gated.filter((ex) => typeof GATES[ex.params.gate] !== 'function')
    .map((ex) => `${ex.id}→${ex.params.gate}`);
  ok('目录用到的每个门控在 GATES 里都有判定函数', missing.length === 0, missing.join(' '));
  ok('GATES 里每一项都是函数', Object.values(GATES).every((f) => typeof f === 'function'));
  atLeast('至少有一批动作是靠门控把关的', gated.length, 8);
}

/* ------------------------------------------------------------------ *
 * [1] bend 引擎：一次循环一次数
 * ------------------------------------------------------------------ */

console.log('\n[1] bend 引擎：一次循环一次数');
{
  // 向后箭步蹲（单侧屈膝）：up 165 → down 105，宽松线 0.55、静默线 0.45
  // 注意：下面这些角度是按「进度 = (165 − 膝角) / 60」换算的，换动作要一起改
  const det = createDetector('lungeBack');
  const r = makeRunner(det);
  r.run(repeat(kneeCycle(75), 1800, 4));
  ok('向后箭步蹲：4 个完整循环 = 4 次', det.validReps === 4, `实际 ${det.validReps}`);
  ok('向后箭步蹲：没有半程误记', det.partialReps === 0, `实际 ${det.partialReps}`);
  ok('向后箭步蹲：每次有效次数都带序号与质量分',
    r.reps.filter((x) => x.valid).length === 4
    && r.reps.filter((x) => x.valid).every((x, i) => x.index === i + 1 && x.quality > 0 && x.duration > 0));
  ok('向后箭步蹲：回到起始位置后进度归零', det.depthPct <= 5, `depthPct=${det.depthPct}`);
}
{
  // 相扑深蹲：门控是 standWide（双腿分开），正面站姿才过
  const det = createDetector('squatSumo');
  const r = makeRunner(det);
  r.run(repeat(kneeCycle(75, 'front'), 1800, 4));
  ok('相扑深蹲：4 个完整循环 = 4 次', det.validReps === 4, `实际 ${det.validReps}`);
  ok('相扑深蹲：没有半程误记', det.partialReps === 0, `实际 ${det.partialReps}`);
  const f = makeRunner(createDetector('squatSumo')).peek(IDLE_FRONT);
  ok('相扑深蹲：正面站姿满足「双腿分开」门控', f.ankleSpread > 0.35, `ankleSpread=${f.ankleSpread.toFixed(2)}`);
}
{
  // 宽距俯卧撑：俯撑姿势（肘 172° → 90°）
  const det = createDetector('pushupWide');
  const r = makeRunner(det);
  r.run(repeat(pushupCycle(90), 1500, 4));
  ok('宽距俯卧撑：4 个完整循环 = 4 次', det.validReps === 4, `实际 ${det.validReps}`);
  ok('宽距俯卧撑：没有半程误记', det.partialReps === 0, `实际 ${det.partialReps}`);
}
{
  // 卷腹：仰卧，肩离地高度就是指标（up 0.20 → down 0.62，数值越大进度越高）
  const det = createDetector('crunch');
  const r = makeRunner(det);
  r.run(repeat(crunchCycle(300), 1400, 4));
  ok('卷腹：4 个完整循环 = 4 次', det.validReps === 4, `实际 ${det.validReps}`);
  ok('卷腹：没有半程误记', det.partialReps === 0, `实际 ${det.partialReps}`);
}
{
  // 回归：卷得高（肩离地超过 0.6 倍躯干长）也必须计数。
  // 曾经的 bug：supine 门控要求 shoulderClear < 0.6，而卷腹的到位线就是 0.62 ——
  // 卷得越标准反而把门控踢掉，次数变成 0 + 一串「太快了」的半程。
  const det = createDetector('crunch');
  const r = makeRunner(det);
  r.run(repeat(crunchCycle(335), 1400, 4));
  ok('卷腹：卷得高也计数', det.validReps === 4, `实际 ${det.validReps}`);
  ok('卷腹：卷得高不误记半程', det.partialReps === 0, `实际 ${det.partialReps}`);
  ok('卷腹：卷得高不该提示太快', !r.cues.some((c) => c.code === 'tooFast'),
    r.cues.map((c) => c.code).join(','));
}
{
  // 反向卷腹 / 仰卧抬腿：用髋角（躯干-大腿夹角，度）当指标，数值变小 = 抬起来
  const cases = [
    ['reverseCrunch', { rest: 90, top: 62 }],
    // 仰卧抬腿（用户描述）：躺平 180° → 腿绷直抬到与上身 90°（垂直地面）→ 放回 180°
    ['lyingLegRaise', { rest: 178, top: 92 }],
  ];
  for (const [id, v] of cases) {
    const det = createDetector(id);
    const r = makeFrameRunner(det);
    r.run(repeatF(
      (p) => supineFrame({ hipAngle: v.rest + (v.top - v.rest) * Math.sin(Math.PI * p) }), 1400, 4,
    ));
    ok(`${id}：4 个完整循环 = 4 次（角度指标方向反过来也照样计次）`, det.validReps === 4, `实际 ${det.validReps}`);
    ok(`${id}：没有半程误记`, det.partialReps === 0, `实际 ${det.partialReps}`);
  }
  {
    // 回归：起始姿势的数值已经越过「起始线」时，也必须能收尾计次
    // （旧 bug：反向卷腹用膝离地高度，桌面位就比 up 高，一轮永远结束不了 → 0 次）
    const det = createDetector('reverseCrunch');
    const r = makeFrameRunner(det);
    r.run(repeatF((p) => supineFrame({ hipAngle: 100 + (60 - 100) * Math.sin(Math.PI * p) }), 1400, 4));
    ok('反向卷腹：起始位偏高（腿伸得比较直）也能计次', det.validReps === 4, `实际 ${det.validReps}`);
  }
  /* ---- 仰卧抬腿（用户描述：躺平 180° → 抬到垂直 90° → 放回 180°，如此循环） ---- */
  {
    // 起始是躺平：腿伸直贴地，髋角 ≈180°，此时进度应该接近 0（不会自己开始计一轮）；
    // 抬到与上身 90°（腿垂直地面）时进度到顶（≥0.85 = 满分深度）
    const det = createDetector('lyingLegRaise');
    const r = makeFrameRunner(det);
    r.run([{ f: supineFrame({ hipAngle: 178, kneeAngle: 176 }), ms: 900 }]);
    ok('仰卧抬腿：躺平（髋角 178°）时进度为 0、不开始计次',
      det.progress <= 0.05 && det.validReps === 0, `progress=${det.progress?.toFixed(2)}`);
    r.run([{ f: supineFrame({ hipAngle: 92, kneeAngle: 176 }), ms: 700 }]);
    ok('仰卧抬腿：抬到与上身 90°（腿垂直地面）时进度到顶（满分深度）',
      det.progress >= 0.85, `progress=${det.progress?.toFixed(2)}`);
  }
  {
    // 抬到一半多（133°）：不到计数线（105°），不算次数，但要出声（不留无声空档）
    const det = createDetector('lyingLegRaise');
    const r = makeFrameRunner(det);
    r.run(repeatF((p) => supineFrame({
      hipAngle: 178 + (133 - 178) * Math.sin(Math.PI * p), kneeAngle: 176,
    }), 1400, 4));
    ok('仰卧抬腿：只抬到 133°（不到计数线）不算次数', det.validReps === 0, `实际 ${det.validReps}`);
    atLeast('仰卧抬腿：抬不够记成半程', det.partialReps, 3);
    ok('仰卧抬腿：抬不够会提示「幅度再大一点」', hasCue(r, 'moreRange'), cuesOf(r).join(','));
  }
  {
    // 用户要求：髋关节大概到 90° 就可以计次，但不要太严格 ——
    //   抬到 100°（离垂直 10°）算一次；抬到 118°（差得远）不算，只提示
    const near = createDetector('lyingLegRaise');
    const rNear = makeFrameRunner(near);
    rNear.run(repeatF((p) => supineFrame({
      hipAngle: 178 + (100 - 178) * Math.sin(Math.PI * p), kneeAngle: 176,
    }), 1400, 4));
    ok('仰卧抬腿：抬到髋关节 100°（离垂直 10°）就计次（宽容到 105° 以内）',
      near.validReps === 4, `实际 ${near.validReps}`);
    ok('仰卧抬腿：抬到 100° 不误记半程', near.partialReps === 0, `实际 ${near.partialReps}`);
    const far = createDetector('lyingLegRaise');
    const rFar = makeFrameRunner(far);
    rFar.run(repeatF((p) => supineFrame({
      hipAngle: 178 + (118 - 178) * Math.sin(Math.PI * p), kneeAngle: 176,
    }), 1400, 4));
    ok('仰卧抬腿：只抬到 118°（差得还远）不计次', far.validReps === 0, `实际 ${far.validReps}`);
    ok('仰卧抬腿：只抬到 118° 会提示「幅度再大一点」', hasCue(rFar, 'moreRange'), cuesOf(rFar).join(','));
  }
  {
    // 用户要求：腿放平、髋关节接近 180° 就能开始下一次，也不要太严格 ——
    //   放回 160°（离躺平 18°）这一轮就该结算并计次，不会因为没完全放平而不算
    const det = createDetector('lyingLegRaise');
    const r = makeFrameRunner(det);
    r.run(repeatF((p) => supineFrame({
      hipAngle: 160 + (95 - 160) * Math.sin(Math.PI * p), kneeAngle: 176,
    }), 1400, 4));
    ok('仰卧抬腿：只放回到 160°（接近放平）也能结算，4 个循环 = 4 次',
      det.validReps === 4, `实际 ${det.validReps}`);
    ok('仰卧抬腿：放回不彻底也不会记半程', det.partialReps === 0, `实际 ${det.partialReps}`);
  }
  {
    // 膝盖弯着抬：髋角一样能凑到 90°，所以要**出声**提醒「腿要绷直」，但仍然计次（只提醒不拦）
    const det = createDetector('lyingLegRaise');
    const r = makeFrameRunner(det);
    r.run(repeatF((p) => supineFrame({
      hipAngle: 178 + (92 - 178) * Math.sin(Math.PI * p), kneeAngle: 110,
    }), 1400, 4));
    ok('仰卧抬腿：弯着膝盖抬，照样计次（提醒不拦计数）', det.validReps === 4, `实际 ${det.validReps}`);
    ok('仰卧抬腿：弯膝盖时会提醒「腿要绷直」', hasCue(r, 'straightLegs'), cuesOf(r).join(','));
  }
  {
    // 宽容线 130°（用户要求「不要太严格，膝盖角度大于 130° 都可以接受」）：
    //   134°（略有点弯）→ 不唠叨；126°（明显弯）→ 出声提醒
    const loose = createDetector('lyingLegRaise');
    const rLoose = makeFrameRunner(loose);
    rLoose.run(repeatF((p) => supineFrame({
      hipAngle: 178 + (92 - 178) * Math.sin(Math.PI * p), kneeAngle: 134,
    }), 1400, 3));
    ok('仰卧抬腿：膝盖只弯一点点（134° > 130°）不提醒', !hasCue(rLoose, 'straightLegs'), cuesOf(rLoose).join(','));
    ok('仰卧抬腿：膝盖 134° 照样计次', loose.validReps === 3, `实际 ${loose.validReps}`);
    const tight = createDetector('lyingLegRaise');
    const rTight = makeFrameRunner(tight);
    rTight.run(repeatF((p) => supineFrame({
      hipAngle: 178 + (92 - 178) * Math.sin(Math.PI * p), kneeAngle: 126,
    }), 1400, 3));
    ok('仰卧抬腿：膝盖弯过宽容线（126° < 130°）才提醒', hasCue(rTight, 'straightLegs'), cuesOf(rTight).join(','));
  }
  {
    // 腿绷直抬起来：不该出现「腿要绷直」的唠叨
    const det = createDetector('lyingLegRaise');
    const r = makeFrameRunner(det);
    r.run(repeatF((p) => supineFrame({
      hipAngle: 178 + (92 - 178) * Math.sin(Math.PI * p), kneeAngle: 176,
    }), 1400, 4));
    ok('仰卧抬腿：腿绷直时不会念「腿要绷直」', !hasCue(r, 'straightLegs'), cuesOf(r).join(','));
  }
}

{
  // ===== 回归：起始位到不了「参考起始值」时不能吞次数 =====
  // 真机上机位/投影会让「站直」的读数只有 150° 左右，而参考起始值写的是 168°。
  // 旧版按绝对值判断「回到了起始位吗」，于是这一轮永不结算，
  // 后面每一次都被并进同一轮 —— 做了 5 个只记 1 个。
  // 现在起始值跟着用户自己的幅度走，必须每次都记上。
  for (const kneeMax of [170, 160, 150]) {
    const det = createDetector('squatSumo');
    const r = makeRunner(det);
    r.run(repeat(kneeCycle(95, 'front', kneeMax), 1600, 4));
    ok(`站不直（顶位读数 ${kneeMax}°）：4 次都要计到`, det.validReps === 4, `实际 ${det.validReps}`);
  }
}

/* ------------------------------------------------------------------ *
 * [2] bend 引擎：只有一个宽松档（严格模式已按用户要求取消）
 * ------------------------------------------------------------------ */

console.log('\n[2] bend 引擎：只有宽松档');
{
  // 只蹲到一半：峰值进度 ≈ 0.78 ≥ 计次线 0.65 → 算一次（深度分低一些）
  const shallow = repeat(kneeCycle(118), 1800, 4);
  const det = createDetector('lungeBack');
  const r = makeRunner(det);
  r.run(shallow);
  ok('半程向后箭步蹲：照样算 4 次（宽松是唯一一档）', det.validReps === 4, `实际 ${det.validReps}`);
  ok('半程向后箭步蹲：不记半程', det.partialReps === 0, `实际 ${det.partialReps}`);
  // 传 strict 也不再有任何变化：选项已被忽略
  const alt = createDetector('lungeBack', { strict: true });
  makeRunner(alt).run(shallow);
  ok('传 strict: true 也还是宽松档（开关已取消）', alt.validReps === det.validReps,
    `${alt.validReps} vs ${det.validReps}`);
  void r;
}
{
  // 俯卧撑类同一档：肘只弯到 130° 也算一次，只是质量分低
  const shallow = repeat(pushupCycle(130), 1500, 4);
  const det = createDetector('pushupWide');
  const r = makeRunner(det);
  r.run(shallow);
  ok('半程宽距俯卧撑：算 4 次', det.validReps === 4, `实际 ${det.validReps}`);
  ok('半程宽距俯卧撑：不算半程', det.partialReps === 0, `实际 ${det.partialReps}`);
  // 深度进分数：做满的峰值更高 → 质量分更高
  const deep = createDetector('pushupWide');
  const rDeep = makeRunner(deep);
  rDeep.run(repeat(pushupCycle(95), 1500, 4));
  ok('做得深的那一次质量分更高（深度分照旧区分质量）',
    rDeep.reps[0].quality > r.reps[0].quality,
    `${rDeep.reps[0].quality} vs ${r.reps[0].quality}`);
}

/* ------------------------------------------------------------------ *
 * [3] bend 引擎：晃动与过快的边界
 * ------------------------------------------------------------------ */

console.log('\n[3] bend 引擎：晃动与过快的边界');
{
  // 只晃了一下（峰值进度 ≈ 0.42，介于 enterP 0.32 与 ignoreP 0.45 之间）：不计次数、不记半程、也不出声
  const det = createDetector('lungeBack');
  const r = makeRunner(det);
  r.run(repeat(kneeCycle(140), 1600, 4));
  ok('轻微晃动：不计有效次数', det.validReps === 0, `实际 ${det.validReps}`);
  ok('轻微晃动：不记半程', det.partialReps === 0, `实际 ${det.partialReps}`);
  ok('轻微晃动：不出纠正提示', r.cues.length === 0, cuesOf(r).join(','));

  const detS = createDetector('squatSumo');
  const rS = makeRunner(detS);
  rS.run(repeat(kneeCycle(140, 'front'), 1600, 4));
  ok('轻微晃动（相扑深蹲）：也不计次数、不出声',
    detS.validReps === 0 && detS.partialReps === 0 && rS.cues.length === 0,
    `有效 ${detS.validReps} / 半程 ${detS.partialReps} / 提示 ${cuesOf(rS).join(',')}`);
}
{
  // 幅度够但快得不像人：只记半程 + 「太快了」
  const det = createDetector('lungeBack');
  const r = makeRunner(det);
  r.run(repeat(kneeCycle(95), 380, 6));
  ok('过快：不计有效次数', det.validReps === 0, `实际 ${det.validReps}`);
  atLeast('过快：记成半程', det.partialReps, 4);
  ok('过快：提示「太快了」', hasCue(r, 'tooFast'), cuesOf(r).join(','));
  ok('过快：半程原因是节奏', badReasons(r).every((x) => x === 'tempo'), badReasons(r).join(','));
}
{
  // 幅度卡在宽松线与静默线之间：不算次数，但要出声纠正（不留「既不计也不提示」的空档）
  const det = createDetector('lungeBack');
  const r = makeRunner(det);
  r.run(repeat(kneeCycle(133), 1600, 4));
  ok('幅度不足：宽松模式也不计次数', det.validReps === 0, `实际 ${det.validReps}`);
  atLeast('幅度不足：记成半程', det.partialReps, 3);
  ok('幅度不足：提示「再做大一点」', hasCue(r, 'moreRange'), cuesOf(r).join(','));
}

{
  // 用户要求：向后箭步蹲「后面几个关键帧对膝盖弯曲的要求更大」——计数线 0.55 → 0.70
  // 现在前膝要弯到约 122° 以内才算一次（收紧前弯到约 137° 就算）；浅的照样出声纠正，只是不计次
  for (const [kneeMin, label] of [[110, '前膝弯到约 110°'], [120, '前膝弯到约 120°']]) {
    const det = createDetector('lungeBack');
    const r = makeRunner(det);
    r.run(repeat(kneeCycle(kneeMin), 1600, 4));
    atLeast(`${label} 计次（不要求 90°）`, det.validReps, 3);
    ok(`${label} 不误记半程`, det.partialReps === 0, `实际 ${det.partialReps}`);
  }
  for (const kneeMin of [130, 135]) {
    const det = createDetector('lungeBack');
    const r = makeRunner(det);
    r.run(repeat(kneeCycle(kneeMin), 1600, 4));
    ok(`向后箭步蹲：前膝只弯到约 ${kneeMin}° 不再计次（收紧前会算一次）`,
      det.validReps === 0, `实际 ${det.validReps}`);
    atLeast(`向后箭步蹲：前膝只弯到约 ${kneeMin}° 记为半程`, det.partialReps, 3);
    ok(`向后箭步蹲：前膝只弯到约 ${kneeMin}° 会出声纠正`,
      r.cues.length > 0, cuesOf(r).join(',') || '（没有任何提示）');
  }
}

/* ------------------------------------------------------------------ *
 * [4] bend 引擎：姿势门控
 * ------------------------------------------------------------------ */

console.log('\n[4] bend 引擎：姿势门控');
{
  // 站着做俯卧撑：门控拦住一切，改成俯撑后立刻放行
  const det = createDetector('pushupWide');
  const r = makeRunner(det);
  r.run([{ pose: IDLE_SIDE, ms: 1500 }]);
  ok('站着做俯卧撑：被门控拦住', det.active === false, `active=${det.active}`);
  ok('站着做俯卧撑：给出准备姿势提示键', typeof det.standby === 'string' && det.standby.length > 0, det.standby);
  ok('站着做俯卧撑：提示键能取到中文文案', t(det.standby) !== det.standby, `${det.standby} → ${t(det.standby)}`);
  ok('站着做俯卧撑：一次也不计', det.validReps === 0 && det.partialReps === 0);
  ok('站着做俯卧撑：进度归零', det.depthPct === 0);
  r.run([{ pose: pronePose({ hip: { x: 1.0, y: 0.68 }, bodyTilt: 63, elbow: 172, armDown: 0 }), ms: 600 }]);
  ok('改成俯撑后：门控放行', det.active === true && det.standby === '', `active=${det.active} standby=${det.standby}`);
  r.run(repeat(pushupCycle(90), 1500, 2));
  ok('改成俯撑后：正常计数', det.validReps === 2, `实际 ${det.validReps}`);
}
{
  // 侧对镜头做相扑深蹲：站距不够宽，门控不放行（standWide）
  const det = createDetector('squatSumo');
  const r = makeRunner(det);
  r.run([{ pose: IDLE_SIDE, ms: 1500 }]);
  ok('站位太窄的相扑深蹲：被门控拦住', det.active === false && det.standby.length > 0, `active=${det.active}`);
  r.run(repeat(kneeCycle(95, 'side'), 1600, 3));
  ok('站位太窄：一次都不计', det.validReps === 0, `实际 ${det.validReps}`);
  r.run([{ pose: IDLE_FRONT, ms: 800 }]);
  ok('站宽之后：门控放行', det.active === true && det.standby === '', `active=${det.active}`);
}
{
  // 躺着做死虫式：站姿时门控拦住（supineLow）
  const det = createDetector('deadBug');
  const r = makeRunner(det);
  r.run([{ pose: IDLE_SIDE, ms: 1500 }]);
  ok('站着做死虫式：被门控拦住并给出提示',
    det.active === false && t(det.standby) !== det.standby, `${det.active} / ${det.standby}`);
  r.run([{ pose: deadBugPose('L'), ms: 600 }]);
  ok('躺下之后：门控放行', det.active === true && det.standby === '', `active=${det.active}`);
}
{
  // 仰卧抬腿的姿势要求放宽了（用户要求）：门控改成 supineFlat —— **只看「肩离地高度 ≤ 0.6×躯干长」**，
  // 删掉了「躯干倾角 ≥ 36°」。所以「半躺」（躯干离竖直只斜 30°）现在也能进入判定，
  // 而站着（肩离地高度 1.2×躯干长）仍旧被这一条拦住。
  const reclined = createDetector('lyingLegRaise');
  const r1 = makeFrameRunner(reclined);
  r1.run([{ f: supineFrame({ torsoIncl: 30, shoulderClear: 0.5, hipAngle: 178, kneeAngle: 176 }), ms: 900 }]);
  ok('仰卧抬腿：躯干只斜 30°（不到旧的 36°）也放行（姿势要求已放宽）',
    reclined.active === true && reclined.standby === '', `active=${reclined.active} standby=${reclined.standby}`);

  const standing = createDetector('lyingLegRaise');
  const r2 = makeFrameRunner(standing);
  r2.run([{ f: supineFrame({ torsoIncl: 10, shoulderClear: 1.2, hipAngle: 178, kneeAngle: 176 }), ms: 900 }]);
  ok('仰卧抬腿：站着（肩离地高度 1.2×躯干长）仍旧被门控拦住',
    standing.active === false && standing.standby !== '', `active=${standing.active} standby=${standing.standby}`);
}

/* ------------------------------------------------------------------ *
 * [5] bend 引擎：跳跃（离地）
 * ------------------------------------------------------------------ */

console.log('\n[5] bend 引擎：跳跃（离地）');
{
  // 深蹲跳：蹲下去、蹬起，但脚不离地 → 半程 + 「跳起来」
  const det = createDetector('squatJump');
  const r = makeRunner(det);
  r.run(repeat(jumpCycle(false), 1300, 3));
  ok('深蹲跳：脚不离地不计有效次数', det.validReps === 0, `实际 ${det.validReps}`);
  atLeast('深蹲跳：脚不离地记成半程', det.partialReps, 3);
  ok('深蹲跳：提示「要跳起来」', hasCue(r, 'needJump'), cuesOf(r).join(','));
  ok('深蹲跳：半程原因是没离地', badReasons(r).every((x) => x === 'flight'), badReasons(r).join(','));
}
{
  // 整具骨架在蹬伸段抬起 ~0.3 秒（抬高 0.07）→ 真的离地，计一次
  const det = createDetector('squatJump');
  const r = makeRunner(det);
  r.run(repeat(jumpCycle(true), 1300, 3));
  ok('深蹲跳：真的离地 = 3 次', det.validReps === 3, `实际 ${det.validReps}`);
  ok('深蹲跳：没有半程误记', det.partialReps === 0, `实际 ${det.partialReps}`);
  ok('深蹲跳：离地时不再提示「要跳起来」', !hasCue(r, 'needJump'), cuesOf(r).join(','));
}
{
  // 箭步跳（侧拍、门控 stand）：同一套离地判据
  const noAir = makeRunner(createDetector('lungeJump'));
  noAir.run(repeat(jumpCycle(false, { view: 'side' }), 1300, 3));
  ok('箭步跳：脚不离地不计有效次数', noAir.det.validReps === 0 && hasCue(noAir, 'needJump'),
    `实际 ${noAir.det.validReps} / ${cuesOf(noAir).join(',')}`);
  const air = createDetector('lungeJump');
  const rAir = makeRunner(air);
  rAir.run(repeat(jumpCycle(true, { view: 'side' }), 1300, 3));
  ok('箭步跳：真的离地 = 3 次', air.validReps === 3, `实际 ${air.validReps}`);
}
{
  // 有校准地面线时，离地判定直接对着地面线算（不再依赖会漂移的滚动基准）：
  // 脚一直踩在地面线上 → 怎么屈伸都不算起跳；蹬伸时整具身体抬离地面线 → 才算一次。
  const GROUND = 0.95;
  const frame = (kneeBent, bottomY, calibrated = true) => ({
    ok: true, torsoIncl: 10, view: 'front', kneeClear: 0.5, hipClear: 1.0,
    kneeBent, kneeExtended: 170, kneeAngle: kneeBent, bodyStraight: 175, hipLineDev: 0,
    bodyBottomY: bottomY, groundRef: GROUND, groundRefCalibrated: calibrated,
    torsoLen: 0.3, perSide: { L: {}, R: {} },
  });
  const onFloor = [
    { f: frame(170, GROUND), ms: 300 },
    { f: frame(100, GROUND), ms: 500 },
    { f: frame(170, GROUND), ms: 500 },
  ];
  const grounded = makeFrameRunner(createDetector('squatJump'));
  grounded.run(repeatFrames(onFloor, 3));
  ok('有地面线：脚不离地（怎么屈伸都不算起跳）',
    grounded.det.validReps === 0 && hasCue(grounded, 'needJump'),
    `有效 ${grounded.det.validReps} / ${cuesOf(grounded).join(',')}`);

  const jumping = [
    { f: frame(170, GROUND), ms: 300 },
    { f: frame(100, GROUND), ms: 400 },
    { f: frame(170, GROUND - 0.09), ms: 300 },
    { f: frame(170, GROUND), ms: 400 },
  ];
  const air = makeFrameRunner(createDetector('squatJump'));
  air.run(repeatFrames(jumping, 3));
  ok('有地面线：抬离地面线 0.09 = 3 次', air.det.validReps === 3, `实际 ${air.det.validReps}`);
  ok('有地面线：离地了就不再提示「要跳起来」', !hasCue(air, 'needJump'), cuesOf(air).join(','));

  // 没有校准线时：同一组帧要靠滚动基准推断（所以真机必须先过校准，判定才稳）
  const noCalib = makeFrameRunner(createDetector('squatJump'));
  noCalib.run(repeatFrames(onFloor.map((s) => ({ ...s, f: frame(0, GROUND, false) })), 3));
  ok('没有地面线时退回滚动基准：同一姿势不会一直累加次数',
    noCalib.det.validReps === 0, `有效 ${noCalib.det.validReps}`);
}{
  // 跳箱：离地门槛 0.035（用户反馈原来的 0.05 偏大，已调小；深蹲跳用的也是 0.035）
  const low = makeRunner(createDetector('boxJump'));
  low.run(repeat(jumpCycle(false), 1300, 3));
  ok('跳箱：脚不离地不计有效次数', low.det.validReps === 0, `实际 ${low.det.validReps}`);
  const det = createDetector('boxJump');
  const r = makeRunner(det);
  r.run(repeat(jumpCycle(true, { dy: 0.09 }), 1300, 3));
  ok('跳箱：抬得够高（0.09）= 3 次', det.validReps === 3, `实际 ${det.validReps}`);
  // 调小之后：抬到 0.045（旧门槛 0.05 判不到、新门槛 0.035 能判到）也要算
  const lower = createDetector('boxJump');
  const rLower = makeRunner(lower);
  rLower.run(repeat(jumpCycle(true, { dy: 0.045 }), 1300, 3));
  ok('跳箱：抬到 0.045（旧线 0.05 不够、新线 0.035 够了）= 3 次',
    lower.validReps === 3, `实际 ${lower.validReps}`);
  // 新门槛之下（0.02）仍旧不算：别把「踮一下脚」当成跳起来
  const below = createDetector('boxJump');
  const rBelow = makeRunner(below);
  rBelow.run(repeat(jumpCycle(true, { dy: 0.02 }), 1300, 3));
  ok('跳箱：抬到 0.02（低于新门槛）= 0 次，并提示要跳起来',
    below.validReps === 0 && hasCue(rBelow, 'needJump'),
    `有效 ${below.validReps} / ${cuesOf(rBelow).join(',')}`);
}
{
  // 离地基线是「最近 3 秒身体最低点」：站着一动不动永远不会被判成离地
  const det = createDetector('squatJump');
  const r = makeRunner(det);
  r.run([{ pose: IDLE_FRONT, ms: 4000 }]);
  ok('静立：不会被误判成离地', det.validReps === 0 && det.partialReps === 0,
    `有效 ${det.validReps} / 半程 ${det.partialReps}`);
}

/* ------------------------------------------------------------------ *
 * [6] alt 引擎：左右交替
 * ------------------------------------------------------------------ */

console.log('\n[6] alt 引擎：左右交替');
{
  // 死虫式（真实骨架）：伸直左腿 → 换右腿 → 换左腿 → 换右腿
  const det = createDetector('deadBug');
  const r = makeRunner(det);
  r.run([
    { pose: deadBugPose('L'), ms: 600 }, { pose: deadBugPose('R'), ms: 600 },
    { pose: deadBugPose('L'), ms: 600 }, { pose: deadBugPose('R'), ms: 600 },
  ]);
  ok('死虫式：换边 4 次 = 4 次', det.validReps === 4, `实际 ${det.validReps}`);
  ok('死虫式：每次计数都标出是哪一侧', r.reps.map((x) => x.side).join(',') === 'L,R,L,R',
    r.reps.map((x) => x.side).join(','));
  const before = det.validReps;
  r.run([{ pose: deadBugPose('R'), ms: 3000 }]);
  ok('死虫式：保持同一侧 3 秒不会继续刷次数', det.validReps === before, `${before} → ${det.validReps}`);
  r.run([{ pose: deadBugPose('L'), ms: 600 }]);
  ok('死虫式：再换边仍然计一次', det.validReps === before + 1, `${det.validReps}`);
  r.run([{ pose: deadBugPose(null), ms: 800 }]);
  ok('死虫式：两条腿都屈着（没有交替）不计数', det.validReps === before + 1, `实际 ${det.validReps}`);
}
{
  // 登山者（手搓帧）：一侧膝收到 85°、另一侧伸直 178°
  const det = createDetector('mountainClimber');
  const r = makeFrameRunner(det);
  r.run([{ f: climberFrame('L'), ms: 500 }, { f: climberFrame('R'), ms: 500 },
    { f: climberFrame('L'), ms: 500 }, { f: climberFrame('R'), ms: 500 }]);
  ok('登山者：换边 4 次 = 4 次', det.validReps === 4, `实际 ${det.validReps}`);
  ok('登山者：每次计数都标出是哪一侧', r.reps.map((x) => x.side).join(',') === 'L,R,L,R',
    r.reps.map((x) => x.side).join(','));
  const before = det.validReps;                 // 上面最后一侧收的是右腿
  r.run([{ f: climberFrame('R'), ms: 3000 }]);
  ok('登山者：一直收着右边不会继续刷次数', det.validReps === before, `${before} → ${det.validReps}`);
  r.run([{ f: climberFrame('L'), ms: 600 }]);
  ok('登山者：再换边仍然计一次', det.validReps === before + 1, `实际 ${det.validReps}`);
  const swapped = det.validReps;
  // 两条腿都伸直（没有任何一侧「在做」）也不计数
  r.run([{ f: proneFrame({ perSide: { L: { knee: 178 }, R: { knee: 178 } } }), ms: 1000 }]);
  ok('登山者：两侧都没动不计数', det.validReps === swapped, `实际 ${det.validReps}`);
}
{
  // 门控：站着做登山者
  const det = createDetector('mountainClimber');
  const r = makeFrameRunner(det);
  r.run([{ f: { torsoIncl: 6, kneeClear: 0.8, hipClear: 1.6, shoulderClear: 2.6, wristClearMin: 1.6 }, ms: 1200 }]);
  ok('站着做登山者：被门控拦住', det.active === false && det.standby.length > 0, `active=${det.active}`);
  r.run([{ f: climberFrame('L'), ms: 600 }]);
  ok('撑下去之后：门控放行', det.active === true && det.standby === '', `active=${det.active}`);
}

/* ------------------------------------------------------------------ *
 * [7] twist 引擎：左右转体
 * ------------------------------------------------------------------ */

console.log('\n[7] twist 引擎：左右转体');
{
  // 目录里没有动作用 twist 引擎，用手工 meta 直接构造（amount 0.16、minRepMs 260）
  const det = new TwistRepDetector(TWIST_META);
  const r = makeFrameRunner(det);
  const tw = (v) => seatedFrame({ wristTwist: v });
  r.run([{ f: tw(0.30), ms: 300 }, { f: tw(-0.30), ms: 300 }, { f: tw(0.30), ms: 300 },
    { f: tw(-0.30), ms: 300 }, { f: tw(0.30), ms: 300 }]);
  ok('俄罗斯转体：换向 4 次 = 4 次', det.validReps === 4, `实际 ${det.validReps}`);
  ok('俄罗斯转体：每次计数都标出转朝哪一侧', r.reps.map((x) => x.side).join(',') === 'L,R,L,R',
    r.reps.map((x) => x.side).join(','));
  ok('俄罗斯转体：初始方向只做「记住」，不算一次换向',
    r.reps.every((x) => x.valid === true) && det.validReps === 4);
}
{
  const det = new TwistRepDetector(TWIST_META);
  const r = makeFrameRunner(det);
  const tw = (v) => seatedFrame({ wristTwist: v });
  r.run([{ f: tw(0.05), ms: 300 }, { f: tw(-0.06), ms: 300 }, { f: tw(0.04), ms: 300 }]);
  ok('俄罗斯转体：幅度低于 amount 一次都不算', det.validReps === 0, `实际 ${det.validReps}`);
  ok('俄罗斯转体：幅度不够时进度条仍有反馈（但不是 0）', det.depthPct > 0, `depthPct=${det.depthPct}`);
}
{
  const det = new TwistRepDetector(TWIST_META);
  const r = makeFrameRunner(det);
  r.run([{ f: { wristTwist: 0.4, torsoIncl: 10, hipClear: 1.4 }, ms: 900 }]);
  ok('俄罗斯转体：没坐在地上时被门控拦住',
    det.active === false && t(det.standby) !== det.standby, `${det.active} / ${det.standby}`);
  ok('俄罗斯转体：门控不通过时不给次数', det.validReps === 0);
}

/* ------------------------------------------------------------------ *
 * [8] sequence 引擎：波比跳
 * ------------------------------------------------------------------ */

console.log('\n[8] sequence 引擎：波比跳');
{
  // 注意：先喂 0.2 秒「丢失跟踪」的帧。
  // 引擎把 startedAt === 0 当成「这一轮还没开始」（`this.startedAt ? now - this.startedAt : 0`），
  // 而本测试的时钟从 0 起，若第一帧就站好，整轮用时会被算成 0 毫秒 → 误判成「太快了」。
  // 真机上 now 来自 performance.now()，不会命中；这里从乱序开始的 0.2 秒也正好模拟「刚打开摄像头」。
  const det = createDetector('burpee');
  const r = makeRunner(det);
  r.run([{ pose: LOST, ms: 200 }, { pose: BURPEE_STAND, ms: 700 }, { pose: BURPEE_CROUCH, ms: 500 },
    { pose: BURPEE_PLANK, ms: 700 }, { pose: BURPEE_JUMP, ms: 400 }, { pose: BURPEE_STAND, ms: 400 }]);
  ok('波比跳：站→蹲→撑→跳 完整一轮 = 1 次', det.validReps === 1, `实际 ${det.validReps}`);
  ok('波比跳：完整一轮不是半程', det.partialReps === 0, `实际 ${det.partialReps}`);
  ok('波比跳：完整一轮有质量分与用时',
    r.reps.length === 1 && r.reps[0].valid === true && r.reps[0].quality > 0 && r.reps[0].duration > 0);
}
{
  // 连续两轮：每一轮都要单独计一次（引擎在完成后把阶段归零）
  const det = createDetector('burpee');
  const r = makeRunner(det);
  const cycle = [{ pose: BURPEE_CROUCH, ms: 500 }, { pose: BURPEE_PLANK, ms: 700 },
    { pose: BURPEE_JUMP, ms: 400 }, { pose: BURPEE_STAND, ms: 400 }];
  r.run([{ pose: LOST, ms: 200 }, { pose: BURPEE_STAND, ms: 700 }, ...cycle, ...cycle]);
  ok('波比跳：连续两轮 = 2 次', det.validReps === 2, `实际 ${det.validReps}`);
}
{
  // 少了「蹲」这一步：顺序不完整 → 一次都不算
  const det = createDetector('burpee');
  const r = makeRunner(det);
  r.run([{ pose: LOST, ms: 200 }, { pose: BURPEE_STAND, ms: 700 }, { pose: BURPEE_PLANK, ms: 700 },
    { pose: BURPEE_JUMP, ms: 400 }, { pose: BURPEE_STAND, ms: 400 }]);
  ok('波比跳：跳过下蹲不算次数', det.validReps === 0, `实际 ${det.validReps}`);
  ok('波比跳：跳过下蹲也不记半程', det.partialReps === 0, `实际 ${det.partialReps}`);
}
{
  // 少了收尾的「跳」：最后站着回到起点，序列停在第 4 阶段 → 一次都不算
  const det = createDetector('burpee');
  const r = makeRunner(det);
  r.run([{ pose: LOST, ms: 200 }, { pose: BURPEE_STAND, ms: 700 }, { pose: BURPEE_CROUCH, ms: 500 },
    { pose: BURPEE_PLANK, ms: 700 }, { pose: BURPEE_STAND, ms: 1200 }]);
  ok('波比跳：最后一跳没离地不算次数', det.validReps === 0, `实际 ${det.validReps}`);
  ok('波比跳：最后一跳没离地也不记半程', det.partialReps === 0, `实际 ${det.partialReps}`);
}
{
  // 站着不动：序列停在第一步，不刷次数
  const det = createDetector('burpee');
  const r = makeRunner(det);
  r.run([{ pose: LOST, ms: 200 }, { pose: BURPEE_STAND, ms: 4000 }]);
  ok('波比跳：静立 4 秒计 0 次', det.validReps === 0 && det.partialReps === 0,
    `有效 ${det.validReps} / 半程 ${det.partialReps}`);
  ok('波比跳：静立时处于可训练状态', det.active === true && det.standby === '');
}

/* ------------------------------------------------------------------ *
 * [9] hold 引擎：姿势计时
 * ------------------------------------------------------------------ */

console.log('\n[9] hold 引擎：姿势计时');
{
  // 侧平板：撑住 5 秒 → 计时累积 + 抛出「开始计时」
  const det = createDetector('sidePlank');
  const r = makeRunner(det);
  r.run([{ pose: sidePlankPose(), ms: 5000 }]);
  near('侧平板：撑住 5 秒 ≈ 计时 5 秒', det.holdMs / 1000, 5, 0.3);
  ok('侧平板：抛出「开始计时」事件', r.holds.some((h) => h.action === 'start'), JSON.stringify(r.holds));
  r.run([{ pose: sidePlankPose(), ms: 2000 }]);
  near('侧平板：继续撑 2 秒 ≈ 累计 7 秒', det.holdMs / 1000, 7, 0.35);
  ok('侧平板：连续保持期间不会重复抛「开始」', r.holds.filter((h) => h.action === 'start').length === 1,
    JSON.stringify(r.holds.map((h) => h.action)));
}
{
  // 宽限期 1200ms：短暂垮掉不中断本组计时
  const det = createDetector('sidePlank');
  const r = makeRunner(det);
  r.run([{ pose: sidePlankPose(), ms: 3000 }]);
  const kept = det.holdMs;
  r.run([{ pose: sidePlankBroken(), ms: 400 }]);
  ok('侧平板：垮掉 0.4 秒（宽限期内）不暂停', !r.holds.some((h) => h.action === 'pause'),
    JSON.stringify(r.holds.map((h) => h.action)));
  ok('侧平板：宽限期内计时不前进', det.holdMs === kept, `${kept} → ${det.holdMs}`);
  r.run([{ pose: sidePlankPose(), ms: 2000 }]);
  ok('侧平板：姿势回来后继续累积', det.holdMs > kept, `${kept} → ${det.holdMs}`);
}
{
  // 垮掉超过宽限期：抛出「暂停计时」，计时冻结；姿势恢复后重新开始
  const det = createDetector('sidePlank');
  const r = makeRunner(det);
  r.run([{ pose: sidePlankPose(), ms: 4000 }]);
  const kept = det.holdMs;
  r.run([{ pose: sidePlankBroken(), ms: 3000 }]);
  ok('侧平板：垮掉超过宽限期 → 抛出「暂停计时」', r.holds.some((h) => h.action === 'pause'),
    JSON.stringify(r.holds.map((h) => h.action)));
  ok('侧平板：暂停时不再计数', det.active === false && det.holdMs === kept, `active=${det.active}`);
  ok('侧平板：暂停时给出原因提示键', typeof det.standby === 'string' && det.standby.length > 0, det.standby);
  r.run([{ pose: sidePlankBroken(), ms: 2000 }]);
  ok('侧平板：垮着不动计时保持冻结', det.holdMs === kept, `${kept} → ${det.holdMs}`);
  r.run([{ pose: sidePlankPose(), ms: 2000 }]);
  ok('侧平板：撑回来后重新开始计时', r.holds.filter((h) => h.action === 'start').length >= 2,
    JSON.stringify(r.holds.map((h) => h.action)));
  atLeast('侧平板：恢复后的计时在继续累积', det.holdMs - kept, 1600);
}
{
  // 站姿体前屈：站直时不计时（门控 standFold），折下去才开始
  const det = createDetector('standingForwardFold');
  const r = makeRunner(det);
  r.run([{ pose: IDLE_SIDE, ms: 2000 }]);
  ok('站姿体前屈：站着不计时', det.holdMs === 0 && det.active === false, `holdMs=${det.holdMs}`);
  ok('站姿体前屈：站着给出提示键', t(det.standby) !== det.standby, `${det.standby} → ${t(det.standby)}`);
  r.run([{ pose: foldPose(), ms: 5000 }]);
  near('站姿体前屈：折下去 5 秒 ≈ 计时 5 秒', det.holdMs / 1000, 5, 0.3);
  ok('站姿体前屈：抛出「开始计时」事件', r.holds.some((h) => h.action === 'start'));
  r.run([{ pose: IDLE_SIDE, ms: 2000 }]);
  ok('站姿体前屈：站直超过宽限期 → 暂停计时', r.holds.some((h) => h.action === 'pause'),
    JSON.stringify(r.holds.map((h) => h.action)));
  const frozen = det.holdMs;
  r.run([{ pose: foldPose(), ms: 2500 }]);
  atLeast('站姿体前屈：再折下去继续累积', det.holdMs - frozen, 2100);
}
{
  // 坐姿体前屈：坐姿门控（seatedFold）
  const det = createDetector('seatedForwardFold');
  const r = makeRunner(det);
  r.run([{ pose: seatedFoldPose(245), ms: 4000 }]);
  near('坐姿体前屈：折住 4 秒 ≈ 计时 4 秒', det.holdMs / 1000, 4, 0.3);
  r.run([{ pose: seatedFoldPose(340), ms: 2000 }]);
  ok('坐姿体前屈：坐直（躯干不再前折）→ 暂停计时', r.holds.some((h) => h.action === 'pause'),
    JSON.stringify(r.holds.map((h) => h.action)));
  ok('坐姿体前屈：坐直后 active 归 false', det.active === false, `active=${det.active}`);
}
{
  // 门控 hold 版本的垃圾姿势：站着喂侧平板
  const det = createDetector('sidePlank');
  const r = makeRunner(det);
  r.run([{ pose: IDLE_SIDE, ms: 3000 }]);
  ok('站姿喂侧平板：不计时', det.holdMs === 0 && det.active === false, `holdMs=${det.holdMs}`);
  ok('站姿喂侧平板：给出「换姿势」提示', t(det.standby) !== det.standby, `${det.standby} → ${t(det.standby)}`);
}

/* ------------------------------------------------------------------ *
 * [10] 垃圾帧 / 丢帧
 * ------------------------------------------------------------------ */

console.log('\n[10] 垃圾帧 / 丢帧');
{
  // 跟踪丢失（全 0 可见度）与 ok:false 的帧：任何动作都不能崩，也不能刷次数
  const crashed = [];
  for (const ex of EXERCISES) {
    const det = createDetector(ex.id);
    const r = makeRunner(det);
    try {
      r.run([{ pose: lostFrame(), ms: 400 }]);
      det.update({ ok: false, t: r.now }, r.now);
      det.update(null, r.now);          // 连帧都没有
      r.run([{ pose: lostFrame(), ms: 400 }]);
      if (det.validReps !== 0 || det.partialReps !== 0) crashed.push(`${ex.id} 丢帧期间计了数`);
    } catch (e) { crashed.push(`${ex.id}:${e.message}`); }
  }
  ok('丢帧 / ok:false 不会让任何动作的识别器崩掉或刷次数', crashed.length === 0, crashed.join(' '));

  // 五个通用引擎：ok:true 但字段全是垃圾 / 缺字段，也不能崩
  const engines = [
    ['bend', new BendRepDetector(EXERCISE_MAP.lungeBack)],
    ['alt', new AltRepDetector(EXERCISE_MAP.deadBug)],
    ['twist', new TwistRepDetector(TWIST_META)],
    ['sequence', new SequenceRepDetector(EXERCISE_MAP.burpee)],
    ['hold', new PoseHoldDetector(EXERCISE_MAP.sidePlank)],
  ];
  const junk = [];
  const frames = [
    {},
    { torsoIncl: NaN, kneeClear: NaN, hipClear: NaN, kneeAngle: NaN, bodyBottomY: NaN },
    { perSide: { L: {}, R: {} }, torsoIncl: 70, shoulderClear: 0.9, wristClearMin: 0.05 },
    { points: [{}, {}], wristTwist: NaN, hipClear: 0.2, torsoIncl: 50 },
    { points: [], bodyStraight: NaN, hipLineDev: NaN },
  ];
  for (const [name, det] of engines) {
    try {
      let now = 0;
      for (const base of frames) { det.update({ ok: true, t: now, ...base }, now); now += DT; }
      det.update({ ok: true, t: now }, now);
    } catch (e) { junk.push(`${name}:${e.message}`); }
  }
  ok('五个通用引擎面对畸形帧（缺字段 / NaN / 空点集）都不崩', junk.length === 0, junk.join(' '));
  ok('畸形帧不会刷出有效次数', engines.every(([, det]) => det.validReps === 0),
    engines.map(([n, d]) => `${n}:${d.validReps}`).join(' '));
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

console.log('');
if (failures.length) {
  console.log(`失败明细（${failures.length} 项）：`);
  for (const f of failures) console.log(`  ✗ ${f}`);
}
console.log(`结果：${passed} 项通过，${failures.length} 项失败`);
process.exit(failures.length ? 1 : 0);
