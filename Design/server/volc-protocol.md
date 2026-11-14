# server/volc-protocol.mjs — 火山流式 ASR 2.0 的二进制协议层（纯编解码）

> 层：服务端（协议） ｜ 685 行 ｜ 不碰网络、不碰文件，Node 里直接可测
> 一句话：把「开始 / 音频 / 最后一包」编成火山认的二进制帧，再把响应帧解成文本事件。

## 1. 它解决什么问题（为什么需要它）

火山 SAUC v3 是**自有二进制帧**（不是 JSON over WS）：4 字节头 + 可选序号 + 长度 + payload，
还可能是 gzip 压缩、可能带错误帧。协议细节与业务无关，所以整层抽成纯函数，
用 Buffer 对拍测试 —— 这样改协议不会牵连会话层。

```
帧结构（整数一律大端，文件头 L7-L24）：
  +--------+--------+--------+--------+
  | byte 0 | byte 1 | byte 2 | byte 3 |   4 字节头
  +--------+--------+--------+--------+
   版本/头长  类型/标志  序列化/压缩  保留
  普通帧   ：header + payload_size(uint32) + payload
  带序号帧 ：header + sequence(int32) + payload_size(uint32) + payload
  错误帧   ：header + error_code(uint32) + msg_size(uint32) + msg(UTF-8)
```

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `HEADER_SIZE` / `PROTOCOL_VERSION` / `HEADER_SIZE_CODE` | L35-L37 | `4` / `0b0001` / `0b0001` | 头长度与版本 |
| `MESSAGE_TYPES` | L39-L45 | full-client / audio-only / full-server / error… | 消息类型 |
| `FLAGS` | L46-L52 | 无序号 / 正序号 / 最后一包 / 负序号 | `(flags & 0b0010)` = 最后一包 |
| `SERIALIZATION` / `COMPRESSION` | L53 / L54 | `NONE/JSON`、`NONE/GZIP` | payload 编码 |
| `VOLC_DEFAULTS` | L57-L66 | 端点 / 超时 / 参数 | 默认连接参数 |
| `AUDIO_FORMAT` | L67-L77 | 16k / 16bit / 单声道 | 音频格式（`asr-probe` 用它造 PCM） |
| `HOTWORDS` | L78-L96 | 词表 | 识别热词（动作名 / 口令） |
| `VOLC_ERROR_CODES` | L97-L109 | 上游码 → 稳定 code | 对外只回稳定 code |
| `FINAL_THROTTLE_MS` | L449 | `300` | final 节流（与 coach-proxy 同值） |

## 3. 算法与流程（步骤化）

**发**：

```
buildStartPayload({lang, hotwords, uid}) L297   → JSON（含热词上下文）
buildStartFrame(...) L324                        → gzip + JSON 序列化 + 无序号帧
buildAudioFrame(chunk, {last}) L337              → gzip + 音频帧；最后一包带 flags 0b0010
buildFrame({messageType, flags, serialization, compression, sequence, payload}) L151 → Buffer
buildAuthHeaders({...}) L639                     → 握手头（APP ID / Key / Resource / Request-Id）
```

**收**：

```
createFrameParser() L245      增量解帧（TCP 分片 → 完整帧）
parseFrame(buffer) L178       解出 {messageType, flags, sequence, payload, errorCode…}
inflateFramePayload(frame) L269   gzip 解压
parseResponseFrame(frame, {secrets}) L412 → {type:'partial'|'final'|'error', text, …}
createTranscriptReducer({throttleMs}) L470 → 把「同一条 utterance 的多次结果」收敛成
       partial（节流）/ final（不重复），避免同一句反复上屏
sanitizeDetail(text, secrets) L679 → 脱敏（上游错误正文可能回显 key）
```

## 4. 对外接口

| 导出 | 位置 | 说明 |
|---|---|---|
| `buildStartFrame` / `buildAudioFrame` / `buildFrame` | L324 / L337 / L151 | 组帧 |
| `createFrameParser` / `parseFrame` / `parseResponseFrame` | L245 / L178 / L412 | 解帧 |
| `createTranscriptReducer({throttleMs})` | L470 | 结果收敛（partial 节流 + final 去重） |
| `parseResultJson(json)` / `hotwordContext(hotwords)` | L380 / L284 | 纯解析 |
| `buildAuthHeaders` / `AUTH_HEADER_NAMES` | L639 / L665 | 握手头（顺序固定） |
| `sanitizeDetail` / `volcErrorCode` | L679 / L110 | 脱敏 / 错误码 |
| `VOLC_DEFAULTS` / `AUDIO_FORMAT` / `HOTWORDS` / `VOLC_ERROR_CODES` / `FINAL_THROTTLE_MS` | L57-L109 | 常量 |

## 5. 与其它文件的关系

- 上游：`node:zlib`（gzip）、`server/env.mjs`（`redactSecrets`）。
- 下游：`server/volc-asr.mjs`（组帧 / 解帧 / reducer）、`server/coach-proxy.mjs`
  （`VOLC_DEFAULTS`）、`server/asr-probe.mjs`（`AUDIO_FORMAT` / `sanitizeDetail`）、
  `tests/test-voice.mjs`（Buffer 对拍）。

## 6. 易错点与设计取舍

- **字节序全大端**：JS 的 `Buffer.readUInt32BE` 才行，用 `readUInt32LE` 会得到荒谬的长度。
- **flags 的「最后一包」是第 2 位**（`0b0010`），不是第 1 位（那是「有序号」）。
- 音频帧**也要 gzip**（火山接受），省带宽；但最后一包的 flags 必须对，否则上游不结束会话。
- `createTranscriptReducer` 的 final 去重要按 **utterance/segment** 判，不能只按文本 ——
  同一句话在两段里都出现是正常的（用户说了两遍）。
- `sanitizeDetail` 必须在**所有**对外文本上调用：错误帧正文是上游原文，可能带 key。
- 热词表（`HOTWORDS`）改这里就够了：`buildStartPayload` 只读这一份。

## 7. 读代码建议（先看哪几行）

1. L1-L25 头部（帧结构图，先看懂这个）；
2. L131-L177 `hasSequence` / `isLastFlags` / `buildFrame`（编码核心）；
3. L178-L268 `parseFrame` / `createFrameParser`（解码核心）；
4. L412-L470 `parseResponseFrame` + `createTranscriptReducer`（业务口径）。
