/**
 * AudioWorklet 处理器（浏览器里由 `addModule()` 加载，Node 测试不会执行它）。
 *
 * 只做一件事：把麦克风的 Float32 渲染块（128 帧）**复制**一份 post 回主线程，
 * 由主线程用 `src/voice/pcm.js` 的纯函数降采样成 16k PCM16 再发给本机代理。
 *
 * 为什么不在 worklet 里降采样：
 *   - `ctx.sampleRate` 可能是 44.1k / 48k，降采样逻辑放主线程才能被 Node 单测覆盖；
 *   - 128 帧一块只有 0.5KB，postMessage 的开销可以忽略（一秒钟约 375 条）。
 */

class MfgPcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs && inputs[0];
    const channel = input && input[0];
    if (channel && channel.length) {
      // 必须复制：渲染块的内存在下一个 quantum 会被复用
      this.port.postMessage(new Float32Array(channel));
    }
    return true;   // 一直活着，直到主线程 disconnect
  }
}

registerProcessor('mfg-pcm-capture', MfgPcmCapture);
