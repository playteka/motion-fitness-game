# server/memory-store.mjs — 教练记忆的长期层（`server/memory/<userId>.md`）

> 层：服务端（记忆） ｜ 607 行 ｜ 不碰网络、不引依赖，Node 里直接跑
> 一句话：一个用户一个 Markdown 文件；人能读、机器能解析；白名单 + 原子写 + 手改也容忍。

## 1. 它解决什么问题（为什么需要它）

三层记忆的最后一层要**跨会话**：语气 / 难度 / 目标 / 伤病 / 每周次数。放 localStorage 会随
浏览器清缓存丢失，放数据库又超出「零依赖」的范围。所以用 Markdown 文件：
用户能自己打开看、能改、能删；服务端只按白名单字段读写。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `MEMORY_DIR` | L45 | `server/memory/` | **已 gitignore**（含个人信息） |
| `MEMORY_MAX_BYTES` | L48 | `64KB` | 超了按坏文件处理（备份 `.bad`） |
| `USER_ID_RE` | L51 | `^[a-zA-Z0-9_-]{1,32}$` | 防路径穿越 |
| `DEFAULT_USER_ID` | L54 | `default` | 单机单用户 |
| `MEMORY_SUMMARY_MAX` | L57 | `20` | 训练摘要最多 20 条 |
| `PREFS_SPEC` / `FACTS_SPEC` | L60 / L77 | 字段白名单（取值 / 范围） | 只有这些能写 |
| `PREFS_FIELDS` / `FACTS_FIELDS` / `MEMORY_FIELDS` | L83-L85 | 数组 | 供工具层做枚举 |
| `MemoryError` | L88 | class | 带 code 的错误（403 / 400 语义） |

MD 格式（文件头 L17-L34）：二级标题分节 —— `## 偏好 (prefs)` / `## 事实 (facts)`（带 `> 来源：`）/
`## 训练摘要`（表格，最新在前）/ `## 上次未完成`。

## 3. 算法与流程（步骤化）

```
读：readMemory(userId) L407
   normalizeUserId → memoryFilePath L126（resolve 后复核在 MEMORY_DIR 内）
   文件不存在 → emptyMemory(userId) L113
   超过 64KB / 解析失败 → backupBad(file) L385 → 按空记忆处理（不崩）
   parseMemoryMarkdown L297 → 规范化字段（normalizeFieldValue L144）

写：updateMemory(userId, patch, {now}) L476
   patch 只允许 prefs/facts/summary/lastUnfinished
   facts 必须带 evidence（用户原话）→ 存进 `> 来源：`（normalizeEvidence L185）
   normalizeSummary L192 / normalizeLastUnfinished L215（形状校验）
   serializeMemory L245 → writeMemoryAtomic L444（写 .tmp-* 再 rename）

删：forgetMemory(userId, target) L536 —— 删字段 / 删某条事实，不删整份记忆
体检：memoryHealth({dir}) L572 —— 只报 users 数量，不泄露内容
```

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `readMemory(userId, {dir})` | L407 | → memory 对象 | 读（不存在返回空记忆） |
| `updateMemory(userId, patch, opts)` | L476 | → 新对象 | 写（原子替换） |
| `forgetMemory(userId, target, opts)` | L536 | → 新对象 | 删字段 / 条目 |
| `memoryHealth({dir})` | L572 | → `{users}` | 健康检查（不泄露内容） |
| `normalizeUserId(value)` | L99 | → id \| null | 路径安全检查 |
| `memoryFilePath(userId, dir)` | L126 | → 绝对路径 | 拼路径 + 复核 |
| `parseMemoryMarkdown` / `serializeMemory` | L297 / L245 | 纯函数 | 解析 / 序列化（测试对拍） |
| `normalizeFieldValue(section, field, raw)` | L144 | → 值 \| null | 白名单 + 范围 |
| `PREFS_FIELDS` / `FACTS_FIELDS` / `MEMORY_FIELDS` / `MEMORY_DIR` / `MEMORY_MAX_BYTES` | L45-L85 | 常量 | 工具层与测试共用 |

## 5. 与其它文件的关系

- 上游：只有 `node:fs` / `node:path` / `node:url`。
- 下游：`preview-server.js`（`/memory`、`/memory/forget`、`/memory/health` 四个端点）、
  `server/llm-provider.mjs`（`applyMemoryOps` 真的写）、`server/llm-tools.mjs`（字段白名单）、
  `src/app.js`（记忆面板读写，走 `/memory`）。
- 与 `src/voice/session.js` 的短时记忆、`localStorage` 的中时记忆是三层中的两层：这里只做长期。

## 6. 易错点与设计取舍

- **路径穿越**是首要安全问题：`USER_ID_RE` + `path.resolve` 复核双保险（L7-L8）。
- **原子写**（`.tmp-*` → `rename`）：进程死在半路也不能留下半个 MD。
- **手改也容忍**（L14）：解析失败不崩，备份 `.bad` 后按空记忆处理；64KB 同理。
- `facts` 必须带 `evidence`：用户要能审查「教练为什么记得这件事」。
- 训练摘要与 `lastUnfinished` 由**客户端**算好同步上来（不是模型写的），仍要校验形状。
- 该目录已 gitignore：不要把 `server/memory/` 提交进仓库（提交时明确路径，别 `git add -A`）。

## 7. 读代码建议（先看哪几行）

1. L1-L35 头部（MD 格式与六条设计约束）；
2. L99-L143 `normalizeUserId` + `memoryFilePath`（安全边界）；
3. L297-L380 `parseMemoryMarkdown`（解析的容错策略）；
4. L476-L535 `updateMemory`（白名单与原子写）。
