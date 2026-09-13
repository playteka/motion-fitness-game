/**
 * 音效 + 中文语音报数。
 * 全部使用浏览器内置能力（WebAudio / SpeechSynthesis），不依赖任何外部资源。
 */

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 0~99 的中文读法，交给语音引擎念出来更自然 */
export function cnNumber(n) {
  n = Math.round(n);
  if (n < 0) return String(n);
  if (n < 10) return CN_DIGITS[n];
  if (n < 20) return '十' + (n % 10 ? CN_DIGITS[n % 10] : '');
  if (n < 100) return CN_DIGITS[Math.floor(n / 10)] + '十' + (n % 10 ? CN_DIGITS[n % 10] : '');
  return String(n);
}

export function cnSeconds(ms) {
  const s = ms / 1000;
  if (s < 60) return `${cnNumber(Math.round(s))}秒`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${cnNumber(m)}分${r ? cnNumber(r) + '秒' : ''}`;
}

export class AudioKit {
  constructor() {
    this.ctx = null;
    this.sfxOn = true;
    this.voiceOn = true;
    this.volume = 0.8;
    this._voice = null;
    this._speaking = false;
    this._lastVoiceAt = 0;
    this._unlocked = false;
  }

  /* ---------- 基础 ---------- */

  unlock() {
    if (this._unlocked) return;
    this._unlocked = true;
    this.ensureCtx();
    if (typeof speechSynthesis !== 'undefined') {
      this.pickVoice();
      speechSynthesis.onvoiceschanged = () => this.pickVoice();
    }
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

  pickVoice() {
    const voices = speechSynthesis.getVoices?.() || [];
    this._voice = voices.find((v) => /zh[-_]CN/i.test(v.lang))
      || voices.find((v) => /^zh/i.test(v.lang))
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
    if (!force && now - this._lastVoiceAt < minGapMs) return;
    if (!force && this._speaking) return; // 不排队，只报最新的
    this._lastVoiceAt = now;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      if (this._voice) u.voice = this._voice;
      u.lang = 'zh-CN';
      u.rate = rate;
      u.pitch = pitch;
      u.volume = this.volume;
      u.onstart = () => { this._speaking = true; };
      u.onend = () => { this._speaking = false; };
      u.onerror = () => { this._speaking = false; };
      speechSynthesis.speak(u);
    } catch { /* 忽略语音异常 */ }
  }

  /** 报数：按次数说中文数字 */
  sayRep(n) { this.say(cnNumber(n) + '个', { rate: 1.35, minGapMs: 200 }); }
  /** 报要领：只在每个要领第一次完成时念出来，避免刷屏 */
  sayStep(label) { this.say(label, { rate: 1.2, minGapMs: 2200 }); }
  sayScore(n) { this.say(cnNumber(n) + '分', { rate: 1.3, minGapMs: 1500, pitch: 1.15 }); }
  sayCountdown(n) { this.say(cnNumber(n), { rate: 1.1, force: true }); }
  sayStart() { this.say('开始', { rate: 1.3, force: true }); }
  sayCue(text) { this.say(text, { rate: 1.15, minGapMs: 6000 }); }
  sayTime(ms) { this.say(cnSeconds(ms), { rate: 1.15, force: true }); }
  stopSpeech() { try { speechSynthesis.cancel(); } catch { /* ignore */ } }
}
