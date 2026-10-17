/**
 * MediaPipe PoseLandmarker 封装。
 * 模型与 wasm 全部走本地 vendor 目录，断网也能跑，画面不出本机。
 */

import { FilesetResolver, PoseLandmarker } from '../vendor/tasks-vision/vision_bundle.mjs';

// 模型文件路径（界面上的模型名称走 i18n：ui.modelLite / ui.modelFull）
export const MODELS = {
  lite: { url: './vendor/models/pose_landmarker_lite.task' },
  full: { url: './vendor/models/pose_landmarker_full.task' },
};

export const WASM_DIR = './vendor/tasks-vision/wasm';

export class PoseEngine {
  constructor() {
    this.landmarker = null;
    this.delegate = null;
    this.modelKey = null;
    this._lastTs = -1;
    this._vision = null;
  }

  get ready() { return !!this.landmarker; }

  /**
   * @param {object} o
   *   modelKey 'lite' | 'full'
   *   onStatus (text) => void
   */
  async init({ modelKey = 'lite', onStatus = () => {} } = {}) {
    if (this.landmarker && this.modelKey === modelKey) return this;
    this.close();

    onStatus('Loading pose model…');
    this._vision = this._vision || await FilesetResolver.forVisionTasks(WASM_DIR);
    const modelUrl = (MODELS[modelKey] || MODELS.lite).url;

    const create = (delegate) => PoseLandmarker.createFromOptions(this._vision, {
      baseOptions: { modelAssetPath: modelUrl, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    });

    let lm;
    try {
      lm = await create('GPU');
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('[pose] GPU delegate unavailable, falling back to CPU:', err?.message || err);
      onStatus('GPU unavailable, using CPU inference…');
      lm = await create('CPU');
      this.delegate = 'CPU';
    }
    this.landmarker = lm;
    this.modelKey = modelKey;
    onStatus(`Model ready (${this.delegate})`);
    return this;
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
   * @param {{facing?:'user'|'environment'|'auto', tier?:'low'|'high'}} opts
   *   一个方案失败就按 cameraAttemptsFor 的顺序换下一个；权限被拒则立刻抛出（不重试）
   */
  async start(deviceId = null, { facing = 'user', tier = 'high' } = {}) {
    this.stop();
    const attempts = cameraAttemptsFor({ deviceId, facing, tier });
    let lastErr = null;
    for (let i = 0; i < attempts.length; i += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        this.stream = await navigator.mediaDevices.getUserMedia(attempts[i]);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
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
