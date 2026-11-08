/**
 * AI 语音教练的界面层（P3.0 基座）。
 *
 * 只做三件事：
 *   1) **状态环**：舞台左下角一颗小圆环（和现有圆环同一套线条 / 深色底风格），
 *      聆听时缓慢呼吸、思考 / 说话 / 出错换颜色，关闭后灰掉；
 *   2) **字幕面板**：舞台底部两行（`你：…` / `教练：…`），`aria-live="polite"`，读屏会念；
 *   3) **教练头像 + 状态文字**：头像走 `icons.js` 的线条图标（`ui:coach`），状态文字在
 *      「聆听 / 思考 / 说话 / 出错」之间切换。
 *
 * 这里**不碰会话状态机**：app.js 把 `session.snapshot()` 交给 `render(state)`，
 * 所有文案走 locales（`coach.*` / `voice.*`），所以中英切换只要重新 render 一次。
 *
 * 版面（`coachLayout`，纯函数，测试直接断言）：
 *   - 宽屏：字幕面板在判定进度条**正上方**（底部留出 `--criteria-bar-h`）；
 *   - 窄屏（≤560px）：判定进度条已经让到圆环上方，字幕面板改贴**舞台底部**；
 *   - 两种情况下都**不压住** HUD 左栏、右上角两颗圆环、判定进度条与左下状态环。
 */

import { t } from '../i18n.js';
import { libIconSVG } from '../icons.js';
import { voiceErrorKey } from './session.js';

/** 状态 → 文案键（`voice.status.*`） */
export const COACH_STATUS_KEYS = Object.freeze({
  off: 'voice.status.off',
  listening: 'voice.status.listening',
  thinking: 'voice.status.thinking',
  speaking: 'voice.status.speaking',
  error: 'voice.status.error',
});

/** 状态 → 是否显示字幕面板（off 时只留灰掉的状态环） */
export const COACH_PANEL_STATES = Object.freeze(['listening', 'thinking', 'speaking', 'error']);

/**
 * 版面常量：**和 style.css 的这几个值一一对应**（测试同时核对两处）。
 * 改一处要跟着改另一处；这里给出的数只用于「不越界 / 不遮挡」的纯几何断言。
 */
export const COACH_LAYOUT = Object.freeze({
  panelMaxW: 560,
  panelMinW: 150,
  desktopBarBottom: 10,      // .criteria-bar { bottom: 10px }
  mobileBarBottomBase: 16,   // 窄屏 .criteria-bar { bottom: calc(16px + var(--ring-px) + 12px) }
  mobileBarGap: 12,
  panelGap: 8,
  panelHeight: 88,
  panelHeightSmall: 64,
  panelBottomInset: 12,      // 窄屏字幕面板贴底
  dockPx: 56,
  dockPxSmall: 48,
  dockInset: 12,
  hudTop: 16,
  hudLeft: 18,
  hudExtraH: 120,
  cornerInset: 18,
  cornerGap: 8,
});

/** 与 CSS 的 `--ring-px` 同一条 clamp；窄屏的两档覆盖也照着来 */
export function coachRingPx(w) {
  const width = Number(w) || 1280;
  if (width <= 560) return 72;
  if (width <= 720) return 84;
  return Math.round(Math.min(140, Math.max(104, width * 0.105)));
}

/** 与 `--criteria-bar-h`（图标高 + 35px）同一条：取各断点的**上限**，几何断言更保守 */
export function coachCriteriaBarH(w) {
  const width = Number(w) || 1280;
  if (width <= 560) return 77;   // 42 + 35
  if (width <= 820) return 87;   // 52 + 35
  return 95;                     // 60 + 35
}

/** 两个矩形（{left,right,top,bottom}）是否相交；共边不算遮挡 */
export function rectsOverlap(a, b) {
  if (!a || !b) return false;
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * 字幕面板 / 状态环 / 判定条 / HUD / 右上角圆环的几何（舞台像素坐标）。
 * 纯函数：不读 DOM，测试直接传 1280×720、560×320 等尺寸。
 */
export function coachLayout(size = {}, opts = {}) {
  const w = Math.max(1, Number(size.w) || 1280);
  const h = Math.max(1, Number(size.h) || 720);
  const ringPx = Number(opts.ringPx) || coachRingPx(w);
  const barH = Number(opts.criteriaBarH) || coachCriteriaBarH(w);
  const mobile = w <= 560;
  const dockPx = mobile ? COACH_LAYOUT.dockPxSmall : COACH_LAYOUT.dockPx;
  const side = COACH_LAYOUT.hudLeft + ringPx + COACH_LAYOUT.mobileBarGap;
  const barBottomY = mobile
    ? COACH_LAYOUT.mobileBarBottomBase + ringPx + COACH_LAYOUT.mobileBarGap
    : COACH_LAYOUT.desktopBarBottom;

  const panelWidth = Math.max(0, Math.min(COACH_LAYOUT.panelMaxW, w - 2 * side));
  const panelHeight = mobile ? COACH_LAYOUT.panelHeightSmall : COACH_LAYOUT.panelHeight;
  const panelLeft = (w - panelWidth) / 2;
  const panelBottom = mobile
    ? COACH_LAYOUT.panelBottomInset
    : barBottomY + barH + COACH_LAYOUT.panelGap;

  return {
    w,
    h,
    mobile,
    ringPx,
    barH,
    side,
    panel: {
      left: panelLeft,
      right: panelLeft + panelWidth,
      top: h - panelBottom - panelHeight,
      bottom: h - panelBottom,
      width: panelWidth,
      height: panelHeight,
    },
    dock: {
      left: COACH_LAYOUT.dockInset,
      right: COACH_LAYOUT.dockInset + dockPx,
      top: h - COACH_LAYOUT.dockInset - dockPx,
      bottom: h - COACH_LAYOUT.dockInset,
      size: dockPx,
    },
    hud: {
      left: COACH_LAYOUT.hudLeft,
      right: COACH_LAYOUT.hudLeft + ringPx,
      top: COACH_LAYOUT.hudTop,
      bottom: COACH_LAYOUT.hudTop + ringPx + COACH_LAYOUT.hudExtraH,
    },
    cornerExit: {
      left: w - COACH_LAYOUT.cornerInset - ringPx,
      right: w - COACH_LAYOUT.cornerInset,
      top: COACH_LAYOUT.hudTop,
      bottom: COACH_LAYOUT.hudTop + ringPx,
    },
    cornerSettings: {
      left: w - COACH_LAYOUT.cornerInset - ringPx,
      right: w - COACH_LAYOUT.cornerInset,
      top: COACH_LAYOUT.hudTop + ringPx + COACH_LAYOUT.cornerGap,
      bottom: COACH_LAYOUT.hudTop + ringPx + COACH_LAYOUT.cornerGap + ringPx,
    },
    criteria: {
      left: mobile ? 10 : side,
      right: mobile ? w - 10 : w - side,
      top: h - barBottomY - barH,
      bottom: h - barBottomY,
    },
  };
}

/** 状态文字（聆听 / 思考 / 说话 / 出错；暂停时单独一句） */
export function coachStatusKey(state, paused = false) {
  if (state === 'listening' && paused) return 'voice.status.paused';
  return COACH_STATUS_KEYS[state] || COACH_STATUS_KEYS.off;
}

/**
 * 创建界面控制器。
 *   mount()        缓存元素、放好线条图标（app.js 在 bindUI 里调一次）
 *   render(snap)   根据 session.snapshot() 更新状态环 / 字幕 / 状态文字
 *   destroy()      收起并清掉引用
 */
export function createCoach({ doc = null } = {}) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const $ = (id) => (d ? d.getElementById(id) : null);
  const el = {};
  let mounted = false;
  let everUsed = false;

  function mount() {
    if (mounted || !d) return api;
    for (const id of ['coachDock', 'coachRing', 'coachRingIcon', 'coachPanel', 'coachAvatar',
      'coachStatus', 'coachSubtitles', 'coachYouText', 'coachCoachText', 'coachHint']) {
      el[id] = $(id);
    }
    if (el.coachAvatar) el.coachAvatar.innerHTML = libIconSVG('ui:coach', 'ui-icon coach-avatar-icon');
    if (el.coachRingIcon) el.coachRingIcon.innerHTML = libIconSVG('ui:mic', 'ui-icon coach-mic-icon');
    mounted = true;
    return api;
  }

  function render(snap = {}) {
    if (!mounted) mount();
    const state = snap.state || 'off';
    const enabled = !!snap.enabled;
    if (enabled && state !== 'off') everUsed = true;
    const paused = !!snap.paused;
    const statusText = t(coachStatusKey(state, paused));
    const errorText = snap.error ? t(voiceErrorKey(snap.error.code)) : '';

    // 状态环：关闭后**灰掉但留着**（让用户看到「现在没在听」），刷新页面后才彻底不占地方
    if (el.coachDock) {
      const showDock = enabled || everUsed;
      el.coachDock.hidden = !showDock;
      el.coachDock.dataset.state = state;
      el.coachDock.setAttribute('aria-label', statusText);
      el.coachDock.setAttribute('title', statusText);
    }
    if (el.coachRing) el.coachRing.dataset.state = state;

    // 字幕面板：只在开启时出现；关闭时连字幕一起收起（状态环单独灰着）
    const showPanel = enabled && state !== 'off';
    if (el.coachPanel) {
      el.coachPanel.hidden = !showPanel;
      el.coachPanel.setAttribute('aria-label', t('coach.title'));
    }
    if (!showPanel) return api;

    const interim = String(snap.interimText || '').trim();
    const user = interim || String(snap.userText || '').trim();
    const coach = errorText
      || String(snap.coachText || '').trim()
      || (state === 'listening' ? t('coach.listeningHint') : statusText);
    if (el.coachStatus) el.coachStatus.textContent = statusText;
    if (el.coachYouText) el.coachYouText.textContent = user;
    if (el.coachCoachText) el.coachCoachText.textContent = coach;
    if (el.coachHint) el.coachHint.textContent = t('coach.hint');
    if (el.coachSubtitles) {
      el.coachSubtitles.setAttribute('aria-live', 'polite');
      el.coachSubtitles.setAttribute('aria-atomic', 'true');
    }
    return api;
  }

  function destroy() {
    if (el.coachPanel) el.coachPanel.hidden = true;
    if (el.coachDock) el.coachDock.hidden = true;
    everUsed = false;
    return api;
  }

  const api = { mount, render, destroy, get mounted() { return mounted; } };
  return api;
}
