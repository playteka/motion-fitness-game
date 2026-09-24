/**
 * 关键帧线条图标：把「这一格要求的人体姿态」画成火柴人线条，给判定进度条用。
 *
 * 设计原则（和 specs.js 一样：一处定义，不许漂移）：
 *   1. 每个图标都由**该格的真实判据**推出来：
 *        - 「前膝屈角 ≤ 152°」→ 画一条膝角正好 152° 的腿；
 *        - 「髋部抬起高度 ≥ 0.22×躯干长」→ 臀桥就抬到那么高；
 *        - 「躯干倾角 ≥ 32°（俯撑）」这类**门槛**不是姿态本身，画的是这个动作的标准姿态。
 *      所以 tests/test-specs.mjs 能直接把「图标里的角度」和「判据里的角度」对上。
 *   2. 只输出矢量线段 + 头部圆点（纯线条、没有色块），进度条上只出现这些图标，不出现文字。
 *   3. **同一批格子用同一套比例尺**：不能每格各自缩放到填满方框，否则「深蹲」和「站直」
 *      会画得一样高，深度差别就没了。站立类以「脚底 + 髋」为锚点、躺姿类以「肩 / 髋」为锚点。
 *   4. 角度与关节点的关系和 tests/synthetic-pose.mjs 是同一套：
 *      膝角 θ 由「大腿相对竖直的夹角 a」和「小腿相对竖直的夹角 b」给出：θ = 180 − |a − b|。
 */

// 「仰卧抬腿那一类」的门控名（supineFlat / supineLow）只写在 engines.js 一处，这里跟着它走
import { isSupineGate } from './engines.js';

export const ICON_BOX = 32;

/**
 * 「用双腿开合幅度当判据」的动作（开合跳）：`kneeSpread` 是老的按膝盖量的口径，
 * `legSpread` 现在用「膝 / 踝取较大值」（见 metrics.js）。两个名字都画正面开合的火柴人。
 */
const isSpreadMetric = (m) => m === 'legSpread' || m === 'kneeSpread';

/** 人体各段长度（图标单位） */
const SEG = { shin: 5.2, thigh: 5.2, torso: 6.4, upper: 3.1, fore: 3.0, head: 1.55 };

/** 站立类：脚底落在 box 的这个 y 上；躺姿类：髋落在 box 的这个位置 */
const STAND_FLOOR = 29;
const STAND_HIP_X = 15;
const LIE_HIP = { x: 13, y: 19 };
/** 一个「站直的人」的总高（脚踝到头顶），用来定站立类的比例尺 */
const STAND_HEIGHT = SEG.shin + SEG.thigh + SEG.torso + SEG.head * 2.6;
const STAND_SCALE = (ICON_BOX - 4.5) / STAND_HEIGHT;
/** 躺姿一个人从脚到头的总长，用来定躺姿类的比例尺 */
const LIE_LENGTH = SEG.shin + SEG.thigh + SEG.torso + SEG.head * 3;
const LIE_SCALE = (ICON_BOX - 4) / LIE_LENGTH;

const rad = (d) => (d * Math.PI) / 180;
/** 距「正上方」deg 度的单位向量（向右为正） */
const up = (deg) => ({ x: Math.sin(rad(deg)), y: -Math.cos(rad(deg)) });
/** 距「正下方」deg 度的单位向量（向右为正） */
const down = (deg) => ({ x: Math.sin(rad(deg)), y: Math.cos(rad(deg)) });
const add = (p, v, k = 1) => ({ x: p.x + v.x * k, y: p.y + v.y * k });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d) => (Number.isFinite(v) ? v : d);
const seg = (a, b) => ({ a, b });

/* ------------------------------------------------------------------ *
 * 姿态构建
 * ------------------------------------------------------------------ */

/**
 * 站立 / 下蹲 / 箭步蹲（侧视）。以**髋**为原点搭骨架，最后整体平移到「脚底落在 STAND_FLOOR」。
 *
 * @param o.knee      前（或唯一）腿的膝角，180 = 伸直
 * @param o.thighFwd  大腿相对竖直往前抬的角度（默认按膝角自动算）
 * @param o.backKnee  后腿膝角（箭步蹲；给 null = 单腿/双腿并拢）
 * @param o.stride    前后脚分开量（箭步蹲用）
 * @param o.lean      躯干相对竖直的角度
 * @param o.elbow     肘角
 * @param o.armDown   上臂相对向下的角度
 * @param o.airborne  跳起来（整幅图离地）
 */
function buildStand({
  knee = 176, thighFwd = null, backKnee = null, stride = 0, lean = 6,
  armDown = 0, elbow = 172, airborne = false,
} = {}) {
  const lines = [];
  const circles = [];
  const hip = { x: 0, y: 0 };
  const d = 180 - clamp(num(knee, 176), 60, 182);   // 需要弯掉的角度

  // 前腿：大腿前抬 a，小腿相对竖直 b，满足 180 − |a − b| = knee
  const a = Number.isFinite(thighFwd) ? thighFwd : (Number.isFinite(backKnee) ? d : d * 0.62);
  const b = a - d;
  const kneeP = add(hip, down(a), SEG.thigh);
  const ankle = add(kneeP, down(b), SEG.shin);
  lines.push(seg(hip, kneeP), seg(kneeP, ankle));
  let lowest = ankle.y;

  // 后腿（箭步蹲）：膝在身后、接近地面，小腿往后放平
  if (Number.isFinite(backKnee)) {
    const db = 180 - clamp(backKnee, 60, 182);
    const ab = -34 - stride * 4;              // 大腿向后下方
    const bb = ab - db;                        // 小腿比大腿再往后折一点
    const backKneeP = add(hip, down(ab), SEG.thigh);
    const backAnkle = add(backKneeP, down(bb), SEG.shin);
    lines.push(seg(hip, backKneeP), seg(backKneeP, backAnkle));
    lowest = Math.max(lowest, backKneeP.y, backAnkle.y);
  }

  const shoulder = add(hip, up(lean), SEG.torso);
  lines.push(seg(hip, shoulder));

  const elbowP = add(shoulder, down(armDown), SEG.upper);
  const wrist = add(elbowP, down(armDown + (180 - num(elbow, 172))), SEG.fore);
  lines.push(seg(shoulder, elbowP), seg(elbowP, wrist));

  const head = add(shoulder, up(lean), SEG.head * 1.6);
  circles.push({ x: head.x, y: head.y, r: SEG.head });

  // 平移：脚底贴到地面线（跳跃时整幅抬起来）。先缩放再落位，否则会跑出方框
  const shift = (p) => ({
    x: p.x * STAND_SCALE + STAND_HIP_X,
    y: (p.y - lowest) * STAND_SCALE + STAND_FLOOR - (airborne ? 1.8 : 0),
  });
  return {
    lines: lines.map((l) => seg(shift(l.a), shift(l.b))),
    circles: circles.map((c) => ({ ...shift(c), r: c.r * STAND_SCALE })),
  };
}

/**
 * 勾腿跳（站立勾腿）：**侧视站姿**，一条腿的脚跟往臀部勾起来。
 *
 * 为什么单独写一个：勾腿跳的判据（`oneSide` / `otherSide`）是「左右交替」这类分侧指标，
 * 落到通用分支里会被画成**躺着**的图（那是死虫式 / 登山者的样子），
 * 用户反馈「勾腿跳进度条上的图标应该是站立勾腿跳的图标」。
 *
 * @param o.kickKnee 勾起来那条腿的膝角（度），越小说明脚跟勾得越靠近臀部
 * @param o.kicked   'near' = 勾近侧腿（腿画在身体这一侧）；'far' = 勾远侧腿（往后一点，颜色一样但位置不同）
 */
function buildKick({ kickKnee = 100, kicked = 'near' } = {}) {
  const lines = [];
  const circles = [];
  const hip = { x: 0, y: 0 };

  // 支撑腿：几乎伸直，脚踩在地上（稍微往后一点，符合勾腿跳的站姿）
  const supThigh = kicked === 'near' ? 3 : 6;
  const supKnee = add(hip, down(supThigh), SEG.thigh);
  const supAnkle = add(supKnee, down(supThigh - 3), SEG.shin);
  lines.push(seg(hip, supKnee), seg(supKnee, supAnkle));

  // 勾起来的那条腿：大腿向后下方，小腿折回上方 —— 脚跟贴近臀部，膝角就是 kickKnee
  const kick = clamp(num(kickKnee, 100), 55, 175);
  const t = kicked === 'near' ? -16 : -26;          // 大腿相对竖直向后（负 = 向后）
  const s = t - (180 - kick);                        // 小腿：与大腿夹角 = 膝角
  const kickKneeP = add(hip, down(t), SEG.thigh);
  const kickAnkle = add(kickKneeP, down(s), SEG.shin);
  lines.push(seg(hip, kickKneeP), seg(kickKneeP, kickAnkle));

  const lowest = Math.max(supAnkle.y, supKnee.y, kickKneeP.y);

  // 躯干直立、手臂自然摆动（勾腿跳时手臂在体侧小幅摆动），画在最后免得被腿压住
  const shoulder = add(hip, up(4), SEG.torso);
  lines.push(seg(hip, shoulder));
  const armDown = kicked === 'near' ? -12 : 14;
  const elbowP = add(shoulder, down(armDown), SEG.upper);
  const wrist = add(elbowP, down(armDown - 26), SEG.fore);
  lines.push(seg(shoulder, elbowP), seg(elbowP, wrist));
  const head = add(shoulder, up(4), SEG.head * 1.6);
  circles.push({ x: head.x, y: head.y, r: SEG.head });

  const shift = (p) => ({
    x: p.x * STAND_SCALE + STAND_HIP_X,
    y: (p.y - lowest) * STAND_SCALE + STAND_FLOOR,
  });
  return {
    lines: lines.map((l) => seg(shift(l.a), shift(l.b))),
    circles: circles.map((c) => ({ ...shift(c), r: c.r * STAND_SCALE })),
  };
}

/**
 * 双段肢体求解（肩→肘→手，或髋→膝→踝）：给定两段长度和肘/膝角，
 * 求中间关节的位置。撑地类姿势靠它保证「手贴在地面上、身体高度由肘角决定」——
 * 肘弯得越多，身体越低，这正是俯卧撑真实的样子。
 */
function ikJoint(root, tip, l1, l2, bend = -1) {
  const dx = tip.x - root.x;
  const dy = tip.y - root.y;
  const dist = clamp(Math.hypot(dx, dy), Math.abs(l1 - l2) + 0.05, l1 + l2 - 0.05);
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const ux = dx / dist;
  const uy = dy / dist;
  return { x: root.x + ux * a + bend * -uy * h, y: root.y + uy * a + bend * ux * h };
}

/** 两段肢体在夹角为 deg 时，两端点的直线距离 */
const spanFor = (l1, l2, deg) => Math.sqrt(Math.max(0.01, l1 * l1 + l2 * l2 - 2 * l1 * l2 * Math.cos(rad(clamp(deg, 20, 180)))));

/**
 * 俯撑 / 仰卧 / 侧卧（侧视）。
 *
 * 两种锚点：
 *   - `support: true`（俯卧撑 / 平板 / 登山者）：**手撑在地面线上**，
 *     肩的高度由肘角算出来（肘越弯身体越低），所以每一格的高度差别一眼可见；
 *   - 其它：以肩（躺姿）或脚（站立类另有一套）为锚点。
 *
 * @param o.tilt    躯干相对竖直的角度（90 = 水平）
 * @param o.hip     髋角（躯干与大腿的夹角；180 = 腿与躯干一条线）
 * @param o.knee    膝角（180 = 腿伸直）
 * @param o.elbow   肘角（180 = 手臂伸直）
 * @param o.rise    髋部抬起量（倍躯干长，臀桥）
 * @param o.support 是不是「手撑地」的姿势
 * @param o.face    俯卧 'down' / 仰卧 'up' / 侧卧 'side' / 坐姿 'seated' / 前折 'fold'
 */
function buildLie({
  tilt = 90, hip = 178, knee = 100, elbow = 178, rise = 0,
  support = false, shoulderRise = 0, bodyLift = 0, hipLift = 0, kneeLift = 0,
  handMark = false, face = 'down', hip2 = NaN, knee2 = NaN,
} = {}) {
  const lines = [];
  const circles = [];
  const shoulder = support
    ? { x: 0, y: -spanFor(SEG.upper, SEG.fore, elbow) - bodyLift }   // 手在地面时，肩高 = 肩到手距离
    : { x: 0, y: -bodyLift };
  // 卷腹：肩离地量把肩「抬起来」，躯干也跟着立起来一点
  const riseTilt = shoulderRise > 0 ? tilt - clamp(shoulderRise, 0, 0.9) * 34 : tilt;
  const hipP = add(shoulder, up(riseTilt + 180), SEG.torso);
  lines.push(seg(shoulder, hipP));

  // 腿：方向 up(tilt − hip)，再由膝角折一次
  const thighDir = tilt - hip;
  const kneeP = add(hipP, up(thighDir), SEG.thigh);
  const ankle = add(kneeP, up(thighDir - (180 - num(knee, 100))), SEG.shin);
  lines.push(seg(hipP, kneeP), seg(kneeP, ankle));

  /**
   * 第二条腿（远侧腿）：死虫式要看出「**一条腿伸出去、另一条腿还屈在桌面位**」，
   * 光画一条腿看不出「一次只伸一条腿」这件事（用户反馈死虫式的关键帧不对）。
   *
   * 远侧腿整体往身体前方（+x，也就是脚的方向）挪一点点、并且稍微抬高一点，
   * 两条腿就不会完全重叠 —— 和勾腿跳里近侧/远侧腿的处理一个道理。
   */
  let hipP2 = null;
  if (Number.isFinite(hip2)) {
    hipP2 = add(hipP, { x: 0.085, y: -0.035 });
    const d2 = tilt - hip2;
    const kneeP2 = add(hipP2, up(d2), SEG.thigh);
    const ankle2 = add(kneeP2, up(d2 - (180 - num(knee2, 100))), SEG.shin);
    lines.push(seg(hipP2, kneeP2), seg(kneeP2, ankle2));
  }

  // 「髋离地 / 膝离地」：把这一段整体抬起来，与地面拉开肉眼可见的空隙
  if (hipLift > 0) { hipP.y -= hipLift; kneeP.y -= hipLift * 0.4; }
  if (kneeLift > 0) { kneeP.y -= kneeLift; ankle.y -= kneeLift * 0.7; }

  // 臀桥：髋（和膝）整体抬起来，脚仍踩在地面
  if (rise > 0) {
    const lift = clamp(rise, 0, 0.6) * SEG.torso * 1.5;
    hipP.y -= lift;
    kneeP.y -= lift * 0.55;
    ankle.y = Math.min(ankle.y, 0);
  }

  // 手臂
  if (support) {
    const hand = { x: 0, y: 0 };
    const elbowP = ikJoint(shoulder, hand, SEG.upper, SEG.fore, -1);
    lines.push(seg(shoulder, elbowP), seg(elbowP, hand));
    // 「手 / 小臂贴地」再补一小段横线，一眼看出是撑在地面上
    if (handMark) lines.push(seg({ x: hand.x - 1.8, y: hand.y }, { x: hand.x + 2.0, y: hand.y }));
  } else {
    const armDir = face === 'up' || face === 'seated' ? 180 - 8 : 0;
    const elbowP = add(shoulder, down(armDir), SEG.upper);
    const wrist = add(elbowP, down(armDir + (180 - num(elbow, 178))), SEG.fore);
    lines.push(seg(shoulder, elbowP), seg(elbowP, wrist));
  }

  // 头
  const headDir = {
    up: tilt - 10, down: tilt + 16, side: tilt + 6, seated: tilt - 6, fold: tilt + 40,
  }[face] ?? tilt + 16;
  const head = add(shoulder, up(headDir), SEG.head * 2.1);
  circles.push({ x: head.x, y: head.y, r: SEG.head });

  // 统一落位：**地面线固定在 STAND_FLOOR 附近**（身体高度差才看得出来），横向按整幅图居中。
  // 支撑类的落位以「手」为准：身体被抬起来时，身体与地面之间的空隙就是「离地」的直观表现。
  const all = [...lines.flatMap((l) => [l.a, l.b]), ...circles.map((c) => ({ x: c.x, y: c.y - c.r }))];
  const lowest = support ? 0 : Math.max(...all.map((p) => p.y));
  const minX = Math.min(...all.map((p) => p.x)) - 1.5;
  const maxX = Math.max(...all.map((p) => p.x)) + 1.5;
  const dx = (ICON_BOX - (maxX - minX) * LIE_SCALE) / 2 - minX * LIE_SCALE;
  const shift = (p) => ({
    x: p.x * LIE_SCALE + dx,
    y: (p.y - lowest) * LIE_SCALE + STAND_FLOOR - 1.5,
  });
  return {
    lines: lines.map((l) => seg(shift(l.a), shift(l.b))),
    circles: circles.map((c) => ({ ...shift(c), r: c.r * LIE_SCALE })),
  };
}

/* ------------------------------------------------------------------ *
 * 判据 → 姿态
 * ------------------------------------------------------------------ */

const STRAIGHT_KNEE = 174;

/**
 * 开合跳 / 立姿开合类（正面）：**双腿按开合角张开、手臂按上举角摆动**。
 *
 * 判据是「双腿开合幅度」（legSpread = 膝间距与踝间距里更大的那个），所以画出来的就是那个开合幅度：
 * 并拢站好 = 两腿几乎竖直、手臂自然下垂；开到最大 = 两腿向外张开、双手举过头顶。
 * 这一套在网上没有「侧视骨架」对应物，所以单独写一个正面构建器 ——
 * 站立类的 buildStand 是侧视的，用它画开合跳会把「开」画成「前后迈步」。
 *
 * @param o.legAngle  每条腿相对竖直向外张开的角度（度）
 * @param o.armAngle  手臂相对「竖直向上」的角度：0 = 举过头顶，180 = 自然下垂
 */
function buildJack({ legAngle = 6, armAngle = 150 } = {}) {
  const S = { thigh: 6.2, shin: 6.2, torso: 7.4, head: 2.0, upper: 3.7, fore: 3.6 };
  const cx = ICON_BOX / 2;
  const la = clamp(num(legAngle, 6), 0, 34);
  const aa = clamp(num(armAngle, 150), 0, 180);

  const lines = [];
  const circles = [];
  // 脚底落在地面线上 → 髋的高度由开合角决定（张得越开，人越矮，看得出在「开」）
  const legLen = S.thigh + S.shin;
  const hip = { x: cx, y: STAND_FLOOR - legLen * Math.cos(rad(la)) };
  const shoulder = { x: cx, y: hip.y - S.torso };

  for (const side of [1, -1]) {
    const knee = add(hip, down(side * la), S.thigh);
    const ankle = add(knee, down(side * la), S.shin);
    lines.push(seg(hip, knee), seg(knee, ankle));
    const elbow = add(shoulder, up(side * aa), S.upper);
    const wrist = add(elbow, up(side * aa), S.fore);
    lines.push(seg(shoulder, elbow), seg(elbow, wrist));
  }
  lines.push(seg(hip, shoulder));
  circles.push({ x: shoulder.x, y: shoulder.y - S.head * 1.6, r: S.head });
  return { lines, circles };
}

/**
 * 把判据里的角度换成**画出来的**角度。
 *
 * 为什么要放大：146° 与 152° 的膝角在 32 像素的小图里几乎看不出差别，
 * 但它们的含义确实不同（开始 vs 计次）。所以画的时候把「需要弯掉的角度」放大一点，
 * 让每一格都能看出来在往下走 —— 顺序和判据严格一致（更难的判据一定画得更弯），
 * 判据本身的数字仍然原样显示在弹窗与悬停提示里。
 */
function amplify(value, gain, straightZone = 8) {
  const need = 180 - num(value, 180);
  if (need <= straightZone) return 180;
  return clamp(180 - need * gain, 88, 180);
}

/** 蹲得越深，上身自然越前倾（图标才像人在蹲） */
const leanForKnee = (knee) => 4 + clamp((180 - num(knee, 178)) / 90, 0, 1) * 20;

/** 髋比膝高（1 ≈ 站直、0 ≈ 大腿水平）→ 膝角 */
const kneeFromHipAboveKnee = (ratio) => clamp(90 + 88 * clamp(num(ratio, 1), 0, 1), 90, 178);

/**
 * 箭步蹲：前后腿一起画。
 *
 * 每一格只强调**它自己那条判据**，另一条腿按「到这一步为止的要求」来画：
 *   开始/计次（前膝）→ 后腿还是直的；双腿（后膝）→ 前腿取前面已过的前膝判据；
 *   满分（前膝）→ 两条腿都按各自最严的那条画。这样四格看起来是四张不同的图。
 */
function lungePose(stage, stages) {
  const idx = Math.max(0, stages.indexOf(stage));
  const isBack = stage.metric === 'straighterKnee';
  const frontStages = stages.map((s, i) => ({ s, i })).filter((x) => x.s.metric === 'frontKnee');
  const currentFront = (() => {
    // 这一格之前（含本格）已经过的前膝判据
    const past = frontStages.filter((x) => x.i <= idx);
    const pick = past.length ? past[past.length - 1] : frontStages[0];
    return num(pick?.s.value, 140);
  })();
  const backStage = stages.find((s) => s.metric === 'straighterKnee');
  const backRequiredYet = backStage ? stages.indexOf(backStage) <= idx : false;

  const frontKnee = isBack ? currentFront : num(stage.value, currentFront);
  const backKnee = isBack ? num(stage.value, 158) : (backRequiredYet ? num(backStage.value, 158) : 178);
  const drawnFront = amplify(frontKnee, 1.9);
  const drawnBack = amplify(backKnee, 1.6);
  return {
    builder: 'stand',
    params: {
      knee: drawnFront,
      // 前腿：小腿竖直、大腿前抬 → 标准箭步蹲（抬的角度就由膝角决定）
      thighFwd: Math.max(0, 180 - drawnFront),
      backKnee: drawnBack,
      stride: 1,
      lean: 6,
    },
    criterion: { knee: frontKnee, backKnee },
    drawn: { knee: drawnFront, backKnee: drawnBack },
  };
}

/**
 * 某一格画成什么姿态。
 * @param stage specStages() 里的一格
 * @param ctx   { id, posture, kind, stages }
 */
export function poseFor(stage, ctx = {}) {
  const metric = stage?.metric;
  const value = num(stage?.value, NaN);
  const posture = ctx.posture || 'stand';
  const stages = ctx.stages || [];
  const isPose = !!stage?.pose;

  if (metric === 'frontKnee' || metric === 'straighterKnee') return lungePose(stage, stages);
  // 勾腿跳（站立左右交替勾腿）：所有格子都画**站姿勾腿**的火柴人 ——
  // 第一格站直、第二格勾近侧腿、第三格勾远侧腿（换另一条腿）。
  // 不这么特判的话，oneSide / otherSide 会落到通用分支画成躺着的图（那是死虫式/登山者）。
  if (ctx.plan === 'standAlt') {
    if (isPose) return { builder: 'stand', params: { knee: 176, lean: 3, armDown: 8 }, criterion: { knee: 176 } };
    const kicking = stage.kind === 'finish' ? 'far' : 'near';
    const kickKnee = num(value, 100);
    return {
      builder: 'kick',
      params: { kickKnee, kicked: kicking },
      criterion: { knee: kickKnee },
      drawn: { knee: kickKnee },
    };
  }
  if (isPose) {
    // 开合跳这类「正面对镜头的开合动作」：起始格画并拢站直（手臂放下）
    if (isSpreadMetric(ctx.metric)) {
      return { builder: 'jack', params: { legAngle: 5, armAngle: 152 }, criterion: { spread: 0 } };
    }
    // 仰卧抬腿这类「躺平、腿伸直」的动作：起始格必须画**躺平 + 腿伸直**（≈180°），
    // 而不是躺着屈膝的姿势（那是臀桥 / 卷腹的起始位，两个动作的判据完全不同）
    if (ctx.metric === 'hip' && isSupineGate(ctx.gate)) {
      return {
        builder: 'lie',
        params: { tilt: 92, hip: 178, knee: 176, face: 'up', elbow: 172 },
        criterion: { hip: 178 },
      };
    }
    return gatePose(posture, value, stages, metric, ctx);
  }

  if (isSpreadMetric(metric)) {
    // 「开到最大」那一格：腿张开的角度由判据值决定，手臂同步举过头顶
    const open = stage.op === 'gte' || stage.op === 'gt';
    if (!open) {
      // 「并拢收回」那一格：姿势和起始格一样（本来就是回到起始位），
      // 加一个向下的箭头才分得出来 —— 否则会被「画得一样就合并」吃掉
      return {
        builder: 'jack',
        params: { legAngle: 5, armAngle: 152, mark: 'down' },
        criterion: { spread: value },
      };
    }
    const legAngle = clamp(7 + (num(value, 0.5) - 0.35) * 18, 7, 30);
    return {
      builder: 'jack',
      params: { legAngle, armAngle: 20 },
      criterion: { spread: value },
      drawn: { legAngle },
    };
  }

  // 躯干倾角：「不要超过 X°」是站姿门槛（画站直），「至少 X°」是要你趴下/折下去（画那个姿态）
  if (metric === 'torsoIncl' || metric === 'trunk') {
    const towardFloor = stage.op === 'gte' || stage.op === 'gt';
    if (!towardFloor) return gatePose(posture, value, stages, metric, ctx);
    if (posture === 'prone') return { builder: 'lie', params: { tilt: 90, hip: 178, knee: 172, elbow: 178, face: 'down', support: true } };
    if (posture === 'supine') return { builder: 'lie', params: { tilt: 92, hip: 118, knee: 96, face: 'up', elbow: 172 } };
    if (ctx.plan === 'stretchHold') return { builder: 'lie', params: { tilt: 28, hip: 178, knee: 176, face: 'fold', elbow: 170 } };
    // 波比跳的「俯撑」那一段：趴下去，比水平略斜
    return { builder: 'lie', params: { tilt: clamp(value + 25, 50, 90), hip: 178, knee: 172, elbow: 176, face: 'down', support: true } };
  }
  if (metric === 'hipClear') {
    // 髋离地：侧平板/前折这类就是「髋抬起来」
    if (ctx.plan === 'stretchHold') return gatePose(posture, value, stages, metric, ctx);
    return { builder: 'lie', params: { tilt: 90, hip: 175, knee: 168, face: 'side', elbow: 178, support: true, hipLift: 2.2 }, criterion: { hipClear: value } };
  }
  if (metric === 'shoulderClear') {
    if (posture === 'prone' || posture === 'side') {
      // 肩离地：撑起来（身体与地面拉开可见的空隙）
      return {
        builder: 'lie',
        params: {
          tilt: 90,
          hip: posture === 'side' ? 175 : 178,
          knee: 168,
          elbow: 178,
          face: posture === 'side' ? 'side' : 'down',
          support: true,
          bodyLift: 2.6,
        },
        criterion: { shoulderClear: value },
      };
    }
    return {
      builder: 'lie',
      params: {
        tilt: 92, hip: 118, knee: 150, elbow: 168,
        shoulderRise: clamp(value, 0, 0.9),   // 卷腹：卷得越高，躯干立得越多
      },
      criterion: { shoulderClear: value },
      drawn: { shoulderRise: clamp(value, 0, 0.9) },
    };
  }
  if (metric === 'kneeClear') {
    // 膝离地：膝盖抬离地面
    return { builder: 'lie', params: { tilt: 90, hip: 178, knee: 172, elbow: 178, face: 'down', support: true, kneeLift: 2.2 }, criterion: { kneeClear: value } };
  }
  if (metric === 'wristClear' || metric === 'wristClearMin') {
    // 手 / 小臂要贴在地面上：撑地 + 手掌处补一小段地面横线
    return { builder: 'lie', params: { tilt: 90, hip: 178, knee: 172, elbow: 178, face: 'down', support: true, bodyLift: 1.2, handMark: true }, criterion: { wristClear: value } };
  }

  if (metric === 'progress') {
    // 「回到起始位」这类用**识别器自己的比例线**（progress ≤ 0.16）判定的格子：
    // 判定照旧用比例（跟着用户自己的幅度走，和引擎同一条线），但**图标按判据里的真实数值画**
    // （「膝屈角 ≥ 157°」就画一条 157° 的腿）。这样它和门控格「站直（176°）」画出来不一样，
    // 不会被「画得一模一样就合并」的规则吃掉 —— 否则进度条最后一格会变成「计次」，
    // 用户就会看到「进度条满了、可是没计次」（真实踩过的坑）。
    const item = stage?.item || {};
    const inner = String(item.metricKey || '').replace('metric.', '');
    const innerValue = Number(item.value);
    if (inner && inner !== 'progress' && Number.isFinite(innerValue)) {
      return poseFor({ ...stage, metric: inner, value: innerValue, op: item.op }, ctx);
    }
    return gatePose(posture, value, stages, metric, ctx);
  }

  switch (metric) {
    case 'knee':
    case 'kneeBent': {
      const drawn = amplify(value, 1.3);
      return { builder: 'stand', params: { knee: drawn, lean: leanForKnee(drawn) }, criterion: { knee: value }, drawn: { knee: drawn } };
    }
    case 'kneeExtended': {
      // 「双腿伸直角 ≥ 145°」是要你站直 → 画站直
      const drawn = amplify(Math.max(STRAIGHT_KNEE, value), 1.3);
      return { builder: 'stand', params: { knee: drawn, lean: 5 }, criterion: { knee: value }, drawn: { knee: drawn } };
    }
    case 'hipAboveKnee': {
      const aim = kneeFromHipAboveKnee(value);
      const drawn = amplify(aim, 1.3);
      return {
        builder: 'stand',
        params: { knee: drawn, lean: leanForKnee(drawn) },
        criterion: { knee: aim, hipAboveKnee: value },
        drawn: { knee: drawn },
      };
    }
    case 'elbow': {
      const drawn = amplify(value, 1.2, 6);
      return posture === 'prone'
        ? { builder: 'lie', params: { tilt: 90, hip: 178, knee: 172, elbow: drawn, face: 'down', support: true }, criterion: { elbow: value }, drawn: { elbow: drawn } }
        : { builder: 'stand', params: { elbow: drawn, armDown: 6 }, criterion: { elbow: value }, drawn: { elbow: drawn } };
    }
    case 'lift':
      return { builder: 'stand', params: { knee: 150, lean: 10, armDown: -25, elbow: 168, airborne: true } };
    case 'shoulderDrop':
      // 肩膀沉到接近地面：撑地姿势下肘弯得越多、身体越低（物理上就是这么回事）
      return {
        builder: 'lie',
        params: {
          tilt: 90,
          hip: 178,
          knee: 172,
          elbow: clamp(180 - (180 * clamp(value, 0, 0.5)) / 0.5, 95, 178),
          face: 'down',
          support: true,
        },
        criterion: { shoulderDrop: value },
        drawn: { elbow: clamp(180 - (180 * clamp(value, 0, 0.5)) / 0.5, 95, 178) },
      };
    case 'hip': {
      // 仰卧类：髋角越大腿越贴地、越小腿越抬起来。回到起始位那一格加个向下箭头，
      // 明确表示「控制着放回去」，也避免和起始格看起来一样
      const finishing = stage?.kind === 'finish';
      return {
        builder: 'lie',
        params: {
          tilt: 92, hip: value, knee: 172, face: 'up', elbow: 170,
          ...(finishing ? { mark: 'down' } : {}),
        },
        criterion: { hip: value },
        drawn: { hip: value },
      };
    }
    case 'hipRise': {
      const rise = clamp(num(value, 0), 0, 0.6);
      // 「顶起」那一格（要求抬到 ≥0.22×躯干长）：画成髋部确实抬起来的臀桥顶，上面加一个向上的箭头
      if (stage?.kind !== 'finish' && rise >= 0.15) {
        return {
          builder: 'lie',
          params: { tilt: 92, hip: 92, knee: 92, rise, face: 'up', elbow: 172, mark: 'up' },
          criterion: { hipRise: value },
          drawn: { rise },
        };
      }
      // 「落回 / 还没抬起来」：画成**屈腿仰卧、双脚踩地**，并加一个向下箭头 ——
      // 一眼看出这是「回到仰卧」（而不是又一个躺着的姿势，也不会跟门控格混成同一张图）
      return {
        builder: 'lie',
        params: { tilt: 92, hip: 118, knee: 96, face: 'up', elbow: 172, mark: 'down' },
        criterion: { hipRise: value },
      };
    }
    case 'oneSide':
      return { builder: 'lie', params: { tilt: 90, hip: 150, knee: clamp(value, 60, 180), face: 'down', support: true }, criterion: { knee: value }, drawn: { knee: clamp(value, 60, 180) } };
    case 'otherSide':
      return { builder: 'lie', params: { tilt: 90, hip: 176, knee: clamp(value, 60, 180), face: 'down', support: true }, criterion: { knee: value }, drawn: { knee: clamp(value, 60, 180) } };
    /**
     * 死虫式（`metric.oneSideLeg` / `metric.otherSideLeg`）：**仰卧 + 一条腿伸出去 + 另一条腿留在桌面位**。
     *
     * 为什么单独一档：落到通用的 `oneSide`/`otherSide` 分支会被画成**脸朝下的俯卧**图
     * （那是登山者的样子），而这两格的判据根本不是膝角、也不是俯撑。
     * 这里两格都画仰卧：第二格近侧腿伸出去（远侧腿屈在桌面位），第三格反过来（远侧腿伸出去），
     * 再给第三格补一个向下箭头 —— 否则两格几乎一样，「换另一条腿」这件事看不出来。
     */
    case 'oneSideLeg':
    case 'otherSideLeg': {
      // 画的是**姿态**而不是判据那个数字：132° 是「至少伸到这里就算」的下限，
      // 真按 132° 画出来（大腿离竖直才 40°）和桌面位的 118° 几乎看不出区别。
      // 这和 gatePose 的取舍一致：门槛值是下限，不是姿态本身。
      const tee = { hip: 118, knee: 96 };          // 桌面位：大腿竖直、膝屈 ≈90°
      const out = { hip: 168, knee: 175 };         // 腿伸出去贴地（膝伸直、大腿从桌面位展开）
      const working = metric === 'oneSideLeg';
      const far = working ? tee : out;             // 远侧腿：第二格还屈着，第三格才是它伸出去
      return {
        builder: 'lie',
        params: {
          tilt: 92,
          face: 'up',
          elbow: 172,
          hip: working ? out.hip : tee.hip,
          knee: working ? out.knee : tee.knee,
          hip2: far.hip,
          knee2: far.knee,
          ...(working ? {} : { mark: 'down' }),
        },
        criterion: { legOut: num(value, 132) },
        drawn: { hip: out.hip },
      };
    }
    default:
      return gatePose(posture, value, stages, metric, ctx);
  }
}

/**
 * 「姿势到位」那一格：画这个动作的标准姿态。
 * 注意门槛值（比如「躯干倾角 ≥ 32°」）是**下限**，不是姿态本身，
 * 所以这里不拿它当角度用；只有「前折」这类明显是姿态角度的才用得上。
 */
function gatePose(posture, value, stages, metric, ctx = {}) {
  switch (posture) {
    case 'prone':
      return { builder: 'lie', params: { tilt: 90, hip: 178, knee: 172, elbow: 178, face: 'down', support: true } };
    case 'supine':
      // 死虫式的第一格是「**桌面位**」：仰卧、双臂朝天、双腿屈膝 90° ——
      // 两条腿都画出来（只画一条看不出「双腿屈膝」这个起始姿势）。
      if (ctx.plan === 'repAlt') {
        return {
          builder: 'lie',
          params: { tilt: 92, hip: 118, knee: 96, hip2: 118, knee2: 96, face: 'up', elbow: 172 },
        };
      }
      return { builder: 'lie', params: { tilt: 92, hip: 118, knee: 96, face: 'up', elbow: 172 } };
    case 'side':
      return { builder: 'lie', params: { tilt: 90, hip: 175, knee: 150, face: 'side', elbow: 168, support: true } };
    case 'seated':
      return { builder: 'lie', params: { tilt: 70, hip: 152, knee: 58, face: 'seated', elbow: 168 } };
    default: {
      // 站立：默认画站直。只有拉伸类的「体前屈」动作才画成前折 ——
      // 门槛值（如「躯干倾角 ≥ 55°」）是下限，不是姿态本身，不能直接当角度画。
      if (ctx.plan === 'stretchHold') {
        return { builder: 'lie', params: { tilt: 28, hip: 178, knee: 176, face: 'fold', elbow: 170 } };
      }
      return { builder: 'stand', params: { knee: STRAIGHT_KNEE, lean: 5 } };
    }
  }
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

/** 某一格的线条图标（纯数据；测试可以直接核对里面的角度） */
export function stageIcon(stage, ctx = {}) {
  const pose = poseFor(stage, ctx);
  const built = pose.builder === 'lie' ? buildLie(pose.params)
    : (pose.builder === 'jack' ? buildJack(pose.params)
      : (pose.builder === 'kick' ? buildKick(pose.params) : buildStand(pose.params)));
  const lines = built.lines.concat(markLines(pose.params?.mark, pose.builder));
  return { lines, circles: built.circles, pose, builder: pose.builder, params: pose.params };
}

/**
 * 「顶起 / 落回」这类**方向标记**：一小段箭头，画在图形外侧的空白处。
 * 为什么要有它：臀桥的第 1 格（屈腿仰卧）和第 3 格（恢复屈腿仰卧）姿势本来就一样，
 * 只靠姿势区分不了；有了箭头就能一眼看出「这一格是往下回到地面」。
 * 位置在方框顶部中间 —— 躺着的人身体在中下部，那里是空的（站立类放在左上角）。
 */
function markLines(mark, builder) {
  if (!mark) return [];
  const cx = builder === 'lie' ? 16 : 4.2;
  const y1 = 3.2;
  const y2 = 9.2;
  const head = 2.1;
  if (mark === 'up') {
    return [
      seg({ x: cx, y: y2 }, { x: cx, y: y1 }),
      seg({ x: cx - head, y: y1 + head }, { x: cx, y: y1 }),
      seg({ x: cx + head, y: y1 + head }, { x: cx, y: y1 }),
    ];
  }
  return [
    seg({ x: cx, y: y1 }, { x: cx, y: y2 }),
    seg({ x: cx - head, y: y2 - head }, { x: cx, y: y2 }),
    seg({ x: cx + head, y: y2 - head }, { x: cx, y: y2 }),
  ];
}

/* ------------------------------------------------------------------ *
 * 判据里的关节角度：直接标在图标里
 * ------------------------------------------------------------------ */

/** 「这个数字是关节角（度）」的指标 */
const JOINT_ANGLE_METRICS = new Set([
  'elbow', 'elbowBent', 'elbowExtended',
  'knee', 'kneeBent', 'kneeExtended',
  'frontKnee', 'straighterKnee', 'hip', 'ankle',
]);

/** 图标里代表的是哪条判据（走识别器比例线的格子，看它展示用的判据条目） */
function stageCriterion(stage) {
  const item = stage?.item || {};
  const inner = String(item.metricKey || '').replace('metric.', '');
  if (stage?.metric === 'progress' && inner && inner !== 'progress') {
    return { metric: inner, value: Number(item.value) };
  }
  return { metric: stage?.metric, value: Number(stage?.value) };
}

/**
 * 一格判据里的关节角度（度数）；不是关节角、或者判据本身是文字（例如箭步蹲
 * 「从本轮最弯处回升 60%」这种没有固定角度的）就返回 null —— 免得图标里标出一个
 * 和弹窗不一致的数字。
 */
export function stageAngle(stage) {
  const item = stage?.item || {};
  const { metric } = stageCriterion(stage);
  if (!JOINT_ANGLE_METRICS.has(metric)) return null;
  if (item.textKey) return null;   // 判据本身是文字 → 弹窗里根本没有这个数字，不标
  const fromItem = Number(item.value);
  if (Number.isFinite(fromItem)) return fromItem;
  const own = Number(stage?.value);
  return Number.isFinite(own) ? own : null;
}

/**
 * 图标里要不要标出角度、标多少。
 *
 * 用户反馈「俯卧撑的关键帧图标太相似了，要有点区别，实在相似就在图标里标注关节度数」——
 * 所以规则是：**同一个动作里有两格用同一个关节角、而且两个度数相差 ≤12°（画出来几乎一样）**
 * 时，这条链上所有同一关节角的格子都标上数字（方便横向比较）。
 * 本来就一眼能区分的链（例如深蹲 176°→135°→112°→149°）不标，免得画面上全是数字。
 */
export function angleLabel(stage, ctx = {}) {
  const { metric } = stageCriterion(stage);
  const value = stageAngle(stage);
  if (!Number.isFinite(value)) return null;
  const same = (ctx.stages || []).filter((s) => stageCriterion(s).metric === metric);
  const vals = same.map(stageAngle).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return null;
  let ambiguous = false;
  for (let i = 0; i < vals.length && !ambiguous; i += 1) {
    for (let j = i + 1; j < vals.length; j += 1) {
      if (Math.abs(vals[i] - vals[j]) <= 12) { ambiguous = true; break; }
    }
  }
  return ambiguous ? `${Math.round(value)}°` : null;
}

/** 某一格的图标 SVG（进度条上只画这个 + 一个判据角度数字，不写别的文字） */
export function iconSVG(stage, ctx = {}) {
  const { lines, circles } = stageIcon(stage, ctx);
  const parts = lines.map((l) => {
    const a = l.a || l[0];
    const b = l.b || l[1];
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`;
  });
  for (const c of circles) parts.push(`<circle cx="${c.x}" cy="${c.y}" r="${c.r}" />`);
  const label = angleLabel(stage, ctx);
  if (label) {
    // 描边当底（paint-order: stroke）→ 数字压在线条上也看得清
    parts.push('<text class="criteria-deg" x="1.6" y="9.6" font-size="7.4" font-weight="800"'
      + ' fill="currentColor" stroke="#0b1422" stroke-width="1.6" paint-order="stroke"'
      + ` text-anchor="start">${label}</text>`);
  }
  return `<svg class="criteria-icon" viewBox="0 0 ${ICON_BOX} ${ICON_BOX}" aria-hidden="true">${parts.join('')}</svg>`;
}

/**
 * 同一批格子里，画出来一模一样的只留第一格。
 *
 * 为什么需要：计时类动作的判据（比如「躯干倾角 ≥ 38°」和「肩离地 ≥ 0.10」）描述的
 * 其实是同一个姿势，画出来一模一样；两格一样的图标并排只会让用户以为「这里有两步」。
 */
export function uniqueStages(stages, ctx = {}) {
  const seen = new Set();
  const out = [];
  for (const s of stages) {
    const sig = JSON.stringify(poseFor(s, ctx).params);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(s);
  }
  return out;
}

/** 图标里那个「被判定的关节角度」（测试用：等于判据里的角度） */
export function iconAngle(stage, ctx = {}) {
  const { pose } = stageIcon(stage, ctx);
  const c = pose.criterion || {};
  if (stage.metric === 'frontKnee') return c.knee;
  if (stage.metric === 'straighterKnee') return c.backKnee;
  if (stage.metric === 'elbow') return c.elbow;
  if (stage.metric === 'hip') return c.hip;
  if (stage.metric === 'knee' || stage.metric === 'kneeBent' || stage.metric === 'kneeExtended') return c.knee;
  return null;
}

/** 图标里**真正画出来**的关节角度（比判据夸张一点，保证深浅看得见） */
export function drawnAngle(stage, ctx = {}) {
  const { pose } = stageIcon(stage, ctx);
  const d = pose.drawn || {};
  const params = pose.params || {};
  if (stage.metric === 'frontKnee') return d.knee ?? params.knee;
  if (stage.metric === 'straighterKnee') return d.backKnee ?? params.backKnee;
  if (stage.metric === 'elbow') return d.elbow ?? params.elbow;
  if (stage.metric === 'hip') return d.hip ?? params.hip;
  if (stage.metric === 'knee' || stage.metric === 'kneeBent' || stage.metric === 'kneeExtended') {
    return d.knee ?? params.knee;
  }
  return null;
}

/** 图标里「身体重心的高度」（站立类）——深浅差别的可测指标 */
export function iconHipY(stage, ctx = {}) {
  const { lines } = stageIcon(stage, ctx);
  // 站立类：hip→shoulder 那条线段的起点就是髋（构建时第一条腿线的第二个点）
  const first = lines[0];
  return first ? Math.max(first.a.y, first.b.y) : null;
}

export const ICON_BUILDERS = { buildStand, buildLie, SEG, STAND_FLOOR, LIE_HIP };
