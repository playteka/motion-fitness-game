# src/metrics.js — 一帧关键点 → 全部动作指标（BodyFrame）

> 层：引擎（特征提取） ｜ 463 行 ｜ 纯函数，唯一入口 `computeFrame()`
> 一句话：识别器只读这一个对象，不再自己碰关键点。

## 1. 它解决什么问题（为什么需要它）

19 个动作的判据五花八门（膝角 / 肘角 / 髋离地 / 开合幅度 / 头离地…），如果每个识别器都自己
算，口径必然漂移。这里**一帧只算一次**，把所有与身高、距离、机位无关的量一次算全：
角度（度）、比值（÷躯干长）、上下关系（y 比较）。阈值因此可以跨人、跨机位复用。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 作用 |
|---|---|---|---|
| `DEFAULT_CALIB` | L15-L23 | torsoLen .30 / thighLen .26 … | 没校准时用的比例兜底 |
| `HORIZONTAL_TILT` | L30 | `55`（度） | 躯干超过它 = 接近水平（`horizontal`） |
| `PERSON_VIS_MEAN` | L46 | `0.10` | 12 个核心关节的**平均**可见度下限 |
| `PERSON_VIS_MIN` | L47 | `0.02` | 判定用 15 点里「第三差」的下限 |
| `PERSON_VIS_SLACK` | L48 | `2` | 允许 2 个判定点看不见 |
| `PERSON_MIN_TORSO` | L59 | `0.02` | 躯干长占画面高比例下限（挡退化帧） |
| `SIDE_IDX` | L61-L64 | L/R 各 8 个索引 | 左右侧取点 |

返回对象里最常用的字段：`kneeAngle` / `kneeBent` / `hipAngle` / `elbowAngle` /
`shoulderAngle` / `legOut` / `kick` / `torsoIncl` / `shoulderAboveHip` / `hipClear` /
`kneeClear` / `legSpread` / `horizontal` / `ok`。

## 3. 算法与流程（步骤化；必要时 ASCII 图）

`computeFrame(metric, calib, now, use3d, world)` L74-L450，每帧顺序固定：

```
① 取中点与比例尺：shoulderMid/hipMid(L79-80)、groundY=最低脚踝(L83)、torsoLen(L85)
② 选「看得最清的一侧」：min(髋膝踝肩肘腕 可见度)，降序取第一(L88-L97)
③ 两侧关节角 perSide{L,R}：knee / hip / legOut=min(knee,hip) / kick / elbow /
   shoulderAngle / ankle / body + wristClear/kneeClear/shoulderClear(L110-L171)
④ 主判定量取**最清楚那一侧**（不是双侧平均）：kneeAngle L186、hipAngle L188、
   elbowAngle L190、shoulderAngle L192 —— 侧拍时远侧肢体被躯干挡住，平均会被拖偏
⑤ 躯干线：torsoIncl(L195)、groundRef=校准地面线优先否则脚踝(L213)、
   shoulderAboveHip(L230)、hipClear/kneeClear/wristClear(L231-232)、
   headClear(L240-245)、hipLineDev(L246，>0 塌腰 / <0 撅臀)
⑥ 视角：shoulderW/torsoLen > 0.72 → 'front'，否则 'side'(L250-253)
⑦ 深蹲量：hipBelowKnee(L257)、thighFromHoriz(L260)、hipAboveKnee=÷小腿长(L270)
⑧ 校准量：bodyTop/bodyBottom/bodySpan(L273-275)、centerXFrac(L279-280)、
   躺姿用 bodySpanX/bodyLeftFrac/bodyRightFrac(L294-297)、facingX(L301)
⑨ 多动作共用姿势量：hipClear/ankleClear(L315-316)、kneeSpread/ankleSpread、
   legSpread=max(膝,踝)(L327)、wristTwist、armRaised、inverted、horizontal、
   quadruped(L339-341)、elbowBent/elbowExtended/ankleAngle/wristClearMin
⑩ 可见度判定：(L350-L369) coreVis 平均 → visFloor=第 3 差点 →
   ok = coreVis>MEAN && visFloor>MIN && torsoLen>MIN_TORSO(L372)
```

**阈值从哪来**：本文件的可见度常量（L46-L59）与 `HORIZONTAL_TILT`（L30）是**唯一来源**；
`specs.js` 与 `calibration.js` 直接 import 它们显示，界面不另抄数字。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `computeFrame(metric, calib, now, use3d=false, world=null)` | L74 | → BodyFrame | 本帧全部指标；`ok=false` 时只有 `{ok,t}` |
| `ema(prev, next, alpha=0.05)` | L453 | 数 | 缓慢变化量（躯干长）的逐帧平滑 |
| `pick(obj, keys, fallback)` | L458 | 数 | 取第一个有限值 |
| `HORIZONTAL_TILT` / `PERSON_VIS_*` / `PERSON_MIN_TORSO` | L30/L46-L59 | 常量 | 界面与测试共用 |
| 重新导出 `clamp` | L463 | — | 方便下游只 import 一个文件 |

## 5. 与其它文件的关系

上游：`geometry.js`（`toMetric` 出来的 `metric` 数组、`angleAt2/3`、`mid`、`signedLineDev`）。
下游：`engines.js`（门控 `GATES` 读 `shoulderAboveHip` / `hipClear`…）、`steps.js`（要领判据）、
`exercises.js`（手写识别器）、`specs.js`（显示 `HORIZONTAL_TILT`）、`app.js`（每帧调用一次）、
`calibration.js`（复用 `PERSON_VIS_MEAN`）。

## 6. 易错点与设计取舍

- **符号**：`hipRise`（L216）与 `shoulderAboveHip`（L230）互为相反数。站立时前者 ≈ −1、后者 ≈ +1。
  站姿门控一律用正数版；历史上把它写反导致「勾腿跳永远提示没进姿势」。
- **`legOut` 取 min(knee, hip)**（L129）：只看膝会放过「小腿踢直、大腿仍在桌面位」；
  只看髋会放过「腿放下去但膝盖还屈着」。
- **`kick` 除以腿长**（L142）：大跨度量（站 1.0 → 勾到臀 0.5），被平滑压浅也照样能过线。
- `ok` 放宽到 `mean>0.10 / 第三差>0.02`（旧 0.16/0.03）：脸和手指**不参与**判定，
  手指被挡不再整帧作废（用户反馈「明明看得清却变灰」）。
- 地面线优先用 `calib.groundY`（L105）：脚踝自己算的地面会跟着人跳起来一起动。

## 7. 读代码建议（先看哪几行）

1. L74-L106 函数头（比例尺 + 侧别选择 + 地面线）；
2. L350-L372 `ok` 的三条门槛；
3. L129-L143 `legOut` / `kick` 的注释（理解「为什么不是简单角度」）；
4. L213-L232 一堆 `*Clear` 的统一定义。
