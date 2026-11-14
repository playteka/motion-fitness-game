# preview-server.js — 零依赖本地预览服务器（页面 + 所有本机代理 + 日志落盘）

> 层：服务端（入口） ｜ 745 行 ｜ 一个进程同时提供页面、`/asr`、`/tts`、`/llm`、`/memory`
> 一句话：`node preview-server.js` 之后，浏览器只要打开 `http://127.0.0.1:4174`。

## 1. 它解决什么问题（为什么需要它）

`file://` 拿不到摄像头与 wasm；语音链路需要一个**本机进程**持有凭证（浏览器不能设握手头）；
调试数据需要一个能写文件的落点。历史上语音代理是独立进程（`node server/coach-proxy.mjs`），
用户经常忘了起 → 前端连不上 → 回退 Web Speech → 国内连不上 Google。现在**并入一个进程**。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `PORT` | L59 | `process.env.PORT` 或 `4174` | 端口 |
| `ROOT` | L60 | 仓库根 | 静态资源根（越界返回 403） |
| `MIME` | L70 | 映射表 | 扩展名 → Content-Type（含 `.webmanifest` / wasm） |
| gzip 缓存 | L433 前 | 按 `mtime:size` 缓存 | 9.3MB wasm → 约 3MB |
| `HOST` | L628 | `127.0.0.1`（默认） | `0.0.0.0` 才给局域网（手机） |
| `HTTPS_ON` / `PROTO` | L629 | 环境变量 | `HTTPS=1` 用 `tools/make-cert.ps1` 的自签证书 |

## 3. 算法与流程（步骤化）

**HTTP（`previewHandler`）**：

```
POST /__debug/log?file=xxx.jsonl   → 追加写 logs/（文件名白名单 ^[A-Za-z0-9._-]+\.jsonl$，L498）
GET  /__debug/logs                 → 列出 logs/*.jsonl（大小 / mtime）
POST /__probe                      → 写 _probe/last.json（无头浏览器自检用，L534）
GET  /asr                          → 体检：{configured, missing}（真正的识别走 upgrade）
GET  /pose-check                   → 报 wasm / 模型的原始与 gzip 后字节数（L576）
GET  /tts、/tts/stream、/tts/health → 交给 server/volc-tts.mjs 的路由
GET  /llm、/llm/health             → 交给 server/llm-provider.mjs 的路由
GET|POST /memory、/memory/forget   → handleMemoryRoute(L241) → memory-store
其它                               → serveStatic(L433)（gzip + 无越界）
```

**WebSocket 升级**（L687-L691）：`server.on('upgrade', createAsrUpgradeHandler({…}))` ——
`/asr` 交给 `coach-proxy.mjs` 的同一份逻辑（缺凭证 → error 帧 + 4401，不崩），其它路径直接断开。

**启动**（`startServer` L652）：HTTPS 证书读不到时给出明确重生成命令；`EADDRINUSE` 提示换端口；
监听后打印中英双语地址、三条链路（ASR / TTS / LLM）的「配没配」状态、局域网地址（`HOST=0.0.0.0`）。

## 4. 对外接口

| 导出 | 位置 | 说明 |
|---|---|---|
| `previewHandler(req, res)` | 文件上方 | HTTP 处理函数（测试可 import，不起端口） |
| `handleMemoryRoute(req, res)` | L241 | `/memory*` 三四个端点 |
| `startServer()` | L652 | 真正 listen（只在 `node preview-server.js` 时调用，L745） |

## 5. 与其它文件的关系

- 上游：`server/coach-proxy.mjs`（ASR）、`server/volc-tts.mjs`（TTS）、
  `server/llm-provider.mjs`（LLM）、`server/memory-store.mjs`（记忆）。
- 下游：`index.html` + `src/*`（静态资源）、`src/voice/diag.js` 与 `src/pose-log.js`
  （都往 `/__debug/log` 写）、`src/voice/providers.js`（`/asr` 选路）、`src/voice/tts-volc.js`（`/tts`）。
- `AGENTS.md` 要求：改完代码要**重启这个服务**并验证 `HTTP 200`。

## 6. 易错点与设计取舍

- **`HOST` 默认只回环**：安全；要让手机访问必须显式 `0.0.0.0`，且摄像头还要求 HTTPS
  （secure context 规则，不是本项目的限制）。
- **静态路径必须防越界**：`path.normalize` 后检查 `startsWith(ROOT)`（L608-L613）。
- **日志文件名白名单**：`/__debug/log` 只接受 `xxx.jsonl`，防止写到任意路径。
- gzip 缓存按 `mtime:size` 失效：改文件立刻生效，不用手动清缓存。
- 语音代理**并入**而不是独立进程：少一个「忘了起」的故障点；独立模式仍保留给排障。
- 打印启动日志时**只报配没配 / 模型名**，绝不打印 key（L700-L714 的注释写明了）。

## 7. 读代码建议（先看哪几行）

1. L1-L60 头部（为什么要它、环境变量）；
2. L480-L530 `/__debug/log` + `/__debug/logs`（日志落盘的白名单）；
3. L549-L596 `/asr` 体检与 `/pose-check`（排障入口）；
4. L652-L745 `startServer`（HTTPS / upgrade / 启动日志）。
