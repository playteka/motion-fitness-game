/**
 * 音效 + 语音播报（多语言）。
 * 全部使用浏览器内置能力（WebAudio / SpeechSynthesis），不依赖任何外部资源。
 *
 * 语音内容一律走 i18n 词条；数字直接交给 TTS 用对应语言朗读
 * （zh-CN / en-US 都能正确读出阿拉伯数字）。
 */

import { t, getMeta } from './i18n.js';

/* ------------------------------------------------------------------ *
 * 背景音乐：**全部现场合成**，不依赖任何音频文件
 * ------------------------------------------------------------------ */

/** MIDI 音高 → 频率（A4 = 69 = 440Hz） */
export const mtof = (midi) => 440 * (2 ** ((midi - 69) / 12));

/**
 * 背景音乐：4 首风格不同的循环曲，用户可以自己挑（设置弹窗里选）。
 *
 * 每首曲子由四小节组成，全部是**现场合成**（不需要音频文件、不联网）：
 *   progression 每小节的和弦根音（MIDI）与和弦性质
 *   drums      鼓组图案，写在 16 分音符网格上（0 是这一小节第 1 拍的第 1 个 16 分）
 *   bass       贝斯：每个音 [16分位置, 相对根音的半音数, 持续几个 16 分]
 *   lead       主旋律 / 和弦点缀，同上
 * 节奏感靠三件事拉开：
 *   ① 底鼓与军鼓的重音位置（four-on-the-floor / 摇滚 / 放克各不同）
 *   ② 反拍开镲与拍手（clap）—— 这是「跟着动起来」的关键
 *   ③ 贝斯的切分（funk 与四踩的差别主要在这里）
 *
 * 音色也都是合成的：底鼓是下滑正弦 + 点击声，军鼓/拍手是噪声音爆，踩镲是高通噪声。
 */
export const TRACKS = [
  {
    id: 'cityRun',
    bpm: 132,
    swing: 0.16,          // 每对八分音符的第二个稍晚一点 → 摇摆的跳跃感
    nameKey: 'music.track.cityRun',
    progression: [
      { root: 48, type: 'maj' },   // C
      { root: 43, type: 'maj' },   // G
      { root: 45, type: 'min' },   // Am
      { root: 41, type: 'maj' },   // F
    ],
    drums: {
      kick: [0, 4, 10],
      snare: [4, 12],
      hat: [0, 2, 4, 6, 8, 10, 12, 14],
      hatAccent: [2, 6, 10, 14],
      clap: [12],
    },
    bass: [[0, 0], [4, 0], [6, 7], [10, 7], [12, 12]],
    lead: [[0, 0], [2, 4], [4, 7], [6, 12], [8, 7], [10, 4], [12, 7], [14, 12]],
    leadType: 'triangle',
  },
  {
    id: 'neonPulse',
    bpm: 144,
    swing: 0,
    nameKey: 'music.track.neonPulse',
    progression: [
      { root: 45, type: 'min' },   // Am
      { root: 41, type: 'maj' },   // F
      { root: 48, type: 'maj' },   // C
      { root: 43, type: 'maj' },   // G
    ],
    drums: {
      // 四踩（每拍一记底鼓）+ 反拍开镲：电子舞曲的推进感
      kick: [0, 4, 8, 12],
      snare: [4, 12],
      hat: [2, 6, 10, 14],
      hatAccent: [6, 14],
      clap: [4, 12],
    },
    bass: [[0, 0], [3, 0], [6, 12], [8, 7], [11, 7], [14, 10]],
    lead: [[2, 12], [6, 7], [10, 12], [14, 15]],
    leadType: 'square',
  },
  {
    id: 'sunriseFunk',
    bpm: 122,
    swing: 0.22,
    nameKey: 'music.track.sunriseFunk',
    progression: [
      { root: 50, type: 'min' },   // Dm
      { root: 43, type: 'maj' },   // G
      { root: 48, type: 'maj' },   // C
      { root: 45, type: 'maj' },   // A
    ],
    drums: {
      // 放克：底鼓切分 + 军鼓重拍 + 幽灵音 + 密集 16 分踩镲
      kick: [0, 3, 6, 10],
      snare: [4, 12],
      ghost: [7, 15],
      hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      hatAccent: [2, 6, 10, 14],
      clap: [12],
    },
    bass: [[0, 0], [3, 12], [6, 7], [9, 10], [12, 7], [14, 3]],
    lead: [[0, 0], [2, 3], [5, 7], [8, 10], [11, 7], [13, 3]],
    leadType: 'triangle',
  },
  {
    id: 'powerDrive',
    bpm: 152,
    swing: 0,
    nameKey: 'music.track.powerDrive',
    progression: [
      { root: 40, type: 'min' },   // Em
      { root: 48, type: 'maj' },   // C
      { root: 43, type: 'maj' },   // G
      { root: 50, type: 'maj' },   // D
    ],
    drums: {
      // 摇滚驱动：双底鼓「咚咚」+ 厚军鼓 + 每小节开头的镲片重击
      kick: [0, 2, 8, 10],
      snare: [4, 12],
      hat: [0, 2, 4, 6, 8, 10, 12, 14],
      hatAccent: [2, 6, 10, 14],
      clap: [0],
    },
    bass: [[0, 0], [2, 0], [4, 0], [6, 0], [8, 0], [10, 0], [12, 7], [14, 0]],
    lead: [[0, 12], [4, 12], [8, 19], [12, 15]],
    leadType: 'sawtooth',
  },
];

export const DEFAULT_TRACK = TRACKS[0].id;

/** 取某首曲子（给错 id 时退回默认，界面永远不会没音乐） */
export function getTrack(id) {
  return TRACKS.find((m) => m.id === id) || TRACKS[0];
}

/** 兼容旧名字：默认那首曲子 */
export const MUSIC = TRACKS[0];

/** 一个完整循环的所有音符事件（t 是相对循环起点的秒数），确定性输出，方便测试 */
export function musicEvents(track = MUSIC) {
  const music = typeof track === 'string' ? getTrack(track) : track;
  const beat = 60 / (music.bpm || 132);
  const step = beat / 4;                       // 一个 16 分音符
  const swing = music.swing || 0;
  // 第 b 小节第 s 个 16 分音符的时间：反拍八分（s % 4 === 2）整体后挪一点 → 摇摆感
  const at = (b, s) => (b * 4 + s / 4 + (swing && s % 4 === 2 ? swing : 0)) * beat;
  const out = [];
  music.progression.forEach((bar, b) => {
    const tones = bar.type === 'min' ? [0, 3, 7] : [0, 4, 7];
    // ---- 鼓组 ----
    for (const s of music.drums.kick || []) {
      out.push({ t: at(b, s), kind: 'kick', freq: 125, dur: 0.11, gain: 0.24, type: 'sine', slideTo: 52, noise: 'click' });
    }
    for (const s of music.drums.snare || []) {
      out.push({ t: at(b, s), kind: 'snare', freq: 210, dur: 0.13, gain: 0.15, type: 'triangle', noise: 'snare' });
    }
    for (const s of music.drums.ghost || []) {
      out.push({ t: at(b, s), kind: 'snare', freq: 210, dur: 0.06, gain: 0.05, type: 'triangle', noise: 'snare' });
    }
    for (const s of music.drums.hat || []) {
      const strong = (music.drums.hatAccent || []).includes(s);
      out.push({ t: at(b, s), kind: 'hat', freq: 9000, dur: strong ? 0.05 : 0.022, gain: strong ? 0.05 : 0.022, noise: 'hat' });
    }
    for (const s of music.drums.clap || []) {
      out.push({ t: at(b, s), kind: 'clap', freq: 1500, dur: 0.12, gain: 0.09, noise: 'clap' });
    }
    // ---- 贝斯 ----
    for (const [s, deg] of music.bass) {
      out.push({ t: at(b, s), kind: 'bass', freq: mtof(bar.root - 12 + deg), dur: step * 1.6, gain: 0.12, type: 'sine' });
    }
    // ---- 主旋律 ----
    for (const [s, deg] of music.lead) {
      out.push({ t: at(b, s), kind: 'lead', freq: mtof(bar.root + 12 + deg), dur: step * 2.2, gain: 0.07, type: music.leadType || 'triangle' });
    }
    // ---- 和弦点缀：每小节开头一个明亮的短和弦 ----
    for (const deg of [tones[0], tones[2]]) {
      out.push({ t: at(b, 0), kind: 'stab', freq: mtof(bar.root + 12 + deg), dur: step * 1.2, gain: 0.045, type: 'square' });
    }
  });
  return out.sort((a, b) => a.t - b.t);
}

/** 一个循环的时长（秒） */
export function musicLoopSeconds(track = MUSIC) {
  const music = typeof track === 'string' ? getTrack(track) : track;
  return music.progression.length * 4 * (60 / (music.bpm || 132));
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
    this._lastEncourage = '';   // 上一次说过的激励语（尽量不重复）
    this._unlocked = false;
    // 背景音乐
    this._musicGain = null;
    this._musicTimer = null;
    this._musicLoopAt = 0;
    this._trackId = DEFAULT_TRACK;   // 用户选的曲子（见 TRACKS）
    this._noise = null;              // 噪声缓冲（鼓组用，按需生成并复用）
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

  /**
   * 判定进度条前进一格：比「要领得分音」更轻的一声，逐级升高。
   * 和要领音可能同一帧一起响，所以音量压小、时值压短，避免叠在一起太吵。
   */
  criteria(index = 0, total = 4) {
    const scale = [659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51];
    const i = Math.max(0, Math.min(index, scale.length - 1));
    this.tone({ freq: scale[i], dur: 0.06, type: 'sine', gain: 0.085 });
    // 最后一格：补一个高八度，听起来像「这一轮判据全过了」
    if (index >= total - 1) this.tone({ freq: scale[i] * 2, dur: 0.16, type: 'sine', gain: 0.07, delay: 0.06 });
  }

  /** 整轮要领全部完成 */
  bonus() {    [784, 988, 1319].forEach((f, i) => this.tone({ freq: f, dur: 0.2, type: 'triangle', gain: 0.16, delay: i * 0.08 }));
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
  /**
   * 报数：**每做一个都念出来**（用户明确要求）。
   * 所以这里用 force 打断上一句 —— 否则「上一次报数还没念完」会把新的报数吞掉。
   */
  sayRep(n) {
    const suffix = t('speech.repSuffix');
    this.say(`${n} ${suffix}`.trim(), { rate: 1.4, force: true });
  }

  /**
   * 激励语：从当前语言的一组短句里轮着说，尽量不重复上一句。
   * 这是「以激励为主」的核心 —— 做得好要及时夸，而不是只挑毛病。
   */
  sayEncourage(seed = 0) {
    const pool = t('speech.encourage');
    const list = Array.isArray(pool) ? pool : [String(pool)];
    if (!list.length) return;
    const idx = Math.abs(Math.round(seed)) % list.length;
    const line = list[idx];
    if (line === this._lastEncourage) return;
    this._lastEncourage = line;
    this.say(line, { rate: 1.25, force: true, pitch: 1.12 });
  }

  /** 报要领：只在每个要领第一次完成时念出来，避免刷屏 */
  sayStep(label) { this.say(label, { rate: 1.2, minGapMs: 2200 }); }

  /**
   * 报计时时长（计时类动作的「5 秒 / 10 秒」）
   *
   * 注意：这里**故意没有「报分数」的方法** —— 用户明确要求「语音一律不报分数，只报次数和读秒」。
   * 分数只出现在屏幕上（HUD、结算面板、训练记录）；跨过 50 分时改念一句激励语（见 app.js 的 checkScoreMilestone）。
   */
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

  /** 当前选的是哪首曲子（id） */
  get trackId() { return this._trackId || DEFAULT_TRACK; }
  get track() { return getTrack(this.trackId); }

  /**
   * 选曲子。正在播的话立刻换成新曲子（不用先关再开）。
   * @param {string} id TRACKS 里的 id
   */
  setTrack(id) {
    const next = getTrack(id).id;
    if (next === this.trackId) return this.trackId;
    this._trackId = next;
    if (this.musicOn && this._musicGain) {
      // 换曲：停掉旧的、等淡出后从头开始播新的
      const wasOn = this.musicOn;
      this.stopMusic();
      setTimeout(() => { if (wasOn && this.musicOn) this.startMusic(); }, 240);
    }
    return next;
  }

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
    const track = this.track;
    const loop = musicLoopSeconds(track);
    let guard = 0;
    while (this._musicLoopAt < ctx.currentTime + 2 && guard < 3) {
      for (const e of musicEvents(track)) this._playNote(e, this._musicLoopAt + e.t);
      this._musicLoopAt += loop;
      guard += 1;
    }
  }

  /** 噪声缓冲（鼓组的军鼓/踩镲/拍手都用它，只需要生成一次） */
  _noiseBuffer(ctx) {
    if (this._noise) return this._noise;
    const len = Math.floor(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this._noise = buf;
    return buf;
  }

  /**
   * 噪声类鼓声：踩镲（高通、极短）、军鼓（噪声 + 一点音高）、拍手（三次短噪声音爆）。
   * 全部现场合成，不需要任何音频素材。
   */
  _playNoise(e, at) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    const g = ctx.createGain();
    if (e.noise === 'hat') {
      filter.type = 'highpass';
      filter.frequency.setValueAtTime(7000, at);
      g.gain.setValueAtTime(Math.max(0.0002, e.gain), at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + e.dur);
    } else if (e.noise === 'snare') {
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1800, at);
      filter.Q.value = 0.8;
      g.gain.setValueAtTime(Math.max(0.0002, e.gain), at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + e.dur);
    } else if (e.noise === 'clap') {
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1100, at);
      filter.Q.value = 1.2;
      // 三次快拍 → 听起来像拍手，而不是一团噪声
      for (const [off, gg] of [[0, 1], [0.012, 0.7], [0.026, 0.45]]) {
        g.gain.setValueAtTime(Math.max(0.0002, e.gain * gg), at + off);
        g.gain.exponentialRampToValueAtTime(0.0001, at + off + 0.03);
      }
    } else {   // click：给底鼓起音加一点「啪」的瞬态
      filter.type = 'highpass';
      filter.frequency.setValueAtTime(2500, at);
      g.gain.setValueAtTime(Math.max(0.0002, e.gain), at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.02);
    }
    src.connect(filter).connect(g).connect(this._musicGain);
    src.start(at, Math.random() * 0.2, e.dur + 0.05);
    src.stop(at + e.dur + 0.08);
  }

  /** 排一个音符（音高、包络都现场算，不需要任何音频素材） */
  _playNote(e, at) {
    const ctx = this.ctx;
    if (!ctx || !this._musicGain) return;
    if (e.noise) this._playNoise(e, at);
    // 纯噪声的打击乐（踩镲 / 拍手）到这里就结束了
    if (e.kind === 'hat' || e.kind === 'clap') return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = e.type || 'sine';
    osc.frequency.setValueAtTime(e.freq, at);
    if (e.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, e.slideTo), at + e.dur);
    // 军鼓是「噪声 + 一点音高」，所以振荡器音量压低，主体交给噪声
    const peak = e.kind === 'snare' ? e.gain * 0.5 : e.gain;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + e.dur);
    osc.connect(g).connect(this._musicGain);
    osc.start(at);
    osc.stop(at + e.dur + 0.03);
  }
}
