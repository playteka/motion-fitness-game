# src/audio.js — 音效 + 语音播报 + 现场合成的背景音乐

> 层：渲染（声音） ｜ 608 行 ｜ 只用浏览器内置能力（WebAudio / SpeechSynthesis），零音频文件
> 一句话：所有「叮、咚、报数、鼓励、BGM」都从这一个 `AudioKit` 出。

## 1. 它解决什么问题（为什么需要它）

体感训练的反馈有一半在声音上：计次要「叮」、要领达标要「叮叮」、报数要用正确语言念、
BGM 要能盖住环境噪音又不抢语音。用音频文件会有体积 / 授权 / 加载失败三类问题，
所以这里**全部现场合成**（振荡器 + 噪声 + 简单包络），语音走系统 TTS。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 内容 | 说明 |
|---|---|---|---|
| `mtof(midi)` | L16 | 频率 | MIDI → Hz（A4 = 69 = 440） |
| `TRACKS` | L33-L127 | 4 首 | 每首＝`{id, bpm, swing, nameKey, progression, drums, bass, lead}` |
| `DEFAULT_TRACK` | L128 | `TRACKS[0].id` | 默认曲目 |
| `getTrack(id)` | L131 | → track | 未知 id 回退默认 |
| `MUSIC` | L136 | `TRACKS[0]` | 兼容旧调用 |
| `musicEvents(track)` | L139 | → 事件数组 | 把「和弦 / 鼓 / 贝斯 / 旋律」摊平成带时间的音符事件 |
| `musicLoopSeconds(track)` | L183 | → 秒 | 一个循环多长（排程用） |
| `AudioKit` | L188-L608 | class | 全部音效 / 语音 / BGM 的唯一入口 |

曲目内部结构（注释 L19-L32）：`drums` 写在 16 分音符网格上；`bass` / `lead` 是
`[16分位置, 相对根音半音数, 持续几个16分]`；音色全是合成的（底鼓下滑正弦、军鼓噪声、踩镲高通噪声）。

## 3. 算法与流程（步骤化）

**初始化**：`ensureCtx()` L272 懒建 `AudioContext`（浏览器要求用户手势后才能出声，
所以 `unlock()` L225 在第一次点击时调用）；`state()` L240 报告可用性。

**音效**（全部走 `tone()` L295：`{freq, dur, type, gain, delay, slideTo}`）：
`rep` L314（计次）、`step` L322（要领）、`criteria` L339、`bonus` L348、`scoreTick` L352、
`partial` L356、`tick` L360、`go` L361、`pause` L362、`milestone` L363、`finish` L366。

**语音**（`say()` L372）：
`sayRep(n)` L414（报数）、`sayEncourage(seed)` L423（按 seed 挑一句鼓励，避免复读）、
`sayStep(label)` L435、`sayTime(ms)` L443、`sayCountdown(n)` L449、`sayStart()` L450、
`sayCue(text)` L451（姿势纠正，`minGapMs` 6000 防刷屏）、`stopSpeech()` L452。
文本一律来自 i18n 词条；数字直接交给系统 TTS 用对应语言念（zh-CN / en-US 都认阿拉伯数字）。

**背景音乐**：`setTrack(id)` L468 换曲、`setMusic(on)` L482 开关、`startMusic()` L488 起播
（`_pumpMusic()` L519 用 `setTimeout` 提前排程下一个循环）、`stopMusic()` L506。
`_noiseBuffer` L536 / `_playNoise` L550 / `_playNote` L588 是音色合成。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `new AudioKit()` | L188 | → 实例 | 单例由 `app.js` 持有 |
| `kit.unlock()` / `kit.state()` | L225 / L240 | void / 对象 | 解锁 / 可用性 |
| `kit.rep / step / criteria / bonus / milestone / finish …` | L314-L366 | void | 音效 |
| `kit.say(text, opts)` / `sayRep` / `sayCue` … | L372-L451 | void | 语音播报 |
| `kit.setVoiceEnabled(on)` / `stopSpeech()` | L263 / L452 | void | 语音开关 / 立即停 |
| `kit.setTrack(id)` / `setMusic(on)` / `startMusic()` / `stopMusic()` | L468-L506 | void | BGM |
| `TRACKS` / `DEFAULT_TRACK` / `getTrack` / `musicEvents` / `musicLoopSeconds` | L33-L183 | 数据 / 纯函数 | 曲目与排程（测试可直接断言） |

## 5. 与其它文件的关系

- 上游：`i18n.js`（`t` 取语音词条、`getMeta().speechLang` 选语言）。
- 下游：只有 `app.js`（计次 / 要领 / 开始 / 结束 / 设置里的开关）。
- 与 `voice/` 目录**无关**：AI 教练的声音走 `voice/tts-volc.js` + `providers.js`，
  这里的 `say*` 只服务「本地报数 / 音效」，两条音路互不抢占（同一时刻可能叠音，
  由调用方在 `app.js` 里决定优先级）。

## 6. 易错点与设计取舍

- **不在构造里建 `AudioContext`**：浏览器策略会让它 `suspended`，必须用户手势后 `unlock()`。
- `say()` 有 `minGapMs`（默认 250）与 `force`：报数可以密，纠正必须稀疏，否则语音互相打断。
- 合成音乐**没有音量自动化总线**，靠每个音符的 `gain` 控制；改 `progression` 时要自己保证
  不爆音（叠加过多会削波）。
- `getTrack` 对未知 id 回退默认，不抛错 —— 设置里存了旧曲目 id 也不会崩。
- `musicEvents` 是纯函数（无 AudioContext），所以排程逻辑可以在 Node 里测。

## 7. 读代码建议（先看哪几行）

1. L16-L32 `mtof` + 曲目结构说明；
2. L188-L295 `AudioKit` 构造 → `unlock` → `tone`（所有音效的底座）；
3. L372-L414 `say()`（语音的节流与语言）；
4. L488-L536 `startMusic` / `_pumpMusic`（循环排程）。
