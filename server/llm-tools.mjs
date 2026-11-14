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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMANDS } from '../src/voice/commands.js';
// 规则频道（rep 报数 / read 读秒）只在 src/voice/rules.js 定义一处，工具的枚举也读它
import { RULE_CHANNELS } from '../src/voice/rules.js';
import { EXERCISES, EXERCISE_MAP } from '../src/catalog.js';
// 记忆白名单只在一处定义（server/memory-store.mjs）：工具能写哪些字段、字段取值范围，
// 都由那边说了算，这里只负责把模型的参数翻译成「记忆操作」。
import { PREFS_FIELDS, FACTS_FIELDS } from './memory-store.mjs';

/** 下拉式参数的可选值（和界面上那几处一一对应，改一处记得改这里） */
export const NAV_DESTS = Object.freeze(['home', 'menu', 'back', 'next', 'prev']);
export const PANEL_WHICH = Object.freeze(['settings', 'records', 'best', 'exerciseSettings']);
export const CATEGORY_IDS = Object.freeze(['upper', 'lower', 'core', 'full', 'stretch']);
export const LANGS = Object.freeze(['zh', 'en']);
/** 规则频道（rep 报数间隔 / read 读秒间隔）—— 直接来自规则引擎的 `RULE_CHANNELS` */
export const RULE_KINDS = Object.freeze([...RULE_CHANNELS]);

/** 动作 id 列表（工具 schema 的枚举；来自动作库，不另抄） */
export const EXERCISE_IDS = Object.freeze(EXERCISES.map((e) => e.id));

/**
 * 会话开始事件（唯一字符串定义；`llm-provider.mjs` 从这里 re-export）。
 *
 * 用户原话：「进入全屏之后应该主动触发一个开始事件，发一个消息给 LLM，这样 AI 教练可以知道
 * 用户已经开始健身了，可以主动向用户问好。」
 *
 * 带这个事件时 `POST /llm` 的 `text` 可以为空 —— user 消息由服务端按 context 生成一条
 * 系统事件描述；system prompt 里另有一条事件规则（见 buildSystemPrompt 第 16 条）。
 */
export const LLM_EVENT_SESSION_START = 'session-start';

/** 一次回答里最多执行几个工具（护栏：防止模型一口气把界面拆了） */
export const MAX_TOOL_CALLS = 3;

/* ------------------------------------------------------------------ *
 * 教练人设：`SOUL.md` 是**唯一来源**（一处定义）
 *
 *   SOUL.md（仓库根目录）→ buildSystemPrompt() 的**前半部分**
 *   → 后面才接「运行规则 / 当前记忆 / state」。
 *
 * 约束：
 *   ① 模块加载时读一次并缓存（`readSoul()`）；文件缺失 / 读失败 → 内置精简兜底人设，只 warn 一条，
 *      **绝不因为少一个 md 就崩**；
 *   ② `SOUL_PATH` 环境变量可覆盖路径（测试用临时文件）；
 *   ③ 超过 12000 字符就截断并 warn（防止有人误贴大文件把 token 撑爆）。
 * ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 默认人设文件：仓库根目录的 `SOUL.md` */
export const DEFAULT_SOUL_PATH = path.resolve(HERE, '..', 'SOUL.md');

/** 人设最多 12000 字符（超出截断；中文约 12000 token 以内，不会撑爆上下文） */
export const SOUL_MAX_CHARS = 12000;

/** 读不到 SOUL.md 时的精简兜底人设（仍然叫可可教练；不抛错、不空提示词） */
export const FALLBACK_SOUL = [
  '# 可可教练 / Coach KK（内置兜底人设）',
  '你叫可可教练（Coach KK），是一名 AI 健身教练。你陪用户「动起来」，并且一直动下去。',
  '性格：元气阳光、专业靠谱、温柔坚定、有点小幽默、有分寸感；性别中立的内核，换的是声音与形象，不换的是陪你动起来的心。',
  '说话：先肯定，再给一个具体可执行的下一步，最后用陪伴感收尾；一次只说一件事，口语、短句。',
  '自报家门（首次见面说一次，之后不重复）：「嗨，我是可可，你的专属教练。不吼人、不画饼，只陪你练到赢。让我们一起动起来！」',
  '红线：不羞辱、不身材焦虑；不越界医疗（伤病 / 孕期 / 慢病建议就医）；不极端节食 / 超量训练；保护数据隐私；做不到就直说；性别不刻板。',
].join('\n');

/** 当前人设文件路径（`SOUL_PATH` 覆盖优先） */
export function soulPath() {
  const override = String(process.env.SOUL_PATH || '').trim();
  return override || DEFAULT_SOUL_PATH;
}

/**
 * 读一份人设文件（纯读取 + 截断，不缓存）：测试 / 诊断可以直接用。
 *
 * @param {string} [file] 人设文件路径
 * @param {{maxChars?:number, logger?:{warn?:Function}}} [opts]
 * @returns {string} 人设正文；读不到 → `FALLBACK_SOUL`
 */
export function loadSoulText(file = soulPath(), { maxChars = SOUL_MAX_CHARS, logger = console } = {}) {
  const warn = (message) => {
    if (logger && typeof logger.warn === 'function') logger.warn(message);
  };
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    warn(`[soul] 读不到人设文件 ${path.basename(file)}，使用内置兜底人设`);
    return FALLBACK_SOUL;
  }
  if (typeof text !== 'string' || !text.trim()) {
    warn(`[soul] 人设文件 ${path.basename(file)} 是空的，使用内置兜底人设`);
    return FALLBACK_SOUL;
  }
  if (text.length > maxChars) {
    warn(`[soul] 人设超过 ${maxChars} 字符，已截断`);
    return text.slice(0, maxChars);
  }
  return text;
}

/** 模块级缓存：{file, text}；路径变了（例如测试改了 SOUL_PATH）才重读 */
let soulCache = { file: soulPath(), text: loadSoulText(soulPath()) };

/** 当前生效的人设正文（读一次、缓存；路径变化自动重读） */
export function readSoul() {
  const file = soulPath();
  if (!soulCache || soulCache.file !== file) {
    soulCache = { file, text: loadSoulText(file) };
  }
  return soulCache.text;
}

/** 清掉缓存（测试在改 `SOUL_PATH` 后用；生产代码不需要） */
export function resetSoulCache() {
  soulCache = null;
}

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
  Object.freeze({
    name: 'continue_last',
    intents: ['continueLast'],
    zh: '继续上次没练完的那一组（回到上次的动作 / 目标 / 第几组）。',
    en: 'Continue the unfinished set from last time (same exercise, target and set).',
    parameters: schema(),
    map: () => ({ intent: 'continueLast', args: {} }),
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
    name: 'set_voice_gender',
    intents: ['setVoiceGender'],
    zh: '换教练声音：female 女声（默认）/ male 男声（只影响朗读音色，会记进长期偏好）。',
    en: 'Switch the coach voice: female (default) or male (spoken voice only; remembered as a preference).',
    parameters: schema({ gender: oneOf('男女声 / voice gender', ['female', 'male']) }, ['gender']),
    map(args) {
      const gender = String(args.gender || '').toLowerCase();
      if (gender !== 'female' && gender !== 'male') return { refused: 'bad-args' };
      return { intent: 'setVoiceGender', args: { gender } };
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

  /* ---------------- R2 口述建规则（规则增删查；和命令表同一套 intent） ----------------
   * 「零 LLM」指的是**口述那条快车道**不联网：说「每 10 个报一次」直接改规则表。
   * 这三个工具只是让「模型也能做同样的事」，执行仍然是 COMMANDS[].run（同一套护栏）。
   */
  Object.freeze({
    name: 'add_rule',
    intents: ['addRule'],
    zh: '口述建一条规则：kind=rep 每 N 个报一次数；kind=read 每 N 秒读一次秒（只活到这次训练结束）。',
    en: 'Build a rule: kind=rep counts every N reps; kind=read reads the time every N seconds '
      + '(lasts until this workout ends).',
    parameters: schema({
      kind: oneOf('哪一类规则 / which kind of rule', RULE_KINDS),
      every: int('间隔：N 个 / N 秒 / interval (N reps or N seconds)', { minimum: 1, maximum: 999 }),
    }, ['kind', 'every']),
    map(args) {
      const kind = String(args.kind || '');
      const every = toInt(args.every);
      if (!RULE_KINDS.includes(kind) || every === null || every < 1) return { refused: 'bad-args' };
      return { intent: 'addRule', args: { kind, every } };
    },
  }),
  Object.freeze({
    name: 'remove_rule',
    intents: ['removeRule'],
    zh: '关掉一类规则：kind=rep 不再报数；kind=read 不再读秒。',
    en: 'Turn a rule off: kind=rep stops counting; kind=read stops the time read-outs.',
    parameters: schema({ kind: oneOf('哪一类规则 / which kind of rule', RULE_KINDS) }, ['kind']),
    map(args) {
      const kind = String(args.kind || '');
      if (!RULE_KINDS.includes(kind)) return { refused: 'bad-args' };
      return { intent: 'removeRule', args: { kind } };
    },
  }),
  Object.freeze({
    name: 'list_rules',
    intents: ['listRules'],
    zh: '把现在生效的规则**念给用户听**（规则名 + 间隔）。',
    en: 'Read out the active rules (name + interval) **aloud**.',
    parameters: schema(),
    map: () => ({ intent: 'listRules', args: {} }),
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

  /* ---------------- 长期记忆（服务端 MD；**没有 client intent**） ---------------- *
   *
   * 这三个工具**不产生客户端动作**（`intents: []`）：记忆写在服务端（`/llm` 里直接调用
   * `memory-store`），前端只需要在回复里说一句「记下了」。
   *
   * 安全边界（用户拍板，别放宽）：
   *   - `remember` **只能写 prefs**（tone / difficulty / sessionMinutes / restSec /
   *     voiceSource / rate），写 facts 会被拒绝；
   *   - `remember_fact` 写 facts 时**必须带 evidence**（用户原话片段），否则拒绝 ——
   *     模型不能凭推测给用户贴标签；
   *   - `forget` 只删单条字段（全部清除只在设置界面 / `POST /memory/forget {all:true}`）。
   */
  Object.freeze({
    name: 'remember',
    intents: [],
    memory: true,
    zh: '记住用户的一条**偏好**（tone 语气 / difficulty 难度 / sessionMinutes 每次分钟数 / '
      + 'restSec 组间休息秒数 / voiceSource 音色来源 / rate 语速）。只能记偏好，不能记事实。',
    en: 'Remember one **preference** (tone, difficulty, sessionMinutes, restSec, voiceSource, rate). '
      + 'Preferences only — never facts.',
    parameters: schema({
      field: oneOf('偏好字段 / preference field', PREFS_FIELDS),
      value: {
        type: ['string', 'number'],
        description: '字段值 / value（tone: warm|strict|funny；difficulty: easy|normal|hard；'
          + 'sessionMinutes: 5~60；restSec: 0~180；voiceSource: auto|volc|system；rate: 0.8~1.3）',
      },
    }, ['field', 'value']),
    map(args) {
      const field = String(args.field || '').trim();
      if (!PREFS_FIELDS.includes(field)) return { refused: 'not-a-preference' };
      if (args.value === undefined || args.value === null || args.value === '') {
        return { refused: 'bad-args' };
      }
      return { memory: { op: 'remember', field, value: args.value } };
    },
  }),
  Object.freeze({
    name: 'remember_fact',
    intents: [],
    memory: true,
    zh: '记住用户**明确说出来的**一条事实（goal 目标 / injuries 伤病史 / weeklyGoal 每周目标次数）。'
      + '必须带 evidence = 用户原话片段；**没有 evidence 就拒绝**，不要根据推测写事实。',
    en: 'Remember one fact the user **explicitly stated** (goal, injuries, weeklyGoal). '
      + 'Requires evidence = the user\'s exact words; without evidence it is refused. Never infer facts.',
    parameters: schema({
      field: oneOf('事实字段 / fact field', FACTS_FIELDS),
      value: {
        type: ['string', 'number', 'array'],
        items: { type: 'string' },
        description: '字段值 / value（goal: 减脂|增肌|保持|增强体能；injuries: 字符串数组；weeklyGoal: 1~7）',
      },
      evidence: str('用户说这句话时的原话片段 / the user\'s exact words'),
    }, ['field', 'value', 'evidence']),
    map(args) {
      const field = String(args.field || '').trim();
      if (!FACTS_FIELDS.includes(field)) return { refused: 'not-a-fact' };
      const evidence = String(args.evidence == null ? '' : args.evidence).trim();
      // 硬门槛：没有用户原话就不写 fact（用户拍板：模型不能自己写 fact）
      if (!evidence) return { refused: 'evidence-required' };
      if (args.value === undefined || args.value === null || args.value === '') {
        return { refused: 'bad-args' };
      }
      return { memory: { op: 'remember-fact', field, value: args.value, evidence } };
    },
  }),
  Object.freeze({
    name: 'forget',
    intents: [],
    memory: true,
    zh: '忘掉一条已经记下的偏好 / 事实（只删这一条；全部清除在设置里做）。',
    en: 'Forget one remembered preference / fact (one field only; clearing everything lives in Settings).',
    parameters: schema({
      field: oneOf('要忘掉的字段 / field to forget', [...PREFS_FIELDS, ...FACTS_FIELDS]),
    }, ['field']),
    map(args) {
      const field = String(args.field || '').trim();
      if (!PREFS_FIELDS.includes(field) && !FACTS_FIELDS.includes(field)) {
        return { refused: 'bad-field' };
      }
      return { memory: { op: 'forget', field } };
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
 * tool_calls → `{ intent, args }` 动作列表 + 服务端记忆操作列表。
 *
 * 记忆工具（`remember` / `remember_fact` / `forget`）**没有 client intent**：
 * 它们的 `map()` 返回 `{ memory: {op, field, value?, evidence?} }`，由 `/llm` 在服务端
 * 直接写 `server/memory/<userId>.md`（前端只负责把模型那句话念出来）。
 *
 * @param {Array<{name:string,args:object}>} toolCalls 模型返回的工具调用
 * @param {object} [opts]
 * @param {'zh'|'en'} [opts.locale='zh'] 保留参数（当前没有需要 locale 的拒绝话术）
 * @returns {{ actions: Array<{intent:string,args:object}>,
 *            refusals: Array<{name:string,reason:string}>,
 *            prompts: string[],
 *            memoryOps: Array<{op:string,field:string,value?:any,evidence?:string}> }}
 *   prompts 目前恒为空（没有工具需要二次确认），字段保留给以后
 */
export function actionsFromToolCalls(toolCalls, { locale = 'zh' } = {}) {
  void locale;   // 兼容旧调用；拒绝话术已全部走通用兜底
  const actions = [];
  const refusals = [];
  const prompts = [];
  const memoryOps = [];
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
    // 记忆工具：没有 intent，只有一条服务端操作
    if (mapped && mapped.memory && typeof mapped.memory === 'object') {
      const op = String(mapped.memory.op || '');
      const field = String(mapped.memory.field || '');
      if (!op || !field) { refusals.push({ name, reason: 'bad-args' }); continue; }
      memoryOps.push({
        op,
        field,
        value: mapped.memory.value,
        evidence: mapped.memory.evidence === undefined ? '' : String(mapped.memory.evidence),
      });
      continue;
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
  return { actions, refusals, prompts, memoryOps };
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
export function buildSystemPrompt({ locale = 'zh', context = null, maxContextChars = 6000, event = '' } = {}) {
  const lang = locale === 'en' ? 'en' : 'zh';
  const soul = readSoul();

  /**
   * ③ 当前记忆（prefs / facts）单独给一段 —— 人设（①）和运行规则（②）之后、state（④）之前。
   * state 里**不再重复** memory，避免同一份个人信息在一段 prompt 里出现两次。
   */
  const mem = context && typeof context === 'object' && context.memory && typeof context.memory === 'object'
    ? context.memory
    : {};
  const srcPrefs = mem.prefs && typeof mem.prefs === 'object' ? mem.prefs : {};
  const srcFacts = mem.facts && typeof mem.facts === 'object' ? mem.facts : {};
  const pick = (src, fields) => {
    const out = {};
    for (const field of fields) {
      const value = src[field];
      if (value !== undefined && value !== null) out[field] = value;
    }
    return out;
  };
  const memory = {
    prefs: pick(srcPrefs, PREFS_FIELDS),
    facts: pick(srcFacts, FACTS_FIELDS),
  };

  let stateCtx = context;
  if (context && typeof context === 'object' && !Array.isArray(context)) {
    stateCtx = { ...context };
    delete stateCtx.memory;
  }
  const state = compactContext(stateCtx, { maxChars: maxContextChars });

  // 教练性别来自长期偏好（prefs.voiceGender）：只改音色与形象，不改人格 / 话术
  const genderRaw = srcPrefs.voiceGender;
  const gender = genderRaw === 'male' ? 'male' : 'female';
  // 首次对话只自报一次：服务端在首次成功回复后把 prefs.introSeen 置 true
  const introSeen = srcPrefs.introSeen === true;

  const lines = [
    // ① 人设（SOUL.md 原文；唯一来源）
    soul,
    '',
    '—— 以下是本产品的运行规则（身份与人设见上文 SOUL）/ Product runtime rules (identity and persona are in SOUL above) ——',
    '你的身份与人设见上文 SOUL。用户说的话来自语音识别，可能有口误或同音字。',
    'Your identity and persona are defined in SOUL above. User text comes from streaming speech recognition and may contain mishearings.',
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
    '   At most 3 tool calls per turn; do not follow a target change with report_progress.',
    '9. 「当前记忆 / Current memory」里的 prefs / facts 是用户之前让你记下的，可以直接参考，不要重新问一遍。',
    '   The prefs / facts in “Current memory” were remembered earlier — use them without asking again.',
    '10. **记忆规则**：只有当用户**明确要求或明确陈述**时才写记忆 —— 偏好用 remember，事实用 remember_fact。',
    '    **不要根据推测写 facts**；remember_fact 必须带 evidence（用户原话片段），没有 evidence 就不要调它。',
    '    写入前如果与已有记忆冲突（例如之前记的 tone=warm，用户现在说喜欢严格），**先口头确认**再写。',
    '    Memory rules: only write when the user explicitly asks or states it (prefs via remember, facts via remember_fact).',
    '    Never infer facts; remember_fact requires the user\'s exact words as evidence. If a new value conflicts with what is',
    '    already remembered, ask for confirmation before overwriting it.',
    '11. **防复读**：state.lastCoachLines 是你最近说过的 5 句，不要重复它们；state.recentEvents 是最近 60 秒的',
    '    计次 / 门控失败 / 关键帧命中，回答「刚才怎么样」时直接引用里面的数字，不要编。',
    '    Do not repeat the lines in state.lastCoachLines; quote state.recentEvents instead of inventing recent numbers.',
    `12. 教练性别：${gender === 'male' ? '男' : '女'}（音色与形象不同；人格、专业度、话术完全一致，不要强化性别刻板印象；`
      + '性别中立的内核不变，人称与自称不要因为性别改变，不要刻意）。',
    `    Coach gender: ${gender}. Voice and avatar differ only; personality, professionalism and wording are identical. `
      + 'Do not reinforce gender stereotypes, keep the neutral core, and do not change person/self-reference by gender — '
      + 'never hard-code “she” or “he”. Call set_voice_gender when the user asks for a male / female coach voice.',
    `13. 用用户的语言回答 / Answer in: ${lang === 'en' ? 'English' : '中文'}。`,
    '14. 回答收尾尽量带一句自然的「动起来！」；**不要每句都硬加**。',
    '    End with a natural “动起来！” / “Let’s move!” when it fits; never force it into every sentence.',
    '15. 红线：不羞辱/不身材焦虑；不越界医疗（伤病/孕期/慢病→建议就医）；不极端节食/超量训练；数据隐私；做不到就直说；性别不刻板。',
    '    Red lines: no shaming or body anxiety; no medical overreach (injury / pregnancy / chronic conditions → see a doctor); '
      + 'no extreme dieting or overtraining; data privacy; admit what you cannot do; no gender stereotypes.',
    /**
     * 会话开始事件（session-start）：用户点「开始体感训练」进了全屏 / 训练界面，前端替用户发一条[事件]，
     * 让教练主动开口。和「用户说话」走同一条回复链路，但话术要短、要主动。
     */
    '16. **会话开始事件**：收到以 `[事件] 用户刚刚进入训练` 开头的 user 消息（`event: session-start`）时：主动打招呼 +'
      + ' 提示今天的动作 / 目标 + 一句注意点；只说 1~2 句、≤40 字；**不要**每次都问一堆问题；'
      + '若「当前记忆」里有目标 / 伤病，可以顺带提一句。',
    '    **Session-start event**: when the user message starts with `[Event] The user has just entered the workout`'
      + ' (`event: session-start`), greet the user proactively, mention today\'s exercise / target and one cue;'
      + ' keep it to 1–2 sentences and ≤40 characters (or about 25 words in English); never ask a list of questions;'
      + ' if Current memory has a goal / injury, you may mention it briefly.',
  ];

  if (!introSeen) {
    lines.push(
      /**
       * 首次见面 + 这次是「进入训练」的主动问候：自报家门必须压成一句短的，
       * 否则模型会把 SOUL 里整段自报念一遍、再叠一句问候，轻松超过「1~2 句、≤40 字」。
       */
      event === LLM_EVENT_SESSION_START
        ? '这是首次对话，而且这次是进入训练时的主动问候：自报家门压成一句短的（例如「嗨，我是可可」），'
          + '再提示动作 / 目标；总共 1~2 句、≤40 字。'
        : '这是首次对话，先说一次自报家门（用 SOUL 里那句原文），之后不再重复。',
      event === LLM_EVENT_SESSION_START
        ? 'This is the first conversation and it is the session-start greeting: keep the self-introduction to one short '
          + 'clause (e.g. “Hi, I’m Coach KK”), then mention the exercise / target; 1–2 sentences in total.'
        : 'This is the first conversation: introduce yourself once using the exact line in SOUL, then never repeat it.',
    );
  }

  lines.push(
    '',
    // ③ 当前记忆（prefs / facts）
    `当前记忆 / Current memory (prefs / facts): ${JSON.stringify(memory)}`,
    '',
    // ④ state（客户端算好的结构化快照）
    `state (JSON): ${state}`,
  );
  return lines.join('\n');
}

export default {
  LLM_TOOL_DEFS,
  LLM_TOOLS,
  LLM_EVENT_SESSION_START,
  TOOL_BY_NAME,
  TOOL_INTENT_MAP,
  TOOLED_INTENTS,
  UNCOVERED_INTENTS,
  UNKNOWN_TOOLED_INTENTS,
  MAX_TOOL_CALLS,
  RULE_KINDS,
  ACTION_REPLY,
  EMPTY_REPLY,
  DEFAULT_SOUL_PATH,
  SOUL_MAX_CHARS,
  FALLBACK_SOUL,
  soulPath,
  loadSoulText,
  readSoul,
  resetSoulCache,
  actionsFromToolCalls,
  buildSystemPrompt,
  compactContext,
  resolveExerciseId,
  toolHelpRows,
};
