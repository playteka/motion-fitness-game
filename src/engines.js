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
   * 仰卧（腿可以伸直：仰卧抬腿）：**只看「躺没躺下」**，而且是**两条证据取「或」**。
   *
   * 用户两轮反馈把这里定成了现在这样：
   *   ① 第一轮「姿势要求只保留『肩离地高度 ≤ 0.6×躯干长』，删除『躯干倾角 ≥ 36°』」——
   *      所以这里不再有「必须同时满足」的硬条件；
   *   ② 第二轮「仰卧抬腿总是进入不了起始姿势」——查下来就是这唯一的一条**依赖地面线**：
   *      校准记下的地面线一旦比身体低（在床上/沙发上做、或者机位在脚这一头），
   *      躺得再标准也会读到「肩离地 0.6 倍躯干长以上」而被判成「没躺下」。
   *      实测：躺平（躯干 90°、髋 180°、膝 178°）在地面线偏低时会被拦住。
   *
   * 现在两条证据任一条成立就算躺平：
   *   - `torsoIncl ≥ 55°`：躯干在画面里接近水平（**完全不看地面线**，机位/床垫都不影响）；
   *   - `shoulderClear ≤ 0.6`：肩膀离地面线不超过 0.6 倍躯干长（原来的那条）。
   * 站起来（躯干 ≈10°、肩离地 ≈1.2）两条都不成立，仍旧被拦住。
   */
  supineFlat: {
    torsoIncl: [55, null],
    shoulderClear: [null, 0.6],
  },
  /** 仰卧（腿可以弯：死虫式）—— 判据与 supineFlat 相同，只是名字不同（见 specs.js 的 OR_GATES） */
  supineLow: {
    torsoIncl: [55, null],
    shoulderClear: [null, 0.6],
  },
  /** 站立体前屈：站着但躯干往前折（髋离地 ≥0.65 倍躯干长 = 不是坐/躺） */
  standFold: {
    torsoIncl: [55, null],
    hipClear: [0.65, null],
  },
  /**
   * 坐姿体前屈：**按用户给的运动学描述重做过**（原来「髋离地 ≤0.9 + 躯干倾角 ≥40」判不出计时）。
   *
   * 用户的描述：「初始关键帧其实就是侧面向镜头坐好，此刻**髋角度约 90°、躯干角度约为 0°**。
   * 当身体前屈的时候，**躯干角度和髋角度相加之和应该始终在 90° 左右**。
   * 当身体前倾、**躯干角度在 30 左右**基本也就到位、可以开始计时了。」
   *
   * 原来的两条都有问题：
   *   ① `hipClear ≤ 0.9`（髋离地高度）**依赖校准地面线** —— 地面线偏低（床上/沙发上做、机位偏）
   *      就永远读成 1.0 以上 → 一次都不计时（用户反馈「实际没有计时」）；
   *   ② `torsoIncl ≥ 40` 比用户说的 30 更严。
   *
   * 现在全部改成**不看地面线**的角度判据：
   *   - `hipAboveKnee ≤ 0.40`：髋不比膝高 → 坐在垫子上（站立 ≈ +0.9、深蹲 ≥ +0.5 都进不来）；
   *   - `knee ≥ 125°`：双腿伸直放平（屈膝糊弄不算；前折全程都成立，不会打断计时）；
   *   - `foldSum ∈ [60, 125]`：**躯干角 + 髋角 ≈ 90°**（用户给的恒等式；站着 ≈180°、躺着 ≥180° 都被排除）；
   *   - `torsoIncl ≥ 28°`：身体前倾到位 → **这一条成立就开始计时**
   *     （用户说「躯干角度在 30 左右基本也就到位」，阈值取 28° 留 2° 识别抖动余量）。
   *
   * 键名用的是**弹窗指标名**（`knee` → `metric.knee`、`hip` → `metric.hip`），
   * 而 GATES 里读的是帧上的字段（`f.kneeAngle` / `f.hipAngle`）—— 和其他门控同一个写法，见下面的 GATES。
   */
  seatedFold: {
    hipAboveKnee: [null, 0.40],
    knee: [125, null],
    foldSum: [60, 125],
    torsoIncl: [28, null],
  },
  /**
   * 坐姿体前屈的**起始姿势**（用户的「初始关键帧」）：侧对镜头坐好 ——
   * 躯干基本竖直（≈0°）、髋角 ≈90°（大腿在身前、放平）、双腿伸直、坐在垫子上。
   * 识别到一次就**锁存**（`startSeen`），之后前折不会把它取消 ——
   * 进度条第一格「坐好」点亮后常亮，第二格「前折到位」才是开始计时那一刻。
   */
  seatedFoldStart: {
    torsoIncl: [null, 25],
    hip: [70, 115],
    knee: [130, null],
    hipAboveKnee: [null, 0.40],
  },
};

/** 区间判定：null 表示该侧不限制 */
export function inLimit(v, [min, max]) {
  if (!Number.isFinite(v)) return false;
  if (min !== null && v < min) return false;
  if (max !== null && v > max) return false;
  return true;
}

/**
 * 「躺下了没有」= **两条证据取「或」**（仰卧类的门控 supineFlat / supineLow 都用它）：
 *   ① 躯干在画面里接近水平（`torsoIncl ≥ 55°`）—— **不看地面线**；
 *   ② 肩膀离地面线不超过 0.6 倍躯干长（`shoulderClear ≤ 0.6`）。
 * 为什么必须是「或」而不是「且」：见 GATE_LIMITS.supineFlat 的说明 ——
 * 躺得再标准，只要校准地面线比身体低（床上/沙发上、或机位在脚这一头），
 * 第 ② 条就会误判成「没躺下」，用户会被卡在「进入不了起始姿势」。
 */
export const supineLying = (f) => inLimit(f.torsoIncl, GATE_LIMITS.supineFlat.torsoIncl)
  || inLimit(f.shoulderClear, GATE_LIMITS.supineFlat.shoulderClear);

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
  /** 仰卧（腿可以伸直：仰卧抬腿 / 死虫式 / 空心支撑 / 龙旗）—— 两条证据取「或」，见 GATE_LIMITS 的说明 */
  supineLow: (f) => supineLying(f),
  supineFlat: (f) => supineLying(f),
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
  /** 坐姿体前屈：**全部是角度判据**（不看地面线）—— 见 GATE_LIMITS.seatedFold 的说明 */
  seatedFold: (f) => inLimit(f.torsoIncl, GATE_LIMITS.seatedFold.torsoIncl)
    && inLimit(f.kneeAngle, GATE_LIMITS.seatedFold.knee)
    && inLimit(f.hipAboveKnee, GATE_LIMITS.seatedFold.hipAboveKnee)
    && inLimit(f.foldSum, GATE_LIMITS.seatedFold.foldSum),
  /** 坐姿体前屈的**起始姿势**（坐直、双腿伸直）：识别到一次就锁存，用于进度条第一格 */
  seatedFoldStart: (f) => inLimit(f.torsoIncl, GATE_LIMITS.seatedFoldStart.torsoIncl)
    && inLimit(f.hipAngle, GATE_LIMITS.seatedFoldStart.hip)
    && inLimit(f.kneeAngle, GATE_LIMITS.seatedFoldStart.knee)
    && inLimit(f.hipAboveKnee, GATE_LIMITS.seatedFoldStart.hipAboveKnee),
  /** 蝴蝶式：坐姿 + 双膝打开 */
  butterfly: (f) => f.hipClear < 0.95 && f.kneeSpread > 0.55 && f.torsoIncl < 55,
  /** 青蛙趴：俯卧/跪趴 + 双膝打开 */
  frogPose: (f) => f.torsoIncl > 35 && f.kneeSpread > 0.5 && f.kneeClear < 0.5,
  /** 倒立（倒立撑）：髋高于肩、身体竖直 */
  inverted: (f) => f.inverted && f.torsoIncl < 50 && f.shoulderClear > 0.3,
  /** 双杠臂屈伸：身体竖直、手在髋两侧（手离地高度接近髋） */
  dips: (f) => f.torsoIncl < 45 && f.hipClear > 0.35 && f.wristClearMin < 0.9 && f.wristClearMin > 0.05,
  /** 悬垂（悬垂举腿）：身体竖直 + 脚离地（需要校准地面线） */
  hang: (f) => f.torsoIncl < 45 && f.ankleClear > 0.25,
};

/** 每个门控对应「现在该怎么做」的提示键后缀 */
export const GATE_HINT = {
  stand: 'stand', standWide: 'stand', standUpright: 'stand', standOneLeg: 'stand', standWall: 'stand',
  standHeelUp: 'stand', standArmCross: 'stand', standFold: 'stand',
  prone: 'prone', proneHigh: 'prone', proneFloor: 'prone', proneLift: 'prone',
  supine: 'supine', supineLow: 'supine', supineFlat: 'supine', hollow: 'supine', crab: 'supine',
  quadruped: 'quadruped', bearCrawl: 'quadruped',
  kneel: 'kneel', kneelFold: 'kneel', childPose: 'kneel', wristStretch: 'kneel',
  seated: 'seated', seatedLow: 'seated', seatedFold: 'seated', seatedFoldStart: 'seated', butterfly: 'seated',
  vSit: 'seated', frogPose: 'prone',
  inverted: 'inverted', hang: 'hang', dips: 'stand',};

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
  // 单侧「腿伸出去的程度」（膝角与髋角取小，见 metrics.js）：死虫式用它
  legOut: (f, s) => f.perSide?.[s]?.legOut,
  // 单侧「脚跟到同侧髋的距离 ÷ 腿长」（站立 ≈1.0、真勾腿 ≈0.5）：勾腿跳的第二路证据
  kick: (f, s) => f.perSide?.[s]?.kick,
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
    // 提示文案默认按门控名给（「躺到垫子上：仰卧屈膝…」那是臀桥/卷腹的说法），
    // 动作可以用 `params.standbyKey` 换成自己的说法 —— 仰卧抬腿要求腿伸直，
    // 沿用「仰卧屈膝」会让人以为起始姿势是屈膝（用户反馈过）。
    const hintKey = this.p.standbyKey || `status.need.${GATE_HINT[this.gateName] || 'stand'}`;

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
    /**
     * 一侧「连续在做」的最长时间（毫秒）。
     *
     * 一次勾腿 / 蹬腿不可能一直保持「在做」：如果这一侧的读数一直没回到 `offValue`
     *（快节奏时腿本来就不会每次完全伸直），超过这个时间就把它判为「已经做完了」。
     * 这个状态只用来驱动画面上的深度条与 🐞 诊断行（**计次走上升沿，见 countRises**）。
     */
    this.strokeMs = p.strokeMs ?? 700;
    /**
     * 两条腿**同一帧**一起进线时，允许认成一次的最小红腿深差（度）。
     *
     * 快跳时支撑腿会跟着下沉，两条腿常常同帧跨线；这时只有「一侧明显更深」才说明
     * 那条是真勾起来的腿（见 countRises）。两条腿一样深（一起弯，不是交替）不认。
     */
    this.leadMin = p.leadMin ?? 18;
    /**
     * 「另一侧必须还在休息位」的额外条件（可选，**死虫式在用**）。
     *
     * 勾腿跳故意**不**要求这个（真人快跳时支撑腿会跟着下沉，见 countRises 的说明）；
     * 但死虫式的动作要点恰恰相反 —— **一次只伸一条腿，另一条腿留在屈膝 90° 的桌面位上**。
     * 没有这条约束时，「两条腿一起伸出去」（是另一个动作、也常常是作弊）会按
     * 「更深的那一侧」计上一次，用户看到的就是「判别标准不对」。
     *
     * 形如 `{ metric: 'legOut', cmp: 'lt', value: 120 }` = 「另一侧的 legOut ≤ 120°」。
     * 读不到数值时**不拦**（宁可放过也不要漏计）。
     */
    this.otherHold = p.otherHold || null;
    /**
     * 「挂起的上升沿」最多等多久（毫秒，见 flushPending）。
     * 换边时另一条腿大概 200~400ms 就回到桌面位了，1.2 秒还没回去说明是真的两条腿一起动。
     */
    this.pendingMs = p.pendingMs ?? 1200;
    /**
     * **第二路证据**（可选，勾腿跳在用）：`{ metric, dip, leadMin }` —— **相对判据**。
     *
     * 用户反馈「跳得时候经常无法计数，尤其是跳得快的时候」。查下来有两层原因：
     *   ① 快节奏 + 动作模糊 + 平滑滤波会把**采样到的**最小膝角压浅（实测差 10~30°），
     *      而膝角那条线必须卡得很紧（松一点「原地小跑」就会被算成勾腿）；
     *   ② **跳得快时人是在原地小弹跳，两条腿都不会再伸直** —— 支撑腿一直停在判定线附近，
     *      「这一侧不在做」这个状态再也不出现，交替的上升沿就再也抓不到，后面的次数全丢。
     *
     * 所以补一路**跨度大、而且相对自己基线**的证据：`perSide.kick` = 脚跟到同侧髋的距离 ÷ 腿长
     * （见 metrics.js）：站立 ≈1.0、原地小跑 ≥0.95、真正勾到臀部 ≈0.45~0.7。
     * 判定写成「**比自己最近『腿伸直』时的读数近了 `dip`（默认 0.12，勾腿跳就用 0.12）**」——
     *   - 小跑的相对变化只有 0.02~0.05，永远够不到 ✅ 不会被误算成勾腿；
     *   - 真勾腿哪怕是快跳、膝角读数被压浅，脚跟确实上来了 0.3~0.45 ✅ 照样计上；
     *   - 它跟着你自己的基线走，所以**两条腿不用伸直也能各自判定**（解决了上面 ② 那层原因）。
     *
     * 两路证据取「**或**」，谁先到线算谁的（和臀桥 / 平板支撑那套「或」判据同一个思路）。
     * `altLeadMin` 是这一路自己的「明显更深」门槛（比例量：默认 0.08 = 8% 腿长，勾腿跳配 0.06 = 6%）。
     */
    this.altMetric = p.altMetric || null;
    this.altDip = p.altDip ?? 0.12;
    /** 膝角那一路额外要求「脚跟至少也上来一点」（见 deepNow 的说明；0 = 不额外要求） */
    this.altKneeDip = p.altKneeDip ?? 0;
    this.altLeadMin = p.altLeadMin ?? 0.08;
    /** 每一侧「腿伸直」时的基线（相对判据的基准，见 altActive） */
    this.altBase = { L: NaN, R: NaN };
    /**
     * 「两条腿同帧跨线、但一时分不出谁更深」时等多久（毫秒）：等这段时间里谁先明显更深就算谁，
     * 一直分不出来（两条腿一起弯，不是交替）就整帧丢掉。
     */
    this.tieMs = p.tieMs ?? 200;
  }

  /** 另一侧现在是不是还在休息位（没配 otherHold 就永远成立） */
  otherSideRestOk(f, side) {
    if (!this.otherHold) return true;
    const read = SIDE_METRICS[this.otherHold.metric] || SIDE_METRICS.knee;
    const v = read(f, side);
    if (!Number.isFinite(v)) return true;
    const cmp = this.otherHold.cmp || 'lt';
    return cmp === 'lt' ? v <= this.otherHold.value : v >= this.otherHold.value;
  }

  onReset() {
    this.sideNow = null;
    this.sideSince = 0;
    this.lastSide = null;
    this.lastAt = 0;
    this.gateOk = false;
    this._badFrames = 0;
    /** 挂起的『已经伸出来、但另一条腿还没回到休息位』的那一侧（见 flushPending） */
    this.pendingSide = null;
    this.pendingAt = 0;
    /** 挂起的『两条腿同帧进线、一时分不出谁更深』的那一对（见 flushTie） */
    this.tiePair = null;
    /** 每一侧「现在正在做」的迟滞状态（进入用 onValue、退出用 offValue）—— 只用于显示 */
    this.sideOn = { L: false, R: false };
    /** 每一侧这一轮「在做」是从什么时候开始的（用于 strokeMs 超时退出） */
    this.sideStart = { L: 0, R: 0 };
    /** 每一侧这一轮做到的最深值（诊断用；也说明这一轮真的做了一下） */
    this.strokeMin = { L: NaN, R: NaN };
    /** 上一帧每一侧是否「在做」（逐帧比较，不带迟滞）：计次靠它 */
    this.wasDeep = { L: false, R: false };
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

  /** 某一侧「正在做」的判定（用配置里的 onValue） */
  isActive(v) {
    if (!Number.isFinite(v)) return false;
    return this.cmp === 'lt' ? v <= this.onValue : v >= this.onValue;
  }

  /** 第二路证据的读数（没配就返回 NaN） */
  altRead(f, s) {
    if (!this.altMetric) return NaN;
    const read = SIDE_METRICS[this.altMetric] || SIDE_METRICS.knee;
    return read(f, s);
  }

  /**
   * 第二路证据到线了没有：**比自己「腿伸直」时的基线近了 `altDip`**（相对判据，见构造函数）。
   * 基线还没测到（比如刚站起来）时这一路不参与，交给膝角那条路。
   */
  altActive(v, s) {
    if (!this.altMetric || !Number.isFinite(v)) return false;
    const base = this.altBase[s];
    if (!Number.isFinite(base) || base < 0.75) return false;
    return v <= base - this.altDip;
  }

  /** 更新第二路证据的基线（缓慢回落的「最大值」，跟着姿势漂移） */
  updateAltBase(f) {
    if (!this.altMetric) return;
    for (const s of ['L', 'R']) {
      const v = this.altRead(f, s);
      if (!Number.isFinite(v)) continue;
      const prev = Number.isFinite(this.altBase[s]) ? this.altBase[s] : v;
      this.altBase[s] = Math.max(v, prev - (this.p.altDecay ?? 0.003));
    }
  }

  /**
   * 这一帧某一侧算不算「在做」（勾腿跳这类配了第二路证据的动作）。
   *
   * 规则（**两路证据取「或」，但第二路一旦可用就以「脚跟有没有上来」为准**）：
   *   ① 没配第二路证据（死虫式 / 登山者）→ 就是原来的指标线；
   *   ② 第二路可用（脚跟看得见、而且已经测到「腿伸直」的基线）：
   *      - 脚跟比自己伸直时近了 `altDip`（0.12）→ 算「勾起来了」；
   *      - 指标（膝角）到线，**并且脚跟至少也上来一点**（`altKneeDip`，0.06）→ 也算。
   *        为什么膝角这一路还要加「脚跟也上来一点」：快跳时**支撑腿的膝盖也会弯到线内**
   *        （实测 120~140°），只看膝角会把支撑腿也当成「在勾」，交替的上升沿就乱了 ——
   *        而「脚跟到髋的距离」不受这个影响（支撑腿的脚跟几乎不动）。
   *   ③ 第二路量不到（脚跟不可见 / 还没建立基线）→ 退回指标线，绝不因为量不到就不计次。
   */
  deepNow(f, s) {
    const kneeOk = this.isActive((SIDE_METRICS[this.metricName] || SIDE_METRICS.knee)(f, s));
    if (!this.altMetric) return kneeOk;
    const v = this.altRead(f, s);
    const base = this.altBase[s];
    // 脚跟的可见度：太低时这一路不参与（退回指标线，宁可放过也不要漏计）
    const heelVis = Number(f.perSide?.[s]?.heelVis);
    const visOk = !Number.isFinite(heelVis) || heelVis >= 0.4;
    const armed = Number.isFinite(v) && Number.isFinite(base) && base >= 0.75 && visOk;
    if (!armed) return kneeOk;
    if (v <= base - this.altDip) return true;
    return kneeOk && v <= base - this.altKneeDip;
  }

  /**
   * 「深了多少」的统一尺度（用来比较两条腿谁更深，只在**同一路证据**之间比较）：
   *   角度类 → 越过判定线多少度；相对比例类（kick）→ 比自己基线近了多少（×100 变成可比的量级）。
   */
  depthMargin(f, s) {
    const v = (SIDE_METRICS[this.metricName] || SIDE_METRICS.knee)(f, s);
    const km = Number.isFinite(v) ? (this.cmp === 'lt' ? this.onValue - v : v - this.onValue) : -Infinity;
    const av = this.altRead(f, s);
    const base = this.altBase[s];
    const am = Number.isFinite(av) && Number.isFinite(base) ? (base - av) * 100 : -Infinity;
    return { knee: km, alt: am };
  }

  isIdle(v) {
    if (!Number.isFinite(v)) return false;
    return this.cmp === 'lt' ? v >= this.offValue : v <= this.offValue;
  }

  /**
   * 每一侧独立维护「正在做」的迟滞状态。
   *
   * 进入用 `onValue`、退出用 `offValue`，落在中间地带时**保持上一次的状态** ——
   * 这样一侧在做的时候不会因为识别抖动在 on/off 之间来回跳。
   * 一侧连续「在做」超过 `strokeMs` 也算做完（见构造函数的说明）。
   *
   * 注意：**计次不靠这个状态**（很快的动作里这个标志会「粘住」，见 countRises），
   * 它只用来驱动画面上的深度条与 🐞 诊断行，所以这里的迟滞不影响「快节奏计不上」那件事。
   */
  updateSides(f, now) {
    const read = (SIDE_METRICS[this.metricName] || SIDE_METRICS.knee);
    for (const s of ['L', 'R']) {
      const v = read(f, s);
      if (!Number.isFinite(v)) continue;
      const was = this.sideOn[s];
      let on = was;
      if (this.isActive(v)) {
        if (!was) { this.sideStart[s] = now; this.strokeMin[s] = v; }
        on = true;
        // 记录这一轮做到的最深值（诊断用，也是「真的做了一下」的证据）
        this.strokeMin[s] = this.cmp === 'lt' ? Math.min(this.strokeMin[s], v) : Math.max(this.strokeMin[s], v);
      } else if (this.isIdle(v)) {
        on = false;
      }
      if (on && now - this.sideStart[s] >= this.strokeMs) on = false;   // 超时：这一轮早就结束了
      this.sideOn[s] = on;
    }
  }

  /**
   * **计次：进入「在做」的那一帧（上升沿）**。
   *
   * 为什么不用「保持 holdMs 才计次」（最早那版）或「回到休息位再结算」：
   *   ① 很快的勾腿**一帧就完成**（跳下去又马上回来）→「保持 25ms」整轮抓不到；
   *   ② 快节奏时勾完那条腿只回到 121°~126°，一直没到退出线 → 迟滞状态「粘住」，
   *      「回到休息位」也跟着漏，而且一侧粘住后另一侧也进不来。
   * 上升沿只看「这一帧是不是刚从线外进到线内」，**和退出线无关**，所以两种情况都成立。
   *
   * 逐帧比较（不做迟滞）：腿回到 126° 但没到退出线时，也算「离开线内」，
   * 所以下一次勾腿照样会被认成一次新的动作，不会被吞掉。
   *
   * **两条腿同一帧一起进线怎么办**（用户反馈「还有少数几次没计上」的第二层原因）：
   * 快跳时人是在原地弹跳，**支撑腿也会跟着下沉**，于是经常出现两条腿同帧跨过判定线。
   * 旧写法要求「恰好一侧进线」，这一帧就整轮丢掉了 —— 实测这种模型下几乎一次都计不上。
   * 现在改成：这种情况若**一侧明显更深**（差 ≥ `leadMin` 度，说明那条才是真勾起来的腿），
   * 就按更深的那一侧计次；两条腿一样深（一起弯，不是交替）仍然不认。
   */
  countRises(f, now) {
    const rise = [];
    const val = {};
    for (const s of ['L', 'R']) {
      val[s] = (SIDE_METRICS[this.metricName] || SIDE_METRICS.knee)(f, s);
      const deep = this.deepNow(f, s);        // 两路证据取「或」（不看迟滞）
      if (deep && !this.wasDeep[s]) rise.push(s);
      this.wasDeep[s] = deep;
    }
    // 先处理上一帧被「另一条腿还在动」挡下来的那一侧
    this.flushPending(f, now);
    // 再处理「上一帧两条腿一起进线、一时分不出谁更深」的那一对（见 tieSide）
    this.flushTie(f, now);
    if (!rise.length) return;
    // 配了 otherHold 的动作（死虫式）：另一条腿必须还在休息位，一次只做一条腿。
    // 不满足时先把这一侧**挂起来**（见 flushPending），不要因为换边那一瞬间
    // 「刚伸完的腿还在往回走」就把这一次伸腿丢掉。
    const allow = (side) => {
      const other = side === 'L' ? 'R' : 'L';
      if (this.otherSideRestOk(f, other)) return true;
      const readOther = SIDE_METRICS[this.otherHold.metric] || SIDE_METRICS.knee;
      this.reject('otherSide', `${other}:${fmt(readOther(f, other))}`);
      this.pendingSide = side;
      this.pendingAt = now;
      return false;
    };
    if (rise.length === 1) {
      // 恰好一侧刚进入「在做」→ 这一侧的这次动作算一次
      if (!allow(rise[0])) return;
      if (rise[0] !== this.lastSide) this.switched = false;   // 新的一侧刚开始：等这次做完再点亮
      this.countRep(rise[0], now);
      return;
    }
    if (rise.length === 2) {
      const [a, b] = rise;
      const pick = this.deeperOf(f, a, b);
      if (!pick) {
        // 两条腿同帧进线、这一帧还分不出谁更深：**别丢**，挂起来等一小会儿（见 flushTie）。
        // 用户反馈「跳得快的时候经常无法计数」——快跳时两条腿常常同一帧跨线，
        // 而更深的那一条往往要再一两帧才显出来；旧写法这一帧直接丢掉，那一次就永远没了。
        this.tiePair = { a, b, at: now };
        return;
      }
      if (!allow(pick)) return;
      if (pick !== this.lastSide) this.switched = false;
      this.countRep(pick, now);
    }
  }

  /**
   * 两条腿同帧进线时，判断哪一条是**真正勾起来**的那条。
   *
   * 判据是「明显更深」，而且**在同一路证据内部**比较：
   *   - 两腿都靠「脚跟到髋的比例」过的线 → 用比例差（`altLeadMin`，勾腿跳 = 0.06 腿长）——
   *     这一路跨度大（1.0 → 0.5），真实勾腿与支撑腿差得很开；
   *   - 否则用膝角差（`leadMin`，勾腿跳 = 18°）。
   * 两条腿一样深（一起弯，不是交替）返回 null。
   */
  deeperOf(f, a, b) {
    const ma = this.depthMargin(f, a);
    const mb = this.depthMargin(f, b);
    const bothAlt = this.altMetric && this.altActive(this.altRead(f, a), a) && this.altActive(this.altRead(f, b), b);
    const bothKnee = Number.isFinite(ma.knee) && Number.isFinite(mb.knee)
      && this.isActive((SIDE_METRICS[this.metricName] || SIDE_METRICS.knee)(f, a))
      && this.isActive((SIDE_METRICS[this.metricName] || SIDE_METRICS.knee)(f, b));
    const key = bothAlt ? 'alt' : (bothKnee ? 'knee' : (Number.isFinite(ma.alt) && Number.isFinite(mb.alt) ? 'alt' : 'knee'));
    const lead = Math.abs(ma[key] - mb[key]);
    const need = key === 'alt' ? this.altLeadMin * 100 : this.leadMin;
    if (!Number.isFinite(lead) || lead < need) return null;
    return ma[key] >= mb[key] ? a : b;
  }

  /** 补记「两条腿同帧进线、稍后才分出更深那一条」的那一次（见 countRises 的 tiePair） */
  flushTie(f, now) {
    if (!this.tiePair) return;
    const { a, b, at } = this.tiePair;
    // 两条腿都不在「在做」里了 → 这一对早结束了，丢掉
    if (!this.deepNow(f, a) && !this.deepNow(f, b)) { this.tiePair = null; return; }
    const pick = this.deeperOf(f, a, b);
    if (pick) {
      this.tiePair = null;
      if (pick !== this.lastSide) this.switched = false;
      this.countRep(pick, now);
      return;
    }
    if (now - at > this.tieMs) this.tiePair = null;   // 等超时：当作「两条腿一起弯」丢掉
  }

  /**
   * 补记「挂起的那一次伸腿」。
   *
   * 为什么需要它：换边那一瞬间，**刚伸完的那条腿还在往回走**（平滑之后约 200~400ms 才回到桌面位），
   * 而另一条腿已经伸出去了 —— 上升沿正好落在「另一条腿还没到位」的几帧里。
   * 如果那一帧直接把上升沿丢掉，这一整次伸腿就永远计不上（实测：换边 4 次只计 1 次）。
   * 所以先挂起，等另一条腿真的回到休息位、并且这一侧**还伸着**的时候再计一次；
   * 如果这一侧先收回来了（说明这次交替根本没做完），就放弃，不补记。
   *
   * 挂起超过 pendingMs 还没等到 → 认为真的是两条腿一起动：出声纠正一次（顺带说明原因）。
   */
  flushPending(f, now) {
    if (!this.pendingSide) return;
    const side = this.pendingSide;
    const other = side === 'L' ? 'R' : 'L';
    const read = (SIDE_METRICS[this.metricName] || SIDE_METRICS.knee);
    if (!this.isActive(read(f, side))) { this.pendingSide = null; return; }
    if (!this.otherSideRestOk(f, other)) {
      if (now - this.pendingAt > this.pendingMs) {
        this.pendingSide = null;
        this.cue('otherSide', null, 'warn', now, 6000);
      }
      return;
    }
    this.pendingSide = null;
    if (side !== this.lastSide) this.switched = false;
    this.countRep(side, now);
  }

  /**
   * 给某一侧记一次数（交替 + 间隔两道门都在这里）。
   * @returns {boolean} 真的计上了没有
   */
  countRep(side, now) {
    if (!side) return false;
    if (side === this.lastSide) return false;                      // 同一条腿连着做，不算交替
    if (this.lastAt && now - this.lastAt < this.minRepMs) return false;   // 太快了：只当抖了一下
    this.lastSide = side;
    this.lastAt = now;
    this.validReps += 1;
    this.reps = this.validReps;
    this.cycleHadValidRep = true;
    this.phase = 'work';
    this.switched = true;   // 换另一条腿成功 = 计次那一刻（进度条最后一格就是这一格）
    this.emit({
      type: 'rep', valid: true, index: this.validReps, quality: 82, side, duration: 0,
    });
    this.nextCycle(now);
    return true;
  }

  /**
   * 计数诊断（🐞 面板显示）。
   *
   * 左右交替类动作（勾腿跳 / 登山者 / 死虫式）以前**没有诊断行**，面板那里一直是「—」，
   * 用户反馈「勾腿跳快一点就计不上」时完全看不到卡在哪 —— 所以这里把判定链上的量都摆出来：
   * 交替线（进入 / 退出）、两条腿当前膝角与「在做 / 休息」状态、当前认的是哪一侧、距上次计次多久。
   */
  diag() {
    const read = (SIDE_METRICS[this.metricName] || SIDE_METRICS.knee);
    const one = (s) => {
      const v = read(this._lastFrame || {}, s);
      // 第二路证据（勾腿跳的「脚跟到髋」）也摆出来：快跳时看得见它有没有到线
      const av = this.altRead(this._lastFrame || {}, s);
      const altTxt = Number.isFinite(av) ? `/${fmt(av)}` : '';
      return `${s}:${Number.isFinite(v) ? Math.round(v) : '—'}${altTxt}${this.sideOn[s] ? '✓' : ''}`;
    };
    const line = this.cmp === 'lt'
      ? `≤${fmt(this.onValue)}/≥${fmt(this.offValue)}`
      : `≥${fmt(this.onValue)}/≤${fmt(this.offValue)}`;
    // 第二路证据是**相对判据**：比自己「腿伸直」时的基线近了 altDip 就算勾起来
    const altLine = this.altMetric ? `${this.altMetric}≤base-${fmt(this.altDip)}` : '';
    return [
      { key: 'debug.diag.sides', value: `${one('L')} ${one('R')}` },
      { key: 'debug.diag.line', value: line },
      // 第二路证据单独一行（标签走 i18n，值里不写中文 —— 源码里不允许出现写死的中文）
      ...(altLine ? [{ key: 'debug.diag.lineAlt', value: altLine }] : []),
      // 死虫式：另一条腿必须留在桌面位（这条不满足时这一帧不会计次，所以单独摆出来）
      ...(this.otherHold
        ? [{
          key: 'debug.diag.otherHold',
          value: `${this.otherHold.cmp === 'gt' ? '≥' : '≤'}${fmt(this.otherHold.value)}`,
        }]
        : []),
      { key: 'debug.diag.side', value: this.sideNow || '—' },
      { key: 'debug.diag.lastSide', value: `${this.lastSide || '—'} ${this.lastAt ? `${Math.round(this._lastNow - this.lastAt)}ms` : ''}`.trim() },
      ...(this.lastReject ? [{ key: 'debug.diag.reject', reject: this.lastReject }] : []),
    ];
  }

  step(f, now) {
    const gate = GATES[this.gateName] || GATES.prone;
    this._lastFrame = f;    // 只给 diag() 看（面板要显示两条腿的读数）
    this._lastNow = now;
    const gated = !!gate(f);
    this.gateOk = gated;
    if (!gated) {
      this.active = false;
      this.standby = `status.need.${GATE_HINT[this.gateName] || 'prone'}`;
      this._badFrames += 1;
      if (this._badFrames > 25) this.cue('notReady', null, 'info', now, 9000);
      this.sideNow = null;
      this.sideSince = 0;
      this.sideOn.L = false;
      this.sideOn.R = false;
      this.sideStart.L = 0;
      this.sideStart.R = 0;
      this.depthPct = 0;
      return;
    }
    this._badFrames = 0;
    this.active = true;
    this.standby = '';

    const advise = ADVISORY[this.gateName];
    if (advise) advise(f, this, now);

    // 左右交替的判定要点（三轮打磨的结论，别再改回去）：
    //
    // ① **不要求另一条腿「几乎伸直」**。用户反馈「慢慢跳能识别，正常速度或快一点就计不上」：
    //    旧判据是「一侧在做（≤onValue）**且另一侧 ≥offValue**」，而真人原地快跳时支撑腿的膝盖
    //    根本不会绷直（实测 120°~140°），off 这一半几乎永远不成立 → 一次都计不上。
    //    现在只要求「另一侧**没有同时在勾**」——这才是「交替」的本意。
    // ② **门槛要浅一点**（100° → 120°）：快节奏 + 动作模糊 + 采样 + 平滑会让**采样到的**
    //    最小膝角比真实值浅 10~30°，100° 常常够不到。
    // ③ **计次走「进入在做」的上升沿**（countRises）：很快的勾腿**一帧就完成**，
    //    「保持 25ms 才计次」整轮抓不到；而「回到休息位再结算」在快节奏下也漏 ——
    //    勾完那条腿只回到 121°~126°，迟滞状态会「粘住」。上升沿只看这一帧有没有进到线内。
    // ④ 退出的线（offValue）只用于**显示**的迟滞状态与 700ms 超时，不参与计次。
    // ⚠️ 顺序：先用**上一帧的基线**判「在做」，再更新基线 —— 否则这一帧自己的读数会先把基线拉低，
    // 相对判据就永远差一点点够不到（经典的「自己把自己压下去」）。
    this.countRises(f, now);
    this.updateAltBase(f);
    this.updateSides(f, now);     // 只驱动深度条与 🐞 诊断行
    /**
     * 「现在有任意一条腿正在做」——进度条第一格用它点亮。
     *
     * 为什么不用「某一侧的膝角 ≤ onValue」当那一格的判据：配了第二路证据的动作（勾腿跳）
     * 可能是**靠第二路计的次**（快跳时膝角读数被压浅），那样会出现「链还没走完就已经计次」，
     * 正好违反「所有关键帧都做完才计次」这条约定。所以这一格直接用识别器自己的判定结果。
     */
    this.anyKicked = ['L', 'R'].some((s) => this.deepNow(f, s));

    const on = ['L', 'R'].filter((s) => this.sideOn[s]);
    const target = on.length === 1 ? on[0] : (on.length === 2 ? this.sideNow : null);
    this.depthPct = target ? 100 : 0;
    if (target) this.sideNow = target;
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
    /** 可选的「起始姿势」门控（坐姿体前屈在用）：认出来一次就锁存（见 startSeen） */
    this.startGateName = p.startGate || null;
  }

  onReset() {
    super.onReset();
    this.startSeen = false;
  }

  /**
   * 计数诊断（🐞 面板显示）：现在计到几秒、姿势门控过没过、起始姿势认出来没有。
   * 「起始姿势」那一行只有配了 `startGate` 的动作才显示（坐姿体前屈）。
   */
  diag() {
    return [
      { key: 'debug.diag.hold', value: `${(this.holdMs / 1000).toFixed(1)}s` },
      { key: 'debug.diag.pose', value: this.gateOk ? 'ok' : 'no' },
      ...(this.startGateName
        ? [{ key: 'debug.diag.startSeen', value: this.startSeen ? 'ok' : 'no' }]
        : []),
      ...(this.lastReject ? [{ key: 'debug.diag.reject', reject: this.lastReject }] : []),
    ];
  }

  checkHold(f) {
    /**
     * 「起始姿势」门控（坐姿体前屈：坐直、双腿伸直、髋角 ≈90°）—— 认出来一次就**锁存**。
     *
     * 用户的模型是「初始关键帧 = 侧对镜头坐好 → 前折」，所以前折必须**从坐好开始**：
     * 没认到过起始姿势就先不计时，并提示「先坐直坐好」（`notSeated`）。
     * 锁存之后身体前折不会把它取消 —— 进度条第一格「坐好」点亮后常亮，第二格「前折到位」才开始计时。
     */
    if (this.startGateName) {
      const startGate = GATES[this.startGateName];
      if (startGate && startGate(f)) this.startSeen = true;
      if (!this.startSeen) {
        this.gateOk = false;
        this.depthPct = 0;
        return { valid: false, reason: 'notSeated' };
      }
    }
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
