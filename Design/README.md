# Design/ — 逐文件设计文档索引

> 这个目录回答一个问题：**每个源文件为什么存在、怎么工作、改它要注意什么**。
> 一份文档对应一个源文件（`tests/` 用一份汇总），每份固定七节：
> ① 为什么需要它 ② 关键数据结构 / 常量 ③ 算法与流程 ④ 对外接口 ⑤ 与其它文件的关系
> ⑥ 易错点与设计取舍 ⑦ 读代码建议（带真实行号）。

## 维护约定（改代码之前先读）

1. **改任何源代码 → 同步更新本目录对应的 md + `Design/ARCHITECTURE.md`**，
   提交信息注明 `docs: Design 同步`（见 `AGENTS.md`）。
2. 文档里的行号是**写作时**的真实区间；源码改动后要顺手校正（粗到函数名也可接受，
   但小节里引用的 `Lx-Ly` 必须存在）。
3. 不确定的地方写「（待确认）」，**不要编造**行为或数值。

## 总览

| 文件 | 文档 | 一句话职责 |
|---|---|---|
| `ARCHITECTURE.md` | [ARCHITECTURE.md](ARCHITECTURE.md) | 全局数据流 / 三层输入 / 三通道输出 / 记忆分层 / 待完善清单 |
| `README.md`（本文件） | — | 索引：每个源文件对应哪份文档 |

## 一、引擎与底座（与动作无关的数学 / 视觉 / 文案）

| 文件 | 文档 | 一句话职责 |
|---|---|---|
| `src/geometry.js` | [src/geometry.md](src/geometry.md) | 关键点索引、角度/距离、一欧元平滑、宽高比校正 |
| `src/metrics.js` | [src/metrics.md](src/metrics.md) | 一帧 33 点 → 全部动作指标（`computeFrame`） |
| `src/pose-engine.js` | [src/pose-engine.md](src/pose-engine.md) | MediaPipe 封装：四阶段加载 / 重试 / GPU→CPU 兜底 / 摄像头 |
| `src/i18n.js` | [src/i18n.md](src/i18n.md) | 取词、切语言、刷新 `data-i18n*` 静态 DOM |
| `src/locales/zh.js` | [src/locales-zh.md](src/locales-zh.md) | 中文词条（唯一真源） |
| `src/locales/en.js` | [src/locales-en.md](src/locales-en.md) | 英文词条（与中文同结构，兼兜底语言） |

## 二、识别与判据

| 文件 | 文档 | 一句话职责 |
|---|---|---|
| `src/catalog.js` | [src/catalog.md](src/catalog.md) | 19 个动作的配置表（一个动作 = 一条配置） |
| `src/engines.js` | [src/engines.md](src/engines.md) | 配置驱动引擎：门控 + 进度 + bend/alt/twist/sequence/hold |
| `src/exercises.js` | [src/exercises.md](src/exercises.md) | 5 个手写识别器 + 动作文案装配 + `createDetector` |
| `src/detector-base.js` | [src/detector-base.md](src/detector-base.md) | 识别器基类：计分 / 提示节流 / 丢帧容忍 / 计时基类 |
| `src/steps.js` | [src/steps.md](src/steps.md) | 动作要领 → 可判定步骤（计分方案表） |
| `src/specs.js` | [src/specs.md](src/specs.md) | 关键帧判据与判分的**展示**数据（数字全部取自识别器） |
| `src/calibration.js` | [src/calibration.md](src/calibration.md) | 运动前校准：轮廓 + 可见 / 入镜 / 机位 / 保持不动 |

## 三、渲染与音效

| 文件 | 文档 | 一句话职责 |
|---|---|---|
| `src/render.js` | [src/render.md](src/render.md) | Canvas：火柴人骨架、角度标注、校准虚线轮廓 |
| `src/icons.js` | [src/icons.md](src/icons.md) | 关键帧线条图标 + 界面图标（按判据反推姿态） |
| `src/audio.js` | [src/audio.md](src/audio.md) | 音效 + 语音播报 + 现场合成的 4 首 BGM |

## 四、应用入口（把零件接起来）

| 文件 | 文档 | 一句话职责 |
|---|---|---|
| `index.html` | [index.md](index.md) | 单页骨架：所有 DOM 节点与 `data-i18n` 契约 |
| `style.css` | [style.md](style.md) | 全部样式与尺寸/颜色令牌（圆环体系一处定义） |
| `src/app.js` | [src/app.md](src/app.md) | 主逻辑：每帧流水线、状态机、界面、语音接线 |

## 五、语音（AI 教练）

| 文件 | 文档 | 一句话职责 |
|---|---|---|
| `src/voice/session.js` | [src/voice/session.md](src/voice/session.md) | 会话状态机 off/listening/thinking/speaking/error |
| `src/voice/providers.js` | [src/voice/providers.md](src/voice/providers.md) | 适配器：麦克风 / ASR / 系统 TTS / VU |
| `src/voice/parse.js` | [src/voice/parse.md](src/voice/parse.md) | 一句话 → `{intent, args}`（命令快车道解析） |
| `src/voice/commands.js` | [src/voice/commands.md](src/voice/commands.md) | 命令表（intent + 中英说法 + `run(ctx,args)`） |
| `src/voice/rules.js` | [src/voice/rules.md](src/voice/rules.md) | 规则快车道：确定性的话 + 一整套「别太吵」护栏 + R4 规则面板的数据（来源 / 触发条件人话 / 报数·读秒总开关） |
| `src/voice/events.js` | [src/voice/events.md](src/voice/events.md) | 事件总线（14 类事件、60 秒窗口、紧凑副本） |
| `src/voice/judge.js` | [src/voice/judge.md](src/voice/judge.md) | LLM 裁判：8 触发点、严格 JSON、默认沉默 |
| `src/voice/llm.js` | [src/voice/llm.md](src/voice/llm.md) | 前端 `/llm` 客户端 + Agent 上下文构建 |
| `src/voice/plan.js` | [src/voice/plan.md](src/voice/plan.md) | **排课**（每日单次计划）：模板 / 禁忌 / 时长预算 / `validatePlan` / 执行队列 |
| `src/voice/coach.js` | [src/voice/coach.md](src/voice/coach.md) | 教练界面层：状态环 / 字幕 / 头像 / VU |
| `src/voice/danmaku.js` | [src/voice/danmaku.md](src/voice/danmaku.md) | 对话弹幕（用户青 / 教练薄荷绿，4 轨道） |
| `src/voice/tts-volc.js` | [src/voice/tts-volc.md](src/voice/tts-volc.md) | 火山 TTS 播放层：MSE / 解码队列 / 三段降级 |
| `src/voice/bargein.js` | [src/voice/bargein.md](src/voice/bargein.md) | 插话打断（连续 2 个够响的 partial） |
| `src/voice/pcm.js` | [src/voice/pcm.md](src/voice/pcm.md) | 100ms 定帧 + 降采样到 16k PCM16 |
| `src/voice/pcm-worklet.js` | [src/voice/pcm-worklet.md](src/voice/pcm-worklet.md) | AudioWorklet：在音频线程定帧 |
| `src/voice/numerals.js` | [src/voice/numerals.md](src/voice/numerals.md) | 数字的数词写法（一 / 二 … / five） |
| `src/voice/diag.js` | [src/voice/diag.md](src/voice/diag.md) | 语音链路诊断（脱敏 / 批量落盘 / 快照） |
| `src/voice/selftest.js` | [src/voice/selftest.md](src/voice/selftest.md) | 独立语音自检（mic → ws → send → result） |

## 六、服务端（本机进程）

| 文件 | 文档 | 一句话职责 |
|---|---|---|
| `preview-server.js` | [preview-server.md](preview-server.md) | 一个进程：页面 + `/asr` + `/tts` + `/llm` + `/memory` + 日志落盘 |
| `server/coach-proxy.mjs` | [server/coach-proxy.md](server/coach-proxy.md) | 浏览器 ↔ 火山之间的 ASR 代理（凭证留本机） |
| `server/volc-asr.mjs` | [server/volc-asr.md](server/volc-asr.md) | 火山 ASR 会话层（连接 / 发帧 / 收事件） |
| `server/volc-protocol.mjs` | [server/volc-protocol.md](server/volc-protocol.md) | 火山二进制协议（纯编解码） |
| `server/volc-tts.mjs` | [server/volc-tts.md](server/volc-tts.md) | 火山 TTS 代理 + 信封拆解 + LRU 缓存 |
| `server/llm-provider.mjs` | [server/llm-provider.md](server/llm-provider.md) | 三家 provider + 限流/超时 + `/llm` 路由 |
| `server/llm-tools.mjs` | [server/llm-tools.md](server/llm-tools.md) | 15 个工具定义 + system prompt（与命令表 1:1） |
| `server/memory-store.mjs` | [server/memory-store.md](server/memory-store.md) | 长期记忆 MD：白名单 + 原子写 + 手改容忍 |
| `server/ws-mini.mjs` | [server/ws-mini.md](server/ws-mini.md) | 最小 WebSocket（握手 / 分帧 / 掩码 / 重组） |
| `server/env.mjs` | [server/env.md](server/env.md) | `coach.env` 解析 + 凭证脱敏 |
| `server/asr-probe.mjs` | [server/asr-probe.md](server/asr-probe.md) | ASR 连通性探针（`npm run asr:probe`） |
| `server/tts-probe.mjs` | [server/tts-probe.md](server/tts-probe.md) | TTS 资源 id × 接口版本探测 |

## 七、工具链与调试

| 文件 | 文档 | 一句话职责 |
|---|---|---|
| `src/pose-log.js` | [src/pose-log.md](src/pose-log.md) | 「记录调试数据」：每帧关节数据写 JSONL |
| `tests/*.mjs`（10 个） | [tests.md](tests.md) | 七套测试 + 合成姿势 + 图标预览 + 真实帧夹具 |

## 覆盖核对

- 源文件（`src/**/*.js` **36** + `server/*.mjs` 11 + 根目录 3 = **50**）
- 文档（本索引之外 **52** 份，含 `ARCHITECTURE.md` 与 `tests.md`）：逐文件一一对应，`tests/` 用一份汇总。
- 抽查方式见 `tests.md` 的「读代码建议」：任选一份文档，按其中的 `Lx-Ly` 打开源码即可对照。
