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
 * 目标骨架关节位置（归一化坐标）。
 * view='front' 用于深蹲（正对镜头），view='side' 用于其余动作（侧对镜头，人像朝右）。
 */
export function outlineJoints(view) {
  const cx = OUTLINE.centerX;
  if (view === 'front') {
    return {
      nose: [cx, 0.155],
      lShoulder: [cx - 0.115, 0.275], rShoulder: [cx + 0.115, 0.275],
      lElbow: [cx - 0.158, 0.405], rElbow: [cx + 0.158, 0.405],
      lWrist: [cx - 0.168, 0.525], rWrist: [cx + 0.168, 0.525],
      lHip: [cx - 0.078, 0.495], rHip: [cx + 0.078, 0.495],
      lKnee: [cx - 0.082, 0.715], rKnee: [cx + 0.082, 0.715],
      lAnkle: [cx - 0.082, 0.920], rAnkle: [cx + 0.082, 0.920],
      lFoot: [cx - 0.078, 0.935], rFoot: [cx + 0.078, 0.935],
    };
  }
  // 侧视：人像朝右（+x 方向）
  return {
    nose: [cx + 0.022, 0.155],
    lShoulder: [cx - 0.004, 0.275], rShoulder: [cx + 0.004, 0.278],
    lElbow: [cx - 0.010, 0.405], rElbow: [cx + 0.010, 0.408],
    lWrist: [cx - 0.016, 0.525], rWrist: [cx + 0.016, 0.528],
    lHip: [cx - 0.004, 0.495], rHip: [cx + 0.004, 0.498],
    lKnee: [cx + 0.026, 0.715], rKnee: [cx + 0.032, 0.718],
    lAnkle: [cx - 0.010, 0.920], rAnkle: [cx - 0.004, 0.923],
    lFoot: [cx + 0.042, 0.935], rFoot: [cx + 0.048, 0.935],
  };
}

/**
 * 轮廓的连线段：起点关节、终点关节、粗细（归一化）。
 * 用「画粗的虚线」来表现人体体积，比细线更像一个轮廓。
 */
export const OUTLINE_SEGMENTS = [
  ['shoulderMid', 'hipMid', 0.175],   // 躯干
  ['lShoulder', 'rShoulder', 0.095],  // 肩
  ['lHip', 'rHip', 0.095],            // 髋
  ['lShoulder', 'lElbow', 0.075],
  ['lElbow', 'lWrist', 0.065],
  ['rShoulder', 'rElbow', 0.075],
  ['rElbow', 'rWrist', 0.065],
  ['lHip', 'lKnee', 0.105],
  ['lKnee', 'lAnkle', 0.090],
  ['rHip', 'rKnee', 0.105],
  ['rKnee', 'rAnkle', 0.090],
  ['lAnkle', 'lFoot', 0.075],
  ['rAnkle', 'rFoot', 0.075],
];

/** 取轮廓上某个关节的位置（含 shoulderMid / hipMid 两个中点） */
export function outlinePoint(joints, name) {
  if (name === 'shoulderMid') {
    const a = joints.lShoulder; const b = joints.rShoulder;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  if (name === 'hipMid') {
    const a = joints.lHip; const b = joints.rHip;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  return joints[name];
}

/** 每个动作要求的机位：深蹲要正面，其余要侧面 */
export function requiredView(exerciseId) {
  return exerciseId === 'squat' ? 'front' : 'side';
}

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
  constructor(exerciseId) {
    this.exerciseId = exerciseId;
    this.view = requiredView(exerciseId);
    this.reset();
  }

  reset() {
    this.readySince = null;
    this.steadyBuf = [];
  }

  setExercise(exerciseId) {
    this.exerciseId = exerciseId;
    this.view = requiredView(exerciseId);
    this.reset();
  }

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

    push('framing', f.bodyTop > 0.04 && f.groundY < 0.968);
    push('distance', f.bodySpan >= OUTLINE.spanMin && f.bodySpan <= OUTLINE.spanMax);
    push('center', Math.abs(f.centerXFrac - OUTLINE.centerX) <= OUTLINE.centerTol);
    // 「站进轮廓」的实质判断：头顶与脚位都要落在轮廓上。
    // 只查头顶的话，会出现“人明显站在轮廓外、面板却全绿”的矛盾。
    push('vertical', Math.abs(f.bodyTop - OUTLINE.bodyTopY) <= OUTLINE.topTol
      && Math.abs(f.groundY - OUTLINE.groundY) <= OUTLINE.groundTol);
    push('view', f.view === this.view);
    push('steady', this.steady.ok);
    return checks;
  }

  /** 每帧调用；返回校准状态 */
  update(f, now) {
    // 先更新「保持不动」的观察窗口
    this.steady = { ok: false, moved: 0 };
    if (f && f.ok && Number.isFinite(f.centerXFrac)) {
      this.steadyBuf.push({ t: now, x: f.centerXFrac, y: f.bodyTop });
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
        return { key: f && f.groundY >= 0.968 ? 'calib.feetCut' : 'calib.headCut' };
      case 'distance':
        return { key: f && f.bodySpan < OUTLINE.spanMin ? 'calib.tooFar' : 'calib.tooClose' };
      case 'center':
        return { key: f && f.centerXFrac < OUTLINE.centerX ? 'calib.centerRight' : 'calib.centerLeft' };
      case 'vertical': {
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
