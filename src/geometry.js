/**
 * 几何与信号处理工具。
 *
 * 坐标约定：x 向右，y 向下（与图像坐标一致）。
 * 所有用于“算角度 / 算比例”的坐标都经过宽高比校正，单位是“画面高度的比例”，
 * 这样 30° 就真的是 30°，与摄像头分辨率、人物在画面中的位置无关。
 */

/** MediaPipe Pose 的 33 个关键点索引 */
export const LM = {
  NOSE: 0,
  L_EYE_INNER: 1, L_EYE: 2, L_EYE_OUTER: 3,
  R_EYE_INNER: 4, R_EYE: 5, R_EYE_OUTER: 6,
  L_EAR: 7, R_EAR: 8,
  MOUTH_L: 9, MOUTH_R: 10,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_PINKY: 17, R_PINKY: 18,
  L_INDEX: 19, R_INDEX: 20,
  L_THUMB: 21, R_THUMB: 22,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30,
  L_FOOT: 31, R_FOOT: 32,
};

/** 用于绘制骨架的连线（成对的点索引） */
export const SKELETON_EDGES = [
  [LM.L_SHOULDER, LM.R_SHOULDER],
  [LM.L_SHOULDER, LM.L_HIP], [LM.R_SHOULDER, LM.R_HIP],
  [LM.L_HIP, LM.R_HIP],
  [LM.L_SHOULDER, LM.L_ELBOW], [LM.L_ELBOW, LM.L_WRIST],
  [LM.R_SHOULDER, LM.R_ELBOW], [LM.R_ELBOW, LM.R_WRIST],
  [LM.L_HIP, LM.L_KNEE], [LM.L_KNEE, LM.L_ANKLE],
  [LM.R_HIP, LM.R_KNEE], [LM.R_KNEE, LM.R_ANKLE],
  [LM.L_ANKLE, LM.L_FOOT], [LM.R_ANKLE, LM.R_FOOT],
  [LM.L_ANKLE, LM.L_HEEL], [LM.R_ANKLE, LM.R_HEEL],
  [LM.L_SHOULDER, LM.R_HIP], [LM.R_SHOULDER, LM.L_HIP],
];

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const toDeg = (r) => (r * 180) / Math.PI;
export const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

/** 中点（会合并可见度，取较低者，避免被遮挡的点“更可信”） */
export function mid(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: ((a.z || 0) + (b.z || 0)) / 2,
    v: Math.min(a.v ?? a.visibility ?? 1, b.v ?? b.visibility ?? 1),
  };
}

/** 二维夹角（度），顶点在 b。返回 0~180，NaN 表示退化 */
export function angleAt2(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const n1 = Math.hypot(v1x, v1y), n2 = Math.hypot(v2x, v2y);
  if (n1 < 1e-6 || n2 < 1e-6) return NaN;
  const cos = clamp((v1x * v2x + v1y * v2y) / (n1 * n2), -1, 1);
  return toDeg(Math.acos(cos));
}

/** 三维夹角（度），顶点在 b */
export function angleAt3(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y, v1z = (a.z || 0) - (b.z || 0);
  const v2x = c.x - b.x, v2y = c.y - b.y, v2z = (c.z || 0) - (b.z || 0);
  const n1 = Math.hypot(v1x, v1y, v1z), n2 = Math.hypot(v2x, v2y, v2z);
  if (n1 < 1e-6 || n2 < 1e-6) return NaN;
  const cos = clamp((v1x * v2x + v1y * v2y + v1z * v2z) / (n1 * n2), -1, 1);
  return toDeg(Math.acos(cos));
}

/**
 * 从 a 指向 b 的向量与“竖直方向”的夹角（度）。
 * 0 = 完全竖直，90 = 完全水平。
 */
export function tiltFromVertical(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 1e-6) return NaN;
  return Math.abs(toDeg(Math.atan2(dx, Math.abs(dy))));
}

/** 点到直线 (s -> e) 的有符号垂距，已按方向归一化：正值代表点“向地面方向”偏离 */
export function signedLineDev(s, e, p) {
  const vx = e.x - s.x, vy = e.y - s.y;
  const n = Math.hypot(vx, vy);
  if (n < 1e-6) return 0;
  const cross = vx * (p.y - s.y) - vy * (p.x - s.x);
  const orient = Math.sign(vx) || 1;
  return (cross / n) * orient;
}

/** 一欧元滤波器（低延迟自适应平滑），比滑动平均更跟手 */
export class OneEuro {
  constructor({ minCutoff = 1.1, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxHat = 0;
    this.xHat = null;
  }
  static _alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, dt) {
    if (!Number.isFinite(x)) return this.xHat ?? 0;
    if (this.xHat === null || !(dt > 0)) {
      this.xHat = x;
      this.xPrev = x;
      return x;
    }
    const dx = (x - this.xPrev) / dt;
    const aD = OneEuro._alpha(this.dCutoff, dt);
    this.dxHat = aD * dx + (1 - aD) * this.dxHat;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxHat);
    const a = OneEuro._alpha(cutoff, dt);
    this.xHat = a * x + (1 - a) * this.xHat;
    this.xPrev = x;
    return this.xHat;
  }
  reset() {
    this.xPrev = null;
    this.xHat = null;
    this.dxHat = 0;
  }
}

/** 对整帧 33 个关键点做平滑 */
export class LandmarkSmoother {
  constructor(count = 33, opts = {}) {
    const xy = { minCutoff: 2.0, beta: 5.0, ...opts };
    const z = { minCutoff: 1.0, beta: 2.0, ...opts };
    const v = { minCutoff: 0.5, beta: 0 };
    this.filters = Array.from({ length: count }, () => ({
      x: new OneEuro(xy), y: new OneEuro(xy), z: new OneEuro(z), v: new OneEuro(v),
    }));
  }
  apply(landmarks, tSec) {
    const out = [];
    const n = Math.min(landmarks.length, this.filters.length);
    const dt = this._lastT == null
      ? 1 / 30
      : Math.min(0.25, Math.max(1 / 240, tSec - this._lastT));
    for (let i = 0; i < n; i++) {
      const p = landmarks[i];
      const f = this.filters[i];
      out.push({
        x: f.x.filter(p.x, dt),
        y: f.y.filter(p.y, dt),
        z: f.z.filter(p.z ?? 0, dt),
        v: f.v.filter(p.visibility ?? p.v ?? 1, dt),
      });
    }
    this._lastT = tSec;
    return out;
  }
  reset() {
    for (const f of this.filters) { f.x.reset(); f.y.reset(); f.z.reset(); f.v.reset(); }
    this._lastT = null;
  }
}

/** 把归一化坐标转成“按宽高比校正”的坐标（单位 = 画面高度） */
export function toMetric(landmarks, aspect) {
  const out = [];
  for (const p of landmarks) {
    out.push({ x: p.x * aspect, y: p.y, z: (p.z ?? 0) * aspect, v: p.v ?? p.visibility ?? 1 });
  }
  return out;
}

/** 滑动中位数（用于校准，抗抖动） */
export function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 简易环形缓冲 */
export class Ring {
  constructor(size = 90) { this.size = size; this.buf = []; }
  push(v) { this.buf.push(v); if (this.buf.length > this.size) this.buf.shift(); }
  get values() { return this.buf; }
  clear() { this.buf = []; }
}
