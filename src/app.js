/**
 * 应用主逻辑：摄像头 → 姿态识别 → 指标 → 动作判定 → 界面/语音反馈。
 * 界面文案全部走 i18n（src/locales/*.js），支持中文 / 英文。
 */

import {
  EXERCISES, EXERCISE_MAP, createDetector, localizedExercise, exerciseUnit,
  localizedCategories, localizedByCategory,
} from './exercises.js';
import { LandmarkSmoother, toMetric, clamp, LM } from './geometry.js';
import { computeFrame } from './metrics.js';
import {
  PoseEngine, Camera,
  PoseLoadError, RETRY_DELAYS, LOAD_ATTEMPTS, FIRST_DETECT_TIMEOUT_MS, LOAD_TIMEOUT_MS,
  DOWNLOAD_STALL_TIMEOUT_MS, INIT_TIMEOUT_MS, GPU_INIT_TIMEOUT_MS, DEFAULT_DELEGATE,
  composeProgress, formatMB, isTimeoutLoadError,
} from './pose-engine.js';
import { PoseRenderer } from './render.js';
import { AudioKit, TRACKS, getTrack, DEFAULT_TRACK } from './audio.js';
import { Calibrator, requiredView } from './calibration.js';
import {
  exerciseSpecs, specCondition, specStages, stageHolds, stageText, stagePoints, stageIndexForStep, SPEC_METRICS,
} from './specs.js';
import { getStepPlan } from './steps.js';
import { iconSVG, uniqueStages, categoryMarkSVG, navPoseSVG, libIconSVG, pawSVG } from './icons.js';
import { PoseLogger } from './pose-log.js';
import {
  t, setLang, getLang, getMeta, applyI18n, detectLang, LOCALES, LANG_ORDER,
} from './i18n.js';
// AI 语音教练（P3.0 基座）：会话状态机 + 适配器 + 界面层。
// app.js 只做接线（热键 / 设置开关 / 生命周期 / 把 snapshot 交给 coach.render）。
import { createVoiceSession, voiceErrorKey } from './voice/session.js';
import { createMic, createAutoAsr, createLlm, createTts, createVuMeter } from './voice/providers.js';
import { createCoach, coachLayout } from './voice/coach.js';
// P3.6：对话弹幕（纯逻辑 + DOM 渲染分层）+ 火山 TTS 播放层（失败自动回退系统 TTS）
import {
  createDanmaku, DANMAKU_MODES, DANMAKU_DEFAULT_MODE, DANMAKU_COLORS,
} from './voice/danmaku.js';
import {
  createVolcTts, TTS_SOURCES, TTS_DEFAULT_SOURCE, TTS_PATH,
} from './voice/tts-volc.js';
// P3.5 语音排障：诊断收集（批量落盘 logs/coach-diag.jsonl）+ 独立的「语音自检」
import { createDiag } from './voice/diag.js';
import { createSelfTest } from './voice/selftest.js';
// P3.2 命令快车道：命令表是唯一来源（说法 / 帮助面板 / 测试都从它来）
import { COMMANDS, commandHelpRows } from './voice/commands.js';
// P3.3 自由对话：POST /llm 的客户端（密钥在服务端；这里只有同源的 /llm）
import { createLlmClient, buildAgentContext } from './voice/llm.js';

const $ = (id) => document.getElementById(id);

/** 拼 HTML 时的最小转义（文案来自词条，数值来自代码常量，仍然兜一层底） */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STORE = {
  settings: 'mfg.settings.v1',
  history: 'mfg.history.v1',
  records: 'mfg.records.v1',
};

/**
 * 当前设置版本：
 *   v2 = 「火柴人」默认关闭、老存档迁移一次；
 *   v3 = 姿态模型 delegate 默认改成 **CPU**（老存档里的空串 = 旧「自动先试 GPU」，
 *        正是会卡到超时的那条路，迁移时直接改成 'cpu'，不必等用户手动清缓存）。
 */
const SETTINGS_VERSION = 3;

const DEFAULT_SETTINGS = {
  modelKey: 'lite',
  /**
   * 用户**自己**改过识别模型没有（手机默认轻量模型只在没改过时生效）。
   * 见 applyDeviceDefaults —— 用户的选择永远优先，不会被「设备默认值」覆盖。
   */
  modelKeySet: false,
  /**
   * 摄像头朝向（手机上有前后两个镜头）：'user' 前置（默认）/ 'environment' 后置。
   * 浏览器实际生效的朝向会回写到 camera.facing，失败时按 pose-engine 的降级顺序自动回退。
   */
  cameraFacing: 'user',
  mirror: true,
  voice: true,
  sfx: true,
  music: true,
  musicTrack: DEFAULT_TRACK,   // 背景音乐选哪首（见 audio.js 的 TRACKS）
  // 判据只有宽松档（用户明确要求取消严格模式），所以设置里没有 strict 这个开关
  /**
   * 缺省值（用户要求）：
   *   - **「火柴人」默认关闭**（`showSkeleton: false`）—— 除非用户主动打开（工具栏那个开关 / 按 S）；
   *   - **「关节角度」默认打开**（`showAngles: true`）—— 除非用户主动关闭。
   * 注意 HTML 里那两个按钮的 `aria-pressed` 只是初始占位，真正的状态由 `syncToggles()` 按这里的设置刷新。
   */
  showAngles: true,
  showSkeleton: false,
  /** 设置版本：用来做一次性迁移（见 loadSettings；v2 起「火柴人」默认关闭） */
  settingsVersion: SETTINGS_VERSION,
  debug: false,
  /**
   * 「记录调试数据」（用户要求）：打开后把每一帧的关节点 + 全部判定指标写进 logs/ 里的 jsonl 文件。
   * 开关放在**运动设定**弹窗里（那个弹窗就是「这个动作怎么判」的地方），状态跟着设置持久化。
   */
  poseLog: false,
  exerciseId: 'squat',
  targets: {},
  // 限时计数（开合跳）的时长单独存：这个动作以前的目标是「次数」，
  // 同一个字段改成秒以后老值（50 次）会变成「50 秒」这种莫名其妙的时长，
  // 所以时长另开一份 settings.seconds，老字段原样留着不读。
  seconds: {},
  camDeviceId: null,
  /**
   * 姿态模型用的 delegate：'gpu' / 'cpu'。
   *
   * **默认 'cpu'**（用户实测：GPU 在创建 WebGL 上下文时会**卡死**，页面白等 20s 才报
   * 「推理器创建失败（超时 20s）」→ 改成默认 CPU，稳；GPU 只在显式选 'gpu' 时才试，
   * 而且只给 6 秒软超时，超时也立刻切 CPU，并把 'cpu' 记下来（见 loadPoseModel 的 onDelegate）。
   */
  poseDelegate: 'cpu',
  /**
   * AI 语音教练（P3.0 基座）的开关：**默认关**。
   * 设置弹窗里的开关与视频界面的 Ctrl+I 写的是同一个字段，所以两边永远同步。
   */
  coachEnabled: false,
  /**
   * 对话显示（P3.6）：'danmaku'（默认）/ 'subtitle' / 'off'。
   * 弹幕 = 一句一条、分两种颜色；字幕 = 原来的两行面板；关闭 = 都不显示（状态环仍在）。
   */
  dialogue: DANMAKU_DEFAULT_MODE,
  /** 音色来源（P3.6）：'auto'（火山优先，默认）/ 'volc'（只试火山）/ 'system'（系统 TTS） */
  ttsSource: TTS_DEFAULT_SOURCE,
  /** 语速：传给 /tts 的 rate（0.5~2，界面给 0.8~1.5 六档） */
  ttsRate: 1,
  /**
   * 自由对话（P3.3）：**默认开**。
   * 关掉 = 只走命令快车道（命中就执行、没命中回罐头回复），**完全不发 /llm 请求**；
   * 适合「不想花钱 / 不想把话发到云端」的用户。
   */
  freeChat: true,
};

const REP_TARGETS = [8, 12, 15, 20, 30];
const HOLD_TARGETS = [20, 30, 45, 60, 90];
// 限时计数（开合跳）的时长预设：单位是秒，不是次数
const TIME_TARGETS = [30, 45, 60, 90, 120];

/**
 * 动作页右上角「设置」圆环 → 屏幕**中间那一层圆环**里可选的数值（**一处定义**：
 * 界面渲染、键盘顺序、测试断言全部从这两个常量读，见 `openSetPicker()` / `setChooserLayout()`）。
 *
 *   - 计数类动作（俯卧撑 / 深蹲这类 `kind === 'rep'`，且不是限时计数）→ **每组次数**，`SET_REP_CHOICES`；
 *   - 计时类动作（平板支撑这类 `kind === 'hold'`）以及限时计数 → **每组秒数**，`SET_SEC_CHOICES`。
 *
 * 选完写进去的仍然是仓库本来就有的那一份存储（`settings.targets[id]` / `settings.seconds[id]`，
 * 见 `setTarget()`），所以 HUD 左上角的目标文案、运动设定弹窗里的数字框、选择页上的小字会一起跟着变
 * —— 没有新造任何存储。
 *
 * 用户后来又要求：「在运动设置中，可选的次数、秒数都应该**大幅度增加**，如果一个页面放不下，
 * **超过 5 个选项，就要使用『向前』『向后』这样的箭头圆环**，让用户能翻页选择。」
 *
 * → 两份列表各扩到 14 / 12 档（覆盖「一次一百个」到「5 分钟」这种大范围，仍然升序），
 *   一页只摆 `SET_PICKER_PER_PAGE`（5）个 → 多出来的靠「向前 / 向后」两颗箭头圆环翻页
 *   （见 `setPickerPageRings()` / `flipSetPickerPage()`）。**翻页是循环的**：最后一页的「向后」回到第一页。
 */
const SET_REP_CHOICES = [3, 5, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100];
const SET_SEC_CHOICES = [10, 15, 20, 30, 45, 60, 90, 120, 150, 180, 240, 300];
/**
 * 中间那一层**一页最多摆几颗「可选数值」圆环**（箭头不算在 5 个里面）。
 * 选项总数 > 这个数时，那一排两端才会出现「向前 / 向后」箭头圆环（≤ 这个数就一颗箭头都没有）。
 */
const SET_PICKER_PER_PAGE = 5;

/** 这个动作的目标预设：计时类与限时计数类都是秒，其余是次数 */
function targetPresetsFor(ex) {
  if (ex.kind === 'hold' || ex.timed) return [...(ex.timed ? TIME_TARGETS : HOLD_TARGETS)];
  return [...REP_TARGETS];
}

/** 目标加减按钮的步长（限时/计时类是 15 秒、5 秒，次数类是 1 次） */
function targetStepFor(ex) {
  if (ex.timed) return 15;
  return ex.kind === 'hold' ? 5 : 1;
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

const audio = new AudioKit();
const engine = new PoseEngine();
const camera = new Camera($('video'));
const renderer = new PoseRenderer($('overlay'));
const smoother = new LandmarkSmoother();

const state = {
  settings: loadSettings(),
  exerciseId: 'squat',
  /**
   * 「运动设定」弹窗**第二步**正在编辑哪个动作（第一步选中的那个）。
   *
   * 与 `exerciseId` 分开：弹窗从主页打开时，用户可能只是想调另一个动作的目标，
   * 不应该顺手把「正在练的动作 / HUD / 进度条」也换掉。目标本身就是**按动作分别存**的
   * （`settings.targets[id]` / `settings.seconds[id]`），所以这里只是「编辑哪一份」的指针。
   * 选择动作（`selectExercise`）时会同步成同一个 id —— 刚练过的动作就是第一步里高亮的那个。
   */
  settingsExerciseId: 'squat',
  target: 15,
  session: 'calibrating',   // calibrating | ready | countdown | running | paused | idle
  homeMode: false,          // 停在动作主页：不校准、不计数（避免浏览动作时偷偷开始一组）
  menuMode: false,          // 停在**手势菜单**：全屏视频画面上摆一圈圆环，手掌停 3 秒选中
  menuLevel: 0,             // 手势菜单的层级：0 = 分类、1 = 该分类下的动作 +「返回」
  menuCategory: '',         // 第二级当前是哪个分类
  menuPage: 0,              // 当前这一层的页码（一页 4 个；向上 / 向下挥手翻页）
  /**
   * 右上角「设置」圆环按下去之后，**屏幕中间那一层圆环**的状态（每组次数 / 每组秒数）。
   * 只在这里记「开着没有、是次数还是秒数、有哪些选项、单位是什么」—— 数值本身不存这里，
   * 选中后照旧写进 `settings.targets[id]` / `settings.seconds[id]`（见 setTarget）。
   */
  setPickerOpen: false,
  setPickerKind: '',        // 'reps' | 'seconds'（跟当前动作走，见 setPickerKindFor）
  setPickerChoices: [],     // 当前这一层可选的数值（来自 SET_REP_CHOICES / SET_SEC_CHOICES）
  setPickerPage: 0,         // 现在停在第几页（0 起；一页 SET_PICKER_PER_PAGE 个，见 setPickerPageRings）
  setPickerUnit: '',        // 环里那个小号单位（和 HUD 同一份：ex.targetUnit）
  autoStart: false,         // 校准识别完成后是否自动进入运动状态（选好动作后为 true）
  afterSet: false,          // 刚结束一组：先让用户休息，不自动开始；离开轮廓后自动恢复
  detector: null,
  calibrator: null,
  calib: null,
  elapsedMs: 0,
  lastTick: 0,
  countdownTimer: null,
  countdownStartedAt: 0,    // 倒计时的起点，用于「定时器被节流」时的时间兜底
  lastCueAt: 0,
  lastCueLevel: 'warn',
  hintUntil: 0,
  lastVideoTime: -1,
  lostSince: 0,
  celebrateUntil: 0,
  goalHit: false,
  wakeLock: null,
  engineReady: false,
  loopCount: 0,
  detectCount: 0,
  poseHits: 0,
  camError: null,
  /** 最近一次 getUserMedia 的 name / message（诊断面板用；camError 是拼好的字符串，给探针看） */
  camErrName: '',
  camErrMessage: '',
  /** 最近一次**姿态模型加载失败**的结构化原因（stage / name / message；成功清空） */
  modelError: null,
  /** 最近一帧「手/脚」离右上角退出圆环多远（🐞 面板用：排查到底有没有识别到手/脚） */
  touchInfo: null,
  consoleErrors: [],
  saidSteps: new Set(),
  stepSig: '',
  calibSig: '',
  lastScoreMilestone: 0,
  /* P3.3 Agent context：最近被提醒过的几句话 / 「太快了」出现过几次（只在内存里） */
  recentNudges: [],
  tooFastCount: 0,
  // ---- 限时计数（开合跳）----
  timeUp: false,            // 时间到：这一组停止计次，等庆祝动画走完再结算
  timeCallsSaid: null,      // 已经报过哪几档剩余时间（45/30/15/5 秒各报一次）
  repsSinceEncourage: 0,      // 距离上一句激励过了几次（每 3 次给一句）
  lastEncourageHint: '',      // 屏幕上刚显示过的激励语（不重复）
  coachAt: -Infinity, // 语音教练上一次说话的时间（全局节流；-Infinity = 还没说过）
  coachSig: '',     // 上一次念的那句话（同一句短时间内不重复）
  // ---- 判定进度条（画面上那条一格一格点亮的判据链）----
  criteriaStages: [],   // 当前动作的阶段（见 specs.js 的 specStages）
  criteriaIdx: -1,      // 已经识别到的最后一格；-1 = 还没开始
  criteriaJust: -1,     // 刚刚点亮的那一格（用于播放「跳一下」动画）
  criteriaJustPts: -1,  // 刚刚拿到分的那一格（同上）
  criteriaPts: [],      // 每一格上**已经拿到**的分（真的有得分项达标才写）
  criteriaMax: [],      // 每一格**能拿多少分**（得分项按关键帧分配，见 specs.js 的 stagePoints）
  criteriaStepStage: {}, // 得分项 id → 第几格（把得分记到对应格子上）
  criteriaClearUntil: 0, // 刚清零后的展示期结束时间（这段时间进度条保持空的）
  criteriaLive: false,   // 这一帧识别到人体了没（决定进度条是灰色还是彩色）
  criteriaLostSince: 0,  // 从什么时候开始没识别到人（丢帧宽限用）
  criteriaIcons: [],     // 每一格的线条图标（SVG 字符串，重建时生成一次）
  criteriaEls: [],       // 每一格的真实元素（{root, icon, pts}）—— 增量更新用，不在计分时重建
  criteriaContext: null, // 生成图标用的上下文（动作姿势/计划/门控）
  // ---- 计时类读秒（每 5 秒播报一次）----
  holdCountNext: 5,      // 下一个要读的秒数（5 / 10 / 15 …）
  holdCountAt: 0,        // 上一次读秒的时刻（用来让要领语音避让）
  // ---- AI 语音教练（P3.0 基座）----
  voice: null,           // session.snapshot() 的最近一份（只在 coach.js 里渲染，app 不直接改）
};

/* ------------------------------------------------------------------ *
 * AI 语音教练（P3.0 基座）
 *
 * 链路：开关（Ctrl+I / 设置）→ mic 权限 → mock ASR → 字幕 → mock LLM → mock TTS。
 * 三个适配器的接口都在 src/voice/providers.js（P3.1 / P3.3 / P3.4 各换一块），
 * 状态机在 src/voice/session.js（纯逻辑），DOM 只在 src/voice/coach.js。
 * 这里只做接线：创建会话、订阅 snapshot、同步设置开关与状态条。
 * ------------------------------------------------------------------ */

/**
 * P3.5 语音诊断：所有关键事件（麦克风 / Worklet / WS / 帧数 / partial / final / 错误）
 * 汇总到 `coachDiag`，每 2 秒或满 20 条批量写到预览服务器的 `logs/coach-diag.jsonl`。
 * 诊断失败绝不抛错，也不含音频（见 diag.js 的截断 / 脱敏规则）。
 */
const coachDiag = createDiag({ timer: true });

/**
 * P3.1：语音识别默认走「本机火山代理 → 回退浏览器 Web Speech」这条自动选路
 * （`createAutoAsr`）。麦克风**只在这里创建一次**：火山采集、音量表（VU）共用同一条
 * `MediaStream`；只有回退 Web Speech 时才会先释放它（识别器要自己取麦）。
 */
const coachMic = createMic({ diag: coachDiag });
const coachAsr = createAutoAsr({ mic: coachMic, diag: coachDiag });
/**
 * P3.6：教练说话默认走**火山 TTS**（本机 /tts 代理），失败 / 超时 3s 自动回退系统 TTS。
 * `coachSystemTts` 就是 P3.0 的 mock TTS（speechSynthesis），作为降级兜底保留；
 * 「音色来源」选「系统」时完全不发 /tts 请求。
 */
const coachSystemTts = createTts({ rate: 1, diag: coachDiag });
const coachTts = createVolcTts({
  fallback: coachSystemTts,
  diag: coachDiag,
  source: state.settings.ttsSource,
  rate: state.settings.ttsRate,
});
/** 独立的「语音自检」：自己的麦 / 自己的 WS，不经过会话状态机（教练关着也能用） */
const coachSelfTest = createSelfTest({
  diag: coachDiag,
  speak: (text) => { try { coachTts.speak(text); } catch { /* ignore */ } },
});
const coach = createCoach({
  // 音量表用的是会话层那一条流（requireStream：拿不到就静默降级，**绝不另开一路麦克风**）
  vuFactory: () => createVuMeter({ stream: coachMic.stream, requireStream: true, diag: coachDiag }),
  diag: coachDiag,
  selfTest: coachSelfTest,
});
/**
 * 对话弹幕（P3.6）：一句一条、用户青 / 教练薄荷绿、只占上半屏 4 条轨道；
 * 底部「最近一句」静态行独立于弹幕层（两种模式都保留）。
 * 纯逻辑在 danmaku.js 的 createDanmakuModel 里，这里只接 DOM 与设置。
 */
const danmaku = createDanmaku({
  layer: $('danmakuLayer'),
  lastEl: $('danmakuLast'),
  settings: state.settings,
});
/** 「别说话」命令的开关：只关教练朗读，字幕照常（session.setMuted） */
let coachMuted = false;
/**
 * 命令快车道的执行上下文（P3.2）。
 *
 * **只有仓库里已经存在的函数**（外加本次新增的 3 个纯 UI 入口：
 * `getStateSnapshot` 只读快照 / `setCoachMuted` 静音开关 / `openVoiceHelp` 面板），
 * 命令本身（`src/voice/commands.js` 的 `run`）绝不直接改 state。
 */
const voiceCommandCtx = {
  // 导航
  showHome, showWorkout, openMenu, closeMenu,
  flipMenuPage, selectFromMenu, menuItems, pickMenuItem, menuPageInfo,
  openSettings, closeSettings, openRecordsModal, closeRecordsModal,
  openExerciseSettings, closeExerciseSettings, openVoiceHelp, closeVoiceHelp,
  // 训练
  startGestureMode, selectExercise, pauseSession, resumeSession, retrySet, setTarget,
  // 语音 / 查询
  setCoachMuted, setCoachEnabled, changeLang, getStateSnapshot,
};
/**
 * ---------------- P3.3 自由对话（LLM + 工具调用） ----------------
 *
 * 顺序（用户要求，和 session.js 里那条注释一一对应）：
 *   ① 命令快车道（`parseCommand` + 命令表）—— 命中就直接执行，不发请求、不花钱；
 *   ② 没命中 → `POST /llm`（带上 `getLlmContext()` 的状态快照）；
 *   ③ 成功 → 会话层拿 `actions` 的 `intent` 去命令表里跑**现有 handler**，
 *      再把 `reply` 当教练说的话（弹幕 + TTS 都在 session → coachTts 那条路上）；
 *   ④ 失败 / 超时 / 503 / 429 → 记 `llm:fallback`，回退 P3.0 的罐头回复，绝不崩。
 *
 * 密钥在服务端（`coach.env`），前端只知道同源的 `/llm`；这里也不打印任何状态。
 */
const coachLlmMock = createLlm();
const coachLlmClient = createLlmClient({
  diag: coachDiag,
  // 浏览器里走 window.fetch（同源 /llm）；Node 集成测试用 __mfg.llmClient.setFetch() 换掉
  fetchImpl: (...args) => {
    const f = typeof window !== 'undefined' && typeof window.fetch === 'function' ? window.fetch : null;
    if (!f) throw new Error('fetch unavailable');
    return f.apply(window, args);
  },
});

/**
 * 发给模型的**只读**状态快照（P3.3）。
 *
 * `getStateSnapshot()` 里放**原始事实**（动作 / 相位 / 关键帧 / 历史 / 提示…），
 * `buildAgentContext()`（src/voice/llm.js，纯函数）再算成
 * `now / session / performance / history / signals` 那份给 LLM 的结构 ——
 * 分数 / 命中率 / 趋势全在前端算好，模型只负责解释与决策，不许自己编数。
 */
function getLlmContext(text = '') {
  let snap = {};
  try {
    snap = getStateSnapshot();
  } catch {
    snap = {};
  }
  return buildAgentContext({ ...snap, utterance: String(text || ''), now: Date.now() });
}

/** 会话层用的 llm 适配器（自由对话关掉时就退回原来的 mock 罐头回复） */
const voiceLlm = {
  reply(text) {
    if (!state.settings.freeChat) return coachLlmMock.reply(text);
    return coachLlmClient
      .respond(text, { locale: getLang(), context: getLlmContext(text) })
      .then((res) => ({ text: res.reply, actions: res.actions }))
      .catch((err) => {
        coachDiag?.record?.('llm:fallback', { code: (err && err.code) || 'llm-error' });
        return coachLlmMock.reply(text);
      });
  },
};

const voice = createVoiceSession({
  mic: coachMic,
  asr: coachAsr,
  llm: voiceLlm,
  tts: coachTts,
  commandCtx: voiceCommandCtx,
  thinkDelay: 360,       // 让「正在想…」真的看得见，不然 thinking 一闪而过
});
/** 第一次打开才说自我介绍（同一次页面生命周期里不重复） */
let coachIntroSaid = false;

state.voice = voice.snapshot();
/** 上一句已经弹过的话（避免同一份 snapshot 反复 emit 时重复弹） */
let lastUserLine = '';
let lastCoachLine = '';
voice.subscribe((snap) => {
  state.voice = snap;
  coach.render(snap);
  syncCoachToggle(!!snap.enabled);
  // 关闭 / 出错：把音量表那一路音频就地释放（render 里也兜了一次，这里保证状态变化即释放）
  if (!snap.enabled || snap.state === 'off' || snap.state === 'error') coach.stopVu();
  // 回退 Web Speech 时共享麦克风已经交给浏览器的识别器了：音量表没有流可用，收掉
  if (snap.route === 'webspeech') coach.stopVu();

  // P3.6 弹幕：final → 一条；partial 只更新底部灰色实时行（不弹）
  if (!snap.enabled || snap.state === 'off') {
    lastUserLine = '';
    lastCoachLine = '';
    return;
  }
  const userLine = String(snap.userText || '');
  const coachLine = String(snap.coachText || '');
  if (userLine && userLine !== lastUserLine) danmaku.push({ text: userLine, kind: 'user' });
  if (coachLine && coachLine !== lastCoachLine) danmaku.push({ text: coachLine, kind: 'coach' });
  lastUserLine = userLine;
  lastCoachLine = coachLine;
  danmaku.setInterim(String(snap.interimText || ''));
});
// 对话显示模式先和设置对齐（弹幕模式收起两行字幕面板；字幕模式照旧）
applyDialogueMode(state.settings.dialogue);

/** 一次动作完成后，进度条保持「空的」多久（让清零看得见） */
const CRITERIA_CLEAR_MS = 650;

/** 丢掉识别多久才把进度条变灰并清零（识别本身会抖，短暂丢帧不算） */
const CRITERIA_LIVE_GRACE_MS = 700;

/** 收集控制台错误，供 ?probe=1 自检输出 */
function captureConsole() {
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      if (level === 'error') state.consoleErrors.push(args.map(String).join(' ').slice(0, 300));
      orig(...args);
    };
  }
}

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE.settings) || '{}');
    const merged = { ...DEFAULT_SETTINGS, ...raw };
    /**
     * 一次性迁移（用户反馈：「火柴人依然还是在呀，请把火柴人默认设为关闭」）：
     *
     * v1 时期「火柴人」的默认值是**开**，所以老存档里那个 `showSkeleton: true` 很可能只是当年的默认值、
     * 并不是用户自己选的 —— 直接把新默认（关）盖上去；之后用户自己再打开时存档已经是 v2，不会再被覆盖。
     * 「关节角度」不动：它新旧默认都是开，存档里的值就是用户真实的选择。
     *
     * v3：姿态模型 delegate 的默认值从「空串（先试 GPU）」改成 'cpu'。老存档里的空串只是旧默认，
     * 并不是用户的选择 —— 直接迁移成 'cpu'（GPU 卡死正是用户今天遇到的问题）。
     */
    if (Number(raw.settingsVersion || 1) < SETTINGS_VERSION) {
      merged.showSkeleton = DEFAULT_SETTINGS.showSkeleton;
      if (!merged.poseDelegate) merged.poseDelegate = DEFAULT_SETTINGS.poseDelegate;
    }
    merged.settingsVersion = SETTINGS_VERSION;
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try { localStorage.setItem(STORE.settings, JSON.stringify(state.settings)); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * AI 语音教练：开关（设置弹窗与 Ctrl+I 共用这一对函数）
 * ------------------------------------------------------------------ */

/** 设置弹窗里那个开关按钮与当前状态对齐（Ctrl+I 改完状态也会走到这里） */
function syncCoachToggle(on) {
  const btn = $('btnCoach');
  if (btn) btn.setAttribute('aria-pressed', String(!!on));
}

/**
 * 开 / 关 AI 语音教练。
 *
 * **设置里的开关和 Ctrl+I 是同一个入口**：都改 `state.settings.coachEnabled`、都走这里，
 * 所以「设置里打开 = 按了 Ctrl+I」。
 *
 * 打开：`voice.start()`（请求麦克风 → 启动 mock ASR），成功时第一次给一句自我介绍；
 * 关闭：`voice.stop()`（停识别 / 停 TTS / 释放麦克风轨道），并在状态条留一句收尾。
 */
async function setCoachEnabled(on, { silent = false } = {}) {
  const next = !!on;
  /**
   * 用户要求：「一旦 AI 语音教练开启，则原来的系统语音提示可以关闭，避免重复。
   * 但是原来的提示音（如滴、叮、错误蜂鸣、计次滴答）可以保持原样，不要变。」
   *
   * 这里**先**切系统语音再启动教练：`audio.say()` 里的 `speechSynthesis.cancel()`
   * 会把教练正在说的那句掐断，所以要在教练开口之前就让系统语音闭嘴。
   * 关掉教练时恢复系统语音 —— 完全回到原来的体验。提示音（WebAudio）一点没动。
   */
  audio.setVoiceEnabled(!next);
  state.settings.coachEnabled = next;
  saveSettings();
  syncCoachToggle(next);

  if (next) {
    const snap = await voice.start();
    if (!snap.enabled || snap.state === 'off') return snap;   // 等权限时被关掉了
    if (snap.state === 'error') {
      coach.stopVu();
      setCueLine(t(voiceErrorKey(snap.error?.code)), 'warn');  // 拒绝 / 不支持：明确提示，不静默
      return snap;
    }
    // 音量表复用会话层那一条共享麦克风（不再开第二路 / 不会多弹一次授权框）；
    // 拿不到就静默降级（coach.js 里 catch 掉，只留状态呼吸），不影响聆听
    coach.startVu();
    if (!coachIntroSaid) {
      coachIntroSaid = true;
      // 自我介绍只上字幕、不抢着发声：开启瞬间用户可能还没准备好听
      voice.onCoachText(t('coach.intro'), { speak: false });
    }
    if (!silent) setCueLine(t('status.coachOn'), 'info');
  } else {
    voice.stop();
    coach.stopVu();
    if (!silent) setCueLine(t('status.coachOff'), 'info');
  }
  return voice.snapshot();
}

/** Ctrl+I：有开就关，没开就开 */
function toggleCoach() {
  return setCoachEnabled(!state.settings.coachEnabled);
}

/**
 * 语音命令「别说话 / 说话」：只切换教练朗读，**字幕照常**（P3.2）。
 * 和 `audio.setVoiceEnabled` 不是一回事：这里只关 AI 教练这一路的 TTS。
 */
function setCoachMuted(on) {
  coachMuted = !!on;
  voice.setMuted(coachMuted);
  setCueLine(t(coachMuted ? 'status.coachMuteOn' : 'status.coachMuteOff'), 'info');
  return coachMuted;
}

/**
 * 对话显示（P3.6）：把设置里的三选一同时应用到弹幕层与两行字幕面板。
 *   - danmaku：弹幕层出现、两行字幕面板收起（底部「最近一句」仍在）；
 *   - subtitle：弹幕层隐藏、两行字幕面板照旧（「最近一句」仍在，面板自动上移一行）；
 *   - off：两者都隐藏（状态环 / 提示行不受影响）。
 * 返回归一化后的模式（非法值回落默认「弹幕」）。
 */
function applyDialogueMode(mode) {
  const next = DANMAKU_MODES.includes(mode) ? mode : DANMAKU_DEFAULT_MODE;
  state.settings.dialogue = next;
  saveSettings();
  danmaku.setMode(next);
  coach.setDialogueMode(next);
  const stage = $('stage');
  if (stage && stage.classList) stage.classList.toggle('dialogue-subtitle', next === 'subtitle');
  danmaku.setInterim('');
  coach.render(voice.snapshot());
  return next;
}

/** 音色来源 / 语速（P3.6）：改了立刻生效，下一句就用新设置 */
function applyTtsSettings() {
  coachTts.setSource(state.settings.ttsSource);
  coachTts.setRate(state.settings.ttsRate);
  return { source: coachTts.source, rate: coachTts.rate };
}

/* ------------------------------------------------------------------ *
 * P3.3 自由对话（LLM + 工具调用）
 *
 * 设置里只有一个开关「自由对话」：
 *   开 → 命令快车道没命中的话，把这句话 + 当前状态发给 `POST /llm`；
 *   关 → 完全不发请求，只用命令快车道 + 原来的罐头回复。
 * 这里同时负责把 `/llm/health` 的 provider / model 显示在开关下面（**没有 key**）。
 * ------------------------------------------------------------------ */

/** 开关按钮与 state.settings.freeChat 对齐（打开设置弹窗、切换语言时都会调） */
function syncFreeChatToggle() {
  const btn = $('btnFreeChat');
  if (btn) btn.setAttribute('aria-pressed', String(!!state.settings.freeChat));
}

/**
 * 「自由对话：开 / 关」的唯一入口（默认开）。
 * 关掉时顺手清掉对话记忆：下次打开不会带着关之前那几轮。
 */
function applyFreeChat(on) {
  const next = !!on;
  state.settings.freeChat = next;
  saveSettings();
  if (!next) coachLlmClient.reset();
  syncFreeChatToggle();
  return refreshLlmStatus();
}

/**
 * 设置里的「当前 provider / model」那一行。
 * 走 `GET /llm/health`（服务端只回 configured / provider / model / 护栏数值，**不含 key**）；
 * 服务端没起 / 没配 key 都只显示一句说明，不报错、不弹窗。
 */
async function refreshLlmStatus() {
  const el = $('llmStatus');
  if (!el) return null;
  if (!state.settings.freeChat) {
    el.textContent = t('settings.freeChatOff');
    el.hidden = false;
    return null;
  }
  const health = await coachLlmClient.health();
  if (!health) {
    el.textContent = t('settings.freeChatNoServer');
    el.hidden = false;
    return null;
  }
  el.textContent = health.configured
    ? t('settings.freeChatStatus', { provider: health.provider, model: health.model })
    : t('settings.freeChatNotConfigured', { provider: health.provider, model: health.model });
  el.hidden = false;
  return health;
}
function loadList(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* ignore */ }
}

/** 分数 + 单位（分 / points / puntos / points） */
const scoreText = (n) => `${n} ${t('speech.scoreSuffix')}`.trim();

/* ------------------------------------------------------------------ *
 * 界面构建
 * ------------------------------------------------------------------ */

function buildLanguageSelect() {
  const sel = $('langSel');
  if (!sel) return;
  sel.innerHTML = '';
  for (const code of LANG_ORDER) {
    const meta = LOCALES[code]?.meta;
    if (!meta) continue;
    const o = document.createElement('option');
    o.value = code;
    o.textContent = `${meta.flag || ''} ${meta.label || code}`.trim();
    sel.appendChild(o);
  }
  sel.value = getLang();
}

/* ------------------------------------------------------------------ *
 * 主页：五个分类 × 动作图标网格
 * ------------------------------------------------------------------ */

/** 当前搜索词（主页搜索框） */
let homeQuery = '';

function buildHome() {
  const box = $('homeCats');
  if (!box) return;
  const q = homeQuery.trim().toLowerCase();
  box.innerHTML = '';
  let shown = 0;
  for (const cat of localizedCategories()) {
    const list = localizedByCategory(cat.id)
      .filter((ex) => !q
        || ex.name.toLowerCase().includes(q)
        || ex.id.toLowerCase().includes(q)
        || (ex.goal || '').toLowerCase().includes(q)
        || (ex.cameraHint || '').toLowerCase().includes(q));
    const block = document.createElement('section');
    block.className = 'cat-block';
    block.dataset.cat = cat.id;
    const count = t('home.count', { n: list.length });
    /**
     * 分类的图标也换成**线条图标**（和手势菜单里、视频画面上是同一张）。
     *
     * 用户要求：「把网页主页上的『上肢』『下肢』这种分类的图标进行更换，保持和视频画面中的线条风格的图标一致。」
     * 以前这里直接印 `cat.icon`（emoji 💪🦵🔥🤸🧘），和菜单里那套 24 网格线条图标不是一回事 —— 现在统一走
     * `categoryMarkSVG()`（Lucide / Tabler 现成图标），取不到才退回 emoji。
     */
    const catIcon = categoryMarkSVG(cat.id) || cat.icon;
    block.innerHTML = `<h3 class="cat-head"><span class="cat-icon">${catIcon}</span>`
      + `<span>${cat.name}</span><span class="cat-count">${count}</span></h3>`;
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = t('home.noResult');
      block.appendChild(p);
    } else {
      const grid = document.createElement('div');
      grid.className = 'ex-grid';
      for (const ex of list) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ex-card';
        btn.dataset.id = ex.id;
        if (ex.id === state.exerciseId) btn.classList.add('active');
        const kind = t(ex.kind === 'rep' ? (ex.timed ? 'ui.kindTimed' : 'ui.kindRep') : 'ui.kindHold');
        const target = `${ex.target} ${ex.targetUnit}`;
        btn.innerHTML = `<span class="ex-icon">${ex.poseIcon || ex.icon}</span>`
          + `<span class="ex-name">${ex.name}</span>`
          + `<span class="ex-meta">${kind} · ${target} · ${ex.judgeText}</span>`
          + (ex.rough ? `<span class="ex-badge">${t('home.rough')}</span>` : '');
        btn.addEventListener('click', () => openExercise(ex.id));
        grid.appendChild(btn);
      }
      block.appendChild(grid);
    }
    if (list.length || !q) box.appendChild(block);
    shown += list.length;
  }
  if (q && !shown) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = t('home.noResult');
    box.appendChild(p);
  }
}

/* ------------------------------------------------------------------ *
 * 两个视图：主页（只负责挑动作）与动作页（体感训练）
 *
 * 用地址栏 hash 当路由，这样「进动作页」是真的换页面：
 *   #/            主页
 *   #/ex/<id>     某个动作的训练页
 * 好处是浏览器后退能回主页、刷新能停在同一个动作、链接可以直接分享。
 * ------------------------------------------------------------------ */

const ROUTE_EX = '#/ex/';

/** 从地址栏读当前动作用户想练哪个动作（不在动作页时返回 null） */
function routeExercise() {
  try {
    const h = String(location.hash || '');
    if (!h.startsWith(ROUTE_EX)) return null;
    const id = h.slice(ROUTE_EX.length);
    return EXERCISE_MAP[id] ? id : null;
  } catch { return null; }
}

/** 同步地址栏（不写历史，避免每帧都塞一条记录） */
function setRoute(hash) {
  try {
    if (location.hash === hash) return;
    if (typeof history !== 'undefined' && history.replaceState) history.replaceState(null, '', hash);
    else location.hash = hash;
  } catch { /* 某些环境（自动化桩）没有 history，忽略即可 */ }
}

/** 曲子列表（设置弹窗里选背景音乐） */
function buildMusicTracks() {
  const box = $('musicTracks');
  if (!box) return;
  box.innerHTML = '';
  for (const track of TRACKS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'track-btn';
    btn.dataset.track = track.id;
    const on = track.id === state.settings.musicTrack;
    btn.setAttribute('aria-pressed', String(on));
    if (on) btn.classList.add('active');
    btn.innerHTML = `<span class="track-name">${t(track.nameKey)}</span>`
      + `<span class="track-meta">${track.bpm} BPM</span>`;
    btn.addEventListener('click', () => selectMusicTrack(track.id));
    box.appendChild(btn);
  }
}

/** 选一首曲子：立刻生效（顺便把背景音乐打开，否则选了也听不到） */
function selectMusicTrack(id) {
  const next = audio.setTrack(id);
  state.settings.musicTrack = next;
  if (!state.settings.music) {
    state.settings.music = true;
    $('btnMusic').setAttribute('aria-pressed', 'true');
    applyMusic();
  }
  saveSettings();
  buildMusicTracks();
  setCueLine(t('status.musicTrack', { name: t(getTrack(next).nameKey) }));
}

/**
 * 背景音乐只在**动作页**播放：主页只是挑动作，不放音乐（用户明确要求）。
 * 用户的选择（state.settings.music）保留着，回到动作页时自动接着放。
 */
/**
 * 摄像头只在**动作页**开着：回到主页就关掉（用户明确要求）。
 * 关闭时把遮罩恢复到「开启摄像头」，下次进动作页会自动重新打开（那一下点击本身就是用户手势，
 * 浏览器允许 getUserMedia），所以用户感觉不到多一步操作。
 */
function stopCameraForHome() {
  if (!camera.active && !camera.stream) return;
  try { camera.stop(); } catch { /* ignore */ }
  state.camStoppedForHome = true;
  state.poseHits = 0;
  $('hud').hidden = true;
  renderer.clear();
  const mask = $('stageMask');
  if (mask) mask.classList.remove('hidden');
  $('maskIcon').textContent = '📷';
  $('maskTitle').textContent = t('ui.maskTitle');
  $('maskText').textContent = t('ui.maskText');
  $('btnStartCam').textContent = t('ui.startCam');
  $('camDot').className = 'dot';
  $('camStatus').textContent = t('status.camOff');
  updatePipelineStatus();
}

/** 从主页回到动作页时把摄像头接回来（只在确实是被主页关掉时需要） */
function resumeCameraFromHome() {
  if (!state.camStoppedForHome || !Camera.supported()) return;
  state.camStoppedForHome = false;
  startCamera(state.settings.camDeviceId || null);
}

function applyMusic() {
  const want = !!state.settings.music && !state.homeMode && !state.menuMode;
  audio.setMusic(want);
}

/**
 * 退出全屏（如果正在全屏）。
 *
 * 用户要求：「做完一个运动退出的时候不仅要退回到主页，也要退出全屏模式」。
 * 否则从「视频框全屏」里点退出/🏠，主页会顶着全屏显示 —— 整页排版被放大、还会留着
 * 那条全屏状态，用户得再按一次 Esc 才回到正常页面。
 *
 * 幂等：本来不在全屏就什么都不做；浏览器不支持 / 拒绝时静默忽略（退出全屏失败绝不能
 * 影响「回主页」这件正事）。桩环境与老浏览器可能不派发 `fullscreenchange`，
 * 所以这里顺手把按钮状态和舞台尺寸自己同步一次。
 */
function exitFullscreen() {
  // 伪全屏（iPhone 那条路）没有原生状态可查，先把类摘掉
  const wasPseudo = typeof pseudoFullscreenOn === 'function' && pseudoFullscreenOn();
  if (wasPseudo && typeof setPseudoFullscreen === 'function') setPseudoFullscreen(false);
  try {
    const doc = typeof document !== 'undefined' ? document : null;
    const el = doc && (doc.fullscreenElement || doc.webkitFullscreenElement);
    if (!el) {
      if (wasPseudo) { $('btnFullscreen')?.setAttribute('aria-pressed', 'false'); onStageResize(); }
      return wasPseudo;
    }
    const p = (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc);
    if (p && typeof p.catch === 'function') p.catch(() => { /* 退出全屏被拒：忽略 */ });
    $('btnFullscreen')?.setAttribute('aria-pressed', 'false');
    onStageResize();
    return true;
  } catch {
    return wasPseudo;   // 老浏览器抛异常也不能拦住回主页
  }
}

function showHome({ syncRoute = true } = {}) {
  if (state.session === 'running' || state.session === 'paused' || state.session === 'countdown') {
    stopSession('switch');
  }
  // 注意顺序：stopSession 会摆出手势圆环，所以收起来这一步必须在它之后
  hideGestureRings();
  hideCornerExit();
  closeMenu();          // 回首页也一定离开手势菜单（收起覆盖层 + menu-mode 样式）
  // 回主页就一定离开「视频框全屏」：主页上全屏只会把整页放大，没有意义
  exitFullscreen();
  // 主页上不校准也不计数：摄像头可以留着预热，但不能在浏览动作时偷偷开始一组
  state.homeMode = true;
  state.session = 'idle';
  applyMusic();          // 主页不放背景音乐
  stopCameraForHome();   // 主页也不需要摄像头，直接关掉（省电、也让摄像头灯灭掉）
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  $('countdown').hidden = true;
  state.calib = null;
  renderCalibration(null);
  $('homeView').hidden = false;
  $('workoutView').hidden = true;
  // 主页那一屏的高饱和渐变底（见 style.css 的 `body.is-home, body.in-workout`）：
  // 动作页也用**同一套**配色（同一份 --home-* 定义），只是挂牌类不同；
  // 两个类互斥 —— 这里保证「回主页」时不会同时挂着动作页那个类。
  document.body.classList.add('is-home');
  document.body.classList.remove('in-workout');
  $('btnHome').hidden = true;
  $('btnExercise').hidden = false;   // 运动设定在主页右上角（和设置并排）
  closeSettings();
  closeExerciseSettings();
  closeRecordsModal();
  buildHome();
  updateButtons();
  if (syncRoute) setRoute('#/');
  // 主页在竖屏下不挡（浏览动作库没问题）：视图一换就重算一次遮罩
  syncDeviceClasses();
}

/** 切到动作页 */
function showWorkout() {
  state.homeMode = false;
  applyMusic();          // 回到动作页再把背景音乐接上（用户选择保留着）
  resumeCameraFromHome(); // 摄像头之前被主页关掉了就自动重开
  // 动作页也铺**主页那套**高饱和渐变（同一份 --home-* 定义，见 style.css 顶部那条共用规则）：
  // 只把「视频区」留成中性深色（.stage 的 #05090f），叠加层各自保留深色 scrim。
  // 与 `is-home` 互斥：进动作页就把主页那个类摘掉。
  document.body.classList.add('in-workout');
  document.body.classList.remove('is-home');
  $('homeView').hidden = true;
  $('workoutView').hidden = false;
  $('btnHome').hidden = false;
  $('btnExercise').hidden = true;   // 运动设定只在主页出现（动作页没有目标设定入口）
  renderExerciseSettings();
  // 右上角的「退出」圆环不在这里摆：它**只在摄像头开着的时候**显示（用户要求），
  // 由主循环里的 syncCornerExit() 每帧对齐（摄像头一开一关它自己出现/消失）。
  syncCornerExit();
  // 动作页要横向画面：手机上竖屏进入时，把「请把手机横过来」的遮罩亮出来
  syncDeviceClasses();
}

/** 从主页点进某个动作（进入训练页） */
function openExercise(id, { fromRoute = false } = {}) {
  if (!EXERCISE_MAP[id]) return;
  showWorkout();
  selectExercise(id);
  if (!fromRoute) setRoute(ROUTE_EX + id);
  // 有些环境（老浏览器 / 自动化桩）没有 scrollTo，别让它把流程打断
  try { window.scrollTo?.({ top: 0, behavior: 'smooth' }); } catch { /* ignore */ }
}

/** 浏览器前进/后退 → 在两个视图之间切换 */
function handleRouteChange() {
  const id = routeExercise();
  if (id) {
    if (state.homeMode || state.exerciseId !== id) openExercise(id, { fromRoute: true });
  } else {
    showHome({ syncRoute: false });
  }
}

/* ------------------------------------------------------------------ *
 * 设置弹窗（语言 / 模型 / 音效 / 背景音乐 / 画面与识别）
 * ------------------------------------------------------------------ */

function settingsOpen() { return !$('settingsModal').hidden; }

/** 有没有任何一个弹窗开着（快捷键要先让给弹窗里的交互） */
function anyModalOpen() {
  return settingsOpen() || exerciseSettingsOpen() || recordsModalOpen() || voiceHelpOpen();
}

/**
 * 现在是不是「视频画面状态」：在动作页（不是动作主页）、而且没有任何弹窗挡着。
 *
 * 用户要求：「在视频状态下，按下 Ctrl+H 可以开启或者停止记录调试数据。」
 * 主页（挑动作的那一屏）不算 —— 那时摄像头都还没开，按 Ctrl+H 不该悄悄开始记录。
 */
function videoStateActive() {
  const view = $('workoutView');
  return !state.homeMode && !!view && !view.hidden && !anyModalOpen();
}

function openSettings() {
  const modal = $('settingsModal');
  if (!modal) return;
  modal.hidden = false;
  // 让读屏软件念出弹窗标题（标题文案走 i18n，这里只做无障碍关联）
  const title = $('settingsTitle');
  if (title) title.textContent = t('settings.title');
  // 「调试数据记录」这一组默认藏着（用户要求按 Ctrl+H 才显示）：弹窗每次打开都按上次的
  // 临时状态对齐（刷新页面回到隐藏），顺便刷一遍状态行上的帧数。
  setPoseLogUi(poseLogUiVisible);
  renderPoseLogStatus();
  // AI 教练开关：Ctrl+I 在弹窗外面也能改状态，打开弹窗时按最新值对齐一次
  syncCoachToggle(!!state.settings.coachEnabled);
  // 自由对话（P3.3）：开关 + 当前的 provider / model（health 是异步的，打开弹窗就刷一次）
  syncFreeChatToggle();
  refreshLlmStatus();
  const first = modal.querySelector('select, button');
  if (first) first.focus({ preventScroll: true });
}

function closeSettings() {
  const modal = $('settingsModal');
  if (modal) modal.hidden = true;
}

/* ------------------------------------------------------------------ *
 * 最佳成绩 / 运动记录弹窗
 *
 * 用户要求：这两块内容**不要再放在动作页里**，改成顶栏两个图标（🏆 / 📜）+ 弹窗显示。
 * 列表本身还是用同一套渲染（renderRecords / renderHistory），只是被搬进了弹窗的容器里。
 * ------------------------------------------------------------------ */

function recordsModalOpen() {
  return !$('bestModal').hidden || !$('historyModal').hidden;
}

/** 打开某个「记录类」弹窗：先把列表刷成最新的，再显示（顺序保证不会闪旧数据） */
function openRecordsModal(which) {
  const modal = $(which === 'best' ? 'bestModal' : 'historyModal');
  if (!modal) return;
  if (which === 'best') renderRecords(); else renderHistory();
  modal.hidden = false;
  const title = $(which === 'best' ? 'bestTitle' : 'historyTitle');
  if (title) title.textContent = t(which === 'best' ? 'ui.best' : 'ui.history');
  const first = modal.querySelector('button');
  if (first) first.focus({ preventScroll: true });
}

function closeRecordsModal() {
  const best = $('bestModal');
  const hist = $('historyModal');
  if (best) best.hidden = true;
  if (hist) hist.hidden = true;
}

/* ------------------------------------------------------------------ *
 * 「教练，我能说什么」语音命令一览（P3.2）
 *
 * 表格**从命令表生成**（`src/voice/commands.js` 的 COMMANDS）：
 * 中文说法 / English / 作用，一处定义，改说法只改 locales + 命令表。
 * 打开方式：设置弹窗里那一行「语音命令一览」，或者直接对教练说「我能说什么」。
 * 关闭方式：右上角 × / 点遮罩 / Esc（和别的弹窗一致）。
 * ------------------------------------------------------------------ */

function voiceHelpOpen() {
  const modal = $('voiceHelpModal');
  return !!modal && modal.hidden === false;
}

/** 把 COMMANDS 渲染成表格行；返回渲染了多少条（测试直接断言这个数） */
function renderVoiceHelp() {
  const box = $('voiceHelpList');
  if (!box) return 0;
  const rows = commandHelpRows();
  box.innerHTML = rows.map((row) => {
    const what = t(row.helpKey);
    return `<tr data-intent="${esc(row.intent)}">`
      + `<td>${esc(row.zh)}</td>`
      + `<td>${esc(row.en)}</td>`
      + `<td>${esc(what)}</td>`
      + '</tr>';
  }).join('');
  return rows.length;
}

function openVoiceHelp() {
  const modal = $('voiceHelpModal');
  if (!modal) return 0;
  const title = $('voiceHelpTitle');
  if (title) title.textContent = t('coach.help.title');
  const lead = $('voiceHelpLead');
  if (lead) lead.textContent = t('coach.help.intro');
  const count = renderVoiceHelp();
  modal.hidden = false;
  const first = modal.querySelector?.('button');
  if (first && typeof first.focus === 'function') first.focus({ preventScroll: true });
  return count;
}

function closeVoiceHelp() {
  const modal = $('voiceHelpModal');
  if (modal) modal.hidden = true;
}

/* ------------------------------------------------------------------ *
 * 运动设定弹窗（**两步**：① 先选动作 → ② 再设这个动作的目标 / 判据 / 机位）
 *
 * 用户要求（原话）：「将目标设定从运动页面中删除，放到主页的右上方和『设置』在一起。
 * 用户打开『运动设定』之后首先选择运动项目，然后再进入对应的运动目标设置等内容。」
 *
 * 所以入口是主页右上角那个图标（`#btnExercise`，与 ⚙️ 设置并排），动作页没有入口；
 * 弹窗打开时**永远先停在第一步（选择动作）**（这是用户那句话的字面要求，比「记住上次动作」
 * 优先），第二步顶部有明确的「← 换一个动作」返回第一步。
 * 目标数据模型本来就是**按动作分别存**（`settings.targets[id]` / `settings.seconds[id]`），
 * 所以第二步编辑的是「选中那个动作」的那一份，不需要新发明一套存储。
 * ------------------------------------------------------------------ */

function exerciseSettingsOpen() { return !$('exerciseModal').hidden; }

/** 「运动设定」当前要编辑哪个动作：第一步选中的那个（永远是一个真实存在的动作 id） */
function settingsExerciseId() {
  return EXERCISE_MAP[state.settingsExerciseId] ? state.settingsExerciseId : state.exerciseId;
}

/**
 * 某个动作**已经保存着**的目标值（次数 / 秒）。
 *
 * 一处定义：`selectExercise` 取当前动作的目标、选择页上的小字、弹窗里的数字框都走这里，
 * 所以「主页卡片 / 运动设定 / HUD」看到的永远是同一个数。
 * 限时计数类存 `settings.seconds`（时长），其余存 `settings.targets`（次数）。
 */
function targetForExercise(id) {
  const ex = localizedExercise(id);
  if (!ex) return 0;
  return ex.timed
    ? (state.settings.seconds?.[id] || ex.seconds || ex.defaultTarget)
    : (state.settings.targets[id] || ex.defaultTarget);
}

/** 第一步：选择动作页（列出动作库，按分类分组） */
function showExercisePickStep() {
  const pick = $('exercisePickStep');
  const target = $('exerciseTargetStep');
  if (pick) pick.hidden = false;
  if (target) target.hidden = true;
}

/** 第二步：这个动作的目标设置页 */
function showExerciseTargetStep() {
  const pick = $('exercisePickStep');
  const target = $('exerciseTargetStep');
  if (pick) pick.hidden = true;
  if (target) target.hidden = false;
}

/**
 * 建第一步的动作选择页：**19 个动作全部列出，按 5 个分类分组**。
 *
 * 图标复用动作自己的姿势图（`localizedExercise().poseIcon`，就是 `icons.js` 的
 * `exercisePoseSVG(id)`，与主页卡片 / 进度条 / HUD 同一套），不另画新图标；
 * 每一项就是「姿势图标 + 名称（+ 目标）」的按钮，点一下（或回车 / 空格）就进第二步。
 */
function renderExercisePicker() {
  const box = $('exercisePickList');
  if (!box) return;
  const picked = settingsExerciseId();
  box.innerHTML = '';
  for (const cat of localizedCategories()) {
    const list = localizedByCategory(cat.id);
    const block = document.createElement('section');
    block.className = 'pick-cat';
    block.dataset.cat = cat.id;
    block.innerHTML = `<div class="pick-cat-head"><span class="pick-cat-icon">${categoryMarkSVG(cat.id) || cat.icon}</span>`
      + `<span class="pick-cat-name">${esc(cat.name)}</span>`
      + `<span class="pick-cat-count">${esc(t('home.count', { n: list.length }))}</span></div>`;
    const grid = document.createElement('div');
    grid.className = 'pick-grid';
    for (const ex of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pick-card';
      btn.dataset.id = ex.id;
      if (ex.id === picked) btn.classList.add('active');
      const kind = t(ex.kind === 'rep' ? (ex.timed ? 'ui.kindTimed' : 'ui.kindRep') : 'ui.kindHold');
      const target = `${targetForExercise(ex.id)} ${ex.targetUnit}`;
      btn.innerHTML = `<span class="pick-icon">${ex.poseIcon || ex.icon}</span>`
        + `<span class="pick-body"><span class="pick-name">${esc(ex.name)}</span>`
        + `<span class="pick-meta">${esc(kind)} · ${esc(target)}</span></span>`;
      btn.setAttribute('aria-label', t('exercise.pickItem', { name: ex.name }));
      btn.setAttribute('title', ex.name);
      btn.addEventListener('click', () => pickExerciseForSettings(ex.id));
      grid.appendChild(btn);
    }
    block.appendChild(grid);
    box.appendChild(block);
  }
}

/** 第一步里选中某个动作 → 进第二步（切换后把焦点放到「换一个动作」上，键盘用户不会迷路） */
function pickExerciseForSettings(id) {
  if (!EXERCISE_MAP[id]) return;
  state.settingsExerciseId = id;
  showExerciseTargetStep();
  renderExerciseSettings();
  const back = $('btnExercisePickAgain');
  if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
}

/**
 * 这个动作的判定进度条模型：显示用的格子、图标、每格能拿多少分。
 * **进度条和运动设定弹窗共用这一份**（弹窗里列的关键帧必须与画面上的一模一样）。
 */
function criteriaModel(id) {
  const ex = localizedExercise(id);
  const ctx = {
    id,
    posture: ex.posture,
    kind: ex.kind,
    plan: ex.plan,
    gate: EXERCISE_MAP[id]?.params?.gate,
    // 引擎量的是哪个指标：图标要用它决定「画成哪一类姿势」（例如开合跳要画正面开合的姿势）
    metric: EXERCISE_MAP[id]?.params?.metric,
    stages: specStages(id),
  };
  // 画出来一模一样的格子留一格就够（计时类动作里两条姿势要求常常画的是同一个姿势）
  const stages = uniqueStages(ctx.stages, ctx);
  const icons = stages.map((s) => iconSVG(s, ctx));
  // **得分分配到关键帧**：每个关键帧能拿多少分（整轮满分奖励记在最后一格，计时类的每秒分也是）
  const scored = stagePoints(id);
  const max = stages.map((s) => {
    const idx = ctx.stages.indexOf(s);
    const row = idx >= 0 ? scored[idx] : null;
    return {
      points: row ? row.points : 0,
      bonus: row ? row.bonus : 0,
      perSecond: row ? row.perSecond : 0,
    };
  });
  // 步骤 id → 第几格：界面按这个把「这一步加到的分」记到对应格子上
  const stepStage = {};
  for (const def of (getStepPlan(id)?.steps || [])) {
    const fullIdx = stageIndexForStep(id, def.id);
    stepStage[def.id] = fullIdx >= 0 ? stages.indexOf(ctx.stages[fullIdx]) : -1;
  }
  return { ctx, stages, icons, max, stepStage };
}

const ROUND_NUM = ['①', '②', '③', '④', '⑤', '⑥', '⑦'];

/**
 * 运动设定弹窗最上面那组：**这个动作的关键帧 + 每格判据 + 每格分数**。
 *
 * 用户要求「把对应动作的关键帧判别标准以及对应的判分标准列出来」，并且
 * **判据完全由关键帧承担** —— 所以这里逐格列出：图标、序号+短标签、判定标准
 * （就是画面上进度条的判据；有替代判据的写成「A 或 B」）、这一格能拿多少分，
 * 以及这一格相关的补充判据（第一格把其余姿势要求、计次格把深度线、最后一格把时间线列出来）。
 * 原来的「计次判据 / 姿势要求」两组已经去掉，判据一律挂在关键帧上。
 */
function keyframeRowsHtml(id) {
  const { stages, icons, max } = criteriaModel(id);
  const isHold = localizedExercise(id).kind === 'hold';
  const { groups } = exerciseSpecs(id);
  const itemsOf = (key) => groups.find((g) => g.titleKey === key)?.items || [];
  const countItems = itemsOf('spec.group.count');
  const postureItems = itemsOf('spec.group.posture');
  const pick = (label) => countItems.find((it) => it.labelKey === label);
  const parts = [];
  let total = 0;
  stages.forEach((stage, i) => {
    const { short, cond } = stageText(stage);
    const row = max[i] || { points: 0, bonus: 0, perSecond: 0 };
    total += row.points + row.bonus;
    const isMoment = i === stages.length - 1;
    const pts = [
      row.points > 0 ? `+${row.points}` : '',
      row.bonus > 0 ? `+${row.bonus} ${t('spec.roundBonus')}` : '',
      row.perSecond > 0 ? `+${row.perSecond}${t('spec.perSecondSuffix')}` : '',
    ].filter(Boolean).join(' ');

    // 这一格的判据：主判据（+ 有替代判据时写成「A 或 B」+ 有附加条件时补「且 C」）+ 该判据原本的说明
    const altText = stage.alt ? ` ${t('spec.orAlt')} ${specCondition(stage.alt.item || stage.alt)}` : '';
    const alsoText = stage.also ? ` ${t('spec.andAlso')} ${specCondition(stage.also.item || stage.also)}` : '';
    const condText = `${cond}${altText}${alsoText}`;
    const lines = [];
    if (stage.item?.noteKey) lines.push(t(stage.item.noteKey, stage.item.noteParams || null));
    // 这一格下面挂「和它同一组（同一个 labelKey）的其余姿势要求」：
    //   ① 第一格还额外带上纯文字类的要求（例如「请正对摄像头」）；
    //   ② 已经被别的格子当判据用掉的条目不再重复（否则第二个关键帧的判据会跑到第一格下面）。
    // 原先只在第一格挂、且不分组，遇到「一个动作有两组姿势要求」（坐姿体前屈：坐好 + 前折到位）就会串位。
    const usedByStages = new Set(stages.map((s) => s.item).filter(Boolean));
    const mine = stage.item ? specCondition(stage.item) : '';
    const sameGroup = (it) => it.labelKey === stage.item?.labelKey;
    const extra = postureItems.filter((it) => it !== stage.item && !usedByStages.has(it)
      && specCondition(it) !== mine
      && (sameGroup(it) || (i === 0 && !!it.textKey)));
    if (extra.length) lines.push(`${t('spec.poseExtra')}${extra.map((it) => specCondition(it)).join('、')}`);
    // 「计次」那一格：把深度线 / 更浅只算晃了一下的线也挂在它下面
    if (stage.item?.labelKey === 'spec.countLine') {
      const bottom = pick('spec.bottomLine');
      if (bottom) lines.push(`${t('spec.depthLine')}${specCondition(bottom)}`);
      const wobble = pick('spec.wobble');
      if (wobble) lines.push(`${t('spec.wobbleLine')}${specCondition(wobble)}`);
    }
    // 最后一格 = 计次那一刻（计时类是开始计时）：把时间类判据挂在这里
    if (isMoment) {
      const minRep = pick('spec.minRep');
      if (minRep) lines.push(`${t('spec.tempoLine')}${specCondition(minRep)}`);
      const prime = pick('spec.holdPrime');
      if (prime) lines.push(`${t('spec.holdPrimeLine')}${specCondition(prime)}`);
      const grace = pick('spec.holdGrace');
      if (grace) lines.push(`${t('spec.holdGraceLine')}${specCondition(grace)}`);
      const giveUp = pick('spec.giveUp');
      if (giveUp) lines.push(t(giveUp.noteKey, giveUp.noteParams || null));
    }

    parts.push(
      '<div class="spec-row spec-kf">'
      + `<span class="spec-kf-icon">${icons[i] || ''}</span>`
      + `<span class="spec-name">${esc(`${ROUND_NUM[i] || `(${i + 1})`} ${short}`)}`
      + (isMoment ? `<span class="spec-badge">${esc(t(isHold ? 'spec.holdMoment' : 'spec.countMoment'))}</span>` : '')
      + '</span>'
      + `<span class="spec-cond">${esc(condText)}</span>`
      + (pts ? `<span class="spec-pts">${esc(pts)}</span>` : '')
      + (lines.filter(Boolean).length
        ? `<span class="spec-note">${esc(lines.filter(Boolean).join(' · '))}</span>` : '')
      + '</div>',
    );
  });
  parts.push(`<div class="spec-note-full">${esc(t('spec.keyframesNote', {
    n: stages.length,
    total,
    every: t('spec.everyFrameNeeded'),
  }))}</div>`);
  return '<div class="spec-group spec-keyframes">'
    + `<div class="spec-group-title">${esc(t('spec.group.keyframes'))}</div>`
    + parts.join('')
    + '</div>';
}

/**
 * 把当前动作的判据渲染进运动设定弹窗。
 *
 * **判据完全挂在关键帧上**（用户要求）：所以只渲染
 *   ① 关键帧与判分（含每格的判据、分数、以及深度/时间等补充线）
 *   ② 姿态提醒（只出声纠正、不吃次数的那几条）
 * 原来的「计次判据（做到什么程度算一次）」「姿势要求」两组已经取消。
 */
function renderExerciseSpecs() {
  const box = $('exerciseSpecs');
  if (!box) return;
  const id = settingsExerciseId();
  const { groups } = exerciseSpecs(id);
  const parts = [keyframeRowsHtml(id)];
  const advice = groups.find((g) => g.titleKey === 'spec.group.advice');
  if (advice && advice.items.length) {
    parts.push('<div class="spec-group">');
    parts.push(`<div class="spec-group-title">${esc(t(advice.titleKey))}</div>`);
    for (const it of advice.items) {
      const note = it.noteKey ? t(it.noteKey, it.noteParams || null) : '';
      parts.push(
        '<div class="spec-row">'
        + `<span class="spec-name">${esc(t(it.labelKey))}</span>`
        + `<span class="spec-cond">${esc(specCondition(it))}</span>`
        + (note ? `<span class="spec-note">${esc(note)}</span>` : '')
        + '</div>',
      );
    }
    parts.push('</div>');
  }
  box.innerHTML = parts.join('');
}

/**
 * 把**选中的那个动作**的资料刷进弹窗第二步（目标、判定依据、机位、关键帧判据），
 * 顺便刷新侧栏那行「本组目标」摘要（摘要说的始终是**正在练**的动作，不是弹窗里在编辑的那个）。
 */
function renderExerciseSettings() {
  const id = settingsExerciseId();
  const ex = localizedExercise(id);
  if (!ex) return;
  const unit = ex.targetUnit || '';
  $('exerciseName').textContent = `${ex.icon} ${ex.name}`;
  $('exerciseJudge').textContent = `🎯 ${t('exercise.judgeBy', { what: ex.judgeText })}`
    + (ex.rough ? ` · ${t('exercise.rough')}` : '');
  $('exerciseCamera').textContent = `📹 ${ex.cameraHint}`;
  $('targetUnit').textContent = unit;
  // 数字框显示**这个动作自己存着的目标**（目标按动作分别存，见 targetForExercise）
  $('targetInput').value = String(targetForExercise(id));
  // 侧栏摘要：正在练的那个动作 + 它自己的目标（弹窗可以编辑别的动作，摘要不跟着乱跳）
  const cur = localizedExercise(state.exerciseId);
  if ($('targetReadout')) {
    $('targetReadout').textContent = `${t('exercise.target')}: ${state.target} ${cur?.targetUnit || ''}`;
  }
  // 限时计数（开合跳）：把「这一组跑多久、成绩是什么」写在目标下面，避免以为要跳到某个次数
  const timedEl = $('exerciseTime');
  if (timedEl) {
    timedEl.textContent = ex.timed ? t('exercise.timedLead', { sec: ex.target }) : '';
    timedEl.hidden = !ex.timed;
  }
  renderExerciseSpecs();
}

/* ------------------------------------------------------------------ *
 * 调试数据记录（运动设定里的「记录调试数据」开关）
 *
 * 用户要求：「请在我测试的时候记录下关节点和一些关键数据……在运动设置里面增加一个『记录调试数据』
 * 的开关项，只要打开了，就把运动的关节数据按照一定的格式写在一个 log 文件里面。」
 * 数据格式与落盘方式见 src/pose-log.js（JSONL，一行一帧，写到项目里的 logs/ 目录）。
 * ------------------------------------------------------------------ */

/** 一行「这次记录的环境」：动作 / 机位 / 校准地面线 / 识别器 / 关键帧判据 / 模型 */
function poseLogMeta() {
  const ex = localizedExercise(state.exerciseId);
  const stages = specStages(state.exerciseId).map((s) => [
    s.shortKey,
    `${s.metric}${s.op}${s.value}`,
    s.valueFrom ? `←${s.valueFrom}` : '',
    s.detFlag ? `[${s.detFlag}]` : '',
    s.kind,
  ].filter(Boolean).join(' '));
  return {
    exerciseId: state.exerciseId,
    name: ex?.name || '',
    lang: getLang(),
    mirror: !!state.settings.mirror,
    view: requiredView(state.exerciseId),
    target: state.target,
    unit: ex?.unit || '',
    video: `${camera.video?.videoWidth || 0}x${camera.video?.videoHeight || 0}`,
    groundY: Number.isFinite(state.calibrator?.groundRef)
      ? Number(state.calibrator.groundRef.toFixed(4)) : null,
    model: state.settings.modelKey,
    det: state.detector ? state.detector.constructor.name : '',
    // 识别器真正用的那几行参数（分析时不用再翻代码对照）
    params: EXERCISE_MAP[state.exerciseId]?.params || null,
    stages,
    ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
  };
}

/** 开关：打开就开始记录（新开一个文件），关掉就收尾并落盘 */
function setPoseLog(on, { silent = false } = {}) {
  if (on) {
    if (!poseLogger.active) {
      const file = poseLogger.start(poseLogMeta());
      if (!silent) setCueLine(t('status.poseLogOn', { file }), 'info');
    }
  } else if (poseLogger.active) {
    const file = poseLogger.stop('off');
    if (!silent) setCueLine(t('status.poseLogOff', { file: file || '' }), 'info');
  }
  renderPoseLogStatus();
  renderRecBadge();
  return poseLogger.status();
}

/**
 * 切换「记录调试数据」（用户要求：**视频画面下按 Ctrl+H** 直接开始 / 停止）。
 *
 * 为什么要这个快捷方式：这一组设置藏在全局配置里、平时不显示，而调试记录恰恰是
 * 「练到一半发现没计上」时才想起来开的东西 —— 打开弹窗再找开关太绕。
 * 现在视频画面里按一下 Ctrl+H 就开始记，再按一下停，屏幕上还会用状态条告诉你
 * 文件名和共记了多少帧（右下角的角标同时在跳帧数）。
 *
 * 开关状态照旧写进设置（`state.settings.poseLog`），并按「运动设定/设置」里那个开关
 * 的按钮状态同步（`renderPoseLogStatus` 会写 `aria-pressed`）。
 */
function togglePoseLog({ silent = false } = {}) {
  const on = !state.settings.poseLog;
  state.settings.poseLog = on;
  saveSettings();
  const btn = $('btnPoseLog');
  if (btn) btn.setAttribute('aria-pressed', String(on));
  const st = setPoseLog(on, { silent: true });
  if (!silent) {
    setCueLine(
      on
        ? t('status.poseLogKeyOn', { file: st.file || '' })
        : t('status.poseLogKeyOff', { file: st.file || '', frames: String(st.frames) }),
      on ? 'info' : 'warn',
    );
  }
  return st;
}

/**
 * 画面**右下角**的「正在记录」角标（用户要求）。
 *
 * 用户原话：「一旦这个开关打开，则在视频屏幕的右下角要出现一个图标，显示其正在记录帧数据，
 * 同时用数字显示已经记录了多少帧了。」
 *
 * 显示条件就是**开关打开着并且在记录**（`poseLog` + `poseLogger.active`）：关掉开关角标立刻消失，
 * 这样「我到底还在不在记」一眼就能看出来，不用再去弹窗里确认。
 * 数字取 `poseLogger.status().frames`（真正写出去的行数），不是循环帧号 —— 队列满了会丢帧，
 * 屏幕上必须是**实际记下来的**数量。
 */
function renderRecBadge() {
  const badge = $('recBadge');
  if (!badge) return;
  const on = !!state.settings.poseLog && poseLogger.active;
  badge.hidden = !on;
  if (!on) return;
  const num = $('recFrames');
  if (!num) return;
  const txt = String(poseLogger.status().frames);
  if (num.textContent !== txt) num.textContent = txt;
}

/** 设置弹窗（全局配置）里那一行状态（记了多少帧、文件叫什么、有没有写失败） */
function renderPoseLogStatus() {
  const el = $('poseLogStatus');
  if (!el) return;
  const s = poseLogger.status();
  const btn = $('btnPoseLog');
  if (btn) btn.setAttribute('aria-pressed', String(!!state.settings.poseLog));
  if (!s.active) {
    el.textContent = t('settings.logOff');
    return;
  }
  el.textContent = t('settings.logOn', {
    file: s.file,
    frames: String(s.frames),
    mb: (s.bytes / 1048576).toFixed(2),
  }) + (s.queued > 20 ? ` · ${t('settings.logQueued', { n: String(s.queued) })}` : '')
    + (s.dropped ? ` · ${t('settings.logDropped', { n: String(s.dropped) })}` : '')
    + (s.error ? ` · ${t('settings.logError', { err: s.error })}` : '');
}

function openExerciseSettings() {
  const modal = $('exerciseModal');
  if (!modal) return;
  // 如果指针失效（比如存档里是个旧 id），退回「正在练的动作」
  if (!EXERCISE_MAP[state.settingsExerciseId]) state.settingsExerciseId = state.exerciseId;
  renderExercisePicker();
  renderExerciseSettings();   // 第二步的内容先渲染好，选中动作时立即出现，不用再等一次
  // **每次打开都先显示选择页**（用户要求「打开运动设定之后首先选择运动项目」）：
  // 上次选过的动作只在第一步里高亮（.active），不会跳过选择这一步。
  showExercisePickStep();
  modal.hidden = false;
  // 让读屏软件念出弹窗标题（文案走 i18n，这里只做无障碍关联）
  const title = $('exerciseTitle');
  if (title) title.textContent = t('exercise.title');
  const first = $('exercisePickList')?.querySelector?.('.pick-card');
  if (first && typeof first.focus === 'function') first.focus({ preventScroll: true });
}

function closeExerciseSettings() {
  const modal = $('exerciseModal');
  if (modal) modal.hidden = true;
  // 关掉后回到第一步：下次打开（不管从哪儿）都不会直接落在某个动作的目标页上
  showExercisePickStep();
}

/* ------------------------------------------------------------------ *
 * 手势圆环：一组做完之后，把手掌放到圆环中央保持 3 秒就触发
 *
 * 为什么要有它：一组做完后人还站在镜头前，手上都是汗/离键盘很远，
 * 「退出」和「再做一次」这两个最常用的选择不该逼用户去点屏幕。
 * 所以一组结束后直接在画面上摆两个大圆环（左：退出，右：再做一次），
 * 手掌（左右手都行）停在圆环中央 → 圆环**顺时针**走满一圈并转成绿色 → 触发。
 * 3 秒是刻意选的：抬手、经过、犹豫都不会误触，鼠标点一下同样有效。
 * ------------------------------------------------------------------ */

/** 两个圆环的位置（舞台内的比例）—— 与 index.html 里的按钮元素一一对应
 *  y = 0.52 是量过的：圆环下沿留在判定进度条（画在画面底部）上方，手机上也不会压住它 */
const GESTURE_RINGS = {
  exit: { x: 0.32, y: 0.52, labelKey: 'ui.gestureExit', timerId: 'ringExitTimer' },
  retry: { x: 0.68, y: 0.52, labelKey: 'ui.gestureRetry', timerId: 'ringRetryTimer' },
};
/** 圆环直径 = 舞台宽度的这个比例（CSS 里 width: 20% 必须与它一致） */
const RING_SIZE = 0.20;
/** 手掌要落在圆心这个半径内才算「在圆环中央」（约环半径的 60%，边缘擦过不算） */
const RING_HIT = 0.06;
/** 手掌要保持多久 */
const GESTURE_HOLD_MS = 3000;
/** 识别会抖：短暂离开这么久以内不清零（但也不再累积） */
const GESTURE_GRACE_MS = 300;

/**
 * **右上角常驻的「退出」圆环**（用户要求）。
 *
 * 最早是左下角：「在画面左下角划一个『退出』圆环，手或者脚进入之后保持 3 秒则退出运动以及全屏状态。
 *   圆环的动画效果和运动结束后的退出圆环保持一样。」后来用户又把它挪到了**右上角**
 * （「把『退出』这个圆环从左下角移到右上角」）——因为 HUD 的进度圆环挪到计次的位置去了，
 * 右上角正好空出来，而且右上角比左下角更好够到。
 *
 * 它和「一组结束后」的那两个圆环**共用同一套东西**：同样的 `.ring-*` 样式与 SVG、
 * 同样的顺时针走满一圈动画、同样的 `paintRing` / `updateGesture` 逻辑、同样的 3 秒
 * （`GESTURE_HOLD_MS`）与同样宽容度（`GESTURE_GRACE_MS`）；尺寸与 HUD 那个进度环
 * **共用 CSS 变量 `--ring-px`**（所以「各个圆环大小一样」是一条样式约束，不会各写各的），
 * 位置按舞台像素摆在**右上角**（`ringCenter('corner', …)`，右边距 18px / 上边距 16px，
 * 再各自叠加 safe-area-inset-right / -top）。区别只有：
 *   - 手**或脚**都算（手掌中心，或整只脚的中心）；
 *   - 触发后退出这一组（训练里回手势菜单；菜单里是兜底的回主页）；
 *   - **只在摄像头开着的时候显示**（`camera.active`）。
 *
 * ⚠️ 位置只有 `ringCenter('corner', …)` 这一处定义：`layoutCornerRing()` 用它来摆可见的圆环，
 * `anyTouchInRing()` / `handInRing()` 用它来判手/脚在不在环里，所以「看到哪就是判哪」。
 */
/** 圆环外沿离画面右边这么远（与 HUD 的右边距 `padding: 16px 18px` 对齐） */
const CORNER_RING_INSET_PX = 18;
/**
 * 圆环上沿离画面顶部这么高：**与 HUD 的上内边距（`.hud` 的 `padding: 16px 18px`）一致**，
 * 所以退出圆环和左上角的名称胶囊在同一条基线上。
 *
 * 历史（别走回头路）：这个圆环原来贴在**左下角**（`CORNER_RING_BOTTOM_PX = 16`，
 * 与右上角 HUD 进度环成对角）。用户后来要求「把『退出』这个圆环从左下角移到**右上角**」，
 * 而右上角又刚好空出来了（HUD 进度环挪到了计次的位置）—— 于是它接管右上角，
 * 常量也从「下边距」改成「上边距」，仍然是最靠近画面角上的那个位置。
 */
const CORNER_RING_TOP_PX = 16;
/**
 * 右上角「**设置**」圆环与上面那颗「退出」圆环之间的**间距**（像素，两个圆的外沿之间）。
 *
 * 用户要求：「在每一个运动的页面的右上角『退出』圆环**下方**增加一个『设置』圆环……
 * 尺寸与退出圆环**相同**、水平中心对齐」—— 所以设置环的圆心 y = 退出环圆心 y + **直径 + 本间距**
 * （圆心的距离 = 一个直径 + 一道缝）。这个数**只有这一处定义**：`ringCenter('settings')` 用它，
 * `settingsRingLayout()` 把它原样吐给 UI 与测试，判定圈（`anyTouchInRing`）也走同一个圆心。
 */
const SET_RING_GAP_PX = 12;
/**
 * 读不到元素真实尺寸时的兜底直径（与 style.css 里 `--ring-px` 的 clamp 参数保持一致）。
 * 用户要求「退出圆环放大一点」：96/132 → 104/140（HUD 进度环共用同一个变量，一起变大、仍然等大）。
 */
const RING_PX_FALLBACK = { min: 104, vw: 0.105, max: 140 };
/**
 * HUD 进度圆环（现在放在计次的位置）的**内径占外径的比例**。
 *
 * SVG viewBox 是 120×120、圆 `r = 52`、描边 `stroke-width = 9`：
 *   内边半径 = 52 − 9/2 = 47.5 → 内径 = 95，占外径 120 的 **95/120**。
 * 环里的数字必须整颗落在这个内径里（再乘一个安全系数），所以这个比例是
 * `hudRingInnerPx()` / `hudValueFontSize()` 的同一个来源 —— 字号和绘制的圆环不会各说各的。
 */
const HUD_RING_INNER_RATIO = 95 / 120;
/**
 * 数字文字宽度的估算系数（`tabular-nums` 的数字每字宽约 0.6em，取 0.62 留一点余量）。
 * 纯估算，不需要真实布局，所以测试可以直接调这几个函数做断言。
 */
const HUD_DIGIT_EM = 0.62;
/** 环里文字最多占内径的比例（剩下的 16% 是内边距，数字贴着描边也不会碰到） */
const HUD_VALUE_PAD = 0.84;

/**
 * HUD 进度圆环的**内径**（像素）—— 只由直径决定，纯函数。
 *
 * 「绘制」和「字号」共用这一份：SVG 描边画在 r=52、stroke 9 的圈上，
 * 内边就是 47.5（viewBox 单位），换算成屏幕上就是 `ringPx × 95/120`。
 */
function hudRingInnerPx(ringPx) {
  const px = Number(ringPx);
  if (!Number.isFinite(px) || px <= 0) return 0;
  return px * HUD_RING_INNER_RATIO;
}

/**
 * 估算一段数字文字的宽度（像素，纯函数）：`字数 × 字号 × 0.62`。
 *
 * 数字是等宽字体（`font-variant-numeric: tabular-nums`），每个字符宽约 0.6em，
 * 0.62 是留了余量；不依赖 `measureText`，所以 Node 测试里能直接算。
 */
function hudTextWidth(text, fontSize) {
  const n = String(text ?? '').length;
  const f = Number(fontSize);
  if (!Number.isFinite(f) || f <= 0) return 0;
  return n * f * HUD_DIGIT_EM;
}

/**
 * **HUD 圆环里那个大数字该用多大字号**（纯函数，测试直接调用）。
 *
 * 用户要求：「把计次或者计时的数字放到圆环里面，注意调整数字大小，使得数字刚好可以放在
 * 圆环之内，尤其是当数字比较大，比如读秒到 100 秒以上的时候，应当**动态调整字体大小**，
 * 使得数字不要超过圆环边界。」
 *
 * 算法：先由圆环直径算出内径，再取「高度」与「宽度」两条约束的较小值 ——
 *   · 高度：字号 = 行高（`line-height: 1`），最多占内径的 84%；
 *   · 宽度：`字数 × 字号 × 0.62 ≤ 内径 × 84%` → 字号 ≤ 内径 × 84% / (字数 × 0.62)。
 * 于是 `0 / 9 / 99 / 100 / 1000` 都落在圈里，位数越多字越小。
 * 返回值按 0.1px **向下**取整（不向上，才保证估算宽度永远不超过内径），
 * 所以测试可以直接断言 `hudTextWidth(text, hudValueFontSize(ringPx, text)) ≤ hudRingInnerPx(ringPx)`。
 */
function hudValueFontSize(ringPx, text) {
  const inner = hudRingInnerPx(ringPx);
  if (!(inner > 0)) return 11;
  const len = Math.max(1, String(text ?? '').length);
  const maxByHeight = inner * HUD_VALUE_PAD;
  const maxByWidth = (inner * HUD_VALUE_PAD) / (len * HUD_DIGIT_EM);
  const size = Math.min(maxByHeight, maxByWidth);
  return Math.max(1, Math.floor(size * 10) / 10);
}
/**
 * 手 / 脚要「进到圆环里」的判定半径（占**直径**）。
 *
 * 用户最新口径：「**手掌或者脚的一部分进入**就要开始沙漏计时，保持 3 秒后退出，**一部分进入即可触发**。」
 * 所以判定**逐点**做（见 touchSamples）：只要手/脚上的任意一个点（指尖 / 脚跟 / 脚趾尖 / 脚踝 / 手腕）
 * 落进圆环里就算进去了 —— 半径就取**圆环画出来的那个半径**（0.5 × 直径），也就是「点在圆圈里面」。
 *
 * 历史（都保留在注释里，免得以后又走回头路）：
 *   - 最初 0.30（= 环半径的 60%）：必须把「手掌中心 / 整只脚的中心」对准圆心才算，
 *     屏幕上半径 70px 的圆环只有中间 42px 有效 —— 用户反馈「十分不灵敏」；
 *   - 中间改成 0.45（= 环半径的 90%）：好一些，但仍然要求**中心**进环，
 *     用手指尖 / 脚趾尖去够的时候中心还在环外，计时就是不开始 —— 用户再次反馈。
 */
const RING_HIT_RATIO = 0.5;
/**
 * 「一部分进入即可触发」额外给的**宽容度**（乘在判定半径上）。
 *
 * 圆环画出来的那个圆圈半径是 0.5×直径，但描边本身有 3~4px、外面还有一圈光晕，
 * 而且 MediaPipe 的点在画面边角会有几个像素的误差 —— 所以判定半径再放宽 **12%**：
 * 「手的边缘搭上圆圈」就算进去了。用户第二次反馈「依然不够灵敏，感觉必须脚踝/手腕进入」，
 * 这 12% 配合下面 `touchSamples` 里补出来的**手掌 / 脚尖外延点**一起解决。
 */
const RING_TOUCH_TOL = 1.12;
/**
 * 手势落点的最低可见度：低于这个值的点整帧不参与（被身体挡住的看不见的手/脚不会误触）。
 * 原来写死 0.4 —— 但手/脚伸到**画面边角**（右上角圆环正好贴在角上）时，MediaPipe 给的可见度
 * 本来就偏低，0.4 会把「明明看得见的手」整个丢掉，这也是「不灵敏」的原因之一，现在放宽到 0.3。
 */
const TOUCH_VIS_MIN = 0.3;
/**
 * **脚**（脚跟 / 脚尖）的最低可见度：比手更宽松（0.15）。
 *
 * 为什么单独给脚一档（用户反馈「**只要脚尖进入圆环就要开始沙漏计时，现在感觉要脚踝进入才开始计时**」）：
 * 圆环贴在画面**角落**（最初是左下角，后来挪到右上角），脚要够到那儿通常是抬起来斜着伸过去 —— 此时 MediaPipe 对
 * 脚跟 / 脚尖这两个点的可见度经常只有 0.2 上下（脚在画面边缘、鞋尖被裁掉、脚背朝镜头都会被压低），
 * 用 0.3 的门槛**整只脚的脚尖点全被丢掉**，只剩一个脚踝点可用 —— 于是「必须把脚踝塞进圆环」
 * 才开始计时，正是用户感觉到的那个现象。手指尖没有这个问题（手举到角上仍然清晰）。
 *
 * 放宽的代价：偶尔会把「其实看不清的脚」也算进来。所以三条保险都在：判定点必须落在**圆环里面**
 * （半径 0.5×直径，比画出来的圆圈还大 15%）、要**连续停满 3 秒**、而且离开后进度是**慢慢退**的
 * （GESTURE_DRAIN_MS，手抖出去一下不会清零）。
 */
const FOOT_VIS_MIN = 0.15;
/**
 * 脚尖点**量不到时自己估一个**（用户要求「脚尖进入就开始计时」）。
 *
 * 两个方向都估一遍，谁落在圆环里算谁的（这些点只用于圆环判定：画面上不画、也不参与动作识别，
 * 有真实脚尖点时永远不会用到它们）：
 *   ① **顺着小腿**：脚尖 ≈ 脚踝 + (脚踝 − 膝) × `FOOT_TIP_FROM_SHIN`
 *      —— 正面看（人朝镜头）时脚是朝下 / 朝镜头的，脚尖就落在脚踝下面；
 *   ② **朝脚跟的反方向**：脚尖 ≈ 脚踝 + (脚踝 − 脚跟) × `FOOT_TIP_FROM_HEEL`
 *      —— 侧面看时脚跟在后、脚尖在前，两者在脚踝的两侧。
 *
 * ⚠️ 不能写成「脚跟 + (脚跟 − 脚踝)」：那是**继续往脚跟后面伸**，方向正好反了 ——
 * 脚尖和脚跟是在脚踝的**两侧**，不是同侧（这个坑写在注释里，免得以后又写成那样）。
 */
const FOOT_TIP_FROM_SHIN = 0.55;
const FOOT_TIP_FROM_HEEL = 1.6;
/**
 * 估算的脚尖**最多能离脚踝多远**（按小腿长的倍数）：正常人脚尖离脚踝约 0.6 倍小腿长，
 * 这里放宽到 0.8 倍。为什么要这一条：万一 MediaPipe 把脚跟误检到很远的地方，
 * 上面第 ② 条延长线就会「凭空」穿过整个画面落进圆环里 —— 误触 = 直接把这一组退掉，代价很大。
 * 小腿量不到时（膝也丢了）不做这个限制 —— 那种情况本来就该退回真实点。
 */
const FOOT_TIP_MAX_SHIN = 0.8;
/**
 * 手/脚离开圆环之后进度退回去的速度：满圈约 1.5 秒退完。
 *
 * 以前是「离开超过 0.3 秒直接把 `since` 清零」→ 辛辛苦苦停了两秒多，手抖出去 0.4 秒就全没了。
 * 现在改成**按时间慢慢退**：短暂滑出去只损失一点点，真的把手拿开才会眼看着退完。
 */
const GESTURE_DRAIN_MS = 1500;
/**
 * 「手/脚已经靠近圆环」的提示倍数：落在判定半径的这个倍数以内就把圆环点亮一下 ——
 * 用户能立刻看出「摄像头看得见我的手，再往环里挪一点就对了」，不用猜是不是没识别到。
 */
const RING_NEAR_FACTOR = 2.2;

/** 手势圆环的运行时状态（进度 0~1、进入时刻、最后在里面的一刻） */
const gestureState = {
  visible: false,
  exit: { p: 0, since: 0, lastInside: 0, done: false },
  retry: { p: 0, since: 0, lastInside: 0, done: false },
  // 右上角常驻的「退出」圆环：独立显示/隐藏（不跟「一组结束」那两个一起）
  corner: { p: 0, since: 0, lastInside: 0, done: false },
  /**
   * 右上角「设置」圆环（在退出圆环**正下方**、同尺寸）：它和退出环**共用一个容器**
   * （`#cornerExit`），所以显隐由同一个 `cornerVisible` 决定，这里只放自己的蓄力进度。
   */
  settings: { p: 0, since: 0, lastInside: 0, at: 0, done: false },
  cornerVisible: false,
  /**
   * 手势菜单里「手掌正停在哪一个圆环里」——同一时刻只有一格在蓄力，
   * 所以只存一份状态（哪一格 + 哪只手 + 进度），换一格 / 换只手就从头开始（见 updateMenu）。
   *   - `side`      正在蓄力的是哪只手（速度闸门按这只手算）；
   *   - `prev`      每只手上一帧的位置（算速度用，判「手是不是在动」）；
   *   - `armed`     每只手有没有「从所有圆环外面进来」的许可（防误触的核心，见 MENU_ARM_MS）；
   *   - `announced` 这一格的名字是不是已经念过了（指着它一会儿就先念出来）；
   *   - `swipe`     「双手同时挥两次」翻页的状态（参考点 / 方向 / 数到第几下 / 冷却，见 updateMenuSwipe）。
   */
  menu: {
    id: '', side: '', p: 0, since: 0, lastInside: 0, at: 0, announced: '',
    prev: { L: null, R: null },
    armed: { L: false, R: false },
    swipe: {
      ref: {}, dir: 0, count: 0, lastAt: 0, quietSince: 0, cooldownUntil: 0,
    },
  },
  /** 换屏动画的定时器与「动画到什么时候为止」（见 animateMenuSwap） */
  menuAnim: { until: 0, ghostTimer: 0, inTimer: 0, homeTimer: 0 },
};

/**
 * 换屏滑动要走的距离（像素）。
 *
 * 「整行滑动」要求最靠里的那一颗（画面中线上那一格）也完全滑出画面，
 * 所以距离 = 半个舞台宽 + 圆环半径 + 余量；所有元素**平移同样的距离**，看起来才是一整行刚性移动。
 * （右上角那颗「返回」不在这条滑动带上 —— 它常驻在 `.menu-screen` 之外。）
 */
function menuSlideDistance(size) {
  const g = menuBandGeom(size);
  return Math.round(size.w / 2 + g.dia / 2 + 28);
}

/**
 * 调试数据记录器（见 src/pose-log.js）。
 *
 * 用户要求：「请在我测试的时候记录下关节点和一些关键数据……在运动设置里面增加一个『记录调试数据』
 * 的开关项，只要打开了，就把运动的关节数据按照一定的格式写在一个 log 文件里面，
 * 这样下次你就可以分析真实的数据了。」
 *
 * 放在模块级：主循环每帧都要用它；开关的状态存在 `state.settings.poseLog`（跟着设置持久化）。
 */
const poseLogger = new PoseLogger({
  // 连续写失败就在状态条上提示一次（用户要能看见「没记上」，而不是以为记好了）
  onError: (err) => setCueLine(t('status.poseLogFailed', { err }), 'warn'),
});

/**
 * 「调试数据记录」那一组在运动设定弹窗里是不是**临时显示出来了**。
 *
 * 用户要求：「改为隐藏，只有用户在弹窗中按下 Ctrl+H 时，才会显示出来。」
 * 所以默认藏起来（连整个分组一起藏），只在弹窗里按 Ctrl+H 才显出来；
 * 这个状态**不写进设置**（刷新页面就回到隐藏），免得哪天忘了关、弹窗又变长。
 */
let poseLogUiVisible = false;

/** 显示 / 隐藏「调试数据记录」那一组（Ctrl+H 调用；弹窗重新打开时也用它保持状态） */
function setPoseLogUi(on) {
  poseLogUiVisible = !!on;
  const group = $('poseLogGroup');
  if (group) group.hidden = !poseLogUiVisible;
  if (poseLogUiVisible) renderPoseLogStatus();
}

/**
 * 圆环的直径（像素）。
 *
 * 优先读元素真实尺寸（CSS 里的 `--ring-px`）；读不到（元素还藏着 / 测试桩）就按**同一组 clamp 参数**
 * 算 —— 这样判定半径和屏幕上看到的圆环永远对得上。
 *
 * ⚠️ 兜底公式用的是**视口宽度（vw）**，不是舞台宽度：CSS 里 `--ring-px: clamp(104px, 10.5vw, 140px)`
 * 里的 vw 就是视口宽度，HUD 进度环与退出圆环都完全由 CSS 决定（= 10.5vw）。以前这里用舞台宽度算，
 * 比 vw 小一圈，于是**在元素还没显示出来的时候量到的直径会被写死在行内样式上** ——
 * 结果就是「退出圆环看起来比 HUD 进度圆环小」（用户反馈）。现在两边口径一致。
 */
function ringPx(key) {
  const el = ringEl(key);
  const w = el?.clientWidth || 0;
  if (w > 0) return w;
  /**
   * 自己量不到（元素还藏着）→ 量那块专门用来读 `--ring-px` 的**探针**（`#ringSizeProbe`，宽高 =
   * `var(--ring-px)`，含 720 / 560px 两条小屏覆盖，`visibility: hidden` 仍然有布局）。
   *
   * 为什么需要探针：菜单里那颗「↩ 返回」圆环要和**动作页的退出圆环**一样大，而退出圆环在菜单里
   * 是 `display: none`（`clientWidth = 0`）。以前退回到「按视口宽度套 clamp 参数」的公式，
   * 它只对宽屏成立 —— 小屏那两条 `--ring-px` 覆盖（84 / 72px）它并不知道，于是菜单里那颗会
   * 比动作页那颗大一圈。量探针拿到的就是 CSS 真正算出来的直径，任何窗口都同数。
   */
  const probe = $('ringSizeProbe');
  const pw = probe?.clientWidth || 0;
  if (pw > 0) return pw;
  const vw = (typeof window !== 'undefined' && window.innerWidth) || stageSize().w;
  return Math.round(clamp(vw * RING_PX_FALLBACK.vw, RING_PX_FALLBACK.min, RING_PX_FALLBACK.max));
}

/**
 * 圆环的圆心（**像素**）：中间两个按比例摆，右上角那个固定在右上角
 * （含刘海 / 状态栏安全区）。
 *
 * ⚠️ 这个函数是**唯一**的位置来源：`layoutCornerRing()` 用它摆可见的圆环，
 * `anyTouchInRing()` / `handInRing()` 用它判手/脚在不在环里 —— 绘制与判定同一份坐标。
 */
function ringCenter(key, stageW, stageH) {
  if (key === 'corner') {
    const px = ringPx('corner');
    const safe = safeAreaInsets();   // 手机横屏时右侧是刘海、顶部是状态栏：圆环要躲开
    return {
      x: stageW - safe.right - CORNER_RING_INSET_PX - px / 2,
      y: safe.top + CORNER_RING_TOP_PX + px / 2,
    };
  }
  /**
   * 「设置」圆环：**在退出圆环正下方**，水平中心对齐、直径相同（用户要求）。
   *
   * ⚠️ 这里**不是另写一套坐标**：x 直接用 `ringCenter('corner')` 的 x，
   * y = 退出环圆心 y + 直径 + `SET_RING_GAP_PX`（两个圆的边缘之间留一道间距）。
   * 于是「退出环挪一格、设置环跟着挪一格」，`layoutSetRing()` 绘制与 `anyTouchInRing()` /
   * `updateSetRing()` 判定拿到的都是这同一个数（看到哪就是判哪）。
   */
  if (key === 'settings') {
    const c = ringCenter('corner', stageW, stageH);
    return { x: c.x, y: c.y + ringPx('corner') + SET_RING_GAP_PX };
  }
  const r = GESTURE_RINGS[key];
  return { x: r.x * stageW, y: r.y * stageH };
}

/** 圆环的判定半径（像素）：中间两个沿用原来的比例口径，右上角退出 / 设置圆环按自己的直径算 */
function ringHitRadius(key, size) {
  if (key === 'corner' || key === 'settings') return ringPx('corner') * RING_HIT_RATIO;
  return RING_HIT * size.w;
}

/**
 * **右上角「退出 / 返回」圆环的完整几何**（用户要求：「把菜单界面中的退出圆环始终放在右上角，
 * 且各界面退出圆环的位置和大小都保持一致。」）
 *
 * 两处「退出 / 返回」圆环**共用这一份**：
 *   - 动作页那颗常驻的「退出」圆环（`#ringQuickExit`，容器 `#cornerExit`）；
 *   - 手势菜单右上角那颗常驻的「↩ 返回」圆环（`#menuBack`，容器 `#menuCornerExit`）。
 *
 * 来源只有这两个函数：
 *   - 圆心 = `ringCenter('corner', …)`（右边距 18px / 上边距 16px + safe-area，**唯一的坐标定义**）；
 *   - 直径 = `ringPx('corner')`（= CSS 的 `--ring-px`，**唯一的尺寸定义**）。
 *
 * 派生量也都在这里，谁都不许另写一套：
 *   - `hit`   = `ringHitRadius('corner', …) × RING_TOUCH_TOL` —— 和动作页那颗**实际生效**的
 *               判定圈同一个数（菜单里的「返回」不再用别的判定口径）；
 *   - `start` = 半径 × `MENU_START_RATIO` —— 菜单的「起手」迟滞，和菜单里其它圆环同一个口径；
 *   - `iconSize` = 直径 × 0.62 —— 和 CSS 的 `.corner-ring .ring-label--icon`
 *               （`calc(var(--ring-px) * 0.62)`）同一个比例。
 *
 * 为什么「所在容器不同」不会带来偏移：两个容器都铺满舞台（`inset: 0`），`stageSize()` 量的就是
 * 舞台像素，`ringCenter('corner', …)` 给的也是舞台像素 —— 所以两者的屏幕坐标是**同一个数**，
 * 不存在「菜单里再换算一次」的等价偏移。
 *
 * ⚠️ 位置与尺寸**只有这一处**：`layoutExitRing()` 用它摆两个元素，`menuBackItem()` 用它给菜单的
 * 判定提供 cx/cy/半径 —— 绘制与判定同源。
 *
 * （`MENU_START_RATIO` 的 `const` 在本文件靠后，运行时才取；`exitRingLayout` 只在 boot 之后被调用。）
 */
function exitRingLayout(size = stageSize()) {
  const px = ringPx('corner');
  const r = px / 2;
  const c = ringCenter('corner', size.w, size.h);
  return {
    cx: c.x,
    cy: c.y,
    px,
    r,
    hit: ringHitRadius('corner', size) * RING_TOUCH_TOL,
    start: r * MENU_START_RATIO,
    iconSize: px * 0.62,
  };
}

/**
 * **右上角「设置」圆环的完整几何**（用户要求：「在每一个运动的页面的右上角『退出』圆环下方
 * 增加一个『设置』圆环……尺寸与退出圆环相同、水平中心对齐」）。
 *
 * ⚠️ 一处定义：它**不是**另写一套坐标，而是从 `exitRingLayout()` / `ringCenter('settings')` 派生 ——
 *   - 圆心 = `ringCenter('settings', …)`，也就是「退出环圆心 +（直径 + `SET_RING_GAP_PX`）」的竖直下移；
 *   - 直径 / 半径 / 判定半径 / 起始迟滞 / 图标尺寸 = 退出环那一份**原样复用**（两颗环永远等大）；
 *   - `below` 就是「圆心到底比退出环低多少」（= 直径 + 间距，测试直接断言这个等式）。
 *
 * 绘制（`layoutSetRing`）与判定（`anyTouchInRing(samples, 'settings', …)` → `ringCenter('settings')`）
 * 用的是同一份数，所以「看到哪就是判哪」。
 */
function settingsRingLayout(size = stageSize()) {
  const base = exitRingLayout(size);
  const c = ringCenter('settings', size.w, size.h);
  return {
    cx: c.x,
    cy: c.y,
    px: base.px,
    r: base.r,
    hit: base.hit,
    start: base.start,
    iconSize: base.iconSize,
    gap: SET_RING_GAP_PX,
    below: c.y - base.cy,       // = px + SET_RING_GAP_PX：圆心之间的竖直距离
  };
}

/**
 * 手 / 脚的**外延采样点**：MediaPipe 的 Pose 模型里，食指 / 小指 / 拇指（17~22）和脚跟 / 脚尖（29~32）
 * 都是**估出来的**，手/脚伸到画面边角（退出圆环所在的位置）时它们常常落在**手腕 / 脚踝附近**、
 * 或者干脆被可见度门槛丢掉 —— 于是「手感上只有手腕和脚踝能触发」（用户第二次反馈的原话：
 * 「感觉目前必须是脚踝和手腕进入才开始 3 秒计时」）。
 *
 * 所以按**肢体的方向**自己把外延补出来（用可靠得多的肘 / 膝当参考点）：
 *   - 手：`手腕 + k × (手腕 − 肘)`，k 取 0.45 / 0.9 —— 手掌与指尖真正所在的位置；
 *   - 脚：`脚踝 + k × (脚踝 − 膝)`（顺着小腿方向，正面视角脚尖就在脚踝下方）以及
 *     `脚踝 + k × (脚踝 − 脚跟)`（侧视角脚尖在脚跟的反方向），各取 0.5 / 1.0。
 * 这些点只用于**圆环判定**（画面上不画、不参与动作识别），而且都做「别伸太远」的上限保护。
 */
const HAND_EXT_K = [0.45, 0.9];
const HAND_EXT_MAX_ARM = 1.2;      // 手掌外延点最多离手腕这么远（按「肩→肘→腕」的长度算）
const FOOT_EXT_K = [0.5, 1.0];

/**
 * 画面里的「手 / 脚」落点（舞台像素坐标，已经考虑镜像）——**每个关键点各算一个采样点**。
 *
 * 手 = 手腕 + 食指 + 小指 + 拇指（每只手 4 个点）+ **沿小臂补出来的手掌点**；
 * 脚 = 踝 + 脚跟 + 脚趾尖（每只脚 3 个点）+ **沿小腿 / 脚跟方向补出来的脚尖点**。
 *
 * 用户口径：「**手掌或脚的一部分进入**我认为就要开始沙漏计时，保持 3 秒后退出。
 *   **一部分进入即可触发**。」 —— 所以右上角那个退出圆环**逐点**判定：
 * 只要手/脚上的**任意一个点**落进圆环里就开始计时（指尖、脚跟、脚趾尖、脚踝都算）。
 *
 * 三次放宽的历史（都保留在注释里）：
 *   ① 可见度门槛 0.4 → 0.3、且「只要有一个点可用就算」；
 *   ② 脚的两个点单独用更宽松的门槛（`FOOT_VIS_MIN` = 0.15）+ 脚尖量不到时估一个；
 *   ③ **手/脚的外延点**（本次）：因为 Pose 模型的指尖 / 脚跟 / 脚尖本来就不可靠，
 *      改用肘 / 膝当参考自己算出手掌与脚尖的位置 —— 这样「脚尖（而不是脚踝）进环」就能触发。
 */
function touchSamples(landmarks, stageW, stageH, mirror) {
  if (!landmarks || !landmarks.length) return [];
  const out = [];
  const toStage = (p) => ({ x: (mirror ? 1 - p.x : p.x) * stageW, y: p.y * stageH });
  const add = (p, kind, side, part, visMin = TOUCH_VIS_MIN) => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    const vis = p.visibility === undefined ? 1 : p.visibility;
    if (vis < visMin) return null;
    const q = { ...toStage(p), kind, side, part, vis };
    out.push(q);
    return q;
  };
  /** 从 from 出发、沿 dir 方向补一串点（dir 已是舞台像素方向） */
  const extend = (from, dir, ks, maxLen, kind, side, part, vis) => {
    const len = Math.hypot(dir.x, dir.y);
    if (!(len > 1)) return;
    for (const k of ks) {
      const reach = len * k;
      if (Number.isFinite(maxLen) && reach > maxLen) continue;
      out.push({
        x: from.x + dir.x * k, y: from.y + dir.y * k, kind, side, part, vis, ghost: true,
      });
    }
  };
  for (const side of ['L', 'R']) {
    const isL = side === 'L';
    const wrist = add(landmarks[isL ? LM.L_WRIST : LM.R_WRIST], 'hand', side, 'wrist');
    add(landmarks[isL ? LM.L_INDEX : LM.R_INDEX], 'hand', side, 'index');
    add(landmarks[isL ? LM.L_PINKY : LM.R_PINKY], 'hand', side, 'pinky');
    add(landmarks[isL ? LM.L_THUMB : LM.R_THUMB], 'hand', side, 'thumb');
    // 手掌 / 指尖的外延（用肘当参考：手腕 − 肘 就是小臂方向）
    if (wrist) {
      const elbowP = landmarks[isL ? LM.L_ELBOW : LM.R_ELBOW];
      const shoulderP = landmarks[isL ? LM.L_SHOULDER : LM.R_SHOULDER];
      if (elbowP && Number.isFinite(elbowP.x) && Number.isFinite(elbowP.y)) {
        const ep = toStage(elbowP);
        // 「别伸太远」的上限：一整条手臂（肩→肘→腕）的长度，正常人手掌远小于它
        const sp = shoulderP && Number.isFinite(shoulderP.x) && Number.isFinite(shoulderP.y)
          ? toStage(shoulderP) : null;
        const armLen = sp ? Math.hypot(wrist.x - sp.x, wrist.y - sp.y) : 0;
        const maxLen = armLen > 1 ? armLen * HAND_EXT_MAX_ARM : Infinity;
        extend(wrist, { x: wrist.x - ep.x, y: wrist.y - ep.y }, HAND_EXT_K, maxLen, 'hand', side, 'palm', wrist.vis);
      }
    }
    const ankle = add(landmarks[isL ? LM.L_ANKLE : LM.R_ANKLE], 'foot', side, 'ankle');
    const heel = add(landmarks[isL ? LM.L_HEEL : LM.R_HEEL], 'foot', side, 'heel', FOOT_VIS_MIN);
    const toe = add(landmarks[isL ? LM.L_FOOT : LM.R_FOOT], 'foot', side, 'toe', FOOT_VIS_MIN);
    // 脚的外延点：真实的脚尖点太小 / 太不准，所以**无论它在不在**都按肢体方向补一串
    //（它在的话内层多一个更准的点，只在量不到时才靠这些外延点，见 FOOT_TIP_MAX_SHIN 的上限）
    if (ankle) {
      const kneeP = landmarks[isL ? LM.L_KNEE : LM.R_KNEE];
      const kp = kneeP && Number.isFinite(kneeP.x) && Number.isFinite(kneeP.y) ? toStage(kneeP) : null;
      // 小腿长（脚踝→膝）：用来卡「外延点别伸太远」
      const shin = kp ? Math.hypot(ankle.x - kp.x, ankle.y - kp.y) : 0;
      const maxLen = shin > 1 ? shin * FOOT_TIP_MAX_SHIN : Infinity;
      if (kp) {
        extend(ankle, { x: ankle.x - kp.x, y: ankle.y - kp.y }, FOOT_EXT_K, maxLen, 'foot', side, 'toe', ankle.vis);
      }
      if (heel) {
        extend(ankle, { x: ankle.x - heel.x, y: ankle.y - heel.y }, FOOT_EXT_K, maxLen, 'foot', side, 'toe',
          Math.min(ankle.vis, heel.vis));
      }
      // 真实的脚尖点量不到时，额外按「脚跟 + 一个脚掌」估一个（和上面那串取并集，谁在环里算谁）
      if (!toe) {
        if (heel) {
          extend(heel, { x: heel.x - ankle.x, y: heel.y - ankle.y }, [1.0], maxLen, 'foot', side, 'toe',
            Math.min(ankle.vis, heel.vis));
        } else if (kp) {
          extend(ankle, { x: ankle.x - kp.x, y: ankle.y - kp.y }, [FOOT_TIP_FROM_SHIN], maxLen, 'foot', side, 'toe', ankle.vis);
        }
      }
    }
  }
  return out;
}

/** 点 (px,py) 到线段 ab 的最短距离（用来判断「整只脚」有没有一部分进圆环） */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 有几个采样点落在圆环里（🐞 面板显示用：「环内点 2」说明结论更稳） */
function pointsInRing(samples, key, size) {
  const c = ringCenter(key, size.w, size.h);
  const hit = ringHitRadius(key, size) * (ringKeyNearCorner(key) ? RING_TOUCH_TOL : 1);
  return samples.filter((p) => Math.hypot(p.x - c.x, p.y - c.y) <= hit).length;
}

/**
 * 手 / 脚有**任意一个采样点**落进圆环里就算「进去了」（用户要求「一部分进入即可触发」）。
 *
 * 另外还判**线段**：同一条手/脚上的采样点两两连成线段，圆环只要和其中任意一条相交也算进去了。
 * 为什么必须有这一条（用户反馈「感觉要脚踝进入才开始计时」）：
 * 脚伸过来的时候，**脚尖在环里、脚踝和脚跟都在环外**是完全可能的 —— 逐点判定这时一个点都不在环内，
 * 于是「脚尖明明已经进去了」却不计时，人只好继续往里塞，直到脚踝也进环。线段判定把整只脚看成一整片，
 * 「脚尖/脚掌搭在圆环上」立刻就算进去了。
 *
 * 返回 `{ inside, pointIn, spanIn, best, bestSeg, minDist, hit }`：
 * `best` 是离圆心最近的采样点、`bestSeg` 是最近的那条线段（🐞 面板要显示它们）。
 */
function anyTouchInRing(samples, key, size) {
  const c = ringCenter(key, size.w, size.h);
  // 右上角那两个圆环（退出 / 设置）多给一点宽容度（见 RING_TOUCH_TOL）；中间两个大圆环仍严格按判定半径
  const hit = ringHitRadius(key, size) * (ringKeyNearCorner(key) ? RING_TOUCH_TOL : 1);
  return anyTouchNearPoint(samples, c, hit);
}

/** 右上角（退出 / 设置）那一对圆环吗 —— 只有它们用 `RING_TOUCH_TOL` 的宽容度 */
function ringKeyNearCorner(key) {
  return key === 'corner' || key === 'settings';
}

/**
 * 手 / 脚有没有**任意一个采样点**（或整只手/脚那一段）落进「以 c 为圆心、hit 为半径」的圈里。
 *
 * `anyTouchInRing()` 只是「先按 key 取圆心与判定半径、再调它」；「设置」环中间那一层选择圆环
 * （每组次数 / 秒数）也用它 —— 那些圆环的圆心来自 `setChooserLayout()`，绘制与判定同样是同一份数。
 */
function anyTouchNearPoint(samples, c, hit) {
  if (!samples || !samples.length) {
    return { inside: false, pointIn: false, spanIn: false, best: null, bestSeg: null, minDist: Infinity, hit };
  }
  let best = null;
  for (const p of samples) {
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (!best || d < best.d) best = { d, p };
  }
  // 整只脚 / 整只手连成的线段（同一条肢体内部的点两两相连）
  const groups = new Map();
  for (const p of samples) {
    const g = `${p.kind}:${p.side}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  let bestSeg = null;
  for (const pts of groups.values()) {
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const d = distToSegment(c.x, c.y, pts[i].x, pts[i].y, pts[j].x, pts[j].y);
        if (!bestSeg || d < bestSeg.d) bestSeg = { d, a: pts[i], b: pts[j] };
      }
    }
  }
  const pointIn = !!best && best.d <= hit;
  const spanIn = !!bestSeg && bestSeg.d <= hit;
  const minDist = Math.min(best ? best.d : Infinity, bestSeg ? bestSeg.d : Infinity);
  return { inside: pointIn || spanIn, pointIn, spanIn, best, bestSeg, minDist, hit };
}

/**
 * 手 / 脚各自的**中心**（手掌中心 / 整只脚的中心）—— 只用于「一组结束」那两个圆环
 * （它们的设计是「把手掌放进圆环中央」）和 🐞 面板的读数；右上角退出圆环改用 touchSamples 逐点判。
 *
 * ⚠️ 只平均**真实量到的关键点**，不算 touchSamples 里补出来的外延点（`ghost`）：
 * 那两个大圆环的设计是「把手掌放进圆环中央」，中心要是被外延点往指尖方向拽，手感就变了。
 * 外延点只服务于右上角退出圆环的「一部分进入即触发」。
 */
function touchPoints(landmarks, stageW, stageH, mirror) {
  const samples = touchSamples(landmarks, stageW, stageH, mirror).filter((p) => !p.ghost);
  const centreOf = (kind, side) => {
    const pts = samples.filter((p) => p.kind === kind && p.side === side);
    if (!pts.length) return null;
    return {
      x: pts.reduce((n, p) => n + p.x, 0) / pts.length,
      y: pts.reduce((n, p) => n + p.y, 0) / pts.length,
      kind,
      side,
    };
  };
  return [
    centreOf('hand', 'L'), centreOf('hand', 'R'),
    centreOf('foot', 'L'), centreOf('foot', 'R'),
  ].filter(Boolean);
}

/** 只有手掌（「一组结束」那两个圆环用；右上角的退出圆环改用 touchSamples 逐点判，手或脚都算） */
function palmPoints(landmarks, stageW, stageH, mirror) {
  /**
   * ⚠️ 只按 `kind === 'hand'` 挑，**不能写成 `slice(0, 2)`**：
   * `touchPoints` 回来的是 `[手·左, 手·右, 脚·左, 脚·右]` 里「识别到的那些」，
   * 一只手没识别到时数组会前移 —— 以前「脚·左」就顶进了第一个位置（side 还叫 L），
   * 于是「一组结束」的两个圆环和猫爪指针都会把**一只脚**当成手掌来画。
   */
  return touchPoints(landmarks, stageW, stageH, mirror).filter((p) => p.kind === 'hand');
}

/** 舞台的像素尺寸（没有布局信息时按 16:9 的默认值兜底，测试桩里也能跑） */
function stageSize() {
  const stage = $('stage');
  const w = stage?.clientWidth || 0;
  const h = stage?.clientHeight || 0;
  if (w > 0 && h > 0) return { w, h };
  return { w: 1280, h: 720 };
}

/* ------------------------------------------------------------------ *
 * 手机 / 平板适配：设备档位 → 默认模型 / 摄像头分辨率；视口单位；安全区；竖屏提示
 *
 * 全部按「纯函数 + 一个读取真实环境的壳」来写：给一组环境值就能断言结论，
 * 真机上的取值由 `deviceEnv()` 负责。PC 上的结论必须与改造前完全一致（档位 = high）。
 * ------------------------------------------------------------------ */

const PHONE_UA = /iPhone|iPod|Android.*Mobile|Windows Phone|BlackBerry|Opera Mini/i;
const TABLET_UA = /iPad|Android(?!.*Mobile)|Tablet|Silk/i;

/**
 * 设备类别（纯函数）：`phone` / `tablet` / `desktop`。
 * 除了 UA，还认「触摸屏 + 小屏」这条兜底 —— iPadOS 的 Safari 会把自己报成 Mac，
 * 但它的屏幕最小边是 768，所以不会被误判成手机（PC 行为不受影响）。
 */
function deviceClass(env = {}) {
  const ua = String(env.ua || '');
  if (PHONE_UA.test(ua)) return 'phone';
  // 「触摸屏 + 小屏」比 UA 更靠谱（有些 Android 浏览器 UA 里没有 Mobile 字样）：
  // 屏幕最小边 ≤500 的触摸设备按手机对待。PC 的屏幕最小边远大于 500，不会误判。
  const minSide = Number(env.screenMin || 0);
  if (Number(env.maxTouchPoints || 0) > 0 && minSide > 0 && minSide <= 500) return 'phone';
  if (TABLET_UA.test(ua)) return 'tablet';
  return 'desktop';
}

/** 真实环境里读一遍判定要用的值（测试可以完全绕开它，自己造 env） */
function deviceEnv() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const win = typeof window !== 'undefined' ? window : {};
  const sw = Number(win.screen?.width) || Number(win.innerWidth) || 0;
  const sh = Number(win.screen?.height) || Number(win.innerHeight) || 0;
  return {
    ua: String(nav.userAgent || ''),
    maxTouchPoints: Number(nav.maxTouchPoints || 0),
    hardwareConcurrency: Number(nav.hardwareConcurrency || 0),
    deviceMemory: Number(nav.deviceMemory || 0),
    width: Number(win.innerWidth || 0),
    height: Number(win.innerHeight || 0),
    screenMin: sw && sh ? Math.min(sw, sh) : 0,
  };
}

/**
 * 性能档位（纯函数）：`low` 表示「按手机的省电口径来」。
 * 手机一律 low（屏幕小、又要靠电池练十几分钟）；平板只有四核以下才算 low；
 * 电脑上只有 ≤2 核的老机器才算 low —— 正常 PC 仍是 `high`，行为和以前一模一样。
 */
function perfTier(env = {}) {
  const cls = deviceClass(env);
  const cores = Number(env.hardwareConcurrency || 0);
  if (cls === 'phone') return 'low';
  if (cls === 'tablet' && cores > 0 && cores <= 4) return 'low';
  if (cores > 0 && cores <= 2) return 'low';
  return 'high';
}

/**
 * 首次打开时该用哪个识别模型（纯函数）：手机 / 低配 → `lite`；其余返回 null = **不改动**。
 * ⚠️ 用户自己在设置里选过（`settings.modelKeySet`）时调用方根本不会问到这里 —— 见 applyDeviceDefaults。
 */
function pickDefaultModelKey(env = {}) {
  return perfTier(env) === 'low' ? 'lite' : null;
}

/** 要不要请用户「把手机横过来」（纯函数）：只有手机 + 竖屏才提示，电脑 / 平板不打扰 */
function shouldSuggestRotate(env = {}) {
  if (deviceClass(env) !== 'phone') return false;
  const w = Number(env.width || 0);
  const h = Number(env.height || 0);
  return h > 0 && w > 0 && h > w;
}

/**
 * 竖屏遮罩**这一刻**该不该亮（手机 + 竖屏 + 在动作页）。
 *
 * 为什么还要看 `homeMode`：竖屏浏览主页的动作库完全没问题，一进站就被整屏遮住太凶；
 * 只有进到动作页（要摄像头、要横向画面）才提示横过来。
 */
function rotateGateWanted(env = deviceEnv()) {
  return shouldSuggestRotate(env) && !state.homeMode;
}

/**
 * 刘海 / 底部横条的像素值：CSS 里定义了 `--safe-*`（`env(safe-area-inset-*)`），
 * JS 侧（右上角退出圆环是自己按像素定位的）读出来用。
 * 读不到（老浏览器 / 测试桩）时一律当 0，绝不让定位算错。
 */
function safeAreaInsets() {
  const zero = { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return zero;
  try {
    const cs = window.getComputedStyle(document.documentElement);
    const px = (name) => {
      const n = parseFloat(String(cs.getPropertyValue(name) || '').replace(/px\s*$/, ''));
      return Number.isFinite(n) ? n : 0;
    };
    return { top: px('--safe-top'), right: px('--safe-right'), bottom: px('--safe-bottom'), left: px('--safe-left') };
  } catch {
    return zero;
  }
}

/**
 * 视口高度兜底：把「当前真实可用高度 / 100」写进 `--vh`。
 *
 * iOS 的地址栏会伸缩：`100vh` 永远是「地址栏收起后」的高度，地址栏在的时候页面底部会被顶出屏幕。
 * CSS 那边优先用 `100dvh`，但 dvh 只有较新的 Safari 支持 —— 所以 JS 再补一层实测值。
 * 返回算出来的高度（0 = 拿不到，此时不改 CSS）。
 */
function syncViewportUnit() {
  const win = typeof window !== 'undefined' ? window : {};
  const vv = win.visualViewport;
  const h = Number((vv && vv.height) || win.innerHeight || 0);
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (root && root.style && typeof root.style.setProperty === 'function' && h > 0) {
    root.style.setProperty('--vh', `${(h / 100).toFixed(2)}px`);
  }
  return h;
}

/**
 * 给 `<body>` 打上设备类名、按需亮出「请把手机横过来」遮罩。
 *
 * 类名（供样式用）：`is-phone` / `is-tablet` / `is-portrait` / `is-landscape`。
 * 竖屏遮罩盖住画面时，正在练的那一组先暂停 —— 遮住了还在跑只会让用户白做。
 */
function syncDeviceClasses(env = deviceEnv()) {
  const cls = deviceClass(env);
  const portrait = shouldSuggestRotate(env);
  const gate = rotateGateWanted(env);
  const body = typeof document !== 'undefined' ? document.body : null;
  if (body && body.classList) {
    body.classList.toggle('is-phone', cls === 'phone');
    body.classList.toggle('is-tablet', cls === 'tablet');
    body.classList.toggle('is-portrait', portrait);
    body.classList.toggle('is-landscape', cls === 'phone' && !portrait);
  }
  const gateEl = $('rotateGate');
  if (gateEl) gateEl.hidden = !gate;
  if (gate && state.session === 'running') pauseSession();
  return { cls, portrait, gate };
}

/**
 * 首次进入时的「省电默认值」：手机 / 低配机器默认用轻量模型。
 * **用户自己选过模型就永不覆盖** —— 这是用户明确要求的那条（`modelKeySet`）。
 */
function applyDeviceDefaults(env = deviceEnv()) {
  if (state.settings.modelKeySet) return null;
  const want = pickDefaultModelKey(env);
  if (!want || want === state.settings.modelKey) return null;
  state.settings.modelKey = want;
  saveSettings();
  return want;
}

/**
 * 圆环里的标签：**只画图标、不写字**（用户要求：「把圆环中的文字退出和再试一次都改为图标表示，
 * 退出图标可以和返回图标一致，『再试一次』需要设计一个新的图标」）。
 *
 *   - 退出 = 和「返回」同一颗线条箭头（Lucide \`corner-up-left\`，和手势菜单里那颗完全一致）；
 *   - 再试一次 = 新加的 \`ui:retry\`（Lucide \`rotate-ccw\`，逆时针圆箭头，通用的「重来」符号）；
 *   - **设置** = 现成的 \`ui:settings\`（Lucide \`settings\` 齿轮，主页那个 ⚙️ 用的就是它，
 *     **不是 emoji**）—— 用户要求设置环「图标用项目既有的线条图标」。
 *
 * 文字含义移到按钮的 \`title\` / \`aria-label\` 上 —— 鼠标悬停和读屏仍然知道是「退出」还是「再做一次」。
 */
const RING_ICON_KEY = { exit: 'back', back: 'back', retry: 'ui:retry', settings: 'ui:settings' };

function setRingIcon(labelEl, btnEl, kind, text) {
  const key = RING_ICON_KEY[kind] || 'back';
  if (labelEl) {
    labelEl.innerHTML = libIconSVG(key, 'ex-pose');
    labelEl.classList?.add('ring-label--icon');
  }
  if (btnEl) {
    btnEl.setAttribute('title', text);
    btnEl.setAttribute('aria-label', text);
  }
}

/** 摆好两个圆环的位置（一处定义：位置和大小都来自 GESTURE_RINGS / RING_SIZE） */
function layoutGestureRings() {
  for (const key of Object.keys(GESTURE_RINGS)) {
    const el = ringEl(key);
    if (!el) continue;
    el.style.left = `${GESTURE_RINGS[key].x * 100}%`;
    el.style.top = `${GESTURE_RINGS[key].y * 100}%`;
    el.style.width = `${RING_SIZE * 100}%`;
  }
  layoutCornerRing();
}

/**
 * 把一颗「退出 / 返回」圆环摆到右上角（**唯一摆法**）。
 *
 * 动作页的退出圆环（`layoutCornerRing`）和手势菜单的返回圆环（`layoutMenu` 末尾）都调它，
 * 位置 / 直径全部来自 `exitRingLayout()` —— 所以两者在屏幕上同坐标、同尺寸。
 */
function layoutExitRing(el, size = stageSize()) {
  if (!el) return;
  // ⚠️ 先清掉行内尺寸再量：行内 px 会盖住 CSS 的 `--ring-px`，如果不清，
  // 上一次量到的旧尺寸会被一直沿用 —— 窗口一改大小（或跨过小屏断点）圆环就不跟着变了，
  // 于是又和 HUD 那个进度圆环不一样大（这正是用户反馈的那个「看起来小一圈」）。
  el.style.width = '';
  el.style.height = '';
  const g = exitRingLayout(size);
  el.style.left = `${g.cx}px`;
  el.style.top = `${g.cy}px`;
  el.style.width = `${g.px}px`;
  el.style.height = `${g.px}px`;
}

/**
 * 把右上角那颗「**设置**」圆环摆到退出圆环**正下方**（唯一摆法）。
 *
 * 位置 / 直径全部来自 `settingsRingLayout()`（= `ringCenter('settings')` + 退出环那一份尺寸），
 * 所以绘制坐标与判定圆心是同一个数；和 `layoutExitRing()` 一样**先清行内尺寸再量**，
 * 免得旧 px 把直径钉住、和退出环不再等大。
 */
function layoutSetRing(el, size = stageSize()) {
  if (!el) return;
  el.style.width = '';
  el.style.height = '';
  const g = settingsRingLayout(size);
  el.style.left = `${g.cx}px`;
  el.style.top = `${g.cy}px`;
  el.style.width = `${g.px}px`;
  el.style.height = `${g.px}px`;
}

/** 右上角两颗圆环（退出 + 设置）的位置（右上角、退出环下方；全屏/横竖屏切换后要重摆） */
function layoutCornerRing() {
  layoutExitRing(ringEl('corner'));
  layoutSetRing(ringEl('settings'));
  // 「设置」选择层开着时窗口变了：中间那一排圆环也要按新尺寸重新摆一遍
  if (state.setPickerOpen) renderSetPicker();
}

function ringEl(key) {
  if (key === 'corner') return $('ringQuickExit');
  if (key === 'settings') return $('ringQuickSet');
  if (key === 'hud') return $('hudRing');
  return $(key === 'exit' ? 'ringExit' : 'ringRetry');
}

/** 右上角退出圆环上那个「退出」图标 / 计时器的元素 */
function cornerLabelEl() { return $('ringQuickExitLabel'); }

/** 一组做完 → 亮出两个圆环，并提示怎么用（语音 + 屏幕上方的提示条） */
function showGestureRings({ speak = true } = {}) {
  const box = $('gestureRings');
  if (!box) return;
  layoutGestureRings();
  const labels = ['exit', 'retry'];
  for (const key of labels) {
    const el = ringEl(key);
    const st = gestureState[key];
    st.p = 0; st.since = 0; st.lastInside = 0; st.done = false;
    el?.classList.remove('dwelling', 'done');
    setRingIcon($(key === 'exit' ? 'ringExitLabel' : 'ringRetryLabel'), el, key, t(GESTURE_RINGS[key].labelKey));
    const timer = $(GESTURE_RINGS[key].timerId);
    if (timer) timer.textContent = '';
    paintRing(key, 0);
  }
  box.hidden = false;
  // 「一组结束」的两个圆环已经给了退出/再做一次 → 右上角那个常驻圆环先收起来，别重复
  hideCornerExit();
  const hint = $('gestureHint');
  if (hint) {
    hint.textContent = t('ui.gestureHint');
    hint.hidden = false;
  }
  gestureState.visible = true;
  // 语音提示晚一点念：紧接着上一句「本组成绩」说会被听成一句，等它念完再说怎么用手势
  if (speak) {
    setTimeout(() => {
      if (gestureState.visible) audio.say(t('ui.gestureVoice'), { rate: 1.05 });
    }, 2600);
  }
}

function hideGestureRings() {
  const box = $('gestureRings');
  if (box) box.hidden = true;
  const hint = $('gestureHint');
  if (hint) hint.hidden = true;
  gestureState.visible = false;
  for (const key of ['exit', 'retry']) {
    const st = gestureState[key];
    st.p = 0; st.since = 0; st.lastInside = 0; st.done = false;
    ringEl(key)?.classList.remove('dwelling', 'done');
  }
  // 右上角那个常驻圆环的显示/隐藏由「摄像头开着没有」决定（每帧同步，见 syncCornerExit）
  syncCornerExit();
}

/** 圆环的进度：顺时针走满一圈（dashoffset 从满到 0） */
function paintRing(key, p) {
  const el = ringEl(key);
  if (!el) return;
  const circle = el.querySelector?.('.ring-fill');
  const clamped = clamp(p, 0, 1);
  if (circle) circle.style.strokeDashoffset = String(326.7 * (1 - clamped));
  const st = gestureState[key];
  el.classList.toggle('dwelling', clamped > 0.001 && !st.done);
  if (st.done) el.classList.add('done');
}

/** 手/脚在不在这个圆环的中央（判定半径由 ringHitRadius 决定，每个环自己的口径） */
function handInRing(points, key, size) {
  const c = ringCenter(key, size.w, size.h);
  const hit = ringHitRadius(key, size);
  return points.some((p) => Math.hypot(p.x - c.x, p.y - c.y) <= hit);
}

/**
 * 每帧更新两个圆环的进度。返回这一帧是否触发了某个动作（触发时圆环已经收起来）。
 * 只要有一只手停在圆环中央满 GESTURE_HOLD_MS 就触发；两只手各停一个环也行。
 */
function updateGesture(landmarks, now) {
  if (!gestureState.visible) return null;
  const size = stageSize();
  const palms = palmPoints(landmarks, size.w, size.h, state.settings.mirror);
  let fired = null;
  for (const key of ['exit', 'retry']) {
    const st = gestureState[key];
    if (st.done) continue;
    const inside = handInRing(palms, key, size);
    if (inside) {
      st.lastInside = now;
      if (!st.since) st.since = now;
      st.p = clamp((now - st.since) / GESTURE_HOLD_MS, 0, 1);
    } else if (now - st.lastInside > GESTURE_GRACE_MS) {
      st.since = 0;
      st.p = Math.max(0, st.p - 0.06);   // 轻轻退回去，看得出「手离开了」
    }
    paintRing(key, st.p);
    const timer = $(GESTURE_RINGS[key].timerId);
    if (timer) {
      const left = Math.max(0, GESTURE_HOLD_MS - (now - st.since)) / 1000;
      timer.textContent = st.p > 0.02 && st.p < 1 ? `${left.toFixed(1)}s` : '';
    }
    if (st.p >= 1) {
      st.done = true;
      paintRing(key, 1);
      fired = key;
    }
  }
  if (fired) triggerGesture(fired);
  return fired;
}

/**
 * 右上角的常驻「退出」圆环：显示 / 隐藏。
 *
 * 显示时机（用户要求）：**只在摄像头开着的时候**（`camera.active`）摆出来 —— 摄像头没开、
 * 或者出错了，圆环就没意义（手/脚也识别不到）。摄像头开着时在校准 / 倒计时 / 计数中 / 暂停
 * 都一直摆着，手或脚伸进去停 3 秒就能退出，不用去够按钮。
 * 「一组结束」的两个大圆环出来时收起来（那儿已经有「退出」了）。
 * 这一同步在每一帧做（`syncCornerExit`），所以摄像头一开一关它自己跟着出现/消失。
 */
function showCornerExit() {
  const box = $('cornerExit');
  if (!box || gestureState.cornerVisible) return;
  const st = gestureState.corner;
  st.p = 0; st.since = 0; st.at = 0; st.lastInside = 0; st.done = false;
  ringEl('corner')?.classList.remove('dwelling', 'done', 'near');
  resetSetRing();                 // 「设置」环（就在退出环正下方）也从 0 开始
  const label = cornerLabelEl();
  // 圆环里只画图标（和「返回」同一颗线条箭头），文字在 title / aria-label 上
  setRingIcon(label, ringEl('corner'), 'exit', t('ui.gestureExit'));
  // 「设置」环：同样是线条图标（齿轮 `ui:settings`，和主页那颗 ⚙️ 同一个形状），文字在 title / aria-label
  setRingIcon($('ringQuickSetLabel'), ringEl('settings'), 'settings', t('ui.gestureSet'));
  const timer = $('ringQuickExitTimer');
  if (timer) timer.textContent = '';
  const setTimer = $('ringQuickSetTimer');
  if (setTimer) setTimer.textContent = '';
  paintRing('corner', 0);
  paintRing('settings', 0);
  // ⚠️ 顺序很重要：**先显示再量尺寸**。元素还在 `display: none` 时 `clientWidth` 是 0，
  // 量到的是兜底值，那个值会被写进行内 width/height —— 于是圆环会一直比 HUD 那个进度圆环小一圈
  // （用户反馈「退出圆环放大一点，大小和 HUD 的进度圆环保持一样大小」就是这个原因）。
  box.hidden = false;
  gestureState.cornerVisible = true;
  layoutCornerRing();
}

function hideCornerExit() {
  const box = $('cornerExit');
  if (box) box.hidden = true;
  gestureState.cornerVisible = false;
  const st = gestureState.corner;
  st.p = 0; st.since = 0; st.at = 0; st.lastInside = 0; st.done = false;
  ringEl('corner')?.classList.remove('dwelling', 'done', 'near');
  resetSetRing();
  closeSetPicker();   // 圆环收起来了，中间那一层选择圆环也不该继续挂着
  state.touchInfo = null;
}

/**
 * 把右上角退出圆环的显示状态与「摄像头开着没有」对齐（每帧调用，很便宜）。
 * 条件：摄像头开着 + 不在主页 + **不在手势菜单里** + 「一组结束」的两个大圆环没摆着。
 *
 * 手势菜单里**不显示**这个圆环（用户要求：「在第一级菜单选择页面去掉『退出』圆环，
 * 增加一个『返回』圆环」）：菜单每一级都有一格「↩ 返回」负责往上一层 / 回网页首页，
 * 右上角那个「退出」只在**动作里**用（退出这一组 → 回菜单）。
 */
function syncCornerExit() {
  const want = !!camera.active && !state.homeMode && !state.menuMode && !gestureState.visible;
  if (want === gestureState.cornerVisible) return;
  if (want) showCornerExit(); else hideCornerExit();
}

/**
 * 每帧更新右上角退出圆环：**手或脚的任意一部分**进到圆环里、保持满 GESTURE_HOLD_MS 就退出。
 * 进度与动画完全复用中间那两个圆环的那一套（paintRing / 同一组常量）。
 *
 * 判定口径（用户要求）：「手掌或脚的一部分进入就要开始沙漏计时，保持 3 秒后退出，
 * **一部分进入即可触发**」，后来又补了「**只要脚尖进入圆环就要开始沙漏计时**，现在感觉要脚踝进入才开始计时」。
 * 所以现在是三层一起判（见 touchSamples / anyTouchInRing）：
 *   1. 逐点 —— 指尖 / 脚跟 / 脚趾尖 / 脚踝 / 手腕，任意一个点落在圆环里；
 *   2. 逐段 —— 同一条手/脚上的点连成线段，圆环和线段相交也算（**脚尖在环里、脚踝在环外**就是这样被抓住的）；
 *   3. 脚尖点量不到时用**估算的脚尖**（`ghost`），脚伸到画面角落（圆环所在的位置）时这一步很关键。
 *
 * 之前几次放宽的历史见 RING_HIT_RATIO / TOUCH_VIS_MIN / FOOT_VIS_MIN / GESTURE_DRAIN_MS 的注释。
 * 「手/脚现在在哪、离圆心多远、是哪个部位进的环」记进 `state.touchInfo`，🐞 面板会显示。
 */
function updateCornerExit(landmarks, now) {
  const size = stageSize();
  const samples = touchSamples(landmarks, size.w, size.h, state.settings.mirror);
  if (!gestureState.cornerVisible) { state.touchInfo = null; return false; }
  const st = gestureState.corner;
  if (st.done) { state.touchInfo = null; return false; }
  // 逐点 + 逐段判定：任意一个采样点、或者整只脚/手连成的线段碰到圆环，就算「手/脚进去了」
  const res = anyTouchInRing(samples, 'corner', size);
  const { inside, best, bestSeg, minDist, pointIn, spanIn } = res;
  const hit = res.hit;
  const near = Number.isFinite(minDist) && minDist <= hit * RING_NEAR_FACTOR;
  const inCount = pointsInRing(samples, 'corner', size);
  state.touchInfo = best
    ? {
      has: true,
      kind: best.p.kind,
      part: best.p.part,
      side: best.p.side,
      ghost: !!best.p.ghost,         // 这个点是**估算**的脚尖（真实的没量到）
      x: best.p.x / size.w,
      y: best.p.y / size.h,
      rel: minDist / (hit || 1),     // 离圆心几个「判定半径」（<1 = 在环里）
      inCount,                       // 有几个采样点进环了（>1 = 结论更稳）
      inside,
      near,
      via: pointIn ? 'point' : (spanIn ? 'span' : 'none'),   // 靠点还是靠「整只脚那一段」进的环
      span: spanIn && bestSeg ? { d: bestSeg.d, from: bestSeg.a.part, to: bestSeg.b.part } : null,
    }
    : { has: false, inside: false, near: false, via: 'none' };

  const dt = clamp(now - (st.at || now), 0, 250);
  st.at = now;
  if (inside) {
    st.lastInside = now;
    st.p = clamp(st.p + dt / GESTURE_HOLD_MS, 0, 1);
  } else if (now - st.lastInside > GESTURE_GRACE_MS) {
    // 离开超过宽限期：**慢慢退回去**（1.5 秒退完一圈），不再一秒清零
    st.p = Math.max(0, st.p - dt / GESTURE_DRAIN_MS);
  }
  const el = ringEl('corner');
  if (el) el.classList.toggle('near', near && !inside);
  paintRing('corner', st.p);
  const timer = $('ringQuickExitTimer');
  if (timer) {
    const left = Math.max(0, GESTURE_HOLD_MS * (1 - st.p)) / 1000;
    timer.textContent = st.p > 0.02 && st.p < 1 ? `${left.toFixed(1)}s` : '';
  }
  if (st.p >= 1) {
    st.done = true;
    paintRing('corner', 1);
    return true;
  }
  return false;
}

/** 右上角圆环触发：退出这一组（和「一组结束后」的退出圆环同一个动作） */
/**
 * 右上角退出圆环触发。
 *
 * 用户要求（全手势流程）：「在各项运动中如果退出，则回到菜单页面，如果在菜单界面退出则回到网页首页。」
 * 后来菜单里改由「↩ 返回」圆环负责往上一层 / 回网页首页（右上角这个圆环在菜单里不再显示），
 * 所以它现在的活是：**训练界面里 → 回手势菜单**（这一组照常收尾结算，记录照旧保存）。
 * `menuMode` 那一支留着当兜底（万一菜单里又出现这个圆环，行为仍然是回网页首页）。
 */
function triggerCornerExit() {
  if (gestureState.corner.done && !gestureState.cornerVisible) return;
  gestureState.corner.done = true;
  paintRing('corner', 1);
  audio.milestone();
  const toHome = state.menuMode;
  audio.say(t('ui.gestureExit'), { rate: 1.1, force: true });
  hideCornerExit();
  if (toHome) showHome();
  else openMenu({ silent: true });
}

/* ------------------------------------------------------------------ *
 * 右上角「设置」圆环（就在退出环**正下方**）+ 屏幕中间那一层「每组次数 / 每组秒数」圆环
 *
 * 用户要求（原话）：「在每一个运动的页面的右上角『退出』圆环**下方**增加一个『**设置**』圆环，
 *   当用户选择之后，在**界面中间出现多个圆环**，让用户选择该运动**每组运动的次数或者秒数**，
 *   比如在俯卧撑界面，则选择每组多少次，在平板支撑界面，则选择多少秒。」
 *
 * 三段：
 *   ① 「设置」环本人 —— 位置 / 直径 / 判定都从 `settingsRingLayout()`（= `ringCenter('settings')`）
 *      这一处取，和退出环同尺寸、同中心线、只在它正下方；交互与退出环**完全一样**
 *      （手/脚任意一部分进环停满 `GESTURE_HOLD_MS` 就触发，鼠标 / 触摸点它也行）；
 *   ② 屏幕中间那一层圆环 —— 计数类动作给 `SET_REP_CHOICES`（每组次数），
 *      计时类给 `SET_SEC_CHOICES`（每组秒数）；每颗环里是「大号数字 + 小号单位」，
 *      当前值高亮；点一下或者手掌停满 3 秒就选中；
 *   ③ 选中后只写**这个动作自己那一份**（`settings.targets[id]` / `settings.seconds[id]`，
 *      见 `setTarget`）—— 正在练的就是它时 HUD 目标文案立刻跟着变并持久化，没有新造存储。
 *
 * 关掉的方式有三个（用户要求「明显的关闭 / 取消方式」）：点空白处、按 `Esc`、再点一次「设置」环。
 * ------------------------------------------------------------------ */

/** 「设置」环自己的蓄力进度（和退出环同一套时间口径，但**各自独立**，互不干扰） */
function resetSetRing() {
  const st = gestureState.settings;
  st.p = 0; st.since = 0; st.at = 0; st.lastInside = 0; st.done = false;
  ringEl('settings')?.classList.remove('dwelling', 'done', 'near');
  const timer = $('ringQuickSetTimer');
  if (timer) timer.textContent = '';
}

/**
 * 每帧更新「设置」环：手 / 脚**任意一部分**进环、保持满 `GESTURE_HOLD_MS` → 打开中间那一层选择圆环。
 *
 * 判定与绘制同一份数：圆心来自 `ringCenter('settings')`（= 退出环圆心 + 直径 + 间距），
 * 半径来自 `ringHitRadius('settings')`（= 画出来的半径 × `RING_TOUCH_TOL`，和退出环同一档宽容度）。
 * 显隐跟着退出环走（同一个容器 `#cornerExit`、同一个 `cornerVisible`）：
 * 摄像头没开、菜单里、或者「一组结束」的两个大圆环摆着的时候，两颗环一起收起来。
 */
function updateSetRing(landmarks, now) {
  if (!gestureState.cornerVisible) return false;
  const st = gestureState.settings;
  const size = stageSize();
  const samples = touchSamples(landmarks, size.w, size.h, state.settings.mirror);
  const res = anyTouchInRing(samples, 'settings', size);
  const dt = clamp(now - (st.at || now), 0, 250);
  st.at = now;
  if (st.done) {
    // 已经触发过：手 / 脚先离开这颗环，才重新武装（否则停在环里会每 3 秒开 / 关一次）
    if (!res.inside) {
      st.done = false;
      st.p = 0;
      st.since = 0;
      st.lastInside = now;
      const el = ringEl('settings');
      if (el) el.classList.remove('dwelling', 'done', 'near');
      paintRing('settings', 0);
    }
    return false;
  }
  if (res.inside) {
    st.lastInside = now;
    st.p = clamp(st.p + dt / GESTURE_HOLD_MS, 0, 1);
  } else if (now - st.lastInside > GESTURE_GRACE_MS) {
    st.p = Math.max(0, st.p - dt / GESTURE_DRAIN_MS);
  }
  const el = ringEl('settings');
  if (el) {
    const near = Number.isFinite(res.minDist) && res.minDist <= res.hit * RING_NEAR_FACTOR;
    el.classList.toggle('near', near && !res.inside);
  }
  paintRing('settings', st.p);
  const timer = $('ringQuickSetTimer');
  if (timer) {
    const left = Math.max(0, GESTURE_HOLD_MS * (1 - st.p)) / 1000;
    timer.textContent = st.p > 0.02 && st.p < 1 ? `${left.toFixed(1)}s` : '';
  }
  if (st.p >= 1) {
    st.done = true;
    paintRing('settings', 1);
    return true;
  }
  return false;
}

/**
 * 「设置」环触发（手/脚停满 3 秒，或者鼠标 / 触摸点它）：**开 / 关切换**中间那一层选择圆环。
 * 「再点一次设置环」也是用户要的关闭方式之一，所以这里是 toggle 而不是单纯 open。
 */
function triggerSetRing() {
  const st = gestureState.settings;
  audio.milestone();
  if (state.setPickerOpen) closeSetPicker();
  else openSetPicker();
  // ⚠️ 「已触发」要在 open / close **之后**再写：closeSetPicker() 里会 resetSetRing（把 done 清掉），
  // 而这里必须把它重新立起来 —— 手 / 脚先离开圆环才会重新武装，否则一直停在环里会每 3 秒开 / 关一次。
  st.done = true;
  st.p = 1;
  st.since = 0;
  paintRing('settings', 1);
  return state.setPickerOpen;
}

/* ---------------- 中间那一层选择圆环的版面（一处定义：绘制 / 判定 / 测试都读它） ---------------- */

/** 圆环之间的间距（像素） */
const SET_CHOOSER_GAP_PX = 14;
/** 左右各留这么多边距（圆环不会贴到画面边上） */
const SET_CHOOSER_PAD_X = 16;
/** 上方留给标题 / 提示、下方留给关闭按钮的高度上限（屏幕矮的时候按比例收，见 setChooserLayout） */
const SET_CHOOSER_PAD_TOP = 64;
const SET_CHOOSER_PAD_BOTTOM = 84;
/**
 * 上下留白的**下限**：屏幕上再矮也不能把标题（「每组次数 · 当前 12 次」）和关闭按钮压到圆环上 ——
 * 54px 刚好放下一行标题（6 + 约 26px）+ 一行提示（36 → 52），68px 刚好放下 44px 高的关闭按钮。
 */
const SET_CHOOSER_PAD_TOP_MIN = 54;
const SET_CHOOSER_PAD_BOTTOM_MIN = 68;
/** 一颗圆环最大 / 最小直径：最小 44px 是「触屏热区 ≥44px」那条无障碍底线 */
const SET_CHOOSER_MAX_PX = 132;
const SET_CHOOSER_MIN_PX = 44;
/** 想排成「一整排」时每颗至少要有这么大（排不下就退成 4 列 / 3 列 / 2 列） */
const SET_CHOOSER_ONE_ROW_MIN_PX = 88;
/**
 * 一页最多排几个格子（**同一排里 5 个选项 + 2 个箭头 = 7 个环**）。
 * 以前是 6（一页就 6 个选项、没有箭头），现在一页固定 5 个选项，两端各加一颗箭头，所以放到 7。
 */
const SET_CHOOSER_ONE_ROW_MAX = SET_PICKER_PER_PAGE + 2;

/** 上方留给标题 / 提示的那一条（矮屏按比例收，但有下限 —— 见 SET_CHOOSER_PAD_TOP_MIN） */
function chooserPadTop(size = stageSize()) {
  return clamp(Math.round(size.h * 0.16), SET_CHOOSER_PAD_TOP_MIN, SET_CHOOSER_PAD_TOP);
}

/** 下方留给关闭按钮的那一条（同理） */
function chooserPadBottom(size = stageSize()) {
  return clamp(Math.round(size.h * 0.2), SET_CHOOSER_PAD_BOTTOM_MIN, SET_CHOOSER_PAD_BOTTOM);
}

/**
 * 按 `cols` 列摆 `count` 颗时，每颗最多能有多大（取「宽度够不够」与「高度够不够」的较小者）。
 * 宽 / 高都要看 —— 否则窄屏上按宽度能排 4 列、高度却只放得下 2 行，圆环会顶出画面。
 */
function setChooserCellFor(cols, count, size = stageSize()) {
  const n = Math.max(1, Math.round(Number(count) || 0));
  const c = Math.max(1, Math.round(Number(cols) || 0));
  const rows = Math.ceil(n / c);
  const availW = Math.max(0, size.w - 2 * SET_CHOOSER_PAD_X);
  const availH = Math.max(0, size.h - chooserPadTop(size) - chooserPadBottom(size));
  const byW = (availW - SET_CHOOSER_GAP_PX * (c - 1)) / c;
  const byH = (availH - SET_CHOOSER_GAP_PX * (rows - 1)) / rows;
  return Math.min(byW, byH);
}

/**
 * 这一层用几列：
 *   ① 先尽量排成**一整排**（一页 7 颗 = 5 选项 + 2 箭头，宽屏 1280×720 上一排正好摆开）；
 *   ② 排不成一排就退成 **4 列**（7 颗 → 4 + 3 两行，小屏上比 3 + 3 + 1 三行大得多）；
 *   ③ 再不行 3 列 / 2 列，最后一列。
 * 宽度按「一排能不能放下」判；退成网格时还要求**整块网格按 44px 的最小直径也塞得进舞台高度**
 * （否则宁可用更少的列数、更多的行 —— 反正不会把圆环顶出画面）。
 * 这样同一层里每颗圆环永远等大（和手势菜单「每页圆环一样大」同一个原则）。
 */
function setChooserCols(count, size = stageSize()) {
  const n = Math.max(1, Math.round(Number(count) || 0));
  const availW = Math.max(0, size.w - 2 * SET_CHOOSER_PAD_X);
  const fitW = (cols) => (availW - SET_CHOOSER_GAP_PX * (cols - 1)) / cols;
  const oneRow = Math.min(n, SET_CHOOSER_ONE_ROW_MAX);
  if (fitW(oneRow) >= SET_CHOOSER_ONE_ROW_MIN_PX) return oneRow;
  for (const cols of [4, 3, 2]) {
    if (n <= cols || fitW(cols) < SET_CHOOSER_MIN_PX) continue;
    const rows = Math.ceil(n / cols);
    const blockH = rows * SET_CHOOSER_MIN_PX + SET_CHOOSER_GAP_PX * (rows - 1);
    if (chooserPadTop(size) + blockH > size.h) continue;   // 竖着塞不下 → 换更小的列数（行更多）
    return cols;
  }
  return 1;
}

/**
 * 中间那一层选择圆环的**完整版面**（纯函数，测试直接调它断言「大屏小屏都不越界」）。
 *
 * 返回 `{ cols, rows, gap, cell, gw, gh, left, top, items }`，其中 `items[i] = { i, cx, cy, px }`
 * 是**舞台像素坐标**（和 `ringCenter()` / `layoutExitRing()` 同一套口径）：
 *   - 绘制：`renderSetPicker()` 把第 i 颗按钮摆到 `(cx, cy)`、宽高 `px`；
 *   - 判定：`updateSetPicker()` 用同一个 `(cx, cy)` 与 `px × RING_HIT_RATIO` 判手掌在不在环里。
 * 所以「看到哪就是判哪」，不会各说一套。
 */
function setChooserLayout(count, size = stageSize()) {
  const n = Math.max(1, Math.round(Number(count) || 0));
  const cols = setChooserCols(n, size);
  const rows = Math.ceil(n / cols);
  const gap = SET_CHOOSER_GAP_PX;
  // 屏幕矮的时候上下留白按比例收，但有**下限**：标题 / 提示 / 关闭按钮都不能压到圆环上
  const padTop = chooserPadTop(size);
  const padBottom = chooserPadBottom(size);
  const availW = Math.max(0, size.w - 2 * SET_CHOOSER_PAD_X);
  const availH = Math.max(0, size.h - padTop - padBottom);
  const cell = clamp(Math.floor(setChooserCellFor(cols, n, size)), SET_CHOOSER_MIN_PX, SET_CHOOSER_MAX_PX);
  const gw = cols * cell + gap * (cols - 1);
  const gh = rows * cell + gap * (rows - 1);
  const left = Math.round((size.w - gw) / 2);
  const top = Math.round(padTop + Math.max(0, (availH - gh) / 2));
  const items = [];
  for (let i = 0; i < n; i += 1) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    // 最后一行不满时整行居中（和手势菜单最后一页一样）
    const inRow = Math.min(cols, n - row * cols);
    const rowW = inRow * cell + gap * (inRow - 1);
    const rowLeft = left + (gw - rowW) / 2;
    items.push({
      i,
      row,
      col,
      px: cell,
      cx: rowLeft + col * (cell + gap) + cell / 2,
      cy: top + row * (cell + gap) + cell / 2,
    });
  }
  return { count: n, cols, rows, gap, cell, gw, gh, left, top, padTop, padBottom, items };
}

/** 这个动作选的是「每组次数」还是「每组秒数」：计时类，以及限时计数类，都是秒 */
function setPickerKindFor(id = state.exerciseId) {
  const ex = localizedExercise(id);
  if (!ex) return 'reps';
  return ex.kind === 'hold' || ex.timed ? 'seconds' : 'reps';
}

/**
 * 这个 kind 可选的数值（**一处定义**：`SET_REP_CHOICES` / `SET_SEC_CHOICES`）。
 *
 * ⚠️ 用户已经选过的值**必须留在列表里**：如果它不在这份预设里（比如以前版本选过 7 次、
 * 或者以后有人手动改了 localStorage），就把它**按大小插进去**，而不是让当前值凭空消失。
 * 顺手做排序 + 去重：列表永远升序、没有重复，翻页顺序才是可预期的。
 */
function setChoicesFor(kind, current = targetForExercise(state.exerciseId)) {
  const base = kind === 'seconds' ? SET_SEC_CHOICES : SET_REP_CHOICES;
  const list = [...new Set(base)].sort((a, b) => a - b);
  const n = Math.round(Number(current));
  if (Number.isFinite(n) && n > 0 && !list.includes(n)) {
    list.push(n);
    list.sort((a, b) => a - b);
  }
  return list;
}

/** 一共几页（一页 `SET_PICKER_PER_PAGE` 个选项；选项 ≤ 5 时就是 1 页、没有箭头） */
function setPickerPages(count = state.setPickerChoices.length) {
  const total = Math.max(1, Math.round(Number(count) || 0));
  return Math.max(1, Math.ceil(total / SET_PICKER_PER_PAGE));
}

/** `value` 落在第几页（`setPickerPageRings()` 的逆运算；找不到就回第 1 页） */
function setPickerPageOf(value, choices = state.setPickerChoices) {
  const idx = choices.indexOf(value);
  if (idx < 0) return 0;
  return Math.floor(idx / SET_PICKER_PER_PAGE);
}

/**
 * **当前这一页到底摆哪些圆环**（选项 + 两端的箭头）—— 绘制 / 判定 / 键盘 / 测试都读它这一份。
 *
 * 返回 `{ rings, page, pages, hasNav, first }`，`rings[i]` 的 `role` 只有三种：
 *   - `'prev'` / `'next'`：翻页箭头（`dir` = −1 / +1），**只有选项总数 > 5 时才出现**；
 *   - `'choice'`：一个可选数值（`value` = 数值，`index` = 在 `setPickerChoices` 里的下标）。
 * 排布顺序就是屏幕上从左到右的顺序：`[向前] 选项… [向后]`。
 */
function setPickerPageRings(page = state.setPickerPage) {
  const choices = state.setPickerChoices;
  const total = choices.length;
  const pages = setPickerPages(total);
  const at = clamp(Math.round(Number(page) || 0), 0, pages - 1);
  const first = at * SET_PICKER_PER_PAGE;
  const slice = choices.slice(first, first + SET_PICKER_PER_PAGE);
  const hasNav = total > SET_PICKER_PER_PAGE;
  const rings = [];
  if (hasNav) rings.push({ role: 'prev', dir: -1 });
  for (let i = 0; i < slice.length; i += 1) {
    rings.push({ role: 'choice', value: slice[i], index: first + i });
  }
  if (hasNav) rings.push({ role: 'next', dir: 1 });
  return { rings, page: at, pages, hasNav, first };
}

/** 把所有蓄力状态清干净（打开 / 关闭 / 翻页都走它，免得一行行抄） */
function resetSetPickerHold() {
  setPickerHold.idx = -1;
  setPickerHold.p = 0;
  setPickerHold.since = 0;
  setPickerHold.lastInside = 0;
  setPickerHold.at = 0;
}

/**
 * 翻页（`dir` = −1 是「向前」、+1 是「向后」）：**循环**，最后一页的「向后」回到第一页、
 * 第一页的「向前」绕到最后一页（选项是一个圆环状的刻度盘，夹在端点反而会让人以为翻不动了）。
 *
 * 只有一页时什么也不做（返回 −1）。翻完立刻重画那一排 —— 当前值高亮由 `renderSetPicker()`
 * 按**整份列表**重新判，所以切到当前值所在的页时会自动亮起来。
 */
function flipSetPickerPage(dir) {
  if (!state.setPickerOpen) return -1;
  const pages = setPickerPages();
  if (pages <= 1) return -1;
  const step = dir < 0 ? -1 : 1;
  state.setPickerPage = ((state.setPickerPage + step) % pages + pages) % pages;
  resetSetPickerHold();
  renderSetPicker();
  // 重建 DOM 之后把焦点还给**同一侧那颗箭头**（不清焦点的话，键盘 / 读屏用户翻一页就掉出来了）
  const role = step < 0 ? 'prev' : 'next';
  const grid = $('setPickerGrid');
  const btn = grid ? [...(grid.children || [])].find((b) => b?.dataset?.role === role) : null;
  btn?.focus?.({ preventScroll: true });
  return state.setPickerPage;
}

/** 选择层开着时手掌的蓄力状态（同一时刻只有一颗在蓄力） */
const setPickerHold = { idx: -1, p: 0, since: 0, lastInside: 0, at: 0 };

/** 把某颗选择圆环的蓄力进度画出来（和 `.ring-fill` 同一套 dashoffset 口径） */
function paintSetChoice(btn, p) {
  if (!btn) return;
  const clamped = clamp(p, 0, 1);
  const circle = btn.querySelector?.('.set-choice-fill');
  if (circle) circle.style.strokeDashoffset = String(326.7 * (1 - clamped));
  btn.classList?.toggle('dwelling', clamped > 0.001);
}

/**
 * 把中间那一层选择圆环画出来（数字环 = 一圈 + 大号数字 + 小号单位；箭头环 = 一圈 + 线条箭头）。
 *
 * 版面全部来自 `setChooserLayout()`：`left/top` 就是圆心（`.set-choice` 用
 * `transform: translate(-50%, -50%)` 定位，和 `.ring-btn` 一样），宽高就是圆环直径。
 * 一页摆什么由 `setPickerPageRings()` 决定（`[向前] + 最多 5 个选项 + [向后]`）。
 *
 * ⚠️ 行内字号也跟着直径算 —— 大屏的环里数字大、小屏的环里数字小，但都完整落在圈里。
 * ⚠️ 当前值高亮**按整份列表判**（不是按这一页）：所以翻到当前值所在的页时它会亮，
 *    翻到别的页时标题里那句「当前每组 12 次」仍然在（信息不丢）。
 */
function renderSetPicker({ focus = false } = {}) {
  if (!state.setPickerOpen) return null;
  const grid = $('setPickerGrid');
  if (!grid) return null;
  const size = stageSize();
  const unit = state.setPickerUnit;
  const current = targetForExercise(state.exerciseId);
  const info = setPickerPageRings();
  const layout = setChooserLayout(info.rings.length, size);
  const kind = state.setPickerKind;
  grid.innerHTML = '';
  const titleEl = $('setPickerTitle');
  if (titleEl) {
    // 标题 = 主题 + 当前值 +（有分页时）第几页：一行放下，当前值在翻页时也不会从视线里消失
    const pageText = info.pages > 1
      ? ` · ${t('ui.setPickerPage', { n: info.page + 1, total: info.pages })}`
      : '';
    titleEl.textContent = `${t(kind === 'seconds' ? 'ui.setPickerSeconds' : 'ui.setPickerReps')}`
      + ` · ${t('ui.setPickerCurrent', { n: current, unit })}` + pageText;
  }
  const hintEl = $('setPickerHint');
  if (hintEl) hintEl.textContent = t('ui.setPickerHint');
  const numPx = Math.max(14, Math.round(layout.cell * 0.36));
  const unitPx = Math.max(10, Math.round(layout.cell * 0.16));
  // 箭头和数字一样大：图标占直径的一半左右（小屏也看得清是「向前 / 向后」）
  const iconPx = Math.max(18, Math.round(layout.cell * 0.5));
  let currentBtn = null;
  for (let i = 0; i < info.rings.length; i += 1) {
    const ring = info.rings[i];
    const it = layout.items[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'set-choice';
    btn.dataset.idx = String(i);
    btn.style.left = `${it.cx}px`;
    btn.style.top = `${it.cy}px`;
    btn.style.width = `${it.px}px`;
    btn.style.height = `${it.px}px`;
    const ringSvg = '<svg class="set-choice-svg" viewBox="0 0 120 120" aria-hidden="true">'
      + '<circle class="set-choice-track" cx="60" cy="60" r="52"></circle>'
      + '<circle class="set-choice-fill" cx="60" cy="60" r="52"></circle>'
      + '</svg>';
    if (ring.role === 'choice') {
      const v = ring.value;
      btn.dataset.v = String(v);
      const label = t('ui.setPickerChoice', { n: v, unit });
      btn.innerHTML = ringSvg
        + `<span class="set-choice-num" style="font-size:${numPx}px">${v}</span>`
        + `<span class="set-choice-unit" style="font-size:${unitPx}px">${esc(unit)}</span>`;
      btn.classList.toggle('is-current', v === current);
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
      btn.setAttribute('aria-pressed', String(v === current));
      btn.addEventListener('click', () => chooseSetValue(v));
      if (v === current && !currentBtn) currentBtn = btn;
    } else {
      // 「向前 / 向后」：和选项环同尺寸、同一套蓄力圈，圈里只画线条箭头（不是 emoji、不是字体字形）
      const label = t(ring.role === 'prev' ? 'ui.setPickerPrev' : 'ui.setPickerNext');
      btn.classList.add('set-choice--arrow');
      btn.dataset.role = ring.role;
      btn.dataset.dir = String(ring.dir);
      btn.innerHTML = ringSvg
        + `<span class="set-choice-icon" aria-hidden="true" style="font-size:${iconPx}px">`
        + `${libIconSVG(ring.role, 'ex-pose')}</span>`;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
      btn.addEventListener('click', () => flipSetPickerPage(ring.dir));
    }
    grid.appendChild(btn);
  }
  // 键盘用户：打开时焦点落在「当前值」那一颗上，Tab / Shift+Tab 换选项、回车 / 空格选中
  if (focus) {
    const first = currentBtn || grid.children[0];
    first?.focus?.({ preventScroll: true });
  }
  return layout;
}

/** 打开中间那一层选择圆环（按**正在练的这个动作**决定是次数还是秒数） */
function openSetPicker() {
  if (state.homeMode || state.menuMode) return false;   // 只有动作页才有这颗圆环
  const id = state.exerciseId;
  const ex = localizedExercise(id);
  if (!ex) return false;
  const kind = setPickerKindFor(id);
  const current = targetForExercise(id);
  state.setPickerOpen = true;
  state.setPickerKind = kind;
  state.setPickerChoices = setChoicesFor(kind, current);
  state.setPickerUnit = ex.targetUnit;      // 和 HUD / 弹窗同一份单位（次 / 秒）
  // 打开就落在**当前值所在的那一页**（当前值在最后一页也不会让人先翻三页去找它）
  state.setPickerPage = setPickerPageOf(current, state.setPickerChoices);
  resetSetPickerHold();
  const box = $('setPicker');
  if (box) box.hidden = false;
  renderSetPicker({ focus: true });
  return true;
}

/** 关掉中间那一层选择圆环（点空白处 / Esc / 再点一次设置环 / 换动作 / 回主页都走它） */
function closeSetPicker() {
  const was = state.setPickerOpen;
  state.setPickerOpen = false;
  state.setPickerKind = '';
  state.setPickerChoices = [];
  state.setPickerPage = 0;
  state.setPickerUnit = '';
  resetSetPickerHold();
  const box = $('setPicker');
  if (box) box.hidden = true;
  const grid = $('setPickerGrid');
  if (grid) grid.innerHTML = '';
  resetSetRing();
  return was;
}

/**
 * 选中一个值：写进**这个动作自己那一份**（`setTarget` 里只有 `settings.targets` / `settings.seconds`），
 * 然后关掉选择层。改的正是当前动作时，HUD 左上角的目标文案（「20 次」/「45 秒」）会立刻跟着变，
 * 并且 `saveSettings()` 已经持久化了 —— 刷新页面还是这个数。
 */
function chooseSetValue(v) {
  if (!state.setPickerOpen) return 0;
  const n = setTarget(v, state.exerciseId);
  closeSetPicker();
  audio.milestone();
  return n;
}

/**
 * 每帧更新中间那一层选择圆环：手掌停在某一颗里满 `GESTURE_HOLD_MS` 就选中它
 * （停在两端的箭头上就是**翻页**，时间和选值一样 3 秒）。
 *
 * 判定半径 = 那颗圆环**画出来的半径**（`px × RING_HIT_RATIO`，和右上角那些环同一个口径），
 * 圆心就是 `setChooserLayout()` 给的 `(cx, cy)` —— 绘制与判定同一份数；环的种类 / 顺序来自
 * `setPickerPageRings()`（和绘制同一份）。
 * 手掌换到别的一颗时，之前那颗的进度**立刻归零**（和手势菜单「一格一格地选」一样）。
 *
 * 返回值：选中了哪个数值就返回它；翻页 / 没触发返回 −1（翻页不是「选中」，不会关掉选择层）。
 */
function updateSetPicker(landmarks, now) {
  if (!state.setPickerOpen) return -1;
  const size = stageSize();
  const palms = palmPoints(landmarks, size.w, size.h, state.settings.mirror);
  const info = setPickerPageRings();
  const layout = setChooserLayout(info.rings.length, size);
  let idx = -1;
  for (const it of layout.items) {
    if (anyTouchNearPoint(palms, { x: it.cx, y: it.cy }, it.px * RING_HIT_RATIO).inside) {
      idx = it.i;
      break;
    }
  }
  const st = setPickerHold;
  const dt = clamp(now - (st.at || now), 0, 250);
  st.at = now;
  if (idx >= 0 && idx !== st.idx) {
    st.idx = idx;
    st.p = 0;
    st.since = now;
  }
  if (idx >= 0) {
    st.lastInside = now;
    if (!st.since) st.since = now;
    st.p = clamp((now - st.since) / GESTURE_HOLD_MS, 0, 1);
  } else if (now - st.lastInside > GESTURE_GRACE_MS) {
    st.p = Math.max(0, st.p - dt / GESTURE_DRAIN_MS);
    if (st.p <= 0) st.idx = -1;
  }
  const btns = $('setPickerGrid')?.children || [];
  for (let i = 0; i < btns.length; i += 1) paintSetChoice(btns[i], i === st.idx ? st.p : 0);
  if (st.p >= 1 && st.idx >= 0) {
    const ring = info.rings[st.idx];
    const fired = { role: ring?.role, value: ring?.value, dir: ring?.dir };
    resetSetPickerHold();
    if (!fired.role) return -1;
    if (fired.role === 'choice') {
      chooseSetValue(fired.value);
      return fired.value;
    }
    flipSetPickerPage(fired.dir);   // 「向前 / 向后」：蓄满 3 秒翻一页，选择层不关
  }
  return -1;
}

/** 一组做完后的两个选择里那个「退出」圆环（手势停满 3 秒，或者用户直接点它） */
function triggerGesture(key) {
  audio.milestone();
  hideGestureRings();
  if (key === 'exit') {
    audio.say(t('ui.gestureExit'), { rate: 1.1, force: true });
    openMenu({ silent: true });     // 退出动作 → 回手势菜单（用户要求）
  } else {
    audio.say(t('ui.gestureRetry'), { rate: 1.1, force: true });
    retrySet();
  }
}

/** 「再做一次」：把这一组的计数全部清零，然后马上重新开始这一组 */
function retrySet() {
  hideGestureRings();
  const det = ensureDetector();
  det?.reset();                 // 次数 / 分数 / 要领清单 / 每轮进度全部清零
  state.afterSet = false;       // 又来一组了：不再是「刚做完一组在休息」的状态
  state.elapsedMs = 0;
  state.goalHit = false;
  state.timeUp = false;         // 限时计数：又来一组 → 时间重新开始
  state.timeCallsSaid = new Set();
  state.saidSteps = new Set();
  state.lastScoreMilestone = 0;
  state.stepSig = '';
  state.celebrateUntil = 0;
  $('celebrate').hidden = true;
  $('scorePop').className = 'score-pop';
  resetCriteriaProgress();
  updateHud();
  renderCriteriaBar();
  beginCountdown();
}

/* ------------------------------------------------------------------ *
 * 全手势操作：首页「开始」按钮 + 视频界面里的手势选择菜单
 *
 * 用户要求：「我希望把界面改造为全手势操作。请在首页增加一个大的『开始』按钮，点击后就打开摄像头
 *   进入到全屏的视频界面。在这个视频界面里面，给出手势选择菜单，也采用手进入圆环 3 秒的方式来进行
 *   选择，菜单项就是各项运动，选择之后则直接进入到全屏的各项运动界面，在各项运动中如果退出，
 *   则回到菜单页面，如果在菜单界面退出则回到网页首页。」
 *
 * 流程：
 *   首页「开始」 ──开摄像头 + #stage 全屏──▶ 手势菜单 ──手掌停满 3 秒选一格──▶ 该动作的训练界面
 *        ▲                                      │                                    │
 *        └────────── 右上角圆环（菜单里不显示；兜底 = 回首页）┘                            │
 *        └──────────────── 右上角圆环（训练里 = 退出 → 回菜单）◀──────────────────────────┘
 *
 * 判定复用其它圆环的同一套常量与手感：手掌中心 + GESTURE_HOLD_MS(3s) + GESTURE_GRACE_MS(300ms 抖动宽容)
 * + GESTURE_DRAIN_MS(1.5s 慢慢退回)；区别只有「一格一格地选」：手掌移到别的圆环上，
 * 之前那一格的进度立刻归零（不然会在两格之间攒进度）。
 *
 * 后来又要求：「把主菜单的圆环再进一步放大，每行放4个圆环就够了，一页不够就增加一页，
 * 然后增加一个向上挥手和向下挥手的手势翻页。」
 * 再后来：「我感觉一页可以放2行，8个。但是挥手换页的方式似乎也不太好。」
 *
 * → 一页 **4 列 × 2 行 = 8 个**（1280×720 上圆环 ≈199px、全屏 1920×1080 上 ≈299px），
 *   一页放不下才分页。**翻页不用挥手**（垂直挥手和「伸手去够上面那一排圆环」是同一个动作方向，
 *   很容易互相打架、也难学）：改成**左右两侧各一个「上一页 / 下一页」圆环**，
 *   用的是和选动作**完全一样**的交互（把手掌放进去），只是按住的时间短（1 秒）、
 *   而且**按住不放会一页一页连续翻**（选中动作仍然是 3 秒，不容易误触）。
 *   鼠标点页码那一行、键盘 ← / →（或 PageUp / PageDown）同样能翻页。
 * ------------------------------------------------------------------ */

/**
 * 每行最多 **6** 个格子（用户要求：「把每个运动圆环的大小再进一步缩小，每行最多放 6 个圆环，
 * 但是把『上一页』、『下一页』这两个圆环也放在这一行」）。
 *
 * 「格子」既可能是选项、也可能是翻页圆环：有分页时第一行两端各占一格（见 `menuNavLayout`），
 * 中间才是选项 —— 所以有分页时这一页的选项数会少 2 个，`menuPerPage()` 一起跟着算。
 */
const MENU_COLS = 6;
/** 宽屏每页只摆**一行**（用户要求「每页还是最多一行」）；窄屏另见 menuRowsFor() */
const MENU_ROWS = 1;
/**
 * 判定半径 = **画出来的圆圈本身**（1.0 倍）。
 *
 * 用户反馈：「因为菜单圆环很大，数量又比较多，人站在画面中手很容易误触某个圆环。」
 * 圆环现在有 200~300px，瞄准早就不难了，多放出去的那 15% 半径（面积 +32%）**全部是误触面积**：
 * 手从旁边走过、站在画面里手自然下垂，都可能蹭到某一格的判定圈。所以收紧到「必须真的在圆圈里」。
 * （右上角那个退出圆环是反过来的老问题 —— 手/脚够不到，所以它单独用 `RING_TOUCH_TOL = 1.12` 放宽；
 *   菜单是「太灵敏」，两者口径不同是刻意的。）
 */
const MENU_HIT_RATIO = 1.0;
/**
 * **起手**要更靠里一点（0.8 倍），进来之后就按 1.0 倍算（迟滞）。
 *
 * 为什么是 0.8：贴着圆环外沿那一圈（0.8~1.0 半径）占整个圆盘 **36% 的面积**，
 * 而「瞄准」时人自然会把手指向圆圈中间 —— 把这一圈排除在「起手」之外，
 * 误触面积直接砍掉三分之一，而正常瞄准（圆环中心那 80%）一点都没变难。
 * 一旦开始蓄力，手在圆环里晃到边上（≤1.0 倍）也不算离开，不会因为一点抖动就断。
 */
const MENU_START_RATIO = 0.8;
/** 翻页圆环的判定比例（和动作圆环一样严格：它就在画面两侧，手很容易扫到） */
const MENU_NAV_HIT_RATIO = 1.0;
/** 圆环直径的上限（真摆不下时会自动减列，见 MENU_CELL_MIN_PX） */
const MENU_RING_MAX = 360;
/**
 * 一格至少要有的宽度（不够就自动减列）。
 *
 * 从 170 收到 **120**：用户要求「每行最多放 6 个圆环」，而且**分页时翻页圆环也占这一行的格子**
 * （一行 = `[上一页] + 选项 + [下一页]`，最多 6 格）—— 格子变多，直径自然跟着变小；
 * 120px 这一档能保证 667×375 这类手机横屏也能排到 5 列（3 个选项 + 2 颗翻页），
 * 不会掉到「一页只放得下 1 个」的地步（见 `menuCols` / `menuPerPage`）。
 */
const MENU_CELL_MIN_PX = 120;
/**
 * 「上一页 / 下一页」圆环：按住多久翻一页。
 *
 * 这三颗圆环**位置固定**、又是可逆动作，所以本来想做得比选动作快；
 * 但用户反馈「返回之后就停在那儿，容易持续返回」，于是把蓄力改到 **5 秒**（比选动作的 3 秒还长）——
 * 想触发必须真的停在那一格上，代价是「按住连翻」变慢（每 `MENU_NAV_HOLD_MS` 一页）。
 */
/**
 * 「上一页 / 下一页」与右上角那颗「↩ 返回」的蓄力时间：**5 秒**。
 *
 * 用户反馈：「因为返回、上一页、下一页始终在相同的位置，容易在返回之后持续返回，
 * 这几个圆环的沙漏时间我觉得可以增加到 5 秒。」
 *
 * 为什么单独设一个更长的值：
 *   - 这三颗圆环**位置固定**（不随翻页动），返回之后手还停在原地就会接着攒进度 → 连续返回；
 *   - 所以蓄力拉到 5 秒（`GESTURE_HOLD_MS` 是 3 秒）：想触发必须**真的停在那一格上**，
 *     手垂在那儿、顺手划过都不会误触；
 *   - 代价是「按住连翻」变慢（每 5 秒一页），但翻页的主路径是**双手同时挥两次**（`MENU_SWIPE_*`），
 *     那一条仍然是快的，圆环只是兜底 + 鼠标 / 键盘（页码、← / →）也有。
 */
const MENU_NAV_HOLD_MS = 5000;
/** 这三颗圆环（右上角「返回」/ 上一页 / 下一页）都用上面那个 5 秒蓄力 */
const MENU_NAV_KINDS = { back: 1, prev: 1, next: 1 };
/** 悬停多久开始念这一格的名字（先让人看清自己指着哪一个，再决定要不要停 3 秒） */
const MENU_ANNOUNCE_P = 0.28;
/**
 * **手要基本停住才算「指着这一格」**：手掌移动速度超过这个值（单位：舞台高度 / 秒）时，
 * 蓄力的计时跟着往后挪（不攒进度）。
 *
 * 为什么需要：菜单铺满整幅画面，人站在画面里抬手、转身、换姿势时手会**从圆环上扫过** ——
 * 以前这种扫过也会攒进度（甚至会念出名字）。现在「走过去、挥过去」一律不算，
 * 只有**停在那儿**才算，这也正是人「瞄准某一格」时的自然动作。
 */
const MENU_STILL_SPEED = 0.30;
/**
 * **要从圆环外面进来才算数**（"armed"）：一只手只有在**所有圆环之外**露过面，
 * 才允许它开始给某一格蓄力；一旦开始蓄力，这次「许可」就用掉了，要再选一次得先出环再进环。
 *
 * 为什么需要：用户反馈「人站在画面中手很容易误触」—— 最常见的情形就是
 * **进菜单时手正好垂在某一格的判定圈里**（画面下半部分那两格），以前它会默默开始攒 3 秒。
 * 现在这种情况一格都不会亮；把手抬出来再放进去（或者干脆垂着不动）都安全。
 */
const MENU_ARM_MS = 260;
/** 手离开后进度退回去的速度（比别的圆环那 1.5 秒快：蹭一下不该留下半格进度） */
const MENU_DRAIN_MS = 700;
/* ---- 换屏动画（翻页 / 返回的「滑动 + 淡入淡出」） ---- */
/**
 * 上一屏滑出 / 淡出的时长、新一屏滑入 / 淡入的时长（要和 style.css 里的动画时长一致）。
 *
 * 用户反馈（两次）：「淡入淡出的效果太快了，放慢速度，让人能清楚的看到滑出滑入的动画效果。」
 * →「还是太快了，还可以进一步放慢。」所以从 160 / 240ms 先放到 320 / 500ms，
 * 再放到 **500 / 800ms**（一整次换屏 ≈0.8 秒，滑出的残影和新一屏的滑入都看得清清楚楚）。
 * 按住翻页圆环是每 5 秒翻一页（`MENU_NAV_HOLD_MS`），比一次动画长得多，所以连续翻页每一页都播得完。
 */
const MENU_ANIM_OUT_MS = 560;
const MENU_ANIM_IN_MS = 560;
/* ---- 「双手同时挥两次」翻页（用户要求） ---- */
/** 一次挥动的行程：舞台高度的 16%（1280×720 上约 115px），两边手都要挥够这个量 */
const MENU_SWIPE_TRAVEL = 0.16;
/** 一次挥动要在这么短的时间里完成（秒表式：慢慢挪不算） */
const MENU_SWIPE_MS = 550;
/** 两次挥动之间的间隔上限：超过这个时间就重新数（要「连着挥两下」） */
const MENU_SWIPE_CHAIN_MS = 1600;
/** 翻完一页的冷却：连挥不会一下子翻好几页 */
const MENU_SWIPE_COOLDOWN_MS = 1200;
/** 「手停下来了」的速度门槛（舞台高度 / 秒）—— 两次挥动之间必须停一下，否则一次长挥会被算成两次 */
const MENU_SWIPE_QUIET = 0.12;
/** 停多久才算「停下来了」 */
const MENU_SWIPE_QUIET_MS = 130;

/**
 * 菜单项：**两级**，每页最多 `MENU_COLS` 个格子（宽屏 6 格一行；有分页时其中 2 格是翻页圆环）。
 *   第一级 `menuLevel === 0`：5 个分类（上肢 / 下肢 / 核心 / 全身 / 拉伸）；
 *   第二级 `menuLevel === 1`：当前分类下的动作。
 *
 * 「↩ 返回」**不在这里**了（用户要求「固定在画面上，不参与翻页」）——它现在和动作页那颗
 * 「退出」圆环一样**常驻在右上角**（见 `menuBackItem()` / `exitRingLayout()`，同一个位置、同一个
 * `--ring-px` 直径）；「◀ 上一页 / 下一页 ▶」仍然在选项行正上方那一条带子里（`menuNavLayout()`）。
 * 所以每页专心放 5 个选项。
 */
function menuItems() {
  if (state.menuLevel === 0) {
    return localizedCategories().map((c) => ({
      id: `cat:${c.id}`,
      kind: 'category',
      catId: c.id,
      name: c.name,
      icon: c.icon,
      /**
       * 分类也用**线条图标**（用户要求「图标全面重新设计、保持风格一致」）：
       * 同一个正面火柴人、把这一类练的部位画粗（见 icons.js 的 `categoryMarkSVG`）。
       * emoji 还留着当兜底（万一某个分类没画）。
       */
      poseIcon: categoryMarkSVG(c.id),
      /**
       * 一级菜单的分类格子**不再显示「N 个动作」**（用户要求：「对于『上肢』『下肢』这样的大类下面，
       * 不要显示『x 个动作』这样的提示了，删掉」）—— 空字串，圆环里就只剩图标和名字。
       */
      sub: '',
    }));
  }
  return localizedByCategory(state.menuCategory).map((ex) => ({
    id: ex.id, kind: 'exercise', name: ex.name, icon: ex.icon, poseIcon: ex.poseIcon, sub: '',
  }));
}

/** 菜单里要列的分类名（第二级的标题用） */
function menuCategoryName() {
  const c = localizedCategories().find((x) => x.id === state.menuCategory);
  return c ? c.name : t('menu.title');
}

/** 这个宽度下能摆几列（一格至少 MENU_CELL_MIN_PX，窄屏自动减列） */
function menuCols(w) {
  return Math.max(1, Math.min(MENU_COLS, Math.floor(w / MENU_CELL_MIN_PX)));
}

/**
 * 摆几行：宽屏**只摆一行**（用户要求「每页还是最多一行」）；
 * 竖屏手机那种窄屏宽度只够 1~2 列，一行就只能放一两个，翻页太碎，所以窄屏放宽到两行。
 * 真的窄到只剩 1 列时给三行 —— 不然「上一页 + 选项 + 下一页」连一行都排不开（见 menuPerPage）。
 */
function menuRowsFor(size = stageSize()) {
  if (size.w >= 620) return MENU_ROWS;
  return menuCols(size.w) < 2 ? 3 : 2;
}

/** 这一页一共有几个**格子**（列 × 行；翻页圆环和选项共用同一套格子） */
function menuPageCells(size = stageSize()) {
  return menuCols(size.w) * menuRowsFor(size);
}

/**
 * 翻页圆环占掉几个格子：**真的要翻页时**才占（有第二页 → 2 格：第一行最左、最右）。
 *
 * ⚠️ 要不要翻页只能由「选项总数 vs 格子数」决定 —— 不能反过来问 `menuPageInfo()`
 * （它要靠 `menuPerPage()`，而 `menuPerPage()` 又要靠这里，会绕成递归）。
 */
function menuNavCells(size = stageSize()) {
  return menuItems().length > menuPageCells(size) ? 2 : 0;
}

/**
 * 这一页放几个**选项**：格子数 − 翻页圆环占的格子。
 * 单页时翻页圆环不出现，整行都是选项（最多 6 个）；有分页时一行 = `[上一页] + 选项 + [下一页]`，
 * 所以选项数比格子数少 2。
 */
function menuPerPage(size = stageSize()) {
  return Math.max(1, menuPageCells(size) - menuNavCells(size));
}

/** 当前这一层的分页信息（页码越界时夹回范围内） */
function menuPageInfo(size = stageSize()) {
  const n = menuItems().length;
  const per = menuPerPage(size);
  const pages = Math.max(1, Math.ceil(n / per));
  const page = clamp(Math.round(state.menuPage) || 0, 0, pages - 1);
  return { page, pages, total: n, per, from: page * per, to: page * per + per };
}

/** 有没有上一页 / 下一页（只有一页就不显示翻页圆环，页码那一行也不显示） */
function menuHasPages(size = stageSize()) {
  return menuNavCells(size) > 0;
}

/**
 * 选项区那一带的纵向 / 横向几何（**一处定义**：`menuRingLayout` 与 `menuNavLayout` 共用）。
 *
 * 用「最满的一页」（`rows = menuRowsFor(size)`）来算 —— 这样圆环的位置**不随翻页跳动**
 * （窄屏上一页可能是 1 行、另一页是 2 行，按当前页算的话整排会跟着上下跑）。
 */
function menuBandGeom(size) {
  const narrow = size.w < 620;
  const top = size.h * (narrow ? 0.20 : 0.16);
  const bottom = size.h * (narrow ? 0.20 : 0.18);
  const rows = menuRowsFor(size);
  const padX = Math.max(10, size.w * 0.02);
  const cellW = Math.max(1, (size.w - padX * 2) / menuCols(size.w));
  const cellH = Math.max(1, (size.h - top - bottom) / rows);
  const dia = Math.max(24, Math.min(cellW * 0.86, cellH * 0.70, MENU_RING_MAX));
  return { narrow, top, bottom, rows, padX, cellW, cellH, dia };
}

/**
 * 菜单圆环的几何：**按舞台尺寸算**（不读 DOM 的布局）——只算**这一页的选项**。
 *
 * 和右上角退出圆环是同一个做法：判定用的圆心 / 半径与写进元素的行内 `left/top` 永远来自同一份数，
 * 所以「看到哪一格」和「程序判哪一格」不会各说一套（测试也能在没有真实布局的桩里跑）。
 * 直径与字号一起算：字号按直径走，圆环一大字就跟着大（用户反馈「圆环太小、字也太小」）。
 *
 * ⚠️ 列数只看屏幕宽度（不看这一页有几个），格子的高度按**最满的一页**算（`menuBandGeom`），
 * 这样**每一页的圆环都一样大、都在同一行高度上**，最后一页不满就整行居中。
 *
 * ⚠️ **有分页时第一行两端是「上一页 / 下一页」**（`menuNavLayout()` 摆那两颗），
 * 选项只占第一行**中间**那几格、再往下按整行排；所以这一页的选项数 = 格子数 − 2。
 * 「↩ 返回」被摘到了右上角（`menuBackItem()`），不占这里的格子。
 */
function menuRingLayout(size) {
  const info = menuPageInfo(size);
  const slice = menuItems().slice(info.from, info.to);
  const n = slice.length;
  if (!n) return [];
  const g = menuBandGeom(size);
  const cols = menuCols(size.w);
  const rows = menuRowsFor(size);
  const dia = g.dia;
  const nameSize = clamp(dia * 0.15, 12, 40);
  // 运动图标改成实心象形图之后更有分量，也跟着放大一档（用户要求「更大气、上档次」）
  const iconSize = clamp(dia * 0.38, 18, 76);

  /**
   * 这一页的**选项格子**（按阅读顺序）。
   *
   * - 有分页、而且第一行排得下「上一页 + 选项 + 下一页」（cols ≥ 3）：第一行两端各让 1 格，
   *   选项从第一行中间开始、再往下按整行排；
   * - 第一行排不下（cols ≤ 2）：翻页圆环改按**整页**的首 / 末格摆（`menuNavLayout` 里同一个判断），
   *   选项占中间那些格子 —— 2 列时就是「左上上一页、右上下拉下一页」，两行各有一个选项。
   */
  const nav = menuHasPages(size);
  const nextAtRowEnd = cols > 2;
  const rowsInfo = [];
  for (let row = 0; row < rows; row += 1) {
    const from = row === 0 && nav ? 1 : 0;
    const end = row === 0 && nav && nextAtRowEnd ? cols - 1 : cols;
    const lastRow = row === rows - 1;
    const colList = [];
    for (let col = from; col < end; col += 1) {
      if (nav && !nextAtRowEnd && lastRow && col === cols - 1) continue;   // 右下角留给「下一页」
      colList.push(col);
    }
    rowsInfo.push({ from, cols: colList });
  }
  const slots = [];
  rowsInfo.forEach((ri, row) => ri.cols.forEach((col, k) => slots.push({ row, col, k })));
  /** 每行实际分到几个选项：不满就把这一行的选项在**这一行的格子带里居中** */
  const counts = new Map();
  slice.forEach((_, i) => {
    const s = slots[i];
    if (s) counts.set(s.row, (counts.get(s.row) || 0) + 1);
  });
  return slice.map((it, i) => {
    const s = slots[i] || { row: 0, col: 0, k: 0 };
    const ri = rowsInfo[s.row] || { from: 0, cols: [0] };
    const count = counts.get(s.row) || 1;
    const lead = ri.from + (ri.cols.length - count) / 2;
    return {
      ...it,
      cx: g.padX + g.cellW * (lead + s.k + 0.5),
      cy: g.top + g.cellH * (s.row + 0.5),
      r: dia / 2,
      hit: (dia / 2) * MENU_HIT_RATIO,
      start: (dia / 2) * MENU_START_RATIO,
      nameSize,
      iconSize,
    };
  });
}

/**
 * 翻页圆环：**有分页时放进选项那一行**（用户要求：「把『上一页』、『下一页』这两个圆环也放在这一行」）。
 *
 * 位置：`[◀ 上一页]` 在第一行第一格，`[下一页 ▶]` 在第一行最后一格 —— 整行就是
 * `[上一页] + 选项 + [下一页]`，**格子总数 ≤ `MENU_COLS`（6）**，和选项同一套直径 / 字号；
 * 只有 2 列时第一行排不下三样东西，改成按**整页**首 / 末格摆（左上 = 上一页、右下 = 下一页），
 * 和 `menuRingLayout()` 里 `nextAtRowEnd` 的判断是同一个。
 *
 * 没有第二页时这两颗根本不出现（单页不显示、页码那一行也不显示）。
 *
 * 历史：它们曾经单独占选项**上方**一条带子、以舞台中线为轴对称（三颗并排居中，返回在中间），
 * 后来「返回」被摘到右上角（`menuBackItem()`），再后来用户要求把这两颗也并入选项行 —— 现在就是这一版。
 * 判定 / 起手半径和选项同一套常量（`MENU_NAV_HIT_RATIO` / `MENU_START_RATIO`），并和绘制同源。
 */
function menuNavLayout(size) {
  if (!menuHasPages(size)) return [];
  const g = menuBandGeom(size);
  const cols = menuCols(size.w);
  const rows = menuRowsFor(size);
  const dia = g.dia;
  const r = dia / 2;
  // 导航圆环里**只有图标、没有文字**（用户要求），所以图标可以画得更大
  const iconSize = clamp(dia * 0.62, 30, 78);
  const nextRow = cols > 2 ? 0 : rows - 1;
  return [
    ['page:prev', 'prev', -1, t('menu.prev'), 0, 0],
    ['page:next', 'next', 1, t('menu.next'), nextRow, cols - 1],
  ].map(([id, kind, dir, name, row, col]) => ({
    // 箭头也改成**线条画**的（`navPoseSVG`），不再用字体里的 ◀ ▶ ↩ —— 字形风格和线条图标不一致
    id, kind, dir, name, icon: '', poseIcon: navPoseSVG(kind), sub: '',
    cx: g.padX + g.cellW * (col + 0.5),
    cy: g.top + g.cellH * (row + 0.5),
    r,
    hit: r * MENU_NAV_HIT_RATIO,
    start: r * MENU_START_RATIO,
    nameSize: clamp(dia * 0.21, 12, 26),
    iconSize,
  }));
}

/**
 * 菜单右上角那颗常驻的「↩ 返回」圆环（**菜单里的「退出」就是它**）。
 *
 * 用户要求：「把菜单界面中的退出圆环始终放在右上角，且各界面退出圆环的位置和大小都保持一致。」
 * —— 它的 cx / cy / 直径 / 判定半径全部来自 `exitRingLayout()`，和动作页那颗「退出」圆环**同一个数**；
 * 它的元素 `#menuBack` 也在 `.menu-screen` **之外**（常驻，不跟换屏滑动），见 index.html。
 *
 * 行为照旧（`selectFromMenu`）：第一级 = 回网页首页、第二级 = 回分类；蓄力 5 秒（`MENU_NAV_KINDS.back`）。
 */
function menuBackItem(size = stageSize()) {
  const g = exitRingLayout(size);
  return {
    id: 'back', kind: 'back', dir: 0, name: t('menu.back'), icon: '', poseIcon: navPoseSVG('back'), sub: '',
    cx: g.cx, cy: g.cy, px: g.px, r: g.r, hit: g.hit, start: g.start,
    // 圈里**只画图标、不写文字**（用户要求），字号由 CSS 的 `.corner-ring .ring-label--icon` 给
    //（= calc(var(--ring-px) * 0.62)，和动作页退出圆环同一比例）；这里留着字段只为形状一致
    nameSize: 0,
    iconSize: g.iconSize,
  };
}

/** 菜单右上角那颗「返回」圆环的按钮元素（常驻在 `.menu-screen` 之外，不在 `#menuGrid` 里） */
function menuBackEl() { return $('menuBack'); }

/**
 * 语音命令「第三个」：选中**当前这一页**的第 index 个（0 起）。
 * 只做「找到那一格 → 交给 selectFromMenu」这一层转接，不改菜单状态；
 * 越界就返回空串（宁可说「没听清」也不瞎点）。
 */
function pickMenuItem(index) {
  if (!state.menuMode) return '';
  const info = menuPageInfo(stageSize());
  const list = menuItems().slice(info.from, info.to);
  const i = Math.round(Number(index));
  if (!Number.isFinite(i) || i < 0 || i >= list.length) return '';
  const item = list[i];
  if (!item) return '';
  selectFromMenu(item.id);
  return item.name || '';
}

/**
 * 菜单里某一格的真实元素（按 data-ex 找）。
 * 「↩ 返回」例外：它**常驻在 `.menu-screen` 之外**（不在 `#menuGrid` 里），有自己的固定 id。
 */
function menuRingEl(id) {
  if (id === 'back') return menuBackEl();
  const grid = $('menuGrid');
  if (!grid || !grid.children) return null;
  return [...grid.children].find((el) => el?.dataset?.ex === id) || null;
}

/** 建菜单项：**当前这一页的动作格 + 翻页圆环**（其它页的圆环不进 DOM，免得留在角落上） */
function buildMenu() {
  const grid = $('menuGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const size = stageSize();
  const info = menuPageInfo(size);
  const nav = menuNavLayout(size);
  for (const it of menuItems().slice(info.from, info.to)) {
    grid.appendChild(menuItemEl(it));      // 动作 / 分类
  }
  for (const it of nav) {
    grid.appendChild(menuItemEl(it));      // 上一页 / 下一页
  }
  // 「↩ 返回」不在这里：它是常驻元素（#menuBack），和动作页的退出圆环同一套坐标/尺寸，
  // 见 index.html 与 menuBackItem() —— 换屏滑动不会把它带走。
}

/** 造一个菜单圆环（动作格与翻页圆环共用同一套结构与动画） */
function menuItemEl(it) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `menu-ring ring-btn menu-ring--${it.kind}`;   // 复用其它圆环的全部样式与动画
  btn.dataset.ex = it.id;
  btn.dataset.kind = it.kind;
  const label = it.kind === 'exercise' ? t('menu.item', { name: it.name }) : it.name;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
  /**
   * 图标：有「人体姿势」线条图的动作用它（19 个动作 + 5 个分类都是），
   * 导航圆环用线条箭头。姿势图的颜色走 currentColor —— 和文字一样是白色，一眼看得清。
   */
  const iconHtml = it.poseIcon || it.icon;
  /**
   * 导航圆环（返回 / 上一页 / 下一页）**只显示图标、不显示文字**（用户要求）：
   * 图标本身已经说得清，圈里再塞一行字反而把图标挤小了。
   * 无障碍名称保留在上面那个 `aria-label` / `title` 上，所以读屏和鼠标悬停仍然知道是什么。
   */
  const navKind = it.kind === 'back' || it.kind === 'prev' || it.kind === 'next';
  btn.innerHTML = '<svg class="ring-svg" viewBox="0 0 120 120" aria-hidden="true">'
    + '<circle class="ring-track" cx="60" cy="60" r="52"></circle>'
    + '<circle class="ring-fill" cx="60" cy="60" r="52"></circle>'
    + '</svg>'
    + `<span class="menu-icon" aria-hidden="true">${iconHtml}</span>`
    + (navKind ? '' : `<span class="menu-name">${it.name}</span>`)
    + `<span class="menu-sub">${it.sub || ''}</span>`
    + '<span class="ring-timer"></span>';
  btn.addEventListener('click', () => {
    if (it.kind === 'prev' || it.kind === 'next') flipMenuPage(it.dir);
    else selectFromMenu(it.id);
  });
  return btn;
}

/** 把菜单圆环按当前舞台尺寸摆好（位置、直径、**字号**都写进行内样式，和判定同一份数） */
function layoutMenu() {
  const size = stageSize();
  for (const it of [...menuRingLayout(size), ...menuNavLayout(size)]) {
    const el = menuRingEl(it.id);
    if (!el) continue;
    el.style.left = `${it.cx}px`;
    el.style.top = `${it.cy}px`;
    el.style.width = `${it.r * 2}px`;
    el.style.height = `${it.r * 2}px`;
    // 字号跟着直径走：圆环大，字就大（用户反馈「圆环太小了，字也太小了」）
    const name = el.querySelector?.('.menu-name');
    if (name) name.style.fontSize = `${it.nameSize.toFixed(1)}px`;
    const icon = el.querySelector?.('.menu-icon');
    if (icon) icon.style.fontSize = `${it.iconSize.toFixed(1)}px`;
    const sub = el.querySelector?.('.menu-sub');
    if (sub) sub.style.fontSize = `${clamp(it.nameSize * 0.72, 10, 20).toFixed(1)}px`;
  }
  /**
   * 右上角那颗「↩ 返回」：**和动作页的退出圆环走同一个摆放函数**（`layoutExitRing`），
   * 位置与直径都来自 `exitRingLayout()` —— 两个界面逐像素同坐标、同尺寸。
   * 圈里的图标字号由 CSS 给（`.corner-ring .ring-label--icon` = calc(--ring-px × 0.62)），
   * 和退出圆环同一个比例，所以这里不再写行内字号。
   */
  layoutExitRing(menuBackEl(), size);
}

/** 菜单右上角「返回」圆环的图标（线条箭头，和动作页退出圆环同一颗；文字含义在 aria-label 上） */
function syncMenuBackIcon() {
  setRingIcon($('menuBackLabel'), menuBackEl(), 'back', t('menu.back'));
}

/** 重建菜单（换层 / 换页 / 换语言 / 进菜单时）：标题、页码、文案与位置一起刷新 */
function renderMenu() {
  const title = $('menuTitle');
  if (title) title.textContent = state.menuLevel === 0 ? t('menu.title') : menuCategoryName();
  const lead = $('menuLead');
  if (lead) {
    lead.textContent = state.menuLevel === 0
      ? t('menu.lead')
      : t('menu.leadIn', { name: menuCategoryName() });
  }
  // 底部提示随层级换：第一级的「↩ 返回」是回网页首页，第二级的是回分类
  const foot = $('menuFoot');
  if (foot) foot.textContent = state.menuLevel === 0 ? t('menu.hint') : t('menu.hintIn');
  syncMenuBackIcon();        // 右上角那颗「返回」的图标 / aria-label 跟着语言走
  // 右上角那颗「返回」常驻（在 `.menu-screen` 之外、不参与换屏滑动）：只要菜单在，它就在
  const cornerBox = $('menuCornerExit');
  if (cornerBox) cornerBox.hidden = false;
  buildMenu();
  layoutMenu();
  renderMenuPage();
  resetMenuProgress();
}

/** 页码那一行（只有一页时不显示；点击 = 下一页，鼠标用户的翻页办法） */
function renderMenuPage() {
  const el = $('menuPage');
  if (!el) return;
  const { page, pages, total } = menuPageInfo();
  el.hidden = pages <= 1;
  el.textContent = pages > 1
    ? t('menu.page', { n: String(page + 1), total: String(pages), count: String(total) })
    : '';
}

/**
/**
 * 菜单换屏的**整屏滑动**（用户要求：「把淡入淡出的效果改为完整的滑动效果，比如从主菜单进入核心运动菜单，
 * 则主菜单的所有圆环全部向左滑出，核心运动的圆环则从右面滑入界面，形成一个整行滑动的效果」）。
 *
 * 做法（关键是**真实 DOM 立刻重建**，动画只做在「残影」上，状态与界面永远同步、测试也不用等动画）：
 *   1. 把当前这一屏（标题 / 说明 / 页码 + 所有圆环 + 底部提示）**克隆**进 `.menu-ghost`，
 *      整块按方向平移出去（平移距离由 `menuSlideDistance` 按舞台宽度算，保证最里面那颗也滑出画面）；
 *   2. 立刻 `rebuild()` 真实的那一屏（同步）；
 *   3. 给 `.menu-screen` 加反方向的入场动画 —— 两边**同距同时长**，观感就是「一整行推过去」。
 *
 * 方向：`dir >= 0`（下一页 / 进下一层）= 老的一屏往左推走、新的一屏从右边推进来；`dir < 0`（上一页 / 返回）反过来。
 * 动画没播完又触发一次：直接换，不叠加（免得连续翻页时一片乱飞）。
 */
function animateMenuSwap(dir, rebuild) {
  const screen = $('menuScreen');
  const grid = $('menuGrid');
  const head = $('menuHead');
  const foot = $('menuFoot');
  const ghost = $('menuGridGhost');
  const root = $('gestureMenu');
  const anim = gestureState.menuAnim;
  const cls = dir >= 0 ? 'next' : 'prev';
  const now = performance.now();
  const fresh = now >= anim.until;

  if (fresh && ghost && grid) {                  // ① 上一屏整块滑出去（克隆件，不影响真实状态）
    const size = stageSize();
    // 滑动距离 / 时长写成 CSS 变量：CSS 里只管动画，具体数字由这里按舞台尺寸给
    root?.style?.setProperty?.('--menu-slide-x', `${menuSlideDistance(size)}px`);
    root?.style?.setProperty?.('--menu-anim-out', `${MENU_ANIM_OUT_MS}ms`);
    root?.style?.setProperty?.('--menu-anim-in', `${MENU_ANIM_IN_MS}ms`);
    ghost.innerHTML = '';
    for (const el of [head, grid, foot]) {
      const copy = typeof el?.cloneNode === 'function' ? el.cloneNode(true) : null;
      if (copy) {
        copy.removeAttribute?.('id');            // 克隆件不留 id（免得页面上出现两个同名元素）
        ghost.appendChild(copy);
      }
    }
    ghost.className = `menu-ghost menu-anim-out-${cls}`;
    clearTimeout(anim.ghostTimer);
    anim.ghostTimer = setTimeout(() => {
      ghost.innerHTML = '';
      ghost.className = 'menu-ghost';
    }, MENU_ANIM_OUT_MS);
  }

  rebuild();                                     // ② 真实那一屏马上换好（同步）

  if (fresh) {                                   // ③ 新一屏从另一侧整块推进来
    const el = screen || grid;
    if (el?.classList) {
      el.classList.remove('menu-anim-in-next', 'menu-anim-in-prev');   // 两个方向互斥，别叠在一起
      void el.offsetWidth;                       // 强制重排，同一个类名也能重放动画
      el.classList.add(`menu-anim-in-${cls}`);
    }
    clearTimeout(anim.inTimer);
    anim.inTimer = setTimeout(() => {
      el?.classList?.remove(`menu-anim-in-${cls}`);
    }, MENU_ANIM_IN_MS);
    anim.until = now + MENU_ANIM_IN_MS + 40;
  }
}

function menuBackHome() {
  const anim = gestureState.menuAnim;
  const menu = $('gestureMenu');
  const home = $('homeView');
  menu?.classList?.add('menu-anim-out-home');
  if (home?.classList) {
    home.classList.remove('menu-anim-in-home');
    void home.offsetWidth;
    home.classList.add('menu-anim-in-home');
  }
  showHome();                                    // 立刻切（不等动画），返回手势不会有延迟
  clearTimeout(anim.homeTimer);
  anim.homeTimer = setTimeout(() => {
    menu?.classList?.remove('menu-anim-out-home');
    home?.classList?.remove('menu-anim-in-home');
  }, MENU_ANIM_IN_MS);
}

/**
 * 翻页（dir = +1 下一页 / -1 上一页；循环）。
 *
 * 用户要求：「一页不够就增加一页」；翻页入口有两个：**双手同时挥两次**（主路径）与顶部那排
 * 「◀ 上一页 / 下一页 ▶」圆环（兜底），鼠标点页码、键盘 ← / → 也能翻。
 * 换页时走一遍滑动 + 淡入淡出（`animateMenuSwap`）。
 */
function flipMenuPage(dir) {
  const { pages } = menuPageInfo();
  if (pages <= 1) return false;
  state.menuPage = ((state.menuPage + dir) % pages + pages) % pages;
  animateMenuSwap(dir, () => {
    buildMenu();                 // 换一页：菜单项本身也换了，重建 + 重新摆
    layoutMenu();
    renderMenuPage();
  });
  audio.tick();
  return true;
}

/** 清掉「手掌停在哪一格」的进度（进菜单、换页 / 换层、换语言、选中之后都调） */
function resetMenuProgress() {  const st = gestureState.menu;
  if (st.id) paintMenuRing(st.id, 0);
  st.id = ''; st.side = ''; st.p = 0; st.since = 0; st.lastInside = 0; st.at = 0;
  st.announced = '';
  /**
   * 蓄力许可也一起清掉：刚进菜单 / 刚翻完页时，手可能正垂在某一格里，
   * 这时候**不该**自己开始攒进度（用户反馈「人站在画面中手很容易误触某个圆环」）。
   * 手只要在环外露过面就会重新拿到许可（见 updateMenu 的闸 4）。
   */
  st.armed = { L: false, R: false };
  // 「双手挥两次」的数数也一起清掉：刚进菜单 / 刚翻完页不该把上一轮的半次挥动接着算
  st.swipe = {
    ref: {}, dir: 0, count: 0, lastAt: 0, quietSince: 0, cooldownUntil: st.swipe?.cooldownUntil || 0,
  };
}

/** 画某一格圆环的进度（复用 `.ring-fill` 的 dashoffset 口径，和别的圆环同一套） */
function paintMenuRing(id, p, leftS = null) {
  const el = menuRingEl(id);
  if (!el) return;
  const v = clamp(p, 0, 1);
  const fill = el.querySelector?.('.ring-fill');
  if (fill) fill.style.strokeDashoffset = String(326.7 * (1 - v));
  el.classList.toggle('dwelling', v > 0.001);
  const timer = el.querySelector?.('.ring-timer');
  if (timer) timer.textContent = (v > 0.02 && v < 1 && Number.isFinite(leftS)) ? `${leftS.toFixed(1)}s` : '';
}

/**
 * **双手同时挥两次**翻页（用户要求：「双手向上挥动两次则向上翻页，双手向下挥动两次则向下翻页」）。
 *
 * 方向按键盘 PageUp / PageDown 的口径（用户确认）：**向上挥 = 上一页、向下挥 = 下一页**。
 *
 * 为什么是「双手 + 两次」：单手挥手在生活里太常见（抬手、挠头、换姿势），
 * 而「两只手一起、同一个方向、连着挥两下」几乎只有「我要翻页」才会做 —— 误触概率极低。
 *
 * 判定口径：
 *   - 两只手都要**看得见**，而且**立参考点**的时候两只手都要**在所有圆环之外**
 *     （正指着某一格时挥手不算翻页；挥的过程中穿过圆环那一片没关系 —— 人挥手的路线本来就在那儿）；
 *   - 两只手各自都要在 `MENU_SWIPE_MS`（550ms）里朝**同一个方向**挥够 `MENU_SWIPE_TRAVEL`
 *     （舞台高度的 16%，1280×720 上约 115px）—— 一只手挥不算；
 *   - **一次挥动只算一次**（burst）：挥完必须**停一下**（两只手的速度掉到 `MENU_SWIPE_QUIET` 以下
 *     并保持 `MENU_SWIPE_QUIET_MS`）才会重置参考点、接受下一次 ——
 *     所以「挥出去再收回来」那个回收动作不会被算成第二次，一次不停的长挥动也不会被算成两次；
 *   - 第二下要和第一下**同方向**、并且在 `MENU_SWIPE_CHAIN_MS`（1.6 秒）内出现；
 *   - 翻完一页有 `MENU_SWIPE_COOLDOWN_MS`（1.2 秒）冷却，连挥不会连翻好几页。
 *
 * @param {object} speed 每只手的当前速度（px/s，见 updateMenu），用来判「停下来了没有」
 * @returns {number} 0 = 不翻页；+1 = 下一页；-1 = 上一页
 */
function updateMenuSwipe(palms, layout, size, now, speed) {
  const sw = gestureState.menu.swipe;
  if (!sw) return 0;
  const travel = MENU_SWIPE_TRAVEL * size.h;
  const quietSpeed = MENU_SWIPE_QUIET * size.h;
  // 必须**两只手都看得见**（一只手挥不算）
  const both = palms.length >= 2 && palms[0].side !== palms[1].side;
  const outside = both && palms.every(
    (p) => layout.every((it) => Math.hypot(p.x - it.cx, p.y - it.cy) > it.hit),
  );
  /** 数数清零（手离开画面 / 冷却中都不能接着数） */
  const drop = () => {
    sw.ref = {}; sw.dir = 0; sw.count = 0; sw.burst = false; sw.quietSince = 0;
  };
  if (!both || now < sw.cooldownUntil) {
    drop();
    return 0;
  }
  /** 立参考点（只有「两只手都在所有圆环之外」时才允许 —— 正指着某一格时挥手不算翻页） */
  const capture = () => {
    sw.ref = {};
    for (const p of palms) sw.ref[p.side] = { y: p.y, t: now };
  };

  // 两只手都停下来了吗？（停下来 = 一次挥动结束，可以重新参考点、接受下一次）
  const quiet = palms.every((p) => (speed?.[p.side] ?? 0) < quietSpeed);
  if (quiet) {
    if (!sw.quietSince) sw.quietSince = now;
    if (now - sw.quietSince >= MENU_SWIPE_QUIET_MS) {
      sw.burst = false;                      // 这一轮结束：下一次挥动从这里重新量
      if (outside) capture(); else sw.ref = {};
      sw.quietSince = 0;
    }
    return 0;
  }
  sw.quietSince = 0;
  if (sw.burst) return 0;                    // 还在同一次挥动里（挥出去 / 收回来都不再数）

  // 两只手各自相对参考点的位移：要同向、都要够行程、都要在时间窗内
  const refs = palms.map((p) => sw.ref[p.side]);
  if (!refs.every(Boolean)) {
    /**
     * 还没有参考点：手在动但人在环外，就从这一刻起算。
     *
     * ⚠️ 「在环外」这一条**只在立参考点时要**，挥的过程中可以**穿过圆环那一片** ——
     * 人站在画面里挥手的路线本来就会从菜单那一行上经过，中途判一次「手在环里」就作废就太苛刻了。
     */
    if (outside) capture();
    return 0;
  }
  const dys = palms.map((p, i) => p.y - refs[i].y);
  const dts = palms.map((_, i) => now - refs[i].t);
  const up = dys.every((d) => d <= -travel) && dts.every((t) => t <= MENU_SWIPE_MS);
  const down = dys.every((d) => d >= travel) && dts.every((t) => t <= MENU_SWIPE_MS);
  if (!up && !down) return 0;

  const dir = up ? -1 : 1;                     // 上 = 上一页（-1）、下 = 下一页（+1）
  sw.burst = true;                             // 这一次挥动到此为止（要停下来才能数下一次）
  const same = dir === sw.dir && now - sw.lastAt <= MENU_SWIPE_CHAIN_MS;
  sw.dir = dir;
  sw.count = same ? sw.count + 1 : 1;
  sw.lastAt = now;
  if (sw.count < 2) return 0;                  // 要连着挥两次
  sw.count = 0;
  sw.cooldownUntil = now + MENU_SWIPE_COOLDOWN_MS;
  return dir;
}

/**
 * 每帧更新手势菜单。
 *
 * 返回 `null`（还没选定）或：
 *   - `{ kind: 'select', id }`  —— 手掌在某一格圆环里停满 `GESTURE_HOLD_MS`（3 秒）：选中它；
 *   - `{ kind: 'page', dir }`   —— 翻页：**双手同时挥两次**（见 updateMenuSwipe），
 *     或者手掌在「◀ 上一页 / 下一页 ▶」圆环里停满 `MENU_NAV_HOLD_MS`（5 秒）。
 *
 * 翻页入口有两个是刻意的：**双手挥两次**是主路径（自然、几乎不会误触），
 * 顶部那两个小圆环是给「挥不动 / 摄像头角度不好」的情况兜底，鼠标和键盘（← / →）也能翻。
 *
 * 「不容易误触」的四道闸（用户反馈：「菜单圆环很大、数量又多，人站在画面中手很容易误触某个圆环」）：
 *   1. **判定圈 = 画出来的圆圈**（`MENU_HIT_RATIO = 1.0`，不再外扩 15%）；
 *   2. **起手要更靠里**（`MENU_START_RATIO = 0.8`，迟滞：进环之后待在边上不算离开）；
 *   3. **手要基本停住**才攒进度（`MENU_STILL_SPEED`）—— 抬手/转身时手从圆环上扫过不算；
 *   4. **要从圆环外面进来**才算数（`MENU_ARM_MS` / `st.armed`）—— 进菜单时手正好垂在某一格里，
 *      那一格不会自己开始攒 3 秒；把手抬出来再放进去才认。
 * 另外：手离开后进度退得比别的圆环快（`MENU_DRAIN_MS`），蹭一下不会留下半格进度。
 */
/**
 * 手掌指针（猫爪）：把手掌当前位置画成一个小猫爪，看得见手在哪儿。
 *
 * 用户要求：「在出现圆环选择的情况下，用户手掌的位置出现一个小的猫爪图标，便于用户知道自己的手掌在哪里。」
 * 后来又要求：「在每个运动的窗口里面，如果手掌进入或者靠近类似『退出』这样的圆环，则像菜单界面一样出现猫爪。」
 *   - **手势菜单**里照旧显示（`state.menuMode`）；**运动界面**里也显示 —— 进了训练
 *     （`running` / `paused` / `countdown`）或者「一组结束」的两个圆环 / 右上角退出圆环正摆着
 *     （`gestureState.visible` / `cornerVisible`）时，只要有手掌被识别到就画；
 *   - **主页（`state.homeMode`）与没有手掌时必须藏起来**，不能残留在画面上（整层 `hidden` + 去掉 `on`）；
 *   - 坐标直接用识别到的手掌中心（和圆环判定用的是同一份舞台像素，所以「爪子在哪」＝「程序认为手在哪」）；
 *   - 猫爪层是 `#stage` 下、**`.menu-screen` 之外**的一层（菜单与运动界面共用），所以翻页滑动时它不跟着动。
 */
function pawsWanted() {
  if (state.homeMode) return false;                  // 主页：一律不画（摄像头也关着）
  if (state.menuMode) return true;                   // 手势菜单：照旧（有没有手由 palms 决定）
  // 运动界面：进了训练（含 3-2-1 倒计时 / 暂停），或者「一组结束」/ 右上角的圆环正摆着
  if (state.session === 'running' || state.session === 'paused'
    || state.session === 'countdown') return true;
  return !!(gestureState.visible || gestureState.cornerVisible);
}

function renderPaws(palms) {
  const layer = $('pawLayer');
  if (!layer) return;
  const list = (palms || []).filter(Boolean);
  // 没有手掌时整层收起来（不是只去掉 on）：手一离开画面爪子就该消失，不给「残影」
  const show = pawsWanted() && list.length > 0;
  layer.hidden = !show;
  for (const side of ['L', 'R']) {
    const el = $(side === 'L' ? 'pawL' : 'pawR');
    if (!el) continue;
    const p = show ? list.find((h) => h && h.side === side) : null;
    if (!p) { el.classList.remove('on'); continue; }
    if (!el.innerHTML) el.innerHTML = pawSVG();
    el.style.left = `${Math.round(p.x)}px`;
    el.style.top = `${Math.round(p.y)}px`;
    el.classList.add('on');
  }
}

/**
 * 猫爪指针的每帧接线：从关键点算出**舞台像素**里的手掌中心（`stageSize()` + 镜像设置，
 * 和圆环判定用的是同一份），再交给 `renderPaws`。
 *
 * 主循环的两条路径（手势菜单 / 运动界面）都调它 —— 以前只在 `updateMenu` 里调，
 * 所以运动界面里根本看不见猫爪（用户这次要的正是那一屏）。
 */
function updatePaws(landmarks) {
  const size = stageSize();
  renderPaws(palmPoints(landmarks, size.w, size.h, state.settings.mirror));
}

function updateMenu(landmarks, now) {
  if (!state.menuMode) return null;
  const size = stageSize();
  const st = gestureState.menu;
  const palms = palmPoints(landmarks, size.w, size.h, state.settings.mirror);
  /**
   * 选项圆环 + 那两颗翻页圆环 + **右上角常驻的「↩ 返回」**一起判：取**最近**的那一个。
   * 「返回」的 cx/cy/判定半径来自 `menuBackItem()` → `exitRingLayout()`，和动作页那颗
   * 退出圆环同一个数（绘制与判定同源，不在菜单里另算一套）。
   */
  const layout = [...menuRingLayout(size), ...menuNavLayout(size), menuBackItem(size)];

  // ---- 闸 3：手掌速度（px/s）。没看到的那只手把记录清掉，免得它再出现时算出一个假速度
  const speed = { L: 0, R: 0 };
  const seen = { L: false, R: false };
  for (const p of palms) {
    seen[p.side] = true;
    const prev = st.prev[p.side];
    if (prev) {
      const dt = clamp(now - prev.t, 1, 500);
      speed[p.side] = Math.hypot(p.x - prev.x, p.y - prev.y) / (dt / 1000);
    }
    st.prev[p.side] = { x: p.x, y: p.y, t: now };
  }
  for (const side of ['L', 'R']) if (!seen[side]) { st.prev[side] = null; st.armed[side] = false; }

  // ---- 双手同时挥两次 → 翻页（先判这个：手在挥的时候本来也不在圆环里）
  const swipeDir = updateMenuSwipe(palms, layout, size, now, speed);
  if (swipeDir) {
    resetMenuProgress();
    audio.tick();
    return { kind: 'page', dir: swipeDir };
  }

  // ---- 闸 4：这只手现在「在所有圆环之外」吗？在外就发一次蓄力许可（进环之后就用掉）
  for (const p of palms) {
    if (layout.every((it) => Math.hypot(p.x - it.cx, p.y - it.cy) > it.hit)) st.armed[p.side] = true;
  }

  // 找最近的那一格：**已经在蓄力的那一格**按 hit 判（手晃到边上不算离开），
  // 要**新起手**的那一格按 start 判（贴着圆环外沿蹭过去不算）；而且那只手必须是「从外面进来」的
  let hover = null;
  for (const it of layout) {
    for (const p of palms) {
      const d = Math.hypot(p.x - it.cx, p.y - it.cy);
      const same = st.id === it.id && st.side === p.side;
      if (d > (same ? it.hit : it.start)) continue;
      if (!same && !st.armed[p.side]) continue;       // 闸 4：没从外面进来的手不算
      if (!hover || d < hover.d) hover = { id: it.id, d, side: p.side };
    }
  }
  const item = hover ? layout.find((it) => it.id === hover.id) : null;
  /** 三个导航圆环（返回 / 上一页 / 下一页）都用更长的 5 秒蓄力，见 MENU_NAV_HOLD_MS 的说明 */
  const holdMs = item && MENU_NAV_KINDS[item.kind] ? MENU_NAV_HOLD_MS : GESTURE_HOLD_MS;
  const dt = clamp(now - (st.at || now), 0, 250);

  if (hover) {
    if (hover.id !== st.id || hover.side !== st.side) {   // 换了一格 / 换了只手：这一格从头开始
      if (st.id) paintMenuRing(st.id, 0);
      st.id = hover.id;
      st.side = hover.side;
      st.since = now;
      st.p = 0;
      st.announced = '';
      st.armed[hover.side] = false;                      // 许可用掉了：要再选一次得先出环再进环
    }
    if (!st.since) st.since = now;
    st.lastInside = now;
    // ---- 闸 3：手在动 → 计时的起点跟着往后挪，进度就不涨（走过去 / 挥过去都不算）
    if (speed[st.side] > MENU_STILL_SPEED * size.h) st.since += dt;
    st.p = clamp((now - st.since) / holdMs, 0, 1);
    // 指着某一格一会儿了 → 把它念出来（先确认「我指的是这个」，再决定要不要停满 3 秒）
    if (item && st.p >= MENU_ANNOUNCE_P && st.announced !== st.id) {
      st.announced = st.id;
      audio.say(item.name, { rate: 1.25, minGapMs: 400 });
    }
  } else if (st.id && now - st.lastInside > GESTURE_GRACE_MS) {
    // 手移开了：宽限期内先不动，之后退回去（菜单里退得更快，蹭一下不留痕迹）
    st.p = Math.max(0, st.p - dt / MENU_DRAIN_MS);
    if (st.p <= 0) { st.since = 0; st.id = ''; st.side = ''; st.announced = ''; }
  }
  st.at = now;

  if (st.id) {
    const left = Math.max(0, holdMs - (now - st.since)) / 1000;
    paintMenuRing(st.id, st.p, left);
  }
  if (!st.id || st.p < 1) return null;

  const fired = item;
  if (fired && (fired.kind === 'prev' || fired.kind === 'next')) {
    // 翻页：**不清进度**，按住不放就一页一页接着翻（这里把计时重新起算）
    st.p = 0;
    st.since = now;
    return { kind: 'page', dir: fired.dir };
  }
  const picked = st.id;
  resetMenuProgress();
  return { kind: 'select', id: picked };
}

/**
 * 右上角圆环的文案：**退出（回菜单）**。
 *
 * 它现在只在训练界面里出现 —— 手势菜单里改成每一级都有一格「↩ 返回」了
 * （用户要求：「在第一级菜单选择页面去掉『退出』圆环，增加一个『返回』圆环」）。
 */
function syncCornerLabel() {
  const txt = t('ui.gestureExit');
  // 圆环里只画图标（和「返回」同一颗），文字放到 title / aria-label 上
  setRingIcon(cornerLabelEl(), ringEl('corner'), 'exit', txt);
  // 「设置」环也一样：齿轮线条图标（`ui:settings`）+ title / aria-label（中英随语言切换）
  setRingIcon($('ringQuickSetLabel'), ringEl('settings'), 'settings', t('ui.gestureSet'));
}

/** 进手势菜单（首页「开始」按钮，或者从训练里退出） */
function openMenu({ silent = false } = {}) {
  // 从训练里退出来：先把这一组正常收尾（结算 / 记录照旧），再切到菜单
  if (state.session === 'running' || state.session === 'paused' || state.session === 'countdown') {
    stopSession('switch');
  }
  hideGestureRings();        // stopSession 会把「一组结束」的两个圆环摆出来，这里收掉
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  $('countdown').hidden = true;
  $('celebrate').hidden = true;
  state.celebrateUntil = 0;
  state.menuMode = true;
  state.menuLevel = 0;       // 每次都从第一级（分类）第一页开始
  state.menuCategory = '';
  state.menuPage = 0;
  state.homeMode = false;    // 菜单不算主页：摄像头要开着、识别要跑
  state.session = 'idle';
  state.calib = null;
  renderCalibration(null);
  $('homeView').hidden = true;
  $('workoutView').hidden = false;
  $('workoutView').classList.add('menu-mode');
  $('stage').classList.add('menu-mode');
  $('btnHome').hidden = false;
  $('btnExercise').hidden = true;    // 手势菜单里也没有「运动设定」（它只在主页右上角）
  renderMenu();
  $('gestureMenu').hidden = false;
  /**
   * 从动作里退回菜单 / 刚进菜单：让这一屏**从左边滑入 + 淡入**（用户要求返回也要有滑动淡入淡出）。
   * 用 `animateMenuSwap` 的「只做入场」那一半 —— 传一个空的重建函数（这一屏刚刚已经建好了）。
   */
  animateMenuSwap(-1, () => {});
  syncCornerLabel();         // 右上角那个圆环此刻是隐藏的（菜单里不显示它）
  syncCornerExit();
  updateButtons();
  if (!silent) audio.say(t('menu.title'), { rate: 1.05 });
}

/** 离开菜单（选中动作 / 回首页时调用）：收起覆盖层与 menu-mode 样式 */
function closeMenu() {
  renderPaws([]);
  state.menuMode = false;
  const menu = $('gestureMenu');
  if (menu) menu.hidden = true;
  $('workoutView')?.classList.remove('menu-mode');
  $('stage')?.classList.remove('menu-mode');
  resetMenuProgress();
  syncCornerLabel();
}

/**
 * 菜单里选中一格（手掌停满 3 秒，或者鼠标点一下那一格）。
 *
 * 两级菜单：分类 → 进第二级；「↩ 返回」→ 第二级回第一级、第一级回**网页首页**；
 * 动作 → 进训练界面（全屏留着，校准通过自动开练）。
 */
function selectFromMenu(id) {
  if (!state.menuMode) return;
  // 「返回」在右上角常驻（不在 menuItems 里），翻页圆环在顶部那一带，所以三处一起找
  const item = [...menuItems(), ...menuNavLayout(stageSize()), menuBackItem(stageSize())]
    .find((it) => it.id === id);
  if (!item) return;
  if (item.kind === 'category') {
    audio.milestone();
    state.menuLevel = 1;
    state.menuCategory = item.catId;
    state.menuPage = 0;
    // 进下一层：走一遍**向右滑入**的动画（和「下一页」同方向，符合「往里走」的直觉）
    animateMenuSwap(1, () => renderMenu());
    audio.say(item.name, { rate: 1.1, force: true });
    return;
  }
  if (item.kind === 'back') {
    audio.milestone();
    // 两级都有「返回」（图标都是 ↩，用户要求一致）：第二级 → 回分类；第一级 → 回网页首页
    if (state.menuLevel === 0) {
      audio.say(t('ui.gestureExit'), { rate: 1.1, force: true });
      menuBackHome();                     // 淡出 + 主页淡入（用户要求返回也要有淡入淡出）
      return;
    }
    state.menuLevel = 0;
    state.menuCategory = '';
    state.menuPage = 0;
    // 回上一层：走一遍**向左滑入**的动画（和「上一页」同方向，符合「往回走」的直觉）
    animateMenuSwap(-1, () => renderMenu());
    audio.say(t('menu.title'), { rate: 1.05 });
    return;
  }
  const ex = localizedExercise(id);
  audio.milestone();
  audio.say(t('menu.picked', { name: ex.name }), { rate: 1.1, force: true });
  closeMenu();
  openExercise(id);          // 视频界面已经是全屏的，这里不会再动全屏
}

/**
 * 首页那个大「开始」按钮：**先同步进全屏** →（必要时）弹一次授权框 → 开摄像头 → 手势菜单
 *
 * 用户要求：「点击『开始体感训练』，如果已经完成了【摄像头 + 麦克风】组合授权，
 * 则不用弹窗授权，直接进入全屏状态，否则应该弹窗要求客户授权，再进入全屏状态。」
 *
 * 权限那一段是异步的（见 startGestureCamera），这里**绝不 await**：点击回调必须保持同步，
 * 否则原生 `requestFullscreen()` 会因为「不是在用户手势里」被浏览器拒绝。
 */
function startGestureMode() {
  if (!Camera.supported()) { setCueLine(t('menu.needCamera'), 'warn'); return; }
  // ⚠️ 全屏必须在**这个点击手势的同步执行栈里**申请：先切视图（#stage 得可见）→ 申请全屏
  // → 再谈权限 / 开摄像头。一旦先 await 了 getUserMedia（可能弹授权框），手势就消耗掉了。
  state.camStoppedForHome = false;   // 摄像头由下面统一开，别让 showWorkout 里再开一次
  showWorkout();
  openMenu({ silent: true });
  requestStageFullscreen();
  // 已授权 → 不显示任何「请允许」的提示，直接开（浏览器这时不会再弹框）；
  // 未授权 → 遮罩上先换成「需要授权」的说法，再开（那一步才会弹一次组合授权框）。
  startGestureCamera();
  audio.say(t('menu.title'), { rate: 1.05 });
}

/* ------------------------------------------------------------------ *
 * 摄像头 + 麦克风授权：先查状态，再决定要不要弹框
 *
 * 用户要求：「如果已经完成了【摄像头 + 麦克风】组合授权，就不用弹窗授权，直接进入全屏状态，
 * 否则应该弹窗要求客户授权，再进入全屏状态。」
 *
 * 查的是 `navigator.permissions.query({ name: 'camera' | 'microphone' })`：
 *   · Firefox 不认这两个名字（直接抛 TypeError）、部分浏览器根本没有 `navigator.permissions`
 *     → 一律当作「未知」，按「需要授权」处理（让浏览器自己弹框），**异常绝不往外抛**。
 *
 * ⚠️ 两个权限**分开判**（别一刀切）：`821c30a` 的硬要求是「麦克风失败不能影响训练」，
 * 所以只有**摄像头**被拒才算练不了（不再请求 → 错误 / 诊断面板）；麦克风被拒只降级成
 * 「只请求摄像头」，训练照常开始 —— 否则「摄像头已允许、只拒了麦克风」的用户会完全练不了。
 * ------------------------------------------------------------------ */

/**
 * 查一个媒体权限此刻的状态（永不抛异常；查不到就是 unknown）。
 * @param {'camera'|'microphone'} name
 * @returns {Promise<'granted'|'prompt'|'denied'|'unknown'>}
 */
async function queryMediaPermission(name) {
  try {
    const perms = typeof navigator !== 'undefined' ? navigator.permissions : null;
    if (!perms || typeof perms.query !== 'function') return 'unknown';
    const status = await perms.query({ name });
    const st = status && status.state;
    return st === 'granted' || st === 'prompt' || st === 'denied' ? st : 'unknown';
  } catch {
    // Firefox 会为 camera / microphone 抛错（不支持这两个名字）：当作未知，别让异常冒出去
    return 'unknown';
  }
}

/**
 * 摄像头 / 麦克风各自的权限状态（两个分开返回，怎么处置由调用方按「谁被拒」决定）。
 * @returns {Promise<{camera:'granted'|'prompt'|'denied'|'unknown', microphone:'granted'|'prompt'|'denied'|'unknown'}>}
 */
async function queryGesturePermission() {
  const [camera, microphone] = await Promise.all([
    queryMediaPermission('camera'),
    queryMediaPermission('microphone'),
  ]);
  return { camera, microphone };
}

/**
 * 这一次请求要不要带麦克风（纯函数）：**只有麦克风被拒时不要**。
 *
 * 被拒时还带 `audio: true` 只会让整次组合请求立刻失败（不会再弹框），白白多走一轮
 * `Camera.start` 的降级 —— 直接请求摄像头更干脆；麦克风被拒绝不能拦住训练。
 */
function gestureWantsMic(perm = {}) {
  return (perm && perm.microphone) !== 'denied';
}

/**
 * 遮罩上那两句话按授权状态换说法（摄像头已授权时一句「请允许」都不提）。
 * 麦克风被拒时再补一句说明 —— 摄像头打开前遮罩正好在眼前，用户一眼能看到「训练照常、只少了 AI 教练」。
 * @param {object} perm     queryGesturePermission() 的结果
 * @param {{micDenied?:boolean}} [opts]
 */
function applyGestureMaskText(perm = {}, { micDenied = false } = {}) {
  const granted = (perm && perm.camera) === 'granted';
  const base = t(granted ? 'ui.maskGrantedText' : 'ui.maskPermText');
  $('maskIcon').textContent = '⏳';
  $('maskTitle').textContent = t(granted ? 'ui.maskGrantedTitle' : 'ui.maskPermTitle');
  $('maskText').textContent = micDenied ? `${base}${t('ui.micDeniedHint')}` : base;
}

/**
 * 麦克风被拒（但摄像头还能用）：**不拦训练**，只给一句轻量说明 ——
 * 画面上一句 6 秒的提示（全屏里也看得见）+ 侧栏状态行留一句。
 * 用途说明白（AI 教练需要它），并告诉用户去哪儿重新允许。
 */
function showMicDeniedHint() {
  const hint = t('ui.micDeniedHint');
  setHint(hint, 'warn', 6000);     // 视频画面上的临时提示（不挡画面、6 秒后自己消失）
  setCueLine(hint, 'warn');        // 侧栏状态行：留着一句，直到被下一次状态更新覆盖
}

/**
 * **摄像头**权限已经是 `denied`：**不要再请求**（浏览器不会再弹框，请求只会立刻失败），
 * 直接把现有的摄像头错误 / 诊断面板那一套摆出来 —— 遮罩 + 诊断面板 + 处置建议，
 * 并明确告诉用户「请在地址栏左侧允许摄像头与麦克风」。
 * （麦克风被拒**不走这里**：那只是少了 AI 教练，训练照常，见 showMicDeniedHint。）
 */
function showGesturePermissionDenied() {
  const hint = t('ui.maskPermDeniedText');
  const err = { name: 'NotAllowedError', message: hint };
  state.camError = `${err.name}: ${err.message}`;
  state.camErrName = err.name;
  state.camErrMessage = err.message;
  const mask = $('stageMask');
  if (mask) mask.classList.remove('hidden');
  $('maskIcon').textContent = '⚠️';
  $('maskTitle').textContent = t('ui.maskCamFailTitle');
  $('maskText').textContent = `${hint}${t('ui.maskCamFailSuffix')}`;
  $('btnStartCam').textContent = t('ui.retry');
  renderCameraDiag(err);          // 诊断面板里同时给出「权限被拒」的处置建议
  updatePipelineStatus();
  setCueLine(hint, 'warn');
}

/**
 * 点击「开始体感训练」之后的异步部分（点击回调里已经**同步**进过全屏了）：
 *   ① 先查摄像头 / 麦克风各自的权限；
 *   ② **摄像头被拒** → 不再请求，直接走错误 / 诊断面板（这时练不了）；
 *   ③ 摄像头已授权 → 不显示任何「请允许」的提示，直接开（getUserMedia 也不会再弹框）；
 *      摄像头待授权 / 未知 → 遮罩上换成「需要授权」的说法，再开（这一步才弹组合授权框）；
 *   ④ **麦克风被拒不影响训练**：改成只请求摄像头（`{ mic: false }`）+ 一句轻量说明；
 *   ⑤ 最后确认还在全屏里：原生全屏那条路没成（权限框打断了手势 / 浏览器没有元素级全屏）
 *      → CSS 伪全屏兜底（伪全屏不需要手势，所以「授权完 → 也是全屏」）。
 * 不 `await` 它：调用方（点击回调）必须保持同步。
 */
async function startGestureCamera() {
  try {
    const perm = await queryGesturePermission();
    // 只有摄像头被拒才拦训练（麦克风被拒只是没有 AI 教练，见下面 wantMic）
    if (perm.camera === 'denied') { showGesturePermissionDenied(); return; }
    const wantMic = gestureWantsMic(perm);
    if (!wantMic) showMicDeniedHint();
    // 用户要求：「在首页点击『开始体感训练』的时候就提示授权麦克风」
    // → 这一次 getUserMedia 同时带 video + audio，只弹一次组合授权框；拿到后音轨立刻 stop。
    // 其它任何 startCamera 调用都不带 mic（不重复弹框）。
    if (!camera.active) {
      if (wantMic) startCamera(state.settings.camDeviceId || null, { mic: true });
      else startCamera(state.settings.camDeviceId || null, { mic: false });
    }
    applyGestureMaskText(perm, { micDenied: !wantMic });
    await ensureGestureFullscreen();
  } catch (err) {
    console.warn('[camera] permission flow failed:', err?.name || err);
  }
}

/* ------------------------------------------------------------------ *
 * 全屏降级链：iPhone 也要能「全屏」
 *
 * 用户实测「Safari 和 Chrome 都无法进入全屏模式」——原因是 **iOS Safari 没有元素级
 * Fullscreen API**（`requestFullscreen` 在 iPhone 上不存在，只有 iPad 有），
 * 所以「点了没反应」。这里按能力依次降级：
 *
 *   ① 标准 `element.requestFullscreen()`      → PC / Android / iPad
 *   ② 老 WebKit `webkitRequestFullscreen()`   → 旧 Safari / 旧 Chromium
 *   ③ **CSS 伪全屏**（`.pseudo-fullscreen`）  → iPhone 的兜底：`#stage` 固定铺满视口，
 *      页面其余部分与滚动被锁住；**我们自己画的 HUD / 判定进度条 / 圆环全都保留**
 *      （这正是 `<video>.webkitEnterFullscreen()` 做不到的：它只放大视频，叠加层全丢）。
 *
 * `pickFullscreenMode` 是纯函数（喂一组能力就返回走哪条路），所以测试能直接钉住降级顺序。
 * ------------------------------------------------------------------ */

/** 伪全屏的类名：`#stage` 与 `body` 同时挂着（样式见 style.css） */
const PSEUDO_FS_CLASS = 'pseudo-fullscreen';

/**
 * 最近一次「原生全屏申请」的结果：`Promise<boolean>`（true = promise 真的 resolve 了）。
 *
 * 为什么需要它：原生 `requestFullscreen()` 是**异步落定**的（浏览器什么时候真的进全屏
 * 只有 promise 知道），而「开始体感训练」在申请完全屏之后还要去查权限 / 等授权框 ——
 * 那一步跑完得回头看这一次申请到底成没成，没成就补 CSS 伪全屏（见 ensureGestureFullscreen）。
 */
let nativeFullscreenAttempt = Promise.resolve(false);

/**
 * 按能力挑一条全屏路径（纯函数）。
 * @param {{requestFullscreen?:boolean, webkitRequestFullscreen?:boolean, pseudo?:boolean}} caps
 * @returns {'standard'|'webkit'|'pseudo'|'none'}
 */
function pickFullscreenMode(caps = {}) {
  if (caps.requestFullscreen) return 'standard';
  if (caps.webkitRequestFullscreen) return 'webkit';
  if (caps.pseudo !== false) return 'pseudo';   // 伪全屏没有前置条件，永远可用
  return 'none';
}

/** 当前环境到底有哪些全屏能力（读真实 DOM；`pseudo` 恒为 true） */
function fullscreenCaps() {
  const stage = $('stage');
  const doc = typeof document !== 'undefined' ? document : null;
  return {
    requestFullscreen: typeof stage?.requestFullscreen === 'function',
    webkitRequestFullscreen: typeof stage?.webkitRequestFullscreen === 'function',
    fullscreenElement: !!(doc && (doc.fullscreenElement || doc.webkitFullscreenElement)),
  };
}

/** CSS 伪全屏现在开着吗 */
function pseudoFullscreenOn() {
  const stage = $('stage');
  return !!(stage && stage.classList && stage.classList.contains(PSEUDO_FS_CLASS));
}

/**
 * 开 / 关 CSS 伪全屏：`#stage` 与 `body` 两个类一起切（只改定位与滚动，不动任何子元素），
 * 切完重摆一次圆环 / 菜单 —— 舞台尺寸变了，它们必须跟着变。
 */
function setPseudoFullscreen(on) {
  const stage = $('stage');
  if (stage && stage.classList) stage.classList.toggle(PSEUDO_FS_CLASS, !!on);
  if (typeof document !== 'undefined' && document.body && document.body.classList) {
    document.body.classList.toggle(PSEUDO_FS_CLASS, !!on);
  }
  $('btnFullscreen')?.setAttribute('aria-pressed', String(!!on));
  if (typeof onStageResize === 'function') onStageResize();
  return !!on;
}

/**
 * 申请「视频框」全屏（右上角那个按钮、首页大按钮、`F` 键都走这里）。
 * 返回 true = 「已经进入某种全屏」（原生或伪全屏）。
 */
function requestStageFullscreen() {
  const stage = $('stage');
  if (!stage) return false;
  const caps = fullscreenCaps();
  if (caps.fullscreenElement) {                       // 已经是原生全屏了，别重复申请
    $('btnFullscreen')?.setAttribute('aria-pressed', 'true');
    nativeFullscreenAttempt = Promise.resolve(true);
    return true;
  }
  const mode = pickFullscreenMode(caps);
  if (mode === 'pseudo') {
    nativeFullscreenAttempt = Promise.resolve(false);   // 这条路上根本没有原生全屏
    return setPseudoFullscreen(true);
  }
  try {
    const p = mode === 'webkit' ? stage.webkitRequestFullscreen() : stage.requestFullscreen();
    // 原生申请被拒（例如权限策略 / 手势已被授权框消耗）时不要停在「半全屏」，直接落到伪全屏兜底
    nativeFullscreenAttempt = p && typeof p.then === 'function'
      ? Promise.resolve(p).then(() => true, () => { setPseudoFullscreen(true); return false; })
      // 老实现返回 void：拿不到结果，只能看此刻的状态
      : Promise.resolve(stageFullscreenOn());
    $('btnFullscreen')?.setAttribute('aria-pressed', 'true');
    return true;
  } catch {
    nativeFullscreenAttempt = Promise.resolve(false);
    return setPseudoFullscreen(true);
  }
}

/**
 * 「开始体感训练」的授权流程跑完之后，确保用户**在全屏里**（用户要求「再进入全屏状态」）。
 *
 *   ① 先等点击那一下的原生全屏申请落定（promise 不落定就没法判断它成没成）；
 *   ② 已经在原生全屏或伪全屏里 → 什么都不做；
 *   ③ 不在 → CSS 伪全屏兜底。伪全屏**不需要用户手势**，所以在 await 之后补上完全合法 ——
 *      这条正是「原生全屏因为授权框丢了手势」时唯一的救命路；
 *      另外 Safari 在弹授权框时会把原生全屏退掉，这里也顺手补回来。
 *
 * 退出方式不变：Esc / 右下角全屏按钮 / 伪全屏那颗按钮都能退。
 * @returns {Promise<boolean>} true = 现在处于某种全屏
 */
async function ensureGestureFullscreen() {
  try { await nativeFullscreenAttempt; } catch { /* 原生那条路失败已经在上面兜成伪全屏了 */ }
  if (stageFullscreenOn()) return true;
  return setPseudoFullscreen(true);
}

/** 现在处于任何一种全屏（原生 or 伪）吗 */
function stageFullscreenOn() {
  const caps = fullscreenCaps();
  return !!caps.fullscreenElement || pseudoFullscreenOn();
}

/** 同一个按钮：不在全屏就进、在就出（返回 true = 现在处于全屏） */
function toggleStageFullscreen() {
  if (stageFullscreenOn()) {
    exitFullscreen();
    return false;
  }
  requestStageFullscreen();
  return stageFullscreenOn();
}

/** 右上角两颗圆环的每帧维护（菜单与训练页共用）：对齐显隐 → 更新进度 → 触发 */
function tickCornerExit(landmarks, now) {
  syncCornerExit();
  if (!gestureState.cornerVisible) return;
  // 先攒「退出」的进度：它一旦触发就会把整个容器（含设置环）收起来
  if (updateCornerExit(landmarks || null, now)) {
    triggerCornerExit();
    return;
  }
  // 设置环在退出环正下方，判定 / 蓄力各算各的，不会互相干扰
  if (updateSetRing(landmarks || null, now)) triggerSetRing();
}

/** 舞台尺寸变化（横竖屏切换、全屏）时把圆环重新摆一次，并按新的圆环直径重算 HUD 数字字号 */
function onStageResize() {
  if (gestureState.visible) layoutGestureRings();
  if (gestureState.cornerVisible) layoutCornerRing();
  if (state.menuMode) layoutMenu();
  // 圆环直径跟着 --ring-px 的 clamp 变了 → 环里那个数字要重新收放（用户要求「resize 时重算」）
  syncHudValueSize();
}

/* ------------------------------------------------------------------ *
 * 判定进度条：把判据摊成几步，每识别到一个姿态就点亮一格
 *
 * 每一格都是识别器真正用的阈值（见 specs.js 的 specStages），顺序就是判定顺序：
 *   站姿/俯撑到位 → 开始这一轮 → 计入一次 → 双腿/离地等附加条件 → 深度到位
 * 一格点亮时：轻响一声 + 该格闪一下；如果这一步同时加了分，格子上显示 +N。
 * 每完成一次动作（rep 事件）就把进度条收回起点，下一轮重新一格一格走过去。
 * ------------------------------------------------------------------ */

/** 按当前动作重建进度条（换动作 / 重新校准时调用） */
function buildCriteriaBar() {
  // 与运动设定弹窗共用同一份模型：弹窗里列的关键帧 = 画面上显示的格子（不会各说一套）
  const { ctx, stages, icons, max, stepStage } = criteriaModel(state.exerciseId);
  state.criteriaStages = stages;
  state.criteriaIcons = icons;
  state.criteriaContext = ctx;
  state.criteriaMax = max;
  state.criteriaStepStage = stepStage;
  state.criteriaPts = new Array(stages.length).fill(0);
  // **只在换动作时建一次 DOM**：之后每一帧只改 class 和数字。
  // 为什么：以前每次「点亮一格 / 加分」都重建整条 innerHTML —— 元素被换掉，
  // 过渡和弹出动画（呼吸、对勾、分数弹出）就从头再放一遍，看起来就是「进度条一直在抖」。
  buildCriteriaSegments();
  resetCriteriaProgress();
  renderCriteriaBar();
}

/** 把这条判据链的格子建出来（图标、判据提示都写一次；状态由 renderCriteriaBar 增量更新） */
function buildCriteriaSegments() {
  const track = $('criteriaTrack');
  state.criteriaEls = [];
  if (!track) return;
  track.innerHTML = '';
  state.criteriaStages.forEach((s, i) => {
    const seg = document.createElement('div');
    seg.className = 'criteria-seg';
    seg.dataset.i = String(i);
    seg.dataset.done = '0';
    seg.dataset.pts = '0';
    // 悬停提示里给完整判据 + 这一格的分数（画面上不写文字，鼠标移上去/触摸才知道这一步要什么）
    const tip = [stageText(s).short, stageText(s).cond, criteriaPointsText(i)].filter(Boolean).join(' · ');
    seg.setAttribute('data-tip', tip);
    seg.innerHTML = state.criteriaIcons[i] || '';   // 线条图标（只在这里写一次）

    const pts = document.createElement('span');
    pts.className = 'criteria-seg-pts';
    seg.appendChild(pts);

    track.appendChild(seg);
    state.criteriaEls.push({ root: seg, pts });
  });
}

/**
 * 把进度收回起点。
 *
 * 一次动作做完时会调用它：**进度条清零、下一轮从头开始**。
 * 注意留了一小段「清零展示时间」（CRITERIA_CLEAR_MS）—— 因为动作是在回到起始姿势的那一刻
 * 才算完成的，如果立刻重新判定，「站姿」那一格会在同一帧又亮起来，用户看起来就像没清零。
 * 这段时间里进度条保持空的，之后再从站姿重新一格一格走。
 */
function resetCriteriaProgress({ holdMs = 0, now = performance.now() } = {}) {
  state.criteriaIdx = -1;
  state.criteriaJust = -1;
  state.criteriaJustPts = -1;
  state.criteriaClearUntil = holdMs > 0 ? now + holdMs : 0;
  for (let i = 0; i < state.criteriaPts.length; i++) state.criteriaPts[i] = 0;
}

/** 进度条是不是正处在「刚清零」的展示期 */
function criteriaCleared(now = performance.now()) {
  return now < state.criteriaClearUntil;
}

/** 某一格能拿多少分的文字（悬停提示用；没有分数的格子返回 ''） */
function criteriaPointsText(index) {
  const row = state.criteriaMax?.[index];
  if (!row) return '';
  const earned = state.criteriaPts?.[index] || 0;
  const parts = [];
  if (earned > 0) parts.push(t('ui.criteriaPtsGot', { n: earned }));
  const max = (row.points || 0) + (row.bonus || 0);
  if (max > 0) parts.push(t('ui.criteriaPtsMax', { n: max }));
  if (row.perSecond > 0) parts.push(t('ui.criteriaPtsPerSec', { n: row.perSecond }));
  return parts.join(' · ');
}

/** 悬停某一格：在进度条上方显示这一格的判定标准 */
function showCriteriaTip(index) {
  const tip = $('criteriaTip');
  const stage = state.criteriaStages?.[index];
  if (!tip || !stage) return;
  const { short, cond } = stageText(stage);
  const pts = criteriaPointsText(index);
  tip.innerHTML = `<span class="criteria-tip-name">${esc(short)}</span>${esc(cond)}`
    + (pts ? `<span class="criteria-tip-pts">${esc(pts)}</span>` : '');
  tip.hidden = false;
}

function hideCriteriaTip() {
  const tip = $('criteriaTip');
  if (tip) tip.hidden = true;
}

/** 某一格现在满足了没 */
function criteriaHolds(stage, frame) {
  return stageHolds(stage, frame, state.detector);
}

/**
 * 每帧推进：只看「下一格」，所以必须按顺序一格一格走，不会跳格。
 * events 是这一帧识别器抛出的事件，用来把刚加到的分标在对应格子上。
 */
function updateCriteria(frame, events, now) {
  const stages = state.criteriaStages;
  if (!stages.length) return;

  // 展示期结束 → 进度条收回起点（下一轮从头走）
  if (state.criteriaClearUntil && now >= state.criteriaClearUntil) {
    state.criteriaClearUntil = 0;
    resetCriteriaProgress();
  }

  // 「识别到人了吗」：没识别到 → 进度条整条变灰（表示还没开始工作）。
  // 识别会抖动，所以给一点宽限：短暂丢帧不立刻变灰、也不清进度，丢久了才清零。
  const seen = !!(frame && frame.ok && frame.bodyVisible !== false);
  if (seen) state.criteriaLostSince = 0;
  else if (!state.criteriaLostSince) state.criteriaLostSince = now;
  const lostMs = seen ? 0 : now - state.criteriaLostSince;
  const live = seen || lostMs < CRITERIA_LIVE_GRACE_MS;
  if (live !== state.criteriaLive) {
    state.criteriaLive = live;
    if (!live) resetCriteriaProgress();
  }

  // 这一帧加到的分（要领得分 / 满分奖励）先处理：清零展示期里也不能丢掉分数反馈。
  // 得分按**得分项 → 关键帧**的映射记到对应的格子上（见 specs.js 的 stageIndexForStep），
  // 所以「得分显示在关键帧里」和「哪个要领给的分」永远对得上，不会飘到别的格子上。
  let earned = 0;
  for (const ev of (events || [])) {
    if (!Number.isFinite(ev.points) || ev.points <= 0) continue;
    earned += ev.points;
    const mapped = ev.type === 'step' ? state.criteriaStepStage?.[ev.id] : undefined;
    let idx = Number.isFinite(mapped) ? mapped : -1;
    if (idx < 0 && ev.type !== 'step') idx = stages.length - 1;   // 整轮奖励 / 每秒分 → 最后一格
    if (idx < 0) idx = Math.max(0, Math.min(stages.length - 1, state.criteriaIdx));
    state.criteriaPts[idx] = (state.criteriaPts[idx] || 0) + ev.points;
    state.criteriaJustPts = idx;
  }
  if (earned > 0) {
    const el = $('criteriaEarned');
    if (el) {
      el.textContent = `+${earned}`;
      el.classList.remove('show');
      // 重新触发一次动画（读一次 offsetWidth）
      void el.offsetWidth;
      el.classList.add('show');
    }
  }

  // 刚清零的那一小段时间里不再判定，让「清零」这件事看得见；
  // 也只有真正在计数（running）时才往前推进 —— 校准阶段只显示「识别到人了」的颜色
  if (!live || state.session !== 'running' || criteriaCleared(now)) {
    renderCriteriaBar(now);
    return;
  }

  let advanced = -1;
  for (let i = state.criteriaIdx + 1; i < stages.length; i++) {
    if (!criteriaHolds(stages[i], frame)) break;
    state.criteriaIdx = i;
    advanced = i;
  }
  if (advanced >= 0) {
    state.criteriaJust = advanced;
    audio.criteria(advanced, stages.length);
  }
  renderCriteriaBar(now);
}

/**
 * 画进度条：**增量更新**，一格一格地只改该改的东西。
 *
 * 用户反馈「计分的时候进度条抖得厉害」——根因就是这里以前每次状态变化都重建整条 innerHTML：
 * 元素被换掉，过渡（背景/边框 0.18s）、呼吸动画、对勾、以及分数数字的弹出动画都会**从头再放一遍**，
 * 一秒一次（计时类每秒加分）就成了肉眼可见的抖动。
 * 现在：
 *   - 格子元素只在换动作时建一次（见 buildCriteriaSegments）；
 *   - class 与数字**只有真的变了才写**，动画因此只在自己该播的时候播一次；
 *   - 上面那条「本帧 +N」的牌子也只在分数变化时更新。
 */
function renderCriteriaBar(now = performance.now()) {
  const bar = $('criteriaBar');
  const track = $('criteriaTrack');
  if (!bar || !track) return;
  const stages = state.criteriaStages;
  // 整条进度条**一直显示**在动作页上：没识别到人 / 没开始计数时是灰的（尚未开始），
  // 识别到人而且正在计数时才有颜色（已经开始工作）。
  const visible = stages.length > 0 && !state.homeMode;
  const live = !!state.criteriaLive;
  const active = state.session === 'running' && live;
  $('stage').classList.toggle('has-criteria', visible);
  if (bar.hidden === visible) bar.hidden = !visible;   // 没变就别写属性（每帧都跑）
  if (!visible) return;
  if (bar.classList.contains('idle') === active) bar.classList.toggle('idle', !active);
  if (bar.classList.contains('active') !== active) bar.classList.toggle('active', active);

  const cleared = criteriaCleared(now);
  const wantReset = cleared && active;
  if (bar.classList.contains('reset') !== wantReset) bar.classList.toggle('reset', wantReset);

  const els = state.criteriaEls || [];
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (!el) continue;
    const done = i <= state.criteriaIdx;
    const earned = state.criteriaPts[i] || 0;
    const row = state.criteriaMax?.[i] || { points: 0, bonus: 0, perSecond: 0 };
    const max = (row.points || 0) + (row.bonus || 0);
    // 用 classList.toggle(name, force)：状态没变时浏览器不会改写 class 属性，
    // 于是过渡与动画不会重放（直接赋值 className 每次都算一次改动）
    el.root.classList.toggle('done', done);
    el.root.classList.toggle('current', !!active && i === state.criteriaIdx + 1);
    el.root.classList.toggle('just', i === state.criteriaJust || i === state.criteriaJustPts);
    const doneStr = done ? '1' : '0';
    if (el.root.dataset.done !== doneStr) el.root.dataset.done = doneStr;
    const ptsStr = String(earned);
    if (el.root.dataset.pts !== ptsStr) el.root.dataset.pts = ptsStr;
    // 格子上显示这一格的分：**真的拿到**了就是大号亮色数字，还没拿到的用灰色小字标出「可得」
    const got = earned > 0;
    const ptsText = got ? `+${earned}` : (max > 0 ? `+${max}` : '');
    if (el.pts.textContent !== ptsText) el.pts.textContent = ptsText;
    el.pts.classList.toggle('earned', got);
    el.pts.classList.toggle('max', !got);
  }
}

function selectExercise(id) {
  if (!EXERCISES.some((e) => e.id === id)) return;
  if (state.session === 'running' || state.session === 'paused' || state.session === 'countdown') {
    stopSession('switch');
  }
  hideGestureRings();   // 换动作：上一组的手势圆环不该留着（必须在 stopSession 之后收）
  closeSetPicker();     // 换动作：中间那一层「每组次数 / 秒数」的选项属于上一个动作，收掉
  state.exerciseId = id;
  state.settings.exerciseId = id;
  // 运动设定第二步的「编辑指针」跟着当前动作走：刚练过的动作就是选择页里高亮的那一个
  state.settingsExerciseId = id;
  const ex = localizedExercise(id);
  // 目标：限时计数类是**时长（秒）**，从 settings.seconds 取（默认就是动作自己的秒数）；
  // 计数 / 计时类是次数或秒，从 settings.targets 取（一处定义见 targetForExercise）
  state.target = targetForExercise(id);
  state.detector = createDetector(id);
  state.calibrator = state.calibrator || new Calibrator(id, { mirror: state.settings.mirror });
  state.calibrator.setExercise(id);
  state.calibrator.setMirror(state.settings.mirror);
  saveSettings();

  document.querySelectorAll('.exercise-btn, .ex-card').forEach((b) => {
    b.classList.toggle('active', b.dataset.id === id);
  });

  // HUD 里那个小图标：有「人体姿势」线条图的动作用它（和菜单 / 主页卡片一致），其余用 emoji
  $('hudIcon').innerHTML = ex.poseIcon || ex.icon;
  $('hudName').textContent = ex.name;
  $('hudUnit').textContent = ex.unit;
  $('targetUnit').textContent = ex.unit;
  $('statTimerLabel').textContent = ex.kind === 'hold' ? t('ui.holdTime') : t('ui.setTime');
  $('cameraHint').textContent = `📹 ${ex.cameraHint}`;
  if ($('judgeLine')) {
    $('judgeLine').textContent = `🎯 ${t('home.judgeBy', { what: ex.judgeText })}`
      + (ex.rough ? ` · ${t('home.rough')}` : '');
  }
  $('howtoTitle').textContent = `${ex.icon} ${ex.name} · ${t('ui.actionGuide')}`;
  $('howtoList').innerHTML = ex.howto.map((x) => `<li>${x}</li>`).join('');
  $('tipList').innerHTML = ex.tips.map((x) => `<li>${x}</li>`).join('');
  $('targetInput').value = String(state.target);
  buildTargetChips();
  renderExerciseSettings();
  buildCriteriaBar();          // 判定进度条：换成这个动作的判据链
  $('summaryCard').hidden = true;
  state.stepSig = '';
  state.saidSteps = new Set();
  state.lastScoreMilestone = 0;
  // 选好动作 → 校准一完成就自动开始（这是用户明确选的动作，不用再点一次）
  toCalibration({ silent: true });
  updateHud();
  renderRecords();
}

/**
 * 进入「运动前校准」阶段：显示虚线人体轮廓，不计数。
 *
 * 默认（afterSet=false）：全身识别一完成，虚线框消失并自动进入运动状态（3-2-1 倒计时）。
 * afterSet=true：一组结束后回到校准，先让用户休息 —— 停在原地不会自动开始（画面上的提示条
 *   会写明「点开始训练」）；一旦离开轮廓（站起来、走开），自动开始立刻恢复，再站好就又会自动开始。
 */
function toCalibration({ silent = false, afterSet = false } = {}) {
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  state.countdownStartedAt = 0;
  $('countdown').hidden = true;
  $('celebrate').hidden = true;
  releaseWakeLock();
  state.session = 'calibrating';
  state.autoStart = true;
  state.afterSet = afterSet;
  resetCriteriaProgress();   // 回到校准：进度条从起点等着
  // 新阶段开始：让语音教练可以立刻开口（不受上一阶段的节流限制）
  state.coachAt = -Infinity;
  state.coachSig = '';
  state.calibrator?.reset();
  state.calib = null;
  state.elapsedMs = 0;
  state.goalHit = false;
  // 回到校准：限时计数的「时间到」也一起清掉，下一组重新计时
  state.timeUp = false;
  state.timeCallsSaid = null;
  state.stepSig = '';
  state.lastTick = performance.now();
  if (!silent) {
    setCueLine(t('calib.lead'));
    // 底部状态条在校准阶段不参与（画面上方有专门的提示条），避免同一句话出现两次
    setHint(null);
    audio.say(t('calib.promptIn'), { rate: 1.05, force: true });
  }
  updateButtons();
}

function buildTargetChips() {
  const ex = localizedExercise(settingsExerciseId());
  const presets = targetPresetsFor(ex);
  const chips = $('targetChips');
  chips.innerHTML = '';
  for (const v of presets) {
    const b = document.createElement('button');
    b.type = 'button';
    // 限时计数的预设是**时长**（秒），不是次数 —— 用 targetUnit 才不会写错单位
    b.textContent = `${v} ${ex.targetUnit}`;
    b.addEventListener('click', () => setTarget(v));
    chips.appendChild(b);
  }
}

/**
 * 写某一个动作的目标（次数 / 秒数）。
 *
 * 目标本来就是**按动作分别存**的：计时 / 限时计数类存 `settings.seconds[id]`（时长），
 * 其余存 `settings.targets[id]`（次数）—— 所以两个动作互不影响。
 *
 * `forId` 省略时写「运动设定弹窗第二步正在编辑的那个动作」（老行为）；
 * 动作页右上角「设置」环会显式传**正在练的这个动作**（`state.exerciseId`），
 * 因为那颗环属于当前这一屏，和弹窗里选中的是哪一个无关。
 */
function setTarget(v, forId) {
  const id = forId && EXERCISE_MAP[forId] ? forId : settingsExerciseId();
  const ex = localizedExercise(id);
  if (!ex) return 0;
  const n = clamp(Math.round(Number(v) || ex.defaultTarget), 1, 999);
  // 限时计数存到 seconds（时长），其他动作存到 targets（次数）
  if (ex.timed) {
    state.settings.seconds = state.settings.seconds || {};
    state.settings.seconds[id] = n;
  } else {
    state.settings.targets[id] = n;
  }
  // 正在练的就是它 → 当前目标 / HUD / 侧栏摘要跟着变（编辑别的动作时不碰这些）
  if (id === state.exerciseId) {
    state.target = n;
    updateHud();
  }
  // 弹窗里的数字框只在它编辑的正是这个动作时才跟着改（设置环改的是**当前动作**，可能不是它）
  if (id === settingsExerciseId()) $('targetInput').value = String(n);
  saveSettings();
  renderExerciseSettings();
  renderExercisePicker();   // 第一步每一项上的「15 次」小字也跟着更新
  return n;
}

/* ------------------------------------------------------------------ *
 * HUD / 面板刷新
 * ------------------------------------------------------------------ */

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** HUD 进度圆环的直径（像素）：读真实元素（= CSS 的 `--ring-px`），读不到按同一组 clamp 兜底 */
function hudRingPx() {
  return ringPx('hud');
}

/** `.hud` 的内边距（`padding: 16px 18px`）—— 列的左 / 上边缘与它同源，改一处两边一起动 */
const HUD_COLUMN_PAD_X = 18;
const HUD_COLUMN_PAD_TOP = 16;

/**
 * HUD 左栏那一列（**目标 / 圆环 / 计分**）的几何 —— 用户两条要求的「一处定义」：
 *   「把**目标次数**放在计数圆环的上方，和圆心纵向对齐」；
 *   「**计分**也与圆心纵向对齐」。
 *
 * 版面本身是 CSS 做的（`.hud-stack` = flex 列 + `align-items: center`），所以这里只算**同一条中线**：
 *   · 列的左边缘 = `.hud` 的左内边距（18px） + 左边安全区；
 *   · 列宽 = 最宽的那一行 —— 正常就是圆环直径（`--ring-px`）；目标 `20 次` / 秒数、分数都比环窄，
 *     真更宽时整列一起变宽，三行仍然共用同一根竖线；
 *   · 于是三行的中心 x **恒等于** `left + colW / 2`，圆环的圆心也正好在这一根线上。
 *
 * ⚠️ **名称不在这条中线上**：用户后来改主意「还是把运动的名称放在左上角，在目标次数的上面」——
 * `#hudName` 待在左栏顶部那行胶囊（`.hud-badge`，与动作图标同一行、**靠左**），`.hud-stack` 里**只有**
 * 目标 / 圆环 / 计分三者，所以这个函数也只算这三者（`rows` 里没有 name）。
 *
 * 纯函数（只读「CSS 算出来的圆环直径 + 舞台尺寸」），测试能直接调它断言「三者中心 x 相同」；
 * `?probe=1` 的 JSON 里也带上这几个数 —— 用户反馈「版面看着不对」时能直接读出当时的实际坐标。
 */
function hudColumnGeom(size = stageSize(), opts = {}) {
  const safe = safeAreaInsets();
  const ringPx = Number(opts.ringPx ?? hudRingPx()) || 0;
  const left = HUD_COLUMN_PAD_X + safe.left;
  const top = HUD_COLUMN_PAD_TOP + safe.top;
  // 目标 / 分数两行的宽度（可选，传进来才算）：不知道就当「比圆环窄」，列宽由圆环决定
  const targetW = Number(opts.targetW) || 0;
  const scoreW = Number(opts.scoreW) || 0;
  // 列宽 = 最宽那一行；`align-items: center` 让每一行都在这个宽度里居中 → 同一根竖线
  const colW = Math.max(ringPx, targetW, scoreW);
  const cx = left + colW / 2;
  return {
    left,          // 列的左边缘（正常就是圆环的左边缘）
    top,           // 图标那一行的上边缘（= .hud 的上内边距 + 上安全区）
    ringPx,        // 圆环直径（= CSS 的 --ring-px）
    colW,          // 这一列的宽度（最宽那一行）
    cx,            // ★ 目标 / 圆环 / 计分**共用**的中心 x
    width: size.w, // 舞台宽度（只用来核对「右侧还留得下退出圆环」）
    rows: {
      // 目标在环**上方**（DOM 里也在 #hudRing 之前）
      target: { w: targetW, cx },
      // 圆环居中：左边缘 = cx − 直径/2
      ring: { w: ringPx, cx, left: cx - ringPx / 2, right: cx + ringPx / 2 },
      // 计分在环**下方**（DOM 里在 #hudRing 之后）
      score: { w: scoreW, cx },
    },
  };
}

/**
 * 把 `#hudValue` 的字号调到「刚好放进圆环内径」（用户要求：数字变大时动态缩小，不出圈）。
 *
 * 纯计算在 `hudValueFontSize(ringPx, text)` 里（测试直接调它），这里只负责读环直径、
 * 把结果写进行内 `font-size`。三处会调：
 *   · `updateHud()` —— 次数 / 秒数每变一次都重算；
 *   · `onStageResize()` —— 窗口 resize / 转屏 / 全屏切换后圆环直径变了；
 *   · 换语言后 HUD 重绘也走 updateHud()。
 * 返回写进去的字号（测试用来断言「100 → 1000 会变小」）。
 */
function syncHudValueSize() {
  const el = $('hudValue');
  if (!el) return 0;
  const size = hudValueFontSize(hudRingPx(), el.textContent || '');
  el.style.fontSize = `${size}px`;
  return size;
}

function updateHud() {
  const ex = localizedExercise(state.exerciseId);
  const det = state.detector;
  const isHold = ex.kind === 'hold';
  const timed = !!ex.timed;

  const valid = det ? det.validReps : 0;
  const partial = det ? det.partialReps : 0;
  const holdMs = det ? det.holdMs : 0;
  const score = det ? det.score : 0;
  // 限时计数：剩几秒（时间到后固定显示 0，不会出现负数）
  const totalMs = state.target * 1000;
  const leftSec = timed ? Math.max(0, Math.ceil((totalMs - state.elapsedMs) / 1000)) : 0;

  // 左上角：名称后面紧跟**本组目标**（计数类 `20 次`、计时 / 限时类是 `45 秒`）——
  // 单位取 ex.targetUnit（与「运动设定」弹窗、选择页上的小字同一份），不另抄一份文案。
  $('hudTarget').textContent = `${state.target} ${ex.targetUnit}`;
  $('hudUnit').textContent = ex.unit;

  if (isHold) {
    $('hudValue').textContent = String(Math.floor(holdMs / 1000));
    // 目标已经在名称后面了，下面这行不再重复「目标 30 秒」
    $('hudSub').textContent = '';
  } else {
    // 限时计数：大数字仍然是**次数**（这一组跳了多少下），时长在下面那行
    $('hudValue').textContent = String(valid);
    $('hudSub').textContent = timed
      ? `⏱ ${t('ui.timeLeft', { left: leftSec, total: state.target })}`
      : '';
  }
  // 次数 / 秒数的位数会变（9 → 100 → 1000、读秒到 100 秒以上）→ 每次都按位数重算字号
  syncHudValueSize();
  $('hudScore').textContent = scoreText(score);

  // 进度环：计时类与限时计数类走**时间**进度（还剩多少时间一眼看得出），其余走次数进度
  const progress = isHold
    ? clamp(holdMs / totalMs, 0, 1)
    : (timed ? clamp(state.elapsedMs / totalMs, 0, 1) : clamp(valid / state.target, 0, 1));
  const C = 2 * Math.PI * 52;
  $('ringFg').style.strokeDashoffset = String(C * (1 - progress));
  $('ringFg').style.stroke = progress >= 1 ? 'var(--good)' : 'var(--accent)';

  $('hudExtra').textContent = partial > 0
    ? `${t('ui.partial')} ${partial}`
    : (det && det.phase && det.phase !== 'idle' ? t(`phase.${det.phase}`) : '');

  $('statValid').textContent = isHold ? `${(holdMs / 1000).toFixed(1)} ${ex.unit}` : String(valid);
  $('statPartial').textContent = isHold ? '—' : String(partial);
  $('statScore').textContent = scoreText(score);
  $('statTimer').textContent = fmtClock(state.elapsedMs);
  const depth = det ? Math.round(det.depthPct || 0) : 0;
  $('statDepth').textContent = `${depth}%`;
  $('depthFill').style.width = `${depth}%`;

  renderSteps();
}

/**
 * 命令快车道用的**只读**状态快照（P3.2）。
 *
 * 命令的 `run()` 不许直接读 `state` / 改 `state`，只能拿这一份快照做判断：
 * 「暂停」要知道现在是不是 running、「我做了几个」要读次数与分数、
 * 「第三个」要知道菜单开没开。这里只读，不触发任何刷新。
 *
 * P3.3 Agent 化（用户要求）后这份快照也是 LLM context 的**原始事实来源**：
 * 除了命令要用的字段，还带上「现在在哪个界面 / 这一组的关键帧 / 最近练过什么 /
 * 最近被提示了什么 / 今天练了多少」—— 再由 `buildAgentContext()` 算成结构化 context。
 */
function getStateSnapshot() {
  const ex = localizedExercise(state.exerciseId);
  const det = state.detector;
  /* 关键帧（判据）进度：名称 / 是否达标 / 得分 / 满分（只给这一组，不塞原始关节角度） */
  const stages = Array.isArray(state.criteriaStages) ? state.criteriaStages : [];
  const criteria = stages.map((stage, i) => {
    let name = '';
    let condition = '';
    try {
      const text = stageText(stage) || {};
      name = text.short || '';
      condition = text.cond || '';
    } catch { /* 判据取不到就不带这一项 */ }
    const max = state.criteriaMax?.[i] || null;
    return {
      name,
      condition,
      hit: i <= state.criteriaIdx,
      pts: Number(state.criteriaPts?.[i]) || 0,
      max: max ? (Number(max.points) || 0) + (Number(max.bonus) || 0) : 0,
    };
  });
  /* 最近练过的几组（localStorage 里的记录，最新在前；名字按当前语言取） */
  const history = loadList(STORE.history).slice(0, 10).map((rec) => {
    const meta = localizedExercise(rec.exerciseId);
    return {
      exerciseId: rec.exerciseId,
      name: meta ? meta.name : String(rec.exerciseId || ''),
      kind: rec.kind,
      at: Number(rec.at) || 0,
      value: Number(rec.value) || 0,
      target: Number(rec.target) || 0,
      score: Number(rec.score) || 0,
      seconds: Number(rec.seconds) || 0,
    };
  });
  /* 历史最佳分（各动作最好成绩里最高的那个） */
  let bestScore = 0;
  try {
    for (const rec of Object.values(loadRecords() || {})) {
      bestScore = Math.max(bestScore, Number(rec && rec.score) || 0);
    }
  } catch { /* 记录读不出来就不带最佳分 */ }
  return {
    exerciseId: state.exerciseId,
    exerciseName: ex ? ex.name : '',
    kind: ex ? ex.kind : 'rep',
    target: state.target,
    targetUnit: ex ? ex.targetUnit : '',
    session: state.session,
    homeMode: !!state.homeMode,
    menuMode: !!state.menuMode,
    menuLevel: state.menuLevel,
    menuCategory: state.menuCategory,
    menuPage: state.menuPage,
    reps: det ? det.validReps : 0,
    partial: det ? det.partialReps : 0,
    score: det ? det.score : 0,
    holdMs: det ? det.holdMs : 0,
    elapsedMs: state.elapsedMs,
    settingsOpen: settingsOpen(),
    exerciseSettingsOpen: exerciseSettingsOpen(),
    recordsOpen: recordsModalOpen(),
    voiceHelpOpen: voiceHelpOpen(),
    lang: getLang(),
    muted: coachMuted,
    /* ---------------- P3.3：给 Agent context 的原始事实 ---------------- */
    view: state.homeMode ? 'home' : (state.menuMode ? 'menu' : 'workout'),
    fullscreen: stageFullscreenOn(),
    coachOn: !!state.voice?.enabled,
    dialogue: state.settings.dialogue !== 'off',
    ttsSource: state.settings.ttsSource,
    freeChat: !!state.settings.freeChat,
    timed: !!(ex && ex.timed),
    criteria,
    gateOk: det ? det.gateOk !== false : true,
    gateName: (det && det.gateName) || '',
    tooFastCount: Number(state.tooFastCount) || 0,
    nudges: Array.isArray(state.recentNudges) ? state.recentNudges.slice(-5) : [],
    recentCommands: Array.isArray(state.voice?.recentCommands) ? state.voice.recentCommands.slice() : [],
    history,
    bestScore,
  };
}

/**
 * 计数诊断文本（给 🐞 面板用）。
 * 识别器只给「i18n 键 + 数值」，文案在这里按当前语言拼 —— 这样出问题时
 * 用户能直接把这一行念给我：卡在哪个阶段、判定线在哪、上一轮为什么没计上。
 */
function diagText() {
  const det = state.detector;
  if (!det || typeof det.diag !== 'function') return '—';
  let items = [];
  try { items = det.diag() || []; } catch { items = []; }
  return items.map((d) => {
    const label = t(d.key);
    if (d.reject) {
      const why = t(`cue.${d.reject.code}`);
      return `${label} ${why}${d.reject.value ? ` ${d.reject.value}` : ''}`;
    }
    if (d.key === 'debug.diag.pose') return `${label} ${d.value === 'ok' ? t('debug.yes') : t('debug.no')}`;
    return `${label} ${d.value}`;
  }).join(' · ');
}

/** 右上角「退出」圆环那一行：手/脚现在在哪、离圆心几个判定半径（排查「到底有没有识别到手/脚」） */
function touchDiagLine(n) {
  const info = state.touchInfo;
  if (!info || !info.has) return `${t('debug.touch')} ${t('debug.noTouch')}`;
  const kind = info.kind === 'foot' ? t('debug.foot') : t('debug.hand');
  // 进环的是哪个部位（指尖 / 脚跟 / 脚趾尖 …）—— 「一部分进入即可触发」，看一眼就知道是哪个点进去了
  const partKey = `debug.part.${info.part}`;
  const part = info.part ? t(partKey) : '';
  // 估算出来的脚尖单独标出来（真实的脚尖点没量到，用的是「脚跟 + 一个脚掌」那条延长线上的点）
  const est = info.ghost ? t('debug.estTip') : '';
  const where = part && part !== partKey ? `${kind}·${part}${est}` : kind;
  return `${t('debug.touch')} ${where}(${n(info.x, 2)},${n(info.y, 2)})`
    + ` ${t('debug.ringDist')} ${n(info.rel, 2)}`
    + ` ${info.inside ? t('debug.inRing') : (info.near ? t('debug.nearRing') : t('debug.outRing'))}`
    // 靠「整只脚那一段」碰到圆环进的环（脚尖在环里、脚踝还在环外）—— 这一行说明白它是怎么触发的
    + (info.via === 'span' ? ` ${t('debug.byFoot')}` : '')
    + (info.inCount > 0 ? ` ${t('debug.inPoints')} ${info.inCount}` : '');
}

/** 实时指标面板：把识别器“看到的”数字直接摆出来，方便自己判断机位问题 */
function renderDebug(f, outline = null) {
  const el = $('debugLine');
  if (!state.settings.debug) { if (!el.hidden) el.hidden = true; return; }
  el.hidden = false;
  // 虚线轮廓这一帧画了没：排查「识别成功了轮廓还挂在画面上」时看这一行
  const outlineTxt = `${t('debug.outline')} ${outline ? t('debug.yes') : t('debug.no')}`;
  if (!f || !f.ok) {
    el.textContent = `${t('debug.count')} ${diagText()} · ${outlineTxt} · ${t('debug.noPerson')}`;
    return;
  }
  const n = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const mark = (v) => (v ? t('debug.yes') : t('debug.no'));  const snd = audio.state();
  // 机位是否“正确”取决于当前动作：深蹲要正面，其余要侧面
  const wantView = requiredView(state.exerciseId);
  const viewName = f.view === 'front' ? t('debug.viewFront') : t('debug.viewSide');
  // 计数诊断：识别器的内部判定状态（为什么这一下没计上）
  const diag = diagText();
  // 这个动作**真正在判的那个指标**的实时读数 + 进度：
  // 开合跳这类「判据不是关节角」的动作以前面板里看不到被判的量，调不动也没法自查 —— 现在都摆出来。
  const judged = judgedMetricLine(f, n);
  el.textContent = [
    `${t('debug.count')} ${diag || '—'}`,
    judged,
    `${t('debug.view')} ${viewName}${mark(f.view === wantView)}(${n(f.viewRatio, 2)})`,
    `${t('debug.bodyVisible')} ${mark(f.bodyVisible)}`,
    `${t('debug.legsVisible')} ${mark(f.legsVisible)}`,
    `${t('debug.trunkLean')} ${n(f.trunkLean)}°`,
    `${t('debug.knee')} ${n(f.kneeAngle)}°`,
    `${t('debug.elbow')} ${n(f.elbowAngle)}°`,
    `${t('debug.hip')} ${n(f.hipAngle)}°`,
    `${t('debug.bodyStraight')} ${n(f.bodyStraight)}°`,
    `${t('debug.hipRise')} ${n(f.hipRise, 2)}`,
    // 站立门控（勾腿跳用的 standUpright）判的是**正数版**「肩高于髋」：
    // 站着 ≈ +1.0，躺下 ≈ 0。两行互为相反数，排查「说我没站好」看这一行。
    `${t('debug.shoulderAboveHip')} ${n(f.shoulderAboveHip, 2)}`,
    `${t('debug.kneeClear')} ${n(f.kneeClear, 2)}`,
    `${t('debug.hipClear')} ${n(f.hipClear, 2)}`,
    `${t('debug.thighFromHoriz')} ${n(f.thighFromHoriz)}°`,
    `${t('debug.visibility')} ${n(f.coreVis, 2)}`,
    touchDiagLine(n),
    `🔊 ${t('debug.sound')} ${snd.ctx}/${snd.voices}`,
    outlineTxt,
    `${t('debug.state')} ${state.session}`,
  ].filter(Boolean).join(' · ');
}

/**
 * 「本动作判的是哪个量」那一行：`🎯 双腿开合距离 0.83（进度 52%）`。
 *
 * 指标名走 specs.js 的同一份映射（`metric.<名字>`，和 🎯 运动设定弹窗里显示的名字完全一致），
 * 数值走 `SPEC_METRICS`（识别器真正在判的那个量）。判据不是本表里的量（手写识别器）时不显示这一行。
 */
function judgedMetricLine(f, n) {
  const meta = EXERCISE_MAP[state.exerciseId];
  const name = meta?.params?.metric;
  const read = name && SPEC_METRICS[name];
  if (!read) return '';
  const value = read(f, state.detector);
  if (!Number.isFinite(value)) return '';
  const pct = Number.isFinite(state.detector?.progress)
    ? `（${t('debug.progress')} ${Math.round(Math.max(0, Math.min(1, state.detector.progress)) * 100)}%）`
    : '';
  return `🎯 ${t(`metric.${name}`)} ${n(value, 2)}${pct}`;
}

/** 要领清单：已完成的打勾，当前该做哪一步高亮 */
function renderSteps() {
  const det = state.detector;
  const ul = $('stepList');
  if (!det) { ul.innerHTML = ''; return; }
  const steps = det.stepStatus();
  const sig = `${getLang()}|${det.cycle}|${det.score}|${steps.map((s) => (s.done ? 1 : 0)).join('')}`;
  if (sig === state.stepSig) return;
  state.stepSig = sig;

  const firstPending = steps.findIndex((s) => !s.done);
  ul.innerHTML = steps.map((s, i) => {
    const cls = s.done ? 'done' : (i === firstPending ? 'current' : '');
    const mark = s.done ? '✓' : (i === firstPending ? '▸' : '○');
    return `<li class="step-item ${cls}">`
      + `<span class="step-check">${mark}</span>`
      + `<span class="step-label">${t(s.labelKey)}</span>`
      + `<span class="step-pts">+${s.points}</span></li>`;
  }).join('');
  $('scoreBadge').textContent = scoreText(det.score);

  // 下一步的“卡点说明”单独放在列表下方，逐帧刷新也不会打断打勾动画
  const pending = det.pendingHint();
  const hintEl = $('stepHint');
  if (pending) {
    const label = t(pending.labelKey);
    hintEl.textContent = pending.hint
      ? t('ui.nextStepWithHint', { label, hint: t(pending.hint.key, pending.hint.params) })
      : t('ui.nextStepNoHint', { label });
    hintEl.className = 'step-hint warn';
  } else {
    hintEl.textContent = t('ui.stepsAllDone');
    hintEl.className = 'step-hint good';
  }
}

function showScorePop(text, kind = 'step') {
  const el = $('scorePop');
  el.textContent = text;
  el.className = `score-pop ${kind}`;
  void el.offsetWidth;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 900);
}

function setHint(text, level, ms = 2600) {
  const el = $('poseHint');
  if (!text) {
    el.hidden = true;
    state.hintUntil = 0;
    return;
  }
  el.textContent = text;
  el.className = 'pose-hint ' + level;
  el.hidden = false;
  // ms >= 1000 视为“重要提示”：在它过期前不覆盖（逐帧状态提示用 700ms，不会抢占）
  if (ms >= 1000) state.hintUntil = performance.now() + ms;
}

function setCueLine(text, level = '') {
  const el = $('cueLine');
  el.textContent = text;
  el.className = 'cue-line' + (level ? ' ' + level : '');
}

/** 数值跳一下：次数和分数共用一套（用户要求分数紧贴次数显示，两个数一起跳才像一组） */
function pulseEl(el) {
  if (!el) return;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
  setTimeout(() => el.classList.remove('pop'), 160);
}

function pulseValue() {
  pulseEl($('hudValue'));
}

/** 分数变化时（要领加分 / 每秒加分 / 计上一次）也跳一下 */
function pulseScore() {
  pulseEl($('hudScore'));
}

/* ------------------------------------------------------------------ *
 * 计时类动作读秒：每 5 秒播报一次秒数
 *
 * 用户要求：平板支撑要读秒，每 5 秒读一次，语音播报「5 秒」「10 秒」…
 * 计时类动作（平板支撑 / 两种体前屈）都走这一段：
 *   - 用识别器自己的 holdMs 算秒数（不是自己数帧），所以暂停/恢复后接着数，不会重头念；
 *   - 计时归零（新一组 / 换动作 / 重置计数）→ 自动从 5 秒重新开始读；
 *   - 和「要领达标」的语音撞在同一帧时让读秒先说，免得两句叠在一起听不清。
 * ------------------------------------------------------------------ */

/** 每隔几秒读一次 */
const HOLD_COUNT_EVERY = 5;

/** 语音 + 屏幕上同时跳一下秒数；返回这一帧要不要读 */
function announceHoldCount(det, ex, now) {
  if (!det || !ex || ex.kind !== 'hold') return false;
  const sec = Math.floor((det.holdMs || 0) / 1000);
  // 计时归零：重新装填，下一组从头从 5 秒开始读
  if (sec <= 0) {
    state.holdCountNext = HOLD_COUNT_EVERY;
    return false;
  }
  if (sec < (state.holdCountNext || HOLD_COUNT_EVERY)) return false;
  // 一次只读一个整数（暂停很久再恢复、秒数跳过了也只读当前这一档，不会连珠炮）
  const n = sec - (sec % HOLD_COUNT_EVERY);
  state.holdCountNext = n + HOLD_COUNT_EVERY;
  state.holdCountAt = now;
  audio.sayTime(n * 1000);   // 「5 秒」/「10 秒」…（语音开关关掉时自然不出声）
  pulseValue();              // 屏幕上的秒数同时跳一下，听不见也看得见
  pulseScore();              // 计时类每秒 +1 分，分数跟着一起跳
  return true;
}

/**
 * 限时计数（开合跳）的剩余时间播报。
 *
 * 用户要求「固定 60 秒，看能跳多少次」——那么「还剩多少时间」必须听得见，
 * 否则跳到一半完全没概念。规则很简单：剩余 **45 / 30 / 15 秒** 各报一次，
 * 最后 **5 秒**再单独喊一句冲刺（每一档只报一次，重复报会很吵）。
 * 时间与次数的语音分工：次数照旧每 5 次报一次（speakEvery），这里只管时间。
 */
const TIME_CALL_AT = [45, 30, 15, 5];

function announceTimeLeft(ex, now) {
  if (!ex || !ex.timed || state.timeUp) return false;
  const left = Math.ceil((state.target * 1000 - state.elapsedMs) / 1000);
  if (!state.timeCallsSaid) state.timeCallsSaid = new Set();
  // 从大到小找出「已经到点、但还没报过」的那一档（一帧只报一档，不会连珠炮）
  const hit = TIME_CALL_AT
    .filter((t) => t < state.target && left <= t && !state.timeCallsSaid.has(t))
    .sort((a, b) => b - a)[0];
  if (hit === undefined) return false;
  for (const t of TIME_CALL_AT) if (t >= hit) state.timeCallsSaid.add(t);   // 中间跳过的档也一起标掉
  audio.say(hit === 5 ? t('speech.timeLast5') : t('speech.timeLeft', { n: hit }), { rate: 1.15 });
  pulseValue();
  return true;
}

function updatePipelineStatus() {
  const parts = [];
  if (camera.active) {
    parts.push(t('status.cameraReady', { w: camera.video.videoWidth, h: camera.video.videoHeight }));
    $('camDot').classList.add('on');
  } else {
    parts.push(t('status.cameraOff'));
    $('camDot').classList.remove('on');
  }
  if (state.engineReady) {
    const model = t(state.settings.modelKey === 'full' ? 'ui.modelFull' : 'ui.modelLite');
    parts.push(t('status.modelReadyShort', { model, delegate: engine.delegate || 'CPU' }));
    parts.push(state.poseHits > 0 ? t('status.personFound') : t('status.searching'));
  } else if (camera.active) {
    parts.push(t('status.modelLoading'));
  }
  $('camStatus').textContent = parts.join(' · ');
}

/* ------------------------------------------------------------------ *
 * 训练流程
 * ------------------------------------------------------------------ */

function ensureDetector() {
  if (!state.detector || state.detector.meta.id !== state.exerciseId) {
    state.detector = createDetector(state.exerciseId);
  }
  return state.detector;
}

function startSession() {
  if (!camera.active) {
    setHint(t('status.needCamera'), 'warn', 2600);
    return;
  }
  if (state.session === 'calibrating') {
    setHint(t('calib.needCalib'), 'warn', 2600);
    return;
  }
  if (state.session === 'running') return;
  if (state.session === 'paused') { resumeSession(); return; }
  if (state.session === 'countdown') return;

  beginCountdown();
}

/**
 * 真正开始一组：3-2-1 倒计时 → 计数。
 * 两条路径都会走到这里：校准识别完成后自动开始，以及用户手动点「开始训练」/按空格。
 */
function beginCountdown() {
  try { audio.unlock(); } catch { /* 音频初始化失败不影响开始训练 */ }
  hideGestureRings();   // 要开始新的一组了，圆环先收起来
  const det = ensureDetector();
  // 注意：不重置计数与得分。识别从选好动作那一刻就开始反馈，
  // 开始一组只是开始计时/记一组，方便用户先摆好姿势拿到要领分。
  state.elapsedMs = 0;
  state.goalHit = false;
  state.saidSteps = new Set();
  state.lastScoreMilestone = 0;
  state.stepSig = '';
  state.lastTick = performance.now();
  $('summaryCard').hidden = true;
  $('celebrate').hidden = true;
  setCueLine(`📹 ${localizedExercise(state.exerciseId).cameraHint}`);
  requestWakeLock();

  state.session = 'countdown';
  state.countdownStartedAt = performance.now();
  if (poseLogger.active) {
    poseLogger.event('meta', poseLogMeta());
    poseLogger.event('session', { ex: state.exerciseId, s: 'countdown' });
  }
  // 限时计数：倒计时结束才开始计时，所以这里先把「时间到」清掉
  state.timeUp = false;
  state.timeCallsSaid = new Set();
  // 一组开始：教练可以立刻念第一条指令
  state.coachAt = -Infinity;
  state.coachSig = '';
  let n = 3;
  $('countdownNum').textContent = String(n);
  $('countdown').hidden = false;
  audio.tick();
  audio.sayCountdown(n);

  clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(() => {
    n -= 1;
    if (n > 0) {
      $('countdownNum').textContent = String(n);
      $('countdownNum').style.animation = 'none';
      void $('countdownNum').offsetWidth;
      $('countdownNum').style.animation = '';
      audio.tick();
      audio.sayCountdown(n);
    } else {
      finishCountdown(det);
    }
  }, 850);
  updateButtons();
}

/**
 * 倒计时结束，正式开始计数。
 * 定时器与「渲染循环里的时间兜底」都会调用它，所以做成幂等的：
 * 浏览器把定时器节流/暂停时（例如切到别的标签页再回来），靠这里兜底推进，
 * 不会一直停在「3」上。
 */
function finishCountdown(det = state.detector) {
  if (state.session !== 'countdown') return;
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  state.countdownStartedAt = 0;
  $('countdown').hidden = true;
  state.session = 'running';
  state.lastTick = performance.now();
  det?.resetClock?.();
  audio.go();
  audio.sayStart();
  // 限时计数（开合跳）：一开始就把规则说清楚 —— 固定多少秒、成绩是这段时间里的次数
  const startEx = localizedExercise(state.exerciseId);
  setCueLine(startEx.timed
    ? t('status.timedGo', { sec: state.target })
    : t('status.countdownGo'), 'good');
  // 调试记录：一组正式开始（带一行环境，方便把「哪一组」和参数对上）
  if (poseLogger.active) {
    poseLogger.event('meta', poseLogMeta());
    poseLogger.event('session', { ex: state.exerciseId, s: 'running', at: performance.now() });
  }
  updateButtons();
}

function pauseSession() {
  if (state.session !== 'running') return;
  state.session = 'paused';
  if (poseLogger.active) poseLogger.event('session', { ex: state.exerciseId, s: 'paused' });
  audio.pause();
  setCueLine(t('status.paused'));
  setHint(t('status.paused'), 'warn', 2000);
  updateButtons();
}

function resumeSession() {
  if (state.session !== 'paused') return;
  state.session = 'running';
  if (poseLogger.active) poseLogger.event('session', { ex: state.exerciseId, s: 'resumed' });
  state.lastTick = performance.now();
  state.detector?.resetClock?.();
  setCueLine(t('status.resume'));
  updateButtons();
}

function stopSession(reason = 'user') {
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  $('countdown').hidden = true;
  const wasActive = state.session === 'running' || state.session === 'paused' || state.session === 'countdown';
  state.session = 'calibrating';
  releaseWakeLock();
  if (!wasActive) { updateButtons(); offerSetChoices(); return; }

  const det = state.detector;
  const ex = localizedExercise(state.exerciseId);
  if (!det) { updateButtons(); offerSetChoices(); return; }

  const isHold = ex.kind === 'hold';
  const timed = !!ex.timed;
  const value = isHold ? Math.round(det.holdMs / 1000) : det.validReps;
  const score = det.score;
  const steps = det.stepStatus();
  const doneCount = steps.filter((s) => s.done).length;
  const hasWork = value > 0 || det.partialReps > 0 || score > 0;
  if (poseLogger.active) {
    poseLogger.event('end', {
      ex: state.exerciseId,
      s: 'calibrating',
      reason,
      value,
      reps: det.validReps,
      partial: det.partialReps,
      score,
      ms: Math.round(state.elapsedMs),
      stepsDone: steps.filter((s) => s.done).map((s) => s.id),
    });
    poseLogger.flush({ force: true });
  }
  if (hasWork) saveSession({ ex, value, partial: det.partialReps, reason, score });
  // 本组结果也念出来（以语音为主：用户不必转头看小结卡）。
  // **只念次数 / 时长 + 一句夸奖，不念分数**（用户要求：语音一律不报分数）——
  // 分数照旧显示在结算面板与记录里。
  if (hasWork) {
    state.setPraiseSeed = (state.setPraiseSeed || 0) + 1;
    const praise = poolLine('speech.praiseSet', state.setPraiseSeed);
    // 限时计数报「60 秒完成 N 次」：这才是这个动作的成绩（次数 + 时长一起说清楚）
    audio.say(timed
      ? t('speech.timedSummary', { value, sec: state.target, praise })
      : t('speech.setSummary', { value, unit: ex.unit, praise }), { rate: 1.15, force: true });
  }

  const items = [
    [t('ui.colAction'), `${ex.icon} ${ex.name}`],
    [t('ui.colScore'), scoreText(score)],
    [isHold ? t('ui.colHold') : t('ui.colValidReps'), `${value} ${ex.unit}`],
    // 完成度：计时类与限时计数类按**时间**算（时间到 = 100%），其余按次数算
    [t('ui.colCompletion'), `${Math.round(clamp(
      isHold ? det.holdMs / (state.target * 1000)
        : (timed ? state.elapsedMs / (state.target * 1000) : value / state.target),
      0, 1.5,
    ) * 100)}%`],
    [t('ui.colSteps'), t('ui.stepsDoneRatio', { done: doneCount, total: steps.length })],
    [t('ui.colElapsed'), fmtClock(state.elapsedMs)],
  ];
  $('summaryGrid').innerHTML = items
    .map(([k, v]) => `<div class="summary-item"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');
  const missed = steps.filter((s) => !s.done).map((s) => t(s.labelKey));
  $('summaryNote').textContent = reason === 'goal'
    ? (timed
      ? t('summary.timedDone', { sec: state.target, n: value, score })
      : t('summary.goalReached', { score }))
    : (hasWork
      ? (missed.length
        ? t('summary.savedWithMiss', { score, list: missed.join('、') })
        : t('summary.savedAll', { score }))
      : t('summary.noData'));

  audio.finish();
  det.reset();
  state.elapsedMs = 0;
  state.timeUp = false;
  state.timeCallsSaid = null;
  setCueLine(t('status.setDone'));
  updateHud();
  renderHistory();
  renderRecords();
  setHint('', 'warn', 0);
  // 一组结束后回到校准阶段：下一组开始前重新确认站位与机位，
  // 但这一轮不再自动开始（autoStart: false），给用户留出休息和小结的时间。
  toCalibration({ silent: false, afterSet: true });
  // 手上都是汗、离键盘远：一组做完直接把「退出 / 再做一次」摆成两个手势圆环
  offerSetChoices();
}

/**
 * 一组结束后提供的两个选择（退出 / 再做一次）。
 *
 * **所有动作都是这条路**：计数的、计时的（平板支撑 / 体前屈）都一样 ——
 * 只要是在动作页上结束了一组，就把两个圆环摆出来，用户可以把手掌停在圆环里选，
 * 也可以直接点。只在主页上不摆（那儿根本没有「这一组」）。
 */
function offerSetChoices() {
  if (state.homeMode || state.menuMode || !state.detector) return;
  showGestureRings();
}

function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  navigator.wakeLock.request('screen').then((l) => { state.wakeLock = l; }).catch(() => {});
}
function releaseWakeLock() {
  try { state.wakeLock?.release(); } catch { /* ignore */ }
  state.wakeLock = null;
}

function updateButtons() {
  const running = state.session === 'running';
  const paused = state.session === 'paused';
  const calibrating = state.session === 'calibrating';
  const busy = running || paused || state.session === 'countdown';
  const label = calibrating ? t('calib.waiting') : (running ? t('ui.training') : (paused ? t('ui.resume') : t('ui.start')));
  $('btnStart').textContent = label;
  $('btnStart').disabled = running || calibrating || state.session === 'countdown';
  $('btnPause').textContent = paused ? t('ui.resume') : t('ui.pause');
  $('btnPause').disabled = !(running || paused);
  $('btnStop').disabled = !busy;
  $('btnResetReps').disabled = !state.detector;
  const rc = $('btnRecalibrate');
  if (rc) rc.disabled = calibrating;
  const card = $('calibCard');
  if (card) card.hidden = !calibrating;
  renderCriteriaBar();   // 判定进度条只在「训练中」出现，跟着会话状态显示/隐藏
}

/* ------------------------------------------------------------------ *
 * 记录
 * ------------------------------------------------------------------ */

function saveSession({ ex, value, partial, reason, score = 0 }) {
  const history = loadList(STORE.history);
  history.unshift({
    at: Date.now(),
    exerciseId: ex.id,
    kind: ex.kind,
    unitKey: ex.unitKey,
    value,
    score,
    partial,
    target: state.target,
    // 限时计数：把时长一起记下来，记录里才能写成「52 次 / 60 秒」
    seconds: ex.timed ? state.target : 0,
    durationMs: Math.round(state.elapsedMs),
    reached: reason === 'goal',
  });
  saveList(STORE.history, history.slice(0, 40));

  const records = loadRecords();
  const cur = records[ex.id];
  const betterScore = !cur || score > (cur.score || 0);
  const betterValue = !cur || value > (cur.value || 0);
  if (value > 0 || score > 0) {
    records[ex.id] = {
      value: betterValue ? value : cur.value,
      score: betterScore ? score : (cur.score || 0),
      // 最好成绩那一次是什么时长（限时计数类）
      seconds: ex.timed ? (betterScore || betterValue ? state.target : (cur.seconds || state.target)) : 0,
      at: Date.now(),
    };
    saveList(STORE.records, records);
  }
}

function loadRecords() {
  try { return JSON.parse(localStorage.getItem(STORE.records) || '{}') || {}; } catch { return {}; }
}

function renderRecords() {
  const records = loadRecords();
  const ul = $('recordList');
  ul.innerHTML = '';
  let any = false;
  for (const meta of EXERCISES) {
    const r = records[meta.id];
    if (!r) continue;
    any = true;
    const ex = localizedExercise(meta.id);
    // 限时计数（开合跳）：成绩要带上时长，「52 次 / 60 秒」这样才说得清
    const sec = ex.timed ? (r.seconds || ex.seconds || 0) : 0;
    const li = document.createElement('li');
    li.innerHTML = `<span class="r-name">${ex.icon} ${ex.name}</span>`
      + `<span class="r-val">${r.value} ${ex.unit}${sec ? ` / ${sec} ${ex.targetUnit}` : ''}</span>`
      + `<span class="r-score">${scoreText(r.score || 0)}</span>`;
    ul.appendChild(li);
  }
  if (!any) ul.innerHTML = `<li class="empty">${t('ui.noRecords')}</li>`;
}

function renderHistory() {
  const history = loadList(STORE.history);
  const ul = $('historyList');
  ul.innerHTML = '';
  if (!history.length) {
    ul.innerHTML = `<li class="empty">${t('ui.noHistory')}</li>`;
    return;
  }
  const localeTag = getMeta().htmlLang || getLang();
  for (const h of history.slice(0, 12)) {
    const d = new Date(h.at);
    const when = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
      + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const ex = localizedExercise(h.exerciseId);
    const li = document.createElement('li');
    li.dataset.locale = localeTag;
    li.innerHTML = `<span class="h-when">${when}</span>`
      + `<span class="h-what">${ex ? `${ex.icon} ${ex.name}` : h.exerciseId}${h.reached ? ' 🎉' : ''}</span>`
      + `<span class="h-val">${h.value} ${ex ? ex.unit : ''}${ex && h.seconds ? ` / ${h.seconds} ${ex.targetUnit}` : ''}</span>`
      + `<span class="h-score">${scoreText(h.score || 0)}</span>`;
    if (h.partial > 0) li.querySelector('.h-what').title = `${t('ui.partial')} ${h.partial}`;
    ul.appendChild(li);
  }
}

/** 校准面板：逐项打勾 + 进度 + 当前该做的一件事 */
function renderCalibration(calib) {
  const card = $('calibCard');
  if (!card) return;
  renderCalibPrompt(calib);
  if (!calib) {
    if (!card.hidden) card.hidden = true;
    return;
  }
  card.hidden = false;
  const sig = `${getLang()}|${calib.checks.map((c) => (c.ok ? 1 : (c.blocking ? 0 : 2))).join('')}`;
  if (sig !== state.calibSig) {
    state.calibSig = sig;
    $('calibList').innerHTML = calib.checks.map((c) => {
      // ✓ 达标；○ 必须项没达标（会拦着开始）；· 建议项没达标（不拦人，只是建议站得更准）
      const mark = c.ok ? '✓' : (c.blocking ? '○' : '·');
      const cls = c.ok ? ' done' : (c.blocking ? '' : ' soft');
      return `<li class="calib-item${cls}">`
        + `<span class="calib-check">${mark}</span>`
        + `<span>${t(`calib.check.${c.id}`)}</span></li>`;
    }).join('');
  }
  const okCount = calib.checks.filter((c) => c.ok).length;
  $('calibBadge').textContent = `${okCount}/${calib.checks.length}`;
  $('calibFill').style.width = `${Math.round(calib.progress * 100)}%`;
  const hintEl = $('calibHint');
  hintEl.textContent = t(calib.hintKey, calib.hintParams);
  // 必须项都过了、只是建议项没达标时用柔和配色，别让人以为「还没法开始」
  hintEl.className = `calib-hint ${calib.ready ? (calib.advisory ? 'soft' : 'good') : 'warn'}`;
}

/**
 * 压在人像上方的文字引导。
 * 用户看的始终是画面，所以「站进虚线轮廓内」这句话必须出现在画面上，
 * 而不是只在右侧面板里；第二行再补上「这一帧还差什么」。
 */
function renderCalibPrompt(calib) {
  const box = $('calibPrompt');
  if (!box) return;
  if (!calib) {
    if (!box.hidden) box.hidden = true;
    return;
  }
  const noBody = calib.hintKey === 'calib.visible';
  const confirmed = state.session === 'ready';
  let mainKey = 'calib.promptIn';
  let level = 'warn';
  if (confirmed) {
    mainKey = 'calib.startNow';
    level = 'ready';
  } else if (calib.ready) {
    mainKey = 'calib.promptReady';
    level = 'ready';
  } else if (noBody) {
    mainKey = 'calib.promptSearch';
    level = 'search';
  }
  // 具体差在哪：只在「人已识别但还没就位」时补充，避免与主提示重复
  const sub = (!confirmed && !calib.ready && !noBody) ? t(calib.hintKey, calib.hintParams) : '';
  const mainEl = $('calibPromptMain');
  const subEl = $('calibPromptSub');
  const mainText = t(mainKey);
  if (mainEl.textContent !== mainText) mainEl.textContent = mainText;
  if (subEl.textContent !== sub) subEl.textContent = sub;
  const cls = `calib-prompt ${level}`;
  if (box.className !== cls) box.className = cls;
  // 一组做完、两个手势圆环摆出来的时候，画面上方只留一条提示（手势怎么用）——
  // 这时候这条提示不显示（会和圆环抢注意力，也占同一块位置）。
  // 但**文字照样更新**：圆环收起来之后它必须立刻是对的，否则会留着上一帧的旧话
  //（例如识别已经成功、却还写着「保持不动…」，用户会以为白站了）。
  box.hidden = !!gestureState.visible;
}

/**
 * 校准阶段的一帧处理：跑就位判定，识别完成后按设置自动进入运动状态。
 * 返回这一帧要画的虚线轮廓参数（**识别成功后一律返回 null** → 虚线轮廓立刻消失）。
 *
 * 虚线轮廓的职责只有一条：**在你还没就位时告诉你要站到哪儿**。
 * 所以它的显示规则是「没就位才画，一就位就消失」，对所有动作、所有阶段都一样：
 *   - 没找到人 / 没站好      → 画（亮蓝 / 亮琥珀，画面上的提示条同时告诉你怎么调整）；
 *   - 就位判定通过并保持住   → 立刻隐藏（第一次自动开始、一组做完的休息态都是这样）。
 * 为什么以前「休息态」会一直留一条绿色轮廓：那一轮故意不自动开始，轮廓被当成
 * 「你已经站好了，可以点开始」的指示灯留着；用户反馈「进了运动状态还有虚线轮廓」，
 * 于是改成统一规则 —— 轮廓只做引导，不做指示灯（就位后由提示条与「开始训练」按钮负责）。
 */
function calibrationStep(frame, now) {
  const calib = state.calibrator.update(frame, now);
  state.calib = calib;
  const outlineOf = (status) => ({
    kind: state.calibrator.kind,
    status,
    // 侧拍时人可能朝左：轮廓跟着翻，头脚方向才不会反
    flip: state.calibrator.facing < 0,
  });

  // 一组结束后先休息：停在原地不自动开始（提示条会写明要自己点「开始训练」）；
  // 一旦从画面里消失（站起来走开、喝水），自动开始立刻重新装填，再站好就又会自动开始。
  // 注意：这里**不再顺手收起手势圆环** —— 卧姿类动作（臀桥 / 卷腹 / 平板 / 坐姿体前屈）做完时
  // 人本来就不在「站立轮廓」里，如果按「离开轮廓」就收圆环，这些动作做完根本选不了。
  // 圆环只在「真的要开始下一组」或用户选择/换动作/回主页时才收。
  const lost = !calib.checks.length || (calib.checks[0].id === 'visible' && !calib.checks[0].ok);
  if (state.afterSet && lost) state.afterSet = false;

  // 全身识别完成（七项全部达标并保持住）
  if (calib.done && state.session === 'calibrating') {
    state.session = 'ready';
    state.lastTick = now;
    audio.milestone();
    setCueLine(t('calib.startNow'), 'good');
    updateButtons();
    // 校准阶段的引导统一走画面上方的提示条：底部状态条收起来，避免同一句话出现两次
    setHint(null);
    if (state.autoStart && !state.afterSet) {
      // 识别完成 → 虚线框消失，直接进入运动状态（3-2-1 倒计时后开始计数）。
      // 这里不再单独念「校准完成」：紧接着的倒计时语音会把它打断。
      renderCalibration(null);
      try {
        beginCountdown();
        return null;
      } catch (err) {
        // 自动开始万一失败（浏览器差异导致初始化异常等），绝不能把用户卡在绿色轮廓上：
        // 退回「手动点开始训练」这条老路，并把错误抛到控制台（页面底部会显示红色错误条）
        state.autoStart = false;   // 自动开始失败：退回手动，避免把用户卡在绿色轮廓上
        console.error('auto start failed:', err);
        renderCalibration(calib);
        return null;               // 识别已经成功：轮廓照样收起来，别再挂在画面上
      }
    }
    // 一组结束后的再次校准：这一轮不自动开始，等用户自己点「开始训练」。
    // 轮廓同样立刻收起 —— 就位了就不再需要引导（提示条会写「点开始训练」）。
    audio.say(t('calib.doneVoice'), { rate: 1.15, force: true });
    renderCalibration(calib);
    return null;
  }

  renderCalibration(calib);
  setHint(null);
  // 校准阶段的每一条提示也念出来：站位、机位、有没有进画面，都不要用户去看屏幕
  coachSay(t(calib.hintKey, calib.hintParams), {
    gapMs: 2600, dedupeMs: 12000, key: `calib:${calib.hintKey}`,
  });
  // 已经就位（这一轮校准早就完成、session 已是 ready）后又回到就位状态：轮廓依旧不画。
  // 只有真的离开就位状态（人出画、站偏）时轮廓才重新出现，用来把人领回轮廓里。
  if (calib.done) return null;
  return outlineOf(!frame.ok ? 'search' : (calib.ready ? 'ready' : 'adjust'));
}

/* ------------------------------------------------------------------ *
 * 事件处理
 * ------------------------------------------------------------------ */

function feedDetector(f, now) {
  const det = state.detector;
  if (!det) return [];
  // 只有真正开始训练后才计数：校准阶段、倒计时、暂停阶段都不累计。
  // 这道门控放在这里而不是调用处，避免以后新增调用点忘了加判断。
  if (state.session !== 'running') return [];
  // 限时计数（开合跳）：时间已经到了 → 这一组立刻停止计次。
  // 「时间到」到真正结算之间还有 2.6 秒庆祝动画，那几秒里多跳的几下不该算进 60 秒的成绩。
  if (state.timeUp) return [];
  return det.update(f, now);
}

/**
 * 画面下方的状态条：任何时刻都要说清「现在是什么状态、卡在哪一步」。
 * 单独抽出来是为了两条纪律：
 *   1) 有待完成的要领时绝不回落成「已识别到你 ✓」这种空话（那会让人以为一切正常、
 *      却在等一个永远不会来的反馈）；
 *   2) 识别器缺失这类异常必须显式写出来，而不是安静地什么都不显示。
 */
function updateStatusHint(frame, now) {
  if (now <= state.hintUntil) return;
  const det = state.detector;
  if (!frame || !frame.ok) {
    setHint(t('status.noPerson'), 'bad', 700);
    // 找不到人也要主动说话：这是最容易「不知道发生了什么」的时刻
    coachSay(t('speech.noPerson'), { gapMs: 4000, dedupeMs: 15000, key: 'noPerson' });
    return;
  }
  if (!det) { setHint(t('status.noDetector'), 'bad', 700); return; }
  const pending = det.pendingHint();
  const recentCue = det.feedback && now - det.feedback.at < 3200 ? det.feedback : null;
  if (pending) {
    setHint(pending.hint
      ? t('ui.nextStepWithHint', { label: t(pending.labelKey), hint: t(pending.hint.key, pending.hint.params) })
      : t('ui.nextStepNoHint', { label: t(pending.labelKey) }), 'warn', 700);
    // 「下一步做什么」也要念出来（带具体差多少的提示，念出来才是真的在教）
    const label = t(pending.labelKey);
    // 用户反馈「指导太多、缺少鼓励」：指导放慢一倍多，把话语权留给报数与激励
    coachSay(pending.hint
      ? t('speech.nextStep', { label, hint: t(pending.hint.key, pending.hint.params) })
      : t('speech.nextStepNoHint', { label }),
    { gapMs: 9000, dedupeMs: 35000, key: `step:${pending.id}` });
    return;
  }
  if (recentCue) {
    setHint(t(recentCue.key, recentCue.params), recentCue.level, 700);
    return;
  }
  if (!det.active && det.standby) {
    setHint(t(det.standby), 'warn', 700);
    coachSay(t(det.standby), { gapMs: 3000, dedupeMs: 15000, key: det.standby });
    return;
  }
  setHint(t('status.ready'), 'good', 700);
}

/**
 * 语音教练：把画面上的提示同步念出来 —— 这个应用是**以语音提示为主**的，
 * 用户不该盯着屏幕才知道下一步做什么、哪里不对、有没有被看到。
 *
 * 三条纪律（避免变成唠叨）：
 *   1) 全局最小间隔（gapMs）：一句话说完之后短时间内不再插话；
 *   2) 同一句话短时间内不重复（dedupeMs）：比如「请站到画面中间」不必每帧都念；
 *   3) 用 force 打断上一句：**最新的指示比正在念的旧话更重要**。
 */
function coachSay(text, { gapMs = 2500, dedupeMs = 12000, key = '' } = {}) {
  if (!text || !state.settings.voice) return;
  const now = performance.now();
  const sig = key || text;
  if (sig === state.coachSig && now - state.coachAt < dedupeMs) return;
  if (now - state.coachAt < gapMs) return;
  state.coachSig = sig;
  state.coachAt = now;
  audio.say(text, { force: true, rate: 1.12 });
}

/**
 * 语音策略（用户反馈：指导太多、缺少鼓励）：
 *   - **每做一个动作都要报数**（sayRep 用 force，不会被别的提示吞掉）；
 *     节奏特别快的动作例外：`catalog.js` 里写 `speakEvery: 10` 的动作（开合跳）**每 10 次才报一次**
 *     —— 用户反馈「动作太快，每次都报数根本听不清」，而且报数本身也会拖慢节奏；
 *   - 每 ENCOURAGE_EVERY 次给一句**激励**（加油 / 太棒了 / 继续坚持 …），轮换不重复；
 *     快节奏动作同样按 `speakEvery` 降频（10 次说一句），不然一组 50 次要念十几句；
 *   - 纠正提示保留但**适度**：同一句话长去重、组内做过 3 次之后进一步降频。
 */
const ENCOURAGE_EVERY = 3;

/** 这个动作每做几次报一次数 / 说一句激励（catalog 里的 speakEvery，默认 1 = 每次都报） */
function speakEveryOf() {
  return Math.max(1, EXERCISE_MAP[state.exerciseId]?.speakEvery || 1);
}

/** 屏幕上的激励语：跟语音同一个池子，轮着显示，不重复上一句 */
function pickEncourageHint(seed) {
  const pool = t('speech.encourage');
  const list = Array.isArray(pool) ? pool : [String(pool)];
  if (!list.length) return '';
  const line = list[Math.abs(Math.round(seed)) % list.length];
  return line === state.lastEncourageHint ? list[(Math.abs(Math.round(seed)) + 1) % list.length] : line;
}

function handleEvents(events, now = performance.now()) {
  const det = state.detector;
  if (!det) return;
  const running = state.session === 'running';

  for (const ev of events) {
    // 调试记录：每一个事件都留一行（计次 / 半程 / 提示 / 要领 / 满分）
    if (poseLogger.active) {
      const { type, ...rest } = ev;
      poseLogger.event(type === 'rep' ? (ev.valid ? 'rep' : 'reject') : type, {
        ex: state.exerciseId,
        ...rest,
        ...(type === 'rep' ? { valid: !!ev.valid, index: ev.index, reason: ev.reason || null, quality: ev.quality ?? null, duration: ev.duration ?? null } : {}),
      });
    }
    if (ev.type === 'step') {
      // 每一步要领达标：立刻响铃 + 加分飘字，第一次完成时还用语音念出要领
      audio.step(ev.index, ev.total);
      showScorePop(`+${ev.points}`);
      pulseScore();
      if (!state.saidSteps.has(ev.id)) {
        state.saidSteps.add(ev.id);
        // 和「5 秒 / 10 秒」读秒撞在同一帧时，让读秒先说：两句叠在一起谁都听不清
        if (now - (state.holdCountAt || -1e9) > 400) audio.sayStep(t(ev.labelKey));
      }
      checkScoreMilestone(ev.score);
    } else if (ev.type === 'bonus') {
      audio.bonus();
      showScorePop(`${t('ui.stepsAllDone')} +${ev.points}`, 'bonus');
      pulseScore();
      // 整轮关键帧全做到：夸一句（用户要求「多给点情绪价值」）。
      // 稍微延后一点：满分奖励和「计上一次」的报数常常在同一帧，晚 0.9 秒念才不会把报数顶掉。
      state.roundPraiseSeed = (state.roundPraiseSeed || 0) + 1;
      const praise = poolLine('speech.praiseRound', state.roundPraiseSeed);
      if (praise) setTimeout(() => audio.say(praise, { rate: 1.18, force: true, pitch: 1.14 }), 900);
    } else if (ev.type === 'points') {
      audio.scoreTick();
      pulseScore();
      checkScoreMilestone(ev.score);
    } else if (ev.type === 'rep') {
      // 一次动作结束（有效或半程）→ 进度条**点亮最后一格**并保持 0.65 秒（让用户看到「这一轮走完了」），
      // 之后自动收回起点，下一轮重新一格一格走。
      // 注意：识别器真正计上的那一次，这里会把整条链补满 —— 保证「做完了就一定显示做完」。
      const last = state.criteriaStages.length - 1;
      if (last >= 0) {
        state.criteriaIdx = last;
        state.criteriaJust = last;
        state.criteriaClearUntil = now + CRITERIA_CLEAR_MS;
      }
      renderCriteriaBar(now);
      if (ev.valid) {
        pulseValue();
        pulseScore();
        audio.rep(det.validReps);
        // 报数节奏：默认**每做一个都报数**（用户明确要求，用 force 打断上一句，不会被吞掉）；
        // 快节奏动作（开合跳 speakEvery: 10）只在 10 的整数倍报一次 —— 每次时间太短，念了也听不清。
        const speakEvery = speakEveryOf();
        if (det.validReps % speakEvery === 0) audio.sayRep(det.validReps);
        state.repsSinceEncourage = (state.repsSinceEncourage || 0) + 1;
        state.maxRepsSinceEncourage = Math.max(state.maxRepsSinceEncourage || 0, state.repsSinceEncourage);
        // 限时计数（开合跳）：目标是**秒**，不是次数 —— 所以「做满目标次数就达成」和
        // 「做一半提醒」这两件事都不适用（60 次 ≠ 60 秒），达标只由时间决定。
        const timedSet = !!localizedExercise(state.exerciseId).timed;
        const half = timedSet ? 0 : Math.ceil(state.target / 2);
        if (!timedSet && det.validReps === half && half > 0) {
          audio.milestone();
          setHint(t('status.half'), 'good', 2200);
          audio.sayCue(t('status.halfVoice'));
        } else if (!timedSet && running && det.validReps >= state.target && !state.goalHit) {
          state.goalHit = true;
          onGoalReached();
        } else if (state.repsSinceEncourage >= Math.max(ENCOURAGE_EVERY, speakEvery)
          && !(speakEvery > 1 && det.validReps % speakEvery === 0)) {
          // 隔几次给一句激励 —— 语音以「鼓励」为主，而不是只挑毛病（快节奏动作同样降频）。
          // 报数那一帧（speakEvery 的整数倍）让给报数：两句挤在同一帧，后一句会把报数顶掉。
          state.repsSinceEncourage = 0;
          audio.sayEncourage(det.validReps / ENCOURAGE_EVERY + det.cycle);
          setHint(pickEncourageHint(det.validReps), 'good', 1500);
        }
      } else {
        audio.partial();
      }
    } else if (ev.type === 'cue') {
      state.lastCueAt = performance.now();
      state.lastCueLevel = ev.level === 'info' ? 'warn' : ev.level;
      // P3.3 Agent context：记下「刚刚提醒过什么」给 LLM（最多留 5 句，不落盘）
      if (ev.key) {
        const nudge = t(ev.key, ev.params);
        if (nudge) {
          if (!Array.isArray(state.recentNudges)) state.recentNudges = [];
          state.recentNudges.push(String(nudge).slice(0, 60));
          while (state.recentNudges.length > 5) state.recentNudges.shift();
        }
      }
      // 「太快了」提示单独计数（LLM 回答「哪里没做好」时能说「你有一拍太快」）
      if (ev.code === 'tooFast') state.tooFastCount = (state.tooFastCount || 0) + 1;
      // 姿势纠正：**适度即可**。统一走教练的大间隔 + 同一句话长去重，
      // 而且动作已经做起来之后（组内有效次数 ≥ 3）进一步降低纠正频率，
      // 把话语权留给报数与激励。
      const warmed = (det.validReps || 0) >= 3;
      coachSay(t(ev.key, ev.params), {
        gapMs: warmed ? 9000 : 3000,
        dedupeMs: warmed ? 30000 : 15000,
        key: ev.key,
      });
    } else if (ev.type === 'hold') {
      if (ev.action === 'start') {
        audio.go();
        if (det.holdMs < 500) audio.sayStart();
      } else {
        audio.pause();
      }
    }
  }
}

/**
 * 跨过 50 分的整数倍：**不再报分数**（用户要求语音一律不报分数，只报次数和读秒），
 * 改成念一句**激励语** —— 分数跳档的那一刻正是最该夸的时候，屏幕上的提示牌仍然写着分数。
 */
function checkScoreMilestone(score) {
  const m = Math.floor(score / 50) * 50;
  if (m > 0 && m > state.lastScoreMilestone) {
    state.lastScoreMilestone = m;
    audio.milestone();
    audio.sayEncourage(m / 50 + (state.detector?.cycle || 0));
    setHint(t('status.milestone', { score: m }), 'good', 2000);
  }
}

/** 从词条池里按序号取一句（池子按顺序轮，天然不会连着重复） */
function poolLine(key, index) {
  const pool = t(key);
  const list = Array.isArray(pool) ? pool : [String(pool)];
  if (!list.length) return '';
  return list[Math.abs(Math.round(index)) % list.length];
}

function onGoalReached() {
  const ex = localizedExercise(state.exerciseId);
  const isHold = ex.kind === 'hold';
  const value = isHold
    ? t('summary.celebrateHold', { n: state.target })
    : (ex.timed
      // 限时计数：时间到就是「达成」，庆祝语直接喊时间到（次数在结算面板里）
      ? t('summary.celebrateTimed', { n: state.target })
      : t('summary.celebrateReps', { n: state.target }));
  $('celebrateText').textContent = t('summary.celebrate', { value });
  $('celebrate').hidden = false;
  state.celebrateUntil = performance.now() + 2600;
  audio.finish();
  // 达标了要夸：先念达成，再补一句激励（用户要求语音以激励为主）
  audio.say(t(ex.timed ? 'status.timeUpVoice' : 'status.goalVoice'), { rate: 1.15, force: true });
  setTimeout(() => audio.sayEncourage((state.detector?.validReps || 0) + 1), 1500);
}

/* ------------------------------------------------------------------ *
 * 主循环
 * ------------------------------------------------------------------ */

function loop() {
  requestAnimationFrame(loop);
  state.loopCount += 1;
  const video = camera.video;
  if (!state.engineReady || !camera.active) {
    renderer.clear();
    return;
  }
  if (video.currentTime === state.lastVideoTime) return;
  state.lastVideoTime = video.currentTime;

  const now = performance.now();
  // 倒计时兜底：定时器被浏览器节流/打断时（切标签页、后台标签等），
  // 靠时间判断继续推进，避免永远停在「3」上，之后既不计数也不报语音。
  if (state.session === 'countdown' && state.countdownStartedAt
    && now - state.countdownStartedAt > 3600) {
    finishCountdown();
  }
  const res = engine.detect(video, now);
  state.detectCount += 1;

  const aspect = camera.aspect;
  let frame = { ok: false, t: now };
  let landmarks = null;
  let smoothedLm = null;      // 平滑后的关键点（调试记录里也留一份，方便看「平滑是不是把动作磨没了」）

  if (res) {
    landmarks = res.landmarks;
    state.poseHits += 1;
    if (state.lostSince) { smoother.reset(); state.lostSince = 0; }
    const smoothed = smoother.apply(landmarks, now / 1000);
    smoothedLm = smoothed;
    // 把校准阶段观测到的地面线传进去：所有「离地高度」都以它为基准。
    // 否则仰卧抬腿 / 跳跃这类动作里，脚踝会跟着身体一起动，地面基准就飘了。
    frame = computeFrame(toMetric(smoothed, aspect),
      { groundY: state.calibrator?.groundRef ?? null }, now, false, res.worldLandmarks);
  } else {
    if (!state.lostSince) state.lostSince = now;
    if (now - state.lostSince > 800) smoother.reset();
  }

  // 尺寸对齐
  renderer.resize(video.videoWidth || 1280, video.videoHeight || 720);

  /**
   * ---- 手势菜单：不校准、不计数、也不记调试帧（还没有动作），只判「手掌停在哪个圆环里」----
   * 画面上仍然是摄像头 + 火柴人（看得见自己），加一圈动作圆环与右上角「退出」圆环。
   */
  if (state.menuMode) {
    renderCalibration(null);
    renderer.draw({ landmarks, frame, exerciseId: state.exerciseId, status: 'ok', outline: null });
    const act = updateMenu(res ? res.landmarks : null, now);
    tickCornerExit(res ? res.landmarks : null, now);
    // 手掌指针（猫爪）：菜单与运动界面共用同一层，两条路径每帧各画一次
    updatePaws(res ? res.landmarks : null);
    if (state.loopCount % 15 === 0) { updatePipelineStatus(); renderRecBadge(); }
    if (act && state.menuMode) {
      if (act.kind === 'page') flipMenuPage(act.dir);
      else selectFromMenu(act.id);
    }
    return;
  }

  const calibrating = !state.homeMode && (state.session === 'calibrating' || state.session === 'ready');
  const counting = !state.homeMode && state.session === 'running';
  let outline = null;

  if (state.homeMode) {
    // ---- 在动作主页上：不校准、不计数、不提示（摄像头可以继续开着预热） ----
    renderCalibration(null);
    state.session = state.session === 'running' ? state.session : 'idle';
  } else if (calibrating) {
    // ---- 运动前校准：只做就位判定与引导，不计数、不计分 ----
    outline = calibrationStep(frame, now);
  } else {
    // ---- 训练中：正常识别与计数 ----
    if (counting) {
      const events = feedDetector(frame, now);
      // 计时类先读秒：这样同一帧里「保持 10 秒」的要领语音会让位给「10 秒」，不会两句叠在一起
      announceHoldCount(state.detector, localizedExercise(state.exerciseId), now);
      // 限时计数：每隔一段报一次「还剩 N 秒」，最后 5 秒单独喊一句
      announceTimeLeft(localizedExercise(state.exerciseId), now);
      handleEvents(events, now);
      updateCriteria(frame, events, now);
    } else {
      // 没在计数时也要跑一次：进度条要一直显示，并且按「有没有识别到人」切换灰/彩色
      updateCriteria(frame, [], now);
    }
    renderCalibration(null);
    updateStatusHint(frame, now);
  }

  // 硬性不变量：**倒计时 / 训练中 / 暂停 这三态一律不画虚线轮廓**。
  // 上面的分支已经保证了这一点，这里再兜一道 —— 以后新增状态分支时，不会因为
  // 漏写 outline = null 就把校准用的虚线轮廓带进训练画面（用户反馈过这个现象：
  // 「进了运动状态还在，进度条都在走了轮廓还留着」）。
  if (state.session === 'countdown' || state.session === 'running' || state.session === 'paused') {
    outline = null;
  }

  // 目标达成：计时类是「保持够久」，限时计数类是「时间到」
  const det = state.detector;
  const ex = localizedExercise(state.exerciseId);

  // 计时（限时计数到点后就停在目标时长上，结算里「本组用时」才是干净的 60 秒）
  if (counting && !state.timeUp) {
    const dt = clamp(now - state.lastTick, 0, 250);
    state.elapsedMs += dt;
    if (ex.timed) state.elapsedMs = Math.min(state.elapsedMs, state.target * 1000);
  }
  state.lastTick = now;

  const timeIsUp = counting && ex.timed && state.elapsedMs >= state.target * 1000;
  if (counting && det && !state.goalHit
    && ((ex.kind === 'hold' && det.holdMs >= state.target * 1000) || timeIsUp)) {
    state.goalHit = true;
    // 时间到就立刻停止计次：庆祝动画那 2.6 秒里多跳的几下不该算进「60 秒」的成绩里
    if (ex.timed) state.timeUp = true;
    onGoalReached();
  }

  // 手势圆环（一组做完后的「退出 / 再做一次」）：识别到的手掌停在圆环中央满 3 秒就触发
  if (gestureState.visible) {
    updateGesture(res ? res.landmarks : null, now);
  }
  // 右上角常驻的「退出」圆环：手或脚进去停满 3 秒 → 训练里回手势菜单（菜单里不显示）
  // （显示与否由摄像头开着没有决定，见 syncCornerExit）
  tickCornerExit(res ? res.landmarks : null, now);
  // 「设置」环打开后，中间那一层「每组次数 / 秒数」的圆环：手掌停在某一颗里满 3 秒就选中它
  if (state.setPickerOpen) updateSetPicker(res ? res.landmarks : null, now);
  // 手掌指针（猫爪）：运动界面里也跟手（「一组结束」/ 右上角退出圆环摆着时，
  // 手一伸进画面就能看见自己的手在哪 —— 用户要求「像菜单界面一样出现猫爪」）
  updatePaws(res ? res.landmarks : null);

  // 实时指标（调试用）
  renderDebug(frame, outline);

  /**
   * 调试数据记录（用户要求）：把这一帧的**原始关键点 + 平滑后关键点 + 全部指标 + 识别器内部状态**
   * 写进 logs/ 里的文件。放在这里（识别器跑完、进度条算完）才能一次记全：
   * 「计不上」到底是关键点没识别到、平滑把动作磨平了、还是判定线本身没到。
   */
  if (poseLogger.active && !state.homeMode) {
    poseLogger.frame({
      exerciseId: state.exerciseId,
      session: state.session,
      landmarks: res ? res.landmarks : null,
      smoothed: smoothedLm,
      frame,
      det: state.detector,
      barIndex: state.criteriaIdx,
      barTotal: state.criteriaStages ? state.criteriaStages.length : 0,
    });
  }

  // 绘制
  const status = !frame.ok ? 'idle'
    : (!det || det.active ? (now - state.lastCueAt < 2000 ? 'warn' : 'ok') : 'warn');
  renderer.draw({
    landmarks, frame, exerciseId: state.exerciseId, status, outline,
  });

  updateHud();

  // 管线状态（摄像头 / 模型 / 是否找到人）
  if (state.loopCount % 15 === 0) updatePipelineStatus();
  // 记录中：设置弹窗开着时，每秒刷新一次状态行（用户能看见帧数在涨，确认真的在记）
  if (poseLogger.active && state.loopCount % 30 === 0) {
    const modal = $('settingsModal');
    if (modal && !modal.hidden) renderPoseLogStatus();
  }
  // 右下角角标的帧数：每 15 帧（约半秒）刷一次就够跳得动了，不必每帧写 DOM
  if (state.loopCount % 15 === 0) renderRecBadge();

  if (state.celebrateUntil && now > state.celebrateUntil) {
    state.celebrateUntil = 0;
    $('celebrate').hidden = true;
    if (state.session === 'running') {
      stopSession('goal');
    }
  }
}

/* ------------------------------------------------------------------ *
 * 摄像头 / 模型
 * ------------------------------------------------------------------ */

/** 给可能卡住的异步操作加超时，避免界面永远停在“正在打开摄像头…” */
function withTimeout(promise, ms, message) {
  // message 可以是文案，也可以是一个 Error（模型加载超时要用带 stage 的 PoseLoadError，才说得清原因）
  const reason = message instanceof Error ? message : new Error(message);
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(reason), ms)),
  ]);
}

/* ------------------------------------------------------------------ *
 * 姿态模型加载：分阶段 + 自动重试 + GPU → CPU 兜底
 *
 * 用户反馈：「在首页点击开始按钮，出现『姿态模型加载失败』」。服务器侧资源全是 200，
 * 所以问题在浏览器里：GPU delegate 建不起来、服务器比页面晚起来（fetch 失败）、
 * 或者错误被一句笼统的「加载失败」盖住了 —— 用户没法把真实原因念出来。
 *
 * 这里做三件事（细节在 src/pose-engine.js）：
 *   ① 失败提示带**阶段 + 错误名 + 一句话原因**（如「模型文件下载失败（HTTP 404）」）；
 *   ② 下载类失败自动重试（退避 400 / 900 / 1800ms，首次 + 3 次），遮罩上显示「正在重试（n/3）」；
 *   ③ GPU 建不起来 / 首帧推理失败或超时 → 自动换 CPU 重试，并把 'cpu' 记进设置
 *      （settings.poseDelegate，下次启动直接用 CPU，不再先失败一次）。
 * 每次失败都写一条 `pose:load-fail` 进诊断日志（logs/coach-diag.jsonl；只有文本、截断、不含图像）。
 * ------------------------------------------------------------------ */

/** 失败阶段 → 界面词条（一处定义：pose-engine 的 stage 与词条一一对应） */
const POSE_STAGE_KEYS = {
  wasm: 'ui.poseStageWasm',
  model: 'ui.poseStageModel',
  create: 'ui.poseStageCreate',
  detect: 'ui.poseStageDetect',
  timeout: 'ui.poseStageTimeout',
  env: 'ui.poseStageEnv',
  unknown: 'ui.poseStageUnknown',
};

/**
 * 加载时的几个数（**只有这一处**）：重试次数 / 退避间隔 / 首帧超时 / 下载卡住超时 /
 * 初始化超时 / 整体超时。
 * 测试直接改 `window.__mfg.poseLoadTuning` 把它调小，不必真等 8 秒 / 60 秒 / 240 秒。
 */
const poseLoadTuning = {
  attempts: LOAD_ATTEMPTS,
  retryDelays: [...RETRY_DELAYS],
  firstDetectTimeoutMs: FIRST_DETECT_TIMEOUT_MS,
  stallTimeoutMs: DOWNLOAD_STALL_TIMEOUT_MS,
  initTimeoutMs: INIT_TIMEOUT_MS,
  gpuTimeoutMs: GPU_INIT_TIMEOUT_MS,
  totalTimeoutMs: LOAD_TIMEOUT_MS,
};

/** 失败对象 → 结构化信息（界面与诊断日志共用；只有文本，不含任何图像） */
function loadErrorInfo(err) {
  if (!err || typeof err !== 'object') {
    return {
      stage: 'unknown', name: 'Error', message: String(err || ''), delegate: '', status: 0, seconds: 0, loaded: 0, total: 0,
      timeoutMs: 0, elapsedMs: 0, conservative: false,
    };
  }
  const name = String(err.errName || err.name || 'Error');
  const rawStage = String(err.stage || (name === 'TimeoutError' ? 'timeout' : 'unknown'));
  return {
    stage: POSE_STAGE_KEYS[rawStage] ? rawStage : 'unknown',
    name,
    message: String(err.reason || err.message || '').slice(0, 120),
    delegate: String(err.delegate || ''),
    status: Number(err.status) || 0,
    seconds: Number(err.seconds) || 0,
    loaded: Number(err.loaded) || 0,
    total: Number(err.total) || 0,
    /** 初始化超时要能说清「上限多少 / 已经等了多久」（用户念的就是这两个数） */
    timeoutMs: Number(err.timeoutMs) || 0,
    elapsedMs: Number(err.elapsedMs) || 0,
    conservative: !!err.conservative,
  };
}

/**
 * 一句话原因（用户能照着念的就是这一句）：
 *   HTTP 404 / 超时 8s / 下载卡住（已收 2.9MB / 5.6MB）/ TypeError: Failed to fetch / RuntimeError: …
 *
 * **初始化超时单独一句**（用户今天就卡在这里）：「推理器创建失败（超时 20s）」太笼统，
 * 现在说清是「初始化识别器超时」，并带上上限与真已用秒数。
 */
function poseFailReason(err) {
  const info = loadErrorInfo(err);
  if (info.name === 'HttpError' && info.status) {
    return t('ui.poseReasonHttp', { status: String(info.status) });
  }
  if (info.name === 'FileProtocol') return t('ui.poseReasonFileUrl');
  if (info.name === 'TimeoutError') {
    // 初始化超时：上限 / 已用 + 一句「怎么自救」
    if (info.stage === 'create') {
      return t('ui.poseInitTimeout', {
        timeout: String(Math.round((info.timeoutMs || poseLoadTuning.initTimeoutMs || 0) / 1000)),
        elapsed: String(Math.round((info.elapsedMs || info.timeoutMs || 0) / 1000)),
      });
    }
    const sec = String(info.seconds || Math.round((poseLoadTuning.firstDetectTimeoutMs || 0) / 1000));
    // 下载卡住时把「已收多少 / 总共多少」也说出来，用户一眼知道是网慢还是根本没开始
    if (info.total > 0 && info.stage !== 'init') {
      return t('ui.poseReasonStall', {
        sec, got: formatMB(info.loaded), total: formatMB(info.total),
      });
    }
    return t('ui.poseReasonTimeout', { sec });
  }
  if (info.message) {
    return info.message.startsWith(info.name) ? info.message : `${info.name}: ${info.message}`;
  }
  return info.name || t('ui.poseReasonUnknown');
}

/** 「阶段（原因）」—— 失败提示的正文，如「模型文件下载失败（HTTP 404）」 */
function poseFailText(err) {
  const info = loadErrorInfo(err);
  // 初始化超时已经是一整句（带上限 / 已用秒数），不再套「阶段（原因）」的壳，免得读起来绕
  if (info.stage === 'create' && info.name === 'TimeoutError') {
    return t('ui.poseInitTimeout', {
      timeout: String(Math.round((info.timeoutMs || poseLoadTuning.initTimeoutMs || 0) / 1000)),
      elapsed: String(Math.round((info.elapsedMs || info.timeoutMs || 0) / 1000)),
    });
  }
  return t('ui.poseFailText', {
    stage: t(POSE_STAGE_KEYS[info.stage] || 'ui.poseStageUnknown'),
    reason: poseFailReason(err),
  });
}

/** 完整句子（状态行用）：「姿态模型加载失败：模型文件下载失败（HTTP 404）」 */
function poseFailSentence(err) {
  return `${t('ui.maskModelFail')}：${poseFailText(err)}`;
}

/* ------------------------------------------------------------------ *
 * 姿态模型加载进度条（用户要求：「增加一个进度条，通过进度条来反馈进度」）
 *
 * 用户第二次反馈的形态是「一直显示正在加载姿态模型…但就是加载不成功」—— 某个 `await`
 * 永远不返回，界面上什么反馈都没有。所以：
 *   · 进度是**真实字节**（不是假转圈）：运行库 40% + 模型 40% + 初始化 20%，
 *     前两段由我们自己流式下载（见 pose-engine 的 downloadWithProgress）；
 *   · 初始化没法细分 → 不确定态（脉冲）+ 已用秒数；
 *   · 每一段都有超时（下载 60s 没有新字节 = 卡住；初始化 20s；首帧 8s），超时立刻进入重试 /
 *     CPU 兜底，所以不会再「永远转圈」；
 *   · 每 2 秒把进度写进诊断日志（`pose:progress`，只有数字，不含任何二进制内容）。
 * 样式（含 prefers-reduced-motion）在 style.css；文案在 ui.model* / ui.pose* 词条里。
 * ------------------------------------------------------------------ */

const modelProgressState = {
  wasm: { loaded: 0, total: 0, bps: 0, done: false },
  model: { loaded: 0, total: 0, bps: 0, done: false },
  init: 0,
  initStartedAt: 0,
  shownPercent: 0,
  timer: null,
};

/** 进度写进诊断日志的节流：每 2 秒一条（只写字节数 / 速率） */
const poseProgressLog = { lastAt: 0, everyMs: 2000 };

/** 重新开一次加载：进度清零（重试时也从头算，用户看得出来是「又试了一次」） */
function resetModelProgress() {
  modelProgressState.wasm = { loaded: 0, total: 0, bps: 0, done: false };
  modelProgressState.model = { loaded: 0, total: 0, bps: 0, done: false };
  modelProgressState.init = 0;
  modelProgressState.initStartedAt = 0;
  modelProgressState.shownPercent = 0;
}

function stopModelProgressTimer() {
  if (!modelProgressState.timer) return;
  try { clearInterval(modelProgressState.timer); } catch { /* ignore */ }
  modelProgressState.timer = null;
}

/**
 * 把一次进度写进诊断日志（每 2 秒最多一条；`done` 的那一条一定写）。
 * @returns {boolean} 这次有没有真的写
 */
function notePoseProgress(p = {}) {
  const now = Date.now();
  if (!p.done && now - poseProgressLog.lastAt < poseProgressLog.everyMs) return false;
  poseProgressLog.lastAt = now;
  coachDiag.record('pose:progress', {
    stage: String(p.stage || ''),
    loaded: Math.max(0, Math.round(Number(p.loaded) || 0)),
    total: Math.max(0, Math.round(Number(p.total) || 0)),
    bps: Math.max(0, Math.round(Number(p.bps) || 0)),
  });
  return true;
}

/** 画进度条（返回 composeProgress 的结果，测试直接断言） */
function renderModelProgress() {
  const s = modelProgressState;
  /**
   * 运行库不再由我们下载（用户拍板 `/vendor/**` 不缓存 → 预热会把 9.3MB 下两遍），
   * 所以总百分比只用 **模型 + 初始化** 两段（wasm 那 40% 的权重按比例并进去，
   * 见 composeProgress 的 scale）；① 那一行单独显示「识别器内部加载」。
   */
  const sum = composeProgress({ model: s.model, init: s.init });
  const box = $('modelProgress');
  if (!box) return sum;
  const known = sum.percent !== null;
  // 百分比只增不减（重试时 resetModelProgress() 才清零）
  if (known) s.shownPercent = Math.max(s.shownPercent || 0, sum.percent);
  const pct = $('mpPercent');
  if (pct) pct.textContent = known ? `${s.shownPercent}%` : t('ui.modelProgressIndeterminate');

  // 标题也在这里刷新（切换语言时跟着变）。
  const title = $('mpTitle');
  if (title) title.textContent = t('ui.modelProgressTitle');

  const byEngine = !!(s.wasm && s.wasm.byEngine);
  const rows = [
    ['Wasm', 'mpRowWasm', 'mpFillWasm', 'mpMetaWasm',
      { fraction: 0, loaded: 0, total: 0, done: !!(s.wasm && s.wasm.done) }, s.wasm],
    ['Model', 'mpRowModel', 'mpFillModel', 'mpMetaModel', sum.model, s.model],
    ['Init', 'mpRowInit', 'mpFillInit', 'mpMetaInit',
      { fraction: sum.init, loaded: sum.init ? 1 : 0, total: 1, done: sum.init >= 1 }, null],
  ];
  for (const [id, rowId, fillId, metaId, part, raw] of rows) {
    const engineRow = id === 'Wasm' && byEngine;
    const started = id === 'Init' ? sum.init > 0
      : engineRow ? !part.done : (part.loaded > 0 || part.done);
    let state = 'waiting';
    if (part.done) state = 'done';
    else if (started) state = (id !== 'Init' && !engineRow && raw && raw.total > 0) ? 'running' : 'indeterminate';

    const row = $(rowId);
    const fill = $(fillId);
    const meta = $(metaId);
    if (row) row.dataset.state = state;
    if (fill) {
      fill.style.width = state === 'done' ? '100%'
        : state === 'running' ? `${Math.round((Number(part.fraction) || 0) * 100)}%`
          : state === 'indeterminate' ? '100%' : '0%';
    }
    if (!meta) continue;
    if (state === 'waiting') meta.textContent = t('ui.modelProgressWaiting');
    else if (state === 'done') meta.textContent = t('ui.modelProgressDone');
    else if (id === 'Init') {
      const sec = s.initStartedAt ? Math.max(0, Math.round((Date.now() - s.initStartedAt) / 1000)) : 0;
      meta.textContent = t('ui.modelInitElapsed', { sec: String(sec) });
    } else if (engineRow) {
      // 运行库由识别器内部下载：拿不到字节数，就说清「谁在下载」，不谎报进度
      meta.textContent = t('ui.modelProgressByEngine');
    } else {
      const bps = raw && raw.bps ? ` · ${formatMB(raw.bps)}/s` : '';
      meta.textContent = `${formatMB(raw && raw.loaded)}${raw && raw.total ? ` / ${formatMB(raw.total)}` : ''}${bps}`;
    }
  }
  return sum;
}

/**
 * 初始化开始时写一条诊断（用户反馈「初始化识别器失败」时，这条能说清：
 * 用的哪个 delegate、第几次、是否最保守那一档、页面有没有跨源隔离、CPU 核数）。
 */
function recordPoseInitStart(p = {}) {
  let crossOriginIsolated = null;
  let hardwareConcurrency = 0;
  try {
    if (typeof window !== 'undefined' && window && 'crossOriginIsolated' in window) {
      crossOriginIsolated = !!window.crossOriginIsolated;
    }
  } catch { crossOriginIsolated = null; }
  try {
    hardwareConcurrency = Number((typeof navigator !== 'undefined' && navigator && navigator.hardwareConcurrency) || 0) || 0;
  } catch { hardwareConcurrency = 0; }
  coachDiag.record('pose:init-start', {
    delegate: String(p.delegate || ''),
    attempt: Number(p.attempt) || 0,
    conservative: p.conservative ? 1 : 0,
    timeoutMs: Math.max(0, Math.round(Number(p.timeoutMs) || 0)),
    crossOriginIsolated,
    hardwareConcurrency,
  });
}

/** 把引擎报上来的进度收进状态并重画（附带每 2 秒一条诊断日志） */
function handlePoseProgress(p = {}) {
  if (!p || !p.stage) return null;
  if (p.stage === 'model') {
    modelProgressState.model = {
      loaded: Number(p.loaded) || 0,
      total: Number(p.total) || 0,
      bps: Number(p.bps) || 0,
      done: !!p.done,
    };
  } else if (p.stage === 'wasm') {
    // 兼容：wasm 进度现在由识别器内部产生，我们不再自己下载；真有的话照旧记
    modelProgressState.wasm = {
      loaded: Number(p.loaded) || 0,
      total: Number(p.total) || 0,
      bps: Number(p.bps) || 0,
      done: !!p.done,
    };
  } else if (p.stage === 'init') {
    modelProgressState.init = p.done ? 1 : 0;
    // 运行库改由识别器内部下载：那一行显示「识别器内部加载」，初始化完成时一起算完成
    modelProgressState.wasm = p.done
      ? { loaded: 1, total: 1, bps: 0, done: true, byEngine: true }
      : { loaded: 0, total: 0, bps: 0, done: false, byEngine: true };
    if (!p.done && !modelProgressState.initStartedAt) modelProgressState.initStartedAt = Date.now();
    if (!p.done) recordPoseInitStart(p);
  } else {
    return null;   // 未知阶段不画、不记
  }
  const sum = renderModelProgress();
  notePoseProgress(p);
  return sum;
}

/**
 * 真正去加载姿态模型（首次进入训练与切换模型共用）。
 *
 * @param {{showMask?:boolean}} [opts] showMask=false 时只更新状态行（切模型不遮住画面）
 * @returns {Promise<boolean>} 成功 true；失败 false（提示 / 诊断日志都写好了，state.modelError 有结构化原因）
 */
async function loadPoseModel({ showMask = true } = {}) {
  const mask = $('stageMask');
  const box = $('modelProgress');
  let logged = false;
  state.modelError = null;
  const recordFail = (error, meta = {}) => {
    logged = true;
    state.modelError = loadErrorInfo(error);
    coachDiag.record('pose:load-fail', {
      stage: state.modelError.stage,
      name: state.modelError.name,
      message: state.modelError.message,
      delegate: state.modelError.delegate,
      status: state.modelError.status,
      attempt: Number(meta.attempt) || 0,
      retry: meta.willRetry ? 1 : 0,
    });
  };

  // 进度条：每次加载都从 0 开始，每 0.5 秒重画一次（初始化那段的「已用秒数」靠它走）
  resetModelProgress();
  stopModelProgressTimer();
  if (showMask && box) box.hidden = false;
  renderModelProgress();
  if (box) modelProgressState.timer = setInterval(() => renderModelProgress(), 500);

  try {
    // 打开方式不对（file:// / 其它协议）：fetch 会被浏览器拦住，模型永远下不来 ——
    // 这种情况下用户只会看到「一直在加载」，所以先明确报错，别去等超时。
    const proto = (typeof location !== 'undefined' && location && location.protocol) || '';
    if (proto && proto !== 'http:' && proto !== 'https:') {
      throw new PoseLoadError('env', 'FileProtocol', proto, { retryable: false });
    }
    await withTimeout(engine.init({
      modelKey: state.settings.modelKey,
      // **默认 CPU**：老存档里的空串（旧「自动先试 GPU」）也走 CPU —— GPU 卡死就是用户今天的病根
      delegate: state.settings.poseDelegate || DEFAULT_DELEGATE,
      video: camera.video,
      onProgress: handlePoseProgress,
      onRetry: ({ retry, retries, delay, error }) => {
        state.modelError = loadErrorInfo(error);
        const line = `${poseFailText(error)} · ${t('ui.poseRetry', {
          n: String(retry), max: String(retries),
        })}`;
        if (showMask) $('maskText').textContent = line;
        setCueLine(line, 'warn');
        // 这一轮从零开始重新下载：进度条也清零，用户看得出来「又试了一次」
        resetModelProgress();
        renderModelProgress();
        console.warn('[pose] load failed, retrying in', delay, 'ms:', state.modelError);
      },
      onDelegate: (delegate, error) => {
        const value = String(delegate || '').toLowerCase();
        if (!value) return;
        state.settings.poseDelegate = value;
        saveSettings();
        if (value === 'cpu') {
          // GPU 卡住 / 起不来 → 已经自动换了 CPU：这句是用户能看懂的「发生了什么」
          setCueLine(isTimeoutLoadError(error) ? t('ui.poseGpuHang') : t('ui.poseGpuFallback'), 'warn');
          coachDiag.record('pose:delegate', {
            from: 'GPU',
            to: 'CPU',
            name: String(error?.errName || error?.name || '').slice(0, 40),
            elapsedMs: Math.max(0, Math.round(Number(error?.elapsedMs) || 0)),
          });
        }
      },
      onAttemptFail: (error, meta = {}) => {
        // 每一次初始化失败都留痕（GPU 卡住 → 超时 → 切 CPU → CPU 也失败，链子完整可回溯）
        const info = loadErrorInfo(error);
        coachDiag.record('pose:init-fail', {
          delegate: String(meta.delegate || info.delegate || ''),
          name: info.name,
          message: info.message,
          elapsedMs: Math.max(0, Math.round(info.elapsedMs || 0)),
          timeoutMs: Math.max(0, Math.round(info.timeoutMs || 0)),
          conservative: meta.conservative ? 1 : 0,
          attempt: Number(meta.attempt) || 0,
          retry: meta.willRetry ? 1 : 0,
        });
        if (isTimeoutLoadError(error) && error.stage === 'create') {
          coachDiag.record('pose:init-timeout', {
            delegate: String(meta.delegate || info.delegate || ''),
            elapsedMs: Math.max(0, Math.round(info.elapsedMs || 0)),
            timeoutMs: Math.max(0, Math.round(info.timeoutMs || 0)),
          });
        }
      },
      onFail: recordFail,
      attempts: poseLoadTuning.attempts,
      retryDelays: poseLoadTuning.retryDelays,
      firstDetectTimeoutMs: poseLoadTuning.firstDetectTimeoutMs,
      stallTimeoutMs: poseLoadTuning.stallTimeoutMs,
      initTimeoutMs: poseLoadTuning.initTimeoutMs,
      gpuTimeoutMs: poseLoadTuning.gpuTimeoutMs,
    }), poseLoadTuning.totalTimeoutMs, new PoseLoadError(
      'timeout',
      'TimeoutError',
      'pose model load timed out',
      { seconds: Math.round((poseLoadTuning.totalTimeoutMs || 0) / 1000) },
    ));

    state.engineReady = true;
    state.modelError = null;
    if (mask) mask.classList.add('hidden');
    updatePipelineStatus();
    return true;
  } catch (err) {
    if (!logged) recordFail(err, { attempt: 0, willRetry: false });
    if (showMask) {
      $('maskIcon').textContent = '⚠️';
      $('maskTitle').textContent = t('ui.maskModelFail');
      $('maskText').textContent = poseFailText(err);
      $('btnStartCam').textContent = t('ui.poseRetryBtn');
      if (mask) mask.classList.remove('hidden');
    }
    setCueLine(poseFailSentence(err), 'warn');
    updatePipelineStatus();
    return false;
  } finally {
    stopModelProgressTimer();
    if (box) box.hidden = true;
  }
}

/* ------------------------------------------------------------------ *
 * 摄像头诊断面板：打不开时**把客观事实摆出来**，而不是只说「失败了」
 *
 * 手机上的问题九成一眼就能看出来：`isSecureContext` 是 false + `location.protocol` 是 http:
 * → 浏览器按 secure context 规则拒绝给摄像头（QQ 浏览器自带取景通道所以看起来「能用」）。
 * 面板做成可折叠的 <details>，PC 上也一样能看到，平时不占地方。
 * 下面三个都是**纯函数**（给什么环境就说什么话），所以测试可以直接喂构造出来的环境断言文案。
 * ------------------------------------------------------------------ */

/** getUserMedia 的错误名 → 处置建议词条（没列到的走 diag.adviceUnknown） */
const DIAG_ERROR_ADVICE = {
  NotAllowedError: 'diag.adviceNotAllowed',
  PermissionDeniedError: 'diag.adviceNotAllowed',
  NotFoundError: 'diag.adviceNotFound',
  DevicesNotFoundError: 'diag.adviceNotFound',
  SecurityError: 'diag.adviceSecurity',
  OverconstrainedError: 'diag.adviceOverconstrained',
  ConstraintNotSatisfiedError: 'diag.adviceOverconstrained',
  NotReadableError: 'diag.adviceNotReadable',
  TrackStartError: 'diag.adviceNotReadable',
  AbortError: 'diag.adviceAbort',
  TypeError: 'diag.adviceType',
};

/** 布尔类属性：拿不到就返回 null（面板显示「—」，不假装是「否」） */
function boolAttr(el, name) {
  if (!el) return null;
  if (typeof el.hasAttribute === 'function') return !!el.hasAttribute(name);
  const raw = el.attributes ? el.attributes[name] : undefined;
  if (raw === undefined) return null;
  return raw !== 'false';
}

/** 把「此刻浏览器里的事实」收集成一个普通对象（纯函数：只读，不改任何状态） */
function cameraDiagEnv(err = null, opts = {}) {
  const v = opts.video || $('video');
  const nav = opts.navigator || (typeof navigator !== 'undefined' ? navigator : null);
  const loc = opts.location || (typeof location !== 'undefined' ? location : null);
  const win = opts.window || (typeof window !== 'undefined' ? window : null);
  const md = (nav && nav.mediaDevices) || null;
  return {
    secureContext: win && 'isSecureContext' in win ? !!win.isSecureContext : null,
    protocol: (loc && loc.protocol) || '',
    hasMediaDevices: !!md,
    hasGetUserMedia: !!(md && md.getUserMedia),
    errName: (err && err.name) || '',
    errMessage: String((err && err.message) || ''),
    videoW: (v && v.videoWidth) || 0,
    videoH: (v && v.videoHeight) || 0,
    playsinline: boolAttr(v, 'playsinline'),
    muted: boolAttr(v, 'muted'),
    autoplay: boolAttr(v, 'autoplay'),
  };
}

/** 面板要显示的三态文字 */
function diagYesNo(v) {
  if (v === null || v === undefined) return t('diag.unknown');
  return v ? t('diag.yes') : t('diag.no');
}

/**
 * 面板里逐行的事实（纯函数：给一个 env 就返回固定的行）。
 * @returns {Array<{label:string,value:string,bad:boolean}>}
 */
function cameraDiagRows(env = {}) {
  const yn = (b) => diagYesNo(b);
  const attrs = `playsinline=${yn(env.playsinline)} muted=${yn(env.muted)} autoplay=${yn(env.autoplay)}`;
  return [
    // 第一行就是手机上最关键的那一条：不是安全上下文 → 浏览器一定不给摄像头
    { label: t('diag.secure'), value: yn(env.secureContext), bad: env.secureContext === false },
    { label: t('diag.protocol'), value: env.protocol || t('diag.unknown'), bad: false },
    { label: t('diag.mediaDevices'), value: yn(env.hasMediaDevices), bad: env.hasMediaDevices === false },
    { label: t('diag.getUserMedia'), value: yn(env.hasGetUserMedia), bad: env.hasGetUserMedia === false },
    {
      label: t('diag.error'),
      value: env.errName ? `${env.errName}: ${env.errMessage}` : t('diag.noError'),
      bad: !!env.errName,
    },
    { label: t('diag.video'), value: `${env.videoW || 0} × ${env.videoH || 0}`, bad: false },
    { label: t('diag.attrs'), value: attrs, bad: false },
  ];
}

/**
 * 这一组事实对应的处置建议（词条 key，纯函数）。
 * 顺序即优先级：**不安全上下文**排第一 —— 它是手机上最常见的根因，
 * 哪怕错误名看起来是 NotAllowedError（权限没给），换到 https 才是正解。
 */
function cameraDiagAdviceKey(env = {}) {
  if (env.secureContext === false) return 'diag.adviceInsecure';
  if (env.hasGetUserMedia === false) return 'diag.adviceNoMedia';
  return DIAG_ERROR_ADVICE[env.errName] || 'diag.adviceUnknown';
}

/** 把面板填出来并显示（返回填进去的内容，测试直接断言返回值） */
function renderCameraDiag(err = null) {
  const box = $('camDiag');
  const list = $('camDiagList');
  const env = cameraDiagEnv(err);
  const rows = cameraDiagRows(env);
  const adviceKey = cameraDiagAdviceKey(env);
  if (list) {
    list.innerHTML = '';
    for (const row of rows) {
      const li = document.createElement('li');
      li.className = row.bad ? 'cam-diag-row is-bad' : 'cam-diag-row';
      const k = document.createElement('span');
      k.className = 'cam-diag-k';
      k.textContent = row.label;
      const val = document.createElement('span');
      val.className = 'cam-diag-v';
      val.textContent = row.value;
      li.appendChild(k);
      li.appendChild(val);
      list.appendChild(li);
    }
  }
  const advice = $('camDiagAdvice');
  if (advice) advice.textContent = `${t('diag.advice')}：${t(adviceKey)}`;
  if (box) box.hidden = false;
  return { env, rows, adviceKey };
}

/**
 * 打开摄像头。
 *
 * `mic: true` 只由首页「开始体感训练」那一下传进来（用户要求：**点击开始训练时就一并请求麦克风**，
 * 不要等按 Ctrl+I 才弹）。它会让 pose-engine 用 `{ video, audio: true }` 只弹一次组合授权框，
 * 拿到流后立刻把音轨 stop 掉；麦克风失败会自动降级成纯视频，**不影响训练**。
 * 其它路径（遮罩上的「开启摄像头」/ 切镜头 / 从主页回到动作页）都不传 mic，不会重复弹框。
 */
async function startCamera(deviceId = null, { mic = false } = {}) {
  const mask = $('stageMask');
  $('maskIcon').textContent = '⏳';
  $('maskTitle').textContent = t('ui.maskOpening');
  $('maskText').textContent = t('ui.maskOpeningText');
  try {
    // 朝向与性能档一起传进去：手机自动降一档分辨率、后置失败会优雅退回前置（见 pose-engine）
    await withTimeout(camera.start(deviceId, {
      facing: state.settings.cameraFacing || 'user',
      tier: perfTier(deviceEnv()),
      mic,
    }), 25000, t('ui.maskCamFailTitle'));
  } catch (err) {
    state.camError = `${err?.name || 'Error'}: ${err?.message || err}`;
    state.camErrName = err?.name || 'Error';
    state.camErrMessage = String(err?.message || err || '');
    console.error('[camera]', state.camError);
    $('maskIcon').textContent = '⚠️';
    $('maskTitle').textContent = t('ui.maskCamFailTitle');
    $('maskText').textContent = `${err?.message || t('ui.unknownError')}${t('ui.maskCamFailSuffix')}`;
    $('btnStartCam').textContent = t('ui.retry');
    // 客观事实 + 一句处置建议（手机上打开就能看出到底卡在哪一步）
    renderCameraDiag(err);
    updatePipelineStatus();
    return;
  }

  audio.unlock();
  $('stage').style.aspectRatio = `${camera.video.videoWidth} / ${camera.video.videoHeight}`;
  $('hud').hidden = false;
  mask.classList.add('hidden');
  // 摄像头开起来了：诊断面板收起来（它只在「打不开」的时候有用）
  const diag = $('camDiag');
  if (diag) diag.hidden = true;
  state.camErrName = '';
  state.camErrMessage = '';
  $('btnStart').disabled = false;
  state.poseHits = 0;
  updatePipelineStatus();

  await refreshCameraList();

  if (!state.engineReady) {
    $('maskTitle').textContent = t('ui.maskModelLoading');
    mask.classList.remove('hidden');
    $('maskText').textContent = t('ui.maskModelText');
    $('btnStartCam').textContent = t('ui.startCam');
    // 分阶段加载 + 下载类失败自动重试 + GPU→CPU 兜底（失败时遮罩上写着「阶段（原因）」）
    const ok = await loadPoseModel();
    if (!ok) return;
    setCueLine(t('status.modelReady'), 'good');
  }
  updateButtons();
}

async function refreshCameraList() {
  try {
    const list = await Camera.list();
    const sel = $('camSel');
    sel.innerHTML = '';
    list.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `${t('ui.camera')} ${i + 1}`;
      sel.appendChild(o);
    });
    if (camera.deviceId) sel.value = camera.deviceId;
    sel.disabled = list.length < 2;
  } catch { /* ignore */ }
}

async function reloadModel() {
  state.engineReady = false;
  // 切模型不遮住画面：失败原因走状态行（同一套分阶段 / 重试 / CPU 兜底逻辑）
  const ok = await loadPoseModel({ showMask: false });
  if (!ok) {
    setCueLine(t('status.modelSwitchFail', { msg: poseFailText(state.modelError) }), 'warn');
    return;
  }
  const model = t(state.settings.modelKey === 'full' ? 'ui.modelFull' : 'ui.modelLite');
  setCueLine(t('status.modelSwitched', { model }), 'good');
}

/* ------------------------------------------------------------------ *
 * 语言切换
 * ------------------------------------------------------------------ */

/** 切换语言后，把静态 DOM 与所有动态文案整体刷新一遍 */
function refreshForLang() {
  applyI18n(document);
  buildLanguageSelect();
  buildHome();
  const prevId = state.exerciseId;
  // 切语言不该把「设置」选择层弄丢（selectExercise 里会把它收掉）—— 记下来，最后按新语言重开一次
  const pickerWasOpen = state.setPickerOpen;
  // 重新渲染当前动作的文案；切换语言不该丢掉已经拿到的分和要领进度
  const det = state.detector;
  const keep = det ? {
    reps: det.validReps,
    partial: det.partialReps,
    hold: det.holdMs,
    score: det.score,
    cycle: det.cycle,
    stepDone: new Map(det.stepDone),
    cycleHadValidRep: det.cycleHadValidRep,
    answered: state.saidSteps,
  } : null;
  selectExercise(prevId);
  if (keep) {
    // 注意：selectExercise 会新建识别器，所以必须恢复到“当前”这个实例上
    const d = state.detector;
    d.validReps = keep.reps; d.reps = keep.reps;
    d.partialReps = keep.partial; d.holdMs = keep.hold; d.score = keep.score;
    d.cycle = keep.cycle; d.stepDone = keep.stepDone;
    d.cycleHadValidRep = keep.cycleHadValidRep;
    state.saidSteps = keep.answered;
  }
  state.stepSig = '';
  audio.pickVoice();
  updateHud();
  updatePipelineStatus();
  renderRecords();
  renderHistory();
  updateButtons();
  if (state.calib) renderCalibration(state.calib);
  buildHome();        // 主页分类/动作名也要跟着换语言
  renderExercisePicker(); // 运动设定第一步的动作名 / 分类名也跟着换语言
  buildMusicTracks(); // 曲子名也要跟着换语言
  if (gestureState.visible) showGestureRings({ speak: false });   // 圆环上的字也要跟着换
  if (state.menuMode) renderMenu();                               // 手势菜单的文案也要跟着换
  syncCornerLabel();
  coach.render(voice.snapshot());                                 // AI 教练的状态 / 字幕也换语言
  if (pickerWasOpen) openSetPicker();   // 「设置」选择层：标题 / 单位 / 提示 / 无障碍名换成新语言
  if (voiceHelpOpen()) renderVoiceHelp();   // 语音命令一览（表格行是按 intent 动态生成的，也要重渲染）
  setCueLine('');
}

function changeLang(code) {
  if (!LOCALES[code]) return;
  setLang(code);
  refreshForLang();
}

/* ------------------------------------------------------------------ *
 * 绑定
 * ------------------------------------------------------------------ */

/**
 * 全屏按钮的显隐与初始状态。
 *
 * ⚠️ 这里**不再**在「没有元素级全屏」时藏按钮：iPhone 恰恰是唯一必须要这颗按钮的机器
 * （原生 API 不存在 → 只能走 CSS 伪全屏）。只有连伪全屏都不可用的环境（理论上不存在）才藏。
 */
function syncFullscreenSupport() {
  const btn = $('btnFullscreen');
  if (!btn) return;
  /*
   * ⚠️ 这里以前是「没有 requestFullscreen 就把按钮藏起来」，结果 **iPhone 上按钮直接消失** ——
   * 而 iPhone 恰恰是唯一需要这颗按钮的机器（原生 API 没有，只能靠 CSS 伪全屏）。
   * 现在只要还有伪全屏兜底，按钮就永远显示：点了必有反应。
   */
  btn.hidden = pickFullscreenMode(fullscreenCaps()) === 'none';
  btn.setAttribute('aria-pressed', String(stageFullscreenOn()));
}

function bindUI() {
  // AI 语音教练的界面层：先把线条图标（麦克风 / 头戴耳麦）放好，再按当前 snapshot 画一次
  coach.mount();
  coach.setDebug(!!state.settings.debug);
  coach.render(voice.snapshot());
  // P3.5 语音排障：底部工具栏这两颗按钮**不依赖教练开关**（教练关着也能看诊断 / 跑自检）
  $('btnVoiceDiag')?.addEventListener('click', () => coach.toggleDiag());
  $('btnVoiceSelfTest')?.addEventListener('click', () => coach.runSelfTest());
  // 语音命令一览默认收起（HTML 里有 hidden，DOM 桩里也要显式关一次：桩不会自己读属性）
  closeVoiceHelp();

  $('btnStartCam').addEventListener('click', () => {
    try { audio.unlock(); } catch { /* ignore */ }   // 最早的合法用户手势，先把声音解锁
    startCamera();
  });
  $('btnStart').addEventListener('click', () => startSession());
  // 一组做完的两个手势圆环：用手掌停 3 秒是主路径，鼠标/触屏点一下同样有效
  $('ringExit')?.addEventListener('click', () => triggerGesture('exit'));
  $('ringRetry')?.addEventListener('click', () => triggerGesture('retry'));
  // 右上角常驻的「退出」圆环：手或脚停 3 秒是主路径，点一下同样有效
  $('ringQuickExit')?.addEventListener('click', () => triggerCornerExit());
  // 「设置」环（就在退出环正下方）：点一下 = 开 / 关中间那一层选择圆环
  $('ringQuickSet')?.addEventListener('click', () => triggerSetRing());
  $('setPickerClose')?.addEventListener('click', () => closeSetPicker());
  // 点空白处（遮罩）关掉选择层 —— 用户要求的「明显的关闭 / 取消方式」之一
  $('setPickerBackdrop')?.addEventListener('click', () => closeSetPicker());
  // 手势菜单右上角那颗「↩ 返回」（和动作页退出圆环同位置同尺寸）：鼠标 / 触屏点一下同样有效
  menuBackEl()?.addEventListener('click', () => selectFromMenu('back'));
  // resize 统一走 onViewportChange（它顺带重算 --vh / 设备类名 / 竖屏遮罩），别再单独挂 onStageResize
  document.addEventListener('fullscreenchange', onStageResize);
  $('btnPause').addEventListener('click', () => (state.session === 'paused' ? resumeSession() : pauseSession()));
  $('btnStop').addEventListener('click', () => stopSession('user'));
  $('btnResetReps').addEventListener('click', () => {
    state.detector?.reset();
    state.elapsedMs = 0;
    state.goalHit = false;
    // 限时计数：重置计数也把「时间到」与已报过的剩余时间档清掉，可以接着把这一组跳完
    state.timeUp = false;
    state.timeCallsSaid = null;
    state.saidSteps = new Set();
    state.lastScoreMilestone = 0;
    state.stepSig = '';
    setCueLine(t('status.reset'));
    updateHud();
  });

  $('btnRecalibrate')?.addEventListener('click', () => toCalibration());

  $('langSel').addEventListener('change', (e) => changeLang(e.target.value));

  $('modelSel').value = state.settings.modelKey;
  $('modelSel').addEventListener('change', async (e) => {
    state.settings.modelKey = e.target.value;
    state.settings.modelKeySet = true;   // 用户自己选过了：以后换设备也不再覆盖
    saveSettings();
    if (camera.active) await reloadModel();
  });

  // ---- 对话显示 / 音色来源 / 语速（P3.6）----
  // 三个下拉框都直接写 settings 并立刻生效（下一句说话就用新设置），没有「保存」按钮。
  {
    const dialogueSel = $('dialogueSel');
    if (dialogueSel) {
      dialogueSel.value = DANMAKU_MODES.includes(state.settings.dialogue)
        ? state.settings.dialogue : DANMAKU_DEFAULT_MODE;
      dialogueSel.addEventListener('change', (e) => applyDialogueMode(e.target.value));
    }
    const sourceSel = $('ttsSourceSel');
    if (sourceSel) {
      sourceSel.value = TTS_SOURCES.includes(state.settings.ttsSource)
        ? state.settings.ttsSource : TTS_DEFAULT_SOURCE;
      sourceSel.addEventListener('change', (e) => {
        state.settings.ttsSource = TTS_SOURCES.includes(e.target.value)
          ? e.target.value : TTS_DEFAULT_SOURCE;
        saveSettings();
        applyTtsSettings();
      });
    }
    const rateSel = $('ttsRateSel');
    if (rateSel) {
      rateSel.value = String(state.settings.ttsRate || 1);
      rateSel.addEventListener('change', (e) => {
        state.settings.ttsRate = Number(e.target.value) || 1;
        saveSettings();
        applyTtsSettings();
      });
    }
    applyTtsSettings();
  }

  // [按钮 id（同一个开关可能有多个按钮，数组里列出来即可）, 设置键, 应用函数, 点击后要不要提示一句话]
  const toggles = [
    ['btnMirror', 'mirror', (v) => {
      $('stage').classList.toggle('mirror', v);
      state.calibrator?.setMirror(v); // 左右方向提示要跟着镜像走
      renderer.mirror = v;            // 画布上的角度文字要反向抵消，否则是镜像字
    }, null],
    ['btnVoice', 'voice', (v) => {
      audio.voiceOn = v;
      if (!v) { audio.stopSpeech(); return; }
      // 打开语音时立刻试播一句：用户马上就能确认到底有没有声音，
      // 而不是等到训练时才发现整场是静音的（顺便也是一次解锁音频的用户手势）
      audio.unlock();
      audio.say(t('speech.voiceTest'), { force: true });
      const st = audio.state();
      // 只开着门没出声的情况也要说清楚：上下文没跑起来（被浏览器挡住）或系统里没有语音包
      if (st.ctx !== 'running' || st.voices === 0) setCueLine(t('status.noSound'), 'warn');
    }, null],
    ['btnSfx', 'sfx', (v) => {
      audio.sfxOn = v;
      if (v) { audio.unlock(); audio.milestone(); }   // 打开音效也立刻响一声
    }, null],
    ['btnMusic', 'music', (v) => {
      applyMusic();          // 主页上不放背景音乐，回到动作页才播
      if (v) audio.unlock();
    }, (v) => setCueLine(t(v ? 'status.musicOn' : 'status.musicOff'))],
    // 「严格模式」已按用户要求彻底取消：判据只有关键帧这一套，界面与识别器里都没有开关了
    ['btnAngles', 'showAngles', (v) => { renderer.showAngles = v; }, null],
    ['btnSkeleton', 'showSkeleton', (v) => {
      renderer.showSkeleton = v;
      // 关掉后立刻清一次画布，避免残影留到下一帧
      if (!v) renderer.clear();
    }, (v) => setCueLine(t(v ? 'status.skeletonOn' : 'status.skeletonOff'))],
    ['btnDebug', 'debug', (v) => {
      if (!v) $('debugLine').hidden = true;
      // 🐞 调试行之外，教练面板也把「最后一次 ASR 原始错误名」露出来，方便排查没字幕
      coach.setDebug(v);
      coach.render(voice.snapshot());
    }, null],
  ];
  for (const [ids, key, apply, announce] of toggles) {
    const btns = (Array.isArray(ids) ? ids : [ids]).map((id) => $(id)).filter(Boolean);
    const press = (v) => { for (const b of btns) b.setAttribute('aria-pressed', String(!!v)); };
    press(!!state.settings[key]);
    apply(state.settings[key]);
    for (const btn of btns) {
      btn.addEventListener('click', () => {
        const v = !(btn.getAttribute('aria-pressed') === 'true');
        press(v);              // 同一个开关的其它按钮一起更新
        state.settings[key] = v;
        saveSettings();
        apply(v);
        if (announce) announce(v);
      });
    }
  }
  audio.voiceOn = state.settings.voice;
  audio.sfxOn = state.settings.sfx;
  // 用上次选的曲子（selectExercise 之前也来得及，因为音乐是这里才启动的）
  audio.setTrack(state.settings.musicTrack || DEFAULT_TRACK);

  // ---- 主页 / 设置弹窗 ----
  $('btnHome').addEventListener('click', () => showHome());
  $('btnSettings').addEventListener('click', () => openSettings());
  $('btnCloseSettings').addEventListener('click', () => closeSettings());
  $('settingsBackdrop').addEventListener('click', () => closeSettings());
  // 运动设定：只有**主页右上角**那个图标（和设置并排）；动作页没有入口。
  // 弹窗内部两步：第一步选动作，第二步设目标；顶部那颗大号胶囊按钮「换一个动作」回到第一步。
  $('btnExercise').addEventListener('click', () => openExerciseSettings());
  {
    // 按钮左边的线条返回箭头：和手势菜单里的「返回」同一个图标（icons.js 的 libIconSVG('back')），
    // 不从 emoji / 字符里凑 —— 24 网格、stroke 2、颜色走 currentColor（= 按钮的 --home-accent）。
    const icon = $('btnExercisePickAgain')?.querySelector?.('.pick-again-icon');
    if (icon) icon.innerHTML = libIconSVG('back', 'ui-icon');
  }
  $('btnExercisePickAgain').addEventListener('click', () => {
    showExercisePickStep();
    renderExercisePicker();   // 回来时把「上次选的动作」高亮 + 目标小字刷新一遍
    const first = $('exercisePickList')?.querySelector?.('.pick-card');
    if (first && typeof first.focus === 'function') first.focus({ preventScroll: true });
  });
  $('btnCloseExercise').addEventListener('click', () => closeExerciseSettings());
  $('exerciseBackdrop').addEventListener('click', () => closeExerciseSettings());

  // ---- 调试数据记录（**设置（全局配置）**弹窗里的隐藏分组）----
  {
    // AI 语音教练：设置里的开关（与视频界面的 Ctrl+I 完全同步）
    const btn = $('btnCoach');
    if (btn) {
      btn.setAttribute('aria-pressed', String(!!state.settings.coachEnabled));
      btn.addEventListener('click', () => {
        const v = !(btn.getAttribute('aria-pressed') === 'true');
        setCoachEnabled(v);   // 打开 = 请求麦克风；关闭 = 停 TTS + 释放轨道
      });
    }
    // P3.3 自由对话：开 / 关（默认开）。关掉之后**完全不发 /llm 请求**，只走命令快车道
    const freeBtn = $('btnFreeChat');
    if (freeBtn) {
      freeBtn.setAttribute('aria-pressed', String(!!state.settings.freeChat));
      freeBtn.addEventListener('click', () => {
        const v = !(freeBtn.getAttribute('aria-pressed') === 'true');
        applyFreeChat(v);
      });
    }
    // 「语音命令一览」：设置里那一行入口 + 弹窗自己的关闭方式（× / 点遮罩 / Esc）
    $('btnVoiceHelp')?.addEventListener('click', () => openVoiceHelp());
    $('btnCloseVoiceHelp')?.addEventListener('click', () => closeVoiceHelp());
    $('voiceHelpBackdrop')?.addEventListener('click', () => closeVoiceHelp());
    // 页面被关掉 / 进 bfcache 时也把麦克风与 TTS 收掉，绝不留后台录音
    window.addEventListener('pagehide', () => voice.stop());
  }

  {
    const btn = $('btnPoseLog');
    if (btn) {
      btn.setAttribute('aria-pressed', String(!!state.settings.poseLog));
      btn.addEventListener('click', () => {
        const v = !(btn.getAttribute('aria-pressed') === 'true');
        btn.setAttribute('aria-pressed', String(!!v));
        state.settings.poseLog = v;
        saveSettings();
        setPoseLog(v);
      });
    }
    const save = $('btnPoseLogSave');
    if (save) {
      save.addEventListener('click', () => {
        poseLogger.flush({ force: true });
        const name = poseLogger.download();
        setCueLine(t(name ? 'status.poseLogSaved' : 'status.poseLogEmpty', { file: name || '' }), name ? 'info' : 'warn');
        renderPoseLogStatus();
      });
    }
    // 打开时如果本来就在记录（比如刷新页面后开关还是开的），也把状态补上
    if (state.settings.poseLog) setPoseLog(true, { silent: true });
    renderPoseLogStatus();
    // 关页面 / 切后台时把最后一批数据发出去（否则最后 1 秒的采样会丢）：优先 sendBeacon
    window.addEventListener('pagehide', () => poseLogger.flushOnUnload());
    window.addEventListener('beforeunload', () => poseLogger.flushOnUnload());
  }

  // 鼠标移到某一格关键帧上 → 在进度条上方显示这一格的判定标准
  {
    const track = $('criteriaTrack');
    const segOf = (e) => (e.target && typeof e.target.closest === 'function' ? e.target.closest('.criteria-seg') : null);
    track.addEventListener('mouseover', (e) => {
      const seg = segOf(e);
      if (seg && seg.dataset) showCriteriaTip(Number(seg.dataset.i));
    });
    track.addEventListener('mouseout', (e) => {
      if (!segOf(e)) hideCriteriaTip();
    });
    track.addEventListener('mouseleave', () => hideCriteriaTip());
  }
  $('exSearch').addEventListener('input', (e) => {
    homeQuery = e.target.value || '';
    buildHome();
  });
  // 浏览器前进/后退在两个视图之间切换（自动化桩可能没有 hashchange，忽略即可）
  try { window.addEventListener('hashchange', handleRouteChange); } catch { /* ignore */ }

  // 浏览器要求「页面先有过一次用户交互」才允许出声（WebAudio 的 AudioContext 会一直 suspended，
  // Chrome 也会拦住没有交互就发起的语音）。所以在第一次点击/按键/触摸时就把音频解锁，
  // 免得后面由「自动识别完成」触发的倒计时、要领语音因为没赶上手势而整场静音。
  const unlockOnFirstGesture = () => {
    try { audio.unlock(); } catch { /* ignore */ }
    // 背景音乐要等这次用户手势之后才能出声（浏览器 autoplay 策略）
    try { applyMusic(); } catch { /* ignore */ }   // 首次手势解锁后，只在动作页放音乐
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      document.removeEventListener(ev, unlockOnFirstGesture);
    }
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    document.addEventListener(ev, unlockOnFirstGesture, { passive: true });
  }

  // 全屏只放大「视频框」(#stage)，不是整个 HTML 页面：
  // 整页全屏会把侧栏、要领清单、成绩卡一起放大，反而看不清动作。
  // 同一条链也负责 **iPhone 的 CSS 伪全屏**（没有元素级 API 时自动降级），
  // 所以这一个按钮在手机上一样「点了有反应」：再点一次就退出。
  $('btnFullscreen').addEventListener('click', () => toggleStageFullscreen());

  // 首页那个大「开始」按钮：全手势操作的入口（开摄像头 → 全屏 → 手势菜单）
  $('btnStartGesture')?.addEventListener('click', () => startGestureMode());
  // 页码按钮：鼠标 / 触屏用户的翻页办法（手势是向上 / 向下挥手）
  $('menuPage')?.addEventListener('click', () => flipMenuPage(1));
  // 原生全屏的状态变化（标准 API 与老 WebKit 的事件名不一样，两个都听）；
  // 伪全屏不走事件，按钮状态由 setPseudoFullscreen 自己维护。
  const onFsChange = () => {
    $('btnFullscreen').setAttribute('aria-pressed', String(stageFullscreenOn()));
    onStageResize();
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  /**
   * 视口变化（转屏 / 地址栏伸缩 / 软键盘）：一次把所有跟着变的东西重算一遍 ——
   * `--vh`（iOS 地址栏伸缩时 100vh 会算错）、设备类名与竖屏遮罩、圆环与菜单的位置。
   */
  const onViewportChange = () => {
    if (pseudoFullscreenOn()) exitFullscreen();   // 伪全屏是按旧视口钉住的，转屏后先退出更稳
    syncViewportUnit();
    syncDeviceClasses();
    onStageResize();
  };
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
  }
  // iOS 的地址栏伸缩只会改 visualViewport，不派发 window.resize —— 补两个监听
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (vv && typeof vv.addEventListener === 'function') {
    vv.addEventListener('resize', onViewportChange);
    vv.addEventListener('scroll', onViewportChange);
  }
  syncFullscreenSupport();

  $('camSel').addEventListener('change', async (e) => {
    state.settings.camDeviceId = e.target.value;
    saveSettings();
    await startCamera(e.target.value);
  });

  // 前置 / 后置摄像头切换（手机）：切换后重新开一次摄像头，失败会按降级顺序回退
  const facingSel = $('facingSel');
  if (facingSel) {
    facingSel.value = state.settings.cameraFacing || 'user';
    facingSel.addEventListener('change', async (e) => {
      state.settings.cameraFacing = e.target.value === 'environment' ? 'environment' : 'user';
      saveSettings();
      setCueLine(t('status.cameraFacing', {
        name: t(state.settings.cameraFacing === 'environment' ? 'ui.facingBack' : 'ui.facingUser'),
      }));
      if (camera.active) await startCamera(state.settings.camDeviceId || null);
    });
  }

  $('tMinus').addEventListener('click', () => {
    setTarget(state.target - targetStepFor(localizedExercise(state.exerciseId)));
  });
  $('tPlus').addEventListener('click', () => {
    setTarget(state.target + targetStepFor(localizedExercise(state.exerciseId)));
  });
  $('targetInput').addEventListener('change', (e) => setTarget(e.target.value));

  $('btnBest').addEventListener('click', () => openRecordsModal('best'));
  $('btnHistory').addEventListener('click', () => openRecordsModal('history'));
  $('btnCloseBest').addEventListener('click', () => closeRecordsModal());
  $('btnCloseHistory').addEventListener('click', () => closeRecordsModal());
  $('bestBackdrop').addEventListener('click', () => closeRecordsModal());
  $('historyBackdrop').addEventListener('click', () => closeRecordsModal());

  $('btnClearHistory').addEventListener('click', () => {
    if (!confirm(t('ui.clearConfirm'))) return;
    saveList(STORE.history, []);
    saveList(STORE.records, {});
    renderHistory();
    renderRecords();
    setCueLine(t('records.cleared'));
  });

  document.addEventListener('keydown', (e) => {
    /**
     * **Ctrl+I**：开 / 关「AI 语音教练」（用户要求：「在全屏界面如果按下 Ctrl+I，
     * 那么代表启动语音 AI 教练…再次按 Ctrl+I 则关闭」）。
     *
     * 三条约束：
     *   ① 全局生效（动作页 / 全屏 / 主页都行），并且 `preventDefault()`；
     *   ② **在输入框里按不生效**（搜索框、数字框、下拉框里 Ctrl+I 可能被浏览器 / 输入法用到，
     *      而且不该在打字时突然开麦）；
     *   ③ 和设置弹窗里的「AI 语音教练」开关走同一个 `setCoachEnabled`，所以两边状态永远同步。
     */
    const typingInField = !!e.target && (
      /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName || '') || e.target.isContentEditable === true
    );
    if ((e.ctrlKey || e.metaKey) && (e.key === 'i' || e.key === 'I')) {
      if (typingInField) return;
      e.preventDefault();
      toggleCoach();
      return;
    }
    /**
     * **Ctrl+H（macOS 上是 Cmd+H）**：在「运动设定」弹窗里显 / 隐「调试数据记录」那一组。
     *
     * 用户要求两轮：
     *   ① 「运动设定弹窗里的『调试数据记录』改为隐藏，只有用户在弹窗中按下 Ctrl+H 时，才会显示出来。」
     *   ② 「关于调试数据记录这部分，请从运动设置放到全局配置里面，还是维持 Ctrl+H 隐藏这样的模式，
     *      正常情况下不显示。此外，在视频状态下，按下 Ctrl+H 可以开启或者停止记录调试数据。」
     *
     * 所以现在是两条互不冲突的分工：
     *   - **设置弹窗（全局配置）打开时**：Ctrl+H = 把那一组显示 / 收起（它默认藏着）；
     *   - **视频画面状态下**（动作页、没有弹窗）：Ctrl+H = 直接**开始 / 停止记录**，不用打开弹窗 ——
     *     调试记录本来就是「练到一半发现没计上」才想起来开的东西，绕进弹窗太慢。
     *   其余情况（其它弹窗、主页）**不拦**这个键，交给浏览器（别把系统快捷键吞掉）。
     *
     * ⚠️ Ctrl+H 在 Chrome 里是「打开历史记录」——**有些浏览器版本会自己吃掉这个键、页面拦不住**。
     * 所以带上修饰键的变体（Ctrl+Shift+H / Ctrl+Alt+H / Cmd+*+H）**一律都算**：
     * 哪个没被浏览器抢走就用哪个，用户按 Ctrl+H 不行时换 Ctrl+Alt+H 一定能用。
     * 放在最前面判断（在「输入框优先」那道守卫之前）：它是组合键、不会和打字冲突。
     */
    if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H')) {
      if (settingsOpen()) {
        e.preventDefault();
        setPoseLogUi(!poseLogUiVisible);
        setCueLine(t(poseLogUiVisible ? 'status.poseLogUiOn' : 'status.poseLogUiOff'), 'info');
      } else if (videoStateActive()) {
        e.preventDefault();
        togglePoseLog();
      }
      return;
    }
    /**
     * 「设置」选择层（中间那一排「每组次数 / 每组秒数」圆环）开着的时候，键盘只服务这一层：
     *   - `Esc` 关掉它（用户要求的关闭方式之一）；
     *   - `← / →`（或 `PageUp / PageDown`）翻页：和点「向前 / 向后」箭头、手掌停在箭头上 3 秒完全等价；
     *   - 数字键 `1`~`5` 直接选**这一页**第几个（比 Tab 过去按回车快）；
     *   - `Tab` / `Shift+Tab` 照常走浏览器默认行为（每颗圆环都是真 `<button>`，能 Tab 到、能回车选中）；
     *   - 其余按键**不穿透**到训练快捷键（否则按空格会开始训练、按 H 会回主页 —— 选择层还没关）。
     */
    if (state.setPickerOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSetPicker();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        flipSetPickerPage((e.key === 'ArrowRight' || e.key === 'PageDown') ? 1 : -1);
        return;
      }
      const pick = Number(e.key);
      // 数字键按「这一页上的第几个选项」算（箭头不占号）：第 2 页按 1 选的是这一页第一个值
      const pageChoices = setPickerPageRings().rings.filter((r) => r.role === 'choice');
      if (Number.isFinite(pick) && pick >= 1 && pick <= pageChoices.length) {
        e.preventDefault();
        chooseSetValue(pageChoices[pick - 1].value);
      }
      return;
    }
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) {
      // 搜索框里按 Esc 先退出搜索，而不是结束整组
      if (e.key === 'Escape' && e.target.id === 'exSearch') {
        e.target.value = '';
        homeQuery = '';
        buildHome();
        e.target.blur();
      }
      return;
    }
    if (e.key === 'Escape') {
      // 弹窗优先关闭；手势菜单里按 Esc = 回网页首页（和右上角圆环同一个动作）；
      // iPhone 的 CSS 伪全屏里 Esc = 先退出全屏（再按一次才是结束这一组）；最后是结束本组
      if (voiceHelpOpen()) { closeVoiceHelp(); return; }
      if (recordsModalOpen()) { closeRecordsModal(); return; }
      if (exerciseSettingsOpen()) { closeExerciseSettings(); return; }
      if (settingsOpen()) { closeSettings(); return; }
      if (state.menuMode) { showHome(); return; }   // showHome 里会把全屏（含伪全屏）一起退出
      if (pseudoFullscreenOn()) { exitFullscreen(); return; }
      stopSession('user');
      return;
    }
    // 手势菜单里：左右方向键翻页（键盘用户 / 没有摄像头时也能翻）
    if (state.menuMode && (e.key === 'ArrowLeft' || e.key === 'PageUp'
      || e.key === 'ArrowRight' || e.key === 'PageDown')) {
      e.preventDefault();
      flipMenuPage((e.key === 'ArrowRight' || e.key === 'PageDown') ? 1 : -1);
      return;
    }
    if (e.key === 'h' || e.key === 'H') { showHome(); return; }
    if (e.key === 'g' || e.key === 'G' || e.key === '?') {
      if (settingsOpen()) closeSettings(); else openSettings();
      return;
    }
    if (e.code === 'Space') { e.preventDefault(); startSession(); return; }
    if (e.key === 'r' || e.key === 'R') { $('btnResetReps').click(); return; }
    if (e.key === 'm' || e.key === 'M') { $('btnMirror').click(); return; }
    if (e.key === 's' || e.key === 'S') { $('btnSkeleton').click(); return; }
    if (e.key === 'f' || e.key === 'F') { $('btnFullscreen').click(); return; }
    // 数字键 1~9：快速切到动作库里前 9 个动作（动作变多了，全部映射已经没有意义）
    const n = Number(e.key);
    if (n >= 1 && n <= Math.min(9, EXERCISES.length)) openExercise(EXERCISES[n - 1].id);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.session === 'running') pauseSession();
      // AI 教练：页面隐藏时自动暂停聆听（麦克风保持，避免回来又弹一次权限）
      voice.pause();
    } else {
      // 屏幕常亮：切到后台时浏览器会把 wakeLock 收回去，回到前台且还在练就重新申请一次
      if (state.session === 'running' && !state.wakeLock) requestWakeLock();
      // 回到前台且用户还开着 AI 教练 → 恢复聆听
      voice.resume();
    }
  });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

/** 把运行时错误直接显示在页面上，方便排查（也方便自动化检查） */
function installErrorBanner() {
  let el = null;
  const show = (msg) => {
    if (!el) {
      el = document.createElement('div');
      el.id = 'errBanner';
      el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99;'
        + 'background:rgba(120,20,20,0.94);color:#ffe3e3;border:1px solid #f87171;border-radius:12px;'
        + 'padding:10px 14px;font:13px/1.5 system-ui,sans-serif;white-space:pre-wrap;max-height:30vh;overflow:auto';
      document.body.appendChild(el);
    }
    el.textContent = 'Runtime error: ' + msg;
    document.documentElement.dataset.error = msg;
  };
  window.addEventListener('error', (e) => show(e.message || String(e.error || e)));
  window.addEventListener('unhandledrejection', (e) => show(String(e.reason?.message || e.reason)));
}

function installProbe() {
  setTimeout(() => {
    const res = performance.getEntriesByType('resource')
      .filter((r) => /\.wasm|\.task|vision_bundle/.test(r.name))
      .map((r) => ({ file: r.name.split('/').pop(), status: r.responseStatus || 0, kb: Math.round((r.transferSize || r.decodedBodySize || 0) / 1024) }));
    // HUD 那一列（目标 / 圆环 / 计分）的几何：三者共用一根中线，圆环直径也在这里 —— 版面「看着不对」时直接读
    const hudCol = hudColumnGeom(stageSize());
    const info = {
      error: document.documentElement.dataset.error || null,
      lang: getLang(),
      engineReady: state.engineReady,
      delegate: engine.delegate,
      modelKey: engine.modelKey,
      cameraActive: camera.active,
      video: `${camera.video.videoWidth}x${camera.video.videoHeight}`,
      aspect: Number(camera.aspect.toFixed(3)),
      loopCount: state.loopCount,
      detectCount: state.detectCount,
      poseHits: state.poseHits,
      overlay: `${renderer.canvas.width}x${renderer.canvas.height}`,
      exercise: state.exerciseId,
      target: state.target,
      session: state.session,
      calibHint: $('calibHint').textContent,
      calibBadge: $('calibBadge').textContent,
      calibVisible: $('calibCard').hidden === false,
      startDisabled: $('btnStart').disabled,
      hudValue: $('hudValue').textContent,
      hudName: $('hudName').textContent,
      // 目标 / 圆环 / 计分共用的中心 x（+ 圆环直径），与测试断言的是同一个函数算出来的数
      hudColumn: {
        cx: Math.round(hudCol.cx),
        ringPx: Math.round(hudCol.ringPx),
        left: Math.round(hudCol.left),
      },
      camStatus: $('camStatus').textContent,
      camError: state.camError,
      maskTitle: $('maskTitle').textContent,
      maskText: $('maskText').textContent,
      cueLine: $('cueLine').textContent,
      stepHint: $('stepHint').textContent,
      maskVisible: !$('stageMask').classList.contains('hidden'),
      exerciseButtons: document.querySelectorAll('.ex-card, .exercise-btn').length,
      homeCards: document.querySelectorAll('.ex-card').length,
      homeView: !$('homeView').hidden,
      settingsOpen: !$('settingsModal').hidden,
      resources: res,
      consoleErrors: state.consoleErrors,
    };
    const pre = document.createElement('pre');
    pre.id = 'probe';
    pre.textContent = 'PROBE_JSON:' + JSON.stringify(info);
    document.body.appendChild(pre);
    document.title = 'PROBE_READY';
    try {
      fetch('/__probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(info) });
    } catch { /* ignore */ }
  }, 15000);
}

function boot() {
  installErrorBanner();
  captureConsole();
  const params = new URLSearchParams(location.search);
  if (!Camera.supported()) {
    // 分两种情况说清楚：**不是安全上下文**（http + 局域网 IP，手机上的头号原因）
    // 与「浏览器太老 / 不支持」。两种都把诊断面板亮出来，让用户看到 isSecureContext 等事实。
    const insecure = typeof window !== 'undefined' && window.isSecureContext === false
      && location.protocol !== 'file:';
    $('maskIcon').textContent = insecure ? '🔒' : '🚫';
    $('maskTitle').textContent = t(insecure ? 'ui.maskInsecureTitle' : 'ui.maskUnsupportedTitle');
    $('maskText').textContent = t(insecure ? 'ui.maskInsecureText' : 'ui.maskUnsupportedText');
    $('btnStartCam').disabled = true;
    renderCameraDiag(state.camErrName ? { name: state.camErrName, message: state.camErrMessage } : null);
  }
  setLang(detectLang(), { persist: false });
  applyI18n(document);
  buildLanguageSelect();
  buildMusicTracks();
  // 手机 / 低配机器：没被用户改过就用轻量模型（必须在 bindUI 之前，不然下拉框读的是旧值）
  applyDeviceDefaults();
  bindUI();
  // 视口单位与设备类名（含竖屏遮罩）先算一次，第一屏就是对的
  syncViewportUnit();
  syncDeviceClasses();
  // 先按地址栏路由定位：带 ?exercise= / ?autostart / ?probe 时直接进动作页（自动化与书签要用），
  // 地址栏是 #/ex/<id> 时进那个动作，否则停在主页让用户挑分类与动作。
  const wantId = params.get('exercise') || routeExercise();
  const direct = !!wantId || params.has('autostart') || params.has('probe');
  selectExercise(wantId || state.settings.exerciseId || 'squat');
  if (direct) {
    showWorkout();
    setRoute(ROUTE_EX + state.exerciseId);
  } else {
    showHome();
  }
  renderHistory();
  renderRecords();
  updateButtons();
  updateHud();
  updatePipelineStatus();
  requestAnimationFrame(loop);
  if (state.settings.mirror) {
    $('stage').classList.add('mirror');
    renderer.mirror = true;   // 角度标签跟着反向，避免出现镜像文字
  }

  if (location.protocol === 'file:') {
    setCueLine(t('status.fileProtocol'), 'warn');
  }

  // AI 语音教练：用户上次把它开着 → 这次进来接着开（权限已授权时不会重复弹框）。
  // 放在首屏渲染之后，失败也只会在状态环 / 字幕里提示，不影响训练流程。
  // 教练开着时系统语音要让位（避免重复，也避免 speechSynthesis.cancel 掐断教练）——
  // 这里先同步关一次，setCoachEnabled 里面还会再按最终状态对齐。
  if (state.settings.coachEnabled) {
    audio.setVoiceEnabled(false);
    setTimeout(() => setCoachEnabled(true, { silent: true }), 0);
  }

  if (params.has('autostart') && Camera.supported()) {
    setTimeout(() => startCamera(), 60);
  }
  if (params.has('probe')) installProbe();
}

boot();

// 调试/自动化测试用的内部句柄（页面本身不依赖它）
window.__mfg = {
  state, engine, camera, audio, renderer, loop,
  selectExercise, startSession, pauseSession, resumeSession, stopSession, toCalibration, beginCountdown,
  feedDetector, handleEvents, updateHud, renderSteps, renderDebug, updatePipelineStatus,
  calibrationStep, renderCalibration, syncFullscreenSupport, finishCountdown, updateStatusHint,
  setTarget, changeLang, refreshForLang,
  buildHome, showHome, showWorkout, openExercise, openSettings, closeSettings,
  openExerciseSettings, closeExerciseSettings, renderExerciseSettings,
  // 运动设定弹窗的两步：第一步选动作（分组列出动作库）/ 第二步目标与判据 / 「换一个动作」
  renderExercisePicker, pickExerciseForSettings, showExercisePickStep, showExerciseTargetStep,
  settingsExerciseId, targetForExercise,
  openRecordsModal, closeRecordsModal, recordsModalOpen, renderRecords, renderHistory,
  buildCriteriaBar, updateCriteria, resetCriteriaProgress, renderCriteriaBar,
  showCriteriaTip, hideCriteriaTip,
  showGestureRings, hideGestureRings, updateGesture, triggerGesture, retrySet,
  gestureState, GESTURE_RINGS, GESTURE_HOLD_MS, RING_HIT,
  // 右上角常驻的「退出」圆环（手或脚进去停 3 秒 → 退出这一组）
  showCornerExit, hideCornerExit, updateCornerExit, triggerCornerExit, syncCornerExit,
  // 右上角「设置」圆环（在退出环**正下方**、同尺寸）+ 屏幕中间那一层「每组次数 / 秒数」圆环：
  //   geometry  : settingsRingLayout / layoutSetRing / SET_RING_GAP_PX
  //   interaction: updateSetRing / triggerSetRing / resetSetRing
  //   picker    : openSetPicker / closeSetPicker / renderSetPicker / updateSetPicker / chooseSetValue
  //   paging    : SET_PICKER_PER_PAGE（一页 5 个）/ setPickerPageRings / setPickerPages / flipSetPickerPage
  //   layout    : setChooserLayout / setChooserCols / setChooserCellFor（纯函数，测试直接断言「大屏小屏都不越界」）
  //   choices   : SET_REP_CHOICES / SET_SEC_CHOICES（**一处定义**，界面与测试都从这里读）
  settingsRingLayout, layoutSetRing, SET_RING_GAP_PX,
  updateSetRing, triggerSetRing, resetSetRing,
  openSetPicker, closeSetPicker, renderSetPicker, updateSetPicker, chooseSetValue,
  SET_PICKER_PER_PAGE, setPickerPageRings, setPickerPages, setPickerPageOf, flipSetPickerPage,
  setChooserLayout, setChooserCols, setChooserCellFor, setPickerKindFor, setChoicesFor,
  SET_REP_CHOICES, SET_SEC_CHOICES,
  SET_CHOOSER_GAP_PX, SET_CHOOSER_PAD_X, SET_CHOOSER_PAD_TOP, SET_CHOOSER_PAD_BOTTOM,
  SET_CHOOSER_MAX_PX, SET_CHOOSER_MIN_PX, SET_CHOOSER_ONE_ROW_MIN_PX, SET_CHOOSER_ONE_ROW_MAX,
  layoutCornerRing, ringCenter, ringPx, ringHitRadius, touchPoints, touchSamples, anyTouchInRing, anyTouchNearPoint, stageSize, onStageResize,
  // 右上角「退出 / 返回」圆环共用的**唯一**几何与摆放（动作页退出圆环 + 菜单返回圆环）
  exitRingLayout, layoutExitRing, menuBackItem, menuBackEl, syncMenuBackIcon,
  CORNER_RING_INSET_PX, CORNER_RING_TOP_PX, RING_PX_FALLBACK, RING_HIT_RATIO,
  // HUD 进度圆环里的字号自适应（纯函数，测试直接调）：
  //   hudRingInnerPx(ringPx) → 内径；hudTextWidth(text, fontSize) → 估算宽；hudValueFontSize(ringPx, text) → 字号
  hudRingInnerPx, hudTextWidth, hudValueFontSize, syncHudValueSize, hudRingPx,
  // HUD 那一列（目标 / 圆环 / 计分）共用的中心线：纯函数，测试断言「三者中心 x 相同」直接调它
  hudColumnGeom, HUD_COLUMN_PAD_X, HUD_COLUMN_PAD_TOP,
  HUD_RING_INNER_RATIO, HUD_DIGIT_EM, HUD_VALUE_PAD,
  TOUCH_VIS_MIN, FOOT_VIS_MIN, FOOT_TIP_FROM_HEEL, FOOT_TIP_FROM_SHIN, distToSegment, pointsInRing,
  // 手/脚「一部分进入即触发」用的外延点参数与退出圆环的宽容度（测试要按它们构造真实肢体）
  RING_TOUCH_TOL, HAND_EXT_K, HAND_EXT_MAX_ARM, FOOT_EXT_K,
  GESTURE_DRAIN_MS, RING_NEAR_FACTOR, touchDiagLine,
  announceHoldCount, HOLD_COUNT_EVERY,
  announceTimeLeft, TIME_CALL_AT, targetPresetsFor, targetStepFor,
  buildMusicTracks, selectMusicTrack,
  // 摄像头诊断面板（打不开时列出客观事实 + 处置建议）
  cameraDiagEnv, cameraDiagRows, cameraDiagAdviceKey, renderCameraDiag, DIAG_ERROR_ADVICE, diagYesNo,
  // 手机适配：设备档位 / 视口单位 / 安全区 / 竖屏遮罩 / 省电默认值
  deviceClass, deviceEnv, perfTier, pickDefaultModelKey, shouldSuggestRotate,
  safeAreaInsets, syncViewportUnit, syncDeviceClasses, applyDeviceDefaults,
  // 调试数据记录（全局配置里的隐藏分组）：记录器本体 + 开关函数，测试直接用它们驱动
  poseLogger, setPoseLog, togglePoseLog, poseLogMeta, renderPoseLogStatus,
  setPoseLogUi, anyModalOpen, videoStateActive,
  // 全手势操作：首页「开始」按钮 + 视频界面里的手势菜单（两级 + 分页 + 翻页圆环）
  startGestureMode, openMenu, closeMenu, selectFromMenu, renderMenu, layoutMenu, renderMenuPage,
  libIconSVG, setRingIcon, pawSVG, renderPaws, pawsWanted, updatePaws,
  updateMenu, flipMenuPage, menuPageInfo, menuPerPage, menuHasPages, menuNavLayout, menuCols,
  menuRingLayout, menuItems, menuItemEl, menuCategoryName, paintMenuRing, requestStageFullscreen,
  // 每页格子数 / 翻页圆环占的格子（「每行最多 6 格，翻页圆环也是这一行的格子」）
  menuPageCells, menuNavCells,
  // 全屏降级链：标准 requestFullscreen → webkitRequestFullscreen → iPhone 的 CSS 伪全屏
  pickFullscreenMode, fullscreenCaps, pseudoFullscreenOn, setPseudoFullscreen, exitFullscreen,
  stageFullscreenOn, toggleStageFullscreen, ensureGestureFullscreen, PSEUDO_FS_CLASS,
  // 摄像头 + 麦克风授权：先查权限（permissions.query）再决定要不要弹框
  //   queryGesturePermission → { camera, microphone }（两个分开判）
  //   gestureWantsMic        → 只有麦克风被拒时不要它（麦克风失败不拦训练）
  //   showMicDeniedHint      → 麦克风被拒时的轻量说明（画面 6 秒提示 + 侧栏一句）
  queryMediaPermission, queryGesturePermission, gestureWantsMic, startGestureCamera,
  showGesturePermissionDenied, showMicDeniedHint,
  tickCornerExit, syncCornerLabel,
  MENU_COLS, MENU_ROWS, MENU_HIT_RATIO, MENU_START_RATIO, MENU_NAV_HIT_RATIO, MENU_RING_MAX,
  MENU_NAV_HOLD_MS, MENU_ANNOUNCE_P, MENU_CELL_MIN_PX,
  MENU_STILL_SPEED, MENU_ARM_MS, MENU_DRAIN_MS,
  MENU_SWIPE_TRAVEL, MENU_SWIPE_MS, MENU_SWIPE_CHAIN_MS, MENU_SWIPE_COOLDOWN_MS,
  MENU_SWIPE_QUIET, MENU_SWIPE_QUIET_MS, updateMenuSwipe, menuRowsFor,
  animateMenuSwap, menuBackHome, menuBandGeom, MENU_ANIM_OUT_MS, MENU_ANIM_IN_MS,
  // AI 语音教练（P3.0 基座）：会话状态机 / 界面控制器 / 开关函数 / 版面纯函数
  //   voice         : { state, enabled, paused, userText, coachText, error, snapshot(), start/stop }
  //   coach         : coach.render(snapshot())
  //   setCoachEnabled / toggleCoach : 设置开关与 Ctrl+I 共用的唯一入口
  //   coachLayout   : 字幕面板 / 状态环 / HUD / 判定条 / 右上角圆环的纯几何（测试断言不越界）
  voice, coach, setCoachEnabled, toggleCoach, syncCoachToggle, coachLayout, voiceErrorKey,
  // P3.6 对话弹幕 + 火山 TTS：
  //   danmaku          : createDanmaku() 的实例（push / setInterim / setMode / snapshot）
  //   applyDialogueMode: 设置里「对话显示」三选一的唯一入口（弹幕 / 字幕 / 关闭）
  //   coachTts         : 火山优先、失败回退系统 TTS 的播放层（speak / stop / setSource / setRate）
  //   coachSystemTts   : 原来的系统 TTS（降级兜底；测试用它确认 fallback 真的被调用）
  danmaku, applyDialogueMode, coachTts, coachSystemTts, applyTtsSettings,
  DANMAKU_MODES, DANMAKU_DEFAULT_MODE, DANMAKU_COLORS,
  TTS_SOURCES, TTS_DEFAULT_SOURCE, TTS_PATH,
  // P3.5 语音排障：诊断收集器（snapshot / record / flush）+ 独立自检控制器
  //   coachDiag.snapshot() → 路由 / WS / 帧数 / partial·final / 最近错误 / 麦克风 / Worklet
  //   coachSelfTest.run()  → 麦克风 → 代理 → 录 2 秒发送 → 服务端结果（四步，独立于会话）
  coachDiag, coachSelfTest, toggleCoachDiag: () => coach.toggleDiag(),
  runVoiceSelfTest: () => coach.runSelfTest(),
  // P3.2 命令快车道：命令表 / 注入的 ctx / 帮助面板 / 只读快照 / 静音
  //   COMMANDS      : 唯一来源（intent + 中英说法 + run）
  //   voiceCommandCtx: 注入给 session 的「现有函数」表（测试可以直接替换某一项做拦截）
  //   openVoiceHelp / closeVoiceHelp / renderVoiceHelp: 「我能说什么」面板
  //   getStateSnapshot: 命令只读 state 的唯一入口（P3.3 起也是 LLM context 的原始事实来源）
  COMMANDS, commandHelpRows, voiceCommandCtx,
  setCoachMuted, getStateSnapshot, pickMenuItem,
  voiceHelpOpen, openVoiceHelp, closeVoiceHelp, renderVoiceHelp,
  // P3.3 自由对话：/llm 客户端 + context 组装 + 设置开关
  //   llmClient        : createLlmClient()（测试用 setFetch 换掉，不联网）
  //   voiceLlm         : 会话层实际用的适配器（reply → { text, actions }）
  //   getLlmContext    : 一句话 + 当前状态 → 结构化 Agent context（P3.3 补充要求）
  //   buildAgentContext: 纯函数（src/voice/llm.js 导出，测试直接喂快照）
  //   applyFreeChat    : 设置里「自由对话」开关的唯一入口（关掉就完全不发 /llm）
  llmClient: coachLlmClient, voiceLlm, llmMock: coachLlmMock,
  getLlmContext, buildAgentContext, applyFreeChat, refreshLlmStatus, syncFreeChatToggle,
  // 画面右下角的「正在记录 x 帧」角标
  renderRecBadge,
  // 姿态模型加载（用户反馈「点开始就姿态模型加载失败」的修复点）：
  //   分阶段失败（wasm / 模型下载 / 推理器创建 / 首帧推理）→ 下载类自动重试 → GPU→CPU 兜底并记住
  //   loadPoseModel()   → true / false（失败时 state.modelError 有 {stage,name,message}）
  //   poseFailText(err) → 「阶段（原因）」中文/英文词条拼出来的那句话
  //   poseLoadTuning    → 重试次数 / 退避间隔 / 首帧超时 / 整体超时（测试把它调小，不必真等）
  loadPoseModel, reloadModel, poseFailText, poseFailReason, poseFailSentence, loadErrorInfo,
  poseLoadTuning, POSE_STAGE_KEYS, PoseLoadError,
  // 姿态模型加载进度条：真实字节进度（运行库 40% / 模型 40% / 初始化 20%）
  //   renderModelProgress() 画一次并把 composeProgress 的结果返回（测试直接断言百分比）
  //   modelProgressState    三段各自的 loaded/total/bps/done（测试可直接喂）
  //   composeProgress       纯函数（pose-engine.js）：总百分比 / 不确定态
  modelProgressState, renderModelProgress, resetModelProgress, handlePoseProgress, notePoseProgress,
  poseProgressLog, composeProgress, formatMB,
};
