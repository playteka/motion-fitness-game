/**
 * 音效 + 语音播报（多语言）。
 * 全部使用浏览器内置能力（WebAudio / SpeechSynthesis），不依赖任何外部资源。
 *
 * 语音内容一律走 i18n 词条；数字直接交给 TTS 用对应语言朗读
 * （zh-CN / en-US / es-ES / fr-FR 都能正确读出阿拉伯数字）。
 */

import { t, getMeta } from './i18n.js';

export class AudioKit {
  constructor() {
    this.ctx = null;
    this.sfxOn = true;
    this.voiceOn = true;
    this.volume = 0.8;
    this._voice = null;
    this._speaking = false;
    this._speakingSince = 0;
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
}
