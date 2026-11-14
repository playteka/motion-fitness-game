# src/icons.js — 关键帧线条图标 + 界面图标（SVG 生成器）

> 层：渲染（矢量图） ｜ 1263 行 ｜ 纯函数，返回 SVG 字符串，不碰 DOM
> 一句话：进度条上每一格的火柴人都是**按那一格的真实判据**画出来的，不是装饰图。

## 1. 它解决什么问题（为什么需要它）

用户要一眼看出「这一格要求什么姿势」。emoji 做不到（也不统一），位图要维护几十张。
所以用**代码画**：给定一格的 `metric/value`，反推关节角，用固定段长拼出火柴人。
好处是 `tests/test-specs.mjs` 能把「图标里画的角度」与「判据里的角度」直接对照 ——
判据改了图标会自动跟着变（文件头 L2-L14 的设计原则）。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `ICON_BOX` | L20 | `32` | 关键帧图标画布边长 |
| `SEG` | L29 | `{shin 5.2, thigh 5.2, torso 6.4, upper 3.1, fore 3.0, head 1.55}` | 人体各段长度（图标单位） |
| `APP_ICON_BOX` | L1096 | `24` | 界面图标（Lucide 风格）画布 |
| `ICON_BUILDERS` | L1263 | `{buildStand, buildLie, SEG, STAND_FLOOR, LIE_HIP}` | 姿态构造器（测试也读） |

姿态对象：`{ builder, params, criterion, drawn }` —— `params` 是画图参数，
`criterion` 是**这一格要求的判据值**，`drawn` 是实际画出来的值（两者一致才算对）。

## 3. 算法与流程（步骤化）

**一格 → 姿态**（`poseFor(stage, ctx)` L551 起）：

```
metric / value / posture / stages 从参数来
① frontKnee / straighterKnee → 箭步蹲姿态（lungePose）
② ctx.plan === 'standAlt'（勾腿跳）→ 站姿/勾腿姿态（不特判会错画成躺姿）
③ stage.pose（门控格）→ 按动作挑「标准姿态」：开合跳并拢、跪撑、俯撑、仰卧…
④ 其余按 metric 落进通用分支（膝角 / 髋角 / 离地高度 / 开合幅度…）
```

**姿态 → SVG**（`stageIcon` L883 → `iconSVG` L980）：按 `builder` 拼线段与头部圆点，
线宽与圆角按 `ICON_BOX` 归一化；**同一批格子共用一套比例尺**（站立类以脚底 + 髋为锚，
躺姿类以肩 / 髋为锚），所以深度差别能看出来（文件头 L11-L12）。

**角度标注**：`stageAngle(stage)` L944、`angleLabel(stage, ctx)` L963、`iconAngle(stage, ctx)` L1229
（图标里真实画的角度）、`drawnAngle` L1241、`iconHipY` L1256 —— 测试与调试用。

**界面图标**：`libIconSVG(key, cls)` L464（Lucide 路径表）、`pawSVG` L471（猫爪指针）、
`categoryMarkSVG(id)` L478（分类标记）、`navPoseSVG(kind)` L483（圆环导航里的小人）、
`exercisePoseSVG(id)` L1199（动作库卡片上的人体姿态，没有则返回空串，界面退回 emoji）。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `poseFor(stage, ctx)` | L551 | → 姿态对象 | 一格画什么 |
| `iconSVG(stage, ctx)` | L980 | → SVG 字符串 | 进度条图标 |
| `stageIcon` / `stageAngle` / `angleLabel` | L883 / L944 / L963 | → 字符串 | 图标 / 角度 / 标签 |
| `exercisePoseSVG(id)` | L1199 | → SVG 或 `''` | 动作卡片姿态图 |
| `libIconSVG(key, cls)` | L464 | → SVG | 界面线条图标（`ui:*` 键） |
| `categoryMarkSVG(id)` / `navPoseSVG(kind)` / `pawSVG()` | L478 / L483 / L471 | → SVG | 分类 / 导航 / 猫爪 |
| `uniqueStages(stages, ctx)` | L1216 | → stage[] | 合并同图相邻格（进度条不重复画同一姿态） |
| `ICON_BOX` / `APP_ICON_BOX` / `ICON_BUILDERS` | L20 / L1096 / L1263 | 常量 | 尺寸与构造器（测试用） |

## 5. 与其它文件的关系

- 上游：`engines.js`（`isSupineGate`，判断仰卧类门控名只在一处定义）、`specs.js` 的 stage 形状。
- 下游：`app.js`（`iconSVG` / `uniqueStages` / `categoryMarkSVG` / `navPoseSVG` / `libIconSVG` / `pawSVG`）、
  `exercises.js`（`exercisePoseSVG`）、`index.html`（内联 Lucide 路径与 `libIconSVG` 同源）。
- 测试：`tests/test-specs.mjs`（图标角度 vs 判据角度）、`tests/preview-icons.mjs`（预览图）。

## 6. 易错点与设计取舍

- **不能每格各自缩放到填满方框**：那样「深蹲」和「站直」会画得一样高，深度信息就没了。
- 特判是必要的：勾腿跳不特判会落进「躺姿交替」分支（L559-L572 的注释就是踩坑记录）；
  跪姿俯卧撑的起始格不能画成标准俯撑（L578-L584）。
- 角度关系与 `tests/synthetic-pose.mjs` 同一套：`θ = 180 − |a − b|`（L14），改一处要两边同步。
- 本文件只产出**字符串**：不查 DOM、不测尺寸，所以 Node 里能直接断言 SVG。
- `exercisePoseSVG` 返回空串是**合法结果**（界面退回 emoji），不要当成错误。

## 7. 读代码建议（先看哪几行）

1. L1-L29 头部设计原则 + `SEG`；
2. L551-L600 `poseFor` 的分支顺序（先看特判再看通用）；
3. L980-L1010 `iconSVG`（姿态 → SVG 的拼装）；
4. L1199-L1230 `exercisePoseSVG` + `uniqueStages`（界面侧的两个入口）。
