/**
 * 火山 TTS 的前端播放层（P3.6 整段 → P3.4 流式 + 插话打断）。
 *
 * 三级降级（每级都记诊断，绝不哑掉）：
 *   ① `POST /tts/stream` → 边收边转发 → **AudioContext 解码队列**按时间轴排（首字最快）；
 *      记 `tts:first-audio {ms}`；失败记 `tts:stream-fail {code}`；
 *   ② 流式 404 / 不支持 / 失败 → `POST /tts` 整段（服务端有缓存），记 `tts:whole`；
 *   ③ 整段也 502 / 超时 / 网络错 → 系统 TTS，记 `tts:fallback {code}`。
 *
 * 用户口径（照做）：
 *   - **火山优先**（设置里 `音色来源 = 自动` 是默认）；`火山` 只试火山、`系统` 直接用系统 TTS；
 *   - **3 秒超时 / 502 / 网络错 → 自动回退**，诊断面板能看到「首字 xx ms」；
 *   - 新一句要说时**先停上一句**（停播放 + abort 流式请求 + 释放解码队列 / blob URL）；
 *   - `stop()` / `close()` 释放**所有**资源；`stop()` 还要 **abort 上游** —— 插话打断靠它；
 *   - 「教练：」前缀只显示不念 —— 前缀在弹幕 / 字幕层加，这里收到的 `text` 是纯正文。
 *
 * 接口和 `createTts()`（providers.js）完全一致：`speak(text, {onEnd,onError}) → boolean`、
 * `cancel()`、`setRate()`。`speak()` 返回 true = 已经接下这一句（异步播放），
 * 结束 / 失败都会回调，**绝不 hang 在 speaking 状态**。
 */

export const TTS_PATH = '/tts';
export const TTS_STREAM_PATH = '/tts/stream';
export const TTS_HEALTH_PATH = '/tts/health';
/** 服务端合成超时（客户端这段时间没拿到音频就往下走一级） */
export const TTS_TIMEOUT_MS = 3000;
/** 流式排程的提前量：第一块音频别卡在「刚好现在」，留一点解码 / 调度余量 */
export const TTS_STREAM_LEAD_SEC = 0.06;
/** 音色来源：自动（火山优先）/ 火山 / 系统 */
export const TTS_SOURCES = Object.freeze(['auto', 'volc', 'system']);
export const TTS_DEFAULT_SOURCE = 'auto';
export const TTS_RATE_MIN = 0.5;
export const TTS_RATE_MAX = 2;
export const TTS_MAX_CHARS = 300;

export function normalizeTtsSource(source) {
  return TTS_SOURCES.includes(source) ? source : TTS_DEFAULT_SOURCE;
}

/** 语速收在 0.5~2（和系统 TTS 的 setRate 同一档），非法值回到 1 */
export function normalizeTtsRate(rate) {
  const v = Number(rate);
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, Math.round(v * 100) / 100));
}

/** 一句正文 → 送进 /tts 的文本（去首尾空白、超长截断） */
export function ttsText(text) {
  const body = String(text == null ? '' : text).trim();
  return body.length > TTS_MAX_CHARS ? body.slice(0, TTS_MAX_CHARS) : body;
}

/* ================================================================== *
 * 流式调度（纯函数）：音频块 → 时间轴
 * ================================================================== */

/**
 * 给定一串音频块（每块的时长）与起始时间轴，算出**每块该在什么时候播**。
 *
 * 纯函数、不碰 AudioContext，所以 Node 里可以直接断言：
 *   - **不丢块**：返回条数 === 输入条数，`index` 与输入顺序一一对应；
 *   - **不重叠**：第 i 块 `startSec >=` 第 i-1 块 `endSec`；
 *   - **不早于现在**：第一块不会排到「过去」（解码 / 网络晚了就顺延，
 *     这也是播放期插话时不会出现两次同时开口的原因）。
 *
 * @param {Array<number|{durationSec:number}>} chunks 每块时长（秒）
 * @param {object} [opts]
 * @param {number} [opts.nowSec]     当前音频时钟（`AudioContext.currentTime`）
 * @param {number} [opts.leadSec]    提前量（默认 60ms）
 * @param {number|null} [opts.startAtSec] 上一块排到的位置；null = 从 now + lead 开始
 * @returns {Array<{index:number,startSec:number,endSec:number,durationSec:number}>}
 */
export function planStreamQueue(chunks, {
  nowSec = 0,
  leadSec = TTS_STREAM_LEAD_SEC,
  startAtSec = null,
} = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  const now = Math.max(0, Number(nowSec) || 0);
  const lead = Math.max(0, Number(leadSec) || 0);
  const start = Number(startAtSec);
  const base = startAtSec === null || startAtSec === undefined || !Number.isFinite(start)
    ? -Infinity
    : start;
  const earliest = now + lead;
  let next = Math.max(base, earliest);
  const out = [];
  list.forEach((chunk, index) => {
    const raw = chunk && typeof chunk === 'object' ? chunk.durationSec : chunk;
    const durationSec = Math.max(0, Number(raw) || 0);
    const startSec = Math.max(next, earliest);
    const endSec = startSec + durationSec;
    out.push({ index, startSec, endSec, durationSec });
    next = endSec;
  });
  return out;
}

/** 任意块（Uint8Array / ArrayBuffer / Buffer）→ ArrayBuffer（复制，decodeAudioData 会独占） */
function toArrayBuffer(chunk) {
  if (!chunk) return new ArrayBuffer(0);
  if (chunk instanceof ArrayBuffer) return chunk.slice(0);
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(chunk)) {
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    return copy.buffer;
  }
  return new ArrayBuffer(0);
}

/**
 * AudioContext 解码队列（比 MediaSource 稳：Chrome / Edge / Safari 都不保证
 * `SourceBuffer` 支持 `audio/mpeg`，而 `decodeAudioData` 到处都有）。
 *
 *   push(arrayBuffer) → 解出 AudioBuffer → 按 `planStreamQueue` 排在上一块之后 → start(when)
 *   finish()          → 流结束；所有块播完回调 onEnd
 *   stop()            → 停所有 source + close AudioContext（插话打断 / 新一句先说）
 */
export function createAudioQueuePlayer({
  win = null,
  AudioContextCtor = null,
  leadSec = TTS_STREAM_LEAD_SEC,
  onEnd = null,
} = {}) {
  const w = win || (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {}));
  const CtxCtor = AudioContextCtor
    || (w && typeof w.AudioContext === 'function' ? w.AudioContext : null)
    || (w && typeof w.webkitAudioContext === 'function' ? w.webkitAudioContext : null)
    || (typeof AudioContext !== 'undefined' ? AudioContext : null);
  let ctx = null;
  let gain = null;
  let nextStart = null;
  const sources = new Set();
  let pending = 0;
  let ended = false;
  let endFired = false;
  let stopped = false;
  let bytes = 0;
  let playedChunks = 0;

  function maybeEnd() {
    if (!ended || pending > 0 || endFired || stopped) return;
    endFired = true;
    try { onEnd?.(); } catch { /* ignore */ }
  }

  async function open() {
    if (ctx) return ctx;
    if (!CtxCtor) {
      throw Object.assign(new Error('AudioContext unavailable'), { code: 'no-audio-context' });
    }
    ctx = new CtxCtor();
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try { await ctx.resume(); } catch { /* ignore */ }
    }
    if (typeof ctx.createGain === 'function') {
      gain = ctx.createGain();
      try { gain.connect?.(ctx.destination); } catch { /* ignore */ }
    }
    return ctx;
  }

  function decode(buffer) {
    return new Promise((resolve, reject) => {
      if (!ctx || typeof ctx.decodeAudioData !== 'function') {
        reject(Object.assign(new Error('decodeAudioData unavailable'), { code: 'no-decode' }));
        return;
      }
      let settled = false;
      const done = (data) => {
        if (settled) return;
        settled = true;
        if (data && (Number(data.duration) > 0 || Number(data.length) >= 0)) resolve(data);
        else reject(Object.assign(new Error('empty audio'), { code: 'decode' }));
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(Object.assign(new Error('decode failed'), { code: 'decode', cause: err }));
      };
      try {
        const ret = ctx.decodeAudioData(buffer, done, fail);
        if (ret && typeof ret.then === 'function') ret.then(done, fail);
      } catch (err) {
        fail(err);
      }
    });
  }

  /** 解一块并排到时间轴上；返回它被安排的位置 */
  async function push(chunk) {
    if (stopped) return null;
    const context = await open();
    const buffer = toArrayBuffer(chunk);
    const data = await decode(buffer);
    if (stopped) return null;
    const durationSec = Math.max(0, Number(data.duration) || 0);
    const [plan] = planStreamQueue([{ durationSec }], {
      nowSec: context.currentTime,
      leadSec,
      startAtSec: nextStart,
    });
    const src = context.createBufferSource();
    src.buffer = data;
    if (gain) src.connect(gain); else src.connect?.(context.destination);
    pending += 1;
    sources.add(src);
    src.onended = () => {
      sources.delete(src);
      pending -= 1;
      maybeEnd();
    };
    try {
      src.start(plan.startSec);
    } catch (err) {
      sources.delete(src);
      pending -= 1;
      throw Object.assign(new Error('start failed'), { code: 'start', cause: err });
    }
    nextStart = plan.endSec;
    bytes += buffer.byteLength;
    playedChunks += 1;
    return { ...plan, bytes: buffer.byteLength, durationSec };
  }

  /** 流收完了：等最后一块播完就回调 onEnd（不 hang） */
  function finish() {
    ended = true;
    maybeEnd();
    return api;
  }

  function stop() {
    if (stopped) return api;
    stopped = true;
    for (const src of sources) {
      try { src.onended = null; } catch { /* ignore */ }
      try { src.stop?.(); } catch { /* ignore */ }
      try { src.disconnect?.(); } catch { /* ignore */ }
    }
    sources.clear();
    pending = 0;
    if (gain) {
      try { gain.disconnect?.(); } catch { /* ignore */ }
      gain = null;
    }
    const c = ctx;
    ctx = null;
    if (c && typeof c.close === 'function') {
      try {
        const p = c.close();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch { /* ignore */ }
    }
    return api;
  }

  const api = {
    kind: 'audio-queue',
    push,
    finish,
    stop,
    close: stop,
    get active() { return !!ctx && !stopped; },
    get bytes() { return bytes; },
    get chunks() { return playedChunks; },
    get pending() { return pending; },
    get nextStartSec() { return nextStart; },
  };
  return api;
}

/* ================================================================== *
 * 播放器：三级降级
 * ================================================================== */

/**
 * 创建火山 TTS 播放器。
 *
 * @param {object} [opts]
 * @param {object} [opts.fallback]      系统 TTS（providers.js 的 createTts()）；最后一级
 * @param {Function} [opts.fetchImpl]   注入 fetch（Node 单测）
 * @param {Function} [opts.AudioCtor]   注入 Audio 构造器（整段播放；Node 单测）
 * @param {Function} [opts.AudioContextCtor] 注入 AudioContext（流式解码队列；Node 单测）
 * @param {Function} [opts.createObjectURL]
 * @param {Function} [opts.revokeObjectURL]
 * @param {object} [opts.win]           浏览器 window（取 fetch / Audio / URL / AudioContext）
 * @param {object} [opts.diag]          诊断收集器（record('tts:first-audio') 等）
 * @param {string} [opts.source]        'auto' | 'volc' | 'system'
 * @param {number} [opts.rate]          语速（0.5~2）
 * @param {number} [opts.timeoutMs]     首块 / 整段超时（默认 3000）
 * @param {string} [opts.endpoint]      整段接口（默认 /tts）
 * @param {string} [opts.streamEndpoint] 流式接口（默认 /tts/stream）
 * @param {boolean} [opts.stream]       是否先试流式（默认 true；测试可关掉）
 */
export function createVolcTts({
  fallback = null,
  fetchImpl = null,
  AudioCtor = null,
  AudioContextCtor = null,
  createObjectURL = null,
  revokeObjectURL = null,
  win = null,
  diag = null,
  source = TTS_DEFAULT_SOURCE,
  rate = 1,
  timeoutMs = TTS_TIMEOUT_MS,
  endpoint = TTS_PATH,
  streamEndpoint = TTS_STREAM_PATH,
  stream: useStream = true,
  now = () => Date.now(),
} = {}) {
  const w = win || (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {}));
  const timeout = Math.max(1, Number(timeoutMs) || TTS_TIMEOUT_MS);
  let currentSource = normalizeTtsSource(source);
  let currentRate = normalizeTtsRate(rate);
  let current = null;          // 正在播 / 正在取的那一句
  let seq = 0;
  let closed = false;
  let speaking = false;

  function pickFetch() {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (w && typeof w.fetch === 'function') return w.fetch.bind(w);
    if (typeof fetch === 'function') return fetch;
    return null;
  }

  function pickAudio() {
    if (typeof AudioCtor === 'function') return AudioCtor;
    if (w && typeof w.Audio === 'function') return w.Audio;
    if (typeof Audio !== 'undefined') return Audio;
    return null;
  }

  function pickAudioContext() {
    if (typeof AudioContextCtor === 'function') return AudioContextCtor;
    if (w && typeof w.AudioContext === 'function') return w.AudioContext;
    if (w && typeof w.webkitAudioContext === 'function') return w.webkitAudioContext;
    if (typeof AudioContext !== 'undefined') return AudioContext;
    return null;
  }

  function makeUrl(blob) {
    const fn = typeof createObjectURL === 'function'
      ? createObjectURL
      : (w && w.URL && typeof w.URL.createObjectURL === 'function' ? w.URL.createObjectURL.bind(w.URL) : null);
    if (!fn) throw Object.assign(new Error('createObjectURL unavailable'), { code: 'no-object-url' });
    return fn(blob);
  }

  function dropUrl(url) {
    if (!url) return;
    try {
      const fn = typeof revokeObjectURL === 'function'
        ? revokeObjectURL
        : (w && w.URL && typeof w.URL.revokeObjectURL === 'function' ? w.URL.revokeObjectURL.bind(w.URL) : null);
      fn?.(url);
    } catch { /* ignore */ }
  }

  function clearTimer(token) {
    if (!token || token.timer === null || token.timer === undefined) return;
    try { clearTimeout(token.timer); } catch { /* ignore */ }
    token.timer = null;
  }

  /** 掐断这一句的所有异步资源：上游请求 / 流读取 / 解码队列 / Audio / blob URL */
  function releaseSources(token) {
    if (!token) return;
    try { token.controller?.abort?.(); } catch { /* ignore */ }
    token.controller = null;
    try { token.reader?.cancel?.(); } catch { /* ignore */ }
    token.reader = null;
    try { token.player?.stop?.(); } catch { /* ignore */ }
    token.player = null;
    if (token.audio) {
      try { token.audio.pause?.(); } catch { /* ignore */ }
      try { token.audio.src = ''; } catch { /* ignore */ }
      token.audio = null;
    }
    if (token.url) {
      dropUrl(token.url);
      token.url = '';
    }
  }

  function releaseToken(token, { end = false, error = null } = {}) {
    if (!token) return;
    clearTimer(token);
    token.stopped = true;
    releaseSources(token);
    if (token !== current) return;
    current = null;
    speaking = false;
    if (token.done) return;
    token.done = true;
    if (end) {
      try { token.onEnd?.(); } catch { /* ignore */ }
    } else if (error) {
      try { token.onError?.(error); } catch { /* ignore */ }
    }
  }

  /** ③ 回退系统 TTS；系统 TTS 也不能用时也要回调 onError，绝不把会话晾在 speaking */
  function useFallback(token, body, code) {
    if (!token || token !== current || closed) return false;
    if (token.mode === 'system') return false;
    token.mode = 'system';
    // 火山那条路可能已经拿到 blob / 已经开始播（例如 play() 被拒）：先全部放掉
    releaseSources(token);
    if (code) diag?.record?.('tts:fallback', { code, chars: body.length });
    const can = fallback && typeof fallback.speak === 'function';
    if (can) {
      let ok = false;
      try {
        ok = fallback.speak(body, {
          onEnd: () => releaseToken(token, { end: true }),
          onError: (err) => releaseToken(token, { error: err || { code: 'fallback-error' } }),
        });
      } catch {
        ok = false;
      }
      if (ok) {
        diag?.record?.('tts:say', { chars: body.length, source: 'system' });
        return true;
      }
    }
    releaseToken(token, { error: { code: 'fallback-unsupported' } });
    return false;
  }

  /**
   * ① 流式：POST /tts/stream，边收边 push 到解码队列。
   * @returns {Promise<boolean>} true = 这一句已经由流式接手（含「播到一半失败 → 收尾」）
   */
  async function tryStream(token, body) {
    const send = pickFetch();
    const CtxCtor = pickAudioContext();
    if (!send) {
      diag?.record?.('tts:stream-fail', { code: 'no-fetch', chars: body.length });
      return false;
    }
    if (!CtxCtor) {
      // 没有 AudioContext（极老浏览器 / 测试桩）：直接走整段，不在前端拼解码队列
      diag?.record?.('tts:stream-fail', { code: 'no-audio-context', chars: body.length });
      return false;
    }

    const player = createAudioQueuePlayer({
      win: w,
      AudioContextCtor: CtxCtor,
      onEnd: () => releaseToken(token, { end: true }),
    });
    token.player = player;

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    token.controller = controller;
    let timedOut = false;
    token.timer = setTimeout(() => {
      timedOut = true;
      try { controller?.abort?.(); } catch { /* ignore */ }
    }, timeout);
    if (token.timer && typeof token.timer.unref === 'function') {
      try { token.timer.unref(); } catch { /* ignore */ }
    }

    let streamStarted = false;
    try {
      const res = await send(streamEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body, rate: currentRate, stream: true }),
        signal: controller ? controller.signal : undefined,
      });
      if (closed || token !== current || token.stopped) return true;
      if (!res || res.ok === false) {
        diag?.record?.('tts:stream-fail', {
          code: (res && res.status) === 404 ? 'not-supported' : 'http',
          status: (res && res.status) || 0,
          chars: body.length,
        });
        return false;
      }
      const reader = pickBodyReader(res.body);
      if (!reader) {
        diag?.record?.('tts:stream-fail', { code: 'no-body', chars: body.length });
        return false;
      }
      token.reader = reader;
      let first = false;
      while (true) {
        const step = await reader.next();
        if (!step || step.done) break;
        if (closed || token !== current || token.stopped) return true;
        const piece = step.value;
        if (!piece || !piece.length) continue;
        const buffer = toArrayBuffer(piece);
        if (!buffer.byteLength) continue;
        if (!first) {
          first = true;
          clearTimer(token);   // 首块到了：不再按「整句超时」算
          diag?.record?.('tts:first-audio', {
            ms: Math.max(0, Math.round(now() - token.startedAt)),
            bytes: buffer.byteLength,
          });
        }
        await player.push(buffer);
        /**
         * 只有**真的排进解码队列**才算「流式已经出声」：
         * 第一块解码失败（例如 MP3 帧被切断）时 streamStarted 还是 false，
         * 上层会整段重试 /tts，而不是静悄悄地把这句话吞掉。
         */
        streamStarted = true;
        token.streamStarted = true;
        if (closed || token !== current || token.stopped) return true;
      }
      token.reader = null;
      if (!first) {
        // 200 但一个字节都没有：当成流式不可用，交给整段
        diag?.record?.('tts:stream-fail', { code: 'empty', chars: body.length });
        return false;
      }
      player.finish();
      diag?.record?.('tts:say', { chars: body.length, source: 'volc', stream: true });
      return true;
    } catch {
      if (closed || token !== current || token.stopped) return true;
      const code = timedOut ? 'timeout' : 'stream';
      diag?.record?.('tts:stream-fail', { code, chars: body.length });
      if (!streamStarted) {
        // 还没出过声：把流式这一级收拾干净，交给整段重试
        try { token.reader?.cancel?.(); } catch { /* ignore */ }
        token.reader = null;
        try { token.controller?.abort?.(); } catch { /* ignore */ }
        token.controller = null;
        try { player.stop(); } catch { /* ignore */ }
        token.player = null;
        return false;
      }
      // 已经出声了：不重念（重念会「说到一半又从头说」），就此收尾
      releaseToken(token, { end: true });
      return true;
    } finally {
      clearTimer(token);
    }
  }

  /** ② 整段：POST /tts → blob → Audio 播放（服务端有缓存） */
  async function playWhole(token, body) {
    if (closed || token !== current || token.stopped) return;
    const send = pickFetch();
    if (!send) {
      diag?.record?.('tts:fail', { code: 'no-fetch', chars: body.length });
      useFallback(token, body, 'no-fetch');
      return;
    }
    token.mode = 'whole';
    diag?.record?.('tts:whole', { chars: body.length });
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    token.controller = controller;
    let timedOut = false;
    token.timer = setTimeout(() => {
      timedOut = true;
      try { controller?.abort?.(); } catch { /* ignore */ }
    }, timeout);
    if (token.timer && typeof token.timer.unref === 'function') {
      try { token.timer.unref(); } catch { /* ignore */ }
    }
    try {
      const res = await send(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body, rate: currentRate }),
        signal: controller ? controller.signal : undefined,
      });
      if (closed || token !== current || token.stopped) return;
      if (!res || res.ok === false) {
        const status = res && res.status ? res.status : 0;
        throw Object.assign(new Error('tts upstream failed'), { code: status === 502 ? 'upstream' : 'http', status });
      }
      const blob = await res.blob();
      if (closed || token !== current || token.stopped) return;
      clearTimer(token);
      const url = makeUrl(blob);
      token.url = url;
      const AudioCtorNow = pickAudio();
      if (!AudioCtorNow) throw Object.assign(new Error('Audio unavailable'), { code: 'no-audio' });
      const audio = new AudioCtorNow(url);
      token.audio = audio;
      audio.onended = () => releaseToken(token, { end: true });
      audio.onerror = () => {
        diag?.record?.('tts:fail', { code: 'audio', chars: body.length });
        token.audio = null;
        token.mode = 'whole';
        useFallback(token, body, 'audio-error');
      };
      const started = audio.play();
      if (started && typeof started.then === 'function') await started;
      if (closed || token !== current || token.mode !== 'whole') return;
      diag?.record?.('tts:say', { chars: body.length, source: 'volc', stream: false });
    } catch (err) {
      if (closed || token !== current || token.stopped) return;
      const code = timedOut ? 'timeout' : ((err && err.code) || 'network');
      diag?.record?.('tts:fail', { code, chars: body.length });
      useFallback(token, body, code);
    } finally {
      clearTimer(token);
    }
  }

  /** ① → ②（流式不可用 / 失败时交给整段） */
  async function playStreaming(token, body) {
    let handled = false;
    if (useStream) handled = await tryStream(token, body);
    if (handled) return;
    if (closed || token !== current || token.stopped) return;
    await playWhole(token, body);
  }

  function speak(text, { onEnd = null, onError = null } = {}) {
    const body = ttsText(text);
    if (closed || !body) return false;
    // 新一句先说：停掉上一句（停播放 + abort 流式请求 + 释放解码队列 / blob URL）
    stop();
    const token = {
      id: (seq += 1),
      mode: 'stream',
      audio: null,
      url: '',
      timer: null,
      done: false,
      stopped: false,
      controller: null,
      reader: null,
      player: null,
      streamStarted: false,
      startedAt: now(),
      onEnd,
      onError,
    };
    current = token;
    speaking = true;
    if (currentSource === 'system') {
      useFallback(token, body, '');
      return true;
    }
    playStreaming(token, body).catch(() => {
      // playStreaming 自己不会 reject；这里只兜底（绝不让一句悄悄消失）
      if (token === current) useFallback(token, body, 'exception');
    });
    return true;
  }

  function stop() {
    const token = current;
    if (token) releaseToken(token, { end: true });
    // 即使当前没有 token 也要把系统 TTS 掐掉：上一句可能已经播完但合成器里还有残留，
    // 而且外部（例如会话 stop / 静音 / 插话打断）期望 cancel 一定有求必应。
    if (fallback && typeof fallback.cancel === 'function') {
      try { fallback.cancel(); } catch { /* ignore */ }
    }
    return api;
  }

  function close() {
    stop();
    closed = true;
  }

  function setRate(n) {
    currentRate = normalizeTtsRate(n);
    if (fallback && typeof fallback.setRate === 'function') {
      try { fallback.setRate(currentRate); } catch { /* ignore */ }
    }
    return currentRate;
  }

  function setSource(v) {
    currentSource = normalizeTtsSource(v);
    return currentSource;
  }

  const api = {
    kind: 'volc',
    name: 'volc-tts',
    get supported() {
      return !!pickFetch() || !!(fallback && fallback.supported);
    },
    get speaking() { return speaking; },
    get rate() { return currentRate; },
    get source() { return currentSource; },
    get timeoutMs() { return timeout; },
    get mode() { return current ? current.mode : ''; },
    speak,
    stop,
    cancel: stop,
    close,
    setRate,
    setSource,
  };
  return api;
}

/** fetch 响应体 → `{ next, cancel }`（浏览器 ReadableStream / Node 异步可迭代都支持） */
function pickBodyReader(body) {
  if (!body) return null;
  try {
    const swallow = (p) => {
      // cancel / return 的 Promise 在「请求已被 abort」时会 reject，必须接住
      if (p && typeof p.catch === 'function') p.catch(() => {});
    };
    if (typeof body.getReader === 'function') {
      const reader = body.getReader();
      return {
        next: () => reader.read(),
        cancel: () => { try { swallow(reader.cancel?.()); } catch { /* ignore */ } },
      };
    }
    if (typeof body[Symbol.asyncIterator] === 'function') {
      const it = body[Symbol.asyncIterator]();
      return {
        next: () => it.next(),
        cancel: () => { try { swallow(it.return?.()); } catch { /* ignore */ } },
      };
    }
  } catch { /* ignore */ }
  return null;
}

export default {
  createVolcTts,
  createAudioQueuePlayer,
  planStreamQueue,
  TTS_SOURCES,
  TTS_DEFAULT_SOURCE,
  TTS_PATH,
  TTS_STREAM_PATH,
  TTS_HEALTH_PATH,
};
