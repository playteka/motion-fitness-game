/**
 * `npm run asr:probe` —— 火山流式 ASR 连通性探针（**用户在本机跑**）。
 *
 * 用途：不打开游戏、不需要麦克风，只验证三件事：
 *   1. `coach.env` 读得到、三个字段齐全（只打印「配了、几个字符」，绝不打印值）；
 *   2. 带着 APP ID / API Key / Resource 头能跟火山完成 WSS 握手（101）；
 *   3. 开始帧 + 一段合成 PCM + 最后一包能拿到服务端响应（错误帧会打印错误码）。
 *
 * 沙箱 / 无外网环境里这个脚本会快速失败并打印 `network` / `timeout`，这是预期结果；
 * 真机上跑通应以 `✓` 结尾。所有输出都经过脱敏（`sanitizeDetail` + 显式 secret 列表）。
 *
 * 用法：
 *   npm run asr:probe
 *   npm run asr:probe -- --env D:\path\to\coach.env --seconds 1.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile, maskSecret, volcConfigFrom } from './env.mjs';
import { createVolcSession, openVolcSocket } from './volc-asr.mjs';
import { AUDIO_FORMAT, sanitizeDetail } from './volc-protocol.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 合成一段 16k / 16bit / 单声道 PCM（低音量正弦；只为打通链路，不指望识别出字） */
export function syntheticPcm(seconds = 1.0, { freq = 440, amp = 0.05, rate = AUDIO_FORMAT.rate } = {}) {
  const n = Math.max(1, Math.round(seconds * rate));
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    const v = Math.max(-1, Math.min(1, amp * Math.sin((2 * Math.PI * freq * i) / rate)));
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

function parseArgs(argv) {
  const out = { env: '', seconds: 1.0, lang: 'zh-CN', resource: '', endpoint: '', authStyle: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === '--env' || a === '-e') && argv[i + 1]) out.env = argv[++i];
    else if (a === '--seconds' && argv[i + 1]) out.seconds = Math.max(0.2, Math.min(10, Number(argv[++i]) || 1));
    else if (a === '--lang' && argv[i + 1]) out.lang = String(argv[++i]);
    // 诊断用：不改 coach.env 也能临时换资源 / 端点 / 鉴权头风格，逐个排除 401 / 403
    else if (a === '--resource' && argv[i + 1]) out.resource = String(argv[++i]);
    else if (a === '--endpoint' && argv[i + 1]) out.endpoint = String(argv[++i]);
    else if (a === '--auth-style' && argv[i + 1]) out.authStyle = String(argv[++i]);
  }
  return out;
}

/** 只打印「哪些头存在」+ 服务端日志 id；**头值里可能含凭证，一律不打印** */
function describeHandshake(headers = {}) {
  const keys = Object.keys(headers || {});
  const names = keys.filter((k) => /^x-(api|tt)-/i.test(k)).sort();
  return {
    headerNames: names,
    logId: headers['x-tt-logid'] || headers['X-Tt-Logid'] || '',
  };
}

/**
 * 跑一次探针。
 * @returns {Promise<{code:number, connected:boolean, responses:number, error:string}>}
 */
export async function runProbe({
  envPath, seconds = 1.0, lang = 'zh-CN', log = console.log,
  resource = '', endpoint = '', authStyle = '',
} = {}) {
  const file = envPath || path.join(ROOT, 'coach.env');
  const loaded = loadEnvFile(file);
  const merged = { ...process.env, ...(loaded.ok ? loaded.env : {}) };
  const config = volcConfigFrom(merged);
  if (resource) config.resource = String(resource);
  if (endpoint) config.endpoint = String(endpoint);
  if (authStyle) config.authStyle = String(authStyle);

  log(`[asr:probe] coach.env: ${loaded.ok ? 'loaded' : `not readable (${loaded.error})`}`);
  log(`[asr:probe]   VOLC_APP_ID      : ${maskSecret(config.appId)}`);
  log(`[asr:probe]   VOLC_API_KEY     : ${maskSecret(config.apiKey)}`);
  log(`[asr:probe]   VOLC_ASR_RESOURCE: ${config.resource}`);
  log(`[asr:probe]   endpoint         : ${config.endpoint}`);
  log(`[asr:probe]   auth style       : ${config.authStyle}`);

  if (!config.configured) {
    log(`[asr:probe] ✗ missing: ${config.missing.join(', ')}`);
    log('[asr:probe]   把字段名补进 coach.env（值只留在本机文件里，不要贴到聊天 / 提交里）');
    return { code: 1, connected: false, responses: 0, error: `missing ${config.missing.join(', ')}` };
  }

  let handshake = null;
  let responses = 0;
  let finalText = '';
  let errorCode = '';
  let errorMessage = '';
  let done = null;
  const finished = new Promise((resolve) => { done = resolve; });

  const session = createVolcSession({
    config,
    openSocket: (args) => openVolcSocket(args).then((handle) => {
      handshake = handle.headers || {};
      return handle;
    }),
    onEvent: (event) => {
      if (!event || !event.type) return;
      responses += 1;
      if (event.type === 'ready') {
        log('[asr:probe] ✓ handshake ok（开始帧已发出）');
        const info = describeHandshake(handshake || {});
        if (info.logId) log(`[asr:probe]   server log id: ${info.logId}`);
        if (info.headerNames.length) log(`[asr:probe]   response headers: ${info.headerNames.join(', ')}`);
        return;
      }
      if (event.type === 'partial') {
        if (event.text) log(`[asr:probe] · partial: ${event.text}`);
        return;
      }
      if (event.type === 'final') {
        finalText = String(event.text || '');
        log(`[asr:probe] ✓ final (${finalText.length} chars)${finalText ? `: ${finalText}` : '（合成音没有字，正常）'}`);
        done({ ok: true });
        return;
      }
      if (event.type === 'error') {
        errorCode = String(event.code || 'error');
        errorMessage = sanitizeDetail(event.message || '', [config.appId, config.apiKey]);
        log(`[asr:probe] ✗ error: code=${errorCode}${event.volcCode ? ` volcCode=${event.volcCode}` : ''} ${errorMessage}`);
        done({ ok: false });
        return;
      }
      if (event.type === 'closed') {
        log(`[asr:probe] · upstream closed (${event.code || ''}`
          + `${event.closeCode ? ` / ws=${event.closeCode}` : ''}`
          + `${event.reason ? ` / ${event.reason}` : ''}) frames=${session.frames}`);
        // 只有「收到过 partial / final」才算真的通了；握手 101 但立刻被关不算
        done({ ok: session.gotFinal || session.segments > 0 });
      }
    },
  });

  const started = await session.start({ lang });
  if (!started) {
    session.close();
    log('[asr:probe] ✗ 建连失败：见上面的 error 行');
    log('[asr:probe]   排障顺序：① 本机能上外网吗 ② coach.env 的 APP ID / Key 是否被重置过');
    log('[asr:probe]            ③ 资源 ID 与控制台开通的计费方式是否一致 ④ 代理是否只绑 127.0.0.1');
    return {
      code: errorCode === 'auth' ? 4 : 3,
      connected: false,
      responses,
      error: errorCode || 'connect failed',
    };
  }

  // 分 100ms 一包送进去（贴近真实链路；只跑一小段，不按真实时间等）
  const pcm = syntheticPcm(seconds);
  const chunk = AUDIO_FORMAT.rate * 2 / 10;   // 100ms = 3200 字节
  for (let offset = 0; offset < pcm.length; offset += chunk) {
    session.audio(pcm.subarray(offset, Math.min(pcm.length, offset + chunk)));
    await sleep(25);
  }
  session.stop();

  const timeout = sleep(15000).then(() => ({ ok: false, timeout: true }));
  const result = await Promise.race([finished, timeout]);
  session.close();

  if (result && result.timeout) {
    log('[asr:probe] ✗ 15 秒内没有任何响应（可能是网络被拦 / 端口被封 / 资源未开通）');
    return { code: 2, connected: true, responses, error: 'timeout' };
  }
  if (result && result.ok) {
    log('[asr:probe] ✓ 连通性检查通过');
    return { code: 0, connected: true, responses, error: '' };
  }
  log(`[asr:probe] ✗ 失败：${errorCode || 'upstream-closed'} ${errorMessage}`.trim());
  if (!errorCode && session.frames === 0) {
    log('[asr:probe]   握手成功但上游一帧都没回：通常是资源 ID / 端点和这个 Key 开通的产品不一致，');
    log('[asr:probe]   或开始帧参数（endpoint / result_type / 音频格式）不被该产品接受。');
  }
  if (errorCode === 'auth') {
    log('[asr:probe]   鉴权失败：确认 VOLC_APP_ID / VOLC_API_KEY 属于同一个应用，且资源 ID 与开通的计费方式一致');
  } else if (errorCode === 'network') {
    log('[asr:probe]   网络失败：先在浏览器里能打开 https://www.volcengine.com 再试');
  }
  return { code: errorCode === 'auth' ? 4 : 3, connected: true, responses, error: errorCode || 'failed' };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === HERE.toLowerCase();

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  runProbe({
    envPath: process.env.COACH_ENV || args.env || '',
    seconds: args.seconds,
    lang: args.lang,
    resource: args.resource,
    endpoint: args.endpoint,
    authStyle: args.authStyle,
  })
    .then((result) => {
      process.exitCode = result.code;
      if (result.code === 0) {
        console.log('[asr:probe] 下一步：node server/coach-proxy.mjs，然后浏览器按 Ctrl+I');
      }
    })
    .catch((err) => {
      console.error(`[asr:probe] ✗ unexpected: ${sanitizeDetail(err && err.message)}`);
      process.exitCode = 1;
    });
}
