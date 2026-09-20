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
 *   engine      'builtin' | 'bend' | 'alt' | 'twist' | 'sequence' | 'hold'
 *   plan        计分方案（steps.js 里的 STEP_PLANS 键）
 *   view        校准要求：'front' 正对镜头 | 'side' 侧对镜头
 *   posture     校准轮廓形态：stand / prone / supine / side / seated
 *   judge       判定依据（界面显示的小字，i18n 键 judge.*）
 *   target      默认目标（次数 / 秒）
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
  // 计时类默认走 hold 引擎，计数类默认走 bend 引擎（需要别的引擎时显式写 engine）
  engine: opts.engine || (opts.kind === 'hold' ? 'hold' : 'bend'),
  plan: opts.plan || (opts.kind === 'hold' ? 'holdPose' : 'repStand'),
  view: opts.view || 'side',
  posture: opts.posture || 'stand',
  judge: opts.judge || 'pose',
  target: opts.target || (opts.kind === 'hold' ? 30 : 12),
  unitKey: opts.kind === 'hold' ? SEC : REP,
  rough: !!opts.rough,
  params: opts.params || {},
});

/* ------------------------------------------------------------------ *
 * 动作库：上肢 3 / 下肢 6 / 核心 6 / 全身 5 / 拉伸 2（共 22 个动作）
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
    params: bend({ metric: 'kneeBent', gate: 'stand', up: 165, down: 105, minRepMs: 520 }),
  }),
  e('bridge', '🌉', 'lower', {
    engine: 'builtin', plan: 'bridge', posture: 'supine', judge: 'rise', target: 15,
  }),
  e('squatJump', '🚀', 'lower', {
    plan: 'jump', view: 'front', posture: 'stand', judge: 'flight', target: 12,
    params: bend({ metric: 'kneeBent', gate: 'stand', up: 168, down: 100, flight: true, flightMin: 0.035, minRepMs: 420 }),
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
    params: { gate: 'supineLow', metric: 'knee', cmp: 'gt', onValue: 150, offValue: 110, minRepMs: 400 },
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
    // 仰卧抬腿：**判据就是腰部的角度**（腿和上身的夹角，hip）。
    //   躺平、腿伸直贴地 ≈ 180°；腿绷直抬到垂直地面 ≈ 90°；放下来回到 ≈ 180°，如此循环。
    //   up=180（起始，跟着用户自己躺平的角度自校准）/ down=90（抬到垂直）。
    //   计数线松一点（looseP 0.65 ≈ 122°，腿抬过大约三分之二就算一次），
    //   满分深度线 0.85 ≈ 104°（基本垂直），分数照深度给 —— 和「大体做到就计次」一致。
    params: bend({
      metric: 'hip', gate: 'supineLow', up: 180, down: 90, looseP: 0.65, minRepMs: 400,
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
    params: { gate: 'prone', metric: 'knee', cmp: 'lt', onValue: 105, offValue: 140, minRepMs: 200 },
  }),
  e('jumpingJack', '🙌', 'full', {
    plan: 'jumpingJack', view: 'front', posture: 'stand', judge: 'spread', target: 50,
    // 开合跳：正对镜头，用**双膝横向距离**（kneeSpread）量「开合」——
    // 并拢站好 ≈ 0.35，跳开站宽 ≈ 1.5（引擎会按用户自己的最窄站距自校准，站得开的人也准）。
    // up < down：progress = (最窄 − 当前) / (最窄 − 最宽)，所以并拢 = 0、开到最大 = 1。
    params: bend({ metric: 'kneeSpread', gate: 'stand', up: 0.35, down: 1.5, minRepMs: 300 }),
  }),
  e('boxJump', '🦘', 'full', {
    plan: 'jump', view: 'front', posture: 'stand', judge: 'flight', target: 10, rough: true,
    params: bend({ metric: 'kneeBent', gate: 'stand', up: 168, down: 100, flight: true, flightMin: 0.05, minRepMs: 500 }),
  }),
  e('lungeJump', '⤴️', 'full', {
    plan: 'jump', posture: 'stand', judge: 'flight', target: 14,
    params: bend({ metric: 'kneeBent', gate: 'stand', up: 165, down: 110, flight: true, flightMin: 0.03, minRepMs: 380 }),
  }),

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
