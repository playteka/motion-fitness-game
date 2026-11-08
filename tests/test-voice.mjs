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

import { createVoiceSession, VOICE_STATES } from '../src/voice/session.js';
import { createLlm } from '../src/voice/providers.js';
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
  ok('没有 speechSynthesis：仍然进入 speaking（字幕在），并安排一个展示计时',
    s2.snapshot().state === 'speaking' && timers.length === 1 && timers[0].ms >= 1200,
    JSON.stringify({ state: s2.snapshot().state, timers: timers.map((x) => x.ms) }));
  timers[0].fn();
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

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
