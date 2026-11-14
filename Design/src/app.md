# src/app.js — 应用主逻辑：把所有模块接成一台机器

> 层：服务端外的**最顶层**（UI + 生命周期 + 接线） ｜ 约 10 000 行 ｜ 唯一大量直接操作 DOM 的文件
> 一句话：摄像头 → 姿态 → 指标 → 识别 → 事件 → （界面 / 音效 / 语音教练）；别的模块都是零件，这里是装配线。

## 1. 它解决什么问题（为什么需要它）

`index.html` 只有一个入口脚本（`<script type="module" src="./src/app.js">`）。所有「谁调谁、
什么时候开关摄像头、什么时候换动作、设置存哪里、语音教练怎么和训练联动」都在这里决定。
它刻意**不实现判定算法**：判定在 `engines.js` / `exercises.js`，文案在 `locales`，
音效在 `audio.js`，语音链路在 `voice/*`。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 内容 | 说明 |
|---|---|---|---|
| `STORE` | L77 | `mfg.settings.v1` / `history` / `records` … | localStorage 键（都带版本号） |
| `SETTINGS_VERSION` | L107 | `3` | 设置结构版本（迁移用） |
| `DEFAULT_SETTINGS` | L109 | 模型 / 镜像 / 语音 / 教练 / 音色 / 节奏 … | 首次启动的默认设置 |
| `REP_TARGETS` / `HOLD_TARGETS` / `TIME_TARGETS` | L193-L196 | 数组 | 目标预设（按动作 kind 选） |
| `SET_REP_CHOICES` / `SET_SEC_CHOICES` | L216-L217 | 数组 | 每组次数 / 秒数可选值 |
| 单例 | L240-L244 | `audio` / `engine` / `camera` / `renderer` / `smoother` | 五个长生命周期对象 |
| `state` | L246-L360 左右 | 几十个字段 | 界面 / 会话 / 诊断状态（见 §3） |
| `coachDiag` … `judge` | L389 / L397-L443 / L490 / L572 / L575 / L839 | 语音链路单例 | 诊断 / ASR / TTS / 自检 / 弹幕 / 插话 / LLM / 事件总线 / 规则引擎 / 裁判 |
| `voiceCommandCtx` | L460 | 回调集合 | 命令表 `run(ctx, args)` 的唯一依赖（见 `voice/commands.js`） |

`state.session` 的取值（L259）：`calibrating | ready | countdown | running | paused | idle`；
`homeMode` / `menuMode` 与它正交（L260-L261）。

## 3. 算法与流程（步骤化）

**启动**（`boot()` L9984 起）：读设置 → 应用 i18n / 主题 / 设备默认值 → 绑定按钮与热键 →
建校准器 → 加载模型（`PoseEngine.init`，带进度条）→ 开摄像头 → `requestAnimationFrame(loop)`（L10036）。

**每帧**（`loop()` L8341-L8540，全项目最重要的 200 行）：

```
① 早退：引擎没就绪 / 摄像头没开 → 清屏 return；视频帧没变（currentTime 相同）→ return
② 倒计时兜底：定时器被浏览器节流 → 超过 3.6s 直接 finishCountdown()
③ engine.detect(video, now) → 关键点
④ smoother.apply() → toMetric() → computeFrame(…, {groundY: 校准地面线})   // 每帧唯一一次
⑤ renderer.resize()；分四种模式：
     手势菜单 menuMode → updateMenu / tickCornerExit / updatePaws，不计数不校准
     主页 homeMode     → 只画画面，不动会话
     校准 calibrating  → calibrationStep(frame, now) 只做就位判定
     训练 counting     → feedDetector(frame, now) → handleEvents(events) →
                        announceHoldCount / announceTimeLeft → syncRuleEvents(now) →
                        updateCriteria(frame, events, now)            // 进度条
⑥ 会话状态硬约束（L8457）：倒计时 / 训练 / 暂停 一律不画校准虚线轮廓
⑦ 目标判定 / 结算 / HUD（updateHud L6920）/ 调试面板（renderDebug L7119）
```

**训练子链路**：`feedDetector`（L7912）把帧喂给 `state.detector` 并取事件 →
`handleEvents`（L8023）分发（音效 / 语音报数 / 计次 / 要领 / 计分）→
`syncRuleEvents`（L8251）把 `rep / tick / idle / gate-*` 发到事件总线，规则引擎决定「说什么」。

**语音教练接线**（L389-L900）：`createDiag` → `createAutoAsr`（火山优先、浏览器兜底）→
`createVolcTts` + `createTts`（降级）→ `createCoach`（界面）→ `createDanmaku` → `createBargeIn` →
`createLlmClient` → `createEventBus` + `createRuleEngine` → `createJudge` →
`createVoiceSession`（L738）。**app.js 只做接线**，状态机在 `voice/session.js`。

## 4. 对外接口

- **没有 `export`**：这是浏览器 entry module，靠 DOM 事件与全局单例工作（`index.html` 里的
  按钮 id / `data-i18n` 属性就是它的外部契约）。
- 对内契约：`voiceCommandCtx`（L460）—— `voice/commands.js` 的每条 `run(ctx, args)` 只允许
  调用这里注入的函数，**命令表不碰 state**。
- `index.html` 里所有 `id="…"` 都被 `$()`（L72）读取；改名必须同步改 HTML。

## 5. 与其它文件的关系

- 上游（全部 import，L6-L70）：`exercises` / `geometry` / `metrics` / `pose-engine` / `render` /
  `audio` / `calibration` / `specs` / `steps` / `icons` / `pose-log` / `i18n` + 整个 `voice/*`。
- 下游：`index.html`（DOM）、`style.css`（类名）。
- 唯一「知道所有模块」的文件：改跨模块流程只能在这里接。

## 6. 易错点与设计取舍

- **每帧只调一次 `computeFrame`**（L8375）：重复调用会让 `legOut` 之类依赖帧的字段翻倍计算，
  也会拖慢帧率。
- **`groundY` 必须来自校准器**（L8376）：用脚踝临时估的地面会跟着跳跃 / 抬腿一起动。
- **状态分支漏写 `outline = null`** 会把校准轮廓带进训练画面（L8453-L8459 是硬兜底，
  新增分支时仍要自己清）。
- 倒计时有**定时器 + 时间判断**双保险（L8355）：只靠 `setTimeout` 在后台标签页会被节流。
- `settings.targets[id]` / `settings.seconds[id]` 是**按动作**存的：换动作不会丢目标。
- 这里所有面向用户的字符串都必须走 `t()`；写死中文会被 `test-i18n` 抓到。

## 7. 读代码建议（先看哪几行）

1. L6-L70 import 清单（一眼看到全项目依赖关系）；
2. L246-L307 `state` 字段（界面状态的全部词汇）；
3. L8341-L8459 `loop()`（每帧顺序，读这一段比读 100 个函数有用）；
4. L389-L500 语音链路接线（谁被包在谁外面）；
5. L9984-L10036 `boot()`（启动顺序）。
