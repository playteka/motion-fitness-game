# src/engines.js — 配置驱动的通用识别引擎（门控 + 进度 + 五种引擎）

> 层：识别（引擎） ｜ 1546 行 ｜ 全项目最大的判定逻辑文件
> 一句话：绝大多数动作不用写代码 —— 只要有 `params`，这里就能判「姿势对不对、做到位没有、算不算一次」。

## 1. 它解决什么问题（为什么需要它）

19 个动作不可能各写一个状态机。把「一次动作」抽象成三件事就能覆盖大部分：
① **门控**（人是不是处在做这个动作应有的配置里）；② **一个随时间来回变化的量**（膝角 / 肘角 /
髋角 / 离地高度 / 左右交替…）；③ **进度** `progress = (up − v) / (up − down)`。
计数口径只有一种（用户取消了严格模式）：峰值过计次线就算一次，动作不标准只用语音纠正 + 分数打折。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 说明 |
|---|---|---|
| `GATE_GRACE_MS` | L42 | `400`：门控掉一下不清空本轮（≈10 帧） |
| `KNEE_PUSHUP_SETUP` | L85-L90 | 跪撑判据**唯一来源**（髋角 [120,180]、髋比膝 ≥0.15、肩比髋 ≥0.10、膝离地 ≤0.50） |
| `GATE_LIMITS` | L92-L259 | 门控阈值表 `[min,max]`（null = 不限），`specs.js` 直接读它显示 |
| `inLimit(v,[min,max])` | L261 | 区间判定（null 侧不限制） |
| `GATES` | L279-L377 | 门控名 → 判定函数（`stand` / `standWide` / `standUpright` / `proneUpright` / `kneelPushup` / `supineFlat` / `seatedFold` …） |
| `GATE_HINT` / `GATE_FAIL_HINT` | L378 / L400 | 门控没过时的提示键；跪撑有逐条细分 |
| `LEG_STRAIGHT_MIN` | L411 | `130`：腿「算绷直」的膝角宽容线 |
| `METRICS` / `SIDE_METRICS` | L422 / L454 | 指标名 → 从 frame 取值（`deg` / 左右取更弯） |
| `ADVISORY_LIMITS` + `ADVISORY` | L486 / L723 | 「建议项」：只提醒、不拦计数（塌腰 / 撅臀 / 腿没绷直） |
| `SEQ_STAGE_LIMITS` | L1365 | 波比跳四阶段（stand/crouch/plank/jump）的判据 |

## 3. 算法与流程（步骤化）

**主引擎 `EngineDetector.step()`** L670-L761（bend 类动作走这里）：

```
lift = bodyLift(...)                       // 离地高度（跳跃用，L522）
gate = GATES[gateName] || GATES.stand
if (!gate(f)) {                            // ① 门控
   active=false；standby=提示键；_badFrames++
   连续 25 帧不过 → cue('notReady')（9s 节流）
   若 now-_badSince > GATE_GRACE_MS → 清 stage/repStartAt/peak/progress
   return
}
if (p.flight && lift > flightMin) flightSeen = true
pr = clamp(progressOf(metric(f)), 0, 1.25) // ② 进度，0=起始 1=到位
ADVISORY[gate]?(f, this, now)              // ③ 建议项只提醒
if (stage === 'up') { pr>=enterP → stage='work'、记 repStartAt/peak；return }  // ④ 起点
peak = max(peak, pr)                       // ⑤ 追踪本轮峰值
pr <= backP 且稳定 ≥ flightGraceMs → finish()   // ⑥ 回到起始 → 结算
now-repStartAt > maxRepMs → 安静作废这一轮        //    卡半路太久
```

**结算 `finish()`** L763-L811：`peak < ignoreP` → 只当晃了一下（什么都不发）；
`peak < looseP` → 半程 + `moreRange`；跳跃类没真离地 → `needJump`；用时 < `minRepMs` →
`tempo`「太快了」；否则 `validReps++` 并给质量分（`56 + 深度/跳跃加成`，夹 0~100）。
**计次发生在「推回起始位」那一帧**，所以数出来的一定是完整的一下一上。

**其余四种引擎**（同一文件）：

| 引擎 | 位置 | 口径 |
|---|---|---|
| `bend`（`EngineDetector`） | L536-L812 | 一个来回 = 一次（上面这段） |
| `alt`（`AltRepDetector`） | L819-L1300 | 左右交替：两侧各「做过」一次算一次；有 `altMetric` 第二路证据（如勾腿跳的 `kick`） |
| `twist` | L1306-L1360 | 左右转体：`wristTwist` 左右各一次算一次 |
| `sequence`（`SequenceDetector`） | L1384-L1460 | 顺序走完 `stages` 才算一次（波比跳），`windowMs` 内有效 |
| `hold`（`HoldEngineDetector`） | L1468-L1530 | 计时类：`checkHold` 只判门控 + 姿势 |

`createEngineDetector(meta)` L1535-L1546 按 `meta.engine` 选类（默认 bend）。

## 4. 对外接口

| 导出 | 位置 | 用途 |
|---|---|---|
| `createEngineDetector(meta, opts)` | L1535 | 工厂：返回对应的识别器实例 |
| `GATES` / `GATE_LIMITS` / `GATE_HINT` | L279 / L92 / L378 | 门控（`specs.js`、`app.js` 直接读） |
| `METRICS` / `SIDE_METRICS` | L422 / L454 | 指标取值表（`pose-log.js` 也读） |
| `bodyLift(det, f, now)` | L522 | 离地高度（跳跃类） |
| `inLimit(v, [min,max])` | L261 | 区间判定 |
| `SUPINE_GATES` / `isSupineGate` | L419-L420 | 「仰卧类」门控名（`icons.js`/`specs.js` 复用） |
| `SEQ_STAGE_LIMITS` / `LEG_STRAIGHT_MIN` / `ADVISORY_LIMITS` | L1365 / L411 / L486 | 界面显示用的同一份数值 |

## 5. 与其它文件的关系

上游：`detector-base.js`（基类）、`geometry.js`（`clamp`）、`catalog.js`（`params` 由 `meta` 带进来）。
下游：`exercises.js`（`createDetector` 分派到这里）、`specs.js`（显示阈值）、`icons.js`（画姿态）、
`voice/rules.js`（`GATE_HINT` → 门控纠正话术）、`pose-log.js`（`SIDE_METRICS`）、`app.js`。

## 6. 易错点与设计取舍

- **门控掉一下 ≠ 这一轮作废**：`GATE_GRACE_MS` 就是为「后箭步蹲后膝贴地」这类掉帧加的；
  去掉它会立刻复现「做到最深时反而『太快了』不计次」。
- **门控阈值一律正数版**：用 `shoulderAboveHip`（正 = 肩在上），**不能**用 `hipRise`
  （相反数，臀桥专用）。历史上写反导致勾腿跳永远「没进入姿势」。
- **`up`/`down` 只是参考值**：`progressOf` 用的是 `effUp`（最近 1.5s 用户自己撑得最直的角度），
  所以浅一点也算——这是俯卧撑「做几个一个都没计上」的修复。
- **两路证据取「或」**（`altMetric` / `otherHold`）：快节奏采样变浅时，第二路跨度量兜底。
- **`ignoreP` 是静音线**：低于它连提示都不发，否则「只是抖了一下」会被念一句。
- `ADVISORY` 只提醒不拦计数 —— 这是产品口径（用户要「大体做到就计次数」），别改成拦。

## 7. 读代码建议（先看哪几行）

1. L1-L14 计数口径（唯一一种宽松模式的定义）；
2. L261-L377 门控表与 `GATES`（判「能不能开始」）；
3. L670-L811 `step()` + `finish()`（核心 140 行，先看这两段）；
4. L42 + L662-L668 `GATE_GRACE_MS` 与 `progressOf`；
5. 需要改某个动作阈值时，去 `catalog.js` 该动作的 `params`，**不要**改这里。
