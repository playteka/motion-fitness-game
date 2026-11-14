# src/calibration.js — 运动前的人体校准（轮廓 + 几条稳健检查）

> 层：识别（准入） ｜ 620 行 ｜ 纯逻辑 + 一个 `Calibrator` 类
> 一句话：告诉用户「站进来」并判断「人是否真的在画面里、机位对不对、躺/站姿态对不对」。

## 1. 它解决什么问题（为什么需要它）

MediaPipe 在「人太小 / 只入镜一半 / 侧对镜头却在做正面动作」时照样输出 33 个点，
读数看起来正常、判定全错。校准就是**开始运动前的准入闸门**：画一个虚线人体轮廓当视觉目标，
判定却用几条与身高无关的数值检查（可见度、入镜、大小、居中、机位、保持不动）。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 内容 | 说明 |
|---|---|---|---|
| `OUTLINE` | L28-L51 | `centerX .5 / groundY .92 / bodyTopY .155 / spanMin .30 / spanMax .98 / centerTol .34 / topTol .36 / groundTol .28 / edgeSlip .03 / holdMs 600 / steadyWindowMs 700 / steadyTol .06` | 站立轮廓与**建议**阈值 |
| `BLOCKING_CHECKS` | L53 | `Set{'visible','framing'}` | 只有这两条**必须**通过，其余只是提示 |
| `LYING` | L393-L399 | `spanMin .42 / spanMax .90 / edgeSlip .03` | 躺姿（俯卧 / 仰卧）改用水平跨度 |
| `Calibrator` | L413-L620 | class | 吃每帧指标，吐「还差什么」 |

## 3. 算法与流程（步骤化）

**构造**（L414-L429）：从 `catalog.js` 读动作的 `view` / `posture`，换算成轮廓种类
（`outlineKind`）、镜像、朝向 `facing`，并把 `groundY` 置空。

**每帧**（`evaluate(f)` L464 起）：

```
push('visible', f.ok && f.bodyVisible && f.coreVis > PERSON_VIS_MEAN …)   // 必须
push('framing', …全身入镜（容忍 edgeSlip）…)                              // 必须
push('size' / 'center' / 'height' / 'view' / 'steady')                     // 建议
→ 返回 [{id, ok, blocking}]，顺序即界面清单顺序
```

**保持与完成**：所有项通过后开始累计时间，达到 `OUTLINE.holdMs`（600ms）→ `done=true`；
`progress` = 保持进度 0~1；`hintKey` = 第一个没通过的项。站立/躺姿用两套阈值
（`lying` getter L461 决定）。

**地面线**（`observeGround` L443-L449）：把 `f.groundY` 攒进滑动窗口（≤90 帧），
**攒够 12 帧后取中位数**作为 `this.groundY` —— 之后所有「离地高度」都以它为基准
（抬腿 / 跳跃时脚踝会跟着身体动，不能拿脚踝当地面）。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `OUTLINE` / `LYING` / `BLOCKING_CHECKS` | L28 / L393 / L53 | 常量 | 阈值（界面显示同一份） |
| `new Calibrator(exerciseId, opts)` | L413 | → 实例 | `opts.mirror` 控制左右提示方向 |
| `evaluate(f)` | L464 | → `[{id, ok, blocking}]` | 逐项检查 |
| `observeGround(f)` / `groundRef` | L443 / L440 | void / 数 | 地面线（校准阶段观测） |
| `setExercise(id)` / `reset()` / `setMirror(on)` | L451 / L433 / L431 | void | 换动作 / 重来 / 镜像 |
| `exercisePose(id)` | L294 | → 对象 | 该动作的人体示意（轮廓参考） |
| `requiredView(id)` / `requiredPosture(id)` / `outlineKind(id)` | L316 / L321 / L326 | → 字符串 | 机位 / 姿态 / 轮廓种类 |
| `outlinePath(kind, {flip})` / `outlineBounds(kind)` | L362 / L374 | → 路径 / 包围盒 | 供 `render.js` 画虚线 |

## 5. 与其它文件的关系

- 上游：`catalog.js`（`view` / `posture`）、`metrics.js`（`PERSON_VIS_MEAN`）、`geometry.js`（`median`）。
- 下游：`render.js`（`outlinePath` 画轮廓）、`app.js`（每帧 `evaluate` + `observeGround`，
  并把 `groundY` 写进 `computeFrame` 的 `calib`）、`pose-engine.js`（无关，只提供关键点）。

## 6. 易错点与设计取舍

- **轮廓只是给眼睛看的**：判定用数值，不做「逐点比对关节位置」—— 后者会因手臂摆动永远对不上
  （文件头 L6-L9）。
- 演进史写在 L22-L27：曾经「必须套进轮廓」→ 大量用户卡住 → 现在只有 `visible` / `framing` 是必须的。
  **不要再把建议项改成必须**。
- 可见度门槛必须与识别器同源（`PERSON_VIS_MEAN`），否则会出现「火柴人已经变彩、校准却说没人」。
- 地面线取**中位数**而不是均值：单帧跳变会带偏整组读数。
- `facing`（L423）：侧拍时人可能朝左或朝右，轮廓要跟着翻，否则头脚方向是反的。

## 7. 读代码建议（先看哪几行）

1. L28-L53 阈值 + `BLOCKING_CHECKS`；
2. L464-L500 `evaluate`（每项检查怎么算）；
3. L443-L449 `observeGround`（地面线为什么是中位数）；
4. L316-L362 三个「动作 → 机位/姿态/轮廓」的映射。
