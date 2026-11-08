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

import { createVoiceSession, VOICE_STATES, VOICE_NOTICE_KEYS } from '../src/voice/session.js';
import {
  createLlm, createAsr, createVuMeter,
  rmsToLevel, smoothLevel, levelToColor,
  VU_COLORS, VU_LEVEL_VOICE, VU_LEVEL_LOUD,
} from '../src/voice/providers.js';
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
    emit(text, info = { isFinal: true }) { handlers.result?.(text, info); },
    emitInterim(text) { handlers.interim?.(text); },
    fail(err) { handlers.error?.(err); },
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
  const log = { tracks: [], closed: 0, contexts: 0 };
  const win = {
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          const track = { stopped: false, stop() { this.stopped = true; } };
          log.tracks.push(track);
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        },
      },
    },
    AudioContext: class {
      constructor() { this.state = ctxState; log.contexts += 1; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
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
}

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
