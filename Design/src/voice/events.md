# src/voice/events.js — 事件总线（R1 规则快车道的地基）

> 层：语音（事件） ｜ 233 行 ｜ 纯 JS，**不碰 DOM**
> 一句话：把「谁在什么时候发生了什么」收敛成一条流，规则引擎和 LLM prompt 读同一份。

## 1. 它解决什么问题（为什么需要它）

语音教练原来只有两条通道：命令快车道（正则）和 LLM 环路（联网）。中间缺一层**确定性**的：
用户说「每 5 秒读一次秒」，系统应该订阅读秒事件、到点直接 TTS，**一个请求都不发**。
这层需要一份统一的事件流 —— 之前它是散在 `session.js`（自己攒 60 秒环形缓冲）和
`llm.js`（自己再裁一遍）里的两份口径，这里收敛成**一处定义**。

## 2. 关键数据结构 / 常量（表）

| 名称 | 位置 | 值 | 说明 |
|---|---|---|---|
| `EVENT_CAPACITY` | L23 | `120` | 环形缓冲容量 |
| `EVENT_WINDOW_MS` | L25 | `60_000` | `recent()` 默认窗口 |
| `EVENT_MAX_CHARS` | L27 | `60` | 单条紧凑事件的序列化上限 |
| `EVENT_MAX_FIELDS` | L29 | `4` | data 最多留几个标量 |
| `EVENT_MAX_STR` | L31 | `20` | 字符串值最多几个字 |
| `EVENT_TYPES` | L45-L60 | 14 个 | 白名单（全部来自现有识别器 / 计时器） |
| `AGENT_EVENT_TYPES` | L66 | 4 个 | 进 LLM prompt 的：`rep / gate-fail / keyframe-hit / keyframe-miss` |

14 个类型：`rep / set-start / set-complete / gate-fail / gate-ok / keyframe-hit / keyframe-miss /
progress / tick / hold-tick / idle / tempo / session-start / session-end`。

## 3. 算法与流程（步骤化）

**发**（`emit(type, data)` L166-L182）：

```
不在 EVENT_TYPES → return null（白名单之外一律不发）
seq += 1；t = 时钟
event = {seq, t, type, data: compactEventData(data, type, {maxChars:0})}   // 订阅者拿完整标量
ring.push({…, data: compactEventData(data, type, {maxChars: EVENT_MAX_CHARS})})  // 缓冲存紧凑副本
trim(t)                                   // 时间窗 + 容量两道限制
for 每个订阅者：matchPattern 通过 → try{ handler(event) }catch{}   // 一个抛错不影响别人
```

**订阅**（`on(pattern, handler)` L188-L193）：`on('rep', fn)` / `on('gate:*', fn)` / `on('*', fn)`，
返回取消函数；`matchPattern`（L77-L88）容忍分隔符（`gate:*` / `gate-*` / `gate*` 都匹配）。

**读**（`recent({sinceMs, limit, types})` L202-L214）：先 `trim`，再按窗口 / 类型过滤，
返回**最新在后的**紧凑副本。

**压缩**（`compactEventData` L101-L124）：数组 / 对象（关键点就在里面）一律丢，
只留标量；超 `maxChars` 就从后往前丢字段 —— 保证进 prompt 的事件一定短。

## 4. 对外接口

| 导出 | 位置 | 签名 | 说明 |
|---|---|---|---|
| `createEventBus({now, capacity})` | L133 | → bus | `emit` / `on` / `recent` / `clear` / `size` / `seq` / `now` |
| `emit(type, data)` | L166 | → event \| null | 白名单外返回 null |
| `on(pattern, handler)` | L188 | → 取消函数 | 支持通配与前缀 |
| `recent({sinceMs, limit, types})` | L202 | → 数组 | 给 prompt / 规则用 |
| `compactEventData(data, type, opts)` | L101 | → 对象 | 纯函数（测试直接用） |
| `matchPattern` / `isEventType` | L77 / L69 | → boolean | 纯函数 |
| `EVENT_TYPES` / `AGENT_EVENT_TYPES` | L45 / L66 | 常量 | 白名单（`session.js` / `llm.js` 复用） |

## 5. 与其它文件的关系

- 上游：无 import（纯 JS，注入 `now`）。
- 下游：`session.js`（`emitEvent` / `recentEvents` 都走它）、`rules.js`（订阅事件做判定）、
  `llm.js`（`normalizeRecentEvents` 读 `AGENT_EVENT_TYPES`）、`app.js`（`createEventBus()` L572）。
- 服务端不直接用它：`server/llm-tools.mjs` 只认事件**名字**（`JUDGE_EVENTS` 在 `judge.js`）。

## 6. 易错点与设计取舍

- **两个副本**（L171-L173）：订阅者拿完整标量（规则要 `target` / `remaining`），
  环形缓冲存紧凑副本（prompt 一定短）。只存一份就会「要么规则缺字段、要么 prompt 太长」。
- **白名单之外不发**（L168）：防止随手 `emit('foo')` 污染事件流；新增事件必须先加 `EVENT_TYPES`。
- **订阅者抛错被吞**（L179）：一个人坏不能影响 emit 的调用方（训练主流程）。
- `seq` 单调递增且 `clear()` **不回退**：日志里能看出「清空过但序号继续」。
- `trim` 在读写时都会跑：容量与时间窗是两道独立限制，别只留一道。

## 7. 读代码建议（先看哪几行）

1. L22-L66 常量与白名单（事件口径全在这里）；
2. L133-L182 总线闭包与 `emit`（两个副本的关键设计）；
3. L101-L124 `compactEventData`（为什么 prompt 不会爆）；
4. L202-L214 `recent`（窗口 / 类型过滤）。
