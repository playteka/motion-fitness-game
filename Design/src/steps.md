# src/steps.js — 动作要领 → 可判定步骤（计分方案表）

> 层：识别（判据数据） ｜ 741 行 ｜ 纯数据 + 几个取值函数
> 一句话：把「照着要领做」翻译成「满足这个条件就 +N 分」，进度条上的每一格都来自这里。

## 1. 它解决什么问题（为什么需要它）

如果分数只由识别器内部算，用户看不懂「为什么这组 61 分」。所以每个动作都有一份
**步骤清单**：每一步 = 一个可判定的条件 + 分值 + i18n 键（+ 可选 `hint` 解释为什么不达标）。
`DetectorBase.evaluateSteps()` 逐帧检查它，界面用 `stepStatus()` 打勾，`specs.js` 用它生成
「关键帧判据」弹窗，`icons.js` 用它画进度条上的姿态图标 —— 三处共用一份数据。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 说明 |
|---|---|---|
| `legDrop(f, side)` | L29 | 小腿「离地比例」：1 ≈ 站立，0 ≈ 跪地 |
| `backSide(f)` | L38 | 后腿 = 膝盖更低的那条（箭步蹲用） |
| `ankleSpread(f)` | L43 | 两踝前后距离 ÷ 躯干长 |
| `straight` / `aligned` / `supine` / `prone` | L49-L58 | 常用姿势谓词（身体成直线 / 髋线偏移 / 仰卧屈膝 / 俯撑） |
| `SQUAT_FRONT` | L71 | 深蹲（正面）共用阈值 —— 识别器与计分**同一套数字** |
| `squatDepthPct(hipAboveKnee)` | L81 | 蹲深百分比（界面进度） |
| `STEP_PLANS` | L103-L720 | 方案表：`plan 名 → { steps, repBonus, perCycle, pointsPerSecond }` |

一个 step 的形状：`{ id, labelKey, points, perCycle?, check(frame, det), hint?(frame, det) }`。
`check` 返回 `true` 即达标；`hint` 返回 `{key, params}` 告诉界面「差在哪」。

## 3. 算法与流程（步骤化）

**取方案**（`getStepPlan` L728-L731 → `planKeyOf` L737-L741）：

```
若 STEP_PLANS[动作id] 存在 → 用动作自己的方案（最初的 6 个动作）
否则用族方案 STEP_PLANS[meta.plan]（19 个动作库都走这条）
都没有 → 空方案 { steps: [], repBonus: 0, perCycle: true, pointsPerSecond: 0 }
```

**每帧判定**（消费方在 `detector-base.js` L85-L108）：按 `steps` 顺序，未完成的逐条调
`check(f, det)`；命中即 `score += points` 并发 `step` 事件；**一帧最多 2 步**。
`perCycle !== false` 的步骤每轮重置（`stepKey` 绑 `cycle`），否则整组只算一次（计时里程碑）。

**进度条映射**：`app.js` 用 `specStages` / `stageIndexForStep`（`specs.js`）把每个 step 分到
「第几格」，于是「某一格点亮」= 对应步骤刚达标。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `getStepPlan(exerciseId, meta)` | L728 | → `{steps, repBonus, perCycle, pointsPerSecond}` | 取方案（缺省空方案） |
| `planKeyOf(exerciseId, meta)` | L737 | → `string \| null` | 实际使用的方案键（动作 id 或族名） |
| `SQUAT_FRONT` | L71 | 常量 | 深蹲阈值（`exercises.js` 也 import） |
| `squatDepthPct(hipAboveKnee)` | L81 | → 百分比 | 蹲深显示 |
| `legDrop` / `backSide` / `ankleSpread` | L29 / L38 / L43 | 纯函数 | 常用几何谓词 |
| `STEP_PLANS` | L103 | 常量 | 全部方案（`specs.js` 只读不用改） |

## 5. 与其它文件的关系

- 上游：`geometry.js`（`LM`）、`catalog.js`（`EXERCISE_MAP`，用于 `planKeyOf` 回查）。
- 下游：`detector-base.js`（每帧跑步骤）、`engines.js`（继承基类后自动获得步骤判定）、
  `exercises.js`（`getStepPlan` + `SQUAT_FRONT`）、`specs.js`（判据弹窗）、
  `app.js`（`getStepPlan` 给 HUD 分格）。
- 本文件**不** import 识别器（否则循环）。

## 6. 易错点与设计取舍

- `check(f, det)` 里的 `det` 是识别器实例：可以读内部状态（例如「这一轮是否已下蹲过」），
  但**不要**在里面改状态（纯查询），否则同一帧多步判定会互相影响。
- `hint` 只应在「已知 `f.ok`」时调用（`detector-base.js` L147 已做保护）。
- **方案键与动作 id 会重名**：`planKeyOf` 先查动作 id 再查族名，所以「动作自己的方案」优先。
- 改阈值时优先改 `catalog.js` 的 `params` / `engines.js` 的门控表；只有**要领步骤**本身
  该变时才动这里，否则 `specs.js` 显示的数字会和识别器脱钩。
- 本文件里的字符串一律是 i18n 键，不写中文（`tests/test-i18n.mjs` 会扫）。

## 7. 读代码建议（先看哪几行）

1. L1-L19 头部（`check` / `hint` / `perCycle` 三个约定）；
2. L103-L140 `STEP_PLANS` 开头一两个方案（看清结构就够）；
3. L728-L741 `getStepPlan` / `planKeyOf`（回退顺序）；
4. L49-L58 四个谓词（后面所有方案都在用）。
