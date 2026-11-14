# server/asr-probe.mjs — 火山流式 ASR 连通性探针（`npm run asr:probe`）

> 层：服务端（工具链） ｜ 216 行 ｜ 命令行脚本，不是服务
> 一句话：不开游戏、不用麦克风，只验证「coach.env 读得到 → 握手 101 → 能收到响应」。

## 1. 它解决什么问题（为什么需要它）

排查「语音没字幕」时，最怕分不清是「配置错」「网络不通」还是「前端问题」。这个探针把
服务端那一段单独跑一遍：凭证在不在、握手能不能过、开始帧 + 一段合成 PCM + 最后一包
能不能拿到响应（错误帧会打印错误码）。沙箱 / 无外网环境下会快速失败并打印
`network` / `timeout`，那是**预期**结果。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 说明 |
|---|---|---|
| `HERE` / `ROOT` | L24 / L25 | 脚本定位（找 `coach.env`） |
| `syntheticPcm(seconds, {freq, amp, rate})` | L30 | 合成一段正弦波 PCM（不需要真麦克风） |
| `parseArgs(argv)` | L40 | `--env` / `--seconds` 等参数 |
| `describeHandshake(headers)` | L56 | 握手响应头摘要（脱敏） |
| `runProbe({...})` | L69 | 主流程（可注入，便于测试） |

## 3. 算法与流程（步骤化）

```
① loadEnvFile → 三个字段（APP ID / API Key / Resource）够不够 → 只打印「配了、几个字符」
② openVolcSocket(url, headers) → 握手是否 101（失败打印稳定 code：auth / network / timeout）
③ createVolcSession → 发开始帧 → 发 syntheticPcm(1.0s) → 发最后一包
④ 等响应：partial / final / error 都打印；错误帧打印 volcCode + sanitizeDetail 后的正文
⑤ 结尾：成功以 ✓ 收尾；失败给出该查什么（凭证 / 资源 id / 网络）
```

所有输出经 `sanitizeDetail` + 显式 secret 列表脱敏（文件头 L10）。

## 4. 对外接口

| 导出 | 位置 | 说明 |
|---|---|---|
| `runProbe(opts)` | L69 | 可编程调用（默认 CLI 入口在文件末尾） |
| `syntheticPcm(seconds, opts)` | L30 | 合成 PCM（测试 / 无麦克风环境用） |
| `describeHandshake(headers)` | L56 | 握手头摘要 |

## 5. 与其它文件的关系

- 上游：`server/env.mjs`（`loadEnvFile` / `maskSecret` / `volcConfigFrom`）、
  `server/volc-asr.mjs`（`createVolcSession` / `openVolcSocket`）、
  `server/volc-protocol.mjs`（`AUDIO_FORMAT` / `sanitizeDetail`）。
- 下游：无（人跑的脚本）。`package.json` 的 `asr:probe` 脚本指向它。
- 与 `server/tts-probe.mjs` 是一对：一个测识别、一个测合成。

## 6. 易错点与设计取舍

- 探针**绝不打印密钥**：只打印长度 / 前几位；错误正文也要脱敏。
- 无外网时快速失败是**正确行为**，不要为了「看起来成功」跳过握手校验。
- 合成 PCM 而不是录麦：探针要能在没有麦克风的机器 / CI 上跑。
- 超时要有上限（默认几秒）：否则连不上时会挂住终端。
- 它验证的是**服务端那一段**：即使探针通过，前端仍可能因权限 / AudioWorklet 出问题
  （那时用界面里的「语音自检」，见 `Design/src/voice/selftest.md`）。

## 7. 读代码建议（先看哪几行）

1. L1-L24 头部（用途与预期失败）；
2. L30-L68 合成 PCM 与参数解析；
3. L69 起 `runProbe`（四步验证的实际顺序）。
