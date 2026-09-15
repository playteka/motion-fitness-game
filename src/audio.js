/**
 * 音效 + 语音播报（多语言）。
 * 全部使用浏览器内置能力（WebAudio / SpeechSynthesis），不依赖任何外部资源。
 *
 * 语音内容一律走 i18n 词条；数字直接交给 TTS 用对应语言朗读
 * （zh-CN / en-US / es-ES / fr-FR 都能正确读出阿拉伯数字）。
 */

import { t, getMeta } from './i18n.js';

/* ------------------------------------------------------------------ *
 * 背景音乐：**全部现场合成**，不依赖任何音频文件
 * ------------------------------------------------------------------ */

/** MIDI 音高 → 频率（A4 = 69 = 440Hz） */
export const mtof = (midi) => 440 * (2 ** ((midi - 69) / 12));

/**
 * 欢快的四小节循环：I–V–vi–IV（C–G–Am–F），132 BPM，带一点摇摆（swing）。
 * 每小节：跳跃的低音 + 明亮的主旋律 + 每小节开头的和弦点缀 + 底鼓/军鼓/踩镲（含切分），
 * 听起来是「轻快有推动力」的练习背景乐；音量仍然压在语音之下，念要领时还会自动降低。
 *
 * melody 是 8 个八分音符的音级偏移（相对 root + 12）；缺省时退回和弦琶音。
 */
export const MUSIC = {
  bpm: 132,
  swing: 0.16,   // 每对八分音符的第二个稍晚一点 → 更有律动
  bars: [
    { root: 48, notes: [0, 4, 7, 12, 7, 4, 7, 12], melody: [0, 0, 4, 0, 7, 4, 0, 2] },   // C
    { root: 43, notes: [0, 4, 7, 12, 7, 4, 7, 12], melody: [0, 4, 7, 4, 12, 7, 4, 0] },  // G
    { root: 45, notes: [0, 3, 7, 12, 7, 3, 7, 12], melody: [0, 3, 7, 3, 12, 7, 3, 0] },  // Am
    { root: 41, notes: [0, 4, 7, 12, 7, 4, 7, 12], melody: [0, 4, 7, 12, 9, 7, 4, 2] },  // F
  ],
};

/** 一个完整循环的所有音符事件（t 是相对循环起点的秒数），确定性输出，方便测试 */
export function musicEvents(music = MUSIC) {
  const beat = 60 / music.bpm;
  const swing = music.swing || 0;
  // 第 b 小节第 i 个八分音符落在第几拍（奇数位加摇摆偏移）
  const at = (b, i) => (b * 4 + (i >> 1) + ((i & 1) ? 0.5 + swing : 0)) * beat;
  const out = [];
  music.bars.forEach((bar, b) => {
    const mel = bar.melody || bar.notes;
    // 主旋律：8 个八分音符，明亮的三角波
    for (let i = 0; i < 8; i++) {
      out.push({
        t: at(b, i), kind: 'lead', freq: mtof(bar.root + 12 + mel[i % mel.length]),
        dur: beat * 0.38, gain: 0.075, type: 'triangle',
      });
    }
    // 低音：根音-根音-五音-五音的跳跃进行
    for (const [i, deg] of [[0, 0], [3, 0], [4, 7], [6, 7]]) {
      out.push({ t: at(b, i), kind: 'bass', freq: mtof(bar.root - 12 + deg), dur: beat * 0.5, gain: 0.1, type: 'sine' });
    }
    // 每小节开头一个明亮的和弦点缀（两个音）
    out.push({ t: at(b, 0), kind: 'stab', freq: mtof(bar.root + 12), dur: beat * 0.22, gain: 0.05, type: 'square' });
    out.push({ t: at(b, 0), kind: 'stab', freq: mtof(bar.root + 19), dur: beat * 0.22, gain: 0.035, type: 'square' });
    // 踩镲：每个八分音符，反拍更响一点 → 有推动力
    for (let i = 0; i < 8; i++) {
      out.push({ t: at(b, i), kind: 'hat', freq: 8200, dur: 0.022, gain: (i & 1) ? 0.028 : 0.016, type: 'square' });
    }
    // 底鼓：1、3 拍 + 第 2 拍后半的切分（这也是「活泼」的关键）
    for (const i of [0, 3, 4]) {
      out.push({ t: at(b, i), kind: 'kick', freq: 120, dur: 0.1, gain: 0.14, type: 'sine', slideTo: 58 });
    }
    // 军鼓：2、4 拍 + 第 4 拍后半的轻打
    for (const [i, g] of [[2, 0.055], [6, 0.055], [7, 0.025]]) {
      out.push({ t: at(b, i), kind: 'snare', freq: 2000, dur: 0.07, gain: g, type: 'triangle' });
    }
  });
  return out.sort((a, b) => a.t - b.t);
}

/** 一个循环的时长（秒） */
export function musicLoopSeconds(music = MUSIC) {
  return music.bars.length * 4 * (60 / music.bpm);
}

export class AudioKit {
  constructor() {
    this.ctx = null;
    this.sfxOn = true;
    this.voiceOn = true;
    this.musicOn = false;
    this.volume = 0.8;
    this._voice = null;
    this._speaking = false;
    this._speakingSince = 0;
    this._lastVoiceAt = 0;
    this._unlocked = false;
    // 背景音乐
    this._musicGain = null;
    this._musicTimer = null;
    this._musicLoopAt = 0;
    this.musicVolume = 0.3;       // 正常音量（要能明显听到，又不盖住语音）
    this.musicDuckVolume = 0.11;  // 念要领时压低
  }

  /* ---------- 基础 ---------- */

  /**
   * 解锁声音。可以重复调用（每次用户交互都调一次最稳）：
   * ensureCtx 只在必要时创建上下文、并在 suspended 时尝试 resume。
   */
  unlock() {
    this._unlocked = true;
    try { this.ensureCtx(); } catch { /* 音频上下文创建失败也不该影响别的声音逻辑 */ }
    try {
      if (typeof speechSynthesis !== 'undefined') {
        this.pickVoice();
        speechSynthesis.onvoiceschanged = () => this.pickVoice();
      }
    } catch { /* ignore */ }
  }

  /**
   * 声音自检信息（给诊断面板用）。
   * 用户说「没有声音」时，这两个值能立刻区分：是音频上下文没跑起来，还是系统里根本没有语音包。
   */
  state() {
    let ctx = 'none';
    try {
      if (this.ctx) ctx = this.ctx.state || 'unknown';
    } catch { ctx = 'unknown'; }
    let voices = 0;
    try {
      voices = (typeof speechSynthesis !== 'undefined' && speechSynthesis.getVoices?.() || []).length;
    } catch { voices = 0; }
    return {
      ctx, voices, voiceOn: !!this.voiceOn, sfxOn: !!this.sfxOn, unlocked: !!this._unlocked,
    };
  }

  ensureCtx() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** 挑选与当前语言匹配的系统语音，语言切换后需要重新调用 */
  pickVoice() {
    if (typeof speechSynthesis === 'undefined') return;
    const want = String(getMeta().speechLang || 'en-US').toLowerCase();
    const base = want.split('-')[0];
    const voices = speechSynthesis.getVoices?.() || [];
    this._voice = voices.find((v) => String(v.lang || '').toLowerCase() === want)
      || voices.find((v) => String(v.lang || '').toLowerCase().startsWith(base))
      || null;
  }

  /* ---------- 音效 ---------- */

  tone({ freq = 660, dur = 0.12, type = 'triangle', gain = 0.16, delay = 0, slideTo = null }) {
    if (!this.sfxOn) return;
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * this.volume), t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 计次音：按五声音阶递进，越练越有节奏感 */
  rep(index) {
    const scale = [523.25, 587.33, 659.25, 783.99, 880.0];
    const f = scale[(index - 1) % scale.length];
    this.tone({ freq: f, dur: 0.1, type: 'triangle', gain: 0.18 });
    this.tone({ freq: f * 2, dur: 0.06, type: 'sine', gain: 0.06, delay: 0.02 });
  }

  /** 要领得分音：第几步就响第几级音，像爬音阶一样给出“又对了一步”的反馈 */
  step(index = 0, total = 5) {
    const scale = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66];
    const i = Math.max(0, Math.min(index, scale.length - 1));
    const f = scale[i];
    const gain = 0.16 + 0.02 * Math.min(3, i);
    this.tone({ freq: f, dur: 0.13, type: 'triangle', gain });
    this.tone({ freq: f * 1.5, dur: 0.2, type: 'sine', gain: gain * 0.45, delay: 0.035 });
    if (index >= total - 1) {
      // 最后一步：补一个高八度，听起来像“这一步很关键”
      this.tone({ freq: f * 2, dur: 0.26, type: 'sine', gain: 0.1, delay: 0.09 });
    }
  }

  /** 整轮要领全部完成 */
  bonus() {
    [784, 988, 1319].forEach((f, i) => this.tone({ freq: f, dur: 0.2, type: 'triangle', gain: 0.16, delay: i * 0.08 }));
  }

  /** 计时类动作每秒的轻点，音量很小，只为“还在计分”的持续反馈 */
  scoreTick() {
    this.tone({ freq: 1320, dur: 0.035, type: 'sine', gain: 0.05 });
  }

  partial() {
    this.tone({ freq: 220, dur: 0.18, type: 'sawtooth', gain: 0.1, slideTo: 160 });
  }

  tick() { this.tone({ freq: 880, dur: 0.07, type: 'square', gain: 0.07 }); }
  go() { this.tone({ freq: 880, dur: 0.14, type: 'square', gain: 0.1 }); this.tone({ freq: 1320, dur: 0.22, type: 'triangle', gain: 0.12, delay: 0.12 }); }
  pause() { this.tone({ freq: 440, dur: 0.12, type: 'sine', gain: 0.1, slideTo: 300 }); }
  milestone() {
    [660, 880, 1100].forEach((f, i) => this.tone({ freq: f, dur: 0.16, type: 'triangle', gain: 0.14, delay: i * 0.09 }));
  }
  finish() {
    [523, 659, 784, 1046].forEach((f, i) => this.tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.16, delay: i * 0.12 }));
  }

  /* ---------- 语音 ---------- */

  say(text, { rate = 1.25, pitch = 1.05, force = false, minGapMs = 250 } = {}) {
    if (!this.voiceOn || typeof speechSynthesis === 'undefined' || !text) return;
    const now = performance.now();
    // 兜底：某些浏览器不会给「被 cancel 掉的那句」触发 onend，_speaking 会一直卡在 true，
    // 之后所有非 force 的提示（要领、报数）就全被丢掉 —— 表现就是「语音提示突然都没了」。
    // 这里用「开始说话的时间」做过期判断，超过 10 秒一律认为已经说完。
    if (this._speaking && now - (this._speakingSince || 0) > 10000) this._speaking = false;
    if (!force && now - this._lastVoiceAt < minGapMs) return;
    if (!force && this._speaking) return; // 不排队，只报最新的
    this._lastVoiceAt = now;
    const meta = getMeta();
    try {
      speechSynthesis.cancel();
      // cancel 之后立刻 speak 在 Chrome 上偶发「新的一句不响」，所以先复位状态、下一拍再 speak
      this._speaking = false;
      this._speakingSince = now;
      const u = new SpeechSynthesisUtterance(String(text));
      if (this._voice && this._voice.lang && String(this._voice.lang).toLowerCase().startsWith(meta.speechLang.split('-')[0])) {
        u.voice = this._voice;
      }
      u.lang = meta.speechLang || 'en-US';
      u.rate = rate;
      u.pitch = pitch;
      u.volume = this.volume;
      u.onstart = () => { this._speaking = true; this._speakingSince = performance.now(); };
      u.onend = () => { this._speaking = false; };
      u.onerror = () => { this._speaking = false; };
      setTimeout(() => { try { speechSynthesis.speak(u); } catch { this._speaking = false; } }, 0);
    } catch { this._speaking = false; }
  }

  /** 报数：数字交给 TTS，单位后缀随语言变化 */
  sayRep(n) {
    const suffix = t('speech.repSuffix');
    this.say(`${n} ${suffix}`.trim(), { rate: 1.35, minGapMs: 200 });
  }

  /** 报要领：只在每个要领第一次完成时念出来，避免刷屏 */
  sayStep(label) { this.say(label, { rate: 1.2, minGapMs: 2200 }); }

  /** 报分数 */
  sayScore(n) {
    const suffix = t('speech.scoreSuffix');
    this.say(`${n} ${suffix}`.trim(), { rate: 1.3, minGapMs: 1500, pitch: 1.15 });
  }

  /** 报计时时长 */
  sayTime(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const suffix = t('speech.secondSuffix');
    this.say(`${s} ${suffix}`.trim(), { rate: 1.15, force: true });
  }

  sayCountdown(n) { this.say(String(n), { rate: 1.1, force: true }); }
  sayStart() { this.say(t('speech.start'), { rate: 1.3, force: true }); }
  sayCue(text) { this.say(text, { rate: 1.15, minGapMs: 6000 }); }
  stopSpeech() { try { speechSynthesis.cancel(); } catch { /* ignore */ } }

  /* ---------- 背景音乐 ---------- */

  /** 开/关背景音乐（开关状态由界面维护） */
  setMusic(on) {
    this.musicOn = !!on;
    if (this.musicOn) this.startMusic();
    else this.stopMusic();
  }

  startMusic() {
    if (!this.musicOn || this._musicTimer) return;
    let ctx = null;
    try { ctx = this.ensureCtx(); } catch { ctx = null; }
    if (!ctx) return;   // 环境不支持 WebAudio：安静地不播，不影响其它功能
    try {
      this._musicGain = ctx.createGain();
      this._musicGain.gain.value = 0.0001;
      this._musicGain.connect(ctx.destination);
      this._musicLoopAt = ctx.currentTime + 0.15;
      this._pumpMusic();
      this._musicTimer = setInterval(() => this._pumpMusic(), 500);
      this._musicGain.gain.setTargetAtTime(this.musicVolume, ctx.currentTime, 0.8);  // 淡入
    } catch {
      this.stopMusic();
    }
  }

  stopMusic() {
    if (this._musicTimer) { clearInterval(this._musicTimer); this._musicTimer = null; }
    try {
      if (this._musicGain && this.ctx) {
        this._musicGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.15);  // 淡出
        const g = this._musicGain;
        setTimeout(() => { try { g.disconnect(); } catch { /* ignore */ } }, 400);
      }
    } catch { /* ignore */ }
    this._musicGain = null;
  }

  /** 提前把接下来的循环排进音频时间线（每次调用最多排 2 个循环，够稳又不会堆积） */
  _pumpMusic() {
    const ctx = this.ctx;
    if (!ctx || !this._musicGain) return;
    // 说话时压低音乐，念完再抬回来，保证语音听得清
    const target = this._speaking ? this.musicDuckVolume : this.musicVolume;
    try { this._musicGain.gain.setTargetAtTime(target, ctx.currentTime, 0.25); } catch { /* ignore */ }
    const loop = musicLoopSeconds();
    let guard = 0;
    while (this._musicLoopAt < ctx.currentTime + 2 && guard < 3) {
      for (const e of musicEvents()) this._playNote(e, this._musicLoopAt + e.t);
      this._musicLoopAt += loop;
      guard += 1;
    }
  }

  /** 排一个音符（音高、包络都现场算，不需要任何音频素材） */
  _playNote(e, at) {
    const ctx = this.ctx;
    if (!ctx || !this._musicGain) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = e.type || 'sine';
    osc.frequency.setValueAtTime(e.freq, at);
    if (e.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, e.slideTo), at + e.dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, e.gain), at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + e.dur);
    osc.connect(g).connect(this._musicGain);
    osc.start(at);
    osc.stop(at + e.dur + 0.03);
  }
}
