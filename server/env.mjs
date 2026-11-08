/**
 * 极简 KEY=VALUE 解析（零依赖）。
 *
 * 只支持日常写法，够读 `coach.env` 就行：
 *
 *     # 注释
 *     VOLC_APP_ID=test
 *     export VOLC_API_KEY="test-token"   # 行尾注释（不带引号时才切）
 *
 * 解析结果只进内存 / 进程环境，**不打印值**。所有对外输出都走 `maskSecret()` /
 * `redactSecrets()`：日志里只出现「有没有配、几个字符」。
 */

import fs from 'node:fs';

/**
 * 解析 KEY=VALUE 文本。
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      // 引号值：以**第一个闭合引号**为界，后面的 ` # 注释` 不算值
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      // 不带引号时，` #` 之后算行尾注释（值里本来就有 # 的情况很少）
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * 读一个 .env 文件。文件不存在 / 读不了都**不抛错**（返回 `{ ok:false }`），
 * 让调用方决定是「降级运行」还是「明确报错」。
 * @param {string} file
 */
export function loadEnvFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { ok: true, env: parseEnv(text), error: '' };
  } catch (err) {
    return { ok: false, env: {}, error: String((err && err.code) || (err && err.message) || 'read-error') };
  }
}

/**
 * 把 token 的出现位置全部换成 `***`（错误信息里可能被服务器回显）。
 * @param {string} text
 * @param {string[]} secrets
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text == null ? '' : text);
  for (const secret of secrets) {
    const value = String(secret == null ? '' : secret);
    if (value.length < 3) continue;
    out = out.split(value).join('***');
  }
  return out;
}

/**
 * 脱敏描述：**只说长度**，不泄露任何字符片段。
 * @param {string} value
 */
export function maskSecret(value) {
  const s = String(value == null ? '' : value);
  if (!s) return '(empty)';
  return `set (${s.length} chars)`;
}

/** 环境变量 → 火山配置（key 全部来自文件 / 进程环境，绝不写死） */
export const COACH_ENV_KEYS = Object.freeze([
  'VOLC_APP_ID',
  'VOLC_API_KEY',
  'VOLC_ASR_RESOURCE',
]);

/**
 * 从解析好的 env 里取火山配置，并给出「缺哪些字段」。
 * @param {Record<string,string>} env
 */
export function volcConfigFrom(env = {}) {
  const appId = String(env.VOLC_APP_ID || '').trim();
  const apiKey = String(env.VOLC_API_KEY || '').trim();
  const resource = String(env.VOLC_ASR_RESOURCE || '').trim() || 'volc.seedasr.sauc.duration';
  const endpoint = String(env.VOLC_ASR_ENDPOINT || '').trim()
    || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
  const authStyle = String(env.VOLC_ASR_AUTH_STYLE || '').trim() || 'auto';
  const missing = [];
  if (!appId) missing.push('VOLC_APP_ID');
  if (!apiKey) missing.push('VOLC_API_KEY');
  return {
    appId,
    apiKey,
    resource,
    endpoint,
    authStyle,
    missing,
    configured: missing.length === 0,
  };
}
