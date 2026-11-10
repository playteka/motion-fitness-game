/**
 * 火山 TTS 的前端播放层（P3.6 整段 → P3.4 流式 + 插话打断 → P3.7 真能出声）。
 *
 * 三级降级（每级都记诊断，绝不哑掉）：
 *   ① `POST /tts/stream` → 边收边播，记 `tts:first-audio {ms,mode}`；失败记 `tts:stream-fail`：
 *      - **MSE**（`MediaSource` + `SourceBuffer('audio/mpeg')`）支持就用它 —— 浏览器原生
 *        demuxer，收到就 append，帧边界不用我们管；
 *      - 不支持 MSE 的浏览器走**解码队列**（`decodeAudioData`），内部按 MP3 帧长切开，
 *        **只把完整帧**送去解码（半帧会让整块解码失败）。
 *   ② 流式 404 / 不支持 / 失败 → `POST /tts` 整段（服务端有缓存），记 `tts:whole`；
 *   ③ 整段也 502 / 超时 / 网络错 → 系统 TTS，记 `tts:fallback {code}`。
 *
 * 🐞 2026-11 真实事故（用户原话「你确定使用了火山 TTS 吗？我怎么感觉还是之前的语音播报的模式」）：
 * 火山**确实被调用了**，日志里 `tts:first-audio` 有值，但接着 `tts:stream-fail` + `tts:fail code:"audio"`
 * + 最后 `tts:say source:"system"` —— 根因是**服务端把上游的 JSON 信封（base64）当成 MP3 转发**
 * （见 `server/volc-tts.mjs` 的 `unwrapVolcAudio`），两端解码器拿到的都不是音频。
 * 这一版同时补了：信封拆解（服务端）/ MSE / 帧对齐 / `tts:fail` 带 `where + errName + errMessage`。
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
/**
 * 流式「中间断流」看门狗：首块到了之后，这么久没有新数据就**当成说完**收尾。
 *
 * 用户反馈「听不到任何声音」的那段日志里，`tts:first-audio` 之后既没有 `tts:say`
 * 也没有 `onEnd` —— 说明流式响应流一直没结束（服务端 / 上游卡住），
 * 于是 `player.finish()` 永远不调用 → MSE 不 `endOfStream()` → 音频不 `ended`
 * → 会话卡在 `speaking`。有了这个看门狗，卡住也会正常收尾（并记 `tts:stream-idle`）。
 */
export const TTS_STREAM_IDLE_MS = 2500;
/** 流式读取的硬上限：一次朗读最多读这么久（超了就 abort，按「说完了」收尾） */
export const TTS_STREAM_READ_MAX_MS = 15000;
/** 一句话的兜底总时长（onEnd 一直不回来也会在到点时让会话回聆听） */
export const TTS_SPEAK_GUARD_MS = 20000;
export const TTS_SPEAK_GUARD_MIN_MS = 6000;

/** 一句话的兜底时长：按字数估（约 4 字/秒）+ 4s 首字 / 缓冲，夹在 [min, max] */
export function ttsGuardMs(text, { min = TTS_SPEAK_GUARD_MIN_MS, max = TTS_SPEAK_GUARD_MS } = {}) {
  const chars = ttsText(text).length;
  const lo = Math.max(0, Number(min) || 0);
  const hi = Math.max(lo, Number(max) || 0);
  return Math.max(lo, Math.min(hi, chars * 250 + 4000));
}
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

/** 任意块 → Uint8Array（不复制已有的视图） */
function toUint8(chunk) {
  if (!chunk) return new Uint8Array(0);
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return new Uint8Array(0);
}

function concatBytes(a, b) {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/* ================================================================== *
 * MP3 帧对齐（纯函数）：**只把完整帧**交给 decodeAudioData
 * ================================================================== */

/** MSE 用的 MIME（`audio/mpeg` 不是所有浏览器都支持，用之前必须问 isTypeSupported） */
export const MSE_MIME = 'audio/mpeg';

const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_LAYER3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPEG_SAMPLE_RATES = {
  0: [11025, 12000, 8000],   // MPEG 2.5
  2: [22050, 24000, 16000],  // MPEG 2
  3: [44100, 48000, 32000],  // MPEG 1
};

/**
 * 读一个 MP3 帧头。
 *
 * 为什么需要它：流式块的边界是**任意字节**（服务端边收边转，浏览器 read 也按自己节奏切），
 * 把「半截帧」喂给 `decodeAudioData` 轻则丢掉一帧、重则整块解码失败 —— 这正是用户
 * 「听到的还是系统播报」那条降级链上的一个真原因。按帧长切开就永远只喂完整帧。
 *
 * @returns {{frameLength:number, bitrate:number, sampleRate:number, mpeg1:boolean}|null}
 */
export function parseMp3FrameHeader(bytes, at = 0) {
  const view = toUint8(bytes);
  if (at + 4 > view.length) return null;
  const b0 = view[at];
  const b1 = view[at + 1];
  const b2 = view[at + 2];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;   // 11 位同步字
  const version = (b1 >> 3) & 0x03;                        // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layer = (b1 >> 1) & 0x03;                          // 1=Layer III（火山给的就是这个）
  if (version === 1 || layer !== 1) return null;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;
  const mpeg1 = version === 3;
  const bitrate = (mpeg1 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES)[bitrateIndex] * 1000;
  const sampleRate = MPEG_SAMPLE_RATES[version][sampleRateIndex];
  if (!bitrate || !sampleRate) return null;
  const padding = (b2 >> 1) & 0x01;
  const frameLength = Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  if (frameLength < 24) return null;
  return { frameLength, bitrate, sampleRate, mpeg1 };
}

/** ID3v2 头长度：null = 不是 ID3，-1 = 还读不够 10 字节 */
function id3TagSize(bytes) {
  if (bytes.length < 3) return -1;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;
  if (bytes.length < 10) return -1;
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14)
    | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const footer = (bytes[5] & 0x10) ? 10 : 0;
  return 10 + size + footer;
}

/**
 * 把「任意切块」的 MP3 字节流重新按**帧边界**切开。
 *
 *   push(chunk) → 完整帧拼成的 Uint8Array | null（不够一帧就攒着）
 *   flush()     → 流结束后剩下的尾巴（半帧也吐出去，别把最后半句丢了）
 *
 * 兜底规则（很重要）：**判不出帧结构就原样透传**。例如全零缓冲 / 测试桩给的假字节，
 * 透传后 `decodeAudioData` 会如实报错 → 上层照旧降级，不会「悄悄没声音」。
 */
export function createMp3FrameSplitter() {
  let pending = new Uint8Array(0);
  let passthrough = false;
  let dropped = 0;
  let frames = 0;

  function push(chunk) {
    const bytes = toUint8(chunk);
    if (!bytes.length) return null;
    pending = concatBytes(pending, bytes);
    if (passthrough) {
      const out = pending;
      pending = new Uint8Array(0);
      return out.length ? out : null;
    }
    // 太短了连帧头都放不下：直接透传（否则「一块都解不出来」会变成静音）
    if (pending.length < 4) {
      const out = pending;
      pending = new Uint8Array(0);
      return out;
    }
    let offset = 0;
    const tag = id3TagSize(pending);
    if (tag === -1) return null;            // ID3 头还没读全
    if (tag !== null) {
      if (pending.length < tag) return null;
      offset = tag;
      dropped += tag;                       // ID3 是元数据，不是音频帧
    }
    let start = -1;
    for (let i = offset; i + 4 <= pending.length; i += 1) {
      if (parseMp3FrameHeader(pending, i)) { start = i; break; }
    }
    if (start < 0) {
      // 整个缓冲里一个帧同步都没有 → 不是帧流，原样透传（让解码器去报错）
      passthrough = true;
      const out = pending;
      pending = new Uint8Array(0);
      return out.length ? out : null;
    }
    dropped += start - offset;
    let end = start;
    let count = 0;
    for (;;) {
      const header = parseMp3FrameHeader(pending, end);
      if (!header) break;
      if (end + header.frameLength > pending.length) break;   // 这帧还没收全
      end += header.frameLength;
      count += 1;
    }
    if (count === 0) {
      pending = pending.slice(start);       // 只来了个帧头：等帧身
      return null;
    }
    const out = pending.slice(start, end);
    frames += count;
    pending = pending.slice(end);
    return out;
  }

  function flush() {
    const out = pending;
    pending = new Uint8Array(0);
    return out.length ? out : null;
  }

  return {
    push,
    flush,
    get pending() { return pending.length; },
    get frames() { return frames; },
    get dropped() { return dropped; },
    get passthrough() { return passthrough; },
  };
}

/* ================================================================== *
 * MSE：边下边播（浏览器原生 demuxer，帧边界不用我们自己管）
 * ================================================================== */

function pickMediaSource(win) {
  const w = win || (typeof window !== 'undefined' ? window : {});
  if (w && typeof w.MediaSource === 'function') return w.MediaSource;
  if (typeof MediaSource !== 'undefined') return MediaSource;
  return null;
}

/** 这个浏览器能不能用 MSE 播 MP3（Chrome 系有些版本不支持 `audio/mpeg`，必须问） */
export function mseSupportsMpeg(win) {
  return mediaSourceSupportsMpeg(pickMediaSource(win));
}

/** 判一个 MediaSource 构造器支不支持 `audio/mpeg`（注入构造器时也走这里） */
function mediaSourceSupportsMpeg(Ctor) {
  if (!Ctor) return false;
  try {
    return typeof Ctor.isTypeSupported === 'function' && Ctor.isTypeSupported(MSE_MIME) === true;
  } catch { return false; }
}

/**
 * MSE 的 appendBuffer 队列（**纯逻辑，可注入假 SourceBuffer 单测**）。
 *
 * MSE 的硬性约束（踩了就 `InvalidStateError`）：
 *   ① 一次只能有一个 append 在飞 —— 上一个 `updateend` 没来之前**不能**再 append；
 *   ② 缓冲满时 `appendBuffer` 抛 `QuotaExceededError` —— 要等这次更新结束再重试，**不能丢块**；
 *   ③ 顺序必须与收到顺序一致（否则音频会倒着播）。
 *
 * `append(bytes)` 会排队，返回的 Promise 在**那块真的进缓冲之后**才 resolve。
 */
export function createMseAppendQueue({ sourceBuffer, onError = null } = {}) {
  if (!sourceBuffer || typeof sourceBuffer.appendBuffer !== 'function') {
    throw Object.assign(new TypeError('createMseAppendQueue requires a SourceBuffer'), { code: 'no-source-buffer' });
  }
  const queue = [];
  let busy = false;
  let stopped = false;
  let bytes = 0;
  let chunks = 0;
  let quotas = 0;

  function waitUpdate() {
    return new Promise((resolve) => {
      const done = () => {
        try { sourceBuffer.removeEventListener?.('updateend', done); } catch { /* ignore */ }
        try { sourceBuffer.removeEventListener?.('error', done); } catch { /* ignore */ }
        resolve();
      };
      if (typeof sourceBuffer.addEventListener === 'function') {
        sourceBuffer.addEventListener('updateend', done);
        sourceBuffer.addEventListener('error', done);
        return;
      }
      // 没有事件接口（老实现 / 极简桩）：退化成轮询 updating
      const poll = () => { if (sourceBuffer.updating) setTimeout(poll, 1); else done(); };
      setTimeout(poll, 0);
    });
  }

  function isQuota(err) {
    return !!err && (err.name === 'QuotaExceededError' || err.code === 22);
  }

  async function pump() {
    if (busy || stopped) return;
    busy = true;
    try {
      while (queue.length && !stopped) {
        if (sourceBuffer.updating) { await waitUpdate(); continue; }
        const item = queue[0];
        try {
          sourceBuffer.appendBuffer(item.bytes);
        } catch (err) {
          if (isQuota(err) && !item.retried) {
            // 缓冲满：等这次更新结束再重试一次（不丢块）
            item.retried = true;
            quotas += 1;
            if (sourceBuffer.updating) await waitUpdate();
            continue;
          }
          queue.shift();
          item.reject(err);
          try { onError?.(err); } catch { /* ignore */ }
          continue;
        }
        queue.shift();
        chunks += 1;
        bytes += item.bytes.byteLength;
        item.resolve(item.bytes.byteLength);
        // 这次 append 的 updateend 到了再放下一块（①）
        if (sourceBuffer.updating) await waitUpdate();
      }
    } finally { busy = false; }
  }

  function append(chunk) {
    const bytesView = toUint8(chunk);
    if (stopped || !bytesView.length) return Promise.resolve(0);
    return new Promise((resolve, reject) => {
      queue.push({ bytes: bytesView, resolve, reject, retried: false });
      pump();
    });
  }

  /** 等队列彻底排空（全部 append 完） */
  function drain() {
    if (!busy && !queue.length) return Promise.resolve();
    return new Promise((resolve) => {
      const tick = () => {
        if (stopped || (!busy && !queue.length)) { resolve(); return; }
        setTimeout(tick, 2);
      };
      setTimeout(tick, 2);
    });
  }

  function stop() {
    stopped = true;
    for (const item of queue) {
      try { item.resolve(0); } catch { /* ignore */ }
    }
    queue.length = 0;
    return api;
  }

  const api = {
    kind: 'mse-append-queue',
    append,
    drain,
    stop,
    get queued() { return queue.length; },
    get busy() { return busy; },
    get bytes() { return bytes; },
    get chunks() { return chunks; },
    get quotas() { return quotas; },
  };
  return api;
}

/**
 * MSE 播放器：`MediaSource` + `SourceBuffer('audio/mpeg')` 边下边播。
 * 与 `createAudioQueuePlayer` 同一套接口（push / finish / stop），上层不用分叉。
 */
export function createMsePlayback({
  win = null,
  MediaSourceCtor = null,
  AudioCtor = null,
  createObjectURL = null,
  revokeObjectURL = null,
  mime = MSE_MIME,
  onEnd = null,
  onError = null,
} = {}) {
  const w = win || (typeof window !== 'undefined' ? window : {});
  const MSCtor = MediaSourceCtor || pickMediaSource(w);
  if (!MSCtor) throw Object.assign(new Error('MediaSource unavailable'), { code: 'no-media-source' });
  const AudioCtorNow = AudioCtor || (w && typeof w.Audio === 'function' ? w.Audio : (typeof Audio !== 'undefined' ? Audio : null));
  if (!AudioCtorNow) throw Object.assign(new Error('Audio unavailable'), { code: 'no-audio' });
  const makeUrl = createObjectURL
    || (w && w.URL && typeof w.URL.createObjectURL === 'function' ? w.URL.createObjectURL.bind(w.URL) : null);
  if (!makeUrl) throw Object.assign(new Error('createObjectURL unavailable'), { code: 'no-object-url' });
  const dropUrl = revokeObjectURL
    || (w && w.URL && typeof w.URL.revokeObjectURL === 'function' ? w.URL.revokeObjectURL.bind(w.URL) : null);

  const mediaSource = new MSCtor();
  const url = makeUrl(mediaSource);
  const audio = new AudioCtorNow();
  audio.src = url;

  let sourceBuffer = null;
  let queue = null;
  let stopped = false;
  let endOfStreamCalled = false;
  let playError = null;

  const ready = new Promise((resolve, reject) => {
    const open = () => {
      if (stopped) { reject(Object.assign(new Error('stopped'), { code: 'stopped' })); return; }
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mime);
      } catch (err) {
        reject(Object.assign(new Error('addSourceBuffer failed'), { code: 'mse-buffer', cause: err }));
        return;
      }
      queue = createMseAppendQueue({ sourceBuffer, onError: (err) => { try { onError?.(err); } catch { /* ignore */ } } });
      /**
       * ⚠️ **绝不能让 `push()` 等 `play()` 的 Promise**（用户反馈「听不到任何声音」的根因）。
       *
       * MSE 的音频元素在**一个字节都没 append 之前** `readyState` 是 HAVE_NOTHING，
       * 此时 `audio.play()` 返回的 Promise 会一直 pending（浏览器要等有数据才真的开始播）。
       * 从前 `ready` 是等 play() resolve 才 resolve 的，而 `push()` 又在等 `ready`
       * —— 死锁：第一块永远 append 不进去（一个字节都没播 / 完全没声音），
       * 响应流也永远读不完（没有 `tts:say` / 没有 `onEnd` / 会话卡在 speaking）。
       * 现在：`ready` = 「SourceBuffer 建好了」；play() 只做**旁路监听**。
       */
      let started = null;
      try { started = audio.play?.(); } catch (err) { started = Promise.reject(err); }
      if (started && typeof started.then === 'function') {
        started.then(null, (err) => {
          if (stopped) return;
          playError = Object.assign(new Error('mse play rejected'), {
            code: 'mse-play', cause: err, causeName: (err && err.name) || '',
          });
          // 自动播放被拒：没出过声，交给上层回退整段 / 系统 TTS（不是「悄悄没声音」）
          stop();
          try { onError?.(playError); } catch { /* ignore */ }
        });
      }
      resolve(queue);
    };
    if (typeof mediaSource.addEventListener === 'function') {
      mediaSource.addEventListener('sourceopen', open);
    } else if (mediaSource.readyState === 'open') {
      open();
    } else {
      reject(Object.assign(new Error('MediaSource never opened'), { code: 'mse-open' }));
    }
  });
  // 别把「没人 await」的 rejection 变成 unhandledRejection
  ready.catch(() => {});

  async function push(chunk) {
    if (stopped) return null;
    const q = await ready;
    if (stopped) return null;
    const n = await q.append(chunk);
    return n ? { bytes: n } : null;
  }

  async function finish() {
    if (stopped) return;
    try {
      const q = await ready;
      await q.drain();
      if (stopped || endOfStreamCalled) return;
      if (sourceBuffer && typeof sourceBuffer.endOfStream === 'function') {
        endOfStreamCalled = true;
        sourceBuffer.endOfStream();
      }
      if (mediaSource && mediaSource.readyState === 'open' && typeof mediaSource.endOfStream === 'function') {
        endOfStreamCalled = true;
        mediaSource.endOfStream();
      }
    } catch { /* 收尾失败就算了，音频已经进缓冲 */ }
  }

  function teardown() {
    try { audio.onended = null; } catch { /* ignore */ }
    try { audio.pause?.(); } catch { /* ignore */ }
    try { audio.src = ''; } catch { /* ignore */ }
    try { queue?.stop(); } catch { /* ignore */ }
    try {
      if (sourceBuffer && mediaSource && mediaSource.readyState === 'open'
        && typeof sourceBuffer.abort === 'function') sourceBuffer.abort();
    } catch { /* ignore */ }
    try { dropUrl?.(url); } catch { /* ignore */ }
  }

  /** 主动停（打断 / 出错 / 关页面）：释放资源并 revoke blob URL */
  function stop() {
    if (stopped) return api;
    stopped = true;
    teardown();
    return api;
  }

  /** 自然播完：**也必须**释放资源（少了这一步就是 blob URL 泄漏，实测踩过） */
  function finishNaturally() {
    if (stopped) return;
    stopped = true;
    teardown();
    try { onEnd?.(); } catch { /* ignore */ }
  }

  audio.onended = () => finishNaturally();
  audio.onerror = () => {
    if (stopped) return;
    stop();
    try { onError?.(Object.assign(new Error('mse audio error'), { code: 'audio' })); } catch { /* ignore */ }
  };

  const api = {
    kind: 'mse',
    push,
    finish,
    stop,
    close: stop,
    get active() { return !stopped; },
    get bytes() { return queue ? queue.bytes : 0; },
    get chunks() { return queue ? queue.chunks : 0; },
    get pending() { return queue ? queue.queued : 0; },
    get audio() { return audio; },
    get url() { return url; },
    /** play() 被拒时的错误（上层据此回退整段；正常播放时是 null） */
    get playError() { return playError; },
  };
  return api;
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
  onError = null,
  frameSafe = true,
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
  let tailInFlight = 0;
  let ended = false;
  let endFired = false;
  let stopped = false;
  let bytes = 0;
  let playedChunks = 0;
  /** 帧对齐：只把**完整 MP3 帧**交给 decodeAudioData（半帧会让整块解码失败） */
  const splitter = frameSafe ? createMp3FrameSplitter() : null;

  function maybeEnd() {
    if (!ended || pending > 0 || tailInFlight > 0 || endFired || stopped) return;
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

  /** 真正解码 + 排到时间轴上；返回它被安排的位置 */
  async function decodeAndSchedule(view) {
    const context = await open();
    const buffer = toArrayBuffer(view);
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

  /**
   * 解一块并排到时间轴上；返回它被安排的位置。
   * `null` = 攒着（这块还不够一帧），不是失败。
   */
  async function push(chunk) {
    if (stopped) return null;
    if (!splitter) return decodeAndSchedule(toUint8(chunk));
    const whole = splitter.push(chunk);
    if (!whole) return null;
    return decodeAndSchedule(whole);
  }

  /** 流收完了：把最后半帧也解掉，等所有块播完再回调 onEnd（不 hang） */
  function finish() {
    if (splitter) {
      const tail = splitter.flush();
      if (tail) {
        tailInFlight += 1;
        decodeAndSchedule(tail).catch((err) => {
          try { onError?.(err); } catch { /* ignore */ }
        }).finally(() => {
          tailInFlight -= 1;
          maybeEnd();
        });
      }
    }
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
    get frames() { return splitter ? splitter.frames : 0; },
    get dropped() { return splitter ? splitter.dropped : 0; },
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
 * @param {boolean} [opts.mse]          流式是否优先用 MSE（默认 true；不支持会自动走解码队列）
 * @param {Function} [opts.MediaSourceCtor] 注入 MediaSource（Node 单测）
 * @param {number} [opts.idleMs]        流式「中间断流」看门狗（默认 2500；0 = 关掉）
 * @param {number} [opts.readMaxMs]     一次流式朗读的读取硬上限（默认 15000；0 = 关掉）
 * @param {number} [opts.guardMs]       一句话的兜底总时长（默认按字数估，见 ttsGuardMs）
 */
export function createVolcTts({
  fallback = null,
  fetchImpl = null,
  AudioCtor = null,
  AudioContextCtor = null,
  MediaSourceCtor = null,
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
  mse: useMse = true,
  idleMs = TTS_STREAM_IDLE_MS,
  readMaxMs = TTS_STREAM_READ_MAX_MS,
  guardMs = null,
  now = () => Date.now(),
} = {}) {
  const w = win || (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {}));
  const timeout = Math.max(1, Number(timeoutMs) || TTS_TIMEOUT_MS);
  const streamIdleMs = Math.max(0, Number(idleMs) || 0);
  const streamReadMaxMs = Math.max(0, Number(readMaxMs) || 0);
  const guardFixed = Number.isFinite(Number(guardMs)) && Number(guardMs) > 0 ? Number(guardMs) : 0;
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

  function pickMediaSourceCtor() {
    if (typeof MediaSourceCtor === 'function') return MediaSourceCtor;
    return pickMediaSource(w);
  }

  /**
   * 诊断用：`errName` + `errMessage`（截到 80 字）。
   *
   * 用户的要求：「下次一眼能看出是 MSE / 解码 / blob / play() 哪一个失败」——
   * 光有 `code:'stream'` 分不出原因，所以把错误名和消息也带出去。
   * ⚠️ 只带错误本身的 name / message，**不拼 URL**（blob URL 里没有凭证，但也没必要泄进日志）。
   */
  function errInfo(err) {
    const name = String((err && (err.name || err.code)) || 'error').slice(0, 40);
    const message = String((err && (err.message || err.reason)) || '').slice(0, 80);
    return message ? { errName: name, errMessage: message } : { errName: name };
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
    if (token.guard !== null && token.guard !== undefined) {
      try { clearTimeout(token.guard); } catch { /* ignore */ }
      token.guard = null;
    }
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
      diag?.record?.('tts:stream-fail', { code: 'no-fetch', where: 'stream', chars: body.length });
      return false;
    }
    /**
     * 播放引擎二选一：
     *   - **MSE**（`MediaSource` + `SourceBuffer('audio/mpeg')`）：浏览器原生 demuxer，
     *     收到就 append，帧边界不用我们管 —— 支持就用它（用户要求的优先方案）；
     *   - **解码队列**：不支持 MSE 的浏览器（Chrome 有些版本 `isTypeSupported('audio/mpeg')`
     *     是 false）走这条，内部按 MP3 帧长切开，只把完整帧交给 `decodeAudioData`。
     */
    const canMse = useMse && mediaSourceSupportsMpeg(pickMediaSourceCtor());
    if (!canMse && !CtxCtor) {
      // 没有 AudioContext（极老浏览器 / 测试桩）：直接走整段，不在前端拼解码队列
      diag?.record?.('tts:stream-fail', { code: 'no-audio-context', where: 'stream', chars: body.length });
      return false;
    }

    let player = null;
    let mode = 'decode';
    if (canMse) {
      try {
        player = createMsePlayback({
          win: w,
          MediaSourceCtor: pickMediaSourceCtor(),
          AudioCtor: pickAudio(),
          createObjectURL,
          revokeObjectURL,
          onEnd: () => releaseToken(token, { end: true }),
          onError: (err) => {
            if (err && err.code === 'mse-play') {
              // 自动播放被拒（还没出过声）：**不当作说完**，让上层回退整段 / 系统 TTS
              diag?.record?.('tts:stream-fail', {
                code: 'mse-play', where: 'stream', chars: body.length, ...errInfo(err),
              });
              return;
            }
            // 播到一半 MSE 报错：已经出过声就不重念，直接收尾（避免「说到一半又从头说」）
            diag?.record?.('tts:fail', { code: 'audio', where: 'stream', chars: body.length, ...errInfo(err) });
            releaseToken(token, { end: true });
          },
        });
        mode = 'mse';
      } catch (err) {
        player = null;
        diag?.record?.('tts:stream-fail', {
          code: 'no-mse', where: 'stream', chars: body.length, ...errInfo(err),
        });
      }
    }
    if (!player) {
      player = createAudioQueuePlayer({
        win: w,
        AudioContextCtor: CtxCtor,
        onEnd: () => releaseToken(token, { end: true }),
      });
      mode = 'decode';
    }
    token.player = player;
    token.mode = mode;

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
          where: 'stream',
          status: (res && res.status) || 0,
          chars: body.length,
        });
        return false;
      }
      const reader = pickBodyReader(res.body);
      if (!reader) {
        diag?.record?.('tts:stream-fail', { code: 'no-body', where: 'stream', chars: body.length });
        return false;
      }
      token.reader = reader;
      let first = false;
      /**
       * 两个看门狗（**首块到了之后**才启动，之前由上面的整句超时负责）：
       *   - idle：`idleMs` 内没有新数据 → 当成说完（`reader.cancel()` 让 `next()` 收尾）；
       *   - 硬上限 `readMaxMs`：一次朗读最多读这么久，超了 abort（按「说完了」收尾）。
       * 没有它们时，只要响应流不结束（用户日志里就是这样）就永远到不了 `player.finish()`
       * → MSE 不 `endOfStream()` → 没有 `ended` → 没有 `onEnd` → 会话卡在 `speaking`。
       */
      let idleTimer = null;
      const idleMs = streamIdleMs;
      const readMaxMs = streamReadMaxMs;
      const clearIdle = () => {
        if (idleTimer === null) return;
        try { clearTimeout(idleTimer); } catch { /* ignore */ }
        idleTimer = null;
      };
      const armIdle = () => {
        clearIdle();
        if (!(idleMs > 0)) return;
        idleTimer = setTimeout(() => {
          idleTimer = null;
          diag?.record?.('tts:stream-idle', { ms: idleMs, chars: body.length, mode });
          // 只取消读取：已经拿到的字节照常播完（不要 abort 整条请求，那会把尾巴切掉）
          try { token.reader?.cancel?.(); } catch { /* ignore */ }
        }, idleMs);
        if (idleTimer && typeof idleTimer.unref === 'function') {
          try { idleTimer.unref(); } catch { /* ignore */ }
        }
      };
      let readTimer = null;
      if (readMaxMs > 0) {
        readTimer = setTimeout(() => {
          readTimer = null;
          diag?.record?.('tts:stream-idle', { ms: readMaxMs, chars: body.length, mode, hard: true });
          try { controller?.abort?.(); } catch { /* ignore */ }
        }, readMaxMs);
        if (readTimer && typeof readTimer.unref === 'function') {
          try { readTimer.unref(); } catch { /* ignore */ }
        }
      }
      try {
        while (true) {
          const step = await reader.next();
          if (!step || step.done) break;
          if (closed || token !== current || token.stopped) return true;
          const piece = step.value;
          if (!piece || !piece.length) continue;
          if (!first) {
            first = true;
            clearTimer(token);   // 首块到了：不再按「整句超时」算
            diag?.record?.('tts:first-audio', {
              ms: Math.max(0, Math.round(now() - token.startedAt)),
              bytes: toUint8(piece).length,
              mode,
            });
          }
          armIdle();
          const scheduled = await player.push(piece);
          /**
           * 只有**真的排进播放引擎**才算「流式已经出声」：
           * 第一块解码 / append 失败时 streamStarted 还是 false，
           * 上层会整段重试 /tts，而不是静悄悄地把这句话吞掉。
           */
          if (scheduled) {
            if (!streamStarted) {
              streamStarted = true;
              token.streamStarted = true;
              /**
               * 「真的开始出声」就该有一条 `tts:say`：从前它记在**流读完之后**，
               * 于是响应流一卡住，日志里就只剩 `tts:first-audio`、没有 `tts:say`
               * （用户反馈「整个时段没有任何 tts 事件」其实就是这个形状）。
               */
              diag?.record?.('tts:say', {
                chars: body.length, source: 'volc', stream: true, mode,
              });
            }
          } else if (player.playError) {
            // play() 被自动播放策略拒了：没出过声，交给整段 / 系统 TTS
            break;
          }
          if (closed || token !== current || token.stopped) return true;
        }
      } finally {
        clearIdle();
        if (readTimer !== null) {
          try { clearTimeout(readTimer); } catch { /* ignore */ }
          readTimer = null;
        }
      }
      token.reader = null;
      if (!first) {
        // 200 但一个字节都没有：当成流式不可用，交给整段
        diag?.record?.('tts:stream-fail', { code: 'empty', where: 'stream', chars: body.length });
        return false;
      }
      /**
       * 收到了字节、但没有一块能播（解码 / append 失败，或 play() 被自动播放策略拒了）：
       * 别假装说完了，把流式这一级收拾干净再交给整段 / 系统 TTS。
       * `playError` 存在时即使前面有块排队过也按「没出过声」处理 —— play() 被拒等于一直静音。
       */
      if (!streamStarted || player.playError) {
        diag?.record?.('tts:stream-fail', {
          code: player.playError ? 'mse-play' : 'undecodable',
          where: 'stream',
          chars: body.length,
          ...(player.playError ? errInfo(player.playError) : {}),
        });
        try { player.stop(); } catch { /* ignore */ }
        token.player = null;
        return false;
      }
      Promise.resolve(player.finish()).catch(() => {});
      return true;
    } catch (err) {
      if (closed || token !== current || token.stopped) return true;
      const code = timedOut ? 'timeout' : 'stream';
      diag?.record?.('tts:stream-fail', {
        code, where: 'stream', chars: body.length, ...errInfo(err),
      });
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
      /**
       * 已经出声了：不重念（重念会「说到一半又从头说」）。
       * 先 `finish()`（MSE → endOfStream → 播完会 `ended`），保证这句真的有 onEnd；
       * 万一音频也卡住，`speak()` 里挂的 token.guard 会在到点时收尾。
       */
      Promise.resolve(player.finish()).catch(() => {});
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
      // ⚠️ blob URL **必须留到播完 / 出错之后**才 revoke（提前 revoke = 音频元素读不到数据，
      //    表现就是 `play()` 的 NotSupportedError 或 `onerror`）。释放统一走 releaseSources()。
      audio.onended = () => releaseToken(token, { end: true });
      audio.onerror = () => {
        const mediaError = audio.error || null;
        diag?.record?.('tts:fail', {
          code: 'audio',
          where: 'whole',
          chars: body.length,
          ...errInfo(mediaError || { name: 'MediaError', message: `code ${(mediaError && mediaError.code) || 0}` }),
        });
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
      // 已经因为 onerror 降级过了：别把同一个失败再记一遍（播放器的 play() 会再 reject 一次）
      if (token.mode !== 'whole') return;
      const code = timedOut ? 'timeout' : ((err && err.code) || 'network');
      diag?.record?.('tts:fail', {
        code, where: 'whole', chars: body.length, ...errInfo(err),
      });
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
      guard: null,
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
    /**
     * 兜底看门狗（最后一道保险）：不管卡在 MSE / 解码队列 / 系统 TTS 哪一级，
     * 到点一定回调 **onEnd**，绝不把会话状态机晾在 `speaking`（那会让用户后面
     * 说的每一句都被丢掉 —— 这就是「说完一句就再也不识别」的现场）。
     */
    const guard = guardFixed || ttsGuardMs(body);
    token.guard = setTimeout(() => {
      token.guard = null;
      if (token !== current || token.done) return;
      diag?.record?.('tts:guard', { ms: guard, chars: body.length, mode: token.mode });
      releaseToken(token, { end: true });
    }, guard);
    if (token.guard && typeof token.guard.unref === 'function') {
      try { token.guard.unref(); } catch { /* ignore */ }
    }
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
  createMp3FrameSplitter,
  createMseAppendQueue,
  createMsePlayback,
  mseSupportsMpeg,
  parseMp3FrameHeader,
  planStreamQueue,
  MSE_MIME,
  TTS_SOURCES,
  TTS_DEFAULT_SOURCE,
  TTS_PATH,
  TTS_STREAM_PATH,
  TTS_HEALTH_PATH,
};
