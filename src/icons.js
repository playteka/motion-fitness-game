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
 * @param o.box       脚下画一个**箱子**（跳箱那一格：人要跳过它）
 */
function buildStand({
  knee = 176, thighFwd = null, backKnee = null, stride = 0, lean = 6,
  armDown = 0, elbow = 172, airborne = false, box = false,
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
  const drawn = lines.map((l) => seg(shift(l.a), shift(l.b)));
  /**
   * 跳箱那一格：脚下画一个**箱子**（四条边，已经是图标坐标，不参与上面的平移缩放）。
   * 人已经腾空（`airborne` 把脚抬到了地面线上方），箱子就摆在原本脚底的位置上 ——
   * 一眼就能看出「这一格是要跳过那个箱子」。
   */
  if (box) {
    const bw = 7.4;
    const bh = 2.6;
    const x0 = STAND_HIP_X - bw / 2;
    const x1 = STAND_HIP_X + bw / 2;
    const y1 = STAND_FLOOR + 1.4;
    const y0 = y1 - bh;
    drawn.push(
      seg({ x: x0, y: y0 }, { x: x1, y: y0 }),
      seg({ x: x1, y: y0 }, { x: x1, y: y1 }),
      seg({ x: x1, y: y1 }, { x: x0, y: y1 }),
      seg({ x: x0, y: y1 }, { x: x0, y: y0 }),
    );
  }
  return {
    lines: drawn,
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
 * @param o.forearm 撑地的是**小臂**（平板支撑）：肘在肩的正下方、小臂平贴地面向前伸 ——
 *                  和「手撑地」（俯卧撑，手臂竖直）区分开。见下面的画法。
 * @param o.face    俯卧 'down' / 仰卧 'up' / 侧卧 'side' / 坐姿 'seated' / 前折 'fold'
 * @param o.armDeg  **手臂方向的手动覆盖**（度；不传就按 face 走）。
 *                  仰卧的默认画法是「手臂朝天花板」—— 画关键帧够用，但**画动作图标时看着别扭**
 *                  （臀桥的人应该是双臂贴着地面放在身体两侧），所以臀桥图标传 282°（贴地、略朝脚的方向）。
 */
function buildLie({
  tilt = 90, hip = 178, knee = 100, elbow = 178, rise = 0,
  support = false, forearm = false, shoulderRise = 0, bodyLift = 0, hipLift = 0, kneeLift = 0,
  handMark = false, face = 'down', hip2 = NaN, knee2 = NaN, armDeg = NaN,
} = {}) {
  const lines = [];
  const circles = [];
  /**
   * 肩的位置：
   *   - `forearm`（小臂撑地）：肩在肘的正上方，高度正好是一条上臂 → 画出来就是**平板支撑**；
   *   - `support`（手撑地）：手在地面线上，肩高由肘角算出来（肘越弯身体越低）；
   *   - 其它：以肩为锚点。
   */
  const shoulder = support
    ? (forearm
      ? { x: 0, y: -SEG.upper - bodyLift }
      : { x: 0, y: -spanFor(SEG.upper, SEG.fore, elbow) - bodyLift })
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
  if (support && forearm) {
    // 小臂撑地（平板支撑）：肘落在肩的正下方、小臂平放在地面上向前伸 —— 就是「双肘撑地」的样子。
    // 顺便在地面线上补一小段，一眼看出小臂是压在垫子上的。
    const elbowP = { x: 0, y: 0 };
    const hand = { x: SEG.fore, y: 0 };
    lines.push(seg(shoulder, elbowP), seg(elbowP, hand));
    if (handMark) lines.push(seg({ x: -1.2, y: 0 }, { x: SEG.fore + 1.6, y: 0 }));
  } else if (support) {
    const hand = { x: 0, y: 0 };
    const elbowP = ikJoint(shoulder, hand, SEG.upper, SEG.fore, -1);
    lines.push(seg(shoulder, elbowP), seg(elbowP, hand));
    // 「手 / 小臂贴地」再补一小段横线，一眼看出是撑在地面上
    if (handMark) lines.push(seg({ x: hand.x - 1.8, y: hand.y }, { x: hand.x + 2.0, y: hand.y }));
  } else {
    const armDir = Number.isFinite(armDeg) ? armDeg
      : (face === 'up' || face === 'seated' ? 180 - 8 : 0);
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
 * @param o.knee      膝角（180 = 腿伸直）—— 相扑深蹲这类「正面 + 屈膝」的动作用它：
 *                    小腿相对大腿再向外折一点，人变矮、更宽，一眼就是「宽站屈膝」
 */
function buildJack({ legAngle = 6, armAngle = 150, knee = 180 } = {}) {
  const S = { thigh: 6.2, shin: 6.2, torso: 7.4, head: 2.0, upper: 3.7, fore: 3.6 };
  const cx = ICON_BOX / 2;
  const la = clamp(num(legAngle, 6), 0, 34);
  const aa = clamp(num(armAngle, 150), 0, 180);
  const bend = (180 - clamp(num(knee, 180), 90, 180)) / 2;   // 每条腿再折出去的角度

  const lines = [];
  const circles = [];
  // 脚底落在地面线上 → 髋的高度由开合角（和膝角）决定（张得越开、蹲得越深，人越矮）
  const legLen = S.thigh * Math.cos(rad(la)) + S.shin * Math.cos(rad(la + bend));
  const hip = { x: cx, y: STAND_FLOOR - legLen };
  const shoulder = { x: cx, y: hip.y - S.torso };

  for (const side of [1, -1]) {
    const kneeP = add(hip, down(side * la), S.thigh);
    const ankle = add(kneeP, down(side * (la + bend)), S.shin);
    lines.push(seg(hip, kneeP), seg(kneeP, ankle));
    const elbow = add(shoulder, up(side * aa), S.upper);
    const wrist = add(elbow, up(side * aa), S.fore);
    lines.push(seg(shoulder, elbow), seg(elbow, wrist));
  }
  lines.push(seg(hip, shoulder));
  circles.push({ x: shoulder.x, y: shoulder.y - S.head * 1.6, r: S.head });
  return { lines, circles };
}

/**
 * 「身体部位」示意图 —— **已改用现成的专业图标**（见下面的 `LIB_ICON_PATHS`），
 * 所以这里不再自己画；保留这个注释是为了说明历史与查找位置。
 */

/**
 * 现成的专业图标（**优先用它们，不自己画** —— ui-icon-design skill 的第 2 步）。
 *
 * 来源与许可：
 *   - Lucide 1.55（ISC 许可）：`biceps-flexed`（上肢）、`footprints`（下肢）、`flame`（核心）、
 *     `person-standing`（全身）、`corner-up-left`（返回）、`chevron-left` / `chevron-right`（上一页 / 下一页）、
 *     `house` / `trophy` / `settings` / `play`（界面按钮）
 *   - Tabler Icons 3.49 outline（MIT）：`stretching`（拉伸）
 * 这里只留它们的 `<path>` / `<circle>`，样式统一交给 CSS 的 `.ex-pose`（stroke 2 / currentColor / 圆头圆角），
 * 所以和手绘的动作图标是同一套几何参数。
 */
const LIB_ICON_PATHS = {
  // ---- 分类：上肢 / 下肢 / 核心 / 全身 / 拉伸 ----
  'cat:upper': '<path d="M12.409 13.017A5 5 0 0 1 22 15c0 3.866-4 7-9 7-4.077 0-8.153-.82-10.371-2.462'
    + '-.426-.316-.631-.832-.62-1.362C2.118 12.723 2.627 2 10 2a3 3 0 0 1 3 3 2 2 0 0 1-2 2c-1.105 0-1.64-.444-2-1"/>'
    + '<path d="M15 14a5 5 0 0 0-7.584 2"/><path d="M9.964 6.825C8.019 7.977 9.5 13 8 15"/>',
  'cat:lower': '<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/>'
    + '<path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/>'
    + '<path d="M16 17h4"/><path d="M4 13h4"/>',
  'cat:core': '<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/>',
  'cat:full': '<circle cx="12" cy="5" r="1"/><path d="m9 20 3-6 3 6"/><path d="m6 8 6 2 6-2"/><path d="M12 10v4"/>',
  'cat:stretch': '<path d="M15 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M5 20l5 -.5l1 -2"/>'
    + '<path d="M18 20v-5h-5.5l2.5 -6.5l-5.5 1l1.5 2"/>',
  // ---- 导航：返回 / 上一页 / 下一页 ----
  back: '<path d="M20 20v-7a4 4 0 0 0-4-4H4"/><path d="M9 14 4 9l5-5"/>',
  prev: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  // ---- 界面按钮（不再是 emoji）----
  'ui:home': '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/>'
    + '<path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'ui:trophy': '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/>'
    + '<path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/>'
    + '<path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/>'
    + '<path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  'ui:settings': '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/>'
    + '<circle cx="12" cy="12" r="3"/>',
  'ui:play': '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
  'ui:brand': '<path d="M17.596 12.768a2 2 0 1 0 2.829-2.829l-1.768-1.767a2 2 0 0 0 2.828-2.829l-2.828-2.828a2 2 0 0 0-2.829 2.828l-1.767-1.768a2 2 0 1 0-2.829 2.829z"/>'
    + '<path d="m2.5 21.5 1.4-1.4"/><path d="m20.1 3.9 1.4-1.4"/>'
    + '<path d="M5.343 21.485a2 2 0 1 0 2.829-2.828l1.767 1.768a2 2 0 1 0 2.829-2.829l-6.364-6.364a2 2 0 1 0-2.829 2.829l1.768 1.767a2 2 0 0 0-2.828 2.829z"/>'
    + '<path d="m9.6 14.4 4.8-4.8"/>',
  'ui:target': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  'ui:history': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  'ui:search': '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  'ui:hand': '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/>'
    + '<path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/>'
    + '<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  'ui:camera': '<path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"/>'
    + '<circle cx="12" cy="13" r="3"/>',
  'ui:maximize': '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/>'
    + '<path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  'ui:close': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

/** 现成图标的 SVG（样式由 `.ex-pose` / `.ui-icon` 给，这里只放形状） */
export function libIconSVG(key, cls = 'ex-pose') {
  const paths = LIB_ICON_PATHS[key];
  if (!paths) return '';
  return `<svg class="${cls}" viewBox="0 0 ${APP_ICON_BOX} ${APP_ICON_BOX}" aria-hidden="true">${paths}</svg>`;
}

/** 分类图标（上肢 / 下肢 / 核心 / 全身 / 拉伸）：用现成的专业图标 */
export function categoryMarkSVG(id) {
  return libIconSVG(`cat:${id}`);
}

/** 导航圆环的图标（返回 / 上一页 / 下一页）：用现成的专业箭头 */
export function navPoseSVG(kind) {
  return libIconSVG(kind);
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
    // 卷腹「卷起来」那一格：判定线是识别器自己算的（躺平基线 −13°），
    // 所以画成**肩离地、躯干折起来的卷腹**（比「屈膝躺下」那格明显高出一截、头也离开地面）。
    if (stage.valueFrom === 'curlLine' || stage.detFlag === 'curled') {
      return {
        builder: 'lie',
        params: { tilt: 92, hip: 118, knee: 96, face: 'up', elbow: 130, shoulderRise: 0.5 },
        criterion: { trunk: value },
      };
    }
    const towardFloor = stage.op === 'gte' || stage.op === 'gt';
    if (!towardFloor) return gatePose(posture, value, stages, metric, ctx);
    if (posture === 'prone') return { builder: 'lie', params: { tilt: 90, hip: 178, knee: 172, elbow: 178, face: 'down', support: true } };
    if (posture === 'supine') return { builder: 'lie', params: { tilt: 92, hip: 118, knee: 96, face: 'up', elbow: 172 } };
    if (ctx.plan === 'stretchHold') return { builder: 'lie', params: { tilt: 28, hip: 178, knee: 176, face: 'fold', elbow: 170 } };
    // 波比跳的「俯撑」那一段：趴下去，比水平略斜
    return { builder: 'lie', params: { tilt: clamp(value + 25, 50, 90), hip: 178, knee: 172, elbow: 176, face: 'down', support: true } };
  }
  if (metric === 'torsoShrink') {
    // 卷腹「卷到位」那一格（计次）：肩-髋距缩到躺平时的 ≈70~80% —— 画成**卷得最深的卷腹**
    // （比「卷起来」那格再高一截，一眼看得出是最后一步）。
    return {
      builder: 'lie',
      params: { tilt: 92, hip: 118, knee: 96, face: 'up', elbow: 130, shoulderRise: 0.85 },
      criterion: { torsoShrink: value },
    };
  }
  if (metric === 'hipClear') {    // 髋离地：前折这类就是「髋抬起来」
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

  if (metric === 'shoulderAngle') {
    // 平板支撑「肩撑住」那一格：**小臂撑地**的姿势（肘 ≈90°、上臂往下撑）。
    // 不特判的话会落到 gatePose 画成直臂撑（两种图标几乎一样），
    // 而这一格判的正是「上臂有没有往下撑住」。
    return {
      builder: 'lie',
      params: { tilt: 90, hip: 178, knee: 172, elbow: 90, face: 'down', support: true },
      criterion: { shoulderAngle: value },
    };
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
      // 跳箱那一格（`boxCleared` / `boxLine`）：人腾空到箱子上面，脚下画着那个箱子
      return {
        builder: 'stand',
        params: {
          knee: 150, lean: 10, armDown: -25, elbow: 168, airborne: true,
          ...(stage.detFlag === 'boxCleared' || stage.valueFrom === 'boxLine' ? { box: true } : {}),
        },
      };
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
  const label = angleLabel(stage, ctx);
  return poseSVG(lines, circles, 'criteria-icon', label ? {
    text: label,
    // 描边当底（paint-order: stroke）→ 数字压在线条上也看得清
    attrs: 'x="1.6" y="9.6" font-size="7.4" font-weight="800"'
      + ' fill="currentColor" stroke="#0b1422" stroke-width="1.6" paint-order="stroke" text-anchor="start"',
  } : null);
}

/** 把「线条 + 圆」拼成一张 SVG（进度条图标与动作图标共用一处写法） */
function poseSVG(lines, circles, cls, text = null) {
  const parts = lines.map((l) => {
    const a = l.a || l[0];
    const b = l.b || l[1];
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`;
  });
  for (const c of circles) parts.push(`<circle cx="${c.x}" cy="${c.y}" r="${c.r}" />`);
  if (text) parts.push(`<text class="criteria-deg" ${text.attrs}>${text.text}</text>`);
  return `<svg class="${cls}" viewBox="0 0 ${ICON_BOX} ${ICON_BOX}" aria-hidden="true">${parts.join('')}</svg>`;
}

/**
 * 动作的「人体姿势」图标 —— **19 个动作全部手绘**（用户要求「图标全面重新设计，
 * 保持风格的一致性，同时和运动动作有相关性」）。
 *
 * 为什么手绘：按 ui-icon-design skill 的第 2 步先在离线库里检索过 ——
 * Lucide / Tabler 只有通用的健身符号（`dumbbell` / `exercise-ball` / `flame` / `person-standing` …），
 * **没有**具体动作（squat / plank / lunge / crunch / bridge 检索命中 0），
 * 所以这 19 张按 skill 第 3 步的规格自己画；分类图标和导航箭头则用库里的现成图标（见上面）。
 *
 * 设计规则（三条，测试盯着）：
 *   1. **同一个画法**：全部由 `buildStand`（侧视站姿/蹲/箭步蹲，跳箱还会画出箱子）、
 *      `buildLie`（躺 / 撑 / 坐）、`buildJack`（正面开合）、`buildKick`（勾腿）四个构建器画出来，
 *      再统一映射到 skill 规定的 **24×24 网格 / 20×20 活动区 / 坐标落在 .5 上**；
 *   2. **姿势就是这个动作的姿势**：每个动作挑**最有辨识度的那一帧**，参数集中写在这一张表里；
 *   3. **互相不重复**：19 张图两两不同（测试逐个比对）。
 */
const EXERCISE_POSES = {
  /* ---- 上肢 ---- */
  // 俯卧撑：手撑地、肘弯到 100°（正在下去的途中，身体明显比平板支撑高）、身体一条线
  pushup: () => buildLie({
    tilt: 90, hip: 178, knee: 174, elbow: 100, face: 'down', support: true, handMark: true,
  }),

  /* ---- 下肢 ---- */
  // 自重深蹲：蹲到底（膝 ~92°）+ 上身前倾 + 双手前平举
  squat: () => buildStand({ knee: 92, lean: 22, armDown: 52, elbow: 150 }),
  // 相扑深蹲：正面视角、宽站 + 屈膝（正面才看得出「宽」）
  squatSumo: () => buildJack({ legAngle: 26, knee: 122, armAngle: 168 }),
  // 向前箭步蹲：大步幅、前膝 90°、后腿较直（后膝 105°）、上身前倾
  lunge: () => buildStand({ knee: 90, backKnee: 105, stride: 8, lean: 16, armDown: 30 }),
  // 向后箭步蹲：步幅小、后膝沉到接近地面（后膝 70°）、上身更直 —— 和向前箭步蹲一眼分得开
  lungeBack: () => buildStand({ knee: 94, backKnee: 70, stride: 3, lean: 8, armDown: 14 }),
  // 勾腿跳：站立、脚跟往臀部勾起来（画法直接沿用进度条那一套）
  buttKick: () => buildKick({ kickKnee: 68, kicked: 'near' }),

  /* ---- 核心 ---- */
  // 臀桥：躺下、屈膝、髋顶起来、身体绷直、双臂贴地
  bridge: () => buildLie({
    tilt: 92, hip: 176, knee: 92, rise: 0.35, face: 'up', elbow: 172, armDeg: 282,
  }),
  // 平板支撑：双肘撑地、小臂平贴地面、身体一条线
  plank: () => buildLie({
    tilt: 90, hip: 178, knee: 172, face: 'down', support: true, forearm: true, handMark: true,
  }),
  // 死虫式：仰卧，一条腿伸出去、另一条腿屈在「桌面位」，手臂朝上
  deadBug: () => buildLie({
    tilt: 92, hip: 176, knee: 172, hip2: 92, knee2: 92, face: 'up', armDeg: 196,
  }),
  // 卷腹：仰卧屈膝，肩离地卷起来（`shoulderRise` 就是把肩抬起来的那一项）
  crunch: () => buildLie({
    tilt: 92, hip: 118, knee: 96, shoulderRise: 0.62, face: 'up', armDeg: 206,
  }),
  // 反向卷腹：仰卧，膝盖往胸口收（髋角 70° = 大腿越过垂直、向胸口折）
  reverseCrunch: () => buildLie({
    tilt: 92, hip: 70, knee: 92, kneeLift: 2.2, face: 'up', armDeg: 278,
  }),
  // 仰卧抬腿：仰卧，双腿竖直向上伸直
  lyingLegRaise: () => buildLie({
    tilt: 92, hip: 92, knee: 176, face: 'up', armDeg: 278,
  }),

  /* ---- 全身 ---- */
  // 深蹲跳：腾空 + 双腿伸展 + 双臂上摆
  squatJump: () => buildStand({ knee: 168, lean: 8, armDown: -58, elbow: 162, airborne: true }),
  // 波比跳：腾空 + 双腿收起 + 双手举过头顶（和深蹲跳靠「收腿」区分）
  burpee: () => buildStand({ knee: 112, lean: 6, armDown: -84, elbow: 160, airborne: true }),
  // 登山者：手撑地、身体一条线、一条腿的膝盖往胸口提起来
  mountainClimber: () => buildLie({
    tilt: 90, hip: 178, knee: 172, elbow: 176, hip2: 112, knee2: 84,
    face: 'down', support: true, handMark: true,
  }),
  // 开合跳：正面、双腿张开、双手举过头顶
  jumpingJack: () => buildJack({ legAngle: 28, armAngle: 8 }),
  // 跳箱：腾空越过脚下的箱子（箱子由 buildStand 的 box 画出来）
  boxJump: () => buildStand({ knee: 132, lean: 12, armDown: 24, airborne: true, box: true }),

  /* ---- 拉伸 ---- */
  // 站立体前屈：膝盖基本伸直、上身折下去、双手垂向脚面
  standingForwardFold: () => buildStand({ knee: 172, lean: 76, armDown: 6, elbow: 166 }),
  // 坐姿体前屈：坐着、双腿前伸、上身往腿上折、双手前伸够脚
  seatedForwardFold: () => buildLie({
    tilt: 44, hip: 136, knee: 174, face: 'seated', armDeg: 264,
  }),
};

/**
 * 分类的「部位示意图」→ 已改用现成的专业图标（`LIB_ICON_PATHS` 的 `cat:*`）。
 * 动作图标回答「这个动作长什么样」，分类图标回答「这一类练哪儿」。
 */

/** 应用图标的画布：**24×24 网格、20×20 活动区居中**（ui-icon-design skill 的硬性规格） */
export const APP_ICON_BOX = 24;
const APP_LIVE = 20;
const APP_PAD = (APP_ICON_BOX - APP_LIVE) / 2;
/** 活动区里再留 0.5 的边（四舍五入到 .5 之后也不会顶到边线） */
const APP_INNER = APP_LIVE - 1;

/** 手绘骨架（32 单位）→ 24 网格：缩进 20×20 活动区，坐标落在整数 / .5 上（避免半像素虚边） */
const gridVal = (v) => Math.round((v / ICON_BOX * APP_LIVE + APP_PAD) * 2) / 2;

/**
 * 把内容整体缩放进活动区（保持比例、居中）。
 *
 * 四个构建器各有各的「张开幅度」（躺着的很长、跳起来的很高），直接映射进来会有的大有的小、
 * 腾空的还会顶出活动区；这一步统一缩放，让 19 张图在同一个 20×20 的框里**视觉重量一致**。
 */
function fitToLiveArea(lines, circles) {
  const xs = [...lines.flatMap((l) => [l.a.x, l.b.x]), ...circles.flatMap((c) => [c.x - c.r, c.x + c.r])];
  const ys = [...lines.flatMap((l) => [l.a.y, l.b.y]), ...circles.flatMap((c) => [c.y - c.r, c.y + c.r])];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const k = Math.min(1, APP_INNER / Math.max(maxX - minX, maxY - minY, 0.001));
  const mid = APP_ICON_BOX / 2;
  const px = (x) => Math.round((mid + (x - cx) * k) * 2) / 2;
  const py = (y) => Math.round((mid + (y - cy) * k) * 2) / 2;
  return {
    lines: lines.map((l) => ({ a: { x: px(l.a.x), y: py(l.a.y) }, b: { x: px(l.b.x), y: py(l.b.y) } })),
    circles: circles.map((c) => ({ x: px(c.x), y: py(c.y), r: Math.max(0.5, Math.round(c.r * k * 2) / 2) })),
  };
}

/**
 * 共线的小段合并成一段。
 *
 * skill 规定「一个图标最多 6 个元素」；人体姿势是**象形图**（一个关节必须两笔），
 * 所以这里把「肘 / 膝基本伸直」的那些两段合成一段 —— 伸直的手臂、站直的腿不用画成两笔，
 * 元素数就能从 10 降到 6~8（README 里写明了这条与 skill 规格的差异与原因）。
 */
function mergeStraightLimbs(lines, tol = 14) {
  const out = lines.map((l) => ({ a: { ...l.a }, b: { ...l.b } }));
  const ang = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length && !changed; i += 1) {
      for (let j = i + 1; j < out.length && !changed; j += 1) {
        const A = out[i];
        const B = out[j];
        const pairs = [[A.a, A.b, B.a, B.b], [A.a, A.b, B.b, B.a], [A.b, A.a, B.a, B.b], [A.b, A.a, B.b, B.a]];
        const hit = pairs.find(([p, , q]) => Math.hypot(p.x - q.x, p.y - q.y) < 0.05);
        if (!hit) continue;
        const [p, far1, , far2] = hit;
        let d = Math.abs(ang(p, far1) - ang(p, far2)) * 180 / Math.PI;
        if (d > 180) d = 360 - d;
        if (d > tol) continue;
        out.splice(j, 1);
        out.splice(i, 1, { a: far1, b: far2 });
        changed = true;
      }
    }
  }
  return out;
}

/** 把骨架画成 SVG（24 网格、只含 shapes、颜色走 currentColor） */
function appIconSVG(lines, circles) {
  const parts = lines.map((l) => `<line x1="${l.a.x}" y1="${l.a.y}" x2="${l.b.x}" y2="${l.b.y}" />`);
  for (const c of circles) {
    parts.push(`<circle cx="${c.x}" cy="${c.y}" r="${Math.max(0.5, Math.round((c.r / ICON_BOX * 24) * 2) / 2)}" />`);
  }
  return `<svg class="ex-pose" viewBox="0 0 ${APP_ICON_BOX} ${APP_ICON_BOX}" aria-hidden="true">${parts.join('')}</svg>`;
}

/** 动作的姿势图标（19 个动作都有；万一漏了返回空串，界面会退回图标字符） */
export function exercisePoseSVG(id) {
  const build = EXERCISE_POSES[id];
  if (!build) return '';
  const { lines, circles } = build();
  const merged = mergeStraightLimbs(lines);
  const fitted = fitToLiveArea(
    merged.map((l) => ({ a: { x: gridVal(l.a.x), y: gridVal(l.a.y) }, b: { x: gridVal(l.b.x), y: gridVal(l.b.y) } })),
    circles.map((c) => ({ x: gridVal(c.x), y: gridVal(c.y), r: c.r })),
  );
  return appIconSVG(fitted.lines, fitted.circles);
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
