# src/voice/commands.js — 命令表（intent + 中英说法 + `run(ctx, args)`）

> 层：语音（执行） ｜ 576 行 ｜ **唯一来源**：快车道 / LLM 工具 / 测试都读它
> 一句话：说一句「暂停」要做什么，全项目只有这里定义一次。

## 1. 它解决什么问题（为什么需要它）

同一条口令有三个消费者：正则快车道（`parse.js`）、LLM 工具调用（`server/llm-tools.mjs`）、
测试（遍历所有 intent 跑中英说法）。如果各写一套，行为必然分叉。所以这里一张表驱动三件事：
说法表在 `locales`、执行逻辑在本文件的 `run()`、工具映射在服务端按 intent 反查。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `COMMAND_CONFIRM_MS` | L39 | `8000` | 等「确认 / 取消」的上限 |
| `FAST_LANE_CLASSES` | L54-L61 | 6 类 | 用户口径的 6 类口令（帮助面板只列这 6 行） |
| `FAST_LANE_INTENTS` | L64-L66 | 7 个 | 上面 6 类展开（`pause` / `resume` 算两个） |
| `ZERO_LLM_INTENTS` | L76-L80 | 7 个 | `continueLast` + 口述规则三条 + **排课三条**（`makePlan` / `shufflePlan` / `startPlan`） |
| `PARSE_INTENTS` | L82 | 14 个 | `parseCommand()` 只在这 14 个里匹配 |
| `CONFIRM_WORDS` / `CANCEL_WORDS` | L111 / L112 | 数组 | 从 locales 的 `coach.confirmWords` / `cancelWords` 取 |
| `COMMANDS` | L156-L549 | 33 条 | 每条：`{intent, phrases, numeric?, confirm?, run(ctx,args)}` |
| 排课三条 | L367-L398 | `makePlan` / `shufflePlan` / `startPlan` | 只调 `ctx.makeTodayPlan` / `ctx.startTodayPlan` |
| `COMMAND_BY_INTENT` | L551 | 映射 | intent → 命令 |

## 3. 算法与流程（步骤化）

**快车道瘦身**（文件头 L20-L31，用户决定只留 6 类）：`run()` **一个都没删** —— 它们仍然给
LLM 工具调用用；变的只是「哪些 intent 参与正则匹配」：

```
FAST_LANE_CLASSES（6 类）→ FAST_LANE_INTENTS（7 个 intent）
   startWorkout / pause / resume / exit / mute / unmute / stopListening
ZERO_LLM_INTENTS（7 个）：
   continueLast / addRule / removeRule / listRules
   makePlan / shufflePlan / startPlan        ← 排课：模板是纯函数，断网 / 没配 LLM 也能用
PARSE_INTENTS = 7 + 7 = 14
其余 19 个 intent（home / menu / setTarget / setVoiceGender …）只经 LLM 工具调用
```

**执行**（`run(ctx, args)` L138 附近的 `command()` 包装）：
只调用注入的 `ctx` 里的函数（`ctx` 在 `app.js` 的 `voiceCommandCtx` L486 组装），
**自己不改任何 state**；返回值告诉会话层「怎么说」（`ack` 文案 / 是否需要确认）。

**确认机制**：`confirm: true` 的命令（目前没有实际使用，`exit` 已改成直接执行，L17）会由
`session.js` 的 `pendingConfirm` 等 `COMMAND_CONFIRM_MS` 再执行。

**排课三条的接缝**：`makePlan` / `shufflePlan` → `ctx.makeTodayPlan({llm})`；`startPlan` →
`ctx.startTodayPlan()`（从进度里那一组接着练）。计划本体 / 校验 / 执行队列全在
`src/voice/plan.js` 与 `app.js`，命令表只把结果翻成一句带数字的确认语。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `COMMANDS` | L156 | 数组 | 全部命令（测试遍历它） |
| `COMMAND_BY_INTENT` | L551 | 对象 | intent → 命令 |
| `commandHelpRows()` | L561 | → 行数组 | 帮助面板只列 6 类 |
| `FAST_LANE_CLASSES` / `FAST_LANE_INTENTS` / `ZERO_LLM_INTENTS` / `PARSE_INTENTS` | L54-L82 | 常量 | 快车道范围（`parse.js` 读） |
| `CONFIRM_WORDS` / `CANCEL_WORDS` | L111 / L112 | 数组 | 确认词 |
| `COMMAND_CONFIRM_MS` | L39 | `8000` | 确认超时 |

## 5. 与其它文件的关系

- 上游：`i18n.js`（`t` / `LOCALES` 说法表）、`catalog.js`（动作名）、`voice/rules.js`
  （`describeRule` 用于规则类命令的 ack 文案）。
- 下游：`voice/parse.js`（说法匹配）、`voice/session.js`（`runCommand` / `runActions`）、
  `app.js`（`voiceCommandCtx` + 帮助面板 + 排课入口）、`server/llm-tools.mjs`（`TOOL_INTENT_MAP`
  按 intent 反查；排课对应 `make_plan` / `start_plan` 两个工具）。
- 测试：`tests/test-voice.mjs` 遍历 `COMMANDS`，每条 intent 的中英说法至少跑一条。

## 6. 易错点与设计取舍

- **`run()` 不许碰 state**：它只能调 `ctx` 注入的函数。这样同一条命令既能被语音调、
  也能被 LLM 调，还能在测试里用假 `ctx` 跑。
- **文案不写在这里**：说法表 / 帮助 / 确认语都在 `locales` 的 `coach.*`（i18n 测试能查对称）。
- 新增 intent 时三处要同步：`COMMANDS` 加一条、`locales` 加说法、`llm-tools.mjs` 的工具
  `intents` 里加上（测试会核对「命令表每条 intent 都被工具覆盖」）。
- `exit` 是 `confirm: false`（用户要求「说退出就退出」）：别再给它加确认。
- 说法表偏「短句」：太长会与其他命令抢匹配，靠 `parse.js` 的最长匹配决胜负。
- 排课三条**故意放在零 LLM 组**：模板 / 校验 / 队列都是纯函数，断网也必须能「答得上、开得起来」；
  LLM 只是可选微调（微调结果必须过 `validatePlan`，不合法回退模板）。

## 7. 读代码建议（先看哪几行）

1. L1-L32 头部（三个消费者 + 快车道瘦身的原因）；
2. L54-L82 四个范围常量（理解「哪些能直接说」）；
3. L138-L170 `command()` 包装与两三条示例命令（看 `run` 怎么写）；
4. L367-L398 排课三条（看「命令只翻结果、不碰计划本体」）；
5. L551-L580 `COMMAND_BY_INTENT` / `commandHelpRows`。
