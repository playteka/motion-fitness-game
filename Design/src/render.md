# src/render.js — 画布渲染：火柴人骨架、角度标注、校准虚线轮廓

> 层：渲染 ｜ 417 行 ｜ 唯一直接操作 Canvas 2D 的模块
> 一句话：把「关键点 + 当前判定焦点」画成人能看懂的画面，不参与任何判定。

## 1. 它解决什么问题（为什么需要它）

用户需要立刻知道「我现在差多少」：所以画面里既要有骨架（姿态对不对），也要有关键角度数字
（差 10° 还是 30°）。哪些角度该标、标在哪个关节，由动作的判据决定（`FOCUS` 表），
而不是全画一遍 —— 否则画面全是数字。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 内容 | 说明 |
|---|---|---|---|
| `COLORS` | L10-L16 | `ok/good/warn/bad/idle` | 骨架按判定结果变色 |
| `OUTLINE_COLORS` | L23-L27 | `search/adjust/ready` | 校准轮廓三态（亮天蓝 / 亮琥珀 / 亮绿） |
| `FOCUS` | L34 起 | `动作 id → ['knee','hip',…]` | 该动作要标哪几个关节角 |
| `PoseRenderer` | L110-L408 | class | 唯一对外类 |

## 3. 算法与流程（步骤化）

**每帧**（由 `app.js` 的渲染循环调用）：

```
renderer.resize(w, h)          // 只在尺寸变了时改 canvas.width/height（L123-L128）
renderer.clear()               // L130-L132
renderer.draw({…})             // L195 起：按 SKELETON_EDGES 连线 + 关节点，颜色按判定结果
renderer.drawAngles(landmarks, frame, exerciseId, W, H, base)  // L265：只画 FOCUS[id] 里的关节
renderer.drawOutline(kind, status, flip)   // 校准阶段：虚线轮廓 + 二次贝塞尔平滑（L147 起）
```

`closedCurvePath(points)`（L170）是把轮廓点连成平滑闭合曲线的内部工具（以相邻点中点为锚）。

- **镜像**：画面被 CSS `scaleX(-1)` 翻过来时，画布上画出来的**文字也会反着写**，
  所以角度标签要再翻一次（L116-L120 的 `mirror`）。
- **校准轮廓**：只画**一条闭合外部轮廓**，用相邻点中点为锚做二次贝塞尔平滑；
  颜色取高饱和 + 外发光，保证在白墙 / 木地板 / 深色衣服上都看得见（L134-L162）。

辅助导出：`showsTrunkAngle(id)` L79、`showsSpreadReadout(id)` L91（界面要不要显示躯干角 / 开合读数）、
`bothKneesVisible(frame, leftKnee, rightKnee)` L103（正面动作要双侧膝都在画面内才标数字）。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `new PoseRenderer(canvas)` | L110 | → 实例 | 拿 canvas 的 2d context |
| `renderer.resize(w,h)` / `clear()` | L123 / L130 | void | 尺寸与清屏 |
| `renderer.draw({…})` | L195 | void | 一帧骨架（颜色按判定结果） |
| `renderer.drawAngles(landmarks, frame, id, W, H, base)` | L265 | void | 关键角度数字 |
| `renderer.drawOutline(kind, status, flip)` | L147 | void | 校准虚线轮廓（5 种 kind） |
| `FOCUS` | L34 | 常量 | 动作 → 标注哪些关节 |
| `showsTrunkAngle` / `showsSpreadReadout` | L79 / L91 | → boolean | 显示与否 |
| `bothKneesVisible(frame, …)` | L103 | → boolean | 正面动作的可见性门槛 |

> 骨架与角度的具体绘制在类内部（L164-L408），只通过 `renderer` 调用，不对外导出。

## 5. 与其它文件的关系

- 上游：`geometry.js`（`LM` / `SKELETON_EDGES`）、`i18n.js`（角度标签单位）、
  `calibration.js`（`outlinePath` / `outlineBounds`）、`catalog.js`（`FOCUS` 按动作查）。
- 下游：只有 `app.js`（每次 `requestAnimationFrame` 里调）。
- 不依赖任何识别器实例：拿到的是 `frame`（`metrics.js` 的输出），所以渲染不会影响判定。

## 6. 易错点与设计取舍

- **状态在 app.js，不在渲染器**：这里没有「这一帧该不该画」的判断，调用方决定。
- `resize` 只在尺寸变化时写 `canvas.width`（会清空画布 + 重置 context 状态）—— 每帧都写会闪。
- `FOCUS` 决定「标哪些角」：新增动作如果判据是关节角却没进 `FOCUS`，用户就看不到数字，
  但**不影响判定**（纯展示）。
- 校准轮廓的「三态颜色」与 `calibration.js` 的 `ready/adjust/search` 一一对应，改一处要同步。
- 文字镜像的坑：`mirror` 为真时标签要反向，否则用户看到的是「镜像文字」。

## 7. 读代码建议（先看哪几行）

1. L34-L78 `FOCUS`（哪些动作标哪些角）；
2. L110-L132 类构造 + `resize` / `clear`；
3. L147-L200 `drawOutline`（校准轮廓的画法与配色理由）；
4. L103-L108 `bothKneesVisible`（正面动作的可见性门槛）。
