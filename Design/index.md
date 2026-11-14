# index.html — 单页应用骨架（静态 DOM + 所有弹窗 + WebGL/canvas 容器）

> 层：界面（结构） ｜ 989 行 ｜ 无构建步骤，直接被浏览器加载
> 一句话：`src/app.js` 需要的每一个 DOM 节点都在这里；id 是它俩之间的契约。

## 1. 它解决什么问题（为什么需要它）

项目零构建：`index.html` 直接 `import` `src/app.js`（`<script type="module">`）。
所以页面的**结构**（顶栏、舞台、HUD、校准层、各种弹窗）必须一次写全；
`app.js` 用 `$('id')` 取节点，改 id 就是改接口。所有可见文字都是**空的**
（`<span data-i18n="…">`），由 `i18n.js` 的 `applyI18n()` 填。

## 2. 关键数据结构 / 常量（表）

| 区块 | 位置 | 内容 | 说明 |
|---|---|---|---|
| `<head>` | L3-L19 | viewport / PWA meta / `style.css` / `manifest.webmanifest` | PWA 与图标（`apple-touch-icon`） |
| 顶栏 | L22-L60 | 品牌、版本号、返回 / 最佳 / 记录 / 运动设定 / 设置 按钮 | 图标全部是内联 Lucide 线条（不用 emoji） |
| 舞台 | 中段 | `<video id="video">` + `<canvas id="overlay">` | 摄像头画面 + 骨架/轮廓画布 |
| 主页 / 动作库 | 中段 | 分类卡、动作卡、目标选择 | 由 `app.js` 动态渲染，容器在这里 |
| HUD / 圆环 | 中段 | 右上进度圆环、左下退出圆环、手势圆环 | 尺寸来自 CSS `--ring-px` |
| 弹窗 | 后段 | 设置 / 记录 / 最佳 / 运动设定 / 语音帮助 / 记忆 | `hidden` 属性控制显隐 |
| R4 规则面板（在设置弹窗里） | L720-L740 | 报数 / 读秒两个 toggle、`#ruleList`（列表由 `app.js` 动态建）、`#btnRuleReset`、`#ruleLimitHint` | 行数不写死：`renderRulePanel()` 按规则表渲染 |
| R4 诊断两行 | L286-L291 | `#coachDiagWhySaid` / `#coachDiagWhySkip` | 「刚才那句为什么说 / 为什么没说」 |
| 脚本 | 末尾 | `<script type="module" src="./src/app.js">` | 唯一入口 |

`data-i18n*` 五种属性（`data-i18n` / `-html` / `-title` / `-aria` / `-placeholder`）在这里大量使用，
由 `i18n.js` 的 `applyI18n()` 统一填充。

## 3. 算法与流程（步骤化）

页面本身没有算法，它的「流程」是**加载顺序**：

```
① 浏览器解析 HTML（此时所有文字为空 / 图标内联可见）
② 加载 style.css → 首屏骨架有样式（无 FOUC 依赖 JS）
③ 加载 manifest / 图标（PWA）
④ 执行 src/app.js → boot()：
     读设置 → detectLang() → applyI18n(document)（填文案）→ 绑定按钮 / 热键
     → 建校准器 → 加载姿态模型 → 开摄像头 → requestAnimationFrame(loop)
```

## 4. 对外接口

- **DOM id**：`app.js` 里 `$('id')`（L72）读取的每一个 id 都是契约（按钮、弹窗、HUD、canvas）。
- **`data-i18n*` 属性**：与 `locales/*.js` 的键一一对应。
- **CSS 类名**：`style.css` 选择器与 `app.js` 动态插入的节点类名一致。
- **PWA**：`manifest.webmanifest` + `theme-color` + `apple-touch-icon`。

## 5. 与其它文件的关系

- 下游（被谁读）：`src/app.js`（全部节点）、`style.css`（全部选择器）、`i18n.js`（`applyI18n`）。
- 上游：`style.css`、`src/app.js`、`manifest.webmanifest`、`icons/*.png`。
- 测试：`tests/test-page.mjs` 检查结构（脚本入口、关键 id、`data-i18n` 完整性等）。

## 6. 易错点与设计取舍

- **所有可见文字必须留空 + `data-i18n`**：写死中文会让英文界面混中文，也会被 `test-i18n` 抓到。
- **图标用内联 SVG（Lucide 路径）**：不用 emoji（跨平台渲染不一致），也不引图标库。
- **不要给节点加内联 `style` 宽度/高度**：圆环尺寸统一由 CSS 变量 `--ring-px` 控制，
  否则会出现「两个圆环一大一小」的老 bug（见 `style.css` 的注释）。
- 弹窗用 `hidden` 属性而不是 `display:none` 内联样式：`app.js` 用 `.hidden` 判断状态
  （`settingsOpen()` 等）。
- 改 id / 改结构后必须跑 `npm test`（`test-page` / `test-app` 会对照）。
- 手机摄像头需要 HTTPS：页面本身不做兼容，由 `preview-server.js` 的 `HTTPS=1` 提供。

## 7. 读代码建议（先看哪几行）

1. L3-L19 `<head>`（PWA / 图标 / 样式，改移动端先看这里）；
2. L22-L60 顶栏按钮（id 与图标写法示例）；
3. 搜 `id="video"` / `id="overlay"`（舞台两个核心节点）；
4. 搜 `settingsModal` / `exerciseModal`（弹窗的 `hidden` 模式）。
