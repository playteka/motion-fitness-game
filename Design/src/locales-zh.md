# src/locales/zh.js — 简体中文词条（唯一真源）

> 层：文案数据 ｜ 2080 行 ｜ 纯对象字面量，`export default`
> 一句话：全项目所有面向用户的中文都在这里；结构即契约，缺键会回退英文。

## 1. 它解决什么问题（为什么需要它）

`src/` 里**不允许出现中文字面量**（`tests/test-i18n.mjs` 会扫），所有文案必须来自词条。
中文这份是「真源」：先写中文，再让 `en.js` 保持**完全相同的键结构**（文件头 L1-L4 明说）。
`i18n.js` 用点分路径取词，缺失时回退英文，所以任何键写漏都不会让界面空白。

## 2. 关键数据结构 / 常量（表）

顶层分组（每个都是 `{…}`，键名点分访问）：

| 分组 | 位置 | 内容 |
|---|---|---|
| `meta` | L7 | `code / label / flag / htmlLang / speechLang / title` |
| `app` | L16 | 品牌名、副标题 |
| `ui` | L22 | 界面控件（按钮、设置项、模型名、快捷键说明…） |
| `diag` | L213 | 诊断面板（链路状态、帧率、字节率…） |
| `calib` | L241 | 校准引导语 |
| `status` | L280 | 状态提示（`status.need.*` 等，识别器 standby 用） |
| `phase` / `summary` / `debug` | L375 / L386 / L400 | 阶段名 / 结算摘要 / 🐞 面板 |
| `ex` | L502 | 每个动作的 `name / cameraHint / goal / howto / tips` |
| `steps` | L627 | 要领步骤名（`steps.*`，对应 `steps.js` 的 `labelKey`） |
| `cat` / `menu` / `home` / **`plan`** / `exercise` | L875-L1010 | 分类、菜单、主页、**排课（`plan.*`）**、运动设定 |
| `records` / `settings` / `memory` | L998 / L1004 / L1099 | 记录、设置、教练记忆面板（R4 的 `settings.rulesGroup` / `rulesLead` / `rulesReset` / `rulesOn` / `rulesOff` / `ruleLimit` / `repToggle` / `readToggle` / `ruleSwitchHint` 也在这里） |
| `judge` / `metric` / `spec` | L1133 / L1155 / L1200 | 判定依据、指标名、关键帧判据 |
| `cue` / `cues` | L1451 / L1529 | 通用提示 / 动作专属提示（`cues.<动作>.<code>`） |
| `fam` | L1472 | 「动作族」要领模板（`fam.<plan>.howto/tips`） |
| `music` | L1509 | 四首 BGM 的曲名 |
| `speech` | L1572 | 语音播报用语（报数 / 开始 / 鼓励） |
| `coach` | L1610 | AI 教练（状态、命令说法、面板、自检…；R4 诊断两行 `coach.diag.whySaid*` / `whySkip*` 与原因码 `coach.diag.reason.*` 也在这块；排课的确认语 `coach.cmdAck.makePlan*` 与告别语 `coach.sessionEnd.*Plan` 也在这里） |
| `voice` / `rule` | L2008 / L2029 | 语音状态名 / 规则描述（R4 的 `rule.source.*` / `rule.cond.*` 也在 `rule` 块） |

## 3. 算法与流程（步骤化）

本文件没有逻辑，只有**被读取的契约**：

```
t('ex.squat.name')        → 取到字符串（i18n.js 的 lookup 逐层下钻）
t('summary.missed', {list}) → 含 {list} 占位符，由 interpolate 替换
tList('ex.squat.howto')   → 数组（要领列表）
hasKey('cues.squat.valgus') → 识别器据此决定用专属文案还是通用文案
```

因此改键名 = 改接口：要同时改 `src/` 里的调用点、`en.js` 的同名键，以及
`tests/test-*.mjs` 里断言过的键。

## 4. 对外接口

| 导出 | 位置 | 形状 | 说明 |
|---|---|---|---|
| `default` | L6 | 嵌套对象 | 由 `i18n.js` 以 `LOCALES.zh` 引入 |

没有函数、没有副作用 —— 唯一的「接口」就是这个对象的键结构。

## 5. 与其它文件的关系

- 下游：`i18n.js`（唯一 import 者）；再经 `t()` 到 `app.js` / `exercises.js` / `specs.js` /
  `audio.js` / `voice/*`。
- 对照：`en.js` 必须同结构；`tests/test-i18n.mjs` 用 `flatten` / `localeKeys` 比对键集合，
  并检查中英 README 的标题数 / 表格行数 / 代码块数。

## 6. 易错点与设计取舍

- **中文是唯一真源**：新增文案先加这里，再补 `en.js`；反过来会缺键（界面显示键名）。
- 值可以是**数组**（要领 / 提示列表），取的时候用 `tList`，别直接塞进 `textContent`。
- 占位符统一 `{name}`（`i18n.js` L75-L78 的正则），不要写 `%s` / `${}`。
- 数字不要在这里拼成中文数词：报数走 `voice/numerals.js`（TTS 需要真正的数词）。
- 当前工作区版本里 `music` 键出现两次（L1446 与 L1457，内容相同）—— 后者覆盖前者，
  属冗余（待确认是否有意保留）。
- 改这里之后必须跑 `npm test`：`test-i18n` 会立刻报出中英不对称。

## 7. 读代码建议（先看哪几行）

1. L1-L20 `meta` + `app`（先看清文件形状）；
2. L22-L60 `ui`（界面主文案，改 UI 时常看）；
3. L1070-L1137 `judge` / `metric` / `spec`（识别相关文案，与 `specs.js` 一一对应）；
4. L1547 起 `coach`（语音教练的全部话术，最长的一块）。
