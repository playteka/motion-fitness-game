/**
 * 语音链路诊断（P3.5）。
 *
 * 用户反馈「说话没有字幕，但麦克风亮着」—— 健康检查（GET /asr → configured:true）是好的，
 * 所以问题只可能落在浏览器侧：麦克风权限 / 共享流 / AudioWorklet / WebSocket / 帧格式 / 回退。
 * 这些在用户那边**看不见**，远程也没法猜。这个模块做三件事：
 *
 *   1) `createDiag()`：把关键事件收集成一条条小记录（**绝不含音频**，文本截断到 80 字），
 *      每 2 秒或满 20 条批量 POST 到预览服务器的 `/__debug/log?file=coach-diag.jsonl`
 *      （复用 `preview-server.js` 已有的落盘接口，`logs/` 已 gitignore）；
 *   2) `snapshot()`：给界面上的「🐞 诊断」小面板读的实时结构（路由 / WS / 帧数 / 计数 / 错误…）；
 *   3) 上传失败**静默丢弃**，绝不把异常抛给教练主流程（诊断不能拖垮训练）。
 *
 * 纯逻辑 + 可注入（fetch / timer / now），Node 里可直接单测（见 tests/test-voice.mjs `[24]`）。
 *
 * 安全约定（AGENTS.md）：
 *   - 只上报**计数、状态、错误名/错误码、截断后的文本**；音频采样 / PCM / ArrayBuffer 一律丢弃；
 *   - 键名里带 key / token / secret / password / audio / pcm / sample 的字段直接 `[redacted]`；
 *   - 值里的 `sk-…` / Bearer 头 / 超长 token 也会被替换成 `[redacted]`；
 *   - 本模块**不碰 DOM**，也不知道 coach.env 的内容。
 */

import { EXPECTED_BYTES_PER_SEC } from './pcm.js';

export const DIAG_FILE = 'coach-diag.jsonl';
export const DIAG_ENDPOINT = `/__debug/log?file=${DIAG_FILE}`;
export const DIAG_FLUSH_MS = 2000;
export const DIAG_BATCH_SIZE = 20;
export const DIAG_MAX_TEXT = 80;

/** 16k / 16bit / 单声道应有的发送码率（与 pcm.js 的 EXPECTED_BYTES_PER_SEC 同源，不另抄一份） */
export { EXPECTED_BYTES_PER_SEC };

/** 这些键名的值一律不上报（音频 / 凭证 / 原始缓冲） */
const SECRET_KEY = /(?:api[-_]?key|access[-_]?key|secret|token|password|passwd|credential|authorization|bearer|audio|pcm|sample|buffer|waveform|arraybuffer)/i;

/**
 * 文本脱敏 + 截断（纯函数）。
 * 顺序：替换明显的凭证形态 → 压掉换行 / 连续空白 → 截到 `max` 个字符。
 */
export function scrubText(value, max = DIAG_MAX_TEXT) {
  let s = String(value == null ? '' : value);
  s = s
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{6,}/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|ak|api|key|token|secret)[-_][A-Za-z0-9_-]{6,}\b/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = Math.max(1, Number(max) || DIAG_MAX_TEXT);
  return s.length > limit ? s.slice(0, limit) : s;
}

/** 单个字段的脱敏（纯函数；键名敏感 → 直接 `[redacted]`） */
export function safeValue(key, value, max = DIAG_MAX_TEXT) {
  if (key && SECRET_KEY.test(String(key))) return '[redacted]';
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrubText(value, max);
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return '[bytes]';
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(value)) return '[bytes]';
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => safeValue('', item, max));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 12)) out[k] = safeValue(k, v, max);
    return out;
  }
  return scrubText(value, max);
}

/** 一条事件 → 可落盘的 JSON 对象（纯函数；测试直接断言它不含密钥 / 音频） */
export function makeEntry(type, data = {}, { now = Date.now, maxText = DIAG_MAX_TEXT } = {}) {
  const entry = { t: Number(now()) || 0, type: scrubText(type, 40) };
  for (const [k, v] of Object.entries(data || {}).slice(0, 16)) {
    if (k === 'type' || k === 't') continue;
    entry[k] = safeValue(k, v, maxText);
  }
  return entry;
}

/** 空快照（结构固定，界面 / 测试都按它读） */
function blankSnapshot() {
  return {
    events: 0,
    pending: 0,
    sent: 0,
    failed: 0,
    lastEventAt: 0,
    lastType: '',
    route: '',
    ws: { state: 'idle', code: null, reason: '' },
    frames: { n: 0, bytes: 0, bytesPerSec: 0, expected: EXPECTED_BYTES_PER_SEC },
    partials: 0,
    finals: 0,
    lastPartial: '',
    lastFinal: '',
    lastError: '',
    asrError: null,
    mic: { state: 'idle', tracks: 0, labels: [], error: '' },
    audio: { sampleRate: 0, state: '' },
    capture: '',
    worklet: { state: 'none', error: '' },
    /**
     * TTS（P3.6 整段 / P3.4 流式 + 插话打断）：
     *   state = idle | say | fallback | fail | first | barge
     *   firstAudioMs = 最近一次流式「首字」耗时；bargeMs = 最近一次插话打断耗时
     *   mode = 流式用的播放引擎（mse / decode）；where = 失败发生在哪一级
     */
    tts: { state: 'idle', last: '', firstAudioMs: 0, bargeMs: 0, mode: '', where: '', errName: '' },
    /**
     * 会话状态机（`session:*`）：
     *   state = '' | listening | thinking | speaking | paused | off | error
     *   sayBy = 最近一句是哪种回合（cmd 命令 / confirm 确认 / tool 工具 / llm / intro）
     *   stopBy = 最近一次 `stop()` 是谁做的（user / pagehide / destroy）——「谁关的会话」
     *   endBy = 最近一次回到 listening 的原因（tts-end / tts-error / timeout / hold）
     * 用户反馈「听不到声音 + 之后的话都没识别」靠这三行就能定位。
     */
    session: { state: '', sayBy: '', stopBy: '', endBy: '' },
  };
}

/**
 * 创建诊断收集器。
 *
 * @param {object}   [opts]
 * @param {object}   [opts.win]       浏览器 window（取 fetch / 定时器；测试可注入假对象）
 * @param {Function} [opts.fetch]     注入的 fetch（默认 win.fetch → 全局 fetch）
 * @param {string}   [opts.endpoint]  落盘地址（默认 /__debug/log?file=coach-diag.jsonl）
 * @param {number}   [opts.flushMs]   批量上报间隔（默认 2000ms）
 * @param {number}   [opts.batchSize] 满多少条立即上报（默认 20）
 * @param {number}   [opts.maxText]   单条文本上限（默认 80 字）
 * @param {boolean}  [opts.timer]     是否自动定时上报（Node 单测默认关；页面传 true）
 * @param {Function} [opts.now]       注入时钟（测试固定时间戳）
 * @param {Function} [opts.setTimer]  注入 setTimeout
 * @param {Function} [opts.clearTimer]注入 clearTimeout
 */
export function createDiag({
  win = null,
  fetch: fetchImpl = null,
  endpoint = DIAG_ENDPOINT,
  flushMs = DIAG_FLUSH_MS,
  batchSize = DIAG_BATCH_SIZE,
  maxText = DIAG_MAX_TEXT,
  timer = false,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const w = win || (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {}));
  const state = blankSnapshot();
  let pending = [];
  let timerId = null;
  let closed = false;
  const listeners = new Set();

  function snapshot() {
    return {
      ...state,
      pending: pending.length,
      ws: { ...state.ws },
      frames: { ...state.frames },
      mic: { ...state.mic, labels: [...state.mic.labels] },
      audio: { ...state.audio },
      worklet: { ...state.worklet },
      tts: { ...state.tts },
      session: { ...state.session },
      asrError: state.asrError ? { ...state.asrError } : null,
    };
  }

  function emit() {
    const snap = snapshot();
    for (const fn of listeners) {
      try { fn(snap); } catch { /* 一个订阅者出错不该影响记录 */ }
    }
  }

  function setLastError(text) {
    state.lastError = scrubText(text, maxText);
  }

  /** 把事件映射进快照的计数器（界面只读快照，不用自己解析事件流） */
  function absorb(entry) {
    const type = entry.type;
    state.events += 1;
    state.lastEventAt = entry.t;
    state.lastType = type;
    switch (type) {
      case 'route:volc':
        state.route = 'volc';
        break;
      case 'route:webspeech':
        state.route = 'webspeech';
        break;
      case 'ws:connecting':
        state.ws = { state: 'connecting', code: null, reason: '' };
        break;
      case 'ws:open':
        state.ws = { state: 'open', code: null, reason: '' };
        break;
      case 'ws:close':
        state.ws = {
          state: 'closed',
          code: Number.isFinite(Number(entry.code)) ? Number(entry.code) : 0,
          reason: String(entry.reason || ''),
        };
        break;
      case 'ws:error':
        state.ws = { state: 'error', code: null, reason: String(entry.name || entry.message || '') };
        setLastError(`ws: ${entry.name || 'error'}`);
        break;
      case 'ws:firstFrame':
        state.frames = { ...state.frames, n: 1, bytes: Number(entry.bytes) || 0 };
        break;
      case 'ws:frames':
        state.frames = { ...state.frames, n: Number(entry.n) || 0, bytes: Number(entry.bytes) || 0 };
        break;
      case 'ws:rate':
        // 实时码率（用户要求的那一行）：正常 ≈ 32000 B/s；偏低说明采集 / 定帧没做对
        state.frames = {
          ...state.frames,
          bytesPerSec: Number(entry.bytesPerSec) || 0,
          expected: Number(entry.expected) || state.frames.expected || EXPECTED_BYTES_PER_SEC,
        };
        break;
      case 'asr:partial':
        state.partials += 1;
        state.lastPartial = String(entry.text || '');
        break;
      case 'asr:final':
        state.finals += 1;
        state.lastFinal = String(entry.text || '');
        break;
      case 'asr:error':
        state.asrError = {
          code: String(entry.code || ''),
          message: String(entry.message || ''),
        };
        setLastError(`asr: ${entry.code || 'error'}`);
        break;
      case 'mic:request':
        state.mic = { state: 'request', tracks: 0, labels: [], error: '' };
        break;
      case 'mic:ok':
        state.mic = {
          state: 'ok',
          tracks: Number(entry.tracks) || 0,
          labels: Array.isArray(entry.labels) ? entry.labels.map(String) : [],
          error: '',
        };
        break;
      case 'mic:fail':
        state.mic = {
          state: 'fail',
          tracks: 0,
          labels: [],
          error: String(entry.name || entry.message || 'mic'),
        };
        setLastError(`mic: ${entry.name || 'fail'}`);
        break;
      case 'mic:release':
        state.mic = { ...state.mic, state: 'released' };
        break;
      case 'ctx:sampleRate':
        state.audio = {
          sampleRate: Number(entry.value) || 0,
          state: String(entry.state || ''),
        };
        break;
      case 'worklet:ok':
        state.worklet = { state: 'ok', error: '' };
        state.capture = 'worklet';
        break;
      case 'worklet:fail':
        state.worklet = {
          state: 'fail',
          error: String(entry.name || entry.message || 'fail'),
        };
        setLastError(`worklet: ${entry.name || 'fail'}`);
        break;
      case 'capture:mode':
        state.capture = String(entry.mode || '');
        break;
      case 'tts:say':
        state.tts = { ...state.tts, state: 'say', last: String(entry.chars || '') };
        break;
      case 'tts:first-audio':
        // 流式首字延迟（用户要求：诊断面板显示「首字 xx ms」）+ 用的是哪个播放引擎（mse / decode）
        state.tts = {
          ...state.tts,
          state: 'first',
          firstAudioMs: Math.max(0, Number(entry.ms) || 0),
          mode: String(entry.mode || ''),
        };
        break;
      case 'tts:stream-fail':
        // 流式不可用 / 失败 → 已经（或即将）走整段 / 系统 TTS，不是致命错误
        state.tts = { ...state.tts, state: 'fallback', last: String(entry.code || 'stream') };
        break;
      case 'tts:whole':
        state.tts = { ...state.tts, state: 'say', last: 'whole' };
        break;
      case 'tts:barge-in':
        // 用户插话打断：面板上留最近一次的耗时（触发 → 静音）
        state.tts = {
          ...state.tts,
          state: 'barge',
          bargeMs: Math.max(0, Number(entry.ms) || 0),
        };
        break;
      case 'tts:fallback':
        // 火山 TTS 超时 / 502 / 网络错 → 已经自动改用系统 TTS（不是致命错误，只在面板留痕）
        state.tts = { ...state.tts, state: 'fallback', last: String(entry.code || '') };
        break;
      case 'tts:fail':
        // where = 哪一级失败（stream / whole / system）+ 真实 errName，面板一眼看出卡在哪
        state.tts = {
          ...state.tts,
          state: 'fail',
          last: String(entry.code || ''),
          where: String(entry.where || ''),
          errName: String(entry.errName || ''),
        };
        break;
      /* ---------------- 会话状态机（session:*） ----------------
       * 用户要求「以后一眼看出是谁关的会话」：stop/pause 都带 by，
       * say/speak-end 也各留一行，日志里能对上「final → say → speak-end → listening」。 */
      case 'session:start':
        state.session = { ...state.session, state: 'listening', stopBy: '', endBy: '' };
        break;
      case 'session:resume':
        state.session = { ...state.session, state: 'listening' };
        break;
      case 'session:say':
        state.session = {
          ...state.session,
          state: entry.muted === true || entry.speak === false ? 'listening' : 'speaking',
          sayBy: String(entry.by || ''),
        };
        break;
      case 'session:speak-end':
        state.session = {
          ...state.session,
          state: 'listening',
          endBy: String(entry.by || ''),
        };
        break;
      case 'session:speak-timeout':
        // 看门狗到点：紧接着一定还有一条 session:speak-end {by:'timeout'}，这里不改状态
        break;
      case 'session:interrupt':
        state.session = { ...state.session, state: 'listening' };
        break;
      case 'session:pause':
        state.session = { ...state.session, state: 'paused' };
        break;
      case 'session:stop':
        // 「谁关的会话」：by = user（Ctrl+I / 设置）/ pagehide（页面卸载）/ destroy
        state.session = {
          ...state.session,
          state: 'off',
          stopBy: String(entry.by || ''),
        };
        break;
      case 'session:fail':
        state.session = { ...state.session, state: 'error' };
        setLastError(`session: ${entry.code || 'fail'}`);
        break;
      case 'vu:open':
        break;
      case 'vu:fail':
        setLastError(`vu: ${entry.name || 'fail'}`);
        break;
      case 'pose:load-fail':
        // 姿态模型加载失败（用户反馈「点开始就姿态模型加载失败」）：
        // 把**阶段 + 真实错误名**留在面板 / 快照上，事后读日志能直接看出卡在哪一步。
        setLastError(`pose: ${entry.stage || 'load'} ${entry.name || ''}`.trim());
        break;
      case 'pose:init-fail':
        // 初始化识别器每一次失败（GPU 卡住 → 超时 → 切 CPU → CPU 也失败，整条链子都会留痕）
        setLastError(`pose:init ${entry.delegate || ''} ${entry.name || ''}`.trim());
        break;
      case 'pose:init-timeout':
        // 初始化超时（用户今天的报错形态：不是 reject，是卡住到超时）
        setLastError(`pose:init timeout ${entry.delegate || ''}`.trim());
        break;
      case 'pose:delegate':
        // GPU 建不起来 → 已自动切 CPU（不是错误，只是排障线索，不写 lastError）
        break;
      case 'pose:slow-load':
        // 「加载偏慢」：单块速率 < 1MB/s 且已用 > 8 秒（阈值见 pose-engine.js 的 SLOW_LOAD_*）。
        // 只有 bps / elapsedMs 两个数字，**不含任何文件内容**。
        // 故意不写 lastError：慢不是错误（界面已经有一条黄色提示），写进去会让诊断面板看起来像挂了。
        break;
      default:
        break;
    }
  }

  function pickFetch() {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (w && typeof w.fetch === 'function') return w.fetch.bind(w);
    if (typeof fetch === 'function') return fetch;
    return null;
  }

  /**
   * 把当前积压的事件一次性 POST 出去。
   * 失败 / 超时 / 没有 fetch → 静默丢弃这一批（`failed += 1`），**永不 reject**。
   * @returns {Promise<boolean>} 是否成功
   */
  async function flush() {
    if (timerId !== null) {
      try { clearTimer(timerId); } catch { /* ignore */ }
      timerId = null;
    }
    if (!pending.length) return true;
    const batch = pending;
    pending = [];
    const send = pickFetch();
    if (!send) {
      state.failed += batch.length;
      emit();
      return false;
    }
    try {
      const body = batch.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
      const res = await send(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-ndjson' },
        body,
        keepalive: true,
      });
      if (res && res.ok === false) throw new Error(`http ${res.status || 'error'}`);
      state.sent += batch.length;
      emit();
      return true;
    } catch {
      state.failed += batch.length;
      emit();
      return false;
    }
  }

  function schedule() {
    if (!timer || closed || timerId !== null || !pending.length) return;
    timerId = setTimer(() => {
      timerId = null;
      flush().then(() => schedule()).catch(() => { /* flush 本身不会 reject，这里只兜底 */ });
    }, flushMs);
    if (timerId && typeof timerId.unref === 'function') {
      try { timerId.unref(); } catch { /* ignore */ }
    }
  }

  /** 记一条事件（唯一的写入口） */
  function record(type, data = {}) {
    if (closed) return snapshot();
    const entry = makeEntry(type, data, { now, maxText });
    absorb(entry);
    pending.push(entry);
    emit();
    if (pending.length >= batchSize) flush().catch(() => { /* 静默 */ });
    else schedule();
    return snapshot();
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** 关闭：清定时器、丢积压（页面卸载时用；不阻塞） */
  function close() {
    closed = true;
    if (timerId !== null) {
      try { clearTimer(timerId); } catch { /* ignore */ }
      timerId = null;
    }
    pending = [];
    listeners.clear();
  }

  return {
    endpoint,
    flushMs,
    batchSize,
    maxText,
    record,
    flush,
    snapshot,
    subscribe,
    close,
    get pending() { return pending.length; },
    get sent() { return state.sent; },
    get failed() { return state.failed; },
  };
}

export default { createDiag, makeEntry, scrubText, safeValue };
