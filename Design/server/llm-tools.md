# server/llm-tools.mjs — LLM 工具集（与命令表 1:1）+ system prompt

> 层：服务端（工具） ｜ 914 行 ｜ 工具定义是数据，执行永远在前端
> 一句话：模型能「做什么」由这里声明；真正动手仍然是 `src/voice/commands.js` 的 `run()`。

## 1. 它解决什么问题（为什么需要它）

模型要能「开始深蹲 / 设成 20 次 / 换个男声」，就必须有 function calling 的工具定义。
但工具不能另造一套执行逻辑 —— 否则语音快车道与模型会做出不一致的行为。所以：
工具只把参数翻译成 `{intent, args}`，执行交给前端命令表。**intent 只有一处定义**
（`COMMANDS`），本文件的 `TOOLED_INTENTS` / `UNCOVERED_INTENTS` 是**现算**的（测试会核对）。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `NAV_DESTS` | L36 | `home/menu/back/next/prev` | 导航参数枚举 |
| `PANEL_WHICH` | L37 | `settings/records/best/exerciseSettings` | 面板枚举 |
| `CATEGORY_IDS` / `LANGS` | L38 / L39 | 5 类 / `zh,en` | 与 `catalog.js` / `i18n.js` 一致 |
| `RULE_KINDS` | L41 | `RULE_CHANNELS` | 与 `rules.js` 同源 |
| `EXERCISE_IDS` | L44 | `EXERCISES.map(id)` | 与 `catalog.js` 同源 |
| `MAX_TOOL_CALLS` | L79 | `3` | 一次回答最多执行几个动作（前端同值） |
| `DEFAULT_SOUL_PATH` / `SOUL_MAX_CHARS` | L97 / L100 | `SOUL.md` / `12000` | 人设文件 |
| `FALLBACK_SOUL` | L103 | 字符串 | 读不到 SOUL.md 时的兜底人设 |
| `LLM_TOOL_DEFS` | L198-L550 | **15 个工具** | 中英描述 + JSON Schema |
| `TOOL_INTENT_MAP` | L556 | intent → 工具 | 现算 |
| `UNCOVERED_INTENTS` / `UNKNOWN_TOOLED_INTENTS` | L566 / L571 | 数组 | 覆盖性自检（测试读） |

## 3. 算法与流程（步骤化）

```
模型回 tool_calls
 → actionsFromToolCalls(toolCalls, {locale}) L632
     按 TOOL_BY_NAME 找工具 → 依 schema 校验参数 → 翻成 {intent, args}
     未知工具 / 参数不合法 → 丢弃（EMPTY_REPLY / ACTION_REPLY）
 → 前端 session.runActions() → COMMANDS[].run(ctx, args)（同一批 handler）
```

**system prompt**（`buildSystemPrompt({locale, context, event})` L700）：
`SOUL.md`（人设 / 红线，`readSoul` L151 带缓存与长度上限）+
工具使用规则 + **紧凑 context**（`compactContext` L679，上限 6000 字符）+ 事件提示。
改「模型怎么说话」改这里与 `SOUL.md`，不要在代码里写死话术。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `LLM_TOOL_DEFS` / `LLM_TOOLS` | L198 / L577 | 数组 | 15 个工具定义（OpenAI 风格） |
| `buildSystemPrompt({locale, context, maxContextChars, event})` | L700 | → 字符串 | system prompt |
| `actionsFromToolCalls(toolCalls, {locale})` | L632 | → `{actions, …}` | 工具调用 → 动作 |
| `resolveExerciseId(value)` | L607 | → id \| null | 动作名 / 别名 → id |
| `compactContext(context, {maxChars})` | L679 | → 对象 | 上下文压缩 |
| `readSoul()` / `loadSoulText(file, opts)` / `resetSoulCache()` | L151 / L125 / L160 | → 字符串 | 人设 |
| `TOOL_INTENT_MAP` / `TOOLED_INTENTS` / `UNCOVERED_INTENTS` / `UNKNOWN_TOOLED_INTENTS` | L556-L576 | 常量 | 覆盖率自检（测试用） |
| `toolHelpRows()` | L587 | → 行数组 | 「你能做什么」 |
| `ACTION_REPLY` / `EMPTY_REPLY` | L165 / L171 | 常量 | 标准回复形状 |

## 5. 与其它文件的关系

- 上游：`src/voice/commands.js`（`COMMANDS`）、`src/voice/rules.js`（`RULE_CHANNELS`）、
  `src/catalog.js`（`EXERCISES`）、`src/voice/judge.js`（`JUDGE_EVENTS`）、
  `server/memory-store.mjs`（`PREFS_FIELDS` / `FACTS_FIELDS` 白名单）、`SOUL.md`（人设文件）。
- 下游：`server/llm-provider.mjs`（工具定义 / prompt / 动作转换）、`tests/test-voice.mjs`
  （覆盖性断言：命令表每条 intent 必须被某个工具覆盖）。
- 注意：服务端 **import `src/` 的模块**（同构复用），所以 `src/` 里不能有浏览器全局的顶层副作用。

## 6. 易错点与设计取舍

- **不要在工具里写业务逻辑**：只翻译参数。执行越界就会与语音快车道分叉。
- 新增命令时三处同步：`COMMANDS` / 工具 `intents` / `PARAM` 枚举；`UNCOVERED_INTENTS`
  会立刻在测试里报出来。
- `SOUL.md` 是数据不是代码：改人设不需要重启（`resetSoulCache` 可清缓存，但默认有缓存）。
- `MAX_TOOL_CALLS = 3` 与前端 `VOICE_LLM_MAX_ACTIONS = 3` 必须同值：模型偶尔一口气调一堆工具。
- 工具描述要写中英两份（既给模型看，也用于帮助面板）。
- `exit_workout` 不再要求 `confirm`（用户要求「说退出就退出」）：旧的确认兜底话术已删除。

## 7. 读代码建议（先看哪几行）

1. L1-L34 头部（四条设计约束，改之前必读）；
2. L198-L240 `LLM_TOOL_DEFS` 前两个工具（看清 schema 写法）；
3. L551-L590 映射与覆盖率自检；
4. L632-L720 `actionsFromToolCalls` + `buildSystemPrompt`。
