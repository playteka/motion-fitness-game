// 本地预览服务器（零依赖）。
// 用法：node preview-server.js  然后浏览器打开 http://127.0.0.1:4174
// 必须通过 http 打开：file:// 会拦截摄像头与 wasm 模型加载。
//
// 手机要用摄像头**必须走 https**（浏览器只在 secure context 下给 getUserMedia）：
//   $env:HOST='0.0.0.0'; $env:HTTPS='1'; node preview-server.js
// 证书怎么来见 tools/make-cert.ps1 与 README 的「手机浏览器使用」。
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';   // 打印局域网地址用（HOST=0.0.0.0 时给手机照抄）
import fs from 'node:fs';
import zlib from 'node:zlib';   // 静态资源 gzip（9.3MB 的 wasm 压到 ~3MB，慢机器上快很多）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';   // 进度看板的数据源：现算 git 状态（见 /progress.json）

// 语音代理（P3.1）：原来是一个**独立进程**（node server/coach-proxy.mjs），用户经常忘了起，
// 于是前端连不上 ws://127.0.0.1:4180/asr → 回退 Web Speech → 国内连不上 Google →「火山引擎不可用」。
// 现在 /asr 的 WebSocket 升级**并入这个服务器**：一个进程同时提供页面和语音代理，开箱即用。
import {
  ASR_PATH,
  createAsrUpgradeHandler,
  createLogger as createAsrLogger,
  loadAsrConfig,
} from './server/coach-proxy.mjs';
// 语音合成（P3.6）：/tts 代理火山 TTS + 内存缓存；P3.4 再加 /tts/stream（边收边转发，不缓存）
import {
  TTS_PATH,
  TTS_STREAM_PATH,
  TTS_HEALTH_PATH,
  createTtsRoutes,
  createVolcTts,
  loadTtsConfig,
} from './server/volc-tts.mjs';
// 自由对话（P3.3）：/llm 调大模型 + 工具调用，/llm/health 只报「配没配 / 谁 / 哪个模型」
// 凭证同样只在本进程里读 coach.env；前端只知道同源的 /llm（和 /asr、/tts 一个思路）。
import {
  LLM_HEALTH_PATH,
  LLM_PATH,
  createLlmGuard,
  createLlmProvider,
  createLlmRoutes,
  loadLlmConfig,
} from './server/llm-provider.mjs';
// 长期记忆（三层记忆的服务端层）：/memory（读）/ POST /memory（写）/ POST /memory/forget /
// /memory/health（只报 users 数量，不泄露内容）。一个用户一个 MD 文件，**已 gitignore**。
import {
  DEFAULT_USER_ID,
  MEMORY_DIR,
  MEMORY_MAX_BYTES,
  MemoryError,
  forgetMemory,
  memoryHealth,
  normalizeUserId,
  readMemory,
  updateMemory,
} from './server/memory-store.mjs';

const PORT = Number(process.env.PORT || 4174);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * HTTPS 开关：`HTTPS=1` / `HTTPS=true` / `--https` 都算。
 * 证书默认找 `tools/certs/dev.pfx`（`tools/make-cert.ps1` 生成的那个），
 * 也可以用 PEM 覆盖：`CERT_FILE=... KEY_FILE=...`（自签隧道 / 别的工具生成的证书）。
 */
const HTTPS_ON = /^(1|true|yes|on)$/i.test(String(process.env.HTTPS || '')) || process.argv.includes('--https');
const CERT_DIR = path.join(ROOT, 'tools', 'certs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pem': 'application/x-pem-file',
  '.cer': 'application/pkix-cert',
};

/** 读证书：优先 PFX（make-cert.ps1 产出的那个），也可以用 CERT_FILE + KEY_FILE 两个 PEM 覆盖 */
function loadTls() {
  const passphrase = process.env.CERT_PASS || 'motion-fitness';
  // ① 显式指定的 PEM（自己已有证书 / 隧道工具生成的证书）
  if (process.env.CERT_FILE && process.env.KEY_FILE) {
    const cert = process.env.CERT_FILE;
    const key = process.env.KEY_FILE;
    if (fs.existsSync(cert) && fs.existsSync(key)) {
      return { cert: fs.readFileSync(cert), key: fs.readFileSync(key), source: `${cert} + ${key}` };
    }
    return null;
  }
  // ② 默认 / 显式指定的 PFX（tools/make-cert.ps1 的产物）
  const pfxPath = process.env.PFX_FILE || path.join(CERT_DIR, 'dev.pfx');
  if (fs.existsSync(pfxPath)) return { pfx: fs.readFileSync(pfxPath), passphrase, source: pfxPath };
  return null;
}

/** 证书缺失时把「怎么生成、生成在哪」直接说清楚，而不是静默失败 */
function explainMissingCert() {
  console.error('');
  console.error('✗ 打不开 HTTPS：没有找到证书。');
  console.error(`  默认找：${path.join(CERT_DIR, 'dev.pfx')}（tools/make-cert.ps1 生成的那个）`);
  console.error('  生成（在项目根目录跑一次即可，Windows 自带 PowerShell 就够，不需要 openssl）：');
  console.error('      powershell -ExecutionPolicy Bypass -File tools\\make-cert.ps1');
  console.error('  想用自己已有的证书（PEM 两份）：');
  console.error('      $env:CERT_FILE="D:\\certs\\fullchain.pem"; $env:KEY_FILE="D:\\certs\\privkey.pem"; $env:HTTPS="1"; node preview-server.js');
  console.error('');
  console.error('✗ Cannot start HTTPS: no certificate found.');
  console.error('  Generate one:  powershell -ExecutionPolicy Bypass -File tools\\make-cert.ps1');
  console.error('  Or point CERT_FILE / KEY_FILE at your own PEM pair.');
  console.error('');
  process.exit(1);
}

/**
 * 语音代理的配置：**只在这里读一次** `coach.env`（缺文件 / 缺字段都不抛错）。
 * 凭证不打印、不进日志；缺字段时页面回退浏览器识别，但预览服务器照常工作。
 */
const asr = loadAsrConfig();
const asrLogger = createAsrLogger();
/**
 * 火山 TTS：和 ASR 一样**只在启动时读一次** `coach.env`（缺文件 / 缺字段都不抛错）。
 * 日志只打「配没配 / 缺哪些字段名」，绝不打印值；`/tts` 的每一句只打 chars / cache / status。
 */
const ttsConfig = loadTtsConfig();
const ttsService = createVolcTts({
  config: ttsConfig.config,
  logger: (fields) => {
    // 只允许这几个字段：字数 / 缓存命中 / 状态码 —— 没有文本、没有凭证
    console.log(`[tts] chars=${fields.chars} cache=${fields.cache} status=${fields.status}`);
  },
});
const ttsRoute = createTtsRoutes({ service: ttsService });

/**
 * 自由对话（P3.3）：同样**只在启动时读一次** `coach.env`（缺文件 / 缺字段都不抛错）。
 * 没有 key → `configured:false`，`POST /llm` 直接 503，页面自动只用命令快车道。
 * 日志只打 provider / model / tokens / tool-calls / 耗时，绝不打印 key。
 */
const llmConfig = loadLlmConfig();
const llmProvider = createLlmProvider({
  config: llmConfig.config,
  logger: (fields) => {
    // 白名单字段（provider/model/ms/prompt/completion/tools/status/code），没有 key
    const parts = Object.entries(fields || {}).map(([k, v]) => `${k}=${v}`);
    console.log(`[llm] ${parts.join(' ')}`);
  },
});
const llmGuard = createLlmGuard();
const llmRoute = createLlmRoutes({
  provider: llmProvider,
  config: llmConfig.config,
  guard: llmGuard,
  memoryStore: { readMemory, updateMemory, forgetMemory },
  logger: (message, fields) => {
    const parts = Object.entries(fields || {}).map(([k, v]) => `${k}=${v}`);
    console.log(`[llm] ${message} ${parts.join(' ')}`);
  },
});

/* ------------------------------------------------------------------ *
 * 长期记忆的路由（三层记忆的第 ③ 层）
 *
 *   GET  /memory?user=<id>          → 读这个用户的记忆（prefs / facts / 摘要 / 上次未完成）
 *   POST /memory                    → 合并式更新（prefs / facts / summaries / lastUnfinished）
 *   POST /memory/forget             → {user, field} 删一条，或 {user, all:true} 全清
 *   GET  /memory/health             → {ok, users:N}（**只报数量，不泄露内容 / id**）
 *
 * 安全：userId 必须是 `^[a-zA-Z0-9_-]{1,32}$`，别的直接 400（防路径穿越）；
 * MD 上限 64KB；字段与取值全在 memory-store 里过白名单。日志一行只记「哪个用户 / 成功没成功」。
 * ------------------------------------------------------------------ */
export const MEMORY_API_PATH = '/memory';
export const MEMORY_FORGET_PATH = '/memory/forget';
export const MEMORY_HEALTH_PATH = '/memory/health';

/** 记忆目录：允许用 `MFG_MEMORY_DIR` 覆盖（测试用临时目录，绝不写进仓库） */
function memoryDir() {
  return String(process.env.MFG_MEMORY_DIR || '') || MEMORY_DIR;
}

/** 读 JSON body（和 /llm 同一套写法；超过上限直接 413） */
function readMemoryBody(req, maxBytes = MEMORY_MAX_BYTES) {
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
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          resolve({ ok: false, code: 'bad-body' });
          return;
        }
        resolve({ ok: true, data });
      } catch {
        resolve({ ok: false, code: 'bad-json' });
      }
    });
    req.on('error', () => resolve({ ok: false, code: 'read-error' }));
  });
}

function sendMemoryJson(res, status, obj) {
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(obj));
  } catch { /* 响应已断 */ }
}

/** 统一的错误响应：稳定 code + 字段 + 原因（**不回显用户文本**） */
function memoryErrorResponse(res, err) {
  const code = (err && err.code) || 'memory-error';
  const status = code === 'too-big' ? 413 : 400;
  sendMemoryJson(res, status, {
    ok: false,
    error: code,
    field: (err && err.field) || '',
    reason: (err && err.reason) || '',
  });
}

/** 处理记忆路由；返回 true = 这个请求已经处理完 */
export function handleMemoryRoute(req, res) {
  const pathOnly = String((req && req.url) || '').split('?')[0];
  if (pathOnly !== MEMORY_API_PATH
    && pathOnly !== MEMORY_FORGET_PATH
    && pathOnly !== MEMORY_HEALTH_PATH) {
    return false;
  }
  const dir = memoryDir();

  if (pathOnly === MEMORY_HEALTH_PATH) {
    if (req.method !== 'GET') {
      sendMemoryJson(res, 405, { ok: false, error: 'method-not-allowed' });
      return true;
    }
    sendMemoryJson(res, 200, memoryHealth({ dir }));
    return true;
  }

  if (pathOnly === MEMORY_API_PATH && req.method === 'GET') {
    let userId = DEFAULT_USER_ID;
    try {
      userId = normalizeUserId(new URL(req.url, 'http://127.0.0.1').searchParams.get('user')
        || DEFAULT_USER_ID);
    } catch {
      sendMemoryJson(res, 400, { ok: false, error: 'bad-user' });
      return true;
    }
    try {
      const memory = readMemory(userId, { dir });
      sendMemoryJson(res, 200, { ok: true, ...memory });
    } catch (err) {
      memoryErrorResponse(res, err);
    }
    return true;
  }

  if (req.method !== 'POST') {
    sendMemoryJson(res, 405, { ok: false, error: 'method-not-allowed' });
    return true;
  }

  readMemoryBody(req).then((parsed) => {
    if (!parsed.ok) {
      sendMemoryJson(res, parsed.code === 'too-big' ? 413 : 400, {
        ok: false,
        error: parsed.code,
      });
      return;
    }
    const body = parsed.data;
    let userId = DEFAULT_USER_ID;
    try {
      userId = normalizeUserId(body.user == null || body.user === '' ? DEFAULT_USER_ID : body.user);
    } catch {
      sendMemoryJson(res, 400, { ok: false, error: 'bad-user' });
      return;
    }
    try {
      if (pathOnly === MEMORY_FORGET_PATH) {
        const memory = forgetMemory(userId, {
          all: body.all === true,
          field: body.field,
        }, { dir });
        sendMemoryJson(res, 200, { ok: true, ...memory });
        return;
      }
      const patch = {};
      if (body.prefs !== undefined) patch.prefs = body.prefs;
      if (body.facts !== undefined) patch.facts = body.facts;
      if (body.summaries !== undefined) patch.summaries = body.summaries;
      if (body.lastUnfinished !== undefined) patch.lastUnfinished = body.lastUnfinished;
      if (!Object.keys(patch).length) {
        sendMemoryJson(res, 400, { ok: false, error: 'empty-patch' });
        return;
      }
      const memory = updateMemory(userId, patch, { dir });
      sendMemoryJson(res, 200, { ok: true, ...memory });
    } catch (err) {
      memoryErrorResponse(res, err);
    }
  }).catch(() => {
    sendMemoryJson(res, 400, { ok: false, error: 'bad-request' });
  });
  return true;
}

/**
 * 能 gzip 的后缀（文本类 **+ 运行库 `.wasm` + 模型 `.task`**）。
 *
 * 上一轮曾经把 `.wasm` 从这份名单里去掉（`c0eaa16`）：本机回环直连 9.3MB 只要 41~86ms，
 * 而 gzip 9.3MB 要 0.3~1.7 秒 —— 在**直连**的本机上压缩确实是净亏 ✗。
 *
 * 但用户后来报了「公司网络快、家里网络慢」：那种情况下 127.0.0.1 也被代理 / VPN 接管了
 * （Chrome 默认会把 localhost 交给系统代理，除非显式绕过），链路只有几百 KB/s~1MB/s，
 * **压缩就是净赚** ✓：9.5MB → ~2.9MB（实测 9502124 → 2909084 字节，省 69%），
 * 模型 `.task` 也能省 ~14%（5777746 → 4971496）。
 * 压缩结果按「路径 + mtime + 大小」缓存，同一个文件只压一次（见下面的 gzipEntryFor），
 * 所以再慢的链路也不会反复付那 0.5 秒的 CPU；压不动的文件按 `GZIP_MIN_SAVING` 自动放弃。
 */
export const GZIP_EXTS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.webmanifest',
  '.svg', '.md', '.txt', '.wasm', '.task']);

/**
 * 「压缩还是原始」的分界线：压缩后**至少要省下 5%**，否则发原始字节。
 *
 * 模型 `.task` 是 zip 容器（里面已经是压缩过的 tflite），实测还能再省 11%~14%，
 * 所以默认会压；但换成更新过的 / 已经打包过 gzip 的模型时可能一点也压不动 ——
 * 那时 `gzBytes >= rawBytes * 0.95`，**放弃压缩直接发原始**，别让用户多付一次解压时间。
 */
export const GZIP_MIN_SAVING = 0.95;

/** 这一对字节数「值不值得压」（纯函数；测试直接断言边界） */
export function gzipWorthIt(rawBytes, gzBytes) {
  const raw = Number(rawBytes) || 0;
  const gz = Number(gzBytes) || 0;
  return raw > 0 && gz > 0 && gz < raw * GZIP_MIN_SAVING;
}

/**
 * gzip 结果的内存缓存：绝对路径 → { key: `mtime:size`, gz, rawBytes, gzBytes }。
 * - 同一个文件（mtime + size 没变）只压一次；
 * - `gz === null` 表示「压过但不值得发」（已缓存这个判断，不会每次请求都白压一遍）；
 * - `gzipInflight` 让并发请求共享同一次压缩（9.3MB 别同时压两遍）。
 */
const gzipCache = new Map();
const gzipInflight = new Map();

/** 异步 gzip（不阻塞事件循环：9.3MB 压 0.5 秒，同步压会让其它请求一起卡住） */
function gzipAsync(buffer) {
  return new Promise((resolve, reject) => {
    zlib.gzip(buffer, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

/**
 * 拿到某个文件的压缩结果（带缓存 + 并发去重）。
 * @returns {Promise<{key:string,gz:Buffer|null,rawBytes:number,gzBytes:number}>}
 *   `gz === null` → 压不动 / 不值得压，调用方直接发原始字节。
 */
export function gzipEntryFor(file, key) {
  const hit = gzipCache.get(file);
  if (hit && hit.key === key) return Promise.resolve(hit);
  const flying = gzipInflight.get(file);
  if (flying && flying.key === key) return flying.promise;
  const promise = fs.promises.readFile(file)
    .then(async (raw) => {
      const gz = await gzipAsync(raw);
      const entry = {
        key,
        gz: gzipWorthIt(raw.length, gz.length) ? gz : null,
        rawBytes: raw.length,
        gzBytes: gz.length,
      };
      gzipCache.set(file, entry);
      return entry;
    })
    .finally(() => {
      const current = gzipInflight.get(file);
      if (current && current.promise === promise) gzipInflight.delete(file);
    });
  gzipInflight.set(file, { key, promise });
  return promise;
}

/** `/pose-check`：一眼看出「服务器能给多大 / 压缩后多大」（只报字节数，不含路径） */
export const POSE_CHECK_PATH = '/pose-check';

/** 这个路径下「用户实际要下载的大文件」（默认轻量模型，可在设置里换 full） */
export const POSE_CHECK_FILES = {
  wasm: 'vendor/tasks-vision/wasm/vision_wasm_internal.wasm',
  model: 'vendor/models/pose_landmarker_lite.task',
};

/** 静态资源的响应头（`/vendor/**` 也一视同仁：本地开发**完全不缓存**，见下面的注释） */
function staticHeaders(ext) {
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    /**
     * **no-store**（用户拍板）：这些文件都不大，每次重新下载不成问题；
     * 反过来，只要缓存过一份坏文件（下载中断 / 反复重启服务器时很容易发生），
     * 就会一直坏下去 —— 用户今天遇到的「初始化识别器超时」正是这种形态，所以宁可慢一点。
     */
    'Cache-Control': 'no-store',
    // 跨源隔离：COOP + COEP 必须**同时**存在（浏览器才会给 SharedArrayBuffer / 高性能 wasm）
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
  };
  if (GZIP_EXTS.has(ext)) headers.Vary = 'Accept-Encoding';
  return headers;
}

/** 读文件 → 按需 gzip（带内存缓存）→ 写响应 */
function serveStatic(req, res, file) {
  const ext = path.extname(file).toLowerCase();
  const notFound = () => {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not Found');
  };
  fs.stat(file, (statErr, stat) => {
    if (statErr || !stat.isFile()) { notFound(); return; }
    const headers = staticHeaders(ext);
    const wantsGzip = GZIP_EXTS.has(ext) && /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
    const send = (buffer, encoding) => {
      if (encoding) headers['Content-Encoding'] = encoding;
      headers['Content-Length'] = buffer.length;
      res.writeHead(200, headers);
      res.end(buffer);
    };
    if (!wantsGzip) {
      fs.readFile(file, (readErr, data) => (readErr ? notFound() : send(data)));
      return;
    }
    // 同一个文件（mtime + size 没变）只压一次：别每次请求都 gzip 9.3MB。
    // 压缩是**异步**的（不阻塞事件循环），并发请求共享同一次压缩；
    // 压不动（.task 本来就压过 / 随机数据）→ gz 为 null → 发原始字节，客户端照样能跑。
    const key = `${Math.round(stat.mtimeMs)}:${stat.size}`;
    const sendRaw = () => fs.readFile(file, (readErr, data) => (readErr ? notFound() : send(data)));
    gzipEntryFor(file, key).then((entry) => {
      if (entry && entry.gz) send(entry.gz, 'gzip');
      else sendRaw();
    }, sendRaw);   // 压失败（读失败 / zlib 出错）也退回原始字节，绝不把请求挂住
  });
}

/**
 * 请求处理函数（导出给测试用：`http.createServer(previewHandler)` 就能跑真实响应头 / gzip 断言）。
 * 只有作为主模块启动时才会真的 listen，被测试 import 时不会占端口。
 */
export const previewHandler = (req, res) => {
  // 长期记忆（三层记忆的第 ③ 层）：/memory、/memory/forget、/memory/health
  if (handleMemoryRoute(req, res)) return;
  // 语音合成（P3.6）：POST /tts（音频）与 GET /tts/health（配没配），先于静态资源处理
  if (ttsRoute(req, res)) return;
  // 自由对话（P3.3）：POST /llm 与 GET /llm/health（不碰任何静态文件）
  if (llmRoute(req, res)) return;

  // 调试数据记录（页面「运动设定」里的「记录调试数据」开关）：
  // 页面把每一批采样（JSONL 文本）POST 到这里，服务端**追加**写进 logs/ 下的文件 ——
  // 这样真机测试完之后，日志就落在项目目录里，可以直接拿来分析「为什么没计上」。
  // 文件名做了白名单校验（只允许 [A-Za-z0-9._-] + .jsonl）。
  if (req.method === 'POST' && req.url.startsWith('/__debug/log')) {
    let body = '';
    let tooBig = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > 12 * 1024 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      if (tooBig) return send(413, { ok: false, error: 'too big' });
      let name = '';
      try {
        name = new URL(req.url, 'http://127.0.0.1').searchParams.get('file') || '';
      } catch { /* ignore */ }
      if (!/^[A-Za-z0-9._-]+\.jsonl$/.test(name)) return send(400, { ok: false, error: 'bad file name' });
      try {
        const dir = path.join(ROOT, 'logs');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name);
        if (!file.startsWith(dir)) return send(403, { ok: false, error: 'forbidden' });
        fs.appendFileSync(file, body);
        return send(200, { ok: true, file: `logs/${name}`, bytes: Buffer.byteLength(body) });
      } catch (err) {
        return send(500, { ok: false, error: String(err && err.message) });
      }
    });
    return;
  }

  // 已经记下来的日志文件列表（排查时方便看一眼「记了多少」）
  if (req.method === 'GET' && req.url.startsWith('/__debug/logs')) {
    try {
      const dir = path.join(ROOT, 'logs');
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { file: f, bytes: st.size, at: st.mtimeMs };
        })
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, files }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(err && err.message) }));
    }
    return;
  }

  // 自检探针：页面用 ?probe=1 打开时会把运行时诊断 POST 到这里，
  // 便于在无头浏览器 / 无人值守场景下检查页面是否正常启动。
  if (req.method === 'POST' && req.url === '/__probe') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 200000) req.destroy(); });
    req.on('end', () => {
      try {
        const dir = path.join(ROOT, '_probe');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'last.json'), body);
      } catch { /* 忽略写入失败 */ }
      res.writeHead(204);
      res.end();
    });
    return;
  }

  // 语音代理的体检入口：浏览器打开 /asr 会看到这里（真正的识别走 WebSocket 升级，
  // 见下面 server.on('upgrade')）。排障时先看 configured / missing，不用猜「代理起没起」。
  if (req.method === 'GET' && (req.url || '').split('?')[0] === ASR_PATH) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      service: 'motion-fitness asr proxy (in preview-server)',
      transport: 'websocket',
      path: ASR_PATH,
      configured: asr.config.configured,
      missing: asr.config.missing,
    }));
    return;
  }

  /**
   * 离线自检：`GET /pose-check`
   *
   * 用户反馈「刚开始加载运行库总是有问题 —— 公司网络加载很快，家里网络很慢」。
   * 这个端点把**服务器能提供多大 / gzip 后多大**直接摆出来，只报字节数（**不含任何路径 / 凭证**）：
   *
   *   { "wasm": { "bytes": 9502124, "gzBytes": 2909084 },
   *     "model": { "bytes": 5777746, "gzBytes": 4971496 }, "gzip": true }
   *
   * 在家里打开它，一眼就能分清是「服务器只给这么点」还是「3MB 的东西走了 30 秒」——
   * 后者就是链路（代理 / VPN 把 127.0.0.1 也代理了，见 README 的「加载慢怎么办」）。
   */
  if (req.method === 'GET' && (req.url || '').split('?')[0] === POSE_CHECK_PATH) {
    const sizeOf = async (rel) => {
      const file = path.join(ROOT, rel);
      let stat = null;
      try { stat = fs.statSync(file); } catch { /* 缺文件就报 0，不报错也不泄露路径 */ }
      if (!stat || !stat.isFile()) return { bytes: 0, gzBytes: 0 };
      try {
        // 复用同一个压缩缓存：这里量到的 gz 大小就是浏览器真正会收到的字节数
        const entry = await gzipEntryFor(file, `${Math.round(stat.mtimeMs)}:${stat.size}`);
        return { bytes: stat.size, gzBytes: entry.gzBytes || 0 };
      } catch {
        return { bytes: stat.size, gzBytes: 0 };
      }
    };
    Promise.all([sizeOf(POSE_CHECK_FILES.wasm), sizeOf(POSE_CHECK_FILES.model)])
      .then(([wasm, model]) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ wasm, model, gzip: true }));
      });
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  serveStatic(req, res, file);
};

/** 服务器启动时用这个（等价的别名，保留原来的名字） */
const handler = previewHandler;

/**
 * 监听地址：默认**只监听本机回环**（安全），需要让同一 Wi-Fi 下的手机访问时，
 * 用环境变量打开：`$env:HOST='0.0.0.0'; node preview-server.js`
 *
 * ⚠️ 手机用 http 打开时**摄像头用不了** —— 浏览器只在 `https://` 或 `localhost` 下允许
 * `getUserMedia`（secure context 规则，不是本项目的限制）。手机要练动作必须走 HTTPS：
 * `HTTPS=1` + `tools/make-cert.ps1` 的自签证书，或者 README 里的 ssh 隧道方案。
 */
const HOST = process.env.HOST || '127.0.0.1';
const PROTO = HTTPS_ON ? 'https' : 'http';

/** 本机的局域网 IPv4（列出所有网卡，手机要挑同一 Wi-Fi 的那个） */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}

/** 只有 `node preview-server.js` 才真的监听端口；被测试 import 时只导出 previewHandler（不占端口） */
const IS_MAIN = (() => {
  try {
    return path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

/** 起服务器（HTTPS / HTTP + 语音代理的 upgrade 路由 + 启动日志） */
function startServer() {
  let server;
  if (HTTPS_ON) {
    const tls = loadTls();
    if (!tls) explainMissingCert();
    try {
      server = https.createServer(tls, handler);
    } catch (err) {
      console.error('');
      console.error('✗ HTTPS 证书读不了：' + (err && err.message));
      console.error(`  证书来源：${tls.source}`);
      console.error('  重新生成一次： powershell -ExecutionPolicy Bypass -File tools\\make-cert.ps1');
      console.error('  （PFX 口令默认 motion-fitness；换过口令就用 CERT_PASS 指定）');
      console.error('');
      process.exit(1);
    }
  } else {
    server = http.createServer(handler);
  }

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`✗ 端口 ${PORT} 已被占用：可能已经有一个 preview-server 在跑。`);
      console.error(`  换一个端口：$env:PORT='4175'; node preview-server.js`);
      process.exit(1);
    }
    throw err;
  });

  /**
   * 语音代理的 WebSocket 升级路由（和独立代理共用 coach-proxy.mjs 里同一份处理逻辑）。
   *
   *   - `/asr`          → 交给 handleAsrUpgrade（缺凭证时回 error 帧 + 4401，不崩）；
   *   - 其它 upgrade    → 直接 socket.destroy()，不留悬空连接。
   */
  server.on('upgrade', createAsrUpgradeHandler({
    config: asr.config,
    logger: asrLogger,
    envPath: asr.envPath,
  }));

  server.listen(PORT, HOST, () => {
    console.log(`体感健身游戏预览地址： ${PROTO}://127.0.0.1:${PORT}`);
    console.log(`Motion Fitness is running at: ${PROTO}://127.0.0.1:${PORT}`);
    console.log(`语音识别代理（同一进程）： ${PROTO === 'https' ? 'wss' : 'ws'}://127.0.0.1:${PORT}${ASR_PATH}`
      + (asr.config.configured ? '（火山凭证已配置）' : '（缺火山凭证 → 页面会自动回退浏览器识别）'));
    console.log(`Speech proxy in this same server: ${PROTO === 'https' ? 'wss' : 'ws'}://127.0.0.1:${PORT}${ASR_PATH}`
      + (asr.config.configured ? ' (Volcengine credentials configured)' : ' (no credentials → the page falls back to Web Speech)'));
    // 火山 TTS：只报「配没配」，不报任何值（音色 / 资源 / key 一律不出现）
    console.log(`语音合成（火山 TTS）： ${ttsService.configured ? '已配置，火山优先（流式 /tts/stream，整段 /tts 带缓存）' : '未配置 → 自动回退系统 TTS'}`
      + `  [${TTS_STREAM_PATH} + ${TTS_HEALTH_PATH}]`);
    console.log(`Text-to-speech (Volcengine TTS): ${ttsService.configured ? 'configured (Volcengine first; streaming /tts/stream, whole /tts with cache)' : 'not configured → system TTS fallback'}`
      + `  [${TTS_PATH}]`);
    if (!ttsService.configured) {
      console.warn(`  ⚠️ TTS 缺字段：${ttsService.missing.join(', ')}（在 ${path.basename(ttsConfig.envPath)} 里填；不填也能用，只是回退系统 TTS）`);
    }
    // 自由对话：只报 provider / model / 配没配，**不报 key**
    console.log(`自由对话（LLM）： ${llmConfig.config.configured ? `已配置，${llmConfig.config.provider} / ${llmConfig.config.model}` : '未配置 → 只走命令快车道'}  [${LLM_PATH}]`);
    console.log(`Free chat (LLM): ${llmConfig.config.configured ? `configured, ${llmConfig.config.provider} / ${llmConfig.config.model}` : 'not configured → command fast-lane only'}  [${LLM_HEALTH_PATH}]`);
    if (!llmConfig.config.configured) {
      console.warn(`  ⚠️ LLM 缺字段：${llmConfig.config.missing.join(', ')}（在 ${path.basename(llmConfig.envPath)} 里填；不填也能练，只是没有自由对话）`);
      console.warn('  ⚠️ Missing: ' + llmConfig.config.missing.join(', ')
        + ` in ${path.basename(llmConfig.envPath)} — the game still works, free chat is off.`);
    }
    if (!asr.config.configured) {
      console.warn(`  ⚠️ 没读到完整凭证：${asr.config.missing.join(', ')}（在 ${path.basename(asr.envPath)} 里填；不填也能练，只是语音识别会回退）`);
      console.warn('  ⚠️ Missing: ' + asr.config.missing.join(', ') + ` in ${path.basename(asr.envPath)} — the game still works, speech falls back.`);
    }
    if (HOST === '0.0.0.0') {
      // 打印局域网地址，手机直接照这个开（同一 Wi-Fi 下；防火墙要放行 Node 入站）
      for (const { name, address } of lanAddresses()) {
        console.log(`局域网（手机同 Wi-Fi 打开）： ${PROTO}://${address}:${PORT}   [${name}]`);
        console.log(`LAN (open on your phone):      ${PROTO}://${address}:${PORT}   [${name}]`);
      }
      if (HTTPS_ON) {
        console.log('✓ 手机用上面这个 https 地址打开就能开摄像头（证书要先装进手机并信任）');
        console.log('✓ Open the https address above on your phone to use the camera.');
        console.log('  证书装法 / 不想装证书的隧道方案，见 README 的「手机浏览器使用」');
        console.log('  See "Using it on a phone" in README for certificate setup or the tunnel option.');
      } else {
        console.log('⚠️ 手机上只能用来看界面 / 动作库 / 成绩：摄像头需要 https，http 会被浏览器拦下');
        console.log('⚠️ On a phone this is browse-only: the camera needs https.');
        console.log(`   加 HTTPS=1 再启动一次即可：$env:HTTPS='1'; $env:HOST='0.0.0.0'; node preview-server.js`);
      }
    } else if (HTTPS_ON) {
      console.log('✓ HTTPS 已开启（只有本机可达；手机要访问请用 HOST=0.0.0.0）');
      console.log('✓ HTTPS is on (loopback only; use HOST=0.0.0.0 to reach it from a phone)');
    }
    console.log('（用 Chrome / Edge 打开，首次点“开启摄像头”并允许权限）');
    console.log('(Open it in Chrome / Edge, click "Start camera" and allow the permission)');
  });
}

if (IS_MAIN) startServer();
