/**
 * AI 语音教练的**会话状态机**（P3.0 基座）。
 *
 * 状态只有五个：
 *
 *      off ──start()──▶ listening ──onUserText()──▶ thinking ──onCoachText()──▶ speaking
 *       ▲                   │                                              │
 *       │                   └────────────── TTS 结束 / 无 TTS 的超时 ────────┘
 *       │                                                                  │
 *       └──────────────────────── stop()（任意状态）◀──────────────────────┘
 *
 * 另外：
 *   - `pause()` / `resume()`：页面隐藏时暂停聆听，回到前台再恢复（不释放麦克风，避免重复授权）；
 *   - `fail()`：麦克风被拒 / ASR 不支持 / LLM 出错 → `error`（`stop()` 或重新 `start()` 都能离开）；
 *   - 对外只有纯对象 / 纯函数（`snapshot()` / `subscribe()`），**不碰任何 DOM**，
 *     所以 Node 里可以直接跑测试（见 tests/test-voice.mjs）。
 *
 * 依赖全部注入：`mic` / `asr` / `tts` 来自 providers.js（P3.1 / P3.3 / P3.4 换实现即可），
 * `llm` 的 `reply()` 同步或 Promise 都支持。
 */

export const VOICE_STATES = Object.freeze(['off', 'listening', 'thinking', 'speaking', 'error']);

/** 状态机的错误码 → 界面文案键（coach.js 用；测试也读同一份） */
export const VOICE_ERROR_KEYS = Object.freeze({
  mic: 'coach.error.mic',
  'mic-unsupported': 'coach.error.mic',
  'mic-empty': 'coach.error.mic',
  'mic-busy': 'coach.error.micBusy',
  'asr-unsupported': 'coach.error.unsupported',
  'asr-service': 'coach.error.service',
  'asr-language': 'coach.error.language',
  asr: 'coach.error.asr',
  llm: 'coach.error.llm',
  generic: 'coach.error.generic',
});

/**
 * 非致命的**提示**（不落 error 状态，只是字幕面板上多一行）：
 * 识别没跑起来 / 网络连不上 / 没听到声音 / 识别被中断。
 * 用户反馈「说话没字幕」里最难受的正是这种情况：状态一直「聆听」，但什么都没说。
 */
export const VOICE_NOTICE_KEYS = Object.freeze({
  network: 'coach.notice.network',
  'no-speech': 'coach.notice.noSpeech',
  'no-result': 'coach.notice.noResult',
  aborted: 'coach.notice.aborted',
  asr: 'coach.notice.asr',
});

/** 进入 listening 后多久没听到任何 interim / final 就提示「没听到声音」 */
export const VOICE_SILENCE_MS = 8000;

export function voiceErrorKey(code) {
  return VOICE_ERROR_KEYS[code] || VOICE_ERROR_KEYS.generic;
}

export function voiceNoticeKey(code) {
  return VOICE_NOTICE_KEYS[code] || VOICE_NOTICE_KEYS.asr;
}

/**
 * 创建会话。
 *
 * @param {object}   [opts]
 * @param {object}   [opts.mic]        麦克风适配器（open / close / active）
 * @param {object}   [opts.asr]        语音识别适配器（start / stop / onResult / onError / onInterim）
 * @param {object}   [opts.llm]        回复适配器（reply(text) → { text } | Promise）
 * @param {object}   [opts.tts]        语音合成适配器（speak / cancel / supported）
 * @param {number}   [opts.thinkDelay] 「思考中」至少停留多久（毫秒；0 = 同步，测试用）
 * @param {number}   [opts.silenceMs]  进入聆听后多久没结果就提示「没听到声音」（0 = 关闭）
 * @param {Function} [opts.setTimer]   可注入的 setTimeout（测试模拟时间用）
 * @param {Function} [opts.clearTimer] 可注入的 clearTimeout
 */
export function createVoiceSession({
  mic = null,
  asr = null,
  llm = null,
  tts = null,
  thinkDelay = 0,
  silenceMs = VOICE_SILENCE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let state = 'off';
  let enabled = false;
  let paused = false;
  let userText = '';
  let interimText = '';
  let coachText = '';
  let error = null;
  /** 非致命提示：{ code, at }（网络 / 没听到 / 中断），字幕面板会显示一行 */
  let notice = null;
  /** 最近一次 ASR 原始错误名（🐞 调试行显示；不会当文案用） */
  let lastError = '';
  /** 从进入 listening / 上次听到声音到现在的静音计时（8 秒无结果 → 提示「没听到声音」） */
  let silenceTimer = null;
  let silenceMsValue = Number.isFinite(Number(silenceMs)) ? Math.max(0, Number(silenceMs)) : VOICE_SILENCE_MS;
  /** 每次 start / stop / 新一轮对话都 +1；异步回调靠它判断「这一轮还算数吗」 */
  let epoch = 0;
  let thinkTimer = null;
  let speakTimer = null;
  const listeners = new Set();

  function snapshot() {
    return {
      state,
      enabled,
      paused,
      userText,
      interimText,
      coachText,
      error: error ? { ...error } : null,
      notice: notice ? { ...notice } : null,
      lastError,
    };
  }

  function emit() {
    const snap = snapshot();
    for (const fn of listeners) {
      try { fn(snap); } catch { /* 一个订阅者出错不该影响状态机 */ }
    }
    return snap;
  }

  function setState(next) {
    state = next;
    return emit();
  }

  function clearTimers() {
    if (thinkTimer !== null) { try { clearTimer(thinkTimer); } catch { /* ignore */ } thinkTimer = null; }
    if (speakTimer !== null) { try { clearTimer(speakTimer); } catch { /* ignore */ } speakTimer = null; }
  }

  /** 取消「没听到声音」的静音计时（离开聆听 / 已经听到声音时） */
  function clearSilence() {
    if (silenceTimer !== null) {
      try { clearTimer(silenceTimer); } catch { /* ignore */ }
      silenceTimer = null;
    }
  }

  /** 重新开始静音计时：8 秒内没有任何 interim / final → 面板上提示「没听到声音」（不自动关闭） */
  function armSilence() {
    clearSilence();
    if (!(silenceMsValue > 0) || !enabled || paused || state !== 'listening') return;
    silenceTimer = setTimer(() => {
      silenceTimer = null;
      if (!enabled || paused || state !== 'listening') return;
      // 已经有更具体的提示（网络异常 / 没听到声音 / 识别中断）就别盖掉它
      if (notice) return;
      notice = { code: 'no-result', at: Date.now() };
      emit();
    }, silenceMsValue);
  }

  /** 非致命提示：只更新字幕面板上那一行，不动状态机（error 才是致命） */
  function setNotice(code, extra = {}) {
    const next = code ? { code, at: Date.now(), ...extra } : null;
    if ((notice && notice.code) === (next && next.code)) return snapshot();
    notice = next;
    return emit();
  }

  function releaseAudio() {
    try { asr?.stop?.(); } catch { /* ignore */ }
    try { tts?.cancel?.(); } catch { /* ignore */ }
  }

  /**
   * 进入 error（麦克风拒绝 / ASR 不支持 / LLM 异常）。
   * 麦克风轨道在这里就释放掉：出错之后不该还留着后台录音。
   */
  function fail(code, err = null) {
    if (state === 'off') return snapshot();
    const raw = err && (err.raw || err.code);
    if (raw) lastError = String(raw);
    error = {
      code: code || 'generic',
      message: err && err.message ? String(err.message) : String(err || ''),
    };
    // 连续 3 次「网络错误」停手时，把「Chrome 语音识别要联网」那行提示留在面板上；
    // 其它致命错误（权限 / 麦被占）就不要再留着旧提示了。
    if (!(code === 'asr' && lastError === 'network')) notice = null;
    clearTimers();
    clearSilence();
    releaseAudio();
    try { mic?.close?.(); } catch { /* ignore */ }
    enabled = true;   // 用户的「开」这个意愿还在；settings.coachEnabled 由 app 同步
    return setState('error');
  }

  function finishSpeaking(myEpoch) {
    if (myEpoch !== epoch || !enabled || paused || state !== 'speaking') return;
    speakTimer = null;
    setState('listening');
    armSilence();
  }

  /** 说一句教练的话：先上字幕（speaking），TTS 结束 / 不可用时回到聆听 */
  function onCoachText(text, { speak = true } = {}) {
    const body = String(text == null ? '' : text).trim();
    if (!body || !enabled || state === 'off') return false;
    coachText = body;
    interimText = '';
    notice = null;
    clearSilence();
    // 打断上一句 TTS（P3.4 的打断也走这里）；**不要停 ASR** —— 说完还要继续听
    try { tts?.cancel?.(); } catch { /* ignore */ }
    const myEpoch = ++epoch;

    if (speak === false) {
      // 自我介绍 / 收尾这类「只显示不念」的台词：不占用 speaking 状态
      if (state === 'thinking') setState('listening'); else emit();
      if (state === 'listening') armSilence();
      return true;
    }

    setState('speaking');
    let spoke = false;
    try {
      spoke = tts ? tts.speak(body, {
        onEnd: () => finishSpeaking(myEpoch),
        onError: () => finishSpeaking(myEpoch),
      }) : false;
    } catch {
      spoke = false;
    }
    if (!spoke) {
      // 没有 speechSynthesis：只出字幕，留一段可读时间再回到聆听
      const hold = Math.max(1200, Math.min(6000, body.length * 160));
      speakTimer = setTimer(() => finishSpeaking(myEpoch), hold);
    }
    return true;
  }

  /** 识别到一句用户的话（最终结果才会推进状态；中间结果只更新字幕） */
  function onUserText(text, info = {}) {
    const body = String(text == null ? '' : text).trim();
    if (info && info.isFinal === false) {
      // 迟到的 interim 不能在 thinking / speaking 里把已经定稿的那句话盖掉
      if (state !== 'listening' || paused) {
        if ((info.clear === true || !body) && interimText) { interimText = ''; emit(); }
        return false;
      }
      if (info.clear === true || !body) {
        if (!interimText) return false;
        interimText = '';   // 识别器把临时结果收回了
        emit();
        return false;
      }
      interimText = body;
      notice = null;        // 听到声音了：清掉「网络异常 / 没听到声音」的提示
      emit();
      armSilence();         // 有结果就重新计时（不是「8 秒内一直没有结果」）
      return false;
    }
    if (!body) return false;
    if (!enabled || state !== 'listening' || paused) return false;
    userText = body;
    interimText = '';
    coachText = '';
    error = null;
    notice = null;
    clearSilence();
    setState('thinking');
    const myEpoch = ++epoch;

    const ask = () => {
      thinkTimer = null;
      if (myEpoch !== epoch || !enabled || paused) return;
      let reply;
      try {
        reply = llm ? llm.reply(body) : null;
      } catch (err) {
        fail('llm', err);
        return;
      }
      Promise.resolve(reply).then((res) => {
        if (myEpoch !== epoch || !enabled || paused) return;
        const answer = res && typeof res === 'object' ? res.text : res;
        if (!answer || !String(answer).trim()) {
          fail('llm');
          return;
        }
        onCoachText(String(answer));
      }).catch((err) => fail('llm', err));
    };

    if (thinkDelay > 0) thinkTimer = setTimer(ask, thinkDelay);
    else ask();
    return true;
  }

  /** 打开：先拿麦克风权限，再启动 ASR。失败落 error（不抛给调用方） */
  async function start() {
    if (enabled && state !== 'off' && state !== 'error') return snapshot();
    epoch += 1;
    clearTimers();
    clearSilence();
    enabled = true;
    paused = false;
    error = null;
    notice = null;
    userText = '';
    interimText = '';
    coachText = '';
    setState('listening');

    try {
      if (mic) await mic.open();
    } catch (err) {
      return fail('mic', err);
    }
    if (!enabled || state !== 'listening') {
      // 等权限的这几百毫秒里用户已经关掉了
      try { mic?.close?.(); } catch { /* ignore */ }
      return snapshot();
    }

    let started = true;
    try {
      started = asr ? asr.start() !== false : true;
    } catch {
      started = false;
    }
    if (!started) return fail('asr-unsupported');
    // 权限框可能开了很久：ASR 真正跑起来之后才开始算「8 秒没听到声音」
    armSilence();
    return snapshot();
  }

  /** 关闭：任意状态 → off；停 TTS、停识别、释放麦克风 */
  function stop() {
    epoch += 1;
    clearTimers();
    clearSilence();
    enabled = false;
    paused = false;
    releaseAudio();
    try { mic?.close?.(); } catch { /* ignore */ }
    userText = '';
    interimText = '';
    coachText = '';
    error = null;
    notice = null;
    state = 'off';
    return emit();
  }

  /** 页面隐藏：暂停聆听 / 停掉正在念的那句（麦克风保持，回到前台直接恢复） */
  function pause() {
    if (!enabled || state === 'off' || state === 'error' || paused) return snapshot();
    epoch += 1;
    clearTimers();
    clearSilence();
    releaseAudio();
    paused = true;
    notice = null;
    state = 'listening';
    return emit();
  }

  /** 回到前台：如果用户还开着，就重新开始聆听 */
  function resume() {
    if (!enabled || !paused || state === 'off' || state === 'error') return snapshot();
    paused = false;
    state = 'listening';
    emit();
    let started = true;
    try { started = asr ? asr.start() !== false : true; } catch { started = false; }
    if (!started) return fail('asr-unsupported');
    armSilence();
    return snapshot();
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function destroy() {
    stop();
    listeners.clear();
  }

  // 把适配器回调接到状态机上（P3.1 的流式 ASR 也照这个接）
  if (asr) {
    asr.onResult?.((text, info) => onUserText(text, info || { isFinal: true }));
    asr.onInterim?.((text, info) => onUserText(text, { ...(info || {}), isFinal: false }));
    asr.onError?.((err) => {
      const code = err && err.code ? err.code : 'asr';
      fail(code === 'unsupported' ? 'asr-unsupported' : code, err);
    });
    // 非致命错误（network / no-speech / aborted）：只上提示，不打断聆听
    asr.onNotice?.((info) => {
      if (!enabled || state === 'off' || state === 'error') return;
      if (info && info.raw) lastError = String(info.raw);
      setNotice((info && info.code) || 'asr', { raw: (info && info.raw) || '' });
    });
  }

  return {
    VOICE_STATES,
    start,
    stop,
    pause,
    resume,
    onUserText,
    onCoachText,
    fail,
    snapshot,
    subscribe,
    destroy,
    get state() { return state; },
    get enabled() { return enabled; },
    get paused() { return paused; },
    get error() { return error ? { ...error } : null; },
    get notice() { return notice ? { ...notice } : null; },
    get lastError() { return lastError; },
    /** 测试可以调小（甚至设 0 关掉）；运行时重新调会重开静音计时 */
    get silenceMs() { return silenceMsValue; },
    set silenceMs(ms) {
      const v = Number(ms);
      if (!Number.isFinite(v) || v < 0) return;
      silenceMsValue = v;
      if (state === 'listening' && enabled && !paused) armSilence();
    },
  };
}
