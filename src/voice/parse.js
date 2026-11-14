/**
 * 语音命令解析（P3.2 命令快车道）—— **纯函数，不碰 DOM、不改 state**。
 *
 *   parseCommand(text, locale = 'zh') → { intent, args, confidence, usedWake }
 *
 * 处理顺序：
 *   1) 归一化：全角 → 半角、去标点、大小写不敏感、合并空白；
 *   2) 唤醒词（**可选**）：开头是「可可 / 教练 / coach」就去掉并置 `usedWake = true`，
 *      没有唤醒词也照常解析（快车道不强制唤醒）；
 *   3) 抽槽位：数量 + 单位（次 / 个 / 下 / 秒 / 分钟）、**间隔（每 N 个 / 每 N 秒）**、
 *      规则频道（报数 / 读秒）、动作名、分类、序数（「第三个」）、语言（「说英文」）；
 *      中文数字会先换成数值（二十 → 20、一分钟 → 60 秒）；
 *   4) 拿 `commands.js` 的说法表做最长匹配（中英两套都参与，所以界面是英文时说中文也认）；
 *      标了 `numeric: true` 的命令（口述建规则）匹配前会抹掉两边的数字，所以「每 10 个报一次」
 *      的说法表项能命中「每 3 个报一次」；
 *   5) 匹配不上 → `{ intent: 'unknown' }`（**不猜**）。
 *
 * 说法表 / 命令含义 / 帮助文案都在 `commands.js` 与 `src/locales/*.js` 里，
 * 这里只做「把一句人话变成 { intent, args }」这一件事。
 */

import { LOCALES } from '../i18n.js';
import { EXERCISES } from '../catalog.js';
import { COMMANDS, CONFIRM_WORDS, CANCEL_WORDS } from './commands.js';

/* ------------------------------------------------------------------ *
 * 字符 / 单位常量（中文用 \u 转义写：源码里不留写死的中文，见 test-i18n）
 * ------------------------------------------------------------------ */

const HAS_CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/** 中文数字字符：零 〇 一 二 两 三 四 五 六 七 八 九 十 百 千 */
const NUM_CHARS = '\u96f6\u3007\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343';
const NUM_PATTERN = `(?:\\d{1,4}(?:\\.\\d+)?|[${NUM_CHARS}]{1,6})`;

/** 中文数字 → 整数（支持「十五 / 二十 / 一百二十 / 两千零五」） */
const DIGIT_VALUE = {
  '\u96f6': 0, '\u3007': 0,
  '\u4e00': 1, '\u4e8c': 2, '\u4e24': 2, '\u4e09': 3, '\u56db': 4,
  '\u4e94': 5, '\u516d': 6, '\u4e03': 7, '\u516b': 8, '\u4e5d': 9,
};
const UNIT_VALUE = { '\u5341': 10, '\u767e': 100, '\u5343': 1000 };

export function cnToInt(token) {
  const text = String(token == null ? '' : token).trim();
  if (!text) return NaN;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  let total = 0;
  let current = 0;
  let seen = false;
  for (const ch of text) {
    if (Object.prototype.hasOwnProperty.call(DIGIT_VALUE, ch)) {
      current = DIGIT_VALUE[ch];
      seen = true;
    } else if (Object.prototype.hasOwnProperty.call(UNIT_VALUE, ch)) {
      const unit = UNIT_VALUE[ch];
      total += (current === 0 ? 1 : current) * unit;
      current = 0;
      seen = true;
    } else {
      return NaN;
    }
  }
  return seen ? total + current : NaN;
}

/** 单位 → 含义（秒 / 分 / 次）。键都是已归一化的写法 */
const MINUTE_UNITS = new Set([
  '\u5206\u949f', '\u5206', 'minute', 'minutes', 'min', 'mins',
]);
const SECOND_UNITS = new Set([
  '\u79d2\u949f', '\u79d2', 'second', 'seconds', 'sec', 'secs', 's',
]);
const REP_UNITS = new Set([
  '\u6b21', '\u4e2a', '\u4e0b', '\u904d', 'rep', 'reps', 'time', 'times', 'set', 'sets',
]);

const AMOUNT_RE = new RegExp(
  `(${NUM_PATTERN})\\s*(\\u5206\\u949f|\\u5206|\\u79d2\\u949f|\\u79d2|\\u6b21|\\u4e2a|\\u4e0b|\\u904d`
  + '|minutes?|mins?|seconds?|secs?|reps?|times?)',
  'i',
);

/**
 * 「每 N 个 / 每隔 N 个 / every N reps」这种**间隔**（R2 口述建规则用）：
 * 和 `readAmount` 分开抽 —— 同一句「每 10 个报一次」里的「10 个」是间隔，不是目标次数。
 */
const INTERVAL_RE = new RegExp(
  `(?:\\u6bcf\\u9694?|every)\\s*(${NUM_PATTERN})\\s*`
  + '(\\u4e2a|\\u6b21|\\u4e0b|\\u79d2\\u949f|\\u79d2|\\u5206\\u949f|\\u5206'
  + '|reps?|times?|seconds?|secs?|minutes?|mins?)',
  'i',
);

/**
 * 「报数 / 读秒」这两个频道的词（口述建规则 / 关规则只认这两个）。
 * 中文用 `\u` 转义（源码里不留写死的中文），英文用小写比较。
 */
const RULE_KIND_WORDS = {
  // 报数 数数 计数 counting count reps
  rep: ['\u62a5\u6570', '\u6570\u6570', '\u8ba1\u6570', 'counting', 'count', 'reps'],
  // 读秒 报时 读时 倒计时 countdown the time clock
  read: ['\u8bfb\u79d2', '\u62a5\u65f6', '\u8bfb\u65f6', '\u5012\u8ba1\u65f6', 'countdown', 'the time', 'clock'],
};

/* 中文序数「第 N」；裸数字兜底时要先把它拿掉，免得把「第三个」当成 3 次 */
const CN_ORDINAL_RE = new RegExp(`\\u7b2c\\s*(${NUM_PATTERN})`, 'g');
const CN_ORDINAL_ONE = new RegExp(`\\u7b2c\\s*(${NUM_PATTERN})`);

/** 这些「一 X」是副词 / 量词，不是数字（「停一下」「一点」「一起」） */
const CN_IDIOM_ONE = /\u4e00\u4e0b|\u4e00\u4e9b|\u4e00\u70b9|\u4e00\u4f1a\u513f|\u4e00\u8d77|\u4e00\u76f4/g;

const EN_ORDINAL = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};
const EN_NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** 唤醒词（开头；大小写不敏感） */
const WAKE_WORDS = [
  '\u53ef\u53ef',   // 可可
  '\u6559\u7ec3',   // 教练
  'coach',
];

/** 「说英文 / 说中文」里的语言词 */
const LANG_WORDS = [
  { lang: 'en', word: 'english' },
  { lang: 'en', word: '\u82f1\u6587' },          // 英文
  { lang: 'en', word: '\u82f1\u8bed' },          // 英语
  { lang: 'zh', word: 'chinese' },
  { lang: 'zh', word: 'mandarin' },
  { lang: 'zh', word: '\u4e2d\u6587' },          // 中文
  { lang: 'zh', word: '\u6c49\u8bed' },          // 汉语
];

/** 分类的英文别名（中文分类名直接从 locales 的 cat.* 取） */
const CATEGORY_ALIASES = {
  upper: ['upper body', 'arms', 'arm', 'chest'],
  lower: ['lower body', 'legs', 'leg'],
  core: ['core', 'abs', 'stomach', 'belly'],
  full: ['full body', 'whole body'],
  stretch: ['stretching', 'stretch', 'flexibility'],
};

const CATEGORY_IDS = ['upper', 'lower', 'core', 'full', 'stretch'];

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

/** 全角 → 半角、去标点、小写、合并空白（命令说法表与输入都走同一个函数） */
export function normalizeText(raw) {
  const src = String(raw == null ? '' : raw);
  let half = '';
  for (const ch of src) {
    const code = ch.codePointAt(0);
    if (code === 0x3000) half += ' ';
    else if (code >= 0xff01 && code <= 0xff5e) half += String.fromCodePoint(code - 0xfee0);
    else half += ch;
  }
  return half
    .toLowerCase()
    .replace(/[\u3000-\u303f\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/g, ' ')
    .replace(/[\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u00b7]/g, ' ')
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const compactText = (text) => String(text == null ? '' : text).replace(/\s+/g, '');

/** 去掉开头的唤醒词（没有也不算错：快车道不强制唤醒） */
function stripWake(spaced) {
  const words = [...WAKE_WORDS].sort((a, b) => b.length - a.length);
  for (const word of words) {
    const w = normalizeText(word);
    if (!w || !spaced.startsWith(w)) continue;
    const next = spaced.charAt(w.length);
    if (next && !/\s/.test(next) && !HAS_CJK.test(next)) continue;   // 防止「coaching」被当成 coach
    return { body: spaced.slice(w.length).trim(), used: true };
  }
  return { body: spaced, used: false };
}

/* ------------------------------------------------------------------ *
 * 槽位
 * ------------------------------------------------------------------ */

/** 中文数字 / 阿拉伯数字统一成数值 */
function numberValue(token) {
  return /^\d/.test(token) ? Number(token) : cnToInt(token);
}

/** 数量 + 单位；没有单位时退化成「裸数字」（「目标 100」「加五」） */
function readAmount(spaced) {
  const m = AMOUNT_RE.exec(spaced);
  if (m) {
    const value = numberValue(m[1]);
    if (!Number.isFinite(value)) return null;
    const unit = m[2].toLowerCase();
    if (MINUTE_UNITS.has(unit)) return { value: value * 60, unit: 'seconds' };
    if (SECOND_UNITS.has(unit)) return { value, unit: 'seconds' };
    if (REP_UNITS.has(unit)) return { value, unit: 'reps' };
    return { value, unit: null };
  }
  const cleaned = spaced.replace(CN_ORDINAL_RE, ' ').replace(CN_IDIOM_ONE, ' ');
  const arabic = /(?:^|[^0-9a-z])(\d{1,4})(?![0-9])/.exec(cleaned);
  if (arabic) return { value: Number(arabic[1]), unit: null };
  const cn = new RegExp(`[${NUM_CHARS}]{1,6}`).exec(cleaned);
  if (cn) {
    const value = cnToInt(cn[0]);
    if (Number.isFinite(value)) return { value, unit: null };
  }
  return null;
}

/**
 * 「每 N 个 / 每 N 秒」→ `{ value, unit: 'reps'|'seconds' }`（R2 口述建规则的间隔槽位）。
 *
 * - 「每 10 个报一次」→ `{value:10, unit:'reps'}`；「每 30 秒报时」→ `{value:30, unit:'seconds'}`；
 * - 分钟换算成秒（「每 2 分钟」→ 120 秒）；中文数字走 `cnToInt`（「每十个」→ 10）；
 * - 没有「每 / 每隔 / every」或没有数字 → `null`（**绝不猜**）。
 */
function readInterval(spaced) {
  const m = INTERVAL_RE.exec(spaced);
  if (!m) return null;
  const value = numberValue(m[1]);
  if (!Number.isFinite(value) || value < 1) return null;
  const unit = m[2].toLowerCase();
  if (MINUTE_UNITS.has(unit)) return { value: Math.round(value * 60), unit: 'seconds' };
  if (SECOND_UNITS.has(unit)) return { value: Math.round(value), unit: 'seconds' };
  if (REP_UNITS.has(unit)) return { value: Math.round(value), unit: 'reps' };
  return null;
}

/**
 * 「别报数了 / 别读秒了」要关掉哪个频道 → `'rep'` / `'read'` / `''`。
 * 取句子里**最后出现**的那个词；同一个位置命中两个词时取更长的
 * （`countdown` 里的 `count` 不会被当成「报数」）。
 */
function readRuleKind(spaced) {
  const text = ` ${normalizeText(spaced)} `;
  let best = { kind: '', end: -1, len: 0 };
  for (const [kind, words] of Object.entries(RULE_KIND_WORDS)) {
    for (const raw of words) {
      const word = normalizeText(raw);
      if (!word) continue;
      const at = text.lastIndexOf(word);
      if (at < 0) continue;
      const end = at + word.length;
      if (end > best.end || (end === best.end && word.length > best.len)) {
        best = { kind, end, len: word.length };
      }
    }
  }
  return best.kind;
}

/** 序数：「第三个 / 第 3 个 / third one / number three」→ 3（找不到返回 0） */
function readOrdinal(spaced, compact) {
  const cn = CN_ORDINAL_ONE.exec(compact);
  if (cn) {
    const n = numberValue(cn[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const en = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i.exec(spaced);
  if (en) return EN_ORDINAL[en[1].toLowerCase()] || 0;
  const num = /\b(?:number|no\.?)\s*([a-z0-9]+)\b/i.exec(spaced);
  if (num) {
    const raw = num[1].toLowerCase();
    const n = /^\d+$/.test(raw) ? Number(raw) : EN_NUMBER_WORDS[raw];
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * 一个词（分类 / 动作名 / 别名）在不在句子里。
 * 中文按去空白后的子串判（「深蹲」能被「自重深蹲」命中）；
 * 英文按词边界判（否则 `score` 会被当成分类 `core`）。
 */
function hasWord(spaced, compact, word) {
  const w = normalizeText(word);
  if (!w) return false;
  if (HAS_CJK.test(w)) return compact.includes(compactText(w));
  return (` ${spaced} `).includes(` ${w} `);
}

/** 分类名 / 别名 → 分类 id（最长的先说，`full body` 不会被 `body` 抢走） */
const CATEGORY_WORDS = (() => {
  const list = [];
  for (const id of CATEGORY_IDS) {
    for (const lang of ['zh', 'en']) {
      const name = LOCALES[lang]?.cat?.[id];
      if (typeof name === 'string') list.push({ id, word: name });
    }
    for (const alias of CATEGORY_ALIASES[id] || []) list.push({ id, word: alias });
  }
  return list.sort((a, b) => normalizeText(b.word).length - normalizeText(a.word).length);
})();

function readCategory(spaced, compact) {
  for (const item of CATEGORY_WORDS) {
    if (hasWord(spaced, compact, item.word)) return item.id;
  }
  return '';
}

/** 动作名 / 别名 → 动作 id（官方中英名 + id + locales 里的短别名） */
const EXERCISE_WORDS = (() => {
  const list = [];
  for (const ex of EXERCISES) {
    const names = new Set([ex.id]);
    for (const lang of ['zh', 'en']) {
      const official = LOCALES[lang]?.ex?.[ex.id]?.name;
      if (typeof official === 'string') names.add(official);
      const aliases = LOCALES[lang]?.coach?.exerciseAliases?.[ex.id];
      if (Array.isArray(aliases)) for (const a of aliases) if (typeof a === 'string') names.add(a);
    }
    for (const word of names) list.push({ id: ex.id, word });
  }
  return list.sort((a, b) => normalizeText(b.word).length - normalizeText(a.word).length);
})();

function readExercise(spaced, compact) {
  for (const item of EXERCISE_WORDS) {
    if (hasWord(spaced, compact, item.word)) return item.id;
  }
  return '';
}

/** 语言词（取句子里**最后**出现的那个：「先中文再说英文」听最后那句） */
function readLang(spaced) {
  let best = '';
  let at = -1;
  for (const item of LANG_WORDS) {
    const w = normalizeText(item.word);
    if (!w) continue;
    const found = spaced.lastIndexOf(w);
    if (found > at) { at = found; best = item.lang; }
  }
  return best;
}

/**
 * 教练声音性别：句子最后出现的「男 / 女」说了算。
 * 只服务于 `setVoiceGender` 这一条命令（其它命令即使句子里带「男」也不会用它）。
 */
function readVoiceGender(spaced) {
  // \u7537 = 男 / \u5973 = 女（源码里不留中文字面量：i18n 自检要求文案必须走 t()）
  const text = ` ${spaced} `;
  const lastPos = (re) => {
    let at = -1;
    for (const m of text.matchAll(re)) at = m.index + m[0].length;
    return at;
  };
  // 英文用 \b，避免 female 里的 male / woman 里的 man 被误判
  const maleAt = Math.max(lastPos(/\bmale\b/g), lastPos(/\bman\b/g), lastPos(/\bboy\b/g), lastPos(/\u7537/g));
  const femaleAt = Math.max(lastPos(/\bfemale\b/g), lastPos(/\bwoman\b/g), lastPos(/\bgirl\b/g), lastPos(/\u5973/g));
  if (maleAt < 0 && femaleAt < 0) return '';
  return maleAt > femaleAt ? 'male' : 'female';
}

/** 「加 / 减」的符号（减、少、降、minus、reduce、decrease、less 都是减） */
function readSign(spaced) {
  return /(\u51cf|\u5c11|\u964d|minus|reduce|decrease|less)/i.test(spaced) ? -1 : 1;
}

/* ------------------------------------------------------------------ *
 * 说法匹配
 * ------------------------------------------------------------------ */

/** 命中返回长度（越长越具体），不命中返回 0 */
function phraseScore(spaced, compact, phrase) {
  const p = normalizeText(phrase);
  if (!p) return 0;
  const pc = compactText(p);
  if (!pc) return 0;
  if (HAS_CJK.test(pc)) return compact.includes(pc) ? pc.length : 0;
  return (` ${spaced} `).includes(` ${p} `) ? p.length : 0;
}

function isExact(spaced, compact, phrase) {
  const p = normalizeText(phrase);
  if (!p) return false;
  if (HAS_CJK.test(p)) return compact === compactText(p);
  return spaced === p;
}

/**
 * 口述规则那种「说法里带数字」的命令：匹配前把**两边**的数字都抹掉再比
 * （「每 10 个报一次」的说法表项是 `每 10 个报一次`，用户说「每 3 个报一次」也得命中）。
 * 只有 `cmd.numeric === true` 的命令走这条路，其余命令仍然逐字匹配。
 */
const NUMERIC_STRIP_RE = new RegExp(`[0-9${NUM_CHARS}]`, 'g');

function numericForm(text) {
  return compactText(normalizeText(text)).replace(NUMERIC_STRIP_RE, '');
}

function numericScore(spaced, phrase) {
  const p = numericForm(phrase);
  if (!p) return 0;
  const body = numericForm(spaced);
  return body.includes(p) ? p.length : 0;
}

/** 这条命令要求的槽位有没有抽到（抽不到就不参与匹配，避免「目标」空喊） */
function slotReady(intent, slots) {
  if (intent === 'setTarget' || intent === 'adjustTarget') return !!slots.amount;
  if (intent === 'pick') return !!slots.ordinal;
  if (intent === 'category') return !!slots.category;
  if (intent === 'switchLang') return !!slots.lang;
  if (intent === 'setVoiceGender') return !!slots.gender;
  // 口述建规则必须有「每 N 个 / 每 N 秒」；关规则必须说清是报数还是读秒
  if (intent === 'addRule') return !!slots.interval;
  if (intent === 'removeRule') return !!slots.ruleKind;
  return true;
}

/** intent + 槽位 → args（只放这一条命令用得上的） */
function argsFor(intent, slots) {
  const args = {};
  if (intent === 'startWorkout') {
    if (slots.exerciseId) args.exerciseId = slots.exerciseId;
    if (slots.amount) {
      args.value = slots.amount.value;
      if (slots.amount.unit) args.unit = slots.amount.unit;
    }
  } else if (intent === 'setTarget' && slots.amount) {
    args.value = slots.amount.value;
    if (slots.amount.unit) args.unit = slots.amount.unit;
  } else if (intent === 'adjustTarget' && slots.amount) {
    args.delta = slots.amount.value * readSign(slots.spaced);
  } else if (intent === 'pick' && slots.ordinal) {
    args.index = slots.ordinal - 1;
  } else if (intent === 'category' && slots.category) {
    args.category = slots.category;
  } else if (intent === 'switchLang' && slots.lang) {
    args.lang = slots.lang;
  } else if (intent === 'setVoiceGender' && slots.gender) {
    args.gender = slots.gender;
  } else if (intent === 'addRule' && slots.interval) {
    // 单位决定频道：个 / 次 → 报数间隔；秒 → 读秒间隔
    args.kind = slots.interval.unit === 'seconds' ? 'read' : 'rep';
    args.every = slots.interval.value;
  } else if (intent === 'removeRule') {
    args.kind = slots.ruleKind || 'rep';
  }
  return args;
}

/* ------------------------------------------------------------------ *
 * 确认 / 取消（只在「等待确认」状态下由 session 调）
 *
 * 这里**故意比命令匹配更严格**：确认 / 取消必须是「整句就是那个词」（可带一个语气词），
 * 否则「今天天气不错」里的「不」会把等待中的退出取消掉。
 * ------------------------------------------------------------------ */

const POLITE_TAIL = /[\u5427\u554a\u5440\u5462\u7684\u4e86]/;   // 吧 / 啊 / 呀 / 呢 / 的 / 了

function matchesAny(text, words) {
  const spaced = normalizeText(text);
  const compact = compactText(spaced);
  if (!compact) return false;
  for (const raw of [...(words.zh || []), ...(words.en || [])]) {
    const w = normalizeText(raw);
    if (!w) continue;
    if (HAS_CJK.test(w)) {
      const wc = compactText(w);
      if (compact === wc) return true;
      // 「确认吧 / 好的呀 / 不要了」：一个语气词后缀可以，长句子不行
      if (wc.length >= 2 && compact.length === wc.length + 1
        && compact.startsWith(wc) && POLITE_TAIL.test(compact.slice(-1))) return true;
    } else if (spaced === w || spaced === `${w} please`) {
      return true;
    }
  }
  return false;
}

export function isConfirmText(text) {
  return matchesAny(text, CONFIRM_WORDS);
}

export function isCancelText(text) {
  return matchesAny(text, CANCEL_WORDS);
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 解析一句用户说的话。
 *
 * @param {string} text             识别到的原句
 * @param {string} [locale='zh']    当前界面语言（说法表两套都参与匹配；这个参数只作为偏好保留）
 * @returns {{ intent: string, args: object, confidence: number, usedWake: boolean }}
 */
export function parseCommand(text, locale = 'zh') {
  const spacedAll = normalizeText(text);
  const { body, used } = stripWake(spacedAll);
  const compact = compactText(body);
  const unknown = { intent: 'unknown', args: {}, confidence: 0, usedWake: used };
  if (!compact) return unknown;

  const amount = readAmount(body);
  const ordinal = readOrdinal(body, compact);
  const category = readCategory(body, compact);
  const exerciseId = readExercise(body, compact);
  const lang = readLang(body);
  const gender = readVoiceGender(body);
  // R2 口述建 / 关规则：间隔（每 10 个 / 每 30 秒）+ 频道（报数 / 读秒）
  const interval = readInterval(body);
  const ruleKind = readRuleKind(body);
  const slots = {
    spaced: body, compact, amount, ordinal, category, exerciseId, lang, gender, interval, ruleKind,
  };

  let best = null;
  for (const cmd of COMMANDS) {
    if (!slotReady(cmd.intent, slots)) continue;
    for (const key of ['zh', 'en']) {
      for (const phrase of cmd[key] || []) {
        const score = cmd.numeric ? numericScore(body, phrase) : phraseScore(body, compact, phrase);
        if (!score) continue;
        if (!best || score > best.score) best = { cmd, phrase, score };
      }
    }
  }

  if (best) {
    const exact = isExact(body, compact, best.phrase);
    // 中英都参与匹配；如果同一句话两端都命中，locale 只用于打破完全并列
    const confidence = exact ? 1 : 0.9;
    const parsed = {
      intent: best.cmd.intent,
      args: argsFor(best.cmd.intent, slots),
      confidence,
      usedWake: used,
    };
    // 同长度并列时优先当前语言的说法（例如英文界面下同时命中 zh / en）
    if (!exact && locale && best.cmd[locale] && best.cmd[locale].some((p) => phraseScore(body, compact, p) === best.score)) {
      parsed.confidence = Math.min(1, confidence + 0.01);
    }
    return parsed;
  }

  // 没有命中固定说法时的「槽位兜底」：只在证据足够强时才认
  if (exerciseId) {
    return {
      intent: 'startWorkout',
      args: argsFor('startWorkout', slots),
      confidence: amount ? 0.85 : 0.8,
      usedWake: used,
    };
  }
  if (ordinal) {
    return { intent: 'pick', args: { index: ordinal - 1 }, confidence: 0.8, usedWake: used };
  }
  if (category) {
    return { intent: 'category', args: { category }, confidence: 0.8, usedWake: used };
  }
  if (lang) {
    return { intent: 'switchLang', args: { lang }, confidence: 0.75, usedWake: used };
  }
  return unknown;
}

export default { parseCommand, normalizeText, cnToInt, isConfirmText, isCancelText };
