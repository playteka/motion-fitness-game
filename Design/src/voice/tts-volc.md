# src/voice/tts-volc.js — 火山 TTS 前端播放层（流式 + MSE / 解码队列 + 三段降级）

> 层：语音（播放） ｜ 1488 行 ｜ 接口与 `providers.js` 的 `createTts()` 完全一致
> 一句话：能边收边播就不等整段；MSE 不行就解码队列；流式不行就整段；全不行才用系统 TTS。

## 1. 它解决什么问题（为什么需要它）

首字延迟决定「教练像不像活的」。整段合成要等全部音频回来（1~2s+），流式可以 0.4~1.3s 出声。
但流式播放有两个现实问题：MP3 帧边界（半帧解码会整块失败）与浏览器差异（MSE 支持度）。
所以做了三级降级，每一级都记诊断，**绝不哑掉**。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `TTS_PATH` / `TTS_STREAM_PATH` / `TTS_HEALTH_PATH` | L31-L33 | `/tts` `/tts/stream` `/tts/health` | 服务端路由 |
| `TTS_TIMEOUT_MS` | L35 | `3000` | 拿不到音频就降一级 |
| `TTS_STREAM_IDLE_MS` | L44 | `2500` | 流中间断流看门狗（超时当说完） |
| `TTS_STREAM_READ_MAX_MS` | L46 | `15000` | 一次朗读的硬上限 |
| `TTS_SPEAK_GUARD_MS` / `MIN` | L48 / L49 | `20000` / `6000` | 兜底总时长（`ttsGuardMs` L52 按字数估） |
| `TTS_STREAM_LEAD_SEC` | L59 | `0.06` | 首块排程提前量 |
| `TTS_SOURCES` / `DEFAULT` | L61 / L62 | `auto / volc / system`，默认 `auto` | 音色来源 |
| `TTS_RATE_MIN/MAX` / `TTS_MAX_CHARS` | L66-L68 | `0.5~2` / `300` | 语速与文本上限 |
| `MSE_MIME` | L176 | `audio/mpeg` | MSE 的 SourceBuffer 类型 |

## 3. 算法与流程（步骤化）

```
speak(text)：
① POST /tts/stream（边收边播）
     支持 MSE → createMsePlayback（L461）：收一块 append 一块，原生 demuxer 管帧边界
     不支持 → createAudioQueuePlayer（L626）：createMp3FrameSplitter（L238）按帧长切开，
              **只把完整帧**送去 decodeAudioData（半帧会让整块失败）
     记 tts:first-audio {ms, mode}
② 流式 404 / 不支持 / 失败（tts:stream-fail）→ POST /tts 整段（服务端有缓存），记 tts:whole
③ 整段也 502 / 超时 / 网络错 → 系统 TTS，记 tts:fallback {code}
```

**抢话**：新一句要说时**先停上一句**（停播放 + abort 流式请求 + 释放解码队列 / blob URL）；
`stop()` 还要 **abort 上游** —— 插话打断（`bargein.js`）靠它（文件 L19-L24）。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createVolcTts({win, diag, lang, rate, source, gender})` | L838 | → `{speak, stop, cancel, close, setRate, …}` | 主入口 |
| `speak(text, {onEnd, onError})` | — | → boolean | true = 接下这一句；结束/失败必回调，绝不 hang |
| `planStreamQueue(chunks, opts)` | L113 | → 排程 | 纯函数（测试断言时序） |
| `parseMp3FrameHeader` / `createMp3FrameSplitter` | L195 / L238 | 纯函数 | MP3 帧对齐 |
| `mseSupportsMpeg(win)` | L326 | → boolean | 能力探测 |
| `createMsePlayback` / `createAudioQueuePlayer` | L461 / L626 | → 播放器 | 两种播放实现 |
| `ttsText` / `ttsGuardMs` / `normalizeTtsRate` / `normalizeTtsSource` | L88 / L52 / L81 / L70 | 纯函数 | 文本清洗与守卫 |
| `TTS_*` 常量 | L31-L68 | 常量 | 界面与测试共用 |

## 5. 与其它文件的关系

- 上游：服务端 `server/volc-tts.mjs`（`/tts`、`/tts/stream`；**返回真音频字节**是关键）。
- 下游：`app.js`（`createVolcTts` L404，包在 `createTts` 外面做降级）、
  `voice/bargein.js`（调它的 `stop`）、`voice/session.js`（只依赖 `speak` 契约）。
- 与 `providers.js` 的 `createTts`：同一个接口，**一个火山、一个系统**；组成降级链。

## 6. 易错点与设计取舍

- **真事故**（L13-L17）：服务端曾把上游 JSON 信封（base64）当 MP3 转发 → 两端解码都失败。
  所以服务端有 `unwrapVolcAudio`，前端有 `tts:fail {where, errName, errMessage}` 诊断。
- **半帧不能解码**：`createMp3FrameSplitter` 只吐完整帧；别为了降低延迟把残帧塞进去。
- **流中间断流看门狗**（`TTS_STREAM_IDLE_MS`）：没有它，响应流永不结束时 `endOfStream()` 不调用、
  `ended` 不触发、会话永远卡在 `speaking`。
- **`speak()` 必须回调**（L26-L28）：`onEnd` / `onError` 二选一，绝不 hang；否则会话层要靠看门狗救。
- `stop()` 与 `cancel()` 的差别：`stop` 停播放 + abort 上游（打断），`cancel` 只清本地。
- 「教练：」前缀只显示不念：前缀在弹幕 / 字幕层加，这里收到的 `text` 是纯正文。

## 7. 读代码建议（先看哪几行）

1. L1-L29 头部（三级降级 + 真实事故复盘）；
2. L52-L120 `ttsGuardMs` / `ttsText` / `planStreamQueue`（纯函数部分）；
3. L195-L330 MP3 帧切分与 MSE 能力探测；
4. L838 起 `createVolcTts` 的 `speak`（降级链的实际顺序）。
