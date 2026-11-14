/**
 * R3：LLM 当「裁判」—— 事件触发，由模型判断要不要说一句（纯逻辑，**不碰 DOM**）。
 *
 * 用户原话（R3）：「LLM 当裁判：事件触发，由模型判断要不要说一句」——
 * 和 R1/R2 的规则快车道相反：那边是**确定性**的口令（不联网、不花钱），
 * 这边把「要不要开口」交给模型，但它**默认闭嘴**（静默优先）。
 *
 * 一次裁判 =
 *   ① 前端按事件触发（本文件上半部分的触发口径）→
 *   ② `POST /llm {event, context}`（服务端按 event 生成 user 消息）→
 *   ③ 模型只回**严格 JSON**：`{"speak": string|null, "actions": [...]?}` →
 *   ④ 本文件的下半部分做护栏（并发 1 / 冷却 / 去重 / 说话中丢弃 / 8s 超时），
 *      真的要说才交给 app.js 现有的 `voice.onCoachText()`（弹幕 + TTS + 降级同一条路）。
 *
 * 护栏（用户拍板，缺一条都会变成「教练很吵」）：
 *   - **不要**每分钟 / 每场的裁判上限（用户明确要求 ✗）—— 由触发频率本身控制；
 *   - 静默优先：模型说 null、文本为空、JSON 不合法 → **一律不出声**；
 *   - 并发 1：同一时刻只允许一条裁判请求，新触发**取消**旧的（旧结果回来直接丢弃）；
 *   - 超时 8s → 静默、**不重试**；LLM 失败 → 门控那条回退 R1 模板口令，其余静默；
 *   - 冷却：同触发 8s、同文本 15s 不重复；教练正在说话时丢弃；
 *   - 诊断：`judge:ask {event, ok, ms, spoke}` / `judge:skip {reason}`。
 *
 * 事件口径只在这里定义一次：服务端（`server/llm-provider.mjs`）也 import 本文件，
 * 所以前端 / 服务端 / 测试读的是同一份 `JUDGE_EVENTS`。
 *
 * 两种「自由文本」事件复用同一条口径、但**不走**裁判模式：
 *   - `session-start`：进场问候（P3.3）；
 *   - `session-end`：离场告别（≤2 句，肯定 + 具体数字 + 「明天见 / 动起来」；
 *     服务端另生成 user 消息，失败时用 locales 里的内置告别语兜底）。
 *
 * ⚠️ 本文件里的字符串一律英文（i18n 自检会扫 src/ 下的中文字面量）；
 *    给用户看的文案全部来自 `src/locales/*.js` 或模型。
 */

/**
 * 教练开口的事件口径（**唯一来源**：前端 / 服务端 / 测试都读这一份）。
 *
 *   · 8 个裁判触发点 → 走**裁判模式**（严格 JSON，默认 null）；
 *   · `session-start` → 复用 P3.3 已有的进场问候（自由文本）；
 *   · `session-end`   → 一次训练的**告别**（自由文本，≤2 句，必须说 —— 见 `isJudgeFarewellEvent`）。
 */
export const JUDGE_EVENTS = Object.freeze([
  /** 一组结束：复盘这组（分数 / 对比上组） */
  'set-complete',
  /** 破纪录：立即（可抢占） */
  'pr',
  /** 每 3 个一次 */
  'rep-judge',
  /** 计时类每 10 秒 */
  'hold-judge',
  /** 静止 10s 起，每 10 秒一次，直到有动作 */
  'idle',
  /** 出画 10s 起，每 10 秒一次，直到回画面 */
  'out-of-frame',
  /** 门控连续 2 次没通过（带上哪条门控 + 差多少） */
  'gate-fail2',
  /** 关键帧连续 2 次漏掉（带上哪一帧 + 差多少分） */
  'keyframe-miss2',
  /** 进入训练：复用已有的主动问候（不是裁判模式，仍旧自由文本） */
  'session-start',
  /**
   * 退出训练（退出全屏 / 回主页）：**告别**（不是裁判模式，自由文本；每次训练只 1 次）。
   * 它和 `session-start` 正好一对：进场问候、离场告别；中间 8 个才是「要不要说一句」的裁判。
   */
  'session-end',
]);

/** 走裁判模式（严格 JSON）的事件：除 `session-start` / `session-end` 以外的 8 个 */
export const JUDGE_ASK_EVENTS = Object.freeze(
  JUDGE_EVENTS.filter((event) => event !== 'session-start' && event !== 'session-end'),
);

/** 走告别模式的事件（自由文本，必须说；`session-end`） */
export const JUDGE_FAREWELL_EVENTS = Object.freeze(['session-end']);

/** 事件是否属于裁判口径（`session-start` / `session-end` 也算，但它们走自由文本） */
export function isJudgeEvent(event) {
  return JUDGE_EVENTS.includes(String(event || ''));
}

/** 是否走裁判模式（严格 JSON + 默认 null） */
export function isJudgeAskEvent(event) {
  return JUDGE_ASK_EVENTS.includes(String(event || ''));
}

/** 是否走告别模式（自由文本 + ≤2 句；`session-end`） */
export function isJudgeFarewellEvent(event) {
  return JUDGE_FAREWELL_EVENTS.includes(String(event || ''));
}

/* ------------------------------------------------------------------ *
 * 数字口径（**一处定义**：触发频率与测试都读这里）
 * ------------------------------------------------------------------ */

/** 客户端等多久（服务端也是 8s；这里到点就静默，绝不重试） */
export const JUDGE_TIMEOUT_MS = 8000;
/** 同一条触发的最小间隔（用户拍板：8s） */
export const JUDGE_COOLDOWN_MS = 8000;
/** 同一句话的最短重复间隔（用户拍板：15s） */
export const JUDGE_DEDUPE_MS = 15000;
/** 一句话最多多少字（用户拍板：≤40 字；模型超了就截断，绝不念长文） */
export const JUDGE_MAX_CHARS = 40;
/**
 * 告别语的上限（用户要求「告别语 ≤2 句」）：
 *   - 最多 2 句（句末标点：。！？!?；; 以及英文句点）；
 *   - 最多 60 字（两句各带一个数字刚好够，再长 TTS 就要念十几秒）。
 * 和裁判那句 40 字分开：告别是「训练结束的最后一句话」，可以有两个短句。
 */
export const FAREWELL_MAX_CHARS = 60;
export const FAREWELL_MAX_SENTENCES = 2;

/** 每 3 个动作问一次裁判 */
export const REP_JUDGE_EVERY = 3;
/** 计时类每 10 秒问一次 */
export const HOLD_JUDGE_EVERY_SEC = 10;
/** 静止从第 10 秒开始，之后每 10 秒一次 */
export const IDLE_JUDGE_START_SEC = 10;
export const IDLE_JUDGE_EVERY_SEC = 10;
/** 出画从第 10 秒开始，之后每 10 秒一次 */
export const OUT_OF_FRAME_JUDGE_START_SEC = 10;
export const OUT_OF_FRAME_JUDGE_EVERY_SEC = 10;
/** 门控 / 关键帧「连续几次」才问裁判（用户拍板：2 次） */
export const GATE_FAIL_JUDGE_STREAK = 2;
export const KEYFRAME_MISS_JUDGE_STREAK = 2;

/**
 * 触发优先级（并发 1 时「新触发取消旧的」；优先级更高的一定能抢占）：
 *   告别 > 破纪录 > 门控 / 关键帧纠正 > 一组结束复盘 > 进场 > 每 3 个 / 每 10 秒 > 出画 > 静止
 */
export const JUDGE_PRIORITY = Object.freeze({
  /**
   * 告别优先级最高：它是这场训练的**最后一句话** ——
   * 一组结束的复盘 / 破纪录都还没回来时，被它抢占（旧结果直接丢弃），
   * 这样「告别之后一句都不许再说」才真的成立。
   */
  'session-end': 120,
  pr: 100,
  'gate-fail2': 80,
  'keyframe-miss2': 80,
  'set-complete': 60,
  'session-start': 50,
  'rep-judge': 40,
  'hold-judge': 40,
  'out-of-frame': 30,
  idle: 20,
});

/** 事件的优先级（不认识 → 0） */
export function judgePriority(event) {
  const value = JUDGE_PRIORITY[String(event || '')];
  return Number.isFinite(value) ? value : 0;
}

/* ------------------------------------------------------------------ *
 * 触发口径（纯函数；测试用假时钟 / 假计数直接断言「各自触发了几次」）
 * ------------------------------------------------------------------ */

/** 每 3 个：第 3 / 6 / 9 … 个（0 不算） */
export function shouldJudgeRep(reps, every = REP_JUDGE_EVERY) {
  const n = Math.round(Number(reps) || 0);
  const step = Math.max(1, Math.round(Number(every) || REP_JUDGE_EVERY));
  return n > 0 && n % step === 0;
}

/** 计时类每 10 秒：10 / 20 / 30 …（0 秒不算） */
export function shouldJudgeHold(elapsedSec, every = HOLD_JUDGE_EVERY_SEC) {
  const sec = Math.round(Number(elapsedSec) || 0);
  const step = Math.max(1, Math.round(Number(every) || HOLD_JUDGE_EVERY_SEC));
  return sec > 0 && sec % step === 0;
}

/** 静止：10 秒起，之后每 10 秒一次（9 秒不问、10 秒问、11~19 秒不问、20 秒再问） */
export function shouldJudgeIdle(
  idleSec,
  { start = IDLE_JUDGE_START_SEC, every = IDLE_JUDGE_EVERY_SEC } = {},
) {
  const sec = Math.round(Number(idleSec) || 0);
  const from = Math.max(1, Math.round(Number(start) || IDLE_JUDGE_START_SEC));
  const step = Math.max(1, Math.round(Number(every) || IDLE_JUDGE_EVERY_SEC));
  return sec >= from && sec % step === 0;
}

/** 出画：10 秒起，之后每 10 秒一次（回到画面后由调用方把秒数清零） */
export function shouldJudgeOutOfFrame(
  outSec,
  { start = OUT_OF_FRAME_JUDGE_START_SEC, every = OUT_OF_FRAME_JUDGE_EVERY_SEC } = {},
) {
  return shouldJudgeIdle(outSec, { start, every });
}

/* ------------------------------------------------------------------ *
 * 模型输出：严格 JSON `{"speak": string|null, "actions": [...]?}`
 * ------------------------------------------------------------------ */

/**
 * 一句话收敛（纯函数）：
 *   - 去掉首尾空白 / 换行 / 引号 / Markdown 装饰；
 *   - 全空白 → ''（调用方按「不说」处理）；
 *   - 超过 `max` 字按**码点**截断（emoji / 中文都不会被切一半）。
 *
 * @param {*} value
 * @param {number} [max]
 * @returns {string}
 */
export function clampJudgeSpeak(value, max = JUDGE_MAX_CHARS) {
  let text = String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  // 模型偶尔会把整句再包一层引号（「"节奏很好"」）→ 去掉最外层成对的引号
  if (/^["'“”].*["'“”]$/.test(text) && text.length > 1) {
    text = text.slice(1, -1).trim();
  }
  const chars = [...text];
  const limit = Math.max(1, Math.round(Number(max) || JUDGE_MAX_CHARS));
  if (chars.length > limit) text = chars.slice(0, limit).join('');
  return text.trim();
}

/**
 * 告别语收敛（纯函数）：**最多 2 句**、最多 `maxChars` 字。
 *
 * 用户要求：「模型给告别语 ≤2 句（肯定 + 具体数字 + 明天见 / 动起来）」——
 * 模型偶尔会多说一句（「辛苦了。明天见。记得拉伸。」），这里按句末标点截到第 2 句，
 * 再按码点截断（emoji / 中文都不会被切一半），最后去掉首尾空白。
 *
 * 句末标点：。！？!?；; 一律算；英文句点只有后面是空白或结尾时才算
 * （否则 `8.5` / `82.5 分` 会被当成一句话说完）。
 *
 * @param {*} value
 * @param {{maxChars?:number, maxSentences?:number}} [opts]
 * @returns {string}
 */
export function clampFarewellSpeak(value, {
  maxChars = FAREWELL_MAX_CHARS,
  maxSentences = FAREWELL_MAX_SENTENCES,
} = {}) {
  let text = String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  // 模型偶尔会包一层 ``` 围栏 / 成对引号（「"今天不错。"」）→ 去掉
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/g, '').trim();
  if (/^["'“”].*["'“”]$/.test(text) && text.length > 1) text = text.slice(1, -1).trim();
  if (!text) return '';
  const limit = Math.max(1, Math.round(Number(maxSentences) || FAREWELL_MAX_SENTENCES));
  const hard = new Set(['。', '！', '？', '；', '!', '?', ';']);
  let seen = 0;
  let cut = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const dot = ch === '.' && (i === text.length - 1 || /\s/.test(text[i + 1] || ''));
    if (!hard.has(ch) && !dot) continue;
    seen += 1;
    if (seen >= limit) { cut = i + 1; break; }
  }
  if (cut > 0 && cut < text.length) text = text.slice(0, cut).trim();
  const chars = [...text];
  const max = Math.max(1, Math.round(Number(maxChars) || FAREWELL_MAX_CHARS));
  if (chars.length > max) text = chars.slice(0, max).join('').trim();
  return text.trim();
}

/**
 * 从一段文本里抠出第一个**配平的** JSON 对象（纯函数）。
 * 会跳过 ```json 围栏、前后多余的解释文字；字符串里的括号不算。
 *
 * @param {string} text
 * @returns {string} 抠出来的 JSON 文本（找不到 → ''）
 */
export function extractJsonObject(text) {
  const raw = String(text == null ? '' : text);
  const start = raw.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
      if (depth < 0) return '';
    }
  }
  return '';
}

/**
 * 解析模型的裁判输出（纯函数）。
 *
 * 严格按 `{"speak": string|null, "actions": [...]?}`：
 *   - 空串 → `{ok:true, speak:null}`（模型什么都没说 = 静默，不是失败）；
 *   - 不是 JSON / 缺 `speak` / `speak` 既不是字符串也不是 null → `ok:false`（调用方静默）；
 *   - `speak` 全空白 → `null`（静默）；
 *   - `actions` 不是数组 → 丢掉（不报错，静默优先）。
 *
 * @param {*} raw 模型返回的原始文本（也接受已经解析过的对象）
 * @returns {{ok:boolean, speak:string|null, actions:object[], empty:boolean, reason:string}}
 */
export function parseJudgeReply(raw) {
  const empty = { ok: true, speak: null, actions: [], empty: true, reason: '' };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return normalizeJudgeObject(raw);
  }
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return empty;
  const json = extractJsonObject(text);
  if (!json) return { ok: false, speak: null, actions: [], empty: false, reason: 'bad-json' };
  let data = null;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, speak: null, actions: [], empty: false, reason: 'bad-json' };
  }
  return normalizeJudgeObject(data);
}

/** 已经是对象时的校验（`parseJudgeReply` 的内部实现，也单独导出方便测试） */
export function normalizeJudgeObject(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, speak: null, actions: [], empty: false, reason: 'bad-json' };
  }
  if (!Object.prototype.hasOwnProperty.call(data, 'speak')) {
    return { ok: false, speak: null, actions: [], empty: false, reason: 'no-speak' };
  }
  const rawSpeak = data.speak;
  if (rawSpeak !== null && typeof rawSpeak !== 'string') {
    return { ok: false, speak: null, actions: [], empty: false, reason: 'bad-speak' };
  }
  const speak = clampJudgeSpeak(rawSpeak);
  const actions = Array.isArray(data.actions)
    ? data.actions.filter((item) => item && typeof item === 'object' && String(item.intent || ''))
    : [];
  return {
    ok: true,
    speak: speak || null,
    actions,
    empty: false,
    reason: '',
  };
}

/* ------------------------------------------------------------------ *
 * 门控诊断 → 「差多少」（纯函数）
 * ------------------------------------------------------------------ */

/**
 * 把识别器的门控诊断行（`debug.diag.gate`）解析成结构化检查项。
 *
 * 识别器那行的格式（`src/engines.js` 的 `gateDiag()`，**代码生成、与语言无关**）：
 *   `✗ torsoIncl 63(>=32)✓ armRaised -1.09(<=0.45)✗`
 * 解析出来就是「哪条门控在看的哪个量、当前值、要求的上下限、差多少」。
 *
 * @param {string} row 诊断行的 value
 * @returns {Array<{metric:string, value:number|null, min:number|null, max:number|null, gap:number, ok:boolean}>}
 */
export function parseGateDiagRow(row) {
  const text = String(row || '');
  const out = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s+(-?\d+(?:\.\d+)?|—)\s*\(([^)]*)\)\s*([✓✗])/g;
  let match = re.exec(text);
  while (match) {
    const metric = match[1];
    const value = match[2] === '—' ? null : Number(match[2]);
    const want = String(match[3] || '');
    const ok = match[4] === '✓';
    const minHit = want.match(/>=\s*(-?\d+(?:\.\d+)?)/);
    const maxHit = want.match(/<=\s*(-?\d+(?:\.\d+)?)/);
    const min = minHit ? Number(minHit[1]) : null;
    const max = maxHit ? Number(maxHit[1]) : null;
    let gap = 0;
    if (!ok && Number.isFinite(value)) {
      if (min !== null && value < min) gap = Math.round((min - value) * 10) / 10;
      else if (max !== null && value > max) gap = Math.round((value - max) * 10) / 10;
    }
    out.push({ metric, value: Number.isFinite(value) ? value : null, min, max, gap, ok });
    match = re.exec(text);
  }
  return out;
}

/** 检查项里「最需要先改」的那一条（没过 + 差距最大；都没过 → 第一条） */
export function worstGateCheck(checks) {
  const list = Array.isArray(checks) ? checks.filter((c) => c && !c.ok) : [];
  if (!list.length) return null;
  return list.reduce((a, b) => (Number(b.gap) || 0) > (Number(a.gap) || 0) ? b : a, list[0]);
}

/* ------------------------------------------------------------------ *
 * 裁判控制器
 * ------------------------------------------------------------------ */

/**
 * 创建裁判控制器。
 *
 * @param {object} opts
 * @param {Function} opts.ask       `(event, {context}) => Promise<{speak:string|null, actions?:object[], ms?:number}>`
 * @param {Function} opts.speak     `(text, {event, fallback:boolean}) => void`（真的念出来）
 * @param {Function} [opts.runActions] `(actions) => void`（可选；模型给 actions 时才执行）
 * @param {Function} [opts.status]  `() => {enabled, muted, speaking}`
 * @param {object}   [opts.diag]    诊断收集器（`judge:ask` / `judge:skip`）
 * @param {Function} [opts.now]     注入时钟（测试用假时钟）
 * @param {Function} [opts.setTimer]/[opts.clearTimer] 注入定时器（测试用假定时器）
 * @param {number}   [opts.timeoutMs]
 * @param {number}   [opts.cooldownMs]
 * @param {number}   [opts.dedupeMs]
 * @param {number}   [opts.maxChars]
 */
export function createJudge({
  ask = null,
  speak = null,
  runActions = null,
  status = null,
  diag = null,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  timeoutMs = JUDGE_TIMEOUT_MS,
  cooldownMs = JUDGE_COOLDOWN_MS,
  dedupeMs = JUDGE_DEDUPE_MS,
  maxChars = JUDGE_MAX_CHARS,
} = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const limit = Math.max(1, Number(timeoutMs) || JUDGE_TIMEOUT_MS);
  const cool = Math.max(0, Number(cooldownMs) || 0);
  const dedupe = Math.max(0, Number(dedupeMs) || 0);
  const maxText = Math.max(1, Number(maxChars) || JUDGE_MAX_CHARS);
  /** 每个事件上一次「真的问出去」的时刻 */
  const lastAskedAt = new Map();
  /** 上一次真的说出去的那句话（同文本 15s 内不重复） */
  let lastText = '';
  let lastTextAt = -Infinity;
  /** 正在飞的那一条：`{epoch, event, priority}`（并发 1） */
  let inflight = null;
  /** 代数：新触发取消旧触发（旧结果回来只丢，不说话） */
  let epoch = 0;
  /** 统计（静默率 / 汇报用） */
  const stats = { asked: 0, spoke: 0, skipped: 0, failed: 0, silenced: 0 };

  const note = (type, data) => {
    try { diag?.record?.(type, data); } catch { /* 诊断永远不能拖垮裁判 */ }
  };

  function snapshotStatus() {
    let st = null;
    try { st = typeof status === 'function' ? status() : null; } catch { st = null; }
    const src = st && typeof st === 'object' ? st : {};
    return {
      enabled: src.enabled !== false,
      muted: src.muted === true,
      speaking: src.speaking === true,
    };
  }

  /** 记一条「跳过」并返回结果（console 上永远看不到，只在诊断里） */
  function skip(reason, event, extra = {}) {
    stats.skipped += 1;
    note('judge:skip', { reason, event: String(event || ''), ...extra });
    return { ok: false, asked: false, spoke: false, skipped: reason, event: String(event || '') };
  }

  /** 真的把一句话念出去（同一句话 15s 内不重复；教练在说话 / 静音 → 丢弃） */
  function say(text, event, { fallback = false } = {}) {
    const body = clampJudgeSpeak(text, maxText);
    if (!body) return false;
    const st = snapshotStatus();
    if (!st.enabled) { skip('coach-off', event, { fallback }); return false; }
    if (st.muted) { skip('muted', event, { fallback }); return false; }
    if (st.speaking) { skip('speaking', event, { fallback }); return false; }
    const at = clock();
    if (dedupe > 0 && body === lastText && at - lastTextAt < dedupe) {
      skip('duplicate', event, { fallback });
      return false;
    }
    lastText = body;
    lastTextAt = at;
    try {
      if (typeof speak === 'function') speak(body, { event, fallback });
    } catch { /* 念话失败不该影响训练 */ }
    return true;
  }

  /**
   * 发起一次裁判（**不重试**；结果通过返回的 Promise 给测试）。
   *
   * @param {string} event `JUDGE_ASK_EVENTS` 之一
   * @param {object} [opts]
   * @param {object} [opts.context] 结构化快照（服务端据此生成 user 消息）
   * @param {string} [opts.fallback] LLM 失败时要念的兜底口令（只有门控那条传）
   * @param {number} [opts.at]      事件时刻（测试传假时钟；默认 clock()）
   * @returns {Promise<{ok:boolean, asked:boolean, spoke:boolean, event:string,
   *                    skipped?:string, code?:string, text?:string, ms?:number}>}
   */
  function request(event, { context = null, fallback = '', at = null } = {}) {
    const ev = String(event || '');
    if (!isJudgeAskEvent(ev)) return Promise.resolve(skip('bad-event', ev));
    if (typeof ask !== 'function') return Promise.resolve(skip('no-client', ev));
    const st = snapshotStatus();
    if (!st.enabled) return Promise.resolve(skip('coach-off', ev));
    if (st.muted) return Promise.resolve(skip('muted', ev));
    /**
     * ⚠️ 这里**不**因为「教练刚好在说话」就放弃：
     * R1 的确定性口令（逐次报数 / 每 5 秒读秒）正好撞在同一些时刻上，请求本身要 1~2 秒才回来，
     * 那时候那句短口令早就说完了。真正的「不叠声」护栏在下面**出声那一刻**（`say()`）：
     * 回来时教练还在说话 → 丢弃并记 `judge:skip {reason:"speaking"}`。
     */
    const explicitAt = at === null || at === undefined ? NaN : Number(at);
    const when = Number.isFinite(explicitAt) ? explicitAt : Number(clock());
    const last = lastAskedAt.get(ev);
    if (last !== undefined && cool > 0 && when - last < cool) {
      return Promise.resolve(skip('cooldown', ev, { since: Math.max(0, when - last) }));
    }
    // 并发 1：新触发取消旧的（优先级更高的一定向后兼容；更低的礼让，别把「破纪录」挤掉）
    if (inflight) {
      if (judgePriority(ev) < inflight.priority) return Promise.resolve(skip('busy', ev));
      epoch += 1;   // 旧请求的结果回来也只会被丢掉
      note('judge:skip', { reason: 'superseded', event: inflight.event });
      inflight = null;
    }
    lastAskedAt.set(ev, when);
    const myEpoch = ++epoch;
    inflight = { epoch: myEpoch, event: ev, priority: judgePriority(ev) };
    stats.asked += 1;
    const started = clock();
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer !== null) { try { clearTimer(timer); } catch { /* ignore */ } }
        if (inflight && inflight.epoch === myEpoch) inflight = null;
        resolve(result);
      };
      /** 失败 / 超时：门控那条回退 R1 模板口令，其余静默（**不重试**） */
      const fail = (code) => {
        const ms = Math.max(0, Number(clock()) - Number(started));
        if (myEpoch !== epoch) { finish({ ok: false, asked: true, spoke: false, event: ev, skipped: 'superseded' }); return; }
        stats.failed += 1;
        let spoke = false;
        if (fallback) spoke = say(fallback, ev, { fallback: true });
        if (!spoke) stats.silenced += 1;
        note('judge:ask', { event: ev, ok: false, ms, spoke, code: String(code || 'judge-error') });
        finish({ ok: false, asked: true, spoke, event: ev, code: String(code || 'judge-error'), ms });
      };
      // 8s 兜底：即使 ask() 永不返回（或注入的客户端忘了超时）也要静默收场
      timer = setTimer(() => fail('timeout'), limit);
      if (timer && typeof timer.unref === 'function') {
        try { timer.unref(); } catch { /* ignore */ }
      }
      Promise.resolve()
        .then(() => ask(ev, { context }))
        .then((res) => {
          if (settled) return;
          const out = res && typeof res === 'object' ? res : {};
          const ms = Math.max(0, Number(clock()) - Number(started));
          if (myEpoch !== epoch) {
            finish({ ok: false, asked: true, spoke: false, event: ev, skipped: 'superseded' });
            return;
          }
          const actions = Array.isArray(out.actions) ? out.actions : [];
          if (actions.length && typeof runActions === 'function') {
            try { runActions(actions); } catch { /* 动作失败不该影响这句话 */ }
          }
          const text = clampJudgeSpeak(out.speak, maxText);
          const spoke = text ? say(text, ev) : false;
          if (!spoke) stats.silenced += 1;
          else stats.spoke += 1;
          note('judge:ask', { event: ev, ok: true, ms, spoke });
          finish({ ok: true, asked: true, spoke, event: ev, text, ms, actions: actions.length });
        })
        .catch((err) => { fail((err && err.code) || 'judge-error'); });
    });
  }

  /** 清空冷却 / 去重 / 统计（换一组 / 换训练 / 测试用例之间） */
  function reset() {
    lastAskedAt.clear();
    lastText = '';
    lastTextAt = -Infinity;
    inflight = null;
    epoch += 1;
    stats.asked = 0;
    stats.spoke = 0;
    stats.skipped = 0;
    stats.failed = 0;
    stats.silenced = 0;
    return stats;
  }

  /**
   * 取消正在飞的那一条（**不出声**，结果回来也丢掉）。
   *
   * 用途：一次训练结束 → 告别要占用唯一的那条通道，先礼让：
   * 正在飞的「一组结束复盘 / 破纪录」直接作废，保证整场只留告别这一句。
   *
   * @param {string} [reason] 诊断里的原因（默认 `cancelled`）
   * @returns {boolean} 是否真的取消了一条
   */
  function cancel(reason = 'cancelled') {
    if (!inflight) return false;
    note('judge:skip', { reason: String(reason || 'cancelled'), event: inflight.event });
    inflight = null;
    epoch += 1;
    return true;
  }

  return {
    request,
    reset,
    cancel,
    /** 当前是否有一条在飞（测试断言并发 1 用） */
    get inflight() { return inflight ? { ...inflight } : null; },
    /** 统计：`{asked, spoke, skipped, failed, silenced}`（silenced = 问了但没出声） */
    get stats() { return { ...stats }; },
    /** 静默率（mock / 真实都适用）：没出声 / 问了 */
    get silenceRate() { return stats.asked ? Math.round((stats.silenced / stats.asked) * 100) : 0; },
    timeoutMs: limit,
    cooldownMs: cool,
    dedupeMs: dedupe,
    maxChars: maxText,
  };
}

export default {
  JUDGE_EVENTS,
  JUDGE_ASK_EVENTS,
  JUDGE_FAREWELL_EVENTS,
  isJudgeEvent,
  isJudgeAskEvent,
  isJudgeFarewellEvent,
  JUDGE_TIMEOUT_MS,
  JUDGE_COOLDOWN_MS,
  JUDGE_DEDUPE_MS,
  JUDGE_MAX_CHARS,
  FAREWELL_MAX_CHARS,
  FAREWELL_MAX_SENTENCES,
  REP_JUDGE_EVERY,
  HOLD_JUDGE_EVERY_SEC,
  IDLE_JUDGE_START_SEC,
  IDLE_JUDGE_EVERY_SEC,
  OUT_OF_FRAME_JUDGE_START_SEC,
  OUT_OF_FRAME_JUDGE_EVERY_SEC,
  GATE_FAIL_JUDGE_STREAK,
  KEYFRAME_MISS_JUDGE_STREAK,
  JUDGE_PRIORITY,
  judgePriority,
  shouldJudgeRep,
  shouldJudgeHold,
  shouldJudgeIdle,
  shouldJudgeOutOfFrame,
  clampJudgeSpeak,
  clampFarewellSpeak,
  extractJsonObject,
  parseJudgeReply,
  normalizeJudgeObject,
  parseGateDiagRow,
  worstGateCheck,
  createJudge,
};
