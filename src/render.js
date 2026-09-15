/**
 * 骨架绘制：把关键点画成“会变色的火柴人”，并标出当前动作关注的角度。
 */

import { LM, SKELETON_EDGES } from './geometry.js';
import { t } from './i18n.js';
import { outlineJoints, outlinePoint, OUTLINE_SEGMENTS } from './calibration.js';

const COLORS = {
  ok: '#34e5c4',
  good: '#4ade80',
  warn: '#fbbf24',
  bad: '#f87171',
  idle: '#7c8aa5',
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
   * 运动前校准用的虚线人体轮廓。
   * @param {'front'|'side'} view 动作要求的机位
   * @param {'search'|'adjust'|'ready'} status 未找到人 / 正在调整 / 已就位
   */
  drawOutline(view, status = 'search') {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    const joints = outlineJoints(view);
    const color = status === 'ready' ? COLORS.good : (status === 'adjust' ? COLORS.warn : COLORS.idle);
    const base = Math.max(2, W / 420);

    ctx.save();
    ctx.setLineDash([base * 3.2, base * 2.8]);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.globalAlpha = status === 'ready' ? 0.9 : 0.55;
    ctx.lineWidth = base * 1.1;
    ctx.shadowColor = color;
    ctx.shadowBlur = base * 4;

    // 每段画成「空心胶囊」轮廓，而不是粗线，这样看起来才是人体外形
    for (const [a, b, w] of OUTLINE_SEGMENTS) {
      const p = outlinePoint(joints, a);
      const q = outlinePoint(joints, b);
      this.capsulePath(p[0] * W, p[1] * H, q[0] * W, q[1] * H, w * H);
      ctx.stroke();
    }
    // 头部
    ctx.beginPath();
    ctx.arc(joints.nose[0] * W, joints.nose[1] * H, 0.05 * H, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** 空心胶囊路径 */
  capsulePath(x1, y1, x2, y2, width) {
    const { ctx } = this;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const r = width / 2;
    if (len < 1e-3 || r < 0.5) {
      ctx.beginPath();
      ctx.arc(x1, y1, Math.max(r, 1), 0, Math.PI * 2);
      return;
    }
    const ang = Math.atan2(dy, dx);
    const nx = (-dy / len) * r;
    const ny = (dx / len) * r;
    ctx.beginPath();
    ctx.moveTo(x1 + nx, y1 + ny);
    ctx.lineTo(x2 + nx, y2 + ny);
    ctx.arc(x2, y2, r, ang - Math.PI / 2, ang + Math.PI / 2);
    ctx.lineTo(x1 - nx, y1 - ny);
    ctx.arc(x1, y1, r, ang + Math.PI / 2, ang - Math.PI / 2);
    ctx.closePath();
  }

  /**
   * @param {object} o
   *   landmarks 归一化关键点（原始帧坐标）
   *   frame     computeFrame 的结果
   *   exerciseId 当前动作
   *   status    'ok' | 'good' | 'warn' | 'bad' | 'idle'
   *   outline   { view, status } 传入时先画校准轮廓
   */
  draw({
    landmarks, frame, exerciseId, status = 'idle', outline = null,
  }) {
    const { ctx, canvas } = this;
    this.clear();
    if (outline) this.drawOutline(outline.view, outline.status);
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
