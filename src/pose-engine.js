/**
 * MediaPipe PoseLandmarker 封装。
 * 模型与 wasm 全部走本地 vendor 目录，断网也能跑，画面不出本机。
 *
 * 用户反馈「在首页点『开始体感训练』→ 姿态模型加载失败」之后，加载流程按**阶段**重写：
 *
 *   ① `wasm`   解析 wasm 文件集（FilesetResolver.forVisionTasks）
 *   ② `model`  下载模型文件（先看 HTTP 状态；字节直接喂给推理器，createFromOptions 不再自己联网）
 *   ③ `create` 创建推理器（GPU 失败 → 自动换 CPU 重试一次）
 *   ④ `detect` 首帧推理自检（带超时；GPU 首帧失败 / 超时同样自动换 CPU）
 *
 * 每个阶段的失败都包成 `PoseLoadError`（带 stage / 真实错误名 / 一句话原因），
 * 界面才能显示「模型文件下载失败（HTTP 404）」这种能照着念的提示，而不是笼统的「加载失败」。
 *
 * 重试策略：
 *   - **只有下载类失败**（fetch 抛错 / HTTP 4xx·5xx / wasm 拉不下来）才重试，
 *     退避 400 → 900 → 1800ms，首次 + 3 次 = 最多 4 次；
 *   - WebGL / wasm 编译 / 推理器创建这类重试也没用的失败**不重试**，直接走 CPU 兜底或报错；
 *   - GPU 兜底成功后由调用方把 `delegate: 'CPU'` 记进设置，下次启动直接用它（不再先失败一次）。
 */

import { FilesetResolver, PoseLandmarker } from '../vendor/tasks-vision/vision_bundle.mjs';

// 模型文件路径（界面上的模型名称走 i18n：ui.modelLite / ui.modelFull）
// `rev` = 模型文件的**字节数**（指纹）：模型 URL 会拼上 `?v=rev`，换了模型文件指纹自动变，
// 不用手工记版本号；老缓存也不会被一直用下去（用户反馈过「前几天都好好的，今天坏了」）。
export const MODELS = {
  lite: { url: './vendor/models/pose_landmarker_lite.task', rev: '5777746' },
  full: { url: './vendor/models/pose_landmarker_full.task', rev: '9398198' },
};

/** 带缓存击穿参数的模型 URL：`./vendor/models/pose_landmarker_lite.task?v=5777746` */
export function modelUrlFor(modelKey = 'lite') {
  const model = MODELS[modelKey] || MODELS.lite;
  return `${model.url}?v=${model.rev}`;
}

export const WASM_DIR = './vendor/tasks-vision/wasm';

/**
 * 最保守的运行库：同一目录里就有**非 SIMD** 的构建（Chromium 也认得，只是慢一点）。
 * 初始化抛错（SIMD 编译 / 运行库 Abort / 线程相关）时最后用这一套再试一次。
 * 说明：vendor 里这版 wasm 是**单线程**构建（loader 与 .wasm 里 SharedArrayBuffer / Atomics /
 * numThreads 全是 0 处），所以没有 `numThreads` 这个开关可调 —— 能换的只有「非 SIMD + CPU」。
 */
export const NOSIMD_FILES = {
  wasmLoaderPath: './vendor/tasks-vision/wasm/vision_wasm_nosimd_internal.js',
  wasmBinaryPath: './vendor/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm',
};

/** 下载类失败的重试间隔（ms）：首次失败等 400，第二次 900，第三次 1800，再失败就报错 */
export const RETRY_DELAYS = [400, 900, 1800];
/** 总共尝试几次（首次 + 3 次重试） */
export const LOAD_ATTEMPTS = RETRY_DELAYS.length + 1;
/** 首帧推理最多等多久（ms）：超时当失败 → 自动切 CPU，界面不会一直转圈 */
export const FIRST_DETECT_TIMEOUT_MS = 8000;
/**
 * 默认 delegate = **CPU**（用户实测：GPU 在创建 WebGL 上下文时会**卡死**而不是报错，
 * 于是白等一个超时才轮到 CPU）。CPU 跑 pose lite 15~30fps 够用，稳比快重要。
 */
export const DEFAULT_DELEGATE = 'CPU';
/** 用户主动要 GPU 时只给它 **6 秒**软超时：卡住 / 失败都立刻切 CPU（超时也算兜底！） */
export const GPU_INIT_TIMEOUT_MS = 6000;
/**
 * 初始化（createFromOptions + 首帧自检）最多等多久（ms）。
 * 从 20s 放宽到 45s：9.3MB 的 wasm 在慢机器上编译 10~20s 很常见，
 * 20s 会把「其实能成功」的初始化误杀成「推理器创建失败（超时 20s）」（用户就是这么中招的）。
 */
export const INIT_TIMEOUT_MS = 45000;
/** 整个加载最多等多久（app.js 拿它做最后一道保险：各阶段自己的超时会先触发，这里是兜底） */
export const LOAD_TIMEOUT_MS = 240000;

/** 阶段名（界面按它挑词条 ui.poseStage*，诊断日志里也原样记这个值） */
export const LOAD_STAGES = ['wasm', 'model', 'create', 'detect', 'timeout', 'env'];

/** 这些错误名属于「可能是一过性的网络问题」→ 值得退避重试一次 */
const RETRYABLE_NAMES = ['TypeError', 'NetworkError', 'AbortError', 'HttpError', 'FetchError'];

/**
 * 姿态模型加载失败（带阶段的结构化错误）。
 * 字段：stage（哪个阶段）/ errName（浏览器报的真实错误名）/ reason（一句话原因）/
 *       retryable（值不值得重试）/ delegate（GPU 还是 CPU）/ status（HTTP 状态码）/ seconds（超时秒数）/
 *       timeoutMs（那一档的上限）/ elapsedMs（真的等了多久）/ conservative（是不是最保守那一档）。
 */
export class PoseLoadError extends Error {
  constructor(stage, errName, message, {
    cause = null, retryable = false, delegate = '', status = 0, seconds = 0, loaded = 0, total = 0,
    timeoutMs = 0, elapsedMs = 0, conservative = false, attempt = 0,
  } = {}) {
    super(String(message || errName || stage || 'pose model load failed'));
    this.name = 'PoseLoadError';
    this.stage = LOAD_STAGES.includes(stage) ? stage : 'unknown';
    this.errName = String(errName || 'Error');
    this.reason = String(message || '');
    this.retryable = !!retryable;
    this.delegate = String(delegate || '');
    this.status = Number(status) || 0;
    this.seconds = Number(seconds) || 0;
    /** 下载卡住时「已经收到多少 / 总共多少字节」（界面提示「已收 2.9MB / 5.6MB」） */
    this.loaded = Number(loaded) || 0;
    this.total = Number(total) || 0;
    /** 初始化超时要说清「上限多少 / 已经等了多久」（用户看到的「推理器创建失败（超时 20s）」就是这里） */
    this.timeoutMs = Number(timeoutMs) || 0;
    this.elapsedMs = Number(elapsedMs) || 0;
    this.conservative = !!conservative;
    this.attempt = Number(attempt) || 0;
    if (cause) this.cause = cause;
  }
}

/** 这个错误值不值得重试（纯函数）：网络 / HTTP 类 → true；WebGL、wasm 编译、超时 → false */
export function isRetryableLoadError(err) {
  if (!err) return false;
  if (typeof err.retryable === 'boolean') return err.retryable;
  return RETRYABLE_NAMES.includes(String(err.name || err.errName || ''));
}

/** 是不是「超时」这一路失败（纯函数）：GPU 卡死 / 初始化太久都靠它区分兜底策略 */
export function isTimeoutLoadError(err) {
  return String((err && (err.errName || err.name)) || '') === 'TimeoutError';
}

/** 把任意一个阶段错误包成 PoseLoadError（纯函数；已经是 PoseLoadError 就原样返回） */
export function asLoadError(stage, err, extra = {}) {
  if (err instanceof PoseLoadError) return err;
  const errName = String((err && (err.name || err.errName)) || 'Error');
  const message = String((err && (err.message || err.reason)) || err || '');
  const retryable = extra.retryable !== undefined
    ? !!extra.retryable
    : RETRYABLE_NAMES.includes(errName);
  return new PoseLoadError(stage, errName, message, { ...extra, retryable, cause: err });
}

/** 带超时的等待：超时用 makeError() 拒绝（纯 Promise，测试可以直接喂很小的毫秒数） */
export function raceTimeout(promise, ms, makeError) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(typeof makeError === 'function' ? makeError() : new Error('timeout'));
    }, Math.max(1, Number(ms) || 1));
    Promise.resolve(promise).then(
      (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); },
      (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); },
    );
  });
}

/** 'GPU' / 'CPU' / null（null = 先试 GPU，失败再换 CPU） */
export function normalizeDelegate(value) {
  const v = String(value || '').trim().toUpperCase();
  return v === 'GPU' || v === 'CPU' ? v : null;
}

/* ------------------------------------------------------------------ *
 * 进度与超时（用户反馈：「一直显示正在加载姿态模型… 但就是加载不成功」）
 *
 * 卡死的根因是**某个 await 永远不返回**：没有超时，重试 / CPU 兜底永远等不到。
 * 所以这里给每一段都加了上限，并把「下载了多少字节」做成**真实进度**：
 *   - 运行库（wasm）：自己先流式读一遍（9.3MB + 0.2MB），拿到字节级进度，顺便预热 HTTP 缓存；
 *   - 模型文件：自己流式读（5.6MB），字节直接交给 createFromOptions 的 modelAssetBuffer；
 *   - 初始化：没法细分 → 不确定态 + 已用秒数。
 * ------------------------------------------------------------------ */

/** 下载时多久没有任何新字节 → 判定「网络卡住了」（ms） */
export const DOWNLOAD_STALL_TIMEOUT_MS = 60000;
/** 总进度条的权重：运行库 40% + 模型 40% + 初始化 20% */
export const PROGRESS_WEIGHTS = { wasm: 0.4, model: 0.4, init: 0.2 };

/**
 * 「加载偏慢」的门槛（用户口径：**单块速率 < 1MB/s 且已用超过 8 秒**）。
 *
 * 为什么需要这个：运行库与模型都是**本机 4174 提供的本地文件**，直连应该 10MB/s 以上
 * （实测 9.3MB 走 86~1655ms）。用户报「公司网络快、家里网络慢」—— 最常见的原因是家里开着
 * 代理 / VPN 把 `127.0.0.1` 也代理了（Chrome 默认把 localhost 交给系统代理，除非显式绕过）。
 * 所以慢到一定程度就在进度条下面提示「把 127.0.0.1、localhost 加进直连」——
 * **只提示，绝不自己去改系统代理** ✗（那是用户的机器设置）。
 *
 * 阈值放在这里**一处定义**：界面（app.js）与测试都读这两个常量，不另抄一份。
 */
export const SLOW_LOAD_BPS = 1024 * 1024;
export const SLOW_LOAD_AFTER_MS = 8000;

/**
 * 这一次进度算不算「加载偏慢」（纯函数）。
 *
 * @param {{bps?:number, elapsedMs?:number}} o  bps = 当前这一段的速率（字节/秒），elapsedMs = 已用毫秒
 * @returns {boolean} 已用超过 8 秒、且**测到的**速率低于 1MB/s
 *
 * 注意 `bps = 0`（一个字节都没来）**不算「慢」**：那是「卡住」，归下载卡住超时（60s 没新字节）
 * 去报，提示更准（会说「已收 0B / 5.6MB」）。这里只判「有速度但太慢」。
 */
export function isSlowLoad({ bps = 0, elapsedMs = 0 } = {}) {
  const speed = Math.max(0, Number(bps) || 0);
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  return speed > 0 && speed < SLOW_LOAD_BPS && elapsed >= SLOW_LOAD_AFTER_MS;
}

/** 字节数 → '2.9MB'（纯函数；进度条与失败原因共用同一份写法） */
export function formatMB(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 合成总进度（纯函数，界面直接用它画进度条）。
 *
 * @param {{wasm?:{loaded?:number,total?:number,done?:boolean},
 *          model?:{loaded?:number,total?:number,done?:boolean},
 *          init?:number}} parts   init 是 0~1 的「初始化」进度
 * @returns {{percent:number|null, approximate:number, indeterminate:boolean,
 *            done:boolean, wasm:object, model:object, init:number}}
 *   - 某一段拿不到 Content-Length（total 未知）→ 那一段是**不确定态**，`percent` 返回 null
 *     （界面显示不确定态 + 已下载字节，绝不谎报百分比）；
 *   - 顺序推进时 `approximate` 单调不减（下一步开始时 loaded/total 只会变大）；
 *   - **wasm 传 null**（运行库交给识别器内部下载、我们拿不到字节）→ 那 40% 的权重
 *     并到 model / init 里按比例重分，百分比仍然能走到 100%（界面那一行另说，见 app.js）。
 */
export function composeProgress({ wasm = null, model = null, init = 0 } = {}) {
  const part = (p) => {
    if (!p) return { fraction: 0, indeterminate: false, done: false, loaded: 0, total: 0 };
    const loaded = Math.max(0, Number(p && p.loaded) || 0);
    const total = Math.max(0, Number(p && p.total) || 0);
    const done = !!(p && p.done);
    if (done) {
      const size = total || loaded;
      return { fraction: 1, indeterminate: false, done: true, loaded: size, total: size };
    }
    if (total > 0) {
      return {
        fraction: Math.min(1, loaded / total), indeterminate: false, done: false, loaded, total,
      };
    }
    return { fraction: 0, indeterminate: true, done: false, loaded, total: 0 };
  };
  const w = part(wasm);
  const m = part(model);
  const initFrac = Math.max(0, Math.min(1, Number(init) || 0));
  // wasm 缺席时把它的权重按比例分给 model / init（分母减小），否则永远到不了 100%
  const scale = wasm ? 1 : (1 - PROGRESS_WEIGHTS.wasm);
  const fraction = ((w.fraction * PROGRESS_WEIGHTS.wasm)
    + (m.fraction * PROGRESS_WEIGHTS.model)
    + (initFrac * PROGRESS_WEIGHTS.init)) / scale;
  const indeterminate = w.indeterminate || m.indeterminate;
  return {
    percent: indeterminate ? null : Math.round(fraction * 100),
    approximate: Math.round(fraction * 100),
    indeterminate,
    done: w.done && m.done && initFrac >= 1,
    wasm: w,
    model: m,
    init: initFrac,
  };
}

export class PoseEngine {
  /**
   * @param {object} [deps] 可注入依赖（单测用；页面里全部用默认实现）
   *   resolveVision(dir)                → FilesetResolver.forVisionTasks
   *   createLandmarker(vision, options) → PoseLandmarker.createFromOptions
   *   fetchModel(url)                   → fetch：模型**只在这里下载一次**
   *   sleep(ms)                         → 重试之间的退避等待
   *   now()                             → 首帧推理要用的单调时间戳
   */
  constructor(deps = {}) {
    this.resolveVision = deps.resolveVision || ((dir) => FilesetResolver.forVisionTasks(dir));
    this.createLandmarker = deps.createLandmarker
      || ((vision, options) => PoseLandmarker.createFromOptions(vision, options));
    this.fetchModel = deps.fetchModel || null;
    this.sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now || (() => (typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now()));
    this.landmarker = null;
    this.delegate = null;
    this.modelKey = null;
    /** 最近一次加载失败的 PoseLoadError（界面 / 诊断日志读它） */
    this.lastError = null;
    this._lastTs = -1;
    this._vision = null;
  }

  get ready() { return !!this.landmarker; }

  /**
   * 加载模型（分阶段 + 下载类失败自动重试 + GPU/超时 → CPU 兜底）。
   *
   * @param {object} o
   *   modelKey             'lite' | 'full'
   *   delegate             'GPU' | 'CPU' | null（null/空 = 默认 CPU；只有显式传 'GPU' 才先试 GPU）
   *   video                首帧推理自检用的 <video>（拿不到就跳过 ④）
   *   onStatus(text)       英文进度（控制台 / 兼容旧调用）
   *   onProgress(p)        进度：{stage:'model'|'init', loaded, total, bps, done, indeterminate,
   *                        delegate, attempt, attempts, conservative, timeoutMs}
   *   onRetry({retry,retries,attempt,max,delay,error})  马上要退避重试了
   *   onDelegate(delegate, error)  GPU 兜底成功（error = 当初 GPU 为什么不行）
   *   onAttemptFail(error, {attempt,delegate,conservative,willRetry})  初始化每一次失败都报（写诊断用）
   *   onFail(error, {attempt,max,willRetry})            某一次尝试彻底失败（写诊断日志用）
   *   attempts / retryDelays / firstDetectTimeoutMs / stallTimeoutMs / initTimeoutMs /
   *   gpuTimeoutMs / cpuFallback
   *                       都可在测试里调小（默认 4 次 / 400·900·1800ms / 8s / 60s / 45s / 6s）
   */
  async init({
    modelKey = 'lite',
    delegate = null,
    video = null,
    onStatus = () => {},
    onProgress = null,
    onRetry = null,
    onDelegate = null,
    onFail = null,
    onAttemptFail = null,
    attempts = LOAD_ATTEMPTS,
    retryDelays = RETRY_DELAYS,
    firstDetectTimeoutMs = FIRST_DETECT_TIMEOUT_MS,
    stallTimeoutMs = DOWNLOAD_STALL_TIMEOUT_MS,
    initTimeoutMs = INIT_TIMEOUT_MS,
    gpuTimeoutMs = GPU_INIT_TIMEOUT_MS,
    cpuFallback = true,
  } = {}) {
    const wanted = normalizeDelegate(delegate);
    if (this.landmarker && this.modelKey === modelKey && (!wanted || wanted === this.delegate)) return this;
    this.close();
    this.lastError = null;

    // 模型 URL 带 `?v=文件字节数`：模型换了指纹就变，不会一直被老缓存 / 中间缓存顶着
    const modelUrl = modelUrlFor(modelKey);
    const max = Math.max(1, Number(attempts) || LOAD_ATTEMPTS);
    const delays = Array.isArray(retryDelays) && retryDelays.length ? retryDelays : RETRY_DELAYS;
    onStatus(`Loading pose model (${modelKey})…`);

    /* ---- ② 模型：流式下载（真实字节进度），下载类失败自动重试 ---- */
    let assets = null;
    for (let attempt = 1; attempt <= max; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        assets = await this.loadAssets(modelUrl, { onProgress, stallTimeoutMs, initTimeoutMs });
        break;
      } catch (err) {
        const error = asLoadError(err.stage || 'model', err);
        const willRetry = attempt < max && isRetryableLoadError(error);
        if (onFail) onFail(error, { attempt, max, willRetry });
        if (!willRetry) {
          this.lastError = error;
          throw error;
        }
        const delay = Number(delays[Math.min(attempt - 1, delays.length - 1)]) || 0;
        // retry 从 1 数到 retries：界面上显示「正在重试（2/3）」就是这里给的
        if (onRetry) onRetry({ retry: attempt, retries: max - 1, attempt: attempt + 1, max, delay, error });
        // eslint-disable-next-line no-await-in-loop
        await this.sleep(delay);
      }
    }

    /* ---- ③④ 创建推理器 + 首帧自检 ----
     * 兜底链（用户实测：GPU 会在创建 WebGL 上下文时**卡死**，只接 reject 的兜底永远等不到）：
     *   ① 默认 CPU（稳）；
     *   ② 显式要 GPU 时只给 6s 软超时 —— **超时也当失败**，立刻换 CPU；
     *   ③ CPU 抛「非超时」的初始化错误（SIMD 编译 / 运行库 Abort）→ 用**非 SIMD 运行库 + CPU**
     *      再试一次（最保守的一档；纯超时不再补试，免得白等两轮）。
     */
    const primary = wanted || DEFAULT_DELEGATE;
    const plan = [{ delegate: primary, conservative: false }];
    if (primary === 'GPU' && cpuFallback) plan.push({ delegate: 'CPU', conservative: false });
    const initMs = Math.max(1, Number(initTimeoutMs) || INIT_TIMEOUT_MS);
    const gpuMs = Math.max(1, Number(gpuTimeoutMs) || GPU_INIT_TIMEOUT_MS);
    let lastErr = null;
    for (let i = 0; i < plan.length; i += 1) {
      const cfg = plan[i];
      const attemptMs = cfg.delegate === 'GPU' ? Math.min(initMs, gpuMs) : initMs;
      // 初始化这一段没法细分（库内部的事）：界面显示不确定态 + 已用秒数
      if (onProgress) {
        onProgress({
          stage: 'init',
          indeterminate: true,
          done: false,
          delegate: cfg.delegate,
          attempt: i + 1,
          attempts: plan.length,
          conservative: cfg.conservative,
          timeoutMs: attemptMs,
        });
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const landmarker = await this.createAndCheck(assets, cfg.delegate, video, firstDetectTimeoutMs, attemptMs, {
          fileset: cfg.conservative ? NOSIMD_FILES : null,
          attempt: i + 1,
          conservative: cfg.conservative,
        });
        this.landmarker = landmarker;
        this.delegate = cfg.delegate;
        this.modelKey = modelKey;
        this._vision = assets.vision;
        if (onProgress) {
          onProgress({
            stage: 'init',
            indeterminate: false,
            done: true,
            delegate: cfg.delegate,
            attempt: i + 1,
            attempts: plan.length,
            conservative: cfg.conservative,
            timeoutMs: attemptMs,
          });
        }
        onStatus(`Model ready (${cfg.delegate})`);
        // GPU 兜底成功：把「本机该用 CPU」告诉调用方（它会写进设置，下次直接用 CPU）。
        // 最保守那一档（非 SIMD + CPU）本来就是 CPU，不算 GPU 兜底，不弹「GPU 失败」的提示。
        if (i > 0 && plan[0].delegate === 'GPU' && !cfg.conservative && onDelegate) {
          onDelegate(cfg.delegate, lastErr);
        }
        return this;
      } catch (error) {
        lastErr = error;
        const retryAsCpu = i < plan.length - 1;
        // 只有「非超时」的初始化错误才值得换更保守的运行库再试一次
        const canConservative = !retryAsCpu && cpuFallback && !cfg.conservative
          && ['create', 'detect', 'wasm'].includes(error.stage)
          && !isTimeoutLoadError(error);
        if (onAttemptFail) {
          onAttemptFail(error, {
            attempt: i + 1,
            delegate: cfg.delegate,
            conservative: cfg.conservative,
            willRetry: retryAsCpu || canConservative,
          });
        }
        if (retryAsCpu) {
          const why = isTimeoutLoadError(error) ? 'initialization timed out' : 'delegate unavailable';
          console.warn(`[pose] ${cfg.delegate} ${why}, falling back to CPU:`, error?.reason || error?.message || error);
          onStatus('GPU unavailable, retrying with CPU inference…');
          continue;
        }
        if (canConservative) {
          plan.push({ delegate: 'CPU', conservative: true });
          console.warn('[pose] init failed, retrying with the most conservative build (non-SIMD + CPU):',
            error?.reason || error?.message || error);
          onStatus('Initialization failed, retrying with non-SIMD CPU…');
          continue;
        }
        if (onFail) onFail(error, { attempt: 1, max: 1, willRetry: false });
        this.lastError = error;
        throw error;
      }
    }
    // 理论上到不了这里（上面每一轮要么 return 要么 throw）
    this.lastError = lastErr || new PoseLoadError('create', 'Error', 'pose model load failed');
    throw this.lastError;
  }

  /**
   * ② 模型文件（运行库交给识别器自己下载，见下）。
   *
   * **不再预热 wasm**（用户拍板：`/vendor/**` 完全不缓存 → 预热等于把 9.3MB 下两遍，更慢）。
   * `FilesetResolver.forVisionTasks` 只算路径、不下载；9.3MB 的 wasm 由 `createFromOptions`
   * 内部拉取（那一段算在「③ 初始化识别器」里，界面用已用秒数反馈）。
   * 模型仍然**自己流式下载**（真实字节进度 + 卡住超时），字节直接交给 `modelAssetBuffer`，只下一次。
   */
  async loadAssets(modelUrl, {
    onProgress = null,
    stallTimeoutMs = DOWNLOAD_STALL_TIMEOUT_MS,
    initTimeoutMs = INIT_TIMEOUT_MS,
  } = {}) {
    if (!this._vision) {
      const ms = Math.max(1, Number(initTimeoutMs) || INIT_TIMEOUT_MS);
      try {
        this._vision = await raceTimeout(
          Promise.resolve().then(() => this.resolveVision(WASM_DIR)),
          ms,
          () => new PoseLoadError('wasm', 'TimeoutError', `timeout after ${Math.round(ms / 1000)}s`, {
            retryable: true, seconds: Math.round(ms / 1000),
          }),
        );
      } catch (err) {
        throw asLoadError('wasm', err, { retryable: isRetryableLoadError(err) });
      }
    }
    const bytes = await this.downloadWithProgress(modelUrl, {
      stage: 'model', timeoutMs: stallTimeoutMs, onProgress,
    });
    return { vision: this._vision, bytes };
  }

  /**
   * 流式下载：**真实字节进度**（`response.body.getReader()` + Content-Length）+ **卡住超时**。
   *
   * 每读一块回调一次 `onProgress({stage, loaded, total, bps, done})`；
   * 超过 `timeoutMs` 没有任何新字节 → PoseLoadError(stage, 'TimeoutError')，错误里带着
   * 已收 / 总大小（界面能说「② 下载模型超时（已收 2.9MB / 5.6MB）」）。
   */
  async downloadWithProgress(url, {
    stage = 'model',
    timeoutMs = DOWNLOAD_STALL_TIMEOUT_MS,
    onProgress = null,
  } = {}) {
    const fetcher = this.fetchModel || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!fetcher) throw new PoseLoadError(stage, 'FetchMissing', 'fetch is not available', { retryable: false });
    let res;
    try {
      res = await fetcher(url);
    } catch (err) {
      // 服务器还没起来时 fetch 直接抛 TypeError（Failed to fetch）—— 这是最该重试的一类
      throw asLoadError(stage, err, { retryable: true });
    }
    // 测试 / 特殊环境可以直接给字节（不必造一个 Response）
    if (typeof ArrayBuffer !== 'undefined'
      && (res instanceof ArrayBuffer || ArrayBuffer.isView(res))) {
      const bytes = res instanceof ArrayBuffer
        ? new Uint8Array(res)
        : new Uint8Array(res.buffer, res.byteOffset, res.byteLength);
      if (!bytes.byteLength) {
        throw new PoseLoadError(stage, 'EmptyModel', 'empty response', { retryable: true });
      }
      if (onProgress) {
        onProgress({ stage, loaded: bytes.byteLength, total: bytes.byteLength, bps: 0, done: true });
      }
      return bytes;
    }
    if (res && res.ok === false) {
      throw new PoseLoadError(stage, 'HttpError', `HTTP ${res.status || 'error'}`, {
        retryable: true,
        status: Number(res.status) || 0,
      });
    }
    const headerTotal = Number(res && res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('content-length')
      : 0) || 0;
    const body = res && res.body;
    if (!body || typeof body.getReader !== 'function') {
      // 没有流式 body（老浏览器 / 桩）：退回一次性读取，进度只有 0 → 100
      let buffer;
      try {
        buffer = await res.arrayBuffer();
      } catch (err) {
        throw asLoadError(stage, err, { retryable: true });
      }
      const bytes = new Uint8Array(buffer);
      if (!bytes.byteLength) throw new PoseLoadError(stage, 'EmptyModel', 'empty response', { retryable: true });
      if (onProgress) {
        onProgress({
          stage, loaded: bytes.byteLength, total: headerTotal || bytes.byteLength, bps: 0, done: true,
        });
      }
      return bytes;
    }

    const reader = body.getReader();
    const chunks = [];
    let loaded = 0;
    const startedAt = this.now();
    const emit = (done = false) => {
      if (!onProgress) return;
      const sec = Math.max(0.001, (this.now() - startedAt) / 1000);
      onProgress({
        stage, loaded, total: headerTotal, bps: loaded / sec, done,
      });
    };
    emit(false);
    for (;;) {
      const ms = Math.max(1, Number(timeoutMs) || DOWNLOAD_STALL_TIMEOUT_MS);
      let step;
      try {
        // eslint-disable-next-line no-await-in-loop
        step = await raceTimeout(reader.read(), ms, () => new PoseLoadError(
          stage,
          'TimeoutError',
          `no data for ${Math.round(ms / 1000)}s`,
          {
            retryable: true,
            seconds: Math.round(ms / 1000),
            loaded,
            total: headerTotal,
          },
        ));
      } catch (err) {
        try { if (typeof reader.cancel === 'function') await reader.cancel(); } catch { /* ignore */ }
        throw err;
      }
      if (!step || step.done) break;
      const value = step.value;
      if (value && value.byteLength) {
        chunks.push(value);
        loaded += value.byteLength;
        emit(false);
      }
    }
    try { if (typeof reader.releaseLock === 'function') reader.releaseLock(); } catch { /* ignore */ }
    if (!loaded) throw new PoseLoadError(stage, 'EmptyModel', 'empty response', { retryable: true });
    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    emit(true);
    return bytes;
  }

  /** ② 下载模型（流式 + 进度；字节直接喂 createFromOptions） */
  async downloadModel(url, { onProgress = null, timeoutMs = DOWNLOAD_STALL_TIMEOUT_MS } = {}) {
    return this.downloadWithProgress(url, { stage: 'model', timeoutMs, onProgress });
  }

  /**
   * ③ 创建推理器（默认 45s 上限；GPU 只给 6s）→ ④ 有视频就立刻跑一帧（带超时），确认这条 delegate 真能用。
   *
   * **超时也是失败**：`createFromOptions` 会**卡住**（用户实测 GPU 建 WebGL 上下文时既不 resolve
   * 也不 reject），所以这里用 raceTimeout —— 到点就当 GPU 不行，调用方会立刻换 CPU。
   * 每一步都带 `elapsedMs` / `timeoutMs` / `delegate` / `conservative`，界面与诊断日志能说清
   * 「哪个 delegate、等了多久、卡在哪一步」。
   */
  async createAndCheck(assets, delegate, video, firstDetectTimeoutMs, initTimeoutMs = INIT_TIMEOUT_MS, {
    fileset = null, attempt = 1, conservative = false,
  } = {}) {
    let landmarker = null;
    const vision = fileset || assets.vision;
    const ms = Math.max(1, Number(initTimeoutMs) || INIT_TIMEOUT_MS);
    const startedAt = Number(this.now()) || 0;
    const elapsed = () => Math.max(0, Math.round((Number(this.now()) || 0) - startedAt));
    try {
      landmarker = await raceTimeout(
        Promise.resolve().then(() => this.createLandmarker(vision, {
          baseOptions: { modelAssetBuffer: assets.bytes, delegate },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputSegmentationMasks: false,
        })),
        ms,
        () => new PoseLoadError('create', 'TimeoutError', `timeout after ${Math.round(ms / 1000)}s`, {
          delegate, retryable: false, seconds: Math.round(ms / 1000),
          timeoutMs: ms, elapsedMs: ms, conservative, attempt,
        }),
      );
    } catch (err) {
      // WebGL 建不起来 / 驱动不支持：重试没用，交给调用方换 CPU。
      // wasm 编译类错误（ModuleFactory / abort(CompileError) / WebAssembly）算「wasm 阶段」，提示更准确。
      const reason = String((err && (err.reason || err.message)) || '');
      const stage = /wasm|modulefactory|webassembly|abort\s*\(/i.test(reason) ? 'wasm' : 'create';
      throw asLoadError(stage, err, {
        delegate,
        retryable: false,
        timeoutMs: ms,
        elapsedMs: Number.isFinite(Number(err && err.elapsedMs)) && err.elapsedMs ? err.elapsedMs : elapsed(),
        conservative,
        attempt,
      });
    }
    if (!landmarker) {
      throw new PoseLoadError('create', 'NoLandmarker', 'createFromOptions returned nothing', {
        delegate, retryable: false, timeoutMs: ms, elapsedMs: elapsed(), conservative, attempt,
      });
    }
    if (video && Number(video.readyState || 0) >= 2) {
      const detectMs = Math.max(1, Number(firstDetectTimeoutMs) || FIRST_DETECT_TIMEOUT_MS);
      try {
        await this.firstFrame(landmarker, video, detectMs);
      } catch (err) {
        try { if (typeof landmarker.close === 'function') landmarker.close(); } catch { /* ignore */ }
        throw asLoadError('detect', err, {
          delegate,
          retryable: false,
          timeoutMs: detectMs,
          elapsedMs: elapsed(),
          conservative,
          attempt,
        });
      }
    }
    return landmarker;
  }

  /** ④ 首帧推理：默认 8s 超时，超时就算这条 delegate 不可用（换 CPU 再试） */
  async firstFrame(landmarker, video, timeoutMs = FIRST_DETECT_TIMEOUT_MS) {
    const ts = Math.max(0, Math.round(this.now()));
    const ms = Math.max(1, Number(timeoutMs) || FIRST_DETECT_TIMEOUT_MS);
    const run = Promise.resolve().then(() => landmarker.detectForVideo(video, ts));
    const res = await raceTimeout(run, ms, () => new PoseLoadError(
      'detect',
      'TimeoutError',
      `timeout after ${Math.round(ms / 1000)}s`,
      { retryable: false, seconds: Math.round(ms / 1000) },
    ));
    this._lastTs = Math.max(this._lastTs, ts);
    return res;
  }

  /** @returns {{landmarks:Array, worldLandmarks:Array|null}|null} */
  detect(video, tsMs) {
    if (!this.landmarker || !video || video.readyState < 2) return null;
    if (tsMs <= this._lastTs) tsMs = this._lastTs + 1; // 时间戳必须递增
    this._lastTs = tsMs;
    let res;
    try {
      res = this.landmarker.detectForVideo(video, tsMs);
    } catch (err) {
      console.warn('[pose] inference failed:', err?.message || err);
      return null;
    }
    if (!res || !res.landmarks || !res.landmarks.length) return null;
    return {
      landmarks: res.landmarks[0],
      worldLandmarks: (res.worldLandmarks && res.worldLandmarks[0]) || null,
    };
  }

  close() {
    try { this.landmarker?.close(); } catch { /* ignore */ }
    this.landmarker = null;
    this.delegate = null;
    this.modelKey = null;
    this._lastTs = -1;
  }
}

/** 摄像头管理：授权、枚举、切换 */

/**
 * 一次 `getUserMedia` 的约束（纯函数，测试直接断言）。
 *
 * - 指定了 `deviceId` → 精确要那一个镜头（用户在工具栏「镜头」里选过的）；
 * - 否则用 `facingMode`（`user` 前置 / `environment` 后置）——手机默认前置；
 * - `tier === 'low'`（手机 / 低配）时把理想分辨率降到 960×540、24fps：
 *   720p 对手机浏览器来说解码 + 推理都更吃力，降一档更稳（识别精度几乎不受影响）。
 */
export function cameraConstraintsFor({ deviceId = null, facing = 'user', tier = 'high' } = {}) {
  const low = tier === 'low';
  const size = {
    width: { ideal: low ? 960 : 1280 },
    height: { ideal: low ? 540 : 720 },
    frameRate: { ideal: low ? 24 : 30 },
  };
  if (deviceId) return { audio: false, video: { deviceId: { exact: deviceId }, ...size } };
  if (facing && facing !== 'auto') return { audio: false, video: { facingMode: facing, ...size } };
  return { audio: false, video: { ...size } };
}

/**
 * 「优雅回退」的尝试顺序（纯函数）。
 *
 * 手机上的摄像头千奇百怪（没有后置、后置被占用、镜头 id 换了），所以一次失败就换下一个方案，
 * 而不是直接报错：
 *   ① 用户明确选过的镜头（deviceId）
 *   ② 用户选的前 / 后置（facingMode）
 *   ③ 后置失败 → 退回前置（绝大多数设备一定有前置）
 *   ④ 最后兜底：什么条件都不加，只要能出画面
 */
export function cameraAttemptsFor({ deviceId = null, facing = 'user', tier = 'high' } = {}) {
  const attempts = [];
  if (deviceId) attempts.push(cameraConstraintsFor({ deviceId, tier }));
  if (facing && facing !== 'auto') attempts.push(cameraConstraintsFor({ facing, tier }));
  if (facing === 'environment') attempts.push(cameraConstraintsFor({ facing: 'user', tier }));
  attempts.push({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
  return attempts;
}

/**
 * 这个错误值不值得换下一个方案重试（纯函数）。
 * **权限被拒（NotAllowedError）不重试** —— 重试只会再弹一次权限框，用户更烦。
 */
export function shouldRetryCamera(errName = '') {
  return ['OverconstrainedError', 'ConstraintNotSatisfiedError', 'NotFoundError',
    'DevicesNotFoundError', 'TypeError'].includes(errName);
}

/**
 * 「开始体感训练」那一下要**一并申请麦克风权限**（用户要求：不要等按 Ctrl+I 才弹）。
 *
 * 做法是给**第一条**摄像头约束加上 `audio: true`，让浏览器只弹**一次**「摄像头 + 麦克风」
 * 组合授权框；拿到流之后 `Camera.start()` 会立刻把音轨 stop 掉（见 `stopAudioTracks`）——
 * 我们只要**权限**，不长期占用麦克风（否则会和 `SpeechRecognition` 抢麦）。
 *
 * 纯函数：返回新的约束，不改传进来的对象；**只有首页那条「开始训练」路径**会用它。
 */
export function cameraWithMic(constraints = {}) {
  return { ...constraints, audio: true };
}

/**
 * 把流里的音轨全部停掉（只要权限，不要占用）。视频轨不动。
 * 返回停掉的音轨数，方便测试与诊断；浏览器没给音轨 / 拿不到轨道时返回 0，
 * **任何异常都吞掉** —— 麦克风这边怎么坏都不能影响摄像头与训练。
 */
export function stopAudioTracks(stream) {
  let tracks = [];
  try {
    tracks = typeof stream?.getAudioTracks === 'function'
      ? stream.getAudioTracks()
      : (typeof stream?.getTracks === 'function'
        ? stream.getTracks().filter((track) => track?.kind === 'audio')
        : []);
  } catch { tracks = []; }
  for (const track of tracks) {
    try { track.stop(); } catch { /* 停不掉也不能影响训练 */ }
  }
  return tracks.length;
}

export class Camera {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.deviceId = null;
    this.facing = 'user';
  }

  get active() { return !!this.stream && this.video.readyState >= 2; }
  get aspect() {
    const w = this.video.videoWidth || 16;
    const h = this.video.videoHeight || 9;
    return w / h;
  }

  static supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async list() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  /**
   * @param {string|null} deviceId 指定镜头（工具栏「镜头」选的）
   * @param {{facing?:'user'|'environment'|'auto', tier?:'low'|'high', mic?:boolean}} opts
   *   一个方案失败就按 cameraAttemptsFor 的顺序换下一个；权限被拒则立刻抛出（不重试）。
   *   `mic: true`（**只在首页「开始体感训练」那一下**）→ 第一条约束带 `audio: true`，
   *   和摄像头只弹一次组合授权框；拿到流后立刻停掉音轨，只留权限。
   */
  async start(deviceId = null, { facing = 'user', tier = 'high', mic = false } = {}) {
    this.stop();
    const baseAttempts = cameraAttemptsFor({ deviceId, facing, tier });
    /**
     * 带麦克风时**只在最前面多试一次**：组合请求（video + audio）→ 同一条约束的纯视频版。
     * 后面仍是原来的降级链（后置 → 前置 → 无条件），语义不变。
     *
     * 组合请求失败**一律**降级重试纯视频（不管错误名是 NotAllowedError 还是 NotFoundError）：
     * 麦克风 / 蓝牙耳机 / 用户只拒了 audio 都不能拖累摄像头。用户如果连摄像头也拒了，
     * 这个纯视频重试会被浏览器立刻拒绝（不会弹第二次框），随后按「权限被拒不重试」停手。
     */
    const attempts = mic ? [cameraWithMic(baseAttempts[0]), ...baseAttempts] : baseAttempts;
    let lastErr = null;
    for (let i = 0; i < attempts.length; i += 1) {
      const constraints = attempts[i];
      try {
        // eslint-disable-next-line no-await-in-loop
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (constraints.audio) {
          // 拿到授权就够了：立刻释放麦克风，避免和 Ctrl+I 的 SpeechRecognition 抢麦
          stopAudioTracks(stream);
        }
        this.stream = stream;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (constraints.audio) {
          console.warn('[camera] camera+mic request failed, retrying camera only:', err?.name || err);
          continue;   // 下一轮就是同一条约束的「只请求摄像头」版本
        }
        if (!shouldRetryCamera(err?.name) || i === attempts.length - 1) break;
        console.warn('[camera] constraint attempt failed, trying the next one:', err?.name || err);
      }
    }
    if (lastErr) throw lastErr;
    this.video.srcObject = this.stream;
    await this.video.play();
    await new Promise((resolve) => {
      if (this.video.videoWidth) return resolve();
      this.video.onloadedmetadata = () => resolve();
    });
    const track = this.stream.getVideoTracks()[0];
    this.deviceId = track?.getSettings?.().deviceId || deviceId || null;
    // 实际生效的朝向（手机上浏览器可能自己纠正），用来同步设置里的下拉
    this.facing = track?.getSettings?.().facingMode || facing || 'user';
    return this.stream;
  }

  stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    this.stream = null;
  }
}
