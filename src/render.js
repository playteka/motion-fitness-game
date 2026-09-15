/**
 * 骨架绘制：把关键点画成“会变色的火柴人”，并标出当前动作关注的角度。
 */

import { LM, SKELETON_EDGES } from './geometry.js';
import { t } from './i18n.js';
import { outlinePath } from './calibration.js';

const COLORS = {
  ok: '#34e5c4',
  good: '#4ade80',
  warn: '#fbbf24',
  bad: '#f87171',
  idle: '#7c8aa5',
};

/**
 * 校准剪影专用配色（跟骨架分开，避免和画面里的火柴人撞色）。
 * 三种状态都是「亮到能在任何背景上看清」的高饱和色：
 * 亮天蓝 = 还没找到人、亮琥珀 = 正在调整、亮绿 = 已就位。
 */
const OUTLINE_COLORS = {
  search: '#38bdf8',
  adjust: '#fbbf24',
  ready: '#4ade80',
};

/** 每个动作重点关注的关节（用于高亮与角度标注） */
const FOCUS = {
  squat: ['knee', 'hip'],
  lunge: ['knee', 'hip'],
  pushup: ['elbow', 'hip'],
  bridge: ['hip', 'knee'],
  plank: ['hip', 'shoulder'],
  bridgehold: ['hip', 'knee'],
};

export class PoseRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.showAngles = true;
    this.showSkeleton = true;
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * 运动前校准用的虚线人体剪影。
   *
   * 只画**一条闭合的外部轮廓**：用户要做的事就是站进去，画骨骼只会让画面变乱。
   * 点位之间用二次贝塞尔平滑（以相邻两点的中点为锚），避免出现折线感。
   *
   * 颜色一律取高饱和亮色 + 高不透明度 + 外发光：摄像头画面里什么背景都有
   *（白墙、木地板、深色衣服），灰蓝色线条很容易糊在背景里看不见。
   *
   * @param {string} kind 剪影种类：front / side / pushup / plank / bridge
   * @param {'search'|'adjust'|'ready'} status 未找到人 / 正在调整 / 已就位
   * @param {boolean} flip 左右翻转（用户侧拍时朝左，轮廓要跟着翻）
   */
  drawOutline(kind, status = 'search', flip = false) {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    const color = OUTLINE_COLORS[status] || OUTLINE_COLORS.search;
    const base = Math.max(2, W / 420);

    ctx.save();
    ctx.setLineDash([base * 3.4, base * 3.0]);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.96;
    ctx.lineWidth = base * 1.8;
    ctx.shadowColor = color;
    ctx.shadowBlur = base * 7;

    this.closedCurvePath(outlinePath(kind, { flip }).map(([x, y]) => [x * W, y * H]));
    ctx.stroke();
    ctx.restore();
  }

  /** 把点列连成平滑的闭合曲线（二次贝塞尔穿过相邻两点的中点） */
  closedCurvePath(points) {
    const { ctx } = this;
    const n = points.length;
    if (n < 3) return;
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const start = mid(points[n - 1], points[0]);
    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    for (let i = 0; i < n; i++) {
      const cur = points[i];
      const next = points[(i + 1) % n];
      const m = mid(cur, next);
      ctx.quadraticCurveTo(cur[0], cur[1], m[0], m[1]);
    }
    ctx.closePath();
  }

  /**
   * @param {object} o
   *   landmarks 归一化关键点（原始帧坐标）
   *   frame     computeFrame 的结果
   *   exerciseId 当前动作
   *   status    'ok' | 'good' | 'warn' | 'bad' | 'idle'
   *   outline   { kind, status, flip } 传入时先画校准轮廓
   */
  draw({
    landmarks, frame, exerciseId, status = 'idle', outline = null,
  }) {
    const { ctx, canvas } = this;
    this.clear();
    if (outline) this.drawOutline(outline.kind || outline.view, outline.status, !!outline.flip);
    if (!landmarks || !landmarks.length) return;

    const W = canvas.width;
    const H = canvas.height;
    const X = (p) => p.x * W;
    const Y = (p) => p.y * H;
    const base = Math.max(2, W / 420);
    const color = COLORS[status] || COLORS.idle;

    // 骨架层（含地面参考线）：关掉“火柴人”后整层不画，只留摄像头画面
    if (this.showSkeleton) {
      // 地面参考线
      if (frame && frame.ok && Number.isFinite(frame.groundY)) {
        ctx.save();
        ctx.strokeStyle = 'rgba(120,150,180,0.35)';
        ctx.setLineDash([base * 3, base * 3]);
        ctx.lineWidth = base * 0.8;
        ctx.beginPath();
        ctx.moveTo(0, frame.groundY * H);
        ctx.lineTo(W, frame.groundY * H);
        ctx.stroke();
        ctx.restore();
      }

      // 骨骼
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = base * 2.6;
      ctx.shadowColor = color;
      ctx.shadowBlur = base * 6;
      for (const [a, b] of SKELETON_EDGES) {
        const p = landmarks[a];
        const q = landmarks[b];
        if (!p || !q) continue;
        if ((p.visibility ?? 1) < 0.25 || (q.visibility ?? 1) < 0.25) continue;
        ctx.beginPath();
        ctx.moveTo(X(p), Y(p));
        ctx.lineTo(X(q), Y(q));
        ctx.stroke();
      }
      ctx.restore();

      // 关节
      ctx.save();
      for (let i = 0; i < landmarks.length; i++) {
        const p = landmarks[i];
        if ((p.visibility ?? 1) < 0.25) continue;
        const isCore = CORE_JOINTS.has(i);
        ctx.fillStyle = isCore ? color : 'rgba(220,240,255,0.75)';
        ctx.beginPath();
        ctx.arc(X(p), Y(p), base * (isCore ? 2.4 : 1.5), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    if (this.showAngles && frame && frame.ok) {
      this.drawAngles(landmarks, frame, exerciseId, W, H, base);
    }
  }

  drawAngles(landmarks, frame, exerciseId, W, H, base) {
    const { ctx } = this;
    const focus = FOCUS[exerciseId] || [];
    const side = frame.side === 'R' ? 'R' : 'L';
    const P = (i) => landmarks[i];
    const items = [];

    const S = { L: LM.L_SHOULDER, R: LM.R_SHOULDER };
    const E = { L: LM.L_ELBOW, R: LM.R_ELBOW };
    const Wr = { L: LM.L_WRIST, R: LM.R_WRIST };
    const Hp = { L: LM.L_HIP, R: LM.R_HIP };
    const K = { L: LM.L_KNEE, R: LM.R_KNEE };
    const A = { L: LM.L_ANKLE, R: LM.R_ANKLE };

    if (focus.includes('knee') && Number.isFinite(frame.kneeAngle)) {
      items.push({ at: P(K[side]), text: `${t('debug.knee')} ${Math.round(frame.kneeAngle)}°` });
    }
    if (focus.includes('elbow') && Number.isFinite(frame.elbowAngle)) {
      items.push({ at: P(E[side]), text: `${t('debug.elbow')} ${Math.round(frame.elbowAngle)}°` });
    }
    if (focus.includes('hip') && Number.isFinite(frame.hipAngle)) {
      items.push({ at: P(Hp[side]), text: `${t('debug.hip')} ${Math.round(frame.hipAngle)}°` });
    }
    if (focus.includes('shoulder') && Number.isFinite(frame.bodyStraight)) {
      items.push({ at: P(S[side]), text: `${t('debug.bodyStraight')} ${Math.round(frame.bodyStraight)}°` });
    }

    ctx.save();
    ctx.font = `600 ${Math.round(base * 11)}px system-ui, "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const it of items) {
      const x = it.at.x * W;
      const y = it.at.y * H - base * 14;
      const w = ctx.measureText(it.text).width + base * 10;
      ctx.fillStyle = 'rgba(8,16,28,0.72)';
      roundRect(ctx, x - w / 2, y - base * 8, w, base * 16, base * 5);
      ctx.fill();
      ctx.fillStyle = '#dff7ff';
      ctx.fillText(it.text, x, y);
    }
    ctx.restore();
  }
}

const CORE_JOINTS = new Set([
  LM.L_SHOULDER, LM.R_SHOULDER, LM.L_ELBOW, LM.R_ELBOW, LM.L_WRIST, LM.R_WRIST,
  LM.L_HIP, LM.R_HIP, LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE,
]);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
