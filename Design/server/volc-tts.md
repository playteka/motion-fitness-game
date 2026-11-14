# server/volc-tts.mjs — 火山语音合成服务端代理 + 内存缓存

> 层：服务端（TTS） ｜ 998 行 ｜ 对外只有 `/tts`、`/tts/stream`、`/tts/health`
> 一句话：把上游的 NDJSON 信封拆成**真音频字节**，带 LRU 缓存与 3 秒超时。

## 1. 它解决什么问题（为什么需要它）

火山 TTS 返回的**不是**裸 MP3，而是 NDJSON 信封（`{"code":0,"data":"<base64 MP3>"}`）或流式分块。
前端解码器拿到信封只会报「解码失败」。同时同一句话会被反复念（报数 / 提示），
每次重新合成既慢又花钱 —— 所以服务端做一层「拆信封 + 缓存 + 超时」。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `TTS_PATH` / `TTS_HEALTH_PATH` / `TTS_STREAM_PATH` | L28 / L29 / L34 | `/tts` / `/tts/health` / `/tts/stream` | 路由 |
| `TTS_ENDPOINT` | L36 | `https://openspeech.bytedance.com/api/v3/tts/unidirectional` | 上游 |
| `TTS_RESOURCE` | L37 | `volc.seedtts.default` | 资源 id |
| `TTS_TIMEOUT_MS` | L38 | `3000` | 整段合成超时（超时 → 502） |
| `TTS_STREAM_FIRST_MS` / `MAX_MS` | L40 / L42 | `3000` / `20000` | 流式首包 / 总上限 |
| `TTS_CACHE_MAX_ENTRIES` / `BYTES` | L43 / L44 | `200` / `20MB` | LRU 上限 |
| `TTS_MAX_TEXT` / `RATE_MIN/MAX` | L45-L47 | `300` / `0.5~2` | 入参校验 |
| `COACH_VOICES` | L71 | 音色表 | 男女声（与前端 `TTS_GENDERS` 对应） |
| `VOLC_TTS_CODE_AUDIO` / `DONE` | L275 / L277 | `0` / `20000000` | 信封里的「有音频」/「结束」码 |

## 3. 算法与流程（步骤化）

```
POST /tts {text, rate}
  ① 校验：text ≤300 字、rate 夹 [0.5,2]、voice 归一化（resolveCoachVoice L90）
  ② 缓存：key = `voice|rate|text`（ttsCacheKey L201）→ 命中直接回音频（LRU，ttsCache*）
  ③ 上游：POST TTS_ENDPOINT（头 X-Api-App-Id / X-Api-Key / X-Api-Resource-Id / Request-Id）
  ④ 拆信封：createVolcMessageParser L280 → 逐条 NDJSON →
        unwrapVolcAudio L389（base64 → 真音频字节；firstMeaningfulByte L372 判是不是 MP3）
        code=0 → 音频；code=20000000 → 结束；其它 → 错误
  ⑤ 回：audio/mpeg；失败 / 超时 → 502 + 简短 JSON（回退系统 TTS 是客户端的事）

POST /tts/stream：边收边转发（不缓存），首包超时 3s、总上限 20s
GET  /tts/health → {configured, missing?}（**不泄露值**）
```

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createTtsRoutes({service, logger})` | L810 | → 路由处理函数表 | 挂到 `preview-server` |
| `createVolcTts({...})` | L423 | → service | 合成 + 缓存（可注入 fetch） |
| `loadTtsConfig({envPath, env})` | L117 | → 配置 | 缺字段 → `configured:false` |
| `createTtsCache({maxEntries, maxBytes})` | L149 | → cache | LRU |
| `createVolcMessageParser()` / `unwrapVolcAudio(raw)` | L280 / L389 | 纯函数 | 拆信封（**关键**） |
| `volcAudioBytes` / `isVolcErrorCode` | L355 / L366 | 纯函数 | 判定 |
| `resolveCoachVoice({gender, voice})` / `normalizeRate` | L90 / L50 | 纯函数 | 入参归一 |
| `TTS_*` / `COACH_VOICES` | L28-L76 | 常量 | 前端同名常量与它对应 |

## 5. 与其它文件的关系

- 上游：`server/env.mjs`（`loadEnvFile`）。
- 下游：`preview-server.js`（`createTtsRoutes` + 三个路径常量）、
  `src/voice/tts-volc.js`（前端播放层，三级降级的第一级就是 `/tts/stream`）。
- 排障：`server/tts-probe.mjs`（直接试资源 id / 音色组合）。

## 6. 易错点与设计取舍

- **信封拆解是这里最容易被写错的一行**：曾经把 base64 信封当 MP3 转发，导致「火山确实被调用
  但两端都解码失败」（前端日志里是 `tts:first-audio` 之后 `tts:fail code:"audio"`）。
- 缓存 key 必须含 `voice|rate|text` 三者：少一个就会「换了音色还是旧声音」。
- 超时 3s：宁可回退系统 TTS，也不要让用户等 10 秒还没声音。
- **绝不打印 / 返回密钥**：日志只有 `chars / cache / status`。
- `/tts/stream` 不缓存：流式内容按块转发，缓存它既占内存又用不上。
- 上游错误码要判「是不是错误码」而不是「非 0 就是错」（`isVolcErrorCode` L366 有白名单）。

## 7. 读代码建议（先看哪几行）

1. L1-L20 头部（为什么会有「信封」这个问题）；
2. L280-L422 `createVolcMessageParser` / `unwrapVolcAudio`（核心解析）；
3. L423 起 `createVolcTts`（缓存 + 上游请求 + 超时）；
4. L810 起 `createTtsRoutes`（三个端点的入参校验与返回码）。
