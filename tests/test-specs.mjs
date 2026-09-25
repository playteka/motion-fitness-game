/**
 * 「关键帧判据与判分」自检（🎯 运动设定弹窗里那组数值）。
 *
 * 这里要守住的核心承诺是：**弹窗里显示的每一个数字都必须等于识别器真正使用的判定线**。
 * 所以这个测试不做「字面比对」，而是：
 *   1) 独立按引擎的公式复算一遍（progress = (up − v)/(up − down)），和弹窗里的数对上；
 *   2) 直接问识别器本体（createDetector）：把弹窗里那个数值喂给它的 progressOf()，
 *      必须正好落在它自己的计次进度线上；
 *   3) 姿势门控的数值必须与 GATES 用的同一张 GATE_LIMITS 表一致；
 *   4) 所有文案键在每种语言里都取得到（不能出现界面上是键名的「半成品」）。
 *
 * 用法：node tests/test-specs.mjs
 */

import { createDetector, EXERCISES } from '../src/exercises.js';
import { EXERCISE_MAP } from '../src/catalog.js';
import {
  exerciseSpecs, specKeys, roundFor, specTextRows, specStages, stageText, stageHolds, SPEC_METRICS,
  stagePoints, stageIndexForStep,
} from '../src/specs.js';
import {
  stageIcon, iconSVG, iconAngle, drawnAngle, ICON_BOX, uniqueStages, angleLabel,
} from '../src/icons.js';
import { toMetric, LandmarkSmoother } from '../src/geometry.js';
import { computeFrame } from '../src/metrics.js';
import { standingPose, ASPECT } from './synthetic-pose.mjs';
import { GATE_LIMITS, ADVISORY_LIMITS, LEG_STRAIGHT_MIN } from '../src/engines.js';
import { getStepPlan } from '../src/steps.js';
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
  ok('动作库里 20 个动作都有指标（弓步跳、宽距/窄距俯卧撑已删除、新增勾腿跳）',
    ALL.length === 20 && ALL.every((id) => itemsOf(id).length > 0), `实际 ${ALL.length}`);
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
  ok('俯卧撑：补充说明里带上了 dropFull / dropStart / dropReturn',
    Number(drop.noteParams.full) === PUSHUP.dropFull && Number(drop.noteParams.start) === PUSHUP.dropStart
    && Number(drop.noteParams.ret) === PUSHUP.dropReturn,
    JSON.stringify(drop.noteParams));
  ok('俯卧撑：四个肩膀下沉线满足 start < return < min < full（否则刚开始下沉就会被判成做完）',
    PUSHUP.dropStart < PUSHUP.dropReturn && PUSHUP.dropReturn < PUSHUP.dropMin && PUSHUP.dropMin < PUSHUP.dropFull,
    JSON.stringify([PUSHUP.dropStart, PUSHUP.dropReturn, PUSHUP.dropMin, PUSHUP.dropFull]));
  ok('俯卧撑：肘角四档满足 顶位 > 开始 > 计次 > 满分深度',
    PUSHUP.elbowUp > PUSHUP.elbowEnter && PUSHUP.elbowEnter > PUSHUP.looseElbow
    && PUSHUP.looseElbow > PUSHUP.elbowFull,
    JSON.stringify([PUSHUP.elbowUp, PUSHUP.elbowEnter, PUSHUP.looseElbow, PUSHUP.elbowFull]));
  ok('俯卧撑：晃动不计的幅度用的是 PUSHUP.minBend',
    findItem('pushup', 'spec.wobble').noteParams.deg === PUSHUP.minBend,
    JSON.stringify(findItem('pushup', 'spec.wobble').noteParams));

  ok('臀桥：抬髋线 = BRIDGE.upRise', findItem('bridge', 'spec.countLine').value === BRIDGE.upRise);
  ok('臀桥：落回线 = BRIDGE.downRise', findItem('bridge', 'spec.bridgeDown').value === BRIDGE.downRise);
  // 用户实测「髋抬到 170° 就是最高点，用这个当关键帧更合适；目前的标准无法计数」→ 加了角度法
  ok('臀桥：角度法那一格 = 肩-髋-膝 ≥ BRIDGE.topAngle（画面上标的「髋」）',
    findItem('bridge', 'spec.bridgeCountAngle')
    && findItem('bridge', 'spec.bridgeCountAngle').metricKey === 'metric.hip'
    && findItem('bridge', 'spec.bridgeCountAngle').value === BRIDGE.topAngle,
    JSON.stringify(findItem('bridge', 'spec.bridgeCountAngle')));
  ok('臀桥：关键帧「顶起来」那一格是「高度线 或 角度线」（两条路任一条到线就算顶到位）',
    (() => {
      const st = specStages('bridge');
      const count = st.find((s) => s.kind === 'count');
      return !!count && count.metric === 'hipRise' && count.valueFrom === 'topLine'
        && !!count.alt && count.alt.metric === 'hip'
        && count.alt.value === BRIDGE.topAngle;
    })(),
    JSON.stringify(specStages('bridge').map((s) => `${s.kind}:${s.metric}${s.op}${s.value}${s.alt ? ` 或 ${s.alt.metric}${s.alt.op}${s.alt.value}` : ''}`)));
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

  // 仰卧抬腿的「躺下」判据（两轮用户反馈的结果）：
  //   ① 第一轮：「只保留『肩离地高度 ≤ 0.6×躯干长』，删掉『躯干倾角 ≥ 36°』」；
  //   ② 第二轮：「总是进入不了起始姿势」→ 那唯一一条**依赖地面线**，躺平也会被误判，
  //      所以现在写成**两条证据取「或」**：躯干接近水平（≥55°，不看地面线）或 肩膀贴近地面线。
  const legRaisePose = itemsOf('lyingLegRaise').filter((it) => it.labelKey.startsWith('spec.pose.'));
  const legRaiseStages = specStages('lyingLegRaise');
  ok('仰卧抬腿：姿势要求是「躯干接近水平 或 肩离地高度 ≤ 0.6×躯干长」两条',
    legRaisePose.length === 2
    && legRaisePose.some((it) => it.metricKey === 'metric.torsoIncl' && it.value === 55)
    && legRaisePose.some((it) => it.metricKey === 'metric.shoulderClear' && it.value === 0.6),
    legRaisePose.map((it) => `${it.metricKey}${it.value}`).join(','));
  ok('仰卧抬腿：不再有旧的「躯干倾角 ≥ 36°」这条（新的 55° 是「或」里的一条，不是硬要求）',
    !legRaisePose.some((it) => it.metricKey === 'metric.torsoIncl' && it.value === 36),
    legRaisePose.map((it) => `${it.metricKey}${it.value}`).join(','));
  ok('仰卧抬腿：两条证据都带上了「两条证据任一条成立就算躺下」的说明',
    legRaisePose.every((it) => it.noteKey === 'spec.note.supineLying'),
    JSON.stringify(legRaisePose.map((it) => it.noteKey)));
  ok('仰卧抬腿：进度条第一格写成「A 或 B」（第二条是替代判据 alt，不是「还要满足」）',
    legRaiseStages[0].alt?.metric === 'shoulderClear' && legRaiseStages[0].metric === 'torsoIncl',
    JSON.stringify([legRaiseStages[0].metric, legRaiseStages[0].alt?.metric]));
  ok('死虫式：同样共用「躺下」的「或」判据（躯干 + 肩离地，两条）',
    itemsOf('deadBug').filter((it) => it.labelKey === 'spec.pose.supineLow').length === 2
    && specStages('deadBug')[0].alt?.metric === 'shoulderClear',
    String(itemsOf('deadBug').filter((it) => it.labelKey === 'spec.pose.supineLow').length));

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
  const countRow = rows.find((r) => r.cond.includes('138'));
  ok('中文：箭步蹲的计次行读得通', /前膝屈角 ≤ 138°/.test(countRow.cond), countRow.cond);
  ok('中文：双腿门槛行在（较直那条腿 ≤ 146°）',
    rows.some((r) => /较直那条腿的膝角 ≤ 146°/.test(r.cond)), JSON.stringify(rows.map((r) => r.cond).slice(0, 6)));
  ok('中文：回程是文字说明（带 65% / 8°）',
    rows.some((r) => /回升 65%/.test(r.cond) && /8°/.test(r.cond)));
  ok('中文：时间类数值带单位且有空隙（≥ 0.45 秒）',
    rows.some((r) => /≥ 0.45 秒/.test(r.cond)), JSON.stringify(rows.map((r) => r.cond).filter((c) => /0\.45/.test(c))));
  ok('中文：区间型指标只写一次单位（膝角区间 20°–160°）',
    specTextRows('bridge').some((r) => /20°–160°/.test(r.cond)),
    JSON.stringify(specTextRows('bridge').map((r) => r.cond)));

  setLang('en', { persist: false });
  const en = specTextRows('lunge').map((r) => r.cond).join(' | ');
  ok('英文：同一批数值（138° / 146°）用英文渲染', /≤ 138°/.test(en) && /≤ 146°/.test(en), en.slice(0, 120));
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
  // 宽距 / 窄距俯卧撑已按用户要求删除 —— 俯撑类的姿态提醒改由登山者（同一个 prone 门控）覆盖
  const prone = itemsOf('mountainClimber').filter((it) => it.noteKey === 'spec.note.adviceOnly');
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

/* ------------------------------------------------------------------ *
 * 8. 判定进度条：格子里的数值 = 真实阈值，而且真的会一格一格点亮
 * ------------------------------------------------------------------ */

console.log('\n[8] 判定进度条（画面上一格一格点亮的那条判据链）');
{
  for (const id of ALL) {
    const st = specStages(id);
    ok(`${id}：有 1~6 格`, st.length >= 1 && st.length <= 6, `实际 ${st.length} 格`);
    ok(`${id}：每一格都能实时判断（指标可解析）`,
      st.every((s) => typeof SPEC_METRICS[s.metric] === 'function'), JSON.stringify(st.map((s) => s.metric)));
    ok(`${id}：每一格都有短标签与判据文字`,
      st.every((s) => {
        const tx = stageText(s);
        return !!tx.short && tx.short !== s.shortKey && !!tx.cond;
      }), JSON.stringify(st.map((s) => stageText(s).short)));
    // 链上的阈值要么是弹窗里列的判据，要么是识别器自己的动态判定线 / 门控信号
    ok(`${id}：格子里的阈值就是弹窗里列出的阈值（或识别器的动态判定线）`,
      st.every((s) => s.valueFrom || s.detFlag || s.metric === 'progress'
        || (Number.isFinite(s.value) && itemsOf(id).some((it) => it.metricKey === `metric.${s.metric}`
          && it.op === s.op && it.value === s.value))),
    JSON.stringify(st.map((s) => `${s.metric}${s.op}${s.value}${s.valueFrom ? '←' + s.valueFrom : ''}`)));
    // 「多余的动作可以从关键帧里面删除」：深度 / 满分那类不影响计次的判据不进链
    ok(`${id}：进度条里没有「不影响计次」的深度/时间类判据`,
      !st.some((s) => ['spec.bottomLine', 'spec.wobble', 'spec.minRep', 'spec.giveUp',
        'spec.holdPrime', 'spec.holdGrace', 'spec.seqWindow', 'spec.altHold', 'spec.altGap'].includes(s.item.labelKey)),
    JSON.stringify(st.map((s) => s.item.labelKey)));
    // 「所有关键帧做完了就要计次」：链上最后一格就是计次那一刻
    if (EXERCISE_MAP[id].kind === 'hold') {
      ok(`${id}（计时类）：最后一格是「姿势到位」`, st[st.length - 1].kind === 'hold',
        st[st.length - 1].kind);
    } else {
      ok(`${id}：最后一格就是「计次那一刻」`, st[st.length - 1].kind === 'finish',
        JSON.stringify(st.map((s) => s.kind)));
      ok(`${id}：链上每一格都是计次必需的条件（没有纯装饰格）`,
        st.every((s) => ['gate', 'enter', 'count', 'finish'].includes(s.kind)),
        JSON.stringify(st.map((s) => `${stageText(s).short}:${s.kind}`)));
    }
  }

  // 用户举的例子：箭步蹲的链 = 站姿 → 开始(146°) → 计次(138°) → 双腿 → 回位（最后一格 = 计次那一刻）
  // 用户后来又要求「后面几个关键帧对膝盖弯曲的要求更大」：计次 152° → 138°、双腿 158° → 146°
  const lunge = specStages('lunge');
  ok('箭步蹲进度条：站姿 → 146° → 138° → 双腿 → 回位',
    lunge.length === 5
    && lunge[0].metric === 'kneeExtended' && lunge[0].value === 145
    && lunge[1].metric === 'frontKnee' && lunge[1].value === 146
    && lunge[2].metric === 'frontKnee' && lunge[2].value === 138
    && lunge[3].metric === 'straighterKnee' && lunge[3].value === 146
    && lunge[4].kind === 'finish',
    JSON.stringify(lunge.map((s) => `${s.metric}${s.op}${s.value}:${s.kind}`)));
  ok('箭步蹲：计次那一格比「开始」更弯（否则点一下前腿就能凑一次）',
    lunge[2].value < lunge[1].value, `${lunge[1].value} → ${lunge[2].value}`);
  const squat = specStages('squat');
  ok('深蹲进度条：站姿 0.86 → 开始 0.78 → 计次 0.62 → 回位（深度分不再单独占一格）',
    squat[0].value === 0.86 && squat[1].value === 0.78 && squat[2].value === 0.62
    && squat[3].kind === 'finish' && squat[3].valueFrom === 'standLine',
    JSON.stringify(squat.map((s) => `${s.value}${s.valueFrom ? '<-' + s.valueFrom : ''}:${s.kind}`)));
  ok('跳跃类动作的进度条包含「起跳」这一格',
    specStages('squatJump').some((s) => s.metric === 'lift' && s.value === 0.035),
    JSON.stringify(specStages('squatJump').map((s) => s.metric)));
  ok('俯卧撑：计次那一格带「肩膀下沉量」替代判据（镜头看不到贴地时靠它）',
    specStages('pushup').some((s) => s.alt && s.alt.metric === 'shoulderDrop' && s.alt.value === PUSHUP.dropMin),
    JSON.stringify(specStages('pushup').map((s) => `${s.metric}${s.alt ? '+' + s.alt.metric : ''}`)));

  // 仰卧抬腿（用户描述）：躺平 180° → 腿绷直抬起 → 与上身 90°（腿垂直地面）→ 放回 180°，如此循环
  {
    const meta = EXERCISE_MAP.lyingLegRaise;
    const st = specStages('lyingLegRaise');
    ok('仰卧抬腿：起始线 180°、抬到垂直是 90°（用户给的数值）',
      meta.params.up === 180 && meta.params.down === 90, `${meta.params.up}/${meta.params.down}`);
    ok('仰卧抬腿：判据就是腰腿夹角（hip）', meta.params.metric === 'hip', String(meta.params.metric));
    ok('仰卧抬腿关键帧：躺平 → 开始抬起 → 计次 → 放回躺平（最后一格 = 计次那一刻）',
      st.length === 4 && st[0].kind === 'gate' && st[1].metric === 'hip' && st[2].metric === 'hip'
      && st[st.length - 1].kind === 'finish',
      JSON.stringify(st.map((s) => `${s.metric}:${s.kind}`)));
    ok('仰卧抬腿：三个度数 = 开始 151° → 计次 105° → 放回 158°（角度一路变小再回到躺平）',
      st[1].value === 151 && st[2].value === 105 && st[3].item.value === 158,
      JSON.stringify(st.map((s) => `${s.op}${s.value}/${s.item?.value}`)));
    ok('仰卧抬腿：计次线在「髋关节约 90°」上留了宽容（105°，离垂直 15° 以内就算一次）',
      st[2].value === 105, String(st[2].value));
    ok('仰卧抬腿：放平就能开始下一次（回位线 158°，离躺平还有 22° 也算回到起始位）',
      st[3].item.value === 158 && meta.params.backP === 0.24,
      `back=${st[3].item.value} backP=${meta.params.backP}`);
    // 「腿要绷直」是建议项：弹窗里列出来的就是识别器真正用的那条宽容线（130°，用户要求不要太严格）
    const advice = exerciseSpecs('lyingLegRaise').groups.find((g) => g.titleKey === 'spec.group.advice');
    const legRow = (advice?.items || []).find((it) => it.labelKey === 'spec.adviceLegStraight');
    ok('仰卧抬腿：弹窗的建议项列出「腿尽量绷直 ≥ 130°」（只提醒、不扣次数）',
      !!legRow && legRow.metricKey === 'metric.knee' && legRow.op === 'gte'
      && legRow.value === LEG_STRAIGHT_MIN && LEG_STRAIGHT_MIN === 130,
      JSON.stringify(legRow));
    ok('仰卧抬腿：其它动作不会被塞进这条建议项',
      !(exerciseSpecs('reverseCrunch').groups.find((g) => g.titleKey === 'spec.group.advice')?.items || [])
        .some((it) => it.labelKey === 'spec.adviceLegStraight'));
  }

  // 通用屈伸类（仰卧抬起 / 站立屈伸 …）：最后一格必须**就是引擎计次那一刻**，
  // 不能是「永远成立」的假格子 —— 否则用户会看到「进度条满了却没计次」（真实踩过的坑：
  // 这里曾经写成 roundFor(0.16,'count') = 0 且 k = 6，progress ≤ 6 恒真）。
  for (const id of ALL) {
    const meta = EXERCISE_MAP[id];
    if (meta.kind === 'hold' || meta.engine !== 'bend') continue;
    const last = specStages(id).slice(-1)[0];
    const backP = Number.isFinite(meta.params?.backP) ? meta.params.backP : 0.16;
    ok(`${id}：最后一格用的是引擎自己的回位线（progress ≤ ${backP}）`,
      last.metric === 'progress' && last.op === 'lte' && near(last.value, backP, 1e-9),
      `${last.metric} ${last.op} ${last.value}`);
    ok(`${id}：最后一格留的宽容量不会让它提前成立`, !(last.k > 0.05), `k = ${last.k}`);
    ok(`${id}：动作还在低位时最后一格**不亮**`, stageHolds(last, { ok: true }, { progress: 0.9 }) === false);
    ok(`${id}：回到起始位时最后一格亮起（= 计次那一刻）`,
      stageHolds(last, { ok: true }, { progress: 0 }) === true);
    ok(`${id}：最后一格的悬停文字是弹窗里那条真实判据（不是「≤ 0 次」这类假数字）`,
      !!(last.item && last.item.textKey) || itemsOf(id).some((it) => it.labelKey === last.item.labelKey
        && it.metricKey === last.item.metricKey && it.op === last.item.op && it.value === last.item.value),
      JSON.stringify(last.item));
  }
}

/* ------------------------------------------------------------------ *
 * 9. 进度条真的会随姿势一格格前进（合成骨架驱动，走的和真机同一条管线）
 * ------------------------------------------------------------------ */

console.log('\n[9] 进度条随姿势前进 / 浅动作不会走到最后一格');
{
  const sp = standingPose;
  const tm = toMetric;
  const cf = computeFrame;
  const LS = LandmarkSmoother;
  const A = ASPECT;
  /** 造一帧（与真机同一条管线：toMetric → computeFrame） */
  const frameOf = (landmarks, t = 1000) => {
    const smoother = new LS();
    let f = { ok: false };
    for (let i = 0; i < 6; i++) f = cf(tm(smoother.apply(landmarks.map((p) => ({ ...p, v: p.visibility })), i / 30), A), null, t + i * 33, false, null);
    return f;
  };
  const squatFrame = (knee) => frameOf(sp({
    knee, lean: 6 + (178 - knee) * 0.28, armDown: (178 - knee) * 0.45, ankleX: 1.0, view: 'front',
  }));

  /** 走一个姿势序列，返回进度条到过的最大格 */
  const walk = (frames) => {
    const det = createDetector('squat');
    const stages = specStages('squat');
    let idx = -1;
    for (const f of frames) {
      for (let i = idx + 1; i < stages.length; i++) {
        if (!stageHolds(stages[i], f, det)) break;
        idx = i;
      }
    }
    return idx;
  };

  const squatStages = specStages('squat');
  const lastSquat = squatStages.length - 1;
  const deep = [178, 170, 160, 150, 140, 130, 120, 110, 100, 90, 80, 75].map(squatFrame);
  const roundTrip = [178, 165, 150, 135, 120, 105, 95, 95, 105, 120, 135, 150, 165, 176, 178].map(squatFrame);
  ok('深蹲：蹲下再站起来才走完关键帧链（最后一格 = 回位 = 计次那一刻）',
    walk(roundTrip) === lastSquat, `到第 ${walk(roundTrip) + 1}/${squatStages.length} 格`);
  ok('深蹲：只蹲下去、不站起来走不完链（不会「链没走完却计次」）',
    walk(deep) < lastSquat, `到第 ${walk(deep) + 1}/${squatStages.length} 格`);
  const shallow = [178, 172, 168, 165, 162, 160, 158].map(squatFrame);
  ok('只蹲一点点：进度条停在前面几格，不会走完', walk(shallow) <= 1, `到第 ${walk(shallow) + 1} 格`);
  ok('站着不动：进度条只点亮「站姿」这一格', walk([178, 178, 178].map(squatFrame)) === 0,
    `到第 ${walk([178, 178, 178].map(squatFrame)) + 1} 格`);
  ok('深蹲：链上最后一格是「回位」',
    squatStages[lastSquat].kind === 'finish', squatStages[lastSquat].kind);
  ok('深蹲：蹲到底那一帧，「回位」那一格不该亮（它还没回来）',
    !stageHolds(squatStages[lastSquat], squatFrame(75), createDetector('squat')));

  // 丢失跟踪（frame.ok = false）时任何一格都不该点
  ok('没识别到人时不点亮任何一格',
    !stageHolds(squatStages[0], { ok: false }, createDetector('squat')));

  // 箭步蹲：两条腿都弯才能过「双腿」那一格（真实阈值 146°；用户要求后几格更严，原来 158°）
  const lungeStages = specStages('lunge');
  const lungeBoth = lungeStages.findIndex((s) => s.metric === 'straighterKnee');
  const lungeFinish = lungeStages.length - 1;
  const fake = (frontKnee, backKnee, kneeExtended = 175) => ({
    ok: true,
    perSide: { L: { knee: frontKnee }, R: { knee: backKnee } },
    kneeExtended,
  });
  ok('箭步蹲：前膝 130°、后膝 140° 时「双腿」这一格过得了',
    stageHolds(lungeStages[lungeBoth], fake(130, 140), createDetector('lunge')));
  ok('箭步蹲：后膝只弯到 150°（旧门槛够、新门槛不够）时「双腿」这一格过不了',
    !stageHolds(lungeStages[lungeBoth], fake(130, 150), createDetector('lunge')));
  ok('箭步蹲：前膝 130° 但后膝几乎伸直（172°）时「双腿」这一格过不了',
    !stageHolds(lungeStages[lungeBoth], fake(130, 172), createDetector('lunge')));
  ok('箭步蹲：站着不动时连「开始」那一格都过不了',
    !stageHolds(lungeStages[1], fake(175, 175), createDetector('lunge')));
  ok('箭步蹲：最后一格是「回位」（计次那一刻）',
    lungeStages[lungeFinish].kind === 'finish', lungeStages[lungeFinish].kind);
  ok('箭步蹲：站起来（两腿伸直）能过一次「回位」',
    stageHolds(lungeStages[lungeFinish], fake(176, 176, 176), createDetector('lunge')));
  ok('箭步蹲：还蹲着（前膝 90°）时「回位」那一格过不了',
    !stageHolds(lungeStages[lungeFinish], fake(90, 95, 95), createDetector('lunge')));

  // 俯卧撑：计次那一格同时接受「肩膀沉到接近地面」这条更稳的证据
  const pushStages = specStages('pushup');
  const pushCount = pushStages.find((s) => s.kind === 'count');
  ok('俯卧撑：计次那一格带「肩膀下沉」替代判据',
    pushCount && pushCount.alt && pushCount.alt.metric === 'shoulderDrop'
    && pushCount.alt.value === PUSHUP.dropMin,
    JSON.stringify(pushCount?.alt && { m: pushCount.alt.metric, v: pushCount.alt.value }));
  // 收尾那一格（回到顶位）要同时要求「肩膀抬回顶位」——宽容度就是识别器用的 dropReturn
  const pushFinish = pushStages[pushStages.length - 1];
  ok('俯卧撑：收尾那一格要求肩膀抬回顶位 dropReturn 以内（与识别器同一个常量）',
    pushFinish && pushFinish.also && pushFinish.also.metric === 'shoulderDrop'
    && pushFinish.also.value === Number(PUSHUP.dropReturn.toFixed(2)),
    JSON.stringify(pushFinish?.also && { m: pushFinish.also.metric, v: pushFinish.also.value }));
}

/* ------------------------------------------------------------------ *
 * 11. 得分分配到关键帧：每一格能拿多少分
 * ------------------------------------------------------------------ */

console.log('\n[11] 得分分配到关键帧');
{
  for (const id of ALL) {
    const stages = specStages(id);
    const rows = stagePoints(id);
    const plan = getStepPlan(id);
    const want = (plan.steps || []).reduce((n, d) => n + d.points, 0) + (plan.repBonus || 0);
    const sum = rows.reduce((n, r) => n + r.points + r.bonus, 0);
    ok(`${id}：每一格的分加起来 = 这个动作的总分（${want}）`, sum === want, `实际 ${sum}`);
    ok(`${id}：分数格子数与关键帧数一致`, rows.length === stages.length,
      `${rows.length} vs ${stages.length}`);
    ok(`${id}：每个得分项都分到了某一格（不存在「有分却没地方显示」的项）`,
      (plan.steps || []).every((d) => stageIndexForStep(id, d.id) >= 0),
      JSON.stringify((plan.steps || []).filter((d) => stageIndexForStep(id, d.id) < 0).map((d) => d.id)));
    ok(`${id}：整轮满分奖励记在最后一格（计次那一刻给的）`,
      !plan.repBonus || rows[rows.length - 1].bonus === plan.repBonus,
      JSON.stringify(rows.map((r) => r.bonus)));
    ok(`${id}：计时类的「每秒加分」也记在最后一格`,
      !plan.pointsPerSecond || rows[rows.length - 1].perSecond === plan.pointsPerSecond,
      JSON.stringify(rows.map((r) => r.perSecond)));
  }

  // 用户举的例子：深蹲 45 分 = 站姿 4 + 开始 6 + 计次 21 + 回位 8 + 满轮 6
  ok('深蹲：4 / 6 / 21 / 8 + 满轮 6 = 45 分',
    JSON.stringify(stagePoints('squat').map((r) => r.points + r.bonus)) === '[4,6,21,14]',
    JSON.stringify(stagePoints('squat').map((r) => r.points + r.bonus)));
  ok('臀桥：仰卧 5 / 顶起 20 / 落回 8 + 满轮 6 = 39 分',
    JSON.stringify(stagePoints('bridge').map((r) => r.points)) === '[5,20,8]'
    && stagePoints('bridge')[2].bonus === 6,
    JSON.stringify(stagePoints('bridge')));
  ok('俯卧撑：俯撑 5 / 开始 7 / 计次 14 / 回位 8 + 满轮 6 = 40 分',
    JSON.stringify(stagePoints('pushup').map((r) => r.points)) === '[5,7,14,8]'
    && stagePoints('pushup')[3].bonus === 6,
    JSON.stringify(stagePoints('pushup')));
}


/* ------------------------------------------------------------------ *
 * 10. 关键帧线条图标（进度条上只画图标 + 判据角度数字）
 * ------------------------------------------------------------------ */

console.log('\n[10] 关键帧线条图标');
{
  const iconCtx = (id) => {
    const meta = EXERCISE_MAP[id];
    return {
      id,
      posture: meta.posture,
      kind: meta.kind,
      plan: meta.plan,
      gate: meta.params?.gate,
      metric: meta.params?.metric,
      stages: specStages(id),
    };
  };

  for (const id of ALL) {
    const ctx = iconCtx(id);
    const stages = uniqueStages(specStages(id), ctx);   // 进度条上真正显示的格子（去掉画得一模一样的）
    const icons = stages.map((s) => stageIcon(s, ctx));
    ok(`${id}：每一格都有图标（至少 3 条线 + 头）`,
      icons.every((ic) => ic.lines.length >= 3 && ic.circles.length === 1),
      JSON.stringify(icons.map((ic) => `${ic.lines.length}/${ic.circles.length}`)));
    ok(`${id}：图标都画在 32×32 方框里（不越界、也不留空图）`,
      icons.every((ic) => {
        const xs = ic.lines.flatMap((l) => [l.a.x, l.b.x]).concat(ic.circles.map((c) => c.x - c.r));
        const ys = ic.lines.flatMap((l) => [l.a.y, l.b.y]).concat(ic.circles.map((c) => c.y - c.r));
        const w = Math.max(...xs) - Math.min(...xs);
        const h = Math.max(...ys) - Math.min(...ys);
        return Math.min(...xs) >= -0.5 && Math.max(...xs) <= ICON_BOX + 0.5
          && Math.min(...ys) >= -0.5 && Math.max(...ys) <= ICON_BOX + 0.5
          && Math.max(w, h) > 8;
      }));
    ok(`${id}：相邻两格的图标不一样（看得出在往下走）`,
      icons.every((ic, i) => i === 0 || JSON.stringify(ic.pose.params) !== JSON.stringify(icons[i - 1].pose.params)),
      JSON.stringify(icons.map((ic) => ic.pose.params)));
    ok(`${id}：进度条至少有一格`, stages.length >= 1, String(stages.length));
    // 「计次那一刻」那一格必须真的画出来（不能被「画得一模一样就合并」吃掉）：
    // 曾经「回到起始位」画得和门控格「站直」一样，于是被合并掉，进度条最后一格变成「计次」——
    // 用户就会看到「进度条满了、却没计次」。计时类没有「计次」，姿势判据本来就会被合并，不做这条要求。
    if (EXERCISE_MAP[id].kind !== 'hold') {
      const kinds = stages.map((s) => s.kind);
      ok(`${id}：画出来的最后一格就是「计次那一刻」（回位/顶起/起跳…）`,
        kinds[kinds.length - 1] === 'finish', JSON.stringify(stages.map((s) => `${s.kind}:${stageText(s).short}`)));
    }
  }

  // 图标里的角度必须来自判据（深蹲/箭步蹲/俯卧撑这类「关节角就是姿态」的判据）
  const squatCtx = iconCtx('squat');
  const squatStages = specStages('squat');

  // 仰卧抬腿（用户描述的四格）：躺平（腿伸直、髋角 ≈180°）→ 抬起 → 抬到垂直（90°）→ 放回躺平
  {
    const ctxJ = iconCtx('lyingLegRaise');
    const stJ = specStages('lyingLegRaise');
    const icons = stJ.map((s) => stageIcon(s, ctxJ));
    const gate = icons[0].pose.params;
    ok('仰卧抬腿：起始格画的是「躺平 + 腿伸直」（不是躺着屈膝的臀桥/卷腹姿势）',
      icons[0].builder === 'lie' && gate.hip >= 176 && gate.knee >= 172, JSON.stringify(gate));
    ok('仰卧抬腿：抬起两格的髋角就是判据里的角度（151° / 105°），越抬越高',
      icons[1].pose.criterion.hip === 151 && icons[2].pose.criterion.hip === 105
      && icons[1].pose.params.hip > icons[2].pose.params.hip,
      JSON.stringify(icons.map((ic) => ic.pose.params.hip)));
    ok('仰卧抬腿：放回那一格带向下箭头（一眼看出是「控制着放回去」，也避免和起始格重样）',
      icons[3].pose.params.mark === 'down' && icons[3].lines.length > icons[0].lines.length,
      JSON.stringify(icons[3].pose.params));
    ok('仰卧抬腿：四个关键帧图标互不相同（不会被「画得一样就合并」吃掉）',
      new Set(stJ.map((s) => JSON.stringify(stageIcon(s, ctxJ).pose.params))).size === 4
      && uniqueStages(stJ, ctxJ).length === 4,
      JSON.stringify(stJ.map((s) => stageIcon(s, ctxJ).pose.params.hip)));
  }
  // 勾腿跳（用户要求）：站立 → 勾腿（≤126°）→ 换另一条腿勾（≤126°），而且图标必须是**站姿勾腿**。
  // 阈值随「快节奏计不上」的三轮修复从 100/135 一路调到 126/132（见 catalog.js 里的说明）
  {
    const ctxK = iconCtx('buttKick');
    const stK = specStages('buttKick');
    const icons = stK.map((s) => stageIcon(s, ctxK));
    ok('勾腿跳：三格 = 站立 → 勾腿 → 换另一条腿勾（最后一格 = 计次那一刻）',
      stK.length === 3 && stK[0].kind === 'gate' && stK[1].kind === 'count' && stK[2].kind === 'finish'
      && stK[1].value === 126 && stK[2].value === 126 && stK[2].metric === 'otherSide',
      JSON.stringify(stK.map((s) => `${s.kind}:${s.metric}${s.op}${s.value}`)));
    ok('勾腿跳：三格图标都是站姿（第一格站直，后两格是「站立勾腿」而不是躺着的图）',
      icons[0].builder === 'stand' && icons[1].builder === 'kick' && icons[2].builder === 'kick',
      icons.map((ic) => ic.builder).join(','));
    ok('勾腿跳：后两格画的就是那个膝角（126°），而且一近一远（换另一条腿）',
      icons[1].pose.params.kickKnee === 126 && icons[2].pose.params.kickKnee === 126
      && icons[1].pose.params.kicked === 'near' && icons[2].pose.params.kicked === 'far',
      JSON.stringify(icons.map((ic) => ic.pose.params)));
    ok('勾腿跳：三格图标互不相同（不会被「画得一样就合并」吃掉）',
      new Set(stK.map((s) => JSON.stringify(stageIcon(s, ctxK).pose.params))).size === 3
      && uniqueStages(stK, ctxK).length === 3);
    ok('勾腿跳：最后一格判据用识别器自己的「换边成功」标记（点亮即计次）',
      stK[2].detFlag === 'switched', String(stK[2].detFlag));
    // 用户要求「第二格之后应该是『勾腿』『勾另一条腿』」→ 关键帧名称按这个动作说
    ok('勾腿跳：关键帧短标签是「勾腿 / 勾另一条腿」（不是通用的「发力 / 换边」）',
      stK[1].shortKey === 'spec.short.tuck' && stK[2].shortKey === 'spec.short.tuckOther'
      && stK[1].item.labelKey === 'spec.altOnButtKick' && stK[2].item.labelKey === 'spec.altSwitchButtKick',
      `${stK[1].shortKey}/${stK[2].shortKey} ${stK[1].item.labelKey}/${stK[2].item.labelKey}`);
    ok('勾腿跳：换了短标签之后，得分仍旧落在正确的格子上（5 / 10 / 22 + 满轮 6）',
      JSON.stringify(stagePoints('buttKick').map((r) => r.points)) === '[5,10,22]'
      && stagePoints('buttKick')[2].bonus === 6,
      JSON.stringify(stagePoints('buttKick')));
    ok('勾腿跳：最后一格的补充说明带上了「回到 ≥132°/最短间隔 0.1 秒」的参数',
      stK[2].item.noteKey === 'spec.note.altSwitch'
      && stK[2].item.noteParams?.rest === 132 && stK[2].item.noteParams?.gap === 0.1,
      JSON.stringify(stK[2].item.noteParams));
  }
  // 死虫式（用户反馈「关键帧判别标准都不对」→ 判据重做）：
  // 判「腿伸出去的程度」（膝角与髋角取小）而不是膝角，而且另一条腿必须留在桌面位。
  {
    const ctxD = iconCtx('deadBug');
    const stD = specStages('deadBug');
    const icons = stD.map((s) => stageIcon(s, ctxD));
    ok('死虫式：三格 = 仰卧桌面位 → 伸出一条腿 → 换另一条腿也伸出去（最后一格 = 计次那一刻）',
      stD.length === 3 && stD[0].kind === 'gate' && stD[1].kind === 'count' && stD[2].kind === 'finish'
      && stD[1].metric === 'oneSideLeg' && stD[2].metric === 'otherSideLeg',
      JSON.stringify(stD.map((s) => `${s.kind}:${s.metric}${s.op}${s.value}`)));
    ok('死虫式：计次线用的是「腿伸出去的程度」132°，而不是膝角 150°',
      stD[1].value === 132 && stD[2].value === 132, `${stD[1].value}/${stD[2].value}`);
    ok('死虫式：关键帧的名字是「伸出一条腿 / 换另一条腿也伸出去」（不是通用的「收/伸」）',
      stD[1].item.labelKey === 'spec.altOnDeadBug' && stD[2].item.labelKey === 'spec.altSwitchDeadBug'
      && stD[1].shortKey === 'spec.short.extend' && stD[2].shortKey === 'spec.short.extendOther',
      `${stD[1].item.labelKey}/${stD[2].item.labelKey} ${stD[1].shortKey}/${stD[2].shortKey}`);
    ok('死虫式：「另一条腿留在桌面位」挂在「伸出一条腿」那一格上（计次的必要条件，写进判据文字里）',
      stD[1].also && stD[1].also.metric === 'otherSideLeg' && stD[1].also.op === 'lte'
      && stD[1].also.value === 120,
      JSON.stringify(stD[1].also && { m: stD[1].also.metric, op: stD[1].also.op, v: stD[1].also.value }));
    ok('死虫式：补充说明里的方向是「≥132° / 收回 ≤112°」（以前写死成「≤」，正好说反）',
      stD[2].item.noteParams?.dir === '≥' && stD[2].item.noteParams?.rel === '≤'
      && stD[2].item.noteParams?.v === 132 && stD[2].item.noteParams?.rest === 112,
      JSON.stringify(stD[2].item.noteParams));
    ok('死虫式：三格图标都是仰卧（第一格双腿屈膝的桌面位，后两格一条腿伸出去）',
      icons.every((ic) => ic.builder === 'lie' && ic.pose.params.face === 'up'),
      JSON.stringify(icons.map((ic) => `${ic.builder}/${ic.pose.params.face}`)));
    ok('死虫式：第二格近侧腿伸出去（画成贴地展开的姿态）、远侧腿屈着；第三格反过来（一眼看出「换另一条腿」）',
      icons[1].pose.params.hip === 168 && icons[1].pose.params.hip2 === 118
      && icons[2].pose.params.hip === 118 && icons[2].pose.params.hip2 === 168
      && icons[1].pose.criterion.legOut === 132,
      JSON.stringify(icons.map((ic) => [ic.pose.params.hip, ic.pose.params.hip2])));
    ok('死虫式：三格图标互不相同（不会被「画得一样就合并」吃掉）',
      new Set(stD.map((s) => JSON.stringify(stageIcon(s, ctxD).pose.params))).size === 3
      && uniqueStages(stD, ctxD).length === 3);
  }

  ok('深蹲：图标里的膝角随判据单调变深（蹲得越深画得越弯）', (() => {
    const bends = squatStages.map((s) => 180 - drawnAngle(s, squatCtx));
    return bends.every((v, i) => i === 0 || v >= bends[i - 1]);
  })(), JSON.stringify(squatStages.map((s) => drawnAngle(s, squatCtx))));

  const lungeCtx = iconCtx('lunge');
  const lungeStages = specStages('lunge');
  ok('箭步蹲：站姿那一格画的是站直的人（不是前折/趴下）',
    stageIcon(lungeStages[0], lungeCtx).builder === 'stand'
    && drawnAngle(lungeStages[0], lungeCtx) >= 170,
    JSON.stringify(stageIcon(lungeStages[0], lungeCtx).pose));
  ok('箭步蹲：「计次」那一格比「开始」画得更弯（判据 138° 比 146° 严，图标也跟着更弯）', (() => {
    const front = lungeStages.filter((s) => s.metric === 'frontKnee' && s.kind !== 'finish');
    const drawn = front.map((s) => drawnAngle(s, lungeCtx));
    return front.length === 2 && front[0].value === 146 && front[1].value === 138
      && drawn[1] < drawn[0];
  })(), JSON.stringify(lungeStages.filter((s) => s.metric === 'frontKnee').map((s) => `${s.kind}:${s.value}→${Math.round(drawnAngle(s, lungeCtx))}`)));
  ok('箭步蹲：图标里的膝角顺序与判据顺序一致（判据更严 → 画得更弯）', (() => {
    const front = lungeStages.filter((s) => s.metric === 'frontKnee');
    return front.every((s) => iconAngle(s, lungeCtx) === s.value);
  })(), JSON.stringify(lungeStages.filter((s) => s.metric === 'frontKnee').map((s) => iconAngle(s, lungeCtx))));
  ok('箭步蹲：「双腿」那一格画出了两条腿（后膝弯下来）', (() => {
    const both = lungeStages.find((s) => s.metric === 'straighterKnee');
    return both && stageIcon(both, lungeCtx).pose.params.backKnee < 170;
  })());

  const pushCtx = iconCtx('pushup');
  const pushStages = specStages('pushup');
  ok('俯卧撑：图标里的肘角 = 判据里的肘角', pushStages
    .filter((s) => s.metric === 'elbow')
    .every((s) => iconAngle(s, pushCtx) === s.value),
  JSON.stringify(pushStages.filter((s) => s.metric === 'elbow').map((s) => iconAngle(s, pushCtx))));
  ok('俯卧撑：肘弯得越多，图标里身体越低（撑地高度随肘角变小）', (() => {
    // 只看「往下走」的那几格（最后那格是「回到顶位」，本来就该画得更高）
    const elbowStages = pushStages.filter((s) => s.metric === 'elbow' && s.kind !== 'finish');
    const heights = elbowStages.map((s) => {
      const ic = stageIcon(s, pushCtx);
      const shoulderY = ic.lines[0].a.y;
      const handY = Math.max(...ic.lines.flatMap((l) => [l.a.y, l.b.y]));
      return handY - shoulderY;   // 撑地高度：手在地面时 = 肩到手的距离
    });
    return heights.length >= 2 && heights.every((v, i) => i === 0 || v <= heights[i - 1]);
  })(), JSON.stringify(pushStages.filter((s) => s.metric === 'elbow').map((s) => `${s.kind}:${s.value}`)));
  ok('俯卧撑：「回到顶位」那一格画得比「计次」那一格高（看得出是回去了）', (() => {
    const h = (s) => {
      const ic = stageIcon(s, pushCtx);
      const shoulderY = ic.lines[0].a.y;
      const handY = Math.max(...ic.lines.flatMap((l) => [l.a.y, l.b.y]));
      return handY - shoulderY;
    };
    const count = pushStages.find((s) => s.kind === 'count');
    const finish = pushStages.find((s) => s.kind === 'finish');
    return count && finish && h(finish) > h(count);
  })());
  ok('俯卧撑：撑地类姿势用「手在地面」的画法（support）',
    pushStages.filter((s) => s.metric === 'elbow').every((s) => stageIcon(s, pushCtx).pose.params.support === true));

  ok('波比跳：「俯撑」那一段画的是趴下（不是站着）',
    stageIcon(specStages('burpee')[2], iconCtx('burpee')).builder === 'lie',
    JSON.stringify(stageIcon(specStages('burpee')[2], iconCtx('burpee')).pose.params));
  ok('跳跃类：「起跳」那一格整幅图离地（头顶上方留白）', (() => {
    const jump = specStages('squatJump').find((s) => s.metric === 'lift');
    const ic = stageIcon(jump, iconCtx('squatJump'));
    const top = Math.min(...ic.lines.flatMap((l) => [l.a.y, l.b.y]));
    const bottom = Math.max(...ic.lines.flatMap((l) => [l.a.y, l.b.y]));
    return top > 0 && bottom < ICON_BOX - 1;
  })());
  ok('拉伸类：体前屈画的是前折姿态（躯干折下去）', (() => {
    const ic = stageIcon(specStages('standingForwardFold')[0], iconCtx('standingForwardFold'));
    return ic.builder === 'lie' && ic.pose.params.face === 'fold';
  })(), JSON.stringify(stageIcon(specStages('standingForwardFold')[0], iconCtx('standingForwardFold')).pose.params));

  // SVG 输出：只有线条和圆（没有色块、没有随便写的文字）；
  // **唯一允许的文字是判据角度数字**（用户要求：关键帧图标太像时在图标里标出关节度数）
  const svg = iconSVG(specStages('lunge')[1], lungeCtx);
  ok('图标 SVG 只有 line / circle（外加判据角度数字，没有色块）',
    /^<svg class="criteria-icon"/.test(svg) && /<circle/.test(svg)
    && !/fill="(?!currentColor)/.test(svg)
    && (svg.match(/<text/g) || []).length === (svg.match(/class="criteria-deg"/g) || []).length,
    svg.slice(0, 120));
  ok('图标 SVG 可解析（坐标都是有限数）', !/NaN|undefined/.test(svg), svg);
  // 度数标注的规则：同一动作里两格用同一个关节角、且度数相差 ≤12°（画出来几乎一样）才标
  const pushStagesForLabel = specStages('pushup');
  const pushLabels = pushStagesForLabel.map((s) => angleLabel(s, pushCtx));
  ok('俯卧撑：肘角几格画得太像 → 图标里标出肘关节度数（用户明确要求）',
    pushLabels.filter(Boolean).length >= 3 && pushLabels.every((l) => !l || /^\d+°$/.test(l)),
    JSON.stringify(pushLabels));
  ok('俯卧撑：标出来的度数就是该格判据里的角度',
    pushStagesForLabel.every((s, i) => !pushLabels[i] || pushLabels[i] === `${Math.round(s.value)}°`),
    JSON.stringify(pushStagesForLabel.map((s, i) => `${s.value}→${pushLabels[i]}`)));
  const squatLabels = specStages('squat').map((s) => angleLabel(s, iconCtx('squat')));
  ok('深蹲：图标本来就能一眼区分（176/135/112/149）→ 不标数字，画面不乱',
    squatLabels.every((l) => l === null), JSON.stringify(squatLabels));
}

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
}
