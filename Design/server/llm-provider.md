# server/llm-provider.mjs — 服务端 LLM 适配层（三家 provider + 护栏 + `/llm` 路由）

> 层：服务端（大脑） ｜ 1272 行 ｜ 零依赖（只用 fetch）
> 一句话：`POST /llm` 一句话进、一句话出；密钥、限流、超时、工具调用全在服务端。

## 1. 它解决什么问题（为什么需要它）

前端不能有 key，而且不同厂商的报文形状不同（DeepSeek / 火山方舟 / OpenAI 兼容）。
更麻烦的是「按 event 生成 user 消息」：裁判（`judge`）、告别（`session-end`）、
排课（`plan-request`）都不该让前端拼 prompt。
所以这里统一：**provider 适配 + 按事件拼消息 + 护栏（限流 / 超时 / 体积）+ 工具调用落地**。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `LLM_PATH` / `LLM_HEALTH_PATH` | L58 / L59 | `/llm` / `/llm/health` | 路由（前端同值） |
| `LLM_TIMEOUT_MS` | L62 | `8000` | 上游超时 → `llm-timeout` |
| `LLM_MAX_TOKENS` | L63 | `400` | 单次上限 |
| `LLM_RATE_LIMIT` / `WINDOW_MS` | L64 / L65 | `20` / `60s` | 每分钟 20 次 |
| `LLM_MAX_BODY` / `MAX_TEXT` | L67 / L69 | `64KB` / `500` | 入参上限 |
| `LLM_MAX_HISTORY_TURNS` / `MAX_CONTEXT_CHARS` | L71 / L73 | `6` / `6000` | prompt 长度护栏 |
| `LLM_PROVIDER_SPECS` | L83-L109 | 三家 + mock | 端点 / 默认模型 / key 来源 |
| `LLM_PROVIDERS` | L110 | 名字数组 | `deepseek / volc / openai / mock` |

## 3. 算法与流程（步骤化）

```
POST /llm {text, locale, context, history?, event?}
① createLlmGuard：限流（每分钟 20）→ 体积 / 文本上限 → 429 / 413 / 400
② 拼消息：
     event=session-start → sessionStartEventMessage(L511)
     event=judge 系列    → judgeEventMessage(L566)
     event=session-end   → sessionEndEventMessage(L702)
     event=plan-request  → planRequestEventMessage(L797)（排课：{goal,minutes,gear,injuries,recent,template}）
     否则 → historyMessages(L485)（最近 6 轮）
     system prompt 来自 llm-tools.buildSystemPrompt（含 SOUL 人设 + 记忆注入 + 第 19 条排课规则）
③ createLlmProvider.call：fetch 上游（超时 8s，错误正文过 redactSecrets）
     模型回 tool_calls → actionsFromToolCalls 翻成 {intent, args}
     记忆类工具 → applyMemoryOps(store, userId, ops)（L869）真写 MD
④ 回 {reply, actions, usage}；失败 → 稳定错误码（llm-timeout / llm-rate / llm-upstream…）
   judge / session-end / plan-request 三类是**无状态事件**：不带历史、不执行工具、
   **原样回文本**（解析与安全判定在客户端：judge.js / app.js + plan.js）
GET /llm/health → {configured, provider, model}（**绝不含 key**；累计 tokens 只在内存）
```

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createLlmRoutes({provider, guard, …})` | L909 | → 路由表 | 挂到 `preview-server` |
| `createLlmProvider({config, …})` | L260 | → provider | `.call(messages, opts)` |
| `createMockLlmProvider({script})` | L410 | → provider | 测试 / 演示（不联网） |
| `createLlmGuard({...})` | L195 | → guard | 限流 / 体积 / 文本校验 |
| `loadLlmConfig({envPath, env})` | L148 | → 配置 | provider / model / key 来源 |
| `inferProvider` / `normalizeProviderName` / `providerApiKey` | L132 / L113 / L122 | 纯函数 | 配置推断 |
| `historyMessages` / `sessionStartEventMessage` / `judgeEventMessage` / `sessionEndEventMessage` / `planRequestEventMessage` | L485 / L511 / L566 / L702 / L797 | → messages | 消息构造（测试直接断言） |
| `applyMemoryOps(store, userId, ops)` | L869 | → 结果 | 记忆工具落地 |
| `llmError` / `llmHttpCode` | L177 / L185 | 纯函数 | 错误码 ↔ HTTP |

## 5. 与其它文件的关系

- 上游：`server/env.mjs`（`loadEnvFile` / `redactSecrets`）、`server/llm-tools.mjs`
  （工具定义 / system prompt / 动作转换）、`server/memory-store.mjs`（记忆读写）、
  `src/voice/judge.js`（事件口径，**服务端也 import 它**）、
  `src/voice/plan.js`（排课边界常量 / 禁忌表，prompt 里直接用）。
- 下游：`preview-server.js`（`createLlmRoutes` + 两个路径常量）、
  `src/voice/llm.js`（前端客户端，只认 `/llm`）。
- 测试：`tests/test-voice.mjs` 用 `createMockLlmProvider` 跑完整对话 / 裁判 / 告别 / 排课事件。

## 6. 易错点与设计取舍

- **`/llm/health` 只报「配没配 / 谁 / 哪个模型」**：泄露 key 是最严重的事故。
- 限流是**内存计数**（重启清零）：够用且简单，不要引 Redis。
- 超时 8s 与前端 9s 的关系：服务端先超时（能给出稳定错误码），前端才不会干等。
- 事件消息由服务端生成（`judgeEventMessage` / `planRequestEventMessage` 等）：prompt 只在这一处，前端不拼。
- 工具调用**不执行**任何界面动作：只翻译成 `{intent,args}`，执行在前端命令表。
- 记忆写入要过 `memory-store` 的白名单与路径校验：不要在这里自己拼文件路径。
- **排课模式不执行工具、不写记忆**：模型只回 JSON 计划；合法性由客户端 `validatePlan`
  把关（不合法回退模板），服务端不做安全判定。

## 7. 读代码建议（先看哪几行）

1. L1-L28 头部（三家 provider + 护栏口径）；
2. L83-L148 `LLM_PROVIDER_SPECS` + `loadLlmConfig`（配哪些环境变量）；
3. L195-L260 `createLlmGuard`（限流 / 体积）；
4. L566-L815 `judgeEventMessage` / `sessionEndEventMessage` / `planRequestEventMessage`；
5. L909 起 `createLlmRoutes`（端点、事件分流、错误码）。
