/**
 * 火山引擎「流式语音识别 2.0」（豆包语音 → 语音识别大模型 → 大模型流式语音识别）的
 * **协议层**：全部是纯函数 / 纯编解码，不碰网络、不碰文件，Node 里直接可测。
 *
 * 参考：<https://www.volcengine.com/docs/6561/1354869>（SAUC v3，二进制 WebSocket）
 *
 * 二进制帧（整数一律大端）：
 *
 *     +--------+--------+--------+--------+
 *     | byte 0 | byte 1 | byte 2 | byte 3 |   4 字节头
 *     +--------+--------+--------+--------+
 *      版本/头长  类型/标志  序列化/压缩  保留
 *
 *     - byte0 高 4 位 = 协议版本（1），低 4 位 = 头长度（1 = 4 字节）
 *     - byte1 高 4 位 = 消息类型，低 4 位 = message-specific flags
 *     - byte2 高 4 位 = 序列化方式（0 = 原始字节，1 = JSON）
 *            低 4 位 = 压缩方式（0 = 不压缩，1 = gzip）
 *
 *     普通帧：header + payload_size(uint32) + payload
 *     带序号的帧：header + sequence(int32) + payload_size(uint32) + payload
 *     错误帧：header + error_code(uint32) + error_message_size(uint32) + error_message(UTF-8)
 *
 * flags：0b0000 无序号 / 0b0001 正序号 / 0b0010 最后一包（无序号）/
 *        0b0011 最后一包（负序号）。所以 `(flags & 0b0010) !== 0` 就是「最后一包」。
 */

import zlib from 'node:zlib';

import { redactSecrets } from './env.mjs';

/* ================================================================== *
 * 常量
 * ================================================================== */

export const HEADER_SIZE = 4;
export const PROTOCOL_VERSION = 0b0001;
export const HEADER_SIZE_CODE = 0b0001;

export const MESSAGE_TYPES = Object.freeze({
  FULL_CLIENT_REQUEST: 0b0001,
  AUDIO_ONLY: 0b0010,
  FULL_SERVER_RESPONSE: 0b1001,
  ERROR: 0b1111,
});

export const FLAGS = Object.freeze({
  NONE: 0b0000,
  POSITIVE_SEQUENCE: 0b0001,
  LAST: 0b0010,
  LAST_NEGATIVE_SEQUENCE: 0b0011,
});

export const SERIALIZATION = Object.freeze({ NONE: 0b0000, JSON: 0b0001 });
export const COMPRESSION = Object.freeze({ NONE: 0b0000, GZIP: 0b0001 });

/** 默认端点（流式）与资源。端点 / 资源都可由 coach.env 覆盖。 */
export const VOLC_DEFAULTS = Object.freeze({
  endpoint: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
  // 流式语音识别 2.0 = volc.seedasr.sauc.duration；1.0 是 volc.bigasr.sauc.duration
  // （以控制台实际开通的那一档为准；probe 的 403 会直接告诉你哪个没开通）
  resource: 'volc.seedasr.sauc.duration',
  connectTimeoutMs: 12000,
  idleTimeoutMs: 20000,
});

/** 音频参数：浏览器端降采样之后就是这一组 */
export const AUDIO_FORMAT = Object.freeze({
  format: 'pcm',
  rate: 16000,
  bits: 16,
  channel: 1,
});

/**
 * 健身场景热词（用户点名要的词）：动作名 + 指标名 + 常用口令。
 * 走 `request.corpus.context`（官方文档里的直连热词，双向流式上限 100 token）。
 */
export const HOTWORDS = Object.freeze([
  '\u6df1\u8e72',              // 深蹲
  '\u4fef\u5367\u6491',        // 俯卧撑
  '\u8dea\u59ff\u4fef\u5367\u6491', // 跪姿俯卧撑
  '\u5e73\u677f\u652f\u6491',  // 平板支撑
  '\u7bad\u6b65\u8e72',        // 箭步蹲
  '\u4f53\u524d\u5c48',        // 体前屈
  '\u9acb\u89d2',              // 髋角
  '\u819d\u89d2',              // 膝角
  '\u6682\u505c',              // 暂停
  '\u7ee7\u7eed',              // 继续
  '\u9000\u51fa',              // 退出
  '\u5f00\u59cb',              // 开始
  '\u76ee\u6807',              // 目标
  '\u79d2',                    // 秒
  '\u6b21',                    // 次
]);

/** 火山错误码 → 代理对外错误码（前端只认这一层，界面文案按它选） */
export const VOLC_ERROR_CODES = Object.freeze({
  20000000: 'ok',
  45000001: 'bad-request',
  45000002: 'empty-audio',
  45000081: 'timeout',
  45000151: 'audio-format',
  55000031: 'server-busy',
});

/**
 * 火山错误码 → 稳定错误码。
 * 5.5 亿段是服务端内部错误，统一算 `upstream`。
 */
export function volcErrorCode(code) {
  const n = Number(code);
  if (VOLC_ERROR_CODES[n]) return VOLC_ERROR_CODES[n];
  if (Number.isFinite(n) && n >= 55000000) return 'upstream';
  return 'upstream';
}

/* ================================================================== *
 * 组帧 / 解帧
 * ================================================================== */

function header({ messageType, flags, serialization, compression }) {
  const h = Buffer.alloc(HEADER_SIZE);
  h[0] = (PROTOCOL_VERSION << 4) | HEADER_SIZE_CODE;
  h[1] = ((messageType & 0x0f) << 4) | (flags & 0x0f);
  h[2] = ((serialization & 0x0f) << 4) | (compression & 0x0f);
  h[3] = 0;
  return h;
}

/** flags 带序号（0b0001 / 0b0011）时，序号紧跟在 4 字节头后面 */
export function hasSequence(flags) {
  return flags === FLAGS.POSITIVE_SEQUENCE || flags === FLAGS.LAST_NEGATIVE_SEQUENCE;
}

/** 是不是「最后一包」（0b0010 / 0b0011） */
export function isLastFlags(flags) {
  return (Number(flags) & FLAGS.LAST) !== 0;
}

/**
 * 组一帧。
 * @param {object} opts
 * @param {number} opts.messageType
 * @param {number} [opts.flags]
 * @param {number} [opts.serialization]
 * @param {number} [opts.compression]
 * @param {Buffer|Uint8Array|string} [opts.payload]
 * @param {number|null} [opts.sequence]
 * @returns {Buffer}
 */
export function buildFrame({
  messageType,
  flags = FLAGS.NONE,
  serialization = SERIALIZATION.NONE,
  compression = COMPRESSION.NONE,
  payload = Buffer.alloc(0),
  sequence = null,
} = {}) {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : (payload || new Uint8Array(0)));
  const parts = [header({ messageType, flags, serialization, compression })];
  if (hasSequence(flags)) {
    const seq = Buffer.alloc(4);
    seq.writeInt32BE(Number.isFinite(Number(sequence)) ? Number(sequence) : -1, 0);
    parts.push(seq);
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  parts.push(size, body);
  return Buffer.concat(parts);
}

/**
 * 解一帧。数据不完整时返回 `null`（等下一块）；结构非法时抛 `code:'protocol'`。
 * @param {Buffer} buffer
 */
export function parseFrame(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length < HEADER_SIZE) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const b2 = buf[2];
  const version = (b0 >> 4) & 0x0f;
  const headerSize = (b0 & 0x0f) * 4;
  const messageType = (b1 >> 4) & 0x0f;
  const flags = b1 & 0x0f;
  const serialization = (b2 >> 4) & 0x0f;
  const compression = b2 & 0x0f;
  if (version !== PROTOCOL_VERSION) {
    throw Object.assign(new Error(`unexpected protocol version ${version}`), { code: 'protocol' });
  }
  if (headerSize !== HEADER_SIZE || buf.length < headerSize) {
    throw Object.assign(new Error(`unexpected header size ${headerSize}`), { code: 'protocol' });
  }

  // 错误帧：header + error_code + error_message_size + error_message
  if (messageType === MESSAGE_TYPES.ERROR) {
    if (buf.length < HEADER_SIZE + 4) return null;
    const errorCode = buf.readUInt32BE(HEADER_SIZE);
    if (buf.length < HEADER_SIZE + 8) return null;
    const messageSize = buf.readUInt32BE(HEADER_SIZE + 4);
    const start = HEADER_SIZE + 8;
    if (buf.length < start + messageSize) return null;
    const message = buf.subarray(start, start + messageSize).toString('utf8');
    return {
      kind: 'error',
      messageType,
      flags,
      serialization,
      compression,
      errorCode,
      message,
      payload: Buffer.alloc(0),
      consumed: start + messageSize,
    };
  }

  let offset = HEADER_SIZE;
  let sequence = null;
  if (hasSequence(flags)) {
    if (buf.length < offset + 4) return null;
    sequence = buf.readInt32BE(offset);
    offset += 4;
  }
  if (buf.length < offset + 4) return null;
  const size = buf.readUInt32BE(offset);
  offset += 4;
  if (buf.length < offset + size) return null;
  const payload = buf.subarray(offset, offset + size);
  return {
    kind: 'frame',
    messageType,
    flags,
    serialization,
    compression,
    sequence,
    payload,
    size,
    consumed: offset + size,
  };
}

/** 流式解帧器（火山服务端一个 data 块里可能有多帧 / 半帧） */
export function createFrameParser() {
  let rest = Buffer.alloc(0);
  return {
    push(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
      rest = rest.length ? Buffer.concat([rest, data]) : data;
      const out = [];
      for (;;) {
        const frame = parseFrame(rest);
        if (!frame) break;
        rest = rest.subarray(frame.consumed);
        out.push(frame);
      }
      return out;
    },
    get pending() { return rest.length; },
  };
}

/**
 * 按头里的压缩标志解压 payload（gzip）。
 * @param {object} frame parseFrame 的结果
 * @param {object} [opts]
 */
export function inflateFramePayload(frame, { gunzip = zlib.gunzipSync } = {}) {
  const payload = (frame && frame.payload) || Buffer.alloc(0);
  if (!frame || frame.compression !== COMPRESSION.GZIP) return payload;
  try {
    return gunzip(payload);
  } catch (err) {
    throw Object.assign(new Error(`gzip decode failed: ${err && err.message}`), { code: 'protocol' });
  }
}

/* ================================================================== *
 * 请求体：开始帧 + 音频帧
 * ================================================================== */

/** corpus.context 里的直连热词（官方要求是 JSON **字符串**） */
export function hotwordContext(hotwords = HOTWORDS) {
  return JSON.stringify({ hotwords: hotwords.map((word) => ({ word: String(word) })) });
}

/**
 * 开始请求（full client request）的 JSON 体。
 * 只放协议参数；**凭证只在 HTTP 头里**，永远不进请求体 / 不进日志。
 *
 * @param {object} [opts]
 * @param {string} [opts.lang]   zh-CN / en-US
 * @param {string[]} [opts.hotwords]
 * @param {string} [opts.uid]
 */
export function buildStartPayload({ lang = 'zh-CN', hotwords = HOTWORDS, uid = 'motion-fitness-game' } = {}) {
  return {
    user: { uid: String(uid) },
    audio: {
      format: AUDIO_FORMAT.format,
      rate: AUDIO_FORMAT.rate,
      bits: AUDIO_FORMAT.bits,
      channel: AUDIO_FORMAT.channel,
      language: String(lang || 'zh-CN'),
    },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_nonstream: false,
      show_utterances: true,
      // full = 每次返回「到目前为止的完整文本」，直接当 partial 上屏最稳
      result_type: 'full',
      // 短口令也要尽快定稿：800ms 静音就断句，最少 1s 音频
      end_window_size: 800,
      force_to_speech_time: 1000,
      corpus: { context: hotwordContext(hotwords) },
    },
  };
}

/** gzip + JSON 的开始帧（带正序号：官方 demo 与线上服务都按这个解析） */
export function buildStartFrame({ lang, hotwords, uid, gzip = zlib.gzipSync } = {}) {
  const payload = gzip(Buffer.from(JSON.stringify(buildStartPayload({ lang, hotwords, uid })), 'utf8'));
  return buildFrame({
    messageType: MESSAGE_TYPES.FULL_CLIENT_REQUEST,
    flags: FLAGS.POSITIVE_SEQUENCE,
    serialization: SERIALIZATION.JSON,
    compression: COMPRESSION.GZIP,
    sequence: 1,
    payload,
  });
}

/** 一包音频（默认 gzip；最后一包用 flags=LAST） */
export function buildAudioFrame(chunk, { last = false, gzip = zlib.gzipSync } = {}) {
  const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || new Uint8Array(0));
  return buildFrame({
    messageType: MESSAGE_TYPES.AUDIO_ONLY,
    flags: last ? FLAGS.LAST : FLAGS.NONE,
    serialization: SERIALIZATION.NONE,
    compression: COMPRESSION.GZIP,
    payload: gzip(raw),
  });
}

/* ================================================================== *
 * 响应解析
 * ================================================================== */

/**
 * 一句 utterance 的稳定标识（用于「同一段文本只发一次 final」）。
 *
 * 火山的 `utterances[]` 一般带 `start_time` / `end_time`（有的版本带 `segment_id`）。
 * 优先用 segment_id，其次 start_time，最后退到数组下标；**再拼上文本**，
 * 这样同一段文字重复回来（上游每个响应都把已定稿句子重发一遍）只算一段。
 */
function segmentKey(utterance, index) {
  const u = utterance || {};
  const raw = u.segment_id ?? u.segmentId ?? u.start_time ?? u.startTime ?? null;
  const id = raw === null || raw === undefined || raw === '' ? `#${index}` : String(raw);
  return `${id}:${typeof u.text === 'string' ? u.text : ''}`;
}

/**
 * 解析响应 JSON 的文本与定稿标志。
 *
 *   {"result":{"text":"…","utterances":[{"text":"…","definite":true}]}}
 *
 * `result.text` 是完整文本；没有 `text` 时退回把 utterances 拼起来。
 *
 * 关键：`result.text` 是**累计**文本，`utterances[].definite` 表示「这一句已经定稿」。
 * 上游每次响应都会把之前定稿的句子再带一遍 —— 所以只有 `segments`（每段的稳定 key + 文本）
 * 才能判断「这次有没有新的定稿」，不能只看 `text` 变没变。
 *
 * @returns {{text: string, definite: boolean, utterances: Array,
 *   segments: Array<{key:string,text:string}>, pending: string}}
 */
export function parseResultJson(json) {
  const result = json && typeof json === 'object' ? (json.result || json) : {};
  let text = '';
  if (result && typeof result.text === 'string') text = result.text;
  const utterances = Array.isArray(result && result.utterances) ? result.utterances : [];
  if (!text && utterances.length) {
    text = utterances.map((u) => (u && typeof u.text === 'string' ? u.text : '')).join('');
  }
  const segments = [];
  const pendingParts = [];
  utterances.forEach((u, i) => {
    const part = u && typeof u.text === 'string' ? u.text : '';
    if (!part) return;
    if (u.definite === true) segments.push({ key: segmentKey(u, i), text: part });
    else pendingParts.push(part);
  });
  const definite = segments.length > 0;
  // 没有 utterances（有的响应只给 result.text）时，pending 就是整段文本
  const pending = utterances.length ? pendingParts.join('') : text;
  return { text: String(text || ''), definite, utterances, segments, pending };
}

/**
 * 把一帧服务端响应变成给浏览器的事件（纯函数，不碰网络）。
 *
 *   全服务端响应 → { type:'partial'|'final', text, pending, segments, isLast, sequence }
 *   错误帧       → { type:'error', code, volcCode, message }
 *   其它（如 ack）→ null
 *
 * `type:'final'` 只表示「这一帧里有定稿信息」；到底要不要真的发给浏览器，由
 * `createTranscriptReducer()` 按 **segment key + 文本** 去重后决定（见下）。
 */
export function parseResponseFrame(frame, { secrets = [] } = {}) {
  if (!frame) return null;
  if (frame.kind === 'error') {
    return {
      type: 'error',
      code: volcErrorCode(frame.errorCode),
      volcCode: Number(frame.errorCode),
      message: sanitizeDetail(frame.message || '', secrets),
    };
  }
  if (frame.messageType !== MESSAGE_TYPES.FULL_SERVER_RESPONSE) return null;
  let json;
  try {
    json = JSON.parse(inflateFramePayload(frame).toString('utf8'));
  } catch (err) {
    return {
      type: 'error',
      code: 'protocol',
      volcCode: 0,
      message: sanitizeDetail(`bad response: ${err && err.message}`, secrets),
    };
  }
  const parsed = parseResultJson(json);
  const isLast = isLastFlags(frame.flags);
  const final = isLast || parsed.definite;
  return {
    type: final ? 'final' : 'partial',
    text: parsed.text,
    pending: parsed.pending,
    definite: parsed.definite,
    segments: parsed.segments,
    isLast,
    sequence: frame.sequence,
  };
}

/** 同一段文本在这个窗口内不重复发（final / partial 各算各的） */
export const FINAL_THROTTLE_MS = 300;

/**
 * 把「上游响应事件」变成「发给浏览器的事件」的**有状态**归约器（纯逻辑，Node 可测）。
 *
 * 为什么需要它：用户日志里同一句 4 个字的结果被当成 `final` 连续发了几百次
 * （`segments:1291`）—— 因为火山的 `result.text` 是累计文本、`utterances` 里
 * 之前定稿的句子每次都重发；只看 `text` 或只看 `definite` 都会把同一句反复当 final。
 *
 * 规则：
 *   1. **final 去重**：按 `segment_id/start_time + text`（没有就退到 text）记住已发过的段，
 *      同一段只发一次；`flags` 的最后一包（isLast）没有新段时**不再**把累计全文重发一遍。
 *   2. **partial 只发「正在说的那部分」**：优先用非 definite utterances 拼出的 `pending`，
 *      没有 utterances 时才用 `text`；文本没变就不发（上游每个音频包都可能回一次相同文本）。
 *   3. **节流**：同一文本 300ms 内不重复发（`FINAL_THROTTLE_MS`）；不同文本立即发。
 *   4. `error` 事件原样透传（错误不能节流 / 去重）。
 *
 * @param {object} [opts]
 * @param {number} [opts.throttleMs] 同一文本的节流窗口（默认 300ms）
 * @param {Function} [opts.now]      时钟（测试注入）
 */
export function createTranscriptReducer({ throttleMs = FINAL_THROTTLE_MS, now = Date.now } = {}) {
  const finalKeys = new Set();
  const emittedAt = new Map();   // `${type}\u0000${text}` → 上次发送时间
  let lastPartialText = '';
  let lastFinalText = '';
  /** 已经发出去的累计文本（用来识别「最后一包把全文又重发一遍」） */
  let sentTranscript = '';
  let emptyFinalSent = false;
  const stats = {
    partials: 0, finals: 0, skippedPartials: 0, skippedFinals: 0,
  };

  function clock() {
    const n = Number(now());
    return Number.isFinite(n) ? n : 0;
  }

  /** 比较累计文本时忽略空白 / 标点差异（火山的 result.text 与 utterances 拼接不总是逐字相同） */
  const normText = (s) => String(s || '').replace(/[\s\p{P}]/gu, '');
  /** 把 tail 里「已经发过的前缀」去掉，只留新内容（按去掉空白 / 标点后的长度对齐） */
  function tailAfterPrefix(prefix, tail) {
    const want = normText(prefix).length;
    if (!want) return tail;
    let matched = 0;
    let i = 0;
    for (; i < tail.length && matched < want; i += 1) {
      if (normText(tail[i])) matched += 1;
    }
    return tail.slice(i).replace(/^[\s\p{P}]+/u, '');
  }

  function throttled(type, text, at) {
    const key = `${type}\u0000${text}`;
    const prev = emittedAt.get(key);
    if (prev !== undefined && at - prev < throttleMs) return true;
    emittedAt.set(key, at);
    if (emittedAt.size > 256) {
      // 只留最近一分钟的键，别让长会话把 Map 撑大
      for (const [k, t] of emittedAt) if (at - t > 60000) emittedAt.delete(k);
    }
    return false;
  }

  /** 把「正在说的那部分」发成 partial（文本没变 / 300ms 内重复 → 不发） */
  function emitPartial(raw, at, out) {
    const text = String(raw == null ? '' : raw);
    if (!text) {
      if (lastPartialText) lastPartialText = '';
      return false;
    }
    if (text === lastPartialText) {
      stats.skippedPartials += 1;
      return false;
    }
    if (throttled('partial', text, at)) {
      stats.skippedPartials += 1;
      return false;
    }
    lastPartialText = text;
    stats.partials += 1;
    out.push({ type: 'partial', text, definite: false });
    return true;
  }

  function push(event) {
    if (!event || !event.type) return [];
    if (event.type === 'error') return [event];
    const at = clock();
    const out = [];

    if (event.type === 'final') {
      const segs = Array.isArray(event.segments) ? event.segments : [];
      const fresh = [];
      for (const seg of segs) {
        const text = String((seg && seg.text) || '');
        if (!text) continue;
        const key = String((seg && (seg.key ?? seg.id)) ?? text);
        if (finalKeys.has(key)) continue;
        finalKeys.add(key);
        fresh.push({ key, text });
      }
      let text = fresh.map((s) => s.text).join('');
      let fromLast = false;
      if (!text && event.isLast && segs.length === 0) {
        // 没有 utterances 的最后一包：用还没发过的全文收尾（累计文本已经发过就不再重发）
        const tail = String(event.text || event.pending || '');
        if (tail && normText(tail) === normText(sentTranscript)) {
          // 上游把已定稿的全文又重发了一遍 —— 吃掉
        } else if (tail && sentTranscript && normText(tail).startsWith(normText(sentTranscript))) {
          text = tailAfterPrefix(sentTranscript, tail);
          fromLast = true;
        } else if (tail && tail !== lastFinalText) {
          text = tail;
          fromLast = true;
        }
      }
      const emptyTail = !text && event.isLast && !lastFinalText
        && finalKeys.size === 0 && !emptyFinalSent && segs.length === 0
        && !String(event.text || event.pending || '');
      if (text || fresh.length > 0 || emptyTail) {
        if (emptyTail) emptyFinalSent = true;
        if (throttled('final', text, at)) {
          stats.skippedFinals += 1;
        } else {
          lastFinalText = text;
          lastPartialText = '';
          sentTranscript += text;
          stats.finals += 1;
          out.push({
            type: 'final',
            text,
            definite: true,
            segment: fresh.length === 1 ? fresh[0].key : undefined,
            fromLast,
          });
        }
      } else {
        // 全是已经发过的段（或没有文本的定稿帧）：不再刷屏
        stats.skippedFinals += 1;
      }
      // 同一帧里可能已经带着「正在说的下一句」：把 pending 也发出去，
      // 否则第一句定稿之后 partial 就永远不出来了（客户端只靠 partial 上屏）。
      // 没有 utterances 的帧（pending 退化成累计全文）不发，避免把整段又当 partial 刷一遍。
      if (segs.length > 0 && event.pending !== undefined) emitPartial(event.pending, at, out);
      return out;
    }

    // partial：优先用「正在说的那部分」（非 definite utterances）；没有这个字段才退回全文
    emitPartial(event.pending !== undefined ? event.pending : event.text, at, out);
    return out;
  }

  return {
    push,
    stats,
    get lastFinalText() { return lastFinalText; },
    get lastPartialText() { return lastPartialText; },
    get finals() { return stats.finals; },
    get partials() { return stats.partials; },
    reset() {
      finalKeys.clear();
      emittedAt.clear();
      lastPartialText = '';
      lastFinalText = '';
      sentTranscript = '';
      emptyFinalSent = false;
      stats.partials = 0;
      stats.finals = 0;
      stats.skippedPartials = 0;
      stats.skippedFinals = 0;
    },
  };
}

/* ================================================================== *
 * 鉴权头 / 脱敏
 * ================================================================== */

/**
 * 火山握手头。
 *
 * 新旧控制台两套鉴权都可能在用，`style` 决定发哪套：
 *   - `app-key`：`X-Api-App-Key`（APP ID）+ `X-Api-Access-Key`（API Key）—— 老控制台
 *   - `api-key`：`X-Api-Key`（API Key）—— 新控制台 / 2.0 文档
 *   - `auto`   ：两套都发（默认；多余的头会被忽略，兼容性优先）
 *
 * 产品头（`X-Api-Resource-Id` / `X-Api-Request-Id` / `X-Api-Connect-Id`）总是发。
 * **这些值只在握手头里出现，绝不进日志 / 请求体 / 返回给浏览器的 JSON。**
 */
export function buildAuthHeaders({
  appId = '',
  apiKey = '',
  resource = VOLC_DEFAULTS.resource,
  requestId = '',
  connectId = '',
  style = 'auto',
} = {}) {
  const headers = {
    'X-Api-Resource-Id': String(resource),
    'X-Api-Request-Id': String(requestId),
    'X-Api-Sequence': '-1',
  };
  if (connectId) headers['X-Api-Connect-Id'] = String(connectId);
  const mode = String(style || 'auto');
  if (mode === 'api-key' || mode === 'auto') {
    headers['X-Api-Key'] = String(apiKey);
  }
  if (mode === 'app-key' || mode === 'auto') {
    headers['X-Api-App-Key'] = String(appId);
    headers['X-Api-Access-Key'] = String(apiKey);
  }
  return headers;
}

/** 头名白名单：日志 / 探针里只允许出现这些名字，值一律不出现 */
export const AUTH_HEADER_NAMES = Object.freeze([
  'X-Api-Key',
  'X-Api-App-Key',
  'X-Api-Access-Key',
  'X-Api-Resource-Id',
  'X-Api-Request-Id',
  'X-Api-Connect-Id',
  'X-Api-Sequence',
]);

/**
 * 错误信息脱敏：服务器 / 操作系统把凭证回显到 message 里时，先抹掉再往外传。
 * 只保留「哪一类错误」，不保留任何 token。
 */
export function sanitizeDetail(text, secrets = []) {
  let out = redactSecrets(text, secrets);
  out = out.replace(/(x-api-[a-z-]+)\s*[:=]\s*\S+/gi, '$1: ***');
  out = out.replace(/(bearer\s+)\S+/gi, '$1***');
  out = out.replace(/((?:api[_-]?key|access[_-]?key|secret|token)\s*[:=]\s*)\S+/gi, '$1***');
  return out.slice(0, 300);
}
