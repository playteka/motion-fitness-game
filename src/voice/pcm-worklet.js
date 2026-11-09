/**
 * AudioWorklet 处理器（浏览器里由 `addModule()` 加载，Node 测试不会执行它）。
 *
 * 只做一件事：按 `sampleRate` 把麦克风的 Float32 渲染块（通常 128 帧）**攒成 100ms 一块**，
 * 再 post 回主线程；主线程用 `src/voice/pcm.js` 的纯函数降采样成 16k PCM16（1600 样本 / 3200 字节）。
 *
 * 为什么不在主线程按渲染块逐块发：
 *   - 以前 128 帧（≈2.7ms）就发一包 → 一秒约 375 条 WebSocket 消息、每包约 86 字节。
 *     用户日志里 `chunks:30619 / audioBytes:2633234` 就是每包 86 字节 —— 帧很多、但每包太碎，
 *     上游识别效果很差（多数会话 `segments:0`）。
 *   - 现在在音频线程里按 100ms 定帧：不受主线程忙（姿态识别 / 渲染）影响，
 *     postMessage 从每秒 375 次降到 **10 次**，主线程也不会积压。
 *
 * 为什么不在 worklet 里降采样：
 *   - `ctx.sampleRate` 可能是 44.1k / 48k，降采样逻辑放主线程才能被 Node 单测覆盖；
 *   - 10 帧/秒 × 4800 个 Float32 的拷贝可以忽略。
 *
 * 约定：`process()` 必须 `return true` 一直活着；主线程 `disconnect()` 后停止。
 * 主线程 `port.postMessage({ type: 'flush' })` 时把不足 100ms 的尾巴也发出去（stop 用）。
 */

/** 一帧 100ms：16k / 16bit / 单声道 = 1600 样本 = 3200 字节 = 32KB/s */
const DEFAULT_FRAME_MS = 100;

class MfgPcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const ms = Number(opts.frameMs);
    this._frameMs = Number.isFinite(ms) && ms >= 10 && ms <= 500 ? ms : DEFAULT_FRAME_MS;
    // sampleRate 是 AudioWorkletGlobalScope 的全局量：44.1k → 4410 样本/帧，48k → 4800
    this._frameLen = Math.max(128, Math.round((sampleRate * this._frameMs) / 1000));
    this._buf = new Float32Array(this._frameLen);
    this._filled = 0;
    this._frames = 0;
    this.port.onmessage = (event) => {
      const data = event && event.data;
      if (data && data.type === 'flush') this._emit(true);
    };
  }

  process(inputs) {
    const input = inputs && inputs[0];
    // 单声道：只取第 0 声道（火山要 channel=1；多声道时混音没有意义）
    const channel = input && input[0];
    if (channel && channel.length) {
      for (let i = 0; i < channel.length; i += 1) {
        this._buf[this._filled] = channel[i];
        this._filled += 1;
        if (this._filled >= this._frameLen) this._emit(false);
      }
    }
    return true;   // 一直活着，直到主线程 disconnect
  }

  /** 发一块（transfer 掉 buffer，零拷贝）；finalTail=true 时允许不足一帧 */
  _emit(finalTail) {
    if (!this._filled) return;
    const samples = finalTail
      ? this._buf.slice(0, this._filled)
      : this._buf.slice(0, this._frameLen);
    this._filled = 0;
    this._frames += 1;
    this.port.postMessage({
      type: 'pcm',
      samples,
      sampleRate,
      frameMs: this._frameMs,
      frames: this._frames,
    }, [samples.buffer]);
  }
}

registerProcessor('mfg-pcm-capture', MfgPcmCapture);
