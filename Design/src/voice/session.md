# src/voice/session.js — 语音会话状态机（off / listening / thinking / speaking / error）

> 层：语音（核心） ｜ 1114 行 ｜ 纯逻辑 + 依赖注入，**不碰 DOM**（Node 里可测）
> 一句话：麦克风、ASR、LLM、TTS 都只是注入的适配器；这里决定「什么时候听、什么时候说、什么时候停」。

## 1. 它解决什么问题（为什么需要它）

语音链路有五个异步来源（麦克风权限、ASR partial/final、LLM 回复、TTS 播放结束、用户操作），
没有一个中心状态机就会出现：重复回复、字幕被迟到的 interim 覆盖、TTS 卡住后永远「在说话」、
说完一句之后再也不会听。本模块把这些收敛成 5 个状态与一组定时器（静音 / 说话看门狗）。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `VOICE_STATES` | L42 | `off/listening/thinking/speaking/error` | 唯一合法状态集合 |
| `VOICE_ERROR_KEYS` | L45-L63 | 错误码 → i18n 键 | `mic` / `asr-*` / `llm` / `generic` … |
| `VOICE_NOTICE_KEYS` | L70-L78 | 提示码 → i18n 键 | 非致命（网络 / 没听到声音 / 回退） |
| `VOICE_SILENCE_MS` | L81 | `8000` | 进 listening 后这么久没结果 → 提示 |
| `VOICE_SPEAK_MIN_MS` / `MAX` | L93-L94 | `6000` / `20000` | 说话看门狗区间 |
| `speakHoldMs(text)` | L100 | 字数 × 260 + 3000，夹 `[min,max]` | 一句话最多占住 speaking 多久 |
| `VOICE_LLM_MAX_ACTIONS` | L111 | `3` | 一次回答最多执行几个动作（与服务端 `MAX_TOOL_CALLS` 同值） |
| 短时记忆 | L123-L137 | 10 轮对话 / 教练最近 5 句 / 最近 60 事件（60s 窗口） | 只在内存，刷新即清 |
| `THINK_SLOW_MS` | L143 | `1500` | 超过它显示「教练在想…」 |

## 3. 算法与流程（步骤化）

```
off ──start()──▶ listening ──onUserText(final)──▶ thinking ──onCoachText()──▶ speaking
                   ▲                                │                        │
                   └──── TTS 结束 / 看门狗到点 / interrupt ◀──────────────────┘
任意状态 ──stop() / fail()──▶ off / error
```

**收到一句话**（`onUserText` L736-L900）：

```
partial（isFinal === false）：
   先喂打断旁路 onInterim（教练说话时也要喂）
   不在 listening → 只在「收回/清空」时清字幕，否则丢弃（迟到的 interim 不能盖定稿）
   listening → 更新 interimText、清提示、重开静音计时
final：
   paused → 记 note('session:drop') 后丢
   state === 'speaking' → 先 interrupt('barge-final') 再处理（TTS 卡死时也能自救）
   仍不是 listening → 记 note 后丢
   → setState('thinking')、epoch += 1
   → handleFastLane(body)：命中命令 → 直接执行（不联网、不花钱）
   → 否则 llm.reply(body) → 有 actions 就 runActions()（复用命令表 handler）
   → onCoachText(text) → speaking（TTS 播放；结束回调再回 listening）
```

**看门狗**：`armSilence()`（L593）在 8s 无结果时给提示；`armThinkSlow()`（L557）显示「在想…」；
`finishSpeaking(epoch, by)`（L652）用 `speakHoldMs` 兜底 —— TTS 的 `onEnd` 永远不回来时也能回
`listening`（并记 `session:speak-timeout`）。

**短时记忆**（L269-L320）：`recordEvent` 写**注入的总线**；`recentEvents(limit)` 读同一份，
所以规则引擎与 LLM prompt 永远看到一致的事件。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createVoiceSession({mic, asr, tts, llm, diag, …})` | L170 | → 会话对象 | 全部依赖注入 |
| `start()` / `stop(by)` / `stopListening(by)` | L~1100 区 | void | 开关会话 |
| `pause(by)` / `resume()` | L980 / L995 | void | 页面隐藏时暂停（不释放麦克风） |
| `onUserText(text, info)` / `onCoachText(text, opts)` | L736 / L670 | boolean / void | ASR 与教练文本入口 |
| `interrupt(by)` / `fail(code)` | L915 / L627 | void | 打断 / 落错误 |
| `runActions(actions)` | L470 | → `{askedConfirm, ack}` | 执行 LLM 给的动作（走命令表） |
| `recordEvent` / `emitEvent` / `recentEvents` / `bus` | L269-L288 | — | 短时事件（总线本体也暴露） |
| `snapshot()` / `subscribe(fn)` / `destroy()` | L336 / L1008 / L1014 | — | 界面渲染 / 订阅 / 释放 |
| `speakHoldMs` / `voiceErrorKey` / `voiceNoticeKey` | L100 / L145 / L149 | 纯函数 | 文案键与看门狗时长 |

`snapshot()`（L336）是界面唯一数据源：`state / enabled / paused / error / notice / route /
interimText / coachText / lastCoachLines / recentTurns / muted / thinkingSlow / pendingConfirm`。

## 5. 与其它文件的关系

- 上游：`i18n.js`（文案键）、`voice/parse.js`（命令解析）、`voice/commands.js`（`COMMANDS` /
  `COMMAND_CONFIRM_MS`）、`voice/events.js`（总线与常量）。
- 下游：`app.js`（`createVoiceSession` 接线 + `snapshot()` 渲染）、`voice/coach.js`（界面层读 snapshot）、
  `voice/bargein.js`（`interrupt`）、`voice/judge.js`/`app.js`（都通过 `onCoachText` 说话）。
- 与 `voice/tts-volc.js` 无直接耦合：只要求 `tts.speak(text, {onEnd, onError})` 契约。

## 6. 易错点与设计取舍

- **`final` 绝不结束会话**（文件头 L12-L16）：说完一句回 `listening`，只有 `stop()` / `pause()` /
  不可恢复的 `fail()` 才放麦克风。改这里会让「只说一句就不听了」复现。
- **epoch 防串台**（L797）：每句话 +1，异步回调回来先比 epoch，旧结果直接丢。
- **说话看门狗不是保险而是主路径**：TTS `onEnd` 丢失是真实发生过的（L84-L92），兜底必须在。
- `speaking` 里收到 **final** 要先 `interrupt` 再处理（L780-L783）：这是「TTS 卡死后自救」的补丁。
- 依赖全注入、`snapshot()` 是纯对象：所以 `tests/test-voice.mjs` 能不起浏览器地跑完整状态机。
- 修改状态转换前先读 L1-L32 的状态图注释，别只看函数名。

## 7. 读代码建议（先看哪几行）

1. L1-L32 状态图与设计约束；
2. L170-L270 `createVoiceSession` 的依赖与内部变量；
3. L736-L805 `onUserText`（partial / final / speaking 三种入口，最易改坏的一段）；
4. L652-L700 `finishSpeaking`（看门狗与 `speaking → listening`）。
