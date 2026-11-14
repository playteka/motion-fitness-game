# server/ws-mini.mjs — 最小 WebSocket 实现（握手 / 分帧 / 掩码 / 分片重组）

> 层：服务端（协议底座） ｜ 230 行 ｜ 零依赖，只做够用的一件事
> 一句话：一个进程要同时当「服务端」（浏览器 → 代理）和「客户端」（代理 → 火山），这里把两者都覆盖。

## 1. 它解决什么问题（为什么需要它）

零依赖的项目不能引 `ws`。而语音链路需要两条 WebSocket：
浏览器 ↔ `/asr` 代理（服务端方向，收到的是**掩码**帧）与代理 ↔ 火山（客户端方向，发出要掩码）。
需要的特性只有：握手 accept 计算、文本/二进制/关闭/ping/pong 五类帧、7/16/64 位长度、
掩码、分片重组。**不做**扩展（permessage-deflate）与子协议协商。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `WS_GUID` | L20 | `258EAFA5-…-C5AB0DC85B11` | RFC 6455 固定 GUID |
| `OPCODES` | L22-L30 | `continuation 0x0 / text 0x1 / binary 0x2 / close 0x8 / ping 0x9 / pong 0xA` | 帧类型 |
| `WS_LIMITS` | L31-L36 | 最大帧 / 最大消息 | 防内存放大 |

## 3. 算法与流程（步骤化）

```
握手：computeAccept(key) = base64(sha1(key + WS_GUID))       L37
      isUpgradeRequest(req) 判断 Upgrade: websocket 头         L42
      handshakeResponse(accept) / rejectResponse(status,text)  L52 / L61

收（服务端方向）：
  decodeFrames(buffer) L123   按 7/16/64 位长度读帧；客户端帧必须带掩码 → 逐字节 XOR 解掩码
  createFrameParser() L169    把 TCP 分片拼成完整帧（每次到达的 chunk 可能只有半个帧头）
  createMessageAssembler(cb) L187  把 continuation 帧拼成完整消息（超限则断开）

发（客户端方向）：
  encodeFrame({opcode, payload, mask}) L82   需要掩码时生成 4 字节随机 key
  closeFrame(code, reason) L224             关闭帧
```

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `computeAccept(key)` | L37 | → 字符串 | `Sec-WebSocket-Accept` |
| `isUpgradeRequest(req)` | L42 | → boolean | 是否 WebSocket 升级请求 |
| `handshakeResponse(accept)` / `rejectResponse(status, text)` | L52 / L61 | → Buffer | 原始响应 |
| `encodeFrame({opcode, payload, mask, fin})` | L82 | → Buffer | 编码一帧 |
| `decodeFrames(buffer)` | L123 | → `{frames, rest}` | 解出完整帧 + 剩余字节 |
| `createFrameParser()` | L169 | → `{push(buf)}` | 增量解帧（TCP 流） |
| `createMessageAssembler(onMessage, {maxBytes})` | L187 | → `{push}` | 分片消息重组 |
| `closeFrame(code, reason)` | L224 | → Buffer | 关闭帧 |
| `WS_GUID` / `OPCODES` / `WS_LIMITS` | L20-L36 | 常量 | 协议常量 |

## 5. 与其它文件的关系

- 下游：`server/coach-proxy.mjs`（浏览器侧握手 + 帧编解码）、`server/volc-asr.mjs`
  （连火山时的客户端帧 + 响应解析）。
- 上游：只有 `node:crypto`（SHA-1）。

## 6. 易错点与设计取舍

- **方向决定掩码**：浏览器发来的帧**必须**有掩码（否则按协议应断开）；我们发往火山的帧
  必须自己加掩码。写反会得到「服务器收到了但解析出乱码」。
- `decodeFrames` 必须返回**剩余字节**：TCP 一个 chunk 常常刚好切在帧中间，丢掉就整条流错位。
- 长度 7 位 = 0~125；126 → 16 位；127 → 64 位。别把 126/127 当长度本身。
- 分片重组有 `maxBytes` 上限：否则恶意（或异常）对端能让进程 OOM。
- 不做 permessage-deflate：火山与浏览器都会先协商，我们回「不支持」，两端退回不压缩（可接受）。
- 所有编解码都是纯函数：测试直接拿 Buffer 对拍，不需要起服务。

## 7. 读代码建议（先看哪几行）

1. L17-L36 常量（opcode 与限制）；
2. L82-L122 `encodeFrame`（掩码与长度编码）；
3. L123-L186 `decodeFrames` / `createFrameParser`（增量解析，最容易出错的地方）；
4. L187-L229 `createMessageAssembler` + `closeFrame`。
