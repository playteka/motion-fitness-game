# src/exercises.js — 手写识别器 + 动作文案装配（19 个动作的「入口」）

> 层：识别（工厂 + 5 个手写识别器） ｜ 1136 行
> 一句话：`createDetector(id)` 是全项目唯一的「拿到动作实例」入口 —— 手写的走这里，其余转给引擎。

## 1. 它解决什么问题（为什么需要它）

绝大多数动作走配置驱动（`engines.js`），但有 5 个**判定最精细**的动作仍值得手写状态机：
深蹲（正面）、箭步蹲、臀桥、卷腹、平板。另外「动作 → 文案」的装配（名称 / 机位 / 要领 / 注意事项）
也只在这里做一次，`app.js` 只拿结果渲染。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 说明 |
|---|---|---|
| `SQUAT` | L118 | `= SQUAT_FRONT`（阈值与 `steps.js` 共用同一份常量） |
| `LUNGE` | L261 | 前后箭步蹲的阈值表 |
| `BRIDGE` | L571 | 臀桥阈值表 |
| `CRUNCH` | L826 | 卷腹阈值表（含「肩-髋距 / 躺平长度」比例） |
| `PLANK` | L1051 | 平板支撑阈值表 |
| `BUILTIN` | L1120-L1126 | 动作 id → 手写识别器类（只有 5 个键） |
| `bendPct(angle, straight, bent)` | L89 | 角度 → 0~100% 进度（进度条用） |

识别器类：`SquatDetector` L120、`LungeDetector` L297、`GluteBridgeDetector` L621、
`CrunchDetector` L855、`PlankDetector` L1067（继承 `HoldDetector`）。

## 3. 算法与流程（步骤化）

**工厂**（`createDetector` L1128-L1134）：

```
meta = EXERCISE_MAP[id]            // 不在目录里 → throw
Builtin = BUILTIN[id]              // 有手写的就用手写的
return Builtin ? new Builtin(meta, opts) : createEngineDetector(meta, opts)
```

**文案装配**（`localizedExercise` L43-L72）—— 每个动作必有的：`name` / `cameraHint` / `goal` /
`unit` / `targetUnit` / `judgeText`；可能缺失的：`howto` / `tips`，缺失时回退到**族模板**
`fam.<plan>.howto` / `fam.<plan>.tips`（L46-L48），所以界面永远不会出现空列表。
`poseIcon` 由 `icons.js` 的 `exercisePoseSVG(id)` 生成（L61）。

**五个手写识别器**的共同套路：`step(f, now)` 里维护一个小状态机（起始位 → 下沉/抬起 → 回位），
每帧只依赖 `metrics.js` 的字段；`diag()` 覆盖它以在 🐞 面板显示阶段 / 本轮峰值 / 判定线。
例如卷腹（L855 起）用「躯干倾角变小 **且** 肩-髋距缩到躺平的 70~80% 或头离地」两个证据取或，
全部与机位无关（不再依赖校准地面线）。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createDetector(id, opts)` | L1128 | → 识别器实例 | **唯一入口**；未知 id 抛错 |
| `localizedExercise(id)` | L43 | → 对象 | 含 `name/howto/tips/poseIcon/unit/targetUnit/…` |
| `localizedCategories()` | L75 | → 数组 | 分类带文案 |
| `localizedByCategory(catId)` | L80 | → 数组 | 该分类下的动作（带文案） |
| `exerciseUnit(id)` | L31 | → 字符串 | 「次」/「秒」 |
| `EXERCISES` / `EXERCISE_MAP` | L28 | 重导出 | 方便只 import 一个模块 |
| `DetectorBase` / `HoldDetector` / `CrunchDetector` | L1136 | 重导出 | 测试 / specs 用 |

## 5. 与其它文件的关系

- 上游：`catalog.js`（数据）、`steps.js`（`getStepPlan`、`SQUAT_FRONT`）、`engines.js`
  （`createEngineDetector` / `bodyLift` / `GATES`）、`icons.js`（`exercisePoseSVG`）、`i18n.js`。
- 下游：`app.js`（`createDetector` + `localized*`）、`specs.js`（读 5 个阈值表）、
  `tests/test-detectors.mjs`（直接 new 这些类）。
- 注意：本文件 import `engines.js`，而 `engines.js` **不** import 本文件（无循环）。

## 6. 易错点与设计取舍

- **文案不在这里写死**：`localizedExercise` 只拼 i18n 键，`src/` 里不允许出现中文字面量
  （`tests/test-i18n.mjs` 会扫）。
- **阈值表与 `steps.js` 必须同源**：`SQUAT = SQUAT_FRONT` 就是这个意思；分叉会出现
  「进度条说你蹲够了、识别器不计数」。
- 手写识别器只该留给「配置引擎表达不了」的动作；能配置的一律进 `catalog.js`（文件头 L84 明确）。
- `createDetector` 对未知 id 直接抛错，不做兜底 —— 让错误在开发期暴露。
- 俯卧撑曾从手写改回通用引擎（`catalog.js` L97-L135 的注释是完整复盘），
  说明「更复杂的手写」并不总是更好。

## 7. 读代码建议（先看哪几行）

1. L1120-L1136 `BUILTIN` + `createDetector`（先知道谁是谁）；
2. L43-L72 `localizedExercise`（文案回退规则）；
3. L89-L92 `bendPct`（进度百分比口径）；
4. 要改某个手写动作：先看它头顶那段注释（例如卷腹 L826 起），再动阈值。
