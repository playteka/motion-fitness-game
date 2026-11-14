/**
 * 语音命令表（P3.2 命令快车道）—— **唯一来源**。
 *
 * 每一条 = 一个 intent + 中英两套说法 + 可选参数 + `run(ctx, args)`。
 * 同一张表同时驱动三件事：
 *   ① 快车道执行（`session.onUserText()` → `parseCommand()` → `run(ctx, args)`）；
 *   ② LLM 工具调用（`server/llm-tools.mjs` 的 `TOOL_INTENT_MAP` 也按 intent 找这里的 `run()`）；
 *   ③ 测试（`tests/test-voice.mjs` 遍历 `COMMANDS`，每条 intent 的中英说法都至少跑一条）。
 *
 * 硬约束：
 *   - `run()` **只调用注入进来的 `ctx` 里已有的函数**，自己不改任何 state
 *     （ctx 在 `src/app.js` 里组装，见 `voiceCommandCtx`）；
 *   - 文案不写在这里：说法表 / 帮助说明 / 确认语都在 `src/locales/*.js` 的 `coach.*` 下，
 *     由 `i18n.js` 统一取（`tests/test-i18n.mjs` 因此能继续检查中英对称）；
 *   - 没有匹配上就返回 `unknown`（见 `parse.js`），**绝不猜**。
 *
 * `exit` **不再二次确认**（用户要求：说退出就退出 ✓）：`confirm: false`，命令一到就执行。
 * 旧的「确认 / 取消」状态机仍保留在 session.js 里（其它需要确认的动作以后还能用）。
 *
 * ## 快车道瘦身（用户决定：只留 6 类）
 *
 * **`run()` 一个都不删** —— 它们仍然给 LLM 的工具调用用（`TOOL_INTENT_MAP` 按 intent 找 handler）。
 * 变的只是「哪些 intent 参与 `parseCommand()` 的说法匹配」：
 *
 *   - `FAST_LANE_CLASSES` —— 用户口径的 **6 类**（暂停 / 继续算一类），帮助面板只列这 6 行；
 *   - `FAST_LANE_INTENTS` —— 上面 6 类实际展开的 **7 个 intent**（`pause` 与 `resume` 是两个）；
 *   - `ZERO_LLM_INTENTS` —— 4 个**不在移除清单里**的零 LLM 口令（「继续上次」+ 口述规则三条）。
 *     R2 的「口述建规则」本来就是**不联网、不花钱**的功能，用户给的 19 条移除清单里也没有它们，
 *     所以它们**继续留在快车道**（但不出现在帮助面板那 6 行里，见 `commandHelpRows()`）；
 *   - `PARSE_INTENTS` = 上面两组之和（11 个）：`parseCommand()` **只在这 11 个里找说法**，
 *     其余 19 个 intent（home / menu / … / setVoiceGender）不再从 `COMMANDS` 匹配，统一交给 LLM。
 */

import { t, LOCALES } from '../i18n.js';
import { EXERCISES, EXERCISE_MAP } from '../catalog.js';
import { describeRule } from './rules.js';

/** 等待「确认 / 取消」的最长时间：8 秒没回应自动取消（用户要求） */
export const COMMAND_CONFIRM_MS = 8000;

/** 五个分类的 id（说法里的分类名本身来自 locales 的 `cat.*`，不在这里抄第二份） */
const CATEGORY_IDS = ['upper', 'lower', 'core', 'full', 'stretch'];

/* ------------------------------------------------------------------ *
 * 快车道范围（**一处定义**：parse.js 与帮助面板都从这里取）
 * ------------------------------------------------------------------ */

/**
 * 用户口径的 **6 类**快车道口令（暂停 / 继续是两个 intent，算一类）。
 *
 * `id` 同时是帮助面板的 `data-intent` 与 `coach.commandHelp.<id>` 的 key；
 * `intents` 是这一类的说法来源（中英说法仍从 locales 的 `coach.commands.*` 取，不另抄）。
 */
export const FAST_LANE_CLASSES = Object.freeze([
  Object.freeze({ id: 'startWorkout', intents: Object.freeze(['startWorkout']) }),
  Object.freeze({ id: 'pause', intents: Object.freeze(['pause', 'resume']) }),
  Object.freeze({ id: 'exit', intents: Object.freeze(['exit']) }),
  Object.freeze({ id: 'mute', intents: Object.freeze(['mute']) }),
  Object.freeze({ id: 'unmute', intents: Object.freeze(['unmute']) }),
  Object.freeze({ id: 'stopListening', intents: Object.freeze(['stopListening']) }),
]);

/** 6 类展开后的 7 个 intent（`pause` / `resume` 各算一个） */
export const FAST_LANE_INTENTS = Object.freeze(
  [...new Set(FAST_LANE_CLASSES.flatMap((group) => group.intents))],
);

/**
 * 不在用户移除清单里的 4 个**零 LLM** 口令，继续留在快车道：
 * `continueLast`（继续上次）+ R2 口述规则三条（建 / 关 / 列）。
 * 帮助面板不列它们（只列 6 类），但说「每 10 个报一次」仍然本机执行、不联网。
 */
export const ZERO_LLM_INTENTS = Object.freeze([
  'continueLast', 'addRule', 'removeRule', 'listRules',
]);

/** `parseCommand()` 允许匹配的全部 intent（7 个核心 + 4 个零 LLM = 11 个） */
export const PARSE_INTENTS = Object.freeze([...FAST_LANE_INTENTS, ...ZERO_LLM_INTENTS]);

/** 从两份词条里取某个 intent 的说法数组（中英各一套；两份 locale 由 i18n 测试保证结构一致） */
function phrases(intent) {
  const zh = LOCALES.zh?.coach?.commands?.[intent];
  const en = LOCALES.en?.coach?.commands?.[intent];
  return {
    zh: Array.isArray(zh) ? zh.slice() : [],
    en: Array.isArray(en) ? en.slice() : [],
  };
}

/** 分类的说法 = 词条里给的变体 + `cat.*` 里的分类名本身（一处定义，不重复搬字） */
function categoryPhrases() {
  const out = phrases('category');
  for (const lang of ['zh', 'en']) {
    const names = CATEGORY_IDS.map((id) => LOCALES[lang]?.cat?.[id]).filter((x) => typeof x === 'string');
    out[lang] = [...new Set([...out[lang], ...names])];
  }
  return out;
}

/** 确认 / 取消的说法（只在「等待确认」状态下匹配，不在命令表里） */
function wordList(key) {
  const zh = LOCALES.zh?.coach?.[key];
  const en = LOCALES.en?.coach?.[key];
  return Object.freeze({
    zh: Object.freeze(Array.isArray(zh) ? zh.slice() : []),
    en: Object.freeze(Array.isArray(en) ? en.slice() : []),
  });
}

export const CONFIRM_WORDS = wordList('confirmWords');
export const CANCEL_WORDS = wordList('cancelWords');

/** 当前 state 的一份只读快照（读取用；绝不改任何东西） */
function snapshotOf(ctx) {
  if (!ctx || typeof ctx.getStateSnapshot !== 'function') return {};
  try {
    return ctx.getStateSnapshot() || {};
  } catch {
    return {};
  }
}

/** 统一的结果：{ key, params } 由 session 用 `t()` 翻成字幕 */
const ack = (key, params) => ({ key, params });

/** 这个动作的目标单位（计时 / 限时计数是秒，其余是次） */
function unitFor(ex) {
  return ex && (ex.kind === 'hold' || ex.timed) ? t('ui.secondsUnit') : t('ui.repsUnit');
}

/** 动作名（当前语言；找不到 id 就原样回 id，绝不抛） */
function exerciseName(id) {
  return EXERCISE_MAP[id] ? t(`ex.${id}.name`) : String(id || '');
}

/** 表项构造：说法从词条取，帮助说明也从词条按 intent 取 */
function command(intent, extra) {
  const say = intent === 'category' ? categoryPhrases() : phrases(intent);
  return Object.freeze({
    intent,
    zh: Object.freeze(say.zh),
    en: Object.freeze(say.en),
    helpKey: `coach.commandHelp.${intent}`,
    ...extra,
  });
}

/* ------------------------------------------------------------------ *
 * 命令表
 * ------------------------------------------------------------------ */

export const COMMANDS = Object.freeze([
  /* ---------------- 导航 ---------------- */
  command('home', {
    run(ctx) {
      ctx.showHome?.();
      return ack('coach.cmdAck.home');
    },
  }),
  command('menu', {
    run(ctx) {
      ctx.openMenu?.({ silent: true });
      return ack('coach.cmdAck.menu');
    },
  }),
  command('next', {
    run(ctx) {
      const ok = ctx.flipMenuPage?.(1);
      return ack(ok ? 'coach.cmdAck.next' : 'coach.cmdAck.notInMenu');
    },
  }),
  command('prev', {
    run(ctx) {
      const ok = ctx.flipMenuPage?.(-1);
      return ack(ok ? 'coach.cmdAck.prev' : 'coach.cmdAck.notInMenu');
    },
  }),
  command('back', {
    run(ctx) {
      const s = snapshotOf(ctx);
      // 有弹窗先关弹窗（和 Esc 的顺序一致：帮助 → 记录 → 运动设定 → 设置）
      if (s.voiceHelpOpen) ctx.closeVoiceHelp?.();
      else if (s.recordsOpen) ctx.closeRecordsModal?.();
      else if (s.exerciseSettingsOpen) ctx.closeExerciseSettings?.();
      else if (s.settingsOpen) ctx.closeSettings?.();
      else if (s.menuMode) ctx.selectFromMenu?.('back');
      else if (!s.homeMode) ctx.openMenu?.({ silent: true });
      return ack('coach.cmdAck.back');
    },
  }),
  command('category', {
    args: 'category',
    run(ctx, args) {
      const id = args && args.category;
      if (!id) return ack('coach.cmdAck.unknownCategory');
      let s = snapshotOf(ctx);
      if (!s.menuMode) ctx.openMenu?.({ silent: true });
      s = snapshotOf(ctx);
      if (s.menuLevel === 1) ctx.selectFromMenu?.('back');
      ctx.selectFromMenu?.(`cat:${id}`);
      return ack('coach.cmdAck.category', { name: t(`cat.${id}`) });
    },
  }),
  command('pick', {
    args: 'index',
    run(ctx, args) {
      const s = snapshotOf(ctx);
      if (!s.menuMode) ctx.openMenu?.({ silent: true });
      const index = Number(args && args.index);
      const name = ctx.pickMenuItem?.(index) || '';
      if (!name) return ack('coach.cmdAck.notInMenu');
      return ack('coach.cmdAck.pick', { index: index + 1, name });
    },
  }),
  command('openSettings', {
    run(ctx) {
      ctx.openSettings?.();
      return ack('coach.cmdAck.openSettings');
    },
  }),
  command('openRecords', {
    run(ctx) {
      ctx.openRecordsModal?.('history');
      return ack('coach.cmdAck.openRecords');
    },
  }),
  command('openBest', {
    run(ctx) {
      ctx.openRecordsModal?.('best');
      return ack('coach.cmdAck.openBest');
    },
  }),
  command('openExerciseSettings', {
    run(ctx) {
      ctx.openExerciseSettings?.();
      return ack('coach.cmdAck.openExerciseSettings');
    },
  }),

  /* ---------------- 训练 ---------------- */
  command('startWorkout', {
    args: 'exercise',
    run(ctx, args) {
      const a = args || {};
      if (a.exerciseId) {
        // 全屏 + 摄像头 / 麦克风权限仍然走**原来那条路**（startGestureMode），不绕开
        ctx.startGestureMode?.();
        ctx.closeMenu?.();
        ctx.selectExercise?.(a.exerciseId);
        if (Number.isFinite(Number(a.value))) ctx.setTarget?.(Number(a.value), a.exerciseId);
        const s = snapshotOf(ctx);
        const name = exerciseName(a.exerciseId);
        if (Number.isFinite(Number(a.value))) {
          const ex = EXERCISE_MAP[a.exerciseId];
          return ack('coach.cmdAck.startWorkoutTarget', {
            name,
            value: s.target ?? Number(a.value),
            unit: unitFor(ex),
          });
        }
        return ack('coach.cmdAck.startWorkoutNamed', { name });
      }
      if (Number.isFinite(Number(a.value))) {
        const s = snapshotOf(ctx);
        const id = s.exerciseId;
        ctx.setTarget?.(Number(a.value), id);
        ctx.startGestureMode?.();
        return ack('coach.cmdAck.startWorkoutTarget', {
          name: exerciseName(id),
          value: Number(a.value),
          unit: unitFor(EXERCISE_MAP[id]),
        });
      }
      ctx.startGestureMode?.();
      return ack('coach.cmdAck.startWorkout');
    },
  }),
  command('pause', {
    run(ctx) {
      const s = snapshotOf(ctx);
      if (s.session === 'running') {
        ctx.pauseSession?.();
        return ack('coach.cmdAck.pause');
      }
      if (s.session === 'paused') return ack('coach.cmdAck.alreadyPaused');
      return ack('coach.cmdAck.pauseNotRunning');
    },
  }),
  command('resume', {
    run(ctx) {
      const s = snapshotOf(ctx);
      if (s.session === 'paused') {
        ctx.resumeSession?.();
        return ack('coach.cmdAck.resume');
      }
      if (s.session === 'running') return ack('coach.cmdAck.alreadyRunning');
      return ack('coach.cmdAck.resumeNotPaused');
    },
  }),
  command('exit', {
    // 说退出就退出（用户要求）：不再走二次确认。确认机制本身仍在 session.js 里
    // （`pendingConfirm` + `COMMAND_CONFIRM_MS`），留给以后真正需要确认的动作。
    confirm: false,
    run(ctx) {
      const s = snapshotOf(ctx);
      // 训练里「退出」= 回手势菜单（和右上角退出圆环同一个动作）；
      // 已经在菜单里再退出 = 回网页首页（和「返回」第一级一致）。
      if (s.menuMode) ctx.showHome?.();
      else ctx.openMenu?.({ silent: true });
      return ack('coach.cmdAck.exit');
    },
  }),
  command('retrySet', {
    run(ctx) {
      const s = snapshotOf(ctx);
      if (s.homeMode || s.menuMode) return ack('coach.cmdAck.retryNotTraining');
      ctx.retrySet?.();
      return ack('coach.cmdAck.retrySet');
    },
  }),
  command('nextExercise', {
    run(ctx) {
      const s = snapshotOf(ctx);
      const list = EXERCISES;
      const at = list.findIndex((e) => e.id === s.exerciseId);
      const next = list[(at + 1 + list.length) % list.length];
      if (!next) return ack('coach.cmdAck.nextExerciseFail');
      if (s.homeMode || s.menuMode) {
        ctx.showWorkout?.();
        ctx.closeMenu?.();
      }
      ctx.selectExercise?.(next.id);
      return ack('coach.cmdAck.nextExercise', { name: exerciseName(next.id) });
    },
  }),
  /**
   * 「继续上次」：回到上次没练完的那个动作 + 目标 + 第几组。
   *
   * 数据来源是**中时记忆**（localStorage 的最近一组 / 服务端 MD 的「上次未完成」），
   * 由 `ctx.continueLastSession()` 负责恢复（这里只把结果翻成一句确认，不碰 state）。
   */
  command('continueLast', {
    run(ctx) {
      const info = ctx.continueLastSession?.();
      if (!info) return ack('coach.cmdAck.continueNothing');
      return ack('coach.cmdAck.continueLast', {
        name: info.name,
        target: info.target,
        set: info.set,
        unit: info.unit || t('ui.repsUnit'),
      });
    },
  }),

  /* ---------------- 目标 ---------------- */
  command('setTarget', {
    args: 'number',
    run(ctx, args) {
      const s = snapshotOf(ctx);
      const id = s.exerciseId;
      const value = Math.round(Number(args && args.value));
      if (!Number.isFinite(value)) return ack('coach.cmdAck.badNumber');
      const next = ctx.setTarget?.(value, id);
      return ack('coach.cmdAck.setTarget', {
        value: Number.isFinite(Number(next)) ? Number(next) : value,
        unit: unitFor(EXERCISE_MAP[id]),
      });
    },
  }),
  command('adjustTarget', {
    args: 'number',
    run(ctx, args) {
      const s = snapshotOf(ctx);
      const id = s.exerciseId;
      const delta = Math.round(Number(args && args.delta));
      if (!Number.isFinite(delta) || !delta) return ack('coach.cmdAck.badNumber');
      const base = Number(s.target) || 0;
      const next = Math.max(1, Math.min(999, base + delta));
      const applied = ctx.setTarget?.(next, id);
      return ack(delta > 0 ? 'coach.cmdAck.adjustUp' : 'coach.cmdAck.adjustDown', {
        delta: Math.abs(delta),
        value: Number.isFinite(Number(applied)) ? Number(applied) : next,
        unit: unitFor(EXERCISE_MAP[id]),
      });
    },
  }),

  /* ---------------- 语音 ---------------- */
  command('mute', {
    run(ctx) {
      ctx.setCoachMuted?.(true);
      return ack('coach.cmdAck.mute');
    },
  }),
  command('unmute', {
    run(ctx) {
      ctx.setCoachMuted?.(false);
      return ack('coach.cmdAck.unmute');
    },
  }),
  command('stopListening', {
    run(ctx) {
      // 关闭教练走的是设置里那个唯一入口（等于 Ctrl+I 关）：停 TTS + 释放麦克风
      ctx.setCoachEnabled?.(false);
      return ack('coach.cmdAck.stopListening');
    },
  }),
  command('help', {
    run(ctx) {
      ctx.openVoiceHelp?.();
      return ack('coach.cmdAck.help');
    },
  }),
  command('switchLang', {
    args: 'lang',
    run(ctx, args) {
      if (args && args.lang) ctx.changeLang?.(args.lang);
      return ack('coach.cmdAck.switchLang');
    },
  }),
  /**
   * 教练声音性别（长期偏好 voiceGender，存在服务端 MD 的 prefs 里）。
   * 命令只把 `female` / `male` 交给 app，音色 ID **只在服务端**（server/volc-tts.mjs）。
   */
  command('setVoiceGender', {
    args: 'gender',
    run(ctx, args) {
      const gender = args && args.gender === 'male' ? 'male' : (args && args.gender === 'female' ? 'female' : '');
      if (!gender) return ack('coach.cmdAck.unknownGender');
      const applied = ctx.setVoiceGender?.(gender);
      const next = applied === 'male' ? 'male' : 'female';
      return ack('coach.cmdAck.voiceGender', {
        gender: t(next === 'male' ? 'settings.voiceMale' : 'settings.voiceFemale'),
      });
    },
  }),

  /* ---------------- 查询 ---------------- */
  command('reportProgress', {
    run(ctx) {
      const s = snapshotOf(ctx);
      const ex = EXERCISE_MAP[s.exerciseId];
      const score = Number(s.score) || 0;
      if (s.homeMode || s.menuMode) {
        return ack('coach.cmdAck.progressIdle', {
          target: Number(s.target) || 0,
          unit: unitFor(ex),
          reps: Number(s.reps) || 0,
          score,
        });
      }
      if (ex && ex.kind === 'hold') {
        return ack('coach.cmdAck.progressHold', {
          seconds: Math.floor((Number(s.holdMs) || 0) / 1000),
          score,
        });
      }
      return ack('coach.cmdAck.progress', { reps: Number(s.reps) || 0, score });
    },
  }),

  /* ---------------- R2 口述建规则（零 LLM） ----------------
   *
   * 用户原话：「每 10 个报一次」→ 建 / 改报数间隔规则；「每 30 秒报时」→ 读秒间隔规则；
   * 「别报数了」→ 删掉对应规则；「现在有什么规则」→ 逐条报出来（≤3 句）。
   *
   * 这三条**只调注入的 ctx**（`addCoachRule` / `removeCoachRules` / `listCoachRules`），
   * 自己不改 state；建出来的规则和内置规则走**同一套引擎与护栏**（`src/voice/rules.js`），
   * 作用域是 `scope: session` —— 一次训练结束就清掉。
   */
  command('addRule', {
    args: 'rule',
    numeric: true,
    run(ctx, args) {
      const info = ctx.addCoachRule?.(args || {});
      if (!info) return ack('coach.cmdAck.ruleFailed');
      return ack(
        info.kind === 'read' ? 'coach.cmdAck.addTimeRule' : 'coach.cmdAck.addRepRule',
        { every: info.every },
      );
    },
  }),
  command('removeRule', {
    args: 'ruleKind',
    run(ctx, args) {
      const kind = (args && args.kind) || '';
      if (!kind) return ack('coach.cmdAck.ruleUnknown');
      const gone = ctx.removeCoachRules?.(kind);
      if (!gone) return ack('coach.cmdAck.ruleNone');
      return ack(gone.kind === 'read' ? 'coach.cmdAck.removeTimeRule' : 'coach.cmdAck.removeRepRule');
    },
  }),
  command('listRules', {
    run(ctx) {
      const rows = ctx.listCoachRules?.() || [];
      if (!rows.length) return ack('coach.cmdAck.rulesEmpty');
      // 最多报 3 条（用户要求 ≤3 句，别把 7 条规则一口气念完）
      const items = rows.slice(0, 3).map((rule) => describeRule(rule)).join(t('rule.listSep'));
      const more = rows.length > 3 ? t('coach.cmdAck.rulesMore', { n: rows.length - 3 }) : '';
      return ack('coach.cmdAck.listRules', { count: rows.length, items: `${items}${more}` });
    },
  }),
]);

/** intent → 表项（帮助面板 / 会话按 intent 找 run 用；一处定义） */
export const COMMAND_BY_INTENT = Object.freeze(
  Object.fromEntries(COMMANDS.map((c) => [c.intent, c])),
);

/**
 * 帮助面板的数据行：中文说法 / English / 作用（作用走词条，按当前语言渲染）。
 *
 * **只渲染 6 类快车道口令**（暂停 / 继续合成一行）—— 其余说法请在帮助面板的说明里
 * 直接告诉用户「更多说法请直接对教练说」（交给 LLM）。`run()` 与 `COMMANDS` 不动。
 */
export function commandHelpRows() {
  return FAST_LANE_CLASSES.map((group) => {
    const commands = group.intents
      .map((intent) => COMMAND_BY_INTENT[intent])
      .filter(Boolean);
    // 同一类里的说法去重后合并（暂停 / 继续并成一行）
    const zh = [...new Set(commands.flatMap((c) => c.zh))].join(' / ');
    const en = [...new Set(commands.flatMap((c) => c.en))].join(' / ');
    return {
      intent: group.id,
      zh,
      en,
      helpKey: `coach.commandHelp.${group.id}`,
    };
  });
}
