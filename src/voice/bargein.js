/**
 * 插话打断（barge-in）状态机（P3.4）。
 *
 * 用户要求：「教练说话时仍然在听，我直接插一句话就能把它止住。」
 * 难点不在「停」，而在**别误触发**：麦克风会收到教练自己的声音、环境噪声、ASR 的抖动。
 * 所以触发条件是**三件事同时成立**（缺一不可）：
 *
 *   1. 教练正在说话（`isPlaying()`）；
 *   2. 设置里「允许插话打断」开着（默认开）；
 *   3. **连续 2 个 partial**，间隔 `< 600ms`，文本长度 `>= 2`，而且
 *      **麦克风 RMS 超过阈值**（播放期阈值比平时高：`0.30` vs `0.18`，
 *      正好用来挡掉「教练自己的声音」—— 外放时它到不了 0.30，用户凑近说才到）。
 *
 * 触发后**同步**做三件事（同一 tick，实测耗时 ≤ 150ms）：
 *   `stop()`（= 停播放 + abort 流式请求 + 释放解码队列 / blob URL）→ `onInterrupt()`
 *   （会话层切回 listening）→ 记 `tts:barge-in {ms}`（ms = 距第一个 partial 的毫秒数）。
 *
 * 纯逻辑 + 全部依赖注入（`stop` / `isPlaying` / `getLevel` / `now` / `diag`），
 * 所以 tests/test-voice.mjs 用假时钟就能断言「什么时候该打断、什么时候不该」。
 */

/** 两个 partial 的最大间隔（超过就不算「连续」） */
export const BARGE_IN_WINDOW_MS = 600;
/** partial 至少要这么长（1 个字的「嗯」「啊」不算插话） */
export const BARGE_IN_MIN_CHARS = 2;
/** 平时（聆听时）的麦克风 RMS 阈值 */
export const BARGE_IN_LEVEL = 0.18;
/** 播放期的麦克风 RMS 阈值：**比平时高**，否则外放的教练声音会把自己打断 */
export const BARGE_IN_PLAYBACK_LEVEL = 0.30;
/** 触发后必须在这段时间内真的静音（用户口径） */
export const BARGE_IN_MAX_LATENCY_MS = 150;

/**
 * 创建插话打断控制器。
 *
 * @param {object}   [opts]
 * @param {Function} [opts.stop]         停掉当前这句（tts.stop：停播放 + abort 流式请求 + 释放缓冲）
 * @param {Function} [opts.isPlaying]    教练现在是不是在说话
 * @param {Function} [opts.getLevel]     当前麦克风 RMS（0~1；来自 createVuMeter 的 readLevel）
 * @param {Function} [opts.enabled]      设置里「允许插话打断」是否开着
 * @param {Function} [opts.onInterrupt]  打断成功后通知会话层（切回 listening）
 * @param {object}   [opts.diag]         诊断收集器（record('tts:barge-in', { ms })）
 * @param {Function} [opts.now]          注入时钟（测试用假时钟）
 * @param {number}   [opts.windowMs]     连续 partial 的最大间隔
 * @param {number}   [opts.minChars]     partial 最小长度
 * @param {number}   [opts.levelThreshold] 聆听期阈值
 * @param {number}   [opts.playbackLevel] 播放期阈值（必须 ≥ 聆听期阈值）
 */
export function createBargeIn({
  stop = null,
  isPlaying = null,
  getLevel = null,
  enabled = null,
  onInterrupt = null,
  diag = null,
  now = () => Date.now(),
  windowMs = BARGE_IN_WINDOW_MS,
  minChars = BARGE_IN_MIN_CHARS,
  levelThreshold = BARGE_IN_LEVEL,
  playbackLevel = BARGE_IN_PLAYBACK_LEVEL,
} = {}) {
  const windowLimit = Math.max(1, Number(windowMs) || BARGE_IN_WINDOW_MS);
  const minLength = Math.max(1, Math.floor(Number(minChars) || BARGE_IN_MIN_CHARS));
  const quietLevel = Math.min(1, Math.max(0, Number(levelThreshold) || BARGE_IN_LEVEL));
  const playingLevel = Math.min(1, Math.max(quietLevel, Number(playbackLevel) || BARGE_IN_PLAYBACK_LEVEL));
  /** 上一个**合格**的 partial：{ at, text } */
  let last = null;
  let triggers = 0;

  function skip(reason, extra = {}) {
    return { triggered: false, reason, ...extra };
  }

  /**
   * 喂一个 ASR partial。
   *
   * @param {string} text
   * @param {object} [info] `{ level, at }`；level 不传就从 `getLevel()` 读
   * @returns {{triggered:boolean, reason?:string, ms?:number, sinceTriggerMs?:number, threshold?:number}}
   */
  function onPartial(text, { level = null, at = null } = {}) {
    const body = String(text == null ? '' : text).trim();
    const hasAt = at !== null && at !== undefined && Number.isFinite(Number(at));
    const atMs = hasAt ? Number(at) : Number(now()) || 0;
    const playing = typeof isPlaying === 'function' ? !!isPlaying() : false;

    // 没在说话：不需要打断，也顺手清掉上一次的「第一个 partial」（避免下一句刚开始就被旧记录触发）
    if (!playing) {
      last = null;
      return skip('not-playing', { at: atMs });
    }
    if (typeof enabled === 'function' && !enabled()) {
      last = null;
      return skip('disabled', { at: atMs });
    }
    if (!body || body.length < minLength) {
      // 太短（「嗯」「啊」）不算插话；不清掉上一个，免得一句话被拆成两段就漏判
      return skip('too-short', { at: atMs, chars: body.length });
    }

    const raw = level === null || level === undefined ? (typeof getLevel === 'function' ? getLevel() : 0) : level;
    const levelValue = Math.max(0, Math.min(1, Number(raw) || 0));
    const threshold = playingLevel;   // 触发只发生在播放期，用「更高」的那一档
    if (levelValue < threshold) {
      // 能量低（像教练自己的声音 / 环境噪声）→ 这一次不算，配对也作废
      last = null;
      return skip('quiet', { at: atMs, level: levelValue, threshold });
    }

    if (last) {
      const gap = atMs - last.at;
      if (gap >= 0 && gap <= windowLimit) {
        const first = last;
        last = null;
        const fromFirst = Math.max(0, atMs - first.at);
        const t0 = Number(now()) || 0;
        try { stop?.(); } catch { /* 停不下来也必须继续切状态 */ }
        const sinceTrigger = Math.max(0, (Number(now()) || t0) - t0);
        triggers += 1;
        diag?.record?.('tts:barge-in', {
          ms: Math.round(fromFirst),
          stopMs: Math.round(sinceTrigger),
          chars: body.length,
          level: Math.round(levelValue * 100) / 100,
          threshold,
        });
        try {
          onInterrupt?.({ at: atMs, firstAt: first.at, text: body, ms: fromFirst });
        } catch { /* 状态机出错不该影响「已经静音」这件事 */ }
        return {
          triggered: true,
          ms: fromFirst,
          sinceTriggerMs: sinceTrigger,
          sinceFirstMs: fromFirst,
          threshold,
        };
      }
    }
    last = { at: atMs, text: body };
    return skip('first', { at: atMs, level: levelValue, threshold });
  }

  /** 清掉配对记录（正常说完 / 关闭教练 / 重新开始聆听时调用） */
  function reset() {
    last = null;
    return api;
  }

  const api = {
    kind: 'barge-in',
    onPartial,
    reset,
    get triggers() { return triggers; },
    get pending() { return last ? { ...last } : null; },
    get windowMs() { return windowLimit; },
    get minChars() { return minLength; },
    get levelThreshold() { return quietLevel; },
    get playbackLevel() { return playingLevel; },
    get maxLatencyMs() { return BARGE_IN_MAX_LATENCY_MS; },
  };
  return api;
}

export default {
  createBargeIn,
  BARGE_IN_WINDOW_MS,
  BARGE_IN_MIN_CHARS,
  BARGE_IN_LEVEL,
  BARGE_IN_PLAYBACK_LEVEL,
  BARGE_IN_MAX_LATENCY_MS,
};
