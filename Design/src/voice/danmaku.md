# src/voice/danmaku.js — 对话弹幕（用户青 / 教练薄荷绿，上半屏 4 条轨道）

> 层：语音（展示） ｜ 486 行 ｜ 纯逻辑与 DOM 渲染**分两层**
> 一句话：用户说一句飞一条、教练答一句飞一条，颜色区分说话人，不压 HUD。

## 1. 它解决什么问题（为什么需要它）

字幕面板只有两行、会被覆盖；用户要的是「弹幕」：说过的每一句都飞过去，能看出谁在说。
但弹幕很容易变成视觉噪音 —— 所以有轨道数、同屏上限、队列上限、去重窗口，以及
「不压住 HUD 圆环 / 判定进度条 / 右下按钮」的范围约束。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `DANMAKU_LANE_COUNT` | L24 | `4` | 上半屏 4 条轨道 |
| `DANMAKU_MAX_ON_SCREEN` | L26 | `8` | 同屏最多 8 条 |
| `DANMAKU_QUEUE_MAX` | L28 | `12` | 排队上限（超了丢最旧） |
| `DANMAKU_DEDUPE_MS` | L30 | `1500` | 同一句 1.5 秒内不重复弹 |
| `DANMAKU_FLIGHT_MS` | L32 | `11000` | 一条飞过舞台的时长（CSS `--danmaku-flight` 与它对应） |
| `DANMAKU_LANE_GAP_MS` | L34 | `2800` | 同轨道两条的最小间隔 |
| `DANMAKU_STATIC_MAX` | L36 | `2` | `prefers-reduced-motion` 时降级成静态两行 |
| `DANMAKU_MODES` | L39 | `danmaku / subtitle / off` | 三种显示模式 |
| `DANMAKU_COLORS` | L43-L47 | 用户青 `#38bdf8`、教练薄荷绿 `#34e5c4` | **一处定义**（CSS 令牌同名引用） |

## 3. 算法与流程（步骤化）

**纯逻辑层**（不碰 DOM、不读时钟，全部参数注入）：

```
pickLane(lanes, now) L69        选一条「最近一条已飞够 LANE_GAP_MS」的轨道（都忙就排队）
layoutBullet({…}) L95           算出一条弹幕的起点/终点/时长（给定尺寸与速度）
createDanmakuModel({…}) L128    队列 / 同屏上限 / 去重 / 静态降级的状态机
```

**DOM 层**（`createDanmaku` L267 起）：把模型吐出的 bullet 变成 `.danmaku` 元素、
用定时器推进、维护底部「最近一句」那一行；`prefers-reduced-motion` 时切成静态两行
（不飞行）。模式切换（`danmaku / subtitle / off`）只改渲染方式，不改数据。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createDanmaku({doc, win, …})` | L267 | → 控制器 | `.say(kind, text)` / `.setMode()` / `.clear()` / `.close()` |
| `createDanmakuModel(opts)` | L128 | → 模型 | 纯逻辑（测试直接断言） |
| `pickLane(lanes, now)` / `layoutBullet({…})` | L69 / L95 | 纯函数 | 轨道与几何 |
| `normalizeKind` / `normalizeMode` | L49 / L54 | 纯函数 | 脏值兜底 |
| `DANMAKU_*` | L24-L47 | 常量 | 上限与配色 |

## 5. 与其它文件的关系

- 上游：`i18n.js`（`t`，如果文案需要本地化）、`style.css`（`.danmaku` / `--danmaku-*` 令牌）。
- 下游：`app.js`（`createDanmaku` L428；用户 / 教练两条文本都从这里进）、`voice/coach.js`
  （字幕面板与弹幕的分工）。
- 不依赖会话状态机：`say()` 只负责展示。

## 6. 易错点与设计取舍

- **颜色只在一处定义**：`DANMAKU_COLORS` 与 CSS 的 `--danmaku-user/coach` 必须同值
  （测试会对照），改一个要改两个。
- **只占上半屏 4 条**：越界会压住 HUD 与进度条 —— 这是用户明确要求。
- **去重 1.5 秒**：同一句话重复出现是最明显的 bug 感（例如连续两次 `rep` 事件）。
- `prefers-reduced-motion` 必须真的降级（不飞行），否则对晕动症用户不友好。
- 纯逻辑与 DOM 分层是**为了测试**：不要在 `createDanmakuModel` 里读 `Date.now()` 或 DOM。
- 队列上限 12：超了丢最旧的，不要无限增长（长时间训练会 OOM）。

## 7. 读代码建议（先看哪几行）

1. L1-L22 头部（用户要求原文 + 分层原因）；
2. L24-L47 全部常量（上限与颜色）；
3. L69-L128 `pickLane` + `createDanmakuModel`（纯逻辑，最值得测的部分）；
4. L267 起 `createDanmaku`（DOM 与 reduced-motion 降级）。
