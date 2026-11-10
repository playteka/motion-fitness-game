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
import {
  createPcmFramer,
  FRAME_MS, FRAME_BYTES, EXPECTED_BYTES_PER_SEC,
} from './pcm.js';

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
export function createMic({ win = null, diag = null } = {}) {
  const w = rootWin(win);
  let stream = null;
  let tracks = [];

  return {
    kind: 'browser',
    async open() {
      diag?.record?.('mic:request', { by: 'mic' });
      const media = w.navigator && w.navigator.mediaDevices;
      if (!media || typeof media.getUserMedia !== 'function') {
        const err = new Error('getUserMedia is not available');
        err.code = 'mic-unsupported';
        diag?.record?.('mic:fail', { name: err.name || 'NotSupportedError', message: err.message });
        throw err;
      }
      try {
        stream = await media.getUserMedia({ audio: true });
      } catch (err) {
        diag?.record?.('mic:fail', {
          name: (err && err.name) || 'Error',
          message: (err && err.message) || String(err || ''),
        });
        throw err;
      }
      tracks = stream && typeof stream.getAudioTracks === 'function'
        ? stream.getAudioTracks()
        : (stream && typeof stream.getTracks === 'function' ? stream.getTracks() : []);
      if (!tracks.length) {
        this.close();
        const err = new Error('no audio track');
        err.code = 'mic-empty';
        diag?.record?.('mic:fail', { name: 'NotFoundError', message: err.message });
        throw err;
      }
      // 设备标签（label）可能带机器 / 用户名等本机信息：只上报**轨数**和序号，不上报原始 label
      diag?.record?.('mic:ok', {
        tracks: tracks.length,
        labels: tracks.map((t, i) => `audio-${i + 1}`),
      });
      return tracks;
    },
    close(reason = 'close') {
      const count = tracks.length;
      for (const track of tracks) {
        try { track.stop(); } catch { /* ignore */ }
      }
      tracks = [];
      stream = null;
      if (diag && count) diag.record?.('mic:release', { tracks: count, reason: String(reason) });
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

/** 语音代理的 WebSocket 路径（页面、预览服务器、独立代理、测试共用这一个常量） */
export const ASR_WS_PATH = '/asr';

/**
 * 没有 `location` 时的兜底：**独立代理进程**（`node server/coach-proxy.mjs`）的地址。
 * 页面正常运行**不用它** —— 见 `resolveAsrUrl()`：默认跟页面同源同端口。
 */
export const DEFAULT_ASR_WS_URL = 'ws://127.0.0.1:4180/asr';

/** 三条路：火山代理 / 浏览器自带 / 都没有 */
export const ASR_ROUTES = Object.freeze({
  VOLC: 'volc',
  WEB_SPEECH: 'webspeech',
  NONE: 'none',
});

/**
 * 跟页面同源的代理地址（**默认值**）：`https:` 页面 → `wss:`，其余 → `ws:`；
 * host 与端口就是页面自己的（`location.host` 已经带端口）。
 *
 * 预览服务器把 `/asr` 代理并进了同一个进程，所以打开 `http://127.0.0.1:4174`
 * 就等于 `ws://127.0.0.1:4174/asr` —— 不需要用户再起第二个进程，也不会再出现
 * 「页面 4174、代理 4180 忘了起 → 火山引擎不可用」。
 *
 * 没有 `location`（Node 里测试 / 老环境）或 host 为空时返回 ''，由调用方兜底。
 */
export function sameOriginAsrUrl(win = null) {
  const w = rootWin(win);
  const loc = w.location;
  if (!loc) return '';
  const host = String(loc.host || '');
  if (!host) return '';
  return `${String(loc.protocol || '').toLowerCase() === 'https:' ? 'wss' : 'ws'}://${host}${ASR_WS_PATH}`;
}

/**
 * 代理地址的优先级：
 *   1. `window.__MFG_ASR_WS__`（显式覆盖：换端口 / 手机连独立代理 / 测试）；
 *   2. 跟页面同源（`sameOriginAsrUrl()`）；
 *   3. `DEFAULT_ASR_WS_URL`（没有 `location` 时的兜底，即独立代理进程那套排障入口）。
 *
 * 显式写 `off` / `none` / `0` / `false` 可以强制回退到 Web Speech。
 */
export function resolveAsrUrl(win = null) {
  const w = rootWin(win);
  const fallback = sameOriginAsrUrl(w) || DEFAULT_ASR_WS_URL;
  const raw = w.__MFG_ASR_WS__;
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim();
  if (!value) return fallback;
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
  /** 共享麦克风适配器：Web Speech 会**自己**取麦，所以启动前必须先释放这一路（只留一条） */
  mic = null,
  diag = null,
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

  /**
   * Web Speech 是浏览器**自己**去开麦克风的：共享的那一路必须先放掉，
   * 否则第二路 getUserMedia 在很多环境里直接失败（用户反馈「麦克风亮着但没字幕」的头号嫌疑）。
   * 会话层之后要恢复聆听时重新 open() 即可。
   */
  function releaseSharedMic() {
    if (!mic || !mic.active) return;
    try {
      mic.close('webspeech');
    } catch { /* ignore */ }
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
    // 先把共享麦克风放掉，再让浏览器的识别器自己取麦（只保留一条输入）
    releaseSharedMic();
    try {
      rec.start();
      starting = false;
      running = true;
      diag?.record?.('route:webspeech', { adapter: 'webrtc' });
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
 * 从一条**已经打开的** MediaStream 采集 PCM 渲染块（AudioWorklet 优先，ScriptProcessor 兜底）。
 *
 * 两处共用这一份实现：
 *   - 火山 ASR 适配器（页面主流程）；
 *   - 「语音自检」按钮（独立流程：自己的流、自己的 WS，不碰会话）。
 *
 * 失败 / 降级都会记进诊断（`worklet:ok` / `worklet:fail` / `capture:mode`），
 * 这样「Worklet 被 CSP / 缓存拦掉」这类问题在页面上就能看到，而不是静默无声。
 *
 * @param {object}   opts
 * @param {object}   opts.win     浏览器 window（测试注入）
 * @param {object}   opts.ctx     AudioContext
 * @param {object}   opts.stream  MediaStream（调用方负责 open / 释放轨道）
 * @param {Function} opts.onChunk (Float32Array) => void
 * @param {object}   [opts.diag]  诊断收集器
 * @returns {Promise<{mode:string, node:object, source:object, gain:object, stop:Function}>}
 */
export async function startPcmCapture({
  win = null, ctx = null, stream = null, onChunk = null, diag = null,
} = {}) {
  const w = rootWin(win);
  if (!ctx || !stream || typeof onChunk !== 'function') {
    throw Object.assign(new Error('audio capture unavailable'), { code: 'mic-empty' });
  }
  const source = ctx.createMediaStreamSource(stream);
  const state = { mode: 'none', node: null, source, gain: null, flush: () => {} };
  function stop() {
    try { state.node?.port?.close?.(); } catch { /* ignore */ }
    try { state.node?.port && (state.node.port.onmessage = null); } catch { /* ignore */ }
    try { state.node?.disconnect?.(); } catch { /* ignore */ }
    try { source?.disconnect?.(); } catch { /* ignore */ }
    try { state.gain?.disconnect?.(); } catch { /* ignore */ }
    if (state.node) {
      try { state.node.onaudioprocess = null; } catch { /* ignore */ }
      try { state.node.onmessage = null; } catch { /* ignore */ }
    }
    state.node = null;
    state.gain = null;
    state.flush = () => {};
  }
  state.stop = stop;

  if (pickCaptureMode(ctx, w) === 'worklet') {
    try {
      await ctx.audioWorklet.addModule(PCM_WORKLET_URL);
      // worklet 在音频线程里按 100ms 定帧（frameMs 与 pcm.js 的 FRAME_MS 同一份常量）
      const node = new w.AudioWorkletNode(ctx, 'mfg-pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { frameMs: FRAME_MS },
      });
      node.port.onmessage = (event) => {
        const data = event && event.data;
        // 新格式 {type:'pcm', samples}；旧 worklet 直接回 Float32Array 也兼容
        const samples = data && data.samples ? data.samples : data;
        if (samples) onChunk(samples);
      };
      // 必须把节点接到 destination（音量 0）：AudioWorkletNode 的输出不接到音频图里时，
      // 部分浏览器不会持续拉取它 —— 这是以前「帧数比预期少」的另一个来源。
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
      state.node = node;
      state.gain = gain;
      state.mode = 'worklet';
      state.flush = () => {
        try { node.port.postMessage({ type: 'flush' }); } catch { /* ignore */ }
      };
      diag?.record?.('worklet:ok', { module: 'pcm-worklet', frameMs: FRAME_MS });
      diag?.record?.('capture:mode', { mode: 'worklet' });
      return state;
    } catch (err) {
      // CSP / 缓存 / 旧浏览器：记下来，然后**必须**退回 ScriptProcessor（不能静默没声音）
      diag?.record?.('worklet:fail', {
        name: (err && err.name) || 'Error',
        message: (err && err.message) || String(err || ''),
      });
    }
  }

  if (typeof ctx.createScriptProcessor !== 'function') {
    stop();
    throw Object.assign(new Error('no audio processing node'), { code: 'asr-unsupported' });
  }
  const node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (event) => {
    const input = event && event.inputBuffer;
    const samples = input && typeof input.getChannelData === 'function'
      ? input.getChannelData(0)
      : null;
    if (samples) onChunk(samples);
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
  state.node = node;
  state.gain = gain;
  state.mode = 'processor';
  diag?.record?.('capture:mode', { mode: 'processor' });
  return state;
}

/**
 * 创建火山 ASR 适配器。
 *
 * @param {object} [opts]
 * @param {object} [opts.win]              浏览器 window（测试注入）
 * @param {object} [opts.mic]              createMic() 的实例（用它的 .stream 采集）
 * @param {string} [opts.url]              代理地址（默认 resolveAsrUrl()）
 * @param {string|Function} [opts.lang]    语言
 * @param {Function} [opts.fallbackFactory] 回退工厂（默认 createAsr）
 * @param {object} [opts.diag]             诊断收集器（可选；只在浏览器里传）
 * @param {number} [opts.connectTimeoutMs] 连代理的超时
 * @param {number} [opts.readyTimeoutMs]   代理连上火山后等 ready 的超时
 */
export function createVolcAsr({
  win = null,
  mic = null,
  url = null,
  lang = null,
  fallbackFactory = null,
  diag = null,
  connectTimeoutMs = 5000,
  readyTimeoutMs = 8000,
  /** stop() 之后最多等多久让服务端把 final 送回来（服务端自己还有 3s 上限） */
  finalWaitMs = 4000,
  /** 100ms 一帧（与 pcm.js 的 FRAME_MS 同源） */
  frameMs = FRAME_MS,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
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
  let stopTimer = null;
  let audio = { ctx: null, capture: null };
  let framer = null;
  let chunks = 0;
  let sentBytes = 0;
  let framesLogged = 0;
  let rateMarkAt = 0;
  let rateMarkBytes = 0;
  let lastRate = 0;
  let firstFrameAt = 0;

  function logFrames(force = false) {
    if (!chunks) return;
    if (!force && chunks - framesLogged < 8) return;
    framesLogged = chunks;
    diag?.record?.('ws:frames', { n: chunks, bytes: sentBytes });
  }

  /**
   * 实时码率（诊断面板那一行）：每 1 秒按「这段时间真正发出去的字节」算一次。
   * 正常应该 ≈ 32000 B/s（16k / 16bit / 单声道）。明显偏低 = 采集没跟上 / 帧被丢 / 采样率没降对。
   */
  function recordRate(force = false) {
    const t = Number(now()) || 0;
    if (!rateMarkAt) { rateMarkAt = t; rateMarkBytes = sentBytes; return; }
    const dt = t - rateMarkAt;
    // 平时每 1 秒一次；stop 时强制补一次，但样本太短（<500ms）就不覆盖上一次的准确值
    if (dt < (force ? 500 : 1000)) return;
    lastRate = Math.round(((sentBytes - rateMarkBytes) * 1000) / dt);
    rateMarkAt = t;
    rateMarkBytes = sentBytes;
    diag?.record?.('ws:rate', { bytesPerSec: lastRate, expected: EXPECTED_BYTES_PER_SEC });
  }

  function clearTimers() {
    if (connectTimer !== null) { try { clearTimer(connectTimer); } catch { /* ignore */ } connectTimer = null; }
    if (readyTimer !== null) { try { clearTimer(readyTimer); } catch { /* ignore */ } readyTimer = null; }
    if (stopTimer !== null) { try { clearTimer(stopTimer); } catch { /* ignore */ } stopTimer = null; }
  }

  function sendJson(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  function sendBytes(buffer) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(buffer); sentBytes += buffer.byteLength || buffer.length || 0; return true; } catch { return false; }
  }

  function closeSocket(closingReason = 'client-stop') {
    if (stopTimer !== null) { try { clearTimer(stopTimer); } catch { /* ignore */ } stopTimer = null; }
    const sock = ws;
    ws = null;
    ready = false;
    if (!sock) return;
    diag?.record?.('ws:close', { code: 1000, reason: closingReason });
    try { sock.onopen = null; } catch { /* ignore */ }
    try { sock.onmessage = null; } catch { /* ignore */ }
    try { sock.onerror = null; } catch { /* ignore */ }
    try { sock.onclose = null; } catch { /* ignore */ }
    try { sock.close?.(); } catch { /* ignore */ }
  }

  function teardownAudio() {
    const current = audio;
    audio = { ctx: null, capture: null };
    framer = null;
    logFrames(true);
    recordRate(true);
    try { current.capture?.stop?.(); } catch { /* ignore */ }
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
    closeSocket(`fallback:${String(reason || '')}`);
    clearTimers();
    // Web Speech 会自己去拿麦克风：**先**把共享的这一路放掉（只保留一条输入）。
    // 自定义 fallbackFactory 也照这条规则走，日志里会留下 mic:release。
    if (mic && mic.active) {
      try { mic.close('webspeech-fallback'); } catch { /* ignore */ }
    }
    diag?.record?.('route:webspeech', { reason: String(reason || '') });
    let adapter = null;
    try {
      adapter = fallbackFactory
        ? fallbackFactory({ win: w, lang, mic, diag })
        : createAsr({ win: w, lang, mic, diag });
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

  /** 发一帧 16k PCM（100ms / 3200 字节）；返回是否真的发出去了 */
  function sendPcmFrame(pcm) {
    if (!pcm || !pcm.length) return false;
    if (manualStop || !ready) return false;
    if (!sendBytes(pcm.buffer)) return false;
    chunks += 1;
    if (chunks === 1) {
      firstFrameAt = Number(now()) || 0;
      diag?.record?.('ws:firstFrame', { bytes: pcm.byteLength });
    }
    logFrames();
    recordRate();
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
    const inputRate = Number(ctx.sampleRate) || 48000;
    diag?.record?.('ctx:sampleRate', { value: inputRate, state: String(ctx.state || '') });
    // 100ms 定帧 + 降采样到 16k：每帧 1600 样本 / 3200 字节，正常 32KB/s
    framer = createPcmFramer({ inputRate, frameMs });
    rateMarkAt = Number(now()) || 0;
    rateMarkBytes = sentBytes;
    lastRate = 0;
    firstFrameAt = 0;
    const emitChunk = (samples) => {
      if (manualStop || !ready || !samples || !framer) return;
      for (const pcm of framer.push(samples)) sendPcmFrame(pcm);
    };

    let capture;
    try {
      capture = await startPcmCapture({ win: w, ctx, stream, onChunk: emitChunk, diag });
    } catch (err) {
      try { ctx.close?.(); } catch { /* ignore */ }
      throw err;
    }
    if (manualStop || !running) {
      try { capture.stop?.(); } catch { /* ignore */ }
      try { ctx.close?.(); } catch { /* ignore */ }
      return false;
    }
    audio.capture = capture;
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
      if (text) {
        diag?.record?.('asr:partial', { text });
        handlers.interim?.(text);
      }
      return;
    }
    if (msg.type === 'final') {
      const text = String(msg.text || '');
      diag?.record?.('asr:final', { text });
      if (text) handlers.result?.(text, { isFinal: true });
      else handlers.interim?.('', { clear: true });
      // stop() 之后还在等这一包：收到 final 就可以安心关连接了
      if (manualStop) closeSocket('server-final');
      return;
    }
    if (msg.type === 'error') {
      const code = String(msg.code || 'error');
      diag?.record?.('asr:error', { code, message: String(msg.message || '') });
      handlers.notice?.({ code: 'asr-fallback', raw: code });
      if (manualStop) { closeSocket(`server-${code}`); return; }
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
    diag?.record?.('ws:connecting', { url: String(target).replace(/\/\/[^/]+/, '//<host>') });
    try { sock.binaryType = 'arraybuffer'; } catch { /* ignore */ }
    sock.onopen = () => {
      if (manualStop || ws !== sock) return;
      diag?.record?.('ws:open', {});
      if (connectTimer !== null) { try { clearTimer(connectTimer); } catch { /* ignore */ } connectTimer = null; }
      sendJson({ type: 'start', lang: speechLang(lang) });
      readyTimer = setTimer(() => {
        readyTimer = null;
        if (!ready && !manualStop) fallbackToWebSpeech('ready-timeout');
      }, readyTimeoutMs);
    };
    sock.onmessage = (event) => { if (ws === sock) onMessage(event); };
    sock.onerror = (err) => {
      diag?.record?.('ws:error', {
        name: (err && err.name) || 'error',
        message: (err && err.message) || '',
      });
      if (manualStop) { closeSocket('ws-error'); return; }
      if (!ready) fallbackToWebSpeech('ws-error');
    };
    sock.onclose = (event) => {
      diag?.record?.('ws:close', {
        code: Number(event && event.code) || 0,
        reason: String((event && event.reason) || ''),
      });
      if (stopTimer !== null) { try { clearTimer(stopTimer); } catch { /* ignore */ } stopTimer = null; }
      if (manualStop || ws !== sock) return;
      fallbackToWebSpeech('ws-closed');
    };
    connectTimer = setTimer(() => {
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
    /** 最近一次测得的发送码率（B/s；正常 ≈ 32000） */
    get bytesPerSec() { return lastRate; },
    /** 一帧的字节数（100ms @16k/16bit/单声道 = 3200） */
    get frameBytes() { return FRAME_BYTES; },
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
      if (ws) closeSocket('restart');
      manualStop = false;
      running = true;
      ready = false;
      fallback = null;
      framer = null;
      chunks = 0;
      sentBytes = 0;
      framesLogged = 0;
      lastRate = 0;
      firstFrameAt = 0;
      rateMarkAt = 0;
      rateMarkBytes = 0;
      currentRoute = ASR_ROUTES.VOLC;
      diag?.record?.('route:volc', {});
      handlers.route?.({ route: ASR_ROUTES.VOLC });
      handlers.state?.('connecting');
      startVolc();
      return true;
    },
    /**
     * 停止。**不能**像以前那样发完 stop 就立刻关 WS：
     * 服务端收到 stop 后要等火山把最后一帧 final 吐出来（最多 3s）再 flush 给浏览器；
     * 浏览器先关的话，那一句就永远收不到了（日志里的 `final:false` / `segments:0`）。
     * 所以：先 flush 最后不足 100ms 的尾巴 → 发 stop → 关采集 → **等 final / 超时**再关 WS。
     */
    stop() {
      if (manualStop) return;
      running = false;
      clearTimers();
      // 尾巴（不足一帧）也要发出去，别把最后一个字切掉
      if (framer) {
        const tail = framer.flush();
        framer = null;
        if (tail && tail.length) sendPcmFrame(tail);
      }
      if (chunks) {
        diag?.record?.('ws:sent', {
          frames: chunks,
          bytes: sentBytes,
          ms: firstFrameAt ? Math.max(1, (Number(now()) || 0) - firstFrameAt) : 0,
        });
      }
      recordRate(true);
      const canWait = !!(ws && ws.readyState === 1 && ready);
      manualStop = true;
      ready = false;
      sendJson({ type: 'stop' });
      const fb = fallback;
      fallback = null;
      try { fb?.stop?.(); } catch { /* ignore */ }
      teardownAudio();
      currentRoute = '';
      if (!canWait) { closeSocket('client-stop'); return; }
      diag?.record?.('ws:drain', { ms: finalWaitMs });
      stopTimer = setTimer(() => {
        stopTimer = null;
        closeSocket('stop-timeout');
      }, finalWaitMs);
      if (stopTimer && typeof stopTimer.unref === 'function') {
        try { stopTimer.unref(); } catch { /* ignore */ }
      }
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
  diag = null,
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
          diag,
          fallbackFactory: fallbackFactory
            || (({ win: fw, lang: fl, mic: fm, diag: fd } = {}) => createAsr({ win: fw, lang: fl, mic: fm, diag: fd })),
        });
      } else {
        const factory = webSpeechFactory || createAsr;
        inner = factory({ win: w, lang, mic, diag });
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
 * `createVuMeter()` 才碰浏览器（AudioContext + AnalyserNode，麦克风流由调用方传进来）。
 * 拿不到共享流时由 coach.js 静默降级，**绝不另开一路 getUserMedia**。
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
 * 音量表适配器：**只做 AnalyserNode**，麦克风由调用方决定用哪一路。
 *
 *   open()      → Promise<boolean>   （失败 reject，由 coach.js 捕获后降级）
 *   readLevel() → number 0~1
 *   close()     → void   （断开节点 + AudioContext.close()；**共享流不 stop**，轨道归 createMic 管）
 *
 * 用户反馈「麦克风亮着但没字幕」的头号嫌疑就是多路 getUserMedia 抢麦：
 * 现在 app.js 把 `createMic()` 拿到的那一条 `MediaStream` 传进来（`stream`），
 * 这里**绝不再调 getUserMedia**；`requireStream: true` 时没有共享流就直接失败（静默降级），
 * 只有 Node 单测 / 旧调用不传 stream 时才保留「自己取麦」的兼容分支。
 */
export function createVuMeter({ win = null, stream: sharedStream = null, requireStream = false, diag = null } = {}) {
  const w = rootWin(win);
  let stream = null;
  let ownStream = false;
  let ctx = null;
  let source = null;
  let analyser = null;
  let bytes = null;
  let active = false;

  function stopTracks(s) {
    let tracks = [];
    try {
      tracks = typeof s?.getTracks === 'function' ? s.getTracks() : [];
    } catch { /* ignore */ }
    for (const track of tracks) {
      try { track.stop?.(); } catch { /* ignore */ }
    }
  }

  function close() {
    active = false;
    try { source?.disconnect?.(); } catch { /* ignore */ }
    source = null;
    analyser = null;
    bytes = null;
    if (ownStream && stream) stopTracks(stream);
    stream = null;
    ownStream = false;
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
      if (!Ctx) {
        const err = new Error('VU meter is not supported');
        err.code = 'vu-unsupported';
        throw err;
      }
      // 页面里**只允许**用会话层那一条共享流：拿不到就静默降级，绝不另开一路麦克风
      if (!sharedStream && requireStream) {
        const err = new Error('no shared microphone stream');
        err.code = 'vu-no-stream';
        throw err;
      }
      if (!sharedStream && (!media || typeof media.getUserMedia !== 'function')) {
        const err = new Error('VU meter is not supported');
        err.code = 'vu-unsupported';
        throw err;
      }
      let s = sharedStream || null;
      let owns = !s;
      let context = null;
      try {
        if (!s) s = await media.getUserMedia({ audio: true });
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
        ownStream = owns;
        ctx = context;
        source = src;
        analyser = node;
        bytes = new Uint8Array(node.fftSize);
        active = true;
        diag?.record?.('vu:open', { shared: !owns });
        return true;
      } catch (err) {
        // 失败时只收拾自己拿的那一路；共享流是别人的，绝不能在这里 stop
        if (owns && s) stopTracks(s);
        try { context?.close?.(); } catch { /* ignore */ }
        stream = null;
        ownStream = false;
        ctx = null;
        source = null;
        analyser = null;
        bytes = null;
        active = false;
        diag?.record?.('vu:fail', { name: (err && err.name) || 'Error', message: (err && err.message) || '' });
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
 *
 * ⚠️ 两条用户反馈（2026-11）都钉在这里：
 *   - 系统 TTS 的 `error` 事件里 `canceled` / `interrupted` **不是失败** —— 那是我们自己
 *     `cancel()` 造成的，记成 `tts:fail` 只会把排障日志搅浑（上一次就是这样把「火山其实
 *     一次都没播出声」掩盖掉的）；
 *   - `synthesis-unavailable` / `voice-unavailable` / `language-unavailable` 这类是**硬失败**
 *     （这台机器就没有可用语音），再试一百遍也不会出声 → 之后只出弹幕，不再徒劳调用。
 */
export function createTts({ win = null, lang = null, rate = 1, diag = null } = {}) {
  const w = rootWin(win);
  let speaking = false;
  let currentRate = Number(rate) > 0 ? Number(rate) : 1;
  let failLogged = false;
  /** 硬失败（系统没有可用语音）：true 之后 speak() 直接返回 false，只出字幕 */
  let dead = false;

  /** 我们自己 cancel() 引起的错误码：不是失败，不记 tts:fail */
  const BENIGN_ERRORS = new Set(['canceled', 'cancelled', 'interrupted']);
  /** 重试也不会出声的错误码：别再让每一句都白跑一遍合成器 */
  const HARD_ERRORS = new Set([
    'synthesis-unavailable', 'synthesis-failed',
    'language-unavailable', 'voice-unavailable',
  ]);

  function synth() { return w.speechSynthesis || null; }
  function Utterance() {
    return w.SpeechSynthesisUtterance
      || (typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : null);
  }

  const api = {
    kind: 'mock',
    name: 'speechSynthesis',
    get supported() { return !dead && !!(synth() && Utterance()); },
    get speaking() { return speaking; },
    get rate() { return currentRate; },
    get lang() { return speechLang(lang); },
    /** 系统语音不可用（硬失败）—— 上层据此只出弹幕 */
    get unavailable() { return dead; },
    setRate(n) {
      const v = Number(n);
      if (Number.isFinite(v) && v > 0) currentRate = Math.min(2, Math.max(0.5, v));
      return currentRate;
    },
    speak(text, { onEnd = null, onError = null } = {}) {
      const s = synth();
      const U = Utterance();
      const body = String(text == null ? '' : text);
      if (!s || !U || !body.trim() || dead) {
        if (!failLogged && !dead) {
          failLogged = true;
          diag?.record?.('tts:fail', {
            code: s && U ? 'empty' : 'unsupported', where: 'system', chars: body.length,
          });
        }
        return false;
      }
      try {
        s.cancel();
        const u = new U(body);
        u.lang = speechLang(lang);
        u.rate = currentRate;
        u.onend = () => { speaking = false; try { onEnd?.(); } catch { /* ignore */ } };
        u.onerror = (err) => {
          speaking = false;
          const code = String((err && (err.error || err.name)) || 'error');
          if (HARD_ERRORS.has(code)) dead = true;
          if (!BENIGN_ERRORS.has(code)) {
            const info = { code, where: 'system', chars: body.length, errName: code };
            const message = String((err && err.message) || '').slice(0, 80);
            if (message) info.errMessage = message;
            diag?.record?.('tts:fail', info);
          }
          try { onError?.(err); } catch { /* ignore */ }
        };
        s.speak(u);
        speaking = true;
        failLogged = false;
        diag?.record?.('tts:say', { chars: body.length });
        return true;
      } catch {
        speaking = false;
        diag?.record?.('tts:fail', { code: 'speak', where: 'system', chars: body.length });
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
