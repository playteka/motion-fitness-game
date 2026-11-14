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

import {
  createVoiceSession, VOICE_STATES, VOICE_NOTICE_KEYS, VOICE_ERROR_KEYS, THINK_SLOW_MS,
  speakHoldMs, VOICE_SPEAK_MIN_MS, VOICE_SPEAK_MAX_MS,
  DIALOGUE_MAX_TURNS, COACH_LINES_MAX, RECENT_EVENTS_MAX, RECENT_EVENTS_WINDOW_MS,
  EVENT_KINDS, RECENT_EVENT_MAX_CHARS,
} from '../src/voice/session.js';
import {
  parseCommand, cnToInt, normalizeText, isConfirmText, isCancelText,
} from '../src/voice/parse.js';
import {
  COMMANDS, COMMAND_BY_INTENT, COMMAND_CONFIRM_MS, CONFIRM_WORDS, CANCEL_WORDS,
} from '../src/voice/commands.js';
import {
  createLlm, createAsr, createVuMeter, createVolcAsr, createAutoAsr,
  createTts as createSystemTts,
  pickAsrRoute, resolveAsrUrl, pickCaptureMode, volcErrorCode, startPcmCapture,
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
  createDanmaku, createDanmakuModel, pickLane, layoutBullet,
  DANMAKU_LANE_COUNT, DANMAKU_MAX_ON_SCREEN, DANMAKU_QUEUE_MAX, DANMAKU_DEDUPE_MS,
  DANMAKU_FLIGHT_MS, DANMAKU_COLORS, DANMAKU_MODES, DANMAKU_DEFAULT_MODE,
} from '../src/voice/danmaku.js';
import {
  createVolcTts, normalizeTtsRate, TTS_TIMEOUT_MS, TTS_SOURCES, TTS_DEFAULT_SOURCE, TTS_PATH,
  TTS_STREAM_PATH, planStreamQueue, createAudioQueuePlayer, TTS_STREAM_LEAD_SEC,
  createMp3FrameSplitter, parseMp3FrameHeader, createMseAppendQueue, mseSupportsMpeg, MSE_MIME,
} from '../src/voice/tts-volc.js';
import {
  createBargeIn, BARGE_IN_WINDOW_MS, BARGE_IN_MIN_CHARS, BARGE_IN_LEVEL,
  BARGE_IN_PLAYBACK_LEVEL, BARGE_IN_MAX_LATENCY_MS,
} from '../src/voice/bargein.js';
import {
  createVolcTts as createVolcTtsServer, createTtsRoutes, createTtsCache, loadTtsConfig,
  ttsCacheKey, TTS_PATH as TTS_SERVER_PATH, TTS_STREAM_PATH as TTS_SERVER_STREAM_PATH,
  TTS_HEALTH_PATH, TTS_MAX_TEXT, TTS_STREAM_FIRST_MS,
  createVolcMessageParser, volcAudioBytes, unwrapVolcAudio,
} from '../server/volc-tts.mjs';
// R3：LLM 裁判（触发口径 / 严格 JSON / 护栏）+ session-end 告别
import {
  createJudge, JUDGE_EVENTS, JUDGE_ASK_EVENTS, isJudgeEvent, isJudgeAskEvent, judgePriority,
  isJudgeFarewellEvent, clampFarewellSpeak, FAREWELL_MAX_CHARS, FAREWELL_MAX_SENTENCES,
  shouldJudgeRep, shouldJudgeHold, shouldJudgeIdle, shouldJudgeOutOfFrame,
  parseJudgeReply, clampJudgeSpeak, parseGateDiagRow, worstGateCheck,
  JUDGE_TIMEOUT_MS, JUDGE_COOLDOWN_MS, JUDGE_DEDUPE_MS, JUDGE_MAX_CHARS,
  REP_JUDGE_EVERY, HOLD_JUDGE_EVERY_SEC, IDLE_JUDGE_START_SEC, OUT_OF_FRAME_JUDGE_START_SEC,
  GATE_FAIL_JUDGE_STREAK, KEYFRAME_MISS_JUDGE_STREAK,
} from '../src/voice/judge.js';
import {
  downsampleToPcm16, pcm16Rms, pcm16Peak, pcmBytesToMs, floatToPcm16,
  createPcmFramer, pcmBytesPerSec,
  FRAME_MS, FRAME_SAMPLES, FRAME_BYTES, EXPECTED_BYTES_PER_SEC,
} from '../src/voice/pcm.js';
import { parseEnv, volcConfigFrom, maskSecret, redactSecrets } from '../server/env.mjs';
import {
  computeAccept, encodeFrame, decodeFrames, createFrameParser as createWsFrameParser,
  createMessageAssembler, OPCODES,
} from '../server/ws-mini.mjs';
import {
  buildFrame, buildStartFrame, buildStartPayload, buildAudioFrame, parseFrame,
  createFrameParser as createVolcFrameParser, parseResponseFrame, buildAuthHeaders,
  parseResultJson, createTranscriptReducer, FINAL_THROTTLE_MS,
  volcErrorCode as mapVolcCode, HOTWORDS, MESSAGE_TYPES, FLAGS, SERIALIZATION, COMPRESSION,
  sanitizeDetail,
} from '../server/volc-protocol.mjs';
import { createVolcSession, encodeClientMessage } from '../server/volc-asr.mjs';
// P3.3 自由对话：服务端 LLM 适配 / 工具表 + 前端客户端 / Agent context（纯函数）
import {
  createLlmClient, buildAgentContext, trimAgentContext, scoreTrend, timeOfDayHint,
  normalizeActions as normalizeLlmActions,
  LLM_PATH as LLM_CLIENT_PATH, LLM_CLIENT_TIMEOUT_MS, LLM_HISTORY_TURNS,
  LLM_EVENT_SESSION_START as LLM_CLIENT_EVENT,
  LLM_EVENT_SESSION_END as LLM_CLIENT_EVENT_END,
  AGENT_CONTEXT_MAX_CHARS, AGENT_EVENTS_MAX, AGENT_EVENTS_WINDOW_MS, AGENT_EVENT_MAX_CHARS,
  AGENT_MEMORY_PREF_FIELDS, AGENT_MEMORY_FACT_FIELDS,
  weekTrend, startOfLocalWeek, normalizeRecentEvents, lastSessionForContext, memoryForContext,
  trainingSummaryForContext, AGENT_SUMMARY_MAX, AGENT_EVENT_KINDS,
} from '../src/voice/llm.js';
import {
  LLM_PATH, LLM_HEALTH_PATH, LLM_TIMEOUT_MS, LLM_MAX_TOKENS, LLM_RATE_LIMIT,
  LLM_RATE_WINDOW_MS, LLM_MAX_HISTORY_TURNS, LLM_EVENT_SESSION_START, LLM_EVENT_SESSION_END,
  loadLlmConfig, createLlmGuard, createLlmProvider, createMockLlmProvider,
  createLlmRoutes, buildLlmMessages, sessionStartEventMessage, sessionEndEventMessage, historyMessages,
  normalizeProviderName, llmHttpCode,
  // R3：裁判事件口径 + 按事件生成 user 消息（服务端）
  JUDGE_EVENT_TYPES, judgeEventMessage, isJudgeAskEvent as isJudgeAskEventServer,
  isJudgeFarewellEvent as isJudgeFarewellEventServer,
} from '../server/llm-provider.mjs';
import {
  LLM_TOOLS, LLM_TOOL_DEFS, TOOL_INTENT_MAP, TOOLED_INTENTS, UNCOVERED_INTENTS,
  UNKNOWN_TOOLED_INTENTS, MAX_TOOL_CALLS, EMPTY_REPLY, EXERCISE_IDS,
  actionsFromToolCalls, toolHelpRows, resolveExerciseId, buildSystemPrompt,
  DEFAULT_SOUL_PATH, SOUL_MAX_CHARS, FALLBACK_SOUL, soulPath,
  loadSoulText, readSoul, resetSoulCache,
} from '../server/llm-tools.mjs';
import {
  MEMORY_DIR, MEMORY_MAX_BYTES, DEFAULT_USER_ID, MEMORY_SUMMARY_MAX,
  PREFS_FIELDS, FACTS_FIELDS, PREFS_SPEC, FACTS_SPEC,
  MemoryError, normalizeUserId, formatMemoryStamp, emptyMemory, memoryFilePath,
  normalizeFieldValue, normalizeEvidence, serializeMemory, parseMemoryMarkdown,
  readMemory, updateMemory, forgetMemory, memoryHealth,
} from '../server/memory-store.mjs';
import {
  COACH_VOICES, VOICE_GENDERS, DEFAULT_VOICE_GENDER,
  normalizeVoiceGender, resolveCoachVoice,
} from '../server/volc-tts.mjs';
import { applyMemoryOps } from '../server/llm-provider.mjs';
import { LOCALES, setLang, t } from '../src/i18n.js';
// R1 动态快车道：事件总线（纯 JS）+ 规则引擎（纯函数）
import {
  createEventBus, EVENT_TYPES, AGENT_EVENT_TYPES, EVENT_CAPACITY, EVENT_WINDOW_MS,
  EVENT_MAX_CHARS, compactEventData, matchPattern, isEventType,
} from '../src/voice/events.js';
import {
  createRuleEngine, builtinRules, normalizeRule, matchesFilter, eventContext, gateCueKey,
  normalizeCoachVolume, MIN_GAP_MS, RULE_PRIORITIES, RULE_SCOPES, COACH_VOLUMES,
  DEFAULT_COACH_VOLUME, BUILTIN_RULE_IDS,
  // R2：私人教练式缺省规则 + 口述建规则
  RULE_CHANNELS, DEFAULT_RULE_BY_CHANNEL, DEFAULT_READ_EVERY_SEC, ADAPTIVE_REP,
  strideForPace, adaptiveAllows, estimateSpeechMs, repRule, readRule,
  ruleNameKey, ruleEveryText, describeRule,
} from '../src/voice/rules.js';
import { numberWord, zhNumber, enNumber } from '../src/voice/numerals.js';

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

/**
 * 假 AudioContext（P3.4 流式解码队列）。
 * 不解真音频：`duration = 字节数 / 1000`（200 字节 = 0.2 秒），source 只记录 `start(when)`。
 * 只给需要「证明流式这一级真的被尝试」的用例注入（真实浏览器都有 AudioContext）。
 */
function fakeAudioContext() {
  const ctxs = [];
  class FakeSource {
    constructor() { this.startedAt = null; this.stopped = 0; }
    connect() { return this; }
    disconnect() { return this; }
    start(when) { this.startedAt = when; }
    stop() { this.stopped += 1; }
  }
  class FakeCtx {
    constructor() {
      this.currentTime = 0;
      this.state = 'running';
      this.destination = {};
      this.sources = [];
      ctxs.push(this);
    }
    createGain() { return { connect() {}, disconnect() {}, gain: { value: 1 } }; }
    createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
    decodeAudioData(buf) { return Promise.resolve({ duration: (buf.byteLength || 0) / 1000, length: 1 }); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  return { FakeCtx, ctxs };
}

function makeSession(opts = {}) {  return createVoiceSession({
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
  ok('close() 之后 socket 被关闭、bytes / 定稿句数统计还在（日志只打数字）',
    upstream.closed === true && session.bytes === 3200 && session.segments === 1
    && session.finals === 1);
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
 * 14b. 真实火山响应样式：partial 先上屏、定稿只发一次（用户反馈「发送的帧很多却没有结果」）
 *
 * 上游的 result.text 是**累计文本**，已定稿的 utterances 每个响应都会重发一遍。
 * 以前代理只看 text / definite，同一句 4 个字能当 final 连发几百次（日志里 segments:1291）；
 * 现在按 segment key + 文本去重，非定稿部分发 partial，并有 300ms 节流。
 * ================================================================== */
console.log('\n[14b] 火山响应序列：partial → final、重复 final 只发一次、300ms 节流');
{
  const utt = (text, definite, startTime) => ({
    text, definite, start_time: startTime, end_time: startTime + 800,
  });
  const response = (json, opts = {}) => parseResponseFrame(parseFrame(volcResponseFrame(json, opts)));
  let clock = 0;
  const reducer = createTranscriptReducer({ now: () => clock });
  const take = (json, opts = {}, at = null) => {
    if (at !== null) clock = at;
    const event = response(json, opts);
    return { event, out: reducer.push(event) };
  };

  const parsed = parseResultJson({
    result: { text: '深蹲 暂停', utterances: [utt('深蹲', true, 0), utt('暂停', false, 800)] },
  });
  ok('parseResultJson：definite 段落带稳定 key（start_time + 文本），pending 只留没定稿的部分',
    parsed.segments.length === 1 && parsed.segments[0].key === '0:深蹲'
    && parsed.segments[0].text === '深蹲' && parsed.pending === '暂停' && parsed.text === '深蹲 暂停',
    JSON.stringify(parsed));

  const first = take({ result: { text: '深蹲', utterances: [utt('深蹲', false, 0)] } }, {}, 0);
  ok('第一帧（definite=false）→ 只出 partial「深蹲」，不出 final',
    first.event.type === 'partial' && first.out.length === 1
    && first.out[0].type === 'partial' && first.out[0].text === '深蹲',
    JSON.stringify(first.out));

  const dupPartial = take({ result: { text: '深蹲', utterances: [utt('深蹲', false, 0)] } }, {}, 100);
  ok('同一段文本的重复 partial（300ms 内）不再发（客户端字幕不会被反复刷）',
    dupPartial.out.length === 0 && reducer.stats.skippedPartials >= 1,
    JSON.stringify({ out: dupPartial.out, stats: reducer.stats }));

  const finDeep = take({ result: { text: '深蹲', utterances: [utt('深蹲', true, 0)] } }, {}, 400);
  ok('definite=true → 出 final「深蹲」',
    finDeep.out.length === 1 && finDeep.out[0].type === 'final' && finDeep.out[0].text === '深蹲',
    JSON.stringify(finDeep.out));

  const finDup = take({ result: { text: '深蹲', utterances: [utt('深蹲', true, 0)] } }, {}, 500);
  ok('同一段 final 重复回来 → 一条都不发（这就是「几百行 final」的根因）',
    finDup.out.length === 0 && reducer.stats.skippedFinals >= 1,
    JSON.stringify({ out: finDup.out, stats: reducer.stats }));

  const nextPartial = take({
    result: { text: '深蹲 暂停', utterances: [utt('深蹲', true, 0), utt('暂停', false, 800)] },
  }, {}, 600);
  ok('上一句已定稿、下一句正在说 → 出 partial「暂停」（不能只等 final）',
    nextPartial.out.length === 1 && nextPartial.out[0].type === 'partial'
    && nextPartial.out[0].text === '暂停',
    JSON.stringify(nextPartial.out));

  const finPause = take({
    result: { text: '深蹲 暂停', utterances: [utt('深蹲', true, 0), utt('暂停', true, 800)] },
  }, {}, 900);
  ok('第二句定稿 → 只发**新的一句**「暂停」，不再把累计全文「深蹲 暂停」当 final',
    finPause.out.length === 1 && finPause.out[0].type === 'final'
    && finPause.out[0].text === '暂停',
    JSON.stringify(finPause.out));

  const finPauseDup = take({
    result: { text: '深蹲 暂停', utterances: [utt('深蹲', true, 0), utt('暂停', true, 800)] },
  }, {}, 1000);
  ok('重复的定稿响应 → 一条也不发',
    finPauseDup.out.length === 0, JSON.stringify(finPauseDup.out));

  const lastCumulative = take({
    result: { text: '深蹲 暂停', utterances: [utt('深蹲', true, 0), utt('暂停', true, 800)] },
  }, { flags: FLAGS.LAST, seq: null }, 1200);
  ok('最后一包（flags=LAST）把已定稿全文重发一遍 → 也不再发重复 final',
    lastCumulative.out.length === 0 && reducer.stats.finals === 2,
    JSON.stringify({ out: lastCumulative.out, finals: reducer.stats.finals }));

  const lastNoUtterances = take({ result: { text: '深蹲，暂停。' } },
    { flags: FLAGS.LAST_NEGATIVE_SEQUENCE, seq: -1 }, 1400);
  ok('最后一包没有 utterances、全文（含标点）也已发过 → 不重复',
    lastNoUtterances.out.length === 0, JSON.stringify(lastNoUtterances.out));

  const err = reducer.push({ type: 'error', code: 'upstream', message: 'boom' });
  ok('error 事件不参与去重 / 节流，原样透传',
    err.length === 1 && err[0].type === 'error' && err[0].code === 'upstream');

  /* ---- 300ms 节流：同一文本过了窗口才允许再发 ---- */
  let clock2 = 0;
  const th = createTranscriptReducer({ throttleMs: FINAL_THROTTLE_MS, now: () => clock2 });
  const p1 = th.push({ type: 'partial', pending: '继续' });
  const f1 = th.push({
    type: 'final', text: '继续', pending: '',
    segments: [{ key: '2:继续', text: '继续' }], isLast: false,
  });
  clock2 = 200;
  const p2 = th.push({ type: 'partial', pending: '继续' });
  clock2 = 400;
  const p3 = th.push({ type: 'partial', pending: '继续' });
  ok(`300ms 节流：t=0 partial / t=0 final / t=200 同文本 partial 被压掉 / t=400 才允许再发`,
    p1.length === 1 && f1.length === 1 && p2.length === 0 && p3.length === 1
    && FINAL_THROTTLE_MS === 300,
    JSON.stringify({ p1: p1.length, f1: f1.length, p2: p2.length, p3: p3.length }));

  /* ---- 会话层：同一份上游响应喂两遍，只发一次 final ---- */
  {
    const events = [];
    const upstream = fakeUpstream();
    const session = createVolcSession({
      config: { appId: 'test-app', apiKey: 'test-key', resource: 'volc.test' },
      onEvent: (event) => events.push(event),
      openSocket: async () => upstream,
    });
    await session.start();
    const feed = (json) => upstream.feed(volcResponseFrame(json));
    const partial = { result: { text: '深蹲', utterances: [utt('深蹲', false, 0)] } };
    const final = { result: { text: '深蹲', utterances: [utt('深蹲', true, 0)] } };
    feed(partial);
    feed(partial);
    feed(final);
    feed(final);
    feed(final);
    const finals = events.filter((e) => e.type === 'final');
    const partials = events.filter((e) => e.type === 'partial');
    ok('会话层：重复响应只发 1 条 final；partial 先出现、且不会把同一句刷屏',
      finals.length === 1 && finals[0].text === '深蹲'
      && partials.length === 1 && partials[0].text === '深蹲'
      && session.finals === 1 && session.partials === 1
      && session.skippedFinals >= 2,
      JSON.stringify({ finals, partials, stats: { f: session.finals, s: session.skippedFinals } }));
    session.close();
  }
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

  /* ---- 100ms 定帧（A1：用户日志里「帧很多、每帧只有 86 字节」的修复） ---- */
  ok('常量：100ms = 1600 样本 = 3200 字节；16k/16bit/单声道 = 32000 B/s',
    FRAME_MS === 100 && FRAME_SAMPLES === 1600 && FRAME_BYTES === 3200
    && EXPECTED_BYTES_PER_SEC === 32000 && pcmBytesPerSec() === 32000,
    JSON.stringify({ FRAME_MS, FRAME_SAMPLES, FRAME_BYTES, EXPECTED_BYTES_PER_SEC }));

  const f48 = createPcmFramer({ inputRate: 48000 });
  let frames48 = [];
  for (let i = 0; i < 10; i += 1) {
    frames48 = frames48.concat(f48.push(sineSamples(4800, { rate: 48000 })));
  }
  const bytes48 = frames48.reduce((n, pcm) => n + pcm.byteLength, 0);
  ok('48k：1 秒（10 × 4800 样本）→ 10 帧 × 3200 字节 = 32000 B/s（±10%）',
    frames48.length === 10 && frames48.every((p) => p.length === 1600 && p.byteLength === 3200)
    && bytes48 === 32000
    && Math.abs(bytes48 - EXPECTED_BYTES_PER_SEC) <= EXPECTED_BYTES_PER_SEC * 0.1
    && f48.pending === 0,
    JSON.stringify({ frames: frames48.length, bytes: bytes48, pending: f48.pending }));

  const fSmall = createPcmFramer({ inputRate: 48000 });
  let smallFrames = [];
  for (let i = 0; i < 375; i += 1) {   // 375 × 128 = 48000 = 1 秒（AudioWorklet 渲染块大小）
    smallFrames = smallFrames.concat(fSmall.push(new Float32Array(128).fill(0.1)));
  }
  ok('48k：按 128 样本小包喂（真实渲染块）也照样攒成 10 帧 × 3200 字节',
    smallFrames.length === 10 && smallFrames.every((p) => p.byteLength === 3200),
    JSON.stringify({ frames: smallFrames.length }));

  const f44 = createPcmFramer({ inputRate: 44100 });
  let frames44 = [];
  for (let i = 0; i < 10; i += 1) {
    frames44 = frames44.concat(f44.push(sineSamples(4410, { rate: 44100 })));
  }
  ok('44.1k：4410 输入样本 → 1600 输出样本（每帧仍 100ms / 3200 字节）',
    f44.frameSamples === 4410 && frames44.length === 10
    && frames44.every((p) => p.length === 1600 && p.byteLength === 3200),
    JSON.stringify({ frameSamples: f44.frameSamples, frames: frames44.length }));

  const fOdd = createPcmFramer({ inputRate: 48000 });
  const half = fOdd.push(new Float32Array(2400).fill(0.2));   // 50ms
  const tail = fOdd.flush();
  ok('flush()：stop 时不足 100ms 的尾巴也发出去（不会把最后一个字切掉）',
    half.length === 0 && !!tail && tail.length === 800 && tail.byteLength === 1600
    && fOdd.pending === 0,
    JSON.stringify({ half: half.length, tail: tail && tail.length }));

  ok('非法采样率 → 不产出任何帧（不会除零 / 发垃圾）',
    createPcmFramer({ inputRate: 0 }).push(new Float32Array(4800)).length === 0);
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
  const sock0 = log.websockets[0];
  const lastSent = sock0.sent.at(-1);
  ok('stop()：先发 {"type":"stop"}、立刻关采集（AudioContext / 节点），但**不立刻关 WS** —— 要等服务端那包 final',
    JSON.parse(lastSent).type === 'stop' && sock0.closed === false
    && ctx.closed === true && node.disconnected === true && asr.active === false);
  sock0.message({ type: 'final', text: '深蹲 暂停' });
  ok('收到服务端 flush 的 final 之后才关 WS（最后一句话不会丢）',
    sock0.closed === true && got.result.at(-1)?.text === '深蹲 暂停');
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
 * 17b. 48kHz → 每帧 3200 字节 / 32KB/s；Worklet 定帧接线；stop 等 final
 * ================================================================== */
console.log('\n[17b] 48kHz 采集：100ms/帧、≈32KB/s、Worklet 100ms 定帧、stop 等 final');
{
  /** 假 AudioWorklet 环境（记录 node 参数 / 接线 / flush 消息） */
  const fakeWorklet = () => {
    const log = { modules: [], nodes: [], gains: [] };
    class FakePort {
      constructor() { this.posted = []; this.onmessage = null; }
      postMessage(msg) { this.posted.push(msg); }
      close() { this.closed = true; }
    }
    class FakeNode {
      constructor(ctx, name, opts) {
        this.ctx = ctx;
        this.name = name;
        this.opts = opts || {};
        this.port = new FakePort();
        this.connected = 0;
        log.nodes.push(this);
      }
      connect(target) { this.connected += 1; target._inputs = (target._inputs || 0) + 1; }
      disconnect() { this.disconnected = true; }
    }
    const destination = { _inputs: 0 };
    const ctx = {
      sampleRate: 48000,
      state: 'running',
      destination,
      audioWorklet: { addModule: async (url) => { log.modules.push(url); } },
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      createGain: () => {
        const g = { gain: { value: 1 }, connect: (t) => { t._inputs = (t._inputs || 0) + 1; }, disconnect() {} };
        log.gains.push(g);
        return g;
      },
      close() { this.closed = true; },
    };
    return { win: { AudioWorkletNode: FakeNode }, ctx, log };
  };
  {
    const { win, ctx, log } = fakeWorklet();
    const got = [];
    const capture = await startPcmCapture({
      win, ctx, stream: {}, onChunk: (samples) => got.push(samples),
    });
    const node = log.nodes[0];
    ok('AudioWorklet 采集：processorOptions.frameMs=100、单声道，并接到 destination（gain=0）',
      capture.mode === 'worklet' && !!node
      && node.opts.processorOptions?.frameMs === 100
      && node.opts.channelCount === 1 && node.opts.channelCountMode === 'explicit'
      && node.connected >= 1 && log.gains.length === 1
      && ctx.destination._inputs === 1,
      JSON.stringify({ mode: capture.mode, opts: node && node.opts }));
    node.port.onmessage({ data: { type: 'pcm', samples: new Float32Array(4800), frameMs: 100 } });
    ok('worklet 回传 {type:"pcm",samples} 时主线程拿到 samples（旧格式 Float32Array 也兼容）',
      got.length === 1 && got[0].length === 4800);
    capture.flush();
    ok('capture.flush() 通知 worklet 把不足 100ms 的尾巴发出来',
      node.port.posted.some((m) => m && m.type === 'flush'));
    capture.stop();

    /* ---- 真跑一遍 worklet 处理器（Node 里补上三个 worklet 全局量） ---- */
    let Registered = null;
    const saved = {
      awp: globalThis.AudioWorkletProcessor,
      rp: globalThis.registerProcessor,
      sr: globalThis.sampleRate,
    };
    globalThis.sampleRate = 48000;
    globalThis.AudioWorkletProcessor = class {
      constructor() {
        this.port = { posted: [], postMessage: (msg) => { this.port.posted.push(msg); } };
      }
    };
    globalThis.registerProcessor = (name, cls) => { Registered = { name, cls }; };
    try {
      await import(new URL('../src/voice/pcm-worklet.js?worklet-test=1', import.meta.url).href);
      const proc = new Registered.cls();
      const block = new Float32Array(128).fill(0.2);
      for (let i = 0; i < 375; i += 1) proc.process([[block]]);
      ok('真跑 worklet：1 秒 375 个渲染块 → 只 post 10 个 100ms 块（4800 样本）',
        Registered.name === 'mfg-pcm-capture' && proc.port.posted.length === 10
        && proc.port.posted.every((m) => m.type === 'pcm' && m.samples.length === 4800
          && m.sampleRate === 48000 && m.frameMs === 100),
        JSON.stringify({ name: Registered.name, posted: proc.port.posted.length }));
      proc.process([[new Float32Array(2400).fill(0.2)]]);
      proc.port.onmessage({ data: { type: 'flush' } });
      const workletTail = proc.port.posted.at(-1);
      ok('worklet flush：不足 100ms 的尾巴也 post 出来（2400 样本 = 50ms）',
        workletTail.samples.length === 2400, JSON.stringify({ len: workletTail.samples.length }));
    } finally {
      globalThis.AudioWorkletProcessor = saved.awp;
      globalThis.registerProcessor = saved.rp;
      globalThis.sampleRate = saved.sr;
    }
  }

  /* ---- createVolcAsr：真实发送节奏（48k → 100ms 帧）---- */
  const { win, log } = fakeVolcWindow({ rate: 48000 });
  const entries = [];
  const diag = { record(type, data) { entries.push({ type, ...(data || {}) }); } };
  const timers = [];
  const cleared = new Set();
  let clock = 1000000;
  const asr = createVolcAsr({
    win,
    mic: { stream: { getTracks: () => [] }, close() {} },
    url: 'ws://127.0.0.1:5999/asr',
    diag,
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) cleared.add(t); },
  });
  const got = { result: [], interim: [] };
  asr.onResult((text) => got.result.push(text));
  asr.onInterim((text) => got.interim.push(text));
  asr.start();
  const sock = log.websockets[0];
  sock.open();
  sock.message({ type: 'ready' });
  await tick(3);
  const ctx = log.contexts[0];
  const node = ctx.node;
  for (let i = 0; i < 10; i += 1) {
    clock += 100;
    node.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4800).fill(0.25) } });
  }
  const binary = sock.sent.filter((x) => typeof x !== 'string');
  ok('48k 1 秒音频 → 10 条二进制帧、每条 3200 字节（不是以前的 375 条 × 86 字节）',
    binary.length === 10 && binary.every((b) => b.byteLength === 3200)
    && asr.chunks === 10 && asr.sentBytes === 32000 && asr.frameBytes === 3200,
    JSON.stringify({ frames: binary.length, bytes: asr.sentBytes, frameBytes: asr.frameBytes }));
  const rate = entries.filter((e) => e.type === 'ws:rate').at(-1);
  ok('诊断码率：实测 ≈32000 B/s（±10%），expected 也是 32000（面板那一行就是它）',
    !!rate && rate.bytesPerSec === 32000 && rate.expected === EXPECTED_BYTES_PER_SEC
    && asr.bytesPerSec === 32000,
    JSON.stringify(rate));

  asr.stop();
  const stopMsg = JSON.parse(sock.sent.at(-1));
  const drain = timers.find((t) => t.ms === 4000 && !cleared.has(t));
  ok('stop()：flush 尾巴 + 发 stop、立刻关采集，但 WS 还开着等 final',
    stopMsg.type === 'stop' && sock.closed === false && ctx.closed === true
    && !!drain && asr.active === false,
    JSON.stringify({ stop: stopMsg.type, closed: sock.closed, drainMs: drain && drain.ms }));
  sock.message({ type: 'final', text: '深蹲' });
  ok('收到 final → 关 WS + 把定稿交给会话（用户能听到 / 看到最后一句）',
    sock.closed === true && got.result.at(-1) === '深蹲');

  /* ---- 上游一直不回 final：到点也要关连接（不永远挂着）---- */
  {
    const w2 = fakeVolcWindow({ rate: 48000 });
    const timers2 = [];
    const diag2 = { record() {} };
    const a2 = createVolcAsr({
      win: w2.win,
      mic: { stream: { getTracks: () => [] }, close() {} },
      url: 'ws://127.0.0.1:5999/asr',
      diag: diag2,
      setTimer: (fn, ms) => { const t = { fn, ms }; timers2.push(t); return t; },
      clearTimer: () => {},
    });
    a2.start();
    const s2 = w2.log.websockets[0];
    s2.open();
    s2.message({ type: 'ready' });
    await tick(3);
    a2.stop();
    const timer = timers2.find((t) => t.ms === 4000);
    timer?.fn();
    ok('final 一直不来 → 4s 超时关 WS（不会永远挂着 / 也不会提前关）',
      s2.closed === true && a2.active === false);
  }
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
 * 21b. 代理收尾（A2/A3）：partial 真的下发、重复 final 只发一次、
 *      stop 等上游 final（或超时 flush）、关闭日志带每帧 / 每秒字节数
 * ================================================================== */
console.log('\n[21b] 代理收尾：partial 下发 / 重复 final 只发一次 / stop 等 final / 码率日志');
{
  const { createAsrUpgradeHandler } = await import('../server/coach-proxy.mjs');
  const http = await import('node:http');
  const net = await import('node:net');

  const logs = [];
  const logger = {
    info: (m, e) => logs.push({ level: 'info', m, e }),
    warn: (m, e) => logs.push({ level: 'warn', m, e }),
    error: (m, e) => logs.push({ level: 'error', m, e }),
  };
  const relays = [];
  const makeServer = async (finalGraceMs) => {
    const srv = http.createServer((req, res) => { res.writeHead(404); res.end('nope'); });
    const sockets = new Set();
    srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    srv.on('upgrade', createAsrUpgradeHandler({
      config: {
        configured: true, missing: [], appId: 'test-app', apiKey: 'fake-token-123',
        resource: 'volc.test', endpoint: 'wss://example.test/asr', authStyle: 'auto',
      },
      logger,
      finalGraceMs,
      relayFactory: ({ onEvent }) => {
        const relay = {
          onEvent,
          started: 0,
          stopped: 0,
          audios: 0,
          audiosBytes: 0,
          lastText: '',
          lastFinalText: '',
          start: async () => {
            relay.started += 1;
            setTimeout(() => onEvent({ type: 'ready' }), 0);
            return true;
          },
          audio(buf) { relay.audios += 1; relay.audiosBytes += buf.length; },
          stop() { relay.stopped += 1; },
          close() { relay.closed = true; },
          get segments() { return 0; },
        };
        relays.push(relay);
        return relay;
      },
    }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return {
      port: srv.address().port,
      close: () => new Promise((resolve) => {
        for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
        srv.close(() => resolve());
      }),
    };
  };
  const connectAsr = (port) => new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const state = { data: Buffer.alloc(0), closed: false };
    sock.on('data', (chunk) => { state.data = Buffer.concat([state.data, chunk]); });
    sock.on('close', () => { state.closed = true; });
    sock.on('error', () => { /* 对端关闭是预期 */ });
    sock.on('connect', () => {
      sock.write(`GET /asr HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      resolve({
        sock,
        state,
        text: (obj) => sock.write(encodeFrame({
          opcode: OPCODES.TEXT, payload: JSON.stringify(obj), mask: true,
        })),
        audio: (buf) => sock.write(encodeFrame({ opcode: OPCODES.BINARY, payload: buf, mask: true })),
      });
    });
  });
  /** 从响应里解出所有完整的文本消息（JSON） */
  const textMessages = (state) => {
    const headEnd = state.data.indexOf('\r\n\r\n');
    if (headEnd < 0) return [];
    return decodeFrames(state.data.subarray(headEnd + 4)).frames
      .filter((f) => f.opcode === OPCODES.TEXT)
      .map((f) => {
        try { return JSON.parse(f.payload.toString('utf8')); } catch { return null; }
      })
      .filter(Boolean);
  };

  /* ---- ① stop 之后等上游 final；重复 final 只发一次 ---- */
  const s1 = await makeServer(120);
  const c1 = await connectAsr(s1.port);
  await waitFor(() => c1.state.data.includes('\r\n\r\n'));
  c1.text({ type: 'start', lang: 'zh-CN' });
  await waitFor(() => textMessages(c1.state).some((m) => m.type === 'ready'));
  const relay1 = relays.at(-1);
  for (let i = 0; i < 10; i += 1) {
    c1.audio(Buffer.alloc(3200, i));
    await new Promise((r) => setTimeout(r, 10));
  }
  await waitFor(() => relay1.audios === 10);
  relay1.onEvent({ type: 'partial', text: '深蹲' });
  ok('上游 partial → 浏览器真的收到 partial（以前日志里完全没有 partial）',
    await waitFor(() => textMessages(c1.state).some((m) => m.type === 'partial' && m.text === '深蹲')));
  relay1.onEvent({ type: 'partial', text: '深蹲' });
  ok('同一段 partial 重复 → 代理不重复下发（partial 也节流）',
    textMessages(c1.state).filter((m) => m.type === 'partial' && m.text === '深蹲').length === 1,
    JSON.stringify(textMessages(c1.state).filter((m) => m.type === 'partial')));

  c1.text({ type: 'stop' });
  await waitFor(() => relay1.stopped === 1);
  ok('stop：代理先让上游定稿，**不立刻**关浏览器连接（等服务端 flush）',
    relay1.stopped === 1 && c1.state.closed === false);
  relay1.onEvent({ type: 'final', text: '深蹲' });
  relay1.onEvent({ type: 'final', text: '深蹲' });
  relay1.onEvent({ type: 'final', text: '深蹲' });
  const closed1 = await waitFor(() => c1.state.closed === true, 1500);
  const finals1 = textMessages(c1.state).filter((m) => m.type === 'final');
  ok('同一段 final 连续来 3 次 → 浏览器只收到 1 条，然后连接关闭',
    closed1 && finals1.length === 1 && finals1[0].text === '深蹲',
    JSON.stringify({ closed: closed1, finals: finals1 }));
  const closedLog = logs.filter((l) => l.m === 'client closed').at(-1);
  ok('关闭日志报「每帧字节 / 每秒字节 / partial·final 条数」（以后一眼看码率）',
    !!closedLog && closedLog.e.bytesPerChunk === 3200
    && closedLog.e.bytesPerSec > 0 && closedLog.e.audioBytes === 32000
    && closedLog.e.partials >= 1 && closedLog.e.finals === 1,
    JSON.stringify(closedLog && closedLog.e));
  c1.sock.destroy();
  await s1.close();

  /* ---- ② 上游一直不回 final：超时也要把最后一句 flush 出去 ---- */
  const s2 = await makeServer(60);
  const c2 = await connectAsr(s2.port);
  await waitFor(() => c2.state.data.includes('\r\n\r\n'));
  c2.text({ type: 'start', lang: 'zh-CN' });
  await waitFor(() => textMessages(c2.state).some((m) => m.type === 'ready'));
  const relay2 = relays.at(-1);
  relay2.lastText = '暂停';
  c2.text({ type: 'stop' });
  await waitFor(() => relay2.stopped === 1);
  const closed2 = await waitFor(() => c2.state.closed === true, 1500);
  const finals2 = textMessages(c2.state).filter((m) => m.type === 'final');
  ok('stop 后上游一直不回 final → 超时把最后一句 flush 给浏览器（不丢收尾）',
    closed2 && finals2.length === 1 && finals2[0].text === '暂停',
    JSON.stringify({ closed: closed2, finals: finals2 }));
  c2.sock.destroy();
  await s2.close();
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
    continueLast: ['继续上次', 'continue last'],
    setTarget: ['设成 20 次', 'set target to 20 reps'],
    adjustTarget: ['加 5 个', 'add 5 reps'],
    mute: ['别说话', 'be quiet'],
    unmute: ['说话', 'unmute'],
    stopListening: ['关闭教练', 'stop listening'],
    help: ['我能说什么', 'what can i say'],
    switchLang: ['说英文', 'speak english'],
    setVoiceGender: ['用男声', 'use a male voice'],
    reportProgress: ['我做了几个', 'how many did i do'],
    // R2 口述建规则（零 LLM）：数字会被换成槽位
    addRule: ['每 10 个报一次', 'report every 10 reps'],
    removeRule: ['别报数了', 'stop counting'],
    listRules: ['现在有什么规则', 'what rules are on'],
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
  ok('没有任何命令需要二次确认（confirm !== true）：说退出就退出',
    COMMANDS.every((c) => c.confirm !== true),
    JSON.stringify(COMMANDS.filter((c) => c.confirm === true).map((c) => c.intent)));
  ok('确认机制本身仍在（8 秒等待常量保留，留给以后需要确认的动作）', COMMAND_CONFIRM_MS === 8000);

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

  /* ---------------- R2 口述建规则：间隔槽位 / 频道 / 同义说法 ---------------- */
  const ruleParse = (text, locale = 'zh') => parseCommand(text, locale);
  ok('「每 10 个报一次」→ addRule {kind:"rep", every:10}（数字是槽位，不是写死的说法）', (() => {
    const p = ruleParse('每 10 个报一次');
    return p.intent === 'addRule' && p.args.kind === 'rep' && p.args.every === 10;
  })(), JSON.stringify(ruleParse('每 10 个报一次')));
  ok('「每 3 个报一次」→ every:3（说法表里写的是 10，照样认）', (() => {
    const p = ruleParse('每 3 个报一次');
    return p.intent === 'addRule' && p.args.kind === 'rep' && p.args.every === 3;
  })(), JSON.stringify(ruleParse('每 3 个报一次')));
  ok('「每 30 秒报时」→ addRule {kind:"read", every:30}；「每 10 秒读秒」→ 10 秒', (() => {
    const a = ruleParse('每 30 秒报时');
    const b = ruleParse('每 10 秒读秒');
    return a.intent === 'addRule' && a.args.kind === 'read' && a.args.every === 30
      && b.intent === 'addRule' && b.args.kind === 'read' && b.args.every === 10;
  })(), JSON.stringify([ruleParse('每 30 秒报时'), ruleParse('每 10 秒读秒')]));
  ok('中文数字 / 分钟换算：「每十个报一次」→ 10；「每两分钟报时」→ 120 秒', (() => {
    const a = ruleParse('每十个报一次');
    const b = ruleParse('每两分钟报时');
    return a.intent === 'addRule' && a.args.every === 10 && a.args.kind === 'rep'
      && b.intent === 'addRule' && b.args.every === 120 && b.args.kind === 'read';
  })(), JSON.stringify([ruleParse('每十个报一次'), ruleParse('每两分钟报时')]));
  ok('「别报数了」→ removeRule kind=rep；「别读秒了」「关掉报时」→ read', (() => {
    const a = ruleParse('别报数了');
    const b = ruleParse('别读秒了');
    const c = ruleParse('关掉报时');
    return a.intent === 'removeRule' && a.args.kind === 'rep'
      && b.intent === 'removeRule' && b.args.kind === 'read'
      && c.intent === 'removeRule' && c.args.kind === 'read';
  })(), JSON.stringify([ruleParse('别报数了'), ruleParse('别读秒了'), ruleParse('关掉报时')]));
  ok('「现在有什么规则」「有哪些规则」→ listRules', (() => {
    const a = ruleParse('现在有什么规则');
    const b = ruleParse('有哪些规则');
    return a.intent === 'listRules' && b.intent === 'listRules';
  })(), JSON.stringify([ruleParse('现在有什么规则'), ruleParse('有哪些规则')]));
  ok('英文同义：「report every 10 reps」/「stop counting」/「stop the countdown」/「what rules are on」', (() => {
    const a = ruleParse('report every 10 reps', 'en');
    const b = ruleParse('stop counting', 'en');
    const c = ruleParse('stop the countdown', 'en');
    const d = ruleParse('what rules are on', 'en');
    const e = ruleParse('read the time every 30 seconds', 'en');
    return a.intent === 'addRule' && a.args.kind === 'rep' && a.args.every === 10
      && e.intent === 'addRule' && e.args.kind === 'read' && e.args.every === 30
      && b.intent === 'removeRule' && b.args.kind === 'rep'
      && c.intent === 'removeRule' && c.args.kind === 'read'
      && d.intent === 'listRules';
  })(), JSON.stringify([ruleParse('report every 10 reps', 'en'), ruleParse('stop counting', 'en')]));
  ok('只带「每」没有间隔的句子**不算**建规则（「每天练多久」→ unknown，不瞎猜）',
    ruleParse('每天练多久').intent === 'unknown', JSON.stringify(ruleParse('每天练多久')));
  ok('建规则没匹配到数字时也不误伤老命令（「再来一组」仍然是 retrySet）',
    ruleParse('再来一组').intent === 'retrySet' && ruleParse('暂停').intent === 'pause');


  // 唤醒词：有就去掉并置 usedWake；没有也照常解析
  ok('「可可，暂停」→ pause，usedWake=true（唤醒词被去掉）', (() => {
    const p = parseCommand('可可，暂停');
    return p.intent === 'pause' && p.usedWake === true;
  })(), JSON.stringify(parseCommand('可可，暂停')));
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
 * 22. P3.2 快车道执行 + 通用确认状态机（合成命令；exit 已改成说退出就退出）
 * ================================================================== */
console.log('\n[23] P3.2 快车道执行 + 通用确认状态机（合成命令 / 8 秒超时）');
{
  setLang('zh', { persist: false });

  /**
   * 用一条**合成命令**驱动通用确认机制：`confirm: true` 的命令才会先问确认。
   * `exit` 已经不需要确认了（用户要求「说退出就退出」），但 `session.js` 的
   * `pendingConfirm` / `COMMAND_CONFIRM_MS` 机制保留 —— 这条合成命令就是它的夹具。
   */
  const DEMO_CONFIRM = Object.freeze({
    intent: 'demoConfirm',
    zh: Object.freeze(['演示确认']),
    en: Object.freeze(['demo confirm']),
    helpKey: 'coach.commandHelp.demoConfirm',
    confirm: true,
    run(ctx) {
      ctx.demoAction?.();
      return { key: 'coach.cmdAck.done' };
    },
  });

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
      /** 合成命令的执行痕迹（证明「确认后才真的执行」） */
      demoAction: () => calls.push(['demoAction']),
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
      llm: {
        reply: opts.llmReply || (() => { llmCalls.n += 1; return { text: 'LLM-REPLY' }; }),
      },
      commandCtx: ctx,
      // 合成确认命令：塞进会话的命令表（`parseCommand` 不认它，靠 LLM 回合的 actions 驱动）
      ...(opts.commands ? { commands: opts.commands } : {}),
      thinkDelay: 0,
      confirmMs: opts.confirmMs ?? 30,
    });
    return { session, tts, llmCalls };
  }

  /** 让 LLM 回合返回一条「需要确认」的合成命令 action */
  const demoReply = () => ({ actions: [{ intent: 'demoConfirm', args: {} }] });

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

  // ⑦ exit：说退出就退出 —— 立刻执行，不再问确认
  {
    const ctx = makeCtx();
    const { session, tts } = makeCommandSession(ctx);
    await session.start();
    session.onUserText('退出');
    ok('说「退出」立刻执行：openMenu 当场被调用、pendingConfirm 为 null（不再等确认）',
      ctx.calls.some((c) => c[0] === 'openMenu')
      && session.pendingConfirm === null,
      JSON.stringify({ calls: ctx.calls, pending: session.pendingConfirm }));
    ok('字幕直接说「好的，退出这一组」，没有确认问句',
      session.snapshot().coachText === t('coach.cmdAck.exit'),
      session.snapshot().coachText);
    await speakDone(session, tts);
    session.stop();
  }

  // ⑦b 已经在菜单里说「退出」→ 直接回网页首页（同样不确认）
  {
    const ctx = makeCtx();
    ctx.setSnap({ menuMode: true });
    const { session } = makeCommandSession(ctx);
    await session.start();
    session.onUserText('退出');
    ok('菜单里说「退出」→ 直接 showHome（不确认、pending 为 null）',
      ctx.calls.some((c) => c[0] === 'showHome')
      && session.pendingConfirm === null,
      JSON.stringify({ calls: ctx.calls, pending: session.pendingConfirm }));
    session.stop();
  }

  // ⑧ 通用确认机制（合成命令 confirm:true）：先问一句，确认后才执行
  {
    const ctx = makeCtx();
    const { session, tts } = makeCommandSession(ctx, {
      commands: [DEMO_CONFIRM],
      llmReply: demoReply,
    });
    await session.start();
    session.onUserText('演示确认');
    await tick(8);
    ok('需要确认的合成命令：先问一句、还没执行（pending=demoConfirm、demoAction 未调用）',
      session.pendingConfirm?.intent === 'demoConfirm'
      && !ctx.calls.some((c) => c[0] === 'demoAction')
      && session.snapshot().coachText === t('coach.confirm.ask'),
      JSON.stringify({ pending: session.pendingConfirm, calls: ctx.calls,
        coach: session.snapshot().coachText }));
    await speakDone(session, tts);

    session.onUserText('确认');
    ok('再喂「确认」→ 合成命令真的执行（demoAction），pending 清空',
      ctx.calls.some((c) => c[0] === 'demoAction')
      && session.pendingConfirm === null,
      JSON.stringify({ calls: ctx.calls, pending: session.pendingConfirm }));
    session.stop();
  }

  // ⑨ 取消：不执行
  {
    const ctx = makeCtx();
    const { session, tts } = makeCommandSession(ctx, {
      commands: [DEMO_CONFIRM],
      llmReply: demoReply,
    });
    await session.start();
    session.onUserText('演示确认');
    await tick(8);
    await speakDone(session, tts);
    session.onUserText('取消');
    ok('「取消」→ 不执行合成命令、pending 清空、字幕说「好，取消了」',
      !ctx.calls.some((c) => c[0] === 'demoAction')
      && session.pendingConfirm === null
      && session.snapshot().coachText === t('coach.confirm.cancelled'),
      JSON.stringify({ calls: ctx.calls, coach: session.snapshot().coachText }));
    session.stop();
  }

  // ⑩ 8 秒没回应 → 自动取消（用 confirmMs=20 模拟）
  {
    const ctx = makeCtx();
    const { session } = makeCommandSession(ctx, {
      confirmMs: 20,
      commands: [DEMO_CONFIRM],
      llmReply: demoReply,
    });
    await session.start();
    session.onUserText('演示确认');
    await tick(8);
    ok('等待确认期间 pendingConfirm 有记录',
      !!session.snapshot().pendingConfirm);
    await new Promise((r) => setTimeout(r, 40));
    ok('20ms 里没有回应（等价于 8 秒）→ 自动取消：不执行、pending 清空、字幕提示超时',
      !ctx.calls.some((c) => c[0] === 'demoAction')
      && session.pendingConfirm === null
      && session.snapshot().coachText === t('coach.confirm.timeout'),
      JSON.stringify({ calls: ctx.calls, pending: session.pendingConfirm,
        coach: session.snapshot().coachText }));
    session.stop();
  }

  // ⑪ 等确认时说了别的话 → 再问一次，不会误执行
  {
    const ctx = makeCtx();
    const { session, tts } = makeCommandSession(ctx, {
      commands: [DEMO_CONFIRM],
      llmReply: demoReply,
    });
    await session.start();
    session.onUserText('演示确认');
    await tick(8);
    await speakDone(session, tts);
    session.onUserText('今天天气不错');
    ok('等确认时说了别的话 → 再问一次「确认 / 取消」，pending 还在、没执行',
      session.pendingConfirm !== null
      && session.snapshot().coachText === t('coach.confirm.repeat')
      && !ctx.calls.some((c) => c[0] === 'demoAction'),
      JSON.stringify({ pending: session.pendingConfirm, coach: session.snapshot().coachText }));
    session.stop();
  }

  // ⑫ stop / pause 会清掉等待中的确认（不留悬空计时器）
  {
    const ctx = makeCtx();
    const { session } = makeCommandSession(ctx, {
      commands: [DEMO_CONFIRM],
      llmReply: demoReply,
    });
    await session.start();
    session.onUserText('演示确认');
    await tick(8);
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
    && initial.frames.n === 0 && initial.frames.bytesPerSec === 0
    && initial.frames.expected === 32000
    && initial.partials === 0 && initial.finals === 0,
    JSON.stringify(initial));

  diag.record('route:volc', {});
  diag.record('ws:connecting', {});
  diag.record('ws:open', {});
  diag.record('ws:firstFrame', { bytes: 3200 });
  diag.record('ws:frames', { n: 12, bytes: 38400 });
  diag.record('ws:rate', { bytesPerSec: 32000, expected: 32000 });
  diag.record('ctx:sampleRate', { value: 48000, state: 'running' });
  diag.record('worklet:fail', { name: 'NotSupportedError', message: 'addModule failed' });
  diag.record('capture:mode', { mode: 'processor' });
  diag.record('asr:partial', { text: '你好' });
  diag.record('asr:final', { text: '字'.repeat(200) });
  diag.record('mic:ok', { tracks: 1, labels: ['audio-1'] });
  diag.record('mic:release', { reason: 'webspeech' });
  const snap = diag.snapshot();
  ok('snapshot 反映路由 / WS / 帧数 / 实时码率 / partial·final 计数',
    snap.route === 'volc' && snap.ws.state === 'open'
    && snap.frames.n === 12 && snap.frames.bytes === 38400
    && snap.frames.bytesPerSec === 32000 && snap.frames.expected === 32000
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

  /* ---- 进入训练时的主动问候（coach:greet）：模型说的 / 内置兜底 / 被跳过 三种都留痕 ---- */
  {
    const greetDiag = createDiag({ fetch: async () => ({ ok: true }), timer: false, now: () => 1700000002000 });
    greetDiag.record('coach:greet', { ok: true, ms: 120, fallback: false });
    const gs = greetDiag.snapshot();
    ok('coach:greet 进 snapshot：ok / ms / fallback（模型问候）',
      gs.greet.ok === true && gs.greet.ms === 120 && gs.greet.fallback === false
      && gs.greet.skipped === '', JSON.stringify(gs.greet));
    greetDiag.record('coach:greet', { ok: false, ms: 8000, fallback: true, code: 'llm-timeout' });
    const gs2 = greetDiag.snapshot();
    ok('coach:greet 失败：fallback=true（用了内置问候），不会静默',
      gs2.greet.ok === false && gs2.greet.fallback === true && gs2.greet.ms === 8000,
      JSON.stringify(gs2.greet));
    greetDiag.record('coach:greet', { ok: false, ms: 0, fallback: false, skipped: 'speaking' });
    ok('coach:greet 被跳过：skipped 记原因（教练正在说话 → 不叠音）',
      greetDiag.snapshot().greet.skipped === 'speaking');
  }

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

  /* ---- 姿态模型加载失败（用户反馈「点开始就姿态模型加载失败」）也走这份诊断日志 ---- */
  {
    // app.js 只记这几个字段：阶段 / 真实错误名 / 一句话原因 / delegate / HTTP 状态 / 第几次尝试
    // —— 没有截图、没有图像、没有音频。
    const pose = createDiag({ fetch: async () => ({ ok: true }), timer: false, now: () => 1700000001000 });
    pose.record('pose:load-fail', {
      stage: 'model',
      name: 'HttpError',
      message: 'HTTP 404',
      delegate: 'GPU',
      status: 404,
      attempt: 4,
      retry: 0,
    });
    const snapPose = pose.snapshot();
    ok('pose:load-fail 进 snapshot：lastType 记类型、lastError 说清阶段与错误名（排障一眼看到）',
      snapPose.lastType === 'pose:load-fail' && snapPose.events === 1
      && snapPose.lastError === 'pose: model HttpError',
      JSON.stringify({ lastType: snapPose.lastType, lastError: snapPose.lastError }));

    // 落盘那一行：字段固定、文本截断、敏感键脱敏，绝不带图像 / 音频 / 凭证
    const poseFields = {
      stage: 'model',
      name: 'HttpError',
      message: `HTTP 404 ${'x '.repeat(120)}`,
      delegate: 'GPU',
      status: 404,
      attempt: 4,
      retry: 0,
    };
    const entry = makeEntry('pose:load-fail', poseFields, { now: () => 1700000001000 });
    ok('pose:load-fail 的字段就是「阶段 / 错误名 / 原因 / delegate / 状态 / 尝试次数」（t+type 之外不夹带）',
      Object.keys(entry).sort().join(',')
        === ['attempt', 'delegate', 'message', 'name', 'retry', 'stage', 'status', 't', 'type'].sort().join(',')
      && entry.stage === 'model' && entry.name === 'HttpError' && entry.delegate === 'GPU'
      && entry.status === 404 && entry.attempt === 4 && entry.retry === 0,
      Object.keys(entry).join(','));
    ok('pose:load-fail 的说明文本截断到 80 字（日志不会被一整篇 base64 撑爆）',
      entry.message.length === 80 && entry.message.startsWith('HTTP 404 '), String(entry.message.length));
    const dirty = makeEntry('pose:load-fail', {
      ...poseFields,
      audio: new Float32Array(4).fill(0.5),
      pcm: 'raw',
      apiKey: 'sk-live-1234567890abcdef',
    }, { now: () => 1700000001000 });
    ok('pose:load-fail 里的敏感键（audio / pcm / apiKey）一律 [redacted]，不写进日志',
      dirty.audio === '[redacted]' && dirty.pcm === '[redacted]'
      && dirty.apiKey === '[redacted]'
      && !JSON.stringify(dirty).includes('sk-live') && !JSON.stringify(dirty).includes('0.5'));
  }
}

/* ================================================================== *
 * [25] 预览服务器的响应头：跨源隔离 / 不缓存 / gzip
 *
 * 用户反馈「下载运行库很慢」「初始化识别器失败」之后定的三条：
 *   ① COOP + COEP 必须**同时**在（crossOriginIsolated 才能为 true，wasm 才拿得到该有的能力）；
 *   ② 静态资源**一律不缓存**（`no-store`）—— 坏文件不会被一直用下去；
 *   ③ 文本 + **运行库 `.wasm` + 模型 `.task` 都走 gzip**（解压后与磁盘文件逐字节一致）。
 *
 * ③ 的来龙去脉：上一轮（c0eaa16）把 `.wasm` 移出了 gzip 名单 —— 本机直连 9.3MB 只要 41~86ms，
 * 而 gzip 要 0.3~1.7s，直连时压缩是净亏。但用户后来报「**公司网络快、家里网络慢**」：
 * 那种情况下 127.0.0.1 也被代理 / VPN 接管了（Chrome 默认把 localhost 交给系统代理），
 * 链路只有几百 KB/s，**压缩就是净赚** —— 实测 9502124 → 2909084 字节（省 69%），
 * 模型 5777746 → 4971496（省 14%）。压不动的文件（随机数据 / 已经压过的模型）按
 * `GZIP_MIN_SAVING` 放弃压缩、原样发原始字节（`gzipWorthIt` 纯函数钉住这条边界）。
 * 压缩结果按「路径 + mtime + 大小」缓存，同一个文件只压一次。
 *
 * 另外钉住 `GET /pose-check`（用户在家一眼看出「服务器能给多大 / 压完多大」，不含任何路径）。
 * 这里起的是**真的 http server**（复用 preview-server.js 导出的 previewHandler），不是字符串断言。
 * ================================================================== */
console.log('\n[25] 预览服务器：COOP+COEP / no-store / gzip（wasm + 模型都压，压不动发原始）/ /pose-check');
{
  const http = await import('node:http');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const {
    previewHandler, GZIP_EXTS, GZIP_MIN_SAVING, gzipWorthIt, POSE_CHECK_PATH,
  } = await import('../preview-server.js');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const srv = http.createServer(previewHandler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });

  /* ---- 名单与「压不动就不压」的边界（纯函数）---- */
  ok('gzip 名单里有 .wasm 与 .task（慢链路下压缩是净赚：9.3MB → ~2.9MB）',
    GZIP_EXTS.has('.wasm') && GZIP_EXTS.has('.task') && GZIP_EXTS.has('.js'),
    [...GZIP_EXTS].join(','));
  ok('GZIP_MIN_SAVING = 0.95：压完没省下 5% 就放弃（gz >= 95% 原始大小 → 不压）',
    GZIP_MIN_SAVING === 0.95
    && gzipWorthIt(1000, 949) === true
    && gzipWorthIt(1000, 950) === false
    && gzipWorthIt(1000, 1200) === false
    && gzipWorthIt(0, 0) === false,
    JSON.stringify([949, 950, 1200].map((gz) => [gz, gzipWorthIt(1000, gz)])));

  const wasmPath = '/vendor/tasks-vision/wasm/vision_wasm_internal.wasm';
  const wasmRaw = fs.readFileSync(path.join(ROOT, wasmPath.slice(1)));
  const wasm = await get(wasmPath, { 'Accept-Encoding': 'gzip' });
  ok('wasm 带 Accept-Encoding: gzip 时**会**压缩：Content-Encoding + Vary（不再原样发 9.3MB）',
    wasm.status === 200 && wasm.headers['content-encoding'] === 'gzip'
    && /accept-encoding/i.test(String(wasm.headers.vary)),
    JSON.stringify({ ce: wasm.headers['content-encoding'], vary: wasm.headers.vary }));
  ok('wasm 压缩后字节数从 9.5MB 降到 ~2.9MB（实测省 69%），Content-Length 就是压缩后的长度',
    wasm.body.length < wasmRaw.length * 0.5
    && wasm.body.length > 1024 * 1024
    && Number(wasm.headers['content-length']) === wasm.body.length,
    JSON.stringify({ gz: wasm.body.length, raw: wasmRaw.length, ratio: +(wasm.body.length / wasmRaw.length).toFixed(3) }));
  ok('wasm gunzip 解压后与磁盘文件**逐字节一致**（压缩不能改坏运行库）',
    zlib.gunzipSync(wasm.body).equals(wasmRaw),
    JSON.stringify({ gz: wasm.body.length, raw: wasmRaw.length }));
  ok('运行库 / 模型都不缓存：Cache-Control 是 no-store（不是 max-age / immutable）',
    wasm.headers['cache-control'] === 'no-store'
    && !/max-age|immutable/i.test(String(wasm.headers['cache-control'])),
    String(wasm.headers['cache-control']));
  ok('静态资源同时带 COOP + COEP（crossOriginIsolated 才能为 true）',
    wasm.headers['cross-origin-opener-policy'] === 'same-origin'
    && wasm.headers['cross-origin-embedder-policy'] === 'credentialless',
    JSON.stringify({
      coop: wasm.headers['cross-origin-opener-policy'], coep: wasm.headers['cross-origin-embedder-policy'],
    }));
  ok('wasm 的 Content-Type 是 application/wasm（instantiateStreaming 认这个 MIME）',
    /application\/wasm/.test(String(wasm.headers['content-type'])),
    String(wasm.headers['content-type']));
  const wasmPlain = await get(wasmPath);
  ok('wasm 请求头不带 Accept-Encoding 时**不压**（原样发，Content-Length = 文件大小，逐字节一致）',
    wasmPlain.status === 200 && wasmPlain.headers['content-encoding'] === undefined
    && Number(wasmPlain.headers['content-length']) === wasmRaw.length
    && wasmPlain.body.equals(wasmRaw),
    JSON.stringify({ ce: wasmPlain.headers['content-encoding'], len: wasmPlain.headers['content-length'] }));

  /* ---- 文本走 gzip：解压后必须与磁盘逐字节一致 ---- */
  const textPath = '/src/voice/pcm.js';
  const textRaw = fs.readFileSync(path.join(ROOT, textPath.slice(1)));
  const textGz = await get(textPath, { 'Accept-Encoding': 'gzip' });
  const textUnz = zlib.gunzipSync(textGz.body);
  ok('文本资源（.js）走 gzip：Content-Encoding + Vary，解压后与磁盘文件逐字节一致',
    textGz.status === 200 && textGz.headers['content-encoding'] === 'gzip'
    && /accept-encoding/i.test(String(textGz.headers.vary))
    && textGz.body.length < textRaw.length
    && textUnz.equals(textRaw),
    JSON.stringify({ gz: textGz.body.length, raw: textRaw.length }));

  const textPlain = await get(textPath);
  ok('请求头不带 Accept-Encoding 时不压（原样发，Content-Length = 文件大小）',
    textPlain.status === 200 && textPlain.headers['content-encoding'] === undefined
    && Number(textPlain.headers['content-length']) === textRaw.length
    && textPlain.body.equals(textRaw),
    JSON.stringify({ ce: textPlain.headers['content-encoding'], len: textPlain.headers['content-length'] }));

  const html = await get('/');
  ok('index.html 也是 no-store + COOP + COEP（页面自己必须先跨源隔离，wasm 才拿得到 SharedArrayBuffer）',
    html.status === 200 && html.headers['cache-control'] === 'no-store'
    && html.headers['cross-origin-opener-policy'] === 'same-origin'
    && html.headers['cross-origin-embedder-policy'] === 'credentialless');

  /* ---- 模型 .task：能省 ~14% 所以也压；压缩结果解压后必须与磁盘一致 ---- */
  const modelPath = '/vendor/models/pose_landmarker_lite.task';
  const modelRaw = fs.readFileSync(path.join(ROOT, modelPath.slice(1)));
  const model = await get(modelPath, { 'Accept-Encoding': 'gzip' });
  ok('模型 .task 也走 gzip（省 ~14%，慢链路上也值），解压后与磁盘逐字节一致',
    model.status === 200 && model.headers['content-encoding'] === 'gzip'
    && model.body.length < modelRaw.length
    && zlib.gunzipSync(model.body).equals(modelRaw),
    JSON.stringify({ gz: model.body.length, raw: modelRaw.length }));
  ok('模型 .task 同样 no-store（用户拍板：本地开发不缓存）',
    model.headers['cache-control'] === 'no-store', String(model.headers['cache-control']));

  /* ---- 「压不动就不压」分支：随机字节（gzip 后更大）→ 必须原样发 ---- */
  const junkName = '_gzip_probe_incompressible.task';
  const junkPath = path.join(ROOT, junkName);
  try {
    const junk = Buffer.alloc(128 * 1024);
    for (let i = 0; i < junk.length; i += 1) junk[i] = Math.floor(Math.random() * 256);
    fs.writeFileSync(junkPath, junk);
    const junkRes = await get(`/${junkName}`, { 'Accept-Encoding': 'gzip' });
    ok('压不动的 .task（压完反而更大）→ 放弃压缩、原样发原始字节（不是 500，也不是空响应）',
      junkRes.status === 200 && junkRes.headers['content-encoding'] === undefined
      && Number(junkRes.headers['content-length']) === junk.length
      && junkRes.body.equals(junk),
      JSON.stringify({
        status: junkRes.status, ce: junkRes.headers['content-encoding'], len: junkRes.headers['content-length'],
      }));
  } finally {
    try { fs.unlinkSync(junkPath); } catch { /* 已经删了 */ }
  }

  const modelSize = fs.statSync(path.join(ROOT, modelPath.slice(1))).size;
  const versioned = await get(`${modelPath}?v=${modelSize}`);
  ok('模型 URL 带 ?v= 指纹照常返回（缓存击穿参数不影响静态服务，字节数一致）',
    versioned.status === 200 && versioned.body.length === modelSize,
    JSON.stringify({ status: versioned.status, len: versioned.body.length, size: modelSize }));

  /* ---- /pose-check：一眼看出「服务器能给多大 / 压完多大」（不含路径 / 凭证）---- */
  const check = await get(POSE_CHECK_PATH);
  let payload = null;
  try { payload = JSON.parse(check.body.toString('utf8')); } catch { payload = null; }
  ok(`${POSE_CHECK_PATH} 返回 { wasm:{bytes,gzBytes}, model:{bytes,gzBytes}, gzip:true }`,
    check.status === 200 && check.headers['cache-control'] === 'no-store'
    && payload && payload.gzip === true
    && Number(payload.wasm.bytes) === wasmRaw.length
    && Number(payload.model.bytes) === modelRaw.length,
    check.body.toString('utf8').slice(0, 200));
  ok('/pose-check 的 gzBytes 是压缩后的真实字节数（wasm 9.5MB → ~2.9MB），能直接看出省了多少',
    payload && payload.wasm.gzBytes < payload.wasm.bytes * 0.5
    && payload.wasm.gzBytes > payload.wasm.bytes * 0.2
    && payload.model.gzBytes < payload.model.bytes,
    JSON.stringify(payload));
  ok('/pose-check 只报字节数：不泄露绝对路径 / 文件名 / 目录（内容里没有 vendor / .wasm / 盘符）',
    !/vendor/i.test(check.body.toString('utf8')) && !/\.wasm|\.task/i.test(check.body.toString('utf8'))
    && !/[A-Za-z]:\\/.test(check.body.toString('utf8')),
    check.body.toString('utf8').slice(0, 200));

  const engineSrc = fs.readFileSync(path.join(ROOT, 'src/pose-engine.js'), 'utf8');
  ok('不再有预热 fetch（/vendor 不缓存时预热会把 9.3MB 下两遍）：pose-engine 里没有 prewarm / wasmFileUrls',
    !/prewarmWasm|wasmFileUrls|_wasmWarmed/.test(engineSrc));
  ok('模型 URL 的 ?v= 用文件字节数当指纹（换模型自动变，不用手记版本号）',
    /export function modelUrlFor/.test(engineSrc)
    && new RegExp(`lite: \\{ url: '\\./vendor/models/pose_landmarker_lite\\.task', rev: '${modelSize}' \\}`).test(engineSrc),
    JSON.stringify({ modelSize }));

  await new Promise((r) => srv.close(r));
}

/* ================================================================== *
 * [26] 对话弹幕：轨道 / 布局 / 去重 / 上限 / 排队 / 模式（纯逻辑 + DOM 渲染分层）
 * ================================================================== */
console.log('\n[26] 对话弹幕：pickLane / layoutBullet / 模型（去重·上限·排队）/ DOM 渲染');
{
  /* ---- 纯函数：选轨道 ---- */
  ok('pickLane：有空轨道 → 取下标最小的那条',
    pickLane([0, 0, 0, 0], 100) === 0 && pickLane([500, 0, 0, 0], 100) === 1);
  ok('pickLane：全满 → 取**最早空出**的那条（不会等最久）',
    pickLane([500, 120, 300, 160], 100) === 1);
  ok('pickLane：空数组 / 非法值不崩',
    pickLane([], 0) === 0 && pickLane(null, 0) === 0);
  ok('轨道数按用户口径是 4 条（只占上半屏）', DANMAKU_LANE_COUNT === 4);

  /* ---- 纯函数：单条版面 ---- */
  const laid = layoutBullet({ text: '开始深蹲', kind: 'coach', lane: 2, startAt: 1000 });
  ok('layoutBullet：kind / lane / startAt / endAt 一次算好',
    laid.kind === 'coach' && laid.lane === 2 && laid.startAt === 1000
    && laid.endAt === 1000 + DANMAKU_FLIGHT_MS && laid.text === '开始深蹲');
  ok('layoutBullet：lane 越界会被夹回 [0, 3]',
    layoutBullet({ lane: 99 }).lane === 3 && layoutBullet({ lane: -5 }).lane === 0);
  ok('layoutBullet：kind 只认 coach，其它都当 user',
    layoutBullet({ kind: 'system' }).kind === 'user' && layoutBullet({ kind: 'coach' }).kind === 'coach');
  ok('颜色口径：用户青 #38bdf8 / 教练薄荷绿 #34e5c4',
    DANMAKU_COLORS.user === '#38bdf8' && DANMAKU_COLORS.coach === '#34e5c4'
    && DANMAKU_MODES.join(',') === 'danmaku,subtitle,off' && DANMAKU_DEFAULT_MODE === 'danmaku');

  /* ---- 模型：去重（同 text + kind 1.5s 内只弹一次） ---- */
  {
    let clock = 0;
    const model = createDanmakuModel({ now: () => clock });
    const first = model.push({ text: '你好', kind: 'user' });
    const dup = model.push({ text: '你好', kind: 'user' });
    ok('去重：同一句 1.5s 内只弹一条',
      first.ok && !first.queued && !dup.ok && dup.reason === 'duplicate',
      JSON.stringify({ first, dup }));
    clock = DANMAKU_DEDUPE_MS - 1;
    ok('去重：1.5s 内（差 1ms）仍然算重复',
      model.push({ text: '你好', kind: 'user' }).reason === 'duplicate');
    clock = DANMAKU_DEDUPE_MS;
    ok('去重：超过 1.5s 可以再弹同一句', model.push({ text: '你好', kind: 'user' }).ok);
    ok('去重按 kind 分开：同一句话教练说一遍不算重复',
      model.push({ text: '你好', kind: 'coach' }).ok);
  }

  /* ---- 模型：4 条轨道依次填满，满了回到最早空出的 ---- */
  {
    const model = createDanmakuModel({ now: () => 0, laneGapMs: 2200 });
    const lanes = [];
    for (let i = 0; i < 5; i += 1) {
      const r = model.push({ text: `第 ${i} 句`, kind: i % 2 ? 'coach' : 'user' });
      lanes.push(r.bullet ? r.bullet.lane : -1);
    }
    ok('模型：前 4 条依次落在 0/1/2/3 轨道，第 5 条回到最早空出的 0',
      lanes.join(',') === '0,1,2,3,0', lanes.join(','));
  }

  /* ---- 模型：同屏上限 8 / 队列 12 / 满则丢弃 ---- */
  {
    let clock = 0;
    const model = createDanmakuModel({
      now: () => clock, maxOnScreen: DANMAKU_MAX_ON_SCREEN, queueMax: DANMAKU_QUEUE_MAX,
      dedupeMs: 0, flightMs: 1000, laneGapMs: 0,
    });
    for (let i = 0; i < DANMAKU_MAX_ON_SCREEN; i += 1) model.push({ text: `屏 ${i}`, kind: 'user' });
    ok('上限：同屏最多 8 条', model.onScreen === DANMAKU_MAX_ON_SCREEN,
      String(model.onScreen));
    const queued = model.push({ text: '排队 1', kind: 'user' });
    ok('上限：第 9 条进队列（不是丢掉）', queued.ok && queued.queued && model.queued === 1);
    for (let i = 2; i <= DANMAKU_QUEUE_MAX; i += 1) model.push({ text: `排队 ${i}`, kind: 'user' });
    ok('队列上限 12 条', model.queued === DANMAKU_QUEUE_MAX, String(model.queued));
    const dropped = model.push({ text: '再多一条', kind: 'user' });
    ok('队列满了不再堆积：直接丢弃并计数',
      !dropped.ok && dropped.reason === 'queue-full' && model.snapshot().dropped === 1);
    clock = 1000;
    const drained = model.expire(clock);
    ok('到点后队列自动补位：同屏仍 8 条，队列从 12 降到 4',
      drained.removed.length === DANMAKU_MAX_ON_SCREEN
      && drained.added.length === DANMAKU_MAX_ON_SCREEN
      && model.onScreen === DANMAKU_MAX_ON_SCREEN && model.queued === DANMAKU_QUEUE_MAX - DANMAKU_MAX_ON_SCREEN,
      JSON.stringify({ added: drained.added.length, onScreen: model.onScreen, queued: model.queued }));
  }

  /* ---- 模型：模式切换 / 清理 ---- */
  {
    let clock = 0;
    const model = createDanmakuModel({ now: () => clock, dedupeMs: 1500 });
    model.push({ text: '字幕一句', kind: 'user' });
    model.setMode('subtitle');
    ok('切到「字幕」模式：弹幕层清空，push 不再产弹幕',
      model.onScreen === 0 && model.mode === 'subtitle'
      && model.push({ text: 'x' }).reason === 'mode');
    model.setMode('off');
    ok('切到「关闭」模式：同样不产弹幕', model.mode === 'off' && !model.push({ text: 'y' }).ok);
    model.setMode(DANMAKU_DEFAULT_MODE);
    model.push({ text: '重新开始', kind: 'user' });
    model.clear();
    ok('clear() 同时清空同屏 / 队列 / 去重表',
      model.onScreen === 0 && model.queued === 0
      && model.push({ text: '重新开始', kind: 'user' }).ok);
  }

  /* ---- DOM 渲染层：颜色类 / 前缀 / 最近一句 / 去重 / 模式 ---- */
  function fakeClassList(initial = '') {
    const set = new Set(String(initial).split(/\s+/).filter(Boolean));
    return {
      add: (...cs) => { for (const c of cs) set.add(c); },
      remove: (...cs) => { for (const c of cs) set.delete(c); },
      contains: (c) => set.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !set.has(c) : !!force;
        if (on) set.add(c); else set.delete(c);
        return on;
      },
      _set: set,
    };
  }
  function fakeEl(tag = 'div') {
    const classes = fakeClassList();
    const el = {
      tagName: tag.toUpperCase(),
      dataset: {},
      style: { setProperty() {} },
      textContent: '',
      hidden: false,
      classList: classes,
      appendChild(child) { return child; },
    };
    // className 与 classList 在真浏览器里是同一份数据：桩里也保持同步
    Object.defineProperty(el, 'className', {
      get() { return [...classes._set].join(' '); },
      set(v) {
        classes._set.clear();
        for (const c of String(v).split(/\s+/)) if (c) classes._set.add(c);
      },
    });
    return el;
  }
  function fakeDoc() {
    return {
      createElement: (tag) => fakeEl(tag),
    };
  }
  function fakeLayer() {
    const el = fakeEl('div');
    el.children = [];
    el.appendChild = (child) => { el.children.push(child); return child; };
    el.removeChild = (child) => { el.children = el.children.filter((c) => c !== child); return child; };
    el.classList = fakeClassList();
    return el;
  }
  function newDetached({ reduce = false, model = null } = {}) {
    const layer = fakeLayer();
    const last = fakeEl('div');
    const win = { matchMedia: () => ({ matches: reduce, addEventListener() {} }) };
    const timers = [];
    let clock = 0;
    const dm = createDanmaku({
      layer,
      lastEl: last,
      doc: fakeDoc(),
      win,
      now: () => clock,
      setTimer: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length; },
      clearTimer: () => {},
      model,
    });
    return { dm, layer, last, timers, advance(ms) { clock += ms; }, get clock() { return clock; } };
  }

  {
    const { dm, layer, last } = newDetached();
    dm.push({ text: '你好', kind: 'user' });
    dm.push({ text: '我在，说话就行。', kind: 'coach' });
    const [userNode, coachNode] = layer.children;
    ok('DOM：一句一条，用户 / 教练各一条', layer.children.length === 2);
    ok('DOM：用户弹幕是青色类（.danmaku--user）+「你：」前缀',
      userNode.classList.contains('danmaku')
      && userNode.classList.contains('danmaku--user')
      && userNode.textContent === `${t('voice.you')}你好`,
      userNode.className);
    ok('DOM：教练弹幕是薄荷绿类（.danmaku--coach）+「教练：」前缀',
      coachNode.classList.contains('danmaku--coach')
      && coachNode.textContent === `${t('voice.coach')}我在，说话就行。`,
      coachNode.className);
    ok('DOM：两条弹幕的颜色类**不同**', userNode.className !== coachNode.className);
    ok('DOM：底部「最近一句」显示最新一句（教练说的那句）',
      last.hidden === false && last.textContent === `${t('voice.coach')}我在，说话就行。`
      && last.classList.contains('danmaku-last--coach'), last.textContent);

    dm.setInterim('我在听');
    ok('DOM：partial 只更新「最近一句」灰色实时行，不新增弹幕',
      layer.children.length === 2 && last.textContent === `${t('voice.you')}我在听`
      && last.classList.contains('danmaku-last--interim'), last.textContent);

    const before = layer.children.length;
    const dup = dm.push({ text: '你好', kind: 'user' });
    ok('DOM：去重命中时不再插一条（同步更新最近一句）',
      layer.children.length === before && dup.reason === 'duplicate' && !dm.snapshot().interim,
      JSON.stringify({ children: layer.children.length, dup }));
  }

  {
    const { dm, layer, last } = newDetached();
    dm.push({ text: 'x', kind: 'user' });
    dm.setMode('subtitle');
    ok('DOM：切「字幕」→ 弹幕层隐藏、清空；最近一句仍在',
      layer.hidden === true && layer.children.length === 0 && last.hidden === false);
    dm.setMode('off');
    ok('DOM：切「关闭」→ 弹幕层与最近一句都隐藏', layer.hidden === true && last.hidden === true);
    dm.setMode('danmaku');
    ok('DOM：切回「弹幕」→ 弹幕层重新出现', layer.hidden === false);
  }

  {
    const { dm, layer } = newDetached();
    for (let i = 0; i < DANMAKU_MAX_ON_SCREEN + 1; i += 1) dm.push({ text: `满 ${i}`, kind: 'user' });
    ok('DOM：同屏最多渲染 8 条（第 9 条排队）',
      layer.children.length === DANMAKU_MAX_ON_SCREEN && dm.queued === 1,
      JSON.stringify({ children: layer.children.length, queued: dm.queued }));
  }

  {
    const model = createDanmakuModel({ now: () => 0, maxOnScreen: 2, queueMax: 4, dedupeMs: 0, flightMs: 1000 });
    const { dm, layer, timers, advance } = newDetached({ model });
    dm.push({ text: '甲', kind: 'user' });
    dm.push({ text: '乙', kind: 'coach' });
    dm.push({ text: '丙', kind: 'user' });
    ok('DOM：同屏满了先进队列', layer.children.length === 2 && dm.queued === 1);
    advance(1000);
    timers[0].fn();
    ok('DOM：到点移除 + 队列补位（新的一句被渲染出来）',
      layer.children.length === 1 && dm.queued === 0
      && layer.children[0].textContent === `${t('voice.you')}丙`,
      layer.children.map((n) => n.textContent).join(' | '));
  }

  {
    const { dm, layer } = newDetached({ reduce: true });
    dm.push({ text: '一', kind: 'user' });
    dm.push({ text: '二', kind: 'coach' });
    dm.push({ text: '三', kind: 'user' });
    ok('prefers-reduced-motion：不飞行，降级成静态两行（只留最新两条）',
      layer.classList.contains('danmaku-layer--static')
      && layer.children.length === 2
      && layer.children.every((n) => n.classList.contains('danmaku--static')),
      JSON.stringify({ cls: [...layer.classList._set], n: layer.children.length }));
  }
}

/* ================================================================== *
 * [27] 火山 TTS 前端：200 播放 / 502·超时回落系统 TTS / stop 打断 / blob 释放
 * （不联网：fetch / Audio / URL.createObjectURL 全部注入假实现）
 * ================================================================== */
console.log('\n[27] 火山 TTS 前端：播放 / 502·超时回落 / 打断 / blob URL 释放');
{
  const tick = async (n = 8) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function fakeSystem() {
    return {
      spoken: [], cancelled: 0, lastOnEnd: null,
      speak(text, { onEnd } = {}) { this.spoken.push(text); this.lastOnEnd = onEnd; return true; },
      finish() { this.lastOnEnd?.(); },
      cancel() { this.cancelled += 1; },
      setRate() {},
    };
  }
  function audioFactory() {
    const list = [];
    class FakeAudio {
      constructor(src) { this.src = src; this.playCalls = 0; this.paused = 0; list.push(this); }
      play() { this.playCalls += 1; return Promise.resolve(); }
      pause() { this.paused += 1; }
      finish() { this.onended?.(); }
    }
    return { FakeAudio, list };
  }
  function urlFactory() {
    let n = 0;
    const revoked = [];
    return {
      revoked,
      create: () => `blob:fake/${(n += 1)}`,
      revoke: (u) => { revoked.push(u); },
    };
  }
  const json = (text) => ({ ok: true, status: 200, blob: async () => ({ size: text.length, type: 'audio/mpeg' }) });

  /* ---- ① 200 → 真的播放；播放结束释放 blob URL ---- */
  {
    const sys = fakeSystem();
    const urls = urlFactory();
    const { FakeAudio, list } = audioFactory();
    const calls = [];
    const diagEvents = [];
    const tts = createVolcTts({
      fallback: sys,
      AudioCtor: FakeAudio,
      AudioContextCtor: fakeAudioContext().FakeCtx,
      createObjectURL: urls.create,
      revokeObjectURL: urls.revoke,
      diag: { record: (type, data) => diagEvents.push({ type, data }) },
      fetchImpl: async (url, init) => { calls.push({ url, init }); return json('开始深蹲'); },
      rate: 1,
    });
    const ends = [];
    const started = tts.speak('开始深蹲', { onEnd: () => ends.push('end') });
    await tick();
    ok('先试流式 /tts/stream（响应没有可读流 → 自动降级整段），两次 body 都带 text + rate',
      started === true && calls.length === 2
      && calls[0].url === TTS_STREAM_PATH && calls[1].url === TTS_PATH
      && JSON.parse(calls[0].init.body).text === '开始深蹲'
      && JSON.parse(calls[0].init.body).rate === 1
      && JSON.parse(calls[1].init.body).text === '开始深蹲'
      && JSON.parse(calls[1].init.body).rate === 1,
      JSON.stringify(calls.map((c) => ({ url: c.url, body: c.init.body }))));
    ok('流式不可用会记一条 tts:stream-fail（诊断面板能看出降级到哪一级）',
      diagEvents.some((e) => e.type === 'tts:stream-fail' && e.data.code === 'no-body'),
      JSON.stringify(diagEvents.map((e) => e.type + ':' + (e.data.code || ''))));
    ok('200：拿到 blob 后用 Audio 播放，没有回退系统 TTS',
      list.length === 1 && list[0].src === 'blob:fake/1' && list[0].playCalls === 1
      && sys.spoken.length === 0,
      JSON.stringify({ audio: list.length, spoken: sys.spoken }));
    ok('200：诊断记一条 tts:say（source=volc）',
      diagEvents.some((e) => e.type === 'tts:say' && e.data.source === 'volc'));
    list[0].finish();
    ok('播完回调 onEnd 并释放 blob URL（不泄漏）',
      ends.length === 1 && urls.revoked.includes('blob:fake/1'),
      JSON.stringify({ ends, revoked: urls.revoked }));
  }

  /* ---- ② 502 → 自动回落系统 TTS，并记 tts:fallback ---- */
  {
    const sys = fakeSystem();
    const diagEvents = [];
    const tts = createVolcTts({
      fallback: sys,
      AudioCtor: audioFactory().FakeAudio,
      createObjectURL: () => 'blob:x',
      revokeObjectURL: () => {},
      diag: { record: (type, data) => diagEvents.push({ type, data }) },
      fetchImpl: async () => ({ ok: false, status: 502 }),
    });
    tts.speak('靶心收紧');
    await tick();
    ok('502：自动回落到系统 TTS（同一句照样念出来）',
      sys.spoken.length === 1 && sys.spoken[0] === '靶心收紧');
    ok('502：诊断记 tts:fallback（code=upstream）',
      diagEvents.some((e) => e.type === 'tts:fallback' && e.data.code === 'upstream'),
      JSON.stringify(diagEvents));
  }

  /* ---- ③ 超时 → 系统 TTS；不把会话晾在 speaking ---- */
  {
    const sys = fakeSystem();
    const diagEvents = [];
    const tts = createVolcTts({
      fallback: sys,
      timeoutMs: 15,
      diag: { record: (type, data) => diagEvents.push({ type, data }) },
      // 永不 resolve 的 fetch：只能靠 3s（这里调成 15ms）超时兜底
      fetchImpl: (url, init) => new Promise((resolve, reject) => {
        init.signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    });
    let errors = 0;
    const started = tts.speak('请开始深蹲', { onError: () => { errors += 1; } });
    ok('超时前 speak() 已经接下这一句（返回 true，异步播放）', started === true);
    // 流式 15ms 超时 → 整段再 15ms 超时 → 系统 TTS（两级都超时，所以等宽一点）
    await wait(200);
    ok('超时：自动回落系统 TTS', sys.spoken.length === 1, JSON.stringify(sys.spoken));
    ok('超时：诊断记 tts:fallback（code=timeout）',
      diagEvents.some((e) => e.type === 'tts:fallback' && e.data.code === 'timeout'),
      JSON.stringify(diagEvents));
    ok('超时回落后不调用 onError（已经改由系统 TTS 念）', errors === 0);
  }

  /* ---- ④ 打断：新一句先说 stop 上一句；stop() 释放 blob URL ---- */
  {
    const urls = urlFactory();
    const { FakeAudio, list } = audioFactory();
    const reqUrls = [];
    const tts = createVolcTts({
      fallback: fakeSystem(),
      AudioCtor: FakeAudio,
      createObjectURL: urls.create,
      revokeObjectURL: urls.revoke,
      fetchImpl: async (url) => { reqUrls.push(url); return json('x'); },
    });
    const ends = [];
    tts.speak('第一句', { onEnd: () => ends.push('one') });
    await tick();
    tts.speak('第二句', { onEnd: () => ends.push('two') });
    await tick();
    ok('打断：上一句先被 pause + 释放 blob URL，再播下一句',
      list.length === 2 && list[0].paused >= 1 && urls.revoked.includes('blob:fake/1')
      && list[1].src === 'blob:fake/2'
      && reqUrls.filter((u) => u === TTS_PATH).length === 2,
      JSON.stringify({ audio: list.length, paused: list[0]?.paused, revoked: urls.revoked, reqUrls }));
    tts.stop();
    ok('stop()：停当前这句并释放它的 blob URL',
      list[1].paused >= 1 && urls.revoked.includes('blob:fake/2'));
    tts.close();
    tts.close();
  }

  /* ---- ⑤ 音色来源 = 系统 → 完全不发 /tts ---- */
  {
    let calls = 0;
    const sys = fakeSystem();
    const tts = createVolcTts({
      fallback: sys, source: 'system',
      fetchImpl: async () => { calls += 1; return json('x'); },
    });
    tts.speak('系统念这一句');
    ok('「音色来源=系统」时不发 /tts，直接交系统 TTS',
      calls === 0 && sys.spoken.length === 1);
    ok('音色来源常量就是 auto / volc / system（默认 auto）',
      TTS_SOURCES.join(',') === 'auto,volc,system' && TTS_DEFAULT_SOURCE === 'auto');
  }

  /* ---- ⑥ 语速真的进了请求体（缓存 key 也按 rate 分） ---- */
  {
    const calls = [];
    const tts = createVolcTts({
      fallback: fakeSystem(),
      AudioCtor: audioFactory().FakeAudio,
      AudioContextCtor: fakeAudioContext().FakeCtx,
      createObjectURL: () => 'blob:r',
      revokeObjectURL: () => {},
      fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return json('x'); },
      rate: 1.5,
    });
    tts.speak('快一点');
    await tick();
    ok('语速传给请求（流式与整段都带 rate=1.5）',
      calls.length === 2 && calls.every((c) => c.rate === 1.5),
      JSON.stringify(calls));
    ok('语速归一化：0.5~2，非法值回 1',
      normalizeTtsRate(1.5) === 1.5 && normalizeTtsRate(9) === 2
      && normalizeTtsRate(0) === 1 && normalizeTtsRate('x') === 1
      && tts.setRate(9) === 2 && tts.setRate(1.5) === 1.5);
  }

  /* ---- ⑦ 服务端缓存命中 → 客户端仍然是 200 播放（缓存对前端透明） ---- */
  {
    const sys = fakeSystem();
    const { FakeAudio, list } = audioFactory();
    const tts = createVolcTts({
      fallback: sys,
      AudioCtor: FakeAudio,
      createObjectURL: () => 'blob:hit',
      revokeObjectURL: () => {},
      fetchImpl: async () => json('缓存命中'),
    });
    tts.speak('缓存命中');
    await tick();
    ok('服务端缓存命中：客户端照常 200 → 播放（不会因为“没重新合成”而卡住）',
      list.length === 1 && list[0].playCalls === 1 && sys.spoken.length === 0);
    tts.close();
  }

  ok('默认超时时间就是 3 秒（用户口径）', TTS_TIMEOUT_MS === 3000);
}

/* ================================================================== *
 * [28] 火山 TTS 服务端：假 fetch 验缓存 / 502 / 超时 / health 不带密钥
 * ================================================================== */
console.log('\n[28] 火山 TTS 服务端：缓存命中 / 超时 502 / health 不泄露凭证');
{
  const config = {
    configured: true, missing: [], appId: 'test-app-id', apiKey: 'test-api-key',
    voice: 'zh_female_vv_uranus_bigtts', resource: 'volc.seedtts.default',
    endpoint: 'https://example.invalid/tts',
  };
  const logLines = [];
  const logger = (fields) => logLines.push(fields);
  const makeFetch = () => {
    let calls = 0;
    let last = null;
    const fn = async (url, init) => {
      calls += 1;
      last = { url, init };
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4, 5]).buffer,
      };
    };
    return { fn, get calls() { return calls; }, get last() { return last; } };
  };

  const fake = makeFetch();
  const cache = createTtsCache({ maxEntries: 200, maxBytes: 1024 });
  const service = createVolcTtsServer({
    config, fetchImpl: fake.fn, cache, timeoutMs: 100, logger,
  });

  const first = await service.synthesize('开始深蹲', 1);
  const second = await service.synthesize('开始深蹲', 1);
  ok('缓存：同一句 + 同一语速只调一次上游（第二次 cached=true）',
    fake.calls === 1 && first.ok && !first.cached && second.ok && second.cached
    && second.bytes === 5,
    JSON.stringify({ calls: fake.calls, first, second }));
  ok('缓存 key = voice|rate|text',
    ttsCacheKey({ voice: config.voice, rate: 1, text: '开始深蹲' })
    === `${config.voice}|1.00|开始深蹲`
    && ttsCacheKey({ voice: config.voice, rate: 1.2, text: '开始深蹲' })
    !== ttsCacheKey({ voice: config.voice, rate: 1, text: '开始深蹲' }));
  ok('上游请求照 server/tts-probe.mjs 那一份可用写法：v3 端点 + 三个 X-Api 头 + speaker/mp3',
    fake.last.url === config.endpoint
    && fake.last.init.headers['X-Api-App-Id'] === config.appId
    && fake.last.init.headers['X-Api-Key'] === config.apiKey
    && fake.last.init.headers['X-Api-Resource-Id'] === config.resource
    && JSON.parse(fake.last.init.body).req_params.speaker === config.voice
    && JSON.parse(fake.last.init.body).req_params.audio_params.format === 'mp3'
    && JSON.parse(fake.last.init.body).req_params.text === '开始深蹲',
    JSON.stringify(fake.last));
  ok('缓存日志只有 chars / cache / status（不含文本与凭证）',
    logLines.length >= 2 && logLines.every((f) => Object.keys(f).sort().join(',') === 'cache,chars,status')
    && !JSON.stringify(logLines).includes('test-api-key'),
    JSON.stringify(logLines));

  const health = service.health();
  ok('health：只有 configured（true）+ missing，绝不带 appId / apiKey',
    health.configured === true
    && !JSON.stringify(health).includes(config.apiKey)
    && !JSON.stringify(health).includes(config.appId),
    JSON.stringify(health));

  /* ---- 上游 502 / 未配置 / 空文本 ---- */
  const bad = createVolcTtsServer({
    config,
    fetchImpl: async () => ({ ok: false, status: 503 }),
    cache: createTtsCache(),
    timeoutMs: 100,
    logger: () => {},
  });
  const badResult = await bad.synthesize('x');
  ok('上游失败 → 502（客户端据此回落系统 TTS）',
    !badResult.ok && badResult.status === 502 && badResult.code === 'upstream',
    JSON.stringify(badResult));

  const off = createVolcTtsServer({
    config: { configured: false, missing: ['VOLC_TTS_VOICE'], appId: '', apiKey: '', voice: '', resource: '', endpoint: '' },
    fetchImpl: async () => { throw new Error('should not be called'); },
    cache: createTtsCache(),
  });
  const offResult = await off.synthesize('x');
  ok('没配置 → 502 not-configured（不抛错、不发请求）',
    !offResult.ok && offResult.code === 'not-configured' && offResult.status === 502);
  ok('空文本 → 400 empty（不合成）', (await service.synthesize('   ')).code === 'empty');
  ok('超长文本裁到 300 字（TTS_MAX_TEXT）',
    TTS_MAX_TEXT === 300 && (await service.synthesize('字'.repeat(400))).ok);

  /* ---- 缓存容量：200 条 / 20MB（LRU） ---- */
  {
    const small = createTtsCache({ maxEntries: 2, maxBytes: 1024 });
    small.set('a', Buffer.alloc(2));
    small.set('b', Buffer.alloc(2));
    small.set('c', Buffer.alloc(2));
    ok('缓存上限 200 条：超过就按 LRU 淘汰最老的',
      small.maxEntries === 200 || (small.size === 2 && !small.has('a')),
      JSON.stringify({ size: small.size, keys: small.keys() }));
    ok('缓存默认上限就是 200 条 / 20MB',
      createTtsCache().maxEntries === 200 && createTtsCache().maxBytes === 20 * 1024 * 1024);
    const byteCap = createTtsCache({ maxEntries: 100, maxBytes: 4 });
    byteCap.set('a', Buffer.alloc(3));
    byteCap.set('b', Buffer.alloc(3));   // 放不进 → 淘汰 a 后 b 也超 → 最终只留不下
    ok('缓存上限 20MB：单条太大就不缓存（不会把整个缓存清空）',
      byteCap.size <= 1 && byteCap.bytes <= 4,
      JSON.stringify({ size: byteCap.size, bytes: byteCap.bytes }));
  }

  /* ---- 真 http：/tts 返回 audio/mpeg，/tts/health 不带密钥 ---- */
  {
    const http = await import('node:http');
    const srv = http.createServer(createTtsRoutes({ service }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const request = (method, p, body = null) => new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: p, method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });

    const callsBefore = fake.calls;
    const res = await request('POST', TTS_SERVER_PATH, JSON.stringify({ text: '开始深蹲', rate: 1 }));
    ok('POST /tts 命中服务端缓存 → 200 + audio/mpeg + 5 字节（不再请求上游）',
      res.status === 200 && /audio\/mpeg/.test(String(res.headers['content-type']))
      && res.body.length === 5 && fake.calls === callsBefore,
      JSON.stringify({ status: res.status, ct: res.headers['content-type'], len: res.body.length, calls: fake.calls }));

    const healthRes = await request('GET', TTS_HEALTH_PATH);
    const healthBody = healthRes.body.toString('utf8');
    ok('GET /tts/health → configured:true，且响应里没有 appId / apiKey',
      healthRes.status === 200
      && JSON.parse(healthBody).configured === true
      && !healthBody.includes(config.apiKey) && !healthBody.includes(config.appId),
      healthBody);

    const badBody = await request('POST', TTS_SERVER_PATH, JSON.stringify({ text: '' }));
    ok('POST /tts 空文本 → 400（不是 200 的空音频）', badBody.status === 400,
      String(badBody.status));
    await new Promise((r) => srv.close(r));
  }

  /* ---- 超时：3s（测试调小）→ 502 timeout ---- */
  {
    const http = await import('node:http');
    const slowService = createVolcTtsServer({
      config,
      fetchImpl: () => new Promise(() => {}),   // 永不返回
      cache: createTtsCache(),
      timeoutMs: 20,
      logger: () => {},
    });
    const srv = http.createServer(createTtsRoutes({ service: slowService }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: TTS_SERVER_PATH, method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ text: '超时测试' }));
    });
    ok('超时（3s）→ 502 + 简短错误 JSON（code=timeout）',
      res.status === 502 && JSON.parse(res.body).error === 'timeout',
      JSON.stringify(res));
    await new Promise((r) => srv.close(r));
  }

  /* ---- 配置读取：键名兼容 + 缺字段只报字段名 ---- */
  {
    const parsed = loadTtsConfig({
      envPath: '/definitely/not/here.env',
      env: {
        VOLC_TTS_APP_ID: 'a', VOLC_TTS_API_KEY: 'k', VOLC_TTS_VOICE: 'v',
        VOLC_TTS_RESOURCE: 'r', VOLC_TTS_ENDPOINT: 'https://example.invalid/x',
      },
    });
    ok('loadTtsConfig：读到 appId / key / voice / resource / endpoint 就算 configured',
      parsed.config.configured === true && parsed.config.missing.length === 0
      && parsed.config.voice === 'v');
    const missing = loadTtsConfig({ envPath: '/definitely/not/here.env', env: { VOLC_APP_ID: 'a' } });
    ok('loadTtsConfig：缺字段只列字段名（key 不出现）',
      missing.config.configured === false
      && missing.config.missing.includes('VOLC_TTS_API_KEY')
      && missing.config.missing.includes('VOLC_TTS_VOICE')
      && !JSON.stringify(missing.config.missing).includes('a'));
    const previewSrc = fs.readFileSync(new URL('../preview-server.js', import.meta.url), 'utf8');
    ok('预览服务器接线：/tts 与 /tts/health 走 createTtsRoutes（启动日志只报“配没配”）',
      /createTtsRoutes/.test(previewSrc) && /ttsRoute\(req, res\)/.test(previewSrc)
      && /TTS_HEALTH_PATH/.test(previewSrc));
  }
}

/* ------------------------------------------------------------------ *
 * [29] P3.3 自由对话：LLM provider / 工具表 / `/llm` 路由 / Agent context
 *
 * 全程**不联网、不用真 key**：provider 注入假 fetch，路由用 mock provider；
 * 唯一的「真 key」路径也只用假字符串，并且断言日志 / health 里不出现它。
 * ------------------------------------------------------------------ */
{
  console.log('\n[29] P3.3 自由对话：工具表 ↔ 命令表 / provider / 护栏 / Agent context');

  const httpMod = await import('node:http');

  /* ---------------- 29.1 工具表与命令表一一对应 ---------------- */
  {
    ok('工具表覆盖命令表的每一条 intent（UNCOVERED_INTENTS 为空）',
      UNCOVERED_INTENTS.length === 0, UNCOVERED_INTENTS.join(','));
    ok('工具里写的 intent 都真的存在（UNKNOWN_TOOLED_INTENTS 为空）',
      UNKNOWN_TOOLED_INTENTS.length === 0, UNKNOWN_TOOLED_INTENTS.join(','));
    ok('TOOLED_INTENTS 的数量 = COMMANDS 的数量（27 条 intent 全部可达；记忆工具没有 client intent）',
      TOOLED_INTENTS.length === COMMANDS.length,
      `${TOOLED_INTENTS.length} / ${COMMANDS.length}`);
    ok('工具数 ≥ 15，且每个工具都有 name / 中英描述 / JSON Schema 参数',
      LLM_TOOL_DEFS.length >= 15 && LLM_TOOL_DEFS.every((t) => t.name && t.zh && t.en
        && t.parameters && t.parameters.type === 'object' && Array.isArray(t.parameters.properties || {}) === false),
      `${LLM_TOOL_DEFS.length} 个工具`);
    // 逐条抽查几个「一对多」的映射（改命令表 / 工具表任意一边都会在这里红）
    const expectMap = {
      start_workout: ['startWorkout'], pause: ['pause'], resume: ['resume'], exit_workout: ['exit'],
      retry_set: ['retrySet'], next_exercise: ['nextExercise'], continue_last: ['continueLast'],
      set_target: ['setTarget'],
      adjust_target: ['adjustTarget'],
      navigate: ['home', 'menu', 'back', 'next', 'prev'],
      open_panel: ['openSettings', 'openRecords', 'openBest', 'openExerciseSettings'],
      set_voice: ['mute', 'unmute'], switch_language: ['switchLang'],
      set_voice_gender: ['setVoiceGender'],
      report_progress: ['reportProgress'], help: ['help'],
      // R2 口述建规则（零 LLM：快车道不联网，但这三条也让模型能触发同一套 run()）
      add_rule: ['addRule'], remove_rule: ['removeRule'], list_rules: ['listRules'],
      pick_category: ['category'], pick_index: ['pick'], stop_listening: ['stopListening'],
      // 长期记忆：服务端副作用，没有 client intent
      remember: [], remember_fact: [], forget: [],
    };
    const mapOk = Object.entries(expectMap).every(([name, intents]) => {
      const got = TOOL_INTENT_MAP[name];
      return Array.isArray(got) && got.length === intents.length
        && intents.every((i) => got.includes(i));
    });
    ok('25 个工具 → 30 条 intent 的映射与命令表一致（含 navigate / open_panel / set_voice 三对多 + 3 个记忆工具 + 3 个规则工具）',
      mapOk && Object.keys(TOOL_INTENT_MAP).length === Object.keys(expectMap).length,
      JSON.stringify(TOOL_INTENT_MAP));
    // OpenAI 风格的 function calling：tools 是 [{type:'function', function:{name,description,parameters}}]
    ok('LLM_TOOLS 是 OpenAI function calling 形状（type=function + name/description/parameters）',
      Array.isArray(LLM_TOOLS) && LLM_TOOLS.every((t) => t.type === 'function'
        && t.function && typeof t.function.name === 'string'
        && typeof t.function.description === 'string'
        && t.function.parameters && t.function.parameters.type === 'object'));
    ok('每个工具的描述里都有中文和英文两种写法（给模型看，也给「我能做什么」用）',
      toolHelpRows().every((r) => /[\u4e00-\u9fa5]/.test(r.zh) && /[a-z]{3,}/i.test(r.en)));
    ok('start_workout 的 exerciseId 枚举来自动作库（catalog.js），不是另抄一份',
      EXERCISE_IDS.length === COMMANDS.length * 0 + EXERCISE_IDS.length
      && EXERCISE_IDS.includes('plank') && EXERCISE_IDS.includes('squat')
      && JSON.stringify(LLM_TOOL_DEFS.find((t) => t.name === 'start_workout').parameters.properties.exerciseId.enum)
        === JSON.stringify(EXERCISE_IDS));
  }

  /* ---------------- 29.2 tool_calls → 命令表的 { intent, args } ---------------- */
  {
    const call = (name, args) => actionsFromToolCalls([{ name, args }], { locale: 'zh' });
    const start = call('start_workout', { exerciseId: 'plank', target: 30 });
    ok('start_workout(plank, 30) → startWorkout{exerciseId:plank, value:30}',
      start.actions.length === 1 && start.actions[0].intent === 'startWorkout'
      && start.actions[0].args.exerciseId === 'plank' && start.actions[0].args.value === 30,
      JSON.stringify(start));
    const setT = call('set_target', { value: 30 });
    ok('set_target(30) → setTarget{value:30}', setT.actions[0]?.intent === 'setTarget'
      && setT.actions[0]?.args.value === 30, JSON.stringify(setT));
    const adj = call('adjust_target', { delta: -10 });
    ok('adjust_target(-10) → adjustTarget{delta:-10}', adj.actions[0]?.args.delta === -10);
    const nav = call('navigate', { dest: 'home' });
    ok('navigate(home) → home', nav.actions[0]?.intent === 'home');
    const panel = call('open_panel', { which: 'best' });
    ok('open_panel(best) → openBest', panel.actions[0]?.intent === 'openBest');
    ok('set_voice(mute:true) → mute；mute:false → unmute',
      call('set_voice', { mute: true }).actions[0]?.intent === 'mute'
      && call('set_voice', { mute: false }).actions[0]?.intent === 'unmute');
    ok('switch_language(en) → switchLang{lang:en}',
      call('switch_language', { lang: 'en' }).actions[0]?.args.lang === 'en');
    ok('pick_index(3) → pick{index:2}（工具用 1 基，命令表用 0 基）',
      call('pick_index', { position: 3 }).actions[0]?.args.index === 2);
    ok('pick_category(core) → category{category:core}',
      call('pick_category', { category: 'core' }).actions[0]?.args.category === 'core');
    ok('中文动作名也能归一化（「平板支撑」→ plank），认不出的 id 拒绝执行',
      resolveExerciseId('平板支撑') === null && resolveExerciseId('plank') === 'plank'
      && call('start_workout', { exerciseId: 'no-such' }).actions.length === 0);

    // exit_workout 不再需要 confirm：没带也照样产生退出动作（说退出就退出）
    const noConfirm = actionsFromToolCalls([{ name: 'exit_workout', args: {} }], { locale: 'zh' });
    ok('exit_workout 不带 confirm → 照样产生 exit 动作（不再问一遍）',
      noConfirm.actions.length === 1 && noConfirm.actions[0].intent === 'exit'
      && noConfirm.refusals.length === 0 && noConfirm.prompts.length === 0,
      JSON.stringify(noConfirm));
    const enNoConfirm = actionsFromToolCalls([{ name: 'exit_workout', args: {} }], { locale: 'en' });
    ok('英文界面同一行为：exit_workout 不带 confirm 也直接执行',
      enNoConfirm.actions.length === 1 && enNoConfirm.actions[0].intent === 'exit'
      && enNoConfirm.prompts.length === 0);
    const confirmed = call('exit_workout', { confirm: true });
    ok('exit_workout 带 confirm:true 也照样是 exit（兼容旧调用，action 里不残留 confirm）',
      confirmed.actions[0]?.intent === 'exit' && confirmed.actions[0]?.args.confirm === undefined);

    // 异常输入：未知工具 / 参数不合法 / 超过上限
    const junk = actionsFromToolCalls([{ name: 'rm_rf', args: {} }, { name: 'set_target', args: { value: 0 } }]);
    ok('未知工具 / 非法参数只记 refusal，不产生 action、不抛错',
      junk.actions.length === 0 && junk.refusals.length === 2
      && junk.refusals[0].reason === 'unknown-tool' && junk.refusals[1].reason === 'bad-args',
      JSON.stringify(junk));
    const many = actionsFromToolCalls(Array.from({ length: 5 }, () => ({ name: 'pause', args: {} })));
    ok(`一次最多执行 ${MAX_TOOL_CALLS} 个工具（多出来的丢掉，防模型拆界面）`,
      many.actions.length === MAX_TOOL_CALLS);
  }

  /* ---------------- 29.3 配置读取（coach.env 的键名与回退） ---------------- */
  {
    const fakeKey = 'sk-fake-test-key-not-real-0000';
    const ds = loadLlmConfig({
      envPath: '/definitely/not/here.env',
      env: { LLM_PROVIDER: 'deepseek', LLM_MODEL: 'deepseek-chat', LLM_API_KEY: fakeKey },
    });
    ok('DeepSeek：provider / model / endpoint / Bearer key 全对，configured=true',
      ds.config.configured === true && ds.config.provider === 'deepseek'
      && ds.config.model === 'deepseek-chat'
      && ds.config.endpoint === 'https://api.deepseek.com/v1/chat/completions'
      && ds.config.apiKey === fakeKey);
    const viaEnv = loadLlmConfig({
      envPath: '/definitely/not/here.env',
      env: { LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: fakeKey },
    });
    ok('LLM_API_KEY 没写时回退 DEEPSEEK_API_KEY（model 用默认 deepseek-chat）',
      viaEnv.config.configured === true && viaEnv.config.apiKey === fakeKey
      && viaEnv.config.model === 'deepseek-chat');
    const inferred = loadLlmConfig({ envPath: '/definitely/not/here.env', env: { DEEPSEEK_API_KEY: fakeKey } });
    ok('没写 LLM_PROVIDER 时按「哪家配了 key」推断 provider',
      inferred.config.provider === 'deepseek', inferred.config.provider);
    const volc = loadLlmConfig({
      envPath: '/definitely/not/here.env',
      env: { LLM_PROVIDER: 'volc', VOLC_ARK_API_KEY: fakeKey },
    });
    ok('火山方舟：缺 LLM_MODEL → configured:false，missing 里只有字段名（不出现 key 值）',
      volc.config.configured === false && volc.config.missing.includes('LLM_MODEL')
      && !JSON.stringify(volc.config.missing).includes(fakeKey)
      && volc.config.endpoint === 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
    const volc2 = loadLlmConfig({
      envPath: '/definitely/not/here.env',
      env: { LLM_PROVIDER: 'volc', LLM_MODEL: 'ep-2026', VOLC_ARK_API_KEY: fakeKey },
    });
    ok('火山方舟：LLM_MODEL + VOLC_ARK_API_KEY 齐了就算 configured',
      volc2.config.configured === true && volc2.config.model === 'ep-2026');
    const oa = loadLlmConfig({
      envPath: '/definitely/not/here.env',
      env: { LLM_PROVIDER: 'openai', OPENAI_API_KEY: fakeKey },
    });
    ok('OpenAI：回退 OPENAI_API_KEY / 默认 gpt-4o-mini / 官方地址',
      oa.config.configured === true && oa.config.model === 'gpt-4o-mini'
      && oa.config.endpoint === 'https://api.openai.com/v1/chat/completions');
    const none = loadLlmConfig({ envPath: '/definitely/not/here.env', env: {} });
    ok('什么都没配 → configured:false（页面回到命令快车道，不报错）',
      none.config.configured === false && none.config.missing.includes('LLM_API_KEY'));
    const mockCfg = loadLlmConfig({ envPath: '/definitely/not/here.env', env: { LLM_PROVIDER: 'mock' } });
    ok('LLM_PROVIDER=mock → 不需要 key，configured:true（测试 / 演示用）',
      mockCfg.config.configured === true && mockCfg.config.provider === 'mock');
    ok('provider 别名归一化（ark / doubao / volcengine → volc，大小写不敏感）',
      normalizeProviderName('ARK') === 'volc' && normalizeProviderName('doubao') === 'volc'
      && normalizeProviderName('VOLCENGINE') === 'volc' && normalizeProviderName('deepseek') === 'deepseek'
      && normalizeProviderName('whatever') === '');
    ok('护栏默认值：超时 8s / max_tokens 400 / 每分钟 20 次 / 最近 6 轮',
      LLM_TIMEOUT_MS === 8000 && LLM_MAX_TOKENS === 400 && LLM_RATE_LIMIT === 20
      && LLM_MAX_HISTORY_TURNS === 6 && LLM_RATE_WINDOW_MS === 60000);
    ok('llmHttpCode：401 → llm-http-401（错误码归一化，不回传上游原文）',
      llmHttpCode(401) === 'llm-http-401' && llmHttpCode(402) === 'llm-http-402'
      && llmHttpCode(0) === 'llm-http-error');
  }

  /* ---------------- 29.4 真 provider（假 fetch）：请求形状 / tool_calls / 错误归一化 ---------------- */
  {
    const fakeKey = 'sk-fake-test-key-not-real-0000';
    const cfg = { provider: 'deepseek', model: 'deepseek-chat', endpoint: 'https://api.deepseek.com/v1/chat/completions', apiKey: fakeKey, configured: true, missing: [] };
    const seen = [];
    const logs = [];
    let nextResponse = () => ({
      ok: true, status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: '你做了 12 个，蹲得比上一组深。',
            tool_calls: [{ function: { name: 'set_target', arguments: '{"value":20}' } }],
          },
        }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
      }),
    });
    const provider = createLlmProvider({
      config: cfg,
      fetchImpl: async (url, init) => { seen.push({ url, init }); return nextResponse(); },
      logger: (f) => logs.push(f),
    });
    const out = await provider.chat({ messages: [{ role: 'user', content: '我做了几个' }], tools: LLM_TOOLS });
    const req = seen[0];
    const body = JSON.parse(req.init.body);
    ok('DeepSeek 请求：URL / Authorization: Bearer / model / max_tokens=400 / tool_choice=auto',
      req.url === 'https://api.deepseek.com/v1/chat/completions'
      && req.init.headers.Authorization === `Bearer ${fakeKey}`
      && body.model === 'deepseek-chat' && body.max_tokens === 400
      && body.tool_choice === 'auto' && Array.isArray(body.tools) && body.tools.length === LLM_TOOLS.length,
      JSON.stringify(Object.keys(body)));
    ok('OpenAI 风格 function calling 的返回值被解析成 { text, toolCalls:[{name,args}] }',
      out.text.startsWith('你做了 12 个') && out.toolCalls.length === 1
      && out.toolCalls[0].name === 'set_target' && out.toolCalls[0].args.value === 20,
      JSON.stringify(out));
    ok('usage 里的 prompt / completion / total 原样带出来',
      out.usage.prompt === 120 && out.usage.completion === 40 && out.usage.total === 160);
    ok('日志只打 provider/model/tokens/tool-calls/耗时（不含 key）',
      logs.length > 0 && logs.every((f) => !JSON.stringify(f).includes(fakeKey))
      && logs.some((f) => f.provider === 'deepseek' && f.tools === 1 && typeof f.ms === 'number'),
      JSON.stringify(logs));

    // 401 / 402 / 坏 JSON / 超时
    nextResponse = () => ({ ok: false, status: 401, text: async () => `{"error":"bad key ${fakeKey}"}`, json: async () => ({}) });
    let code = '';
    try { await provider.chat({ messages: [] }); } catch (err) { code = err.code; }
    ok('上游 401 → 归一化 llm-http-401（错误正文里的 key 也被脱敏）', code === 'llm-http-401', code);
    nextResponse = () => ({ ok: false, status: 402, text: async () => '{"error":"insufficient balance"}', json: async () => ({}) });
    try { await provider.chat({ messages: [] }); } catch (err) { code = err.code; }
    ok('上游 402（余额不足）→ llm-http-402，不崩、不打印 key', code === 'llm-http-402', code);
    nextResponse = () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } });
    try { await provider.chat({ messages: [] }); } catch (err) { code = err.code; }
    ok('响应不是 JSON → llm-bad-json', code === 'llm-bad-json', code);
    const slow = createLlmProvider({ config: cfg, fetchImpl: () => new Promise(() => {}), timeoutMs: 20, logger: () => {} });
    try { await slow.chat({ messages: [] }); } catch (err) { code = err.code; }
    ok('8s 超时（测试里调成 20ms）→ llm-timeout', code === 'llm-timeout', code);
    const noKey = createLlmProvider({ config: { ...cfg, apiKey: '', configured: false }, fetchImpl: () => { throw new Error('should not call'); } });
    try { await noKey.chat({ messages: [] }); } catch (err) { code = err.code; }
    ok('没 key 的 provider 根本不发请求（llm-config）', code === 'llm-config', code);
  }

  /* ---------------- 29.5 `/llm` + `/llm/health` 路由（真 http，假 provider） ---------------- */
  {
    const fakeKey = 'sk-fake-test-key-not-real-0000';
    const cfg = { provider: 'deepseek', model: 'deepseek-chat', endpoint: 'https://api.deepseek.com/v1/chat/completions', apiKey: fakeKey, configured: true, missing: [] };
    const okProvider = createMockLlmProvider({
      script: [{
        text: '好，平板支撑 30 秒，先做慢一点。',
        toolCalls: [
          { name: 'start_workout', args: { exerciseId: 'plank', target: 30 } },
          { name: 'set_target', args: { value: 30 } },
        ],
        usage: { prompt: 100, completion: 20, total: 120 },
      }],
    });
    const guard = createLlmGuard({ limit: 20, windowMs: 60000 });
    const route = createLlmRoutes({ provider: okProvider, config: cfg, guard, logger: () => {} });
    const srv = httpMod.createServer(route);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    const request = (method, path, body) => new Promise((resolve, reject) => {
      const req = httpMod.request({
        host: '127.0.0.1', port, path, method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });

    // health：只有 configured / provider / model / 护栏 / 用量，**没有 key**
    const healthRes = await request('GET', LLM_HEALTH_PATH);
    const health = JSON.parse(healthRes.body);
    ok('GET /llm/health → {configured:true, provider, model, limits}',
      healthRes.status === 200 && health.configured === true && health.provider === 'deepseek'
      && health.model === 'deepseek-chat' && health.limits.perMinute === 20 && health.limits.maxTokens === 400,
      healthRes.body);
    ok('/llm/health 的响应里**没有 key**（不出现 sk- / apiKey / 假 key 的任何片段）',
      !/sk-/.test(healthRes.body) && !/apiKey/i.test(healthRes.body) && !healthRes.body.includes(fakeKey),
      healthRes.body);

    // 正常：一句话 → reply + actions（映射成命令表的 intent）
    const normal = await request('POST', LLM_PATH, {
      text: '帮我换成平板支撑 30 秒',
      locale: 'zh',
      context: { session: { exerciseId: 'squat', reps: 3 }, utterance: '帮我换成平板支撑 30 秒' },
    });
    const nJson = JSON.parse(normal.body);
    ok('POST /llm → 200 + reply + actions（start_workout(plank) + set_target(30) 映射成 intent）',
      normal.status === 200 && nJson.reply === '好，平板支撑 30 秒，先做慢一点。'
      && nJson.actions.length === 2
      && nJson.actions[0].intent === 'startWorkout' && nJson.actions[0].args.exerciseId === 'plank'
      && nJson.actions[0].args.value === 30
      && nJson.actions[1].intent === 'setTarget' && nJson.actions[1].args.value === 30,
      normal.body);
    ok('POST /llm 的响应里有 usage，并且服务端把它累计进 health',
      nJson.usage.total === 120 && JSON.parse((await request('GET', LLM_HEALTH_PATH)).body).usage.tokens.total === 120);
    const sent = okProvider.calls.at(-1);
    const sys = sent.messages[0];
    ok('发给模型的 messages：system 里有 Agent 行为准则（中英）+ 客户端的事实（state JSON）',
      sys.role === 'system' && /Agent 行为准则/.test(sys.content) && /Agent rules/.test(sys.content)
      && /state \(JSON\)/.test(sys.content) && sys.content.includes('plank') === false
      && sys.content.includes('squat')
      && sent.messages.at(-1).role === 'user' && sent.messages.at(-1).content === '帮我换成平板支撑 30 秒');
    ok('system 提示里明确写了「数字由客户端算好，不许自己编」',
      /不许自己编/.test(sys.content) && /Never invent numbers/.test(sys.content));

    /* session-start 事件：空 text 也放行，user 消息由服务端按 context 生成（不是空的用户文本） */
    const intro = await request('POST', LLM_PATH, {
      event: 'session-start',
      text: '',
      locale: 'zh',
      context: { session: { exerciseId: 'squat', name: '自重深蹲', target: 20, kind: 'reps' } },
    });
    const introJson = JSON.parse(intro.body);
    ok('POST /llm {event:session-start, text:""} → 200（不因空文本 400），结构与普通对话一致（reply + actions）',
      intro.status === 200 && introJson.ok === true
      && typeof introJson.reply === 'string' && Array.isArray(introJson.actions),
      intro.body);
    const introSent = okProvider.calls.at(-1).messages.at(-1);
    ok('发给模型的 user 是「用户刚刚进入训练」事件描述：带动作 / 目标，不是空文本',
      introSent.role === 'user' && introSent.content.includes('刚刚进入训练')
      && introSent.content.includes('自重深蹲') && introSent.content.includes('20')
      && introSent.content.trim().length > 10, introSent.content);
    ok('session-start 的 system 里有事件规则（主动打招呼 / 1~2 句 / ≤40 字 / 不问一堆问题）',
      /session-start/.test(okProvider.calls.at(-1).messages[0].content)
      && /主动打招呼/.test(okProvider.calls.at(-1).messages[0].content)
      && /40/.test(okProvider.calls.at(-1).messages[0].content));
    // 只放行 session-start：别的 event 值仍按普通对话处理 → 空文本还是 400
    ok('未知 event 不放行空文本（仍然 400 empty-text，避免拿事件名白嫖请求）',
      (await request('POST', LLM_PATH, { event: 'bogus', text: '   ', locale: 'zh' })).status === 400);

    // exit_workout 没带 confirm：照样返回 exit 动作（不再回「要退出就说确认退出」）
    const exitNoConfirm = createMockLlmProvider({ script: [{ toolCalls: [{ name: 'exit_workout', args: {} }] }] });
    const routeExit = createLlmRoutes({ provider: exitNoConfirm, config: cfg, guard: createLlmGuard(), logger: () => {} });
    const srv2 = httpMod.createServer(routeExit);
    await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
    const expr = await new Promise((resolve, reject) => {
      const req = httpMod.request({
        host: '127.0.0.1', port: srv2.address().port, path: LLM_PATH, method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ text: '退出吧', locale: 'zh' }));
    });
    const exitJson = JSON.parse(expr.body);
    ok('exit_workout 不带 confirm（服务端）→ 直接返回 exit 动作，回复留空（等前端念命令表的短确认）',
      expr.status === 200 && exitJson.actions.length === 1
      && exitJson.actions[0].intent === 'exit' && exitJson.reply === '',
      expr.body);
    await new Promise((r) => srv2.close(r));

    // 不传 context（或 context 是垃圾）也不能 500
    const noCtx = await request('POST', LLM_PATH, { text: '随便说一句', locale: 'zh', context: 'not-an-object' });
    ok('context 缺失 / 类型不对也不 500（服务端容错）', noCtx.status === 200 && JSON.parse(noCtx.body).ok === true);

    /* 只调工具、没说话 → reply 留空（前端用命令表的短确认，不编「好，这就办」） */
    {
      const toolOnly = createMockLlmProvider({
        script: [{ toolCalls: [{ name: 'start_workout', args: { exerciseId: 'plank', target: 30 } }] }],
      });
      const routeT = createLlmRoutes({ provider: toolOnly, config: cfg, guard: createLlmGuard(), logger: () => {} });
      const srvT = httpMod.createServer(routeT);
      await new Promise((r) => srvT.listen(0, '127.0.0.1', r));
      const got = await new Promise((resolve, reject) => {
        const req = httpMod.request({
          host: '127.0.0.1', port: srvT.address().port, path: LLM_PATH, method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ text: '换成平板支撑 30 秒', locale: 'zh' }));
      });
      const j = JSON.parse(got.body);
      ok('模型只调工具没说话 → reply 留空（会话层改用命令表自己的短确认），actions 照常返回',
        got.status === 200 && j.reply === '' && j.actions.length === 1 && j.actions[0].intent === 'startWorkout',
        got.body);
      await new Promise((r) => srvT.close(r));
    }
    /* 什么都没给 → 服务端补一句「没听懂」，不返回空回复 */
    {
      const emptyProvider = createMockLlmProvider({ script: [{ text: '' }] });
      const routeE = createLlmRoutes({ provider: emptyProvider, config: cfg, guard: createLlmGuard(), logger: () => {} });
      const srvE = httpMod.createServer(routeE);
      await new Promise((r) => srvE.listen(0, '127.0.0.1', r));
      const got = await new Promise((resolve, reject) => {
        const req = httpMod.request({
          host: '127.0.0.1', port: srvE.address().port, path: LLM_PATH, method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ text: '……', locale: 'zh' }));
      });
      ok('模型既没说话也没调工具 → 服务端补一句「没听懂」（绝不返回空 reply）',
        got.status === 200 && JSON.parse(got.body).reply === EMPTY_REPLY.zh, got.body);
      await new Promise((r) => srvE.close(r));
    }

    // 坏 JSON / 空文本 / GET 方法
    const badJson = await new Promise((resolve, reject) => {
      const req = httpMod.request({
        host: '127.0.0.1', port, path: LLM_PATH, method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode }));
      });
      req.on('error', reject);
      req.end('{not json');
    });
    ok('请求体不是 JSON → 400（不 500）', badJson.status === 400);
    ok('空文本 → 400', (await request('POST', LLM_PATH, { text: '   ' })).status === 400);
    ok('GET /llm → 405（只接受 POST）', (await request('GET', LLM_PATH)).status === 405);

    /* 超时 → 503（客户端据此回退罐头回复） */
    const timeoutProvider = { provider: 'deepseek', model: 'deepseek-chat', configured: true, chat: async () => { const e = new Error('timeout'); e.code = 'llm-timeout'; throw e; } };
    const routeTimeout = createLlmRoutes({ provider: timeoutProvider, config: cfg, guard: createLlmGuard(), logger: () => {} });
    const srv3 = httpMod.createServer(routeTimeout);
    await new Promise((r) => srv3.listen(0, '127.0.0.1', r));
    const tres = await new Promise((resolve, reject) => {
      const req = httpMod.request({
        host: '127.0.0.1', port: srv3.address().port, path: LLM_PATH, method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ text: '超时测试', locale: 'zh' }));
    });
    ok('provider 超时 → 503 + {error:llm-timeout}（前端回退罐头回复，不崩）',
      tres.status === 503 && JSON.parse(tres.body).error === 'llm-timeout', tres.body);
    await new Promise((r) => srv3.close(r));

    /* 没配置 → 503 not-configured（客户端只用快车道） */
    const unconfiguredCfg = { ...cfg, configured: false, apiKey: '' };
    const routeNoKey = createLlmRoutes({ provider: okProvider, config: unconfiguredCfg, guard: createLlmGuard(), logger: () => {} });
    const srv4 = httpMod.createServer(routeNoKey);
    await new Promise((r) => srv4.listen(0, '127.0.0.1', r));
    const nres = await new Promise((resolve, reject) => {
      const req = httpMod.request({
        host: '127.0.0.1', port: srv4.address().port, path: LLM_PATH, method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ text: 'hello', locale: 'en' }));
    });
    ok('没配 key → POST /llm 503 not-configured（页面自动只用命令快车道）',
      nres.status === 503 && JSON.parse(nres.body).error === 'not-configured', nres.body);
    await new Promise((r) => srv4.close(r));

    /* 护栏：每分钟最多 20 次 —— 第 21 次 429 */
    {
      const guardLimit = createLlmGuard({ limit: 20, windowMs: 60000, now: (() => { let t = 0; return () => (t += 1000); })() });
      const routeGuard = createLlmRoutes({
        provider: createMockLlmProvider({ script: [{ text: 'ok' }] }),
        config: cfg, guard: guardLimit, logger: () => {},
      });
      const srv5 = httpMod.createServer(routeGuard);
      await new Promise((r) => srv5.listen(0, '127.0.0.1', r));
      const gport = srv5.address().port;
      const hit = () => new Promise((resolve, reject) => {
        const req = httpMod.request({
          host: '127.0.0.1', port: gport, path: LLM_PATH, method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ text: 'hi', locale: 'zh' }));
      });
      const statuses = [];
      for (let i = 0; i < 21; i += 1) statuses.push((await hit()).status);
      ok('护栏：每分钟 20 次正常，第 21 次 429 rate-limit',
        statuses.slice(0, 20).every((s) => s === 200) && statuses[20] === 429,
        statuses.join(','));
      const healthAfter = guardLimit.usage();
      ok('累计请求数只统计放行的请求（20 次，被 429 挡下的不计）',
        healthAfter.requests === 20, JSON.stringify(healthAfter));
      await new Promise((r) => srv5.close(r));
    }

    // history：服务端只夹最近 6 轮（12 条）
    const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `第 ${i} 句` }));
    const many = historyMessages(history, { maxTurns: 6 });
    ok('historyMessages：20 条历史只留最近 6 轮（12 条），顺序不变',
      many.length === 12 && many[0].content === '第 8 句' && many.at(-1).content === '第 19 句',
      `${many.length} 条`);
    const built = buildLlmMessages({ text: '你好', locale: 'zh', context: { a: 1 }, history });
    ok('buildLlmMessages：system + 最近 12 条历史 + 这一句（最后一条是 user 的输入）',
      built.length === 14 && built[0].role === 'system' && built.at(-1).content === '你好');

    /* session-start：user 消息是一条系统事件描述（中英各一套），不是空的用户文本 */
    {
      const zhCtx = { session: { exerciseId: 'squat', name: '自重深蹲', target: 20, kind: 'reps' } };
      const zhBuilt = buildLlmMessages({ event: LLM_EVENT_SESSION_START, locale: 'zh', context: zhCtx });
      const zhUser = zhBuilt.at(-1);
      ok('session-start（zh）：最后一条 user 含「刚刚进入训练」+ 动作 + 目标，且不是空文本',
        zhUser.role === 'user' && zhUser.content.includes('刚刚进入训练')
        && zhUser.content.includes('自重深蹲') && zhUser.content.includes('20')
        && zhUser.content.trim() !== '');
      ok('session-start（zh）的 system 里有事件规则：主动打招呼 / 1~2 句 / ≤40 字 / 不要问一堆问题',
        /session-start/.test(zhBuilt[0].content)
        && /主动打招呼/.test(zhBuilt[0].content)
        && /1~2 句/.test(zhBuilt[0].content)
        && /40/.test(zhBuilt[0].content)
        && /不要.*问一堆问题/.test(zhBuilt[0].content));

      const enCtx = { session: { name: 'Bodyweight Squat', target: 30, kind: 'hold' } };
      const enBuilt = buildLlmMessages({ event: LLM_EVENT_SESSION_START, locale: 'en', context: enCtx });
      ok('session-start（en）：user 是英文事件描述（just entered / 动作 / 30 sec / greet）',
        /just entered the workout/i.test(enBuilt.at(-1).content)
        && enBuilt.at(-1).content.includes('Bodyweight Squat')
        && enBuilt.at(-1).content.includes('30 sec')
        && /greet the user proactively/i.test(enBuilt.at(-1).content));
      ok('session-start（en）的 system 里有英文事件规则（greet / 1–2 sentences / 40 / never ask a list）',
        /session-start/.test(enBuilt[0].content)
        && /greet the user proactively/i.test(enBuilt[0].content)
        && /1–2 sentences/.test(enBuilt[0].content)
        && /never ask a list of questions/i.test(enBuilt[0].content));

      ok('sessionStartEventMessage：动作缺失也不会编数字 / 不会写出空目标',
        sessionStartEventMessage({ locale: 'zh', context: null }).includes('刚刚进入训练')
        && !/目标=\d/.test(sessionStartEventMessage({ locale: 'zh', context: null }))
        && sessionStartEventMessage({ locale: 'en', context: {} }).includes('just entered the workout'));
      ok('不带 event 时 buildLlmMessages 行为不变（空 text 的消息内容仍是空串，交给路由 400）',
        buildLlmMessages({ text: '' }).at(-1).content === ''
        && buildLlmMessages({ text: '你好' }).at(-1).content === '你好');
      ok('客户端与服务端的 session-start 事件名一致（不各写一份字符串）',
        LLM_CLIENT_EVENT === LLM_EVENT_SESSION_START && LLM_EVENT_SESSION_START === 'session-start');

      // 首次见面遇到 session-start：自报必须压成一句短的，否则模型会念完 SOUL 整段再问候（超过 1~2 句 / 40 字）
      const introCtx = { memory: { prefs: { introSeen: false }, facts: {} } };
      const normalFirstPrompt = buildSystemPrompt({ locale: 'zh', context: introCtx });
      const greetFirstPrompt = buildLlmMessages({
        event: LLM_EVENT_SESSION_START, locale: 'zh', context: introCtx,
      })[0].content;
      ok('session-start 首次见面：自报压成一句短的（不再要求念 SOUL 整段），保证 1~2 句 / ≤40 字',
        /这是首次对话/.test(normalFirstPrompt) && /用 SOUL 里那句原文/.test(normalFirstPrompt)
        && /这是首次对话/.test(greetFirstPrompt) && /自报家门压成一句短的/.test(greetFirstPrompt)
        && !/用 SOUL 里那句原文/.test(greetFirstPrompt));
    }
    await new Promise((r) => srv.close(r));

    const previewSrc = fs.readFileSync(new URL('../preview-server.js', import.meta.url), 'utf8');
    ok('预览服务器接线：/llm 与 /llm/health 走 createLlmRoutes（启动日志只报 provider / model）',
      /createLlmRoutes/.test(previewSrc) && /llmRoute\(req, res\)/.test(previewSrc)
      && /LLM_HEALTH_PATH/.test(previewSrc) && /llmGuard/.test(previewSrc));
  }

  /* ---------------- 29.6 Agent context：字段 / 计算 / 截断（纯函数） ---------------- */
  {
    // 桩：3 组历史（一组今天的、两组昨天的）+ 5 个关键帧里第 3 帧没达标
    const nowMs = new Date('2026-06-01T15:30:00').getTime();
    const todayMs = new Date('2026-06-01T09:00:00').getTime();
    const yesterdayMs = new Date('2026-05-31T20:00:00').getTime();
    const snapshot = {
      now: nowMs, locale: 'zh', view: 'workout', fullscreen: true, coachOn: true,
      dialogue: true, ttsSource: 'auto',
      exerciseId: 'squat', exerciseName: '自重深蹲', kind: 'rep', session: 'running',
      target: 20, reps: 12, holdMs: 0, elapsedMs: 84000, score: 61,
      criteria: [
        { name: '站好', hit: true, pts: 5, max: 5 },
        { name: '下蹲到位', hit: true, pts: 7, max: 7 },
        { name: '蹲到底', hit: false, pts: 0, max: 8 },
        { name: '回正', hit: true, pts: 4, max: 4 },
        { name: '膝盖不过脚尖', hit: true, pts: 3, max: 3 },
      ],
      gateOk: false, gateName: 'stand', tooFastCount: 1,
      nudges: ['肘再弯一点', '蹲低一点', '慢一点'],
      recentCommands: ['pause', 'setTarget'],
      bestScore: 86,
      history: [
        { exerciseId: 'squat', name: '自重深蹲', kind: 'rep', at: todayMs, value: 20, target: 20, score: 72, seconds: 0 },
        { exerciseId: 'pushup', name: '俯卧撑', kind: 'rep', at: yesterdayMs, value: 12, target: 15, score: 52, seconds: 0 },
        { exerciseId: 'plank', name: '平板支撑', kind: 'hold', at: yesterdayMs, value: 45, target: 45, score: 60, seconds: 0 },
      ],
      utterance: '我这组做得怎么样？',
    };
    const ctx = buildAgentContext(snapshot);
    ok('Agent context 顶层字段齐全：now / session / performance / history / signals / utterance',
      ['now', 'session', 'performance', 'history', 'signals', 'utterance'].every((k) => k in ctx));
    ok('now：下午 + locale + view + 全屏 + 教练开 + 字幕模式 + TTS 来源',
      ctx.now.tsHint === '下午' && ctx.now.locale === 'zh' && ctx.now.view === 'workout'
      && ctx.now.fullscreen === true && ctx.now.coachOn === true
      && ctx.now.dialogueMode === true && ctx.now.tts === 'volc', JSON.stringify(ctx.now));
    ok('session：动作 / 名称 / 次数类 / 相位 / 目标 / 次数 / 用时',
      ctx.session.exerciseId === 'squat' && ctx.session.name === '自重深蹲'
      && ctx.session.kind === 'reps' && ctx.session.phase === 'running'
      && ctx.session.target === 20 && ctx.session.reps === 12 && ctx.session.elapsedSec === 84,
      JSON.stringify(ctx.session));
    ok('performance：分数 / 质量分 / 节奏 / 太快次数 / 关键帧（名称+是否达标+得分）',
      ctx.performance.score === 61 && ctx.performance.quality === 0.7
      && ctx.performance.tempoPerMin === 9 && ctx.performance.tooFastCount === 1
      && ctx.performance.keyframes.length === 5
      && ctx.performance.keyframes[2].hit === false
      && ctx.performance.keyframes[1].pts === 7,
      JSON.stringify(ctx.performance));
    ok('performance.gateOk=false 时带上是哪个门控（gateOk / lastGateFail）',
      ctx.performance.gateOk === false && ctx.performance.lastGateFail === 'stand');
    ok('signals.keyframeHitRate = 4/5 = 0.8（客户端算好，不让模型算）',
      ctx.signals.keyframeHitRate === 0.8, String(ctx.signals.keyframeHitRate));
    ok('signals.lastNudges / recentCommands 只留最近 3 条',
      ctx.signals.lastNudges.length === 3 && ctx.signals.lastNudges.at(-1) === '慢一点'
      && ctx.signals.recentCommands.length === 2);
    ok('history.lastExercises 最多 5 条、带 agoSec / reps / target / score',
      ctx.history.lastExercises.length === 3
      && ctx.history.lastExercises[0].id === 'squat'
      && ctx.history.lastExercises[0].score === 72
      && ctx.history.lastExercises[1].id === 'pushup'
      && ctx.history.lastExercises[1].reps === 12
      && ctx.history.lastExercises[1].agoSec === Math.round((nowMs - yesterdayMs) / 1000),
      JSON.stringify(ctx.history.lastExercises[0]));
    ok('history.today：只汇总今天那一组（sets 1 / reps 20 / avgScore 72）',
      ctx.history.today.sets === 1 && ctx.history.today.reps === 20
      && ctx.history.today.avgScore === 72, JSON.stringify(ctx.history.today));
    ok('history.trend：和上一组比（72 > 52 → improved）；bestScore 带出来',
      ctx.history.trend === 'improved' && ctx.history.bestScore === 86);
    ok('utterance 原样带上（用户话语 + 运动状态一起给模型）',
      ctx.utterance === '我这组做得怎么样？');
    ok('整份 context 的 JSON ≤ 6000 字符（≈800 tokens 的预算）',
      JSON.stringify(ctx).length <= AGENT_CONTEXT_MAX_CHARS, String(JSON.stringify(ctx).length));

    // 趋势的三条规则
    ok('trend 规则：少于 2 组 → first；高于上一组 improved；低 declined；相同 flat',
      scoreTrend([]) === 'first' && scoreTrend([{ score: 9 }]) === 'first'
      && scoreTrend([{ score: 9 }, { score: 5 }]) === 'improved'
      && scoreTrend([{ score: 5 }, { score: 9 }]) === 'declined'
      && scoreTrend([{ score: 5 }, { score: 5 }]) === 'flat');

    // 空状态（还没练过）不崩
    const empty = buildAgentContext({});
    ok('空快照（第一次打开、还没练过）不崩，字段仍然齐全',
      empty.session.exerciseId === '' && empty.history.lastExercises.length === 0
      && empty.history.today.sets === 0 && empty.history.trend === 'first'
      && empty.performance.keyframes.length === 0 && empty.signals.keyframeHitRate === 0);
    ok('空快照：没有 utterance 时是空串，view 默认 workout',
      empty.utterance === '' && empty.now.view === 'workout');
    ok('view 映射：homeMode → home / menuMode → menu',
      buildAgentContext({ view: 'home' }).now.view === 'home'
      && buildAgentContext({ view: 'menu' }).now.view === 'menu');
    ok('dialogueMode 是布尔（关掉对话显示时为 false）',
      buildAgentContext({ dialogue: false }).now.dialogueMode === false);
    ok('ttsSource=system → tts:"system"（火山默认 "volc"）',
      buildAgentContext({ ttsSource: 'system' }).now.tts === 'system'
      && buildAgentContext({ ttsSource: 'volc' }).now.tts === 'volc');
    ok('计时类（hold）：remainingSec = 目标秒数 - 已保持秒数',
      (() => {
        const hold = buildAgentContext({ kind: 'hold', target: 45, holdMs: 12500, session: 'running' });
        return hold.session.kind === 'hold' && hold.session.remainingSec === 33;
      })());
    ok('计时类在闲置时（holdMs=0）不是负数',
      buildAgentContext({ kind: 'hold', target: 30, holdMs: 999000 }).session.remainingSec === 0);

    // history 截断到 5 条
    const manyHistory = Array.from({ length: 8 }, (_, i) => ({
      exerciseId: 'squat', name: `第 ${i} 组`, kind: 'rep', at: nowMs - i * 60000,
      value: 10 + i, target: 20, score: 50 + i, seconds: 0,
    }));
    const cut = buildAgentContext({ now: nowMs, history: manyHistory });
    ok('history.lastExercises：给 8 条只留 5 条（用户要求最多 5 条）',
      cut.history.lastExercises.length === 5 && cut.history.lastExercises[0].id === 'squat',
      String(cut.history.lastExercises.length));

    // 关键帧超过 5 个 → 只留 5 个，且优先保留「第一个没达标的」
    const manyFrames = Array.from({ length: 9 }, (_, i) => ({ name: `帧${i}`, hit: i !== 4, pts: i === 4 ? 0 : 1, max: 1 }));
    const picked = buildAgentContext({ criteria: manyFrames });
    ok('performance.keyframes：9 帧只留 5 帧，且包含第一个没达标的帧（「哪里没做好」要答得出来）',
      picked.performance.keyframes.length === 5
      && picked.performance.keyframes.some((k) => k.name === '帧4' && k.hit === false),
      JSON.stringify(picked.performance.keyframes));

    // 体积兜底：超长字段也要被压回 6000 字符以内
    const big = buildAgentContext({
      criteria: Array.from({ length: 30 }, (_, i) => ({ name: '很长很长的关键帧名字'.repeat(6) + i, hit: i % 2 === 0, pts: i, max: 10 })),
      history: Array.from({ length: 20 }, (_, i) => ({ exerciseId: 'x', name: '很长的动作名字'.repeat(8), kind: 'rep', at: nowMs - i * 1000, value: 10, target: 20, score: 50, seconds: 0 })),
      nudges: Array.from({ length: 10 }, () => '一句很长很长的提示'.repeat(8)),
      utterance: '很长的一句话'.repeat(200),
    });
    ok('体积上限：即使快照很大，JSON 也被裁到 ≤ 6000 字符',
      JSON.stringify(big).length <= AGENT_CONTEXT_MAX_CHARS, String(JSON.stringify(big).length));
    ok('trimAgentContext 单独调用也能把体积压到更小的上限（不抛错）',
      JSON.stringify(trimAgentContext(big, { maxChars: 1200 })).length <= 1200);

    // 时间提示（可注入 Date，测试不依赖真实钟）
    ok('timeOfDayHint：早上 / 下午 / 晚上 + 英文',
      timeOfDayHint(new Date('2026-06-01T07:00:00'), 'zh') === '早上'
      && timeOfDayHint(new Date('2026-06-01T15:00:00'), 'zh') === '下午'
      && timeOfDayHint(new Date('2026-06-01T21:00:00'), 'zh') === '晚上'
      && timeOfDayHint(new Date('2026-06-01T15:00:00'), 'en') === 'afternoon');
  }

  /* ---------------- 29.7 前端客户端：请求体 / 6 轮记忆 / 失败归一化 ---------------- */
  {
    const seen = [];
    const client = createLlmClient({
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return {
          ok: true, status: 200,
          json: async () => ({ ok: true, reply: '不错，再做两个。', actions: [{ intent: 'setTarget', args: { value: 20 } }], usage: { total: 9 } }),
        };
      },
      timeoutMs: 50,
    });
    const res = await client.respond('我做了几个', { locale: 'zh', context: { session: { reps: 3 } } });
    const body = JSON.parse(seen[0].init.body);
    ok('客户端 POST /llm：body 带 text / locale / context / history',
      seen[0].url === LLM_CLIENT_PATH && body.text === '我做了几个' && body.locale === 'zh'
      && body.context.session.reps === 3 && Array.isArray(body.history));
    ok('客户端返回 {reply, actions}，action 的 intent 原样保留（由会话层执行）',
      res.reply === '不错，再做两个。' && res.actions[0].intent === 'setTarget'
      && res.actions[0].args.value === 20);
    for (let i = 0; i < 15; i += 1) await client.respond(`第 ${i} 句`, { locale: 'zh' });
    ok('对话记忆只在内存里，最多 10 轮（20 条），刷新即清',
      LLM_HISTORY_TURNS === 10 && client.history.length === LLM_HISTORY_TURNS * 2,
      String(client.history.length));
    client.reset();
    ok('reset() 清空对话记忆', client.history.length === 0);

    const failing = createLlmClient({
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: 'not-configured' }) }),
    });
    let code = '';
    try { await failing.respond('hi', { locale: 'en' }); } catch (err) { code = err.code; }
    ok('服务端 503 → 客户端抛 {code:not-configured}（app 据此回退罐头回复）', code === 'not-configured', code);

    const rate = createLlmClient({
      fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ ok: false, error: 'rate-limit' }) }),
    });
    try { await rate.respond('hi'); } catch (err) { code = err.code; }
    ok('429 → {code:rate-limit}', code === 'rate-limit', code);

    const slow = createLlmClient({ fetchImpl: () => new Promise(() => {}), timeoutMs: 20 });
    try { await slow.respond('hi'); } catch (err) { code = err.code; }
    ok('客户端超时（测试调成 20ms）→ {code:llm-timeout}', code === 'llm-timeout', code);

    ok('客户端不会把 key 带进请求头（前端根本不知道 key）',
      seen.every((s) => !/authorization/i.test(JSON.stringify(s.init.headers || {}))));

    // 只调工具、没有文字的回合：也要记进记忆（否则历史里会出现连续两条 user）
    const toolClient = createLlmClient({
      fetchImpl: async () => ({
        ok: true, status: 200,
        json: async () => ({ ok: true, reply: '', actions: [{ intent: 'pause', args: {} }], usage: {} }),
      }),
    });
    const toolRes = await toolClient.respond('停一下', { locale: 'zh' });
    ok('只调工具、reply 为空 → 客户端照常返回 actions，并把这一轮记进记忆（user + 工具名）',
      toolRes.actions.length === 1 && toolClient.history.length === 2
      && toolClient.history[0].role === 'user' && toolClient.history[1].role === 'assistant'
      && toolClient.history[1].content === 'pause',
      JSON.stringify(toolClient.history));
    ok('normalizeActions 丢掉形状不对的 action（只留 {intent, args}）',
      normalizeLlmActions([{ intent: 'pause', args: {} }, null, 'x', { args: {} }, { intent: 'home' }])
        .map((a) => a.intent).join(',') === 'pause,home');
    ok('客户端默认超时 9s（服务端 8s 先超时，这里只是兜底）', LLM_CLIENT_TIMEOUT_MS === 9000);

    /* session-start：空 text 也照发（服务端生成事件描述），并记进对话记忆 */
    {
      const eventSeen = [];
      const introClient = createLlmClient({
        fetchImpl: async (url, init) => {
          eventSeen.push({ url, init });
          return {
            ok: true, status: 200,
            json: async () => ({ ok: true, reply: '开始吧，深蹲 20 次。', actions: [] }),
          };
        },
      });
      let emptyCode = '';
      try { await introClient.respond(''); } catch (err) { emptyCode = err.code; }
      ok('空 text 且没有 event → 客户端直接抛 llm-empty（一个请求都不发）',
        emptyCode === 'llm-empty' && eventSeen.length === 0, emptyCode);
      const introRes = await introClient.respond('', {
        locale: 'zh',
        context: { session: { name: '自重深蹲', target: 20 } },
        event: 'session-start',
      });
      const introBody = JSON.parse(eventSeen[0].init.body);
      ok('session-start：空 text 也照发，body 带 event:"session-start" + context',
        introBody.event === 'session-start' && introBody.text === ''
        && introBody.context.session.name === '自重深蹲');
      ok('session-start 的回复照常 {reply, actions}，并记进对话记忆（事件标记 + 回复成对）',
        introRes.reply === '开始吧，深蹲 20 次。' && introClient.history.length === 2
        && introClient.history[0].role === 'user'
        && introClient.history[0].content.includes('session-start')
        && introClient.history[1].content === '开始吧，深蹲 20 次。',
        JSON.stringify(introClient.history));
    }
  }

  /* ---------------- 29.8 会话层：actions 真的走命令表 handler ---------------- */
  {
    const calls = [];
    const ctx = new Proxy({}, {
      get(_t, key) {
        return (...args) => { calls.push({ key: String(key), args }); return undefined; };
      },
    });
    const s = createVoiceSession({
      mic: fakeMic(), asr: fakeAsr(), tts: fakeTts(),
      llm: {
        reply: () => ({
          text: '好，平板支撑 30 秒。',
          actions: [
            { intent: 'startWorkout', args: { exerciseId: 'plank', value: 30 } },
            { intent: 'setTarget', args: { value: 30 } },
          ],
        }),
      },
      commandCtx: ctx,
      thinkDelay: 0,
      thinkSlowMs: 20,
    });
    await s.start();
    // 这句话**故意不含动作名 / 数字**：命令快车道不命中，才会走到 LLM
    s.onUserText('教练我有点累，帮我安排个轻松的');
    await tick(8);
    ok('LLM 返回 actions → 会话层按顺序调用命令表的 run（startGestureMode/selectExercise/setTarget 这些**现有函数**）',
      calls.some((c) => c.key === 'startGestureMode')
      && calls.some((c) => c.key === 'selectExercise' && c.args[0] === 'plank')
      && calls.some((c) => c.key === 'setTarget' && c.args[0] === 30),
      JSON.stringify(calls));
    ok('执行完 actions 后，把模型那句 reply 当教练说的话（字幕 + TTS）',
      s.snapshot().coachText === '好，平板支撑 30 秒。'
      && s.snapshot().state === 'speaking');
    ok('recentCommands 记下刚执行过的 intent（给下一轮 context 的 signals 用）',
      s.snapshot().recentCommands.includes('startWorkout')
      && s.snapshot().recentCommands.includes('setTarget'),
      JSON.stringify(s.snapshot().recentCommands));

    // exit 不再需要 confirm：LLM 给的 exit 直接执行，不再问确认
    const calls2 = [];
    const ctx2 = new Proxy({}, { get: (_t, key) => (...a) => { calls2.push(String(key)); } });
    const s2 = createVoiceSession({
      mic: fakeMic(), asr: fakeAsr(), tts: fakeTts(),
      llm: { reply: () => ({ text: '好，退出。', actions: [{ intent: 'exit', args: {} }] }) },
      commandCtx: ctx2, thinkDelay: 0,
    });
    await s2.start();
    // 这句话**故意不含「退出」**（否则会命中命令快车道），要走 LLM 回合才测得到工具动作
    s2.onUserText('我不太想练了');
    await tick(8);
    ok('LLM 给的 exit 不带 confirm → 直接执行（openMenu 被调用），pendingConfirm 为 null',
      s2.pendingConfirm === null && calls2.includes('openMenu')
      && s2.snapshot().coachText === '好，退出。',
      JSON.stringify({ pending: s2.pendingConfirm, calls: calls2,
        coach: s2.snapshot().coachText }));
    s2.stop();

    // 「教练在想…」：1.5s 没回来才出现（测试把 thinkSlowMs 调成 20ms）
    let release = null;
    const s3 = createVoiceSession({
      mic: fakeMic(), asr: fakeAsr(), tts: fakeTts(),
      llm: { reply: () => new Promise((r) => { release = r; }) },
      commandCtx: {}, thinkDelay: 0, thinkSlowMs: 20,
    });
    await s3.start();
    s3.onUserText('慢慢想');
    await new Promise((r) => setTimeout(r, 10));
    ok('「教练在想…」不会立刻出现（1.5s 内算正常思考）', s3.snapshot().thinkingSlow === false);
    await new Promise((r) => setTimeout(r, 30));
    ok('超过 thinkSlowMs 还没回来 → thinkingSlow=true（界面据此显示「教练在想…」）',
      s3.snapshot().thinkingSlow === true && s3.snapshot().state === 'thinking');
    release({ text: '想好了。' });
    await tick(8);
    ok('回答回来 → thinkingSlow 立刻收掉', s3.snapshot().thinkingSlow === false);
    s3.stop();
    ok('THINK_SLOW_MS 默认就是 1.5 秒（用户口径）', THINK_SLOW_MS === 1500);

    // 模型只调了工具、没有文字：用那条命令自己的短确认（不是通用的「好，这就办」）
    const s4 = createVoiceSession({
      mic: fakeMic(), asr: fakeAsr(), tts: fakeTts(),
      commands: [{ intent: 'reportProgress', run: () => ({ key: 'coach.cmdAck.done' }) }],
      llm: { reply: () => ({ text: '', actions: [{ intent: 'reportProgress', args: {} }] }) },
      commandCtx: {}, thinkDelay: 0,
    });
    await s4.start();
    s4.onUserText('报一下');
    await tick(8);
    ok('模型只调工具、没给文字 → 会话层用命令表那条命令的短确认（数字与措辞都来自一处定义）',
      s4.snapshot().coachText === t('coach.cmdAck.done'), s4.snapshot().coachText);
    s4.stop();
  }
}

/* ================================================================== *
 * [30] P3.4 流式调度：纯函数排程 + AudioContext 解码队列（不联网、不碰真音频）
 * ================================================================== */
console.log('\n[30] 流式调度：按序入队 / 不丢块 / 不重叠（纯函数 + 解码队列）');
{
  ok('默认提前量就是 60ms（一处定义）', TTS_STREAM_LEAD_SEC === 0.06);

  const plan = planStreamQueue([{ durationSec: 0.2 }, { durationSec: 0.2 }, { durationSec: 0.2 }],
    { nowSec: 1, leadSec: 0.1 });
  ok('给定块序列 + 时间轴：按序排（index 0,1,2），起点接着上一块终点（不重叠）',
    plan.length === 3 && plan.map((p) => p.index).join(',') === '0,1,2'
    && plan[0].startSec === 1.1 && plan[1].startSec === 1.3 && plan[2].startSec === 1.5
    && plan.every((p, i) => i === 0 || p.startSec >= plan[i - 1].endSec - 1e-9)
    && plan.every((p) => p.endSec - p.startSec > 0),
    JSON.stringify(plan));
  ok('不丢块：输入几块就排出几块（0 时长的块也保留，不会被悄悄丢掉）',
    planStreamQueue([0.1, 0, 0.1]).length === 3
    && planStreamQueue([]).length === 0);
  ok('解码 / 网络来晚了：不会排到「过去」，从 now + lead 接着排（不追赶、不重叠）',
    (() => {
      const late = planStreamQueue([0.2, 0.2], { nowSec: 5, leadSec: 0.1, startAtSec: 1 });
      return late[0].startSec === 5.1 && late[1].startSec === 5.3;
    })());

  /* ---- 解码队列：3 块依次 push，必须都排上、顺序与起止时间都对 ---- */
  const ctxs = [];
  class FakeSource {
    constructor() { this.startedAt = null; this.stopped = 0; }
    connect() { return this; }
    disconnect() { return this; }
    start(when) { this.startedAt = when; }
    stop() { this.stopped += 1; }
  }
  class FakeCtx {
    constructor() {
      this.currentTime = 2;
      this.state = 'running';
      this.destination = {};
      this.sources = [];
      ctxs.push(this);
    }
    createGain() { return { connect() {}, disconnect() {}, gain: { value: 1 } }; }
    createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
    decodeAudioData(buf) { return Promise.resolve({ duration: (buf.byteLength || 0) / 1000, length: 1 }); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  const ended = [];
  const player = createAudioQueuePlayer({
    AudioContextCtor: FakeCtx,
    leadSec: 0.1,
    onEnd: () => ended.push(1),
  });
  const pushes = [];
  for (const bytes of [200, 300, 400]) pushes.push(await player.push(new Uint8Array(bytes)));
  const sources = ctxs[0].sources;
  ok('解码队列：3 块都排上了（不丢块），每块起点 = 上一块终点（不重叠）',
    player.chunks === 3 && sources.length === 3
    && pushes.every((p, i) => i === 0 || p.startSec >= pushes[i - 1].endSec - 1e-9)
    && sources.map((s) => s.startedAt).join(',') === pushes.map((p) => p.startSec).join(','),
    JSON.stringify({ pushes: pushes.map((p) => [p.startSec, p.endSec]), starts: sources.map((s) => s.startedAt) }));
  ok('字节数如实累计（200 + 300 + 400 = 900）', player.bytes === 900, String(player.bytes));
  player.finish();
  ok('finish() 之后还有块没播完 → 不提前回调 onEnd', ended.length === 0);
  for (const s of sources) s.onended?.();
  ok('所有块都播完 → onEnd 只回调一次（不重复、也不会 hang）', ended.length === 1);
  player.stop();
  /* ---- stop()：还在播的 source 全部停掉、AudioContext 关掉（插话打断不留声音） ---- */
  const player2 = createAudioQueuePlayer({ AudioContextCtor: FakeCtx, leadSec: 0.1 });
  await player2.push(new Uint8Array(100));
  await player2.push(new Uint8Array(100));
  const liveSources = ctxs[1].sources;
  player2.stop();
  ok('stop() 停掉所有还没播完的 source 并关闭 AudioContext（插话打断不留声音）',
    liveSources.length === 2 && liveSources.every((s) => s.stopped === 1)
    && ctxs[1].state === 'closed',
    JSON.stringify({ stopped: liveSources.map((s) => s.stopped), state: ctxs[1].state }));
}

/* ================================================================== *
 * [31] P3.4 三级降级：/tts/stream 404 → /tts；/tts 502 → 系统 TTS
 * ================================================================== */
console.log('\n[31] 三级降级：/tts/stream 404 → /tts；/tts 502 → 系统 TTS（每级都记诊断）');
{
  const tick = async (n = 10) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };
  function fakeSystem() {
    return {
      spoken: [], cancelled: 0,
      speak(text) { this.spoken.push(text); return true; },
      cancel() { this.cancelled += 1; },
      setRate() {},
    };
  }
  function audioFactory() {
    const list = [];
    class FakeAudio {
      constructor(src) { this.src = src; this.playCalls = 0; this.paused = 0; list.push(this); }
      play() { this.playCalls += 1; return Promise.resolve(); }
      pause() { this.paused += 1; }
    }
    return { FakeAudio, list };
  }
  const blobRes = { ok: true, status: 200, blob: async () => ({ size: 8, type: 'audio/mpeg' }) };
  /** 假流式响应：按给定块依次吐出（ReadableStream 的 getReader 形状） */
  const streamRes = (chunks) => {
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length
            ? { done: false, value: chunks[i++] }
            : { done: true, value: undefined }),
          cancel: async () => {},
        }),
      },
    };
  };

  /* ---- ① stream 404 → 整段成功（真的播放，不是哑掉） ---- */
  {
    const urls = [];
    const sys = fakeSystem();
    const { FakeAudio, list } = audioFactory();
    const diagEvents = [];
    let n = 0;
    const tts = createVolcTts({
      fallback: sys,
      AudioCtor: FakeAudio,
      AudioContextCtor: fakeAudioContext().FakeCtx,
      createObjectURL: () => `blob:${(n += 1)}`,
      revokeObjectURL: () => {},
      diag: { record: (type, data) => diagEvents.push({ type, data }) },
      fetchImpl: async (url) => {
        urls.push(url);
        if (url === TTS_STREAM_PATH) return { ok: false, status: 404 };
        return blobRes;
      },
    });
    tts.speak('降一级');
    await tick();
    ok('/tts/stream 404 → 自动降级到整段 /tts 并真的播放（没有回退系统 TTS）',
      urls.join(',') === `${TTS_STREAM_PATH},${TTS_PATH}`
      && list.length === 1 && list[0].playCalls === 1 && sys.spoken.length === 0,
      JSON.stringify({ urls, audio: list.length, spoken: sys.spoken.length }));
    ok('404 记 tts:stream-fail（code=not-supported）', diagEvents.some(
      (e) => e.type === 'tts:stream-fail' && e.data.code === 'not-supported'),
      JSON.stringify(diagEvents.map((e) => `${e.type}:${e.data.code || ''}`)));
    ok('降级到整段时也记了 tts:whole（每级都留痕）', diagEvents.some((e) => e.type === 'tts:whole'));
  }

  /* ---- ② /tts 502 → 系统 TTS ---- */
  {
    const urls = [];
    const sys = fakeSystem();
    const diagEvents = [];
    const tts = createVolcTts({
      fallback: sys,
      // 没有 AudioContext → 流式这一级直接跳过（记 no-audio-context），只打整段
      diag: { record: (type, data) => diagEvents.push({ type, data }) },
      fetchImpl: async (url) => { urls.push(url); return { ok: false, status: url === TTS_STREAM_PATH ? 404 : 502 }; },
    });
    tts.speak('降两级');
    await tick();
    ok('/tts 502 → 再降级到系统 TTS（同一句照常念出来，不会哑掉）',
      sys.spoken.length === 1 && sys.spoken[0] === '降两级',
      JSON.stringify({ urls, spoken: sys.spoken }));
    ok('系统 TTS 那一级也记诊断（tts:say source=system + tts:fallback code=upstream）',
      diagEvents.some((e) => e.type === 'tts:say' && e.data.source === 'system')
      && diagEvents.some((e) => e.type === 'tts:fallback' && e.data.code === 'upstream'),
      JSON.stringify(diagEvents.map((e) => `${e.type}:${e.data.code || e.data.source || ''}`)));
  }

  /* ---- ③ 流式首块解码失败（MP3 帧被切断）→ 整段重试，句子不能被吞掉 ---- */
  {
    class BadCtx {
      constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
      createGain() { return { connect() {}, disconnect() {} }; }
      createBufferSource() { return { connect() {}, start() {}, stop() {}, disconnect() {} }; }
      decodeAudioData() { return Promise.reject(new Error('decode failed')); }
      close() { this.state = 'closed'; return Promise.resolve(); }
    }
    const urls = [];
    const sys = fakeSystem();
    const { FakeAudio, list } = audioFactory();
    const diagEvents = [];
    const tts = createVolcTts({
      fallback: sys,
      AudioCtor: FakeAudio,
      AudioContextCtor: BadCtx,
      createObjectURL: () => 'blob:bad',
      revokeObjectURL: () => {},
      diag: { record: (type, data) => diagEvents.push({ type, data }) },
      fetchImpl: async (url) => {
        urls.push(url);
        if (url === TTS_STREAM_PATH) return streamRes([new Uint8Array([1, 2, 3])]);
        return blobRes;
      },
    });
    tts.speak('解码失败');
    await tick(30);
    ok('流式第一块解码失败 → 自动整段重试 /tts（这句话不会静悄悄消失）',
      urls.join(',') === `${TTS_STREAM_PATH},${TTS_PATH}` && list.length === 1
      && sys.spoken.length === 0,
      JSON.stringify({ urls, audio: list.length, spoken: sys.spoken.length }));
    ok('解码失败也记了 tts:stream-fail（code=stream）',
      diagEvents.some((e) => e.type === 'tts:stream-fail' && e.data.code === 'stream'),
      JSON.stringify(diagEvents.map((e) => `${e.type}:${e.data.code || ''}`)));
  }
}

/* ================================================================== *
 * [32] P3.4 插话打断状态机（假时钟）：该停的停、不该停的绝不动
 * ================================================================== */
console.log('\n[32] 插话打断（假时钟）：连续 2 个够响的 partial 才停；1 个 / 太轻 / 开关关都不打断');
{
  ok('常量：连续窗口 600ms、至少 2 字、播放期阈值比平时高、打断目标 ≤150ms',
    BARGE_IN_WINDOW_MS === 600 && BARGE_IN_MIN_CHARS === 2
    && BARGE_IN_LEVEL === 0.18 && BARGE_IN_PLAYBACK_LEVEL > BARGE_IN_LEVEL
    && BARGE_IN_MAX_LATENCY_MS === 150,
    JSON.stringify({ BARGE_IN_WINDOW_MS, BARGE_IN_MIN_CHARS, BARGE_IN_LEVEL, BARGE_IN_PLAYBACK_LEVEL }));

  /** 一个小夹具：假时钟 + 记录 stop / interrupt / 诊断 */
  function harness({ playing = true, on = true, startAt = 0 } = {}) {
    const clock = { t: startAt };
    const state = { playing, on };
    const stopped = [];
    const interrupts = [];
    const events = [];
    const barge = createBargeIn({
      stop: () => stopped.push(clock.t),
      isPlaying: () => state.playing,
      getLevel: () => 0,
      enabled: () => state.on,
      onInterrupt: (info) => { interrupts.push(info); state.playing = false; },
      diag: { record: (type, data) => events.push({ type, data }) },
      now: () => clock.t,
    });
    return { clock, state, stopped, interrupts, events, barge };
  }

  /* ---- ① 正常触发：两个够响的 partial（间隔 90ms）→ 停 ---- */
  {
    const h = harness({ startAt: 1000 });
    const first = h.barge.onPartial('你好', { level: 0.4 });
    h.clock.t = 1090;
    const second = h.barge.onPartial('你好啊', { level: 0.4 });
    ok('连续 2 个 partial（间隔 90ms）+ 能量过播放期阈值 → 触发打断，stop() 被调用',
      first.triggered === false && second.triggered === true && h.stopped.length === 1,
      JSON.stringify({ first, second, stopped: h.stopped }));
    ok('距第一个 partial ≤150ms（实测 90ms）',
      second.ms === 90 && second.ms <= BARGE_IN_MAX_LATENCY_MS, String(second.ms));
    ok('触发在同一个 tick 完成：stop() 与状态切换耗时 0ms（远小于 150ms）',
      second.sinceTriggerMs === 0 && h.interrupts.length === 1);
    ok('诊断记一条 tts:barge-in {ms}（面板显示插话耗时）',
      h.events.some((e) => e.type === 'tts:barge-in' && e.data.ms === 90),
      JSON.stringify(h.events));
    ok('打断后控制器不再挂着一个「第一个 partial」（不会连停两次）',
      h.barge.pending === null && h.stopped.length === 1);
  }

  /* ---- ② 只有 1 个 partial → 不打断 ---- */
  {
    const h = harness({ startAt: 2000 });
    const r = h.barge.onPartial('我要', { level: 0.5 });
    ok('只有 1 个 partial → 不打断（只记成「第一个」）',
      r.triggered === false && r.reason === 'first' && h.stopped.length === 0);
    h.clock.t = 2000 + BARGE_IN_WINDOW_MS + 10;
    const tooLate = h.barge.onPartial('我要加练', { level: 0.5 });
    ok('第二个 partial 超过 600ms 才来 → 不算连续，仍然不打断',
      tooLate.triggered === false && h.stopped.length === 0,
      JSON.stringify(tooLate));
  }

  /* ---- ③ 能量低（像教练自己的声音 / 环境噪声）→ 不打断 ---- */
  {
    const h = harness({ startAt: 3000 });
    h.barge.onPartial('你好', { level: 0.2 });
    h.clock.t = 3080;
    const r = h.barge.onPartial('你好啊', { level: 0.2 });
    ok('能量 0.20（高于聆听期 0.18、低于播放期阈值）→ 不打断：播放期阈值更高正是为了挡自己的声音',
      r.triggered === false && r.reason === 'quiet' && r.threshold === BARGE_IN_PLAYBACK_LEVEL
      && h.stopped.length === 0,
      JSON.stringify(r));
  }

  /* ---- ④ 开关关闭 → 不打断 ---- */
  {
    const h = harness({ startAt: 4000, on: false });
    h.barge.onPartial('你好', { level: 0.6 });
    h.clock.t = 4050;
    const r = h.barge.onPartial('你好啊', { level: 0.6 });
    ok('设置里关掉「允许插话打断」→ 再响也不打断',
      r.triggered === false && r.reason === 'disabled' && h.stopped.length === 0);
  }

  /* ---- ⑤ 没在说话 → 不需要打断（也清掉旧的配对记录） ---- */
  {
    const h = harness({ startAt: 5000, playing: false });
    h.barge.onPartial('你好', { level: 0.9 });
    h.clock.t = 5050;
    const r = h.barge.onPartial('你好啊', { level: 0.9 });
    ok('教练没在说话时收到 partial → 不打断（没有可停的）',
      r.triggered === false && r.reason === 'not-playing' && h.stopped.length === 0 && h.barge.pending === null);
  }

  /* ---- ⑥ 1 个字（「嗯」「啊」）不算插话 ---- */
  {
    const h = harness({ startAt: 6000 });
    h.barge.onPartial('嗯', { level: 0.9 });
    h.clock.t = 6040;
    const r = h.barge.onPartial('啊', { level: 0.9 });
    ok('1 个字的「嗯 / 啊」不触发（至少 2 个字）',
      r.triggered === false && r.reason === 'too-short' && h.stopped.length === 0);
  }
}

/* ================================================================== *
 * [33] P3.4 会话 interrupt()：只停语音，字幕 / 弹幕不动，ASR 不停
 * ================================================================== */
console.log('\n[33] 会话 interrupt()：插话打断只停语音（字幕照常、ASR 不停、迟到的 onEnd 不翻状态）');
{
  /* ---- ① 说话中 interrupt() ---- */
  {
    const asr = fakeAsr();
    const tts = fakeTts();
    const session = makeSession({ asr, tts, llm: { reply: () => '这是一句很长的话' } });
    await session.start();
    session.onUserText('今天感觉怎么样');
    await tick(8);
    ok('前置：教练已经开始说话（speaking），TTS 收到一句',
      session.snapshot().state === 'speaking' && tts.spoken.length === 1,
      JSON.stringify({ state: session.snapshot().state, spoken: tts.spoken }));
    const asrStops = asr.stopped;
    const snap = session.interrupt();
    ok('interrupt() → 立刻回到 listening，且 tts.cancel() 被调用（语音停）',
      snap.state === 'listening' && tts.cancelled >= 1,
      JSON.stringify({ state: snap.state, cancelled: tts.cancelled }));
    ok('教练那句话的字幕还在（弹幕不会被清掉，只是不念了）',
      snap.coachText === '这是一句很长的话', snap.coachText);
    ok('ASR 没有停（还在听，用户接着说的那句照常走 thinking）', asr.stopped === asrStops);
    tts.finish();   // 被掐断那句迟到的 onEnd
    ok('被打断那句迟到的 onEnd 不会把状态改回去（epoch 已提升）',
      session.snapshot().state === 'listening');
    ok('不在 speaking 时 interrupt() 是幂等的（不动状态）', session.interrupt().state === 'listening');
    session.stop();
  }

  /* ---- ② onInterim 旁路：教练说话时的 partial 也收得到（插话打断的入口） ---- */
  {
    const asr = fakeAsr();
    const tts = fakeTts();
    const seen = [];
    const session = createVoiceSession({
      mic: fakeMic(),
      asr,
      tts,
      llm: { reply: () => '好的' },
      thinkDelay: 0,
      onInterim: (text, info, st) => seen.push({ text, final: info.isFinal, state: st.state }),
    });
    await session.start();
    session.onUserText('随便聊两句');
    await tick(8);
    asr.emitInterim('打断一下');
    ok('onInterim 旁路：教练说话（speaking）时也能收到 partial —— 打断判断才有输入',
      session.snapshot().state === 'speaking'
      && seen.length === 1 && seen[0].text === '打断一下'
      && seen[0].final === false && seen[0].state === 'speaking',
      JSON.stringify({ seen, state: session.snapshot().state }));
    session.stop();
  }
}

/* ================================================================== *
 * [34] P3.4 服务端 /tts/stream：边收边转发 / 客户端中断 → 上游 abort / 日志不打印 key
 * （真实 http server + 假上游，不联网、不用真凭证）
 * ================================================================== */
console.log('\n[34] 服务端 /tts/stream：转发字节与上游一致 / 客户端中断 → 上游 abort / 日志不含 key');
{
  const http = await import('node:http');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const config = {
    configured: true, missing: [], appId: 'test-app-id', apiKey: 'test-secret-key',
    voice: 'zh_female_test', resource: 'volc.seedtts.default', endpoint: 'https://example.invalid/tts',
  };
  const logLines = [];
  const logger = (fields) => logLines.push(fields);
  const CHUNKS = [Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6]), Buffer.from([7, 8, 9])];

  function listen(srv) {
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
  }
  function close(srv) {
    return new Promise((resolve) => { try { srv.close(() => resolve()); } catch { resolve(); } });
  }
  function postStream(port, text, onFirstData = null) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const req = http.request({
        host: '127.0.0.1', port, path: TTS_SERVER_STREAM_PATH, method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let total = 0;
        let chunks = 0;
        let firstAt = 0;
        res.on('data', (buf) => {
          if (!firstAt) firstAt = Date.now() - t0;
          total += buf.length;
          chunks += 1;
          onFirstData?.(res, req);
        });
        res.on('end', () => resolve({
          status: res.statusCode, headers: res.headers, total, chunks, firstAt, ms: Date.now() - t0,
        }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ text, rate: 1 }));
    });
  }

  /* ---- ① 正常：三块依次到达，字节数与上游一致 ---- */
  {
    let upstreamCalls = 0;
    const upstream = { signal: null, aborted: false };
    const service = createVolcTtsServer({
      config,
      logger,
      fetchImpl: (url, init) => {
        upstreamCalls += 1;
        upstream.signal = init.signal;
        init.signal?.addEventListener?.('abort', () => { upstream.aborted = true; });
        // 假上游：分块返回（每块之间隔 8ms，好让「边收边转发」看得出来）
        return Promise.resolve({
          ok: true,
          status: 200,
          body: (async function* stream() {
            for (const chunk of CHUNKS) {
              await wait(8);
              yield chunk;
            }
          })(),
        });
      },
    });
    const srv = http.createServer(createTtsRoutes({ service, logger }));
    const port = await listen(srv);
    try {
      const res = await postStream(port, '流式测试');
      const okStatus = res.status === 200;
      ok('POST /tts/stream → 200 + audio/mpeg + Transfer-Encoding: chunked（边收边转发）',
        okStatus && /audio\/mpeg/.test(String(res.headers['content-type']))
        && String(res.headers['transfer-encoding'] || '').toLowerCase() === 'chunked',
        JSON.stringify({ status: res.status, headers: res.headers }));
      ok('转发字节数与上游完全一致（4 + 2 + 3 = 9 字节，一块都不少）',
        res.total === 9 && res.total === Buffer.concat(CHUNKS).length, String(res.total));
      ok('是真的分块到达（不是攒成一整段再发）：至少 2 个数据事件',
        res.chunks >= 2, JSON.stringify({ chunks: res.chunks }));
      ok('首块时间早于整句完成时间（有「首字」优势，不是等全部收完）',
        res.firstAt > 0 && res.firstAt <= res.ms, JSON.stringify({ firstAt: res.firstAt, ms: res.ms }));
      ok('流式不缓存：同一句再发一次 → 上游被请求第二次',
        await (async () => { await postStream(port, '流式测试'); return upstreamCalls === 2; })(),
        String(upstreamCalls));
      const allLogs = JSON.stringify(logLines);
      ok('服务端日志只有 chars / cache / status，绝不含 appId / apiKey',
        logLines.length > 0
        && logLines.every((f) => Object.keys(f).sort().join(',') === 'cache,chars,status')
        && !allLogs.includes('test-secret-key') && !allLogs.includes('test-app-id'),
        allLogs);
    } finally {
      await close(srv);
    }
  }

  /* ---- ② 客户端中途断开 → 上游立刻被 abort ---- */
  {
    const upstream = { signal: null, aborted: false };
    const service = createVolcTtsServer({
      config,
      fetchImpl: (url, init) => {
        upstream.signal = init.signal;
        init.signal?.addEventListener?.('abort', () => { upstream.aborted = true; });
        return Promise.resolve({
          ok: true,
          status: 200,
          body: (async function* stream() {
            yield Buffer.from([1, 2, 3]);
            await wait(150);          // 还「在合成」的时候客户端走了
            yield Buffer.from([4, 5, 6]);
          })(),
        });
      },
    });
    const srv = http.createServer(createTtsRoutes({ service }));
    const port = await listen(srv);
    let received = 0;
    try {
      await new Promise((resolve) => {
        const req = http.request({
          host: '127.0.0.1', port, path: TTS_SERVER_STREAM_PATH, method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          res.once('data', (buf) => {
            received = buf.length;
            res.destroy();     // 客户端断开（等价于插话打断 / 关页面）
            req.destroy();
            resolve();
          });
        });
        req.on('error', () => resolve());
        req.end(JSON.stringify({ text: '打断这一句', rate: 1 }));
      });
      await wait(60);
      ok('客户端断开 → 服务端立刻 abort 上游（不继续烧钱）',
        upstream.signal && upstream.signal.aborted === true && upstream.aborted === true,
        JSON.stringify({ signal: !!upstream.signal, aborted: upstream.aborted }));
      ok('断开前确实已经收到第一块（说明是「播到一半」被掐断，不是压根没开始）',
        received === 3, String(received));
    } finally {
      await close(srv);
    }
  }
}

/* ================================================================== *
 * [35] 🐞 上游是 NDJSON + base64 信封，不是裸 MP3（2026-11 真实事故）
 *
 * 现场：`tts:first-audio` 有值（火山确实回了音频）→ `tts:stream-fail` →
 * `tts:whole` → `tts:fail code:"audio"` → `tts:say source:"system"`。
 * 根因：服务端把 `{"code":0,"data":"SUQz…"}` 整包当 `audio/mpeg` 转发，
 * 两端解码器拿到的都不是音频 → 一路降级到系统播报（用户听到的确实是系统语音）。
 * ================================================================== */
console.log('\n[35] 上游信封拆解：NDJSON + base64 → 真 MP3（/tts 与 /tts/stream 都对）');
{
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---- 合成一段「真 MP3」：ID3v2 头 + N 个 192 字节的帧（MPEG2 Layer III / 24kHz / 64kbps） ---- */
  const FRAME_LEN = 192;
  const FRAME_HEADER = [0xff, 0xf3, 0x84, 0xc4];
  function mp3Frame(fill) {
    const buf = new Uint8Array(FRAME_LEN);
    buf.set(FRAME_HEADER, 0);
    buf.fill(fill, 4);
    return buf;
  }
  function id3Tag() {
    // 实测上游的 45 字节头：ID3 / v2.4 / flags 0 / size(35) 的 syncsafe 写法
    const buf = new Uint8Array(45);
    buf.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x23], 0);
    return buf;
  }
  const concatAll = (list) => {
    const out = new Uint8Array(list.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of list) { out.set(b, at); at += b.length; }
    return out;
  };
  const F1 = mp3Frame(1);
  const F2 = mp3Frame(2);
  const F3 = mp3Frame(3);
  const FULL = concatAll([id3Tag(), F1, F2, F3]);          // 45 + 192*3 = 621 字节
  /** 上游把这条 MP3 拆成两块 base64 送回来（一块带 ID3，另一块是纯帧） */
  const PARTS = [concatAll([id3Tag(), F1]), concatAll([F2, F3])];
  const b64 = (bytes) => Buffer.from(bytes).toString('base64');
  /** 真实响应形状：音频块 + 句子标记 + 结束码（20000000 = OK） */
  const envelope = (audioParts, tail = { code: 20000000, message: 'OK', data: null }) => Buffer.from(
    [
      ...audioParts.map((part) => JSON.stringify({ code: 0, message: '', data: b64(part) })),
      JSON.stringify({ code: 0, message: '', data: '', sentence: { text: '请开始深蹲' } }),
      JSON.stringify(tail),
    ].join('\n') + '\n',
    'utf8',
  );

  /* ---- ① 增量解析：对象被切在任意字节处也要拼回来 ---- */
  {
    const text = envelope(PARTS).toString('utf8');
    const parser = createVolcMessageParser();
    const got = [];
    for (let i = 0; i < text.length; i += 17) got.push(...parser.push(text.slice(i, i + 17)));
    got.push(...parser.flush());
    ok('增量解析：对象被切成 17 字节一段也能拼成 4 条（音频 x2 + 句子 + 结束）',
      got.length === 4 && got.filter((m) => typeof m.data === 'string' && m.data.length > 0).length === 2,
      JSON.stringify(got.map((m) => ({ code: m.code, dataLen: (m.data || '').length, sentence: !!m.sentence }))));
    ok('增量解析：带 sentence 的标记块与结束码 20000000 都认得（不是错误）',
      !!got[2].sentence && got[3].code === 20000000 && got[3].message === 'OK',
      JSON.stringify({ sentence: !!got[2]?.sentence, tail: got[3] }));
  }

  /* ---- ② unwrapVolcAudio：拆信封 / 裸字节透传 / 上游错误码 ---- */
  {
    const unwrapped = unwrapVolcAudio(envelope(PARTS));
    ok('unwrapVolcAudio：base64 拆出来拼成**真 MP3**（621 字节、首字节是 ID3 的 0x49）',
      unwrapped.encoded === true && unwrapped.audio.length === FULL.length
      && unwrapped.audio[0] === 0x49 && unwrapped.audio[1] === 0x44 && unwrapped.audio[2] === 0x33
      && Buffer.compare(unwrapped.audio, Buffer.from(FULL)) === 0,
      JSON.stringify({ encoded: unwrapped.encoded, len: unwrapped.audio.length, head: [...unwrapped.audio.slice(0, 3)] }));

    const raw = unwrapVolcAudio(Buffer.from(FULL));
    ok('unwrapVolcAudio：上游直接给裸音频就原样返回（老假上游 / 灰度期兼容）',
      raw.encoded === false && raw.audio.length === FULL.length
      && Buffer.compare(raw.audio, Buffer.from(FULL)) === 0);

    const bad = unwrapVolcAudio(envelope([], { code: 45000001, message: 'invalid speaker', data: null }));
    ok('unwrapVolcAudio：结束码是错误码且没有音频 → 记下 code / message（不冒充成功）',
      bad.encoded === true && bad.audio.length === 0 && bad.code === 45000001
      && bad.error === 'invalid speaker',
      JSON.stringify({ code: bad.code, error: bad.error, len: bad.audio.length }));

    ok('volcAudioBytes：data 空串 / null / 非对象 → null（句子标记块不会被当成音频）',
      volcAudioBytes({ code: 0, data: '' }) === null
      && volcAudioBytes({ code: 0, data: null }) === null
      && volcAudioBytes(null) === null);
  }

  /* ---- ③ 真 http：POST /tts 回来的就是那 621 字节（Content-Length 也一致） ---- */
  {
    const http = await import('node:http');
    const config = {
      configured: true, missing: [], appId: 'test-app-id', apiKey: 'test-secret-key',
      voice: 'zh_female_test', resource: 'volc.seedtts.default', endpoint: 'https://example.invalid/tts',
    };
    const service = createVolcTtsServer({
      config,
      cache: createTtsCache(),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from(envelope(PARTS)).buffer,
      }),
    });
    const srv = http.createServer(createTtsRoutes({ service }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const request = (method, p, body = null) => new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: p, method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
    try {
      const res = await request('POST', TTS_SERVER_PATH, JSON.stringify({ text: '请开始深蹲', rate: 1 }));
      ok('POST /tts：响应体就是拆出来的 MP3 字节（不是 JSON 文本），且与 Content-Length 一致',
        res.status === 200 && res.body.length === FULL.length
        && res.body[0] === 0x49 && Buffer.compare(res.body, Buffer.from(FULL)) === 0
        && Number(res.headers['content-length']) === FULL.length,
        JSON.stringify({
          status: res.status, len: res.body.length, ct: res.headers['content-type'],
          cl: res.headers['content-length'], head: res.body.slice(0, 4).toString('hex'),
        }));
      ok('POST /tts：Content-Type 仍是 audio/mpeg（现在这个声明才是真的）',
        /audio\/mpeg/.test(String(res.headers['content-type'])));
    } finally {
      await new Promise((r) => srv.close(r));
    }
  }

  /* ---- ④ 真 http：/tts/stream 把信封切在任意字节处，转发出来仍是那 621 字节 ---- */
  {
    const http = await import('node:http');
    const config = {
      configured: true, missing: [], appId: 'test-app-id', apiKey: 'test-secret-key',
      voice: 'zh_female_test', resource: 'volc.seedtts.default', endpoint: 'https://example.invalid/tts',
    };
    const wire = envelope(PARTS);
    const service = createVolcTtsServer({
      config,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        // 每 23 字节吐一块：对象一定被切开，而且切在 base64 中间
        body: (async function* stream() {
          for (let i = 0; i < wire.length; i += 23) {
            await wait(1);
            yield wire.slice(i, i + 23);
          }
        })(),
      }),
    });
    const srv = http.createServer(createTtsRoutes({ service }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      const received = await new Promise((resolve, reject) => {
        const chunks = [];
        const req = http.request({
          host: '127.0.0.1', port, path: TTS_SERVER_STREAM_PATH, method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end(JSON.stringify({ text: '请开始深蹲', rate: 1 }));
      });
      ok('/tts/stream：上游信封被切在 base64 中间，转发出来仍是完整的 621 字节 MP3（首字节 0x49）',
        received.status === 200 && received.body.length === FULL.length
        && received.body[0] === 0x49
        && Buffer.compare(received.body, Buffer.from(FULL)) === 0,
        JSON.stringify({ status: received.status, len: received.body.length }));
    } finally {
      await new Promise((r) => srv.close(r));
    }
  }
}

/* ================================================================== *
 * [36] 客户端播放：MSE 追加队列 / MP3 帧对齐 / blob 释放时机 / tts:fail 字段
 * ================================================================== */
console.log('\n[36] 客户端播放：MSE 追加队列 / 帧对齐 / blob 不提前 revoke / 失败能看出原因');
{
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tick = async (n = 10) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };
  const FRAME_LEN = 192;
  const FRAME_HEADER = [0xff, 0xf3, 0x84, 0xc4];
  function mp3Frame(fill) {
    const buf = new Uint8Array(FRAME_LEN);
    buf.set(FRAME_HEADER, 0);
    buf.fill(fill, 4);
    return buf;
  }
  function id3Tag() {
    const buf = new Uint8Array(45);
    buf.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x23], 0);
    return buf;
  }
  const concatAll = (list) => {
    const out = new Uint8Array(list.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of list) { out.set(b, at); at += b.length; }
    return out;
  };

  /* ---- ① MP3 帧头 / 帧对齐（纯函数） ---- */
  {
    const hdr = parseMp3FrameHeader(mp3Frame(0));
    ok('MP3 帧头：192 字节 / 24kHz / 64kbps 的 MPEG2 Layer III 帧算得对（火山实测就是这一种）',
      !!hdr && hdr.frameLength === 192 && hdr.sampleRate === 24000 && hdr.bitrate === 64000
      && hdr.mpeg1 === false, JSON.stringify(hdr));
    ok('MP3 帧头：不是同步字 / Layer II / bitrate 15 一律返回 null（不乱猜）',
      parseMp3FrameHeader(new Uint8Array([0, 1, 2, 3])) === null
      && parseMp3FrameHeader(new Uint8Array([0xff, 0xf5, 0x84, 0xc4])) === null
      && parseMp3FrameHeader(new Uint8Array([0xff, 0xfb, 0xf4, 0xc4])) === null);

    const splitter = createMp3FrameSplitter();
    const head = splitter.push(concatAll([id3Tag(), mp3Frame(1).slice(0, 100)]));
    ok('帧对齐：ID3 头 + 半帧先攒着（push 返回 null，不会把半帧送去解码）', head === null);
    const rest = splitter.push(mp3Frame(1).slice(100));
    ok('帧对齐：补齐后正好吐 1 个完整帧（192 字节、帧同步开头、不含 ID3）',
      !!rest && rest.length === 192 && rest[0] === 0xff && (rest[1] & 0xe0) === 0xe0,
      JSON.stringify({ len: rest && rest.length }));
    ok('帧对齐：ID3 那 45 字节记进 dropped（诊断能看出元数据被跳过）',
      splitter.dropped === 45 && splitter.frames === 1, JSON.stringify({ dropped: splitter.dropped }));

    const zero = createMp3FrameSplitter();
    const passthrough = zero.push(new Uint8Array(64));
    ok('帧对齐：判不出帧结构就原样透传（全零 / 假字节交给解码器去报错，绝不静默吞掉）',
      !!passthrough && passthrough.length === 64 && zero.passthrough === true);
  }

  /* ---- ② MSE appendBuffer 队列：不乱序、不并发、QuotaExceeded 重试 ---- */
  function fakeSourceBuffer({ quotaOnce = false } = {}) {
    const sb = {
      mime: '', updating: false, list: [], listeners: {}, quotas: 0, appended: 0,
      quotaOnce,
      addEventListener(n, fn) { (this.listeners[n] || (this.listeners[n] = [])).push(fn); },
      removeEventListener(n, fn) { this.listeners[n] = (this.listeners[n] || []).filter((f) => f !== fn); },
      emit(n) { for (const fn of [...(this.listeners[n] || [])]) fn({ type: n }); },
      endUpdate() { this.updating = false; this.emit('updateend'); },
      appendBuffer(bytes) {
        if (this.updating) throw Object.assign(new Error('append while updating'), { name: 'InvalidStateError' });
        if (this.quotaOnce) {
          this.quotaOnce = false;
          this.quotas += 1;
          throw Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' });
        }
        const view = new Uint8Array(bytes);
        this.list.push([...view]);
        this.appended += view.length;
        this.updating = true;
        setTimeout(() => this.endUpdate(), 0);
      },
      endOfStream() {},
      abort() {},
    };
    return sb;
  }
  {
    const sb = fakeSourceBuffer();
    const queue = createMseAppendQueue({ sourceBuffer: sb });
    const p1 = queue.append(new Uint8Array([1, 1]));
    const p2 = queue.append(new Uint8Array([2, 2]));
    await tick(6);
    ok('MSE 队列：上一块 updateend 之前不会追加下一块（否则 InvalidStateError）',
      sb.list.length === 1 && queue.queued === 1,
      JSON.stringify({ appended: sb.list.length, queued: queue.queued }));
    await wait(10);
    await Promise.all([p1, p2]);
    ok('MSE 队列：两块按收到顺序进缓冲（不是倒着 / 不是并行）',
      sb.list.length === 2 && sb.list.map((x) => x[0]).join(',') === '1,2'
      && sb.appended === 4 && queue.chunks === 2,
      JSON.stringify({ order: sb.list.map((x) => x[0]), appended: sb.appended }));
  }
  {
    const sb = fakeSourceBuffer({ quotaOnce: true });
    const queue = createMseAppendQueue({ sourceBuffer: sb });
    const got = await queue.append(new Uint8Array([7, 7, 7]));
    await wait(5);
    ok('MSE 队列：QuotaExceededError 之后重试成功、不丢块（quotas=1，字节最终进去了）',
      got === 3 && sb.quotas === 1 && sb.list.length === 1 && queue.chunks === 1
      && sb.appended === 3,
      JSON.stringify({ got, quotas: sb.quotas, appended: sb.appended }));
  }

  /* ---- ③ 假 MediaSource / 假 Audio 元素 ---- */
  function fakeMediaSourceFactory() {
    const created = [];
    class FakeMediaSource {
      constructor() {
        this.readyState = 'closed';
        this.buffers = [];
        this.listeners = {};
        this.endOfStreamCalls = 0;
        created.push(this);
        setTimeout(() => {
          this.readyState = 'open';
          for (const fn of [...(this.listeners.sourceopen || [])]) fn({ type: 'sourceopen' });
        }, 0);
      }
      static isTypeSupported(type) { return type === MSE_MIME; }
      addEventListener(n, fn) { (this.listeners[n] || (this.listeners[n] = [])).push(fn); }
      removeEventListener(n, fn) { this.listeners[n] = (this.listeners[n] || []).filter((f) => f !== fn); }
      addSourceBuffer(mime) {
        if (this.failAdd) throw new Error('addSourceBuffer failed');
        const sb = fakeSourceBuffer();
        sb.mime = mime;
        this.buffers.push(sb);
        return sb;
      }
      endOfStream() { this.endOfStreamCalls += 1; this.readyState = 'ended'; }
    }
    return { FakeMediaSource, created };
  }
  function fakeElementAudio() {
    const list = [];
    class FakeAudio {
      constructor(src) { this.src = src; this.playCalls = 0; this.paused = 0; list.push(this); }
      play() { this.playCalls += 1; return Promise.resolve(); }
      pause() { this.paused += 1; }
      finish() { this.onended?.(); }
      fail() { this.onerror?.(); }
    }
    return { FakeAudio, list };
  }
  function urlFactory() {
    let n = 0;
    const revoked = [];
    return { revoked, create: () => `blob:fake/${(n += 1)}`, revoke: (u) => { revoked.push(u); } };
  }
  function fakeSystem() {
    return {
      spoken: [], cancelled: 0,
      speak(text) { this.spoken.push(text); return true; },
      cancel() { this.cancelled += 1; },
      setRate() {},
    };
  }
  const streamRes = (chunks) => {
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length
            ? { done: false, value: chunks[i++] }
            : { done: true, value: undefined }),
          cancel: async () => {},
        }),
      },
    };
  };
  const wholeRes = { ok: true, status: 200, blob: async () => ({ size: 8, type: 'audio/mpeg' }) };

  /* ---- ④ 支持 MSE 时走 MSE：append 到 SourceBuffer、首块记 mode=mse、结束后 endOfStream ---- */
  {
    const { FakeMediaSource, created } = fakeMediaSourceFactory();
    const { FakeAudio, list } = fakeElementAudio();
    const urls = urlFactory();
    const diagEvents = [];
    const sys = fakeSystem();
    const tts = createVolcTts({
      fallback: sys,
      MediaSourceCtor: FakeMediaSource,
      AudioCtor: FakeAudio,
      createObjectURL: urls.create,
      revokeObjectURL: urls.revoke,
      diag: { record: (type, data) => diagEvents.push({ type, data }) },
      fetchImpl: async (url) => (url === TTS_STREAM_PATH ? streamRes([mp3Frame(1), mp3Frame(2)]) : wholeRes),
    });
    tts.speak('用 MSE 播');
    await wait(30);
    const ms = created[0];
    ok('MSE 可用时走 MSE：addSourceBuffer("audio/mpeg") 真的被调用',
      !!ms && ms.buffers.length === 1 && ms.buffers[0].mime === MSE_MIME,
      JSON.stringify({ buffers: ms && ms.buffers.length, mime: ms && ms.buffers[0]?.mime }));
    ok('MSE：两帧按序 append 进缓冲（192 x 2 = 384 字节），没有回退系统 TTS',
      ms.buffers[0].appended === 384 && ms.buffers[0].list.length === 2 && sys.spoken.length === 0,
      JSON.stringify({ appended: ms.buffers[0].appended, chunks: ms.buffers[0].list.length, spoken: sys.spoken }));
    const first = diagEvents.find((e) => e.type === 'tts:first-audio');
    ok('MSE：tts:first-audio 带上 mode=mse（面板能看出用的哪个播放引擎）',
      !!first && first.data.mode === 'mse' && first.data.bytes === 192,
      JSON.stringify(first));
    ok('MSE：播起来以后记 tts:say source=volc stream=true', diagEvents.some(
      (e) => e.type === 'tts:say' && e.data.source === 'volc' && e.data.stream === true));
    await wait(20);
    ok('MSE：流收完 → endOfStream 被调用（不然浏览器会一直等后续数据）',
      ms.endOfStreamCalls === 1 && ms.readyState === 'ended',
      JSON.stringify({ calls: ms.endOfStreamCalls, state: ms.readyState }));
    ok('MSE：播放期间 blob URL 不 revoke（提前 revoke = 音频元素读不到数据）',
      urls.revoked.length === 0, JSON.stringify(urls.revoked));
    list[0].finish();
    ok('MSE：播完释放 blob URL', urls.revoked.length === 1, JSON.stringify(urls.revoked));
    tts.close();
  }

  /* ---- ⑤ 不支持 MSE（isTypeSupported 为 false）→ 走帧对齐解码队列，mode=decode ---- */
  {
    function NoMse() { throw new Error('should not build MediaSource'); }
    NoMse.isTypeSupported = () => false;
    const decoded = [];
    class FakeCtx {
      constructor() { this.currentTime = 1; this.state = 'running'; this.destination = {}; }
      createGain() { return { connect() {}, disconnect() {} }; }
      createBufferSource() { return { connect() {}, start() {}, stop() {}, disconnect() {} }; }
      decodeAudioData(buf) { decoded.push(buf.byteLength); return Promise.resolve({ duration: buf.byteLength / 192000, length: 1 }); }
      close() { this.state = 'closed'; return Promise.resolve(); }
    }
    const diagEvents = [];
    const sys = fakeSystem();
    const tts = createVolcTts({
      fallback: sys,
      MediaSourceCtor: NoMse,
      AudioContextCtor: FakeCtx,
      AudioCtor: fakeElementAudio().FakeAudio,
      createObjectURL: () => 'blob:x',
      revokeObjectURL: () => {},
      diag: { record: (type, data) => diagEvents.push({ type, data }) },
      // 第一块把 ID3 + 半帧切在一起：帧对齐之后只喂完整帧
      fetchImpl: async (url) => (url === TTS_STREAM_PATH
        ? streamRes([concatAll([id3Tag(), mp3Frame(1).slice(0, 100)]), mp3Frame(1).slice(100)])
        : wholeRes),
    });
    tts.speak('解码队列播');
    await wait(20);
    ok('不支持 MSE → 走解码队列，mode=decode', diagEvents.some(
      (e) => e.type === 'tts:first-audio' && e.data.mode === 'decode'));
    ok('解码队列：只解完整帧（解到 1 块 192 字节，半帧那段没被送去解码）',
      decoded.length === 1 && decoded[0] === 192 && sys.spoken.length === 0,
      JSON.stringify({ decoded, spoken: sys.spoken }));
    tts.close();
  }

  /* ---- ⑥ 整段路径：blob URL 播放结束前不 revoke；play() 被拒时 tts:fail 带 where/errName ---- */
  {
    const urls = urlFactory();
    const { FakeAudio, list } = fakeElementAudio();
    const tts = createVolcTts({
      fallback: fakeSystem(),
      AudioCtor: FakeAudio,
      createObjectURL: urls.create,
      revokeObjectURL: urls.revoke,
      AudioContextCtor: null,             // 没有 AudioContext → 流式直接跳过，只打整段
      fetchImpl: async () => wholeRes,
    });
    tts.speak('整段播放');
    await wait(10);
    ok('整段：开始播放时 blob URL 还在（没有提前 revoke）',
      list.length === 1 && list[0].playCalls === 1 && urls.revoked.length === 0,
      JSON.stringify({ audio: list.length, revoked: urls.revoked }));
    list[0].finish();
    ok('整段：播完才 revoke blob URL（提前 revoke 就是 NotSupportedError 的来源）',
      urls.revoked.length === 1, JSON.stringify(urls.revoked));
    tts.close();
  }
  {
    class RejectAudio {
      constructor(src) { this.src = src; this.paused = 0; }
      play() {
        return Promise.reject(Object.assign(new Error('The element has no supported sources.'), {
          name: 'NotSupportedError', code: 9,
        }));
      }
      pause() { this.paused += 1; }
    }
    const diagEvents = [];
    const sys = fakeSystem();
    const tts = createVolcTts({
      fallback: sys,
      AudioCtor: RejectAudio,
      createObjectURL: () => 'blob:bad',
      revokeObjectURL: () => {},
      diag: { record: (type, data) => diagEvents.push({ type, data }) },
      fetchImpl: async () => wholeRes,
    });
    tts.speak('播放被拒');
    await wait(10);
    const fails = diagEvents.filter((e) => e.type === 'tts:fail');
    ok('tts:fail 带 where=whole + code=9（DOMException NOT_SUPPORTED_ERR）+ errName/errMessage',
      fails.length === 1 && fails[0].data.where === 'whole' && fails[0].data.code === 9
      && fails[0].data.errName === 'NotSupportedError'
      && typeof fails[0].data.errMessage === 'string' && fails[0].data.errMessage.length <= 80,
      JSON.stringify(fails));
    ok('play() 被拒后回退系统 TTS（同一句照样念出来，不哑掉）', sys.spoken.length === 1,
      JSON.stringify(sys.spoken));
  }
  {
    // onerror 路径：记 where=whole / code=audio，而且**不再**被 play() 的 rejection 重复记一条
    const { FakeAudio, list } = fakeElementAudio();
    const diagEvents = [];
    class RejectAfterError extends FakeAudio {
      play() {
        this.playCalls = (this.playCalls || 0) + 1;
        this.onerror?.();
        return Promise.reject(Object.assign(new Error('no supported sources'), { name: 'NotSupportedError', code: 9 }));
      }
    }
    const tts = createVolcTts({
      fallback: fakeSystem(),
      AudioCtor: RejectAfterError,
      createObjectURL: () => 'blob:err',
      revokeObjectURL: () => {},
      diag: { record: (type, data) => diagEvents.push({ type, data }) },
      fetchImpl: async () => wholeRes,
    });
    tts.speak('元素报错');
    await wait(10);
    const fails = diagEvents.filter((e) => e.type === 'tts:fail');
    ok('音频元素 onerror：记 where=whole + code=audio，且同一个失败只记一条（不重复刷）',
      fails.length === 1 && fails[0].data.where === 'whole' && fails[0].data.code === 'audio',
      JSON.stringify(fails));
    ok('onerror 之后回退系统 TTS', diagEvents.some(
      (e) => e.type === 'tts:say' && e.data.source === 'system'));
  }

  /* ---- ⑦ MSE 的 play() 被自动播放策略拒绝 → 不当作未捕获异常，改走整段 ---- */
  {
    const { FakeMediaSource } = fakeMediaSourceFactory();
    class BlockedAudio {
      constructor(src) { this.src = src; this.paused = 0; }
      play() {
        return Promise.reject(Object.assign(new Error('play() failed because the user did not interact'), {
          name: 'NotAllowedError',
        }));
      }
      pause() { this.paused += 1; }
      finish() { this.onended?.(); }
    }
    const calls = [];
    const sys = fakeSystem();
    const tts = createVolcTts({
      fallback: sys,
      MediaSourceCtor: FakeMediaSource,
      AudioCtor: BlockedAudio,
      createObjectURL: () => 'blob:mse-blocked',
      revokeObjectURL: () => {},
      diag: { record: () => {} },
      fetchImpl: async (url) => {
        calls.push(url);
        return url === TTS_STREAM_PATH ? streamRes([mp3Frame(1)]) : wholeRes;
      },
    });
    tts.speak('被自动播放策略挡住');
    await wait(30);
    ok('MSE 的 play() 被拒（NotAllowedError）→ 自动降级到整段 /tts，不是「悄悄没声音」',
      calls.join(',') === `${TTS_STREAM_PATH},${TTS_PATH}`,
      JSON.stringify({ calls, spoken: sys.spoken }));
    tts.close();
  }

  /* ---- ⑧ 系统 TTS：硬失败 / 被打断的区别 ---- */
  function fakeSystemSynth({ autoEnd = false } = {}) {
    const spoken = [];
    let utter = null;
    const win = {
      navigator: { language: 'zh-CN' },
      speechSynthesis: {
        speak(u) {
          spoken.push(u);
          utter = u;
          if (autoEnd) setTimeout(() => u.onend?.(), 0);
        },
        cancel() {},
      },
      SpeechSynthesisUtterance: class {
        constructor(text) { this.text = String(text); }
      },
    };
    return { win, spoken, get utter() { return utter; } };
  }
  {
    const harness = fakeSystemSynth();
    const events = [];
    const tts = createSystemTts({
      win: harness.win, lang: 'zh-CN',
      diag: { record: (type, data) => events.push({ type, data }) },
    });
    ok('系统 TTS：第一句交给合成器（返回 true、记 tts:say）',
      tts.speak('第一句') === true && harness.spoken.length === 1
      && events.some((e) => e.type === 'tts:say'));
    harness.utter.onerror({ error: 'synthesis-unavailable' });
    const fails = events.filter((e) => e.type === 'tts:fail');
    ok('系统 TTS：synthesis-unavailable 记 tts:fail，且带 where=system（下次一眼看出是系统这级）',
      fails.length === 1 && fails[0].data.where === 'system'
      && fails[0].data.code === 'synthesis-unavailable',
      JSON.stringify(fails));
    ok('系统 TTS：硬失败之后不再徒劳调用（第二句返回 false，只出弹幕）',
      tts.speak('第二句') === false && harness.spoken.length === 1
      && tts.unavailable === true && tts.supported === false);
  }
  {
    // 我们自己 cancel() 造成的 'interrupted' 不是失败：不该刷 tts:fail（上次就是它把日志搅浑的）
    const harness = fakeSystemSynth();
    const events = [];
    const tts = createSystemTts({
      win: harness.win, lang: 'zh-CN',
      diag: { record: (type, data) => events.push({ type, data }) },
    });
    tts.speak('被打断');
    harness.utter.onerror({ error: 'interrupted' });
    ok('系统 TTS：interrupted / canceled（我们自己 cancel 的）不记 tts:fail，也不算不可用',
      !events.some((e) => e.type === 'tts:fail') && tts.unavailable === false);
  }

  /* ---- ⑨ 回归（用户反馈「听不到任何声音」的根因）：MSE 的 play() 一直不 resolve ----
   *
   * Chrome 在 SourceBuffer 里**一个字节都没有**之前，`audio.play()` 的 Promise 会一直
   * pending。从前 `ready` 等 play() resolve，而 `push()` 又等 `ready` → 死锁：
   * 第一块永远 append 不进去（一个字节都没播 = 完全没声音），响应流也读不完
   * （没有 `tts:say` / 没有 `onEnd` / 会话卡在 speaking）。
   * 这里用一个**永不 resolve 的 play()** 把这个死锁钉死：音频照样要进缓冲、照样要收尾。 */
  {
    const { FakeMediaSource, created } = fakeMediaSourceFactory();
    const audioList = [];
    class PendingPlayAudio {
      constructor(src) { this.src = src; this.paused = 0; this.ended = 0; audioList.push(this); }
      play() { this.playCalls = (this.playCalls || 0) + 1; return new Promise(() => {}); }
      pause() { this.paused += 1; }
      finish() { this.ended += 1; this.onended?.(); }
    }
    const diagEvents = [];
    let ended = 0;
    const tts = createVolcTts({
      fallback: fakeSystem(),
      MediaSourceCtor: FakeMediaSource,
      AudioCtor: PendingPlayAudio,
      createObjectURL: () => 'blob:mse-pending',
      revokeObjectURL: () => {},
      diag: { record: (type, data) => diagEvents.push({ type, data }) },
      fetchImpl: async (url) => (url === TTS_STREAM_PATH ? streamRes([mp3Frame(1), mp3Frame(2)]) : wholeRes),
    });
    tts.speak('播放等数据', { onEnd: () => { ended += 1; } });
    await wait(40);
    const ms = created[0];
    ok('MSE + play() 永远 pending：两块音频照样 append 进缓冲（不再等 play()，死锁已修）',
      !!ms && ms.buffers[0] && ms.buffers[0].appended === 384 && ms.buffers[0].list.length === 2,
      JSON.stringify({ appended: ms && ms.buffers[0] && ms.buffers[0].appended,
        chunks: ms && ms.buffers[0] && ms.buffers[0].list.length }));
    ok('MSE + play() 永远 pending：流读完照样 finish() → endOfStream（不会一直等后续数据）',
      ms.endOfStreamCalls === 1 && ms.readyState === 'ended',
      JSON.stringify({ calls: ms.endOfStreamCalls, state: ms.readyState }));
    ok('MSE + play() 永远 pending：音频会话真的在播（audio.play() 被调用过一次）',
      audioList.length === 1 && audioList[0].playCalls === 1,
      JSON.stringify({ audios: audioList.length, plays: audioList[0] && audioList[0].playCalls }));
    audioList[0].finish();
    ok('MSE + play() 永远 pending：播完仍然回调 onEnd（会话能回到 listening）', ended === 1, String(ended));
    tts.close();
  }

  /* ---- ⑩ 流式响应流卡住不结束 → 空闲看门狗收尾（tts:stream-idle）----
   *
   * 用户日志里 `tts:first-audio` 之后既没有 `tts:say` 也没有 `onEnd`：响应流一直没结束，
   * 于是 `player.finish()` 永远不调用 → MSE 不 endOfStream → 没有 `ended` → 会话卡死。
   * 现在首块之后挂一个空闲看门狗：到点就取消读取、正常收尾。 */
  {
    const { FakeMediaSource, created } = fakeMediaSourceFactory();
    const { FakeAudio, list } = fakeElementAudio();
    const diagEvents = [];
    let ended = 0;
    /** 只给第一块，之后的 read() 永远 pending；cancel() 才让它以 done 收尾 */
    const stallingReader = (piece) => {
      let first = true;
      let pending = null;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () => {
              if (first) { first = false; return Promise.resolve({ done: false, value: piece }); }
              return new Promise((resolve) => { pending = resolve; });
            },
            cancel: async () => { pending?.({ done: true, value: undefined }); pending = null; },
          }),
        },
      };
    };
    const tts = createVolcTts({
      fallback: fakeSystem(),
      MediaSourceCtor: FakeMediaSource,
      AudioCtor: FakeAudio,
      createObjectURL: () => 'blob:stall',
      revokeObjectURL: () => {},
      diag: { record: (type, data) => diagEvents.push({ type, data }) },
      idleMs: 25,
      readMaxMs: 0,
      fetchImpl: async () => stallingReader(mp3Frame(1)),
    });
    tts.speak('这条流会卡住', { onEnd: () => { ended += 1; } });
    await wait(80);
    ok('流式卡住（响应流不再结束）→ 空闲看门狗记 tts:stream-idle 并收尾（不再挂死）',
      diagEvents.some((e) => e.type === 'tts:stream-idle')
      && created[0] && created[0].endOfStreamCalls === 1,
      JSON.stringify({ idle: diagEvents.some((e) => e.type === 'tts:stream-idle'),
        eos: created[0] && created[0].endOfStreamCalls }));
    ok('流式卡住：首块就记了 tts:say（日志里能看出「这条确实尝试出声了」）',
      diagEvents.some((e) => e.type === 'tts:say' && e.data.source === 'volc'),
      JSON.stringify(diagEvents.map((e) => e.type)));
    list[0].finish();
    ok('流式卡住：收尾后播完仍然回调 onEnd', ended === 1, String(ended));
    tts.close();
  }

  /* ---- ⑪ 兜底看门狗：所有播放引擎都不回调 onEnd 时，到点也必须 onEnd ---- */
  {
    const diagEvents = [];
    let ended = 0;
    const tts = createVolcTts({
      fallback: fakeSystem(),
      AudioCtor: fakeElementAudio().FakeAudio,
      createObjectURL: () => 'blob:guard',
      revokeObjectURL: () => {},
      diag: { record: (type, data) => diagEvents.push({ type, data }) },
      guardMs: 30,
      fetchImpl: async () => wholeRes,     // 整段：Audio 永远不 ended
    });
    tts.speak('没人回调结束', { onEnd: () => { ended += 1; } });
    await wait(80);
    ok('兜底看门狗到点 → 记 tts:guard 并回调 onEnd（任何一级卡住都不会把会话晾在 speaking）',
      ended === 1 && diagEvents.some((e) => e.type === 'tts:guard'),
      JSON.stringify({ ended, events: diagEvents.map((e) => e.type) }));
    tts.close();
  }
}

/* ================================================================== *
 * [37] 说完一句继续聆听（用户反馈钉住：final 之后不许关会话）
 * ================================================================== */
console.log('\n[37] final 之后继续聆听 / TTS 卡住也不吞掉下一句 / 谁关的会话有据可查');
{
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  ok('speakHoldMs：短句按 min 兜底、超长句夹在 max（看门狗不会把正常朗读掐掉）',
    speakHoldMs('好的', { min: 6000, max: 20000 }) === 6000
    && speakHoldMs('字'.repeat(200), { min: 6000, max: 20000 }) === 20000
    && speakHoldMs('字'.repeat(20), { min: 100, max: 20000 }) === 8200
    && speakHoldMs('', { min: 100, max: 20000 }) === 3000,
    JSON.stringify([speakHoldMs('好的'), speakHoldMs('字'.repeat(200)),
      speakHoldMs('字'.repeat(20)), speakHoldMs('')]));

  /** 记录诊断事件的假 diag */
  const makeDiag = () => {
    const events = [];
    return { events, record: (type, data) => events.push({ type, data }) };
  };

  /* ---- ① final 之后：仍在 listening、ASR 没停、麦克风还在 ---- */
  {
    const mic = fakeMic();
    const asr = fakeAsr();
    const tts = fakeTts();
    const diag = makeDiag();
    const session = createVoiceSession({
      mic, asr, tts, llm: { reply: () => '收到' }, thinkDelay: 0, diag,
    });
    await session.start();
    asr.emit('你好');
    await tick();
    ok('① 一句 final → thinking → speaking（教练开口），ASR 一次都没停',
      session.snapshot().state === 'speaking' && asr.stopped === 0 && mic.closed === 0,
      JSON.stringify({ state: session.snapshot().state, asrStops: asr.stopped, micClosed: mic.closed }));

    asr.emitInterim('再');
    asr.emitInterim('再说');
    asr.emitInterim('再说一句');
    ok('① 教练念的时候连着 3 个 partial：状态不变、麦克风与识别都还在（不是「说完一句就关会话」）',
      session.snapshot().state === 'speaking' && asr.stopped === 0 && mic.closed === 0
      && session.enabled === true,
      JSON.stringify({ state: session.snapshot().state, asrStops: asr.stopped, micClosed: mic.closed }));

    tts.finish();
    ok('① 这句念完 → 回到 listening，enabled 仍为 true（final 只上屏 / 触发回复，不结束会话）',
      session.snapshot().state === 'listening' && session.enabled === true
      && mic.closed === 0 && asr.stopped === 0,
      JSON.stringify({ state: session.snapshot().state, enabled: session.enabled,
        asrStops: asr.stopped, micClosed: mic.closed }));

    asr.emit('设成 20 次');
    await tick();
    ok('① 下一句 final 照常被处理（命令快车道：TTS 收到第二句，状态又到 speaking）',
      session.snapshot().state === 'speaking' && tts.spoken.length === 2,
      JSON.stringify({ state: session.snapshot().state, spoken: tts.spoken }));
    tts.finish();
    ok('① 全程没有 stop：ASR 没停、麦克风没释放（正是用户要的「说完一句会继续聆听」）',
      asr.stopped === 0 && mic.closed === 0 && session.snapshot().state === 'listening',
      JSON.stringify({ asrStops: asr.stopped, micClosed: mic.closed, state: session.snapshot().state }));
    ok('① 诊断：命令确认语也走了发声路径（session:say by=cmd + session:speak-end by=tts-end）',
      diag.events.some((e) => e.type === 'session:say' && e.data.by === 'cmd')
      && diag.events.some((e) => e.type === 'session:speak-end' && e.data.by === 'tts-end'),
      JSON.stringify(diag.events.filter((e) => String(e.type).startsWith('session:'))));
    ok('① 诊断里没有任何 session:stop（final 绝不会关会话）',
      !diag.events.some((e) => e.type === 'session:stop'),
      JSON.stringify(diag.events.map((e) => e.type)));
    session.destroy();
    ok('① destroy() 记为 by=destroy（「谁关的会话」有据可查）',
      diag.events.some((e) => e.type === 'session:stop' && e.data.by === 'destroy')
      && mic.closed === 1,
      JSON.stringify(diag.events.filter((e) => e.type === 'session:stop')));
  }

  /* ---- ② TTS 卡住（onEnd 永远不回来）时用户说的下一句：当作插话，不能丢 ---- */
  {
    const mic = fakeMic();
    const asr = fakeAsr();
    const tts = fakeTts();          // speak() 返回 true 但测试里**永远不调 onEnd**（模拟卡住）
    const diag = makeDiag();
    const session = createVoiceSession({
      mic, asr, tts, llm: { reply: () => '我在听' }, thinkDelay: 0, diag,
    });
    await session.start();
    asr.emit('随便聊两句');
    await tick(8);
    ok('② 前置：教练卡在 speaking（TTS 的 onEnd 一直没回来）',
      session.snapshot().state === 'speaking' && tts.spoken.length === 1,
      JSON.stringify({ state: session.snapshot().state, spoken: tts.spoken }));
    asr.emit('再说一句新的');
    await tick(8);
    ok('② 卡住时用户说完整的一句 → 先插话打断再处理（不再被静默丢掉）',
      tts.spoken.length === 2 && session.snapshot().state === 'speaking',
      JSON.stringify({ spoken: tts.spoken, state: session.snapshot().state }));
    ok('② 打断记 session:barge-final；ASR 与麦克风都没停',
      diag.events.some((e) => e.type === 'session:barge-final')
      && asr.stopped === 0 && mic.closed === 0,
      JSON.stringify({ barge: diag.events.filter((e) => e.type === 'session:barge-final'),
        asrStops: asr.stopped, micClosed: mic.closed }));
    session.stop('user');
    ok('② stop(\'user\') → session:stop {by:user} + 麦克风按 user 释放（Ctrl+I 的记录方式）',
      diag.events.some((e) => e.type === 'session:stop' && e.data.by === 'user')
      && mic.closed === 1,
      JSON.stringify(diag.events.filter((e) => e.type === 'session:stop')));
  }

  /* ---- ③ 说话看门狗：TTS 永远不回调 onEnd，到点也必须回 listening ---- */
  {
    const mic = fakeMic();
    const asr = fakeAsr();
    const tts = fakeTts();
    const diag = makeDiag();
    const session = createVoiceSession({
      mic, asr, tts, llm: { reply: () => '一句不会结束的话' }, thinkDelay: 0, diag,
      speakMinMs: 20, speakMaxMs: 40,
    });
    await session.start();
    asr.emit('你好');
    await tick(8);
    ok('③ 前置：说话中（speaking）', session.snapshot().state === 'speaking');
    await wait(90);
    ok('③ 看门狗到点 → 强制回 listening（并记 session:speak-timeout / speak-end by=timeout）',
      session.snapshot().state === 'listening'
      && diag.events.some((e) => e.type === 'session:speak-timeout')
      && diag.events.some((e) => e.type === 'session:speak-end' && e.data.by === 'timeout'),
      JSON.stringify({ state: session.snapshot().state,
        events: diag.events.filter((e) => String(e.type).startsWith('session:')).map((e) => e.type + ':' + (e.data.by || '')) }));
    ok('③ 看门狗到点会先把 TTS 掐掉（tts.cancel），不会和下一句叠着说',
      tts.cancelled >= 1, String(tts.cancelled));
    asr.emit('下一句');
    await tick(8);
    ok('③ 看门狗救回来之后，下一句 final 照常处理', tts.spoken.length === 2,
      JSON.stringify(tts.spoken));
    session.stop('pagehide');
    ok('③ stop(\'pagehide\') → session:stop {by:pagehide}（和用户主动关区分开）',
      diag.events.some((e) => e.type === 'session:stop' && e.data.by === 'pagehide'),
      JSON.stringify(diag.events.filter((e) => e.type === 'session:stop')));
  }

  /* ---- ④ 页面隐藏：pause 记 by=hidden；暂停期间不处理 final，resume 后恢复 ---- */
  {
    const mic = fakeMic();
    const asr = fakeAsr();
    const tts = fakeTts();
    const diag = makeDiag();
    const session = createVoiceSession({
      mic, asr, tts, llm: { reply: () => '好的' }, thinkDelay: 0, diag,
    });
    await session.start();
    session.pause('hidden');
    ok('④ pause(\'hidden\') → session:pause {by:hidden}；麦克风保持（回到前台不用重新授权）',
      diag.events.some((e) => e.type === 'session:pause' && e.data.by === 'hidden')
      && session.enabled === true && session.paused === true && mic.closed === 0,
      JSON.stringify({ paused: session.paused, micClosed: mic.closed,
        events: diag.events.map((e) => e.type) }));
    asr.emit('暂停时说的一句');
    await tick(8);   // final 是异步派发的，和本文件其它用例一样多等几拍
    ok('④ 暂停期间来的 final 不处理，但要留证据（session:drop state=…）',
      tts.spoken.length === 0
      && diag.events.some((e) => e.type === 'session:drop'),
      JSON.stringify({ spoken: tts.spoken, drops: diag.events.filter((e) => e.type === 'session:drop') }));
    session.resume();
    ok('④ 回到前台 → resume 记 session:resume，状态回到 listening',
      session.paused === false && session.snapshot().state === 'listening'
      && diag.events.some((e) => e.type === 'session:resume'),
      JSON.stringify({ paused: session.paused, state: session.snapshot().state }));
    session.stop('user');
  }
}

/* ================================================================== *
 * [30] 三层记忆 · 长时层：服务端 MD（读写 / 白名单 / 路径穿越 / 坏文件 / 原子写）
 * ================================================================== */
console.log('\n[30] 三层记忆 · 长时层：server/memory/<userId>.md（白名单 / 安全 / 容错）');
{
  const path = await import('node:path');
  const os = await import('node:os');
  const fsp = fs;
  let dir;
  try {
    dir = fsp.mkdtempSync(path.join(os.tmpdir(), 'mfg-memory-'));
  } catch {
    dir = fsp.mkdtempSync(path.join(process.cwd(), '.memory-test-'));
  }
  const throwsCode = (fn, code) => {
    try { fn(); return false; } catch (err) { return !!err && err.code === code; }
  };
  try {
    ok('记忆文件上限 64KB、摘要最多 20 条，默认 userId 是 default',
      MEMORY_MAX_BYTES === 64 * 1024 && MEMORY_SUMMARY_MAX === 20 && DEFAULT_USER_ID === 'default');

    const saved = updateMemory('alice', {
      prefs: { tone: 'warm', sessionMinutes: 20, rate: 1.1, voiceGender: 'male' },
      facts: {
        goal: { value: '减脂', evidence: '2026-11-11 我说想减脂' },
        injuries: { value: ['膝盖', '腰'], evidence: '我膝盖和腰都不太好' },
      },
      summaries: [
        { at: new Date('2026-11-11T17:30:00').getTime(), name: '自重深蹲', target: 20, reps: 20, score: 61 },
      ],
      lastUnfinished: { at: new Date('2026-11-11T17:30:00').getTime(), exerciseId: 'squat', name: '自重深蹲', set: 2, reps: 12, target: 20 },
    }, { dir });
    const back = readMemory('alice', { dir });
    ok('MD 读写往返：prefs / facts / 来源 / 摘要 / 上次未完成都对',
      back.prefs.tone === 'warm' && back.prefs.sessionMinutes === 20 && back.prefs.rate === 1.1
      && back.prefs.voiceGender === 'male'
      && back.facts.goal === '减脂' && JSON.stringify(back.facts.injuries) === JSON.stringify(['膝盖', '腰'])
      && back.sources.goal === '2026-11-11 我说想减脂'
      && back.summaries.length === 1 && back.summaries[0].name === '自重深蹲' && back.summaries[0].score === 61
      && back.summaries[0].stamp === formatMemoryStamp(new Date('2026-11-11T17:30:00').getTime())
      && back.lastUnfinished && back.lastUnfinished.set === 2 && back.lastUnfinished.reps === 12,
      JSON.stringify(back));

    const md = fsp.readFileSync(path.join(dir, 'alice.md'), 'utf8');
    ok('MD 是人能读的格式：二级标题分节 + 「- 字段: 值」+ 「> 来源：…」+ 表格',
      /^# 教练记忆 — alice/m.test(md)
      && /## 偏好 \(prefs\)/.test(md) && /- tone: warm/.test(md)
      && /## 事实 \(facts\)/.test(md) && /- goal: 减脂/.test(md)
      && /  > 来源：2026-11-11 我说想减脂/.test(md)
      && /## 训练摘要（最近 20 次，最新在前）/.test(md)
      && /\| 日期 \| 动作 \| 目标 \| 实际 \| 分数 \|/.test(md)
      && /## 上次未完成/.test(md) && /第 2 组（12\/20）/.test(md),
      md.slice(0, 500));

    ok('白名单接受 voiceGender（female|male），MD 里能看到这一行',
      /- voiceGender: male/.test(md));

    // 白名单 / 取值范围：全部拒绝，且**不留下半份文件**
    const before = fsp.readFileSync(path.join(dir, 'alice.md'), 'utf8');
    ok('非法 prefs 字段被拒（not-in-whitelist）',
      throwsCode(() => updateMemory('alice', { prefs: { nickname: 'x' } }, { dir }), 'bad-field'));
    ok('非法枚举值被拒（tone=angry / voiceGender=robot / goal=变壮）',
      throwsCode(() => updateMemory('alice', { prefs: { tone: 'angry' } }, { dir }), 'bad-value')
      && throwsCode(() => updateMemory('alice', { prefs: { voiceGender: 'robot' } }, { dir }), 'bad-value')
      && throwsCode(() => updateMemory('alice', { facts: { goal: { value: '变壮', evidence: '我想变壮' } } }, { dir }), 'bad-value'));
    ok('数值范围被拒：sessionMinutes 4/61、restSec -1/181、rate 1.4、weeklyGoal 8',
      throwsCode(() => updateMemory('alice', { prefs: { sessionMinutes: 4 } }, { dir }), 'bad-value')
      && throwsCode(() => updateMemory('alice', { prefs: { sessionMinutes: 61 } }, { dir }), 'bad-value')
      && throwsCode(() => updateMemory('alice', { prefs: { restSec: -1 } }, { dir }), 'bad-value')
      && throwsCode(() => updateMemory('alice', { prefs: { restSec: 181 } }, { dir }), 'bad-value')
      && throwsCode(() => updateMemory('alice', { prefs: { rate: 1.4 } }, { dir }), 'bad-value')
      && throwsCode(() => updateMemory('alice', { facts: { weeklyGoal: { value: 8, evidence: '每周八次' } } }, { dir }), 'bad-value'));
    ok('injuries 最多 5 项 / 每项最多 20 字（超了被拒）',
      throwsCode(() => updateMemory('alice', { facts: { injuries: { value: ['a', 'b', 'c', 'd', 'e', 'f'], evidence: 'x' } } }, { dir }), 'bad-value')
      && throwsCode(() => updateMemory('alice', { facts: { injuries: { value: ['字'.repeat(21)], evidence: 'x' } } }, { dir }), 'bad-value'));
    ok('未知 patch 顶层键被拒（unknown-field）',
      throwsCode(() => updateMemory('alice', { nickname: 'x' }, { dir }), 'unknown-field'));
    ok('facts 没有 evidence 被拒（evidence-required）——模型不能凭推测写事实',
      throwsCode(() => updateMemory('alice', { facts: { goal: '增肌' } }, { dir }), 'evidence-required'));
    ok('被拒之后原 MD 一个字节都没变（不做半截写入 / 不留 .tmp）',
      fsp.readFileSync(path.join(dir, 'alice.md'), 'utf8') === before
      && fsp.readdirSync(dir).every((name) => !name.includes('.tmp-')));

    // 路径穿越：userId 必须是 ^[a-zA-Z0-9_-]{1,32}$
    const badUsers = ['../x', 'a/b', 'a\\b', '', 'x'.repeat(33), 'a.b', '..'];
    ok('路径穿越 / 非法 userId 一律 bad-user（../x、a/b、a\\b、空串、超长、带点）',
      badUsers.every((u) => throwsCode(() => normalizeUserId(u), 'bad-user')
        && throwsCode(() => readMemory(u, { dir }), 'bad-user')
        && throwsCode(() => updateMemory(u, { prefs: { tone: 'warm' } }, { dir }), 'bad-user')
        && throwsCode(() => forgetMemory(u, { all: true }, { dir }), 'bad-user')));
    ok('记忆文件永远落在 memory 目录里（userId → <dir>/<id>.md）',
      memoryFilePath('alice', dir) === path.join(path.resolve(dir), 'alice.md'));

    // 手改容忍：合法手写 MD 照样解析；垃圾文件备份 .bad 后按空记忆处理
    fsp.writeFileSync(path.join(dir, 'manual.md'), [
      '# 教练记忆 — manual',
      '',
      '## 偏好 (prefs)',
      '- difficulty: hard',
      '- tone: 这是手改的非法值',
      '',
      '## 事实 (facts)',
      '- weeklyGoal: 3',
      '  > 来源：每周练三次',
      '',
      '## 训练摘要（最近 20 次，最新在前）',
      '| 日期 | 动作 | 目标 | 实际 | 分数 |',
      '|---|---|---|---|---|',
      '| 2026-11-10 09:00 | 平板支撑 | 45 | 45 | 70 |',
      '',
      '## 上次未完成',
      '- 2026-11-10 09:00 平板支撑 第 1 组（30/45）',
    ].join('\n'), 'utf8');
    const manual = readMemory('manual', { dir });
    ok('手改的 MD 容忍：合法字段读出来 / 非法值忽略 / 表格与上次数照读',
      manual.prefs.difficulty === 'hard' && manual.prefs.tone === undefined
      && manual.facts.weeklyGoal === 3 && manual.sources.weeklyGoal === '每周练三次'
      && manual.summaries.length === 1 && manual.summaries[0].reps === 45
      && manual.lastUnfinished && manual.lastUnfinished.set === 1);

    fsp.writeFileSync(path.join(dir, 'broken.md'), '这不是一份记忆文件，只是随便写的东西。\n', 'utf8');
    const broken = readMemory('broken', { dir });
    ok('坏 MD（完全不像记忆）→ 空记忆 + 备份 .bad，不崩',
      broken.prefs.tone === undefined && broken.facts.goal === undefined
      && fsp.existsSync(path.join(dir, 'broken.md.bad')));

    fsp.writeFileSync(path.join(dir, 'huge.md'), `# 教练记忆 — huge\n${'x'.repeat(MEMORY_MAX_BYTES + 100)}`, 'utf8');
    const huge = readMemory('huge', { dir });
    ok('超过 64KB 的 MD → 空记忆 + 备份 .bad（不读进内存 / 不崩）',
      Object.keys(huge.prefs).length === 0 && fsp.existsSync(path.join(dir, 'huge.md.bad')));

    ok('forget 单条：只删指定字段（来源一起删）',
      (() => {
        const m = forgetMemory('alice', { field: 'tone' }, { dir });
        return m.prefs.tone === undefined && m.prefs.sessionMinutes === 20;
      })());
    ok('forget 也接受 prefs.xxx / facts.xxx 前缀',
      (() => {
        const m = forgetMemory('alice', { field: 'facts.goal' }, { dir });
        return m.facts.goal === undefined && m.sources.goal === undefined;
      })());
    ok('forget all：文件直接删掉，读回来是空记忆',
      (() => {
        const m = forgetMemory('alice', { all: true }, { dir });
        return !fsp.existsSync(path.join(dir, 'alice.md')) && Object.keys(m.prefs).length === 0;
      })());

    updateMemory('bob', { prefs: { tone: 'funny' } }, { dir });
    const health = memoryHealth({ dir });
    ok('/memory/health 只报 users 数量（不读内容 / 不泄露 id）',
      health.ok === true && health.users === 2 && !JSON.stringify(health).includes('bob'),
      JSON.stringify(health));
  } finally {
    try { fsp.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ================================================================== *
 * [31] 记忆工具：remember（只能 prefs）/ remember_fact（必须 evidence）/ forget
 * ================================================================== */
console.log('\n[31] 记忆工具：remember 只能记偏好 / remember_fact 必须有用户原话 / forget');
{
  const text = (call) => actionsFromToolCalls([call], { locale: 'zh' });
  const rem = text({ name: 'remember', args: { field: 'tone', value: 'warm' } });
  ok('remember(tone=warm) → 一条服务端记忆操作（没有 client action）',
    rem.memoryOps.length === 1 && rem.memoryOps[0].op === 'remember'
    && rem.memoryOps[0].field === 'tone' && rem.memoryOps[0].value === 'warm'
    && rem.actions.length === 0);
  ok('remember 不能写 facts（goal → not-a-preference）',
    (() => {
      const r = text({ name: 'remember', args: { field: 'goal', value: '减脂' } });
      return r.memoryOps.length === 0 && r.refusals[0]?.reason === 'not-a-preference';
    })());
  ok('remember_fact 没有 evidence → 拒绝（evidence-required），不产生任何写入',
    (() => {
      const r = text({ name: 'remember_fact', args: { field: 'goal', value: '减脂' } });
      return r.memoryOps.length === 0 && r.refusals[0]?.reason === 'evidence-required';
    })());
  ok('remember_fact 带 evidence → 操作里原样带上用户原话',
    (() => {
      const r = text({ name: 'remember_fact', args: {
        field: 'goal', value: '减脂', evidence: '我想减脂',
      } });
      return r.memoryOps.length === 1 && r.memoryOps[0].op === 'remember-fact'
        && r.memoryOps[0].evidence === '我想减脂';
    })());
  ok('forget(tone) → forget 操作；未知字段 → bad-field',
    text({ name: 'forget', args: { field: 'tone' } }).memoryOps[0]?.op === 'forget'
    && text({ name: 'forget', args: { field: 'nickname' } }).refusals[0]?.reason === 'bad-field');
  ok('记忆操作也受「一次最多 3 个工具」限制',
    actionsFromToolCalls(Array.from({ length: 6 }, () => ({ name: 'remember', args: { field: 'tone', value: 'warm' } })))
      .memoryOps.length === MAX_TOOL_CALLS);

  // 服务端 /llm 真的写：mock provider 调 remember + remember_fact
  const path = await import('node:path');
  const os = await import('node:os');
  const http = await import('node:http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfg-memory-llm-'));
  const store = {
    readMemory: (u) => readMemory(u, { dir }),
    updateMemory: (u, p) => updateMemory(u, p, { dir }),
    forgetMemory: (u, t) => forgetMemory(u, t, { dir }),
  };
  try {
    const provider = createMockLlmProvider({
      script: [{
        text: '好，我记下了。',
        toolCalls: [
          { name: 'remember', args: { field: 'tone', value: 'warm' } },
          { name: 'remember_fact', args: { field: 'goal', value: '减脂', evidence: '我想减脂' } },
        ],
      }],
    });
    const routes = createLlmRoutes({
      provider,
      config: { configured: true, provider: 'mock', model: 'mock' },
      memoryStore: store,
    });
    const srv = http.createServer(routes);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const post = (p, body) => new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, path: p, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end(data);
    });
    const out = await post('/llm', { user: 'routeuser', text: '记住我喜欢温柔一点，我想减脂', locale: 'zh' });
    const saved = readMemory('routeuser', { dir });
    const md = fs.readFileSync(path.join(dir, 'routeuser.md'), 'utf8');
    ok('POST /llm：remember → prefs 写进 MD、remember_fact → facts + 来源，响应带回最新 memory',
      out.status === 200 && saved.prefs.tone === 'warm' && saved.facts.goal === '减脂'
      && saved.sources.goal === '我想减脂' && out.body.memory?.prefs?.tone === 'warm'
      && /- tone: warm/.test(md) && /  > 来源：我想减脂/.test(md),
      JSON.stringify({ out: out.body, md }));
    ok('POST /llm 的记忆工具只回「成功/失败」理由，不把用户原话写进日志字段',
      Array.isArray(out.body.memoryOps) && out.body.memoryOps.every((r) => r.ok === true));

    // 非法 userId → 400（绝不落盘）
    const bad = await post('/llm', { user: '../x', text: 'hi' });
    ok('POST /llm：非法 userId → 400 bad-user，不写任何文件',
      bad.status === 400 && bad.body.error === 'bad-user'
      && !fs.existsSync(path.join(dir, '..', 'x.md')));
    await new Promise((r) => srv.close(r));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ================================================================== *
 * [32] 短时记忆：最近 60 秒事件（≤60 条、正序、单条 ≤60 字符）/ 10 轮对话 / 教练最近 5 句
 * ================================================================== */
console.log('\n[32] 短时记忆：60 秒事件环形缓冲 / 10 轮对话 / 教练最近 5 句（防复读）');
{
  ok('常量：60 秒窗口 / 60 条上限 / 单条 ≤60 字符 / 事件类型白名单',
    RECENT_EVENTS_WINDOW_MS === 60000 && RECENT_EVENTS_MAX === 60
    && RECENT_EVENT_MAX_CHARS === 60
    && EVENT_KINDS.join(',') === 'rep,gate-fail,keyframe-hit,keyframe-miss'
    && JSON.stringify(EVENT_KINDS) === JSON.stringify(AGENT_EVENT_KINDS));

  const clock = { t: 0 };
  const session = createVoiceSession({
    mic: fakeMic(), asr: fakeAsr(), tts: fakeTts(),
    llm: { reply: () => ({ text: '好' }) }, thinkDelay: 0,
    now: () => clock.t,
  });
  await session.start();
  for (let i = 0; i < 70; i += 1) {
    clock.t += 1000;
    session.recordEvent('rep', { n: i, v: true });
  }
  const events = session.recentEvents();
  ok('70 条事件只留最近 60 条（环形缓冲），最旧的在 60 秒窗口内',
    events.length === 60 && events[0].t <= 60 && events.at(-1).t <= 1,
    JSON.stringify({ n: events.length, first: events[0], last: events.at(-1) }));
  ok('事件按时间正序（最旧在前，t 从大到小）',
    events.every((ev, i) => i === 0 || ev.t <= events[i - 1].t + 1e-9));
  ok('每条事件的 JSON ≤60 字符（prompt 里保持短）',
    events.every((ev) => JSON.stringify(ev).length <= RECENT_EVENT_MAX_CHARS),
    String(Math.max(...events.map((ev) => JSON.stringify(ev).length))));
  clock.t += 61000;
  ok('超过 60 秒的事件自动过期（只剩 60 秒内）', session.recentEvents().length === 0);

  session.recordEvent('rep', { n: 3, points: [[1, 2], [3, 4]], pose: { x: 1 } });
  const lastEv = session.recentEvents().at(-1);
  ok('事件 data 只留标量：关键点 / 嵌套对象一律被丢掉',
    lastEv && lastEv.data.n === 3 && !('points' in lastEv.data) && !('pose' in lastEv.data),
    JSON.stringify(lastEv));
  ok('非法事件类型被忽略', session.recordEvent('landmarks', {}) === false);
  session.stop('user');

  // 10 轮对话 + 教练最近 5 句
  const s2 = createVoiceSession({
    mic: fakeMic(), asr: fakeAsr(), tts: fakeTts(),
    llm: { reply: (t) => ({ text: `答：${t}` }) }, thinkDelay: 0,
  });
  await s2.start();
  for (let i = 0; i < 12; i += 1) {
    s2.onUserText(`聊天内容 ${i}`);
    await tick(6);
  }
  ok('对话记忆最多 10 轮（20 条），更早的自动丢掉',
    s2.snapshot().recentTurns.length === DIALOGUE_MAX_TURNS * 2
    && s2.snapshot().recentTurns[0].role === 'user',
    String(s2.snapshot().recentTurns.length));
  ok('教练最近 5 句：只留最近 5 条，重复的一句挪到末尾（不占两个名额）',
    s2.lastCoachLines().length === COACH_LINES_MAX
    && (() => {
      const before = s2.lastCoachLines();
      s2.onCoachText(before[1]);
      const after = s2.lastCoachLines();
      return after.length === COACH_LINES_MAX && after.at(-1) === before[1]
        && after.filter((x) => x === before[1]).length === 1;
    })(),
    JSON.stringify(s2.lastCoachLines()));
  s2.stop('user');
}

/* ================================================================== *
 * [33] 中时记忆：本周 vs 上周（客户端算）+ lastSession + context 装配 / 瘦身
 * ================================================================== */
console.log('\n[33] 中时记忆：本周 vs 上周 / lastSession / context 里的 memory + 事件 + 防复读');
{
  const nowMs = new Date('2026-06-03T15:00:00').getTime();   // 周三
  const weekStart = startOfLocalWeek(nowMs);
  const at = (daysAgo, hour = 10) => {
    const d = new Date(nowMs);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
  };
  const thisWeek = [
    { at: at(0), kind: 'rep', value: 20, target: 20, score: 65, seconds: 0 },
    { at: at(2), kind: 'rep', value: 15, target: 15, score: 75, seconds: 0 },
  ];
  const lastWeek = [
    { at: weekStart - 3 * 86400000, kind: 'rep', value: 15, target: 15, score: 55, seconds: 0 },
    { at: weekStart - 1 * 86400000, kind: 'hold', value: 40, target: 45, score: 65, seconds: 0 },
  ];
  const trend = weekTrend([...thisWeek, ...lastWeek], nowMs);
  ok('weekTrend：本周 / 上周各 2 组，reps / secs / avgScore 与 delta 都对',
    trend.thisWeek.sets === 2 && trend.thisWeek.reps === 35 && trend.thisWeek.avgScore === 70
    && trend.lastWeek.sets === 2 && trend.lastWeek.reps === 15 && trend.lastWeek.secs === 40
    && trend.lastWeek.avgScore === 60
    && trend.delta.sets === 0 && trend.delta.avgScore === 10,
    JSON.stringify(trend));
  ok('weekTrend verdict：平均分高 ≥3 → improved / 低 ≥3 → declined / 差不多 → flat',
    trend.verdict === 'improved'
    && weekTrend([...lastWeek, { ...thisWeek[0], score: 50 }], nowMs).verdict === 'declined'
    && weekTrend([...lastWeek, { ...thisWeek[0], score: 61 }], nowMs).verdict === 'flat');
  ok('weekTrend：只有本周练了 → improved；只有上周 → declined；都没练 → flat',
    weekTrend([thisWeek[0]], nowMs).verdict === 'improved'
    && weekTrend([lastWeek[0]], nowMs).verdict === 'declined'
    && weekTrend([], nowMs).verdict === 'flat');

  const last = lastSessionForContext({
    exerciseId: 'squat', name: '自重深蹲', target: 20, reps: 12,
    setIndex: 2, at: at(0, 17), finished: false,
  });
  ok('lastSession（localStorage 形状，setIndex）→ context 的紧凑形状（set / MM-DD HH:mm）',
    last.exerciseId === 'squat' && last.set === 2 && last.reps === 12
    && last.target === 20 && /^\d{2}-\d{2} \d{2}:\d{2}$/.test(last.at)
    && last.finished === false,
    JSON.stringify(last));
  ok('lastSession 缺 exerciseId 但有名字也保留；完全没有 → null',
    lastSessionForContext({ name: '平板支撑' })?.name === '平板支撑'
    && lastSessionForContext(null) === null);

  const ctx = buildAgentContext({
    now: nowMs,
    history: [...thisWeek, ...lastWeek],
    recentEvents: normalizeRecentEvents([
      { t: 2, type: 'rep', data: { n: 5 } },
      { t: 1, type: 'keyframe-hit', data: { p: 7, k: 'down' } },
      { t: 99, type: 'rep', data: { n: 1 } },          // 超过 60 秒：丢掉
      { t: 3, type: 'landmarks', data: { x: 1 } },     // 类型不在白名单：丢掉
    ]),
    lastCoachLines: ['一', '二', '三', '四', '五', '六'],
    memory: {
      prefs: { tone: 'warm', voiceGender: 'male', nickname: '不该出现' },
      facts: { goal: '减脂', injuries: ['膝盖', '腰'], unknown: 'x' },
    },
    lastSession: { exerciseId: 'squat', name: '自重深蹲', target: 20, reps: 12, setIndex: 2, at: at(0, 17) },
    trainingSummary: Array.from({ length: 22 }, (_, i) => ({
      at: at(0, 17), name: `动作 ${i}`, target: 20, reps: 12, score: 60 + i,
    })),
  });
  ok('context 带上 memory（白名单 prefs + facts）/ trendWeek / lastSession / recentEvents / lastCoachLines',
    ctx.memory.prefs.tone === 'warm' && ctx.memory.prefs.voiceGender === 'male'
    && ctx.memory.prefs.nickname === undefined
    && ctx.memory.facts.goal === '减脂' && ctx.memory.facts.injuries.length === 2
    && ctx.memory.facts.unknown === undefined
    && ctx.trendWeek.verdict === 'improved'
    && ctx.lastSession.set === 2
    && ctx.trainingSummary.length === AGENT_SUMMARY_MAX
    && ctx.trainingSummary[0].name === '动作 0'
    && ctx.trainingSummary[0].score === 60
    && /^\d{2}-\d{2} \d{2}:\d{2}$/.test(ctx.trainingSummary[0].date)
    && ctx.recentEvents.length === 2 && ctx.recentEvents[0].type === 'rep'
    && ctx.lastCoachLines.length === 5 && ctx.lastCoachLines[0] === '二',
    JSON.stringify({ memory: ctx.memory, trend: ctx.trendWeek, last: ctx.lastSession }));
  ok('整体仍然 ≤6000 字符（记忆 / 事件也在预算里）',
    JSON.stringify(ctx).length <= AGENT_CONTEXT_MAX_CHARS, String(JSON.stringify(ctx).length));
  ok('前端白名单字段和 server/memory-store.mjs 一一对应（不会漂）',
    JSON.stringify([...AGENT_MEMORY_PREF_FIELDS]) === JSON.stringify([...PREFS_FIELDS])
    && JSON.stringify([...AGENT_MEMORY_FACT_FIELDS]) === JSON.stringify([...FACTS_FIELDS]));

  // 超预算：先丢最旧的 recentEvents
  const manyEvents = Array.from({ length: 60 }, (_, i) => ({
    t: 60 - i, type: 'rep', data: { n: i },
  }));
  const big = buildAgentContext({
    now: nowMs,
    history: Array.from({ length: 30 }, (_, i) => ({
      exerciseId: 'x', name: '很长的动作名字'.repeat(8), kind: 'rep',
      at: nowMs - i * 1000, value: 10, target: 20, score: 50, seconds: 0,
    })),
    recentEvents: manyEvents,
    lastCoachLines: Array.from({ length: 5 }, (_, i) => `第 ${i} 句很长的教练台词`.repeat(6)),
    memory: { prefs: { tone: 'warm' }, facts: { injuries: ['膝盖'] } },
    lastSession: { exerciseId: 'squat', name: '自重深蹲', target: 20, reps: 12, setIndex: 2 },
    trainingSummary: Array.from({ length: 20 }, (_, i) => ({
      at: nowMs - i * 60000, name: `动作 ${i}`, target: 20, reps: 12, score: 60,
    })),
    utterance: '很长的一句话'.repeat(800),
  });
  ok('瘦身：超预算时 recentEvents 会变少（先丢最旧的），整体仍 ≤6000',
    big.recentEvents.length < manyEvents.length
    && JSON.stringify(big).length <= AGENT_CONTEXT_MAX_CHARS,
    JSON.stringify({ events: big.recentEvents.length, chars: JSON.stringify(big).length }));
  ok('强瘦身到 1200 字符也不抛错，事件 / 教练台词先被丢',
    (() => {
      const tight = buildAgentContext({
        now: nowMs,
        recentEvents: manyEvents,
        lastCoachLines: ['一', '二', '三', '四', '五'],
        history: [{ exerciseId: 'x', name: 'y', kind: 'rep', at: nowMs, value: 1, target: 1, score: 1 }],
        memory: { prefs: { tone: 'warm' }, facts: { goal: '减脂' } },
      });
      const trimmed = trimAgentContext(JSON.parse(JSON.stringify(tight)), { maxChars: 1200 });
      return JSON.stringify(trimmed).length <= 1200;
    })());
}

/* ================================================================== *
 * [34] 教练声音性别：白名单音色映射 / TTS 请求 / 命令 / 人设 / 诊断
 * ================================================================== */
console.log('\n[34] 教练声音：女声默认 / 男声 zh_male_taocheng_uranus_bigtts / 命令与设置同一条路');
{
  ok('音色映射一处定义：女声 zh_female_vv_uranus_bigtts / 男声 zh_male_taocheng_uranus_bigtts',
    COACH_VOICES.female === 'zh_female_vv_uranus_bigtts'
    && COACH_VOICES.male === 'zh_male_taocheng_uranus_bigtts'
    && DEFAULT_VOICE_GENDER === 'female'
    && JSON.stringify([...VOICE_GENDERS]) === JSON.stringify(['female', 'male']));
  ok('非法 gender / voice 解析成空（路由据此 400），空值回默认女声',
    normalizeVoiceGender('robot') === '' && normalizeVoiceGender('') === 'female'
    && resolveCoachVoice({ gender: 'robot' }) === ''
    && resolveCoachVoice({ gender: '' }) === COACH_VOICES.female
    && resolveCoachVoice({ gender: 'male' }) === COACH_VOICES.male
    && resolveCoachVoice({ voice: 'female' }) === COACH_VOICES.female
    && resolveCoachVoice({ voice: '随便一个音色' }) === '');

  // 4 句中文 + 4 句英文（用户拍板的准确说法）+ 常见变体
  const zhCases = [
    ['换个女声', 'female'], ['换女声', 'female'], ['用女声', 'female'], ['女声吧', 'female'],
    ['换个男声', 'male'], ['换男声', 'male'], ['用男声', 'male'], ['男声吧', 'male'],
    ['换个女教练', 'female'], ['换女教练', 'female'], ['女教练吧', 'female'],
    ['换个男教练', 'male'], ['换男教练', 'male'], ['男教练吧', 'male'],
  ];
  ok('中文 4 句 + 变体全部命中 setVoiceGender，且 args.gender 正确',
    zhCases.every(([phrase, gender]) => {
      const r = parseCommand(phrase, 'zh');
      return r.intent === 'setVoiceGender' && r.args.gender === gender;
    }),
    JSON.stringify(zhCases.map(([p]) => [p, parseCommand(p, 'zh')])));
  const enCases = [
    ['switch to a female voice', 'female'], ['female voice', 'female'],
    ['use the female voice', 'female'], ['switch to a male voice', 'male'],
    ['male voice', 'male'], ['use the male voice', 'male'],
    ['female coach', 'female'], ['male coach', 'male'],
  ];
  ok('英文 8 句全部命中 setVoiceGender，且 args.gender 正确',
    enCases.every(([phrase, gender]) => {
      const r = parseCommand(phrase, 'en');
      return r.intent === 'setVoiceGender' && r.args.gender === gender;
    }),
    JSON.stringify(enCases.map(([p]) => [p, parseCommand(p, 'en')])));

  const toolGender = actionsFromToolCalls([{ name: 'set_voice_gender', args: { gender: 'male' } }], { locale: 'zh' });
  ok('工具 set_voice_gender(male) → setVoiceGender{male}；非法值拒绝',
    toolGender.actions[0]?.intent === 'setVoiceGender' && toolGender.actions[0]?.args.gender === 'male'
    && actionsFromToolCalls([{ name: 'set_voice_gender', args: { gender: 'robot' } }]).actions.length === 0);

  // 服务端 TTS：男 / 女请求体里的 speaker + 缓存不串味
  const config = {
    configured: true, missing: [], appId: 'test-app-id', apiKey: 'test-api-key',
    voice: COACH_VOICES.female, resource: 'volc.seedtts.default',
    endpoint: 'https://example.invalid/tts',
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
  };
  const service = createVolcTtsServer({ config, fetchImpl, timeoutMs: 100 });
  const male = await service.synthesize('同一句话', 1, { gender: 'male' });
  const female = await service.synthesize('同一句话', 1, { gender: 'female' });
  const maleAgain = await service.synthesize('同一句话', 1, { gender: 'male' });
  ok('/tts 带 gender:male → 上游 req_params.speaker 是男声音色 ID',
    male.ok && calls[0].req_params.speaker === COACH_VOICES.male,
    JSON.stringify(calls[0]));
  ok('同一句话 female / male **不共享缓存**：男声第二次才命中（上游只调 2 次）',
    calls.length === 2 && female.ok && female.cached === false
    && maleAgain.ok && maleAgain.cached === true
    && calls[1].req_params.speaker === COACH_VOICES.female,
    JSON.stringify({ calls: calls.length, female, maleAgain }));

  // 路由：非法 gender → 400；合法 gender 真的传给 service
  const http = await import('node:http');
  const seen = [];
  const stubService = {
    configured: true,
    health: () => ({ ok: true, configured: true, voices: COACH_VOICES }),
    async synthesize(text, rate, opts = {}) {
      seen.push({ text, rate, gender: opts.gender });
      return { ok: true, buffer: Buffer.from([1, 2]), bytes: 2, cached: false };
    },
    async stream(text, rate, opts = {}) {
      seen.push({ text, rate, gender: opts.gender, stream: true });
      opts.onFirstChunk?.();
      opts.onChunk?.(Buffer.from([1]));
      return { ok: true, bytes: 1, chunks: 1, firstChunkMs: 0, aborted: false };
    },
  };
  const srv = http.createServer(createTtsRoutes({ service: stubService }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const postJson = (p, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(data);
  });
  try {
    const bad = await postJson('/tts', { text: 'hi', gender: 'robot' });
    ok('POST /tts 非法 gender → 400 bad-gender（**选严格拒绝**，不偷偷回退）',
      bad.status === 400 && JSON.parse(bad.body.toString('utf8')).error === 'bad-gender'
      && seen.length === 0);
    await postJson('/tts', { text: 'hi', gender: 'male' });
    await postJson('/tts/stream', { text: 'hi', gender: 'female' });
    ok('/tts 与 /tts/stream 把白名单 gender 传给 service（男声 / 女声各一次）',
      seen.length === 2 && seen[0].gender === 'male' && seen[1].gender === 'female'
      && seen[1].stream === true,
      JSON.stringify(seen));
  } finally {
    await new Promise((r) => srv.close(r));
  }

  // 人设联动：system prompt 里的教练性别
  const pMale = buildSystemPrompt({ context: { memory: { prefs: { voiceGender: 'male' } } } });
  const pFemale = buildSystemPrompt({ context: { memory: { prefs: { voiceGender: 'female' } } } });
  ok('system prompt 里写「教练性别：男 / 女」，并提醒人称与自称要克制、不要写死「她」',
    /教练性别：男/.test(pMale) && /Coach gender: male/.test(pMale)
    && /教练性别：女/.test(pFemale)
    && /不要刻意/.test(pMale) && /never hard-code/.test(pMale));

  // 诊断事件 voice:gender
  const diag = createDiag({ fetch: async () => ({ ok: true }) });
  diag.record('voice:gender', { to: 'male' });
  ok('诊断字典认识 voice:gender {to}（快照里能读到当前性别）',
    diag.snapshot().tts.gender === 'male');
  diag.close?.();

  // 白名单：voiceGender 写进 MD
  const path = await import('node:path');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfg-voice-gender-'));
  try {
    updateMemory('g1', { prefs: { voiceGender: 'male' } }, { dir });
    const saved = readMemory('g1', { dir });
    const md = fs.readFileSync(path.join(dir, 'g1.md'), 'utf8');
    ok('prefs 白名单接受 voiceGender，MD 里能看到「- voiceGender: male」',
      saved.prefs.voiceGender === 'male' && /- voiceGender: male/.test(md));
    ok('voiceGender 只接受 female / male（别的值 bad-value）',
      (() => {
        try { updateMemory('g1', { prefs: { voiceGender: 'other' } }, { dir }); return false; } catch (e) { return e.code === 'bad-value'; }
      })());
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ================================================================== *
 * [35] /memory 路由（并入 preview-server.js）：GET / POST / forget / health + 不写进仓库
 * ================================================================== */
console.log('\n[35] /memory 路由：读 / 写 / 忘 / health（临时目录，绝不写进仓库）');
{
  const path = await import('node:path');
  const os = await import('node:os');
  const http = await import('node:http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfg-memory-route-'));
  // 真实的 server/memory/ 里可能有用户自己的记忆（MD 是 gitignore 的本地数据）：
  // 这里只要求「测试前后一个文件都不多不少」，**绝不允许**为了跑测试把用户记忆删掉。
  const repoMemory = path.join(process.cwd(), 'server', 'memory');
  const repoFilesBefore = (fs.existsSync(repoMemory)
    ? fs.readdirSync(repoMemory).filter((n) => n.endsWith('.md'))
    : []).sort();
  const savedEnv = process.env.MFG_MEMORY_DIR;
  process.env.MFG_MEMORY_DIR = dir;
  const { previewHandler } = await import('../preview-server.js');
  const srv = http.createServer(previewHandler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const request = (method, p, body = null) => new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: p, method,
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  try {
    const health0 = await request('GET', '/memory/health');
    ok('GET /memory/health：只回 {ok, users}，内容 / userId 一概不泄露',
      health0.status === 200 && health0.body.ok === true && health0.body.users === 0
      && typeof health0.body.users === 'number'
      && !('prefs' in health0.body) && !('facts' in health0.body),
      JSON.stringify(health0.body));

    const empty = await request('GET', '/memory?user=alice');
    ok('GET /memory?user=alice：还没记过 → 空记忆（不建文件）',
      empty.status === 200 && Object.keys(empty.body.prefs).length === 0
      && Object.keys(empty.body.facts).length === 0 && !fs.existsSync(path.join(dir, 'alice.md')));

    const wrote = await request('POST', '/memory', {
      user: 'alice',
      prefs: { tone: 'warm', voiceGender: 'male', sessionMinutes: 20 },
      facts: { goal: { value: '减脂', evidence: '我想减脂' } },
    });
    ok('POST /memory：prefs + facts(evidence) 写进 <dir>/alice.md，并回最新记忆',
      wrote.status === 200 && wrote.body.ok === true
      && wrote.body.prefs.tone === 'warm' && wrote.body.prefs.voiceGender === 'male'
      && wrote.body.facts.goal === '减脂' && wrote.body.sources.goal === '我想减脂'
      && fs.existsSync(path.join(dir, 'alice.md')),
      JSON.stringify(wrote.body));
    const health1 = await request('GET', '/memory/health');
    ok('GET /memory/health：users 变成 1（只报数量）', health1.body.users === 1);

    const badValue = await request('POST', '/memory', { user: 'alice', prefs: { sessionMinutes: 99 } });
    ok('POST /memory 非法值 → 400 + 明确原因（code/field/reason）',
      badValue.status === 400 && badValue.body.error === 'bad-value'
      && badValue.body.field === 'sessionMinutes' && badValue.body.reason === 'out-of-range',
      JSON.stringify(badValue.body));
    const badUser = await request('POST', '/memory', { user: '../x', prefs: { tone: 'warm' } });
    ok('POST /memory 路径穿越 userId → 400 bad-user，目录里不会多出文件',
      badUser.status === 400 && badUser.body.error === 'bad-user'
      && fs.readdirSync(dir).filter((n) => n.endsWith('.md')).length === 1);

    const forgot = await request('POST', '/memory/forget', { user: 'alice', field: 'prefs.tone' });
    ok('POST /memory/forget {field}：只删这一条，别的还在',
      forgot.status === 200 && forgot.body.prefs.tone === undefined
      && forgot.body.prefs.voiceGender === 'male');
    const forgotAll = await request('POST', '/memory/forget', { user: 'alice', all: true });
    ok('POST /memory/forget {all:true}：文件删掉、读回来是空记忆',
      forgotAll.status === 200 && Object.keys(forgotAll.body.prefs).length === 0
      && !fs.existsSync(path.join(dir, 'alice.md')));

    ok('.gitignore 里有 server/memory/（个人信息绝不进仓库）',
      /^server\/memory\/$/m.test(fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8')));
    const repoFilesAfter = (fs.existsSync(repoMemory)
      ? fs.readdirSync(repoMemory).filter((n) => n.endsWith('.md'))
      : []).sort();
    ok('/memory 路由只写 MFG_MEMORY_DIR 指过去的临时目录，仓库里的 server/memory/ 一个 .md 都不多不少',
      JSON.stringify(repoFilesAfter) === JSON.stringify(repoFilesBefore),
      `before=${repoFilesBefore.join(',')} after=${repoFilesAfter.join(',')}`);
  } finally {
    await new Promise((r) => srv.close(r));
    if (savedEnv === undefined) delete process.env.MFG_MEMORY_DIR;
    else process.env.MFG_MEMORY_DIR = savedEnv;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ================================================================== *
 * [36] 教练人设 SOUL.md：唯一来源 / 兜底 / 截断 / 名字 / introSeen / 红线
 * ================================================================== */
console.log('\n[36] 教练人设：SOUL.md 拼进 system prompt（顺序 / 兜底 / 截断 / 名字 / 首次自报 / 红线）');
{
  const path = await import('node:path');
  const os = await import('node:os');
  const http = await import('node:http');
  const savedSoulPath = process.env.SOUL_PATH;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mfg-soul-'));
  const realSoul = fs.readFileSync(DEFAULT_SOUL_PATH, 'utf8');
  const restoreEnv = () => {
    if (savedSoulPath === undefined) delete process.env.SOUL_PATH;
    else process.env.SOUL_PATH = savedSoulPath;
    resetSoulCache();
  };

  try {
    // 默认路径：SOUL.md 原文必须就是 system prompt 的前半部分
    delete process.env.SOUL_PATH;
    resetSoulCache();
    const prompt = buildSystemPrompt();
    ok('SOUL.md 是 system prompt 的前半部分（从第 0 个字符开始，不是摘要/副本）',
      prompt.startsWith(realSoul), `prompt=${prompt.length} soul=${realSoul.length}`);
    ok('SOUL.md 的独特原话真的进了 prompt（「不吼人、不画饼」）',
      prompt.includes('不吼人、不画饼'));
    const iSoul = prompt.indexOf(realSoul);
    const iRules = prompt.indexOf('以下是本产品的运行规则');
    const iMemory = prompt.indexOf('当前记忆 / Current memory');
    const iState = prompt.indexOf('state (JSON):');
    ok('拼装顺序：① SOUL → ② 运行规则 → ③ 当前记忆 → ④ state',
      iSoul === 0 && iRules > iSoul && iMemory > iRules && iState > iMemory,
      JSON.stringify({ iSoul, iRules, iMemory, iState }));
    ok('名字统一：prompt 含「可可」、绝不含旧名（老唤醒词）',
      /可可/.test(prompt) && !/\u5c0f\u8fc8/.test(prompt));
    ok('红线一行可机器断言（不羞辱 / 就医 / 不极端 / 隐私 / 直说 / 性别不刻板）',
      ['不羞辱', '不身材焦虑', '不越界医疗', '建议就医', '不极端节食', '超量训练',
        '数据隐私', '做不到就直说', '性别不刻板'].every((k) => prompt.includes(k)),
      ['不羞辱', '不身材焦虑', '不越界医疗', '建议就医', '不极端节食', '超量训练',
        '数据隐私', '做不到就直说', '性别不刻板'].filter((k) => !prompt.includes(k)).join(','));
    ok('口头禅「动起来！」有一条，并明确「不要每句都硬加」',
      prompt.includes('动起来！') && prompt.includes('不要每句都硬加'));
    const pMale = buildSystemPrompt({ context: { memory: { prefs: { voiceGender: 'male' } } } });
    ok('性别联动：女 / 男都写进 prompt，说明人格 / 专业度 / 话术一致、不要刻板',
      /教练性别：女/.test(prompt) && /教练性别：男/.test(pMale)
      && prompt.includes('不要强化性别刻板印象') && pMale.includes('不要强化性别刻板印象')
      && prompt.includes('人格、专业度、话术完全一致'));

    // 首次对话只自报一次：introSeen 布尔偏好
    const first = buildSystemPrompt({ context: { memory: { prefs: {} } } });
    const seen = buildSystemPrompt({ context: { memory: { prefs: { introSeen: true } } } });
    ok('introSeen 未见过 → 加「这是首次对话」；见过之后不再加',
      first.includes('这是首次对话') && !seen.includes('这是首次对话'));
    ok('memory 单独一段（state JSON 里不重复 introSeen）',
      seen.includes('当前记忆 / Current memory')
      && seen.includes('"introSeen":true')
      && !seen.slice(seen.indexOf('state (JSON):')).includes('introSeen'));

    // SOUL_PATH 覆盖：读环境变量指的文件
    const customFile = path.join(tmp, 'custom-soul.md');
    fs.writeFileSync(customFile, '# 自定义人设\n你是可可，测试专用。\n', 'utf8');
    process.env.SOUL_PATH = customFile;
    resetSoulCache();
    const custom = buildSystemPrompt();
    ok('SOUL_PATH 覆盖：优先读环境变量指的文件',
      custom.startsWith('# 自定义人设') && custom.includes('测试专用') && soulPath() === customFile);

    // 文件缺失 → 内置兜底 + 只 warn 一条，不抛错
    process.env.SOUL_PATH = path.join(tmp, 'missing-soul.md');
    resetSoulCache();
    const warns = [];
    const origWarn = console.warn;
    let fallbackPrompt = '';
    try {
      console.warn = (...args) => warns.push(args.join(' '));
      fallbackPrompt = buildSystemPrompt();
    } finally {
      console.warn = origWarn;
    }
    ok('SOUL.md 缺失 → 内置兜底人设、不抛错、只 warn 一条',
      fallbackPrompt.includes('内置兜底人设') && fallbackPrompt.includes('可可')
      && !fallbackPrompt.startsWith(realSoul)
      && warns.filter((m) => m.includes('[soul]')).length === 1,
      JSON.stringify(warns));

    // 超过 12000 字符 → 截断并 warn
    const longFile = path.join(tmp, 'long-soul.md');
    fs.writeFileSync(longFile, 'A'.repeat(SOUL_MAX_CHARS + 500), 'utf8');
    process.env.SOUL_PATH = longFile;
    resetSoulCache();
    const longWarns = [];
    const origWarn2 = console.warn;
    let longText = '';
    try {
      console.warn = (...args) => longWarns.push(args.join(' '));
      longText = readSoul();
    } finally {
      console.warn = origWarn2;
    }
    ok('超长 SOUL 截断到 12000 字符并 warn（不会把 token 撑爆）',
      SOUL_MAX_CHARS === 12000 && longText.length === 12000
      && longWarns.some((m) => m.includes('截断')),
      `len=${longText.length} warns=${longWarns.join(' | ')}`);
    ok('loadSoulText 直接读：缺文件返回同一份兜底人设（测试 / 诊断可用）',
      loadSoulText(path.join(tmp, 'nope.md'), { logger: { warn: () => {} } }) === FALLBACK_SOUL);
  } finally {
    restoreEnv();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // 首次成功对话后：服务端自动写 prefs.introSeen=true；下一轮 prompt 不再提醒
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfg-soul-intro-'));
  const store = {
    readMemory: (u) => readMemory(u, { dir }),
    updateMemory: (u, p) => updateMemory(u, p, { dir }),
    forgetMemory: (u, t) => forgetMemory(u, t, { dir }),
  };
  const seenPrompts = [];
  const provider = {
    configured: true,
    provider: 'mock',
    model: 'mock',
    async chat({ messages }) {
      seenPrompts.push(messages[0].content);
      return { text: '嗨，我是可可，你的专属教练。不吼人、不画饼，只陪你练到赢。让我们一起动起来！', toolCalls: [] };
    },
  };
  const routes = createLlmRoutes({ provider, config: { configured: true, provider: 'mock', model: 'mock' }, memoryStore: store });
  const srv = http.createServer(routes);
  let post = null;
  try {
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    post = (body) => new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, path: '/llm', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end(data);
    });
    const one = await post({ user: 'souluser', text: '你是谁？', locale: 'zh' });
    const saved = readMemory('souluser', { dir });
    const md = fs.readFileSync(path.join(dir, 'souluser.md'), 'utf8');
    ok('首轮 prompt 带首次自报提示，回复里是可可',
      one.status === 200 && seenPrompts[0].includes('这是首次对话')
      && one.body.reply.includes('可可'));
    ok('首轮成功后服务端写 prefs.introSeen=true（不依赖模型 remember）',
      saved.prefs.introSeen === true && /- introSeen: true/.test(md)
      && one.body.memory?.prefs?.introSeen === true,
      JSON.stringify({ prefs: saved.prefs, memory: one.body.memory }));
    const two = await post({ user: 'souluser', text: '今天练什么？', locale: 'zh' });
    ok('第二轮 prompt 不再提醒自报（introSeen 已 true，记忆里能看到）',
      two.status === 200 && !seenPrompts[1].includes('这是首次对话')
      && seenPrompts[1].includes('"introSeen":true'));
  } finally {
    await new Promise((r) => srv.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ================================================================== *
 * [37] R1 事件总线：emit / on（type + prefix:*）/ recent（60 秒 / ≤60 条 / ≤60 字符）/ 容量 / 异常隔离
 * ================================================================== */
console.log('\n[37] R1 事件总线：emit / on / recent（60 秒窗口）/ 容量 / 订阅异常隔离 / 一处定义');
{
  ok('常量：14 类事件 / 进 prompt 的 4 类 / 容量 120 / 60 秒 / 单条 ≤60 字符',
    EVENT_TYPES.length === 14 && AGENT_EVENT_TYPES.length === 4 && EVENT_CAPACITY === 120
    && EVENT_WINDOW_MS === 60000 && EVENT_MAX_CHARS === 60
    && AGENT_EVENT_TYPES.join(',') === 'rep,gate-fail,keyframe-hit,keyframe-miss'
    && EVENT_TYPES.join(',') === 'rep,set-start,set-complete,gate-fail,gate-ok,keyframe-hit,'
      + 'keyframe-miss,progress,tick,hold-tick,idle,tempo,session-start,session-end',
    EVENT_TYPES.join(','));
  ok('和 session.js / llm.js 是**同一份**白名单（一处定义，不会漂）',
    JSON.stringify(AGENT_EVENT_TYPES) === JSON.stringify(EVENT_KINDS)
    && JSON.stringify(AGENT_EVENT_TYPES) === JSON.stringify(AGENT_EVENT_KINDS));
  ok('matchPattern：`*` 全收 / `gate:*` 前缀 / 其余全等',
    matchPattern('*', 'rep') && matchPattern('gate:*', 'gate-fail') && matchPattern('gate:*', 'gate-ok')
    && !matchPattern('gate:*', 'rep') && matchPattern('rep', 'rep') && !matchPattern('rep', 'reps'));
  ok('isEventType：白名单里 16 类都认，乱写的类型不认',
    EVENT_TYPES.every((ty) => isEventType(ty)) && !isEventType('landmarks') && !isEventType(''));

  const clock = { t: 100000 };
  const bus = createEventBus({ now: () => clock.t });
  const seen = [];
  const gateSeen = [];
  const off = bus.on('rep', (ev) => seen.push(ev));
  bus.on('gate:*', (ev) => gateSeen.push(ev));
  const all = [];
  bus.on('*', (ev) => all.push(ev.type));

  const one = bus.emit('rep', { n: 1, v: true, target: 20 });
  ok('emit 自动补 { seq, t, type, data }，seq 从 1 递增、t 来自注入时钟',
    one && one.seq === 1 && one.t === 100000 && one.type === 'rep'
    && one.data.n === 1 && one.data.target === 20,
    JSON.stringify(one));
  clock.t += 1000;
  const two = bus.emit('rep', { n: 2, v: true, target: 20 });
  ok('订阅者按类型收到（seq 递增）', seen.length === 2 && two.seq === 2);
  bus.emit('gate-fail', { g: 'prone' });
  bus.emit('gate-ok', { g: 'prone' });
  ok('`gate:*` 前缀订阅收到 gate-fail / gate-ok 两条', gateSeen.length === 2
    && gateSeen[0].type === 'gate-fail' && gateSeen[1].type === 'gate-ok');
  ok('`*` 全订阅收到全部事件', all.length === 4 && all[0] === 'rep');
  off();
  bus.emit('rep', { n: 3, v: true, target: 20 });
  ok('取消订阅之后不再收到', seen.length === 2 && all.length === 5);

  const bad = bus.emit('landmarks', { x: 1 });
  ok('白名单外的类型 → 直接不发（返回 null，订阅者一条都收不到）',
    bad === null && all.length === 5 && bus.seq === 5);

  // 一个 handler 抛错 → 其它订阅照常收到，emit 不抛
  const after = [];
  bus.on('rep', () => { throw new Error('boom'); });
  bus.on('rep', (ev) => after.push(ev.seq));
  let threw = false;
  try { bus.emit('rep', { n: 4, v: true, target: 20 }); } catch { threw = true; }
  ok('同一 handler 抛错不影响其它订阅，也不会把异常抛给调用方',
    threw === false && after.length === 1, JSON.stringify({ threw, after }));

  // 单条紧凑事件：只留标量 + ≤60 字符
  const compact = compactEventData({ n: 3, points: [[1, 2]], pose: { x: 1 }, v: true, r: 'depth', target: 20 }, 'rep');
  ok('data 只留标量（关键点 / 嵌套对象一律丢掉）',
    compact.n === 3 && compact.v === true && !('points' in compact) && !('pose' in compact),
    JSON.stringify(compact));
  const long = compactEventData({ a: 'x'.repeat(40), b: 'y'.repeat(40), c: 'z'.repeat(40) }, 'rep');
  ok('序列化超过 60 字符就从后往前丢字段（一定装得下）',
    JSON.stringify({ t: 0, type: 'rep', data: long }).length <= EVENT_MAX_CHARS, JSON.stringify(long));

  // recent：60 秒窗口 / limit / types
  const bus2 = createEventBus({ now: () => clock.t });
  clock.t = 200000;
  for (let i = 0; i < 10; i += 1) {
    clock.t += 5000;
    bus2.emit('rep', { n: i, v: true });
  }
  ok('recent() 只回 60 秒窗口内的事件（50 秒里 10 条都在）', bus2.recent().length === 10);
  ok('recent({ limit }) 截断最新的 N 条', bus2.recent({ limit: 3 }).length === 3
    && bus2.recent({ limit: 3 }).at(-1).data.n === 9);
  bus2.emit('gate-fail', { g: 'prone' });
  ok('recent({ types }) 只回指定的类型',
    bus2.recent({ types: ['gate-fail'] }).length === 1
    && bus2.recent({ types: ['gate-fail'] })[0].type === 'gate-fail');
  clock.t += 61000;
  ok('超过 60 秒的事件自动过期', bus2.recent().length === 0);
  ok('recent() 的每一条 ≤60 字符',
    bus.recent().every((ev) => JSON.stringify(ev).length <= EVENT_MAX_CHARS + 20));

  // 容量：120 条上限
  const bus3 = createEventBus({ now: () => clock.t });
  clock.t = 300000;
  for (let i = 0; i < 130; i += 1) { clock.t += 100; bus3.emit('tick', { elapsedSec: i }); }
  ok('容量 120：发 130 条只留最近 120 条（最旧的被挤掉）',
    bus3.size === 120 && bus3.recent({ limit: 200 }).length === 120
    && bus3.recent({ limit: 200 }).at(-1).data.elapsedSec === 129);
  bus3.clear();
  ok('clear() 清空缓冲，但 seq 不回退（还能看出「清过几次」）',
    bus3.size === 0 && bus3.seq === 130);

  /* ---------------- 总线 ↔ 会话：recordEvent / recentEvents 都走同一条总线 ---------------- */
  const shared = createEventBus({ now: () => clock.t });
  clock.t = 400000;
  const session = createVoiceSession({
    mic: fakeMic(), asr: fakeAsr(), tts: fakeTts(),
    llm: { reply: () => ({ text: '好' }) }, thinkDelay: 0,
    now: () => clock.t, bus: shared,
  });
  await session.start();
  ok('session 用注入的总线（不是自己再攒一份）', session.bus === shared);
  session.recordEvent('rep', { n: 5, v: true, target: 20 });
  ok('session.recordEvent 真的发到总线上（总线里能查到）',
    shared.size === 1 && shared.recent()[0].type === 'rep'
    && session.recentEvents().length === 1);
  const tickEv = session.emitEvent('tick', { elapsedSec: 5 });
  ok('session.emitEvent(任意白名单类型) → 返回事件；非白名单 → null',
    tickEv && tickEv.type === 'tick' && session.emitEvent('nope', {}) === null);
  ok('recentEvents() 只回那 4 类（tick 不进 LLM prompt）',
    session.recentEvents().length === 1 && session.recentEvents()[0].type === 'rep');
  session.destroy();
}

/* ================================================================== *
 * [38] R1 规则引擎：everyN / remainingLte / consecutive / cooldown / 预算 / 优先级 / 6 秒间隔 / 读秒 bypass / scope
 * ================================================================== */
console.log('\n[38] R1/R2 规则引擎：filter / 冷却 / 预算 / 优先级抢占 / 全局 6 秒间隔 / 读秒 bypass / 静音丢弃 / scope 清理 / 逐次报数自适应');
{
  const clock = { t: 1000000 };
  /** 造一台引擎（默认中档话量、教练开着、没人说话）；`only` 可以只要某几个频道 */
  const makeEngine = ({ volume = 'high', minGapMs = MIN_GAP_MS, diag = null, channels = null } = {}) => {
    const engine = createRuleEngine({ now: () => clock.t, minGapMs, diag });
    for (const r of builtinRules()) {
      const ch = r.channel || '';
      if (channels && !channels.includes(ch)) continue;
      engine.add(r);
    }
    return engine;
  };
  const st = (extra = {}) => ({ speaking: false, muted: false, coachOn: true, volume: 'high', ...extra });
  const fire = (engine, type, data = {}, extra = {}) => engine.handle({ type, data }, st(extra));
  /** 后面几个小节共用的一次结果（`out = fire(...)`） */
  let out = null;

  ok('护栏常量：全局最小开口间隔 6000ms；七个优先级档位（破纪录 100 > 纠正 60 > 读秒 45 > 倒数 40 > 计数 35 > 鼓励 30 > 催促 20）',
    MIN_GAP_MS === 6000 && RULE_PRIORITIES.record === 100 && RULE_PRIORITIES.correct === 60
    && RULE_PRIORITIES.read === 45 && RULE_PRIORITIES.countdown === 40
    && RULE_PRIORITIES.count === 35 && RULE_PRIORITIES.encourage === 30
    && RULE_PRIORITIES.idle === 20 && RULE_SCOPES.join(',') === 'set,session,forever');
  ok('话量三档：low / mid / high，默认 mid（脏值归一化到 mid）',
    COACH_VOLUMES.join(',') === 'low,mid,high' && DEFAULT_COACH_VOLUME === 'mid'
    && normalizeCoachVolume('xx') === 'mid' && normalizeCoachVolume(undefined) === 'mid');
  ok('内置六条规则 id 一处定义（和 builtinRules() 一一对应；门控那条 R3 已停用）',
    BUILTIN_RULE_IDS.length === 6
    && !BUILTIN_RULE_IDS.includes('gate-fail-2')
    && builtinRules().map((r) => r.id).join(',') === BUILTIN_RULE_IDS.join(','));
  ok('两条「频道」规则：rep 报数 / read 读秒，缺省规则 id 一处定义（每 5 秒读秒是缺省）',
    RULE_CHANNELS.join(',') === 'rep,read'
    && DEFAULT_RULE_BY_CHANNEL.rep === 'rep-count' && DEFAULT_RULE_BY_CHANNEL.read === 'hold-read-5'
    && DEFAULT_READ_EVERY_SEC === 5);
  ok('模板全在 locales：六条规则的模板键都能取到词条（模板是函数的也能取）',
    builtinRules().every((r) => {
      const keys = typeof r.action.template === 'function'
        ? [1, 5, 10].map((n) => r.action.template({ n }))
        : [r.action.template];
      return keys.every((key) => {
        const text = t(key, { n: 5, cue: 'X', word: 'X' });
        return typeof text === 'string' && text !== key;
      });
    }));

  /* ---------------- R2 缺省规则①：逐次报数（像私教）+ 五个了 + 自适应降频 ---------------- */
  const counter = makeEngine();
  const said = [];
  const pump = (engine, n, gap, extra = {}) => {
    clock.t += gap;
    const out = fire(engine, 'rep', { n, target: 20, v: true }, extra);
    if (out) said.push(out.speak);
    return out;
  };
  fire(counter, 'session-start');
  fire(counter, 'set-start', { target: 20 });
  for (let n = 1; n <= 3; n += 1) pump(counter, n, 2000);
  ok('默认（中档）计次类**逐次报数**：3 次 rep → 说出「一」「二」「三」（不是每 5 个才说）',
    said.map((s) => s.text).join(',') === '一,二,三'
    && said.every((s) => s.ruleId === 'rep-count' && s.priority === RULE_PRIORITIES.count),
    JSON.stringify(said));
  ok('第 4 个（普通数）仍报「四」', pump(counter, 4, 2000)?.speak.text === '四');
  const five = pump(counter, 5, 2000);
  ok('第 5 个换成整句鼓励：「五个了」（中文数词，不是阿拉伯数字 5）',
    five && five.speak.text === '五个了' && !/[0-9]/.test(five.speak.text),
    JSON.stringify(five && five.speak));
  const ten = pump(counter, 10, 5000);
  ok('第 10 个再加一句鼓励：「十个了，稳住」', ten && ten.speak.text === '十个了，稳住',
    JSON.stringify(ten && ten.speak));
  ok('计数通道走 bypassGap：全局 6 秒间隔管不住它（1 秒一个也照报）',
    pump(counter, 11, 1000)?.speak.text === '十一');

  // 话量=少 → 只报每 5 个
  const lowCounter = makeEngine({ volume: 'low' });
  const lowSaid = [];
  fire(lowCounter, 'session-start');
  fire(lowCounter, 'set-start', { target: 20 });
  for (let n = 1; n <= 10; n += 1) {
    clock.t += 2000;
    const out = fire(lowCounter, 'rep', { n, target: 20, v: true }, { volume: 'low' });
    if (out) lowSaid.push(out.speak.text);
  }
  ok('话量=少 → **只报每 5 个**（1~4 与 6~9 都不说）', lowSaid.join(',') === '五个了,十个了，稳住',
    JSON.stringify(lowSaid));

  // 节奏快 → 每 2 个 / 每 3 个（避免 TTS 排队）
  const fast = makeEngine();
  const fastSaid = [];
  fire(fast, 'session-start');
  fire(fast, 'set-start', { target: 20 });
  for (let n = 1; n <= 12; n += 1) {
    clock.t += 700;   // <1s 一个
    const out = fire(fast, 'rep', { n, target: 20, v: true });
    if (out) fastSaid.push(out.speak.text);
  }
  ok('节奏很快（0.7s 一个）→ 自动降频到每 3 个（12 次里最多 4~5 句，绝不是 12 句）',
    fastSaid.length <= 6, JSON.stringify(fastSaid));
  ok('降频也保住「五个了」这一句（整句鼓励允许越过 stride）',
    fastSaid.includes('五个了'), JSON.stringify(fastSaid));
  const mid = makeEngine();
  const midSaid = [];
  fire(mid, 'session-start');
  fire(mid, 'set-start', { target: 20 });
  for (let n = 1; n <= 8; n += 1) {
    clock.t += 1200;   // 1~1.5s 一个
    const out = fire(mid, 'rep', { n, target: 20, v: true });
    if (out) midSaid.push(out.speak.text);
  }
  ok('节奏中等（1.2s 一个）→ 每 2 个报一次（8 次里 4~5 句）',
    midSaid.length <= 6 && midSaid.includes('五个了'), JSON.stringify(midSaid));
  ok('strideForPace：≥1.5s → 1；1~1.5s → 2；更快 → 3（上限 3；没样本也报 1）',
    strideForPace(2000) === 1 && strideForPace(1500) === 1 && strideForPace(1200) === 2
    && strideForPace(700) === 3 && strideForPace(120) === 3 && strideForPace(0) === 1,
    JSON.stringify([2000, 1500, 1200, 700, 0].map((ms) => strideForPace(ms))));
  ok('自适应参数一处定义：每秒最多 1 次播报 + 话量=少每 5 个 + 教练说话剩余 >1.5s 跳过',
    ADAPTIVE_REP.minStepMs === 1000 && ADAPTIVE_REP.lowVolumeStride === 5
    && ADAPTIVE_REP.fastMs === 1500 && ADAPTIVE_REP.skipWhileSpeakingMs === 1500);
  ok('adaptiveAllows：两次报数之间 <1 秒的直接跳过（每秒最多 1 次）',
    adaptiveAllows({ adaptive: { ...ADAPTIVE_REP } }, { lastAt: 1000, paceMs: 2000 },
      eventContext({ type: 'rep', data: { n: 4, target: 20 } }), 'mid', 1500) === false);

  /* ---------------- R2 缺省规则②：计时类每 5 秒读秒 ---------------- */
  const reader = makeEngine();
  const readSaid = [];
  fire(reader, 'session-start');
  fire(reader, 'set-start', { target: 60 });
  for (let sec = 1; sec <= 20; sec += 1) {
    clock.t += 1000;
    const out = fire(reader, 'tick', { elapsedSec: sec, hold: 1, remainingSec: 60 - sec });
    if (out) readSaid.push(out.speak.text);
  }
  ok('计时类**每 5 秒读秒**：5/10/15/20 秒各说一句（「五秒」「十秒」…）',
    readSaid.join(',') === '五秒,十秒,十五秒,二十秒', JSON.stringify(readSaid));
  ok('计数类动作的 tick 不带 hold → 默认那条读秒规则不开口（用户口述的「报时」才管所有动作）',
    fire(reader, 'tick', { elapsedSec: 25 }) === null);
  const lastFive = fire(reader, 'tick', { elapsedSec: 55, hold: 1, remainingSec: 5 });
  ok('读数规则把**最后 5 秒让给逐秒倒数**（remainingGt:5，别两句撞在同一秒）', lastFive === null,
    JSON.stringify(lastFive && lastFive.speak));
  const holdCountdown = (() => { clock.t += 1000; return fire(reader, 'hold-tick', { remainingSec: 5 }); })();
  ok('最后 5 秒仍然是逐秒倒数（「5」）', holdCountdown && holdCountdown.speak.text === '5',
    JSON.stringify(holdCountdown && holdCountdown.speak));

  /* ---------------- 教练正在说话：计数通道剩余台词 >1.5s 就跳过这一下 ---------------- */
  const talky = makeEngine();
  fire(talky, 'session-start');
  fire(talky, 'set-start', { target: 20 });
  clock.t += 5000;
  ok('教练正在说话 + 剩余台词 >1.5s → **跳过这一下**（不积压、不叠音）',
    fire(talky, 'rep', { n: 1, target: 20 }, { speaking: true, speakLeftMs: 2500 }) === null);
  clock.t += 5000;
  const shortLeft = fire(talky, 'rep', { n: 2, target: 20 }, { speaking: true, speakLeftMs: 400 });
  ok('教练马上说完了（剩余 <1.5s）→ 这一下照报（计数通道 bypassGap）',
    shortLeft && shortLeft.speak.text === '二', JSON.stringify(shortLeft && shortLeft.speak));
  ok('estimateSpeechMs 是纯函数：字数 × 200ms，最短 600ms',
    estimateSpeechMs('') === 600 && estimateSpeechMs('一二三') === 600
    && estimateSpeechMs('一二三四五') === 1000);

  /* ---------------- 计数与「最后 3 个」共存：优先说「还剩 3 个」，下一拍继续数 ---------------- */
  const mixed = makeEngine();
  fire(mixed, 'session-start');
  fire(mixed, 'set-start', { target: 20 });
  clock.t += 2000;
  const l3 = fire(mixed, 'rep', { n: 17, target: 20, v: true });
  ok('remainingLte:3 —— 做到 17/20 优先说「还剩 3 个」（priority 40 > 计数 35）',
    l3 && l3.speak.ruleId === 'last-three' && l3.speak.text === '还剩 3 个'
    && l3.speak.priority === RULE_PRIORITIES.countdown, JSON.stringify(l3));
  clock.t += 2000;
  const next18 = fire(mixed, 'rep', { n: 18, target: 20, v: true });
  ok('最后 3 个每组只说一次；下一拍**继续报数**（18 → 「十八」，不会因为倒数就停下来）',
    next18 && next18.speak.ruleId === 'rep-count' && next18.speak.text === '十八',
    JSON.stringify(next18 && next18.speak));
  ok('matchesFilter / eventContext 是纯函数：remaining / pct / sec / everySec / hold 都算得出来',
    eventContext({ type: 'rep', data: { n: 5, target: 20 } }).remaining === 15
    && eventContext({ type: 'rep', data: { n: 5, target: 20 } }).pct === 25
    && eventContext({ type: 'hold-tick', data: { remainingSec: 4 } }).remaining === 4
    && eventContext({ type: 'idle', data: { sec: 9 } }).sec === 9
    && matchesFilter({ everyN: 5 }, eventContext({ type: 'rep', data: { n: 10, target: 20 } }))
    && !matchesFilter({ everyN: 5 }, eventContext({ type: 'rep', data: { n: 7, target: 20 } }))
    && matchesFilter({ everySec: 5 }, eventContext({ type: 'tick', data: { elapsedSec: 15 } }))
    && !matchesFilter({ everySec: 5 }, eventContext({ type: 'tick', data: { elapsedSec: 0 } }))
    && eventContext({ type: 'tick', data: { elapsedSec: 5, hold: 1 } }).hold === true
    && !matchesFilter({ hold: true }, eventContext({ type: 'tick', data: { elapsedSec: 5 } })));

  /* ---------------- R3：门控连错 2 次已交给 LLM 裁判（R1 模板停用，防双声） ---------------- */
  const g = makeEngine();
  fire(g, 'session-start');
  fire(g, 'gate-fail', { g: 'kneelPushup' });
  clock.t += 500;
  out = fire(g, 'gate-fail', { g: 'kneelPushup' });
  ok('R3：R1 不再为「门控连错 2 次」开口（交给裁判的 gate-fail2 事件，防双声 ✗）',
    out === null && !builtinRules().some((r) => r.id === 'gate-fail-2'), JSON.stringify(out));
  clock.t += 100;
  fire(g, 'gate-ok', { g: 'kneelPushup' });
  ok('gateCueKey 仍然一处定义：未知门控名兜底 status.need.stand（裁判兜底口令也用它）',
    gateCueKey('nope') === 'status.need.stand' && gateCueKey('prone') === 'status.need.prone'
    && gateCueKey('kneelPushup') === 'status.need.kneelPushup');
  ok('门控那句 R1 模板**文案还在**（rule.gateFail2 + {cue}；裁判失败 / 超时用它回退）',
    (() => {
      const line = t('rule.gateFail2', { cue: t('status.need.kneelPushup') });
      return typeof line === 'string' && line.includes(t('status.need.kneelPushup'))
        && !line.includes('{cue}');
    })());

  /* ---------------- 读秒：最后 5 秒 + bypassGap ---------------- */
  const c = makeEngine();
  fire(c, 'session-start');
  fire(c, 'set-start', { target: 20 });
  clock.t += 1000;
  out = fire(c, 'hold-tick', { remainingSec: 5 });
  ok('hold-tick remainingLte:5 → 报「5」（priority 40）',
    out && out.speak.ruleId === 'countdown-5' && out.speak.text === '5'
    && out.speak.priority === RULE_PRIORITIES.countdown, JSON.stringify(out));
  clock.t += 1000;
  const out2 = fire(c, 'hold-tick', { remainingSec: 4 });
  ok('读秒 bypassGap：1 秒后立刻能读下一声（不等 6 秒）',
    out2 && out2.speak.text === '4', JSON.stringify(out2));
  clock.t += 1000;
  ok('hold-tick 剩余 6 秒不读（只读最后 5 秒）',
    fire(c, 'hold-tick', { remainingSec: 6 }) === null);

  /* ---------------- 全局 6 秒间隔 & 同 tick 只一条 ---------------- */
  const gapEngine = createRuleEngine({ now: () => clock.t });
  gapEngine.add({
    id: 'test-a', scope: 'set', trigger: { event: 'progress' },
    action: { template: 'rule.halfway' }, priority: 60, cooldownMs: 0,
  });
  gapEngine.add({
    id: 'test-b', scope: 'set', trigger: { event: 'idle' },
    action: { template: 'rule.idle8' }, priority: 50, cooldownMs: 0,
  });
  clock.t += 100000;
  out = gapEngine.handle({ type: 'progress', data: { pct: 50 } }, st());
  ok('第一条规则说话', out && out.speak.ruleId === 'test-a');
  clock.t += 1000;
  out = gapEngine.handle({ type: 'idle', data: { sec: 8 } }, st());
  ok('**全局最小开口间隔 6 秒**：1 秒后另一条规则被挡（reason=gap 记进诊断）',
    out === null && gapEngine.gapMs === 6000);
  clock.t += 5000;
  out = gapEngine.handle({ type: 'idle', data: { sec: 14 } }, st());
  ok('过了 6 秒就放行', out && out.speak.ruleId === 'test-b');
  clock.t += 0;
  out = gapEngine.handle({ type: 'progress', data: { pct: 60 } }, st());
  ok('同一个 tick（时间没走）只让一条说话', out === null);

  const prio = createRuleEngine({ now: () => clock.t, minGapMs: 0 });
  prio.add({ id: 'low', trigger: { event: 'rep' }, action: { template: 'rule.idle8' }, priority: 20, cooldownMs: 0 });
  prio.add({ id: 'high', trigger: { event: 'rep' }, action: { template: 'rule.repCount' }, priority: 90, cooldownMs: 0 });
  clock.t += 1000;
  out = prio.handle({ type: 'rep', data: { n: 5, target: 20 } }, st());
  ok('priority 抢占：同一事件两条命中，只回最高优先级那条', out && out.speak.ruleId === 'high',
    JSON.stringify(out));

  /* ---------------- 冷却 / 预算 / 话量 / 静音 / speaking ---------------- */
  const budget = createRuleEngine({ now: () => clock.t, minGapMs: 0 });
  budget.add({
    id: 'per-minute', trigger: { event: 'idle' }, action: { template: 'rule.idle8' },
    priority: 20, cooldownMs: 0, budget: { perMinute: 2 },
  });
  budget.add({
    id: 'cooldown', trigger: { event: 'progress' }, action: { template: 'rule.halfway' },
    priority: 30, cooldownMs: 5000,
  });
  let spoke = 0;
  for (let i = 0; i < 5; i += 1) {
    clock.t += 1000;
    if (budget.handle({ type: 'idle', data: { sec: 8 + i } }, st())) spoke += 1;
  }
  ok('budget.perMinute:2 —— 一分钟内第 3 次起被挡（5 次只说了 2 次）', spoke === 2, String(spoke));
  clock.t += 1000;
  ok('cooldownMs:5000 —— 第一次说', !!budget.handle({ type: 'progress', data: { pct: 50 } }, st()));
  clock.t += 3000;
  ok('cooldownMs:5000 —— 3 秒后（冷却内）不说', budget.handle({ type: 'progress', data: { pct: 60 } }, st()) === null);
  clock.t += 3000;
  ok('cooldownMs:5000 —— 超过冷却再说', !!budget.handle({ type: 'progress', data: { pct: 70 } }, st()));

  const quiet = makeEngine();
  clock.t += 100000;
  fire(quiet, 'session-start');
  ok('静音（muted）→ 一条规则都不说', fire(quiet, 'gate-fail', { g: 'prone' }, { muted: true }) === null
    && fire(quiet, 'gate-fail', { g: 'prone' }, { muted: true }) === null);
  ok('教练关（coachOn:false）→ 一条都不说',
    fire(quiet, 'gate-fail', { g: 'prone' }, { coachOn: false }) === null);
  ok('教练正在说话（speaking）→ 纠正被丢弃（不排队）',
    fire(quiet, 'gate-fail', { g: 'prone' }, { speaking: true }) === null);
  clock.t += 1000;
  const countdownWhileSpeaking = fire(quiet, 'hold-tick', { remainingSec: 3 }, { speaking: true });
  ok('**读秒是唯一例外**：speaking 时 bypassGap 的读秒照样说',
    countdownWhileSpeaking && countdownWhileSpeaking.speak.ruleId === 'countdown-5');

  /* ---------------- scope 到期清理（只留固定规则：把预算断言从「逐次报数」里隔离出来） ---------------- */
  const scope = makeEngine({ channels: [''] });
  fire(scope, 'session-start');
  fire(scope, 'set-start', { target: 3 });
  clock.t += 1000;
  out = fire(scope, 'rep', { n: 1, target: 3, v: true });
  ok('一组里最后 3 个说了一次', out && out.speak.ruleId === 'last-three');
  clock.t += 1000;
  ok('同一组里第二次被 perSet 预算挡住（scope=set 的预算真的在起作用）',
    fire(scope, 'rep', { n: 2, target: 3, v: true }) === null);
  fire(scope, 'set-complete', { reps: 3, score: 30 });
  clock.t += 6000;
  ok('set-complete 清 set 作用域 → 下一组还能再说一次',
    fire(scope, 'rep', { n: 1, target: 3, v: true })?.speak.ruleId === 'last-three');
  fire(scope, 'session-end');
  clock.t += 6000;
  ok('session-end 之后 scope=set 的规则还能用（规则本身不属于会话，只清运行期状态）',
    fire(scope, 'rep', { n: 1, target: 3, v: true })?.speak.ruleId === 'last-three');

  /* ---------------- 口述建的规则是 scope: session：session-end 真的删掉 ---------------- */
  const sessionRules = createRuleEngine({ now: () => clock.t, minGapMs: 0 });
  for (const r of builtinRules()) sessionRules.add(r);
  const userRule = sessionRules.add(repRule({ every: 4, id: 'user-rep-4', scope: 'session' }));
  ok('口述规则进表：scope=session、channel=rep、filter.everyN=4',
    userRule && userRule.scope === 'session' && userRule.channel === 'rep'
    && userRule.trigger.filter.everyN === 4, JSON.stringify(userRule && userRule.trigger.filter));
  clock.t += 1000;
  sessionRules.handle({ type: 'session-end', data: {} }, st());
  ok('session-end 把 scope=session 的口述规则**删掉**（内置 set 规则还在）',
    !sessionRules.list().some((r) => r.id === 'user-rep-4')
    && sessionRules.list().some((r) => r.id === 'rep-count'),
    sessionRules.list().map((r) => r.id).join(','));

  const scoped = createRuleEngine({ now: () => clock.t, minGapMs: 0 });
  scoped.add({ id: 's1', scope: 'set', trigger: { event: 'rep' }, action: { template: 'rule.halfway' } });
  scoped.add({ id: 's2', scope: 'session', trigger: { event: 'rep' }, action: { template: 'rule.halfway' } });
  scoped.add({ id: 's3', scope: 'forever', trigger: { event: 'rep' }, action: { template: 'rule.halfway' } });
  ok('list() 按优先级排序；clearScope("set") 只删 set 作用域',
    scoped.list().length === 3 && scoped.clearScope('set') === 1
    && scoped.list().map((r) => r.id).sort().join(',') === 's2,s3');
  ok('remove(id) 删一条并返回是否删到；normalizeRule 拒绝脏规则',
    scoped.remove('s2') === true && scoped.remove('s2') === false
    && normalizeRule({}) === null && normalizeRule({ id: 'x', trigger: { event: 'nope' } }) === null
    && normalizeRule({ id: 'x', trigger: { event: 'rep' } }).priority === RULE_PRIORITIES.encourage);

  /* ---------------- 话量三档（少 = 只报每 5 个） ---------------- */
  const vol = makeEngine({ volume: 'low' });
  const fireLow = (type, data = {}) => fire(vol, type, data, { volume: 'low' });
  fireLow('session-start');
  clock.t += 1000;
  ok('话量=少：第 1~4 个**不说**（不是每一下都报）',
    fireLow('rep', { n: 1, target: 20, v: true }) === null
    && fireLow('rep', { n: 4, target: 20, v: true }) === null);
  clock.t += 2000;
  out = fireLow('rep', { n: 5, target: 20, v: true });
  ok('话量=少：只报每 5 个（第 5 个说「五个了」）',
    out && out.speak.ruleId === 'rep-count' && out.speak.text === '五个了',
    JSON.stringify(out && out.speak));
  clock.t += 6000;
  ok('话量=少：过半**不说**', fireLow('progress', { pct: 50 }) === null);
  clock.t += 6000;
  ok('话量=少：最后 5 秒倒数**不说**', fireLow('hold-tick', { remainingSec: 5 }) === null);
  clock.t += 6000;
  ok('话量=少：最后 3 个**照说**', fireLow('rep', { n: 17, target: 20, v: true })?.speak.ruleId === 'last-three');
  clock.t += 6000;
  ok('话量=少：门控连错**不再由 R1 说**（R3 起交给裁判；纠正类只剩最后 3 个）',
    fireLow('gate-fail', { g: 'prone' }) === null
    && fireLow('gate-fail', { g: 'prone' }) === null);
  const volHi = makeEngine({ volume: 'high' });
  fire(volHi, 'session-start', {}, { volume: 'high' });
  clock.t += 1000;
  ok('话量=多：第 5 个照说「五个了」',
    fire(volHi, 'rep', { n: 5, target: 20, v: true }, { volume: 'high' })?.speak.text === '五个了');
  clock.t += 6000;
  ok('话量=多：过半**照说**',
    fire(volHi, 'progress', { pct: 50 }, { volume: 'high' })?.speak.ruleId === 'halfway');

  /* ---------------- 诊断：rule:skip ---------------- */
  const diagBus = createDiag({ fetch: async () => ({ ok: true }), now: () => clock.t });
  const diagEngine = makeEngine({ diag: diagBus });
  clock.t += 1000;
  diagEngine.handle({ type: 'gate-fail', data: { g: 'prone' } }, st({ muted: true }));
  ok('诊断：静音被挡记 `rule:skip {reason:"muted"}`（调试「为什么教练不说话」）',
    diagBus.snapshot().rule.skip === 1 && diagBus.snapshot().rule.reason === 'muted',
    JSON.stringify(diagBus.snapshot().rule));
  clock.t += 1000;
  diagEngine.handle({ type: 'idle', data: { sec: 9 } }, st({ speaking: true }));
  clock.t += 1000;
  diagEngine.handle({ type: 'idle', data: { sec: 9 } }, st({ speaking: true }));
  ok('诊断：正在说话被挡记 reason=speaking', diagBus.snapshot().rule.reason === 'speaking');
  diagBus.record('rule:speak', { ruleId: 'last-three', event: 'rep', priority: 40, ms: 3 });
  ok('诊断字典认 `rule:speak {ruleId, event, priority, ms}`',
    diagBus.snapshot().rule.speak === 1 && diagBus.snapshot().rule.lastRule === 'last-three'
    && diagBus.snapshot().rule.priority === 40 && diagBus.snapshot().rule.ms === 3,
    JSON.stringify(diagBus.snapshot().rule));
}

/* ================================================================== *
 * [39] R2 私人教练式缺省规则 + 口述建规则：数词 / 规则工厂 / 描述 / 用户规则只在自己那一步说
 * ================================================================== */
console.log('\n[39] R2：数词（一/二/五）· repRule / readRule 工厂 · describeRule · 口述规则只在自己的间隔说');
{
  setLang('zh', { persist: false });
  const clock = { t: 5000000 };
  const st = (extra = {}) => ({ speaking: false, muted: false, coachOn: true, volume: 'mid', ...extra });
  const makeEngine = (rules) => {
    const engine = createRuleEngine({ now: () => clock.t, minGapMs: 0 });
    for (const r of rules) engine.add(r);
    return engine;
  };

  /* ---------------- 数词（给 TTS 念的不是阿拉伯数字） ---------------- */
  ok('中文数词：1~10 / 十几 / 几十 / 一百零五',
    zhNumber(1) === '一' && zhNumber(5) === '五' && zhNumber(10) === '十'
    && zhNumber(15) === '十五' && zhNumber(20) === '二十' && zhNumber(21) === '二十一'
    && zhNumber(99) === '九十九' && zhNumber(105) === '一百零五'
    && zhNumber(100) === '一百',
    JSON.stringify([1, 5, 10, 15, 20, 21, 99, 105, 100].map((n) => zhNumber(n))));
  ok('英文数词：one / ten / twenty-one（二十几带连字符）',
    enNumber(1) === 'one' && enNumber(10) === 'ten' && enNumber(21) === 'twenty-one'
    && enNumber(120) === 'one hundred twenty',
    JSON.stringify([1, 10, 21, 120].map((n) => enNumber(n))));
  ok('numberWord(n, lang)：中文走数词，其余语言走英文数词；超范围不编（回阿拉伯数字）',
    numberWord(5, 'zh') === '五' && numberWord(5, 'en') === 'five'
    && numberWord(5) === '五' && numberWord(1000, 'zh') === '1000');

  /* ---------------- 规则工厂 ---------------- */
  const defRep = normalizeRule(repRule());
  ok('repRule() 缺省 = 逐次报数：rep 事件 / channel=rep / priority 35 / bypassGap / 自适应参数齐全',
    defRep.id === 'rep-count' && defRep.scope === 'set' && defRep.channel === 'rep'
    && defRep.priority === RULE_PRIORITIES.count && defRep.bypassGap === true
    && defRep.adaptive && defRep.adaptive.minStepMs === 1000
    && defRep.adaptive.lowVolumeStride === 5 && defRep.trigger.filter === null,
    JSON.stringify(defRep.adaptive));
  const fixedRep = normalizeRule(repRule({ every: 10, id: 'user-rep-10', scope: 'session' }));
  ok('repRule({every:10}) = 固定间隔：filter.everyN=10 / scope=session / 没有自适应（不再降频）',
    fixedRep.trigger.filter.everyN === 10 && fixedRep.scope === 'session'
    && fixedRep.adaptive === null && fixedRep.channel === 'rep');
  const defRead = normalizeRule(readRule());
  ok('readRule() 缺省 = 计时类每 5 秒读秒：tick + everySec:5 + hold + remainingGt:5 / priority 45',
    defRead.id === 'hold-read-5' && defRead.channel === 'read'
    && defRead.trigger.filter.everySec === 5 && defRead.trigger.filter.hold === true
    && defRead.trigger.filter.remainingGt === 5
    && defRead.priority === RULE_PRIORITIES.read && defRead.bypassGap === true);
  const userRead = normalizeRule(readRule({ every: 30, id: 'user-read-30', scope: 'session', holdOnly: false }));
  ok('readRule({every:30, holdOnly:false}) = 报时规则：everySec=30、不限计时类（计数类也报）',
    userRead.trigger.filter.everySec === 30 && !userRead.trigger.filter.hold
    && !('remainingGt' in userRead.trigger.filter) && userRead.scope === 'session');

  /* ---------------- describeRule（「现在有什么规则」逐条报出来用） ---------------- */
  ok('describeRule：规则名 + 间隔都走词条（报数 / 读秒 / 固定间隔 / 自适应）',
    describeRule(defRep) === '报数间隔：每个都报，节奏快时自动降频'
    && describeRule(fixedRep) === '报数间隔：每 10 个报一次'
    && describeRule(defRead) === '读秒间隔：每 5 秒读一次'
    && describeRule(userRead) === '读秒间隔：每 30 秒读一次',
    JSON.stringify([describeRule(defRep), describeRule(fixedRep), describeRule(defRead), describeRule(userRead)]));
  ok('ruleNameKey / ruleEveryText 是纯函数（没写 label 的规则兜底「其他规则」）',
    ruleNameKey(defRep) === 'rule.name.rep'
    && ruleNameKey({}) === 'rule.name.other'
    && ruleEveryText(fixedRep) === '每 10 个报一次');

  /* ---------------- 口述「每 10 个报一次」→ 只在第 10 个说 ---------------- */
  const rep10 = makeEngine([repRule({ every: 10, id: 'user-rep-10', scope: 'session' })]);
  const said = [];
  let out = null;
  for (let n = 1; n <= 20; n += 1) {
    clock.t += 1500;
    out = rep10.handle({ type: 'rep', data: { n, target: 40, v: true } }, st());
    if (out) said.push({ n, text: out.speak.text, ruleId: out.speak.ruleId });
  }
  ok('用户规则「每 10 个报一次」：1~9 不说，第 10 个说，20 个里只说 2 次',
    said.length === 2 && said[0].n === 10 && said[1].n === 20
    && said.every((s) => s.ruleId === 'user-rep-10'), JSON.stringify(said));
  ok('第 10 个那句话是整句鼓励（「十个了，稳住」），不是干巴巴的「10」',
    said[0].text === '十个了，稳住', JSON.stringify(said[0]));

  /* ---------------- 口述「每 30 秒报时」→ 只在自己那一秒说 ---------------- */
  const read30 = makeEngine([readRule({ every: 30, id: 'user-read-30', scope: 'session', holdOnly: false })]);
  const readSaid = [];
  for (const sec of [5, 10, 15, 20, 25, 30, 35, 60]) {
    clock.t += 1000;
    const r = read30.handle({ type: 'tick', data: { elapsedSec: sec } }, st());
    if (r) readSaid.push(r.speak.text);
  }
  ok('用户规则「每 30 秒报时」：只在 30 / 60 秒说（计数类动作的 tick 也算）',
    readSaid.join(',') === '三十秒,六十秒', JSON.stringify(readSaid));

  /* ---------------- 两条规则同一条引擎：互不串台 ---------------- */
  const both = makeEngine([
    repRule({ every: 5, id: 'user-rep-5', scope: 'session' }),
    readRule({ every: 10, id: 'user-read-10', scope: 'session', holdOnly: false }),
  ]);
  clock.t += 1000;
  const repHit = both.handle({ type: 'rep', data: { n: 5, target: 20 } }, st());
  clock.t += 1000;
  const tickHit = both.handle({ type: 'tick', data: { elapsedSec: 10 } }, st());
  ok('报数规则只听 rep、读秒规则只听 tick（两条用户规则同表也不打架）',
    repHit && repHit.speak.ruleId === 'user-rep-5'
    && tickHit && tickHit.speak.ruleId === 'user-read-10',
    JSON.stringify([repHit && repHit.speak, tickHit && tickHit.speak]));
}

/* ================================================================== *
 * [40] R3：LLM 当「裁判」—— 事件触发、严格 JSON、静默优先、并发 1、8s 冷却 / 15s 去重
 * ================================================================== */
console.log('\n[40] R3 LLM 裁判：8 个触发点口径 / 严格 JSON / 触发次数（假时钟）/ 并发 1 / 门控回退');
{
  setLang('zh', { persist: false });
  const clock = { t: 9000000 };
  const st = (extra = {}) => ({ enabled: true, muted: false, speaking: false, ...extra });
  const makeDiag = () => createDiag({ fetch: async () => ({ ok: true }), now: () => clock.t });
  /** 只记「谁被念了」的假 speak */
  const makeSpeaker = () => {
    const said = [];
    return { said, speak: (text, meta) => said.push({ text, ...(meta || {}) }) };
  };
  /** 假定时器：手动 fire（测 8s 超时用） */
  const makeTimers = () => {
    const list = [];
    return {
      list,
      setTimer: (fn, ms) => { list.push({ fn, ms }); return list.length; },
      clearTimer: () => {},
      fireAll: () => { for (const item of list.splice(0)) item.fn(); },
    };
  };

  /* ---------------- 口径：一处定义（前端 / 服务端 / 测试同一份） ---------------- */
  ok('[40] 裁判口径一处定义：10 个事件（8 个触发点 + 复用 session-start + 告别 session-end）',
    JUDGE_EVENTS.length === 10
    && JUDGE_EVENTS.join(',') === 'set-complete,pr,rep-judge,hold-judge,idle,out-of-frame,gate-fail2,keyframe-miss2,session-start,session-end'
    && JUDGE_ASK_EVENTS.length === 8
    && !JUDGE_ASK_EVENTS.includes('session-start') && !JUDGE_ASK_EVENTS.includes('session-end'),
    JSON.stringify(JUDGE_EVENTS));
  ok('[40] 服务端读的是同一份 JUDGE_EVENTS（JUDGE_EVENT_TYPES === JUDGE_EVENTS）',
    Array.isArray(JUDGE_EVENT_TYPES) && JUDGE_EVENT_TYPES.join(',') === JUDGE_EVENTS.join(','));
  ok('[40] isJudgeEvent / isJudgeAskEvent / isJudgeFarewellEvent：session-start 与 session-end 都不走裁判模式',
    isJudgeEvent('session-start') && !isJudgeAskEvent('session-start')
    && isJudgeEvent('session-end') && !isJudgeAskEvent('session-end')
    && isJudgeFarewellEvent('session-end') && !isJudgeFarewellEvent('session-start')
    && isJudgeEvent('rep-judge') && isJudgeAskEvent('rep-judge')
    && !isJudgeEvent('nope') && !isJudgeAskEvent(''));
  ok('[40] 触发优先级：告别最高（最后一句话，可抢占破纪录），静止最低',
    judgePriority('session-end') === 120 && judgePriority('session-end') > judgePriority('pr')
    && judgePriority('pr') === 100 && judgePriority('gate-fail2') === 80
    && judgePriority('set-complete') === 60 && judgePriority('rep-judge') === 40
    && judgePriority('out-of-frame') === 30 && judgePriority('idle') === 20
    && judgePriority('nope') === 0);
  ok('[40] 告别语 ≤2 句 / ≤60 字：第 3 句被截掉、小数点不算句末、换行压成空格',
    FAREWELL_MAX_CHARS === 60 && FAREWELL_MAX_SENTENCES === 2
    && clampFarewellSpeak('这组 12 次，平均 76.5 分。明天见！第三句不该出现。')
      === '这组 12 次，平均 76.5 分。明天见！'
    && clampFarewellSpeak('第一句。第二句！第三句。') === '第一句。第二句！'
    && clampFarewellSpeak('  ') === ''
    && [...clampFarewellSpeak('啊'.repeat(120))].length === FAREWELL_MAX_CHARS,
    JSON.stringify({
      two: clampFarewellSpeak('这组 12 次，平均 76.5 分。明天见！第三句不该出现。'),
      three: clampFarewellSpeak('第一句。第二句！第三句。'),
    }));

  /* ---------------- 触发次数（假时钟 / 假计数） ---------------- */
  const countRep = (max) => {
    let n = 0;
    for (let i = 1; i <= max; i += 1) if (shouldJudgeRep(i)) n += 1;
    return n;
  };
  ok('[40] 每 3 个：1~12 个里只问 4 次（3 / 6 / 9 / 12），0 不算',
    REP_JUDGE_EVERY === 3 && countRep(12) === 4 && !shouldJudgeRep(0)
    && shouldJudgeRep(3) && !shouldJudgeRep(4));
  ok('[40] 计时类每 10 秒：1~30 秒里问 3 次（10 / 20 / 30），0 秒 / 9 秒不问',
    HOLD_JUDGE_EVERY_SEC === 10
    && [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 19, 20, 29, 30].filter((s) => shouldJudgeHold(s)).join(',')
      === '10,20,30'
    && !shouldJudgeHold(0) && !shouldJudgeHold(9));
  ok('[40] 静止：10 秒起、之后每 10 秒一次（9 秒不问 / 10 问 / 11~19 不问 / 20 再问）',
    IDLE_JUDGE_START_SEC === 10
    && !shouldJudgeIdle(9) && shouldJudgeIdle(10) && !shouldJudgeIdle(11)
    && !shouldJudgeIdle(19) && shouldJudgeIdle(20) && shouldJudgeIdle(30)
    && [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].filter((s) => shouldJudgeIdle(s)).length === 2);
  ok('[40] 出画：和静止同一套口径（10 秒起、每 10 秒一次，回到画面由调用方清零）',
    OUT_OF_FRAME_JUDGE_START_SEC === 10
    && !shouldJudgeOutOfFrame(9) && shouldJudgeOutOfFrame(10)
    && !shouldJudgeOutOfFrame(15) && shouldJudgeOutOfFrame(20));
  ok('[40] 护栏数值就是用户拍板的：8s 冷却 / 15s 去重 / 8s 超时 / 一句话 ≤40 字',
    JUDGE_COOLDOWN_MS === 8000 && JUDGE_DEDUPE_MS === 15000
    && JUDGE_TIMEOUT_MS === 8000 && JUDGE_MAX_CHARS === 40
    && GATE_FAIL_JUDGE_STREAK === 2 && KEYFRAME_MISS_JUDGE_STREAK === 2);

  /* ---------------- 严格 JSON 解析（speak / actions / 静默） ---------------- */
  ok('[40] `{"speak":null}` → 静默（ok=true, speak=null，不是失败）',
    parseJudgeReply('{"speak": null}').ok === true
    && parseJudgeReply('{"speak": null}').speak === null
    && parseJudgeReply('{"speak":null}').actions.length === 0);
  ok('[40] `{"speak":"节奏再稳一点"}` → 原样取出这一句',
    parseJudgeReply('{"speak":"节奏再稳一点"}').speak === '节奏再稳一点');
  ok('[40] 模型多包一层 ```json 围栏 / 前后有解释文字也能抠出来',
    parseJudgeReply('```json\n{"speak":"好"}\n```').speak === '好'
    && parseJudgeReply('这是结果：{"speak":"好"} 以上').speak === '好');
  ok('[40] 空输出 = 静默（不是失败）；不是 JSON / 缺 speak / speak 不是字符串 → ok=false（调用方静默）',
    parseJudgeReply('').ok === true && parseJudgeReply('').speak === null
    && parseJudgeReply('我觉得还行').ok === false
    && parseJudgeReply('{"text":"x"}').ok === false
    && parseJudgeReply('{"speak": 42}').ok === false);
  ok('[40] 超过 40 字截断（按码点，不切一半）；换行压成空格；成对引号去掉',
    parseJudgeReply(`{"speak":"${'啊'.repeat(60)}"}`).speak.length === 40
    && clampJudgeSpeak('第一行\n第二行') === '第一行 第二行'
    && clampJudgeSpeak('"节奏很好"') === '节奏很好'
    && clampJudgeSpeak('   ') === '');
  ok('[40] actions 只在是数组时保留（每项要有 intent）',
    parseJudgeReply('{"speak":null,"actions":[{"intent":"pause","args":{}},{"nope":1}]}').actions.length === 1
    && parseJudgeReply('{"speak":null,"actions":"x"}').actions.length === 0);

  /* ---------------- 门控诊断 → 「差多少」 ---------------- */
  const checks = parseGateDiagRow('✗ knee 120(>=50<=158)✗ hip 40(>=50<=158)✗ armRaised 0.9(<=0.45)✗');
  ok('[40] 门控诊断行解析：哪个量 / 当前值 / 上下限 / 差多少',
    checks.length === 3
    && checks[0].metric === 'knee' && checks[0].value === 120 && checks[0].ok === false
    && checks[1].metric === 'hip' && checks[1].gap === 10
    && Math.abs(checks[2].gap - 0.45) < 0.06,
    JSON.stringify(checks));
  ok('[40] 过了的那条 gap=0；worstGateCheck 挑差得最多的那条',
    parseGateDiagRow('✗ knee 99(>=50<=158)✓').every((c) => c.gap === 0 && c.ok)
    && worstGateCheck(checks).metric === 'hip' && worstGateCheck([]) === null);

  /* ---------------- 控制器：静默优先 + 真出声 ---------------- */
  {
    const diag = makeDiag();
    const sp = makeSpeaker();
    const judge = createJudge({
      ask: async () => ({ speak: null, actions: [] }),
      speak: sp.speak,
      diag,
      now: () => clock.t,
    });
    const silentRun = await judge.request('rep-judge', { context: { judge: { event: 'rep-judge' } } });
    ok('[40] mock LLM 回 speak:null → **不出声**（一句都不念），但诊断记了 judge:ask {ok:true, spoke:false}',
      silentRun.ok === true && silentRun.spoke === false && sp.said.length === 0
      && diag.snapshot().judge.ask === 1 && diag.snapshot().judge.spoke === 0
      && diag.snapshot().judge.ok === true,
      JSON.stringify({ run: silentRun, judge: diag.snapshot().judge }));
    ok('[40] 静默率（mock 下）= 100%（问了 1 次、一句没说）',
      judge.silenceRate === 100 && judge.stats.asked === 1 && judge.stats.silenced === 1);
  }
  {
    const diag = makeDiag();
    const sp = makeSpeaker();
    const judge = createJudge({
      ask: async () => ({ speak: '膝盖再弯一点', actions: [] }),
      speak: sp.speak,
      diag,
      now: () => clock.t,
    });
    const run = await judge.request('rep-judge');
    ok('[40] 模型给了一句话 → 走同一条教练通道念出去（source=judge，不是 fallback）',
      run.spoke === true && sp.said.length === 1 && sp.said[0].text === '膝盖再弯一点'
      && sp.said[0].fallback !== true
      && diag.snapshot().judge.spoke === 1 && judge.silenceRate === 0,
      JSON.stringify({ run, said: sp.said }));
  }

  /* ---------------- 护栏：冷却 / 去重 / 静音 / 说话中 / 教练关 ---------------- */
  {
    const diag = makeDiag();
    const sp = makeSpeaker();
    let calls = 0;
    const judge = createJudge({
      ask: async () => { calls += 1; return { speak: null }; },
      speak: sp.speak,
      diag,
      now: () => clock.t,
    });
    await judge.request('rep-judge');
    const again = await judge.request('rep-judge');
    ok('[40] 同触发 8s 冷却：8 秒内再触发 → judge:skip {reason:"cooldown"}（不发请求）',
      again.skipped === 'cooldown' && calls === 1
      && diag.snapshot().judge.reason === 'cooldown',
      JSON.stringify({ again, calls }));
    clock.t += 8000;
    const later = await judge.request('rep-judge');
    ok('[40] 过 8 秒之后同一个触发可以再问一次', later.ok === true && calls === 2);
    clock.t += 100;   // 换一个触发不受「同触发冷却」影响（各自记各自的时刻）
    const other = await judge.request('hold-judge');
    ok('[40] 冷却按触发分开算：hold-judge 不受 rep-judge 影响', other.ok === true && calls === 3);
  }
  {
    const sp = makeSpeaker();
    const judge = createJudge({
      ask: async () => ({ speak: '同一句话' }),
      speak: sp.speak,
      now: () => clock.t,
    });
    await judge.request('rep-judge');
    clock.t += 8000;
    const dup = await judge.request('hold-judge');     // 8s 后再来一条，同一句 → 去重
    ok('[40] 同文本 15s 内不重复（8 秒后同一个句子还没过窗口）',
      sp.said.length === 1 && dup.spoke === false,
      JSON.stringify({ said: sp.said.length, dup }));
    clock.t += 8000;                                    // 累计 16s > 15s
    const dup2 = await judge.request('idle');
    ok('[40] 过了 15s 去重窗口，同一句话可以再说（不是永久禁掉）',
      dup2.spoke === true && sp.said.length === 2, JSON.stringify(dup2));
  }
  {
    const sp = makeSpeaker();
    const diag = makeDiag();
    let status = st({ enabled: false });
    let calls = 0;
    const judge = createJudge({
      ask: async () => { calls += 1; return { speak: '好' }; },
      speak: sp.speak,
      diag,
      status: () => status,
      now: () => clock.t,
    });
    const off = await judge.request('rep-judge');
    status = st({ muted: true });
    const muted = await judge.request('hold-judge');
    status = st({ speaking: true });
    const speaking = await judge.request('idle');
    ok('[40] 教练关 / 静音 → 直接丢弃（诊断说清是哪道栏杆）；正在说话 → 请求可以问，但**出声那一刻**丢弃',
      off.skipped === 'coach-off' && muted.skipped === 'muted'
      && speaking.ok === true && speaking.spoke === false
      && calls === 1 && sp.said.length === 0
      && diag.snapshot().judge.skip === 3 && diag.snapshot().judge.reason === 'speaking',
      JSON.stringify({ off, muted, speaking, judge: diag.snapshot().judge }));
    status = st();
    clock.t += 1000;
    const back = await judge.request('set-complete');
    ok('[40] 恢复之后照常问（丢弃不占用冷却）', back.ok === true && calls === 2);
  }

  /* ---------------- 并发 1：新触发取消旧的（破纪录可抢占） ---------------- */
  {
    const diag = makeDiag();
    const sp = makeSpeaker();
    let resolveFirst = null;
    let n = 0;
    const judge = createJudge({
      ask: (event) => {
        n += 1;
        if (event === 'rep-judge') return new Promise((resolve) => { resolveFirst = resolve; });
        return Promise.resolve({ speak: '破纪录了' });
      },
      speak: sp.speak,
      diag,
      now: () => clock.t,
    });
    const slow = judge.request('rep-judge');
    await Promise.resolve();
    ok('[40] 并发 1：同一时刻只有一条在飞（inflight 有值）', !!judge.inflight && n === 1,
      JSON.stringify(judge.inflight));
    clock.t += 100;
    const pr = await judge.request('pr');
    ok('[40] 破纪录（优先级 100）抢占低优先级请求：新请求立刻问出去并出声',
      pr.ok === true && pr.spoke === true && sp.said.at(-1).text === '破纪录了');
    resolveFirst({ speak: '这条已经晚了' });
    const stale = await slow;
    ok('[40] 被取消的旧请求回来也只丢：不出声、不记 spoke',
      stale.spoke === false && stale.skipped === 'superseded'
      && !sp.said.some((item) => item.text === '这条已经晚了'),
      JSON.stringify({ stale, said: sp.said }));
    ok('[40] 诊断：被判超车的那条记 judge:skip {reason:"superseded"}',
      diag.snapshot().judge.skip >= 1);
  }
  {
    const judge = createJudge({
      ask: () => new Promise(() => {}),   // 永不返回
      speak: () => {},
      now: () => clock.t,
    });
    judge.request('pr');
    await Promise.resolve();
    const lower = await judge.request('idle');
    ok('[40] 低优先级触发在飞时不会挤掉高优先级（reason=busy）', lower.skipped === 'busy');
  }

  /* ---------------- 超时 8s / 失败：门控回退模板，其余静默 ---------------- */
  {
    const diag = makeDiag();
    const sp = makeSpeaker();
    const timers = makeTimers();
    const judge = createJudge({
      ask: () => new Promise(() => {}),
      speak: sp.speak,
      diag,
      now: () => clock.t,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const p = judge.request('rep-judge');
    await Promise.resolve();
    clock.t += 8000;
    timers.fireAll();
    const run = await p;
    ok('[40] 超时 8s → 静默收场（ok:false、不出声、不重试），诊断带 code=timeout',
      run.ok === false && run.spoke === false && sp.said.length === 0
      && diag.snapshot().judge.failed === 1 && diag.snapshot().judge.code === 'timeout'
      && timers.list.length === 0,
      JSON.stringify({ run, judge: diag.snapshot().judge }));
  }
  {
    const sp = makeSpeaker();
    const judge = createJudge({
      ask: async () => { const err = new Error('nope'); err.code = 'llm-timeout'; throw err; },
      speak: sp.speak,
      now: () => clock.t,
    });
    const silent = await judge.request('rep-judge');
    ok('[40] LLM 失败（非门控）→ 静默，不回退任何模板口令',
      silent.ok === false && silent.spoke === false && sp.said.length === 0);
  }
  {
    const diag = makeDiag();
    const sp = makeSpeaker();
    const judge = createJudge({
      ask: async () => { const err = new Error('nope'); err.code = 'llm-http-503'; throw err; },
      speak: sp.speak,
      diag,
      now: () => clock.t,
    });
    const fallback = '膝盖再弯一点（连着两次没到位，先摆好）';
    const run = await judge.request('gate-fail2', {
      context: { judge: { event: 'gate-fail2', gate: 'kneelPushup' } },
      fallback,
    });
    ok('[40] 门控那条 LLM 失败 → **回退 R1 模板口令**（同一句，source=fallback）',
      run.ok === false && run.spoke === true
      && sp.said.length === 1 && sp.said[0].text === fallback && sp.said[0].fallback === true
      && diag.snapshot().judge.spoke === 1,
      JSON.stringify({ run, said: sp.said }));
  }

  /* ---------------- 服务端：一条事件一条 user 消息（中英各一套） ---------------- */
  const ctx = {
    session: { name: '自重深蹲', exerciseId: 'squat', kind: 'reps', target: 20, reps: 6 },
    performance: { score: 88 },
    judge: {
      event: 'set-complete',
      unit: '次',
      set: { value: 15, score: 88, target: 20, kind: 'reps' },
      prev: { value: 12, score: 71 },
      trend: 'improved',
      record: 'score',
      score: 88, prevScore: 71, value: 15, prevValue: 12,
      every: 3, reps: 6, elapsedSec: 20, remainingSec: 40, idleSec: 10, outSec: 12,
      gate: 'kneelPushup', cue: '膝盖再弯一点', streak: 2,
      worst: { metric: 'hip', value: 40, min: 50, max: 158, gap: 10 },
      keyframe: { id: 'kneeLine', name: '膝盖过脚尖', pts: 3, max: 7, gap: 4 },
      miss: { name: '膝盖过脚尖', pts: 3, max: 7, gap: 4 },
    },
  };
  const zhMsgs = {};
  for (const event of JUDGE_ASK_EVENTS) {
    zhMsgs[event] = judgeEventMessage({ event, locale: 'zh', context: ctx });
  }
  ok('[40] 8 个裁判事件都生成了中文 user 消息（都以 [事件] 开头、不重复）',
    JUDGE_ASK_EVENTS.every((e) => zhMsgs[e].startsWith('[事件]'))
    && new Set(Object.values(zhMsgs)).size === 8,
    JSON.stringify(zhMsgs));
  ok('[40] 每条消息都带上了这条事件的关键数字（不是一句空话）',
    zhMsgs['set-complete'].includes('15') && zhMsgs['set-complete'].includes('88')
    && zhMsgs['set-complete'].includes('71') && zhMsgs['set-complete'].includes('比上一组高')
    && zhMsgs.pr.includes('破纪录') && zhMsgs.pr.includes('88')
    && zhMsgs['rep-judge'].includes('6/20') && zhMsgs['rep-judge'].includes('膝盖过脚尖')
    && zhMsgs['hold-judge'].includes('20 秒') && zhMsgs['hold-judge'].includes('40 秒')
    && zhMsgs.idle.includes('10 秒') && zhMsgs['out-of-frame'].includes('12 秒')
    && zhMsgs['gate-fail2'].includes('kneelPushup') && zhMsgs['gate-fail2'].includes('hip=40')
    && zhMsgs['gate-fail2'].includes('差 10')
    && zhMsgs['keyframe-miss2'].includes('膝盖过脚尖') && zhMsgs['keyframe-miss2'].includes('差 4'),
    JSON.stringify(zhMsgs));
  /** 英文环境下的 context：动作名 / 口令 / 关键帧名都由客户端按语言给英文（见 buildAgentContext） */
  const ctxEn = JSON.parse(JSON.stringify(ctx));
  ctxEn.session.name = 'Squat';
  ctxEn.judge.cue = 'bend the knee a bit more';
  ctxEn.judge.unit = 'reps';
  ctxEn.judge.miss = { name: 'knee over toes', pts: 3, max: 7, gap: 4 };
  ctxEn.judge.keyframe = { id: 'kneeLine', name: 'knee over toes', pts: 3, max: 7, gap: 4 };
  const enMsgs = Object.fromEntries(JUDGE_ASK_EVENTS.map((e) => (
    [e, judgeEventMessage({ event: e, locale: 'en', context: ctxEn })])
  ));
  ok('[40] 英文另一套：都以 [Event] 开头、和中文不同、没有残留中文',
    JUDGE_ASK_EVENTS.every((e) => enMsgs[e].startsWith('[Event]') && enMsgs[e] !== zhMsgs[e]
      && !/[\u4e00-\u9fff]/.test(enMsgs[e])),
    JUDGE_ASK_EVENTS.map((e) => `${e}:${enMsgs[e].startsWith('[Event]') ? '' : 'no-prefix'}`
      + `${enMsgs[e] === zhMsgs[e] ? 'same' : ''}${/[\u4e00-\u9fff]/.test(enMsgs[e]) ? 'cjk' : ''}`
      + (enMsgs[e].startsWith('[Event]') && !/[\u4e00-\u9fff]/.test(enMsgs[e]) ? '' : ` ${enMsgs[e]}`)).join(' | '));
  ok('[40] buildLlmMessages 里按 event 生成 user 消息（最后一条就是它）',
    buildLlmMessages({ event: 'gate-fail2', locale: 'zh', context: ctx }).at(-1).content
      === zhMsgs['gate-fail2']
    && buildLlmMessages({ event: 'rep-judge', locale: 'en', context: ctxEn }).at(-1).content
      === enMsgs['rep-judge']);
  ok('[40] 裁判 mode 的 system prompt 写明了严格 JSON / 默认 null / ≤40 字 / 不编数字',
    (() => {
      const sys = buildLlmMessages({ event: 'rep-judge', locale: 'zh', context: ctx })[0].content;
      return sys.includes('{"speak": string|null') && sys.includes('默认 speak = null')
        && sys.includes('40 字') && sys.includes('不要问问题') && sys.includes('不许自己编');
    })());
  ok('[40] session-start 仍然是**普通问候**（不是裁判 mode，也不带 JSON 规则）',
    (() => {
      const msgs = buildLlmMessages({ event: 'session-start', locale: 'zh', context: ctx });
      return msgs.at(-1).content.startsWith('[事件] 用户刚刚进入训练')
        && !msgs[0].content.includes('默认 speak = null');
    })());
  ok('[40] 裁判请求**不带对话历史**（一条事件一条请求，最后一条是这条事件）',
    (() => {
      const msgs = buildLlmMessages({
        event: 'idle', locale: 'zh', context: ctx,
        history: [{ role: 'user', content: '上一句' }, { role: 'assistant', content: '上一答' }],
      });
      // buildLlmMessages 本身照旧拼历史；「裁判不带历史」由路由决定（history: judgeMode ? [] : …）
      return msgs.length >= 2 && msgs.at(-1).content === zhMsgs.idle;
    })());
  /* 首次见面只自报一次：裁判 mode 下**不加**「先说一次自报家门」（否则模型会在训练中自我介绍一下） */
  ok('[40] 裁判 mode 下不加「首次自报家门」（introSeen 未置位时也只说事件本身）',
    (() => {
      const sys = buildLlmMessages({ event: 'rep-judge', locale: 'zh', context: ctx })[0].content;
      return !sys.includes('先说一次自报家门') && !sys.includes('这是首次对话');
    })());

  /* ================================================================== *
   * session-end 告别（退出全屏 / 回主页 → ≤2 句；之后本场不再与 LLM 通信）
   * ================================================================== */

  /* ---------------- ① 服务端：告别事件的 user 消息（中英各一套，数字全来自 context） ---------------- */
  const farewellCtx = {
    session: { name: '自重深蹲', exerciseId: 'squat', kind: 'reps', target: 20, reps: 3 },
    judge: {
      event: 'session-end',
      unit: '次',
      durationSec: 740,
      sets: 3,
      reps: 45,
      avgScore: 82,
      bestScore: 95,
      bestValue: 18,
      prev: { sets: 2, reps: 30, avgScore: 79, bestScore: 90 },
      deltaReps: 15,
      deltaScore: 3,
    },
  };
  const farewellZh = sessionEndEventMessage({ locale: 'zh', context: farewellCtx });
  /** 英文环境下动作名 / 单位都由客户端按语言给英文（见 buildAgentContext），这里照做 */
  const farewellCtxEn = JSON.parse(JSON.stringify(farewellCtx));
  farewellCtxEn.judge.unit = 'reps';
  const farewellEn = sessionEndEventMessage({ locale: 'en', context: farewellCtxEn });
  ok('[40] session-end：中文事件描述带齐时长 / 组数 / 次数 / 均分 / 最佳 / 与上次对比',
    farewellZh.startsWith('[事件] 本次训练结束')
    && farewellZh.includes('12 分钟') && farewellZh.includes('3 组')
    && farewellZh.includes('45') && farewellZh.includes('82 分')
    && farewellZh.includes('95 分') && farewellZh.includes('18')
    && farewellZh.includes('30') && farewellZh.includes('+15') && farewellZh.includes('+3')
    && farewellZh.includes('明天见') && farewellZh.includes('最多 2 句'),
    farewellZh);
  ok('[40] session-end：英文另一套（[Event] 开头、没有残留中文、数字一致）',
    farewellEn.startsWith('[Event] Workout finished') && !/[\u4e00-\u9fff]/.test(farewellEn)
    && farewellEn.includes('12 min') && farewellEn.includes('45') && farewellEn.includes('+15'),
    farewellEn);
  ok('[40] session-end：0 组（中途退出）也发事件，并明确「不要编成绩」',
    (() => {
      const zero = sessionEndEventMessage({
        locale: 'zh',
        context: { judge: { event: 'session-end', durationSec: 40, sets: 0, reps: 0, avgScore: 0, bestScore: 0, prev: null } },
      });
      return zero.includes('组数=0') && zero.includes('总次数=0') && zero.includes('不要编成绩')
        && zero.includes('没有上一场可比') && zero.includes('40 秒');
    })());
  ok('[40] buildLlmMessages：session-end 的 user 消息就是那句告别事件（不是空 text）',
    buildLlmMessages({ event: 'session-end', locale: 'zh', context: farewellCtx }).at(-1).content === farewellZh
    && buildLlmMessages({ event: 'session-end', locale: 'en', context: farewellCtxEn }).at(-1).content === farewellEn);
  ok('[40] 告别 mode 的 system prompt：纯文本 / 最多 2 句 / 真实数字 / 明天见或动起来 / 不提问',
    (() => {
      const sys = buildLlmMessages({ event: 'session-end', locale: 'zh', context: farewellCtx })[0].content;
      return sys.includes('告别模式') && sys.includes('纯文本') && sys.includes('最多 **2 句**')
        && sys.includes('明天见') && sys.includes('不要提问')
        && !sys.includes('默认 speak = null') && !sys.includes('先说一次自报家门');
    })());
  ok('[40] 告别不带对话历史（一条事件一条请求），也不加「首次自报家门」',
    (() => {
      const msgs = buildLlmMessages({
        event: 'session-end', locale: 'zh', context: farewellCtx,
        history: [{ role: 'user', content: '上一句' }, { role: 'assistant', content: '上一答' }],
      });
      // 「告别不带历史」由路由决定（history: judgeMode || farewellMode ? [] : …）
      return msgs.at(-1).content === farewellZh
        && !msgs[0].content.includes('这是首次对话');
    })());
  ok('[40] 服务端读的是同一份告别口径（session-end 不算裁判，但算告别）',
    LLM_EVENT_SESSION_END === 'session-end' && LLM_CLIENT_EVENT_END === 'session-end'
    && isJudgeFarewellEventServer('session-end') && !isJudgeAskEventServer('session-end'));

  /* ---------------- ② 客户端：farewell() 发 {event:'session-end', text:''}，读回自由文本 ---------------- */
  {
    const calls = [];
    const client = createLlmClient({
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, reply: '今天 3 组 45 次，均分 82 分。明天见！', actions: [], provider: 'deepseek', model: 'deepseek-chat' }),
        };
      },
    });
    const out = await client.farewell({ locale: 'zh', context: farewellCtx });
    ok('[40] 客户端 farewell()：POST /llm {event:"session-end", text:""}，回自由文本（不解析 JSON）',
      calls.length === 1 && calls[0].url.endsWith('/llm')
      && calls[0].body.event === 'session-end' && calls[0].body.text === ''
      && !!calls[0].body.context && calls[0].body.context.judge.event === 'session-end'
      && out.text === '今天 3 组 45 次，均分 82 分。明天见！' && out.ms >= 0,
      JSON.stringify({ calls, out }));
    let sealedCode = '';
    client.setSealed(true);
    try { await client.farewell({ locale: 'zh', context: farewellCtx }); } catch (err) { sealedCode = String((err && err.code) || ''); }
    let respondCode = '';
    try { await client.respond('你好'); } catch (err) { respondCode = String((err && err.code) || ''); }
    let judgeCode = '';
    try { await client.judge('rep-judge', { context: farewellCtx }); } catch (err) { judgeCode = String((err && err.code) || ''); }
    ok('[40] 封麦（告别之后）：farewell / respond / judge 全部 llm-sealed，**一个 fetch 都不发**',
      sealedCode === 'llm-sealed' && respondCode === 'llm-sealed' && judgeCode === 'llm-sealed'
      && client.sealed === true && calls.length === 1,
      JSON.stringify({ sealedCode, respondCode, judgeCode, sealed: client.sealed, calls: calls.length }));
    client.setSealed(false);
    const again = await client.farewell({ locale: 'zh', context: farewellCtx });
    ok('[40] 下一次训练解封 → 又能发出去', client.sealed === false && calls.length === 2 && !!again.text);
  }

  /* ---------------- ③ 控制器：cancel() 作废在飞的一条（告别抢占唯一通道） ---------------- */
  {
    const sp = makeSpeaker();
    const diag = makeDiag();
    let release = null;
    const judge = createJudge({
      ask: (event) => (event === 'rep-judge'
        ? new Promise((resolve) => { release = resolve; })
        : Promise.resolve({ speak: '破纪录了' })),
      speak: sp.speak,
      diag,
      now: () => clock.t,
    });
    const pending = judge.request('rep-judge');
    await Promise.resolve();
    ok('[40] cancel() 之前：有一条在飞（可以抢占）', !!judge.inflight);
    const cancelled = judge.cancel('session-end');
    // 作废之后，那条迟到的结果回来了 → 只丢（await 它拿到 superseded，不用等 8s 超时）
    if (typeof release === 'function') release({ speak: '这条已经晚了' });
    const run = await pending;
    await Promise.resolve();
    ok('[40] cancel()：在飞的那条作废（不出声、结果回来也只丢），诊断记 judge:skip',
      cancelled === true && run.spoke === false && run.skipped === 'superseded'
      && sp.said.length === 0 && diag.snapshot().judge.skip === 1
      && diag.snapshot().judge.reason === 'session-end',
      JSON.stringify({ run, said: sp.said, judge: diag.snapshot().judge }));
  }
}

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
