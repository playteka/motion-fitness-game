/**
 * AI 语音教练的**适配器接口 + mock 实现**（P3.0 基座）。
 *
 * 设计目标：界面与会话逻辑只认接口，不认厂商。之后每一步只换一个文件里的一套实现：
 *
 *   - `createAsr()` 语音识别（speech → text）
 *       P3.1 换成云端流式 ASR；本轮是浏览器 `SpeechRecognition || webkitSpeechRecognition`
 *       的**临时替代**（MockAsr），浏览器不支持时返回 `false` 并在 UI 上明确提示，不抛错。
 *   - `createLlm()` 教练回复（text → text）
 *       P3.3 换成 LLM + 工具；本轮是**规则罐头**（MockLlm），**绝不执行任何界面命令**。
 *   - `createTts()` 语音合成（text → speech）
 *       P3.4 换成带打断的流式 TTS；本轮直接包 `speechSynthesis`，不可用时只出字幕。
 *
 * 另外给了 `createMic()`：打开 / 释放麦克风轨道。P3.1 之后即使换成云端 ASR，这一层也不用动。
 *
 * 三个接口的共同约定：
 *   - 工厂函数**不碰 DOM**、加载时不抛错；所有浏览器能力都在调用时探测。
 *   - 适配器只做「能力」，**不渲染**（字幕 / 状态环在 coach.js）。
 *   - 任何失败都走回调或返回值，不把异常抛给会话状态机（会话负责落 error 状态）。
 */

import { t, tList, getLang, getMeta } from '../i18n.js';

/* ================================================================== *
 * 工具
 * ================================================================== */

/** 浏览器全局对象（Node 里测试时没有 window，退回 globalThis） */
function rootWin(win) {
  if (win) return win;
  if (typeof window !== 'undefined') return window;
  return typeof globalThis !== 'undefined' ? globalThis : {};
}

/** 当前语言的 BCP-47 语音标签（zh-CN / en-US） */
function speechLang(lang) {
  if (typeof lang === 'function') return lang();
  if (lang) return String(lang);
  try {
    const meta = getMeta();
    if (meta && meta.speechLang) return meta.speechLang;
  } catch { /* ignore */ }
  return getLang() === 'zh' ? 'zh-CN' : 'en-US';
}

/* ================================================================== *
 * 麦克风：权限 + 轨道生命周期（打开 / 释放都只在这里）
 * ================================================================== */

/**
 * 麦克风适配器。
 *
 *   open()  → Promise<MediaStreamTrack[]>   （拒绝 / 没有设备时 reject，由会话落 error）
 *   close() → void                           （每一轨都 stop，绝不留后台麦克风）
 *   active  → boolean                        （现在是否还握着轨道）
 */
export function createMic({ win = null } = {}) {
  const w = rootWin(win);
  let stream = null;
  let tracks = [];

  return {
    kind: 'browser',
    async open() {
      const media = w.navigator && w.navigator.mediaDevices;
      if (!media || typeof media.getUserMedia !== 'function') {
        const err = new Error('getUserMedia is not available');
        err.code = 'mic-unsupported';
        throw err;
      }
      stream = await media.getUserMedia({ audio: true });
      tracks = stream && typeof stream.getAudioTracks === 'function'
        ? stream.getAudioTracks()
        : (stream && typeof stream.getTracks === 'function' ? stream.getTracks() : []);
      if (!tracks.length) {
        this.close();
        const err = new Error('no audio track');
        err.code = 'mic-empty';
        throw err;
      }
      return tracks;
    },
    close() {
      for (const track of tracks) {
        try { track.stop(); } catch { /* ignore */ }
      }
      tracks = [];
      stream = null;
    },
    get active() { return tracks.length > 0; },
    get trackCount() { return tracks.length; },
  };
}

/* ================================================================== *
 * ASR（mock：浏览器内置 SpeechRecognition）
 * ================================================================== */

/** 浏览器里的识别构造器；不支持时返回 null（每次调用都重新探测，方便测试里删掉它） */
export function speechRecognitionCtor(win = null) {
  const w = rootWin(win);
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/**
 * Mock ASR 的会话行为：
 *   - `continuous = true` / `interimResults = true`，`lang` 跟随界面语言（zh-CN / en-US）；
 *   - 一句话结束时把**最终结果**交给 `onResult(text, { isFinal: true })`；
 *   - 中间结果交给可选的 `onInterim(text)`（只用于字幕预览）；
 *   - `end` 之后自动重启：指数退避（400ms → 800ms → 1600ms，封顶 2s），
 *     **连续 3 次都没拿到结果就停**，并 `onError({ code: 'asr', fatal: true })` 让 UI 提示；
 *   - 浏览器不支持时 `start()` 返回 `false`，**不抛错**（会话据此落 error 状态）。
 */
export function createAsr({ win = null, lang = null } = {}) {
  const w = rootWin(win);
  let recognition = null;
  let running = false;
  let manualStop = true;
  let failures = 0;
  let restartTimer = null;
  const handlers = { result: null, interim: null, error: null, end: null, state: null };

  function clearRestart() {
    if (restartTimer !== null) {
      try { clearTimeout(restartTimer); } catch { /* ignore */ }
      restartTimer = null;
    }
  }

  function restart() {
    restartTimer = null;
    if (manualStop || !recognition) return;
    startInternal();
  }

  function startInternal() {
    const Ctor = speechRecognitionCtor(w);
    if (!Ctor) {
      running = false;
      return false;
    }
    let rec;
    try { rec = new Ctor(); } catch { return false; }
    recognition = rec;
    rec.lang = speechLang(lang);
    rec.continuous = true;
    rec.interimResults = true;

    rec.onstart = () => {
      running = true;
      handlers.state?.('listening', { failures });
    };
    rec.onresult = (event) => {
      if (!event || !event.results) return;
      const start = Number(event.resultIndex) || 0;
      let interim = '';
      for (let i = start; i < event.results.length; i += 1) {
        const item = event.results[i];
        const alt = item && item[0];
        const text = alt && alt.transcript ? String(alt.transcript) : '';
        if (!text) continue;
        if (item.isFinal) {
          failures = 0;   // 真的识别出了东西：连续失败计数清零
          handlers.result?.(text, { isFinal: true });
        } else {
          interim += text;
        }
      }
      if (interim) handlers.interim?.(interim);
    };
    rec.onerror = (event) => {
      const code = (event && event.error) || 'asr';
      const fatal = code === 'not-allowed' || code === 'service-not-allowed'
        || code === 'audio-capture' || code === 'unsupported';
      if (fatal) {
        manualStop = true;
        running = false;
        clearRestart();
        handlers.error?.({ code: code === 'audio-capture' ? 'mic' : (code === 'unsupported' ? 'asr-unsupported' : 'mic'), fatal: true, raw: code });
      }
      // 非致命错误（no-speech / aborted / network）交给 end 的退避重启处理
    };
    rec.onend = () => {
      running = false;
      handlers.end?.();
      if (manualStop) return;
      failures += 1;
      if (failures >= 3) {
        manualStop = true;
        handlers.error?.({ code: 'asr', fatal: true, attempts: failures });
        return;
      }
      const delay = Math.min(2000, 400 * (2 ** (failures - 1)));
      handlers.state?.('restarting', { failures, delay });
      clearRestart();
      restartTimer = setTimeout(restart, delay);
    };
    try {
      rec.start();
      running = true;
      return true;
    } catch {
      running = false;
      return false;
    }
  }

  const api = {
    kind: 'mock',
    name: 'webkitSpeechRecognition',
    get supported() { return !!speechRecognitionCtor(w); },
    get active() { return running; },
    get attempts() { return failures; },
    get lang() { return speechLang(lang); },
    onResult(fn) { handlers.result = fn; return api; },
    onInterim(fn) { handlers.interim = fn; return api; },
    onError(fn) { handlers.error = fn; return api; },
    onEnd(fn) { handlers.end = fn; return api; },
    onState(fn) { handlers.state = fn; return api; },
    /** 开始聆听；返回 false = 这个浏览器不支持（调用方落 error 状态，不抛错） */
    start() {
      if (!speechRecognitionCtor(w)) {
        running = false;
        return false;
      }
      if (running && recognition) return true;
      manualStop = false;
      failures = 0;
      clearRestart();
      return startInternal();
    },
    stop() {
      manualStop = true;
      running = false;
      clearRestart();
      const rec = recognition;
      recognition = null;
      if (rec) {
        try { rec.onend = null; } catch { /* ignore */ }
        try { rec.stop?.(); } catch { /* ignore */ }
        try { rec.abort?.(); } catch { /* ignore */ }
      }
    },
  };
  return api;
}

/* ================================================================== *
 * LLM（mock：规则罐头；P3.3 只换这里）
 * ================================================================== */

/** 问候 / 提问 / 感谢的简单模式（用 unicode 转义写中文，源码里不留写死的中文文案） */
const RE_GREETING = /^\s*(?:\u4f60\u597d|\u60a8\u597d|\u55e8|\u54c8\u55bd|\u65e9\u4e0a\u597d|\u665a\u4e0a\u597d|hi|hello|hey|yo)(?=$|[\s,.!?~\uff0c\u3002\uff01\uff1f])/i;
const RE_QUESTION = /[?\uff1f]|(?:\u4ec0\u4e48|\u600e\u4e48|\u5982\u4f55|\u4e3a\u4ec0\u4e48|\u80fd\u4e0d\u80fd|\u53ef\u4ee5\u5417|\u54ea\u4e2a|\u591a\u5c11|what|how|why|can i|should i|which)/i;
const RE_THANKS = /(?:\u8c22\u8c22|\u591a\u8c22|thanks|thank you|thx)/i;

/**
 * Mock LLM（规则罐头）。
 *
 *   reply(text) → { text, key, index? }
 *
 * 命中的都是 `src/locales/*.js` 里 `coach.reply.*` / `coach.encourage` 的词条，
 * 所以**每一句都能追溯到 locales**（测试会逐句核对）。
 *
 * ⚠️ 这一层只负责「说人话」，**不执行任何界面命令**（开合跳、退出、调音量…
 *    一律不认）。命令解析与执行是 P3.2，LLM + 工具调用是 P3.3。
 */
export function createLlm({ pick = Math.random } = {}) {
  return {
    kind: 'mock',
    /** text → { text, key, index? }；同步返回，P3.3 可以返回 Promise（会话两种都支持） */
    reply(text) {
      const raw = String(text == null ? '' : text).trim();
      if (!raw) return { text: t('coach.reply.fallback'), key: 'coach.reply.fallback' };
      if (RE_GREETING.test(raw)) return { text: t('coach.reply.greeting'), key: 'coach.reply.greeting' };
      if (RE_THANKS.test(raw)) return { text: t('coach.reply.thanks'), key: 'coach.reply.thanks' };
      if (RE_QUESTION.test(raw)) return { text: t('coach.reply.question'), key: 'coach.reply.question' };
      const list = tList('coach.encourage');
      const index = Math.min(list.length - 1, Math.max(0, Math.floor(Number(pick()) * list.length) || 0));
      return { text: list[index], key: 'coach.encourage', index };
    },
  };
}

/* ================================================================== *
 * TTS（mock：speechSynthesis；P3.4 只换这里）
 * ================================================================== */

/**
 * Mock TTS。
 *
 *   speak(text, { onEnd, onError }) → boolean   （true = 真的交给系统念了）
 *   cancel()                        → void
 *   setRate(n)                      → 语速（0.5 ~ 2）
 *
 * `speechSynthesis` 不可用时返回 `false`（**只出字幕**，不抛错）；会话会按字数留一段
 * 展示时间再回到聆听状态。
 */
export function createTts({ win = null, lang = null, rate = 1 } = {}) {
  const w = rootWin(win);
  let speaking = false;
  let currentRate = Number(rate) > 0 ? Number(rate) : 1;

  function synth() { return w.speechSynthesis || null; }
  function Utterance() {
    return w.SpeechSynthesisUtterance
      || (typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : null);
  }

  const api = {
    kind: 'mock',
    name: 'speechSynthesis',
    get supported() { return !!(synth() && Utterance()); },
    get speaking() { return speaking; },
    get rate() { return currentRate; },
    get lang() { return speechLang(lang); },
    setRate(n) {
      const v = Number(n);
      if (Number.isFinite(v) && v > 0) currentRate = Math.min(2, Math.max(0.5, v));
      return currentRate;
    },
    speak(text, { onEnd = null, onError = null } = {}) {
      const s = synth();
      const U = Utterance();
      const body = String(text == null ? '' : text);
      if (!s || !U || !body.trim()) return false;
      try {
        s.cancel();
        const u = new U(body);
        u.lang = speechLang(lang);
        u.rate = currentRate;
        u.onend = () => { speaking = false; try { onEnd?.(); } catch { /* ignore */ } };
        u.onerror = (err) => { speaking = false; try { onError?.(err); } catch { /* ignore */ } };
        s.speak(u);
        speaking = true;
        return true;
      } catch {
        speaking = false;
        return false;
      }
    },
    cancel() {
      speaking = false;
      try { synth()?.cancel(); } catch { /* ignore */ }
    },
  };
  return api;
}
