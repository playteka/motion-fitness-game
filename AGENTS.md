# 给后续 AI 会话的约定（动这个仓库之前先读）

## Git：**不要自动 push**（用户明确要求）

> 用户原话：「以后不要每次修改都 git push 了，先修改代码，等我让你做 git push 的时候再保存到
> github，否则每条修改指令你都要我确认，有点烦。」

- **改代码 → 本地提交（`git commit`）即可**，`git push` 会让沙箱弹审批框，用户每次都要点一下，很烦。
- 只有用户**明确说**「push / 推到 github / 提交到远端」时才 `git push`。
- **不要主动重试**：推送失败（断网 / 连接被重置）就如实报告「本地已提交，未推送」并停手，
  不要自动重试、也不要下一轮顺手补推 —— 等用户再开口。
- **一次授权只管一次**：用户说「推送」只推**当时已有的**提交；之后新做的改动默认留在本地，
  想要再推要用户再说一次（用户 2026-xx 再次强调：「不要每次修改都 push 到 github，除非我要求你这么做」）。
- 需要 push 时：`git -c http.version=HTTP/1.1 push origin main`，并且要带
  `sandbox_permissions: danger-full-access`（沙箱会拦 git 的凭据助手），提交信息用
  `git commit -F 临时文件`（PowerShell 里中文/引号会出问题），临时文件提交前 `git reset -q` 掉、用完删掉。

## 这个项目的其它固定约定

- **零依赖纯前端**：`index.html` + `src/*.js` + `styles 在 style.css`；本地预览 `node preview-server.js`
  （默认 http://127.0.0.1:4174），**必须走 http**（file:// 拿不到摄像头）。
- **一处定义**：界面上显示的阈值必须来自识别器真正用的常量（`src/specs.js` / `src/icons.js` 都从
  `src/catalog.js` 与识别器常量里取），改一个数界面跟着变，不许另抄一份。
- **识别器**：绝大多数动作走 `src/engines.js` 的配置驱动引擎（bend / alt / twist / sequence / hold）；
  手写识别器只在需要精细判定的动作上（squat / lunge / bridge / plank / crunch / boxJump）。
- **测试**：`npm test` 跑七套（i18n / detectors / engines / specs / page / app / voice），改完必须全绿；
  新增功能要补断言，用户反馈过的现象要钉住（README 里 `tests/*.mjs` 的说明与测试数也要同步刷新）。
- **中英两份 README 结构必须一致**（`tests/test-i18n.mjs` 会对照标题数 / 表格行数 / 代码块数 / 目录条目）。
- **临时脚本**：调试用的探针写 `tests/probe_*.mjs`、提交信息写 `commitmsg*.tmp`，
  **用完必须删掉**，别提交进仓库。
- **PowerShell 注意**：中文 / 反引号 / `<` 会让内联 `node -e` 挂掉 —— 需要中文时用 write 工具写临时
  `.mjs` 再 `node` 跑；文件的换行符要跟着原来的（README 是 CRLF，src 是 LF）。
- **日志**：`logs/` 是「记录调试数据」写出来的真实关节数据（已 gitignore），只留在本地。

## 改代码必须同步 `Design/` 文档（用户明确要求，缺了视为没做完）

> 用户原话：「改任何源代码 → 同步更新 `Design/` 里对应文档与 `Design/ARCHITECTURE.md`
> （提交信息里注明『docs: Design 同步』），否则视为不完整。」

- `Design/` 是**逐文件**设计文档：`Design/src/*.md`、`Design/src/voice/*.md`、`Design/server/*.md`、
  根目录的 `Design/index.md` / `style.md` / `preview-server.md`，`tests/` 汇总在 `Design/tests.md`；
  索引与分层见 **`Design/README.md`**（一份 md 对一个源文件）。
- 每份文档固定七节（为什么需要它 / 数据结构 / 算法流程 / 对外接口 / 与谁有关 / 易错点 / 读代码建议），
  正文里的行号必须是**真实存在的区间**（如 `L120-L180`），不确定写「（待确认）」。
- **改动判定**：
  - 改了某个 `src/**`、`server/**`、`index.html`、`style.css`、`preview-server.js` → 更新对应 md；
  - 改了模块边界 / 数据流 / 端点 / 文件增删 → 同时更新 `Design/ARCHITECTURE.md` 与 `Design/README.md` 索引；
  - 只改注释 / 纯格式 → 可以不更新，但行号大幅漂移时要顺手校正。
- **提交信息**：代码 + 文档放在同一个提交里，信息末尾加一行 `docs: Design 同步`。
  提交只写明确路径（别 `git add -A`，`coach.env` / `server/memory/` / `logs/` 绝不入库）。

## 每次改完代码：**自动重启预览服务**（用户明确要求）

> 用户原话：「每次修改完代码之后请帮我自动把服务重启，请记住。」

- **改完并提交后，主动重启 `preview-server.js`**（它能加载服务端改动：`/asr`、`/progress.json`、`/__debug/log`、HTTPS 等）；
- 纯前端改动理论上只需 Ctrl+F5（服务器读磁盘），但**按要求仍然重启**，省得用户分不清 ✓；
- **重启方式**：先用 `netstat -ano | findstr :4174` 找到占用进程 → `Stop-Process` → 再以**受管后台任务**起 `node preview-server.js`（`HOST=0.0.0.0`）→ 等 3~4 秒再验证 `HTTP 200` ✓；
- ⚠️ 如果 4174 是**用户自己双击启动器**开的窗口（不是我们的后台任务）：**不要直接杀** ✗（会关掉他的窗口）→ 改成告诉他「重启一下启动器」或「只需要 Ctrl+F5」✓；
- 重启后必须验证并回报：`HTTP 200` + 需要的端点（`/progress.json`、`/asr` 的 `configured`）✓。
## 进度看板的任务进度条：怎么用（`.progress-task.json`）

> 用户要求：「假设要改 10 个文件，改好 5 个进度就到一半」—— 看板按**文件数**算进度。

- **开工时**在仓库根目录写 `.progress-task.json`（**已 gitignore** ✓）：
  ```json
  { "title": "任务标题", "planned": ["src/a.js", "src/b.js", "…"], "startedAt": <Date.now()> }
  ```
- **完工后删掉它** ✓（不要留假数据 ✗ —— 用户明确问过「示例 section 有必要吗」，
  结论是**没必要**：没有清单时看板自动隐藏那块 ✓）。
- 看板（<http://127.0.0.1:4174/p>）会把「清单里 mtime ≥ startedAt 的文件」标成 ✓，
  进度 = 已完成 / 总数 ✓ —— 真的按文件算，不是估算 ✓。
- 派子代理做较大改动时，**由主代理负责写这份清单**（子代理只改代码 ✓）。
