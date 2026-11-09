/**
 * 本机语音代理（P3.1）。
 *
 * 浏览器 ──ws(s)://<页面 host>/asr──▶ 本机进程 ──wss://openspeech.bytedance.com──▶ 火山
 *
 * **两种跑法，同一份逻辑**：
 *   1. 默认（推荐）**并入预览服务器**：`node preview-server.js` 一个进程就够，
 *      `/asr` 的 WebSocket 升级由 `createAsrUpgradeHandler()` 接管 —— 页面跟页面同源同端口，
 *      用户不用再开第二个窗口；
 *   2. 独立进程（排障）：`node server/coach-proxy.mjs`（`npm run coach-proxy`），
 *      默认 `ws://127.0.0.1:4180/asr`，专门用来单独验证代理这一层。
 *
 * 为什么要有它：
 *   - 浏览器里的 `webkitSpeechRecognition` 在国内连不上 Google 的识别服务（`error.network`）；
 *   - 火山要求握手头里带 APP ID / API Key —— 浏览器 `WebSocket` **不能自定义头**，
 *     而且凭证绝不能进前端；
 *   - 所以由本机 Node 进程拿着 `coach.env` 里的凭证去连，浏览器只知道同源的 `/asr`。
 *
 * 安全约束（实现时逐条守住）：
 *   - 独立进程**只绑 127.0.0.1**（端口默认 4180，可用 `PORT` 覆盖），不接受局域网连接；
 *   - 凭证只从 `coach.env` / 进程环境读，**不打印值**（只打印「配了、几个字符」）；
 *   - 错误信息统一过 `sanitizeDetail()`，防止底层把 Key 回显到浏览器 / 日志里；
 *   - 日志只在内存 / 终端；要写文件请用 `COACH_LOG=1`（写到系统临时目录），**不放仓库**；
 *   - 缺凭证时**不崩**：握手照常完成 → error 帧（code=config）→ 关闭码 4401（见 CLOSE_CODE_CONFIG）。
 *
 * 对浏览器的控制消息：
 *   收到：{"type":"start","lang":"zh-CN"} / {"type":"stop"}
 *   发出：{"type":"ready"} / {"type":"partial","text":"…"} / {"type":"final","text":"…"}
 *         / {"type":"error","code":"…","message":"…"}
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile, maskSecret, volcConfigFrom } from './env.mjs';
import { closeFrame, computeAccept, createFrameParser, createMessageAssembler, encodeFrame, handshakeResponse, isUpgradeRequest, OPCODES, rejectResponse } from './ws-mini.mjs';
import { createVolcSession } from './volc-asr.mjs';
import { VOLC_DEFAULTS } from './volc-protocol.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');

/** 监听地址写死回环；不提供 HOST 覆盖（这个代理只服务本机浏览器） */
export const BIND_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4180;
export const ASR_PATH = '/asr';

/**
 * 缺凭证时给浏览器的关闭码（4000~4999 是应用自定义区间）。
 * 1011 之类的通用码看不出原因；用一个专属码，排障时一眼能认出「是 coach.env 没填」。
 */
export const CLOSE_CODE_CONFIG = 4401;

/** 单条 WebSocket 消息上限（一包 16k PCM 只有几 KB，1MB 已经很宽松） */
const MAX_CLIENT_MESSAGE = 1024 * 1024;
/** 收到 stop 之后最多再等多久让火山把最后一帧吐出来（浏览器端会等 same 4s） */
export const FINAL_GRACE_MS = 3000;
/** 同一段文本在这个窗口内不重复发 final（与 volc-protocol 的节流同一档） */
export const FINAL_THROTTLE_MS = 300;

/** 短连接 id（日志用，不含任何可追踪信息） */
function shortId() {
  return Math.random().toString(16).slice(2, 8);
}

/**
 * 日志器。**永远只接收已经脱敏的字段**（本文件里所有调用点都只传数字 / 错误码 / 布尔）。
 * `COACH_LOG=1` 时额外追加到系统临时目录（不进仓库）。
 */
export function createLogger({ sink = console, file = '' } = {}) {
  const write = (level, message, extra) => {
    const line = `[coach-proxy] ${message}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
    try { (sink[level] || sink.log).call(sink, line); } catch { /* ignore */ }
    if (file) {
      try { fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`); } catch { /* ignore */ }
    }
  };
  return {
    info: (message, extra) => write('log', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
    file,
  };
}

/** 每个浏览器的连接：解 WS 帧 → 控制消息 / 音频 → 火山会话 */
function attachClient(socket, {
  config, logger, envPath, head = null,
  relayFactory = createVolcSession,
  finalGraceMs = FINAL_GRACE_MS,
}) {
  const id = shortId();
  const wsParser = createFrameParser();
  const audio = { bytes: 0, chunks: 0, firstAt: 0, lastAt: 0 };
  let relay = null;
  let started = false;
  let stopRequested = false;
  let finalSent = false;
  let closing = false;
  let finalTimer = null;
  let closed = false;
  let partialsSent = 0;
  let finalsSent = 0;
  let lastFinalText = '';
  const finalSentAt = new Map();   // 文本 → 上次发送时间（300ms 节流用）
  const partialAt = new Map();     // partial 文本 → 上次发送时间（300ms 节流用）

  logger.info('client connected', { id });

  // Node 的 upgrade 事件会把「握手包里已经读到的字节」单独给出来（第三个参数）。
  // 浏览器刚连上就发 start 时这些字节就是第一批帧，不 unshift 回去会丢。
  if (head && head.length) {
    try { socket.unshift(head); } catch { /* 老版本 Node 没有 / 已经关了 */ }
  }

  const send = (obj) => {
    if (closed || socket.destroyed) return;
    try {
      socket.write(encodeFrame({ opcode: OPCODES.TEXT, payload: JSON.stringify(obj) }));
    } catch { /* 对端已经走了 */ }
  };

  function clearFinalTimer() {
    if (finalTimer !== null) {
      clearTimeout(finalTimer);
      finalTimer = null;
    }
  }

  /**
   * 发一条 final —— **同一段文本只发一次**。
   *
   * 以前上游每个响应都把「之前已定稿的句子 + 累计全文」重发一遍，代理照单全收，
   * 日志里同一句 4 个字能在几秒内刷几百行（`final {chars:4}`），客户端被刷屏 / 去重，
   * 用户就「看不到结果」。这里做三层保护：
   *   1. 同一段文本连续出现（lastFinalText）不再发；
   *   2. 同一文本 300ms 内不再发；
   *   3. 空字符串收尾只发一次（前面的 final 已经有内容时不再补空包）。
   * @returns {boolean} 是否真的发了
   */
  function sendFinal(text, { reason = 'upstream' } = {}) {
    const body = String(text == null ? '' : text);
    const at = Date.now();
    if (body === '' && finalSent) return false;
    if (body && body === lastFinalText) return false;
    const prev = finalSentAt.get(body);
    if (prev !== undefined && at - prev < FINAL_THROTTLE_MS) return false;
    finalSentAt.set(body, at);
    if (finalSentAt.size > 256) {
      for (const [k, t] of finalSentAt) if (at - t > 60000) finalSentAt.delete(k);
    }
    lastFinalText = body;
    finalSent = true;
    finalsSent += 1;
    clearFinalTimer();
    send({ type: 'final', text: body });
    logger.info('final', { id, chars: body.length, reason, n: finalsSent });
    return true;
  }

  function sendPartial(text) {
    const body = String(text == null ? '' : text);
    if (!body) return false;
    const at = Date.now();
    const prev = partialAt.get(body);
    if (prev !== undefined && at - prev < FINAL_THROTTLE_MS) return false;
    partialAt.set(body, at);
    if (partialAt.size > 256) {
      for (const [k, t] of partialAt) if (at - t > 60000) partialAt.delete(k);
    }
    partialsSent += 1;
    send({ type: 'partial', text: body });
    return true;
  }

  function closeClient() {
    if (closed) return;
    const segments = relay ? relay.segments : 0;
    const durationMs = audio.firstAt ? Math.max(1, (audio.lastAt || Date.now()) - audio.firstAt) : 0;
    closed = true;
    clearFinalTimer();
    closing = true;
    teardownRelay();
    try {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(1000, 0);
      socket.write(encodeFrame({ opcode: OPCODES.CLOSE, payload }));
    } catch { /* ignore */ }
    try { socket.end(); } catch { /* ignore */ }
    logger.info('client closed', {
      id,
      audioBytes: audio.bytes,
      chunks: audio.chunks,
      // 每帧字节数 / 每秒字节数：正常应是 3200 字节/帧、≈32000 B/s
      bytesPerChunk: audio.chunks ? Math.round(audio.bytes / audio.chunks) : 0,
      bytesPerSec: durationMs ? Math.round((audio.bytes * 1000) / durationMs) : 0,
      partials: partialsSent,
      finals: finalsSent,
      segments,
      final: finalSent,
    });
  }

  function teardownRelay() {
    const r = relay;
    relay = null;
    try { r?.close?.(); } catch { /* ignore */ }
  }

  function finishSoon(delayMs = 80) {
    if (closing) return;
    closing = true;
    setTimeout(closeClient, delayMs).unref?.();
  }

  /** 火山事件 → 浏览器消息（这里也是**唯一**把 event 变成 {type:...} 的地方） */
  function onVolcEvent(event) {
    if (!event || !event.type) return;
    if (event.type === 'ready') {
      logger.info('upstream ready', { id });
      send({ type: 'ready' });
      return;
    }
    if (event.type === 'partial') {
      const text = String(event.text || '');
      if (!text) return;
      // 中间结果要真的发给浏览器：客户端只靠 partial 才会上屏（以前日志里完全没有 partial）
      sendPartial(text);
      return;
    }
    if (event.type === 'final') {
      sendFinal(event.text, { reason: stopRequested ? 'stop' : 'upstream' });
      if (stopRequested) finishSoon(120);
      return;
    }
    if (event.type === 'error') {
      // event.message 已经在 volc-asr 里脱敏；这里再兜一层，绝不让凭证出现在浏览器 / 日志
      const code = String(event.code || 'upstream');
      const message = String(event.message || '').slice(0, 300);
      logger.warn('upstream error', { id, code, volcCode: event.volcCode || 0 });
      send({ type: 'error', code, message });
      if (!finalSent) finishSoon(120);
      return;
    }
    if (event.type === 'closed') {
      if (!closing && !stopRequested) {
        logger.warn('upstream closed', { id, code: event.code || '' });
        send({ type: 'error', code: 'upstream', message: 'upstream closed' });
        finishSoon(80);
      }
    }
  }

  async function handleStart(msg) {
    if (started) {
      send({ type: 'error', code: 'bad-request', message: 'already started' });
      return;
    }
    started = true;
    const lang = String(msg && msg.lang ? msg.lang : 'zh-CN').slice(0, 20);
    if (!config.configured) {
      logger.warn('start rejected: config missing', { id, missing: config.missing });
      send({
        type: 'error',
        code: 'config',
        message: `coach.env is missing ${config.missing.join(', ')} (${path.basename(envPath)})`,
      });
      return;
    }
    relay = relayFactory({ config, onEvent: onVolcEvent });
    logger.info('asr start', { id, lang, resource: config.resource });
    const ok = await relay.start({ lang });
    if (!ok) {
      // relay 自己已经发过具体的 error（config / auth / network / timeout）；
      // 这里只兜底一个「没收到任何事件」的极端情况，不覆盖更准确的错误码。
      if (!finalSent) logger.warn('asr start failed', { id });
    }
  }

  function handleStop() {
    if (stopRequested) return;
    stopRequested = true;
    clearFinalTimer();
    const r = relay;
    if (!r) {
      sendFinal('', { reason: 'stop-empty' });
      finishSoon(80);
      return;
    }
    logger.info('asr stop', { id, audioBytes: audio.bytes, chunks: audio.chunks });
    r.stop();
    // 火山有时最后一帧回得很慢：最多等 finalGraceMs；到点用「最后一句可见文本」flush。
    // （以前这里直接 send final 并立刻关连接，最后一包经常丢 —— 客户端现在会一直等到这一包。）
    finalTimer = setTimeout(() => {
      finalTimer = null;
      sendFinal(String(r.lastText || ''), { reason: 'stop-flush' });
      finishSoon(60);
    }, finalGraceMs);
    finalTimer.unref?.();
  }

  function handleControl(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      send({ type: 'error', code: 'bad-request', message: 'invalid JSON' });
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      send({ type: 'error', code: 'bad-request', message: 'missing type' });
      return;
    }
    if (msg.type === 'start') {
      handleStart(msg).catch((err) => {
        logger.error('start failed', { id, code: (err && err.code) || 'unknown' });
        send({ type: 'error', code: 'network', message: 'start failed' });
      });
      return;
    }
    if (msg.type === 'stop') { handleStop(); return; }
    send({ type: 'error', code: 'bad-request', message: `unknown type ${msg.type}` });
  }

  const assembler = createMessageAssembler(({ opcode, payload }) => {
    if (opcode === OPCODES.TEXT) {
      handleControl(payload.toString('utf8'));
      return;
    }
    if (opcode !== OPCODES.BINARY) return;
    if (!relay || stopRequested) return;
    const now = Date.now();
    if (!audio.firstAt) audio.firstAt = now;
    audio.lastAt = now;
    audio.bytes += payload.length;
    audio.chunks += 1;
    relay.audio(payload);
    // 每 10 帧（≈1 秒）打一次：正常是 3200 字节/帧、≈32000 B/s。
    // 一句日志就能看出「帧很多但每帧太小」还是「采集没跟上」。
    if (audio.chunks % 10 === 0) {
      const span = Math.max(1, audio.lastAt - audio.firstAt);
      logger.info('audio', {
        id,
        chunks: audio.chunks,
        bytes: audio.bytes,
        bytesPerChunk: Math.round(audio.bytes / audio.chunks),
        bytesPerSec: Math.round((audio.bytes * 1000) / span),
      });
    }
  }, { maxBytes: MAX_CLIENT_MESSAGE });

  socket.setNoDelay?.(true);
  socket.on('data', (chunk) => {
    let frames;
    try {
      frames = wsParser.push(chunk);
    } catch (err) {
      logger.warn('bad websocket frame', { id, code: (err && err.code) || 'ws' });
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === OPCODES.PING) {
        try { socket.write(encodeFrame({ opcode: OPCODES.PONG, payload: frame.payload })); } catch { /* ignore */ }
        continue;
      }
      if (frame.opcode === OPCODES.CLOSE) { closeClient(); return; }
      try {
        assembler.push(frame);
      } catch (err) {
        logger.warn('bad client message', { id, code: (err && err.code) || 'ws' });
        send({ type: 'error', code: 'bad-request', message: 'message too large' });
        closeClient();
        return;
      }
    }
  });
  socket.on('error', () => { /* 'close' 会跟着来 */ });
  socket.on('close', () => {
    if (closed) return;
    closed = true;
    clearFinalTimer();
    const segments = relay ? relay.segments : 0;
    teardownRelay();
    logger.info('client disconnected', {
      id, audioBytes: audio.bytes, chunks: audio.chunks, segments,
    });
  });

  return { close: closeClient };
}

/**
 * 读 `coach.env` 并算出火山配置（预览服务器 / 独立代理 / 探针共用这一份，不各抄一套）。
 *
 * **只读文件，不打印值**：返回的 `config` 里有 key，调用方只能拿它去连火山 /
 * 交给 `maskSecret()` 打印「配了几位」。
 *
 * @param {object} [opts]
 * @param {string} [opts.envPath] 显式文件路径；默认 `COACH_ENV` 或 `<项目根>/coach.env`
 * @param {object} [opts.env]     进程环境（测试注入用）
 * @returns {{ config: object, envPath: string, loaded: {ok:boolean, env:object, error:string} }}
 */
export function loadAsrConfig({ envPath = '', env = process.env } = {}) {
  const file = envPath || String(env.COACH_ENV || '') || path.join(ROOT, 'coach.env');
  const loaded = loadEnvFile(file);
  const merged = { ...env, ...(loaded.ok ? loaded.env : {}) };
  return { config: volcConfigFrom(merged), envPath: file, loaded };
}

/** 缺凭证时回给浏览器的错误文案：**只出现字段名**，绝不出现值 */
function configErrorMessage(config) {
  const missing = (config && config.missing) || ['VOLC_APP_ID', 'VOLC_API_KEY'];
  return `coach.env is missing ${missing.join(', ')}`;
}

/**
 * 处理一次 `/asr` 的 WebSocket 升级。
 *
 * 预览服务器（`preview-server.js`）与独立代理（`node server/coach-proxy.mjs`）
 * **共用这一份**，不复制粘贴 —— 两边行为必须完全一致，否则「并入以后」和
 * 「单独跑代理」排障结论会不一样。
 *
 * 凭证缺失（`coach.env` 不存在 / 缺字段）时**不崩、也不默默拒绝**：
 *   ① 先把 WS 握手做完（直接拒握手的话浏览器只报 "WebSocket connection failed"，
 *      用户根本看不出是缺 key）；
 *   ② 发一条 `{"type":"error","code":"config",…}`（前端据此回退 Web Speech 并给出原因）；
 *   ③ 发关闭帧 `4401`，然后断开；
 *   ④ 打一条**脱敏**日志（只有字段名 / 文件名，没有值）。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} [head] Node 在 upgrade 事件里给的「已读到但还没解」的字节
 * @param {object} [opts] `{ config, logger, envPath }`
 * @returns {boolean} 是否把连接交给了火山会话
 */
export function handleAsrUpgrade(req, socket, head, {
  config, logger = createLogger(), envPath = '',
  relayFactory = createVolcSession,
  finalGraceMs = FINAL_GRACE_MS,
} = {}) {
  const log = logger || createLogger();

  if (!isUpgradeRequest(req)) {
    try { socket.write(rejectResponse(400, 'not a websocket upgrade')); } catch { /* ignore */ }
    try { socket.destroy(); } catch { /* ignore */ }
    return false;
  }

  if (!config || !config.configured) {
    try {
      socket.write(handshakeResponse(computeAccept(req.headers['sec-websocket-key'])));
      socket.write(encodeFrame({
        opcode: OPCODES.TEXT,
        payload: JSON.stringify({ type: 'error', code: 'config', message: configErrorMessage(config) }),
      }));
      socket.write(closeFrame(CLOSE_CODE_CONFIG, 'config-missing'));
    } catch { /* 对端已经走了 */ }
    try { socket.end(); } catch { /* ignore */ }
    log.warn('asr upgrade rejected: config missing', {
      missing: (config && config.missing) || ['VOLC_APP_ID', 'VOLC_API_KEY'],
      file: path.basename(String(envPath || 'coach.env')),
    });
    return false;
  }

  try {
    socket.write(handshakeResponse(computeAccept(req.headers['sec-websocket-key'])));
  } catch {
    try { socket.destroy(); } catch { /* ignore */ }
    return false;
  }
  attachClient(socket, { config, logger: log, envPath, head, relayFactory, finalGraceMs });
  return true;
}

/**
 * 造一个 `server.on('upgrade', …)` 处理器：路径是 `/asr` 就交给 `handleAsrUpgrade()`，
 * 其它路径按 `unknown` 处理：
 *   - `'destroy'`（默认）：直接销毁 —— 预览服务器用它，不留悬空连接；
 *   - `'reject'`：先回 404 再销毁 —— 独立代理用它，排障时能看到「路径写错了」。
 *
 * @param {object} [opts] `{ config, logger, envPath, unknown }`
 * @returns {(req: object, socket: object, head?: Buffer) => void}
 */
export function createAsrUpgradeHandler({
  config,
  logger = createLogger(),
  envPath = '',
  unknown = 'destroy',
  relayFactory = createVolcSession,
  finalGraceMs = FINAL_GRACE_MS,
} = {}) {
  return (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url || '/', `http://${BIND_HOST}`).pathname; } catch { /* ignore */ }
    if (pathname !== ASR_PATH) {
      if (unknown === 'reject') {
        try { socket.write(rejectResponse(404, 'not found')); } catch { /* ignore */ }
      }
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    handleAsrUpgrade(req, socket, head, { config, logger, envPath, relayFactory, finalGraceMs });
  };
}

/**
 * 创建代理 HTTP 服务（不 listen，便于测试 / 复用）。
 * @param {object} opts
 * @param {object} opts.config  volcConfigFrom() 的结果
 * @param {object} [opts.logger]
 * @param {string} [opts.envPath]
 */
export function createCoachProxy({ config, logger = createLogger(), envPath = '' } = {}) {
  const startedAt = Date.now();
  const server = http.createServer((req, res) => {
    const pathname = String((req.url || '').split('?')[0]);
    if (req.method === 'GET' && (pathname === '/health' || pathname === '/')) {
      const endpoint = (() => {
        try { return new URL(config.endpoint || VOLC_DEFAULTS.endpoint).host; } catch { return ''; }
      })();
      const body = {
        ok: true,
        service: 'motion-fitness coach proxy',
        asr: `ws://${BIND_HOST}:${server.address()?.port || DEFAULT_PORT}${ASR_PATH}`,
        configured: !!config.configured,
        missing: config.missing || [],
        resource: config.resource || VOLC_DEFAULTS.resource,
        endpointHost: endpoint,
        uptimeMs: Date.now() - startedAt,
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('coach-proxy: only /asr (WebSocket) and /health are available');
  });

  server.on('upgrade', createAsrUpgradeHandler({ config, logger, envPath, unknown: 'reject' }));

  return server;
}

/* ================================================================== *
 * CLI
 * ================================================================== */

function isMain() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]).toLowerCase() === HERE.toLowerCase();
}

export function main() {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  // 读凭证的逻辑与 preview-server 共用同一份（loadAsrConfig），这里只是自己 listen
  const { config, envPath, loaded } = loadAsrConfig();

  const logFile = process.env.COACH_LOG
    ? path.join(os.tmpdir(), 'mfg-coach-proxy.log')
    : '';
  const logger = createLogger({ file: logFile });

  if (!loaded.ok) {
    logger.warn('coach.env not found or unreadable; proxy still runs, /asr will answer error config', {
      file: path.basename(envPath),
      reason: loaded.error,
    });
  }
  logger.info('config', {
    appId: maskSecret(config.appId),
    apiKey: maskSecret(config.apiKey),
    resource: config.resource,
    endpoint: (() => {
      try { return new URL(config.endpoint).host; } catch { return '(bad)'; }
    })(),
    authStyle: config.authStyle,
    configured: config.configured,
    missing: config.missing,
  });

  const server = createCoachProxy({ config, logger, envPath });
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      logger.error('port already in use', { port });
      process.exitCode = 1;
      return;
    }
    logger.error('server error', { code: (err && err.code) || 'unknown' });
    process.exitCode = 1;
  });
  server.listen(port, BIND_HOST, () => {
    // 只打印地址 / 是否配置好，不打印任何凭证
    logger.info('listening', { url: `ws://${BIND_HOST}:${port}${ASR_PATH}`, health: `http://${BIND_HOST}:${port}/health` });
    if (logFile) logger.info('log file', { file: logFile });
  });
  return server;
}

if (isMain()) main();
