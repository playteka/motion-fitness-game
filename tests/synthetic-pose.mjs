/**
 * 合成人体姿态生成器（仅用于测试）。
 *
 * 在“公制空间”里搭建骨架：x 向右、y 向下，单位 = 画面高度的比例，
 * 因此 x 方向要先乘宽高比才能还原成 MediaPipe 的归一化坐标。
 * 生成的结果会走和真实摄像头完全一样的管线（toMetric → computeFrame → detector），
 * 所以这组测试验证的是真正的识别逻辑，而不是另写一套简化判据。
 */

import { LM } from '../src/geometry.js';

export const ASPECT = 16 / 9;

/** 人体各段长度（单位：画面高度） */
export const SEG = {
  torso: 0.32,
  thigh: 0.27,
  shin: 0.27,
  upper: 0.18,
  fore: 0.17,
  head: 0.13,
  shoulderW: 0.26,   // 正面视角：肩宽/躯干长 ≈ 0.81，与真人比例一致，便于机位识别
  hipW: 0.18,
};

/** 距“正上方”θ 度（向 +x 方向旋转）的单位向量 */
const up = (deg) => {
  const r = (deg * Math.PI) / 180;
  return { x: Math.sin(r), y: -Math.cos(r) };
};
/** 距“正下方”θ 度（向 +x 方向旋转）的单位向量 */
const down = (deg) => {
  const r = (deg * Math.PI) / 180;
  return { x: Math.sin(r), y: Math.cos(r) };
};
const add = (p, v, k = 1) => ({ x: p.x + v.x * k, y: p.y + v.y * k });

/**
 * 由“髋 + 大腿朝向 + 膝角”推出整条腿。
 * @param hip 髋关节位置
 * @param thighUp 髋→膝 方向相对“正上方”的角度（度）
 * @param knee 膝关节角（180 = 伸直）
 */
function legFromHip(hip, thighUp, knee) {
  const kneePos = add(hip, up(thighUp), SEG.thigh);
  const shinUp = thighUp - knee; // 小腿（踝→膝）相对正上方的角度
  const ankle = add(kneePos, up(shinUp), -SEG.shin);
  return { knee: kneePos, ankle, shinUp };
}

/**
 * 由“肩 + 上臂朝向 + 肘角”推出整条手臂。
 * @param shoulder 肩关节位置
 * @param armDown 上臂相对“正下方”的角度（度）
 * @param elbow 肘角（180 = 伸直）
 */
function armFromShoulder(shoulder, armDown, elbow) {
  const elbowPos = add(shoulder, down(armDown), SEG.upper);
  const wrist = add(elbowPos, down(armDown + (180 - elbow)), SEG.fore);
  return { elbow: elbowPos, wrist };
}

/** 把公制坐标转成 MediaPipe 风格的归一化坐标 */
function toNormalized(p, aspect) {
  return { x: p.x / aspect, y: p.y, z: 0 };
}

function blank() {
  return Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.5 }));
}

/**
 * 站立/蹲：脚踝固定在地面，其余关节由“膝角 + 躯干前倾 + 手臂姿态”推出。
 * @param {object} o
 *   ground     地面 y
 *   ankleX     脚踝 x
 *   knee       膝角（度）
 *   shinTilt   小腿前倾角（度）；缺省时由膝角自动推算
 *   lean       躯干前倾角（度）
 *   armDown    上臂相对向下的角度（度）
 *   elbow      肘角（度）
 */
export function standingPose(o = {}) {
  const {
    ground = 0.95,
    ankleX = 0.95,
    knee = 178,
    shinTilt = null,
    lean = 6,
    armDown = 0,
    elbow = 172,
    facing = 1,
    view = 'side',
    hipDX = 0,
    hipDY = 0,
    spread = 0,
    spreadAnkle = null,
  } = o;

  const st = shinTilt === null ? Math.min(26, Math.max(0, (180 - knee) * 0.24)) : shinTilt;
  const ankle = { x: ankleX, y: ground };
  const kneePos = add(ankle, up(st), SEG.shin);
  const thighUp = st - (180 - knee);
  const hip = add(kneePos, up(thighUp), SEG.thigh);
  hip.x += hipDX;
  hip.y += hipDY;
  const shoulder = add(hip, up(lean), SEG.torso);
  const arm = armFromShoulder(shoulder, armDown, elbow);

  return assemble({ hip, shoulder, knee: kneePos, ankle, ...arm, facing, view, ground, spread, spreadAnkle });
}

/**
 * 俯卧/俯撑：整条身体线由“身体倾角”决定，手臂自由摆放。
 * @param {object} o
 *   hip        髋关节绝对位置
 *   bodyTilt   身体线相对水平面的倾角（度）；越大肩越高
 *   elbow      肘角
 *   armDown    上臂相对向下的角度
 *   sag        额外把髋向下压的量（模拟塌腰）
 */
export function pronePose(o = {}) {
  const {
    hip = { x: 0.9, y: 0.7 },
    bodyTilt = 63,
    elbow = 172,
    armDown = 0,
    sag = 0,
    facing = 1,
  } = o;
  const lean = bodyTilt;                 // 躯干（髋→肩）相对竖直的角度 = 身体倾角
  const thighUp = lean + 180;            // 腿延续身体轴线，指向后方
  const shoulder = add(hip, up(lean), SEG.torso);
  const kneePos = add(hip, up(thighUp), SEG.thigh);
  const ankle = add(kneePos, up(thighUp), SEG.shin);
  const arm = armFromShoulder(shoulder, armDown, elbow);
  const hipAdj = { x: hip.x, y: hip.y + sag };
  return assemble({
    hip: hipAdj,
    shoulder,
    knee: kneePos,
    ankle,
    ...arm,
    facing,
    view: 'side',
  });
}

/**
 * 仰卧（臀桥）：髋位置 + 大腿朝向 + 膝角 + 躯干朝向。
 */
export function supinePose(o = {}) {
  const {
    hip = { x: 0.75, y: 0.9 },
    thighUp = 50,       // 髋→膝 相对正上方（>90 表示膝在髋前方且更高）
    knee = 100,
    torsoUp = 270,      // 髋→肩 相对正上方（270 = 水平指向 -x，即躺下）
    /**
     * 髋→肩 的**长度**（默认就是整条躯干 SEG.torso）。
     * 卷腹时躯干会折起来：胸廓向骨盆卷过去，肩到髋的距离随之变短
     * （用户观察「只有初始关键帧长度的 70% 左右」），所以这里可以传一个更短的值来建模。
     */
    torsoLen = SEG.torso,
    armDown = -90,      // 上臂沿地面指向后方
    elbow = 178,
    facing = 1,
  } = o;
  const shoulder = add(hip, up(torsoUp), torsoLen);
  const { knee: kneePos, ankle } = legFromHip(hip, thighUp, knee);
  const arm = armFromShoulder(shoulder, armDown, elbow);
  return assemble({ hip, shoulder, knee: kneePos, ankle, ...arm, facing, view: 'side' });
}

/**
 * 左右两条腿分别给定的姿态（箭步蹲）。
 */
export function twoLegPose(o = {}) {
  const {
    hip = { x: 0.75, y: 0.65 },
    front = { knee: 95, shinUp: 175 },
    back = { knee: 95, shinUp: 75 },
    lean = 8,
    armDown = 0,
    elbow = 172,
  } = o;
  const shoulder = add(hip, up(lean), SEG.torso);
  const arm = armFromShoulder(shoulder, armDown, elbow);
  const fKnee = add(hip, up(front.thighUp ?? 90 - lean), SEG.thigh);
  const fAnkle = add(fKnee, up(front.shinUp), -SEG.shin);
  const bKnee = add(hip, up(back.thighUp ?? 180 - lean), SEG.thigh);
  const bAnkle = add(bKnee, up(back.shinUp), -SEG.shin);
  return assemble({
    hip, shoulder, knee: fKnee, ankle: fAnkle, ...arm, facing: 1, view: 'side',
    sideB: { knee: bKnee, ankle: bAnkle },
  });
}

/** 由关键关节位置拼出 33 点，并按朝向镜像 */
function assemble(p) {
  const {
    hip, shoulder, knee, ankle, elbow, wrist, facing = 1, view = 'side', sideB = null, spread = 0, spreadAnkle = null,
  } = p;
  const mir = (q) => (facing === 1 ? q : { x: ASPECT - q.x, y: q.y });

  const half = (a, b, w) => {
    if (view !== 'front') return [a, a];
    return [
      { x: a.x + w / 2, y: a.y, z: a.z ?? 0, v: 0.92 },
      { x: a.x - w / 2, y: a.y, z: a.z ?? 0, v: 0.92 },
    ];
  };

  const lm = blank();
  const set = (i, q, vis) => { lm[i] = { x: q.x, y: q.y, z: q.z ?? 0, visibility: vis }; };
  const nearVis = 0.95;
  const farVis = view === 'front' ? 0.92 : 0.42;

  const [shL, shR] = half(shoulder, shoulder, SEG.shoulderW);
  const [hipL, hipR] = half(hip, hip, SEG.hipW);

  // 近侧腿 = 参数腿，远侧腿在侧拍时用同一条腿（可见度低）
  const farKnee = sideB ? sideB.knee : knee;
  const farAnkle = sideB ? sideB.ankle : ankle;
  const farKneeVis = sideB ? 0.92 : farVis;

  set(LM.L_SHOULDER, shL, nearVis);
  set(LM.R_SHOULDER, shR, view === 'front' ? 0.92 : farVis);
  set(LM.L_HIP, hipL, nearVis);
  set(LM.R_HIP, hipR, view === 'front' ? 0.92 : farVis);
  // 正面视角时两腿要左右分开（真人就是这样），否则膝间距为 0 会被误判成膝盖内扣。
  // o.spread 是额外的横向张开量（开合跳这类「双腿开合」的动作要用它）。
  const extra = view === 'front' ? spread : 0;
  // o.spreadAnkle：只把**脚**再往外挪（真人跳开时腿是往外撑的，脚张得比膝盖大得多，
  // 开合跳的真实几何就靠它来复现；见 metrics.js 里 legSpread 的说明）。
  const extraA = view === 'front' ? (spreadAnkle ?? spread) : 0;
  const latK = view === 'front' ? SEG.hipW / 2 + 0.02 + extra : 0;
  const latA = view === 'front' ? SEG.hipW / 2 + 0.03 + extraA : 0;
  const shiftX = (q, dx) => ({ x: q.x + dx, y: q.y, z: q.z ?? 0 });

  set(LM.L_KNEE, shiftX(knee, latK), nearVis);
  set(LM.R_KNEE, shiftX(farKnee, -latK), farKneeVis);
  set(LM.L_ANKLE, shiftX(ankle, latA), nearVis);
  set(LM.R_ANKLE, shiftX(farAnkle, -latA), farKneeVis);
  set(LM.L_HEEL, shiftX(add(ankle, up(90), 0.07), latA), nearVis);
  set(LM.R_HEEL, shiftX(add(farAnkle, up(90), 0.07), -latA), farKneeVis);
  set(LM.L_FOOT, shiftX(add(ankle, up(90), -0.13), latA), nearVis);
  set(LM.R_FOOT, shiftX(add(farAnkle, up(90), -0.13), -latA), farKneeVis);
  set(LM.L_ELBOW, elbow, nearVis);
  set(LM.R_ELBOW, elbow, farVis);
  set(LM.L_WRIST, wrist, nearVis);
  set(LM.R_WRIST, wrist, farVis);
  set(LM.L_PINKY, add(wrist, { x: 0, y: 0.02 }, 1), nearVis);
  set(LM.R_PINKY, add(wrist, { x: 0, y: 0.02 }, 1), farVis);

  const nose = add(shoulder, up(p.headUp ?? 0), SEG.head);
  set(LM.NOSE, nose, nearVis);
  set(LM.L_EYE, add(nose, { x: 0, y: -0.02 }, 1), nearVis);
  set(LM.R_EYE, add(nose, { x: 0.02, y: -0.02 }, 1), farVis);
  set(LM.L_EAR, add(nose, { x: -0.03, y: 0.01 }, 1), nearVis);
  set(LM.R_EAR, add(nose, { x: 0.03, y: 0.01 }, 1), farVis);
  set(LM.MOUTH_L, add(nose, { x: 0, y: 0.04 }, 1), nearVis);
  set(LM.MOUTH_R, add(nose, { x: 0.02, y: 0.04 }, 1), farVis);

  // 镜像 + 归一化
  return lm.map((q) => {
    const m = mir(q);
    return toNormalized(m, ASPECT);
  });
}

/** 补一帧“跟踪丢失”（全 0 可见度） */
export function lostFrame() {
  return blank().map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
}

/**
 * 把一条腿的小腿绕膝盖折过去（模拟「脚跟往臀部勾」）。
 *
 * `foldDeg` 是**真正的膝角变化量**：折叠后膝角 = 180 − foldDeg。
 * ⚠️ 必须在**公制空间**（x 乘画幅比例）里折叠：归一化坐标里 x 被压扁了，
 * 直接按归一化方向旋转会把角度放大近一倍（实测「折 35°」在真实几何里是 **54°/126°**），
 * 用它做的模型会失真 —— 之前测试里「支撑腿只弯一点」的模型其实是深蹲级别的膝角。
 */
export function foldShin(lm, side, foldDeg) {
  const iHip = LM[`${side}_HIP`];
  const iKnee = LM[`${side}_KNEE`];
  const iAnkle = LM[`${side}_ANKLE`];
  const iHeel = LM[`${side}_HEEL`];
  const iFoot = LM[`${side}_FOOT`];
  const toM = (p) => ({ x: p.x * ASPECT, y: p.y });
  const hip = toM(lm[iHip]);
  const knee = toM(lm[iKnee]);
  const ankle = toM(lm[iAnkle]);
  const thighDir = Math.atan2(knee.y - hip.y, knee.x - hip.x);
  const shinLen = Math.hypot(ankle.x - knee.x, ankle.y - knee.y) || 0.2;
  const a = thighDir + (foldDeg * Math.PI) / 180;
  const x = knee.x + Math.cos(a) * shinLen;
  const y = knee.y + Math.sin(a) * shinLen;
  /**
   * 脚跟 / 脚尖跟着小腿一起转（绕着膝转同样的角度）。
   * 不转它们的话，「脚跟到髋的距离」这个指标在测试里永远是站立的 1.0 ——
   * 而勾腿跳的**第二路证据**判的正是它（见 metrics.js 的 perSide.kick）。
   */
  const rot = (p) => {
    const dx = p.x - knee.x;
    const dy = p.y - knee.y;
    const cos = Math.cos((foldDeg * Math.PI) / 180);
    const sin = Math.sin((foldDeg * Math.PI) / 180);
    return { x: knee.x + dx * cos - dy * sin, y: knee.y + dx * sin + dy * cos };
  };
  if (lm[iHeel]) {
    const h = rot(toM(lm[iHeel]));
    lm[iHeel] = { ...lm[iHeel], x: h.x / ASPECT, y: h.y };
  }
  if (lm[iFoot]) {
    const ft = rot(toM(lm[iFoot]));
    lm[iFoot] = { ...lm[iFoot], x: ft.x / ASPECT, y: ft.y };
  }
  lm[iAnkle] = { ...lm[iAnkle], x: x / ASPECT, y };
  return lm;
}

export { up, down, add };
