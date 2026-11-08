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
