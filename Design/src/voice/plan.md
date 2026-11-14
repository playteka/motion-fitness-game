# src/voice/plan.js — 排课（每日单次计划）：模板 / 校验 / 执行队列

> 层：语音（计划） ｜ 689 行 ｜ **纯函数**：不碰 DOM、不读写 localStorage、不联网
> 一句话：「今天练什么」→ 按目标 / 时长 / 器械 / 伤病 / 最近训练排一份计划，并回答「这份计划能不能执行」。

## 1. 它解决什么问题（为什么需要它）

用户原话：「今天练什么」→ 一份可执行计划 + 一键开始（**只做每日单次计划**，不做 4 周周期）。

把它做成纯函数有三个理由：
① **断网 / 没配 LLM 也必须能用** —— 模板是确定性算出来的，语音说「今天练什么」零延迟；
② **安全性可测** —— 伤病禁忌、时长预算、动作库 id 全部在这一个文件里判定，
   LLM 微调回来的计划**必须**过同一个 `validatePlan()`，不合法就回退模板；
③ **执行与展示解耦** —— `planToQueue()` 把计划摊成「一组一步 + 组间休息一步」，
   `app.js` 只照着队列走（依次 startWorkout），计划本身不掺 UI 逻辑。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `PLAN_GOALS` | L31 | `fatLoss` / `muscle` / `endurance` / `posture` | 四个目标（用户口径：减脂 / 增肌 / 体能 / 体态） |
| `PLAN_GEAR` | L34 | `none` / `dumbbells` / `band` | 器械三档 |
| `PLAN_INJURIES` | L37 | `knee` / `waist` | 只做两个最常见的伤病维度 |
| `PLAN_DEFAULT/MIN/MAX_MINUTES` | L42-L44 | `20 / 5 / 120` | 时长预算（分钟） |
| `PLAN_MIN_BLOCKS` / `PLAN_MAX_BLOCKS` | L46-L47 | `2 / 6` | 结构：≥2 个、≤6 个动作（用户要求） |
| `PLAN_MIN/MAX_SETS` | L49-L50 | `1 / 4` | 每个动作的组数 |
| `PLAN_MIN_REPS` / `PLAN_MIN_HOLD_SEC` / `PLAN_MIN_TIMED_SEC` | L52-L54 | `5 / 15 / 20` | 目标下限 |
| `PLAN_REP_SECONDS` | L56 | `3` | 计次动作每组时长估算（每次 3 秒） |
| `PLAN_MAX_REST_SEC` | L58 | `180` | 组间休息上限（LLM 给 600 秒也不接受） |
| `PLAN_HISTORY_MAX` / `PLAN_RECENT_MAX` | L60-L62 | `10 / 20` | 历史 10 个 / 最近训练 20 条 |
| `INJURY_BANS` | L73 | 两个数组 | knee → `lungeJump/squatJump/squat/lunge/lungeBack/burpee`；waist → `bridge/crunch/reverseCrunch` |
| `INJURY_SWAPS` | L82 | 映射 | 禁忌命中后的替代动作（`squat → squatSumo`、`bridge → deadBug` …） |
| `INJURY_WORDS` | L98 | `\u` 转义词表 | 中文「膝盖 / 腰」+ 英文 knee / waist 都认（源码不留写死中文） |
| `GEAR_ADJUST` | L104 | 三档 | 负重时计次目标下调（0.8 / 0.9）、休息 +10 / +5 秒、备注 key |
| `TEMPLATES` | L114 | 5 套 | 减脂全身循环 / 增肌上肢 / 增肌下肢 / 体能间歇 / 体态核心+拉伸 |

计划对象（`buildPlanTemplate` 的返回 / `mfg.plan.v1` 的内容）：

```js
{
  title, rationale, source: 'template' | 'llm',
  blocks: [{ exerciseId, sets, target, restSec, note, name }],
  goal, minutes, gear, injuries, focus, variant,
  actions, sets, seconds, createdAt,
}
```

## 3. 算法与流程（步骤化）

```
buildPlanTemplate({goal, minutes, gear, injuries, recent, variant})        L398
  ① normalizePlanOptions（脏值退回安全值）                                 L236
  ② muscle 目标：muscleFocus(recent) 按最近 7 天上下肢组数挑**练得少**的那半   L265
  ③ 取模板 → rotate(variant)（「换一个」换起手动作）                         L314 / L280
  ④ 禁忌过滤：命中 INJURY_BANS → INJURY_SWAPS，替代动作也要过检查、去重      L200
  ⑤ makeBlock：按 GEAR_ADJUST 下调计次目标、加休息、拼 note 文案              L323
  ⑥ shrinkToBudget：超预算时 ①减组数 → ②目标降 20% → ③丢最后一块（≥2）→ ④休息减半  L351
  ⑦ 标题 / 理由走词条（plan.title.* / plan.rationale.*），汇总 actions/sets/seconds
```

**校验**（`validatePlan(plan, {minutes, injuries, catalog})` L477）返回 `{ok, reasons[]}`，
reason 是**稳定码**（不是中文）：`bad-shape` / `bad-title` / `no-blocks` / `too-few-blocks` /
`too-many-blocks` / `unknown-exercise:<id>` / `duplicate-exercise:<id>` / `bad-sets:<i>` /
`bad-target:<i>` / `bad-rest:<i>` / `banned:<id>` / `over-budget:<秒>`。`catalog` 可注入（测试用假库）。

**执行队列**（`planToQueue(plan)` L528）：每组一个 `set` 步，组与组之间插一个 `rest` 步
（最后一组后面没有休息）；`queueTotals(queue)` L549 汇总组数与预计秒数。

**LLM 微调**：`buildPlanRequest` L571 只带 `{goal, minutes, gear, injuries, recent20, template}`；
`parsePlanJson` L618 容忍 ```json 围栏 / 前后解释 / `{plan:{…}}` 包一层，返回 `{ok, plan, reason}`，
**合法性一律交给 `validatePlan`**（本文件不做安全判定之外的裁剪）。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `buildPlanTemplate(opts)` | L398 | → plan | 模板计划（唯一来源） |
| `validatePlan(plan, opts)` | L477 | → `{ok, reasons}` | LLM 计划必须过这一关 |
| `planToQueue(plan)` | L528 | → 队列数组 | 执行顺序（组 + 休息） |
| `planTotals(plan)` / `estimateBlockSeconds(block)` / `perSetSeconds(block)` | L224 / L217 / L207 | → 秒 / 汇总 | 时长预算（校验与模板**同一套**） |
| `normalizeInjuries(raw)` / `isBannedExercise(id, injuries)` | L185 / L200 | → 数组 / boolean | 伤病归一化与判定 |
| `muscleFocus(recent)` / `recentForPlan(recent)` | L265 / L245 | → `{focus,upper,lower}` / 数组 | 增肌分化 |
| `buildPlanRequest(opts)` / `parsePlanJson(raw)` | L571 / L618 | → 对象 | `/llm` plan-request 的两端 |
| `shrinkToBudget(blocks, sec)` | L351 | → 数组 | 预算收缩（纯函数，测试直接调） |
| `exerciseName` / `targetUnit` | L296 / L303 | → 文案 | 计划里的动作名 / 单位 |

## 5. 与其它文件的关系

- 上游：`i18n.js`（`t`，标题 / 理由 / 备注全部走词条）、`catalog.js`（`EXERCISE_MAP` / `isTimedReps`）。
- 下游：`app.js`（存储三件套 / 卡面 / 执行 / 告别语）、`src/voice/commands.js`（三条零 LLM 口令）、
  `src/voice/llm.js`（`LLM_EVENT_PLAN_REQUEST` + `requestPlan()`）、
  `server/llm-tools.mjs`（system prompt 的 schema 与禁忌表**直接读这里的常量**）、
  `server/llm-provider.mjs`（`planRequestEventMessage` 拼 user 消息）。
- 测试：`tests/test-voice.mjs` 的 `[42]`（模板 / 禁忌 / 预算 / 校验 / 队列 / 事件）与
  `tests/test-app.mjs` 的 `[56]`（卡面 / 微调回退 / 执行 / 三件套）。

## 6. 易错点与设计取舍

- **预算估算与校验必须同一套函数**：模板生成用它收缩、`validatePlan` 用它判超时，
  两边各写一份就会出现「模板自己都过不了校验」。
- **禁忌是保守的**：宁可少排一个动作，也不让伤痛期用户做禁忌动作；替代动作本身也要再过一遍禁忌。
- **LLM 计划绝不放行未校验的 id**：`parsePlanJson` 只做形状归一化，`validatePlan` 才是安全闸门；
  `app.js` 的 `refinePlanWithLlm()` 在任何一步失败时**保留模板**并记 `plan:llm {ok:false}` 诊断。
- **`shrinkToBudget` 的终态**：2 个动作都到目标下限、休息减到 0 还超预算 → 停止收缩（不再砍到 1 个动作），
  由 `validatePlan` 或调用方负责；这是有意为之（结构 ≥2 个动作比「刚好不超时」更重要）。
- **`variant` 只旋转模板顺序**，不改目标 / 组数；「换一个」必须真的换出不同 signature（app 里连试 8 次）。
- 源码里**不写死中文**（伤病词用 `\u` 转义）：`tests/test-i18n.mjs` 会扫 `src/**/*.js`。

## 7. 读代码建议（先看哪几行）

1. L26-L62 常量（目标 / 器械 / 边界值，先看清规模）；
2. L66-L180 禁忌表 + 替代 + 五套模板（安全边界在这里）；
3. L398-L475 `buildPlanTemplate`（选择 / 过滤 / 预算 / 标题的完整流程）；
4. L477-L545 `validatePlan` + `planToQueue`（安全闸门与执行队列）；
5. L571-L660 `buildPlanRequest` + `parsePlanJson`（LLM 微调的两端）。
