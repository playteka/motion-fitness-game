/**
 * 通用识别引擎（配置驱动）。
 *
 * 60+ 动作不可能每个都手写一个状态机，所以把「一次动作」抽象成：
 *   ① 姿势门控（gate）：人是不是处在做这个动作应有的身体配置里（站/俯卧/仰卧/四足/坐/跪/倒立/悬垂）
 *   ② 一个随时间来回变化的量（metric）：膝角 / 肘角 / 髋角 / 踝角 / 髋抬起 / 离地高度 / 左右交替 / 左右转体
 *   ③ 进度：progress = (up − v) / (up − down)，0 = 起始位置，1 = 到位
 * 计数规则与最初 6 个动作完全一致（用户反馈「大体做到就计次数，动作不标准用语音纠正」）：
 *   - progress 峰值 ≥ bottomP：到位（拿满深度分）
 *   - 峰值 ≥ looseP 就算一次（**只有这一种宽松模式**，严格模式已按用户要求取消）
 *   - 峰值 < ignoreP：只是晃了一下 —— 不计数、也不出声
 *   - 用时过短 → 半程 + 「太快了」；幅度不够 → 半程 + 「再做大一点」
 *   - 跳跃类额外要求真的离地（脚离开地面线）
 */

import { clamp } from './geometry.js';
import { DetectorBase, HoldDetector } from './detector-base.js';

/* ------------------------------------------------------------------ *
 * 姿势门控
 * ------------------------------------------------------------------ */

/**
 * 门控阈值表：`[最小值, 最大值]`，null 表示这一侧不限制。
 *
 * 为什么单独抽成表：🎯「运动设定」弹窗要把**真正用于判定的数值**显示给用户
 *（比如「肩离地 ≥ 0.10×躯干长」）。如果界面自己抄一份数字，改了识别逻辑就会出现
 * 「界面说的和实际判的不一样」。这里一处定义，下面的 GATES 用它判定，
 * specs.js 用它生成界面文案，两边永远一致。
 *
 * 只收录动作库里真的用到的门控（其余门控仍是就地写死的判定）。
 */
export const GATE_LIMITS = {
  /** 站立（膝盖离地、髋在膝上方） */
  stand: {
    torsoIncl: [null, 52],
    kneeClear: [0.28, null],
    hipClear: [0.55, null],
  },
  /** 站立 + 双腿分开（相扑深蹲） */
  standWide: {
    torsoIncl: [null, 52],
    kneeClear: [0.28, null],
    hipClear: [0.55, null],
    ankleSpread: [0.35, null],
  },
  /**
   * 站立（**不依赖地面线**的版本）：躯干接近竖直 + 肩明显高于髋。
   *
   * 勾腿跳用它。为什么不用普通 `stand` 门控：那个门控还要「膝离地 ≥0.28、髋离地 ≥0.55 倍躯干长」，
   * 这两个量都以**校准地面线**为基准 —— 地面线一旦偏了（脚出画、校准时人没站到位），
   * 站得笔直也会被判成「没站好」。用户反馈「我明明站好了、躯干倾角只有几度，它却总说我没站好」，
   * 查下来就是卡在这两条地面相关的条件上。
   *
   * 两个条件都不依赖地面线、也不依赖机位距离：
   *   torsoIncl        躯干相对竖直的倾角（站直 ≈ 0°）
   *   shoulderAboveHip **正数 = 肩在髋上方**（站立 ≈ +1.0，仰卧 ≈ 0，臀桥/倒立为负）
   *
   * ⚠️ 符号坑（务必记着）：这里用的是 `shoulderAboveHip`（正数版），**不是 `hipRise`**。
   * 两者互为相反数（`hipRise = −shoulderAboveHip`，它是「髋抬到肩上方」的量，臀桥在用）。
   * 这里曾经写成 `inLimit(f.hipRise, [0.5, null])` —— 等于要求「髋比肩高半条躯干」（几乎倒立），
   * 于是站得再标准也永远过不了门控，画面上一直提示「还没进入这个动作的姿势」。
   */
  standUpright: {
    torsoIncl: [null, 52],
    shoulderAboveHip: [0.5, null],
  },
  /** 俯撑（俯卧撑 / 平板 / 登山者）：躯干接近水平 + 肩离地 + 手在地面 */
  prone: {
    torsoIncl: [32, null],
    shoulderClear: [0.10, null],
    wristClearMin: [null, 0.95],
  },
  /** 仰卧屈膝（臀桥 / 卷腹）：肩离地高度放宽到 0.95，卷腹卷高了也算 */
  supine: {
    torsoIncl: [36, null],
    shoulderClear: [null, 0.95],
    kneeClear: [0.15, null],
  },
  /** 仰卧（腿可以伸直：死虫式）：横着躺 + 肩不要抬太高 */
  supineLow: {
    torsoIncl: [36, null],
    shoulderClear: [null, 0.6],
  },
  /**
   * 仰卧抬腿专用的**最宽松**仰卧门控：**只看肩离地高度**。
   *
   * 用户明确要求「姿势要求只保留『肩离地高度 ≤ 0.6×躯干长』，删除『躯干倾角 ≥ 36°』，
   * 进一步放宽姿势要求」—— 所以这个门控里没有 torsoIncl 这一条。
   * 剩下的肩离地高度本身就已经把「站着 / 坐直」挡在外面（站立时肩离地高度约 1.0×躯干长以上）。
   */
  supineFlat: {
    shoulderClear: [null, 0.6],
  },
  /** 侧卧（侧平板）：横着躺 + 肩/髋离地 + 手撑地 */
  sideLying: {
    torsoIncl: [55, null],
    shoulderClear: [0.12, null],
    hipClear: [0.08, null],
    wristClearMin: [null, 0.6],
  },
  /** 站立体前屈：站着但躯干往前折 */
  standFold: {
    torsoIncl: [55, null],
    hipClear: [0.65, null],
  },
  /** 坐姿体前屈：坐着 + 躯干往前折 */
  seatedFold: {
    hipClear: [null, 0.9],
    torsoIncl: [40, null],
  },
};

/** 区间判定：null 表示该侧不限制 */
export function inLimit(v, [min, max]) {
  if (!Number.isFinite(v)) return false;
  if (min !== null && v < min) return false;
  if (max !== null && v > max) return false;
  return true;
}

export const GATES = {
  /** 站立（膝盖离地、髋在膝上方） */
  stand: (f) => inLimit(f.torsoIncl, GATE_LIMITS.stand.torsoIncl)
    && inLimit(f.kneeClear, GATE_LIMITS.stand.kneeClear)
    && inLimit(f.hipClear, GATE_LIMITS.stand.hipClear),
  /** 站立 + 双腿分开（相扑深蹲 / 侧向箭步蹲） */
  standWide: (f) => GATES.stand(f)
    && inLimit(f.ankleSpread, GATE_LIMITS.standWide.ankleSpread),
  /** 单腿站立（手枪深蹲 / 单腿硬拉）：另一条腿离地或明显抬起 */
  standOneLeg: (f) => GATES.stand(f)
    && (Math.abs(f.perSide.L.kneeY - f.perSide.R.kneeY) > 0.06 * f.torsoLen
      || Math.abs(f.perSide.L.ankleY - f.perSide.R.ankleY) > 0.10),
  /** 站立 + 手撑在高处（推墙小腿拉伸） */
  standWall: (f) => GATES.stand(f) && f.wristClearMin > 0.35 && f.torsoIncl > 8,
  /** 站立 + 一条腿后勾（站姿股四头肌拉伸） */
  standHeelUp: (f) => GATES.stand(f) && f.kneeBent < 110,
  /** 站立 + 手臂交叉在身前（肩部拉伸） */
  standArmCross: (f) => GATES.stand(f) && f.elbowBent < 125,
  /** 站立体前屈：站着但躯干往前折 */
  standFold: (f) => inLimit(f.torsoIncl, GATE_LIMITS.standFold.torsoIncl)
    && inLimit(f.hipClear, GATE_LIMITS.standFold.hipClear),
  /** 俯撑（俯卧撑 / 平板 / 登山者）：躯干接近水平 + 手在地面 */
  prone: (f) => inLimit(f.torsoIncl, GATE_LIMITS.prone.torsoIncl)
    && inLimit(f.shoulderClear, GATE_LIMITS.prone.shoulderClear)
    && inLimit(f.wristClearMin, GATE_LIMITS.prone.wristClearMin),
  /** 手撑在椅子/台阶上的俯撑（上斜俯卧撑） */
  proneHigh: (f) => f.torsoIncl > 20 && f.shoulderClear > 0.10 && f.wristClearMin < 1.5,
  /** 俯卧在地面（超人式 / 青蛙趴 / 婴儿式） */
  proneFloor: (f) => f.torsoIncl > 42 && f.shoulderClear < 0.55 && f.wristClearMin < 0.6,
  /** 俯卧 + 手脚都抬离地面（超人式） */
  proneLift: (f) => f.torsoIncl > 35 && f.shoulderClear < 0.8 && f.wristClearMin > 0.12
    && f.kneeClear > 0.12,
  /** 仰卧屈膝（臀桥 / 卷腹）
   *  肩离地高度给到 0.95 倍躯干长：卷腹本来就要把肩胛骨卷离地面（能到 0.7~1.0），
   *  卡在 0.6 会把「卷得高」的正常动作挡在门外（反而吃不到次数）。 */
  supine: (f) => inLimit(f.torsoIncl, GATE_LIMITS.supine.torsoIncl)
    && inLimit(f.shoulderClear, GATE_LIMITS.supine.shoulderClear)
    && inLimit(f.kneeClear, GATE_LIMITS.supine.kneeClear),
  /** 仰卧（腿可以伸直：仰卧抬腿 / 死虫式 / 空心支撑 / 龙旗） */
  supineLow: (f) => inLimit(f.torsoIncl, GATE_LIMITS.supineLow.torsoIncl)
    && inLimit(f.shoulderClear, GATE_LIMITS.supineLow.shoulderClear),
  supineFlat: (f) => inLimit(f.shoulderClear, GATE_LIMITS.supineFlat.shoulderClear),
  /** 站立（不依赖地面线）：躯干竖直 + 肩高于髋 —— 见 GATE_LIMITS.standUpright 的说明（注意符号） */
  standUpright: (f) => inLimit(f.torsoIncl, GATE_LIMITS.standUpright.torsoIncl)
    && inLimit(f.shoulderAboveHip, GATE_LIMITS.standUpright.shoulderAboveHip),
  /** 空心支撑：肩和腿都稍微离地 */
  hollow: (f) => f.torsoIncl > 36 && f.shoulderClear > 0.12 && f.shoulderClear < 0.7
    && f.kneeClear > 0.12 && f.kneeClear < 0.9,
  /** V 字支撑：屁股着地、腿抬起、上身向后倾 */
  vSit: (f) => f.hipClear < 0.85 && f.kneeClear > 0.45 && f.torsoIncl > 20,
  /** 四点支撑（鸟狗式 / 猫牛式 / 胸椎旋转 / 熊爬） */
  quadruped: (f) => f.quadruped,
  /** 熊爬：四点支撑但膝离地 */
  bearCrawl: (f) => f.quadruped && f.kneeClear > 0.22,
  /** 螃蟹走：仰面、手在身后撑地、髋抬起 */
  crab: (f) => f.torsoIncl > 40 && f.shoulderClear > 0.22 && f.wristClearMin < 0.85 && f.hipClear > 0.22,
  /** 跪姿（髋在膝上、膝贴地、躯干直立） */
  kneel: (f) => f.kneeClear < 0.28 && f.hipClear > 0.35 && f.torsoIncl < 45,
  /** 跪姿前屈（鸽子式 / 蜥蜴式） */
  kneelFold: (f) => f.kneeClear < 0.32 && f.torsoIncl > 25,
  /** 婴儿式：跪 + 躯干前折 + 手往前伸 */
  childPose: (f) => f.kneeClear < 0.32 && f.torsoIncl > 50 && f.wristClearMin < 0.55,
  /** 手腕背伸拉伸：跪姿 + 手在身前撑地 + 肘伸直 */
  wristStretch: (f) => f.kneeClear < 0.45 && f.wristClearMin < 0.55 && f.elbowExtended > 140,
  /** 坐姿（体前屈 / 蝴蝶式） */
  seated: (f) => f.hipClear < 0.85 && f.kneeClear > 0.08 && f.torsoIncl < 65,
  /** 坐在地上的低姿（俄罗斯转体） */
  seatedLow: (f) => f.hipClear < 0.9 && f.torsoIncl > 15,
  /** 坐姿体前屈：坐着 + 躯干往前折 */
  seatedFold: (f) => inLimit(f.hipClear, GATE_LIMITS.seatedFold.hipClear)
    && inLimit(f.torsoIncl, GATE_LIMITS.seatedFold.torsoIncl),
  /** 蝴蝶式：坐姿 + 双膝打开 */
  butterfly: (f) => f.hipClear < 0.95 && f.kneeSpread > 0.55 && f.torsoIncl < 55,
  /** 青蛙趴：俯卧/跪趴 + 双膝打开 */
  frogPose: (f) => f.torsoIncl > 35 && f.kneeSpread > 0.5 && f.kneeClear < 0.5,
  /** 侧卧（侧平板） */
  sideLying: (f) => inLimit(f.torsoIncl, GATE_LIMITS.sideLying.torsoIncl)
    && inLimit(f.shoulderClear, GATE_LIMITS.sideLying.shoulderClear)
    && inLimit(f.hipClear, GATE_LIMITS.sideLying.hipClear)
    && inLimit(f.wristClearMin, GATE_LIMITS.sideLying.wristClearMin),
  /** 倒立（倒立撑）：髋高于肩、身体竖直 */
  inverted: (f) => f.inverted && f.torsoIncl < 50 && f.shoulderClear > 0.3,
  /** 双杠臂屈伸：身体竖直、手在髋两侧（手离地高度接近髋） */
  dips: (f) => f.torsoIncl < 45 && f.hipClear > 0.35 && f.wristClearMin < 0.9 && f.wristClearMin > 0.05,
  /** 悬垂（悬垂举腿）：身体竖直 + 脚离地（需要校准地面线） */
  hang: (f) => f.torsoIncl < 45 && f.ankleClear > 0.25,
};

/** 每个门控对应「现在该怎么做」的提示键后缀 */
const GATE_HINT = {
  stand: 'stand', standWide: 'stand', standUpright: 'stand', standOneLeg: 'stand', standWall: 'stand',
  standHeelUp: 'stand', standArmCross: 'stand', standFold: 'stand',
  prone: 'prone', proneHigh: 'prone', proneFloor: 'prone', proneLift: 'prone',
  supine: 'supine', supineLow: 'supine', supineFlat: 'supine', hollow: 'supine', crab: 'supine',
  quadruped: 'quadruped', bearCrawl: 'quadruped',
  kneel: 'kneel', kneelFold: 'kneel', childPose: 'kneel', wristStretch: 'kneel',
  seated: 'seated', seatedLow: 'seated', seatedFold: 'seated', butterfly: 'seated',
  vSit: 'seated', frogPose: 'prone',
  sideLying: 'side', inverted: 'inverted', hang: 'hang', dips: 'stand',
};

/* ------------------------------------------------------------------ *
 * 指标取值：一次动作里“来回变化的那个量”
 * ------------------------------------------------------------------ */

/**
 * 仰卧抬腿「腿要绷直」的宽容线：膝盖角度 ≥ 这个值就算绷直。
 * 用户明确要求「腿要绷直，但不要太严格，膝盖角度大于 130° 都可以接受」——
 * 所以只在这个角度以下才出声提醒，而且**只是提醒，不扣次数**（界面上的建议项也读这条常量）。
 */
export const LEG_STRAIGHT_MIN = 130;

/**
 * 「仰卧抬腿那一类」的仰卧门控：supineFlat（放宽后：只看肩离地高度）与 supineLow。
 *
 * 仰卧抬腿专用的几处特例（进度条第一格画躺平姿势、腿要绷直的建议项、语音纠正）
 * 都认这两个名字，换门控名时不会漏改。
 */
export const SUPINE_GATES = ['supineFlat', 'supineLow'];
export const isSupineGate = (name) => SUPINE_GATES.includes(name);

export const METRICS = {
  knee: (f) => f.kneeAngle,
  kneeBent: (f) => f.kneeBent,
  kneeExtended: (f) => f.kneeExtended,
  elbow: (f) => f.elbowAngle,
  elbowBent: (f) => f.elbowBent,
  elbowExtended: (f) => f.elbowExtended,
  hip: (f) => f.hipAngle,
  ankle: (f) => f.ankleAngle,
  body: (f) => f.bodyStraight,
  shoulderClear: (f) => f.shoulderClear,
  kneeClear: (f) => f.kneeClear,
  hipRise: (f) => f.hipRise,
  hipClear: (f) => f.hipClear,
  wristClear: (f) => f.wristClearMin,
  armRaised: (f) => f.armRaised,
  kneeSpread: (f) => f.kneeSpread,
  legSpread: (f) => f.legSpread,
  trunk: (f) => f.torsoIncl,
};

/** 单侧指标（左右交替类动作用，需要分别看左右） */
export const SIDE_METRICS = {
  knee: (f, s) => f.perSide?.[s]?.knee,
  hip: (f, s) => f.perSide?.[s]?.hip,
  elbow: (f, s) => f.perSide?.[s]?.elbow,
  armRaised: (f, s) => f.perSide?.[s]?.armRaised,
  wristClear: (f, s) => f.perSide?.[s]?.wristClear,
  kneeClear: (f, s) => f.perSide?.[s]?.kneeClear,
  ankleY: (f, s) => f.perSide?.[s]?.ankleY,
};

/**
 * 渐进式姿势提醒（不拦截计数，只出声纠正）。
 *
 * 只给「站姿」和「俯撑」两类做提醒：
 *   - 站姿：膝盖内扣、上身歪斜 —— 这两条在正面机位测得准，也是深蹲/箭步蹲最常犯的错；
 *   - 俯撑：塌腰 / 撅臀 / 身体不直 —— 俯卧撑类动作的核心错误。
 * 仰卧与坐姿类**故意不做实时提醒**：卷腹、抬腿、体前屈本来就会让肩/背离开地面，
 * 拿「离地多少」去判断姿势只会误报（实测卷腹卷得标准反而被念「肋骨不要外翻」）。
 */
/**
 * 实时提醒的阈值（一处定义：ADVISORY 用它出声纠正，specs.js 用它显示技术指标）。
 * 这些提醒**不拦计数**，只出声 + 打折质量分。
 */
export const ADVISORY_LIMITS = {
  prone: { bodyStraight: 138, hipLineDev: 0.16 },
  stand: { valgus: 0.45, trunkLean: 35 },
};

const ADVISORY = {
  prone: (f, d, now) => {
    if (f.bodyStraight < ADVISORY_LIMITS.prone.bodyStraight) return d.cue('keepStraight', null, 'warn', now, 5000);
    if (f.hipLineDev > ADVISORY_LIMITS.prone.hipLineDev) return d.cue('sag', null, 'warn', now, 5000);
    if (f.hipLineDev < -ADVISORY_LIMITS.prone.hipLineDev) return d.cue('pike', null, 'warn', now, 5000);
    return null;
  },
  stand: (f, d, now) => {
    if (f.view === 'front' && f.valgus > ADVISORY_LIMITS.stand.valgus) return d.cue('valgus', null, 'warn', now, 6000);
    if (f.trunkLean > ADVISORY_LIMITS.stand.trunkLean) return d.cue('lean', null, 'warn', now, 6000);
    return null;
  },
};

/**
 * 离地高度（正数 = 身体整体离开地面）。
 *
 * 有校准地面线时直接用它：脚一定踩在那条线上，换姿势（站↔俯撑）不会被误判成起跳。
 * 没有校准时退回「最近 3 秒身体最低点」的滚动基准 —— 注意这个基准在
 * 「站姿 → 俯撑」这类会让最低跟踪点抬高的姿势切换里会短暂失准，所以真机要走校准那条路。
 */
/** 诊断显示用的数值格式：比例型指标（0~1）保留两位小数，角度型取整 */
const fmt = (v) => (Math.abs(v) < 10 ? Number(v).toFixed(2) : String(Math.round(v)));

export function bodyLift(det, f, now) {
  const bottom = Number.isFinite(f.bodyBottomY) ? f.bodyBottomY : 0;
  if (f.groundRefCalibrated && Number.isFinite(f.groundRef)) return f.groundRef - bottom;
  det.baseBottom = Math.max(det.baseBottom || bottom, bottom);
  if (det._baseAt === undefined) det._baseAt = now;
  if (now - det._baseAt > 3000) { det._baseAt = now; det.baseBottom = bottom; }
  return det.baseBottom - bottom;
}

/* ------------------------------------------------------------------ *
 * 引擎 1：屈伸一次（膝 / 肘 / 髋 / 踝 / 抬高高度）
 * ------------------------------------------------------------------ */

class BendRepDetector extends DetectorBase {
  constructor(meta, opts) {
    super(meta, opts);
    const p = meta.params || {};
    this.p = p;
    this.metricName = p.metric || 'knee';
    this.gateName = p.gate || 'stand';
    this.up = Number.isFinite(p.up) ? p.up : 170;
    this.down = Number.isFinite(p.down) ? p.down : 100;
    this.enterP = p.enterP ?? 0.32;
    this.bottomP = p.bottomP ?? 0.85;
    this.backP = p.backP ?? 0.16;
    this.looseP = p.looseP ?? 0.55;
    this.ignoreP = p.ignoreP ?? 0.45;
    this.minRepMs = p.minRepMs ?? 380;
    this.maxRepMs = p.maxRepMs ?? 9000;
    this.flightMin = p.flightMin ?? 0.035;
    // 跳跃类：身体刚回到起始位时，离地信号往往还差一帧才到（蹬伸的最后一段才离地），
    // 所以留一个短窗口等它 —— 否则「真的跳了」也会被判成「没离地」。
    this.flightGraceMs = p.flightGraceMs ?? 320;
  }

  onReset() {
    this.stage = 'up';
    this.repStartAt = 0;
    this.peak = 0;
    this.progress = 0;
    this.gateOk = false;
    this.flightSeen = false;
    this.backSince = 0;
    this.baseBottom = 0;
    this._badFrames = 0;
    this._baseAt = undefined;
    // 最近 1.5 秒里「起始侧」的极值（见 effUp 的说明）
    this._recent = [];
  }

  metric(f) { return (METRICS[this.metricName] || METRICS.knee)(f); }

  /**
   * 记下最近的指标值（用来估用户自己的「起始位置」）。
   * 为什么需要：绝对阈值会被机位/投影骗 —— 侧拍俯卧撑时手臂明明伸直了，
   * 二维肘角可能只有 140°，于是「回到 168° 才算一轮结束」永远不成立，
   * 后面每一次下放都被并进同一轮，十次变成一次。用「回到自己刚才的起始位置附近」
   * 判断才算得准，而且对每个人都自适应。
   */
  rememberValue(v, now) {
    if (!Number.isFinite(v)) return;
    this._recent.push({ t: now, v });
    while (this._recent.length && now - this._recent[0].t > 1500) this._recent.shift();
  }

  /** 这一轮实际使用的「起始值」：用户自己的极值，但不越过动作本身的参考值 */
  get effUp() {
    if (!this._recent.length) return this.up;
    const vals = this._recent.map((r) => r.v);
    const upward = this.up >= this.down;   // 起始值的数值更大（膝角/肘角）还是更小（踝角/抬起高度）
    const extreme = upward ? Math.max(...vals) : Math.min(...vals);
    return upward ? Math.min(this.up, extreme) : Math.max(this.up, extreme);
  }

  /** 离地高度：见文件顶部的 bodyLift 说明 */
  liftOf(f, now) { return bodyLift(this, f, now); }

  /** 计数诊断（🐞 面板显示）：起始值（跟着用户自己走）/ 本轮峰值 / 上次为什么没计上 */
  diag() {
    return [
      { key: 'debug.diag.stage', value: this.stage },
      { key: 'debug.diag.startValue', value: `${fmt(this.effUp)}/${fmt(this.up)}` },
      { key: 'debug.diag.peak', value: `${Math.round(this.peak * 100)}%` },
      { key: 'debug.diag.counts', value: `${this.validReps}/${this.partialReps}` },
      ...(this.lastReject ? [{ key: 'debug.diag.reject', reject: this.lastReject }] : []),
    ];
  }

  /** 0 = 起始位置，1 = 到位（起始位置用「用户自己的」极值，见 effUp） */
  progressOf(v) {
    const up = this.effUp;
    const span = up - this.down;
    if (!Number.isFinite(v) || Math.abs(span) < 1e-6) return 0;
    return (up - v) / span;
  }

  step(f, now) {
    const lift = this.liftOf(f, now);
    // 离地高度：有校准地面线就用它当地面；没有就用最近 3 秒里「身体最低点」当基准，
    // 跳起来时整体抬升。基准每 3 秒重设一次，允许跑动/换机位。
    const gate = GATES[this.gateName] || GATES.stand;
    const gated = !!gate(f);
    this.gateOk = gated;
    const hintKey = `status.need.${GATE_HINT[this.gateName] || 'stand'}`;

    if (!gated) {
      this.active = false;
      this.standby = hintKey;
      this._badFrames += 1;
      if (this._badFrames > 25) this.cue('notReady', null, 'info', now, 9000);
      this.stage = 'up';
      this.repStartAt = 0;
      this.peak = 0;
      this.progress = 0;
      this.depthPct = 0;
      return;
    }
    this._badFrames = 0;
    this.active = true;
    this.standby = '';

    if (this.p.flight && lift > this.flightMin) this.flightSeen = true;

    const rawV = this.metric(f);
    this.rememberValue(rawV, now);
    const pr = clamp(this.progressOf(rawV), 0, 1.25);
    this.progress = pr;
    this.depthPct = clamp(pr * 100, 0, 100);

    const advise = ADVISORY[this.gateName];
    if (advise) advise(f, this, now);
    // 仰卧抬腿（指标是腰-腿夹角、起始是躺平）：膝盖弯着也能把夹角凑到 90°，
    // 所以腿没有绷直时出声纠正 —— 只提醒、不拦计数（和其余「建议项」一个待遇）。
    // 宽容线 130°：不要太严格，膝盖角度大于 130° 就算绷直（用户要求）
    if (this.metricName === 'hip' && isSupineGate(this.gateName)
      && pr > 0.25 && Number.isFinite(f.kneeAngle) && f.kneeAngle < LEG_STRAIGHT_MIN) {
      this.cue('straightLegs', null, 'warn', now, 9000);
    }

    if (this.stage === 'up') {
      if (pr >= this.enterP) {
        this.stage = 'work';
        this.repStartAt = now;
        this.peak = pr;
        this.phase = 'down';
      }
      return;
    }

    this.peak = Math.max(this.peak, pr);
    const backToStart = pr <= this.backP;
    if (backToStart) {
      if (!this.backSince) this.backSince = now;
    } else {
      this.backSince = 0;
    }
    const waitMs = this.p.flight ? this.flightGraceMs : 0;
    if (backToStart && now - this.backSince >= waitMs) {
      this.finish(f, now);
    } else if (now - this.repStartAt > this.maxRepMs) {
      // 卡在半路太久（换姿势、走神）：安静地作废这一轮，不刷半程
      this.stage = 'up';
      this.repStartAt = 0;
      this.peak = 0;
      this.backSince = 0;
      this.phase = 'up';
    }
  }

  finish(f, now) {
    const dur = now - this.repStartAt;
    const peak = this.peak;
    const flight = this.flightSeen;
    this.stage = 'up';
    this.phase = 'up';
    this.repStartAt = 0;
    this.peak = 0;
    this.flightSeen = false;

    if (peak < this.ignoreP) return; // 只是晃了一下

    const deepEnough = peak >= this.bottomP;
    // 只有宽松模式（用户要求取消严格模式）：峰值到「计次线」就算一次，
    // 深度不够只是分数打折 + 出声纠正，不再有「必须沉到底」的第二种模式。
    const looseEnough = peak >= this.looseP;

    if (!deepEnough && !looseEnough) {
      this.partialReps += 1;
      this.reject('moreRange', `${Math.round(peak * 100)}%`);
      this.cue('moreRange', null, 'warn', now, 3500);
      this.emit({ type: 'rep', valid: false, reason: 'range' });
      this.nextCycle(now);
      return;
    }
    if (this.p.flight && !flight) {
      this.partialReps += 1;
      this.reject('needJump');
      this.cue('needJump', null, 'warn', now, 3500);
      this.emit({ type: 'rep', valid: false, reason: 'flight' });
      this.nextCycle(now);
      return;
    }
    if (dur < this.minRepMs) {
      this.partialReps += 1;
      this.reject('tempo', `${Math.round(dur)}ms`);
      this.cue('tooFast', null, 'warn', now, 3500);
      this.emit({ type: 'rep', valid: false, reason: 'tempo' });
      this.nextCycle(now);
      return;
    }

    this.validReps += 1;
    this.reps = this.validReps;
    this.cycleHadValidRep = true;
    const quality = clamp(Math.round(56 + (peak >= 0.98 ? 30 : peak >= this.bottomP ? 24 : 14) + (flight ? 10 : 5)), 0, 100);
    this.emit({ type: 'rep', valid: true, index: this.validReps, quality, duration: dur, peak });
    this.nextCycle(now);
  }
}

/* ------------------------------------------------------------------ *
 * 引擎 2：左右交替一次（登山者 / 自行车卷腹 / 死虫式 / 鸟狗式）
 * ------------------------------------------------------------------ */

class AltRepDetector extends DetectorBase {
  constructor(meta, opts) {
    super(meta, opts);
    const p = meta.params || {};
    this.p = p;
    this.gateName = p.gate || 'prone';
    this.metricName = p.metric || 'knee';
    this.cmp = p.cmp || 'lt';
    this.onValue = p.onValue ?? p.active ?? 110;
    this.offValue = p.offValue ?? p.inactive ?? 140;
    this.minRepMs = p.minRepMs ?? 200;
    this.holdMs = p.holdMs ?? 60;
  }

  onReset() {
    this.sideNow = null;
    this.sideSince = 0;
    this.lastSide = null;
    this.lastAt = 0;
    this.gateOk = false;
    this._badFrames = 0;
    /**
     * 「已经换到另一条腿了」。
     *
     * 进度条最后一格用它点亮：左右交替类动作**换边成功的那一刻就是计次那一刻**，
     * 而「另一侧回到休息位」只是一个中间条件 —— 用它当最后一格的判据，
     * 用户会看到「最后一格亮了却没计次」。这个标记在计次时置 true，
     * 新的一侧开始做（换边的第一帧）时清掉，所以每次交替只会亮一次。
     */
    this.switched = false;
  }

  /** 某一侧「正在做」的判定 */
  isActive(v) {
    if (!Number.isFinite(v)) return false;
    return this.cmp === 'lt' ? v <= this.onValue : v >= this.onValue;
  }

  isIdle(v) {
    if (!Number.isFinite(v)) return false;
    return this.cmp === 'lt' ? v >= this.offValue : v <= this.offValue;
  }

  step(f, now) {
    const gate = GATES[this.gateName] || GATES.prone;
    const gated = !!gate(f);
    this.gateOk = gated;
    if (!gated) {
      this.active = false;
      this.standby = `status.need.${GATE_HINT[this.gateName] || 'prone'}`;
      this._badFrames += 1;
      if (this._badFrames > 25) this.cue('notReady', null, 'info', now, 9000);
      this.sideNow = null;
      this.sideSince = 0;
      this.depthPct = 0;
      return;
    }
    this._badFrames = 0;
    this.active = true;
    this.standby = '';

    const advise = ADVISORY[this.gateName];
    if (advise) advise(f, this, now);

    const read = (SIDE_METRICS[this.metricName] || SIDE_METRICS.knee);
    const cand = ['L', 'R'].map((s) => {
      const v = read(f, s);
      return { s, v, on: this.isActive(v), off: this.isIdle(v) };
    });
    const on = cand.filter((c) => c.on);
    const off = cand.filter((c) => c.off);
    // 必须一侧在做、另一侧在休息，才是「交替」
    let target = null;
    if (on.length === 1 && off.length === 1 && on[0].s !== off[0].s) target = on[0].s;

    this.depthPct = target ? 100 : 0;

    if (target !== this.sideNow) {
      this.sideNow = target;
      this.sideSince = target ? now : 0;
      if (target) this.switched = false;   // 新的一侧刚开始做：还没换过边
      return;
    }
    if (!target) return;
    if (now - this.sideSince < this.holdMs) return;
    if (target === this.lastSide) return;
    if (this.lastAt && now - this.lastAt < this.minRepMs) return;

    this.lastSide = target;
    this.lastAt = now;
    this.validReps += 1;
    this.reps = this.validReps;
    this.cycleHadValidRep = true;
    this.phase = 'work';
    this.switched = true;   // 换另一条腿成功 = 计次那一刻（进度条最后一格就是这一格）
    this.emit({
      type: 'rep', valid: true, index: this.validReps, quality: 82, side: target, duration: 0,
    });
    this.nextCycle(now);
  }
}

/* ------------------------------------------------------------------ *
 * 引擎 3：左右转体（俄罗斯转体）
 * ------------------------------------------------------------------ */

class TwistRepDetector extends DetectorBase {
  constructor(meta, opts) {
    super(meta, opts);
    const p = meta.params || {};
    this.p = p;
    this.gateName = p.gate || 'seatedLow';
    this.amount = p.amount ?? 0.16;
    this.minRepMs = p.minRepMs ?? 220;
  }

  onReset() {
    this.lastSign = 0;
    this.lastAt = 0;
    this.gateOk = false;
    this._badFrames = 0;
  }

  step(f, now) {
    const gate = GATES[this.gateName] || GATES.seatedLow;
    const gated = !!gate(f);
    this.gateOk = gated;
    if (!gated) {
      this.active = false;
      this.standby = `status.need.${GATE_HINT[this.gateName] || 'seated'}`;
      this._badFrames += 1;
      if (this._badFrames > 25) this.cue('notReady', null, 'info', now, 9000);
      this.depthPct = 0;
      return;
    }
    this._badFrames = 0;
    this.active = true;
    this.standby = '';

    const tw = f.wristTwist;
    const mag = Math.min(1, Math.abs(tw) / (this.amount * 2));
    this.depthPct = clamp(mag * 100, 0, 100);
    if (Math.abs(tw) < this.amount) return;
    const sign = Math.sign(tw);
    if (!this.lastSign) { this.lastSign = sign; this.lastAt = now; return; }
    if (sign === this.lastSign) return;
    if (now - this.lastAt < this.minRepMs) return;
    this.lastSign = sign;
    this.lastAt = now;
    this.validReps += 1;
    this.reps = this.validReps;
    this.cycleHadValidRep = true;
    this.phase = 'work';
    this.emit({ type: 'rep', valid: true, index: this.validReps, quality: 84, side: sign > 0 ? 'R' : 'L' });
    this.nextCycle(now);
  }
}

/* ------------------------------------------------------------------ *
 * 引擎 4：多段动作序列（波比跳这类「一整套」动作）
 * ------------------------------------------------------------------ */

/**
 * 序列动作（波比跳）每一段的判据。
 * 同样是「一处定义」：seqStage 用它判定，specs.js 用它生成弹窗里的技术指标。
 */
export const SEQ_STAGE_LIMITS = {
  stand: { gate: 'stand' },
  crouch: { gate: 'stand', kneeBent: [null, 125] },
  plank: { torsoIncl: [45, null], wristClearMin: [null, 0.75], kneeClear: [null, 0.6] },
  jump: { gate: 'stand', lift: [0.035, null] },
};

const seqStage = {
  stand: (f) => GATES.stand(f),
  crouch: (f) => GATES.stand(f) && inLimit(f.kneeBent, SEQ_STAGE_LIMITS.crouch.kneeBent),
  plank: (f) => inLimit(f.torsoIncl, SEQ_STAGE_LIMITS.plank.torsoIncl)
    && inLimit(f.wristClearMin, SEQ_STAGE_LIMITS.plank.wristClearMin)
    && inLimit(f.kneeClear, SEQ_STAGE_LIMITS.plank.kneeClear),
  jump: (f) => GATES.stand(f) && inLimit(f.__lift, SEQ_STAGE_LIMITS.jump.lift),
  kneel: (f) => GATES.kneel(f),
  sit: (f) => GATES.seated(f),
};

class SequenceRepDetector extends DetectorBase {
  constructor(meta, opts) {
    super(meta, opts);
    const p = meta.params || {};
    this.p = p;
    this.stages = (p.stages || ['stand', 'crouch', 'plank', 'stand']).map((s) => seqStage[s] || seqStage.stand);
    this.stageNames = p.stages || ['stand', 'crouch', 'plank', 'stand'];
    this.windowMs = p.windowMs ?? 9000;
    this.minRepMs = p.minRepMs ?? 900;
  }

  onReset() {
    this.idx = 0;
    // 用 -1 表示「还没开始这一套」：0 是合法时间戳（第一帧 now 可能就是 0），
    // 用 0 当哨兵会让第一次波比跳被算成「用时 0 秒 → 太快了」。
    this.startedAt = -1;
    this.baseBottom = 0;
    this.lift = 0;
    this.gateOk = false;
    this._badFrames = 0;
    this._baseAt = undefined;
  }

  step(f, now) {
    // 离地高度：与 bend 引擎同一套规则（校准地面优先，否则用滚动基准）
    const lift = bodyLift(this, f, now);
    const ff = { ...f, __lift: lift };
    this.lift = lift;

    // 站姿是整套动作的起点；不在场地上就提示
    const inPlace = GATES.stand(f) || f.torsoIncl > 40 || GATES.seated(f) || GATES.kneel(f);
    this.gateOk = inPlace;
    if (!inPlace) {
      this.active = false;
      this.standby = 'status.need.stand';
      this._badFrames += 1;
      if (this._badFrames > 40) this.cue('notReady', null, 'info', now, 9000);
      this.idx = 0;
      this.depthPct = 0;
      return;
    }
    this._badFrames = 0;
    this.active = true;
    this.standby = '';

    if (this.startedAt >= 0 && now - this.startedAt > this.windowMs) {
      this.idx = 0;
      this.startedAt = -1;
    }

    this.depthPct = clamp((this.idx / (this.stages.length - 1)) * 100, 0, 100);

    if (this.stages[this.idx](ff)) {
      if (this.idx === 0) this.startedAt = now;
      this.idx += 1;
      if (this.idx >= this.stages.length) {
        const dur = this.startedAt >= 0 ? now - this.startedAt : 0;
        this.idx = 0;
        this.startedAt = -1;
        this.depthPct = 0;
        this.phase = 'work';
        if (dur >= this.minRepMs) {
          this.validReps += 1;
          this.reps = this.validReps;
          this.cycleHadValidRep = true;
          this.emit({ type: 'rep', valid: true, index: this.validReps, quality: 88, duration: dur });
          this.nextCycle(now);
        } else {
          this.partialReps += 1;
          this.cue('tooFast', null, 'warn', now, 3500);
          this.emit({ type: 'rep', valid: false, reason: 'tempo' });
          this.nextCycle(now);
        }
      } else {
        this.phase = 'work';
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 引擎 5：计时（姿势到位就计时）
 * ------------------------------------------------------------------ */

class PoseHoldDetector extends HoldDetector {
  constructor(meta, opts) {
    super(meta, opts);
    const p = meta.params || {};
    this.p = p;
    this.gateName = p.gate || 'stand';
  }

  /** 计数诊断（🐞 面板显示）：现在计到几秒、姿势门控过没过 */
  diag() {
    return [
      { key: 'debug.diag.hold', value: `${(this.holdMs / 1000).toFixed(1)}s` },
      { key: 'debug.diag.pose', value: this.gateOk ? 'ok' : 'no' },
      ...(this.lastReject ? [{ key: 'debug.diag.reject', reject: this.lastReject }] : []),
    ];
  }

  checkHold(f) {
    const gate = GATES[this.gateName] || GATES.stand;
    const ok = !!gate(f);
    // 计分步骤（holdPose / stretchHold 方案）要靠 gateOk 判断「姿势到位」这一步
    this.gateOk = ok;
    if (!ok) {
      this.depthPct = 0;
      return { valid: false, reason: 'pose' };
    }
    if (this.p.straight && !(f.bodyStraight >= this.p.straight)) {
      this.depthPct = 60;
      return { valid: false, reason: 'keepStraight' };
    }
    this.depthPct = 100;
    return { valid: true };
  }
}

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */

export function createEngineDetector(meta, opts = {}) {
  switch (meta.engine) {
    case 'bend': return new BendRepDetector(meta, opts);
    case 'alt': return new AltRepDetector(meta, opts);
    case 'twist': return new TwistRepDetector(meta, opts);
    case 'sequence': return new SequenceRepDetector(meta, opts);
    case 'hold': return new PoseHoldDetector(meta, opts);
    default: return new PoseHoldDetector(meta, opts);
  }
}

export { BendRepDetector, AltRepDetector, TwistRepDetector, SequenceRepDetector, PoseHoldDetector };
