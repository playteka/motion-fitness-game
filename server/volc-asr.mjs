/**
 * 火山流式 ASR 的**会话层**：建立 WSS 连接、发开始帧 / 音频帧、把响应变成事件。
 *
 * 这里把「协议」和「传输」分开：
 *   - 组帧 / 解帧 / 响应解析全在 `volc-protocol.mjs`（纯函数，测试直接对拍 Buffer）；
 *   - 本文件只负责 socket 生命周期，`openSocket` 可注入 ——
 *     测试用假 socket 跑完整条链路，**不需要联网、不需要真 Key**。
 *
 * 对外的错误码（浏览器只认这一层，绝不带凭证）：
 *   auth       握手被 401 / 403 拒绝（APP ID / API Key / 资源不匹配）
 *   network    连不上 / DNS / TLS / 连接被重置
 *   timeout    连接超时、或开始后长时间没有任何响应
 *   upstream   火山返回错误帧（错误码另放在 volcCode）
 *   protocol   收到解不动的帧
 *   config     coach.env 缺字段（代理启动时就知道）
 */

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import { encodeFrame, createMessageAssembler, createFrameParser as createWsFrameParser, OPCODES } from './ws-mini.mjs';
import {
  VOLC_DEFAULTS,
  buildAuthHeaders,
  buildStartFrame,
  buildAudioFrame,
  createFrameParser as createVolcFrameParser,
  parseResponseFrame,
  sanitizeDetail,
} from './volc-protocol.mjs';

/** 把底层 socket / TLS 错误压成稳定错误码 */
export function networkErrorCode(err) {
  const code = String((err && err.code) || '');
  const message = String((err && err.message) || '');
  if (/ETIMEDOUT|TIMEOUT/i.test(code) || /timed?\s*out|timeout/i.test(message)) return 'timeout';
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EPIPE|EHOSTUNREACH|ENETUNREACH|ECONNABORTED)$/.test(code)) {
    return 'network';
  }
  if (/CERT|TLS|SSL|SELF_SIGNED/i.test(code) || /certificate|tls|ssl/i.test(message)) return 'network';
  return 'network';
}

function fail(code, message) {
  return Object.assign(new Error(String(message || code)), { code });
}

/** 客户端帧必须掩码（RFC 6455），关闭帧也一样 */
function maskedCloseFrame(code = 1000) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return encodeFrame({ opcode: OPCODES.CLOSE, payload, mask: true });
}

/**
 * 把一帧**火山应用层**的字节包成客户端 WebSocket 二进制帧（带掩码）。
 *
 * 这一步不能省：直接 `socket.write(volcFrame)` 会把 4 字节协议头当成 WS 帧头，
 * 服务端解析错位后会用 1002 / “unexpected reserved bits” 把连接关掉。
 * 单独导出也是为了单测能钉住它。
 */
export function encodeClientMessage(payload) {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload || new Uint8Array(0));
  return encodeFrame({ opcode: OPCODES.BINARY, payload: body, mask: true });
}

/**
 * 打开到火山的 WSS 连接（带自定义头 —— 浏览器 / 内置 WebSocket 都做不到这点，
 * 所以这里直接拿 `https.request` 走 Upgrade）。返回一个很小的句柄。
 *
 * @returns {Promise<{headers:object, send:Function, close:Function, destroy:Function,
 *   onFrame:Function, onClose:Function, onError:Function}>}
 */
export function openVolcSocket({ url, headers = {}, timeoutMs = VOLC_DEFAULTS.connectTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(String(url || '')); } catch { reject(fail('config', 'bad endpoint url')); return; }
    const mod = u.protocol === 'wss:' ? https : (u.protocol === 'ws:' ? http : null);
    if (!mod) { reject(fail('config', `unsupported protocol ${u.protocol}`)); return; }

    const key = crypto.randomBytes(16).toString('base64');
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* ignore */ }
      reject(fail('timeout', 'connect timeout'));
    }, Math.max(1000, Number(timeoutMs) || VOLC_DEFAULTS.connectTimeoutMs));

    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'wss:' ? 443 : 80),
      path: `${u.pathname}${u.search || ''}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...headers,
      },
    });

    req.on('upgrade', (res, socket, head) => {
      if (settled) { try { socket.destroy(); } catch { /* ignore */ } return; }
      settled = true;
      clearTimeout(timer);

      const wsParser = createWsFrameParser();
      const volcParser = createVolcFrameParser();
      const frameHandlers = [];
      const closeHandlers = [];
      const errorHandlers = [];
      let closed = false;

      const emitFrame = (frame) => {
        for (const fn of frameHandlers) { try { fn(frame); } catch { /* ignore */ } }
      };
      const emitClose = (info = null) => {
        if (closed) return;
        closed = true;
        for (const fn of closeHandlers) { try { fn(info || {}); } catch { /* ignore */ } }
      };
      const emitError = (err) => {
        for (const fn of errorHandlers) { try { fn(err); } catch { /* ignore */ } }
      };
      const assembler = createMessageAssembler(({ opcode, payload }) => {
        // 火山只发二进制帧；文本帧留给未来（例如状态），先忽略
        if (opcode !== OPCODES.BINARY) return;
        for (const frame of volcParser.push(payload)) emitFrame(frame);
      });

      socket.on('data', (chunk) => {
        let wsFrames;
        try { wsFrames = wsParser.push(chunk); } catch (err) { emitError(err); return; }
        for (const f of wsFrames) {
          if (f.opcode === OPCODES.PING) {
            try { socket.write(encodeFrame({ opcode: OPCODES.PONG, payload: f.payload, mask: true })); } catch { /* ignore */ }
            continue;
          }
          if (f.opcode === OPCODES.CLOSE) {
            let code = 0;
            let reason = '';
            try {
              if (f.payload.length >= 2) code = f.payload.readUInt16BE(0);
              if (f.payload.length > 2) reason = f.payload.subarray(2).toString('utf8');
            } catch { /* ignore */ }
            emitClose({ code, reason });
            try { socket.end(); } catch { /* ignore */ }
            continue;
          }
          try { assembler.push(f); } catch (err) { emitError(err); }
        }
      });
      socket.on('close', () => emitClose());
      socket.on('error', (err) => { emitError(err); emitClose(); });
      if (head && head.length) {
        try {
          for (const f of wsParser.push(head)) assembler.push(f);
        } catch { /* ignore */ }
      }

      resolve({
        headers: (res && res.headers) || {},
        send(buf) {
          if (closed || socket.destroyed) return false;
          try {
            // 必须再包一层 WebSocket 二进制帧（客户端帧还要掩码），否则服务端解析错位
            socket.write(encodeClientMessage(buf));
            return true;
          } catch { return false; }
        },
        close(code = 1000) {
          if (!socket.destroyed) {
            try { socket.write(maskedCloseFrame(code)); } catch { /* ignore */ }
            try { socket.end(); } catch { /* ignore */ }
          }
        },
        destroy() { try { socket.destroy(); } catch { /* ignore */ } },
        onFrame(fn) { if (typeof fn === 'function') frameHandlers.push(fn); },
        onClose(fn) { if (typeof fn === 'function') closeHandlers.push(fn); },
        onError(fn) { if (typeof fn === 'function') errorHandlers.push(fn); },
      });
    });

    req.on('response', (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const status = Number(res.statusCode) || 0;
      // 401 / 403：APP ID / API Key / 资源不匹配；404：端点写错
      const code = status === 401 || status === 403 || status === 404
        ? 'auth'
        : (status >= 500 ? 'upstream' : 'network');
      // 把响应体（通常是 JSON / 纯文本的原因）带出来，探针才能说清「为什么被拒」。
      // 只收前 500 字节，且之后会过 sanitizeDetail（不会回显凭证）。
      let detail = '';
      try { res.setEncoding('utf8'); } catch { /* ignore */ }
      res.on('data', (chunk) => {
        if (detail.length < 500) detail += String(chunk);
      });
      res.on('end', () => {
        reject(fail(code, `HTTP ${status}${detail ? `: ${detail.slice(0, 400)}` : ''}`));
      });
      res.on('error', () => {
        reject(fail(code, `HTTP ${status}`));
      });
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(fail(networkErrorCode(err), err && err.message));
    });
    req.end();
  });
}

/**
 * 一次识别会话。
 *
 *   start({lang})   建连 + 发开始帧（成功时先发 `ready` 事件）
 *   audio(pcmBuf)    转发一包 16k / 16bit / 单声道 PCM
 *   stop()           发最后一包（flags=LAST），等服务端定稿
 *   close()          立刻断开（浏览器关了 / 代理进程退出）
 *
 * @param {object} opts
 * @param {object} opts.config        {appId, apiKey, resource, endpoint, authStyle, missing}
 * @param {Function} opts.onEvent     {type:'ready'|'partial'|'final'|'error'|'closed', ...}
 * @param {Function} [opts.openSocket] 可注入的连接函数（测试用假 socket）
 */
export function createVolcSession({
  config = {},
  onEvent = () => {},
  openSocket = openVolcSocket,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  idleTimeoutMs = VOLC_DEFAULTS.idleTimeoutMs,
} = {}) {
  const secrets = [config.appId, config.apiKey].filter((s) => s && String(s).length >= 3);
  const safe = (text) => sanitizeDetail(text, secrets);

  let socket = null;
  let started = false;
  let stopped = false;
  let closed = false;
  let idleTimer = null;
  let bytes = 0;
  let segments = 0;
  let frames = 0;
  let lastText = '';
  let gotFinal = false;

  const emit = (event) => {
    try { onEvent(event); } catch { /* 订阅者出错不影响链路 */ }
  };

  function clearIdle() {
    if (idleTimer !== null) {
      try { clearTimer(idleTimer); } catch { /* ignore */ }
      idleTimer = null;
    }
  }

  /** 一段时间没有任何响应就明确报错（不把界面吊在「正在聆听」） */
  function armIdle() {
    clearIdle();
    if (!(idleTimeoutMs > 0) || closed) return;
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (closed) return;
      emit({ type: 'error', code: 'timeout', message: 'no response from upstream' });
      close();
    }, idleTimeoutMs);
  }

  async function start({ lang = 'zh-CN' } = {}) {
    if (started || closed) return false;
    started = true;
    if (config.missing && config.missing.length) {
      emit({
        type: 'error',
        code: 'config',
        message: `coach.env is missing ${config.missing.join(', ')}`,
      });
      return false;
    }
    const headers = buildAuthHeaders({
      appId: config.appId,
      apiKey: config.apiKey,
      resource: config.resource || VOLC_DEFAULTS.resource,
      requestId: crypto.randomUUID(),
      connectId: crypto.randomUUID(),
      style: config.authStyle || 'auto',
    });

    let sock;
    try {
      sock = await openSocket({
        url: config.endpoint || VOLC_DEFAULTS.endpoint,
        headers,
        timeoutMs: config.connectTimeoutMs || VOLC_DEFAULTS.connectTimeoutMs,
      });
    } catch (err) {
      closed = true;
      const rawCode = String((err && err.code) || '');
      const code = ['auth', 'config', 'timeout', 'network', 'upstream'].includes(rawCode)
        ? rawCode
        : networkErrorCode(err);
      emit({
        type: 'error',
        code,
        message: safe((err && err.message) || 'connect failed'),
      });
      return false;
    }
    if (stopped) { try { sock.close?.(); } catch { /* ignore */ } return false; }
    socket = sock;

    sock.onFrame?.((frame) => {
      frames += 1;
      const event = parseResponseFrame(frame, { secrets });
      if (!event) return;
      if (event.type === 'error') {
        emit({ ...event, message: safe(event.message) });
        return;
      }
      if (event.text) { lastText = event.text; segments += 1; }
      clearIdle();   // 上游说话了：不再算「连上后一直没响应」
      if (event.type === 'final') { gotFinal = true; }
      emit(event);
    });
    sock.onClose?.((info) => {
      if (closed) return;
      closed = true;
      clearIdle();
      emit({
        type: 'closed',
        code: stopped ? 'stopped' : 'upstream-closed',
        closeCode: (info && info.code) || 0,
        reason: safe((info && info.reason) || ''),
      });
    });
    sock.onError?.((err) => {
      emit({
        type: 'error',
        code: networkErrorCode(err),
        message: safe((err && err.message) || 'socket error'),
      });
    });

    try {
      sock.send(buildStartFrame({ lang: String(lang || 'zh-CN') }));
    } catch (err) {
      emit({ type: 'error', code: 'network', message: safe((err && err.message) || 'send failed') });
      return false;
    }
    emit({ type: 'ready' });
    armIdle();
    return true;
  }

  function audio(chunk) {
    if (closed || stopped || !socket) return false;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || new Uint8Array(0));
    if (!buf.length) return false;
    bytes += buf.length;
    try {
      socket.send(buildAudioFrame(buf));
    } catch (err) {
      emit({ type: 'error', code: 'network', message: safe((err && err.message) || 'send failed') });
      return false;
    }
    // 注意：这里**不**重新起 idle 计时。用户一直说话时我们每 85ms 都在发静音/语音包，
    // 若按「发过包」续命，上游彻底不回也就永远发现不了。20 秒的 idle 只盯「开始后有没有响应」；
    // 之后长时间没识别结果由浏览器端的 8 秒静音提示负责。
    return true;
  }

  /** 最后一包：空 payload + flags=LAST；服务端会回最后一帧（可能带完整文本） */
  function stop() {
    if (closed || stopped || !socket) return false;
    stopped = true;
    clearIdle();
    try {
      socket.send(buildAudioFrame(Buffer.alloc(0), { last: true }));
      return true;
    } catch {
      return false;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    clearIdle();
    const sock = socket;
    socket = null;
    try { sock?.close?.(); } catch { /* ignore */ }
  }

  return {
    start,
    audio,
    stop,
    close,
    get bytes() { return bytes; },
    get segments() { return segments; },
    get frames() { return frames; },
    get lastText() { return lastText; },
    get gotFinal() { return gotFinal; },
    get closed() { return closed; },
    get stopped() { return stopped; },
  };
}
