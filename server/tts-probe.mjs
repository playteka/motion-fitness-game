/**
 * 火山「语音合成」连通性探测 —— 只读 `coach.env`，只打印脱敏结果。
 *
 * 用途：控制台里「资源 ID / 音色 ID」这类值最容易被填错（ASR 就踩过 bigasr vs seedasr ✗），
 * 与其猜，不如让这个脚本把候选组合挨个试一遍，直接告出「哪一组能通」。
 *
 * 用法（在项目根目录）：
 *   node server/tts-probe.mjs
 *   node server/tts-probe.mjs --voice zh_female_xxx          # 指定音色
 *   node server/tts-probe.mjs --resource volc.service_type.10029
 *   node server/tts-probe.mjs --text "髋角 160 到 180 度"     # 换测试文本
 *
 * 安全：只打印 APP ID 长度 / Key 前 4 位，绝不打印完整密钥 ✓；不写任何文件 ✓。
 */
import path from 'node:path';
import { loadEnvFile } from './env.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const loaded = loadEnvFile(process.env.COACH_ENV || path.join(process.cwd(), 'coach.env'));
if (!loaded.ok) {
  console.error('✗ 读不到 coach.env（' + loaded.error + '）—— 在项目根目录跑：node server/tts-probe.mjs');
  process.exit(2);
}
const env = loaded.env;
const appId = env.VOLC_TTS_APP_ID || env.VOLC_APP_ID || '';
const apiKey = env.VOLC_TTS_API_KEY || env.VOLC_API_KEY || '';
const voice = arg('voice', env.VOLC_TTS_VOICE || '');
const text = arg('text', '髋角 160 到 180 度，请开始深蹲');

if (!appId || !apiKey) {
  console.error('✗ coach.env 里没有 APP ID / API Key（VOLC_APP_ID / VOLC_API_KEY）');
  process.exit(2);
}
if (!voice) {
  console.error('✗ 没给音色 ID：请先在控制台「音色列表」里试听并复制 voice_type，然后');
  console.error('   node server/tts-probe.mjs --voice <你的音色ID>');
  process.exit(2);
}

const mask = (s) => (s ? `${s.slice(0, 4)}…(${s.length} 字符)` : '(空)');
const t0 = Date.now();
console.log('APP ID  :', mask(appId));
console.log('API Key :', mask(apiKey));
console.log('音色    :', voice);
console.log('测试文本:', text);
console.log('');

/** 候选资源 ID：TTS 2.0 在不同开通口径下可能叫这些名字之一（探测完以通的那个为准） */
const candidates = arg('resource')
  ? [arg('resource')]
  : [
    'volc.service_type.10029',      // 大模型语音合成（常见）
    'volc.megatts.default',         // 旧版大模型 TTS
    'volc.tts.default',             // 兜底候选
    'volc.seedtts.default',        // 2.0 系命名（与 seedasr 同族）
  ];

/** v1 的老接口（Bearer token 风格） */
async function tryV1(resource) {
  const body = {
    app: { appid: appId, token: apiKey, cluster: resource },
    user: { uid: 'mfg-probe' },
    audio: { voice_type: voice, encoding: 'mp3' },
    request: { reqid: `probe-${Date.now()}`, text, operation: 'query' },
  };
  const res = await fetch('https://openspeech.bytedance.com/api/v1/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer;${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const raw = await res.text();
  return { kind: 'v1', status: res.status, ok: res.ok, msg: raw.slice(0, 220) };
}

/** v3 的新接口（X-Api-Key 头，和 ASR 2.0 同一套鉴权风格） */
async function tryV3(resource) {
  const res = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Id': appId,
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resource,
      'X-Api-Request-Id': `probe-${Date.now()}`,
    },
    body: JSON.stringify({
      user: { uid: 'mfg-probe' },
      req_params: {
        text,
        speaker: voice,
        audio_params: { format: 'mp3', sample_rate: 24000 },
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  // v3 的响应是二进制（含音频帧）或 JSON 错误；只要状态码能区分「鉴权/资源对不对」就够
  const head = buf.slice(0, 200).toString('utf8').replace(/[^\x20-\x7E\u4e00-\u9fff]/g, '.');
  return { kind: 'v3', status: res.status, ok: res.ok, msg: head, bytes: buf.length };
}

let worked = [];
for (const resource of candidates) {
  for (const fn of [tryV3, tryV1]) {
    try {
      const r = await fn(resource);
      const tag = r.ok ? '✓ 可用' : '✗ 失败';
      console.log(
        `${tag}  [${r.kind}] resource=${resource}  → HTTP ${r.status}`
          + (r.bytes ? `  ${r.bytes} 字节` : '')
          + `\n         ${r.msg.replace(/\s+/g, ' ')}`,
      );
      if (r.ok) worked.push({ resource, kind: r.kind });
    } catch (err) {
      console.log(`✗ 异常  [${fn.name}] resource=${resource}  → ${String(err && err.message).slice(0, 160)}`);
    }
  }
}

console.log('');
console.log(`耗时 ${Date.now() - t0} ms`);
if (worked.length) {
  const best = worked[0];
  console.log('✅ 能通的一组：');
  console.log(`   VOLC_TTS_RESOURCE=${best.resource}`);
  console.log(`   （鉴权风格：${best.kind}）`);
  console.log('   把上面这行填进 coach.env 即可；音色仍是：' + voice);
} else {
  console.log('✗ 所有候选都不通。可能原因：');
  console.log('   1) 音色 ID 不对（控制台「音色列表」里复制 voice_type）');
  console.log('   2) 资源 ID 不对（控制台「语音合成 2.0」开通页/资源页里看）');
  console.log('   3) TTS 还没真正开通 / 用的不是同一个应用');
  console.log('   → 把这整段输出发我，我按返回码判断');
  process.exitCode = 1;
}
