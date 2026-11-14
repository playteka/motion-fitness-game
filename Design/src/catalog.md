# src/catalog.js — 19 个动作的配置表（一个动作 = 一条配置）

> 层：识别（数据） ｜ 422 行 ｜ 纯数据 + 两个纯函数
> 一句话：动作库里**没有判定代码**，只有「用哪个引擎、哪些参数、门控叫什么、默认目标多少」。

## 1. 它解决什么问题（为什么需要它）

19 个动作里只有少数值得手写状态机（`engine: 'builtin'`），其余全部交给
`engines.js` 的配置驱动引擎。把差异压成配置，好处是「加一个动作 ≈ 加一条数据」，
而且 `specs.js` / `icons.js` 能直接读同一份 `params` 去生成界面文案与图标（一处定义）。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 形状 | 说明 |
|---|---|---|---|
| `CATEGORIES` | L30-L36 | `{id, icon, key}[]` | upper / lower / core / full / stretch |
| `CATEGORY_MAP` | L38 | 对象 | id → 分类 |
| `bend(opts)` | L48-L56 | 函数 | 「屈伸一次」默认参数：`enterP .32 / bottomP .85 / backP .16 / looseP .55 / ignoreP .45 / minRepMs 380` |
| `e(id, icon, cats, opts)` | L58-L78 | 函数 | 生成一条动作配置（补齐 kind / engine / plan / view / posture / target / speakEvery …） |
| `EXERCISES` | L95-L413 | 19 条 | 上肢 2 / 下肢 5 / 核心 6 / 全身 4 / 拉伸 2 |
| `isTimedReps(meta)` | L85 | `boolean` | 计数类 + `seconds>0` = **限时计数**（开合跳 / 勾腿跳） |
| `targetUnitKey(meta)` | L88 | i18n 键 | 目标单位：计时与限时计数 = 秒，其余 = 次 |

一条配置的字段（L7-L23 有完整说明）：`id / icon / cats / kind / seconds / engine / plan /
view / posture / judge / target / unitKey / rough / speakEvery / params`。

## 3. 算法与流程（步骤化）

配置生成（`e()` L58-L78）决定的默认值：

```
kind     = opts.kind || 'rep'
engine   = opts.engine || (kind==='hold' ? 'hold' : 'bend')
plan     = opts.plan   || (kind==='hold' ? 'holdPose' : 'repStand')
view     = opts.view   || 'side'          posture = opts.posture || 'stand'
target   = opts.target || (kind==='hold' ? 30 : 12)
unitKey  = kind==='hold' ? SEC : REP      speakEvery = max(1, opts.speakEvery||1)
params   = opts.params || {}
```

`bend(opts)` 再补一层「屈伸」默认进度线，动作条目只写**差异**（例如俯卧撑把
`looseP` 从 .55 收到 .30，跪姿俯卧撑 .20）。每条动作上方的长注释就是它的调参史
（L97-L135 俯卧撑、L160-L174 跪姿、L188-L211 后箭步蹲 …），**改阈值前必须先读那一段**。

## 4. 对外接口

| 导出 | 位置 | 说明 |
|---|---|---|
| `EXERCISES` | L95 | 全部动作（顺序 = 动作库顺序） |
| `EXERCISE_MAP` | L415 | id → 配置 |
| `CATEGORIES` / `CATEGORY_MAP` | L30 / L38 | 分类 |
| `exercisesInCategory(catId)` | L418 | 该分类下的动作（保序） |
| `isTimedReps(meta)` / `targetUnitKey(meta)` | L85 / L88 | 限时计数判断、目标单位 |
| `default` | L422 | 上述对象的聚合导出 |

## 5. 与其它文件的关系

- 下游（读数据）：`engines.js`（`params` → 引擎行为）、`exercises.js`（`engine:'builtin'` 建手写识别器）、
  `steps.js`（按 `plan` 取计分方案）、`specs.js`（显示 `params` 与门控）、`icons.js`（按 `plan` 画图标）、
  `voice/commands.js`（动作名 / 枚举）、`calibration.js`（`view` / `posture` 决定校准轮廓）、
  `server/llm-tools.mjs`（`EXERCISE_IDS` 枚举）。
- 上游：无（叶子数据模块，只 import 无）。

## 6. 易错点与设计取舍

- **`posture` 不是装饰**：`calibration.js` 用它挑轮廓，`engines.js` 的 `supine*` 门控要它一致；
  写错会出现「校准说对、门控永远不过」。
- **`gate` 名必须真的存在于 `GATE_LIMITS`**（`engines.js` L92 起）：拼错不会报错，
  而是门控静默失效（`GATES[name]` 为 `undefined` 时按「不拦」处理）。
- **进度线不能重叠**：`backP` 必须 < `enterP`（俯卧撑注释 L133 特意强调），否则同一帧既是
  「回去」又是「开始」，状态机会抖。
- **`seconds` 与 `target` 是两件事**：限时计数时 `target` 按秒解释，成绩仍是次数（L81-L85）。
- 删动作时别只删条目：`README` 的动作计数、`specs`/`icons` 的映射、测试里的动作 id 都要一起动。

## 7. 读代码建议（先看哪几行）

1. L1-L24 头部字段说明（读一遍再改任何动作）；
2. L44-L88 三个工具（`REP`/`SEC`、`bend`、`e`、`isTimedReps`）；
3. L95-L135 俯卧撑（最典型的「配置驱动」样例 + 调参史）；
4. L366-L397 开合跳（`seconds`、`speakEvery`、`skipEnter` 都在这里）。
