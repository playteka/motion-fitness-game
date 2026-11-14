# src/voice/diag.js — 语音链路诊断（收集 / 脱敏 / 批量落盘 / 实时快照）

> 层：语音（可观测性） ｜ 636 行 ｜ 纯逻辑 + 可注入 fetch / timer，Node 里可测
> 一句话：把「麦克风亮着但没字幕」这种看不见的问题，变成 `logs/coach-diag.jsonl` 里能查的记录。

## 1. 它解决什么问题（为什么需要它）

健康检查 `GET /asr → configured:true` 是好的，问题只可能落在浏览器侧：权限 / 共享流 /
AudioWorklet / WebSocket / 帧格式 / 回退。用户看不见，远程也猜不到。所以要三件事：
① 关键事件记成小记录并批量上报；② 给界面一个实时快照；③ 上报失败**静默丢弃**，绝不拖垮训练。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `DIAG_FILE` | L25 | `coach-diag.jsonl` | 落盘文件名 |
| `DIAG_ENDPOINT` | L26 | `/__debug/log?file=…` | 复用预览服务器的落盘接口 |
| `DIAG_FLUSH_MS` / `DIAG_BATCH_SIZE` | L27 / L28 | `2000` / `20` | 批量节奏 |
| `DIAG_MAX_TEXT` | L29 | `80` | 文本截断（绝不记录整段对话） |
| `SECRET_KEY` | L35 | 正则 | 键名带 key/token/secret/audio/pcm/sample… → `[redacted]` |
| `blankSnapshot()` | L82 起 | 结构 | `route / ws / frames / partials / finals / mic / audio / worklet / tts` |

## 3. 算法与流程（步骤化）

```
record(type, data)                           // 所有模块都调它
  → scrubText 脱敏（sk-… / Bearer / 超长 token → [redacted]，L41）
  → safeValue 按 SECRET_KEY 把敏感键整条丢弃（L54）
  → makeEntry 组装 {t, type, …}（文本截到 80 字，L72）
  → 攒进 pending
  → 满 20 条 或 每 2 秒 → flush()：POST /__debug/log（失败静默，只记 failed 计数）
snapshot()  ← 界面 🐞 面板读它（实时结构，见 blankSnapshot）
```

上报内容只有**计数、状态、错误名/码、截断文本**；音频采样 / PCM / ArrayBuffer 一律丢弃。
值里的 `sk-…`、Bearer 头、超长 token 也会被替换（文件头 L16-L20）。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createDiag({fetch, timer, now, endpoint})` | L175 | → diag | `record / flush / snapshot / subscribe / close` |
| `diag.record(type, data)` | — | void | 记一条（唯一写入口） |
| `diag.snapshot()` | — | → 对象 | 实时结构（界面面板） |
| `diag.subscribe(fn)` / `close()` | — | → 取消 / void | 订阅变化 / 释放 |
| `diag.pending` / `sent` / `failed` | L630-L632 | getter | 队列与成功率 |
| `scrubText` / `safeValue` / `makeEntry` | L41 / L54 / L72 | 纯函数 | 脱敏与组装（测试直接用） |
| `EXPECTED_BYTES_PER_SEC` | L32 | 重导出 | 与 `pcm.js` 同源（判码率是否正常） |

## 5. 与其它文件的关系

- 上游：`voice/pcm.js`（`EXPECTED_BYTES_PER_SEC`）。
- 下游：`app.js`（`createDiag({timer:true})` L389，注入给 ASR / TTS / 自检 / 规则引擎 / 裁判）、
  `preview-server.js`（`/__debug/log` 写到 `logs/`，已 gitignore）。
- 与 `src/pose-log.js` 是两条独立通道（那个记关节数据），共用同一个落盘端点。

## 6. 易错点与设计取舍

- **不记录音频**：文件头 L16-L19 是硬约束；`SECRET_KEY` 正则里就有 `audio|pcm|sample`。
- 文本一律截到 80 字：诊断文件不该变成对话记录。
- 上报失败**静默**：`diag` 抛错会污染训练主流程，所有调用点都包了 try。
- 批量上报（2s / 20 条）：逐条 POST 会把 `preview-server` 压垮。
- `snapshot()` 是**结构稳定**的（`blankSnapshot` 就是契约）：界面按字段名读，改字段要同步改面板。
- 诊断也记「为什么没说」（`rule:skip` / `judge:skip`）——排查「教练不理我」时靠它。

## 7. 读代码建议（先看哪几行）

1. L1-L22 头部（三件事 + 安全约定）；
2. L82 起 `blankSnapshot`（界面能看到的全部字段）；
3. L41-L80 `scrubText` / `safeValue` / `makeEntry`（脱敏规则）；
4. L175 起 `createDiag` + L620-L633 返回的 API。
