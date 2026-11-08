/**
 * 最小 WebSocket 实现（零依赖，只做够用的一件事）。
 *
 * 支撑 `server/coach-proxy.mjs` 的两个方向：
 *   - **服务端**：浏览器 → 代理的帧是**掩码**的文本 / 二进制帧；
 *   - **客户端**：代理 → 火山的帧是**不掩码**的帧（我们发出去的要掩码）。
 *
 * 只实现：
 *   - 握手：`Sec-WebSocket-Accept` 的 SHA-1 计算；
 *   - 分帧：文本（0x1）/ 二进制（0x2）/ 关闭（0x8）/ ping（0x9）/ pong（0xA）；
 *   - 长度编码（7 / 16 / 64 位）、掩码、分片重组；
 *   - 不做扩展（permessage-deflate / RSV 位）、不做子协议协商。
 *
 * 所有编解码都是**纯函数**，测试里直接拿着 Buffer 对拍（不联网、不起服务）。
 */

import crypto from 'node:crypto';

/** RFC 6455 的固定 GUID */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODES = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

export const WS_LIMITS = Object.freeze({
  /** 单条消息上限（16k PCM 一帧几 KB，16MB 已经是上限里的上限） */
  maxMessageBytes: 16 * 1024 * 1024,
});

/** 握手：客户端 `Sec-WebSocket-Key` → 服务端 `Sec-WebSocket-Accept`（RFC 6455 §1.3） */
export function computeAccept(key) {
  return crypto.createHash('sha1').update(String(key || '') + WS_GUID).digest('base64');
}

/** 这个 HTTP 请求是不是一个合法的 WebSocket Upgrade？ */
export function isUpgradeRequest(req) {
  if (!req || !req.headers) return false;
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const connection = String(req.headers.connection || '').toLowerCase();
  return upgrade === 'websocket'
    && connection.split(/\s*,\s*/).includes('upgrade')
    && !!req.headers['sec-websocket-key'];
}

/** 101 响应头（CRLF 结尾，直接 socket.write） */
export function handshakeResponse(accept) {
  return 'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n`
    + '\r\n';
}

/** 拒绝 Upgrade 的 HTTP 响应（握手阶段出错时用，不抛异常） */
export function rejectResponse(status, text) {
  const body = String(text || '');
  return `HTTP/1.1 ${status} ${status === 400 ? 'Bad Request' : 'Not Found'}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + '\r\n'
    + body;
}

/**
 * 编一帧。
 *
 * @param {object}   [opts]
 * @param {number}   [opts.opcode]  默认 0x1（文本）
 * @param {Buffer|Uint8Array|string} [opts.payload]
 * @param {boolean}  [opts.fin]     默认 true
 * @param {boolean}  [opts.mask]    默认 false（服务端发帧不掩码；客户端发帧必须掩码）
 * @param {Function} [opts.rng]     返回 4 字节掩码（测试可注入固定值）
 * @returns {Buffer}
 */
export function encodeFrame({
  opcode = OPCODES.TEXT,
  payload = Buffer.alloc(0),
  fin = true,
  mask = false,
  rng = null,
} = {}) {
  const data = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : (payload || new Uint8Array(0)));
  const len = data.length;
  const first = (fin ? 0x80 : 0) | (opcode & 0x0f);
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len <= 0xffff) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = first;
  if (!mask) return Buffer.concat([head, data]);

  head[1] |= 0x80;
  const key = (typeof rng === 'function' ? rng() : crypto.randomBytes(4)).subarray(0, 4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) masked[i] = data[i] ^ key[i % 4];
  return Buffer.concat([head, key, masked]);
}

/**
 * 从一段字节里解出所有**完整**帧，尾部不完整的原样返回。
 *
 * @param {Buffer} buffer
 * @returns {{frames: Array<{fin:boolean, opcode:number, payload:Buffer, masked:boolean}>, rest: Buffer}}
 */
export function decodeFrames(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset];
    const b1 = buf[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = offset + 2;
    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      const big = buf.readBigUInt64BE(p);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw Object.assign(new Error('websocket frame too large'), { code: 'ws-too-large' });
      }
      len = Number(big);
      p += 8;
    }
    let maskKey = null;
    if (masked) {
      if (p + 4 > buf.length) break;
      maskKey = buf.subarray(p, p + 4);
      p += 4;
    }
    if (p + len > buf.length) break;   // 半帧：等下一块
    let payload = Buffer.from(buf.subarray(p, p + len));
    if (masked && maskKey) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    }
    frames.push({ fin, opcode, payload, masked });
    offset = p + len;
  }
  return { frames, rest: buf.subarray(offset) };
}

/**
 * 流式解帧器：`push(chunk)` 返回这一块里解出来的完整帧。
 * socket 的 'data' 事件会随便切块，必须自己攒。
 */
export function createFrameParser() {
  let rest = Buffer.alloc(0);
  return {
    push(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
      rest = rest.length ? Buffer.concat([rest, data]) : data;
      const out = decodeFrames(rest);
      rest = out.rest;
      return out.frames;
    },
    get pending() { return rest.length; },
  };
}

/**
 * 分片重组：把 `fin=false` 的 CONTINUATION 帧拼回一条消息。
 * 控制帧（ping / pong / close）不分片，直接回调，不占用重组缓冲。
 */
export function createMessageAssembler(onMessage, { maxBytes = WS_LIMITS.maxMessageBytes } = {}) {
  let chunks = [];
  let opcode = OPCODES.TEXT;
  let size = 0;
  return {
    push(frame) {
      if (!frame) return;
      if (frame.opcode === OPCODES.PING || frame.opcode === OPCODES.PONG
        || frame.opcode === OPCODES.CLOSE) {
        try { onMessage?.({ opcode: frame.opcode, payload: frame.payload }); } catch { /* ignore */ }
        return;
      }
      if (frame.opcode === OPCODES.CONTINUATION) {
        if (!chunks.length) return;          // 没有起始帧的续帧：忽略
      } else {
        chunks = [];
        size = 0;
        opcode = frame.opcode;
      }
      size += frame.payload.length;
      if (size > maxBytes) {
        chunks = [];
        size = 0;
        throw Object.assign(new Error('websocket message too large'), { code: 'ws-too-large' });
      }
      chunks.push(frame.payload);
      if (!frame.fin) return;
      const payload = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      chunks = [];
      size = 0;
      try { onMessage?.({ opcode, payload }); } catch { /* ignore */ }
    },
    reset() { chunks = []; size = 0; },
  };
}

/** 关闭帧（带状态码；服务端主动结束连接时用） */
export function closeFrame(code = 1000, reason = '') {
  const body = Buffer.from(String(reason || ''), 'utf8');
  const payload = Buffer.alloc(2 + body.length);
  payload.writeUInt16BE(code, 0);
  body.copy(payload, 2);
  return encodeFrame({ opcode: OPCODES.CLOSE, payload });
}
