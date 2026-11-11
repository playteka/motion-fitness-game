/**
 * 服务端 LLM 适配层（P3.3 自由对话）。
 *
 *   POST /llm          {text, locale, context, history?} → {reply, actions, usage}
 *   GET  /llm/health   → {configured, provider, model}（**绝不含 key**）
 *
 * 三家 provider 都走 fetch（**不引任何 npm 依赖**）：
 *   deepseek  https://api.deepseek.com/v1/chat/completions          默认 deepseek-chat
 *   volc      火山方舟 https://ark.cn-beijing.volces.com/api/v3/chat/completions   模型由 LLM_MODEL 指定
 *   openai    https://api.openai.com/v1/chat/completions            默认 gpt-4o-mini
 *   mock      测试 / 演示用：按脚本返回，不联网
 *
 * 凭证只在本进程里读 `coach.env`：
 *   LLM_PROVIDER = deepseek|volc|openai|mock
 *   LLM_MODEL    = 模型 id（volc 必填）
 *   LLM_API_KEY  = 通用 key；没写时按 provider 回退
 *                  deepseek → DEEPSEEK_API_KEY / volc → VOLC_ARK_API_KEY / openai → OPENAI_API_KEY
 *   LLM_ENDPOINT = 可选：自建 / 网关的 OpenAI 兼容地址
 *
 * 护栏（和 /tts 一样，只是普通内存计数，不落盘）：
 *   - 每分钟最多 20 次（`LLM_RATE_LIMIT` / `LLM_RATE_WINDOW_MS`）；
 *   - 单次 max_tokens 400（`LLM_MAX_TOKENS`）；
 *   - 超时 8s（`LLM_TIMEOUT_MS`）→ 稳定错误码 llm-timeout；
 *   - 累计 token / 请求数只放内存（`/llm/health` 里能看到，重启即清零）。
 *
 * 日志只打 provider / model / tokens / tool-calls / 耗时，**绝不打 key**；
 * 上游错误正文统一过 `redactSecrets()`（万一上游把 key 回显了也只会变成 `***`）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile, redactSecrets } from './env.mjs';
import {
  EMPTY_REPLY,
  LLM_EVENT_SESSION_START,
  LLM_TOOLS,
  actionsFromToolCalls,
  buildSystemPrompt,
} from './llm-tools.mjs';
// 长期记忆（服务端 MD）：`/llm` 里工具要真的把 prefs / facts 写进去，
// 并且把「用户记住了什么」带回前端 —— 白名单 / 路径安全全在 memory-store 里。
import {
  DEFAULT_USER_ID,
  MemoryError,
  normalizeUserId,
} from './memory-store.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');

/** 路由 */
export const LLM_PATH = '/llm';
export const LLM_HEALTH_PATH = '/llm/health';

/** 护栏参数（README 里写的就是这几个数） */
export const LLM_TIMEOUT_MS = 8000;
export const LLM_MAX_TOKENS = 400;
export const LLM_RATE_LIMIT = 20;
export const LLM_RATE_WINDOW_MS = 60 * 1000;
/** 请求体上限（一句话 + 一小段 state，64KB 已经非常宽松） */
export const LLM_MAX_BODY = 64 * 1024;
/** 单句输入上限（再长就不是语音识别了，直接拒，省钱也防滥用） */
export const LLM_MAX_TEXT = 500;
/** 客户端可以带最近 6 轮对话（服务端再夹一次，别信客户端） */
export const LLM_MAX_HISTORY_TURNS = 6;
/** 服务端给模型的 system 提示里，state 最多占多少字符（= 客户端 `AGENT_CONTEXT_MAX_CHARS`） */
export const LLM_MAX_CONTEXT_CHARS = 6000;
/**
 * 会话开始事件（`POST /llm {event:'session-start'}`）：唯一字符串定义在 `llm-tools.mjs`
 * （system prompt 的事件规则也要用它），这里 re-export 给路由 / 测试 / 前端对照。
 */
export { LLM_EVENT_SESSION_START };

/** provider 元信息：默认地址 / 默认模型 / key 回退变量 */
export const LLM_PROVIDER_SPECS = Object.freeze({
  deepseek: Object.freeze({
    id: 'deepseek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    keyEnv: 'DEEPSEEK_API_KEY',
  }),
  volc: Object.freeze({
    id: 'volc',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    model: '',
    keyEnv: 'VOLC_ARK_API_KEY',
  }),
  openai: Object.freeze({
    id: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    keyEnv: 'OPENAI_API_KEY',
  }),
  mock: Object.freeze({
    id: 'mock',
    endpoint: '',
    model: 'mock',
    keyEnv: '',
  }),
});

export const LLM_PROVIDERS = Object.freeze(Object.keys(LLM_PROVIDER_SPECS));

/** provider 名归一化：大小写 / 空格 / 常见别名（ark、豆包、doubao 都算 volc） */
export function normalizeProviderName(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'ark' || raw === 'doubao' || raw === 'volcengine' || raw === '豆包') return 'volc';
  if (raw === 'deepseek-chat' || raw === 'ds') return 'deepseek';
  return LLM_PROVIDERS.includes(raw) ? raw : '';
}

/** 某个 provider 的 key：LLM_API_KEY 优先，其次各家自己的环境变量名 */
export function providerApiKey(env, provider) {
  const merged = env || {};
  const own = String(merged.LLM_API_KEY || '').trim();
  if (own) return own;
  const spec = LLM_PROVIDER_SPECS[provider];
  if (!spec || !spec.keyEnv) return '';
  return String(merged[spec.keyEnv] || '').trim();
}

/** 没写 LLM_PROVIDER 时，按「哪家配了 key」猜一个（猜不出来落 deepseek，缺 key 就 503） */
export function inferProvider(env) {
  const merged = env || {};
  for (const [id, spec] of Object.entries(LLM_PROVIDER_SPECS)) {
    if (!spec.keyEnv) continue;
    if (String(merged[spec.keyEnv] || '').trim()) return id;
  }
  return 'deepseek';
}

/**
 * 从 `coach.env` 读 LLM 配置。
 *
 * @param {object} [opts]
 * @param {string} [opts.envPath]
 * @param {object} [opts.env] 进程环境（测试注入）
 */
export function loadLlmConfig({ envPath = '', env = process.env } = {}) {
  const file = envPath || String(env.COACH_ENV || '') || path.join(ROOT, 'coach.env');
  const loaded = loadEnvFile(file);
  const merged = { ...env, ...(loaded.ok ? loaded.env : {}) };
  const provider = normalizeProviderName(merged.LLM_PROVIDER) || inferProvider(merged);
  const spec = LLM_PROVIDER_SPECS[provider] || LLM_PROVIDER_SPECS.deepseek;
  const apiKey = providerApiKey(merged, provider);
  const model = String(merged.LLM_MODEL || '').trim() || spec.model;
  const endpoint = String(merged.LLM_ENDPOINT || '').trim() || spec.endpoint;
  const missing = [];
  if (provider !== 'mock') {
    if (!apiKey) missing.push('LLM_API_KEY');
    if (!model) missing.push('LLM_MODEL');
  }
  return {
    config: {
      provider,
      model,
      apiKey,
      endpoint,
      missing,
      configured: missing.length === 0,
    },
    envPath: file,
    loaded,
  };
}

/** 稳定错误码（前端只看 code，不看上游原文） */
export function llmError(code, detail = '') {
  const err = new Error(detail || code);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

/** 上游 HTTP 状态 → 稳定 code */
export function llmHttpCode(status) {
  const n = Number(status) || 0;
  if (!n) return 'llm-http-error';
  return `llm-http-${n}`;
}

/**
 * 每次 /llm 请求的护栏（限流 + 累计 token）。
 * `now` 可注入，测试不必等一分钟。
 */
export function createLlmGuard({
  limit = LLM_RATE_LIMIT,
  windowMs = LLM_RATE_WINDOW_MS,
  now = () => Date.now(),
} = {}) {
  const perMinute = Math.max(1, Math.floor(Number(limit)) || LLM_RATE_LIMIT);
  const windowMsValue = Math.max(1, Number(windowMs) || LLM_RATE_WINDOW_MS);
  let stamps = [];
  let requests = 0;
  let prompt = 0;
  let completion = 0;
  let total = 0;
  const trim = () => {
    const at = now();
    stamps = stamps.filter((t) => at - t < windowMsValue);
  };
  return {
    limit: perMinute,
    windowMs: windowMsValue,
    /** 记一次请求；窗口内已经到上限就返回 false（这次不执行） */
    hit() {
      trim();
      if (stamps.length >= perMinute) return false;
      stamps.push(now());
      requests += 1;
      return true;
    },
    remaining() {
      trim();
      return Math.max(0, perMinute - stamps.length);
    },
    /** 记一次用量（0 也记，方便 health 里看出请求数） */
    addUsage(usage) {
      const u = usage && typeof usage === 'object' ? usage : {};
      const p = Math.max(0, Number(u.prompt) || 0);
      const c = Math.max(0, Number(u.completion) || 0);
      const t = Math.max(0, Number(u.total) || (p + c));
      prompt += p;
      completion += c;
      total += t;
      return { prompt: p, completion: c, total: t };
    },
    usage() {
      return { requests, tokens: { prompt, completion, total } };
    },
    reset() {
      stamps = [];
      requests = 0;
      prompt = 0;
      completion = 0;
      total = 0;
    },
  };
}

/**
 * 构造真正的 HTTP provider（三家都叫 OpenAI 兼容接口，差别只有地址 / 模型 / key）。
 *
 * @param {object} opts
 * @param {object} opts.config    `loadLlmConfig().config`
 * @param {Function} [opts.fetchImpl] 测试注入（不联网）
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxTokens]
 * @param {Function} [opts.logger] 只接收脱敏字段
 */
export function createLlmProvider({
  config = {},
  fetchImpl = null,
  timeoutMs = LLM_TIMEOUT_MS,
  maxTokens = LLM_MAX_TOKENS,
  logger = null,
} = {}) {
  const cfg = config || {};
  const spec = LLM_PROVIDER_SPECS[cfg.provider] || null;
  const endpoint = String(cfg.endpoint || (spec && spec.endpoint) || '');
  const model = String(cfg.model || (spec && spec.model) || '');
  const apiKey = String(cfg.apiKey || '');
  const call = typeof fetchImpl === 'function'
    ? fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const timeout = Math.max(1, Number(timeoutMs) || LLM_TIMEOUT_MS);
  const limit = Math.max(1, Number(maxTokens) || LLM_MAX_TOKENS);

  const log = (fields) => {
    if (typeof logger !== 'function') return;
    try { logger(fields); } catch { /* 日志失败不影响请求 */ }
  };

  return {
    kind: 'http',
    get provider() { return cfg.provider || ''; },
    get model() { return model; },
    get endpoint() { return endpoint; },
    get configured() { return cfg.configured !== false && !!apiKey && !!endpoint && !!model; },
    get maxTokens() { return limit; },
    get timeoutMs() { return timeout; },

    /**
     * 调一次 chat/completions。
     * @returns {Promise<{text:string, toolCalls:Array<{name:string,args:object}>,
     *                    usage:{prompt:number,completion:number,total:number},
     *                    provider:string, model:string, ms:number}>}
     */
    async chat({ messages = [], tools = LLM_TOOLS, signal = null } = {}) {
      if (!cfg.configured || !apiKey || !endpoint || !model) throw llmError('llm-config');
      if (typeof call !== 'function') throw llmError('llm-network', 'fetch unavailable');
      const started = Date.now();
      const controller = new AbortController();
      let timedOut = false;
      let timer = null;
      // **双保险**：一边 abort（真 fetch 会立刻断），一边用 Promise.race 兜住
      // 「ignoring signal 的 fetch / 一直不返回的网关」——否则超时根本不会触发。
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          try { controller.abort(); } catch { /* ignore */ }
          reject(llmError('llm-timeout', `timeout after ${timeout}ms`));
        }, timeout);
      });
      if (signal) {
        if (signal.aborted) {
          try { controller.abort(); } catch { /* ignore */ }
        } else if (typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', () => {
            try { controller.abort(); } catch { /* ignore */ }
          }, { once: true });
        }
      }
      const payload = {
        model,
        messages: Array.isArray(messages) ? messages : [],
        max_tokens: limit,
        tools: Array.isArray(tools) ? tools : LLM_TOOLS,
        tool_choice: 'auto',
        stream: false,
      };
      try {
        const res = await Promise.race([call(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }), timeoutPromise]);
        const status = Number(res && res.status) || 0;
        if (!res || res.ok === false) {
          let detail = '';
          try { detail = await res.text(); } catch { /* ignore */ }
          const code = llmHttpCode(status);
          log({ provider: cfg.provider, model, status, ms: Date.now() - started, code });
          throw llmError(code, redactSecrets(detail, [apiKey]).slice(0, 200));
        }
        let data = null;
        try {
          data = await res.json();
        } catch {
          log({ provider: cfg.provider, model, ms: Date.now() - started, code: 'llm-bad-json' });
          throw llmError('llm-bad-json', 'response is not json');
        }
        const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
        const message = (choice && choice.message) || {};
        const text = typeof message.content === 'string' ? message.content.trim() : '';
        const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        const toolCalls = rawCalls.map((item) => {
          const fn = (item && item.function) || {};
          let args = {};
          const raw = fn.arguments;
          if (raw && typeof raw === 'object') args = raw;
          else if (typeof raw === 'string' && raw.trim()) {
            try { args = JSON.parse(raw); } catch { args = {}; }
          }
          return { name: String(fn.name || ''), args: args && typeof args === 'object' ? args : {} };
        }).filter((c) => c.name);
        const u = (data && data.usage) || {};
        const usage = {
          prompt: Math.max(0, Number(u.prompt_tokens) || 0),
          completion: Math.max(0, Number(u.completion_tokens) || 0),
          total: Math.max(0, Number(u.total_tokens) || 0),
        };
        const ms = Date.now() - started;
        log({
          provider: cfg.provider,
          model,
          ms,
          prompt: usage.prompt,
          completion: usage.completion,
          tools: toolCalls.length,
        });
        return { text, toolCalls, usage, provider: cfg.provider, model, ms };
      } catch (err) {
        if (timedOut) {
          log({ provider: cfg.provider, model, ms: Date.now() - started, code: 'llm-timeout' });
          throw llmError('llm-timeout', `timeout after ${timeout}ms`);
        }
        if (err && err.code) throw err;
        log({ provider: cfg.provider, model, ms: Date.now() - started, code: 'llm-network' });
        throw llmError('llm-network', redactSecrets(String((err && err.message) || err), [apiKey]).slice(0, 200));
      } finally {
        try { clearTimeout(timer); } catch { /* ignore */ }
      }
    },
  };
}

/**
 * mock provider：**测试 / 演示用**，按脚本返回（不联网、不需要 key）。
 *
 * 脚本每一项可以是对象或函数：
 *   { text, toolCalls, usage, delayMs, error }
 *   ({ messages, tools }) => 同样的对象
 * 脚本有多项时**按顺序用完为止**，用完了就一直用最后一项（方便重复断言）。
 */
export function createMockLlmProvider({ script = [], logger = null } = {}) {
  const queue = Array.isArray(script) ? script.slice() : [script];
  const calls = [];
  return {
    kind: 'mock',
    provider: 'mock',
    model: 'mock',
    endpoint: '(mock)',
    configured: true,
    calls,
    async chat({ messages = [], tools = LLM_TOOLS } = {}) {
      calls.push({ messages, tools });
      const item = queue.length > 1 ? queue.shift() : queue[0];
      const step = typeof item === 'function' ? item({ messages, tools }) : item;
      if (step && step.delayMs) await new Promise((r) => setTimeout(r, Number(step.delayMs) || 0));
      if (step && step.error) {
        throw llmError(String(step.error), 'mock error');
      }
      const out = {
        text: String((step && step.text) || ''),
        toolCalls: Array.isArray(step && step.toolCalls) ? step.toolCalls : [],
        usage: (step && step.usage) || { prompt: 0, completion: 0, total: 0 },
        provider: 'mock',
        model: 'mock',
        ms: 0,
      };
      if (typeof logger === 'function') {
        try { logger({ provider: 'mock', model: 'mock', ms: 0, tools: out.toolCalls.length }); } catch { /* ignore */ }
      }
      return out;
    },
  };
}

/** 收集请求 body（和 /tts 同一套写法） */
function readJsonBody(req, { maxBytes = LLM_MAX_BODY } = {}) {
  return new Promise((resolve) => {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        tooBig = true;
        try { req.destroy(); } catch { /* ignore */ }
      }
    });
    req.on('end', () => {
      if (tooBig) { resolve({ ok: false, code: 'too-big' }); return; }
      if (!body) { resolve({ ok: false, code: 'empty-body' }); return; }
      try {
        const data = JSON.parse(body);
        if (!data || typeof data !== 'object') { resolve({ ok: false, code: 'bad-body' }); return; }
        resolve({ ok: true, data });
      } catch {
        resolve({ ok: false, code: 'bad-json' });
      }
    });
    req.on('error', () => resolve({ ok: false, code: 'read-error' }));
  });
}

function sendJson(res, status, obj) {
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(obj));
  } catch { /* 响应已断 */ }
}

/**
 * 客户端带来的历史 → OpenAI 风格的 messages（只留最近 `maxTurns` 轮，服务端再夹一次）。
 * 客户端格式：`[{role:'user'|'assistant', content:string}]`（也接受 `text`）。
 */
export function historyMessages(history, { maxTurns = LLM_MAX_HISTORY_TURNS } = {}) {
  const list = Array.isArray(history) ? history : [];
  const turns = Math.max(0, Math.floor(Number(maxTurns) || 0));
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role === 'assistant' ? 'assistant' : (item.role === 'user' ? 'user' : '');
    if (!role) continue;
    const content = String(item.content == null ? (item.text == null ? '' : item.text) : item.content).trim();
    if (!content) continue;
    out.push({ role, content: content.slice(0, LLM_MAX_TEXT) });
  }
  // 一轮 = user + assistant 两条；只留最后 maxTurns 轮
  return out.slice(Math.max(0, out.length - turns * 2));
}

/**
 * `event: session-start` 的 user 消息（中英各一套）。
 *
 * 它不是「用户说的话」，而是一条**系统事件描述**：模型据此知道用户刚进入训练、
 * 现在练什么、目标多少，该由教练主动开口。动作 / 目标 / 单位全部来自客户端算好的 context
 * （`session.name / target / kind`），服务端不猜、不补数字。
 *
 * @param {{locale?:string, context?:object}} [opts]
 * @returns {string} 直接作为 messages 里那条 user 的内容
 */
export function sessionStartEventMessage({ locale = 'zh', context = null } = {}) {
  const lang = locale === 'en' ? 'en' : 'zh';
  const session = context && typeof context === 'object' && context.session && typeof context.session === 'object'
    ? context.session
    : {};
  const name = String(session.name || session.exerciseId || '').trim().slice(0, 40);
  const target = Math.max(0, Math.round(Number(session.target) || 0));
  const hold = session.kind === 'hold';
  if (lang === 'en') {
    const ex = name || 'this exercise';
    const targetText = target > 0 ? `, target ${target} ${hold ? 'sec' : 'reps'}` : '';
    return `[Event] The user has just entered the workout: exercise=${ex}${targetText}. `
      + 'This is the first message of this session. Greet the user proactively.';
  }
  const ex = name || '这个动作';
  const targetText = target > 0 ? `，目标=${target}${hold ? '秒' : '次'}` : '';
  return `[事件] 用户刚刚进入训练：动作=${ex}${targetText}，这是本次训练的第一句对话。请主动打个招呼。`;
}

/** 组一次请求的 messages（system + 最近历史 + 这一句 / 一条 session-start 事件） */
export function buildLlmMessages({
  text = '',
  locale = 'zh',
  context = null,
  history = [],
  event = '',
  maxTurns = LLM_MAX_HISTORY_TURNS,
  maxContextChars = LLM_MAX_CONTEXT_CHARS,
} = {}) {
  const lang = locale === 'en' ? 'en' : 'zh';
  const userContent = event === LLM_EVENT_SESSION_START
    ? sessionStartEventMessage({ locale: lang, context })
    : String(text).slice(0, LLM_MAX_TEXT);
  return [
    { role: 'system', content: buildSystemPrompt({ locale: lang, context, maxContextChars, event }) },
    ...historyMessages(history, { maxTurns }),
    { role: 'user', content: userContent },
  ];
}

const noKeyLog = (logger, message, extra) => {
  if (typeof logger !== 'function') return;
  try { logger(message, extra); } catch { /* ignore */ }
};

/**
 * 执行工具请求里的**记忆操作**（服务端副作用，不产生 client action）。
 *
 * 每个操作单独 try：一条写失败（非法值 / 超 64KB）不影响这一轮的回答，
 * 失败原因只回稳定 code（`evidence-required` / `bad-value` / `too-big` …），不含用户文本。
 *
 * @param {{updateMemory:Function,forgetMemory:Function}} store
 * @param {string} userId
 * @param {Array<{op:string,field:string,value?:any,evidence?:string}>} ops
 * @returns {Array<{ok:boolean,op:string,field:string,reason?:string}>}
 */
export function applyMemoryOps(store, userId, ops = []) {
  const results = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    try {
      if (op.op === 'remember') {
        store.updateMemory(userId, { prefs: { [op.field]: op.value } });
      } else if (op.op === 'remember-fact') {
        store.updateMemory(userId, { facts: { [op.field]: { value: op.value, evidence: op.evidence } } });
      } else if (op.op === 'forget') {
        store.forgetMemory(userId, { field: op.field });
      } else {
        throw new MemoryError('unknown-op', { field: op.field });
      }
      results.push({ ok: true, op: op.op, field: op.field });
    } catch (err) {
      results.push({
        ok: false,
        op: op.op,
        field: op.field,
        reason: (err && (err.reason || err.code)) || 'memory-error',
      });
    }
  }
  return results;
}

/**
 * `/llm` + `/llm/health` 的路由（返回 true = 这个请求已经被处理）。
 *
 * 抽成工厂函数是为了测试：`http.createServer(createLlmRoutes({ provider: fake }))`
 * 就能在不联网、不用真 key 的情况下跑完「正常返回 actions / 超时 503 / 没配置 503 /
 * 每分钟 20 次 / health 不带 key」这些用例。
 *
 * @param {object} opts
 * @param {object} opts.provider  `createLlmProvider()` / `createMockLlmProvider()` / 手写假 provider
 * @param {object} [opts.config]  `loadLlmConfig().config`（缺省从 provider 里读）
 * @param {object} [opts.guard]   `createLlmGuard()`
 * @param {Function} [opts.logger] 只接收脱敏字段（provider/model/tokens/tools/ms）
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.maxHistoryTurns]
 */
export function createLlmRoutes({
  provider,
  config = null,
  guard = null,
  logger = null,
  maxTokens = LLM_MAX_TOKENS,
  maxHistoryTurns = LLM_MAX_HISTORY_TURNS,
  /**
   * 长期记忆的存储（`memory-store.mjs`）。不传 → 记忆工具一律拒绝（`memory-unavailable`），
   * 其余对话照常 —— 测试 / 没接记忆的部署不受影响。
   */
  memoryStore = null,
} = {}) {
  if (!provider || typeof provider.chat !== 'function') {
    throw new TypeError('createLlmRoutes requires a provider with chat()');
  }
  const limitGuard = guard || createLlmGuard();
  const cfg = config || {
    configured: provider.configured !== false,
    provider: String(provider.provider || 'mock'),
    model: String(provider.model || ''),
  };

  return function handleLlmRoute(req, res) {
    const urlPath = String((req && req.url) || '').split('?')[0];

    if (urlPath === LLM_HEALTH_PATH) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return true;
      }
      // 只回「配没配 / 谁 / 哪个模型 / 护栏数值 / 用量」——**没有任何 key**
      sendJson(res, 200, {
        ok: true,
        configured: !!cfg.configured,
        provider: cfg.provider,
        model: cfg.model,
        limits: { perMinute: limitGuard.limit, maxTokens },
        usage: limitGuard.usage(),
      });
      return true;
    }

    if (urlPath !== LLM_PATH) return false;
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      return true;
    }

    readJsonBody(req).then(async (parsed) => {
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.code });
        return;
      }
      // ① 没配置 key：直接 503，客户端据此只用命令快车道（不花钱、不报错）
      if (!cfg.configured) {
        noKeyLog(logger, 'llm skipped', { code: 'not-configured', provider: cfg.provider });
        sendJson(res, 503, { ok: false, error: 'not-configured', configured: false });
        return;
      }
      // ② 限流：每分钟最多 20 次
      if (!limitGuard.hit()) {
        sendJson(res, 429, { ok: false, error: 'rate-limit', limit: limitGuard.limit });
        return;
      }
      const data = parsed.data;
      const text = String(data.text == null ? '' : data.text).trim();
      /**
       * 可选的 `event`：目前只认 `session-start`（进训练后主动问候）。
       * 它允许 `text` 为空 —— 这条 user 消息由服务端按 context 生成；
       * 其它任何值都当普通对话，仍然要求有 text（旧客户端行为不变）。
       */
      const event = data.event === LLM_EVENT_SESSION_START ? LLM_EVENT_SESSION_START : '';
      if (!text && !event) {
        sendJson(res, 400, { ok: false, error: 'empty-text' });
        return;
      }
      if (text.length > LLM_MAX_TEXT) {
        sendJson(res, 400, { ok: false, error: 'text-too-long' });
        return;
      }
      const locale = data.locale === 'en' ? 'en' : 'zh';
      /**
       * 长期记忆属于哪个用户：`user` 由前端 localStorage 生成（默认 `default`）。
       * 这里**先校验**再往下走 —— 非法 id 直接 400，绝不进 memory-store。
       */
      let userId = DEFAULT_USER_ID;
      try {
        userId = normalizeUserId(data.user == null || data.user === '' ? DEFAULT_USER_ID : data.user);
      } catch {
        sendJson(res, 400, { ok: false, error: 'bad-user' });
        return;
      }
      /**
       * 服务端自己也读一遍记忆，合并进 context：前端那次 `GET /memory` 失败（服务器刚起 / 断网）
       * 时模型仍然知道用户之前记下的偏好与事实。客户端传来的 memory 优先（它可能刚改过）。
       */
      let context = data.context && typeof data.context === 'object' ? data.context : null;
      if (memoryStore) {
        try {
          const mem = memoryStore.readMemory(userId);
          const hasMemory = Object.keys(mem.prefs || {}).length > 0 || Object.keys(mem.facts || {}).length > 0;
          if (hasMemory) {
            context = {
              ...(context || {}),
              memory: { prefs: mem.prefs, facts: mem.facts },
            };
          }
        } catch { /* 记忆读不出来不该挡住对话 */ }
      }
      /**
       * 首次见面只自报一次：这里**先看**这轮开始时记没记过。
       * 没记过 → 本轮 system 里会带「这是首次对话」；等模型正常回完之后，
       * 由服务端把 `prefs.introSeen` 置 true（**不依赖模型的 remember**，模型忘了也不会复读）。
       */
      const introSeen = !!(context && context.memory && context.memory.prefs
        && context.memory.prefs.introSeen === true);
      const messages = buildLlmMessages({
        text,
        locale,
        context,
        history: data.history,
        event,
        maxTurns: maxHistoryTurns,
      });
      const started = Date.now();
      try {
        const out = await provider.chat({ messages, tools: LLM_TOOLS });
        const { actions, refusals, prompts, memoryOps } = actionsFromToolCalls(
          out && out.toolCalls,
          { locale },
        );
        /** 记忆工具是**服务端副作用**：写进 `server/memory/<userId>.md`，没有 client action */
        let memoryResults = [];
        if (memoryOps.length) {
          if (memoryStore) {
            memoryResults = applyMemoryOps(memoryStore, userId, memoryOps);
          } else {
            memoryResults = memoryOps.map((op) => ({
              ok: false, op: op.op, field: op.field, reason: 'memory-unavailable',
            }));
          }
        }
        /**
         * 首次成功对话后由服务端标记 `prefs.introSeen = true`：下一轮起 system prompt 不再加
         * 「先说一次自报家门」。标记失败（磁盘满 / 非法值）**不影响这一句回答**。
         */
        let introMarked = false;
        if (memoryStore && !introSeen) {
          try {
            memoryStore.updateMemory(userId, { prefs: { introSeen: true } });
            introMarked = true;
          } catch { /* 标记失败就不标，下一轮还会提醒一次 */ }
        }
        const usage = limitGuard.addUsage(out && out.usage);
        let reply = String((out && out.text) || '').trim();
        // 模型只调了工具没说话 → 让前端的会话层用**命令表自己的短确认**（比编一句通用话准确）；
        // prompts 现在恒为空（没有工具需要二次确认，`exit_workout` 也直接执行）；什么都没给 → 一句「没听懂」。
        if (!reply && prompts.length) reply = prompts[0];
        // 只写了记忆、没说话：给一句短确认（记忆工具没有 client action 可借）
        if (!reply && !actions.length && memoryResults.some((r) => r.ok)) {
          reply = locale === 'en' ? 'Got it, I will remember that.' : '好，我记下了。';
        }
        if (!reply && !actions.length) reply = EMPTY_REPLY[locale];
        if (typeof logger === 'function') {
          try {
            logger('llm ok', {
              provider: cfg.provider,
              model: cfg.model,
              ms: Date.now() - started,
              prompt: usage.prompt,
              completion: usage.completion,
              actions: actions.length,
              refused: refusals.length,
              // 只记数量，不记字段值（记忆里是用户个人信息）
              memory: memoryResults.length,
              memoryFailed: memoryResults.filter((r) => !r.ok).length,
              intro: introMarked ? 1 : 0,
              event: event || '',
            });
          } catch { /* ignore */ }
        }
        /** 写完记忆回一份最新的快照，前端「教练记得什么」立刻能对上 */
        let memory = null;
        if (memoryStore && (memoryOps.length || introMarked)) {
          try { memory = memoryStore.readMemory(userId); } catch { memory = null; }
        }
        sendJson(res, 200, {
          ok: true,
          reply,
          actions,
          refusals,
          memoryOps: memoryResults,
          memory,
          usage,
          provider: cfg.provider,
          model: cfg.model,
        });
      } catch (err) {
        const code = (err && err.code) || 'llm-error';
        noKeyLog(logger, 'llm failed', {
          provider: cfg.provider, model: cfg.model, code, ms: Date.now() - started,
        });
        // 超时 / 401 / 坏 JSON / 网络错误 → 一律 503（客户端回退罐头回复，不崩）
        sendJson(res, 503, { ok: false, error: code });
      }
    }).catch(() => {
      sendJson(res, 503, { ok: false, error: 'llm-error' });
    });
    return true;
  };
}

export default {
  LLM_PATH,
  LLM_HEALTH_PATH,
  LLM_TIMEOUT_MS,
  LLM_MAX_TOKENS,
  LLM_RATE_LIMIT,
  LLM_RATE_WINDOW_MS,
  LLM_MAX_HISTORY_TURNS,
  LLM_EVENT_SESSION_START,
  LLM_PROVIDERS,
  LLM_PROVIDER_SPECS,
  normalizeProviderName,
  providerApiKey,
  inferProvider,
  loadLlmConfig,
  llmError,
  llmHttpCode,
  createLlmGuard,
  createLlmProvider,
  createMockLlmProvider,
  createLlmRoutes,
  buildLlmMessages,
  sessionStartEventMessage,
  historyMessages,
  applyMemoryOps,
};
