# src/voice/coach.js — 教练界面层（状态环 / 字幕面板 / 头像 / VU / 诊断面板）

> 层：语音（展示） ｜ 688 行 ｜ 不碰会话状态机，只渲染 `session.snapshot()`
> 一句话：把「聆听 / 思考 / 说话 / 出错」画成一个会呼吸的光环 + 两行字幕 + 音量反馈。

## 1. 它解决什么问题（为什么需要它）

语音链路是异步的，用户必须随时知道「它在听吗 / 它在想吗 / 它是不是坏了」。纯文字状态不够，
所以在舞台左下角放一颗小圆环：聆听时缓慢呼吸、思考 / 说话 / 出错换颜色，关闭后灰掉。
版面还要**不压住** HUD 左栏、右上角两颗圆环、判定进度条 —— 这需要一套纯函数布局。
R4 起它还负责 🐞 诊断面板的两行「刚才那句为什么说 / 为什么没说」：读 `diag.snapshot()`
的 `lastSpeak` / `lastSkip`，把**原因码**翻成人话。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 内容 | 说明 |
|---|---|---|---|
| `COACH_STATUS_KEYS` | L32-L44 | 状态 → i18n 键 | `voice.status.*` |
| `COACH_ROUTE_KEYS` | L45-L50 | 路由 → i18n 键 | 火山 / 浏览器 / 回退（诊断可见） |
| `COACH_PANEL_STATES` | L51 | `['listening','thinking','speaking','error']` | 面板四态 |
| `COACH_LAYOUT` | L57-L77 | 各区块的尺寸 / 间距常量 | 版面参数（一处定义） |
| `DIAG_REASON_KEYS` | L60-L93 | 原因码 → i18n 键 | R4：`rule:skip` / `judge:skip` / `judge:ask` 的原因码（`stride` / `cooldown` / `rep-off` / `judge-silent` …） |
| `coachRingPx(w)` / `coachCriteriaBarH(w)` | L78 / L86 | → 像素 | 响应式尺寸 |
| `coachLayout(size, opts)` | L103 | → 各区块矩形 | **纯函数**，测试直接断言不重叠 |

## 3. 算法与流程（步骤化）

```
app.js 每次状态变化 → coach.render(session.snapshot())
  → coachStatusKey(state, paused) L172 取文案键（走 i18n）
  → 状态环：颜色 / 呼吸动画按 state；level（VU）按音量调亮度与缩放
  → 字幕：`你：…` / `教练：…` 两行（aria-live="polite"，读屏会念）
  → 提示行：notice / error（网络异常、没听到声音、权限被拒…）
  → VU：用**会话层那一条共享麦克风** + AnalyserNode；拿不到流 → 静默降级成「按状态呼吸」
  → renderDiag L522：路由 / WS / 帧 / 码率 / 识别 / 错误 / 麦克风 / Worklet / TTS
      + R4 的两行：whySaidText L453 / whySkipText L467（read lastSpeak / lastSkip）
```

`coachLayout` 的两套版面（文件头 L19-L22）：宽屏字幕面板在判定进度条**正上方**（留出
`--criteria-bar-h`）；窄屏（≤560px）改贴舞台底部；两种都不压 HUD / 圆环 / 进度条。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createCoach({doc, win, vuFactory, diag, selfTest})` | L183 | → coach | `.render(snapshot)` / `.mount()` / `.toggleDiag()` / `.close()` |
| `coachLayout(size, opts)` | L103 | → 矩形集合 | 纯函数（测试断言不重叠） |
| `coachRingPx(w)` / `coachCriteriaBarH(w)` | L78 / L86 | → 像素 | 响应式尺寸 |
| `rectsOverlap(a,b)` | L94 | → boolean | 布局自检 |
| `coachStatusKey(state, paused)` | L172 | → i18n 键 | 状态文案 |
| `DIAG_REASON_KEYS` / `diagReasonText(code)` | L60 / L96 | 常量 / → 字符串 | R4：原因码 → 人话（未知码原样返回） |
| `COACH_*` 常量 | L32-L77 | 常量 | 状态 / 路由 / 面板 / 版面 |

## 5. 与其它文件的关系

- 上游：`i18n.js`（`t` / `hasKey`）、`icons.js`（`libIconSVG('ui:coach')` 头像）、`voice/session.js`
  （`voiceErrorKey` / `voiceNoticeKey` 与 `snapshot()` 形状）、`voice/providers.js`
  （`createVuMeter` / `smoothLevel` / `levelToColor`）、`voice/pcm.js`（`EXPECTED_BYTES_PER_SEC`）。
- 下游：`app.js`（`createCoach` L417 + 每次状态变化调 `render`）。
- 诊断面板的字段来自 `voice/diag.js` 的 `snapshot()`（`lastSpeak` / `lastSkip` 在 L145-L146）。
- 版面与 `style.css` 的 `--criteria-bar-h` 等变量耦合：改 CSS 变量要同步 `COACH_LAYOUT`。

## 6. 易错点与设计取舍

- **不碰会话状态机**：只读 snapshot，所以状态机可以在 Node 里跑、界面层可以单独测布局。
- **绝不另开一路 `getUserMedia`**（L12-L14）：VU 必须用会话层那条共享流；拿不到就降级，
  否则页面上会出现两个麦克风占用（用户看到小红点）。
- **诊断只读快照、不猜原因**（R4）：两行文本完全来自 `lastSpeak` / `lastSkip`；
  原因码缺词条时原样显示（排障优先），不要在这里写死中文。
- 文案全部走 locales（`coach.*` / `voice.*`）：切语言只要重新 `render` 一次。
- 布局是**纯函数**：不要在 `coachLayout` 里读 DOM 尺寸，由调用方传 `size`。
- 状态环的呼吸动画是「低频」的：太快会分散注意力，也会让 `prefers-reduced-motion` 用户难受。
- 错误与提示分两级（`error` 落状态、`notice` 只多一行）：不要把所有问题都变成红色错误态。

## 7. 读代码建议（先看哪几行）

1. L1-L23 头部（做哪四件事、版面约定）；
2. L57-L110 `COACH_LAYOUT` + `coachLayout`（唯一需要理解的几何）；
3. L172-L183 `coachStatusKey` + `createCoach` 入口；
4. L60-L100 `DIAG_REASON_KEYS` / `diagReasonText` + L438-L476 诊断两行的取数（R4）；
5. 渲染函数里的 VU 分支（拿不到共享流时的降级路径）。
