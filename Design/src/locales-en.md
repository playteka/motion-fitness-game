# src/locales/en.js — 英文词条（与 zh.js 同结构）

> 层：文案数据 ｜ 2027 行 ｜ 纯对象字面量，`export default`
> 一句话：英文界面 / 英文语音的全部文案，**键结构必须与 `zh.js` 完全一致**。

## 1. 它解决什么问题（为什么需要它）

界面支持中英切换（`i18n.js` 的 `setLang`），英文既是可选语言，也是**兜底语言**：
`t()` 在当前语言找不到键时会回退到英文（`i18n.js` L85-L88）。所以这份文件必须比中文更完整，
否则兜底会兜到「键名」上。

## 2. 关键数据结构 / 常量（表）

与 `zh.js` 一一对应的顶层分组（顺序与位置基本同步）：

| 分组 | 位置 | 内容 |
|---|---|---|
| `meta` | L7 附近 | `code:'en' / label / htmlLang:'en' / speechLang:'en-US' / title` |
| `app` / `ui` | L16 起 | 品牌、界面控件 |
| `diag` / `calib` / `status` / `phase` / `summary` / `debug` | 中段 | 诊断、校准、状态、结算 |
| `ex` / `steps` / `cat` / `menu` / `home` / `exercise` | 中段 | 动作文案与导航 |
| `records` / `settings` / `memory` | 中后段 | 记录、设置、记忆面板 |
| `judge` / `metric` / `spec` | 中后段 | 判定依据与关键帧判据 |
| `cue` / `fam` / `cues` / `speech` | 后段 | 提示、族模板、动作专属提示、语音 |
| `coach` / `voice` / `rule` | 末段（约 L1560 / L1952 / L1975） | AI 教练（含 R4 的 `coach.diag.whySaid*` / `whySkip*` / `reason.*`）、语音状态、规则描述（含 R4 的 `rule.source.*` / `rule.cond.*`） |

> 具体行号随内容增长而变；以「分组名」定位，比记行号可靠。当前工作区版本 **2027 行**。

## 3. 算法与流程（步骤化）

无逻辑，只有被读取的契约：

```
t('ui.start') 在 lang='en' 时 → 这里的值
t('ui.start') 在 lang='zh' 且 zh 缺这个键 → 也回退到这里
```

因此**新增中文词条时必须同步这里**，否则英文界面显示键名（`ui.start`）。

## 4. 对外接口

| 导出 | 位置 | 形状 | 说明 |
|---|---|---|---|
| `default` | L6 | 嵌套对象 | 由 `i18n.js` 以 `LOCALES.en` 引入 |

## 5. 与其它文件的关系

- 下游：`i18n.js`（唯一 import 者），再经 `t()` 分发到所有 UI / 语音模块。
- 对照：`tests/test-i18n.mjs` 比对 `localeKeys('zh')` 与 `localeKeys('en')` 的集合；
  同时检查 `README.md` 与 `README.en.md` 的标题 / 表格 / 代码块数量一致
  （所以**文档结构**也算这份文件的一部分约定）。

## 6. 易错点与设计取舍

- **不要机翻式逐字对译**：动作要领是给做动作的人看的，语义优先（`ex.*` 是用户体验的主战场）。
- 英文比中文长，注意界面溢出：按钮 / HUD 文案尽量短（这一点在 `en.js` 里是硬约束）。
- 句子里的数字用占位符 `{n}`，不要拼死；报数走 `voice/numerals.js` 的 `enNumber`。
- 与 `zh.js` 的键**顺序**不要求一致，但**集合**必须一致（测试只比集合）。
- 语音（`speechLang: 'en-US'`）与界面语言是同一份 `meta`：改 `meta` 会影响 TTS 选音色。

## 7. 读代码建议（先看哪几行）

1. L1-L20 `meta` / `app`（确认 `speechLang`）；
2. 搜 `coach:` 看语音教练话术（最长、最常改）；
3. 搜 `spec:` 对照 `specs.js` 的 `labelKey`（改判据文案时两边一起看）。
