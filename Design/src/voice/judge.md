# src/voice/judge.js — LLM 当裁判：事件触发，由模型决定「要不要说一句」

> 层：语音（决策） ｜ 671 行 ｜ 前端逻辑 + 触发口径（服务端也 import 本文件）
> 一句话：跟规则快车道相反 —— 那边确定性、这边问模型；但**默认闭嘴**，且护栏一条不少。

## 1. 它解决什么问题（为什么需要它）

规则能处理「报数 / 读秒」这类确定性的话，但「这组做得比上组差，要不要说？」只有模型能判断。
代价是延迟（1~2s）与费用，所以它必须**稀缺**：只在 8 个触发点问，问完默认 `null`（不说话）。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `JUDGE_EVENTS` | L42-L66 | 10 个 | 事件口径**唯一来源**（前端 / 服务端 / 测试都读它） |
| `JUDGE_ASK_EVENTS` | L69-L71 | 8 个 | 走裁判模式（严格 JSON） |
| `JUDGE_FAREWELL_EVENTS` | L74 | `['session-end']` | 走告别模式（自由文本，必须说） |
| `JUDGE_TIMEOUT_MS` | L96 | `8000` | 超时即静默，**不重试** |
| `JUDGE_COOLDOWN_MS` | L98 | `8000` | 同一触发的最小间隔 |
| `JUDGE_DEDUPE_MS` | L100 | `15000` | 同一句话的最短重复间隔 |
| `JUDGE_MAX_CHARS` | L102 | `40` | 一句最多 40 字 |
| `FAREWELL_MAX_CHARS` / `SENTENCES` | L109 / L110 | `60` / `2` | 告别 ≤2 句、≤60 字 |
| `REP_JUDGE_EVERY` / `HOLD_JUDGE_EVERY_SEC` | L113 / L115 | `3` / `10` | 每 3 个 / 每 10 秒 |
| `IDLE_*` / `OUT_OF_FRAME_*` | L117-L121 | 10s 起、每 10s | 静止 / 出画 |
| `GATE_FAIL_JUDGE_STREAK` / `KEYFRAME_MISS_JUDGE_STREAK` | L123 / L124 | `2` | 连续 2 次才问 |
| `JUDGE_PRIORITY` | L130-L148 | `session-end 120 / pr 100 / gate 80 / set-complete 60 …` | 并发 1 时谁能抢占 |

## 3. 算法与流程（步骤化）

```
① 触发判定（本文件上半部分，纯函数）：
     shouldJudgeRep(reps, every) L159 / shouldJudgeHold(sec, every) L166 /
     shouldJudgeIdle(...) L173 / shouldJudgeOutOfFrame(...) L184
     judgePriority(event) L149 决定「新触发能否抢占旧的」
② 发 POST /llm {event, context}（服务端按 event 生成 user 消息，见 llm-provider.mjs）
③ 模型只回**严格 JSON**：{"speak": string|null, "actions": [...]?}
     extractJsonObject L273 → parseJudgeReply L311 → normalizeJudgeObject L330
④ 护栏（下半部分 + createJudge L420）：
     并发 1（新触发取消旧请求，旧结果回来直接丢）
     冷却 8s / 同文本 15s / 教练正在说话时丢弃
     8s 超时 → 静默、不重试；LLM 失败 → 门控那条回退 R1 模板口令，其余静默
⑤ 真要说话 → 交给 app.js 现有的 voice.onCoachText()（弹幕 + TTS + 降级同一条路）
⑥ 诊断：judge:ask {event, ok, ms, spoke} / judge:skip {reason}
```

**两种自由文本事件**不走裁判模式（文件头 L26-L29）：`session-start`（进场问候）与
`session-end`（告别，≤2 句：肯定 + 具体数字 + 「明天见 / 动起来」；失败时用 locales 内置告别语兜底）。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createJudge({llm, diag, speak, …})` | L420 | → judge | `.ask(event, extra)` / `.status()` |
| `JUDGE_EVENTS` / `isJudgeEvent` / `isJudgeAskEvent` / `isJudgeFarewellEvent` | L42-L89 | 常量 / 纯函数 | 事件口径 |
| `judgePriority(event)` | L149 | → 数 | 抢占判断 |
| `shouldJudgeRep` / `shouldJudgeHold` / `shouldJudgeIdle` / `shouldJudgeOutOfFrame` | L159-L195 | → boolean | 触发节奏 |
| `clampJudgeSpeak` / `clampFarewellSpeak` | L205 / L235 | → 字符串 | 长度 / 句数裁剪 |
| `parseJudgeReply` / `normalizeJudgeObject` / `extractJsonObject` | L311 / L330 / L273 | 纯函数 | 严格 JSON 解析（非法即静默） |
| `parseGateDiagRow` / `worstGateCheck` | L368 / L394 | → 对象 | 门控失败时「差多少」的证据 |
| 常量组 | L96-L148 | 常量 | 服务端与测试共用 |

## 5. 与其它文件的关系

- 上游：`voice/llm.js`（实际发请求的客户端，`parseJudgeReply` 也在那边被复用）、`i18n` 经调用方。
- 下游：`app.js`（`createJudge` L839 + 各个 `judge*Tick` 函数把事件喂进来）、
  `server/llm-provider.mjs`（import `JUDGE_EVENTS` / `isJudgeAskEvent` / `isJudgeFarewellEvent`）、
  `server/llm-tools.mjs`（`JUDGE_EVENT_TYPES`）。
- 与 `rules.js` 并列：确定性的话走规则，需要判断的走裁判；两者最终都调 `voice.onCoachText`。

## 6. 易错点与设计取舍

- **默认闭嘴**（L17）：`null`、空文本、JSON 不合法 → 一律不出声。改这里会让教练突然话多。
- **没有「每分钟 / 每场上限」**（L16，用户明确要求不要）：靠触发频率本身控制，别偷偷加。
- 并发 1 + 新触发取消旧的（L18）：否则同一秒两个回答会叠在一起。
- 告别优先级最高（L131-L136）：它是「这场训练的最后一句话」，之后一句都不许再说。
- 本文件字符串一律英文（L31-L32）：`test-i18n` 会扫 `src/` 下的中文字面量；给用户看的文案
  只能来自 locales 或模型。
- 服务端也 import 本文件：**改事件口径 = 改协议**，两端会一起变（这是有意设计）。

## 7. 读代码建议（先看哪几行）

1. L35-L90 事件口径（哪些走裁判、哪些走自由文本）；
2. L96-L148 全部数字与优先级；
3. L311-L367 严格 JSON 解析（静默优先的实现）；
4. L420 起 `createJudge`（并发 1 / 冷却 / 去重 / 超时的实际代码）。
