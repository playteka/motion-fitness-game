# src/pose-engine.js — MediaPipe Pose 封装（加载 / 兜底 / 重试 / 摄像头）

> 层：引擎（视觉输入） ｜ 892 行 ｜ 全项目最重的外部依赖封装处
> 一句话：本地 wasm + 本地模型 → 33 个关键点；加载失败要能说出「哪一步、为什么、还能怎么办」。

## 1. 它解决什么问题（为什么需要它）

模型 9.3MB + wasm 运行库，慢机器、断网、GPU 卡死、缓存中毒都会让「点开始训练」变成
「加载失败」四个字 —— 用户没法自救。这里把加载拆成**四个阶段**（wasm / model / create / detect），
每阶段失败都包成带 `stage` 与真实错误名的 `PoseLoadError`，并按「这次失败值不值得重试」决定退避。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `MODELS` | L27-L30 | `lite`（5777746 字节）/ `full`（9398198） | `rev` = 文件字节数，作缓存指纹 |
| `modelUrlFor(key)` | L33 | `./vendor/models/…task?v=<rev>` | 换模型文件指纹自动变 |
| `WASM_DIR` | L38 | `./vendor/tasks-vision/wasm` | 本地运行库 |
| `NOSIMD_FILES` | L46-L49 | 两个路径 | 最保守一档（非 SIMD） |
| `RETRY_DELAYS` | L52 | `[400, 900, 1800]` | **只对下载类失败**重试 |
| `LOAD_ATTEMPTS` | L54 | `4` | 首次 + 3 次 |
| `FIRST_DETECT_TIMEOUT_MS` | L56 | `8000` | 首帧推理自检超时 |
| `DEFAULT_DELEGATE` | L61 | `'CPU'` | 默认 CPU（GPU 会卡死而不是报错） |
| `GPU_INIT_TIMEOUT_MS` | L63 | `6000` | 显式要 GPU 时的软超时（超时也算失败） |
| `INIT_TIMEOUT_MS` | L69 | `45000` | 初始化上限（慢机器编译 wasm 要 10~20s） |
| `LOAD_TIMEOUT_MS` | L71 | `240000` | `app.js` 最后一道保险 |
| `LOAD_STAGES` | L74 | `wasm/model/create/detect/timeout/env` | 阶段名（界面与日志共用） |
| `PROGRESS_WEIGHTS` | L169 | `wasm .4 / model .4 / init .2` | 进度条权重 |

## 3. 算法与流程（步骤化）

**`init()` L306-L453** 的完整链路：

```
① 决定 wanted = normalizeDelegate(delegate)（null → CPU）；同 modelKey+delegate 已就绪 → 直接返回
② 模型下载：for attempt 1..max
     loadAssets(modelUrl) 失败且 isRetryableLoadError → 退避 400/900/1800 再试
     不重试的错误（WebGL / wasm 编译 / 超时）→ 直接抛
③ 兜底链 plan（L365-L367）：
     [ {delegate: primary} ]  primary = wanted || 'CPU'
     若 primary === 'GPU' → push {delegate:'CPU'}
④ createAndCheck(assets, delegate, video, firstDetectMs, attemptMs)
     GPU 一档只给 min(initMs, 6s)：**超时也当失败**，立刻换 CPU
     失败若为非超时的 create/detect/wasm 错误 → 再 push 一档「非 SIMD + CPU」
⑤ 成功 → 记 landmarker/delegate/modelKey；GPU 兜底成功 → onDelegate(原因)
```

**下载**（`downloadWithProgress` L495 / `downloadModel` L604）：流式读 `response.body`，
算 `bps` 与真实字节进度，卡住超过 `DOWNLOAD_STALL_TIMEOUT_MS`（60s）判超时；
字节直接喂给 `modelAssetBuffer`，**只下一次**。

**进度**（`composeProgress` L222）：把三段加权成 0~1，界面只读这一个数；
`isSlowLoad`（L194）用 `SLOW_LOAD_BPS = 1MB/s` 且已用 > `SLOW_LOAD_AFTER_MS = 8s`
判断「要不要提示网络慢」。

**每帧推理**（`firstFrame` L680）：`landmarker.detectForVideo(video, now)`；时间戳必须
单调递增（`_lastTs`），否则 MediaPipe 会报错。

**摄像头**（L732-L892）：`cameraConstraintsFor` / `cameraAttemptsFor`（多档降级：
理想分辨率 → 逐档降级）、`shouldRetryCamera`（哪些错误名值得再试）、`cameraWithMic`
（可选带麦克风，教练要共用一条流）、`stopAudioTracks`；`Camera` 类 L805-L892 负责
`list()` / `start(deviceId, {facing, tier, mic})` / 停止。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `new PoseEngine(deps)` | L259 | → 实例 | 依赖可注入（测试不联网） |
| `engine.init({modelKey, delegate, video, onProgress, onRetry, onDelegate, …})` | L306 | → this | 加载（失败抛 `PoseLoadError`） |
| `engine.close()` / `ready` | — | — | 释放 / 是否就绪 |
| `PoseLoadError` | L85 | class | `{stage, errName, reason, retryable, status, timeoutMs, elapsedMs, …}` |
| `isRetryableLoadError` / `isTimeoutLoadError` | L112 / L119 | 纯函数 | 兜底策略判定 |
| `composeProgress` / `formatMB` / `isSlowLoad` | L222 / L201 / L194 | 纯函数 | 进度与提示 |
| `cameraConstraintsFor` / `cameraAttemptsFor` / `cameraWithMic` / `stopAudioTracks` | L732-L803 | 纯函数 | 摄像头约束 |
| `Camera` | L805 | class | `list()` / `start()` |

## 5. 与其它文件的关系

- 上游：`vendor/tasks-vision/vision_bundle.mjs`（唯一外部 import）。
- 下游：`app.js`（`PoseEngine` + `Camera` + 所有超时常量）、`geometry.js`（对输出的点做平滑）。
- 与 `metrics.js` 无直接关系：这里只出关键点，指标换算在下游。

## 6. 易错点与设计取舍

- **默认 CPU**（L58-L61）：GPU 在创建 WebGL 上下文时会**卡死**（不报错），等超时才轮到 CPU，
  用户白等 20s。CPU 跑 lite 15~30fps 够用 —— 稳比快重要。
- **只有下载类失败才重试**：WebGL / wasm 编译失败重试也没用，只会让用户多等。
- **模型 URL 带 `?v=字节数`**（L24-L30）：换文件指纹就变，避免「前几天好用、今天坏了」的老缓存。
- `INIT_TIMEOUT_MS` 从 20s 放宽到 45s：把「其实能成功」的慢机器误杀是最坏的结果。
- 时间戳必须单调（`_lastTs`）：`detectForVideo` 对回退的时间戳会抛错。
- `close()` 要在换模型 / 页面卸载时调，否则 wasm 内存不释放。

## 7. 读代码建议（先看哪几行）

1. L1-L20 头部（四阶段 + 重试策略，先读这段再改加载逻辑）；
2. L306-L367 `init()` 前 60 行（重试循环 + 兜底链）；
3. L371-L449 兜底链的 `for` 循环（GPU→CPU→非 SIMD 的顺序）；
4. L495-L604 流式下载（进度与卡住超时）。
