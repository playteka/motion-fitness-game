/**
 * 火山「语音合成 2.0」的服务端代理 + 内存缓存（P3.6）。
 *
 * 协议**照抄 `server/tts-probe.mjs` 里已经实测可用的那一份**，不自己改：
 *   POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 *   headers: X-Api-App-Id / X-Api-Key / X-Api-Resource-Id / X-Api-Request-Id
 *   body   : { user: { uid }, req_params: { text, speaker, audio_params } }
 * 返回 `audio/mpeg` 二进制。
 *
 * 用户要求：
 *   - `POST /tts`（body `{"text":"…","rate":1.0}`）→ 音频 / 502；
 *   - 内存缓存 key = `voice|rate|text`，上限 200 条 / 20MB，LRU —— 同一句只合成一次；
 *   - 失败 / 超时（3s）→ 502 + 简短错误 JSON（回退系统 TTS 是客户端的事）；
 *   - **绝不打印 / 返回密钥**：日志只有 `chars / cache / status`；
 *   - `GET /tts/health` → `{ configured: true|false }`（不泄露值）。
 *
 * 安全约定（AGENTS.md）：凭证只在本进程内存里，`config` 不对外暴露；
 * 对外只有 `configured` / `missing`（字段名）与健康检查。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TTS_PATH = '/tts';
export const TTS_HEALTH_PATH = '/tts/health';

export const TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
export const TTS_RESOURCE = 'volc.seedtts.default';
export const TTS_TIMEOUT_MS = 3000;
export const TTS_CACHE_MAX_ENTRIES = 200;
export const TTS_CACHE_MAX_BYTES = 20 * 1024 * 1024;
export const TTS_MAX_TEXT = 300;
export const TTS_RATE_MIN = 0.5;
export const TTS_RATE_MAX = 2;

/** 规范化语速（0.5~2，保留两位） */
export function normalizeRate(rate) {
  const v = Number(rate);
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, Math.round(v * 100) / 100));
}

/** 正文裁剪（去空白 + 上限 300 字；空串返回 ''） */
export function ttsBody(text) {
  const body = String(text == null ? '' : text).trim();
  return body.length > TTS_MAX_TEXT ? body.slice(0, TTS_MAX_TEXT) : body;
}

/**
 * 从 `coach.env` 读 TTS 配置。
 *
 * 键名优先级（与 ASR 的写法一致，旧名字兼容）：
 *   VOLC_TTS_APP_ID / VOLC_APP_ID
 *   VOLC_TTS_API_KEY / VOLC_API_KEY
 *   VOLC_TTS_VOICE（必填；没有音色就不合成）
 *   VOLC_TTS_RESOURCE（默认 volc.seedtts.default）
 *   VOLC_TTS_ENDPOINT（默认 v3 unidirectional）
 *
 * @param {object} [opts]
 * @param {string} [opts.envPath]
 * @param {object} [opts.env] 进程环境（测试注入）
 */
export function loadTtsConfig({ envPath = '', env = process.env } = {}) {
  const file = envPath || String(env.COACH_ENV || '') || path.join(ROOT, 'coach.env');
  const loaded = loadEnvFile(file);
  const merged = { ...env, ...(loaded.ok ? loaded.env : {}) };
  const appId = String(merged.VOLC_TTS_APP_ID || merged.VOLC_APP_ID || '').trim();
  const apiKey = String(merged.VOLC_TTS_API_KEY || merged.VOLC_API_KEY || '').trim();
  const voice = String(merged.VOLC_TTS_VOICE || '').trim();
  const resource = String(merged.VOLC_TTS_RESOURCE || '').trim() || TTS_RESOURCE;
  const endpoint = String(merged.VOLC_TTS_ENDPOINT || '').trim() || TTS_ENDPOINT;
  const missing = [];
  if (!appId) missing.push('VOLC_TTS_APP_ID');
  if (!apiKey) missing.push('VOLC_TTS_API_KEY');
  if (!voice) missing.push('VOLC_TTS_VOICE');
  return {
    config: {
      appId,
      apiKey,
      voice,
      resource,
      endpoint,
      missing,
      configured: missing.length === 0,
    },
    envPath: file,
    loaded,
  };
}

/**
 * LRU 内存缓存（key → Buffer）。上限 200 条 / 20MB：
 * 命中后挪到 Map 末尾；超出任一上限就从最老的开始删。
 */
export function createTtsCache({
  maxEntries = TTS_CACHE_MAX_ENTRIES,
  maxBytes = TTS_CACHE_MAX_BYTES,
} = {}) {
  const entries = new Map();   // key → Buffer（Map 的插入顺序 = LRU 顺序）
  let bytes = 0;
  const entryLimit = Math.max(1, Math.floor(Number(maxEntries)) || TTS_CACHE_MAX_ENTRIES);
  const byteLimit = Math.max(1, Math.floor(Number(maxBytes)) || TTS_CACHE_MAX_BYTES);

  function trim() {
    while ((entries.size > entryLimit || bytes > byteLimit) && entries.size > 0) {
      const [key, buf] = entries.entries().next().value;
      entries.delete(key);
      bytes -= buf.length;
    }
  }

  return {
    get size() { return entries.size; },
    get bytes() { return bytes; },
    get maxEntries() { return entryLimit; },
    get maxBytes() { return byteLimit; },
    /** 命中就返回 Buffer，并把它挪到最新 */
    get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },
    has(key) { return entries.has(key); },
    set(key, buf) {
      const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
      if (!key || !data.length) return false;
      // 单条就超过总容量：不缓存（否则会把整个缓存清空还存不下）
      if (data.length > byteLimit) return false;
      const prev = entries.get(key);
      if (prev) {
        entries.delete(key);
        bytes -= prev.length;
      }
      entries.set(key, data);
      bytes += data.length;
      trim();
      return entries.has(key);
    },
    clear() { entries.clear(); bytes = 0; },
    keys() { return [...entries.keys()]; },
  };
}

/** 缓存 key：`voice|rate|text`（rate 固定两位小数，1 / 1.0 / 1.00 命中同一份） */
export function ttsCacheKey({ voice = '', rate = 1, text = '' } = {}) {
  return `${String(voice)}|${normalizeRate(rate).toFixed(2)}|${String(text)}`;
}

/** 上游错误 → 稳定 code（不回传上游原文，避免把凭证带进日志 / JSON） */
function upstreamCode(err) {
  if (!err) return 'upstream';
  if (err.code === 'timeout' || err.name === 'AbortError' || err.name === 'TimeoutError') return 'timeout';
  const status = Number(err.status) || 0;
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'upstream';
  return err.code === 'network' ? 'network' : 'upstream';
}

/**
 * 创建火山 TTS 服务。
 *
 * @param {object} [opts]
 * @param {object} [opts.config]      `loadTtsConfig().config`（含 key，只在内部用）
 * @param {Function} [opts.fetchImpl] 注入 fetch（测试用假 fetch，不联网）
 * @param {object} [opts.cache]       注入缓存（默认 200 条 / 20MB）
 * @param {number} [opts.timeoutMs]   合成超时（默认 3000）
 * @param {Function} [opts.logger]    只接收 `{chars, cache, status}`（默认不打日志）
 * @param {Function} [opts.now]
 */
export function createVolcTts({
  config = null,
  fetchImpl = null,
  cache = null,
  timeoutMs = TTS_TIMEOUT_MS,
  logger = null,
  now = () => Date.now(),
} = {}) {
  const cfg = config || loadTtsConfig().config;
  const store = cache || createTtsCache();
  const limitMs = Math.max(1, Number(timeoutMs) || TTS_TIMEOUT_MS);
  const call = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  let requestSeq = 0;

  function log(fields) {
    if (typeof logger !== 'function') return;
    try { logger(fields); } catch { /* 日志失败不影响合成 */ }
  }

  /** 对外只给安全字段（绝不含 appId / apiKey） */
  function health() {
    return {
      ok: true,
      service: 'motion-fitness volc tts (in preview-server)',
      configured: !!cfg.configured,
      missing: [...(cfg.missing || [])],
    };
  }

  /**
   * 合成一句（命中缓存直接返回）。
   * @returns {Promise<{ok:boolean, buffer?:Buffer, bytes?:number, cached:boolean, code?:string, status?:number}>}
   */
  async function synthesize(text, rate = 1) {
    const body = ttsBody(text);
    const rateValue = normalizeRate(rate);
    if (!body) return { ok: false, code: 'empty', status: 400, cached: false };
    if (!cfg.configured) {
      log({ chars: 0, cache: 'skip', status: 502 });
      return { ok: false, code: 'not-configured', status: 502, cached: false };
    }
    if (typeof call !== 'function') {
      log({ chars: body.length, cache: 'skip', status: 502 });
      return { ok: false, code: 'no-fetch', status: 502, cached: false };
    }

    const key = ttsCacheKey({ voice: cfg.voice, rate: rateValue, text: body });
    const hit = store.get(key);
    if (hit) {
      log({ chars: body.length, cache: 'hit', status: 200 });
      return { ok: true, buffer: hit, bytes: hit.length, cached: true, status: 200 };
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    let timedOut = false;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        try { controller?.abort?.(); } catch { /* ignore */ }
        reject(Object.assign(new Error('tts timeout'), { code: 'timeout' }));
      }, limitMs);
      if (timer && typeof timer.unref === 'function') {
        try { timer.unref(); } catch { /* ignore */ }
      }
    });

    // 协议保持与 server/tts-probe.mjs 一致；只有语速 ≠ 1 时才多带一个 speech_rate
    const reqParams = {
      text: body,
      speaker: cfg.voice,
      audio_params: { format: 'mp3', sample_rate: 24000 },
    };
    if (Math.abs(rateValue - 1) > 0.001) {
      reqParams.audio_params.speech_rate = Math.round((rateValue - 1) * 100);
    }
    const payload = {
      user: { uid: 'mfg-preview' },
      req_params: reqParams,
    };
    requestSeq += 1;
    const requestId = `mfg-${now()}-${requestSeq}`;

    try {
      const res = await Promise.race([
        call(cfg.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-App-Id': cfg.appId,
            'X-Api-Key': cfg.apiKey,
            'X-Api-Resource-Id': cfg.resource,
            'X-Api-Request-Id': requestId,
          },
          body: JSON.stringify(payload),
          signal: controller ? controller.signal : undefined,
        }),
        timeoutPromise,
      ]);
      const status = Number(res && res.status) || 0;
      if (!res || res.ok === false) {
        log({ chars: body.length, cache: 'miss', status: status || 502 });
        return {
          ok: false,
          code: status === 401 || status === 403 ? 'auth' : 'upstream',
          upstream: status,
          status: 502,
          cached: false,
        };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) {
        log({ chars: body.length, cache: 'miss', status: 502 });
        return { ok: false, code: 'empty-audio', status: 502, cached: false };
      }
      store.set(key, buf);
      log({ chars: body.length, cache: 'miss', status: 200 });
      return { ok: true, buffer: buf, bytes: buf.length, cached: false, status: 200 };
    } catch (err) {
      const code = timedOut ? 'timeout' : upstreamCode(err);
      log({ chars: body.length, cache: 'miss', status: 502 });
      return { ok: false, code, status: 502, cached: false };
    } finally {
      if (timer) {
        try { clearTimeout(timer); } catch { /* ignore */ }
      }
    }
  }

  return {
    path: TTS_PATH,
    healthPath: TTS_HEALTH_PATH,
    get configured() { return !!cfg.configured; },
    get missing() { return [...(cfg.missing || [])]; },
    get voice() { return cfg.configured ? cfg.voice : ''; },
    get resource() { return cfg.resource || ''; },
    get endpoint() { return cfg.endpoint || ''; },
    cache: store,
    synthesize,
    health,
  };
}

/** 收集请求 body（上限 64KB） */
function readJsonBody(req, { maxBytes = 64 * 1024 } = {}) {
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
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  } catch { /* 响应已断 */ }
}

/**
 * `/tts` + `/tts/health` 的路由（返回 true = 这个请求已经被处理）。
 *
 * 单独抽出来是为了测试：`http.createServer(createTtsRoutes({ service }))` 就能
 * 用**假 fetch** 跑一遍「缓存命中不二次请求 / 超时 502 / health 不带密钥」。
 *
 * @param {object} opts
 * @param {object} opts.service `createVolcTts()` 的返回值
 * @param {Function} [opts.logger] 只打 `{chars, cache, status}`
 */
export function createTtsRoutes({ service, logger = null } = {}) {
  if (!service || typeof service.synthesize !== 'function') {
    throw new TypeError('createTtsRoutes requires a tts service');
  }
  return function handleTtsRoute(req, res) {
    const urlPath = String((req && req.url) || '').split('?')[0];

    if (urlPath === TTS_HEALTH_PATH) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return true;
      }
      // 只回 configured / missing 与音色名（音色不是密钥），绝不回 appId / apiKey
      sendJson(res, 200, service.health());
      return true;
    }

    if (urlPath !== TTS_PATH) return false;

    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      return true;
    }

    readJsonBody(req).then(async (parsed) => {
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.code });
        return;
      }
      const data = parsed.data;
      const text = ttsBody(data.text);
      if (!text) {
        sendJson(res, 400, { ok: false, error: 'empty-text' });
        return;
      }
      const rate = normalizeRate(data.rate);
      const result = await service.synthesize(text, rate);
      if (!result || !result.ok || !result.buffer) {
        sendJson(res, 502, {
          ok: false,
          error: (result && result.code) || 'tts-failed',
          status: (result && result.status) || 502,
        });
        return;
      }
      try {
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': result.buffer.length,
          'Cache-Control': 'no-store',
        });
        res.end(result.buffer);
        if (typeof logger === 'function') {
          logger({ chars: text.length, cache: result.cached ? 'hit' : 'miss', status: 200 });
        }
      } catch { /* 响应已断 */ }
    }).catch(() => {
      sendJson(res, 502, { ok: false, error: 'tts-failed', status: 502 });
    });
    return true;
  };
}

export default {
  TTS_PATH,
  TTS_HEALTH_PATH,
  loadTtsConfig,
  createTtsCache,
  createVolcTts,
  createTtsRoutes,
  ttsCacheKey,
  normalizeRate,
};
