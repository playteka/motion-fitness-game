# src/voice/selftest.js — 语音自检（一键排障：mic → 代理 → 录音 → 结果）

> 层：语音（排障） ｜ 559 行 ｜ **完全独立**于教练会话；依赖全部可注入
> 一句话：主流程卡住时，用它自己取麦、自己连 `/asr`、自己录 2 秒发出去，把坏在哪一步说出来。

## 1. 它解决什么问题（为什么需要它）

用户反馈「麦克风亮着但没字幕」时，主流程（会话状态机）可能已经被 error 卡住，
再用它来测就分不清「哪一步坏了」。所以自检**不碰** `createVoiceSession` / `createMic` 的实例，
只复用两个无状态工具（`createVuMeter` / `startPcmCapture`），走一遍最小链路。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `SELF_TEST_STEPS` | L26 | `['mic','ws','send','result']` | 四步 |
| `SELF_TEST_STEP_KEYS` | L27 | 步骤 → i18n 键 | 面板上每一步的标题 |
| `SELF_TEST_FAIL_KEYS` | L33 | 失败码 → i18n 键 | 「麦克风没打开 / 代理连不上 / 403…」 |
| `SELF_TEST_FAIL_UPSTREAM_KEY` | L39 | `coach.selfTest.fail.upstream` | 上游错误的兜底文案 |
| `selfTestLang()` | L42 | → `zh-CN` / `en-US` | 用当前界面语言（不是写死） |

## 3. 算法与流程（步骤化）

```
① mic    ：getUserMedia({audio}) → 失败 → fail('mic')，直接把失败那一步用 TTS 说出来
② ws      ：new WebSocket(resolveAsrUrl(win)) → open 超时 / 连不上 → fail('ws')
③ send    ：createPcmFramer + startPcmCapture 录 2 秒 → 按 100ms 帧发 → 发 stop/最后一包
④ result  ：等服务端 partial / final（带超时）→ 有结果 = 通过；上游错误码 → fail 对应的 code
结束一定释放：音轨 stop、AudioContext.close()、WebSocket.close()、音量表 close()
```

每一步的状态都写进诊断面板（`diag`），失败时用 TTS 念**失败的那一步**（用户能照着修）。
只上报计数与文本（走 `diag.js`，自带截断与脱敏），**不传音频**。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createSelfTest({win, diag, tts, …})` | L77 | → 控制器 | 依赖可注入（Node 可测） |
| `run()` | L549 | → Promise | 跑完四步；返回结果对象 |
| `cancel()` / `destroy()` | L550 / L551 | void | 中途放弃 / 释放 |
| `snapshot()` / `subscribe(fn)` | L552 / L553 | → 对象 / 取消函数 | 面板状态 |
| `running` / `mounted` | L554 / L555 | getter | 是否在跑 / 是否已卸载 |
| `SELF_TEST_STEPS` / `SELF_TEST_STEP_KEYS` / `SELF_TEST_FAIL_KEYS` | L26-L39 | 常量 | 面板文案与步骤名 |
| `selfTestLang()` | L42 | 纯函数 | 语言选择 |

## 5. 与其它文件的关系

- 上游：`i18n.js`（`t` / `getLang` / `getMeta`）、`voice/providers.js`
  （`createVuMeter` / `startPcmCapture` / `resolveAsrUrl` / `sameOriginAsrUrl` / `DEFAULT_ASR_WS_URL`）、
  `voice/pcm.js`（`createPcmFramer` / `FRAME_BYTES`）。
- 下游：`app.js`（设置里的「语音自检」按钮）、`voice/coach.js`（面板显示步骤状态）。
- 与 `voice/session.js` **零耦合**：这正是它能在主流程坏掉时工作的原因。

## 6. 易错点与设计取舍

- **独立才有价值**：不要为了「复用」去调 `createMic` / 会话状态机，否则主流程一坏自检也跟着坏。
- 结束时必须释放四样资源（文件头 L14）：音轨 / AudioContext / WebSocket / 音量表 —— 漏一个
  就会继续占着麦克风（用户会看到浏览器上的红点不灭）。
- 失败要**TTS 说出来**：面板可能看不见（用户在全屏训练页），声音是最直接的反馈。
- 只上报计数与文本：自检时最容易顺手把音频带上，明确禁止。
- 语言跟界面走（`selfTestLang`），不要写死中文提示。

## 7. 读代码建议（先看哪几行）

1. L1-L17 头部（为什么独立、要释放什么）；
2. L26-L45 常量与语言；
3. L77 起 `createSelfTest` 的四步（尤其 ③ 录 2 秒的定帧与停止）；
4. 失败分支的 TTS 调用（哪里调用 `tts.speak` 报出失败步骤）。
