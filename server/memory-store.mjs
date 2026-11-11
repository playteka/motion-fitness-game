/**
 * 教练记忆的**长期层**（服务端 Markdown 文件）。
 *
 *   server/memory/<userId>.md       一个用户一个文件（**gitignore 掉**：里面有个人信息）
 *
 * 设计约束（改这个文件之前先读）：
 *   ① **安全第一**：userId 必须匹配 `^[a-zA-Z0-9_-]{1,32}$`（防路径穿越），
 *      文件名只由这个 id 拼出来；写之前再 `path.resolve()` 复核一次，绝不允许跑出 memory 目录。
 *   ② **白名单**：只有 `prefs` / `facts` 两组字段能写（取值 / 范围都校验），其它一律拒绝。
 *      `facts` 是「用户主动说的事实」—— 工具层必须带 `evidence`（用户原话片段），
 *      这里把它存进 MD 的 `> 来源：` 行，用户能在「教练记得什么」里审查。
 *   ③ **训练摘要 / 上次未完成**：由客户端算好后同步上来（不是模型写的），同样要校验形状。
 *   ④ **原子替换**：先写 `<file>.tmp-*` 再 `rename`，绝不让进程死在半路留下半个 MD。
 *   ⑤ **手改也容忍**：解析失败不崩 —— 备份成 `.bad`，按空记忆处理；超过 64KB 同样处理。
 *   ⑥ 这个文件**不碰网络、不引依赖**，Node 里直接跑（tests/test-voice.mjs 用临时目录测）。
 *
 * MD 格式（人类可读 + 机器可解析，二级标题分节）：
 *
 *   # 教练记忆 — <userId>
 *
 *   ## 偏好 (prefs)
 *   - tone: warm
 *
 *   ## 事实 (facts)
 *   - goal: 减脂
 *     > 来源：2026-11-11 我说想减脂
 *
 *   ## 训练摘要（最近 20 次，最新在前）
 *   | 日期 | 动作 | 目标 | 实际 | 分数 |
 *   |---|---|---|---|---|
 *   | 2026-11-11 17:30 | 自重深蹲 | 20 | 20 | 61 |
 *
 *   ## 上次未完成
 *   - 2026-11-11 17:30 自重深蹲 第 2 组（12/20）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');

/** 默认目录（`server/memory/`，**已 gitignore**；测试可以传别的 dir） */
export const MEMORY_DIR = path.join(ROOT, 'server', 'memory');

/** 一个 MD 最多 64KB（再大就不是记忆了；读 / 写都拦） */
export const MEMORY_MAX_BYTES = 64 * 1024;

/** userId 白名单：只允许这几类字符，长度 1~32（**路径穿越在字符层面就不可能**） */
export const USER_ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;

/** 没指定 userId 时用哪个（前端首次打开会生成随机 id，并允许在设置里改 / 重置） */
export const DEFAULT_USER_ID = 'default';

/** 训练摘要最多存多少条（用户口径：最近 20 次，最新在前） */
export const MEMORY_SUMMARY_MAX = 20;

/** 偏好字段白名单（key → 校验规则） */
export const PREFS_SPEC = Object.freeze({
  tone: Object.freeze({ type: 'enum', values: Object.freeze(['warm', 'strict', 'funny']) }),
  difficulty: Object.freeze({ type: 'enum', values: Object.freeze(['easy', 'normal', 'hard']) }),
  sessionMinutes: Object.freeze({ type: 'int', min: 5, max: 60 }),
  restSec: Object.freeze({ type: 'int', min: 0, max: 180 }),
  voiceSource: Object.freeze({ type: 'enum', values: Object.freeze(['auto', 'volc', 'system']) }),
  /** 教练声音性别（默认 female；male 用 `zh_male_taocheng_uranus_bigtts`，见 volc-tts.mjs） */
  voiceGender: Object.freeze({ type: 'enum', values: Object.freeze(['female', 'male']) }),
  rate: Object.freeze({ type: 'number', min: 0.8, max: 1.3 }),
});

/** 事实字段白名单（只能由用户主动说；写入必须带 evidence） */
export const FACTS_SPEC = Object.freeze({
  goal: Object.freeze({ type: 'enum', values: Object.freeze(['减脂', '增肌', '保持', '增强体能']) }),
  injuries: Object.freeze({ type: 'string-array', maxItems: 5, maxLen: 20 }),
  weeklyGoal: Object.freeze({ type: 'int', min: 1, max: 7 }),
});

export const PREFS_FIELDS = Object.freeze(Object.keys(PREFS_SPEC));
export const FACTS_FIELDS = Object.freeze(Object.keys(FACTS_SPEC));
export const MEMORY_FIELDS = Object.freeze([...PREFS_FIELDS, ...FACTS_FIELDS]);

/** 稳定错误码（路由据此回 4xx + 明确原因；**不抛裸 Error**） */
export class MemoryError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.name = 'MemoryError';
    this.code = String(code || 'memory-error');
    this.field = detail.field ? String(detail.field) : '';
    this.reason = detail.reason ? String(detail.reason) : '';
  }
}

/** 校验并归一化 userId；不合法直接抛 `bad-user`（绝不返回一个能拼出路径的值） */
export function normalizeUserId(value) {
  const id = String(value == null ? '' : value).trim();
  if (!USER_ID_RE.test(id)) throw new MemoryError('bad-user');
  return id;
}

/** 本地时间 `YYYY-MM-DD HH:mm`（MD 里给人看的；测试也用这个函数算期望值） */
export function formatMemoryStamp(ms = Date.now()) {
  const d = new Date(Number(ms) || Date.now());
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 空记忆（解析失败 / 文件不存在 / 参数非法时的兜底形状，字段永远齐全） */
export function emptyMemory(userId = DEFAULT_USER_ID) {
  return {
    user: userId,
    prefs: {},
    facts: {},
    sources: {},
    summaries: [],
    lastUnfinished: null,
    updatedAt: null,
  };
}

/** userId → MD 绝对路径（再做一次目录复核，双保险） */
export function memoryFilePath(userId, dir = MEMORY_DIR) {
  const id = normalizeUserId(userId);
  const base = path.resolve(String(dir || MEMORY_DIR));
  const file = path.resolve(base, `${id}.md`);
  if (file !== path.join(base, `${id}.md`) || !file.startsWith(`${base}${path.sep}`)) {
    throw new MemoryError('bad-user');
  }
  return file;
}

/* ------------------------------------------------------------------ *
 * 取值校验
 * ------------------------------------------------------------------ */

/**
 * 把一个字段值按白名单规则归一化。
 * @returns {{ok:true, value:any}|{ok:false, reason:string}}
 */
export function normalizeFieldValue(section, field, raw) {
  const spec = (section === 'facts' ? FACTS_SPEC : PREFS_SPEC)[field];
  if (!spec) return { ok: false, reason: 'bad-field' };
  if (spec.type === 'enum') {
    const s = String(raw == null ? '' : raw).trim();
    if (!spec.values.includes(s)) return { ok: false, reason: 'bad-value' };
    return { ok: true, value: s };
  }
  if (spec.type === 'int' || spec.type === 'number') {
    if (raw === '' || raw === null || raw === undefined) return { ok: false, reason: 'bad-value' };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, reason: 'bad-value' };
    if (spec.type === 'int' && !Number.isInteger(n)) return { ok: false, reason: 'bad-value' };
    if (n < spec.min || n > spec.max) return { ok: false, reason: 'out-of-range' };
    return { ok: true, value: spec.type === 'int' ? n : Math.round(n * 100) / 100 };
  }
  if (spec.type === 'string-array') {
    const list = Array.isArray(raw)
      ? raw
      : String(raw == null ? '' : raw).split(/[,，、;；]/);
    const out = [];
    for (const item of list) {
      const s = String(item == null ? '' : item).trim();
      if (!s) continue;
      if (Array.from(s).length > spec.maxLen) return { ok: false, reason: 'too-long' };
      if (!out.includes(s)) out.push(s);
    }
    if (!out.length) return { ok: false, reason: 'bad-value' };
    if (out.length > spec.maxItems) return { ok: false, reason: 'too-many' };
    return { ok: true, value: out };
  }
  return { ok: false, reason: 'bad-field' };
}

/** facts 的 evidence（用户原话片段）：必须是非空字符串，最长 200 字 */
export function normalizeEvidence(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) throw new MemoryError('evidence-required');
  return Array.from(s).slice(0, 200).join('');
}

/** 一条训练摘要（客户端算好；这里只校验形状 + 格式化日期） */
function normalizeSummary(item, now = Date.now()) {
  const src = item && typeof item === 'object' ? item : {};
  const name = String(src.name || src.exercise || src.exerciseName || '').trim();
  if (!name) throw new MemoryError('bad-summary', { field: 'summaries', reason: 'name' });
  const at = Number(src.at);
  const stamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(src.date || ''))
    ? String(src.date)
    : formatMemoryStamp(Number.isFinite(at) && at > 0 ? at : now);
  const int = (v, min, max, fallback = 0) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };
  return {
    stamp,
    name: Array.from(name).slice(0, 30).join(''),
    target: int(src.target, 0, 999),
    reps: int(src.reps ?? src.value, 0, 999),
    score: int(src.score, 0, 100000),
  };
}

/** 「上次未完成」：{at, exerciseId?, name, set, reps, target} 或 null */
function normalizeLastUnfinished(item, now = Date.now()) {
  if (item === null || item === undefined) return null;
  const src = item && typeof item === 'object' ? item : null;
  if (!src) throw new MemoryError('bad-last-session');
  const name = String(src.name || src.exerciseName || '').trim();
  if (!name) throw new MemoryError('bad-last-session', { field: 'lastUnfinished', reason: 'name' });
  const at = Number(src.at);
  const stamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(src.date || ''))
    ? String(src.date)
    : formatMemoryStamp(Number.isFinite(at) && at > 0 ? at : now);
  const int = (v, min, max, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  const out = {
    stamp,
    exerciseId: /^[a-zA-Z0-9_-]{1,32}$/.test(String(src.exerciseId || '')) ? String(src.exerciseId) : '',
    name: Array.from(name).slice(0, 30).join(''),
    set: int(src.set, 1, 99, 1),
    reps: int(src.reps ?? src.value, 0, 999, 0),
    target: int(src.target, 0, 999, 0),
  };
  return out;
}

/* ------------------------------------------------------------------ *
 * 序列化 / 解析
 * ------------------------------------------------------------------ */

/** 记忆对象 → MD 文本（**唯一格式定义**；解析要能读回同一份） */
export function serializeMemory(memory) {
  const m = memory && typeof memory === 'object' ? memory : emptyMemory();
  const user = normalizeUserId(m.user);
  const lines = [`# 教练记忆 — ${user}`, ''];
  lines.push('## 偏好 (prefs)');
  for (const field of PREFS_FIELDS) {
    const value = m.prefs && m.prefs[field];
    if (value === undefined || value === null) continue;
    lines.push(`- ${field}: ${value}`);
  }
  lines.push('');
  lines.push('## 事实 (facts)');
  for (const field of FACTS_FIELDS) {
    const value = m.facts && m.facts[field];
    if (value === undefined || value === null) continue;
    lines.push(`- ${field}: ${Array.isArray(value) ? value.join(', ') : value}`);
    const src = m.sources && m.sources[field];
    if (src) {
      // 一行一个来源（多行会被 MD 当成列表，这里压成一行；本来就是用户原话片段）
      lines.push(`  > 来源：${String(src).replace(/\s*\n\s*/g, ' ')}`);
    }
  }
  lines.push('');
  lines.push('## 训练摘要（最近 20 次，最新在前）');
  lines.push('| 日期 | 动作 | 目标 | 实际 | 分数 |');
  lines.push('|---|---|---|---|---|');
  for (const row of Array.isArray(m.summaries) ? m.summaries.slice(0, MEMORY_SUMMARY_MAX) : []) {
    lines.push(`| ${row.stamp} | ${row.name} | ${row.target} | ${row.reps} | ${row.score} |`);
  }
  lines.push('');
  lines.push('## 上次未完成');
  const last = m.lastUnfinished;
  if (last) {
    lines.push(`- ${last.stamp} ${last.name} 第 ${last.set} 组（${last.reps}/${last.target}）`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 是不是「这看起来像一份记忆 MD」（用于判断手改坏了没有；坏文件要备份成 .bad） */
function looksLikeMemory(text) {
  return /^#\s*教练记忆/m.test(text)
    || /^##\s*(偏好|prefs|preference)/im.test(text)
    || /^##\s*(事实|facts)/im.test(text)
    || /^##\s*(训练摘要|summary|summaries)/im.test(text)
    || /^##\s*(上次未完成|unfinished|last session)/im.test(text);
}

/**
 * MD 文本 → 记忆对象（**容忍手改**：认不出的行直接忽略，不抛错）。
 * 字段值仍然过白名单 —— 手改出来的非法值不会被带进模型 context。
 */
export function parseMemoryMarkdown(text, userId = DEFAULT_USER_ID) {
  const out = emptyMemory(normalizeUserId(userId));
  const src = String(text == null ? '' : text);
  if (!src.trim()) return out;
  let section = '';
  let pendingFact = '';
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = /^##\s*(.+)$/.exec(trimmed);
    if (heading) {
      const title = heading[1].toLowerCase();
      section = /prefs|偏好|preference/.test(title) ? 'prefs'
        : (/facts|事实/.test(title) ? 'facts'
          : (/摘要|summary|summaries/.test(title) ? 'summaries'
            : (/未完成|unfinished|last session/.test(title) ? 'last' : '')));
      pendingFact = '';
      continue;
    }
    if (/^#\s/.test(trimmed)) continue;   // 一级标题（含 userId）

    if (section === 'prefs' || section === 'facts') {
      const sourceLine = /^>\s*(?:来源|source)\s*[:：]\s*(.*)$/i.exec(trimmed);
      if (sourceLine && section === 'facts' && pendingFact) {
        out.sources[pendingFact] = String(sourceLine[1]).trim().slice(0, 200);
        pendingFact = '';
        continue;
      }
      const item = /^-\s*([a-zA-Z]+)\s*:\s*(.*)$/.exec(trimmed);
      if (!item) continue;
      const field = item[1];
      const spec = (section === 'facts' ? FACTS_SPEC : PREFS_SPEC)[field];
      if (!spec) continue;
      const value = normalizeFieldValue(section, field, item[2]);
      if (!value.ok) continue;
      if (section === 'facts') {
        out.facts[field] = value.value;
        pendingFact = field;
      } else {
        out.prefs[field] = value.value;
      }
      continue;
    }

    if (section === 'summaries') {
      if (!trimmed.startsWith('|')) continue;
      const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length < 5) continue;
      if (/^日期$|date/i.test(cells[0]) || /^-+$/.test(cells[0])) continue;
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(cells[0])) continue;
      if (!cells[1]) continue;
      const int = (v) => Math.max(0, Math.round(Number(v)) || 0);
      out.summaries.push({
        stamp: cells[0],
        name: cells[1].slice(0, 30),
        target: int(cells[2]),
        reps: int(cells[3]),
        score: int(cells[4]),
      });
      if (out.summaries.length >= MEMORY_SUMMARY_MAX) out.summaries.length = MEMORY_SUMMARY_MAX;
      continue;
    }

    if (section === 'last') {
      const m = /^-\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+(.+?)\s+第\s*(\d+)\s*组[（(]\s*(\d+)\s*\/\s*(\d+)\s*[）)]/.exec(trimmed);
      if (!m) continue;
      out.lastUnfinished = {
        stamp: m[1],
        exerciseId: '',
        name: m[2].trim().slice(0, 30),
        set: Math.max(1, Math.min(99, Number(m[3]) || 1)),
        reps: Math.max(0, Number(m[4]) || 0),
        target: Math.max(0, Number(m[5]) || 0),
      };
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 读 / 写 / 忘
 * ------------------------------------------------------------------ */

function dirOf(dir) {
  return path.resolve(String(dir || MEMORY_DIR));
}

function backupBad(file) {
  const backup = `${file}.bad`;
  try {
    if (fs.existsSync(backup)) {
      fs.renameSync(backup, `${backup}.${Date.now()}`);
    }
    fs.renameSync(file, backup);
    return backup;
  } catch {
    return '';
  }
}

/**
 * 读一个用户的记忆。
 * - 文件不存在 → 空记忆（不创建文件）；
 * - 超过 64KB / 完全不像记忆 MD → 备份成 `.bad`，返回空记忆（**绝不崩**）；
 * - 手改造成的非法值 → 忽略该行（其它正常字段照常读出来）。
 *
 * @returns {{user:string,prefs:object,facts:object,sources:object,summaries:Array,
 *            lastUnfinished:object|null,updatedAt:number|null}}
 */
export function readMemory(userId, { dir = MEMORY_DIR } = {}) {
  const user = normalizeUserId(userId);
  const file = memoryFilePath(user, dir);
  const out = emptyMemory(user);
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    return out;
  }
  if (!stat || !stat.isFile()) return out;
  if (stat.size > MEMORY_MAX_BYTES) {
    backupBad(file);
    return out;
  }
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  if (!looksLikeMemory(text)) {
    if (text.trim()) backupBad(file);
    return out;
  }
  let parsed = null;
  try {
    parsed = parseMemoryMarkdown(text, user);
  } catch {
    backupBad(file);
    return out;
  }
  parsed.updatedAt = Math.round(Number(stat.mtimeMs) || Date.now());
  return parsed;
}

/** 原子写：写 `.tmp-*` → `rename`（中途挂掉也不会留下半个 MD） */
function writeMemoryAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** 归一化一个 patch 里的 facts 值：既接受 `{value, evidence}` 也接受裸值（内部用） */
function readFactPatch(field, raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw) {
    return { value: raw.value, evidence: normalizeEvidence(raw.evidence) };
  }
  return { value: raw, evidence: '' };
}

/**
 * 更新一个用户的记忆（合并式：只改 patch 里带的字段）。
 *
 * patch 允许的顶层键：`prefs` / `facts` / `summaries` / `lastUnfinished`（别的键一律 `unknown-field`）。
 * - `prefs: {tone:'warm'}`（白名单 + 范围校验）
 * - `facts: {goal:{value:'减脂', evidence:'用户原话'}}`（facts **必须带 evidence**）
 * - `summaries: [{at,name,target,reps,score}]`（整段替换，最多 20 条）
 * - `lastUnfinished: {...}|null`
 *
 * @returns 写入后的完整记忆对象
 */
export function updateMemory(userId, patch = {}, { dir = MEMORY_DIR, now = Date.now() } = {}) {
  const user = normalizeUserId(userId);
  const src = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const allowed = new Set(['prefs', 'facts', 'summaries', 'lastUnfinished']);
  for (const key of Object.keys(src)) {
    if (!allowed.has(key)) throw new MemoryError('unknown-field', { field: key });
  }
  const current = readMemory(user, { dir });

  if (src.prefs !== undefined) {
    if (!src.prefs || typeof src.prefs !== 'object' || Array.isArray(src.prefs)) {
      throw new MemoryError('bad-prefs', { field: 'prefs' });
    }
    for (const [field, raw] of Object.entries(src.prefs)) {
      if (!PREFS_FIELDS.includes(field)) throw new MemoryError('bad-field', { field, reason: 'not-in-whitelist' });
      const value = normalizeFieldValue('prefs', field, raw);
      if (!value.ok) throw new MemoryError('bad-value', { field, reason: value.reason });
      current.prefs[field] = value.value;
    }
  }

  if (src.facts !== undefined) {
    if (!src.facts || typeof src.facts !== 'object' || Array.isArray(src.facts)) {
      throw new MemoryError('bad-facts', { field: 'facts' });
    }
    for (const [field, raw] of Object.entries(src.facts)) {
      if (!FACTS_FIELDS.includes(field)) throw new MemoryError('bad-field', { field, reason: 'not-in-whitelist' });
      const { value: rawValue, evidence } = readFactPatch(field, raw);
      const value = normalizeFieldValue('facts', field, rawValue);
      if (!value.ok) throw new MemoryError('bad-value', { field, reason: value.reason });
      current.facts[field] = value.value;
      current.sources[field] = normalizeEvidence(evidence);
    }
  }

  if (src.summaries !== undefined) {
    if (!Array.isArray(src.summaries)) throw new MemoryError('bad-summaries', { field: 'summaries' });
    current.summaries = src.summaries
      .slice(0, MEMORY_SUMMARY_MAX)
      .map((item) => normalizeSummary(item, now));
  }

  if (src.lastUnfinished !== undefined) {
    current.lastUnfinished = normalizeLastUnfinished(src.lastUnfinished, now);
  }

  const text = serializeMemory({ ...current, user });
  if (Buffer.byteLength(text, 'utf8') > MEMORY_MAX_BYTES) {
    throw new MemoryError('too-big', { field: 'memory' });
  }
  writeMemoryAtomic(memoryFilePath(user, dir), text);
  const saved = readMemory(user, { dir });
  return saved;
}

/**
 * 忘掉一条字段 / 全部。
 * `field` 可以写 `tone`（两节里唯一的字段）也可以写 `prefs.tone` / `facts.goal`。
 * `{all:true}` → 直接删掉这个用户的 MD 文件（每条已单独备份不出来，属于用户主动清除）。
 */
export function forgetMemory(userId, target = {}, { dir = MEMORY_DIR } = {}) {
  const user = normalizeUserId(userId);
  const want = target && typeof target === 'object' ? target : {};
  if (want.all === true) {
    const file = memoryFilePath(user, dir);
    try { fs.unlinkSync(file); } catch { /* 本来就没有 */ }
    return emptyMemory(user);
  }
  const rawField = String(want.field == null ? '' : want.field).trim();
  if (!rawField) throw new MemoryError('bad-field', { field: '' });
  let section = '';
  let field = rawField;
  const dot = rawField.indexOf('.');
  if (dot > 0) {
    section = rawField.slice(0, dot);
    field = rawField.slice(dot + 1);
  }
  if (!PREFS_FIELDS.includes(field) && !FACTS_FIELDS.includes(field)) {
    throw new MemoryError('bad-field', { field: rawField });
  }
  if (section && section !== 'prefs' && section !== 'facts') {
    throw new MemoryError('bad-field', { field: rawField });
  }
  const actualSection = section || (PREFS_FIELDS.includes(field) ? 'prefs' : 'facts');
  const current = readMemory(user, { dir });
  if (actualSection === 'prefs') {
    delete current.prefs[field];
  } else {
    delete current.facts[field];
    delete current.sources[field];
  }
  writeMemoryAtomic(memoryFilePath(user, dir), serializeMemory({ ...current, user }));
  return readMemory(user, { dir });
}

/** `/memory/health` 用：只报「有几个用户的记忆文件」，**绝不读内容 / 不泄露 id** */
export function memoryHealth({ dir = MEMORY_DIR } = {}) {
  const base = dirOf(dir);
  let users = 0;
  try {
    for (const name of fs.readdirSync(base)) {
      if (/^[a-zA-Z0-9_-]{1,32}\.md$/.test(name)) users += 1;
    }
  } catch { /* 目录不存在 = 0 个用户 */ }
  return { ok: true, users };
}

export default {
  MEMORY_DIR,
  MEMORY_MAX_BYTES,
  USER_ID_RE,
  DEFAULT_USER_ID,
  MEMORY_SUMMARY_MAX,
  PREFS_SPEC,
  FACTS_SPEC,
  PREFS_FIELDS,
  FACTS_FIELDS,
  MEMORY_FIELDS,
  MemoryError,
  normalizeUserId,
  formatMemoryStamp,
  emptyMemory,
  memoryFilePath,
  normalizeFieldValue,
  normalizeEvidence,
  serializeMemory,
  parseMemoryMarkdown,
  readMemory,
  updateMemory,
  forgetMemory,
  memoryHealth,
};
