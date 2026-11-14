# server/coach-proxy.mjs — 本机 ASR 代理（浏览器 ↔ 火山之间的那一跳）

> 层：服务端（代理） ｜ 604 行 ｜ 两种跑法：**并入预览服务器**（默认）或独立进程
> 一句话：浏览器只知道同源的 `/asr`，凭证与握手头全部留在本机 Node 进程里。

## 1. 它解决什么问题（为什么需要它）

两件事浏览器做不到：
① 火山的握手头要带 APP ID / API Key（浏览器 `WebSocket` **不能自定义头**，且凭证不能进前端）；
② `webkitSpeechRecognition` 在国内连不上 Google（`error.network`）。
所以由本机进程拿 `coach.env` 的凭证去连火山，浏览器只说同源的 `/asr`。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `BIND_HOST` / `DEFAULT_PORT` | L47 / L48 | `127.0.0.1` / `4180` | 独立进程只绑本机 |
| `ASR_PATH` | L49 | `/asr` | WebSocket 路径 |
| `CLOSE_CODE_CONFIG` | L55 | `4401` | 缺凭证的关闭码（前端可识别） |
| `MAX_CLIENT_MESSAGE` | L58 | `1 MiB` | 客户端消息上限 |
| `FINAL_GRACE_MS` | L60 | `3000` | 断开前等 final 的宽限 |
| `FINAL_THROTTLE_MS` | L62 | `300` | final 节流（与协议层同值） |

**控制消息**（L26-L29）：收 `{type:'start', lang}` / `{type:'stop'}`；
发 `{type:'ready'}` / `{type:'partial', text}` / `{type:'final', text}` / `{type:'error', code, message}`。

## 3. 算法与流程（步骤化）

```
浏览器 WS 升级 → handleAsrUpgrade(req, socket, head, …) L440
  → computeAccept 握手（ws-mini）→ 建 volc 会话
  → attachClient(socket, …) L90：
      收 start → 开火山会话（buildAuthHeaders）
      收二进制音频帧 → 转给火山（buildAudioFrame）
      火山 partial/final → 转成 {type,text} JSON 帧发回浏览器（final 节流 300ms）
      收 stop → 发最后一包 → 等 final（≤3s）→ 关闭
  缺凭证 → 握手照常完成 → error 帧 {code:'config'} → 关闭码 4401（不崩）
```

`createAsrUpgradeHandler({...})` L489 是给 `preview-server.js` 用的薄封装；
`createCoachProxy({config, logger})` L518 起独立进程的 HTTP 服务器；`main()` L558 是 CLI 入口。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createAsrUpgradeHandler({logger, config, …})` | L489 | → `(req, socket, head)` | 挂到现有 HTTP server 的 `upgrade` 事件 |
| `handleAsrUpgrade(req, socket, head, …)` | L440 | void | 单次升级处理 |
| `createCoachProxy({config, logger, envPath})` | L518 | → server | 独立进程模式 |
| `loadAsrConfig({envPath, env})` | L407 | → `{config, missing}` | 读 coach.env |
| `createLogger({sink, file})` | L73 | → logger | 只在内存 / 终端（`COACH_LOG=1` 才写临时目录） |
| `main()` | L558 | void | CLI（`npm run coach-proxy`） |
| `ASR_PATH` / `BIND_HOST` / `DEFAULT_PORT` / `CLOSE_CODE_CONFIG` / `FINAL_*` | L47-L62 | 常量 | `preview-server.js` 复用 |

## 5. 与其它文件的关系

- 上游：`server/env.mjs`（读凭证 / 脱敏）、`server/ws-mini.mjs`（帧）、
  `server/volc-asr.mjs`（会话）、`server/volc-protocol.mjs`（`VOLC_DEFAULTS`）。
- 下游：`preview-server.js`（`createAsrUpgradeHandler` + `ASR_PATH`）、
  `src/voice/providers.js`（前端选路 `ws(s)://<host>/asr`）。
- 排障：`server/asr-probe.mjs`（不走浏览器直接测这条链路）。

## 6. 易错点与设计取舍

- **只绑 127.0.0.1**（独立进程）：局域网不该能连到带凭证的代理。
- **缺凭证不崩**（L24）：握手完成 → error 帧 → 4401；否则前端看到的是「连不上」而不是
  「没配置」，用户无法自救。
- 错误信息一律过 `sanitizeDetail`：防止底层把 Key 回显到浏览器 / 日志。
- 独立进程与并入模式是**同一份逻辑**：不要为两种跑法写两套转发。
- `FINAL_GRACE_MS` 是断开前的等待：直接断会丢最后一两个词（用户会觉得「识别少字」）。
- 日志默认只进内存 / 终端：要落文件用 `COACH_LOG=1`（写系统临时目录，不进仓库）。

## 7. 读代码建议（先看哪几行）

1. L1-L30 头部（两种跑法 + 控制消息）；
2. L90-L236 `attachClient`（转发与节流的全部逻辑）；
3. L407-L440 `loadAsrConfig` + 缺字段分支；
4. L489-L518 `createAsrUpgradeHandler`（预览服务器怎么挂它）。
