# src/voice/parse.js — 一句话 → `{ intent, args }`（命令快车道的解析器）

> 层：语音（理解） ｜ 537 行 ｜ **纯函数**，不碰 DOM、不改 state
> 一句话：把「每十个报一次数」变成 `{intent:'addRule', args:{every:10}}`，命中不了就老实说 `unknown`。

## 1. 它解决什么问题（为什么需要它）

有些口令必须**零延迟、零成本、断网可用**（暂停 / 继续 / 退出 / 静音 / 报数间隔 / 读秒间隔）。
交给 LLM 会有 1~2 秒延迟且要联网。所以用「归一化 + 抽槽位 + 说法表最长匹配」本机解析，
覆盖 6 类核心口令 + 4 个零 LLM 口令；**匹配不上绝不猜**，直接交给 LLM。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 内容 | 说明 |
|---|---|---|---|
| `HAS_CJK` | L33 | 正则 | 判断是否中文输入 |
| `NUM_CHARS` / `NUM_PATTERN` | L36 / L37 | 中文数字字符 / 匹配式 | 「零一二两三四五六七八九十百千」 |
| `DIGIT_VALUE` / `UNIT_VALUE` | L40-L45 | 映射 | 中文数字 → 值 |
| `cnToInt(token)` | L47 | 函数 | 「十五 / 二十 / 一百二十 / 两千零五」→ 数 |
| `normalizeText(raw)` | L159 | 函数 | 全角→半角、去标点、小写、合并空白 |
| `stripWake(spaced)` | L180 | 函数 | 去掉「可可 / 教练 / coach」并置 `usedWake` |

## 3. 算法与流程（步骤化）

`parseCommand(text, locale='zh')` L508 起：

```
① normalizeText → 全角转半角、去标点、大小写不敏感、合并空白
② stripWake → 可选唤醒词（没有也照常解析：快车道不强制唤醒）
③ 抽槽位（各自一个 read* 函数）：
     readAmount L202  数量 + 单位（次/个/下/秒/分钟）
     readInterval L231 「每 N 个 / 每 N 秒」
     readRuleKind L248 规则频道（报数 / 读秒）
     readOrdinal L267 「第三个」
     readCategory L309 分类名 readExercise L332 动作名
     readLang L340（说英文）readVoiceGender L356 readSign L372
④ 说法表最长匹配（phraseScore L381 / isExact L390）：
     中英两套说法都参与（界面英文时说中文也认）
     numeric:true 的命令先把数字抹掉再比（「每 10 个」的说法能命中「每 3 个」）
     只在 PARSE_INTENTS（11 个 intent）里找，其余交给 LLM
⑤ slotReady(intent, slots) L416 校验必需槽位 → argsFor L429 组装 args
⑥ 都不中 → { intent:'unknown' }
```

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `parseCommand(text, locale)` | L508 | → `{intent, args, confidence, usedWake}` | 唯一主入口 |
| `cnToInt(token)` | L47 | → 数 \| null | 中文数字（含位值） |
| `normalizeText(raw)` | L159 | → 字符串 | 归一化（测试直接用） |
| `isConfirmText(text)` / `isCancelText(text)` | L489 / L493 | → boolean | 「好 / 取消」判定（session 用） |

## 5. 与其它文件的关系

- 上游：`i18n.js`（`LOCALES` 里的说法表）、`catalog.js`（`EXERCISES` 动作名）、
  `voice/commands.js`（`COMMANDS` / `PARSE_INTENTS` / `CONFIRM_WORDS` / `CANCEL_WORDS`）。
- 下游：`voice/session.js`（`onUserText` → `parseCommand` → `COMMANDS[].run`）、`app.js`（帮助面板）。
- 服务端不直接用它：工具调用走 `server/llm-tools.mjs` 的 `TOOL_INTENT_MAP`。

## 6. 易错点与设计取舍

- **`unknown` 是正确答案**：宁可交给 LLM，也不要模糊匹配到「暂停」（会造成误操作）。
- 中文数字用 `\u` 转义（L36-L45）：`src/` 里不允许写死中文。
- 「每 N 个」的说法表项会先把数字抹掉再比（L404-L415），所以一条说法覆盖所有 N；
  数字本身由 `readInterval` 抽出来。
- 唤醒词**可选**：`usedWake` 只作诊断，不参与是否执行。
- 只在 `PARSE_INTENTS` 里匹配（L78 的 11 个）：多出来的 intent 仍可被 LLM 工具调用，
  但不会从语音快车道进 —— 「回到首页 / 设成 20 次」这类已交给 LLM。
- 解析是纯函数：改说法表只影响识别，不影响执行。

## 7. 读代码建议（先看哪几行）

1. L1-L27 头部（处理顺序六步）；
2. L47-L158 `cnToInt`（中文数字，最难的一段）；
3. L508-L573 `parseCommand`（主流程与回退）；
4. L381-L415 `phraseScore` / `numericScore`（匹配打分规则）。
