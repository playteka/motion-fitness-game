# src/geometry.js — 几何与信号处理的最小工具库

> 层：引擎（数学底层） ｜ 197 行 ｜ 无业务状态、无 DOM
> 一句话：把 MediaPipe 的关键点变成「角度 / 距离 / 平滑后的坐标」，全项目只有这一份几何口径。

## 1. 它解决什么问题（为什么需要它）

识别器的所有阈值都是「角度」与「比例」，不是像素。要保证「30° 就是 30°」，必须先把归一化
坐标按**宽高比**校正（x 乘 aspect、单位取画面高），否则同一个姿势在 16:9 与 4:3 下读数不同。
另外摄像头数据抖动大，裸关键点直接进状态机 → 误计数，所以这里提供一欧元滤波器。

本文件只管数学：不认识任何动作，也不 import 业务模块（`geometry.js` 是全仓库最底层，
`metrics.js` / `steps.js` / `exercises.js` / `pose-log.js` / `render.js` 都依赖它）。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 形状 / 值 | 作用 |
|---|---|---|---|
| `LM` | L10-L27 | 33 个具名索引 | MediaPipe Pose 关键点编号（`L_SHOULDER` = 11 … `R_FOOT` = 32） |
| `SKELETON_EDGES` | L30-L41 | 19 组 `[a, b]` | 火柴人连线；`render.js` 只按这张表画 |
| `clamp` / `lerp` / `toDeg` | L43-L45 | 纯函数 | 夹取 / 插值 / 弧度转度 |
| `dist2` / `dist3` | L46-L47 | 纯函数 | 二维 / 三维距离（`z` 缺省按 0） |
| `mid` | L50-L57 | `{x,y,z,v}` | 两点中点，**可见度取 min**（被遮挡的点不能更可信） |
| `signedLineDev` | L90-L97 | 数 | 点到直线的有符号垂距，正值 = 往地面方向偏 |
| `OneEuro` | L100-L134 | class | 低延迟自适应平滑（见 §3） |
| `LandmarkSmoother` | L137-L169 | class | 33 点 × (x,y,z,v) 四组一欧元滤波器 |
| `toMetric` | L172-L181 | `Array` | 归一化坐标 → 宽高比校正坐标，并把 `aspect` 挂到数组上 |

## 3. 算法与流程（步骤化）

**每帧（平滑）**：`LandmarkSmoother.apply(landmarks, tSec)` L146-L164

```
dt = 上一帧到现在（首帧取 1/30；夹在 [1/240, 0.25] 秒）
for 每个点 i:
   x = filterX.filter(p.x, dt)   y = filterY.filter(p.y, dt)
   z = filterZ.filter(p.z ?? 0, dt)
   v = filterV.filter(p.visibility ?? p.v ?? 1, dt)
```

三组滤波器参数不同（L139-L144）：xy 快（`minCutoff 2.0, beta 5.0`）、z 中（`1.0/2.0`）、
v 慢（`0.5/0`，可见度要稳），全部集中在构造函数里 —— **一处定义**。

**一欧元滤波**（L113-L128）：先按 `dCutoff` 平滑出速度 `dxHat`，再令
`cutoff = minCutoff + beta·|dxHat|`，最后用该 cutoff 的一阶低通 `alpha = 1/(1 + tau/dt)`
更新 `xHat`。效果：慢动作强平滑、快动作低延迟 —— 比滑动平均更跟手。

**角度**：`angleAt2`（L60-L67）用向量点积 + `acos`，退化（长度 < 1e-6）返回 `NaN`
而不是 0 —— 下游全部用 `Number.isFinite` 过滤，`NaN` 表示「这一帧测不准」。
`tiltFromVertical`（L83-L87）用 `atan2(dx, |dy|)`，刻意**丢掉左右方向**：0° = 竖直，90° = 水平。

**坐标校正**：`toMetric`（L172-L181）只做 `x*aspect`、`z*aspect`，y 不动；
同时把 `aspect` 挂在返回数组上，`metrics.js` 用它把「画面高为单位」换回「画面宽比例」（居中判断）。

## 4. 对外接口（导出函数/事件/端点，含参数与返回值）

| 导出 | 位置 | 签名 | 返回值 |
|---|---|---|---|
| `LM` | L10 | 常量对象 | 关键点索引 |
| `SKELETON_EDGES` | L30 | 常量数组 | `[[i,j], …]` |
| `mid(a, b)` | L50 | 两个点 | `{x,y,z,v}` |
| `angleAt2/angleAt3(a,b,c)` | L60 / L70 | 三个点 | 度（0~180）或 `NaN` |
| `tiltFromVertical(a,b)` | L83 | 起点、终点 | 度（0~90）或 `NaN` |
| `signedLineDev(s,e,p)` | L90 | 直线两点 + 点 | 有符号垂距 |
| `new OneEuro(opts)` | L100 | `{minCutoff,beta,dCutoff}` | `.filter(x,dt)` / `.reset()` |
| `new LandmarkSmoother(count,opts)` | L137 | 点数、滤波参数 | `.apply(landmarks,tSec)` / `.reset()` |
| `toMetric(landmarks, aspect)` | L172 | 关键点、宽高比 | 新数组（带 `.aspect`） |
| `median(arr)` | L184 | 数组 | 中位数（空数组 `NaN`） |
| `new Ring(size)` | L192 | 容量 | `.push(v)` / `.values` / `.clear()` |

## 5. 与其它文件的关系（上游/下游，谁调用它）

- 上游：`vendor/tasks-vision`（原始归一化关键点，经 `pose-engine.js` 出来）。
- 下游：`metrics.js`（唯一消费 `toMetric` 的地方）、`pose-engine.js`（用 `LandmarkSmoother`）、
  `steps.js` / `exercises.js` / `render.js` / `pose-log.js`（用 `LM`、`dist2`、`clamp`）。
- 测试：`tests/test-detectors.mjs` 直接用 `angleAt2` 造合成姿势。

## 6. 易错点与设计取舍（坑、为什么这么做）

- **y 轴向下**（图像坐标）：所以「肩比髋高」是 `y` 更小；`metrics.js` 里 `shoulderAboveHip`
  特意做成正数版，就是为了不在下游写反（见 `Design/src/metrics.md`）。
- **`NaN` 是信息**，不是错误：退化成 0 会让「两腿重叠」被当成「完全伸直」。所有下游都先
  `Number.isFinite` 再取值。
- `LandmarkSmoother` 的 `dt` **有下限**（1/240）：同一毫秒内两帧会让 `dt=0` → 除零。
- `toMetric` 把 `aspect` 挂在数组上，是故意省掉一个参数（否则 `computeFrame` 要为它多一个入参）；
  拿不到 `.aspect` 时下游按 1 处理（`metrics.js` L279）。
- `tiltFromVertical` 取 `Math.abs(atan2(...))`：不区分「往前倾」和「往后倾」，需要方向时
  用 `signedLineDev` / 关键点比较，别硬从这个函数里要。

## 7. 读代码建议（先看哪几行）

1. L10-L41 关键点与骨架表（后面所有 `P(i)` 都靠它）；
2. L172-L181 `toMetric`（理解「单位 = 画面高」）；
3. L100-L134 `OneEuro`（唯一一段有状态数学）；
4. L60-L97 三个几何小函数（`NaN` 约定）。
