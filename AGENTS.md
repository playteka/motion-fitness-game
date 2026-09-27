# 给后续 AI 会话的约定（动这个仓库之前先读）

## Git：**不要自动 push**（用户明确要求）

> 用户原话：「以后不要每次修改都 git push 了，先修改代码，等我让你做 git push 的时候再保存到
> github，否则每条修改指令你都要我确认，有点烦。」

- **改代码 → 本地提交（`git commit`）即可**，`git push` 会让沙箱弹审批框，用户每次都要点一下，很烦。
- 只有用户**明确说**「push / 推到 github / 提交到远端」时才 `git push`。
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
- **测试**：`npm test` 跑六套（i18n / detectors / engines / specs / page / app），改完必须全绿；
  新增功能要补断言，用户反馈过的现象要钉住（README 里 `tests/*.mjs` 的说明与测试数也要同步刷新）。
- **中英两份 README 结构必须一致**（`tests/test-i18n.mjs` 会对照标题数 / 表格行数 / 代码块数 / 目录条目）。
- **临时脚本**：调试用的探针写 `tests/probe_*.mjs`、提交信息写 `commitmsg*.tmp`，
  **用完必须删掉**，别提交进仓库。
- **PowerShell 注意**：中文 / 反引号 / `<` 会让内联 `node -e` 挂掉 —— 需要中文时用 write 工具写临时
  `.mjs` 再 `node` 跑；文件的换行符要跟着原来的（README 是 CRLF，src 是 LF）。
- **日志**：`logs/` 是「记录调试数据」写出来的真实关节数据（已 gitignore），只留在本地。
