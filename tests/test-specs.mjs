/**
 * 「计次技术指标」自检（🎯 运动设定弹窗里那组数值）。
 *
 * 这里要守住的核心承诺是：**弹窗里显示的每一个数字都必须等于识别器真正使用的判定线**。
 * 所以这个测试不做「字面比对」，而是：
 *   1) 独立按引擎的公式复算一遍（progress = (up − v)/(up − down)），和弹窗里的数对上；
 *   2) 直接问识别器本体（createDetector）：把弹窗里那个数值喂给它的 progressOf()，
 *      必须正好落在它自己的计次进度线上；
 *   3) 姿势门控的数值必须与 GATES 用的同一张 GATE_LIMITS 表一致；
 *   4) 所有文案键在四种语言里都取得到（不能出现界面上是键名的「半成品」）。
 *
 * 用法：node tests/test-specs.mjs
 */

import { createDetector, EXERCISES } from '../src/exercises.js';
import { EXERCISE_MAP } from '../src/catalog.js';
import {
  exerciseSpecs, specKeys, roundFor, specTextRows,
} from '../src/specs.js';
import { GATE_LIMITS, ADVISORY_LIMITS } from '../src/engines.js';
import { HOLD_PRIME_MS, HOLD_GRACE_MS } from '../src/detector-base.js';
import { SQUAT, LUNGE, PUSHUP, BRIDGE, PLANK } from '../src/exercises.js';
import { localeKeys, setLang } from '../src/i18n.js';
import { LOCALES, LANG_ORDER } from '../src/i18n.js';

let passed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
const near = (a, b, tol = 0.011) => Math.abs(a - b) <= tol;

const ALL = EXERCISES.map((e) => e.id);
const specsOf = (id) => exerciseSpecs(id);
const itemsOf = (id) => specsOf(id).groups.flatMap((g) => g.items);
const findItem = (id, labelKey) => itemsOf(id).find((it) => it.labelKey === labelKey);
const UNITS = new Set(['deg', 'torso', 'shin', 'lift', 's', 'count']);
const OPS = new Set(['lte', 'gte', 'lt', 'gt', 'range']);

/* ------------------------------------------------------------------ *
 * 1. 覆盖度与结构
 * ------------------------------------------------------------------ */

console.log('\n[1] 每个动作都有技术指标');
{
  for (const id of ALL) {
    const s = specsOf(id);
    const items = itemsOf(id);
    ok(`${id}：至少给出两组指标`, s.groups.length >= 2, `实际 ${s.groups.length} 组`);
    ok(`${id}：至少 4 条指标`, items.length >= 4, `实际 ${items.length} 条`);
    ok(`${id}：第一条是「计次判据」`, s.groups[0].titleKey === 'spec.group.count', s.groups[0].titleKey);
    ok(`${id}：每条指标都有标签`, items.every((it) => typeof it.labelKey === 'string' && it.labelKey));
    ok(`${id}：数值都是有限数`, items.every((it) => it.textKey
      || (Number.isFinite(it.value) && (it.value2 === undefined || Number.isFinite(it.value2)))),
    JSON.stringify(items.filter((it) => !it.textKey && !Number.isFinite(it.value)).map((it) => it.labelKey)));
    ok(`${id}：单位都是已知单位`, items.every((it) => it.unit === undefined || UNITS.has(it.unit)),
      JSON.stringify([...new Set(items.map((it) => it.unit))]));
    ok(`${id}：比较符都是已知比较符`, items.every((it) => it.op === undefined || OPS.has(it.op)),
      JSON.stringify([...new Set(items.map((it) => it.op))]));
    ok(`${id}：带指标的条目一定带比较符`, items.every((it) => !it.metricKey || it.op || it.textKey));
  }
  ok('动作库里 22 个动作都有指标', ALL.length === 22 && ALL.every((id) => itemsOf(id).length > 0), `实际 ${ALL.length}`);
}

/* ------------------------------------------------------------------ *
 * 2. 数值 = 引擎公式（独立复算）
 * ------------------------------------------------------------------ */

console.log('\n[2] 通用引擎类：数值等于 (up, down) 与进度阈值算出来的那条线');
{
  const bendIds = EXERCISES.filter((e) => e.engine === 'bend').map((e) => e.id);
  ok('有屈伸类动作可测', bendIds.length >= 8, `实际 ${bendIds.length}`);
  for (const id of bendIds) {
    const p = EXERCISE_MAP[id].params || {};
    const up = Number.isFinite(p.up) ? p.up : 170;
    const down = Number.isFinite(p.down) ? p.down : 100;
    const unit = itemsOf(id).find((it) => it.labelKey === 'spec.countLine').unit;
    const expect = (pr) => roundFor(up - pr * (up - down), unit);
    const rows = [
      ['spec.enterLine', p.enterP ?? 0.32],
      ['spec.countLine', p.looseP ?? 0.55],
      ['spec.bottomLine', p.bottomP ?? 0.85],
      ['spec.backLine', p.backP ?? 0.16],
      ['spec.wobble', p.ignoreP ?? 0.45],
    ];
    for (const [key, pr] of rows) {
      const it = findItem(id, key);
      ok(`${id}：${key} = ${pr} 进度对应的角度`, it && near(it.value, expect(pr)),
        `弹窗 ${it && it.value} vs 复算 ${expect(pr)}`);
    }
    const minRep = findItem(id, 'spec.minRep');
    ok(`${id}：最短用时 = minRepMs`, near(minRep.value, (p.minRepMs ?? 380) / 1000, 0.001),
      `${minRep.value} vs ${(p.minRepMs ?? 380) / 1000}`);
  }
}

/* ------------------------------------------------------------------ *
 * 3. 数值 = 识别器本体用的那条线（最强的一条断言）
 * ------------------------------------------------------------------ */

console.log('\n[3] 把弹窗里的数值喂回识别器：必须正好落在它自己的进度线上');
{
  const bendIds = EXERCISES.filter((e) => e.engine === 'bend').map((e) => e.id);
  for (const id of bendIds) {
    const det = createDetector(id);
    const count = findItem(id, 'spec.countLine');
    const bottom = findItem(id, 'spec.bottomLine');
    ok(`${id}：宽松计数线就是识别器的 looseP`,
      near(det.progressOf(count.value), det.looseP, 0.02),
      `弹窗 ${count.value} → 进度 ${det.progressOf(count.value).toFixed(3)}，looseP=${det.looseP}`);
    ok(`${id}：深度线就是识别器的 bottomP`,
      near(det.progressOf(bottom.value), det.bottomP, 0.02),
      `${bottom.value} → ${det.progressOf(bottom.value).toFixed(3)} vs ${det.bottomP}`);
  }
}

/* ------------------------------------------------------------------ *
 * 4. 手写识别器：显示的就是它自己的常量
 * ------------------------------------------------------------------ */

console.log('\n[4] 五个手写识别器：显示值与常量一致');
{
  const squat = createDetector('squat');
  ok('深蹲：计次线 = SQUAT.looseRatio', findItem('squat', 'spec.countLine').value === SQUAT.looseRatio,
    `${findItem('squat', 'spec.countLine').value} vs ${SQUAT.looseRatio}`);
  ok('深蹲：到位线 = SQUAT.bottomRatio', findItem('squat', 'spec.bottomLine').value === SQUAT.bottomRatio);
  ok('深蹲：站姿线 = 识别器的 standLine 上限', findItem('squat', 'spec.backLine').value === SQUAT.standRatio
    && squat.standLine === SQUAT.standRatio, `standLine=${squat.standLine}`);
  ok('深蹲：最短用时 = SQUAT.minRepMs', near(findItem('squat', 'spec.minRep').value, SQUAT.minRepMs / 1000, 0.001));

  const lunge = createDetector('lunge');
  ok('箭步蹲：计次线 = 识别器的 countLine', findItem('lunge', 'spec.countLine').value === lunge.countLine,
    `${findItem('lunge', 'spec.countLine').value} vs ${lunge.countLine}`);
  ok('箭步蹲：双腿门槛 = 识别器的 bothLine 上限',
    findItem('lunge', 'spec.bothKnees').value === Math.min(LUNGE.bothBentNeeded, lunge.bothLine),
    `${findItem('lunge', 'spec.bothKnees').value} vs bothLine=${lunge.bothLine}`);
  ok('箭步蹲：到位线 = LUNGE.downKnee', findItem('lunge', 'spec.bottomLine').value === LUNGE.downKnee);
  ok('箭步蹲：回程用文字说明（没有固定角度）',
    !!findItem('lunge', 'spec.backLine').textKey, findItem('lunge', 'spec.backLine').textKey);

  const pushup = createDetector('pushup');
  ok('俯卧撑：计次线 = PUSHUP.looseElbow', findItem('pushup', 'spec.countLine').value === PUSHUP.looseElbow);
  ok('俯卧撑：深度线 = PUSHUP.elbowFull', findItem('pushup', 'spec.bottomLine').value === PUSHUP.elbowFull);
  ok('俯卧撑：回到顶位 = 识别器的 backLine（参考顶位）',
    findItem('pushup', 'spec.backLine').value === pushup.backLine,
    `${findItem('pushup', 'spec.backLine').value} vs ${pushup.backLine}`);
  const drop = findItem('pushup', 'spec.shoulderDrop');
  ok('俯卧撑：肩膀下沉线 = PUSHUP.dropMin', drop.value === PUSHUP.dropMin, `${drop.value} vs ${PUSHUP.dropMin}`);
  ok('俯卧撑：补充说明里带上了 dropFull / dropStart',
    Number(drop.noteParams.full) === PUSHUP.dropFull && Number(drop.noteParams.start) === PUSHUP.dropStart,
    JSON.stringify(drop.noteParams));
  ok('俯卧撑：晃动不计的幅度用的是 PUSHUP.minBend',
    findItem('pushup', 'spec.wobble').noteParams.deg === PUSHUP.minBend,
    JSON.stringify(findItem('pushup', 'spec.wobble').noteParams));

  ok('臀桥：抬髋线 = BRIDGE.upRise', findItem('bridge', 'spec.countLine').value === BRIDGE.upRise);
  ok('臀桥：落回线 = BRIDGE.downRise', findItem('bridge', 'spec.bridgeDown').value === BRIDGE.downRise);
  const kneeRange = itemsOf('bridge').find((it) => it.metricKey === 'metric.knee' && it.op === 'range');
  ok('臀桥：膝角区间 = BRIDGE.kneeMin~kneeMax',
    kneeRange.value === BRIDGE.kneeMin && kneeRange.value2 === BRIDGE.kneeMax,
    JSON.stringify([kneeRange.value, kneeRange.value2]));

  ok('平板支撑：必须项阈值 = PLANK 常量',
    findItem('plank', 'spec.plankHard')
    && itemsOf('plank').some((it) => it.metricKey === 'metric.trunk' && it.value === PLANK.torsoIncl)
    && itemsOf('plank').some((it) => it.metricKey === 'metric.shoulderClear' && it.value === PLANK.shoulderClearMin)
    && itemsOf('plank').some((it) => it.metricKey === 'metric.wristClear' && it.value === PLANK.handOnFloorMax));
  ok('平板支撑：计时宽容 = HOLD_PRIME_MS / HOLD_GRACE_MS',
    near(findItem('plank', 'spec.holdPrime').value, HOLD_PRIME_MS / 1000, 0.001)
    && near(findItem('plank', 'spec.holdGrace').value, HOLD_GRACE_MS / 1000, 0.001));
}

/* ------------------------------------------------------------------ *
 * 5. 姿势门控：与 GATES 用的是同一张表
 * ------------------------------------------------------------------ */

console.log('\n[5] 姿势要求用的就是 GATES 的那张表');
{
  let checked = 0;
  for (const ex of EXERCISES) {
    const p = ex.params || {};
    const gate = ex.engine === 'builtin' ? null : (p.gate || null);
    if (!gate || !GATE_LIMITS[gate]) continue;
    const shown = itemsOf(ex.id).filter((it) => it.labelKey === `spec.pose.${gate}`);
    const limits = GATE_LIMITS[gate];
    ok(`${ex.id}：门控 ${gate} 的每条阈值都列出来了`,
      shown.length === Object.keys(limits).length,
      `弹窗 ${shown.length} 条 vs 表里 ${Object.keys(limits).length} 条`);
    for (const [metric, range] of Object.entries(limits)) {
      const it = shown.find((x) => x.metricKey === `metric.${metric}`);
      const expect = range[0] !== null ? range[0] : range[1];
      ok(`${ex.id}：${gate}.${metric} = ${expect}`, it && near(it.value, expect, 0.0001),
        `弹窗 ${it && it.value} vs 表 ${expect}`);
      checked += 1;
    }
  }
  ok('确实检查了门控数值（不是空跑）', checked >= 20, `实际 ${checked} 条`);

  // 手写识别器用自己的姿势判据（不套通用 prone 门控），也必须逐条对上
  const pose = itemsOf('pushup').filter((it) => it.labelKey === 'spec.pushupPose');
  ok('俯卧撑：俯撑判据 = PUSHUP.activeTorso',
    pose.some((it) => it.metricKey === 'metric.torsoIncl' && it.value === PUSHUP.activeTorso));
  ok('俯卧撑：俯撑判据 = PUSHUP.activeShoulderClear',
    pose.some((it) => it.metricKey === 'metric.shoulderClear' && it.value === PUSHUP.activeShoulderClear));
  ok('俯卧撑：俯撑判据 = PUSHUP.activeHandOnFloor',
    pose.some((it) => it.metricKey === 'metric.wristClear' && it.value === PUSHUP.activeHandOnFloor));
  ok('俯卧撑：身体直线要求 = PUSHUP.bodyStraightMin',
    itemsOf('pushup').some((it) => it.metricKey === 'metric.body' && it.value === PUSHUP.bodyStraightMin));
  ok('俯卧撑：没有混进通用 prone 门控的 0.95（那是别的动作的判据）',
    !pose.some((it) => it.metricKey === 'metric.wristClearMin'));
  ok('臀桥：躺姿判据 = BRIDGE 的常量',
    itemsOf('bridge').some((it) => it.metricKey === 'metric.trunk' && it.value === BRIDGE.supineTorso)
    && itemsOf('bridge').some((it) => it.metricKey === 'metric.shoulderClear' && it.value === BRIDGE.shoulderClearMax)
    && itemsOf('bridge').some((it) => it.metricKey === 'metric.kneeClear' && it.value === BRIDGE.kneeClearMin));
}

/* ------------------------------------------------------------------ *
 * 5b. 单位不能张冠李戴（深蹲的「髋比膝高」是除以小腿长，不是躯干长）
 * ------------------------------------------------------------------ */

console.log('\n[5b] 指标单位与代码里的换算一致');
{
  const ratio = itemsOf('squat').filter((it) => it.metricKey === 'metric.hipAboveKnee');
  ok('深蹲：髋比膝高用「小腿长」当单位',
    ratio.length >= 4 && ratio.every((it) => it.unit === 'shin'),
    JSON.stringify([...new Set(ratio.map((it) => it.unit))]));
  ok('箭步蹲：后膝离地用「小腿长」当单位',
    itemsOf('lunge').some((it) => it.metricKey === 'metric.backKneeDrop' && it.unit === 'shin'));
  const angleRows = itemsOf('lunge').filter((it) => it.metricKey === 'metric.frontKnee');
  ok('角度类指标用「度」', angleRows.length >= 3 && angleRows.every((it) => it.unit === 'deg'));
  ok('离地高度类指标用「躯干长」',
    itemsOf('plank').filter((it) => it.metricKey === 'metric.shoulderClear').every((it) => it.unit === 'torso'));
}

/* ------------------------------------------------------------------ *
 * 5c. 最终显示的文字（走 app.js 用的同一套渲染函数）
 * ------------------------------------------------------------------ */

console.log('\n[5c] 界面上最终看到的文字');
{
  const rows = specTextRows('lunge');
  const row = (name) => rows.find((r) => r.name === name);
  const countRow = rows.find((r) => r.cond.includes('152'));
  ok('中文：箭步蹲的计次行读得通', /前膝屈角 ≤ 152°/.test(countRow.cond), countRow.cond);
  ok('中文：双腿门槛行在（较直那条腿 ≤ 158°）',
    rows.some((r) => /较直那条腿的膝角 ≤ 158°/.test(r.cond)), JSON.stringify(rows.map((r) => r.cond).slice(0, 6)));
  ok('中文：回程是文字说明（带 60% / 8°）',
    rows.some((r) => /回升 60%/.test(r.cond) && /8°/.test(r.cond)));
  ok('中文：时间类数值带单位且有空隙（≥ 0.45 秒）',
    rows.some((r) => /≥ 0.45 秒/.test(r.cond)), JSON.stringify(rows.map((r) => r.cond).filter((c) => /0\.45/.test(c))));
  ok('中文：区间型指标只写一次单位（30°–148°）',
    specTextRows('bridge').some((r) => /30°–148°/.test(r.cond)),
    JSON.stringify(specTextRows('bridge').map((r) => r.cond)));

  setLang('en', { persist: false });
  const en = specTextRows('lunge').map((r) => r.cond).join(' | ');
  ok('英文：同一批数值（152° / 158°）用英文渲染', /≤ 152°/.test(en) && /≤ 158°/.test(en), en.slice(0, 120));
  ok('英文：单位是「× torso length」', /torso length/.test(specTextRows('plank').map((r) => r.cond).join(' ')));
  ok('英文：没有残留中文', !/[\u4e00-\u9fff]/.test(
    ALL.map((id) => specTextRows(id).map((r) => r.group + r.name + r.cond + r.note).join('')).join(''),
  ));
  setLang('zh', { persist: false });
  ok('中文：指标文案无键名泄漏',
    !/spec\.|metric\./.test(ALL.map((id) => specTextRows(id).map((r) => r.group + r.name + r.cond + r.note).join('')).join('')));
}

/* ------------------------------------------------------------------ *
 * 6. 文案键：每种语言都必须取得到
 * ------------------------------------------------------------------ */

console.log('\n[6] 所有指标文案键在中英两种语言里都存在');
{
  const keys = new Set(['spec.unit.deg', 'spec.unit.torso', 'spec.unit.shin', 'spec.unit.lift', 'spec.unit.s', 'spec.unit.count',
    'exercise.specGroup', 'exercise.specLead']);
  for (const id of ALL) for (const k of specKeys(id)) keys.add(k);
  const dicts = Object.fromEntries(LANG_ORDER.map((l) => [l, new Set(localeKeys(l))]));
  const missing = { zh: [], en: [] };
  for (const k of keys) {
    for (const l of LANG_ORDER) if (!dicts[l].has(k)) missing[l].push(k);
  }
  for (const l of LANG_ORDER) {
    ok(`${l}：${keys.size} 个指标文案键都在`, missing[l].length === 0, missing[l].slice(0, 8).join(', '));
  }
  ok('指标文案键数量合理（不是只写了一两条）', keys.size >= 60, `实际 ${keys.size}`);
  ok('中英两种语言的键数量一致', !!LOCALES.zh && dicts.zh.size === dicts.en.size, `${dicts.zh.size} vs ${dicts.en.size}`);
  ok('语言目录只有中英两种', LANG_ORDER.join() === 'zh,en' && Object.keys(LOCALES).join() === 'zh,en',
    `${LANG_ORDER.join()} / ${Object.keys(LOCALES).join()}`);
}

/* ------------------------------------------------------------------ *
 * 7. 实时提醒阈值
 * ------------------------------------------------------------------ */

console.log('\n[7] 姿态提醒阈值来自 ADVISORY_LIMITS');
{
  const prone = itemsOf('pushupWide').filter((it) => it.noteKey === 'spec.note.adviceOnly');
  ok('俯撑类：身体直线角提醒 = ADVISORY_LIMITS.prone.bodyStraight',
    prone.some((it) => it.metricKey === 'metric.body' && it.value === ADVISORY_LIMITS.prone.bodyStraight));
  ok('俯撑类：塌腰偏差提醒 = ADVISORY_LIMITS.prone.hipLineDev',
    prone.some((it) => it.metricKey === 'metric.hipLineDevAbs' && it.value === ADVISORY_LIMITS.prone.hipLineDev));
  const squatAdvice = itemsOf('squat').filter((it) => it.noteKey === 'spec.note.adviceOnly');
  ok('站姿类：膝盖内扣提醒 = ADVISORY_LIMITS.stand.valgus',
    squatAdvice.some((it) => it.metricKey === 'metric.valgus' && it.value === ADVISORY_LIMITS.stand.valgus));
  ok('站姿类：上身前倾提醒 = ADVISORY_LIMITS.stand.trunkLean',
    squatAdvice.some((it) => it.metricKey === 'metric.trunk' && it.value === ADVISORY_LIMITS.stand.trunkLean));
  ok('提醒都标了「只出声不扣次数」', [...prone, ...squatAdvice].every((it) => it.noteKey === 'spec.note.adviceOnly'));
}

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
