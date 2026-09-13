/**
 * MediaPipe PoseLandmarker 封装。
 * 模型与 wasm 全部走本地 vendor 目录，断网也能跑，画面不出本机。
 */

import { FilesetResolver, PoseLandmarker } from '../vendor/tasks-vision/vision_bundle.mjs';

export const MODELS = {
  lite: { label: '轻量（流畅，推荐）', url: './vendor/models/pose_landmarker_lite.task' },
  full: { label: '完整（更准，吃性能）', url: './vendor/models/pose_landmarker_full.task' },
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

    onStatus('正在加载姿态模型…');
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
      console.warn('[pose] GPU 不可用，回退 CPU：', err?.message || err);
      onStatus('GPU 不可用，改用 CPU 推理…');
      lm = await create('CPU');
      this.delegate = 'CPU';
    }
    this.landmarker = lm;
    this.modelKey = modelKey;
    onStatus(`模型就绪（${this.delegate}）`);
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
      console.warn('[pose] 推理失败：', err?.message || err);
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
export class Camera {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.deviceId = null;
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

  async start(deviceId = null) {
    this.stop();
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
        : { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    await this.video.play();
    await new Promise((resolve) => {
      if (this.video.videoWidth) return resolve();
      this.video.onloadedmetadata = () => resolve();
    });
    this.deviceId = this.stream.getVideoTracks()[0]?.getSettings?.().deviceId || deviceId || null;
    return this.stream;
  }

  stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    this.stream = null;
  }
}
