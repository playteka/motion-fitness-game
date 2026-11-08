/**
 * 「语音自检」（P3.5）：**完全独立**于 AI 教练会话的一键排障流程。
 *
 *   mic → 代理连接 → 录 2 秒并发送 → 等服务端 partial / final
 *
 * 为什么独立：用户反馈「麦克风亮着但没字幕」，这时候主流程（Ctrl+I / 会话状态机）本身可能
 * 已经被错误状态卡住，再拿它来测就分不清「哪一步坏了」。这里自己取麦、自己连 `/asr`、
 * 自己录一段 PCM 发出去，每一步都在诊断面板里写清楚；失败时用 TTS 把**失败的那一步**说出来
 * （「麦克风没打开」/「代理连不上」/「火山返回 403」…）。
 *
 * 设计约束：
 *   - 不碰 `createVoiceSession` / `createMic` 的实例（只复用 `createVuMeter` / `startPcmCapture`
 *     这两个无状态工具），所以它开着也不会影响教练；
 *   - 结束时一定释放：音轨 stop、AudioContext.close()、WebSocket.close()、音量表 close()；
 *   - 全程可注入（window / WebSocket / AudioContext / getUserMedia / 定时器 / TTS），Node 里可测；
 *   - 只上报计数与文本（走 diag.js，自带截断与脱敏），**不传音频**。
 */

import { t, getLang, getMeta } from '../i18n.js';
import {
  createVuMeter, startPcmCapture, resolveAsrUrl, sameOriginAsrUrl,
  DEFAULT_ASR_WS_URL,
} from './providers.js';
import { downsampleToPcm16 } from './pcm.js';

export const SELF_TEST_STEPS = Object.freeze(['mic', 'ws', 'send', 'result']);
export const SELF_TEST_STEP_KEYS = Object.freeze({
  mic: 'coach.selfTest.step.mic',
  ws: 'coach.selfTest.step.ws',
  send: 'coach.selfTest.step.send',
  result: 'coach.selfTest.step.result',
});
export const SELF_TEST_FAIL_KEYS = Object.freeze({
  mic: 'coach.selfTest.fail.mic',
  ws: 'coach.selfTest.fail.ws',
  send: 'coach.selfTest.fail.send',
  result: 'coach.selfTest.fail.timeout',
});
export const SELF_TEST_FAIL_UPSTREAM_KEY = 'coach.selfTest.fail.upstream';

/** 当前语言的识别语言标签（zh-CN / en-US），和 providers.js 的规则一致 */
export function selfTestLang() {
  try {
    const meta = getMeta();
    if (meta && meta.speechLang) return meta.speechLang;
  } catch { /* ignore */ }
  return getLang() === 'zh' ? 'zh-CN' : 'en-US';
}

function rootWin(win) {
  if (win) return win;
  if (typeof window !== 'undefined') return window;
  return typeof globalThis !== 'undefined' ? globalThis : {};
}

function blankSteps() {
  const out = {};
  for (const id of SELF_TEST_STEPS) out[id] = 'pending';
  return out;
}

/**
 * 创建自检控制器。
 *
 * @param {object}   [opts]
 * @param {object}   [opts.win]        浏览器 window（测试注入）
 * @param {object}   [opts.diag]       诊断收集器（createDiag）
 * @param {object}   [opts.tts]        TTS 适配器（失败时把原因说出来；可选）
 * @param {Function} [opts.speak]      自定义「说一句」（优先于 tts.speak）
 * @param {string}   [opts.url]        代理地址（默认 resolveAsrUrl / 同源 /asr）
 * @param {number}   [opts.recordMs]   录多久（默认 2000ms；页面可用 window.__MFG_SELFTEST_RECORD_MS__ 覆盖）
 * @param {number}   [opts.readyMs]    连上代理并等到 ready 的超时（默认 8000ms）
 * @param {number}   [opts.resultMs]   等 final 的超时（默认 4000ms）
 * @param {Function} [opts.setTimer]   注入 setTimeout
 * @param {Function} [opts.clearTimer] 注入 clearTimeout
 */
export function createSelfTest({
  win = null,
  diag = null,
  tts = null,
  speak = null,
  url = null,
  recordMs = 2000,
  readyMs = 8000,
  resultMs = 4000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const w = rootWin(win);
  const listeners = new Set();
  let seq = 0;
  let running = false;
  let step = '';
  let steps = blankSteps();
  let volume = 0;
  let volumeError = '';
  let frames = 0;
  let bytes = 0;
  let partials = 0;
  let finals = 0;
  let ws = 'idle';
  let result = { kind: '', text: '', code: '' };
  let error = null;
  let startedAt = 0;
  let finishedAt = 0;
  /** 运行期的资源（每次 run 重置；cleanup 幂等） */
  let res = null;
  let volumeTimer = null;
  let unmounted = false;

  function snapshot() {
    return {
      running,
      step,
      steps: { ...steps },
      volume,
      volumeError,
      frames,
      bytes,
      partials,
      finals,
      ws,
      result: { ...result },
      error: error ? { ...error } : null,
      startedAt,
      finishedAt,
      url: typeof url === 'string' && url ? url : targetUrl(),
    };
  }

  function emit() {
    const snap = snapshot();
    for (const fn of listeners) {
      try { fn(snap); } catch { /* 订阅者出错不影响自检 */ }
    }
    return snap;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function targetUrl() {
    return url || resolveAsrUrl(w) || sameOriginAsrUrl(w) || DEFAULT_ASR_WS_URL;
  }

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  function msOverride(name, fallback) {
    const v = w && w[name];
    return num(v, fallback);
  }

  function setStep(id, status) {
    if (id) steps = { ...steps, [id]: status };
    if (status === 'running') step = id;
    if (id) diag?.record?.('selftest:step', { step: id, status });
    emit();
  }

  function speakFailure(id, code) {
    let key = SELF_TEST_FAIL_KEYS[id];
    if (id === 'result' && code && !/^(?:timeout|empty|result-timeout|no-result)$/i.test(String(code))) {
      key = SELF_TEST_FAIL_UPSTREAM_KEY;
    }
    if (!key) return '';
    let text = '';
    try { text = String(t(key, { code: code || '' })); } catch { text = ''; }
    if (!text) return '';
    const say = typeof speak === 'function'
      ? speak
      : (tts && typeof tts.speak === 'function' ? (line) => tts.speak(line) : null);
    try { say?.(text); } catch { /* 说话失败不能影响自检结果 */ }
    return text;
  }

  function cleanup() {
    if (!res) return;
    const current = res;
    res = null;
    if (volumeTimer !== null) {
      try { clearTimer(volumeTimer); } catch { /* ignore */ }
      volumeTimer = null;
    }
    try { current.meter?.close?.(); } catch { /* ignore */ }
    try { current.capture?.stop?.(); } catch { /* ignore */ }
    try {
      const p = current.ctx?.close?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* ignore */ }
    try { current.socket?.close?.(); } catch { /* ignore */ }
    const tracks = current.tracks || [];
    for (const track of tracks) {
      try { track.stop?.(); } catch { /* ignore */ }
    }
  }

  function finish(ok, id, code) {
    running = false;
    finishedAt = Date.now();
    cleanup();
    ws = 'closed';
    diag?.record?.('selftest:done', { ok: !!ok, step: id || '', code: code || '' });
    emit();
    return { ok: !!ok, step: id || '', code: code || '', ...snapshot() };
  }

  function failAt(id, code, { speak = true } = {}) {
    steps = { ...steps, [id]: 'fail' };
    error = { step: id, code: String(code || '') };
    if (speak) speakFailure(id, code);
    diag?.record?.('selftest:fail', { step: id, code: String(code || '') });
    return finish(false, id, code);
  }

  /** 等一个事件 / 超时；返回 {ok, event}（永不 reject） */
  function waitFor(promise, ms) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimer(() => resolve({ ok: false, timeout: true }), Math.max(1, ms));
      if (timer && typeof timer.unref === 'function') {
        try { timer.unref(); } catch { /* ignore */ }
      }
    });
    return Promise.race([promise, timeout]).then((value) => {
      if (timer !== null) { try { clearTimer(timer); } catch { /* ignore */ } }
      return value && value.ok === true ? value : { ok: false, ...(value || {}) };
    });
  }

  /** 自己的 getUserMedia（与教练会话完全无关；只开这一路） */
  async function openMic() {
    const media = w.navigator && w.navigator.mediaDevices;
    if (!media || typeof media.getUserMedia !== 'function') {
      const err = new Error('getUserMedia is not available');
      err.name = 'NotSupportedError';
      throw err;
    }
    diag?.record?.('mic:request', { by: 'selftest' });
    const stream = await media.getUserMedia({ audio: true });
    const tracks = stream && typeof stream.getAudioTracks === 'function'
      ? stream.getAudioTracks()
      : (stream && typeof stream.getTracks === 'function' ? stream.getTracks() : []);
    if (!tracks.length) {
      const err = new Error('no audio track');
      err.name = 'NotFoundError';
      throw err;
    }
    diag?.record?.('mic:ok', {
      tracks: tracks.length,
      labels: tracks.map((track, i) => `audio-${i + 1}`),
    });
    return { stream, tracks };
  }

  /** 一步一步跑；每一步失败都会停下来、把原因说出来 */
  async function run() {
    if (running) return { ok: false, step: step || '', code: 'busy', ...snapshot() };
    const token = ++seq;
    const stale = () => token !== seq;
    res = {
      stream: null, tracks: [], meter: null, ctx: null, capture: null, socket: null,
    };
    const mine = res;
    running = true;
    step = '';
    steps = blankSteps();
    volume = 0;
    volumeError = '';
    frames = 0;
    bytes = 0;
    partials = 0;
    finals = 0;
    ws = 'connecting';
    result = { kind: '', text: '', code: '' };
    error = null;
    startedAt = Date.now();
    finishedAt = 0;
    diag?.record?.('selftest:start', {});
    emit();

    /* ---- ① 麦克风 -------------------------------------------------- */
    setStep('mic', 'running');
    try {
      const opened = await openMic();
      if (stale()) return finish(false, 'mic', 'cancelled');
      mine.stream = opened.stream;
      mine.tracks = opened.tracks;
    } catch (err) {
      if (stale()) return finish(false, 'mic', 'cancelled');
      return failAt('mic', (err && err.name) || (err && err.code) || 'mic');
    }
    setStep('mic', 'ok');

    // 音量表（共享这一条流，不再 getUserMedia）；打不开也不影响自检，只是没有音量读数
    try {
      mine.meter = createVuMeter({ win: w, stream: mine.stream, diag });
      await mine.meter.open();
      if (stale()) return finish(false, 'mic', 'cancelled');
      const tick = () => {
        if (stale() || !mine.meter) return;
        try { volume = mine.meter.readLevel(); } catch { volume = 0; }
        emit();
        volumeTimer = setTimer(tick, 120);
        if (volumeTimer && typeof volumeTimer.unref === 'function') {
          try { volumeTimer.unref(); } catch { /* ignore */ }
        }
      };
      tick();
    } catch (err) {
      volumeError = String((err && (err.code || err.name)) || 'vu');
      volume = 0;
      emit();
    }

    /* ---- ② 连代理（/asr）------------------------------------------ */
    setStep('ws', 'running');
    const WS = w.WebSocket;
    const target = targetUrl();
    if (typeof WS !== 'function' || !target) {
      return failAt('ws', 'ws-unsupported');
    }
    let socket = null;
    try {
      socket = new WS(target);
      mine.socket = socket;
      socket.binaryType = 'arraybuffer';
    } catch {
      return failAt('ws', 'ws-construct');
    }

    let settleReady = () => {};
    const readyPromise = new Promise((resolve) => { settleReady = resolve; });
    let settleFinal = () => {};
    const finalPromise = new Promise((resolve) => { settleFinal = resolve; });
    let finalSeen = null;
    let serverError = null;
    let lastPartial = '';

    socket.onopen = () => {
      if (stale()) return;
      ws = 'open';
      diag?.record?.('ws:open', { by: 'selftest' });
      emit();
      try { socket.send(JSON.stringify({ type: 'start', lang: selfTestLang() })); } catch { /* ignore */ }
    };
    socket.onmessage = (event) => {
      if (stale()) return;
      let msg = null;
      try { msg = JSON.parse(String(event && event.data)); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'ready') {
        ws = 'ready';
        emit();
        settleReady({ ok: true, event: msg });
        return;
      }
      if (msg.type === 'partial') {
        partials += 1;
        lastPartial = String(msg.text || '');
        diag?.record?.('asr:partial', { text: lastPartial });
        emit();
        return;
      }
      if (msg.type === 'final') {
        finals += 1;
        const text = String(msg.text || '');
        diag?.record?.('asr:final', { text });
        finalSeen = text;
        emit();
        settleFinal({ ok: true, event: msg });
        return;
      }
      if (msg.type === 'error') {
        serverError = {
          code: String(msg.code || 'error'),
          message: String(msg.message || ''),
        };
        diag?.record?.('asr:error', serverError);
        ws = 'error';
        emit();
        settleReady({ ok: false, error: serverError });
        settleFinal({ ok: false, error: serverError });
      }
    };
    socket.onerror = (err) => {
      if (stale()) return;
      ws = 'error';
      diag?.record?.('ws:error', {
        name: (err && err.name) || 'error',
        message: (err && err.message) || '',
      });
      emit();
      settleReady({ ok: false, error: { code: 'ws-error', message: '' } });
      settleFinal({ ok: false, error: { code: 'ws-error', message: '' } });
    };
    socket.onclose = (event) => {
      if (stale()) return;
      const code = Number(event && event.code) || 0;
      ws = code ? `closed(${code})` : 'closed';
      diag?.record?.('ws:close', { code, reason: String((event && event.reason) || '') });
      emit();
      settleReady({ ok: false, error: { code: code ? `closed-${code}` : 'ws-closed', message: '' } });
      settleFinal({ ok: false, error: { code: code ? `closed-${code}` : 'ws-closed', message: '' } });
    };

    diag?.record?.('ws:connecting', { by: 'selftest' });
    const ready = await waitFor(readyPromise, msOverride('__MFG_SELFTEST_READY_MS__', readyMs));
    if (stale()) return finish(false, 'ws', 'cancelled');
    if (!ready.ok) {
      const code = ready.error?.code || 'ready-timeout';
      return failAt('ws', code);
    }
    setStep('ws', 'ok');

    /* ---- ③ 录 2 秒并发送 ------------------------------------------ */
    setStep('send', 'running');
    const Ctx = w.AudioContext || w.webkitAudioContext;
    if (!Ctx) return failAt('send', 'no-audio-context');
    try {
      const ctx = new Ctx();
      mine.ctx = ctx;
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        await ctx.resume().catch(() => {});
      }
      diag?.record?.('ctx:sampleRate', {
        value: Number(ctx.sampleRate) || 0,
        state: String(ctx.state || ''),
      });
      const inputRate = Number(ctx.sampleRate) || 48000;
      const capture = await startPcmCapture({
        win: w,
        ctx,
        stream: mine.stream,
        diag,
        onChunk: (samples) => {
          if (stale() || !socket || socket.readyState !== 1) return;
          const pcm = downsampleToPcm16(samples, inputRate);
          if (!pcm.length) return;
          try {
            socket.send(pcm.buffer);
          } catch {
            return;
          }
          bytes += pcm.buffer.byteLength;
          frames += 1;
          if (frames === 1) diag?.record?.('ws:firstFrame', { bytes: pcm.buffer.byteLength });
          if (frames % 8 === 0) diag?.record?.('ws:frames', { n: frames, bytes });
          emit();
        },
      });
      mine.capture = capture;
    } catch (err) {
      if (stale()) return finish(false, 'send', 'cancelled');
      return failAt('send', (err && (err.code || err.name)) || 'capture');
    }

    await new Promise((resolve) => {
      const timer = setTimer(resolve, msOverride('__MFG_SELFTEST_RECORD_MS__', recordMs));
      if (timer && typeof timer.unref === 'function') {
        try { timer.unref(); } catch { /* ignore */ }
      }
    });
    if (stale()) return finish(false, 'send', 'cancelled');
    try { mine.capture?.stop?.(); } catch { /* ignore */ }
    try { socket.send(JSON.stringify({ type: 'stop' })); } catch { /* ignore */ }
    if (frames <= 0) return failAt('send', 'no-frames');
    diag?.record?.('ws:frames', { n: frames, bytes });
    setStep('send', 'ok');

    /* ---- ④ 服务端结果 --------------------------------------------- */
    setStep('result', 'running');
    if (finalSeen === null) {
      const settled = await waitFor(finalPromise, msOverride('__MFG_SELFTEST_RESULT_MS__', resultMs));
      if (stale()) return finish(false, 'result', 'cancelled');
      if (!settled.ok) {
        if (lastPartial) {
          result = { kind: 'partial', text: lastPartial, code: '' };
        } else if (serverError) {
          result = { kind: 'error', text: '', code: serverError.code };
          return failAt('result', serverError.code);
        } else {
          result = { kind: 'timeout', text: '', code: settled.error?.code || 'timeout' };
          return failAt('result', result.code);
        }
      } else if (finalSeen === null) {
        result = { kind: 'final', text: String(settled.event?.text || ''), code: '' };
      }
    }
    if (finalSeen !== null) {
      result = { kind: 'final', text: finalSeen, code: '' };
    }
    if (result.kind === 'final' && !String(result.text || '').trim()) {
      if (lastPartial) result = { kind: 'partial', text: lastPartial, code: '' };
      else if (serverError) {
        result = { kind: 'error', text: '', code: serverError.code };
        return failAt('result', serverError.code);
      } else {
        result = { kind: 'timeout', text: '', code: 'empty' };
        return failAt('result', 'empty');
      }
    }
    setStep('result', 'ok');
    return finish(true, 'result', '');
  }

  function cancel() {
    if (!running) return snapshot();
    seq += 1;
    running = false;
    step = '';
    ws = 'closed';
    finishedAt = Date.now();
    cleanup();
    diag?.record?.('selftest:cancel', {});
    emit();
    return snapshot();
  }

  function destroy() {
    unmounted = true;
    cancel();
    listeners.clear();
  }

  return {
    SELF_TEST_STEPS,
    run,
    cancel,
    destroy,
    snapshot,
    subscribe,
    get running() { return running; },
    get mounted() { return !unmounted; },
  };
}

export default { createSelfTest, SELF_TEST_STEPS, selfTestLang };
