# 架构说明（ARCHITECTURE）

> 一句话：**一个拥有视觉（33 关键点）与语音（听/说）的健身 AI Agent** —— 摄像头看动作、事件总线判断「该不该说话」、规则直接执行、LLM 负责思考与调度。
>
> 本文件已移入 `Design/`。文中出现的路径（`src/app.js`、`server/…`）都**相对于仓库根目录**，
> 不是相对本文件；逐文件的设计文档见 [Design/README.md](README.md)。

## 1. 数据流总览

```
摄像头视频
   │
   ▼ ① src/pose-engine.js          MediaPipe PoseLandmarker → 33 个 3D 关键点（本地 wasm/模型，CPU 优先，带进度条）
   ▼ ② src/metrics.js              关键点 → 关节角度 / 距离比 / 倾角（hip、knee、hipAboveKnee、kneeClear、torsoIncl…）
   ▼ ③ 识别器                        每帧判断「门控是否通过」→「是否完成一次」→「关键帧是否达标」
        · src/engines.js            配置驱动引擎（bend/alt/twist/sequence/hold）+ GATE_LIMITS/GATES
        · src/exercises.js          手写状态机（深蹲/弓步/臀桥/平板/卷腹/跪姿俯卧撑…）
        · src/detector-base.js      基类：计分、提示节流、丢帧容忍
        · src/steps.js              关键帧判据表（哪一帧、什么条件、多少分）
        · src/specs.js              界面展示用规格（与识别器同一份常量，一处定义）
   ▼ ④ src/voice/events.js          事件总线：rep / gate-fail / keyframe-hit·miss / progress / tick / idle / …
   ▼ ⑤ 分流
        ├─ src/voice/rules.js       规则引擎：确定性的话（报数、读秒、倒数、最后 3 个、过半、催促）→ 0 成本、≤80ms
        │                           设置页的「当前生效的规则」面板也读它（R4：逐条开关 / 一键恢复默认 /
        │                           「报数 / 读秒」两个总开关，状态存 settings.ruleSwitches）
        └─ src/voice/judge.js       LLM 裁判：8 个触发点 → 问模型「要不要说一句」→ 默认沉默
   ▼ ⑥ src/voice/session.js         会话状态机 off/listening/thinking/speaking/error + 命令快车道 + 确认机制
   ▼ ⑦ 输出
        · src/voice/tts-volc.js     火山流式 TTS（MSE 播放 + 三段降级 + 插话打断）
        · src/voice/danmaku.js      弹幕（用户青 / 教练薄荷绿）
        · src/voice/diag.js         诊断快照（含 R4 的 lastSpeak / lastSkip → 面板两行「为什么说 / 没说」）
        · index.html / style.css    光环头像、HUD、菜单、规则面板
```

## 2. 三层输入

| 输入 | 处理位置 |
|---|---|
| **视觉**（动作/姿势） | pose-engine → metrics → 识别器 → 事件 |
| **语音**（说话） | 火山流式 ASR（`/asr` 代理，100ms 帧、32KB/s）→ `src/voice/parse.js` |
| **命令** | `parse.js` 快车道（25 类 intent / 292 说法）→ `commands.js` 执行 |

## 3. 声音输出的三条通道

| 通道 | 决定者 | 延迟 | 成本 | 文件 |
|---|---|---|---|---|
| 命令快车道 | 正则命中 | ≤300ms | 0 | `parse.js` + `commands.js` |
| **规则快车道** | 预置/口述规则 | ≤80ms | **0** | `rules.js` |
| LLM 裁判 | 模型判断 | 1~2s | 按量计费 | `judge.js` |
| 主动事件 | 进入训练/离开 | 1~2s | 每次 1 次 | `judge.js` + `app.js` |

## 4. Agent 的「大脑」与「记忆」

| 层 | 文件 | 内容 |
|---|---|---|
| 人设 | `SOUL.md` | 可可教练（Coach KK）：身份/性格/话术/红线 → 拼进 system prompt |
| 工具 | `server/llm-tools.mjs` | 15 个工具（与命令表 1:1）+ system 规则 + 记忆注入 |
| 模型调用 | `server/llm-provider.mjs` | DeepSeek/豆包/OpenAI + 限流 + `/llm` 路由 |
| 短时记忆 | 内存（`session.js` / `llm.js`） | 10 轮对话 · 教练最近 5 句 · **最近 60 秒事件** |
| 中时记忆 | localStorage | 最近 20 次训练摘要 · 本周 vs 上周趋势 · `lastSession`（继续上次） |
| 长时记忆 | `server/memory/<userId>.md` | `prefs`（语气/难度/时长/音色/性别/语速）+ `facts`（目标/伤病/每周次数，带来源） |

## 5. 已具备（可用）

- 19 个动作识别 + 计次/计时 + 关键帧计分 + 门控（姿势准入）
- 手势菜单、猫爪指针、圆环导航、全屏、成绩/记录/最佳
- 火山流式 ASR（本机代理）、命令快车道、自由对话 + 工具调用
- 火山流式 TTS（首字 ~0.4~1.3s）+ 插话打断（≤150ms）+ 三段降级
- 规则引擎（6 条内置）+ 口述建规则 + **R4 规则面板**（全部规则逐条开关 / 一键恢复默认 /
  「报数 / 读秒」两个总开关 / LLM 规则上限提示）+ LLM 裁判（8 触发点，默认沉默）
- 三层记忆、SOUL 人设、进训练主动问候、极简光环头像、弹幕
- 七套测试 **4465**（i18n / detectors / engines / specs / page / app / voice）

## 6. 没做好 / 需要完善（按优先级）

| 优先级 | 缺口 | 现状 | 建议 |
|---|---|---|---|
| **P0** | **姿态「标准度」检测**（平板/俯卧撑的**塌腰、翘臀、身体不成直线**） | 只有门控 + 关键帧（蹲深/站直），**没有臀位/腰曲的显式判据** ✗ | 在 `metrics.js` 加 `hipSag`（髋相对肩-踝连线偏移）、`pelvisTilt`；在 `steps.js` 加判据 → 发 `posture-fault{type}` 事件 → 交给裁判说「腰别塌」 |
| **P0** | `session-end` 告别 + 结束后静默 | **已完成**（见 `src/app.js` 的告别段） | 保持回归测试 |
| **P1** | **R4 规则面板** | **已完成**：`src/voice/rules.js` 出数据（来源 / 触发条件人话 / 频道），`src/app.js` L751-L926 渲染与开关，`settings.ruleSwitches` 持久化；诊断两行见 `src/voice/diag.js` L145-L146 + `coach.js` L60-L100 | 保持 `[41]` / `[55]` 回归；LLM 规则的**上限拦截**等真接上自动建规则时再加在 `addCoachRule` 入口 |
| **P1** | 每 3 个 / 静止 / 出画 的频率整形 | 已实现节流，但**快节奏时仍偏密** ✗ | 「每 3 个且 ≥6s」；静止/出画 **退避 10→20→40s** |
| **P1** | **训练计划 / 排课** | 无 ✗ | 「今天练什么」→ Agent 生成计划 + 一键开始（最像私教的能力） |
| **P2** | 动作库覆盖 | 19 个 | 加：引体/划船/硬拉（需器械）、拉伸类（计时） |
| **P2** | 多用户 / 登录 | 单机单用户 ✗ | `/memory` 已按 userId 分文件，接鉴权即可 |
| **P2** | 语音唤醒词 | 可选支持 ✓ | 「可可」常驻唤醒（低功耗 VAD） |
| **P3** | 移动端 | 仅局域网浏览 ✗（摄像头需 https） | 加 HTTPS + 移动布局 → PWA 安装 |
| **P3** | 离线可用性 | 需本机 node 进程（**进程常驻是痛点** ✗） | 打包成桌面应用（Electron/Tauri）或做成纯静态 + 本地推理（WASM） |
| **P3** | 可观测性 | 诊断面板 + 日志 ✓；看板已删 ✗ | 用 JSONL 离线分析即可，别再依赖常驻进程 |

## 7. 一句话结论

**视觉 → 事实（角度/参数）→ 判据（门控/关键帧）→ 事件 → 分流（规则 / LLM）→ 说与显示** —— 这条链路已经打通且可测；下一步的重点不是「加更多规则」，而是 **① 姿势标准的显式判据**（塌腰/翘臀这类真问题）与 **② 排课能力**（真正把人带起来）。

## 8. 设计文档索引

**逐文件设计文档的入口：[`Design/README.md`](README.md)**（按「引擎 / 识别 / 渲染 / 语音 / 服务端 / 工具链」分组，一份 md 对一个源文件）。

每份文档固定七节：① 为什么需要它 ② 关键数据结构 / 常量 ③ 算法与流程 ④ 对外接口
⑤ 与其它文件的关系 ⑥ 易错点与设计取舍 ⑦ 读代码建议（含真实行号）。

维护约定（`AGENTS.md` 有同一份）：**改任何源代码 → 同步更新 `Design/` 里对应的 md 与本文件**，
提交信息注明 `docs: Design 同步`，否则视为改动不完整。

| 想知道什么 | 先看 |
|---|---|
| 全局数据流、三层输入、三通道输出、记忆分层 | 本文件 §1-§4 |
| 某个源文件为什么存在、怎么工作 | `Design/README.md` 的索引表 → 对应 md |
| 测试覆盖了什么、数字从哪来 | [tests.md](tests.md) |
| 服务端端点（`/asr` `/tts` `/llm` `/memory` `/__debug/log`） | [preview-server.md](preview-server.md) |
