/**
 * 本机语音代理（P3.1）。
 *
 * 浏览器 ──ws://127.0.0.1:4180/asr──▶ 本进程 ──wss://openspeech.bytedance.com──▶ 火山
 *
 * 为什么要有它：
 *   - 浏览器里的 `webkitSpeechRecognition` 在国内连不上 Google 的识别服务（`error.network`）；
 *   - 火山要求握手头里带 APP ID / API Key —— 浏览器 `WebSocket` **不能自定义头**，
 *     而且凭证绝不能进前端；
 *   - 所以由本机 Node 进程拿着 `coach.env` 里的凭证去连，浏览器只知道 `ws://127.0.0.1:4180/asr`。
 *
 * 安全约束（实现时逐条守住）：
 *   - **只绑 127.0.0.1**（端口默认 4180，可用 `PORT` 覆盖），不接受局域网连接；
 *   - 凭证只从 `coach.env` / 进程环境读，**不打印值**（只打印「配了、几个字符」）；
 *   - 错误信息统一过 `sanitizeDetail()`，防止底层把 Key 回显到浏览器 / 日志里；
 *   - 日志只在内存 / 终端；要写文件请用 `COACH_LOG=1`（写到系统临时目录），**不放仓库**。
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
import { computeAccept, createFrameParser, createMessageAssembler, encodeFrame, handshakeResponse, isUpgradeRequest, OPCODES, rejectResponse } from './ws-mini.mjs';
import { createVolcSession } from './volc-asr.mjs';
import { VOLC_DEFAULTS } from './volc-protocol.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');

/** 监听地址写死回环；不提供 HOST 覆盖（这个代理只服务本机浏览器） */
export const BIND_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4180;
export const ASR_PATH = '/asr';

/** 单条 WebSocket 消息上限（一包 16k PCM 只有几 KB，1MB 已经很宽松） */
const MAX_CLIENT_MESSAGE = 1024 * 1024;
/** 收到 stop 之后最多再等多久让火山把最后一帧吐出来 */
const FINAL_GRACE_MS = 3000;

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
function attachClient(socket, { config, logger, envPath }) {
  const id = shortId();
  const wsParser = createFrameParser();
  const audio = { bytes: 0, chunks: 0 };
  let relay = null;
  let started = false;
  let stopRequested = false;
  let finalSent = false;
  let closing = false;
  let finalTimer = null;
  let closed = false;

  logger.info('client connected', { id });

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

  function closeClient() {
    if (closed) return;
    const segments = relay ? relay.segments : 0;
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
      send({ type: 'partial', text });
      return;
    }
    if (event.type === 'final') {
      finalSent = true;
      clearFinalTimer();
      send({ type: 'final', text: String(event.text || '') });
      logger.info('final', { id, chars: String(event.text || '').length });
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
    relay = createVolcSession({ config, onEvent: onVolcEvent });
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
      send({ type: 'final', text: '' });
      finishSoon(80);
      return;
    }
    logger.info('asr stop', { id, audioBytes: audio.bytes, chunks: audio.chunks });
    r.stop();
    // 火山有时最后一帧回得很慢：最多等 FINAL_GRACE_MS，到点用已经收到的最后一句定稿
    finalTimer = setTimeout(() => {
      finalTimer = null;
      if (!finalSent) {
        finalSent = true;
        send({ type: 'final', text: r.lastText || '' });
      }
      finishSoon(60);
    }, FINAL_GRACE_MS);
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
    audio.bytes += payload.length;
    audio.chunks += 1;
    relay.audio(payload);
    if (audio.chunks % 64 === 0) {
      logger.info('audio', { id, chunks: audio.chunks, bytes: audio.bytes });
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

  server.on('upgrade', (req, socket) => {
    let pathname = '';
    try { pathname = new URL(req.url || '/', `http://${BIND_HOST}`).pathname; } catch { /* ignore */ }
    if (pathname !== ASR_PATH) {
      try { socket.write(rejectResponse(404, 'not found')); socket.destroy(); } catch { /* ignore */ }
      return;
    }
    if (!isUpgradeRequest(req)) {
      try { socket.write(rejectResponse(400, 'not a websocket upgrade')); socket.destroy(); } catch { /* ignore */ }
      return;
    }
    try {
      socket.write(handshakeResponse(computeAccept(req.headers['sec-websocket-key'])));
    } catch {
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    attachClient(socket, { config, logger, envPath });
  });

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
  const envPath = process.env.COACH_ENV || path.join(ROOT, 'coach.env');
  const loaded = loadEnvFile(envPath);
  const merged = { ...process.env, ...(loaded.ok ? loaded.env : {}) };
  const config = volcConfigFrom(merged);

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
