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
import { downsampleToPcm16 } from './pcm.js';

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
    /** 给火山采集层用的原始 MediaStream（只读；stop 仍由 close() 负责） */
    get stream() { return stream; },
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

/* ================================================================== *
 * ASR 选路（P3.1）：优先本机火山代理，代理不可用就回退浏览器 Web Speech
 * ================================================================== */

/** 本机代理的默认地址（浏览器只知道这个地址，凭证全在代理进程的 coach.env 里） */
export const DEFAULT_ASR_WS_URL = 'ws://127.0.0.1:4180/asr';

/** 三条路：火山代理 / 浏览器自带 / 都没有 */
export const ASR_ROUTES = Object.freeze({
  VOLC: 'volc',
  WEB_SPEECH: 'webspeech',
  NONE: 'none',
});

/**
 * 代理地址：默认 `ws://127.0.0.1:4180/asr`，可被 `window.__MFG_ASR_WS__` 覆盖（测试 / 换端口）。
 * 显式写 `off` / `none` / `0` / `false` 可以强制回退到 Web Speech。
 */
export function resolveAsrUrl(win = null) {
  const w = rootWin(win);
  const raw = w.__MFG_ASR_WS__;
  if (typeof raw !== 'string') return DEFAULT_ASR_WS_URL;
  const value = raw.trim();
  if (!value) return DEFAULT_ASR_WS_URL;
  if (/^(off|none|false|0)$/i.test(value)) return '';
  return value;
}

/**
 * 选哪一路（纯函数，测试直接传假 window）。
 *
 * 火山那一路需要三样东西同时成立：
 *   - 一个非空的代理地址；
 *   - `WebSocket`（收发 PCM / 识别结果）；
 *   - `AudioContext`（麦克风降采样成 16k PCM）。
 * 缺任何一样就回退 `webkitSpeechRecognition`；再没有就是 `none`（界面落 error）。
 */
export function pickAsrRoute({ win = null, url = null } = {}) {
  const w = rootWin(win);
  const target = url === null || url === undefined ? resolveAsrUrl(w) : String(url || '');
  const hasVolc = !!target
    && typeof w.WebSocket === 'function'
    && !!(w.AudioContext || w.webkitAudioContext);
  if (hasVolc) return ASR_ROUTES.VOLC;
  return speechRecognitionCtor(w) ? ASR_ROUTES.WEB_SPEECH : ASR_ROUTES.NONE;
}

/**
 * auto 适配器用的地址归一化：显式传 `off` / `none` / `0` / `false` 表示**强制回退**，
 * 传空 / 不传则用 `resolveAsrUrl()` 的默认值或 `window.__MFG_ASR_WS__` 覆盖。
 */
function asrTarget(win, url) {
  if (url === null || url === undefined) return resolveAsrUrl(win);
  const value = String(url).trim();
  if (!value) return resolveAsrUrl(win);
  if (/^(off|none|false|0)$/i.test(value)) return '';
  return value;
}

/**
 * 麦克风采集用哪种节点（纯函数）：
 *   - `worklet`：有 `AudioWorkletNode` + `ctx.audioWorklet`（首选，不占主线程）；
 *   - `processor`：只有 `createScriptProcessor`（兜底，老浏览器 / 部分环境）；
 *   - `none`：两样都没有。
 */
export function pickCaptureMode(ctx, win = null) {
  if (!ctx) return 'none';
  const w = rootWin(win);
  if (ctx.audioWorklet && typeof w.AudioWorkletNode === 'function') return 'worklet';
  if (typeof ctx.createScriptProcessor === 'function') return 'processor';
  return 'none';
}

/** 代理 / 火山返回的错误码 → 会话错误码（session.js 的 VOICE_ERROR_KEYS 认得这些） */
export const VOLC_ERROR_MAP = Object.freeze({
  auth: 'asr-auth',
  network: 'asr-network',
  timeout: 'asr-timeout',
  upstream: 'asr-upstream',
  'server-busy': 'asr-upstream',
  'bad-request': 'asr-protocol',
  'empty-audio': 'asr-protocol',
  'audio-format': 'asr-protocol',
  protocol: 'asr-protocol',
  config: 'asr-config',
});

export function volcErrorCode(code) {
  return VOLC_ERROR_MAP[String(code || '')] || 'asr';
}

/**
 * Chrome 的 `SpeechRecognitionErrorEvent.error` → 适配器错误码。
 *
 * 只有**重试也没用**的错误才映射成 fatal（会话会落 error、UI 给出处置建议）；
 * `network` / `no-speech` / `aborted` 交给 `onend` 的退避重启继续试，
 * 同时通过 `onNotice` 让界面**说出来**（用户反馈「说话没字幕」多半就是卡在这里：
 * 识别服务连不上，但界面一直是「正在聆听…」，什么都没说）。
 */
export const ASR_FATAL_ERRORS = Object.freeze({
  'not-allowed': 'mic',                 // 权限被拒：地址栏左侧允许麦克风
  'service-not-allowed': 'asr-service', // 浏览器 / 企业策略禁用了语音识别服务
  'audio-capture': 'mic-busy',          // 麦克风被别的页面占用 / 没有输入设备
  'language-not-supported': 'asr-language',
  unsupported: 'asr-unsupported',
});

/** 非致命错误 → 界面上那行提示的文案码（`coach.notice.*`，未知的落到 asr） */
export function asrNoticeCode(raw) {
  const code = String(raw || '');
  if (code === 'network' || code === 'no-speech' || code === 'aborted') return code;
  return 'asr';
}

/**
 * Mock ASR 的会话行为：
 *   - `continuous = true` / `interimResults = true`，`lang` 跟随界面语言（zh-CN / en-US）；
 *   - **中间结果（interim）立刻交给 `onInterim(text)` 上屏** —— Chrome 在连续模式下
 *     最终结果可能很久才来、甚至不来；只等 final 就会「说完一句什么都不显示」；
 *   - 最终结果交给 `onResult(text, { isFinal: true })` 定稿；
 *   - 识别器收回临时结果时 `onInterim('', { clear: true })`，别把上一句半截留在屏幕上；
 *   - 每次 `start()` 都新建一个识别实例，并用 `running / starting` 双 guard，
 *     重复 `start()` 不会把 `InvalidStateError` 抛给调用方；
 *   - `end` 之后自动重启：指数退避（400ms → 800ms → 1600ms，封顶 2s），
 *     **连续 3 次都没拿到任何结果（interim 也算结果）就停**，并 `onError({ code:'asr' })`；
 *   - 致命错误（权限 / 服务被禁 / 麦被占 / 语言不支持）走 `onError`，
 *     非致命的（network / no-speech / aborted）走 `onNotice`，界面能说出原因；
 *   - 浏览器不支持时 `start()` 返回 `false`，**不抛错**（会话据此落 error 状态）。
 */
export function createAsr({
  win = null,
  lang = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const w = rootWin(win);
  let recognition = null;
  let running = false;
  let starting = false;
  let manualStop = true;
  let failures = 0;
  let restartTimer = null;
  let lastError = '';
  const handlers = { result: null, interim: null, error: null, end: null, state: null, notice: null, route: null };

  /** 记下最后一个原始错误名（🐞 调试行会显示它），浏览器里另留一条 console */
  function noteError(raw) {
    lastError = String(raw || 'asr');
    try { w.console?.info?.(`[voice] asr error: ${lastError}`); } catch { /* ignore */ }
  }

  function clearRestart() {
    if (restartTimer !== null) {
      try { clearTimer(restartTimer); } catch { /* ignore */ }
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
      starting = false;
      running = true;
      handlers.state?.('listening', { failures });
    };
    rec.onresult = (event) => {
      if (!event || !event.results) return;
      const len = Number(event.results.length) || 0;
      const rawStart = Number(event.resultIndex);
      const start = Number.isFinite(rawStart) ? Math.max(0, Math.min(len, rawStart)) : 0;
      let interim = '';
      const finals = [];
      for (let i = start; i < len; i += 1) {
        const item = event.results[i];
        const alt = item && item[0];
        const text = alt && alt.transcript ? String(alt.transcript) : '';
        if (!text) continue;
        if (item.isFinal === true) finals.push(text);
        else interim += text;
      }
      // **先**把中间结果交出去：用户说完最后几个字、final 还没来的时候，字幕已经跟着变了。
      // interim 也算「识别出了东西」：continuous 模式下 final 可能永远不来，
      // 如果只认 final，重启计数会一路涨到 3，把正在说话的人踢出聆听状态。
      if (interim) {
        failures = 0;
        handlers.interim?.(interim);
      }
      for (const text of finals) {
        failures = 0;
        handlers.result?.(text, { isFinal: true });
      }
      if (!interim && !finals.length && handlers.interim) {
        // 识别器把临时结果收回了（例如用户把话咽回去）：清掉半截字幕
        handlers.interim('', { clear: true });
      }
    };
    rec.onerror = (event) => {
      const raw = (event && event.error) || 'asr';
      noteError(raw);
      const fatal = ASR_FATAL_ERRORS[raw];
      if (fatal) {
        manualStop = true;
        starting = false;
        running = false;
        clearRestart();
        handlers.error?.({ code: fatal, fatal: true, raw });
        return;
      }
      // 自己 stop() 引起的 aborted 不算异常，别闪一条「识别被中断」
      if (raw === 'aborted' && manualStop) return;
      handlers.notice?.({ code: asrNoticeCode(raw), raw });
    };
    rec.onend = () => {
      running = false;
      starting = false;
      handlers.end?.();
      if (manualStop) return;
      failures += 1;
      if (failures >= 3) {
        manualStop = true;
        handlers.error?.({ code: 'asr', fatal: true, attempts: failures, raw: lastError || 'asr' });
        return;
      }
      const delay = Math.min(2000, 400 * (2 ** (failures - 1)));
      handlers.state?.('restarting', { failures, delay });
      clearRestart();
      restartTimer = setTimer(restart, delay);
    };
    starting = true;
    try {
      rec.start();
      starting = false;
      running = true;
      handlers.route?.({ route: ASR_ROUTES.WEB_SPEECH });
      return true;
    } catch (err) {
      // InvalidStateError 之类：不抛给会话，返回 false 让 UI 落 error（会话会给出可重试提示）
      starting = false;
      running = false;
      noteError(err?.name || 'start-failed');
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
    get lastError() { return lastError; },
    /** 这一路是什么（火山代理 / 浏览器自带）；会话把它写进 snapshot 给界面提示 */
    get route() { return ASR_ROUTES.WEB_SPEECH; },
    onResult(fn) { handlers.result = fn; return api; },
    onInterim(fn) { handlers.interim = fn; return api; },
    onError(fn) { handlers.error = fn; return api; },
    onEnd(fn) { handlers.end = fn; return api; },
    onState(fn) { handlers.state = fn; return api; },
    /** 非致命错误（network / no-speech / aborted）：只提示，不落 error 状态 */
    onNotice(fn) { handlers.notice = fn; return api; },
    /** 选路结果（火山适配器会先报 volc、回退时再报 webspeech） */
    onRoute(fn) { handlers.route = fn; return api; },
    /** 开始聆听；返回 false = 这个浏览器不支持（调用方落 error 状态，不抛错） */
    start() {
      if (!speechRecognitionCtor(w)) {
        running = false;
        handlers.route?.({ route: ASR_ROUTES.NONE });
        return false;
      }
      if (running || starting) return true;   // 重复 start() 不抛 InvalidStateError
      manualStop = false;
      failures = 0;
      clearRestart();
      return startInternal();
    },
    stop() {
      manualStop = true;
      running = false;
      starting = false;
      clearRestart();
      const rec = recognition;
      recognition = null;
      if (rec) {
        try { rec.onend = null; } catch { /* ignore */ }
        try { rec.onresult = null; } catch { /* ignore */ }
        try { rec.onerror = null; } catch { /* ignore */ }
        try { rec.stop?.(); } catch { /* ignore */ }
        try { rec.abort?.(); } catch { /* ignore */ }
      }
    },
  };
  return api;
}

/* ================================================================== *
 * 火山流式 ASR 适配器（P3.1）：麦克风 → 16k PCM16 → 本机代理 → 火山
 *
 * 接口与 createAsr() **完全一致**（start / stop / onResult / onInterim / onError /
 * onState），另外多一个 onRoute 给界面提示「现在用的是哪一路」。
 *
 * 连接 / 握手 / 鉴权失败（代理没起、端口不通、coach.env 缺字段、火山拒绝）时：
 *   - 如果浏览器还有 Web Speech，就**静默回退**到它，并通过 onRoute 把路由改成
 *     `webspeech`、onNotice 报一条 `asr-fallback`（字幕面板会写出来）；
 *   - 两路都没有才 onError（会话落 error）。
 *
 * 关闭时按顺序收拾：停 AudioWorklet / ScriptProcessor → 断 WebSocket → 关 AudioContext。
 * 麦克风轨道由会话层的 mic 适配器释放（这里只用、不 stop，避免两处抢着关）。
 * ================================================================== */

/** worklet 模块地址（浏览器里由 preview-server 以 text/javascript 提供） */
const PCM_WORKLET_URL = new URL('./pcm-worklet.js', import.meta.url).href;

/**
 * 创建火山 ASR 适配器。
 *
 * @param {object} [opts]
 * @param {object} [opts.win]              浏览器 window（测试注入）
 * @param {object} [opts.mic]              createMic() 的实例（用它的 .stream 采集）
 * @param {string} [opts.url]              代理地址（默认 resolveAsrUrl()）
 * @param {string|Function} [opts.lang]    语言
 * @param {Function} [opts.fallbackFactory] 回退工厂（默认 createAsr）
 * @param {number} [opts.connectTimeoutMs] 连代理的超时
 * @param {number} [opts.readyTimeoutMs]   代理连上火山后等 ready 的超时
 */
export function createVolcAsr({
  win = null,
  mic = null,
  url = null,
  lang = null,
  fallbackFactory = null,
  connectTimeoutMs = 5000,
  readyTimeoutMs = 8000,
} = {}) {
  const w = rootWin(win);
  const handlers = {
    result: null, interim: null, error: null, end: null, state: null, notice: null, route: null,
  };
  let ws = null;
  let ready = false;
  let running = false;
  let manualStop = true;
  let currentRoute = '';
  let fallback = null;
  let connectTimer = null;
  let readyTimer = null;
  let audio = { ctx: null, source: null, node: null, gain: null };
  let chunks = 0;
  let sentBytes = 0;

  function clearTimers() {
    if (connectTimer !== null) { try { clearTimeout(connectTimer); } catch { /* ignore */ } connectTimer = null; }
    if (readyTimer !== null) { try { clearTimeout(readyTimer); } catch { /* ignore */ } readyTimer = null; }
  }

  function sendJson(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  function sendBytes(buffer) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(buffer); sentBytes += buffer.byteLength || buffer.length || 0; return true; } catch { return false; }
  }

  function closeSocket() {
    const sock = ws;
    ws = null;
    ready = false;
    if (!sock) return;
    try { sock.onopen = null; } catch { /* ignore */ }
    try { sock.onmessage = null; } catch { /* ignore */ }
    try { sock.onerror = null; } catch { /* ignore */ }
    try { sock.onclose = null; } catch { /* ignore */ }
    try { sock.close?.(); } catch { /* ignore */ }
  }

  function teardownAudio() {
    const current = audio;
    audio = { ctx: null, source: null, node: null, gain: null };
    try { current.node?.port?.close?.(); } catch { /* ignore */ }
    try { current.node?.disconnect?.(); } catch { /* ignore */ }
    try { current.source?.disconnect?.(); } catch { /* ignore */ }
    try { current.gain?.disconnect?.(); } catch { /* ignore */ }
    if (current.node) {
      try { current.node.onaudioprocess = null; } catch { /* ignore */ }
      try { current.node.onmessage = null; } catch { /* ignore */ }
    }
    if (current.ctx) {
      try {
        const p = current.ctx.close?.();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch { /* ignore */ }
    }
  }

  /** 代理 / 火山不可用：收拾干净后回退 Web Speech（没有才报错） */
  function fallbackToWebSpeech(reason) {
    if (manualStop || fallback) return false;
    teardownAudio();
    closeSocket();
    clearTimers();
    let adapter = null;
    try {
      adapter = fallbackFactory
        ? fallbackFactory({ win: w, lang })
        : createAsr({ win: w, lang });
    } catch { adapter = null; }
    if (!adapter) {
      running = false;
      currentRoute = '';
      handlers.error?.({ code: 'asr-unsupported', fatal: true });
      return false;
    }
    fallback = adapter;
    adapter.onResult?.((text, info) => handlers.result?.(text, info));
    adapter.onInterim?.((text, info) => handlers.interim?.(text, info));
    adapter.onError?.((err) => handlers.error?.(err));
    adapter.onEnd?.(() => handlers.end?.());
    adapter.onState?.((phase, info) => handlers.state?.(phase, info));
    adapter.onNotice?.((info) => handlers.notice?.(info));
    currentRoute = ASR_ROUTES.WEB_SPEECH;
    handlers.route?.({ route: ASR_ROUTES.WEB_SPEECH, reason: String(reason || '') });
    handlers.notice?.({ code: 'asr-fallback', raw: String(reason || '') });
    let started = false;
    try { started = adapter.start() !== false; } catch { started = false; }
    if (!started) {
      fallback = null;
      running = false;
      handlers.error?.({ code: 'asr-unsupported', fatal: true });
      return false;
    }
    handlers.state?.('listening', { route: ASR_ROUTES.WEB_SPEECH });
    return true;
  }

  /** 一收到 ready 就开始采集：音频晚一点发没关系，但没有 ready 前别白占麦克风 */
  async function startCapture() {
    const Ctx = w.AudioContext || w.webkitAudioContext;
    const stream = mic && mic.stream ? mic.stream : null;
    if (!Ctx || !stream) {
      throw Object.assign(new Error('audio capture unavailable'), { code: 'mic-empty' });
    }
    const ctx = new Ctx();
    audio.ctx = ctx;
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try { await ctx.resume(); } catch { /* ignore */ }
    }
    const source = ctx.createMediaStreamSource(stream);
    audio.source = source;
    const inputRate = Number(ctx.sampleRate) || 48000;
    const emitChunk = (samples) => {
      if (manualStop || !ready || !samples) return;
      const pcm = downsampleToPcm16(samples, inputRate);
      if (!pcm.length) return;
      chunks += 1;
      sendBytes(pcm.buffer);
    };

    if (pickCaptureMode(ctx, w) === 'worklet') {
      try {
        await ctx.audioWorklet.addModule(PCM_WORKLET_URL);
        if (manualStop || !running) {
          try { ctx.close?.(); } catch { /* ignore */ }
          return false;
        }
        const node = new w.AudioWorkletNode(ctx, 'mfg-pcm-capture');
        node.port.onmessage = (event) => emitChunk(event && event.data);
        source.connect(node);
        audio.node = node;
        return true;
      } catch { /* 退回 ScriptProcessor */ }
    }

    if (manualStop || !running) {
      try { ctx.close?.(); } catch { /* ignore */ }
      return false;
    }
    if (typeof ctx.createScriptProcessor !== 'function') {
      throw Object.assign(new Error('no audio processing node'), { code: 'asr-unsupported' });
    }
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (event) => {
      const input = event && event.inputBuffer;
      const samples = input && typeof input.getChannelData === 'function'
        ? input.getChannelData(0)
        : null;
      emitChunk(samples);
    };
    const gain = typeof ctx.createGain === 'function' ? ctx.createGain() : null;
    if (gain) {
      try { gain.gain.value = 0; } catch { /* ignore */ }
    }
    source.connect(node);
    if (gain) {
      node.connect(gain);
      gain.connect(ctx.destination);
    } else {
      node.connect(ctx.destination);
    }
    audio.node = node;
    audio.gain = gain;
    return true;
  }

  function onMessage(event) {
    let msg;
    try { msg = JSON.parse(String(event && event.data)); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ready') {
      ready = true;
      if (readyTimer !== null) { clearTimeout(readyTimer); readyTimer = null; }
      handlers.state?.('listening', { route: ASR_ROUTES.VOLC });
      startCapture().catch(() => { fallbackToWebSpeech('capture-failed'); });
      return;
    }
    if (msg.type === 'partial') {
      const text = String(msg.text || '');
      if (text) handlers.interim?.(text);
      return;
    }
    if (msg.type === 'final') {
      const text = String(msg.text || '');
      if (text) handlers.result?.(text, { isFinal: true });
      else handlers.interim?.('', { clear: true });
      return;
    }
    if (msg.type === 'error') {
      const code = String(msg.code || 'error');
      handlers.notice?.({ code: 'asr-fallback', raw: code });
      fallbackToWebSpeech(`server-${code}`);
    }
  }

  function startVolc() {
    const WS = w.WebSocket;
    const target = asrTarget(w, url);
    if (!WS || !target || !(w.AudioContext || w.webkitAudioContext)) {
      fallbackToWebSpeech('unsupported');
      return;
    }
    let sock;
    try { sock = new WS(target); } catch { fallbackToWebSpeech('ws-construct'); return; }
    ws = sock;
    try { sock.binaryType = 'arraybuffer'; } catch { /* ignore */ }
    sock.onopen = () => {
      if (manualStop || ws !== sock) return;
      if (connectTimer !== null) { clearTimeout(connectTimer); connectTimer = null; }
      sendJson({ type: 'start', lang: speechLang(lang) });
      readyTimer = setTimeout(() => {
        readyTimer = null;
        if (!ready && !manualStop) fallbackToWebSpeech('ready-timeout');
      }, readyTimeoutMs);
    };
    sock.onmessage = (event) => { if (ws === sock) onMessage(event); };
    sock.onerror = () => { if (!ready) fallbackToWebSpeech('ws-error'); };
    sock.onclose = () => {
      if (manualStop || ws !== sock) return;
      fallbackToWebSpeech('ws-closed');
    };
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (!ready && !manualStop) fallbackToWebSpeech('connect-timeout');
    }, connectTimeoutMs);
  }

  const api = {
    kind: 'volc',
    name: 'volc-asr',
    get supported() {
      return !!asrTarget(w, url)
        && typeof w.WebSocket === 'function'
        && !!(w.AudioContext || w.webkitAudioContext);
    },
    get active() { return running; },
    get route() { return currentRoute; },
    get ready() { return ready; },
    get chunks() { return chunks; },
    get sentBytes() { return sentBytes; },
    onResult(fn) { handlers.result = fn; return api; },
    onInterim(fn) { handlers.interim = fn; return api; },
    onError(fn) { handlers.error = fn; return api; },
    onEnd(fn) { handlers.end = fn; return api; },
    onState(fn) { handlers.state = fn; return api; },
    onNotice(fn) { handlers.notice = fn; return api; },
    onRoute(fn) { handlers.route = fn; return api; },
    start() {
      if (running) return true;
      if (!api.supported || !(url || resolveAsrUrl(w))) {
        currentRoute = '';
        return false;
      }
      manualStop = false;
      running = true;
      ready = false;
      fallback = null;
      chunks = 0;
      sentBytes = 0;
      currentRoute = ASR_ROUTES.VOLC;
      handlers.route?.({ route: ASR_ROUTES.VOLC });
      handlers.state?.('connecting');
      startVolc();
      return true;
    },
    stop() {
      manualStop = true;
      running = false;
      ready = false;
      clearTimers();
      sendJson({ type: 'stop' });
      const fb = fallback;
      fallback = null;
      try { fb?.stop?.(); } catch { /* ignore */ }
      closeSocket();
      teardownAudio();
      currentRoute = '';
    },
  };
  return api;
}

/**
 * 自动选路适配器：每次 start() 都重新判断（代理可能刚启动 / 刚关掉；
 * 测试里也可以中途替换 window 上的能力）。
 *
 *   - 有 WebSocket + AudioContext + 代理地址 → createVolcAsr（内部还会自己回退）；
 *   - 否则 → createAsr（浏览器 Web Speech）；
 *   - 都没有 → start() 返回 false，会话落 error。
 *
 * 对会话仍然只有 P3.0 那套接口；选路结果通过 onRoute 上报。
 */
export function createAutoAsr({
  win = null,
  mic = null,
  url = null,
  lang = null,
  volcFactory = null,
  webSpeechFactory = null,
  fallbackFactory = null,
} = {}) {
  const w = rootWin(win);
  const handlers = {
    result: null, interim: null, error: null, end: null, state: null, notice: null, route: null,
  };
  let inner = null;
  let lastRoute = '';

  function bind(adapter) {
    adapter.onResult?.((text, info) => handlers.result?.(text, info));
    adapter.onInterim?.((text, info) => handlers.interim?.(text, info));
    adapter.onError?.((err) => handlers.error?.(err));
    adapter.onEnd?.(() => handlers.end?.());
    adapter.onState?.((phase, info) => handlers.state?.(phase, info));
    adapter.onNotice?.((info) => handlers.notice?.(info));
    adapter.onRoute?.((info) => {
      if (info && info.route) {
        lastRoute = info.route;
        handlers.route?.(info);
      }
    });
  }

  const api = {
    kind: 'auto',
    get name() { return inner ? (inner.name || inner.kind || '') : 'auto'; },
    get supported() { return pickAsrRoute({ win: w, url: asrTarget(w, url) }) !== ASR_ROUTES.NONE; },
    get active() { return !!(inner && inner.active); },
    get route() { return lastRoute; },
    onResult(fn) { handlers.result = fn; return api; },
    onInterim(fn) { handlers.interim = fn; return api; },
    onError(fn) { handlers.error = fn; return api; },
    onEnd(fn) { handlers.end = fn; return api; },
    onState(fn) { handlers.state = fn; return api; },
    onNotice(fn) { handlers.notice = fn; return api; },
    onRoute(fn) { handlers.route = fn; return api; },
    start() {
      if (inner) {
        try { inner.stop(); } catch { /* ignore */ }
        inner = null;
      }
      const target = asrTarget(w, url);
      const route = pickAsrRoute({ win: w, url: target });
      lastRoute = route === ASR_ROUTES.NONE ? '' : route;
      handlers.route?.({ route });
      if (route === ASR_ROUTES.VOLC) {
        const factory = volcFactory || createVolcAsr;
        inner = factory({
          win: w,
          mic,
          url: target,
          lang,
          fallbackFactory: fallbackFactory || (({ win: fw, lang: fl } = {}) => createAsr({ win: fw, lang: fl })),
        });
      } else {
        const factory = webSpeechFactory || createAsr;
        inner = factory({ win: w, lang });
      }
      bind(inner);
      let started = false;
      try { started = inner.start() !== false; } catch { started = false; }
      return started;
    },
    stop() {
      const adapter = inner;
      inner = null;
      lastRoute = '';
      try { adapter?.stop?.(); } catch { /* ignore */ }
    },
  };
  return api;
}

/* ================================================================== *
 * VU（音量表）：把麦克风音量映射成 0~1 的 level + 品牌色
 *
 * 纯函数（`rmsToLevel` / `smoothLevel` / `levelToColor`）在 Node 里直接可测；
 * `createVuMeter()` 才碰浏览器（getUserMedia + AudioContext + AnalyserNode）。
 * 第二路音频打不开时（有些环境不允许两路同时占用麦克风）由 coach.js 静默降级，
 * 绝不把异常抛给用户 / 会话。
 * ================================================================== */

/** 静音门限（RMS）：低于它一律当作没声音，避免底噪把环染成青色 */
export const VU_RMS_FLOOR = 0.004;
/** 大声上限（RMS）：再大也只到 level 1 */
export const VU_RMS_CEIL = 0.30;
/** 对数压缩系数：越小越「灵敏」，12 让小声（RMS 0.02 左右）也能到 level≈0.3 */
export const VU_LOG_K = 12;
/** 颜色阈值：level < VOICE 是灰；VOICE ~ LOUD 是青；>= LOUD 是薄荷绿 */
export const VU_LEVEL_VOICE = 0.08;
export const VU_LEVEL_LOUD = 0.62;
/** 品牌色：静音灰 / 说话青 / 大声薄荷亮绿（都来自 style.css 的 --muted / --accent-2 / --accent） */
export const VU_COLORS = Object.freeze({
  silent: '#8fa1bb',
  voice: '#38bdf8',
  loud: '#34e5c4',
});

/** 快升慢降：上升时间常数 45ms（跟得上音节），下降 220ms（不会一抖一抖） */
export const VU_ATTACK_MS = 45;
export const VU_RELEASE_MS = 220;

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * 一段时域采样（`getByteTimeDomainData` 的 Uint8Array，128 = 中点）→ 0~1 的 level。
 *
 *   rms   = sqrt(mean(((v - 128) / 128)^2))           ← 真 RMS，不是峰值
 *   x     = clamp((rms - FLOOR) / (CEIL - FLOOR))      ← 去掉底噪、归一化
 *   level = log1p(K * x) / log1p(K)                    ← 对数压缩：小声也看得见变化
 *
 * 单调：rms 越大 level 越大；静音（≤ FLOOR / 空数组）严格返回 0。
 * @param {ArrayLike<number>} samples
 * @returns {number} 0~1
 */
export function rmsToLevel(samples, { floor = VU_RMS_FLOOR, ceil = VU_RMS_CEIL, k = VU_LOG_K } = {}) {
  const n = samples && Number(samples.length) || 0;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = (Number(samples[i]) - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  if (!Number.isFinite(rms) || rms <= floor) return 0;
  const x = clamp01((rms - floor) / Math.max(1e-9, ceil - floor));
  return clamp01(Math.log1p(k * x) / Math.log1p(k));
}

/** 平滑：快升慢降（`dtMs` 是两帧的间隔；同一帧内 dt=0 时保持原值） */
export function smoothLevel(prev, next, dtMs = 50) {
  const p = clamp01(prev);
  const n = clamp01(next);
  const dt = Math.min(200, Math.max(0, Number(dtMs) || 0));
  if (dt === 0) return p;
  const tau = n > p ? VU_ATTACK_MS : VU_RELEASE_MS;
  const k = 1 - Math.exp(-dt / tau);
  return clamp01(p + (n - p) * k);
}

/** level → 品牌色（灰 / 青 / 薄荷亮绿；三档颜色互不相同） */
export function levelToColor(level) {
  const l = clamp01(level);
  if (l < VU_LEVEL_VOICE) return VU_COLORS.silent;
  if (l < VU_LEVEL_LOUD) return VU_COLORS.voice;
  return VU_COLORS.loud;
}

/**
 * 音量表适配器：打开第二路音频 + AnalyserNode。
 *
 *   open()      → Promise<boolean>   （失败 reject，由 coach.js 捕获后降级）
 *   readLevel() → number 0~1
 *   close()     → void   （停音轨 + 断开节点 + AudioContext.close()，不留后台麦克风）
 */
export function createVuMeter({ win = null } = {}) {
  const w = rootWin(win);
  let stream = null;
  let ctx = null;
  let source = null;
  let analyser = null;
  let bytes = null;
  let active = false;

  function close() {
    active = false;
    try { source?.disconnect?.(); } catch { /* ignore */ }
    source = null;
    analyser = null;
    bytes = null;
    if (stream) {
      let tracks = [];
      try {
        tracks = typeof stream.getTracks === 'function' ? stream.getTracks() : [];
      } catch { /* ignore */ }
      for (const track of tracks) {
        try { track.stop?.(); } catch { /* ignore */ }
      }
    }
    stream = null;
    const c = ctx;
    ctx = null;
    if (c) {
      try {
        const p = c.close?.();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch { /* ignore */ }
    }
  }

  return {
    kind: 'vu',
    get active() { return active; },
    async open() {
      if (active) return true;
      const Ctx = w.AudioContext || w.webkitAudioContext;
      const media = w.navigator && w.navigator.mediaDevices;
      // 先看有没有 AudioContext：没有就别去抓麦克风（不白白占用第二路）
      if (!Ctx || !media || typeof media.getUserMedia !== 'function') {
        const err = new Error('VU meter is not supported');
        err.code = 'vu-unsupported';
        throw err;
      }
      let s = null;
      let context = null;
      try {
        s = await media.getUserMedia({ audio: true });
        context = new Ctx();
        if (context.state === 'suspended') {
          try { await context.resume(); } catch { /* ignore */ }
        }
        if (context.state && context.state !== 'running') {
          const err = new Error(`AudioContext is ${context.state}`);
          err.code = 'vu-suspended';
          throw err;
        }
        const src = context.createMediaStreamSource(s);
        const node = context.createAnalyser();
        node.fftSize = 512;                 // 小一点：10ms 级别的音量表，够用且省
        node.smoothingTimeConstant = 0.2;   // 主要平滑我们自己算（快升慢降）
        src.connect(node);
        stream = s;
        ctx = context;
        source = src;
        analyser = node;
        bytes = new Uint8Array(node.fftSize);
        active = true;
        return true;
      } catch (err) {
        // 失败时自己收拾干净：停音轨、关上下文（不留后台麦克风）
        try { for (const track of (s && s.getTracks ? s.getTracks() : [])) track.stop?.(); } catch { /* ignore */ }
        try { context?.close?.(); } catch { /* ignore */ }
        stream = null;
        ctx = null;
        source = null;
        analyser = null;
        bytes = null;
        active = false;
        throw err;
      }
    },
    readLevel() {
      if (!active || !analyser || !bytes) return 0;
      try {
        analyser.getByteTimeDomainData(bytes);
        return rmsToLevel(bytes);
      } catch {
        return 0;
      }
    },
    close,
  };
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
