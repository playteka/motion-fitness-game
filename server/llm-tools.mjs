/**
 * LLM 工具集（P3.3 自由对话）—— **和命令表 1:1，不另造一套**。
 *
 * 设计约束（改这个文件之前先读）：
 *   ① **intent 只有一处定义**：`src/voice/commands.js` 的 `COMMANDS`。
 *      这里每个工具用 `intents: [...]` 声明它对应哪几条 intent，`TOOLED_INTENTS` /
 *      `UNCOVERED_INTENTS` 由命令表**现算**（tests/test-voice.mjs 会核对：命令表里
 *      每一条 intent 都必须被某个工具覆盖，工具映射到的 intent 也必须真的存在）。
 *   ② **工具只把参数翻译成 `{ intent, args }`**，真正的执行仍然走
 *      `session.js` → `COMMANDS[].run(ctx, args)`（P3.2 的同一批 handler），这里不碰任何 state。
 *   ③ **中文 + 英文描述**：既给模型看（function calling 的 description），
 *      也用于「你能做什么」这类回答（`toolHelpRows()`）。
 *   ④ **安全**：`exit_workout` **不再要求 `confirm`**（用户要求「说退出就退出」✓）：
 *      模型照旧带 `confirm:true` 也好、没带也好，都会直接产生退出动作，**不会再问用户一遍**。
 *      服务端不再有「需要确认的工具」→ 旧的 `CONFIRM_PROMPT` 兜底话术已删除；
 *      通用确认机制仍保留在会话层（`session.js` 的 `pendingConfirm`），留给以后需要确认的动作。
 *
 * 动作 id 也不在这里抄：`start_workout` 的枚举直接来自 `src/catalog.js` 的 `EXERCISES`。
 */

import { COMMANDS } from '../src/voice/commands.js';
import { EXERCISES, EXERCISE_MAP } from '../src/catalog.js';

/** 下拉式参数的可选值（和界面上那几处一一对应，改一处记得改这里） */
export const NAV_DESTS = Object.freeze(['home', 'menu', 'back', 'next', 'prev']);
export const PANEL_WHICH = Object.freeze(['settings', 'records', 'best', 'exerciseSettings']);
export const CATEGORY_IDS = Object.freeze(['upper', 'lower', 'core', 'full', 'stretch']);
export const LANGS = Object.freeze(['zh', 'en']);

/** 动作 id 列表（工具 schema 的枚举；来自动作库，不另抄） */
export const EXERCISE_IDS = Object.freeze(EXERCISES.map((e) => e.id));

/** 一次回答里最多执行几个工具（护栏：防止模型一口气把界面拆了） */
export const MAX_TOOL_CALLS = 3;

/** 模型只给了工具、没给文字时的兜底短句（会被 TTS 念出来，必须很短） */
export const ACTION_REPLY = Object.freeze({
  zh: '好，这就办。',
  en: 'Done.',
});

/** 模型什么都没给（既没文字也没工具）时的兜底 */
export const EMPTY_REPLY = Object.freeze({
  zh: '这句我没听懂，换个说法再说一次？',
  en: "I didn't catch that — can you say it another way?",
});

/** 参数 schema 的小工具：properties + required 都是手写的，读起来比嵌套对象清楚 */
function schema(properties = {}, required = []) {
  const out = { type: 'object', properties, additionalProperties: false };
  if (required.length) out.required = required;
  return out;
}

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const oneOf = (description, values) => ({ type: 'string', description, enum: [...values] });

/**
 * 工具定义表。
 *
 * 字段：
 *   name       工具名（给模型看的 snake_case）
 *   intents    对应命令表里的 intent（可以一对多，例如 navigate 覆盖 5 条）
 *   zh / en    一句中文 / 英文描述
 *   parameters JSON Schema
 *   map(args)  → { intent, args } 或 { refused: 'bad-args' | ... }
 */
export const LLM_TOOL_DEFS = Object.freeze([
  /* ---------------- 训练 ---------------- */
  Object.freeze({
    name: 'start_workout',
    intents: ['startWorkout'],
    zh: '开始训练；可以顺便指定动作（exerciseId）和目标（target）。',
    en: 'Start a workout, optionally with an exercise and a target.',
    parameters: schema({
      exerciseId: oneOf('动作 id / exercise id（留空 = 保持当前动作）', EXERCISE_IDS),
      target: int('目标：动作是次数，平板支撑 / 限时类是秒 / target: reps, or seconds for holds', {
        minimum: 1, maximum: 999,
      }),
    }),
    map(args) {
      const out = {};
      if (args.exerciseId !== undefined && args.exerciseId !== null && args.exerciseId !== '') {
        const id = resolveExerciseId(args.exerciseId);
        if (!id) return { refused: 'unknown-exercise' };
        out.exerciseId = id;
      }
      const target = toInt(args.target);
      if (target !== null) out.value = target;
      return { intent: 'startWorkout', args: out };
    },
  }),
  Object.freeze({
    name: 'pause',
    intents: ['pause'],
    zh: '暂停当前这一组。',
    en: 'Pause the current set.',
    parameters: schema(),
    map: () => ({ intent: 'pause', args: {} }),
  }),
  Object.freeze({
    name: 'resume',
    intents: ['resume'],
    zh: '继续刚才暂停的那一组。',
    en: 'Resume the paused set.',
    parameters: schema(),
    map: () => ({ intent: 'resume', args: {} }),
  }),
  Object.freeze({
    name: 'exit_workout',
    intents: ['exit'],
    zh: '退出当前这一组（**直接退出，不再问一遍**）。',
    en: 'Leave the current set right away (no extra confirmation).',
    /**
     * `confirm` 只为兼容系统提示词里「带 confirm:true」的写法保留：可选、可省略，
     * 服务端**不再**据此拦截。说退出就退出（用户要求）。
     */
    parameters: schema({
      confirm: bool('兼容字段，可省略；服务端不再据此拦截 / optional and ignored'),
    }),
    map: () => ({ intent: 'exit', args: {} }),
  }),
  Object.freeze({
    name: 'retry_set',
    intents: ['retrySet'],
    zh: '再来一组（计数清零并重新开始）。',
    en: 'Retry this set from scratch.',
    parameters: schema(),
    map: () => ({ intent: 'retrySet', args: {} }),
  }),
  Object.freeze({
    name: 'next_exercise',
    intents: ['nextExercise'],
    zh: '换成动作库里的下一个动作。',
    en: 'Switch to the next exercise in the library.',
    parameters: schema(),
    map: () => ({ intent: 'nextExercise', args: {} }),
  }),

  /* ---------------- 目标 ---------------- */
  Object.freeze({
    name: 'set_target',
    intents: ['setTarget'],
    zh: '把目标设成一个具体数字（次数或秒数，按当前动作的单位）。',
    en: 'Set the target to an exact number (reps, or seconds for holds).',
    parameters: schema({ value: int('目标值 / target value', { minimum: 1, maximum: 999 }) }, ['value']),
    map(args) {
      const value = toInt(args.value);
      if (value === null || value < 1) return { refused: 'bad-args' };
      return { intent: 'setTarget', args: { value } };
    },
  }),
  Object.freeze({
    name: 'adjust_target',
    intents: ['adjustTarget'],
    zh: '在当前目标上加减一个数（减少用负数，例如 -10）。',
    en: 'Adjust the target by a delta (negative to reduce, e.g. -10).',
    parameters: schema({ delta: int('加减多少 / delta (negative = reduce)', { minimum: -999, maximum: 999 }) }, ['delta']),
    map(args) {
      const delta = toInt(args.delta);
      if (delta === null || delta === 0) return { refused: 'bad-args' };
      return { intent: 'adjustTarget', args: { delta } };
    },
  }),

  /* ---------------- 导航 / 面板 ---------------- */
  Object.freeze({
    name: 'navigate',
    intents: ['home', 'menu', 'back', 'next', 'prev'],
    zh: '界面导航：home 回首页 / menu 打开手势菜单 / back 返回上一层 / next·prev 菜单翻页。',
    en: 'Navigate: home, open the menu, go back one level, or flip menu pages.',
    parameters: schema({ dest: oneOf('去哪里 / where to go', NAV_DESTS) }, ['dest']),
    map(args) {
      const dest = String(args.dest || '');
      if (!NAV_DESTS.includes(dest)) return { refused: 'bad-args' };
      return { intent: dest, args: {} };
    },
  }),
  Object.freeze({
    name: 'open_panel',
    intents: ['openSettings', 'openRecords', 'openBest', 'openExerciseSettings'],
    zh: '打开面板：settings 设置 / records 训练记录 / best 最佳成绩 / exerciseSettings 运动设定。',
    en: 'Open a panel: settings, records, best scores, or exercise settings.',
    parameters: schema({ which: oneOf('哪个面板 / which panel', PANEL_WHICH) }, ['which']),
    map(args) {
      const which = String(args.which || '');
      const intent = { settings: 'openSettings', records: 'openRecords', best: 'openBest', exerciseSettings: 'openExerciseSettings' }[which];
      if (!intent) return { refused: 'bad-args' };
      return { intent, args: {} };
    },
  }),

  /* ---------------- 语音 / 语言 ---------------- */
  Object.freeze({
    name: 'set_voice',
    intents: ['mute', 'unmute'],
    zh: '教练要不要出声：mute=true 只出字幕，mute=false 恢复朗读。',
    en: 'Coach speech on/off: mute=true shows subtitles only; false restores speech.',
    parameters: schema({ mute: bool('true = 只出字幕 / subtitles only') }, ['mute']),
    map(args) {
      if (typeof args.mute !== 'boolean') return { refused: 'bad-args' };
      return { intent: args.mute ? 'mute' : 'unmute', args: {} };
    },
  }),
  Object.freeze({
    name: 'switch_language',
    intents: ['switchLang'],
    zh: '切换界面语言（zh 中文 / en English）。',
    en: 'Switch the UI language (zh / en).',
    parameters: schema({ lang: oneOf('语言 / language', LANGS) }, ['lang']),
    map(args) {
      const lang = String(args.lang || '');
      if (!LANGS.includes(lang)) return { refused: 'bad-args' };
      return { intent: 'switchLang', args: { lang } };
    },
  }),
  Object.freeze({
    name: 'stop_listening',
    intents: ['stopListening'],
    zh: '关闭 AI 教练（等于按 Ctrl+I 关，麦克风也会释放）。',
    en: 'Turn the AI coach off (same as Ctrl+I; releases the microphone).',
    parameters: schema(),
    map: () => ({ intent: 'stopListening', args: {} }),
  }),

  /* ---------------- 查询 / 帮助 ---------------- */
  Object.freeze({
    name: 'report_progress',
    intents: ['reportProgress'],
    zh: '把当前次数 / 秒数 / 分数**念给用户听**。只在用户明确要求「报一下 / 说给我听」时用；'
      + '问「做得怎么样 / 哪里没做好」时请直接用 state 里的数字回答，不要调这个工具。',
    en: 'Read the current reps / hold seconds / score **aloud**. Only when the user explicitly asks you to read it out; '
      + 'for "how did I do / what was wrong" answer directly from the state instead of calling this tool.',
    parameters: schema(),
    map: () => ({ intent: 'reportProgress', args: {} }),
  }),
  Object.freeze({
    name: 'help',
    intents: ['help'],
    zh: '打开「我能说什么」语音命令一览。',
    en: 'Open the list of voice commands the coach understands.',
    parameters: schema(),
    map: () => ({ intent: 'help', args: {} }),
  }),

  /* ---------------- 菜单里的分类 / 序号（快车道剩下的两条也覆盖上） ---------------- */
  Object.freeze({
    name: 'pick_category',
    intents: ['category'],
    zh: '进入一个动作分类：upper 上肢 / lower 下肢 / core 核心 / full 全身 / stretch 拉伸。',
    en: 'Open an exercise category: upper, lower, core, full, stretch.',
    parameters: schema({ category: oneOf('哪个分类 / which category', CATEGORY_IDS) }, ['category']),
    map(args) {
      const category = String(args.category || '');
      if (!CATEGORY_IDS.includes(category)) return { refused: 'bad-args' };
      return { intent: 'category', args: { category } };
    },
  }),
  Object.freeze({
    name: 'pick_index',
    intents: ['pick'],
    zh: '选中手势菜单里的第 N 个（position 从 1 开始，例如 3 = 第三个）。',
    en: 'Pick the Nth item in the gesture menu (1-based, e.g. 3 = the third).',
    parameters: schema({ position: int('第几个（从 1 开始）/ 1-based position', { minimum: 1, maximum: 99 }) }, ['position']),
    map(args) {
      const position = toInt(args.position);
      if (position === null || position < 1) return { refused: 'bad-args' };
      // 命令表的 pick 用 0 基下标（parse.js 的「第三个」→ index 2）
      return { intent: 'pick', args: { index: position - 1 } };
    },
  }),
]);

/** 工具名 → 定义（一处查表） */
export const TOOL_BY_NAME = Object.freeze(
  Object.fromEntries(LLM_TOOL_DEFS.map((t) => [t.name, t])),
);

/** 工具名 → 覆盖的 intent 列表（测试据此核对「一一对应」） */
export const TOOL_INTENT_MAP = Object.freeze(
  Object.fromEntries(LLM_TOOL_DEFS.map((t) => [t.name, Object.freeze([...t.intents])])),
);

/** 所有被工具覆盖到的 intent（去重、保持命令表顺序） */
export const TOOLED_INTENTS = Object.freeze(
  COMMANDS.map((c) => c.intent).filter((intent) => LLM_TOOL_DEFS.some((t) => t.intents.includes(intent))),
);

/** 命令表里有、但没有任何工具能触发的 intent（**必须是空数组**；有值就是漏了） */
export const UNCOVERED_INTENTS = Object.freeze(
  COMMANDS.map((c) => c.intent).filter((intent) => !TOOLED_INTENTS.includes(intent)),
);

/** 工具里写了、命令表里却不存在的 intent（**必须是空数组**；有值就是写错了名字） */
export const UNKNOWN_TOOLED_INTENTS = Object.freeze(
  [...new Set(LLM_TOOL_DEFS.flatMap((t) => t.intents))]
    .filter((intent) => !COMMANDS.some((c) => c.intent === intent)),
);

/** OpenAI 风格的工具描述（直接塞进 chat/completions 的 `tools` 字段） */
export const LLM_TOOLS = Object.freeze(LLM_TOOL_DEFS.map((t) => Object.freeze({
  type: 'function',
  function: Object.freeze({
    name: t.name,
    description: `${t.zh} / ${t.en}`,
    parameters: t.parameters,
  }),
})));

/** 「我能做什么」用的数据行（中文 / 英文 / 覆盖的 intent；界面或测试都能直接用） */
export function toolHelpRows() {
  return LLM_TOOL_DEFS.map((t) => ({
    name: t.name,
    zh: t.zh,
    en: t.en,
    intents: [...t.intents],
  }));
}

/** 把 `"30"` / `30.7` / `30` 统一成整数；不是数字就返回 null（不猜） */
function toInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : null;
}

/**
 * 动作 id 归一化：模型有时会照中文名写（「平板支撑」），有时写 id。
 * 只认 catalog 里的 id（大小写不敏感）；认不出返回 null。
 */
export function resolveExerciseId(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  if (EXERCISE_MAP[raw]) return raw;
  const lower = raw.toLowerCase();
  const hit = EXERCISE_IDS.find((id) => id.toLowerCase() === lower);
  return hit || null;
}

/**
 * tool_calls → `{ intent, args }` 动作列表。
 *
 * @param {Array<{name:string,args:object}>} toolCalls 模型返回的工具调用
 * @param {object} [opts]
 * @param {'zh'|'en'} [opts.locale='zh'] 保留参数（当前没有需要 locale 的拒绝话术）
 * @returns {{ actions: Array<{intent:string,args:object}>,
 *            refusals: Array<{name:string,reason:string}>,
 *            prompts: string[] }} prompts 目前恒为空（没有工具需要二次确认），字段保留给以后
 */
export function actionsFromToolCalls(toolCalls, { locale = 'zh' } = {}) {
  void locale;   // 兼容旧调用；拒绝话术已全部走通用兜底
  const actions = [];
  const refusals = [];
  const prompts = [];
  const list = Array.isArray(toolCalls) ? toolCalls.slice(0, MAX_TOOL_CALLS) : [];
  for (const call of list) {
    const name = call && call.name ? String(call.name) : '';
    const def = TOOL_BY_NAME[name];
    if (!def) { refusals.push({ name: name || '(empty)', reason: 'unknown-tool' }); continue; }
    const args = call && call.args && typeof call.args === 'object' && !Array.isArray(call.args)
      ? call.args
      : {};
    let mapped = null;
    try {
      mapped = def.map(args);
    } catch {
      mapped = { refused: 'bad-args' };
    }
    if (!mapped || (mapped.refused && !mapped.intent)) {
      refusals.push({ name, reason: (mapped && mapped.refused) || 'bad-args' });
      continue;
    }
    if (!mapped.intent || !COMMANDS.some((c) => c.intent === mapped.intent)) {
      refusals.push({ name, reason: 'unknown-intent' });
      continue;
    }
    actions.push({ intent: mapped.intent, args: mapped.args && typeof mapped.args === 'object' ? mapped.args : {} });
  }
  return { actions, refusals, prompts };
}

/** 把当前 state 快照压成一段短 JSON（提示词用；过长就截断，绝不把整份 state 塞给模型） */
export function compactContext(context, { maxChars = 6000 } = {}) {
  const src = context && typeof context === 'object' ? context : {};
  let text = '';
  try {
    text = JSON.stringify(src);
  } catch {
    text = '{}';
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/**
 * 系统提示词（给模型看的那一段）。
 *
 * 内容刻意**短**：模型只需要知道「你是谁、怎么说话、能调工具、现在用户在哪 + 在做什么状态」，
 * 具体工具说明由 function calling 的 schema 提供（LLM_TOOLS）。
 *
 * ⚠️ 用户的硬要求（P3.3 Agent 化）：`context` 里的**数字全部由客户端算好**，
 * 模型只负责解释与决策，**不许自己编数字** ✗。
 */
export function buildSystemPrompt({ locale = 'zh', context = null, maxContextChars = 6000 } = {}) {
  const lang = locale === 'en' ? 'en' : 'zh';
  const state = compactContext(context, { maxChars: maxContextChars });
  return [
    '你是「体感健身游戏」里的 AI 教练。用户说的话来自语音识别，可能有口误或同音字。',
    'You are the AI coach inside a motion fitness game. User text comes from streaming speech recognition and may contain mishearings.',
    '',
    'Agent 行为准则 / Agent rules:',
    '1. 你能看到用户此刻在做什么、做得怎么样（state 里的 now / session / performance / history / signals）。',
    '2. state 里的数字都是客户端算好的事实（分数 / 次数 / 命中率 / 趋势）。回答要引用**真实数字**，不许自己编 ✗。',
    '   Never invent numbers: quote now/session/performance/history/signals only.',
    '3. 想改变界面或训练状态就调用工具（tools），不要只在嘴上说「已经改了」。',
    '   Call a tool to actually change state; do not claim you did it without calling one.',
    '4. 不确定就直接问一句（「你是想调低目标，还是换动作？」），不要猜。',
    '   If unsure, ask a short clarifying question instead of guessing.',
    '5. 训练中话要短：一句话，口语，不超过 40 字；不要 Markdown / 列表 / emoji（会被 TTS 念出来）。',
    '   Keep it to one short spoken sentence (no markdown / lists / emoji).',
    '6. 用户问「刚才哪里没做好 / 这组怎么样」时：直接用 performance.keyframes / signals.keyframeHitRate 里的数字回答，'
      + '**不要**调 report_progress（那是「念给我听」才用的）。',
    '   For "how did I do / what went wrong", answer from performance / signals directly; do not call report_progress.',
    '7. 用户说退出就**直接退出**（exit_workout，带 confirm:true），不要再问一遍 ✗。',
    '   When the user asks to exit, call exit_workout with confirm:true right away; do not ask again.',
    '8. 一次最多调用 3 个工具；改完目标不需要再调一次 report_progress。',
    `9. 用用户的语言回答 / Answer in: ${lang === 'en' ? 'English' : '中文'}。`,
    '',
    `state (JSON): ${state}`,
  ].join('\n');
}

export default {
  LLM_TOOL_DEFS,
  LLM_TOOLS,
  TOOL_BY_NAME,
  TOOL_INTENT_MAP,
  TOOLED_INTENTS,
  UNCOVERED_INTENTS,
  UNKNOWN_TOOLED_INTENTS,
  MAX_TOOL_CALLS,
  ACTION_REPLY,
  EMPTY_REPLY,
  actionsFromToolCalls,
  buildSystemPrompt,
  compactContext,
  resolveExerciseId,
  toolHelpRows,
};
