# src/app.js — 应用主逻辑：把所有模块接成一台机器

> 层：服务端外的**最顶层**（UI + 生命周期 + 接线） ｜ 约 11 340 行 ｜ 唯一大量直接操作 DOM 的文件
> 一句话：摄像头 → 姿态 → 指标 → 识别 → 事件 → （界面 / 音效 / 语音教练）；别的模块都是零件，这里是装配线。

## 1. 它解决什么问题（为什么需要它）

`index.html` 只有一个入口脚本（`<script type="module" src="./src/app.js">`）。所有「谁调谁、
什么时候开关摄像头、什么时候换动作、设置存哪里、语音教练怎么和训练联动」都在这里决定。
它刻意**不实现判定算法**：判定在 `engines.js` / `exercises.js`，文案在 `locales`，
音效在 `audio.js`，语音链路在 `voice/*`；**排课的算法也在 `voice/plan.js`**（这里只做存储 / 卡面 / 执行）。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 内容 | 说明 |
|---|---|---|---|
| `STORE` | L79 | `mfg.settings.v1` / `history` / `records` / `plan` / `planProgress` / `planHistory` … | localStorage 键（都带版本号） |
| `SETTINGS_VERSION` | L109 | `3` | 设置结构版本（迁移用） |
| `DEFAULT_SETTINGS` | L111 | 模型 / 镜像 / 语音 / 教练 / 音色 / 节奏 / **ruleSwitches** / **planGoal·planMinutes·planGear·planInjuries** | 首次启动的默认设置 |
| `REP_TARGETS` / `HOLD_TARGETS` / `TIME_TARGETS` | L205-L208 | 数组 | 目标预设（按动作 kind 选） |
| `SET_REP_CHOICES` / `SET_SEC_CHOICES` | L228-L229 | 数组 | 每组次数 / 秒数可选值 |
| 单例 | L252-L256 | `audio` / `engine` / `camera` / `renderer` / `smoother` | 五个长生命周期对象 |
| `state` | L258 起 | 几十个字段 | 界面 / 会话 / 诊断状态；**排课执行游标**（`plan*` L346-L360）也在这里 |
| `coachDiag` … `judge` | L401-L455 / L501 / L587 / L969 / L1070 | 语音链路单例 | 诊断 / ASR / TTS / 自检 / 弹幕 / 插话 / LLM / 事件总线 / 规则引擎 / 裁判 |
| `voiceCommandCtx` | L486 | 回调集合 | 命令表 `run(ctx, args)` 的唯一依赖（含排课 `makeTodayPlan` / `startTodayPlan`） |
| 规则面板 | L751-L926 | `ruleCatalog` / `ruleSwitchOn` / `applyRuleSwitches` / `rulePanelRows` / `renderRulePanel` / `setRuleEnabled` / `resetRuleDefaults` / `setRuleChannelSwitch` / `syncRuleCount` | R4：设置页「当前生效的规则」+「报数 / 读秒」两个总开关 |
| 排课 | L2640-L3270 | `readPlan` / `savePlan` / `buildTodayPlan` / `refinePlanWithLlm` / `renderPlanCard` / `startPlanBlock` / `planAfterSet` / `finishPlan` / `planFarewellStats` | 每日单次计划（三件套 + 卡面 + 执行 + 告别数字） |

`state.session` 的取值（L271）：`calibrating | ready | countdown | running | paused | idle`；
`homeMode` / `menuMode` 与它正交（L272-L273）。

## 3. 算法与流程（步骤化）

**启动**（`boot()` L10249 起）：读设置 → 应用 i18n / 主题 / 设备默认值 → 绑定按钮与热键 →
建校准器 → 加载模型（`PoseEngine.init`，带进度条）→ 开摄像头 → `requestAnimationFrame(loop)`（L8591）。

**每帧**（`loop()` L8590-L8796，全项目最重要的 200 行）：

```
① 早退：引擎没就绪 / 摄像头没开 → 清屏 return；视频帧没变（currentTime 相同）→ return
② 倒计时兜底：定时器被浏览器节流 → 超过 3.6s 直接 finishCountdown()
③ engine.detect(video, now) → 关键点
④ smoother.apply() → toMetric() → computeFrame(…, {groundY: 校准地面线})   // 每帧唯一一次（L8624）
⑤ renderer.resize()；分四种模式：
     手势菜单 menuMode → updateMenu / tickCornerExit / updatePaws，不计数不校准
     主页 homeMode     → 只画画面，不动会话
     校准 calibrating  → calibrationStep(frame, now) 只做就位判定
     训练 counting     → feedDetector(frame, now) → handleEvents(events) →
                        announceHoldCount / announceTimeLeft → syncRuleEvents(now) →
                        updateCriteria(frame, events, now)（L6815）               // 进度条
⑥ 会话状态硬约束：倒计时 / 训练 / 暂停 一律不画校准虚线轮廓
⑦ 目标判定 / 结算 / HUD（updateHud L7169）/ 调试面板（renderDebug L7368）
```

**训练子链路**：`feedDetector`（L8161）把帧喂给 `state.detector` 并取事件 →
`handleEvents`（L8272）分发（音效 / 语音报数 / 计次 / 要领 / 计分）→
`syncRuleEvents`（L8500）把 `rep / tick / idle / gate-*` 发到事件总线，规则引擎决定「说什么」。

**语音教练接线**（L401-L1100）：`createDiag` → `createAutoAsr`（火山优先、浏览器兜底）→
`createVolcTts` + `createTts`（降级）→ `createCoach`（界面）→ `createDanmaku` → `createBargeIn` →
`createLlmClient` → `createEventBus` + `createRuleEngine`（L584-L592）→ `createJudge` →
`createVoiceSession`（L969）。**app.js 只做接线**，状态机在 `voice/session.js`。

**R4 规则面板**（L751-L926）：`settings.ruleSwitches` 是唯一开关存储（`rep` / `read` 两个总开关 +
单条规则 id 的 `false`）。启动时 `applyRuleSwitches()`（L760）把关掉的规则从引擎摘掉；
`openSettings()`（L2889）→ `syncRuleCount()`（L924）→ `renderRulePanel()`（L798）按
`rulePanelRows()`（L771）重画列表；`setRuleEnabled()`（L853）关一条 = `remove` + 记 `false`、
开回 = 按 `builtinRules()` 的缺省定义 `add`；`resetRuleDefaults()`（L888）清用户 / LLM 规则并复位开关；
`setRuleChannelSwitch()`（L911）切两个总开关（`ruleState()` 里的 `repOn` / `readOn`，L596）。

**排课（每日单次计划，L2640-L3270）**：

```
① 存储三件套：readPlan / savePlan / readPlanProgress / savePlanProgress / readPlanHistory /
   pushPlanHistory / clearPlanData（L2655-L2750）—— 「清除训练记录」时三件套一起清（L10580 附近）
② buildTodayPlan（L2824）：planPrefs（目标 / 时长 / 器械 / 伤病，优先长期记忆 facts.goal / injuries）
   → plan.js 的 buildPlanTemplate 同步出模板 → 存盘 + 重画卡 → 后台 refinePlanWithLlm（L2890）
③ refinePlanWithLlm（L2890）：/llm {event:'plan-request'} → parsePlanJson → **validatePlan**
   不合法 / 失败 → 保留模板 + 记 plan:llm {ok:false}；合法 → source='llm' 替换
④ renderPlanCard（L2969）：首页卡片（标题 / 理由 / 每行动作 · 组数 × 目标 · 组间休息 / 汇总）
⑤ startPlanBlock（L3067）：**走命令快车道同一套入口**（voiceCommandCtx 的 startGestureMode →
   selectExercise → setTarget），并写进度
⑥ planAfterSet（L3149）：在 stopSession 末尾调用；reason='goal' → doneSets+1 → 组间休息
   （planRestThen L3050 → runPlanRest L3037）→ 下一组 / 下一个动作；全部做完 → finishPlan
⑦ finishPlan（L3209）：写 planHistory + progress.done → showHome() → session-end
   → 告别语里的 planFarewellStats（L3252）给出「今天 N 个动作 / 完成率」
```

## 4. 对外接口

- **没有 `export`**：这是浏览器 entry module，靠 DOM 事件与全局单例工作（`index.html` 里的
  按钮 id / `data-i18n` 属性就是它的外部契约）。
- 对内契约：`voiceCommandCtx`（L472）—— `voice/commands.js` 的每条 `run(ctx, args)` 只允许
  调用这里注入的函数，**命令表不碰 state**。R4 的规则面板函数（L751-L926）也挂在
  `window.__mfg`（L~10480）上给集成测试直接调。
- `index.html` 里所有 `id="…"` 都被 `$()`（L72）读取；改名必须同步改 HTML。

## 5. 与其它文件的关系

- 上游（全部 import，L6-L70）：`exercises` / `geometry` / `metrics` / `pose-engine` / `render` /
  `audio` / `calibration` / `specs` / `steps` / `icons` / `pose-log` / `i18n` + 整个 `voice/*`。
- 下游：`index.html`（DOM，含 R4 的 `#ruleList` / `#btnRuleRep` / `#btnRuleRead` / `#btnRuleReset` /
  `#ruleLimitHint`）、`style.css`（类名，R4 的 `.rule-*`）。
- 唯一「知道所有模块」的文件：改跨模块流程只能在这里接。

## 6. 易错点与设计取舍

- **每帧只调一次 `computeFrame`**（L8624）：重复调用会让 `legOut` 之类依赖帧的字段翻倍计算，
  也会拖慢帧率。
- **`groundY` 必须来自校准器**（L8625）：用脚踝临时估的地面会跟着跳跃 / 抬腿一起动。
- **状态分支漏写 `outline = null`** 会把校准轮廓带进训练画面（L8704-L8707 是硬兜底，
  新增分支时仍要自己清）。
- 倒计时有**定时器 + 时间判断**双保险（L8604-L8605）：只靠 `setTimeout` 在后台标签页会被节流。
- `settings.targets[id]` / `settings.seconds[id]` 是**按动作**存的：换动作不会丢目标。
- **规则开关只有一份存储**（R4）：`settings.ruleSwitches` —— `rep` / `read` 两个总开关 +
  单条规则 id 的 `false`。别在别处再记一份「关掉了哪些规则」；`applyRuleSwitches()` 只在启动时摘规则，
  `ensureDefaultRules()`（L655）补缺省规则时也要先看 `ruleSwitchOn`，否则用户关掉的规则会被重新打开。
- 这里所有面向用户的字符串都必须走 `t()`；写死中文会被 `test-i18n` 抓到。
- **排课的推进只挂在 `stopSession` 末尾**（L~7940 的 `planAfterSet(reason)`）：换动作 / 回主页
  都不该被当成「完成一组」；`startPlanBlock` 里 `planActive` 也是**切完动作之后**才置 true，
  否则 selectExercise → stopSession('switch') 会被误判成「用户手动停了计划」。
- 计划的三件套（`mfg.plan.v1` / `.progress.v1` / `.history.v1`）只在这里读写；`plan.js` 保持纯函数。
  告别语的计划数字来自 `state.planDone || readPlanProgress()`，所以 `showHome()` 里必须先
  `cancelPlanOnHome()` 保存进度、再发 `session-end`。进度里的 `started` 只在**点过开始**后置 true：
  仅仅在首页生成过计划（没开始练）时，告别语**不会**提「完成 0 个」。

## 7. 读代码建议（先看哪几行）

1. L6-L70 import 清单（一眼看到全项目依赖关系）；
2. L258-L370 `state` 字段（界面状态的全部词汇 + 排课执行游标）；
3. L8590 起 `loop()`（每帧顺序，读这一段比读 100 个函数有用）；
4. L401-L1070 语音链路接线（谁被包在谁外面）；
5. L751-L926 R4 规则面板（开关 / 列表 / 一键恢复默认）；
6. L2640-L3270 排课（三件套 / 卡面 / 执行 / 完成）；
7. L11017 起 `boot()`（启动顺序；排课在首屏前 `ensureTodayPlan()`）。
