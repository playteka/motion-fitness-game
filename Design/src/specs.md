# src/specs.js — 每个动作的「关键帧判据与判分」文案数据

> 层：识别（展示口径） ｜ 1368 行 ｜ 只读其它模块的常量，不参与判定
> 一句话：🎯「运动设定」弹窗里列的每一个数字都来自这里，而这里的每个数字都直接取自识别器。

## 1. 它解决什么问题（为什么需要它）

用户想知道「到底要蹲多深才算一次」。如果界面自己抄一份数字，改了识别逻辑就会出现
「弹窗说 30°、识别器判 25°」。所以本文件**不定义任何阈值**，只 import 识别器的常量
（`GATE_LIMITS` / `SEQ_STAGE_LIMITS` / `HOLD_PRIME_MS` / 各动作 `params`）再拼成条目。
文件头 L6-L13 把这条约定写死了。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 形状 | 说明 |
|---|---|---|---|
| `roundFor(v, unit)` | L56 | 数 | 按单位取整（`deg` 取整、`torso` 两位…） |
| `METRIC_UNITS` | L63 | 映射 | 单位名 → 显示后缀 |
| `BUILDERS` | L640-L647 | 映射 | 6 个动作有**专门**的判据生成器（squat / lunge / bridge / plank / crunch / seatedForwardFold） |
| `SPEC_METRICS` | L699 | 映射 | `metricKey` → 当前帧数值（进度条逐帧判断用，与识别器同源） |
| `SPEC_OP` | L1323 | 映射 | `lte/gte/lt/gt/range` → 文案 |

一条 item：`{labelKey, metricKey, op, value, value2, unit, noteKey, noteParams}` 或
`{labelKey, textKey, noteParams}`（无可计算数值时）。单位：`deg/torso/shin/lift/s/count/ratio`。

## 3. 算法与流程（步骤化）

**判据**（`exerciseSpecs(id)` L657-L673）：

```
meta = EXERCISE_MAP[id]（不存在 → 空 groups）
parts = BUILDERS[id]?.() ?? 按 meta.engine 分派 alt / twist / sequence / hold / bend
groups = [计次 spec.group.count, 姿势 spec.group.posture, 建议 spec.group.advice]（空组丢掉）
```

**进度条格子**（`specStages(id)` L913 起）：从 `count` 组里按识别顺序摊成一格一格，
**最后一格就是计次发生的那一刻**（文件 L900-L911 的约定）。门控格单独处理：
有真实门控的动作直接把识别器的 `gateOk` / `active` 挂上去（L923-L936），
深蹲 / 箭步蹲没有门控时退回数值判据；`seatedForwardFold` / `crunch` 的第一格走自己的分支。

**每帧**（`stageHolds(stage, frame, det)` L773）：用 `SPEC_METRICS` 取值 + `op/value` 比较，
判断这一格过没过；界面点亮它。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `exerciseSpecs(id)` | L657 | → `{id, engine, groups}` | 弹窗三组判据 |
| `specKeys(id)` | L676 | → `string[]` | 面板用到的全部 i18n 键（测试对照中英） |
| `specStages(id)` | L913 | → stage[] | 进度条格子（末尾即计次） |
| `stageHolds(stage, frame, det)` | L773 | → boolean | 这一格当前是否满足 |
| `stagePoints(id)` / `stageIndexForStep(id, stepId)` | L1274 / L1292 | → 数组 / 数 | 每格分值、步骤 → 格的映射 |
| `stageText(stage)` / `specCondition(it)` / `specValueText(v,unit)` | L1311 / L1338 / L1328 | → 字符串 | 文案拼装 |
| `specTextRows(id)` | L1353 | → 行数组 | 帮助面板 / 导出用 |
| `SPEC_METRICS` / `SPEC_OP` / `METRIC_UNITS` | L699 / L1323 / L63 | 常量 | 取值与符号 |
| `HORIZONTAL_TILT` | L1368 | 重导出 | 供界面显示 |

## 5. 与其它文件的关系

- 上游（只读）：`engines.js`、`metrics.js`、`detector-base.js`、`steps.js`、`catalog.js`、
  `exercises.js`（6 个手写阈值表）、`i18n.js`（`t` 拼文案）。
- 下游：`app.js`（弹窗 / 进度条 / HUD）、`tests/test-specs.mjs`（逐动作对照「图标角度 = 判据角度」）。

## 6. 易错点与设计取舍

- **不许在这里写数字**：只允许 `import` 常量后换算。出现字面量阈值就是 bug（会与识别器漂移）。
- `groups` 空组要被 `filter` 掉（L671）：否则弹窗会出现空标题。
- 进度条只收「计一次必须满足」的判据；深度 / 满分那类**不进链**（L908-L909），
  否则会把后面的格子卡住，与「最后一格点亮 = 已计次」矛盾。
- `SPEC_METRICS` 与 `stageHolds` 必须一起改：前者是「取什么值」，后者是「怎么比」。
- 「或」门控（仰卧类）要显示成「A 或 B」（L937-L939 的 `alt` 标记），不能写成两条都必须。

## 7. 读代码建议（先看哪几行）

1. L1-L34 头部的条目结构与单位约定；
2. L640-L687 `BUILDERS` + `exerciseSpecs` + `specKeys`（分派全貌）；
3. L900-L913 `specStages` 上方的「最后一格 = 计次」约定；
4. L699-L760 `SPEC_METRICS`（取值表）。
