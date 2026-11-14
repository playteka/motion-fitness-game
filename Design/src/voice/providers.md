# src/voice/providers.js — 适配器层（麦克风 / ASR / LLM / TTS / VU）

> 层：语音（能力适配） ｜ 1482 行 ｜ 界面与会话只认接口，不认厂商
> 一句话：换一家服务只改这一个文件里的一套实现；失败一律走回调，**绝不把异常抛给状态机**。

## 1. 它解决什么问题（为什么需要它）

浏览器能力差异极大：`SpeechRecognition` 在国内连不上 Google、`speechSynthesis` 音色随系统、
火山要 WebSocket + 自定义握手头（浏览器不能设）。所以把「能力」全部收在这层：
`createAsr`（浏览器回退）/ `createVolcAsr`（火山流式）/ `createAutoAsr`（优先火山、失败回退）、
`createMic`（权限与轨道生命周期）、`createTts`（系统 TTS 兜底）、`createVuMeter`（音量表）。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `ASR_WS_PATH` | L134 | `/asr` | 同源代理路径 |
| `DEFAULT_ASR_WS_URL` | L140 | `ws://127.0.0.1:4180/asr` | 独立代理进程的默认地址 |
| `ASR_ROUTES` | L143 | 同源 / 本机 / 独立 | 选路策略 |
| `VOLC_ERROR_MAP` | L233 | 上游错误码 → 稳定 code | 只回 code，不回凭证 |
| `ASR_FATAL_ERRORS` | L258 | 致命错误集合 | 决定是落 error 还是只给 notice |
| `VU_RMS_FLOOR` / `CEIL` / `LOG_K` | L1145-L1149 | `0.004` / `0.30` / `12` | 音量映射到 0~1 |
| `VU_LEVEL_VOICE` / `LOUD` | L1151-L1152 | `0.08` / `0.62` | 颜色分档 |
| `VU_ATTACK_MS` / `RELEASE_MS` | L1161-L1162 | `45` / `220` | 起振快、回落慢（像真的 VU 表） |

## 3. 算法与流程（步骤化）

**麦克风**（`createMic` L61）：`open()` → `Promise<MediaStreamTrack[]>`，`close()` 每轨 `stop()`，
`active` getter。**只有这一处**拿到 / 释放麦克风（会话层不直接碰 `getUserMedia`）。

**ASR 选路**（`createAutoAsr` L1052）：

```
resolveAsrUrl(win) L176 / pickAsrRoute L196：
   页面是 http(s) → 同源 ws(s)://<host>/asr（并入 preview-server 的那条）
   页面是 file:// 或同源不可用 → 127.0.0.1:4180 → 再失败 → 浏览器 SpeechRecognition
createVolcAsr L642：AudioWorklet 定帧 → 100ms PCM 帧 → WebSocket 发 /asr
   partial / final / error 回调；错误码走 volcErrorCode L246 / asrNoticeCode L267
createAsr L288：浏览器 SpeechRecognition 的临时替代（不支持时返回 false + 提示，不抛错）
```

**采集**（`startPcmCapture` L525）：`AudioContext` → `addModule(pcm-worklet.js)` →
worklet 每 100ms 回 Float32 → `pcm.js` 降采样成 16k PCM16 → 交给回调（发 WebSocket）。

**VU**（`createVuMeter` L1222）：共享麦克风流 → `AnalyserNode` → `rmsToLevel`（对数映射）→
`smoothLevel`（起振 45ms / 回落 220ms）→ `levelToColor`（灰 → 青 → 薄荷亮绿）。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createMic({win, diag})` | L61 | → `{open, close, active}` | 麦克风生命周期 |
| `createAutoAsr({mic, diag})` | L1052 | → asr 适配器 | 火山优先、浏览器兜底 |
| `createVolcAsr({…})` / `createAsr({win})` | L642 / L288 | → asr 适配器 | 两种实现 |
| `startPcmCapture({…})` | L525 | → 控制器 | 采集 + 定帧（自检也用它） |
| `resolveAsrUrl` / `sameOriginAsrUrl` / `pickAsrRoute` | L176 / L159 / L196 | 纯函数 | 选路 |
| `volcErrorCode` / `asrNoticeCode` | L246 / L267 | 纯函数 | 错误码归一 |
| `createVuMeter({…})` / `rmsToLevel` / `smoothLevel` / `levelToColor` | L1222 / L1177 / L1192 / L1203 | 混合 | 音量表 |
| `createLlm({pick})` | L1360 | → llm | 本地罐头回复（无 LLM 时的兜底） |
| `createTts({win, lang, rate, diag})` | L1398 | → `{speak, cancel, setRate}` | 系统 TTS（最终降级） |

## 5. 与其它文件的关系

- 上游：`i18n.js`（`t` / `tList` / `getLang` / `getMeta().speechLang`）、
  `voice/pcm.js`（定帧 / 降采样）、`vendor` 无（浏览器 API）。
- 下游：`app.js`（`createMic` / `createAutoAsr` / `createTts` / `createVuMeter`）、
  `voice/session.js`（只依赖接口形状）、`voice/tts-volc.js`（火山 TTS 播放层，与 `createTts` 同契约）、
  `voice/coach.js`（VU）、`voice/selftest.js`（`createVuMeter` / `startPcmCapture`）。
- 服务端对应物：`server/coach-proxy.mjs`（`/asr` 代理）、`server/volc-asr.mjs`。

## 6. 易错点与设计取舍

- **工厂不碰 DOM、加载时不抛错**（L16-L19）：所有浏览器能力在调用时探测，Node 里 import 也不崩。
- **失败走回调 / 返回值**：状态机负责落 error，这层不抛异常（否则一个 reject 就能让整条链路停）。
- `resumeAudio()` / `AudioContext` 的用户手势限制：没有手势时 `state='suspended'`，要在
  `unlock` 时机重启（与 `audio.js` 同一坑）。
- **只有一处释放麦克风**：`mic.close()`；会话层 / 自检 / 教练都不许自己 `stop` 轨道。
- VU 的 attack/release 不对称是刻意的：对称会显得「忽明忽暗」。
- `createTts` 是**最终兜底**：它出声就说明火山那条彻底失败了，诊断里会出现 `tts:say source:"system"`。

## 7. 读代码建议（先看哪几行）

1. L1-L27 头部（三个接口的约定与分工）；
2. L54-L124 `createMic`（权限与轨道）；
3. L196-L290 选路与错误码归一；
4. L525-L642 采集 + 火山 ASR（100ms 帧的来源）；
5. L1145-L1222 VU 映射。
