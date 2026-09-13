/**
 * 动作要领 → 计分步骤。
 *
 * 设计目标：**照着要领一步一步做，就能一步一步拿分**。
 * 每个步骤是一个「可判定的条件」，满足即立刻加分，并触发音效 / 语音 / 界面打勾，
 * 这样用户能马上知道自己刚才哪一下做对了。
 *
 * check(frame, det) 返回 true 表示这一步达标。
 *   - frame：本帧动作指标（见 metrics.js）
 *   - det：当前识别器实例，用于读取内部状态（例如“这一轮是否已经下蹲过”）
 *
 * perCycle: true   → 每完成一次动作，步骤清单重置（可以反复得分）
 * perCycle: false  → 整组只算一次（主要用于计时类动作的里程碑）
 */

import { LM } from './geometry.js';

/* ---------------- 小工具 ---------------- */

const SIDE = {
  L: { knee: LM.L_KNEE, ankle: LM.L_ANKLE, hip: LM.L_HIP },
  R: { knee: LM.R_KNEE, ankle: LM.R_ANKLE, hip: LM.R_HIP },
};

/** 某一侧小腿「离地比例」：1 ≈ 站立，0 ≈ 跪地 */
function legDrop(f, side) {
  const I = SIDE[side];
  const k = f.points[I.knee];
  const a = f.points[I.ankle];
  const shin = Math.hypot(k.x - a.x, k.y - a.y) || 1e-6;
  return (a.y - k.y) / shin;
}

/** 后腿 = 膝盖更低的那条（箭步蹲用） */
function backSide(f) {
  return f.points[SIDE.L.knee].y >= f.points[SIDE.R.knee].y ? 'L' : 'R';
}

/** 两脚踝的前后距离（相对躯干长） */
export function ankleSpread(f) {
  const dx = Math.abs(f.points[LM.L_ANKLE].x - f.points[LM.R_ANKLE].x);
  return dx / Math.max(1e-3, f.torsoLen);
}

/** 身体是否成一条直线（平板支撑 / 俯卧撑用） */
const straight = (f, min = 165) => Number.isFinite(f.bodyStraight) && f.bodyStraight >= min;
const aligned = (f, max = 0.13) => Math.abs(f.hipLineDev) <= max;

/** 仰卧屈膝姿势（臀桥类用） */
const supine = (f) => f.torsoIncl > 40
  && f.kneeAngle > 30 && f.kneeAngle < 142
  && f.shoulderClear < 0.40 && f.kneeClear > 0.32;

/** 俯撑姿势（俯卧撑用） */
const prone = (f) => f.torsoIncl > 35 && f.shoulderClear > 0.15 && f.wristClear < 0.55;

/* ---------------- 通用“为什么还没得分”提示 ---------------- */

/** 站姿类要领没达成时，逐条说明卡在哪一项 */
function stanceWhy(f, legWord = '双腿') {
  if (f.view !== 'side') return '检测到你在正面/斜对镜头：请侧对摄像头（身体与镜头垂直），侧面拍摄才能测准角度';
  if (!f.bodyVisible) return '没看清你的全身：请退后一点，让头顶到脚都出现在画面里';
  if (f.trunkLean >= 32) return '身体有点歪或前倾：站直一点，让肩膀在髋部正上方';
  if (f.kneeExtended <= 150) return `把${legWord}完全伸直站好`;
  return '再站正一点就能拿到这一步的分';
}

export { legDrop, backSide, stanceWhy };

export const STEP_PLANS = {
  /* ---------------- 深蹲 ---------------- */
  squat: {
    perCycle: true,
    repBonus: 6,
    steps: [
      {
        id: 'stance',
        label: '侧对摄像头站好，全身入镜、身体直立',
        points: 4,
        // 用“更直的那条腿”判断站直，避免远侧腿被遮挡时估歪导致拿不到分
        check: (f) => f.view === 'side' && f.bodyVisible && f.trunkLean < 32 && f.kneeExtended > 150,
        hint: (f) => stanceWhy(f),
      },
      {
        id: 'hinge',
        label: '髋部向后向下坐（屈髋启动）',
        points: 6,
        check: (f) => f.kneeAngle <= 152 && f.hipAngle < 165,
        hint: (f) => (f.kneeAngle > 152 ? '开始下蹲：髋部向后向下坐，别只是弯腰' : ''),
      },
      {
        id: 'descend',
        label: '双膝顺着脚尖方向屈曲下沉',
        points: 7,
        check: (f) => f.kneeAngle <= 135,
        hint: (f) => (f.kneeAngle > 135 ? '继续往下蹲，让膝盖弯得更多一些' : ''),
      },
      {
        id: 'parallel',
        label: '蹲到大腿接近水平（这步分最高）',
        points: 14,
        check: (f) => f.thighFromHoriz <= 25 || f.hipBelowKnee,
        hint: (f) => `再蹲低一点：现在大腿离水平还差约 ${Math.max(0, Math.round(f.thighFromHoriz - 25))}°`,
      },
      {
        id: 'stand',
        label: '蹬地站直，髋膝完全伸展',
        points: 8,
        // 髋角在“快站直”那一瞬间还在恢复中，所以用较宽的髋角下限，避免漏判这一步
        check: (f, d) => d.cycleDescended && f.kneeAngle >= 150 && f.hipAngle >= 130,
        hint: (f) => (f.kneeAngle < 150 ? '脚掌蹬地站起来，把髋和膝都伸直' : ''),
      },
    ],
  },

  /* ---------------- 箭步蹲 ---------------- */
  lunge: {
    perCycle: true,
    repBonus: 6,
    steps: [
      {
        id: 'stance',
        label: '侧对摄像头站好，身体直立、全身入镜',
        points: 4,
        check: (f) => f.view === 'side' && f.bodyVisible && f.trunkLean < 32 && f.kneeExtended > 145,
        hint: (f) => stanceWhy(f, '两条腿'),
      },
      {
        id: 'split',
        label: '一条腿向前迈出，前后脚分开',
        points: 5,
        check: (f) => f.legsVisible && ankleSpread(f) > 0.45 && ankleSpread(f) <= 0.9,
        hint: (f) => (ankleSpread(f) <= 0.45
          ? `向前迈一步：现在两脚前后只差约 ${Math.round(ankleSpread(f) * 100)}%（需要 45% 以上）`
          : ''),
      },
      {
        id: 'stride',
        label: '迈成一大步（前后距离拉开）',
        points: 6,
        check: (f) => f.legsVisible && ankleSpread(f) > 0.9,
        hint: (f) => (ankleSpread(f) <= 0.9 ? '步子再大一点，前后脚距离拉开' : ''),
      },
      {
        id: 'sink',
        label: '双膝同时弯曲下沉，前膝约 90°',
        points: 11,
        check: (f) => f.kneeBent <= 118 && f.kneeFar <= 150,
        hint: (f) => (f.kneeBent > 118 ? '双膝一起弯曲往下沉，前膝弯到接近 90°' : ''),
      },
      {
        id: 'backknee',
        label: '后膝下降到接近地面（这步分最高）',
        points: 14,
        check: (f) => legDrop(f, backSide(f)) <= 0.35,
        hint: (f) => {
          const drop = legDrop(f, backSide(f));
          return drop > 0.35 ? '后腿再往下沉，让后膝接近地面' : '';
        },
      },
      {
        id: 'return',
        label: '前脚蹬地回到站姿',
        points: 8,
        check: (f, d) => d.cycleSunk && f.kneeBent >= 145 && f.kneeFar >= 140,
        hint: (f) => (f.kneeBent < 145 ? '前脚蹬地站起来，回到站直姿势' : ''),
      },
    ],
  },

  /* ---------------- 俯卧撑 ---------------- */
  pushup: {
    perCycle: true,
    repBonus: 6,
    steps: [
      {
        id: 'setup',
        label: '双手撑地，身体成一条直线',
        points: 5,
        check: (f) => prone(f) && straight(f) && aligned(f),
        hint: (f) => {
          if (f.torsoIncl <= 35) return '先趴下撑好：双手在肩下、身体放平';
          if (f.wristClear >= 0.55) return '手掌要撑在地面上';
          if (!straight(f, 165)) return '身体要成一条直线：收腹夹臀，别塌腰也别撅臀';
          return '把身体收成一条线就能拿分';
        },
      },
      {
        id: 'lower',
        label: '收紧核心，肘部弯曲下沉',
        points: 7,
        check: (f) => f.elbowAngle <= 140 && straight(f, 146),
        hint: (f) => (f.elbowAngle > 140 ? '开始下放：肘部弯曲，胸口向地面靠近' : ''),
      },
      {
        id: 'depth',
        label: '肘角弯到 90° 以内，胸口接近地面（这步分最高）',
        points: 14,
        check: (f) => f.elbowAngle <= 95 && straight(f, 146),
        hint: (f) => (f.elbowAngle > 95 ? `再往下一点：现在肘角约 ${Math.round(f.elbowAngle)}°` : ''),
      },
      {
        id: 'press',
        label: '推起还原，手臂完全伸直',
        points: 8,
        check: (f, d) => d.cycleLowered && f.elbowAngle >= 145,
        hint: (f) => (f.elbowAngle < 145 ? '用力推起，手臂完全伸直' : ''),
      },
    ],
  },

  /* ---------------- 臀桥（计数） ---------------- */
  bridge: {
    perCycle: true,
    repBonus: 6,
    steps: [
      {
        id: 'setup',
        label: '仰卧屈膝，双脚与髋同宽踩实',
        points: 5,
        check: (f) => supine(f) && f.hipRise < 0.2,
        hint: (f) => {
          if (f.torsoIncl <= 40) return '先躺下：仰卧在垫子上，屈膝、双脚踩实';
          if (f.kneeAngle >= 142 || f.kneeAngle <= 30) return '把膝盖弯起来（约 90°），双脚踩实地面';
          if (f.kneeClear <= 0.32) return '膝盖抬起来，脚掌踩在地面上';
          return '躺好屈膝就能拿到这一步的分';
        },
      },
      {
        id: 'lift',
        label: '收紧臀部，把髋部向上顶起',
        points: 6,
        check: (f) => f.hipRise > 0.15,
        hint: (f) => (f.hipRise <= 0.15 ? '收紧臀部，把髋部向上顶起' : ''),
      },
      {
        id: 'top',
        label: '顶到肩-髋-膝接近一条直线（这步分最高）',
        points: 14,
        check: (f) => f.hipRise > 0.35,
        hint: (f) => (f.hipRise <= 0.35 ? '继续往上顶，顶到肩、髋、膝接近一条直线' : ''),
      },
      {
        id: 'lower',
        label: '臀部有控制地落回地面',
        points: 8,
        check: (f, d) => d.wasAtTop && f.hipRise < 0.15,
        hint: () => '有控制地把臀部放回地面（别直接掉下来）',
      },
    ],
  },

  /* ---------------- 平板支撑（计时） ---------------- */
  plank: {
    perCycle: false,
    repBonus: 0,
    pointsPerSecond: 1,
    steps: [
      {
        id: 'setup',
        label: '小臂在肩下撑地，把身体撑起来',
        points: 8,
        check: (f) => f.shoulderClear > 0.22 && f.wristClear < 0.32
          && (f.elbowAngle < 122 || f.elbowAngle > 148),
        hint: (f) => {
          if (f.torsoIncl <= 45) return '先趴下撑地：小臂在肩关节正下方，身体放平';
          if (f.shoulderClear <= 0.22) return '把身体撑起来，别趴在地上';
          if (f.wristClear >= 0.32) return '手掌/小臂要贴住地面';
          return '小臂压实地面（肘角约 90°），或手臂完全伸直撑起';
        },
      },
      {
        id: 'align',
        label: '头、背、髋、脚踝成一条直线',
        points: 12,
        check: (f) => straight(f, 158) && aligned(f, 0.14),
        hint: (f) => {
          if (f.hipLineDev > 0.14) return '腰塌下去了：夹紧臀部、收紧肚子';
          if (f.hipLineDev < -0.14) return '臀部抬太高了：放低一点，身体成一条线';
          return '收紧核心，让肩、髋、踝成一条直线';
        },
      },
      {
        id: 'hold3',
        label: '稳定保持 3 秒',
        points: 10,
        check: (f, d) => d.holdMs >= 3000,
      },
      {
        id: 'hold10',
        label: '稳定保持 10 秒',
        points: 15,
        check: (f, d) => d.holdMs >= 10000,
      },
      {
        id: 'hold30',
        label: '稳定保持 30 秒',
        points: 25,
        check: (f, d) => d.holdMs >= 30000,
      },
    ],
  },

  /* ---------------- 静态臀桥（计时） ---------------- */
  bridgehold: {
    perCycle: false,
    repBonus: 0,
    pointsPerSecond: 1,
    steps: [
      {
        id: 'setup',
        label: '仰卧屈膝，双脚踩实与髋同宽',
        points: 6,
        check: (f) => supine(f),
        hint: (f) => {
          if (f.torsoIncl <= 40) return '先躺下：仰卧在垫子上，屈膝、双脚踩实';
          return '把膝盖弯到约 90°，脚掌踩实地面';
        },
      },
      {
        id: 'lift',
        label: '顶起髋部到最高点',
        points: 12,
        check: (f) => f.hipRise > 0.32,
        hint: (f) => (f.hipRise <= 0.32 ? '把髋部顶到最高点并停住' : ''),
      },
      {
        id: 'hold3',
        label: '臀部收紧保持 3 秒',
        points: 10,
        check: (f, d) => d.holdMs >= 3000,
      },
      {
        id: 'hold10',
        label: '保持 10 秒',
        points: 15,
        check: (f, d) => d.holdMs >= 10000,
      },
      {
        id: 'hold20',
        label: '保持 20 秒',
        points: 20,
        check: (f, d) => d.holdMs >= 20000,
      },
    ],
  },
};

export function getStepPlan(exerciseId) {
  const plan = STEP_PLANS[exerciseId];
  if (!plan) return { steps: [], repBonus: 0, perCycle: true, pointsPerSecond: 0 };
  return plan;
}
