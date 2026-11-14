/**
 * 数字的「念法」（R2 私人教练式报数用，**纯函数 / 不碰 DOM**）。
 *
 * 用户原话：「规则要优化：原则上要像私人教练一样主动帮用户计数……播报文案要像私教
 * （短、有节奏、偶尔带一句鼓励），zh 例「一」「二」… + 每 5 个时加「五个了」。」
 *
 * 所以数字不能直接把 `5` 塞进模板让 TTS 去猜（有的音色会把 5 念成「五」、有的念成
 * "five"、还有的念成「伍」），而是**先换成这个语言的数词**再交给 TTS：
 *   中文：一 / 二 / … / 十 / 十一 / 二十 / 一百零五
 *   英文：one / two / … / ten / eleven / twenty-one
 *
 * 约束：
 *   - 只做 1~999（报数 / 读秒永远在这个范围）；更大的数直接回阿拉伯数字，绝不编；
 *   - 中文数词一律用 `\u` 转义写（`tests/test-i18n.mjs` 要求 src 里不出现写死的中文）；
 *   - 不 import 任何东西（`i18n.js` 也不反向依赖它，避免循环）。
 */

/* ------------------------------------------------------------------ *
 * 中文数词
 * ------------------------------------------------------------------ */

/** 零 一 二 三 四 五 六 七 八 九 */
const ZH_DIGITS = [
  '\u96f6', '\u4e00', '\u4e8c', '\u4e09', '\u56db',
  '\u4e94', '\u516d', '\u4e03', '\u516b', '\u4e5d',
];
/** 十 / 百 */
const ZH_TEN = '\u5341';
const ZH_HUNDRED = '\u767e';

/**
 * 整数 → 中文数词（1~999；0 → 「零」；超范围回阿拉伯数字）。
 * @param {number} value
 * @returns {string}
 */
export function zhNumber(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return '';
  if (n < 0) return `-${zhNumber(-n)}`;
  if (n > 999) return String(n);
  if (n < 10) return ZH_DIGITS[n];
  if (n < 20) return n === 10 ? ZH_TEN : `${ZH_TEN}${ZH_DIGITS[n - 10]}`;
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return `${ZH_DIGITS[tens]}${ZH_TEN}${ones ? ZH_DIGITS[ones] : ''}`;
  }
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const head = `${ZH_DIGITS[hundreds]}${ZH_HUNDRED}`;
  if (!rest) return head;
  // 一百零五 / 一百一十 / 一百二十三：中间的空位要补一个「零」
  if (rest < 10) return `${head}${ZH_DIGITS[0]}${ZH_DIGITS[rest]}`;
  return `${head}${zhNumber(rest)}`;
}

/* ------------------------------------------------------------------ *
 * 英文数词
 * ------------------------------------------------------------------ */

const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const EN_TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/**
 * 整数 → 英文数词（1~999；二十几用连字符 `twenty-one`；超范围回阿拉伯数字）。
 * @param {number} value
 * @returns {string}
 */
export function enNumber(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return '';
  if (n < 0) return `minus ${enNumber(-n)}`;
  if (n > 999) return String(n);
  if (n < 10) return EN_ONES[n];
  if (n < 20) return EN_TEENS[n - 10];
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return `${EN_TENS[tens]}${ones ? `-${EN_ONES[ones]}` : ''}`;
  }
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const head = `${EN_ONES[hundreds]} hundred`;
  return rest ? `${head} ${enNumber(rest)}` : head;
}

/**
 * 按语言取数词。
 * @param {number} value
 * @param {string} [lang='zh'] `zh` 中文数词，其余（en）英文数词
 * @returns {string}
 */
export function numberWord(value, lang = 'zh') {
  return String(lang) === 'zh' ? zhNumber(value) : enNumber(value);
}

export default { zhNumber, enNumber, numberWord };
