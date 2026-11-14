# src/voice/bargein.js — 插话打断（说话时也能插一句把教练止住）

> 层：语音（播放控制） ｜ 171 行 ｜ 纯状态机 + 依赖注入
> 一句话：**「连续 2 个够响的 partial」**才打断 —— 难点不是停，而是别误触发。

## 1. 它解决什么问题（为什么需要它）

用户要「教练说话时仍然在听，我直接插一句话就能把它止住」。麻烦在于麦克风会收到三样东西：
教练自己的声音（外放）、环境噪声、ASR 的抖动。只按「听到声音就停」会被自己的 TTS 打断自己，
形成「说一句停一下」的死循环。所以要一组**同时成立**的条件。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 作用 |
|---|---|---|---|
| `BARGE_IN_WINDOW_MS` | L23 | `600` | 两个 partial 的最大间隔（超过就不算「连续」） |
| `BARGE_IN_MIN_CHARS` | L25 | `2` | 至少两个字（「嗯」「啊」不算） |
| `BARGE_IN_LEVEL` | L27 | `0.18` | 聆听期的麦克风 RMS 阈值 |
| `BARGE_IN_PLAYBACK_LEVEL` | L29 | `0.30` | **播放期**阈值（更高，挡掉外放的教练声音） |
| `BARGE_IN_MAX_LATENCY_MS` | L31 | `150` | 触发后必须在这段时间内真的静音 |

## 3. 算法与流程（步骤化）

```
onPartial(text):
  ① 不是「教练正在说话」→ 重置计数，return
  ② 设置里「允许插话打断」关着 → 重置，return
  ③ 文本长度 < BARGE_IN_MIN_CHARS → 不算
  ④ 距上一个 partial > BARGE_IN_WINDOW_MS → 重新数（count = 1）
  ⑤ 麦克风 RMS < 阈值（播放期用 BARGE_IN_PLAYBACK_LEVEL）→ 不算
  ⑥ count >= 2（连续两个）→ 触发：
       stop()（停播放 + abort 流式请求 + 释放解码队列 / blob URL）
       → onInterrupt()（会话层切回 listening）
       → diag('tts:barge-in', { ms })（ms = 距第一个 partial 的毫秒数）
```

**三件事同步做完**（文件头 L14-L16）：实测 ≤150ms，用户感觉是「立刻停」。
`stop()` 里必须 **abort 上游流式请求**，否则服务端还在合成、音频继续到达。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createBargeIn(opts)` | L49 | → 控制器 | 依赖全注入：`stop` / `isPlaying` / `getLevel` / `enabled` / `onInterrupt` / `diag` / `now` |
| `onPartial(text)` | 控制器方法 | void | 喂 ASR 的 partial 文本 |
| `reset()` / `state` | 控制器方法 | void / 对象 | 清计数 / 读当前状态 |
| `BARGE_IN_*` | L23-L31 | 常量 | 阈值（`app.js` 用 `BARGE_IN_MAX_LATENCY_MS` 做断言/提示） |

## 5. 与其它文件的关系

- 上游：`voice/providers.js`（麦克风 + ASR 的 partial）、`providers.js` 的 `createVuMeter`
  （`getLevel` 来源）。
- 下游：`voice/session.js`（`interrupt()` 切回 listening）、`voice/tts-volc.js`（`stop()` 真停）。
- `app.js` L443 创建，并把 `tts.stop` / `session.state` / `vu.readLevel` 注入。

## 6. 易错点与设计取舍

- **播放期阈值更高**（0.30 vs 0.18）：外放时教练的声音到不了 0.30，用户凑近说才到 —— 这是
  整套机制的关键，不要为了「更灵敏」把两个阈值调成一样。
- **要求连续 2 个 partial**：单个 partial 可能是 ASR 的瞬时误识；两个且间隔 <600ms 才是真说话。
- 打断要**同时**做三件事，少一件就会出现「声音停了但 TTS 还在播」「状态卡在 speaking」。
- 本模块不碰 DOM / 不碰 AudioContext：所有动作通过注入的函数完成，所以 Node 里可用假时钟断言。
- 关闭「允许插话打断」时不要顺手 `stop()` —— 用户可能只是想让它说完。

## 7. 读代码建议（先看哪几行）

1. L22-L31 五个常量（全部判据）；
2. L49-L110 `createBargeIn` 的 `onPartial`（判定顺序就是上面 §3）；
3. L110-L170 触发后的三件事与诊断字段。
