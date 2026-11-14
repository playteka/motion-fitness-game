# tests/ — 七套测试（一份汇总）

> 层：工具链（验收） ｜ 10 个文件 ｜ `npm test` 串联七套，`node tests/xxx.mjs` 单跑
> 一句话：这套仓库的**规格说明书**——README 里承诺的行为，基本都能在某个 `[编号]` 段落里找到。

## 1. 它解决什么问题（为什么需要它）

这个项目没有 UI 自动化框架、没有构建：所有「用户反馈过、修好了」的现象都必须被
**钉住**，否则下一轮改动很容易把它改回去。所以测试用最朴素的方式写：
`node tests/test-x.mjs`，自带断言函数，跑完打印 `✓ n 项`。

## 2. 关键数据结构 / 常量（表）

| 文件 | 断言数（README） | 覆盖什么 |
|---|---|---|
| `test-i18n.mjs` | 18 | 中英键结构一致 / 无漏翻 / 占位符与数组长度一致 / 源码无写死中文 / 中英文档结构一致 |
| `test-detectors.mjs` | 408 | 5 个手写识别器的标准 + 错误动作、要领得分、校准判定、勾腿跳多速度计次、跪姿俯卧撑真实几何、俯卧撑放宽线 |
| `test-engines.mjs` | 228 | 通用引擎一次循环一次数、门控、跳跃离地、左右交替（含第二路证据）、死虫式/坐姿体前屈/卷腹判据、后箭步蹲门控掉帧回归 |
| `test-specs.mjs` | 797 | 弹窗数字喂回识别器（必须落在它自己的计次线上）、门控与 `GATE_LIMITS` 同源、19 动作都有指标、图标角度 = 判据角度 |
| `test-page.mjs` | 700 | `index.html` 结构、圆环布局与热区、`data-i18n` 完整性、无 emoji 图标、麦克风接线、运动设定两步弹窗、R4 规则面板 DOM / 词条 / 样式 |
| `test-app.mjs` | 1357 | 真实 DOM 桩里的整机流程：命令快车道（只留 6 类；已移出的说法交给 LLM）、全屏/权限、设置环翻页、HUD、记录、记忆面板、规则与裁判、告别、R4 规则面板（逐条开关 / 开回恢复 / 一键恢复默认 / 报数·读秒） |
| `test-voice.mjs` | 957 | 命令解析（6 类 7 个 intent 命中 + 19 个已移出 intent 一律 `unknown`）、会话状态机、ASR 适配器、火山代理/协议/降采样、TTS 降级、规则引擎、裁判、告别、诊断、R4 来源 / 触发条件人话 / 总开关 / `lastSpeak`·`lastSkip` |
| `synthetic-pose.mjs` | — | **合成姿势生成器**：按关节角造 33 点（`foldShin()` 在公制空间折叠，折 X° = 膝角 180−X°） |
| `preview-icons.mjs` | — | `npm run icons:preview`：把所有关键帧图标渲成一张预览 PNG（人工检查用，不是断言） |
| `fixtures/lungeBack-right-leg-back.json` | — | 真实帧夹具（后箭步蹲右腿向后不计数那个 bug 的现场数据） |

## 3. 算法与流程（步骤化）

```
npm test
 ├→ test-i18n      : 纯数据（locales 两份 + README 两份）对照
 ├→ test-detectors : synthetic-pose 造帧 → computeFrame → 识别器 → 断言计数/分数
 ├→ test-engines   : 同上，但走配置驱动引擎（catalog.js 的 params）
 ├→ test-specs     : exerciseSpecs/specStages 的数字 ↔ engines/exercises 常量
 ├→ test-page      : 读 index.html + style.css 做静态断言（不需要浏览器）
 ├→ test-app       : 用最小 DOM 桩跑 app.js（模块级副作用 + 事件绑定）
 └→ test-voice     : 纯 Node（会话/规则/裁判/协议/降采样/诊断）
```

共同模式：**没有浏览器**。需要 DOM 的地方用桩（`test-app`），需要网络的地方注入假 socket /
假 fetch（`test-voice`），需要关键点的地方用 `synthetic-pose.mjs` 合成。

## 4. 对外接口

- 每个文件都是**可执行脚本**：退出码 0 = 通过，非 0 = 失败（`npm test` 用 `&&` 串联）。
- `test-detectors.mjs --dump`：打印合成帧 / 判定过程（排查阈值时用）。
- `synthetic-pose.mjs` 导出造帧函数（被 3 套测试复用）。

## 5. 与其它文件的关系

- 读：`src/**`（源码与常量）、`index.html` / `style.css`、`locales/*`、`README*.md`。
- 被验证的契约：`AGENTS.md`（七套必须全绿）、README 的测试表格（数字要与实际一致）。
- 本目录**不参与运行时**：`index.html` 不加载它。

## 6. 易错点与设计取舍

- **测试里的数字要与 README 表格同步**：新增断言后 README 的「N 项」也要刷新（否则文档失真）。
- **不要引入测试框架**：零依赖是硬约束；自带 `assert` 帮助函数就够。
- `fixtures/` 里放的是**真实关键点**：不要手改，它代表用户现场。
- 临时探针写 `tests/probe_*.mjs`，**用完删掉**（`AGENTS.md` 明确）。
- 一个 bug 修好后要补断言并注明「哪个用户现象」：这些注释是未来的决策依据。
- 改 `src/` 时如果测试挂了，先判断「是代码错了」还是「测试钉的是旧口径」——
  后者要同时改测试与 README 说明，不能默默放宽。

## 7. 读代码建议（先看哪几行）

1. `package.json` 的 `test` 脚本（七套的顺序）；
2. `tests/synthetic-pose.mjs` 顶部（合成姿势怎么造，理解后其它测试都好读）；
3. `tests/test-detectors.mjs` 里带用户引述的段落（最能说明「为什么这么判」）；
4. `tests/test-voice.mjs` 的 `[25]`（真实 http server 验 gzip / 静态资源，写法最特殊）。
