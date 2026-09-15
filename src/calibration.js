/**
 * 运动前的人体姿态校准。
 *
 * 画面上放一个虚线人体轮廓，引导用户站进去；所有检查全部通过并保持一小会儿后，
 * 判定「全身识别完成」，再提示用户开始运动与计数。
 *
 * 设计取舍：轮廓是给眼睛看的，判定用的是**几条稳健的数值检查**
 * （人体可见、全身入镜、距离合适、左右居中、高度合适、机位正确、保持不动），
 * 而不是逐点比对关节位置 —— 后者会因为手臂摆动、模型抖动而永远对不上。
 */

/** 目标轮廓与判定阈值（归一化画面坐标，x/y 都是画面宽/高的比例） */
export const OUTLINE = {
  centerX: 0.5,
  groundY: 0.92,        // 目标脚踝高度
  bodyTopY: 0.155,      // 目标头顶位置 → 身体约占画面高度 0.765
  // 上限特意压在「头顶刚好不出画」以内（groundY - spanMax = 0.06 > 0.04），
  // 否则站太近时会先报「头顶出画」而不是更贴切的「往后退一点」
  spanMin: 0.60,
  spanMax: 0.84,
  centerTol: 0.16,
  topTol: 0.14,         // 头顶允许偏离目标位置多少
  groundTol: 0.11,      // 脚踝允许偏离目标地面线多少
  holdMs: 1100,         // 全部通过后保持这么久才算校准完成
  steadyWindowMs: 700,  // 「保持不动」的观察窗口
  steadyTol: 0.028,     // 窗口内髋部最大位移（归一化）
};

/**
 * 虚线剪影：**只勾勒人体外形的一条闭合曲线**，不再把关节连成「火柴人」。
 *
 * 为什么改成外形：用户要做的事只有一件 —— 站进轮廓里。画骨骼会让画面变得
 * 又密又乱（十几条粗线互相压叠），还容易让人以为必须把关节对齐才算数。
 * 一条干净的外形线，一眼就能看出「该站在哪、还差多少」。
 *
 * 数据说明：
 *   - 坐标是归一化的画面比例；`dx` 是相对画面中线的横向偏移（正数 = 画面右侧），y 是高度比例。
 *   - front 写「半侧」，另一半镜像得到 → 天然左右对称，改比例时不会两边不一致。
 *   - side 是侧身剪影（人像朝右），左右本来就不对称，所以写完整点列。
 *   - 比例按真人身材换算：横向偏移 ≈ 身高比例 × (身体高度 / 2) / 宽高比，
 *     所以剪影是「瘦长」的真实身材，而不是又宽又矮的雪人。
 */
const SILHOUETTE_HALF = [
  // 头（占身高约 1/7.5，即画面高度 0.10）
  [0.000, 0.155],   // 头顶
  [0.018, 0.164],
  [0.025, 0.186],   // 头最宽
  [0.022, 0.222],
  [0.013, 0.245],   // 下颌
  [0.013, 0.262],   // 颈
  // 肩与手臂：手臂略微离开身体（10~20°），既能看清轮廓，也避免手臂挡住躯干影响识别
  [0.031, 0.278],
  [0.055, 0.296],   // 肩峰
  [0.072, 0.352],   // 上臂外侧
  [0.082, 0.445],   // 肘外侧
  [0.080, 0.490],
  [0.076, 0.520],   // 腕外侧
  [0.070, 0.555],
  [0.060, 0.594],   // 指尖（约在大腿中段）
  [0.052, 0.580],   // 手内侧
  [0.058, 0.520],
  [0.058, 0.445],   // 肘内侧
  [0.058, 0.352],
  [0.054, 0.305],   // 腋下
  // 躯干外缘
  [0.046, 0.374],   // 胸
  [0.040, 0.452],   // 腰（最细）
  [0.046, 0.531],   // 髋
  // 腿外侧
  [0.047, 0.580],
  [0.043, 0.715],   // 膝外侧
  [0.041, 0.800],
  [0.038, 0.900],   // 踝外侧
  // 脚
  [0.022, 0.928],   // 脚跟
  [0.026, 0.938],   // 脚底
  [0.050, 0.938],   // 脚尖
  [0.052, 0.924],   // 脚背
  [0.022, 0.905],   // 踝内侧
  // 腿内侧（回到中线收口）
  [0.022, 0.800],
  [0.016, 0.715],   // 膝内侧
  [0.011, 0.630],
  [0.000, 0.562],   // 裆部（中线）
];

const SILHOUETTE_SIDE = [
  // 头顶 → 身体前侧（人像朝右）
  [0.000, 0.155],
  [0.020, 0.164],
  [0.030, 0.190],   // 面部最前
  [0.022, 0.235],
  [0.008, 0.258],   // 下巴
  [0.012, 0.280],   // 颈前
  [0.030, 0.312],   // 胸
  [0.034, 0.372],   // 腹
  [0.026, 0.440],   // 小腹
  [0.032, 0.500],   // 髋前
  [0.036, 0.570],   // 大腿前
  [0.033, 0.719],   // 膝前
  [0.024, 0.820],   // 小腿前
  [0.019, 0.897],   // 踝前
  [0.023, 0.912],   // 脚背
  [0.054, 0.936],   // 脚尖
  [0.002, 0.938],   // 脚底
  [-0.020, 0.934],  // 脚跟
  [-0.014, 0.906],  // 踝后
  // 身体后侧 → 回到头顶
  [-0.010, 0.820],  // 小腿后
  [-0.019, 0.719],  // 膝后
  [-0.022, 0.600],  // 大腿后
  [-0.042, 0.545],  // 臀
  [-0.040, 0.500],  // 髋后
  [-0.032, 0.440],  // 腰后
  [-0.034, 0.372],  // 背
  [-0.038, 0.315],  // 肩胛
  [-0.014, 0.280],  // 颈后
  [-0.026, 0.235],  // 后脑
  [-0.030, 0.190],
  [-0.020, 0.164],
];

/**
 * 俯卧撑：**侧面的俯卧撑起状态**（人像朝右，头在右、脚在左）。
 * 身体是一条从肩到脚跟的直线（约离开地面 20°），双臂伸直撑地，手掌在肩的正下方。
 */
const SILHOUETTE_PUSHUP = [
  // 头与颈
  [0.172, 0.582],   // 头顶
  [0.202, 0.612],   // 面部最前
  [0.188, 0.640],   // 下巴
  [0.158, 0.650],   // 颈前
  [0.155, 0.668],   // 肩前
  // 撑地的手臂（前侧：肩 → 肘 → 手）
  [0.188, 0.700],
  [0.200, 0.770],
  [0.206, 0.838],   // 手外侧
  [0.195, 0.862],   // 手掌贴地
  [0.172, 0.858],   // 手内侧
  [0.160, 0.770],
  [0.148, 0.700],   // 腋下
  // 身体前侧（胸腹 → 大腿 → 小腿 → 脚背）向左
  [0.115, 0.690],
  [0.030, 0.720],
  [-0.020, 0.740],
  [-0.070, 0.760],
  [-0.120, 0.792],  // 膝前
  [-0.155, 0.822],
  [-0.182, 0.852],  // 脚背
  [-0.208, 0.872],  // 脚尖贴地
  // 身体后侧（脚跟 → 小腿 → 臀 → 背 → 后脑）回到头顶
  [-0.190, 0.845],
  [-0.182, 0.815],
  [-0.148, 0.790],
  [-0.100, 0.758],  // 膝后
  [-0.050, 0.730],
  [-0.008, 0.706],  // 臀
  [0.045, 0.680],
  [0.100, 0.655],   // 背
  [0.150, 0.625],   // 肩胛
  [0.168, 0.612],   // 颈后
  [0.180, 0.590],   // 后脑
];

/**
 * 平板支撑：同样是俯卧，但**靠小臂撑地**（肘在肩下、小臂贴地向前）。
 * 与俯卧撑区分开，用户一眼就知道该摆哪个姿势。
 */
const SILHOUETTE_PLANK = [
  [0.172, 0.582],
  [0.202, 0.612],
  [0.188, 0.640],
  [0.158, 0.652],
  [0.150, 0.668],   // 肩前
  // 小臂撑地：上臂竖直向下到肘，小臂贴地向前
  [0.152, 0.740],
  [0.150, 0.812],   // 肘前
  [0.190, 0.830],   // 小臂上缘
  [0.226, 0.840],   // 手
  [0.232, 0.860],
  [0.218, 0.872],   // 手掌贴地
  [0.180, 0.868],
  [0.145, 0.860],   // 肘底
  [0.135, 0.812],
  [0.138, 0.740],
  [0.142, 0.700],   // 腋下
  [0.110, 0.690],
  [0.030, 0.720],
  [-0.020, 0.740],
  [-0.070, 0.760],
  [-0.120, 0.792],
  [-0.155, 0.822],
  [-0.182, 0.852],
  [-0.208, 0.872],
  [-0.190, 0.845],
  [-0.182, 0.815],
  [-0.148, 0.790],
  [-0.100, 0.758],
  [-0.050, 0.730],
  [-0.008, 0.706],
  [0.045, 0.680],
  [0.100, 0.655],
  [0.145, 0.625],
  [0.168, 0.612],
  [0.180, 0.590],
];

/**
 * 臀桥 / 静态臀桥：**侧面的仰卧屈腿**（头在右、脚在左，脸朝上，髋还在地面上）。
 * 这是臀桥的起始姿势：仰卧、屈膝约 90°、双脚踩实地面，臀部落在地面上。
 * 侧拍时手臂被躯干挡住，剪影里不画手臂。
 */
const SILHOUETTE_BRIDGE = [
  // 头（后脑 → 头顶 → 面部）
  [0.225, 0.800],   // 后脑
  [0.180, 0.757],   // 头顶
  [0.140, 0.762],   // 额头
  [0.128, 0.790],   // 面部
  [0.133, 0.812],   // 下巴
  [0.128, 0.822],   // 颈前
  // 身体前侧（胸 → 腹 → 髋）朝上的那一面，向左
  [0.105, 0.808],
  [0.060, 0.798],
  [0.015, 0.795],
  [-0.022, 0.800],  // 髋前
  // 抬起的大腿与竖直的小腿
  [-0.050, 0.740],
  [-0.090, 0.652],  // 膝前（最高点）
  [-0.095, 0.740],
  [-0.092, 0.838],  // 踝前
  [-0.115, 0.850],  // 脚背
  [-0.156, 0.858],  // 脚尖
  // 身体后侧（脚掌 → 小腿 → 臀 → 背 → 后脑）回到起点
  [-0.118, 0.864],  // 脚掌贴地
  [-0.080, 0.864],  // 脚跟
  [-0.067, 0.836],
  [-0.048, 0.740],
  [-0.030, 0.664],  // 膝后
  [-0.003, 0.742],
  [0.006, 0.806],   // 臀
  [-0.008, 0.860],  // 臀部落在地面
  [0.045, 0.858],
  [0.080, 0.860],
  [0.115, 0.860],   // 肩后
  [0.142, 0.852],   // 颈后
  [0.200, 0.848],
];

/** 动作 → 机位 + 姿态。机位决定「机位正确」怎么判，姿态决定画哪种轮廓、怎么量距离和高度。 */
export const EXERCISE_POSE = {
  squat: { view: 'front', kind: 'front', posture: 'stand' },
  lunge: { view: 'side', kind: 'side', posture: 'stand' },
  pushup: { view: 'side', kind: 'pushup', posture: 'prone' },
  plank: { view: 'side', kind: 'plank', posture: 'prone' },
  bridge: { view: 'side', kind: 'bridge', posture: 'supine' },
  bridgehold: { view: 'side', kind: 'bridge', posture: 'supine' },
};

const DEFAULT_POSE = EXERCISE_POSE.lunge;

/** 取某个动作的机位与姿态 */
export function exercisePose(exerciseId) {
  return EXERCISE_POSE[exerciseId] || DEFAULT_POSE;
}

/** 每个动作要求的机位：深蹲要正面，其余要侧面 */
export function requiredView(exerciseId) {
  return exercisePose(exerciseId).view;
}

/** 每个动作的体态：站立 / 俯卧 / 仰卧，决定「距离、高度」按哪个方向量 */
export function requiredPosture(exerciseId) {
  return exercisePose(exerciseId).posture;
}

/** 该动作要画的虚线剪影种类 */
export function outlineKind(exerciseId) {
  return exercisePose(exerciseId).kind;
}

const SILHOUETTES = {
  side: SILHOUETTE_SIDE,
  pushup: SILHOUETTE_PUSHUP,
  plank: SILHOUETTE_PLANK,
  bridge: SILHOUETTE_BRIDGE,
};

/**
 * 剪影的点列（归一化坐标），首尾相连成一条闭合曲线。
 * kind：'front' 站姿正面（深蹲）、'side' 站姿侧面（箭步蹲）、
 *       'pushup' 俯卧撑、'plank' 平板支撑、'bridge' 臀桥/静态臀桥。
 * flip=true 时左右翻转，用来让轮廓跟上用户实际朝向（侧拍时人可能朝左或朝右）。
 */
export function outlinePath(kind, { flip = false } = {}) {
  const cx = OUTLINE.centerX;
  const put = ([dx, y]) => [cx + (flip ? -dx : dx), y];
  if (kind === 'front') {
    const pts = SILHOUETTE_HALF.map(put);
    // 首尾两点在中线上，镜像时跳过，避免在中线上出现重复点
    for (let i = SILHOUETTE_HALF.length - 2; i >= 1; i--) {
      pts.push([cx + (flip ? SILHOUETTE_HALF[i][0] : -SILHOUETTE_HALF[i][0]), SILHOUETTE_HALF[i][1]]);
    }
    return pts;
  }
  return (SILHOUETTES[kind] || SILHOUETTE_SIDE).map(put);
}

/** 剪影的外接框（归一化），用于自检、调试与「高度合适」的判定 */
export function outlineBounds(kind) {
  const pts = outlinePath(kind);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const left = Math.min(...xs); const right = Math.max(...xs);
  const top = Math.min(...ys); const bottom = Math.max(...ys);
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

/**
 * 躺姿（俯卧 / 仰卧）的判定阈值。
 * 躺下以后身体是横着的：竖直方向的跨度只剩身体厚度（约 0.2），
 * 所以「距离」改量身体在水平方向有多长（单位同样是画面高度，区间因此可以复用），
 * 「高度」改成看身体上下范围的中心落在哪一带。
 */
export const LYING = {
  spanMin: 0.60,
  spanMax: 0.84,
  centerTol: 0.13,   // 身体水平中点偏离画面中线的容忍度
  // 上下位置给得很宽：摄像头放桌上时躺姿会出现在画面偏下，放地上时又接近画面中央，
  // 这条只负责挡掉「整体跑到画面上半部分 / 贴边」的离谱情况，不该逼着用户为了对齐轮廓去挪地方。
  bandTol: 0.32,
  edgeMargin: 0.02,  // 身体不能贴边（贴边就说明没完整进画）
};

/**
 * 校准器：吃进每帧指标，吐出「还差什么」和「是否就位」。
 *
 * update() 返回：
 *   {
 *     done,                 // 校准完成（保持时间够了）
 *     ready,                // 当前这一帧全部检查通过
 *     progress,             // 保持进度 0~1
 *     checks: [id...],      // 通过了的检查项 id
 *     hintKey, hintParams,  // 当前最该做的一件事（第一个没通过的项）
 *   }
 */
export class Calibrator {
  constructor(exerciseId, opts = {}) {
    this.exerciseId = exerciseId;
    this.view = requiredView(exerciseId);
    this.posture = requiredPosture(exerciseId);
    this.kind = outlineKind(exerciseId);
    // 预览是否镜像：左右方向提示必须按「用户屏幕上看到的」来给，
    // 否则关掉镜像后会让人往反方向站。
    this.mirror = opts.mirror !== false;
    // 侧拍时人可能朝左也可能朝右：轮廓要跟着翻过来，否则头脚方向是反的
    this.facing = 1;
    this.reset();
  }

  setMirror(on) { this.mirror = !!on; }

  reset() {
    this.readySince = null;
    this.steadyBuf = [];
  }

  setExercise(exerciseId) {
    this.exerciseId = exerciseId;
    this.view = requiredView(exerciseId);
    this.posture = requiredPosture(exerciseId);
    this.kind = outlineKind(exerciseId);
    this.facing = 1;
    this.reset();
  }

  /** 躺姿（俯卧 / 仰卧）？——身体横着放，距离和高度要换一套量法 */
  get lying() { return this.posture !== 'stand'; }

  /** 返回 [{id, ok}]，顺序就是界面上的检查清单顺序 */
  evaluate(f) {
    const checks = [];
    const push = (id, ok) => checks.push({ id, ok });

    const visible = !!(f && f.ok && f.bodyVisible && f.coreVis > 0.5
      && f.perSide[f.side] && Number.isFinite(f.perSide[f.side].knee));
    push('visible', visible);
    if (!visible) {
      // 人体都没识别出来时，后面的检查没有意义，直接结束
      return checks;
    }

    if (!this.lying) {
      push('framing', f.bodyTop > 0.04 && f.groundY < 0.968);
      push('distance', f.bodySpan >= OUTLINE.spanMin && f.bodySpan <= OUTLINE.spanMax);
      push('center', Math.abs(f.centerXFrac - OUTLINE.centerX) <= OUTLINE.centerTol);
      // 「站进轮廓」的实质判断：头顶与脚位都要落在轮廓上。
      // 只查头顶的话，会出现“人明显站在轮廓外、面板却全绿”的矛盾。
      push('vertical', Math.abs(f.bodyTop - OUTLINE.bodyTopY) <= OUTLINE.topTol
        && Math.abs(f.groundY - OUTLINE.groundY) <= OUTLINE.groundTol);
    } else {
      // 躺姿：量「身体有多长」（水平方向）、身体中点是否居中、上下位置是否落在轮廓那一带
      const b = outlineBounds(this.kind);
      push('framing', f.bodyLeftFrac > LYING.edgeMargin && f.bodyRightFrac < 1 - LYING.edgeMargin
        && f.bodyTopY > LYING.edgeMargin && f.bodyBottomY < 1 - LYING.edgeMargin);
      push('distance', f.bodySpanX >= LYING.spanMin && f.bodySpanX <= LYING.spanMax);
      push('center', Math.abs(f.bodyMidFrac - OUTLINE.centerX) <= LYING.centerTol);
      const bodyMidY = (f.bodyTopY + f.bodyBottomY) / 2;
      push('vertical', Math.abs(bodyMidY - (b.top + b.bottom) / 2) <= LYING.bandTol);
    }
    push('view', f.view === this.view);
    push('steady', this.steady.ok);
    return checks;
  }

  /** 每帧调用；返回校准状态 */
  update(f, now) {
    // 先更新「保持不动」的观察窗口。
    // 站立时盯住「躯干中点 + 头顶」，躺姿时盯住「身体水平中点 + 上下中心」，
    // 后者对躺着的身体更灵敏（躺姿的头顶高度几乎不变）。
    this.steady = { ok: false, moved: 0 };
    const devX = this.lying ? f?.bodyMidFrac : f?.centerXFrac;
    const devY = this.lying && f && Number.isFinite(f.bodyTopY)
      ? (f.bodyTopY + f.bodyBottomY) / 2
      : f?.bodyTop;
    if (f && f.ok && Number.isFinite(devX) && Number.isFinite(devY)) {
      this.steadyBuf.push({ t: now, x: devX, y: devY });
      while (this.steadyBuf.length && now - this.steadyBuf[0].t > OUTLINE.steadyWindowMs) {
        this.steadyBuf.shift();
      }
      const xs = this.steadyBuf.map((p) => p.x);
      const ys = this.steadyBuf.map((p) => p.y);
      const moved = Math.max(...xs) - Math.min(...xs) + (Math.max(...ys) - Math.min(...ys));
      this.steady = { ok: this.steadyBuf.length >= 6 && moved <= OUTLINE.steadyTol, moved };
    } else {
      this.steadyBuf.length = 0;
    }

    // 头在髋的前方 → 人朝 +x（画面右侧），轮廓不用翻
    if (f && f.ok && Number.isFinite(f.facingX)) this.facing = f.facingX >= 0 ? 1 : -1;

    const checks = this.evaluate(f);
    const ready = checks.length > 0 && checks.every((c) => c.ok);

    if (ready) {
      if (this.readySince === null) this.readySince = now;
    } else {
      this.readySince = null;
    }
    const heldMs = this.readySince === null ? 0 : now - this.readySince;
    const done = heldMs >= OUTLINE.holdMs;

    const firstFail = checks.find((c) => !c.ok);
    const hint = firstFail ? this.hintFor(firstFail.id, f) : { key: 'calib.ready', params: null };

    return {
      done,
      ready,
      progress: Math.max(0, Math.min(1, heldMs / OUTLINE.holdMs)),
      checks,
      hintKey: hint.key,
      hintParams: hint.params,
    };
  }

  hintFor(id, f) {
    switch (id) {
      case 'visible':
        return { key: 'calib.visible' };
      case 'framing':
        // 躺姿是被左右边框切掉的（身体横着放），提示统一按「往中间挪 / 退后」给
        if (this.lying) return { key: 'calib.cutOff' };
        return { key: f && f.groundY >= 0.968 ? 'calib.feetCut' : 'calib.headCut' };
      case 'distance': {
        if (this.lying) {
          return { key: f && f.bodySpanX < LYING.spanMin ? 'calib.tooFar' : 'calib.tooClose' };
        }
        return { key: f && f.bodySpan < OUTLINE.spanMin ? 'calib.tooFar' : 'calib.tooClose' };
      }
      case 'center': {
        // centerLeft / centerRight 的语义是「该往哪边站」，不是「现在偏哪边」。
        // 先算出用户在**自己屏幕上**看到的位置（镜像时左右相反），再让他往反方向站。
        const at = this.lying ? (f?.bodyMidFrac ?? OUTLINE.centerX) : (f?.centerXFrac ?? OUTLINE.centerX);
        const appearsRight = this.mirror ? at < OUTLINE.centerX : at > OUTLINE.centerX;
        return { key: appearsRight ? 'calib.centerLeft' : 'calib.centerRight' };
      }
      case 'vertical': {
        if (this.lying) {
          // 躺姿看身体上下范围的中心：偏下 → 整体往上挪
          const b = outlineBounds(this.kind);
          const mid = (b.top + b.bottom) / 2;
          const bodyMid = f && Number.isFinite(f.bodyTopY) ? (f.bodyTopY + f.bodyBottomY) / 2 : mid;
          return { key: bodyMid > mid ? 'calib.moveUp' : 'calib.moveDown' };
        }
        // 头顶与脚位哪个偏得多就用哪个：整体偏下 → 往上站；偏上 → 往下站
        const dTop = (f?.bodyTop ?? OUTLINE.bodyTopY) - OUTLINE.bodyTopY;
        const dGround = (f?.groundY ?? OUTLINE.groundY) - OUTLINE.groundY;
        const err = Math.abs(dTop) > Math.abs(dGround) ? dTop : dGround;
        return { key: err > 0 ? 'calib.moveUp' : 'calib.moveDown' };
      }
      case 'view':
        return { key: this.view === 'front' ? 'calib.viewFront' : 'calib.viewSide' };
      case 'steady':
        return { key: 'calib.steady' };
      default:
        return { key: 'calib.adjust' };
    }
  }
}
