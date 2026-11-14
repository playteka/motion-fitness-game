# server/env.mjs — 极简 `KEY=VALUE` 解析 + 凭证脱敏

> 层：服务端（工具） ｜ 113 行 ｜ 零依赖，只读文件，**不打印值**
> 一句话：读 `coach.env` 的那 20 行代码，以及「日志里绝不出现密钥」的那 50 行。

## 1. 它解决什么问题（为什么需要它）

项目零依赖，不能引 `dotenv`。而凭证（火山 APP ID / API Key、LLM Key）只能放在
`coach.env` 里（已 gitignore）。同时所有对外输出（日志 / 健康检查 / 错误信息）都必须
只出现「配了没配、几个字符」，不能出现值 —— 所以解析与脱敏放在同一个文件里。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 内容 | 说明 |
|---|---|---|---|
| `parseEnv(text)` | L21 | `Record<string,string>` | 解析 `KEY=VALUE`（支持 `export` 前缀 / 引号 / 行尾注释） |
| `loadEnvFile(file)` | L49 | 路径 → 对象 | 读文件 + 解析（读不到返回空对象，不抛） |
| `redactSecrets(text, secrets)` | L63 | 字符串 | 把出现的密钥值替换成 `***` |
| `maskSecret(value)` | L77 | 字符串 | 只留「长度 / 前 4 位」这种形式 |
| `COACH_ENV_KEYS` | L84-L93 | 数组 | coach.env 认可的键名清单 |
| `volcConfigFrom(env)` | L94 | → `{appId, apiKey, resourceId, …}` | 从环境变量取火山三项 + 缺哪些 |

## 3. 算法与流程（步骤化）

```
loadEnvFile(path) → fs.readFileSync
  逐行：去注释（不带引号时切 #）→ 去 export 前缀 → 去引号 → split('=') 首个等号
  → {KEY: VALUE}（只进内存 / process.env，不写回文件）
对外输出：maskSecret(key) → 「已配置（32 字符）」；redactSecrets(text, [key…]) → '***'
```

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `parseEnv(text)` | L21 | → 对象 | 纯函数（测试直接用字符串） |
| `loadEnvFile(file)` | L49 | → 对象 | 读不到 → `{}` |
| `redactSecrets(text, secrets=[])` | L63 | → 字符串 | 上游错误正文过一遍 |
| `maskSecret(value)` | L77 | → 字符串 | 「配了、几个字符」 |
| `COACH_ENV_KEYS` | L84 | 常量 | 键名白名单 |
| `volcConfigFrom(env=process.env)` | L94 | → `{config, missing}` 形状（具体字段见实现） | 火山配置装配 |

## 5. 与其它文件的关系

- 下游：`server/coach-proxy.mjs`、`server/volc-tts.mjs`、`server/llm-provider.mjs`、
  `server/volc-protocol.mjs`（`redactSecrets`）、`server/asr-probe.mjs`、`server/tts-probe.mjs`。
- 上游：只有 `node:fs`（零依赖）。

## 6. 易错点与设计取舍

- **解析失败不抛**：缺 `coach.env` 时服务端要能起来（健康检查报 `configured:false`），
  而不是启动即崩。
- 行尾注释只在**不带引号**时才切：`KEY="a#b"` 里的 `#` 是值的一部分。
- `redactSecrets` 要在**所有**对外错误路径上调用：上游把 key 回显到错误正文是真实存在的。
- `maskSecret` 只用于人看的日志；不要把它的输出再拿去拼请求。
- 改动键名要同步 `COACH_ENV_KEYS` 与 README 的配置表（用户照 README 填）。

## 7. 读代码建议（先看哪几行）

1. L1-L14 头部（支持哪些写法）；
2. L21-L62 `parseEnv` / `loadEnvFile`（唯一的解析逻辑）；
3. L63-L84 `redactSecrets` / `maskSecret`（安全约定）；
4. L94 起 `volcConfigFrom`（缺字段时返回什么）。
