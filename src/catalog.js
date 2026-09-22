/**
 * 动作库（分类目录）。
 *
 * 一个动作 = 一条配置。识别逻辑本身在 engines.js（配置驱动的通用引擎），
 * 只有最经典的几个动作保留专门写的识别器（engine: 'builtin'，判定最精细）。
 *
 * 每条配置的字段：
 *   id          唯一 id，也是 i18n 键 `ex.<id>.*` 的前缀
 *   icon        图标（emoji，主页与动作页都用它）
 *   cats        所属分类（一个动作可以属于多个分类，例如 ['lower','full'] 就会在两块里出现）
 *   kind        'rep'（计数）| 'hold'（计时）
 *   seconds     限时计数的时长（秒）。>0 时这个动作变成**「限时计数」**：
 *               这一组固定跑 N 秒（`target` 也按秒解释），时间到自动结算；
 *               次数照旧按关键帧一格一格计 —— 成绩就是「这段时间里完成了多少次」。
 *               为 0（默认）= 普通计数，做到目标次数才结束。
 *   engine      'builtin' | 'bend' | 'alt' | 'twist' | 'sequence' | 'hold'
 *   plan        计分方案（steps.js 里的 STEP_PLANS 键）
 *   view        校准要求：'front' 正对镜头 | 'side' 侧对镜头
 *   posture     校准轮廓形态：stand / prone / supine / side / seated
 *   judge       判定依据（界面显示的小字，i18n 键 judge.*）
 *   target      默认目标（次数 / 秒；限时计数类是秒）
 *   params      引擎参数（见 engines.js 顶部注释）
 *   rough       true = 摄像头只能粗略判定（界面会写明「粗略判定」，README 也有说明）
 */

/* ------------------------------------------------------------------ *
 * 分类
 * ------------------------------------------------------------------ */

export const CATEGORIES = [
  { id: 'upper', icon: '💪', key: 'cat.upper' },
  { id: 'lower', icon: '🦵', key: 'cat.lower' },
  { id: 'core', icon: '🔥', key: 'cat.core' },
  { id: 'full', icon: '🤸', key: 'cat.full' },
  { id: 'stretch', icon: '🧘', key: 'cat.stretch' },
];

export const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

/* ------------------------------------------------------------------ *
 * 常用参数（引擎默认值，动作条目里只写差异）
 * ------------------------------------------------------------------ */

const REP = 'ui.repsUnit';
const SEC = 'ui.secondsUnit';

/** 通用「屈伸一次」参数：up = 起始位置的值，down = 到位时的值，progress = (up-v)/(up-down) */
const bend = (opts) => ({
  enterP: 0.32,     // 进入「正在做」的进度
  bottomP: 0.85,    // 算「到位」的进度
  backP: 0.16,      // 回到起始（这一轮结束）
  looseP: 0.55,     // 宽松模式：做到这个进度就算一次
  ignoreP: 0.45,    // 低于这个进度只当是晃了一下，不出声也不计数
  minRepMs: 380,
  ...opts,
});

const e = (id, icon, cats, opts) => ({
  id,
  icon,
  cats: Array.isArray(cats) ? cats : [cats],
  kind: opts.kind || 'rep',
  // 限时计数：这一组固定跑这么多秒（0 = 普通计数，做到目标次数为止）
  seconds: Math.max(0, Math.round(opts.seconds || 0)),
  // 计时类默认走 hold 引擎，计数类默认走 bend 引擎（需要别的引擎时显式写 engine）
  engine: opts.engine || (opts.kind === 'hold' ? 'hold' : 'bend'),
  plan: opts.plan || (opts.kind === 'hold' ? 'holdPose' : 'repStand'),
  view: opts.view || 'side',
  posture: opts.posture || 'stand',
  judge: opts.judge || 'pose',
  target: opts.target || (opts.kind === 'hold' ? 30 : 12),
  unitKey: opts.kind === 'hold' ? SEC : REP,
  rough: !!opts.rough,
  // 语音报数的节奏：默认每做一个都报数；节奏很快的动作（开合跳）写 10 = 每 10 次才报一次
  // （用户反馈「动作太快，每次都报数根本听不清」）。同一个数字也用来降低「激励语」的频率。
  speakEvery: Math.max(1, opts.speakEvery || 1),
  params: opts.params || {},
});

/**
 * 是不是「限时计数」：计数类动作 + 配了秒数。
 * 这类动作**计次规则完全不变**（还是按关键帧一格一格来），只是「什么时候算完成」
 * 从「做到目标次数」换成「时间到」——成绩 = 这段时间里完成了几次。
 */
export const isTimedReps = (meta) => !!meta && meta.kind !== 'hold' && (meta.seconds || 0) > 0;

/** 这个动作的目标是以什么为单位：计时类与限时计数类是「秒」，其余是「次」 */
export const targetUnitKey = (meta) => (meta.kind === 'hold' || isTimedReps(meta) ? SEC : REP);

/* ------------------------------------------------------------------ *
 * 动作库：上肢 3 / 下肢 6 / 核心 6 / 全身 5 / 拉伸 2（共 22 个动作）
 * （「弓步跳」已按用户要求删除）
 * ------------------------------------------------------------------ */

export const EXERCISES = [
  /* ================= 上肢 ================= */
  e('pushup', '💪', 'upper', {
    engine: 'builtin', plan: 'pushup', posture: 'prone', judge: 'elbow', target: 12,
  }),
  e('pushupWide', '↔️', 'upper', {
    plan: 'repProne', posture: 'prone', judge: 'elbow', target: 12,
    params: bend({ metric: 'elbow', gate: 'prone', up: 152, down: 118, minRepMs: 340 }),
  }),
  e('pushupDiamond', '💎', 'upper', {
    plan: 'repProne', posture: 'prone', judge: 'elbow', target: 10,
    params: bend({ metric: 'elbow', gate: 'prone', up: 152, down: 110, minRepMs: 340 }),
  }),

  /* ================= 下肢 ================= */
  e('squat', '🏋️', 'lower', {
    engine: 'builtin', plan: 'squat', view: 'front', posture: 'stand', judge: 'knee', target: 15,
  }),
  e('squatSumo', '🤼', 'lower', {
    plan: 'repStand', view: 'front', posture: 'stand', judge: 'knee', target: 15,
    params: bend({ metric: 'kneeBent', gate: 'standWide', up: 168, down: 95, minRepMs: 480 }),
  }),
  e('lunge', '🚶', 'lower', {
    engine: 'builtin', plan: 'lunge', posture: 'stand', judge: 'knee', target: 16,
  }),
  e('lungeBack', '↩️', 'lower', {
    plan: 'repStand', posture: 'stand', judge: 'knee', target: 16,
    // 向后箭步蹲（通用屈伸引擎）：up = 站直读数、down = 沉到底读数。
    // 用户反馈「前后箭步蹲都太灵敏了，后面几个关键帧对膝盖弯曲的要求可以更大一些」——
    // 所以把**跟膝盖弯曲有关的那两格**收紧（进度 = (up − v)/(up − down)，越大越深）：
    //   ③ 计次   looseP 0.55 → 0.70（前膝 ≈ 123° 以内，到半程箭步蹲才计次）
    //   满分深度 bottomP 0.85 → 0.92（≈ 110°）
    // ② 开始（enterP 0.32）和 ⑤ 回位（backP 0.16）不动：那两格说的不是「膝盖弯多少」，
    // 动回位线只会把每一轮拖长，还会和「太快了」的节奏判定打架。
    params: bend({
      metric: 'kneeBent', gate: 'stand', up: 165, down: 105,
      looseP: 0.70, bottomP: 0.92, minRepMs: 520,
    }),
  }),
  e('bridge', '🌉', 'lower', {
    engine: 'builtin', plan: 'bridge', posture: 'supine', judge: 'rise', target: 15,
  }),
  e('squatJump', '🚀', 'full', {
    // 用户要求：深蹲跳从「下肢」移到「全身」（全身现在 5 个：深蹲跳 / 波比跳 / 登山者 / 开合跳 / 跳箱）
    plan: 'jump', view: 'front', posture: 'stand', judge: 'flight', target: 12,
    params: bend({ metric: 'kneeBent', gate: 'stand', up: 168, down: 100, flight: true, flightMin: 0.035, minRepMs: 420 }),
  }),
  e('buttKick', '🏃', 'lower', {
    // 勾腿跳（原地后勾腿 / 踢臀跳）：站姿左右交替，把脚跟往臀部勾。
    // 判据是**膝盖弯曲度**：勾起来的那条腿膝角很小（脚跟靠近臀部），放下去伸直就换边。
    // 左右交替交给 alt 引擎（和登山者、死虫式同一套），所以「左勾一次 + 右勾一次 = 1 次」。
    //
    // 参数按用户反馈调过两轮：
    //   ① 「动作比较快、识别不到位、没有及时计次」→ holdMs 60→25、minRepMs 180→110
    //   ② 「慢慢跳能识别，正常速度或快一点就计不上」→ 见下面 params 里的 onValue / offValue 说明
    engine: 'alt', plan: 'standAlt', posture: 'stand', judge: 'leg',
    // 用户要求：勾腿跳也改成**限时计数**（和开合跳同一套）—— 固定 60 秒，看能勾多少次。
    // `seconds` = 这一组的时间上限，`target` 按秒解释；计次规则不变（站好 → 勾一条腿 →
    // 换另一条腿也勾到，换边那一刻算一次）。
    seconds: 60, target: 60,
    // 同样节奏很快（一秒约两下）：**每 5 次报一次数**（用户要求），别每次都念
    speakEvery: 5,
    params: {
      // 门控用 standUpright（只看躯干竖直 + 肩高于髋，都**不依赖地面线**）：
      // 用户反馈「我明明站好了、躯干倾角只有几度，却总说我没站好」——
      // 普通 stand 门控还要求「膝离地 ≥0.28、髋离地 ≥0.55 倍躯干长」，这两个量以校准地面线为基准，
      // 地面线一旦偏了（脚出画 / 校准时没站到位）就会一直判不过。
      // ⚠️ 阈值按用户两轮反馈调过（100/135 → 112/122 → **120/126**）：
      //   onValue  「勾起来」的门槛。快节奏 + 动作模糊 + 采样 + 平滑滤波会让**采样到的**
      //            最小膝角比真实值浅不少（实测能差 10~30°）：100° 常常够不到 → 这一侧永远进不了
      //            「在做」状态、一次都计不上。120° 仍远小于慢跑/高抬腿慢跑（实测只下去 15°~31°，
      //            读数落在 145° 以上），所以「原地小跑、脚跟没勾起来」照样不计次（有测试钉住）。
      //   offValue 「这一侧做完了」的门槛，只比进入线高 6°（迟滞带）。旧值 135° 要求勾完那条腿
      //            回到 ≥135°，可快节奏时腿不会每次都伸直（采样停在 120~130°），于是这一侧一直
      //            被判成「还在做」，两条腿的迟滞状态互相锁死 —— 表现就是「慢跳能识别、快跳计不上」。
      // 引擎另外还有两条保险：① 交替只看「另一侧**没有同时在勾**」（不再要求另一条腿伸直）；
      // ② 一侧连续「在做」超过 700ms 就判它做完了。所以两侧不会真的锁死。
      gate: 'standUpright', metric: 'knee', cmp: 'lt',
      onValue: 120, offValue: 126, minRepMs: 110,
    },
  }),

  /* ================= 核心 ================= */
  e('plank', '🧘', 'core', {
    engine: 'builtin', kind: 'hold', plan: 'plank', posture: 'prone', judge: 'time', target: 45,
  }),
  e('sidePlank', '🧎', 'core', {
    kind: 'hold', plan: 'holdPose', posture: 'side', judge: 'pose', target: 30, rough: true,
    params: { gate: 'sideLying' },
  }),
  e('deadBug', '🐞', 'core', {
    engine: 'alt', plan: 'repAlt', posture: 'supine', judge: 'leg', target: 16,
    // 「进入在做」= 腿伸出去（膝角 ≥150°），「退出」 110 → **125**：
    // 和勾腿跳同一条经验（见那边的注释）—— 腿收回来时不会每次都弯到 110°，
    // 退出线太紧会让两侧状态锁死、后面的次数都计不上；150° 的进入线没动。
    params: { gate: 'supineLow', metric: 'knee', cmp: 'gt', onValue: 150, offValue: 125, minRepMs: 400 },
  }),
  e('crunch', '🌀', 'core', {
    plan: 'repSupine', posture: 'supine', judge: 'clear', target: 20,
    params: bend({ metric: 'shoulderClear', gate: 'supine', up: 0.20, down: 0.62, minRepMs: 340 }),
  }),
  e('reverseCrunch', '🔃', 'core', {
    plan: 'repSupine', posture: 'supine', judge: 'hip', target: 15,
    // 反向卷腹是「骨盆卷起、大腿转向胸口」：同样用髋角（躯干-大腿夹角）量，
    // 但起始是屈膝桌面位（≈90°），卷到最上面 ≈60°；坐着/躺着不动时夹角更大，不会乱计数。
    params: bend({ metric: 'hip', gate: 'supine', up: 92, down: 62, minRepMs: 340 }),
  }),
  e('lyingLegRaise', '🦿', 'core', {
    plan: 'repSupine', posture: 'supine', judge: 'hip', target: 15,
    // 仰卧抬腿：**判据就是髋关节的角度**（腿和上身的夹角，hip）。
    //   躺平、腿伸直贴地 ≈ 180°；腿绷直抬到垂直地面 ≈ 90°；放下来回到 ≈ 180°，如此循环。
    //   up=180（起始，跟着用户自己躺平的角度自校准）/ down=90（抬到垂直）。
    //   用户要求「髋关节大概到 90° 就可以计次，不要太严格」→ 计数线放在 105°（离垂直 15° 以内都算），
    //   满分深度 95°（基本垂直）；「腿放平接近 180° 就能开始下一次，也不要太严格」→ 回位线放到 158°
    //   （离躺平还有 22° 就算回到起始位，不会因为没完全放平而不结算）。
    //   姿势要求同样放宽（用户要求）：门控用 supineFlat —— **只看「肩离地高度 ≤ 0.6×躯干长」**，
    //   删掉了「躯干倾角 ≥ 36°」（死虫式仍旧用 supineLow 那条两条都看的门控）。
    params: bend({
      metric: 'hip', gate: 'supineFlat', up: 180, down: 90,
      enterP: 0.32, looseP: 0.83, bottomP: 0.94, backP: 0.24, ignoreP: 0.45, minRepMs: 400,
    }),
  }),

  /* ================= 全身 ================= */
  e('burpee', '💥', 'full', {
    engine: 'sequence', plan: 'sequence', view: 'front', posture: 'stand', judge: 'sequence', target: 10,
    params: {
      stages: ['stand', 'crouch', 'plank', 'jump'], windowMs: 9000, minRepMs: 900,
    },
  }),
  e('mountainClimber', '⛰️', 'full', {
    engine: 'alt', plan: 'repAlt', posture: 'prone', judge: 'leg', target: 24,
    // 退出线 140 → 125：和勾腿跳同一个道理（见那边的注释）—— 快节奏时腿收回去不会每次都绷直，
    // 退出线太高会让两侧的迟滞状态互相锁死、后面都计不上。
    // 「进入在做」的线（膝角 ≤105°）没动，所以「只是撑住不动」不会被算进来。
    params: { gate: 'prone', metric: 'knee', cmp: 'lt', onValue: 112, offValue: 124, minRepMs: 200 },
  }),
  e('jumpingJack', '🙌', 'full', {
    plan: 'jumpingJack', view: 'front', posture: 'stand', judge: 'spread',
    // 用户要求：开合跳改成**限时计数** —— 固定 60 秒，看这段时间里能跳多少次。
    // `seconds: 60` = 这一组的时间上限；`target: 60` 是同一件事（目标按秒算）。
    // 计次规则完全没动：还是「并拢 → 跳开 → 收回」三个关键帧一格一格走，走完一圈算一次，
    // 只是「什么时候结束」从「跳到目标次数」变成「时间到」。
    // 时长可以在 🎯 运动设定里改（30 / 45 / 60 / 90 / 120 秒）。
    seconds: 60, target: 60,
    // 动作节奏快、每次时间短：**每 5 次报一次数**（用户要求从 10 次改成 5 次），别每次都念
    speakEvery: 5,
    // 开合跳：正对镜头，用**双腿开合幅度**（legSpread = 膝间距与踝间距里更大的那个）量「开合」——
    // 引擎会按用户自己的最窄站距自校准，站得开的人也准。
    // up < down：progress = (最窄 − 当前) / (最窄 − 最宽)，所以并拢 = 0、开到最大 = 1。
    //
    // 用户反馈「开合跳跳了很多次一次都没计上、卡在第三关键帧」。原因是原来的判据太严：
    //   ① 只量膝盖 —— 真人跳开时脚张得比膝盖大得多，膝盖读数只有 0.8~0.9，而当时的计数线要求 0.98；
    //   ② 「最宽」参考值定在 1.5 倍躯干长（≈ 85cm 膝距），真人的开合跳到不了。
    // 现在改成「膝 / 踝取较大值」，参考区间收到 0.30 ~ 1.25，计数进度也一起放松：
    //   ② 打开 enterP 0.25（≈ 0.54 倍躯干长就点亮「打开」）
    //   ③ 计次 looseP 0.38（≈ 0.66 倍躯干长 —— 用户反馈 0.73 偏大，适度调小）
    //   满分深度 bottomP 0.80（≈ 1.06，真正跳到大开）
    //   收回 backP 0.25（回到自己最窄站距附近就算这一轮结束；要比要领「收回」那一格的
    //   0.45 更严，否则回位和计次会挤在同一帧上）
    //   最短一轮 400ms（真人开合跳一轮约 0.6~1.0 秒，400ms 以下只当是抖了一下）
    //   关键帧只留三格（用户要求）：并拢站好 → 跳开（计次）→ 收回，中间那一格「开始」
    //   在这么快的节奏里一闪而过、没有信息量，靠 `skipEnter` 去掉（见 specs.js）。
    params: bend({
      metric: 'legSpread', gate: 'stand', up: 0.30, down: 1.25,
      enterP: 0.25, looseP: 0.38, bottomP: 0.80, ignoreP: 0.30, backP: 0.25, minRepMs: 400,
      skipEnter: true,
    }),
  }),
  e('boxJump', '🦘', 'full', {
    plan: 'jump', view: 'front', posture: 'stand', judge: 'flight', target: 10, rough: true,
    // 跳箱（粗略判定）：判据是「整个人离地」。离地门槛从 0.05 收到 **0.035**
    // （用户反馈「离地高度 ≥ 0.05×画面高可能还是大了，稍微再调小一点」）——
    // 现在和深蹲跳用的是同一条线，跳箱本来跳得就没那么高，再叠加校准地面线的误差，0.05 容易判不到。
    params: bend({ metric: 'kneeBent', gate: 'stand', up: 168, down: 100, flight: true, flightMin: 0.035, minRepMs: 500 }),
  }),
  // 「弓步跳（跳跃箭步蹲）」已按用户要求删除 —— 动作库现在 22 个动作（全身 5 个）。

  /* ================= 拉伸（计时，判定的是「姿势到位」） ================= */
  e('standingForwardFold', '🙇', 'stretch', {
    kind: 'hold', plan: 'stretchHold', posture: 'stand', judge: 'pose', target: 30,
    params: { gate: 'standFold' },
  }),
  e('seatedForwardFold', '🧎‍♂️', 'stretch', {
    kind: 'hold', plan: 'stretchHold', posture: 'seated', judge: 'pose', target: 30,
    params: { gate: 'seatedFold' },
  }),
];

export const EXERCISE_MAP = Object.fromEntries(EXERCISES.map((x) => [x.id, x]));

/** 某个分类下的动作（保持目录顺序） */
export function exercisesInCategory(catId) {
  return EXERCISES.filter((x) => x.cats.includes(catId));
}

export default { EXERCISES, EXERCISE_MAP, CATEGORIES, CATEGORY_MAP, exercisesInCategory };
