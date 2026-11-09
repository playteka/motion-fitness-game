/**
 * 火山 TTS 的前端播放层（P3.6）。
 *
 * 链路：`speak(text)` → `POST /tts`（预览服务器代理火山 v3 合成）→ 拿回 `audio/mpeg`
 * → `new Audio(URL.createObjectURL(blob))` 播放。
 *
 * 用户口径（照做）：
 *   - **火山优先**（设置里 `音色来源 = 自动` 是默认）；`火山` 只试火山、`系统` 直接用系统 TTS；
 *   - **3 秒超时 / 502 / 网络错 → 自动回退系统 TTS**，并记诊断 `tts:fallback`；
 *   - 新一句要说时**先停上一句**（停播放 + 释放 blob URL），绝不留后台音频；
 *   - `stop()` / `close()` 释放**所有** blob URL（避免内存泄漏）；
 *   - 「教练：」前缀只显示不念 —— 前缀在弹幕 / 字幕层加，这里收到的 `text` 是纯正文。
 *
 * 接口和 `createTts()`（providers.js）完全一致：`speak(text, {onEnd,onError}) → boolean`、
 * `cancel()`、`setRate()`。`speak()` 返回 true = 已经接下这一句（异步播放），
 * 结束 / 失败都会回调，**绝不 hang 在 speaking 状态**。
 */

export const TTS_PATH = '/tts';
export const TTS_HEALTH_PATH = '/tts/health';
/** 服务端合成超时（客户端这段时间没拿到音频就回退系统 TTS） */
export const TTS_TIMEOUT_MS = 3000;
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

/**
 * 创建火山 TTS 播放器。
 *
 * @param {object} [opts]
 * @param {object} [opts.fallback]      系统 TTS（providers.js 的 createTts()）；火山失败时用它
 * @param {Function} [opts.fetchImpl]   注入 fetch（Node 单测）
 * @param {Function} [opts.AudioCtor]   注入 Audio 构造器（Node 单测）
 * @param {Function} [opts.createObjectURL]
 * @param {Function} [opts.revokeObjectURL]
 * @param {object} [opts.win]           浏览器 window（取 fetch / Audio / URL）
 * @param {object} [opts.diag]          诊断收集器（record('tts:fallback') 等）
 * @param {string} [opts.source]        'auto' | 'volc' | 'system'
 * @param {number} [opts.rate]          语速（0.5~2）
 * @param {number} [opts.timeoutMs]     合成超时（默认 3000）
 * @param {string} [opts.endpoint]      默认 /tts
 */
export function createVolcTts({
  fallback = null,
  fetchImpl = null,
  AudioCtor = null,
  createObjectURL = null,
  revokeObjectURL = null,
  win = null,
  diag = null,
  source = TTS_DEFAULT_SOURCE,
  rate = 1,
  timeoutMs = TTS_TIMEOUT_MS,
  endpoint = TTS_PATH,
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

  function releaseToken(token, { end = false, error = null } = {}) {
    if (!token) return;
    clearTimer(token);
    if (token.audio) {
      try { token.audio.pause?.(); } catch { /* ignore */ }
      try { token.audio.src = ''; } catch { /* ignore */ }
    }
    if (token.url) {
      dropUrl(token.url);
      token.url = '';
    }
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

  /** 回退系统 TTS；系统 TTS 也不能用时也要回调 onError，绝不把会话晾在 speaking */
  function useFallback(token, body, code) {
    if (!token || token !== current || closed) return false;
    if (token.mode === 'system') return false;
    token.mode = 'system';
    // 火山那边可能已经拿到 blob / 已经开始播（例如 play() 被拒）：先停掉并释放，再交给系统 TTS
    if (token.audio) {
      try { token.audio.pause?.(); } catch { /* ignore */ }
      token.audio = null;
    }
    if (token.url) {
      dropUrl(token.url);
      token.url = '';
    }
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

  async function playVolc(token, body) {
    const send = pickFetch();
    if (!send) {
      diag?.record?.('tts:fail', { code: 'no-fetch', chars: body.length });
      useFallback(token, body, 'no-fetch');
      return;
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
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
      if (closed || token !== current) return;              // 期间被 stop / 新一句打断
      if (!res || res.ok === false) {
        const status = res && res.status ? res.status : 0;
        throw Object.assign(new Error('tts upstream failed'), { code: status === 502 ? 'upstream' : 'http', status });
      }
      const blob = await res.blob();
      if (closed || token !== current) return;
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
        token.mode = 'volc';
        useFallback(token, body, 'audio-error');
      };
      const started = audio.play();
      if (started && typeof started.then === 'function') await started;
      if (closed || token !== current || token.mode !== 'volc') return;
      diag?.record?.('tts:say', { chars: body.length, source: 'volc' });
    } catch (err) {
      if (closed || token !== current) return;
      const code = timedOut ? 'timeout' : ((err && err.code) || 'network');
      diag?.record?.('tts:fail', { code, chars: body.length });
      useFallback(token, body, code);
    } finally {
      clearTimer(token);
    }
  }

  function speak(text, { onEnd = null, onError = null } = {}) {
    const body = ttsText(text);
    if (closed || !body) return false;
    // 新一句先说：停掉上一句（停播放 + 释放 blob URL）
    stop();
    const token = {
      id: (seq += 1),
      mode: 'volc',
      audio: null,
      url: '',
      timer: null,
      done: false,
      onEnd,
      onError,
    };
    current = token;
    speaking = true;
    if (currentSource === 'system') {
      useFallback(token, body, '');
      return true;
    }
    playVolc(token, body).catch(() => {
      // playVolc 自己不会 reject；这里只兜底（绝不让一句悄悄消失）
      if (token === current) useFallback(token, body, 'exception');
    });
    return true;
  }

  function stop() {
    const token = current;
    if (token) releaseToken(token, { end: true });
    // 即使当前没有 token 也要把系统 TTS 掐掉：上一句可能已经播完但合成器里还有残留，
    // 而且外部（例如会话 stop / 静音）期望 cancel 一定有求必应。
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
    speak,
    stop,
    cancel: stop,
    close,
    setRate,
    setSource,
  };
  return api;
}

export default { createVolcTts, TTS_SOURCES, TTS_DEFAULT_SOURCE, TTS_PATH, TTS_HEALTH_PATH };
