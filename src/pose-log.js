/**
 * 调试数据记录（用户要求：「请在我测试的时候记录下关节点和一些关键数据……在运动设置里面增加一个
 * 『记录调试数据』的开关项，只要打开了，就把运动的关节数据按照一定的格式写在一个 log 文件里面」）。
 *
 * 为什么做成「攒一批 → POST 给本地预览服务器」而不是直接写文件：
 * **浏览器不许网页写本地文件**。所以这里走两条路，都用得上：
 *   1. 主路：把采样攒成批，POST 到 `preview-server.js` 的 `/__debug/log?file=…`，
 *      由服务端**追加**写进项目里的 `logs/xxx.jsonl` —— 用户测完，文件就在项目目录里，直接能分析；
 *   2. 兜底：`download()` 把已经记下的内容做成 `.jsonl` 让浏览器下载（没有服务器时也能拿到数据）。
 *
 * 文件格式：**JSONL**（一行一个 JSON），第一行是 `meta`，之后每帧一行 `frame`，
 * 计次 / 提示 / 会话切换各一行事件。写进去的东西是「够我复现判定」的最小集合：
 *   - `lm`：33 个关节点 × [x, y, z, 可见度]（原始归一化坐标，未平滑的那一份也带上）；
 *   - `m`：这一帧算出来的**所有**指标（角度 / 离地高度 / 躯干长 …）；
 *   - `d`：识别器内部状态（阶段、进度、本轮峰值、计次线、回退线、上一次没计上的原因 …）；
 *   - `bar`：进度条当前点亮到第几格（「链走完」与「计上」是不是同一帧，看它最快）。
 */
import { LM } from './geometry.js';
import { SIDE_METRICS } from './engines.js';

/** 采样打包发给服务端的节奏 */
const FLUSH_MS = 1500;
const FLUSH_ROWS = 400;
/** 内存里最多留多少行（防止长时间测试把页面撑爆） */
const MAX_BUFFER = 60_000;
/**
 * 识别器上要记下来的内部字段（**白名单**）。
 *
 * 各动作的识别器字段不一样（通用引擎有 `effUp/looseP`，手写识别器有 `countElbow/backLine`…），
 * 所以这里按名字捞：有就记、没有就跳过 —— 于是日志里永远包含「这个动作真正用的那条线」。
 */
const DET_FIELDS = [
  // 通用引擎
  'stage', 'phase', 'progress', 'peak', 'depthPct', 'active', 'gateOk', 'metricName',
  'up', 'down', 'enterP', 'bottomP', 'backP', 'looseP', 'ignoreP', 'minRepMs', 'effUp',
  'flightSeen', 'lift',
  // 左右交替类（勾腿跳 / 登山者 / 死虫式）：两条腿的判定线与第二路证据的基线
  'anyKicked', 'switched', 'cmp', 'onValue', 'offValue', 'leadMin',
  'altMetric', 'altDip', 'altKneeDip', 'altLeadMin', 'altBase', 'sideOn', 'wasDeep', 'tiePair',
  // 深蹲 / 箭步蹲
  'standLine', 'exitLine', 'bothLine', 'enterLine', 'minRatio', 'repMin',
  // 俯卧撑（旧手写识别器已删，这里留着兼容历史日志）
  'countElbow', 'backLine', 'topLine', 'drop', 'minElbow',
  // 臀桥 / 平板
  'atBottom', 'topLine2',
  // 卷腹
  'torsoShrink', 'headUp', 'curlLine', 'shrinkLine', 'lying',
  // 跳箱
  'boxLine', 'boxCleared', 'landed', 'crouchPct', 'peakLift', 'lastJump', 'box',
  // 计时类
  'holdMs', 'holding', 'okMs',
  // 次数
  'validReps', 'partialReps', 'cycle', 'score',
];

/**
 * 左右交替类的「两条腿各自的读数」：日志里必须把这两个数记下来 ——
 * 勾腿跳「计不上」时，光看判定线是查不出来的，得看**两条腿当时各是多少**。
 */
const SIDE_FIELDS = (det, frame) => {
  if (!det || !det.altMetric) return null;
  const read = SIDE_METRICS[det.metricName] || SIDE_METRICS.knee;
  const readAlt = SIDE_METRICS[det.altMetric];
  const out = {};
  for (const s of ['L', 'R']) {
    const m = read(frame, s);
    const a = readAlt ? readAlt(frame, s) : NaN;
    out[s] = {
      v: num(m, 2),
      alt: num(a, 3),
      base: num(det.altBase ? det.altBase[s] : NaN, 3),
    };
  }
  return out;
};

/** 帧上要记下来的指标字段（全部：诊断时最怕「当时没记下来」） */
const SKIP_FRAME_KEYS = new Set(['points', 'perSide', 't']);

const num = (v, d = 4) => (Number.isFinite(v) ? Number(Number(v).toFixed(d)) : null);

function roundPoint(p) {
  if (!p) return null;
  return [num(p.x), num(p.y), num(p.z), num(p.visibility ?? p.v, 2)];
}

/** 识别器 → 一行可读的状态（只挑白名单里的字段，值做过长度限制） */
function detState(det) {
  if (!det) return null;
  const out = {};
  for (const k of DET_FIELDS) {
    const v = det[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'number') out[k] = num(v, 3);
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 24);
    else if (typeof v === 'object') {
      // 小对象（跳箱的箱子几何 / 上一次跳跃的结果 / 挂起的那一对腿）：只抄几个关键字段
      const small = {};
      for (const [kk, vv] of Object.entries(v)) {
        if (typeof vv === 'number') small[kk] = num(vv, 3);
        else if (typeof vv === 'boolean' || typeof vv === 'string') small[kk] = typeof vv === 'string' ? vv.slice(0, 16) : vv;
        if (Object.keys(small).length >= 6) break;
      }
      if (Object.keys(small).length) out[k] = small;
    }
  }
  if (det.lastReject) out.reject = `${det.lastReject.code}${det.lastReject.value ? ':' + det.lastReject.value : ''}`;
  return out;
}

/** 帧指标（去掉 points / perSide 这种大块对象，其余全带上） */
function frameMetrics(f) {
  if (!f) return null;
  const out = { ok: !!f.ok };
  for (const [k, v] of Object.entries(f)) {
    if (SKIP_FRAME_KEYS.has(k)) continue;
    if (typeof v === 'number') out[k] = num(v, 4);
    else if (typeof v === 'boolean' || typeof v === 'string') out[k] = v;
  }
  return out;
}

/** 本地时间戳（文件名与行里都用它，方便和用户的操作对上） */
function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class PoseLogger {
  /**
   * @param {object} o
   *   post  发一批数据的函数（默认 POST 到本地预览服务器）
   *   now   取当前时间（测试里可注入）
   */
  constructor({ post = null, now = () => Date.now() } = {}) {
    this.now = now;
    this.post = post || (async (file, body) => {
      if (typeof fetch !== 'function') throw new Error('no fetch');
      const r = await fetch(`/__debug/log?file=${encodeURIComponent(file)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body,
        keepalive: true,
      });
      if (!r || !r.ok) throw new Error(`http ${r && r.status}`);
      return r;
    });
    this.reset();
  }

  reset() {
    this.active = false;
    this.file = '';
    this.rows = [];          // 还没发出去的批次
    this.all = [];           // 已经记下来的全部（给「下载」兜底用）
    this.frames = 0;
    this.bytes = 0;
    this.error = '';
    this._lastFlush = 0;
    this._inflight = false;
  }

  /** 打开记录（用户刚勾上开关，或者页面带着开关启动）：开一个新文件 */
  start(meta = {}) {
    this.reset();
    this.active = true;
    const ex = meta.exerciseId || 'x';
    this.file = `pose-${ex}-${stamp(new Date(this.now()))}.jsonl`;
    this._write({ k: 'meta', v: 1, at: this.now(), ...meta });
    return this.file;
  }

  stop(reason = 'off') {
    if (!this.active) return null;
    this._write({ k: 'end', at: this.now(), reason, frames: this.frames, file: this.file });
    this.active = false;
    this.flush({ force: true });
    return this.file;
  }

  /** 记一帧（原始关键点 + 平滑后的指标 + 识别器状态 + 进度条进度 + 左右两条腿各自的读数） */
  frame({ t, exerciseId, session, landmarks, smoothed, frame, det, barIndex, barTotal }) {
    if (!this.active) return;
    this.frames += 1;
    this._write({
      k: 'f',
      t: Number(this.now()),
      ex: exerciseId,
      s: session,
      lm: landmarks ? landmarks.map(roundPoint) : null,
      sm: smoothed ? smoothed.map(roundPoint) : null,
      m: frameMetrics(frame),
      d: detState(det),
      sides: frame ? SIDE_FIELDS(det, frame) : null,
      bar: Number.isFinite(barIndex) ? [barIndex, barTotal] : null,
    });
  }

  /** 记一个事件（计次 / 提示 / 要领 / 会话切换 / 校准） */
  event(kind, data = {}) {
    if (!this.active) return;
    this._write({ k: kind, t: Number(this.now()), ...data });
  }

  _write(obj) {
    let line;
    try {
      line = `${JSON.stringify(obj)}\n`;
    } catch {
      return;   // 有循环引用就丢掉这一行，别让它把记录搞崩
    }
    this.rows.push(line);
    this.all.push(line);
    this.bytes += line.length;
    if (this.all.length > MAX_BUFFER) {
      // 内存兜底：只保留最近的一半（下载兜底会少一点，但不会把页面撑爆）
      this.all = this.all.slice(-Math.floor(MAX_BUFFER / 2));
    }
    const due = this.rows.length >= FLUSH_ROWS
      || this.now() - this._lastFlush >= FLUSH_MS;
    if (due) this.flush();
  }

  /** 把攒下来的行发给本地服务器（失败就留着，下次再发） */
  flush({ force = false } = {}) {
    if (!this.rows.length || this._inflight) {
      // 正在发：记一笔「发完再补一次」，否则这次要发的东西会一直留在缓冲里
      //（关掉开关、点「保存/下载」时都要求数据立刻落盘）
      if (this.rows.length && this._inflight) this._again = true;
      return;
    }
    if (!force && this.now() - this._lastFlush < FLUSH_MS) return;
    const body = this.rows.join('');
    this.rows = [];
    this._lastFlush = this.now();
    this._inflight = true;
    this._again = false;
    Promise.resolve(this.post(this.file, body))
      .then(() => { this.error = ''; })
      .catch((err) => {
        // 发不出去就退回去重试（同时记下原因，界面上会显示）
        this.error = String(err && err.message || err);
        this.rows = [body, ...this.rows];
      })
      .finally(() => {
        this._inflight = false;
        if (this._again || (this.rows.length && this.now() - this._lastFlush >= FLUSH_MS)) {
          this._again = false;
          this.flush({ force: true });
        }
      });
  }

  /** 兜底：把已经记下的内容做成文件让浏览器下载（没有预览服务器时也能拿到数据） */
  download() {
    const text = this.all.join('');
    if (!text) return null;
    const name = this.file || `pose-${stamp(new Date(this.now()))}.jsonl`;
    try {
      const blob = new Blob([text], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 4000);
      return name;
    } catch {
      return null;
    }
  }

  /** 界面上显示的状态（模态里那一行） */
  status() {
    return {
      active: this.active,
      file: this.file,
      frames: this.frames,
      bytes: this.bytes,
      pending: this.all.length,
      error: this.error,
    };
  }
}

/** 33 个关节点的名字（日志里只用索引，这里留一份对照表给分析时用） */
export const LANDMARK_NAMES = Object.keys(LM);

export default PoseLogger;
