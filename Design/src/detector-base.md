# src/detector-base.js — 识别器基类：计分 / 提示节流 / 丢帧容忍 / 计时基类

> 层：识别（基类） ｜ 355 行 ｜ 不认任何具体动作
> 一句话：所有识别器（手写的与配置驱动的）共用的那层「跟动作无关」的骨架。

## 1. 它解决什么问题（为什么需要它）

19 个动作 × 每个都要输出「分数、步骤打勾、提示、丢帧、快照」，如果各写一遍必然不一致。
更关键的是 `engines.js` 也要继承同一套基类 —— 单独成文件是为了**避免
`exercises.js` ↔ `engines.js` 的循环依赖**（文件头 L4-L5 明说）。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 / 形状 | 说明 |
|---|---|---|---|
| `DetectorBase` | L16-L248 | class | 计分 / 提示 / 丢帧 / 快照 |
| `HOLD_PRIME_MS` | L276 | `250` | 计时类：姿势稳定这么久才开始计时 |
| `HOLD_GRACE_MS` | L277 | `1200` | 姿势垮掉在宽限内不停表 |
| `HoldDetector` | L279-L355 | class | 计时类基类（`checkHold` 由子类实现） |
| 状态字段 | L22-L41 | `reps/validReps/partialReps/holdMs/score/cycle/stage/peak/…` | 全部在构造函数里初始化 |

`plan`（L21）= `getStepPlan(meta.id, meta)`，即「要领 → 可判定步骤」清单（见 `steps.md`）。

## 3. 算法与流程（步骤化）

**每帧**：`update(f, now)` L172-L191

```
events = []
if (!f || !f.ok) {                         // 丢帧
  记 _lostSince；超过 400ms → phase='idle'、onLost()、standby='status.lostTracking'
  return events
}
_lastFrame = f
evaluateSteps(f, now)   // ① 先结算要领分
step(f, now)            // ② 再跑计数状态机（子类实现；引擎类在这里判门控/进度）
tickHoldScore(now)      // ③ 计时类的每秒得分
return events           // 事件由 app.js 取走 → 事件总线 → 规则/裁判
```

- **要领计分**（`evaluateSteps` L85-L108）：按 `plan.steps` 顺序第一次达成就加分，
  **一帧最多奖励 2 步**（L89，避免音效糊在一起）；`stepKey`（L79-L82）把「每轮一次」的
  步骤绑到 `cycle` 上。
- **整轮奖励**（`nextCycle` L116-L124）：本轮有有效次且该轮步骤全中 → 加 `repBonus`。
- **提示节流**（`cue` L162-L169）：同 `code` 在 `throttleMs`（默认 4500）内只出一次；
  文案键优先 `cues.<动作>.<code>`，没有就退回 `cue.<code>`（`resolveCueKey` L257-L265）。
- **计时类**（`HoldDetector.step` L313-L354）：`checkHold()` 通过累计 `okMs`；
  超过 `HOLD_PRIME_MS` 才开始计时并**补回**这段（L323-L329）；不通过累计 `badMs`，
  在 `HOLD_GRACE_MS` 内**暂停但不停表**；超了发 `hold:pause` 并给 `standby` 提示。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `DetectorBase` | L16 | `new (meta, opts)` | 子类实现 `step()` / 可覆盖 `onReset/onLost/onNewCycle` |
| `update(f, now)` | L172 | → `events[]` | 每帧唯一入口 |
| `snapshot()` | L228-L245 | → 对象 | `reps/score/cycle/steps/phase/active/standby/depthPct/feedback` |
| `stepStatus()` / `pendingHint()` | L127 / L142 | → 数组 / 对象 | 界面要领清单与「卡在哪一步」 |
| `diag()` | L217-L226 | → `[{key,value}]` | 🐞 面板用的结构化诊断行 |
| `reject(code, value)` | L208 | void | 记「这次没计上，因为…」（只给诊断） |
| `HoldDetector` | L279 | class | 子类实现 `checkHold() → {valid, reason}` |
| `setCueKeyResolver(fn)` | L255 | void | 把 `hasKey` 注入进来（避免初始化顺序问题） |

## 5. 与其它文件的关系

- 上游：`geometry.js`（`clamp`）、`steps.js`（`getStepPlan`）、`i18n.js`（经 resolver 间接用 `hasKey`）。
- 下游：`exercises.js`（`SquatDetector` 等继承它）、`engines.js`（`EngineDetector` / `AltRepDetector` /
  `SequenceDetector` / `HoldEngineDetector` 继承它）、`specs.js`（显示 `HOLD_PRIME_MS/HOLD_GRACE_MS`）、
  `app.js`（`snapshot()` 喂 HUD）。

## 6. 易错点与设计取舍

- **`update()` 里先计分再计数**的顺序不能换（L186）：否则「完成后半段要领」会晚一帧拿奖励。
- `_lastT` / `_lostSince` 是**内部计时基准**：暂停恢复时要调 `resetClock()`（L50），
  否则暂停时长会被算进这一轮。
- 丢帧阈值 **400ms** 写在 `update` 里（L177），计时类的宽限是另一个数（`HOLD_GRACE_MS`），
  两者别混。
- 事件不是回调，而是**攒在 `this.events` 里等 `update` 返回**：这样 Node 里能同步断言。
- `cue()` 的默认 `now` 是 `performance.now()`，注入时钟时务必要传（测试里）。
- `diag()` 默认只给 4 行；具体识别器覆盖它补内部状态（阶段、判定线、本轮峰值）。

## 7. 读代码建议（先看哪几行）

1. L16-L43 构造函数的字段清单；
2. L172-L191 `update()`（每帧顺序，最重要的 20 行）；
3. L313-L354 `HoldDetector.step()`（计时类的宽限逻辑）；
4. L162-L169 `cue()`（提示节流 + 文案键回退）。
