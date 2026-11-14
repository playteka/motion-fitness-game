# src/voice/llm.js — 前端 LLM 客户端 + Agent 上下文构建

> 层：语音（对话） ｜ 911 行 ｜ 纯逻辑 + 注入 fetch，Node 里可测
> 一句话：把一句话 + 当前训练状态发给同源的 `POST /llm`，拿回 `{reply, actions}`；密钥永远在服务端。

## 1. 它解决什么问题（为什么需要它）

自由对话需要「模型知道现在在练什么、做了几个、刚才发生了什么」。如果把这些散着传，
prompt 会越来越长、越来越贵。所以这里做两件事：
① 把界面状态压缩成**有上限**的 `context`（`buildAgentContext`）；
② 用一个薄客户端把请求发出去，并把失败压成稳定错误码（绝不弹到界面上）。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `LLM_PATH` / `LLM_HEALTH_PATH` | L24 / L25 | `/llm` `/llm/health` | 与服务端常量同值 |
| `LLM_EVENT_SESSION_START` / `END` | L31 / L38 | `session-start` / `session-end` | 自由文本事件 |
| `LLM_CLIENT_TIMEOUT_MS` | L44 | `9000` | 客户端超时（服务端 8s） |
| `LLM_HISTORY_TURNS` | L47 | `10` | 对话记忆轮数（只在内存） |
| `LLM_CLIENT_MAX_TEXT` | L50 | `500` | 单句上限 |
| `AGENT_CONTEXT_MAX_CHARS` | L67 | `6000` | 上下文总上限 |
| `AGENT_SUMMARY_MAX` / `HISTORY_MAX` / `KEYFRAMES_MAX` / `SIGNALS_MAX` / `COACH_LINES_MAX` | L65-L84 | `20 / 5 / 5 / 3 / 5` | 各区块条数上限 |
| `AGENT_EVENTS_MAX` / `WINDOW_MS` / `MAX_CHARS` | L86-L90 | `60` / `60s` / `60` | 最近事件（与总线同口径） |
| `AGENT_MEMORY_PREF_FIELDS` / `FACT_FIELDS` | L102-L105 | 白名单 | 只有这些字段能进 prompt |

## 3. 算法与流程（步骤化）

**上下文**（`buildAgentContext(snapshot)` L351）：

```
输入 snapshot（app.js 组装）：当前动作 / 目标 / 已完成 / 分数 / 关键帧 / 最近训练摘要 /
     lastSession / 本周趋势 / 记忆（prefs+facts）/ 教练最近 5 句 / 最近 60 秒事件
处理：
   timeOfDayHint(date, locale) L110        早上/晚上（问候用）
   weekTrend(entries, now) L172            本周 vs 上周（TREND_WEEK_SCORE_DELTA = 3）
   memoryForContext(memory) L212           只保留白名单字段
   normalizeRecentEvents(events,…) L233    按窗口/条数/字符裁剪
   trainingSummaryForContext / lastSessionForContext / pickKeyframes（各带上限）
   scoreTrend(entries) L329
→ trimAgentContext(context, {maxChars}) L475  最后按总字符数裁剪
```

**请求**（`createLlmClient()` L580）：`POST /llm {text, locale, context, history}` →
拿 `{reply, actions}` → `normalizeActions`（L554）把动作裁到 `VOICE_LLM_MAX_ACTIONS` 个 →
返回。失败映射成 `LLM_CLIENT_ERRORS`（L532）里的稳定 code，由 `app.js` 回退到罐头回复并记
`llm:fallback` 诊断。

**裁判 / 告别**：本文件复用 `judge.js` 的 `JUDGE_TIMEOUT_MS` / `isJudgeAskEvent` / `parseJudgeReply`
（L21），所以「严格 JSON + 默认沉默」的口径只有一份。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createLlmClient({fetch, win, diag})` | L580 | → llm | `.reply(text, {context, history})` / `.health()` |
| `buildAgentContext(snapshot)` | L351 | → 对象 | 压缩后的上下文 |
| `trimAgentContext(ctx, opts)` | L475 | → 对象 | 按字符上限裁剪 |
| `normalizeActions(actions)` | L554 | → 数组 | 动作白名单 + 条数上限 |
| `memoryForContext(memory)` | L212 | → 对象 | 只保留白名单字段 |
| `weekTrend` / `scoreTrend` / `shortStamp` / `timeOfDayHint` | L172 / L329 / L200 / L110 | 纯函数 | 趋势与时间 |
| `normalizeRecentEvents` / `trainingSummaryForContext` / `lastSessionForContext` | L233 / L265 / L280 | 纯函数 | 各区裁剪 |
| `LLM_CLIENT_ERRORS` / `llmClientError` | L532 / L546 | 常量 / 函数 | 稳定错误码 |

## 5. 与其它文件的关系

- 上游：`i18n.js`（`LOCALES`）、`voice/events.js`（`AGENT_EVENT_TYPES`）、
  `voice/judge.js`（裁判口径与 JSON 解析）。
- 下游：`app.js`（`createLlmClient` L490 + `buildAgentContext` 组上下文）、
  `server/llm-provider.mjs`（真正发请求、拼 prompt、调工具）。
- 与 `providers.js` 的 `createLlm`（本地罐头）是**降级关系**：LLM 客户端失败才用它。

## 6. 易错点与设计取舍

- **密钥永远不在这里**：只有同源 `/llm`；前端既没有也不该有 key。
- **上下文必须有上限**（`6000` 字符）：逐区块裁剪 + 最后整体裁剪；否则一局训练后 prompt 会爆。
- `actions` 的每一项都是命令表里的 `{intent, args}`，执行仍走 `COMMANDS[].run`（不另写一套）。
- 失败**不抛到界面**：`app.js` 回退罐头回复 + 记诊断；用户只会觉得「教练简短了一点」。
- 事件口径与 `events.js` 同源（`AGENT_EVENT_KINDS = AGENT_EVENT_TYPES`）：不要另抄一份。
- 记忆只传白名单字段：`facts` 带来源（用户原话），不应该整份塞进 prompt。

## 7. 读代码建议（先看哪几行）

1. L1-L22 头部（接缝与失败策略）；
2. L351-L475 `buildAgentContext` + `trimAgentContext`（上下文形状与上限）；
3. L580 起 `createLlmClient`（请求 / 超时 / 错误码）；
4. L532-L580 `LLM_CLIENT_ERRORS` + `normalizeActions`。
