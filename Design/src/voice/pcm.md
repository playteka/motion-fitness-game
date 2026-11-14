# src/voice/pcm.js — 浏览器端 PCM 工具（100ms 定帧 + 降采样到 16k）

> 层：语音（音频格式） ｜ 203 行 ｜ 纯函数 + 一个可注入的 framer，Node 里直接可测
> 一句话：麦克风给 44.1k/48k Float32，火山要 16k/16bit/单声道 —— 这层只做这一件事。

## 1. 它解决什么问题（为什么需要它）

火山流式 ASR 的输入是 16kHz / 16bit / 单声道，且**每包 100ms** 才有正常识别效果。
麦克风给的是 44.1k 或 48k 的 Float32 渲染块。如果按渲染块（128 样本 ≈ 2.7ms）直接发，
一秒 375 包、每包 86 字节 —— 日志看着「帧很多」，但上游把音频切得极碎，多数会话 `segments:0`。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `TARGET_RATE` | L14 | `16000` | 火山要求 |
| `PCM16_FULL_SCALE` | L16 | `32767` | Int16 满量程 |
| `FRAME_MS` | L26 | `100` | 一帧 100ms |
| `FRAME_SAMPLES` | L28 | `1600` | 1600 样本 |
| `FRAME_BYTES` | L30 | `3200` | 3200 字节 |
| `EXPECTED_BYTES_PER_SEC` | L32 | `32000` | 32KB/s（诊断面板判断「正常吗」） |

## 3. 算法与流程（步骤化）

**降采样**（`downsampleToPcm16(input, inputRate, targetRate)` L67）：
每个输出样本取输入里 `[i*ratio, (i+1)*ratio)` 的**区间平均**（简易低通，比直接抽取少很多混叠），
再转 Int16。输出长度严格 `round(n * 16000 / inputRate)` —— 44.1k→16k 的整数关系由
`createPcmFramer` 保证不漂移（见下）。

**定帧**（`createPcmFramer({inputRate, frameMs, targetRate})` L138-L203）：

```
frameLen = round(inputRate * frameMs / 1000)   // 48k → 4800，44.1k → 4410（输入样本数）
push(samples)  → 追加进内部 buffer → while (可用 >= frameLen) take()
take()        → 取连续 frameLen 个 → downsampleToPcm16 → 输出 Int16Array（恒 1600 样本）
flush()       → 把不足 100ms 的尾巴也转一帧（stop 时用；没有尾巴返回 null）
```

buffer 是**可增长的**（`ensure` L152-L159）：主线程卡顿时一次可能来很多样本。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `downsampleToPcm16(input, inRate, targetRate)` | L67 | → `Int16Array` | 降采样 + 转 Int16 |
| `floatToPcm16(input)` | L45 | → `Int16Array` | 只转格式（夹 -1~1、四舍五入） |
| `createPcmFramer(opts)` | L138 | → `{push, flush, reset, …}` | 定帧器（`push` 返回 0~N 帧） |
| `pcm16Rms(pcm)` / `pcm16Peak(pcm)` | L87 / L99 | → 0~1 | 音量（VU / 诊断） |
| `pcmBytesToMs` / `pcmBytesPerSec` | L110 / L116 | → 数 | 字节 ↔ 毫秒 |
| `TARGET_RATE` / `FRAME_MS` / `FRAME_BYTES` / `EXPECTED_BYTES_PER_SEC` | L14-L32 | 常量 | 诊断与测试共用 |

## 5. 与其它文件的关系

- 上游：无（纯函数，不碰 WebAudio）。
- 下游：`voice/providers.js`（`startPcmCapture` 用 framer 发帧）、`voice/pcm-worklet.js` 的产出
  也在这里定帧 / 降采样、`voice/diag.js`（`EXPECTED_BYTES_PER_SEC` 判码率）、
  `voice/selftest.js`（`createPcmFramer` + `FRAME_BYTES`）。
- 测试：`tests/test-voice.mjs` 断言 44.1k → 16k 的长度与值。

## 6. 易错点与设计取舍

- **不做重采样滤波器组 / 抗混叠窗**：语音识别对这点混叠不敏感，区间平均已经够干净；
  重要的是**长度严格正确**（L9-L10）。
- 44.1k 不能整除 16k：所以按「输入 4410 样本 → 输出 1600」定帧，靠 `round` 而不是累积误差。
- 空输入 / 非法采样率 → 返回空（调用方跳过这一包），不抛错。
- `flush()` 的尾巴不足一帧：ASR 需要它（否则最后一个字被吞），但**不要**每帧都调。
- `FRAME_BYTES` 必须 = `FRAME_SAMPLES * 2`：改采样率 / 位深时三处一起改。

## 7. 读代码建议（先看哪几行）

1. L18-L32 常量（100ms / 3200 字节的来历）；
2. L67-L86 `downsampleToPcm16`（区间平均 + 长度）；
3. L138-L203 `createPcmFramer`（`take` / `flush` 是全链路的关键）。
