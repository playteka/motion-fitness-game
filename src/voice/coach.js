/**
 * AI 语音教练的界面层（P3.0 基座）。
 *
 * 只做四件事：
 *   1) **状态环**：舞台左下角一颗小圆环（和现有圆环同一套线条 / 深色底风格），
 *      聆听时缓慢呼吸、思考 / 说话 / 出错换颜色，关闭后灰掉；
 *   2) **字幕面板**：舞台底部两行（`你：…` / `教练：…`），`aria-live="polite"`，读屏会念；
 *      外加一行**状态 / 错误提示**（网络异常、没听到声音、权限被拒…）——用户反馈
 *      「说话没字幕」时，最怕的就是界面对着一片安静什么也不说；
 *   3) **教练头像 + 状态文字**：头像走 `icons.js` 的线条图标（`ui:coach`），状态文字在
 *      「聆听 / 思考 / 说话 / 出错」之间切换；
 *   4) **音量表（VU）**：教练开启期间用**会话层那一条共享麦克风** + AnalyserNode 读音量，
 *      状态环按 level 变色（灰 → 青 → 薄荷亮绿）+ 轻微放大 / 发光；拿不到共享流时
 *      静默降级成「按状态呼吸」，绝不另开一路 getUserMedia。关闭教练时关 AudioContext。
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
import { voiceErrorKey, voiceNoticeKey } from './session.js';
import { createVuMeter, smoothLevel, levelToColor } from './providers.js';
import { EXPECTED_BYTES_PER_SEC } from './pcm.js';

/** 状态 → 文案键（`voice.status.*`） */
export const COACH_STATUS_KEYS = Object.freeze({
  off: 'voice.status.off',
  listening: 'voice.status.listening',
  thinking: 'voice.status.thinking',
  speaking: 'voice.status.speaking',
  error: 'voice.status.error',
});

/**
 * 识别走哪一路 → 字幕面板上的那行小字（`coach.route.*`）。
 * P3.1：默认「本机火山代理」，代理不可用时自动回退浏览器 Web Speech ——
 * 用户必须能一眼看出当前是哪一路，不然「没字幕」时根本不知道谁在识别。
 */
export const COACH_ROUTE_KEYS = Object.freeze({
  volc: 'coach.route.volc',
  webspeech: 'coach.route.webSpeech',
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
export function createCoach({ doc = null, win = null, vuFactory = null, diag = null, selfTest = null } = {}) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const w = win || (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {}));
  const $ = (id) => (d ? d.getElementById(id) : null);
  const el = {};
  let mounted = false;
  let everUsed = false;
  let debug = false;
  let lastSnap = {};
  /** 「诊断」小面板开着没有（独立于教练开关：教练关着也能看 / 自检） */
  let diagOpen = false;
  // ---- 音量表（VU）状态 ----
  let vu = null;
  let vuStarting = false;
  let vuFailed = false;
  let vuLogged = false;
  let vuRaf = null;
  let vuLevel = 0;
  let vuLastAt = 0;
  let vuActive = false;
  function queryMotion() {
    try { return w.matchMedia ? w.matchMedia('(prefers-reduced-motion: reduce)') : null; } catch { return null; }
  }
  let motionQuery = queryMotion();
  const reduceMotion = () => !!(motionQuery && motionQuery.matches);

  function mount() {
    if (mounted || !d) return api;
    for (const id of ['coachDock', 'coachRing', 'coachRingSvg', 'coachRingFill', 'coachRingIcon',
      'coachPanel', 'coachAvatar', 'coachStatus', 'coachSubtitles', 'coachYouText', 'coachCoachText',
      'coachNotice', 'coachRoute', 'coachHint', 'coachDiagBtn', 'coachDiag', 'coachDiagClose',
      'coachDiagRoute', 'coachDiagWs', 'coachDiagFrames', 'coachDiagRate', 'coachDiagResults',
      'coachDiagError', 'coachDiagMic', 'coachDiagWorklet', 'btnVoiceSelfTestPanel', 'coachSelfTestMic',
      'coachSelfTestWs', 'coachSelfTestSend', 'coachSelfTestResult', 'coachSelfTestVolume',
      'coachSelfTestResultText']) {
      el[id] = $(id);
    }
    if (el.coachAvatar) el.coachAvatar.innerHTML = libIconSVG('ui:coach', 'ui-icon coach-avatar-icon');
    if (el.coachRingIcon) el.coachRingIcon.innerHTML = libIconSVG('ui:mic', 'ui-icon coach-mic-icon');
    // 「诊断」的开关：教练面板里那颗小按钮 + 底部工具栏那颗，都走同一个入口
    el.coachDiagBtn?.addEventListener?.('click', () => toggleDiag());
    el.coachDiagClose?.addEventListener?.('click', () => closeDiag());
    el.btnVoiceSelfTestPanel?.addEventListener?.('click', () => runSelfTest());
    // 诊断面板随 diag / 自检的事件实时刷新（2 秒一批的落盘与 UI 是两条线，互不影响）
    diag?.subscribe?.(() => renderDiag());
    selfTest?.subscribe?.(() => renderDiag());
    mounted = true;
    renderDiag();
    return api;
  }

  /* ---------------- 音量表：开 / 关 / 每帧上色 ---------------- */
  function clearVuStyle() {
    if (el.coachRingFill) {
      el.coachRingFill.style.stroke = '';
      el.coachRingFill.style.opacity = '';
    }
    if (el.coachRing) {
      el.coachRing.style.transform = '';
      el.coachRing.style.boxShadow = '';
    }
    if (el.coachDock) el.coachDock.dataset.vu = vu ? 'active' : 'off';
  }

  function stopVu() {
    vuActive = false;
    vuLevel = 0;
    vuLastAt = 0;
    vuFailed = false;      // 下次开启教练时重新试一次（可能是暂时的「麦克风被占用」）
    if (vuRaf !== null && w.cancelAnimationFrame) {
      try { w.cancelAnimationFrame(vuRaf); } catch { /* ignore */ }
    }
    vuRaf = null;
    const meter = vu;
    vu = null;
    if (meter) {
      try { meter.close(); } catch { /* ignore */ }
    }
    clearVuStyle();
    return api;
  }

  function applyVuStyle(snap) {
    const listening = snap.state === 'listening' && !snap.paused && vuActive;
    if (!listening) { clearVuStyle(); return; }
    const color = levelToColor(vuLevel);
    const l = Math.max(0, Math.min(1, vuLevel));
    if (el.coachRingFill) {
      el.coachRingFill.style.stroke = color;
      el.coachRingFill.style.opacity = String(0.65 + 0.35 * l);
    }
    if (el.coachRing) {
      // 尊重 prefers-reduced-motion：只换颜色，不放大 / 不加发光
      if (reduceMotion() || l < 0.02) {
        el.coachRing.style.transform = '';
        el.coachRing.style.boxShadow = '';
      } else {
        el.coachRing.style.transform = `scale(${(1 + 0.10 * l).toFixed(3)})`;
        el.coachRing.style.boxShadow = `0 0 ${(6 + 18 * l).toFixed(1)}px ${color}66`;
      }
    }
  }

  function tickVu() {
    vuRaf = null;
    if (!vu) return;
    const now = (w.performance && typeof w.performance.now === 'function') ? w.performance.now() : Date.now();
    const dt = vuLastAt ? Math.min(200, Math.max(0, now - vuLastAt)) : 50;
    vuLastAt = now;
    vuLevel = smoothLevel(vuLevel, vu.readLevel(), dt);
    applyVuStyle(lastSnap || {});
    if (vu && typeof w.requestAnimationFrame === 'function') {
      vuRaf = w.requestAnimationFrame(tickVu);
    }
  }

  /**
   * 开共享麦克风做音量表（不再自己getUserMedia）。失败**绝不抛错**：静默降级成「按状态呼吸」，
   * 只在 console 记一条（例如回退 Web Speech 时麦克风已经交给识别器，这里本来就没有流）。
   */
  async function startVu() {
    if (vu || vuStarting || vuFailed || !d) return api;
    const factory = vuFactory || (() => (d && w ? createVuMeter({ win: w }) : null));
    vuStarting = true;
    motionQuery = queryMotion();   // 每次开启都重新读一次系统「减少动效」设置
    let meter = null;
    try {
      meter = factory();
      if (!meter) throw Object.assign(new Error('no VU meter'), { code: 'vu-unsupported' });
      await meter.open();
      if (!meter.active) throw Object.assign(new Error('VU meter inactive'), { code: 'vu-inactive' });
      // 等权限 / AudioContext 的这几百毫秒里用户可能已经把教练关了：别把麦克风留在后台
      if (!lastSnap || !lastSnap.enabled || lastSnap.state === 'off' || lastSnap.state === 'error') {
        try { meter.close(); } catch { /* ignore */ }
        return api;
      }
      vu = meter;
      vuActive = true;
      vuLevel = 0;
      vuLastAt = 0;
      if (el.coachDock) el.coachDock.dataset.vu = 'active';
      if (typeof w.requestAnimationFrame === 'function') vuRaf = w.requestAnimationFrame(tickVu);
    } catch (err) {
      vuFailed = true;
      try { meter?.close?.(); } catch { /* ignore */ }
      vu = null;
      vuActive = false;
      if (el.coachDock) el.coachDock.dataset.vu = 'off';
      if (!vuLogged) {
        vuLogged = true;
        try {
          w.console?.info?.('[voice] VU meter unavailable, using state animation:',
            (err && (err.code || err.message)) || err);
        } catch { /* ignore */ }
      }
    } finally {
      vuStarting = false;
    }
    return api;
  }

  /* ---------------- 诊断 / 语音自检（P3.5） ---------------- */

  function setText(id, value) {
    if (el[id]) el[id].textContent = String(value == null ? '' : value);
  }

  /** 底部工具栏那颗「语音自检」按钮：打开面板并跑四步（不依赖教练是否开启） */
  function runSelfTest() {
    diagOpen = true;
    renderDiag();
    return selfTest?.run?.();
  }

  function toggleDiag(force) {
    diagOpen = force === undefined ? !diagOpen : !!force;
    renderDiag();
    return api;
  }

  function closeDiag() {
    diagOpen = false;
    renderDiag();
    return api;
  }

  function workletText(snap) {
    const state = snap.worklet && snap.worklet.state;
    if (state === 'ok') return t('coach.diag.workletOk');
    if (state === 'fail') return t('coach.diag.workletFail');
    if (snap.capture === 'processor') return t('coach.diag.workletProcessor');
    return t('coach.diag.workletNone');
  }

  function renderSelfTest(snap = {}) {
    const names = {
      mic: t('coach.selfTest.step.mic'),
      ws: t('coach.selfTest.step.ws'),
      send: t('coach.selfTest.step.send'),
      result: t('coach.selfTest.step.result'),
    };
    const ids = ['mic', 'ws', 'send', 'result'];
    const fields = {
      mic: 'coachSelfTestMic',
      ws: 'coachSelfTestWs',
      send: 'coachSelfTestSend',
      result: 'coachSelfTestResult',
    };
    const steps = snap.steps || {};
    ids.forEach((id, i) => {
      const status = steps[id] || 'pending';
      setText(fields[id], t('coach.selfTest.line', {
        n: i + 1,
        name: names[id],
        status: t(`coach.selfTest.status.${status}`),
      }));
    });
    setText('coachSelfTestVolume', t('coach.selfTest.volumeValue', {
      level: snap.volume > 0 ? Number(snap.volume).toFixed(2) : '—',
    }));

    let resultText = '';
    const res = snap.result || {};
    if (res.text) {
      resultText = t('coach.selfTest.resultText', { kind: res.kind || '', text: res.text });
    } else if (res.code) {
      resultText = t('coach.selfTest.resultError', { code: res.code });
    } else if (snap.running) {
      resultText = t('coach.selfTest.status.running');
    } else if (snap.error) {
      resultText = t('coach.selfTest.failedAt', {
        step: names[snap.error.step] || snap.error.step || '',
        code: snap.error.code || '',
      });
    }
    setText('coachSelfTestResultText', resultText);
  }

  /** 画诊断面板（数据全部来自 diag.snapshot() / selfTest.snapshot()；这里不碰任何音频） */
  function renderDiag() {
    if (!el.coachDiag) return api;
    el.coachDiag.hidden = !diagOpen;
    if (el.coachDiagBtn) el.coachDiagBtn.setAttribute('aria-expanded', String(diagOpen));
    if (!diagOpen) return api;
    const snap = diag ? diag.snapshot() : null;
    if (snap) {
      const route = snap.route || t('coach.diag.none');
      setText('coachDiagRoute', route);
      let wsText = snap.ws && snap.ws.state ? snap.ws.state : t('coach.diag.none');
      if (snap.ws && snap.ws.state === 'closed' && snap.ws.code !== null) {
        wsText = `closed(${snap.ws.code})`;
      }
      setText('coachDiagWs', wsText);
      setText('coachDiagFrames', t('coach.diag.framesValue', {
        n: (snap.frames && snap.frames.n) || 0,
        bytes: (snap.frames && snap.frames.bytes) || 0,
      }));
      // 实时码率：正常 ≈32KB/s；明显偏低时这一行会直接暴露「发了很多帧、但每帧太小 / 采集没跟上」
      const frames = snap.frames || {};
      const expected = Number(frames.expected) || EXPECTED_BYTES_PER_SEC;
      setText('coachDiagRate', frames.bytesPerSec > 0
        ? t('coach.diag.rateValue', {
          rate: (Number(frames.bytesPerSec) / 1000).toFixed(1),
          expected: (expected / 1000).toFixed(0),
        })
        : t('coach.diag.ratePending'));
      setText('coachDiagResults', t('coach.diag.resultsValue', {
        partial: snap.partials || 0,
        final: snap.finals || 0,
      }));
      setText('coachDiagError', snap.lastError || t('coach.diag.none'));
      setText('coachDiagMic', t('coach.diag.micValue', {
        tracks: (snap.mic && snap.mic.tracks) || 0,
        state: (snap.audio && snap.audio.state) || '—',
      }));
      setText('coachDiagWorklet', workletText(snap));
    }
    if (selfTest) renderSelfTest(selfTest.snapshot());
    return api;
  }

  function render(snap = {}) {
    if (!mounted) mount();
    lastSnap = snap;
    renderDiag();   // 诊断面板独立于教练开关：教练关着 / 面板收起时也要保持最新
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

    // 关闭 / 出错时把音量表释放掉（共享音轨由 createMic 统一 stop，绝不留后台录音）
    if (!enabled || state === 'off' || state === 'error') stopVu();

    // 字幕面板：只在开启时出现；关闭时连字幕一起收起（状态环单独灰着）
    const showPanel = enabled && state !== 'off';
    if (el.coachPanel) {
      el.coachPanel.hidden = !showPanel;
      el.coachPanel.setAttribute('aria-label', t('coach.title'));
    }
    if (!showPanel) {
      // 面板收起时把「识别走哪一路」也一起收掉（下次打开重新按当前路由填）
      if (el.coachRoute) {
        el.coachRoute.hidden = true;
        el.coachRoute.textContent = '';
      }
      return api;
    }

    const interim = String(snap.interimText || '').trim();
    const user = interim || String(snap.userText || '').trim();
    const coach = errorText
      || String(snap.coachText || '').trim()
      || (state === 'listening' ? t('coach.listeningHint') : statusText);

    // 状态 / 错误提示行：网络异常、没听到声音、识别被中断……
    // debug 模式追加**最后一个原始 ASR 错误名**（例如 network / not-allowed）
    const noticeCode = snap.notice && snap.notice.code;
    const noticeRaw = (snap.notice && snap.notice.raw) || noticeCode;
    let noticeText = noticeCode ? t(voiceNoticeKey(noticeCode), { code: noticeRaw }) : '';
    if (debug && snap.lastError) {
      const tag = `\u{1F41E} ${snap.lastError}`;   // 小虫子 emoji（用转义写，源码里不留 emoji）
      noticeText = noticeText ? `${noticeText} · ${tag}` : tag;
    }

    if (el.coachStatus) el.coachStatus.textContent = statusText;
    if (el.coachYouText) el.coachYouText.textContent = user;
    if (el.coachCoachText) el.coachCoachText.textContent = coach;
    // 识别走的是哪一路（火山代理 / 浏览器自带）——P3.1 的排障入口
    if (el.coachRoute) {
      const routeKey = COACH_ROUTE_KEYS[snap.route];
      const routeText = routeKey ? t(routeKey) : '';
      el.coachRoute.hidden = !routeText;
      el.coachRoute.textContent = routeText;
    }
    if (el.coachNotice) {
      el.coachNotice.hidden = !noticeText;
      el.coachNotice.textContent = noticeText;
    }
    if (el.coachHint) el.coachHint.textContent = t('coach.hint');
    if (el.coachSubtitles) {
      el.coachSubtitles.setAttribute('aria-live', 'polite');
      el.coachSubtitles.setAttribute('aria-atomic', 'true');
    }
    // 状态变化后马上按新状态上色（VU 每帧也会再调一次）
    applyVuStyle(snap);
    return api;
  }

  function setDebug(on) {
    debug = !!on;
    return api;
  }

  function destroy() {
    stopVu();
    diagOpen = false;
    if (el.coachDiag) el.coachDiag.hidden = true;
    if (el.coachPanel) el.coachPanel.hidden = true;
    if (el.coachDock) el.coachDock.hidden = true;
    everUsed = false;
    return api;
  }

  const api = {
    mount,
    render,
    destroy,
    setDebug,
    startVu,
    stopVu,
    toggleDiag,
    closeDiag,
    renderDiag,
    runSelfTest,
    get mounted() { return mounted; },
    get vuActive() { return vuActive; },
    get vuLevel() { return vuLevel; },
    get diagOpen() { return diagOpen; },
  };
  return api;
}
