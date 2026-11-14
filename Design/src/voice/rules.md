# src/voice/rules.js — 规则快车道（确定性的话：报数 / 读秒 / 倒数 / 纠正 / 催促）

> 层：语音（决策） ｜ 853 行 ｜ 纯逻辑，**不发请求、不花钱**
> 一句话：事件进来 → 一整套护栏筛一遍 → 最多返回一句要念的话（`{speak}`）。

## 1. 它解决什么问题（为什么需要它）

用户要求「每 5 秒读一次秒」「计次像私教一样报数」——这些**必须零延迟、零成本、断网可用**。
规则引擎订阅事件总线（`events.js`），命中就返回一句话，由 `app.js` 走现有的弹幕 + TTS 通道念出来。
难点全在**别太吵**：所以护栏比规则本身多。

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
| `COACH_VOLUMES` | L99-L100 | `low/mid/high`，默认 `mid` | 话量三档 |

规则形状（L9-L10）：`{id, scope, channel, label, trigger:{event, filter, resetOn}, action:{template, args}, cooldownMs, priority, budget:{perSet, perMinute}, adaptive, bypassGap, volumes, enabled}`。

## 3. 算法与流程（步骤化）

`engine.handle(event, state)`（L~460 起，护栏在 L515-L605）：

```
① 诊断包装：note('rule:skip', {reason}) —— 为什么没说，日志里能查
② 教练关 / 静音 → 直接 null（规则全丢）
③ 候选：trigger.event 对上 + volumes 允许 + matchesFilter(filter, ctx)（L159）
④ 按 priority 降序（同优先级按 id）
⑤ 逐条过护栏，**谁先过谁说话**（同一个 tick 只出一条）：
     adaptive 不允许（stride 不够，L273）→ 跳过
     正在说话：普通规则丢弃；bypassGap 的读秒可以说，
       但计数类若剩余台词 > 1.5s（skipWhileSpeakingMs）也跳过（不排队、不叠音）
     同一毫秒已说过（at <= lastSpeakAt）→ 跳过
     规则冷却 cooldownMs / 每组预算 perSet / 每分钟预算 perMinute
     全局间隔 MIN_GAP_MS（bypassGap 规则不受限）
     渲染出的文本为空 → 跳过
⑥ 记账（冷却 / 预算 / 全局间隔）→ 返回 {speak:{text,ruleId,priority} , actions?}
```

**作用域到期**：`set-complete` → `resetScope('set')`（清运行期状态）；`session-end` →
`clearScope('session')`（口述规则只活一次训练，L24-L25）。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createRuleEngine({now, diag, t, minGapMs})` | L306 | → engine | `add/remove/list/clear/clearScope/reset/handle` + `size/spoken/gapMs` |
| `handle(event, state)` | L~460 | → `{speak, actions?}` \| null | 唯一决策入口 |
| `repRule(opts)` / `readRule(opts)` | L652 / L700 | → rule | 口述建规则用 |
| `builtinRules({t})` | L753 | → rule[] | 8 条内置规则 |
| `gateCueKey(gate)` | L629 | → i18n 键 | 门控 → 「该怎么做」（与 `GATE_HINT` 同源） |
| `describeRule` / `ruleNameKey` / `ruleEveryText` | L842 / L818 / L828 | → 字符串 | 规则面板 / ack 文案 |
| `normalizeRule` / `matchesFilter` / `strideForPace` / `adaptiveAllows` / `estimateSpeechMs` / `eventContext` | L201 / L159 / L252 / L273 / L290 / L125 | 纯函数 | 单测直接用 |
| `MIN_GAP_MS` / `ADAPTIVE_REP` / `RULE_PRIORITIES` / `RULE_CHANNELS` / `COACH_VOLUMES` | L34-L100 | 常量 | 界面与测试共用 |

## 5. 与其它文件的关系

- 上游：`i18n.js`（`t` / `hasKey` / `getLang` 取模板）、`engines.js`（`GATE_HINT`）、
  `voice/events.js`（`EVENT_TYPES`）、`voice/numerals.js`（`numberWord`）。
- 下游：`app.js`（`createRuleEngine` L575 + `syncRuleEvents` L8251 把事件喂进来，
  命中后走 `voice.onCoachText`）、`voice/commands.js`（`describeRule` 做 ack）、
  `server/llm-tools.mjs`（`RULE_CHANNELS` 做工具枚举）。
- 与 `judge.js` 是**两条并列通道**：规则确定、裁判随机；两者都最终调 `voice.onCoachText`。

## 6. 易错点与设计取舍

- **护栏不加就会「很吵」**（文件头 L15-L26 逐条列了）：全局间隔、冷却、预算、同 tick 只一条、
  说话中丢弃、静音丢弃 —— 少任何一条用户都会投诉。
- **`bypassGap` 只给计数 / 读秒**：它们需要「每个都报」，但仍受 `minStepMs` 与
  `skipWhileSpeakingMs` 约束（每秒最多 1 次）。
- **不排队、不叠音**：教练在说话时的普通规则直接丢，绝不攒着后补（会变成复读机）。
- 模板里的数字必须走 `numberWord`，不要直接塞阿拉伯数字（TTS 念法不稳定）。
- 规则只**返回文本**，不自己念：真正的 TTS / 弹幕在 `app.js`，所以规则可以在 Node 里全测。
- 改 `RULE_PRIORITIES` 会改变「谁抢到这一 tick」，属于产品口径，别随手调。

## 7. 读代码建议（先看哪几行）

1. L1-L110 头部 + 常量（护栏清单与优先级）；
2. L515-L606 `handle` 的护栏链（本项目最密集的一段 if）；
3. L252-L305 `strideForPace` / `adaptiveAllows` / `estimateSpeechMs`（降频算术）；
4. L753-L813 `builtinRules`（8 条内置规则的实际形状）。
