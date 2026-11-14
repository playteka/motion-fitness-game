# src/voice/pcm-worklet.js — AudioWorklet：把麦克风渲染块攒成 100ms 一块

> 层：语音（音频线程） ｜ 74 行 ｜ 只在浏览器音频线程执行（Node 测试不会加载它）
> 一句话：定帧发生在音频线程，不受主线程（姿态识别 / 渲染）卡顿影响。

## 1. 它解决什么问题（为什么需要它）

主线程每帧要跑姿态推理 + 渲染，忙起来会掉帧；如果在主线程按渲染块（128 帧 ≈ 2.7ms）发音频，
一秒 375 条 WebSocket 消息、每包约 86 字节 —— 上游识别效果极差（多数会话 `segments:0`）。
把「攒成 100ms」放到音频线程后，`postMessage` 从每秒 375 次降到 **10 次**。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `DEFAULT_FRAME_MS` | L23 | `100` | 一帧毫秒数（可被 `processorOptions.frameMs` 覆盖，限 10~500） |
| `_frameLen` | L32 | `max(128, round(sampleRate*ms/1000))` | 44.1k → 4410，48k → 4800 样本 |
| `_buf` / `_filled` | L33-L34 | `Float32Array` + 计数 | 攒样本的缓冲 |
| `_frames` | L35 | 计数 | 发过多少块（诊断用） |
| 处理器名 | L74 | `'mfg-pcm-capture'` | `registerProcessor` 的名字（主线程 `addModule` 后用） |

## 3. 算法与流程（步骤化）

```
process(inputs):
  channel = inputs[0][0]            // 单声道：只取第 0 声道（火山要 channel=1）
  for 每个样本:
    _buf[_filled++] = 样本
    若 _filled >= _frameLen → _emit(false)
  return true                       // 一直活着，直到主线程 disconnect
```

`_emit(finalTail)` L57-L71：`postMessage({type:'pcm', samples, sampleRate, frameMs, frames})`
并 **transfer** `samples.buffer`（零拷贝）。`finalTail=true` 时允许不足一帧
（主线程 `port.postMessage({type:'flush'})` 触发，见 L36-L39，`stop()` 时用）。

**降采样不在这里做**：`ctx.sampleRate` 可能是 44.1k / 48k，降采样逻辑放主线程才能被
Node 单测覆盖（`pcm.js` 的 `downsampleToPcm16`），10 帧/秒 × 4800 个 Float32 的拷贝可忽略。

## 4. 对外接口

- 不是 ES module 的常规导出：靠 `registerProcessor('mfg-pcm-capture', MfgPcmCapture)`（L74）
  注册，主线程 `audioWorklet.addModule('./src/voice/pcm-worklet.js')` 后按名字创建。
- 消息契约：收 `{type:'flush'}`；发 `{type:'pcm', samples, sampleRate, frameMs, frames}`。

## 5. 与其它文件的关系

- 上游：无 import（音频线程里只有 `AudioWorkletProcessor` / `sampleRate` / `registerProcessor`
  这些全局量）。
- 下游：`voice/providers.js` 的 `startPcmCapture`（创建 worklet 节点、收 `pcm` 消息、
  交给 `pcm.js` 的 `createPcmFramer` 定帧后发 WebSocket）。
- 与 `pcm.js` 分工：**worklet 定帧（按输入采样率）**，`pcm.js` 降采样成 16k 的 Int16。

## 6. 易错点与设计取舍

- `process()` **必须 `return true`**：返回 `false` 后处理器会被回收，麦克风就「突然没声」。
- `_frameLen` 下限 128：`frameMs` 配太小（<10ms）时 `sampleRate*ms/1000` 可能小于渲染块，
  会频繁 `_emit`，所以夹在 10~500ms 且至少 128 样本。
- 只取声道 0：多声道混音对 ASR 没意义（而且会改变音量）。
- transfer 掉 `buffer` 后原数组不可再用：`_emit` 里用 `slice` 出的新数组，不能用 `subarray`。
- 该文件**不会**被 Node 测试加载：它依赖 `AudioWorkletProcessor` 全局量；测的是 `pcm.js`。

## 7. 读代码建议（先看哪几行）

1. L1-L20 头部（为什么在音频线程定帧）；
2. L26-L40 构造（`frameLen` 与 flush 消息）；
3. L42-L54 `process`（唯一的热点路径）；
4. L57-L71 `_emit`（transfer 与 `frames` 计数）。
