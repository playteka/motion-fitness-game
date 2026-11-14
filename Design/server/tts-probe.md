# server/tts-probe.mjs — 火山 TTS 连通性探针（试资源 id × 接口版本）

> 层：服务端（工具链） ｜ 141 行 ｜ 命令行脚本，不是服务
> 一句话：把候选「资源 ID × 接口版本」挨个试一遍，直接告出「哪一组能通」。

## 1. 它解决什么问题（为什么需要它）

TTS 2.0 的资源 id 在不同开通口径下叫不同名字（`volc.service_type.10029` / `volc.megatts.default` /
`volc.tts.default` / `volc.seedtts.default`），音色 id 又必须从控制台复制。与其猜，不如让它试。
ASR 就踩过 `bigasr` vs `seedasr` 的坑（文件头 L4-L5）。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 说明 |
|---|---|---|
| `arg(name, fallback)` | L19-L22 | 极简参数解析（`--voice` / `--resource` / `--text`） |
| `coach.env` 读取 | L24-L43 | `COACH_ENV` 或当前目录；缺字段直接退出并说明 |
| `candidates` | L54-L61 | 4 个候选资源 id（`--resource` 可覆盖） |
| `tryV1(resource)` | L64 | 老接口 `api/v1/tts`（`Bearer;key` 风格） |
| `tryV3(resource)` | L82 | 新接口 `api/v3/tts/unidirectional`（`X-Api-*` 头） |

## 3. 算法与流程（步骤化）

```
① 读 coach.env → appId / apiKey / voice（voice 必填，否则给出复制 path 的提示）
② 打印脱敏摘要：APP ID / API Key 只留前 4 位 + 长度
③ for resource in candidates:  for fn in [tryV3, tryV1]:
       POST 15s 超时 → 打印「✓ 可用 / ✗ 失败」+ HTTP 状态 + 前 200 字符
④ 结束：有能通的 → 打印可直接粘进 coach.env 的那一行（VOLC_TTS_RESOURCE=…）；
       都不通 → 列出三个最可能的原因（音色 id / 资源 id / 是否同一应用），exitCode = 1
```

## 4. 对外接口

- 没有 `export`：这是**人跑的脚本**（`node server/tts-probe.mjs [--voice …]`）。
- 输出契约：能被用户整段复制给维护者判断返回码（文件末尾 L139-L140）。

## 5. 与其它文件的关系

- 上游：`server/env.mjs`（`loadEnvFile`）。
- 下游：无。它的结论直接写进 `coach.env`（`VOLC_TTS_RESOURCE`），再由
  `server/volc-tts.mjs` 的 `loadTtsConfig` 读走。
- 与 `server/asr-probe.mjs` 是一对（识别 / 合成各一个）。

## 6. 易错点与设计取舍

- **不打印完整密钥**：只用 `mask()`（前 4 位 + 长度）。
- 两个接口都试：v1 与 v3 鉴权风格不同，只看状态码就能判断「鉴权对不对 / 资源对不对」。
- 15s 超时：不设上限时连不上会挂住终端。
- 本脚本**不写任何文件**（文件头 L13）：诊断不应该产生副作用。
- 默认文本是中文且带动作术语（`髋角 160 到 180 度…`），因为 TTS 对生僻词的处理最容易暴露
  资源 / 音色填错。
- 探到的资源 id 只写进 `coach.env`（`VOLC_TTS_RESOURCE`，由 `server/volc-tts.mjs` 的
  `loadTtsConfig` 读），**不要**写死在代码里 —— 换了开通方式就要能立刻改。

## 7. 读代码建议（先看哪几行）

1. L1-L14 头部（为什么需要它）；
2. L19-L51 参数与凭证检查（缺什么就报什么）；
3. L53-L106 候选资源与两个接口的实现；
4. L108-L141 结果汇总（能通的那一行怎么给用户）。
