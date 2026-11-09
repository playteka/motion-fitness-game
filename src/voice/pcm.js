/**
 * 浏览器端 PCM 工具（**纯函数**，Node 里直接可测）。
 *
 * 火山流式 ASR 要的是 16kHz / 16bit / 单声道 PCM；麦克风给的是 44.1k / 48k 的 Float32。
 * 这里只做两件事：
 *   - `downsampleToPcm16()`：按比例做**区间平均**（简易低通），再转 Int16；
 *   - `floatToPcm16()` / `pcm16Rms()`：给测试与诊断用的小工具。
 *
 * 不做重采样滤波器组 / 抗混叠窗：语音识别对这点混叠不敏感，区间平均已经够干净，
 * 重要的是**长度严格等于 round(n * 16000 / inputRate)**（测试钉住 44.1k → 16k）。
 */

/** 目标采样率（火山要求 16000） */
export const TARGET_RATE = 16000;
/** Int16 的满量程 */
export const PCM16_FULL_SCALE = 32767;

/**
 * 一帧 = **100ms**。
 *
 * 用户反馈「发了很多帧但没有结果」：以前每个 AudioWorklet 渲染块（128 样本 ≈ 2.7ms）就发一包，
 * 一秒 375 包、每包只有约 86 字节 —— 看日志像是「帧很多」，但对上游来说音频被切得极碎、
 * 每包都要单独 gzip，识别效果很差（多数会话 `segments:0`）。
 * 100ms 一包（1600 样本 / 3200 字节）才是流式 ASR 的正常节奏：**32KB/s**。
 */
export const FRAME_MS = 100;
/** 100ms @16k 的样本数（1600） */
export const FRAME_SAMPLES = (TARGET_RATE * FRAME_MS) / 1000;
/** 100ms @16k/16bit/单声道的字节数（3200） */
export const FRAME_BYTES = FRAME_SAMPLES * 2;
/** 16k / 16bit / 单声道应有的码率：32000 字节/秒（诊断面板按它判断「正常吗」） */
export const EXPECTED_BYTES_PER_SEC = (TARGET_RATE * 16) / 8;

function clampSample(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < -1 ? -1 : (n > 1 ? 1 : n);
}

/**
 * Float32 采样 → Int16 PCM（振幅夹在 -1~1，四舍五入）。
 * @param {ArrayLike<number>} input
 * @returns {Int16Array}
 */
export function floatToPcm16(input) {
  const n = input && Number(input.length) || 0;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.round(clampSample(input[i]) * PCM16_FULL_SCALE);
  }
  return out;
}

/**
 * 降采样到 16k 并转 Int16。
 *
 * 每个输出样本取输入里对应的一段 `[i*ratio, (i+1)*ratio)` 的平均值：
 *   - 44.1k → 16k 时一段约 2.76 个样本，平滑掉高频（比直接抽取少很多混叠）；
 *   - 长度 `Math.round(input.length * targetRate / inputRate)`；
 *   - 空输入 / 非法采样率 → 空 Int16Array（调用方直接跳过这一包）。
 *
 * @param {ArrayLike<number>} input      Float32 采样（-1~1）
 * @param {number} inputRate             输入采样率（ctx.sampleRate，通常 44100 / 48000）
 * @param {number} [targetRate]          目标采样率，默认 16000
 * @returns {Int16Array}
 */
export function downsampleToPcm16(input, inputRate, targetRate = TARGET_RATE) {
  const n = input && Number(input.length) || 0;
  const from = Number(inputRate);
  const to = Number(targetRate);
  if (!n || !(from > 0) || !(to > 0)) return new Int16Array(0);

  const ratio = from / to;
  const outLen = Math.max(1, Math.round(n / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const start = Math.min(n - 1, Math.floor(i * ratio));
    const end = Math.min(n, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += clampSample(input[j]);
    out[i] = Math.round((sum / (end - start)) * PCM16_FULL_SCALE);
  }
  return out;
}

/** 一段 Int16 PCM 的 RMS（0~1），给诊断 / 测试用 */
export function pcm16Rms(pcm) {
  const n = pcm && Number(pcm.length) || 0;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = Number(pcm[i]) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** 一段 Int16 PCM 的峰值（0~1） */
export function pcm16Peak(pcm) {
  const n = pcm && Number(pcm.length) || 0;
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    const v = Math.abs(Number(pcm[i]) / 32768);
    if (v > peak) peak = v;
  }
  return peak;
}

/** 字节数 → 毫秒（16k / 16bit / 单声道 = 32 字节/毫秒） */
export function pcmBytesToMs(bytes, rate = TARGET_RATE, bits = 16, channels = 1) {
  const perMs = (rate * bits * channels) / 8000;
  return perMs > 0 ? Number(bytes) / perMs : 0;
}

/** 某个采样率 / 位深 / 声道应有的字节率（16k/16bit/单声道 → 32000） */
export function pcmBytesPerSec(rate = TARGET_RATE, bits = 16, channels = 1) {
  const r = Number(rate);
  return r > 0 ? (r * Number(bits) * Number(channels)) / 8 : 0;
}

/**
 * 把任意大小的采集块攒成**固定 100ms** 的 16k PCM16 帧（纯函数状态机，Node 可测）。
 *
 *   const framer = createPcmFramer({ inputRate: 48000 });
 *   for (const pcm of framer.push(float32Block)) ws.send(pcm.buffer);   // 每次 1600 样本 / 3200 字节
 *   framer.flush();                                    // stop 时把最后不足 100ms 的尾巴也发出去
 *
 * - 输入块大小随便（AudioWorklet 按 100ms 批量给，ScriptProcessor 给 4096 样本）；
 * - 跨块保留余数，所以 4800 + 4096 + … 的拼接不会丢样本 / 不重复；
 * - 一次 `push` 在块特别大时可能吐出多帧（循环），调用方逐帧发送即可；
 * - `downsampleToPcm16()` 里的区间平均保证 4800 → 1600、4410 → 1600。
 *
 * @param {object} opts
 * @param {number} opts.inputRate       采集采样率（ctx.sampleRate，通常 44100 / 48000）
 * @param {number} [opts.frameMs]       一帧多少毫秒（默认 100）
 * @param {number} [opts.targetRate]    目标采样率（默认 16000）
 */
export function createPcmFramer({ inputRate, frameMs = FRAME_MS, targetRate = TARGET_RATE } = {}) {
  const rate = Number(inputRate);
  const target = Number(targetRate);
  const ms = Number(frameMs) > 0 ? Number(frameMs) : FRAME_MS;
  const valid = rate > 0 && target > 0;
  /** 一帧需要多少**输入**样本（48k → 4800，44.1k → 4410） */
  const frameLen = valid ? Math.max(1, Math.round((rate * ms) / 1000)) : 0;
  /** 一帧吐多少**输出**样本（应恒为 1600；不整除的采样率也不漂移） */
  const outLen = valid ? Math.max(1, Math.round((target * ms) / 1000)) : 0;
  let buf = new Float32Array(valid ? Math.max(frameLen, 2048) : 1);
  let filled = 0;
  let frames = 0;
  let flushed = 0;

  function ensure(extra) {
    if (filled + extra <= buf.length) return;
    let cap = buf.length || 1;
    while (cap < filled + extra) cap *= 2;
    const next = new Float32Array(cap);
    next.set(buf.subarray(0, filled));
    buf = next;
  }

  function take() {
    const pcm = downsampleToPcm16(buf.subarray(0, frameLen), rate, target);
    buf.copyWithin(0, frameLen, filled);
    filled -= frameLen;
    frames += 1;
    return pcm;
  }

  return {
    push(samples) {
      if (!valid || !samples) return [];
      const len = Number(samples.length) || 0;
      if (!len) return [];
      ensure(len);
      buf.set(samples, filled);
      filled += len;
      const out = [];
      while (filled >= frameLen) out.push(take());
      return out;
    },
    /** 把最后不足 100ms 的尾巴也转成一帧（stop 时调用；没有尾巴返回 null） */
    flush() {
      if (!valid || !filled) return null;
      const pcm = downsampleToPcm16(buf.subarray(0, filled), rate, target);
      filled = 0;
      flushed += 1;
      return pcm;
    },
    reset() {
      filled = 0;
      frames = 0;
      flushed = 0;
    },
    get inputRate() { return rate; },
    get targetRate() { return target; },
    get frameMs() { return ms; },
    get frameSamples() { return frameLen; },
    get outputSamples() { return outLen; },
    get frames() { return frames; },
    get flushedFrames() { return flushed; },
    get pending() { return filled; },
  };
}
