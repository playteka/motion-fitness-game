/**
 * AI 语音教练（P3.0 基座）的第一套独立测试：**不需要浏览器、不需要真麦克风**。
 *
 * 覆盖两件事：
 *   1) `src/voice/session.js` 的状态机：
 *        off → start() → listening → onUserText() → thinking → onCoachText() → speaking
 *        →（TTS 结束）→ listening；stop() 从任意状态回 off；错误态进入 / 退出；
 *        pause() / resume()、speak:false 的自我介绍、TTS 不可用时只出字幕。
 *   2) `src/voice/providers.js` 的 `mockLlm` 罐头回复：
 *        中英输入都给出非空回复，而且每一条都能在 `src/locales/*.js` 的 `coach.*` 词条里找到。
 *
 * 运行：node tests/test-voice.mjs
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

import { createVoiceSession, VOICE_STATES, VOICE_NOTICE_KEYS, VOICE_ERROR_KEYS } from '../src/voice/session.js';
import {
  parseCommand, cnToInt, normalizeText, isConfirmText, isCancelText,
} from '../src/voice/parse.js';
import {
  COMMANDS, COMMAND_BY_INTENT, COMMAND_CONFIRM_MS, CONFIRM_WORDS, CANCEL_WORDS,
} from '../src/voice/commands.js';
import {
  createLlm, createAsr, createVuMeter, createVolcAsr, createAutoAsr,
  pickAsrRoute, resolveAsrUrl, pickCaptureMode, volcErrorCode,
  DEFAULT_ASR_WS_URL, ASR_ROUTES,
  rmsToLevel, smoothLevel, levelToColor,
  VU_COLORS, VU_LEVEL_VOICE, VU_LEVEL_LOUD,
} from '../src/voice/providers.js';
import {
  createDiag, makeEntry, scrubText, DIAG_ENDPOINT, DIAG_FILE, DIAG_MAX_TEXT,
  DIAG_FLUSH_MS, DIAG_BATCH_SIZE,
} from '../src/voice/diag.js';
import { createSelfTest, SELF_TEST_STEPS } from '../src/voice/selftest.js';
import {
  downsampleToPcm16, pcm16Rms, pcm16Peak, pcmBytesToMs, floatToPcm16,
} from '../src/voice/pcm.js';
import { parseEnv, volcConfigFrom, maskSecret, redactSecrets } from '../server/env.mjs';
import {
  computeAccept, encodeFrame, decodeFrames, createFrameParser as createWsFrameParser,
  createMessageAssembler, OPCODES,
} from '../server/ws-mini.mjs';
import {
  buildFrame, buildStartFrame, buildStartPayload, buildAudioFrame, parseFrame,
  createFrameParser as createVolcFrameParser, parseResponseFrame, buildAuthHeaders,
  volcErrorCode as mapVolcCode, HOTWORDS, MESSAGE_TYPES, FLAGS, SERIALIZATION, COMPRESSION,
  sanitizeDetail,
} from '../server/volc-protocol.mjs';
import { createVolcSession, encodeClientMessage } from '../server/volc-asr.mjs';
import { LOCALES, setLang, t } from '../src/i18n.js';

let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/** 等待 Promise 链（mock LLM 的 Promise.resolve 分支）走完，不依赖真实时间 */
async function tick(n = 5) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

/** 假麦克风：记录 open / close，可模拟权限拒绝 */
function fakeMic({ fail = false } = {}) {
  return {
    fail,
    opened: 0,
    closed: 0,
    async open() {
      this.opened += 1;
      if (this.fail) {
        const err = new Error('permission denied');
        err.name = 'NotAllowedError';
        throw err;
      }
    },
    close() { this.closed += 1; },
  };
}

/** 假 ASR：记录 start / stop，测试里手动 emit 识别结果 */
function fakeAsr({ startResult = true } = {}) {
  const handlers = {};
  return {
    startResult,
    started: 0,
    stopped: 0,
    start() { this.started += 1; return this.startResult; },
    stop() { this.stopped += 1; },
    onResult(fn) { handlers.result = fn; },
    onInterim(fn) { handlers.interim = fn; },
    onError(fn) { handlers.error = fn; },
    onEnd(fn) { handlers.end = fn; },
    onRoute(fn) { handlers.route = fn; },
    emit(text, info = { isFinal: true }) { handlers.result?.(text, info); },
    emitInterim(text) { handlers.interim?.(text); },
    fail(err) { handlers.error?.(err); },
    setRoute(route) { handlers.route?.({ route }); },
  };
}

/** 假 TTS：记录要念的句子；finish() 模拟浏览器念完 */
function fakeTts({ supported = true } = {}) {
  return {
    supported,
    spoken: [],
    cancelled: 0,
    _ends: [],
    speak(text, { onEnd } = {}) {
      this.spoken.push(text);
      this._ends.push(onEnd);
      return this.supported;
    },
    finish(i = this._ends.length - 1) { this._ends[i]?.(); },
    cancel() { this.cancelled += 1; },
  };
}

function makeSession(opts = {}) {
  return createVoiceSession({
    mic: opts.mic || fakeMic(),
    asr: opts.asr || fakeAsr(),
    llm: opts.llm || createLlm({ pick: () => 0 }),
    tts: opts.tts || fakeTts(),
    thinkDelay: 0,
    ...opts,
  });
}

/** 把一份 locale 拍平成 "a.b.c" → 值（只用于「回复必须来自词条」的核对） */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => { out[`${key}.${i}`] = item; });
    else out[key] = v;
  }
  return out;
}
const flat = { zh: flatten(LOCALES.zh), en: flatten(LOCALES.en) };
const localeValues = (lang) => new Set(Object.values(flat[lang]));

/* ================================================================== *
 * 1. 状态机
 * ================================================================== */
console.log('\n[1] 状态机：off → listening → thinking → speaking → listening');
{
  ok('状态集合就是 off / listening / thinking / speaking / error 五个',
    VOICE_STATES.length === 5
    && ['off', 'listening', 'thinking', 'speaking', 'error'].every((s) => VOICE_STATES.includes(s)),
    JSON.stringify(VOICE_STATES));

  const mic = fakeMic();
  const asr = fakeAsr();
  const tts = fakeTts();
  let resolveReply;
  const pending = new Promise((r) => { resolveReply = r; });
  const session = makeSession({ mic, asr, tts, llm: { reply: () => pending } });
  const seen = [];
  session.subscribe((snap) => {
    if (seen[seen.length - 1] !== snap.state) seen.push(snap.state);
  });

  ok('初始状态 off（还没有开麦）', session.snapshot().state === 'off' && session.enabled === false);
  await session.start();
  ok('start() → listening；麦克风 open + ASR start 各一次',
    session.snapshot().state === 'listening' && session.enabled === true
    && mic.opened === 1 && asr.started === 1,
    JSON.stringify({ state: session.snapshot().state, mic: mic.opened, asr: asr.started }));

  session.onUserText('你好');
  ok('onUserText() → thinking，用户字幕先出来',
    session.snapshot().state === 'thinking' && session.snapshot().userText === '你好',
    JSON.stringify(session.snapshot()));
  ok('thinking 期间还没有把任何话交给 TTS', tts.spoken.length === 0, tts.spoken.join(' | '));

  resolveReply({ text: '罐头回复' });
  await tick();
  ok('LLM 回答到达 → onCoachText() → speaking，并调用 TTS',
    session.snapshot().state === 'speaking'
    && session.snapshot().coachText === '罐头回复'
    && tts.spoken.length === 1 && tts.spoken[0] === '罐头回复',
    JSON.stringify({ state: session.snapshot().state, spoken: tts.spoken }));
  ok('字幕两行同时保留（用户那句话 + 教练回复）',
    session.snapshot().userText === '你好' && session.snapshot().coachText === '罐头回复');

  tts.finish();
  ok('TTS 结束 → listening（可以接着问下一句）',
    session.snapshot().state === 'listening' && session.snapshot().coachText === '罐头回复',
    session.snapshot().state);
  ok('状态轨迹完整：listening → thinking → speaking → listening',
    seen.join('>') === 'listening>thinking>speaking>listening', seen.join('>'));

  const snap = session.stop();
  ok('stop() 从 listening 回到 off，并释放麦克风 / 停 ASR / 停 TTS',
    snap.state === 'off' && session.enabled === false
    && mic.closed >= 1 && asr.stopped >= 1 && tts.cancelled >= 1,
    JSON.stringify({ state: snap.state, mic: mic.closed, asr: asr.stopped, tts: tts.cancelled }));
}

console.log('\n[2] stop() 从任意状态都能回 off');
{
  // ② thinking
  {
    const mic = fakeMic();
    const asr = fakeAsr();
    const tts = fakeTts();
    const session = makeSession({ mic, asr, tts, llm: { reply: () => new Promise(() => {}) } });
    await session.start();
    session.onUserText('还在想');
    ok('thinking 时 stop() → off（先停识别 / 释放麦克风）',
      session.snapshot().state === 'thinking'
      && session.stop().state === 'off' && asr.stopped >= 1 && mic.closed >= 1);
  }
  // ③ speaking
  {
    const mic = fakeMic();
    const asr = fakeAsr();
    const tts = fakeTts();
    const session = makeSession({ mic, asr, tts, llm: createLlm({ pick: () => 0 }) });
    await session.start();
    session.onCoachText('正在念的一句');
    ok('speaking 时 stop() → off，且 tts.cancel() 被调用（不留着声音）',
      session.snapshot().state === 'speaking'
      && session.stop().state === 'off' && tts.cancelled >= 1 && mic.closed >= 1,
      JSON.stringify({ state: session.snapshot().state, cancelled: tts.cancelled }));
  }
  // ④ error
  {
    const mic = fakeMic({ fail: true });
    const asr = fakeAsr();
    const session = makeSession({ mic, asr });
    await session.start();
    ok('error 时 stop() → off',
      session.snapshot().state === 'error' && session.stop().state === 'off'
      && session.enabled === false);
  }
  // ⑤ off 时 stop() 不炸
  {
    const session = makeSession();
    ok('本来就是 off 时再 stop() 也不炸（幂等）', session.stop().state === 'off');
  }
}

console.log('\n[3] 错误态：进入与退出');
{
  const mic = fakeMic({ fail: true });
  const asr = fakeAsr();
  const tts = fakeTts();
  const session = makeSession({ mic, asr, tts });
  await session.start();
  ok('麦克风被拒绝 → error（enabled 保持 true，用户「开」的意愿还在）',
    session.snapshot().state === 'error' && session.enabled === true
    && session.error?.code === 'mic');
  ok('麦克风失败时不会去启动 ASR，也把麦克风轨道收掉（绝不留后台录音）',
    asr.started === 0 && mic.closed >= 1, JSON.stringify({ asr: asr.started, mic: mic.closed }));

  mic.fail = false;
  await session.start();
  ok('error 状态下重新 start() → listening（退出错误态）',
    session.snapshot().state === 'listening' && session.error === null && mic.opened >= 2,
    JSON.stringify({ state: session.snapshot().state, opened: mic.opened }));
  session.stop();
  ok('stop() 从 error / listening 都会回到 off', session.snapshot().state === 'off');
}

console.log('\n[4] ASR 不支持 / 适配器报错');
{
  const mic = fakeMic();
  const asr = fakeAsr({ startResult: false });
  const session = makeSession({ mic, asr });
  await session.start();
  ok('ASR.start() 返回 false → error（asr-unsupported），不抛异常',
    session.snapshot().state === 'error'
    && session.snapshot().error?.code === 'asr-unsupported'
    && mic.closed >= 1,
    JSON.stringify({ state: session.snapshot().state, error: session.snapshot().error }));

  // 适配器通过 onError 报错（P3.1 的云端 ASR 也走这条路）
  const mic2 = fakeMic();
  const asr2 = fakeAsr();
  const session2 = makeSession({ mic: mic2, asr: asr2 });
  await session2.start();
  asr2.fail({ code: 'asr', fatal: true, attempts: 3 });
  ok('ASR 适配器回调 onError({ code: "asr" }) → error + 提示可重试',
    session2.snapshot().state === 'error' && session2.snapshot().error?.code === 'asr'
    && mic2.closed >= 1);
  session2.stop();
}

console.log('\n[5] pause() / resume()：页面隐藏暂停聆听，回到前台恢复');
{
  const mic = fakeMic();
  const asr = fakeAsr();
  const tts = fakeTts();
  const session = makeSession({ mic, asr, tts });
  await session.start();
  const startedBefore = asr.started;
  session.pause();
  ok('pause() → 状态仍是 listening 但 paused=true，停掉 ASR（麦克风保持）',
    session.snapshot().state === 'listening' && session.snapshot().paused === true
    && asr.stopped >= 1 && mic.closed === 0,
    JSON.stringify({ state: session.snapshot().state, paused: session.snapshot().paused }));
  ok('暂停时用户说话不会推进状态（不会在后台偷偷对话）',
    session.onUserText('喂') === false && session.snapshot().state === 'listening');
  session.resume();
  ok('resume() → paused=false、重新启动 ASR',
    session.snapshot().paused === false && asr.started > startedBefore,
    JSON.stringify({ paused: session.snapshot().paused, started: asr.started }));
  session.stop();
}

console.log('\n[6] 只上字幕 / 不抢发声 / TTS 不可用');
{
  const mic = fakeMic();
  const asr = fakeAsr();
  const tts = fakeTts();
  const session = makeSession({ mic, asr, tts });
  await session.start();
  const before = tts.spoken.length;
  session.onCoachText('自我介绍只显示', { speak: false });
  ok('onCoachText(..., { speak:false }) 只更新字幕、不调用 TTS，状态保持 listening',
    session.snapshot().state === 'listening'
    && session.snapshot().coachText === '自我介绍只显示'
    && tts.spoken.length === before,
    JSON.stringify({ state: session.snapshot().state, spoken: tts.spoken }));

  const timers = [];
  const silentTts = fakeTts({ supported: false });
  const s2 = createVoiceSession({
    mic: fakeMic(),
    asr: fakeAsr(),
    llm: createLlm({ pick: () => 0 }),
    tts: silentTts,
    thinkDelay: 0,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  await s2.start();
  s2.onCoachText('只出字幕的一句话');
  const speakTimers = timers.filter((x) => x.ms >= 1200 && x.ms <= 6000);
  ok('没有 speechSynthesis：仍然进入 speaking（字幕在），并安排一个展示计时',
    s2.snapshot().state === 'speaking' && speakTimers.length === 1 && speakTimers[0].ms >= 1200,
    JSON.stringify({ state: s2.snapshot().state, timers: timers.map((x) => x.ms) }));
  speakTimers[0].fn();
  ok('展示计时到 → 回到 listening（没有声音也不会卡在 speaking）',
    s2.snapshot().state === 'listening', s2.snapshot().state);
  s2.stop();
}

/* ================================================================== *
 * 7. mock LLM：中英都能答，且每句都能追溯到 locales
 * ================================================================== */
console.log('\n[7] mockLlm：中英罐头回复都能追溯到 coach.* 词条');
{
  setLang('zh', { persist: false });
  const llm = createLlm({ pick: () => 0 });

  const zhGreeting = llm.reply('你好');
  ok('中文问候 → coach.reply.greeting，非空且来自中文词条',
    zhGreeting.key === 'coach.reply.greeting'
    && zhGreeting.text === t('coach.reply.greeting')
    && localeValues('zh').has(zhGreeting.text),
    JSON.stringify(zhGreeting));

  const zhQuestion = llm.reply('这个动作怎么练？');
  ok('中文提问 → coach.reply.question',
    zhQuestion.key === 'coach.reply.question' && localeValues('zh').has(zhQuestion.text),
    JSON.stringify(zhQuestion));

  const zhThanks = llm.reply('谢谢');
  ok('中文道谢 → coach.reply.thanks',
    zhThanks.key === 'coach.reply.thanks' && localeValues('zh').has(zhThanks.text),
    JSON.stringify(zhThanks));

  const zhRandom = llm.reply('继续');
  ok('其它输入 → coach.encourage 里的随机一句（pick 固定时 index=0）',
    zhRandom.key === 'coach.encourage' && zhRandom.index === 0
    && zhRandom.text === LOCALES.zh.coach.encourage[0]
    && localeValues('zh').has(zhRandom.text),
    JSON.stringify(zhRandom));

  const zhEmpty = llm.reply('   ');
  ok('空输入 → coach.reply.fallback（不是空字符串）',
    zhEmpty.key === 'coach.reply.fallback' && zhEmpty.text.trim().length > 0
    && localeValues('zh').has(zhEmpty.text), JSON.stringify(zhEmpty));

  // 英文：语言跟随界面
  setLang('en', { persist: false });
  const enCases = ['hello', 'how should I train?', 'thanks', 'keep going'];
  const keys = [];
  for (const input of enCases) {
    const reply = llm.reply(input);
    keys.push(reply.key);
    ok(`英文输入「${input}」→ 非空回复且来自英文 coach.* 词条（${reply.key}）`,
      typeof reply.text === 'string' && reply.text.trim().length > 0
      && localeValues('en').has(reply.text)
      && !/[\u3400-\u9fff]/.test(reply.text),
      JSON.stringify(reply));
  }
  ok('英文问候 / 提问 / 道谢 / 鼓励四条路径都走到了',
    keys[0] === 'coach.reply.greeting' && keys[1] === 'coach.reply.question'
    && keys[2] === 'coach.reply.thanks' && keys[3] === 'coach.encourage',
    keys.join(','));

  // 同一套输入换回中文，回复也要换回中文
  setLang('zh', { persist: false });
  const zhAgain = llm.reply('hello');
  ok('界面语言切回中文后，同一句英文问候也用中文回复',
    zhAgain.text === t('coach.reply.greeting') && /[\u4e00-\u9fff]/.test(zhAgain.text),
    JSON.stringify(zhAgain));

  // 把所有 coach.* 文案都喂一遍，确认不会出现空回复 / 抛出
  const coachInputs = ['你好', 'hello', '怎么办', 'what', '谢谢', 'thanks', '继续', '', '做一个深蹲'];
  let bad = 0;
  for (const input of coachInputs) {
    try {
      const r = llm.reply(input);
      if (!r || typeof r.text !== 'string' || !r.text.trim()) bad += 1;
    } catch { bad += 1; }
  }
  ok('9 组中英输入全部返回非空回复（没有抛异常 / 空话）', bad === 0, `${bad} 个失败`);
}

/* ================================================================== *
 * 8. ASR 适配器（浏览器 SpeechRecognition 的替身）
 *    用户反馈「我说话没有出现字幕」：这里钉住三条最容易静默失败的路
 *    —— interim 必须立刻上交、错误必须分流、重复 start() 不许抛错。
 * ================================================================== */
console.log('\n[8] ASR 适配器：interim 立即可见 / 错误分流 / 退避重启 / 重复 start() 不抛错');

/** 假的 SpeechRecognition 环境：recs 里的实例由测试手动触发事件 */
function fakeSpeechWindow() {
  const recs = [];
  class FakeRec {
    constructor() {
      this.lang = '';
      this.continuous = false;
      this.interimResults = false;
      this.started = 0;
      this.stopped = 0;
      this.onstart = null;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      recs.push(this);
    }
    start() { this.started += 1; this.onstart?.(); }
    stop() { this.stopped += 1; }
    abort() { this.stopped += 1; }
    result(text, isFinal, resultIndex = 0) {
      const item = [{ transcript: text }];
      item.isFinal = isFinal;
      this.onresult?.({ resultIndex, results: [item] });
    }
    clearResults() { this.onresult?.({ resultIndex: 0, results: [] }); }
    error(name) { this.onerror?.({ error: name }); }
    end() { this.onend?.(); }
  }
  return { win: { SpeechRecognition: FakeRec }, recs };
}

function makeFakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    last() { return timers.filter((x) => !x.cleared).at(-1); },
    run() { const tmr = this.last(); if (tmr) tmr.fn(); return tmr; },
  };
}

{
  const { win, recs } = fakeSpeechWindow();
  const clock = makeFakeTimers();
  const asr = createAsr({ win, lang: 'zh-CN', setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const got = { result: [], interim: [], notice: [], error: [], state: [] };
  asr.onResult((text, info) => got.result.push({ text, info }));
  asr.onInterim((text, info) => got.interim.push({ text, info }));
  asr.onNotice((info) => got.notice.push(info));
  asr.onError((info) => got.error.push(info));
  asr.onState((phase, info) => got.state.push({ phase, info }));

  ok('start() 真的启动识别：lang / continuous / interimResults 都对',
    asr.start() === true && asr.active === true
    && recs[0].lang === 'zh-CN' && recs[0].continuous === true && recs[0].interimResults === true,
    JSON.stringify(asr.supported ? { lang: recs[0]?.lang, continuous: recs[0]?.continuous } : null));
  ok('重复 start() 直接返回 true、不再新建实例（不会 InvalidStateError）',
    asr.start() === true && recs.length === 1);

  recs[0].result('我', false);
  ok('interim 立刻交给 onInterim（此刻还没有 final）',
    got.interim.length === 1 && got.interim[0].text === '我' && got.result.length === 0,
    JSON.stringify({ interim: got.interim, result: got.result }));
  recs[0].result('我在', false);
  ok('interim 逐字更新（「我」→「我在」）',
    got.interim.at(-1).text === '我在' && got.result.length === 0);

  recs[0].result('我在', true);
  ok('final 交给 onResult（isFinal:true），interim 不重复算结果',
    got.result.length === 1 && got.result[0].text === '我在' && got.result[0].info.isFinal === true);

  recs[0].clearResults();
  ok('识别器收回临时结果 → onInterim("", { clear:true })（不留半截字幕）',
    got.interim.at(-1).text === '' && got.interim.at(-1).info.clear === true,
    JSON.stringify(got.interim.at(-1)));

  recs[0].error('network');
  ok('error.network → 非致命 notice（不落 error，继续聆听）',
    got.notice.at(-1).code === 'network' && got.error.length === 0 && asr.active === true,
    JSON.stringify(got.notice));
  recs[0].error('no-speech');
  ok('error.no-speech → notice.no-speech（提示靠近一点，不停止聆听）',
    got.notice.at(-1).code === 'no-speech' && asr.active === true);
  recs[0].error('aborted');
  ok('error.aborted（不是自己 stop 的）→ notice.aborted',
    got.notice.at(-1).code === 'aborted' && asr.active === true);

  recs[0].end();
  ok('第一次 end → 退避 400ms 后自动重启（onState restarting）',
    got.state.at(-1).phase === 'restarting' && got.state.at(-1).info.delay === 400
    && clock.timers.length === 1,
    JSON.stringify(got.state.at(-1)));
  clock.run();
  ok('退避到点 → 新建识别实例并重新 start（不会复用正在关闭的实例）',
    recs.length === 2 && recs[1].started === 1 && asr.active === true);
  asr.stop();
  ok('stop() 之后 active=false，且不会再把 aborted 当异常提示出来',
    asr.active === false && recs[1].stopped >= 1);
}

{
  // 每一种「重试没用」的错误都要有独立错误码（界面才能给出不同处置建议）
  const fatalCases = [
    ['not-allowed', 'mic'],
    ['audio-capture', 'mic-busy'],
    ['service-not-allowed', 'asr-service'],
    ['language-not-supported', 'asr-language'],
    ['unsupported', 'asr-unsupported'],
  ];
  for (const [raw, code] of fatalCases) {
    const { win, recs } = fakeSpeechWindow();
    const asr = createAsr({ win, setTimer: () => 0, clearTimer: () => {} });
    const errors = [];
    asr.onError((info) => errors.push(info));
    asr.start();
    recs[0].error(raw);
    ok(`error.${raw} → 致命错误 ${code}（停手，不再重启）`,
      errors.length === 1 && errors[0].code === code && errors[0].fatal === true
      && errors[0].raw === raw && asr.active === false,
      JSON.stringify(errors));
  }
}

{
  // 连续 3 次「没有任何结果」才停手；interim 也算结果，不能把正在说话的人踢掉
  const { win, recs } = fakeSpeechWindow();
  const clock = makeFakeTimers();
  const asr = createAsr({ win, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const errors = [];
  asr.onError((info) => errors.push(info));
  asr.start();
  recs[0].end();
  const d1 = clock.timers.at(-1).ms;
  clock.run();
  recs[1].end();
  const d2 = clock.timers.at(-1).ms;
  clock.run();
  recs[2].end();
  ok('连续 3 次没有结果 → 停手并报 asr（400ms → 800ms 退避，第 3 次不再重启）',
    errors.length === 1 && errors[0].code === 'asr' && errors[0].fatal === true
    && errors[0].attempts === 3 && asr.active === false && d1 === 400 && d2 === 800,
    JSON.stringify({ errors, d1, d2, recs: recs.length }));

  const { win: win2, recs: recs2 } = fakeSpeechWindow();
  const clock2 = makeFakeTimers();
  const asr2 = createAsr({ win: win2, setTimer: clock2.setTimer, clearTimer: clock2.clearTimer });
  asr2.start();
  recs2[0].end();
  clock2.run();
  recs2[1].result('喂', false);   // 有 interim：证明真的识别出了东西
  recs2[1].end();
  ok('interim 也算「识别出了东西」：失败计数清零，退避回到 400ms（不会被连续模式踢掉）',
    clock2.last() && clock2.last().ms === 400,
    JSON.stringify(clock2.timers.map((x) => x.ms)));
  asr2.stop();
}

{
  // 识别实例自己抛 InvalidStateError：start() 返回 false，绝不把异常抛给会话
  const win = {
    SpeechRecognition: class {
      constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; }
      start() { const err = new Error('already started'); err.name = 'InvalidStateError'; throw err; }
      stop() {}
    },
  };
  const asr = createAsr({ win });
  let threw = false;
  let started = true;
  try { started = asr.start(); } catch { threw = true; }
  ok('识别实例抛出 InvalidStateError → start() 返回 false（调用方落 error，不吞异常到界面）',
    threw === false && started === false && asr.lastError === 'InvalidStateError',
    JSON.stringify({ threw, started, lastError: asr.lastError }));

  const bare = createAsr({ win: {} });
  ok('浏览器没有 SpeechRecognition → start() 返回 false（会话落 asr-unsupported）',
    bare.start() === false && bare.supported === false);
}

{
  // 每一种非致命提示都必须有中英词条（界面才说得出来；i18n 测试另外保证键结构对称）
  const keys = Object.values(VOICE_NOTICE_KEYS);
  const missingZh = keys.filter((k) => typeof flat.zh[k] !== 'string' || !flat.zh[k].trim());
  const missingEn = keys.filter((k) => typeof flat.en[k] !== 'string' || !flat.en[k].trim());
  ok('所有非致命提示（网络 / 没听到 / 8 秒没结果 / 中断 / 未知）都有中英词条',
    keys.length >= 5 && missingZh.length === 0 && missingEn.length === 0,
    JSON.stringify({ keys, missingZh, missingEn }));
}

/* ================================================================== *
 * 9. 音量表：RMS → level → 颜色 / 平滑（纯函数，不需要麦克风）
 * ================================================================== */
console.log('\n[9] 音量表：rmsToLevel / smoothLevel / levelToColor（纯函数）');

/** 生成一段 128 为中点的正弦采样（amp 越大越响） */
function sineBytes(n, amp) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = 128 + Math.round(amp * Math.sin(i / 2));
  return out;
}

{
  ok('静音（全是 128）→ level = 0（灰）',
    rmsToLevel(new Uint8Array(64).fill(128)) === 0 && rmsToLevel([]) === 0);
  const quiet = rmsToLevel(sineBytes(256, 8));
  const normal = rmsToLevel(sineBytes(256, 24));
  const loud = rmsToLevel(sineBytes(256, 100));
  ok('小声 / 正常 / 大声三档 level 依次变大，且都落在 0~1',
    quiet > 0 && normal > quiet && loud > normal && loud <= 1,
    JSON.stringify({ quiet, normal, loud }));

  const steps = [0, 4, 8, 16, 24, 32, 48, 64, 100].map((a) => rmsToLevel(sineBytes(256, a)));
  ok('level 随音量单调不减（9 档线性递增的振幅全部有序）',
    steps.every((v, i) => i === 0 || v >= steps[i - 1]),
    JSON.stringify(steps.map((v) => Number(v.toFixed(3)))));

  ok('同一段采样反复计算结果一致（纯函数）',
    rmsToLevel(sineBytes(256, 24)) === normal);
  ok('静音 / 正常 / 大声 → 三种不同颜色（灰 / 青 / 薄荷亮绿）',
    levelToColor(0) === VU_COLORS.silent && levelToColor(0.3) === VU_COLORS.voice
    && levelToColor(0.9) === VU_COLORS.loud
    && new Set([levelToColor(0), levelToColor(0.3), levelToColor(0.9)]).size === 3,
    JSON.stringify([levelToColor(0), levelToColor(0.3), levelToColor(0.9)]));
  ok('颜色阈值就是导出的 VOICE / LOUD 两个常量（不是另抄一份）',
    levelToColor(VU_LEVEL_VOICE) === VU_COLORS.voice
    && levelToColor(VU_LEVEL_LOUD - 0.01) === VU_COLORS.voice
    && levelToColor(VU_LEVEL_LOUD) === VU_COLORS.loud);
  ok('越界 level 会被夹到 0~1（不会返回 undefined）',
    levelToColor(-3) === VU_COLORS.silent && levelToColor(9) === VU_COLORS.loud);

  ok('平滑：同一帧 dt=0 时保持原值；相同值不动',
    smoothLevel(0.2, 0.9, 0) === 0.2 && Math.abs(smoothLevel(0.5, 0.5, 50) - 0.5) < 1e-9);
  const rise = smoothLevel(0, 1, 50);
  const fall = 1 - smoothLevel(1, 0, 50);
  ok('平滑是「快升慢降」：50ms 内上升 > 0.6，下降 < 0.35',
    rise > 0.6 && fall < 0.35, `rise=${rise.toFixed(3)} fall=${fall.toFixed(3)}`);
  const seq = [0.1, 0.3, 0.6, 0.9].map((v) => smoothLevel(0.2, v, 40));
  ok('平滑对输入 level 单调（输入越大输出越大）',
    seq.every((v, i) => i === 0 || v >= seq[i - 1]), JSON.stringify(seq.map((v) => Number(v.toFixed(3)))));
  ok('平滑输出始终夹在 0~1（负输入 / 超界输入也不会跑出去）',
    smoothLevel(-2, 3, 50) <= 1 && smoothLevel(-2, 3, 50) >= 0 && smoothLevel(2, -1, 50) >= 0);
}

/* ================================================================== *
 * 10. createVuMeter：第二路音频的开关与释放（假 AudioContext）
 * ================================================================== */
console.log('\n[10] createVuMeter：打开 / 读数 / 关闭（停音轨 + 关 AudioContext）');

function fakeVuWindow({ samples = 190, ctxState = 'running' } = {}) {
  const log = { tracks: [], closed: 0, contexts: 0, calls: 0 };
  const win = {
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          log.calls += 1;
          const track = { stopped: false, stop() { this.stopped = true; } };
          log.tracks.push(track);
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        },
      },
    },
    AudioContext: class {
      constructor() { this.state = ctxState; log.contexts += 1; }
      createMediaStreamSource(stream) {
        log.sourceStream = stream;
        return { connect() {}, disconnect() {} };
      }
      createAnalyser() {
        return {
          fftSize: 512,
          smoothingTimeConstant: 0,
          getByteTimeDomainData(buf) { for (let i = 0; i < buf.length; i += 1) buf[i] = samples; },
        };
      }
      resume() { this.state = 'running'; return Promise.resolve(); }
      close() { log.closed += 1; this.state = 'closed'; return Promise.resolve(); }
    },
  };
  return { win, log };
}

{
  const { win, log } = fakeVuWindow({ samples: 190 });
  const meter = createVuMeter({ win });
  ok('open() 拿到第二路音频 + Analyser，active=true',
    (await meter.open()) === true && meter.active === true && log.contexts === 1);
  const lv = meter.readLevel();
  ok('readLevel() 把大声波形读成高 level（> 0.6）', lv > 0.6, String(lv));
  meter.close();
  ok('close() 停掉音轨并 AudioContext.close()（不留后台麦克风）',
    meter.active === false && log.tracks[0].stopped === true && log.closed === 1,
    JSON.stringify({ stopped: log.tracks[0].stopped, closed: log.closed }));

  const silentMeter = createVuMeter({ win: fakeVuWindow({ samples: 128 }).win });
  await silentMeter.open();
  ok('静音波形读数为 0（灰环）', silentMeter.readLevel() === 0);
  silentMeter.close();

  const suspended = createVuMeter({ win: fakeVuWindow({ ctxState: 'suspended' }).win });
  ok('AudioContext 处于 suspended 时会先 resume()，成功就照常打开',
    (await suspended.open()) === true && suspended.active === true);
  suspended.close();

  const unsupported = createVuMeter({ win: { navigator: {} } });
  let code = '';
  try { await unsupported.open(); } catch (err) { code = err.code; }
  ok('没有 AudioContext / getUserMedia → open() 明确 reject（调用方静默降级）',
    code === 'vu-unsupported' && unsupported.active === false, code);

  /* ---- 共享麦克风（P3.5 的重点）：只许用会话层那一条流 ---- */
  {
    const { win, log } = fakeVuWindow({ samples: 190 });
    const shared = {
      getTracks: () => [{ stopped: false, stop() { this.stopped = true; } }],
      getAudioTracks: () => [{ stopped: false, stop() { this.stopped = true; } }],
    };
    const track = shared.getAudioTracks()[0];
    const meter = createVuMeter({ win, stream: shared, requireStream: true });
    ok('共享流：open() 直接用传进来的 MediaStream，**不再调用 getUserMedia**',
      (await meter.open()) === true && log.calls === 0 && log.sourceStream === shared,
      JSON.stringify({ calls: log.calls, same: log.sourceStream === shared }));
    ok('共享流：readLevel 照常读数（音量表仍然工作）', meter.readLevel() > 0.6, String(meter.readLevel()));
    meter.close();
    ok('共享流：close() 只关自己的 AudioContext，**不 stop 别人的音轨**（轨道归 createMic）',
      log.closed === 1 && track.stopped === false,
      JSON.stringify({ closed: log.closed, stopped: track.stopped }));

    const noWin = fakeVuWindow();
    const noStream = createVuMeter({ win: noWin.win, requireStream: true });
    let noStreamCode = '';
    try { await noStream.open(); } catch (err) { noStreamCode = err.code; }
    ok('requireStream：没有共享流时直接失败（vu-no-stream），绝不偷偷再开一路麦克风',
      noStreamCode === 'vu-no-stream' && noWin.log.calls === 0,
      JSON.stringify({ code: noStreamCode, calls: noWin.log.calls }));
  }
}

/* ================================================================== *
 * 以下是 P3.1：本机代理 + 火山流式 ASR（全部离线 / 全用假值）
 * ================================================================== */

/** 造一帧火山服务端「全服务端响应」（默认带正序号 + gzip + JSON） */
function volcResponseFrame(json, {
  flags = FLAGS.POSITIVE_SEQUENCE, seq = 1, gzip = true,
} = {}) {
  const raw = Buffer.from(JSON.stringify(json), 'utf8');
  return buildFrame({
    messageType: MESSAGE_TYPES.FULL_SERVER_RESPONSE,
    flags,
    serialization: SERIALIZATION.JSON,
    compression: gzip ? COMPRESSION.GZIP : COMPRESSION.NONE,
    payload: gzip ? zlib.gzipSync(raw) : raw,
    sequence: seq,
  });
}

/** 造一帧火山错误帧：header + error_code + error_message_size + message */
function volcErrorFrame(code, message) {
  const text = Buffer.from(String(message), 'utf8');
  const head = Buffer.alloc(4);
  head[0] = 0x11;
  head[1] = 0xf0;   // message type 0b1111（错误帧）
  head[2] = 0x00;
  head[3] = 0x00;
  const codeBuf = Buffer.alloc(4);
  codeBuf.writeUInt32BE(code, 0);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(text.length, 0);
  return Buffer.concat([head, codeBuf, sizeBuf, text]);
}

/** 假的火山上游 socket（createVolcSession 的 openSocket 注入点） */
function fakeUpstream() {
  const sent = [];
  const frameHandlers = [];
  const closeHandlers = [];
  const errorHandlers = [];
  const parser = createVolcFrameParser();
  return {
    sent,
    closed: false,
    headers: { 'x-tt-logid': 'test-log-id' },
    send(buf) { sent.push(Buffer.from(buf)); return true; },
    close() { this.closed = true; },
    onFrame(fn) { frameHandlers.push(fn); },
    onClose(fn) { closeHandlers.push(fn); },
    onError(fn) { errorHandlers.push(fn); },
    feed(raw) {
      for (const frame of parser.push(raw)) for (const fn of frameHandlers) fn(frame);
    },
    die(code) {
      const err = Object.assign(new Error(`boom ${code}`), { code });
      for (const fn of errorHandlers) fn(err);
      for (const fn of closeHandlers) fn();
    },
  };
}

/** 假浏览器窗口：WebSocket + AudioContext（ScriptProcessor）+ SpeechRecognition 全部可观察 */
function fakeVolcWindow({ rate = 48000 } = {}) {
  const log = { websockets: [], contexts: [], recognitions: [] };
  class FakeRecognizer {
    constructor() {
      this.lang = '';
      this.continuous = false;
      this.interimResults = false;
      this.started = 0;
      this.stopped = 0;
      this.onstart = null;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      log.recognitions.push(this);
    }
    start() { this.started += 1; this.onstart?.(); }
    stop() { this.stopped += 1; }
    abort() { this.stopped += 1; }
  }
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closed = false;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      log.websockets.push(this);
    }
    send(data) { this.sent.push(data); }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.readyState = 3;
      this.onclose?.({});
    }
    open() { this.readyState = 1; this.onopen?.({}); }
    message(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
    fail() { this.onerror?.({}); }
  }
  class FakeAudioContext {
    constructor() {
      this.sampleRate = rate;
      this.state = 'running';
      this.destination = {};
      this.closed = false;
      this.source = null;
      this.node = null;
      log.contexts.push(this);
    }
    createMediaStreamSource() {
      this.source = {
        connected: 0,
        disconnected: false,
        connect() { this.connected += 1; },
        disconnect() { this.disconnected = true; },
      };
      return this.source;
    }
    createScriptProcessor() {
      this.node = {
        connected: 0,
        disconnected: false,
        onaudioprocess: null,
        connect() { this.connected += 1; },
        disconnect() { this.disconnected = true; },
      };
      return this.node;
    }
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    }
    close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
  }
  return {
    win: { WebSocket: FakeWebSocket, AudioContext: FakeAudioContext, SpeechRecognition: FakeRecognizer },
    log,
  };
}

/** 正弦采样（降采样测试用） */
function sineSamples(n, { freq = 441, amp = 0.5, rate = 44100 } = {}) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/* ================================================================== *
 * 11. coach.env 解析（只读文件；测试里全是假值）
 * ================================================================== */
console.log('\n[11] coach.env 极简 KEY=VALUE 解析（假值，不碰真文件、不联网）');
{
  const text = [
    '# comment line',
    'VOLC_APP_ID=test',
    'export VOLC_API_KEY="fake-token-123"   # trailing comment',
    "VOLC_ASR_RESOURCE='volc.test.resource'",
    'EMPTY=',
    'EQ=a=b=c',
    'not a valid line',
    '',
  ].join('\r\n');
  const env = parseEnv(text);
  ok('KEY=VALUE / export / 单双引号都能解析（CRLF 也行）',
    env.VOLC_APP_ID === 'test' && env.VOLC_API_KEY === 'fake-token-123'
    && env.VOLC_ASR_RESOURCE === 'volc.test.resource',
    JSON.stringify(env));
  ok('空值保留空串、值里的 = 不会被切开、注释 / 非法行被忽略',
    env.EMPTY === '' && env.EQ === 'a=b=c'
    && Object.keys(env).length === 5 && !('not a valid line' in env),
    JSON.stringify(Object.keys(env)));
  const missing = volcConfigFrom({});
  ok('缺字段时 configured=false，并列出缺哪两个字段',
    missing.configured === false && missing.missing.length === 2
    && missing.missing.includes('VOLC_APP_ID') && missing.missing.includes('VOLC_API_KEY'),
    JSON.stringify(missing.missing));
  const cfg = volcConfigFrom(env);
  ok('字段齐全 → configured=true，资源来自文件、端点 / 鉴权风格可覆盖',
    cfg.configured === true && cfg.resource === 'volc.test.resource'
    && /^wss:\/\//.test(cfg.endpoint) && cfg.authStyle === 'auto');
  const override = volcConfigFrom({
    ...env,
    VOLC_ASR_ENDPOINT: 'wss://example.test/asr',
    VOLC_ASR_AUTH_STYLE: 'api-key',
  });
  ok('VOLC_ASR_ENDPOINT / VOLC_ASR_AUTH_STYLE 能覆盖默认值',
    override.endpoint === 'wss://example.test/asr' && override.authStyle === 'api-key');
  ok('maskSecret 只给长度、redactSecrets 抹掉值（日志 / 探针不会漏 Key）',
    maskSecret('fake-token-123') === 'set (14 chars)'
    && maskSecret('') === '(empty)'
    && !redactSecrets('token=fake-token-123', ['fake-token-123']).includes('fake-token-123')
    && redactSecrets('abc', ['']) === 'abc');
}

/* ================================================================== *
 * 12. 最小 WebSocket：握手 / 分帧 / 掩码 / 半帧 / 分片（纯函数）
 * ================================================================== */
console.log('\n[12] 最小 WebSocket：握手 / 分帧 / 掩码 / 半帧 / 分片');
{
  ok('Sec-WebSocket-Accept 与 RFC 6455 示例一致',
    computeAccept('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');

  const textFrame = encodeFrame({ opcode: OPCODES.TEXT, payload: 'hello' });
  const textOut = decodeFrames(textFrame);
  ok('文本帧往返：首字节 0x81、长度 5、服务端帧不带掩码',
    textFrame[0] === 0x81 && textFrame[1] === 5
    && textOut.frames.length === 1
    && textOut.frames[0].payload.toString() === 'hello'
    && textOut.frames[0].masked === false);

  const masked = encodeFrame({
    opcode: OPCODES.BINARY,
    payload: Buffer.from([1, 2, 3, 4]),
    mask: true,
    rng: () => Buffer.from([9, 8, 7, 6]),
  });
  const maskedOut = decodeFrames(masked);
  ok('客户端掩码帧：首字节 0x82、mask 位=1，解码后字节完全还原',
    masked[0] === 0x82 && (masked[1] & 0x80) !== 0
    && maskedOut.frames[0].payload.equals(Buffer.from([1, 2, 3, 4]))
    && maskedOut.frames[0].masked === true);
  ok('掩码真的生效：明文 payload 不会原样出现在帧里',
    !masked.includes(Buffer.from([1, 2, 3, 4])));

  const two = Buffer.concat([textFrame, masked]);
  ok('一个缓冲区里多帧一次解出来',
    decodeFrames(two).frames.length === 2 && decodeFrames(two).rest.length === 0);
  const cut = two.subarray(0, two.length - 2);
  const cutOut = decodeFrames(cut);
  ok('半帧留在 rest 里等下一块（不会把半包当消息）',
    cutOut.frames.length === 1 && cutOut.rest.length === 8,
    JSON.stringify({ frames: cutOut.frames.length, rest: cutOut.rest.length }));

  const parser = createWsFrameParser();
  const firstHalf = parser.push(two.subarray(0, 7));
  const secondHalf = parser.push(two.subarray(7));
  ok('流式解帧器跨 chunk 拼出两帧', firstHalf.length + secondHalf.length === 2 && parser.pending === 0);

  const mid = encodeFrame({ opcode: OPCODES.BINARY, payload: Buffer.alloc(300, 1) });
  ok('126~65535 字节走 16 位长度（300 字节的帧能解回来）',
    mid[1] === 126 && decodeFrames(mid).frames[0].payload.length === 300);
  const big = encodeFrame({ opcode: OPCODES.BINARY, payload: Buffer.alloc(70000, 7) });
  ok('>=65536 字节走 64 位长度（70000 字节的帧能解回来）',
    big[1] === 127 && decodeFrames(big).frames[0].payload.length === 70000);

  const messages = [];
  const assembler = createMessageAssembler((msg) => messages.push(msg));
  assembler.push({ fin: false, opcode: OPCODES.TEXT, payload: Buffer.from('he') });
  assembler.push({ fin: true, opcode: OPCODES.CONTINUATION, payload: Buffer.from('llo') });
  ok('分片重组：TEXT(fin=0) + CONTINUATION(fin=1) → 一条 hello',
    messages.length === 1 && messages[0].opcode === OPCODES.TEXT
    && messages[0].payload.toString() === 'hello');

  const control = [];
  const ctlAssembler = createMessageAssembler((msg) => control.push(msg));
  ctlAssembler.push({ fin: true, opcode: OPCODES.PING, payload: Buffer.from('p') });
  ctlAssembler.push({ fin: true, opcode: OPCODES.PONG, payload: Buffer.alloc(0) });
  ok('控制帧（ping / pong）直接交给调用方、不占分片缓冲',
    control.length === 2 && control[0].opcode === OPCODES.PING && control[1].opcode === OPCODES.PONG);
}

/* ================================================================== *
 * 13. 火山 v3 协议：组帧 / 解帧 / 热词 / partial & final / error / 鉴权头
 * ================================================================== */
console.log('\n[13] 火山 v3 协议：组帧 / 解帧 / 热词 / partial & final / error / 鉴权头');
{
  const body = buildStartPayload({ lang: 'zh-CN' });
  ok('开始请求：PCM / 16kHz / 16bit / 单声道 / 中文',
    body.audio.format === 'pcm' && body.audio.rate === 16000 && body.audio.bits === 16
    && body.audio.channel === 1 && body.audio.language === 'zh-CN');

  const context = body.request.corpus.context;
  const hot = JSON.parse(context).hotwords.map((w) => w.word);
  const wanted = ['深蹲', '俯卧撑', '跪姿俯卧撑', '平板支撑', '箭步蹲', '体前屈',
    '髋角', '膝角', '暂停', '继续', '退出', '开始', '目标', '秒', '次'];
  ok('热词覆盖动作 / 指标 / 口令 15 个词（全部来自 HOTWORDS）',
    wanted.every((w) => hot.includes(w)), JSON.stringify(hot));
  ok('热词以 JSON **字符串** 放进 corpus.context（官方要求），数量与 HOTWORDS 一致',
    typeof context === 'string' && hot.length === HOTWORDS.length && HOTWORDS.length >= 15);

  const start = buildStartFrame({ lang: 'zh-CN' });
  const parsedStart = parseFrame(start);
  ok('开始帧头：0x11 0x11 0x11（版本 1 / 头长 4 / 类型 1 / 正序号 / JSON / gzip）',
    start[0] === 0x11 && start[1] === 0x11 && start[2] === 0x11,
    [...start.subarray(0, 4)].join(','));
  ok('开始帧带正序号 sequence=1（线上服务按这个解析，flags=0 会被当成坏帧关掉）',
    parsedStart.flags === FLAGS.POSITIVE_SEQUENCE && parsedStart.sequence === 1,
    JSON.stringify({ flags: parsedStart.flags, sequence: parsedStart.sequence }));
  ok('开始帧 gzip 解开就是同一份 JSON',
    JSON.parse(zlib.gunzipSync(parsedStart.payload).toString('utf8')).audio.rate === 16000);

  // 真实踩过的坑：Node 客户端如果直接把「火山应用层帧」写进 socket，
  // 服务端会把 4 字节协议头当成 WebSocket 帧头 → 1002 / unexpected reserved bits。
  const clientWs = decodeFrames(encodeClientMessage(start));
  ok('发给火山前再包一层掩码二进制 WS 帧（不是裸写应用层帧）',
    clientWs.frames.length === 1
    && clientWs.frames[0].opcode === OPCODES.BINARY
    && clientWs.frames[0].masked === true
    && parseFrame(clientWs.frames[0].payload).messageType === MESSAGE_TYPES.FULL_CLIENT_REQUEST,
    JSON.stringify({ frames: clientWs.frames.length, masked: clientWs.frames[0]?.masked }));

  const audio = buildAudioFrame(Buffer.from([0, 1, 2, 3]));
  const parsedAudio = parseFrame(audio);
  ok('音频帧：类型 0b0010、序列化 0（原始字节）、gzip 后能还原',
    parsedAudio.messageType === MESSAGE_TYPES.AUDIO_ONLY
    && parsedAudio.serialization === SERIALIZATION.NONE
    && zlib.gunzipSync(parsedAudio.payload).equals(Buffer.from([0, 1, 2, 3])));
  const last = buildAudioFrame(Buffer.alloc(0), { last: true });
  ok('最后一包 flags=0b0010（无序号）、payload 为空',
    (parseFrame(last).flags & 0x0f) === 0x02);

  const partial = parseResponseFrame(parseFrame(volcResponseFrame({ result: { text: '深蹲' } })));
  ok('partial：未定稿文本 + 序号一起解出来',
    partial.type === 'partial' && partial.text === '深蹲' && partial.sequence === 1,
    JSON.stringify(partial));
  const final = parseResponseFrame(parseFrame(volcResponseFrame({
    result: { text: '深蹲 暂停', utterances: [{ text: '深蹲 暂停', definite: true }] },
  }, { flags: FLAGS.LAST_NEGATIVE_SEQUENCE, seq: -1 })));
  ok('final：definite utterance 或最后一包都算定稿',
    final.type === 'final' && final.text === '深蹲 暂停' && final.definite === true);
  const emptyFinal = parseResponseFrame(parseFrame(volcResponseFrame(
    { result: { text: '' } }, { flags: FLAGS.LAST, seq: null },
  )));
  ok('最后一包没有文本也返回 final（调用方拿上一句收尾）',
    emptyFinal.type === 'final' && emptyFinal.text === '');
  const noGzip = parseResponseFrame(parseFrame(volcResponseFrame(
    { result: { text: 'hello' } }, { gzip: false },
  )));
  ok('服务端没开 gzip 也能解（按头里的 compression 判断）',
    noGzip.type === 'partial' && noGzip.text === 'hello');

  const bad = parseResponseFrame(parseFrame(volcErrorFrame(45000001, 'invalid request')));
  ok('错误帧（类型 0b1111）解析出稳定 code + 火山错误码 + 消息',
    bad.type === 'error' && bad.code === 'bad-request' && bad.volcCode === 45000001
    && bad.message.includes('invalid'));
  const leak = parseResponseFrame(parseFrame(volcErrorFrame(
    45000001, 'X-Api-Key: fake-token-123 Bearer fake-token-123',
  )));
  ok('错误消息脱敏：不回显 X-Api-Key / Bearer token',
    !leak.message.includes('fake-token-123') && leak.message.includes('***'), leak.message);
  ok('火山错误码映射：参数 / 超时 / 空音频 / 5xx',
    mapVolcCode(45000001) === 'bad-request' && mapVolcCode(45000081) === 'timeout'
    && mapVolcCode(45000002) === 'empty-audio' && mapVolcCode(55000031) === 'server-busy'
    && mapVolcCode(55999999) === 'upstream');
  ok('sanitizeDetail 把 api_key= / access_key= 也抹掉',
    !sanitizeDetail('api_key=fake-token-123').includes('fake-token-123')
    && !sanitizeDetail('access_key=fake-token-123').includes('fake-token-123'));

  const autoHeaders = buildAuthHeaders({
    appId: 'test-app', apiKey: 'test-key', resource: 'volc.test',
    requestId: 'req-1', connectId: 'conn-1',
  });
  ok('auto 鉴权风格：APP ID + Access Key + X-Api-Key 都发（新旧控制台都能连）',
    autoHeaders['X-Api-App-Key'] === 'test-app' && autoHeaders['X-Api-Access-Key'] === 'test-key'
    && autoHeaders['X-Api-Key'] === 'test-key' && autoHeaders['X-Api-Resource-Id'] === 'volc.test'
    && autoHeaders['X-Api-Request-Id'] === 'req-1' && autoHeaders['X-Api-Connect-Id'] === 'conn-1');
  const apiKeyStyle = buildAuthHeaders({ appId: 'test-app', apiKey: 'test-key', style: 'api-key' });
  const appKeyStyle = buildAuthHeaders({ appId: 'test-app', apiKey: 'test-key', style: 'app-key' });
  ok('api-key 风格只发 X-Api-Key；app-key 风格不发 X-Api-Key',
    apiKeyStyle['X-Api-Key'] === 'test-key' && apiKeyStyle['X-Api-Access-Key'] === undefined
    && appKeyStyle['X-Api-Key'] === undefined && appKeyStyle['X-Api-Access-Key'] === 'test-key');
}

/* ================================================================== *
 * 14. 火山会话层：用假 socket 跑完整条链路（不联网）
 * ================================================================== */
console.log('\n[14] 火山会话层（假 socket）：开始 / 音频 / 定稿 / 错误 / 脱敏');
{
  const events = [];
  const upstream = fakeUpstream();
  let seenUrl = '';
  let seenHeaders = null;
  const session = createVolcSession({
    config: {
      appId: 'test-app', apiKey: 'test-key', resource: 'volc.test',
      endpoint: 'wss://example.test/asr', authStyle: 'auto',
    },
    onEvent: (event) => events.push(event),
    openSocket: async ({ url, headers }) => {
      seenUrl = url;
      seenHeaders = headers;
      return upstream;
    },
  });

  ok('start()：带鉴权头连到配置的端点，并立刻发开始帧 + ready',
    await session.start({ lang: 'zh-CN' }) === true
    && seenUrl === 'wss://example.test/asr'
    && seenHeaders['X-Api-App-Key'] === 'test-app'
    && seenHeaders['X-Api-Resource-Id'] === 'volc.test'
    && events.some((e) => e.type === 'ready')
    && upstream.sent.length === 1,
    JSON.stringify({ events, sent: upstream.sent.length }));

  const startFrame = parseFrame(upstream.sent[0]);
  ok('发出去的第一帧是 full client request（类型 0b0001 / JSON / gzip / 16k）',
    startFrame.messageType === MESSAGE_TYPES.FULL_CLIENT_REQUEST
    && JSON.parse(zlib.gunzipSync(startFrame.payload).toString()).audio.rate === 16000);

  upstream.feed(volcResponseFrame({ result: { text: '深蹲' } }));
  ok('服务端 partial → relay 的 partial 事件（文本可直接上屏）',
    events.at(-1).type === 'partial' && events.at(-1).text === '深蹲');

  session.audio(Buffer.alloc(3200, 1));
  const audioFrame = parseFrame(upstream.sent.at(-1));
  ok('音频：转发成 audio-only 帧，gzip 解压后还是 3200 字节',
    audioFrame.messageType === MESSAGE_TYPES.AUDIO_ONLY
    && zlib.gunzipSync(audioFrame.payload).length === 3200);

  session.stop();
  const stopFrame = parseFrame(upstream.sent.at(-1));
  ok('stop()：最后一包 flags=0b0010、空 payload',
    (stopFrame.flags & 0x0f) === 0x02 && zlib.gunzipSync(stopFrame.payload).length === 0);

  upstream.feed(volcResponseFrame({
    result: { text: '深蹲 暂停', utterances: [{ definite: true, text: '深蹲 暂停' }] },
  }, { flags: FLAGS.LAST_NEGATIVE_SEQUENCE, seq: -1 }));
  ok('定稿帧 → relay 的 final 事件，并记住最后一句',
    events.at(-1).type === 'final' && events.at(-1).text === '深蹲 暂停'
    && session.lastText === '深蹲 暂停' && session.gotFinal === true);

  session.close();
  ok('close() 之后 socket 被关闭、bytes / segments 统计还在（日志只打数字）',
    upstream.closed === true && session.bytes === 3200 && session.segments >= 2);
}
{
  const events = [];
  const session = createVolcSession({
    config: { appId: 'test-app', apiKey: 'test-key', resource: 'volc.test' },
    onEvent: (event) => events.push(event),
    openSocket: async () => {
      throw Object.assign(new Error('upstream rejected test-key'), { code: 'auth' });
    },
  });
  ok('鉴权失败 → error 事件带 code=auth，message 里没有 Key',
    await session.start() === false
    && events.at(-1).type === 'error' && events.at(-1).code === 'auth'
    && !events.at(-1).message.includes('test-key'),
    JSON.stringify(events));
}
{
  const events = [];
  let opened = 0;
  const session = createVolcSession({
    config: volcConfigFrom({}),
    onEvent: (event) => events.push(event),
    openSocket: async () => { opened += 1; return fakeUpstream(); },
  });
  ok('coach.env 缺字段 → config 错误，且根本不去连火山',
    await session.start() === false && events.at(-1).code === 'config' && opened === 0);
}

/* ================================================================== *
 * 15. 16k 降采样（纯函数）：长度 / 振幅 / 静音 / 钳位
 * ================================================================== */
console.log('\n[15] 16k 降采样（纯函数）：长度 / 振幅 / 静音 / 钳位');
{
  const src44 = sineSamples(44100);
  const pcm44 = downsampleToPcm16(src44, 44100);
  ok('44.1k 1 秒 → 16000 个样本（round(n × 16000 / 44100)）',
    pcm44.length === 16000, String(pcm44.length));
  const rms44 = pcm16Rms(pcm44);
  ok('振幅合理：0.5 幅度的 441Hz 正弦降采样后 RMS ≈ 0.35（落在 0.30~0.40）',
    rms44 > 0.30 && rms44 < 0.40, rms44.toFixed(3));
  const peak44 = pcm16Peak(pcm44);
  ok('峰值接近原始幅度 0.5（区间平均没有把信号压没）',
    Math.abs(peak44 - 0.5) < 0.03, peak44.toFixed(3));
  const pcm48 = downsampleToPcm16(sineSamples(48000, { rate: 48000 }), 48000);
  ok('48k 1 秒 → 16000 个样本、RMS 与 44.1k 那一路接近',
    pcm48.length === 16000 && Math.abs(pcm16Rms(pcm48) - rms44) < 0.02);
  ok('静音 → 全 0（不产生直流 / 噪声）',
    pcm16Peak(downsampleToPcm16(new Float32Array(8000), 8000)) === 0);
  ok('空输入 / 非法采样率 → 空数组（调用方直接跳过这一包）',
    downsampleToPcm16(new Float32Array(0), 44100).length === 0
    && downsampleToPcm16(src44, 0).length === 0
    && downsampleToPcm16(null, 44100).length === 0);
  ok('振幅钳位：超出 ±1 的采样不会溢出成负值',
    floatToPcm16(new Float32Array([2, -2, 0.5]))[0] === 32767
    && floatToPcm16(new Float32Array([2, -2, 0.5]))[1] === -32767
    && floatToPcm16(new Float32Array([2, -2, 0.5]))[2] === 16384);
  ok('16k / 16bit / 单声道：3200 字节 = 100ms',
    pcmBytesToMs(3200) === 100 && pcmBytesToMs(32) === 1);
}

/* ================================================================== *
 * 16. 自动选路（纯函数）：有代理走火山、没有回退 Web Speech、都没有落 none
 * ================================================================== */
console.log('\n[16] 自动选路：有代理走火山、没有回退 Web Speech、都没有落 none');
{
  const fullWin = { WebSocket: class {}, AudioContext: class {}, SpeechRecognition: class {} };
  ok('有 WebSocket + AudioContext → volc',
    pickAsrRoute({ win: fullWin, url: 'ws://127.0.0.1:4180/asr' }) === ASR_ROUTES.VOLC);
  ok('只有 Web Speech → webspeech（代理不可用时的默认回退）',
    pickAsrRoute({ win: { SpeechRecognition: class {} }, url: 'ws://127.0.0.1:4180/asr' }) === ASR_ROUTES.WEB_SPEECH);
  ok('什么都没有 → none（会话会落 asr-unsupported，而不是静默）',
    pickAsrRoute({ win: {}, url: '' }) === ASR_ROUTES.NONE);
  ok('默认地址就是 ws://127.0.0.1:4180/asr',
    DEFAULT_ASR_WS_URL === 'ws://127.0.0.1:4180/asr' && resolveAsrUrl({}) === DEFAULT_ASR_WS_URL);
  ok('window.__MFG_ASR_WS__ 覆盖代理地址（测试 / 换端口）',
    resolveAsrUrl({ __MFG_ASR_WS__: 'ws://127.0.0.1:5999/asr' }) === 'ws://127.0.0.1:5999/asr');
  ok('__MFG_ASR_WS__ 写 off / none 时强制回退（不连代理）',
    resolveAsrUrl({ __MFG_ASR_WS__: 'off' }) === ''
    && resolveAsrUrl({ __MFG_ASR_WS__: 'NONE' }) === ''
    && pickAsrRoute({ win: fullWin, url: '' }) === ASR_ROUTES.WEB_SPEECH);
  const ctxWorklet = { audioWorklet: {}, createScriptProcessor() {} };
  const ctxProcessor = { createScriptProcessor() {} };
  ok('采集优先 AudioWorklet，其次 ScriptProcessor，都没有 → none',
    pickCaptureMode(ctxWorklet, { AudioWorkletNode: class {} }) === 'worklet'
    && pickCaptureMode(ctxWorklet, {}) === 'processor'
    && pickCaptureMode(ctxProcessor, {}) === 'processor'
    && pickCaptureMode(null, {}) === 'none');
  ok('错误码映射：auth / network / timeout / upstream / config → 会话错误码',
    volcErrorCode('auth') === 'asr-auth' && volcErrorCode('network') === 'asr-network'
    && volcErrorCode('timeout') === 'asr-timeout' && volcErrorCode('upstream') === 'asr-upstream'
    && volcErrorCode('server-busy') === 'asr-upstream' && volcErrorCode('config') === 'asr-config'
    && volcErrorCode('something-else') === 'asr');

  const asr = fakeAsr();
  const session = makeSession({ asr });
  await session.start();
  asr.setRoute('volc');
  ok('会话把 ASR 选路写进 snapshot（字幕面板据此提示当前用哪一路）',
    session.snapshot().route === 'volc' && session.route === 'volc');
  session.stop();
  ok('stop() 清空 route', session.snapshot().route === '');
}

/* ================================================================== *
 * 17. createVolcAsr：采集 → 发送 → partial / final → 关闭释放 → 回退
 * ================================================================== */
console.log('\n[17] createVolcAsr：采集 → 发送 → partial / final → 关闭释放 → 回退');
{
  const { win, log } = fakeVolcWindow();
  const mic = { stream: { getTracks: () => [] }, close() {} };
  const asr = createVolcAsr({ win, mic, url: 'ws://127.0.0.1:5999/asr', lang: 'zh-CN' });
  const got = { route: [], state: [], interim: [], result: [], notice: [], error: [] };
  asr.onRoute((info) => got.route.push(info.route));
  asr.onState((phase) => got.state.push(phase));
  asr.onInterim((text) => got.interim.push(text));
  asr.onResult((text, info) => got.result.push({ text, info }));
  asr.onNotice((info) => got.notice.push(info));
  asr.onError((info) => got.error.push(info));

  ok('start()：立刻走火山并连到指定代理地址',
    asr.start() === true && asr.route === 'volc' && got.route[0] === 'volc'
    && log.websockets.length === 1 && log.websockets[0].url === 'ws://127.0.0.1:5999/asr');
  log.websockets[0].open();
  const startMsg = JSON.parse(log.websockets[0].sent[0]);
  ok('WS 打开后发 {"type":"start","lang":"zh-CN"}',
    startMsg.type === 'start' && startMsg.lang === 'zh-CN');

  log.websockets[0].message({ type: 'ready' });
  await tick(3);
  ok('ready → 开始采集（没有 AudioWorklet 时用 ScriptProcessor 兜底）',
    log.contexts.length === 1 && !!log.contexts[0].node && log.contexts[0].node.connected >= 1);
  ok('ready → 状态进 listening（会话不再停在连接中）',
    got.state.includes('listening') && asr.active === true);

  const ctx = log.contexts[0];
  const node = ctx.node;
  node.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4800).fill(0.25) } });
  const binary = log.websockets[0].sent.filter((x) => typeof x !== 'string');
  ok('4800 个 48k 采样 → 1600 个 16k 样本 = 3200 字节二进制帧',
    binary.length === 1 && binary[0].byteLength === 3200 && asr.sentBytes === 3200,
    `${binary.length}/${binary[0] && binary[0].byteLength}`);

  log.websockets[0].message({ type: 'partial', text: '深蹲' });
  ok('代理 partial → onInterim（字幕跟着变）', got.interim.at(-1) === '深蹲');
  log.websockets[0].message({ type: 'final', text: '深蹲 暂停' });
  ok('代理 final → onResult(isFinal:true) 定稿',
    got.result.at(-1)?.text === '深蹲 暂停' && got.result.at(-1)?.info?.isFinal === true);

  asr.stop();
  const lastSent = log.websockets[0].sent.at(-1);
  ok('stop()：发 {"type":"stop"}、关 WS、关 AudioContext、断开处理节点（不留后台麦克风）',
    JSON.parse(lastSent).type === 'stop' && log.websockets[0].closed === true
    && ctx.closed === true && node.disconnected === true && asr.active === false);
  ok('stop() 之后 route 清空', asr.route === '');
}
{
  const { win, log } = fakeVolcWindow();
  const mic = { stream: { getTracks: () => [] }, close() {} };
  const asr = createVolcAsr({ win, mic, url: 'ws://127.0.0.1:5999/asr' });
  const got = { route: [], notice: [], error: [] };
  asr.onRoute((info) => got.route.push(info.route));
  asr.onNotice((info) => got.notice.push(info));
  asr.onError((info) => got.error.push(info));
  asr.start();
  log.websockets[0].fail();
  await tick(2);
  ok('代理连不上（WS error）→ 自动回退 Web Speech：路由变 webspeech + 启动浏览器识别',
    got.route.at(-1) === 'webspeech' && got.notice.some((n) => n.code === 'asr-fallback')
    && log.recognitions.length === 1 && log.recognitions[0].started === 1
    && log.websockets[0].closed === true && got.error.length === 0,
    JSON.stringify({ route: got.route, recs: log.recognitions.length, errors: got.error }));
  asr.stop();
  ok('回退后 stop() 会停掉浏览器识别',
    log.recognitions[0].stopped >= 1 && asr.active === false);

  const noWs = createVolcAsr({ win: { AudioContext: class {} }, mic });
  ok('连 WebSocket 都没有 → start() 返回 false（外层选 webspeech）', noWs.start() === false);
}
{
  const { win, log } = fakeVolcWindow();
  delete win.SpeechRecognition;
  const mic = { stream: { getTracks: () => [] }, close() {} };
  const asr = createVolcAsr({ win, mic, url: 'ws://127.0.0.1:5999/asr' });
  const errors = [];
  asr.onError((info) => errors.push(info));
  asr.start();
  log.websockets[0].fail();
  await tick(2);
  ok('代理不可用且浏览器也没有 Web Speech → onError(asr-unsupported)，不静默',
    errors.at(-1)?.code === 'asr-unsupported', JSON.stringify(errors));
  asr.stop();
}

/* ================================================================== *
 * 18. createAutoAsr：每次 start() 重新选路，接口与 P3.0 完全一致
 * ================================================================== */
console.log('\n[18] createAutoAsr：每次 start() 重新选路，接口与 P3.0 完全一致');
{
  const { win, log } = fakeVolcWindow();
  const mic = { stream: { getTracks: () => [] }, close() {} };
  const auto = createAutoAsr({ win, mic });
  const routes = [];
  auto.onRoute((info) => routes.push(info.route));
  ok('auto：有 WebSocket + AudioContext → 选火山（默认地址 ws://127.0.0.1:4180/asr）',
    auto.supported === true && auto.start() === true && auto.route === 'volc'
    && log.websockets[0]?.url === DEFAULT_ASR_WS_URL && routes.includes('volc'));
  auto.stop();

  const webWin = {
    SpeechRecognition: class {
      constructor() { this.started = 0; }
      start() { this.started += 1; this.onstart?.(); }
      stop() {}
    },
  };
  const auto2 = createAutoAsr({ win: webWin });
  ok('auto：没有 WebSocket → 自动回退 Web Speech（start 成功、路由 webspeech）',
    auto2.supported === true && auto2.start() === true && auto2.route === 'webspeech');
  auto2.stop();

  const none = createAutoAsr({ win: {} });
  ok('auto：两路都没有 → start() 返回 false（会话落 asr-unsupported）',
    none.supported === false && none.start() === false);

  const forced = createAutoAsr({ win, url: 'off' });
  ok('auto：url=off 强制 Web Speech（有识别构造器时仍然可用）',
    forced.start() === true && forced.route === 'webspeech');
  forced.stop();
}

/* ================================================================== *
 * 19. 安全：代理只绑回环、前端没有任何凭证字段
 * ================================================================== */
console.log('\n[19] 安全：代理只绑回环、前端没有任何凭证字段');
{
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const proxySrc = read('../server/coach-proxy.mjs');
  ok('代理写死只绑 127.0.0.1（源码里没有 0.0.0.0，也不接受 HOST 覆盖）',
    /BIND_HOST = '127\.0\.0\.1'/.test(proxySrc)
    && !/0\.0\.0\.0/.test(proxySrc) && !/process\.env\.HOST/.test(proxySrc));
  ok('代理默认端口 4180，可用 PORT 覆盖',
    /DEFAULT_PORT = 4180/.test(proxySrc) && /process\.env\.PORT/.test(proxySrc));
  const frontend = [
    '../src/voice/providers.js', '../src/voice/session.js',
    '../src/voice/coach.js', '../src/voice/pcm.js',
  ].map(read).join('\n');
  ok('前端源码里没有任何 VOLC_ 凭证字段（浏览器不知道 APP ID / Key / 资源）',
    !/VOLC_(APP_ID|API_KEY|ASR_RESOURCE)/.test(frontend));
  ok('浏览器只知道一个默认代理地址 ws://127.0.0.1:4180/asr',
    /ws:\/\/127\.0\.0\.1:4180\/asr/.test(frontend));
  ok('代理日志器不接收 headers（代码里没有把握手头写进日志的路径）',
    !/logger\.\w+\([^)]*headers/.test(proxySrc));
}

/* ================================================================== *
 * 20. P3.1 的新错误 / 提示 / 路由文案都有中英词条
 * ================================================================== */
console.log('\n[20] P3.1 的新错误 / 提示 / 路由文案都有中英词条');
{
  const codes = ['asr-auth', 'asr-network', 'asr-timeout', 'asr-upstream', 'asr-protocol', 'asr-config'];
  const missingZh = codes.filter((code) => {
    const key = VOICE_ERROR_KEYS[code];
    return typeof flat.zh[key] !== 'string' || !flat.zh[key].trim();
  });
  const missingEn = codes.filter((code) => {
    const key = VOICE_ERROR_KEYS[code];
    return typeof flat.en[key] !== 'string' || !flat.en[key].trim();
  });
  ok('6 个火山错误码都有中英文案', missingZh.length === 0 && missingEn.length === 0,
    JSON.stringify({ missingZh, missingEn }));
  ok('回退提示 asr-fallback 有中英文案',
    typeof flat.zh[VOICE_NOTICE_KEYS['asr-fallback']] === 'string'
    && typeof flat.en[VOICE_NOTICE_KEYS['asr-fallback']] === 'string');
  ok('两路识别的路由文案（volc / webSpeech）都有中英词条',
    typeof flat.zh['coach.route.volc'] === 'string' && typeof flat.en['coach.route.volc'] === 'string'
    && typeof flat.zh['coach.route.webSpeech'] === 'string'
    && typeof flat.en['coach.route.webSpeech'] === 'string');
}

/* ================================================================== *
 * 21. /asr 升级路由：并入预览服务器后，一个进程同时提供页面与语音代理
 *
 * 用户反馈「没有识别出来，显示火山引擎不可用」：代理原来是**独立进程**，忘了起就连不上
 * ws://127.0.0.1:4180/asr → 回退 Web Speech → 国内连不上 Google → 永远不可用。
 * 这里用**真实 http server + 裸 socket**（不联网）钉住三件事：
 *   ① /asr 升级被交给 coach-proxy 里同一份处理逻辑（预览服务器只是注册路由，没有复制）；
 *   ② 缺凭证时：握手照常完成 → error 帧（code=config）→ 关闭码 4401，日志脱敏，服务器不崩；
 *   ③ 非 /asr 的 upgrade 直接销毁，不留悬空连接。
 * ================================================================== */
console.log('\n[21] /asr 升级路由：一个进程就够（缺凭证不崩、其它 upgrade 直接销毁）');

/** 轮询等待（真实 socket 的收发是异步的；不用固定 sleep，省时间也不 flaky） */
async function waitFor(fn, ms = 1500) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return !!fn();
}

{
  const { createAsrUpgradeHandler, handleAsrUpgrade, loadAsrConfig, CLOSE_CODE_CONFIG, ASR_PATH }
    = await import('../server/coach-proxy.mjs');
  const http = await import('node:http');
  const net = await import('node:net');

  const logs = [];
  const captureLogger = {
    info: (m, e) => logs.push({ level: 'info', m, e }),
    warn: (m, e) => logs.push({ level: 'warn', m, e }),
    error: (m, e) => logs.push({ level: 'error', m, e }),
  };

  // 和 preview-server.js 完全同一条路径：普通 http server + createAsrUpgradeHandler
  const makeServer = async (opts) => {
    const srv = http.createServer((req, res) => { res.writeHead(404); res.end('nope'); });
    // upgrade 之后的 socket 不再受 http server 的 close() 管，自己记下来，收尾时逐个销毁
    const sockets = new Set();
    srv.on('connection', (sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    srv.on('upgrade', createAsrUpgradeHandler(opts));
    srv.testSockets = sockets;
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return srv;
  };
  const closeServer = (srv) => new Promise((resolve) => {
    for (const sock of srv.testSockets) { try { sock.destroy(); } catch { /* ignore */ } }
    try { srv.closeAllConnections?.(); } catch { /* ignore */ }
    srv.close(() => resolve());
  });
  const connectUpgrade = (port, pathname) => new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const state = { data: Buffer.alloc(0), closed: false };
    sock.on('data', (chunk) => { state.data = Buffer.concat([state.data, chunk]); });
    sock.on('close', () => { state.closed = true; });
    sock.on('error', () => { /* 对端销毁连接是预期行为 */ });
    sock.on('connect', () => {
      sock.write(`GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      resolve({ sock, state });
    });
  });

  ok('handleAsrUpgrade / createAsrUpgradeHandler 都是导出（预览服务器与独立代理共用同一份）',
    typeof handleAsrUpgrade === 'function' && typeof createAsrUpgradeHandler === 'function'
    && ASR_PATH === '/asr');
  ok('关闭码落在应用自定义区间 4000~4999（排障时一眼认出「缺凭证」）',
    CLOSE_CODE_CONFIG >= 4000 && CLOSE_CODE_CONFIG <= 4999, String(CLOSE_CODE_CONFIG));

  /* ---- ① 缺凭证：也要说清楚原因，而且不能把服务器搞挂 ---- */
  const missingCfg = { configured: false, missing: ['VOLC_APP_ID', 'VOLC_API_KEY'] };
  const broker = await makeServer({
    config: missingCfg, logger: captureLogger, envPath: 'C:\\tmp\\coach.env',
  });
  const port = broker.address().port;
  const first = await connectUpgrade(port, ASR_PATH);
  const gotHead = await waitFor(() => first.state.data.includes('\r\n\r\n'));
  const headText = first.state.data.toString('latin1');
  ok('缺凭证：握手仍然完成（直接拒握手的话浏览器只会报 connection failed，看不出缺 key）',
    gotHead && /^HTTP\/1\.1 101 Switching Protocols/.test(headText)
    && headText.includes('s3pPLMBiTxaQ9kYGzzhZRbK+xOo='),
    headText.split('\r\n')[0]);

  const headerEnd = headText.indexOf('\r\n\r\n') + 4;
  const bodyOf = () => first.state.data.subarray(headerEnd);
  const framesReady = await waitFor(() => decodeFrames(bodyOf()).frames.length >= 2);
  const frames = decodeFrames(bodyOf()).frames;
  const errFrame = frames.find((f) => f.opcode === OPCODES.TEXT);
  const closeCode = frames.find((f) => f.opcode === OPCODES.CLOSE);
  let errPayload = null;
  try { errPayload = JSON.parse(errFrame.payload.toString('utf8')); } catch { errPayload = null; }
  ok('缺凭证：先回 {"type":"error","code":"config"}，并说清缺哪几个字段（不回显任何值）',
    framesReady && !!errPayload && errPayload.type === 'error' && errPayload.code === 'config'
    && /VOLC_APP_ID/.test(String(errPayload.message))
    && !/test-key|fake-token|VOLC_API_KEY=\S/.test(JSON.stringify(errPayload)),
    JSON.stringify(errPayload));
  ok(`缺凭证：再用关闭码 ${CLOSE_CODE_CONFIG} 断开（不是 1006 那种看不出原因的码）`,
    !!closeCode && closeCode.payload.readUInt16BE(0) === CLOSE_CODE_CONFIG,
    closeCode ? String(closeCode.payload.readUInt16BE(0)) : 'no close frame');
  ok('缺凭证：日志只说「缺哪几个字段 / 哪个文件」（键值一个都不出现）',
    logs.some((l) => l.level === 'warn' && /config missing/.test(l.m)
      && l.e && l.e.file === 'coach.env' && l.e.missing.includes('VOLC_APP_ID'))
    && !logs.some((l) => /test-key|fake-token|VOLC_API_KEY=/.test(JSON.stringify(l))),
    JSON.stringify(logs.slice(0, 3)));

  first.sock.destroy();
  const second = await connectUpgrade(port, ASR_PATH);
  const secondOk = await waitFor(() => second.state.data.includes('\r\n\r\n'));
  ok('缺凭证：服务器不崩 —— 同一条失败之后还能继续接受新的 /asr 升级', secondOk);
  second.sock.destroy();
  const pageOk = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.resume();
      resolve(res.statusCode === 404);   // 这个测试服务器对普通请求只回 404，重点是有响应
    });
    req.on('error', () => resolve(false));
  });
  ok('缺凭证：同一个服务器的普通请求照常处理（语音代理不影响页面）', pageOk);
  await closeServer(broker);

  /* ---- ② 非 /asr 的 upgrade：直接销毁 ---- */
  const other = await makeServer({ config: missingCfg, logger: captureLogger });
  const otherPort = other.address().port;
  const stray = await connectUpgrade(otherPort, '/not-asr');
  const strayClosed = await waitFor(() => stray.state.closed === true);
  ok('非 /asr 的 upgrade 直接销毁（不回 101、也不留悬空连接）',
    strayClosed && stray.state.data.length === 0,
    JSON.stringify({ closed: stray.state.closed, bytes: stray.state.data.length }));
  await closeServer(other);

  /* ---- ③ 有凭证：正常 101（不触发 start 就不会去连火山，全程离线） ---- */
  const live = await makeServer({
    config: {
      configured: true, missing: [], appId: 'test-app', apiKey: 'fake-token-123',
      resource: 'volc.test', endpoint: 'wss://example.test/asr', authStyle: 'auto',
    },
    logger: captureLogger,
  });
  const livePort = live.address().port;
  const good = await connectUpgrade(livePort, ASR_PATH);
  const goodHead = await waitFor(() => good.state.data.includes('\r\n\r\n'));
  ok('有凭证：/asr 正常升级到 101（真的去连火山是收到 start 之后的事）',
    goodHead && /^HTTP\/1\.1 101 /.test(good.state.data.toString('latin1')));
  good.sock.destroy();
  await closeServer(live);

  /* ---- ④ 预览服务器只是「注册路由 + 复用」，没有第二份实现 ---- */
  const previewSrc = fs.readFileSync(new URL('../preview-server.js', import.meta.url), 'utf8');
  ok('预览服务器注册了 server.on("upgrade") 并直接交给 createAsrUpgradeHandler（没有复制粘贴握手代码）',
    /server\.on\('upgrade',\s*createAsrUpgradeHandler\(/.test(previewSrc)
    && /from '\.\/server\/coach-proxy\.mjs'/.test(previewSrc)
    && !/handshakeResponse|computeAccept|attachClient/.test(previewSrc));

  const lazy = loadAsrConfig({ envPath: 'C:\\definitely-not-here\\coach.env', env: {} });
  ok('loadAsrConfig：coach.env 不存在也不抛错，只报「缺两个字段」（预览服务器照常启动）',
    lazy.config.configured === false && lazy.config.missing.length === 2 && lazy.loaded.ok === false,
    JSON.stringify({ configured: lazy.config.configured, missing: lazy.config.missing }));
}

/* ================================================================== *
 * 21. P3.2 命令解析（parseCommand）：纯函数、每条 intent 中英各一条
 * ================================================================== */
console.log('\n[22] P3.2 命令解析：说法表 / 数字归一化 / 唤醒词 / 不瞎猜');
{
  setLang('zh', { persist: false });

  /**
   * 每条 intent 的**代表说法**（不是直接拿说法表第一项：带槽位的命令要给它一个完整句子，
   * 比如 pick 必须带「第三个」、setTarget 必须带数字）。表里有、这里没有会直接失败。
   */
  const SAMPLES = {
    home: ['回首页', 'go home'],
    menu: ['打开菜单', 'open menu'],
    next: ['下一页', 'next page'],
    prev: ['上一页', 'previous page'],
    back: ['返回', 'go back'],
    category: ['上肢', 'upper body'],
    pick: ['第三个', 'the third one'],
    openSettings: ['打开设置', 'open settings'],
    openRecords: ['训练记录', 'workout history'],
    openBest: ['最佳成绩', 'best score'],
    openExerciseSettings: ['运动设定', 'exercise settings'],
    startWorkout: ['开始训练', 'start training'],
    pause: ['暂停', 'pause'],
    resume: ['继续', 'resume'],
    exit: ['退出', 'exit'],
    retrySet: ['再来一组', 'one more set'],
    nextExercise: ['换动作', 'next exercise'],
    setTarget: ['设成 20 次', 'set target to 20 reps'],
    adjustTarget: ['加 5 个', 'add 5 reps'],
    mute: ['别说话', 'be quiet'],
    unmute: ['说话', 'unmute'],
    stopListening: ['关闭教练', 'stop listening'],
    help: ['我能说什么', 'what can i say'],
    switchLang: ['说英文', 'speak english'],
    reportProgress: ['我做了几个', 'how many did i do'],
  };

  ok(`命令表共 ${COMMANDS.length} 条 intent，每条都有中英测试样例`,
    COMMANDS.length >= 20
    && Object.keys(SAMPLES).length === COMMANDS.length
    && COMMANDS.every((c) => Array.isArray(SAMPLES[c.intent])),
    JSON.stringify({ commands: COMMANDS.map((c) => c.intent), samples: Object.keys(SAMPLES) }));
  ok('intent 不重复；COMMAND_BY_INTENT 与命令表一一对应',
    new Set(COMMANDS.map((c) => c.intent)).size === COMMANDS.length
    && COMMANDS.every((c) => COMMAND_BY_INTENT[c.intent] === c));
  ok('每条命令都有 zh / en 说法、帮助 key、可执行的 run()',
    COMMANDS.every((c) => c.zh.length > 0 && c.en.length > 0
      && typeof c.helpKey === 'string' && c.helpKey.startsWith('coach.commandHelp.')
      && typeof c.run === 'function'));
  ok('只有 exit 需要二次确认（confirm: true），其它命令都不弹确认',
    COMMANDS.filter((c) => c.confirm === true).map((c) => c.intent).join(',') === 'exit');
  ok('确认等待时间就是用户要求的 8 秒（COMMAND_CONFIRM_MS）', COMMAND_CONFIRM_MS === 8000);

  for (const cmd of COMMANDS) {
    const [zh, en] = SAMPLES[cmd.intent];
    const pz = parseCommand(zh, 'zh');
    const pe = parseCommand(en, 'en');
    ok(`中文「${zh}」→ ${cmd.intent}`, pz.intent === cmd.intent,
      JSON.stringify(pz));
    ok(`English "${en}" → ${cmd.intent}`, pe.intent === cmd.intent,
      JSON.stringify(pe));
  }

  // 数字归一化：中文数字 / 单位换算 / 全角 / 大小写
  ok('cnToInt：二十 = 20、十五 = 15、两 = 2、一百二十 = 120、一百 = 100',
    cnToInt('二十') === 20 && cnToInt('十五') === 15 && cnToInt('两') === 2
    && cnToInt('一百二十') === 120 && cnToInt('一百') === 100
    && cnToInt('3') === 3);
  ok('「深蹲二十次」→ 深蹲、20 次', (() => {
    const p = parseCommand('深蹲二十次');
    return p.intent === 'startWorkout' && p.args.exerciseId === 'squat'
      && p.args.value === 20 && p.args.unit === 'reps';
  })(), JSON.stringify(parseCommand('深蹲二十次')));
  ok('「设成两秒」→ 2 秒（中文数字 + 秒）', (() => {
    const p = parseCommand('设成两秒');
    return p.intent === 'setTarget' && p.args.value === 2 && p.args.unit === 'seconds';
  })(), JSON.stringify(parseCommand('设成两秒')));
  ok('「目标 一分钟」→ 60 秒（分钟换算成秒）', (() => {
    const p = parseCommand('目标 一分钟');
    return p.intent === 'setTarget' && p.args.value === 60 && p.args.unit === 'seconds';
  })(), JSON.stringify(parseCommand('目标 一分钟')));
  ok('「目标 30 秒」→ 30 秒', (() => {
    const p = parseCommand('目标 30 秒');
    return p.intent === 'setTarget' && p.args.value === 30 && p.args.unit === 'seconds';
  })());
  ok('「练深蹲」→ startWorkout + exerciseId=squat', (() => {
    const p = parseCommand('练深蹲');
    return p.intent === 'startWorkout' && p.args.exerciseId === 'squat';
  })(), JSON.stringify(parseCommand('练深蹲')));
  ok('「加 5 个」→ +5；「减 10」→ −10', (() => {
    const up = parseCommand('加 5 个');
    const down = parseCommand('减 10');
    return up.intent === 'adjustTarget' && up.args.delta === 5
      && down.intent === 'adjustTarget' && down.args.delta === -10;
  })(), JSON.stringify([parseCommand('加 5 个'), parseCommand('减 10')]));
  ok('「第三个」→ pick index=2（第 3 个 → 0 起下标 2）；「第 4 个」→ 3', (() => {
    const a = parseCommand('第三个');
    const b = parseCommand('第 4 个');
    return a.intent === 'pick' && a.args.index === 2 && b.intent === 'pick' && b.args.index === 3;
  })(), JSON.stringify([parseCommand('第三个'), parseCommand('第 4 个')]));
  ok('「说英文」→ switchLang=en；「说中文」→ switchLang=zh', (() => {
    const a = parseCommand('说英文');
    const b = parseCommand('说中文');
    return a.intent === 'switchLang' && a.args.lang === 'en'
      && b.intent === 'switchLang' && b.args.lang === 'zh';
  })());

  // 唤醒词：有就去掉并置 usedWake；没有也照常解析
  ok('「小迈，暂停」→ pause，usedWake=true（唤醒词被去掉）', (() => {
    const p = parseCommand('小迈，暂停');
    return p.intent === 'pause' && p.usedWake === true;
  })(), JSON.stringify(parseCommand('小迈，暂停')));
  ok('「教练 开始训练」→ startWorkout，usedWake=true', (() => {
    const p = parseCommand('教练 开始训练');
    return p.intent === 'startWorkout' && p.usedWake === true;
  })());
  ok('「coach pause」→ pause（大小写不敏感），usedWake=true', (() => {
    const p = parseCommand('coach pause');
    return p.intent === 'pause' && p.usedWake === true;
  })());
  ok('没有唤醒词也照常解析：「暂停」→ pause 且 usedWake=false',
    parseCommand('暂停').intent === 'pause' && parseCommand('暂停').usedWake === false);

  // 归一化：全角 / 标点 / 大小写
  ok('全角 + 标点 + 大写都能归一化：「ＰＡＵＳＥ！」→ pause', (() => {
    const p = parseCommand('ＰＡＵＳＥ！');
    return p.intent === 'pause' && p.confidence === 1;
  })(), JSON.stringify(parseCommand('ＰＡＵＳＥ！')));
  ok('大小写不敏感：「PAUSE」「Pause」都 → pause',
    parseCommand('PAUSE').intent === 'pause' && parseCommand('Pause').intent === 'pause');
  ok('normalizeText 把全角感叹号 / 空格 / 大小写处理掉',
    normalizeText('  ＰＡＵＳＥ！ ') === 'pause', normalizeText('  ＰＡＵＳＥ！ '));

  // 不瞎猜
  ok('匹配不上 → unknown（「烤面包」「please dance」都不猜）', (() => {
    const a = parseCommand('烤面包');
    const b = parseCommand('please dance');
    return a.intent === 'unknown' && a.confidence === 0
      && b.intent === 'unknown' && b.confidence === 0;
  })(), JSON.stringify([parseCommand('烤面包'), parseCommand('please dance')]));
  ok('只说「20 次」不带动作 / 目标词 → unknown（不替用户决定改谁的目标）',
    parseCommand('20 次').intent === 'unknown', JSON.stringify(parseCommand('20 次')));
  ok('精确命中的 confidence=1，句子里带别的话时 <1',
    parseCommand('暂停').confidence === 1
    && parseCommand('麻烦你先暂停一下').confidence < 1,
    JSON.stringify([parseCommand('暂停'), parseCommand('麻烦你先暂停一下')]));

  // 确认 / 取消的词表
  ok('确认词：中文「确认 / 好的」、English「confirm / yes」都算确认',
    isConfirmText('确认') && isConfirmText('好的') && isConfirmText('confirm') && isConfirmText('yes'));
  ok('取消词：中文「取消 / 算了」、English「cancel / no」都算取消',
    isCancelText('取消') && isCancelText('算了') && isCancelText('cancel') && isCancelText('no'));
  ok('「暂停」不是确认也不是取消（只在等待确认时才检查这两张表）',
    !isConfirmText('暂停') && !isCancelText('暂停'));
  ok('确认 / 取消词表本身中英都有（来自 locales 的 coach.confirmWords / cancelWords）',
    CONFIRM_WORDS.zh.length > 0 && CONFIRM_WORDS.en.length > 0
    && CANCEL_WORDS.zh.length > 0 && CANCEL_WORDS.en.length > 0);
}

/* ================================================================== *
 * 22. P3.2 快车道执行 + exit 的 pendingConfirm 状态机
 * ================================================================== */
console.log('\n[23] P3.2 快车道执行 + exit 确认状态机（8 秒自动取消）');
{
  setLang('zh', { persist: false });

  /** 一整套假 ctx：只记录被调用了哪些现有函数，不改状态 */
  function makeCtx(overrides = {}) {
    const calls = [];
    const base = {
      session: 'running',
      exerciseId: 'squat',
      target: 15,
      homeMode: false,
      menuMode: false,
      reps: 12,
      score: 88,
      holdMs: 0,
    };
    let snap = { ...base };
    const ctx = {
      calls,
      getStateSnapshot: () => ({ ...snap }),
      setSnap(next) { snap = { ...snap, ...next }; },
      showHome: () => calls.push(['showHome']),
      openMenu: (o) => calls.push(['openMenu', o]),
      openSettings: () => calls.push(['openSettings']),
      openRecordsModal: (w) => calls.push(['openRecordsModal', w]),
      openExerciseSettings: () => calls.push(['openExerciseSettings']),
      flipMenuPage: (d) => { calls.push(['flipMenuPage', d]); return true; },
      closeMenu: () => calls.push(['closeMenu']),
      selectFromMenu: (id) => calls.push(['selectFromMenu', id]),
      pickMenuItem: (i) => { calls.push(['pickMenuItem', i]); return i === 2 ? '核心' : ''; },
      startGestureMode: () => calls.push(['startGestureMode']),
      selectExercise: (id) => calls.push(['selectExercise', id]),
      pauseSession: () => calls.push(['pauseSession']),
      resumeSession: () => calls.push(['resumeSession']),
      retrySet: () => calls.push(['retrySet']),
      setTarget: (v, id) => { calls.push(['setTarget', v, id]); snap.target = v; return v; },
      setCoachMuted: (on) => calls.push(['setCoachMuted', on]),
      setCoachEnabled: (on) => calls.push(['setCoachEnabled', on]),
      changeLang: (lang) => calls.push(['changeLang', lang]),
      openVoiceHelp: () => calls.push(['openVoiceHelp']),
      closeVoiceHelp: () => calls.push(['closeVoiceHelp']),
      ...overrides,
    };
    return ctx;
  }

  function makeCommandSession(ctx, opts = {}) {
    const tts = fakeTts();
    const llmCalls = { n: 0 };
    const session = createVoiceSession({
      mic: fakeMic(),
      asr: fakeAsr(),
      tts,
      llm: { reply: () => { llmCalls.n += 1; return { text: 'LLM-REPLY' }; } },
      commandCtx: ctx,
      thinkDelay: 0,
      confirmMs: opts.confirmMs ?? 30,
    });
    return { session, tts, llmCalls };
  }

  /** 让教练把话说完 → 回到 listening（下一步的确认才听得到） */
  async function speakDone(session, tts) {
    if (tts._ends.length) tts.finish();
    await tick(3);
    return session.state;
  }

  // ① 未知命令 → 走 mockLlm；已知命令 → 不走 LLM
  {
    const ctx = makeCtx();
    const { session, tts, llmCalls } = makeCommandSession(ctx);
    await session.start();
    session.onUserText('暂停');
    ok('「暂停」走快车道：调用 ctx.pauseSession，并把「好的，暂停」当字幕',
      ctx.calls.some((c) => c[0] === 'pauseSession')
      && session.snapshot().coachText === t('coach.cmdAck.pause')
      && session.state === 'speaking',
      JSON.stringify({ calls: ctx.calls, coach: session.snapshot().coachText, state: session.state }));
    ok('快车道不经过 LLM（llm.reply 一次都没调）', llmCalls.n === 0, String(llmCalls.n));
    ok('快车道照样把话交给 TTS（不是只出字幕）', tts.spoken.length === 1, String(tts.spoken.length));
    await speakDone(session, tts);

    session.onUserText('烤面包');
    await tick(3);
    ok('没匹配上 → 仍然走 mockLlm，并给出「没听清，可以说…」的提示',
      llmCalls.n === 1 && session.snapshot().coachText === 'LLM-REPLY'
      && typeof t('coach.reply.fallback') === 'string' && t('coach.reply.fallback').length > 0,
      JSON.stringify({ llm: llmCalls.n, coach: session.snapshot().coachText }));
    session.stop();
  }

  // ② setTarget / adjustTarget 的参数真的传进 ctx.setTarget
  {
    const ctx = makeCtx();
    const { session, tts } = makeCommandSession(ctx);
    await session.start();
    session.onUserText('设成 30 次');
    ok('「设成 30 次」→ ctx.setTarget(30, squat)，字幕回「目标改成 30 次」',
      ctx.calls.some((c) => c[0] === 'setTarget' && c[1] === 30 && c[2] === 'squat')
      && session.snapshot().coachText.includes('30')
      && session.snapshot().coachText.includes(t('ui.repsUnit')),
      JSON.stringify({ calls: ctx.calls, coach: session.snapshot().coachText }));
    await speakDone(session, tts);
    session.onUserText('加 5 个');
    ok('「加 5 个」（当前 30）→ ctx.setTarget(35, squat)，字幕说「加 5」',
      ctx.calls.some((c) => c[0] === 'setTarget' && c[1] === 35)
      && session.snapshot().coachText.includes('35')
      && session.snapshot().coachText.includes(t('ui.repsUnit')),
      JSON.stringify({ calls: ctx.calls, coach: session.snapshot().coachText }));
    await speakDone(session, tts);
    session.onUserText('减 10');
    ok('「减 10」（当前 35）→ ctx.setTarget(25, squat)',
      ctx.calls.some((c) => c[0] === 'setTarget' && c[1] === 25),
      JSON.stringify(ctx.calls));
    session.stop();
  }

  // ③ 「开始深蹲」：全屏 + 权限仍然走 startGestureMode，然后选动作
  {
    const ctx = makeCtx();
    const { session } = makeCommandSession(ctx);
    await session.start();
    session.onUserText('开始深蹲');
    ok('「开始深蹲」→ startGestureMode（全屏 + 权限走原路）+ selectExercise(squat)',
      ctx.calls.some((c) => c[0] === 'startGestureMode')
      && ctx.calls.some((c) => c[0] === 'selectExercise' && c[1] === 'squat'),
      JSON.stringify(ctx.calls));
    session.stop();
  }

  // ④ 「第三个」：菜单没开就先开菜单，再交给 pickMenuItem
  {
    const ctx = makeCtx();
    const { session } = makeCommandSession(ctx);
    await session.start();
    session.onUserText('第三个');
    ok('「第三个」→ 先 openMenu，再 pickMenuItem(2)，字幕报第 3 个',
      ctx.calls.some((c) => c[0] === 'openMenu')
      && ctx.calls.some((c) => c[0] === 'pickMenuItem' && c[1] === 2)
      && session.snapshot().coachText.includes('3'),
      JSON.stringify({ calls: ctx.calls, coach: session.snapshot().coachText }));
    session.stop();
  }

  // ⑤ mute：只关朗读，字幕照常；unmute 恢复
  {
    const ctx = makeCtx();
    const { session, tts } = makeCommandSession(ctx);
    ctx.setCoachMuted = (on) => { ctx.calls.push(['setCoachMuted', on]); session.setMuted(on); };
    await session.start();
    session.onUserText('别说话');
    ok('「别说话」→ setCoachMuted(true)，session.muted=true，确认语只上字幕不朗读',
      ctx.calls.some((c) => c[0] === 'setCoachMuted' && c[1] === true)
      && session.muted === true
      && session.snapshot().coachText === t('coach.cmdAck.mute')
      && tts.spoken.length === 0,
      JSON.stringify({ muted: session.muted, spoken: tts.spoken.length }));
    session.onUserText('说话');
    ok('「说话」→ setCoachMuted(false)，朗读恢复（TTS 收到一句）',
      ctx.calls.some((c) => c[0] === 'setCoachMuted' && c[1] === false)
      && session.muted === false && tts.spoken.length >= 1,
      JSON.stringify({ muted: session.muted, spoken: tts.spoken.length }));
    session.stop();
  }

  // ⑥ 查询 / 帮助 / 切语言
  {
    const ctx = makeCtx();
    const { session, tts } = makeCommandSession(ctx);
    await session.start();
    session.onUserText('我做了几个');
    ok('「我做了几个」→ 读快照回答（12 个 / 88 分）',
      session.snapshot().coachText.includes('12') && session.snapshot().coachText.includes('88'),
      session.snapshot().coachText);
    await speakDone(session, tts);
    session.onUserText('我能说什么');
    ok('「我能说什么」→ ctx.openVoiceHelp()', ctx.calls.some((c) => c[0] === 'openVoiceHelp'));
    session.stop();
  }

  // ⑦ exit：第一次只问确认，不执行
  {
    const ctx = makeCtx();
    const { session, tts } = makeCommandSession(ctx);
    await session.start();
    session.onUserText('退出');
    ok('第一次说「退出」**不执行**：pendingConfirm.intent=exit，菜单没打开',
      session.pendingConfirm && session.pendingConfirm.intent === 'exit'
      && !ctx.calls.some((c) => c[0] === 'openMenu')
      && !ctx.calls.some((c) => c[0] === 'showHome'),
      JSON.stringify({ pending: session.pendingConfirm, calls: ctx.calls }));
    ok('教练问「确认退出吗？说『确认』或『取消』」',
      session.snapshot().coachText === t('coach.confirm.ask'),
      session.snapshot().coachText);
    await speakDone(session, tts);

    session.onUserText('确认');
    ok('再喂「确认」→ 真的退出（openMenu），pending 清空',
      ctx.calls.some((c) => c[0] === 'openMenu')
      && session.pendingConfirm === null,
      JSON.stringify({ calls: ctx.calls, pending: session.pendingConfirm }));
    session.stop();
  }

  // ⑧ 取消：不执行
  {
    const ctx = makeCtx();
    const { session, tts } = makeCommandSession(ctx);
    await session.start();
    session.onUserText('退出');
    await speakDone(session, tts);
    session.onUserText('取消');
    ok('「取消」→ 不退出、pending 清空、字幕说「好，不退出」',
      !ctx.calls.some((c) => c[0] === 'openMenu')
      && session.pendingConfirm === null
      && session.snapshot().coachText === t('coach.confirm.cancelled'),
      JSON.stringify({ calls: ctx.calls, coach: session.snapshot().coachText }));
    session.stop();
  }

  // ⑨ 8 秒没回应 → 自动取消（用 confirmMs=20 模拟）
  {
    const ctx = makeCtx();
    const { session } = makeCommandSession(ctx, { confirmMs: 20 });
    await session.start();
    session.onUserText('退出');
    ok('等待确认期间 pendingConfirm 有记录',
      !!session.snapshot().pendingConfirm);
    await new Promise((r) => setTimeout(r, 40));
    ok('20ms 里没有回应（等价于 8 秒）→ 自动取消：不执行、pending 清空、字幕提示超时',
      !ctx.calls.some((c) => c[0] === 'openMenu')
      && session.pendingConfirm === null
      && session.snapshot().coachText === t('coach.confirm.timeout'),
      JSON.stringify({ calls: ctx.calls, pending: session.pendingConfirm,
        coach: session.snapshot().coachText }));
    session.stop();
  }

  // ⑩ 等确认时说了别的话 → 再问一次，不会误执行
  {
    const ctx = makeCtx();
    const { session, tts } = makeCommandSession(ctx);
    await session.start();
    session.onUserText('退出');
    await speakDone(session, tts);
    session.onUserText('今天天气不错');
    ok('等确认时说了别的话 → 再问一次「确认 / 取消」，pending 还在',
      session.pendingConfirm !== null
      && session.snapshot().coachText === t('coach.confirm.repeat')
      && !ctx.calls.some((c) => c[0] === 'openMenu'),
      JSON.stringify({ pending: session.pendingConfirm, coach: session.snapshot().coachText }));
    session.stop();
  }

  // ⑪ stop / pause 会清掉等待中的确认（不留悬空计时器）
  {
    const ctx = makeCtx();
    const { session } = makeCommandSession(ctx);
    await session.start();
    session.onUserText('退出');
    session.stop();
    ok('关闭教练 / 页面隐藏时，等待中的确认会被清掉', session.pendingConfirm === null);
  }
}

/* ================================================================== *
 * 24. 语音诊断（P3.5）：事件收集 / 批量落盘 / snapshot / 脱敏 / 失败不抛错
 * ================================================================== */
console.log('\n[24] 语音诊断：事件收集 / 批量落盘 / snapshot / 脱敏 / 失败不抛错');
{
  ok('默认端点就是预览服务器的落盘接口（logs/coach-diag.jsonl）',
    DIAG_ENDPOINT === `/__debug/log?file=${DIAG_FILE}`
    && DIAG_FILE === 'coach-diag.jsonl'
    && DIAG_FLUSH_MS === 2000 && DIAG_BATCH_SIZE === 20 && DIAG_MAX_TEXT === 80,
    DIAG_ENDPOINT);

  ok('scrubText：Bearer / sk-… / 超长 token 都变 [redacted]，并截到 80 字',
    scrubText('Bearer abcdefghijklmnop sk-live-1234567890abcdef')
      .includes('[redacted]')
    && !scrubText('Bearer abcdefghijklmnop').includes('abcdefghijklmnop')
    && scrubText('a '.repeat(200)).length === 80
    && scrubText('　 \n  多行\n文本  ').length <= 80,
    scrubText('Bearer abcdefghijklmnop sk-live-1234567890abcdef'));

  ok('makeEntry：敏感键（apiKey / audio / pcm / samples）一律不上报',
    (() => {
      const entry = makeEntry('asr:final', {
        text: '你好',
        apiKey: 'sk-live-1234567890abcdef',
        audio: new Float32Array(4).fill(0.5),
        pcm: 'raw',
        samples: [0.1, 0.2],
      }, { now: () => 123 });
      const json = JSON.stringify(entry);
      return entry.t === 123 && entry.text === '你好'
        && entry.apiKey === '[redacted]' && entry.audio === '[redacted]'
        && entry.pcm === '[redacted]' && entry.samples === '[redacted]'
        && !json.includes('sk-live') && !json.includes('0.5');
    })());

  /* ---- 事件 → 快照计数器 ---- */
  const uploads = [];
  const fetchOk = async (url, opts) => {
    uploads.push({ url, body: String(opts && opts.body) });
    return { ok: true, status: 200 };
  };
  const diag = createDiag({
    fetch: fetchOk,
    timer: false,
    now: () => 1700000000000,
    maxText: 80,
  });
  const initial = diag.snapshot();
  ok('snapshot() 结构固定（events / route / ws / frames / partials·finals / 错误 / mic / audio / worklet）',
    ['events', 'pending', 'sent', 'failed', 'route', 'ws', 'frames', 'partials', 'finals',
      'lastPartial', 'lastFinal', 'lastError', 'mic', 'audio', 'capture', 'worklet', 'tts']
      .every((k) => k in initial)
    && initial.ws.state === 'idle' && initial.mic.tracks === 0
    && initial.frames.n === 0 && initial.partials === 0 && initial.finals === 0,
    JSON.stringify(initial));

  diag.record('route:volc', {});
  diag.record('ws:connecting', {});
  diag.record('ws:open', {});
  diag.record('ws:firstFrame', { bytes: 3200 });
  diag.record('ws:frames', { n: 12, bytes: 38400 });
  diag.record('ctx:sampleRate', { value: 48000, state: 'running' });
  diag.record('worklet:fail', { name: 'NotSupportedError', message: 'addModule failed' });
  diag.record('capture:mode', { mode: 'processor' });
  diag.record('asr:partial', { text: '你好' });
  diag.record('asr:final', { text: '字'.repeat(200) });
  diag.record('mic:ok', { tracks: 1, labels: ['audio-1'] });
  diag.record('mic:release', { reason: 'webspeech' });
  const snap = diag.snapshot();
  ok('snapshot 反映路由 / WS / 帧数 / partial·final 计数',
    snap.route === 'volc' && snap.ws.state === 'open'
    && snap.frames.n === 12 && snap.frames.bytes === 38400
    && snap.partials === 1 && snap.finals === 1 && snap.lastPartial === '你好'
    && snap.lastFinal.length === 80,
    JSON.stringify({ route: snap.route, ws: snap.ws, frames: snap.frames,
      partials: snap.partials, finals: snap.finals }));
  ok('snapshot 反映 AudioContext / Worklet 兜底 / 麦克风轨数（label 是脱敏后的序号）',
    snap.audio.sampleRate === 48000 && snap.audio.state === 'running'
    && snap.worklet.state === 'fail' && snap.capture === 'processor'
    && snap.mic.state === 'released' && snap.mic.tracks === 1
    && snap.mic.labels.join(',') === 'audio-1',
    JSON.stringify({ audio: snap.audio, worklet: snap.worklet, mic: snap.mic }));
  ok('asr:error 写进 lastError / asrError（错误码不会带凭证）',
    (() => {
      diag.record('asr:error', { code: 'auth', message: 'bad key sk-live-1234567890abcdef' });
      const s = diag.snapshot();
      return s.asrError.code === 'auth' && s.lastError.includes('auth')
        && !s.lastError.includes('sk-live');
    })());

  /* ---- 批量落盘 ---- */
  const flushed = await diag.flush();
  ok('flush() 把积压事件按 JSONL 批量 POST 到 /__debug/log?file=coach-diag.jsonl',
    flushed === true && uploads.length === 1
    && uploads[0].url === DIAG_ENDPOINT
    && uploads[0].body.trim().split('\n').every((line) => {
      try { JSON.parse(line); return true; } catch { return false; }
    }),
    JSON.stringify({ ok: flushed, uploads: uploads.length }));
  const allText = uploads.map((u) => u.body).join('\n');
  ok('落盘内容不含密钥、不含音频数据（只有文本 / 计数 / 状态）',
    !allText.includes('sk-live') && !allText.includes('Bearer ')
    && !allText.includes('Float32') && !allText.includes('"audio"')
    && allText.includes('"type":"mic:ok"') && allText.includes('audio-1'),
    allText.slice(0, 160));
  ok('flush 后 sent 计数增加、pending 清零',
    diag.sent > 0 && diag.snapshot().pending === 0, String(diag.sent));

  /* ---- 满 20 条自动上报（不等 2 秒）---- */
  const autoUploads = [];
  const auto = createDiag({
    fetch: async (url, opts) => { autoUploads.push(String(opts.body)); return { ok: true }; },
    timer: false,
    now: () => 1,
  });
  for (let i = 0; i < DIAG_BATCH_SIZE; i += 1) auto.record('asr:partial', { text: `第 ${i} 条` });
  await new Promise((r) => setTimeout(r, 0));
  ok('满 20 条自动上报（不必等 2 秒定时器）',
    autoUploads.length === 1
    && autoUploads[0].trim().split('\n').length === DIAG_BATCH_SIZE
    && auto.snapshot().pending === 0,
    JSON.stringify({ uploads: autoUploads.length, pending: auto.snapshot().pending }));

  /* ---- 2 秒定时器（注入假 timer，不真等）---- */
  {
    const timers = [];
    const timerDiag = createDiag({
      fetch: async () => ({ ok: true }),
      timer: true,
      flushMs: 2000,
      now: () => 1,
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return { id: timers.length }; },
      clearTimer: () => {},
    });
    timerDiag.record('mic:request', {});
    ok('打开 timer 后，第一条事件就会排一个 2 秒的批量上报',
      timers.length === 1 && timers[0].ms === 2000, JSON.stringify(timers.map((t) => t.ms)));
    timerDiag.close();
  }

  /* ---- 上传失败：静默丢弃，不抛错 ---- */
  const failing = createDiag({
    fetch: async () => { throw new Error('network down'); },
    timer: false,
    now: () => 1,
  });
  failing.record('mic:fail', { name: 'NotAllowedError', message: 'denied' });
  failing.record('asr:error', { code: 'network' });
  let threw = false;
  let failedResult = true;
  try { failedResult = await failing.flush(); } catch { threw = true; }
  ok('上传失败不抛错（静默丢弃这一批），failed 计数 +1',
    threw === false && failedResult === false && failing.snapshot().failed === 2
    && failing.snapshot().pending === 0,
    JSON.stringify({ threw, failedResult, failed: failing.snapshot().failed }));

  /* ---- 会话 / 教练主流程不受诊断影响 ---- */
  ok('诊断模块不碰 DOM（纯逻辑，可在 Node 里跑）',
    !/\bdocument\b/.test(fs.readFileSync(new URL('../src/voice/diag.js', import.meta.url), 'utf8'))
    && !/\bdocument\b/.test(fs.readFileSync(new URL('../src/voice/selftest.js', import.meta.url), 'utf8')));
  ok('自检的四步固定为 mic → ws → send → result（界面与失败文案都按这四步）',
    SELF_TEST_STEPS.join(',') === 'mic,ws,send,result');
}

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
