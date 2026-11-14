# server/volc-asr.mjs — 火山流式 ASR 的会话层（连接 / 发帧 / 收事件）

> 层：服务端（传输） ｜ 443 行 ｜ socket 可注入，测试不需要联网也不需要真 Key
> 一句话：协议在 `volc-protocol.mjs`，这里只负责 socket 的生命周期与稳定错误码。

## 1. 它解决什么问题（为什么需要它）

「连火山 → 发开始帧 → 持续发音频 → 收 partial/final → 收尾」是一条有状态的流程，
涉及 TLS、握手头、超时、错误分类。把它和纯编解码分开，测试就能用假 socket 跑完整条链路。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 / 形状 | 说明 |
|---|---|---|---|
| `networkErrorCode(err)` | L36 | 稳定 code | 把底层 socket / TLS 错误压成 `network` / `timeout` |
| `fail(code, message)` | L47 | 内部工具 | 构造统一失败 |
| `maskedCloseFrame(code)` | L52 | Buffer | 客户端方向的关闭帧（要掩码） |
| `encodeClientMessage(payload)` | L65 | Buffer | 文本消息（JSON）帧 |
| `openVolcSocket({url, headers, timeoutMs})` | L79 | → socket | 建连 + 握手（可注入） |
| `createVolcSession({...})` | L237 | → session | 一次识别会话 |

对外错误码（L9-L16，浏览器只认这层）：`auth`（401/403）、`network`、`timeout`、
`upstream`（带 `volcCode`）、`protocol`、`config`（coach.env 缺字段）。

## 3. 算法与流程（步骤化）

```
createVolcSession({socket, config, …})：
① 连接：openVolcSocket(url, headers = buildAuthHeaders(...)) —— 握手失败 → auth / network
② 发开始帧：buildStartFrame({lang, hotwords, uid})
③ 音频：每收一块 PCM → buildAudioFrame(chunk, {last:false})；结束时发 {last:true}
④ 收：ws 帧 → createFrameParser → parseFrame → inflate → parseResponseFrame
      → createTranscriptReducer（partial 节流 / final 去重）→ onPartial / onFinal 回调
⑤ 错误帧 → onError({code:'upstream', volcCode, message: sanitizeDetail(...)})
⑥ 收尾：发最后一包 → 等 final（有宽限）→ 关闭；超时 → timeout
```

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `openVolcSocket({url, headers, timeoutMs})` | L79 | → Promise<socket> | 可注入（测试用假 socket） |
| `createVolcSession({...})` | L237 | → session | `start / write / end / close` + 回调 |
| `encodeClientMessage(payload)` | L65 | → Buffer | 文本帧 |
| `maskedCloseFrame(code)` | L52 | → Buffer | 关闭帧 |
| `networkErrorCode(err)` | L36 | → 稳定 code | 错误归类 |

## 5. 与其它文件的关系

- 上游：`server/ws-mini.mjs`（帧编解码）、`server/volc-protocol.mjs`（组帧 / 解帧 / reducer）。
- 下游：`server/coach-proxy.mjs`（每个浏览器连接建一个会话）、`server/asr-probe.mjs`（探针）。
- 与前端 `src/voice/providers.js` 的 `createVolcAsr` 是**同一条链路的两端**：前端发 PCM，
  这里转发给火山。

## 6. 易错点与设计取舍

- **凭证只在服务端**：`buildAuthHeaders` 的结果不进日志，错误正文一律 `sanitizeDetail`。
- 错误码只有这 6 个：前端文案与重试策略都按它们分支，别新增（会缺文案）。
- `auth` 与 `config` 要分开：前者是 key 错，后者是没配 —— 用户看到的提示完全不同。
- 关闭要等 final 有宽限（`FINAL_GRACE_MS` 在 coach-proxy，不在本文件）：直接断会丢最后一两个词。
- socket 可注入是这层的核心设计：没有它就无法在 CI 里测完整链路。

## 7. 读代码建议（先看哪几行）

1. L1-L16 头部（错误码清单与分层理由）；
2. L36-L78 错误归类与客户端帧；
3. L79-L236 `openVolcSocket`（握手与超时）；
4. L237 起 `createVolcSession`（发帧 / 收帧 / 回调）。
