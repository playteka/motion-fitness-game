# src/pose-log.js — 「记录调试数据」：把每帧关节数据写成 JSONL

> 层：工具链（调试） ｜ 350 行 ｜ 浏览器不能写文件，所以攒批 POST 给本地预览服务器
> 一句话：用户勾上开关后，`logs/pose-*.jsonl` 里留下「够复现判定」的最小集合。

## 1. 它解决什么问题（为什么需要它）

用户反馈「做了 10 个只计了 6 个」时，光看界面查不出来：必须能看到**识别器内部状态**
（现在在哪一阶段、本轮峰值多少、计次线在哪、上一次为什么没计上）。
浏览器不许网页写本地文件，所以这里走「攒批 → POST `/__debug/log?file=…` → 服务端追加写」。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `FLUSH_MS` | L22 | `1000` | 攒 1 秒发一批 |
| `FLUSH_ROWS` | L23 | `200` | 或攒够 200 行 |
| `CHUNK_BYTES` | L36 | `48 * 1024` | 单次 POST 上限（**踩过 keepalive 64KB 的坑**，L24-L35） |
| `MAX_QUEUE` | L38 | `40` | 待发块上限（服务端连不上时保护内存） |
| `MAX_BUFFER` | L40 | `60_000` | 内存里最多留多少行（下载兜底用） |
| `PoseLogger` | L157-L347 | class | 记录器 |
| `LANDMARK_NAMES` | L348 | `Object.keys(LM)` | 33 点名字（分析脚本用） |

JSONL 行类型（`k` 字段）：`meta`（第一行）/ `f`（一帧）/ 其它事件（计次、提示、要领、会话切换）。

## 3. 算法与流程（步骤化）

**一帧**（`frame({t, exerciseId, session, landmarks, smoothed, frame, det, barIndex, barTotal})` L214-L229）：

```
{k:'f', t, ex: 动作id, s: 会话序号,
 lm: 33 个 [x,y,z,可见度]（原始，未平滑）,
 sm: 平滑后的一份,
 m : 这一帧算出的全部指标（角度 / 离地 / 躯干长…）,
 d : 识别器内部状态（阶段 / 进度 / 峰值 / 判定线 / 上次没计上的原因）,
 sides: 左右腿各自的读数,
 bar : [当前格, 总格数]}
```

**写入**（`_write` L237-L254）：`JSON.stringify` 失败（循环引用）就丢掉这一行；
满足「200 行 / 1 秒」就触发 `flush()`。

**发送**（`flush` L257-L287）：原始行 → 按 48KB `chunkify` 入队 → 一次只发队首一块
（`_inflight` 串行）→ 失败退回队首、连续 3 次失败退避 5 秒并回调 `onError`。

**收尾**：`stop(reason)` L205-L211 写一行 `{k:'end'}` 并强制 flush；
`flushOnUnload()` L293 在页面卸载时用 `sendBeacon`（同样有 64KB 上限，所以仍先切块）；
`download()` L314 把 `all` 里的行做成 `.jsonl` 让浏览器下载（没有服务器时的兜底）。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `new PoseLogger({post, now, onError})` | L164 | → 实例 | `post(file, body)` 可注入（默认 fetch） |
| `start(meta)` / `stop(reason)` | L196 / L205 | → 文件名 | 开始 / 结束记录 |
| `frame({…})` / `event(kind, data)` | L214 / L232 | void | 记一帧 / 记一个事件 |
| `flush({force})` / `flushOnUnload()` | L257 / L293 | void | 手动刷 / 关页刷 |
| `download()` / `status()` | L314 / L333 | void / 对象 | 下载兜底 / 状态（行数、错误、丢弃数） |
| `reset()` | L179 | void | 清空（换动作时） |

## 5. 与其它文件的关系

- 上游：`geometry.js`（`LM`）、`engines.js`（`SIDE_METRICS`，取左右腿读数）。
- 下游：`app.js`（设置开关 `setPoseLog` + 每帧 `logger.frame`）、
  `preview-server.js`（`/__debug/log` 追加落盘到 `logs/`，已 gitignore）。
- 与 `voice/diag.js` 是**两条独立通道**：那个记语音链路（`coach-diag.jsonl`），
  这个记关节数据（`pose-*.jsonl`），都走同一个 `/__debug/log` 端点。

## 6. 易错点与设计取舍

- **`keepalive` 的 64KB 上限**（L24-L35）：真实事故 —— 每批 100KB，全部 reject，
  文件里只剩一行 meta。现在普通 POST 不带 keepalive，并且按 48KB 切块。
- **一帧约 2.5KB**：所以「1 秒一批」≈ 100KB，切块是必须的，不是优化。
- 失败**退避**而不是狂重试（`_retryAt`）：否则服务端没起时页面会被自己的请求刷爆。
- `_write` 丢弃循环引用的行：宁可少一行，也不要让记录器抛错影响训练。
- 内存 `MAX_BUFFER` 到顶后**只保留最近一半**：下载兜底会缺前半段，但页面不会 OOM。
- 记录的是**原始关键点 + 平滑后**两份：分析「滤波是否把动作压浅」时必需。

## 7. 读代码建议（先看哪几行）

1. L22-L40 五个容量常量（尤其 L24-L36 的 keepalive 事故说明）；
2. L214-L229 `frame()`（一帧记什么）；
3. L257-L287 `flush()`（切块 + 串行 + 退避，最有信息量的一段）；
4. L205-L211 `stop()` 与 L293-L313 `flushOnUnload()`（关页不丢数据）。
