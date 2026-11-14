# src/voice/rules.js — 规则快车道（确定性的话：报数 / 读秒 / 倒数 / 纠正 / 催促）

> 层：语音（决策） ｜ 973 行 ｜ 纯逻辑，**不发请求、不花钱**
> 一句话：事件进来 → 一整套护栏筛一遍 → 最多返回一句要念的话（`{speak}`）。

## 1. 它解决什么问题（为什么需要它）

用户要求「每 5 秒读一次秒」「计次像私教一样报数」——这些**必须零延迟、零成本、断网可用**。
规则引擎订阅事件总线（`events.js`），命中就返回一句话，由 `app.js` 走现有的弹幕 + TTS 通道念出来。
难点全在**别太吵**：所以护栏比规则本身多。R4 起它还是**设置页规则面板的唯一事实来源**：
面板上那一行行（名称 / 触发条件 / 来源 / 开关）全部从这里的规则对象现算。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `MIN_GAP_MS` | L34 | `6000` | 全局最小开口间隔（`bypassGap` 规则除外） |
| `DEFAULT_READ_EVERY_SEC` | L40 | `5` | 计时类默认读秒间隔 |
| `ADAPTIVE_REP` | L54-L62 | `fastMs 1500 / midMs 1000 / maxStride 3 / minStepMs 1000 / milestoneEvery 5 / lowVolumeStride 5 / skipWhileSpeakingMs 1500` | 计数自适应降频 |
| `RULE_PRIORITIES` | L65-L80 | record 100 / correct 60 / read 45 / countdown 40 / count 35 / encourage 30 / idle 20 | 谁先说话 |
| `RULE_CHANNELS` | L87 | `['rep','read']` | 口述建规则只在这两个频道替换 |
| `DEFAULT_RULE_BY_CHANNEL` | L90 | `rep→rep-count` / `read→hold-read-5` | 恢复默认 |
| `RULE_SCOPES` | L96 | `set / session / forever` | 作用域（到期怎么清） |
| `RULE_SOURCES` | L103 | `builtin / user / llm` | R4 来源徽标（一处定义） |
| `USER_RULE_PREFIX` / `LLM_RULE_PREFIX` | L106 / L109 | `user-` / `llm-` | 按 id 前缀认来源 |
| `MAX_LLM_RULES` | L112 | `8` | LLM 规则上限（设置页提示用） |
| `COACH_VOLUMES` | L115-L116 | `low/mid/high`，默认 `mid` | 话量三档 |

规则形状（L9-L10）：`{id, scope, channel, label, trigger:{event, filter, resetOn}, action:{template, args}, cooldownMs, priority, budget:{perSet, perMinute}, adaptive, bypassGap, volumes, enabled}`。
R4 新增的纯函数：`ruleSource`（L893）按 `source` 字段 → id 前缀 → builtin 的顺序判断来源；
`ruleChannelOf`（L137）按 `channel` → 触发事件推频道（`rep→rep`、`tick`/`hold-tick→read`）；
`ruleConditionText`（L918）把 `trigger.filter` 拼成人话（`每 3 个` / `剩余 ≤5 秒` / `静止 ≥8 秒`…）。

## 3. 算法与流程（步骤化）

`engine.handle(event, state)`（L507 起，护栏在 L567-L655）：

```
① 作用域到期 / 会话开始：resetScope / clearScope（L511-L534 附近）
② 连续次数 + 节奏：先按这一次事件更新每条规则的 streak / pace（L535 起）
③ 教练关 / 静音 → 直接 null（规则全丢）
④ 候选：trigger.event 对上 + volumes 允许 + matchesFilter(filter, ctx)（L200）
     R4 新增一道闸：ruleChannelOf(rule) 的那一路总开关关着（repOn/readOn === false）
       → note('rule:skip', {reason:'rep-off'|'read-off'}) 并跳过（L575-L579）
⑤ 按 priority 降序（同优先级按 id）
⑥ 逐条过护栏，**谁先过谁说话**（同一个 tick 只出一条）：
     adaptive 不允许（stride 不够，L314）→ 跳过
     正在说话：普通规则丢弃；bypassGap 的读秒可以说，
       但计数类若剩余台词 > 1.5s（skipWhileSpeakingMs）也跳过（不排队、不叠音）
     同一毫秒已说过（at <= lastSpeakAt）→ 跳过
     规则冷却 cooldownMs / 每组预算 perSet / 每分钟预算 perMinute
     全局间隔 MIN_GAP_MS（bypassGap 规则不受限）
     渲染出的文本为空 → 跳过
⑦ 记账（冷却 / 预算 / 全局间隔）→ 返回 {speak:{text,ruleId,priority} , actions?}（L643-L654）
```

**作用域到期**：`set-complete` → `resetScope('set')`（清运行期状态）；`session-end` →
`clearScope('session')`（口述规则只活一次训练，L24-L25）。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createRuleEngine({now, diag, t, minGapMs})` | L347 | → engine | `add/remove/list/clear/clearScope/reset/handle` + `size/spoken/gapMs` |
| `handle(event, state)` | L507 | → `{speak, actions?}` \| null | 唯一决策入口（`state.repOn/readOn` 是 R4 两个总开关） |
| `repRule(opts)` / `readRule(opts)` | L702 / L750 | → rule | 口述建规则用 |
| `builtinRules({t})` | L803 | → rule[] | 6 条内置规则 |
| `gateCueKey(gate)` | L679 | → i18n 键 | 门控 → 「该怎么做」（与 `GATE_HINT` 同源） |
| `ruleSource` / `ruleSourceKey` | L893 / L904 | → `builtin|user|llm` / 词条键 | 面板来源徽标 |
| `ruleChannelOf` / `isChannelBlocked` | L137 / L147 | → `rep|read|''` / boolean | 报数 / 读秒总开关 |
| `ruleConditionText` | L918 | → 字符串 | 触发条件人话（面板第二列） |
| `describeRule` / `ruleNameKey` / `ruleEveryText` | L959 / L868 / L878 | → 字符串 | 口述 ack 文案 |
| `normalizeRule` / `matchesFilter` / `strideForPace` / `adaptiveAllows` / `estimateSpeechMs` / `eventContext` | L242 / L200 / L293 / L314 / L331 / L166 | 纯函数 | 单测直接用 |
| `MIN_GAP_MS` / `ADAPTIVE_REP` / `RULE_PRIORITIES` / `RULE_CHANNELS` / `RULE_SOURCES` / `MAX_LLM_RULES` / `COACH_VOLUMES` | L34-L116 | 常量 | 界面与测试共用 |

## 5. 与其它文件的关系

- 上游：`i18n.js`（`t` / `hasKey` / `getLang` 取模板）、`engines.js`（`GATE_HINT`）、
  `voice/events.js`（`EVENT_TYPES`）、`voice/numerals.js`（`numberWord`）。
- 下游：`app.js`（`createRuleEngine` L587 + `rulePanelRows` L771 / `renderRulePanel` L798 把它渲染成
  设置页列表；`syncRuleEvents` L8500 把事件喂进来，命中后走 `voice.onCoachText`）、
  `voice/commands.js`（`describeRule` 做 ack）、`server/llm-tools.mjs`（`RULE_CHANNELS` 做工具枚举）。
- 与 `judge.js` 是**两条并列通道**：规则确定、裁判随机；两者都最终调 `voice.onCoachText`，
  诊断里分别记 `rule:speak` / `judge:ask`（面板两行「为什么说 / 为什么没说」就是读这两路）。

## 6. 易错点与设计取舍

- **护栏不加就会「很吵」**（文件头 L15-L26 逐条列了）：全局间隔、冷却、预算、同 tick 只一条、
  说话中丢弃、静音丢弃 —— 少任何一条用户都会投诉。
- **`bypassGap` 只给计数 / 读秒**：它们需要「每个都报」，但仍受 `minStepMs` 与
  `skipWhileSpeakingMs` 约束（每秒最多 1 次）。
- **两个总开关只加一道闸，不动规则表**（R4）：关报数 / 读秒时规则还在引擎里，开回来立刻恢复；
  别把它们做成 `remove()`（那样面板就分不清「用户关的」和「口述删的」）。
- **来源按前缀认**：`user-*` / `llm-*` 是约定；新增来源要么带 `source` 字段，要么加前缀，
  别在面板里另写一份判断（`ruleSource` 是唯一入口）。
- **触发条件必须现算**：面板第二列只读 `trigger.filter`，不允许为某条规则写死一句话
  （否则改了 filter、界面就对不上了）。
- **不排队、不叠音**：教练在说话时的普通规则直接丢，绝不攒着后补（会变成复读机）。
- 模板里的数字必须走 `numberWord`，不要直接塞阿拉伯数字（TTS 念法不稳定）。
- 规则只**返回文本**，不自己念：真正的 TTS / 弹幕在 `app.js`，所以规则可以在 Node 里全测。
- 改 `RULE_PRIORITIES` 会改变「谁抢到这一 tick」，属于产品口径，别随手调。

## 7. 读代码建议（先看哪几行）

1. L1-L120 头部 + 常量（护栏清单、优先级、来源 / 上限）；
2. L567-L655 `handle` 的候选与护栏链（本项目最密集的一段 if，R4 的频道闸在 L575-L579）；
3. L293-L345 `strideForPace` / `adaptiveAllows` / `estimateSpeechMs`（降频算术）；
4. L803-L863 `builtinRules`（6 条内置规则的实际形状）；
5. L893-L973 R4 的来源 / 频道 / 触发条件人话（设置页规则面板读的就是这 5 个函数）。
