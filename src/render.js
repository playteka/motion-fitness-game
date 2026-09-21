/**
 * 骨架绘制：把关键点画成“会变色的火柴人”，并标出当前动作关注的角度。
 */

import { LM, SKELETON_EDGES } from './geometry.js';
import { t } from './i18n.js';
import { outlinePath } from './calibration.js';
import { EXERCISE_MAP } from './catalog.js';

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

/**
 * 每个动作重点关注的关节（用于角度标注）：判据是哪个关节角，就在画面上标哪个角，
 * 让用户一边做一边能看到「离判决线还有多远」。
 * 判据不是关节角的动作（跳跃离地、开合距离、整套顺序、计时保持…）不标，免得画面全是数字。
 */
export const FOCUS = {
  squat: ['knee', 'hip'],
  squatSumo: ['knee', 'hip'],
  squatJump: ['knee', 'hip'],
  lunge: ['knee', 'hip'],
  lungeBack: ['knee', 'hip'],
  pushup: ['elbow', 'hip'],
  pushupWide: ['elbow'],
  pushupDiamond: ['elbow'],
  bridge: ['hip', 'knee'],
  plank: ['hip', 'shoulder'],
  sidePlank: ['hip', 'shoulder'],
  deadBug: ['knee', 'hip'],
  crunch: ['hip', 'shoulder'],
  reverseCrunch: ['hip', 'knee'],
  // 仰卧抬腿：判据就是「腰腿夹角」（+ 膝角用来看腿有没有绷直）
  lyingLegRaise: ['hip', 'knee'],
  mountainClimber: ['knee', 'hip'],
  // 勾腿跳：判据是「勾起来那条腿的膝角」（脚跟往臀部勾，膝角变小）
  buttKick: ['knee'],
  boxJump: ['knee', 'hip'],
};

/**
 * 「躯干倾角」要不要标在画面上。
 *
 * 用户要求：「要在画面上显示躯干倾角的度数，类似『髋』『膝』的度数显示方法」。
 * 规则就跟着「髋 / 膝」走 —— **凡是在画面上标了关节角的动作（FOCUS 里有条目的），都再加一个躯干倾角**：
 * 这 18 个动作的判据里本来就都有躯干倾角（站立 ≤52°、俯撑 ≥32°、仰卧 ≥36°、前折 ≥55°…），
 * 标出来正好能对着判决线看；而开合跳、波比跳、体前屈这些「判据不是角度」的动作仍旧一个数字都不标，
 * 画面不会变成一串数字。
 */
export function showsTrunkAngle(exerciseId) {
  return (FOCUS[exerciseId] || []).length > 0;
}

/**
 * 「开合跳」这类**判据不是关节角、而是双腿开合幅度**的动作：画面上显示实时开合幅度。
 *
 * 用户问「开合跳怎么没有角度」—— 因为它的判据本来就不是关节角（是两腿张开多宽，
 * 单位是躯干长；见 metrics.js 的 legSpread）。别的动作画面上有「膝 132°」这种角度标签，
 * 它一个数字都没有，看起来像坏了 —— 所以这里给它一个同款胶囊：「开合 0.83」，
 * 显示的正是识别器真正在判的那个量（计数线 0.73、收回线 0.54，见 🎯 运动设定弹窗）。
 */
export function showsSpreadReadout(exerciseId) {
  const metric = EXERCISE_MAP[exerciseId]?.params?.metric;
  return metric === 'legSpread' || metric === 'kneeSpread';
}

/**
 * 两条腿是不是都在画面里（用来决定「膝」标一个还是左右各标一个）。
 *
 * 判据用的是识别器自己算的那一条：`frame.legsVisible`（两侧「髋-膝-踝」可见度都 > 0.16，
 * 和 🐞 面板里显示的「双腿可见」完全同一个条件），再确认两个膝关键点都落在画面内 ——
 * 只要有一侧不满足，就退回标一个「膝」（侧拍时远侧腿常被躯干挡住，贸然标「左膝 / 右膝」会误导）。
 */
export function bothKneesVisible(frame, leftKnee, rightKnee) {
  const inFrame = (p) => !!p && p.x > 0.02 && p.x < 0.98 && p.y > 0.02 && p.y < 0.98;
  return frame.legsVisible === true
    && inFrame(leftKnee) && inFrame(rightKnee)
    && Number.isFinite(frame.perSide?.L?.knee) && Number.isFinite(frame.perSide?.R?.knee);
}

export class PoseRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.showAngles = true;
    this.showSkeleton = true;
    /**
     * 画面是否左右镜像。镜像时视频和画布都被 CSS `scaleX(-1)` 翻过来，
     * 于是画布上画出来的文字也会跟着反着写 —— 角度标签必须再翻一次才读得通。
     */
    this.mirror = false;
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
    /** 两个关键点的中点（躯干倾角标在躯干中段，不会和「身体直线」的肩点标签叠在一起） */
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

    const S = { L: LM.L_SHOULDER, R: LM.R_SHOULDER };
    const E = { L: LM.L_ELBOW, R: LM.R_ELBOW };
    const Wr = { L: LM.L_WRIST, R: LM.R_WRIST };
    const Hp = { L: LM.L_HIP, R: LM.R_HIP };
    const K = { L: LM.L_KNEE, R: LM.R_KNEE };
    const A = { L: LM.L_ANKLE, R: LM.R_ANKLE };

    // 膝：**两条腿都在画面里时，左右膝各标一个**（用户要求「分别显示左膝和右膝的度数」）；
    // 只有一条腿看得清（侧拍时远侧腿常被躯干挡住）时仍旧只标一个「膝」，不做左右之分。
    if (focus.includes('knee')) {
      if (bothKneesVisible(frame, P(K.L), P(K.R))) {
        for (const s of ['L', 'R']) {
          items.push({
            at: P(K[s]),
            text: `${t(s === 'L' ? 'debug.kneeL' : 'debug.kneeR')} ${Math.round(frame.perSide[s].knee)}°`,
          });
        }
      } else if (Number.isFinite(frame.kneeAngle)) {
        items.push({ at: P(K[side]), text: `${t('debug.knee')} ${Math.round(frame.kneeAngle)}°` });
      }
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
    // 躯干倾角：和「髋」「膝」一模一样的画法（深色胶囊 + 度数），只是要不要标由下面的规则决定。
    // 锚点取躯干中段（肩中点 ↔ 髋中点的中点），并**垂直于躯干方向往外让开一段**：
    // 站立时让到躯干侧面、躺姿时让到身体上方 —— 这样不管哪种姿势都不会和标在关节上的
    // 「髋 / 膝 / 身体直线」胶囊压在一起（那三个都贴着关键点画）。
    if (showsTrunkAngle(exerciseId) && Number.isFinite(frame.torsoIncl)) {
      const ls = P(LM.L_SHOULDER);
      const rs = P(LM.R_SHOULDER);
      const lh = P(LM.L_HIP);
      const rh = P(LM.R_HIP);
      if (ls && rs && lh && rh) {
        const sm = mid(ls, rs);
        const hm = mid(lh, rh);
        const ax = sm.x - hm.x;
        const ay = sm.y - hm.y;
        const len = Math.hypot(ax, ay) || 1;
        let nx = -ay / len;
        let ny = ax / len;
        if (ny > 0) { nx = -nx; ny = -ny; }   // 统一偏向上方：躺姿时标在身体上侧，不会贴到进度条那边
        const gapPx = base * 24;
        items.push({
          at: { x: (sm.x + hm.x) / 2 + (nx * gapPx) / W, y: (sm.y + hm.y) / 2 + (ny * gapPx) / H },
          text: `${t('debug.trunk')} ${Math.round(frame.torsoIncl)}°`,
        });
      }
    }

    // 开合跳：判据是「双腿开合幅度」而不是关节角，所以标的是这个幅度（同款胶囊、同样跟着镜像翻转）。
    // 锚点取双腿中段（两膝中点 ↔ 两踝中点的中点），腿张开 / 并拢时数字就在腿中间动。
    if (showsSpreadReadout(exerciseId)) {
      const spread = Number.isFinite(frame.legSpread) ? frame.legSpread : frame.kneeSpread;
      const lk = P(LM.L_KNEE);
      const rk = P(LM.R_KNEE);
      const la = P(LM.L_ANKLE);
      const ra = P(LM.R_ANKLE);
      if (Number.isFinite(spread) && lk && rk && la && ra) {
        items.push({ at: mid(mid(lk, rk), mid(la, ra)), text: `${t('debug.legSpread')} ${spread.toFixed(2)}` });
      }
    }

    ctx.save();
    ctx.font = `600 ${Math.round(base * 11)}px system-ui, "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const pillH = base * 16;
    const boxes = items.map((it) => ({
      text: it.text,
      x: it.at.x * W,
      y: it.at.y * H - base * 14,
      w: ctx.measureText(it.text).width + base * 10,
      h: pillH,
    }));
    // 防重叠：两个胶囊（例如侧拍站姿时左右膝几乎重在一起）撞上了，就把后面那个往上抬一行，
    // 保证两个数字都看得见，而不是叠成一团。
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        let guard = 0;
        while (guard < 4
          && Math.abs(boxes[i].x - boxes[j].x) < (boxes[i].w + boxes[j].w) / 2
          && Math.abs(boxes[i].y - boxes[j].y) < (boxes[i].h + boxes[j].h) / 2) {
          boxes[i].y -= boxes[i].h + base * 2;
          guard += 1;
        }
      }
    }
    for (const b of boxes) {
      ctx.save();
      // 平移到标签中心；镜像画面下再水平翻一次，抵消 CSS 的 scaleX(-1)，
      // 否则「膝 132°」会显示成左右颠倒的乱码。
      ctx.translate(b.x, b.y);
      if (this.mirror) ctx.scale(-1, 1);
      ctx.fillStyle = 'rgba(8,16,28,0.72)';
      roundRect(ctx, -b.w / 2, -b.h / 2, b.w, b.h, base * 5);
      ctx.fill();
      ctx.fillStyle = '#dff7ff';
      ctx.fillText(b.text, 0, 0);
      ctx.restore();
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
