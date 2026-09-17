/**
 * 把一帧关键点换算成“动作指标”（BodyFrame）。
 *
 * 这里刻意只使用与人体尺度无关的量：
 *   - 关节角度（度）           → 与身高、摄像头距离无关
 *   - 长度比例（除以躯干长）   → 与摄像头距离无关
 *   - 上下先后关系（y 比较）   → 与左右朝向、镜像无关
 * 因此同一套阈值可以适配不同的人、不同的机位（只要侧对摄像头即可）。
 */

import {
  LM, angleAt2, angleAt3, dist2, mid, tiltFromVertical, signedLineDev, toDeg, clamp,
} from './geometry.js';

export const DEFAULT_CALIB = {
  torsoLen: 0.30,
  thighLen: 0.26,
  shinLen: 0.26,
  upperArmLen: 0.18,
  forearmLen: 0.17,
  ready: false,
  view: 'side',
};

const SIDE_IDX = {
  L: { shoulder: LM.L_SHOULDER, elbow: LM.L_ELBOW, wrist: LM.L_WRIST, hip: LM.L_HIP, knee: LM.L_KNEE, ankle: LM.L_ANKLE, heel: LM.L_HEEL, foot: LM.L_FOOT },
  R: { shoulder: LM.R_SHOULDER, elbow: LM.R_ELBOW, wrist: LM.R_WRIST, hip: LM.R_HIP, knee: LM.R_KNEE, ankle: LM.R_ANKLE, heel: LM.R_HEEL, foot: LM.R_FOOT },
};

/**
 * 计算一帧的全部动作指标。
 * @param {Array} metric 已按宽高比校正的关键点
 * @param {object} calib 校准结果（可缺省，缺省时用当前帧自测的比例）
 * @param {number} now 毫秒时间戳
 * @param {boolean} use3d 是否用三维世界坐标计算关节角
 * @param {Array|null} world 世界坐标关键点
 */
export function computeFrame(metric, calib, now, use3d = false, world = null) {
  const base = { ok: false, t: now };
  if (!metric || metric.length < 33) return base;

  const P = (i) => metric[i];
  const shoulderMid = mid(P(LM.L_SHOULDER), P(LM.R_SHOULDER));
  const hipMid = mid(P(LM.L_HIP), P(LM.R_HIP));

  // 画面中点估计的“地面高度”：脚踝是绝大多数动作里的最低支撑点
  const groundY = Math.max(P(LM.L_ANKLE).y, P(LM.R_ANKLE).y);

  const torsoLen = Math.max(1e-3, dist2(shoulderMid, hipMid));

  // 选“看得最清楚”的一侧（侧拍时远侧腿会被遮挡）
  const sides = ['L', 'R'].map((s) => {
    const idx = SIDE_IDX[s];
    const w = Math.min(
      P(idx.hip).v, P(idx.knee).v, P(idx.ankle).v,
      P(idx.shoulder).v, P(idx.elbow).v, P(idx.wrist).v,
    );
    return { s, w, idx };
  }).sort((a, b) => b.w - a.w);
  const best = sides[0];
  const idx = best.idx;

  const use3 = use3d && world && world.length >= 33;
  const angleAt = use3
    ? (a, b, c) => angleAt3(world[a], world[b], world[c])
    : (a, b, c) => angleAt2(metric[a], metric[b], metric[c]);

  // ---- 两侧关节角 ----
  const perSide = {};
  for (const s of ['L', 'R']) {
    const I = SIDE_IDX[s];
    perSide[s] = {
      knee: angleAt(I.hip, I.knee, I.ankle),
      hip: angleAt(I.shoulder, I.hip, I.knee),
      elbow: angleAt(I.shoulder, I.elbow, I.wrist),
      body: angleAt(I.shoulder, I.hip, I.ankle),
      kneeY: P(I.knee).y,
      hipY: P(I.hip).y,
      ankleY: P(I.ankle).y,
      vis: Math.min(P(I.hip).v, P(I.knee).v, P(I.ankle).v),
    };
  }

  // 取双侧平均（正面拍摄时更稳），同时保留“更弯的那条腿”用于深蹲/箭步蹲
  const val = (k) => {
    const a = perSide.L[k], b = perSide.R[k];
    if (!Number.isFinite(a)) return b;
    if (!Number.isFinite(b)) return a;
    return (a + b) / 2;
  };

  const kneeBent = Math.min(...['L', 'R'].map((s) => perSide[s].knee).filter(Number.isFinite));
  const kneeExtended = Math.max(...['L', 'R'].map((s) => perSide[s].knee).filter(Number.isFinite));

  // 主判定用的膝角取“看得最清的那一侧”：侧拍时远侧腿常被躯干遮挡、估得不准，
  // 用双侧平均会被它拖偏（这也是“站得笔直却拿不到站姿分”的常见原因）。
  const kneeAngle = Number.isFinite(perSide[best.s].knee) ? perSide[best.s].knee : val('knee');

  const hipAngle = perSide[best.s].hip;
  const bodyStraight = perSide[best.s].body;
  const elbowAngle = perSide[best.s].elbow;

  const torsoIncl = tiltFromVertical(hipMid, shoulderMid);          // 0=直立, 90=水平
  const shoulderClear = (groundY - shoulderMid.y) / torsoLen;        // 肩离地高度（躯干长为单位）
  const hipRise = (shoulderMid.y - hipMid.y) / torsoLen;             // 髋相对肩的高度（臀桥用）
  const kneeClear = (groundY - P(idx.knee).y) / torsoLen;            // 膝离地高度
  const wristClear = (groundY - P(idx.wrist).y) / torsoLen;          // 手离地高度
  const hipLineDev = signedLineDev(shoulderMid, P(idx.ankle), hipMid) / torsoLen; // >0 塌腰, <0 撅臀

  // 视角判断：肩宽 / 躯干长。正面 ≈ 0.8+，侧面 ≈ 0.1~0.4
  // 阈值放宽到 0.72：斜对镜头（约 45°）也当作“能用”，避免误判成正面而拿不到“侧对镜头”的分
  const shoulderW = dist2(P(LM.L_SHOULDER), P(LM.R_SHOULDER));
  const hipW = dist2(P(LM.L_HIP), P(LM.R_HIP));
  const viewRatio = shoulderW / torsoLen;
  const view = viewRatio > 0.72 ? 'front' : 'side';

  // 深蹲/箭步蹲的“髋低于膝”判据（用最弯的那条腿所在侧）
  const kneeSide = perSide[best.s];
  const hipBelowKnee = hipMid.y >= P(idx.knee).y - 0.05 * torsoLen;

  // 大腿与地面的夹角：0° = 大腿水平（深蹲“蹲到水平”），90° = 站立
  const thighDX = P(idx.knee).x - hipMid.x;
  const thighDY = P(idx.knee).y - hipMid.y;
  const thighFromHoriz = Math.abs(toDeg(Math.atan2(Math.abs(thighDY), Math.abs(thighDX))));

  // ---- 正面视角专用：竖直方向的量在正视图里不被压缩 ----
  // 小腿在图中的长度：深蹲时小腿的前倾发生在「前后」方向，正视图看不到，
  // 所以这个长度在下蹲过程中基本不变，是一个稳定的比例尺。
  const shinLen = Math.max(1e-3, dist2(P(idx.knee), P(idx.ankle)));
  // 髋比膝高多少（除以小腿长）：≈1.0 = 站直，≈0 = 蹲到大腿水平，<0 = 蹲过水平。
  // 这正是「蹲到平行」的严格定义，而且正对镜头也能测准。
  const hipAboveKnee = (P(idx.knee).y - hipMid.y) / shinLen;

  // ---- 校准用：人体在画面里的大小与位置 ----
  const bodyTop = Math.min(P(LM.NOSE).y, shoulderMid.y);
  const bodyBottom = groundY;
  const bodySpan = bodyBottom - bodyTop;
  const centerX = (shoulderMid.x + hipMid.x) / 2;
  // 上面这些量的单位是「画面高度」，而 x 还要除回宽高比才是「画面宽度比例」，
  // 校准的目标轮廓是画在归一化坐标里的，所以这里给出宽度比例版本，两者才能直接比较。
  const aspect = metric.aspect || 1;
  const centerXFrac = centerX / aspect;

  // ---- 躺姿（俯卧撑 / 平板支撑 / 臀桥）专用：躺下时身体是横着的 ----
  // 站立动作用 bodySpan（竖直跨度）判断「距离是否合适」；躺姿的竖直跨度只剩身体厚度
  //（约 0.2），拿它判断距离会永远不达标 —— 所以躺姿改量「身体在水平方向有多长」，
  // 单位同样是画面高度，阈值区间可以直接复用。
  const boxIdx = [
    LM.NOSE, LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP,
    LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE, LM.L_FOOT, LM.R_FOOT,
  ];
  const boxXs = boxIdx.map((i) => metric[i].x);
  const boxYs = boxIdx.map((i) => metric[i].y);
  const bodyLeft = Math.min(...boxXs);
  const bodyRight = Math.max(...boxXs);
  const bodySpanX = bodyRight - bodyLeft;       // 身体水平长度（画面高度为单位）
  const bodyLeftFrac = bodyLeft / aspect;       // 换成「画面宽度比例」，好跟轮廓比较
  const bodyRightFrac = bodyRight / aspect;
  const bodyMidFrac = (bodyLeftFrac + bodyRightFrac) / 2;
  const bodyTopY = Math.min(...boxYs);          // 躺姿的上下范围（抬腿时膝是最高的）
  const bodyBottomY = Math.max(...boxYs);
  // 侧拍时人可能朝左也可能朝右（±1）：用来把校准轮廓左右翻过来对上朝向
  const facingX = P(LM.NOSE).x >= hipMid.x ? 1 : -1;

  // 躯干相对竖直的倾斜（带方向：正=前倾到 +x 方向）
  const trunkLean = torsoIncl;

  // 膝盖内扣（仅正面视角有效）：膝间距明显小于踝间距
  const kneeGap = Math.abs(P(LM.L_KNEE).x - P(LM.R_KNEE).x);
  const ankleGap = Math.abs(P(LM.L_ANKLE).x - P(LM.R_ANKLE).x);
  const valgus = view === 'front' && ankleGap > 0.02 ? 1 - kneeGap / ankleGap : 0;

  const visMin = Math.min(...metric.map((p) => p.v ?? 1));
  // 只看核心关节的平均可见度：个别末端点（手指、耳朵）被遮挡不应该判定为“没人”
  const coreIdx = [
    LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP,
    LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE,
    LM.L_ELBOW, LM.R_ELBOW, LM.L_WRIST, LM.R_WRIST,
  ];
  const coreVis = coreIdx.reduce((s, i) => s + (metric[i].v ?? 1), 0) / coreIdx.length;

  // 全身是否入镜：至少一侧“髋-膝-踝-肩-肘-腕”链条清楚可见；
  // 真机侧拍时远侧肢体可见度天然偏低，所以门槛放宽，并允许用核心关节平均可见度兜底
  // 可见度门槛整体放宽（用户反馈识别太严）：只要核心关节大致看得见就算「识别到人」
  const bodyVisible = best.w > 0.28 || coreVis > 0.38;
  const legVisL = Math.min(P(LM.L_HIP).v, P(LM.L_KNEE).v, P(LM.L_ANKLE).v);
  const legVisR = Math.min(P(LM.R_HIP).v, P(LM.R_KNEE).v, P(LM.R_ANKLE).v);
  const legsVisible = legVisL > 0.16 && legVisR > 0.16;

  return {
    ok: coreVis > 0.16 && visMin > 0.03,
    t: now,
    side: best.s,
    perSide,
    // 关节角
    kneeAngle,
    kneeBent,
    kneeExtended,
    kneeFar: kneeExtended,
    hipAngle,
    elbowAngle,
    bodyStraight,
    // 比例量
    torsoLen,
    torsoIncl,
    trunkLean,
    shoulderClear,
    hipRise,
    kneeClear,
    wristClear,
    hipLineDev,
    hipBelowKnee,
    thighFromHoriz,
    shinLen,
    hipAboveKnee,
    bodyTop,
    bodyBottom,
    bodySpan,
    centerX,
    centerXFrac,
    bodySpanX,
    bodyLeftFrac,
    bodyRightFrac,
    bodyMidFrac,
    bodyTopY,
    bodyBottomY,
    facingX,
    valgus,
    view,
    viewRatio,
    bodyVisible,
    legsVisible,
    coreVis,
    groundY,
    shoulderWidth: shoulderW,
    hipWidth: hipW,
    points: metric,
    worldOk: !!use3,
  };
}

/** 逐帧指数平滑（用于躯干长这类缓慢变化的量） */
export function ema(prev, next, alpha = 0.05) {
  if (!Number.isFinite(prev)) return next;
  return prev + (next - prev) * alpha;
}

export function pick(obj, keys, fallback) {
  for (const k of keys) if (Number.isFinite(obj[k])) return obj[k];
  return fallback;
}

export { clamp };
